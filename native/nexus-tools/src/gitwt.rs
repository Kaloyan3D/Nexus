//! Isolated Git working copies for autonomous coding (A5.6).
//!
//! Every `repo-code` task runs in its own checkout, created and inspected by
//! this trusted module. Design decisions (see `native/A5.6-EVIDENCE.md` §2):
//!
//! * The working copy is a dedicated LOCAL CLONE (`git clone --local
//!   --no-hardlinks --no-checkout`) checked out detached at the recorded
//!   commit, not a `git worktree add`. A linked worktree writes administrative
//!   entries into the source repository's `.git` and keeps a live link to it;
//!   the clone leaves the source byte-for-byte untouched and shares nothing
//!   writable with it.
//! * No shell. Every Git invocation is `Command::new("git")` with an argument
//!   vector, a cleared environment, system/global config disabled, hooks
//!   disabled, fsmonitor disabled, no prompts, no optional locks, a wall-clock
//!   timeout and a bounded output.
//! * A source repository is accepted only when it is a plain non-bare
//!   repository with a clean tree and a born HEAD, no alternates, no
//!   submodules and no config key that can make Git run a program (filters,
//!   fsmonitor, hooksPath, diff/merge drivers, credential helpers, includes).
//!   Anything else is refused explicitly (`dirty-source`, `ambiguous-source`),
//!   never guessed.
//! * Creation is crash-safe: clone into `.creating-*`, verify, then atomically
//!   rename. Stale `.creating-*` directories are swept by the caller at start.
//! * The model never names a path here: the destination is
//!   `<root>/<taskInstanceId>`, derived from the Controller's task identity.
//!
//! This module never commits, pushes, merges or rebases. The only mutation of
//! the copy's `.git` is `git add -A` (index) to compute a reviewable diff.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const MAX_GIT_OUTPUT: usize = 1024 * 1024;
pub const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest unified diff returned to a reviewer.
pub const MAX_DIFF_BYTES: usize = 256 * 1024;
pub const MAX_DIFF_FILES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WtError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for WtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for WtError {}

fn err(code: &'static str, message: impl Into<String>) -> WtError {
    WtError {
        code,
        message: message.into(),
    }
}

/// What the Controller records about the source of a task.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    /// Full commit id the working copy is checked out at.
    pub commit: String,
    /// `sha256("nexus-repo-id/v1" 0 canonical-path 0 commit)`.
    pub repo_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub source: SourceState,
    pub task_instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// `added` | `modified` | `deleted` | `renamed` | `other`
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReport {
    pub base_commit: String,
    pub files: Vec<FileChange>,
    pub files_truncated: bool,
    pub diff: String,
    pub diff_digest: String,
    pub diff_truncated: bool,
}

pub fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

struct GitOut {
    status: i32,
    stdout: Vec<u8>,
    truncated: bool,
}

/// Run Git without a shell, with a cleared environment and hardened config.
fn git(cwd: Option<&Path>, args: &[&str]) -> Result<GitOut, WtError> {
    let mut c = Command::new("git");
    c.env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/local/bin")
        .env("HOME", "/nonexistent")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/bin/false")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_AUTHOR_NAME", "nexus")
        .env("GIT_AUTHOR_EMAIL", "nexus@localhost")
        .env("GIT_COMMITTER_NAME", "nexus")
        .env("GIT_COMMITTER_EMAIL", "nexus@localhost")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.quotePath=false",
            "-c",
            "gc.auto=0",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "advice.detachedHead=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let mut child = c
        .spawn()
        .map_err(|e| err("git-unavailable", format!("cannot run git: {e}")))?;
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut truncated = false;
        if let Some(o) = out.as_mut() {
            let mut chunk = [0u8; 16 * 1024];
            loop {
                match o.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() < MAX_GIT_OUTPUT {
                            let take = n.min(MAX_GIT_OUTPUT - buf.len());
                            buf.extend_from_slice(&chunk[..take]);
                            if take < n {
                                truncated = true;
                            }
                        } else {
                            truncated = true;
                        }
                    }
                }
            }
        }
        (buf, truncated)
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(-1),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err("git-timeout", "git did not finish in time"));
            }
        }
    };
    let (stdout, truncated) = reader.join().unwrap_or_default();
    Ok(GitOut {
        status,
        stdout,
        truncated,
    })
}

fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, WtError> {
    let o = git(Some(cwd), args)?;
    if o.status != 0 {
        return Err(err(
            "git-failed",
            format!("git {} failed", args.first().unwrap_or(&"")),
        ));
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

fn is_hex_commit(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Config keys that make Git execute a program or pull in more config.
fn dangerous_config_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    k.starts_with("filter.")
        || k.starts_with("include.")
        || k.starts_with("includeif.")
        || k.starts_with("credential.")
        || k.starts_with("url.")
        || k.starts_with("alias.")
        || k.starts_with("submodule.")
        || k.starts_with("remote.")
            && (k.ends_with(".uploadpack") || k.ends_with(".receivepack") || k.ends_with(".vcs"))
        || (k.starts_with("diff.") && (k.ends_with(".command") || k.ends_with(".textconv")))
        || (k.starts_with("merge.") && k.ends_with(".driver"))
        || (k.starts_with("mergetool.") || k.starts_with("difftool."))
        || matches!(
            k.as_str(),
            "core.fsmonitor"
                | "core.hookspath"
                | "core.sshcommand"
                | "core.gitproxy"
                | "core.editor"
                | "core.pager"
                | "core.askpass"
                | "core.attributesfile"
                | "core.excludesfile"
                | "diff.external"
                | "gpg.program"
                | "uploadpack.packobjectshook"
                | "sequence.editor"
                | "http.proxy"
                | "protocol.ext.allow"
        )
}

/// Validate a source repository and return the commit a working copy would
/// start from. Read-only: no index refresh, no hooks, no filters.
pub fn inspect_source(src: &Path) -> Result<SourceState, WtError> {
    let canon = std::fs::canonicalize(src)
        .map_err(|_| err("ambiguous-source", "source repository does not exist"))?;
    let dotgit = canon.join(".git");
    let md = std::fs::symlink_metadata(&dotgit).map_err(|_| {
        err(
            "ambiguous-source",
            "source is not a Git working tree (.git missing)",
        )
    })?;
    if !md.file_type().is_dir() {
        return Err(err(
            "ambiguous-source",
            ".git must be a real directory (linked worktrees, symlinks and gitfiles are not supported)",
        ));
    }
    if std::fs::symlink_metadata(dotgit.join("objects/info/alternates")).is_ok() {
        return Err(err(
            "ambiguous-source",
            "the repository borrows objects from another repository (alternates)",
        ));
    }
    if std::fs::symlink_metadata(dotgit.join("commondir")).is_ok() {
        return Err(err(
            "ambiguous-source",
            "linked worktree administration found",
        ));
    }
    // Config can make Git run programs: refuse such a repository outright.
    let cfg = git(Some(&canon), &["config", "--local", "--list", "--null"])?;
    if cfg.status != 0 {
        return Err(err(
            "ambiguous-source",
            "repository configuration is unreadable",
        ));
    }
    for entry in String::from_utf8_lossy(&cfg.stdout).split('\0') {
        let key = entry.split('\n').next().unwrap_or("");
        if !key.is_empty() && dangerous_config_key(key) {
            return Err(err(
                "ambiguous-source",
                format!(
                    "repository config key '{}' can run programs; refused",
                    key.chars().take(60).collect::<String>()
                ),
            ));
        }
    }
    let bare = git_ok(&canon, &["rev-parse", "--is-bare-repository"])?;
    if bare.trim() != "false" {
        return Err(err(
            "ambiguous-source",
            "bare repositories are not supported",
        ));
    }
    let head = git(
        Some(&canon),
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    )?;
    let commit = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    if head.status != 0 || !is_hex_commit(&commit) {
        return Err(err(
            "ambiguous-source",
            "HEAD does not name a commit (unborn branch?)",
        ));
    }
    let gm = git(Some(&canon), &["cat-file", "-e", "HEAD:.gitmodules"])?;
    if gm.status == 0 {
        return Err(err("ambiguous-source", "submodules are not supported"));
    }
    let st = git(
        Some(&canon),
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
            "--no-renames",
        ],
    )?;
    if st.status != 0 {
        return Err(err("ambiguous-source", "git status failed"));
    }
    if !st.stdout.is_empty() {
        return Err(err(
            "dirty-source",
            "the source repository has uncommitted or untracked changes; commit or stash them first (the agent only sees a committed state)",
        ));
    }
    let mut h = Sha256::new();
    h.update(b"nexus-repo-id/v1\0");
    h.update(canon.to_string_lossy().as_bytes());
    h.update([0]);
    h.update(commit.as_bytes());
    Ok(SourceState {
        commit,
        repo_id: hex::encode(h.finalize()),
    })
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    hex::encode(b)
}

/// Create `<root>/<id>` as an isolated checkout of `src` at its current,
/// clean HEAD. Refuses to reuse an existing destination.
pub fn create(src: &Path, root: &Path, id: &str) -> Result<WorktreeInfo, WtError> {
    if !valid_task_id(id) {
        return Err(err(
            "bad-task-id",
            "task instance id is not a valid worktree name",
        ));
    }
    let root =
        std::fs::canonicalize(root).map_err(|_| err("bad-root", "worktree root does not exist"))?;
    let dest = root.join(id);
    if std::fs::symlink_metadata(&dest).is_ok() {
        return Err(err("exists", "a working copy for this task already exists"));
    }
    let state = inspect_source(src)?;
    let canon_src =
        std::fs::canonicalize(src).map_err(|_| err("ambiguous-source", "source vanished"))?;
    if root.starts_with(&canon_src) || canon_src.starts_with(&root) {
        return Err(err(
            "bad-root",
            "the worktree root overlaps the source repository",
        ));
    }
    let tmp = root.join(format!(".creating-{id}-{}", rand_hex(6)));
    let cleanup = |p: &Path| {
        let _ = std::fs::remove_dir_all(p);
    };
    let tmp_s = tmp.to_string_lossy().into_owned();
    let src_s = canon_src.to_string_lossy().into_owned();
    let r = (|| -> Result<(), WtError> {
        let c = git(
            None,
            &[
                "clone",
                "--local",
                "--no-hardlinks",
                "--no-checkout",
                "--no-tags",
                "--quiet",
                "--template=",
                "--",
                &src_s,
                &tmp_s,
            ],
        )?;
        if c.status != 0 {
            return Err(err("clone-failed", "git clone failed"));
        }
        // No remote: the copy can never fetch from or push to anything.
        let _ = git(Some(&tmp), &["remote", "remove", "origin"]);
        git_ok(&tmp, &["config", "--local", "core.hooksPath", "/dev/null"])?;
        git_ok(&tmp, &["config", "--local", "core.fsmonitor", "false"])?;
        git_ok(&tmp, &["checkout", "--quiet", "--detach", &state.commit])?;
        let head = git_ok(&tmp, &["rev-parse", "--verify", "HEAD^{commit}"])?;
        if head.trim() != state.commit {
            return Err(err(
                "verify-failed",
                "checked-out commit differs from the recorded commit",
            ));
        }
        let st = git(
            Some(&tmp),
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?;
        if st.status != 0 || !st.stdout.is_empty() {
            return Err(err("verify-failed", "fresh checkout is not clean"));
        }
        Ok(())
    })();
    if let Err(e) = r {
        cleanup(&tmp);
        return Err(e);
    }
    // Atomic publication: the final name never exists half-built.
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        cleanup(&tmp);
        return Err(err(
            "publish-failed",
            format!("cannot publish working copy: {e}"),
        ));
    }
    Ok(WorktreeInfo {
        path: dest,
        source: state,
        task_instance_id: id.to_owned(),
    })
}

/// Remove stale half-built copies (call at start-up, before serving).
pub fn sweep_stale(root: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(".creating-") {
                if let Ok(md) = std::fs::symlink_metadata(e.path()) {
                    if md.file_type().is_dir() {
                        let _ = std::fs::remove_dir_all(e.path());
                        n += 1;
                    }
                }
            }
        }
    }
    n
}

/// Approximate disk usage of one managed working copy: lstat sizes, symlinks
/// never followed, bounded work. Returns (bytes, entries, truncated).
pub fn disk_usage(root: &Path, id: &str) -> Result<(u64, u64, bool), WtError> {
    use std::os::unix::fs::MetadataExt;
    if !valid_task_id(id) {
        return Err(err("bad-task-id", "invalid task id"));
    }
    let root = std::fs::canonicalize(root).map_err(|_| err("bad-root", "worktree root missing"))?;
    let top = root.join(id);
    let md =
        std::fs::symlink_metadata(&top).map_err(|_| err("not-found", "no such working copy"))?;
    if !md.file_type().is_dir() {
        return Err(err("not-found", "not a working copy directory"));
    }
    const MAX_ENTRIES: u64 = 200_000;
    let (mut bytes, mut n, mut trunc) = (0u64, 0u64, false);
    let mut stack = vec![top];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            n += 1;
            if n > MAX_ENTRIES {
                trunc = true;
                return Ok((bytes, n, trunc));
            }
            let Ok(m) = std::fs::symlink_metadata(e.path()) else {
                continue;
            };
            bytes += m.blocks() * 512;
            if m.file_type().is_dir() {
                stack.push(e.path());
            }
        }
    }
    Ok((bytes, n, trunc))
}

/// Explicit operator removal of one task's copy.
pub fn remove(root: &Path, id: &str) -> Result<(), WtError> {
    if !valid_task_id(id) {
        return Err(err("bad-task-id", "invalid task id"));
    }
    let root = std::fs::canonicalize(root).map_err(|_| err("bad-root", "worktree root missing"))?;
    let dest = root.join(id);
    let md =
        std::fs::symlink_metadata(&dest).map_err(|_| err("not-found", "no such working copy"))?;
    if !md.file_type().is_dir() {
        return Err(err("not-found", "not a working copy directory"));
    }
    std::fs::remove_dir_all(&dest).map_err(|e| err("remove-failed", e.to_string()))
}

/// The reviewable change set of a working copy relative to its base commit:
/// file list, unified diff and digest. Never commits.
pub fn diff(wt: &Path, base_commit: &str) -> Result<DiffReport, WtError> {
    // `git add -A` stages into the copy's own index, which must never be written by two
    // diffs at once (index.lock): one diff at a time in this process. (Found by the real
    // Desktop asking for the same diff twice.)
    static DIFF_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one_at_a_time = DIFF_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if !is_hex_commit(base_commit) {
        return Err(err("bad-commit", "base commit is malformed"));
    }
    let md = std::fs::symlink_metadata(wt.join(".git"))
        .map_err(|_| err("not-found", "not a working copy"))?;
    if !md.file_type().is_dir() {
        return Err(err("not-found", "not a working copy"));
    }
    // Stage everything (index only) so new and deleted files appear.
    git_ok(wt, &["add", "-A", "--", "."])?;
    let ns = git(
        Some(wt),
        &[
            "diff",
            "--cached",
            "--name-status",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "-z",
            base_commit,
        ],
    )?;
    let nu = git(
        Some(wt),
        &[
            "diff",
            "--cached",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "-z",
            base_commit,
        ],
    )?;
    let d = git(
        Some(wt),
        &[
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            base_commit,
        ],
    )?;
    if ns.status != 0 || nu.status != 0 || d.status != 0 {
        return Err(err("git-failed", "git diff failed"));
    }
    // numstat -z: "<add>\t<del>\t<path>\0" (renames: "<a>\t<d>\t\0old\0new\0")
    let mut counts: std::collections::BTreeMap<String, (Option<u64>, Option<u64>)> =
        Default::default();
    {
        let text = String::from_utf8_lossy(&nu.stdout).into_owned();
        let mut parts = text.split('\0').peekable();
        while let Some(p) = parts.next() {
            if p.is_empty() {
                continue;
            }
            let mut f = p.splitn(3, '\t');
            let (a, dl, path) = (
                f.next().unwrap_or(""),
                f.next().unwrap_or(""),
                f.next().unwrap_or(""),
            );
            let parse = |s: &str| s.parse::<u64>().ok();
            if path.is_empty() {
                let _old = parts.next();
                if let Some(newp) = parts.next() {
                    counts.insert(newp.to_owned(), (parse(a), parse(dl)));
                }
            } else {
                counts.insert(path.to_owned(), (parse(a), parse(dl)));
            }
        }
    }
    let mut files = Vec::new();
    let mut files_truncated = false;
    {
        let text = String::from_utf8_lossy(&ns.stdout).into_owned();
        let mut parts = text.split('\0');
        while let Some(st) = parts.next() {
            if st.is_empty() {
                continue;
            }
            let first = st.chars().next().unwrap_or('?');
            let path1 = parts.next().unwrap_or("").to_owned();
            let (status, path) = match first {
                'A' => ("added", path1),
                'M' | 'T' => ("modified", path1),
                'D' => ("deleted", path1),
                'R' | 'C' => {
                    let new = parts.next().unwrap_or("").to_owned();
                    ("renamed", new)
                }
                _ => ("other", path1),
            };
            if files.len() >= MAX_DIFF_FILES {
                files_truncated = true;
                continue;
            }
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((None, None));
            files.push(FileChange {
                path,
                status: status.to_owned(),
                additions,
                deletions,
            });
        }
    }
    let mut text = String::from_utf8_lossy(&d.stdout).into_owned();
    let mut diff_truncated = d.truncated;
    if text.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        diff_truncated = true;
    }
    let diff_digest = hex::encode(Sha256::digest(text.as_bytes()));
    Ok(DiffReport {
        base_commit: base_commit.to_owned(),
        files,
        files_truncated,
        diff: text,
        diff_digest,
        diff_truncated,
    })
}

/// Hardened Git for callers outside this module (snapshots): no shell, cleared
/// environment, no hooks. Returns `(exit status, stdout)`; stdout is bounded.
/// Carry the work of an earlier (interrupted) task over into a fresh copy of the same
/// project: every file the earlier copy added, changed or deleted relative to its base
/// commit is reproduced in `to_wt`. Regular files only; nothing under `.git`; paths are
/// validated components. Returns how many files were carried over.
pub fn seed_copy(from_wt: &Path, base_commit: &str, to_wt: &Path) -> Result<usize, WtError> {
    static SEED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = SEED_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if !is_hex_commit(base_commit) {
        return Err(err("bad-commit", "base commit is malformed"));
    }
    git_ok(from_wt, &["add", "-A", "--", "."])?;
    let ns = git(
        Some(from_wt),
        &[
            "diff",
            "--cached",
            "--name-status",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-z",
            base_commit,
        ],
    )?;
    if ns.status != 0 {
        return Err(err("git-failed", "git diff failed"));
    }
    let text = String::from_utf8_lossy(&ns.stdout).into_owned();
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let mut n = 0usize;
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        let ok_path = !path.starts_with('/')
            && path
                .split('/')
                .all(|c| !c.is_empty() && c != "." && c != ".." && c != ".git");
        if !ok_path {
            continue;
        }
        let from = from_wt.join(path);
        let to = to_wt.join(path);
        if status.starts_with('D') {
            let _ = std::fs::remove_file(&to);
            n += 1;
            continue;
        }
        let Ok(md) = std::fs::symlink_metadata(&from) else {
            continue;
        };
        if !md.file_type().is_file() || md.len() > 64 * 1024 * 1024 {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| err("io", e.to_string()))?;
        }
        // never write through a link that appeared in the fresh copy
        if let Ok(t) = std::fs::symlink_metadata(&to) {
            if t.file_type().is_symlink() {
                continue;
            }
        }
        std::fs::copy(&from, &to).map_err(|e| err("io", e.to_string()))?;
        n += 1;
    }
    Ok(n)
}

/// What carrying a conversation's earlier work onto a NEWER snapshot of the project did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RebaseReport {
    /// Files reproduced in the new copy (the project did not touch them since the old base).
    pub carried: usize,
    /// Files whose content the new snapshot already has (the change was applied to the folder).
    pub already_applied: usize,
    /// Files changed both by the earlier work and in the project since: nothing is written.
    pub conflicts: Vec<String>,
}

fn blob_of(cwd: &Path, spec: &str) -> Option<String> {
    let o = git(Some(cwd), &["rev-parse", "--verify", "-q", spec]).ok()?;
    if o.status != 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&o.stdout).trim().to_owned();
    (!s.is_empty()).then_some(s)
}

/// Like [`seed_copy`], but the new copy was made from a DIFFERENT snapshot of the same
/// project (`new_base`) than the earlier one (`old_base`): the folder changed between the
/// two. Per file the earlier work touched:
///   * the new snapshot already has the earlier work's content -> nothing to do (applied);
///   * the project did not change that file since `old_base` -> the earlier work is carried;
///   * otherwise both sides changed it -> conflict.
///
/// Any conflict means NOTHING is written (the caller reports it; the user decides).
pub fn seed_rebase(
    from_wt: &Path,
    old_base: &str,
    to_wt: &Path,
    new_base: &str,
) -> Result<RebaseReport, WtError> {
    static SEED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = SEED_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if !is_hex_commit(old_base) || !is_hex_commit(new_base) {
        return Err(err("bad-commit", "base commit is malformed"));
    }
    git_ok(from_wt, &["add", "-A", "--", "."])?;
    let ns = git(
        Some(from_wt),
        &[
            "diff",
            "--cached",
            "--name-status",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-z",
            old_base,
        ],
    )?;
    if ns.status != 0 {
        return Err(err("git-failed", "git diff failed"));
    }
    let text = String::from_utf8_lossy(&ns.stdout).into_owned();
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let mut report = RebaseReport::default();
    let mut plan: Vec<(bool, String)> = Vec::new(); // (delete?, path)
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        let ok_path = !path.starts_with('/')
            && path
                .split('/')
                .all(|c| !c.is_empty() && c != "." && c != ".." && c != ".git");
        if !ok_path {
            continue;
        }
        let deleted = status.starts_with('D');
        let head = if deleted {
            None
        } else {
            blob_of(from_wt, &format!(":{path}"))
        };
        let b1 = blob_of(from_wt, &format!("{old_base}:{path}"));
        let b2 = blob_of(to_wt, &format!("{new_base}:{path}"));
        if head == b2 {
            report.already_applied += 1;
        } else if b2 == b1 {
            plan.push((deleted, path.to_owned()));
        } else {
            report.conflicts.push(path.to_owned());
        }
    }
    if !report.conflicts.is_empty() {
        return Ok(report);
    }
    for (deleted, path) in plan {
        let from = from_wt.join(&path);
        let to = to_wt.join(&path);
        if deleted {
            let _ = std::fs::remove_file(&to);
            report.carried += 1;
            continue;
        }
        let Ok(md) = std::fs::symlink_metadata(&from) else {
            continue;
        };
        if !md.file_type().is_file() || md.len() > 64 * 1024 * 1024 {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| err("io", e.to_string()))?;
        }
        if let Ok(t) = std::fs::symlink_metadata(&to) {
            if t.file_type().is_symlink() {
                continue;
            }
        }
        std::fs::copy(&from, &to).map_err(|e| err("io", e.to_string()))?;
        report.carried += 1;
    }
    Ok(report)
}

pub fn run_git(cwd: &Path, args: &[&str]) -> Result<(i32, Vec<u8>), WtError> {
    let o = git(Some(cwd), args)?;
    Ok((o.status, o.stdout))
}
