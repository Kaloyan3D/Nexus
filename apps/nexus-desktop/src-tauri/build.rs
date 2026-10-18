// Application commands are an explicit allowlist: only the listed commands
// get `allow-*` permissions, and the capability file grants exactly those.
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
    "intent_models",
    "intent_submit",
    "intent_workspaces",
    "intent_inspect_submit",
    "intent_code_sources",
    "intent_code_limits",
    "intent_code_submit",
    "intent_diff",
    "intent_copy",
    "intent_status",
    "intent_cancel",
    "intent_list",
    "tool_events",
    "list_approvals",
    "integrity_status",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build failed");
}
