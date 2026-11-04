//! Host side of the Linux engine bridge: one supervised child process (SSH in production)
//! whose stdio carries [`crate::bridge_proto`] lines.
//!
//! * One connection at a time, reconnected with back-off after any failure (guest reboot,
//!   network loss, bridge crash). Every in-flight call fails with a clear error the moment
//!   the connection dies; nothing is retried or replayed behind the person's back.
//! * Authentication is the transport's (SSH key, pinned host key, forced command on the
//!   guest). This module adds no trust: it only forwards named commands and answers the
//!   guest's confirmations through the host's native dialogs.

use crate::bridge_proto::*;
use crate::dialogs::Dialogs;
use crate::dto::UiError;
use crate::engine::{EngineDiagnostics, EngineLink, EngineStatus};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const HELLO_TIMEOUT: Duration = Duration::from_secs(20);
const PING_EVERY: Duration = Duration::from_secs(5);
const PONG_DEADLINE: Duration = Duration::from_secs(20);

/// Starts the process that speaks the bridge protocol on its stdio.
pub trait Transport: Send + Sync + 'static {
    fn spawn(&self) -> std::io::Result<Child>;
    /// Short, non-secret description for diagnostics.
    fn describe(&self) -> String;
}

/// `ssh` to the guest. The guest's `authorized_keys` entry for the key forces the bridge as
/// the only command (`restrict,command=...`), so the client names no command at all.
#[derive(Debug, Clone)]
pub struct SshTransport {
    pub host: String,
    pub user: String,
    pub identity_file: PathBuf,
    /// The app's own pinned host-key file; a changed key refuses the connection.
    pub known_hosts: PathBuf,
}

impl Transport for SshTransport {
    fn spawn(&self) -> std::io::Result<Child> {
        Command::new("/usr/bin/ssh")
            .arg("-T")
            .args(["-o", "BatchMode=yes"])
            .args(["-o", "IdentitiesOnly=yes"])
            .args(["-o", "StrictHostKeyChecking=yes"])
            .args(["-o", "PasswordAuthentication=no"])
            .args(["-o", "ForwardAgent=no"])
            .args(["-o", "ClearAllForwardings=yes"])
            .args(["-o", "ControlMaster=no", "-o", "ControlPath=none"])
            .args(["-o", "ConnectTimeout=8"])
            .args(["-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"])
            .arg("-i")
            .arg(&self.identity_file)
            .arg("-o")
            // ssh splits option values on spaces ("Application Support"), so the path is quoted
            .arg(format!(
                "UserKnownHostsFile=\"{}\"",
                self.known_hosts.display()
            ))
            .arg(format!("{}@{}", self.user, self.host))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }

    fn describe(&self) -> String {
        format!("ssh {}@{}", self.user, self.host)
    }
}

type Reply = Result<Value, UiError>;

struct Conn {
    stdin: Mutex<ChildStdin>,
    /// `None` once the connection is closed: late callers fail instead of waiting forever.
    pending: Mutex<Option<HashMap<u64, Sender<Reply>>>>,
}

enum Event {
    Line(ToHost),
    Closed(String),
}

#[derive(Default)]
struct Info {
    status: Option<EngineStatus>,
    hello: Option<Hello>,
    guest_phase: Option<String>,
    last_error: Option<String>,
    connected_since: Option<Instant>,
    attempts: u64,
    last_pong_ms: Option<u128>,
}

struct Shared {
    transport: Box<dyn Transport>,
    dialogs: Arc<dyn Dialogs>,
    host_version: String,
    info: Mutex<Info>,
    conn: Mutex<Option<Arc<Conn>>>,
    next_id: AtomicU64,
    shutdown: AtomicBool,
    wake: (Mutex<bool>, Condvar),
}

pub struct BridgeLink {
    shared: Arc<Shared>,
    supervisor: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl BridgeLink {
    /// Start the supervisor; the first connection attempt begins immediately.
    pub fn start(
        transport: Box<dyn Transport>,
        dialogs: Arc<dyn Dialogs>,
        host_version: &str,
    ) -> Arc<BridgeLink> {
        let shared = Arc::new(Shared {
            transport,
            dialogs,
            host_version: host_version.to_owned(),
            info: Mutex::new(Info {
                status: Some(EngineStatus::Connecting),
                ..Info::default()
            }),
            conn: Mutex::new(None),
            next_id: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
            wake: (Mutex::new(false), Condvar::new()),
        });
        let s = shared.clone();
        let handle = std::thread::Builder::new()
            .name("nexus-bridge-link".into())
            .spawn(move || supervise(s))
            .expect("spawn bridge supervisor");
        Arc::new(BridgeLink {
            shared,
            supervisor: Mutex::new(Some(handle)),
        })
    }

    fn set_status(shared: &Shared, s: EngineStatus) {
        if let Ok(mut i) = shared.info.lock() {
            i.status = Some(s);
        }
    }
}

impl BridgeLink {
    /// Send one request line and wait for its reply (or for the connection to die).
    fn request(&self, make: impl FnOnce(u64) -> ToGuest) -> Reply {
        let st = self.status();
        if !st.is_ready() {
            return Err(st.unavailable_error());
        }
        let conn = self
            .shared
            .conn
            .lock()
            .ok()
            .and_then(|c| c.clone())
            .ok_or_else(|| self.status().unavailable_error())?;
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        match conn.pending.lock().map_err(|_| lost())?.as_mut() {
            Some(p) => {
                p.insert(id, tx);
            }
            None => return Err(lost()),
        }
        let line = encode(&make(id));
        if write_line(&conn, &line).is_err() {
            if let Ok(mut p) = conn.pending.lock() {
                if let Some(p) = p.as_mut() {
                    p.remove(&id);
                }
            }
            return Err(lost());
        }
        // No timeout: a task may legitimately run for a long time. A dead connection fails
        // every pending call (the sender is dropped / answered by the supervisor).
        rx.recv().unwrap_or_else(|_| Err(lost()))
    }
}

impl EngineLink for BridgeLink {
    fn status(&self) -> EngineStatus {
        self.shared
            .info
            .lock()
            .ok()
            .and_then(|i| i.status.clone())
            .unwrap_or(EngineStatus::Connecting)
    }

    fn call(&self, cmd: &str, args: Value) -> Reply {
        let cmd = cmd.to_owned();
        self.request(move |id| ToGuest::Call { id, cmd, args })
    }

    fn sync(&self, req: crate::sync::wire::SyncReq) -> Reply {
        self.request(move |id| ToGuest::Sync { id, req })
    }

    fn diagnostics(&self) -> EngineDiagnostics {
        let i = match self.shared.info.lock() {
            Ok(i) => i,
            Err(_) => return EngineDiagnostics::default(),
        };
        let mut lines = vec![
            format!("Transport: {}", self.shared.transport.describe()),
            format!(
                "State: {}",
                i.status
                    .as_ref()
                    .map(|s| s.code())
                    .unwrap_or("engine-connecting")
            ),
            format!("Connection attempts: {}", i.attempts),
        ];
        if let Some(h) = &i.hello {
            lines.push(format!(
                "Engine: Nexus {} on {} (bridge protocol {}, client API v{}, IPC v{}, user id {})",
                h.app_version, h.hostname, h.proto, h.client_api_version, h.ipc_protocol, h.uid
            ));
        }
        if let Some(p) = &i.guest_phase {
            lines.push(format!("Engine runtime: {p}"));
        }
        if let Some(t) = i.connected_since {
            lines.push(format!("Connected for {}s", t.elapsed().as_secs()));
        }
        if let Some(ms) = i.last_pong_ms {
            lines.push(format!("Last round trip: {ms} ms"));
        }
        if let Some(e) = &i.last_error {
            lines.push(format!("Last problem: {e}"));
        }
        EngineDiagnostics { lines }
    }

    fn reconnect(&self) {
        let (m, c) = &self.shared.wake;
        if let Ok(mut g) = m.lock() {
            *g = true;
            c.notify_all();
        }
    }

    fn shutdown(&self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.reconnect();
        if let Some(h) = self.supervisor.lock().ok().and_then(|mut h| h.take()) {
            let _ = h.join();
        }
    }
}

fn lost() -> UiError {
    UiError {
        code: "engine-disconnected".to_owned(),
        message: "The connection to the Linux engine was lost before this finished. The request may or may not have reached the engine; check the task list before repeating it.".to_owned(),
    }
}

fn write_line(conn: &Conn, line: &str) -> std::io::Result<()> {
    let mut w = conn
        .stdin
        .lock()
        .map_err(|_| std::io::Error::other("poisoned"))?;
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// Read one line of at most [`MAX_LINE_BYTES`]; `Ok(None)` = end of stream.
fn read_bounded_line<R: BufRead>(r: &mut R) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    let n = r
        .by_ref()
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() > MAX_LINE_BYTES {
        return Err(std::io::Error::other("protocol line too long"));
    }
    String::from_utf8(buf)
        .map(|s| Some(s.trim_end().to_owned()))
        .map_err(|_| std::io::Error::other("protocol line is not text"))
}

fn sleep_or_wake(shared: &Shared, d: Duration) {
    let (m, c) = &shared.wake;
    if let Ok(g) = m.lock() {
        let (mut g, _) = c
            .wait_timeout_while(g, d, |woken| {
                !*woken && !shared.shutdown.load(Ordering::SeqCst)
            })
            .unwrap_or_else(|e| e.into_inner());
        *g = false;
    }
}

fn supervise(shared: Arc<Shared>) {
    let mut backoff = Duration::from_secs(1);
    while !shared.shutdown.load(Ordering::SeqCst) {
        if let Ok(mut i) = shared.info.lock() {
            i.attempts += 1;
            i.status = Some(EngineStatus::Connecting);
        }
        let outcome = run_connection(&shared);
        // the connection is gone: nobody may use it any more
        if let Ok(mut c) = shared.conn.lock() {
            *c = None;
        }
        if shared.shutdown.load(Ordering::SeqCst) {
            break;
        }
        let (status, was_connected) = match outcome {
            Outcome::Incompatible(m) => (EngineStatus::Error { detail: m.clone() }, false),
            Outcome::Failed(m) => (EngineStatus::Disconnected { detail: m.clone() }, false),
            Outcome::Dropped(m) => (EngineStatus::Disconnected { detail: m.clone() }, true),
        };
        eprintln!(
            "nexus: engine link: {}",
            match &status {
                EngineStatus::Disconnected { detail } | EngineStatus::Error { detail } =>
                    detail.as_str(),
                _ => "ended",
            }
        );
        if let Ok(mut i) = shared.info.lock() {
            i.last_error = match &status {
                EngineStatus::Disconnected { detail } | EngineStatus::Error { detail } => {
                    Some(detail.clone())
                }
                _ => None,
            };
            i.connected_since = None;
            i.guest_phase = None;
            i.status = Some(status);
        }
        backoff = if was_connected {
            Duration::from_secs(1)
        } else {
            (backoff * 2).min(Duration::from_secs(15))
        };
        sleep_or_wake(&shared, backoff);
    }
    BridgeLink::set_status(
        &shared,
        EngineStatus::Disconnected {
            detail: "stopped".to_owned(),
        },
    );
}

enum Outcome {
    /// Never became usable (spawn error, ssh failure, no hello).
    Failed(String),
    /// Connected and compatible, then lost.
    Dropped(String),
    /// Reached a bridge we must not use.
    Incompatible(String),
}

fn run_connection(shared: &Arc<Shared>) -> Outcome {
    let mut child = match shared.transport.spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(format!("cannot start the connection: {e}")),
    };
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Outcome::Failed("cannot attach to the connection".to_owned());
    };
    // keep the tail of stderr: it carries ssh's own reason ("Permission denied", "No route")
    let err_tail = Arc::new(Mutex::new(String::new()));
    {
        let t = err_tail.clone();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stderr);
            let mut line = String::new();
            while r.read_line(&mut line).unwrap_or(0) > 0 {
                if let Ok(mut t) = t.lock() {
                    t.push_str(&line);
                    let n = t.len();
                    if n > 1024 {
                        *t = t[n - 1024..].to_owned();
                    }
                }
                line.clear();
            }
        });
    }
    let (ev_tx, ev_rx): (Sender<Event>, Receiver<Event>) = channel();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        loop {
            match read_bounded_line(&mut r) {
                Ok(Some(l)) if l.is_empty() => continue,
                Ok(Some(l)) => match serde_json::from_str::<ToHost>(&l) {
                    Ok(m) => {
                        if ev_tx.send(Event::Line(m)).is_err() {
                            return;
                        }
                    }
                    Err(_) => {
                        let _ = ev_tx.send(Event::Closed(
                            "the engine sent an unreadable message".into(),
                        ));
                        return;
                    }
                },
                Ok(None) => {
                    let _ = ev_tx.send(Event::Closed("the connection closed".into()));
                    return;
                }
                Err(e) => {
                    let _ = ev_tx.send(Event::Closed(e.to_string()));
                    return;
                }
            }
        }
    });

    let stderr_note = |base: String| -> String {
        let t = err_tail
            .lock()
            .map(|t| t.trim().to_owned())
            .unwrap_or_default();
        // ssh reasons are one short line each; show the last one
        match t.lines().last() {
            Some(l) if !l.is_empty() => format!("{base}: {l}"),
            _ => base,
        }
    };

    // 1. hello
    let hello = match ev_rx.recv_timeout(HELLO_TIMEOUT) {
        Ok(Event::Line(ToHost::Hello(h))) => h,
        Ok(Event::Line(_)) => {
            kill(&mut child);
            return Outcome::Incompatible("the engine did not introduce itself".to_owned());
        }
        Ok(Event::Closed(m)) => {
            kill(&mut child);
            return Outcome::Failed(stderr_note(m));
        }
        Err(_) => {
            kill(&mut child);
            return Outcome::Failed(stderr_note("the engine did not answer in time".to_owned()));
        }
    };
    if let Err(m) = check_hello(&hello, &shared.host_version) {
        kill(&mut child);
        if let Ok(mut i) = shared.info.lock() {
            i.hello = Some(hello);
        }
        return Outcome::Incompatible(m);
    }
    let conn = Arc::new(Conn {
        stdin: Mutex::new(stdin),
        pending: Mutex::new(Some(HashMap::new())),
    });
    if let Ok(mut i) = shared.info.lock() {
        i.hello = Some(hello);
        i.connected_since = Some(Instant::now());
        i.last_error = None;
        i.status = Some(EngineStatus::Ready);
    }
    if let Ok(mut c) = shared.conn.lock() {
        *c = Some(conn.clone());
    }

    // 2. serve until the connection ends
    let mut ping_n = 0u64;
    let mut last_ping = Instant::now() - PING_EVERY;
    let mut last_pong = Instant::now();
    let mut ping_sent_at = Instant::now();
    let reason = loop {
        if shared.shutdown.load(Ordering::SeqCst) {
            break "stopped".to_owned();
        }
        if last_ping.elapsed() >= PING_EVERY {
            ping_n += 1;
            ping_sent_at = Instant::now();
            last_ping = ping_sent_at;
            if write_line(&conn, &encode(&ToGuest::Ping { n: ping_n })).is_err() {
                break stderr_note("the connection was lost".to_owned());
            }
        }
        if last_pong.elapsed() > PONG_DEADLINE {
            break "the engine stopped answering".to_owned();
        }
        match ev_rx.recv_timeout(Duration::from_millis(500)) {
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                break stderr_note("the connection closed".into())
            }
            Ok(Event::Closed(m)) => break stderr_note(m),
            Ok(Event::Line(m)) => match m {
                ToHost::Ok { id, value } => complete(&conn, id, Ok(value)),
                ToHost::Err { id, error } => complete(&conn, id, Err(error)),
                ToHost::Pong {
                    n,
                    phase,
                    active_runs,
                } => {
                    if n == ping_n {
                        last_pong = Instant::now();
                    }
                    if let Ok(mut i) = shared.info.lock() {
                        i.last_pong_ms = Some(ping_sent_at.elapsed().as_millis());
                        i.guest_phase = Some(phase);
                        i.status = Some(match active_runs {
                            Some(a) if a > 0 => EngineStatus::Busy { active_runs: a },
                            _ => EngineStatus::Ready,
                        });
                    }
                }
                ToHost::Confirm { id, title, text } => {
                    let (d, c) = (shared.dialogs.clone(), conn.clone());
                    std::thread::spawn(move || {
                        let t: String = title.chars().take(MAX_DIALOG_TITLE).collect();
                        let x: String = text.chars().take(MAX_DIALOG_TEXT).collect();
                        // a dialog that cannot be shown is never an approval, and is reported as a failure
                        // (not as the person saying no) so it surfaces with a reason
                        let (allowed, error) = match d.confirm(&t, &x) {
                            Ok(a) => (a, None),
                            Err(e) => (false, Some(e)),
                        };
                        let _ =
                            write_line(&c, &encode(&ToGuest::ConfirmReply { id, allowed, error }));
                    });
                }
                ToHost::Secret { id, title, prompt } => {
                    let (d, c) = (shared.dialogs.clone(), conn.clone());
                    std::thread::spawn(move || {
                        let t: String = title.chars().take(MAX_DIALOG_TITLE).collect();
                        let x: String = prompt.chars().take(MAX_DIALOG_TEXT).collect();
                        // a prompt that cannot be shown or is cancelled yields no secret
                        let (value, error) = match d.secret(&t, &x) {
                            Ok(v) => (v, None),
                            Err(e) => (None, Some(e)),
                        };
                        let _ = write_line(&c, &encode(&ToGuest::SecretReply { id, value, error }));
                    });
                }
                ToHost::Hello(_) => break "the engine sent a second hello".to_owned(),
            },
        }
    };

    // 3. teardown: fail everything in flight, then close the process
    if let Ok(mut p) = conn.pending.lock() {
        if let Some(map) = p.take() {
            for (_, tx) in map {
                let _ = tx.send(Err(lost()));
            }
        }
    }
    kill(&mut child);
    Outcome::Dropped(reason)
}

fn complete(conn: &Conn, id: u64, r: Reply) {
    let tx = conn
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.as_mut().and_then(|m| m.remove(&id)));
    if let Some(tx) = tx {
        let _ = tx.send(r);
    }
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
