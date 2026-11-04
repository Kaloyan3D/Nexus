//! Guest side of the macOS engine bridge (`nexus-bridge --stdio`).
//!
//! It serves the SAME command set the Linux desktop window serves, by dispatching each request
//! through the real registered Tauri handler (`invoke_handler`) of a headless mock-runtime app
//! that holds the same state (`Runtime`, `ClientConfig`). Validation, idempotency keys, grants,
//! approvals and every refusal therefore come from the existing code, not from a copy.
//!
//! Trust model: the bridge runs as the SSH-authenticated user (the forced command of the
//! restricted key), so its broker calls carry that user's real peer credentials exactly like
//! the Linux desktop's. It never exposes a socket; stdio is the only channel. Dialogs that need a
//! person are forwarded to the Mac as native confirmations; everything else a dialog could do
//! (folders, secrets, browsers) fails closed.

use super::{invoke_handler, AppState};
use crate::bridge_proto::*;
use crate::dialogs::Dialogs;
use crate::dto::UiError;
use crate::interactive;
use crate::sync::guest::GuestStore;
use crate::sync::wire::{SyncReq, SYNC_VERSION};
use nexus_client::intent_client as ic;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindowBuilder};

/// Calls served at once. The UI issues bursts of reads; a bound keeps one connection from
/// starving the guest.
const MAX_IN_FLIGHT: usize = 32;
/// Seconds of silence from the Mac after which this connection is considered dead.
const IDLE_LIMIT_SECS: u64 = 90;

struct Out(Mutex<Box<dyn Write + Send>>);

impl Out {
    fn send(&self, m: &ToHost) -> std::io::Result<()> {
        let mut w = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("poisoned"))?;
        w.write_all(encode(m).as_bytes())?;
        w.write_all(b"\n")?;
        w.flush()
    }
}

/// What the Mac answered to a secret prompt: the text, nothing (cancelled), or why it could not ask.
type SecretAnswer = Result<Option<String>, String>;

/// Dialogs of the guest runtime: only "confirm" reaches a person, and only on the Mac.
struct RemoteDialogs {
    /// The connection a person's answer is asked on (the newest one).
    out: Mutex<Arc<Out>>,
    waiting: Mutex<HashMap<u64, Sender<Result<bool, String>>>>,
    secrets: Mutex<HashMap<u64, Sender<SecretAnswer>>>,
    next: AtomicU64,
}

impl RemoteDialogs {
    fn answer(&self, id: u64, allowed: bool, error: Option<String>) {
        if let Some(tx) = self.waiting.lock().ok().and_then(|mut w| w.remove(&id)) {
            let _ = tx.send(match error {
                Some(e) => Err(format!("the Mac could not show the confirmation: {e}")),
                None => Ok(allowed),
            });
        }
    }

    fn answer_secret(&self, id: u64, value: Option<String>, error: Option<String>) {
        if let Some(tx) = self.secrets.lock().ok().and_then(|mut w| w.remove(&id)) {
            let _ = tx.send(match error {
                Some(e) => Err(format!("the Mac could not show the prompt: {e}")),
                None => Ok(value),
            });
        }
    }

    /// The Mac went away: nobody can answer, so every open question is a refusal.
    fn refuse_all(&self) {
        if let Ok(mut w) = self.waiting.lock() {
            for (_, tx) in w.drain() {
                let _ = tx.send(Ok(false));
            }
        }
        if let Ok(mut w) = self.secrets.lock() {
            for (_, tx) in w.drain() {
                let _ = tx.send(Ok(None));
            }
        }
    }
}

impl Dialogs for RemoteDialogs {
    fn pick_folder(&self, _title: &str) -> Result<Option<String>, String> {
        Err("choosing a folder on the Mac is not supported by the engine bridge yet".to_owned())
    }

    fn confirm(&self, title: &str, text: &str) -> Result<bool, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.waiting
            .lock()
            .map_err(|_| "poisoned".to_owned())?
            .insert(id, tx);
        let out = self.out.lock().map_err(|_| "poisoned".to_owned())?.clone();
        let sent = out.send(&ToHost::Confirm {
            id,
            title: title.to_owned(),
            text: text.to_owned(),
        });
        if sent.is_err() {
            return Err("the Mac is no longer connected".to_owned());
        }
        // `Err` inside: the Mac could not show the dialog (a failure with a reason, not a "no")
        rx.recv()
            .map_err(|_| "the Mac is no longer connected".to_owned())?
    }

    fn secret(&self, title: &str, prompt: &str) -> Result<Option<String>, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.secrets
            .lock()
            .map_err(|_| "poisoned".to_owned())?
            .insert(id, tx);
        let out = self.out.lock().map_err(|_| "poisoned".to_owned())?.clone();
        let sent = out.send(&ToHost::Secret {
            id,
            title: title.to_owned(),
            prompt: prompt.to_owned(),
        });
        if sent.is_err() {
            return Err("the Mac is no longer connected".to_owned());
        }
        // `Err` inside: the Mac could not show the dialog (a failure with a reason, not a "no")
        rx.recv()
            .map_err(|_| "the Mac is no longer connected".to_owned())?
    }
}

fn ui_error(code: &str, message: impl Into<String>) -> UiError {
    UiError {
        code: code.to_owned(),
        message: message.into(),
    }
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

fn current_uid() -> u32 {
    // /proc/self is owned by the effective uid of the process
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .unwrap_or(u32::MAX)
}

/// Run until the host closes stdin. Returns the process exit code.
/// State shared by every connection: one runtime, one command window, one staging store.
struct Core {
    runtime: Arc<interactive::Runtime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    store: Arc<GuestStore>,
    dialogs: Arc<RemoteDialogs>,
    in_flight: Arc<AtomicUsize>,
}

/// The `App` must outlive the `Core` (it owns the command window) but is not `Sync`, so the caller keeps it.
fn build_core(first: Arc<Out>) -> Result<(Core, tauri::App<tauri::test::MockRuntime>), i32> {
    let dialogs = Arc::new(RemoteDialogs {
        out: Mutex::new(first),
        waiting: Mutex::new(HashMap::new()),
        secrets: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
    });
    // Same wiring as the desktop window: the runtime attaches to (or starts) the engine under
    // NEXUS_HOME and supervises it. The bridge never stops it when the Mac disconnects.
    let runtime = Arc::new(interactive::Runtime::new());
    interactive::install(runtime.clone());
    runtime.watch_for_updates();
    runtime.start_async();
    let cfg = match nexus_client::ClientConfig::resolve(None, None, false) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nexus-bridge: client configuration: {e:?}");
            return Err(2);
        }
    };
    let app = mock_builder()
        .invoke_handler(invoke_handler())
        .build(tauri::generate_context!())
        .expect("bridge app");
    app.manage(runtime.clone());
    app.manage::<Arc<dyn Dialogs>>(dialogs.clone());
    app.manage(AppState::new(cfg));
    // The window comes from the real tauri.conf.json, so the real ACL (build.rs manifest +
    // capabilities/main.json) decides which commands may run, exactly as in the desktop window.
    let window_cfg = app
        .config()
        .app
        .windows
        .first()
        .expect("a window in tauri.conf.json")
        .clone();
    let window = WebviewWindowBuilder::from_config(&app, &window_cfg)
        .expect("bridge window config")
        .build()
        .expect("bridge window");
    Ok((
        Core {
            runtime,
            window,
            store: Arc::new(GuestStore::new(mac_root())),
            dialogs,
            in_flight: Arc::new(AtomicUsize::new(0)),
        },
        app,
    ))
}

/// Run until the host closes stdin. Returns the process exit code.
pub fn run_bridge() -> i32 {
    let out = Arc::new(Out(Mutex::new(Box::new(std::io::stdout()))));
    let (core, _app) = match build_core(out.clone()) {
        Ok(c) => c,
        Err(code) => return code,
    };
    serve_connection(&core, std::io::stdin().lock(), out, || {
        std::process::exit(0)
    });
    0
}

/// `nexus-bridge --vsock PORT`: a long-lived service. The Mac (through the VM runner) connects over
/// virtio-vsock; the newest connection replaces the previous one. The engine keeps running between
/// connections (it is owned by this process's runtime, not by a connection).
pub fn run_bridge_vsock(port: u32) -> i32 {
    use std::os::fd::{AsRawFd, FromRawFd};
    // a connection-less placeholder until the first host connects
    let placeholder = Arc::new(Out(Mutex::new(Box::new(std::io::sink()))));
    let (core, _app) = match build_core(placeholder) {
        Ok((c, a)) => (Arc::new(c), a),
        Err(code) => return code,
    };
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        eprintln!(
            "nexus-bridge: no vsock support: {}",
            std::io::Error::last_os_error()
        );
        return 3;
    }
    let mut addr: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
    addr.svm_port = port;
    addr.svm_cid = libc::VMADDR_CID_ANY;
    let rc = unsafe {
        libc::bind(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if rc != 0 || unsafe { libc::listen(fd, 4) } != 0 {
        eprintln!(
            "nexus-bridge: cannot listen on vsock port {port}: {}",
            std::io::Error::last_os_error()
        );
        return 3;
    }
    eprintln!("nexus-bridge: listening on vsock port {port}");
    let current: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
    loop {
        let mut peer: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
        let c = unsafe { libc::accept(fd, &mut peer as *mut _ as *mut libc::sockaddr, &mut len) };
        if c < 0 {
            continue;
        }
        // Only the host (CID 2) is a legitimate peer on this socket.
        if peer.svm_cid != libc::VMADDR_CID_HOST {
            unsafe { libc::close(c) };
            continue;
        }
        if let Some(old) = current.lock().ok().and_then(|mut g| g.replace(c)) {
            unsafe { libc::shutdown(old, libc::SHUT_RDWR) };
        }
        let core = core.clone();
        let current = current.clone();
        std::thread::spawn(move || {
            let file = unsafe { std::fs::File::from_raw_fd(c) };
            let writer = file.try_clone().expect("clone vsock fd");
            let out = Arc::new(Out(Mutex::new(Box::new(writer))));
            if let Ok(mut g) = core.dialogs.out.lock() {
                *g = out.clone();
            }
            let raw = file.as_raw_fd();
            serve_connection(&core, std::io::BufReader::new(file), out, move || unsafe {
                libc::shutdown(raw, libc::SHUT_RDWR);
            });
            if let Ok(mut g) = current.lock() {
                if *g == Some(c) {
                    *g = None;
                }
            }
        });
    }
}

/// Serve one host connection until it ends. `on_idle` is called when the host has been silent too long.
fn serve_connection<R: BufRead>(
    core: &Core,
    mut input: R,
    out: Arc<Out>,
    on_idle: impl Fn() + Send + 'static,
) {
    let (runtime, window, store, dialogs, in_flight) = (
        &core.runtime,
        &core.window,
        &core.store,
        &core.dialogs,
        &core.in_flight,
    );
    if out
        .send(&ToHost::Hello(Hello {
            proto: PROTO_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            client_api_version: nexus_client::CLIENT_API_VERSION,
            ipc_protocol: nexus_client::IPC_PROTOCOL_VERSION,
            sync: SYNC_VERSION,
            uid: current_uid(),
            hostname: hostname(),
        }))
        .is_err()
    {
        return;
    }
    // The Mac pings every few seconds. A connection that has gone silent (network cut without a clean
    // close) must not linger: after IDLE_LIMIT_SECS without any line it is ended.
    // The engine keeps running; only this connection ends.
    let started_at = std::time::Instant::now();
    let last_rx = Arc::new(AtomicU64::new(0));
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let (last_rx, dialogs, finished) = (last_rx.clone(), dialogs.clone(), finished.clone());
        std::thread::spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if started_at
                    .elapsed()
                    .as_secs()
                    .saturating_sub(last_rx.load(Ordering::SeqCst))
                    > IDLE_LIMIT_SECS
                {
                    dialogs.refuse_all();
                    on_idle();
                    return;
                }
            }
        });
    }
    loop {
        let line = match read_line(&mut input) {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(_) => break,
        };
        last_rx.store(started_at.elapsed().as_secs(), Ordering::SeqCst);
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<ToGuest>(&line) else {
            // not in the protocol: end the session rather than guess
            break;
        };
        match msg {
            ToGuest::Ping { n } => {
                let active = interactive_active_runs(runtime);
                let _ = out.send(&ToHost::Pong {
                    n,
                    phase: runtime.phase_name(),
                    active_runs: active,
                });
            }
            ToGuest::ConfirmReply { id, allowed, error } => dialogs.answer(id, allowed, error),
            ToGuest::SecretReply { id, value, error } => dialogs.answer_secret(id, value, error),
            ToGuest::Sync { id, req } => {
                if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    let _ = out.send(&ToHost::Err {
                        id,
                        error: ui_error("busy", "the engine bridge is serving too many requests"),
                    });
                    continue;
                }
                let (out, store, runtime, in_flight) = (
                    out.clone(),
                    store.clone(),
                    runtime.clone(),
                    in_flight.clone(),
                );
                std::thread::spawn(move || {
                    let reply = sync_dispatch(&store, &runtime, req);
                    let _ = out.send(&match reply {
                        Ok(value) => ToHost::Ok { id, value },
                        Err(error) => ToHost::Err { id, error },
                    });
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                });
            }
            ToGuest::Call { id, cmd, args } => {
                if BRIDGE_REFUSES.contains(&cmd.as_str()) {
                    let _ = out.send(&ToHost::Err {
                        id,
                        error: ui_error(
                            "engine-unsupported",
                            format!("`{cmd}` is not available through the engine bridge"),
                        ),
                    });
                    continue;
                }
                if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    let _ = out.send(&ToHost::Err {
                        id,
                        error: ui_error("busy", "the engine bridge is serving too many requests"),
                    });
                    continue;
                }
                let (out, window, in_flight) = (out.clone(), window.clone(), in_flight.clone());
                std::thread::spawn(move || {
                    let reply = dispatch(&window, &cmd, args);
                    let _ = out.send(&match reply {
                        Ok(value) => ToHost::Ok { id, value },
                        Err(error) => ToHost::Err { id, error },
                    });
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                });
            }
        }
    }
    finished.store(true, Ordering::SeqCst);
    // the connection ended (Mac quit or the link dropped): no dialog can be answered any more
    dialogs.refuse_all();
}

/// The Nexus-owned staging root: nothing outside it is ever read or written by a sync request.
fn mac_root() -> std::path::PathBuf {
    let root = std::env::var_os("NEXUS_MAC_ROOT")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("NexusMac")))
        .expect("HOME");
    use std::os::unix::fs::DirBuilderExt;
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root);
    root
}

fn sync_ui_error(e: crate::sync::wire::SyncErr) -> UiError {
    ui_error(&e.code, e.message)
}

/// One project-transfer request. Operations that replace the working copy wait for an idle
/// engine, so a running task never has its files swapped underneath it.
fn sync_dispatch(
    store: &GuestStore,
    runtime: &interactive::Runtime,
    req: SyncReq,
) -> Result<Value, UiError> {
    let changes_files = matches!(
        req,
        SyncReq::StageBegin { .. } | SyncReq::StageCommit { .. } | SyncReq::Discard { .. }
    );
    if changes_files && !matches!(runtime.active_run_count(), Ok(0)) {
        return Err(ui_error(
            "engine-busy",
            "the engine is running a task; the project is refreshed when it finishes",
        ));
    }
    let is_commit = matches!(req, SyncReq::StageCommit { .. });
    let mut out = store.handle(req).map_err(sync_ui_error)?;
    if is_commit {
        let work = out["workPath"].as_str().unwrap_or_default().to_owned();
        let reg = register_project(&work)?;
        if let (Some(o), Some(r)) = (out.as_object_mut(), reg.as_object()) {
            for (k, v) in r {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(out)
}

/// Open the staged working copy as a real Nexus project (Direct Workspace: the engine edits this
/// guest folder; the Mac folder is only changed by the verified writeback).
fn register_project(work: &str) -> Result<Value, UiError> {
    let sock = ic::default_broker_socket();
    let e = |c: &dyn std::fmt::Display, m: &dyn std::fmt::Display| {
        ui_error(&c.to_string(), m.to_string())
    };
    let v = ic::project_open_with(&sock, work, None).map_err(|x| e(&x.code, &x.message))?;
    let id = v["project"]["projectId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if v["project"]["workspaceMode"].as_str() != Some("direct") {
        ic::project_set_workspace(&sock, &id, "direct").map_err(|x| e(&x.code, &x.message))?;
    }
    Ok(serde_json::json!({
        "guestProjectId": id,
        "registeredNew": v["created"],
        "snapshot": v["snapshot"],
    }))
}

fn interactive_active_runs(rt: &interactive::Runtime) -> Option<u64> {
    rt.active_run_count().ok().map(|n| n as u64)
}

/// Dispatch through the registered handler, so the real argument decoding and every refusal
/// of the Linux command layer applies.
fn dispatch(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, UiError> {
    let request = InvokeRequest {
        cmd: cmd.to_owned(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "tauri://localhost".parse().expect("url"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    match get_ipc_response(window, request) {
        Ok(InvokeResponseBody::Json(s)) => {
            serde_json::from_str(&s).map_err(|_| ui_error("internal", "unreadable command result"))
        }
        Ok(InvokeResponseBody::Raw(_)) => Err(ui_error("internal", "unexpected binary result")),
        Err(v) => Err(serde_json::from_value::<UiError>(v.clone())
            .unwrap_or_else(|_| ui_error("command", v.to_string()))),
    }
}

/// One protocol line, bounded.
fn read_line<R: BufRead>(r: &mut R) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    let n = r
        .by_ref()
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() > MAX_LINE_BYTES {
        return Err(std::io::Error::other("line too long"));
    }
    String::from_utf8(buf)
        .map(|s| Some(s.trim_end().to_owned()))
        .map_err(|_| std::io::Error::other("not text"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dialogs() -> Arc<RemoteDialogs> {
        Arc::new(RemoteDialogs {
            out: Mutex::new(Arc::new(Out(Mutex::new(Box::new(std::io::sink()))))),
            waiting: Mutex::new(HashMap::new()),
            secrets: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        })
    }

    /// Wait until the dialog has registered its question, then answer it.
    fn ask(
        d: &Arc<RemoteDialogs>,
        answer: impl FnOnce(&RemoteDialogs, u64),
    ) -> Result<bool, String> {
        let d2 = d.clone();
        let t = std::thread::spawn(move || d2.confirm("T", "text"));
        loop {
            let id = d.waiting.lock().unwrap().keys().next().copied();
            if let Some(id) = id {
                answer(d, id);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        t.join().unwrap()
    }

    #[test]
    fn the_persons_yes_and_no_reach_the_command_that_asked() {
        let d = dialogs();
        assert_eq!(ask(&d, |d, id| d.answer(id, true, None)), Ok(true));
        assert_eq!(ask(&d, |d, id| d.answer(id, false, None)), Ok(false));
    }

    #[test]
    fn a_confirmation_the_mac_could_not_show_is_an_error_with_a_reason_not_a_no() {
        let d = dialogs();
        let r = ask(&d, |d, id| d.answer(id, false, Some("no display".into())));
        let e = r.unwrap_err();
        assert!(
            e.contains("could not show the confirmation") && e.contains("no display"),
            "{e}"
        );
    }

    #[test]
    fn a_dropped_connection_refuses_every_open_question() {
        let d = dialogs();
        let r = ask(&d, |d, _| d.refuse_all());
        assert_eq!(r, Ok(false));
    }
}
