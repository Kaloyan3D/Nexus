//! Filesystem observation and the command-effects ledger (M3A).
//!
//! What a command did to a persistent workspace is OBSERVED, never assumed: the tree is described
//! before the process starts and again after its whole process tree has settled, and the two
//! descriptions are compared. The observer works only through the pinned workspace descriptor
//! (descriptor-relative `openat2`/`fstatat`, `O_NOFOLLOW`, no mount crossing, identity re-checked after
//! every open) and never consults the displayed project path after the process has started.
//!
//! * **Tier 1 - detailed.** Every ordinary entry is recorded with its type, size, permission bits, owner,
//!   link count, inode, `mtime`/`ctime` and (symlinks) target. Change detection uses `ctime`, which a
//!   process cannot set: a file whose content, mode or link count changed always shows a new `ctime`.
//!   Contents are NOT hashed before the command (no full-tree hashing); only files that changed are
//!   hashed afterwards, within a byte budget, and never a secret-shaped file.
//! * **Tier 2 - bounded.** Dependency and build directories (`node_modules`, `target`, `.venv`, `dist`, ...)
//!   and `.git` are summarised, not enumerated: entry count, newest times and a signature of what was seen,
//!   under a per-directory entry budget. A truncated summary says so.
//! * **Completeness is explicit.** Any skipped directory, unreadable or vanished entry, budget hit, mount
//!   crossing or identity change is recorded as a reason; a manifest with reasons is `complete: false`
//!   and no consumer may present its diff as exhaustive.
//!
//! Observation establishes TEMPORAL CORRELATION: these changes appeared while the command ran. It does not
//! prove that the command made each of them (a user's editor, a file watcher, or another Nexus operation
//! can write during the same window), and it says so in every record.

use crate::workspace::{
    fstat_fd, fstatat_nofollow, open_rel, Kind, NameClass, Workspace, WorkspacePolicy,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const MANIFEST_SCHEMA: &str = "nexus.fs-manifest/v1";
pub const RECORD_SCHEMA: &str = "nexus.command-effects/v1";
pub const ATTRIBUTION_NOTE: &str = "Observation shows that these changes appeared while the command ran (temporal correlation). It does not prove that the command made every one of them.";

/// Directory names summarised instead of enumerated (the stager's ignored set plus common caches).
const BULK_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
    ".tox",
    ".nuxt",
    ".parcel-cache",
];

/// Resource limits of one observation (configured by the daemon, never by a caller of the tool).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveBudget {
    /// Detailed entries across the whole tree.
    pub max_entries: u64,
    /// Entries examined inside ONE bulk directory.
    pub max_bulk_entries: u64,
    pub max_depth: u32,
    /// Wall-clock allowance of one observation.
    pub max_wall_ms: u64,
    /// Largest file that is hashed after the command.
    pub hash_file_max: u64,
    /// Bytes hashed after one command.
    pub hash_total_max: u64,
    /// Longest path list kept per category in a record (counts stay exact). The record FILE holds the full
    /// lists a guarded restore needs; journals and tool results carry only short summaries of them.
    pub list_cap: usize,
}

impl Default for ObserveBudget {
    fn default() -> Self {
        Self {
            max_entries: 200_000,
            max_bulk_entries: 5_000,
            max_depth: 64,
            max_wall_ms: 20_000,
            hash_file_max: 1024 * 1024,
            hash_total_max: 64 * 1024 * 1024,
            list_cap: 20_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rec {
    /// `f` file, `d` directory, `l` symlink, `o` other (fifo, socket, device)
    pub kind: String,
    pub size: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub nlink: u64,
    pub ino: u64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// Summary of a bulk directory (never enumerated in the record).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bulk {
    pub entries: u64,
    pub dirs: u64,
    pub newest_mtime_ns: i64,
    pub newest_ctime_ns: i64,
    /// sha256 over `(relative path, kind, size, mtime, ctime)` of what was examined, in sorted order.
    pub sig: String,
    /// The examination stopped at the budget: what lies beyond is not covered.
    pub truncated: bool,
    /// `.git`: a protected location.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub complete: bool,
    /// Why not (deduplicated, bounded).
    pub reasons: Vec<String>,
    pub unreadable: u64,
    pub vanished: u64,
    /// Bulk directories whose summary stopped at its budget. This is by design (tier 2 is bounded) and does
    /// NOT make the project-file observation incomplete, but it is always stated.
    #[serde(default)]
    pub bulk_truncated: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootId {
    pub dev: u64,
    pub ino: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: String,
    pub root: RootId,
    pub started_ms: u64,
    pub ended_ms: u64,
    pub entries: BTreeMap<String, Rec>,
    pub bulk: BTreeMap<String, Bulk>,
    pub completeness: Completeness,
    /// Stable digest of the observed STATE (stat-based identity, not a content digest).
    pub digest: String,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Dependency/build directory names (tier 2).
pub fn is_bulk_name_pub(n: &str) -> bool {
    is_bulk_name(n)
}

fn is_bulk_name(n: &str) -> bool {
    BULK_NAMES.contains(&n)
}

struct Acc {
    budget: ObserveBudget,
    t0: Instant,
    entries: BTreeMap<String, Rec>,
    bulk: BTreeMap<String, Bulk>,
    reasons: BTreeSet<String>,
    unreadable: u64,
    vanished: u64,
    count: u64,
    stop: bool,
    root_dev: u64,
}

impl Acc {
    fn reason(&mut self, r: String) {
        if self.reasons.len() < 24 {
            self.reasons.insert(r);
        }
    }
    fn time_up(&mut self) -> bool {
        if self.t0.elapsed().as_millis() as u64 > self.budget.max_wall_ms {
            self.reason("time-budget".into());
            self.stop = true;
        }
        self.stop
    }
}

fn kind_char(k: Kind) -> &'static str {
    match k {
        Kind::File => "f",
        Kind::Dir => "d",
        Kind::Symlink => "l",
        Kind::Special => "o",
    }
}

fn ns(v: i128) -> i64 {
    v.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

fn dir_names(fd: RawFd) -> Result<Vec<Vec<u8>>, i32> {
    let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if dup < 0 {
        return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
    }
    let dirp = unsafe { libc::fdopendir(dup) };
    if dirp.is_null() {
        unsafe { libc::close(dup) };
        return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
    }
    unsafe { libc::rewinddir(dirp) };
    let mut out = Vec::new();
    loop {
        let e = unsafe { libc::readdir(dirp) };
        if e.is_null() {
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*e).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            out.push(name.to_vec());
        }
    }
    unsafe { libc::closedir(dirp) };
    out.sort();
    Ok(out)
}

fn open_dir_checked(parent: RawFd, name: &CString) -> Result<OwnedFd, i32> {
    let fd = open_rel(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_owned()
    } else {
        format!("{rel}/{name}")
    }
}

/// Describe the tree below an open directory (tier 1), summarising bulk directories (tier 2).
fn walk(acc: &mut Acc, dirfd: RawFd, rel: &str, depth: u32) {
    if acc.stop {
        return;
    }
    if depth > acc.budget.max_depth {
        acc.reason(format!("depth:{rel}"));
        return;
    }
    let names = match dir_names(dirfd) {
        Ok(n) => n,
        Err(_) => {
            acc.unreadable += 1;
            acc.reason(format!("unreadable:{rel}"));
            return;
        }
    };
    for raw in names {
        if acc.stop {
            return;
        }
        let Ok(name) = std::str::from_utf8(&raw) else {
            acc.unreadable += 1;
            acc.reason("non-utf8-name".into());
            continue;
        };
        acc.count += 1;
        if acc.count > acc.budget.max_entries {
            acc.reason("entry-budget".into());
            acc.stop = true;
            return;
        }
        if acc.count.is_multiple_of(256) && acc.time_up() {
            return;
        }
        let path = join(rel, name);
        let Ok(c) = CString::new(raw.clone()) else {
            continue;
        };
        let st = match fstatat_nofollow(dirfd, &c) {
            Ok(s) => s,
            Err(libc::ENOENT) => {
                acc.vanished += 1;
                acc.reason(format!("vanished:{path}"));
                continue;
            }
            Err(_) => {
                acc.unreadable += 1;
                acc.reason(format!("unreadable:{path}"));
                continue;
            }
        };
        let mut rec = Rec {
            kind: kind_char(st.kind).into(),
            size: st.size,
            mode: st.mode,
            uid: st.uid,
            gid: st.gid,
            nlink: st.nlink,
            ino: st.ino,
            mtime_ns: ns(st.mtime_ns),
            ctime_ns: ns(st.ctime_ns),
            target: None,
        };
        match st.kind {
            Kind::Symlink => {
                let mut buf = vec![0u8; 4096];
                let n = unsafe {
                    libc::readlinkat(dirfd, c.as_ptr(), buf.as_mut_ptr().cast(), buf.len())
                };
                if n >= 0 {
                    buf.truncate(n as usize);
                    rec.target = Some(String::from_utf8_lossy(&buf).into_owned());
                } else {
                    acc.unreadable += 1;
                    acc.reason(format!("unreadable:{path}"));
                }
            }
            Kind::Dir => {
                if st.dev != acc.root_dev {
                    acc.reason(format!("mount-crossing:{path}"));
                    acc.entries.insert(path, rec);
                    continue;
                }
                let bulk = is_bulk_name(name) || name == ".git";
                let sub = open_dir_checked(dirfd, &c);
                acc.entries.insert(path.clone(), rec);
                match sub {
                    Ok(fd) => {
                        use std::os::fd::AsRawFd;
                        // the descriptor must be the very directory that was examined (no swap in between)
                        match fstat_fd(fd.as_raw_fd()) {
                            Ok(now) if now.ino == st.ino && now.dev == st.dev => {}
                            _ => {
                                acc.reason(format!("changed-during-observation:{path}"));
                                continue;
                            }
                        }
                        if bulk {
                            let b = summarise_bulk(acc, fd.as_raw_fd(), name == ".git");
                            acc.bulk.insert(path, b);
                        } else {
                            walk(acc, fd.as_raw_fd(), &path, depth + 1);
                        }
                    }
                    Err(libc::EXDEV) => acc.reason(format!("mount-crossing:{path}")),
                    Err(_) => {
                        acc.unreadable += 1;
                        acc.reason(format!("unreadable:{path}"));
                    }
                }
                continue;
            }
            _ => {}
        }
        acc.entries.insert(path, rec);
    }
}

/// Tier 2: examine a bulk directory under its own entry budget.
fn summarise_bulk(acc: &mut Acc, fd: RawFd, protected: bool) -> Bulk {
    let mut h = Sha256::new();
    let mut b = Bulk {
        entries: 0,
        dirs: 0,
        newest_mtime_ns: 0,
        newest_ctime_ns: 0,
        sig: String::new(),
        truncated: false,
        protected,
    };
    let budget = acc.budget.max_bulk_entries;
    let (dev, deadline) = (acc.root_dev, acc.budget.max_wall_ms);
    let t0 = acc.t0;
    #[allow(clippy::too_many_arguments)]
    fn rec(
        fd: RawFd,
        rel: &str,
        depth: u32,
        h: &mut Sha256,
        b: &mut Bulk,
        budget: u64,
        dev: u64,
        t0: Instant,
        deadline: u64,
    ) {
        if b.truncated {
            return;
        }
        if depth > 48 {
            b.truncated = true;
            return;
        }
        let Ok(names) = dir_names(fd) else {
            b.truncated = true;
            return;
        };
        for raw in names {
            if b.truncated {
                return;
            }
            if b.entries >= budget
                || (b.entries.is_multiple_of(512) && t0.elapsed().as_millis() as u64 > deadline)
            {
                b.truncated = true;
                return;
            }
            let Ok(c) = CString::new(raw.clone()) else {
                continue;
            };
            let Ok(st) = fstatat_nofollow(fd, &c) else {
                b.truncated = true; // an entry that cannot be examined means the summary is not exhaustive
                continue;
            };
            b.entries += 1;
            let nm = String::from_utf8_lossy(&raw).into_owned();
            let path = if rel.is_empty() {
                nm
            } else {
                format!("{rel}/{nm}")
            };
            let (m, c2) = (ns(st.mtime_ns), ns(st.ctime_ns));
            b.newest_mtime_ns = b.newest_mtime_ns.max(m);
            b.newest_ctime_ns = b.newest_ctime_ns.max(c2);
            h.update(
                format!("{path}\0{}\0{}\0{m}\0{c2}\n", kind_char(st.kind), st.size).as_bytes(),
            );
            if st.kind == Kind::Dir {
                b.dirs += 1;
                if st.dev != dev {
                    continue;
                }
                if let Ok(sub) = open_dir_checked(fd, &c) {
                    use std::os::fd::AsRawFd;
                    rec(
                        sub.as_raw_fd(),
                        &path,
                        depth + 1,
                        h,
                        b,
                        budget,
                        dev,
                        t0,
                        deadline,
                    );
                }
            }
        }
    }
    rec(fd, "", 0, &mut h, &mut b, budget, dev, t0, deadline);
    b.sig = hex::encode(h.finalize());
    b
}

fn manifest_digest(
    entries: &BTreeMap<String, Rec>,
    bulk: &BTreeMap<String, Bulk>,
    c: &Completeness,
) -> String {
    let mut h = Sha256::new();
    h.update(MANIFEST_SCHEMA.as_bytes());
    h.update(b"\n");
    for (p, r) in entries {
        h.update(
            format!(
                "{p}\0{}\0{}\0{}\0{}:{}\0{}\0{}\0{}\0{}\0{}\n",
                r.kind,
                r.size,
                r.mode,
                r.uid,
                r.gid,
                r.nlink,
                r.ino,
                r.mtime_ns,
                r.ctime_ns,
                r.target.as_deref().unwrap_or("")
            )
            .as_bytes(),
        );
    }
    for (p, b) in bulk {
        h.update(
            format!(
                "B\0{p}\0{}\0{}\0{}\0{}\0{}\0{}\n",
                b.entries, b.dirs, b.newest_mtime_ns, b.newest_ctime_ns, b.sig, b.truncated
            )
            .as_bytes(),
        );
    }
    h.update(
        format!(
            "C\0{}\0{}\0{}\n",
            c.complete,
            c.reasons.join("|"),
            c.bulk_truncated
        )
        .as_bytes(),
    );
    hex::encode(h.finalize())
}

/// Observe the tree below the workspace's pinned root. Never fails: whatever could not be examined is
/// recorded as a reason and the manifest says `complete: false`.
pub fn observe(ws: &Workspace, budget: &ObserveBudget) -> Manifest {
    let started_ms = now_ms();
    let dup = unsafe { libc::fcntl(ws.root_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    let mut acc = Acc {
        budget: budget.clone(),
        t0: Instant::now(),
        entries: BTreeMap::new(),
        bulk: BTreeMap::new(),
        reasons: BTreeSet::new(),
        unreadable: 0,
        vanished: 0,
        count: 0,
        stop: false,
        root_dev: 0,
    };
    let mut root = RootId { dev: 0, ino: 0 };
    if dup < 0 {
        acc.reason("root-unavailable".into());
    } else {
        let owned = unsafe { OwnedFd::from_raw_fd(dup) };
        use std::os::fd::AsRawFd;
        match fstat_fd(owned.as_raw_fd()) {
            Ok(st) => {
                root = RootId {
                    dev: st.dev,
                    ino: st.ino,
                };
                acc.root_dev = st.dev;
                walk(&mut acc, owned.as_raw_fd(), "", 0);
            }
            Err(_) => acc.reason("root-unreadable".into()),
        }
    }
    let completeness = Completeness {
        complete: acc.reasons.is_empty(),
        reasons: acc.reasons.iter().cloned().collect(),
        unreadable: acc.unreadable,
        vanished: acc.vanished,
        bulk_truncated: acc.bulk.values().filter(|b| b.truncated).count() as u64,
    };
    let digest = manifest_digest(&acc.entries, &acc.bulk, &completeness);
    Manifest {
        schema: MANIFEST_SCHEMA.into(),
        root,
        started_ms,
        ended_ms: now_ms(),
        entries: acc.entries,
        bulk: acc.bulk,
        completeness,
        digest,
    }
}

// ----------------------------------------------------------------------------- effects

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathList {
    /// Exact number of paths in the category.
    pub count: u64,
    pub paths: Vec<String>,
    /// `paths` holds fewer than `count`.
    pub truncated: bool,
}

impl PathList {
    fn from(mut v: Vec<String>, cap: usize) -> Self {
        v.sort();
        let count = v.len() as u64;
        let truncated = v.len() > cap;
        v.truncate(cap);
        Self {
            count,
            paths: v,
            truncated,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaChange {
    pub path: String,
    /// `mode`, `owner`, `ctime-only` (link count or other metadata changed, content did not)
    pub what: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub path: String,
    pub target: String,
    /// The target leaves the workspace (absolute, or climbs above the root).
    pub escapes_root: bool,
    /// `created` | `changed`
    pub change: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkChange {
    pub path: String,
    pub before: Option<BulkBrief>,
    pub after: Option<BulkBrief>,
    /// Both summaries covered everything they examined (not truncated).
    pub exhaustive: bool,
    pub protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkBrief {
    pub entries: u64,
    pub dirs: u64,
    pub newest_ctime_ns: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Protected {
    pub path: String,
    /// `git` | `secret-name` | `build-steering`
    pub rule: String,
    /// `created` | `modified` | `deleted` | `metadata` | `bulk`
    pub change: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub from: String,
    pub to: String,
    pub evidence: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectSet {
    pub created: PathList,
    pub modified: PathList,
    pub deleted: PathList,
    pub created_dirs: PathList,
    pub deleted_dirs: PathList,
    pub metadata_changed: Vec<MetaChange>,
    pub symlinks: Vec<LinkInfo>,
    /// Files with more than one link that appeared, changed, or whose link count changed: a write through
    /// one name changes the other.
    pub hardlink_risks: PathList,
    /// Fifos, sockets or devices that appeared.
    pub specials_created: PathList,
    pub protected: Vec<Protected>,
    pub bulk_changed: Vec<BulkChange>,
    /// Deleted + created pairs sharing an inode, size and mtime. Reported ALSO as delete/create:
    /// identity is only evidence, not proof.
    pub likely_renames: Vec<Rename>,
    /// sha256 of the post-image of created/modified regular files (bounded; absent = not hashed)
    pub post_sha256: BTreeMap<String, String>,
    /// A category list is capped or a manifest was incomplete: the lists are not exhaustive.
    pub lists_may_be_incomplete: bool,
}

fn protected_rule(path: &str) -> Option<&'static str> {
    let pol = WorkspacePolicy::default();
    let mut rule = None;
    for c in path.split('/') {
        if c == ".git" {
            return Some("git");
        }
        if pol.classify_name(c) == NameClass::Sensitive {
            rule = Some("secret-name");
        }
    }
    if rule.is_none() {
        let last = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        if crate::protect::PROTECTED_NAMES.contains(&last.as_str()) {
            rule = Some("build-steering");
        }
    }
    rule
}

fn escapes(path: &str, target: &str) -> bool {
    if target.starts_with('/') {
        return true;
    }
    let mut depth = path.split('/').count() as i64 - 1; // directories above the link inside the root
    for c in target.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

fn brief(b: &Bulk) -> BulkBrief {
    BulkBrief {
        entries: b.entries,
        dirs: b.dirs,
        newest_ctime_ns: b.newest_ctime_ns,
        truncated: b.truncated,
    }
}

/// Compare two manifests of the same workspace. Pure; hashing of changed files is a separate step.
pub fn diff(pre: &Manifest, post: &Manifest, budget: &ObserveBudget) -> (EffectSet, Vec<String>) {
    let cap = budget.list_cap;
    let (mut created, mut modified, mut deleted) = (vec![], vec![], vec![]);
    let (mut cdirs, mut ddirs, mut hard, mut specials) = (vec![], vec![], vec![], vec![]);
    let (mut meta, mut links, mut prot) = (vec![], vec![], vec![]);
    for (p, b) in &post.entries {
        match pre.entries.get(p) {
            None => {
                match b.kind.as_str() {
                    "d" => cdirs.push(p.clone()),
                    "o" => {
                        specials.push(p.clone());
                        created.push(p.clone());
                    }
                    "l" => {
                        links.push(LinkInfo {
                            path: p.clone(),
                            target: b.target.clone().unwrap_or_default(),
                            escapes_root: escapes(p, b.target.as_deref().unwrap_or("")),
                            change: "created".into(),
                        });
                        created.push(p.clone());
                    }
                    _ => {
                        if b.nlink > 1 {
                            hard.push(p.clone());
                        }
                        created.push(p.clone());
                    }
                }
                if let Some(r) = protected_rule(p) {
                    prot.push(Protected {
                        path: p.clone(),
                        rule: r.into(),
                        change: "created".into(),
                    });
                }
            }
            Some(a) if a == b => {}
            Some(a) => {
                let mut what = vec![];
                if a.mode != b.mode {
                    what.push("mode".to_owned());
                }
                if a.uid != b.uid || a.gid != b.gid {
                    what.push("owner".to_owned());
                }
                let type_changed = a.kind != b.kind;
                let content = !type_changed
                    && b.kind == "f"
                    && (a.size != b.size || a.mtime_ns != b.mtime_ns);
                let link_changed = b.kind == "l" && a.target != b.target;
                if type_changed {
                    // a different kind of object under the same name: delete + create
                    deleted.push(p.clone());
                    created.push(p.clone());
                } else if content {
                    modified.push(p.clone());
                    if b.nlink > 1 {
                        hard.push(p.clone());
                    }
                } else if link_changed {
                    links.push(LinkInfo {
                        path: p.clone(),
                        target: b.target.clone().unwrap_or_default(),
                        escapes_root: escapes(p, b.target.as_deref().unwrap_or("")),
                        change: "changed".into(),
                    });
                }
                if b.kind == "f" && a.nlink != b.nlink {
                    hard.push(p.clone());
                    what.push("links".to_owned());
                }
                if what.is_empty()
                    && !content
                    && !link_changed
                    && !type_changed
                    && a.ctime_ns != b.ctime_ns
                    && b.kind != "d"
                {
                    what.push("ctime-only".to_owned());
                }
                let has_meta = !what.is_empty();
                if has_meta {
                    meta.push(MetaChange {
                        path: p.clone(),
                        what,
                    });
                }
                if content || link_changed || type_changed || has_meta {
                    if let Some(r) = protected_rule(p) {
                        let ch = if content { "modified" } else { "metadata" };
                        prot.push(Protected {
                            path: p.clone(),
                            rule: r.into(),
                            change: ch.into(),
                        });
                    }
                }
            }
        }
    }
    for (p, a) in &pre.entries {
        if !post.entries.contains_key(p) {
            if a.kind == "d" {
                ddirs.push(p.clone());
            } else {
                deleted.push(p.clone());
            }
            if let Some(r) = protected_rule(p) {
                prot.push(Protected {
                    path: p.clone(),
                    rule: r.into(),
                    change: "deleted".into(),
                });
            }
        }
    }
    // renames: a deleted regular file and a created one with the same inode, size and mtime
    let mut renames = vec![];
    for d in &deleted {
        let Some(a) = pre.entries.get(d) else {
            continue;
        };
        if a.kind != "f" {
            continue;
        }
        if let Some(c) = created.iter().find(|c| {
            post.entries.get(*c).is_some_and(|b| {
                b.kind == "f" && b.ino == a.ino && b.size == a.size && b.mtime_ns == a.mtime_ns
            })
        }) {
            renames.push(Rename {
                from: d.clone(),
                to: c.clone(),
                evidence: "same-inode-size-mtime".into(),
            });
        }
    }
    // bulk summaries
    let mut bulk_changed = vec![];
    let keys: BTreeSet<&String> = pre.bulk.keys().chain(post.bulk.keys()).collect();
    for k in keys {
        let (a, b) = (pre.bulk.get(k), post.bulk.get(k));
        if a == b {
            continue;
        }
        let protected = a.is_some_and(|x| x.protected) || b.is_some_and(|x| x.protected);
        if protected {
            prot.push(Protected {
                path: k.clone(),
                rule: "git".into(),
                change: "bulk".into(),
            });
        }
        bulk_changed.push(BulkChange {
            path: k.clone(),
            before: a.map(brief),
            after: b.map(brief),
            exhaustive: !a.is_some_and(|x| x.truncated) && !b.is_some_and(|x| x.truncated),
            protected,
        });
    }
    let capped = [
        &created, &modified, &deleted, &cdirs, &ddirs, &hard, &specials,
    ]
    .iter()
    .any(|v| v.len() > cap)
        || meta.len() > cap
        || links.len() > cap
        || prot.len() > cap;
    let changed_for_hash: Vec<String> = created
        .iter()
        .chain(modified.iter())
        .filter(|p| post.entries.get(*p).is_some_and(|r| r.kind == "f"))
        .cloned()
        .collect();
    meta.truncate(cap);
    links.truncate(cap);
    prot.truncate(cap);
    renames.truncate(cap);
    let fx = EffectSet {
        created: PathList::from(created, cap),
        modified: PathList::from(modified, cap),
        deleted: PathList::from(deleted, cap),
        created_dirs: PathList::from(cdirs, cap),
        deleted_dirs: PathList::from(ddirs, cap),
        metadata_changed: meta,
        symlinks: links,
        hardlink_risks: PathList::from(hard, cap),
        specials_created: PathList::from(specials, cap),
        protected: prot,
        bulk_changed,
        likely_renames: renames,
        post_sha256: BTreeMap::new(),
        lists_may_be_incomplete: capped
            || !pre.completeness.complete
            || !post.completeness.complete,
    };
    (fx, changed_for_hash)
}

/// sha256 of the files that appeared or changed (descriptor-relative, no symlinks, never a secret-shaped
/// file), within the byte budget. Files not hashed are simply absent from `post_sha256`.
pub fn hash_changed(ws: &Workspace, paths: &[String], fx: &mut EffectSet, budget: &ObserveBudget) {
    let pol = WorkspacePolicy::default();
    let mut total = 0u64;
    for p in paths {
        if fx.post_sha256.len() >= budget.list_cap {
            break;
        }
        if p.split('/')
            .any(|c| pol.classify_name(c) == NameClass::Sensitive)
        {
            continue;
        }
        if !fx.created.paths.contains(p) && !fx.modified.paths.contains(p) {
            continue;
        }
        let Some(fd) = open_rel_path(ws.root_raw_fd(), p) else {
            continue;
        };
        let mut f = std::fs::File::from(fd);
        let Ok(md) = f.metadata() else { continue };
        if !md.is_file()
            || md.len() > budget.hash_file_max
            || total + md.len() > budget.hash_total_max
        {
            continue;
        }
        let mut h = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut ok = true;
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => h.update(&buf[..n]),
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            total += md.len();
            fx.post_sha256.insert(p.clone(), hex::encode(h.finalize()));
        }
    }
}

/// Open `rel` (a normalized relative path) under `root` one component at a time with `RESOLVE_NO_SYMLINKS`.
pub(crate) fn open_rel_path(root: RawFd, rel: &str) -> Option<OwnedFd> {
    let comps: Vec<&str> = rel.split('/').collect();
    let mut cur = unsafe { libc::fcntl(root, libc::F_DUPFD_CLOEXEC, 3) };
    if cur < 0 {
        return None;
    }
    for (i, c) in comps.iter().enumerate() {
        if c.is_empty() || *c == "." || *c == ".." {
            unsafe { libc::close(cur) };
            return None;
        }
        let cs = CString::new(*c).ok()?;
        let last = i + 1 == comps.len();
        let flags = if last {
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
        } else {
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
        };
        let next = open_rel(cur, &cs, flags);
        unsafe { libc::close(cur) };
        cur = next.ok()?;
    }
    Some(unsafe { OwnedFd::from_raw_fd(cur) })
}

/// Open a directory below the pinned root (`""` = the root itself), never following a symlink.
pub(crate) fn open_dir_rel(root: RawFd, rel: &str) -> Option<OwnedFd> {
    let mut cur = unsafe { libc::fcntl(root, libc::F_DUPFD_CLOEXEC, 3) };
    if cur < 0 {
        return None;
    }
    if !rel.is_empty() {
        for c in rel.split('/') {
            if c.is_empty() || c == "." || c == ".." {
                unsafe { libc::close(cur) };
                return None;
            }
            let cs = CString::new(c).ok()?;
            let next = open_rel(
                cur,
                &cs,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            );
            unsafe { libc::close(cur) };
            cur = next.ok()?;
        }
    }
    Some(unsafe { OwnedFd::from_raw_fd(cur) })
}

/// The current state of one entry (`name` inside `dirfd`) in manifest form; `None` when it does not exist.
pub(crate) fn rec_at(dirfd: RawFd, name: &str) -> Result<Option<Rec>, i32> {
    let c = CString::new(name).map_err(|_| libc::EINVAL)?;
    let st = match fstatat_nofollow(dirfd, &c) {
        Ok(s) => s,
        Err(libc::ENOENT) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut rec = Rec {
        kind: kind_char(st.kind).into(),
        size: st.size,
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        nlink: st.nlink,
        ino: st.ino,
        mtime_ns: ns(st.mtime_ns),
        ctime_ns: ns(st.ctime_ns),
        target: None,
    };
    if st.kind == Kind::Symlink {
        let mut buf = vec![0u8; 4096];
        let n = unsafe { libc::readlinkat(dirfd, c.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
        if n >= 0 {
            buf.truncate(n as usize);
            rec.target = Some(String::from_utf8_lossy(&buf).into_owned());
        }
    }
    Ok(Some(rec))
}

// ----------------------------------------------------------------------------- the ledger record

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestBrief {
    pub digest: String,
    pub entries: u64,
    pub bulk_dirs: u64,
    pub complete: bool,
    pub reasons: Vec<String>,
    pub bulk_truncated: u64,
}

impl ManifestBrief {
    pub fn of(m: &Manifest) -> Self {
        Self {
            digest: m.digest.clone(),
            entries: m.entries.len() as u64,
            bulk_dirs: m.bulk.len() as u64,
            complete: m.completeness.complete,
            reasons: m.completeness.reasons.clone(),
            bulk_truncated: m.completeness.bulk_truncated,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessState {
    /// The process ended by itself or was ended by the supervisor (not: still running or unknown).
    pub exited: bool,
    /// `exited` | `signaled` | `timeout` | `cancelled` | `revoked` | `memory-limit` | `process-limit` | `unknown`
    pub how: String,
    pub exit_code: Option<i64>,
    /// The whole process tree is gone (the execution cgroup was emptied) before the post manifest.
    pub settled: bool,
}

/// One observed execution. Inspectable evidence; it is NOT an authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectsRecord {
    pub schema: String,
    pub execution_id: String,
    pub task_instance_id: String,
    pub command_id: String,
    pub workspace: RootId,
    /// The standing grant the command ran under, as sealed by the Kernel (absent = none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<serde_json::Value>,
    pub fs_scope: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    pub pre: ManifestBrief,
    pub post: Option<ManifestBrief>,
    pub process: ProcessState,
    pub effects: EffectSet,
    /// `observed` (both manifests complete, process ended and settled normally) | `partial` (complete
    /// evidence of a command that did not finish normally) | `uncertain` (incomplete, unsettled, or recovered).
    pub outcome: String,
    pub outcome_reasons: Vec<String>,
    /// M3B: the checkpoint taken before the command (bounded description; the index is the authority).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<serde_json::Value>,
    /// M3B: for every observed modification/deletion, whether its original is recoverable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recoverability: Option<crate::checkpoint::Recoverability>,
    /// M3B: the observed post state of created/modified/changed entries (the guarded restore compares
    /// the current filesystem with it to find later edits).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub post_state: BTreeMap<String, Rec>,
    /// Where the time of an in-place execution went (protection scan, observation, checkpoint, launch+run).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub timing_ms: BTreeMap<String, u64>,
    /// Always `temporal`.
    pub attribution: String,
    pub note: String,
    pub digest: String,
}

impl EffectsRecord {
    pub fn compute_digest(&self) -> String {
        let mut c = self.clone();
        c.digest = String::new();
        hex::encode(Sha256::digest(serde_json::to_vec(&c).unwrap_or_default()))
    }
}

/// The observed post state of the entries a restore will look at.
pub fn post_state_of(post: &Manifest, fx: &EffectSet) -> BTreeMap<String, Rec> {
    let mut out = BTreeMap::new();
    for p in fx
        .created
        .paths
        .iter()
        .chain(fx.modified.paths.iter())
        .chain(fx.metadata_changed.iter().map(|m| &m.path))
        .chain(fx.symlinks.iter().map(|l| &l.path))
    {
        if let Some(r) = post.entries.get(p) {
            out.insert(p.clone(), r.clone());
        }
    }
    out
}

/// Decide the outcome of an observed execution.
pub fn judge(
    pre: &Manifest,
    post: Option<&Manifest>,
    p: &ProcessState,
    identity_ok: bool,
) -> (String, Vec<String>) {
    let mut why = vec![];
    if !pre.completeness.complete {
        why.push(format!(
            "pre-manifest-incomplete:{}",
            pre.completeness.reasons.join(",")
        ));
    }
    match post {
        None => why.push("post-manifest-missing".into()),
        Some(m) if !m.completeness.complete => why.push(format!(
            "post-manifest-incomplete:{}",
            m.completeness.reasons.join(",")
        )),
        _ => {}
    }
    if !p.settled {
        why.push("process-tree-not-settled".into());
    }
    if !identity_ok {
        why.push("workspace-identity-changed".into());
    }
    if !why.is_empty() {
        return ("uncertain".into(), why);
    }
    if p.how != "exited" {
        return (
            "partial".into(),
            vec![format!("command-did-not-finish-normally:{}", p.how)],
        );
    }
    ("observed".into(), vec![])
}

/// Bounded view for tool results and journal rows.
pub fn summary(rec: &EffectsRecord, list_max: usize) -> serde_json::Value {
    let l = |p: &PathList| serde_json::json!({ "count": p.count, "paths": p.paths.iter().take(list_max).collect::<Vec<_>>() });
    let e = &rec.effects;
    serde_json::json!({
        "outcome": rec.outcome, "outcomeReasons": rec.outcome_reasons,
        "complete": rec.pre.complete && rec.post.as_ref().is_some_and(|p| p.complete),
        "settled": rec.process.settled, "attribution": rec.attribution, "note": rec.note,
        "timingMs": rec.timing_ms,
        "preDigest": rec.pre.digest, "postDigest": rec.post.as_ref().map(|p| p.digest.clone()),
        "created": l(&e.created), "modified": l(&e.modified), "deleted": l(&e.deleted),
        "createdDirs": l(&e.created_dirs), "deletedDirs": l(&e.deleted_dirs),
        "metadataChanged": e.metadata_changed.iter().take(list_max).collect::<Vec<_>>(),
        "symlinks": e.symlinks.iter().take(list_max).collect::<Vec<_>>(),
        "hardlinkRisks": l(&e.hardlink_risks), "specialsCreated": l(&e.specials_created),
        "protected": e.protected.iter().take(list_max).collect::<Vec<_>>(),
        "bulkChanged": e.bulk_changed.iter().take(list_max).collect::<Vec<_>>(),
        "likelyRenames": e.likely_renames.iter().take(list_max).collect::<Vec<_>>(),
        "listsMayBeIncomplete": e.lists_may_be_incomplete,
        "checkpoint": rec.checkpoint,
        "recoverability": rec.recoverability.as_ref().map(|r| serde_json::json!({
            "complete": r.complete, "available": r.available, "unavailable": r.unavailable,
            "new": r.new_paths, "bulkNotCaptured": r.bulk_not_captured,
            "unavailablePaths": r.pre_images.iter().filter(|(_, v)| *v != "available").take(list_max)
                .map(|(k, v)| serde_json::json!({"path": k, "reason": v})).collect::<Vec<_>>(),
        })),
        "digest": rec.digest, "executionId": rec.execution_id,
    })
}

// ----------------------------------------------------------------------------- persistence

pub const EFFECTS_DIR: &str = "_effects";

pub fn effects_dir(run_root: &Path) -> PathBuf {
    run_root.join(EFFECTS_DIR)
}

fn valid_exec_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn write_private(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let tmp = dir.join(format!(".{name}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, dir.join(name))?;
    std::fs::File::open(dir)?.sync_all()
}

/// Persist the pre-execution manifest (the durable observation boundary a crash recovery needs).
pub fn write_pre(dir: &Path, exec_id: &str, m: &Manifest) -> std::io::Result<()> {
    if !valid_exec_id(exec_id) {
        return Err(std::io::Error::other("bad execution id"));
    }
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&serde_json::to_vec(m).map_err(std::io::Error::other)?)?;
    write_private(dir, &format!("{exec_id}.pre.json.gz"), &gz.finish()?)
}

pub fn read_pre(dir: &Path, exec_id: &str) -> Option<Manifest> {
    if !valid_exec_id(exec_id) {
        return None;
    }
    let raw = std::fs::read(dir.join(format!("{exec_id}.pre.json.gz"))).ok()?;
    let mut s = Vec::new();
    flate2::read::GzDecoder::new(&raw[..])
        .take(1 << 30)
        .read_to_end(&mut s)
        .ok()?;
    serde_json::from_slice(&s).ok()
}

pub fn remove_pre(dir: &Path, exec_id: &str) {
    if valid_exec_id(exec_id) {
        let _ = std::fs::remove_file(dir.join(format!("{exec_id}.pre.json.gz")));
    }
}

pub fn write_record(dir: &Path, rec: &EffectsRecord) -> std::io::Result<()> {
    if !valid_exec_id(&rec.execution_id) {
        return Err(std::io::Error::other("bad execution id"));
    }
    write_private(
        dir,
        &format!("{}.json", rec.execution_id),
        &serde_json::to_vec_pretty(rec).map_err(std::io::Error::other)?,
    )
}

pub fn read_record(dir: &Path, exec_id: &str) -> Option<EffectsRecord> {
    if !valid_exec_id(exec_id) {
        return None;
    }
    serde_json::from_slice(&std::fs::read(dir.join(format!("{exec_id}.json"))).ok()?).ok()
}

/// Remove ledger files older than `max_age` (daemon-private data only). Returns how many.
pub fn sweep(dir: &Path, max_age: std::time::Duration) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|a| a >= max_age);
        if old
            && e.file_type().map(|t| t.is_file()).unwrap_or(false)
            && std::fs::remove_file(e.path()).is_ok()
        {
            n += 1;
        }
    }
    n
}

/// Identity of the pinned root as seen now through the descriptor.
pub fn root_identity(ws: &Workspace) -> Option<RootId> {
    fstat_fd(ws.root_raw_fd()).ok().map(|s| RootId {
        dev: s.dev,
        ino: s.ino,
    })
}

/// Does the path the registry shows still lead to the pinned directory? (Informational: the mount and every
/// observation use the descriptor, never the path.)
pub fn path_still_leads_to(ws: &Workspace) -> bool {
    let Ok(c) = CString::new(Path::new(ws.root_path()).as_os_str().as_bytes()) else {
        return false;
    };
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return false;
    }
    let r = fstat_fd(fd);
    unsafe { libc::close(fd) };
    match (r, root_identity(ws)) {
        (Ok(a), Some(b)) => a.dev == b.dev && a.ino == b.ino,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn open(dir: &Path) -> Workspace {
        Workspace::open_root(dir.to_str().unwrap(), WorkspacePolicy::default()).unwrap()
    }
    fn tree() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(d.path()).unwrap();
        (d, root)
    }
    fn put(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    fn fx(ws: &Workspace, pre: &Manifest) -> EffectSet {
        let b = ObserveBudget::default();
        let post = observe(ws, &b);
        let (mut e, changed) = diff(pre, &post, &b);
        hash_changed(ws, &changed, &mut e, &b);
        e
    }
    fn pause() {
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    #[test]
    fn every_kind_of_change_is_detected_through_the_pinned_root() {
        let (_d, root) = tree();
        put(&root, "src/a.rs", "one\n");
        put(&root, "src/b.rs", "two\n");
        put(&root, "docs/old.md", "old\n");
        put(&root, "gone/x.txt", "x\n");
        put(&root, "tool.sh", "#!/bin/sh\n");
        std::fs::set_permissions(
            root.join("src/b.rs"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let ws = open(&root);
        let pre = observe(&ws, &ObserveBudget::default());
        assert!(pre.completeness.complete, "{:?}", pre.completeness);
        pause();
        // nested creation, two modifications, a deletion (file and directory), a move, a chmod
        put(&root, "new/deep/er/c.txt", "created\n");
        put(&root, "src/a.rs", "ONE MODIFIED\n");
        put(&root, "src/b.rs", "two-but-longer\n");
        std::fs::remove_dir_all(root.join("gone")).unwrap();
        std::fs::rename(root.join("docs/old.md"), root.join("docs/renamed.md")).unwrap();
        pause();
        std::fs::set_permissions(root.join("tool.sh"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let e = fx(&ws, &pre);
        assert!(
            e.created.paths.contains(&"new/deep/er/c.txt".to_owned()),
            "{e:?}"
        );
        for d in ["new", "new/deep", "new/deep/er"] {
            assert!(
                e.created_dirs.paths.contains(&d.to_owned()),
                "{d}: {:?}",
                e.created_dirs
            );
        }
        assert_eq!(e.modified.paths, ["src/a.rs", "src/b.rs"]);
        assert!(e.deleted.paths.contains(&"gone/x.txt".to_owned()));
        assert!(e.deleted_dirs.paths.contains(&"gone".to_owned()));
        // a move is delete + create, with the identity evidence alongside
        assert!(
            e.deleted.paths.contains(&"docs/old.md".to_owned())
                && e.created.paths.contains(&"docs/renamed.md".to_owned())
        );
        assert_eq!(
            e.likely_renames,
            [Rename {
                from: "docs/old.md".into(),
                to: "docs/renamed.md".into(),
                evidence: "same-inode-size-mtime".into()
            }]
        );
        // content hashes of what appeared / changed
        assert_eq!(
            e.post_sha256["src/a.rs"],
            hex::encode(Sha256::digest(b"ONE MODIFIED\n"))
        );
        assert!(e.post_sha256.contains_key("new/deep/er/c.txt"));
        // an untouched file is not mentioned anywhere
        assert!(!e
            .modified
            .paths
            .iter()
            .chain(&e.created.paths)
            .any(|p| p == "docs/other"));
        assert!(
            e.metadata_changed
                .iter()
                .any(|m| m.path == "tool.sh" && m.what == ["mode"]),
            "{:?}",
            e.metadata_changed
        );
        assert!(!e.lists_may_be_incomplete);
    }

    #[test]
    fn a_same_size_rewrite_with_the_old_mtime_is_not_silent() {
        let (_d, root) = tree();
        put(&root, "f.txt", "aaaa");
        let ws = open(&root);
        let pre = observe(&ws, &ObserveBudget::default());
        let before = std::fs::metadata(root.join("f.txt")).unwrap();
        pause();
        std::fs::write(root.join("f.txt"), "bbbb").unwrap();
        // restore the modification time: a process can do this, it cannot restore ctime
        let ft = std::fs::File::options()
            .write(true)
            .open(root.join("f.txt"))
            .unwrap();
        ft.set_modified(before.modified().unwrap()).unwrap();
        let e = fx(&ws, &pre);
        assert!(
            e.modified.paths.is_empty(),
            "content cannot be proven without a pre-image hash"
        );
        assert!(
            e.metadata_changed
                .iter()
                .any(|m| m.path == "f.txt" && m.what == ["ctime-only"]),
            "{:?}",
            e.metadata_changed
        );
    }

    #[test]
    fn symlinks_hard_links_specials_and_protected_paths_are_reported_never_followed() {
        let (_d, root) = tree();
        let outside = tempfile::tempdir().unwrap();
        put(outside.path(), "secret.txt", "TOP-SECRET");
        put(&root, "Cargo.lock", "v1\n");
        put(&root, ".git/HEAD", "ref: refs/heads/main\n");
        put(&root, "real.txt", "data\n");
        let ws = open(&root);
        let pre = observe(&ws, &ObserveBudget::default());
        pause();
        symlink(outside.path(), root.join("outlink")).unwrap(); // absolute: leaves the root
        symlink("../../etc/passwd", root.join("climb")).unwrap(); // relative: climbs out
        symlink("real.txt", root.join("inside")).unwrap(); // stays inside
        std::fs::hard_link(root.join("real.txt"), root.join("alias.txt")).unwrap();
        let fifo = CString::new(root.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        put(&root, ".env", "TOKEN=1\n");
        put(&root, "Cargo.lock", "v2-changed\n");
        put(&root, ".git/HEAD", "ref: refs/heads/evil\n");
        let e = fx(&ws, &pre);
        let link = |p: &str| {
            e.symlinks
                .iter()
                .find(|l| l.path == p)
                .unwrap_or_else(|| panic!("{p}: {:?}", e.symlinks))
        };
        assert!(
            link("outlink").escapes_root
                && link("climb").escapes_root
                && !link("inside").escapes_root
        );
        // the outside tree was never entered
        assert!(!e.created.paths.iter().any(|p| p.contains("secret")));
        assert!(
            e.hardlink_risks.paths.contains(&"alias.txt".to_owned()),
            "{:?}",
            e.hardlink_risks
        );
        assert!(e.specials_created.paths.contains(&"pipe".to_owned()));
        let rules: Vec<(&str, &str)> = e
            .protected
            .iter()
            .map(|p| (p.path.as_str(), p.rule.as_str()))
            .collect();
        assert!(rules.contains(&(".env", "secret-name")), "{rules:?}");
        assert!(
            rules.contains(&("Cargo.lock", "build-steering")),
            "{rules:?}"
        );
        assert!(rules.contains(&(".git", "git")), "{rules:?}");
        // a secret-shaped file is reported but never read for hashing
        assert!(!e.post_sha256.contains_key(".env"));
        assert!(e.post_sha256.contains_key("Cargo.lock"));
    }

    #[test]
    fn bulk_directories_are_summarised_and_bounded_not_enumerated() {
        let (_d, root) = tree();
        put(&root, "src/main.rs", "fn main(){}\n");
        for i in 0..3000 {
            put(&root, &format!("node_modules/pkg{}/f{}.js", i % 40, i), "x");
        }
        let ws = open(&root);
        let b = ObserveBudget {
            max_bulk_entries: 500,
            ..Default::default()
        };
        let pre = observe(&ws, &b);
        // tier 1 is complete and small; the bulk directory is one summary
        assert!(pre.completeness.complete, "{:?}", pre.completeness);
        assert!(
            pre.entries.keys().all(|k| !k.starts_with("node_modules/")),
            "bulk content was enumerated"
        );
        let nm = &pre.bulk["node_modules"];
        assert!(nm.truncated && nm.entries <= 500, "{nm:?}");
        assert_eq!(
            pre.completeness.bulk_truncated, 1,
            "the truncation must be stated"
        );
        pause();
        put(&root, "node_modules/pkg0/new.js", "y");
        put(&root, "node_modules/pkg1/f1.js", "changed");
        let post = observe(&ws, &b);
        let (e, _) = diff(&pre, &post, &b);
        // an in-budget change is detected in aggregate; nothing is claimed about individual files
        let ch = e.bulk_changed.iter().find(|c| c.path == "node_modules");
        assert!(ch.is_some(), "{:?}", e.bulk_changed);
        assert!(
            !ch.unwrap().exhaustive,
            "a truncated summary must not claim to be exhaustive"
        );
        assert!(e.created.paths.is_empty() && e.modified.paths.is_empty());
        // with a budget that covers the directory the summary is exhaustive and sees every change
        let big = ObserveBudget {
            max_bulk_entries: 50_000,
            ..Default::default()
        };
        let pre2 = observe(&ws, &big);
        assert_eq!(pre2.completeness.bulk_truncated, 0);
        pause();
        put(&root, "node_modules/pkg2/late.js", "z");
        let (e2, _) = diff(&pre2, &observe(&ws, &big), &big);
        assert!(e2.bulk_changed[0].exhaustive);
    }

    #[test]
    fn limits_unreadable_directories_and_every_skip_make_the_manifest_incomplete_and_say_why() {
        let (_d, root) = tree();
        for i in 0..400 {
            put(&root, &format!("d{}/f{}.txt", i % 10, i), "x");
        }
        let ws = open(&root);
        let tiny = ObserveBudget {
            max_entries: 60,
            ..Default::default()
        };
        let m = observe(&ws, &tiny);
        assert!(
            !m.completeness.complete && m.completeness.reasons.contains(&"entry-budget".to_owned()),
            "{:?}",
            m.completeness
        );
        let late = ObserveBudget {
            max_wall_ms: 0,
            ..Default::default()
        };
        let m = observe(&ws, &late);
        assert!(
            m.completeness.reasons.contains(&"time-budget".to_owned()),
            "{:?}",
            m.completeness
        );
        // an unreadable directory
        std::fs::set_permissions(root.join("d3"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let m = observe(&ws, &ObserveBudget::default());
        assert!(
            !m.completeness.complete
                && m.completeness.unreadable >= 1
                && m.completeness
                    .reasons
                    .iter()
                    .any(|r| r.starts_with("unreadable:d3")),
            "{:?}",
            m.completeness
        );
        std::fs::set_permissions(root.join("d3"), std::fs::Permissions::from_mode(0o755)).unwrap();
        // a diff against an incomplete manifest never claims to be exhaustive
        let full = observe(&ws, &ObserveBudget::default());
        let (e, _) = diff(&m, &full, &ObserveBudget::default());
        assert!(e.lists_may_be_incomplete);
        // the cap on a category list keeps the exact count
        let cap = ObserveBudget {
            list_cap: 5,
            ..Default::default()
        };
        let pre = observe(&ws, &cap);
        for i in 0..20 {
            put(&root, &format!("many/n{i}.txt"), "n");
        }
        let (e, _) = diff(&pre, &observe(&ws, &cap), &cap);
        assert_eq!(
            (e.created.count, e.created.paths.len(), e.created.truncated),
            (20, 5, true)
        );
        assert!(e.lists_may_be_incomplete);
    }

    #[test]
    fn the_digest_is_stable_for_an_unchanged_tree_and_changes_with_it() {
        let (_d, root) = tree();
        put(&root, "a.txt", "a");
        put(&root, "node_modules/x/y.js", "y");
        let ws = open(&root);
        let b = ObserveBudget::default();
        let (m1, m2) = (observe(&ws, &b), observe(&ws, &b));
        assert_eq!(m1.digest, m2.digest);
        assert_eq!(m1.entries, m2.entries);
        pause();
        put(&root, "a.txt", "aa");
        assert_ne!(m1.digest, observe(&ws, &b).digest);
        let (e, _) = diff(&m1, &m2, &b);
        assert_eq!(
            e,
            EffectSet::default(),
            "identical manifests have no effects"
        );
    }

    #[test]
    fn hashing_is_bounded_and_skips_large_and_secret_files() {
        let (_d, root) = tree();
        let ws = open(&root);
        let b = ObserveBudget {
            hash_file_max: 100,
            hash_total_max: 150,
            ..Default::default()
        };
        let pre = observe(&ws, &b);
        put(&root, "small1.txt", &"a".repeat(80));
        put(&root, "small2.txt", &"b".repeat(80));
        put(&root, "huge.bin", &"c".repeat(5000));
        put(&root, "id_rsa", "KEY");
        let post = observe(&ws, &b);
        let (mut e, ch) = diff(&pre, &post, &b);
        hash_changed(&ws, &ch, &mut e, &b);
        assert!(e.post_sha256.contains_key("small1.txt"));
        assert!(
            !e.post_sha256.contains_key("small2.txt"),
            "total byte budget exceeded"
        );
        assert!(!e.post_sha256.contains_key("huge.bin"));
        assert!(!e.post_sha256.contains_key("id_rsa"));
        assert_eq!(e.created.count, 4);
    }

    #[test]
    fn the_record_judges_outcomes_honestly_and_round_trips_through_the_ledger() {
        let (_d, root) = tree();
        put(&root, "a.txt", "a");
        let ws = open(&root);
        let b = ObserveBudget::default();
        let pre = observe(&ws, &b);
        let post = observe(&ws, &b);
        let done = ProcessState {
            exited: true,
            how: "exited".into(),
            exit_code: Some(0),
            settled: true,
        };
        assert_eq!(judge(&pre, Some(&post), &done, true).0, "observed");
        let cancelled = ProcessState {
            how: "cancelled".into(),
            exit_code: None,
            ..done.clone()
        };
        assert_eq!(judge(&pre, Some(&post), &cancelled, true).0, "partial");
        let unsettled = ProcessState {
            settled: false,
            ..done.clone()
        };
        assert_eq!(judge(&pre, Some(&post), &unsettled, true).0, "uncertain");
        assert_eq!(judge(&pre, None, &done, true).0, "uncertain");
        assert_eq!(judge(&pre, Some(&post), &done, false).0, "uncertain");
        let mut inc = post.clone();
        inc.completeness.complete = false;
        inc.completeness.reasons = vec!["entry-budget".into()];
        let (o, why) = judge(&pre, Some(&inc), &done, true);
        assert_eq!(o, "uncertain");
        assert!(why[0].contains("entry-budget"));
        // ledger persistence: private files, exact round trip, pre-manifest round trip
        let led = tempfile::tempdir().unwrap();
        let dir = effects_dir(led.path());
        write_pre(&dir, "nexus-exec-1", &pre).unwrap();
        assert_eq!(read_pre(&dir, "nexus-exec-1").unwrap(), pre);
        let mut rec = EffectsRecord {
            schema: RECORD_SCHEMA.into(),
            execution_id: "nexus-exec-1".into(),
            task_instance_id: "t".into(),
            command_id: "c".into(),
            workspace: pre.root.clone(),
            grant: None,
            fs_scope: "workspace".into(),
            started_ms: 1,
            ended_ms: 2,
            pre: ManifestBrief::of(&pre),
            post: Some(ManifestBrief::of(&post)),
            process: done,
            effects: EffectSet::default(),
            checkpoint: None,
            recoverability: None,
            post_state: Default::default(),
            timing_ms: Default::default(),
            outcome: "observed".into(),
            outcome_reasons: vec![],
            attribution: "temporal".into(),
            note: ATTRIBUTION_NOTE.into(),
            digest: String::new(),
        };
        rec.digest = rec.compute_digest();
        write_record(&dir, &rec).unwrap();
        assert_eq!(read_record(&dir, "nexus-exec-1").unwrap(), rec);
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(dir.join("nexus-exec-1.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // hostile ids never name a path
        assert!(
            write_pre(&dir, "../x", &pre).is_err()
                && read_pre(&dir, "../x").is_none()
                && read_record(&dir, "a/b").is_none()
        );
        remove_pre(&dir, "nexus-exec-1");
        assert!(read_pre(&dir, "nexus-exec-1").is_none());
        assert_eq!(sweep(&dir, std::time::Duration::from_secs(3600)), 0);
        assert_eq!(sweep(&dir, std::time::Duration::ZERO), 1);
    }

    #[test]
    fn the_observer_follows_the_descriptor_not_the_path() {
        let (_d, root) = tree();
        put(&root, "a.txt", "a");
        let ws = open(&root);
        let moved = root.with_file_name(format!(
            "{}-moved",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::rename(&root, &moved).unwrap();
        std::fs::create_dir(&root).unwrap(); // a decoy at the old path
        put(&root, "decoy.txt", "d");
        let m = observe(&ws, &ObserveBudget::default());
        assert!(
            m.entries.contains_key("a.txt") && !m.entries.contains_key("decoy.txt"),
            "{:?}",
            m.entries.keys()
        );
        assert!(
            !path_still_leads_to(&ws),
            "the path no longer leads to the pinned directory and that is reported"
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::rename(&moved, &root).unwrap();
    }
}
