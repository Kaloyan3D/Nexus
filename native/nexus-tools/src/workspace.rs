//! Descriptor-relative workspace read boundary.
//!
//! Security model (Linux/Unix): the authorized root is opened once and its
//! `(dev, ino)` identity pinned. Every access walks the path one component
//! at a time with `fstatat(AT_SYMLINK_NOFOLLOW)` + `openat(O_NOFOLLOW)`
//! relative to the previous directory descriptor, then re-`fstat`s the
//! opened descriptor and requires the same `(dev, ino)` and file type as
//! the pre-open `fstatat`. Consequences:
//!
//! * a symlink in any component is refused (never followed);
//! * a component swapped for a symlink/other object between check and open
//!   is caught by `O_NOFOLLOW` or the post-open identity comparison;
//! * `..` and absolute paths are refused lexically and cannot be expressed
//!   descriptor-relatively anyway;
//! * crossing onto another device (mount point, bind mount of /proc etc.)
//!   is refused;
//! * FIFOs/sockets/devices are classified from `fstatat` before any open
//!   and re-checked after, and are opened `O_NONBLOCK|O_NOCTTY` so even a
//!   lost race cannot block or acquire a controlling terminal.
//!
//! String canonicalization is not part of the security boundary.
//! Residual: a hard link to an out-of-workspace file is indistinguishable
//! from an in-workspace file (documented limitation).

use crate::result::{ToolError, ToolErrorCode};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicU64, Ordering};

pub const POLICY_VERSION: u32 = 1;

pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_COMPONENT_BYTES: usize = 255;
pub const MAX_PATH_DEPTH: usize = 64;

/// Explicit, testable path policy. Fixed at build time; not model-tunable.
#[derive(Debug, Clone)]
pub struct WorkspacePolicy {
    /// Hidden (dot-prefixed) names that are nonetheless readable.
    pub hidden_allowlist: &'static [&'static str],
    /// Names never readable, listed or searched, at any depth.
    pub always_denied_names: &'static [&'static str],
    /// Directory names skipped by search traversal and flagged in listings.
    pub ignored_dirs: &'static [&'static str],
}

impl Default for WorkspacePolicy {
    fn default() -> Self {
        Self {
            hidden_allowlist: &[
                ".gitignore",
                ".gitattributes",
                ".editorconfig",
                ".nvmrc",
                ".node-version",
                ".prettierrc",
                ".rustfmt.toml",
                ".env.example",
                ".env.sample",
                ".env.template",
                ".github",
            ],
            // `.nexus*`, `.ai-harness`: Nexus runtime state, ledgers and
            // dev-instance homes (A5.5): never repository content.
            always_denied_names: &[
                ".git",
                ".ssh",
                ".gnupg",
                ".aws",
                ".kube",
                ".docker",
                ".nexus",
                ".nexus-a54",
                ".ai-harness",
            ],
            ignored_dirs: &[
                "node_modules",
                "target",
                "dist",
                "build",
                "__pycache__",
                ".venv",
                "venv",
                "vendor",
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameClass {
    Allowed,
    Hidden,
    Sensitive,
}

static WORKBENCH_NAMES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Autonomy-first (interactive profile, set once at daemon start): ordinary dotfiles
/// (`.eslintrc`, `.prettierignore`, `.dockerignore`, ...) are readable and writable.
/// Credentials, `.git` and the other always-denied names stay out of reach.
pub fn enable_workbench_names() {
    WORKBENCH_NAMES.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn workbench_names() -> bool {
    WORKBENCH_NAMES.load(std::sync::atomic::Ordering::SeqCst)
}

/// Extensions of source code and documentation (never secret stores themselves).
fn is_source_file_name(lower: &str) -> bool {
    const EXT: [&str; 22] = [
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".go", ".java", ".kt", ".cs",
        ".rb", ".php", ".swift", ".c", ".h", ".cpp", ".md", ".mts", ".cts", ".sh",
    ];
    EXT.iter().any(|e| lower.ends_with(e))
}

impl WorkspacePolicy {
    pub fn is_ignored_dir(&self, name: &str) -> bool {
        self.ignored_dirs.contains(&name)
    }

    /// Classify one path component. Sensitive wins over hidden.
    pub fn classify_name(&self, name: &str) -> NameClass {
        let lower = name.to_ascii_lowercase();
        if self.always_denied_names.contains(&lower.as_str()) {
            return NameClass::Sensitive;
        }
        let allow_listed = self.hidden_allowlist.contains(&lower.as_str());
        if !allow_listed {
            let sensitive_exact = [
                ".netrc",
                ".npmrc",
                ".pypirc",
                ".git-credentials",
                ".pgpass",
                ".htpasswd",
                "kubeconfig",
                "id_rsa",
                "id_dsa",
                "id_ecdsa",
                "id_ed25519",
                "authorized_keys",
                "known_hosts",
                "shadow",
                "secrets.json",
                "secrets.yaml",
                "secrets.yml",
                "secrets.toml",
                "credentials",
                "credentials.json",
                "service-account.json",
            ];
            let sensitive_prefix = [
                "id_rsa",
                "id_dsa",
                "id_ecdsa",
                "id_ed25519",
                ".env",
                // Nexus operator authorization records (A5.4/A5.5).
                "live-authorization",
                "live-session-authorization",
                "route-verification-authorization",
            ];
            let sensitive_suffix = [
                ".pem",
                ".key",
                ".p12",
                ".pfx",
                ".jks",
                ".keystore",
                ".kdbx",
                ".ppk",
                ".gpg",
                ".asc",
                ".crt.key",
                // Issuer/approver/witness capability files.
                ".cap",
            ];
            if sensitive_exact.contains(&lower.as_str())
                || sensitive_prefix.iter().any(|p| lower.starts_with(p))
                || sensitive_suffix.iter().any(|s| lower.ends_with(s))
                // `credentials.json`, `.aws/credentials`: secrets. But source files that merely
                // NAME the concept (`provider-credentials.ts`, `credentials_store.rs`) are code a
                // reviewer must be able to read.
                || (lower.contains("credential") && !is_source_file_name(&lower))
            {
                return NameClass::Sensitive;
            }
        }
        if lower.starts_with('.') && !allow_listed && !workbench_names() {
            return NameClass::Hidden;
        }
        NameClass::Allowed
    }
}

/// A lexically validated workspace-relative path (no I/O performed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelPath {
    comps: Vec<String>,
}

fn pe(msg: &str) -> ToolError {
    ToolError::new(ToolErrorCode::PathInvalid, msg)
}

impl RelPath {
    pub fn root() -> Self {
        Self { comps: Vec::new() }
    }

    pub fn parse(raw: &str) -> Result<Self, ToolError> {
        if raw.len() > MAX_PATH_BYTES {
            return Err(pe("path too long"));
        }
        if raw.contains('\0') {
            return Err(pe("path contains NUL"));
        }
        if raw.starts_with('/') {
            return Err(pe("absolute paths are not permitted"));
        }
        if raw.contains('\\') {
            return Err(pe("backslashes are not permitted"));
        }
        let lower = raw.to_ascii_lowercase();
        for enc in ["%2e", "%2f", "%5c", "%00"] {
            if lower.contains(enc) {
                return Err(pe("percent-encoded path syntax is not permitted"));
            }
        }
        if raw.chars().any(|c| c.is_control()) {
            return Err(pe("control characters are not permitted"));
        }
        let mut comps = Vec::new();
        for (i, c) in raw.split('/').enumerate() {
            if c.is_empty() || c == "." {
                continue;
            }
            if c == ".." {
                return Err(pe("parent traversal is not permitted"));
            }
            if i == 0 && c.starts_with('~') {
                return Err(pe("home expansion is not permitted"));
            }
            if c.len() > MAX_COMPONENT_BYTES {
                return Err(pe("path component too long"));
            }
            comps.push(c.to_owned());
        }
        if comps.len() > MAX_PATH_DEPTH {
            return Err(pe("path too deep"));
        }
        Ok(Self { comps })
    }

    pub fn components(&self) -> &[String] {
        &self.comps
    }

    pub fn is_root(&self) -> bool {
        self.comps.is_empty()
    }

    pub fn join(&self, name: &str) -> Self {
        let mut c = self.comps.clone();
        c.push(name.to_owned());
        Self { comps: c }
    }

    pub fn display(&self) -> String {
        if self.comps.is_empty() {
            ".".to_owned()
        } else {
            self.comps.join("/")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Special,
}

#[derive(Debug, Clone, Copy)]
pub struct Identity {
    pub dev: u64,
    pub ino: u64,
    /// Kernel mount ID (statx `STATX_MNT_ID`). Unlike `st_dev`, this
    /// differs across bind mounts of the same filesystem.
    pub mnt_id: u64,
    pub nlink: u64,
    /// Permission bits (`st_mode & 0o7777`).
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub mtime_ns: i128,
    pub ctime_ns: i128,
    pub kind: Kind,
    pub size: u64,
}

fn kind_of_mode(mode: u32) -> Kind {
    match mode & libc::S_IFMT {
        libc::S_IFREG => Kind::File,
        libc::S_IFDIR => Kind::Dir,
        libc::S_IFLNK => Kind::Symlink,
        _ => Kind::Special,
    }
}

fn io_err(action: &str, errno: i32) -> ToolError {
    ToolError::new(
        ToolErrorCode::IoError,
        format!("{action} failed (errno {errno})"),
    )
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn statx_at(dirfd: RawFd, name: &CString, flags: i32) -> Result<Identity, i32> {
    let mut sx: libc::statx = unsafe { std::mem::zeroed() };
    let mask = libc::STATX_BASIC_STATS | libc::STATX_MNT_ID;
    let rc = unsafe { libc::statx(dirfd, name.as_ptr(), flags, mask, &mut sx) };
    if rc != 0 {
        return Err(last_errno());
    }
    if sx.stx_mask & libc::STATX_MNT_ID == 0 {
        // Kernel without mount-ID support: isolation cannot be proven.
        return Err(libc::ENOTSUP);
    }
    Ok(Identity {
        dev: libc::makedev(sx.stx_dev_major, sx.stx_dev_minor),
        ino: sx.stx_ino,
        mnt_id: sx.stx_mnt_id,
        nlink: sx.stx_nlink as u64,
        mode: sx.stx_mode as u32 & 0o7777,
        uid: sx.stx_uid,
        gid: sx.stx_gid,
        mtime_ns: sx.stx_mtime.tv_sec as i128 * 1_000_000_000 + sx.stx_mtime.tv_nsec as i128,
        ctime_ns: sx.stx_ctime.tv_sec as i128 * 1_000_000_000 + sx.stx_ctime.tv_nsec as i128,
        kind: kind_of_mode(sx.stx_mode as u32),
        size: sx.stx_size,
    })
}

fn fstatat_nofollow(dirfd: RawFd, name: &CString) -> Result<Identity, i32> {
    statx_at(dirfd, name, libc::AT_SYMLINK_NOFOLLOW)
}

fn fstat_fd(fd: RawFd) -> Result<Identity, i32> {
    let empty = CString::new("").expect("static");
    statx_at(fd, &empty, libc::AT_EMPTY_PATH)
}

static OPENAT2_UNAVAILABLE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;

/// Open one component relative to `parent`. Prefers `openat2` so the kernel
/// itself enforces no-symlink / no-magiclink / no-cross-mount / beneath
/// (defense in depth on top of the userspace `statx` checks); falls back to
/// `openat(O_NOFOLLOW)` when `openat2` is unavailable (the userspace mount-ID
/// and identity checks still apply).
fn open_rel(parent: RawFd, name: &CString, flags: i32) -> Result<RawFd, i32> {
    if !OPENAT2_UNAVAILABLE.load(Ordering::Relaxed) {
        let how = OpenHow {
            flags: flags as u64,
            mode: 0,
            resolve: RESOLVE_NO_XDEV
                | RESOLVE_NO_MAGICLINKS
                | RESOLVE_NO_SYMLINKS
                | RESOLVE_BENEATH,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                parent,
                name.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if fd >= 0 {
            return Ok(fd as RawFd);
        }
        let e = last_errno();
        if e != libc::ENOSYS && e != libc::EPERM {
            return Err(e);
        }
        // ENOSYS (old kernel) or EPERM (seccomp): fall back, remember.
        OPENAT2_UNAVAILABLE.store(true, Ordering::Relaxed);
    }
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        Err(last_errno())
    } else {
        Ok(fd)
    }
}

#[derive(Debug)]
pub struct Opened {
    pub fd: OwnedFd,
    pub identity: Identity,
}

/// Raw directory entry as read from a descriptor.
#[derive(Debug, Clone)]
pub struct RawEntry {
    pub name: Vec<u8>,
}

pub struct Workspace {
    root: OwnedFd,
    root_identity: Identity,
    root_path: String,
    pub policy: WorkspacePolicy,
    accesses: AtomicU64,
}

impl std::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace")
            .field("dev", &self.root_identity.dev)
            .field("ino", &self.root_identity.ino)
            .finish()
    }
}

/// Filesystem magic numbers that are never valid workspaces: proc, sysfs,
/// devpts, cgroup(2), debugfs, tracefs, securityfs, selinuxfs, bpf, nsfs, pstore.
const PSEUDO_FS_MAGIC: &[i64] = &[
    0x9fa0,
    0x6265_6572,
    0x1cd1,
    0x0027_e0eb,
    0x6367_7270,
    0x6462_6720,
    0x7472_6163,
    0x7363_6673,
    0xf97c_ff8c,
    0xcafe_4a11,
    0x6e73_6673,
    0x6165_676c,
];

const FORBIDDEN_ROOT_PREFIXES: &[&str] = &["/proc", "/sys", "/dev"];

impl Workspace {
    /// Open the authorized workspace root. Performs `stat`/`open` of the
    /// root directory itself and nothing else. `root` must be absolute, must
    /// not be `/`, `/proc`, `/sys`, `/dev` (or beneath them), and must be a
    /// real directory (the final component may not be a symlink; ancestor
    /// symlinks are resolved by the issuer's canonical path, whose identity
    /// the Kernel then seals).
    pub fn open_root(root: &str, policy: WorkspacePolicy) -> Result<Self, ToolError> {
        let werr = |m: &str| ToolError::new(ToolErrorCode::WorkspaceInvalid, m);
        if !root.starts_with('/') {
            return Err(werr("workspace root must be an absolute path"));
        }
        if root.contains('\0') {
            return Err(werr("workspace root contains NUL"));
        }
        let canon = std::fs::canonicalize(root)
            .map_err(|_| werr("workspace root does not exist or is unreadable"))?;
        let canon_str = canon
            .to_str()
            .ok_or_else(|| werr("workspace root is not valid UTF-8"))?
            .to_owned();
        if canon_str == "/" {
            return Err(werr("the filesystem root is not a valid workspace"));
        }
        for p in FORBIDDEN_ROOT_PREFIXES {
            if canon_str == *p || canon_str.starts_with(&[p, "/"].concat()) {
                return Err(werr("workspace root is in a forbidden system location"));
            }
        }
        let c = CString::new(canon_str.clone()).map_err(|_| werr("workspace root contains NUL"))?;
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(werr("workspace root cannot be opened as a directory"));
        }
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        let identity = fstat_fd(owned.as_raw_fd()).map_err(|e| {
            if e == libc::ENOTSUP {
                werr("kernel lacks mount-ID support (statx STATX_MNT_ID); workspace isolation cannot be proven")
            } else {
                io_err("statx root", e)
            }
        })?;
        let mut sf: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(owned.as_raw_fd(), &mut sf) } != 0 {
            return Err(io_err("fstatfs root", last_errno()));
        }
        if PSEUDO_FS_MAGIC.contains(&(sf.f_type as i64)) {
            return Err(werr("workspace root is on a pseudo or kernel filesystem"));
        }
        if identity.kind != Kind::Dir {
            return Err(werr("workspace root is not a directory"));
        }
        Ok(Self {
            root: owned,
            root_identity: identity,
            root_path: canon_str,
            policy,
            accesses: AtomicU64::new(0),
        })
    }

    /// True when `id` lives on the same device *and* the same mount as the
    /// workspace root (rejects same-device bind mounts).
    pub fn same_mount(&self, id: &Identity) -> bool {
        id.dev == self.root_identity.dev && id.mnt_id == self.root_identity.mnt_id
    }

    pub fn root_dev(&self) -> u64 {
        self.root_identity.dev
    }
    pub fn root_ino(&self) -> u64 {
        self.root_identity.ino
    }
    /// Digest input for sealing: the canonical root path.
    pub fn root_path(&self) -> &str {
        &self.root_path
    }
    /// Number of workspace-content descriptor operations performed.
    pub fn access_count(&self) -> u64 {
        self.accesses.load(Ordering::SeqCst)
    }

    /// Check a name against policy; returns the refusal error if blocked.
    pub fn check_name(&self, name: &str) -> Result<(), ToolError> {
        match self.policy.classify_name(name) {
            NameClass::Allowed => Ok(()),
            NameClass::Hidden => Err(ToolError::new(
                ToolErrorCode::HiddenPathRefused,
                "hidden paths are not permitted by policy",
            )),
            NameClass::Sensitive => Err(ToolError::new(
                ToolErrorCode::SensitivePathRefused,
                "credential or sensitive paths are not permitted by policy",
            )),
        }
    }

    fn open_one(&self, parent: RawFd, name: &str, want_dir: bool) -> Result<Opened, ToolError> {
        let c = CString::new(name).map_err(|_| pe("component contains NUL"))?;
        self.accesses.fetch_add(1, Ordering::SeqCst);
        let pre = match fstatat_nofollow(parent, &c) {
            Ok(i) => i,
            Err(e) if e == libc::ENOENT => {
                return Err(ToolError::new(ToolErrorCode::NotFound, "path not found"))
            }
            Err(e) if e == libc::ENOTDIR => {
                return Err(ToolError::new(
                    ToolErrorCode::NotADirectory,
                    "a path component is not a directory",
                ))
            }
            Err(e) => return Err(io_err("stat", e)),
        };
        match pre.kind {
            Kind::Symlink => {
                return Err(ToolError::new(
                    ToolErrorCode::SymlinkRefused,
                    "symbolic links are never followed",
                ))
            }
            Kind::Special => {
                return Err(ToolError::new(
                    ToolErrorCode::SpecialFileRefused,
                    "device, FIFO, socket and other special files are refused",
                ))
            }
            Kind::File if want_dir => {
                return Err(ToolError::new(
                    ToolErrorCode::NotADirectory,
                    "a path component is not a directory",
                ))
            }
            _ => {}
        }
        if pre.dev != self.root_identity.dev || pre.mnt_id != self.root_identity.mnt_id {
            return Err(ToolError::new(
                ToolErrorCode::MountCrossing,
                "path crosses onto another filesystem or mount",
            ));
        }
        if pre.kind == Kind::File && pre.nlink > 1 {
            return Err(ToolError::new(
                ToolErrorCode::HardlinkRefused,
                "files with multiple hard links are refused (cannot prove they are workspace-local)",
            ));
        }
        let mut flags =
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY;
        if pre.kind == Kind::Dir {
            flags |= libc::O_DIRECTORY;
        }
        let fd = match open_rel(parent, &c, flags) {
            Ok(fd) => fd,
            Err(e) => {
                return Err(match e {
                    x if x == libc::EXDEV => ToolError::new(
                        ToolErrorCode::MountCrossing,
                        "path crosses onto another filesystem or mount",
                    ),
                    x if x == libc::ELOOP => ToolError::new(
                        ToolErrorCode::SymlinkRefused,
                        "path was replaced by a symbolic link",
                    ),
                    x if x == libc::ENOENT => {
                        ToolError::new(ToolErrorCode::RaceDetected, "path vanished during open")
                    }
                    x if x == libc::ENOTDIR => {
                        ToolError::new(ToolErrorCode::RaceDetected, "path type changed during open")
                    }
                    x => io_err("open", x),
                });
            }
        };
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        let post = fstat_fd(owned.as_raw_fd()).map_err(|e| io_err("fstat", e))?;
        if post.dev != pre.dev
            || post.ino != pre.ino
            || post.kind != pre.kind
            || post.mnt_id != pre.mnt_id
            || (post.kind == Kind::File && post.nlink > 1)
        {
            return Err(ToolError::new(
                ToolErrorCode::RaceDetected,
                "path was replaced between check and open",
            ));
        }
        Ok(Opened {
            fd: owned,
            identity: post,
        })
    }

    /// Open a path beneath the root. Intermediate components must be
    /// directories; the final component is returned as whatever regular
    /// file or directory it is (symlinks/specials refused).
    pub fn open_path(&self, rel: &RelPath) -> Result<Opened, ToolError> {
        let mut cur_dup: Option<OwnedFd> = None;
        let n = rel.components().len();
        if n == 0 {
            let fd = unsafe { libc::dup(self.root.as_raw_fd()) };
            if fd < 0 {
                return Err(io_err("dup root", last_errno()));
            }
            self.accesses.fetch_add(1, Ordering::SeqCst);
            return Ok(Opened {
                fd: unsafe { OwnedFd::from_raw_fd(fd) },
                identity: self.root_identity,
            });
        }
        let mut last: Option<Opened> = None;
        for (i, name) in rel.components().iter().enumerate() {
            self.check_name(name)?;
            let parent = match &cur_dup {
                Some(fd) => fd.as_raw_fd(),
                None => self.root.as_raw_fd(),
            };
            let is_last = i + 1 == n;
            let opened = self.open_one(parent, name, !is_last)?;
            if is_last {
                last = Some(opened);
                break;
            }
            cur_dup = Some(opened.fd);
        }
        last.ok_or_else(|| pe("empty path"))
    }

    pub fn open_dir(&self, rel: &RelPath) -> Result<Opened, ToolError> {
        let o = self.open_path(rel)?;
        if o.identity.kind != Kind::Dir {
            return Err(ToolError::new(
                ToolErrorCode::NotADirectory,
                "path is not a directory",
            ));
        }
        Ok(o)
    }

    pub fn open_file(&self, rel: &RelPath) -> Result<Opened, ToolError> {
        let o = self.open_path(rel)?;
        if o.identity.kind != Kind::File {
            return Err(ToolError::new(
                ToolErrorCode::NotAFile,
                "path is not a regular file",
            ));
        }
        Ok(o)
    }

    /// Stat one entry of an open directory without following symlinks.
    pub fn stat_entry(&self, dir: &OwnedFd, name: &[u8]) -> Result<Identity, ToolError> {
        let c = CString::new(name.to_vec()).map_err(|_| pe("name contains NUL"))?;
        self.accesses.fetch_add(1, Ordering::SeqCst);
        fstatat_nofollow(dir.as_raw_fd(), &c).map_err(|e| {
            if e == libc::ENOENT {
                ToolError::new(ToolErrorCode::RaceDetected, "entry vanished during listing")
            } else {
                io_err("stat entry", e)
            }
        })
    }

    /// Read at most `limit + 1` raw names from an open directory. The
    /// extra name signals overflow; `.` and `..` are excluded.
    pub fn read_dir_names(
        &self,
        dir: &OwnedFd,
        limit: usize,
    ) -> Result<(Vec<RawEntry>, bool), ToolError> {
        let dupfd = unsafe { libc::dup(dir.as_raw_fd()) };
        if dupfd < 0 {
            return Err(io_err("dup dir", last_errno()));
        }
        let dirp = unsafe { libc::fdopendir(dupfd) };
        if dirp.is_null() {
            let e = last_errno();
            unsafe { libc::close(dupfd) };
            return Err(io_err("fdopendir", e));
        }
        self.accesses.fetch_add(1, Ordering::SeqCst);
        // The duplicated descriptor shares its file offset with the one it
        // came from (notably the pinned root): always start from the top,
        // or a second listing of the same directory is silently empty.
        unsafe { libc::rewinddir(dirp) };
        let mut out = Vec::new();
        let mut overflow = false;
        loop {
            unsafe { *libc::__errno_location() = 0 };
            let ent = unsafe { libc::readdir(dirp) };
            if ent.is_null() {
                let e = last_errno();
                if e != 0 {
                    unsafe { libc::closedir(dirp) };
                    return Err(io_err("readdir", e));
                }
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*ent).d_name.as_ptr()) }
                .to_bytes()
                .to_vec();
            if name == b"." || name == b".." {
                continue;
            }
            if out.len() >= limit {
                overflow = true;
                break;
            }
            out.push(RawEntry { name });
        }
        unsafe { libc::closedir(dirp) };
        Ok((out, overflow))
    }

    // ---- A3.3 write-side descriptor operations ---------------------------

    /// Write policy is strictly tighter than read policy: *any* hidden,
    /// sensitive or internal component refuses, including the read
    /// allowlist (`.gitignore`, `.github`, ...), `.git` and Nexus' own
    /// temp-file prefix. Directories named like dependency/build trees are
    /// refused too. Applied to every component before any descriptor work.
    pub fn check_write_names(&self, rel: &RelPath) -> Result<(), ToolError> {
        if rel.is_root() {
            return Err(ToolError::new(
                ToolErrorCode::NotAFile,
                "the workspace root is not a writable file",
            ));
        }
        for c in rel.components() {
            if c.starts_with('.') && !workbench_names() {
                return Err(ToolError::new(
                    ToolErrorCode::HiddenPathRefused,
                    "hidden, VCS and internal paths are never writable",
                ));
            }
            if self.policy.classify_name(c) == NameClass::Sensitive {
                return Err(ToolError::new(
                    ToolErrorCode::SensitivePathRefused,
                    "credential or sensitive paths are never writable",
                ));
            }
            if self.policy.is_ignored_dir(c) {
                return Err(ToolError::new(
                    ToolErrorCode::HiddenPathRefused,
                    "dependency and build directories are not writable by tools",
                ));
            }
        }
        Ok(())
    }

    /// Open the (existing) parent directory of a write target by
    /// descriptor. Returns the directory and the final component name.
    pub fn open_parent_for_write(&self, rel: &RelPath) -> Result<(Opened, String), ToolError> {
        self.check_write_names(rel)?;
        let comps = rel.components();
        let (name, parent) = comps.split_last().ok_or_else(|| pe("empty path"))?;
        let parent_rel = RelPath {
            comps: parent.to_vec(),
        };
        let dir = self.open_dir(&parent_rel)?;
        Ok((dir, name.clone()))
    }

    /// `None` when the entry does not exist; otherwise its identity
    /// (no symlink following).
    pub fn stat_in_dir(&self, dir: &OwnedFd, name: &str) -> Result<Option<Identity>, ToolError> {
        let c = CString::new(name).map_err(|_| pe("component contains NUL"))?;
        self.accesses.fetch_add(1, Ordering::SeqCst);
        match fstatat_nofollow(dir.as_raw_fd(), &c) {
            Ok(i) => Ok(Some(i)),
            Err(e) if e == libc::ENOENT => Ok(None),
            Err(e) => Err(io_err("stat", e)),
        }
    }

    /// Open an existing regular file by name relative to an already-open
    /// directory, with the full read-side protections (no symlink, no
    /// mount crossing, hard-link refusal, identity re-check).
    pub fn open_file_in_dir(&self, dir: &OwnedFd, name: &str) -> Result<Opened, ToolError> {
        let o = self.open_one(dir.as_raw_fd(), name, false)?;
        if o.identity.kind != Kind::File {
            return Err(ToolError::new(
                ToolErrorCode::NotAFile,
                "target is not a regular file",
            ));
        }
        Ok(o)
    }

    /// Fresh `statx` of an already-open descriptor (identity, size and
    /// nanosecond mtime/ctime) for before/after consistency checks.
    pub fn fstat_identity(&self, fd: &OwnedFd) -> Result<Identity, ToolError> {
        fstat_fd(fd.as_raw_fd()).map_err(|e| io_err("fstat", e))
    }

    pub fn same_mount_as_root(&self, id: &Identity) -> bool {
        self.same_mount(id)
    }

    pub fn count_access(&self) {
        self.accesses.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod a55_policy_tests {
    use super::*;

    #[test]
    fn nexus_runtime_state_credentials_and_authorizations_are_never_repository_content() {
        let p = WorkspacePolicy::default();
        for n in [
            ".nexus",
            ".NEXUS-A54",
            ".ai-harness",
            ".git",
            ".env",
            ".env.local",
            "id_rsa",
            "server.pem",
            "issuer.cap",
            "approver.cap",
            "credentials.json",
            "provider-credentials.json",
            "live-authorization.json",
            "live-session-authorization.consumed-1.json",
            "route-verification-authorization.json",
            "secrets.yaml",
            ".npmrc",
        ] {
            assert_eq!(p.classify_name(n), NameClass::Sensitive, "{n}");
        }
        // ordinary source whose NAME merely mentions authorization stays readable
        for n in [
            "authorization.rs",
            "authorize.rs",
            "auth.rs",
            "dispatch.rs",
            "README.md",
            "capability.rs",
            // code that is ABOUT credentials is code (found by a real repository review)
            "provider-credentials.ts",
            "credentials_store.rs",
            "CredentialService.cs",
            "credentials.md",
        ] {
            assert_eq!(p.classify_name(n), NameClass::Allowed, "{n}");
        }
    }
}
