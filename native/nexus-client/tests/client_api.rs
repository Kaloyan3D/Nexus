//! A2.4 Client API contract tests: versioning, redaction, mock isolation, blocked live.

use nexus_client::*;

#[test]
fn api_version_is_one() {
    assert_eq!(CLIENT_API_VERSION, 1);
    assert_eq!(CLIENT_API_VERSION_STR, "1");
    assert_eq!(IPC_PROTOCOL_VERSION, 1);
}

#[test]
fn errors_redact_secrets() {
    let e = ClientError::internal("leak sk-test-SECRET-marker-xyz Bearer abc");
    assert!(
        !e.to_string().contains("sk-test-SECRET-marker-xyz"),
        "secret leaked: {e}"
    );
    assert!(!e.to_string().contains("Bearer abc"), "secret leaked: {e}");
}

#[test]
fn models_reports_blocked_live_and_no_dispatch() {
    let m = models();
    assert_eq!(
        m.get("dispatchEnabled").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        m.pointer("/live/ready").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert!(m
        .pointer("/live/blockers")
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false));
}

#[test]
fn live_blockers_pin_dispatch_disabled() {
    let b = live_blockers();
    assert_eq!(
        b.get("dispatchEnabled").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(b.get("ready").and_then(|v| v.as_bool()), Some(false));
}

#[test]
fn mock_run_is_isolated_and_deterministic() {
    let r = run_mock("Test native runtime").expect("mock run");
    assert_eq!(r.text, "Hello, world.");
    assert_eq!(r.finish_reason, "stop");
    assert!(!r.events.is_empty());
    assert!(!r.request_digest.is_empty());
}

#[test]
fn mock_run_refuses_empty_prompt() {
    let e = run_mock("   ").expect_err("empty");
    assert_eq!(e.code, "bad-usage");
}

#[test]
fn cancel_is_unauthorized_for_normal_users() {
    let cfg = ClientConfig::resolve(None, None, true).expect("config");
    let e = cancel(&cfg, "cmd-x").expect_err("cancel gated");
    assert_eq!(e.code, "unauthorized");
}

#[test]
fn config_show_carries_no_secrets() {
    let cfg = ClientConfig::resolve(None, None, true).expect("config");
    let s = cfg.summary_json();
    assert_eq!(
        s.get("dispatchEnabled").and_then(|v| v.as_bool()),
        Some(false)
    );
    let raw = s.to_string();
    assert!(!raw.contains("sk-"));
    assert!(!raw.contains("Bearer"));
}
