//! macOS desktop host (milestone 1): the original Nexus interface running natively, with no engine.
//!
//! The engine is Linux software and is not linked, started or simulated on this platform. What
//! this host does:
//!
//! * answers the few commands whose truthful answer needs no engine (`app_info`, `runtime_status`,
//!   `list_tasks`, `runtime_state`, `environment_check`) with an explicit "unavailable" state;
//! * runs the native folder picker for `project_pick` and then reports that nothing could be
//!   opened: the chosen path is not stored, forwarded or authorized anywhere;
//! * answers **every other** registered command with the structured `engine-unavailable` error.
//!   Command names, argument shapes, `build.rs` and the capability file are the same as on Linux.
//!
//! No command here starts a process, opens a socket, or reports a result it did not obtain.

//! macOS desktop host: the original Nexus interface running natively, with the engine in a Linux guest.
//!
//! The engine is Linux software. This host never links, starts or simulates it; it reaches the real
//! one through [`EngineLink`] (an authenticated SSH bridge, `bridge_link.rs`) when `engine.json`
//! configures one, and otherwise falls back to [`NoEngine`]:
//!
//! * a registered command is forwarded to the engine only while the link is `Ready`/`Busy`; in every
//!   other state it is rejected with the link's structured error and nothing is sent;
//! * the few status commands (`app_info`, `runtime_status`, `list_tasks`, `runtime_state`,
//!   `environment_check`) answer with an explicit "not connected" state instead of an error;
//! * `project_pick` stays on this Mac (a Mac folder is not a guest folder; folder sync is a later
//!   milestone): cancel is quiet, a chosen folder is dropped and nothing is granted;
//! * `run_mock` is never served: no simulated run is ever presented here.
//!
//! Command names, argument shapes, `build.rs` and the capability file are the same as on Linux.

use crate::bridge_link::BridgeLink;
use crate::dialogs::{Dialogs, MacDialogs};
use crate::dto::*;
use crate::engine::{EngineLink, EngineStatus, NoEngine, UNAVAILABLE_CODE};
use crate::engine_config::EngineConfig;
use crate::engine_vm::VmTransport;
use crate::sync::coordinator::Coordinator;
use crate::sync::registry::Store;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{InvokeBody, InvokeError};
use tauri::{Manager, State};

/// Status commands: forwarded to the engine when it is ready, otherwise answered locally with an
/// explicit "not connected" state.
pub const STATUS_COMMANDS: &[&str] = &[
    "app_info",
    "runtime_status",
    "list_tasks",
    "runtime_state",
    "environment_check",
];

/// Commands answered on this Mac only, whatever the engine state.
pub const LOCAL_COMMANDS: &[&str] = &["project_pick"];

/// Commands never served on this host (simulated or not meaningful through the bridge).
pub const NEVER_SERVED: &[&str] = &["run_mock"];

type Engine = Arc<dyn EngineLink>;

/// Same JSON shape as the Linux `RuntimeState` (`src/lib/contracts.ts`), with `phase: "unavailable"`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeState {
    mode: &'static str,
    phase: &'static str,
    message: Option<String>,
    home: Option<String>,
    diagnostics: Vec<String>,
    provider_connected: bool,
    consent: Consent,
    can_open_projects: bool,
    update_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Consent {
    given: bool,
    provider_id: Option<String>,
    remote_model_id: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvCheck {
    platform: &'static str,
    dialog_tool: Option<&'static str>,
    opener: Option<&'static str>,
    toolchains: Vec<(&'static str, bool)>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn app_info() -> AppInfo {
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        // No client / IPC protocol is linked on this platform.
        client_api_version: 0,
        ipc_protocol: 0,
        platform: "macos".to_owned(),
        socket_path: String::new(),
        ledger_dir: None,
        dispatch_enabled: false,
        live_ready: false,
    }
}

fn environment_check() -> EnvCheck {
    EnvCheck {
        platform: "macos",
        dialog_tool: Some("macOS native"),
        opener: Some("open"),
        toolchains: Vec::new(),
    }
}

/// Native folder picker. The renderer supplies no path and receives none. A cancelled pick is
/// `cancelled`. A chosen folder goes to the coordinator, which validates it, asks the person for the
/// standing permission in a native dialog, and copies it to the engine; without a connected engine it
/// is dropped and nothing is stored or granted.
#[tauri::command]
async fn project_pick(
    engine: State<'_, Engine>,
    dialogs: State<'_, Arc<dyn Dialogs>>,
    coord: State<'_, Option<Arc<Coordinator>>>,
) -> Result<serde_json::Value, UiError> {
    let (status, d) = (engine.status(), dialogs.inner().clone());
    let coord = coord.inner().clone();
    let picked =
        tauri::async_runtime::spawn_blocking(move || d.pick_folder("Choose a project folder"))
            .await
            .map_err(|_| internal())?
            .map_err(|m| UiError {
                code: "project".to_owned(),
                message: m,
            })?;
    let Some(path) = picked else {
        return Err(UiError {
            code: "cancelled".to_owned(),
            message: "cancelled".to_owned(),
        });
    };
    match coord {
        Some(c) => tauri::async_runtime::spawn_blocking(move || c.open_project(&path))
            .await
            .map_err(|_| internal())?,
        None => Err(UiError {
            code: UNAVAILABLE_CODE.to_owned(),
            message: format!(
                "The folder was not opened: {} No folder was stored and no permission was granted.",
                status.message()
            ),
        }),
    }
}

/// Merge this host's view into the engine's own `runtime_state`: the engine's phase, provider and
/// consent are real and kept; what only this Mac can know (Mac folders open through the native picker;
/// where the engine is) is added.
fn annotate_runtime_state(engine: &dyn EngineLink, mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("canOpenProjects".into(), Value::Bool(true));
        // the plain sentence stays in `message`; connection facts go to Settings → Diagnostics only
        if o.get("message").is_none_or(Value::is_null) {
            o.insert("message".into(), Value::String(engine.status().message()));
        }
        o.insert(
            "diagnostics".into(),
            serde_json::json!(engine.diagnostics().lines),
        );
    }
    v
}

/// Local, honest answers to the status commands while the engine cannot give its own.
fn local_status_unavailable(engine: &dyn EngineLink, cmd: &str) -> Option<Value> {
    let s = engine.status();
    match cmd {
        "runtime_state" => {
            let st = s.clone();
            let diagnostics = engine.diagnostics().lines;
            Some(
                serde_json::to_value(RuntimeState {
                    mode: "interactive",
                    phase: match st {
                        EngineStatus::Connecting => "starting",
                        _ => "unavailable",
                    },
                    message: Some(st.message()),
                    diagnostics,
                    home: None,
                    provider_connected: false,
                    consent: Consent {
                        given: false,
                        provider_id: None,
                        remote_model_id: None,
                        text: None,
                    },
                    can_open_projects: false,
                    update_pending: false,
                })
                .ok()?,
            )
        }
        "app_info" => serde_json::to_value(app_info()).ok(),
        "environment_check" => serde_json::to_value(environment_check()).ok(),
        "runtime_status" => serde_json::to_value(RuntimeSnapshot::empty(
            Connection::Disconnected,
            Some(s.message()),
            now_ms(),
        ))
        .ok(),
        "list_tasks" => serde_json::to_value(TasksDto {
            available: false,
            source: None,
            error: Some(s.message()),
            tasks: Vec::new(),
        })
        .ok(),
        _ => None,
    }
}

fn internal() -> UiError {
    UiError {
        code: "internal".to_owned(),
        message: "background task failed".to_owned(),
    }
}

/// Real handlers for [`LOCAL_COMMANDS`]; every other command is forwarded to the engine when it
/// is ready and rejected with the engine's status error otherwise.
fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let local: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![project_pick]);
    move |invoke| {
        let cmd = invoke.message.command().to_owned();
        if LOCAL_COMMANDS.contains(&cmd.as_str()) {
            return local(invoke);
        }
        let webview = invoke.message.webview();
        let engine: Engine = match webview.try_state::<Engine>() {
            Some(e) => e.inner().clone(),
            None => Arc::new(NoEngine),
        };
        if NEVER_SERVED.contains(&cmd.as_str()) {
            invoke.resolver.reject(UiError {
                code: UNAVAILABLE_CODE.to_owned(),
                message: "Simulated (mock) runs are not available on this Mac; only real engine work is shown."
                    .to_owned(),
            });
            return true;
        }
        let status = engine.status();
        if !status.is_ready() {
            if STATUS_COMMANDS.contains(&cmd.as_str()) {
                if let Some(v) = local_status_unavailable(engine.as_ref(), &cmd) {
                    invoke.resolver.respond(Ok::<Value, InvokeError>(v));
                    return true;
                }
            }
            invoke.resolver.reject(status.unavailable_error());
            return true;
        }
        let args = match invoke.message.payload() {
            InvokeBody::Json(v) => v.clone(),
            InvokeBody::Raw(_) => {
                invoke.resolver.reject(UiError {
                    code: "invalid-request".to_owned(),
                    message: "binary arguments are not accepted".to_owned(),
                });
                return true;
            }
        };
        let coord: Option<Arc<Coordinator>> = webview
            .try_state::<Option<Arc<Coordinator>>>()
            .and_then(|c| c.inner().clone());
        invoke.resolver.respond_async(async move {
            let e2 = engine.clone();
            let c2 = cmd.clone();
            let reply = tauri::async_runtime::spawn_blocking(move || match coord {
                Some(c) => c.serve(&c2, args),
                None => e2.call(&c2, args),
            })
            .await
            .map_err(|_| InvokeError::from(internal()))?;
            let v = reply.map_err(InvokeError::from)?;
            Ok::<Value, InvokeError>(if cmd == "runtime_state" {
                annotate_runtime_state(engine.as_ref(), v)
            } else {
                v
            })
        });
        true
    }
}

/// The embedded engine's VM handle (for a clean stop when the app quits).
struct VmHandle(Option<Arc<VmTransport>>);

/// Choose the engine link. In order: `NEXUS_ENGINE=off` (none); an explicit SSH `engine.json` (development
/// machines); otherwise the embedded Linux microVM when an image is available. Anything else falls back to
/// [`NoEngine`], with the reason on stderr.
fn make_engine(app: &tauri::AppHandle, dialogs: Arc<dyn Dialogs>) -> (Engine, VmHandle) {
    let none = || (Arc::new(NoEngine) as Engine, VmHandle(None));
    if std::env::var_os("NEXUS_ENGINE").is_some_and(|v| v == "off") {
        return none();
    }
    let (Ok(dir), Ok(data), Some(home)) = (
        app.path().app_config_dir(),
        app.path().app_data_dir(),
        std::env::var_os("HOME").map(std::path::PathBuf::from),
    ) else {
        return none();
    };
    let version = env!("CARGO_PKG_VERSION");
    if !EngineConfig::wants_vm(&dir) {
        match EngineConfig::load(&dir, &home) {
            Ok(Some(t)) => {
                return (
                    BridgeLink::start(Box::new(t), dialogs, version),
                    VmHandle(None),
                )
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("nexus: engine not configured: {e}");
                return none();
            }
        }
    }
    let Some(helper) = VmTransport::locate_helper() else {
        eprintln!("nexus: the engine VM helper (nexus-vm) is not part of this build");
        return none();
    };
    let bundled = app.path().resource_dir().ok().map(|r| r.join("engine"));
    let dev_image = std::env::var_os("NEXUS_ENGINE_IMAGE_DIR").map(std::path::PathBuf::from);
    let vm = Arc::new(VmTransport::new(helper, bundled, dev_image, &data));
    if !vm.has_image() {
        eprintln!("nexus: no engine image is installed");
        return none();
    }
    (
        BridgeLink::start(Box::new(vm.clone()), dialogs, version),
        VmHandle(Some(vm)),
    )
}

/// The synchronization coordinator exists only when a real engine link is configured. Its follow-up
/// loop finishes interrupted writebacks and applies finished, verified runs.
fn make_coordinator(
    app: &tauri::AppHandle,
    engine: Engine,
    dialogs: Arc<dyn Dialogs>,
) -> Option<Arc<Coordinator>> {
    if engine.status()
        == EngineStatus::Unavailable(crate::engine::UnavailableReason::NoGuestConnected)
    {
        return None;
    }
    let dir = app.path().app_data_dir().ok()?.join("sync");
    let store = match Store::open(&dir) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("nexus: project registry unavailable: {e}");
            return None;
        }
    };
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .and_then(|h| std::fs::canonicalize(h).ok());
    let c = Coordinator::new(store, engine, dialogs, home);
    let c2 = c.clone();
    std::thread::Builder::new()
        .name("nexus-sync".into())
        .spawn(move || loop {
            c2.tick();
            std::thread::sleep(std::time::Duration::from_secs(2));
        })
        .ok()?;
    Some(c)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dialogs: Arc<dyn Dialogs> = Arc::new(MacDialogs::new(app.handle().clone()));
            app.manage::<Arc<dyn Dialogs>>(dialogs.clone());
            let (engine, vm) = make_engine(app.handle(), dialogs.clone());
            app.manage(vm);
            app.manage::<Engine>(engine.clone());
            app.manage::<Option<Arc<Coordinator>>>(make_coordinator(app.handle(), engine, dialogs));
            Ok(())
        })
        .invoke_handler(handler())
        .build(tauri::generate_context!())
        .expect("error while building Nexus")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(e) = app.try_state::<Engine>() {
                    e.shutdown();
                }
                // the embedded engine goes away with the app (its data stays on its state disk)
                if let Some(vm) = app.try_state::<VmHandle>().and_then(|h| h.0.clone()) {
                    vm.stop();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command this host answers itself is a registered, permitted command.
    #[test]
    fn local_commands_are_registered_and_permitted() {
        let build = include_str!("../build.rs");
        let caps = include_str!("../capabilities/main.json");
        for c in LOCAL_COMMANDS {
            assert!(build.contains(&format!("\"{c}\"")), "build.rs missing {c}");
            let p = format!("\"allow-{}\"", c.replace('_', "-"));
            assert!(caps.contains(&p), "capability missing {p}");
        }
    }

    /// Engine-backed commands that start or run work must NOT be answered locally.
    #[test]
    fn execution_commands_are_never_local() {
        for c in [
            "run_mock",
            "runtime_start",
            "intent_submit",
            "intent_code_submit",
            "intent_inspect_submit",
            "thread_send",
            "provider_connect",
            "project_adopt",
            "project_set_edit_mode",
            "project_set_grant",
            "preview_open",
            "exec_restore_apply",
            "run_restore_apply",
        ] {
            assert!(!LOCAL_COMMANDS.contains(&c), "{c} must be rejected");
        }
    }

    #[test]
    fn runtime_state_is_truthfully_unavailable() {
        let e: Engine = Arc::new(NoEngine);
        let s = e.status();
        assert!(!s.is_ready());
        let v = serde_json::to_value(RuntimeState {
            mode: "interactive",
            phase: "unavailable",
            message: Some(s.message()),
            home: None,
            diagnostics: vec![],
            provider_connected: false,
            consent: Consent {
                given: false,
                provider_id: None,
                remote_model_id: None,
                text: None,
            },
            can_open_projects: false,
            update_pending: false,
        })
        .unwrap();
        assert_eq!(v["phase"], "unavailable");
        assert_eq!(v["canOpenProjects"], false);
        assert_eq!(v["providerConnected"], false);
    }

    #[test]
    fn status_commands_answer_honestly_without_an_engine() {
        let e: Engine = Arc::new(NoEngine);
        let v = local_status_unavailable(e.as_ref(), "runtime_state").unwrap();
        assert_eq!(v["phase"], "unavailable");
        assert_eq!(v["providerConnected"], false);
        let t = local_status_unavailable(e.as_ref(), "list_tasks").unwrap();
        assert_eq!(t["available"], false);
        assert!(local_status_unavailable(e.as_ref(), "thread_send").is_none());
    }

    #[test]
    fn engine_runtime_state_is_kept_and_annotated() {
        let e: Engine = Arc::new(NoEngine);
        let guest = serde_json::json!({"phase":"ready","providerConnected":true,"canOpenProjects":true,"message":null});
        let v = annotate_runtime_state(e.as_ref(), guest);
        assert_eq!(v["phase"], "ready");
        assert_eq!(v["providerConnected"], true);
        assert_eq!(
            v["canOpenProjects"], true,
            "a Mac folder opens through the native picker"
        );
        assert!(v["message"].as_str().unwrap().contains("Linux"));
    }

    #[test]
    fn mock_runs_are_never_served() {
        assert!(NEVER_SERVED.contains(&"run_mock"));
        assert!(!LOCAL_COMMANDS.contains(&"run_mock"));
        assert!(!STATUS_COMMANDS.contains(&"run_mock"));
    }
}
