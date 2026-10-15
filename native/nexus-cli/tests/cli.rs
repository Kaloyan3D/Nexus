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

// ---- A3.1 native tools -------------------------------------------------

#[test]
fn tools_list_and_inspect_are_read_only_metadata() {
    let (c, so, _) = run(&["--json", "tools", "list"]);
    assert_eq!(c, 0);
    let v: serde_json::Value = serde_json::from_str(&so).expect("tools json");
    let ids: Vec<_> = v["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, vec!["fs.list", "fs.read", "fs.search"]);
    assert_eq!(v["writeTools"], "none");
    assert_eq!(v["aiInitiatedExecution"], "disabled");
    let (c, so, _) = run(&["--json", "tools", "inspect", "fs.read"]);
    assert_eq!(c, 0);
    let v: serde_json::Value = serde_json::from_str(&so).unwrap();
    assert_eq!(v["readOnly"], true);
    let (c, _, se) = run(&["tools", "inspect", "fs.write"]);
    assert_eq!(c, 2, "{se}");
}

#[test]
fn offline_run_is_double_gated_and_labelled() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "hello needle\n").unwrap();
    let ws = dir.path().to_str().unwrap();
    // Missing flag.
    let (c, _, _) = run(&["tools", "run-offline", "--workspace", ws, "fs.list"]);
    assert_eq!(c, 2);
    // Flag but no env gate.
    let out = nexus()
        .args([
            "--json",
            "tools",
            "run-offline",
            "--offline-test",
            "--workspace",
            ws,
            "fs.list",
        ])
        .env_remove("NEXUS_TOOLS_OFFLINE_TEST")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4));
    // Both gates.
    let out = nexus()
        .args([
            "--json",
            "tools",
            "run-offline",
            "--offline-test",
            "--workspace",
            ws,
            "fs.search",
            r#"{"query":"needle"}"#,
        ])
        .env("NEXUS_TOOLS_OFFLINE_TEST", "1")
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["controllerAuthorized"], false);
    assert_eq!(v["aiInitiated"], false);
    assert_eq!(
        v["journalPhases"],
        serde_json::json!(["authorized", "started", "completed"])
    );
    assert_eq!(v["result"]["stats"]["matchesReturned"], 1);
}
