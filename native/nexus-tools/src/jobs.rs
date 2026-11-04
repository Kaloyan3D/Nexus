//! M7: durable, supervised background jobs (development servers, watchers).
//!
//! Architecture (review answers, condensed):
//! * **Source of truth** — the [`JobManager`] owns every job's state. Each job also persists a
//!   record (`<state-dir>/<id>.json`) written on every transition; the record is a *claim* that
//!   [`JobManager::reconcile`] re-derives from reality (live handle, cgroup, pid) after a crash.
//!   A record that says `running` without a live supervisor is marked `interrupted` — never
//!   reported as running, never as completed.
//! * **Ownership** — only the manager writes job state. Callers (daemon/broker/CLI) ask through
//!   `start`/`stop`/`status`/`logs`; the model has no direct path here at all.
//! * **Confinement** — a job is an ordinary sandboxed command (same `SandboxSpec`, same launch
//!   gate, same frozen grant the caller prepared). The manager adds supervision, bounded logs,
//!   a wall-clock/runtime limit and, for authorized ports only, a loopback dev bridge (M7C).
//!   It cannot widen anything: exposure requires the port to be in the grant's `devPorts`.
//! * **Failure** — the manager's death takes every job with it (bwrap `--die-with-parent`, the
//!   supervisor kills the cgroup on stop; a crashed daemon leaves records that reconcile to
//!   `interrupted`). No job is detached from Nexus authorization.
//! * **Logs** — combined output is appended inside the sandbox to a Nexus-owned directory bound
//!   at `/work/joblogs`; a watchdog keeps the file within its byte budget (tail-preserving).

use crate::result::{ToolError, ToolErrorCode};
use crate::sandbox::{run_sandboxed, SandboxControl, SandboxSpec, StopReason};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

fn refuse(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::CommandRefused, msg)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    /// `running` | `exited` | `stopped` | `failed` | `interrupted`
    pub state: String,
    /// Human-readable command line (redacted by the caller's resolver display).
    pub display: String,
    /// Task/run this job belongs to (explicit ownership, supplied by the caller).
    pub task: String,
    /// Digest/label of the frozen grant the job was started under.
    pub authority: String,
    /// The project the job runs in (empty for records written before this field existed).
    #[serde(default)]
    pub project: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
    /// Sandbox-side supervisor pid (bwrap), when known.
    pub pid: Option<u32>,
    pub cgroup: Option<String>,
    /// `(sandbox port, host loopback port)` exposures actually bridged.
    pub exposed: Vec<(u16, u16)>,
    pub log_bytes: u64,
    pub log_truncated: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the caller (which owns authorization and sandbox preparation) hands to `start`.
pub struct JobStart {
    /// Fully prepared sandbox spec for the command (in-place mount descriptors already set).
    /// The manager wraps the program so its output lands in the job log; `program`/`args` are
    /// preserved exactly as the command that runs.
    pub spec: SandboxSpec,
    /// Keeps in-place mount descriptors alive for the job's lifetime.
    pub mount: Option<crate::inplace::InPlaceMount>,
    pub display: String,
    pub task: String,
    pub authority: String,
    /// The project the job runs in; shown with the job, never used for authorization.
    pub project: String,
    /// Ports the frozen grant allows to expose (`grant.dev_ports`).
    pub authorized_ports: Vec<u16>,
    /// `(sandbox port, requested host port; 0 = ephemeral)` to expose on host loopback.
    pub expose: Vec<(u16, u16)>,
    /// Byte budget of the combined job log.
    pub max_log_bytes: u64,
}

struct JobControl {
    stop: Arc<AtomicBool>,
    pid: Arc<Mutex<Option<u32>>>,
}
impl SandboxControl for JobControl {
    fn should_stop(&mut self) -> Option<StopReason> {
        if self.stop.load(Ordering::SeqCst) {
            Some(StopReason::Cancelled)
        } else {
            None
        }
    }
    fn on_spawned(&mut self, pid: u32, _cgroup: &str) -> Result<(), ToolError> {
        *self.pid.lock().unwrap() = Some(pid);
        Ok(())
    }
}

struct Handle {
    record: Arc<Mutex<JobRecord>>,
    stop: Arc<AtomicBool>,
    bridges: Vec<crate::devbridge::DevBridge>,
    _mount: Option<crate::inplace::InPlaceMount>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// The daemon-owned supervisor of background jobs. Dropping it stops every job.
pub struct JobManager {
    dir: PathBuf,
    jobs: Mutex<BTreeMap<String, Handle>>,
}

/// Job ids are unique across every manager in the process (tests and the daemon may hold
/// several managers; cgroup names derive from the id and must never collide).
static JOB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl JobManager {
    /// Open (creating if needed) the state directory and reconcile whatever a previous,
    /// possibly crashed, owner left behind.
    pub fn open(dir: &Path) -> Result<Self, ToolError> {
        std::fs::create_dir_all(dir.join("logs"))
            .map_err(|e| refuse(format!("job state dir: {e}")))?;
        let m = Self {
            dir: dir.to_path_buf(),
            jobs: Mutex::new(BTreeMap::new()),
        };
        m.reconcile()?;
        Ok(m)
    }

    fn persist(&self, rec: &JobRecord) -> Result<(), ToolError> {
        let p = self.dir.join(format!("{}.json", rec.id));
        let tmp = self.dir.join(format!("{}.json.tmp", rec.id));
        std::fs::write(&tmp, serde_json::to_string_pretty(rec).unwrap_or_default())
            .and_then(|_| std::fs::rename(&tmp, &p))
            .map_err(|e| refuse(format!("persist job record: {e}")))
    }

    /// Records left by a previous owner: a job with no live supervisor in THIS manager is
    /// checked against reality (pid + cgroup). Anything not provably alive becomes
    /// `interrupted` — a daemon restart never reports a dead job as running or completed.
    pub fn reconcile(&self) -> Result<Vec<JobRecord>, ToolError> {
        let mut out = Vec::new();
        let live: std::collections::BTreeSet<String> =
            self.jobs.lock().unwrap().keys().cloned().collect();
        for e in std::fs::read_dir(&self.dir).map_err(|e| refuse(format!("job state: {e}")))? {
            let e = e.map_err(|e| refuse(format!("job state: {e}")))?;
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else {
                continue;
            };
            let Ok(mut rec) = serde_json::from_str::<JobRecord>(&text) else {
                continue;
            };
            if rec.state == "running" && !live.contains(&rec.id) {
                let alive = rec.pid.is_some_and(|pid| {
                    (unsafe { libc::kill(pid as i32, 0) } == 0)
                        && rec.cgroup.as_ref().is_some_and(|c| Path::new(c).exists())
                });
                if !alive {
                    rec.state = "interrupted".into();
                    rec.ended_at_ms = Some(now_ms());
                    self.persist(&rec)?;
                }
            }
            out.push(rec);
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    pub fn start(&self, mut start: JobStart) -> Result<JobRecord, ToolError> {
        // Exposure is grant-bound: every requested sandbox port must be authorized.
        for (port, _) in &start.expose {
            if !start.authorized_ports.contains(port) {
                return Err(refuse(format!(
                    "development port {port} is not authorized for this project (grant devPorts: {:?}); Nexus will not expose it",
                    start.authorized_ports
                )));
            }
        }
        let id = format!(
            "job-{}-{}",
            std::process::id(),
            JOB_SEQ.fetch_add(1, Ordering::SeqCst) + 1
        );
        // M7C: the gate's dev bridge sockets live in a per-job bound directory.
        let dev_dir = self.dir.join("dev").join(&id);
        if !start.expose.is_empty() {
            std::fs::create_dir_all(&dev_dir).map_err(|e| refuse(format!("dev dir: {e}")))?;
            start.spec.dev = Some(crate::sandbox::DevSpec {
                dir: dev_dir.clone(),
                ports: start.expose.iter().map(|(p, _)| *p).collect(),
            });
        }
        // Route the command's output into the job log inside the sandbox.
        let log_dir = self.dir.join("logs");
        let host_log_dir = log_dir.join(&id);
        std::fs::create_dir_all(&host_log_dir).map_err(|e| refuse(format!("job log dir: {e}")))?;
        start
            .spec
            .rw_binds
            .push((host_log_dir.clone(), "/work/joblogs".into()));
        let inner_program = start.spec.program.clone();
        let inner_args = start.spec.args.clone();
        start.spec.program = "/usr/bin/sh".into();
        let mut wrapped = vec![
            "-c".to_owned(),
            "exec \"$0\" \"$@\" >>/work/joblogs/out.log 2>&1".to_owned(),
            inner_program,
        ];
        wrapped.extend(inner_args);
        start.spec.args = wrapped;
        start.spec.id = format!("nexus-{}", id);

        let rec = JobRecord {
            id: id.clone(),
            state: "running".into(),
            display: start.display.clone(),
            task: start.task.clone(),
            authority: start.authority.clone(),
            project: start.project.clone(),
            started_at_ms: now_ms(),
            ended_at_ms: None,
            exit_code: None,
            pid: None,
            cgroup: None,
            exposed: Vec::new(),
            log_bytes: 0,
            log_truncated: false,
        };
        self.persist(&rec)?;
        let record = Arc::new(Mutex::new(rec.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        let pid_slot = Arc::new(Mutex::new(None));
        let mut ctl = JobControl {
            stop: stop.clone(),
            pid: pid_slot.clone(),
        };
        let spec = start.spec;
        let rec_thread = record.clone();
        let stop_thread = stop.clone();
        let dir_thread = self.dir.clone();
        let cap = if start.max_log_bytes == 0 {
            1 << 20
        } else {
            start.max_log_bytes
        };
        let log_file = host_log_dir.join("out.log");
        // log watchdog: keep the log within its budget (tail-preserving, approximate under
        // concurrent append — the budget is a storage bound, not a byte-exact guarantee)
        let wd_stop = stop.clone();
        let wd_file = log_file.clone();
        std::thread::spawn(move || {
            while !wd_stop.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Ok(md) = std::fs::metadata(&wd_file) {
                    if md.len() > cap.saturating_mul(2) {
                        if let Ok(mut data) = std::fs::read(&wd_file) {
                            let tail = data.split_off(data.len().saturating_sub(cap as usize));
                            let _ = std::fs::write(&wd_file, tail);
                        }
                    }
                }
            }
        });
        let thread = std::thread::spawn(move || {
            let outcome = run_sandboxed(&spec, &mut ctl);
            let mut r = rec_thread.lock().unwrap();
            r.ended_at_ms = Some(now_ms());
            match &outcome {
                Ok(o) => {
                    r.cgroup = Some(o.cgroup.clone());
                    let stopped = stop_thread.load(Ordering::SeqCst);
                    match o.exit {
                        crate::sandbox::ExitKind::Exited(c) => {
                            r.state = if stopped {
                                "stopped".into()
                            } else {
                                "exited".into()
                            };
                            r.exit_code = Some(c);
                        }
                        crate::sandbox::ExitKind::Signaled(s) => {
                            r.state = if stopped {
                                "stopped".into()
                            } else {
                                "exited".into()
                            };
                            r.exit_code = Some(128 + s);
                        }
                        crate::sandbox::ExitKind::Timeout => {
                            r.state = "exited".into();
                            r.exit_code = Some(124);
                        }
                        crate::sandbox::ExitKind::MemoryLimit
                        | crate::sandbox::ExitKind::ProcessLimit => {
                            r.state = "failed".into();
                            r.exit_code = Some(137);
                        }
                        crate::sandbox::ExitKind::Cancelled
                        | crate::sandbox::ExitKind::Revoked(_) => {
                            r.state = "stopped".into();
                            r.exit_code = None;
                        }
                    }
                }
                Err(e) => {
                    r.state = "failed".into();
                    r.display = format!("{} [start failed: {}]", r.display, e.message);
                }
            }
            // final storage-bound enforcement (the watchdog bounds growth while running;
            // a job that outruns it is cut to the tail here, and the record says so)
            let log_path = dir_thread.join("logs").join(&r.id).join("out.log");
            if let Ok(md) = std::fs::metadata(&log_path) {
                if md.len() > cap {
                    if let Ok(mut data) = std::fs::read(&log_path) {
                        let tail = data.split_off(data.len().saturating_sub(cap as usize));
                        let _ = std::fs::write(&log_path, tail);
                        r.log_truncated = true;
                    }
                }
                r.log_bytes = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
            }
            let _ = persist_at(&dir_thread, &r);
        });
        // record the supervisor pid once known (best effort, short wait), then open the
        // host-loopback bridges (they relay through the gate's sockets; no namespace entry)
        for _ in 0..50 {
            if let Some(pid) = *pid_slot.lock().unwrap() {
                let mut r = record.lock().unwrap();
                r.pid = Some(pid);
                let _ = self.persist(&r);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let mut bridges = Vec::new();
        let mut exposed = Vec::new();
        for (job_port, host_port) in &start.expose {
            match crate::devbridge::DevBridge::start(dev_dir.clone(), *job_port, *host_port) {
                Ok(b) => {
                    exposed.push((*job_port, b.host_port));
                    bridges.push(b);
                }
                Err(e) => {
                    let mut r = record.lock().unwrap();
                    r.display = format!("{} [bridge {job_port} failed: {}]", r.display, e.message);
                    let _ = self.persist(&r);
                }
            }
        }
        if !exposed.is_empty() {
            let mut r = record.lock().unwrap();
            r.exposed = exposed;
            let _ = self.persist(&r);
        }
        let snapshot = record.lock().unwrap().clone();
        self.jobs.lock().unwrap().insert(
            id.clone(),
            Handle {
                record,
                stop,
                bridges,
                _mount: start.mount,
                thread: Some(thread),
            },
        );
        Ok(snapshot)
    }

    pub fn status(&self, id: &str) -> Result<JobRecord, ToolError> {
        // Prefer the durable record of jobs this manager does not supervise (history).
        if let Some(h) = self.jobs.lock().unwrap().get(id) {
            let mut r = h.record.lock().unwrap().clone();
            if let Ok(md) = std::fs::metadata(self.dir.join("logs").join(id).join("out.log")) {
                r.log_bytes = md.len();
            }
            return Ok(r);
        }
        let p = self.dir.join(format!("{id}.json"));
        let text = std::fs::read_to_string(&p).map_err(|_| refuse(format!("no such job: {id}")))?;
        serde_json::from_str(&text).map_err(|e| refuse(format!("job record unreadable: {e}")))
    }

    pub fn list(&self) -> Vec<JobRecord> {
        self.reconcile().unwrap_or_default()
    }

    /// Bounded tail of the job's combined log.
    pub fn logs(&self, id: &str, max_bytes: usize) -> Result<String, ToolError> {
        let p = self.dir.join("logs").join(id).join("out.log");
        let mut f = std::fs::File::open(&p).map_err(|_| refuse(format!("no log for job {id}")))?;
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let keep = (max_bytes as u64).min(len);
        f.seek(SeekFrom::Start(len - keep))
            .map_err(|e| refuse(format!("log seek: {e}")))?;
        let mut buf = vec![0u8; keep as usize];
        f.read_exact(&mut buf)
            .map_err(|e| refuse(format!("log read: {e}")))?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    /// Stop the job and its complete supervised process tree (the sandbox supervisor kills
    /// the cgroup), and remove every port exposure.
    pub fn stop(&self, id: &str) -> Result<JobRecord, ToolError> {
        let mut handle = self
            .jobs
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| refuse(format!("no running job: {id}")))?;
        handle.stop.store(true, Ordering::SeqCst);
        drop(handle.bridges); // listeners close: exposure removed first
        if let Some(t) = handle.thread.take() {
            let _ = t.join();
        }
        let r = handle.record.lock().unwrap().clone();
        self.persist(&r)?;
        Ok(r)
    }

    /// Stop everything (daemon shutdown, revocation, manager drop).
    pub fn stop_all(&self) {
        let ids: Vec<String> = self.jobs.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
}

fn persist_at(dir: &Path, rec: &JobRecord) -> Result<(), ToolError> {
    let p = dir.join(format!("{}.json", rec.id));
    let tmp = dir.join(format!("{}.json.tmp", rec.id));
    std::fs::write(&tmp, serde_json::to_string_pretty(rec).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &p))
        .map_err(|e| refuse(format!("persist job record: {e}")))
}

impl Drop for JobManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}
