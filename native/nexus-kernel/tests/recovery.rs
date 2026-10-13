mod common;
use common::{accept, code_of, handshake, reopen, setup, snapshot};
use nexus_contracts::KernelEventKind;
use nexus_kernel::AcceptRequest;

fn backup_db(paths: &common::Paths) -> tempfile::TempDir {
    let backup = tempfile::tempdir().expect("backup dir");
    for suffix in ["", "-wal", "-shm"] {
        let src = std::path::PathBuf::from([paths.db.to_string_lossy().as_ref(), suffix].concat());
        if src.exists() {
            std::fs::copy(&src, backup.path().join(src.file_name().unwrap())).unwrap();
        }
    }
    backup
}

fn restore_db(paths: &common::Paths, backup: &tempfile::TempDir) {
    for suffix in ["", "-wal", "-shm"] {
        let dst = std::path::PathBuf::from([paths.db.to_string_lossy().as_ref(), suffix].concat());
        let _ = std::fs::remove_file(&dst);
    }
    for entry in std::fs::read_dir(backup.path()).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(
            entry.path(),
            paths.db.parent().unwrap().join(entry.file_name()),
        )
        .unwrap();
    }
}

#[test]
fn deterministic_reconstruction() {
    let (mut kernel, paths) = setup("rec-reconstruct");
    let (i1, s1, snap1) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    accept(&mut kernel, i1, s1, snap1);
    let (i2, s2, snap2) = handshake(&mut kernel, "task-1", "attempt-2", "cmd-2");
    accept(&mut kernel, i2, s2, snap2);
    drop(kernel);
    let kernel = reopen(&paths, true);
    let state = kernel.reconstruct("task-1", "native").expect("reconstruct");
    assert_eq!(state.epoch, 2);
    assert_eq!(state.receipts.len(), 2);
    let kinds: Vec<KernelEventKind> = state.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            KernelEventKind::GenerationAcquired,
            KernelEventKind::CommandAccepted,
            KernelEventKind::GenerationAcquired,
            KernelEventKind::CommandAccepted
        ]
    );
    let mut last = 0;
    for e in &state.events {
        assert!(e.seq > last);
        last = e.seq;
    }
}

#[test]
fn dispatch_is_never_authorized() {
    let (mut kernel, _p) = setup("rec-dispatch");
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    let (receipt, _) = accept(&mut kernel, intent, issued, snap);
    assert_eq!(
        receipt.status,
        nexus_contracts::ReceiptStatus::AcceptedReservedDispatchDisabled
    );
    let result = kernel.authorize_dispatch(&receipt.command_id);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code.as_str(), "dispatch-disabled");
}

#[test]
fn witness_loss_and_downgrade_refused() {
    let (mut kernel, paths) = setup("rec-witness");
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    accept(&mut kernel, intent, issued, snap);
    drop(kernel);
    std::fs::remove_file(&paths.witness).unwrap();
    let mut orphaned = reopen(&paths, true);
    let acquire = orphaned.acquire_generation("task-1", "native");
    assert!(acquire.is_err());
    assert_eq!(
        acquire.unwrap_err().code.as_str(),
        "reconciliation-required"
    );
    let mut downgraded = reopen(&paths, false);
    let acquire2 = downgraded.acquire_generation("task-1", "native");
    assert!(acquire2.is_err());
    assert_eq!(acquire2.unwrap_err().code.as_str(), "witness-required");
}

#[test]
fn corrupt_witness_fails_closed() {
    let (mut kernel, paths) = setup("rec-corrupt-w");
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    accept(&mut kernel, intent, issued, snap);
    drop(kernel);
    std::fs::write(&paths.witness, b"corrupted witness bytes").unwrap();
    match nexus_kernel::Kernel::open(&paths.db, Some(&paths.witness)) {
        Err(e) => assert_eq!(e.code.as_str(), "reconciliation-required"),
        Ok(mut kernel) => {
            let lease = kernel.acquire_generation("task-1", "native");
            assert!(lease.is_err(), "corrupt witness must fail closed");
            assert_eq!(lease.unwrap_err().code.as_str(), "reconciliation-required");
        }
    }
}
#[test]
fn rollback_detected_and_fenced_recovery() {
    let (mut kernel, paths) = setup("rec-rollback");
    let epoch1 = kernel.acquire_generation("task-1", "native").unwrap();
    assert_eq!(epoch1.lease_epoch, 1);
    let pre_epoch2 = backup_db(&paths);
    let epoch2 = kernel.acquire_generation("task-1", "native").unwrap();
    assert_eq!(epoch2.lease_epoch, 2);
    let intent2 = common::make_intent("task-1", "attempt-2", "cmd-2")
        .with_lease(epoch2.lease_epoch, &epoch2.store_incarnation);
    let snap = snapshot();
    let issued2 = common::make_issued(&mut kernel, "task-1", &snap);
    accept(&mut kernel, intent2.clone(), issued2.clone(), snap.clone());
    drop(kernel);
    restore_db(&paths, &pre_epoch2);
    let mut restored = reopen(&paths, true);
    restored
        .seal_issuance(&issued2)
        .expect("re-seal after restore");
    let replay = restored.accept_command(&AcceptRequest {
        intent: intent2,
        issued: issued2,
        snapshot: snap,
    });
    assert_eq!(code_of(&replay), "rollback-detected");
    let lease = restored
        .fence_for_recovery("task-1", "native", 2, "operator-attestation-test-1")
        .expect("fenced recovery");
    assert!(lease.lease_epoch >= 3, "never re-issues fenced epochs");
    let stale =
        common::make_intent("task-1", "attempt-3", "cmd-3").with_lease(2, &lease.store_incarnation);
    let snap3 = snapshot();
    let issued3 = common::make_issued(&mut restored, "task-1", &snap3);
    let result = restored.accept_command(&AcceptRequest {
        intent: stale,
        issued: issued3,
        snapshot: snap3,
    });
    assert_eq!(code_of(&result), "stale-lease");
    let fresh = common::make_intent("task-1", "attempt-4", "cmd-4")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snap4 = snapshot();
    let issued4 = common::make_issued(&mut restored, "task-1", &snap4);
    let (receipt, created) = accept(&mut restored, fresh, issued4, snap4);
    assert!(created);
    assert_eq!(receipt.lease_epoch, lease.lease_epoch);
}

#[test]
fn same_lease_receipt_loss_requires_reconciliation() {
    let (mut kernel, paths) = setup("rec-samelease");
    let lease = kernel.acquire_generation("task-1", "native").unwrap();
    let pre_accept = backup_db(&paths);
    let intent = common::make_intent("task-1", "attempt-1", "cmd-1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snap = snapshot();
    let issued = common::make_issued(&mut kernel, "task-1", &snap);
    accept(&mut kernel, intent.clone(), issued.clone(), snap.clone());
    drop(kernel);
    restore_db(&paths, &pre_accept);
    let mut restored = reopen(&paths, true);
    restored
        .seal_issuance(&issued)
        .expect("re-seal after restore");
    let replay = restored.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&replay), "reconciliation-required");
    assert_eq!(restored.count_receipts().unwrap(), 0);
}

#[test]
fn binary_has_no_effect_surface() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let src = std::fs::read_to_string(std::path::Path::new(manifest).join("src").join("main.rs"))
        .expect("main.rs readable");
    for forbidden in [
        "Command::new",
        "TcpStream",
        "TcpListener",
        "UdpSocket",
        "std::net",
        "reqwest",
        "tokio",
        ".spawn(",
        "libloading",
        "dlopen",
        "exec(",
    ] {
        assert!(
            !src.contains(forbidden),
            "binary must not contain {forbidden}"
        );
    }
    let build = std::process::Command::new("cargo")
        .args(["build", "--bin", "nexus-kernel"])
        .current_dir(manifest)
        .output()
        .expect("cargo build bin");
    assert!(build.status.success());
    let exe = [manifest, "/../target/debug/nexus-kernel"].concat();
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("cli.db");
    let out = std::process::Command::new(&exe)
        .args(["init", "--db", &db.to_string_lossy()])
        .output()
        .expect("run init");
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("dispatch_enabled=false"),
        "binary reports dispatch disabled"
    );
    let out = std::process::Command::new(&exe)
        .args(["status", "--db", &db.to_string_lossy()])
        .output()
        .expect("run status");
    assert!(out.status.success());
}
