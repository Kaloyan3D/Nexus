//! A2.4 production dispatch boundary: no network without a kernel-sealed grant.
//!
//! The raw Transport::send primitive stays available for offline unit tests, but the
//! production API (dispatch_authorized) refuses every unauthorized call before any
//! byte is sent: forged, wrong-digest, expired, revoked, cancelled, and replayed
//! dispatches all fail closed with zero provider sends. Mock execution only.

use nexus_contracts::{
    ControllerIntentV1, ExecutionTargetCoreV1, RegistryProvenanceV1, RegistryResolutionV1,
    CONTRACT_SCHEMA_VERSION,
};
use nexus_kernel::{NativeDispatchRequest, SCOPE_MOCK_E2E};
use nexus_model::testkit::{self, MockScript, MockTransport};
use nexus_model::*;

const SECRET: &str = "sk-test-SECRET-marker-xyz";
const TASK: &str = "task-auth";
const CRED_REF: &str = "credential://connections/connection";
const ORIGIN: &str = "http://127.0.0.1:9";

fn kernel_ext() -> serde_json::Value {
    serde_json::json!({ "extensionVersion": 1, "endpoint": { "protocol": "http", "origin": ORIGIN, "path": "/v1/responses", "method": "POST", "localLoopback": true }, "remoteModelIdConfirmed": "remote-model", "reasoningEffort": "low", "billing": { "tier": "test-unmetered", "dataUse": "standard" }, "session": { "sessionId": "session-test" }, "capabilities": ["text"], "contextLimitTokens": 8192, "outputLimitTokens": 1024, "connectionBinding": "connection", "credentialRef": CRED_REF })
}

fn ext_digest(v: &serde_json::Value) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(v))
}

#[allow(dead_code)]
struct Setup {
    kernel: nexus_kernel::Kernel,
    _dir: tempfile::TempDir,
    target: ExecutionTargetV2,
    issued_model: RegistryResolutionV1,
    snapshot_model: serde_json::Value,
    pin: VerifiedExecutionPin,
    attested: AttestedPreparedModelRequest,
    grant: nexus_kernel::SealedNativeDispatchGrant,
    attempt_id: String,
}

fn build(attempt: &str, command: &str) -> Setup {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("k.db");
    let wit = dir.path().join("k.wit.db");
    let mut kernel = nexus_kernel::Kernel::open(&db, Some(&wit)).expect("open");
    let target = ExecutionTargetV2::test_target(ORIGIN, "/v1/responses");
    let snapshot_model = serde_json::json!({"schemaVersion": 1, "tag": "auth-test"});
    let tv = serde_json::to_value(&target.core).expect("core");
    let mut issued_model = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "nexus-registry-bridge/1".to_owned(),
        task_instance_id: TASK.to_owned(),
        role: "muse_main".to_owned(),
        target: target.core.clone(),
        provenance: RegistryProvenanceV1 {
            issuer: "nexus-registry-bridge/1".to_owned(),
            resolution_id_compat: target.core.resolution_id.clone(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&snapshot_model),
            target_digest: nexus_contracts::target_digest_of(&tv),
            mode_config_revision: target.core.mode_config_revision.clone(),
            issuance_id: String::new(),
        },
    };
    issued_model.provenance.issuance_id = issued_model.issuance_id_of();
    let pin = VerifiedExecutionPin::bind(
        TASK,
        command,
        attempt,
        1,
        "test-incarnation",
        &issued_model,
        &snapshot_model,
        &target,
        "test-command-digest",
    )
    .expect("pin");
    let transport_tmp = MockTransport::new(
        MockScript::CleanStream {
            body: testkit::load_fixture("basic-text").sse_body,
        },
        SECRET,
    );
    let binding = TransportBinding::new(ORIGIN);
    let runtime = OfflineModelRuntime::new(transport_tmp, binding, TransportLimits::default());
    let prepared = runtime
        .prepare(
            &pin,
            &issued_model,
            &snapshot_model,
            &target,
            &ModelRequest::text_only("user", "hi"),
        )
        .expect("prepare");
    assert_eq!(prepared.endpoint_origin, ORIGIN);
    let attested = runtime
        .attest(&pin, &issued_model, &snapshot_model, &target, prepared)
        .expect("attest");
    let request_digest = attested.prepared().request_digest.clone();
    let lease = kernel.acquire_generation(TASK, "native").expect("acquire");
    let intent = ControllerIntentV1::build(
        TASK,
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
    let ktarget =
        ExecutionTargetCoreV1::sample("muse_main", "engineering-v2", serde_json::json!(3));
    let kv = serde_json::to_value(&ktarget).expect("kcore");
    let ksnapshot =
        serde_json::json!({"schemaVersion": 1, "tag": "synthetic-test-snapshot", "modes": []});
    let mut kissued = RegistryResolutionV1 {
        schema_version: CONTRACT_SCHEMA_VERSION,
        issuer: "registry-bridge".to_owned(),
        task_instance_id: TASK.to_owned(),
        role: "muse_main".to_owned(),
        target: ktarget,
        provenance: RegistryProvenanceV1 {
            issuer: "registry-bridge".to_owned(),
            resolution_id_compat: "compat".to_owned(),
            registry_snapshot_digest: nexus_contracts::snapshot_digest_of(&ksnapshot),
            target_digest: nexus_contracts::target_digest_of(&kv),
            mode_config_revision: serde_json::json!(3),
            issuance_id: String::new(),
        },
    };
    kissued.provenance.issuance_id = kissued.issuance_id_of();
    kernel.seal_issuance(&kissued).expect("seal issuance");
    kernel
        .accept_command(&nexus_kernel::AcceptRequest {
            intent,
            issued: kissued.clone(),
            snapshot: ksnapshot.clone(),
        })
        .expect("accept");
    let ext = kernel_ext();
    let extd = ext_digest(&ext);
    kernel.seal_extension(&ext).expect("seal ext");
    let bundle = serde_json::json!({ "commandId": command, "taskInstanceId": TASK, "attemptId": attempt, "leaseEpoch": lease.lease_epoch, "storeIncarnation": lease.store_incarnation, "role": "muse_main", "targetDigest": kissued.provenance.target_digest, "snapshotDigest": kissued.provenance.registry_snapshot_digest, "issuanceId": kissued.provenance.issuance_id, "extensionDigest": extd, "requestDigest": request_digest, "sessionId": "session-test", "scope": SCOPE_MOCK_E2E });
    kernel.publish_intent(&bundle).expect("publish");
    let grant = kernel
        .authorize_sealed_dispatch(&NativeDispatchRequest {
            command_id: command.to_owned(),
            request_digest: attested.prepared().request_digest.clone(),
            scope: SCOPE_MOCK_E2E.to_owned(),
            endpoint_origin: ORIGIN.to_owned(),
            credential_ref: CRED_REF.to_owned(),
        })
        .expect("authorize sealed");
    Setup {
        kernel,
        _dir: dir,
        target,
        issued_model,
        snapshot_model,
        pin,
        attested,
        grant,
        attempt_id: attempt.to_owned(),
    }
}

fn mock(script_body: String) -> MockTransport {
    MockTransport::new(MockScript::CleanStream { body: script_body }, SECRET)
}

#[test]
fn authorized_happy_path_sends_exactly_once() {
    let mut s = build("attempt-a1", "cmd-a1");
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let observed = t.observed.clone();
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    let report = dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect("authorized send");
    assert_eq!(t.sends(), 1);
    assert!(!report.events.is_empty());
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
    assert_eq!(
        observed
            .secret_seen
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[test]
fn forged_grant_sends_nothing() {
    let mut s = build("attempt-a2", "cmd-a2");
    s.grant.tag_hex = "00".repeat(32);
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    let err = dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect_err("forged");
    assert!(!err.bytes_sent);
    assert_eq!(t.sends(), 0);
}

#[test]
fn wrong_digest_grant_sends_nothing() {
    let mut s = build("attempt-a3", "cmd-a3");
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    let mut bad = s.grant.clone();
    bad.request_digest = "ff".repeat(32);
    let err = dispatch_authorized(
        &t,
        &mut s.kernel,
        &bad,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect_err("digest");
    assert!(!err.bytes_sent);
    assert_eq!(t.sends(), 0);
}

#[test]
fn revoked_credential_sends_nothing() {
    let mut s = build("attempt-a4", "cmd-a4");
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let cred = Credential::test_credential(SECRET);
    cred.revoke();
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    let err = dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &cred,
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect_err("revoked");
    assert!(!err.bytes_sent);
    assert_eq!(t.sends(), 0);
}

#[test]
fn cancelled_token_sends_nothing() {
    let mut s = build("attempt-a5", "cmd-a5");
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    let err = dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &cancel,
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect_err("cancelled");
    assert!(!err.bytes_sent);
    assert_eq!(t.sends(), 0);
}

#[test]
fn replay_after_success_sends_nothing_more() {
    let mut s = build("attempt-a6", "cmd-a6");
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect("first");
    assert_eq!(t.sends(), 1);
    let err = dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect_err("replay");
    assert!(!err.bytes_sent);
    assert_eq!(t.sends(), 1, "no second billable dispatch after replay");
}

#[test]
fn replay_with_fresh_tracker_after_success_sends_nothing_more() {
    let mut s = build("attempt-a7", "cmd-a7");
    let t = mock(testkit::load_fixture("basic-text").sse_body);
    let mut attempt = AttemptTracker::new(&s.attempt_id);
    let mut store = AttemptStore::new();
    dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut attempt,
        &mut store,
    )
    .expect("first");
    assert_eq!(t.sends(), 1);
    let mut fresh_attempt = AttemptTracker::new(&s.attempt_id);
    let err = dispatch_authorized(
        &t,
        &mut s.kernel,
        &s.grant,
        &s.attested,
        CRED_REF,
        &Credential::test_credential(SECRET),
        &CancellationToken::new(),
        &TransportLimits::default(),
        &mut fresh_attempt,
        &mut store,
    )
    .expect_err("replay with dropped attempt state");
    assert!(!err.bytes_sent);
    assert_eq!(
        t.sends(),
        1,
        "re-presented grant must not cause a second provider call"
    );
}
