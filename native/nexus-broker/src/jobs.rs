//! M7D: background-job control surface (broker verbs `job-start`, `job-status`, `job-logs`,
//! `job-stop`, `job-list`). The broker owns the [`JobManager`]; jobs run in the project's real
//! (Direct) folder under the project's standing grant, frozen at start. The model has no path
//! to these verbs (the broker socket is uid-gated); the future agent tools call the same
//! surface. A per-job watcher stops the job if the grant is revoked, expires, or no longer
//! covers an exposed development port — a job cannot outlive its authority.

use crate::projects::Env;
use nexus_tools::contract::ProcessArgs;
use nexus_tools::grant::StandingGrant;
use nexus_tools::inplace::{self, PrepareOptions};
use nexus_tools::jobs::{JobManager, JobStart};
use nexus_tools::process::{CommandPolicy, Toolchain};
use nexus_tools::registry::{self, WorkspaceMode};
use nexus_tools::sandbox::{cgroup_base, ConfineSpec, SandboxLimits, SandboxSpec};
use nexus_tools::workspace::{Workspace, WorkspacePolicy};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

type CmdErr = (&'static str, String);
fn bad(code: &'static str, m: impl Into<String>) -> CmdErr {
    (code, m.into())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_project(env: &Env<'_>, id: &str) -> Result<registry::ProjectRecord, CmdErr> {
    let f = registry::load(env.registry_dir, env.trust)
        .map_err(|e| bad("registry-untrusted", e.message))?;
    f.projects
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| bad("not-found", format!("no such project: {id}")))
}

fn active_grant(rec: &registry::ProjectRecord) -> Result<StandingGrant, CmdErr> {
    let st = rec.grant.as_ref().ok_or_else(|| {
        bad(
            "no-grant",
            "this project has no standing permission; grant one first",
        )
    })?;
    let now = now_ms();
    if st.status(now).as_str() != "active" {
        return Err(bad(
            "grant-inactive",
            format!("the project's permission is {}", st.status(now).as_str()),
        ));
    }
    Ok(st.current.clone())
}

fn record_json(r: &nexus_tools::jobs::JobRecord, ready_ports: bool) -> Value {
    json!({
        "jobId": r.id, "state": r.state, "command": r.display, "task": r.task,
        "authority": r.authority, "projectId": r.project, "startedAtMs": r.started_at_ms, "endedAtMs": r.ended_at_ms,
        "exitCode": r.exit_code, "pid": r.pid,
        "exposed": r.exposed.iter().map(|(p, h)| json!({"port": p, "hostPort": h, "url": format!("http://127.0.0.1:{h}")})).collect::<Vec<_>>(),
        "ready": ready_ports && r.state == "running" && !r.exposed.is_empty(),
        "logBytes": r.log_bytes, "logTruncated": r.log_truncated,
    })
}

/// Start a background job in the project's Direct folder under its frozen grant.
pub fn job_start(
    mgr: &Arc<JobManager>,
    env: &Env<'_>,
    state_dir: &std::path::Path,
    params: &Value,
) -> Result<Value, CmdErr> {
    let id = params
        .get("projectId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let rec = load_project(env, id)?;
    if rec.workspace_mode != WorkspaceMode::Direct {
        return Err(bad(
            "not-available",
            "background jobs need a Direct Workspace project (commands run in the real project folder)",
        ));
    }
    let grant = active_grant(&rec)?;
    if grant.fs != "workspace" {
        return Err(bad(
            "not-available",
            "background jobs need a Workspace (in-place) permission for this project",
        ));
    }
    let frozen = grant.frozen(&rec.id);
    let program = params
        .get("program")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad("bad-request", "program is required"))?;
    let args: Vec<String> = params
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let cwd = params
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(".")
        .to_owned();
    let expose: Vec<(u16, u16)> = params
        .get("exposePorts")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64().and_then(|n| u16::try_from(n).ok()))
                .map(|p| (p, 0))
                .collect()
        })
        .unwrap_or_default();
    let root = rec
        .origin
        .clone()
        .unwrap_or_else(|| rec.source_path.clone());
    // must be read BEFORE the job starts: a job that creates .git immediately would otherwise look like it had one
    let git_before = std::fs::symlink_metadata(std::path::Path::new(&root).join(".git")).is_ok();
    let ws = Workspace::open_root(&root, WorkspacePolicy::default())
        .map_err(|e| bad("workspace-error", e.message))?;
    let policy = CommandPolicy::standard(Toolchain::discover()).with_workbench();
    let cmd = policy
        .resolve(&ProcessArgs {
            program: program.to_owned(),
            args: args.clone(),
            cwd: cwd.clone(),
        })
        .map_err(|e| bad("command-refused", e.message))?;
    if cmd.install {
        return Err(bad(
            "command-refused",
            "dependency installation runs as a foreground command, not a background job",
        ));
    }
    let mount = inplace::prepare_with(
        &ws,
        &PrepareOptions {
            git_worktree: frozen.exec.git_worktree == "read-only",
            git_write: frozen.exec.git_write,
            forbidden: env.forbidden.clone(),
            ..Default::default()
        },
    )
    .map_err(|e| bad("workspace-error", e.message))?;
    let shim = nexus_tools::confine_host::locate_shim()
        .ok_or_else(|| bad("not-available", "the sandbox launch gate is not available"))?;
    let sha = nexus_tools::confine_host::shim_is_trustworthy(&shim)
        .map_err(|e| bad("not-available", e))?;
    let ident = nexus_tools::observe::root_identity(&ws)
        .ok_or_else(|| bad("workspace-error", "workspace root identity unavailable"))?;
    let env_dir = state_dir.join("job-env").join(&rec.id);
    std::fs::create_dir_all(&env_dir).map_err(|e| bad("io-error", e.to_string()))?;
    let wall = params
        .get("maxRuntimeMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(30 * 60_000)
        .min(2 * 3_600_000);
    let spec = SandboxSpec {
        id: "job".into(),
        program: cmd.program.clone(),
        args: cmd.argv.clone(),
        src_dir: PathBuf::new(),
        cwd: cmd.cwd.clone(),
        env: cmd.env.clone(),
        ro_binds: vec![],
        rw_binds: vec![(env_dir, "/work/env".into())],
        src_writable: true,
        pinned_root: Some(mount.root_fd()),
        protect: mount.protect(),
        fd_ro_binds: mount.fd_ro_binds(),
        egress: None,
        dev: None,
        net: false,
        limits: SandboxLimits {
            wall_ms: wall,
            cpu_secs: 3_600,
            ..Default::default()
        },
        cgroup_base: cgroup_base()
            .ok_or_else(|| bad("not-available", "cgroup v2 is not available"))?,
        confine: Some(ConfineSpec {
            shim,
            shim_sha256: sha,
            root: (ident.dev, ident.ino),
            min_abi: nexus_tools::confine::MIN_ABI,
            require_scope: false,
        }),
    };
    let task = params
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("interactive")
        .to_owned();
    let rec_job = mgr
        .start(JobStart {
            spec,
            mount: Some(mount),
            display: format!("{} {}", cmd.name, cmd.argv.join(" ")),
            task,
            authority: frozen.digest.clone(),
            project: rec.id.clone(),
            authorized_ports: frozen.exec.dev_ports.clone(),
            expose,
            max_log_bytes: 1 << 20,
        })
        .map_err(|e| bad("command-refused", e.message))?;
    // Release 1: a job runs for as long as the person leaves it, and mounts are prepared before it starts, so
    // a `.git` it creates is unprotected for its whole life. While the job runs, and once more when it ends,
    // whatever in a `.git` THE JOB created could run later with the person's privileges is neutralised (a few
    // syscalls per tick, idempotent; a `.git` that existed before the job started is never touched).
    let git_root = PathBuf::from(&root);
    let git_quarantine = state_dir.join("job-git-quarantine").join(&rec.id);
    let sweep_git = move || {
        if git_before {
            return;
        }
        if let Ok(d) = std::fs::File::open(&git_root) {
            use std::os::fd::AsRawFd;
            nexus_tools::gitguard::neutralize_created_git(
                d.as_raw_fd(),
                ".git",
                ".git",
                &git_quarantine,
            );
        }
    };
    // Revocation watcher: the job cannot outlive the authority that permitted it.
    {
        let mgr = mgr.clone();
        let job_id = rec_job.id.clone();
        let registry_dir = env.registry_dir.to_path_buf();
        let trust = env.trust.clone();
        let project_id = rec.id.clone();
        let digest = frozen.digest.clone();
        let exposed_ports: Vec<u16> = rec_job.exposed.iter().map(|(p, _)| *p).collect();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            sweep_git();
            let Ok(st) = mgr.status(&job_id) else { return };
            if st.state != "running" {
                sweep_git();
                return;
            }
            let still_valid = registry::load(&registry_dir, &trust)
                .ok()
                .and_then(|f| f.projects.into_iter().find(|p| p.id == project_id))
                .and_then(|p| p.grant)
                .map(|g| {
                    let now = now_ms();
                    g.status(now).as_str() == "active"
                        && g.current.frozen(&project_id).digest == digest
                        && exposed_ports
                            .iter()
                            .all(|p| g.current.exec.dev_ports.contains(p))
                })
                .unwrap_or(false);
            if !still_valid {
                let _ = mgr.stop(&job_id);
                return;
            }
        });
    }
    Ok(record_json(&rec_job, true))
}

pub fn job_status(mgr: &Arc<JobManager>, params: &Value) -> Result<Value, CmdErr> {
    let id = params.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let r = mgr.status(id).map_err(|e| bad("not-found", e.message))?;
    Ok(record_json(&r, true))
}

pub fn job_logs(mgr: &Arc<JobManager>, params: &Value) -> Result<Value, CmdErr> {
    let id = params.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let max = params
        .get("maxBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(16 * 1024)
        .min(256 * 1024) as usize;
    let logs = mgr.logs(id, max).map_err(|e| bad("not-found", e.message))?;
    Ok(json!({"jobId": id, "logs": logs}))
}

pub fn job_stop(mgr: &Arc<JobManager>, params: &Value) -> Result<Value, CmdErr> {
    let id = params.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let r = mgr.stop(id).map_err(|e| bad("not-found", e.message))?;
    Ok(record_json(&r, false))
}

pub fn job_list(mgr: &Arc<JobManager>, params: &Value) -> Result<Value, CmdErr> {
    // optional filter: only the jobs of one project
    let only = params.get("projectId").and_then(|v| v.as_str());
    let jobs = mgr
        .list()
        .iter()
        .filter(|r| only.is_none_or(|p| r.project == p))
        .map(|r| record_json(r, true))
        .collect::<Vec<_>>();
    Ok(json!({"jobs": jobs}))
}

/// Validate a model-proposed job tool call (M7D agent surface). The engine will dispatch
/// `job_start`/`job_status`/`job_logs`/`job_stop` here; the same rules bind every caller:
/// program names follow the universal syntax, exposed ports are plain port numbers (their
/// authorization is the grant's, checked again in `job_start`), and job ids are bounded.
pub fn validate_tool_call(name: &str, args: &Value) -> Result<(), (&'static str, String)> {
    let obj = args
        .as_object()
        .ok_or_else(|| bad("invalid-arguments", "job tool arguments must be an object"))?;
    match name {
        "job_start" => {
            let program = obj
                .get("program")
                .and_then(|v| v.as_str())
                .ok_or_else(|| bad("invalid-arguments", "job_start requires a program"))?;
            if !nexus_tools::workbench::program_syntax_ok(program) {
                return Err(bad(
                    "invalid-arguments",
                    "program must be an installed program name or a workspace-relative path",
                ));
            }
            match obj.get("exposePorts") {
                Some(Value::Array(a))
                    if a.iter()
                        .all(|v| v.as_u64().is_some_and(|n| (1..=65535).contains(&n)))
                        && a.len() <= 32 => {}
                _ => {
                    return Err(bad(
                        "invalid-arguments",
                        "exposePorts must be a list of at most 32 port numbers",
                    ))
                }
            }
            Ok(())
        }
        "job_status" | "job_stop" | "job_logs" => match obj.get("jobId").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() && s.len() <= 128 => Ok(()),
            _ => Err(bad("invalid-arguments", "a jobId is required")),
        },
        _ => Err(bad(
            "invalid-arguments",
            format!("unknown job tool: {name}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_tool_calls_are_validated_like_every_other_proposal() {
        assert!(validate_tool_call(
            "job_start",
            &json!({"program": "npm", "args": ["run", "dev"], "cwd": ".", "exposePorts": [5173]})
        )
        .is_ok());
        assert!(validate_tool_call(
            "job_start",
            &json!({"program": "/usr/bin/npm", "args": [], "cwd": ".", "exposePorts": []})
        )
        .is_err());
        assert!(validate_tool_call(
            "job_start",
            &json!({"program": "npm", "args": [], "cwd": ".", "exposePorts": [0]})
        )
        .is_err());
        assert!(validate_tool_call("job_status", &json!({"jobId": "job-1"})).is_ok());
        assert!(validate_tool_call("job_status", &json!({})).is_err());
        assert!(validate_tool_call("job_evil", &json!({})).is_err());
    }
}
