//! LIVE end-to-end check of the macOS transport against the real Fedora engine.
//!
//! Ignored by default: it needs the guest from `engine.json` to be up and its restricted key
//! installed. Run with `cargo test --test live_guest -- --ignored --nocapture`.
//! Native confirmations are scripted to DENY, so the run can never be granted anything here.

use nexus_desktop_lib::bridge_link::BridgeLink;
use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::engine::{EngineLink, EngineStatus};
use nexus_desktop_lib::engine_config::EngineConfig;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn link() -> Arc<BridgeLink> {
    let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
    let dir = home.join("Library/Application Support/ai.arthurlabs.nexus.desktop");
    let t = EngineConfig::load(&dir, &home)
        .unwrap()
        .expect("engine.json");
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm: false,
        ..Default::default()
    });
    BridgeLink::start(Box::new(t), d, env!("CARGO_PKG_VERSION"))
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

#[test]
#[ignore]
fn read_path_against_real_engine() {
    let l = link();
    until("ready", 40, || l.status().is_ready().then_some(()));
    let rs = until("guest runtime ready", 60, || {
        let v = l.call("runtime_state", json!({})).ok()?;
        (v["phase"] == "ready").then_some(v)
    });
    println!(
        "runtime_state: phase={} provider={} consent={}",
        rs["phase"], rs["providerConnected"], rs["consent"]["given"]
    );
    let pl = l
        .call("project_list", json!({"withChanges": false}))
        .unwrap();
    let projects = pl["projects"].as_array().unwrap();
    println!(
        "projects: {:?}",
        projects
            .iter()
            .map(|p| p["label"].clone())
            .collect::<Vec<_>>()
    );
    assert!(!projects.is_empty());
    let tl = l
        .call(
            "thread_list",
            json!({"projectId": null, "includeArchived": false}),
        )
        .unwrap();
    println!("threads: {}", tl["threads"].as_array().unwrap().len());
    let targets = l.call("intent_targets", json!({})).unwrap();
    println!(
        "model routes: {}",
        targets.as_array().map_or(0, |a| a.len())
    );
    // the host-local / simulated commands are refused by the guest bridge itself
    let e = l.call("run_mock", json!({})).unwrap_err();
    assert_eq!(e.code, "engine-unsupported");
    let e = l.call("definitely_not_a_command", json!({})).unwrap_err();
    println!("unknown command -> {}: {}", e.code, e.message);
    l.shutdown();
}

#[test]
#[ignore]
fn real_task_from_the_mac_transport() {
    let l = link();
    until("ready", 40, || l.status().is_ready().then_some(()));
    until("guest runtime ready", 90, || {
        let v = l.call("runtime_state", json!({})).ok()?;
        (v["phase"] == "ready").then_some(())
    });
    let projects = l
        .call("project_list", json!({"withChanges": false}))
        .unwrap();
    let pid = projects["projects"][0]["projectId"]
        .as_str()
        .unwrap()
        .to_owned();
    // a fresh key per run; set NEXUS_LIVE_RUN to inspect an existing run instead of submitting
    let key = format!(
        "m2-live-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    );
    let sent = l
        .call(
            "thread_send",
            json!({
                "threadId": null, "projectId": pid,
                "content": "Add a short 'Usage' section at the end of README.md explaining how to open index.html in a browser, then run `node --check app.js` to confirm app.js still parses, and report the result.",
                "mode": "auto", "workspace": "continue",
                "providerId": null, "remoteModelId": null, "logicalModelId": null, "routeId": null,
                "idempotencyKey": key, "engine": null
            }),
        )
        .unwrap();
    let run_id = sent["run"]["runId"].as_str().unwrap().to_owned();
    let thread_id = sent["threadId"].as_str().unwrap().to_owned();
    println!(
        "submitted thread={thread_id} run={run_id} state={}",
        sent["run"]["state"]
    );
    // idempotent replay: same key must not create a second run
    let again = l
        .call("thread_send", json!({
            "threadId": null, "projectId": pid, "content": "Add a short 'Usage' section at the end of README.md explaining how to open index.html in a browser, then run `node --check app.js` to confirm app.js still parses, and report the result.",
            "mode": "auto", "workspace": "continue", "providerId": null, "remoteModelId": null, "logicalModelId": null,
            "routeId": null, "idempotencyKey": key, "engine": null }))
        .unwrap();
    println!(
        "replay={} same-run={}",
        again["replay"],
        again["run"]["runId"] == sent["run"]["runId"]
    );
    let mut last = String::new();
    let run: Value = until("run terminal", 900, || {
        let r = l.call("intent_status", json!({"runId": run_id})).ok()?;
        let s = r["state"].as_str().unwrap_or("").to_owned();
        if s != last {
            println!("  state -> {s}");
            last = s;
        }
        r["terminal"].as_bool().unwrap_or(false).then_some(r)
    });
    println!(
        "terminal: state={} finish={} in={} out={}",
        run["state"], run["finishReason"], run["usageInputTokens"], run["usageOutputTokens"]
    );
    let act = l
        .call(
            "intent_activity",
            json!({"runId": run_id, "offset": 0, "limit": 50}),
        )
        .ok();
    if let Some(a) = act {
        println!(
            "activity: {}",
            serde_json::to_string(&a)
                .unwrap()
                .chars()
                .take(1500)
                .collect::<String>()
        );
    }
    let ti = run["taskInstanceId"].as_str().map(str::to_owned);
    if let Some(ti) = ti {
        if let Ok(ev) = l.call("tool_events", json!({"taskInstanceId": ti})) {
            println!(
                "tool events: {}",
                serde_json::to_string(&ev)
                    .unwrap()
                    .chars()
                    .take(2500)
                    .collect::<String>()
            );
        }
    }
    let d = l
        .call(
            "thread_get",
            json!({"threadId": thread_id, "afterSeq": null}),
        )
        .unwrap();
    println!(
        "thread messages: {}",
        d["messages"].as_array().map_or(0, |m| m.len())
    );
    println!(
        "thread detail: {}",
        serde_json::to_string(&d)
            .unwrap()
            .chars()
            .take(3000)
            .collect::<String>()
    );
    assert!(matches!(
        l.status(),
        EngineStatus::Ready | EngineStatus::Busy { .. }
    ));
    l.shutdown();
}
