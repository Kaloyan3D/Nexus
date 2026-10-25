//! Preparing an in-place root (True In-Place Execution, milestone 1).
//!
//! Given the already-verified [`Workspace`] of a task, produce the descriptors and protections the
//! sandbox needs to bind that SAME directory object read-write:
//!
//! * the root descriptor is a duplicate of the one `Workspace::open_root` pinned (`dev`, `ino`, mount id
//!   already recorded) - the path is never consulted again;
//! * mounts below the root are refused (a bind or FUSE mount inside the project could re-export anything);
//! * `.git` stays visible but READ-ONLY (the Isolated task's own git directory is the base of its
//!   reviewable diff and must not be rewritten by a command);
//! * existing top-level entries whose names are secret-shaped (`.env*`, keys, `.ssh`, `.nexus*`, ...) are
//!   hidden. Only entries that EXIST are masked: a mask on an absent name would create it in the project.
//!
//! Known limit (a prerequisite for Direct + network, ADR S3/S6): hiding is top-level only. An Isolated
//! copy is made from a snapshot that already excludes secret-shaped names at every depth, so nothing
//! nested exists to hide; a user's real folder does not have that property.

use crate::exec_contract::ProtectMode;
use crate::result::{ToolError, ToolErrorCode};
use crate::sandbox::Protect;
use crate::workspace::{NameClass, Workspace};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

fn refuse(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::WorkspaceInvalid, msg)
}

/// Descriptors and protections for one in-place execution. Dropping it closes every descriptor.
#[derive(Debug)]
pub struct InPlaceMount {
    root: OwnedFd,
    entries: Vec<(Protect, Option<OwnedFd>)>,
    /// What was hidden/read-only, for the audit record.
    pub summary: serde_json::Value,
}

impl InPlaceMount {
    pub fn root_fd(&self) -> RawFd {
        self.root.as_raw_fd()
    }

    pub fn protect(&self) -> Vec<Protect> {
        self.entries
            .iter()
            .map(|(p, fd)| Protect {
                rel: p.rel.clone(),
                mode: p.mode,
                fd: fd.as_ref().map(|f| f.as_raw_fd()),
                ino: p.ino,
            })
            .collect()
    }
}

/// Mount points strictly below `root`, from a `/proc/self/mountinfo` text.
pub fn mounts_below(mountinfo: &str, root: &str) -> Vec<String> {
    let prefix = format!("{}/", root.trim_end_matches('/'));
    mountinfo
        .lines()
        .filter_map(|l| l.split(' ').nth(4))
        .map(unescape_mountinfo)
        .filter(|m| m.starts_with(&prefix))
        .collect()
}

fn unescape_mountinfo(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 3 < b.len()
            && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c))
        {
            let v = (b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0');
            out.push(v);
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What to do about regular files that have more than one link (their content may also be reachable by a
/// name outside the workspace, which confinement cannot see or stop).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HardLinks {
    /// Default: such files stay READABLE but are mounted read-only for the command, so a write through the
    /// workspace name cannot alter the other name. Nothing is changed in the user's project.
    #[default]
    Protect,
    /// Operator opt-in: the command may write them (the record states that hard-linked files were writable).
    Allow,
}

#[derive(Debug, Clone)]
pub struct PrepareOptions {
    pub hard_links: HardLinks,
    /// Entries examined while looking for protected entries, over the whole tree (dependency directories
    /// included). Beyond it the workspace cannot be verified and the command is refused.
    pub max_entries: u64,
    pub max_ms: u64,
    /// Protected entries (masks and read-only mounts) one execution may carry.
    pub max_protect: usize,
}

impl Default for PrepareOptions {
    fn default() -> Self {
        Self {
            hard_links: HardLinks::Protect,
            max_entries: 2_000_000,
            max_ms: 15_000,
            max_protect: 1024,
        }
    }
}

fn is_bulk(name: &str) -> bool {
    crate::observe::is_bulk_name_pub(name)
}

struct Dir {
    rel: String,
    fd: OwnedFd,
    in_bulk: bool,
}

/// `(name, st_mode, dev, ino, nlink)`
type DirEntryInfo = (Vec<u8>, u32, u64, u64, u64);

fn list_dir(dir: RawFd) -> Option<Vec<DirEntryInfo>> {
    use std::os::unix::ffi::OsStrExt;
    // A FRESH open file description: a duplicate shares the read offset with the original, so a second listing
    // of the same descriptor (the next command in the same workspace) would be empty.
    let dot = CString::new(".").expect("static");
    let dup = unsafe {
        libc::openat(
            dir,
            dot.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if dup < 0 {
        return None;
    }
    let d = unsafe { libc::fdopendir(dup) };
    if d.is_null() {
        unsafe { libc::close(dup) };
        return None;
    }
    let mut out = Vec::new();
    loop {
        let e = unsafe { libc::readdir(d) };
        if e.is_null() {
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*e).d_name.as_ptr()) }
            .to_bytes()
            .to_vec();
        if name == b"." || name == b".." {
            continue;
        }
        let c = CString::new(name.clone()).ok()?;
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(dir, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            continue; // vanished while listing
        }
        out.push((name, st.st_mode, st.st_dev, st.st_ino, st.st_nlink));
    }
    unsafe { libc::closedir(d) };
    let _ = std::ffi::OsStr::from_bytes(b"");
    Some(out)
}

/// Prepare the root of `ws` for an in-place execution. Fails closed.
pub fn prepare(ws: &Workspace) -> Result<InPlaceMount, ToolError> {
    prepare_with(ws, &PrepareOptions::default())
}

pub fn prepare_with(ws: &Workspace, opts: &PrepareOptions) -> Result<InPlaceMount, ToolError> {
    let started = std::time::Instant::now();
    // 1. Own descriptor of the pinned object.
    let dup = unsafe { libc::fcntl(ws.root_raw_fd(), libc::F_DUPFD_CLOEXEC, 100) };
    if dup < 0 {
        return Err(refuse("cannot duplicate the workspace descriptor"));
    }
    let root = unsafe { OwnedFd::from_raw_fd(dup) };
    let root_dev = {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(root.as_raw_fd(), &mut st) } != 0 {
            return Err(refuse("cannot inspect the workspace root"));
        }
        st.st_dev
    };
    // 2. No mounts below the root.
    let mi = std::fs::read_to_string("/proc/self/mountinfo")
        .map_err(|_| refuse("cannot read the mount table; in-place execution refused"))?;
    let below = mounts_below(&mi, ws.root_path());
    if !below.is_empty() {
        return Err(refuse(
            "a mount exists below the workspace root; in-place execution refused (nothing was run)",
        ));
    }
    // 3. Protections, from the directory object itself (never from a path): every depth, no symlink followed.
    let mut entries: Vec<(Protect, Option<OwnedFd>)> = Vec::new();
    let (mut ro, mut hidden, mut hard): (Vec<String>, Vec<String>, Vec<String>) =
        (vec![], vec![], vec![]);
    let (mut sockets, mut examined, mut bulk_hard, mut non_utf8) = (0u64, 0u64, 0u64, 0u64);
    let mut git_nested = 0u64;
    let mut unreadable: Vec<String> = vec![];
    let mut stack = vec![Dir {
        rel: String::new(),
        fd: unsafe {
            OwnedFd::from_raw_fd(libc::fcntl(root.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 100))
        },
        in_bulk: false,
    }];
    while let Some(d) = stack.pop() {
        let Some(list) = list_dir(d.fd.as_raw_fd()) else {
            // A directory this user cannot list cannot be listed by the command either (it runs as the same
            // user), so nothing in it needs masking; it is reported, not hidden.
            unreadable.push(d.rel.clone());
            continue;
        };
        let mut list = list;
        list.sort_by(|a, b| a.0.cmp(&b.0));
        for (raw, mode, dev, ino, nlink) in list {
            examined += 1;
            if examined > opts.max_entries || started.elapsed().as_millis() as u64 > opts.max_ms {
                return Err(refuse(
                    "the workspace is too large to verify its protected entries within the configured budget; in-place execution refused (nothing was run)",
                ));
            }
            let kind = mode & libc::S_IFMT;
            let Ok(name) = String::from_utf8(raw.clone()) else {
                non_utf8 += 1;
                if matches!(
                    kind,
                    libc::S_IFSOCK | libc::S_IFIFO | libc::S_IFCHR | libc::S_IFBLK
                ) {
                    return Err(refuse(
                        "a special file with a non-UTF-8 name cannot be masked; in-place execution refused",
                    ));
                }
                continue;
            };
            let rel = if d.rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", d.rel, name)
            };
            let sensitive = !d.in_bulk && ws.policy.classify_name(&name) == NameClass::Sensitive;
            let cname = CString::new(raw).map_err(|_| refuse("bad entry name"))?;
            let open_path = || -> Option<OwnedFd> {
                let fd = unsafe {
                    libc::openat(
                        d.fd.as_raw_fd(),
                        cname.as_ptr(),
                        libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
            };
            match kind {
                libc::S_IFDIR => {
                    if name == ".git" {
                        let Some(fd) = open_path() else { continue };
                        if !d.rel.is_empty() {
                            git_nested += 1;
                        }
                        ro.push(rel.clone());
                        entries.push((
                            Protect {
                                rel,
                                mode: ProtectMode::ReadOnly,
                                fd: None,
                                ino,
                            },
                            Some(fd),
                        ));
                    } else if sensitive {
                        hidden.push(rel.clone());
                        entries.push((
                            Protect {
                                rel,
                                mode: ProtectMode::HideDir,
                                fd: None,
                                ino: 0,
                            },
                            None,
                        ));
                    } else {
                        if dev != root_dev {
                            return Err(refuse(
                                "a different filesystem is mounted inside the workspace; in-place execution refused",
                            ));
                        }
                        let fd = unsafe {
                            libc::openat(
                                d.fd.as_raw_fd(),
                                cname.as_ptr(),
                                libc::O_RDONLY
                                    | libc::O_DIRECTORY
                                    | libc::O_NOFOLLOW
                                    | libc::O_CLOEXEC,
                            )
                        };
                        if fd < 0 {
                            // not openable by this user: equally closed to the command (same uid)
                            unreadable.push(rel);
                            continue;
                        }
                        stack.push(Dir {
                            in_bulk: d.in_bulk || is_bulk(&name),
                            rel,
                            fd: unsafe { OwnedFd::from_raw_fd(fd) },
                        });
                    }
                }
                libc::S_IFREG => {
                    if name == ".git" {
                        // a linked worktree (or submodule): the file only POINTS at a git directory elsewhere
                        let Some(fd) = open_path() else { continue };
                        if !d.rel.is_empty() {
                            git_nested += 1;
                        }
                        ro.push(rel.clone());
                        entries.push((
                            Protect {
                                rel,
                                mode: ProtectMode::ReadOnly,
                                fd: None,
                                ino,
                            },
                            Some(fd),
                        ));
                    } else if sensitive {
                        hidden.push(rel.clone());
                        entries.push((
                            Protect {
                                rel,
                                mode: ProtectMode::HideFile,
                                fd: None,
                                ino: 0,
                            },
                            None,
                        ));
                    } else if nlink > 1 {
                        if d.in_bulk || opts.hard_links == HardLinks::Allow {
                            bulk_hard += 1;
                        } else if let Some(fd) = open_path() {
                            hard.push(rel.clone());
                            entries.push((
                                Protect {
                                    rel,
                                    mode: ProtectMode::ReadOnly,
                                    fd: None,
                                    ino,
                                },
                                Some(fd),
                            ));
                        }
                    }
                }
                // sockets are an escape primitive (connect() works across the mount namespace); fifos and
                // device nodes are covered for the same reason
                libc::S_IFSOCK | libc::S_IFIFO | libc::S_IFCHR | libc::S_IFBLK => {
                    sockets += 1;
                    hidden.push(rel.clone());
                    entries.push((
                        Protect {
                            rel,
                            mode: ProtectMode::HideFile,
                            fd: None,
                            ino: 0,
                        },
                        None,
                    ));
                }
                // symlinks cannot leave the sandbox (their targets are not mapped) and are never masked:
                // a bind over a symlink would follow it
                _ => {}
            }
            if entries.len() > opts.max_protect {
                return Err(refuse(format!(
                    "more than {} protected entries ({} hard-linked files, {} special files); in-place execution refused (nothing was run)",
                    opts.max_protect,
                    hard.len(),
                    sockets
                )));
            }
        }
    }
    // the top-level `.git` first, as before (stable order for the digest): sort by rel
    entries.sort_by(|a, b| a.0.rel.cmp(&b.0.rel));
    ro.sort();
    hidden.sort();
    hard.sort();
    let git = git_summary(&root);
    Ok(InPlaceMount {
        root,
        entries,
        summary: serde_json::json!({
            "readOnly": ro, "hidden": hidden, "hiddenScan": "recursive",
            "hardLinkedReadOnly": hard, "hardLinks": match opts.hard_links { HardLinks::Protect => "protect", HardLinks::Allow => "allowed-by-operator" },
            "hardLinkedInDependencyDirs": bulk_hard,
            "specialFilesMasked": sockets, "nestedGit": git_nested,
            "entriesExamined": examined, "nonUtf8Skipped": non_utf8, "unreadableDirs": unreadable,
            "git": git,
        }),
    })
}

/// How the top-level `.git` looks. A linked worktree's `.git` is a FILE pointing at a git directory that
/// is outside the workspace: it is shown read-only but its target is NOT mounted (a repository could
/// otherwise name any directory of the host), so git operations that need the target fail closed.
fn git_summary(root: &OwnedFd) -> serde_json::Value {
    let c = CString::new(".git").expect("static");
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            root.as_raw_fd(),
            c.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return serde_json::json!({"kind": "none"});
    }
    match st.st_mode & libc::S_IFMT {
        libc::S_IFDIR => serde_json::json!({"kind": "directory", "metadata": "read-only"}),
        libc::S_IFREG => {
            let fd = unsafe {
                libc::openat(
                    root.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            let mut text = String::new();
            if fd >= 0 {
                use std::io::Read;
                let _ = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) })
                    .take(4096)
                    .read_to_string(&mut text);
            }
            let target = text.strip_prefix("gitdir:").map(|t| t.trim().to_owned());
            serde_json::json!({
                "kind": "linked-worktree-file", "gitdirTarget": target,
                "metadata": "the file is read-only; its target directory is not mounted",
            })
        }
        _ => serde_json::json!({"kind": "other"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mountinfo_parsing_finds_only_mounts_strictly_below_the_root() {
        let mi = "36 1 0:30 / /home/u/proj rw - ext4 /dev/x rw\n\
                  37 36 0:31 / /home/u/proj/sub rw - tmpfs t rw\n\
                  38 1 0:32 / /home/u/project2 rw - tmpfs t rw\n\
                  39 36 0:33 / /home/u/proj/with\\040space rw - tmpfs t rw\n";
        let v = mounts_below(mi, "/home/u/proj");
        assert_eq!(v, ["/home/u/proj/sub", "/home/u/proj/with space"]);
        assert!(mounts_below(mi, "/home/u/other").is_empty());
    }
}
