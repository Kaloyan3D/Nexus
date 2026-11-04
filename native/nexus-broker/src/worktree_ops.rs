//! A6.1.3 operator working-copy lifecycle: list, export a patch, remove.
//!
//! Operator-only: these functions need the issuer capability file and the
//! broker state directory, which no Desktop/renderer path can reach. A copy
//! belongs to one run (and so one project); only a copy of a TERMINAL run is
//! removable, the daemon independently refuses a copy with a pending approval or
//! an unfinished tool execution, and only the task id the daemon itself created
//! is ever a removal target — never a path. Audit evidence (run records, the
//! Kernel journals, transcripts and the operator log written here) lives outside
//! the copy, so removing a copy never removes evidence.

use crate::store::Store;
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub struct Ctx {
    pub state_dir: PathBuf,
    pub daemon_socket: PathBuf,
    pub cap_path: PathBuf,
}

/// Orphans (copies no run record explains) are removable only once this old.
pub const ORPHAN_MIN_AGE_MS: u64 = 10 * 60 * 1000;

fn call(c: &Ctx, cmd: &str, params: Value) -> Result<Value, String> {
    let cap = nexus_client::issuer::read_capability(&c.cap_path)
        .map_err(|e| format!("issuer capability: {}", e.message))?;
    let r = nexus_client::issuer::issuer_call(&c.daemon_socket, &cap, cmd, params)
        .map_err(|e| format!("daemon: {}", e.message))?;
    if r.get("ok") != Some(&Value::Bool(true)) {
        return Err(format!(
            "daemon refused {cmd}: {}",
            r.get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("refused")
        ));
    }
    Ok(r)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One retained working copy joined with what the broker knows about its run.
pub fn list(c: &Ctx) -> Result<Vec<Value>, String> {
    let store = Store::open(&c.state_dir).map_err(|e| format!("state dir: {e}"))?;
    let runs = store.all();
    let r = call(c, "worktree-list", json!({}))?;
    let now = now_ms();
    let mut out = Vec::new();
    for w in r["worktrees"].as_array().cloned().unwrap_or_default() {
        let task = w["taskInstanceId"].as_str().unwrap_or("");
        let rec = runs
            .iter()
            .find(|r| r.run.task_instance_id.as_deref() == Some(task));
        let age = w["createdAtMs"].as_u64().map(|c| now.saturating_sub(c));
        let (status, run_id, state) = match rec {
            Some(r) if r.run.terminal => (
                "inactive",
                Some(r.run.run_id.clone()),
                Some(r.run.state.clone()),
            ),
            Some(r) => (
                "active",
                Some(r.run.run_id.clone()),
                Some(r.run.state.clone()),
            ),
            None => ("orphan", None, None),
        };
        out.push(json!({
            "taskInstanceId": task,
            "runId": run_id,
            "runState": state,
            "status": status,
            "project": w["projectId"].clone().as_str().map(str::to_owned)
                .or_else(|| rec.and_then(|r| r.run.workspace_id.clone())),
            "baseCommit": w["sourceCommit"],
            "ageMs": age,
            "approxBytes": w["approxBytes"],
            "usageTruncated": w["usageTruncated"],
            "diffDigest": rec.and_then(|r| r.run.diff_digest.clone()),
        }));
    }
    Ok(out)
}

/// Accept a run id or a task instance id; return (task id, run id).
fn select(c: &Ctx, key: &str) -> Result<(String, Option<String>), String> {
    let store = Store::open(&c.state_dir).map_err(|e| format!("state dir: {e}"))?;
    if let Some(r) = store.load(key) {
        return r
            .run
            .task_instance_id
            .map(|t| (t, Some(key.to_owned())))
            .ok_or_else(|| "that run has no working copy".to_owned());
    }
    if nexus_tools::gitwt::valid_task_id(key) {
        let run = store
            .all()
            .into_iter()
            .find(|r| r.run.task_instance_id.as_deref() == Some(key))
            .map(|r| r.run.run_id);
        return Ok((key.to_owned(), run));
    }
    Err("not a run id or a working-copy id".into())
}

/// The reviewable patch of a copy (never applied anywhere). Writes `out`
/// exclusively (0600) when given. Refuses a truncated diff unless allowed.
pub fn patch(
    c: &Ctx,
    key: &str,
    out: Option<&Path>,
    allow_truncated: bool,
) -> Result<Value, String> {
    let (task, run) = select(c, key)?;
    let r = call(c, "worktree-diff", json!({ "taskInstanceId": task }))?;
    let d = r["diff"].clone();
    if d["diffTruncated"] == Value::Bool(true) && !allow_truncated {
        return Err("the diff is truncated (too large to export whole); repeat with --allow-truncated to export the partial diff".into());
    }
    let text = d["diff"].as_str().unwrap_or("");
    if let Some(p) = out {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(p)
            .map_err(|e| format!("cannot create {}: {e} (it must not exist)", p.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(json!({
        "taskInstanceId": task, "runId": run, "baseCommit": d["baseCommit"],
        "files": d["files"], "diffDigest": d["diffDigest"], "diffTruncated": d["diffTruncated"],
        "bytes": text.len(), "patch": if out.is_none() { Value::String(text.to_owned()) } else { Value::Null },
    }))
}

/// Explicit removal of one INACTIVE copy. Writes the operator log first.
pub fn remove(c: &Ctx, key: &str, orphan: bool) -> Result<Value, String> {
    let (task, run) = select(c, key)?;
    let items = list(c)?;
    let item = items
        .iter()
        .find(|w| w["taskInstanceId"] == task.as_str())
        .ok_or_else(|| "no such retained working copy".to_owned())?;
    match item["status"].as_str() {
        Some("inactive") => {}
        Some("active") => {
            return Err(
                "the run is still active; its working copy is leased and will not be removed"
                    .into(),
            )
        }
        _ => {
            if !orphan {
                return Err(
                    "no run record explains this copy; repeat with --orphan to remove it".into(),
                );
            }
            if item["ageMs"].as_u64().unwrap_or(0) < ORPHAN_MIN_AGE_MS {
                return Err("an unexplained copy younger than 10 minutes may belong to a run that is just starting".into());
            }
        }
    }
    let line = json!({
        "atMs": now_ms(), "op": "worktree-remove", "taskInstanceId": task, "runId": run,
        "project": item["project"], "baseCommit": item["baseCommit"], "diffDigest": item["diffDigest"],
        "approxBytes": item["approxBytes"], "uid": unsafe { libc::geteuid() },
    });
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(c.state_dir.join("worktree-ops.jsonl"))
        .map_err(|e| format!("operator log: {e}"))?;
    writeln!(log, "{line}").map_err(|e| e.to_string())?;
    log.sync_all().map_err(|e| e.to_string())?;
    call(c, "worktree-remove", json!({ "taskInstanceId": task }))?;
    Ok(json!({ "removed": task, "runId": run, "project": item["project"] }))
}
