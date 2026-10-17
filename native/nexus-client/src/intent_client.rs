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
    // ---- A5.5 repo-inspect progress (absent/zero for model-only runs) ----
    /// Server-managed workspace identity (never a path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Provider calls (model turns) started so far / allowed.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub turn: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub max_turns: u32,
    /// Tool calls proposed so far / allowed.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub tool_calls: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub max_tool_calls: u32,
    /// Bytes of tool results returned to the model so far.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub tool_result_bytes: u64,
    /// Which policy limit ended the run cleanly (`max-turns`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// repo-code: approved edit operations used / allowed.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub edits_used: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub max_edits: u32,
    /// repo-code: approved test/build executions used / allowed.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub tests_used: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub max_tests: u32,
    /// repo-code: `pass` / `fail` of the most recent test execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_test_verification: Option<String>,
    /// repo-code: the operation waiting for an independent approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<PendingApproval>,
    /// repo-code: commit the isolated working copy was made from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_commit: Option<String>,
    /// repo-code: final change set (summary; the diff text is `intent diff`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<ChangedFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_digest: Option<String>,
    /// Bounded, ordered record of every proposed tool call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_activity: Vec<ToolActivity>,
    /// `path:line[-line]` references in the final answer that the Controller
    /// could match against bytes the tools actually returned in this run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations_verified: Vec<String>,
    /// References the model made that no tool result in this run supports.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations_unverified: Vec<String>,
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}
fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

/// One model-proposed tool call and what became of it. Everything here is a
/// summary or a digest: result bytes stay in the durable transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub index: u32,
    pub turn: u32,
    /// Provider `call_id` (as supplied; sanitized).
    pub call_id: String,
    /// Model-visible name (`fs_list`, ...), or what it asked for.
    pub tool: String,
    /// Short, redaction-safe argument summary (path, line range; never a
    /// search query's text, only its length).
    pub args_summary: String,
    /// `executed` | `refused` | `failed` | `cancelled`
    pub status: String,
    pub error_code: Option<String>,
    pub result_bytes: u64,
    pub result_digest: Option<String>,
    pub truncated: bool,
    pub execution_id: Option<String>,
    pub journal_seq: Option<i64>,
    pub args_digest: Option<String>,
    // ---- A5.6 repo-code (absent for read-only tools) ----
    /// The independent approval this mutation/process ran under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// `approved` | `denied` | `expired` | `revoked` | `cancelled` | `timed-out`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_outcome: Option<String>,
    /// Write/edit: sha256 of the file before and after (receipt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_sha256: Option<String>,
    /// Process: exit code and `pass`/`fail`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
}

/// An operation waiting for an independent human approval (A5.6). The
/// reviewer uses the separate approver tool; nothing here can approve.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub approval_id: String,
    pub tool: String,
    pub summary: String,
    pub request_digest: Option<String>,
    pub expires_at_ms: Option<u64>,
    /// `edit` | `write` | `command` (A6.1: what the reviewer will be asked about).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// File path inside the working copy, or the executable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Bounded text of the MODEL'S proposal (changed lines / argv). The
    /// authoritative, daemon-derived diff is only shown to the approver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<String>,
    /// Fixed, human-readable restrictions that apply to this operation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub restrictions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
}

/// The fixed run limits the Desktop uses for `repo-code` (A6.1). They are
/// defined here, shown to the user before submitting, and cannot be chosen by
/// the renderer. A live session authorization must allow at least these.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCodeLimits {
    pub max_turns: u32,
    pub max_tool_calls: u32,
    pub max_tool_result_bytes: u64,
    pub max_edits: u32,
    pub max_tests: u32,
    pub max_output_tokens: u64,
    pub max_runtime_secs: u64,
}

pub const DESKTOP_CODE_LIMITS: DesktopCodeLimits = DesktopCodeLimits {
    max_turns: 12,
    max_tool_calls: 30,
    max_tool_result_bytes: 131_072,
    max_edits: 5,
    max_tests: 5,
    max_output_tokens: 1024,
    max_runtime_secs: 1800,
};

impl DesktopCodeLimits {
    pub fn to_intent_limits(self) -> nexus_contracts::intent::IntentLimits {
        nexus_contracts::intent::IntentLimits {
            max_output_tokens: Some(self.max_output_tokens),
            max_turns: Some(self.max_turns),
            max_tool_calls: Some(self.max_tool_calls),
            max_tool_result_bytes: Some(self.max_tool_result_bytes),
            max_runtime_secs: Some(self.max_runtime_secs),
            max_edits: Some(self.max_edits),
            max_tests: Some(self.max_tests),
        }
    }
}

/// One file of the final reviewable change set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

/// A source repository this client may ask Nexus to modify (identity only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedCodeSource {
    pub source_id: String,
}

/// The reviewable result of a repo-code run, from the isolated working copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReply {
    pub run: IntentRun,
    pub base_commit: String,
    pub files: Vec<ChangedFile>,
    pub files_truncated: bool,
    pub diff: String,
    pub diff_digest: String,
    pub diff_truncated: bool,
}

/// A workspace this client may select (identity only, never a path).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedWorkspace {
    pub workspace_id: String,
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
        "workspace-not-allowed",
        "code-not-available",
        "live-not-authorized",
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

/// Workspaces this client may select for `repo-inspect`.
pub fn workspaces(socket: &Path) -> Result<Vec<AllowedWorkspace>, ClientError> {
    let v = call(socket, "intent-workspaces", serde_json::json!({}), 10_000)?;
    decode(v.get("workspaces").cloned().unwrap_or_default())
}

/// Operator-approved CODING sources (A5.6) this client may select. Distinct
/// from read-only workspaces: a right to inspect never implies a right to edit.
pub fn code_sources(socket: &Path) -> Result<Vec<AllowedCodeSource>, ClientError> {
    let v = call(socket, "intent-code-sources", serde_json::json!({}), 10_000)?;
    decode(v.get("sources").cloned().unwrap_or_default())
}

/// The reviewable change set of one of THIS client's repo-code runs.
pub fn diff(socket: &Path, run_id: &str) -> Result<DiffReply, ClientError> {
    decode(call(
        socket,
        "intent-diff",
        serde_json::json!({ "runId": run_id }),
        30_000,
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
