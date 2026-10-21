//! A5.5 `repo-inspect` model-turn executor and conversation recorder.
//!
//! One call of [`run_inspect_turn`] is exactly ONE provider request: a
//! sealed `repo-inspect` grant is redeemed (single use), the request is sent
//! through the same verified-HTTPS transport as `model-only`, and the
//! response is returned as DATA: assistant text plus the tool calls the model
//! *proposed*. This module never executes a tool, never touches a workspace,
//! never mints a grant and never retries. The Controller-side loop (the
//! broker) validates every proposal, asks the Kernel to authorize it, runs it
//! through the existing native tools and then starts the NEXT turn, which is
//! a new Controller attempt with its own command, grant and request digest.

use crate::config::ClientConfig;
use crate::error::ClientError;
use crate::model_run::{
    authed_frame, bind_with, cancel_marker, classify, endpoint_kind, grant_from_json,
    model_conversation_id, now_ms, read_cap, runtime_for, ModelRunRequest, ModelRunState,
    PreparedModelRun, Recorder, StateMeta,
};
use nexus_model::{
    AssembledToolCall, Credential, InputItem, ModelErrorCode, ModelEvent, ModelRequest,
    ModelRuntime, StreamAssembler, ToolProfile,
};
use nexus_transcript::store::valid_task_id;
use nexus_transcript::{Actor, EventKind, InputClass, MessageState, Speaker, TranscriptStore};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What the Controller needs to describe a run's target to the transcript.
#[derive(Debug, Clone)]
pub struct InspectBasics {
    /// `repo-inspect` or `repo-code` (recorded in the conversation).
    pub mode: &'static str,
    pub provider_id: String,
    pub remote_model_id: String,
    pub logical_model_id: String,
    pub endpoint_origin: String,
    pub workspace_id: String,
}

/// Durable, append-only conversation of one repo-inspect run.
pub struct InspectSession {
    rec: Recorder,
    conv: String,
    kind: &'static str,
}

fn input_items_model(
    items: &[InputItem],
    max_output_tokens: Option<u64>,
    profile: ToolProfile,
) -> ModelRequest {
    ModelRequest {
        messages: Vec::new(),
        items: items.to_vec(),
        tool_profile: Some(profile),
        tools: Vec::new(),
        reasoning_effort_override: None,
        session_override: None,
        stream: true,
        max_output_tokens,
    }
}

/// Pure preparation of one turn's exact request bytes (sends nothing).
pub fn prepare_inspect_turn(
    req: &ModelRunRequest,
    items: &[InputItem],
    profile: ToolProfile,
) -> Result<PreparedModelRun, ClientError> {
    let b = bind_with(req, "repo-inspect")?;
    let runtime = runtime_for(&b.target, nexus_model::TransportLimits::default(), None);
    let prepared = runtime
        .prepare(
            &b.pin,
            &b.issued,
            &req.snapshot,
            &b.target,
            &input_items_model(items, req.max_output_tokens, profile),
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
        request_bytes: prepared.request_bytes.len(),
    })
}

impl InspectSession {
    /// Open the conversation: user prompt + accepted + target-selected.
    pub fn begin(
        cfg: &ClientConfig,
        task_instance_id: &str,
        prompt: &str,
        basics: &InspectBasics,
    ) -> Result<Self, ClientError> {
        let store =
            Arc::new(TranscriptStore::open(&cfg.transcript_dir).map_err(|e| {
                ClientError::internal(format!("transcript store unavailable: {e}"))
            })?);
        let conv = model_conversation_id()?;
        let kind = endpoint_kind(&basics.endpoint_origin);
        let meta = StateMeta {
            provider_id: Some(basics.provider_id.clone()),
            remote_model_id: Some(basics.remote_model_id.clone()),
            logical_model_id: Some(basics.logical_model_id.clone()),
            endpoint_kind: Some(kind.to_owned()),
            endpoint_origin: Some(basics.endpoint_origin.clone()),
            response_origin: Some(if kind == "provider" {
                "provider".to_owned()
            } else {
                "loopback-test-double".to_owned()
            }),
            ..Default::default()
        };
        let mut rec = Recorder {
            store,
            conv: conv.clone(),
            task_instance_id: task_instance_id.to_owned(),
            attempt_id: String::new(),
            actor: Actor {
                agent: Some(format!("nexus-{}", basics.mode)),
                model: Some(basics.remote_model_id.clone()),
                provider: Some(basics.provider_id.clone()),
            },
            meta,
            text: String::new(),
            rev: 0,
            last_partial_ms: 0,
            suffix: String::new(),
        };
        let (prompt_text, redactions) = nexus_transcript::redact::redact_text(prompt);
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
            &format!(
                "Request accepted (user-initiated {} on '{}'{}).",
                basics.mode,
                basics.workspace_id,
                if basics.mode == "repo-code" {
                    "; isolated working copy, every write and command needs independent approval"
                } else {
                    ", read-only tools"
                }
            ),
            None,
        )?;
        rec.state(
            ModelRunState::TargetSelected,
            &format!(
                "Target {}/{} via {} ({}). Selected repository contents may be sent to this provider.",
                basics.provider_id,
                basics.remote_model_id,
                basics.endpoint_origin,
                if kind == "provider" {
                    "provider endpoint"
                } else {
                    "loopback test double, not a real provider"
                }
            ),
            None,
        )?;
        Ok(Self {
            rec,
            conv,
            kind: if kind == "provider" {
                "provider"
            } else {
                "loopback-test-double"
            },
        })
    }

    pub fn conversation_id(&self) -> &str {
        &self.conv
    }

    pub fn endpoint_kind(&self) -> &'static str {
        self.kind
    }

    /// Start a model turn: its own attempt/command/request digest.
    pub fn begin_turn(
        &mut self,
        turn: impl std::fmt::Display,
        attempt_id: &str,
        command_id: &str,
        digest: &str,
    ) {
        self.rec.suffix = format!("-t{turn}");
        self.rec.attempt_id = attempt_id.to_owned();
        self.rec.meta.attempt_id = Some(attempt_id.to_owned());
        self.rec.meta.command_id = Some(command_id.to_owned());
        self.rec.meta.request_digest = Some(digest.to_owned());
        self.rec.meta.http_status = None;
        self.rec.meta.finish_reason = None;
        self.rec.meta.provider_request_id = None;
        self.rec.meta.provider_response_id = None;
        self.rec.meta.error_code = None;
        self.rec.text.clear();
        self.rec.rev = 0;
    }

    pub fn state(
        &mut self,
        state: ModelRunState,
        text: &str,
        error_code: Option<&str>,
    ) -> Result<(), ClientError> {
        self.rec.state(state, text, error_code)
    }

    /// Cumulative provider-reported usage across turns (only what was supplied).
    pub fn set_usage(&mut self, input: u64, output: u64) {
        self.rec.meta.usage_input_tokens = Some(input);
        self.rec.meta.usage_output_tokens = Some(output);
    }

    pub fn set_latency(&mut self, ms: u64) {
        self.rec.meta.latency_ms = Some(ms);
    }

    /// Record a validated-or-refused tool proposal.
    pub fn tool_call(
        &self,
        index: u32,
        call_id: &str,
        tool: &str,
        args_json: &str,
        status: &str,
        is_error: bool,
    ) -> Result<(), ClientError> {
        let mut e = self.rec.base(
            &format!("toolcall-{index}"),
            EventKind::ToolCall,
            Speaker::Worker,
            InputClass::ModelGenerated,
        );
        e.actor = self.rec.actor.clone();
        e.tool_name = Some(tool.to_owned());
        e.tool_call_id = Some(call_id.to_owned());
        // The model chose these bytes: redact credential-shaped spans before
        // they are stored (the same redactor the user prompt goes through).
        let (args, redactions) = nexus_transcript::redact::redact_text(
            &args_json.chars().take(2048).collect::<String>(),
        );
        e.tool_input = Some(args);
        e.redactions = redactions;
        e.text = Some(format!("{tool} {status}"));
        e.is_error = Some(is_error);
        self.rec.append(e)
    }

    /// Record the (bounded, untrusted) result handed back to the model.
    pub fn tool_result(
        &self,
        index: u32,
        call_id: &str,
        tool: &str,
        preview: &str,
        provenance_json: &str,
        is_error: bool,
    ) -> Result<(), ClientError> {
        let mut e = self.rec.base(
            &format!("toolresult-{index}"),
            EventKind::ToolResult,
            Speaker::Tool,
            InputClass::ToolOutput,
        );
        e.actor = Actor {
            agent: Some("nexus-native-tools".to_owned()),
            model: None,
            provider: None,
        };
        e.tool_name = Some(tool.to_owned());
        e.tool_call_id = Some(call_id.to_owned());
        e.tool_input = Some(provenance_json.to_owned());
        let (text, redactions) = nexus_transcript::redact::redact_text(
            &preview.chars().take(8 * 1024).collect::<String>(),
        );
        e.text = Some(text);
        e.redactions = redactions;
        e.is_error = Some(is_error);
        self.rec.append(e)
    }
}

/// The request for one turn. The authority-bearing JSON is data to be
/// re-verified: the Kernel seals bind these digests, so tampered copies fail
/// redemption.
pub struct InspectTurn<'a> {
    pub profile: ToolProfile,
    pub request: &'a ModelRunRequest,
    pub items: Vec<InputItem>,
    /// `result.grant` of the daemon's `dispatch-authorize` (scope repo-inspect).
    pub grant: &'a serde_json::Value,
}

/// What one provider response contained (all of it untrusted data).
#[derive(Debug, Clone)]
pub struct TurnOutput {
    pub text: String,
    /// The response's assistant `message` items with the provider's phase, in wire order
    /// (empty when the provider completed none; `text` is always the whole text).
    pub messages: Vec<nexus_model::AssembledMessage>,
    /// The response's replayable `reasoning` items (canonical JSON), in wire order.
    pub reasoning: Vec<String>,
    pub tool_calls: Vec<AssembledToolCall>,
    pub usage: Option<(u64, u64)>,
    pub response_id: Option<String>,
    pub finish_reason: String,
    pub http_status: Option<u16>,
    pub provider_request_id: Option<String>,
    pub first_token_ms: Option<u64>,
    pub latency_ms: u64,
    pub request_digest: String,
    /// Truncated turns only: the response had started (or even finished) a tool call.
    pub partial_tool: bool,
}

/// How a turn ended.
#[derive(Debug, Clone)]
pub enum TurnEnd {
    /// A complete provider response (text and/or proposed tool calls).
    Output(Box<TurnOutput>),
    /// A6.1.4: the provider ended the response at `max_output_tokens` (reasoning
    /// tokens included). Whatever it had assembled, including any half-written
    /// tool call, is DISCARDED: nothing from this turn may execute. Not terminal;
    /// the caller decides whether to spend another authorized turn on a larger cap.
    Truncated(Box<TurnOutput>),
    /// Anything else: cancelled, timed out, uncertain, refused, failed. The
    /// terminal run state has ALREADY been recorded; the loop must stop.
    Ended {
        state: ModelRunState,
        code: String,
        message: String,
        latency_ms: u64,
    },
}

/// Execute ONE authorized repo-inspect provider request.
///
/// `cancel_flag` (the broker's per-run flag) and the conversation's cancel
/// marker both stop the transport. Never retries.
pub fn run_inspect_turn(
    cfg: &ClientConfig,
    opts: &crate::model_run::ModelRunOptions,
    session: &mut InspectSession,
    turn: &InspectTurn<'_>,
    cancel_flag: &Arc<AtomicBool>,
    on_text: &mut dyn FnMut(&str),
) -> Result<TurnEnd, ClientError> {
    let started = Instant::now();
    let req = turn.request;
    let bound = bind_with(req, "repo-inspect")?;
    let runtime = runtime_for(&bound.target, opts.limits, opts.transport.as_ref());
    let prepared = runtime
        .prepare(
            &bound.pin,
            &bound.issued,
            &req.snapshot,
            &bound.target,
            &input_items_model(&turn.items, req.max_output_tokens, turn.profile),
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
    let grant = grant_from_json(turn.grant)?;
    let want_scope = match turn.profile {
        ToolProfile::RepoInspectV1 => nexus_kernel::SCOPE_REPO_INSPECT,
        // the experimental signals tool is broker-handled: the Kernel scope stays repo-code
        ToolProfile::RepoCodeV1 | ToolProfile::RepoCodeMuseSignalsV1 => {
            nexus_kernel::SCOPE_REPO_CODE
        }
    };
    if grant.scope != want_scope {
        return Err(ClientError::usage(
            "grant scope does not match this agentic profile; this executor sends nothing for any other scope",
        ));
    }
    let credential = Credential::from_protected_file(&opts.credentials_path, &grant.credential_ref)
        .map_err(|e| ClientError::blocked(format!("provider credential unavailable: {e}")))?;
    let cap_hex = read_cap(&opts.cap_path)?;
    let request_digest = attested.prepared().request_digest.clone();

    session.rec.state(
        ModelRunState::Authorized,
        "Sealed agentic grant presented; redeeming with the daemon.",
        None,
    )?;

    let cancel = nexus_model::CancellationToken::new();
    let done = Arc::new(AtomicBool::new(false));
    let marker = cancel_marker(cfg, &session.conv);
    let watcher = {
        let cancel = cancel.clone();
        let done = Arc::clone(&done);
        let flag = Arc::clone(cancel_flag);
        let marker = marker.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if flag.load(Ordering::SeqCst) || marker.exists() {
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
        "requestDigest": request_digest,
        "endpointOrigin": attested.prepared().endpoint_origin,
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
    let mut first_token_ms: Option<u64> = None;
    let mut streaming_marked = false;
    let rec_cell = std::cell::RefCell::new(&mut session.rec);
    let text_cell = std::cell::RefCell::new(on_text);
    let result = {
        let mut on_started = || -> Result<(), nexus_model::ModelError> {
            // Write-ahead: durable BEFORE bytes are written.
            rec_cell
                .borrow_mut()
                .state(
                    ModelRunState::RequestStarted,
                    "Provider request started. If this process dies now the outcome is UNKNOWN and the request will not be re-sent.",
                    None,
                )
                .map_err(|e| {
                    nexus_model::ModelError::new(
                        ModelErrorCode::TransportRefused,
                        format!("write-ahead record failed; nothing was sent: {}", e.message),
                    )
                })
        };
        let mut on_event = |ev: &ModelEvent| {
            if let ModelEvent::TextDelta(t) = ev {
                let mut r = rec_cell.borrow_mut();
                if !streaming_marked {
                    streaming_marked = true;
                    let _ = r.state(ModelRunState::Streaming, "Provider is streaming.", None);
                }
                if first_token_ms.is_none() {
                    first_token_ms = Some(started.elapsed().as_millis() as u64);
                }
                r.text.push_str(t);
                if r.text.len() > 256 * 1024 {
                    r.text.truncate(256 * 1024);
                }
                (text_cell.borrow_mut())(t);
                if now_ms().saturating_sub(r.last_partial_ms) >= 120 {
                    let _ = r.assistant(MessageState::Partial);
                }
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
    let rec: &mut Recorder = rec_cell.into_inner();
    let latency_ms = started.elapsed().as_millis() as u64;
    rec.meta.latency_ms = Some(latency_ms);
    rec.meta.first_token_ms = first_token_ms;

    let end = |rec: &mut Recorder,
               state: ModelRunState,
               code: &str,
               message: String|
     -> Result<TurnEnd, ClientError> {
        if !rec.text.is_empty() {
            rec.assistant(MessageState::Interrupted)?;
        }
        rec.state(state, &message, Some(code))?;
        Ok(TurnEnd::Ended {
            state,
            code: code.to_owned(),
            message,
            latency_ms,
        })
    };

    match result {
        Ok(report) => {
            rec.meta.http_status = report.http_status;
            rec.meta.provider_request_id = report.provider_request_id.clone();
            rec.meta.finish_reason = report.finish_reason.clone();
            let mut response_id: Option<String> = None;
            let mut usage: Option<(u64, u64)> = None;
            let mut asm = StreamAssembler::new(
                &req.attempt_id,
                &request_digest,
                opts.limits.max_events,
                opts.limits.max_text_bytes,
                opts.limits.max_arg_bytes,
            );
            let mut assemble_err: Option<nexus_model::ModelError> = None;
            for ev in &report.events {
                match ev {
                    ModelEvent::ResponseId(id) => response_id = Some(id.clone()),
                    ModelEvent::Usage(u) => usage = Some((u.input_tokens, u.output_tokens)),
                    _ => {}
                }
                if let Err(e) = asm.push(ev.clone()) {
                    assemble_err = Some(e);
                    break;
                }
            }
            rec.meta.provider_response_id = response_id.clone();
            if let Some((i, o)) = usage {
                rec.meta.usage_input_tokens = Some(i);
                rec.meta.usage_output_tokens = Some(o);
            }
            if report.truncated || report.finish_reason.is_none() {
                let (code, text) = match report.stop_cause {
                    Some(ModelErrorCode::Timeout) => (
                        "timeout",
                        "The provider timed out mid-response. The outcome is unknown; nothing was re-sent and no proposed tool was run.",
                    ),
                    Some(ModelErrorCode::Cancelled) => (
                        "cancelled",
                        "Cancelled by the user. Any provider-side effect is unknown; nothing was re-sent and no proposed tool was run.",
                    ),
                    _ => (
                        "stream-partial",
                        "The provider stream ended without a terminal event; the output is incomplete. Nothing was re-sent and no proposed tool was run.",
                    ),
                };
                let state = match report.stop_cause {
                    Some(ModelErrorCode::Timeout) => ModelRunState::TimedOut,
                    Some(ModelErrorCode::Cancelled) => ModelRunState::Cancelled,
                    _ => ModelRunState::Uncertain,
                };
                return end(rec, state, code, text.to_owned());
            }
            if report.finish_reason.as_deref() == Some("incomplete:max_output_tokens") {
                if !rec.text.is_empty() {
                    rec.assistant(MessageState::Interrupted)?;
                }
                return Ok(TurnEnd::Truncated(Box::new(TurnOutput {
                    text: rec.text.clone(),
                    messages: Vec::new(),
                    reasoning: Vec::new(),
                    tool_calls: Vec::new(),
                    usage,
                    response_id,
                    finish_reason: "incomplete:max_output_tokens".to_owned(),
                    http_status: report.http_status,
                    provider_request_id: report.provider_request_id.clone(),
                    first_token_ms,
                    latency_ms,
                    request_digest,
                    partial_tool: report.events.iter().any(|e| {
                        matches!(
                            e,
                            ModelEvent::ToolFragment { .. } | ModelEvent::ToolDone { .. }
                        )
                    }),
                })));
            }
            if let Some(e) = assemble_err {
                return end(
                    rec,
                    ModelRunState::Failed,
                    e.code.as_str(),
                    format!("Failed: {}", e.message),
                );
            }
            asm.set_finish(report.finish_reason.as_deref().unwrap_or("stop"));
            match asm.finish() {
                Ok(t) => {
                    if !rec.text.is_empty() || !t.text.is_empty() {
                        rec.text = t.text.clone();
                        rec.assistant(MessageState::Final)?;
                    }
                    Ok(TurnEnd::Output(Box::new(TurnOutput {
                        text: t.text,
                        messages: t.messages,
                        reasoning: t.reasoning_items,
                        tool_calls: t.tool_calls,
                        usage,
                        response_id,
                        finish_reason: t.finish_reason,
                        http_status: report.http_status,
                        provider_request_id: report.provider_request_id.clone(),
                        first_token_ms,
                        latency_ms,
                        request_digest,
                        partial_tool: false,
                    })))
                }
                Err(e) => end(
                    rec,
                    ModelRunState::Failed,
                    "tool-call-incomplete",
                    format!(
                        "Failed: {} (no proposed tool was executed; nothing re-sent)",
                        e.message
                    ),
                ),
            }
        }
        Err(te) => {
            let code = te.error.code;
            let state = classify(code, te.bytes_sent);
            let text = match state {
                ModelRunState::Cancelled => "Cancelled by the user. Any provider-side effect is unknown; the request was not re-sent.".to_owned(),
                ModelRunState::TimedOut => format!("The provider timed out. The outcome is unknown; the request was not re-sent. ({})", te.error.message),
                ModelRunState::Uncertain => format!("Submission outcome is UNCERTAIN (the request may have been processed and billed). It was not re-sent. ({})", te.error.message),
                ModelRunState::Refused => format!("Refused before any byte was sent: {}", te.error.message),
                _ => format!("Failed: {}", te.error.message),
            };
            end(rec, state, code.as_str(), text)
        }
    }
}

/// True when `conversation_id` names a repo-inspect/model conversation the
/// transcript store accepts (used by the broker before serving it).
pub fn valid_conversation_id(id: &str) -> bool {
    valid_task_id(id) && id.starts_with(crate::model_run::MODEL_CONVERSATION_PREFIX)
}
