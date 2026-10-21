//! EM-04C1: the persistent, supervised Node worker behind the Muse Governor and Signals bridge.
//!
//! The one-shot bridge ([`super::governor_bridge::NodeGovernorBridge`]) starts a Node process for
//! every evaluation (≈ 174 ms Governor, ≈ 81 ms signal, mostly process start). This supervisor
//! keeps ONE process alive per run and talks to it over the versioned, length-framed protocol of
//! `muse_bridge_worker.cjs`. The algorithms are the same unchanged historical CommonJS modules,
//! run by the unchanged one-shot bridge source in a fresh closure for every request.
//!
//! Ownership and authority:
//! * The supervisor OWNS the process: it spawns it lazily, restarts it after a failure, kills it
//!   on cancellation, timeout, protocol violation and `Drop`. There is no daemon, no pool shared
//!   across runs, and nothing outlives the owner (EOF on the worker's stdin also ends it).
//! * The worker is LOGICALLY STATELESS. It receives the complete Muse blocks with every request
//!   and returns the complete result; the Broker's engine state is the only ledger. A restart
//!   therefore loses nothing, and a retried request returns the same answer.
//! * The worker has no credentials, no environment (`env_clear`), no Kernel or Registry handle and
//!   no file or network access of its own; it can only answer frames.
//!
//! Every boundary is validated here, in Rust: frame size (both ways), strict envelope shape,
//! protocol version, request id (each answered exactly once, strictly in order), scope echo, the
//! digest of every loaded source, and the bridge's own `ok`/`code` contract. Anything unexpected
//! (an unsolicited, duplicated or replayed message, a stale id, a foreign scope, a partial frame
//! at EOF, a timeout) kills the worker and is an `Err` with a code, never a guess. Requests are
//! serialized by a lock with a bounded number of waiters (backpressure: `bridge-busy`), and the
//! number of live workers and the restart rate are bounded.

use super::governor_bridge::{
    berr, BridgeError, GovernorEvaluator, ACTIVITY_SOURCE, BRIDGE_SOURCE, GOVERNOR_SOURCE,
    RUNTIME_SOURCE, SIGNALS_SOURCE,
};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Wire protocol version (the worker refuses any other).
pub const WORKER_PROTOCOL: u64 = 1;
/// The worker script, embedded; its digest is reported separately from the policy sources.
pub const WORKER_SOURCE: &str = include_str!("muse_bridge_worker.cjs");
/// Largest serialized `args` of one request (the Muse blocks are a few KB).
pub const MAX_WORKER_ARGS: usize = 512 * 1024;
/// Largest frame the worker may send (equal to the one-shot bridge's output bound).
pub const MAX_WORKER_RESPONSE: usize = 256 * 1024;
/// A request is never allowed to wait for another longer than its own timeout; at most this many
/// calls may be waiting for (or using) one worker, so a stuck worker cannot grow a queue.
pub const MAX_PENDING_CALLS: usize = 4;
/// Process-wide bound on live workers (one per running adaptive-capable run).
pub const MAX_LIVE_WORKERS: usize = 16;
/// Crash-loop bound: at most this many spawns of one supervisor within [`SPAWN_WINDOW`].
pub const MAX_SPAWNS_PER_WINDOW: usize = 6;
pub const SPAWN_WINDOW: Duration = Duration::from_secs(60);
/// V8 old-space ceiling of the worker (MiB). The historical modules need a few MiB.
pub const WORKER_HEAP_MB: u32 = 48;
/// V8 young-generation (semi-space) ceiling (MiB). The old-space cap does not bound it: with the
/// default it grew the worker to 200+ MiB RSS on the bundled Node 24; with 2 MiB it stays ~80 MiB.
pub const WORKER_SEMI_SPACE_MB: u32 = 2;
/// The node flags of every worker, in order. `--permission` is Node's deny-all permission mode:
/// NO `--allow-fs-read`, `--allow-fs-write`, `--allow-child-process`, `--allow-worker` or
/// `--allow-addons` is ever added. It needs Node >= 23.5 (stable name); an older Node rejects the
/// option and the worker simply does not start (fail closed, no unprotected fallback).
pub fn worker_node_flags() -> Vec<String> {
    vec![
        "--permission".to_owned(),
        format!("--max-old-space-size={WORKER_HEAP_MB}"),
        format!("--max-semi-space-size={WORKER_SEMI_SPACE_MB}"),
    ]
}

static LIVE_WORKERS: AtomicUsize = AtomicUsize::new(0);

/// The worker allowance of ONE broker: derived from its configured `max_active` (a run that is
/// admitted can have one worker), never more than [`MAX_LIVE_WORKERS`]. The process-wide
/// `LIVE_WORKERS` count stays as an absolute backstop.
#[derive(Debug)]
pub struct WorkerSlots {
    live: AtomicUsize,
    max: usize,
}

impl WorkerSlots {
    pub fn for_max_active(max_active: usize) -> Self {
        Self {
            live: AtomicUsize::new(0),
            max: max_active.clamp(1, MAX_LIVE_WORKERS),
        }
    }
    pub fn max(&self) -> usize {
        self.max
    }
    pub fn live(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }
    fn acquire(&self) -> bool {
        if self.live.fetch_add(1, Ordering::SeqCst) >= self.max {
            self.live.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }
    fn release(&self) {
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Number of worker processes alive right now in this broker process.
pub fn live_workers() -> usize {
    LIVE_WORKERS.load(Ordering::SeqCst)
}

/// SHA-256 of the worker script (not part of `sources_digest`: decision evidence is unchanged).
pub fn worker_digest() -> String {
    nexus_contracts::sha256_hex(WORKER_SOURCE)
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub node: PathBuf,
    /// The worker script (always [`WORKER_SOURCE`] in production; tests may wrap or replace it).
    pub script: String,
    /// One request (and the start-up handshake) never takes longer than this.
    pub timeout: Duration,
    pub max_pending: usize,
    pub max_spawns: usize,
    pub spawn_window: Duration,
    /// Node flags before `-e` (see [`worker_node_flags`]). Only tests may change them.
    pub node_flags: Vec<String>,
    /// The broker's worker allowance; `None` = only the process-wide backstop.
    pub slots: Option<Arc<WorkerSlots>>,
}

impl WorkerConfig {
    pub fn new(node: PathBuf) -> Self {
        Self {
            node,
            script: WORKER_SOURCE.to_owned(),
            timeout: super::governor_bridge::BRIDGE_TIMEOUT,
            max_pending: MAX_PENDING_CALLS,
            max_spawns: MAX_SPAWNS_PER_WINDOW,
            spawn_window: SPAWN_WINDOW,
            node_flags: worker_node_flags(),
            slots: None,
        }
    }

    /// The configuration of a run's worker under a broker's allowance.
    pub fn with_slots(mut self, slots: Arc<WorkerSlots>) -> Self {
        self.slots = Some(slots);
        self
    }

    /// TEST ONLY: start the worker WITHOUT the permission mode, to prove that the worker and the
    /// supervisor refuse to run unprotected. Not available in production builds.
    #[cfg(any(test, feature = "test-engines"))]
    pub fn without_permission_for_tests(mut self) -> Self {
        self.node_flags.retain(|f| f != "--permission");
        self
    }
}

/// Counters of the supervisor's life (observable, never decision input).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WorkerStatsSnapshot {
    pub spawns: u64,
    pub requests: u64,
    pub retries: u64,
    pub crashes: u64,
    pub timeouts: u64,
    pub cancellations: u64,
    pub protocol_violations: u64,
    pub busy_rejections: u64,
}

#[derive(Default)]
struct WorkerStats {
    spawns: AtomicU64,
    requests: AtomicU64,
    retries: AtomicU64,
    crashes: AtomicU64,
    timeouts: AtomicU64,
    cancellations: AtomicU64,
    protocol_violations: AtomicU64,
    busy_rejections: AtomicU64,
}

impl WorkerStats {
    fn snapshot(&self) -> WorkerStatsSnapshot {
        let g = |a: &AtomicU64| a.load(Ordering::SeqCst);
        WorkerStatsSnapshot {
            spawns: g(&self.spawns),
            requests: g(&self.requests),
            retries: g(&self.retries),
            crashes: g(&self.crashes),
            timeouts: g(&self.timeouts),
            cancellations: g(&self.cancellations),
            protocol_violations: g(&self.protocol_violations),
            busy_rejections: g(&self.busy_rejections),
        }
    }
}

/// Why one exchange with the worker failed.
#[derive(Debug)]
enum Fail {
    /// The process exited, closed its pipe or could not be written: nothing was answered.
    Died(String),
    Timeout,
    Cancelled,
    /// The worker answered something it must never send.
    Protocol(String),
    TooLarge,
}

enum Incoming {
    Frame(Vec<u8>),
    Closed(String),
    TooLarge,
}

struct WorkerProc {
    slots: Option<Arc<WorkerSlots>>,
    child: Child,
    to_worker: Option<SyncSender<Vec<u8>>>,
    from_worker: mpsc::Receiver<Incoming>,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    next_id: u64,
}

impl WorkerProc {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Kill, reap and join. Idempotent; bounded (the process is dead, so its pipes are closed).
    fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.to_worker = None;
        // the reader may be blocked handing over a frame nobody will read: dropping our receiver
        // wakes it (joining first would wait for it forever)
        drop(std::mem::replace(
            &mut self.from_worker,
            mpsc::sync_channel(1).1,
        ));
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
        if let Some(h) = self.writer.take() {
            let _ = h.join();
        }
    }
}

impl Drop for WorkerProc {
    fn drop(&mut self) {
        self.terminate();
        LIVE_WORKERS.fetch_sub(1, Ordering::SeqCst);
        if let Some(sl) = &self.slots {
            sl.release();
        }
    }
}

struct Inner {
    proc: Option<WorkerProc>,
    spawns: VecDeque<Instant>,
}

/// The supervised worker of ONE run. See the module documentation.
pub struct WorkerGovernorBridge {
    cfg: WorkerConfig,
    /// Echoed by every response: a response for another scope is a protocol violation.
    scope: String,
    cancel: Arc<AtomicBool>,
    closed: AtomicBool,
    pending: AtomicUsize,
    inner: Mutex<Inner>,
    stats: WorkerStats,
}

/// A worker-supplied code, reduced to a short identifier before it enters an error message.
fn safe_code(c: &str) -> String {
    c.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(48)
        .collect()
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + body.len());
    v.extend_from_slice(&(body.len() as u32).to_be_bytes());
    v.extend_from_slice(body);
    v
}

/// Reads one frame; `Err(Incoming)` for EOF/oversize/IO problems.
fn read_frame(r: &mut impl Read, max: usize) -> Result<Vec<u8>, Incoming> {
    let mut head = [0u8; 4];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(Incoming::Closed("the worker closed its output".into()))
        }
        Err(e) => return Err(Incoming::Closed(format!("read failed: {e}"))),
    }
    let n = u32::from_be_bytes(head) as usize;
    if n == 0 || n > max {
        return Err(Incoming::TooLarge);
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body)
        .map_err(|_| Incoming::Closed("the worker closed its output inside a frame".into()))?;
    Ok(body)
}

impl WorkerGovernorBridge {
    pub fn new(node: PathBuf, scope: impl Into<String>, cancel: Arc<AtomicBool>) -> Self {
        Self::with_config(WorkerConfig::new(node), scope, cancel)
    }

    pub fn with_config(
        cfg: WorkerConfig,
        scope: impl Into<String>,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        let mut scope: String = scope.into();
        scope.truncate(128);
        // a scope is an identifier (it is echoed on the wire and shown in `ps`)
        if scope.is_empty()
            || !scope
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        {
            scope = "run".into();
        }
        Self {
            cfg,
            scope,
            cancel,
            closed: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            inner: Mutex::new(Inner {
                proc: None,
                spawns: VecDeque::new(),
            }),
            stats: WorkerStats::default(),
        }
    }

    pub fn stats(&self) -> WorkerStatsSnapshot {
        self.stats.snapshot()
    }

    /// The worker's process id, if one is running (tests and diagnostics).
    pub fn pid(&self) -> Option<u32> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.proc.as_ref().map(|p| p.pid())
    }

    /// Ends the worker for good: every later call is refused. Idempotent.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.proc = None;
    }

    fn spawn(&self, inner: &mut Inner) -> Result<(), BridgeError> {
        // D3: outside test builds the flags are EXACTLY the reviewed set - no `--allow-*` grant,
        // no dropped `--permission`, nothing added - whatever a caller put in the configuration
        check_worker_flags(&self.cfg.node_flags, TEST_FLAG_OVERRIDES_ALLOWED)
            .map_err(|m| berr("bridge-unavailable", m))?;
        let now = Instant::now();
        while inner
            .spawns
            .front()
            .is_some_and(|t| now.duration_since(*t) > self.cfg.spawn_window)
        {
            inner.spawns.pop_front();
        }
        if inner.spawns.len() >= self.cfg.max_spawns {
            return Err(berr(
                "bridge-restart-limit",
                "the Governor worker failed too often; not restarted until the window passes",
            ));
        }
        if let Some(sl) = &self.cfg.slots {
            if !sl.acquire() {
                return Err(berr(
                    "bridge-busy",
                    "this broker's Governor worker allowance (its max_active) is in use",
                ));
            }
        }
        if LIVE_WORKERS.fetch_add(1, Ordering::SeqCst) >= MAX_LIVE_WORKERS {
            LIVE_WORKERS.fetch_sub(1, Ordering::SeqCst);
            if let Some(sl) = &self.cfg.slots {
                sl.release();
            }
            return Err(berr(
                "bridge-busy",
                "too many Governor workers are running in this broker",
            ));
        }
        // From here the counts are owned by the WorkerProc (released in its Drop).
        let mut child = match Command::new(&self.cfg.node)
            .args(&self.cfg.node_flags)
            .arg("-e")
            .arg(&self.cfg.script)
            // the scope (a task generation id) is visible in `ps`: it names whose worker this is
            .arg("--")
            .arg(&self.scope)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                LIVE_WORKERS.fetch_sub(1, Ordering::SeqCst);
                if let Some(sl) = &self.cfg.slots {
                    sl.release();
                }
                return Err(berr(
                    "bridge-unavailable",
                    format!("cannot start node: {e}"),
                ));
            }
        };
        inner.spawns.push_back(now);
        self.stats.spawns.fetch_add(1, Ordering::SeqCst);
        let mut stdin = child.stdin.take();
        let mut stdout = child.stdout.take();
        // writer: one frame at a time; a write that blocks on a stuck worker ends when it is killed
        let (to_worker, wrx) = mpsc::sync_channel::<Vec<u8>>(1);
        let writer = std::thread::spawn(move || {
            while let Ok(f) = wrx.recv() {
                let Some(s) = stdin.as_mut() else { return };
                if s.write_all(&f).and_then(|_| s.flush()).is_err() {
                    return;
                }
            }
        });
        // reader: bounded frames; one pending message at most (a second is a violation)
        let (rtx, from_worker) = mpsc::sync_channel::<Incoming>(1);
        let reader = std::thread::spawn(move || {
            let Some(out) = stdout.as_mut() else { return };
            loop {
                match read_frame(out, MAX_WORKER_RESPONSE) {
                    Ok(b) => {
                        if rtx.send(Incoming::Frame(b)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = rtx.send(e);
                        return;
                    }
                }
            }
        });
        let mut proc = WorkerProc {
            slots: self.cfg.slots.clone(),
            child,
            to_worker: Some(to_worker),
            from_worker,
            reader: Some(reader),
            writer: Some(writer),
            next_id: 0,
        };
        match self.handshake(&mut proc) {
            Ok(()) => {
                inner.proc = Some(proc);
                Ok(())
            }
            Err(f) => {
                let mut e = self.fail_error(&f);
                if matches!(f, Fail::Died(_) | Fail::Timeout) {
                    e.message.push_str(
                        " (a Governor worker needs Node >= 23.5 with --permission and proves it at start-up; there is no unprotected fallback)",
                    );
                }
                drop(proc);
                Err(e)
            }
        }
    }

    fn handshake(&self, proc: &mut WorkerProc) -> Result<(), Fail> {
        let hello = serde_json::json!({
            "v": WORKER_PROTOCOL, "type": "hello",
            "sources": {
                "governor": GOVERNOR_SOURCE, "runtime": RUNTIME_SOURCE,
                "activity": ACTIVITY_SOURCE, "signals": SIGNALS_SOURCE,
            },
            "bridge": BRIDGE_SOURCE,
        })
        .to_string();
        self.send(proc, frame(hello.as_bytes()))?;
        let body = self.await_frame(proc)?;
        let v: Value = serde_json::from_slice(&body)
            .map_err(|_| Fail::Protocol("ready is not JSON".into()))?;
        let obj = v
            .as_object()
            .ok_or_else(|| Fail::Protocol("ready is not an object".into()))?;
        if obj.get("v") == Some(&Value::from(WORKER_PROTOCOL))
            && obj.get("type").and_then(|t| t.as_str()) == Some("fatal")
        {
            // e.g. `permission-not-enforced`: the worker refused to run unprotected
            let code = obj.get("code").and_then(|c| c.as_str()).unwrap_or("?");
            return Err(Fail::Died(format!(
                "the worker reported {}",
                safe_code(code)
            )));
        }
        if obj
            .keys()
            .any(|k| !["v", "type", "digests", "node", "permission"].contains(&k.as_str()))
            || obj.get("v") != Some(&Value::from(WORKER_PROTOCOL))
            || obj.get("type").and_then(|t| t.as_str()) != Some("ready")
        {
            return Err(Fail::Protocol("unexpected start-up message".into()));
        }
        // EM-04C2 S1 (D3): the worker must PROVE Node's deny-all permission mode. Checked here
        // independently of the worker's own refusal; a missing, disabled or partial report is a
        // protocol violation and the process is killed - never used.
        verify_permission(obj.get("permission"))?;
        let want = [
            ("governor", GOVERNOR_SOURCE),
            ("runtime", RUNTIME_SOURCE),
            ("activity", ACTIVITY_SOURCE),
            ("signals", SIGNALS_SOURCE),
            ("bridge", BRIDGE_SOURCE),
        ];
        let digests = obj
            .get("digests")
            .and_then(|d| d.as_object())
            .ok_or_else(|| Fail::Protocol("ready carries no digests".into()))?;
        if digests.len() != want.len() {
            return Err(Fail::Protocol("unexpected digest set".into()));
        }
        for (k, src) in want {
            if digests.get(k).and_then(|d| d.as_str())
                != Some(nexus_contracts::sha256_hex(src).as_str())
            {
                return Err(Fail::Protocol(format!(
                    "the worker loaded a different {k} source than the broker embeds"
                )));
            }
        }
        Ok(())
    }

    fn send(&self, proc: &mut WorkerProc, f: Vec<u8>) -> Result<(), Fail> {
        let Some(tx) = proc.to_worker.as_ref() else {
            return Err(Fail::Died("the worker is closed".into()));
        };
        tx.try_send(f)
            .map_err(|_| Fail::Died("the worker is not accepting input".into()))
    }

    /// Waits for the next frame: bounded by the timeout, the cancel flag and the process itself.
    fn await_frame(&self, proc: &mut WorkerProc) -> Result<Vec<u8>, Fail> {
        let deadline = Instant::now() + self.cfg.timeout;
        loop {
            if self.cancel.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
                return Err(Fail::Cancelled);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Fail::Timeout);
            }
            let slice = (deadline - now).min(Duration::from_millis(20));
            match proc.from_worker.recv_timeout(slice) {
                Ok(Incoming::Frame(b)) => return Ok(b),
                Ok(Incoming::Closed(m)) => return Err(Fail::Died(m)),
                Ok(Incoming::TooLarge) => return Err(Fail::TooLarge),
                Err(RecvTimeoutError::Timeout) => {
                    if let Ok(Some(st)) = proc.child.try_wait() {
                        // drain what it said before exiting (a `fatal` frame), else report the exit
                        return match proc.from_worker.try_recv() {
                            Ok(Incoming::Frame(b)) => Ok(b),
                            _ => Err(Fail::Died(format!("the worker exited ({st})"))),
                        };
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Fail::Died("the worker's reader ended".into()))
                }
            }
        }
    }

    fn fail_error(&self, f: &Fail) -> BridgeError {
        match f {
            Fail::Died(m) => {
                self.stats.crashes.fetch_add(1, Ordering::SeqCst);
                berr("bridge-failed", format!("the Governor worker failed: {m}"))
            }
            Fail::Timeout => {
                self.stats.timeouts.fetch_add(1, Ordering::SeqCst);
                berr(
                    "bridge-timeout",
                    "the Governor bridge did not answer in time",
                )
            }
            Fail::Cancelled => {
                self.stats.cancellations.fetch_add(1, Ordering::SeqCst);
                berr("bridge-cancelled", "the Governor bridge was cancelled")
            }
            Fail::Protocol(m) => {
                self.stats
                    .protocol_violations
                    .fetch_add(1, Ordering::SeqCst);
                berr(
                    "bridge-protocol",
                    format!("the Governor worker broke its protocol: {m}"),
                )
            }
            Fail::TooLarge => berr("bridge-output-too-large", "bridge output exceeds its bound"),
        }
    }

    /// One request/response on a live worker. A returned `Ok` is the bridge's own answer
    /// (`ok:true` result, or its error contract); anything else is a transport failure.
    fn exchange(
        &self,
        proc: &mut WorkerProc,
        op: &str,
        args_json: &str,
    ) -> Result<Result<Value, BridgeError>, Fail> {
        // nothing may be waiting for us: an unsolicited or duplicated message is a violation
        match proc.from_worker.try_recv() {
            Err(TryRecvError::Empty) => {}
            Ok(Incoming::Frame(_)) => {
                return Err(Fail::Protocol("an unsolicited message arrived".into()))
            }
            Ok(Incoming::Closed(m)) => return Err(Fail::Died(m)),
            Ok(Incoming::TooLarge) => return Err(Fail::TooLarge),
            Err(TryRecvError::Disconnected) => {
                return Err(Fail::Died("the worker's reader ended".into()))
            }
        }
        if let Ok(Some(st)) = proc.child.try_wait() {
            return Err(Fail::Died(format!("the worker exited ({st})")));
        }
        proc.next_id += 1;
        let id = proc.next_id;
        let req = format!(
            "{{\"v\":{WORKER_PROTOCOL},\"type\":\"request\",\"id\":{id},\"scope\":{},\"op\":{},\"args\":{args_json}}}",
            serde_json::to_string(&self.scope).unwrap_or_default(),
            serde_json::to_string(op).unwrap_or_default(),
        );
        self.send(proc, frame(req.as_bytes()))?;
        let body = self.await_frame(proc)?;
        let v: Value = serde_json::from_slice(&body)
            .map_err(|_| Fail::Protocol("a response is not JSON".into()))?;
        let obj = v
            .as_object()
            .ok_or_else(|| Fail::Protocol("a response is not an object".into()))?;
        if obj.get("v") != Some(&Value::from(WORKER_PROTOCOL)) {
            return Err(Fail::Protocol("unsupported protocol version".into()));
        }
        match obj.get("type").and_then(|t| t.as_str()) {
            Some("response") => {}
            Some("fatal") => {
                let code = obj.get("code").and_then(|c| c.as_str()).unwrap_or("?");
                return Err(Fail::Died(format!(
                    "the worker reported {}",
                    safe_code(code)
                )));
            }
            _ => return Err(Fail::Protocol("an unknown message type".into())),
        }
        if obj
            .keys()
            .any(|k| !["v", "type", "id", "scope", "bridge"].contains(&k.as_str()))
        {
            return Err(Fail::Protocol("unknown response fields".into()));
        }
        if obj.get("id").and_then(|i| i.as_u64()) != Some(id) {
            return Err(Fail::Protocol(
                "the response answers another request (stale or replayed)".into(),
            ));
        }
        if obj.get("scope").and_then(|s| s.as_str()) != Some(self.scope.as_str()) {
            return Err(Fail::Protocol(
                "the response belongs to another scope".into(),
            ));
        }
        let bridge = obj
            .get("bridge")
            .and_then(|b| b.as_object())
            .ok_or_else(|| Fail::Protocol("the response carries no bridge answer".into()))?;
        match bridge.get("ok").and_then(|o| o.as_bool()) {
            Some(true) => Ok(Ok(bridge.get("result").cloned().unwrap_or(Value::Null))),
            Some(false) => Ok(Err(berr(
                bridge
                    .get("code")
                    .and_then(|c| c.as_str())
                    .unwrap_or("bridge-error"),
                bridge
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect::<String>(),
            ))),
            None => Err(Fail::Protocol("the bridge answer has no ok flag".into())),
        }
    }
}

/// Explicit lifecycle owner of a run's worker: the worker is shut down when the lease drops
/// (end of the run, early return or unwinding), whoever else still holds the evaluator.
pub struct WorkerLease(Arc<WorkerGovernorBridge>);

impl WorkerLease {
    pub fn new(w: Arc<WorkerGovernorBridge>) -> Self {
        Self(w)
    }
}

impl Drop for WorkerLease {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

/// Test builds may add `--allow-*` grants to a TEST script (and may drop `--permission` to prove the
/// refusal); production builds never can.
pub(crate) const TEST_FLAG_OVERRIDES_ALLOWED: bool = cfg!(any(test, feature = "test-engines"));

/// The flags a worker may be started with. In production they must equal [`worker_node_flags`]
/// exactly; this makes "no filesystem or process exception is ever granted to the worker" a property
/// of the supervisor and not only of how the default configuration happens to be built.
pub(crate) fn check_worker_flags(flags: &[String], overrides_allowed: bool) -> Result<(), String> {
    if overrides_allowed || flags == worker_node_flags().as_slice() {
        return Ok(());
    }
    Err("the Governor worker is started only with the reviewed Node flags (deny-all permission mode, no --allow-* grant); refusing to start another configuration".to_owned())
}

/// The permission report of a `ready` message must say: enforced, every scope denied, and the four
/// canary operations refused with the permission error.
fn verify_permission(p: Option<&Value>) -> Result<(), Fail> {
    let bad = |m: &str| {
        Err(Fail::Protocol(format!(
            "permission mode is not enforced: {m}"
        )))
    };
    let Some(p) = p.and_then(|p| p.as_object()) else {
        return bad("no permission report");
    };
    if p.keys()
        .any(|k| !["enforced", "scopes", "canaries"].contains(&k.as_str()))
    {
        return bad("unexpected report fields");
    }
    if p.get("enforced") != Some(&Value::Bool(true)) {
        return bad("the worker reports it disabled");
    }
    let Some(scopes) = p.get("scopes").and_then(|s| s.as_object()) else {
        return bad("no scope report");
    };
    let want_scopes = ["fs.read", "fs.write", "child", "worker", "addon"];
    if scopes.len() != want_scopes.len()
        || !want_scopes
            .iter()
            .all(|k| scopes.get(*k) == Some(&Value::Bool(false)))
    {
        return bad("a scope is not denied");
    }
    let Some(c) = p.get("canaries").and_then(|c| c.as_object()) else {
        return bad("no canary report");
    };
    let code = |k: &str| c.get(k).and_then(|v| v.as_str());
    if c.len() != 4
        || code("read") != Some("ERR_ACCESS_DENIED")
        || code("write") != Some("ERR_ACCESS_DENIED")
        || code("child") != Some("ERR_ACCESS_DENIED")
        || !matches!(
            code("addon"),
            Some("ERR_DLOPEN_DISABLED" | "ERR_ACCESS_DENIED")
        )
    {
        return bad("a canary operation was not refused");
    }
    Ok(())
}

struct PendingGuard<'a>(&'a AtomicUsize);
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl GovernorEvaluator for WorkerGovernorBridge {
    fn call(&self, op: &str, args: &Value) -> Result<Value, BridgeError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(berr("bridge-closed", "the Governor worker was shut down"));
        }
        if self.cancel.load(Ordering::SeqCst) {
            self.stats.cancellations.fetch_add(1, Ordering::SeqCst);
            return Err(berr(
                "bridge-cancelled",
                "the Governor bridge was cancelled",
            ));
        }
        if !args.is_object() {
            return Err(berr(
                "bridge-input-invalid",
                "bridge arguments must be an object",
            ));
        }
        let args_json = serde_json::to_string(args).map_err(|_| {
            berr(
                "bridge-input-invalid",
                "bridge arguments are not serializable",
            )
        })?;
        if args_json.len() > MAX_WORKER_ARGS {
            return Err(berr(
                "bridge-input-too-large",
                "bridge input exceeds its bound",
            ));
        }
        // backpressure: bounded callers per worker; a request is never queued unboundedly
        if self.pending.fetch_add(1, Ordering::SeqCst) >= self.cfg.max_pending {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            self.stats.busy_rejections.fetch_add(1, Ordering::SeqCst);
            return Err(berr(
                "bridge-busy",
                "the Governor worker has too many waiting calls",
            ));
        }
        let _pending = PendingGuard(&self.pending);
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => {
                // a panic mid-exchange: whatever the worker was doing is unknown, so drop it
                let mut g = p.into_inner();
                g.proc = None;
                g
            }
        };
        let mut attempt = 0;
        loop {
            attempt += 1;
            if self.closed.load(Ordering::SeqCst) {
                return Err(berr("bridge-closed", "the Governor worker was shut down"));
            }
            // a worker that died while idle is replaced before use
            if inner
                .proc
                .as_mut()
                .is_some_and(|p| matches!(p.child.try_wait(), Ok(Some(_))))
            {
                inner.proc = None;
                self.stats.crashes.fetch_add(1, Ordering::SeqCst);
            }
            if inner.proc.is_none() {
                self.spawn(&mut inner)?;
            }
            let Some(proc) = inner.proc.as_mut() else {
                return Err(berr("bridge-unavailable", "no Governor worker"));
            };
            self.stats.requests.fetch_add(1, Ordering::SeqCst);
            match self.exchange(proc, op, &args_json) {
                Ok(answer) => return answer,
                Err(f) => {
                    // any transport failure ends the process: the next call starts a clean one
                    inner.proc = None;
                    let retryable = matches!(f, Fail::Died(_) | Fail::Protocol(_));
                    if retryable && attempt == 1 {
                        // the worker is stateless and the request is a pure function of its
                        // arguments: re-asking a fresh worker cannot apply anything twice
                        self.stats.retries.fetch_add(1, Ordering::SeqCst);
                        match &f {
                            Fail::Died(_) => {
                                self.stats.crashes.fetch_add(1, Ordering::SeqCst);
                            }
                            _ => {
                                self.stats
                                    .protocol_violations
                                    .fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        continue;
                    }
                    return Err(self.fail_error(&f));
                }
            }
        }
    }
}

impl Drop for WorkerGovernorBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The evaluator the engine test suites run against: the persistent worker by default, the
/// one-shot bridge when `NEXUS_TEST_BRIDGE=oneshot`. Both must satisfy the same suites unchanged.
#[cfg(any(test, feature = "test-engines"))]
pub fn test_evaluator(node: PathBuf) -> Arc<dyn GovernorEvaluator> {
    if std::env::var("NEXUS_TEST_BRIDGE").as_deref() == Ok("oneshot") {
        Arc::new(super::governor_bridge::NodeGovernorBridge::new(node))
    } else {
        Arc::new(WorkerGovernorBridge::new(
            node,
            "test",
            Arc::new(AtomicBool::new(false)),
        ))
    }
}
