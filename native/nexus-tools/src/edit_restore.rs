//! Guarded restoration of the files Nexus's own edit tools wrote in a Direct workspace (Release 1).
//!
//! The Direct store keeps, per path a task touched, the exact original (or "did not exist") and the sha of the
//! last post-image Nexus VERIFIED. That is enough to put a file back WITHOUT guessing: a path is touched only
//! when it still holds exactly what Nexus last wrote. Anything else - a file you edited afterwards, one a later
//! command rewrote, one you deleted, a symlink or hard link now standing where the file was - is a **conflict**
//! and is left exactly as it is. Nothing is ever deleted unless it is byte-identical to what Nexus created.
//!
//! Safety properties (each has a test):
//! * every path is validated with the same rule that governs Nexus's own writes (no `..`, no absolute path, no
//!   VCS/credential/CI paths) and opened one component at a time without following symlinks, below the pinned
//!   workspace root: a symlinked directory or a path that leaves the workspace is refused;
//! * the check and the change are not separable by a concurrent writer: a replacement is an atomic
//!   `RENAME_EXCHANGE` followed by a verification of the file that was swapped OUT (if it is not what Nexus wrote,
//!   the exchange is undone); a deletion first moves the file aside with `RENAME_NOREPLACE`, verifies it, and only
//!   then unlinks it (otherwise it is moved back);
//! * hard-linked files are never rewritten or removed (that would alter or detach other names);
//! * a preview changes nothing and carries a digest; applying requires the digest of a preview taken against the
//!   CURRENT state, so a change since the preview invalidates the confirmation;
//! * restoration is not a transaction: each path is decided on its own and the report says exactly which were
//!   restored, skipped, left alone (conflict) or cannot be recovered.

use crate::direct::{Entry, Store};
use crate::observe::{self, now_ms, Rec};
use crate::workspace::Workspace;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

const RENAME_NOREPLACE: u32 = 1;
const RENAME_EXCHANGE: u32 = 2;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Item {
    pub path: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRestoreReport {
    pub dry_run: bool,
    /// `refused` | `completed` | `partial` | `nothing-restored`
    pub outcome: String,
    pub refused: Option<String>,
    pub restored: Vec<Item>,
    pub skipped: Vec<Item>,
    pub conflicted: Vec<Item>,
    pub unrecoverable: Vec<Item>,
    pub note: String,
}

const NOTE: &str = "Restoration is not atomic: each file was decided on its own. A file is put back only if it still holds exactly what Nexus last wrote; a file you or a later command changed is left untouched. Files Nexus created are removed only if they are unchanged.";

impl EditRestoreReport {
    /// What a person must confirm: the digest of what the report says would happen (independent of `dry_run`).
    pub fn confirm_digest(&self) -> String {
        let v = serde_json::json!({
            "refused": self.refused, "restored": self.restored, "skipped": self.skipped,
            "conflicted": self.conflicted, "unrecoverable": self.unrecoverable,
        });
        hex::encode(Sha256::digest(
            nexus_contracts::canonical_json(&v).as_bytes(),
        ))
    }
    pub fn counts(&self) -> serde_json::Value {
        serde_json::json!({
            "restored": self.restored.len(), "skipped": self.skipped.len(),
            "conflicted": self.conflicted.len(), "unrecoverable": self.unrecoverable.len(),
        })
    }
}

fn split(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// sha256 of the regular file `name` inside `dir`, read through a descriptor opened without following links.
fn sha_at(dir: RawFd, name: &CString) -> Option<String> {
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return None;
    }
    let mut f = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    if !f.metadata().ok()?.is_file() {
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

fn renameat2(dir: RawFd, from: &CString, to: &CString, flags: u32) -> std::io::Result<()> {
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            dir,
            from.as_ptr(),
            dir,
            to.as_ptr(),
            flags,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

struct Ctx<'a> {
    ws: &'a Workspace,
    store: &'a Store,
    dry: bool,
    rep: EditRestoreReport,
    tmp_n: u32,
}

impl Ctx<'_> {
    fn ok(&mut self, p: &str, d: &str) {
        self.rep.restored.push(Item {
            path: p.into(),
            detail: d.into(),
        });
    }
    fn skip(&mut self, p: &str, d: &str) {
        self.rep.skipped.push(Item {
            path: p.into(),
            detail: d.into(),
        });
    }
    fn conflict(&mut self, p: &str, d: &str) {
        self.rep.conflicted.push(Item {
            path: p.into(),
            detail: d.into(),
        });
    }
    fn lost(&mut self, p: &str, d: &str) {
        self.rep.unrecoverable.push(Item {
            path: p.into(),
            detail: d.into(),
        });
    }

    fn temp_name(&mut self, tag: &str) -> CString {
        self.tmp_n += 1;
        CString::new(format!(
            ".nexus-{tag}-{}-{}",
            std::process::id(),
            self.tmp_n
        ))
        .unwrap()
    }

    /// Write `bytes` into a new private file next to the destination, with the recorded permission bits.
    fn stage(&mut self, dir: RawFd, bytes: &[u8], mode: Option<u32>) -> Result<CString, String> {
        let tmp = self.temp_name("restore");
        let fd = unsafe {
            libc::openat(
                dir,
                tmp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(format!("create-failed:{}", std::io::Error::last_os_error()));
        }
        let mut f = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
        let drop_tmp = |m: String| {
            unsafe { libc::unlinkat(dir, tmp.as_ptr(), 0) };
            m
        };
        f.write_all(bytes)
            .map_err(|e| drop_tmp(format!("write-failed:{e}")))?;
        if let Some(m) = mode {
            unsafe { libc::fchmod(f.as_raw_fd(), m & 0o7777) };
        }
        f.sync_all()
            .map_err(|e| drop_tmp(format!("sync-failed:{e}")))?;
        Ok(tmp)
    }

    fn entry(&mut self, e: &Entry) {
        let path = e.path.as_str();
        if !e.applied {
            self.skip(path, "no change by Nexus was verified on this file");
            return;
        }
        if crate::protect::workbench_path_check(path).is_err() {
            self.lost(
                path,
                "unsafe-path: not a path Nexus may write, so not one it will restore",
            );
            return;
        }
        let (parent_rel, name) = split(path);
        let Some(par) = observe::open_dir_rel(self.ws.root_raw_fd(), parent_rel) else {
            self.conflict(path, "the folder is gone, or is now a link: not followed");
            return;
        };
        let dir = par.as_raw_fd();
        let Ok(cname) = CString::new(name) else {
            self.lost(path, "unsafe-path");
            return;
        };
        let cur: Option<Rec> = match observe::rec_at(dir, name) {
            Ok(v) => v,
            Err(_) => {
                self.lost(path, "could not be examined");
                return;
            }
        };
        let pre: Option<Vec<u8>> = if e.existed {
            self.store.read_pre(e)
        } else {
            None
        };
        // the original must be intact before anything is decided on it
        if e.existed
            && pre
                .as_ref()
                .map(|b| Some(sha_hex(b)) != e.sha)
                .unwrap_or(true)
        {
            self.lost(path, "the kept original is missing or damaged");
            return;
        }
        if let Some(c) = &cur {
            if c.kind != "f" {
                self.conflict(
                    path,
                    "it is not a regular file now (a link, folder or special file): left alone",
                );
                return;
            }
            if c.nlink > 1 {
                self.conflict(
                    path,
                    "hard-linked: changing it would alter or detach other names; left alone",
                );
                return;
            }
        }
        let cur_sha = cur.as_ref().and_then(|_| sha_at(dir, &cname));
        if cur.is_some() && cur_sha.is_none() {
            self.conflict(path, "could not be read safely: left alone");
            return;
        }
        match (&e.last_post_sha, &cur_sha) {
            // Nexus wrote (or created) it and it is gone
            (Some(_), None) => self.conflict(path, "removed after Nexus changed it: left as it is"),
            // Nexus deleted it
            (None, None) => {
                if !e.existed {
                    self.skip(
                        path,
                        "nothing to restore: Nexus created and removed it itself",
                    );
                } else if self.dry {
                    self.ok(path, "would be recreated from the kept original");
                } else {
                    let bytes = pre.unwrap_or_default();
                    match self.stage(dir, &bytes, e.mode) {
                        Err(m) => self.lost(path, &m),
                        Ok(tmp) => match renameat2(dir, &tmp, &cname, RENAME_NOREPLACE) {
                            Ok(()) => self.ok(path, "recreated from the kept original"),
                            Err(x) => {
                                unsafe { libc::unlinkat(dir, tmp.as_ptr(), 0) };
                                if x.raw_os_error() == Some(libc::EEXIST) {
                                    self.conflict(
                                        path,
                                        "recreated by someone while restoring: left as it is",
                                    );
                                } else {
                                    self.lost(path, &format!("rename-failed:{x}"));
                                }
                            }
                        },
                    }
                }
            }
            (None, Some(s)) => {
                if e.existed && Some(s) == e.sha.as_ref() {
                    self.skip(path, "already as it was");
                } else {
                    self.conflict(
                        path,
                        "it exists again with different content: left as it is",
                    );
                }
            }
            (Some(post), Some(s)) => {
                if e.existed && Some(s) == e.sha.as_ref() && s != post {
                    self.skip(path, "already as it was");
                } else if s != post {
                    self.conflict(
                        path,
                        "changed after Nexus wrote it (by you or a later command): left as it is",
                    );
                } else if self.dry {
                    self.ok(
                        path,
                        if e.existed {
                            "would be put back as it was"
                        } else {
                            "created by Nexus and unchanged; would be removed"
                        },
                    );
                } else if e.existed {
                    self.replace(dir, &cname, path, pre.unwrap_or_default(), e.mode, post);
                } else {
                    self.remove_created(dir, &cname, path, post);
                }
            }
        }
    }

    /// Atomically swap the staged original in; verify what was swapped OUT; undo the swap if it is not what Nexus wrote.
    fn replace(
        &mut self,
        dir: RawFd,
        name: &CString,
        path: &str,
        pre: Vec<u8>,
        mode: Option<u32>,
        post: &str,
    ) {
        let tmp = match self.stage(dir, &pre, mode) {
            Ok(t) => t,
            Err(m) => {
                self.lost(path, &m);
                return;
            }
        };
        if let Err(x) = renameat2(dir, &tmp, name, RENAME_EXCHANGE) {
            unsafe { libc::unlinkat(dir, tmp.as_ptr(), 0) };
            self.lost(path, &format!("exchange-failed:{x}"));
            return;
        }
        // `tmp` now names the file that was at `path`
        if sha_at(dir, &tmp).as_deref() == Some(post) {
            unsafe { libc::unlinkat(dir, tmp.as_ptr(), 0) };
            crate::mutate::crash_point("edit-restore-mid");
            self.ok(path, "put back as it was");
        } else if renameat2(dir, &tmp, name, RENAME_EXCHANGE).is_ok() {
            unsafe { libc::unlinkat(dir, tmp.as_ptr(), 0) };
            self.conflict(path, "changed while restoring: left as it is");
        } else {
            self.lost(path, "changed while restoring and could not be swapped back; the newer version is kept beside it");
        }
    }

    /// Move the file aside, verify it is exactly what Nexus created, then delete it; otherwise move it back.
    fn remove_created(&mut self, dir: RawFd, name: &CString, path: &str, post: &str) {
        let aside = self.temp_name("kept");
        if let Err(x) = renameat2(dir, name, &aside, RENAME_NOREPLACE) {
            self.lost(path, &format!("could-not-move-aside:{x}"));
            return;
        }
        if sha_at(dir, &aside).as_deref() == Some(post) {
            unsafe { libc::unlinkat(dir, aside.as_ptr(), 0) };
            crate::mutate::crash_point("edit-restore-mid");
            self.ok(path, "created by Nexus and unchanged; removed");
        } else if renameat2(dir, &aside, name, RENAME_NOREPLACE).is_ok() {
            self.conflict(path, "changed while restoring: kept");
        } else {
            self.lost(
                path,
                "changed while restoring; kept under a temporary name beside it",
            );
        }
    }
}

/// Preview or apply the restoration of the files this task's edit tools wrote. `ws` is the task's workspace root.
pub fn restore_edits(ws: &Workspace, store: &Store, dry_run: bool) -> EditRestoreReport {
    let entries = match store.entries() {
        Ok(e) => e,
        Err(e) => {
            return EditRestoreReport {
                dry_run,
                outcome: "refused".into(),
                refused: Some(format!("no record of this run's file changes ({})", e.code)),
                note: NOTE.into(),
                ..Default::default()
            }
        }
    };
    let mut c = Ctx {
        ws,
        store,
        dry: dry_run,
        rep: EditRestoreReport {
            dry_run,
            note: NOTE.into(),
            ..Default::default()
        },
        tmp_n: 0,
    };
    // newest-created paths first is irrelevant per file; directories are handled after
    for e in &entries {
        c.entry(e);
    }
    // folders the task created, deepest first, only when empty
    let mut dirs = store.dirs().unwrap_or_default();
    dirs.sort();
    dirs.reverse();
    for d in dirs {
        if crate::protect::workbench_path_check(&d).is_err() {
            continue;
        }
        let (pr, name) = split(&d);
        let Some(par) = observe::open_dir_rel(ws.root_raw_fd(), pr) else {
            continue;
        };
        match observe::rec_at(par.as_raw_fd(), name) {
            Ok(Some(r)) if r.kind == "d" => {
                if dry_run {
                    c.ok(&d, "folder created by Nexus; would be removed if empty");
                } else {
                    let n = CString::new(name).unwrap_or_default();
                    if unsafe { libc::unlinkat(par.as_raw_fd(), n.as_ptr(), libc::AT_REMOVEDIR) }
                        == 0
                    {
                        c.ok(&d, "folder created by Nexus; removed (empty)");
                    } else {
                        c.skip(&d, "folder kept: it still holds files Nexus did not create or that were kept");
                    }
                }
            }
            _ => {}
        }
    }
    let r = &mut c.rep;
    r.outcome =
        if r.restored.is_empty() && (!r.conflicted.is_empty() || !r.unrecoverable.is_empty()) {
            "nothing-restored"
        } else if r.conflicted.is_empty() && r.unrecoverable.is_empty() {
            "completed"
        } else {
            "partial"
        }
        .into();
    if !dry_run && !r.restored.is_empty() {
        unsafe { libc::syncfs(ws.root_raw_fd()) };
    }
    let _ = now_ms();
    c.rep
}
