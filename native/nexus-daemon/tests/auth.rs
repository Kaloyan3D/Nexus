//! Issuer authorization boundary (A1.3.3): unauthorized mutations are
//! refused, replay is rejected, the same-UID limitation is proven and
//! pinned, and the legacy CLI cannot bypass daemon authorization.

mod common;

use common::*;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::time::Duration;

fn unauthed(cmd: &str, params: serde_json::Value) -> String {
    serde_json::json!({"protocol": 1, "id": next_id("un"), "cmd": cmd, "params": params})
        .to_string()
}

#[test]
fn readonly_daemon_disables_all_privileged_commands() {
    let mut d = spawn_daemon("readonly", true);
    // No cap file exists in readonly mode: no credential can enable what
    // configuration disables.
    assert!(!d.cap.exists(), "readonly mode creates no capability file");
    for (cmd, params) in [
        (
            "acquire",
            serde_json::json!({"taskInstanceId": "t", "backend": "native"}),
        ),
        ("seal", serde_json::json!({"resolution": {}})),
        (
            "accept",
            serde_json::json!({"intent": {}, "resolution": {}, "snapshot": {}, "lease": {}}),
        ),
    ] {
        let resp = raw_request(&d.socket, &unauthed(cmd, params)).expect("transport");
        assert_refused(&resp, "privileged-disabled");
    }
    // Even a well-formed auth block cannot enable readonly mutations.
    let forged = serde_json::json!({
        "protocol": 1, "id": "ro-forge", "cmd": "acquire",
        "params": {"taskInstanceId": "t", "backend": "native"},
        "auth": {"nonce": next_nonce(), "ts": now_ms(), "tag": "00".repeat(32)},
    })
    .to_string();
    let resp = raw_request(&d.socket, &forged).expect("transport");
    assert_refused(&resp, "privileged-disabled");
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn shadow_test_refuses_unauthenticated_mutations() {
    let mut d = spawn_daemon("shadow-test", true);
    for (cmd, params) in [
        (
            "acquire",
            serde_json::json!({"taskInstanceId": "t", "backend": "native"}),
        ),
        ("seal", serde_json::json!({"resolution": {}})),
        (
            "accept",
            serde_json::json!({"intent": {}, "resolution": {}, "snapshot": {}, "lease": {}}),
        ),
    ] {
        let resp = raw_request(&d.socket, &unauthed(cmd, params)).expect("transport");
        assert_refused(&resp, "issuer-untrusted");
    }
    // Read-only commands need no authentication.
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"rh","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&health);
    let receipt = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"rr","cmd":"receipt","params":{"commandId":"nothing"}}"#,
    )
    .expect("transport");
    assert_ok(&receipt);
    assert_eq!(receipt.get("receipt"), Some(&serde_json::Value::Null));
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn wrong_key_stale_timestamp_and_replay_are_refused() {
    let mut d = spawn_daemon("shadow-test", true);
    let good_cap = read_cap(&d.cap);
    let params = serde_json::json!({"taskInstanceId": "t", "backend": "native"});
    // Wrong key (a different daemon's capability would look like this).
    let bad = authed_frame(&"ff".repeat(32), "acquire", params.clone());
    let resp = raw_request(&d.socket, &bad).expect("transport");
    assert_refused(&resp, "issuer-untrusted");
    // Stale timestamp with a valid tag.
    let id = next_id("stale");
    let nonce = next_nonce();
    let ts = now_ms() - 10 * 60 * 1000;
    let tag = sign(&good_cap, "acquire", &id, &params, &nonce, ts);
    let stale = serde_json::json!({
        "protocol": 1, "id": id, "cmd": "acquire", "params": params,
        "auth": {"nonce": nonce, "ts": ts, "tag": tag},
    })
    .to_string();
    let resp = raw_request(&d.socket, &stale).expect("transport");
    assert_refused(&resp, "issuer-untrusted");
    // Valid frame, sent twice: the replay is rejected even though the
    // first admission succeeded (acquire is idempotent-safe at the kernel,
    // but the authorization layer rejects the reused nonce).
    let frame = authed_frame(&good_cap, "acquire", params);
    let first = raw_request(&d.socket, &frame).expect("transport");
    assert_ok(&first);
    let second = raw_request(&d.socket, &frame).expect("transport");
    assert_refused(&second, "replay-rejected");
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn forged_resolution_is_refused_on_the_protected_path() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    // 1. No authentication at all: refused before seal semantics are even
    //    consulted, however self-consistent the forgery is.
    let snapshot = snapshot();
    let forged = resolution_for("task-forge-1", &snapshot);
    let resp = raw_request(
        &d.socket,
        &unauthed("seal", serde_json::json!({"resolution": forged})),
    )
    .expect("transport");
    assert_refused(&resp, "issuer-untrusted");
    // 2. Authenticated but tampered bytes: the kernel's seal check fails
    //    closed (issuanceId no longer matches the sealed content).
    let mut tampered = forged.clone();
    tampered["provenance"]["issuanceId"] = serde_json::Value::String("00".repeat(32));
    let resp = raw_request(
        &d.socket,
        &authed_frame(&cap, "seal", serde_json::json!({"resolution": tampered})),
    )
    .expect("transport");
    assert_eq!(
        resp.get("ok"),
        Some(&serde_json::Value::Bool(false)),
        "tampered seal must fail: {resp}"
    );
    assert!(
        code_of(&resp) == "delivery-invalid" || code_of(&resp) == "forged-issuer",
        "tampered seal names its refusal: {resp}"
    );
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn same_uid_cap_theft_is_possible_and_documented() {
    // HONEST LIMITATION TEST: this test PROVES the documented weakness. A
    // process running as the daemon's UID can read the 0600 capability file
    // (same-UID reads are allowed by the OS) and impersonate the trusted
    // issuer. If this test ever FAILS (impersonation refused), the trust
    // boundary got stronger and the documentation must be updated.
    let mut d = spawn_daemon("shadow-test", true);
    let mode = std::fs::metadata(&d.cap)
        .expect("cap exists")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "cap file is owner-only on disk");
    // Same-UID read succeeds despite 0600: that is the vulnerability.
    let stolen = read_cap(&d.cap);
    assert_eq!(stolen.len(), 64);
    let resp = raw_request(
        &d.socket,
        &authed_frame(
            &stolen,
            "acquire",
            serde_json::json!({"taskInstanceId": "task-theft-1", "backend": "native"}),
        ),
    )
    .expect("transport");
    assert_ok(&resp);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn legacy_cli_cannot_bypass_daemon_authorization() {
    let mut d = spawn_daemon("shadow-test", true);
    let dir = d._dir.path().to_path_buf();
    // CLI acquire while the daemon owns the store: refused, exit 2.
    let req = dir.join("acq.json");
    std::fs::write(
        &req,
        r#"{"protocol":1,"taskInstanceId":"t","backend":"native"}"#,
    )
    .expect("req");
    let out = Command::new(kernel_bin())
        .arg("acquire")
        .arg("--db")
        .arg(&d.db)
        .arg("--input")
        .arg(&req)
        .output()
        .expect("cli runs");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("daemon-owns-store"));
    // CLI seal likewise refused.
    let snapshot = snapshot();
    let forged = resolution_for("task-cli-bypass", &snapshot);
    let seal_req = dir.join("seal.json");
    std::fs::write(
        &seal_req,
        serde_json::json!({"protocol": 1, "resolution": forged}).to_string(),
    )
    .expect("seal req");
    let out = Command::new(kernel_bin())
        .arg("seal")
        .arg("--db")
        .arg(&d.db)
        .arg("--input")
        .arg(&seal_req)
        .output()
        .expect("cli runs");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("daemon-owns-store"));
    // Read-only CLI still works (no authority is bypassed by reading).
    let rec_req = dir.join("rec.json");
    std::fs::write(&rec_req, r#"{"protocol":1,"commandId":"nothing"}"#).expect("rec req");
    let out = Command::new(kernel_bin())
        .arg("receipt")
        .arg("--db")
        .arg(&d.db)
        .arg("--input")
        .arg(&rec_req)
        .output()
        .expect("cli runs");
    assert!(out.status.success());
    terminate(&mut d.child);
    let _ = d.child.wait();
    // After the daemon exits, the CLI mutation path works again (no stale
    // ownership): proves the guard tracks liveness, not file existence.
    let out = Command::new(kernel_bin())
        .arg("acquire")
        .arg("--db")
        .arg(&d.db)
        .arg("--input")
        .arg(&req)
        .output()
        .expect("cli runs");
    assert!(
        out.status.success(),
        "CLI works after daemon exit: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn conflicting_commands_preserve_prior_receipt() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    let first = accept_one(
        &d.socket,
        &cap,
        "task-conf-1",
        "task-conf-1-A1",
        "cmd-conf-1",
    );
    let first_receipt = first.get("receipt").expect("receipt").clone();
    // Same commandId, different attempt identity (different digest).
    let acquired = raw_request(
        &d.socket,
        &authed_frame(
            &cap,
            "acquire",
            serde_json::json!({"taskInstanceId": "task-conf-1", "backend": "native"}),
        ),
    )
    .expect("acquire");
    assert_ok(&acquired);
    let lease = acquired.get("lease").expect("lease").clone();
    let snapshot = snapshot();
    let resolution = resolution_for("task-conf-1", &snapshot);
    let sealed = raw_request(
        &d.socket,
        &authed_frame(&cap, "seal", serde_json::json!({"resolution": resolution})),
    )
    .expect("seal");
    assert_ok(&sealed);
    let intent = intent_for("task-conf-1", "task-conf-1-A2", "cmd-conf-1");
    let conflict = raw_request(
        &d.socket,
        &authed_frame(
            &cap,
            "accept",
            serde_json::json!({
                "intent": intent,
                "resolution": resolution,
                "snapshot": snapshot,
                "lease": { "epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation") },
            }),
        ),
    )
    .expect("accept");
    assert_refused(&conflict, "command-conflict");
    // Prior authority is byte-identical.
    let reread = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"cf","cmd":"receipt","params":{"commandId":"cmd-conf-1"}}"#,
    )
    .expect("receipt");
    assert_ok(&reread);
    assert_eq!(reread.get("receipt"), Some(&first_receipt));
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn crash_between_accept_and_response_converges_on_receipt() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    // Commit one receipt normally first (control case for byte-identity).
    let first = accept_one(&d.socket, &cap, "task-ack-1", "task-ack-1-A1", "cmd-ack-1");
    let first_receipt = first.get("receipt").expect("receipt").clone();
    // Second command: send the accept frame, then SIGKILL without reading
    // the response (models termination after commit, before the ACK).
    let acquired = raw_request(
        &d.socket,
        &authed_frame(
            &cap,
            "acquire",
            serde_json::json!({"taskInstanceId": "task-ack-1", "backend": "native"}),
        ),
    )
    .expect("acquire");
    let lease = acquired.get("lease").expect("lease").clone();
    let snapshot = snapshot();
    let resolution = resolution_for("task-ack-1", &snapshot);
    let sealed = raw_request(
        &d.socket,
        &authed_frame(&cap, "seal", serde_json::json!({"resolution": resolution})),
    )
    .expect("seal");
    assert_ok(&sealed);
    let intent = intent_for("task-ack-1", "task-ack-1-A2", "cmd-ack-2");
    let frame = authed_frame(
        &cap,
        "accept",
        serde_json::json!({
            "intent": intent,
            "resolution": resolution,
            "snapshot": snapshot,
            "lease": { "epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation") },
        }),
    );
    {
        use std::io::Write;
        let mut s = std::os::unix::net::UnixStream::connect(&d.socket).expect("connect");
        s.write_all(frame.as_bytes()).expect("write");
        s.write_all(b"\n").expect("newline");
        // No read: crash immediately.
    }
    crash(&mut d.child);
    // Restart on the same DataRoot (stale socket reclaimed).
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&d.db)
        .arg("--socket")
        .arg(&d.socket)
        .arg("--cap")
        .arg(&d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&d.witness)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("restart");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            &d.socket,
            r#"{"protocol":1,"id":"ak","cmd":"health","params":{}}"#,
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                break;
            }
        }
        if std::time::Instant::now() > deadline {
            terminate(&mut child);
            panic!("restart never ready");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // Converge: re-accepting the same envelope is either created (if the
    // crash landed before commit) or replayed (if after). It is NEVER a
    // conflict and there is exactly one receipt for each command.
    let cap2 = read_cap(&d.cap);
    let acquired = raw_request(
        &d.socket,
        &authed_frame(
            &cap2,
            "acquire",
            serde_json::json!({"taskInstanceId": "task-ack-1", "backend": "native"}),
        ),
    )
    .expect("acquire2");
    let lease = acquired.get("lease").expect("lease").clone();
    let reconverge = raw_request(
        &d.socket,
        &authed_frame(
            &cap2,
            "accept",
            serde_json::json!({
                "intent": intent,
                "resolution": resolution,
                "snapshot": snapshot,
                "lease": { "epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation") },
            }),
        ),
    )
    .expect("re-accept");
    assert_ok(&reconverge);
    // Control receipt is untouched.
    let reread = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"ak2","cmd":"receipt","params":{"commandId":"cmd-ack-1"}}"#,
    )
    .expect("receipt");
    assert_ok(&reread);
    assert_eq!(reread.get("receipt"), Some(&first_receipt));
    let status = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"ak3","cmd":"status","params":{}}"#,
    )
    .expect("status");
    assert_eq!(
        status.get("acceptedCommands").and_then(|v| v.as_i64()),
        Some(2)
    );
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn missing_witness_latches_reconciliation_required() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    let _ = accept_one(&d.socket, &cap, "task-wit-1", "task-wit-1-A1", "cmd-wit-1");
    terminate(&mut d.child);
    let _ = d.child.wait();
    // Witness file lost while the main store survives: the next generation
    // operation must fail closed, and status must latch the condition.
    std::fs::remove_file(&d.witness).expect("delete witness");
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&d.db)
        .arg("--socket")
        .arg(&d.socket)
        .arg("--cap")
        .arg(&d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&d.witness)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("restart without witness");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            &d.socket,
            r#"{"protocol":1,"id":"w1","cmd":"health","params":{}}"#,
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                break;
            }
        }
        if std::time::Instant::now() > deadline {
            terminate(&mut child);
            panic!("restart never ready");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // Note: the cap rotated on restart; re-read it.
    let cap2 = read_cap(&d.cap);
    let resp = raw_request(
        &d.socket,
        &authed_frame(
            &cap2,
            "acquire",
            serde_json::json!({"taskInstanceId": "task-wit-1", "backend": "native"}),
        ),
    )
    .expect("acquire");
    assert_eq!(
        resp.get("ok"),
        Some(&serde_json::Value::Bool(false)),
        "witness loss must fail closed: {resp}"
    );
    assert!(
        code_of(&resp) == "reconciliation-required" || code_of(&resp) == "witness-required",
        "witness loss names its refusal: {resp}"
    );
    let status = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"w2","cmd":"status","params":{}}"#,
    )
    .expect("status");
    assert_ok(&status);
    assert_eq!(
        status.get("reconciliationRequired"),
        Some(&serde_json::Value::Bool(true))
    );
    terminate(&mut child);
    let _ = child.wait();
}
