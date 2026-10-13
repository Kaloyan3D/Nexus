mod common;
use common::{accept, handshake, reopen, setup};

#[test]
fn restart_preserves_receipts_and_ordering() {
    let (mut kernel, paths) = setup("dur-restart");
    let mut digests = Vec::new();
    for i in 1..=3 {
        let task = ["task-", &i.to_string()].concat();
        let attempt = ["attempt-", &i.to_string()].concat();
        let command = ["cmd-", &i.to_string()].concat();
        let (intent, issued, snap) = handshake(&mut kernel, &task, &attempt, &command);
        let (receipt, created) = accept(&mut kernel, intent, issued, snap);
        assert!(created);
        digests.push((command, receipt.command_digest, receipt.event_seq));
    }
    let before = kernel.list_all_events().unwrap();
    drop(kernel);
    let after_restart = reopen(&paths, true);
    assert_eq!(after_restart.count_receipts().unwrap(), 3);
    let after = after_restart.list_all_events().unwrap();
    assert_eq!(
        before, after,
        "event journal survives restart byte-identical"
    );
    let mut last_seq = 0;
    for e in &after {
        assert!(e.seq > last_seq);
        last_seq = e.seq;
    }
    for (command, digest, _seq) in &digests {
        let r = after_restart
            .read_receipt(command)
            .unwrap()
            .expect("receipt survives");
        assert_eq!(&r.command_digest, digest);
    }
}

#[test]
fn refused_commands_leave_no_trace() {
    let (mut kernel, _p) = setup("dur-clean");
    let (_i, _s, _snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    let lease = kernel.acquire_generation("task-2", "native").unwrap();
    let bad = common::make_intent("task-2", "attempt-1", "cmd-2")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snap = common::snapshot();
    let forged = common::make_issued(&mut kernel, "task-9", &snap);
    let result = kernel.accept_command(&nexus_kernel::AcceptRequest {
        intent: bad,
        issued: forged,
        snapshot: snap,
    });
    assert_eq!(common::code_of(&result), "generation-mismatch");
    assert_eq!(kernel.count_commands().unwrap(), 0);
    assert_eq!(kernel.count_receipts().unwrap(), 0);
    let generations_only: Vec<_> = kernel
        .list_all_events()
        .unwrap()
        .into_iter()
        .filter(|e| e.kind != nexus_contracts::KernelEventKind::GenerationAcquired)
        .collect();
    assert!(
        generations_only.is_empty(),
        "refused commands journal nothing"
    );
}

#[test]
fn corrupt_store_fails_closed() {
    let (_kernel, paths) = setup("dur-corrupt");
    drop(_kernel);
    std::fs::write(&paths.db, b"this is not a sqlite database at all").unwrap();
    let result = nexus_kernel::Kernel::open(&paths.db, Some(&paths.witness));
    assert!(result.is_err());
    let code = result.err().expect("must fail").code;
    assert!(
        code == nexus_contracts::KernelErrorCode::StoreCorrupt
            || code == nexus_contracts::KernelErrorCode::ReconciliationRequired,
        "unexpected {code:?}"
    );
}

#[test]
fn incompatible_schema_fails_closed() {
    let (mut kernel, paths) = setup("dur-incompat");
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    accept(&mut kernel, intent, issued, snap);
    drop(kernel);
    bump_schema_version(&paths.db, 99);
    let result = nexus_kernel::Kernel::open(&paths.db, Some(&paths.witness));
    assert!(result.is_err());
    assert_eq!(
        result.err().expect("must fail").code,
        nexus_contracts::KernelErrorCode::StoreIncompatible
    );
}

#[test]
fn sigkill_mid_loop_leaves_only_complete_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("kill.db");
    let witness = dir.path().join("kill.witness.db");
    let manifest = env!("CARGO_MANIFEST_DIR");
    let build = std::process::Command::new("cargo")
        .args(["build", "--example", "crash_writer"])
        .current_dir(manifest)
        .output()
        .expect("cargo build example");
    assert!(
        build.status.success(),
        "example builds: {}",
        String::from_utf8_lossy(&build.stderr)
    );
    let exe = target_example(manifest, "crash_writer");
    let mut child = std::process::Command::new(&exe)
        .args([
            "--db",
            &db.to_string_lossy(),
            "--witness",
            &witness.to_string_lossy(),
            "--task",
            "killtask",
            "--n",
            "2000",
        ])
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("spawn writer");
    std::thread::sleep(std::time::Duration::from_millis(400));
    child.kill().expect("SIGKILL writer");
    let _ = child.wait();
    let kernel =
        nexus_kernel::Kernel::open(&db, Some(&witness)).expect("store opens after SIGKILL");
    assert_eq!(
        kernel.count_commands().unwrap(),
        kernel.count_receipts().unwrap()
    );
    let events = kernel.list_all_events().unwrap();
    let mut last_seq = 0;
    for e in &events {
        assert!(e.seq > last_seq, "event order survives SIGKILL");
        last_seq = e.seq;
    }
    let state = kernel
        .reconstruct("killtask", "native")
        .expect("reconstruction works after SIGKILL");
    assert_eq!(
        state.receipts.len() as i64,
        kernel.count_receipts().unwrap()
    );
    for r in &state.receipts {
        let again = kernel
            .read_receipt(&r.command_id)
            .unwrap()
            .expect("receipt present");
        assert_eq!(&again, r);
    }
}

#[test]
fn concurrent_processes_agree_on_one_authority() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("xproc.db");
    let witness = dir.path().join("xproc.witness.db");
    let manifest = env!("CARGO_MANIFEST_DIR");
    let build = std::process::Command::new("cargo")
        .args(["build", "--example", "crash_writer"])
        .current_dir(manifest)
        .output()
        .expect("cargo build example");
    assert!(build.status.success());
    let exe = target_example(manifest, "crash_writer");
    let mut children = Vec::new();
    for worker in 0..4 {
        let task = ["xtask-", &worker.to_string()].concat();
        let child = std::process::Command::new(&exe)
            .args([
                "--db",
                &db.to_string_lossy(),
                "--witness",
                &witness.to_string_lossy(),
                "--task",
                &task,
                "--n",
                "25",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn writer");
        children.push(child);
    }
    for mut child in children {
        let status = child.wait().expect("wait writer");
        assert!(status.success(), "writer exits clean");
    }
    let kernel = nexus_kernel::Kernel::open(&db, Some(&witness)).expect("open after xproc");
    assert_eq!(kernel.count_commands().unwrap(), 100);
    assert_eq!(kernel.count_receipts().unwrap(), 100);
    for worker in 0..4 {
        let task = ["xtask-", &worker.to_string()].concat();
        let state = kernel
            .reconstruct(&task, "native")
            .expect("reconstruct generation");
        assert_eq!(state.epoch, 25);
        assert_eq!(state.receipts.len(), 25);
    }
}

fn target_example(manifest: &str, name: &str) -> std::path::PathBuf {
    let debug = std::path::Path::new(manifest)
        .join("..")
        .join("target")
        .join("debug")
        .join("examples")
        .join(name);
    if debug.exists() {
        return debug;
    }
    std::path::Path::new(manifest)
        .join("..")
        .join("target")
        .join("release")
        .join("examples")
        .join(name)
}
fn bump_schema_version(db: &std::path::Path, version: i64) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.execute(
        "UPDATE schema_version SET version = ?1",
        rusqlite::params![version],
    )
    .unwrap();
}
