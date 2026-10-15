//! Typed, read-only tool event contract for GUI / CLI consumers.
//!
//! Events are *derived* from the authoritative Kernel tool journal; they
//! are never authored by a UI and never fabricate assistant messages. A
//! consumer maps `ToolEventV1` into Conversation (inline tool cards),
//! Activity (timeline), Tool details and Verification views.

use nexus_store::ToolJournalEntry;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolEventStatus {
    Authorized,
    Started,
    Completed,
    Failed,
    /// `started` was journaled but no `completed` followed (crash or
    /// in-flight). Never auto-retried.
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEventV1 {
    pub schema_version: u32,
    pub request_id: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub tool_id: String,
    pub tool_version: u32,
    pub status: ToolEventStatus,
    pub args: serde_json::Value,
    pub result_status: Option<String>,
    pub error_code: Option<String>,
    pub truncated: bool,
    pub truncation_reasons: Vec<String>,
    pub redacted: bool,
    pub redaction_kinds: Vec<String>,
    pub output_digest: Option<String>,
    pub output_bytes: Option<u64>,
    pub stats: Option<serde_json::Value>,
    /// Always false in A3.1: live AI-initiated execution is disabled.
    pub ai_initiated: bool,
    pub first_seq: i64,
    pub last_seq: i64,
    pub authorized_at_utc: String,
    pub last_at_utc: String,
}

/// Fold journal entries (append order) into one event per request.
pub fn tool_events_from_journal(entries: &[ToolJournalEntry]) -> Vec<ToolEventV1> {
    let mut order: Vec<String> = Vec::new();
    let mut by: std::collections::HashMap<String, ToolEventV1> = std::collections::HashMap::new();
    for e in entries {
        let ev = by.entry(e.request_id.clone()).or_insert_with(|| {
            order.push(e.request_id.clone());
            ToolEventV1 {
                schema_version: 1,
                request_id: e.request_id.clone(),
                execution_id: e.execution_id.clone(),
                task_instance_id: e.task_instance_id.clone(),
                attempt_id: e.attempt_id.clone(),
                command_id: e.command_id.clone(),
                tool_id: e
                    .payload
                    .get("toolId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                tool_version: e
                    .payload
                    .get("toolVersion")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                status: ToolEventStatus::Authorized,
                args: serde_json::Value::Null,
                result_status: None,
                error_code: None,
                truncated: false,
                truncation_reasons: Vec::new(),
                redacted: false,
                redaction_kinds: Vec::new(),
                output_digest: None,
                output_bytes: None,
                stats: None,
                ai_initiated: false,
                first_seq: e.seq,
                last_seq: e.seq,
                authorized_at_utc: e.recorded_at_utc.clone(),
                last_at_utc: e.recorded_at_utc.clone(),
            }
        });
        ev.last_seq = e.seq;
        ev.last_at_utc = e.recorded_at_utc.clone();
        match e.phase.as_str() {
            "started" => ev.status = ToolEventStatus::Started,
            "completed" => {
                let p = &e.payload;
                let rs = p.get("resultStatus").and_then(|v| v.as_str());
                ev.status = if rs == Some("error") {
                    ToolEventStatus::Failed
                } else {
                    ToolEventStatus::Completed
                };
                ev.result_status = rs.map(str::to_owned);
                ev.error_code = p
                    .get("errorCode")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                if let Some(t) = p.get("truncation") {
                    ev.truncated = t
                        .get("truncated")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    ev.truncation_reasons = t
                        .get("reasons")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                if let Some(r) = p.get("redaction") {
                    ev.redacted = r.get("redacted").and_then(|v| v.as_bool()).unwrap_or(false);
                    ev.redaction_kinds = r
                        .get("kinds")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                ev.output_digest = p
                    .get("outputDigest")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                ev.output_bytes = p.get("outputBytes").and_then(|v| v.as_u64());
                ev.stats = p.get("stats").cloned();
                if let Some(a) = p.get("args") {
                    ev.args = a.clone();
                }
                if let Some(t) = p.get("toolId").and_then(|v| v.as_str()) {
                    ev.tool_id = t.to_owned();
                }
            }
            _ => {}
        }
    }
    order.into_iter().filter_map(|k| by.remove(&k)).collect()
}

impl ToolEventV1 {
    /// A request journaled as started with no completion is interrupted.
    pub fn mark_interrupted_if_open(mut self) -> Self {
        if self.status == ToolEventStatus::Started {
            self.status = ToolEventStatus::Interrupted;
        }
        self
    }
}
