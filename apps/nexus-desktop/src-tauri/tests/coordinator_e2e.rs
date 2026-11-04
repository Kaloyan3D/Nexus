//! The coordinator against a fake engine whose project transfer is the real guest store: onboarding,
//! preflight refresh, run follow-up, verified writeback, conflicts, restart recovery.

use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::dto::UiError;
use nexus_desktop_lib::engine::{EngineLink, EngineStatus};
use nexus_desktop_lib::sync::coordinator::Coordinator;
use nexus_desktop_lib::sync::guest::GuestStore;
use nexus_desktop_lib::sync::registry::*;
use nexus_desktop_lib::sync::wire::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct Fake {
    guest: GuestStore,
    ready: Mutex<bool>,
    runs: Mutex<HashMap<String, Value>>,
    sent: Mutex<Vec<Value>>,
    next: Mutex<u32>,
    /// the engine-side execution grant (set by `project_allow_work`)
    granted: Mutex<bool>,
}

impl EngineLink for Fake {
    fn status(&self) -> EngineStatus {
        if *self.ready.lock().unwrap() {
            EngineStatus::Ready
        } else {
            EngineStatus::Disconnected {
                detail: "test".into(),
            }
        }
    }
    fn sync(&self, req: SyncReq) -> Result<Value, UiError> {
        if !*self.ready.lock().unwrap() {
            return Err(self.status().unavailable_error());
        }
        let commit = matches!(req, SyncReq::StageCommit { .. });
        let mut v = self.guest.handle(req).map_err(|e| UiError {
            code: e.code,
            message: e.message,
        })?;
        if commit {
            v["guestProjectId"] = json!("guest-proj");
        }
        Ok(v)
    }
    fn call(&self, cmd: &str, args: Value) -> Result<Value, UiError> {
        if !*self.ready.lock().unwrap() {
            return Err(self.status().unavailable_error());
        }
        match cmd {
            "project_list" => {
                let mut p =
                    json!({"projectId": "guest-proj", "label": "work", "workspaceMode": "direct"});
                if *self.granted.lock().unwrap() {
                    p["grant"] = json!({"status": "active", "fs": "workspace", "net": "offline", "approval": "auto", "devPorts": []});
                }
                Ok(
                    json!({"projects": [p], "permissions": {"known": true, "inPlaceAvailable": true}}),
                )
            }
            "project_allow_work" => {
                *self.granted.lock().unwrap() = true;
                Ok(json!({"project": {"projectId": args["projectId"]}}))
            }
            "thread_send" => {
                self.sent.lock().unwrap().push(args);
                let mut n = self.next.lock().unwrap();
                *n += 1;
                let id = format!("run_{n}");
                self.runs.lock().unwrap().insert(
                    id.clone(),
                    json!({"runId": id, "terminal": false, "state": "executing"}),
                );
                Ok(
                    json!({"threadId": "thr_1", "replay": false, "run": {"runId": id, "terminal": false}}),
                )
            }
            "intent_status" => Ok(self
                .runs
                .lock()
                .unwrap()
                .get(args["runId"].as_str().unwrap())
                .cloned()
                .unwrap()),
            "project_forget" => Ok(json!({"forgotten": "guest-proj"})),
            _ => Ok(json!({"cmd": cmd})),
        }
    }
}

struct T {
    shown: Arc<Mutex<Vec<(String, String)>>>,
    _d: tempfile::TempDir,
    root: PathBuf,
    gwork: PathBuf,
    fake: Arc<Fake>,
    c: Arc<Coordinator>,
}

fn w(root: &Path, rel: &str, c: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, c).unwrap();
}
fn r(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|_| "<absent>".into())
}

fn setup(consent: bool) -> T {
    let d = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(d.path()).unwrap().join("home");
    let root = home.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    w(&root, "app.js", "console.log(1)\n");
    w(&root, "README.md", "# p\n");
    let store = Arc::new(Store::open(&home.parent().unwrap().join("data")).unwrap());
    let fake = Arc::new(Fake {
        guest: GuestStore::new(d.path().join("guest")),
        ready: Mutex::new(true),
        runs: Mutex::new(HashMap::new()),
        sent: Mutex::new(vec![]),
        next: Mutex::new(0),
        granted: Mutex::new(false),
    });
    let sd = ScriptedDialogs {
        confirm: consent,
        ..Default::default()
    };
    let shown = sd.shown.clone();
    let dialogs: Arc<dyn Dialogs> = Arc::new(sd);
    let c = Coordinator::new(store, fake.clone(), dialogs, Some(home));
    T {
        shown,
        gwork: PathBuf::new(),
        _d: d,
        root: std::fs::canonicalize(&root).unwrap(),
        fake,
        c,
    }
}

impl T {
    fn _dialogs_shown(&self) -> Vec<(String, String)> {
        self.shown.lock().unwrap().clone()
    }
}

fn pick(t: &mut T) -> Value {
    let v = t.c.open_project(t.root.to_str().unwrap()).unwrap();
    let pid = t.c.store.list()[0].id.clone();
    t.gwork =
        t._d.path()
            .join("guest")
            .join(pid)
            .join("work")
            .join("proj");
    v
}

fn finish(t: &T, run: &str, verification: &str) {
    t.fake.runs.lock().unwrap().insert(
        run.into(),
        json!({"runId": run, "terminal": true, "state": "completed", "cancelRequested": false, "errorCode": null, "completion": "fulfilled",
               "codingOutcome": {"verification": verification, "checksFailedUnresolved": 0, "uncertainOperations": 0, "staleAfterEdit": false}}),
    );
}

fn send(t: &T) -> Result<Value, UiError> {
    t.c.serve("thread_send", json!({"threadId": null, "projectId": "guest-proj", "content": "do it", "mode": "auto", "workspace": "continue", "idempotencyKey": "k"}))
}

#[test]
fn onboarding_needs_consent_and_shows_the_mac_path() {
    let t = setup(false);
    let e = t.c.open_project(t.root.to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, "cancelled");
    assert!(
        t.c.store.list().is_empty(),
        "nothing is registered without consent"
    );
    assert!(
        !t._d.path().join("guest").exists()
            || std::fs::read_dir(t._d.path().join("guest"))
                .map(|d| d.count())
                .unwrap_or(0)
                == 0
    );

    let mut t = setup(true);
    let v = pick(&mut t);
    assert_eq!(v["created"], true);
    assert_eq!(v["project"]["macPath"], t.root.to_str().unwrap());
    assert_eq!(
        v["project"]["workspaceMode"], "direct",
        "what the engine reports about its own working copy is passed through, not rewritten"
    );
    assert_eq!(v["project"]["sync"]["state"], "synced");
    assert!(
        v["project"].get("grant").is_none(),
        "no engine grant exists yet, and none is invented"
    );
    assert_eq!(r(&t.gwork, "app.js"), "console.log(1)\n");
    // choosing it again is a refresh, not a second project
    let again = t.c.open_project(t.root.to_str().unwrap()).unwrap();
    assert_eq!(again["created"], false);
    assert_eq!(t.c.store.list().len(), 1);
}

#[test]
fn a_verified_task_updates_the_mac_folder_automatically() {
    let mut t = setup(true);
    pick(&mut t);
    // person edits on the Mac between runs: the engine copy is refreshed by the preflight
    w(&t.root, "app.js", "console.log(2)\n");
    let reply = send(&t).unwrap();
    assert_eq!(r(&t.gwork, "app.js"), "console.log(2)\n");
    assert_eq!(reply["run"]["hostSync"]["state"], "running");
    assert!(reply["run"]["hostSync"]["label"]
        .as_str()
        .unwrap()
        .contains("working"));
    // while it runs, a second task is refused instead of re-staging over it
    assert_eq!(send(&t).unwrap_err().code, "sync-run-active");
    // the engine edits its working copy and the run ends verified
    w(&t.gwork, "app.js", "console.log(3)\n");
    w(&t.gwork, "lib/util.js", "exports.x=1\n");
    t.c.tick(); // still running: nothing happens
    assert_eq!(r(&t.root, "app.js"), "console.log(2)\n");
    finish(&t, "run_1", "verified-passed");
    t.c.tick();
    assert_eq!(r(&t.root, "app.js"), "console.log(3)\n");
    assert_eq!(r(&t.root, "lib/util.js"), "exports.x=1\n");
    let list = t.c.serve("project_list", json!({})).unwrap();
    assert_eq!(list["projects"][0]["sync"]["state"], "synced");
    let st =
        t.c.serve("intent_status", json!({"runId": "run_1"}))
            .unwrap();
    assert_eq!(st["hostSync"]["state"], "applied");
    assert_eq!(st["hostSync"]["changed"].as_array().unwrap().len(), 2);
    // duplicate ticks never write twice
    let m = std::fs::metadata(t.root.join("app.js"))
        .unwrap()
        .modified()
        .unwrap();
    t.c.tick();
    t.c.tick();
    assert_eq!(
        std::fs::metadata(t.root.join("app.js"))
            .unwrap()
            .modified()
            .unwrap(),
        m
    );
    // the next task starts from the updated Mac folder (nothing to restage, no unexported changes)
    assert!(send(&t).is_ok());
}

#[test]
fn cancelled_failed_and_unverified_runs_do_not_touch_the_mac_folder() {
    let mut t = setup(true);
    pick(&mut t);
    send(&t).unwrap();
    w(&t.gwork, "app.js", "BROKEN\n");
    finish(&t, "run_1", "verified-failed");
    t.c.tick();
    assert_eq!(r(&t.root, "app.js"), "console.log(1)\n");
    let st =
        t.c.serve("intent_status", json!({"runId": "run_1"}))
            .unwrap();
    assert_eq!(st["hostSync"]["state"], "not-applied");
    assert!(st["hostSync"]["label"]
        .as_str()
        .unwrap()
        .contains("Not applied"));
}

#[test]
fn a_host_edit_during_the_run_is_a_conflict_that_blocks_the_next_task() {
    let mut t = setup(true);
    pick(&mut t);
    send(&t).unwrap();
    w(&t.gwork, "app.js", "// nexus\n");
    w(&t.root, "app.js", "// person\n"); // edited in the Mac editor while Nexus works
    finish(&t, "run_1", "verified-passed");
    t.c.tick();
    assert_eq!(r(&t.root, "app.js"), "// person\n");
    let list = t.c.serve("project_list", json!({})).unwrap();
    assert_eq!(list["projects"][0]["sync"]["state"], "conflict");
    assert_eq!(
        list["projects"][0]["sync"]["conflicts"][0]["path"],
        "app.js"
    );
    let e = send(&t).unwrap_err();
    assert_eq!(e.code, "sync-sync-conflict");
    // the person puts their file back as it was; "adopt" retries and applies Nexus's preserved result
    w(&t.root, "app.js", "console.log(1)\n");
    let a =
        t.c.serve("project_adopt", json!({"runId": "run_1"}))
            .unwrap();
    assert_eq!(a["changed"], 1);
    assert_eq!(r(&t.root, "app.js"), "// nexus\n");
}

#[test]
fn engine_down_when_a_run_ends_is_recovered_when_it_returns() {
    let mut t = setup(true);
    pick(&mut t);
    send(&t).unwrap();
    w(&t.gwork, "new.txt", "n\n");
    finish(&t, "run_1", "verified-passed");
    *t.fake.ready.lock().unwrap() = false; // SSH down / guest restarting
    t.c.tick();
    assert_eq!(r(&t.root, "new.txt"), "<absent>");
    // nothing can be started while the engine is away
    assert!(send(&t).is_err());
    *t.fake.ready.lock().unwrap() = true;
    t.c.tick();
    assert_eq!(r(&t.root, "new.txt"), "n\n");
}

#[test]
fn restart_with_a_run_in_flight_resumes_from_the_registry() {
    let mut t = setup(true);
    pick(&mut t);
    send(&t).unwrap();
    w(&t.gwork, "z.txt", "z\n");
    // "app restart": a brand new coordinator over the same registry directory
    let store = Arc::new(Store::open(t.c.store.dir()).unwrap());
    let dialogs: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs::default());
    let c2 = Coordinator::new(store, t.fake.clone(), dialogs, None);
    finish(&t, "run_1", "verified-passed");
    c2.tick();
    assert_eq!(r(&t.root, "z.txt"), "z\n");
    c2.tick();
    let reopened = Store::open(t.c.store.dir()).unwrap();
    assert_eq!(reopened.list()[0].generation, 2);
}

#[test]
fn unsupported_edit_mode_changes_and_forget() {
    let mut t = setup(true);
    pick(&mut t);
    let e =
        t.c.serve(
            "project_set_edit_mode",
            json!({"projectId": "guest-proj", "mode": "direct"}),
        )
        .unwrap_err();
    assert_eq!(e.code, "sync-unsupported");
    t.c.serve("project_forget", json!({"projectId": "guest-proj"}))
        .unwrap();
    assert!(t.c.store.list().is_empty());
    assert_eq!(
        r(&t.root, "app.js"),
        "console.log(1)\n",
        "the Mac folder is never touched by forgetting"
    );
}

#[test]
fn the_opt_in_is_asked_separately_and_can_be_changed_by_choosing_the_folder_again() {
    // allow-all dialogs: both questions answered "Allow"
    let mut t = setup(true);
    let v = pick(&mut t);
    assert_eq!(v["project"]["sync"]["applyUnverified"], true);
    let shown = t._dialogs_shown();
    assert!(
        shown
            .iter()
            .any(|(title, _)| title.contains("Also apply results that could not be verified")),
        "{shown:?}"
    );
    assert!(
        t.c.store.list()[0]
            .consent
            .as_ref()
            .unwrap()
            .apply_unverified
    );
}

/// The bug: "Run commands → Allow…" was applied by the engine but never shown, because the Mac host rewrote the
/// project it forwarded. The engine's grant must reach the UI, and a project without one must show none.
#[test]
fn an_execution_grant_given_in_the_engine_is_visible_after_it_is_applied() {
    let mut t = setup(true);
    pick(&mut t);
    let before = t.c.serve("project_list", json!({})).unwrap();
    assert!(before["projects"][0].get("grant").is_none());
    assert_eq!(before["projects"][0]["sync"]["state"], "synced");
    t.c.serve("project_allow_work", json!({"projectId": "guest-proj"}))
        .unwrap();
    let after = t.c.serve("project_list", json!({})).unwrap();
    let p = &after["projects"][0];
    assert_eq!(p["grant"]["status"], "active");
    assert_eq!(
        p["grant"]["fs"], "workspace",
        "the grant the person confirmed"
    );
    assert_eq!(p["workspaceMode"], "direct");
    // the Mac-side synchronization setting is a separate fact and did not move
    assert_eq!(p["sync"]["applyUnverified"], true);
    assert_eq!(p["macPath"], t.root.to_str().unwrap());
}
