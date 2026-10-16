//! Unprivileged intent-broker client (A5.3).
//!
//! The ONE client path for user intents: `nexus intent ...` (CLI), the
//! Tauri backend (Nexus Desktop) and any future external consumer all use
//! these functions, which speak the narrow broker protocol over a local
//! Unix socket. Nothing here reads an issuer capability or a provider
//! credential, signs a frame, or can name a daemon command: the broker
//! socket accepts only the intent verbs below.

use crate::error::{ClientError, ExitCode};
use nexus_contracts::intent::NexusIntentV1;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const BROKER_PROTOCOL_VERSION: u32 = 1;
/// Schema tag on every CLI JSON envelope.
pub const CLI_SCHEMA: &str = "nexus.intent.cli/v1";

/// Default broker socket: `NEXUS_BROKER_SOCKET` or `~/.nexus/broker.sock`.
pub fn default_broker_socket() -> PathBuf {
    if let Ok(p) = std::env::var("NEXUS_BROKER_SOCKET") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h).join(".nexus").join("broker.sock"),
        _ => PathBuf::from("/tmp/nexus-broker.sock"),
    }
}

/// Server-assigned view of one run. Identity fields (`clientId`, ids) are
/// authoritative broker/Controller values, never client input.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntentRun {
    pub run_id: String,
    pub request_id: String,
    /// `uid:<n>`: derived from the connection's OS peer credentials.
    pub client_id: String,
    /// received | preparing | authorized | executing | request-started |
    /// streaming | completed | cancelled | timed-out | provider-failed |
    /// uncertain | refused | failed | rejected | abandoned
    pub state: String,
    pub terminal: bool,
    pub intent_type: String,
    pub response_mode: String,
    pub task_id: Option<String>,
    pub task_instance_id: Option<String>,
    pub attempt_id: Option<String>,
    pub command_id: Option<String>,
    pub conversation_id: Option<String>,
    pub provider_id: Option<String>,
    pub remote_model_id: Option<String>,
    pub logical_model_id: Option<String>,
    /// `provider` | `loopback-test-double`
    pub endpoint_kind: Option<String>,
    pub request_digest: Option<String>,
    pub http_status: Option<u16>,
    pub usage_input_tokens: Option<u64>,
    pub usage_output_tokens: Option<u64>,
    pub finish_reason: Option<String>,
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub first_token_ms: Option<u64>,
    #[serde(default)]
    pub provider_request_id: Option<String>,
    #[serde(default)]
    pub provider_response_id: Option<String>,
    /// Machine-readable classification of a non-success end.
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub cancel_requested: bool,
    /// First 160 characters of the user's own prompt (owner-only view).
    #[serde(default)]
    pub prompt_preview: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Allowed (Registry-issued) model the client may select.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedModel {
    pub provider_id: String,
    pub remote_model_id: String,
    pub logical_model_id: String,
    pub endpoint_kind: String,
    pub output_limit_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReply {
    pub run: IntentRun,
    /// True when the idempotency key matched an existing run (no new attempt).
    pub replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultReply {
    pub run: IntentRun,
    /// Untrusted model output (possibly partial when the run did not complete).
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowReply {
    pub run: IntentRun,
    pub text_delta: String,
    pub next_offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReply {
    pub run: IntentRun,
    /// `requested` | `already-requested` | `already-terminal`
    pub outcome: String,
}

fn next_id() -> String {
    crate::model_run::urandom_hex(8).unwrap_or_else(|_| "00000000".to_owned())
}

fn broker_error(resp: &serde_json::Value) -> ClientError {
    let code = resp
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("broker-error");
    let message = resp
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("the broker refused the request");
    let (static_code, exit) = match code {
        "unauthorized" | "peer-unauthorized" => ("unauthorized", ExitCode::Unauthorized),
        "pilot-disabled" | "broker-shutting-down" | "internal" => {
            (leak_code(code), ExitCode::Internal)
        }
        other => (leak_code(other), ExitCode::Usage),
    };
    ClientError::new(static_code, exit, message)
}

/// Map a wire code onto a `&'static str` without allocating per call: the
/// set is closed (anything else becomes `broker-error`).
fn leak_code(code: &str) -> &'static str {
    const KNOWN: &[&str] = &[
        "bad-intent",
        "unsupported-intent-type",
        "unsupported-schema",
        "content-too-large",
        "bad-request",
        "unknown-command",
        "model-not-available",
        "model-not-allowed",
        "idempotency-conflict",
        "bad-offset",
        "not-terminal",
        "not-found",
        "busy",
        "rate-limited",
        "pilot-disabled",
        "broker-shutting-down",
        "internal",
    ];
    KNOWN
        .iter()
        .find(|k| **k == code)
        .copied()
        .unwrap_or("broker-error")
}

fn call(
    socket: &Path,
    cmd: &str,
    params: serde_json::Value,
    timeout_ms: u64,
) -> Result<serde_json::Value, ClientError> {
    let frame = serde_json::json!({
        "protocol": BROKER_PROTOCOL_VERSION,
        "id": format!("c-{}", next_id()),
        "cmd": cmd,
        "params": params,
    });
    let resp = crate::transport::ipc_roundtrip(socket, &frame, timeout_ms)?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(resp
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    } else {
        Err(broker_error(&resp))
    }
}

fn decode<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T, ClientError> {
    serde_json::from_value(v).map_err(|e| ClientError::internal(format!("broker reply shape: {e}")))
}

/// Registry-issued models this client may select.
pub fn models(socket: &Path) -> Result<Vec<AllowedModel>, ClientError> {
    let v = call(socket, "intent-models", serde_json::json!({}), 20_000)?;
    decode(v.get("models").cloned().unwrap_or_default())
}

/// Submit one intent. The intent is validated locally first (fail fast) and
/// again by the broker (authoritative).
pub fn submit(socket: &Path, intent: &NexusIntentV1) -> Result<SubmitReply, ClientError> {
    intent
        .validate()
        .map_err(|e| ClientError::usage(format!("{}: {}", e.code, e.message)))?;
    let v = call(
        socket,
        "intent-submit",
        serde_json::json!({ "intent": intent }),
        60_000,
    )?;
    decode(v)
}

pub fn status(socket: &Path, run_id: &str) -> Result<IntentRun, ClientError> {
    let v = call(
        socket,
        "intent-status",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )?;
    decode(v.get("run").cloned().unwrap_or_default())
}

pub fn result(socket: &Path, run_id: &str) -> Result<ResultReply, ClientError> {
    decode(call(
        socket,
        "intent-result",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )?)
}

/// Long-poll for progress: returns when new text exists, the state changed
/// from `state_seen`, the run is terminal, or `wait_ms` (<= 2000) elapsed.
pub fn follow(
    socket: &Path,
    run_id: &str,
    offset: u64,
    state_seen: Option<&str>,
    wait_ms: u64,
) -> Result<FollowReply, ClientError> {
    decode(call(
        socket,
        "intent-follow",
        serde_json::json!({
            "runId": run_id, "offset": offset, "stateSeen": state_seen, "waitMs": wait_ms.min(2_000),
        }),
        10_000,
    )?)
}

pub fn cancel(socket: &Path, run_id: &str) -> Result<CancelReply, ClientError> {
    decode(call(
        socket,
        "intent-cancel",
        serde_json::json!({ "runId": run_id }),
        10_000,
    )?)
}

pub fn list(socket: &Path, limit: u32) -> Result<Vec<IntentRun>, ClientError> {
    let v = call(
        socket,
        "intent-list",
        serde_json::json!({ "limit": limit }),
        10_000,
    )?;
    decode(v.get("runs").cloned().unwrap_or_default())
}

/// Read-only conversation page for one of THIS client's runs (the broker
/// authorizes by run ownership; the transcript file stays issuer-private).
/// Returns the same JSON shape as a native `ConversationView`.
pub fn conversation(
    socket: &Path,
    conversation_id: &str,
    after_seq: Option<u64>,
    before_seq: Option<u64>,
    limit: Option<u32>,
) -> Result<serde_json::Value, ClientError> {
    let v = call(
        socket,
        "intent-conversation",
        serde_json::json!({
            "conversationId": conversation_id, "afterSeq": after_seq,
            "beforeSeq": before_seq, "limit": limit,
        }),
        15_000,
    )?;
    Ok(v.get("view").cloned().unwrap_or(serde_json::Value::Null))
}

/// Look up the run owning a conversation (Desktop cancel helper).
pub fn run_for_conversation(
    socket: &Path,
    conversation_id: &str,
) -> Result<Option<IntentRun>, ClientError> {
    Ok(list(socket, 100)?
        .into_iter()
        .find(|r| r.conversation_id.as_deref() == Some(conversation_id)))
}

/// Fresh idempotency key (unique per call; callers that want retry safety
/// must pass their own stable key).
pub fn fresh_key(prefix: &str) -> String {
    format!("{prefix}-{}", next_id())
}
