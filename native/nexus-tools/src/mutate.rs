//! Descriptor-relative mutation primitives (Linux). No pathname string is
//! ever re-resolved: every operation names an entry relative to an open
//! directory descriptor that was validated by the workspace boundary.
//!
//! Atomicity model (see A3.3-EVIDENCE.md):
//! * create  -> `renameat2(RENAME_NOREPLACE)`: atomic, fails if present.
//! * replace -> temp file + `renameat2(RENAME_EXCHANGE)`: the old inode is
//!   moved to the temp name *atomically with publication*, so the exact
//!   inode that was replaced can be re-hashed. This is a *detect-and-undo*
//!   protocol, NOT an atomic compare-and-swap: the kernel cannot make the
//!   replacement conditional on content. The invariant that holds instead
//!   is **non-destruction**: Nexus only ever unlinks an inode whose
//!   identity it has verified (its own temp, or the verified expected
//!   pre-image); any other inode it displaces is renamed aside, never
//!   deleted.
//!
//! Filesystems that reject these flags are refused, not emulated.

use crate::result::{ToolError, ToolErrorCode};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

pub const RENAME_NOREPLACE: u32 = 1;
pub const RENAME_EXCHANGE: u32 = 2;

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn werr(what: &str, e: i32) -> ToolError {
    ToolError::new(
        ToolErrorCode::WriteFailed,
        format!("{what} failed (errno {e})"),
    )
}

fn cname(n: &str) -> Result<CString, ToolError> {
    CString::new(n).map_err(|_| ToolError::new(ToolErrorCode::PathInvalid, "name contains NUL"))
}

/// Exclusively create a private (0600) temporary file in `dir`.
pub fn create_temp(dir: RawFd, name: &str) -> Result<OwnedFd, ToolError> {
    let c = cname(name)?;
    let fd = unsafe {
        libc::openat(
            dir,
            c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(werr("create temp", errno()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn write_all(fd: RawFd, mut buf: &[u8]) -> Result<(), ToolError> {
    while !buf.is_empty() {
        let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
        if n < 0 {
            let e = errno();
            if e == libc::EINTR {
                continue;
            }
            return Err(werr("write", e));
        }
        if n == 0 {
            return Err(werr("write", libc::EIO));
        }
        buf = &buf[n as usize..];
    }
    Ok(())
}

pub fn fchmod(fd: RawFd, mode: u32) -> Result<(), ToolError> {
    if unsafe { libc::fchmod(fd, mode as libc::mode_t) } != 0 {
        return Err(werr("fchmod", errno()));
    }
    Ok(())
}

pub fn fsync(fd: RawFd) -> Result<(), ToolError> {
    if unsafe { libc::fsync(fd) } != 0 {
        return Err(werr("fsync", errno()));
    }
    Ok(())
}

pub fn unlink(dir: RawFd, name: &str) -> Result<(), ToolError> {
    let c = cname(name)?;
    if unsafe { libc::unlinkat(dir, c.as_ptr(), 0) } != 0 {
        let e = errno();
        if e != libc::ENOENT {
            return Err(werr("unlink", e));
        }
    }
    Ok(())
}

/// Create a private (0700) directory entry and open it. The directory is
/// freshly created (`mkdirat` fails on an existing name), owned by us and
/// verified before use: it is the protected staging area in which temp and
/// displaced files live, so that no directory-writer without access to it
/// can substitute a file under a name Nexus is about to unlink.
pub fn mkdir_private(dir: RawFd, name: &str) -> Result<OwnedFd, ToolError> {
    let c = cname(name)?;
    if unsafe { libc::mkdirat(dir, c.as_ptr(), 0o700) } != 0 {
        return Err(werr("mkdir stage", errno()));
    }
    let fd = unsafe {
        libc::openat(
            dir,
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let e = errno();
        unsafe { libc::unlinkat(dir, c.as_ptr(), libc::AT_REMOVEDIR) };
        return Err(werr("open stage", e));
    }
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    // Enforce mode regardless of umask and verify ownership.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::fchmod(fd, 0o700) } == 0
        && unsafe { libc::fstat(fd, &mut st) } == 0
        && st.st_uid == unsafe { libc::geteuid() }
        && (st.st_mode & 0o777) == 0o700;
    if !ok {
        unsafe { libc::unlinkat(dir, c.as_ptr(), libc::AT_REMOVEDIR) };
        return Err(werr("verify stage", libc::EPERM));
    }
    Ok(owned)
}

/// Remove an (empty) directory entry; `Ok(false)` when it is not empty.
pub fn rmdir(dir: RawFd, name: &str) -> bool {
    match cname(name) {
        Ok(c) => unsafe { libc::unlinkat(dir, c.as_ptr(), libc::AT_REMOVEDIR) == 0 },
        Err(_) => false,
    }
}

/// `renameat2` between two directories (same filesystem).
pub fn renameat2_dirs(
    from_dir: RawFd,
    from: &str,
    to_dir: RawFd,
    to: &str,
    flags: u32,
) -> Result<(), i32> {
    let f = CString::new(from).map_err(|_| libc::EINVAL)?;
    let t = CString::new(to).map_err(|_| libc::EINVAL)?;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            from_dir,
            f.as_ptr(),
            to_dir,
            t.as_ptr(),
            flags as libc::c_uint,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}

/// Raw `renameat2` within one directory. Returns the errno on failure so
/// callers can classify `EEXIST` (conflict) vs `EINVAL/ENOSYS`
/// (unsupported filesystem).
pub fn renameat2(dir: RawFd, from: &str, to: &str, flags: u32) -> Result<(), i32> {
    let f = CString::new(from).map_err(|_| libc::EINVAL)?;
    let t = CString::new(to).map_err(|_| libc::EINVAL)?;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            dir,
            f.as_ptr(),
            dir,
            t.as_ptr(),
            flags as libc::c_uint,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}

/// Test-only deterministic crash points (feature `crash-injection`).
/// Compiled out of production builds entirely.
#[cfg(feature = "crash-injection")]
pub fn crash_point(point: &str) {
    if std::env::var("NEXUS_TEST_WRITE_CRASH_AT").as_deref() == Ok(point) {
        unsafe {
            libc::raise(libc::SIGKILL);
        }
    }
}
#[cfg(not(feature = "crash-injection"))]
#[inline(always)]
pub fn crash_point(_point: &str) {}

/// `(dev, ino)` of an open descriptor.
pub fn fd_identity(fd: RawFd) -> Option<(u64, u64)> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return None;
    }
    Some((st.st_dev as u64, st.st_ino as u64))
}

/// `(dev, ino)` of a directory entry (no symlink following).
pub fn entry_identity(dir: RawFd, name: &str) -> Option<(u64, u64)> {
    let c = CString::new(name).ok()?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::fstatat(dir, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
    if rc != 0 {
        return None;
    }
    Some((st.st_dev as u64, st.st_ino as u64))
}

/// Unlink `name` only if it still refers to exactly the inode `id`.
/// (A residual check-then-unlink window of microseconds remains; it is
/// documented in the evidence and only ever concerns files Nexus created.)
pub fn unlink_if_identity(dir: RawFd, name: &str, id: (u64, u64)) -> Result<bool, ToolError> {
    if entry_identity(dir, name) == Some(id) {
        between_check_and_unlink(name);
        unlink(dir, name)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// Test-only injection point inside the check-then-unlink window
// (feature `crash-injection`; compiled out of production builds).
#[cfg(feature = "crash-injection")]
type UnlinkHook = Box<dyn FnMut(&str)>;

#[cfg(feature = "crash-injection")]
thread_local! {
    static UNLINK_HOOK: std::cell::RefCell<Option<UnlinkHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(feature = "crash-injection")]
pub fn set_between_check_and_unlink(f: Option<UnlinkHook>) {
    UNLINK_HOOK.with(|h| *h.borrow_mut() = f);
}

#[cfg(feature = "crash-injection")]
fn between_check_and_unlink(name: &str) {
    UNLINK_HOOK.with(|h| {
        if let Some(f) = h.borrow_mut().as_mut() {
            f(name);
        }
    });
}

#[cfg(not(feature = "crash-injection"))]
#[inline(always)]
fn between_check_and_unlink(_name: &str) {}

/// Atomically move `from` to `to` only if `to` does not exist.
pub fn rename_aside(dir: RawFd, from: &str, to: &str) -> Result<(), i32> {
    renameat2(dir, from, to, RENAME_NOREPLACE)
}

/// True when the open file carries extended attributes that Nexus would
/// silently drop on replacement (`user.*`, POSIX ACLs, `trusted.*`).
/// `security.*` labels are re-applied by the kernel/LSM on creation and are
/// disclosed as not preserved.
pub fn has_unpreservable_xattrs(fd: RawFd) -> bool {
    let n = unsafe { libc::flistxattr(fd, std::ptr::null_mut(), 0) };
    if n <= 0 {
        return false;
    }
    let mut buf = vec![0u8; n as usize];
    let m = unsafe { libc::flistxattr(fd, buf.as_mut_ptr().cast(), buf.len()) };
    if m <= 0 {
        return true; // cannot prove absence: fail closed
    }
    buf[..m as usize]
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .any(|n| {
            n.starts_with(b"user.")
                || n.starts_with(b"system.posix_acl")
                || n.starts_with(b"trusted.")
        })
}

pub fn fd_of(o: &OwnedFd) -> RawFd {
    o.as_raw_fd()
}
