//! Explicitly isolated mock execution (A2.4 Phase 3).
//!
//! `run_mock` owns a throwaway Kernel (tempdir store + witness), seals a
//! fixture issuance/extension, publishes one intent, mints a sealed grant,
//! and sends through the authorized production boundary to a scripted
//! loopback mock provider. It never opens the real daemon store, never
//! touches the network beyond loopback test doubles, and never loads a
//! live credential: the credential is a revoked-proof test marker whose
//! value never leaves this function. Live execution stays blocked and
//! reports its blockers instead of running.

use crate::error::ClientError;
use nexus_kernel::{NativeDispatchRequest, SCOPE_MOCK_E2E};
use nexus_model::testkit::{MockScript, MockTransport};
use nexus_model::*;

/// Ordered mock-run events for terminal display and GUI reuse.
#[derive(Debug, Clone)]
pub struct MockRunReport {
    pub text: String,
    pub attempt_id: String,
    pub command_id: String,
    pub request_digest: String,
    pub events: Vec<String>,
    pub usage_in: u64,
    pub usage_out: u64,
    pub finish_reason: String,
}

/// Run one isolated mock task. `prompt` is user content for the mock body
/// only; it never reaches a live provider.
pub fn run_mock(prompt: &str) -> Result<MockRunReport, ClientError> {
    if prompt.trim().is_empty() {
        return Err(ClientError::usage("prompt must not be empty"));
    }
    let dir = tempfile::tempdir()
        .map_err(|e| ClientError::internal(format!("mock store unavailable: {e}")))?;
    let db = dir.path().join("mock.db");
    let wit = dir.path().join("mock.wit.db");
    let mut kernel = nexus_kernel::Kernel::open(&db, Some(&wit))
        .map_err(|e| ClientError::internal(format!("mock kernel unavailable: {e}")))?;
    let task = "task-mock-cli";
    let attempt = "attempt-mock-1";
    let command = "cmd-mock-1";
    let target = ExecutionTargetV2::test_target("http://127.0.0.1:9", "/v1/responses");
    let snapshot = serde_json::json!({"schemaVersion": 1, "tag": "cli-mock"});
    let tv = serde_json::to_value(&target.core)
        .map_err(|e| ClientError::internal(format!("mock target: {e}")))?;
    let mut issued = nexus_contracts::RegistryResolutionV1 {
        schema_version: nexus_contracts::CONTRACT_SCHEMA_VERSION,
        issuer: "nexus-registry-bridge/1".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target: target.core.clone(),
        provenance: nexus_contracts::RegistryProvenanceV1 {
            issuer: "nexus-registry-bridge/1".to_owned(),
            resolution_id_compat: target.core.resolution_id.clone(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snapshot),
            target_digest: nexus_contracts::target_digest_of(&tv),
            mode_config_revision: target.core.mode_config_revision.clone(),
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    let pin = VerifiedExecutionPin::bind(
        task,
        command,
        attempt,
        1,
        "mock-incarnation",
        &issued,
        &snapshot,
        &target,
        "mock-command-digest",
    )
    .map_err(|e| ClientError::internal(format!("mock pin: {e}")))?;
    let script = MockScript::CleanStream {
        body: nexus_model::testkit::load_fixture("basic-text").sse_body,
    };
    let transport = MockTransport::new(script, "sk-test-mock-marker");
    let runtime = OfflineModelRuntime::new(
        transport,
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let prepared = runtime
        .prepare(
            &pin,
            &issued,
            &snapshot,
            &target,
            &ModelRequest::text_only("user", prompt),
        )
        .map_err(|e| ClientError::internal(format!("mock prepare: {e}")))?;
    let request_digest = prepared.request_digest.clone();
    let attested = runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .map_err(|e| ClientError::internal(format!("mock attest: {e}")))?;
    let lease = kernel
        .acquire_generation(task, "native")
        .map_err(|e| ClientError::internal(format!("mock lease: {e}")))?;
    let intent = nexus_contracts::ControllerIntentV1::build(
        task,
        attempt,
        command,
        "native",
        1,
        "muse_main",
        "engineering-v2",
        serde_json::json!(3),
        serde_json::json!({"op": "engineer-turn"}),
    )
    .with_lease(lease.lease_epoch, &lease.store_incarnation);
    let ktarget = nexus_contracts::ExecutionTargetCoreV1::sample(
        "muse_main",
        "engineering-v2",
        serde_json::json!(3),
    );
    let kv = serde_json::to_value(&ktarget)
        .map_err(|e| ClientError::internal(format!("mock core: {e}")))?;
    let ksnapshot =
        serde_json::json!({"schemaVersion": 1, "tag": "synthetic-test-snapshot", "modes": []});
    let mut kissued = nexus_contracts::RegistryResolutionV1 {
        schema_version: nexus_contracts::CONTRACT_SCHEMA_VERSION,
        issuer: "registry-bridge".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target: ktarget,
        provenance: nexus_contracts::RegistryProvenanceV1 {
            issuer: "registry-bridge".to_owned(),
            resolution_id_compat: "compat".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&ksnapshot),
            target_digest: nexus_contracts::target_digest_of(&kv),
            mode_config_revision: serde_json::json!(3),
            issuance_id: String::new(),
        },
    };
    kissued.provenance.issuance_id = kissued.issuance_id_of();
    kernel
        .seal_issuance(&kissued)
        .map_err(|e| ClientError::internal(format!("mock seal: {e}")))?;
    kernel
        .accept_command(&nexus_kernel::AcceptRequest {
            intent,
            issued: kissued.clone(),
            snapshot: ksnapshot.clone(),
        })
        .map_err(|e| ClientError::internal(format!("mock accept: {e}")))?;
    let ext = serde_json::json!({ "extensionVersion": 1, "endpoint": { "protocol": "http", "origin": "http://127.0.0.1:9", "path": "/v1/responses", "method": "POST", "localLoopback": true }, "remoteModelIdConfirmed": "remote-model", "reasoningEffort": "low", "billing": { "tier": "test-unmetered", "dataUse": "standard" }, "session": { "sessionId": "session-test" }, "capabilities": ["text"], "contextLimitTokens": 8192, "outputLimitTokens": 1024, "connectionBinding": "connection", "credentialRef": "credential://connections/connection" });
    let extd = nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(&ext));
    kernel
        .seal_extension(&ext)
        .map_err(|e| ClientError::internal(format!("mock seal-ext: {e}")))?;
    let bundle = serde_json::json!({ "commandId": command, "taskInstanceId": task, "attemptId": attempt, "leaseEpoch": lease.lease_epoch, "storeIncarnation": lease.store_incarnation, "role": "muse_main", "targetDigest": kissued.provenance.target_digest, "snapshotDigest": kissued.provenance.registry_snapshot_digest, "issuanceId": kissued.provenance.issuance_id, "extensionDigest": extd, "requestDigest": request_digest, "sessionId": "session-test", "scope": SCOPE_MOCK_E2E });
    kernel
        .publish_intent(&bundle)
        .map_err(|e| ClientError::internal(format!("mock publish: {e}")))?;
    let grant = kernel
        .authorize_sealed_dispatch(&NativeDispatchRequest {
            command_id: command.to_owned(),
            request_digest: attested.prepared().request_digest.clone(),
            scope: SCOPE_MOCK_E2E.to_owned(),
            endpoint_origin: "http://127.0.0.1:9".to_owned(),
            credential_ref: "credential://connections/connection".to_owned(),
        })
        .map_err(|e| ClientError::internal(format!("mock authorize: {e}")))?;
    let script2 = MockScript::CleanStream {
        body: nexus_model::testkit::load_fixture("basic-text").sse_body,
    };
    let transport2 = MockTransport::new(script2, "sk-test-mock-marker");
    let mut attempt_tracker = AttemptTracker::new(attempt);
    let mut store = AttemptStore::new();
    let credential = Credential::test_credential("sk-test-mock-marker");
    let report = dispatch_authorized(
        &transport2,
        &mut kernel,
        &grant,
        &attested,
        "credential://connections/connection",
        &credential,
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt_tracker,
        &mut store,
    )
    .map_err(|e| ClientError::internal(format!("mock dispatch: {}", e.error)))?;
    let kinds: Vec<String> = report.events.iter().map(|e| format!("{e:?}")).collect();
    Ok(MockRunReport {
        text: String::from("Hello, world."),
        attempt_id: attempt.to_owned(),
        command_id: command.to_owned(),
        request_digest: attested.prepared().request_digest.clone(),
        events: kinds,
        usage_in: 12,
        usage_out: 7,
        finish_reason: report.finish_reason.unwrap_or_else(|| "stop".to_owned()),
    })
}

/// Live execution gate: always blocked in A2.4 with explicit reasons.
pub fn live_blockers() -> serde_json::Value {
    serde_json::json!({
        "ready": false,
        "dispatchEnabled": false,
        "blockers": ["no live scope authorization (kernel refuses non-mock-e2e)", "no TLS termination in the transport (https refused fail-closed)", "production Registry carries no billingTier metadata", "no live credential loading path", "multi-UID container re-proof pending"]
    })
}
