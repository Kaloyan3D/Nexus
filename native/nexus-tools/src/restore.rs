//! Guarded restoration (M3B).
//!
//! Restores the pre-command state of the paths an observed in-place command changed, using three sources of
//! truth: the **checkpoint** (what the paths were), the **effects record** (what the command left; sealed by its
//! digest) and the **current filesystem** (what is there now). A path is touched only when the current state is
//! exactly what the command left (or the path is already original). Anything a person changed afterwards is a
//! **conflict** and is left alone. Restoration is **not a transaction**: each path is decided and applied on its
//! own; the report says which were restored, skipped, conflicted or unrecoverable, and running it again is safe
//! (restored paths read as "already original"). It is only ever started by an explicit operator request, never by
//! crash recovery.
//!
//! Known limits, reported rather than hidden: the check of a path and its replacement are separate steps (a writer
//! that changes the file between them wins); restored files get the recorded permission bits and mtime but not
//! the recorded owner; hard-linked files are never rewritten (that would change other names or detach this one);
//! renames are handled as a deletion plus a creation, each guarded on its own.

use crate::checkpoint::{self, Index};
use crate::observe::{self, EffectsRecord, Rec};
use crate::workspace::Workspace;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
    /// Decide everything, change nothing.
    pub dry_run: bool,
    /// Stop after this many filesystem mutations (the report says it stopped).
    pub max_operations: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Item {
    pub path: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub execution_id: String,
    pub dry_run: bool,
    /// `refused` | `completed` | `partial` | `nothing-restored`
    pub outcome: String,
    pub refused: Option<String>,
    pub checkpoint_status: Option<String>,
    pub restored: Vec<Item>,
    pub skipped: Vec<Item>,
    pub conflicted: Vec<Item>,
    pub unrecoverable: Vec<Item>,
    /// The effects record's path lists were capped: paths beyond them are not covered.
    pub record_lists_truncated: bool,
    pub stopped_at_operation_limit: bool,
    pub note: String,
}

impl RestoreReport {
    pub fn counts(&self) -> serde_json::Value {
        serde_json::json!({
            "restored": self.restored.len(), "skipped": self.skipped.len(),
            "conflicted": self.conflicted.len(), "unrecoverable": self.unrecoverable.len(),
        })
    }

    /// Digest of what the report says would happen (independent of the dry-run flag): the confirmation a
    /// person must give back before it is applied.
    pub fn confirm_digest(&self) -> String {
        let v = serde_json::json!({
            "executionId": self.execution_id, "refused": self.refused,
            "restored": self.restored, "skipped": self.skipped,
            "conflicted": self.conflicted, "unrecoverable": self.unrecoverable,
            "truncated": self.record_lists_truncated,
        });
        hex::encode(Sha256::digest(
            nexus_contracts::canonical_json(&v).as_bytes(),
        ))
    }
}

const NOTE: &str = "Restoration is not atomic. Each path was decided on its own against the checkpoint, the recorded post-command state and the current filesystem; a path changed by anyone afterwards is reported as a conflict and left untouched.";

fn refuse(id: &str, dry: bool, why: &str) -> RestoreReport {
    RestoreReport {
        execution_id: id.into(),
        dry_run: dry,
        outcome: "refused".into(),
        refused: Some(why.into()),
        note: NOTE.into(),
        ..Default::default()
    }
}

fn split(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

struct Ctx<'a> {
    ws: &'a Workspace,
    store: &'a Path,
    id: &'a str,
    idx: Index,
    rec: EffectsRecord,
    opts: RestoreOptions,
    rep: RestoreReport,
    ops: usize,
    stopped: bool,
    tmp_n: u32,
}

impl Ctx<'_> {
    fn parent(&self, path: &str) -> Option<OwnedFd> {
        observe::open_dir_rel(self.ws.root_raw_fd(), split(path).0)
    }

    fn current(&self, path: &str) -> Result<Option<Rec>, String> {
        let Some(p) = self.parent(path) else {
            return Ok(None); // the parent is gone (or not a directory): nothing at this path
        };
        observe::rec_at(p.as_raw_fd(), split(path).1).map_err(|e| format!("stat-failed:{e}"))
    }

    fn sha_now(&self, path: &str) -> Option<String> {
        let fd = observe::open_rel_path(self.ws.root_raw_fd(), path)?;
        let mut f = std::fs::File::from(fd);
        let st = crate::workspace::fstat_fd(f.as_raw_fd()).ok()?;
        if !matches!(st.kind, crate::workspace::Kind::File) {
            return None;
        }
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = f.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Some(hex::encode(h.finalize()))
    }

    /// Is the current state of `path` what the command left?
    fn is_post(&self, path: &str, cur: &Rec) -> bool {
        if let Some(post) = self.rec.post_state.get(path) {
            if post.kind == cur.kind
                && post.size == cur.size
                && post.mtime_ns == cur.mtime_ns
                && post.ctime_ns == cur.ctime_ns
                && post.ino == cur.ino
                && post.target == cur.target
            {
                return true;
            }
        }
        if cur.kind == "l" {
            return self
                .rec
                .post_state
                .get(path)
                .is_some_and(|p| p.kind == "l" && p.target == cur.target);
        }
        match (self.rec.effects.post_sha256.get(path), cur.kind.as_str()) {
            (Some(want), "f") => self.sha_now(path).as_deref() == Some(want.as_str()),
            _ => false,
        }
    }

    fn is_original(&self, path: &str, cur: &Rec) -> bool {
        let Some(e) = self.idx.entries.get(path) else {
            return false;
        };
        match (e.kind.as_str(), cur.kind.as_str()) {
            ("l", "l") => e.target == cur.target,
            ("f", "f") => e.sha256.is_some() && self.sha_now(path) == e.sha256,
            ("d", "d") => true,
            _ => false,
        }
    }

    fn ok(&mut self, path: &str, d: &str) {
        self.rep.restored.push(Item {
            path: path.into(),
            detail: d.into(),
        });
    }
    fn skip(&mut self, path: &str, d: &str) {
        self.rep.skipped.push(Item {
            path: path.into(),
            detail: d.into(),
        });
    }
    fn conflict(&mut self, path: &str, d: &str) {
        self.rep.conflicted.push(Item {
            path: path.into(),
            detail: d.into(),
        });
    }
    fn lost(&mut self, path: &str, d: &str) {
        self.rep.unrecoverable.push(Item {
            path: path.into(),
            detail: d.into(),
        });
    }

    /// May another mutation be made? (Counts it.)
    fn may_mutate(&mut self) -> bool {
        if let Some(m) = self.opts.max_operations {
            if self.ops >= m {
                self.stopped = true;
                return false;
            }
        }
        self.ops += 1;
        true
    }

    /// Write the stored content of `path` next to its destination, verified, with the recorded mode and
    /// mtime. Returns the temporary name.
    fn stage_file(&mut self, path: &str, parent: RawFd) -> Result<CString, String> {
        let e = self
            .idx
            .entries
            .get(path)
            .ok_or("not-in-checkpoint")?
            .clone();
        let mut src = checkpoint::open_blob(self.store, self.id, &e)?;
        self.tmp_n += 1;
        let tmp = CString::new(format!(
            ".nexus-restore-{}-{}",
            std::process::id(),
            self.tmp_n
        ))
        .map_err(|_| "bad-name")?;
        let fd = unsafe {
            libc::openat(
                parent,
                tmp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(format!("create-failed:{}", std::io::Error::last_os_error()));
        }
        let mut out = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
        let drop_tmp = |m: String| {
            unsafe { libc::unlinkat(parent, tmp.as_ptr(), 0) };
            m
        };
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = src.read(&mut buf).map_err(|_| drop_tmp("corrupt".into()))?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n])
                .map_err(|x| drop_tmp(format!("write-failed:{x}")))?;
        }
        if Some(hex::encode(h.finalize())) != e.sha256 {
            return Err(drop_tmp("corrupt".into()));
        }
        unsafe { libc::fchmod(out.as_raw_fd(), e.mode & 0o7777) };
        let ts = [
            libc::timespec {
                tv_sec: 0,
                tv_nsec: libc::UTIME_OMIT,
            },
            libc::timespec {
                tv_sec: (e.mtime_ns / 1_000_000_000) as libc::time_t,
                tv_nsec: (e.mtime_ns % 1_000_000_000) as libc::c_long,
            },
        ];
        unsafe { libc::futimens(out.as_raw_fd(), ts.as_ptr()) };
        // No per-file fsync (it dominated restore time on copy-on-write filesystems): one syncfs at the end.
        Ok(tmp)
    }

    fn replace_file(&mut self, path: &str, expect_absent: bool) {
        let Some(par) = self.parent(path) else {
            self.conflict(path, "parent-directory-missing");
            return;
        };
        let name = CString::new(split(path).1).unwrap_or_default();
        let tmp = match self.stage_file(path, par.as_raw_fd()) {
            Ok(t) => t,
            Err(m) if m == "corrupt" || m == "missing" => {
                self.lost(path, &format!("pre-image-{m}"));
                return;
            }
            Err(m) => {
                self.lost(path, &m);
                return;
            }
        };
        let rc = if expect_absent {
            unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    par.as_raw_fd(),
                    tmp.as_ptr(),
                    par.as_raw_fd(),
                    name.as_ptr(),
                    1u32, // RENAME_NOREPLACE
                )
            }
        } else {
            unsafe {
                libc::renameat(
                    par.as_raw_fd(),
                    tmp.as_ptr(),
                    par.as_raw_fd(),
                    name.as_ptr(),
                ) as _
            }
        };
        if rc != 0 {
            let e = std::io::Error::last_os_error();
            unsafe { libc::unlinkat(par.as_raw_fd(), tmp.as_ptr(), 0) };
            if e.raw_os_error() == Some(libc::EEXIST) {
                self.conflict(path, "recreated-during-restore");
            } else {
                self.lost(path, &format!("rename-failed:{e}"));
            }
            return;
        }
        crate::mutate::crash_point("restore-mid");
        self.ok(path, "content restored from the checkpoint");
    }

    fn restore_symlink(&mut self, path: &str, replace: bool) {
        let Some(par) = self.parent(path) else {
            self.conflict(path, "parent-directory-missing");
            return;
        };
        let target = self
            .idx
            .entries
            .get(path)
            .and_then(|e| e.target.clone())
            .unwrap_or_default();
        let (Ok(name), Ok(t)) = (CString::new(split(path).1), CString::new(target)) else {
            self.lost(path, "bad-symlink-target");
            return;
        };
        if replace && unsafe { libc::unlinkat(par.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            self.lost(path, "could-not-remove-current-link");
            return;
        }
        if unsafe { libc::symlinkat(t.as_ptr(), par.as_raw_fd(), name.as_ptr()) } != 0 {
            self.lost(
                path,
                &format!("symlink-failed:{}", std::io::Error::last_os_error()),
            );
            return;
        }
        self.ok(path, "symbolic link restored");
    }
}

/// Restore the state before execution `id`. `store` is the checkpoint store, `eff_dir` the effects ledger.
pub fn restore(
    ws: &Workspace,
    store: &Path,
    eff_dir: &Path,
    id: &str,
    opts: RestoreOptions,
) -> RestoreReport {
    let dry = opts.dry_run;
    let Some(rec) = observe::read_record(eff_dir, id) else {
        return refuse(id, dry, "no-effects-record");
    };
    if rec.digest != rec.compute_digest() {
        return refuse(id, dry, "effects-record-digest-mismatch");
    }
    if !rec.process.settled {
        return refuse(id, dry, "process-not-settled");
    }
    if observe::root_identity(ws).as_ref() != Some(&rec.workspace) {
        return refuse(id, dry, "workspace-identity-changed");
    }
    let Some(ck) = rec.checkpoint.clone() else {
        return refuse(id, dry, "no-checkpoint");
    };
    let (Some(ck_id), Some(ck_digest)) = (
        ck.get("id").and_then(|v| v.as_str()).map(str::to_owned),
        ck.get("indexDigest")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    ) else {
        return refuse(id, dry, "no-checkpoint");
    };
    let idx = match checkpoint::read_index(store, &ck_id) {
        Ok(i) => i,
        Err(e) => return refuse(id, dry, &format!("checkpoint-{e}")),
    };
    if idx.digest != ck_digest {
        return refuse(id, dry, "checkpoint-digest-differs-from-the-record");
    }
    if idx.workspace != rec.workspace {
        return refuse(id, dry, "checkpoint-belongs-to-another-workspace");
    }
    let mut c = Ctx {
        ws,
        store,
        id: &ck_id,
        rep: RestoreReport {
            execution_id: id.into(),
            dry_run: dry,
            checkpoint_status: Some(idx.status.clone()),
            note: NOTE.into(),
            ..Default::default()
        },
        idx,
        rec,
        opts,
        ops: 0,
        stopped: false,
        tmp_n: 0,
    };
    run(&mut c);
    if !dry && c.ops > 0 {
        unsafe { libc::syncfs(c.ws.root_raw_fd()) };
    }
    let r = &mut c.rep;
    r.stopped_at_operation_limit = c.stopped;
    r.outcome = if r.restored.is_empty() && !r.conflicted.is_empty()
        || r.restored.is_empty() && !r.unrecoverable.is_empty()
    {
        "nothing-restored"
    } else if r.conflicted.is_empty()
        && r.unrecoverable.is_empty()
        && !c.stopped
        && !r.record_lists_truncated
    {
        "completed"
    } else if r.restored.is_empty() && r.skipped.is_empty() {
        "nothing-restored"
    } else {
        "partial"
    }
    .into();
    if !dry {
        if let Ok(b) = serde_json::to_vec(&c.rep) {
            let p = store
                .join(&ck_id)
                .join(format!("restore-{}.json", observe::now_ms()));
            let _ = std::fs::write(p, b);
        }
    }
    c.rep
}

fn run(c: &mut Ctx) {
    let fx = c.rec.effects.clone();
    c.rep.record_lists_truncated = fx.created.truncated
        || fx.modified.truncated
        || fx.deleted.truncated
        || fx.created_dirs.truncated
        || fx.deleted_dirs.truncated
        || fx.lists_may_be_incomplete;
    let created: BTreeSet<&String> = fx.created.paths.iter().collect();
    let deleted: BTreeSet<&String> = fx.deleted.paths.iter().collect();
    let dry = c.opts.dry_run;

    // A. directories the command removed, shallow first
    let mut ddirs: Vec<&String> = fx.deleted_dirs.paths.iter().collect();
    ddirs.sort();
    for d in ddirs {
        let Some(e) = c.idx.entries.get(d.as_str()).cloned() else {
            c.lost(d, "not-in-checkpoint");
            continue;
        };
        match c.current(d) {
            Ok(None) => {
                let Some(par) = c.parent(d) else {
                    c.conflict(d, "parent-directory-missing");
                    continue;
                };
                if dry {
                    c.ok(d, "directory would be recreated");
                } else if c.may_mutate() {
                    let n = CString::new(split(d).1).unwrap_or_default();
                    let rc = unsafe { libc::mkdirat(par.as_raw_fd(), n.as_ptr(), 0o700) };
                    if rc == 0 {
                        unsafe {
                            let fd = libc::openat(
                                par.as_raw_fd(),
                                n.as_ptr(),
                                libc::O_RDONLY
                                    | libc::O_DIRECTORY
                                    | libc::O_NOFOLLOW
                                    | libc::O_CLOEXEC,
                            );
                            if fd >= 0 {
                                libc::fchmod(fd, e.mode & 0o7777);
                                libc::close(fd);
                            }
                        }
                        c.ok(d, "directory recreated");
                    } else {
                        c.lost(
                            d,
                            &format!("mkdir-failed:{}", std::io::Error::last_os_error()),
                        );
                    }
                }
            }
            Ok(Some(r)) if r.kind == "d" => c.skip(d, "directory already exists"),
            Ok(Some(_)) => c.conflict(d, "a non-directory now occupies the path"),
            Err(m) => c.lost(d, &m),
        }
    }

    // B. files and links the command changed or removed
    let mut targets: BTreeSet<String> = BTreeSet::new();
    targets.extend(fx.modified.paths.iter().cloned());
    targets.extend(fx.deleted.paths.iter().cloned());
    targets.extend(
        fx.symlinks
            .iter()
            .filter(|l| l.change == "changed")
            .map(|l| l.path.clone()),
    );
    let mut handled: BTreeSet<String> = BTreeSet::new();
    for p in &targets {
        if c.stopped {
            break;
        }
        handled.insert(p.clone());
        let Some(e) = c.idx.entries.get(p).cloned() else {
            c.lost(p, "not-in-checkpoint");
            continue;
        };
        if e.kind == "o" || (e.kind == "f" && e.blob.is_none()) {
            c.lost(
                p,
                &format!(
                    "no-pre-image:{}",
                    e.excluded.clone().unwrap_or_else(|| "not-stored".into())
                ),
            );
            continue;
        }
        if e.kind == "d" {
            continue;
        }
        let was_deleted = deleted.contains(p) && !created.contains(p);
        let cur = match c.current(p) {
            Ok(v) => v,
            Err(m) => {
                c.lost(p, &m);
                continue;
            }
        };
        match cur {
            None => {
                if !was_deleted && !deleted.contains(p) {
                    c.conflict(p, "removed-after-the-command");
                    continue;
                }
                if dry {
                    c.ok(p, "would be recreated from the checkpoint");
                } else if c.may_mutate() {
                    if e.kind == "l" {
                        c.restore_symlink(p, false);
                    } else {
                        c.replace_file(p, true);
                    }
                }
            }
            Some(cur) => {
                if c.is_original(p, &cur) {
                    c.skip(p, "already original");
                    continue;
                }
                if cur.kind == "f" && cur.nlink > 1 {
                    c.conflict(p, "hard-linked: replacing it would detach or alter other names; not rewritten");
                    continue;
                }
                if was_deleted {
                    c.conflict(p, "recreated-after-the-command");
                    continue;
                }
                if !c.is_post(p, &cur) {
                    c.conflict(p, "changed-after-the-command");
                    continue;
                }
                if dry {
                    c.ok(p, "would be restored from the checkpoint");
                } else if c.may_mutate() {
                    if e.kind == "l" {
                        c.restore_symlink(p, true);
                    } else if cur.kind == "f" {
                        c.replace_file(p, false);
                    } else {
                        c.conflict(p, "the type of the entry changed; not replaced");
                    }
                }
            }
        }
    }

    // C. things the command created (not those already handled as type changes)
    let mut cr: Vec<&String> = fx
        .created
        .paths
        .iter()
        .filter(|p| !handled.contains(*p))
        .collect();
    cr.sort();
    cr.reverse();
    for p in cr {
        if c.stopped {
            break;
        }
        match c.current(p) {
            Ok(None) => c.skip(p, "already gone"),
            Ok(Some(cur)) => {
                if cur.kind == "d" {
                    c.conflict(p, "a directory now occupies the path");
                } else if !c.is_post(p, &cur) {
                    c.conflict(p, "modified-after-the-command; kept");
                } else if dry {
                    c.ok(p, "created by the command; would be removed");
                } else if c.may_mutate() {
                    let Some(par) = c.parent(p) else {
                        c.skip(p, "already gone");
                        continue;
                    };
                    let n = CString::new(split(p).1).unwrap_or_default();
                    if unsafe { libc::unlinkat(par.as_raw_fd(), n.as_ptr(), 0) } == 0 {
                        c.ok(p, "created by the command; removed");
                    } else {
                        c.lost(
                            p,
                            &format!("unlink-failed:{}", std::io::Error::last_os_error()),
                        );
                    }
                }
            }
            Err(m) => c.lost(p, &m),
        }
    }

    // D. directories the command created, deepest first, only when empty
    let mut cd: Vec<&String> = fx.created_dirs.paths.iter().collect();
    cd.sort();
    cd.reverse();
    for d in cd {
        if c.stopped {
            break;
        }
        match c.current(d) {
            Ok(Some(r)) if r.kind == "d" => {
                if dry {
                    c.ok(d, "created by the command; would be removed if empty");
                } else if c.may_mutate() {
                    let Some(par) = c.parent(d) else { continue };
                    let n = CString::new(split(d).1).unwrap_or_default();
                    if unsafe { libc::unlinkat(par.as_raw_fd(), n.as_ptr(), libc::AT_REMOVEDIR) }
                        == 0
                    {
                        c.ok(d, "created by the command; removed (empty)");
                    } else {
                        c.skip(d, "not removed: it still holds entries the command did not create or that were kept");
                    }
                }
            }
            Ok(Some(_)) => c.conflict(d, "a non-directory now occupies the path"),
            Ok(None) => c.skip(d, "already gone"),
            Err(m) => c.lost(d, &m),
        }
    }

    // E. permission-only changes
    for m in &fx.metadata_changed {
        if c.stopped {
            break;
        }
        let p = &m.path;
        if handled.contains(p) {
            continue;
        }
        if m.what.iter().any(|w| w == "owner") {
            c.lost(p, "owner-change-is-not-restored");
        }
        if !m.what.iter().any(|w| w == "mode") {
            continue;
        }
        let Some(e) = c.idx.entries.get(p).cloned() else {
            c.lost(p, "not-in-checkpoint");
            continue;
        };
        let Ok(Some(cur)) = c.current(p) else {
            c.skip(p, "no longer present");
            continue;
        };
        if cur.mode == e.mode {
            c.skip(p, "mode already original");
        } else if c.rec.post_state.get(p).is_some_and(|q| q.mode == cur.mode) {
            if dry {
                c.ok(p, "mode would be restored");
            } else if c.may_mutate() {
                let fd = if e.kind == "d" {
                    observe::open_dir_rel(c.ws.root_raw_fd(), p)
                } else {
                    observe::open_rel_path(c.ws.root_raw_fd(), p)
                };
                match fd {
                    Some(fd) if unsafe { libc::fchmod(fd.as_raw_fd(), e.mode & 0o7777) } == 0 => {
                        c.ok(p, "permission bits restored")
                    }
                    _ => c.lost(p, "chmod-failed"),
                }
            }
        } else {
            c.conflict(p, "mode-changed-after-the-command");
        }
    }

    // F. summarised directories were never captured
    for b in &fx.bulk_changed {
        let why = if b.protected {
            "git-directory-not-captured"
        } else {
            "bulk-directory-not-captured"
        };
        c.lost(&b.path, why);
    }
}
