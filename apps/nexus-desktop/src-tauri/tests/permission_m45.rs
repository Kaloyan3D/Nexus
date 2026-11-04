//! M4.5: the permission decisions made on the Mac. Every decision that widens what happens without the person
//! is a native confirmation built from the ENGINE's record; the renderer cannot supply the text, the digest or
//! the approval.

use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::dto::UiError;
use nexus_desktop_lib::engine::{EngineLink, EngineStatus};
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::registry::Store;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct Engine {
    calls: Mutex<Vec<(String, Value)>>,
    run: Mutex<Value>,
    offline_project: bool,
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
        Ok(match cmd {
            "intent_status" => json!({"run": self.run.lock().unwrap().clone()}),
            "permission_prepare_upgrade" => {
                json!({"text": "ENGINE UPGRADE TEXT", "token": "tok-1", "mode": args["mode"]})
            }
            "project_list" => {
                json!({"projects": [{"projectId": "gp", "grant": {"net": if self.offline_project {"offline"} else {"install"}}}]})
            }
            "thread_send" => json!({"run": {"runId": "run_x"}, "threadId": "thr_x"}),
            _ => json!({"ok": true}),
        })
    }
}

fn pending() -> Value {
    json!({
        "requestId": "pr-1", "kind": "dependency-install", "digest": "d1d1",
        "program": "cargo", "args": ["add", "clap@4", "rusqlite"], "cwd": "src",
        "plan": {"manager": "cargo", "verb": "add", "packages": [{"name": "clap", "constraint": "4"}, {"name": "rusqlite", "constraint": ""}], "options": ["--features bundled"], "fromManifest": false},
        "purpose": "cargo add clap@4 rusqlite", "mode": "ask"
    })
}

fn rig(
    confirm: bool,
    mode: &str,
    offline_project: bool,
) -> (
    Arc<Coordinator>,
    Arc<Engine>,
    ScriptedDialogs,
    tempfile::TempDir,
) {
    let d = tempfile::tempdir().unwrap();
    let eng = Arc::new(Engine {
        calls: Mutex::new(vec![]),
        run: Mutex::new(
            json!({"runId": "run_1", "permissionMode": mode, "pendingPermission": pending()}),
        ),
        offline_project,
    });
    let dialogs = ScriptedDialogs {
        confirm,
        ..Default::default()
    };
    let dd: Arc<dyn Dialogs> = Arc::new(dialogs.clone());
    let c = Coordinator::new(
        Arc::new(Store::open(d.path()).unwrap()),
        eng.clone(),
        dd,
        None,
    );
    (c, eng, dialogs, d)
}

fn sent(e: &Engine, cmd: &str) -> Vec<Value> {
    e.calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(c, _)| c == cmd)
        .map(|(_, a)| a.clone())
        .collect()
}

#[test]
fn approving_shows_the_engines_own_description_and_binds_the_decision_to_the_engines_digest() {
    let (c, e, dlg, _d) = rig(true, "ask", false);
    c.serve(
        "permission_decide",
        json!({"runId": "run_1", "requestId": "pr-1", "decision": "approve", "digest": "d1d1"}),
    )
    .unwrap();
    let shown = dlg.shown.lock().unwrap().clone();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].0, "Install dependencies?");
    for want in [
        "Package manager: cargo",
        "clap (4), rusqlite",
        "--features bundled",
        "Workspace: src",
        "cargo add clap@4 rusqlite",
        "does not allow any other installation",
    ] {
        assert!(
            shown[0].1.contains(want),
            "missing {want:?} in:\n{}",
            shown[0].1
        );
    }
    let d = sent(&e, "permission_decide");
    assert_eq!(d.len(), 1);
    assert_eq!(
        (d[0]["decision"].as_str(), d[0]["digest"].as_str()),
        (Some("approve"), Some("d1d1"))
    );
}

#[test]
fn a_renderer_cannot_approve_with_a_different_digest_or_for_a_request_that_is_gone() {
    let (c, e, dlg, _d) = rig(true, "ask", false);
    let bad = c.serve("permission_decide", json!({"runId": "run_1", "requestId": "pr-1", "decision": "approve", "digest": "other"})).unwrap_err();
    assert_eq!(bad.code, "permission-mismatch");
    let gone = c.serve("permission_decide", json!({"runId": "run_1", "requestId": "pr-OLD", "decision": "approve", "digest": "d1d1"})).unwrap_err();
    assert_eq!(gone.code, "permission-gone");
    assert!(
        dlg.shown.lock().unwrap().is_empty(),
        "no dialog for a request that does not match"
    );
    assert!(
        sent(&e, "permission_decide").is_empty(),
        "nothing reached the engine"
    );
}

#[test]
fn a_no_in_the_native_dialog_is_a_denial_and_deny_needs_no_dialog() {
    let (c, e, dlg, _d) = rig(false, "ask", false);
    c.serve(
        "permission_decide",
        json!({"runId": "run_1", "requestId": "pr-1", "decision": "approve", "digest": "d1d1"}),
    )
    .unwrap();
    assert_eq!(sent(&e, "permission_decide")[0]["decision"], "deny");
    assert_eq!(dlg.shown.lock().unwrap().len(), 1);
    let (c, e, dlg, _d) = rig(true, "ask", false);
    c.serve(
        "permission_decide",
        json!({"runId": "run_1", "requestId": "pr-1", "decision": "deny"}),
    )
    .unwrap();
    assert_eq!(sent(&e, "permission_decide")[0]["decision"], "deny");
    assert!(dlg.shown.lock().unwrap().is_empty());
}

#[test]
fn an_upgrade_needs_the_native_confirmation_with_the_engines_text_and_a_downgrade_does_not() {
    let (c, e, dlg, _d) = rig(false, "ask", false);
    let err = c
        .serve(
            "permission_set_mode",
            json!({"runId": "run_1", "mode": "full"}),
        )
        .unwrap_err();
    assert_eq!(err.code, "permission-declined");
    assert!(
        sent(&e, "permission_set_mode").is_empty(),
        "declined: the mode never changed"
    );
    assert_eq!(dlg.shown.lock().unwrap()[0].1, "ENGINE UPGRADE TEXT");

    let (c, e, dlg, _d) = rig(true, "ask", false);
    c.serve(
        "permission_set_mode",
        json!({"runId": "run_1", "mode": "full"}),
    )
    .unwrap();
    let s = sent(&e, "permission_set_mode");
    assert_eq!(
        (s[0]["mode"].as_str(), s[0]["upgradeToken"].as_str()),
        (Some("full"), Some("tok-1"))
    );
    assert_eq!(dlg.shown.lock().unwrap().len(), 1);

    let (c, e, dlg, _d) = rig(false, "full", false);
    c.serve(
        "permission_set_mode",
        json!({"runId": "run_1", "mode": "ask"}),
    )
    .unwrap();
    assert!(
        dlg.shown.lock().unwrap().is_empty(),
        "a downgrade is immediate and silent"
    );
    assert!(sent(&e, "permission_set_mode")[0]["upgradeToken"].is_null());
    assert!(c
        .serve(
            "permission_set_mode",
            json!({"runId": "run_1", "mode": "yolo"})
        )
        .is_err());
}

#[test]
fn starting_in_full_access_shows_the_one_time_confirmation_and_declining_starts_nothing() {
    let (c, e, dlg, _d) = rig(false, "ask", false);
    let err = c
        .serve(
            "thread_send",
            json!({"projectId": "gp", "content": "go", "permissionMode": "full"}),
        )
        .unwrap_err();
    assert_eq!(err.code, "permission-declined");
    assert!(sent(&e, "thread_send").is_empty());
    assert!(dlg.shown.lock().unwrap()[0]
        .1
        .contains("WITHOUT asking you again"));

    let (c, e, dlg, _d) = rig(true, "ask", false);
    c.serve(
        "thread_send",
        json!({"projectId": "gp", "content": "go", "permissionMode": "full"}),
    )
    .unwrap();
    assert_eq!(sent(&e, "thread_send").len(), 1);
    assert_eq!(dlg.shown.lock().unwrap().len(), 1);

    // the other two modes never show the Full Access confirmation
    let (c, e, dlg, _d) = rig(true, "ask", false);
    for m in ["ask", "auto-safe"] {
        c.serve(
            "thread_send",
            json!({"projectId": "gp", "content": "go", "permissionMode": m}),
        )
        .unwrap();
    }
    assert!(dlg.shown.lock().unwrap().is_empty());
    assert_eq!(sent(&e, "thread_send").len(), 2);
    assert!(c
        .serve(
            "thread_send",
            json!({"projectId": "gp", "content": "go", "permissionMode": "root"})
        )
        .is_err());
}

#[test]
fn a_project_without_the_install_network_is_offered_the_standing_install_permission_first() {
    let (c, e, _dlg, _d) = rig(true, "ask", true);
    c.serve(
        "thread_send",
        json!({"projectId": "gp", "content": "go", "permissionMode": "ask"}),
    )
    .unwrap();
    assert_eq!(
        sent(&e, "project_allow_installs").len(),
        1,
        "{:?}",
        e.calls.lock().unwrap()
    );
    let (c, e, _dlg, _d) = rig(true, "ask", false);
    c.serve(
        "thread_send",
        json!({"projectId": "gp", "content": "go", "permissionMode": "ask"}),
    )
    .unwrap();
    assert!(sent(&e, "project_allow_installs").is_empty());
}

#[test]
fn the_desktop_defaults_to_ask_for_approval_when_no_mode_is_named() {
    let (c, e, dlg, _d) = rig(true, "ask", false);
    c.serve("thread_send", json!({"projectId": "gp", "content": "go"}))
        .unwrap();
    assert_eq!(sent(&e, "thread_send")[0]["permissionMode"], "ask");
    assert!(dlg.shown.lock().unwrap().is_empty());
}
