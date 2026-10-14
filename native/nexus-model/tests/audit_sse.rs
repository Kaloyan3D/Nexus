//! Audit: SSE framing edge cases (duplicates, keepalive, segmentation).

use nexus_contracts::{RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION};
use nexus_model::testkit::{MockScript, MockTransport};
use nexus_model::*;

const SECRET_MARKER: &str = "sk-test-SECRET-marker-xyz";
const TASK: &str = "task-a2-2";
const COMMAND: &str = "cmd-a2-2";

fn target_for(origin: &str) -> ExecutionTargetV2 {
    ExecutionTargetV2::test_target(origin, "/v1/responses")
}

fn issued_for(target: &ExecutionTargetV2) -> (RegistryResolutionV1, serde_json::Value) {
    let snapshot = serde_json::json!({"tag": "audit"});
    let tv = serde_json::to_value(&target.core).expect("core");
    let mut issued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "nexus-registry-bridge/1".to_owned(),
        task_instance_id: TASK.to_owned(),
        role: "muse_main".to_owned(),
        target: target.core.clone(),
        provenance: RegistryProvenanceV1 {
            issuer: "nexus-registry-bridge/1".to_owned(),
            resolution_id_compat: target.core.resolution_id.clone(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snapshot),
            target_digest: nexus_contracts::target_digest_of(&tv),
            mode_config_revision: target.core.mode_config_revision.clone(),
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    (issued, snapshot)
}

fn pin_for(
    target: &ExecutionTargetV2,
    issued: &RegistryResolutionV1,
    snapshot: &serde_json::Value,
    attempt: &str,
) -> VerifiedExecutionPin {
    VerifiedExecutionPin::bind(
        TASK,
        COMMAND,
        attempt,
        1,
        "inc",
        issued,
        snapshot,
        target,
        "cmd-digest",
    )
    .expect("pin")
}

fn mock_runtime(
    script: MockScript,
    attempt: &str,
) -> (
    OfflineModelRuntime<MockTransport>,
    ExecutionTargetV2,
    RegistryResolutionV1,
    serde_json::Value,
    VerifiedExecutionPin,
) {
    let target = target_for("http://127.0.0.1:9");
    let (issued, snapshot) = issued_for(&target);
    let pin = pin_for(&target, &issued, &snapshot, attempt);
    let transport = MockTransport::new(script, SECRET_MARKER);
    let runtime = OfflineModelRuntime::new(
        transport,
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    (runtime, target, issued, snapshot, pin)
}

fn credential() -> Credential {
    Credential::test_credential(SECRET_MARKER)
}

#[test]
fn duplicate_provider_completion_is_refused() {
    let completed = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1},\"finish_reason\":\"stop\"}}\n\n";
    let body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n".to_owned()
        + completed
        + completed;
    let (runtime, target, issued, snapshot, pin) =
        mock_runtime(MockScript::CleanStream { body }, "attempt-dup-complete");
    let prepared = runtime
        .prepare(
            &pin,
            &issued,
            &snapshot,
            &target,
            &ModelRequest::text_only("user", "hi"),
        )
        .expect("prepare");
    let attested = runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("attest");
    let mut attempt = AttemptTracker::new("attempt-dup-complete");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("second completion");
    assert_eq!(err.code, ModelErrorCode::SseMalformed, "{err}");
    assert_ne!(attempt.state(), AttemptState::TerminalCommitted);
    let mut attempt2 = AttemptTracker::new("attempt-dup-complete");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("retry");
    assert_eq!(err2.code, ModelErrorCode::ContinuationRequired, "{err2}");
}

#[test]
fn keepalive_frames_do_not_break_normalization() {
    let fixture = testkit::load_fixture("basic-text");
    let body = ": provider keepalive\n\ndata:\n\n".to_owned() + &fixture.sse_body;
    let (runtime, target, issued, snapshot, pin) =
        mock_runtime(MockScript::CleanStream { body }, "attempt-keepalive");
    let prepared = runtime
        .prepare(
            &pin,
            &issued,
            &snapshot,
            &target,
            &ModelRequest::text_only("user", "hi"),
        )
        .expect("prepare");
    let attested = runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("attest");
    let mut attempt = AttemptTracker::new("attempt-keepalive");
    let mut store = AttemptStore::new();
    let terminal = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("keepalive ignored");
    assert_eq!(terminal.text, "Hello, world.");
    assert_eq!(attempt.state(), AttemptState::TerminalCommitted);
}
