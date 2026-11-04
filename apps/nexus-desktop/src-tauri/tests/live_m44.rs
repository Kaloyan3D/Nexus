//! LIVE end-to-end of command execution in the rebuilt engine (M4.4): a real Rust crate on the Mac, the real
//! coordinator and bridge code, the embedded Linux engine started exactly as the app starts it, a real
//! model-driven task in the real sandbox, and the verified writeback. Ignored by default (needs the engine
//! image provisioned by a launch of the rebuilt Nexus.app, the app closed, and a connected provider). Native
//! dialogs are scripted to ALLOW the one onboarding consent (a test cannot click); nothing else is scripted.
//! The provider connection is used only through the engine's own stored session; no credential is read here.
//!
//!   NEXUS_VM_HELPER=<Nexus.app>/Contents/MacOS/nexus-vm \
//!     cargo test --test live_m44 -- --ignored --nocapture --test-threads=1

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

fn w(root: &Path, rel: &str, c: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, c).unwrap();
}

fn r(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|_| "<absent>".into())
}

/// A disposable Rust crate on the Mac whose `add` is declared `-> i64` but returns the `i32` sum.
fn demo(name: &str) -> PathBuf {
    let (_, home) = app_dir();
    let root = home.join("Projects").join(name);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    w(
        &root,
        "Cargo.toml",
        "[package]\nname = \"m44_demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n",
    );
    w(
        &root,
        "src/lib.rs",
        "pub fn add(a: i32, b: i32) -> i64 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds_two_numbers() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n",
    );
    w(&root, "README.md", "# m44_demo\n\nA tiny Rust crate.\n");
    std::fs::canonicalize(&root).unwrap()
}

const TASK: &str = "This is a Rust crate and the commands below are the point of the task, so run each one for real and quote what it printed. \
1) Run `cargo --version` and `rustc --version`. \
2) Run `cargo check --offline`; it should fail to compile: read the compiler's error. \
3) Fix the source so it compiles (do not change what the test expects), then run `cargo check --offline` again. \
4) Run `cargo test --offline` and report the test result line. \
5) Also run the program `nexus-no-such-tool-m44` with `--version` once, and the program `/usr/bin/true` once; both are expected to fail, report the exact reason the system gave for each.";

fn start_link() -> (Arc<BridgeLink>, Arc<dyn Dialogs>, PathBuf) {
    let (dir, home) = app_dir();
    let dialogs: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: true,
        ..Default::default()
    });
    let link: Arc<BridgeLink> = {
        #[cfg(target_os = "macos")]
        {
            assert!(
                EngineConfig::wants_vm(&dir),
                "engine.json must select the embedded VM"
            );
            // the embedded engine, exactly as the app starts it (the app has already provisioned the image)
            let helper = nexus_desktop_lib::engine_vm::VmTransport::locate_helper()
                .expect("set NEXUS_VM_HELPER to the rebuilt app's nexus-vm");
            let vm = Arc::new(nexus_desktop_lib::engine_vm::VmTransport::new(
                helper, None, None, &dir,
            ));
            BridgeLink::start(Box::new(vm), dialogs.clone(), env!("CARGO_PKG_VERSION"))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let t = EngineConfig::load(&dir, &home)
                .unwrap()
                .expect("engine.json");
            BridgeLink::start(Box::new(t), dialogs.clone(), env!("CARGO_PKG_VERSION"))
        }
    };
    until("engine ready", 90, || {
        link.status().is_ready().then_some(())
    });
    let rs = until("guest runtime ready", 180, || {
        let v = link.call("runtime_state", json!({})).ok()?;
        (v["phase"] == "ready").then_some(v)
    });
    println!(
        "runtime_state: phase={} providerConnected={}",
        rs["phase"], rs["providerConnected"]
    );
    (link, dialogs, home)
}

/// The engine's own record of a run: its verdict and every tool call it recorded.
fn record_of(link: &BridgeLink, run: &str) -> (Value, Vec<Value>) {
    let st = link.call("intent_status", json!({"runId": run})).unwrap();
    println!(
        "engine verdict: state={} completion={} verification={}",
        st["state"], st["completion"], st["codingOutcome"]["verification"]
    );
    let page = link
        .call(
            "intent_activity",
            json!({"runId": run, "offset": 0, "limit": 200}),
        )
        .unwrap();
    let items = page["activity"].as_array().cloned().unwrap_or_default();
    println!(
        "--- {} recorded tool calls (the engine's own record):",
        items.len()
    );
    for a in &items {
        println!(
            "  #{:<3} {:<9} {:<9} exit={:<5} verification={:<9} code={:<22} class={:<22} {}",
            a["index"],
            a["tool"].as_str().unwrap_or(""),
            a["status"].as_str().unwrap_or(""),
            a["exitCode"],
            a["verification"].as_str().unwrap_or("-"),
            a["errorCode"].as_str().unwrap_or("-"),
            a["processClass"].as_str().unwrap_or("-"),
            a["argsSummary"].as_str().unwrap_or("")
        );
    }
    for a in items.iter().filter(|a| a["status"] == "refused") {
        println!("  refused record verbatim: {a}");
    }
    (st, items)
}

/// What the task asked for, checked against the engine's record (not against the model's words).
fn check_flow(st: &Value, items: &[Value]) {
    let find = |needle: &str| -> Vec<&Value> {
        items
            .iter()
            .filter(|a| {
                a["tool"] == "proc_run" && a["argsSummary"].as_str().unwrap_or("").contains(needle)
            })
            .collect()
    };
    // 1) the toolchain runs
    for v in ["cargo --version", "rustc --version"] {
        let hits = find(v);
        assert!(!hits.is_empty(), "the model never ran `{v}`");
        assert!(
            hits.iter()
                .any(|a| a["status"] == "executed" && a["exitCode"] == 0),
            "`{v}` did not execute with exit 0: {hits:?}"
        );
    }
    // 2) the broken crate fails to compile (real rustc), then compiles
    let checks = find("cargo check");
    assert!(
        checks
            .iter()
            .any(|a| a["status"] == "executed" && a["exitCode"] != 0 && a["exitCode"] != 127),
        "no failing `cargo check` was recorded: {checks:?}"
    );
    assert!(
        checks
            .iter()
            .any(|a| a["status"] == "executed" && a["exitCode"] == 0),
        "no passing `cargo check` was recorded"
    );
    // 3) the tests run and pass
    assert!(
        find("cargo test")
            .iter()
            .any(|a| a["status"] == "executed" && a["exitCode"] == 0),
        "no passing `cargo test`"
    );
    // 4) a missing program is reported as not installed, a policy denial as a refusal (when the model ran them)
    for a in find("nexus-no-such-tool-m44") {
        assert_eq!(a["errorCode"], "executable-not-found", "{a}");
        assert_eq!(a["status"], "refused", "{a}");
    }
    for a in find("/usr/bin/true") {
        assert_eq!(a["errorCode"], "command-refused", "{a}");
    }
    assert_eq!(st["codingOutcome"]["verification"], "verified-passed");
}

#[test]
#[ignore]
fn a_rust_crate_is_checked_fixed_and_tested_in_the_real_engine() {
    let name = "nexus-m44-rust-demo";
    let root = demo(name);
    let data = std::env::temp_dir().join(format!("nexus-m44-{name}"));
    let _ = std::fs::remove_dir_all(&data);

    let (link, dialogs, home) = start_link();
    assert!(
        link.call("runtime_state", json!({})).unwrap()["providerConnected"] == true,
        "no provider is connected in this engine: a live-model run is not possible"
    );
    let store = Arc::new(Store::open(&data).unwrap());
    let c = Coordinator::new(
        store,
        link.clone(),
        dialogs,
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    let v = c.open_project(root.to_str().unwrap()).unwrap();
    println!(
        "onboarded: label={} sync={}",
        v["project"]["label"], v["project"]["sync"]["state"]
    );
    let gid = c.store.list()[0].guest_id.clone().unwrap();

    let key = format!(
        "m44-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let sent = c
        .serve(
            "thread_send",
            json!({"threadId": null, "projectId": gid, "content": TASK, "mode": "auto", "workspace": "continue",
                "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null,
                "idempotencyKey": key, "engine": null}),
        )
        .unwrap();
    let run = sent["run"]["runId"].as_str().unwrap().to_owned();
    println!("task submitted: {run}");

    let mut last = String::new();
    let fin = until("run synchronized", 1500, || {
        c.tick();
        let s = serde_json::to_value(c.store.list()[0].run(&run).map(|x| x.sync.clone())).unwrap()
            ["state"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        if s != last {
            println!("  run {run}: sync -> {s}");
            last = s.clone();
        }
        matches!(
            s.as_str(),
            "applied" | "conflict" | "failed" | "not-applied"
        )
        .then_some(s)
    });
    println!("final sync state: {fin}");
    let (st, items) = record_of(&link, &run);
    let lib = r(&root, "src/lib.rs");
    println!("--- src/lib.rs on the Mac now:\n{lib}");
    // the Mac's own toolchain (if any) agrees
    if let Ok(o) = std::process::Command::new("cargo")
        .args(["test", "--offline", "-q"])
        .current_dir(&root)
        .env(
            "CARGO_TARGET_DIR",
            std::env::temp_dir().join("nexus-m44-mac-target"),
        )
        .output()
    {
        println!(
            "host `cargo test`: success={} {}",
            o.status.success(),
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| l.contains("test result"))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
    check_flow(&st, &items);
    assert_eq!(fin, "applied");
    assert!(lib.contains("as i64"), "the type mismatch is still there");
    // leave the person's engine as it was: forget the disposable project and remove the folder
    let _ = c.forget(&gid);
    let _ = std::fs::remove_dir_all(&root);
    link.shutdown();
}

/// Read-only: re-check a finished run against the engine's record (`NEXUS_M44_RUN=run_...`).
#[test]
#[ignore]
fn inspect_a_finished_run() {
    let run = std::env::var("NEXUS_M44_RUN").expect("NEXUS_M44_RUN");
    let (link, _dialogs, _home) = start_link();
    let (st, items) = record_of(&link, &run);
    check_flow(&st, &items);
    link.shutdown();
}

const POLICY_TASK: &str = "This is a deliberate test of the command policy; do not change any files. \
1) Run the program `sh` with the single argument `-i` once (an interactive shell; it is expected to be refused) and tell me exactly what the system said. \
2) Then run `sh` with `-c` and the script `echo policy-test-done` and tell me its output.";

/// A genuine policy denial (an interactive shell) must come back as `command-refused`, distinguishable from
/// a program that is not installed (`executable-not-found`) and from a command that ran and failed. Also
/// removes the disposable project of `a_rust_crate_...` from the person's engine and disk.
#[test]
#[ignore]
fn a_policy_denial_is_distinguishable_in_the_real_engine_and_the_demos_are_removed() {
    let name = "nexus-m44-policy-demo";
    let root = demo(name);
    let data = std::env::temp_dir().join(format!("nexus-m44-{name}"));
    let _ = std::fs::remove_dir_all(&data);
    let (link, dialogs, home) = start_link();
    assert!(
        link.call("runtime_state", json!({})).unwrap()["providerConnected"] == true,
        "no provider is connected in this engine"
    );
    let c = Coordinator::new(
        Arc::new(Store::open(&data).unwrap()),
        link.clone(),
        dialogs.clone(),
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    c.open_project(root.to_str().unwrap()).unwrap();
    let gid = c.store.list()[0].guest_id.clone().unwrap();
    let sent = c
        .serve(
            "thread_send",
            json!({"threadId": null, "projectId": gid, "content": POLICY_TASK, "mode": "auto", "workspace": "continue",
                "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null,
                "idempotencyKey": format!("m44p-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()), "engine": null}),
        )
        .unwrap();
    let run = sent["run"]["runId"].as_str().unwrap().to_owned();
    println!("task submitted: {run}");
    let fin = until("run synchronized", 900, || {
        c.tick();
        let s = serde_json::to_value(c.store.list()[0].run(&run).map(|x| x.sync.clone())).unwrap()
            ["state"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        matches!(
            s.as_str(),
            "applied" | "conflict" | "failed" | "not-applied"
        )
        .then_some(s)
    });
    println!("final sync state: {fin}");
    let (st, items) = record_of(&link, &run);
    let procs: Vec<&Value> = items.iter().filter(|a| a["tool"] == "proc_run").collect();
    let refused: Vec<&&Value> = procs
        .iter()
        .filter(|a| a["argsSummary"].as_str().unwrap_or("").contains("sh -i"))
        .collect();
    assert!(!refused.is_empty(), "the model never ran `sh -i`");
    for a in &refused {
        assert_eq!(a["status"], "refused", "{a}");
        assert_eq!(a["errorCode"], "command-refused", "{a}");
    }
    assert!(
        procs.iter().any(|a| a["status"] == "executed"
            && a["exitCode"] == 0
            && a["argsSummary"]
                .as_str()
                .unwrap_or("")
                .contains("policy-test-done")),
        "the permitted `sh -c` command did not run: {procs:?}"
    );
    println!("policy denial recorded as: {}", refused[0]["errorCode"]);
    let _ = st;

    // remove both disposable projects from the person's engine and disk
    let _ = c.forget(&gid);
    let _ = std::fs::remove_dir_all(&root);
    let first = std::env::temp_dir().join("nexus-m44-nexus-m44-rust-demo");
    if first.exists() {
        let c1 = Coordinator::new(
            Arc::new(Store::open(&first).unwrap()),
            link.clone(),
            dialogs,
            Some(std::fs::canonicalize(&home).unwrap()),
        );
        if let Some(g) = c1.store.list().first().and_then(|p| p.guest_id.clone()) {
            let _ = c1.forget(&g);
        }
        let _ = std::fs::remove_dir_all(&first);
        let _ = std::fs::remove_dir_all(home.join("Projects/nexus-m44-rust-demo"));
    }
    link.shutdown();
}
