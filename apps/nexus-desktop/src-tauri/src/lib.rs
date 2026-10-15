//! Nexus desktop Tauri shell (A2.5). Thin typed command layer over
//! `nexus-client` v1. The renderer never gets filesystem, shell, HTTP or
//! credential access: it can only call the commands registered below, which
//! are mirrored 1:1 by `build.rs` and `capabilities/main.json`.

mod backend;
mod dto;

use dto::*;
use nexus_client::ClientConfig;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::ipc::Channel;

struct AppState {
    cfg: ClientConfig,
    mock_running: AtomicBool,
    mock_counter: AtomicU64,
}

/// Released on drop so a panic can never wedge the single-flight guard.
struct MockGuard<'a>(&'a AtomicBool);
impl Drop for MockGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    backend::app_info(&state.cfg)
}

#[tauri::command]
async fn runtime_status(state: tauri::State<'_, AppState>) -> Result<RuntimeSnapshot, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::runtime_status(&cfg))
        .await
        .map_err(|_| internal())
}

#[tauri::command]
async fn list_tasks(state: tauri::State<'_, AppState>) -> Result<TasksDto, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::list_tasks(&cfg))
        .await
        .map_err(|_| internal())
}

#[tauri::command]
async fn task_journal(
    state: tauri::State<'_, AppState>,
    task_instance_id: String,
) -> Result<JournalDto, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::task_journal(&cfg, &task_instance_id))
        .await
        .map_err(|_| internal())?
}

#[tauri::command]
async fn conversation_read(
    state: tauri::State<'_, AppState>,
    task_instance_id: String,
    after_seq: Option<u64>,
    before_seq: Option<u64>,
    limit: Option<u32>,
) -> Result<nexus_client::ConversationView, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend::conversation_read(&cfg, &task_instance_id, after_seq, before_seq, limit)
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn model_io_read(
    state: tauri::State<'_, AppState>,
    task_instance_id: String,
) -> Result<nexus_client::ModelIoView, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::model_io_read(&cfg, &task_instance_id))
        .await
        .map_err(|_| internal())?
}

#[tauri::command]
async fn list_mock_conversations(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<nexus_client::MockConversationSummary>, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || nexus_client::list_mock_conversations(&cfg))
        .await
        .map_err(|_| internal())
}

/// A5.1: read-only index of recorded model-only conversations.
#[tauri::command]
async fn list_model_conversations(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<nexus_client::ModelConversationSummary>, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || nexus_client::list_model_conversations(&cfg))
        .await
        .map_err(|_| internal())
}

/// A5.1: durable status of one model-only run, derived from the transcript.
#[tauri::command]
async fn model_run_status(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<nexus_client::ModelRunStatus, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::model_run_status(&cfg, &conversation_id).map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// A5.1: request cancellation of a model-only run. Fail-safe direction
/// only: writes a stop marker next to the transcript; grants nothing and
/// cannot start, resend or authorize anything.
#[tauri::command]
async fn cancel_model_run(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<(), UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::request_model_cancel(&cfg, &conversation_id)
            .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn tool_events(
    state: tauri::State<'_, AppState>,
    task_instance_id: String,
) -> Result<nexus_client::TaskToolEvents, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::tool_events(&cfg, &task_instance_id))
        .await
        .map_err(|_| internal())?
}

#[tauri::command]
async fn list_approvals(
    state: tauri::State<'_, AppState>,
    task_instance_id: String,
) -> Result<nexus_client::ApprovalsView, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::approvals(&cfg, &task_instance_id))
        .await
        .map_err(|_| internal())?
}

#[tauri::command]
async fn integrity_status(
    state: tauri::State<'_, AppState>,
) -> Result<nexus_client::IntegrityView, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || backend::integrity(&cfg))
        .await
        .map_err(|_| internal())?
}

#[tauri::command]
fn model_catalog() -> ModelCatalog {
    backend::model_catalog()
}

#[tauri::command]
fn live_blockers() -> LiveBlockers {
    backend::live_blockers()
}

#[tauri::command]
async fn run_mock(
    state: tauri::State<'_, AppState>,
    prompt: String,
    on_event: Channel<MockEvent>,
) -> Result<MockResult, UiError> {
    backend::validate_prompt(&prompt)?;
    if state
        .mock_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(UiError {
            code: "busy".to_owned(),
            message: "a mock run is already in progress".to_owned(),
        });
    }
    let n = state.mock_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let run_id = format!("mock-run-{n}");
    let flag = &state.mock_running;
    let _guard = MockGuard(flag);
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend::run_mock(&cfg, &run_id, &prompt, &mut |e| {
            // A closed channel just means the renderer went away.
            let _ = on_event.send(e);
        })
    })
    .await
    .map_err(|_| internal())?
}

fn internal() -> UiError {
    UiError {
        code: "internal".to_owned(),
        message: "background task failed".to_owned(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = ClientConfig::resolve(None, None, false).expect("client configuration");
    tauri::Builder::default()
        .manage(AppState {
            cfg,
            mock_running: AtomicBool::new(false),
            mock_counter: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            runtime_status,
            list_tasks,
            task_journal,
            model_catalog,
            live_blockers,
            run_mock,
            conversation_read,
            model_io_read,
            list_mock_conversations,
            list_model_conversations,
            model_run_status,
            cancel_model_run,
            tool_events,
            list_approvals,
            integrity_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}

#[cfg(test)]
mod authz_tests {
    //! The command allowlist, build.rs manifest and capability file must
    //! agree exactly, and the capability must grant nothing else.
    const COMMANDS: &[&str] = &[
        "app_info",
        "runtime_status",
        "list_tasks",
        "task_journal",
        "model_catalog",
        "live_blockers",
        "run_mock",
        "conversation_read",
        "model_io_read",
        "list_mock_conversations",
        "list_model_conversations",
        "model_run_status",
        "cancel_model_run",
        "tool_events",
        "list_approvals",
        "integrity_status",
    ];

    #[test]
    fn capability_grants_exactly_registered_commands() {
        let raw = include_str!("../capabilities/main.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut granted: Vec<String> = v["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_owned())
            .collect();
        granted.sort();
        let mut expected: Vec<String> = COMMANDS
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-")))
            .collect();
        expected.sort();
        assert_eq!(granted, expected);
        assert!(granted.iter().all(|p| p.starts_with("allow-")));
    }

    #[test]
    fn build_manifest_matches_handler_list() {
        let build = include_str!("../build.rs");
        let src = include_str!("lib.rs");
        for c in COMMANDS {
            assert!(build.contains(&format!("\"{c}\"")), "build.rs missing {c}");
            assert!(src.contains(&format!("            {c}")) || src.contains(&format!("fn {c}")));
        }
    }

    #[test]
    fn tauri_config_has_strict_csp_and_no_remote_urls() {
        let raw = include_str!("../tauri.conf.json");
        assert!(raw.contains("default-src 'self'"));
        assert!(raw.contains("object-src 'none'"));
        assert!(!raw.contains("'unsafe-eval'"));
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let csp = v["app"]["security"]["csp"].as_str().unwrap();
        assert!(
            !csp.contains("https:") && !csp.contains("http://")
                || csp.contains("http://ipc.localhost")
        );
        assert!(!csp.replace("http://ipc.localhost", "").contains("http://"));
    }

    /// A5.1: the renderer-facing model-run surface carries no credential,
    /// grant or issuer authority, and the backend never calls the executor.
    #[test]
    fn model_run_surface_exposes_no_credentials_or_authority() {
        let st = nexus_client::ModelRunStatus {
            conversation_id: "model_0123456789abcdef0123456789abcdef".into(),
            state: "completed".into(),
            terminal: true,
            provider_id: Some("p".into()),
            remote_model_id: Some("m".into()),
            logical_model_id: Some("l".into()),
            endpoint_kind: Some("provider".into()),
            attempt_id: Some("a".into()),
            command_id: Some("c".into()),
            request_digest: Some("d".into()),
            http_status: Some(200),
            usage_input_tokens: Some(1),
            usage_output_tokens: Some(2),
            finish_reason: Some("stop".into()),
            latency_ms: Some(3),
            error_code: None,
            cancel_requested: false,
            text: "hello".into(),
        };
        let v = serde_json::to_value(&st).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "attemptId", "cancelRequested", "commandId", "conversationId", "endpointKind",
            "errorCode", "finishReason", "httpStatus", "latencyMs", "logicalModelId",
            "providerId", "remoteModelId", "requestDigest", "state", "terminal", "text",
            "usageInputTokens", "usageOutputTokens",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected, "an exact, credential-free field set");
        let src = include_str!("lib.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").unwrap();
        for forbidden in [
            "run_model_only",
            "credentials_path",
            "cap_path",
            "model-redeem",
            "dispatch-authorize",
            "from_protected_file",
        ] {
            assert!(!prod.contains(forbidden), "Tauri backend must not reference {forbidden}");
        }
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        for p in cap["permissions"].as_array().unwrap() {
            let p = p.as_str().unwrap();
            assert!(p.starts_with("allow-"), "{p}");
            for bad in ["fs", "shell", "http", "opener", "process", "dialog"] {
                assert!(!p.contains(&format!("{bad}:")), "{p}");
            }
        }
    }
}
