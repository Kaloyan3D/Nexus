//! A2.0 Gate 1 + Gate 5 crash-safety and readiness regression tests.
//!
//! Two independently restorable storage roots (main store files vs witness
//! file) model separate failure domains. Every durability transition is
//! crashed or rolled back: prepare-without-commit, commit-without-ack,
//! full acknowledgement, and complete main-store restore with an intact
//! witness. A restored pre-acceptance backup must never silently authorize
//! duplicate dispatch -- unknown outcomes suspend or reconcile, and
//! `dispatch_enabled()` stays false throughout.

mod common;
use common::{accept, code_of, handshake, make_intent, make_issued, reopen, setup, snapshot};
use nexus_kernel::AcceptRequest;
use nexus_store::{Store, WitnessStore};

fn copy_main_db(src_db: &std::path::Path, dst_dir: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let src = std::path::PathBuf::from([src_db.to_string_lossy().as_ref(), suffix].concat());
        if src.exists() {
            std::fs::copy(&src, dst_dir.join(src.file_name().unwrap())).unwrap();
        }
    }
}

fn restore_main_db(db: &std::path::Path, backup: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let dst = std::path::PathBuf::from([db.to_string_lossy().as_ref(), suffix].concat());
        let _ = std::fs::remove_file(&dst);
    }
    for entry in std::fs::read_dir(backup).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), db.parent().unwrap().join(entry.file_name())).unwrap();
    }
}

fn digests_for(
    intent: &nexus_contracts::ControllerIntentV1,
    issued: &nexus_contracts::RegistryResolutionV1,
    snapshot: &serde_json::Value,
    epoch: u64,
    incarnation: &str,
) -> (String, String, String) {
    let target_value = serde_json::to_value(&issued.target).expect("target value");
    let target_digest = nexus_contracts::target_digest_of(&target_value);
    let snapshot_digest = nexus_contracts::snapshot_digest_of(snapshot);
    let command_digest = nexus_contracts::command_digest_of(
        &intent.intent_digest,
        &target_digest,
        &snapshot_digest,
        epoch,
        incarnation,
    );
    (target_digest, snapshot_digest, command_digest)
}

#[test]
fn p1_prepare_without_commit_heals_on_identical_replay() {
    // Crash point P1: witness reservation landed, main-store commit never
    // ran. The command must not be dispatchable, and an identical replay
    // must heal to a single acknowledged receipt.
    let (mut kernel, paths) = setup("a20-p1");
    let lease = kernel.acquire_generation("task-p1", "native").unwrap();
    let mut intent = make_intent("task-p1", "attempt-1", "cmd-p1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snap = snapshot();
    let issued = make_issued(&mut kernel, "task-p1", &snap);
    let (_td, _sd, cmd_digest) = digests_for(
        &intent,
        &issued,
        &snap,
        lease.lease_epoch,
        &lease.store_incarnation,
    );
    let issuance = issued.provenance.issuance_id.clone();
    drop(kernel);
    // Simulate the crash: reservation only, no store commit.
    let mut witness = WitnessStore::open(&paths.witness).unwrap();
    let res = witness
        .prepare_reservation(
            &nexus_contracts::generation_key("task-p1", "native"),
            "task-p1",
            "attempt-1",
            "cmd-p1",
            lease.lease_epoch,
            &lease.store_incarnation,
            &cmd_digest,
            &issuance,
        )
        .expect("prepare");
    assert_eq!(res.state, nexus_store::ReservationState::Prepared);
    drop(witness);
    // No receipt exists; dispatch stays disabled and readiness is NOT_READY.
    let mut kernel = reopen(&paths, true);
    assert!(kernel.read_receipt("cmd-p1").unwrap().is_none());
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
    assert!(kernel.authorize_dispatch("cmd-p1").is_err());
    let readiness = kernel.dispatch_readiness(Some("cmd-p1"));
    assert_eq!(readiness.verdict, "NOT_READY");
    assert!(!readiness.ready);
    assert_eq!(
        readiness.dimension_ready("dispatch-reservation"),
        Some(false)
    );
    // Identical replay heals to exactly one acknowledged receipt.
    intent = make_intent("task-p1", "attempt-1", "cmd-p1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let (receipt, created) = accept(&mut kernel, intent, issued, snap);
    assert!(created);
    assert_eq!(
        receipt.status,
        nexus_contracts::ReceiptStatus::AcceptedReservedDispatchDisabled
    );
    let res = kernel
        .read_reservation("cmd-p1")
        .unwrap()
        .expect("reservation");
    assert_eq!(res.state, nexus_store::ReservationState::Acknowledged);
    assert_eq!(kernel.count_receipts().unwrap(), 1);
}

#[test]
fn p1_conflicting_binding_is_never_reaccepted() {
    // Same commandId with any differing immutable field fails closed and
    // preserves the prepared authority.
    let (mut kernel, paths) = setup("a20-p1conflict");
    let lease = kernel.acquire_generation("task-c", "native").unwrap();
    let snap = snapshot();
    let issued = make_issued(&mut kernel, "task-c", &snap);
    let intent = make_intent("task-c", "attempt-1", "cmd-c")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let (_td, _sd, cmd_digest) = digests_for(
        &intent,
        &issued,
        &snap,
        lease.lease_epoch,
        &lease.store_incarnation,
    );
    let issuance = issued.provenance.issuance_id.clone();
    drop(kernel);
    let mut witness = WitnessStore::open(&paths.witness).unwrap();
    witness
        .prepare_reservation(
            &nexus_contracts::generation_key("task-c", "native"),
            "task-c",
            "attempt-1",
            "cmd-c",
            lease.lease_epoch,
            &lease.store_incarnation,
            &cmd_digest,
            &issuance,
        )
        .unwrap();
    // A forged digest under the same commandId is a conflict, not a heal.
    let bad = witness.prepare_reservation(
        &nexus_contracts::generation_key("task-c", "native"),
        "task-c",
        "attempt-1",
        "cmd-c",
        lease.lease_epoch,
        &lease.store_incarnation,
        &"00".repeat(32),
        &issuance,
    );
    assert_eq!(bad.unwrap_err().code.as_str(), "command-conflict");
    drop(witness);
}

#[test]
fn p2_commit_without_ack_heals_on_identical_replay() {
    // Crash point P2: main-store commit landed, witness acknowledgement did
    // not. The next identical replay must converge to one receipt and heal
    // the witness -- never to a conflict, never to two receipts.
    let (mut kernel, paths) = setup("a20-p2");
    let lease = kernel.acquire_generation("task-p2", "native").unwrap();
    let intent = make_intent("task-p2", "attempt-1", "cmd-p2")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snap = snapshot();
    let issued = make_issued(&mut kernel, "task-p2", &snap);
    let target_value = serde_json::to_value(&issued.target).unwrap();
    let (target_digest, snapshot_digest, command_digest) = digests_for(
        &intent,
        &issued,
        &snap,
        lease.lease_epoch,
        &lease.store_incarnation,
    );
    let issuance = issued.provenance.issuance_id.clone();
    drop(kernel);
    // Drive the two commits separately: reservation + store commit, no ack.
    let mut witness = WitnessStore::open(&paths.witness).unwrap();
    witness
        .prepare_reservation(
            &nexus_contracts::generation_key("task-p2", "native"),
            "task-p2",
            "attempt-1",
            "cmd-p2",
            lease.lease_epoch,
            &lease.store_incarnation,
            &command_digest,
            &issuance,
        )
        .unwrap();
    drop(witness);
    let mut store = Store::open(&paths.db).unwrap();
    let outcome = store
        .accept_command(&nexus_store::AcceptInput {
            command_id: "cmd-p2".to_owned(),
            task_instance_id: "task-p2".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            backend: "native".to_owned(),
            controller_revision: 1,
            role: "muse_main".to_owned(),
            mode_id: "engineering-v2".to_owned(),
            mode_config_revision_json: "3".to_owned(),
            payload_json: serde_json::to_string(&serde_json::json!({"op": "engineer-turn"}))
                .unwrap(),
            payload_digest: intent.payload_digest.clone(),
            intent_digest: intent.intent_digest.clone(),
            target_json: serde_json::to_string(&target_value).unwrap(),
            snapshot_digest,
            target_digest,
            issuance_id: issuance,
            lease_epoch: lease.lease_epoch,
            store_incarnation: lease.store_incarnation.clone(),
            command_digest: command_digest.clone(),
        })
        .expect("store commit");
    assert!(outcome.created);
    drop(store);
    // P2 state: receipt without acknowledgement. Identical replay heals.
    let mut kernel = reopen(&paths, true);
    let res = kernel
        .read_reservation("cmd-p2")
        .unwrap()
        .expect("prepared");
    assert_eq!(res.state, nexus_store::ReservationState::Prepared);
    let intent2 = make_intent("task-p2", "attempt-1", "cmd-p2")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let result = kernel.accept_command(&AcceptRequest {
        intent: intent2,
        issued,
        snapshot: snap,
    });
    let (receipt, created) = result.expect("heal");
    assert!(!created, "P2 heal is a replay, not a second acceptance");
    assert_eq!(receipt.command_digest, command_digest);
    let res = kernel.read_reservation("cmd-p2").unwrap().expect("acked");
    assert_eq!(res.state, nexus_store::ReservationState::Acknowledged);
    assert_eq!(kernel.count_receipts().unwrap(), 1);
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
}

#[test]
fn full_restore_with_intact_witness_never_silently_reauthorizes() {
    // Complete main-store restore with an intact witness: the acknowledged
    // command lost its receipt, so the outcome is explicitly unknown and
    // re-acceptance is refused -- never a silent duplicate dispatch.
    let (mut kernel, paths) = setup("a20-restore");
    let backup_dir = tempfile::tempdir().unwrap();
    copy_main_db(&paths.db, backup_dir.path());
    let (intent, issued, snap) = handshake(&mut kernel, "task-r", "attempt-1", "cmd-r");
    let (receipt, created) = accept(&mut kernel, intent.clone(), issued.clone(), snap.clone());
    assert!(created);
    let digest = receipt.command_digest.clone();
    drop(kernel);
    restore_main_db(&paths.db, backup_dir.path());
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
    // The witness still names the acknowledgement; replay protection holds.
    let res = restored
        .read_reservation("cmd-r")
        .unwrap()
        .expect("reservation");
    assert_eq!(res.state, nexus_store::ReservationState::Acknowledged);
    assert_eq!(res.command_digest, digest);
    let readiness = restored.dispatch_readiness(Some("cmd-r"));
    assert_eq!(readiness.verdict, "NOT_READY");
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
    assert!(restored.authorize_dispatch("cmd-r").is_err());
}

#[test]
fn abandoned_reservations_never_invent_success() {
    // Expiry moves prepared -> abandoned; acknowledgement of an abandoned
    // reservation refuses; identical re-preparation re-arms without ever
    // having claimed success, and a later accept creates exactly one receipt.
    let (mut kernel, paths) = setup("a20-abandon");
    let lease = kernel.acquire_generation("task-a", "native").unwrap();
    let snap = snapshot();
    let issued = make_issued(&mut kernel, "task-a", &snap);
    let intent = make_intent("task-a", "attempt-1", "cmd-a")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let (_td, _sd, cmd_digest) = digests_for(
        &intent,
        &issued,
        &snap,
        lease.lease_epoch,
        &lease.store_incarnation,
    );
    let issuance = issued.provenance.issuance_id.clone();
    drop(kernel);
    let mut witness = WitnessStore::open(&paths.witness).unwrap();
    witness
        .prepare_reservation(
            &nexus_contracts::generation_key("task-a", "native"),
            "task-a",
            "attempt-1",
            "cmd-a",
            lease.lease_epoch,
            &lease.store_incarnation,
            &cmd_digest,
            &issuance,
        )
        .unwrap();
    let reaped = witness.reap_abandoned(0).expect("reap");
    assert_eq!(reaped, 1);
    let res = witness.read_reservation("cmd-a").unwrap().expect("row");
    assert_eq!(res.state, nexus_store::ReservationState::Abandoned);
    let ack = witness.acknowledge_reservation("cmd-a", &cmd_digest, lease.lease_epoch);
    assert_eq!(ack.unwrap_err().code.as_str(), "reservation-expired");
    drop(witness);
    // Identical accept re-arms and commits exactly once.
    let mut kernel = reopen(&paths, true);
    let intent2 = make_intent("task-a", "attempt-1", "cmd-a")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let (receipt, created) = accept(&mut kernel, intent2, issued, snap);
    assert!(created);
    assert_eq!(receipt.command_digest, cmd_digest);
    let res = kernel.read_reservation("cmd-a").unwrap().expect("acked");
    assert_eq!(res.state, nexus_store::ReservationState::Acknowledged);
}

#[test]
fn retention_never_erases_replay_protection() {
    // Pruning deletes only abandoned rows; acknowledged reservations and
    // accepted-map entries survive, so replay protection is never erased.
    let (mut kernel, paths) = setup("a20-retain");
    let (intent, issued, snap) = handshake(&mut kernel, "task-t", "attempt-1", "cmd-t");
    accept(&mut kernel, intent, issued, snap);
    let lease2 = kernel.acquire_generation("task-t", "native").unwrap();
    let snap2 = snapshot();
    let issued2 = make_issued(&mut kernel, "task-t", &snap2);
    let intent2 = make_intent("task-t", "attempt-2", "cmd-doomed")
        .with_lease(lease2.lease_epoch, &lease2.store_incarnation);
    let (_td, _sd, doomed_digest) = digests_for(
        &intent2,
        &issued2,
        &snap2,
        lease2.lease_epoch,
        &lease2.store_incarnation,
    );
    let issuance2 = issued2.provenance.issuance_id.clone();
    drop(kernel);
    let mut witness = WitnessStore::open(&paths.witness).unwrap();
    witness
        .prepare_reservation(
            &nexus_contracts::generation_key("task-t", "native"),
            "task-t",
            "attempt-2",
            "cmd-doomed",
            lease2.lease_epoch,
            &lease2.store_incarnation,
            &doomed_digest,
            &issuance2,
        )
        .unwrap();
    assert_eq!(witness.reap_abandoned(0).unwrap(), 1);
    let removed = witness.delete_abandoned(0).expect("prune");
    assert_eq!(removed, 1);
    // Acknowledged reservation and accepted entry for cmd-t are untouched.
    let res = witness.read_reservation("cmd-t").unwrap().expect("kept");
    assert_eq!(res.state, nexus_store::ReservationState::Acknowledged);
    assert!(witness.read_reservation("cmd-doomed").unwrap().is_none());
    drop(witness);
    // Conflicting reuse of the protected commandId still fails.
    let mut kernel = reopen(&paths, true);
    let (intent3, issued3, snap3) = handshake(&mut kernel, "task-t", "attempt-9", "cmd-t");
    let conflict = kernel.accept_command(&AcceptRequest {
        intent: intent3,
        issued: issued3,
        snapshot: snap3,
    });
    assert_eq!(code_of(&conflict), "command-conflict");
}

#[test]
fn recovery_attestation_is_verified_not_trusted() {
    // A2.0 Gate 4: the operator number is checked against independent
    // evidence. Asserting a maximum below the witness maximum fails closed
    // instead of silently blessing a forgotten issuance; a trivial
    // attestation string is refused instead of recorded as assurance.
    let (mut kernel, _paths) = setup("a20-attest");
    let _e1 = kernel.acquire_generation("task-f", "native").unwrap();
    let _e2 = kernel.acquire_generation("task-f", "native").unwrap();
    // Witness maximum is 2: attesting 1 must fail, not fence.
    let low = kernel.fence_for_recovery(
        "task-f",
        "native",
        1,
        "operator eve reviewed witness log, reason rotation",
    );
    assert_eq!(low.unwrap_err().code.as_str(), "reconciliation-required");
    // Trivial attestation strings are refused even with a valid maximum.
    for bad in ["", "   ", "short", "ok-123"] {
        let r = kernel.fence_for_recovery("task-f", "native", 2, bad);
        assert_eq!(
            r.unwrap_err().code.as_str(),
            "delivery-invalid",
            "attestation {bad:?} must be refused"
        );
    }
    // A well-evidenced attestation covering the known maximum fences
    // forward only, and the decision is durably auditable.
    let lease = kernel
        .fence_for_recovery(
            "task-f",
            "native",
            2,
            "operator eve reviewed witness max 2, reason rotation",
        )
        .expect("fence");
    assert!(lease.lease_epoch >= 3, "never re-issues fenced epochs");
    let audit = kernel.recovery_audit("task-f", "native").expect("audit");
    assert_eq!(audit.len(), 1);
    assert_eq!(
        audit[0]["baseline"]["fencedEpoch"],
        serde_json::json!(lease.lease_epoch)
    );
    assert_eq!(
        audit[0]["baseline"]["previousWitnessMax"],
        serde_json::json!(2)
    );
    // A second fence can only move forward: the previously fenced epoch is
    // now the witness maximum, so re-attesting the old maximum is refused
    // and only a fresh attestation covering the new maximum fences onward.
    let stale = kernel.fence_for_recovery(
        "task-f",
        "native",
        2,
        "operator eve second review, reason rotation",
    );
    assert_eq!(stale.unwrap_err().code.as_str(), "reconciliation-required");
    let lease2 = kernel
        .fence_for_recovery(
            "task-f",
            "native",
            lease.lease_epoch,
            "operator eve second review of fenced epoch, reason rotation",
        )
        .expect("second fence");
    assert!(
        lease2.lease_epoch > lease.lease_epoch,
        "fenced epochs are never reused"
    );
    assert_eq!(kernel.recovery_audit("task-f", "native").unwrap().len(), 2);
}

#[test]
fn readiness_is_read_only_and_never_authorizes() {
    let (kernel, paths) = setup("a20-ready");
    let before_cmds = kernel.count_commands().unwrap();
    let before_receipts = kernel.count_receipts().unwrap();
    let global = kernel.dispatch_readiness(None);
    assert_eq!(global.verdict, "NOT_READY");
    assert!(!global.ready);
    assert!(!global.dispatch_enabled);
    assert_eq!(global.dimensions.len(), 9);
    for name in [
        "trusted-issuer-identity",
        "controller-durable-authority",
        "pinned-target",
        "generation-lease",
        "witness-health",
        "dispatch-reservation",
        "reconciliation-state",
        "recovery-attestation",
        "dispatch-disabled",
    ] {
        assert!(
            global.dimensions.iter().any(|d| d.name == name),
            "dimension {name} is individually evaluated"
        );
    }
    // Mandatory proofs are absent without a witness-backed command.
    assert_eq!(
        global.dimension_ready("trusted-issuer-identity"),
        Some(false)
    );
    assert_eq!(
        global.dimension_ready("controller-durable-authority"),
        Some(false)
    );
    assert_eq!(global.dimension_ready("witness-health"), Some(true));
    assert_eq!(global.dimension_ready("dispatch-disabled"), Some(true));
    // Assessing changes nothing and authorizes nothing.
    let _ = kernel.dispatch_readiness(Some("cmd-ghost"));
    assert_eq!(kernel.count_commands().unwrap(), before_cmds);
    assert_eq!(kernel.count_receipts().unwrap(), before_receipts);
    assert!(kernel.authorize_dispatch("cmd-ghost").is_err());
    assert_eq!(
        kernel
            .authorize_dispatch("cmd-ghost")
            .unwrap_err()
            .code
            .as_str(),
        "dispatch-disabled"
    );
    drop(kernel);
    // Without a witness the reservation and witness dimensions fail closed.
    let dir = tempfile::tempdir().unwrap();
    let lonely = nexus_kernel::Kernel::open(&dir.path().join("k.db"), None).unwrap();
    let report = lonely.dispatch_readiness(None);
    assert_eq!(report.verdict, "NOT_READY");
    assert_eq!(report.dimension_ready("witness-health"), Some(false));
    let _ = paths;
}
