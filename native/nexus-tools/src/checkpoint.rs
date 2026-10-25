//! Filesystem checkpoints and pre-images (M3B).
//!
//! Before an authorized in-place command can mutate its workspace, the content it could change is preserved
//! OUTSIDE the command's writable view (`<run_root>/_checkpoints/<executionId>/`, owner-only, never mounted
//! into the sandbox). The checkpoint is driven by the M3A pre-manifest: exactly the tier-1 entries that were
//! observed are preserved, each one verified against its observed identity before and after it is stored.
//!
//! **What this is not.** It is NOT a point-in-time filesystem snapshot. Files are preserved one after another
//! (reflink clone where the filesystem supports it, bounded copy otherwise). A file that changes while it is
//! being preserved is detected (ctime/size/inode compared before and after) and reported, never stored as if
//! it were consistent; but two files can come from slightly different moments if a writer is active. The
//! index says so (`consistency`), and no consumer may claim more.
//!
//! **Coverage is explicit.** `status: complete` means every tier-1 entry was either stored or excluded *by a
//! stated design rule* (secret-shaped names are never copied; special files are not copied; dependency/build
//! directories and `.git` are tier 2 and are not captured). Anything else that was not stored (size/file budget,
//! a file too large, a change during checkpointing, an unreadable entry, storage) makes it `incomplete` with the
//! reason. Nothing is ever dropped silently.

use crate::observe::{self, EffectSet, Manifest, RootId};
use crate::workspace::{NameClass, Workspace, WorkspacePolicy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

pub const CHECKPOINT_DIR: &str = "_checkpoints";
pub const INDEX_SCHEMA: &str = "nexus.checkpoint/v1";
pub const CONSISTENCY_NOTE: &str = "Not an atomic snapshot: files are preserved one after another and each is verified unchanged against the pre-execution observation; a writer active during checkpointing is reported, not hidden.";

pub fn store_dir(run_root: &Path) -> PathBuf {
    run_root.join(CHECKPOINT_DIR)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// No checkpoint (the pre-M3B behaviour).
    Off,
    /// Owner decision D4: a command may run without a complete checkpoint; the record says so.
    BestEffort,
    /// Opt-in: a command is refused unless its checkpoint is complete.
    Required,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "best-effort" => Some(Self::BestEffort),
            "required" => Some(Self::Required),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointBudget {
    /// Logical bytes preserved by one checkpoint.
    pub max_bytes: u64,
    pub max_files: u64,
    pub max_file_bytes: u64,
    /// Logical bytes of all retained checkpoints together.
    pub store_quota_bytes: u64,
    pub retention_secs: u64,
    /// Free space that must remain on the store's filesystem after a bounded copy.
    pub min_free_bytes: u64,
}

impl Default for CheckpointBudget {
    fn default() -> Self {
        Self {
            max_bytes: 1024 * 1024 * 1024,
            max_files: 100_000,
            max_file_bytes: 256 * 1024 * 1024,
            store_quota_bytes: 4 * 1024 * 1024 * 1024,
            retention_secs: 7 * 24 * 3600,
            min_free_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointPolicy {
    pub mode: Mode,
    pub budget: CheckpointBudget,
    /// Never try a reflink (benchmarks, tests of the bounded-copy path).
    pub force_copy: bool,
}

impl Default for CheckpointPolicy {
    fn default() -> Self {
        Self {
            mode: Mode::Off,
            budget: CheckpointBudget::default(),
            force_copy: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// `f` file, `d` directory, `l` symlink, `o` other
    pub kind: String,
    pub size: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub mtime_ns: i64,
    pub nlink: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// sha256 of the stored content (files only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// File name inside `files/` (present = content stored).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    /// Why the content was not stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded: Option<String>,
    /// The file has more than one link: other names (possibly outside the workspace) share its content.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hardlinked: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reflinked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    /// Tier-2 directories (dependency/build) that are NOT captured.
    pub bulk_dirs_not_captured: Vec<String>,
    pub git_not_captured: bool,
    pub secret_shaped_excluded: u64,
    pub special_excluded: u64,
    /// Entries excluded for an unplanned reason (the checkpoint is `incomplete`).
    pub unplanned_excluded: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub schema: String,
    pub execution_id: String,
    pub created_ms: u64,
    pub workspace: RootId,
    /// `reflink` | `copy` | `mixed` | `none`
    pub method: String,
    pub consistency: String,
    /// `complete` | `incomplete`
    pub status: String,
    pub reasons: Vec<String>,
    pub entries: BTreeMap<String, Entry>,
    pub coverage: Coverage,
    pub files_stored: u64,
    pub logical_bytes: u64,
    pub reflinked_bytes: u64,
    pub copied_bytes: u64,
    pub digest: String,
}

impl Index {
    pub fn compute_digest(&self) -> String {
        let mut c = self.clone();
        c.digest = String::new();
        hex::encode(Sha256::digest(serde_json::to_vec(&c).unwrap_or_default()))
    }

    /// Bounded description for journals and records.
    pub fn brief(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.execution_id, "status": self.status, "method": self.method,
            "consistency": "non-atomic", "reasons": self.reasons,
            "files": self.files_stored, "logicalBytes": self.logical_bytes,
            "reflinkedBytes": self.reflinked_bytes, "copiedBytes": self.copied_bytes,
            "coverage": self.coverage, "indexDigest": self.digest,
        })
    }
}

/// A checkpoint that could not be made at all (nothing was persisted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub reasons: Vec<String>,
}

fn fail(r: &str) -> Failure {
    Failure {
        reasons: vec![r.to_owned()],
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn secret_shaped(path: &str) -> bool {
    let pol = WorkspacePolicy::default();
    path.split('/')
        .any(|c| pol.classify_name(c) == NameClass::Sensitive)
}

fn free_bytes(p: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail * s.f_frsize)
}

const FICLONE: libc::c_ulong = 0x4004_9409;

/// Test hook (feature `crash-injection` only): the bounded copy reports ENOSPC after this many bytes.
#[cfg(feature = "crash-injection")]
fn enospc_after() -> Option<u64> {
    std::env::var("NEXUS_TEST_CHECKPOINT_ENOSPC_AFTER_BYTES")
        .ok()?
        .parse()
        .ok()
}
#[cfg(not(feature = "crash-injection"))]
fn enospc_after() -> Option<u64> {
    None
}

/// Store one source file: reflink when possible, otherwise a bounded copy. Returns `(sha256, reflinked)`.
/// `reflink` is the learned capability of the store filesystem (None = not yet known).
fn store_file(
    src: &mut std::fs::File,
    dst: &Path,
    reflink: &mut Option<bool>,
    written_total: &mut u64,
) -> std::io::Result<(String, bool)> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dst)?;
    let mut cloned = false;
    if *reflink != Some(false) {
        let rc = unsafe { libc::ioctl(out.as_raw_fd(), FICLONE, src.as_raw_fd()) };
        if rc == 0 {
            *reflink = Some(true);
            cloned = true;
        } else {
            let e = std::io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::EXDEV)
                | Some(libc::EOPNOTSUPP)
                | Some(libc::EINVAL)
                | Some(libc::ENOTTY)
                | Some(libc::ENOSYS) => *reflink = Some(false),
                _ => return Err(e),
            }
        }
    }
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        if !cloned {
            if let Some(limit) = enospc_after() {
                if *written_total + n as u64 > limit {
                    return Err(std::io::Error::from_raw_os_error(libc::ENOSPC));
                }
            }
            out.write_all(&buf[..n])?;
            *written_total += n as u64;
        }
    }
    Ok((hex::encode(h.finalize()), cloned))
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// Create the checkpoint of `pre` for execution `id` under `store`. On success the checkpoint is durably
/// persisted (index written, fsynced, directory published) and marked ACTIVE until `finish`.
pub fn create(
    ws: &Workspace,
    store: &Path,
    id: &str,
    pre: &Manifest,
    pol: &CheckpointPolicy,
) -> Result<Index, Failure> {
    use std::os::unix::fs::DirBuilderExt;
    if !valid_id(id) {
        return Err(fail("bad-execution-id"));
    }
    let b = &pol.budget;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(store)
        .map_err(|_| fail("store-unavailable"))?;
    let _ = gc(store, b);
    let partial = store.join(format!("{id}.partial"));
    cleanup(&partial);
    let finalp = store.join(id);
    cleanup(&finalp);
    for d in [&partial, &partial.join("files")] {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(d)
            .map_err(|_| fail("store-unavailable"))?;
    }
    let _ = std::fs::write(partial.join("ACTIVE"), b"1");
    if observe::root_identity(ws).as_ref() != Some(&pre.root) {
        cleanup(&partial);
        return Err(fail("workspace-identity-changed"));
    }
    let root = ws.root_raw_fd();
    let mut idx = Index {
        schema: INDEX_SCHEMA.into(),
        execution_id: id.into(),
        created_ms: observe::now_ms(),
        workspace: pre.root.clone(),
        method: "none".into(),
        consistency: CONSISTENCY_NOTE.into(),
        status: "complete".into(),
        reasons: vec![],
        entries: BTreeMap::new(),
        coverage: Coverage::default(),
        files_stored: 0,
        logical_bytes: 0,
        reflinked_bytes: 0,
        copied_bytes: 0,
        digest: String::new(),
    };
    let mut reasons: Vec<String> = vec![];
    let why = |r: String, reasons: &mut Vec<String>| {
        if reasons.len() < 50 && !reasons.contains(&r) {
            reasons.push(r);
        }
    };
    if !pre.completeness.complete {
        why(
            format!(
                "pre-manifest-incomplete:{}",
                pre.completeness.reasons.join(",")
            ),
            &mut reasons,
        );
    }
    idx.coverage.bulk_dirs_not_captured = pre
        .bulk
        .iter()
        .filter(|(_, v)| !v.protected)
        .map(|(k, _)| k.clone())
        .collect();
    idx.coverage.git_not_captured = pre.bulk.values().any(|v| v.protected);
    // Storage estimate for the files that would be stored.
    let est: u64 = pre
        .entries
        .iter()
        .filter(|(p, r)| r.kind == "f" && r.size <= b.max_file_bytes && !secret_shaped(p))
        .map(|(_, r)| r.size)
        .sum();
    let free = free_bytes(store);
    let mut reflink: Option<bool> = if pol.force_copy { Some(false) } else { None };
    let (mut n_ref, mut n_copy) = (0u64, 0u64);
    let mut written = 0u64;
    let mut preflighted = false;
    for (path, r) in &pre.entries {
        let mut e = Entry {
            kind: r.kind.clone(),
            size: r.size,
            mode: r.mode,
            uid: r.uid,
            gid: r.gid,
            mtime_ns: r.mtime_ns,
            nlink: r.nlink,
            target: r.target.clone(),
            sha256: None,
            blob: None,
            excluded: None,
            hardlinked: r.kind == "f" && r.nlink > 1,
            reflinked: false,
        };
        match r.kind.as_str() {
            "d" | "l" => {}
            "o" => {
                e.excluded = Some("special-file".into());
                idx.coverage.special_excluded += 1;
            }
            _ => {
                if secret_shaped(path) {
                    e.excluded = Some("secret-shaped".into());
                    idx.coverage.secret_shaped_excluded += 1;
                } else if r.size > b.max_file_bytes {
                    e.excluded = Some("file-too-large".into());
                    why(format!("file-too-large:{path}"), &mut reasons);
                } else if idx.files_stored >= b.max_files {
                    e.excluded = Some("file-budget".into());
                    why("file-budget".into(), &mut reasons);
                } else if idx.logical_bytes + r.size > b.max_bytes {
                    e.excluded = Some("size-budget".into());
                    why("size-budget".into(), &mut reasons);
                } else {
                    // Open through the pinned descriptor, no symlink followed, and verify identity.
                    let opened = observe::open_rel_path(root, path);
                    let Some(fd) = opened else {
                        e.excluded = Some("unreadable".into());
                        why(format!("unreadable:{path}"), &mut reasons);
                        idx.coverage.unplanned_excluded += 1;
                        idx.entries.insert(path.clone(), e);
                        continue;
                    };
                    let mut f = std::fs::File::from(fd);
                    let same = |f: &std::fs::File| {
                        crate::workspace::fstat_fd(f.as_raw_fd())
                            .ok()
                            .is_some_and(|s| {
                                matches!(s.kind, crate::workspace::Kind::File)
                                    && s.ino == r.ino
                                    && s.size == r.size
                                    && (s.ctime_ns as i64) == r.ctime_ns
                            })
                    };
                    if !same(&f) {
                        e.excluded = Some("changed-since-observation".into());
                        why(format!("changed-since-observation:{path}"), &mut reasons);
                    } else {
                        let blob = format!("{}", idx.entries.len());
                        let dst = partial.join("files").join(&blob);
                        match store_file(&mut f, &dst, &mut reflink, &mut written) {
                            Ok((sha, cloned)) => {
                                if !same(&f) {
                                    let _ = std::fs::remove_file(&dst);
                                    e.excluded = Some("changed-during-checkpoint".into());
                                    why(format!("changed-during-checkpoint:{path}"), &mut reasons);
                                } else {
                                    e.sha256 = Some(sha);
                                    e.blob = Some(blob);
                                    e.reflinked = cloned;
                                    idx.files_stored += 1;
                                    idx.logical_bytes += r.size;
                                    if cloned {
                                        idx.reflinked_bytes += r.size;
                                        n_ref += 1;
                                    } else {
                                        idx.copied_bytes += r.size;
                                        n_copy += 1;
                                    }
                                    if !preflighted && reflink == Some(false) {
                                        preflighted = true;
                                        if let Some(fr) = free {
                                            if est.saturating_add(b.min_free_bytes) > fr {
                                                cleanup(&partial);
                                                return Err(fail("insufficient-storage"));
                                            }
                                        }
                                    }
                                    if idx.files_stored == 2 {
                                        crate::mutate::crash_point("checkpoint-during");
                                    }
                                }
                            }
                            Err(err) => {
                                let _ = std::fs::remove_file(&dst);
                                if err.raw_os_error() == Some(libc::ENOSPC)
                                    || err.raw_os_error() == Some(libc::EDQUOT)
                                {
                                    cleanup(&partial);
                                    return Err(fail("storage-exhausted"));
                                }
                                e.excluded = Some("unreadable".into());
                                why(format!("unreadable:{path}"), &mut reasons);
                            }
                        }
                    }
                    if e.excluded.is_some() {
                        idx.coverage.unplanned_excluded += 1;
                    }
                }
                if e.excluded.as_deref() == Some("file-too-large")
                    || e.excluded.as_deref() == Some("file-budget")
                    || e.excluded.as_deref() == Some("size-budget")
                {
                    idx.coverage.unplanned_excluded += 1;
                }
            }
        }
        idx.entries.insert(path.clone(), e);
    }
    idx.method = match (n_ref > 0, n_copy > 0) {
        (true, true) => "mixed",
        (true, false) => "reflink",
        (false, true) => "copy",
        _ => "none",
    }
    .into();
    if !reasons.is_empty() {
        idx.status = "incomplete".into();
    }
    idx.reasons = reasons;
    idx.digest = idx.compute_digest();
    // Persist: index (atomic, fsynced), then publish the directory.
    let bytes = serde_json::to_vec(&idx).map_err(|_| fail("index-unserializable"))?;
    let tmp = partial.join(".index.tmp");
    let persist = (|| -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, partial.join("index.json"))?;
        std::fs::File::open(&partial)?.sync_all()?;
        std::fs::rename(&partial, &finalp)?;
        std::fs::File::open(store)?.sync_all()
    })();
    if persist.is_err() {
        cleanup(&partial);
        cleanup(&finalp);
        return Err(fail("index-write-failed"));
    }
    Ok(idx)
}

/// The execution that owns the checkpoint ended (or was recovered): it may now be retired by retention.
pub fn finish(store: &Path, id: &str) {
    if valid_id(id) {
        let _ = std::fs::remove_file(store.join(id).join("ACTIVE"));
    }
}

pub fn remove(store: &Path, id: &str) {
    if valid_id(id) {
        cleanup(&store.join(id));
        cleanup(&store.join(format!("{id}.partial")));
    }
}

/// Read and verify an index. The error names what is wrong: `missing` | `corrupt` | `unsupported-schema` |
/// `digest-mismatch`.
pub fn read_index(store: &Path, id: &str) -> Result<Index, String> {
    if !valid_id(id) {
        return Err("missing".into());
    }
    let raw = std::fs::read(store.join(id).join("index.json")).map_err(|_| "missing".to_owned())?;
    let idx: Index = serde_json::from_slice(&raw).map_err(|_| "corrupt".to_owned())?;
    if idx.schema != INDEX_SCHEMA {
        return Err("unsupported-schema".into());
    }
    if idx.execution_id != id || idx.digest != idx.compute_digest() {
        return Err("digest-mismatch".into());
    }
    Ok(idx)
}

/// Open a stored blob (size checked; the content hash is verified by whoever consumes the bytes).
pub fn open_blob(store: &Path, id: &str, e: &Entry) -> Result<std::fs::File, String> {
    let blob = e.blob.as_deref().ok_or("not-stored")?;
    if blob.is_empty() || !blob.bytes().all(|b| b.is_ascii_digit()) {
        return Err("corrupt".into());
    }
    let p = store.join(id).join("files").join(blob);
    let md = std::fs::symlink_metadata(&p).map_err(|_| "missing".to_owned())?;
    if !md.is_file() || md.len() != e.size {
        return Err("corrupt".into());
    }
    std::fs::File::open(&p).map_err(|_| "missing".to_owned())
}

/// Read a pre-image fully, verifying its hash (bounded; for diffs).
pub fn read_preimage(
    store: &Path,
    id: &str,
    path: &str,
    max: u64,
) -> Result<Option<Vec<u8>>, String> {
    let idx = read_index(store, id)?;
    let Some(e) = idx.entries.get(path) else {
        return Ok(None);
    };
    if e.kind != "f" || e.blob.is_none() || e.size > max {
        return Ok(None);
    }
    let mut f = open_blob(store, id, e)?;
    let mut b = Vec::with_capacity(e.size as usize);
    f.read_to_end(&mut b).map_err(|_| "corrupt".to_owned())?;
    if Some(hex::encode(Sha256::digest(&b))) != e.sha256 {
        return Err("corrupt".into());
    }
    Ok(Some(b))
}

// ----------------------------------------------------------------------------- recoverability

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recoverability {
    /// Every change in the record has an available pre-image (or is new) and nothing is uncaptured.
    pub complete: bool,
    pub available: u64,
    pub unavailable: u64,
    pub new_paths: u64,
    /// Changes inside summarised dependency/build directories: never claimed recoverable.
    pub bulk_not_captured: u64,
    /// Per modified/deleted/changed path: `available` | `unavailable:<reason>`.
    pub pre_images: BTreeMap<String, String>,
}

/// For every observed modification/deletion/metadata change: is its original recoverable from `idx`?
pub fn assess(idx: Option<&Index>, fx: &EffectSet) -> Recoverability {
    let mut r = Recoverability::default();
    let judge = |path: &str, r: &mut Recoverability| {
        let v = match idx {
            None => "unavailable:no-checkpoint".to_owned(),
            Some(i) => match i.entries.get(path) {
                None => "unavailable:not-in-checkpoint".to_owned(),
                Some(e) if e.kind == "f" && e.blob.is_some() => "available".to_owned(),
                Some(e) if e.kind == "l" || e.kind == "d" => "available".to_owned(),
                Some(e) => format!(
                    "unavailable:{}",
                    e.excluded.clone().unwrap_or_else(|| "not-stored".into())
                ),
            },
        };
        if v == "available" {
            r.available += 1;
        } else {
            r.unavailable += 1;
        }
        r.pre_images.insert(path.to_owned(), v);
    };
    for p in fx
        .modified
        .paths
        .iter()
        .chain(fx.deleted.paths.iter())
        .chain(fx.metadata_changed.iter().map(|m| &m.path))
        .chain(
            fx.symlinks
                .iter()
                .filter(|l| l.change == "changed")
                .map(|l| &l.path),
        )
    {
        if !r.pre_images.contains_key(p) {
            judge(p, &mut r);
        }
    }
    r.new_paths = fx.created.count;
    r.bulk_not_captured = fx.bulk_changed.len() as u64;
    r.complete = r.unavailable == 0
        && r.bulk_not_captured == 0
        && idx.is_some_and(|i| i.status == "complete")
        && !fx.lists_may_be_incomplete
        && !fx.created.truncated
        && !fx.modified.truncated
        && !fx.deleted.truncated;
    r
}

// ----------------------------------------------------------------------------- retention

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GcReport {
    pub removed: u64,
    pub kept: u64,
}

fn age_secs(p: &Path) -> Option<u64> {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()?
        .elapsed()
        .ok()
        .map(|d| d.as_secs())
}

/// Retention and quota. Never removes a checkpoint whose execution is still ACTIVE.
pub fn gc(store: &Path, b: &CheckpointBudget) -> GcReport {
    let mut rep = GcReport::default();
    let Ok(rd) = std::fs::read_dir(store) else {
        return rep;
    };
    let mut live: Vec<(u64, u64, PathBuf)> = vec![]; // (created_ms, bytes, dir)
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if p.join("ACTIVE").exists() {
            rep.kept += 1;
            continue;
        }
        if name.ends_with(".partial") {
            if age_secs(&p).is_some_and(|a| a > 24 * 3600) {
                cleanup(&p);
                rep.removed += 1;
            }
            continue;
        }
        let idx = std::fs::read(p.join("index.json"))
            .ok()
            .and_then(|r| serde_json::from_slice::<Index>(&r).ok());
        let old = age_secs(&p).is_some_and(|a| a > b.retention_secs);
        match idx {
            Some(i) if !old => live.push((i.created_ms, i.logical_bytes, p)),
            _ => {
                cleanup(&p);
                rep.removed += 1;
            }
        }
    }
    live.sort_by_key(|x| x.0);
    let mut total: u64 = live.iter().map(|x| x.1).sum();
    let mut i = 0;
    while total > b.store_quota_bytes && i < live.len() {
        cleanup(&live[i].2);
        total = total.saturating_sub(live[i].1);
        rep.removed += 1;
        i += 1;
    }
    rep.kept += (live.len() - i) as u64;
    rep
}

/// At daemon start no execution of the previous process is running: unpublished checkpoints are
/// partial leftovers, and ACTIVE markers are stale.
pub fn startup_sweep(store: &Path, b: &CheckpointBudget) -> GcReport {
    if let Ok(rd) = std::fs::read_dir(store) {
        for e in rd.flatten() {
            let p = e.path();
            if e.file_name().to_string_lossy().ends_with(".partial") {
                cleanup(&p);
            } else {
                let _ = std::fs::remove_file(p.join("ACTIVE"));
            }
        }
    }
    gc(store, b)
}

/// Benchmark helper: the recoverability of `fx` against a freshly made index.
#[doc(hidden)]
pub fn finish_assess_for_bench(idx: &Index, fx: &EffectSet) -> Recoverability {
    assess(Some(idx), fx)
}
