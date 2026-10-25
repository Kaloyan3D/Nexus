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

/// Where a task's edits happen. `Isolated` (the default and the only mode before Direct Workspace): a
/// throw-away clone of the project's snapshot, reviewed and applied afterwards. `Direct`: the project's real
/// folder, edited in place under the same Kernel, approval and write-scope rules. A durable, project-level
/// choice: changing it never alters a task that already started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceMode {
    #[default]
    Isolated,
    Direct,
}

impl WorkspaceMode {
    pub fn is_isolated(&self) -> bool {
        matches!(self, WorkspaceMode::Isolated)
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkspaceMode::Isolated => "isolated",
            WorkspaceMode::Direct => "direct",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "isolated" => Some(WorkspaceMode::Isolated),
            "direct" => Some(WorkspaceMode::Direct),
            _ => None,
        }
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
    /// A6.1.4: display name, origin folder and detected kinds of a project opened from
    /// the Desktop. `managed` projects live in a Nexus-owned snapshot repository whose
    /// current commit is the pin; the origin folder is only ever read.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub managed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub snapshot_origin_dirty: bool,
    /// Autonomy-first: the project policy allows dependency installation (network for the
    /// install forms of package managers, inside the sandbox). Chosen when the project is
    /// opened; changeable in the project's settings.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub installs: bool,
    /// Trusted workspace mode: a finished, verified task's patch is applied to the user's
    /// folder by itself (still all-or-nothing, still refused if the folder changed meanwhile).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trusted: bool,
    /// Direct Workspace: where a NEW task's edits happen (see [`WorkspaceMode`]). Only a managed project
    /// (one opened from the Desktop/CLI, with a known origin folder) can be `Direct`.
    #[serde(default, skip_serializing_if = "WorkspaceMode::is_isolated")]
    pub workspace_mode: WorkspaceMode,
    /// The user's standing grant for this project (see `grant`). Absent = the long-standing defaults.
    /// Written only through [`set_grant`], [`revoke_grant`] and [`clear_grant`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<crate::grant::GrantState>,
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
    if p.workspace_mode == WorkspaceMode::Direct {
        let origin_ok = p.managed
            && p.origin.as_deref().is_some_and(|o| {
                o.starts_with('/')
                    && o != "/"
                    && !o.contains('\0')
                    && !o.split('/').any(|c| c == ".." || c == ".")
            });
        if !origin_ok {
            return Err(err(
                "bad-workspace-mode",
                "only a project opened with a canonical origin folder can use the direct workspace",
            ));
        }
    }
    // A live grant for in-place commands cannot coexist with the direct workspace (not implemented).
    if let Some(g) = &p.grant {
        if g.revoked_at_ms.is_none()
            && g.current.fs == "workspace"
            && p.workspace_mode == WorkspaceMode::Direct
        {
            return Err(err(
                "bad-workspace-mode",
                "this project's permissions allow commands to change the working copy in place, which is not available for the direct workspace; change the permissions first",
            ));
        }
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
        managed: false,
        label: None,
        origin: None,
        kinds: Vec::new(),
        snapshot_fingerprint: None,
        snapshot_origin_dirty: false,
        installs: false,
        trusted: false,
        workspace_mode: WorkspaceMode::Isolated,
        grant: None,
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

/// What the Desktop learned when it opened a project (A6.1.4).
#[derive(Debug, Clone)]
pub struct ManagedMeta {
    pub label: String,
    pub origin: String,
    pub kinds: Vec<String>,
    pub fingerprint: String,
    pub origin_dirty: bool,
    /// Where a NEW project's tasks edit. An existing project keeps its durable choice.
    pub new_mode: WorkspaceMode,
}

/// Register (or re-register) a managed project whose source is a Nexus-owned snapshot
/// repository. The snapshot must verify clean at exactly `commit`.
pub fn upsert_managed(
    dir: &Path,
    trust: &Trust,
    id: &str,
    snapshot_path: &Path,
    commit: &str,
    meta: &ManagedMeta,
    write_allow: Vec<String>,
) -> Result<ProjectRecord, RegError> {
    if !valid_project_id(id) {
        return Err(err("bad-id", "invalid project id"));
    }
    if !valid_commit(commit) {
        return Err(err(
            "bad-commit",
            "commit must be 40 lowercase hex characters",
        ));
    }
    let (canon, head) = inspect_source(snapshot_path)?;
    if head != commit {
        return Err(err(
            "commit-mismatch",
            "the snapshot is not at the stated commit",
        ));
    }
    let mut out: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        let now = now_ms();
        let path = canon.to_string_lossy().into_owned();
        if let Some(o) = f
            .projects
            .iter()
            .find(|p| p.source_path == path && p.id != id)
        {
            return Err(err(
                "duplicate-source",
                format!("that snapshot belongs to {}", o.id),
            ));
        }
        if let Some(p) = f.projects.iter_mut().find(|p| p.id == id) {
            if !p.managed {
                return Err(err(
                    "not-managed",
                    "that project was registered by the operator, not opened from the Desktop",
                ));
            }
            p.source_path = path;
            p.pinned_commit = commit.to_owned();
            p.label = Some(meta.label.clone());
            p.origin = Some(meta.origin.clone());
            p.kinds = meta.kinds.clone();
            p.snapshot_fingerprint = Some(meta.fingerprint.clone());
            p.snapshot_origin_dirty = meta.origin_dirty;
            p.updated_at_ms = now;
            out = Some(p.clone());
        } else {
            let rec = ProjectRecord {
                id: id.to_owned(),
                source_path: path,
                pinned_commit: commit.to_owned(),
                write_allow,
                allowed_uids: Vec::new(),
                managed: true,
                label: Some(meta.label.clone()),
                origin: Some(meta.origin.clone()),
                kinds: meta.kinds.clone(),
                snapshot_fingerprint: Some(meta.fingerprint.clone()),
                snapshot_origin_dirty: meta.origin_dirty,
                installs: true,
                trusted: false,
                workspace_mode: meta.new_mode,
                grant: None,
                created_at_ms: now,
                updated_at_ms: now,
            };
            f.projects.push(rec.clone());
            out = Some(rec);
        }
        Ok(())
    })?;
    out.ok_or_else(|| err("internal", "no record"))
}

/// Change whether a managed project may install dependencies (the project-level policy).
pub fn set_installs(
    dir: &Path,
    trust: &Trust,
    id: &str,
    installs: Option<bool>,
    trusted: Option<bool>,
) -> Result<ProjectRecord, RegError> {
    let mut out: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        match f.projects.iter_mut().find(|p| p.id == id && p.managed) {
            Some(p) => {
                if let Some(i) = installs {
                    p.installs = i;
                }
                if let Some(t) = trusted {
                    p.trusted = t;
                }
                p.updated_at_ms = now_ms();
                out = Some(p.clone());
                Ok(())
            }
            None => Err(err("not-found", format!("no opened project {id}"))),
        }
    })?;
    out.ok_or_else(|| err("internal", "no record"))
}

/// Choose where NEW tasks of a managed project edit (the durable, project-level workspace choice). A task
/// that already started keeps the workspace it started in.
pub fn set_workspace_mode(
    dir: &Path,
    trust: &Trust,
    id: &str,
    mode: WorkspaceMode,
) -> Result<ProjectRecord, RegError> {
    let mut out: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        match f.projects.iter_mut().find(|p| p.id == id && p.managed) {
            Some(p) => {
                p.workspace_mode = mode;
                p.updated_at_ms = now_ms();
                // validated by `mutate` (a Direct project needs its origin folder)
                out = Some(p.clone());
                Ok(())
            }
            None => Err(err("not-found", format!("no opened project {id}"))),
        }
    })?;
    out.ok_or_else(|| err("internal", "no record"))
}

/// Remove a managed project from the registry (the user's folder is untouched).
pub fn remove_managed(dir: &Path, trust: &Trust, id: &str) -> Result<ProjectRecord, RegError> {
    let mut gone: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        match f.projects.iter().position(|p| p.id == id) {
            Some(i) if f.projects[i].managed => {
                gone = Some(f.projects.remove(i));
                Ok(())
            }
            Some(_) => Err(err(
                "not-managed",
                "operator-registered projects are removed by the operator",
            )),
            None => Err(err("not-found", format!("no project {id}"))),
        }
    })?;
    gone.ok_or_else(|| err("internal", "no record"))
}

// ------------------------------------------------------------------ standing grants

const GRANT_AUDIT: &str = "grants.audit.jsonl";

fn grant_err(e: crate::grant::GrantError) -> RegError {
    err(e.code, e.message)
}

/// Append one audit line (before the registry change is published, tagged with the generation it would
/// produce, so a line whose publish failed is recognizable).
fn audit_grant(dir: &Path, line: &serde_json::Value) -> Result<(), RegError> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join(GRANT_AUDIT))
        .map_err(|e| {
            err(
                "registry-io",
                format!("cannot write the grant audit log: {e}"),
            )
        })?;
    let mut text = line.to_string();
    text.push('\n');
    f.write_all(text.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| {
            err(
                "registry-io",
                format!("cannot write the grant audit log: {e}"),
            )
        })
}

fn new_grant_id() -> Result<String, RegError> {
    let mut b = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|e| err("registry-io", format!("no randomness: {e}")))?;
    Ok(format!("grt_{}", hex::encode(b)))
}

/// Create the project's standing grant, or replace it with a new version. `consent_sha256` is the digest
/// of the exact text the user confirmed. Replacing keeps the grant id (the lineage running tasks hold)
/// unless the previous grant was revoked, which starts a new lineage.
pub fn set_grant(
    dir: &Path,
    trust: &Trust,
    id: &str,
    spec: &crate::grant::GrantSpec,
    by: &str,
    consent_sha256: &str,
) -> Result<ProjectRecord, RegError> {
    let mut out: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        let gen_next = f.generation + 1;
        let p = f
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| err("not-found", format!("no project {id}")))?;
        let now = now_ms();
        crate::grant::validate_spec(spec, p.workspace_mode == WorkspaceMode::Direct, now)
            .map_err(grant_err)?;
        let (grant_id, version, kind, history, prev) = match &p.grant {
            Some(st) if st.revoked_at_ms.is_none() => (
                st.current.grant_id.clone(),
                st.current.version + 1,
                "replaced",
                st.history.clone(),
                Some(st.current.digest(id)),
            ),
            Some(st) => (
                new_grant_id()?,
                st.current.version + 1,
                "created",
                st.history.clone(),
                Some(st.current.digest(id)),
            ),
            None => (new_grant_id()?, 1, "created", Vec::new(), None),
        };
        let cur = crate::grant::StandingGrant {
            grant_id,
            version,
            fs: spec.fs.clone(),
            net: spec.net.clone(),
            approval: spec.approval.clone(),
            created_at_ms: now,
            expires_at_ms: spec.expires_at_ms,
            created_by: by.chars().take(64).collect(),
            consent_sha256: consent_sha256.chars().take(64).collect(),
        };
        let digest = cur.digest(id);
        audit_grant(
            dir,
            &serde_json::json!({
                "atMs": now, "generation": gen_next, "projectId": id, "event": kind,
                "grantId": cur.grant_id, "version": cur.version, "digest": digest,
                "previousDigest": prev, "fs": cur.fs, "net": cur.net, "approval": cur.approval,
                "expiresAtMs": cur.expires_at_ms, "by": cur.created_by, "consentSha256": cur.consent_sha256,
            }),
        )?;
        let mut st = crate::grant::GrantState {
            current: cur,
            revoked_at_ms: None,
            revoked_by: None,
            history,
        };
        st.push_event(crate::grant::GrantEvent {
            at_ms: now,
            kind: kind.into(),
            version,
            digest,
            by: by.chars().take(64).collect(),
        });
        p.grant = Some(st);
        p.updated_at_ms = now;
        out = Some(p.clone());
        Ok(())
    })?;
    out.ok_or_else(|| err("internal", "no record"))
}

/// Revoke the project's grant: new tasks are refused and running tasks stop being allowed to act.
pub fn revoke_grant(
    dir: &Path,
    trust: &Trust,
    id: &str,
    by: &str,
) -> Result<ProjectRecord, RegError> {
    let mut out: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        let gen_next = f.generation + 1;
        let p = f
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| err("not-found", format!("no project {id}")))?;
        let now = now_ms();
        let st = p
            .grant
            .as_mut()
            .ok_or_else(|| err("no-grant", "this project has no standing grant"))?;
        if st.revoked_at_ms.is_some() {
            return Err(err("already-revoked", "this grant is already revoked"));
        }
        let digest = st.current.digest(id);
        audit_grant(
            dir,
            &serde_json::json!({
                "atMs": now, "generation": gen_next, "projectId": id, "event": "revoked",
                "grantId": st.current.grant_id, "version": st.current.version, "digest": digest,
                "by": by.chars().take(64).collect::<String>(),
            }),
        )?;
        st.revoked_at_ms = Some(now);
        st.revoked_by = Some(by.chars().take(64).collect());
        let (v, d) = (st.current.version, digest);
        st.push_event(crate::grant::GrantEvent {
            at_ms: now,
            kind: "revoked".into(),
            version: v,
            digest: d,
            by: by.chars().take(64).collect(),
        });
        p.updated_at_ms = now;
        out = Some(p.clone());
        Ok(())
    })?;
    out.ok_or_else(|| err("internal", "no record"))
}

/// Remove the grant entirely (the project returns to the long-standing defaults). A task that holds the
/// removed grant is no longer allowed to act. Audited.
pub fn clear_grant(
    dir: &Path,
    trust: &Trust,
    id: &str,
    by: &str,
) -> Result<ProjectRecord, RegError> {
    let mut out: Option<ProjectRecord> = None;
    mutate(dir, trust, |f| {
        let gen_next = f.generation + 1;
        let p = f
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| err("not-found", format!("no project {id}")))?;
        let st = p
            .grant
            .as_ref()
            .ok_or_else(|| err("no-grant", "this project has no standing grant"))?;
        let now = now_ms();
        audit_grant(
            dir,
            &serde_json::json!({
                "atMs": now, "generation": gen_next, "projectId": id, "event": "cleared",
                "grantId": st.current.grant_id, "version": st.current.version,
                "digest": st.current.digest(id), "by": by.chars().take(64).collect::<String>(),
            }),
        )?;
        p.grant = None;
        p.updated_at_ms = now;
        out = Some(p.clone());
        Ok(())
    })?;
    out.ok_or_else(|| err("internal", "no record"))
}

/// The permissions a NEW task of this project runs under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// No grant: the long-standing defaults apply.
    Legacy,
    /// An active grant.
    Granted(crate::grant::Frozen),
}

/// Resolve the project's permissions for a new task. A grant that is expired or revoked is REJECTED (never
/// replaced by the defaults): the user must renew, replace or clear it.
pub fn resolve_permissions(rec: &ProjectRecord, now_ms: i64) -> Result<Resolved, RegError> {
    use crate::grant::GrantStatus;
    match &rec.grant {
        None => Ok(Resolved::Legacy),
        Some(st) => match st.status(now_ms) {
            GrantStatus::Active => Ok(Resolved::Granted(st.current.frozen(&rec.id))),
            GrantStatus::Expired => Err(err(
                "grant-expired",
                "this project's permissions have expired; renew them (nexus project grant set) or clear them",
            )),
            GrantStatus::Revoked => Err(err(
                "grant-revoked",
                "this project's permissions were revoked; grant them again or clear them",
            )),
        },
    }
}

/// May a task that froze `frozen` still act? Only while its grant lineage is current, not revoked and not
/// expired (by the frozen expiry or a shorter one set later). A newer version of the same lineage never
/// changes what the task may do, and never stops it.
pub fn task_may_act(
    rec: &ProjectRecord,
    frozen: &crate::grant::Frozen,
    now_ms: i64,
) -> Result<(), RegError> {
    use crate::grant::GrantStatus;
    let Some(st) = &rec.grant else {
        return Err(err(
            "grant-withdrawn",
            "the permissions this task was started under were removed",
        ));
    };
    if st.current.grant_id != frozen.grant_id {
        return Err(err(
            "grant-replaced",
            "the permissions this task was started under were replaced by a new grant; start a new task",
        ));
    }
    if st.status(now_ms) == GrantStatus::Revoked {
        return Err(err(
            "grant-revoked",
            "the permissions this task was started under were revoked",
        ));
    }
    let exp = [frozen.expires_at_ms, st.current.expires_at_ms]
        .into_iter()
        .flatten()
        .min();
    if exp.is_some_and(|e| now_ms >= e) {
        return Err(err(
            "grant-expired",
            "the permissions this task was started under have expired",
        ));
    }
    Ok(())
}
