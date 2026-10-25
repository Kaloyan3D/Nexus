//! Typed, read-only tool event contract for GUI / CLI consumers.
//!
//! Events are *derived* from the authoritative Kernel tool journal; they
//! are never authored by a UI and never fabricate assistant messages. One
//! allow-listed projection (`ToolRecordV1`) is shared by the daemon and by
//! in-process callers, and `fold_tool_records` turns phase records into
//! one `ToolEventV1` per request.

use nexus_store::ToolJournalEntry;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolEventStatus {
    Authorized,
    Started,
    /// Write intent durably recorded; nothing mutated yet.
    Planned,
    /// Temp file durable; not yet published.
    Prepared,
    /// Published and directory-synced; not yet verified.
    Applied,
    /// Published and re-read: matches the planned post-image.
    Verified,
    /// Refused because the target differs from what was expected.
    Conflict,
    /// Read tool finished.
    Completed,
    Failed,
    /// Started/planned with no terminal record (crash). Outcome per
    /// `change.mutation`; never auto-retried.
    Interrupted,
    Expired,
    Cancelled,
    /// Sandboxed process is executing (`running` journaled).
    Running,
    /// Sandboxed process terminated; see `process.reason`/`exitCode`.
    Exited,
}

/// Allow-listed projection of one journal phase record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRecordV1 {
    pub seq: i64,
    pub phase: String,
    pub request_id: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub command_id: String,
    pub recorded_at_utc: String,
    #[serde(default)]
    pub tool_id: Option<String>,
    #[serde(default)]
    pub tool_version: Option<u32>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub args: serde_json::Value,
    #[serde(default)]
    pub result_status: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub truncation: serde_json::Value,
    #[serde(default)]
    pub redaction: serde_json::Value,
    #[serde(default)]
    pub stats: serde_json::Value,
    #[serde(default)]
    pub output_digest: Option<String>,
    #[serde(default)]
    pub output_bytes: Option<u64>,
    #[serde(default)]
    pub reason: Option<String>,
    /// Write phases: operation/path/pre+post digests/mutation/observed.
    #[serde(default)]
    pub change: serde_json::Value,
    /// Process phases: command, snapshot/sandbox digests, exit, usage,
    /// bounded redacted output tails, sandbox policy summary.
    #[serde(default)]
    pub process: serde_json::Value,
    #[serde(default)]
    pub ai_initiated: bool,
    #[serde(default)]
    pub lease_epoch: Option<u64>,
}

/// The single projection used for every consumer. Never passes the raw
/// payload through: only named fields, no roots, no content, no query text.
pub fn record_from_entry(e: &ToolJournalEntry) -> ToolRecordV1 {
    let p = &e.payload;
    let s = |k: &str| p.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let pick = |k: &str| p.get(k).cloned().unwrap_or(serde_json::Value::Null);
    let mut change = serde_json::Map::new();
    for (src, dst) in [
        ("operation", "operation"),
        ("path", "path"),
        ("preSha256", "preSha256"),
        ("postSha256", "postSha256"),
        ("postBytes", "postBytes"),
        ("mutation", "mutation"),
        ("observed", "observed"),
        ("observedSha256", "observedSha256"),
        ("conflict", "conflict"),
        ("preservedAs", "preservedAs"),
        ("approverIndependent", "approverIndependent"),
        ("displacedPreserved", "displacedPreserved"),
        (
            "publishedOverUnexpectedPreImage",
            "publishedOverUnexpectedPreImage",
        ),
    ] {
        if let Some(v) = p.get(src) {
            change.insert(dst.to_owned(), v.clone());
        }
    }
    ToolRecordV1 {
        seq: e.seq,
        phase: e.phase.clone(),
        request_id: e.request_id.clone(),
        execution_id: e.execution_id.clone(),
        task_instance_id: e.task_instance_id.clone(),
        attempt_id: e.attempt_id.clone(),
        command_id: e.command_id.clone(),
        recorded_at_utc: e.recorded_at_utc.clone(),
        tool_id: s("toolId"),
        tool_version: p
            .get("toolVersion")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        scope: s("scope"),
        args: pick("args"),
        result_status: s("resultStatus"),
        error_code: s("errorCode"),
        truncation: pick("truncation"),
        redaction: pick("redaction"),
        stats: pick("stats"),
        output_digest: s("outputDigest"),
        output_bytes: p.get("outputBytes").and_then(|v| v.as_u64()),
        reason: s("reason"),
        process: {
            let mut m = serde_json::Map::new();
            for k in [
                "command",
                "program",
                "argvDigest",
                "cwd",
                "snapshotDigest",
                "snapshotFiles",
                "snapshotBytes",
                "snapshotSkipped",
                "sandboxDigest",
                "sandbox",
                "limits",
                "exitCode",
                "signal",
                "verification",
                "wallMs",
                "userMs",
                "sysMs",
                "maxRssKb",
                "peakRssBytes",
                "peakProcs",
                "stdoutBytes",
                "stderrBytes",
                "stdoutTruncated",
                "stderrTruncated",
                "stdoutTail",
                "stderrTail",
                "outputDigest",
                "processStarted",
                "outcome",
                "leftoverProcessesKilled",
                "runDirRemoved",
                // standing grant / filesystem scope the command ran under (absent for legacy runs)
                "grant",
                "fsScope",
                // M3A: observation boundary (prepared) and bounded effects summary (exited/cancelled/recovered)
                "observation",
                "effects",
            ] {
                if let Some(v) = p.get(k) {
                    m.insert(k.to_owned(), v.clone());
                }
            }
            if (e.phase == "exited" || e.phase == "cancelled") && p.get("reason").is_some() {
                m.insert("terminationReason".to_owned(), p["reason"].clone());
            }
            if m.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::Object(m)
            }
        },
        change: if change.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::Object(change)
        },
        // A5.5: set by the Kernel only for a model-proposed read call in a
        // repo-inspect command (journaled at `authorized`).
        ai_initiated: p
            .get("aiInitiated")
            .or_else(|| p.get("provenance").and_then(|x| x.get("aiInitiated")))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        lease_epoch: p.get("leaseEpoch").and_then(|v| v.as_u64()).or_else(|| {
            p.get("provenance")
                .and_then(|x| x.get("leaseEpoch"))
                .and_then(|v| v.as_u64())
        }),
    }
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
    /// `read` or `write` (from the sealed grant scope).
    pub scope: String,
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
    /// Write tools: operation, path, pre/post digests, `mutation`
    /// (`none` | `applied` | `applied-unverified` | `uncertain` | ...).
    pub change: Option<serde_json::Value>,
    /// Process tools only (see `ToolRecordV1::process`).
    pub process: Option<serde_json::Value>,
    /// True only for a model-proposed read call in a user-initiated
    /// repo-inspect command (A5.5); false for everything else.
    pub ai_initiated: bool,
    /// Lease generation the request was authorized under.
    pub lease_epoch: Option<u64>,
    pub first_seq: i64,
    pub last_seq: i64,
    pub authorized_at_utc: String,
    pub last_at_utc: String,
}

/// Fold phase records (ascending `seq`) into one event per request.
/// Duplicate or out-of-order `seq` values are ignored, so a reconnecting
/// consumer that re-reads an overlapping page produces no duplicates.
pub fn fold_tool_records(records: &[ToolRecordV1]) -> Vec<ToolEventV1> {
    let mut order: Vec<String> = Vec::new();
    let mut by: std::collections::HashMap<String, ToolEventV1> = std::collections::HashMap::new();
    let mut last_seq = 0i64;
    for r in records {
        if r.seq <= last_seq {
            continue;
        }
        last_seq = r.seq;
        let ev = by.entry(r.request_id.clone()).or_insert_with(|| {
            order.push(r.request_id.clone());
            ToolEventV1 {
                schema_version: 1,
                request_id: r.request_id.clone(),
                execution_id: r.execution_id.clone(),
                task_instance_id: r.task_instance_id.clone(),
                attempt_id: r.attempt_id.clone(),
                command_id: r.command_id.clone(),
                tool_id: r.tool_id.clone().unwrap_or_default(),
                tool_version: r.tool_version.unwrap_or(0),
                scope: r.scope.clone().unwrap_or_else(|| "read".to_owned()),
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
                change: None,
                process: None,
                ai_initiated: r.ai_initiated,
                lease_epoch: r.lease_epoch,
                first_seq: r.seq,
                last_seq: r.seq,
                authorized_at_utc: r.recorded_at_utc.clone(),
                last_at_utc: r.recorded_at_utc.clone(),
            }
        });
        ev.last_seq = r.seq;
        ev.last_at_utc = r.recorded_at_utc.clone();
        if ev.lease_epoch.is_none() {
            ev.lease_epoch = r.lease_epoch;
        }
        if let Some(t) = &r.tool_id {
            ev.tool_id = t.clone();
        }
        if let serde_json::Value::Object(m) = &r.change {
            let mut cur = match ev.change.take() {
                Some(serde_json::Value::Object(c)) => c,
                _ => serde_json::Map::new(),
            };
            for (k, v) in m {
                cur.insert(k.clone(), v.clone());
            }
            ev.change = Some(serde_json::Value::Object(cur));
        }
        if let serde_json::Value::Object(m) = &r.process {
            let mut cur = match ev.process.take() {
                Some(serde_json::Value::Object(c)) => c,
                _ => serde_json::Map::new(),
            };
            for (k, v) in m {
                cur.insert(k.clone(), v.clone());
            }
            ev.process = Some(serde_json::Value::Object(cur));
        }
        match r.phase.as_str() {
            "running" => ev.status = ToolEventStatus::Running,
            "exited" => {
                ev.status = ToolEventStatus::Exited;
                ev.result_status = Some("ok".to_owned());
            }
            "cancelled" => {
                ev.status = ToolEventStatus::Cancelled;
                ev.result_status = Some("error".to_owned());
            }
            "started" => ev.status = ToolEventStatus::Started,
            "planned" => ev.status = ToolEventStatus::Planned,
            "prepared" => ev.status = ToolEventStatus::Prepared,
            "applied" => ev.status = ToolEventStatus::Applied,
            "verified" => {
                ev.status = ToolEventStatus::Verified;
                ev.result_status = Some("ok".to_owned());
            }
            "conflict" => {
                ev.status = ToolEventStatus::Conflict;
                ev.result_status = Some("error".to_owned());
                ev.error_code = r.error_code.clone().or(Some("conflict".to_owned()));
            }
            "failed" => {
                ev.status =
                    if matches!(r.error_code.as_deref(), Some("cancelled") | Some("revoked")) {
                        ToolEventStatus::Cancelled
                    } else {
                        ToolEventStatus::Failed
                    };
                ev.result_status = Some("error".to_owned());
                ev.error_code = r.error_code.clone();
            }
            "expired" => ev.status = ToolEventStatus::Expired,
            "interrupted" => ev.status = ToolEventStatus::Interrupted,
            "completed" => {
                let code = r.error_code.as_deref();
                ev.status = if matches!(code, Some("cancelled") | Some("revoked")) {
                    ToolEventStatus::Cancelled
                } else if r.result_status.as_deref() == Some("error") {
                    ToolEventStatus::Failed
                } else {
                    ToolEventStatus::Completed
                };
                ev.result_status = r.result_status.clone();
                ev.error_code = r.error_code.clone();
                ev.truncated = r
                    .truncation
                    .get("truncated")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                ev.truncation_reasons = r
                    .truncation
                    .get("reasons")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                ev.redacted = r
                    .redaction
                    .get("redacted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                ev.redaction_kinds = r
                    .redaction
                    .get("kinds")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                ev.output_digest = r.output_digest.clone();
                ev.output_bytes = r.output_bytes;
                ev.stats = if r.stats.is_null() {
                    None
                } else {
                    Some(r.stats.clone())
                };
                if !r.args.is_null() {
                    ev.args = r.args.clone();
                }
            }
            _ => {}
        }
        if ev.args.is_null() && !r.args.is_null() {
            ev.args = r.args.clone();
        }
    }
    order.into_iter().filter_map(|k| by.remove(&k)).collect()
}

/// Fold journal entries directly (in-process callers and tests).
pub fn tool_events_from_journal(entries: &[ToolJournalEntry]) -> Vec<ToolEventV1> {
    let recs: Vec<ToolRecordV1> = entries.iter().map(record_from_entry).collect();
    fold_tool_records(&recs)
}

impl ToolEventV1 {
    /// A request journaled as started with no completion is interrupted.
    pub fn mark_interrupted_if_open(mut self) -> Self {
        if matches!(
            self.status,
            ToolEventStatus::Started
                | ToolEventStatus::Planned
                | ToolEventStatus::Prepared
                | ToolEventStatus::Running
        ) {
            self.status = ToolEventStatus::Interrupted;
        }
        self
    }
}
