//! A2.3 mock-E2E: Controller + Registry + Kernel + transport, no DSH.
//!
//! Real nexusd subprocess, REAL JS authority code (issuer, shadow intent,
//! V2 issuance, intent bundle via node one-shots), real kernel seals, and a
//! loopback mock provider. Asserts the exact authorized bytes reach the
//! mock, terminal outcomes bind to the Controller attempt, and restarts,
//! replays, fences, and forgeries behave. No live traffic, no secrets.

mod common;

use common::{authed_frame, code_of, nexusd_bin, raw_request, read_cap, spawn_daemon, terminate};
use nexus_model::testkit::{self, LocalMockServer, MockHttpResponse};
use nexus_model::{
    AttemptState, AttemptStore, AttemptTracker, CancellationToken, Credential, ExecutionTargetV2,
    HttpSseTransport, ModelRequest, ModelRuntime, OfflineModelRuntime, TransportBinding,
    TransportLimits, VerifiedExecutionPin,
};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TASK_ID: &str = "TASK-E2E-1";
const ATTEMPT_ID: &str = "TASK-E2E-1-A1";
const TASK_INSTANCE: &str = "task-e2e-1";
const SESSION_ID: &str = "session-e2e-1";
const SECRET_MARKER: &str = "sk-e2e-test-marker";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn driver() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("e2e")
        .join("driver.cjs")
}

fn node_json(args: &[&str], stdin: Option<&str>) -> serde_json::Value {
    let mut cmd = Command::new("node");
    cmd.arg(driver()).args(args);
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::inherit());
    let mut child = cmd.spawn().expect("spawn node driver");
    if let Some(text) = stdin {
        use std::io::Write;
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(text.as_bytes())
            .expect("write stdin");
    }
    let out = child.wait_with_output().expect("node driver output");
    assert!(out.status.success(), "node driver failed: {:?}", args[0]);
    serde_json::from_slice(&out.stdout).expect("driver prints one JSON line")
}

fn write_ledger(workspace: &Path) {
    let state = workspace.join(".ai-harness").join("state");
    let runs = workspace.join(".ai-harness").join("runs").join(TASK_ID);
    std::fs::create_dir_all(&state).expect("state dir");
    std::fs::create_dir_all(&runs).expect("runs dir");
    std::fs::write(
        state.join("tasks.json"),
        serde_json::json!({ "schemaVersion": 1, "nextSequence": 2, "tasks": [{ "taskId": TASK_ID, "taskInstanceId": TASK_INSTANCE, "attemptCount": 1 }] }).to_string(),
    )
    .expect("tasks.json");
    let attempt = serde_json::json!({ "taskId": TASK_ID, "taskInstanceId": TASK_INSTANCE, "attemptId": ATTEMPT_ID, "sequence": 1, "status": "started", "executionClass": "muse_main", "sessionId": SESSION_ID, "startedByTurn": "turn-1" });
    std::fs::write(runs.join("attempts.jsonl"), attempt.to_string() + "\n")
        .expect("attempts.jsonl");
}

fn call(
    proc_socket: &Path,
    cap_hex: &str,
    cmd: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let frame = authed_frame(cap_hex, cmd, params);
    raw_request(proc_socket, &frame).expect("daemon responds")
}

fn assert_ok(resp: &serde_json::Value, what: &str) -> serde_json::Value {
    assert_eq!(
        resp.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "{what} refused: {resp}"
    );
    resp.clone()
}

fn wait_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = raw_request(
            socket,
            "{\"protocol\":1,\"id\":\"ready-poll\",\"cmd\":\"health\",\"params\":{}}",
        ) {
            if resp.get("ok") == Some(&serde_json::Value::Bool(true)) {
                return;
            }
        }
        assert!(Instant::now() < deadline, "daemon never became ready");
        std::thread::sleep(Duration::from_millis(25));
    }
}

struct Ctx {
    _tmp: tempfile::TempDir,
    proc_: common::DaemonProc,
    cap_hex: String,
    _data_root: PathBuf,
    _workspace: PathBuf,
    _repo: PathBuf,
    mock: LocalMockServer,
    resolution: serde_json::Value,
    snapshot: serde_json::Value,
    core: serde_json::Value,
    extension: serde_json::Value,
    extension_digest: String,
    _issuance_id: String,

    shadow_intent: serde_json::Value,
    kernel_intent: serde_json::Value,
    lease_epoch: u64,
    incarnation: String,
}

fn setup_e2e() -> Ctx {
    let tmp = tempfile::tempdir().expect("tempdir");
    let data_root = tmp.path().join("registry");
    std::fs::create_dir_all(&data_root).expect("dataroot");
    let workspace = tmp.path().join("ws");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let repo = repo_root();
    let fixture = testkit::load_fixture("basic-text");
    let mock = LocalMockServer::serve(vec![MockHttpResponse::sse(&fixture.sse_body)], 8);
    let port = mock.addr.port().to_string();
    let reg = node_json(
        &[
            "registry",
            data_root.to_str().expect("utf8"),
            repo.to_str().expect("utf8"),
            port.as_str(),
        ],
        None,
    );
    assert_eq!(
        reg.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "fixture registry: {reg}"
    );
    write_ledger(&workspace);
    let issued = node_json(
        &[
            "issue",
            repo.to_str().expect("utf8"),
            data_root.to_str().expect("utf8"),
            TASK_INSTANCE,
            SESSION_ID,
        ],
        None,
    );
    assert_eq!(
        issued.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "issuance: {issued}"
    );
    let shadow = node_json(
        &[
            "intent",
            workspace.to_str().expect("utf8"),
            TASK_ID,
            ATTEMPT_ID,
            TASK_INSTANCE,
        ],
        None,
    );
    assert_eq!(
        shadow.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "shadow intent: {shadow}"
    );
    let proc = spawn_daemon("shadow-test", true);
    let cap_hex = read_cap(&proc.cap);
    let answer = call(
        &proc.socket,
        &cap_hex,
        "acquire",
        serde_json::json!({ "taskInstanceId": TASK_INSTANCE, "backend": "native" }),
    );
    let ok = assert_ok(&answer, "acquire");
    let lease_epoch = ok
        .get("lease")
        .and_then(|v| v.get("leaseEpoch"))
        .and_then(|v| v.as_u64())
        .expect("epoch");
    let incarnation = ok
        .get("lease")
        .and_then(|v| v.get("storeIncarnation"))
        .and_then(|v| v.as_str())
        .expect("incarnation")
        .to_owned();
    let seal = call(
        &proc.socket,
        &cap_hex,
        "seal",
        serde_json::json!({ "resolution": issued.get("resolution").expect("resolution") }),
    );
    assert_ok(&seal, "seal");
    let seal_ext = call(
        &proc.socket,
        &cap_hex,
        "seal-extension",
        serde_json::json!({ "extension": issued.get("extension").expect("extension") }),
    );
    let seal_ext_ok = assert_ok(&seal_ext, "seal-extension");
    let sealed_digest = seal_ext_ok
        .get("extensionDigest")
        .and_then(|v| v.as_str())
        .expect("digest")
        .to_owned();
    assert_eq!(
        sealed_digest,
        issued
            .get("extensionDigest")
            .and_then(|v| v.as_str())
            .expect("js digest"),
        "Rust seal digest matches JS issuance digest"
    );
    let kernel_intent_in = serde_json::json!({
        "shadowIntent": shadow.get("intent").expect("intent"),
        "issuance": {
            "modeId": issued.get("modeId").expect("modeId"),
            "role": issued.get("role").expect("role"),
            "modeConfigRevision": issued.get("modeConfigRevision").expect("modeConfigRevision"),
            "modeConfigDigest": issued.get("modeConfigDigest").expect("modeConfigDigest"),
        },
    });
    let kernel_intent_out = node_json(&["kernel-intent"], Some(&kernel_intent_in.to_string()));
    assert_eq!(
        kernel_intent_out.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "kernel intent: {kernel_intent_out}"
    );
    Ctx {
        _tmp: tmp,
        proc_: proc,
        cap_hex,
        _data_root: data_root,
        _workspace: workspace,
        _repo: repo,
        mock,
        resolution: issued.get("resolution").expect("resolution").clone(),
        snapshot: issued.get("snapshot").expect("snapshot").clone(),
        core: issued.get("core").expect("core").clone(),
        extension: issued.get("extension").expect("extension").clone(),
        extension_digest: sealed_digest,
        _issuance_id: issued
            .get("issuanceId")
            .and_then(|v| v.as_str())
            .expect("issuanceId")
            .to_owned(),
        shadow_intent: shadow.get("intent").expect("intent").clone(),
        kernel_intent: kernel_intent_out.get("intent").expect("intent").clone(),
        lease_epoch,
        incarnation,
    }
}

fn model_pin_and_target(ctx: &Ctx) -> (ExecutionTargetV2, VerifiedExecutionPin) {
    let core: nexus_contracts::ExecutionTargetCoreV1 =
        serde_json::from_value(ctx.core.clone()).expect("core");
    let target = ExecutionTargetV2::from_extension_json(core, &ctx.extension).expect("target");
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let intent_digest = ctx
        .kernel_intent
        .get("intentDigest")
        .and_then(|v| v.as_str())
        .expect("intentDigest");
    let command_digest = nexus_contracts::KernelCommandV1::compute_digest(
        intent_digest,
        &issued.provenance.target_digest,
        &issued.provenance.registry_snapshot_digest,
        ctx.lease_epoch,
        &ctx.incarnation,
    );
    let pin = VerifiedExecutionPin::bind(
        TASK_INSTANCE,
        ctx.shadow_intent
            .get("commandId")
            .and_then(|v| v.as_str())
            .expect("commandId"),
        ATTEMPT_ID,
        ctx.lease_epoch,
        &ctx.incarnation,
        &issued,
        &ctx.snapshot,
        &target,
        &command_digest,
    )
    .expect("pin");
    (target, pin)
}

#[test]
fn e2e_mock_happy_path() {
    let mut ctx = setup_e2e();
    let socket = &ctx.proc_.socket;
    let (target, pin) = model_pin_and_target(&ctx);
    assert_eq!(
        target.extension_digest(),
        ctx.extension_digest,
        "Rust digest matches JS issuance digest"
    );
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let mercury = OfflineModelRuntime::new(
        nexus_model::testkit::MockTransport::new(
            nexus_model::testkit::MockScript::CleanStream {
                body: String::new(),
            },
            "",
        ),
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let input = ModelRequest::text_only("user", "answer in one sentence");
    let prepared = mercury
        .prepare(&pin, &issued, &ctx.snapshot, &target, &input)
        .expect("prepare");
    assert_eq!(
        prepared.endpoint_origin,
        ctx.mock.origin(),
        "prepared origin is the mock provider"
    );
    let publish_in = serde_json::json!({
        "shadowIntent": ctx.shadow_intent,
        "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        "role": "muse_main",
        "issuance": { "taskInstanceId": TASK_INSTANCE, "resolution": ctx.resolution },
        "extensionDigest": ctx.extension_digest,
        "requestDigest": prepared.request_digest,
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let published_out = node_json(&["publish"], Some(&publish_in.to_string()));
    assert_eq!(
        published_out.get("ok"),
        Some(&serde_json::Value::Bool(true)),
        "publish bundle: {published_out}"
    );
    let bundle = published_out.get("bundle").expect("bundle").clone();
    let pub_resp = call(
        socket,
        &ctx.cap_hex,
        "intent-publish",
        serde_json::json!({ "intent": bundle }),
    );
    assert_ok(&pub_resp, "intent-publish");
    let accept_resp = call(
        socket,
        &ctx.cap_hex,
        "accept",
        serde_json::json!({
            "intent": ctx.kernel_intent,
            "resolution": ctx.resolution,
            "snapshot": ctx.snapshot,
            "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        }),
    );
    let accept_ok = assert_ok(&accept_resp, "accept");
    assert_eq!(
        accept_ok.get("replayed"),
        Some(&serde_json::Value::Bool(false))
    );
    let auth_resp = call(
        socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": prepared.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    let grant = assert_ok(&auth_resp, "dispatch-authorize");
    assert_eq!(
        grant
            .get("grant")
            .and_then(|v| v.get("scope"))
            .and_then(|v| v.as_str()),
        Some("mock-e2e")
    );
    let runtime = OfflineModelRuntime::new(
        HttpSseTransport::new(TransportBinding::new(&ctx.mock.origin())),
        TransportBinding::new(&ctx.mock.origin()),
        TransportLimits::default(),
    );
    let attested = runtime
        .attest(&pin, &issued, &ctx.snapshot, &target, prepared)
        .expect("attest");
    let mut attempt = AttemptTracker::new(ATTEMPT_ID);
    let mut store = AttemptStore::new();
    let credential = Credential::test_credential(SECRET_MARKER);
    let terminal = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential,
            &CancellationToken::new(),
        )
        .expect("dispatch");
    assert_eq!(terminal.text, "Hello, world.");
    assert_eq!(attempt.state(), AttemptState::TerminalCommitted);
    let observed = ctx.mock.observed();
    let body = observed.request_body.lock().expect("mutex").clone();
    let sent: serde_json::Value = serde_json::from_slice(&body).expect("server body");
    assert_eq!(
        sent.get("model").and_then(|v| v.as_str()),
        Some("e2e-mock-model")
    );
    assert!(
        !String::from_utf8_lossy(&body).contains(SECRET_MARKER),
        "no secret reached the provider"
    );
    assert_eq!(
        observed
            .auth_present
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let again = call(
        socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": terminal.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_eq!(code_of(&again), "command-conflict");
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_forged_issuance_cannot_publish() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let bundle = serde_json::json!({
        "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
        "taskInstanceId": TASK_INSTANCE,
        "attemptId": ATTEMPT_ID,
        "leaseEpoch": ctx.lease_epoch,
        "storeIncarnation": ctx.incarnation,
        "role": "muse_main",
        "targetDigest": "ff".repeat(32),
        "snapshotDigest": "ee".repeat(32),
        "issuanceId": "dd".repeat(32),
        "extensionDigest": ctx.extension_digest,
        "requestDigest": "cc".repeat(32),
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let resp = call(
        &socket,
        &ctx.cap_hex,
        "intent-publish",
        serde_json::json!({ "intent": bundle }),
    );
    assert_eq!(
        code_of(&resp),
        "forged-issuer",
        "unsealed issuance never publishes: {resp}"
    );
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_tampered_request_digest_refused() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let (target, pin) = model_pin_and_target(&ctx);
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let probe_runtime = OfflineModelRuntime::new(
        nexus_model::testkit::MockTransport::new(
            nexus_model::testkit::MockScript::CleanStream {
                body: String::new(),
            },
            "",
        ),
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let prepared = probe_runtime
        .prepare(
            &pin,
            &issued,
            &ctx.snapshot,
            &target,
            &ModelRequest::text_only("user", "answer in one sentence"),
        )
        .expect("prepare");
    let publish_in = serde_json::json!({
        "shadowIntent": ctx.shadow_intent,
        "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        "role": "muse_main",
        "issuance": { "taskInstanceId": TASK_INSTANCE, "resolution": ctx.resolution },
        "extensionDigest": ctx.extension_digest,
        "requestDigest": prepared.request_digest,
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let published_out = node_json(&["publish"], Some(&publish_in.to_string()));
    let bundle = published_out.get("bundle").expect("bundle").clone();
    assert_ok(
        &call(
            &socket,
            &ctx.cap_hex,
            "intent-publish",
            serde_json::json!({ "intent": bundle }),
        ),
        "intent-publish",
    );
    let accept_resp = call(
        &socket,
        &ctx.cap_hex,
        "accept",
        serde_json::json!({
            "intent": ctx.kernel_intent,
            "resolution": ctx.resolution,
            "snapshot": ctx.snapshot,
            "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        }),
    );
    assert_ok(&accept_resp, "accept");
    let evil = call(
        &socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": "bb".repeat(32),
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_eq!(
        code_of(&evil),
        "binding-mismatch",
        "tampered request digest refused: {evil}"
    );
    terminate(&mut ctx.proc_.child);
}

fn respawn(ctx: &mut Ctx) {
    terminate(&mut ctx.proc_.child);
    let db = ctx.proc_.db.clone();
    let socket = ctx.proc_.socket.clone();
    let cap = ctx.proc_.cap.clone();
    let witness = ctx.proc_.witness.clone();
    let mut cmd = Command::new(nexusd_bin());
    cmd.arg("--db")
        .arg(&db)
        .arg("--socket")
        .arg(&socket)
        .arg("--cap")
        .arg(&cap)
        .arg("--trust-mode")
        .arg("shadow-test")
        .arg("--witness")
        .arg(&witness)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ctx.proc_.child = cmd.spawn().expect("respawn nexusd");
    wait_ready(&socket);
}

#[test]
fn e2e_restart_heals_without_reexecution() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let (target, pin) = model_pin_and_target(&ctx);
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let probe_runtime = OfflineModelRuntime::new(
        nexus_model::testkit::MockTransport::new(
            nexus_model::testkit::MockScript::CleanStream {
                body: String::new(),
            },
            "",
        ),
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let input = ModelRequest::text_only("user", "answer in one sentence");
    let prepared = probe_runtime
        .prepare(&pin, &issued, &ctx.snapshot, &target, &input)
        .expect("prepare");
    let publish_in = serde_json::json!({
        "shadowIntent": ctx.shadow_intent,
        "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        "role": "muse_main",
        "issuance": { "taskInstanceId": TASK_INSTANCE, "resolution": ctx.resolution },
        "extensionDigest": ctx.extension_digest,
        "requestDigest": prepared.request_digest,
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let published_out = node_json(&["publish"], Some(&publish_in.to_string()));
    assert_eq!(
        published_out.get("ok"),
        Some(&serde_json::Value::Bool(true))
    );
    let bundle = published_out.get("bundle").expect("bundle").clone();
    assert_ok(
        &call(
            &socket,
            &ctx.cap_hex,
            "intent-publish",
            serde_json::json!({ "intent": bundle }),
        ),
        "intent-publish",
    );
    let accept_resp = call(
        &socket,
        &ctx.cap_hex,
        "accept",
        serde_json::json!({
            "intent": ctx.kernel_intent,
            "resolution": ctx.resolution,
            "snapshot": ctx.snapshot,
            "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        }),
    );
    assert_ok(&accept_resp, "accept");
    let auth_resp = call(
        &socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": prepared.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_ok(&auth_resp, "dispatch-authorize");
    respawn(&mut ctx);
    let socket2 = ctx.proc_.socket.clone();
    ctx.cap_hex = read_cap(&ctx.proc_.cap);
    let receipt = call(
        &socket2,
        &ctx.cap_hex,
        "receipt",
        serde_json::json!({ "commandId": ctx.shadow_intent.get("commandId").expect("commandId") }),
    );
    let receipt_ok = assert_ok(&receipt, "receipt-after-restart");
    assert!(
        receipt_ok.get("receipt").is_some(),
        "receipt survives restart"
    );
    let accept_again = call(
        &socket2,
        &ctx.cap_hex,
        "accept",
        serde_json::json!({
            "intent": ctx.kernel_intent,
            "resolution": ctx.resolution,
            "snapshot": ctx.snapshot,
            "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        }),
    );
    assert_eq!(
        accept_again.get("replayed"),
        Some(&serde_json::Value::Bool(true)),
        "identical replay heals"
    );
    let again = call(
        &socket2,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": prepared.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_eq!(
        code_of(&again),
        "command-conflict",
        "executed intent never re-authorizes"
    );
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_stale_lease_refused_after_advance() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let (target, pin) = model_pin_and_target(&ctx);
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let probe_runtime = OfflineModelRuntime::new(
        nexus_model::testkit::MockTransport::new(
            nexus_model::testkit::MockScript::CleanStream {
                body: String::new(),
            },
            "",
        ),
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let prepared = probe_runtime
        .prepare(
            &pin,
            &issued,
            &ctx.snapshot,
            &target,
            &ModelRequest::text_only("user", "x"),
        )
        .expect("prepare");
    let publish_in = serde_json::json!({
        "shadowIntent": ctx.shadow_intent,
        "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        "role": "muse_main",
        "issuance": { "taskInstanceId": TASK_INSTANCE, "resolution": ctx.resolution },
        "extensionDigest": ctx.extension_digest,
        "requestDigest": prepared.request_digest,
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let published_out = node_json(&["publish"], Some(&publish_in.to_string()));
    let bundle = published_out.get("bundle").expect("bundle").clone();
    assert_ok(
        &call(
            &socket,
            &ctx.cap_hex,
            "intent-publish",
            serde_json::json!({ "intent": bundle }),
        ),
        "intent-publish",
    );
    let accept_resp = call(
        &socket,
        &ctx.cap_hex,
        "accept",
        serde_json::json!({
            "intent": ctx.kernel_intent,
            "resolution": ctx.resolution,
            "snapshot": ctx.snapshot,
            "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        }),
    );
    assert_ok(&accept_resp, "accept");
    let advance = call(
        &socket,
        &ctx.cap_hex,
        "acquire",
        serde_json::json!({ "taskInstanceId": TASK_INSTANCE, "backend": "native" }),
    );
    assert_ok(&advance, "advance generation");
    let stale = call(
        &socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": prepared.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_eq!(
        code_of(&stale),
        "stale-lease",
        "advanced generation refuses old lease: {stale}"
    );
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_fence_blocks_dispatch() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let (target, pin) = model_pin_and_target(&ctx);
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let probe_runtime = OfflineModelRuntime::new(
        nexus_model::testkit::MockTransport::new(
            nexus_model::testkit::MockScript::CleanStream {
                body: String::new(),
            },
            "",
        ),
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let prepared = probe_runtime
        .prepare(
            &pin,
            &issued,
            &ctx.snapshot,
            &target,
            &ModelRequest::text_only("user", "x"),
        )
        .expect("prepare");
    let publish_in = serde_json::json!({
        "shadowIntent": ctx.shadow_intent,
        "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        "role": "muse_main",
        "issuance": { "taskInstanceId": TASK_INSTANCE, "resolution": ctx.resolution },
        "extensionDigest": ctx.extension_digest,
        "requestDigest": prepared.request_digest,
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let published_out = node_json(&["publish"], Some(&publish_in.to_string()));
    let bundle = published_out.get("bundle").expect("bundle").clone();
    assert_ok(
        &call(
            &socket,
            &ctx.cap_hex,
            "intent-publish",
            serde_json::json!({ "intent": bundle }),
        ),
        "intent-publish",
    );
    assert_ok(
        &call(
            &socket,
            &ctx.cap_hex,
            "intent-fence",
            serde_json::json!({ "commandId": ctx.shadow_intent.get("commandId").expect("commandId") }),
        ),
        "intent-fence",
    );
    let fenced = call(
        &socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": prepared.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_eq!(
        code_of(&fenced),
        "intent-fenced",
        "fenced intent never dispatches: {fenced}"
    );
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_revoked_credential_sends_nothing() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let (target, pin) = model_pin_and_target(&ctx);
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(ctx.resolution.clone()).expect("issued");
    let probe_runtime = OfflineModelRuntime::new(
        nexus_model::testkit::MockTransport::new(
            nexus_model::testkit::MockScript::CleanStream {
                body: String::new(),
            },
            "",
        ),
        TransportBinding::new("http://127.0.0.1:9"),
        TransportLimits::default(),
    );
    let prepared = probe_runtime
        .prepare(
            &pin,
            &issued,
            &ctx.snapshot,
            &target,
            &ModelRequest::text_only("user", "x"),
        )
        .expect("prepare");
    let publish_in = serde_json::json!({
        "shadowIntent": ctx.shadow_intent,
        "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        "role": "muse_main",
        "issuance": { "taskInstanceId": TASK_INSTANCE, "resolution": ctx.resolution },
        "extensionDigest": ctx.extension_digest,
        "requestDigest": prepared.request_digest,
        "sessionId": SESSION_ID,
        "scope": "mock-e2e",
    });
    let published_out = node_json(&["publish"], Some(&publish_in.to_string()));
    let bundle = published_out.get("bundle").expect("bundle").clone();
    assert_ok(
        &call(
            &socket,
            &ctx.cap_hex,
            "intent-publish",
            serde_json::json!({ "intent": bundle }),
        ),
        "intent-publish",
    );
    let accept_resp = call(
        &socket,
        &ctx.cap_hex,
        "accept",
        serde_json::json!({
            "intent": ctx.kernel_intent,
            "resolution": ctx.resolution,
            "snapshot": ctx.snapshot,
            "lease": { "epoch": ctx.lease_epoch, "storeIncarnation": ctx.incarnation },
        }),
    );
    assert_ok(&accept_resp, "accept");
    let auth_resp = call(
        &socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": ctx.shadow_intent.get("commandId").expect("commandId"),
            "requestDigest": prepared.request_digest,
            "scope": "mock-e2e",
            "endpointOrigin": ctx.mock.origin(),
            "credentialRef": target.credential_ref,
        }),
    );
    assert_ok(&auth_resp, "dispatch-authorize");
    let runtime = OfflineModelRuntime::new(
        HttpSseTransport::new(TransportBinding::new(&ctx.mock.origin())),
        TransportBinding::new(&ctx.mock.origin()),
        TransportLimits::default(),
    );
    let attested = runtime
        .attest(&pin, &issued, &ctx.snapshot, &target, prepared)
        .expect("attest");
    let mut attempt = AttemptTracker::new(ATTEMPT_ID);
    let mut store = AttemptStore::new();
    let credential = Credential::test_credential(SECRET_MARKER);
    credential.revoke();
    let err = runtime
        .dispatch(
            &mut attempt,
            &mut store,
            &attested,
            &credential,
            &CancellationToken::new(),
        )
        .expect_err("revoked");
    assert_eq!(err.code, nexus_model::ModelErrorCode::CredentialRevoked);
    assert_eq!(
        ctx.mock.connections(),
        0,
        "revoked credential opens no connection"
    );
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_untrusted_identities_are_refused() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let naked = raw_request(
        &socket,
        "{\"protocol\":1,\"id\":\"r1\",\"cmd\":\"intent-publish\",\"params\":{\"intent\":{}}}",
    )
    .expect("responds");
    assert_eq!(
        code_of(&naked),
        "issuer-untrusted",
        "unsigned privileged call refused: {naked}"
    );
    terminate(&mut ctx.proc_.child);
}

#[test]
fn e2e_live_scope_is_refused() {
    let mut ctx = setup_e2e();
    let socket = ctx.proc_.socket.clone();
    let live = call(
        &socket,
        &ctx.cap_hex,
        "dispatch-authorize",
        serde_json::json!({
            "commandId": "cmd-ghost",
            "requestDigest": "ab".repeat(32),
            "scope": "live",
            "endpointOrigin": "https://example.com",
            "credentialRef": "credential://x",
        }),
    );
    assert_eq!(
        code_of(&live),
        "scope-refused",
        "live scope never authorizes: {live}"
    );
    terminate(&mut ctx.proc_.child);
}
