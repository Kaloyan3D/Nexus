//! Direct Workspace: the trusted pieces behind "edit the project's real folder in place".
//!
//! In a direct task the Kernel workspace binding names the user's folder itself (the same
//! descriptor-relative, no-symlink, no-`..`, same-device boundary of `workspace.rs`; the same
//! atomic, pre-image-guarded, crash-journaled writes of `write.rs`). What an isolated copy gave for
//! free - a baseline to diff against and a way to see what changed - does not exist for a live
//! folder, so this module keeps it explicitly and durably, OUTSIDE the folder:
//!
//! * a **pre-image store** per task: the first time a task touches a path, the exact bytes the
//!   operation was planned over (or "did not exist") are saved, 0600 in a 0700 daemon-private
//!   directory, together with the file mode. First touch wins; later edits never replace it. The
//!   write tool calls this through `WriteHooks::preimage` *before* it journals its intent, and an
//!   error there refuses the operation with nothing mutated: no edit or deletion ever happens
//!   without its original being kept;
//! * the sha of the last post-image Nexus verified for each path, so a later change made OUTSIDE
//!   Nexus is recognised (`external_changes`) and shown, never attributed to the agent;
//! * a **diff** computed from the pre-images and the current files: only paths Nexus touched, so a
//!   dirty tree, untracked user files and non-Git folders are all fine and never swept in.
//!
//! The folder is never modified here and nothing in this module deletes anything inside it.

use crate::workspace::{RelPath, Workspace, WorkspacePolicy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Most distinct paths one task may touch in a direct folder (a bound, not a quota users meet).
pub const MAX_TOUCHED: usize = 4000;
/// Largest pre-image kept per file.
pub const MAX_PRE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_DIFF_BYTES: usize = 256 * 1024;
pub const MAX_DIFF_FILES: usize = 200;
const SCHEMA: &str = "nexus.direct-preimages/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for DirectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for DirectError {}
fn err(code: &'static str, m: impl Into<String>) -> DirectError {
    DirectError {
        code,
        message: m.into(),
    }
}

/// Validate (and canonicalize) the folder a direct task may edit. Fail closed. The caller names a
/// folder only through the trusted project registry; this is the daemon's own independent check.
pub fn validate_root(root: &str, forbidden: &[PathBuf]) -> Result<PathBuf, DirectError> {
    if root.is_empty() || root.len() > 4096 || root.contains('\0') || !root.starts_with('/') {
        return Err(err(
            "scope-refused",
            "a project folder must be an absolute path",
        ));
    }
    let canon = std::fs::canonicalize(root)
        .map_err(|_| err("scope-refused", "the project folder does not exist"))?;
    let md = std::fs::symlink_metadata(&canon)
        .map_err(|_| err("scope-refused", "the project folder cannot be read"))?;
    if !md.is_dir() {
        return Err(err("scope-refused", "a project must be a folder"));
    }
    if md.uid() != unsafe { libc::geteuid() } {
        return Err(err(
            "scope-refused",
            "only a folder owned by the identity running Nexus can be edited directly",
        ));
    }
    if canon.parent().is_none() {
        return Err(err(
            "scope-refused",
            "the filesystem root cannot be a project",
        ));
    }
    for top in [
        "/proc", "/sys", "/dev", "/etc", "/usr", "/boot", "/bin", "/sbin", "/lib", "/lib64",
        "/var", "/run", "/root",
    ] {
        if canon.starts_with(top) {
            return Err(err("scope-refused", "system folders cannot be a project"));
        }
    }
    if let Some(h) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| std::fs::canonicalize(h).ok())
    {
        if canon == h || h.starts_with(&canon) {
            return Err(err(
                "scope-refused",
                "a project must be a project folder, not a whole home folder",
            ));
        }
    }
    for f in forbidden {
        let f = std::fs::canonicalize(f).unwrap_or_else(|_| f.clone());
        if canon.starts_with(&f) || f.starts_with(&canon) {
            return Err(err(
                "scope-refused",
                "that folder overlaps Nexus's own data",
            ));
        }
    }
    Ok(canon)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    /// The file existed when the task first touched it.
    pub existed: bool,
    pub sha: Option<String>,
    pub bytes: u64,
    pub mode: Option<u32>,
    /// Sha of the last post-image Nexus VERIFIED for this path (`None` = the file was deleted or the
    /// operation never completed).
    #[serde(default)]
    pub last_post_sha: Option<String>,
    /// Nexus verified at least one operation on this path.
    #[serde(default)]
    pub applied: bool,
    pub first_touch_ms: u64,
    /// When Nexus last verified an operation on this path (used to tell a tool write from a command's).
    #[serde(default)]
    pub last_post_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: String,
    task: String,
    root: String,
    entries: Vec<Entry>,
    /// Folders this task created (workspace-relative, in creation order).
    #[serde(default)]
    dirs: Vec<String>,
    /// What commands were observed to change in the folder (temporal evidence, no pre-images).
    #[serde(default)]
    observed: Vec<Observed>,
}

/// Cap on remembered command observations per task (oldest dropped, said so in `observedDropped`).
pub const MAX_OBSERVED: usize = 64;
/// Paths remembered per observed command (more are counted by the ledger but not repeated here).
pub const MAX_OBSERVED_PATHS: usize = 2_000;

/// One path a command was observed to change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedPath {
    pub path: String,
    /// `created` | `modified` | `deleted`
    pub kind: String,
    /// sha256 of the post-image when the observer hashed it (absent = not hashed or deleted).
    pub post_sha: Option<String>,
    /// M3B: `available` when the checkpoint holds the original of a modified/deleted file, otherwise
    /// `unavailable:<reason>`; empty for created paths and for records without a checkpoint.
    #[serde(default)]
    pub pre_image: String,
    /// A tool write (fs_write) on this path completed inside the command's window: whose change this is
    /// cannot be told apart.
    pub ambiguous: bool,
}

/// The Direct Workspace's view of one observed command execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub execution_id: String,
    pub command_id: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    /// `observed` | `partial` | `uncertain`
    pub outcome: String,
    /// The lists below name every change (observation complete, nothing truncated).
    pub complete: bool,
    pub paths: Vec<ObservedPath>,
    /// M3B: where the pre-images of this execution are (`<store>`, execution id).
    #[serde(default)]
    pub checkpoint: Option<(String, String)>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path_key(path: &str) -> String {
    hex::encode(Sha256::digest(path.as_bytes()))
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// One task's pre-image store: `<base>/.direct/<task>/{manifest.json,pre/<sha256(path)>}`.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

struct Locked(std::fs::File);
impl Drop for Locked {
    fn drop(&mut self) {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

impl Store {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The store of `task` under `base` (does not create it).
    pub fn at(base: &Path, task: &str) -> Self {
        Self {
            dir: base.join(".direct").join(task),
        }
    }

    pub fn exists(&self) -> bool {
        self.dir.join("manifest.json").is_file()
    }

    /// Create the (empty) store of a task that is about to edit `root`.
    pub fn create(base: &Path, task: &str, root: &str) -> Result<Self, DirectError> {
        let s = Self::at(base, task);
        let io = |e: std::io::Error| err("internal", format!("direct store: {e}"));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(s.dir.join("pre"))
            .map_err(io)?;
        let _g = s.lock()?;
        if s.exists() {
            return Err(err("conflict", "this task already has a direct workspace"));
        }
        s.write_manifest(&Manifest {
            schema: SCHEMA.into(),
            task: task.to_owned(),
            root: root.to_owned(),
            entries: Vec::new(),
            dirs: Vec::new(),
            observed: Vec::new(),
        })?;
        Ok(s)
    }

    fn lock(&self) -> Result<Locked, DirectError> {
        use std::os::unix::io::AsRawFd;
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.dir.join(".lock"))
            .map_err(|e| err("internal", format!("direct store lock: {e}")))?;
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(err("internal", "direct store lock failed"));
        }
        Ok(Locked(f))
    }

    fn read_manifest(&self) -> Result<Manifest, DirectError> {
        let mut raw = String::new();
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.dir.join("manifest.json"))
            .map_err(|_| err("not-found", "no direct workspace record for this task"))?;
        (&mut f)
            .take(8 * 1024 * 1024)
            .read_to_string(&mut raw)
            .map_err(|_| err("corrupt", "the direct workspace record is unreadable"))?;
        let m: Manifest = serde_json::from_str(&raw)
            .map_err(|_| err("corrupt", "the direct workspace record is malformed"))?;
        if m.schema != SCHEMA {
            return Err(err("corrupt", "unknown direct workspace record schema"));
        }
        Ok(m)
    }

    fn write_manifest(&self, m: &Manifest) -> Result<(), DirectError> {
        let io = |e: std::io::Error| err("internal", format!("direct store: {e}"));
        let tmp = self
            .dir
            .join(format!(".manifest.tmp-{}", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .map_err(io)?;
        f.write_all(&serde_json::to_vec(m).map_err(|e| err("internal", e.to_string()))?)
            .map_err(io)?;
        f.sync_all().map_err(io)?;
        std::fs::rename(&tmp, self.dir.join("manifest.json")).map_err(io)?;
        if let Ok(d) = std::fs::File::open(&self.dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    pub fn root(&self) -> Result<String, DirectError> {
        Ok(self.read_manifest()?.root)
    }

    pub fn entries(&self) -> Result<Vec<Entry>, DirectError> {
        let mut e = self.read_manifest()?.entries;
        e.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(e)
    }

    /// Folders this task created, in creation order.
    pub fn dirs(&self) -> Result<Vec<String>, DirectError> {
        Ok(self.read_manifest()?.dirs)
    }

    /// Remember folders the task created (bounded; duplicates ignored).
    pub fn record_dirs(&self, dirs: &[String]) -> Result<(), DirectError> {
        let _g = self.lock()?;
        let mut m = self.read_manifest()?;
        for d in dirs {
            if !m.dirs.contains(d) && m.dirs.len() < MAX_TOUCHED {
                m.dirs.push(d.clone());
            }
        }
        self.write_manifest(&m)
    }

    /// First touch wins: keep the exact pre-image of `path` the first time it is planned over.
    pub fn record_pre(
        &self,
        path: &str,
        pre: Option<&[u8]>,
        mode: Option<u32>,
    ) -> Result<(), DirectError> {
        let _g = self.lock()?;
        let mut m = self.read_manifest()?;
        if m.entries.iter().any(|e| e.path == path) {
            return Ok(());
        }
        if m.entries.len() >= MAX_TOUCHED {
            return Err(err(
                "scope-refused",
                "this task has already changed the most files a direct task may",
            ));
        }
        if let Some(b) = pre {
            if b.len() as u64 > MAX_PRE_BYTES {
                return Err(err(
                    "scope-refused",
                    "the original of this file is too large to keep safely",
                ));
            }
            let io = |e: std::io::Error| err("internal", format!("direct store: {e}"));
            let dest = self.dir.join("pre").join(path_key(path));
            let tmp = self
                .dir
                .join("pre")
                .join(format!(".tmp-{}", std::process::id()));
            let _ = std::fs::remove_file(&tmp);
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&tmp)
                .map_err(io)?;
            f.write_all(b).map_err(io)?;
            f.sync_all().map_err(io)?;
            std::fs::rename(&tmp, &dest).map_err(io)?;
        }
        m.entries.push(Entry {
            path: path.to_owned(),
            existed: pre.is_some(),
            sha: pre.map(sha_hex),
            bytes: pre.map(|b| b.len() as u64).unwrap_or(0),
            mode,
            last_post_sha: None,
            applied: false,
            first_touch_ms: now_ms(),
            last_post_ms: 0,
        });
        self.write_manifest(&m)
    }

    /// Nexus verified an operation on `path`; `post` = sha of its post-image (`None` = deleted).
    pub fn record_post(&self, path: &str, post: Option<&str>) -> Result<(), DirectError> {
        let _g = self.lock()?;
        let mut m = self.read_manifest()?;
        match m.entries.iter_mut().find(|e| e.path == path) {
            Some(e) => {
                e.last_post_sha = post.map(str::to_owned);
                e.applied = true;
                e.last_post_ms = now_ms();
            }
            None => {
                return Err(err(
                    "corrupt",
                    "an operation was verified on an unrecorded path",
                ))
            }
        }
        self.write_manifest(&m)
    }

    /// Remember what an observed in-place command changed in the folder. Idempotent per execution id.
    pub fn record_command_effects(
        &self,
        rec: &crate::observe::EffectsRecord,
    ) -> Result<(), DirectError> {
        self.record_command_effects_in(rec, None)
    }

    /// As `record_command_effects`, remembering where the execution's checkpoint lives so a diff can use
    /// its pre-images.
    pub fn record_command_effects_in(
        &self,
        rec: &crate::observe::EffectsRecord,
        checkpoint_store: Option<&Path>,
    ) -> Result<(), DirectError> {
        let _g = self.lock()?;
        let mut m = self.read_manifest()?;
        if m.observed
            .iter()
            .any(|o| o.execution_id == rec.execution_id)
        {
            return Ok(());
        }
        let fx = &rec.effects;
        let mut paths: Vec<ObservedPath> = Vec::new();
        for (kind, list) in [
            ("created", &fx.created),
            ("modified", &fx.modified),
            ("deleted", &fx.deleted),
        ] {
            for p in &list.paths {
                let ambiguous = m.entries.iter().any(|e| {
                    e.path == *p
                        && e.last_post_ms >= rec.started_ms
                        && e.last_post_ms <= rec.ended_ms
                });
                paths.push(ObservedPath {
                    path: p.clone(),
                    kind: kind.to_owned(),
                    post_sha: fx.post_sha256.get(p).cloned(),
                    pre_image: rec
                        .recoverability
                        .as_ref()
                        .and_then(|r| r.pre_images.get(p).cloned())
                        .unwrap_or_default(),
                    ambiguous,
                });
            }
        }
        let complete = rec.outcome == "observed"
            && !fx.lists_may_be_incomplete
            && fx.created.count + fx.modified.count + fx.deleted.count == paths.len() as u64
            && paths.len() <= MAX_OBSERVED_PATHS
            // changes inside summarised dependency/build folders are counted, not listed
            && fx.bulk_changed.is_empty();
        paths.truncate(MAX_OBSERVED_PATHS);
        m.observed.push(Observed {
            execution_id: rec.execution_id.clone(),
            command_id: rec.command_id.clone(),
            started_ms: rec.started_ms,
            ended_ms: rec.ended_ms,
            outcome: rec.outcome.clone(),
            complete,
            paths,
            checkpoint: checkpoint_store.and_then(|s| {
                rec.checkpoint
                    .as_ref()
                    .and_then(|c| c.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|id| (s.to_string_lossy().into_owned(), id.to_owned()))
            }),
        });
        let over = m.observed.len().saturating_sub(MAX_OBSERVED);
        if over > 0 {
            m.observed.drain(..over);
        }
        self.write_manifest(&m)
    }

    /// Command observations, oldest first.
    pub fn observed(&self) -> Result<Vec<Observed>, DirectError> {
        Ok(self.read_manifest()?.observed)
    }

    pub(crate) fn read_pre(&self, e: &Entry) -> Option<Vec<u8>> {
        if !e.existed {
            return None;
        }
        let mut b = Vec::new();
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.dir.join("pre").join(path_key(&e.path)))
            .ok()?
            .take(MAX_PRE_BYTES + 1)
            .read_to_end(&mut b)
            .ok()?;
        Some(b)
    }

    /// Remove the task's store (never anything in the project folder).
    pub fn remove(&self) -> Result<(), DirectError> {
        match std::fs::remove_dir_all(&self.dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err("internal", format!("direct store: {e}"))),
        }
    }
}

/// Retention: remove the kept originals of direct tasks that ended long ago (their record too). Only
/// daemon-private data under `<base>/.direct` and `<base>/.meta` is ever touched, never a project folder.
/// Returns how many tasks were swept.
pub fn sweep_old(base: &Path, max_age: std::time::Duration) -> usize {
    let Ok(rd) = std::fs::read_dir(base.join(".direct")) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !crate::gitwt::valid_task_id(&name) {
            continue;
        }
        let manifest = e.path().join("manifest.json");
        let age = std::fs::symlink_metadata(&manifest)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok());
        if age.is_some_and(|a| a >= max_age) {
            let meta = base.join(".meta").join(format!("{name}.json"));
            // only a record that says it is a direct task is removed along with its store
            let is_direct = std::fs::read_to_string(&meta)
                .ok()
                .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
                .is_some_and(|m| m.get("kind").and_then(|k| k.as_str()) == Some("direct"));
            if std::fs::remove_dir_all(e.path()).is_ok() {
                if is_direct {
                    let _ = std::fs::remove_file(&meta);
                }
                n += 1;
            }
        }
    }
    n
}

/// The current bytes of `path` in the folder, read through the descriptor-relative boundary
/// (`Ok(None)` = absent; a symlink or special file is an error, never followed).
fn read_current(ws: &Workspace, path: &str) -> Result<Option<Vec<u8>>, DirectError> {
    let rel = RelPath::parse(path).map_err(|e| err("bad-path", e.message))?;
    match ws.open_file(&rel) {
        Ok(o) => {
            let mut b = Vec::new();
            std::fs::File::from(o.fd)
                .take(MAX_PRE_BYTES + 1)
                .read_to_end(&mut b)
                .map_err(|_| err("io", "the file could not be read"))?;
            Ok(Some(b))
        }
        Err(e) if e.code == crate::result::ToolErrorCode::NotFound => Ok(None),
        Err(e) => Err(err("unreadable", e.message)),
    }
}

/// The latest command observation of each path (with when it ended).
fn latest_observed(
    store: &Store,
) -> Result<std::collections::BTreeMap<String, (ObservedPath, u64)>, DirectError> {
    let mut m = std::collections::BTreeMap::new();
    for o in store.observed()? {
        for p in o.paths {
            m.insert(p.path.clone(), (p, o.ended_ms));
        }
    }
    Ok(m)
}

/// What a tool-written path is expected to contain NOW.
enum Expected {
    Absent,
    Sha(String),
    /// a command left it unhashed: nothing to compare against, never flagged
    Unknown,
}

/// The content Nexus's tool last wrote, unless a COMMAND changed the path later - then what that command left
/// (a command's edit is not the user's).
fn expected_of(
    e: &Entry,
    obs: &std::collections::BTreeMap<String, (ObservedPath, u64)>,
) -> Expected {
    if let Some((o, ended)) = obs.get(&e.path) {
        if *ended >= e.last_post_ms {
            return if o.kind == "deleted" {
                Expected::Absent
            } else {
                match &o.post_sha {
                    Some(s) => Expected::Sha(s.clone()),
                    None => Expected::Unknown,
                }
            };
        }
    }
    match &e.last_post_sha {
        Some(s) => Expected::Sha(s.clone()),
        None => Expected::Absent,
    }
}

fn deviates(exp: &Expected, cur: Option<&str>) -> bool {
    match exp {
        Expected::Absent => cur.is_some(),
        Expected::Sha(s) => cur != Some(s.as_str()),
        Expected::Unknown => false,
    }
}

/// Paths this task wrote (verified) whose content is not what Nexus last wrote: something else
/// changed them afterwards. A file Nexus deleted that exists again counts too.
pub fn external_changes(store: &Store, root: &str) -> Result<Vec<String>, DirectError> {
    let ws = Workspace::open_root(root, WorkspacePolicy::default())
        .map_err(|e| err("scope-refused", e.message))?;
    let mut out = Vec::new();
    let obs = latest_observed(store)?;
    for e in store.entries()? {
        if !e.applied {
            continue;
        }
        let cur = read_current(&ws, &e.path)
            .ok()
            .flatten()
            .map(|b| sha_hex(&b));
        if deviates(&expected_of(&e, &obs), cur.as_deref()) {
            out.push(e.path);
        }
    }
    // Paths only a command changed: what the command left is the expected state; a later difference
    // (a user edit after the command) is an outside change. The latest observation of a path wins.
    let known: std::collections::HashSet<String> =
        store.entries()?.into_iter().map(|e| e.path).collect();
    let mut latest: std::collections::BTreeMap<String, ObservedPath> = Default::default();
    for o in store.observed()? {
        for p in o.paths {
            latest.insert(p.path.clone(), p);
        }
    }
    for (path, o) in latest {
        if known.contains(&path) {
            continue;
        }
        let cur = read_current(&ws, &path).ok().flatten();
        let changed = match (o.kind.as_str(), &o.post_sha, &cur) {
            ("deleted", _, Some(_)) => true,
            ("deleted", _, None) => false,
            (_, _, None) => true,
            (_, Some(sha), Some(b)) => &sha_hex(b) != sha,
            // not hashed (too large, secret-shaped): nothing to compare against
            (_, None, Some(_)) => false,
        };
        if changed {
            out.push(path);
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// `added` | `modified` | `deleted`
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    /// The file changed after Nexus's last verified write (someone else edited it).
    pub external_change: bool,
    /// `tool` (Nexus recorded a pre-image) | `command` (observed after a command ran; no pre-image)
    pub origin: String,
    /// `exact` for tool writes; for commands `temporal` or `ambiguous` (see the observer's note)
    pub attribution: String,
    /// The diff text for this file is against a recorded pre-image. False for command-origin
    /// modifications and deletions: only the fact of the change is known.
    pub pre_image: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectDiff {
    pub files: Vec<FileDiff>,
    pub files_truncated: bool,
    pub diff: String,
    pub diff_digest: String,
    pub diff_truncated: bool,
    /// Folders the task created that exist now.
    pub created_dirs: Vec<String>,
    /// Changes made by commands that cannot be shown as a diff (no pre-image), and how reliable the
    /// command evidence is. Empty when no command ran in place.
    pub command_evidence: CommandEvidence,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEvidence {
    pub executions: u64,
    /// Some observation was partial, uncertain, truncated, or ambiguous: the list may be incomplete.
    pub incomplete: bool,
    pub note: String,
}

/// What this task changed: pre-image vs the current file, for the paths it touched only.
pub fn diff(store: &Store, root: &str) -> Result<DirectDiff, DirectError> {
    let ws = Workspace::open_root(root, WorkspacePolicy::default())
        .map_err(|e| err("scope-refused", e.message))?;
    let io = |e: std::io::Error| err("internal", format!("direct diff: {e}"));
    let tmp = tempdir_in(store.dir())?;
    let (a_dir, b_dir) = (tmp.join("a"), tmp.join("b"));
    std::fs::create_dir_all(&a_dir).map_err(io)?;
    std::fs::create_dir_all(&b_dir).map_err(io)?;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(tmp.clone());
    let mut files = Vec::new();
    let mut changed_paths = Vec::new();
    let obs_all = latest_observed(store)?;
    for e in store.entries()? {
        let pre = store.read_pre(&e);
        let cur = read_current(&ws, &e.path).unwrap_or(None);
        if pre == cur {
            continue; // touched but identical (an edit that was reverted, a refused operation)
        }
        let external = e.applied
            && deviates(
                &expected_of(&e, &obs_all),
                cur.as_deref().map(sha_hex).as_deref(),
            );
        let status = match (&pre, &cur) {
            (None, Some(_)) => "added",
            (Some(_), None) => "deleted",
            _ => "modified",
        };
        for (dir, content) in [(&a_dir, &pre), (&b_dir, &cur)] {
            if let Some(bytes) = content {
                let p = dir.join(&e.path);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).map_err(io)?;
                }
                std::fs::write(&p, bytes).map_err(io)?;
            }
        }
        files.push(FileDiff {
            path: e.path.clone(),
            status: status.to_owned(),
            additions: None,
            deletions: None,
            external_change: external,
            origin: "tool".into(),
            attribution: "exact".into(),
            pre_image: true,
        });
        changed_paths.push(e.path);
    }
    // Paths only a command changed.
    let known: std::collections::HashSet<String> = files.iter().map(|f| f.path.clone()).collect();
    let all_known: std::collections::HashSet<String> =
        store.entries()?.into_iter().map(|e| e.path).collect();
    let observed = store.observed()?;
    let mut evidence = CommandEvidence {
        executions: observed.len() as u64,
        ..Default::default()
    };
    type Latest =
        std::collections::BTreeMap<String, (ObservedPath, bool, Option<(String, String)>)>;
    let mut latest: Latest = Default::default();
    for o in &observed {
        if !o.complete {
            evidence.incomplete = true;
        }
        for p in &o.paths {
            if p.ambiguous {
                evidence.incomplete = true;
            }
            latest.insert(
                p.path.clone(),
                (p.clone(), o.complete, o.checkpoint.clone()),
            );
        }
    }
    for (path, (o, complete, ck)) in latest {
        if known.contains(&path) || all_known.contains(&path) {
            continue;
        }
        let cur = read_current(&ws, &path).unwrap_or(None);
        let (status, with_pre) = match (o.kind.as_str(), &cur) {
            ("created", Some(_)) => ("added", true),
            ("deleted", None) => ("deleted", false),
            (_, Some(_)) => ("modified", false),
            // created then removed, or modified then removed: report what is true now
            (_, None) => ("deleted", false),
        };
        if o.ambiguous {
            evidence.incomplete = true;
        }
        let external = match (&o.post_sha, &cur) {
            (Some(sha), Some(b)) => &sha_hex(b) != sha,
            _ => false,
        };
        // M3B: a modification or deletion is diffable when the checkpoint holds the original.
        let stored = if !with_pre && o.pre_image == "available" {
            ck.as_ref().and_then(|(s, id)| {
                crate::checkpoint::read_preimage(Path::new(s), id, &path, MAX_PRE_BYTES)
                    .ok()
                    .flatten()
            })
        } else {
            None
        };
        let with_pre = with_pre || stored.is_some();
        if with_pre {
            for (dir, content) in [(&a_dir, &stored), (&b_dir, &cur)] {
                if let Some(bytes) = content {
                    let p = dir.join(&path);
                    if let Some(parent) = p.parent() {
                        std::fs::create_dir_all(parent).map_err(io)?;
                    }
                    std::fs::write(&p, bytes).map_err(io)?;
                }
            }
        }
        files.push(FileDiff {
            path: path.clone(),
            status: status.to_owned(),
            additions: None,
            deletions: None,
            external_change: external,
            origin: "command".into(),
            attribution: if o.ambiguous || !complete {
                "ambiguous".into()
            } else {
                "temporal".into()
            },
            // a created file is shown whole against nothing, which is exact; the rest cannot be
            pre_image: with_pre,
        });
        if with_pre {
            changed_paths.push(path);
        }
    }
    if evidence.executions > 0 {
        evidence.note = crate::observe::ATTRIBUTION_NOTE.into();
    }
    let _ = &changed_paths;
    let files_truncated = files.len() > MAX_DIFF_FILES;
    files.truncate(MAX_DIFF_FILES);
    let created_dirs: Vec<String> = store
        .dirs()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| {
            std::fs::symlink_metadata(Path::new(root).join(d))
                .map(|m| m.is_dir())
                .unwrap_or(false)
        })
        .collect();
    if files.is_empty() {
        return Ok(DirectDiff {
            files,
            files_truncated: false,
            diff: String::new(),
            diff_digest: sha_hex(b""),
            diff_truncated: false,
            created_dirs,
            command_evidence: evidence,
        });
    }
    let (status, out) = crate::gitwt::run_git(
        &tmp,
        &[
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-prefix",
            "--",
            "a",
            "b",
        ],
    )
    .map_err(|e| err("git-failed", e.message))?;
    // `git diff --no-index` exits 1 when the trees differ
    if status != 0 && status != 1 {
        return Err(err("git-failed", "git diff failed"));
    }
    let raw = String::from_utf8_lossy(&out).into_owned();
    // `git diff --no-index a b` names the two sides by their directories; normalise every section
    // header to the usual `a/<path> b/<path>` and count each file's changed lines.
    let mut text = String::new();
    let mut sections: Vec<&str> = Vec::new();
    {
        let mut start = 0usize;
        let bytes = raw.as_bytes();
        let marker = b"diff --git ";
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i..].starts_with(marker) && (i == 0 || bytes[i - 1] == b'\n') {
                if i > start {
                    sections.push(&raw[start..i]);
                }
                start = i;
            }
            i += 1;
        }
        if start < raw.len() {
            sections.push(&raw[start..]);
        }
    }
    for sec in sections {
        let head = sec.lines().next().unwrap_or("");
        let head = head.strip_prefix("diff --git ").unwrap_or(head);
        let matched = files.iter().position(|f| {
            let p = &f.path;
            [
                format!("a/{p} a/{p}"),
                format!("a/{p} b/{p}"),
                format!("b/{p} b/{p}"),
            ]
            .iter()
            .any(|h| h == head)
        });
        let (mut adds, mut dels, mut binary, mut in_hunk) = (0u64, 0u64, false, false);
        for l in sec.lines() {
            if l.starts_with("@@") {
                in_hunk = true;
            } else if l.starts_with("Binary files") || l.starts_with("GIT binary patch") {
                binary = true;
            } else if in_hunk {
                if l.starts_with('+') {
                    adds += 1;
                } else if l.starts_with('-') {
                    dels += 1;
                }
            }
        }
        match matched {
            Some(i) => {
                let p = files[i].path.clone();
                if !binary {
                    files[i].additions = Some(adds);
                    files[i].deletions = Some(dels);
                }
                text.push_str(&format!("diff --git a/{p} b/{p}\n"));
                text.push_str(sec.split_once('\n').map(|x| x.1).unwrap_or(""));
            }
            None => text.push_str(sec),
        }
    }
    let mut diff_truncated = false;
    if text.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        diff_truncated = true;
    }
    let diff_digest = sha_hex(text.as_bytes());
    Ok(DirectDiff {
        files,
        files_truncated,
        diff: text,
        diff_digest,
        diff_truncated,
        created_dirs,
        command_evidence: evidence,
    })
}

fn tempdir_in(base: &Path) -> Result<PathBuf, DirectError> {
    let p = base.join(format!("diff-{}-{}", std::process::id(), now_ms()));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&p)
        .map_err(|e| err("internal", format!("direct diff: {e}")))?;
    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700));
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, tempfile::TempDir, Store, String) {
        let proj = tempfile::tempdir().unwrap();
        let base = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(proj.path()).unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let store = Store::create(base.path(), "task-abc", &root_s).unwrap();
        (proj, base, store, root_s)
    }

    #[test]
    fn first_touch_wins_and_the_original_is_kept_outside_the_project() {
        let (proj, base, store, root) = setup();
        std::fs::write(proj.path().join("a.txt"), "one\n").unwrap();
        store
            .record_pre("a.txt", Some(b"one\n"), Some(0o644))
            .unwrap();
        store
            .record_pre("a.txt", Some(b"two\n"), Some(0o644))
            .unwrap();
        let e = store.entries().unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].sha.as_deref(), Some(sha_hex(b"one\n").as_str()));
        assert!(store.dir().starts_with(base.path()) && !store.dir().starts_with(&root));
        assert_eq!(
            std::fs::metadata(store.dir().join("pre").join(path_key("a.txt")))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn the_diff_covers_added_modified_and_deleted_files_and_only_those_touched() {
        let (proj, _b, store, root) = setup();
        std::fs::write(proj.path().join("mod.txt"), "one\ntwo\n").unwrap();
        std::fs::write(proj.path().join("gone.txt"), "bye\n").unwrap();
        std::fs::write(proj.path().join("untouched.txt"), "user\n").unwrap();
        store
            .record_pre("mod.txt", Some(b"one\ntwo\n"), Some(0o644))
            .unwrap();
        store
            .record_pre("gone.txt", Some(b"bye\n"), Some(0o644))
            .unwrap();
        store.record_pre("new.txt", None, None).unwrap();
        std::fs::write(proj.path().join("mod.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::remove_file(proj.path().join("gone.txt")).unwrap();
        std::fs::write(proj.path().join("new.txt"), "hello\n").unwrap();
        store
            .record_post("mod.txt", Some(&sha_hex(b"one\nTWO\nthree\n")))
            .unwrap();
        store.record_post("gone.txt", None).unwrap();
        store
            .record_post("new.txt", Some(&sha_hex(b"hello\n")))
            .unwrap();
        let d = diff(&store, &root).unwrap();
        let by = |p: &str| {
            d.files
                .iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("{p}"))
        };
        assert_eq!(by("mod.txt").status, "modified");
        assert_eq!(
            (by("mod.txt").additions, by("mod.txt").deletions),
            (Some(2), Some(1))
        );
        assert_eq!(by("gone.txt").status, "deleted");
        assert_eq!(by("new.txt").status, "added");
        assert_eq!(
            d.files.len(),
            3,
            "untouched.txt is not part of the change set"
        );
        assert!(
            d.diff.contains("diff --git a/new.txt b/new.txt"),
            "{}",
            d.diff
        );
        assert!(d.diff.contains("+hello"));
        assert!(d.files.iter().all(|f| !f.external_change));
        assert!(external_changes(&store, &root).unwrap().is_empty());
    }

    #[test]
    fn a_touched_but_identical_file_is_not_a_change_and_an_outside_edit_is_flagged() {
        let (proj, _b, store, root) = setup();
        std::fs::write(proj.path().join("f.txt"), "x\n").unwrap();
        store
            .record_pre("f.txt", Some(b"x\n"), Some(0o644))
            .unwrap();
        assert!(diff(&store, &root).unwrap().files.is_empty());
        std::fs::write(proj.path().join("f.txt"), "y\n").unwrap();
        store.record_post("f.txt", Some(&sha_hex(b"y\n"))).unwrap();
        assert!(external_changes(&store, &root).unwrap().is_empty());
        // the user edits it afterwards
        std::fs::write(proj.path().join("f.txt"), "y\nuser edit\n").unwrap();
        assert_eq!(external_changes(&store, &root).unwrap(), ["f.txt"]);
        let d = diff(&store, &root).unwrap();
        assert!(d.files[0].external_change);
    }

    #[test]
    fn a_symlinked_target_is_never_read_through() {
        let (proj, _b, store, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s3cret\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), proj.path().join("link"))
            .unwrap();
        store.record_pre("link", None, None).unwrap();
        let d = diff(&store, &root).unwrap();
        assert!(!d.diff.contains("s3cret"), "{}", d.diff);
    }

    #[test]
    fn roots_that_could_expose_more_than_a_project_are_refused() {
        assert_eq!(
            validate_root("relative", &[]).unwrap_err().code,
            "scope-refused"
        );
        assert!(validate_root("/", &[]).is_err());
        assert!(validate_root("/etc", &[]).is_err());
        assert!(validate_root("/proc/self", &[]).is_err());
        let d = tempfile::tempdir().unwrap();
        let inner = d.path().join("p");
        std::fs::create_dir(&inner).unwrap();
        assert!(validate_root(inner.to_str().unwrap(), &[]).is_ok());
        // overlapping Nexus's own data, either way
        assert!(validate_root(inner.to_str().unwrap(), &[d.path().to_path_buf()]).is_err());
        assert!(validate_root(d.path().to_str().unwrap(), std::slice::from_ref(&inner)).is_err());
        // a symlink to a folder resolves to the real folder
        let link = d.path().join("l");
        std::os::unix::fs::symlink(&inner, &link).unwrap();
        assert_eq!(
            validate_root(link.to_str().unwrap(), &[]).unwrap(),
            std::fs::canonicalize(&inner).unwrap()
        );
        // a file is not a project
        let f = d.path().join("file");
        std::fs::write(&f, "x").unwrap();
        assert!(validate_root(f.to_str().unwrap(), &[]).is_err());
    }

    #[test]
    fn old_stores_are_swept_and_recent_ones_and_projects_are_not() {
        let (proj, base, store, _root) = setup();
        std::fs::write(proj.path().join("keep.txt"), "keep\n").unwrap();
        store.record_pre("keep.txt", Some(b"keep\n"), None).unwrap();
        // a recent store survives a 30-day sweep
        assert_eq!(
            sweep_old(base.path(), std::time::Duration::from_secs(30 * 86400)),
            0
        );
        assert!(store.exists());
        // an old one goes (its manifest is older than the cutoff), the project never
        let f = std::fs::File::options()
            .write(true)
            .open(store.dir().join("manifest.json"))
            .unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 86400))
            .unwrap();
        assert_eq!(
            sweep_old(base.path(), std::time::Duration::from_secs(30 * 86400)),
            1
        );
        assert!(!store.exists());
        assert_eq!(
            std::fs::read_to_string(proj.path().join("keep.txt")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn removing_a_store_never_touches_the_project() {
        let (proj, _b, store, _root) = setup();
        std::fs::write(proj.path().join("keep.txt"), "keep\n").unwrap();
        store.record_pre("keep.txt", Some(b"keep\n"), None).unwrap();
        store.remove().unwrap();
        assert!(!store.exists());
        assert_eq!(
            std::fs::read_to_string(proj.path().join("keep.txt")).unwrap(),
            "keep\n"
        );
        store.remove().unwrap(); // idempotent
    }
}
