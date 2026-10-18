//! A6.1.3 — operator project registry.
//!
//! A *project* is one operator-authorized Git source: a stable id, the canonical
//! source path, the exact 40-hex commit it must be at, an optional write
//! allowlist and the (fixed, documented) disclosure scope. The registry is one
//! JSON file in an operator-owned directory.
//!
//! Trust boundary. Authority to register or change a project is exactly
//! "being able to write this directory", i.e. the OS identity that owns it.
//! The daemon and the broker only ever READ it, and they refuse a registry whose
//! directory or file is not owned by an identity they were told to trust, is
//! group/world-writable, is a symlink, or is malformed. The file is NOT signed:
//! on a same-UID development instance a signing key held by that same identity
//! would add no independence, so none is pretended. In a multi-UID deployment
//! the registry owner is a distinct operator uid and the daemon/broker run as
//! other uids that can read but not write it.
//!
//! Updates are atomic (temp file, fsync, rename, directory fsync) under an
//! exclusive lock, and every successful update bumps `generation`.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "nexus.project-registry.v1";
pub const FILE_NAME: &str = "projects.json";
const LOCK_NAME: &str = "registry.lock";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_PROJECTS: usize = 64;

/// What leaves the machine when a project is used with a model provider. It is
/// fixed by the product (not operator-editable) so every project shows the same
/// truthful statement.
pub const DISCLOSURE_SCOPE: &str = "Task text, the model's own tool calls and every tool result \
(directory listings, files the model chooses to read, search hits, bounded command output) are \
sent to the model provider. Reads cannot be limited to a path scope: any file in the repository at \
the pinned commit may be read and sent unless it is secret-shaped. Only writes are scoped.";

/// Execution restrictions that apply to EVERY project (fixed by the product; not
/// per-project and not editable through the registry).
pub const EXECUTION_RESTRICTIONS: &[&str] = &[
    "Work happens only in an isolated copy; the original repository is never modified.",
    "Every model-proposed edit and command needs a separate independent approval.",
    "Commands are limited to cargo (check/test/build/fmt), npm (test, run build) and tsc --noEmit.",
    "Commands run in a sandbox with network access disabled and a read-only source snapshot.",
    "No commit, merge, push or deployment is ever performed.",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for RegError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RegError {}
fn err(code: &'static str, m: impl Into<String>) -> RegError {
    RegError {
        code,
        message: m.into(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRecord {
    pub id: String,
    /// Canonical absolute path of the Git working tree (never contains symlinks).
    pub source_path: String,
    /// The exact commit the source must be at (40 lowercase hex).
    pub pinned_commit: String,
    /// Relative path prefixes (`dir/`) or exact files writes may target. Empty = whole project.
    #[serde(default)]
    pub write_allow: Vec<String>,
    /// Client uids (as seen by the broker) that may select this project. Empty =
    /// every uid the broker itself allows. Enforced by the broker.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_uids: Vec<u32>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryFile {
    pub schema: String,
    pub generation: u64,
    pub projects: Vec<ProjectRecord>,
}

impl RegistryFile {
    pub fn empty() -> Self {
        Self {
            schema: SCHEMA.into(),
            generation: 0,
            projects: Vec::new(),
        }
    }
    pub fn get(&self, id: &str) -> Option<&ProjectRecord> {
        self.projects.iter().find(|p| p.id == id)
    }
}

/// Which OS identities may own the registry. Empty = only the caller's euid.
#[derive(Debug, Clone, Default)]
pub struct Trust {
    pub owner_uids: Vec<u32>,
}
impl Trust {
    fn ok(&self, uid: u32) -> bool {
        if self.owner_uids.is_empty() {
            uid == unsafe { libc::geteuid() }
        } else {
            self.owner_uids.contains(&uid)
        }
    }
}

pub fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        && !id.starts_with('.')
}

pub fn valid_commit(c: &str) -> bool {
    c.len() == 40
        && c.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn validate_write_allow(list: &[String]) -> Result<(), RegError> {
    if list.len() > 64 {
        return Err(err("bad-write-allow", "at most 64 write-scope entries"));
    }
    for p in list {
        if p.is_empty()
            || p.len() > 256
            || p.starts_with('/')
            || p.contains("..")
            || p.contains("//")
            || p.contains('\0')
            || p.contains('\\')
            || p == "."
            || p.starts_with(".git")
        {
            return Err(err(
                "bad-write-allow",
                format!("write-scope entry {p:?} must be a plain relative path (no '..', no .git)"),
            ));
        }
    }
    Ok(())
}

/// Structural validation of one record (no filesystem access).
pub fn validate_record(p: &ProjectRecord) -> Result<(), RegError> {
    if !valid_project_id(&p.id) {
        return Err(err("bad-id", format!("project id {:?} is invalid", p.id)));
    }
    if !p.source_path.starts_with('/')
        || p.source_path.contains('\0')
        || p.source_path == "/"
        || p.source_path.split('/').any(|c| c == ".." || c == ".")
    {
        return Err(err(
            "bad-path",
            "source path must be a canonical absolute path",
        ));
    }
    if !valid_commit(&p.pinned_commit) {
        return Err(err(
            "bad-commit",
            "pinned commit must be 40 lowercase hex characters",
        ));
    }
    validate_write_allow(&p.write_allow)
}

fn validate_file(f: &RegistryFile) -> Result<(), RegError> {
    if f.schema != SCHEMA {
        return Err(err("bad-schema", "unknown registry schema"));
    }
    if f.projects.len() > MAX_PROJECTS {
        return Err(err("too-many", "too many projects"));
    }
    let mut seen: Vec<&str> = Vec::new();
    for p in &f.projects {
        validate_record(p)?;
        if seen.contains(&p.id.as_str()) {
            return Err(err(
                "duplicate-id",
                format!("duplicate project id {}", p.id),
            ));
        }
        seen.push(&p.id);
    }
    Ok(())
}

fn check_dir(dir: &Path, trust: &Trust) -> Result<(), RegError> {
    let md = std::fs::symlink_metadata(dir)
        .map_err(|_| err("registry-missing", "registry directory does not exist"))?;
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err(err(
            "registry-untrusted",
            "registry directory must be a real directory",
        ));
    }
    if !trust.ok(md.uid()) {
        return Err(err(
            "registry-untrusted",
            "registry directory is owned by an untrusted identity",
        ));
    }
    if md.mode() & 0o022 != 0 {
        return Err(err(
            "registry-untrusted",
            "registry directory is group/world-writable",
        ));
    }
    Ok(())
}

fn check_file(md: &std::fs::Metadata, trust: &Trust) -> Result<(), RegError> {
    if !md.is_file() {
        return Err(err(
            "registry-untrusted",
            "registry file must be a regular file",
        ));
    }
    if !trust.ok(md.uid()) {
        return Err(err(
            "registry-untrusted",
            "registry file is owned by an untrusted identity",
        ));
    }
    if md.mode() & 0o022 != 0 {
        return Err(err(
            "registry-untrusted",
            "registry file is group/world-writable",
        ));
    }
    if md.nlink() != 1 {
        return Err(err(
            "registry-untrusted",
            "registry file must not be hard-linked",
        ));
    }
    if md.len() > MAX_FILE_BYTES {
        return Err(err("registry-malformed", "registry file is too large"));
    }
    Ok(())
}

/// Read and fully validate the registry. A missing FILE in a trusted directory
/// is an empty registry; a missing or untrusted DIRECTORY is an error.
pub fn load(dir: &Path, trust: &Trust) -> Result<RegistryFile, RegError> {
    check_dir(dir, trust)?;
    let path = dir.join(FILE_NAME);
    let f = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RegistryFile::empty()),
        Err(_) => {
            return Err(err(
                "registry-untrusted",
                "registry file cannot be opened (symlink?)",
            ))
        }
    };
    let md = f
        .metadata()
        .map_err(|_| err("registry-untrusted", "registry file cannot be inspected"))?;
    check_file(&md, trust)?;
    let mut raw = String::new();
    f.take(MAX_FILE_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|_| {
            err(
                "registry-malformed",
                "registry file is not valid UTF-8 text",
            )
        })?;
    let file: RegistryFile = serde_json::from_str(&raw).map_err(|e| {
        err(
            "registry-malformed",
            format!("registry file is malformed: {e}"),
        )
    })?;
    validate_file(&file)?;
    Ok(file)
}

/// Apply one change atomically. Only the identity that owns the directory may
/// call this (a different euid fails closed). Creates the directory (0700) if
/// absent.
pub fn mutate<T>(
    dir: &Path,
    trust: &Trust,
    f: impl FnOnce(&mut RegistryFile) -> Result<T, RegError>,
) -> Result<T, RegError> {
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::io::AsRawFd;
    if std::fs::symlink_metadata(dir).is_err() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| {
                err(
                    "registry-io",
                    format!("cannot create registry directory: {e}"),
                )
            })?;
    }
    check_dir(dir, trust)?;
    let dmd = std::fs::symlink_metadata(dir).map_err(|e| err("registry-io", e.to_string()))?;
    if dmd.uid() != unsafe { libc::geteuid() } {
        return Err(err(
            "not-registry-owner",
            "only the identity that owns the registry directory may change it",
        ));
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join(LOCK_NAME))
        .map_err(|e| err("registry-io", format!("cannot open the registry lock: {e}")))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(err("registry-io", "cannot lock the registry"));
    }
    let mut file = load(dir, trust)?;
    let out = f(&mut file)?;
    file.generation += 1;
    validate_file(&file)?;
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| err("registry-io", e.to_string()))?;
    // The file is group-readable only when the operator made the directory
    // group-readable (to share it with the daemon/broker); never group-writable.
    let file_mode = if dmd.mode() & 0o040 != 0 {
        0o640
    } else {
        0o600
    };
    let tmp = dir.join(format!(".{FILE_NAME}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut t = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .map_err(|e| err("registry-io", format!("cannot write the registry: {e}")))?;
    let res = (|| -> std::io::Result<()> {
        t.write_all(&bytes)?;
        t.sync_all()?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(file_mode))?;
        // keep the directory's group so the readers it was shared with can still read
        // the new file (a no-op unless the operator belongs to that group)
        let _ = std::os::unix::fs::chown(&tmp, None, Some(dmd.gid()));
        std::fs::rename(&tmp, dir.join(FILE_NAME))?;
        std::fs::File::open(dir)?.sync_all()
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(err(
            "registry-io",
            format!("cannot publish the registry: {e}"),
        ));
    }
    Ok(out)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Verify a candidate source is a clean, unambiguous Git working tree and return
/// (canonical path, HEAD commit).
pub fn inspect_source(path: &Path) -> Result<(PathBuf, String), RegError> {
    if !path.is_absolute() {
        return Err(err("bad-path", "source path must be absolute"));
    }
    let canon =
        std::fs::canonicalize(path).map_err(|_| err("bad-path", "source path does not exist"))?;
    if canon == Path::new("/") {
        return Err(err("bad-path", "the filesystem root cannot be a project"));
    }
    let st = crate::gitwt::inspect_source(&canon).map_err(|e| err("bad-source", e.to_string()))?;
    Ok((canon, st.commit))
}

/// Register a project. The source must be clean; it is pinned to its HEAD, which
/// must equal `expect_commit` when the operator supplies one.
pub fn add(
    dir: &Path,
    trust: &Trust,
    id: &str,
    path: &Path,
    expect_commit: Option<&str>,
    write_allow: Vec<String>,
) -> Result<ProjectRecord, RegError> {
    add_with(
        dir,
        trust,
        id,
        path,
        expect_commit,
        write_allow,
        Vec::new(),
        false,
    )
}

/// Path-only check used when the operator cannot run git on the source (a source
/// owned by another identity trips git's ownership protection). The daemon
/// verifies cleanliness and the pin on EVERY task, so nothing is trusted from
/// this shortcut; the commit must be stated explicitly.
fn canonical_dir(path: &Path) -> Result<PathBuf, RegError> {
    if !path.is_absolute() {
        return Err(err("bad-path", "source path must be absolute"));
    }
    let canon =
        std::fs::canonicalize(path).map_err(|_| err("bad-path", "source path does not exist"))?;
    if canon == Path::new("/") {
        return Err(err("bad-path", "the filesystem root cannot be a project"));
    }
    match std::fs::symlink_metadata(canon.join(".git")) {
        Ok(m) if m.file_type().is_dir() => Ok(canon),
        _ => Err(err(
            "bad-source",
            "source is not a Git working tree (.git missing or unreadable)",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn add_with(
    dir: &Path,
    trust: &Trust,
    id: &str,
    path: &Path,
    expect_commit: Option<&str>,
    write_allow: Vec<String>,
    allowed_uids: Vec<u32>,
    defer_verify: bool,
) -> Result<ProjectRecord, RegError> {
    if !valid_project_id(id) {
        return Err(err(
            "bad-id",
            "project id: 1-64 of A-Za-z0-9._:- , not starting with '.'",
        ));
    }
    validate_write_allow(&write_allow)?;
    let (canon, head) = if defer_verify {
        let c = expect_commit.ok_or_else(|| {
            err(
                "bad-commit",
                "--defer-verify needs the commit stated explicitly",
            )
        })?;
        if !valid_commit(c) {
            return Err(err(
                "bad-commit",
                "commit must be 40 lowercase hex characters",
            ));
        }
        (canonical_dir(path)?, c.to_owned())
    } else {
        inspect_source(path)?
    };
    if let Some(c) = expect_commit {
        if !valid_commit(c) {
            return Err(err(
                "bad-commit",
                "commit must be 40 lowercase hex characters",
            ));
        }
        if c != head {
            return Err(err(
                "commit-mismatch",
                format!("the source is at {head}, not {c}; check out the intended commit first"),
            ));
        }
    }
    let rec = ProjectRecord {
        id: id.to_owned(),
        source_path: canon.to_string_lossy().into_owned(),
        pinned_commit: head,
        write_allow,
        allowed_uids,
        created_at_ms: now_ms(),
        updated_at_ms: now_ms(),
    };
    mutate(dir, trust, |f| {
        if f.get(id).is_some() {
            return Err(err("duplicate-id", format!("project {id} already exists")));
        }
        if let Some(o) = f.projects.iter().find(|p| p.source_path == rec.source_path) {
            return Err(err(
                "duplicate-source",
                format!("that source is already registered as {}", o.id),
            ));
        }
        f.projects.push(rec.clone());
        Ok(())
    })?;
    Ok(rec)
}

pub fn remove(dir: &Path, trust: &Trust, id: &str) -> Result<(), RegError> {
    mutate(dir, trust, |f| {
        let n = f.projects.len();
        f.projects.retain(|p| p.id != id);
        if f.projects.len() == n {
            return Err(err("not-found", format!("no project {id}")));
        }
        Ok(())
    })
}

/// Explicit re-pin: the new commit must be given by the operator AND be the
/// source's current clean HEAD. Returns (old, new).
pub fn repin(dir: &Path, trust: &Trust, id: &str, to: &str) -> Result<(String, String), RegError> {
    repin_with(dir, trust, id, to, false)
}

pub fn repin_with(
    dir: &Path,
    trust: &Trust,
    id: &str,
    to: &str,
    defer_verify: bool,
) -> Result<(String, String), RegError> {
    if !valid_commit(to) {
        return Err(err(
            "bad-commit",
            "commit must be 40 lowercase hex characters",
        ));
    }
    let cur = load(dir, trust)?;
    let rec = cur
        .get(id)
        .ok_or_else(|| err("not-found", format!("no project {id}")))?;
    if defer_verify {
        let canon = canonical_dir(Path::new(&rec.source_path))?;
        if canon.to_string_lossy() != rec.source_path {
            return Err(err(
                "source-moved",
                "the registered path now resolves elsewhere",
            ));
        }
    } else {
        let (canon, head) = inspect_source(Path::new(&rec.source_path))?;
        if canon.to_string_lossy() != rec.source_path {
            return Err(err(
                "source-moved",
                "the registered path now resolves elsewhere",
            ));
        }
        if head != to {
            return Err(err(
                "commit-mismatch",
                format!("the source is at {head}, not {to}; check it out first"),
            ));
        }
    }
    mutate(dir, trust, |f| {
        let p = f
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| err("not-found", format!("no project {id}")))?;
        let old = std::mem::replace(&mut p.pinned_commit, to.to_owned());
        p.updated_at_ms = now_ms();
        Ok((old, to.to_owned()))
    })
}

pub fn set_allowed_uids(
    dir: &Path,
    trust: &Trust,
    id: &str,
    uids: Vec<u32>,
) -> Result<(), RegError> {
    mutate(dir, trust, |f| {
        let p = f
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| err("not-found", format!("no project {id}")))?;
        p.allowed_uids = uids;
        p.updated_at_ms = now_ms();
        Ok(())
    })
}

pub fn set_write_allow(
    dir: &Path,
    trust: &Trust,
    id: &str,
    write_allow: Vec<String>,
) -> Result<(), RegError> {
    validate_write_allow(&write_allow)?;
    mutate(dir, trust, |f| {
        let p = f
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| err("not-found", format!("no project {id}")))?;
        p.write_allow = write_allow;
        p.updated_at_ms = now_ms();
        Ok(())
    })
}

/// Resolve a project for use RIGHT NOW (daemon and broker call this per task):
/// the record must exist and its path must still canonicalize to itself, so a
/// path later replaced by a symlink is refused.
pub fn resolve(dir: &Path, trust: &Trust, id: &str) -> Result<ProjectRecord, RegError> {
    let f = load(dir, trust)?;
    let rec = f
        .get(id)
        .cloned()
        .ok_or_else(|| err("unknown-project", "that project is not registered"))?;
    let canon = std::fs::canonicalize(&rec.source_path).map_err(|_| {
        err(
            "source-moved",
            "the registered source path no longer exists",
        )
    })?;
    if canon.to_string_lossy() != rec.source_path {
        return Err(err(
            "source-moved",
            "the registered source path now resolves elsewhere",
        ));
    }
    Ok(rec)
}
