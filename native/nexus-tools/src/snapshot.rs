//! A6.1.4: managed project snapshots.
//!
//! Opening a project must not need a clean Git tree, a commit, or an operator.
//! Nexus copies the project's *current* files (tracked, untracked and, for Node
//! projects, installed dependencies) into a Nexus-owned Git repository and commits
//! them. That commit is the revision the registry pins; isolated working copies are
//! cloned from it; the user's directory is only ever READ.
//!
//! Selection rules (all enforced here, never by the caller):
//! * symlinks, sockets, devices and anything that is not a regular file are skipped;
//! * `.git` is never copied; secret-shaped names (`.env*`, keys, credentials) are
//!   never copied, so they can never reach a model;
//! * per-file, total-size and file-count caps bound the work and the disclosure.

use crate::gitwt::run_git;
use crate::workspace::{NameClass, WorkspacePolicy};
use sha2::{Digest, Sha256};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub struct SnapshotLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for SnapshotLimits {
    fn default() -> Self {
        Self {
            max_files: 60_000,
            max_total_bytes: 512 * 1024 * 1024,
            max_file_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapErr {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for SnapErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for SnapErr {}
fn err(code: &'static str, m: impl Into<String>) -> SnapErr {
    SnapErr {
        code,
        message: m.into(),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub commit: String,
    pub files: usize,
    pub bytes: u64,
    /// `(relative path, reason)` of the first skipped entries (bounded).
    pub skipped: Vec<(String, &'static str)>,
    pub skipped_total: usize,
    pub fingerprint: String,
    /// Origin Git facts, when the origin is a Git working tree (best effort).
    pub origin_head: Option<String>,
    pub origin_dirty: Option<bool>,
}

/// Directories whose contents are never copied (build output and caches); installed
/// Node dependencies are handled separately.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".gradle",
    ".idea",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    "obj",
    ".cache",
];

fn skip_reason(rel: &str, pol: &WorkspacePolicy) -> Option<&'static str> {
    for c in rel.split('/') {
        if SKIP_DIRS.contains(&c) {
            return Some("build-or-cache-directory");
        }
        if pol.classify_name(c) == NameClass::Sensitive {
            return Some("sensitive-name");
        }
    }
    None
}

fn is_git_tree(origin: &Path) -> bool {
    std::fs::symlink_metadata(origin.join(".git"))
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

/// Files of the project, relative and `/`-separated, in sorted order.
fn candidates(origin: &Path, node: bool, cap: usize) -> Result<Vec<String>, SnapErr> {
    let mut out: Vec<String> = Vec::new();
    if is_git_tree(origin) {
        let (st, bytes) = run_git(
            origin,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        )
        .map_err(|e| err("git-failed", e.to_string()))?;
        if st != 0 {
            return Err(err("git-failed", "git could not list the project's files"));
        }
        for r in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            out.push(String::from_utf8_lossy(r).into_owned());
            if out.len() > cap + 1 {
                break;
            }
        }
    } else {
        walk(origin, origin, &mut out, cap + 1)?;
    }
    if node
        && std::fs::symlink_metadata(origin.join("node_modules"))
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false)
    {
        let mut nm = Vec::new();
        walk(origin, &origin.join("node_modules"), &mut nm, cap + 1)?;
        out.extend(nm);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<String>, cap: usize) -> Result<(), SnapErr> {
    let rd = std::fs::read_dir(dir)
        .map_err(|e| err("unreadable", format!("cannot read a directory: {e}")))?;
    for e in rd.flatten() {
        if out.len() > cap {
            return Ok(());
        }
        let Ok(m) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        let name = e.file_name().to_string_lossy().into_owned();
        if m.file_type().is_dir() {
            // installed dependencies are added explicitly (Node projects), never by accident
            if SKIP_DIRS.contains(&name.as_str()) || (name == "node_modules" && dir == base) {
                continue;
            }
            walk(base, &e.path(), out, cap)?;
        } else if let Ok(rel) = e.path().strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// Cheap change detector: a digest of the selected files' (path, size, mtime).
pub fn fingerprint(origin: &Path, limits: &SnapshotLimits) -> Result<String, SnapErr> {
    let pol = WorkspacePolicy::default();
    let mut h = Sha256::new();
    let mut n = 0usize;
    for rel in candidates(origin, false, limits.max_files)? {
        if skip_reason(&rel, &pol).is_some() {
            continue;
        }
        let Ok(m) = std::fs::symlink_metadata(origin.join(&rel)) else {
            continue;
        };
        if !m.file_type().is_file() {
            continue;
        }
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(m.len().to_le_bytes());
        h.update(m.mtime().to_le_bytes());
        h.update(m.mtime_nsec().to_le_bytes());
        n += 1;
        if n > limits.max_files {
            break;
        }
    }
    Ok(hex::encode(h.finalize()))
}

/// Copy the project's current files into a fresh Git repository at `dest` (which must
/// not exist) and commit them.
pub fn snapshot(
    origin: &Path,
    dest: &Path,
    node: bool,
    limits: &SnapshotLimits,
) -> Result<SnapshotInfo, SnapErr> {
    let origin = std::fs::canonicalize(origin)
        .map_err(|_| err("bad-origin", "the project folder does not exist"))?;
    if dest.exists() {
        return Err(err(
            "dest-exists",
            "the snapshot destination already exists",
        ));
    }
    let pol = WorkspacePolicy::default();
    let files = candidates(&origin, node, limits.max_files)?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dest)
        .map_err(|e| err("io", format!("cannot create the snapshot directory: {e}")))?;
    let result = (|| -> Result<SnapshotInfo, SnapErr> {
        let (mut count, mut total) = (0usize, 0u64);
        let mut skipped: Vec<(String, &'static str)> = Vec::new();
        let mut skipped_total = 0usize;
        let mut note = |rel: &str, why: &'static str| {
            skipped_total += 1;
            if skipped.len() < 50 {
                skipped.push((rel.to_owned(), why));
            }
        };
        let mut fp = Sha256::new();
        for rel in &files {
            if rel.is_empty()
                || rel.starts_with('/')
                || rel.split('/').any(|c| c == ".." || c == ".")
            {
                note(rel, "unsafe-path");
                continue;
            }
            if node_dep(rel) && !node {
                note(rel, "dependency-directory");
                continue;
            }
            if !node_dep(rel) {
                if let Some(why) = skip_reason(rel, &pol) {
                    note(rel, why);
                    continue;
                }
            } else if rel
                .split('/')
                .any(|c| pol.classify_name(c) == NameClass::Sensitive)
            {
                note(rel, "sensitive-name");
                continue;
            }
            let src = origin.join(rel);
            let Ok(m) = std::fs::symlink_metadata(&src) else {
                continue;
            }; // deleted but still listed
            if !m.file_type().is_file() {
                note(rel, "not-a-regular-file");
                continue;
            }
            if m.len() > limits.max_file_bytes {
                note(rel, "file-too-large");
                continue;
            }
            if count >= limits.max_files {
                return Err(err(
                    "too-many-files",
                    format!("the project has more than {} files", limits.max_files),
                ));
            }
            total += m.len();
            if total > limits.max_total_bytes {
                return Err(err(
                    "too-large",
                    "the project is larger than the snapshot size limit",
                ));
            }
            let to = dest.join(rel);
            if let Some(p) = to.parent() {
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(p)
                    .map_err(|e| err("io", e.to_string()))?;
            }
            std::fs::copy(&src, &to).map_err(|e| err("io", format!("cannot copy a file: {e}")))?;
            let mode = if m.permissions().mode() & 0o111 != 0 {
                0o700
            } else {
                0o600
            };
            std::fs::set_permissions(&to, std::fs::Permissions::from_mode(mode))
                .map_err(|e| err("io", e.to_string()))?;
            if !node_dep(rel) {
                fp.update(rel.as_bytes());
                fp.update([0]);
                fp.update(m.len().to_le_bytes());
                fp.update(m.mtime().to_le_bytes());
                fp.update(m.mtime_nsec().to_le_bytes());
            }
            count += 1;
        }
        let g = |args: &[&str]| -> Result<Vec<u8>, SnapErr> {
            let (st, out) = run_git(dest, args).map_err(|e| err("git-failed", e.to_string()))?;
            if st != 0 {
                return Err(err(
                    "git-failed",
                    format!("git {} failed", args.first().unwrap_or(&"")),
                ));
            }
            Ok(out)
        };
        g(&["init", "-q", "-b", "main"])?;
        g(&["add", "-A", "-f"])?;
        g(&[
            "-c",
            "user.name=Nexus Snapshot",
            "-c",
            "user.email=snapshot@nexus.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "nexus snapshot",
        ])?;
        let commit = String::from_utf8_lossy(&g(&["rev-parse", "HEAD"])?)
            .trim()
            .to_owned();
        let (origin_head, origin_dirty) = if is_git_tree(&origin) {
            let head = run_git(&origin, &["rev-parse", "HEAD"])
                .ok()
                .filter(|(s, _)| *s == 0)
                .map(|(_, o)| String::from_utf8_lossy(&o).trim().to_owned());
            let dirty = run_git(&origin, &["status", "--porcelain"])
                .ok()
                .filter(|(s, _)| *s == 0)
                .map(|(_, o)| !o.is_empty());
            (head, dirty)
        } else {
            (None, None)
        };
        Ok(SnapshotInfo {
            commit,
            files: count,
            bytes: total,
            skipped,
            skipped_total,
            fingerprint: hex::encode(fp.finalize()),
            origin_head,
            origin_dirty,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dest);
    }
    result
}

fn node_dep(rel: &str) -> bool {
    rel.starts_with("node_modules/")
}

/// A6.1.4 adoption: apply a Nexus-produced patch to the user's ORIGINAL folder. Only ever
/// invoked after the user confirmed in a native dialog. Refuses unless the folder is
/// unchanged since the snapshot the patch is based on; checks the whole patch first
/// (all-or-nothing); never touches `.git`, never creates a commit.
pub fn apply_patch(
    origin: &Path,
    expected_fingerprint: &str,
    patch: &str,
    limits: &SnapshotLimits,
) -> Result<Vec<String>, SnapErr> {
    let origin = std::fs::canonicalize(origin)
        .map_err(|_| err("bad-origin", "the project folder no longer exists"))?;
    if fingerprint(&origin, limits)? != expected_fingerprint {
        return Err(err(
            "origin-changed",
            "the folder changed since Nexus copied it, so the patch might not fit; refresh the project and run the task again, or apply the patch by hand",
        ));
    }
    // every path the patch names must be a plain relative path the agent could write
    let mut paths: Vec<String> = Vec::new();
    for l in patch.lines() {
        if let Some(rest) = l.strip_prefix("diff --git a/") {
            let p = rest.split(" b/").next().unwrap_or("").to_owned();
            crate::protect::write_path_check(&p)
                .map_err(|(_, why)| err("bad-patch", format!("the patch touches {p}: {why}")))?;
            paths.push(p);
        } else if l.starts_with("rename ")
            || l.starts_with("GIT binary patch")
            || l.starts_with("Binary files ")
            || l.starts_with("copy ")
            || l.starts_with("old mode ")
            || l.starts_with("new mode ")
        {
            return Err(err(
                "bad-patch",
                "renames, copies, mode changes and binary changes are not applied automatically",
            ));
        }
    }
    if paths.is_empty() {
        return Err(err("bad-patch", "the patch changes no files"));
    }
    let scratch = tempfile_in_private(&origin)?;
    let pf = scratch.join("nexus.patch");
    std::fs::write(&pf, patch).map_err(|e| err("io", e.to_string()))?;
    let pfs = pf.to_string_lossy().into_owned();
    let apply = |check: bool| -> Result<(), SnapErr> {
        let mut a = vec!["apply", "--whitespace=nowarn"];
        if check {
            a.push("--check");
        }
        a.push(&pfs);
        let (st, _) = run_git(&origin, &a).map_err(|e| err("git-failed", e.to_string()))?;
        if st == 0 {
            Ok(())
        } else {
            Err(err(
                "patch-conflict",
                "the patch does not apply cleanly to your folder",
            ))
        }
    };
    let r = apply(true).and_then(|_| apply(false));
    let _ = std::fs::remove_dir_all(&scratch);
    r?;
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// A private scratch directory OUTSIDE the project (never inside the user's folder).
fn tempfile_in_private(origin: &Path) -> Result<PathBuf, SnapErr> {
    let base = std::env::temp_dir().join(format!(
        "nexus-adopt-{}-{}",
        std::process::id(),
        origin
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)
        .map_err(|e| err("io", e.to_string()))?;
    Ok(base)
}

/// Never follow or accept a destination that is not a plain directory we created.
pub fn remove_snapshot(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_dir() => std::fs::remove_dir_all(dir),
        Ok(_) => Err(std::io::Error::other("not a snapshot directory")),
        Err(e) => Err(e),
    }
}

pub fn snapshot_dir_name(project_id: &str, n: u64) -> PathBuf {
    PathBuf::from(format!("{project_id}-{n}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::process::Command;

    fn git(d: &Path, args: &[&str]) {
        let o = Command::new("git")
            .current_dir(d)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    }

    fn w(d: &Path, rel: &str, text: &str) {
        let p = d.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn files_in(d: &Path) -> Vec<String> {
        let (_, o) = run_git(d, &["ls-files", "-z"]).unwrap();
        String::from_utf8_lossy(&o)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_dirty_git_project_is_snapshotted_as_it_is_and_the_original_is_never_touched() {
        let o = tempfile::tempdir().unwrap();
        let d = o.path();
        w(d, "src/lib.rs", "pub fn a() {}\n");
        w(d, "README.md", "# p\n");
        w(d, ".gitignore", "build/\n*.log\n");
        git(d, &["init", "-q", "-b", "main"]);
        git(d, &["add", "-A"]);
        git(d, &["commit", "-qm", "i"]);
        // dirty: modified tracked, untracked new file, ignored output, secrets, symlink, big file
        w(d, "src/lib.rs", "pub fn a() { /* edited */ }\n");
        w(d, "src/new.rs", "pub fn n() {}\n");
        w(d, "build/out.o", "binary");
        w(d, "debug.log", "log");
        w(d, ".env", "API_KEY=sk-secret\n");
        w(d, "keys/id_rsa", "PRIVATE");
        w(d, "certs/server.pem", "PEM");
        symlink("/etc/passwd", d.join("passwd-link")).unwrap();
        w(d, "big.bin", &"x".repeat(5 * 1024 * 1024));
        let before: Vec<u8> = {
            let o = Command::new("sh").arg("-c").arg(format!("cd {} && find . -type f -not -path './.git/*' | sort | xargs sha256sum && git status --porcelain", d.display())).output().unwrap();
            o.stdout
        };
        let dest_root = tempfile::tempdir().unwrap();
        let dest = dest_root.path().join("snap");
        let info = snapshot(d, &dest, false, &SnapshotLimits::default()).unwrap();
        let mut got = files_in(&dest);
        got.sort();
        assert_eq!(
            got,
            [".gitignore", "README.md", "src/lib.rs", "src/new.rs"],
            "{info:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("src/lib.rs")).unwrap(),
            "pub fn a() { /* edited */ }\n"
        );
        assert!(
            !dest.join(".env").exists()
                && !dest.join("keys/id_rsa").exists()
                && !dest.join("certs/server.pem").exists()
        );
        assert!(
            !dest.join("passwd-link").exists()
                && !dest.join("big.bin").exists()
                && !dest.join("build").exists()
        );
        let why: Vec<_> = info
            .skipped
            .iter()
            .map(|(p, w)| format!("{p}:{w}"))
            .collect();
        for want in [
            ".env:sensitive-name",
            "keys/id_rsa:sensitive-name",
            "passwd-link:not-a-regular-file",
            "big.bin:file-too-large",
        ] {
            assert!(why.iter().any(|x| x == want), "{why:?}");
        }
        assert_eq!((info.origin_dirty, info.files), (Some(true), 4));
        assert!(info.origin_head.is_some() && info.commit.len() == 40);
        // the snapshot repo is clean and at that commit; the original is byte-identical
        let (_, st) = run_git(&dest, &["status", "--porcelain"]).unwrap();
        assert!(st.is_empty());
        let after = Command::new("sh").arg("-c").arg(format!("cd {} && find . -type f -not -path './.git/*' | sort | xargs sha256sum && git status --porcelain", d.display())).output().unwrap().stdout;
        assert_eq!(before, after);
    }

    #[test]
    fn a_plain_folder_node_dependencies_limits_and_fingerprints() {
        let o = tempfile::tempdir().unwrap();
        let d = o.path();
        w(d, "index.js", "console.log(1)\n");
        w(d, "package.json", "{}");
        w(d, "node_modules/dep/index.js", "module.exports=1\n");
        w(d, "node_modules/dep/.env", "SECRET=1\n");
        w(d, "target/x", "build output");
        let dr = tempfile::tempdir().unwrap();
        let plain = snapshot(d, &dr.path().join("a"), false, &SnapshotLimits::default()).unwrap();
        assert_eq!(plain.origin_head, None);
        let mut f = files_in(&dr.path().join("a"));
        f.sort();
        assert_eq!(f, ["index.js", "package.json"]);
        let node = snapshot(d, &dr.path().join("b"), true, &SnapshotLimits::default()).unwrap();
        let mut f = files_in(&dr.path().join("b"));
        f.sort();
        assert_eq!(
            f,
            ["index.js", "node_modules/dep/index.js", "package.json"],
            "deps included, their secrets not: {node:?}"
        );
        // limits fail closed and leave no destination behind
        let lim = SnapshotLimits {
            max_files: 1,
            ..Default::default()
        };
        assert_eq!(
            snapshot(d, &dr.path().join("c"), false, &lim)
                .unwrap_err()
                .code,
            "too-many-files"
        );
        assert!(!dr.path().join("c").exists());
        let lim = SnapshotLimits {
            max_total_bytes: 5,
            ..Default::default()
        };
        assert_eq!(
            snapshot(d, &dr.path().join("d"), false, &lim)
                .unwrap_err()
                .code,
            "too-large"
        );
        assert!(
            snapshot(d, &dr.path().join("a"), false, &SnapshotLimits::default()).is_err(),
            "never overwrites"
        );
        // the fingerprint moves when a file changes and not otherwise
        let l = SnapshotLimits::default();
        let f1 = fingerprint(d, &l).unwrap();
        assert_eq!(f1, fingerprint(d, &l).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(20));
        w(d, "index.js", "console.log(2)\n");
        assert_ne!(f1, fingerprint(d, &l).unwrap());
        w(d, "target/other", "ignored");
        let f2 = fingerprint(d, &l).unwrap();
        w(d, "target/other2", "ignored too");
        assert_eq!(
            f2,
            fingerprint(d, &l).unwrap(),
            "build output does not count as a change"
        );
    }

    #[test]
    fn adoption_applies_all_or_nothing_only_to_an_unchanged_folder_and_never_to_protected_paths() {
        let o = tempfile::tempdir().unwrap();
        let d = o.path();
        w(d, "src/lib.rs", "pub fn a() -> i32 {\n    1\n}\n");
        w(d, "src/other.rs", "x\n");
        let lim = SnapshotLimits::default();
        let dr = tempfile::tempdir().unwrap();
        let info = snapshot(d, &dr.path().join("s"), false, &lim).unwrap();
        // a Nexus-style patch against the snapshot
        let patch = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n pub fn a() -> i32 {\n-    1\n+    2\n }\n";
        // changed since the snapshot: refused, nothing written
        w(d, "src/other.rs", "changed\n");
        let e = apply_patch(d, &info.fingerprint, patch, &lim).unwrap_err();
        assert_eq!(e.code, "origin-changed");
        assert_eq!(
            std::fs::read_to_string(d.join("src/lib.rs")).unwrap(),
            "pub fn a() -> i32 {\n    1\n}\n"
        );
        // unchanged: applied
        let info = snapshot(d, &dr.path().join("s2"), false, &lim).unwrap();
        let files = apply_patch(d, &info.fingerprint, patch, &lim).unwrap();
        assert_eq!(files, ["src/lib.rs"]);
        assert!(std::fs::read_to_string(d.join("src/lib.rs"))
            .unwrap()
            .contains("    2"));
        // a conflicting patch is rejected whole (second hunk target missing => nothing applied)
        let info = snapshot(d, &dr.path().join("s3"), false, &lim).unwrap();
        let bad = format!("{patch}diff --git a/src/missing.rs b/src/missing.rs\n--- a/src/missing.rs\n+++ b/src/missing.rs\n@@ -1 +1 @@\n-nope\n+yes\n");
        assert_eq!(
            apply_patch(d, &info.fingerprint, &bad, &lim)
                .unwrap_err()
                .code,
            "patch-conflict"
        );
        // protected / hidden / escaping paths, renames and binary patches are refused before git runs
        for p in [
            "diff --git a/build.rs b/build.rs\n--- a/build.rs\n+++ b/build.rs\n",
            "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n",
            "diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n",
            "diff --git a/src/a.rs b/src/b.rs\nrename from src/a.rs\nrename to src/b.rs\n",
            "diff --git a/src/lib.rs b/src/lib.rs\nGIT binary patch\n",
        ] {
            assert_eq!(
                apply_patch(d, &info.fingerprint, p, &lim).unwrap_err().code,
                "bad-patch",
                "{p}"
            );
        }
        assert_eq!(
            apply_patch(d, &info.fingerprint, "nothing here", &lim)
                .unwrap_err()
                .code,
            "bad-patch"
        );
    }
}
