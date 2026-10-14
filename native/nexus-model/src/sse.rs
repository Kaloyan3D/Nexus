//! Deterministic SSE parsing + streaming normalization (A2.2, Phase 4.4-4.6).
//!
//! Responses-compatible frames (`data: {...}`, `data: [DONE]`, `: comment`)
//! are parsed strictly: incomplete or malformed frames are `sse-malformed`,
//! never guessed. Text and reasoning deltas keep wire order; tool-call
//! argument fragments are concatenated per `item_id` and returned as DATA —
//! the transport never executes tools. Usage and terminal status normalize
//! into [`TerminalResponse`]. Every bound lives in `transport::Limits` and
//! is enforced here during assembly.

use crate::error::{ModelError, ModelErrorCode};
use std::collections::BTreeMap;

/// Assembled (never executed) tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssembledToolCall {
    /// Provider item id.
    pub item_id: String,
    /// Tool name.
    pub name: String,
    /// Assembled arguments (parsed JSON).
    pub arguments: serde_json::Value,
}

/// Token usage reported by the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    /// Input tokens.
    pub input_tokens: u64,
    /// Output tokens.
    pub output_tokens: u64,
}

/// Normalized terminal response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalResponse {
    /// Attempt this response belongs to.
    pub attempt_id: String,
    /// Request digest that produced it.
    pub request_digest: String,
    /// Assembled assistant text (wire order).
    pub text: String,
    /// Assembled reasoning text (wire order, where supported).
    pub reasoning_text: String,
    /// Assembled tool calls (data only).
    pub tool_calls: Vec<AssembledToolCall>,
    /// Provider-reported usage.
    pub usage: Usage,
    /// Provider finish reason (`stop`, `tool_calls`, `length`, ...).
    pub finish_reason: String,
}

/// One normalized stream event (wire order preserved).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelEvent {
    /// Assistant text fragment.
    TextDelta(String),
    /// Reasoning fragment (where supported).
    ReasoningDelta(String),
    /// Tool argument fragment (assembly only).
    ToolFragment {
        /// Provider item id.
        item_id: String,
        /// Tool name (first seen wins; drift is `sse-malformed`).
        name: String,
        /// Argument bytes fragment.
        delta: String,
    },
    /// Provider usage snapshot.
    Usage(Usage),
}

struct ToolAssembly {
    name: String,
    args: String,
}

/// Incremental stream assembler. Feed `ModelEvent`s in wire order; `finish`
/// assembles the terminal response or reports the partial failure.
pub struct StreamAssembler {
    attempt_id: String,
    request_digest: String,
    text: String,
    reasoning: String,
    tools: BTreeMap<String, ToolAssembly>,
    usage: Usage,
    finish_reason: Option<String>,
    text_bytes: usize,
    arg_bytes: usize,
    events: usize,
    max_events: usize,
    max_text_bytes: usize,
    max_arg_bytes: usize,
}

impl StreamAssembler {
    /// Create an assembler with explicit bounds.
    pub fn new(
        attempt_id: &str,
        request_digest: &str,
        max_events: usize,
        max_text_bytes: usize,
        max_arg_bytes: usize,
    ) -> Self {
        Self {
            attempt_id: attempt_id.to_owned(),
            request_digest: request_digest.to_owned(),
            text: String::new(),
            reasoning: String::new(),
            tools: BTreeMap::new(),
            usage: Usage::default(),
            finish_reason: None,
            text_bytes: 0,
            arg_bytes: 0,
            events: 0,
            max_events,
            max_text_bytes,
            max_arg_bytes,
        }
    }

    /// Push one normalized event. Bounds are enforced incrementally so an
    /// excessive stream fails fast instead of buffering unboundedly.
    pub fn push(&mut self, event: ModelEvent) -> Result<(), ModelError> {
        self.events += 1;
        if self.events > self.max_events {
            return Err(ModelError::new(
                ModelErrorCode::PayloadTooLarge,
                format!("event count exceeds {}", self.max_events),
            ));
        }
        match event {
            ModelEvent::TextDelta(d) => {
                self.text_bytes += d.len();
                if self.text_bytes > self.max_text_bytes {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "assembled output exceeds the text bound",
                    ));
                }
                self.text.push_str(&d);
                Ok(())
            }
            ModelEvent::ReasoningDelta(d) => {
                self.text_bytes += d.len();
                if self.text_bytes > self.max_text_bytes {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "assembled output exceeds the text bound",
                    ));
                }
                self.reasoning.push_str(&d);
                Ok(())
            }
            ModelEvent::ToolFragment {
                item_id,
                name,
                delta,
            } => {
                if item_id.trim().is_empty() {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool fragment lacks item identity",
                    ));
                }
                // Argument deltas may omit the name when the `added` event
                // already registered it; a name for an UNKNOWN item is
                // malformed (no guessing), and drift within one item is
                // malformed.
                if name.trim().is_empty() && !self.tools.contains_key(&item_id) {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool argument delta for an unregistered item",
                    ));
                }
                let entry = self.tools.entry(item_id).or_insert(ToolAssembly {
                    name: name.clone(),
                    args: String::new(),
                });
                if !name.trim().is_empty() && entry.name != name {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool fragment name drifted within one item",
                    ));
                }
                self.arg_bytes += delta.len();
                if self.arg_bytes > self.max_arg_bytes {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "assembled tool arguments exceed the argument bound",
                    ));
                }
                entry.args.push_str(&delta);
                Ok(())
            }
            ModelEvent::Usage(u) => {
                self.usage = u;
                Ok(())
            }
        }
    }

    /// Record the provider finish reason (`response.completed`).
    pub fn set_finish(&mut self, reason: &str) {
        self.finish_reason = Some(reason.to_owned());
    }

    /// Assemble the terminal response. Fails with `stream-partial` when the
    /// provider never completed, and parses (never executes) tool arguments.
    pub fn finish(self) -> Result<TerminalResponse, ModelError> {
        let reason = match self.finish_reason {
            Some(r) => r,
            None => {
                return Err(ModelError::new(
                    ModelErrorCode::StreamPartial,
                    format!(
                        "stream ended without provider completion after {} events (partial output retained, never executed)",
                        self.events
                    ),
                ));
            }
        };
        let mut calls = Vec::new();
        for (item_id, asm) in self.tools {
            let arguments: serde_json::Value = serde_json::from_str(&asm.args).map_err(|_| {
                ModelError::new(
                    ModelErrorCode::StreamPartial,
                    "tool call arguments are incomplete or invalid JSON (item retained unexecuted)",
                )
            })?;
            calls.push(AssembledToolCall {
                item_id,
                name: asm.name,
                arguments,
            });
        }
        Ok(TerminalResponse {
            attempt_id: self.attempt_id,
            request_digest: self.request_digest,
            text: self.text,
            reasoning_text: self.reasoning,
            tool_calls: calls,
            usage: self.usage,
            finish_reason: reason,
        })
    }
}

/// Parse one raw SSE payload line (the text after `data: `). Returns `None`
/// for the `[DONE]` terminal marker. Provider errors surface as
/// `provider-failed` (message redacted by construction).
///
/// Appends normalized events to `out` and reports completion/failure via
/// the return: `Ok(true)` = provider completed, `Ok(false)` = continue.
pub fn parse_data_payload(
    payload: &str,
    out: &mut Vec<ModelEvent>,
    assembler_finish: &mut Option<String>,
    completed_seen: &mut bool,
) -> Result<bool, ModelError> {
    let trimmed = payload.trim();
    if trimmed == "[DONE]" {
        return Ok(false);
    }
    if trimmed.is_empty() {
        // Empty `data:` lines are keepalive padding, not content: ignore.
        return Ok(false);
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| {
        ModelError::new(
            ModelErrorCode::SseMalformed,
            format!("SSE data frame is not JSON (offset {} )", error_offset(&e)),
        )
    })?;
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "response.output_text.delta" => {
            let delta = value.get("delta").and_then(|v| v.as_str()).ok_or_else(|| {
                ModelError::new(
                    ModelErrorCode::SseMalformed,
                    "output_text.delta lacks a string delta",
                )
            })?;
            out.push(ModelEvent::TextDelta(delta.to_owned()));
            Ok(false)
        }
        "response.reasoning.delta" => {
            let delta = value.get("delta").and_then(|v| v.as_str()).ok_or_else(|| {
                ModelError::new(
                    ModelErrorCode::SseMalformed,
                    "reasoning.delta lacks a string delta",
                )
            })?;
            out.push(ModelEvent::ReasoningDelta(delta.to_owned()));
            Ok(false)
        }
        "response.output_item.added" => {
            // Registers the tool identity; argument bytes arrive as deltas.
            let item = value.get("item").ok_or_else(|| {
                ModelError::new(
                    ModelErrorCode::SseMalformed,
                    "output_item.added lacks an item",
                )
            })?;
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if item_type == "function_call" {
                let id = item.get("id").and_then(|v| v.as_str()).ok_or_else(|| {
                    ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "function_call lacks an item id",
                    )
                })?;
                let name = item.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
                    ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "function_call lacks a tool name",
                    )
                })?;
                out.push(ModelEvent::ToolFragment {
                    item_id: id.to_owned(),
                    name: name.to_owned(),
                    delta: String::new(),
                });
            }
            Ok(false)
        }
        "response.function_call_arguments.delta" => {
            let id = value
                .get("item_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "argument delta lacks an item_id",
                    )
                })?;
            let delta = value.get("delta").and_then(|v| v.as_str()).ok_or_else(|| {
                ModelError::new(
                    ModelErrorCode::SseMalformed,
                    "argument delta lacks a string delta",
                )
            })?;
            // The name travels on the added event; when the provider omits
            // it, the delta is still assemblable once an identity exists.
            // A delta for an unknown item is malformed (no guessing).
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            out.push(ModelEvent::ToolFragment {
                item_id: id.to_owned(),
                name,
                delta: delta.to_owned(),
            });
            Ok(false)
        }
        "response.completed" => {
            // A second completion in one stream is a protocol violation, not
            // a tie to break: fail closed rather than silently last-wins.
            if *completed_seen {
                return Err(ModelError::new(
                    ModelErrorCode::SseMalformed,
                    "duplicate provider completion in one stream (refusing to pick a winner)",
                ));
            }
            *completed_seen = true;
            let response = value.get("response");
            let status = response
                .and_then(|r| r.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            if status != "completed" {
                return Err(ModelError::new(
                    ModelErrorCode::ProviderFailed,
                    format!("provider reported terminal status {status}"),
                ));
            }
            let usage = response
                .and_then(|r| r.get("usage"))
                .map(|u| Usage {
                    input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                })
                .unwrap_or_default();
            out.push(ModelEvent::Usage(usage));
            let reason = response
                .and_then(|r| r.get("finish_reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("stop")
                .to_owned();
            *assembler_finish = Some(reason);
            Ok(true)
        }
        "response.failed" => {
            let code = value
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            Err(ModelError::new(
                ModelErrorCode::ProviderFailed,
                format!("provider reported failure {code}"),
            ))
        }
        // Forward-compatible: unknown well-formed types are ignored (they
        // still count toward the event bound at the transport layer).
        _ => Ok(false),
    }
}

/// Parse only the blank-line-terminated prefix of a body, dropping a
/// trailing partial frame. Used when the connection dropped mid-stream:
/// complete events are retained for inspection while the truncation itself
/// is reported separately (`truncated: true`). An empty prefix yields no
/// events (the original read error, not a parse error, classifies).
pub fn parse_sse_body_complete_prefix(
    body: &str,
    max_frames: usize,
) -> Result<Vec<ModelEvent>, ModelError> {
    let (events, _) = parse_sse_body_inner(body, max_frames, false)?;
    Ok(events)
}

/// Feed one raw SSE stream body (text) through the parser. `max_frames`
/// bounds the frame count before parsing. Returns normalized events plus
/// the optional finish reason. A body cut mid-frame is `sse-malformed`;
/// use `parse_sse_body_complete_prefix` to retain complete events from a
/// truncated stream.
pub fn parse_sse_body(
    body: &str,
    max_frames: usize,
) -> Result<(Vec<ModelEvent>, Option<String>), ModelError> {
    parse_sse_body_inner(body, max_frames, true)
}

fn parse_sse_body_inner(
    body: &str,
    max_frames: usize,
    strict_trailing: bool,
) -> Result<(Vec<ModelEvent>, Option<String>), ModelError> {
    let mut out = Vec::new();
    let mut finish: Option<String> = None;
    let mut completed_seen = false;
    let mut frames = 0;
    let mut current: Vec<String> = Vec::new();
    // Trailing unterminated data (no blank line, no [DONE]) means the
    // connection dropped mid-frame: malformed, never guessed complete.
    let mut terminated = true;
    for line in body.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if !current.is_empty() {
                frames += 1;
                if frames > max_frames {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "SSE frame count exceeds the bound",
                    ));
                }
                feed_frame(&current, &mut out, &mut finish, &mut completed_seen)?;
                current.clear();
            }
            terminated = true;
            continue;
        }
        terminated = false;
        if line.starts_with(':') {
            continue; // SSE comment / keepalive.
        }
        if let Some(payload) = line.strip_prefix("data:") {
            let payload = payload.strip_prefix(' ').unwrap_or(payload);
            current.push(payload.to_owned());
        } else if line.starts_with("event:")
            || line.starts_with("id:")
            || line.starts_with("retry:")
        {
            continue; // Named-event metadata we do not route on.
        } else {
            return Err(ModelError::new(
                ModelErrorCode::SseMalformed,
                "SSE line is neither data nor a comment",
            ));
        }
    }
    if !current.is_empty() {
        if !terminated && strict_trailing {
            return Err(ModelError::new(
                ModelErrorCode::SseMalformed,
                "SSE body ends mid-frame (truncated stream)",
            ));
        }
        if !terminated && !strict_trailing {
            // Drop the trailing partial frame: its bytes are incomplete
            // and must never be guessed at.
            return Ok((out, finish));
        }
        frames += 1;
        if frames > max_frames {
            return Err(ModelError::new(
                ModelErrorCode::PayloadTooLarge,
                "SSE frame count exceeds the bound",
            ));
        }
        feed_frame(&current, &mut out, &mut finish, &mut completed_seen)?;
    }
    Ok((out, finish))
}

fn feed_frame(
    current: &[String],
    out: &mut Vec<ModelEvent>,
    finish: &mut Option<String>,
    completed_seen: &mut bool,
) -> Result<(), ModelError> {
    if current.is_empty() {
        return Ok(());
    }
    if current.len() > 1 {
        // Multi-line data: only single-payload frames are supported; a
        // split JSON payload cannot be reassembled unambiguously.
        return Err(ModelError::new(
            ModelErrorCode::SseMalformed,
            "multi-line SSE data frame is not supported",
        ));
    }
    let _ = parse_data_payload(&current[0], out, finish, completed_seen)?;
    Ok(())
}

fn error_offset(e: &serde_json::Error) -> usize {
    // serde_json 1.x exposes the byte offset via column(); line is always 1
    // for single-frame payloads.
    e.column()
}
