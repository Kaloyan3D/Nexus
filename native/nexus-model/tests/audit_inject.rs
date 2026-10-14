//! Audit: wire-string policy (header-injection refusal).

use nexus_contracts::{RegistryProvenanceV1, RegistryResolutionV1, CONTRACT_SCHEMA_VERSION};
use nexus_model::testkit::{MockScript, MockTransport};
use nexus_model::*;

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

fn setup(
    script: MockScript,
) -> (
    OfflineModelRuntime<MockTransport>,
    ExecutionTargetV2,
    RegistryResolutionV1,
    serde_json::Value,
    VerifiedExecutionPin,
) {
    let target = target_for("http://127.0.0.1:9");
    let (issued, snapshot) = issued_for(&target);
    let pin = VerifiedExecutionPin::bind(
        TASK,
        COMMAND,
        "attempt-audit",
        1,
        "inc",
        &issued,
        &snapshot,
        &target,
        "cmd-digest",
    )
    .expect("pin");
    let transport = MockTransport::new(script, "");
    let runtime = OfflineModelRuntime::new(
        transport,
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    (runtime, target, issued, snapshot, pin)
}

#[test]
fn header_injection_strings_are_not_executable() {
    let e_acute = char::from_u32(0xE9).expect("e-acute");
    let (runtime, _, issued, snapshot, pin) = setup(MockScript::FailConnect);
    let input = ModelRequest::text_only("user", "hi");
    let mut target = target_for("http://127.0.0.1:9");
    target.endpoint.path = "/v1/responses\r\nX-Injected: 1".to_owned();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("crlf-path")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = target_for("http://127.0.0.1:9");
    target.session.session_id = "s\r\nAuthorization: Bearer x".to_owned();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("crlf-session")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = target_for("http://127.0.0.1:9");
    target.endpoint.origin = "http://127.0.0.1:9\r\nX: 1".to_owned();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("crlf-origin")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = target_for("http://127.0.0.1:9");
    target.endpoint.origin = "http://evil host/".to_owned();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("space-host")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = target_for("http://127.0.0.1:9");
    target.session.session_id = "session 1".to_owned();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("space-session")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let mut target = target_for("http://127.0.0.1:9");
    target.endpoint.path = format!("/v1/r{e_acute}sponses");
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("non-ascii-path")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    let _ = e_acute.is_alphabetic();
}

#[test]
fn endpoint_string_policy_covers_scheme_host_and_loopback() {
    let (runtime, _, issued, snapshot, pin) = setup(MockScript::FailConnect);
    let input = ModelRequest::text_only("user", "hi");
    let mut target = ExecutionTargetV2::test_target("http://192.0.2.1:80", "/v1/responses");
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("non-loopback http")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    target = ExecutionTargetV2::test_target("http://user:pass@127.0.0.1:9", "/v1/responses");
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("userinfo")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    target = ExecutionTargetV2::test_target("http://127.0.0.1:9", "v1/responses");
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("relative path")
            .code,
        ModelErrorCode::TargetIncomplete
    );
    target = ExecutionTargetV2::test_target("http://127.0.0.1:9", "/v1/responses");
    target.endpoint.method = "GET".to_owned();
    assert_eq!(
        runtime
            .prepare(&pin, &issued, &snapshot, &target, &input)
            .expect_err("non-POST")
            .code,
        ModelErrorCode::TargetIncomplete
    );
}
