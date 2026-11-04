//! Crash-loop writer for real SIGKILL durability tests (dev-only helper).
//! Hammers acquire + seal + accept with unique command ids; the test kills
//! it mid-loop and verifies only complete records survive.
use nexus_contracts::{
    ControllerIntentV1, ExecutionTargetCoreV1, RegistryProvenanceV1, RegistryResolutionV1,
    CONTRACT_SCHEMA_VERSION,
};
use nexus_kernel::{AcceptRequest, Kernel};

fn arg(args: &[String], name: &str) -> String {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned().unwrap_or_default();
        }
    }
    String::new()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let db = arg(&args, "--db");
    let witness = arg(&args, "--witness");
    let task = arg(&args, "--task");
    let n: usize = arg(&args, "--n").parse().unwrap_or(500);
    let mut kernel = Kernel::open(
        std::path::Path::new(&db),
        Some(std::path::Path::new(&witness)),
    )
    .expect("open");
    let snapshot = serde_json::json!({"schemaVersion": 1, "tag": "crash-loop"});
    for i in 0..n {
        let command = [task.as_str(), "-cmd-", &i.to_string()].concat();
        let attempt = [task.as_str(), "-attempt-", &i.to_string()].concat();
        let lease = kernel.acquire_generation(&task, "native").expect("acquire");
        let intent = ControllerIntentV1::build(
            &task,
            &attempt,
            &command,
            "native",
            1,
            "muse_main",
            "engineering-v2",
            serde_json::json!(3),
            serde_json::json!({"op": "engineer-turn", "i": i}),
        )
        .with_lease(lease.lease_epoch, &lease.store_incarnation);
        let target =
            ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(3));
        let target_value = serde_json::to_value(&target).expect("target");
        let provisional = RegistryResolutionV1 {
            schema_version: CONTRACT_SCHEMA_VERSION,
            issuer: "registry-bridge".to_owned(),
            task_instance_id: task.clone(),
            role: "muse_main".to_owned(),
            target,
            provenance: RegistryProvenanceV1 {
                issuer: "registry-bridge".to_owned(),
                resolution_id_compat: "compat".to_owned(),
                registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snapshot),
                target_digest: nexus_contracts::target_digest_of(&target_value),
                mode_config_revision: serde_json::json!(3),
                issuance_id: String::new(),
            },
        };
        let issuance_id = provisional.issuance_id_of();
        let mut issued = provisional;
        issued.provenance.issuance_id = issuance_id;
        kernel.seal_issuance(&issued).expect("seal");
        kernel
            .accept_command(&AcceptRequest {
                intent,
                issued,
                snapshot: snapshot.clone(),
            })
            .expect("accept");
    }
    println!("DONE {n}");
}
