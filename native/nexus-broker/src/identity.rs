//! Build/instance identity for the broker (A5.4).
//!
//! The second live attempt in A5.4 was served by a broker process that
//! predated the fix: `cargo build` replaced the binary on disk, the old
//! process kept running, and a second `start` was (correctly) refused by the
//! single-instance lock without anybody noticing. Identity here is the
//! (device, inode) of the executable file: a rebuild or reinstall always
//! creates a new inode, while the running process keeps the old one, so the
//! comparison needs no hashing, no clock and no trust in the file name.
//!
//! Nothing here signals, kills or otherwise touches another process.

use serde::{Deserialize, Serialize};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const INSTANCE_FILE: &str = "instance.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub pid: u32,
    pub exe: String,
    pub started_at_ms: u64,
}

fn file_id(p: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(p).ok().map(|m| (m.dev(), m.ino()))
}

/// True when the executable behind `link` (e.g. `/proc/<pid>/exe`, which keeps
/// pointing at the ORIGINAL inode even after the path was replaced) is not the
/// file currently installed at `current_path`.
pub fn is_stale(link: &Path, current_path: &Path) -> bool {
    match (file_id(link), file_id(current_path)) {
        (Some(a), Some(b)) => a != b,
        _ => true, // a missing side cannot be proven current
    }
}

fn own_path() -> Option<PathBuf> {
    let p = std::fs::read_link("/proc/self/exe").ok()?;
    let s = p.to_string_lossy();
    Some(PathBuf::from(s.strip_suffix(" (deleted)").unwrap_or(&s)))
}

/// Has THIS process's binary been replaced on disk since it started?
pub fn self_stale() -> bool {
    match own_path() {
        Some(path) => is_stale(Path::new("/proc/self/exe"), &path),
        None => true,
    }
}

pub fn write_instance(state_dir: &Path) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let rec = Instance {
        pid: std::process::id(),
        exe: own_path()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        started_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let tmp = state_dir.join(".instance.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("instance record: {e}"))?;
    f.write_all(
        serde_json::to_string(&rec)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, state_dir.join(INSTANCE_FILE)).map_err(|e| e.to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Running {
    /// No live broker recorded for this state directory.
    None,
    /// A live broker runs exactly the installed binary.
    Current(u32),
    /// A live broker runs a binary that is no longer the installed one.
    Stale(u32),
}

/// Inspect the recorded broker against the binary at `installed`. Pure
/// observation; a recycled pid is excluded by requiring the process to still be
/// a `nexus-broker`.
pub fn running_broker(state_dir: &Path, installed: &Path) -> Running {
    let Ok(raw) = std::fs::read_to_string(state_dir.join(INSTANCE_FILE)) else {
        return Running::None;
    };
    let Ok(rec) = serde_json::from_str::<Instance>(&raw) else {
        return Running::None;
    };
    let proc_dir = PathBuf::from(format!("/proc/{}", rec.pid));
    let Ok(cmd) = std::fs::read(proc_dir.join("cmdline")) else {
        return Running::None;
    };
    let cmd = String::from_utf8_lossy(&cmd);
    let first = cmd.split('\0').next().unwrap_or("");
    if !first.ends_with("nexus-broker") {
        return Running::None;
    }
    if is_stale(&proc_dir.join("exe"), installed) {
        Running::Stale(rec.pid)
    } else {
        Running::Current(rec.pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_the_installed_file_makes_a_running_image_stale() {
        let d = tempfile::tempdir().unwrap();
        let installed = d.path().join("nexus-broker");
        std::fs::write(&installed, b"v1").unwrap();
        // A held-open descriptor models /proc/<pid>/exe: it follows the inode.
        let link = d.path().join("proc-exe");
        std::os::unix::fs::symlink("/proc/self/fd/0", &link).ok();
        let held = std::fs::File::open(&installed).unwrap();
        let fd_path = PathBuf::from(format!(
            "/proc/self/fd/{}",
            std::os::fd::AsRawFd::as_raw_fd(&held)
        ));
        assert!(!is_stale(&fd_path, &installed), "same inode is current");
        // "cargo build": a new file renamed over the path.
        let next = d.path().join("next");
        std::fs::write(&next, b"v2").unwrap();
        std::fs::rename(&next, &installed).unwrap();
        assert!(
            is_stale(&fd_path, &installed),
            "old image vs replaced file is stale"
        );
        // A hard link to the same inode is not stale.
        let hl = d.path().join("hl");
        std::fs::hard_link(&installed, &hl).unwrap();
        assert!(!is_stale(&hl, &installed));
        // Missing files can never be proven current.
        assert!(is_stale(&d.path().join("gone"), &installed));
        assert!(is_stale(&installed, &d.path().join("gone")));
    }

    #[test]
    fn this_test_binary_is_not_stale_and_recorded_instances_resolve() {
        assert!(!self_stale());
        let d = tempfile::tempdir().unwrap();
        assert_eq!(
            running_broker(d.path(), Path::new("/nonexistent")),
            Running::None
        );
        write_instance(d.path()).unwrap();
        // The recorded pid is this test process, which is not named nexus-broker.
        assert_eq!(
            running_broker(d.path(), Path::new("/nonexistent")),
            Running::None
        );
        // Garbage and dead pids are "none", never a panic.
        std::fs::write(d.path().join(INSTANCE_FILE), b"{not json").unwrap();
        assert_eq!(running_broker(d.path(), Path::new("/x")), Running::None);
        let dead = Instance {
            pid: 4_000_000,
            exe: String::new(),
            started_at_ms: 0,
        };
        std::fs::write(
            d.path().join(INSTANCE_FILE),
            serde_json::to_string(&dead).unwrap(),
        )
        .unwrap();
        assert_eq!(running_broker(d.path(), Path::new("/x")), Running::None);
    }
}
