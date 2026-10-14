//! A2.4 CLI contract tests: exit codes, JSON shape, mock isolation, blocked live.

use std::process::Command;

fn nexus() -> Command {
    Command::new(env!("CARGO_BIN_EXE_nexus"))
}

fn run(args: &[&str]) -> (i32, String, String) {
    let out = nexus().args(args).output().expect("spawn nexus");
    let code = out.status.code().unwrap_or(-1);
    (
        code,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn version_exits_zero() {
    let (c, so, _) = run(&["--version"]);
    assert_eq!(c, 0);
    assert!(so.contains("nexus 0.1.0"), "{so}");
}

#[test]
fn models_json_is_blocked_live() {
    let (c, so, _) = run(&["--json", "models"]);
    assert_eq!(c, 0);
    let v: serde_json::Value = serde_json::from_str(&so).expect("models json");
    assert_eq!(
        v.get("dispatchEnabled").and_then(|x| x.as_bool()),
        Some(false)
    );
}

#[test]
fn config_show_has_no_secrets() {
    let (c, so, _) = run(&["--json", "config", "show"]);
    assert_eq!(c, 0);
    let v: serde_json::Value = serde_json::from_str(&so).expect("config json");
    assert_eq!(v.get("clientApiVersion").and_then(|x| x.as_u64()), Some(1));
    assert!(!so.contains("sk-"));
    assert!(!so.contains("Bearer"));
}

#[test]
fn mock_run_json_is_deterministic() {
    let (c, so, _) = run(&["--json", "run", "--mock", "Test native runtime"]);
    assert_eq!(c, 0, "stdout={so}");
    let v: serde_json::Value = serde_json::from_str(&so).expect("mock json");
    assert_eq!(v.get("ok").and_then(|x| x.as_bool()), Some(true));
    assert_eq!(v.get("mock").and_then(|x| x.as_bool()), Some(true));
    assert_eq!(
        v.get("text").and_then(|x| x.as_str()),
        Some("Hello, world.")
    );
}

#[test]
fn mock_run_never_touches_live_provider() {
    let (c, so, se) = run(&["--json", "run", "--mock", "Test native runtime"]);
    assert_eq!(c, 0);
    let combined = so + &se;
    assert!(!combined.contains("https://"), "live URL in mock output");
    assert!(combined.contains("mock") || combined.contains("Hello"));
}

#[test]
fn live_run_is_blocked_exit_five() {
    let (c, so, se) = run(&["run"]);
    assert_eq!(c, 5, "stdout={so} stderr={se}");
    let combined = so + &se;
    assert!(combined.contains("BLOCKED"), "{combined}");
}

#[test]
fn status_without_daemon_is_disconnected() {
    let (c, _, se) = run(&["--socket", "/tmp/nexus-test-absent-xyz.sock", "status"]);
    assert_eq!(c, 3, "stderr={se}");
}

#[test]
fn doctor_without_daemon_is_disconnected() {
    let (c, _, _) = run(&["--socket", "/tmp/nexus-test-absent-xyz.sock", "doctor"]);
    assert_eq!(c, 3);
}

#[test]
fn tasks_without_ledger_is_usage() {
    let (c, _, _) = run(&["tasks"]);
    assert_eq!(c, 2);
}

#[test]
fn unknown_command_is_usage() {
    let (c, _, _) = run(&["frobnicate"]);
    assert_eq!(c, 2);
}

#[test]
fn tasks_lists_real_ledger_and_never_mock() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join("tasks.json"),
        r#"{"tasks":[{"id":"TASK-REAL-1","title":"Real controller task"}]}"#,
    )
    .expect("ledger");
    let ledger = dir.path().to_str().expect("utf8").to_owned();
    let out = nexus()
        .args(["--ledger-dir", &ledger, "--json", "tasks"])
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(0));
    let so = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(so.contains("TASK-REAL-1"), "{so}");
    assert!(
        !so.contains("cmd-mock-1"),
        "synthetic mock identity must never appear as a ledger task: {so}"
    );
}

#[test]
fn mock_output_is_labeled_mock() {
    let (c, so, _) = run(&["run", "--mock", "Test native runtime"]);
    assert_eq!(c, 0);
    assert!(
        so.contains("[mock]"),
        "mock runs must be labeled mock: {so}"
    );
}

#[test]
fn malformed_ledger_is_honest_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("tasks.json"), "NOT JSON{{{").expect("ledger");
    let ledger = dir.path().to_str().expect("utf8").to_owned();
    let out = nexus()
        .args(["--ledger-dir", &ledger, "tasks"])
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(1));
    assert!(!out.status.success());
}
