//! A5.1 controlled model-only inference executor.
//!
//! One user-initiated, text-only request is sent to the explicitly selected
//! Registry target through the existing sealed-grant architecture:
//!
//! ```text
//! Controller (JS, issuer)            this module (issuer identity)        nexusd
//!   issue target / intent / accept  ->  prepare_model_run (pure)
//!   publish intent(scope model-only)
//!   dispatch-authorize ------------------------------------------------>  mint grant
//!                                   run_model_only(grant)
//!                                     credential from protected file
//!                                     model-redeem ----------------------->  verify + durable redeem
//!                                     write-ahead "request started"
//!                                     HttpSseTransport.send_streaming
//!                                     transcript: partials / terminal
//! ```
//!
//! What this module is NOT: it holds no Kernel handle and no issuance key,
//! mints no grants, executes no tool, reads no workspace file, spawns no
//! process, and never retries. The model's output is stored as untrusted
//! text; tool-call fragments in a response are recorded as inert text and
//! never dispatched. Provider credentials come only from a protected
//! backend file and never enter IPC frames, transcript records, errors or
//! the request bytes.

use crate::config::ClientConfig;
use crate::error::ClientError;
use nexus_model::{
    Credential, ExecutionTargetV2, HttpSseTransport, ModelErrorCode, ModelEvent, ModelRequest,
    ModelRuntime, OfflineModelRuntime, TransportBinding, TransportLimits, VerifiedExecutionPin,
};
use nexus_transcript::store::valid_task_id;
use nexus_transcript::{
    Actor, EventKind, InputClass, MessageState, Source, Speaker, TranscriptEventV1, TranscriptStore,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Largest accepted user prompt (bytes). Larger input is refused locally
/// before any state exists.
pub const MAX_PROMPT_BYTES: usize = 16 * 1024;

/// Conversation id prefix for model-only runs.
pub const MODEL_CONVERSATION_PREFIX: &str = "model_";

/// Optional caller expectation. When present, the Registry-issued target
/// must match it exactly: no silent provider fallback, no model swap.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedTarget {
    pub provider_id: String,
    pub remote_model_id: String,
}

/// Everything the executor needs from the Controller/Registry. It carries
/// authority-bearing JSON only as *data to be re-verified*: the kernel
/// seals bind these digests, so tampered copies fail redemption.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRunRequest {
    /// Must be `true`: the run was explicitly started by a user action.
    pub user_initiated: bool,
    pub prompt: String,
    pub task_instance_id: String,
    pub command_id: String,
    pub attempt_id: String,
    pub lease_epoch: u64,
    pub store_incarnation: String,
    /// Kernel controller-intent digest (from the Controller bridge).
    pub intent_digest: String,
    pub resolution: serde_json::Value,
    pub snapshot: serde_json::Value,
    pub core: serde_json::Value,
    pub extension: serde_json::Value,
    #[serde(default)]
    pub expected: Option<ExpectedTarget>,
    /// Optional per-request output cap; may only lower the sealed limit.
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
}

/// Result of the pure preparation step (no network, no IPC).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedModelRun {
    pub request_digest: String,
    pub endpoint_origin: String,
    pub credential_ref: String,
    pub provider_id: String,
    pub remote_model_id: String,
    pub logical_model_id: String,
    pub extension_digest: String,
    pub output_limit_tokens: u64,
}

/// Explicit executor configuration. Paths only; never secret values.
#[derive(Debug, Clone)]
pub struct ModelRunOptions {
    /// Issuer capability file (hex). Read once for the redemption call.
    pub cap_path: PathBuf,
    /// Protected provider credential file (`0600`, JSON ref -> token).
    pub credentials_path: PathBuf,
    pub limits: TransportLimits,
    /// `None` in production and in the CLI: the transport is the verifying
    /// rustls/webpki-roots HTTPS transport with the public-address policy.
    /// The offline acceptance suite injects a transport that trusts its own
    /// test CA and a scripted resolver. It cannot disable verification.
    pub transport: Option<TransportFactory>,
}

/// Builds the transport for one sealed endpoint binding (test seam).
#[derive(Clone)]
pub struct TransportFactory(pub Arc<dyn Fn(TransportBinding) -> HttpSseTransport + Send + Sync>);

impl std::fmt::Debug for TransportFactory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TransportFactory(..)")
    }
}

/// Lifecycle of one model-only run, persisted as transcript status events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelRunState {
    Accepted,
    TargetSelected,
    Authorized,
    RequestStarted,
    Streaming,
    Completed,
    Cancelled,
    TimedOut,
    ProviderFailed,
    /// Bytes may have left the process and the outcome is unknown. Never
    /// resubmitted automatically.
    Uncertain,
    /// Refused locally before any byte was sent (nothing billable).
    Refused,
    /// Failed after send with a definite local classification
    /// (malformed stream, oversize, ...).
    Failed,
    /// A5.5 repo-inspect: a model turn finished and its proposed read-only
    /// tool calls are being validated/executed. Not terminal; no provider
    /// request is in flight.
    ToolRunning,
    /// A5.5 repo-inspect: the run stopped cleanly at a policy limit (turns,
    /// tool calls, bytes or runtime). Terminal; partial findings are kept.
    LimitReached,
}

impl ModelRunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::TargetSelected => "target-selected",
            Self::Authorized => "authorized",
            Self::RequestStarted => "request-started",
            Self::Streaming => "streaming",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed-out",
            Self::ProviderFailed => "provider-failed",
            Self::Uncertain => "uncertain",
            Self::Refused => "refused",
            Self::Failed => "failed",
            Self::ToolRunning => "tool-running",
            Self::LimitReached => "limit-reached",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "accepted" => Self::Accepted,
            "target-selected" => Self::TargetSelected,
            "authorized" => Self::Authorized,
            "request-started" => Self::RequestStarted,
            "streaming" => Self::Streaming,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            "timed-out" => Self::TimedOut,
            "provider-failed" => Self::ProviderFailed,
            "uncertain" => Self::Uncertain,
            "refused" => Self::Refused,
            "failed" => Self::Failed,
            "tool-running" => Self::ToolRunning,
            "limit-reached" => Self::LimitReached,
            _ => return None,
        })
    }
    pub fn is_terminal(self) -> bool {
        !matches!(
            self,
            Self::Accepted
                | Self::TargetSelected
                | Self::Authorized
                | Self::RequestStarted
                | Self::Streaming
                | Self::ToolRunning
        )
    }
}

/// Machine-readable state metadata carried in a status event's
/// `tool_input` field (never rendered as markup; contains no secrets).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateMeta {
    pub(crate) state: String,
    pub(crate) provider_id: Option<String>,
    pub(crate) remote_model_id: Option<String>,
    pub(crate) logical_model_id: Option<String>,
    pub(crate) endpoint_kind: Option<String>,
    pub(crate) endpoint_origin: Option<String>,
    pub(crate) attempt_id: Option<String>,
    pub(crate) command_id: Option<String>,
    pub(crate) request_digest: Option<String>,
    pub(crate) http_status: Option<u16>,
    pub(crate) usage_input_tokens: Option<u64>,
    pub(crate) usage_output_tokens: Option<u64>,
    pub(crate) finish_reason: Option<String>,
    pub(crate) latency_ms: Option<u64>,
    pub(crate) first_token_ms: Option<u64>,
    pub(crate) provider_request_id: Option<String>,
    pub(crate) provider_response_id: Option<String>,
    pub(crate) error_code: Option<String>,
    pub(crate) response_origin: Option<String>,
}

/// Read model of one run, for CLI and GUI.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRunStatus {
    pub conversation_id: String,
    pub state: String,
    pub terminal: bool,
    pub provider_id: Option<String>,
    pub remote_model_id: Option<String>,
    pub logical_model_id: Option<String>,
    /// `provider` | `loopback-test-double`.
    pub endpoint_kind: Option<String>,
    pub attempt_id: Option<String>,
    pub command_id: Option<String>,
    pub request_digest: Option<String>,
    pub http_status: Option<u16>,
    pub usage_input_tokens: Option<u64>,
    pub usage_output_tokens: Option<u64>,
    pub finish_reason: Option<String>,
    pub latency_ms: Option<u64>,
    /// Time from run start to the first text delta (None until/unless one arrived).
    pub first_token_ms: Option<u64>,
    /// Request id the provider supplied in a response header (never synthesized).
    pub provider_request_id: Option<String>,
    /// `response.id` the provider supplied in the stream (never synthesized).
    pub provider_response_id: Option<String>,
    pub error_code: Option<String>,
    pub cancel_requested: bool,
    /// Text recorded so far (untrusted model output).
    pub text: String,
}

/// Terminal result of `run_model_only`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRunOutcome {
    pub status: ModelRunStatus,
}

/// Live update delivered to a caller while a run progresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelRunUpdate {
    Conversation { id: String },
    State { state: ModelRunState },
    Text { delta: String },
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn urandom_hex(n: usize) -> Result<String, ClientError> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| ClientError::internal(format!("entropy unavailable: {e}")))?;
    Ok(hex::encode(buf))
}

pub(crate) fn model_conversation_id() -> Result<String, ClientError> {
    Ok(format!("{MODEL_CONVERSATION_PREFIX}{}", urandom_hex(16)?))
}

pub(crate) fn endpoint_kind(origin: &str) -> &'static str {
    let loopback = nexus_contracts::origin_scheme_host(origin)
        .map(|(scheme, host)| {
            scheme == "http"
                && matches!(
                    nexus_contracts::classify_host(host),
                    nexus_contracts::DestinationVerdict::Loopback
                )
        })
        .unwrap_or(false);
    if loopback {
        "loopback-test-double"
    } else {
        "provider"
    }
}

pub(crate) struct Bound {
    pub(crate) target: ExecutionTargetV2,
    pub(crate) issued: nexus_contracts::RegistryResolutionV1,
    pub(crate) pin: VerifiedExecutionPin,
}

fn bind(req: &ModelRunRequest) -> Result<Bound, ClientError> {
    bind_with(req, "model-only")
}

pub(crate) fn bind_with(req: &ModelRunRequest, what: &str) -> Result<Bound, ClientError> {
    if !req.user_initiated {
        return Err(ClientError::usage(format!(
            "{what} runs must be explicitly user-initiated (userInitiated=true)"
        )));
    }
    if req.prompt.trim().is_empty() {
        return Err(ClientError::usage("prompt must not be empty"));
    }
    if req.prompt.len() > MAX_PROMPT_BYTES {
        return Err(ClientError::usage(format!(
            "prompt exceeds the {MAX_PROMPT_BYTES}-byte limit"
        )));
    }
    let core: nexus_contracts::ExecutionTargetCoreV1 = serde_json::from_value(req.core.clone())
        .map_err(|_| ClientError::usage("core does not match ExecutionTargetCoreV1"))?;
    let issued: nexus_contracts::RegistryResolutionV1 =
        serde_json::from_value(req.resolution.clone())
            .map_err(|_| ClientError::usage("resolution does not match RegistryResolutionV1"))?;
    let target = ExecutionTargetV2::from_extension_json(core, &req.extension)
        .map_err(|e| ClientError::usage(format!("target extension refused: {e}")))?;
    target
        .validate_executable()
        .map_err(|e| ClientError::usage(format!("target is not executable: {e}")))?;
    if let Some(exp) = &req.expected {
        if exp.provider_id != target.core.provider_id
            || exp.remote_model_id != target.core.remote_model_id
        {
            return Err(ClientError::new(
                "wrong-model",
                crate::error::ExitCode::Usage,
                format!(
                    "the Registry target is {}/{} but {}/{} was expected; no substitution or fallback is performed",
                    target.core.provider_id,
                    target.core.remote_model_id,
                    exp.provider_id,
                    exp.remote_model_id
                ),
            ));
        }
    }
    let command_digest = nexus_contracts::KernelCommandV1::compute_digest(
        &req.intent_digest,
        &issued.provenance.target_digest,
        &issued.provenance.registry_snapshot_digest,
        req.lease_epoch,
        &req.store_incarnation,
    );
    let pin = VerifiedExecutionPin::bind(
        &req.task_instance_id,
        &req.command_id,
        &req.attempt_id,
        req.lease_epoch,
        &req.store_incarnation,
        &issued,
        &req.snapshot,
        &target,
        &command_digest,
    )
    .map_err(|e| ClientError::usage(format!("execution pin refused: {e}")))?;
    Ok(Bound {
        target,
        issued,
        pin,
    })
}

pub(crate) fn runtime_for(
    target: &ExecutionTargetV2,
    limits: TransportLimits,
    factory: Option<&TransportFactory>,
) -> OfflineModelRuntime<HttpSseTransport> {
    let binding = TransportBinding::new(&target.endpoint.origin);
    let transport = match factory {
        Some(f) => (f.0)(binding.clone()),
        None => HttpSseTransport::new(binding.clone()),
    };
    OfflineModelRuntime::new(transport, binding, limits)
}

/// Pure preparation: validate the target, enforce the expected model, build
/// the exact request bytes and report their digest. Sends nothing.
pub fn prepare_model_run(req: &ModelRunRequest) -> Result<PreparedModelRun, ClientError> {
    let b = bind(req)?;
    let runtime = runtime_for(&b.target, TransportLimits::default(), None);
    let prepared = runtime
        .prepare(
            &b.pin,
            &b.issued,
            &req.snapshot,
            &b.target,
            &model_input(req),
        )
        .map_err(|e| ClientError::usage(format!("request preparation refused: {e}")))?;
    Ok(PreparedModelRun {
        request_digest: prepared.request_digest.clone(),
        endpoint_origin: prepared.endpoint_origin.clone(),
        credential_ref: b.target.credential_ref.clone(),
        provider_id: b.target.core.provider_id.clone(),
        remote_model_id: b.target.core.remote_model_id.clone(),
        logical_model_id: b.target.core.logical_model_id.clone(),
        extension_digest: b.target.extension_digest(),
        output_limit_tokens: b.target.output_limit_tokens,
    })
}

fn model_input(req: &ModelRunRequest) -> ModelRequest {
    let mut m = ModelRequest::text_only("user", &req.prompt);
    m.max_output_tokens = req.max_output_tokens;
    m
}

pub(crate) fn cancel_marker(cfg: &ClientConfig, conv: &str) -> PathBuf {
    cfg.transcript_dir.join(format!("{conv}.cancel"))
}

/// User-requested cancellation: a fail-safe marker next to the transcript.
/// It can only *stop* a run; it grants nothing and carries no data.
pub fn request_model_cancel(cfg: &ClientConfig, conversation_id: &str) -> Result<(), ClientError> {
    if !valid_task_id(conversation_id) || !conversation_id.starts_with(MODEL_CONVERSATION_PREFIX) {
        return Err(ClientError::usage("not a model conversation id"));
    }
    let store = TranscriptStore::open(&cfg.transcript_dir)
        .map_err(|e| ClientError::internal(format!("transcript store unavailable: {e}")))?;
    if !store.exists(conversation_id) {
        return Err(ClientError::usage("unknown model conversation"));
    }
    std::fs::write(cancel_marker(cfg, conversation_id), b"cancel\n")
        .map_err(|e| ClientError::internal(format!("cancel marker unwritable: {e}")))
}

pub(crate) struct Recorder {
    pub(crate) store: Arc<TranscriptStore>,
    pub(crate) conv: String,
    pub(crate) task_instance_id: String,
    pub(crate) attempt_id: String,
    pub(crate) actor: Actor,
    pub(crate) meta: StateMeta,
    pub(crate) text: String,
    pub(crate) rev: u32,
    pub(crate) last_partial_ms: u64,
    /// Appended to state-event and assistant-message ids so repeated states
    /// across the turns of one conversation stay distinct (repo-inspect).
    pub(crate) suffix: String,
}

impl Recorder {
    pub(crate) fn base(
        &self,
        id: &str,
        kind: EventKind,
        speaker: Speaker,
        class: InputClass,
    ) -> TranscriptEventV1 {
        let mut e =
            TranscriptEventV1::new(id, &self.conv, kind, speaker, class, Source::NativeStore);
        e.timestamp_ms = Some(now_ms());
        e.display_task_id = Some("MODEL".to_owned());
        e.attempt_id = Some(self.attempt_id.clone());
        e.session_id = Some(self.task_instance_id.clone());
        e
    }

    pub(crate) fn append(&self, e: TranscriptEventV1) -> Result<(), ClientError> {
        self.store
            .append(&self.conv, e)
            .map(|_| ())
            .map_err(|err| ClientError::internal(format!("transcript write failed: {err}")))
    }

    pub(crate) fn state(
        &mut self,
        state: ModelRunState,
        text: &str,
        error_code: Option<&str>,
    ) -> Result<(), ClientError> {
        self.meta.state = state.as_str().to_owned();
        self.meta.error_code = error_code.map(str::to_owned);
        let (kind, class) = if error_code.is_some() {
            (EventKind::Error, InputClass::System)
        } else {
            (EventKind::Status, InputClass::System)
        };
        let mut e = self.base(
            &format!("model-state-{}{}", state.as_str(), self.suffix),
            kind,
            Speaker::Runtime,
            class,
        );
        e.text = Some(text.to_owned());
        e.actor = self.actor.clone();
        e.tool_input = serde_json::to_string(&self.meta).ok();
        if error_code.is_some() {
            e.is_error = Some(true);
            e.error_code = error_code.map(str::to_owned);
        }
        self.append(e)
    }

    pub(crate) fn assistant(&mut self, state: MessageState) -> Result<(), ClientError> {
        let mut e = self.base(
            &format!("assistant-1{}", self.suffix),
            EventKind::AssistantMessage,
            Speaker::Worker,
            InputClass::ModelGenerated,
        );
        e.event_id = format!("assistant-1{}@{}", self.suffix, self.rev);
        e.revision = self.rev;
        e.state = state;
        e.actor = self.actor.clone();
        e.text = Some(self.text.clone());
        self.rev += 1;
        self.last_partial_ms = now_ms();
        self.append(e)
    }
}

pub(crate) fn classify(code: ModelErrorCode, bytes_sent: bool) -> ModelRunState {
    match code {
        ModelErrorCode::Cancelled => ModelRunState::Cancelled,
        ModelErrorCode::Timeout => {
            if bytes_sent {
                ModelRunState::TimedOut
            } else {
                ModelRunState::Refused
            }
        }
        ModelErrorCode::ProviderFailed => ModelRunState::ProviderFailed,
        ModelErrorCode::SendUncertain | ModelErrorCode::StreamPartial => ModelRunState::Uncertain,
        _ if !bytes_sent => ModelRunState::Refused,
        ModelErrorCode::Disconnected => ModelRunState::Uncertain,
        _ => ModelRunState::Failed,
    }
}

pub(crate) fn grant_from_json(
    g: &serde_json::Value,
) -> Result<nexus_kernel::SealedNativeDispatchGrant, ClientError> {
    let s = |k: &str| g.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let bad = || ClientError::usage("grant does not match the sealed grant shape");
    Ok(nexus_kernel::SealedNativeDispatchGrant {
        command_id: s("commandId").ok_or_else(bad)?,
        attempt_id: s("attemptId").ok_or_else(bad)?,
        task_instance_id: s("taskInstanceId").ok_or_else(bad)?,
        request_digest: s("requestDigest").ok_or_else(bad)?,
        endpoint_origin: s("endpointOrigin").ok_or_else(bad)?,
        scope: s("scope").ok_or_else(bad)?,
        target_digest: s("targetDigest").ok_or_else(bad)?,
        extension_digest: s("extensionDigest").ok_or_else(bad)?,
        lease_epoch: g
            .get("leaseEpoch")
            .and_then(|v| v.as_u64())
            .ok_or_else(bad)?,
        store_incarnation: s("storeIncarnation").ok_or_else(bad)?,
        credential_ref: s("credentialRef").ok_or_else(bad)?,
        issued_at_ms: g
            .get("issuedAtMs")
            .and_then(|v| v.as_i64())
            .ok_or_else(bad)?,
        expires_at_ms: g
            .get("expiresAtMs")
            .and_then(|v| v.as_i64())
            .ok_or_else(bad)?,
        nonce_hex: s("nonceHex").ok_or_else(bad)?,
        granted_at_utc: s("grantedAtUtc").ok_or_else(bad)?,
        tag_hex: s("tagHex").ok_or_else(bad)?,
    })
}

/// Build an issuer-authenticated IPC frame (see `crate::issuer`).
pub(crate) fn authed_frame(
    cap_hex: &str,
    cmd: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    crate::issuer::signed_frame(cap_hex, cmd, params)
}

pub(crate) fn read_cap(path: &Path) -> Result<String, ClientError> {
    std::fs::read_to_string(path)
        .map_err(|_| ClientError::unauthorized("issuer capability file is unreadable"))
}

/// Execute one authorized model-only request and record it durably.
///
/// `grant` is the JSON object returned by the daemon's `dispatch-authorize`
/// (`result.grant`). Never retries; a crash after redemption leaves the run
/// `request-started` with no terminal, which [`recover_model_run`] turns
/// into an explicit `uncertain` state.
pub fn run_model_only(
    cfg: &ClientConfig,
    opts: &ModelRunOptions,
    req: &ModelRunRequest,
    grant: &serde_json::Value,
    on_update: &mut dyn FnMut(ModelRunUpdate),
) -> Result<ModelRunOutcome, ClientError> {
    let started = Instant::now();
    let bound = bind(req)?;
    let runtime = runtime_for(&bound.target, opts.limits, opts.transport.as_ref());
    let prepared = runtime
        .prepare(
            &bound.pin,
            &bound.issued,
            &req.snapshot,
            &bound.target,
            &model_input(req),
        )
        .map_err(|e| ClientError::usage(format!("request preparation refused: {e}")))?;
    let attested = runtime
        .attest(
            &bound.pin,
            &bound.issued,
            &req.snapshot,
            &bound.target,
            prepared,
        )
        .map_err(|e| ClientError::usage(format!("attestation refused: {e}")))?;
    let grant = grant_from_json(grant)?;
    if grant.scope != nexus_kernel::SCOPE_MODEL_ONLY {
        return Err(ClientError::usage(
            "grant scope is not model-only; this executor sends nothing for any other scope",
        ));
    }
    // Configuration validation BEFORE anything billable: the credential
    // must load from the protected file for the sealed reference.
    let credential = Credential::from_protected_file(&opts.credentials_path, &grant.credential_ref)
        .map_err(|e| ClientError::blocked(format!("provider credential unavailable: {e}")))?;
    let cap_hex = read_cap(&opts.cap_path)?;

    let store = Arc::new(
        TranscriptStore::open(&cfg.transcript_dir)
            .map_err(|e| ClientError::internal(format!("transcript store unavailable: {e}")))?,
    );
    let conv = model_conversation_id()?;
    on_update(ModelRunUpdate::Conversation { id: conv.clone() });
    let target = &bound.target;
    let origin = attested.prepared().endpoint_origin.clone();
    let kind = endpoint_kind(&origin);
    let meta = StateMeta {
        provider_id: Some(target.core.provider_id.clone()),
        remote_model_id: Some(target.core.remote_model_id.clone()),
        logical_model_id: Some(target.core.logical_model_id.clone()),
        endpoint_kind: Some(kind.to_owned()),
        endpoint_origin: Some(origin.clone()),
        attempt_id: Some(req.attempt_id.clone()),
        command_id: Some(req.command_id.clone()),
        request_digest: Some(attested.prepared().request_digest.clone()),
        response_origin: Some(if kind == "provider" {
            "provider".to_owned()
        } else {
            "loopback-test-double".to_owned()
        }),
        ..Default::default()
    };
    let mut rec = Recorder {
        store: Arc::clone(&store),
        conv: conv.clone(),
        task_instance_id: req.task_instance_id.clone(),
        attempt_id: req.attempt_id.clone(),
        actor: Actor {
            agent: Some("nexus-model-only".to_owned()),
            model: Some(target.core.remote_model_id.clone()),
            provider: Some(target.core.provider_id.clone()),
        },
        meta,
        text: String::new(),
        rev: 0,
        last_partial_ms: 0,
        suffix: String::new(),
    };
    let (prompt_text, redactions) = nexus_transcript::redact::redact_text(&req.prompt);
    let mut user = rec.base(
        "user-1",
        EventKind::UserMessage,
        Speaker::User,
        InputClass::UserAuthored,
    );
    user.text = Some(prompt_text);
    user.redactions = redactions;
    rec.append(user)?;
    rec.state(
        ModelRunState::Accepted,
        "Request accepted (user-initiated, model-only, no tools).",
        None,
    )?;
    on_update(ModelRunUpdate::State {
        state: ModelRunState::Accepted,
    });
    rec.state(
        ModelRunState::TargetSelected,
        &format!(
            "Target {}/{} via {} ({}).",
            target.core.provider_id,
            target.core.remote_model_id,
            origin,
            if kind == "provider" {
                "provider endpoint"
            } else {
                "loopback test double, not a real provider"
            }
        ),
        None,
    )?;
    on_update(ModelRunUpdate::State {
        state: ModelRunState::TargetSelected,
    });
    rec.state(
        ModelRunState::Authorized,
        "Sealed model-only grant presented; redeeming with the daemon.",
        None,
    )?;
    on_update(ModelRunUpdate::State {
        state: ModelRunState::Authorized,
    });

    // Cancellation: a watcher thread turns the user's marker file into the
    // in-process token the transport polls between reads.
    let cancel = nexus_model::CancellationToken::new();
    let done = Arc::new(AtomicBool::new(false));
    let marker = cancel_marker(cfg, &conv);
    let watcher = {
        let cancel = cancel.clone();
        let done = Arc::clone(&done);
        let marker = marker.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if marker.exists() {
                    cancel.cancel();
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
    };

    let redeem_params = serde_json::json!({
        "grant": {
            "commandId": grant.command_id, "attemptId": grant.attempt_id,
            "taskInstanceId": grant.task_instance_id, "requestDigest": grant.request_digest,
            "endpointOrigin": grant.endpoint_origin, "scope": grant.scope,
            "targetDigest": grant.target_digest, "extensionDigest": grant.extension_digest,
            "leaseEpoch": grant.lease_epoch, "storeIncarnation": grant.store_incarnation,
            "credentialRef": grant.credential_ref, "issuedAtMs": grant.issued_at_ms,
            "expiresAtMs": grant.expires_at_ms, "nonceHex": grant.nonce_hex,
            "grantedAtUtc": grant.granted_at_utc, "tagHex": grant.tag_hex,
        },
        "requestDigest": attested.prepared().request_digest,
        "endpointOrigin": origin,
        "credentialRef": grant.credential_ref,
    });
    let socket = cfg.socket_path.clone();
    let mut redeem = || -> Result<(), nexus_model::ModelError> {
        let frame = authed_frame(&cap_hex, "model-redeem", redeem_params.clone()).map_err(|e| {
            nexus_model::ModelError::new(ModelErrorCode::TransportRefused, e.message)
        })?;
        let resp = crate::transport::ipc_roundtrip(&socket, &frame, 10_000).map_err(|e| {
            nexus_model::ModelError::new(ModelErrorCode::TransportRefused, e.message)
        })?;
        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            return Ok(());
        }
        let code = resp
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("daemon-error");
        Err(nexus_model::ModelError::new(
            ModelErrorCode::TransportRefused,
            format!("grant redemption refused by the daemon ({code}); nothing was sent"),
        ))
    };

    let mut tracker = nexus_model::AttemptTracker::new(&req.attempt_id);
    let mut attempts = nexus_model::AttemptStore::new();
    let mut first_event = true;
    let mut first_token_ms: Option<u64> = None;
    let mut response_id: Option<String> = None;
    let mut usage: Option<(u64, u64)> = None;
    // The hooks borrow the recorder and the callback: use RefCell-free
    // sequencing by collecting events into a queue processed through a
    // single closure that owns `rec`.
    let rec_cell = std::cell::RefCell::new(rec);
    let update_cell = std::cell::RefCell::new(on_update);
    let result = {
        let mut on_started = || -> Result<(), nexus_model::ModelError> {
            let mut r = rec_cell.borrow_mut();
            // Write-ahead: durable BEFORE bytes are written. If this record
            // cannot be persisted the send is aborted.
            r.state(
                ModelRunState::RequestStarted,
                "Provider request started. If this process dies now the outcome is UNKNOWN and the request will not be re-sent.",
                None,
            )
            .map_err(|e| {
                nexus_model::ModelError::new(
                    ModelErrorCode::TransportRefused,
                    format!("write-ahead record failed; nothing was sent: {}", e.message),
                )
            })?;
            (update_cell.borrow_mut())(ModelRunUpdate::State {
                state: ModelRunState::RequestStarted,
            });
            Ok(())
        };
        let mut on_event = |ev: &ModelEvent| {
            let mut r = rec_cell.borrow_mut();
            match ev {
                ModelEvent::TextDelta(t) => {
                    if first_event {
                        first_event = false;
                        let _ = r.state(ModelRunState::Streaming, "Provider is streaming.", None);
                        (update_cell.borrow_mut())(ModelRunUpdate::State {
                            state: ModelRunState::Streaming,
                        });
                    }
                    if first_token_ms.is_none() {
                        first_token_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    r.text.push_str(t);
                    if r.text.len() > 256 * 1024 {
                        r.text.truncate(256 * 1024);
                    }
                    (update_cell.borrow_mut())(ModelRunUpdate::Text { delta: t.clone() });
                    if now_ms().saturating_sub(r.last_partial_ms) >= 120 {
                        let _ = r.assistant(MessageState::Partial);
                    }
                }
                ModelEvent::Usage(u) => usage = Some((u.input_tokens, u.output_tokens)),
                ModelEvent::ResponseId(id) => response_id = Some(id.clone()),
                // Reasoning deltas and tool-call fragments are provider
                // data. They are never rendered as output and never
                // dispatched: a fragment is inert text at most.
                ModelEvent::ReasoningDelta(_)
                | ModelEvent::ToolFragment { .. }
                | ModelEvent::ToolDone { .. }
                | ModelEvent::MessageDone { .. } => {}
            }
        };
        nexus_model::dispatch_redeemed_streaming(
            runtime.transport(),
            &grant,
            &attested,
            &grant.credential_ref,
            &credential,
            &cancel,
            &opts.limits,
            &mut tracker,
            &mut attempts,
            nexus_model::RedeemedDispatch {
                redeem: &mut redeem,
                on_started: &mut on_started,
                on_event: &mut on_event,
            },
        )
    };
    done.store(true, Ordering::SeqCst);
    let _ = watcher.join();
    let _ = std::fs::remove_file(&marker);
    let mut rec = rec_cell.into_inner();
    let latency = started.elapsed().as_millis() as u64;
    rec.meta.latency_ms = Some(latency);
    rec.meta.first_token_ms = first_token_ms;
    rec.meta.provider_response_id = response_id;
    if let Some((i, o)) = usage {
        rec.meta.usage_input_tokens = Some(i);
        rec.meta.usage_output_tokens = Some(o);
    }
    let terminal: ModelRunState;
    match result {
        Ok(report) => {
            rec.meta.http_status = report.http_status;
            rec.meta.provider_request_id = report.provider_request_id.clone();
            rec.meta.finish_reason = report.finish_reason.clone();
            if report.finish_reason.is_some() && !report.truncated {
                rec.assistant(MessageState::Final)?;
                terminal = ModelRunState::Completed;
                rec.state(
                    terminal,
                    &format!(
                        "Completed ({}).",
                        report.finish_reason.as_deref().unwrap_or("stop")
                    ),
                    None,
                )?;
            } else {
                if !rec.text.is_empty() {
                    rec.assistant(MessageState::Interrupted)?;
                }
                let cause = report.stop_cause;
                terminal = match cause {
                    Some(ModelErrorCode::Timeout) => ModelRunState::TimedOut,
                    Some(ModelErrorCode::Cancelled) => ModelRunState::Cancelled,
                    _ => ModelRunState::Uncertain,
                };
                let (text, code) = match terminal {
                    ModelRunState::TimedOut => (
                        "The provider timed out mid-response. The outcome is unknown; the request was not re-sent.",
                        "timeout",
                    ),
                    ModelRunState::Cancelled => (
                        "Cancelled by the user. Any provider-side effect is unknown; the request was not re-sent.",
                        "cancelled",
                    ),
                    _ => (
                        "The provider stream ended without a terminal event; the output is incomplete. The request was not re-sent.",
                        "stream-partial",
                    ),
                };
                rec.state(terminal, text, Some(code))?;
            }
        }
        Err(te) => {
            let code = te.error.code;
            terminal = classify(code, te.bytes_sent);
            if !rec.text.is_empty() {
                rec.assistant(MessageState::Interrupted)?;
            }
            let text = match terminal {
                ModelRunState::Cancelled => "Cancelled by the user. Any provider-side effect is unknown; the request was not re-sent.".to_owned(),
                ModelRunState::TimedOut => format!("The provider timed out. The outcome is unknown; the request was not re-sent. ({})", te.error.message),
                ModelRunState::Uncertain => format!("Submission outcome is UNCERTAIN (the request may have been processed and billed). It was not re-sent. ({})", te.error.message),
                ModelRunState::Refused => format!("Refused before any byte was sent: {}", te.error.message),
                _ => format!("Failed: {}", te.error.message),
            };
            rec.state(terminal, &text, Some(code.as_str()))?;
        }
    }
    (update_cell.into_inner())(ModelRunUpdate::State { state: terminal });
    let status = status_from_store(cfg, &conv)?;
    Ok(ModelRunOutcome { status })
}

/// Close out a run whose executor process died: `request-started` with no
/// terminal becomes an explicit `uncertain` state (never a resubmission).
/// Runs that never reached `request-started` become `refused` (nothing sent).
pub fn recover_model_run(
    cfg: &ClientConfig,
    conversation_id: &str,
) -> Result<ModelRunStatus, ClientError> {
    let status = status_from_store(cfg, conversation_id)?;
    if status.terminal {
        return Ok(status);
    }
    let store = TranscriptStore::open(&cfg.transcript_dir)
        .map_err(|e| ClientError::internal(format!("transcript store unavailable: {e}")))?;
    let started = matches!(
        ModelRunState::parse(&status.state),
        Some(ModelRunState::RequestStarted | ModelRunState::Streaming)
    );
    let between_turns = matches!(
        ModelRunState::parse(&status.state),
        Some(ModelRunState::ToolRunning)
    );
    let (state, text, code) = if between_turns {
        (
            ModelRunState::Failed,
            "The executor stopped between model turns. No provider request was in flight; partial findings are kept and nothing is resumed or re-run.",
            "loop-interrupted",
        )
    } else if started {
        (
            ModelRunState::Uncertain,
            "The executor stopped during inference. The outcome is UNKNOWN (possibly billed). The request will not be re-sent automatically.",
            "send-uncertain",
        )
    } else {
        (
            ModelRunState::Refused,
            "The executor stopped before any request was sent. Nothing was submitted.",
            "interrupted-before-send",
        )
    };
    let mut meta = StateMeta {
        state: state.as_str().to_owned(),
        provider_id: status.provider_id.clone(),
        remote_model_id: status.remote_model_id.clone(),
        logical_model_id: status.logical_model_id.clone(),
        endpoint_kind: status.endpoint_kind.clone(),
        attempt_id: status.attempt_id.clone(),
        command_id: status.command_id.clone(),
        request_digest: status.request_digest.clone(),
        error_code: Some(code.to_owned()),
        ..Default::default()
    };
    meta.response_origin = status.endpoint_kind.clone();
    let mut e = TranscriptEventV1::new(
        format!("model-state-{}", state.as_str()),
        conversation_id,
        EventKind::Error,
        Speaker::Runtime,
        InputClass::System,
        Source::NativeStore,
    );
    e.timestamp_ms = Some(now_ms());
    e.display_task_id = Some("MODEL".to_owned());
    e.attempt_id = status.attempt_id.clone();
    e.text = Some(text.to_owned());
    e.is_error = Some(true);
    e.error_code = Some(code.to_owned());
    e.tool_input = serde_json::to_string(&meta).ok();
    store
        .append(conversation_id, e)
        .map_err(|err| ClientError::internal(format!("transcript write failed: {err}")))?;
    status_from_store(cfg, conversation_id)
}

/// Derive the run status from the durable transcript (never from memory).
pub fn status_from_store(
    cfg: &ClientConfig,
    conversation_id: &str,
) -> Result<ModelRunStatus, ClientError> {
    if !valid_task_id(conversation_id) || !conversation_id.starts_with(MODEL_CONVERSATION_PREFIX) {
        return Err(ClientError::usage("not a model conversation id"));
    }
    let store = TranscriptStore::open(&cfg.transcript_dir)
        .map_err(|e| ClientError::internal(format!("transcript store unavailable: {e}")))?;
    if !store.exists(conversation_id) {
        return Err(ClientError::usage("unknown model conversation"));
    }
    let loaded = store
        .load(conversation_id)
        .map_err(|e| ClientError::internal(e.to_string()))?;
    let mut meta = StateMeta::default();
    let mut state = ModelRunState::Accepted;
    let mut text = String::new();
    for ev in &loaded.events {
        if ev.event_id.starts_with("model-state-") {
            if let Some(m) = ev
                .tool_input
                .as_deref()
                .and_then(|s| serde_json::from_str::<StateMeta>(s).ok())
            {
                if let Some(s) = ModelRunState::parse(&m.state) {
                    state = s;
                }
                meta = m;
            }
        }
        if ev.kind == EventKind::AssistantMessage {
            if let Some(t) = &ev.text {
                text = t.clone();
            }
        }
    }
    Ok(ModelRunStatus {
        conversation_id: conversation_id.to_owned(),
        state: state.as_str().to_owned(),
        terminal: state.is_terminal(),
        provider_id: meta.provider_id,
        remote_model_id: meta.remote_model_id,
        logical_model_id: meta.logical_model_id,
        endpoint_kind: meta.endpoint_kind,
        attempt_id: meta.attempt_id,
        command_id: meta.command_id,
        request_digest: meta.request_digest,
        http_status: meta.http_status,
        usage_input_tokens: meta.usage_input_tokens,
        usage_output_tokens: meta.usage_output_tokens,
        finish_reason: meta.finish_reason,
        latency_ms: meta.latency_ms,
        first_token_ms: meta.first_token_ms,
        provider_request_id: meta.provider_request_id,
        provider_response_id: meta.provider_response_id,
        error_code: meta.error_code,
        cancel_requested: cancel_marker(cfg, conversation_id).exists(),
        text,
    })
}

/// Index of recorded model-only conversations (newest first).
pub fn list_model_conversations(cfg: &ClientConfig) -> Vec<ModelConversationSummary> {
    let Ok(store) = TranscriptStore::open(&cfg.transcript_dir) else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(store.root()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if !id.starts_with(MODEL_CONVERSATION_PREFIX) || !valid_task_id(id) {
            continue;
        }
        let Ok(loaded) = store.load(id) else { continue };
        let first = loaded
            .events
            .iter()
            .find(|e| e.kind == EventKind::UserMessage);
        let Ok(st) = status_from_store(cfg, id) else {
            continue;
        };
        out.push(ModelConversationSummary {
            conversation_id: id.to_owned(),
            first_prompt: first
                .and_then(|e| e.text.clone())
                .unwrap_or_default()
                .chars()
                .take(160)
                .collect(),
            started_at_ms: first.and_then(|e| e.timestamp_ms),
            state: st.state,
            terminal: st.terminal,
            provider_id: st.provider_id,
            remote_model_id: st.remote_model_id,
            endpoint_kind: st.endpoint_kind,
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.started_at_ms));
    out.truncate(100);
    out
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelConversationSummary {
    pub conversation_id: String,
    pub first_prompt: String,
    pub started_at_ms: Option<u64>,
    pub state: String,
    pub terminal: bool,
    pub provider_id: Option<String>,
    pub remote_model_id: Option<String>,
    pub endpoint_kind: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executor_has_no_tool_process_filesystem_or_authority_surface() {
        // The model-only executor must not even *name* a path to execution,
        // approval, grant minting or workspace access. A reference here
        // would be a reviewable regression.
        let src = include_str!("model_run.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").expect("test split");
        // Code only: documentation may *describe* the chain it is NOT part of.
        let prod: String = prod
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "std::process",
            "Command::new",
            "tool-execute",
            "tool-revoke",
            "workspace-bind",
            "approval-request",
            "approval-decide",
            "intent-publish",
            "dispatch-authorize",
            "seal-extension",
            "nexus_tools",
            "read_dir(&workspace",
            "authorize_dispatch",
            "enable_model_only_pilot",
        ] {
            assert!(
                !prod.contains(forbidden),
                "model_run.rs must not reference {forbidden}"
            );
        }
    }

    #[test]
    fn state_names_round_trip_and_terminals_are_exact() {
        use ModelRunState::*;
        let all = [
            Accepted,
            TargetSelected,
            Authorized,
            RequestStarted,
            Streaming,
            Completed,
            Cancelled,
            TimedOut,
            ProviderFailed,
            Uncertain,
            Refused,
            Failed,
        ];
        for s in all {
            assert_eq!(ModelRunState::parse(s.as_str()), Some(s));
        }
        let terminals: Vec<_> = all.iter().filter(|s| s.is_terminal()).collect();
        assert_eq!(terminals.len(), 7);
        assert!(!RequestStarted.is_terminal() && !Streaming.is_terminal());
    }

    #[test]
    fn classification_never_calls_an_uncertain_send_definite() {
        use ModelErrorCode as C;
        use ModelRunState as S;
        assert_eq!(classify(C::TransportRefused, false), S::Refused);
        assert_eq!(classify(C::Disconnected, false), S::Refused);
        assert_eq!(classify(C::Disconnected, true), S::Uncertain);
        assert_eq!(classify(C::SendUncertain, true), S::Uncertain);
        assert_eq!(classify(C::Timeout, true), S::TimedOut);
        assert_eq!(classify(C::Cancelled, true), S::Cancelled);
        assert_eq!(classify(C::ProviderFailed, true), S::ProviderFailed);
        assert_eq!(classify(C::SseMalformed, true), S::Failed);
        assert_eq!(classify(C::PayloadTooLarge, true), S::Failed);
        assert_eq!(classify(C::RedirectRefused, true), S::Failed);
    }

    #[test]
    fn user_initiation_and_prompt_bounds_are_enforced_before_any_state() {
        let mut req = ModelRunRequest {
            user_initiated: false,
            prompt: "hi".to_owned(),
            task_instance_id: "t".to_owned(),
            command_id: "c".to_owned(),
            attempt_id: "a".to_owned(),
            lease_epoch: 1,
            store_incarnation: "i".to_owned(),
            intent_digest: "d".to_owned(),
            resolution: serde_json::json!({}),
            snapshot: serde_json::json!({}),
            core: serde_json::json!({}),
            extension: serde_json::json!({}),
            expected: None,
            max_output_tokens: None,
        };
        let e = prepare_model_run(&req).expect_err("not user initiated");
        assert!(e.message.contains("user-initiated"), "{e}");
        req.user_initiated = true;
        req.prompt = "  ".to_owned();
        assert!(prepare_model_run(&req).is_err());
        req.prompt = "x".repeat(MAX_PROMPT_BYTES + 1);
        assert!(prepare_model_run(&req).is_err());
    }

    #[test]
    fn endpoint_kind_is_derived_from_the_origin_not_asserted() {
        assert_eq!(endpoint_kind("http://127.0.0.1:9"), "loopback-test-double");
        assert_eq!(endpoint_kind("https://api.example.com"), "provider");
        assert_eq!(
            endpoint_kind("http://localhost:11434"),
            "loopback-test-double"
        );
    }
}
