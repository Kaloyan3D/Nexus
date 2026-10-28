//! OpenCode Go-compatible request/response contracts (A2.2, Phase 4.3).
//!
//! `ModelRequest` is UI-adjacent input: messages, tool definitions, and
//! optional overrides. It carries NO endpoint, NO model id, NO credential —
//! those come only from the pinned target at preparation time. Overrides
//! that disagree with the pin are `wrong-target`, never merged.
//!
//! Serialization is exact and inspectable BEFORE any byte is sent
//! (`prepare()` returns the bytes; see `prepare.rs`). Response frames are
//! Responses-compatible SSE (`data: {...}`), normalized by `sse.rs`.

use crate::error::{ModelError, ModelErrorCode};

/// Bounds keeping every payload inside auditable limits.
pub const MAX_MESSAGES: usize = 128;
/// Per-message content bound.
pub const MAX_MESSAGE_CHARS: usize = 32 * 1024;
/// Tool definition bound.
pub const MAX_TOOLS: usize = 64;
/// Total serialized request bound (1 MiB).
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// One chat message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    /// `user`, `assistant`, `system`, `developer`, or `tool`.
    pub role: String,
    /// Message text.
    pub content: String,
}

/// One callable tool definition (declared, never executed by the transport).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    /// Tool name (non-empty).
    pub name: String,
    /// Human description.
    pub description: String,
    /// JSON-Schema parameters.
    pub parameters: serde_json::Value,
}

/// One item of a tool-capable (`repo-inspect`) conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputItem {
    /// A user or assistant message.
    Message { role: String, content: String },
    /// A function call the model made earlier, echoed back verbatim.
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    /// The result of executing that call (untrusted repository data).
    FunctionCallOutput { call_id: String, output: String },
    /// One of the model's own earlier `message` items, replayed with the phase the provider
    /// gave it (`commentary` or `final_answer`). Phase-aware models treat an unlabelled
    /// assistant message as a final answer.
    AssistantPhase { phase: String, content: String },
    /// One of the model's own `reasoning` items from an earlier response of this run,
    /// replayed verbatim (canonical JSON from `sse::replayable_reasoning`).
    Reasoning { item: String },
}

/// Which fixed tool catalog a request offers. `None` on a request means
/// text-only: the OpenCode Go adapter then refuses every tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolProfile {
    /// `fs_list`, `fs_read`, `fs_search` (see `repo_tools`).
    RepoInspectV1,
    /// `fs_list`, `fs_read`, `fs_search` plus `fs_write`, `fs_edit`,
    /// `proc_run` (A5.6, `repo-code` only; every mutation needs approval).
    RepoCodeV1,
    /// EM-04B EXPERIMENTAL (test fixtures only): `RepoCodeV1` plus the Muse reasoning-signals tool
    /// `muse_update_reasoning_state`, which the broker handles as control-plane input (no Kernel
    /// tool, no effect outside engine state). Offered only to the isolated `muse-v1-signals` engine;
    /// `RepoCodeV1` stays byte-identical.
    RepoCodeMuseSignalsV1,
    /// M7D: `RepoCodeV1` plus the four broker-handled background-job tools
    /// (`job_start`/`job_status`/`job_logs`/`job_stop`, no Kernel tool ids). Offered only to
    /// the `muse-v0-jobs` engine; `RepoCodeV1` stays byte-identical.
    RepoCodeJobsV1,
    /// Adaptive + Jobs: the `nexus-adaptive-v1` catalog — the full coding
    /// catalog, the reasoning-signals tool, and the four job tools.
    RepoCodeAdaptiveJobsV1,
}

/// Bounds for a tool-capable conversation.
pub const MAX_INPUT_ITEMS: usize = 480;
pub const MAX_TOOL_OUTPUT_CHARS: usize = 96 * 1024;

/// Model input. The remote model id, reasoning effort, and session binding
/// are NOT fields here: they are target-bound at preparation.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelRequest {
    /// Conversation messages (1..=MAX_MESSAGES).
    pub messages: Vec<ChatMessage>,
    /// Tool-capable conversation (A5.5). Used INSTEAD of `messages` when
    /// `tool_profile` is set; must be empty otherwise.
    pub items: Vec<InputItem>,
    /// Fixed tool catalog to offer (A5.5). `tools` must stay empty: the
    /// definitions come from the crate, never from the caller.
    pub tool_profile: Option<ToolProfile>,
    /// Declared tools (0..=MAX_TOOLS). Fragments are assembled by `sse.rs`
    /// and returned as data; the transport never executes them.
    pub tools: Vec<ToolDefinition>,
    /// Optional reasoning override: must equal the pinned effort or the
    /// request is `wrong-target`. `None` inherits the pin.
    pub reasoning_effort_override: Option<String>,
    /// Optional session override: must equal the pinned session or the
    /// request is `wrong-target`. `None` inherits the pin.
    pub session_override: Option<String>,
    /// Streaming is mandatory: terminal normalization requires the SSE
    /// event stream. Non-streaming requests are refused.
    pub stream: bool,
    /// Optional per-request output cap (A5.3). It can only LOWER the
    /// Registry-sealed output limit; a value above it is `wrong-target`.
    pub max_output_tokens: Option<u64>,
}

impl ModelRequest {
    /// Minimal text-only request used by conformance tests.
    pub fn text_only(role: &str, content: &str) -> Self {
        Self {
            messages: vec![ChatMessage {
                role: role.to_owned(),
                content: content.to_owned(),
            }],
            items: Vec::new(),
            tool_profile: None,
            tools: Vec::new(),
            reasoning_effort_override: None,
            session_override: None,
            stream: true,
            max_output_tokens: None,
        }
    }

    /// Effective output cap: the sealed limit, or a lower caller request.
    pub fn effective_max_output(&self, sealed: u64) -> Result<u64, ModelError> {
        match self.max_output_tokens {
            None => Ok(sealed),
            Some(0) => Err(ModelError::new(
                ModelErrorCode::TargetIncomplete,
                "output cap must be positive",
            )),
            Some(n) if n <= sealed => Ok(n),
            Some(_) => Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "requested output cap exceeds the Registry-sealed output limit",
            )),
        }
    }

    /// Structural validation (bounds only; target binding happens in
    /// `prepare`). Credential-shaped content is NOT scanned here on
    /// purpose: user text may legitimately discuss secrets, and the
    /// guarantee is that credentials never enter headers/errors — not that
    /// users cannot type them.
    pub fn validate_shape(&self) -> Result<(), ModelError> {
        if !self.stream {
            return Err(ModelError::new(
                ModelErrorCode::TransportRefused,
                "non-streaming requests are refused: terminal normalization requires SSE",
            ));
        }
        if self.tool_profile.is_some() {
            return self.validate_tool_shape();
        }
        if !self.items.is_empty() {
            return Err(ModelError::new(
                ModelErrorCode::TransportRefused,
                "conversation items require a tool profile",
            ));
        }
        if self.messages.is_empty() || self.messages.len() > MAX_MESSAGES {
            return Err(ModelError::new(
                ModelErrorCode::TransportRefused,
                format!("message count must be 1..={MAX_MESSAGES}"),
            ));
        }
        for (i, m) in self.messages.iter().enumerate() {
            if m.role.trim().is_empty() {
                return Err(ModelError::new(
                    ModelErrorCode::TransportRefused,
                    format!("message {i} has an empty role"),
                ));
            }
            if m.content.is_empty() || m.content.len() > MAX_MESSAGE_CHARS {
                return Err(ModelError::new(
                    ModelErrorCode::TransportRefused,
                    format!("message {i} exceeds the content bound"),
                ));
            }
        }
        if self.tools.len() > MAX_TOOLS {
            return Err(ModelError::new(
                ModelErrorCode::TransportRefused,
                format!("tool count exceeds {MAX_TOOLS}"),
            ));
        }
        for (i, t) in self.tools.iter().enumerate() {
            if t.name.trim().is_empty() {
                return Err(ModelError::new(
                    ModelErrorCode::TransportRefused,
                    format!("tool {i} has an empty name"),
                ));
            }
        }
        Ok(())
    }

    fn validate_tool_shape(&self) -> Result<(), ModelError> {
        let refuse = |m: &str| Err(ModelError::new(ModelErrorCode::TransportRefused, m));
        if !self.messages.is_empty() || !self.tools.is_empty() {
            return refuse(
                "a tool-profile request uses items only; caller tool definitions are refused",
            );
        }
        if self.items.is_empty() || self.items.len() > MAX_INPUT_ITEMS {
            return refuse("item count is out of range");
        }
        let id_ok = |s: &str| {
            !s.is_empty()
                && s.len() <= 80
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
        };
        for it in &self.items {
            match it {
                InputItem::Message { role, content } => {
                    if role != "user" && role != "assistant" {
                        return refuse("only user and assistant messages are accepted");
                    }
                    if content.is_empty() || content.len() > MAX_MESSAGE_CHARS {
                        return refuse("message content is empty or oversized");
                    }
                }
                InputItem::FunctionCall {
                    call_id,
                    name,
                    arguments,
                } => {
                    // The echo is HISTORY: a refused proposal (unknown tool) must
                    // still be answered with an output, so only the shape is
                    // checked here. The offered catalog stays the fixed three.
                    let name_ok = !name.is_empty()
                        && name.len() <= 64
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
                    if !id_ok(call_id) || !name_ok || arguments.len() > MAX_MESSAGE_CHARS {
                        return refuse("function call echo is malformed");
                    }
                }
                InputItem::FunctionCallOutput { call_id, output } => {
                    if !id_ok(call_id) || output.len() > MAX_TOOL_OUTPUT_CHARS {
                        return refuse("function call output is malformed or oversized");
                    }
                }
                InputItem::Reasoning { item } => {
                    let ok = serde_json::from_str::<serde_json::Value>(item)
                        .ok()
                        .and_then(|v| crate::sse::replayable_reasoning(&v))
                        .is_some_and(|canon| canon == *item);
                    if !ok {
                        return refuse("reasoning item is malformed");
                    }
                }
                InputItem::AssistantPhase { phase, content } => {
                    if phase != "commentary" && phase != "final_answer" {
                        return refuse("assistant message phase is not a documented value");
                    }
                    if content.is_empty() || content.len() > MAX_MESSAGE_CHARS {
                        return refuse("message content is empty or oversized");
                    }
                }
            }
        }
        // Every output must answer an earlier call with the same id, once.
        let mut open: Vec<&str> = Vec::new();
        let mut answered: Vec<&str> = Vec::new();
        for it in &self.items {
            match it {
                InputItem::FunctionCall { call_id, .. } => {
                    if open.contains(&call_id.as_str()) || answered.contains(&call_id.as_str()) {
                        return refuse("duplicate function call id");
                    }
                    open.push(call_id);
                }
                InputItem::FunctionCallOutput { call_id, .. } => {
                    let Some(pos) = open.iter().position(|c| *c == call_id) else {
                        return refuse("function call output without a matching call");
                    };
                    open.remove(pos);
                    answered.push(call_id);
                }
                InputItem::Message { .. }
                | InputItem::AssistantPhase { .. }
                | InputItem::Reasoning { .. } => {}
            }
        }
        if !open.is_empty() {
            return refuse("a function call has no output; the provider would reject the request");
        }
        // The conversation must end on something the model should answer.
        match self.items.last() {
            Some(
                InputItem::FunctionCall { .. }
                | InputItem::AssistantPhase { .. }
                | InputItem::Reasoning { .. },
            )
            | None => {
                return refuse("conversation must end with a user message or a function output")
            }
            Some(InputItem::Message { role, .. }) if role != "user" => {
                return refuse("conversation must end with a user message or a function output")
            }
            _ => {}
        }
        Ok(())
    }

    /// Effective reasoning effort against the pinned target value.
    pub fn effective_reasoning<'a>(&'a self, pinned: &'a str) -> Result<&'a str, ModelError> {
        match self.reasoning_effort_override.as_deref() {
            None => Ok(pinned),
            Some(o) if o == pinned => Ok(pinned),
            Some(_) => Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "reasoning effort override differs from the pinned target",
            )),
        }
    }

    /// Effective session id against the pinned session binding.
    pub fn effective_session<'a>(&'a self, pinned: &'a str) -> Result<&'a str, ModelError> {
        match self.session_override.as_deref() {
            None => Ok(pinned),
            Some(o) if o == pinned => Ok(pinned),
            Some(_) => Err(ModelError::new(
                ModelErrorCode::WrongTarget,
                "session override differs from the pinned session binding",
            )),
        }
    }
}
