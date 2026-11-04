//! A5.1 model-only scope: the kernel side of the controlled pilot.
//!
//! Proves: disabled by default; explicit user initiator required; origin
//! policy (loopback or public https only); durable single-use redemption;
//! the scope never relaxes `dispatch_enabled()`/`authorize_dispatch()`; the
//! mock-e2e scope keeps its loopback-only rule.

mod common;

use common::{accept, handshake, setup};
use nexus_contracts::KernelErrorCode;
use nexus_kernel::{
    NativeDispatchRequest, INITIATOR_USER_EXPLICIT, SCOPE_MOCK_E2E, SCOPE_MODEL_ONLY,
};

fn ext_json(origin: &str, protocol: &str, loopback: bool) -> serde_json::Value {
    serde_json::json!({
        "extensionVersion": 1,
        "endpoint": { "protocol": protocol, "origin": origin, "path": "/v1/responses", "method": "POST", "localLoopback": loopback },
        "remoteModelIdConfirmed": "remote-model",
        "reasoningEffort": "low",
        "billing": { "tier": "metered", "dataUse": "standard" },
        "session": { "sessionId": "session-test" },
        "capabilities": ["text"],
        "contextLimitTokens": 8192,
        "outputLimitTokens": 1024,
        "connectionBinding": "connection",
        "credentialRef": "credential://connections/connection"
    })
}

fn digest(v: &serde_json::Value) -> String {
    nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(v))
}

struct Fx {
    issued: nexus_contracts::RegistryResolutionV1,
    command_id: String,
    attempt_id: String,
    task: String,
    request_digest: String,
}

fn fx(kernel: &mut nexus_kernel::Kernel, task: &str, cmd: &str, ext: &serde_json::Value) -> Fx {
    let (intent, issued, snapshot) = handshake(kernel, task, "attempt-1", cmd);
    let command_id = intent.command_id.clone();
    accept(kernel, intent, issued.clone(), snapshot);
    kernel.seal_extension(ext).expect("seal ext");
    Fx {
        issued,
        command_id,
        attempt_id: "attempt-1".to_owned(),
        task: task.to_owned(),
        request_digest: nexus_contracts::sha256_hex("model-only-bytes"),
    }
}

fn bundle(
    kernel: &mut nexus_kernel::Kernel,
    f: &Fx,
    ext: &serde_json::Value,
    scope: &str,
    initiator: Option<&str>,
) -> serde_json::Value {
    let (epoch, inc) = kernel
        .store_current_generation(&f.task, "native")
        .expect("gen")
        .expect("epoch");
    let mut b = serde_json::json!({
        "commandId": f.command_id, "taskInstanceId": f.task, "attemptId": f.attempt_id,
        "leaseEpoch": epoch, "storeIncarnation": inc, "role": "muse_main",
        "targetDigest": f.issued.provenance.target_digest,
        "snapshotDigest": f.issued.provenance.registry_snapshot_digest,
        "issuanceId": f.issued.provenance.issuance_id,
        "extensionDigest": digest(ext), "requestDigest": f.request_digest,
        "sessionId": "session-test", "scope": scope,
    });
    if let Some(i) = initiator {
        b["initiator"] = serde_json::json!(i);
    }
    b
}

fn req(f: &Fx, origin: &str, scope: &str) -> NativeDispatchRequest {
    NativeDispatchRequest {
        command_id: f.command_id.clone(),
        request_digest: f.request_digest.clone(),
        scope: scope.to_owned(),
        endpoint_origin: origin.to_owned(),
        credential_ref: "credential://connections/connection".to_owned(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[test]
fn pilot_is_off_by_default_and_refuses_publication() {
    let (mut kernel, _p) = setup("cmd-mo1");
    let ext = ext_json("https://api.example.com:443", "https", false);
    let f = fx(&mut kernel, "task-mo1", "cmd-mo1", &ext);
    assert!(!kernel.model_only_pilot_enabled());
    let b = bundle(
        &mut kernel,
        &f,
        &ext,
        SCOPE_MODEL_ONLY,
        Some(INITIATOR_USER_EXPLICIT),
    );
    let err = kernel.publish_intent(&b).expect_err("pilot off");
    assert_eq!(err.code, KernelErrorCode::ScopeRefused);
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
}

#[test]
fn explicit_user_initiator_is_required() {
    let (mut kernel, _p) = setup("cmd-mo2");
    kernel.enable_model_only_pilot();
    let ext = ext_json("https://api.example.com:443", "https", false);
    let f = fx(&mut kernel, "task-mo2", "cmd-mo2", &ext);
    for bad in [None, Some("autonomous-workflow"), Some("")] {
        let b = bundle(&mut kernel, &f, &ext, SCOPE_MODEL_ONLY, bad);
        let err = kernel.publish_intent(&b).expect_err("initiator refused");
        assert_eq!(err.code, KernelErrorCode::ScopeRefused, "{bad:?}");
    }
    let b = bundle(
        &mut kernel,
        &f,
        &ext,
        SCOPE_MODEL_ONLY,
        Some(INITIATOR_USER_EXPLICIT),
    );
    kernel
        .publish_intent(&b)
        .expect("explicit user intent publishes");
}

#[test]
fn origin_policy_allows_loopback_and_public_https_only() {
    for (i, (origin, protocol, loopback, allowed)) in [
        ("http://127.0.0.1:9", "http", true, true),
        ("https://api.example.com:443", "https", false, true),
        ("http://api.example.com:80", "http", false, false),
        ("https://10.0.0.5:443", "https", false, false),
        ("https://169.254.169.254:443", "https", false, false),
        ("https://localhost:443", "https", false, false),
        ("https://[fd00::1]:443", "https", false, false),
        ("https://2130706433:443", "https", false, false),
        ("https://metadata:443", "https", false, false),
    ]
    .into_iter()
    .enumerate()
    {
        let cmd = format!("cmd-mo3-{i}");
        let (mut kernel, _p) = setup(&cmd);
        kernel.enable_model_only_pilot();
        let ext = ext_json(origin, protocol, loopback);
        let f = fx(&mut kernel, &format!("task-mo3-{i}"), &cmd, &ext);
        let b = bundle(
            &mut kernel,
            &f,
            &ext,
            SCOPE_MODEL_ONLY,
            Some(INITIATOR_USER_EXPLICIT),
        );
        let r = kernel.publish_intent(&b);
        assert_eq!(r.is_ok(), allowed, "{origin}: {r:?}");
        if let Err(e) = r {
            assert_eq!(e.code, KernelErrorCode::ScopeRefused, "{origin}");
        }
    }
}

#[test]
fn mock_scope_keeps_its_loopback_only_rule() {
    let (mut kernel, _p) = setup("cmd-mo4");
    kernel.enable_model_only_pilot();
    let ext = ext_json("https://api.example.com:443", "https", false);
    let f = fx(&mut kernel, "task-mo4", "cmd-mo4", &ext);
    let b = bundle(&mut kernel, &f, &ext, SCOPE_MOCK_E2E, None);
    kernel
        .publish_intent(&b)
        .expect("publish is scope-agnostic on origin");
    let err = kernel
        .authorize_sealed_dispatch(&req(&f, "https://api.example.com:443", SCOPE_MOCK_E2E))
        .expect_err("mock scope never reaches a public host");
    assert_eq!(err.code, KernelErrorCode::ScopeRefused);
}

#[test]
fn redemption_is_durable_and_single_use() {
    let (mut kernel, paths) = setup("cmd-mo5");
    kernel.enable_model_only_pilot();
    let ext = ext_json("http://127.0.0.1:9", "http", true);
    let f = fx(&mut kernel, "task-mo5", "cmd-mo5", &ext);
    let b = bundle(
        &mut kernel,
        &f,
        &ext,
        SCOPE_MODEL_ONLY,
        Some(INITIATOR_USER_EXPLICIT),
    );
    kernel.publish_intent(&b).expect("publish");
    let g = kernel
        .authorize_sealed_dispatch(&req(&f, "http://127.0.0.1:9", SCOPE_MODEL_ONLY))
        .expect("authorize");
    assert_eq!(g.scope, SCOPE_MODEL_ONLY);
    // A non-redeeming verification still passes (in-process legacy path).
    kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect("verify");
    kernel
        .redeem_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect("first redemption");
    let again = kernel
        .redeem_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("second redemption");
    assert_eq!(again.code, KernelErrorCode::CommandConflict);
    let verify = kernel
        .verify_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("redeemed grant no longer verifies");
    assert_eq!(verify.code, KernelErrorCode::CommandConflict);
    let reauth = kernel
        .authorize_sealed_dispatch(&req(&f, "http://127.0.0.1:9", SCOPE_MODEL_ONLY))
        .expect_err("no second grant");
    assert_eq!(reauth.code, KernelErrorCode::CommandConflict);
    // Durable across a kernel restart on the same store.
    drop(kernel);
    let mut reopened = nexus_kernel::Kernel::open(&paths.db, Some(&paths.witness)).expect("reopen");
    reopened.enable_model_only_pilot();
    let after = reopened
        .redeem_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect_err("redemption survives restart");
    assert_eq!(after.code, KernelErrorCode::CommandConflict);
}

#[test]
fn model_only_grants_confer_no_general_dispatch_authority() {
    let (mut kernel, _p) = setup("cmd-mo6");
    kernel.enable_model_only_pilot();
    let ext = ext_json("http://127.0.0.1:9", "http", true);
    let f = fx(&mut kernel, "task-mo6", "cmd-mo6", &ext);
    let b = bundle(
        &mut kernel,
        &f,
        &ext,
        SCOPE_MODEL_ONLY,
        Some(INITIATOR_USER_EXPLICIT),
    );
    kernel.publish_intent(&b).expect("publish");
    let _g = kernel
        .authorize_sealed_dispatch(&req(&f, "http://127.0.0.1:9", SCOPE_MODEL_ONLY))
        .expect("authorize");
    assert!(!nexus_kernel::Kernel::dispatch_enabled());
    let err = kernel
        .authorize_dispatch(&f.command_id)
        .expect_err("still refuses");
    assert_eq!(err.code, KernelErrorCode::DispatchDisabled);
    // The legacy plain path (A2.3) still admits only mock-e2e.
    let plain = kernel
        .authorize_native_dispatch(&req(&f, "http://127.0.0.1:9", SCOPE_MODEL_ONLY))
        .expect_err("plain path is mock-only");
    assert_eq!(plain.code, KernelErrorCode::ScopeRefused);
}

#[test]
fn concurrent_redemption_has_exactly_one_winner_across_kernel_handles() {
    // Two independent kernel handles over the same durable store race to
    // redeem one grant: the atomic executed -> redeemed transition admits
    // exactly one; the loser is a command-conflict, never a second send.
    let (mut kernel, paths) = setup("cmd-mo7");
    kernel.enable_model_only_pilot();
    let ext = ext_json("http://127.0.0.1:9", "http", true);
    let f = fx(&mut kernel, "task-mo7", "cmd-mo7", &ext);
    let b = bundle(
        &mut kernel,
        &f,
        &ext,
        SCOPE_MODEL_ONLY,
        Some(INITIATOR_USER_EXPLICIT),
    );
    kernel.publish_intent(&b).expect("publish");
    let g = kernel
        .authorize_sealed_dispatch(&req(&f, "http://127.0.0.1:9", SCOPE_MODEL_ONLY))
        .expect("authorize");
    drop(kernel);
    let wins = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let conflicts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut hs = Vec::new();
    for _ in 0..6 {
        let (db, wit, g) = (paths.db.clone(), paths.witness.clone(), g.clone());
        let (w, c) = (wins.clone(), conflicts.clone());
        hs.push(std::thread::spawn(move || {
            let mut k = nexus_kernel::Kernel::open(&db, Some(&wit)).expect("open");
            k.enable_model_only_pilot();
            match k.redeem_sealed_grant(
                &g,
                &g.request_digest,
                &g.endpoint_origin,
                &g.credential_ref,
                now_ms(),
            ) {
                Ok(_) => {
                    w.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Err(e) if e.code == KernelErrorCode::CommandConflict => {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Err(e) => panic!("unexpected refusal: {e:?}"),
            }
        }));
    }
    for h in hs {
        h.join().expect("thread");
    }
    assert_eq!(wins.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(conflicts.load(std::sync::atomic::Ordering::SeqCst), 5);
}

#[test]
fn grant_is_bound_to_scope_task_attempt_and_kernel_key() {
    let (mut kernel, _p) = setup("cmd-mo8");
    kernel.enable_model_only_pilot();
    let ext = ext_json("http://127.0.0.1:9", "http", true);
    let f = fx(&mut kernel, "task-mo8", "cmd-mo8", &ext);
    let b = bundle(
        &mut kernel,
        &f,
        &ext,
        SCOPE_MODEL_ONLY,
        Some(INITIATOR_USER_EXPLICIT),
    );
    kernel.publish_intent(&b).expect("publish");
    let g = kernel
        .authorize_sealed_dispatch(&req(&f, "http://127.0.0.1:9", SCOPE_MODEL_ONLY))
        .expect("authorize");
    // Any field changed after minting breaks the kernel HMAC: the grant is
    // not transferable to another task, attempt, scope, lease or origin.
    let mut tampered = Vec::new();
    let mut t = g.clone();
    t.task_instance_id = "task-other".into();
    tampered.push(("task", t));
    let mut t = g.clone();
    t.attempt_id = "attempt-other".into();
    tampered.push(("attempt", t));
    let mut t = g.clone();
    t.scope = SCOPE_MOCK_E2E.into();
    tampered.push(("scope", t));
    let mut t = g.clone();
    t.lease_epoch += 1;
    tampered.push(("lease", t));
    let mut t = g.clone();
    t.expires_at_ms += 1_000_000;
    tampered.push(("ttl", t));
    for (what, t) in tampered {
        let e = kernel
            .redeem_sealed_grant(
                &t,
                &t.request_digest,
                &t.endpoint_origin,
                &t.credential_ref,
                now_ms(),
            )
            .expect_err(what);
        assert_ne!(e.code, KernelErrorCode::StoreCorrupt, "{what}");
    }
    // None of the forged redemptions consumed the real grant.
    kernel
        .redeem_sealed_grant(
            &g,
            &g.request_digest,
            &g.endpoint_origin,
            &g.credential_ref,
            now_ms(),
        )
        .expect("genuine grant still redeems exactly once");
}
