//! Guest-side staging root: the only place the engine bridge reads or writes project content.
//!
//! Layout under the Nexus-owned root (`~/NexusMac`), one directory per authorized project id:
//! ```text
//! <pid>/work/<label>/      the Nexus working copy (this is what the engine registers and edits)
//! <pid>/meta/baseline.json last accepted state: generation + file hashes (the trusted baseline)
//! <pid>/meta/stage.json    the transfer in progress (resumable)
//! <pid>/meta/publish.json  an interrupted publication, finished on the next call
//! <pid>/meta/export.json   the export plan the host may read from
//! <pid>/incoming/          verified files of the transfer in progress
//! ```
//! Metadata lives OUTSIDE the working copy so it can never be mistaken for project content.
//! Every path that reaches the filesystem is derived from a validated project id and a validated
//! relative path; nothing the host sends is ever used as an absolute path.

use super::manifest::{self, Change, ChangeKind, FileEntry, Files};
use super::policy::*;
use super::wire::*;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

type R<T> = Result<T, SyncErr>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Baseline {
    generation: u64,
    label: String,
    files: Files,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stage {
    generation: u64,
    label: String,
    base_digest: Option<String>,
    target_digest: String,
    change_count: u64,
    changes: Vec<Change>,
    files_done: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Publish {
    generation: u64,
    label: String,
    target_digest: String,
    changes: Vec<Change>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Export {
    plan_digest: String,
    changes: Vec<Change>,
}

pub struct GuestStore {
    root: PathBuf,
}

fn io(e: impl std::fmt::Display) -> SyncErr {
    SyncErr::new("io", e.to_string())
}

fn bad(m: &str) -> SyncErr {
    SyncErr::new("bad-request", m)
}

/// A project id: short, lower-case alphanumerics and dashes. Never a path.
pub fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A folder label: one path component, printable, no separators.
pub fn valid_label(l: &str) -> bool {
    !l.is_empty()
        && l.len() <= 64
        && l != "."
        && l != ".."
        && !l.starts_with('.')
        && !l.contains(['/', '\\', '\0'])
        && !l.chars().any(|c| c.is_control())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().expect("has parent");
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("x")
    ));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    sync_dir(dir)
}

pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

fn read_json<T: for<'a> Deserialize<'a>>(p: &Path) -> R<Option<T>> {
    match std::fs::read(p) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| SyncErr::new("corrupt", format!("{}: {e}", p.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(e)),
    }
}

fn write_json<T: Serialize>(p: &Path, v: &T) -> R<()> {
    write_atomic(p, &serde_json::to_vec(v).map_err(io)?).map_err(io)
}

impl GuestStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn pdir(&self, pid: &str) -> R<PathBuf> {
        if !valid_project_id(pid) {
            return Err(bad("project id"));
        }
        Ok(self.root.join(pid))
    }
    fn meta(&self, pid: &str) -> R<PathBuf> {
        Ok(self.pdir(pid)?.join("meta"))
    }
    fn incoming(&self, pid: &str) -> R<PathBuf> {
        Ok(self.pdir(pid)?.join("incoming"))
    }
    fn work(&self, pid: &str, label: &str) -> R<PathBuf> {
        if !valid_label(label) {
            return Err(bad("project label"));
        }
        Ok(self.pdir(pid)?.join("work").join(label))
    }

    fn baseline(&self, pid: &str) -> R<Option<Baseline>> {
        read_json(&self.meta(pid)?.join("baseline.json"))
    }

    /// Path of the working copy, once the project has a baseline.
    pub fn work_path(&self, pid: &str) -> R<Option<PathBuf>> {
        match self.baseline(pid)? {
            Some(b) => Ok(Some(self.work(pid, &b.label)?)),
            None => Ok(None),
        }
    }

    pub fn handle(&self, req: SyncReq) -> R<Value> {
        match req {
            SyncReq::StageBegin {
                project_id,
                label,
                generation,
                base_digest,
                target_digest,
                change_count,
            } => self
                .stage_begin(
                    &project_id,
                    &label,
                    generation,
                    base_digest,
                    target_digest,
                    change_count,
                )
                .map(|v| json!(v)),
            SyncReq::StageChanges {
                project_id,
                generation,
                start,
                changes,
            } => self.stage_changes(&project_id, generation, start, changes),
            SyncReq::StageChunk {
                project_id,
                generation,
                path,
                offset,
                data,
            } => self.stage_chunk(&project_id, generation, &path, offset, &data),
            SyncReq::StageStatus { project_id } => self.stage_status(&project_id).map(|v| json!(v)),
            SyncReq::StageCommit {
                project_id,
                generation,
                target_digest,
            } => self
                .stage_commit(&project_id, generation, &target_digest)
                .map(|v| json!(v)),
            SyncReq::StageAbort { project_id } => self.stage_abort(&project_id),
            SyncReq::ExportPlan { project_id } => self.export_plan(&project_id).map(|v| json!(v)),
            SyncReq::ExportRead {
                project_id,
                plan_digest,
                path,
                offset,
                len,
            } => self
                .export_read(&project_id, &plan_digest, &path, offset, len)
                .map(|v| json!(v)),
            SyncReq::ExportAck {
                project_id,
                plan_digest,
                generation,
            } => self.export_ack(&project_id, &plan_digest, generation),
            SyncReq::Discard { project_id } => self.discard(&project_id),
        }
    }

    // ---- staging -------------------------------------------------------------------------

    pub fn stage_status(&self, pid: &str) -> R<StageStatus> {
        self.finish_interrupted_publish(pid)?;
        let b = self.baseline(pid)?;
        let st: Option<Stage> = read_json(&self.meta(pid)?.join("stage.json"))?;
        let in_progress = match st {
            Some(s) => {
                let partial = self.partial_of(pid, &s)?;
                Some(InProgress {
                    generation: s.generation,
                    target_digest: s.target_digest.clone(),
                    change_count: s.change_count,
                    changes_received: s.changes.len() as u64,
                    files_done: s.files_done.clone(),
                    partial,
                })
            }
            None => None,
        };
        Ok(StageStatus {
            baseline_generation: b.as_ref().map(|b| b.generation),
            baseline_digest: b.as_ref().map(|b| manifest::digest(&b.files)),
            in_progress,
            work_path: match &b {
                Some(b) => Some(self.work(pid, &b.label)?.display().to_string()),
                None => None,
            },
        })
    }

    fn part_path(&self, pid: &str, rel: &str) -> R<PathBuf> {
        let name = hex::encode(sha2_of(rel.as_bytes()));
        Ok(self
            .incoming(pid)?
            .join("parts")
            .join(format!("{name}.part")))
    }
    fn file_path(&self, pid: &str, rel: &str) -> R<PathBuf> {
        validate_rel(rel).map_err(bad)?;
        Ok(self.incoming(pid)?.join("files").join(rel))
    }

    fn partial_of(&self, pid: &str, s: &Stage) -> R<Option<(String, u64)>> {
        for c in &s.changes {
            if c.new.is_some() && !s.files_done.contains(&c.path) {
                if let Ok(m) = std::fs::metadata(self.part_path(pid, &c.path)?) {
                    return Ok(Some((c.path.clone(), m.len())));
                }
            }
        }
        Ok(None)
    }

    fn work_matches_baseline(&self, pid: &str, b: &Baseline) -> R<bool> {
        let w = self.work(pid, &b.label)?;
        let scan = manifest::scan(&w).map_err(|e| SyncErr::new("scan", e.to_string()))?;
        Ok(scan.files == b.files)
    }

    pub fn stage_begin(
        &self,
        pid: &str,
        label: &str,
        generation: u64,
        base_digest: Option<String>,
        target_digest: String,
        change_count: u64,
    ) -> R<StageStatus> {
        self.finish_interrupted_publish(pid)?;
        let _ = self.work(pid, label)?;
        if change_count > MAX_FILES as u64 * 2 {
            return Err(SyncErr::new("limits", "too many changes"));
        }
        let meta = self.meta(pid)?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&meta)
            .map_err(io)?;
        let baseline = self.baseline(pid)?;
        match (&baseline, &base_digest) {
            (None, None) => {}
            (Some(b), Some(d)) if manifest::digest(&b.files) == *d => {
                if b.label != label {
                    return Err(SyncErr::new(
                        "baseline-mismatch",
                        "the project folder name changed",
                    ));
                }
            }
            _ => {
                return Err(SyncErr::new(
                    "baseline-mismatch",
                    "the engine's copy is not the baseline the Mac expects",
                ))
            }
        }
        if let Some(b) = &baseline {
            if generation <= b.generation {
                return Err(SyncErr::new(
                    "stale-generation",
                    "that generation is already accepted",
                ));
            }
            // never stage over work the engine holds that was not exported
            if !self.work_matches_baseline(pid, b)? {
                return Err(SyncErr::new(
                    "guest-has-unexported-changes",
                    "the engine's working copy has changes that were not applied to the Mac yet",
                ));
            }
        }
        let sp = meta.join("stage.json");
        if let Some(s) = read_json::<Stage>(&sp)? {
            if s.generation == generation
                && s.target_digest == target_digest
                && s.base_digest == base_digest
            {
                return self.stage_status(pid); // resume
            }
        }
        // a different (or no) transfer: start clean. The accepted baseline and the working copy are untouched.
        let inc = self.incoming(pid)?;
        let _ = std::fs::remove_dir_all(&inc);
        for d in ["files", "parts"] {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(inc.join(d))
                .map_err(io)?;
        }
        write_json(
            &sp,
            &Stage {
                generation,
                label: label.to_owned(),
                base_digest,
                target_digest,
                change_count,
                changes: vec![],
                files_done: vec![],
            },
        )?;
        self.stage_status(pid)
    }

    fn load_stage(&self, pid: &str, generation: u64) -> R<Stage> {
        let s: Stage = read_json(&self.meta(pid)?.join("stage.json"))?
            .ok_or_else(|| SyncErr::new("no-transfer", "no transfer is in progress"))?;
        if s.generation != generation {
            return Err(SyncErr::new(
                "no-transfer",
                "that generation is not the transfer in progress",
            ));
        }
        Ok(s)
    }

    fn stage_changes(
        &self,
        pid: &str,
        generation: u64,
        start: u64,
        changes: Vec<Change>,
    ) -> R<Value> {
        let mut s = self.load_stage(pid, generation)?;
        let base = self.baseline(pid)?;
        if changes.len() > 5000 {
            return Err(bad("page too large"));
        }
        if start > s.changes.len() as u64 {
            return Err(SyncErr::new(
                "out-of-order",
                format!("expected change {}", s.changes.len()),
            ));
        }
        for (i, c) in changes.into_iter().enumerate() {
            let idx = start as usize + i;
            if idx < s.changes.len() {
                if s.changes[idx] != c {
                    return Err(SyncErr::new("out-of-order", "a resent change differs"));
                }
                continue;
            }
            if s.changes.len() as u64 >= s.change_count {
                return Err(bad("more changes than announced"));
            }
            self.check_change(&c, base.as_ref())?;
            s.changes.push(c);
        }
        write_json(&self.meta(pid)?.join("stage.json"), &s)?;
        Ok(json!({"received": s.changes.len()}))
    }

    fn check_change(&self, c: &Change, base: Option<&Baseline>) -> R<()> {
        if !path_is_syncable(&c.path) {
            return Err(SyncErr::new(
                "unsafe-path",
                format!("not a synchronizable path: {}", c.path),
            ));
        }
        let have = base.and_then(|b| b.files.get(&c.path));
        match c.kind {
            ChangeKind::Add => {
                if c.old.is_some() || c.new.is_none() || have.is_some() {
                    return Err(bad("add"));
                }
            }
            ChangeKind::Modify => {
                if c.new.is_none() || have != c.old.as_ref() || have.is_none() {
                    return Err(bad("modify"));
                }
            }
            ChangeKind::Delete => {
                if c.new.is_some() || have != c.old.as_ref() || have.is_none() {
                    return Err(bad("delete"));
                }
            }
        }
        if let Some(n) = &c.new {
            if n.size > MAX_FILE_BYTES {
                return Err(SyncErr::new(
                    "limits",
                    format!(
                        "{} is larger than {} MiB",
                        c.path,
                        MAX_FILE_BYTES / 1024 / 1024
                    ),
                ));
            }
            if n.sha256.len() != 64 || !n.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(bad("hash"));
            }
        }
        Ok(())
    }

    fn stage_chunk(
        &self,
        pid: &str,
        generation: u64,
        path: &str,
        offset: u64,
        data: &str,
    ) -> R<Value> {
        let mut s = self.load_stage(pid, generation)?;
        let entry = s
            .changes
            .iter()
            .find(|c| c.path == path)
            .and_then(|c| c.new.clone())
            .ok_or_else(|| {
                SyncErr::new("not-announced", "that file is not part of this transfer")
            })?;
        if s.files_done.iter().any(|p| p == path) {
            return Ok(json!({"done": true, "size": entry.size}));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| bad("chunk encoding"))?;
        if bytes.len() > CHUNK_BYTES {
            return Err(bad("chunk too large"));
        }
        let part = self.part_path(pid, path)?;
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if offset != have {
            return Err(SyncErr::new("offset-mismatch", have.to_string()));
        }
        if have + bytes.len() as u64 > entry.size {
            return Err(SyncErr::new("limits", "more data than announced"));
        }
        {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(&part)
                .map_err(io)?;
            f.write_all(&bytes).map_err(io)?;
            if have + bytes.len() as u64 == entry.size {
                f.sync_all().map_err(io)?;
            }
        }
        let size_now = have + bytes.len() as u64;
        if size_now == entry.size {
            let (n, h) = manifest::hash_file(&part).map_err(io)?;
            if n != entry.size || h != entry.sha256 {
                let _ = std::fs::remove_file(&part);
                return Err(SyncErr::new(
                    "hash-mismatch",
                    format!("{path} did not arrive intact"),
                ));
            }
            let dest = self.file_path(pid, path)?;
            if let Some(p) = dest.parent() {
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(p)
                    .map_err(io)?;
            }
            std::fs::rename(&part, &dest).map_err(io)?;
            s.files_done.push(path.to_owned());
            write_json(&self.meta(pid)?.join("stage.json"), &s)?;
            return Ok(json!({"done": true, "size": size_now}));
        }
        Ok(json!({"done": false, "size": size_now}))
    }

    pub fn stage_abort(&self, pid: &str) -> R<Value> {
        let _ = std::fs::remove_file(self.meta(pid)?.join("stage.json"));
        let _ = std::fs::remove_dir_all(self.incoming(pid)?);
        Ok(json!({"aborted": true}))
    }

    pub fn stage_commit(&self, pid: &str, generation: u64, target_digest: &str) -> R<CommitReply> {
        self.finish_interrupted_publish(pid)?;
        // idempotent: an already accepted generation is simply reported
        if let Some(b) = self.baseline(pid)? {
            if b.generation == generation && manifest::digest(&b.files) == target_digest {
                return Ok(CommitReply {
                    work_path: self.work(pid, &b.label)?.display().to_string(),
                    generation,
                    created: false,
                });
            }
        }
        let s = self.load_stage(pid, generation)?;
        if s.target_digest != target_digest {
            return Err(SyncErr::new(
                "digest-mismatch",
                "the transfer is for a different target",
            ));
        }
        if s.changes.len() as u64 != s.change_count {
            return Err(SyncErr::new("incomplete", "the change list is incomplete"));
        }
        let base = self.baseline(pid)?;
        let mut target: Files = base.as_ref().map(|b| b.files.clone()).unwrap_or_default();
        for c in &s.changes {
            match (&c.kind, &c.new) {
                (ChangeKind::Delete, _) => {
                    target.remove(&c.path);
                }
                (_, Some(n)) => {
                    target.insert(c.path.clone(), n.clone());
                }
                _ => return Err(bad("change")),
            }
        }
        if manifest::digest(&target) != s.target_digest {
            return Err(SyncErr::new(
                "digest-mismatch",
                "the staged changes do not produce the announced project",
            ));
        }
        let total: u64 = target.values().map(|e| e.size).sum();
        if target.len() > MAX_FILES || total > MAX_TOTAL_BYTES {
            return Err(SyncErr::new(
                "limits",
                "the project exceeds the synchronization limits",
            ));
        }
        for c in &s.changes {
            if let Some(n) = &c.new {
                if !s.files_done.contains(&c.path) {
                    return Err(SyncErr::new(
                        "incomplete",
                        format!("{} has not arrived", c.path),
                    ));
                }
                // re-verify what is about to be published
                let (sz, h) = manifest::hash_file(&self.file_path(pid, &c.path)?).map_err(io)?;
                if sz != n.size || h != n.sha256 {
                    return Err(SyncErr::new(
                        "hash-mismatch",
                        format!("{} changed while staged", c.path),
                    ));
                }
            }
        }
        if let Some(b) = &base {
            if !self.work_matches_baseline(pid, b)? {
                return Err(SyncErr::new(
                    "guest-has-unexported-changes",
                    "the engine's working copy changed while staging",
                ));
            }
        }
        let created = base.is_none();
        let publish = Publish {
            generation,
            label: s.label.clone(),
            target_digest: s.target_digest.clone(),
            changes: s.changes.clone(),
        };
        write_json(&self.meta(pid)?.join("publish.json"), &publish)?;
        self.run_publish(pid, &publish)?;
        Ok(CommitReply {
            work_path: self.work(pid, &s.label)?.display().to_string(),
            generation,
            created,
        })
    }

    /// Finish a publication that was cut short (crash, lost connection). Idempotent.
    fn finish_interrupted_publish(&self, pid: &str) -> R<()> {
        if let Some(p) = read_json::<Publish>(&self.meta(pid)?.join("publish.json"))? {
            self.run_publish(pid, &p)?;
        }
        Ok(())
    }

    fn run_publish(&self, pid: &str, p: &Publish) -> R<()> {
        let work = self.work(pid, &p.label)?;
        let inc_files = self.incoming(pid)?.join("files");
        let base = self.baseline(pid)?;
        let mut target: Files = base.as_ref().map(|b| b.files.clone()).unwrap_or_default();
        for c in &p.changes {
            match &c.new {
                Some(n) => {
                    target.insert(c.path.clone(), n.clone());
                }
                None => {
                    target.remove(&c.path);
                }
            }
        }
        if base.is_none() {
            // first publication: build the tree beside the final name, then one atomic rename
            let building = work.with_file_name(format!("{}.building", p.label));
            if !work.exists() {
                let _ = std::fs::remove_dir_all(&building);
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(&building)
                    .map_err(io)?;
                for c in &p.changes {
                    if let Some(n) = &c.new {
                        let to = building.join(&c.path);
                        if let Some(par) = to.parent() {
                            std::fs::DirBuilder::new()
                                .recursive(true)
                                .mode(0o700)
                                .create(par)
                                .map_err(io)?;
                        }
                        // copy, not move: a publication cut short here is simply redone
                        std::fs::copy(inc_files.join(&c.path), &to).map_err(io)?;
                        set_mode(&to, n.exec)?;
                    }
                }
                std::fs::rename(&building, &work).map_err(io)?;
                if let Some(par) = work.parent() {
                    let _ = sync_dir(par);
                }
            }
        } else {
            for c in &p.changes {
                let to = work.join(&c.path);
                match &c.new {
                    Some(n) => {
                        let src = inc_files.join(&c.path);
                        if src.exists() {
                            if let Some(par) = to.parent() {
                                std::fs::DirBuilder::new()
                                    .recursive(true)
                                    .mode(0o700)
                                    .create(par)
                                    .map_err(io)?;
                            }
                            std::fs::rename(&src, &to).map_err(io)?;
                        }
                        set_mode(&to, n.exec)?;
                    }
                    None => {
                        let _ = std::fs::remove_file(&to);
                        prune_empty_dirs(&work, &to);
                    }
                }
            }
        }
        write_json(
            &self.meta(pid)?.join("baseline.json"),
            &Baseline {
                generation: p.generation,
                label: p.label.clone(),
                files: target,
            },
        )?;
        let _ = std::fs::remove_file(self.meta(pid)?.join("publish.json"));
        let _ = std::fs::remove_file(self.meta(pid)?.join("stage.json"));
        let _ = std::fs::remove_dir_all(self.incoming(pid)?);
        Ok(())
    }

    // ---- export --------------------------------------------------------------------------

    pub fn export_plan(&self, pid: &str) -> R<ExportPlan> {
        self.finish_interrupted_publish(pid)?;
        let b = self
            .baseline(pid)?
            .ok_or_else(|| SyncErr::new("no-baseline", "the project has not been staged"))?;
        let w = self.work(pid, &b.label)?;
        let scan = manifest::scan(&w).map_err(|e| SyncErr::new("scan", e.to_string()))?;
        let changes = manifest::diff(&b.files, &scan.files);
        for c in &changes {
            if !path_is_syncable(&c.path) {
                return Err(SyncErr::new(
                    "unsafe-path",
                    format!("not a synchronizable path: {}", c.path),
                ));
            }
        }
        let plan_digest = manifest::change_digest(&changes);
        write_json(
            &self.meta(pid)?.join("export.json"),
            &Export {
                plan_digest: plan_digest.clone(),
                changes: changes.clone(),
            },
        )?;
        Ok(ExportPlan {
            base_generation: b.generation,
            plan_digest,
            changes,
            workspace_digest: manifest::digest(&scan.files),
            ignored: scan.skipped.clone(),
            ignored_total: scan.skipped_total as u64,
        })
    }

    pub fn export_read(
        &self,
        pid: &str,
        plan_digest: &str,
        path: &str,
        offset: u64,
        len: u64,
    ) -> R<ReadReply> {
        let ex: Export = read_json(&self.meta(pid)?.join("export.json"))?
            .ok_or_else(|| SyncErr::new("no-plan", "no export plan"))?;
        if ex.plan_digest != plan_digest {
            return Err(SyncErr::new("no-plan", "that plan is not current"));
        }
        let entry = ex
            .changes
            .iter()
            .find(|c| c.path == path)
            .and_then(|c| c.new.clone())
            .ok_or_else(|| SyncErr::new("not-in-plan", "that file is not part of the plan"))?;
        let b = self
            .baseline(pid)?
            .ok_or_else(|| SyncErr::new("no-baseline", "the project has not been staged"))?;
        let file = self.work(pid, &b.label)?.join(path);
        // never follow a link planted after planning
        let md = std::fs::symlink_metadata(&file)
            .map_err(|_| SyncErr::new("changed-since-plan", format!("{path} is gone")))?;
        if !md.file_type().is_file() || md.len() != entry.size {
            return Err(SyncErr::new(
                "changed-since-plan",
                format!("{path} changed after the plan"),
            ));
        }
        if offset == 0 {
            let (_, h) = manifest::hash_file(&file).map_err(io)?;
            if h != entry.sha256 {
                return Err(SyncErr::new(
                    "changed-since-plan",
                    format!("{path} changed after the plan"),
                ));
            }
        }
        let len = len.min(CHUNK_BYTES as u64);
        let mut f = std::fs::File::open(&file).map_err(io)?;
        f.seek(SeekFrom::Start(offset)).map_err(io)?;
        let mut buf = vec![0u8; len as usize];
        let mut got = 0;
        while got < buf.len() {
            let n = f.read(&mut buf[got..]).map_err(io)?;
            if n == 0 {
                break;
            }
            got += n;
        }
        buf.truncate(got);
        Ok(ReadReply {
            data: base64::engine::general_purpose::STANDARD.encode(&buf),
            eof: offset + got as u64 >= entry.size,
        })
    }

    pub fn export_ack(&self, pid: &str, plan_digest: &str, generation: u64) -> R<Value> {
        let b = self
            .baseline(pid)?
            .ok_or_else(|| SyncErr::new("no-baseline", "the project has not been staged"))?;
        if b.generation >= generation {
            return Ok(json!({"acknowledged": true, "already": true})); // duplicate ack
        }
        let ex: Export = read_json(&self.meta(pid)?.join("export.json"))?
            .ok_or_else(|| SyncErr::new("no-plan", "no export plan"))?;
        if ex.plan_digest != plan_digest {
            return Err(SyncErr::new("no-plan", "that plan is not current"));
        }
        let mut files = b.files.clone();
        for c in &ex.changes {
            match &c.new {
                Some(n) => {
                    files.insert(c.path.clone(), n.clone());
                }
                None => {
                    files.remove(&c.path);
                }
            }
        }
        write_json(
            &self.meta(pid)?.join("baseline.json"),
            &Baseline {
                generation,
                label: b.label,
                files,
            },
        )?;
        let _ = std::fs::remove_file(self.meta(pid)?.join("export.json"));
        Ok(json!({"acknowledged": true, "already": false}))
    }

    pub fn discard(&self, pid: &str) -> R<Value> {
        let d = self.pdir(pid)?;
        if d.exists() {
            std::fs::remove_dir_all(&d).map_err(io)?;
        }
        Ok(json!({"discarded": true}))
    }
}

fn sha2_of(b: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).to_vec()
}

fn set_mode(p: &Path, exec: bool) -> R<()> {
    std::fs::set_permissions(
        p,
        std::fs::Permissions::from_mode(if exec { 0o700 } else { 0o600 }),
    )
    .map_err(io)
}

fn prune_empty_dirs(root: &Path, file: &Path) {
    let mut cur = file.parent();
    while let Some(d) = cur {
        if d == root || !d.starts_with(root) {
            break;
        }
        if std::fs::remove_dir(d).is_err() {
            break; // not empty (or gone)
        }
        cur = d.parent();
    }
}

#[allow(dead_code)]
fn entry(size: u64, sha256: String, exec: bool) -> FileEntry {
    FileEntry { size, sha256, exec }
}
