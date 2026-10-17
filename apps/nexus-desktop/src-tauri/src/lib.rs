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
) -> Result<serde_json::Value, UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Model runs are read THROUGH THE BROKER (ownership-authorized,
        // transcript files stay issuer-private); everything else keeps the
        // historical local reader.
        nexus_client::desktop_contract::conversation_read(
            &cfg,
            &nexus_client::intent_client::default_broker_socket(),
            &task_instance_id,
            after_seq,
            before_seq,
            limit,
        )
        .map_err(|e| backend::ui_error(&e))
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
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::desktop_contract::list_model_conversations(
            &cfg,
            &nexus_client::intent_client::default_broker_socket(),
        )
    })
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
        nexus_client::desktop_contract::model_run_status(
            &cfg,
            &nexus_client::intent_client::default_broker_socket(),
            &conversation_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// Cancel a model-only run. Runs started through the intent broker are
/// cancelled through the broker (the authoritative path, same as
/// `nexus intent cancel`). Only when no broker run owns the conversation
/// (an operator-started `nexus model run`) does this fall back to the
/// fail-safe stop marker. Either way it can only STOP a run: it cannot
/// start, resend or authorize anything.
#[tauri::command]
async fn cancel_model_run(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<(), UiError> {
    let cfg = state.cfg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::desktop_contract::cancel_model_run(
            &cfg,
            &nexus_client::intent_client::default_broker_socket(),
            &conversation_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

// ---- A5.3: the SAME intent client the CLI uses (broker socket only) --------
// No capability, credential, grant or daemon socket is reachable from here:
// these commands only call `nexus_client::intent_client`.

#[tauri::command]
async fn intent_models() -> Result<Vec<nexus_client::intent_client::AllowedModel>, UiError> {
    tauri::async_runtime::spawn_blocking(|| {
        nexus_client::intent_client::models(&nexus_client::intent_client::default_broker_socket())
            .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// Submit one user-typed model-only intent. `idempotency_key` is generated
/// once per Send click by the UI so a duplicate click or a retried call can
/// never create a second billable attempt.
#[tauri::command]
async fn intent_submit(
    prompt: String,
    provider_id: Option<String>,
    remote_model_id: Option<String>,
    idempotency_key: String,
) -> Result<nexus_client::intent_client::SubmitReply, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        use nexus_client::intent_contract::{
            IntentLimits, ModelSelection, NexusIntentV1, ResponseMode,
        };
        let model = match (provider_id, remote_model_id) {
            (Some(p), Some(m)) => Some(ModelSelection {
                provider_id: p,
                remote_model_id: m,
            }),
            (None, None) => None,
            _ => {
                return Err(UiError {
                    code: "bad-usage".to_owned(),
                    message: "provider and model must be selected together".to_owned(),
                })
            }
        };
        let intent = NexusIntentV1 {
            schema_version: 1,
            request_id: nexus_client::intent_client::fresh_key("gui"),
            idempotency_key,
            intent_type: "model-only".to_owned(),
            content: prompt,
            model,
            workspace_id: None,
            limits: IntentLimits::default(),
            response_mode: ResponseMode::Stream,
            client_label: Some("nexus-desktop".to_owned()),
        };
        nexus_client::intent_client::submit(
            &nexus_client::intent_client::default_broker_socket(),
            &intent,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// A5.5: the operator-approved read-only workspaces this user may inspect
/// (identities only; the broker never returns a path).
#[tauri::command]
async fn intent_workspaces() -> Result<Vec<nexus_client::intent_client::AllowedWorkspace>, UiError>
{
    tauri::async_runtime::spawn_blocking(|| {
        nexus_client::intent_client::workspaces(
            &nexus_client::intent_client::default_broker_socket(),
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// A5.5: submit one user-typed READ-ONLY repository inspection. The renderer
/// supplies text, a workspace IDENTITY chosen from `intent_workspaces`, and an
/// idempotency key. It cannot name a path, a tool, a limit or a model.
#[tauri::command]
async fn intent_inspect_submit(
    prompt: String,
    workspace_id: String,
    idempotency_key: String,
) -> Result<nexus_client::intent_client::SubmitReply, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        use nexus_client::intent_contract::{IntentLimits, NexusIntentV1, ResponseMode};
        let intent = NexusIntentV1 {
            schema_version: 1,
            request_id: nexus_client::intent_client::fresh_key("gui"),
            idempotency_key,
            intent_type: "repo-inspect".to_owned(),
            content: prompt,
            model: None,
            workspace_id: Some(workspace_id),
            limits: IntentLimits {
                max_output_tokens: Some(1024),
                ..IntentLimits::default()
            },
            response_mode: ResponseMode::Stream,
            client_label: Some("nexus-desktop".to_owned()),
        };
        nexus_client::intent_client::submit(
            &nexus_client::intent_client::default_broker_socket(),
            &intent,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// A5.6: the operator-approved CODING sources (identities only). A right to
/// inspect never implies a right to modify; the broker lists them separately.
#[tauri::command]
async fn intent_code_sources(
) -> Result<Vec<nexus_client::intent_client::AllowedCodeSource>, UiError> {
    tauri::async_runtime::spawn_blocking(|| {
        nexus_client::intent_client::code_sources(
            &nexus_client::intent_client::default_broker_socket(),
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// A6.1: the fixed run limits a Desktop coding task uses (shown to the user
/// before submitting; not renderer-controlled).
#[tauri::command]
fn intent_code_limits() -> nexus_client::intent_client::DesktopCodeLimits {
    nexus_client::intent_client::DESKTOP_CODE_LIMITS
}

/// A5.6: submit one user-typed `repo-code` task. The renderer supplies text,
/// a source IDENTITY from `intent_code_sources` and an idempotency key - no
/// path, tool, command, limit, model or approval. The work happens in an
/// isolated copy; every edit and command still needs an independent approval
/// that this application cannot give.
#[tauri::command]
async fn intent_code_submit(
    prompt: String,
    source_id: String,
    idempotency_key: String,
) -> Result<nexus_client::intent_client::SubmitReply, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        use nexus_client::intent_contract::{NexusIntentV1, ResponseMode};
        let intent = NexusIntentV1 {
            schema_version: 1,
            request_id: nexus_client::intent_client::fresh_key("gui"),
            idempotency_key,
            intent_type: "repo-code".to_owned(),
            content: prompt,
            model: None,
            workspace_id: Some(source_id),
            limits: nexus_client::intent_client::DESKTOP_CODE_LIMITS.to_intent_limits(),
            response_mode: ResponseMode::Stream,
            client_label: Some("nexus-desktop".to_owned()),
        };
        nexus_client::intent_client::submit(
            &nexus_client::intent_client::default_broker_socket(),
            &intent,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// A5.6: the reviewable change set of one of this user's repo-code runs.
/// Read-only; nothing here can apply, commit or push it.
#[tauri::command]
async fn intent_diff(run_id: String) -> Result<nexus_client::intent_client::DiffReply, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::diff(
            &nexus_client::intent_client::default_broker_socket(),
            &run_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn intent_status(run_id: String) -> Result<nexus_client::intent_client::IntentRun, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::status(
            &nexus_client::intent_client::default_broker_socket(),
            &run_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn intent_cancel(
    run_id: String,
) -> Result<nexus_client::intent_client::CancelReply, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::cancel(
            &nexus_client::intent_client::default_broker_socket(),
            &run_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn intent_list() -> Result<Vec<nexus_client::intent_client::IntentRun>, UiError> {
    tauri::async_runtime::spawn_blocking(|| {
        nexus_client::intent_client::list(&nexus_client::intent_client::default_broker_socket(), 50)
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
            intent_models,
            intent_submit,
            intent_workspaces,
            intent_inspect_submit,
            intent_code_sources,
            intent_code_limits,
            intent_code_submit,
            intent_diff,
            intent_status,
            intent_cancel,
            intent_list,
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
        "intent_models",
        "intent_submit",
        "intent_workspaces",
        "intent_inspect_submit",
        "intent_code_sources",
        "intent_code_limits",
        "intent_code_submit",
        "intent_diff",
        "intent_status",
        "intent_cancel",
        "intent_list",
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
            first_token_ms: Some(2),
            provider_request_id: Some("req_x".into()),
            provider_response_id: Some("resp_x".into()),
            error_code: None,
            cancel_requested: false,
            text: "hello".into(),
        };
        let v = serde_json::to_value(&st).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "attemptId",
            "cancelRequested",
            "commandId",
            "conversationId",
            "endpointKind",
            "errorCode",
            "finishReason",
            "firstTokenMs",
            "httpStatus",
            "latencyMs",
            "logicalModelId",
            "providerId",
            "providerRequestId",
            "providerResponseId",
            "remoteModelId",
            "requestDigest",
            "state",
            "terminal",
            "text",
            "usageInputTokens",
            "usageOutputTokens",
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
            assert!(
                !prod.contains(forbidden),
                "Tauri backend must not reference {forbidden}"
            );
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

    /// A5.3: the renderer-facing intent commands go through the shared
    /// unprivileged intent client only; the backend links no path that reads
    /// an issuer capability, signs a daemon frame or opens a credential.
    #[test]
    fn intent_commands_use_only_the_unprivileged_broker_client() {
        let src = include_str!("lib.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").unwrap();
        assert!(prod.contains("intent_client::submit"));
        for forbidden in [
            "issuer::",
            "signed_frame",
            "read_capability",
            "issuer_call",
            "credentials",
            "from_protected_file",
            "run_model_only",
            "dispatch-authorize",
            "tool-execute",
        ] {
            assert!(
                !prod.contains(forbidden),
                "Tauri backend must not reference {forbidden}"
            );
        }
        // The submit command cannot carry anything but text + an explicit
        // provider/model pair + an idempotency key.
        assert!(prod.contains("fn intent_submit(\n    prompt: String,\n    provider_id: Option<String>,\n    remote_model_id: Option<String>,\n    idempotency_key: String,\n)"));
    }

    /// `NEXUS_BROKER_SOCKET` is process-global: the fake-broker tests must not
    /// overlap.
    static BROKER_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A5.5: the renderer can only pick a workspace IDENTITY from the broker's
    /// list and send text; the repo-inspect submit carries no path, tool,
    /// model, grant or loop-limit field of the renderer's choosing.
    #[test]
    fn desktop_repo_inspect_commands_carry_identities_never_paths_or_authority() {
        let _env = BROKER_ENV.lock().unwrap_or_else(|p| p.into_inner());
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("nexus-tauri-a55-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("broker.sock");
        let _ = std::fs::remove_file(&sock);
        let l = UnixListener::bind(&sock).unwrap();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let f2 = frames.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().take(2) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let v: serde_json::Value = serde_json::from_str(&line).unwrap();
                let cmd = v["cmd"].as_str().unwrap_or("").to_owned();
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let run = serde_json::json!({"runId":"run_00000000000000000000000000000000","requestId":"r","clientId":"uid:1","state":"preparing","terminal":false,"intentType":"repo-inspect","responseMode":"stream","cancelRequested":false,"createdAtMs":1,"updatedAtMs":1,"workspaceId":"demo"});
                let result = match cmd.as_str() {
                    "intent-submit" => serde_json::json!({"run": run, "replay": false}),
                    _ => serde_json::json!({"workspaces": [{"workspaceId": "demo"}]}),
                };
                let _ = s.write_all(
                    format!(
                        "{}\n",
                        serde_json::json!({"protocol":1,"id":rid,"ok":true,"result":result})
                    )
                    .as_bytes(),
                );
            }
        });
        std::env::set_var("NEXUS_BROKER_SOCKET", &sock);
        let ws = tauri::async_runtime::block_on(super::intent_workspaces()).unwrap();
        assert_eq!(ws[0].workspace_id, "demo");
        let r = tauri::async_runtime::block_on(super::intent_inspect_submit(
            "explain auth".into(),
            "demo".into(),
            "gui-0123456789abcdef".into(),
        ))
        .unwrap();
        assert!(!r.replay);
        let got = frames.lock().unwrap().clone();
        assert_eq!(got[0]["cmd"], "intent-workspaces");
        assert_eq!(got[1]["cmd"], "intent-submit");
        let i = got[1]["params"]["intent"].as_object().unwrap();
        let mut keys: Vec<&str> = i.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "clientLabel",
                "content",
                "idempotencyKey",
                "intentType",
                "limits",
                "model",
                "requestId",
                "responseMode",
                "schemaVersion",
                "workspaceId"
            ]
        );
        assert_eq!(i["intentType"], "repo-inspect");
        assert_eq!(i["workspaceId"], "demo");
        assert_eq!(i["limits"], serde_json::json!({"maxOutputTokens": 1024}));
        let wire = got[1].to_string();
        assert!(
            !wire.contains('/') || !wire.contains("etc"),
            "no path-like workspace"
        );
        let src = include_str!("lib.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").unwrap();
        for forbidden in [
            "fs_read",
            "fs_list",
            "fs_search",
            "fs.read",
            "toolPolicy",
            "workspace_root",
        ] {
            assert!(
                !prod.contains(forbidden),
                "Tauri backend must not reference {forbidden}"
            );
        }
        assert!(prod.contains("fn intent_inspect_submit(\n    prompt: String,\n    workspace_id: String,\n    idempotency_key: String,\n)"));
    }

    /// A5.6: the renderer picks a code SOURCE identity and sends text; it can
    /// never carry a path, tool, command, limit, approval or model, and the
    /// backend holds no approval authority at all.
    #[test]
    fn desktop_repo_code_commands_carry_identities_never_paths_or_authority() {
        let _env = BROKER_ENV.lock().unwrap_or_else(|p| p.into_inner());
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("nexus-tauri-a56-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("broker.sock");
        let _ = std::fs::remove_file(&sock);
        let l = UnixListener::bind(&sock).unwrap();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let f2 = frames.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().take(3) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
                let v: serde_json::Value = serde_json::from_str(&line).unwrap();
                let cmd = v["cmd"].as_str().unwrap_or("").to_owned();
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let run = serde_json::json!({"runId":"run_00000000000000000000000000000000","requestId":"r","clientId":"uid:1","state":"preparing","terminal":false,"intentType":"repo-code","responseMode":"stream","cancelRequested":false,"createdAtMs":1,"updatedAtMs":1,"workspaceId":"proj"});
                let result = match cmd.as_str() {
                    "intent-submit" => serde_json::json!({"run": run, "replay": false}),
                    "intent-diff" => serde_json::json!({"run": run, "baseCommit": "abc", "files": [{"path": "src/lib.rs", "status": "M", "additions": 1, "deletions": 1}], "filesTruncated": false, "diff": "--- a\n+++ b\n", "diffDigest": "d", "diffTruncated": false}),
                    _ => serde_json::json!({"sources": [{"sourceId": "proj"}]}),
                };
                let _ = s.write_all(format!("{}\n", serde_json::json!({"protocol":1,"id":rid,"ok":true,"result":result})).as_bytes());
            }
        });
        std::env::set_var("NEXUS_BROKER_SOCKET", &sock);
        let src = tauri::async_runtime::block_on(super::intent_code_sources()).unwrap();
        assert_eq!(src[0].source_id, "proj");
        // the limits shown to the user are the backend constants (no broker round trip)
        assert_eq!(super::intent_code_limits(), nexus_client::intent_client::DESKTOP_CODE_LIMITS);
        let r = tauri::async_runtime::block_on(super::intent_code_submit("fix the test".into(), "proj".into(), "gui-0123456789abcdef".into())).unwrap();
        assert!(!r.replay);
        let d = tauri::async_runtime::block_on(super::intent_diff(r.run.run_id.clone())).unwrap();
        assert_eq!(d.files[0].path, "src/lib.rs");
        let got = frames.lock().unwrap().clone();
        assert_eq!(got[0]["cmd"], "intent-code-sources");
        assert_eq!(got[1]["cmd"], "intent-submit");
        assert_eq!(got[2]["cmd"], "intent-diff");
        let i = got[1]["params"]["intent"].as_object().unwrap();
        let mut keys: Vec<&str> = i.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["clientLabel", "content", "idempotencyKey", "intentType", "limits", "model", "requestId", "responseMode", "schemaVersion", "workspaceId"]);
        assert_eq!(i["intentType"], "repo-code");
        assert_eq!(i["workspaceId"], "proj");
        assert_eq!(
            i["limits"],
            serde_json::to_value(nexus_client::intent_client::DESKTOP_CODE_LIMITS.to_intent_limits()).unwrap(),
            "limits are the fixed, backend-defined Desktop set (not renderer-controlled)"
        );
        assert_eq!(i["limits"]["maxEdits"], 5);
        assert_eq!(i["limits"]["maxTests"], 5);
        let src = include_str!("lib.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").unwrap();
        for forbidden in [
            "approval-decide", "approval-get", "approval-request", "approval-revoke", "approval_decide", "approvalDecide",
            "fs_write", "fs_edit", "proc_run", "fs.write", "fs.edit", "proc.run", "worktree", "git ", "Command::new",
            "std::process",
        ] {
            assert!(!prod.contains(forbidden), "Tauri backend must not reference {forbidden}");
        }
        assert!(prod.contains("fn intent_code_submit(\n    prompt: String,\n    source_id: String,\n    idempotency_key: String,\n)"));
    }

    /// A5.3: the Desktop's Send/cancel commands put exactly the documented
    /// broker verbs on the broker socket (the same wire the CLI uses) and
    /// nothing else. A recording fake broker captures the frames.
    #[test]
    fn desktop_intent_commands_speak_only_the_broker_protocol() {
        let _env = BROKER_ENV.lock().unwrap_or_else(|p| p.into_inner());
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("nexus-tauri-a53-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("broker.sock");
        let _ = std::fs::remove_file(&sock);
        let l = UnixListener::bind(&sock).unwrap();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let f2 = frames.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().take(3) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let v: serde_json::Value = serde_json::from_str(&line).unwrap();
                let cmd = v["cmd"].as_str().unwrap_or("").to_owned();
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let run = serde_json::json!({"runId":"run_00000000000000000000000000000000","requestId":"r","clientId":"uid:1","state":"preparing","terminal":false,"intentType":"model-only","responseMode":"stream","cancelRequested":false,"createdAtMs":1,"updatedAtMs":1});
                let result = match cmd.as_str() {
                    "intent-submit" => serde_json::json!({"run": run, "replay": false}),
                    "intent-cancel" => serde_json::json!({"run": run, "outcome": "requested"}),
                    _ => serde_json::json!({"models": []}),
                };
                let _ = s.write_all(
                    format!(
                        "{}\n",
                        serde_json::json!({"protocol":1,"id":rid,"ok":true,"result":result})
                    )
                    .as_bytes(),
                );
            }
        });
        std::env::set_var("NEXUS_BROKER_SOCKET", &sock);
        let r = tauri::async_runtime::block_on(super::intent_submit(
            "hello model".into(),
            Some("acme".into()),
            Some("acme-large-1".into()),
            "gui-0123456789abcdef".into(),
        ))
        .unwrap();
        assert!(!r.replay);
        tauri::async_runtime::block_on(super::intent_cancel(
            "run_00000000000000000000000000000000".into(),
        ))
        .unwrap();
        tauri::async_runtime::block_on(super::intent_models()).unwrap();
        let got = frames.lock().unwrap().clone();
        assert_eq!(got.len(), 3);
        // submit: closed field set, explicit model, caller-supplied key, no authority.
        assert_eq!(got[0]["cmd"], "intent-submit");
        let i = got[0]["params"]["intent"].as_object().unwrap();
        let mut keys: Vec<&str> = i.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "clientLabel",
                "content",
                "idempotencyKey",
                "intentType",
                "limits",
                "model",
                "requestId",
                "responseMode",
                "schemaVersion"
            ]
        );
        assert_eq!(i["intentType"], "model-only");
        assert_eq!(i["model"]["providerId"], "acme");
        assert_eq!(i["idempotencyKey"], "gui-0123456789abcdef");
        assert_eq!(got[1]["cmd"], "intent-cancel");
        assert_eq!(got[2]["cmd"], "intent-models");
        for f in &got {
            assert!(f.get("auth").is_none(), "the renderer path signs nothing");
            let text = f.to_string();
            assert!(!text.contains("cap") || !text.contains("hmac"), "{text}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A5.3.1: every model-run read/cancel goes through the shared Desktop
    /// contract (broker first). The backend no longer reads transcripts for
    /// model runs by itself.
    #[test]
    fn model_run_commands_route_through_the_shared_desktop_contract() {
        let src = include_str!("lib.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").unwrap();
        for needed in [
            "desktop_contract::conversation_read",
            "desktop_contract::model_run_status",
            "desktop_contract::list_model_conversations",
            "desktop_contract::cancel_model_run",
        ] {
            assert!(prod.contains(needed), "missing {needed}");
        }
        for forbidden in [
            "nexus_client::list_model_conversations",
            "nexus_client::model_run_status",
            "nexus_client::request_model_cancel",
        ] {
            assert!(
                !prod.contains(forbidden),
                "the backend must not read transcripts directly: {forbidden}"
            );
        }
    }
}
