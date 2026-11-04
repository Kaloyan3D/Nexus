//! Deterministic, bounded project manifests: what is in a folder, hashed, with everything left
//! out named and counted. Used on the Mac (project scan, baseline) and on the guest (export diff).

use super::policy::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub size: u64,
    /// Lower-case hex SHA-256 of the content.
    pub sha256: String,
    /// Owner-executable bit (the only mode bit that is synchronized).
    pub exec: bool,
}

/// Project-relative path (`/`-separated) → entry, in byte order.
pub type Files = BTreeMap<String, FileEntry>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkipNote {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Scan {
    pub files: Files,
    /// The first skipped entries (bounded); the total is exact.
    pub skipped: Vec<SkipNote>,
    pub skipped_total: usize,
    pub total_bytes: u64,
}

/// A scan that cannot honestly describe the folder. Never degraded to a partial snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScanError {
    TooManyFiles { limit: usize },
    TooLarge { limit: u64 },
    CaseCollision { a: String, b: String },
    NormalizationCollision { a: String, b: String },
    Unreadable { path: String, message: String },
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanError::TooManyFiles { limit } => write!(f, "the project has more than {limit} files"),
            ScanError::TooLarge { limit } => write!(f, "the project is larger than {} MiB", limit / 1024 / 1024),
            ScanError::CaseCollision { a, b } => write!(f, "\"{a}\" and \"{b}\" differ only by letter case, which a Mac and the Linux engine treat differently"),
            ScanError::NormalizationCollision { a, b } => write!(f, "\"{a}\" and \"{b}\" are the same name written in two Unicode forms"),
            ScanError::Unreadable { path, message } => write!(f, "cannot read \"{path}\": {message}"),
        }
    }
}

fn note(scan: &mut Scan, path: &str, reason: SkipReason) {
    scan.skipped_total += 1;
    if scan.skipped.len() < 100 {
        scan.skipped.push(SkipNote {
            path: path.to_owned(),
            reason,
        });
    }
}

pub fn hash_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((n, hex::encode(h.finalize())))
}

/// A symlink is "unsafe" when its target is absolute or leaves the project lexically.
fn symlink_is_safe(rel: &str, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut depth = rel.split('/').count() as i64 - 1; // directories above the link
    for c in target.components() {
        match c {
            std::path::Component::Normal(_) => depth += 1,
            std::path::Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            std::path::Component::CurDir => {}
            _ => return false,
        }
    }
    true
}

/// Scan `root` deterministically. Symlinks are never followed.
pub fn scan(root: &Path) -> Result<Scan, ScanError> {
    let mut out = Scan::default();
    let mut seen: BTreeMap<String, String> = BTreeMap::new(); // fold(rel) -> rel (files and directories)
    walk(root, "", &mut out, &mut seen)?;
    Ok(out)
}

fn unreadable(path: &str, e: impl std::fmt::Display) -> ScanError {
    ScanError::Unreadable {
        path: path.to_owned(),
        message: e.to_string(),
    }
}

fn walk(
    dir: &Path,
    prefix: &str,
    out: &mut Scan,
    seen: &mut BTreeMap<String, String>,
) -> Result<(), ScanError> {
    let rd = std::fs::read_dir(dir)
        .map_err(|e| unreadable(if prefix.is_empty() { "." } else { prefix }, e))?;
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for e in rd {
        let e = e.map_err(|e| unreadable(prefix, e))?;
        let name = match e.file_name().into_string() {
            Ok(n) => n,
            Err(raw) => {
                let shown = format!("{prefix}{}", raw.to_string_lossy());
                note(out, &shown, SkipReason::InvalidName);
                continue;
            }
        };
        entries.push((name, e.path()));
    }
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for (name, path) in entries {
        let rel = format!("{prefix}{name}");
        let md = std::fs::symlink_metadata(&path).map_err(|e| unreadable(&rel, e))?;
        let ft = md.file_type();
        if ft.is_dir() {
            if let Some(why) = skip_dir(&name) {
                note(out, &format!("{rel}/"), why);
                continue;
            }
            register(seen, &rel)?;
            walk(&path, &format!("{rel}/"), out, seen)?;
        } else if ft.is_symlink() {
            let target = std::fs::read_link(&path).map_err(|e| unreadable(&rel, e))?;
            let why = if symlink_is_safe(&rel, &target) {
                SkipReason::Symlink
            } else {
                SkipReason::UnsafeSymlink
            };
            note(out, &rel, why);
        } else if ft.is_file() {
            if let Some(why) = skip_file_name(&name) {
                note(out, &rel, why);
                continue;
            }
            if validate_rel(&rel).is_err() {
                note(out, &rel, SkipReason::InvalidName);
                continue;
            }
            if md.len() > MAX_FILE_BYTES {
                note(out, &rel, SkipReason::TooLarge);
                continue;
            }
            register(seen, &rel)?;
            if out.files.len() >= MAX_FILES {
                return Err(ScanError::TooManyFiles { limit: MAX_FILES });
            }
            out.total_bytes += md.len();
            if out.total_bytes > MAX_TOTAL_BYTES {
                return Err(ScanError::TooLarge {
                    limit: MAX_TOTAL_BYTES,
                });
            }
            let (size, sha256) = hash_file(&path).map_err(|e| unreadable(&rel, e))?;
            out.files.insert(
                rel,
                FileEntry {
                    size,
                    sha256,
                    exec: md.permissions().mode() & 0o100 != 0,
                },
            );
        } else {
            // sockets, FIFOs, devices and anything else that is not a regular file
            note(out, &rel, SkipReason::NotRegularFile);
        }
    }
    Ok(())
}

fn register(seen: &mut BTreeMap<String, String>, rel: &str) -> Result<(), ScanError> {
    let key = fold(rel);
    match seen.get(&key) {
        Some(prev) if prev != rel => {
            // same fold: distinguish a pure case difference from a normalization difference
            let lower_equal = prev.to_lowercase() == rel.to_lowercase();
            Err(if lower_equal {
                ScanError::CaseCollision {
                    a: prev.clone(),
                    b: rel.to_owned(),
                }
            } else {
                ScanError::NormalizationCollision {
                    a: prev.clone(),
                    b: rel.to_owned(),
                }
            })
        }
        _ => {
            seen.insert(key, rel.to_owned());
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    Add,
    Modify,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
    /// The entry in the baseline (absent for `Add`).
    pub old: Option<FileEntry>,
    /// The entry after the change (absent for `Delete`).
    pub new: Option<FileEntry>,
}

/// Changes that turn `base` into `now`, in path order.
pub fn diff(base: &Files, now: &Files) -> Vec<Change> {
    let mut out = Vec::new();
    for (p, n) in now {
        match base.get(p) {
            None => out.push(Change {
                path: p.clone(),
                kind: ChangeKind::Add,
                old: None,
                new: Some(n.clone()),
            }),
            Some(o) if o != n => out.push(Change {
                path: p.clone(),
                kind: ChangeKind::Modify,
                old: Some(o.clone()),
                new: Some(n.clone()),
            }),
            _ => {}
        }
    }
    for (p, o) in base {
        if !now.contains_key(p) {
            out.push(Change {
                path: p.clone(),
                kind: ChangeKind::Delete,
                old: Some(o.clone()),
                new: None,
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Digest of a manifest (order-independent of insertion; BTreeMap is ordered).
pub fn digest(files: &Files) -> String {
    let mut h = Sha256::new();
    for (p, e) in files {
        h.update(p.as_bytes());
        h.update([0]);
        h.update(e.size.to_le_bytes());
        h.update(e.sha256.as_bytes());
        h.update([e.exec as u8]);
    }
    hex::encode(h.finalize())
}

/// Digest of a change list (binds an export plan to what is later applied).
pub fn change_digest(changes: &[Change]) -> String {
    let mut h = Sha256::new();
    for c in changes {
        h.update(c.path.as_bytes());
        h.update([0, c.kind as u8]);
        h.update(
            c.old
                .as_ref()
                .map(|e| e.sha256.as_str())
                .unwrap_or("-")
                .as_bytes(),
        );
        h.update(
            c.new
                .as_ref()
                .map(|e| e.sha256.as_str())
                .unwrap_or("-")
                .as_bytes(),
        );
        h.update([c.new.as_ref().map(|e| e.exec as u8).unwrap_or(2)]);
    }
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn w(d: &Path, rel: &str, c: &str) {
        let p = d.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, c).unwrap();
    }

    #[test]
    fn scan_is_deterministic_and_filters() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        w(r, "src/main.rs", "fn main(){}");
        w(r, "README.md", "hi");
        w(r, ".env", "SECRET=1");
        w(r, ".git/config", "x");
        w(r, "node_modules/a/i.js", "x");
        w(r, "target/debug/x", "x");
        w(r, ".DS_Store", "x");
        w(r, "key.pem", "x");
        std::os::unix::fs::symlink("README.md", r.join("link")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", r.join("evil")).unwrap();
        std::os::unix::fs::symlink("../../outside", r.join("src/up")).unwrap();
        fs::write(r.join("big.bin"), vec![0u8; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let a = scan(r).unwrap();
        let b = scan(r).unwrap();
        assert_eq!(a.files, b.files);
        assert_eq!(
            a.files.keys().collect::<Vec<_>>(),
            vec!["README.md", "src/main.rs"]
        );
        let why = |p: &str| a.skipped.iter().find(|s| s.path == p).map(|s| s.reason);
        assert_eq!(why(".env"), Some(SkipReason::SensitiveName));
        assert_eq!(why(".git/"), Some(SkipReason::BuildOrCacheDirectory));
        assert_eq!(
            why("node_modules/"),
            Some(SkipReason::BuildOrCacheDirectory)
        );
        assert_eq!(why("link"), Some(SkipReason::Symlink));
        assert_eq!(why("evil"), Some(SkipReason::UnsafeSymlink));
        assert_eq!(why("src/up"), Some(SkipReason::UnsafeSymlink));
        assert_eq!(why("big.bin"), Some(SkipReason::TooLarge));
        assert_eq!(why(".DS_Store"), Some(SkipReason::OsMetadata));
        assert!(a.skipped_total >= 10);
    }

    #[test]
    fn collisions_are_errors_not_silent_drops() {
        let d = tempfile::tempdir().unwrap();
        w(d.path(), "Readme.md", "a");
        w(d.path(), "README.md", "b");
        // a case-insensitive host cannot even hold both; on a case-sensitive one this must be reported
        if d.path().join("Readme.md").exists() && fs::read_dir(d.path()).unwrap().count() == 2 {
            assert!(matches!(
                scan(d.path()),
                Err(ScanError::CaseCollision { .. })
            ));
        }
        let d = tempfile::tempdir().unwrap();
        w(d.path(), "caf\u{e9}.txt", "a");
        w(d.path(), "cafe\u{301}.txt", "b");
        if fs::read_dir(d.path()).unwrap().count() == 2 {
            assert!(matches!(
                scan(d.path()),
                Err(ScanError::NormalizationCollision { .. })
            ));
        }
    }

    #[test]
    fn diff_finds_add_modify_delete_and_exec() {
        let e = |h: &str, x: bool| FileEntry {
            size: 1,
            sha256: h.into(),
            exec: x,
        };
        let base: Files = [
            ("a".into(), e("1", false)),
            ("b".into(), e("2", false)),
            ("c".into(), e("3", false)),
        ]
        .into();
        let now: Files = [
            ("a".into(), e("1", false)),
            ("b".into(), e("9", false)),
            ("c".into(), e("3", true)),
            ("d".into(), e("4", false)),
        ]
        .into();
        let d = diff(&base, &now);
        let kinds: Vec<_> = d.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("b", ChangeKind::Modify),
                ("c", ChangeKind::Modify),
                ("d", ChangeKind::Add)
            ]
        );
        let none = diff(&now, &base);
        assert!(none
            .iter()
            .any(|c| c.kind == ChangeKind::Delete && c.path == "d"));
        assert_ne!(change_digest(&d), change_digest(&none));
    }

    #[test]
    fn symlink_safety_is_lexical() {
        assert!(symlink_is_safe("a/b", Path::new("../x")));
        assert!(!symlink_is_safe("a/b", Path::new("../../x")));
        assert!(!symlink_is_safe("a", Path::new("/abs")));
        assert!(symlink_is_safe("a", Path::new("b/c")));
    }
}
