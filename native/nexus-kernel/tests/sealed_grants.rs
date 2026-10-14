//! A2.4 sealed dispatch grants: the production authority boundary.
//!
//! Proves direct unauthorized transport execution is impossible through the
//! production API: only a kernel-sealed grant verifies, bound to the exact
//! task/attempt/lease/command/target/request, with forged/replayed/expired/
//! cancelled/revoked grants refused and authority re-checked at verify time.

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

fn ext_digest(ext: &serde_json::Value) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(ext))
}

struct Fx {
    issued: nexus_contracts::RegistryResolutionV1,
    command_id: String,
    attempt_id: String,
    request_digest: String,
}

fn fx(kernel: &mut nexus_kernel::Kernel, task: &str, attempt: &str, command: &str) -> Fx {
    let (intent, issued, snapshot) = handshake(kernel, task, attempt, command);
    let command_id = intent.command_id.clone();
    accept(kernel, intent, issued.clone(), snapshot.clone());
    kernel.seal_extension(&ext_json()).expect("seal ext");
    Fx {
        issued,
        command_id,
        attempt_id: attempt.to_owned(),
        request_digest: nexus_contracts::sha256_hex("sealed-bytes"),
    }
}

fn bundle(f: &Fx, task: &str, epoch: u64, inc: &str, extd: &str) -> serde_json::Value {
    serde_json::json!({ "commandId": f.command_id, "taskInstanceId": task, "attemptId": f.attempt_id, "leaseEpoch": epoch, "storeIncarnation": inc, "role": "muse_main", "targetDigest": f.issued.provenance.target_digest, "snapshotDigest": f.issued.provenance.registry_snapshot_digest, "issuanceId": f.issued.provenance.issuance_id, "extensionDigest": extd, "requestDigest": f.request_digest, "sessionId": "session-test", "scope": SCOPE_MOCK_E2E })
}

fn req(f: &Fx) -> NativeDispatchRequest {
    NativeDispatchRequest {
        command_id: f.command_id.clone(),
        request_digest: f.request_digest.clone(),
        scope: SCOPE_MOCK_E2E.to_owned(),
        endpoint_origin: "http://127.0.0.1:9".to_owned(),
        credential_ref: "credential://connections/connection".to_owned(),
    }
}

fn issue(
    task: &str,
    attempt: &str,
    cmd: &str,
) -> (
    nexus_kernel::Kernel,
    nexus_kernel::SealedNativeDispatchGrant,
    Fx,
    common::Paths,
) {
    let (mut kernel, paths) = setup(cmd);
    let f = fx(&mut kernel, task, attempt, cmd);
    let (epoch, inc) = kernel
        .store_current_generation(task, "native")
        .expect("gen")
        .expect("epoch");
    let b = bundle(&f, task, epoch, &inc, &ext_digest(&ext_json()));
    kernel.publish_intent(&b).expect("publish");
    let g = kernel
        .authorize_sealed_dispatch(&req(&f))
        .expect("sealed authorize");
    (kernel, g, f, paths)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[test]
fn sealed_grant_verifies_for_exact_binding() {
    let (mut kernel, g, _f, _paths) = issue("task-sg1", "attempt-1", "cmd-sg1");
    let plain = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect("verify");
    assert_eq!(plain.command_id, g.command_id);
    assert_eq!(plain.attempt_id, g.attempt_id);
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
}

#[test]
fn forged_tag_is_refused() {
    let (mut kernel, mut g, _f, _paths) = issue("task-sg2", "attempt-1", "cmd-sg2");
    g.tag_hex = "00".repeat(32);
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("forged");
    assert_eq!(err.code, KernelErrorCode::ForgedIssuer);
}

#[test]
fn tampered_request_digest_is_refused() {
    let (mut kernel, g, _f, _paths) = issue("task-sg3", "attempt-1", "cmd-sg3");
    let other = "ff".repeat(32);
    let err = kernel
        .verify_sealed_grant(&g, &other, &g.endpoint_origin, &g.credential_ref, now_ms())
        .expect_err("digest drift");
    assert_eq!(err.code, KernelErrorCode::BindingMismatch);
}

#[test]
fn tampered_endpoint_is_refused() {
    let (mut kernel, g, _f, _paths) = issue("task-sg4", "attempt-1", "cmd-sg4");
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            "http://127.0.0.1:10",
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("endpoint drift");
    assert_eq!(err.code, KernelErrorCode::BindingMismatch);
}

#[test]
fn tampered_credential_ref_is_refused() {
    let (mut kernel, g, _f, _paths) = issue("task-sg5", "attempt-1", "cmd-sg5");
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            "credential://connections/other",
            now_ms(),
        )
        .expect_err("cred drift");
    assert_eq!(err.code, KernelErrorCode::BindingMismatch);
}

#[test]
fn expired_grant_is_refused() {
    let (mut kernel, g, _f, _paths) = issue("task-sg6", "attempt-1", "cmd-sg6");
    let late = g.expires_at_ms.saturating_add(1);
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            late,
        )
        .expect_err("expired");
    assert_eq!(err.code, KernelErrorCode::ReservationExpired);
}

#[test]
fn tampered_ttl_is_refused_as_forged() {
    let (mut kernel, mut g, _f, _paths) = issue("task-sg7", "attempt-1", "cmd-sg7");
    g.expires_at_ms = g.issued_at_ms.saturating_add(60_000);
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("ttl tamper");
    assert_eq!(err.code, KernelErrorCode::ForgedIssuer);
}

#[test]
fn stale_lease_after_generation_advance_is_refused() {
    let (mut kernel, g, _f, _paths) = issue("task-sg8", "attempt-1", "cmd-sg8");
    kernel
        .acquire_generation("task-sg8", "native")
        .expect("advance");
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("stale");
    assert_eq!(err.code, KernelErrorCode::StaleLease);
}

#[test]
fn self_issued_grant_without_kernel_key_is_refused() {
    let (_kernel, g, _f, _paths) = issue("task-sg9", "attempt-1", "cmd-sg9");
    let (mut other, _p) = setup("cmd-sg9-other");
    let err = other
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("foreign key");
    assert_eq!(err.code, KernelErrorCode::ForgedIssuer);
}

#[test]
fn grant_for_unknown_command_is_refused() {
    let (mut kernel, mut g, _f, _paths) = issue("task-sg10", "attempt-1", "cmd-sg10");
    g.command_id = "cmd-ghost".to_owned();
    let err = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("ghost");
    assert!(matches!(
        err.code,
        KernelErrorCode::ForgedIssuer | KernelErrorCode::IntentUnknown
    ));
}

#[test]
fn second_authorize_after_sealed_is_conflict() {
    let (mut kernel, _g, f, _paths) = issue("task-sg11", "attempt-1", "cmd-sg11");
    let err = kernel
        .authorize_sealed_dispatch(&req(&f))
        .expect_err("replay authorize");
    assert_eq!(err.code, KernelErrorCode::CommandConflict);
    let err2 = kernel
        .authorize_native_dispatch(&req(&f))
        .expect_err("plain replay");
    assert_eq!(err2.code, KernelErrorCode::CommandConflict);
}

#[test]
fn concurrent_sealed_authorize_grants_exactly_once() {
    let (mut kernel, _paths) = setup("sealed-race");
    let f = fx(
        &mut kernel,
        "task-race-sealed",
        "attempt-1",
        "cmd-race-sealed",
    );
    let (epoch, inc) = kernel
        .store_current_generation("task-race-sealed", "native")
        .expect("gen")
        .expect("epoch");
    let b = bundle(
        &f,
        "task-race-sealed",
        epoch,
        &inc,
        &ext_digest(&ext_json()),
    );
    kernel.publish_intent(&b).expect("publish");
    let base = req(&f);
    let shared = std::sync::Arc::new(std::sync::Mutex::new(kernel));
    let handles: Vec<std::thread::JoinHandle<bool>> = (0..8)
        .map(|_| {
            let kernel = std::sync::Arc::clone(&shared);
            let r = nexus_kernel::NativeDispatchRequest {
                command_id: base.command_id.clone(),
                request_digest: base.request_digest.clone(),
                scope: base.scope.clone(),
                endpoint_origin: base.endpoint_origin.clone(),
                credential_ref: base.credential_ref.clone(),
            };
            std::thread::spawn(move || {
                kernel
                    .lock()
                    .expect("kernel mutex")
                    .authorize_sealed_dispatch(&r)
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
        "exactly one racing sealed authorization wins; the rest refuse"
    );
}
