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

fn openat_path(dir: RawFd, name: &str) -> Option<OwnedFd> {
    let c = CString::new(name).ok()?;
    let fd = unsafe {
        libc::openat(
            dir,
            c.as_ptr(),
            libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
}

fn file_type(fd: RawFd) -> Option<u32> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstat(fd, &mut st) } == 0).then_some(st.st_mode & libc::S_IFMT)
}

/// Prepare the root of `ws` for an in-place execution. Fails closed.
pub fn prepare(ws: &Workspace) -> Result<InPlaceMount, ToolError> {
    // 1. Own descriptor of the pinned object.
    let dup = unsafe { libc::fcntl(ws.root_raw_fd(), libc::F_DUPFD_CLOEXEC, 100) };
    if dup < 0 {
        return Err(refuse("cannot duplicate the workspace descriptor"));
    }
    let root = unsafe { OwnedFd::from_raw_fd(dup) };
    // 2. No mounts below the root.
    let mi = std::fs::read_to_string("/proc/self/mountinfo")
        .map_err(|_| refuse("cannot read the mount table; in-place execution refused"))?;
    let below = mounts_below(&mi, ws.root_path());
    if !below.is_empty() {
        return Err(refuse(
            "a mount exists below the workspace root; in-place execution refused (nothing was run)",
        ));
    }
    // 3. Protections, from the directory object itself (never from a path).
    let mut entries: Vec<(Protect, Option<OwnedFd>)> = Vec::new();
    let mut ro: Vec<String> = Vec::new();
    let mut hidden: Vec<String> = Vec::new();
    if let Some(fd) = openat_path(root.as_raw_fd(), ".git") {
        match file_type(fd.as_raw_fd()) {
            Some(libc::S_IFDIR) | Some(libc::S_IFREG) => {
                entries.push((
                    Protect {
                        rel: ".git".into(),
                        mode: ProtectMode::ReadOnly,
                        fd: None,
                    },
                    Some(fd),
                ));
                ro.push(".git".into());
            }
            _ => {
                return Err(refuse(
                    "`.git` is not a plain directory or file; in-place execution refused",
                ))
            }
        }
    }
    let names = std::fs::read_dir(format!("/proc/self/fd/{}", root.as_raw_fd()))
        .map_err(|_| refuse("cannot list the workspace root"))?;
    let mut sensitive: Vec<String> = Vec::new();
    for e in names.flatten() {
        let Some(n) = e.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if n == ".git" {
            continue;
        }
        if ws.policy.classify_name(&n) == NameClass::Sensitive {
            sensitive.push(n);
        }
    }
    sensitive.sort();
    for n in sensitive {
        let Some(fd) = openat_path(root.as_raw_fd(), &n) else {
            continue;
        };
        let mode = match file_type(fd.as_raw_fd()) {
            Some(libc::S_IFDIR) => ProtectMode::HideDir,
            // regular files, sockets and fifos are covered by an empty file (a socket in the project is
            // otherwise an escape primitive: connect() works across the mount namespace)
            Some(libc::S_IFREG) | Some(libc::S_IFSOCK) | Some(libc::S_IFIFO) => {
                ProtectMode::HideFile
            }
            // symlinks cannot leave the sandbox (their targets are not mapped); devices cannot be
            // created by the snapshot. Not masked: a bind over a symlink would follow it.
            _ => continue,
        };
        hidden.push(n.clone());
        entries.push((
            Protect {
                rel: n,
                mode,
                fd: None,
            },
            None,
        ));
    }
    Ok(InPlaceMount {
        root,
        entries,
        summary: serde_json::json!({ "readOnly": ro, "hidden": hidden, "hiddenScan": "top-level" }),
    })
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
