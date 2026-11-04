//! LIVE end-to-end of macOS workspaces: a real Mac folder, the real coordinator and bridge code, SSH
//! to the Fedora engine, a real model-driven task in the real sandbox, and the verified writeback.
//! Ignored by default (needs the guest, the restricted key and a provider). Native dialogs are scripted
//! to ALLOW the one onboarding consent (a test cannot click); nothing else is scripted.
//!
//!   cargo test --test live_m3 -- --ignored --nocapture --test-threads=1 <scenario>

use nexus_desktop_lib::bridge_link::BridgeLink;
use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::engine::{EngineLink, EngineStatus};
use nexus_desktop_lib::engine_config::EngineConfig;
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::registry::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Rig {
    link: Arc<BridgeLink>,
    c: Arc<Coordinator>,
    data: PathBuf,
    root: PathBuf,
}

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

fn w(root: &Path, rel: &str, c: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, c).unwrap();
}
fn r(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|_| "<absent>".into())
}

/// A disposable development project on the Mac.
fn demo(name: &str) -> PathBuf {
    let (_, home) = app_dir();
    let root = home.join("Projects").join(name);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    w(&root, "package.json", "{\n  \"name\": \"calc-demo\",\n  \"version\": \"1.0.0\",\n  \"scripts\": { \"test\": \"node --test\" }\n}\n");
    w(
        &root,
        "calc.js",
        "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
    );
    w(&root, "calc.test.js", "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./calc');\ntest('add', () => { assert.strictEqual(add(2, 3), 5); });\n");
    w(&root, "README.md", "# calc-demo\n\nA tiny calculator.\n");
    w(&root, ".env", "API_KEY=do-not-copy\n");
    std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
    w(&root, "node_modules/x/index.js", "// dependency\n");
    std::fs::canonicalize(&root).unwrap()
}

fn start(link: Option<Arc<BridgeLink>>, data: &Path, root: &Path) -> Rig {
    let (dir, home) = app_dir();
    let link = link.unwrap_or_else(|| {
        let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
            confirm: true,
            ..Default::default()
        });
        #[cfg(target_os = "macos")]
        if EngineConfig::wants_vm(&dir) {
            // the embedded engine, exactly as the app starts it (the app has already provisioned the image)
            let helper = nexus_desktop_lib::engine_vm::VmTransport::locate_helper()
                .expect("set NEXUS_VM_HELPER");
            let vm = Arc::new(nexus_desktop_lib::engine_vm::VmTransport::new(
                helper, None, None, &dir,
            ));
            return BridgeLink::start(Box::new(vm), d, env!("CARGO_PKG_VERSION"));
        }
        let t = EngineConfig::load(&dir, &home)
            .unwrap()
            .expect("engine.json");
        BridgeLink::start(Box::new(t), d, env!("CARGO_PKG_VERSION"))
    });
    until("engine ready", 60, || {
        link.status().is_ready().then_some(())
    });
    until("guest runtime ready", 120, || {
        (link.call("runtime_state", json!({})).ok()?["phase"] == "ready").then_some(())
    });
    let store = Arc::new(Store::open(data).unwrap());
    let dialogs: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: true,
        ..Default::default()
    });
    let c = Coordinator::new(
        store,
        link.clone(),
        dialogs,
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    Rig {
        link,
        c,
        data: data.to_owned(),
        root: root.to_owned(),
    }
}

fn fresh(name: &str) -> Rig {
    let root = demo(name);
    let data = std::env::temp_dir().join(format!("nexus-m3-{name}"));
    let _ = std::fs::remove_dir_all(&data);
    start(None, &data, &root)
}

impl Rig {
    fn pick(&self) -> Value {
        let v = self.c.open_project(self.root.to_str().unwrap()).unwrap();
        println!(
            "onboarded: macPath={} sync={} label={} created={}",
            v["project"]["macPath"],
            v["project"]["sync"]["state"],
            v["project"]["label"],
            v["created"]
        );
        v
    }
    fn gid(&self) -> String {
        self.c.store.list()[0].guest_id.clone().unwrap()
    }
    fn send(&self, text: &str) -> Result<Value, nexus_desktop_lib::dto::UiError> {
        let key = format!(
            "m3-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        self.c.serve("thread_send", json!({"threadId": null, "projectId": self.gid(), "content": text, "mode": "auto", "workspace": "continue",
            "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null, "idempotencyKey": key, "engine": null}))
    }
    fn sync_state(&self, run: &str) -> String {
        self.c.store.list()[0]
            .run(run)
            .map(|x| {
                serde_json::to_value(&x.sync).unwrap()["state"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .unwrap_or_default()
    }
    fn wait_final(&self, run: &str) -> String {
        let mut last = String::new();
        until("run synchronized", 900, || {
            self.c.tick();
            let s = self.sync_state(run);
            if s != last {
                println!("  run {run}: sync -> {s}");
                last = s.clone();
            }
            matches!(
                s.as_str(),
                "applied" | "conflict" | "failed" | "not-applied"
            )
            .then_some(s)
        })
    }
    fn run_id(reply: &Value) -> String {
        reply["run"]["runId"].as_str().unwrap().to_owned()
    }
    fn engine_status(&self, run: &str) -> Value {
        self.link
            .call("intent_status", json!({"runId": run}))
            .unwrap()
    }
}

const TASK: &str = "Add a `multiply(a, b)` function to calc.js and export it. Add a test for it to calc.test.js. Then run `npm test` and make sure it passes.";

#[test]
#[ignore]
fn happy_path_then_second_task_after_a_host_edit() {
    let t = fresh("nexus-m3-demo");
    let v = t.pick();
    assert_eq!(v["project"]["macPath"], t.root.to_str().unwrap());
    assert!(
        !format!("{v}").contains("NexusMac"),
        "no engine paths in what the UI sees"
    );
    // engine copy: filtered
    let g = t.c.store.list()[0].clone();
    println!(
        "skipped on the way over: {:?}",
        g.skipped.iter().map(|s| s.path.clone()).collect::<Vec<_>>()
    );
    assert!(
        g.skipped.iter().any(|s| s.path == ".env")
            && g.skipped.iter().any(|s| s.path == "node_modules/")
    );

    let sent = t.send(TASK).unwrap();
    let run = Rig::run_id(&sent);
    println!(
        "task 1 submitted: {run}, hostSync={}",
        sent["run"]["hostSync"]["state"]
    );
    assert_eq!(t.wait_final(&run), "applied");
    let st = t.engine_status(&run);
    println!(
        "engine verdict: state={} completion={} verification={}",
        st["state"], st["completion"], st["codingOutcome"]["verification"]
    );
    assert_eq!(st["codingOutcome"]["verification"], "verified-passed");
    let calc = r(&t.root, "calc.js");
    println!("--- calc.js on the Mac now:\n{calc}");
    assert!(calc.contains("multiply"));
    assert_eq!(r(&t.root, ".env"), "API_KEY=do-not-copy\n");
    // the Mac's own toolchain agrees with the engine's verdict
    let out = std::process::Command::new("node")
        .arg("--test")
        .current_dir(&t.root)
        .output()
        .unwrap();
    println!(
        "host `node --test`: {}",
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| l.contains("# pass") || l.contains("# fail"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    assert!(out.status.success(), "tests pass on the Mac too");
    let applied_gen = t.c.store.list()[0].generation;

    // "open in the normal macOS editor": the person edits README on the Mac, then a second task
    w(
        &t.root,
        "README.md",
        "# calc-demo\n\nA tiny calculator. (edited on the Mac)\n",
    );
    let sent2 = t.send("Add a `subtract(a, b)` function to calc.js (export it) with a test in calc.test.js, run `npm test`, make sure it passes.").unwrap();
    let run2 = Rig::run_id(&sent2);
    println!("task 2 submitted: {run2}");
    assert_eq!(t.wait_final(&run2), "applied");
    assert!(
        r(&t.root, "calc.js").contains("subtract") && r(&t.root, "calc.js").contains("multiply")
    );
    assert!(
        r(&t.root, "README.md").contains("edited on the Mac"),
        "the person's edit survived"
    );
    assert!(t.c.store.list()[0].generation > applied_gen);
    // duplicate completion events: no second writeback
    let gen = t.c.store.list()[0].generation;
    for _ in 0..3 {
        t.c.tick();
    }
    assert_eq!(t.c.store.list()[0].generation, gen);
    t.link.shutdown();
}

#[test]
#[ignore]
fn host_edit_during_execution_is_a_conflict() {
    let t = fresh("nexus-m3-conflict");
    t.pick();
    let sent = t.send("Change the `add` function in calc.js to also accept a third optional argument `c` (default 0) and add it to the result. Update the test in calc.test.js to cover it and run `npm test`.").unwrap();
    let run = Rig::run_id(&sent);
    // the person edits the same file in their Mac editor while Nexus works
    std::thread::sleep(Duration::from_secs(1));
    w(&t.root, "calc.js", "// edited by the person in their editor while Nexus was working\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
    let s = t.wait_final(&run);
    println!("final: {s}");
    assert_eq!(s, "conflict");
    assert!(
        r(&t.root, "calc.js").starts_with("// edited by the person"),
        "the person's file is untouched"
    );
    let rec = t.c.store.list()[0].run(&run).cloned().unwrap();
    println!(
        "conflicts: {:?}; Nexus's result kept at {:?}",
        rec.conflicts, rec.saved_result
    );
    let saved = PathBuf::from(rec.saved_result.unwrap());
    assert!(
        r(&saved, "calc.js").contains("function add"),
        "Nexus's version is preserved"
    );
    // the next task is refused until it is resolved
    assert_eq!(t.send("anything").unwrap_err().code, "sync-sync-conflict");
    t.link.shutdown();
}

#[test]
#[ignore]
fn cancelled_and_unverified_runs_never_overwrite() {
    let t = fresh("nexus-m3-nonqual");
    t.pick();
    // cancelled right after it starts
    let sent = t.send("Rewrite calc.js completely with a different design and add many helper functions, then run npm test.").unwrap();
    let run = Rig::run_id(&sent);
    let c = t
        .link
        .call("intent_cancel", json!({"runId": run, "reason": null}));
    println!(
        "cancel -> {:?}",
        c.as_ref()
            .map(|v| v["state"].clone())
            .map_err(|e| e.message.clone())
    );
    let s = t.wait_final(&run);
    println!("cancelled run sync: {s}");
    assert_ne!(s, "applied");
    assert_eq!(
        r(&t.root, "calc.js"),
        "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n"
    );
    // a run whose change is not verified (no command may be run)
    let engine_dirty = t.c.store.list()[0].pending_conflict().is_some();
    if !engine_dirty {
        let sent = t.send("Append the line `// unverified` to README.md. Do NOT run any command or test; just make the edit.").ok();
        if let Some(sent) = sent {
            let run = Rig::run_id(&sent);
            let s = t.wait_final(&run);
            let st = t.engine_status(&run);
            println!(
                "unverified run: engine verification={} -> sync {s}",
                st["codingOutcome"]["verification"]
            );
            if st["codingOutcome"]["verification"] != "verified-passed" {
                assert_eq!(s, "not-applied");
                assert!(!r(&t.root, "README.md").contains("unverified"));
            }
        }
    }
    t.link.shutdown();
}

#[test]
#[ignore]
fn ssh_drop_and_app_restart_mid_run() {
    let t = fresh("nexus-m3-restart");
    t.pick();
    let sent = t.send(TASK).unwrap();
    let run = Rig::run_id(&sent);
    std::thread::sleep(Duration::from_secs(2));
    // SSH disconnect: kill the ssh child process
    let n = std::process::Command::new("pkill")
        .args(["-f", "nexus_engine_app_ed25519"])
        .status()
        .unwrap();
    println!("killed ssh: {n}");
    until("link recovers", 60, || {
        let s = t.link.status();
        println!("  link: {s:?}");
        s.is_ready().then_some(())
    });
    // application restart: everything in memory is dropped; only the registry on disk survives
    let (data, root) = (t.data.clone(), t.root.clone());
    t.link.shutdown();
    drop(t.c);
    println!("-- app restarted --");
    let t2 = start(None, &data, &root);
    println!(
        "registry after restart: run {} is {:?}",
        run,
        t2.sync_state(&run)
    );
    assert_eq!(t2.wait_final(&run), "applied");
    assert!(r(&root, "calc.js").contains("multiply"));
    let gen = t2.c.store.list()[0].generation;
    for _ in 0..3 {
        t2.c.tick();
    }
    assert_eq!(
        t2.c.store.list()[0].generation,
        gen,
        "no duplicate writeback"
    );
    t2.link.shutdown();
}

#[test]
#[ignore]
fn engine_restart_mid_run_applies_nothing() {
    let t = fresh("nexus-m3-engine-restart");
    t.pick();
    let sent = t.send(TASK).unwrap();
    let run = Rig::run_id(&sent);
    std::thread::sleep(Duration::from_secs(3));
    // guest engine restart: kill the broker and daemon on the guest (admin key, test only)
    let admin = std::process::Command::new("ssh")
        .args([
            "-i",
            &format!(
                "{}/.ssh/nexus_engine_ed25519",
                std::env::var("HOME").unwrap()
            ),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "kaloyan@192.168.64.2",
            "pkill -f 'target/debug/[n]exus-broker'; pkill -f 'target/debug/[n]exusd'; echo killed",
        ])
        .output()
        .unwrap();
    println!(
        "engine killed: {}",
        String::from_utf8_lossy(&admin.stdout).trim()
    );
    let s = t.wait_final(&run);
    println!("run sync after engine restart: {s}");
    // whatever happened, only a verified-passed completion may reach the Mac folder
    let calc = r(&t.root, "calc.js");
    if s != "applied" {
        assert_eq!(
            calc,
            "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n"
        );
    } else {
        let st = t.engine_status(&run);
        assert_eq!(st["codingOutcome"]["verification"], "verified-passed");
    }
    assert!(matches!(
        t.link.status(),
        EngineStatus::Ready
            | EngineStatus::Busy { .. }
            | EngineStatus::Disconnected { .. }
            | EngineStatus::Connecting
    ));
    t.link.shutdown();
}

#[test]
#[ignore]
fn failing_checks_are_not_applied() {
    let t = fresh("nexus-m3-failing");
    t.pick();
    let sent = t
        .send("Change `add` in calc.js so it returns a - b. Do NOT touch calc.test.js and do NOT revert your change even if the test then fails. Run `npm test` once and report the result.")
        .unwrap();
    let run = Rig::run_id(&sent);
    let s = t.wait_final(&run);
    let st = t.engine_status(&run);
    println!(
        "engine: state={} completion={} verification={} -> sync {s}",
        st["state"], st["completion"], st["codingOutcome"]["verification"]
    );
    if st["codingOutcome"]["verification"] != "verified-passed" {
        assert_eq!(s, "not-applied");
        assert_eq!(
            r(&t.root, "calc.js"),
            "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
            "the Mac file is untouched"
        );
    }
    t.link.shutdown();
}

/// Housekeeping for the live scenarios: forget every demo project except the main one (through the
/// same coordinator path the app uses), so the engine's project list is left tidy.
#[test]
#[ignore]
fn zz_cleanup_extra_demo_projects() {
    let (dir, home) = app_dir();
    let t = EngineConfig::load(&dir, &home)
        .unwrap()
        .expect("engine.json");
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: true,
        ..Default::default()
    });
    let link = BridgeLink::start(Box::new(t), d.clone(), env!("CARGO_PKG_VERSION"));
    until("engine ready", 60, || {
        link.status().is_ready().then_some(())
    });
    for e in std::fs::read_dir(std::env::temp_dir()).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !n.starts_with("nexus-m3-") || n == "nexus-m3-nexus-m3-demo" {
            continue;
        }
        let store = Arc::new(Store::open(&e.path()).unwrap());
        let c = Coordinator::new(store.clone(), link.clone(), d.clone(), None);
        for p in store.list() {
            if let Some(g) = p.guest_id.clone() {
                let r = c.serve("project_forget", json!({"projectId": g}));
                println!(
                    "forget {} -> {:?}",
                    p.label,
                    r.map(|_| "ok").map_err(|e| e.message)
                );
            }
        }
        let _ = std::fs::remove_dir_all(e.path());
    }
    link.shutdown();
}

/// The embedded engine: onboarding stages a Mac folder into the microVM and registers it with the real broker.
#[test]
#[ignore]
fn vm_onboarding_stages_into_the_microvm() {
    let t = fresh("nexus-m4-vm");
    let v = t.pick();
    assert_eq!(v["project"]["sync"]["state"], "synced");
    let p = t.c.store.list()[0].clone();
    println!(
        "staged {} files; skipped {:?}",
        p.file_count,
        p.skipped.iter().map(|s| s.path.clone()).collect::<Vec<_>>()
    );
    let plan = t
        .link
        .sync(nexus_desktop_lib::sync::wire::SyncReq::ExportPlan {
            project_id: p.id.clone(),
        })
        .unwrap();
    assert_eq!(
        plan["changes"].as_array().unwrap().len(),
        0,
        "the engine's working copy equals the Mac folder"
    );
    let st = t.link.call("runtime_state", json!({})).unwrap();
    println!(
        "engine runtime: phase={} provider={}",
        st["phase"], st["providerConnected"]
    );
    // cleanup
    let _ = t.c.serve("project_forget", json!({"projectId": t.gid()}));
    t.link.shutdown();
    let _ = std::fs::remove_dir_all(&t.root);
}

/// Trace of "Run commands → Allow…" on a synchronized project, against a SEPARATE embedded engine (so the
/// running app's own engine is untouched). Prints every native dialog the engine asked for and the project as
/// the UI sees it before and after.
#[test]
#[ignore]
#[cfg(target_os = "macos")]
fn vm_allow_work_trace() {
    let (_, home) = app_dir();
    let data = std::env::temp_dir().join("nxfix-data");
    let _ = std::fs::remove_dir_all(&data);
    let img = std::env::var("NEXUS_ENGINE_IMAGE_DIR").expect("NEXUS_ENGINE_IMAGE_DIR");
    let helper =
        nexus_desktop_lib::engine_vm::VmTransport::locate_helper().expect("NEXUS_VM_HELPER");
    let vm = Arc::new(nexus_desktop_lib::engine_vm::VmTransport::new(
        helper,
        None,
        Some(PathBuf::from(img)),
        &data,
    ));
    let sd = ScriptedDialogs {
        confirm: true,
        ..Default::default()
    };
    let shown = sd.shown.clone();
    let d: Arc<dyn Dialogs> = Arc::new(sd);
    let link = BridgeLink::start(Box::new(vm.clone()), d.clone(), env!("CARGO_PKG_VERSION"));
    until("engine ready", 90, || {
        link.status().is_ready().then_some(())
    });
    until("runtime ready", 90, || {
        (link.call("runtime_state", json!({})).ok()?["phase"] == "ready").then_some(())
    });
    let root = demo("nexus-m4-allow");
    let store = Arc::new(Store::open(&data.join("sync")).unwrap());
    let c = Coordinator::new(
        store,
        link.clone(),
        d,
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    let v = c.open_project(root.to_str().unwrap()).unwrap();
    let gid = v["project"]["projectId"].as_str().unwrap().to_owned();
    let show = |tag: &str, c: &Coordinator| {
        let l = c.serve("project_list", json!({})).unwrap();
        let p = &l["projects"][0];
        println!(
            "[{tag}] workspaceMode={} grant={} sync.applyUnverified={} permissions={}",
            p["workspaceMode"], p["grant"], p["sync"]["applyUnverified"], l["permissions"]
        );
    };
    show("before", &c);
    let r = c.serve("project_allow_work", json!({"projectId": gid}));
    println!(
        "project_allow_work -> {:?}",
        r.as_ref()
            .map(|v| v.to_string().chars().take(300).collect::<String>())
            .map_err(|e| format!("{}: {}", e.code, e.message))
    );
    println!(
        "dialogs shown by the engine: {:?}",
        shown
            .lock()
            .unwrap()
            .iter()
            .map(|(t, x)| format!("{t} :: {}", x.chars().take(120).collect::<String>()))
            .collect::<Vec<_>>()
    );
    show("after", &c);
    let _ = c.serve("project_forget", json!({"projectId": gid}));
    link.shutdown();
    vm.stop();
    let _ = std::fs::remove_dir_all(&root);
}
