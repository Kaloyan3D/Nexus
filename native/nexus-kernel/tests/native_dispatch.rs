//! A2.3 kernel dispatch authorization tests (mock-e2e scope only).

mod common;

use common::{accept, handshake, setup};
use nexus_contracts::KernelErrorCode;
use nexus_kernel::{NativeDispatchRequest, SCOPE_MOCK_E2E};

fn ext_json() -> serde_json::Value {
    serde_json::json!({
        "extensionVersion": 1,
        "endpoint": { "protocol": "http", "origin": "http://127.0.0.1:9", "path": "/v1/responses", "method": "POST", "localLoopback": true },
        "remoteModelIdConfirmed": "remote-model",
        "reasoningEffort": "low",
        "billing": { "tier": "test-unmetered", "dataUse": "standard" },
        "session": { "sessionId": "session-test" },
        "capabilities": ["text"],
        "contextLimitTokens": 8192,
        "outputLimitTokens": 1024,
        "connectionBinding": "connection",
        "credentialRef": "credential://connections/connection"
    })
}

struct Fixture {
    issued: nexus_contracts::RegistryResolutionV1,
    _snapshot: serde_json::Value,
    command_id: String,
    attempt_id: String,
    request_digest: String,
}

fn happy_fixture(
    kernel: &mut nexus_kernel::Kernel,
    task: &str,
    attempt: &str,
    command: &str,
) -> Fixture {
    let (intent, issued, snapshot) = handshake(kernel, task, attempt, command);
    let command_id = intent.command_id.clone();
    accept(kernel, intent, issued.clone(), snapshot.clone());
    let ext = ext_json();
    kernel.seal_extension(&ext).expect("seal extension");
    let request_digest = nexus_contracts::sha256_hex("e2e-mock-request-bytes");
    Fixture {
        issued,
        _snapshot: snapshot,
        command_id,
        attempt_id: attempt.to_owned(),
        request_digest,
    }
}

fn bundle_for(
    fx: &Fixture,
    task: &str,
    lease_epoch: u64,
    incarnation: &str,
    ext_digest: &str,
) -> serde_json::Value {
    serde_json::json!({
        "commandId": fx.command_id,
        "taskInstanceId": task,
        "attemptId": fx.attempt_id,
        "leaseEpoch": lease_epoch,
        "storeIncarnation": incarnation,
        "role": "muse_main",
        "targetDigest": fx.issued.provenance.target_digest,
        "snapshotDigest": fx.issued.provenance.registry_snapshot_digest,
        "issuanceId": fx.issued.provenance.issuance_id,
        "extensionDigest": ext_digest,
        "requestDigest": fx.request_digest,
        "sessionId": "session-test",
        "scope": SCOPE_MOCK_E2E,
    })
}

#[test]
fn publish_then_authorize_happy_path() {
    let (mut kernel, _paths) = setup("dispatch-happy");
    let fx = happy_fixture(&mut kernel, "task-d1", "attempt-1", "cmd-d1");
    let lease = kernel
        .store_current_generation("task-d1", "native")
        .expect("gen")
        .expect("epoch");
    let bundle = bundle_for(&fx, "task-d1", lease.0, &lease.1, &ext_digest(&ext_json()));
    let published = kernel.publish_intent(&bundle).expect("publish");
    assert_eq!(published.command_id, fx.command_id);
    let grant = kernel
        .authorize_native_dispatch(&auth_req(&fx, "http://127.0.0.1:9"))
        .expect("authorize");
    assert_eq!(grant.command_id, fx.command_id);
    assert_eq!(grant.request_digest, fx.request_digest);
    assert_eq!(grant.endpoint_origin, "http://127.0.0.1:9");
    assert_eq!(grant.scope, SCOPE_MOCK_E2E);
    let again = kernel.authorize_native_dispatch(&auth_req(&fx, "http://127.0.0.1:9"));
    assert_eq!(
        again.expect_err("second grant").code,
        KernelErrorCode::CommandConflict
    );
}

#[test]
fn fence_then_authorize_is_refused() {
    let (mut kernel, _paths) = setup("dispatch-fence");
    let fx = happy_fixture(&mut kernel, "task-d2", "attempt-1", "cmd-d2");
    let lease = kernel
        .store_current_generation("task-d2", "native")
        .expect("gen")
        .expect("epoch");
    let bundle = bundle_for(&fx, "task-d2", lease.0, &lease.1, &ext_digest(&ext_json()));
    kernel.publish_intent(&bundle).expect("publish");
    kernel.fence_intent(&fx.command_id).expect("fence");
    let err = kernel
        .authorize_native_dispatch(&auth_req(&fx, "http://127.0.0.1:9"))
        .expect_err("fenced");
    assert_eq!(err.code, KernelErrorCode::IntentFenced);
}

#[test]
fn live_scope_is_refused_at_publish_and_authorize() {
    let (mut kernel, _paths) = setup("dispatch-scope");
    let fx = happy_fixture(&mut kernel, "task-d3", "attempt-1", "cmd-d3");
    let lease = kernel
        .store_current_generation("task-d3", "native")
        .expect("gen")
        .expect("epoch");
    let mut bundle = bundle_for(&fx, "task-d3", lease.0, &lease.1, &ext_digest(&ext_json()));
    bundle["scope"] = serde_json::Value::String("live".to_owned());
    let err = kernel.publish_intent(&bundle).expect_err("live publish");
    assert_eq!(err.code, KernelErrorCode::ScopeRefused);
    let bundle = bundle_for(&fx, "task-d3", lease.0, &lease.1, &ext_digest(&ext_json()));
    kernel.publish_intent(&bundle).expect("publish");
    let mut req = auth_req(&fx, "http://127.0.0.1:9");
    req.scope = "live".to_owned();
    let err = kernel
        .authorize_native_dispatch(&req)
        .expect_err("live authorize");
    assert_eq!(err.code, KernelErrorCode::ScopeRefused);
}

#[test]
fn stale_lease_is_refused() {
    let (mut kernel, _paths) = setup("dispatch-stale");
    let fx = happy_fixture(&mut kernel, "task-d4", "attempt-1", "cmd-d4");
    let lease = kernel
        .store_current_generation("task-d4", "native")
        .expect("gen")
        .expect("epoch");
    let bundle = bundle_for(&fx, "task-d4", lease.0, &lease.1, &ext_digest(&ext_json()));
    kernel.publish_intent(&bundle).expect("publish");
    kernel
        .acquire_generation("task-d4", "native")
        .expect("advance generation");
    let err = kernel
        .authorize_native_dispatch(&auth_req(&fx, "http://127.0.0.1:9"))
        .expect_err("stale");
    assert_eq!(err.code, KernelErrorCode::StaleLease);
}

#[test]
fn unknown_intent_is_refused() {
    let (mut kernel, _paths) = setup("dispatch-unknown");
    let req = NativeDispatchRequest {
        command_id: "cmd-ghost".to_owned(),
        request_digest: "ab".repeat(32),
        scope: SCOPE_MOCK_E2E.to_owned(),
        endpoint_origin: "http://127.0.0.1:9".to_owned(),
        credential_ref: "credential://connections/connection".to_owned(),
    };
    let err = kernel.authorize_native_dispatch(&req).expect_err("ghost");
    assert_eq!(err.code, KernelErrorCode::IntentUnknown);
}

#[test]
fn non_loopback_endpoint_is_refused_at_authorize() {
    let (mut kernel, _paths) = setup("dispatch-remote");
    let fx = happy_fixture(&mut kernel, "task-d6", "attempt-1", "cmd-d6");
    let lease = kernel
        .store_current_generation("task-d6", "native")
        .expect("gen")
        .expect("epoch");
    let mut ext = ext_json();
    ext["endpoint"] = serde_json::json!({ "protocol": "https", "origin": "https://example.com", "path": "/v1/responses", "method": "POST", "localLoopback": false });
    let digest = ext_digest(&ext);
    kernel.seal_extension(&ext).expect("seal remote ext");
    let bundle = bundle_for(&fx, "task-d6", lease.0, &lease.1, &digest);
    kernel.publish_intent(&bundle).expect("publish");
    let req = auth_req(&fx, "https://example.com");
    let err = kernel
        .authorize_native_dispatch(&req)
        .expect_err("remote origin");
    assert_eq!(err.code, KernelErrorCode::ScopeRefused);
}

fn auth_req(fx: &Fixture, origin: &str) -> NativeDispatchRequest {
    NativeDispatchRequest {
        command_id: fx.command_id.clone(),
        request_digest: fx.request_digest.clone(),
        scope: SCOPE_MOCK_E2E.to_owned(),
        endpoint_origin: origin.to_owned(),
        credential_ref: "credential://connections/connection".to_owned(),
    }
}

#[test]
fn concurrent_authorize_grants_exactly_once() {
    let (mut kernel, _paths) = setup("dispatch-race");
    let fx = happy_fixture(&mut kernel, "task-race", "attempt-1", "cmd-race");
    let lease = kernel
        .store_current_generation("task-race", "native")
        .expect("gen")
        .expect("epoch");
    let bundle = bundle_for(
        &fx,
        "task-race",
        lease.0,
        &lease.1,
        &ext_digest(&ext_json()),
    );
    kernel.publish_intent(&bundle).expect("publish");
    let req = auth_req(&fx, "http://127.0.0.1:9");
    let shared = std::sync::Arc::new(std::sync::Mutex::new(kernel));
    let handles: Vec<std::thread::JoinHandle<bool>> = (0..8)
        .map(|_| {
            let kernel = std::sync::Arc::clone(&shared);
            let req = NativeDispatchRequest {
                command_id: req.command_id.clone(),
                request_digest: req.request_digest.clone(),
                scope: req.scope.clone(),
                endpoint_origin: req.endpoint_origin.clone(),
                credential_ref: req.credential_ref.clone(),
            };
            std::thread::spawn(move || {
                kernel
                    .lock()
                    .expect("kernel mutex")
                    .authorize_native_dispatch(&req)
                    .is_ok()
            })
        })
        .collect();
    let oks = handles
        .into_iter()
        .filter_map(|h| h.join().ok())
        .filter(|granted| *granted)
        .count();
    assert_eq!(
        oks, 1,
        "exactly one racing authorization wins; the rest refuse"
    );
}

fn ext_digest(ext: &serde_json::Value) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(ext))
}
