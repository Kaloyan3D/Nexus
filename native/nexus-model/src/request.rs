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
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

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

/// Model input. The remote model id, reasoning effort, and session binding
/// are NOT fields here: they are target-bound at preparation.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelRequest {
    /// Conversation messages (1..=MAX_MESSAGES).
    pub messages: Vec<ChatMessage>,
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
