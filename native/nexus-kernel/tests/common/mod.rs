#![allow(dead_code)]
use nexus_contracts::{
    CommandReceiptV1, ControllerIntentV1, ExecutionTargetCoreV1, RegistryProvenanceV1,
    RegistryResolutionV1, CONTRACT_SCHEMA_VERSION,
};
use nexus_kernel::{AcceptRequest, Kernel};
use std::path::PathBuf;

pub struct Paths {
    pub _dir: tempfile::TempDir,
    pub db: PathBuf,
    pub witness: PathBuf,
}

pub fn setup(tag: &str) -> (Kernel, Paths) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join([tag, ".db"].concat());
    let witness = dir.path().join([tag, ".witness.db"].concat());
    let kernel = Kernel::open(&db, Some(&witness)).expect("open kernel");
    (
        kernel,
        Paths {
            _dir: dir,
            db,
            witness,
        },
    )
}

pub fn reopen(paths: &Paths, with_witness: bool) -> Kernel {
    let w = if with_witness {
        Some(paths.witness.as_path())
    } else {
        None
    };
    Kernel::open(&paths.db, w).expect("reopen kernel")
}

pub fn snapshot() -> serde_json::Value {
    serde_json::json!({"schemaVersion": 1, "tag": "synthetic-test-snapshot", "modes": []})
}

pub fn rev3() -> serde_json::Value {
    serde_json::json!(3)
}

pub fn payload() -> serde_json::Value {
    serde_json::json!({"op": "engineer-turn"})
}

pub fn make_intent(task: &str, attempt: &str, command: &str) -> ControllerIntentV1 {
    ControllerIntentV1::build(
        task,
        attempt,
        command,
        "native",
        1,
        "muse_main",
        "engineering-v2",
        rev3(),
        payload(),
    )
}

pub fn make_issued(
    kernel: &mut Kernel,
    task: &str,
    snapshot: &serde_json::Value,
) -> RegistryResolutionV1 {
    let target = ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", rev3());
    let target_value = serde_json::to_value(&target).expect("target value");
    let provisional = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "registry-bridge".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target,
        provenance: RegistryProvenanceV1 {
            issuer: "registry-bridge".to_owned(),
            resolution_id_compat: "compat".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(snapshot),
            target_digest: nexus_contracts::target_digest_of(&target_value),
            mode_config_revision: rev3(),
            issuance_id: String::new(),
        },
    };
    let issuance_id = provisional.issuance_id_of();
    let mut issued = provisional;
    issued.provenance.issuance_id = issuance_id;
    kernel.seal_issuance(&issued).expect("seal issuance");
    issued
}

pub fn handshake(
    kernel: &mut Kernel,
    task: &str,
    attempt: &str,
    command: &str,
) -> (ControllerIntentV1, RegistryResolutionV1, serde_json::Value) {
    let lease = kernel.acquire_generation(task, "native").expect("acquire");
    let intent =
        make_intent(task, attempt, command).with_lease(lease.lease_epoch, &lease.store_incarnation);
    let snapshot = snapshot();
    let issued = make_issued(kernel, task, &snapshot);
    (intent, issued, snapshot)
}

pub fn accept(
    kernel: &mut Kernel,
    intent: ControllerIntentV1,
    issued: RegistryResolutionV1,
    snapshot: serde_json::Value,
) -> (CommandReceiptV1, bool) {
    kernel
        .accept_command(&AcceptRequest {
            intent,
            issued,
            snapshot,
        })
        .expect("accept")
}

pub fn code_of(result: &Result<(CommandReceiptV1, bool), nexus_contracts::KernelError>) -> String {
    match result {
        Ok(_) => "ok".to_owned(),
        Err(e) => e.code.as_str().to_owned(),
    }
}
