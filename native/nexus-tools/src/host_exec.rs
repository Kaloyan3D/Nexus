//! M8 Full Access: the host execution backend (ADR Rev 2 §7.4).
//!
//! Commands run as the current OS user, in the real working directory, with no
//! mount/network namespace, no Landlock and no seccomp. This is reachable only
//! when the Kernel-sealed filesystem scope is `Full`, which only a user grant
//! can mint; the confined backends never route here on failure.
//!
//! Supervision is honest about what it is: a process group with
//! `PR_SET_PDEATHSIG`, wall-clock bound, cancellation/revocation polling and a
//! group kill. Inside the project, a bounded pre/post stat manifest reports
//! observed changes; effects outside the project are NOT observed and cannot
//! be undone by Nexus, and the result says so.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    if program.is_empty() || program.contains('\0') {
        return Err(refused("empty program name".into()));
    }
    let p = Path::new(program);
    if p.is_absolute() {
        return if p.exists() {
            Ok(p.to_path_buf())
        } else {
            Err(refused(format!(
                "program '{program}' does not exist on this machine; install it or correct the path (nothing was run, and no other backend was substituted)"
            )))
        };
    }
    if program.contains('/') {
        let cand = root.join(p);
        return if cand.exists() {
            Ok(cand)
        } else {
            Err(refused(format!(
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
    Err(refused(format!(
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

/// Spawn and supervise one host command. Kills the whole process group when
/// `should_stop` fires or the wall bound expires.
pub fn run_host(run: HostRun<'_>) -> Result<SandboxOutcome, ToolError> {
    use std::os::unix::process::CommandExt;
    let started = Instant::now();
    // M8.1: supervise through a dedicated cgroup v2 leaf when the machine
    // offers one (the same infrastructure as the sandbox, but membership and
    // kill only — no limits, no confinement). `setsid`/daemonized descendants
    // stay in the cgroup, so `cgroup.kill` reaches what a process-group kill
    // cannot. Without a writable cgroup the run honestly falls back to
    // process-group supervision and says so in its outcome.
    let leaf_name = format!(
        "nexus-host-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let cgroup: Option<PathBuf> = crate::sandbox::cgroup_base().and_then(|base| {
        let leaf = base.join(&leaf_name);
        std::fs::create_dir(&leaf).ok().map(|_| leaf)
    });

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
    let cgroup: Option<PathBuf> = cgroup.and_then(|leaf| {
        let member = std::fs::read_to_string(leaf.join("cgroup.procs"))
            .is_ok_and(|s| s.lines().any(|l| l.trim() == pid.to_string()));
        if member || std::fs::write(leaf.join("cgroup.procs"), pid.to_string()).is_ok() {
            Some(leaf)
        } else {
            let _ = std::fs::remove_dir(&leaf);
            None
        }
    });
    let cap = run.tail_bytes;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let t_out = std::thread::spawn(move || read_tail(&mut out_pipe, cap));
    let t_err = std::thread::spawn(move || read_tail(&mut err_pipe, cap));
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
    // inherits the pipes and would otherwise hold them open forever.
    let cgroup_reaped = cgroup
        .as_ref()
        .is_some_and(|cg| crate::sandbox::kill_and_remove_cgroup(cg));
    let (stdout, stdout_bytes, stdout_truncated) = t_out.join().unwrap_or_default();
    let (stderr, stderr_bytes, stderr_truncated) = t_err.join().unwrap_or_default();
    Ok(SandboxOutcome {
        exit,
        stdout,
        stderr,
        stdout_bytes,
        stderr_bytes,
        stdout_truncated,
        stderr_truncated,
        wall_ms: started.elapsed().as_millis() as u64,
        user_ms: 0,
        sys_ms: 0,
        max_rss_kb: 0,
        signal_hint: None,
        peak_rss_bytes: 0,
        peak_procs: 0,
        cgroup: match &cgroup {
            Some(cg) if cgroup_reaped => format!("{} (killed and removed)", cg.display()),
            Some(cg) => format!("{} (removal unconfirmed)", cg.display()),
            None => format!("host-process-group:{pid}"),
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

/// Read a pipe fully, keeping only the bounded tail; returns
/// (tail, total_bytes, truncated).
fn read_tail(pipe: &mut Option<impl Read>, cap: usize) -> (Vec<u8>, u64, bool) {
    let Some(p) = pipe.as_mut() else {
        return (Vec::new(), 0, false);
    };
    let mut tail: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut buf = [0u8; 8192];
    loop {
        match p.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n as u64;
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > cap {
                    let drop = tail.len() - cap;
                    tail.drain(..drop);
                }
            }
        }
    }
    (tail, total, total as usize > cap)
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
