//! LIVE (M4.6): execution analytics against the real engine. Ignored by default; needs the app closed and the engine
//! image provisioned by a launch of the rebuilt Nexus.app (`NEXUS_VM_HELPER`). Writes the analytics documents it reads
//! to `$NEXUS_M46_OUT` (a directory) for the report.
//!
//!   NEXUS_M46_OUT=/tmp/m46 NEXUS_VM_HELPER=<Nexus.app>/Contents/MacOS/nexus-vm \
//!     cargo test --test live_m46 -- --ignored --nocapture --test-threads=1 <test>

use nexus_desktop_lib::bridge_link::BridgeLink;
use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::engine::EngineLink;
use nexus_desktop_lib::engine_config::EngineConfig;
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::registry::*;
use serde_json::{json, Value};
use std::path::PathBuf;
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

fn link() -> Arc<BridgeLink> {
    let (dir, _) = app_dir();
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: true,
        ..Default::default()
    });
    assert!(EngineConfig::wants_vm(&dir));
    let helper =
        nexus_desktop_lib::engine_vm::VmTransport::locate_helper().expect("set NEXUS_VM_HELPER");
    let vm = Arc::new(nexus_desktop_lib::engine_vm::VmTransport::new(
        helper, None, None, &dir,
    ));
    let l = BridgeLink::start(Box::new(vm), d, env!("CARGO_PKG_VERSION"));
    until("engine ready", 240, || l.status().is_ready().then_some(()));
    until("runtime ready", 300, || {
        (l.call("runtime_state", json!({})).ok()?["phase"] == "ready").then_some(())
    });
    l
}

fn out(name: &str, v: &Value) {
    if let Ok(d) = std::env::var("NEXUS_M46_OUT") {
        let _ = std::fs::create_dir_all(&d);
        let _ = std::fs::write(
            PathBuf::from(d).join(name),
            serde_json::to_vec_pretty(v).unwrap(),
        );
    }
}

fn host(l: &BridgeLink, run: &str) -> Value {
    l.call(
        "run_analytics_export",
        json!({"runId": run, "hostPlatform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH), "appVersion": env!("CARGO_PKG_VERSION")}),
    )
    .unwrap()
}

/// Read-only: the analytics of a run that already exists in the person's engine (`NEXUS_M46_RUN`), with the run record
/// beside it so every figure can be checked against what was persisted at the time.
#[test]
#[ignore]
fn analytics_of_an_existing_run() {
    let run = std::env::var("NEXUS_M46_RUN").expect("NEXUS_M46_RUN");
    let l = link();
    let rec = l.call("intent_status", json!({"runId": run})).unwrap();
    let doc = host(&l, &run);
    out(&format!("{run}.analytics.json"), &doc);
    out(&format!("{run}.runrecord.json"), &rec);
    println!("runRecord: state={} completion={} usageIn={} usageOut={} latency={} firstToken={} created={} updated={}",
        rec["state"], rec["completion"], rec["usageInputTokens"], rec["usageOutputTokens"], rec["latencyMs"], rec["firstTokenMs"], rec["createdAtMs"], rec["updatedAtMs"]);
    println!("source={}", doc["source"]);
    println!(
        "runtime={}",
        serde_json::to_string(&doc["runtime"]).unwrap()
    );
    println!(
        "tokens={}",
        serde_json::to_string(&doc["tokens"])
            .unwrap()
            .chars()
            .take(900)
            .collect::<String>()
    );
    println!(
        "tools={}",
        serde_json::to_string(&doc["tools"])
            .unwrap()
            .chars()
            .take(700)
            .collect::<String>()
    );
    println!(
        "verification={}",
        serde_json::to_string(&doc["verification"])
            .unwrap()
            .chars()
            .take(500)
            .collect::<String>()
    );
    println!("cost={}", doc["cost"]);
    println!("missing={}", doc["missing"]);
    l.shutdown();
}

/// A new short real-model task; then its analytics are read back and compared with the run record.
#[test]
#[ignore]
fn a_short_live_task_is_captured_accurately() {
    let (_, home) = app_dir();
    let root = home.join("Projects/nexus-m46-demo");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("README.md"), "# demo\n").unwrap();
    std::fs::write(
        root.join("src/add.js"),
        "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n",
    )
    .unwrap();
    std::fs::write(root.join("src/add.test.js"), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./add');\ntest('adds', () => { assert.strictEqual(add(2, 3), 5); });\n").unwrap();
    let root = std::fs::canonicalize(&root).unwrap();
    let data = std::env::temp_dir().join("nexus-m46-demo");
    let _ = std::fs::remove_dir_all(&data);
    let l = link();
    let yes: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: true,
        ..Default::default()
    });
    let onboard = Coordinator::new(
        Arc::new(Store::open(&data).unwrap()),
        l.clone(),
        yes.clone(),
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    onboard.open_project(root.to_str().unwrap()).unwrap();
    let c = Coordinator::new(
        Arc::new(Store::open(&data).unwrap()),
        l.clone(),
        yes,
        Some(std::fs::canonicalize(&home).unwrap()),
    );
    let gid = c.store.list()[0].guest_id.clone().unwrap();
    let key = format!(
        "m46-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let r = c
        .serve("thread_send", json!({"threadId": null, "projectId": gid,
            "content": "src/add.js has a bug: add returns a - b. Fix it, then run `node --test src/` and tell me the result.",
            "mode": "auto", "workspace": "continue", "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null,
            "idempotencyKey": key, "engine": null, "permissionMode": "auto-safe"}))
        .unwrap();
    let run = r["run"]["runId"].as_str().unwrap().to_owned();
    println!("task submitted: {run}");
    let rec = until("run end", 900, || {
        c.tick();
        let st = l.call("intent_status", json!({"runId": run})).ok()?;
        (st["terminal"] == true).then_some(st)
    });
    let doc = host(&l, &run);
    out("short-task.analytics.json", &doc);
    out("short-task.runrecord.json", &rec);
    println!(
        "runRecord: state={} completion={} usageIn={} usageOut={} created={} updated={}",
        rec["state"],
        rec["completion"],
        rec["usageInputTokens"],
        rec["usageOutputTokens"],
        rec["createdAtMs"],
        rec["updatedAtMs"]
    );
    println!("source={}", doc["source"]);
    println!(
        "runtime={}",
        serde_json::to_string(&doc["runtime"]).unwrap()
    );
    println!(
        "tokens={}",
        serde_json::to_string(&doc["tokens"])
            .unwrap()
            .chars()
            .take(1200)
            .collect::<String>()
    );
    println!(
        "routing={}",
        serde_json::to_string(&doc["routing"])
            .unwrap()
            .chars()
            .take(900)
            .collect::<String>()
    );
    println!(
        "tools={}",
        serde_json::to_string(&doc["tools"])
            .unwrap()
            .chars()
            .take(900)
            .collect::<String>()
    );
    println!(
        "verification={}",
        serde_json::to_string(&doc["verification"])
            .unwrap()
            .chars()
            .take(500)
            .collect::<String>()
    );
    println!("cost={}  missing={}", doc["cost"], doc["missing"]);
    // checks against the run record (the existing source of truth)
    assert_eq!(doc["source"]["perRequestRecord"], true);
    assert_eq!(doc["tokens"]["source"], "per-request");
    assert_eq!(
        doc["tokens"]["input"], rec["usageInputTokens"],
        "per-request input equals the run record's cumulative input"
    );
    assert_eq!(doc["tokens"]["output"], rec["usageOutputTokens"]);
    assert_eq!(doc["tokens"]["reconciliation"]["matches"], true);
    assert!(doc["runtime"]["requests"]["count"].as_u64().unwrap() >= 2);
    let wall = doc["runtime"]["wallMs"].as_u64().unwrap();
    let cats = &doc["runtime"]["categoriesExclusive"];
    let sum: u64 = [
        "modelRequestMs",
        "toolExecutionMs",
        "approvalWaitMs",
        "controllerMs",
    ]
    .iter()
    .map(|k| cats[k].as_u64().unwrap())
    .sum();
    assert!(
        sum >= wall.saturating_sub(1) && sum <= wall + cats["modelRequestMs"].as_u64().unwrap(),
        "categories {sum} vs wall {wall}"
    );
    assert!(doc["verification"]["cycles"].as_u64().unwrap() >= 1);
    let _ = c.forget(&gid);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&data);
    l.shutdown();
}
