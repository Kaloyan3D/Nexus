//! Read-only historical adapter over DSH session logs.
//!
//! Join rules (all required, never display ids or timestamps alone):
//! 1. The Controller attempt journal (`runs/<TASK>/attempts.jsonl`) names the
//!    task instance id, attempt id and session id, and the run directory name
//!    equals the record's display task id.
//! 2. The session log header id equals that session id and its `cwd` equals
//!    the attempt's workspace.
//! 3. The session contains a Controller binding message that names the same
//!    task instance id, and no binding message names a different instance.
//!
//! A session failing any rule yields no events; the reason is reported.

use crate::contract::*;
use crate::redact::redact_text;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const TEXT_CAP: usize = 32_000;
pub const TOOL_INPUT_CAP: usize = 16_000;
const LABEL_CAP: usize = 80;
const MAX_ROWS: usize = 2_000_000;
const MAX_ATTEMPT_FILE: u64 = 4 * 1024 * 1024;

/// Hard resource limits for untrusted on-disk input.
#[derive(Debug, Clone, Copy)]
pub struct DshLimits {
    /// Largest compressed session file that will be read at all.
    pub max_compressed: u64,
    /// Output cap across all frames (zstd-bomb defense).
    pub max_decompressed: u64,
    /// Longer JSONL lines are skipped and counted as invalid.
    pub max_line: usize,
}

impl Default for DshLimits {
    fn default() -> Self {
        Self {
            max_compressed: 64 * 1024 * 1024,
            max_decompressed: 256 * 1024 * 1024,
            max_line: 8 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DshSources {
    /// `<workspace>/.ai-harness/runs`
    pub runs_dir: PathBuf,
    /// `~/.local/share/nexus/data/sessions` (contains one dir per workspace)
    pub sessions_root: PathBuf,
    pub limits: DshLimits,
}

impl DshSources {
    pub fn new(runs_dir: impl Into<PathBuf>, sessions_root: impl Into<PathBuf>) -> Self {
        Self {
            runs_dir: runs_dir.into(),
            sessions_root: sessions_root.into(),
            limits: DshLimits::default(),
        }
    }
}

/// Regular file or directory only: symlinks are never followed.
fn is_plain(path: &Path, want_dir: bool) -> bool {
    match fs::symlink_metadata(path) {
        Ok(m) => !m.file_type().is_symlink() && if want_dir { m.is_dir() } else { m.is_file() },
        Err(_) => false,
    }
}

/// Recorded identifiers and labels are untrusted: clip and redact.
fn label(v: Option<String>) -> Option<String> {
    v.map(|t| {
        let clipped: String = t.chars().take(LABEL_CAP).collect();
        crate::redact::redact_text(&clipped).0
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HistoryError {
    #[error("no attempt records exist for this task instance")]
    NoAttempts,
    #[error("io: {0}")]
    Io(String),
}

#[derive(Debug, Clone)]
pub struct History {
    pub display_task_id: String,
    pub attempts: Vec<AttemptProvenance>,
    pub events: Vec<TranscriptEventV1>,
    pub model_requests: Vec<ModelRequestRecord>,
    pub coverage: Coverage,
}

fn valid_session_id(s: &str) -> bool {
    s.len() == 44
        && s.starts_with("session-")
        && s[8..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn valid_display_id(s: &str) -> bool {
    s.len() > 5 && s.starts_with("TASK-") && s[5..].bytes().all(|b| b.is_ascii_digit())
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(str::to_owned)
}

fn clip(text: &str, cap: usize) -> (String, bool, u64) {
    let len = text.chars().count() as u64;
    if text.chars().count() <= cap {
        (text.to_owned(), false, len)
    } else {
        (text.chars().take(cap).collect(), true, len)
    }
}

fn texts_of(content: &Value) -> String {
    let mut out = Vec::new();
    if let Some(arr) = content.as_array() {
        for b in arr {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    out.push(t.to_owned());
                }
            } else if let Some(inner) = b.get("content") {
                let t = texts_of(inner);
                if !t.is_empty() {
                    out.push(t);
                }
            }
        }
    } else if let Some(t) = content.as_str() {
        out.push(t.to_owned());
    }
    out.join("\n")
}

/// Session logs are appended as consecutive zstd frames; decode them all.
/// Output is bounded; a truncated or corrupt tail keeps the bytes decoded so
/// far and reports a note instead of discarding the whole log.
fn decompress(path: &Path, lim: &DshLimits) -> Result<(String, Option<String>), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > lim.max_compressed {
        return Err(format!(
            "compressed log exceeds {} bytes",
            lim.max_compressed
        ));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut src: &[u8] = &bytes;
    let mut buf: Vec<u8> = Vec::new();
    let mut frames = 0u32;
    let mut note = None;
    while !src.is_empty() {
        let room = lim.max_decompressed.saturating_sub(buf.len() as u64);
        if room == 0 {
            note = Some(format!(
                "decompression stopped at the {} byte limit; the log is incomplete",
                lim.max_decompressed
            ));
            break;
        }
        let mut dec = match ruzstd::decoding::StreamingDecoder::new(&mut src) {
            Ok(d) => d,
            Err(e) => {
                note = Some(format!("log tail is not a valid zstd frame ({e})"));
                break;
            }
        };
        if let Err(e) = (&mut dec).take(room).read_to_end(&mut buf) {
            note = Some(format!(
                "log truncated or corrupt after {frames} frames ({e})"
            ));
            break;
        }
        frames += 1;
        if frames > 100_000 {
            note = Some("frame count limit reached".into());
            break;
        }
    }
    if frames == 0 && buf.is_empty() {
        return Err(note.unwrap_or_else(|| "empty or undecodable log".into()));
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), note))
}

fn find_session_file(root: &Path, session_id: &str) -> Option<PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    for ws in fs::read_dir(root).ok()?.flatten() {
        let ws_path = ws.path();
        if !is_plain(&ws_path, true) {
            continue;
        }
        let dir = ws_path.join(session_id);
        if !is_plain(&dir, true) {
            continue;
        }
        let file = dir.join("session.jsonl.zstd");
        if is_plain(&file, false) {
            return Some(file);
        }
    }
    None
}

struct Attempt {
    prov: AttemptProvenance,
    workspace: Option<String>,
}

fn load_attempts(
    runs_dir: &Path,
    task_instance_id: &str,
    cov: &mut Coverage,
) -> Result<(String, Vec<Attempt>), HistoryError> {
    let mut display: Option<String> = None;
    let mut out: Vec<Attempt> = Vec::new();
    let entries = fs::read_dir(runs_dir).map_err(|e| HistoryError::Io(e.to_string()))?;
    for dir in entries.flatten() {
        let name = dir.file_name().to_string_lossy().into_owned();
        if !valid_display_id(&name) || !is_plain(&dir.path(), true) {
            continue;
        }
        let file = dir.path().join("attempts.jsonl");
        let small = fs::symlink_metadata(&file)
            .map(|m| m.len() <= MAX_ATTEMPT_FILE)
            .unwrap_or(false);
        if !is_plain(&file, false) || !small {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file) else {
            continue;
        };
        for line in raw.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                cov.records_invalid += 1;
                continue;
            };
            if s(&v, "taskInstanceId").as_deref() != Some(task_instance_id) {
                continue;
            }
            if s(&v, "taskId").as_deref() != Some(name.as_str()) {
                cov.records_invalid += 1;
                continue;
            }
            display = Some(name.clone());
            if s(&v, "status").as_deref() == Some("started") {
                let Some(attempt_id) = s(&v, "attemptId") else {
                    cov.records_invalid += 1;
                    continue;
                };
                if out.iter().any(|a| a.prov.attempt_id == attempt_id) {
                    continue;
                }
                out.push(Attempt {
                    workspace: s(&v, "workspace"),
                    prov: AttemptProvenance {
                        attempt_id: label(Some(attempt_id)).unwrap_or_default(),
                        sequence: v.get("sequence").and_then(|x| x.as_u64()).unwrap_or(0),
                        execution_class: label(s(&v, "executionClass")),
                        session_id: s(&v, "sessionId").filter(|x| valid_session_id(x)),
                        started_by_turn: s(&v, "startedByTurn").and_then(|t| t.parse().ok()),
                        started_at_utc: label(s(&v, "startedAtUtc")),
                        binding: "unverified: session not inspected".to_owned(),
                    },
                });
            }
        }
    }
    let display = display.ok_or(HistoryError::NoAttempts)?;
    out.sort_by_key(|a| a.prov.sequence);
    if out.is_empty() {
        return Err(HistoryError::NoAttempts);
    }
    Ok((display, out))
}

/// Verify the in-record binding. Returns Ok(()) or the refusal reason.
fn verify_binding(
    rows: &[Value],
    session_id: &str,
    workspace: Option<&str>,
    task_instance_id: &str,
) -> Result<(), String> {
    let header = rows.first().ok_or("empty session log")?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return Err("first record is not a session header".into());
    }
    if s(header, "id").as_deref() != Some(session_id) {
        return Err("session header id does not match the attempt journal".into());
    }
    if let (Some(ws), Some(cwd)) = (workspace, s(header, "cwd")) {
        if ws != cwd {
            return Err("session cwd does not match the attempt workspace".into());
        }
    }
    let mut bound = false;
    for r in rows {
        if r.get("type").and_then(|t| t.as_str()) != Some("user/message") {
            continue;
        }
        let d = &r["data"];
        if d["source"]["plugin"].as_str() == Some("aih-controller")
            && d["source"]["form"].as_str() == Some("controller-binding")
        {
            let text = texts_of(&d["content"]);
            let named: Vec<&str> = text
                .lines()
                .filter_map(|l| l.strip_prefix("Task instance: "))
                .map(str::trim)
                .collect();
            if named.is_empty() {
                continue;
            }
            if named.iter().any(|n| *n != task_instance_id) {
                return Err("session is bound to a different task instance".into());
            }
            bound = true;
        }
    }
    if bound {
        Ok(())
    } else {
        Err("session has no Controller binding message for this task instance".into())
    }
}

struct Builder<'a> {
    task: &'a str,
    display: &'a str,
    session_id: &'a str,
    cov: &'a mut Coverage,
}

impl Builder<'_> {
    fn event(
        &self,
        id: String,
        kind: EventKind,
        speaker: Speaker,
        class: InputClass,
        time: Option<u64>,
        turn: Option<u64>,
    ) -> TranscriptEventV1 {
        let mut e =
            TranscriptEventV1::new(id, self.task, kind, speaker, class, Source::DshSessionLog);
        e.display_task_id = Some(self.display.to_owned());
        e.session_id = Some(self.session_id.to_owned());
        e.timestamp_ms = time;
        e.turn = turn;
        e
    }

    fn set_text(&mut self, e: &mut TranscriptEventV1, raw: &str, cap: usize) {
        let (clipped, truncated, len) = clip(raw, cap);
        let (red, n) = redact_text(&clipped);
        e.text = Some(red);
        e.truncated = truncated;
        e.original_len = Some(len);
        e.redactions += n;
        self.cov.redactions += u64::from(n);
        if truncated {
            self.cov.truncated_fields += 1;
        }
    }
}

struct StepAcc {
    text: String,
    time: Option<u64>,
    finish_error: bool,
}

fn process_session(
    rows: &[Value],
    session_id: &str,
    task: &str,
    display: &str,
    cov: &mut Coverage,
    requests: &mut Vec<ModelRequestRecord>,
) -> Vec<TranscriptEventV1> {
    let mut b = Builder {
        task,
        display,
        session_id,
        cov,
    };
    let mut events: Vec<TranscriptEventV1> = Vec::new();
    let mut turn: Option<u64> = None;
    let mut agent: Option<String> = None;
    let mut last_model: Option<(Option<String>, Option<String>)> = None;
    let mut finals: HashSet<(u64, u64)> = HashSet::new();
    let mut acc: HashMap<(u64, u64), StepAcc> = HashMap::new();
    let mut call_args: HashMap<String, String> = HashMap::new();
    let mut last_request_idx: Option<usize> = None;

    for r in rows.iter().skip(1) {
        b.cov.records_scanned += 1;
        let ty = r.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let d = &r["data"];
        let seq = r
            .get("seq")
            .and_then(|x| x.as_u64())
            .or_else(|| r.get("seq0").and_then(|x| x.as_u64()));
        let time = r
            .get("time")
            .and_then(|x| x.as_u64())
            .or_else(|| r.get("time0").and_then(|x| x.as_u64()));
        let Some(seq) = seq else {
            b.cov.records_invalid += 1;
            continue;
        };
        let step_key = |d: &Value| -> Option<(u64, u64)> {
            Some((d.get("turn")?.as_u64()?, d.get("step")?.as_u64()?))
        };
        match ty {
            "turn/start" => turn = d.get("turn").and_then(|t| t.as_u64()),
            "agent-preset/selected" => agent = s(d, "agentPreset"),
            "user/message" => {
                let text = texts_of(&d["content"]);
                let src = &d["source"];
                let kind = src["kind"].as_str().unwrap_or("");
                let (ek, sp, class) = if kind == "user" {
                    (
                        EventKind::UserMessage,
                        Speaker::User,
                        InputClass::UserAuthored,
                    )
                } else if src["plugin"].as_str() == Some("aih-controller") {
                    (
                        EventKind::ControllerMessage,
                        Speaker::Controller,
                        InputClass::ControllerCompiled,
                    )
                } else {
                    (
                        EventKind::ControllerMessage,
                        Speaker::Runtime,
                        InputClass::RuntimeInjected,
                    )
                };
                let mut e = b.event(format!("dsh:{session_id}:{seq}"), ek, sp, class, time, turn);
                b.set_text(&mut e, &text, TEXT_CAP);
                events.push(e);
            }
            "assistant/message" => {
                if let Some(k) = step_key(d) {
                    finals.insert(k);
                }
                let content = &d["message"]["content"];
                let mut text = Vec::new();
                if let Some(blocks) = content.as_array() {
                    for blk in blocks {
                        match blk.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = blk.get("text").and_then(|t| t.as_str()) {
                                    text.push(t.to_owned());
                                }
                            }
                            Some("reasoning") => b.cov.reasoning_blocks_omitted += 1,
                            _ => {}
                        }
                    }
                }
                let joined = text.join("\n");
                if joined.trim().is_empty() {
                    continue;
                }
                let src = &d["message"]["source"];
                let mut e = b.event(
                    format!("dsh:{session_id}:{seq}"),
                    EventKind::AssistantMessage,
                    Speaker::Worker,
                    InputClass::ModelGenerated,
                    time,
                    d.get("turn").and_then(|t| t.as_u64()).or(turn),
                );
                e.actor = Actor {
                    agent: label(agent.clone()),
                    model: label(s(src, "model")),
                    provider: label(s(src, "provider")),
                };
                b.set_text(&mut e, &joined, TEXT_CAP);
                events.push(e);
            }
            "tool/call" => {
                let call_id = s(d, "callId");
                let args = s(d, "arguments").unwrap_or_default();
                if let Some(c) = &call_id {
                    call_args.insert(c.clone(), args.clone());
                }
                let mut e = b.event(
                    format!("dsh:{session_id}:{seq}"),
                    EventKind::ToolCall,
                    Speaker::Worker,
                    InputClass::ModelGenerated,
                    time,
                    d.get("turn").and_then(|t| t.as_u64()).or(turn),
                );
                e.actor.agent = label(agent.clone());
                e.tool_name = label(s(d, "name"));
                e.tool_call_id = label(call_id);
                let (clipped, truncated, len) = clip(&args, TOOL_INPUT_CAP);
                let (red, n) = redact_text(&clipped);
                e.tool_input = Some(red);
                e.truncated = truncated;
                e.original_len = Some(len);
                e.redactions = n;
                b.cov.redactions += u64::from(n);
                if truncated {
                    b.cov.truncated_fields += 1;
                }
                events.push(e);
            }
            "tool/result" => {
                let m = &d["message"];
                let call_id = m["source"]["callId"].as_str().map(str::to_owned);
                let text = texts_of(&m["content"]);
                let is_error = m["content"].as_array().and_then(|a| {
                    a.iter()
                        .find_map(|x| x.get("isError").and_then(|v| v.as_bool()))
                });
                let mut e = b.event(
                    format!("dsh:{session_id}:{seq}"),
                    EventKind::ToolResult,
                    Speaker::Tool,
                    InputClass::ToolOutput,
                    time,
                    d.get("turn").and_then(|t| t.as_u64()).or(turn),
                );
                e.tool_call_id = label(call_id);
                e.is_error = is_error;
                b.set_text(&mut e, &text, TEXT_CAP);
                events.push(e);
            }
            "tool/code-dispatch" | "tool/code-dispatch-start" => {
                b.cov.nested_tool_dispatches_not_rendered += 1;
            }
            "assistant/chunk" => {
                if let Some(k) = step_key(d) {
                    let a = acc.entry(k).or_insert(StepAcc {
                        text: String::new(),
                        time,
                        finish_error: false,
                    });
                    let ch = &d["chunk"];
                    match ch["type"].as_str() {
                        Some("text-delta") => {
                            if let Some(t) = ch["text"].as_str() {
                                a.text.push_str(t);
                            }
                        }
                        Some("finish") if ch["reason"]["kind"].as_str() == Some("error") => {
                            a.finish_error = true;
                        }
                        _ => {}
                    }
                }
            }
            "text-chunks" => {
                if let Some(k) = step_key(d) {
                    let a = acc.entry(k).or_insert(StepAcc {
                        text: String::new(),
                        time,
                        finish_error: false,
                    });
                    if let Some(arr) = d["texts"].as_array() {
                        for t in arr.iter().filter_map(|t| t.as_str()) {
                            a.text.push_str(t);
                        }
                    }
                }
            }
            "step/end" => {
                if let Some(k) = step_key(d) {
                    if !finals.contains(&k) {
                        if let Some(a) = acc.remove(&k) {
                            if !a.text.trim().is_empty() {
                                let mut e = b.event(
                                    format!("dsh:{session_id}:{}.{}:chunks", k.0, k.1),
                                    EventKind::AssistantMessage,
                                    Speaker::Worker,
                                    InputClass::ModelGenerated,
                                    a.time,
                                    Some(k.0),
                                );
                                e.actor = Actor {
                                    agent: label(agent.clone()),
                                    model: label(last_model.as_ref().and_then(|m| m.0.clone())),
                                    provider: label(last_model.as_ref().and_then(|m| m.1.clone())),
                                };
                                e.state = if a.finish_error {
                                    MessageState::Interrupted
                                } else {
                                    MessageState::Partial
                                };
                                e.recording = Recording::AssembledFromChunks;
                                b.set_text(&mut e, &a.text, TEXT_CAP);
                                events.push(e);
                            }
                        }
                    }
                }
            }
            "request/header" => {
                let h = &d["header"];
                let cfg = &h["config"];
                let provider = s(cfg, "provider");
                let model = s(cfg, "model");
                let handoff = match &last_model {
                    Some((m, p)) => (m != &model) || (p != &provider),
                    None => false,
                };
                if handoff {
                    let mut e = b.event(
                        format!("dsh:{session_id}:{seq}:handoff"),
                        EventKind::ModelHandoff,
                        Speaker::Runtime,
                        InputClass::System,
                        time,
                        turn,
                    );
                    e.actor = Actor {
                        agent: label(agent.clone()),
                        model: label(model.clone()),
                        provider: label(provider.clone()),
                    };
                    let from = last_model.clone().unwrap_or((None, None));
                    let lbl =
                        |v: &Option<String>| label(v.clone()).unwrap_or_else(|| "?".to_owned());
                    e.text = Some(format!(
                        "Model changed: {} / {} → {} / {}",
                        lbl(&from.1),
                        lbl(&from.0),
                        lbl(&provider),
                        lbl(&model)
                    ));
                    events.push(e);
                }
                last_model = Some((model.clone(), provider.clone()));
                let sys = h["system"].as_str().unwrap_or("");
                let (clipped, truncated, len) = clip(sys, TEXT_CAP);
                let (red, n) = redact_text(&clipped);
                b.cov.redactions += u64::from(n);
                if truncated {
                    b.cov.truncated_fields += 1;
                }
                requests.push(ModelRequestRecord {
                    record_id: format!("dsh:{session_id}:{seq}"),
                    attempt_id: None,
                    session_id: session_id.to_owned(),
                    turn,
                    timestamp_ms: time,
                    provider: label(provider),
                    model: label(model),
                    reasoning_effort: label(s(cfg, "reasoningEffort")),
                    max_tokens: cfg.get("maxTokens").and_then(|x| x.as_u64()),
                    context_window: None,
                    system_prompt: if sys.is_empty() { None } else { Some(red) },
                    system_prompt_len: len,
                    system_prompt_truncated: truncated,
                    tool_names: h["tools"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|t| label(s(t, "name")))
                                .take(200)
                                .collect()
                        })
                        .unwrap_or_default(),
                    redactions: n,
                    source: Source::DshSessionLog,
                });
                last_request_idx = Some(requests.len() - 1);
            }
            "request/context" => {
                if let Some(i) = last_request_idx {
                    requests[i].context_window = d.get("contextWindow").and_then(|x| x.as_u64());
                }
            }
            "llm/retry" => {
                let mut e = b.event(
                    format!("dsh:{session_id}:{seq}"),
                    EventKind::Status,
                    Speaker::Runtime,
                    InputClass::System,
                    time,
                    d.get("turn").and_then(|t| t.as_u64()).or(turn),
                );
                let msg = d["failure"]["message"].as_str().unwrap_or("provider error");
                let text = format!(
                    "Provider retry {}/{}: {}",
                    d["retry"].as_u64().unwrap_or(0),
                    d["maxRetries"].as_u64().unwrap_or(0),
                    msg
                );
                b.set_text(&mut e, &text, TEXT_CAP);
                e.error_code = label(s(&d["failure"], "code"));
                events.push(e);
            }
            "turn/end" => {
                let kind = d["reason"]["kind"].as_str().unwrap_or("");
                let t = d.get("turn").and_then(|t| t.as_u64());
                match kind {
                    "completed" => {}
                    "error" => {
                        let mut e = b.event(
                            format!("dsh:{session_id}:{seq}"),
                            EventKind::Error,
                            Speaker::Runtime,
                            InputClass::System,
                            time,
                            t,
                        );
                        let msg = d["reason"]["error"]["message"]
                            .as_str()
                            .unwrap_or("turn ended with an error");
                        b.set_text(&mut e, msg, TEXT_CAP);
                        e.is_error = Some(true);
                        e.error_code = label(s(&d["reason"]["error"], "code"));
                        events.push(e);
                    }
                    other => {
                        let mut e = b.event(
                            format!("dsh:{session_id}:{seq}"),
                            EventKind::Status,
                            Speaker::Runtime,
                            InputClass::System,
                            time,
                            t,
                        );
                        e.text = Some(format!(
                            "Turn ended: {}",
                            label(Some(other.to_owned())).unwrap_or_default()
                        ));
                        events.push(e);
                    }
                }
            }
            _ => {}
        }
    }
    events
}

/// Build the historical conversation for one task instance.
pub fn read_history(src: &DshSources, task_instance_id: &str) -> Result<History, HistoryError> {
    let mut cov = Coverage::default();
    let (display, mut attempts) = load_attempts(&src.runs_dir, task_instance_id, &mut cov)?;
    let mut sessions: Vec<String> = Vec::new();
    for a in &attempts {
        if let Some(sid) = &a.prov.session_id {
            if !sessions.contains(sid) {
                sessions.push(sid.clone());
            }
        }
    }
    let mut per_session: Vec<(u64, Vec<TranscriptEventV1>)> = Vec::new();
    let mut requests: Vec<ModelRequestRecord> = Vec::new();
    let mut verified_sessions: HashSet<String> = HashSet::new();
    for sid in &sessions {
        let workspace = attempts
            .iter()
            .find(|a| a.prov.session_id.as_deref() == Some(sid))
            .and_then(|a| a.workspace.clone());
        let Some(path) = find_session_file(&src.sessions_root, sid) else {
            cov.notes.push(format!("session {sid}: log file not found"));
            for a in attempts
                .iter_mut()
                .filter(|a| a.prov.session_id.as_deref() == Some(sid))
            {
                a.prov.binding = "unavailable: session log not found".to_owned();
            }
            continue;
        };
        let raw = match decompress(&path, &src.limits) {
            Ok((r, note)) => {
                if let Some(n) = note {
                    cov.notes.push(format!("session {sid}: {n}"));
                    cov.records_invalid += 1;
                }
                r
            }
            Err(e) => {
                cov.notes.push(format!("session {sid}: unreadable ({e})"));
                for a in attempts
                    .iter_mut()
                    .filter(|a| a.prov.session_id.as_deref() == Some(sid))
                {
                    a.prov.binding = "unavailable: session log unreadable".to_owned();
                }
                continue;
            }
        };
        let mut rows: Vec<Value> = Vec::new();
        for line in raw.lines() {
            if rows.len() >= MAX_ROWS {
                cov.notes
                    .push(format!("session {sid}: row limit {MAX_ROWS} reached"));
                break;
            }
            if line.len() > src.limits.max_line {
                cov.records_invalid += 1;
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(v) => rows.push(v),
                Err(_) => cov.records_invalid += 1,
            }
        }
        match verify_binding(&rows, sid, workspace.as_deref(), task_instance_id) {
            Err(why) => {
                cov.notes.push(format!("session {sid}: refused ({why})"));
                for a in attempts
                    .iter_mut()
                    .filter(|a| a.prov.session_id.as_deref() == Some(sid))
                {
                    a.prov.binding = format!("refused: {why}");
                }
            }
            Ok(()) => {
                for a in attempts
                    .iter_mut()
                    .filter(|a| a.prov.session_id.as_deref() == Some(sid))
                {
                    a.prov.binding = "verified".to_owned();
                }
                verified_sessions.insert(sid.clone());
                let mut req_local: Vec<ModelRequestRecord> = Vec::new();
                let evs = process_session(
                    &rows,
                    sid,
                    task_instance_id,
                    &display,
                    &mut cov,
                    &mut req_local,
                );
                let started = rows[0]
                    .get("createdAt")
                    .and_then(|c| c.as_u64())
                    .unwrap_or(0);
                per_session.push((started, evs));
                requests.extend(req_local);
            }
        }
    }
    // Sessions are ordered by header creation time; file order is preserved within each.
    per_session.sort_by_key(|(t, _)| *t);
    let mut all: Vec<TranscriptEventV1> = per_session.into_iter().flat_map(|(_, e)| e).collect();
    // Attempt attribution by turn within each verified session.
    let mut by_session: HashMap<&str, Vec<(u64, &str)>> = HashMap::new();
    for a in &attempts {
        if let (Some(sid), Some(t)) = (a.prov.session_id.as_deref(), a.prov.started_by_turn) {
            by_session
                .entry(sid)
                .or_default()
                .push((t, a.prov.attempt_id.as_str()));
        }
    }
    for v in by_session.values_mut() {
        v.sort();
    }
    let attribute = |sid: &str, turn: Option<u64>| -> Option<String> {
        let t = turn?;
        by_session
            .get(sid)?
            .iter()
            .rev()
            .find(|(start, _)| *start <= t)
            .map(|(_, id)| (*id).to_owned())
    };
    for e in all.iter_mut() {
        if let Some(sid) = e.session_id.clone() {
            e.attempt_id = attribute(&sid, e.turn);
        }
    }
    for r in requests.iter_mut() {
        r.attempt_id = attribute(&r.session_id, r.turn);
    }
    for (i, e) in all.iter_mut().enumerate() {
        e.seq = i as u64;
    }
    cov.events_emitted = all.len() as u64;
    if requests.iter().any(|r| r.system_prompt_truncated) {
        cov.notes
            .push("one or more recorded system prompts were truncated for display".to_owned());
    }
    Ok(History {
        display_task_id: display,
        attempts: attempts.into_iter().map(|a| a.prov).collect(),
        events: all,
        model_requests: requests,
        coverage: cov,
    })
}

/// Small bounded cache: switching between tasks and paging "load earlier"
/// must not re-decode multi-megabyte logs. Entries are keyed by task instance
/// and invalidated by the size/mtime of every file the result depends on.
type CacheEntry = (String, String, std::sync::Arc<History>);
static CACHE: std::sync::OnceLock<std::sync::Mutex<Vec<CacheEntry>>> = std::sync::OnceLock::new();
const CACHE_ENTRIES: usize = 6;

fn fingerprint(src: &DshSources, task_instance_id: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::time::UNIX_EPOCH;
    let mut cov = Coverage::default();
    let (_, attempts) = load_attempts(&src.runs_dir, task_instance_id, &mut cov).ok()?;
    let mut h = Sha256::new();
    h.update(format!("{:?}", src.limits).as_bytes());
    for a in &attempts {
        h.update(
            format!(
                "{}|{:?}|{:?}",
                a.prov.attempt_id, a.prov.session_id, a.prov.started_by_turn
            )
            .as_bytes(),
        );
        if let Some(sid) = &a.prov.session_id {
            match find_session_file(&src.sessions_root, sid).and_then(|p| fs::metadata(p).ok()) {
                Some(m) => {
                    let mt = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    h.update(format!("|{}|{}", m.len(), mt).as_bytes());
                }
                None => h.update(b"|missing"),
            }
        }
    }
    Some(hex::encode(h.finalize()))
}

/// Cached variant of [`read_history`].
pub fn read_history_cached(
    src: &DshSources,
    task_instance_id: &str,
) -> Result<std::sync::Arc<History>, HistoryError> {
    let fp = fingerprint(src, task_instance_id);
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    if let Some(fp) = &fp {
        if let Ok(g) = cache.lock() {
            if let Some((_, _, h)) = g
                .iter()
                .find(|(id, f, _)| id == task_instance_id && f == fp)
            {
                return Ok(h.clone());
            }
        }
    }
    let built = std::sync::Arc::new(read_history(src, task_instance_id)?);
    if let (Some(fp), Ok(mut g)) = (fp, cache.lock()) {
        g.retain(|(id, _, _)| id != task_instance_id);
        g.push((task_instance_id.to_owned(), fp, built.clone()));
        while g.len() > CACHE_ENTRIES {
            g.remove(0);
        }
    }
    Ok(built)
}

/// Authoritative attempt list for a task instance, from the Controller
/// attempt journal only (no session logs are opened). Returns the display
/// task id and the recorded attempts in sequence order.
pub fn list_attempts(
    runs_dir: &Path,
    task_instance_id: &str,
) -> Result<(String, Vec<AttemptProvenance>), HistoryError> {
    let mut cov = Coverage::default();
    let (display, attempts) = load_attempts(runs_dir, task_instance_id, &mut cov)?;
    Ok((display, attempts.into_iter().map(|a| a.prov).collect()))
}
