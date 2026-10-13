mod common;
use common::{
    accept, code_of, handshake, make_intent, make_issued, payload, rev3, setup, snapshot,
};
use nexus_contracts::{
    ControllerIntentV1, ExecutionTargetCoreV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION,
};
use nexus_kernel::AcceptRequest;

#[test]
fn correct_envelope_accepted() {
    let (mut kernel, _p) = setup("identity-happy");
    let (intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    let (receipt, created) = accept(&mut kernel, intent, issued, snap);
    assert!(created);
    assert_eq!(receipt.command_id, "cmd-1");
    assert_eq!(
        receipt.status,
        nexus_contracts::ReceiptStatus::AcceptedReservedDispatchDisabled
    );
    assert_eq!(kernel.count_receipts().unwrap(), 1);
}

#[test]
fn target_mismatch_rejected() {
    let (mut kernel, _p) = setup("identity-target");
    let (intent, mut issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    issued.target.remote_model_id = "attacker-model".to_owned();
    let result = kernel.accept_command(&AcceptRequest {
        intent: intent.clone(),
        issued: issued.clone(),
        snapshot: snap.clone(),
    });
    assert_eq!(code_of(&result), "delivery-invalid");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
    let target_value = serde_json::to_value(&issued.target).unwrap();
    issued.provenance.target_digest = nexus_contracts::target_digest_of(&target_value);
    issued.provenance.issuance_id = issued.issuance_id_of();
    let regilded = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&regilded), "forged-issuer");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
}

#[test]
fn provenance_mismatch_rejected() {
    let (mut kernel, _p) = setup("identity-prov");
    let (intent, issued, _snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    let other_snapshot = serde_json::json!({"schemaVersion": 1, "tag": "different-snapshot"});
    let result = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: other_snapshot,
    });
    assert_eq!(code_of(&result), "binding-mismatch");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
}

#[test]
fn generation_mismatch_rejected() {
    let (mut kernel, _p) = setup("identity-gen");
    let snap = snapshot();
    let lease = kernel.acquire_generation("task-1", "native").unwrap();
    let intent = make_intent("task-1", "attempt-1", "cmd-1")
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let issued = make_issued(&mut kernel, "task-2", &snap);
    let result = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&result), "generation-mismatch");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
}

#[test]
fn incomplete_target_rejected() {
    let (mut kernel, _p) = setup("identity-incomplete");
    let snap = snapshot();
    let mut target =
        ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(3));
    target.route_id = String::new();
    let target_value = serde_json::to_value(&target).unwrap();
    let issued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
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
            issuance_id: "pending".to_owned(),
        },
    };
    let result = kernel.seal_issuance(&issued);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code.as_str(), "target-incomplete");
}

#[test]
fn unsupported_schema_rejected() {
    let (mut kernel, _p) = setup("identity-schema");
    let (mut intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    intent.schema_version = 99;
    let result = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&result), "unsupported-schema");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
}

#[test]
fn tampered_payload_rejected() {
    let (mut kernel, _p) = setup("identity-tamper");
    let (mut intent, issued, snap) = handshake(&mut kernel, "task-1", "attempt-1", "cmd-1");
    intent.intent_payload = serde_json::json!({"op": "smuggled"});
    let result = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&result), "payload-tamper");
}

#[test]
fn role_binding_mismatch_rejected() {
    let (mut kernel, _p) = setup("identity-role");
    let snap = snapshot();
    let lease = kernel.acquire_generation("task-1", "native").unwrap();
    let intent = ControllerIntentV1::build(
        "task-1",
        "attempt-1",
        "cmd-1",
        "native",
        1,
        "other_role",
        "engineering-v2",
        rev3(),
        payload(),
    )
    .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let issued = make_issued(&mut kernel, "task-1", &snap);
    let result = kernel.accept_command(&AcceptRequest {
        intent,
        issued,
        snapshot: snap,
    });
    assert_eq!(code_of(&result), "binding-mismatch");
    assert_eq!(kernel.count_receipts().unwrap(), 0);
}
