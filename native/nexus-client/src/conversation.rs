//! Per-task conversation API (A2.5).
//!
//! Read paths resolve a task instance id to its recorded conversation:
//! the native store first, then the verified historical DSH adapter. Write
//! paths exist only inside the backend (`run_mock_recorded`), never as a
//! renderer-facing endpoint. Nothing is synthesized: absent history is
//! reported as absent.

use crate::config::ClientConfig;
use crate::error::ClientError;
use crate::mock::{run_mock_streaming, MockProgress, MockRunReport};
use nexus_transcript::store::valid_task_id;
use nexus_transcript::{
    page, read_history_cached, Actor, AttemptProvenance, Coverage, DshSources, EventKind,
    HistoryError, InputClass, MessageState, ModelRequestRecord, Page, PageSpec, Source, Speaker,
    TranscriptEventV1, TranscriptStore,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Exact user-facing copy when nothing was recorded.
pub const NO_HISTORY_MESSAGE: &str = "Conversation history was not recorded for this task.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub task_instance_id: String,
    /// `native-store` | `dsh-session-log` | `none`
    pub source: String,
    pub available: bool,
    pub reason: Option<String>,
    pub display_task_id: Option<String>,
    pub attempts: Vec<AttemptProvenance>,
    pub page: Page,
    pub coverage: Coverage,
    /// Set when the durable store failed its integrity chain.
    pub integrity_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIoView {
    pub task_instance_id: String,
    pub source: String,
    pub available: bool,
    pub records: Vec<ModelRequestRecord>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockConversationSummary {
    pub conversation_id: String,
    pub first_prompt: String,
    pub started_at_ms: Option<u64>,
    pub events: u64,
    pub finalized: bool,
}

const MODEL_IO_NOTE: &str = "Only the recorded request header is shown (provider, model, effort, system prompt, tool names). The full provider message array is not recorded verbatim, so it is not shown and never reconstructed.";

fn empty_page() -> Page {
    page(
        &[],
        PageSpec {
            limit: 1,
            ..Default::default()
        },
    )
}

fn none_view(
    id: &str,
    reason: String,
    attempts: Vec<AttemptProvenance>,
    cov: Coverage,
    display: Option<String>,
) -> ConversationView {
    ConversationView {
        task_instance_id: id.to_owned(),
        source: "none".to_owned(),
        available: false,
        reason: Some(reason),
        display_task_id: display,
        attempts,
        page: empty_page(),
        coverage: cov,
        integrity_failure: None,
    }
}

fn dsh_sources(cfg: &ClientConfig) -> Option<DshSources> {
    Some(DshSources::new(
        cfg.runs_dir.clone()?,
        cfg.sessions_root.clone()?,
    ))
}

fn check_id(id: &str) -> Result<(), ClientError> {
    if valid_task_id(id) {
        Ok(())
    } else {
        Err(ClientError::usage("task instance id is malformed"))
    }
}

/// Resolve the conversation for one task instance.
pub fn conversation(
    cfg: &ClientConfig,
    task_instance_id: &str,
    spec: PageSpec,
) -> Result<ConversationView, ClientError> {
    check_id(task_instance_id)?;
    // 1. Native store (authoritative for native/mock records).
    if let Ok(store) = TranscriptStore::open(&cfg.transcript_dir) {
        if store.exists(task_instance_id) {
            let loaded = store
                .load(task_instance_id)
                .map_err(|e| ClientError::internal(e.to_string()))?;
            let mut cov = Coverage {
                events_emitted: loaded.events.len() as u64,
                records_invalid: loaded.skipped,
                ..Default::default()
            };
            let integrity = loaded.integrity_failure_at.map(|n| {
                format!("transcript chain broken at line {n}; later records are not trusted")
            });
            if let Some(i) = &integrity {
                cov.notes.push(i.clone());
            }
            return Ok(ConversationView {
                task_instance_id: task_instance_id.to_owned(),
                source: "native-store".to_owned(),
                available: !loaded.events.is_empty(),
                reason: if loaded.events.is_empty() {
                    Some(NO_HISTORY_MESSAGE.to_owned())
                } else {
                    None
                },
                display_task_id: loaded
                    .events
                    .first()
                    .and_then(|e| e.display_task_id.clone()),
                attempts: Vec::new(),
                page: page(&loaded.events, spec),
                coverage: cov,
                integrity_failure: integrity,
            });
        }
    }
    // 2. Historical DSH session log, joined only through the attempt journal.
    let Some(src) = dsh_sources(cfg) else {
        return Ok(none_view(
            task_instance_id,
            format!(
                "{NO_HISTORY_MESSAGE} (no Controller run directory or session root is configured)"
            ),
            Vec::new(),
            Coverage::default(),
            None,
        ));
    };
    match read_history_cached(&src, task_instance_id) {
        Ok(h) => {
            if h.events.is_empty() {
                let detail = h
                    .attempts
                    .iter()
                    .map(|a| a.binding.as_str())
                    .collect::<Vec<_>>()
                    .join("; ");
                return Ok(none_view(
                    task_instance_id,
                    format!("{NO_HISTORY_MESSAGE} ({detail})"),
                    h.attempts.clone(),
                    h.coverage.clone(),
                    Some(h.display_task_id.clone()),
                ));
            }
            Ok(ConversationView {
                task_instance_id: task_instance_id.to_owned(),
                source: "dsh-session-log".to_owned(),
                available: true,
                reason: None,
                display_task_id: Some(h.display_task_id.clone()),
                attempts: h.attempts.clone(),
                page: page(&h.events, spec),
                coverage: h.coverage.clone(),
                integrity_failure: None,
            })
        }
        Err(HistoryError::NoAttempts) => Ok(none_view(
            task_instance_id,
            format!("{NO_HISTORY_MESSAGE} (the Controller recorded no attempt for this task)"),
            Vec::new(),
            Coverage::default(),
            None,
        )),
        Err(HistoryError::Io(e)) => Ok(none_view(
            task_instance_id,
            format!("{NO_HISTORY_MESSAGE} (attempt journal unreadable: {e})"),
            Vec::new(),
            Coverage::default(),
            None,
        )),
    }
}

/// Recorded provider-request headers for a task (Model I/O view).
pub fn model_io(cfg: &ClientConfig, task_instance_id: &str) -> Result<ModelIoView, ClientError> {
    check_id(task_instance_id)?;
    let empty = |note: &str| ModelIoView {
        task_instance_id: task_instance_id.to_owned(),
        source: "none".to_owned(),
        available: false,
        records: Vec::new(),
        note: note.to_owned(),
    };
    if task_instance_id.starts_with("mock_") {
        return Ok(empty(
            "Mock runs use a loopback fixture provider; no provider request header exists.",
        ));
    }
    let Some(src) = dsh_sources(cfg) else {
        return Ok(empty(
            "No Controller run directory or session root is configured.",
        ));
    };
    match read_history_cached(&src, task_instance_id) {
        Ok(h) if !h.model_requests.is_empty() => Ok(ModelIoView {
            task_instance_id: task_instance_id.to_owned(),
            source: "dsh-session-log".to_owned(),
            available: true,
            records: h.model_requests.clone(),
            note: MODEL_IO_NOTE.to_owned(),
        }),
        _ => Ok(empty(
            "No verified provider request records exist for this task.",
        )),
    }
}

fn mock_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = Sha256::new();
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update(b"nexus-mock-conversation");
    format!("mock_{}", &hex::encode(h.finalize())[..32])
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mk(
    id: &str,
    conv: &str,
    kind: EventKind,
    speaker: Speaker,
    class: InputClass,
) -> TranscriptEventV1 {
    let mut e = TranscriptEventV1::new(id, conv, kind, speaker, class, Source::MockFixture);
    e.timestamp_ms = Some(now_ms());
    e.display_task_id = Some("MOCK".to_owned());
    e
}

/// Run the isolated mock workflow and durably record its conversation in the
/// backend-owned native store (source `mock-fixture`). Returns the report and
/// the conversation id. The renderer can only trigger this; it cannot write.
pub fn run_mock_recorded(
    cfg: &ClientConfig,
    prompt: &str,
    on_progress: &mut dyn FnMut(MockProgress),
) -> Result<(MockRunReport, String), ClientError> {
    if prompt.trim().is_empty() {
        return Err(ClientError::usage("prompt must not be empty"));
    }
    let store = TranscriptStore::open(&cfg.transcript_dir)
        .map_err(|e| ClientError::internal(format!("transcript store unavailable: {e}")))?;
    let conv = mock_id();
    on_progress(MockProgress::Conversation { id: conv.clone() });
    let rec = |e: TranscriptEventV1| -> Result<(), ClientError> {
        store
            .append(&conv, e)
            .map(|_| ())
            .map_err(|e| ClientError::internal(format!("transcript write failed: {e}")))
    };
    let (prompt_text, redactions) = nexus_transcript::redact::redact_text(prompt);
    let mut user = mk(
        "user-1",
        &conv,
        EventKind::UserMessage,
        Speaker::User,
        InputClass::UserAuthored,
    );
    user.text = Some(prompt_text);
    user.redactions = redactions;
    rec(user)?;

    let mut text = String::new();
    let mut rev: u32 = 0;
    let mut write_err: Option<ClientError> = None;
    let report = run_mock_streaming(prompt, &mut |p| {
        on_progress(p.clone());
        if write_err.is_some() {
            return;
        }
        let result = match &p {
            MockProgress::Step { id, label } => {
                let mut e = mk(
                    &format!("step-{id}"),
                    &conv,
                    EventKind::Status,
                    Speaker::Runtime,
                    InputClass::System,
                );
                e.text = Some(label.clone());
                rec(e)
            }
            MockProgress::Stream(item) if item.kind == "text" => {
                text.push_str(&item.content);
                let mut e = mk(
                    "assistant-1",
                    &conv,
                    EventKind::AssistantMessage,
                    Speaker::Worker,
                    InputClass::ModelGenerated,
                );
                e.event_id = format!("assistant-1@{rev}");
                e.revision = rev;
                e.state = MessageState::Partial;
                e.actor = Actor {
                    agent: Some("mock-provider".to_owned()),
                    model: Some("e2e-mock-model".to_owned()),
                    provider: Some("loopback-fixture".to_owned()),
                };
                e.text = Some(text.clone());
                rev += 1;
                rec(e)
            }
            MockProgress::Stream(_) | MockProgress::Conversation { .. } => Ok(()),
        };
        if let Err(e) = result {
            write_err = Some(e);
        }
    });
    let report = match report {
        Ok(r) => r,
        Err(err) => {
            let mut e = mk(
                "error-1",
                &conv,
                EventKind::Error,
                Speaker::Runtime,
                InputClass::System,
            );
            e.text = Some(err.message.clone());
            e.is_error = Some(true);
            e.error_code = Some(err.code.to_owned());
            let _ = rec(e);
            return Err(err);
        }
    };
    if let Some(e) = write_err {
        return Err(e);
    }
    let mut fin = mk(
        "assistant-1",
        &conv,
        EventKind::AssistantMessage,
        Speaker::Worker,
        InputClass::ModelGenerated,
    );
    fin.event_id = format!("assistant-1@{rev}");
    fin.revision = rev;
    fin.state = MessageState::Final;
    fin.actor = Actor {
        agent: Some("mock-provider".to_owned()),
        model: Some("e2e-mock-model".to_owned()),
        provider: Some("loopback-fixture".to_owned()),
    };
    fin.text = Some(report.text.clone());
    rec(fin)?;
    let passed = report.checks.iter().filter(|c| c.status == "pass").count();
    let mut v = mk(
        "verify-1",
        &conv,
        EventKind::Status,
        Speaker::Runtime,
        InputClass::System,
    );
    v.text = Some(format!(
        "Verification: {passed}/{} checks passed · finish {}",
        report.checks.len(),
        report.finish_reason
    ));
    rec(v)?;
    Ok((report, conv))
}

/// Index of persisted mock conversations (newest first).
pub fn list_mock_conversations(cfg: &ClientConfig) -> Vec<MockConversationSummary> {
    let Ok(store) = TranscriptStore::open(&cfg.transcript_dir) else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(store.root()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if !id.starts_with("mock_") || !valid_task_id(id) {
            continue;
        }
        let Ok(loaded) = store.load(id) else {
            continue;
        };
        let collapsed = nexus_transcript::view::collapse(&loaded.events);
        let first = collapsed.iter().find(|e| e.kind == EventKind::UserMessage);
        let finalized = collapsed
            .iter()
            .any(|e| e.kind == EventKind::AssistantMessage && e.state == MessageState::Final);
        out.push(MockConversationSummary {
            conversation_id: id.to_owned(),
            first_prompt: first
                .and_then(|e| e.text.clone())
                .unwrap_or_default()
                .chars()
                .take(160)
                .collect(),
            started_at_ms: first.and_then(|e| e.timestamp_ms),
            events: collapsed.len() as u64,
            finalized,
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.started_at_ms));
    out.truncate(100);
    out
}
