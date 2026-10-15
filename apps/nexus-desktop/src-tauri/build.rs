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
