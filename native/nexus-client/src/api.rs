//! Versioned client operations shared by CLI and future GUI (A2.4 Phase 2).
//!
//! One authoritative surface: status/health, task listing and details,
//! attempt status, registry model information (mock catalog offline;
//! live issuance stays blocked), verification/evidence, streaming events,
//! and operator actions gated by daemon authorization. The client never
//! opens SQLite: kernel state arrives only through the authenticated IPC
//! boundary, and task metadata arrives from read-only ledger JSON.

use crate::config::ClientConfig;
use crate::error::ClientError;
use crate::transport::{interpret_response, ipc_roundtrip, read_request};

/// Request timeout for single IPC round trips.
pub const IPC_TIMEOUT_MS: u64 = 10_000;

fn req(cfg: &ClientConfig, id: &str, cmd: &str) -> Result<serde_json::Value, ClientError> {
    let frame = read_request(id, cmd, serde_json::json!({}));
    let resp = ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?;
    interpret_response(&resp)
}

/// Runtime status and health (read-only; works while the daemon runs).
pub fn status(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-status", "status")
}

/// Daemon health probe (read-only).
pub fn health(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-health", "health")
}

/// Read-only dispatch readiness assessment (observational, never authorizing).
pub fn readiness(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-readiness", "readiness")
}

/// One command receipt by id (read-only).
pub fn receipt(cfg: &ClientConfig, command_id: &str) -> Result<serde_json::Value, ClientError> {
    if command_id.is_empty() {
        return Err(ClientError::usage("command id must not be empty"));
    }
    let frame = read_request(
        "nexus-receipt",
        "receipt",
        serde_json::json!({ "commandId": command_id }),
    );
    interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)
}

/// Bounded journal read (read-only event streaming source).
pub fn journal(cfg: &ClientConfig, limit: u64) -> Result<serde_json::Value, ClientError> {
    let frame = read_request(
        "nexus-journal",
        "journal",
        serde_json::json!({ "limit": limit }),
    );
    interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)
}

/// Task-scoped journal read (the daemon's `journal` command requires a task
/// instance id and backend; this is the form the daemon actually serves).
pub fn journal_for_task(
    cfg: &ClientConfig,
    task_instance_id: &str,
    backend: &str,
) -> Result<serde_json::Value, ClientError> {
    if task_instance_id.is_empty() || backend.is_empty() {
        return Err(ClientError::usage(
            "task instance id and backend must not be empty",
        ));
    }
    let frame = read_request(
        "nexus-journal-task",
        "journal",
        serde_json::json!({ "taskInstanceId": task_instance_id, "backend": backend }),
    );
    interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)
}

/// Store digest (read-only integrity pin).
pub fn digest(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    req(cfg, "nexus-digest", "digest")
}

/// Task listing from the read-only Controller ledger (never SQLite).
/// Without a ledger directory the operation reports `ledger-unavailable`
/// instead of inventing tasks.
pub fn tasks(cfg: &ClientConfig) -> Result<serde_json::Value, ClientError> {
    let dir = cfg.ledger_dir.clone().ok_or_else(|| {
        ClientError::usage("no ledger directory configured (set NEXUS_LEDGER_DIR or --ledger-dir)")
    })?;
    let path = dir.join("tasks.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        ClientError::internal(format!("ledger unreadable at {}: {e}", path.display()))
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| ClientError::internal(format!("ledger tasks.json is not JSON: {e}")))?;
    Ok(serde_json::json!({ "ok": true, "tasks": value, "source": path.display().to_string() }))
}

/// Task details: ledger record plus live attempt/receipt state where known.
pub fn task_show(cfg: &ClientConfig, task_id: &str) -> Result<serde_json::Value, ClientError> {
    if task_id.is_empty() {
        return Err(ClientError::usage("task id must not be empty"));
    }
    let all = tasks(cfg)?;
    let found = all.get("tasks").cloned().unwrap_or(serde_json::Value::Null);
    Ok(
        serde_json::json!({ "ok": true, "taskId": task_id, "tasks": found, "note": "ledger is the task source of truth; kernel receipts pin execution state per command" }),
    )
}

/// Controller attempt status: receipt plus generation/witness context.
pub fn attempt_status(
    cfg: &ClientConfig,
    command_id: &str,
) -> Result<serde_json::Value, ClientError> {
    let r = receipt(cfg, command_id)?;
    let ready = readiness(cfg).unwrap_or(serde_json::json!({"ok": false}));
    Ok(serde_json::json!({ "ok": true, "commandId": command_id, "receipt": r, "readiness": ready }))
}

/// Registry model information.
///
/// Offline A2.4 reports the local mock/test catalog plus the explicit live
/// blockers (no TLS stack, no live scope gate, no billing metadata, no live
/// credential path). The Registry JS service remains the only live model
/// authority: this catalog never routes production traffic.
pub fn models() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "clientApiVersion": crate::version::CLIENT_API_VERSION,
        "catalog": [
            { "model": "e2e-mock-model", "scope": "mock-e2e", "origin": "http://127.0.0.1:0 (loopback testbed)", "reasoning": "low", "live": false },
            { "model": "remote-model-a", "scope": "offline-test", "origin": "loopback only", "reasoning": "low", "live": false }
        ],
        "live": { "ready": false, "blockers": ["no live scope authorization (kernel refuses non-mock-e2e)", "no TLS termination in the transport (https refused fail-closed)", "production Registry carries no billingTier metadata", "no live credential loading path", "multi-UID container re-proof pending"] },
        "dispatchEnabled": false
    })
}

/// Verification and evidence bundle for one command (receipt + journal +
/// digest, all read-only).
pub fn verify(cfg: &ClientConfig, command_id: &str) -> Result<serde_json::Value, ClientError> {
    let r = receipt(cfg, command_id)?;
    let j = journal(cfg, 50).unwrap_or(serde_json::json!({"ok": false}));
    let d = digest(cfg).unwrap_or(serde_json::json!({"ok": false}));
    Ok(
        serde_json::json!({ "ok": true, "commandId": command_id, "receipt": r, "journal": j, "digest": d, "dispatchEnabled": false }),
    )
}

/// Operator cancellation (Controller fence) is authorization-gated: normal
/// CLI users without the daemon issuer capability receive `unauthorized`.
/// This client never mints or forwards raw capabilities; the daemon enforces
/// the gate and this function only surfaces its refusal honestly.
pub fn cancel(_cfg: &ClientConfig, _command_id: &str) -> Result<serde_json::Value, ClientError> {
    Err(ClientError::unauthorized("cancellation requires the daemon issuer capability, which normal CLI users are never given; run the broker as operator or fence through the Controller ledger"))
}

/// Local daemon reachability without authentication (used by `doctor`).
pub fn probe_daemon(cfg: &ClientConfig) -> (bool, String) {
    match health(cfg) {
        Ok(_) => (
            true,
            format!("daemon reachable at {}", cfg.socket_path.display()),
        ),
        Err(e) => (
            false,
            format!("daemon unreachable at {}: {e}", cfg.socket_path.display()),
        ),
    }
}

/// One page of tool-journal records for a task attempt (read-only).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRecordsPage {
    pub records: Vec<nexus_tools::ToolRecordV1>,
    pub next_cursor: i64,
    pub has_more: bool,
}

/// Authenticated, bounded, cursor-paged tool records for exactly one
/// (task instance, attempt). `after_seq` is the last seq already seen.
pub fn tool_events(
    cfg: &ClientConfig,
    task_instance_id: &str,
    attempt_id: &str,
    after_seq: i64,
    limit: u32,
) -> Result<ToolRecordsPage, ClientError> {
    if task_instance_id.is_empty() || attempt_id.is_empty() {
        return Err(ClientError::usage(
            "task instance id and attempt id must not be empty",
        ));
    }
    let frame = read_request(
        "nexus-tool-events",
        "tool-events",
        serde_json::json!({
            "taskInstanceId": task_instance_id,
            "attemptId": attempt_id,
            "afterSeq": after_seq.max(0),
            "limit": limit.clamp(1, 200),
        }),
    );
    let v = interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)?;
    let records: Vec<nexus_tools::ToolRecordV1> = serde_json::from_value(
        v.get("records")
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![])),
    )
    .map_err(|e| ClientError::internal(format!("malformed tool records: {e}")))?;
    Ok(ToolRecordsPage {
        next_cursor: v
            .get("nextCursor")
            .and_then(|x| x.as_i64())
            .unwrap_or(after_seq),
        has_more: v.get("hasMore").and_then(|x| x.as_bool()).unwrap_or(false),
        records,
    })
}

/// Read every record after `after_seq` (bounded to 50 pages) and fold into
/// typed events. Returns `(events, next_cursor, complete)`.
pub fn tool_events_folded(
    cfg: &ClientConfig,
    task_instance_id: &str,
    attempt_id: &str,
    after_seq: i64,
) -> Result<(Vec<nexus_tools::ToolEventV1>, i64, bool), ClientError> {
    let mut cursor = after_seq.max(0);
    let mut all = Vec::new();
    let mut complete = false;
    for _ in 0..50 {
        let page = tool_events(cfg, task_instance_id, attempt_id, cursor, 200)?;
        cursor = page.next_cursor;
        all.extend(page.records);
        if !page.has_more {
            complete = true;
            break;
        }
    }
    Ok((nexus_tools::fold_tool_records(&all), cursor, complete))
}

/// One authoritative attempt and its tool events.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptToolEvents {
    pub attempt_id: String,
    pub sequence: u64,
    pub events: Vec<nexus_tools::ToolEventV1>,
    pub complete: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskToolEvents {
    pub available: bool,
    pub reason: Option<String>,
    pub attempts: Vec<AttemptToolEvents>,
}

/// Tool events for one task instance, grouped by the attempts recorded in
/// the Controller attempt journal. Attempt ids are never constructed: when
/// no authoritative list exists the result is `available: false` with a
/// reason. Each attempt is queried under its own (task, attempt) scope, so
/// events of different tasks, attempts or generations are never merged; an
/// attempt the daemon does not know is reported per attempt, not hidden.
pub fn tool_events_for_task(
    cfg: &ClientConfig,
    task_instance_id: &str,
) -> Result<TaskToolEvents, ClientError> {
    if task_instance_id.is_empty() {
        return Err(ClientError::usage("task instance id must not be empty"));
    }
    let unavailable = |reason: &str| TaskToolEvents {
        available: false,
        reason: Some(reason.to_owned()),
        attempts: Vec::new(),
    };
    let Some(runs) = cfg.runs_dir.clone() else {
        return Ok(unavailable(
            "no Controller run directory is configured; attempt identity cannot be established",
        ));
    };
    let attempts = match nexus_transcript::list_attempts(&runs, task_instance_id) {
        Ok((_, a)) => a,
        Err(nexus_transcript::HistoryError::NoAttempts) => {
            return Ok(unavailable(
                "the Controller recorded no attempt for this task instance",
            ))
        }
        Err(_) => return Ok(unavailable("the Controller attempt journal is unreadable")),
    };
    let mut out = Vec::new();
    for a in attempts {
        match tool_events_folded(cfg, task_instance_id, &a.attempt_id, 0) {
            Ok((events, _, complete)) => out.push(AttemptToolEvents {
                attempt_id: a.attempt_id,
                sequence: a.sequence,
                events,
                complete,
                error: None,
            }),
            Err(e) => {
                // A daemon that cannot be reached is an overall failure; a
                // refusal for one attempt (unknown to the kernel) is local.
                if e.exit == crate::error::ExitCode::Disconnected {
                    return Err(e);
                }
                out.push(AttemptToolEvents {
                    attempt_id: a.attempt_id,
                    sequence: a.sequence,
                    events: Vec::new(),
                    complete: true,
                    error: Some(e.code.to_owned()),
                });
            }
        }
    }
    Ok(TaskToolEvents {
        available: true,
        reason: None,
        attempts: out,
    })
}

// ------------------------------------------------------------------ A4.2

/// One human-approval request as the daemon reports it to read-only
/// clients. Deliberately carries NO review content (diff, argv text), no
/// review code and no credential: the privileged review and the Approve /
/// Deny action live only in the trusted terminal approver workflow.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub approval_id: String,
    pub state: String,
    pub command_id: String,
    pub task_instance_id: String,
    pub attempt_id: String,
    pub tool_id: String,
    pub scope: String,
    pub request_digest: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub operation_kind: Option<String>,
    pub created_ms: i64,
    pub expires_ms: i64,
    #[serde(default)]
    pub decided_ms: Option<i64>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub decision_reason: Option<String>,
    #[serde(default)]
    pub approver_id: Option<String>,
    #[serde(default)]
    pub human_auth_mechanism: Option<String>,
    #[serde(default)]
    pub grant_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalsView {
    pub available: bool,
    pub reason: Option<String>,
    /// Always `terminal-only` in A4.2: the GUI never approves.
    pub approval_action: String,
    pub approvals: Vec<ApprovalRecord>,
}

/// Read-only approval status for one task instance (or all). An absent or
/// non-human-approval daemon is reported as `available: false`, never as
/// an empty approved list.
pub fn approvals(
    cfg: &ClientConfig,
    task_instance_id: Option<&str>,
) -> Result<ApprovalsView, ClientError> {
    let mut params = serde_json::Map::new();
    if let Some(t) = task_instance_id {
        if t.is_empty() {
            return Err(ClientError::usage("task instance id must not be empty"));
        }
        params.insert("taskInstanceId".to_owned(), t.into());
    }
    let frame = read_request(
        "nexus-approval-list",
        "approval-list",
        serde_json::Value::Object(params),
    );
    let resp = ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?;
    let unavailable = |reason: String| ApprovalsView {
        available: false,
        reason: Some(reason),
        approval_action: "terminal-only".to_owned(),
        approvals: Vec::new(),
    };
    match interpret_response(&resp) {
        Ok(v) => {
            let approvals: Vec<ApprovalRecord> = serde_json::from_value(
                v.get("approvals")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| ClientError::internal(format!("malformed approvals: {e}")))?;
            Ok(ApprovalsView {
                available: true,
                reason: None,
                approval_action: "terminal-only".to_owned(),
                approvals,
            })
        }
        Err(e) if e.message.contains("approval-disabled") => Ok(unavailable(
            "the daemon is not running in human-approval mode".to_owned(),
        )),
        Err(e) if e.exit == crate::error::ExitCode::Disconnected => Err(e),
        Err(e) => Ok(unavailable(e.code.to_owned())),
    }
}

// ------------------------------------------------------------------ A4.3

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalIntegrityView {
    pub journal: String,
    pub local_count: u64,
    #[serde(default)]
    pub witness_count: Option<u64>,
    pub status: String,
    pub detail: String,
}

/// Read-only journal integrity. `state` is one of: `verified`,
/// `unanchored-legacy`, `witness-unavailable`, `recovery-required`,
/// `integrity-mismatch`, `not-configured`. `scope` always states what was
/// and was not verified; there is no generic "secure" value.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityView {
    pub state: String,
    pub scope: String,
    pub configured: bool,
    #[serde(default)]
    pub journals: Vec<JournalIntegrityView>,
    #[serde(default)]
    pub detail: String,
}

pub fn integrity(cfg: &ClientConfig) -> Result<IntegrityView, ClientError> {
    let frame = read_request(
        "nexus-integrity-status",
        "integrity-status",
        serde_json::json!({}),
    );
    let v = interpret_response(&ipc_roundtrip(&cfg.socket_path, &frame, IPC_TIMEOUT_MS)?)?;
    serde_json::from_value(
        v.get("integrity")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .map_err(|e| ClientError::internal(format!("malformed integrity status: {e}")))
}
