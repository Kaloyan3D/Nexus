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
    /// Provider `call_id` (the identity a function-call OUTPUT must echo).
    /// Empty when the provider never supplied one.
    pub call_id: String,
    /// Tool name.
    pub name: String,
    /// Assembled arguments (parsed JSON).
    pub arguments: serde_json::Value,
}

/// One complete assistant `message` output item, as the provider labelled it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssembledMessage {
    /// Provider item id (sanitized token; may be empty).
    pub item_id: String,
    /// `commentary` (a preamble before tool calls) or `final_answer`; `None` when the
    /// provider sent no phase. Phase-aware models need it back verbatim on replay.
    pub phase: Option<String>,
    /// The item's output text.
    pub text: String,
}

/// Token usage reported by the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    /// Input tokens.
    pub input_tokens: u64,
    /// Output tokens.
    pub output_tokens: u64,
    /// Input tokens served from the provider's prompt cache, when the provider says so. A SUBSET of
    /// `input_tokens` (OpenAI-style definition); `None` when not reported (never 0 by assumption).
    pub cached_input_tokens: Option<u64>,
    /// Input tokens written to the cache (providers that bill cache writes), when reported.
    pub cache_write_tokens: Option<u64>,
    /// Reasoning tokens, when reported. A SUBSET of `output_tokens` for OpenAI-style providers.
    pub reasoning_tokens: Option<u64>,
    /// The provider's own total, when reported.
    pub total_tokens: Option<u64>,
    /// Provider-reported cost of the request in micro-USD, when the provider reports one (never estimated).
    pub cost_micro_usd: Option<u64>,
    /// Provider-reported list-price equivalent of the request in nano-USD (OpenCode Go reports `opencode.list_cost`
    /// next to a plan-billed `cost` of 0). A reported figure, not an estimate.
    pub list_cost_nano_usd: Option<u64>,
}

/// Read the provider's `usage` object. Absent fields stay `None`; the raw object is returned too (only numeric leaves,
/// bounded) so nothing the provider reported is lost and nothing else (text, headers, ids) is kept.
pub fn parse_usage(u: &serde_json::Value) -> (Usage, String) {
    let n = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_u64());
    let nested = |a: &str, b: &str| n(u.get(a).and_then(|d| d.get(b)));
    let input = n(u.get("input_tokens")).or_else(|| n(u.get("prompt_tokens")));
    let output = n(u.get("output_tokens")).or_else(|| n(u.get("completion_tokens")));
    let cached = nested("input_tokens_details", "cached_tokens")
        .or_else(|| nested("prompt_tokens_details", "cached_tokens"))
        .or_else(|| n(u.get("cache_read_input_tokens")))
        .or_else(|| n(u.get("prompt_cache_hit_tokens")));
    let cache_write = n(u.get("cache_creation_input_tokens"))
        .or_else(|| nested("input_tokens_details", "cache_creation_tokens"))
        .or_else(|| nested("prompt_tokens_details", "cache_write_tokens"));
    let reasoning = nested("output_tokens_details", "reasoning_tokens")
        .or_else(|| nested("completion_tokens_details", "reasoning_tokens"));
    // OpenCode Go: explicit cache-write counters and the list-price cost, under `opencode`
    let oc = u.get("opencode");
    let oc_tokens = oc.and_then(|o| o.get("tokens"));
    let w5 = n(oc_tokens.and_then(|t| t.get("cache_write_5m")));
    let w1 = n(oc_tokens.and_then(|t| t.get("cache_write_1h")));
    let cache_write = cache_write.or_else(|| match (w5, w1) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    });
    let list_cost = oc
        .and_then(|o| o.get("list_cost"))
        .and_then(|c| c.as_f64())
        .filter(|c| c.is_finite() && *c >= 0.0)
        .map(|c| (c * 1_000_000_000.0).round() as u64);
    let cost = u
        .get("cost")
        .and_then(|c| c.as_f64())
        .filter(|c| c.is_finite() && *c >= 0.0)
        .map(|c| (c * 1_000_000.0).round() as u64);
    let usage = Usage {
        input_tokens: input.unwrap_or(0),
        output_tokens: output.unwrap_or(0),
        cached_input_tokens: cached,
        cache_write_tokens: cache_write,
        reasoning_tokens: reasoning,
        total_tokens: n(u.get("total_tokens")),
        cost_micro_usd: cost,
        list_cost_nano_usd: list_cost,
    };
    (usage, numeric_leaves(u))
}

/// Canonical JSON of an object reduced to its numeric leaves (depth <= 3, <= 32 keys).
fn numeric_leaves(v: &serde_json::Value) -> String {
    fn walk(v: &serde_json::Value, depth: u8, left: &mut usize) -> Option<serde_json::Value> {
        match v {
            serde_json::Value::Number(_) if *left > 0 => {
                *left -= 1;
                Some(v.clone())
            }
            serde_json::Value::Object(m) if depth < 3 => {
                let mut o = serde_json::Map::new();
                for (k, x) in m {
                    if *left == 0 {
                        break;
                    }
                    if let Some(y) = walk(x, depth + 1, left) {
                        o.insert(k.chars().take(48).collect(), y);
                    }
                }
                (!o.is_empty()).then_some(serde_json::Value::Object(o))
            }
            _ => None,
        }
    }
    let mut left = 32usize;
    walk(v, 0, &mut left)
        .map(|x| x.to_string())
        .unwrap_or_else(|| "{}".to_owned())
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
    /// The assistant `message` items with their phase, in wire order (empty when the
    /// provider never completed an item; `text` above is always the full text).
    pub messages: Vec<AssembledMessage>,
    /// The response's `reasoning` items (canonical JSON, see [`ModelEvent::ReasoningDone`]),
    /// in wire order, for verbatim replay on the next request of the same run.
    pub reasoning_items: Vec<String>,
    /// Provider-reported usage.
    pub usage: Usage,
    /// Provider response id, when the provider supplied one.
    pub response_id: Option<String>,
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
        /// Provider `call_id` when known on this event (empty otherwise).
        call_id: String,
        /// Tool name (first seen wins; drift is `sse-malformed`).
        name: String,
        /// Argument bytes fragment.
        delta: String,
    },
    /// The provider's COMPLETE arguments for one function call
    /// (`function_call_arguments.done` / `output_item.done`). Authoritative
    /// when present; it must agree with any assembled deltas.
    ToolDone {
        item_id: String,
        call_id: String,
        name: String,
        arguments: String,
    },
    /// Provider usage snapshot (only when the provider actually reported it).
    Usage(Usage),
    /// Provider response identifier (`response.id`), as supplied. Never
    /// synthesized.
    ResponseId(String),
    /// The raw numeric `usage` fields the provider reported (canonical JSON, numeric leaves only).
    UsageRaw(String),
    /// The model identifier the provider says served the response (`response.model`), as supplied.
    ResponseModel(String),
    /// A complete `reasoning` item (`output_item.done`), reduced to the fields a later
    /// request may echo (`type`, `id`, `encrypted_content`, `summary`) as canonical JSON.
    ReasoningDone { item: String },
    /// A complete assistant `message` item (`output_item.done`) with its phase.
    MessageDone {
        item_id: String,
        phase: Option<String>,
        text: String,
    },
}

struct ToolAssembly {
    name: String,
    call_id: String,
    args: String,
    done: Option<String>,
}

/// Incremental stream assembler. Feed `ModelEvent`s in wire order; `finish`
/// assembles the terminal response or reports the partial failure.
pub struct StreamAssembler {
    attempt_id: String,
    request_digest: String,
    text: String,
    reasoning: String,
    tools: BTreeMap<String, ToolAssembly>,
    messages: Vec<AssembledMessage>,
    message_bytes: usize,
    reasoning_items: Vec<String>,
    usage: Usage,
    response_id: Option<String>,
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
            messages: Vec::new(),
            message_bytes: 0,
            reasoning_items: Vec::new(),
            usage: Usage::default(),
            response_id: None,
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
                call_id,
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
                    call_id: String::new(),
                    args: String::new(),
                    done: None,
                });
                if !name.trim().is_empty() && entry.name != name {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool fragment name drifted within one item",
                    ));
                }
                Self::bind_call_id(entry, &call_id)?;
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
            ModelEvent::ToolDone {
                item_id,
                call_id,
                name,
                arguments,
            } => {
                if item_id.trim().is_empty() {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool completion lacks item identity",
                    ));
                }
                if name.trim().is_empty() && !self.tools.contains_key(&item_id) {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool completion for an unregistered item",
                    ));
                }
                self.arg_bytes += arguments.len();
                if self.arg_bytes > self.max_arg_bytes {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "assembled tool arguments exceed the argument bound",
                    ));
                }
                let entry = self.tools.entry(item_id).or_insert(ToolAssembly {
                    name: name.clone(),
                    call_id: String::new(),
                    args: String::new(),
                    done: None,
                });
                if !name.trim().is_empty() && entry.name != name {
                    return Err(ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "tool completion name drifted within one item",
                    ));
                }
                Self::bind_call_id(entry, &call_id)?;
                match &entry.done {
                    // An EMPTY completion carries no arguments: it neither conflicts with nor
                    // replaces a complete one (seen live on OpenCode Go: `arguments.done` with the
                    // arguments, then `output_item.done` with `"arguments": ""`; DSH's adapter
                    // falls back to the streamed arguments the same way). Alone it still fails
                    // as invalid JSON in `finish`.
                    Some(_) if arguments.is_empty() => {}
                    Some(prev) if prev.is_empty() => entry.done = Some(arguments),
                    // The same item may be completed twice (arguments.done and
                    // output_item.done); non-empty completions must agree.
                    Some(prev) if *prev != arguments => {
                        return Err(ModelError::new(
                            ModelErrorCode::SseMalformed,
                            "conflicting complete arguments for one tool call",
                        ))
                    }
                    _ => entry.done = Some(arguments),
                }
                Ok(())
            }
            ModelEvent::Usage(u) => {
                self.usage = u;
                Ok(())
            }
            ModelEvent::ResponseId(id) => {
                self.response_id = Some(id);
                Ok(())
            }
            // read by the turn runner straight from the event stream (analytics); not part of the committed response
            ModelEvent::UsageRaw(_) | ModelEvent::ResponseModel(_) => Ok(()),
            ModelEvent::ReasoningDone { item } => {
                self.message_bytes += item.len();
                if self.message_bytes > self.max_text_bytes {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "completed reasoning items exceed the text bound",
                    ));
                }
                // a provider repeating the same completed item must not duplicate the replay
                if !self.reasoning_items.contains(&item) {
                    self.reasoning_items.push(item);
                }
                Ok(())
            }
            ModelEvent::MessageDone {
                item_id,
                phase,
                text,
            } => {
                // the same text already arrived as deltas: bounded separately so a provider
                // cannot double the assembled output through completed items
                self.message_bytes += text.len();
                if self.message_bytes > self.max_text_bytes {
                    return Err(ModelError::new(
                        ModelErrorCode::PayloadTooLarge,
                        "completed assistant messages exceed the text bound",
                    ));
                }
                // a provider repeating the same completed item must not duplicate the replay
                if item_id.is_empty() || !self.messages.iter().any(|m| m.item_id == item_id) {
                    self.messages.push(AssembledMessage {
                        item_id,
                        phase,
                        text,
                    });
                }
                Ok(())
            }
        }
    }

    fn bind_call_id(entry: &mut ToolAssembly, call_id: &str) -> Result<(), ModelError> {
        if call_id.is_empty() {
            return Ok(());
        }
        if entry.call_id.is_empty() {
            entry.call_id = call_id.to_owned();
            return Ok(());
        }
        if entry.call_id != call_id {
            return Err(ModelError::new(
                ModelErrorCode::SseMalformed,
                "tool call_id drifted within one item",
            ));
        }
        Ok(())
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
            // Complete provider arguments, when sent, are authoritative; but
            // they must agree with whatever deltas were assembled.
            // An empty completion carries no arguments (see `ToolDone`): the deltas decide.
            let text = match asm.done.as_ref().filter(|d| !d.is_empty()) {
                Some(d) => {
                    if !asm.args.is_empty() && asm.args != *d {
                        return Err(ModelError::new(
                            ModelErrorCode::SseMalformed,
                            "assembled argument deltas disagree with the complete arguments",
                        ));
                    }
                    d.as_str()
                }
                None => asm.args.as_str(),
            };
            let arguments: serde_json::Value = serde_json::from_str(text).map_err(|_| {
                ModelError::new(
                    ModelErrorCode::StreamPartial,
                    "tool call arguments are incomplete or invalid JSON (item retained unexecuted)",
                )
            })?;
            calls.push(AssembledToolCall {
                item_id,
                call_id: asm.call_id,
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
            messages: self.messages,
            reasoning_items: self.reasoning_items,
            usage: self.usage,
            response_id: self.response_id,
            finish_reason: reason,
        })
    }
}

/// Keep only a short, token-like identifier from provider-supplied text so a
/// hostile or verbose provider cannot smuggle prose or secrets into our
/// records.
fn safe_token(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
        .take(64)
        .collect::<String>()
}

fn push_response_id(id: &str, out: &mut Vec<ModelEvent>) {
    let t = safe_token(id);
    if !t.is_empty() && out.last() != Some(&ModelEvent::ResponseId(t.clone())) {
        out.push(ModelEvent::ResponseId(t));
    }
}

fn call_id_of(item: &serde_json::Value) -> String {
    item.get("call_id")
        .and_then(|v| v.as_str())
        .map(safe_token)
        .unwrap_or_default()
}

/// Emit a [`ModelEvent::ToolDone`] for a complete `function_call` item
/// (anything else is ignored).
fn push_function_call_done(
    item: &serde_json::Value,
    out: &mut Vec<ModelEvent>,
) -> Result<(), ModelError> {
    if item.get("type").and_then(|v| v.as_str()) != Some("function_call") {
        return Ok(());
    }
    let id = item.get("id").and_then(|v| v.as_str()).ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::SseMalformed,
            "completed function_call lacks an item id",
        )
    })?;
    let name = item.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
        ModelError::new(
            ModelErrorCode::SseMalformed,
            "completed function_call lacks a tool name",
        )
    })?;
    let arguments = item
        .get("arguments")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ModelError::new(
                ModelErrorCode::SseMalformed,
                "completed function_call lacks string arguments",
            )
        })?;
    out.push(ModelEvent::ToolDone {
        item_id: id.to_owned(),
        call_id: call_id_of(item),
        name: name.to_owned(),
        arguments: arguments.to_owned(),
    });
    Ok(())
}

/// Largest `encrypted_content` accepted for replay.
pub const MAX_REASONING_ITEM_BYTES: usize = 128 * 1024;

/// A `reasoning` output item reduced to what may be echoed back, as canonical JSON:
/// `type`, an id of at most 128 token characters, the opaque `encrypted_content`
/// (base64 alphabet only) and the `summary` parts (`summary_text` strings). Anything
/// else, or an item without encrypted content, is not replayable (`None`).
pub fn replayable_reasoning(item: &serde_json::Value) -> Option<String> {
    if item.get("type").and_then(|v| v.as_str()) != Some("reasoning") {
        return None;
    }
    let id = item.get("id").and_then(|v| v.as_str())?;
    let id_ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'));
    let enc = item.get("encrypted_content").and_then(|v| v.as_str())?;
    let enc_ok = !enc.is_empty()
        && enc.len() <= MAX_REASONING_ITEM_BYTES
        && enc
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+' | b'/' | b'='));
    if !id_ok || !enc_ok {
        return None;
    }
    let summary: Vec<serde_json::Value> = item
        .get("summary")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    let text = p.get("text").and_then(|t| t.as_str())?;
                    (p.get("type").and_then(|t| t.as_str()) == Some("summary_text")
                        && text.len() <= 16 * 1024)
                        .then(|| serde_json::json!({"type": "summary_text", "text": text}))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(nexus_contracts::canonical_json(&serde_json::json!({
        "type": "reasoning", "id": id, "encrypted_content": enc, "summary": summary,
    })))
}

/// Emit a [`ModelEvent::MessageDone`] for a complete assistant `message` item. Only the
/// two documented phases are kept; any other value is dropped (never echoed back).
fn push_message_done(item: &serde_json::Value, out: &mut Vec<ModelEvent>) {
    if item.get("type").and_then(|v| v.as_str()) != Some("message") {
        return;
    }
    let text: String = item
        .get("content")
        .and_then(|c| c.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("output_text"))
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let phase = item
        .get("phase")
        .and_then(|v| v.as_str())
        .filter(|p| matches!(*p, "commentary" | "final_answer"))
        .map(str::to_owned);
    out.push(ModelEvent::MessageDone {
        item_id: item
            .get("id")
            .and_then(|v| v.as_str())
            .map(safe_token)
            .unwrap_or_default(),
        phase,
        text,
    });
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
                    call_id: call_id_of(item),
                    name: name.to_owned(),
                    delta: String::new(),
                });
            }
            Ok(false)
        }
        // A finished output item. For a function call this carries the
        // COMPLETE arguments and the call_id.
        "response.output_item.done" => {
            if let Some(item) = value.get("item") {
                push_function_call_done(item, out)?;
                push_message_done(item, out);
                if let Some(r) = replayable_reasoning(item) {
                    out.push(ModelEvent::ReasoningDone { item: r });
                }
            }
            Ok(false)
        }
        "response.function_call_arguments.done" => {
            let id = value
                .get("item_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "arguments.done lacks an item_id",
                    )
                })?;
            let arguments = value
                .get("arguments")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ModelError::new(
                        ModelErrorCode::SseMalformed,
                        "arguments.done lacks string arguments",
                    )
                })?;
            out.push(ModelEvent::ToolDone {
                item_id: id.to_owned(),
                call_id: String::new(),
                name: value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                arguments: arguments.to_owned(),
            });
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
                call_id: String::new(),
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
            // Usage is recorded ONLY when the provider reported it: absent
            // usage stays absent (never a fabricated 0/0).
            if let Some(u) = response
                .and_then(|r| r.get("usage"))
                .filter(|u| u.is_object())
            {
                let (usage, raw) = parse_usage(u);
                out.push(ModelEvent::Usage(usage));
                out.push(ModelEvent::UsageRaw(raw));
            }
            if let Some(id) = response.and_then(|r| r.get("id")).and_then(|v| v.as_str()) {
                push_response_id(id, out);
            }
            if let Some(m) = response
                .and_then(|r| r.get("model"))
                .and_then(|v| v.as_str())
            {
                let m: String = m
                    .chars()
                    .filter(|c| c.is_ascii_graphic())
                    .take(96)
                    .collect();
                if !m.is_empty() {
                    out.push(ModelEvent::ResponseModel(m));
                }
            }
            // Function calls listed in the final response object are complete.
            if let Some(items) = response
                .and_then(|r| r.get("output"))
                .and_then(|o| o.as_array())
            {
                for item in items {
                    push_function_call_done(item, out)?;
                }
            }
            let reason = response
                .and_then(|r| r.get("finish_reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("stop")
                .to_owned();
            *assembler_finish = Some(reason);
            Ok(true)
        }
        "response.created" | "response.in_progress" => {
            if let Some(id) = value
                .get("response")
                .and_then(|r| r.get("id"))
                .and_then(|v| v.as_str())
            {
                push_response_id(id, out);
            }
            Ok(false)
        }
        // The provider ended the response early but deliberately (for
        // example the output-token limit). That is a definitive provider
        // terminal, reported with its own reason - never as a plain stop.
        "response.incomplete" => {
            if *completed_seen {
                return Err(ModelError::new(
                    ModelErrorCode::SseMalformed,
                    "duplicate provider completion in one stream (refusing to pick a winner)",
                ));
            }
            *completed_seen = true;
            let response = value.get("response");
            if let Some(u) = response
                .and_then(|r| r.get("usage"))
                .filter(|u| u.is_object())
            {
                let (usage, raw) = parse_usage(u);
                out.push(ModelEvent::Usage(usage));
                out.push(ModelEvent::UsageRaw(raw));
            }
            if let Some(id) = response.and_then(|r| r.get("id")).and_then(|v| v.as_str()) {
                push_response_id(id, out);
            }
            if let Some(m) = response
                .and_then(|r| r.get("model"))
                .and_then(|v| v.as_str())
            {
                let m: String = m
                    .chars()
                    .filter(|c| c.is_ascii_graphic())
                    .take(96)
                    .collect();
                if !m.is_empty() {
                    out.push(ModelEvent::ResponseModel(m));
                }
            }
            let why = response
                .and_then(|r| r.get("incomplete_details"))
                .and_then(|d| d.get("reason"))
                .and_then(|v| v.as_str())
                .map(safe_token)
                .unwrap_or_else(|| "unspecified".to_owned());
            *assembler_finish = Some(format!("incomplete:{why}"));
            Ok(true)
        }
        // Top-level stream error event (`{"type":"error", ...}`).
        "error" => {
            let code = value
                .get("code")
                .or_else(|| value.get("error").and_then(|e| e.get("code")))
                .and_then(|v| v.as_str())
                .map(safe_token)
                .unwrap_or_else(|| "unknown".to_owned());
            Err(ModelError::new(
                ModelErrorCode::ProviderFailed,
                format!("provider reported stream error {code}"),
            ))
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
            // Shape only (never content): a short field-name-like prefix and
            // the line length, so a protocol mismatch is diagnosable.
            let shape: String = line
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                .take(16)
                .collect();
            return Err(ModelError::new(
                ModelErrorCode::SseMalformed,
                format!(
                    "SSE line is neither data nor a comment (prefix '{shape}', {} bytes)",
                    line.len()
                ),
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

#[cfg(test)]
mod usage_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_responses_api_shape_keeps_cached_reasoning_and_the_raw_numbers() {
        let (u, raw) = parse_usage(&json!({
            "input_tokens": 1200, "output_tokens": 300, "total_tokens": 1500,
            "input_tokens_details": {"cached_tokens": 1000},
            "output_tokens_details": {"reasoning_tokens": 120}
        }));
        assert_eq!((u.input_tokens, u.output_tokens), (1200, 300));
        assert_eq!(u.cached_input_tokens, Some(1000));
        assert_eq!(u.reasoning_tokens, Some(120));
        assert_eq!(u.total_tokens, Some(1500));
        assert_eq!(u.cache_write_tokens, None, "not reported: absent, not zero");
        let r: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(r["input_tokens_details"]["cached_tokens"], 1000);
    }

    #[test]
    fn other_providers_shapes_are_normalized_without_assuming_the_same_definitions() {
        let (chat, _) = parse_usage(&json!({"prompt_tokens": 50, "completion_tokens": 9,
            "prompt_tokens_details": {"cached_tokens": 40}, "completion_tokens_details": {"reasoning_tokens": 3}}));
        assert_eq!(
            (
                chat.input_tokens,
                chat.output_tokens,
                chat.cached_input_tokens,
                chat.reasoning_tokens
            ),
            (50, 9, Some(40), Some(3))
        );
        let (anthropic, _) = parse_usage(&json!({"input_tokens": 10, "output_tokens": 5,
            "cache_read_input_tokens": 700, "cache_creation_input_tokens": 200}));
        assert_eq!(anthropic.cached_input_tokens, Some(700));
        assert_eq!(anthropic.cache_write_tokens, Some(200));
    }

    #[test]
    fn the_opencode_shape_keeps_cache_writes_the_plan_billed_cost_and_the_list_price() {
        let (u, raw) = parse_usage(
            &json!({"cost": 0, "input_tokens": 4666, "output_tokens": 92, "total_tokens": 4758,
            "input_tokens_details": {"cached_tokens": 3953}, "output_tokens_details": {"reasoning_tokens": 3},
            "opencode": {"allowance": 9.761e-05, "list_cost": 9.761e-05,
                "tokens": {"cache_read": 3953, "cache_write_1h": 0, "cache_write_5m": 0, "input": 713, "output": 92, "reasoning": 3}}}),
        );
        assert_eq!(
            u.cost_micro_usd,
            Some(0),
            "plan-billed: the provider's own cost is 0"
        );
        assert_eq!(u.list_cost_nano_usd, Some(97_610));
        assert_eq!(
            u.cache_write_tokens,
            Some(0),
            "reported as zero, not unknown"
        );
        assert_eq!(u.cached_input_tokens, Some(3953));
        let r: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            r["opencode"]["tokens"]["cache_write_5m"], 0,
            "the raw fields are kept verbatim"
        );
        // when the provider sends no opencode block nothing is invented
        let (plain, _) = parse_usage(&json!({"input_tokens": 1, "output_tokens": 1}));
        assert_eq!(
            (plain.cache_write_tokens, plain.list_cost_nano_usd),
            (None, None)
        );
    }

    #[test]
    fn missing_and_partial_usage_stays_missing() {
        let (u, raw) = parse_usage(&json!({"input_tokens": 7}));
        assert_eq!((u.input_tokens, u.output_tokens), (7, 0));
        assert_eq!(
            (
                u.cached_input_tokens,
                u.reasoning_tokens,
                u.total_tokens,
                u.cost_micro_usd
            ),
            (None, None, None, None)
        );
        assert_eq!(raw, r#"{"input_tokens":7}"#);
        let (empty, raw) = parse_usage(&json!({}));
        assert_eq!(empty, Usage::default());
        assert_eq!(raw, "{}");
    }

    #[test]
    fn the_provider_reported_cost_is_kept_in_micro_dollars_and_only_when_reported() {
        let (u, _) = parse_usage(&json!({"input_tokens": 1, "output_tokens": 1, "cost": 0.012345}));
        assert_eq!(u.cost_micro_usd, Some(12345));
        let (n, _) = parse_usage(&json!({"input_tokens": 1, "cost": -1.0}));
        assert_eq!(n.cost_micro_usd, None);
    }

    #[test]
    fn the_raw_record_holds_numbers_only_never_text_or_credentials() {
        let (_, raw) = parse_usage(&json!({
            "input_tokens": 3, "authorization": "Bearer sk-SECRET-TOKEN", "model": "x",
            "nested": {"api_key": "sk-ANOTHER", "n": 5, "deep": {"deeper": {"deepest": 1}}}
        }));
        assert!(
            !raw.contains("sk-")
                && !raw.contains("Bearer")
                && !raw.contains("authorization")
                && !raw.contains("api_key"),
            "{raw}"
        );
        assert!(raw.contains("\"input_tokens\":3") && raw.contains("\"n\":5"));
        assert!(!raw.contains("deepest"), "depth is bounded");
    }
}
