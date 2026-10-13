mod common;
use common::{accept, code_of, handshake, make_intent, setup, snapshot};
use nexus_kernel::AcceptRequest;

#[test]
fn replay_returns_original_receipt() {
    let (mut kernel, _p) = setup("idem-replay");
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    let (first, created) = accept(&mut kernel, intent.clone(), issued.clone(), snap.clone());
    assert!(created);
    let (second, created_again) = accept(&mut kernel, intent, issued, snap);
    assert!(!created_again);
    assert_eq!(first, second);
    assert_eq!(kernel.count_commands().unwrap(), 1);
    assert_eq!(kernel.count_receipts().unwrap(), 1);
}

#[test]
fn same_command_id_different_envelope_rejected() {
    let (mut kernel, _p) = setup("idem-conflict");
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    accept(&mut kernel, intent, issued, snap.clone());
    let lease = kernel.acquire_generation("task-1", "native").unwrap();
    let other = make_intent("task-1", "attempt-2", "cmd-1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snap2 = snapshot();
    let issued2 = common::make_issued(&mut kernel, "task-1", &snap2);
    let result = kernel.accept_command(&AcceptRequest {
        intent: other,
        issued: issued2,
        snapshot: snap2,
    });
    assert_eq!(code_of(&result), "command-conflict");
    assert_eq!(kernel.count_receipts().unwrap(), 1);
}

#[test]
fn concurrent_acceptance_yields_one_authority() {
    let (_kernel, paths) = setup("idem-concurrent");
    let mut prep = common::reopen(&paths, true);
    let lease = prep.acquire_generation("task-1", "native").unwrap();
    let snap = snapshot();
    let issued = common::make_issued(&mut prep, "task-1", &snap);
    let intent = make_intent("task-1", "attempt-1", "cmd-1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    drop(prep);
    let mut handles = Vec::new();
    for _ in 0..8 {
        let db = paths.db.clone();
        let w = paths.witness.clone();
        let (i, s, snapshot) = (intent.clone(), issued.clone(), snap.clone());
        handles.push(std::thread::spawn(move || {
            let mut k = nexus_kernel::Kernel::open(&db, Some(&w)).expect("open");
            k.accept_command(&AcceptRequest {
                intent: i,
                issued: s,
                snapshot,
            })
            .map(|(r, created)| (r.command_digest, created))
            .map_err(|e| [e.code.as_str(), e.message.as_str()].join(": "))
        }));
    }
    let mut created_count = 0;
    let mut digests = std::collections::HashSet::new();
    for h in handles {
        let (digest, created) = h.join().expect("thread").expect("accept");
        digests.insert(digest);
        if created {
            created_count += 1;
        }
    }
    assert_eq!(created_count, 1, "exactly one winner");
    assert_eq!(digests.len(), 1, "one authoritative digest");
    let check = common::reopen(&paths, true);
    assert_eq!(check.count_receipts().unwrap(), 1);
}

#[test]
fn concurrent_acquisition_issues_unique_epochs() {
    let (_kernel, paths) = setup("idem-epochs");
    let mut handles = Vec::new();
    for _ in 0..8 {
        let db = paths.db.clone();
        let w = paths.witness.clone();
        handles.push(std::thread::spawn(move || {
            let mut k = nexus_kernel::Kernel::open(&db, Some(&w)).expect("open");
            k.acquire_generation("task-1", "native")
                .map(|l| l.lease_epoch)
                .map_err(|e| [e.code.as_str(), e.message.as_str()].join(": "))
        }));
    }
    let mut epochs: Vec<u64> = handles
        .into_iter()
        .map(|h| h.join().expect("thread").expect("acquire"))
        .collect();
    epochs.sort_unstable();
    epochs.dedup();
    assert_eq!(epochs.len(), 8, "no duplicate epochs");
    assert_eq!(epochs, vec![1, 2, 3, 4, 5, 6, 7, 8]);
}

#[test]
fn stale_lease_rejected() {
    let (mut kernel, _p) = setup("idem-stale");
    let snap = snapshot();
    let first = kernel.acquire_generation("task-1", "native").unwrap();
    let second = kernel.acquire_generation("task-1", "native").unwrap();
    assert_eq!((first.lease_epoch, second.lease_epoch), (1, 2));
    let issued = common::make_issued(&mut kernel, "task-1", &snap);
    let stale = make_intent("task-1", "attempt-1", "cmd-1")
        .with_lease(first.lease_epoch, &first.store_incarnation);
    let result = kernel.accept_command(&AcceptRequest {
        intent: stale,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&result), "stale-lease");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
}

#[test]
fn unsealed_issuance_rejected() {
    let (mut kernel, _p) = setup("idem-unsealed");
    let snap = snapshot();
    let lease = kernel.acquire_generation("task-1", "native").unwrap();
    let intent = make_intent("task-1", "attempt-1", "cmd-1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let target = nexus_contracts::ExecutionTargetCoreV1::sample(
        "muse_main",
        "engineering-v2",
        serde_json::json!(3),
    );
    let target_value = serde_json::to_value(&target).unwrap();
    let mut issued = nexus_contracts::RegistryResolutionV1 {
        schema_version: 1,
        issuer: "registry-bridge".to_owned(),
        task_instance_id: "task-1".to_owned(),
        role: "muse_main".to_owned(),
        target,
        provenance: nexus_contracts::RegistryProvenanceV1 {
            issuer: "registry-bridge".to_owned(),
            resolution_id_compat: "compat".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snap),
            target_digest: nexus_contracts::target_digest_of(&target_value),
            mode_config_revision: serde_json::json!(3),
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    let result = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&result), "forged-issuer");
}
