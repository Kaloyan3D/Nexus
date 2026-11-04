//! Versioned conversation event contract. Additive: readers must ignore
//! unknown fields; writers must never reuse an `event_id` + `revision` with
//! different content.

use serde::{Deserialize, Serialize};

pub const TRANSCRIPT_SCHEMA: &str = "nexus.transcript/v1";

/// What kind of record this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    UserMessage,
    /// Controller- or runtime-authored text that the model could see.
    ControllerMessage,
    AssistantMessage,
    ToolCall,
    ToolResult,
    /// Recovery/status notices that belong in the conversation (e.g. retries).
    Status,
    Error,
    ModelHandoff,
}

/// Who actually produced the record. Never defaults to the orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Speaker {
    User,
    Orchestrator,
    Worker,
    Reviewer,
    Tool,
    Runtime,
    Controller,
}

/// The spec's input taxonomy: what is this text, relative to the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputClass {
    /// Typed by the user.
    UserAuthored,
    /// Written by the Controller (bindings, attempt notices).
    ControllerCompiled,
    /// Injected by the runtime (policy snapshots, skill catalogs).
    RuntimeInjected,
    /// Result a tool returned that the model saw.
    ToolOutput,
    /// Produced by the model.
    ModelGenerated,
    /// Execution/status notice that is not model-visible input.
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageState {
    Partial,
    Final,
    /// The attempt/turn ended before this message was finalized.
    Interrupted,
}

/// Where the record came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    /// Written by the native backend at the execution boundary.
    NativeStore,
    /// Read-only import from a historical DSH session log.
    DshSessionLog,
    /// Isolated mock workflow (fixture output, never authoritative history).
    MockFixture,
}

/// How faithfully the content mirrors what was recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Recording {
    /// A finalized record exists in the source.
    Recorded,
    /// Assembled from recorded stream chunks; no finalized record existed.
    AssembledFromChunks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    /// Recorded agent identity (e.g. `aih-muse`), if known.
    pub agent: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEventV1 {
    pub schema: String,
    /// Stable, source-derived identity. Same id + revision = same record.
    pub event_id: String,
    /// Logical message identity; later `revision`s supersede earlier ones.
    pub message_id: String,
    pub revision: u32,
    /// Position within this task's transcript (assigned by store/adapter).
    pub seq: u64,
    pub task_instance_id: String,
    pub display_task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub session_id: Option<String>,
    pub turn: Option<u64>,
    pub kind: EventKind,
    pub speaker: Speaker,
    pub actor: Actor,
    pub input_class: InputClass,
    pub timestamp_ms: Option<u64>,
    pub state: MessageState,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_input: Option<String>,
    pub is_error: Option<bool>,
    pub error_code: Option<String>,
    pub source: Source,
    pub recording: Recording,
    /// Number of credential-like spans replaced with `[REDACTED:*]`.
    pub redactions: u32,
    pub truncated: bool,
    pub original_len: Option<u64>,
    /// Store sequence of the revision being shown. In collapsed views `seq` is
    /// the stable display position and this is the live-follow cursor value.
    #[serde(default)]
    pub revision_seq: u64,
}

impl TranscriptEventV1 {
    /// Minimal constructor; callers fill the rest explicitly.
    pub fn new(
        event_id: impl Into<String>,
        task_instance_id: impl Into<String>,
        kind: EventKind,
        speaker: Speaker,
        input_class: InputClass,
        source: Source,
    ) -> Self {
        let id = event_id.into();
        Self {
            schema: TRANSCRIPT_SCHEMA.to_owned(),
            message_id: id.clone(),
            event_id: id,
            revision: 0,
            seq: 0,
            task_instance_id: task_instance_id.into(),
            display_task_id: None,
            attempt_id: None,
            session_id: None,
            turn: None,
            kind,
            speaker,
            actor: Actor::default(),
            input_class,
            timestamp_ms: None,
            state: MessageState::Final,
            text: None,
            tool_name: None,
            tool_call_id: None,
            tool_input: None,
            is_error: None,
            error_code: None,
            source,
            recording: Recording::Recorded,
            redactions: 0,
            truncated: false,
            original_len: None,
            revision_seq: 0,
        }
    }
}

/// Recorded provider-request header (Model I/O view). Never a reconstructed
/// payload: only fields that exist in the source record are present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestRecord {
    pub record_id: String,
    pub attempt_id: Option<String>,
    pub session_id: String,
    pub turn: Option<u64>,
    pub timestamp_ms: Option<u64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub max_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub system_prompt: Option<String>,
    pub system_prompt_len: u64,
    pub system_prompt_truncated: bool,
    pub tool_names: Vec<String>,
    pub redactions: u32,
    pub source: Source,
}

/// Provenance of one attempt: how it was joined to its conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptProvenance {
    pub attempt_id: String,
    pub sequence: u64,
    pub execution_class: Option<String>,
    pub session_id: Option<String>,
    pub started_by_turn: Option<u64>,
    pub started_at_utc: Option<String>,
    /// `verified` only when the session's in-record binding names this task instance.
    pub binding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub records_scanned: u64,
    pub events_emitted: u64,
    pub records_invalid: u64,
    pub reasoning_blocks_omitted: u64,
    pub redactions: u64,
    pub truncated_fields: u64,
    pub nested_tool_dispatches_not_rendered: u64,
    pub notes: Vec<String>,
}
