//! Mac-side synchronization engine: stage a project to the engine, read a finished run's changes
//! back out, and apply them to the Mac folder under conflict protection with a recoverable journal.
//!
//! Trust: the guest is trusted to say what the *engine* did, never what the *Mac folder* may
//! receive. Consent, the baseline and every conflict decision live here; a path or hash coming from
//! the guest is re-validated, re-hashed and compared with the Mac's own baseline before anything is
//! written, and a result that fails any check is kept, not applied.

use super::guest::{sync_dir, write_atomic};
use super::manifest::{self, Change, ChangeKind, FileEntry, Files};
use super::policy::*;
use super::registry::*;
use super::wire::*;
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// The engine's side of the transfer protocol. In production this is the bridge; in tests it
/// is the guest staging store called directly.
pub trait Guest: Send + Sync {
    fn call(&self, req: SyncReq) -> Result<Value, SyncErr>;
}

pub struct LocalGuest(pub super::guest::GuestStore);
impl Guest for LocalGuest {
    fn call(&self, req: SyncReq) -> Result<Value, SyncErr> {
        self.0.handle(req)
    }
}

/// Test seam: make a specific step misbehave. `None` in production.
#[derive(Debug, Clone, Default)]
pub enum Fault {
    #[default]
    None,
    /// Stop dead before applying op `n` (a crash: no rollback, journal left as is).
    CrashBeforeOp(usize),
    /// Fail op `n` with an I/O error (disk full / permission): the writeback must roll back.
    IoErrorAtOp(usize),
    /// A person edits `path` just before op `n` runs.
    HostEditBeforeOp(usize, String, Vec<u8>),
}

pub struct Ctx<'a> {
    pub store: &'a Store,
    pub guest: &'a dyn Guest,
    pub fault: Fault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostErr {
    pub code: String,
    pub message: String,
}
impl HostErr {
    pub fn new(code: &str, m: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: m.into(),
        }
    }
}
impl std::fmt::Display for HostErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl From<SyncErr> for HostErr {
    fn from(e: SyncErr) -> Self {
        HostErr {
            code: e.code,
            message: e.message,
        }
    }
}
impl From<StoreError> for HostErr {
    fn from(e: StoreError) -> Self {
        HostErr::new("registry", e.0)
    }
}
fn io(e: impl std::fmt::Display) -> HostErr {
    HostErr::new("io", e.to_string())
}

fn call<T: serde::de::DeserializeOwned>(g: &dyn Guest, req: SyncReq) -> Result<T, HostErr> {
    let v = g.call(req)?;
    serde_json::from_value(v).map_err(|e| HostErr::new("protocol", e.to_string()))
}

// ======================================================================================
// project registration
// ======================================================================================

/// Validate a folder chosen in the native picker. Fail closed; returns the canonical root and
/// its identity.
pub fn validate_root(
    raw: &Path,
    home: Option<&Path>,
    app_data: &Path,
) -> Result<(PathBuf, u64, u64), HostErr> {
    let bad = |m: &str| Err(HostErr::new("bad-project", m));
    let canon = std::fs::canonicalize(raw)
        .map_err(|_| HostErr::new("bad-project", "that folder does not exist"))?;
    let md = std::fs::metadata(&canon)
        .map_err(|_| HostErr::new("bad-project", "that folder cannot be read"))?;
    if !md.is_dir() {
        return bad("a project must be a folder");
    }
    if canon.parent().is_none() {
        return bad("the filesystem root cannot be a project");
    }
    if md.uid() != unsafe_geteuid() {
        return bad("only folders you own can be opened as a project");
    }
    for top in [
        "/System",
        "/Library",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/private/etc",
        "/var",
        "/private/var",
        "/dev",
        "/Applications",
        "/Volumes",
    ] {
        if canon.starts_with(top)
            && !canon.starts_with("/private/var/folders")
            && !canon.starts_with("/var/folders")
        {
            return bad("system folders cannot be opened as a project");
        }
    }
    if let Some(h) = home {
        if canon == h || h.starts_with(&canon) {
            return bad("open a project folder, not your whole home folder");
        }
        for sensitive in [
            ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config", ".local", ".cache", "Library",
        ] {
            if canon.starts_with(h.join(sensitive)) {
                return bad(
                    "that folder holds credentials or application data and cannot be a project",
                );
            }
        }
    }
    let app_data = std::fs::canonicalize(app_data).unwrap_or_else(|_| app_data.to_owned());
    if canon.starts_with(&app_data) || app_data.starts_with(&canon) {
        return bad("that folder overlaps Nexus's own data");
    }
    Ok((canon, md.dev(), md.ino()))
}

fn unsafe_geteuid() -> u32 {
    // the owner of a freshly created temp file is the effective user
    static UID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *UID.get_or_init(|| {
        let p = std::env::temp_dir().join(format!(".nexus-uid-{}", std::process::id()));
        let uid = std::fs::File::create(&p)
            .and_then(|f| f.metadata())
            .map(|m| m.uid())
            .unwrap_or(u32::MAX);
        let _ = std::fs::remove_file(&p);
        uid
    })
}

pub fn new_project_id() -> String {
    let mut b = [0u8; 8];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    format!("mac-{}", hex::encode(b))
}

/// Folder name usable as the engine-side working copy directory name.
pub fn label_of(root: &Path) -> String {
    let raw = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned
        .trim_matches(|c| c == '.' || c == ' ' || c == '-')
        .to_owned();
    let cleaned: String = cleaned.chars().take(48).collect();
    if cleaned.is_empty() {
        "project".to_owned()
    } else {
        cleaned
    }
}

// ======================================================================================
// staging: Mac -> engine
// ======================================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageReport {
    pub unchanged: bool,
    pub generation: u64,
    pub work_path: Option<String>,
    pub created: bool,
    pub files: usize,
    pub bytes: u64,
    /// Broker project id of the engine-side working copy, when the engine reported it.
    pub guest_id: Option<String>,
}

pub fn stage_project(ctx: &Ctx, pid: &str) -> Result<StageReport, HostErr> {
    let p = ctx
        .store
        .get(pid)
        .ok_or_else(|| HostErr::new("unknown-project", "unknown project"))?;
    let consent = p
        .consent
        .as_ref()
        .ok_or_else(|| HostErr::new("no-consent", "no standing permission for this project"))?;
    if consent.root != p.root || consent.scope != SCOPE_VERSION {
        return Err(HostErr::new(
            "no-consent",
            "the permission given does not cover this folder",
        ));
    }
    if let Some(r) = p.active_run() {
        return Err(HostErr::new(
            "run-active",
            format!("run {} has not finished synchronizing", r.run_id),
        ));
    }
    if let Some(r) = p.pending_conflict() {
        return Err(HostErr::new(
            "sync-conflict",
            format!(
                "run {} has a result that could not be applied; resolve it first",
                r.run_id
            ),
        ));
    }
    let root = PathBuf::from(&p.root);
    let md = std::fs::metadata(&root)
        .map_err(|_| HostErr::new("root-changed", "the project folder is gone"))?;
    if md.dev() != p.root_dev || md.ino() != p.root_ino {
        return Err(HostErr::new(
            "root-changed",
            "the project folder was replaced; open it again",
        ));
    }
    let scan = manifest::scan(&root).map_err(|e| HostErr::new("scan", e.to_string()))?;
    let mut base = if p.staged {
        ctx.store.baseline(pid)
    } else {
        Files::new()
    };
    let mut initial = !p.staged;
    let mut changes = manifest::diff(&base, &scan.files);
    if p.staged && changes.is_empty() {
        ctx.store.update(pid, |p| {
            p.skipped = scan.skipped.clone();
            p.skipped_total = scan.skipped_total as u64;
        })?;
        return Ok(StageReport {
            unchanged: true,
            generation: p.generation,
            work_path: None,
            created: false,
            files: scan.files.len(),
            bytes: scan.total_bytes,
            guest_id: p.guest_id.clone(),
        });
    }
    let target_digest = manifest::digest(&scan.files);
    let generation = p.generation + 1;
    ctx.store.update(pid, |p| p.staging = true)?;
    let result = (|| -> Result<(CommitReply, Option<String>), HostErr> {
        let begin =
            |base: &Files, initial: bool, changes: &Vec<Change>| -> Result<StageStatus, HostErr> {
                call(
                    ctx.guest,
                    SyncReq::StageBegin {
                        project_id: pid.to_owned(),
                        label: p.label.clone(),
                        generation,
                        base_digest: if initial {
                            None
                        } else {
                            Some(manifest::digest(base))
                        },
                        target_digest: target_digest.clone(),
                        change_count: changes.len() as u64,
                    },
                )
            };
        let status = match begin(&base, initial, &changes) {
            Ok(s) => s,
            Err(e) if e.code == "baseline-mismatch" && !initial => {
                // the engine lost (or never had) its copy: stage everything again if it truly holds nothing
                let st: StageStatus = call(
                    ctx.guest,
                    SyncReq::StageStatus {
                        project_id: pid.to_owned(),
                    },
                )?;
                if st.baseline_digest.is_some() {
                    return Err(e);
                }
                base = Files::new();
                initial = true;
                changes = manifest::diff(&base, &scan.files);
                begin(&base, initial, &changes)?
            }
            Err(e) => return Err(e),
        };
        let ip = status.in_progress.clone();
        let have_changes = ip.as_ref().map(|i| i.changes_received).unwrap_or(0);
        let files_done: Vec<String> = ip
            .as_ref()
            .map(|i| i.files_done.clone())
            .unwrap_or_default();
        let partial = ip.as_ref().and_then(|i| i.partial.clone());
        // 1. the change list, in pages
        let mut start = have_changes as usize;
        while start < changes.len() {
            let end = (start + 500).min(changes.len());
            let _: Value = call(
                ctx.guest,
                SyncReq::StageChanges {
                    project_id: pid.to_owned(),
                    generation,
                    start: start as u64,
                    changes: changes[start..end].to_vec(),
                },
            )?;
            start = end;
        }
        // 2. content
        for c in &changes {
            let Some(n) = &c.new else { continue };
            if files_done.contains(&c.path) {
                continue;
            }
            let file = root.join(&c.path);
            let (sz, h) = manifest::hash_file(&file)
                .map_err(|e| HostErr::new("changed-during-staging", format!("{}: {e}", c.path)))?;
            if sz != n.size || h != n.sha256 {
                return Err(HostErr::new(
                    "changed-during-staging",
                    format!("{} changed while it was being copied; try again", c.path),
                ));
            }
            let mut off = match &partial {
                Some((p, o)) if *p == c.path => *o,
                _ => 0,
            };
            let mut f = std::fs::File::open(&file).map_err(io)?;
            loop {
                f.seek(SeekFrom::Start(off)).map_err(io)?;
                let mut buf = vec![0u8; CHUNK_BYTES.min((n.size - off) as usize)];
                f.read_exact(&mut buf).map_err(io)?;
                let r = ctx.guest.call(SyncReq::StageChunk {
                    project_id: pid.to_owned(),
                    generation,
                    path: c.path.clone(),
                    offset: off,
                    data: base64::engine::general_purpose::STANDARD.encode(&buf),
                });
                match r {
                    Ok(v) => {
                        off += buf.len() as u64;
                        if v["done"].as_bool() == Some(true) {
                            break;
                        }
                    }
                    Err(e) if e.code == "offset-mismatch" => {
                        off = e
                            .message
                            .parse()
                            .map_err(|_| HostErr::new("protocol", "offset"))?;
                    }
                    Err(e) => return Err(e.into()),
                }
                if n.size == 0 {
                    break;
                }
            }
        }
        let v = ctx.guest.call(SyncReq::StageCommit {
            project_id: pid.to_owned(),
            generation,
            target_digest: target_digest.clone(),
        })?;
        let guest_id = v["guestProjectId"].as_str().map(str::to_owned);
        let reply: CommitReply =
            serde_json::from_value(v).map_err(|e| HostErr::new("protocol", e.to_string()))?;
        Ok((reply, guest_id))
    })();
    match result {
        Ok((reply, guest_id)) => {
            ctx.store.save_baseline(pid, &scan.files)?;
            ctx.store.update(pid, |p| {
                p.generation = generation;
                p.staged = true;
                p.staging = false;
                if guest_id.is_some() {
                    p.guest_id = guest_id.clone();
                }
                p.last_sync_ms = Some(now_ms());
                p.skipped = scan.skipped.clone();
                p.skipped_total = scan.skipped_total as u64;
                p.file_count = scan.files.len() as u64;
                p.total_bytes = scan.total_bytes;
            })?;
            Ok(StageReport {
                unchanged: false,
                generation,
                work_path: Some(reply.work_path),
                created: reply.created,
                files: scan.files.len(),
                bytes: scan.total_bytes,
                guest_id,
            })
        }
        Err(e) => {
            ctx.store.update(pid, |p| p.staging = false)?;
            Err(e)
        }
    }
}

// ======================================================================================
// run qualification
// ======================================================================================

fn basic_gate(run: &Value) -> Result<(), String> {
    if run["terminal"].as_bool() != Some(true) {
        return Err("the run has not finished".into());
    }
    if run["state"].as_str() != Some("completed") {
        return Err(format!(
            "the run ended as {}",
            run["state"].as_str().unwrap_or("unknown")
        ));
    }
    if run["cancelRequested"].as_bool() == Some(true) {
        return Err("the run was cancelled".into());
    }
    if !run["errorCode"].is_null() {
        return Err("the run reported an error".into());
    }
    Ok(())
}

/// Whether the engine's own verdict on a run allows its result to reach the Mac folder.
/// `Err(reason)` = not applied (nothing is written). Based only on the broker's run record.
pub fn qualifies(run: &Value) -> Result<(), String> {
    qualifies_with(run, false)
}

/// Like [`qualifies`]; with `apply_unverified` (the person's explicit per-project choice) a finished,
/// uncancelled run whose result could not be *verified* (no test exists) is applied too. A failed check,
/// a cancelled or errored run is never applied.
pub fn qualifies_with(run: &Value, apply_unverified: bool) -> Result<(), String> {
    basic_gate(run)?;
    let co = &run["codingOutcome"];
    // M4.2: a check whose exit status could not attest it (a compound command that may have masked a failure) and
    // that nothing re-established is a suspected failure. It blocks under EVERY policy: "apply unverified" is for
    // projects where no check could be run, not a way past a check that was run and cannot be trusted. The same
    // holds for an uncertain outcome. Absent fields (an older engine) mean "no such hazard was recorded".
    if co["checksUnattestedUnresolved"].as_u64().unwrap_or(0) != 0
        || run["unresolvedUnattestedChecks"].as_u64().unwrap_or(0) != 0
        || co["verification"].as_str() == Some("unattested-checks")
        || run["completion"].as_str() == Some("unattested-checks")
    {
        return Err(
            "a verification check ran inside a compound command that cannot show it passed, so a failure may be hidden"
                .into(),
        );
    }
    if apply_unverified {
        if co["verification"].as_str() == Some("verified-failed")
            || run["completion"].as_str() == Some("failing-checks")
            || co["checksFailedUnresolved"].as_u64().unwrap_or(0) != 0
        {
            return Err("its checks failed".into());
        }
        if co["verification"].as_str() == Some("uncertain")
            || co["uncertainOperations"].as_u64().unwrap_or(0) != 0
        {
            return Err("an operation's outcome is uncertain".into());
        }
        return Ok(());
    }
    if co.is_null() {
        return Err("the run has no verification outcome".into());
    }
    if co["verification"].as_str() != Some("verified-passed") {
        return Err(match co["verification"].as_str() {
            Some("no-test-executed") | None => {
                "no test was run, so it could not be verified".to_owned()
            }
            Some(v) => format!("not verified ({v})"),
        });
    }
    if co["checksFailedUnresolved"].as_u64().unwrap_or(1) != 0
        || co["uncertainOperations"].as_u64().unwrap_or(1) != 0
        || co["staleAfterEdit"].as_bool() != Some(false)
    {
        return Err("verification is incomplete or uncertain".into());
    }
    match run["completion"].as_str() {
        Some("fulfilled") | Some("no-change-verified") => Ok(()),
        other => Err(format!(
            "the task was not completed ({})",
            other.unwrap_or("unknown")
        )),
    }
}

// ======================================================================================
// writeback: engine -> Mac
// ======================================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Applied { changed: usize },
    NotApplied(String),
    Conflict(Vec<ConflictInfo>),
    Failed(String),
}

fn set_run(ctx: &Ctx, pid: &str, run: &str, f: impl FnOnce(&mut RunRecord)) -> Result<(), HostErr> {
    ctx.store.update(pid, |p| {
        if let Some(r) = p.runs.iter_mut().find(|r| r.run_id == run) {
            f(r)
        }
    })?;
    Ok(())
}

/// Register a run that was just submitted for a project (or return the existing record).
pub fn track_run(
    store: &Store,
    pid: &str,
    run_id: &str,
    thread_id: Option<String>,
) -> Result<(), HostErr> {
    store.update(pid, |p| {
        if p.run(run_id).is_none() {
            p.runs.push(RunRecord {
                run_id: run_id.to_owned(),
                thread_id,
                sync: SyncState::Running,
                started_ms: now_ms(),
                generation_at_start: p.generation,
                verification: None,
                changed: vec![],
                conflicts: vec![],
                message: None,
                applied_ms: None,
                saved_result: None,
            });
        }
    })?;
    Ok(())
}

/// Called with the broker's authoritative run record once the run is terminal. Idempotent: calling it
/// again for the same run (duplicate completion events, app restarts) never writes twice.
pub fn writeback_run(ctx: &Ctx, pid: &str, run_id: &str, run: &Value) -> Result<Outcome, HostErr> {
    let p = ctx
        .store
        .get(pid)
        .ok_or_else(|| HostErr::new("unknown-project", "unknown project"))?;
    if let Some(rec) = p.run(run_id) {
        match &rec.sync {
            SyncState::Applied => {
                if let Some(j) = ctx.store.journal(pid, run_id) {
                    finish_applied(ctx, &j)?;
                }
                return Ok(Outcome::Applied {
                    changed: rec.changed.len(),
                });
            }
            SyncState::NotApplied { reason } => return Ok(Outcome::NotApplied(reason.clone())),
            _ => {}
        }
    }
    track_run(ctx.store, pid, run_id, None)?;
    // a journal means a writeback already started: reconcile, never restart blindly
    if let Some(j) = ctx.store.journal(pid, run_id) {
        return resume_journal(ctx, j);
    }
    let verification = run["codingOutcome"]["verification"]
        .as_str()
        .map(str::to_owned);
    set_run(ctx, pid, run_id, |r| r.verification = verification.clone())?;
    let apply_unverified = p.consent.as_ref().is_some_and(|c| c.apply_unverified);
    if let Err(reason) = qualifies_with(run, apply_unverified) {
        set_run(ctx, pid, run_id, |r| {
            r.sync = SyncState::NotApplied {
                reason: reason.clone(),
            };
            r.message = Some(reason.clone());
        })?;
        return Ok(Outcome::NotApplied(reason));
    }
    match p.consent.as_ref() {
        Some(c) if c.root == p.root && c.scope == SCOPE_VERSION => {}
        _ => {
            let reason = "no standing permission to update this folder".to_owned();
            set_run(ctx, pid, run_id, |r| {
                r.sync = SyncState::NotApplied {
                    reason: reason.clone(),
                }
            })?;
            return Ok(Outcome::NotApplied(reason));
        }
    }
    set_run(ctx, pid, run_id, |r| r.sync = SyncState::Exporting)?;
    match export_and_apply(ctx, &p, run_id) {
        Ok(o) => Ok(o),
        Err(e) => {
            // transport and engine errors leave the run exportable: it is retried, not lost
            set_run(ctx, pid, run_id, |r| r.message = Some(e.message.clone()))?;
            Err(e)
        }
    }
}

fn export_and_apply(ctx: &Ctx, p: &Project, run_id: &str) -> Result<Outcome, HostErr> {
    let pid = p.id.as_str();
    let plan: ExportPlan = call(
        ctx.guest,
        SyncReq::ExportPlan {
            project_id: pid.to_owned(),
        },
    )?;
    if plan.base_generation != p.generation {
        let m =
            "the engine's baseline does not match the Mac's; stage the project again".to_owned();
        set_run(ctx, pid, run_id, |r| {
            r.sync = SyncState::Failed;
            r.message = Some(m.clone())
        })?;
        return Ok(Outcome::Failed(m));
    }
    // never trust a plan blindly: recompute its digest and re-check every path and size
    if manifest::change_digest(&plan.changes) != plan.plan_digest {
        return fail_run(ctx, pid, run_id, "the engine's change list is inconsistent");
    }
    if plan.changes.len() > MAX_FILES {
        return fail_run(ctx, pid, run_id, "the change list is too large");
    }
    let changed: Vec<ChangedFile> = plan
        .changes
        .iter()
        .map(|c| ChangedFile {
            path: c.path.clone(),
            kind: c.kind,
        })
        .collect();
    set_run(ctx, pid, run_id, |r| r.changed = changed.clone())?;
    let mut total = 0u64;
    for c in &plan.changes {
        if !path_is_syncable(&c.path) {
            return fail_run(
                ctx,
                pid,
                run_id,
                &format!(
                    "the engine proposed a change to a protected path ({})",
                    c.path
                ),
            );
        }
        if let Some(n) = &c.new {
            if n.size > MAX_FILE_BYTES {
                return fail_run(
                    ctx,
                    pid,
                    run_id,
                    &format!("{} is larger than the limit", c.path),
                );
            }
            total += n.size;
        }
    }
    if total > MAX_TOTAL_BYTES {
        return fail_run(ctx, pid, run_id, "the result is larger than the limit");
    }
    if plan.changes.is_empty() {
        set_run(ctx, pid, run_id, |r| {
            r.sync = SyncState::Applied;
            r.applied_ms = Some(now_ms());
            r.message = Some("no files changed".into())
        })?;
        return Ok(Outcome::Applied { changed: 0 });
    }
    // download into Mac-side staging, verifying every file
    let rd = ctx.store.run_dir(pid, run_id);
    let incoming = rd.join("incoming");
    for c in &plan.changes {
        let Some(n) = &c.new else { continue };
        let dest = incoming.join(&c.path);
        if let Ok((sz, h)) = manifest::hash_file(&dest) {
            if sz == n.size && h == n.sha256 {
                continue; // already downloaded (resume)
            }
        }
        download(ctx, pid, &plan.plan_digest, &c.path, n, &dest)?;
    }
    let ops: Vec<Op> = plan
        .changes
        .iter()
        .map(|c| Op {
            path: c.path.clone(),
            kind: c.kind,
            old: c.old.clone(),
            new: c.new.clone(),
            status: OpStatus::Todo,
        })
        .collect();
    let mut j = Journal {
        run_id: run_id.to_owned(),
        project_id: pid.to_owned(),
        plan_digest: plan.plan_digest.clone(),
        base_generation: p.generation,
        new_generation: p.generation + 1,
        state: JState::Prepared,
        ops,
        conflicts: vec![],
        message: None,
        created_ms: now_ms(),
        baseline_saved: false,
        acked: false,
    };
    prepare_and_apply(ctx, p, &mut j)
}

fn fail_run(ctx: &Ctx, pid: &str, run: &str, m: &str) -> Result<Outcome, HostErr> {
    set_run(ctx, pid, run, |r| {
        r.sync = SyncState::Failed;
        r.message = Some(m.to_owned())
    })?;
    Ok(Outcome::Failed(m.to_owned()))
}

fn download(
    ctx: &Ctx,
    pid: &str,
    plan: &str,
    rel: &str,
    n: &FileEntry,
    dest: &Path,
) -> Result<(), HostErr> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(io)?;
    }
    let tmp = dest.with_extension("nexus-part");
    let mut f = std::fs::File::create(&tmp).map_err(io)?;
    let mut off = 0u64;
    while off < n.size || (n.size == 0 && off == 0) {
        let r: ReadReply = call(
            ctx.guest,
            SyncReq::ExportRead {
                project_id: pid.to_owned(),
                plan_digest: plan.to_owned(),
                path: rel.to_owned(),
                offset: off,
                len: CHUNK_BYTES as u64,
            },
        )?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&r.data)
            .map_err(|_| HostErr::new("protocol", "chunk"))?;
        if bytes.len() > CHUNK_BYTES || off + bytes.len() as u64 > n.size {
            return Err(HostErr::new(
                "protocol",
                "the engine sent more data than announced",
            ));
        }
        f.write_all(&bytes).map_err(io)?;
        off += bytes.len() as u64;
        if r.eof || bytes.is_empty() {
            break;
        }
    }
    f.sync_all().map_err(io)?;
    let (sz, h) = manifest::hash_file(&tmp).map_err(io)?;
    if sz != n.size || h != n.sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(HostErr::new(
            "hash-mismatch",
            format!("{rel} did not arrive intact"),
        ));
    }
    std::fs::rename(&tmp, dest).map_err(io)?;
    Ok(())
}

// ---- host file inspection --------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum HState {
    Absent,
    File(FileEntry),
    /// A directory, a link or anything else where a regular file was expected.
    Other(&'static str),
}

fn host_state(root: &Path, rel: &str) -> Result<HState, HostErr> {
    // never read or write through a symlink or over a non-directory ancestor
    let comps: Vec<&str> = rel.split('/').collect();
    let mut cur = root.to_owned();
    for c in &comps[..comps.len() - 1] {
        cur.push(c);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => {
                return Ok(HState::Other("a folder on the path is a link"))
            }
            Ok(m) if !m.is_dir() => return Ok(HState::Other("a file is in the way of a folder")),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HState::Absent),
            Err(e) => return Err(io(e)),
        }
    }
    let full = root.join(rel);
    match std::fs::symlink_metadata(&full) {
        Ok(m) if m.file_type().is_symlink() => Ok(HState::Other("it is a link")),
        Ok(m) if m.is_dir() => Ok(HState::Other("it is a folder")),
        Ok(m) if m.is_file() => {
            let (size, sha256) = manifest::hash_file(&full).map_err(io)?;
            Ok(HState::File(FileEntry {
                size,
                sha256,
                exec: m.permissions().mode() & 0o100 != 0,
            }))
        }
        Ok(_) => Ok(HState::Other("it is not a regular file")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HState::Absent),
        Err(e) => Err(io(e)),
    }
}

/// Another name in the same folder that is the same file on this (case/normalization-insensitive) volume.
fn name_collision(root: &Path, rel: &str) -> Option<String> {
    let mut cur = root.to_owned();
    for (i, c) in rel.split('/').enumerate() {
        let want = fold(c);
        let mut found_exact = false;
        let mut other = None;
        if let Ok(rd) = std::fs::read_dir(&cur) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n == c {
                    found_exact = true;
                } else if fold(&n) == want {
                    other = Some(n);
                }
            }
        }
        if let Some(o) = other {
            let mut shown = rel.split('/').take(i).collect::<Vec<_>>().join("/");
            if !shown.is_empty() {
                shown.push('/');
            }
            shown.push_str(&o);
            return Some(shown);
        }
        if !found_exact {
            break;
        }
        cur.push(c);
    }
    None
}

fn conflicts_for(root: &Path, ops: &[Op]) -> Result<Vec<ConflictInfo>, HostErr> {
    let mut out = Vec::new();
    for op in ops {
        let c = |reason: &str| ConflictInfo {
            path: op.path.clone(),
            reason: reason.to_owned(),
        };
        if !path_is_syncable(&op.path) {
            out.push(c("protected path"));
            continue;
        }
        let st = host_state(root, &op.path)?;
        match (&op.kind, &st) {
            (_, HState::Other(why)) => out.push(c(&format!("changed on your Mac: {why}"))),
            (ChangeKind::Modify, HState::Absent) => out.push(c("deleted or renamed on your Mac")),
            (ChangeKind::Modify, HState::File(f)) | (ChangeKind::Delete, HState::File(f)) => {
                let old = op.old.as_ref().expect("old");
                if f.sha256 != old.sha256 || f.size != old.size {
                    out.push(c("edited on your Mac"))
                } else if f.exec != old.exec {
                    out.push(c("permissions changed on your Mac"))
                }
            }
            (ChangeKind::Delete, HState::Absent) => {} // already gone
            (ChangeKind::Add, HState::File(f)) => {
                let n = op.new.as_ref().expect("new");
                if f.sha256 != n.sha256 || f.exec != n.exec {
                    out.push(c("a different file with this name appeared on your Mac"))
                }
            }
            (ChangeKind::Add, HState::Absent) => {
                if let Some(other) = name_collision(root, &op.path) {
                    out.push(c(&format!("the name matches \"{other}\" on your Mac")));
                }
            }
        }
    }
    Ok(out)
}

fn backup_path(ctx: &Ctx, j: &Journal, rel: &str) -> PathBuf {
    ctx.store
        .run_dir(&j.project_id, &j.run_id)
        .join("backup")
        .join(rel)
}

fn save_j(ctx: &Ctx, j: &Journal) -> Result<(), HostErr> {
    ctx.store.save_journal(j)?;
    Ok(())
}

fn prepare_and_apply(ctx: &Ctx, p: &Project, j: &mut Journal) -> Result<Outcome, HostErr> {
    let root = PathBuf::from(&p.root);
    let (pid, run) = (j.project_id.clone(), j.run_id.clone());
    let conflicts = conflicts_for(&root, &j.ops)?;
    if !conflicts.is_empty() {
        return conflict_out(ctx, j, conflicts);
    }
    // backups of everything that will be replaced or removed
    for op in &j.ops {
        if matches!(op.kind, ChangeKind::Modify | ChangeKind::Delete) {
            if let HState::File(f) = host_state(&root, &op.path)? {
                let dest = backup_path(ctx, j, &op.path);
                if let Some(par) = dest.parent() {
                    std::fs::create_dir_all(par).map_err(io)?;
                }
                std::fs::copy(root.join(&op.path), &dest).map_err(io)?;
                let (_, h) = manifest::hash_file(&dest).map_err(io)?;
                if h != f.sha256 {
                    return conflict_out(
                        ctx,
                        j,
                        vec![ConflictInfo {
                            path: op.path.clone(),
                            reason: "edited on your Mac while it was being backed up".into(),
                        }],
                    );
                }
            }
        }
    }
    j.state = JState::Prepared;
    save_j(ctx, j)?;
    set_run(ctx, &pid, &run, |r| r.sync = SyncState::Prepared)?;
    apply_ops(ctx, p, j)
}

fn conflict_out(
    ctx: &Ctx,
    j: &mut Journal,
    conflicts: Vec<ConflictInfo>,
) -> Result<Outcome, HostErr> {
    j.state = JState::Conflict;
    j.conflicts = conflicts.clone();
    j.message = Some("your Mac folder changed too; nothing was overwritten".into());
    save_j(ctx, j)?;
    let saved = ctx.store.run_dir(&j.project_id, &j.run_id).join("incoming");
    set_run(ctx, &j.project_id, &j.run_id, |r| {
        r.sync = SyncState::Conflict;
        r.conflicts = conflicts.clone();
        r.message = j.message.clone();
        r.saved_result = Some(saved.display().to_string());
    })?;
    Ok(Outcome::Conflict(conflicts))
}

fn tmp_name(j: &Journal, i: usize) -> String {
    format!(
        ".nexus-sync-{}-{}.tmp",
        j.run_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect::<String>(),
        i
    )
}

fn apply_ops(ctx: &Ctx, p: &Project, j: &mut Journal) -> Result<Outcome, HostErr> {
    let root = PathBuf::from(&p.root);
    j.state = JState::Applying;
    save_j(ctx, j)?;
    set_run(ctx, &j.project_id, &j.run_id, |r| {
        r.sync = SyncState::Applying
    })?;
    for i in 0..j.ops.len() {
        if j.ops[i].status == OpStatus::Done {
            continue;
        }
        match &ctx.fault {
            Fault::CrashBeforeOp(n) if *n == i => {
                return Err(HostErr::new("crash", "simulated crash"))
            }
            Fault::HostEditBeforeOp(n, path, data) if *n == i => {
                std::fs::write(root.join(path), data).map_err(io)?;
            }
            _ => {}
        }
        let r = apply_one(ctx, &root, j, i);
        match r {
            Ok(()) => {
                j.ops[i].status = OpStatus::Done;
                save_j(ctx, j)?;
            }
            Err(ApplyErr::Conflict(c)) => {
                rollback(ctx, &root, j)?;
                return conflict_out(ctx, j, vec![c]);
            }
            Err(ApplyErr::Io(m)) => {
                rollback(ctx, &root, j)?;
                j.state = JState::Failed;
                j.message = Some(format!(
                    "could not write to your Mac folder ({m}); everything was put back"
                ));
                save_j(ctx, j)?;
                set_run(ctx, &j.project_id, &j.run_id, |r| {
                    r.sync = SyncState::Failed;
                    r.message = j.message.clone();
                    r.saved_result = Some(
                        ctx.store
                            .run_dir(&j.project_id, &j.run_id)
                            .join("incoming")
                            .display()
                            .to_string(),
                    );
                })?;
                return Ok(Outcome::Failed(j.message.clone().unwrap_or_default()));
            }
        }
    }
    j.state = JState::Applied;
    save_j(ctx, j)?;
    finish_applied(ctx, j)?;
    Ok(Outcome::Applied {
        changed: j.ops.len(),
    })
}

enum ApplyErr {
    Conflict(ConflictInfo),
    Io(String),
}

fn apply_one(ctx: &Ctx, root: &Path, j: &Journal, i: usize) -> Result<(), ApplyErr> {
    let op = &j.ops[i];
    let conflict = |reason: &str| {
        ApplyErr::Conflict(ConflictInfo {
            path: op.path.clone(),
            reason: reason.to_owned(),
        })
    };
    if let Fault::IoErrorAtOp(n) = ctx.fault {
        if n == i {
            return Err(ApplyErr::Io("No space left on device".into()));
        }
    }
    // the file must still be exactly what the baseline says (or already be the result)
    let st = host_state(root, &op.path).map_err(|e| ApplyErr::Io(e.message))?;
    let target = root.join(&op.path);
    let ioe = |e: std::io::Error| ApplyErr::Io(e.to_string());
    match op.kind {
        ChangeKind::Delete => match st {
            HState::Absent => Ok(()),
            HState::File(f) if Some(&f) == op.old.as_ref() => {
                std::fs::remove_file(&target).map_err(ioe)?;
                prune_empty(root, &target);
                Ok(())
            }
            _ => Err(conflict("changed on your Mac while Nexus was writing")),
        },
        ChangeKind::Modify | ChangeKind::Add => {
            let new = op.new.as_ref().expect("new");
            match (&st, op.kind) {
                (HState::File(f), _) if f == new => return Ok(()), // already the result (resumed)
                (HState::File(f), ChangeKind::Modify) if Some(f) == op.old.as_ref() => {}
                (HState::Absent, ChangeKind::Add) => {}
                _ => return Err(conflict("changed on your Mac while Nexus was writing")),
            }
            let src = ctx
                .store
                .run_dir(&j.project_id, &j.run_id)
                .join("incoming")
                .join(&op.path);
            if let Some(par) = target.parent() {
                std::fs::create_dir_all(par).map_err(ioe)?;
            }
            let tmp = target.with_file_name(tmp_name(j, i));
            {
                let mut data = std::fs::File::open(&src).map_err(ioe)?;
                let mut out = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(if new.exec { 0o755 } else { 0o644 })
                    .open(&tmp)
                    .map_err(ioe)?;
                std::io::copy(&mut data, &mut out).map_err(ioe)?;
                out.sync_all().map_err(ioe)?;
            }
            std::fs::set_permissions(
                &tmp,
                std::fs::Permissions::from_mode(if new.exec { 0o755 } else { 0o644 }),
            )
            .map_err(ioe)?;
            // last look before publishing
            let again = host_state(root, &op.path).map_err(|e| ApplyErr::Io(e.message))?;
            let ok = match op.kind {
                ChangeKind::Modify => {
                    matches!(&again, HState::File(f) if Some(f) == op.old.as_ref())
                }
                _ => again == HState::Absent,
            };
            if !ok {
                let _ = std::fs::remove_file(&tmp);
                return Err(conflict("changed on your Mac while Nexus was writing"));
            }
            match op.kind {
                ChangeKind::Modify => std::fs::rename(&tmp, &target).map_err(ioe)?,
                _ => {
                    // exclusive create: fails instead of overwriting anything that just appeared
                    let l = std::fs::hard_link(&tmp, &target);
                    let _ = std::fs::remove_file(&tmp);
                    l.map_err(|e| {
                        if e.kind() == std::io::ErrorKind::AlreadyExists {
                            conflict("a file with this name appeared on your Mac")
                        } else {
                            ApplyErr::Io(e.to_string())
                        }
                    })?;
                }
            }
            if let Some(par) = target.parent() {
                let _ = sync_dir(par);
            }
            Ok(())
        }
    }
}

fn prune_empty(root: &Path, file: &Path) {
    let mut cur = file.parent();
    while let Some(d) = cur {
        if d == root || !d.starts_with(root) || std::fs::remove_dir(d).is_err() {
            break;
        }
        cur = d.parent();
    }
}

/// Put back every op that was applied, in reverse order, only where the file is still what Nexus wrote.
fn rollback(ctx: &Ctx, root: &Path, j: &mut Journal) -> Result<(), HostErr> {
    j.state = JState::RollingBack;
    save_j(ctx, j)?;
    for i in (0..j.ops.len()).rev() {
        if j.ops[i].status != OpStatus::Done {
            continue;
        }
        let op = j.ops[i].clone();
        let target = root.join(&op.path);
        let now = host_state(root, &op.path)?;
        let restore = |ctx: &Ctx| -> Result<(), HostErr> {
            let b = backup_path(ctx, j, &op.path);
            let tmp = target.with_file_name(tmp_name(j, 10_000 + i));
            if let Some(par) = target.parent() {
                std::fs::create_dir_all(par).map_err(io)?;
            }
            std::fs::copy(&b, &tmp).map_err(io)?;
            let exec = op.old.as_ref().map(|o| o.exec).unwrap_or(false);
            std::fs::set_permissions(
                &tmp,
                std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }),
            )
            .map_err(io)?;
            std::fs::rename(&tmp, &target).map_err(io)
        };
        match op.kind {
            ChangeKind::Add => {
                if matches!(&now, HState::File(f) if Some(f) == op.new.as_ref()) {
                    std::fs::remove_file(&target).map_err(io)?;
                    prune_empty(root, &target);
                }
            }
            ChangeKind::Modify => {
                if matches!(&now, HState::File(f) if Some(f) == op.new.as_ref()) {
                    restore(ctx)?;
                }
            }
            ChangeKind::Delete => {
                if now == HState::Absent {
                    restore(ctx)?;
                }
            }
        }
        j.ops[i].status = OpStatus::RolledBack;
        save_j(ctx, j)?;
    }
    Ok(())
}

/// After every op is on disk: record the new baseline, mark the run applied, tell the engine.
fn finish_applied(ctx: &Ctx, j: &Journal) -> Result<(), HostErr> {
    let mut j = j.clone();
    let pid = j.project_id.clone();
    if !j.baseline_saved {
        let mut b = ctx.store.baseline(&pid);
        for op in &j.ops {
            match &op.new {
                Some(n) => {
                    b.insert(op.path.clone(), n.clone());
                }
                None => {
                    b.remove(&op.path);
                }
            }
        }
        ctx.store.save_baseline(&pid, &b)?;
        let (gen, run) = (j.new_generation, j.run_id.clone());
        let changed: Vec<ChangedFile> = j
            .ops
            .iter()
            .map(|o| ChangedFile {
                path: o.path.clone(),
                kind: o.kind,
            })
            .collect();
        ctx.store.update(&pid, |p| {
            p.generation = gen;
            p.last_sync_ms = Some(now_ms());
            if let Some(r) = p.runs.iter_mut().find(|r| r.run_id == run) {
                r.sync = SyncState::Applied;
                r.applied_ms = Some(now_ms());
                r.changed = changed;
                r.conflicts.clear();
                r.message = None;
            }
        })?;
        j.baseline_saved = true;
        save_j(ctx, &j)?;
    }
    if !j.acked {
        // idempotent on the engine side; if the engine is unreachable this is retried on the next call
        if ctx
            .guest
            .call(SyncReq::ExportAck {
                project_id: pid.clone(),
                plan_digest: j.plan_digest.clone(),
                generation: j.new_generation,
            })
            .is_ok()
        {
            j.acked = true;
            save_j(ctx, &j)?;
        }
    }
    // temporary files left by an interrupted attempt
    Ok(())
}

/// Reconcile a journal against the observed Mac folder. Never assumes an interrupted write
/// succeeded or failed: every op is classified by what is actually on disk.
pub fn resume_journal(ctx: &Ctx, mut j: Journal) -> Result<Outcome, HostErr> {
    let p = ctx
        .store
        .get(&j.project_id)
        .ok_or_else(|| HostErr::new("unknown-project", "unknown project"))?;
    let root = PathBuf::from(&p.root);
    match j.state {
        JState::Applied => {
            finish_applied(ctx, &j)?;
            Ok(Outcome::Applied {
                changed: j.ops.len(),
            })
        }
        JState::Conflict => Ok(Outcome::Conflict(j.conflicts.clone())),
        JState::Failed => Ok(Outcome::Failed(j.message.clone().unwrap_or_default())),
        JState::RollingBack => {
            rollback(ctx, &root, &mut j)?;
            j.state = JState::Failed;
            j.message = Some("an interrupted writeback was rolled back".into());
            save_j(ctx, &j)?;
            set_run(ctx, &j.project_id, &j.run_id, |r| {
                r.sync = SyncState::Failed;
                r.message = j.message.clone()
            })?;
            Ok(Outcome::Failed(j.message.clone().unwrap_or_default()))
        }
        JState::Prepared | JState::Applying => {
            cleanup_tmp(&root, &j);
            // classify every op by observation
            let mut all_post = true;
            for op in j.ops.clone().iter() {
                let st = host_state(&root, &op.path)?;
                let post = match op.kind {
                    ChangeKind::Delete => st == HState::Absent,
                    _ => matches!(&st, HState::File(f) if Some(f) == op.new.as_ref()),
                };
                let pre = match op.kind {
                    ChangeKind::Add => st == HState::Absent,
                    _ => matches!(&st, HState::File(f) if Some(f) == op.old.as_ref()),
                };
                if !post {
                    all_post = false;
                }
                if !post && !pre {
                    // neither untouched nor finished: someone else changed it. Keep both versions.
                    for o in j.ops.iter_mut() {
                        let s = host_state(&root, &o.path)?;
                        let done = match o.kind {
                            ChangeKind::Delete => s == HState::Absent,
                            _ => matches!(&s, HState::File(f) if Some(f) == o.new.as_ref()),
                        };
                        o.status = if done { OpStatus::Done } else { OpStatus::Todo };
                    }
                    rollback(ctx, &root, &mut j)?;
                    return conflict_out(
                        ctx,
                        &mut j,
                        vec![ConflictInfo {
                            path: op.path.clone(),
                            reason: "changed on your Mac while Nexus was writing".into(),
                        }],
                    );
                }
            }
            for op in j.ops.iter_mut() {
                let st = host_state(&root, &op.path)?;
                let done = match op.kind {
                    ChangeKind::Delete => st == HState::Absent,
                    _ => matches!(&st, HState::File(f) if Some(f) == op.new.as_ref()),
                };
                op.status = if done { OpStatus::Done } else { OpStatus::Todo };
            }
            if all_post {
                j.state = JState::Applied;
                save_j(ctx, &j)?;
                finish_applied(ctx, &j)?;
                return Ok(Outcome::Applied {
                    changed: j.ops.len(),
                });
            }
            apply_ops(ctx, &p, &mut j)
        }
    }
}

fn cleanup_tmp(root: &Path, j: &Journal) {
    for (i, op) in j.ops.iter().enumerate() {
        let target = root.join(&op.path);
        for k in [i, 10_000 + i] {
            let _ = std::fs::remove_file(target.with_file_name(tmp_name(j, k)));
        }
    }
}

/// Re-examine a result that could not be applied (the person may have resolved the difference).
/// Applies it only if no conflict remains; otherwise it stays preserved.
pub fn retry_conflict(ctx: &Ctx, pid: &str, run_id: &str) -> Result<Outcome, HostErr> {
    let p = ctx
        .store
        .get(pid)
        .ok_or_else(|| HostErr::new("unknown-project", "unknown project"))?;
    let mut j = ctx
        .store
        .journal(pid, run_id)
        .ok_or_else(|| HostErr::new("no-journal", "nothing to retry"))?;
    if !matches!(j.state, JState::Conflict | JState::Failed) {
        return resume_journal(ctx, j);
    }
    for op in j.ops.iter_mut() {
        op.status = OpStatus::Todo;
    }
    // the preserved download must still be intact
    let inc = ctx.store.run_dir(pid, run_id).join("incoming");
    for op in &j.ops {
        if let Some(n) = &op.new {
            match manifest::hash_file(&inc.join(&op.path)) {
                Ok((sz, h)) if sz == n.size && h == n.sha256 => {}
                _ => {
                    return Err(HostErr::new(
                        "result-lost",
                        "the saved result is no longer intact",
                    ))
                }
            }
        }
    }
    if let Some(cur) = ctx.store.baseline(pid).into_iter().next() {
        let _ = cur;
    }
    prepare_and_apply(ctx, &p, &mut j)
}

/// Startup/reconnect recovery for one project: finish or roll back interrupted writebacks.
pub fn recover_project(ctx: &Ctx, pid: &str) -> Vec<(String, Result<Outcome, HostErr>)> {
    let Some(p) = ctx.store.get(pid) else {
        return vec![];
    };
    let mut out = Vec::new();
    for r in &p.runs {
        if let Some(j) = ctx.store.journal(pid, &r.run_id) {
            let needs = matches!(
                j.state,
                JState::Prepared | JState::Applying | JState::RollingBack
            ) || (j.state == JState::Applied && (!j.baseline_saved || !j.acked));
            if needs {
                out.push((r.run_id.clone(), resume_journal(ctx, j)));
            }
        }
    }
    out
}

pub fn summary(o: &Outcome) -> Value {
    match o {
        Outcome::Applied { changed } => json!({"outcome": "applied", "changed": changed}),
        Outcome::NotApplied(r) => json!({"outcome": "not-applied", "reason": r}),
        Outcome::Conflict(c) => json!({"outcome": "conflict", "conflicts": c}),
        Outcome::Failed(m) => json!({"outcome": "failed", "message": m}),
    }
}

#[allow(dead_code)]
fn unused(_: &dyn Fn()) {
    let _ = write_atomic;
}
