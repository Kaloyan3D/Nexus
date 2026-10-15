//! Pure adapter logic over nexus-client v1. No Tauri types: unit-testable
//! without a window. All daemon input is validated and fails closed.

use crate::dto::*;
use nexus_client as nc;
use serde_json::Value;

const MAX_DESCRIPTION_CHARS: usize = 20_000;
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_PAYLOAD_CHARS: usize = 600;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn ui_error(e: &nc::ClientError) -> UiError {
    UiError {
        code: e.code.to_owned(),
        message: e.message.clone(),
    }
}

pub fn app_info(cfg: &nc::ClientConfig) -> AppInfo {
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        client_api_version: nc::CLIENT_API_VERSION,
        ipc_protocol: nc::IPC_PROTOCOL_VERSION,
        platform: std::env::consts::OS.to_owned(),
        socket_path: cfg.socket_path.display().to_string(),
        ledger_dir: cfg.ledger_dir.as_ref().map(|p| p.display().to_string()),
        // Pinned: the GUI never reports live as available.
        dispatch_enabled: false,
        live_ready: false,
    }
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// Validate and normalize a daemon `status` response (fail closed).
pub fn snapshot_from_status(
    status: &Value,
    readiness: Option<&Value>,
    now: u64,
) -> RuntimeSnapshot {
    let malformed = |why: &str| {
        RuntimeSnapshot::empty(
            Connection::Malformed,
            Some(format!("daemon response rejected: {why}")),
            now,
        )
    };
    if let Some(p) = status.get("protocol") {
        if p.as_u64() != Some(u64::from(nc::IPC_PROTOCOL_VERSION)) {
            return malformed("IPC protocol version mismatch");
        }
    }
    let Some(state) = str_of(status, "state") else {
        return malformed("missing state");
    };
    let Some(dispatch) = status.get("dispatchEnabled").and_then(|v| v.as_bool()) else {
        return malformed("missing dispatchEnabled");
    };
    let mut snap = RuntimeSnapshot::empty(Connection::Connected, None, now);
    snap.state = Some(state);
    snap.dispatch_enabled = Some(dispatch);
    if dispatch {
        snap.connection = Connection::Unsafe;
        snap.detail = Some(
            "daemon reports dispatch enabled; Nexus refuses to treat this runtime as safe"
                .to_owned(),
        );
    }
    snap.trust_mode = str_of(status, "trustMode");
    snap.incarnation = str_of(status, "incarnation");
    snap.accepted_commands = status.get("acceptedCommands").and_then(|v| v.as_u64());
    snap.total_commands = status.get("totalCommands").and_then(|v| v.as_u64());
    snap.event_count = status.get("eventCount").and_then(|v| v.as_u64());
    snap.witness_configured = status
        .pointer("/witness/configured")
        .and_then(|v| v.as_bool());
    snap.witness_present = status.pointer("/witness/present").and_then(|v| v.as_bool());
    snap.reconciliation_required = status
        .get("reconciliationRequired")
        .and_then(|v| v.as_bool());
    snap.peer_uid_enforced = status.get("peerUidEnforced").and_then(|v| v.as_bool());
    snap.socket_shared = status.get("socketShared").and_then(|v| v.as_bool());
    snap.started_at_utc = str_of(status, "startedAtUtc");
    snap.active_clients = status.get("activeClients").and_then(|v| v.as_u64());
    snap.requests = status.get("requests").and_then(|v| v.as_u64());
    snap.refusals = status.get("refusals").and_then(|v| v.as_u64());
    snap.errors = status.get("errors").and_then(|v| v.as_u64());
    if let Some(r) = readiness {
        snap.readiness_verdict = r
            .pointer("/readiness/verdict")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        if let Some(dims) = r
            .pointer("/readiness/dimensions")
            .and_then(|v| v.as_array())
        {
            snap.readiness_dimensions = dims
                .iter()
                .filter_map(|d| {
                    Some(ReadinessDimension {
                        name: str_of(d, "name")?,
                        ready: d.get("ready")?.as_bool()?,
                        detail: str_of(d, "detail").unwrap_or_default(),
                    })
                })
                .collect();
        }
    }
    snap
}

pub fn runtime_status(cfg: &nc::ClientConfig) -> RuntimeSnapshot {
    let now = now_ms();
    match nc::status(cfg) {
        Ok(status) => {
            let readiness = nc::readiness(cfg).ok();
            snapshot_from_status(&status, readiness.as_ref(), now)
        }
        Err(e) => {
            let conn = match e.code {
                "disconnected" => Connection::Disconnected,
                "unauthorized" => Connection::Unauthorized,
                _ => Connection::Error,
            };
            RuntimeSnapshot::empty(conn, Some(e.message), now)
        }
    }
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Title derived from the first meaningful description line (the ledger has
/// no title field); markdown heading markers are stripped.
pub fn derive_title(description: &str) -> String {
    for line in description.lines() {
        let t = line.trim().trim_start_matches('#').trim();
        if !t.is_empty() {
            let mut out: String = t.chars().take(120).collect();
            if t.chars().count() > 120 {
                out.push('…');
            }
            return out;
        }
    }
    "(no description)".to_owned()
}

fn outcome_of(v: &Value) -> VerificationOutcome {
    if let Some(s) = v.as_str() {
        return VerificationOutcome {
            name: s.to_owned(),
            status: "unknown".to_owned(),
            raw: s.to_owned(),
        };
    }
    let name = ["name", "id", "check", "command", "kind"]
        .iter()
        .find_map(|k| str_of(v, k))
        .unwrap_or_else(|| "check".to_owned());
    let raw = ["status", "result", "outcome", "verdict"]
        .iter()
        .find_map(|k| str_of(v, k))
        .or_else(|| {
            v.get("passed")
                .and_then(|p| p.as_bool())
                .map(|p| p.to_string())
        })
        .unwrap_or_default();
    let low = raw.to_lowercase();
    let status = if matches!(low.as_str(), "pass" | "passed" | "ok" | "success" | "true") {
        "pass"
    } else if matches!(low.as_str(), "fail" | "failed" | "error" | "false") {
        "fail"
    } else {
        "unknown"
    };
    VerificationOutcome {
        name,
        status: status.to_owned(),
        raw,
    }
}

fn scrub(text: &str) -> String {
    nc::transcript::redact::redact_text(text).0
}

pub fn normalize_task(v: &Value) -> Option<TaskDto> {
    let task_id = str_of(v, "taskId")?;
    // Ledger text is user-authored and may carry pasted credentials.
    let description = scrub(&str_of(v, "description").unwrap_or_default());
    let truncated = description.chars().count() > MAX_DESCRIPTION_CHARS;
    let desc_out: String = description.chars().take(MAX_DESCRIPTION_CHARS).collect();
    let worktree = v
        .get("worktree")
        .and_then(|w| w.as_str().map(str::to_owned).or_else(|| str_of(w, "path")));
    Some(TaskDto {
        task_id,
        task_instance_id: str_of(v, "taskInstanceId"),
        title: derive_title(&description),
        description: desc_out,
        description_truncated: truncated,
        status: str_of(v, "status").unwrap_or_else(|| "unknown".to_owned()),
        bound_engine: str_of(v, "boundEngine"),
        execution_class: str_of(v, "executionClass"),
        risk: str_of(v, "risk"),
        attempt: v.get("attempt").and_then(|x| x.as_u64()),
        max_attempts: v.get("maxAttempts").and_then(|x| x.as_u64()),
        base_commit: str_of(v, "baseCommit"),
        worktree,
        created_at_utc: str_of(v, "createdAtUtc"),
        updated_at_utc: str_of(v, "updatedAtUtc"),
        completed_at_utc: str_of(v, "completedAtUtc"),
        acceptance_criteria: string_list(v.get("acceptanceCriteria"))
            .iter()
            .map(|c| scrub(c))
            .collect(),
        dependencies: string_list(v.get("dependencies")),
        verification_required: string_list(v.pointer("/verification/required")),
        verification_outcomes: v
            .pointer("/verification/outcomes")
            .and_then(|o| o.as_array())
            .map(|a| a.iter().map(outcome_of).collect())
            .unwrap_or_default(),
        failure_signatures: string_list(v.get("failureSignatures"))
            .iter()
            .map(|c| scrub(c))
            .collect(),
    })
}

pub fn tasks_from_ledger(resp: &Value) -> Result<Vec<TaskDto>, String> {
    let root = resp.get("tasks").ok_or("ledger response has no tasks")?;
    let list = root
        .get("tasks")
        .and_then(|t| t.as_array())
        .or_else(|| root.as_array())
        .ok_or("ledger tasks.json has no task array")?;
    let mut out: Vec<TaskDto> = list.iter().filter_map(normalize_task).collect();
    out.sort_by(|a, b| b.updated_at_utc.cmp(&a.updated_at_utc));
    Ok(out)
}

pub fn list_tasks(cfg: &nc::ClientConfig) -> TasksDto {
    match nc::tasks(cfg) {
        Ok(resp) => match tasks_from_ledger(&resp) {
            Ok(tasks) => TasksDto {
                available: true,
                source: str_of(&resp, "source"),
                error: None,
                tasks,
            },
            Err(e) => TasksDto {
                available: false,
                source: str_of(&resp, "source"),
                error: Some(e),
                tasks: Vec::new(),
            },
        },
        Err(e) => TasksDto {
            available: false,
            source: None,
            error: Some(e.message),
            tasks: Vec::new(),
        },
    }
}

/// Task instance ids are `task_` + 32 lowercase hex; anything else is refused
/// before it can reach the daemon frame.
pub fn valid_instance_id(id: &str) -> bool {
    id.len() == 37
        && id.starts_with("task_")
        && id[5..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn journal_from_response(resp: &Value) -> JournalDto {
    let events = resp
        .get("events")
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .map(|e| JournalEvent {
                    seq: e.get("seq").and_then(|s| s.as_i64()).unwrap_or(-1),
                    kind: str_of(e, "kind").unwrap_or_else(|| "unknown".to_owned()),
                    command_id: str_of(e, "commandId"),
                    recorded_at_utc: str_of(e, "recordedAtUtc"),
                    payload: e
                        .get("payload")
                        .map(|p| p.to_string().chars().take(MAX_PAYLOAD_CHARS).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    JournalDto {
        events,
        receipt_count: resp
            .get("receipts")
            .and_then(|r| r.as_array())
            .map(|a| a.len() as u64)
            .unwrap_or(0),
        truncated: resp
            .get("truncated")
            .and_then(|t| t.as_bool())
            .unwrap_or(false),
    }
}

pub fn task_journal(cfg: &nc::ClientConfig, task_instance_id: &str) -> Result<JournalDto, UiError> {
    if !valid_instance_id(task_instance_id) {
        return Err(UiError {
            code: "bad-usage".to_owned(),
            message: "task instance id is malformed".to_owned(),
        });
    }
    nc::journal_for_task(cfg, task_instance_id, "native")
        .map(|r| journal_from_response(&r))
        .map_err(|e| ui_error(&e))
}

/// Read-only tool events for a task instance, grouped by the attempts the
/// Controller attempt journal records. The renderer never supplies (or
/// guesses) an attempt id and never executes tools.
pub fn tool_events(
    cfg: &nc::ClientConfig,
    task_instance_id: &str,
) -> Result<nc::TaskToolEvents, UiError> {
    if !valid_instance_id(task_instance_id) {
        return Err(UiError {
            code: "bad-usage".to_owned(),
            message: "task instance id is malformed".to_owned(),
        });
    }
    nc::tool_events_for_task(cfg, task_instance_id).map_err(|e| ui_error(&e))
}

pub fn model_catalog() -> ModelCatalog {
    let m = nc::models();
    let entries = m
        .get("catalog")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .map(|e| CatalogEntry {
                    model: str_of(e, "model").unwrap_or_default(),
                    scope: str_of(e, "scope").unwrap_or_default(),
                    origin: str_of(e, "origin").unwrap_or_default(),
                    reasoning: str_of(e, "reasoning").unwrap_or_default(),
                    live: e.get("live").and_then(|l| l.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    ModelCatalog {
        source: "offline-mock-catalog".to_owned(),
        entries,
        live_ready: false,
        blockers: string_list(m.pointer("/live/blockers")),
        dispatch_enabled: false,
    }
}

pub fn live_blockers() -> LiveBlockers {
    let b = nc::live_blockers();
    LiveBlockers {
        ready: false,
        dispatch_enabled: false,
        blockers: string_list(b.get("blockers")),
    }
}

const MAX_PAGE_LIMIT: u32 = 500;

pub fn conversation_read(
    cfg: &nc::ClientConfig,
    task_instance_id: &str,
    after_seq: Option<u64>,
    before_seq: Option<u64>,
    limit: Option<u32>,
) -> Result<nc::ConversationView, UiError> {
    let spec = nc::transcript::PageSpec {
        after_seq,
        before_seq,
        limit: limit.unwrap_or(200).clamp(1, MAX_PAGE_LIMIT),
    };
    nc::conversation(cfg, task_instance_id, spec).map_err(|e| ui_error(&e))
}

pub fn model_io_read(
    cfg: &nc::ClientConfig,
    task_instance_id: &str,
) -> Result<nc::ModelIoView, UiError> {
    nc::model_io(cfg, task_instance_id).map_err(|e| ui_error(&e))
}

pub fn validate_prompt(prompt: &str) -> Result<(), UiError> {
    if prompt.trim().is_empty() {
        return Err(UiError {
            code: "bad-usage".to_owned(),
            message: "prompt must not be empty".to_owned(),
        });
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(UiError {
            code: "bad-usage".to_owned(),
            message: format!("prompt exceeds {MAX_PROMPT_CHARS} characters"),
        });
    }
    Ok(())
}

/// Run the isolated mock workflow, forwarding ordered events to `emit`.
pub fn run_mock(
    cfg: &nc::ClientConfig,
    run_id: &str,
    prompt: &str,
    emit: &mut dyn FnMut(MockEvent),
) -> Result<MockResult, UiError> {
    validate_prompt(prompt)?;
    let started = std::time::Instant::now();
    emit(MockEvent::Started {
        run_id: run_id.to_owned(),
    });
    // Recorded at the execution boundary by the backend; the renderer only
    // receives a copy of the stream and can never write transcript records.
    let (report, conversation_id) = nc::run_mock_recorded(cfg, prompt, &mut |p| match p {
        nc::MockProgress::Step { id, label } => emit(MockEvent::Step { id, label }),
        nc::MockProgress::Stream(s) => emit(MockEvent::Stream {
            index: s.index,
            kind: s.kind,
            content: s.content,
        }),
        nc::MockProgress::Conversation { id } => emit(MockEvent::Conversation {
            conversation_id: id,
        }),
    })
    .map_err(|e| ui_error(&e))?;
    Ok(MockResult {
        conversation_id,
        run_id: run_id.to_owned(),
        mock: true,
        text: report.text,
        attempt_id: report.attempt_id,
        command_id: report.command_id,
        request_digest: report.request_digest,
        finish_reason: report.finish_reason,
        usage_input: report.usage_in,
        usage_output: report.usage_out,
        checks: report
            .checks
            .into_iter()
            .map(|c| MockCheckDto {
                id: c.id,
                label: c.label,
                status: c.status,
                detail: c.detail,
            })
            .collect(),
        event_count: report.events.len() as u64,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good_status() -> Value {
        json!({"ok": true, "protocol": 1, "state": "ready", "dispatchEnabled": false,
               "trustMode": "shadow", "acceptedCommands": 2, "totalCommands": 3, "eventCount": 9,
               "witness": {"configured": true, "present": true}})
    }

    #[test]
    fn valid_status_is_connected() {
        let s = snapshot_from_status(&good_status(), None, 1);
        assert_eq!(s.connection, Connection::Connected);
        assert_eq!(s.accepted_commands, Some(2));
        assert_eq!(s.witness_present, Some(true));
    }

    #[test]
    fn missing_fields_fail_closed() {
        let s = snapshot_from_status(&json!({"ok": true, "protocol": 1}), None, 1);
        assert_eq!(s.connection, Connection::Malformed);
        assert!(s.state.is_none());
        let s = snapshot_from_status(&json!({"state": "ready"}), None, 1);
        assert_eq!(s.connection, Connection::Malformed);
    }

    #[test]
    fn wrong_protocol_is_rejected() {
        let mut v = good_status();
        v["protocol"] = json!(2);
        assert_eq!(
            snapshot_from_status(&v, None, 1).connection,
            Connection::Malformed
        );
    }

    #[test]
    fn dispatch_enabled_is_unsafe() {
        let mut v = good_status();
        v["dispatchEnabled"] = json!(true);
        assert_eq!(
            snapshot_from_status(&v, None, 1).connection,
            Connection::Unsafe
        );
    }

    #[test]
    fn app_info_pins_live_off() {
        let cfg = nc::ClientConfig::resolve(Some("/x.sock".into()), None, false).unwrap();
        let i = app_info(&cfg);
        assert!(!i.dispatch_enabled && !i.live_ready);
    }

    #[test]
    fn disconnected_daemon_reports_disconnected_not_fabricated() {
        let cfg =
            nc::ClientConfig::resolve(Some("/nonexistent/nexus.sock".into()), None, false).unwrap();
        let s = runtime_status(&cfg);
        assert_eq!(s.connection, Connection::Disconnected);
        assert!(s.state.is_none() && s.accepted_commands.is_none());
    }

    #[test]
    fn ledger_normalization_and_title() {
        let ledger = json!({"tasks": [
            {"taskId": "TASK-0001", "taskInstanceId": "task_0123456789abcdef0123456789abcdef",
             "description": "# Title here\n\nbody", "status": "ready", "attempt": 0, "maxAttempts": 3,
             "updatedAtUtc": "2026-01-01T00:00:00Z",
             "verification": {"required": ["unit"], "outcomes": [{"name": "unit", "status": "passed"}]}},
            {"taskId": "TASK-0002", "description": "x", "status": "failed", "updatedAtUtc": "2026-02-01T00:00:00Z"},
            {"noTaskId": true}
        ]});
        let t = tasks_from_ledger(&json!({"tasks": ledger})).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].task_id, "TASK-0002", "sorted by updated desc");
        assert_eq!(t[1].title, "Title here");
        assert_eq!(t[1].verification_outcomes[0].status, "pass");
    }

    #[test]
    fn ledger_text_is_redacted_before_reaching_the_renderer() {
        let v = json!({"taskId": "TASK-0003", "description": "# Fix\nuse api_key=abcdef1234567890 and Bearer zzzzzzzzzzzz1234",
            "acceptanceCriteria": ["password=hunter2hunter2"], "status": "ready"});
        let t = normalize_task(&v).unwrap();
        let blob = serde_json::to_string(&t).unwrap();
        for leak in ["abcdef1234567890", "zzzzzzzzzzzz1234", "hunter2hunter2"] {
            assert!(!blob.contains(leak), "{leak} leaked");
        }
        assert!(t.description.contains("[REDACTED:"));
    }

    #[test]
    fn missing_ledger_is_unavailable_not_empty_success() {
        let cfg = nc::ClientConfig::resolve(Some("/x.sock".into()), None, false).unwrap();
        // ledger_dir may come from the environment; force none for determinism
        let cfg = nc::ClientConfig {
            ledger_dir: None,
            ..cfg
        };
        let t = list_tasks(&cfg);
        assert!(!t.available && t.error.is_some() && t.tasks.is_empty());
    }

    #[test]
    fn instance_id_validation() {
        assert!(valid_instance_id("task_0123456789abcdef0123456789abcdef"));
        assert!(!valid_instance_id("task_0123"));
        assert!(!valid_instance_id("TASK-0001"));
        assert!(!valid_instance_id("task_0123456789ABCDEF0123456789abcdef"));
        let cfg = nc::ClientConfig::resolve(Some("/x.sock".into()), None, false).unwrap();
        assert!(task_journal(&cfg, "../etc/passwd").is_err());
    }

    #[test]
    fn prompt_validation() {
        assert!(validate_prompt("  ").is_err());
        assert!(validate_prompt(&"x".repeat(MAX_PROMPT_CHARS + 1)).is_err());
        assert!(validate_prompt("Привет, Nova").is_ok());
    }

    #[test]
    fn mock_run_emits_ordered_events_and_real_checks() {
        let mut events: Vec<MockEvent> = Vec::new();
        let d = tempfile::tempdir().unwrap();
        let mut cfg = nc::ClientConfig::resolve(Some("/x.sock".into()), None, false).unwrap();
        cfg.transcript_dir = d.path().join("t");
        let r = run_mock(&cfg, "mock-1", "Тест native runtime", &mut |e| {
            events.push(e)
        })
        .unwrap();
        assert!(r.conversation_id.starts_with("mock_"));
        assert!(r.mock && !r.text.is_empty());
        assert!(matches!(events.first(), Some(MockEvent::Started { .. })));
        assert!(r.checks.iter().all(|c| c.status == "pass"));
        let idx: Vec<u64> = events
            .iter()
            .filter_map(|e| match e {
                MockEvent::Stream { index, .. } => Some(*index),
                _ => None,
            })
            .collect();
        assert!(idx.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn catalog_is_labelled_offline() {
        let c = model_catalog();
        assert_eq!(c.source, "offline-mock-catalog");
        assert!(!c.live_ready && !c.dispatch_enabled && c.entries.iter().all(|e| !e.live));
    }
}
