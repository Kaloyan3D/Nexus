//! M4.6: the Mac side of the benchmark export: it adds its own platform and version, and saving writes only into
//! Downloads under a name made from the validated run id.

use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::dto::UiError;
use nexus_desktop_lib::engine::{EngineLink, EngineStatus};
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::registry::Store;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct Engine {
    calls: Mutex<Vec<(String, Value)>>,
}

impl EngineLink for Engine {
    fn status(&self) -> EngineStatus {
        EngineStatus::Ready
    }
    fn call(&self, cmd: &str, args: Value) -> Result<Value, UiError> {
        self.calls
            .lock()
            .unwrap()
            .push((cmd.to_owned(), args.clone()));
        Ok(
            json!({"schema": "nexus.run-analytics", "schemaVersion": 1, "runId": args["runId"], "identity": {"host": {"hostPlatform": args["hostPlatform"], "appVersion": args["appVersion"]}}}),
        )
    }
}

fn rig() -> (
    Arc<Coordinator>,
    Arc<Engine>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let eng = Arc::new(Engine {
        calls: Mutex::new(vec![]),
    });
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs::default());
    let c = Coordinator::new(
        Arc::new(Store::open(data.path()).unwrap()),
        eng.clone(),
        d,
        Some(home.path().to_path_buf()),
    );
    (c, eng, data, home)
}

#[test]
fn the_export_carries_the_macs_own_platform_and_app_version() {
    let (c, e, _d, _h) = rig();
    let doc = c
        .serve(
            "run_analytics_export",
            json!({"runId": "run_abc", "hostPlatform": "attacker-claimed", "appVersion": "9.9"}),
        )
        .unwrap();
    let sent = e.calls.lock().unwrap()[0].1.clone();
    assert_eq!(
        sent["hostPlatform"],
        format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "the app states its own platform, not the renderer's"
    );
    assert_eq!(sent["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(doc["schema"], "nexus.run-analytics");
}

#[test]
fn saving_writes_into_downloads_under_a_name_made_from_the_run_id() {
    let (c, _e, _d, h) = rig();
    let r = c
        .serve("run_analytics_save", json!({"runId": "run_0123abcd"}))
        .unwrap();
    let path = std::path::PathBuf::from(r["path"].as_str().unwrap());
    assert_eq!(
        path,
        h.path()
            .join("Downloads/nexus-run-analytics-run_0123abcd.json")
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["runId"], "run_0123abcd");
    assert_eq!(saved["schemaVersion"], 1);
}

#[test]
fn a_run_id_that_could_name_another_path_is_refused_and_nothing_is_written() {
    let (c, e, _d, h) = rig();
    for bad in [
        "../../etc/x",
        "run/../x",
        "",
        "run id",
        "a".repeat(65).as_str(),
    ] {
        let err = c
            .serve("run_analytics_save", json!({"runId": bad}))
            .unwrap_err();
        assert_eq!(err.code, "bad-usage", "{bad}");
    }
    assert!(
        e.calls.lock().unwrap().is_empty(),
        "the engine was never asked"
    );
    assert!(!h.path().join("Downloads").exists());
}
