//! A2.1 isolation adversarial tests: real `nexusd` binary, real Unix
//! sockets, real SO_PEERCRED. No production data is touched.
//!
//! What these tests prove (and what they cannot): the UID gate is enforced
//! against REAL peer credentials, including a non-matching allowlist while
//! presenting a VALID capability tag -- a stolen cap alone is insufficient.
//! Genuinely distinct OS identities are unavailable to this unprivileged
//! runner, so the non-matching allowlist stands in for the untrusted-UID
//! principal: the daemon sees a real uid that is not authorized and must
//! refuse. Production remains BLOCKED until separate service identities
//! exist (see native/deploy/SETUP.md and the A2.1 evidence report).

mod common;
use common::{
    authed_frame, code_of, kernel_bin, nexusd_bin, raw_request, read_cap, spawn_daemon_opts,
    terminate,
};
use std::process::{Command, Stdio};

fn other_uid() -> u32 {
    let me = unsafe { libc::geteuid() };
    if me != 65534 {
        65534
    } else {
        1000
    }
}

fn me_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn acquire_params(task: &str) -> serde_json::Value {
    serde_json::json!({ "taskInstanceId": task, "backend": "native" })
}

#[test]
fn non_allowlisted_uid_refused_despite_valid_capability() {
    // The hostile principal: a real, valid capability tag presented over a
    // connection whose SO_PEERCRED uid is NOT allowlisted. Must refuse with
    // peer-unauthorized -- never admit, never fall back.
    let proc = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--allowed-uids", &other_uid().to_string()],
    );
    let cap = read_cap(&proc.cap);
    let frame = authed_frame(&cap, "acquire", acquire_params("task-hostile"));
    let resp = raw_request(&proc.socket, &frame).expect("transport");
    assert_eq!(resp.get("ok"), Some(&serde_json::Value::Bool(false)));
    assert_eq!(code_of(&resp), "peer-unauthorized");
    // Read-only surface is unaffected: refusal is scoped to privilege.
    let health = raw_request(
        &proc.socket,
        r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_eq!(health.get("ok"), Some(&serde_json::Value::Bool(true)));
    let mut child = proc.child;
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn allowlisted_uid_shadow_flow_works_and_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let proc = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--allowed-uids", &me_uid().to_string()],
    );
    let cap = read_cap(&proc.cap);
    let frame = authed_frame(&cap, "acquire", acquire_params("task-legit"));
    let resp = raw_request(&proc.socket, &frame).expect("transport");
    assert_eq!(resp.get("ok"), Some(&serde_json::Value::Bool(true)));
    assert_eq!(
        resp.pointer("/lease/leaseEpoch"),
        Some(&serde_json::Value::from(1u64))
    );
    // Owner-only creation proof (umask 0077): no group/other bits on the
    // capability, the store, the witness, or the DataRoot itself, so a
    // genuinely distinct OS identity gets EACCES on all kernel persistence.
    for path in [&proc.cap, &proc.db, &proc.witness] {
        let mode = std::fs::metadata(path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(
            mode,
            0o600,
            "{} must be 0600, got {:o}",
            path.display(),
            mode
        );
    }
    let dir_mode = std::fs::metadata(proc.db.parent().unwrap())
        .expect("stat dir")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dir_mode, 0o700, "dataroot must be 0700, got {dir_mode:o}");
    let mut child = proc.child;
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn permissive_dataroot_refuses_startup() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).expect("chmod");
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(dir.path().join("k.db"))
        .arg("--socket")
        .arg(dir.path().join("n.sock"))
        .arg("--trust-mode")
        .arg("shadow-test")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("daemon runs");
    assert!(
        !out.status.success(),
        "permissive dataroot must refuse startup"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("insecure-dataroot"),
        "refusal is named explicitly: {stderr}"
    );
    assert!(
        !dir.path().join("n.sock").exists(),
        "no socket is ever bound on refusal"
    );
}

#[test]
fn unauthenticated_and_forged_seal_refused_with_gate_enforcing() {
    // Item 1: an unauthorized process can neither issue nor seal. Missing
    // auth is refused before the UID gate is even consulted
    // (issuer-untrusted, never peer-unauthorized, never admitted).
    let proc = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--allowed-uids", &me_uid().to_string()],
    );
    let no_auth = raw_request(
        &proc.socket,
        r#"{"protocol":1,"id":"noauth","cmd":"seal","params":{"resolution":{}}}"#,
    )
    .expect("transport");
    assert_eq!(no_auth.get("ok"), Some(&serde_json::Value::Bool(false)));
    assert_eq!(code_of(&no_auth), "issuer-untrusted");
    // Forged tag over a self-consistent resolution: auth gates first.
    let cap = read_cap(&proc.cap);
    let mut forged: serde_json::Value = serde_json::from_str(&authed_frame(
        &cap,
        "seal",
        serde_json::json!({"resolution":{}}),
    ))
    .expect("frame json");
    forged["auth"]["tag"] = serde_json::Value::String("de".repeat(32));
    let resp = raw_request(&proc.socket, &forged.to_string()).expect("transport");
    assert_eq!(resp.get("ok"), Some(&serde_json::Value::Bool(false)));
    assert_eq!(code_of(&resp), "issuer-untrusted");
    let mut child = proc.child;
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn replay_rejected_at_ipc_with_gate_enforcing() {
    let proc = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--allowed-uids", &me_uid().to_string()],
    );
    let cap = read_cap(&proc.cap);
    let frame = authed_frame(&cap, "acquire", acquire_params("task-replay"));
    let first = raw_request(&proc.socket, &frame).expect("transport");
    assert_eq!(first.get("ok"), Some(&serde_json::Value::Bool(true)));
    let replay = raw_request(&proc.socket, &frame).expect("transport");
    assert_eq!(replay.get("ok"), Some(&serde_json::Value::Bool(false)));
    assert_eq!(code_of(&replay), "replay-rejected");
    let mut child = proc.child;
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn cli_cannot_bypass_live_daemon_ownership() {
    let proc = spawn_daemon_opts("shadow-test", true, &[]);
    let kernel = kernel_bin();
    let req = proc._dir.path().join("acq.json");
    std::fs::write(
        &req,
        r#"{"protocol":1,"taskInstanceId":"t","backend":"native"}"#,
    )
    .expect("write");
    let out = Command::new(kernel)
        .arg("acquire")
        .arg("--db")
        .arg(&proc.db)
        .arg("--input")
        .arg(&req)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("cli runs");
    assert!(
        !out.status.success(),
        "CLI mutation must be refused while live"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("daemon-owns-store"),
        "refusal names ownership"
    );
    let mut child = proc.child;
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn readiness_reports_transport_posture_and_stays_not_ready() {
    let proc = spawn_daemon_opts(
        "shadow-test",
        true,
        &["--allowed-uids", &me_uid().to_string()],
    );
    let ready = raw_request(
        &proc.socket,
        r#"{"protocol":1,"id":"r","cmd":"readiness","params":{}}"#,
    )
    .expect("transport");
    assert_eq!(ready.get("ok"), Some(&serde_json::Value::Bool(true)));
    assert_eq!(
        ready.pointer("/readiness/verdict"),
        Some(&serde_json::Value::String("NOT_READY".to_owned()))
    );
    assert_eq!(
        ready.pointer("/transport/peerUidEnforced"),
        Some(&serde_json::Value::Bool(true))
    );
    let allowed = ready
        .pointer("/transport/allowedUids")
        .expect("allowedUids");
    assert!(allowed
        .as_array()
        .expect("array")
        .contains(&serde_json::Value::from(me_uid())));
    assert_eq!(
        ready.pointer("/readiness/dispatch_enabled"),
        Some(&serde_json::Value::Bool(false))
    );
    let mut child = proc.child;
    terminate(&mut child);
    let _ = child.wait();
}
