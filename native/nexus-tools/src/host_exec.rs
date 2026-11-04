//! M8 Full Access: the host execution backend (ADR Rev 2 §7.4).
//!
//! Commands run as the current OS user, in the real working directory, with no
//! mount/network namespace, no Landlock and no seccomp. This is reachable only
//! when the Kernel-sealed filesystem scope is `Full`, which only a user grant
//! can mint; the confined backends never route here on failure.
//!
//! Supervision is honest about what it is: a process group with
//! `PR_SET_PDEATHSIG`, wall-clock bound, cancellation/revocation polling and a
//! group kill; when the machine offers a writable cgroup v2 each execution also
//! gets its own leaf, so `setsid`/daemonized descendants are reached by
//! `cgroup.kill` as well. Without one the run degrades to the process group and
//! says so, and it never waits indefinitely for output a detached descendant
//! keeps open. Inside the project, a bounded pre/post stat manifest reports
//! observed changes; effects outside the project are NOT observed and cannot
//! be undone by Nexus, and the result says so.

use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::result::{ToolError, ToolErrorCode};
use crate::sandbox::{ExitKind, SandboxOutcome};

/// Host environment allow-list (ADR §7.4): credential-bearing variables are
/// not inherited. `HOME` is included because host toolchains require it; it
/// carries no credential by itself.
const HOST_ENV_KEYS: [&str; 8] = [
    "PATH", "HOME", "LANG", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR",
];

pub fn host_env(model_env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for k in HOST_ENV_KEYS {
        if let Ok(v) = std::env::var(k) {
            env.insert(k.to_owned(), v);
        }
    }
    for (k, v) in std::env::vars() {
        if k.starts_with("LC_") {
            env.insert(k, v);
        }
    }
    // Model-proposed variables may not replace the resolution-critical ones.
    for (k, v) in model_env {
        if k == "PATH" || k == "HOME" || k.starts_with("NEXUS_") {
            continue;
        }
        env.insert(k.clone(), v.clone());
    }
    env
}

/// Resolve a program for the host: project-relative paths stay inside the
/// workspace root, absolute paths are used as given, bare names search PATH.
pub fn resolve_host_program(program: &str, root: &Path) -> Result<PathBuf, ToolError> {
    let refused = |m: String| ToolError::new(ToolErrorCode::CommandRefused, m);
    // the program is absent: not a policy decision
    let missing = |m: String| ToolError::new(ToolErrorCode::ExecutableNotFound, m);
    if program.is_empty() || program.contains('\0') {
        return Err(refused("empty program name".into()));
    }
    let p = Path::new(program);
    if p.is_absolute() {
        return if p.exists() {
            Ok(p.to_path_buf())
        } else {
            Err(missing(format!(
                "program '{program}' does not exist on this machine; install it or correct the path (nothing was run, and no other backend was substituted)"
            )))
        };
    }
    if program.contains('/') {
        let cand = root.join(p);
        return if cand.exists() {
            Ok(cand)
        } else {
            Err(missing(format!(
                "project program '{program}' does not exist in the workspace; install it into the project or use an installed tool (nothing was run)"
            )))
        };
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join(program);
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    Err(missing(format!(
        "program '{program}' is not installed on this machine (not found on PATH); install it first (nothing was run, and no other backend was substituted)"
    )))
}

pub struct HostRun<'a> {
    pub program: PathBuf,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub wall_ms: u64,
    pub tail_bytes: usize,
    pub should_stop: &'a mut dyn FnMut() -> Option<&'static str>,
}

/// How one host command is supervised.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Supervision {
    /// A dedicated cgroup v2 leaf when the machine offers a writable one, else the process group.
    Auto,
    /// The process group only: what a run degrades to without a writable cgroup. Selectable so that the
    /// degraded mode can be exercised on a machine that does have cgroups.
    ProcessGroupOnly,
}

/// Longest wait, after the command has ended, for its output pipes to reach EOF before the readers are told
/// to stop. With a cgroup leaf every writer is dead by then; this only matters when a detached descendant
/// that Nexus could not reach still holds a pipe.
const READER_GRACE: Duration = Duration::from_millis(1000);
/// Once told to stop, a reader drains at most this long (the data already in the pipe), then returns.
const READER_STOP_DRAIN: Duration = Duration::from_millis(250);
const READER_POLL_MS: libc::c_int = 50;

/// A token no other host execution of this process has used or will use: wall-clock nanoseconds, forced
/// strictly above every earlier token. The clock alone is not unique (two threads can read the same tick,
/// and every execution of a process shares its pid and start time), and a duplicate leaf name made the second
/// `mkdir` fail, which silently dropped that run's cgroup supervision.
fn unique_leaf_token() -> u64 {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut prev = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(prev.saturating_add(1));
        match LAST.compare_exchange_weak(prev, next, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => prev = seen,
        }
    }
}

/// The leaf name of one execution: `nexus-host-<supervisor pid>-<supervisor start>-<unique token>`
/// (the shape `orphan_host_leaf` reads).
fn leaf_name() -> String {
    let pid = std::process::id();
    format!(
        "nexus-host-{pid}-{}-{}",
        supervisor_start(pid).unwrap_or(0),
        unique_leaf_token()
    )
}

/// Create this execution's supervision leaf. An existing name is never adopted (it would be another live
/// execution's cgroup): take a fresh token and try again. Any other failure is returned so that the run says
/// why it degraded, instead of silently losing the guarantee.
fn create_leaf(base: &Path) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let leaf = base.join(leaf_name());
        match std::fs::create_dir(&leaf) {
            Ok(()) => return Ok(leaf),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", leaf.display())),
        }
    }
    Err("no unused cgroup leaf name after 8 attempts".into())
}

/// Spawn and supervise one host command. Kills the whole process group (and, with a cgroup leaf, every
/// descendant) when `should_stop` fires or the wall bound expires.
pub fn run_host(run: HostRun<'_>) -> Result<SandboxOutcome, ToolError> {
    run_host_with(run, Supervision::Auto)
}

pub fn run_host_with(
    run: HostRun<'_>,
    supervision: Supervision,
) -> Result<SandboxOutcome, ToolError> {
    use std::os::unix::process::CommandExt;
    let started = Instant::now();
    // M8.1: supervise through a dedicated cgroup v2 leaf when the machine
    // offers one (the same infrastructure as the sandbox, but membership and
    // kill only — no limits, no confinement). `setsid`/daemonized descendants
    // stay in the cgroup, so `cgroup.kill` reaches what a process-group kill
    // cannot. Without a writable cgroup the run honestly falls back to
    // process-group supervision and says so in its outcome.
    // Why supervision is only the process group, when it is (reported in the outcome).
    let mut degraded: Option<String> = None;
    let cgroup: Option<PathBuf> = match supervision {
        Supervision::ProcessGroupOnly => {
            degraded = Some("process-group supervision requested".into());
            None
        }
        Supervision::Auto => match crate::sandbox::cgroup_base() {
            None => {
                degraded = Some("no writable cgroup v2 on this machine".into());
                None
            }
            Some(base) => match create_leaf(&base) {
                Ok(leaf) => Some(leaf),
                Err(why) => {
                    degraded = Some(why);
                    None
                }
            },
        },
    };

    let mut cmd = Command::new(&run.program);
    cmd.args(&run.argv[1.min(run.argv.len())..])
        .current_dir(&run.cwd)
        .env_clear()
        .envs(&run.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let leaf_for_child = cgroup
        .as_ref()
        .map(|l| l.join("cgroup.procs").to_string_lossy().into_owned());
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            // Join the supervision cgroup BEFORE exec: a post-spawn write by
            // the supervisor races the workload's first fork, and a descendant
            // forked in that window would keep the parent cgroup and escape
            // `cgroup.kill`. A failure here is not fatal to the spawn; the
            // supervisor verifies membership and degrades honestly.
            if let Some(procs) = &leaf_for_child {
                let _ = std::fs::write(procs, std::process::id().to_string());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| {
        ToolError::new(
            ToolErrorCode::SandboxUnavailable,
            format!("host spawn failed: {e}; nothing was run"),
        )
    })?;
    let pid = child.id();
    // Verify the child actually joined the leaf (its pre-exec write is the
    // race-free path; this write is a second chance). Without membership the
    // run degrades to process-group supervision and reports that honestly.
    let cgroup: Option<PathBuf> = match cgroup {
        Some(leaf) => {
            let member = std::fs::read_to_string(leaf.join("cgroup.procs"))
                .is_ok_and(|s| s.lines().any(|l| l.trim() == pid.to_string()));
            if member || std::fs::write(leaf.join("cgroup.procs"), pid.to_string()).is_ok() {
                Some(leaf)
            } else {
                degraded = Some(format!(
                    "the command could not be moved into {}",
                    leaf.display()
                ));
                let _ = std::fs::remove_dir(&leaf);
                None
            }
        }
        None => None,
    };
    let cap = run.tail_bytes;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let stop_readers = Arc::new(AtomicBool::new(false));
    let (s_out, s_err) = (stop_readers.clone(), stop_readers.clone());
    let t_out = std::thread::spawn(move || read_tail(&mut out_pipe, cap, &s_out));
    let t_err = std::thread::spawn(move || read_tail(&mut err_pipe, cap, &s_err));
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break exit_kind(status),
            Ok(None) => {}
            Err(e) => {
                return Err(ToolError::new(
                    ToolErrorCode::SandboxUnavailable,
                    format!("host wait failed: {e}"),
                ))
            }
        }
        if started.elapsed() > Duration::from_millis(run.wall_ms.max(1)) {
            kill_tree(&cgroup, pid);
            let _ = child.wait();
            break ExitKind::Timeout;
        }
        if let Some(reason) = (run.should_stop)() {
            let kind = match reason {
                "revoked" => ExitKind::Revoked("grant revoked".into()),
                _ => ExitKind::Cancelled,
            };
            kill_tree(&cgroup, pid);
            let _ = child.wait();
            break kind;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // Nothing the command detached may outlive it under Nexus supervision:
    // when a cgroup leaf is in use it is killed and removed here, on every
    // terminal path, so daemonized descendants end with the execution. This
    // must happen BEFORE joining the pipe readers: a detached descendant
    // inherits the pipes and would otherwise hold them open.
    let cgroup_reaped = cgroup
        .as_ref()
        .is_some_and(|cg| crate::sandbox::kill_and_remove_cgroup(cg));
    // Without a leaf (or if its removal could not be confirmed) a descendant that left the process group
    // can still hold a pipe. The readers therefore get a bounded grace to reach EOF and are then told to
    // stop; the run never waits indefinitely on output it cannot end.
    let (out_tail, err_tail) = finish_readers(t_out, t_err, &stop_readers);
    let still_open = out_tail.still_open || err_tail.still_open;
    let note = |s: &str| {
        let mut n = String::new();
        if let Some(d) = &degraded {
            n.push_str(&format!(" (cgroup supervision unavailable: {d})"));
        }
        if still_open {
            n.push_str(" (an output pipe was still held by a descendant Nexus could not reach when the command ended; output may be incomplete)");
        }
        format!("{s}{n}")
    };
    Ok(SandboxOutcome {
        exit,
        stdout: out_tail.bytes,
        stderr: err_tail.bytes,
        stdout_bytes: out_tail.total,
        stderr_bytes: err_tail.total,
        stdout_truncated: out_tail.truncated,
        stderr_truncated: err_tail.truncated,
        wall_ms: started.elapsed().as_millis() as u64,
        user_ms: 0,
        sys_ms: 0,
        max_rss_kb: 0,
        signal_hint: None,
        peak_rss_bytes: 0,
        peak_procs: 0,
        cgroup: match &cgroup {
            Some(cg) if cgroup_reaped => note(&format!("{} (killed and removed)", cg.display())),
            Some(cg) => note(&format!("{} (removal unconfirmed)", cg.display())),
            None => note(&format!("host-process-group:{pid}")),
        },
        resource_enforcement: if cgroup.is_some() {
            "kernel-cgroup"
        } else {
            "process-group-polling"
        },
        oom_killed: false,
        pids_limit_hit: false,
    })
}

fn exit_kind(status: std::process::ExitStatus) -> ExitKind {
    use std::os::unix::process::ExitStatusExt;
    if let Some(code) = status.code() {
        ExitKind::Exited(code)
    } else if let Some(sig) = status.signal() {
        ExitKind::Signaled(sig)
    } else {
        ExitKind::Exited(-1)
    }
}

/// Kill the whole supervised tree: by cgroup when supervised that way
/// (reaches `setsid` escapees), else by process group (best effort).
fn kill_tree(cgroup: &Option<PathBuf>, pid: u32) {
    match cgroup {
        Some(cg) => {
            crate::sandbox::kill_and_remove_cgroup(cg);
        }
        None => kill_group(pid),
    }
}

fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// What one output pipe delivered.
#[derive(Default)]
struct Tail {
    /// The bounded tail (at most `cap` bytes).
    bytes: Vec<u8>,
    total: u64,
    truncated: bool,
    /// The reader was stopped before EOF: some process still held the write end.
    still_open: bool,
}

/// Read a pipe, keeping only the bounded tail. Ends at EOF; once `stop` is set it ends after draining what
/// is already in the pipe (at most `READER_STOP_DRAIN`), so a detached writer that never exits cannot keep
/// the supervisor waiting forever.
fn read_tail(pipe: &mut Option<impl Read + AsRawFd>, cap: usize, stop: &AtomicBool) -> Tail {
    let Some(p) = pipe.as_mut() else {
        return Tail::default();
    };
    let fd = p.as_raw_fd();
    let mut t = Tail::default();
    let mut buf = [0u8; 8192];
    let mut stopped_at: Option<Instant> = None;
    loop {
        if stop.load(Ordering::Acquire) {
            stopped_at.get_or_insert_with(Instant::now);
        }
        if stopped_at.is_some_and(|at| at.elapsed() > READER_STOP_DRAIN) {
            t.still_open = true;
            break;
        }
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd, count 1; the fd is owned by `p` for the whole call.
        let ready = unsafe { libc::poll(&mut pfd, 1, READER_POLL_MS) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if ready == 0 {
            if stopped_at.is_some() {
                t.still_open = true;
                break;
            }
            continue;
        }
        // readable, hung up or errored: this read does not block
        match p.read(&mut buf) {
            Ok(0) => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(n) => {
                t.total += n as u64;
                t.bytes.extend_from_slice(&buf[..n]);
                if t.bytes.len() > cap {
                    let drop = t.bytes.len() - cap;
                    t.bytes.drain(..drop);
                }
            }
        }
    }
    t.truncated = t.total as usize > cap;
    t
}

/// Wait, bounded, for both readers to reach EOF; then tell any straggler to stop and join both.
fn finish_readers(
    t_out: std::thread::JoinHandle<Tail>,
    t_err: std::thread::JoinHandle<Tail>,
    stop: &AtomicBool,
) -> (Tail, Tail) {
    let deadline = Instant::now() + READER_GRACE;
    while Instant::now() < deadline && !(t_out.is_finished() && t_err.is_finished()) {
        std::thread::sleep(Duration::from_millis(10));
    }
    stop.store(true, Ordering::Release);
    (
        t_out.join().unwrap_or_default(),
        t_err.join().unwrap_or_default(),
    )
}

/// Bounded stat manifest of the project (M8C): rel path -> (len, mtime).
/// Never follows symlinks out of the tree; stops at `max` entries.
pub fn project_manifest(root: &Path, max: usize) -> (BTreeMap<String, (u64, i64)>, bool) {
    let mut map = BTreeMap::new();
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, String, u32)> = vec![(root.to_path_buf(), String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            if map.len() >= max {
                truncated = true;
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                if depth < 24 {
                    stack.push((e.path(), r, depth + 1));
                }
            } else if md.is_file() {
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as i64)
                    .unwrap_or(0);
                map.insert(r, (md.len(), mtime));
            }
        }
    }
    (map, truncated)
}

/// Diff two project manifests into bounded counts plus a sample of paths.
pub fn manifest_diff(
    pre: &BTreeMap<String, (u64, i64)>,
    post: &BTreeMap<String, (u64, i64)>,
) -> serde_json::Value {
    let mut created: Vec<&String> = Vec::new();
    let mut modified: Vec<&String> = Vec::new();
    let mut deleted: Vec<&String> = Vec::new();
    for (k, v) in post {
        match pre.get(k) {
            None => created.push(k),
            Some(u) if u != v => modified.push(k),
            _ => {}
        }
    }
    for k in pre.keys() {
        if !post.contains_key(k) {
            deleted.push(k);
        }
    }
    let sample =
        |v: &[&String]| -> Vec<String> { v.iter().take(50).map(|s| (*s).clone()).collect() };
    serde_json::json!({
        "observedInProject": true,
        "created": created.len(), "modified": modified.len(), "deleted": deleted.len(),
        "createdSample": sample(&created), "modifiedSample": sample(&modified),
        "deletedSample": sample(&deleted),
        "outsideProjectEffects": "not observed: a Full Access command can change anything the OS user can reach; Nexus does not scan outside the project and cannot undo those effects",
        "recoverable": false,
    })
}

fn supervisor_start(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

/// Only reap leaves whose recorded supervisor is no longer that process.
/// Live supervisors can belong to another daemon using the same user cgroup.
fn orphan_host_leaf(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("nexus-host-") else {
        return false;
    };
    let parts: Vec<_> = rest.split('-').collect();
    if !(parts.len() == 2 || parts.len() == 3) || parts.iter().any(|p| p.parse::<u128>().is_err()) {
        return false;
    }
    let Ok(pid) = parts[0].parse::<u32>() else {
        return false;
    };
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        Ok(_) if parts.len() == 2 || parts[1] == "0" => false, // legacy leaf: do not kill a live owner
        Ok(_) => supervisor_start(pid).is_some_and(|start| Some(start) != parts[1].parse().ok()),
    }
}

pub fn reap_orphan_host_cgroups(base: &Path) {
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            if entry.file_name().to_str().is_some_and(orphan_host_leaf) {
                crate::sandbox::kill_and_remove_cgroup(&entry.path());
            }
        }
    }
}

#[cfg(test)]
mod supervisor_identity_tests {
    #[test]
    fn live_supervisors_and_reused_pids_are_distinguished() {
        let pid = std::process::id();
        let start = super::supervisor_start(pid).unwrap();
        assert!(!super::orphan_host_leaf(&format!(
            "nexus-host-{pid}-{start}-1"
        )));
        assert!(super::orphan_host_leaf(&format!(
            "nexus-host-{pid}-{}-1",
            start + 1
        )));
        assert!(!super::orphan_host_leaf(&format!("nexus-host-{pid}-1")));
        assert!(super::orphan_host_leaf("nexus-host-0-1-1"));
        for name in [
            "nexus-exec-test",
            "nexus-host-invalid",
            "nexus-host-1-2-3-4",
        ] {
            assert!(!super::orphan_host_leaf(name));
        }
    }

    #[test]
    fn leaf_tokens_are_unique_even_when_threads_read_the_same_clock_tick() {
        use std::collections::HashSet;
        let all: Vec<Vec<u64>> = std::thread::scope(|scope| {
            let hs: Vec<_> = (0..16)
                .map(|_| scope.spawn(|| (0..2000).map(|_| super::unique_leaf_token()).collect()))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut seen = HashSet::new();
        for per_thread in &all {
            assert!(per_thread.windows(2).all(|w| w[0] < w[1]), "not increasing");
            for t in per_thread {
                assert!(seen.insert(*t), "token {t} issued twice");
            }
        }
        assert_eq!(seen.len(), 16 * 2000);
    }

    #[test]
    fn a_generated_leaf_name_is_a_live_supervisors_and_never_repeats() {
        let a = super::leaf_name();
        let b = super::leaf_name();
        assert_ne!(a, b);
        assert!(!super::orphan_host_leaf(&a) && !super::orphan_host_leaf(&b));
    }

    #[test]
    fn leaf_creation_gives_distinct_directories_and_reports_why_it_failed() {
        let dir = tempfile::tempdir().unwrap();
        let a = super::create_leaf(dir.path()).unwrap();
        let b = super::create_leaf(dir.path()).unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        let why = super::create_leaf(&dir.path().join("missing/base")).unwrap_err();
        assert!(why.contains("cannot create"), "{why}");
    }

    fn pipe() -> (std::fs::File, i32) {
        use std::os::unix::io::FromRawFd;
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (unsafe { std::fs::File::from_raw_fd(fds[0]) }, fds[1])
    }

    #[test]
    fn a_reader_returns_at_eof_when_every_writer_is_gone() {
        let (r, w) = pipe();
        unsafe {
            libc::write(w, b"all of it".as_ptr().cast(), 9);
            libc::close(w);
        }
        let stop = std::sync::atomic::AtomicBool::new(false);
        let t = super::read_tail(&mut Some(r), 1024, &stop);
        assert_eq!(t.bytes, b"all of it");
        assert!(!t.still_open);
    }

    #[test]
    fn a_reader_is_released_when_a_writer_never_closes_and_keeps_what_arrived() {
        let (r, w) = pipe();
        unsafe { libc::write(w, b"partial".as_ptr().cast(), 7) };
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s2 = stop.clone();
        let reader = std::thread::spawn(move || super::read_tail(&mut Some(r), 1024, &s2));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !reader.is_finished(),
            "must keep waiting while not told to stop"
        );
        stop.store(true, std::sync::atomic::Ordering::Release);
        let started = std::time::Instant::now();
        let t = reader.join().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(t.bytes, b"partial");
        assert!(t.still_open);
        unsafe { libc::close(w) };
    }
}
