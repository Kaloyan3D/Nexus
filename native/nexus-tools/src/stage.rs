//! Safe workspace staging (A3.4 Phase 3).
//!
//! The sandbox never sees the real workspace. A *snapshot* is copied into a
//! private host directory using the A3.1 descriptor-relative boundary, with
//! an explicit inclusion policy, and that directory is bind-mounted
//! read-only at `/work/src`. Excluded before copying: hidden/VCS/credential
//! paths (`.git`, `.env*`, keys, ...), dependency/build trees
//! (`node_modules`, `target`, ...), symlinks, hard-linked files, special
//! files and anything on another mount. Size and file counts are bounded.
//! Consistency (exact, deliberately modest guarantee):
//!
//! * **Per file:** the content is read twice through the same descriptor
//!   (`pread` from offset 0) and compared byte for byte, and
//!   `(size, inode, mtime_ns, ctime_ns)` is compared between listing, open,
//!   after the first read and after the second read. A same-size in-place
//!   modification — including one that restores `mtime` — changes `ctime`
//!   and/or the second read, so a **torn or concurrently modified file is
//!   detected and aborts the snapshot** (`snapshot-failed`).
//! * **Across files: NOT atomic.** Files are copied one after another, so
//!   the snapshot is *not* a point-in-time image of the workspace; a writer
//!   can change file B after file A was copied. Only a filesystem-level
//!   snapshot (btrfs/ZFS/LVM) could provide that and none is used. The
//!   snapshot digest identifies exactly what was staged, nothing more.
//! * A modification that completes between the second verification of a
//!   file and process start is, by definition, a later version.

use crate::result::{ToolError, ToolErrorCode};
use crate::workspace::{Kind, NameClass, RelPath, Workspace};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct StageLimits {
    pub max_files: u64,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
    pub max_depth: u32,
    pub max_dirs: u64,
}

impl Default for StageLimits {
    fn default() -> Self {
        Self {
            max_files: 20_000,
            max_bytes: 256 * 1024 * 1024,
            max_file_bytes: 16 * 1024 * 1024,
            max_depth: 32,
            max_dirs: 5_000,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageReport {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub skipped_hidden: u64,
    pub skipped_sensitive: u64,
    pub skipped_ignored: u64,
    pub skipped_symlinks: u64,
    pub skipped_special: u64,
    pub skipped_hardlinks: u64,
    pub skipped_mount_crossing: u64,
    pub skipped_large: u64,
    pub skipped_non_utf8_names: u64,
    /// sha256 over the sorted `(path, content sha256)` list.
    pub digest: String,
    /// What was staged, file by file: `(path, content sha256)`, sorted. Lets the caller tell afterwards
    /// what a command changed in its scratch copy.
    #[serde(skip)]
    pub manifest: Vec<(String, String)>,
    /// Every directory that was staged (workspace-relative, excluding the root).
    #[serde(skip)]
    pub dir_paths: Vec<String>,
}

fn fail(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::SnapshotFailed, msg)
}

/// Copy the permitted workspace content into `dest` (must not exist).
pub fn stage_workspace(
    ws: &Workspace,
    dest: &Path,
    limits: &StageLimits,
    probe: &mut dyn FnMut() -> Result<(), ToolError>,
    observe: &mut dyn FnMut(&str),
) -> Result<StageReport, ToolError> {
    std::fs::create_dir(dest).map_err(|e| fail(format!("cannot create staging dir: {e}")))?;
    let mut rep = StageReport::default();
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut stack: Vec<(RelPath, u32)> = vec![(RelPath::root(), 0)];
    let mut tick = 0u32;
    while let Some((dir, depth)) = stack.pop() {
        probe()?;
        if rep.dirs >= limits.max_dirs {
            return Err(fail("snapshot exceeds the directory-count limit"));
        }
        rep.dirs += 1;
        if !dir.is_root() {
            rep.dir_paths.push(dir.display());
        }
        let opened = ws
            .open_dir(&dir)
            .map_err(|e| fail(format!("snapshot walk failed ({})", e.code.as_str())))?;
        let (raw, overflow) = ws
            .read_dir_names(&opened.fd, 50_000)
            .map_err(|e| fail(format!("snapshot walk failed ({})", e.code.as_str())))?;
        if overflow {
            return Err(fail("a directory exceeds the entry limit"));
        }
        let host_dir = if dir.is_root() {
            dest.to_path_buf()
        } else {
            dest.join(dir.components().join("/"))
        };
        if !dir.is_root() {
            std::fs::create_dir_all(&host_dir).map_err(|e| fail(format!("mkdir failed: {e}")))?;
        }
        let mut names: Vec<(String, Kind, u32, crate::workspace::Identity)> = Vec::new();
        for e in raw {
            let Ok(name) = String::from_utf8(e.name.clone()) else {
                rep.skipped_non_utf8_names += 1;
                continue;
            };
            match ws.policy.classify_name(&name) {
                NameClass::Hidden => {
                    rep.skipped_hidden += 1;
                    continue;
                }
                NameClass::Sensitive => {
                    rep.skipped_sensitive += 1;
                    continue;
                }
                NameClass::Allowed => {}
            }
            let id = ws.stat_entry(&opened.fd, &e.name).map_err(|e| {
                fail(format!(
                    "snapshot changed during staging ({})",
                    e.code.as_str()
                ))
            })?;
            if !ws.same_mount(&id) {
                rep.skipped_mount_crossing += 1;
                continue;
            }
            match id.kind {
                Kind::Symlink => {
                    rep.skipped_symlinks += 1;
                    continue;
                }
                Kind::Special => {
                    rep.skipped_special += 1;
                    continue;
                }
                Kind::Dir if ws.policy.is_ignored_dir(&name) => {
                    rep.skipped_ignored += 1;
                    continue;
                }
                Kind::File if id.nlink > 1 => {
                    rep.skipped_hardlinks += 1;
                    continue;
                }
                Kind::File if id.size > limits.max_file_bytes => {
                    rep.skipped_large += 1;
                    continue;
                }
                _ => {}
            }
            names.push((name, id.kind, id.mode, id));
        }
        names.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut subdirs = Vec::new();
        for (name, kind, mode, listed) in names {
            match kind {
                Kind::Dir => {
                    if depth + 1 > limits.max_depth {
                        return Err(fail("snapshot exceeds the depth limit"));
                    }
                    subdirs.push(dir.join(&name));
                }
                Kind::File => {
                    tick += 1;
                    if tick.is_multiple_of(64) {
                        probe()?;
                    }
                    if rep.files >= limits.max_files {
                        return Err(fail("snapshot exceeds the file-count limit"));
                    }
                    let o = ws
                        .open_file_in_dir(&opened.fd, &name)
                        .map_err(|e| fail(format!("snapshot read failed ({})", e.code.as_str())))?;
                    // Compare against the identity captured at LISTING time, so a
                    // change made after the directory was read is detected.
                    let changed = |what: &str| {
                        fail(format!(
                            "workspace changed during snapshot creation ({}: {what})",
                            dir.join(&name).display()
                        ))
                    };
                    let same = |a: &crate::workspace::Identity, b: &crate::workspace::Identity| {
                        a.size == b.size
                            && a.ino == b.ino
                            && a.dev == b.dev
                            && a.mtime_ns == b.mtime_ns
                            && a.ctime_ns == b.ctime_ns
                    };
                    // Identity at open must equal the listing-time identity.
                    if !same(&listed, &o.identity) {
                        return Err(changed("changed after listing"));
                    }
                    if o.identity.size > limits.max_file_bytes {
                        rep.skipped_large += 1;
                        continue;
                    }
                    let open_id = o.identity;
                    let size = open_id.size;
                    // Pass 1.
                    let mut f = std::fs::File::from(o.fd);
                    let mut buf = Vec::with_capacity(size as usize);
                    (&mut f)
                        .take(limits.max_file_bytes + 1)
                        .read_to_end(&mut buf)
                        .map_err(|e| fail(format!("snapshot read failed: {e}")))?;
                    observe(&dir.join(&name).display());
                    if buf.len() as u64 != size {
                        return Err(changed("size changed while reading"));
                    }
                    // Pass 2 (pread from 0) and byte comparison.
                    use std::os::unix::fs::FileExt;
                    let mut buf2 = vec![0u8; buf.len() + 1];
                    let mut got = 0usize;
                    while got < buf2.len() {
                        match f.read_at(&mut buf2[got..], got as u64) {
                            Ok(0) => break,
                            Ok(n) => got += n,
                            Err(e) => return Err(fail(format!("snapshot re-read failed: {e}"))),
                        }
                    }
                    if got != buf.len() || buf2[..got] != buf[..] {
                        return Err(changed("content differs between reads"));
                    }
                    // Final identity re-check on the same descriptor.
                    let fd_owned = std::os::fd::OwnedFd::from(f);
                    let after = ws.fstat_identity(&fd_owned)?;
                    if !same(&open_id, &after) {
                        return Err(changed("metadata changed during copy"));
                    }
                    rep.bytes += buf.len() as u64;
                    if rep.bytes > limits.max_bytes {
                        return Err(fail("snapshot exceeds the total size limit"));
                    }
                    let host_path = host_dir.join(&name);
                    let mut out = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&host_path)
                        .map_err(|e| fail(format!("stage write failed: {e}")))?;
                    out.write_all(&buf)
                        .map_err(|e| fail(format!("stage write failed: {e}")))?;
                    use std::os::unix::fs::PermissionsExt;
                    let perm = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
                    std::fs::set_permissions(&host_path, std::fs::Permissions::from_mode(perm))
                        .map_err(|e| fail(format!("stage chmod failed: {e}")))?;
                    rep.files += 1;
                    entries.push((dir.join(&name).display(), hex::encode(Sha256::digest(&buf))));
                }
                _ => {}
            }
        }
        for d in subdirs.into_iter().rev() {
            stack.push((d, depth + 1));
        }
    }
    entries.sort();
    let mut h = Sha256::new();
    for (p, s) in &entries {
        h.update(p.as_bytes());
        h.update([0]);
        h.update(s.as_bytes());
        h.update(b"\n");
    }
    rep.digest = hex::encode(h.finalize());
    rep.manifest = entries;
    Ok(rep)
}
