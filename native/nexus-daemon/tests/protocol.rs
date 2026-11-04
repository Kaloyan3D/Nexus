//! IPC protocol: valid request/response, version mismatch, malformed
//! frames, oversized requests, concurrent connections, disconnects,
//! unknown commands. All against the real `nexusd` over a real socket.

mod common;

use common::*;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::time::Duration;

#[test]
fn version_mismatch_is_rejected_with_id() {
    let mut d = spawn_daemon("readonly", false);
    let resp = raw_request(
        &d.socket,
        r#"{"protocol":2,"id":"v9","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_refused(&resp, "version-mismatch");
    assert_eq!(resp.get("id").and_then(|v| v.as_str()), Some("v9"));
    // The daemon still serves afterwards.
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"v10","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&health);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn malformed_frames_cannot_crash_daemon() {
    let mut d = spawn_daemon("readonly", false);
    for (i, frame) in [
        "not json at all",
        "[1,2,3]",
        "\"just a string\"",
        r#"{"protocol":1}"#,                                     // missing id/cmd
        r#"{"protocol":1,"id":"","cmd":"health"}"#,              // empty id
        r#"{"protocol":1,"id":"m","cmd":""}"#,                   // empty cmd
        r#"{"protocol":1,"id":"m","cmd":"health","params":[]}"#, // params not object
        r#"{"protocol":1,"id":"m","cmd":"health","evil":true}"#, // unknown field
        r#"{"protocol":1,"id":"m","cmd":"health","auth":42}"#,   // auth not object
    ]
    .iter()
    .enumerate()
    {
        let resp = raw_request(&d.socket, frame).unwrap_or_else(|e| {
            panic!("frame {i} got a transport error instead of a refusal: {e}")
        });
        assert_eq!(
            resp.get("ok"),
            Some(&serde_json::Value::Bool(false)),
            "malformed frame {i} must be a refusal: {resp}"
        );
        let _ = frame;
    }
    // Still serving exact-state reads.
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"after","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&health);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn oversized_request_is_rejected_before_parsing() {
    let mut d = spawn_daemon("readonly", false);
    let big = "x".repeat(1024 * 1024 + 100);
    let frame = format!(r#"{{"protocol":1,"id":"big","cmd":"health","params":{{"pad":"{big}"}}}}"#);
    let mut stream = UnixStream::connect(&d.socket).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("timeout");
    stream.write_all(frame.as_bytes()).expect("write");
    stream.write_all(b"\n").expect("newline");
    let mut reader = std::io::BufReader::new(stream);
    let mut line = String::new();
    use std::io::BufRead;
    reader.read_line(&mut line).expect("read");
    let resp: serde_json::Value = serde_json::from_str(line.trim()).expect("json response");
    assert_refused(&resp, "too-large");
    // Daemon survives the oversized frame.
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"ok2","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&health);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn unknown_commands_fail_closed() {
    let mut d = spawn_daemon("readonly", false);
    for cmd in [
        "explode", "ACQUIRE", "Health", "shutdown", "exec", "seal ", "",
    ] {
        let frame =
            serde_json::json!({"protocol": 1, "id": "u1", "cmd": cmd, "params": {}}).to_string();
        let resp = raw_request(&d.socket, &frame).expect("transport");
        // Empty cmd is a parse refusal; anything else is unknown-command.
        // Both are closed refusals, never success.
        assert_eq!(
            resp.get("ok"),
            Some(&serde_json::Value::Bool(false)),
            "cmd {cmd:?} must fail: {resp}"
        );
        if !cmd.is_empty() {
            assert_refused(&resp, "unknown-command");
        }
    }
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn concurrent_clients_share_one_daemon() {
    let mut d = spawn_daemon("shadow-test", true);
    let socket = d.socket.clone();
    let handles: Vec<_> = (0..16)
        .map(|i| {
            let sock = socket.clone();
            std::thread::spawn(move || {
                let frame = format!(r#"{{"protocol":1,"id":"c{i}","cmd":"health","params":{{}}}}"#);
                raw_request(&sock, &frame).expect("concurrent transport")
            })
        })
        .collect();
    for h in handles {
        let resp = h.join().expect("thread");
        assert_ok(&resp);
    }
    let status = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"cs","cmd":"status","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&status);
    assert!(status.get("requests").and_then(|v| v.as_u64()).unwrap_or(0) >= 17);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn concurrent_identical_accepts_yield_one_receipt() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    let socket = d.socket.clone();
    // One lease for all racers (generation fencing is kernel-serial).
    let acquired = raw_request(
        &socket,
        &authed_frame(
            &cap,
            "acquire",
            serde_json::json!({"taskInstanceId": "task-race-1", "backend": "native"}),
        ),
    )
    .expect("acquire");
    assert_ok(&acquired);
    let lease = acquired.get("lease").expect("lease").clone();
    let snapshot = snapshot();
    let resolution = resolution_for("task-race-1", &snapshot);
    let sealed = raw_request(
        &socket,
        &authed_frame(&cap, "seal", serde_json::json!({"resolution": resolution})),
    )
    .expect("seal");
    assert_ok(&sealed);
    let intent = intent_for("task-race-1", "task-race-1-A1", "cmd-race-1");
    let accept_params = serde_json::json!({
        "intent": intent,
        "resolution": resolution,
        "snapshot": snapshot,
        "lease": { "epoch": lease.get("leaseEpoch"), "storeIncarnation": lease.get("storeIncarnation") },
    });
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (sock, capc, params) = (socket.clone(), cap.clone(), accept_params.clone());
            std::thread::spawn(move || {
                raw_request(&sock, &authed_frame(&capc, "accept", params))
                    .expect("accept transport")
            })
        })
        .collect();
    let mut created = 0;
    let mut replayed = 0;
    let mut digest = String::new();
    for h in handles {
        let resp = h.join().expect("thread");
        assert_ok(&resp);
        let was_replay = resp.get("replayed") == Some(&serde_json::Value::Bool(true));
        if was_replay {
            replayed += 1;
        } else {
            created += 1;
        }
        let r = resp.get("receipt").expect("receipt");
        let dg = r
            .get("commandDigest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if digest.is_empty() {
            digest = dg;
        } else {
            assert_eq!(
                digest, dg,
                "all racers observe the same authoritative receipt"
            );
        }
    }
    assert_eq!(created, 1, "exactly one winner");
    assert_eq!(replayed, 7, "every loser replays");
    let status = raw_request(
        &socket,
        r#"{"protocol":1,"id":"rs","cmd":"status","params":{}}"#,
    )
    .expect("status");
    assert_eq!(
        status.get("acceptedCommands").and_then(|v| v.as_i64()),
        Some(1)
    );
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn abrupt_disconnect_does_not_disturb_daemon() {
    let mut d = spawn_daemon("readonly", false);
    // Connect and vanish without sending anything, several times.
    for _ in 0..5 {
        let _ = UnixStream::connect(&d.socket).expect("connect");
    }
    // Half a frame, then vanish.
    {
        let mut s = UnixStream::connect(&d.socket).expect("connect");
        s.write_all(b"{\"protocol\":1,").expect("partial write");
    }
    std::thread::sleep(Duration::from_millis(200));
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"dd","cmd":"health","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&health);
    terminate(&mut d.child);
    let _ = d.child.wait();
}

#[test]
fn status_exposes_required_observability() {
    let mut d = spawn_daemon("shadow-test", true);
    let status = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"ob","cmd":"status","params":{}}"#,
    )
    .expect("transport");
    assert_ok(&status);
    for field in [
        "state",
        "incarnation",
        "ipcProtocol",
        "trustMode",
        "shadowMode",
        "dispatchEnabled",
        "acceptedCommands",
        "eventCount",
        "journalHead",
        "witness",
        "reconciliationRequired",
        "activeClients",
        "requests",
        "refusals",
        "errors",
    ] {
        assert!(
            status.get(field).is_some(),
            "status exposes '{field}': {status}"
        );
    }
    assert_eq!(
        status.get("dispatchEnabled"),
        Some(&serde_json::Value::Bool(false))
    );
    terminate(&mut d.child);
    let _ = d.child.wait();
}
