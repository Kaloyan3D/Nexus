//! Typed Rust-to-frontend data contracts. Mirrored by `src/lib/contracts.ts`.
//! Every value originates from nexus-client v1; nothing is synthesized here.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub client_api_version: u32,
    pub ipc_protocol: u32,
    pub platform: String,
    pub socket_path: String,
    pub ledger_dir: Option<String>,
    pub dispatch_enabled: bool,
    pub live_ready: bool,
}

/// `connected` is the only state in which daemon-derived fields are trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Connection {
    Connected,
    Disconnected,
    Unauthorized,
    /// Response shape or protocol did not match; failed closed.
    Malformed,
    /// Daemon claims dispatch is enabled, which this client must refuse to trust.
    Unsafe,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessDimension {
    pub name: String,
    pub ready: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub connection: Connection,
    pub detail: Option<String>,
    pub checked_at_ms: u64,
    pub state: Option<String>,
    pub trust_mode: Option<String>,
    pub incarnation: Option<String>,
    pub accepted_commands: Option<u64>,
    pub total_commands: Option<u64>,
    pub event_count: Option<u64>,
    pub witness_configured: Option<bool>,
    pub witness_present: Option<bool>,
    pub reconciliation_required: Option<bool>,
    pub peer_uid_enforced: Option<bool>,
    pub socket_shared: Option<bool>,
    pub started_at_utc: Option<String>,
    pub active_clients: Option<u64>,
    pub requests: Option<u64>,
    pub refusals: Option<u64>,
    pub errors: Option<u64>,
    pub dispatch_enabled: Option<bool>,
    pub readiness_verdict: Option<String>,
    pub readiness_dimensions: Vec<ReadinessDimension>,
}

impl RuntimeSnapshot {
    pub fn empty(connection: Connection, detail: Option<String>, now_ms: u64) -> Self {
        Self {
            connection,
            detail,
            checked_at_ms: now_ms,
            state: None,
            trust_mode: None,
            incarnation: None,
            accepted_commands: None,
            total_commands: None,
            event_count: None,
            witness_configured: None,
            witness_present: None,
            reconciliation_required: None,
            peer_uid_enforced: None,
            socket_shared: None,
            started_at_utc: None,
            active_clients: None,
            requests: None,
            refusals: None,
            errors: None,
            dispatch_enabled: None,
            readiness_verdict: None,
            readiness_dimensions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationOutcome {
    pub name: String,
    /// `pass` | `fail` | `unknown` (the ledger's own wording is kept in `raw`).
    pub status: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub task_id: String,
    pub task_instance_id: Option<String>,
    pub title: String,
    pub description: String,
    pub description_truncated: bool,
    pub status: String,
    pub bound_engine: Option<String>,
    pub execution_class: Option<String>,
    pub risk: Option<String>,
    pub attempt: Option<u64>,
    pub max_attempts: Option<u64>,
    pub base_commit: Option<String>,
    pub worktree: Option<String>,
    pub created_at_utc: Option<String>,
    pub updated_at_utc: Option<String>,
    pub completed_at_utc: Option<String>,
    pub acceptance_criteria: Vec<String>,
    pub dependencies: Vec<String>,
    pub verification_required: Vec<String>,
    pub verification_outcomes: Vec<VerificationOutcome>,
    pub failure_signatures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksDto {
    pub available: bool,
    pub source: Option<String>,
    pub error: Option<String>,
    pub tasks: Vec<TaskDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    pub seq: i64,
    pub kind: String,
    pub command_id: Option<String>,
    pub recorded_at_utc: Option<String>,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalDto {
    pub events: Vec<JournalEvent>,
    pub receipt_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub model: String,
    pub scope: String,
    pub origin: String,
    pub reasoning: String,
    pub live: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    /// Always `offline-mock-catalog`: not the live Registry.
    pub source: String,
    pub entries: Vec<CatalogEntry>,
    pub live_ready: bool,
    pub blockers: Vec<String>,
    pub dispatch_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBlockers {
    pub ready: bool,
    pub dispatch_enabled: bool,
    pub blockers: Vec<String>,
}

/// Ordered events delivered over a Tauri channel during a mock run.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum MockEvent {
    Started {
        #[serde(rename = "runId")]
        run_id: String,
    },
    Step {
        id: String,
        label: String,
    },
    Stream {
        index: u64,
        kind: String,
        content: String,
    },
    Conversation {
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockCheckDto {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockResult {
    /// Id of the durably recorded conversation (`mock_*`).
    pub conversation_id: String,
    pub run_id: String,
    pub mock: bool,
    pub text: String,
    pub attempt_id: String,
    pub command_id: String,
    pub request_digest: String,
    pub finish_reason: String,
    pub usage_input: u64,
    pub usage_output: u64,
    pub checks: Vec<MockCheckDto>,
    pub event_count: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiError {
    pub code: String,
    pub message: String,
}
