//! LIVE (M4.5): the four permission scenarios through the real Mac coordinator, bridge, embedded Linux engine,
//! broker, sandbox and a REAL model (the person's connected provider, used only through the engine's own session;
//! no credential is read here). Ignored by default; needs the app closed and the engine image provisioned by a
//! launch of the rebuilt Nexus.app. The native dialogs are SCRIPTED: a scripted person is not a person, and
//! every dialog the code shows is printed so the text can be read.
//!
//!   NEXUS_VM_HELPER=<Nexus.app>/Contents/MacOS/nexus-vm \
//!     cargo test --test live_m45 -- --ignored --nocapture --test-threads=1 <scenario>

use nexus_desktop_lib::bridge_link::BridgeLink;
use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::engine::EngineLink;
use nexus_desktop_lib::engine_config::EngineConfig;
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::registry::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn app_dir() -> (PathBuf, PathBuf) {
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    (
        home.join("Library/Application Support/ai.arthurlabs.nexus.desktop"),
        home,
    )
}

fn until<T>(what: &str, secs: u64, mut f: impl FnMut() -> Option<T>) -> T {
    let t = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t.elapsed() < Duration::from_secs(secs), "timed out: {what}");
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn demo(name: &str) -> PathBuf {
    let (_, home) = app_dir();
    let root = home.join("Projects").join(name);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(
        root.join("README.md"),
        "# todo\n\nA todo command-line app.\n",
    )
    .unwrap();
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\nname = \"todo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::canonicalize(&root).unwrap()
}

struct Rig {
    link: Arc<BridgeLink>,
    c: Arc<Coordinator>,
    dialogs: ScriptedDialogs,
    root: PathBuf,
    data: PathBuf,
    gid: String,
}

fn rig(name: &str, confirm: bool) -> Rig {
    let root = demo(name);
    let (dir, home) = app_dir();
    let data = std::env::temp_dir().join(format!("nexus-m45-{name}"));
    let _ = std::fs::remove_dir_all(&data);
    let scripted = ScriptedDialogs {
        confirm: true,
        ..Default::default()
    };
    let boot: Arc<dyn Dialogs> = Arc::new(scripted.clone());
    let link: Arc<BridgeLink> = {
        assert!(EngineConfig::wants_vm(&dir));
        let helper = nexus_desktop_lib::engine_vm::VmTransport::locate_helper()
            .expect("set NEXUS_VM_HELPER");
        let vm = Arc::new(nexus_desktop_lib::engine_vm::VmTransport::new(
            helper, None, None, &dir,
        ));
        BridgeLink::start(Box::new(vm), boot, env!("CARGO_PKG_VERSION"))
    };
    until("engine ready", 120, || {
        link.status().is_ready().then_some(())
    });
    let rs = until("runtime ready", 180, || {
        let v = link.call("runtime_state", json!({})).ok()?;
        (v["phase"] == "ready").then_some(v)
    });
    assert_eq!(rs["providerConnected"], true, "no provider connected");
    // onboarding needs the "allow" answer (the one consent a test cannot click); done first, with its own store
    let onboard = Coordinator::new(
        Arc::new(Store::open(&data).unwrap()),
        link.clone(),
        Arc::new(ScriptedDialogs {
            confirm: true,
            ..Default::default()
        }),
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    onboard.open_project(root.to_str().unwrap()).unwrap();
    // the coordinator under test then answers every later dialog as the scenario says
    let dialogs = ScriptedDialogs {
        confirm,
        ..Default::default()
    };
    let c = Coordinator::new(
        Arc::new(Store::open(&data).unwrap()),
        link.clone(),
        Arc::new(dialogs.clone()),
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    let gid = c.store.list()[0].guest_id.clone().unwrap();
    Rig {
        link,
        c,
        dialogs,
        root,
        data,
        gid,
    }
}

impl Rig {
    fn send(&self, text: &str, mode: &str) -> Result<String, nexus_desktop_lib::dto::UiError> {
        let key = format!(
            "m45-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let r = self.c.serve(
            "thread_send",
            json!({"threadId": null, "projectId": self.gid, "content": text, "mode": "auto", "workspace": "continue",
                   "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null,
                   "idempotencyKey": key, "engine": null, "permissionMode": mode}),
        )?;
        Ok(r["run"]["runId"].as_str().unwrap().to_owned())
    }
    fn status(&self, run: &str) -> Value {
        self.link
            .call("intent_status", json!({"runId": run}))
            .unwrap()
    }
    fn sync_state(&self, run: &str) -> String {
        serde_json::to_value(self.c.store.list()[0].run(run).map(|x| x.sync.clone())).unwrap()
            ["state"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    }
    /// Drive the run to its end. `on_pending` is the (scripted) person: it gets each request and answers it.
    fn drive(&self, run: &str, secs: u64, mut on_pending: impl FnMut(&Self, &Value)) -> Value {
        let mut answered = std::collections::HashSet::new();
        let start = Instant::now();
        loop {
            self.c.tick();
            let st = self.status(run);
            if let Some(p) = st["pendingPermission"].as_object() {
                let id = p["requestId"].as_str().unwrap_or("").to_owned();
                if !id.is_empty() && answered.insert(id) {
                    on_pending(self, &Value::Object(p.clone()));
                }
            }
            if st["terminal"] == true
                && matches!(
                    self.sync_state(run).as_str(),
                    "applied" | "conflict" | "failed" | "not-applied" | ""
                )
            {
                return st;
            }
            assert!(
                start.elapsed() < Duration::from_secs(secs),
                "run did not finish: {}",
                st["state"]
            );
            std::thread::sleep(Duration::from_millis(700));
        }
    }
    fn decide(&self, run: &str, p: &Value, d: &str) {
        self.c
            .serve("permission_decide", json!({"runId": run, "requestId": p["requestId"], "digest": p["digest"], "decision": d}))
            .unwrap();
    }
    fn activity(&self, run: &str) -> Vec<Value> {
        let page = self
            .link
            .call(
                "intent_activity",
                json!({"runId": run, "offset": 0, "limit": 300}),
            )
            .unwrap();
        page["activity"].as_array().cloned().unwrap_or_default()
    }
    fn print_record(&self, run: &str, st: &Value) {
        println!(
            "mode={} state={} completion={} verification={}",
            st["permissionMode"],
            st["state"],
            st["completion"],
            st["codingOutcome"]["verification"]
        );
        for a in self
            .activity(run)
            .iter()
            .filter(|a| a["tool"] == "proc_run")
        {
            println!(
                "  #{:<3} {:<9} exit={:<5} class={:<18} mode={:<9} decision={:<17} code={:<20} {}",
                a["index"],
                a["status"].as_str().unwrap_or(""),
                a["exitCode"],
                a["opClass"].as_str().unwrap_or("-"),
                a["permissionMode"].as_str().unwrap_or("-"),
                a["permissionDecision"].as_str().unwrap_or("-"),
                a["errorCode"].as_str().unwrap_or("-"),
                a["argsSummary"].as_str().unwrap_or("")
            );
        }
        for e in st["permissionEvents"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            println!(
                "  event {:<24} mode={:<9} {}",
                e["kind"].as_str().unwrap_or(""),
                e["mode"].as_str().unwrap_or(""),
                e["detail"].as_str().unwrap_or("")
            );
        }
        for d in st["dependencies"].as_array().cloned().unwrap_or_default() {
            println!(
                "  dep   {} {} {:?} -> {} ({}) exit={}",
                d["manager"], d["verb"], d["packages"], d["outcome"], d["decision"], d["exitCode"]
            );
        }
        for (t, x) in self.dialogs.shown.lock().unwrap().iter() {
            println!("  DIALOG [{t}] {}", x.replace('\n', " | "));
        }
    }
    fn finish(self) {
        let _ = self.c.forget(&self.gid);
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_dir_all(&self.data);
        self.link.shutdown();
    }
}

const TASK: &str = "Create a small Rust command-line todo app in this project (a Cargo crate named todo). Use the clap crate (derive feature) for the command line and the rusqlite crate (bundled feature) to store tasks in a SQLite file. Add the dependencies, make `cargo build` succeed, write at least one unit test that uses rusqlite with an in-memory database, run `cargo test`, and fix anything that fails. Report the real results.";

fn files_text(root: &Path) -> String {
    std::fs::read_to_string(root.join("Cargo.toml")).unwrap_or_default()
}

/// A: Ask for Approval. The dialog appears, the person approves, packages install, cargo builds and tests pass.
#[test]
#[ignore]
fn scenario_a_ask_for_approval_approve() {
    let t = rig("nexus-m45-a", true);
    let run = t.send(TASK, "ask").expect("start");
    let st = t.drive(&run, 1700, |t, p| {
        println!(
            "REQUEST: {} {:?} plan={}",
            p["program"], p["args"], p["plan"]
        );
        t.decide(&run, p, "approve");
    });
    t.print_record(&run, &st);
    let acts = t.activity(&run);
    assert!(
        st["dependencies"].as_array().is_some_and(|d| d
            .iter()
            .any(|x| x["outcome"] == "installed" && x["decision"] == "approved-once")),
        "an approved installation was recorded"
    );
    assert!(acts.iter().any(|a| a["opClass"] == "dependency-install"
        && a["permissionDecision"] == "approved-once"
        && a["exitCode"] == 0));
    assert!(
        acts.iter().any(|a| a["argsSummary"]
            .as_str()
            .unwrap_or("")
            .contains("cargo test")
            && a["exitCode"] == 0),
        "cargo test passed"
    );
    assert!(
        t.dialogs
            .shown
            .lock()
            .unwrap()
            .iter()
            .any(|(title, text)| title == "Install dependencies?"
                && text.contains("Package manager: cargo")),
        "the native dialog showed the installation"
    );
    let cargo = files_text(&t.root);
    println!("--- Cargo.toml on the Mac:\n{cargo}");
    assert!(cargo.contains("clap") && cargo.contains("rusqlite"));
    t.finish();
}

/// B: the person denies. Nothing is installed; the agent gets an explicit denial.
#[test]
#[ignore]
fn scenario_b_ask_for_approval_deny() {
    let t = rig("nexus-m45-b", true);
    let run = t.send(TASK, "ask").expect("start");
    let mut denials = 0;
    let st = t.drive(&run, 1700, |t, p| {
        denials += 1;
        println!("REQUEST #{denials}: {} {:?}", p["program"], p["args"]);
        t.decide(&run, p, "deny");
        // the agent may try again a few times; the run's own refusal limit ends a refusing loop
        if denials > 8 {
            let _ = t.link.call("intent_cancel", json!({"runId": run}));
        }
    });
    t.print_record(&run, &st);
    let acts = t.activity(&run);
    assert!(
        !st["dependencies"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .any(|x| x["outcome"] == "installed"),
        "nothing was installed"
    );
    assert!(
        !acts
            .iter()
            .any(|a| a["opClass"] == "dependency-install" && a["status"] == "executed"),
        "no install command ran"
    );
    assert!(
        acts.iter().any(|a| a["errorCode"] == "permission-denied"),
        "the agent received an explicit denial"
    );
    assert!((1..=9).contains(&denials), "denials: {denials}");
    t.finish();
}

/// C: Full Access. One confirmation, no prompt during the work; installs, builds, tests.
#[test]
#[ignore]
fn scenario_c_full_access() {
    let t = rig("nexus-m45-c", true);
    let run = t.send(TASK, "full").expect("start");
    let st = t.drive(&run, 1700, |_, p| panic!("Full Access asked: {p}"));
    t.print_record(&run, &st);
    let acts = t.activity(&run);
    let shown = t.dialogs.shown.lock().unwrap().clone();
    assert_eq!(
        shown
            .iter()
            .filter(|(title, _)| title == "Full Access")
            .count(),
        1,
        "exactly one Full Access confirmation"
    );
    assert!(
        !shown.iter().any(|(title, _)| title.contains("Install")),
        "no installation prompt"
    );
    assert!(st["permissionEvents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["kind"] != "requested"));
    assert!(acts.iter().any(|a| a["opClass"] == "dependency-install"
        && a["permissionDecision"] == "auto-full-access"
        && a["exitCode"] == 0));
    assert!(
        acts.iter().any(|a| a["argsSummary"]
            .as_str()
            .unwrap_or("")
            .contains("cargo test")
            && a["exitCode"] == 0),
        "cargo test passed"
    );
    assert!(st["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["decision"] == "auto-full-access" && d["outcome"] == "installed"));
    t.finish();
}

/// D: Full Access, switched to Ask for Approval while the run works; later installs must ask.
#[test]
#[ignore]
fn scenario_d_switch_from_full_access_to_ask_during_the_run() {
    let t = rig("nexus-m45-d", true);
    let task = format!("{TASK} When everything passes, ALSO add the crate `itoa` as a dependency and use it to format the task number in the todo list output, then run cargo test again.");
    let run = t.send(&task, "full").expect("start");
    let mut switched = false;
    let mut asked_after_switch = 0;
    let start = Instant::now();
    let st = loop {
        t.c.tick();
        let st = t.status(&run);
        let ran_install = t
            .activity(&run)
            .iter()
            .any(|a| a["opClass"] == "dependency-install" && a["status"] == "executed");
        if !switched && ran_install && st["terminal"] != true {
            // the person lowers the mode while the run works: immediate, no dialog
            t.c.serve("permission_set_mode", json!({"runId": run, "mode": "ask"}))
                .expect("downgrade");
            switched = true;
            println!("SWITCHED to ask after the first automatic installation");
        }
        if let Some(p) = st["pendingPermission"].as_object() {
            if switched {
                asked_after_switch += 1;
                println!("REQUEST after the switch: {} {:?}", p["program"], p["args"]);
                t.decide(&run, &Value::Object(p.clone()), "approve");
                std::thread::sleep(Duration::from_secs(2));
            }
        }
        if st["terminal"] == true
            && matches!(
                t.sync_state(&run).as_str(),
                "applied" | "conflict" | "failed" | "not-applied" | ""
            )
        {
            break st;
        }
        assert!(
            start.elapsed() < Duration::from_secs(1700),
            "run did not finish"
        );
        std::thread::sleep(Duration::from_millis(600));
    };
    t.print_record(&run, &st);
    let acts = t.activity(&run);
    assert!(switched, "the run never installed anything before ending");
    let kinds: Vec<String> = st["permissionEvents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap_or("").to_owned())
        .collect();
    assert!(kinds.contains(&"mode-downgrade".to_owned()));
    // every install that ran BEFORE the switch is auto (Full); any AFTER it was requested and approved
    let installs: Vec<&Value> = acts
        .iter()
        .filter(|a| a["opClass"] == "dependency-install")
        .collect();
    assert!(installs
        .iter()
        .any(|a| a["permissionMode"] == "full" && a["permissionDecision"] == "auto-full-access"));
    for a in installs.iter().filter(|a| a["permissionMode"] == "ask") {
        assert!(
            matches!(
                a["permissionDecision"].as_str(),
                Some("approved-once" | "denied")
            ),
            "an install after the switch ran without a decision: {a}"
        );
    }
    println!("requests after the switch: {asked_after_switch}");
    t.finish();
}
