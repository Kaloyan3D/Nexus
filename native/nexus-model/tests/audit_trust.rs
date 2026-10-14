//! Audit: transport binding, segmentation, encoding, trust boundary.

use nexus_contracts::{RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION};
use nexus_model::testkit::{self, LocalMockServer, MockHttpResponse};
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
) -> VerifiedExecutionPin {
    VerifiedExecutionPin::bind(
        TASK,
        COMMAND,
        "attempt-http",
        1,
        "inc",
        issued,
        snapshot,
        target,
        "cmd-digest",
    )
    .expect("pin")
}

fn credential() -> Credential {
    Credential::test_credential(SECRET_MARKER)
}

fn http_ctx(
    responses: Vec<MockHttpResponse>,
) -> (
    OfflineModelRuntime<HttpSseTransport>,
    LocalMockServer,
    ExecutionTargetV2,
    RegistryResolutionV1,
    serde_json::Value,
    VerifiedExecutionPin,
) {
    let server = LocalMockServer::serve(responses, 4);
    let origin = server.origin();
    let target = target_for(&origin);
    let (issued, snapshot) = issued_for(&target);
    let pin = pin_for(&target, &issued, &snapshot);
    let binding = TransportBinding::new(&origin);
    let runtime = OfflineModelRuntime::new(
        HttpSseTransport::new(binding),
        TransportBinding::new(&origin),
        TransportLimits::default(),
    );
    (runtime, server, target, issued, snapshot, pin)
}

#[test]
fn networked_transport_enforces_its_own_binding() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, server, target, issued, snapshot, pin) =
        http_ctx(vec![MockHttpResponse::sse(&fixture.sse_body)]);
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
    // Direct transport use bypassing the runtime gates: the transport
    // refuses by its own binding before any socket exists.
    let rogue = HttpSseTransport::new(TransportBinding::new("http://127.0.0.1:1"));
    let err = rogue
        .send(
            &attested,
            &credential(),
            &CancellationToken::new(),
            &TransportLimits::default(),
        )
        .expect_err("rogue origin")
        .error;
    assert_eq!(err.code, ModelErrorCode::EndpointMismatch, "{err}");
    assert_eq!(server.connections(), 0, "no socket was opened");
}

#[test]
fn sse_split_across_tcp_segments_normalizes() {
    let fixture = testkit::load_fixture("basic-text");
    let expected = testkit::normalize_fixture(
        &fixture,
        "attempt-http",
        "digest-x",
        &TransportLimits::default(),
    );
    let dripping = MockHttpResponse {
        status: 200,
        headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
        body: fixture.sse_body.clone(),
        cut_after: None,
        drip: true,
        raw_bytes: None,
        stall_ms: None,
    };
    let (runtime, server, target, issued, snapshot, pin) = http_ctx(vec![dripping]);
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
    let mut attempt = AttemptTracker::new("attempt-http");
    let mut store = AttemptStore::new();
    let terminal = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("dripped stream normalizes");
    assert_eq!(terminal.text, expected.text);
    assert_eq!(terminal.usage, expected.usage);
    assert_eq!(server.connections(), 1);
}

#[test]
fn invalid_utf8_body_fails_closed_without_panic() {
    let raw = MockHttpResponse {
        status: 200,
        headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
        body: String::new(),
        cut_after: None,
        drip: false,
        raw_bytes: Some(b"data: \xff\xfe not utf8\n\n".to_vec()),
        stall_ms: None,
    };
    let (runtime, _server, target, issued, snapshot, pin) = http_ctx(vec![raw]);
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
    let mut attempt = AttemptTracker::new("attempt-http");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("invalid utf8");
    assert_eq!(err.code, ModelErrorCode::SseMalformed, "{err}");
    assert!(!err.message.contains(SECRET_MARKER));
    assert_ne!(attempt.state(), AttemptState::TerminalCommitted);
}

#[test]
fn structural_attestation_is_not_production_authorization() {
    // A fully self-consistent but Registry-unblessed chain
    // (attacker-chosen model, matching digests, bound pin) attests
    // SUCCESSFULLY at the structural level. This pins the trust boundary
    // instead of hiding it: production authorization additionally requires
    // the kernel HMAC seal, a live lease, and genuine Registry issuance,
    // none of which exist in this offline milestone. Production dispatch
    // stays disabled regardless.
    let mut target = target_for("http://127.0.0.1:9");
    target.core.remote_model_id = "attacker-model".to_owned();
    target.remote_model_id_confirmed = "attacker-model".to_owned();
    let (issued, snapshot) = issued_for(&target);
    let pin = VerifiedExecutionPin::bind(
        TASK,
        COMMAND,
        "attempt-fabricated",
        1,
        "inc",
        &issued,
        &snapshot,
        &target,
        "cmd-digest",
    )
    .expect("pin");
    let transport = testkit::MockTransport::new(
        testkit::MockScript::CleanStream {
            body: testkit::load_fixture("basic-text").sse_body,
        },
        SECRET_MARKER,
    );
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
            &ModelRequest::text_only("user", "hi"),
        )
        .expect("structural prepare");
    runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("structural attest");
    assert!(
        !nexus_kernel::Kernel::dispatch_enabled(),
        "structural success never enables dispatch"
    );
}
