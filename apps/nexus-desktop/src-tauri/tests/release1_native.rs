//! Release 1: the Desktop's native layer for project access, previews and recovery. A scripted fake broker
//! records exactly what crosses the wire, so these tests state what the NATIVE process asks a person and
//! what it will and will not send: only a "yes" in a native dialog reaches the broker, permissions are
//! amended (never rebuilt from scratch), a preview address is resolved by the broker and never by the
//! renderer, and a recovery is bound to the digest the person reviewed.
//!
//! The broker here is a FAKE (a canned Unix-socket server): these are Tauri-command integration tests, not
//! sandbox or GUI tests. The real-broker/real-sandbox path is `release1_runtime.rs`.

use nexus_desktop_lib::dialogs::{is_local_preview_url, Dialogs, ScriptedDialogs};
use nexus_desktop_lib::interactive::Runtime;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};

/// `NEXUS_BROKER_SOCKET` is process-global: the tests run one after the other.
static LOCK: Mutex<()> = Mutex::new(());

type Handler = Box<dyn Fn(&Value) -> Result<Value, (&'static str, &'static str)> + Send + Sync>;

struct Fake {
    frames: Arc<Mutex<Vec<Value>>>,
    _dir: std::path::PathBuf,
}

impl Fake {
    fn start(name: &str, handler: Handler) -> (Fake, Runtime) {
        let dir = std::env::temp_dir().join(format!("nexus-rel1-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("broker.sock");
        let _ = std::fs::remove_file(&sock);
        let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
        let l = UnixListener::bind(&sock).unwrap();
        let fr = frames.clone();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let Ok(mut s) = stream else { break };
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let v: Value = serde_json::from_str(&line).unwrap();
                fr.lock().unwrap().push(v.clone());
                let id = v["id"].clone();
                let reply = match handler(&v) {
                    Ok(r) => json!({"protocol":1,"id":id,"ok":true,"result":r}),
                    Err((code, message)) => {
                        json!({"protocol":1,"id":id,"ok":false,"code":code,"message":message})
                    }
                };
                let _ = writeln!(s, "{reply}");
            }
        });
        std::env::set_var("NEXUS_BROKER_SOCKET", &sock);
        (Fake { frames, _dir: dir }, Runtime::new())
    }
    fn cmds(&self) -> Vec<String> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .map(|f| f["cmd"].as_str().unwrap_or("").to_owned())
            .collect()
    }
    fn frame(&self, cmd: &str) -> Option<Value> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|f| f["cmd"] == cmd)
            .cloned()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn dialogs(confirm: bool) -> ScriptedDialogs {
    ScriptedDialogs {
        confirm,
        ..Default::default()
    }
}

/// A broker that knows one project with the given workspace mode and grant, and echoes a consent text that
/// names the exact grant it was asked about (so a test can see what the person would have been shown).
fn project_broker(project: Value) -> Handler {
    Box::new(move |f| match f["cmd"].as_str().unwrap_or("") {
        "project-list" => Ok(json!({"projects": [project.clone()], "permissions": {"known": true}})),
        "project-grant-preview" => {
            let p = &f["params"];
            Ok(json!({
                "text": format!("CONSENT fs={} net={} approval={} devPorts={} checkpoint={} gitWrite={} hosts={} expires={}",
                    p["fs"].as_str().unwrap_or(""), p["net"].as_str().unwrap_or(""), p["approval"].as_str().unwrap_or(""),
                    p["devPorts"], p["checkpoint"], p["gitWrite"], p["allowHosts"], p["expiresInSecs"]),
                "textSha256": "a".repeat(64),
            }))
        }
        "project-grant" => Ok(json!({"project": {"projectId": "p"}})),
        "project-workspace" => Ok(json!({"project": {"projectId": "p", "workspaceMode": "direct"}})),
        _ => Ok(json!({})),
    })
}

fn grant(fs: &str, net: &str, extra: Value) -> Value {
    let mut g = json!({
        "grantId": "g", "version": 1, "digest": "d", "fs": fs, "net": net, "approval": "auto",
        "checkpoint": "best-effort", "hardLinks": "protect", "gitWrite": false, "devPorts": [],
        "expiresAtMs": null, "status": "active", "netPolicy": {"hosts": [], "local_ports": []},
    });
    for (k, v) in extra.as_object().unwrap() {
        g[k] = v.clone();
    }
    g
}

fn project(mode: &str, grant: Option<Value>) -> Value {
    let mut p = json!({"projectId": "p", "label": "demo", "workspaceMode": mode});
    if let Some(g) = grant {
        p["grant"] = g;
    }
    p
}

// ---- previews are AMENDMENTS of the active permissions -------------------------------------------

#[test]
fn allowing_previews_adds_ports_keeps_everything_else_and_needs_a_native_yes() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let g = grant(
        "workspace",
        "controlled",
        json!({
            "devPorts": [3000], "checkpoint": "required", "hardLinks": "allow", "gitWrite": true,
            "approval": "auto", "expiresAtMs": now_ms() + 3_600_000,
            "netPolicy": {"hosts": [{"host": "registry.npmjs.org", "ports": [443]}, {"host": "github.com", "ports": []}], "local_ports": [5432]},
        }),
    );
    let (fake, rt) = Fake::start("amend", project_broker(project("direct", Some(g))));

    // a "no": the broker's exact text was shown, nothing was stored
    let no = dialogs(false);
    assert_eq!(
        rt.project_allow_previews(&no, "p", &[5173]).unwrap_err(),
        "cancelled"
    );
    assert!(!fake.cmds().contains(&"project-grant".to_owned()));
    let shown = no.shown.lock().unwrap()[0].1.clone();
    assert!(shown.starts_with("CONSENT "), "{shown}");

    // a "yes": the complete, amended permissions are previewed, shown and stored
    let yes = dialogs(true);
    rt.project_allow_previews(&yes, "p", &[5173, 3000]).unwrap();
    let set = fake.frame("project-grant").expect("stored");
    let p = &set["params"];
    assert_eq!(p["devPorts"], json!([3000, 5173]), "sorted, de-duplicated, additive");
    assert_eq!(p["fs"], "workspace");
    assert_eq!(p["net"], "controlled");
    assert_eq!(p["checkpoint"], "required", "recovery policy kept");
    assert_eq!(p["hardLinks"], "allow");
    assert_eq!(p["gitWrite"], true, "an existing Git-write choice is kept, never widened or hidden");
    assert_eq!(p["allowHosts"], json!(["registry.npmjs.org:443", "github.com"]), "{p}");
    assert_eq!(p["allowLocalPorts"], json!([5432]));
    assert_eq!(p["surface"], "desktop");
    assert_eq!(p["textSha256"], "a".repeat(64), "the digest of the text that was shown");
    // the lifetime is the REMAINING one: never extended by amending
    let secs = p["expiresInSecs"].as_u64().unwrap();
    assert!((3590..=3600).contains(&secs), "{secs}");
    // what the person was shown named the new port
    assert!(yes.shown.lock().unwrap()[0].1.contains("[3000,5173]"));
}

#[test]
fn previews_are_refused_before_any_dialog_when_they_cannot_work_or_are_not_ports() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let cases: Vec<(&str, Value, Vec<u16>, &str)> = vec![
        ("no grant at all", project("direct", None), vec![5173], "no-grant"),
        (
            "commands on a throw-away copy",
            project("direct", Some(grant("scratch", "offline", json!({})))),
            vec![5173],
            "not-available",
        ),
        (
            "an isolated project",
            project("isolated", Some(grant("workspace", "offline", json!({})))),
            vec![5173],
            "not-available",
        ),
        (
            "revoked permissions",
            project("direct", Some(grant("workspace", "offline", json!({"status": "revoked"})))),
            vec![5173],
            "ended",
        ),
        (
            "expired permissions",
            project("direct", Some(grant("workspace", "offline", json!({"status": "expired"})))),
            vec![5173],
            "ended",
        ),
        (
            "a reserved port",
            project("direct", Some(grant("workspace", "offline", json!({})))),
            vec![80],
            "reserved",
        ),
        (
            "no port",
            project("direct", Some(grant("workspace", "offline", json!({})))),
            vec![],
            "between one and eight",
        ),
        (
            "too many ports",
            project("direct", Some(grant("workspace", "offline", json!({})))),
            (3000..3009).collect(),
            "between one and eight",
        ),
    ];
    for (name, proj, ports, expect) in cases {
        let (fake, rt) = Fake::start("refuse", project_broker(proj));
        let d = dialogs(true);
        let e = rt.project_allow_previews(&d, "p", &ports).unwrap_err();
        assert!(e.contains(expect), "{name}: {e}");
        assert!(d.shown.lock().unwrap().is_empty(), "{name}: a dialog was shown");
        assert!(!fake.cmds().contains(&"project-grant".to_owned()), "{name}");
    }
}

#[test]
fn editing_permissions_keeps_what_the_panel_does_not_offer() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let g = grant(
        "workspace",
        "offline",
        json!({"devPorts": [4321], "checkpoint": "required", "hardLinks": "allow", "gitWrite": true}),
    );
    let (fake, rt) = Fake::start("keep", project_broker(project("direct", Some(g))));
    let d = dialogs(true);
    // the panel changes only the lifetime: previews, recovery policy and the Git choice must survive
    rt.project_set_grant_keeping(&d, "p", "workspace", "offline", "auto", Some(86_400), &Default::default(), None)
        .unwrap();
    let p = fake.frame("project-grant").unwrap()["params"].clone();
    assert_eq!(p["devPorts"], json!([4321]));
    assert_eq!(p["checkpoint"], "required");
    assert_eq!(p["hardLinks"], "allow");
    assert_eq!(p["gitWrite"], true);
    assert_eq!(p["expiresInSecs"], 86_400);

    // explicitly clearing the ports clears them; leaving the project folder drops them (nothing to preview)
    rt.project_set_grant_keeping(&d, "p", "workspace", "offline", "auto", None, &Default::default(), Some(vec![]))
        .unwrap();
    assert!(fake.frame("project-grant").unwrap()["params"].get("devPorts").is_none());
    rt.project_set_grant_keeping(&d, "p", "scratch", "offline", "auto", None, &Default::default(), None)
        .unwrap();
    assert!(fake.frame("project-grant").unwrap()["params"].get("devPorts").is_none());
}

#[test]
fn a_revoked_permission_set_is_not_silently_revived_with_its_old_options() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let g = grant(
        "workspace",
        "offline",
        json!({"status": "revoked", "devPorts": [4321], "checkpoint": "off", "gitWrite": true}),
    );
    let (fake, rt) = Fake::start("revived", project_broker(project("direct", Some(g))));
    let d = dialogs(true);
    rt.project_set_grant_keeping(&d, "p", "workspace", "offline", "auto", None, &Default::default(), None)
        .unwrap();
    let p = fake.frame("project-grant").unwrap()["params"].clone();
    assert!(p.get("devPorts").is_none(), "{p}");
    assert!(p.get("gitWrite").is_none(), "{p}");
    assert_eq!(p["checkpoint"], "best-effort", "defaults, not the revoked grant's weaker policy");
}

// ---- one-step "allow Nexus to edit this project" ------------------------------------------------

#[test]
fn allowing_work_asks_for_the_folder_and_the_commands_separately_and_never_picks_full_access() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (fake, rt) = Fake::start("work", project_broker(project("isolated", None)));
    let d = dialogs(true);
    rt.project_allow_work(&d, "p").unwrap();
    let shown: Vec<String> = d.shown.lock().unwrap().iter().map(|s| s.0.clone()).collect();
    assert_eq!(
        shown,
        vec![
            "Let Nexus edit this folder directly?".to_owned(),
            "Change this project's permissions".to_owned()
        ],
        "one native dialog for the folder, one with the broker's exact text for the commands"
    );
    assert_eq!(fake.frame("project-workspace").unwrap()["params"]["workspace"], "direct");
    let p = fake.frame("project-grant").unwrap()["params"].clone();
    assert_eq!((p["fs"].as_str(), p["net"].as_str(), p["approval"].as_str()), (Some("workspace"), Some("offline"), Some("auto")));
    assert!(p.get("devPorts").is_none() && p.get("gitWrite").is_none() && p["expiresInSecs"].is_null());

    // a "no" to the folder stops everything: nothing was changed
    let (fake, rt) = Fake::start("work-no", project_broker(project("isolated", None)));
    let no = dialogs(false);
    assert_eq!(rt.project_allow_work(&no, "p").unwrap_err(), "cancelled");
    assert!(!fake.cmds().contains(&"project-workspace".to_owned()));
    assert!(!fake.cmds().contains(&"project-grant".to_owned()));
}

#[test]
fn allowing_work_raises_only_the_scope_of_existing_permissions_and_refuses_to_touch_full_access() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (fake, rt) = Fake::start(
        "work-scratch",
        project_broker(project("direct", Some(grant("scratch", "install", json!({"approval": "auto", "devPorts": []}))))),
    );
    let d = dialogs(true);
    rt.project_allow_work(&d, "p").unwrap();
    let p = fake.frame("project-grant").unwrap()["params"].clone();
    assert_eq!((p["fs"].as_str(), p["net"].as_str()), (Some("workspace"), Some("install")), "{p}");
    // already direct: no folder dialog
    assert_eq!(d.shown.lock().unwrap().len(), 1);

    // already working in place: nothing to do, nothing is sent
    let (fake, rt) = Fake::start(
        "work-done",
        project_broker(project("direct", Some(grant("workspace", "offline", json!({}))))),
    );
    let d = dialogs(true);
    rt.project_allow_work(&d, "p").unwrap();
    assert!(d.shown.lock().unwrap().is_empty());
    assert!(!fake.cmds().contains(&"project-grant".to_owned()));

    // Full Access is never silently changed from here
    let (fake, rt) = Fake::start(
        "work-full",
        project_broker(project("direct", Some(grant("full", "full", json!({}))))),
    );
    let d = dialogs(true);
    let e = rt.project_allow_work(&d, "p").unwrap_err();
    assert!(e.contains("Full Access"), "{e}");
    assert!(!fake.cmds().contains(&"project-grant".to_owned()));
}

// ---- dependency downloads --------------------------------------------------------------------------

#[test]
fn dependency_downloads_toggle_install_only_network_and_never_replace_a_destination_list() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (fake, rt) = Fake::start(
        "inst-on",
        project_broker(project("direct", Some(grant("workspace", "offline", json!({}))))),
    );
    let d = dialogs(true);
    rt.project_allow_installs(&d, "p", true).unwrap();
    assert_eq!(fake.frame("project-grant").unwrap()["params"]["net"], "install");
    let (fake, rt) = Fake::start(
        "inst-off",
        project_broker(project("direct", Some(grant("workspace", "install", json!({}))))),
    );
    rt.project_allow_installs(&d, "p", false).unwrap();
    assert_eq!(fake.frame("project-grant").unwrap()["params"]["net"], "offline");
    // specific destinations / full network are advanced settings: refused, not overwritten
    for net in ["controlled", "full"] {
        let (fake, rt) = Fake::start(
            "inst-adv",
            project_broker(project("direct", Some(grant("workspace", net, json!({}))))),
        );
        let e = rt.project_allow_installs(&d, "p", true).unwrap_err();
        assert!(e.contains("Advanced permissions"), "{e}");
        assert!(!fake.cmds().contains(&"project-grant".to_owned()));
    }
}

#[test]
fn widening_policies_need_a_native_yes_and_narrowing_does_not() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (fake, rt) = Fake::start("policy", Box::new(|_| Ok(json!({"project": {}}))));
    let no = dialogs(false);
    assert_eq!(rt.project_set_policy(&no, "p", Some(true), None).unwrap_err(), "cancelled");
    assert_eq!(rt.project_set_policy(&no, "p", None, Some(true)).unwrap_err(), "cancelled");
    assert!(!fake.cmds().contains(&"project-policy".to_owned()), "a declined dialog widened a policy");
    // turning OFF needs no dialog
    rt.project_set_policy(&no, "p", Some(false), Some(false)).unwrap();
    assert!(no.shown.lock().unwrap().len() == 2, "only the two declined requests showed a dialog");
    let yes = dialogs(true);
    rt.project_set_policy(&yes, "p", Some(true), None).unwrap();
    assert_eq!(fake.frame("project-policy").unwrap()["params"]["installs"], true);
}

// ---- previews: the address is the broker's ------------------------------------------------------------

#[test]
fn a_preview_opens_the_brokers_loopback_address_and_only_while_the_server_runs() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let state = Arc::new(Mutex::new("running"));
    let st = state.clone();
    let (fake, rt) = Fake::start(
        "preview",
        Box::new(move |f| match f["cmd"].as_str().unwrap_or("") {
            "job-status" => Ok(json!({
                "jobId": f["params"]["jobId"], "state": *st.lock().unwrap(),
                "exposed": [{"port": 5173, "hostPort": 43111, "url": "http://evil.example/"}],
            })),
            _ => Ok(json!({})),
        }),
    );
    let d = dialogs(true);
    let url = rt.preview_open(&d, "job-1", 5173).unwrap();
    assert_eq!(url, "http://127.0.0.1:43111", "built from the broker's host port, not from any address string");
    assert_eq!(*d.opened.lock().unwrap(), vec!["http://127.0.0.1:43111".to_owned()]);
    // a port the job does not publish
    let e = rt.preview_open(&d, "job-1", 9999).unwrap_err();
    assert!(e.contains("not published"), "{e}");
    // a stopped server
    *state.lock().unwrap() = "stopped";
    let e = rt.preview_open(&d, "job-1", 5173).unwrap_err();
    assert!(e.contains("not running"), "{e}");
    assert_eq!(d.opened.lock().unwrap().len(), 1, "nothing else was opened");
    assert!(fake.cmds().iter().all(|c| c == "job-status"));
}

#[test]
fn only_a_local_loopback_preview_address_is_ever_opened() {
    for ok in ["http://127.0.0.1:5173", "http://127.0.0.1:1", "http://127.0.0.1:65535"] {
        assert!(is_local_preview_url(ok), "{ok}");
    }
    for bad in [
        "http://127.0.0.1",
        "http://127.0.0.1:",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:80/evil",
        "http://127.0.0.1:80@evil.example",
        "https://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1.evil.example:5173",
        "file:///etc/passwd",
        "--help",
        "",
    ] {
        assert!(!is_local_preview_url(bad), "{bad}");
    }
    // the scripted browser enforces the same rule as the system one
    assert!(dialogs(true).open_url("http://example.org").is_err());
}

// ---- recovery -------------------------------------------------------------------------------------

fn restore_broker(refused: Option<&'static str>) -> Handler {
    Box::new(move |f| {
        if f["cmd"] == "exec-restore-preview" || f["cmd"] == "exec-restore" {
            return Ok(json!({
                "restore": {
                    "executionId": f["params"]["executionId"], "outcome": "completed",
                    "refused": refused,
                    "restored": [{"path": "src/a.txt", "detail": "restored"}],
                    "skipped": [], "conflicted": [{"path": "src/b.txt", "detail": "changed since"}], "unrecoverable": [],
                },
                "confirmDigest": "digest-one",
            }));
        }
        Ok(json!({}))
    })
}

#[test]
fn a_restore_is_bound_to_the_reviewed_digest_and_a_native_yes() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (fake, rt) = Fake::start("restore", restore_broker(None));

    // the files moved since the person looked: refused before any dialog
    let d = dialogs(true);
    let e = rt.restore_apply(&d, "exec-1", "stale-digest").unwrap_err();
    assert!(e.starts_with("changed:"), "{e}");
    assert!(d.shown.lock().unwrap().is_empty());

    // a "no": the exact outcome was shown, nothing was applied
    let no = dialogs(false);
    assert_eq!(rt.restore_apply(&no, "exec-1", "digest-one").unwrap_err(), "cancelled");
    let text = no.shown.lock().unwrap()[0].1.clone();
    assert!(text.contains("src/a.txt") && text.contains("src/b.txt"), "{text}");
    assert!(text.contains("left exactly as they are"), "{text}");
    assert!(
        fake.frames.lock().unwrap().iter().all(|f| f["cmd"] != "exec-restore" || f["params"]["dryRun"] != false),
        "nothing was applied"
    );

    // a "yes" with the reviewed digest applies, with the digest and the Desktop's surface
    rt.restore_apply(&dialogs(true), "exec-1", "digest-one").unwrap();
    let applied = fake
        .frames
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|f| f["cmd"] == "exec-restore")
        .cloned()
        .expect("applied");
    assert_eq!(applied["params"]["confirm"], "digest-one");
    assert_eq!(applied["params"]["surface"], "desktop");
}

#[test]
fn a_refused_restore_shows_no_dialog_and_applies_nothing() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (fake, rt) = Fake::start("restore-refused", restore_broker(Some("the task still has a command in progress")));
    let d = dialogs(true);
    let e = rt.restore_apply(&d, "exec-1", "digest-one").unwrap_err();
    assert!(e.starts_with("refused:") && e.contains("command in progress"), "{e}");
    assert!(d.shown.lock().unwrap().is_empty());
    assert!(!fake.cmds().contains(&"exec-restore".to_owned()));
}

#[test]
fn effects_are_trimmed_for_display() {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (_fake, rt) = Fake::start(
        "effects",
        Box::new(|_| {
            Ok(json!({"effects": {
                "executionId": "exec-1", "outcome": "observed", "postState": {"a": 1}, "grant": {"x": 1},
                "timingMs": {"run": 5}, "pre": {}, "post": {},
                "effects": {"created": {"paths": ["a"]}, "postSha256": {"a": "h"}},
            }}))
        }),
    );
    let v = rt.exec_effects_view("exec-1").unwrap();
    let e = &v["effects"];
    for k in ["postState", "grant", "timingMs", "pre", "post"] {
        assert!(e.get(k).is_none(), "{k} leaked");
    }
    assert!(e["effects"].get("postSha256").is_none());
    assert_eq!(e["outcome"], "observed");
    assert!(e["effects"]["created"].is_object());
}
