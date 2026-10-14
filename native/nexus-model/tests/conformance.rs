//! A2.2 adversarial conformance tests (failing-first; Phase 5).
//!
//! Every test pins a security property: wrong-target refusal, attestation
//! gating, streaming/cancellation semantics, truthful failure
//! classification with no silent retry, bounds, and secret redaction.
//! No test performs real inference: the transport is `MockTransport`
//! (scripted) or `HttpSseTransport` against loopback `LocalMockServer`.
//! No model-driven tool execution exists anywhere (assembly returns data).

use nexus_contracts::{RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION};
use nexus_model::testkit::{self, LocalMockServer, MockHttpResponse, MockScript, MockTransport};
use nexus_model::*;
use std::sync::Arc;

const SECRET_MARKER: &str = "sk-test-SECRET-marker-xyz";
const TASK: &str = "task-a2-2";
const COMMAND: &str = "cmd-a2-2";

fn target_for(origin: &str) -> ExecutionTargetV2 {
    ExecutionTargetV2::test_target(origin, "/v1/responses")
}

fn issued_for(target: &ExecutionTargetV2, task: &str) -> (RegistryResolutionV1, serde_json::Value) {
    let snapshot = serde_json::json!({"schemaVersion": 1, "tag": "a2-2-test-snapshot"});
    let target_value = serde_json::to_value(&target.core).expect("core value");
    let target_digest = nexus_contracts::target_digest_of(&target_value);
    let snapshot_digest = nexus_contracts::snapshot_digest_of(&snapshot);
    let mut issued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "nexus-registry-bridge/1".to_owned(),
        task_instance_id: task.to_owned(),
        role: "muse_main".to_owned(),
        target: target.core.clone(),
        provenance: RegistryProvenanceV1 {
            issuer: "nexus-registry-bridge/1".to_owned(),
            resolution_id_compat: target.core.resolution_id.clone(),
            registry_snapshot_digest: snapshot_digest,
            target_digest,
            mode_config_revision: target.core.mode_config_revision.clone(),
            issuance_id: String::new(),
        },
    };
    issued.provenance.issuance_id = issued.issuance_id_of();
    (issued, snapshot)
}

/// Recompute provenance digests after mutating an issued target: simulates
/// a fresh Registry issuance for changed content. The pin still binds the
/// OLD digests, so verification must refuse with `wrong-target`.
fn reseal(issued: &mut RegistryResolutionV1, snapshot: &serde_json::Value) {
    let value = serde_json::to_value(&issued.target).expect("core");
    issued.provenance.target_digest = nexus_contracts::target_digest_of(&value);
    issued.provenance.registry_snapshot_digest = nexus_contracts::snapshot_digest_of(snapshot);
    issued.provenance.mode_config_revision = issued.target.mode_config_revision.clone();
    issued.provenance.issuance_id = issued.issuance_id_of();
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
        "test-incarnation",
        issued,
        snapshot,
        target,
        "test-command-digest",
    )
    .expect("pin binds")
}

fn mock_setup(
    script: MockScript,
    attempt: &str,
) -> (
    OfflineModelRuntime<MockTransport>,
    Arc<testkit::MockObservations>,
    ExecutionTargetV2,
    RegistryResolutionV1,
    serde_json::Value,
    VerifiedExecutionPin,
) {
    let target = target_for("http://127.0.0.1:9");
    let (issued, snapshot) = issued_for(&target, TASK);
    let pin = pin_for(&target, &issued, &snapshot, attempt);
    let transport = MockTransport::new(script, SECRET_MARKER);
    let observed = transport.observed.clone();
    let binding = TransportBinding::new("http://127.0.0.1:9");
    let runtime = OfflineModelRuntime::new(transport, binding, TransportLimits::default());
    (runtime, observed, target, issued, snapshot, pin)
}

fn attest_happy(
    runtime: &OfflineModelRuntime<MockTransport>,
    pin: &VerifiedExecutionPin,
    issued: &RegistryResolutionV1,
    snapshot: &serde_json::Value,
    target: &ExecutionTargetV2,
    input: &ModelRequest,
) -> AttestedPreparedModelRequest {
    let prepared = runtime
        .prepare(pin, issued, snapshot, target, input)
        .expect("prepare");
    runtime
        .attest(pin, issued, snapshot, target, prepared)
        .expect("attest")
}

fn credential() -> Credential {
    Credential::test_credential(SECRET_MARKER)
}

fn assert_no_secret(message: &str) {
    assert!(!message.contains(SECRET_MARKER), "secret leaked: {message}");
    assert!(
        !message.contains("sk-test-SECRET"),
        "secret leaked: {message}"
    );
}

// ---- Preparation: exact binding, no network. ----

#[test]
fn prepare_binds_exact_routing_without_network() {
    let (runtime, observed, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-exact");
    let input = ModelRequest::text_only("user", "hello");
    let prepared = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("prepare succeeds even though connects fail: no network in prepare");
    assert_eq!(prepared.endpoint_origin, "http://127.0.0.1:9");
    assert_eq!(prepared.endpoint_path, "/v1/responses");
    assert_eq!(prepared.method, "POST");
    assert_eq!(prepared.remote_model_id, "remote-model-a");
    assert_eq!(prepared.reasoning_effort, "low");
    assert_eq!(prepared.session_header, "session-test-1");
    let body: serde_json::Value = serde_json::from_slice(&prepared.request_bytes).expect("body");
    assert_eq!(
        body.get("model").and_then(|v| v.as_str()),
        Some("remote-model-a")
    );
    assert_eq!(
        body.get("reasoning")
            .and_then(|v| v.get("effort"))
            .and_then(|v| v.as_str()),
        Some("low")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|v| v.get("x-opencode-session"))
            .and_then(|v| v.as_str()),
        Some("session-test-1")
    );
    assert_eq!(
        body.get("metadata")
            .and_then(|v| v.get("route"))
            .and_then(|v| v.as_str()),
        Some("route-a")
    );
    // No credential material anywhere near the prepared bytes.
    assert_no_secret(&String::from_utf8_lossy(&prepared.request_bytes));
    assert!(!String::from_utf8_lossy(&prepared.request_bytes).contains("Bearer"));
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn wrong_endpoint_origin_refused() {
    let (runtime, _, mut target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-endpoint");
    target.endpoint.origin = "http://127.0.0.1:10".to_owned();
    let input = ModelRequest::text_only("user", "hi");
    let err = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect_err("drifted endpoint must be refused");
    assert_eq!(err.code, ModelErrorCode::WrongTarget, "{err}");
}

#[test]
fn wrong_model_id_refused() {
    let (runtime, _, mut target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-model");
    target.remote_model_id_confirmed = "remote-model-evil".to_owned();
    let input = ModelRequest::text_only("user", "hi");
    let err = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect_err("drifted model id must be refused");
    assert_eq!(err.code, ModelErrorCode::WrongTarget, "{err}");
}

#[test]
fn wrong_route_refused() {
    let (runtime, _, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-route");
    let input = ModelRequest::text_only("user", "hi");
    // Prepare against the pinned issuance, then change the Registry route
    // before attestation: the pin still binds the old digest.
    let prepared = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("prepare binds the pin");
    let mut drifted = issued.clone();
    drifted.target.route_id = "route-evil".to_owned();
    reseal(&mut drifted, &snapshot);
    let err = runtime
        .attest(&pin, &drifted, &snapshot, &target, prepared)
        .expect_err("changed route after pin creation must be refused");
    assert_eq!(err.code, ModelErrorCode::WrongTarget, "{err}");
}

#[test]
fn wrong_reasoning_refused() {
    let (runtime, _, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-reasoning");
    let mut input = ModelRequest::text_only("user", "hi");
    input.reasoning_effort_override = Some("high".to_owned());
    let err = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect_err("reasoning override drift must be refused");
    assert_eq!(err.code, ModelErrorCode::WrongTarget, "{err}");
    // Matching override inherits cleanly.
    input.reasoning_effort_override = Some("low".to_owned());
    runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("matching override is exact");
}

#[test]
fn wrong_session_header_refused() {
    let (runtime, _, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-session");
    let mut input = ModelRequest::text_only("user", "hi");
    input.session_override = Some("session-evil".to_owned());
    let err = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect_err("session drift must be refused");
    assert_eq!(err.code, ModelErrorCode::WrongTarget, "{err}");
}

#[test]
fn missing_billing_provenance_is_target_incomplete() {
    let (runtime, _, mut target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-billing");
    let input = ModelRequest::text_only("user", "hi");
    target.billing.tier.clear();
    let err = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect_err("missing billing tier is not executable");
    assert_eq!(err.code, ModelErrorCode::TargetIncomplete, "{err}");
    target.billing.tier = "metered".to_owned();
    target.billing.data_use.clear();
    let err = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect_err("missing data-use provenance is not executable");
    assert_eq!(err.code, ModelErrorCode::TargetIncomplete, "{err}");
}

#[test]
fn missing_capability_context_session_is_target_incomplete() {
    let (runtime, _, base, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-gaps");
    let input = ModelRequest::text_only("user", "hi");
    let mut target = base.clone();
    target.capabilities.clear();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("no capabilities")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = base.clone();
    target.context_limit_tokens = 0;
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("no context")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = base.clone();
    target.session.session_id.clear();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("no session")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = base.clone();
    target.endpoint.origin.clear();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("no endpoint")
            .code,
        ModelErrorCode::TargetIncomplete
    );
}

#[test]
fn changed_registry_target_after_pin_is_refused() {
    let (runtime, _, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-changed");
    let input = ModelRequest::text_only("user", "hi");
    let prepared = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("prepare binds the pin");
    let mut drifted = issued.clone();
    drifted.target.remote_model_id = "remote-model-evil".to_owned();
    reseal(&mut drifted, &snapshot);
    let err = runtime
        .attest(&pin, &drifted, &snapshot, &target, prepared)
        .expect_err("changed Registry target after pin creation");
    assert_eq!(err.code, ModelErrorCode::WrongTarget, "{err}");
}

#[test]
fn tampered_preparation_fails_attestation() {
    let (runtime, _, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-tamper");
    let input = ModelRequest::text_only("user", "hi");
    let mut prepared = runtime
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("prepare");
    // Tamper with the digest coverage: bytes no longer match.
    prepared.request_digest = "00".repeat(32);
    let err = runtime
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect_err("tampered digest must fail attestation");
    assert_eq!(err.code, ModelErrorCode::AttestationFailed, "{err}");
}

#[test]
fn dispatch_twice_on_one_tracker_is_duplicate() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, _, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body,
        },
        "attempt-twice",
    );
    let input = ModelRequest::text_only("user", "hi");
    let attested = attest_happy(&runtime, &pin, &issued, &snapshot, &target, &input);
    let mut attempt = AttemptTracker::new("attempt-twice");
    let mut store = AttemptStore::new();
    runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("first dispatch commits");
    assert_eq!(attempt.state(), AttemptState::TerminalCommitted);
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("second dispatch on one tracker");
    assert_eq!(err.code, ModelErrorCode::DuplicateAttempt, "{err}");
}

// ---- Streaming normalization over the recorded corpus. ----

#[test]
fn clean_stream_normalizes_terminal() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body.clone(),
        },
        "attempt-clean",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-clean");
    let mut store = AttemptStore::new();
    let terminal = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("clean stream commits");
    assert_eq!(terminal.text, "Hello, world.");
    assert_eq!(terminal.usage.input_tokens, 12);
    assert_eq!(terminal.usage.output_tokens, 7);
    assert_eq!(terminal.finish_reason, "stop");
    assert_eq!(attempt.state(), AttemptState::TerminalCommitted);
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 1);
    // The mock recorded an authorization header without ever storing the secret.
    assert_eq!(
        observed
            .auth_present
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(
        observed
            .secret_seen
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[test]
fn fixtures_normalize_to_recorded_expectations() {
    for name in ["basic-text", "reasoning-tool", "interleaved-order"] {
        let fixture = testkit::load_fixture(name);
        let terminal = testkit::normalize_fixture(
            &fixture,
            "attempt-fixture",
            "digest-fixture",
            &TransportLimits::default(),
        );
        assert_eq!(terminal.text, fixture.expected_text, "{name} text");
        assert_eq!(
            terminal.reasoning_text, fixture.expected_reasoning,
            "{name} reasoning"
        );
        assert_eq!(
            terminal.tool_calls.len(),
            fixture.expected_tools.len(),
            "{name} tools"
        );
        for (call, (ename, eargs)) in terminal
            .tool_calls
            .iter()
            .zip(fixture.expected_tools.iter())
        {
            assert_eq!(&call.name, ename, "{name} tool name");
            assert_eq!(&call.arguments, eargs, "{name} tool args");
        }
        assert_eq!(
            terminal.usage.input_tokens, fixture.expected_usage.0,
            "{name} input"
        );
        assert_eq!(
            terminal.usage.output_tokens, fixture.expected_usage.1,
            "{name} output"
        );
        assert_eq!(
            terminal.finish_reason, fixture.expected_finish,
            "{name} finish"
        );
    }
}

#[test]
fn reasoning_tool_fragments_assemble_without_execution() {
    let fixture = testkit::load_fixture("reasoning-tool");
    let (runtime, _, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body,
        },
        "attempt-tool",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-tool");
    let mut store = AttemptStore::new();
    let terminal = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("tool stream commits as data");
    assert_eq!(terminal.reasoning_text, "Let me check.");
    assert_eq!(terminal.tool_calls.len(), 1);
    assert_eq!(terminal.tool_calls[0].name, "get_file");
    assert_eq!(
        terminal.tool_calls[0].arguments,
        serde_json::json!({"path": "src/main.rs"})
    );
    assert_eq!(terminal.finish_reason, "tool_calls");
    // Assembly is data: there is no execution entry point on the terminal.
    // (This assertion is structural — `TerminalResponse` exposes no runner —
    // plus behavioral: dispatch performed zero tool effects by construction.)
}

// ---- Redirect / proxy / endpoint integrity over real loopback TCP. ----

fn http_setup(
    responses: Vec<MockHttpResponse>,
    limits: TransportLimits,
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
    let (issued, snapshot) = issued_for(&target, TASK);
    let pin = pin_for(&target, &issued, &snapshot, "attempt-http");
    let binding = TransportBinding::new(&origin);
    let runtime = OfflineModelRuntime::new(HttpSseTransport::new(binding.clone()), binding, limits);
    (runtime, server, target, issued, snapshot, pin)
}

#[test]
fn fixtures_roundtrip_through_loopback_wire() {
    for name in ["basic-text", "reasoning-tool", "interleaved-order"] {
        let fixture = testkit::load_fixture(name);
        let expected = testkit::normalize_fixture(
            &fixture,
            "attempt-http",
            "digest-x",
            &TransportLimits::default(),
        );
        let (runtime, server, target, issued, snapshot, pin) = http_setup(
            vec![MockHttpResponse::sse(&fixture.sse_body)],
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
            .expect("wire roundtrip commits");
        assert_eq!(terminal.text, expected.text, "{name}");
        assert_eq!(terminal.reasoning_text, expected.reasoning_text, "{name}");
        assert_eq!(terminal.tool_calls, expected.tool_calls, "{name}");
        assert_eq!(attempt.state(), AttemptState::TerminalCommitted);
        // Exact wire proof from the server side.
        assert_eq!(server.connections(), 1, "{name}: exactly one connection");
        let obs = server.observed();
        let line = obs.request_line.lock().expect("mutex").clone();
        assert!(
            line.starts_with("POST /v1/responses HTTP/1.1"),
            "{name}: {line}"
        );
        assert_eq!(
            obs.session_header.lock().expect("mutex").clone(),
            "session-test-1",
            "{name}"
        );
        assert_eq!(
            obs.auth_present.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "{name}"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&obs.request_body.lock().expect("mutex").clone())
                .expect("server body");
        assert_eq!(
            body.get("model").and_then(|v| v.as_str()),
            Some("remote-model-a"),
            "{name}"
        );
        assert_no_secret(&String::from_utf8_lossy(
            &obs.request_body.lock().expect("mutex").clone(),
        ));
    }
}

#[test]
fn redirect_is_never_followed() {
    let (runtime, server, target, issued, snapshot, pin) = http_setup(
        vec![MockHttpResponse::redirect()],
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
        .expect_err("redirect must be refused");
    assert_eq!(err.code, ModelErrorCode::RedirectRefused, "{err}");
    assert_no_secret(&err.message);
    assert_eq!(
        server.connections(),
        1,
        "no second connection may follow the redirect"
    );
    // Uncertain outcome recorded: retry demands a continuation, not a re-send.
    let mut attempt2 = AttemptTracker::new("attempt-http");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("uncertain retry");
    assert_eq!(err2.code, ModelErrorCode::ContinuationRequired, "{err2}");
    assert_eq!(server.connections(), 1, "still exactly one connection");
}

#[test]
fn proxy_destination_change_refused_before_connect() {
    let fixture = testkit::load_fixture("basic-text");
    let server = LocalMockServer::serve(vec![MockHttpResponse::sse(&fixture.sse_body)], 4);
    let origin = server.origin();
    let target = target_for(&origin);
    let (issued, snapshot) = issued_for(&target, TASK);
    let pin = pin_for(&target, &issued, &snapshot, "attempt-http");
    // Transport bound to a DIFFERENT origin than the preparation.
    let runtime = OfflineModelRuntime::new(
        HttpSseTransport::new(TransportBinding::new("http://127.0.0.1:1")),
        TransportBinding::new("http://127.0.0.1:1"),
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
        .expect_err("destination change must be refused");
    assert_eq!(err.code, ModelErrorCode::EndpointMismatch, "{err}");
    assert_eq!(
        attempt.state(),
        AttemptState::NotSent,
        "no byte may have been sent"
    );
    assert_eq!(
        server.connections(),
        0,
        "the pinned server saw no connection"
    );
}

#[test]
fn read_deadline_is_truthful_timeout() {
    let (runtime, _server, target, issued, snapshot, pin) = http_setup(
        vec![MockHttpResponse::stall(800)],
        TransportLimits {
            read_timeout_ms: 150,
            ..TransportLimits::default()
        },
    );
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
        .expect_err("stalled provider must time out");
    assert_eq!(err.code, ModelErrorCode::Timeout, "{err}");
    assert_eq!(
        attempt.state(),
        AttemptState::SendUncertain,
        "outcome unknown, not re-sent"
    );
}

// ---- Failure classification: drops, cancellation, duplicates, bounds. ----

#[test]
fn connection_drop_before_send_stays_not_sent() {
    let (runtime, observed, target, issued, snapshot, pin) =
        mock_setup(MockScript::FailConnect, "attempt-drop-before");
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-drop-before");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("connect fails");
    assert_eq!(err.code, ModelErrorCode::Disconnected, "{err}");
    assert_no_secret(&err.message);
    assert_eq!(attempt.state(), AttemptState::NotSent);
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 0);
    // The failure is recorded deterministically: the same bytes replay the
    // same error with no new provider contact (no automatic retry, and no
    // silent second call on explicit replay either).
    let mut attempt2 = AttemptTracker::new("attempt-drop-before");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("replay");
    assert_eq!(err2.code, ModelErrorCode::Disconnected, "{err2}");
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn connection_drop_after_send_is_uncertain_without_resend() {
    let (runtime, observed, target, issued, snapshot, pin) =
        mock_setup(MockScript::DropAfterSend, "attempt-drop-after");
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-drop-after");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("drop after send");
    assert_eq!(err.code, ModelErrorCode::SendUncertain, "{err}");
    assert_eq!(attempt.state(), AttemptState::SendUncertain);
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 1);
    // A second dispatch — even explicit — must not trigger another call.
    let mut attempt2 = AttemptTracker::new("attempt-drop-after");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("uncertain retry");
    assert_eq!(err2.code, ModelErrorCode::ContinuationRequired, "{err2}");
    assert_eq!(
        observed.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second send"
    );
}

#[test]
fn disconnect_mid_body_yields_partial_without_retry() {
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::DisconnectMidBody {
            prefix: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"part\"}\n\n"
                .to_owned(),
            trailing: "data: {\"type\":\"response.output_text.del".to_owned(),
        },
        "attempt-midbody",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-midbody");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("mid-body cut");
    assert_eq!(err.code, ModelErrorCode::StreamPartial, "{err}");
    assert_eq!(attempt.state(), AttemptState::StreamPartial);
    assert_eq!(
        attempt.events_seen(),
        1,
        "the complete prefix event is retained"
    );
    let mut attempt2 = AttemptTracker::new("attempt-midbody");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("partial retry");
    assert_eq!(err2.code, ModelErrorCode::ContinuationRequired, "{err2}");
    assert_eq!(
        observed.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second send"
    );
}

#[test]
fn incomplete_sse_frames_are_refused() {
    // Garbage line: neither data nor comment.
    let (runtime, _, target, issued, snapshot, pin) = mock_setup(
        MockScript::MalformedBody {
            body: "this is not sse\n\n".to_owned(),
        },
        "attempt-garbage",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-garbage");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("garbage frame");
    assert_eq!(err.code, ModelErrorCode::SseMalformed, "{err}");
    assert_no_secret(&err.message);
    // Truncated mid-frame body (no terminating blank line).
    let (runtime, _, target, issued, snapshot, pin) = mock_setup(
        MockScript::MalformedBody {
            body: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}".to_owned(),
        },
        "attempt-truncated",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-truncated");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("truncated frame");
    assert_eq!(err.code, ModelErrorCode::SseMalformed, "{err}");
}

#[test]
fn partial_tool_call_arguments_are_never_executed() {
    // Valid frames (plain-string fragment, no completion): the stream is
    // partial, the arguments never assemble, and nothing executes.
    let body = "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"call_9\",\"name\":\"delete_everything\"}}\n\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"call_9\",\"delta\":\"{partial\"}\n\n";
    let (runtime, _, target, issued, snapshot, pin) = mock_setup(
        MockScript::PartialFrames {
            body: body.to_owned(),
        },
        "attempt-partial-tool",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-partial-tool");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("partial tool call without completion");
    assert_eq!(err.code, ModelErrorCode::StreamPartial, "{err}");
    assert_eq!(attempt.state(), AttemptState::StreamPartial);
    // No terminal exists, so no tool call was assembled, let alone run.
}

#[test]
fn cancellation_during_streaming_stops_reads() {
    let fixture = testkit::load_fixture("interleaved-order");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::CancelAfter {
            events: 1,
            body: fixture.sse_body,
        },
        "attempt-cancel",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let cancel = CancellationToken::new();
    let mut attempt = AttemptTracker::new("attempt-cancel");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(&mut attempt, &mut store, &attested, &credential(), &cancel)
        .expect_err("cancelled mid-stream");
    assert_eq!(err.code, ModelErrorCode::Cancelled, "{err}");
    assert_ne!(
        attempt.state(),
        AttemptState::TerminalCommitted,
        "cancellation is never terminal"
    );
    assert_eq!(
        observed.reads.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "transport stopped pulling"
    );
    assert!(cancel.is_cancelled());
    // The uncertain outcome cannot be re-driven.
    let mut attempt2 = AttemptTracker::new("attempt-cancel");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("cancelled retry");
    assert_eq!(err2.code, ModelErrorCode::ContinuationRequired, "{err2}");
    assert_eq!(
        observed.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second send"
    );
}

#[test]
fn cancellation_before_send_sends_nothing() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body,
        },
        "attempt-pre-cancel",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut attempt = AttemptTracker::new("attempt-pre-cancel");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(&mut attempt, &mut store, &attested, &credential(), &cancel)
        .expect_err("pre-cancelled");
    assert_eq!(err.code, ModelErrorCode::Cancelled, "{err}");
    assert_eq!(attempt.state(), AttemptState::NotSent);
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn duplicate_attempt_with_different_bytes_is_refused() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body,
        },
        "attempt-dup",
    );
    let first = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "first"),
    );
    let mut attempt = AttemptTracker::new("attempt-dup");
    let mut store = AttemptStore::new();
    runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &first,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("first commits");
    // Same attempt id, different message bytes.
    let second = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "second"),
    );
    let mut attempt2 = AttemptTracker::new("attempt-dup");
    let err = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &second,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("replayed attempt id with new bytes");
    assert_eq!(err.code, ModelErrorCode::DuplicateAttempt, "{err}");
    assert_eq!(
        observed.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second send"
    );
}

#[test]
fn replayed_terminal_returns_without_new_bytes() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body,
        },
        "attempt-replay",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-replay");
    let mut store = AttemptStore::new();
    let first = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("first commits");
    // Same attempt id, same bytes, fresh tracker (post-restart shape).
    let mut attempt2 = AttemptTracker::new("attempt-replay");
    let second = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect("terminal replays");
    assert_eq!(first, second);
    assert_eq!(attempt2.state(), AttemptState::TerminalCommitted);
    assert_eq!(
        observed.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second send"
    );
}

fn tight_runtime(
    script: MockScript,
    limits: TransportLimits,
) -> OfflineModelRuntime<MockTransport> {
    OfflineModelRuntime::new(
        MockTransport::new(script, SECRET_MARKER),
        TransportBinding::new("http://127.0.0.1:9"),
        limits,
    )
}

#[test]
fn excessive_event_and_output_sizes_are_refused() {
    let target = target_for("http://127.0.0.1:9");
    let (issued, snapshot) = issued_for(&target, TASK);
    let pin = pin_for(&target, &issued, &snapshot, "attempt-many");
    let input = ModelRequest::text_only("user", "hi");
    // Far more frames than the bound.
    let many: String = (0..32)
        .map(|_| "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n")
        .collect();
    let tight = tight_runtime(
        MockScript::CleanStream { body: many },
        TransportLimits {
            max_events: 8,
            ..TransportLimits::default()
        },
    );
    let prepared = tight
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("prepare");
    let attested = tight
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("attest");
    let mut attempt = AttemptTracker::new("attempt-many");
    let mut store = AttemptStore::new();
    let err = tight
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("too many events");
    assert_eq!(err.code, ModelErrorCode::PayloadTooLarge, "{err}");
    assert_no_secret(&err.message);
    // The frame bound fires inside the transport before any event is
    // observed: truthfully send-uncertain (no event seen), never a guess.
    assert_eq!(attempt.state(), AttemptState::SendUncertain);
    // The uncertain frame flood cannot be re-driven either.
    let mut attempt_retry = AttemptTracker::new("attempt-many");
    let mut store_retry = store;
    let err_retry = tight
        .dispatch(
            &mut attempt_retry,
            &mut store_retry,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("frame-flood retry");
    assert_eq!(
        err_retry.code,
        ModelErrorCode::ContinuationRequired,
        "{err_retry}"
    );
    // Oversize single delta against a tight text bound.
    let big = "y".repeat(4096);
    let body = format!("data: {{\"type\":\"response.output_text.delta\",\"delta\":\"{big}\"}}\n\n");
    let tight_text = tight_runtime(
        MockScript::CleanStream { body },
        TransportLimits {
            max_text_bytes: 16,
            ..TransportLimits::default()
        },
    );
    let prepared = tight_text
        .prepare(&pin, &issued, &snapshot, &target, &input)
        .expect("prepare");
    let attested = tight_text
        .attest(&pin, &issued, &snapshot, &target, prepared)
        .expect("attest");
    let mut attempt = AttemptTracker::new("attempt-many");
    let mut store = AttemptStore::new();
    let err = tight_text
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("oversize output");
    assert_eq!(err.code, ModelErrorCode::PayloadTooLarge, "{err}");
    // The oversize event reached the assembler after one observed event:
    // partial output retained, never executed, never retried.
    assert_eq!(attempt.state(), AttemptState::StreamPartial);
}

#[test]
fn credential_revocation_before_dispatch_sends_nothing() {
    let fixture = testkit::load_fixture("basic-text");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::CleanStream {
            body: fixture.sse_body,
        },
        "attempt-revoke-before",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let cred = credential();
    cred.revoke();
    let mut attempt = AttemptTracker::new("attempt-revoke-before");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &cred,
            &CancellationToken::new(),
        )
        .expect_err("revoked credential");
    assert_eq!(err.code, ModelErrorCode::CredentialRevoked, "{err}");
    assert_no_secret(&err.message);
    assert_eq!(attempt.state(), AttemptState::NotSent);
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn credential_revocation_mid_stream_is_uncertain() {
    let fixture = testkit::load_fixture("interleaved-order");
    let (runtime, observed, target, issued, snapshot, pin) = mock_setup(
        MockScript::RevokeAfter {
            events: 1,
            body: fixture.sse_body,
        },
        "attempt-revoke-mid",
    );
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-revoke-mid");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("mid-stream revocation");
    assert_eq!(err.code, ModelErrorCode::CredentialRevoked, "{err}");
    assert_ne!(attempt.state(), AttemptState::TerminalCommitted);
    assert_eq!(observed.sends.load(std::sync::atomic::Ordering::SeqCst), 1);
    let mut attempt2 = AttemptTracker::new("attempt-revoke-mid");
    let err2 = runtime
        .dispatch(
            &mut attempt2,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("revoked retry");
    assert_eq!(err2.code, ModelErrorCode::ContinuationRequired, "{err2}");
    assert_eq!(
        observed.sends.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "no second send"
    );
}

#[test]
fn secret_redaction_in_every_error_path() {
    // Every classified error redacts credential-shaped material.
    let codes = [
        ModelErrorCode::WrongTarget,
        ModelErrorCode::TargetIncomplete,
        ModelErrorCode::AttestationFailed,
        ModelErrorCode::TransportRefused,
        ModelErrorCode::SendUncertain,
        ModelErrorCode::StreamPartial,
        ModelErrorCode::ProviderFailed,
        ModelErrorCode::RedirectRefused,
        ModelErrorCode::CredentialRevoked,
    ];
    for code in codes {
        let err = ModelError::new(
            code,
            format!("boom {SECRET_MARKER} with Bearer abcdef1234567890"),
        );
        assert_no_secret(&err.message);
        assert_no_secret(&err.to_string());
    }
    // The credential handle itself never formats its secret.
    let cred = credential();
    assert_no_secret(&format!("{cred:?}"));
    // A provider failure echoing secret-shaped text is redacted.
    let body = format!(
        "data: {{\"type\":\"response.failed\",\"error\":{{\"code\":\"boom-{SECRET_MARKER}\"}}}}\n\n"
    );
    let (runtime, observed, target, issued, snapshot, pin) =
        mock_setup(MockScript::CleanStream { body }, "attempt-secret-echo");
    let attested = attest_happy(
        &runtime,
        &pin,
        &issued,
        &snapshot,
        &target,
        &ModelRequest::text_only("user", "hi"),
    );
    let mut attempt = AttemptTracker::new("attempt-secret-echo");
    let mut store = AttemptStore::new();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential(),
            &CancellationToken::new(),
        )
        .expect_err("provider failure");
    assert_eq!(err.code, ModelErrorCode::ProviderFailed, "{err}");
    assert_no_secret(&err.message);
    assert_eq!(
        observed
            .secret_seen
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[test]
fn production_dispatch_remains_disabled() {
    assert!(
        !nexus_kernel::Kernel::dispatch_enabled(),
        "A2.2 leaves production dispatch disabled"
    );
    let dir = tempfile::tempdir().expect("tempdir");
    let kernel = nexus_kernel::Kernel::open(&dir.path().join("k.db"), None).expect("open");
    let err = kernel
        .authorize_dispatch("cmd-x")
        .expect_err("dispatch is never authorized");
    assert_eq!(err.code, nexus_contracts::KernelErrorCode::DispatchDisabled);
}
