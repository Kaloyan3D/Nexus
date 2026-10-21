//! Nexus desktop Tauri shell (A2.5). Thin typed command layer over
//! `nexus-client` v1. The renderer never gets filesystem, shell, HTTP or
//! credential access: it can only call the commands registered below, which
//! are mirrored 1:1 by `build.rs` and `capabilities/main.json`.

mod backend;
pub mod dialogs;
pub mod dto;
pub mod interactive;

use dto::*;
use nexus_client::ClientConfig;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
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

/// R-NATIVE-3: read-only Registry target catalog (identities + status only;
/// no secret, path or limit the renderer could set). Same broker socket
/// and client as every other intent command.
#[tauri::command]
async fn intent_targets() -> Result<Vec<nexus_client::intent_client::RegistryTarget>, UiError> {
    tauri::async_runtime::spawn_blocking(|| {
        nexus_client::intent_client::registry_targets(
            &nexus_client::intent_client::default_broker_socket(),
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// R-NATIVE-3: one identity part of a model selection. Provider and remote
/// model ids are single path segments; logical model ids and route ids may
/// themselves contain '/'. Identities only: no path, tool, limit, secret
/// or authority can cross here.
fn valid_identity_part(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.len() <= 200 && !t.contains('/') && !t.chars().any(|c| c.is_control())
}

fn valid_route_id(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.len() <= 200 && !t.chars().any(|c| c.is_control())
}

/// Submit one user-typed model-only intent. `idempotency_key` is generated
/// once per Send click by the UI so a duplicate click or a retried call can
/// never create a second billable attempt.
#[tauri::command]
async fn intent_submit(
    prompt: String,
    provider_id: Option<String>,
    remote_model_id: Option<String>,
    logical_model_id: Option<String>,
    route_id: Option<String>,
    idempotency_key: String,
) -> Result<nexus_client::intent_client::SubmitReply, UiError> {
    // R-NATIVE-3: identities only. Anything else (paths, tools, limits,
    // secrets, authority) is rejected before reaching the broker.
    for part in [&provider_id, &remote_model_id, &logical_model_id, &route_id]
        .into_iter()
        .flatten()
    {
        if !valid_identity_part(part) && !valid_route_id(part) {
            return Err(UiError {
                code: "bad-usage".to_owned(),
                message: "model selection is not valid".to_owned(),
            });
        }
    }
    if let Some(r) = route_id.as_deref() {
        if r.trim().is_empty() || r.len() > 200 {
            return Err(UiError {
                code: "bad-usage".to_owned(),
                message: "model selection is not valid".to_owned(),
            });
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        use nexus_client::intent_contract::{
            IntentLimits, ModelSelection, NexusIntentV1, ResponseMode,
        };
        let model = match (provider_id, remote_model_id, logical_model_id, route_id) {
            (Some(p), Some(m), l, r) => {
                if !valid_identity_part(&p) || !valid_identity_part(&m) {
                    return Err(UiError {
                        code: "bad-usage".to_owned(),
                        message: "model selection is not valid".to_owned(),
                    });
                }
                if let Some(l) = l.as_deref() {
                    // Logical ids may contain '/' (e.g. "acme/large").
                    if !valid_route_id(l) {
                        return Err(UiError {
                            code: "bad-usage".to_owned(),
                            message: "model selection is not valid".to_owned(),
                        });
                    }
                }
                if let Some(r) = r.as_deref() {
                    if !valid_route_id(r) {
                        return Err(UiError {
                            code: "bad-usage".to_owned(),
                            message: "model selection is not valid".to_owned(),
                        });
                    }
                }
                Some(ModelSelection {
                    provider_id: p,
                    remote_model_id: m,
                    logical_model_id: l,
                    route_id: r,
                    // the Desktop never chooses an Engineering Mode (EM-04C2 S4)
                    mode_id: None,
                })
            }
            (None, None, None, None) => None,
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
        interactive::guarded(|| {
            nexus_client::intent_client::submit(
                &nexus_client::intent_client::default_broker_socket(),
                &intent,
            )
            .map_err(|e| backend::ui_error(&e))
        })
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
        interactive::guarded(|| {
            nexus_client::intent_client::submit(
                &nexus_client::intent_client::default_broker_socket(),
                &intent,
            )
            .map_err(|e| backend::ui_error(&e))
        })
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

/// The limits a Desktop coding task will really get plus the approval lifetime
/// (A6.1.3): the fixed maximums lowered by the operator's caps, read from the
/// broker. Shown before submitting; never renderer-controlled.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeLimitsView {
    #[serde(flatten)]
    limits: nexus_client::intent_client::DesktopCodeLimits,
    approval_lifetime_secs: u64,
    built_in: Option<nexus_client::intent_client::DesktopCodeLimits>,
}

#[tauri::command]
async fn intent_code_limits() -> Result<CodeLimitsView, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::code_config(
            &nexus_client::intent_client::default_broker_socket(),
        )
        .map(|c| CodeLimitsView {
            limits: c.limits,
            approval_lifetime_secs: c.approval_lifetime_secs,
            built_in: c.built_in,
        })
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
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
            // The limits are the broker's (fixed maximums lowered by the operator, or the
            // interactive defaults); the renderer never states one.
            limits: nexus_client::intent_client::code_config(
                &nexus_client::intent_client::default_broker_socket(),
            )
            .map_err(|e| backend::ui_error(&e))?
            .limits
            .to_intent_limits(),
            response_mode: ResponseMode::Stream,
            client_label: Some("nexus-desktop".to_owned()),
        };
        interactive::guarded(|| {
            nexus_client::intent_client::submit(
                &nexus_client::intent_client::default_broker_socket(),
                &intent,
            )
            .map_err(|e| backend::ui_error(&e))
        })
    })
    .await
    .map_err(|_| internal())?
}

/// A6.1.3: read-only facts (retained?, age, size, base commit) about the
/// isolated working copy of one of this user's repo-code runs. Never a path.
#[tauri::command]
async fn intent_copy(run_id: String) -> Result<nexus_client::intent_client::CopyInfo, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::copy_info(
            &nexus_client::intent_client::default_broker_socket(),
            &run_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

// ---- A6.1.4 interactive profile ------------------------------------------------

#[tauri::command]
async fn runtime_state(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
) -> Result<interactive::RuntimeState, UiError> {
    let rt = rt.inner().clone();
    tauri::async_runtime::spawn_blocking(move || rt.state())
        .await
        .map_err(|_| internal())
}

#[tauri::command]
async fn runtime_start(rt: tauri::State<'_, Arc<interactive::Runtime>>) -> Result<(), UiError> {
    rt.inner().start_async();
    Ok(())
}

fn ui_msg(code: &str, m: String) -> UiError {
    UiError {
        code: if m == "cancelled" {
            "cancelled".to_owned()
        } else {
            code.to_owned()
        },
        message: m,
    }
}

#[tauri::command]
async fn provider_connect(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
    dialogs: tauri::State<'_, Arc<dyn dialogs::Dialogs>>,
) -> Result<nexus_runtime::ConnectReport, UiError> {
    let (rt, d) = (rt.inner().clone(), dialogs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || rt.provider_connect(d.as_ref()))
        .await
        .map_err(|_| internal())?
        .map_err(|m| ui_msg("provider-connect", m))
}

#[tauri::command]
async fn provider_consent(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
    dialogs: tauri::State<'_, Arc<dyn dialogs::Dialogs>>,
) -> Result<interactive::ConsentView, UiError> {
    let (rt, d) = (rt.inner().clone(), dialogs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || rt.provider_consent(d.as_ref()))
        .await
        .map_err(|_| internal())?
        .map_err(|m| ui_msg("consent", m))
}

#[tauri::command]
async fn provider_revoke(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
    dialogs: tauri::State<'_, Arc<dyn dialogs::Dialogs>>,
) -> Result<interactive::ConsentView, UiError> {
    let (rt, d) = (rt.inner().clone(), dialogs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || rt.provider_revoke(d.as_ref()))
        .await
        .map_err(|_| internal())?
        .map_err(|m| ui_msg("consent", m))
}

/// Native folder picker, then the broker opens the folder as a project. No path
/// parameter exists: the renderer cannot name a folder.
#[tauri::command]
async fn project_pick(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
    dialogs: tauri::State<'_, Arc<dyn dialogs::Dialogs>>,
) -> Result<serde_json::Value, UiError> {
    let (rt, d) = (rt.inner().clone(), dialogs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || rt.project_pick(d.as_ref()))
        .await
        .map_err(|_| internal())?
        .map_err(|m| ui_msg("project", m))
}

#[tauri::command]
async fn project_list(with_changes: Option<bool>) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::project_list(
            &nexus_client::intent_client::default_broker_socket(),
            with_changes.unwrap_or(false),
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// Settings: the user's own, lower run limits. Everything is optional; leaving a field out
/// resets it to the built-in value. The broker clamps to 1..=built-in.
#[tauri::command]
async fn code_limits_set(
    limits: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::limits_set(
            &nexus_client::intent_client::default_broker_socket(),
            &limits,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn project_set_policy(
    project_id: String,
    installs: Option<bool>,
    trusted: Option<bool>,
) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::project_policy(
            &nexus_client::intent_client::default_broker_socket(),
            &project_id,
            installs,
            trusted,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn project_refresh(project_id: String) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::project_refresh(
            &nexus_client::intent_client::default_broker_socket(),
            &project_id,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn project_forget(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
    dialogs: tauri::State<'_, Arc<dyn dialogs::Dialogs>>,
    project_id: String,
) -> Result<serde_json::Value, UiError> {
    let (rt, d) = (rt.inner().clone(), dialogs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || rt.project_forget(d.as_ref(), &project_id))
        .await
        .map_err(|_| internal())?
        .map_err(|m| ui_msg("project", m))
}

/// Apply a finished run's patch to the user's own folder after a native confirmation.
#[tauri::command]
async fn project_adopt(
    rt: tauri::State<'_, Arc<interactive::Runtime>>,
    dialogs: tauri::State<'_, Arc<dyn dialogs::Dialogs>>,
    run_id: String,
) -> Result<serde_json::Value, UiError> {
    let (rt, d) = (rt.inner().clone(), dialogs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || rt.adopt_patch(d.as_ref(), &run_id))
        .await
        .map_err(|_| internal())?
        .map_err(|m| ui_msg("adopt", m))
}

// ---- A7.1 conversations ----------------------------------------------------------
//
// A conversation is the broker's durable record of a project discussion. The renderer can
// list and read them and send a message (text + project identity + a mode/workspace choice);
// it cannot name a path, a tool, a limit, a model or an approval, and it cannot change what
// a read-only request may do (the broker enforces that).

#[tauri::command]
async fn thread_list(
    project_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::thread_list(
            &nexus_client::intent_client::default_broker_socket(),
            project_id.as_deref(),
            include_archived.unwrap_or(false),
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn thread_get(
    thread_id: String,
    after_seq: Option<u64>,
) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::thread_get(
            &nexus_client::intent_client::default_broker_socket(),
            &thread_id,
            after_seq,
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

/// One message into a conversation (created when `thread_id` is absent). The broker starts
/// the run, continuing from the conversation's workspace.
#[tauri::command]
// The renderer calls this by NAMED arguments (the frontend/backend contract in api.ts); the four
// identity fields of an optional selection are separate named arguments by design.
#[allow(clippy::too_many_arguments)]
async fn thread_send(
    thread_id: Option<String>,
    project_id: String,
    content: String,
    mode: Option<String>,
    workspace: Option<String>,
    provider_id: Option<String>,
    remote_model_id: Option<String>,
    logical_model_id: Option<String>,
    route_id: Option<String>,
    idempotency_key: String,
) -> Result<serde_json::Value, UiError> {
    // R-NATIVE-3: optional selection as identities only (default sends none,
    // byte-for-byte the same request as before). Rejected before the broker.
    let (model, route) = match (&provider_id, &remote_model_id, &logical_model_id, &route_id) {
        (None, None, None, None) => (None, None),
        (p, m, l, r) => {
            // Provider and remote model ids are single segments; the logical
            // id may itself contain '/' (e.g. "acme/large"), so it is
            // validated leniently and never packed into the `model` path.
            // The exact catalog routeId carries the disambiguation instead.
            for part in [p, m].into_iter().flatten() {
                if !valid_identity_part(part) {
                    return Err(UiError {
                        code: "bad-usage".to_owned(),
                        message: "model selection is not valid".to_owned(),
                    });
                }
            }
            for part in [l, r].into_iter().flatten() {
                if !valid_route_id(part) {
                    return Err(UiError {
                        code: "bad-usage".to_owned(),
                        message: "model selection is not valid".to_owned(),
                    });
                }
            }
            match (p, m) {
                (Some(p), Some(m)) => (Some(format!("{p}/{m}")), r.clone()),
                (None, None) if r.is_some() => (None, r.clone()),
                _ => {
                    return Err(UiError {
                        code: "bad-usage".to_owned(),
                        message: "provider and model must be selected together".to_owned(),
                    })
                }
            }
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        interactive::guarded(|| {
            nexus_client::intent_client::thread_send(
                &nexus_client::intent_client::default_broker_socket(),
                &nexus_client::intent_client::ThreadSend {
                    thread_id: thread_id.as_deref(),
                    project_id: &project_id,
                    content: &content,
                    mode: mode.as_deref().unwrap_or("auto"),
                    workspace: workspace.as_deref().unwrap_or("continue"),
                    idempotency_key: &idempotency_key,
                    model: model.as_deref(),
                    route: route.as_deref(),
                },
            )
            .map_err(|e| backend::ui_error(&e))
        })
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn thread_create(
    project_id: String,
    title: Option<String>,
) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::thread_create(
            &nexus_client::intent_client::default_broker_socket(),
            &project_id,
            title.as_deref(),
        )
        .map_err(|e| backend::ui_error(&e))
    })
    .await
    .map_err(|_| internal())?
}

#[tauri::command]
async fn thread_update(
    thread_id: String,
    title: Option<String>,
    archived: Option<bool>,
) -> Result<serde_json::Value, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::thread_update(
            &nexus_client::intent_client::default_broker_socket(),
            &thread_id,
            title.as_deref(),
            archived,
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

/// The final text of a finished run, as the broker recorded it (the report or summary).
#[tauri::command]
async fn intent_result(run_id: String) -> Result<String, UiError> {
    tauri::async_runtime::spawn_blocking(move || {
        nexus_client::intent_client::result(
            &nexus_client::intent_client::default_broker_socket(),
            &run_id,
        )
        .map(|r| r.text)
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
    // A6.1.4: unless an operator-run broker is named, this app owns the runtime. The
    // runtime object sets the socket environment BEFORE the client config resolves.
    let runtime = Arc::new(interactive::Runtime::new());
    interactive::install(runtime.clone());
    runtime.watch_for_updates();
    runtime.start_async();
    let cfg = ClientConfig::resolve(None, None, false).expect("client configuration");
    let rt_exit = runtime.clone();
    tauri::Builder::default()
        .manage(runtime)
        .manage::<Arc<dyn dialogs::Dialogs>>(Arc::new(dialogs::SystemDialogs))
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
            intent_targets,
            intent_submit,
            intent_workspaces,
            intent_inspect_submit,
            intent_code_sources,
            intent_code_limits,
            intent_code_submit,
            intent_diff,
            intent_copy,
            intent_status,
            intent_result,
            intent_cancel,
            intent_list,
            tool_events,
            list_approvals,
            integrity_status,
            runtime_state,
            runtime_start,
            provider_connect,
            provider_consent,
            provider_revoke,
            project_pick,
            project_list,
            project_refresh,
            project_set_policy,
            code_limits_set,
            project_forget,
            project_adopt,
            thread_list,
            thread_get,
            thread_send,
            thread_create,
            thread_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nexus")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                rt_exit.shutdown();
            }
        });
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
        "intent_targets",
        "intent_submit",
        "intent_workspaces",
        "intent_inspect_submit",
        "intent_code_sources",
        "intent_code_limits",
        "intent_code_submit",
        "intent_diff",
        "intent_copy",
        "intent_status",
        "intent_result",
        "intent_cancel",
        "intent_list",
        "tool_events",
        "list_approvals",
        "integrity_status",
        "runtime_state",
        "runtime_start",
        "provider_connect",
        "provider_consent",
        "provider_revoke",
        "project_pick",
        "project_list",
        "project_refresh",
        "project_set_policy",
        "code_limits_set",
        "project_forget",
        "project_adopt",
        "thread_list",
        "thread_get",
        "thread_send",
        "thread_create",
        "thread_update",
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
        // The submit command cannot carry anything but text + an optional
        // identity-only selection + an idempotency key.
        assert!(prod.contains("fn intent_submit(\n    prompt: String,\n    provider_id: Option<String>,\n    remote_model_id: Option<String>,\n    logical_model_id: Option<String>,\n    route_id: Option<String>,\n    idempotency_key: String,\n)"));
        // The thread-send command accepts the same identities only.
        assert!(prod.contains("logical_model_id: Option<String>,\n    route_id: Option<String>,\n    idempotency_key: String,"));
        // The read-only catalog command exists and takes no renderer input.
        assert!(prod.contains("async fn intent_targets()"));
        // No path, tool, limit, secret or approval vocabulary in the three commands that carry or
        // list selections (the global guard above covers the whole backend and is unchanged).
        for name in [
            "async fn intent_submit(",
            "async fn thread_send(",
            "async fn intent_targets(",
        ] {
            let start = prod.find(name).unwrap_or_else(|| panic!("{name} exists"));
            let rest = &prod[start..];
            let body = &rest[..rest[name.len()..]
                .find("#[tauri::command]")
                .map_or(rest.len(), |e| e + name.len())];
            for forbidden in [
                "credential",
                "approval",
                "context_limit",
                "output_limit",
                "max_output",
                "workspace_root",
                "tool-execute",
                "fs_write",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "{name} must not reference {forbidden}"
                );
            }
        }
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
            for stream in l.incoming().take(6) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let v: serde_json::Value = serde_json::from_str(&line).unwrap();
                let cmd = v["cmd"].as_str().unwrap_or("").to_owned();
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let run = serde_json::json!({"runId":"run_00000000000000000000000000000000","requestId":"r","clientId":"uid:1","state":"preparing","terminal":false,"intentType":"repo-code","responseMode":"stream","cancelRequested":false,"createdAtMs":1,"updatedAtMs":1,"workspaceId":"proj"});
                let result = match cmd.as_str() {
                    "intent-submit" => serde_json::json!({"run": run, "replay": false}),
                    "intent-diff" => {
                        serde_json::json!({"run": run, "baseCommit": "abc", "files": [{"path": "src/lib.rs", "status": "M", "additions": 1, "deletions": 1}], "filesTruncated": false, "diff": "--- a\n+++ b\n", "diffDigest": "d", "diffTruncated": false})
                    }
                    "intent-code-config" => {
                        serde_json::json!({"limits": {"maxTurns": 12, "maxToolCalls": 30, "maxToolResultBytes": 131072, "maxEdits": 5, "maxTests": 5, "maxOutputTokens": 1024, "maxRuntimeSecs": 1800}, "approvalLifetimeSecs": 300})
                    }
                    "intent-copy" => {
                        serde_json::json!({"retained": true, "active": false, "projectId": "proj", "baseCommit": "abc", "ageMs": 5, "approxBytes": 1024})
                    }
                    _ => serde_json::json!({"sources": [{"sourceId": "proj"}]}),
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
        let src = tauri::async_runtime::block_on(super::intent_code_sources()).unwrap();
        assert_eq!(src[0].source_id, "proj");
        // the limits shown to the user are the backend constants (no broker round trip)
        let lim = tauri::async_runtime::block_on(super::intent_code_limits()).unwrap();
        assert_eq!(lim.limits.max_edits, 5);
        assert_eq!(lim.approval_lifetime_secs, 300);
        let r = tauri::async_runtime::block_on(super::intent_code_submit(
            "fix the test".into(),
            "proj".into(),
            "gui-0123456789abcdef".into(),
        ))
        .unwrap();
        assert!(!r.replay);
        let d = tauri::async_runtime::block_on(super::intent_diff(r.run.run_id.clone())).unwrap();
        assert_eq!(d.files[0].path, "src/lib.rs");
        let c = tauri::async_runtime::block_on(super::intent_copy(r.run.run_id.clone())).unwrap();
        assert!(c.retained && !c.active && c.approx_bytes == Some(1024));
        let got = frames.lock().unwrap().clone();
        assert_eq!(got[0]["cmd"], "intent-code-sources");
        assert_eq!(got[1]["cmd"], "intent-code-config");
        assert_eq!(
            got[2]["cmd"], "intent-code-config",
            "submit reads the broker's limits"
        );
        assert_eq!(got[3]["cmd"], "intent-submit");
        assert_eq!(got[4]["cmd"], "intent-diff");
        assert_eq!(got[5]["cmd"], "intent-copy");
        assert_eq!(got[5]["params"].as_object().unwrap().len(), 1);
        let i = got[3]["params"]["intent"].as_object().unwrap();
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
        assert_eq!(i["intentType"], "repo-code");
        assert_eq!(i["workspaceId"], "proj");
        assert_eq!(
            i["limits"],
            serde_json::to_value(
                nexus_client::intent_client::DESKTOP_CODE_LIMITS.to_intent_limits()
            )
            .unwrap(),
            "limits are the broker's reported set (not renderer-controlled)"
        );
        assert_eq!(i["limits"]["maxEdits"], 5);
        assert_eq!(i["limits"]["maxTests"], 5);
        let src = include_str!("lib.rs");
        let (prod, _) = src.split_once("#[cfg(test)]").unwrap();
        for forbidden in [
            "approval-decide",
            "approval-get",
            "approval-request",
            "approval-revoke",
            "approval_decide",
            "approvalDecide",
            "fs_write",
            "fs_edit",
            "proc_run",
            "fs.write",
            "fs.edit",
            "proc.run",
            "worktree",
            "git ",
            "Command::new",
            "std::process",
        ] {
            assert!(
                !prod.contains(forbidden),
                "Tauri backend must not reference {forbidden}"
            );
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
            for stream in l.incoming().take(4) {
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
            None,
            None,
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

    /// R-NATIVE-3: `intent_targets` reads the broker's `intent-models` reply
    /// (the same verb the CLI path uses) and surfaces the `targets` field;
    /// the frame carries no auth, path, credential or limit the renderer
    /// could set.
    #[test]
    fn desktop_intent_targets_reads_the_registry_catalog() {
        let _env = BROKER_ENV.lock().unwrap_or_else(|p| p.into_inner());
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("nexus-tauri-rn3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("broker.sock");
        let _ = std::fs::remove_file(&sock);
        let l = UnixListener::bind(&sock).unwrap();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let f2 = frames.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().take(1) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let v: serde_json::Value = serde_json::from_str(&line).unwrap();
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let result = serde_json::json!({
                    "models": [],
                    "targets": [{
                        "providerId": "acme", "remoteModelId": "acme-large-1",
                        "logicalModelId": "acme/large", "routeId": "acme/large",
                        "issuable": true, "allowed": true,
                    }],
                });
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
        let targets = tauri::async_runtime::block_on(super::intent_targets()).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].provider_id, "acme");
        assert_eq!(targets[0].remote_model_id, "acme-large-1");
        assert_eq!(targets[0].route_id, "acme/large");
        let got = frames.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["cmd"], "intent-models");
        assert!(
            got[0].get("auth").is_none(),
            "the renderer path signs nothing"
        );
        let wire = got[0].to_string();
        assert!(!wire.contains("secret") && !wire.contains("credential"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R-NATIVE-3: `intent_submit` forwards a chosen target as identities (provider, model, logical
    /// model, route) inside the intent's `model`; a malformed or lone half of a selection never reaches
    /// the broker socket.
    #[test]
    fn desktop_intent_submit_forwards_the_selection_identities_and_rejects_malformed_ones() {
        let _env = BROKER_ENV.lock().unwrap_or_else(|p| p.into_inner());
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir =
            std::env::temp_dir().join(format!("nexus-tauri-rn3-submit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("broker.sock");
        let _ = std::fs::remove_file(&sock);
        let l = UnixListener::bind(&sock).unwrap();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let f2 = frames.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().take(1) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let v: serde_json::Value = serde_json::from_str(&line).unwrap();
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let run = serde_json::json!({"runId":"run_00000000000000000000000000000000","requestId":"r","clientId":"uid:1","state":"preparing","terminal":false,"intentType":"model-only","responseMode":"stream","cancelRequested":false,"createdAtMs":1,"updatedAtMs":1});
                let result = serde_json::json!({"run": run, "replay": false});
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
        tauri::async_runtime::block_on(super::intent_submit(
            "hello".into(),
            Some("acme".into()),
            Some("acme-large-1".into()),
            Some("acme/large".into()),
            Some("acme/large".into()),
            "gui-0000000000000011".into(),
        ))
        .unwrap();
        let got = frames.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0]["params"]["intent"]["model"],
            serde_json::json!({"providerId":"acme","remoteModelId":"acme-large-1","logicalModelId":"acme/large","routeId":"acme/large"})
        );
        // malformed identities, and half a selection, are refused before any broker contact
        for (p, m, l, r) in [
            (Some("acme"), Some("../../etc/passwd"), None, None),
            (Some("acme"), None, None, None),
            (None, None, Some("acme/large"), None),
            (Some("acme"), Some("acme-large-1"), Some("bad\nid"), None),
        ] {
            let e = tauri::async_runtime::block_on(super::intent_submit(
                "hello".into(),
                p.map(str::to_owned),
                m.map(str::to_owned),
                l.map(str::to_owned),
                r.map(str::to_owned),
                "gui-0000000000000012".into(),
            ))
            .unwrap_err();
            assert_eq!(e.code, "bad-usage", "{p:?} {m:?} {l:?} {r:?}");
        }
        assert_eq!(
            frames.lock().unwrap().len(),
            1,
            "nothing malformed reached the broker"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R-NATIVE-3: `thread_send` with no selection puts `model: null` and
    /// `route: null` on the `thread-send` wire frame (byte-identical to the
    /// pre-R-NATIVE-3 request); a chosen model+route forwards the identities
    /// (`provider/remote` plus the exact route id); malformed or oversized
    /// identities are rejected before any broker contact.
    #[test]
    fn desktop_thread_send_forwards_identities_only() {
        let _env = BROKER_ENV.lock().unwrap_or_else(|p| p.into_inner());
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("nexus-tauri-rn3-send-{}", std::process::id()));
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
                let rid = v["id"].clone();
                f2.lock().unwrap().push(v);
                let result = serde_json::json!({
                    "threadId": "thr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "run": {"runId":"run_00000000000000000000000000000000","requestId":"r","clientId":"uid:1","state":"preparing","terminal":false,"intentType":"repo-code","responseMode":"stream","cancelRequested":false,"createdAtMs":1,"updatedAtMs":1},
                    "replay": false,
                });
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
        // Default: no selection -> model/route are null.
        tauri::async_runtime::block_on(super::thread_send(
            None,
            "east-india".into(),
            "hello".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            "gui-0000000000000001".into(),
        ))
        .unwrap();
        // Choice: identities only (logical id with a slash stays intact via route).
        tauri::async_runtime::block_on(super::thread_send(
            None,
            "east-india".into(),
            "hello".into(),
            None,
            None,
            Some("acme".into()),
            Some("acme-large-1".into()),
            Some("acme/large".into()),
            Some("acme/large".into()),
            "gui-0000000000000002".into(),
        ))
        .unwrap();
        let got = frames.lock().unwrap().clone();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["cmd"], "thread-send");
        assert!(got[0]["params"]["model"].is_null());
        assert!(got[0]["params"]["route"].is_null());
        assert_eq!(got[1]["params"]["model"], "acme/acme-large-1");
        assert_eq!(got[1]["params"]["route"], "acme/large");
        // Malformed identities never reach the broker socket.
        let bad = tauri::async_runtime::block_on(super::thread_send(
            None,
            "east-india".into(),
            "hello".into(),
            None,
            None,
            Some("acme".into()),
            Some("../../etc/passwd".into()),
            None,
            None,
            "gui-0000000000000003".into(),
        ));
        assert_eq!(bad.unwrap_err().code, "bad-usage");
        let lone = tauri::async_runtime::block_on(super::thread_send(
            None,
            "east-india".into(),
            "hello".into(),
            None,
            None,
            Some("acme".into()),
            None,
            None,
            None,
            "gui-0000000000000004".into(),
        ));
        assert_eq!(lone.unwrap_err().code, "bad-usage");
        assert_eq!(frames.lock().unwrap().len(), 2, "rejections send no frames");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
