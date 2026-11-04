//! Host-side bridge transport against a scripted bridge process (no SSH, no guest).

use nexus_desktop_lib::bridge_link::{BridgeLink, Transport};
use nexus_desktop_lib::dialogs::{Dialogs, ScriptedDialogs};
use nexus_desktop_lib::engine::{EngineLink, EngineStatus};
use serde_json::json;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Mock {
    env: Vec<(&'static str, &'static str)>,
    program: Option<String>,
}

impl Transport for Mock {
    fn spawn(&self) -> std::io::Result<Child> {
        let exe = std::env::current_exe().unwrap();
        let path = exe
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/mock_bridge");
        let mut c = Command::new(self.program.clone().unwrap_or(path.display().to_string()));
        for (k, v) in &self.env {
            c.env(k, v);
        }
        c.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
    fn describe(&self) -> String {
        "mock bridge".into()
    }
}

fn start(env: Vec<(&'static str, &'static str)>, confirm: bool) -> Arc<BridgeLink> {
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs {
        confirm,
        ..Default::default()
    });
    BridgeLink::start(Box::new(Mock { env, program: None }), d, "0.1.0")
}

fn wait(link: &BridgeLink, f: impl Fn(&EngineStatus) -> bool) -> EngineStatus {
    let t = Instant::now();
    loop {
        let s = link.status();
        if f(&s) {
            return s;
        }
        assert!(t.elapsed() < Duration::from_secs(30), "timed out in {s:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn connects_and_forwards_a_named_command() {
    let l = start(vec![], true);
    wait(&l, |s| s.is_ready());
    let v = l.call("thread_list", json!({"projectId": "p"})).unwrap();
    assert_eq!(v["cmd"], "thread_list");
    assert_eq!(v["args"]["projectId"], "p");
    assert!(l.diagnostics().lines.iter().any(|x| x.contains("mock")));
    l.shutdown();
}

#[test]
fn incompatible_engine_is_an_error_and_receives_nothing() {
    let l = start(vec![("MOCK_PROTO", "99")], true);
    let s = wait(&l, |s| matches!(s, EngineStatus::Error { .. }));
    assert!(s.message().contains("protocol"));
    let e = l.call("thread_send", json!({})).unwrap_err();
    assert_eq!(e.code, "engine-error");
    l.shutdown();
    let l = start(vec![("MOCK_VERSION", "9.9.9")], true);
    wait(&l, |s| matches!(s, EngineStatus::Error { .. }));
    l.shutdown();
}

#[test]
fn busy_reflects_active_runs() {
    let l = start(vec![("MOCK_ACTIVE", "2")], true);
    wait(&l, |s| matches!(s, EngineStatus::Busy { active_runs: 2 }));
    assert!(l.call("x", json!({})).is_ok());
    l.shutdown();
}

#[test]
fn a_crash_fails_the_call_then_reconnects() {
    let l = start(vec![], true);
    wait(&l, |s| s.is_ready());
    let e = l.call("crash", json!({})).unwrap_err();
    assert_eq!(e.code, "engine-disconnected");
    assert!(e.message.contains("may or may not"));
    wait(&l, |s| matches!(s, EngineStatus::Disconnected { .. }));
    // refused while down: nothing is queued or replayed
    assert_eq!(
        l.call("thread_send", json!({})).unwrap_err().code,
        "engine-disconnected"
    );
    // automatic reconnection
    wait(&l, |s| s.is_ready());
    assert!(l.call("thread_list", json!({})).is_ok());
    assert!(l
        .diagnostics()
        .lines
        .iter()
        .any(|x| x.contains("attempts: 2")));
    l.shutdown();
}

#[test]
fn confirmations_are_answered_by_the_host_dialog() {
    for allowed in [true, false] {
        let l = start(vec![], allowed);
        wait(&l, |s| s.is_ready());
        let v = l.call("ask", json!({})).unwrap();
        assert_eq!(v["allowed"], allowed);
        l.shutdown();
    }
}

#[test]
fn unreachable_guest_is_disconnected_with_the_reason() {
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs::default());
    let l = BridgeLink::start(
        Box::new(Mock {
            env: vec![("MOCK_EXIT_AT_START", "1")],
            program: None,
        }),
        d,
        "0.1.0",
    );
    let s = wait(&l, |s| matches!(s, EngineStatus::Disconnected { .. }));
    assert!(s.message().contains("Permission denied"), "{}", s.message());
    l.shutdown();
    let d: Arc<dyn Dialogs> = Arc::new(ScriptedDialogs::default());
    let l = BridgeLink::start(
        Box::new(Mock {
            env: vec![],
            program: Some("/nonexistent/ssh".into()),
        }),
        d,
        "0.1.0",
    );
    wait(&l, |s| matches!(s, EngineStatus::Disconnected { .. }));
    l.shutdown();
}

#[test]
fn shutdown_is_safe_and_idempotent() {
    let l = start(vec![], true);
    wait(&l, |s| s.is_ready());
    l.shutdown();
    l.shutdown();
    assert!(!l.status().is_ready());
    assert!(l.call("x", json!({})).is_err());
}

struct BrokenDialogs;
impl Dialogs for BrokenDialogs {
    fn pick_folder(&self, _: &str) -> Result<Option<String>, String> {
        Err("no display".into())
    }
    fn confirm(&self, _: &str, _: &str) -> Result<bool, String> {
        Err("no display".into())
    }
    fn secret(&self, _: &str, _: &str) -> Result<Option<String>, String> {
        Err("no display".into())
    }
}

#[test]
fn a_confirmation_that_cannot_be_shown_is_reported_as_a_failure_not_as_a_no() {
    let l = BridgeLink::start(
        Box::new(Mock {
            env: vec![],
            program: None,
        }),
        Arc::new(BrokenDialogs),
        "0.1.0",
    );
    wait(&l, |s| s.is_ready());
    let v = l.call("ask", json!({})).unwrap();
    assert_eq!(v["allowed"], false, "never an approval");
    assert_eq!(
        v["error"], "no display",
        "and the reason travels back to the engine"
    );
    l.shutdown();
}
