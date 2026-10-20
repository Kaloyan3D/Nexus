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
    /// Structured stream fragments in wire order (derived from real events).
    pub stream: Vec<MockStreamItem>,
    /// Verification checks, each the outcome of a real step of this run.
    pub checks: Vec<MockCheck>,
}

/// One normalized stream item from the mock provider (wire order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockStreamItem {
    pub index: u64,
    /// `text` | `reasoning` | `tool-fragment` | `usage`.
    pub kind: String,
    pub content: String,
}

/// One verification check produced by an actually executed step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockCheck {
    pub id: String,
    pub label: String,
    /// `pass` | `fail`.
    pub status: String,
    pub detail: String,
}

/// Progress notification emitted while the isolated mock workflow runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockProgress {
    /// A workflow step completed successfully.
    Step { id: String, label: String },
    /// One provider stream item, in wire order.
    Stream(MockStreamItem),
    /// The durable conversation this run is being recorded into.
    Conversation { id: String },
}

/// Run one isolated mock task. `prompt` is user content for the mock body
/// only; it never reaches a live provider.
pub fn run_mock(prompt: &str) -> Result<MockRunReport, ClientError> {
    run_mock_streaming(prompt, &mut |_| {})
}

/// Like [`run_mock`], reporting each completed step and stream item in order.
/// Stream items are delivered in wire order after the single authorized send
/// returns; no event is fabricated.
pub fn run_mock_streaming(
    prompt: &str,
    on_progress: &mut dyn FnMut(MockProgress),
) -> Result<MockRunReport, ClientError> {
    let mut checks: Vec<MockCheck> = Vec::new();
    let mut step = |id: &str, label: &str, detail: &str, cb: &mut dyn FnMut(MockProgress)| {
        checks.push(MockCheck {
            id: id.to_owned(),
            label: label.to_owned(),
            status: "pass".to_owned(),
            detail: detail.to_owned(),
        });
        cb(MockProgress::Step {
            id: id.to_owned(),
            label: label.to_owned(),
        });
    };
    if prompt.trim().is_empty() {
        return Err(ClientError::usage("prompt must not be empty"));
    }
    let dir = tempfile::tempdir()
        .map_err(|e| ClientError::internal(format!("mock store unavailable: {e}")))?;
    let db = dir.path().join("mock.db");
    let wit = dir.path().join("mock.wit.db");
    let mut kernel = nexus_kernel::Kernel::open(&db, Some(&wit))
        .map_err(|e| ClientError::internal(format!("mock kernel unavailable: {e}")))?;
    step(
        "isolated-store",
        "Isolated throwaway kernel store opened",
        "tempdir store + witness; never the daemon store",
        on_progress,
    );
    let task = "task-mock-cli";
    let attempt = "attempt-mock-1";
    let command = "cmd-mock-1";
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
    let ext = serde_json::json!({ "extensionVersion": 1, "endpoint": { "protocol": "http", "origin": "http://127.0.0.1:9", "path": "/v1/responses", "method": "POST", "localLoopback": true }, "remoteModelIdConfirmed": "remote-model", "reasoningEffort": "low", "billing": { "tier": "test-unmetered", "dataUse": "standard" }, "session": { "sessionId": "session-test" }, "capabilities": ["text"], "contextLimitTokens": 8192, "outputLimitTokens": 1024, "connectionBinding": "connection", "credentialRef": "credential://connections/connection" });
    // EM-02: the request is prepared from exactly the target the Kernel seals for this attempt
    // (the grant names it, and the executor refuses any other).
    let target = ExecutionTargetV2::from_extension_json(kissued.target.clone(), &ext)
        .map_err(|e| ClientError::internal(format!("mock target: {e}")))?;
    let snapshot = ksnapshot.clone();
    let issued = kissued.clone();
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
    step(
        "request-prepared",
        "Request prepared and digest bound",
        &request_digest,
        on_progress,
    );
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
    step(
        "sealed-grant",
        "Sealed mock-e2e dispatch grant minted by the kernel",
        "scope mock-e2e; exactly-once; 300 s TTL",
        on_progress,
    );
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
    let mut text = String::new();
    let (mut usage_in, mut usage_out) = (0u64, 0u64);
    let mut stream: Vec<MockStreamItem> = Vec::new();
    for (i, ev) in report.events.iter().enumerate() {
        let item = match ev {
            ModelEvent::TextDelta(t) => {
                text.push_str(t);
                MockStreamItem {
                    index: i as u64,
                    kind: "text".to_owned(),
                    content: t.clone(),
                }
            }
            ModelEvent::ReasoningDelta(t) => MockStreamItem {
                index: i as u64,
                kind: "reasoning".to_owned(),
                content: t.clone(),
            },
            ModelEvent::ToolFragment { name, delta, .. } => MockStreamItem {
                index: i as u64,
                kind: "tool-fragment".to_owned(),
                content: format!("{name}: {delta}"),
            },
            ModelEvent::ToolDone {
                name, arguments, ..
            } => MockStreamItem {
                index: i as u64,
                kind: "tool-complete".to_owned(),
                content: format!("{name}: {arguments}"),
            },
            ModelEvent::ResponseId(id) => MockStreamItem {
                index: i as u64,
                kind: "response-id".to_owned(),
                content: id.clone(),
            },
            ModelEvent::ReasoningDone { item } => MockStreamItem {
                index: i as u64,
                kind: "reasoning-complete".to_owned(),
                content: format!("{} bytes", item.len()),
            },
            ModelEvent::MessageDone { phase, text, .. } => MockStreamItem {
                index: i as u64,
                kind: "message-complete".to_owned(),
                content: format!("{}: {}", phase.as_deref().unwrap_or("-"), text.len()),
            },
            ModelEvent::Usage(u) => {
                usage_in = u.input_tokens;
                usage_out = u.output_tokens;
                MockStreamItem {
                    index: i as u64,
                    kind: "usage".to_owned(),
                    content: format!("input={} output={}", u.input_tokens, u.output_tokens),
                }
            }
        };
        on_progress(MockProgress::Stream(item.clone()));
        stream.push(item);
    }
    step(
        "dispatch-authorized",
        "Authorized send completed against loopback mock provider",
        "no live provider traffic; Kernel::dispatch_enabled() stays false",
        on_progress,
    );
    checks.push(MockCheck {
        id: "dispatch-disabled".to_owned(),
        label: "Production dispatch remains disabled".to_owned(),
        status: if nexus_kernel::Kernel::dispatch_enabled() {
            "fail"
        } else {
            "pass"
        }
        .to_owned(),
        detail: "Kernel::dispatch_enabled() == false".to_owned(),
    });
    let finish = report.finish_reason.clone();
    checks.push(MockCheck {
        id: "stream-terminal".to_owned(),
        label: "Stream reached a terminal finish reason".to_owned(),
        status: if finish.is_some() && !report.truncated {
            "pass"
        } else {
            "fail"
        }
        .to_owned(),
        detail: finish.clone().unwrap_or_else(|| "none".to_owned()),
    });
    Ok(MockRunReport {
        text,
        attempt_id: attempt.to_owned(),
        command_id: command.to_owned(),
        request_digest: attested.prepared().request_digest.clone(),
        events: kinds,
        usage_in,
        usage_out,
        finish_reason: finish.unwrap_or_else(|| "none".to_owned()),
        stream,
        checks,
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
