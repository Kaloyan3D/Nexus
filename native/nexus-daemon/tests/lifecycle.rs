//! Daemon lifecycle: start/ready/stop/restart, second-instance refusal,
//! crash/restart, stale socket recovery, corrupt-database refusal.
//! All tests drive the real `nexusd` binary as a subprocess.

mod common;

use common::*;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn start_ready_stop_reports_lifecycle() {
    let mut d = spawn_daemon("readonly", true);
    let health = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"h","cmd":"health","params":{}}"#,
    )
    .expect("health transport");
    assert_ok(&health);
    assert_eq!(health.get("state").and_then(|v| v.as_str()), Some("ready"));
    assert_eq!(health.get("ipcProtocol").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(
        health.get("dispatchEnabled"),
        Some(&serde_json::Value::Bool(false))
    );
    assert!(health.get("incarnation").and_then(|v| v.as_str()).is_some());
    let status = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"s","cmd":"status","params":{}}"#,
    )
    .expect("status transport");
    assert_ok(&status);
    assert_eq!(status.get("state").and_then(|v| v.as_str()), Some("ready"));
    assert_eq!(
        status.get("trustMode").and_then(|v| v.as_str()),
        Some("readonly")
    );
    assert_eq!(
        status.get("shadowMode").and_then(|v| v.as_str()),
        Some("shadow-only")
    );
    assert_eq!(
        status.get("reconciliationRequired"),
        Some(&serde_json::Value::Bool(false))
    );
    assert_eq!(
        status.get("acceptedCommands").and_then(|v| v.as_i64()),
        Some(0)
    );
    // Graceful SIGTERM: terminate() waits for exit; the socket file is removed.
    let socket = d.socket.clone();
    terminate(&mut d.child);
    let deadline = Instant::now() + Duration::from_secs(5);
    while socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(!socket.exists(), "graceful stop removes the socket file");
}

#[test]
fn restart_with_existing_state_preserves_receipts() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    let accepted = accept_one(
        &d.socket,
        &cap,
        "task-restart-1",
        "task-restart-1-A1",
        "cmd-restart-1",
    );
    let first_receipt = accepted.get("receipt").expect("receipt").clone();
    let socket = d.socket.clone();
    let db = d.db.clone();
    let witness = d.witness.clone();
    let cap_path = d.cap.clone();
    terminate(&mut d.child);
    let _ = d.child.wait();
    // Restart on the SAME DataRoot (fresh process, same paths).
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&db)
        .arg("--socket")
        .arg(&socket)
        .arg("--cap")
        .arg(&cap_path)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&witness)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("restart nexusd");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            &socket,
            r#"{"protocol":1,"id":"rp","cmd":"health","params":{}}"#,
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                break;
            }
        }
        if Instant::now() > deadline {
            terminate(&mut child);
            panic!("restarted daemon never became ready");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // The authoritative receipt survived the restart byte-identically.
    let reread = raw_request(
        &socket,
        r#"{"protocol":1,"id":"rr","cmd":"receipt","params":{"commandId":"cmd-restart-1"}}"#,
    )
    .expect("receipt transport");
    assert_ok(&reread);
    assert_eq!(reread.get("receipt"), Some(&first_receipt));
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn second_instance_is_refused() {
    let mut first = spawn_daemon("readonly", true);
    // Same DataRoot AND same socket: must fail closed, fast.
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(&first.db)
        .arg("--socket")
        .arg(&first.socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("second daemon runs");
    assert!(!out.status.success(), "second daemon must not start");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("daemon-already-running"),
        "second instance names the refusal: {stderr}"
    );
    // The first daemon is unaffected.
    let health = raw_request(
        &first.socket,
        r#"{"protocol":1,"id":"h2","cmd":"health","params":{}}"#,
    )
    .expect("health transport");
    assert_ok(&health);
    terminate(&mut first.child);
    let _ = first.child.wait();
}

#[test]
fn crash_restart_recovers_and_reclaims_stale_socket() {
    let mut d = spawn_daemon("shadow-test", true);
    let cap = read_cap(&d.cap);
    let accepted = accept_one(
        &d.socket,
        &cap,
        "task-crash-1",
        "task-crash-1-A1",
        "cmd-crash-1",
    );
    let first_receipt = accepted.get("receipt").expect("receipt").clone();
    let socket = d.socket.clone();
    assert!(socket.exists());
    // SIGKILL: no graceful cleanup; the socket file is left stale.
    crash(&mut d.child);
    assert!(socket.exists(), "crash leaves the socket file stale");
    // A new daemon reclaims the stale socket and serves durable state.
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&d.db)
        .arg("--socket")
        .arg(&socket)
        .arg("--cap")
        .arg(&d.cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&d.witness)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("restart after crash");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            &socket,
            r#"{"protocol":1,"id":"rc","cmd":"health","params":{}}"#,
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                break;
            }
        }
        if Instant::now() > deadline {
            terminate(&mut child);
            panic!("post-crash daemon never became ready (stale socket not reclaimed)");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let reread = raw_request(
        &socket,
        r#"{"protocol":1,"id":"rc2","cmd":"receipt","params":{"commandId":"cmd-crash-1"}}"#,
    )
    .expect("receipt transport");
    assert_ok(&reread);
    assert_eq!(reread.get("receipt"), Some(&first_receipt));
    terminate(&mut child);
    let _ = child.wait();
}

#[test]
fn corrupt_database_refuses_startup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("k.db");
    std::fs::write(&db, b"this is not a sqlite database at all").expect("write garbage");
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(&db)
        .arg("--socket")
        .arg(dir.path().join("n.sock"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("daemon runs");
    assert!(!out.status.success(), "corrupt store must refuse startup");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("store-corrupt"),
        "corruption is named explicitly: {stderr}"
    );
}

#[test]
fn incompatible_schema_refuses_startup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("k.db");
    // Initialize a real store through the kernel binary, then forge a
    // future schema version directly in SQLite.
    let init = Command::new(kernel_bin())
        .arg("init")
        .arg("--db")
        .arg(&db)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("kernel init runs");
    assert!(init.status.success(), "kernel init works");
    {
        let conn = rusqlite::Connection::open(&db).expect("open db");
        conn.execute("UPDATE schema_version SET version = 99", [])
            .expect("forge version");
    }
    let out = Command::new(nexusd_bin())
        .arg("--db")
        .arg(&db)
        .arg("--socket")
        .arg(dir.path().join("n.sock"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("daemon runs");
    assert!(
        !out.status.success(),
        "incompatible schema must refuse startup"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("store-incompatible"),
        "incompatibility is named explicitly: {stderr}"
    );
}

#[test]
fn fresh_dataroot_starts_clean() {
    let mut d = spawn_daemon("readonly", false);
    let status = raw_request(
        &d.socket,
        r#"{"protocol":1,"id":"f","cmd":"status","params":{}}"#,
    )
    .expect("status transport");
    assert_ok(&status);
    assert_eq!(
        status.get("acceptedCommands").and_then(|v| v.as_i64()),
        Some(0)
    );
    assert_eq!(status.get("eventCount").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(
        status.get("witness").and_then(|v| v.get("configured")),
        Some(&serde_json::Value::Bool(false))
    );
    terminate(&mut d.child);
    let _ = d.child.wait();
}
