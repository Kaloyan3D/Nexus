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
}
