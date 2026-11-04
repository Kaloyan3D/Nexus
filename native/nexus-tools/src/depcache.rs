//! Content-addressed, read-only Rust dependency cache (A3.5).
//!
//! Trust model
//! -----------
//! * **Acquisition is separate from execution.** The sandbox can never fetch
//!   anything. Artifacts enter only through [`DepCache::admit`] /
//!   [`DepCache::admit_from_dir`], run by an operator-controlled process with
//!   filesystem rights on the cache directory (`0700`, owned by the cache
//!   owner). There is no daemon IPC operation and no network code here.
//! * **Admission verifies.** A `.crate` file is admitted only when the
//!   sha256 of its bytes equals the checksum recorded in the project's
//!   `Cargo.lock`. The archive is parsed by a strict in-process reader that
//!   refuses links, devices, absolute/`..`/backslash paths, NUL, duplicates,
//!   wrong top-level directory and anything over the quotas.
//! * **Objects are immutable.** Each object lives at
//!   `objects/<sha256>/` (content-addressed by the Cargo checksum), is built
//!   in a private staging directory, made read-only, and published with one
//!   atomic `rename`. A different object can never replace an existing one.
//! * **Use re-verifies.** Before an execution, every needed object is
//!   re-hashed file by file against its recorded manifest; a poisoned object
//!   fails the run closed.
//! * **The sandbox gets a per-execution, read-only `local-registry` view**
//!   containing exactly the packages named in the project's lockfile (hard
//!   links to the immutable `.crate` objects plus index entries whose
//!   `cksum` equals the lockfile checksum), mounted read-only. Never a
//!   package home. Cargo itself re-verifies every archive against both the
//!   index and `Cargo.lock` and unpacks into the sandbox's private tmpfs.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const CACHE_VERSION: &str = "nexus-depcache/1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheError {
    pub code: &'static str,
    pub message: String,
}

impl CacheError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CacheError {}

type R<T> = Result<T, CacheError>;

#[derive(Debug, Clone)]
pub struct CacheQuota {
    pub max_objects: usize,
    pub max_total_bytes: u64,
    pub max_crate_bytes: u64,
    pub max_unpacked_bytes: u64,
    pub max_files_per_crate: usize,
    pub max_path_len: usize,
}

impl Default for CacheQuota {
    fn default() -> Self {
        Self {
            max_objects: 4096,
            max_total_bytes: 4 * 1024 * 1024 * 1024,
            max_crate_bytes: 128 * 1024 * 1024,
            max_unpacked_bytes: 512 * 1024 * 1024,
            max_files_per_crate: 50_000,
            max_path_len: 240,
        }
    }
}

// ------------------------------------------------------------ lockfile

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct LockedPackage {
    pub name: String,
    pub version: String,
    pub checksum: String,
}

#[derive(Debug, Clone, Default)]
pub struct LockFile {
    pub registry: Vec<LockedPackage>,
    /// `name version (source)` of packages the cache cannot serve (git,
    /// alternate registries): fail closed.
    pub unsupported: Vec<String>,
    pub path_packages: usize,
}

fn valid_pkg_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
        && !s.starts_with('.')
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Minimal, strict `Cargo.lock` reader (v1–v4 `[[package]]` tables).
pub fn parse_cargo_lock(text: &str) -> R<LockFile> {
    let mut out = LockFile::default();
    let mut cur: Option<(String, String, Option<String>, Option<String>)> = None;
    let mut seen_package = false;
    let flush = |cur: &mut Option<(String, String, Option<String>, Option<String>)>,
                 out: &mut LockFile|
     -> R<()> {
        if let Some((name, version, source, checksum)) = cur.take() {
            if !valid_pkg_token(&name) || !valid_pkg_token(&version) {
                return Err(CacheError::new(
                    "lockfile-invalid",
                    format!("unsafe package identity in Cargo.lock: {name:?} {version:?}"),
                ));
            }
            match source.as_deref() {
                None => out.path_packages += 1,
                Some(s)
                    if s == "registry+https://github.com/rust-lang/crates.io-index"
                        || s == "sparse+https://index.crates.io/" =>
                {
                    match checksum {
                        Some(c) if is_sha256(&c) => out.registry.push(LockedPackage {
                            name,
                            version,
                            checksum: c,
                        }),
                        _ => {
                            return Err(CacheError::new(
                                "lockfile-invalid",
                                format!("{name} {version} has no valid sha256 checksum"),
                            ))
                        }
                    }
                }
                Some(s) => out.unsupported.push(format!("{name} {version} ({s})")),
            }
        }
        Ok(())
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line == "[[package]]" {
            flush(&mut cur, &mut out)?;
            cur = Some((String::new(), String::new(), None, None));
            seen_package = true;
            continue;
        }
        if line.starts_with('[') {
            flush(&mut cur, &mut out)?;
            continue;
        }
        if let Some(c) = cur.as_mut() {
            if let Some((k, v)) = line.split_once('=') {
                let v = v.trim().trim_matches('"').to_owned();
                match k.trim() {
                    "name" => c.0 = v,
                    "version" => c.1 = v,
                    "source" => c.2 = Some(v),
                    "checksum" => c.3 = Some(v),
                    _ => {}
                }
            }
        }
    }
    flush(&mut cur, &mut out)?;
    if !seen_package {
        return Err(CacheError::new(
            "lockfile-invalid",
            "no [[package]] entries",
        ));
    }
    out.registry.sort();
    out.registry.dedup();
    Ok(out)
}

// ----------------------------------------------------------- manifests

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub cache_version: String,
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub crate_bytes: u64,
    pub unpacked_files: u64,
    pub unpacked_bytes: u64,
    pub admitted_at_unix: u64,
    pub operator: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admitted {
    Created,
    Identical,
}

#[derive(Debug, Clone, Default)]
pub struct AdmitReport {
    pub created: Vec<String>,
    pub identical: Vec<String>,
    /// Packages whose `.crate` was not supplied (fine only if never
    /// needed for the build target).
    pub missing: Vec<String>,
    /// Packages for which no index entry could be admitted (fatal: Cargo
    /// cannot resolve the lockfile without them).
    pub index_missing: Vec<String>,
    pub rejected: Vec<(String, String)>,
}

impl AdmitReport {
    pub fn complete(&self) -> bool {
        self.missing.is_empty() && self.index_missing.is_empty() && self.rejected.is_empty()
    }

    /// Resolvable by Cargo (every index entry present, nothing rejected);
    /// `.crate` files may be absent for never-built (e.g. other-platform)
    /// packages.
    pub fn resolvable(&self) -> bool {
        self.index_missing.is_empty() && self.rejected.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub cache_version: String,
    pub objects: usize,
    pub total_bytes: u64,
    pub stale_staging: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeReport {
    pub packages: usize,
    pub files: u64,
    pub bytes: u64,
    pub copied_instead_of_linked: u64,
    /// Locked packages with an index entry but no `.crate` (never fetched).
    pub crates_absent: u64,
}

// ---------------------------------------------------------------- cache

#[derive(Debug, Clone)]
pub struct DepCache {
    root: PathBuf,
    quota: CacheQuota,
}

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

fn io(code: &'static str, what: &str, e: std::io::Error) -> CacheError {
    CacheError::new(code, format!("{what}: {e}"))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn rand_hex() -> R<String> {
    let mut b = [0u8; 8];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|e| io("entropy", "urandom", e))?;
    Ok(hex::encode(b))
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(e.path());
            } else {
                total += md.len();
            }
        }
    }
    total
}

/// Reject any path that is not a plain relative path made of safe
/// components.
fn safe_rel(path: &str, max_len: usize) -> R<Vec<&str>> {
    let bad = |m: &str| Err(CacheError::new("archive-path", format!("{m}: {path:?}")));
    if path.is_empty() || path.len() > max_len {
        return bad("empty or too long");
    }
    if path.starts_with('/') || path.contains('\0') || path.contains('\\') {
        return bad("absolute, NUL or backslash");
    }
    let mut comps = Vec::new();
    for c in path.split('/') {
        if c.is_empty() || c == "." {
            continue;
        }
        if c == ".." {
            return bad("parent traversal");
        }
        if c.len() > 200 {
            return bad("component too long");
        }
        comps.push(c);
    }
    if comps.is_empty() {
        return bad("no components");
    }
    Ok(comps)
}

impl DepCache {
    /// Open (and with `create`, initialise) a cache directory. The
    /// directory must be a real directory owned by the current user with no
    /// group/other access; an existing cache must carry the expected
    /// version marker.
    pub fn open(root: &Path, create: bool, quota: CacheQuota) -> R<Self> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if !root.is_absolute() {
            return Err(CacheError::new("cache-root", "cache root must be absolute"));
        }
        if create && !root.exists() {
            std::fs::create_dir_all(root).map_err(|e| io("cache-root", "mkdir", e))?;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| io("cache-root", "chmod", e))?;
        }
        let md = std::fs::symlink_metadata(root).map_err(|e| io("cache-root", "stat", e))?;
        if !md.is_dir() || md.file_type().is_symlink() {
            return Err(CacheError::new(
                "cache-root",
                "cache root is not a real directory",
            ));
        }
        if md.uid() != euid() || md.mode() & 0o077 != 0 {
            return Err(CacheError::new(
                "cache-root",
                "cache root must be owned by the current user with mode 0700",
            ));
        }
        let ver = root.join("VERSION");
        if ver.exists() {
            let v = std::fs::read_to_string(&ver).map_err(|e| io("cache-version", "read", e))?;
            if v.trim() != CACHE_VERSION {
                return Err(CacheError::new(
                    "cache-version",
                    format!("unsupported cache version {:?}", v.trim()),
                ));
            }
        } else if create {
            std::fs::write(&ver, format!("{CACHE_VERSION}\n"))
                .map_err(|e| io("cache-version", "write", e))?;
        } else {
            return Err(CacheError::new("cache-version", "cache is not initialised"));
        }
        std::fs::create_dir_all(root.join("objects"))
            .map_err(|e| io("cache-root", "objects", e))?;
        std::fs::set_permissions(root.join("objects"), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| io("cache-root", "chmod", e))?;
        Ok(Self {
            root: root.to_path_buf(),
            quota,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn objects(&self) -> PathBuf {
        self.root.join("objects")
    }

    fn object_dir(&self, sha: &str) -> PathBuf {
        self.objects().join(sha)
    }

    pub fn stats(&self) -> CacheStats {
        let mut s = CacheStats {
            cache_version: CACHE_VERSION.to_owned(),
            ..Default::default()
        };
        if let Ok(rd) = std::fs::read_dir(self.objects()) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with(".tmp-") {
                    s.stale_staging += 1;
                } else if is_sha256(&n) {
                    s.objects += 1;
                    s.total_bytes += dir_size(&e.path());
                }
            }
        }
        s
    }

    /// Remove abandoned staging directories (interrupted admissions).
    /// They are never visible as objects.
    pub fn gc_staging(&self) -> usize {
        self.gc_staging_older_than(600)
    }

    /// Only staging directories untouched for `min_age_secs` are removed,
    /// so a live concurrent admission is never pulled out from under its
    /// publisher. Published objects are never garbage-collected here.
    pub fn gc_staging_older_than(&self, min_age_secs: u64) -> usize {
        let mut n = 0;
        let now = std::time::SystemTime::now();
        if let Ok(rd) = std::fs::read_dir(self.objects()) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(".tmp-") {
                    let old = e
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| now.duration_since(t).ok())
                        .map(|d| d.as_secs() >= min_age_secs)
                        .unwrap_or(false);
                    if !old {
                        continue;
                    }
                    make_writable(&e.path());
                    if std::fs::remove_dir_all(e.path()).is_ok() {
                        n += 1;
                    }
                }
            }
        }
        n
    }

    /// Admit one crate archive. `expected_sha256` is the lockfile checksum.
    pub fn admit(
        &self,
        name: &str,
        version: &str,
        expected_sha256: &str,
        crate_bytes: &[u8],
        operator: &str,
    ) -> R<Admitted> {
        if !valid_pkg_token(name) || !valid_pkg_token(version) || !is_sha256(expected_sha256) {
            return Err(CacheError::new("admit-input", "invalid package identity"));
        }
        if crate_bytes.len() as u64 > self.quota.max_crate_bytes {
            return Err(CacheError::new(
                "quota",
                "crate archive exceeds the size quota",
            ));
        }
        let actual = hex::encode(Sha256::digest(crate_bytes));
        if actual != expected_sha256 {
            return Err(CacheError::new(
                "checksum-mismatch",
                format!("{name} {version}: archive sha256 {actual} != lockfile {expected_sha256}"),
            ));
        }
        let final_dir = self.object_dir(expected_sha256);
        if final_dir.exists() {
            self.verify_object(expected_sha256)?;
            return Ok(Admitted::Identical);
        }
        let stats = self.stats();
        if stats.objects >= self.quota.max_objects {
            return Err(CacheError::new("quota", "object-count quota reached"));
        }
        if stats.total_bytes.saturating_add(crate_bytes.len() as u64) > self.quota.max_total_bytes {
            return Err(CacheError::new("quota", "total-size quota reached"));
        }
        let staging = self.objects().join(format!(".tmp-{}", rand_hex()?));
        std::fs::create_dir(&staging).map_err(|e| io("staging", "mkdir", e))?;
        let built = self.extract_into(
            &staging,
            name,
            version,
            expected_sha256,
            crate_bytes,
            operator,
        );
        if let Err(e) = built {
            make_writable(&staging);
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        // Publish atomically. If another process won the race the target
        // exists (non-empty) and rename fails: verify it instead.
        match std::fs::rename(&staging, &final_dir) {
            Ok(()) => Ok(Admitted::Created),
            Err(_) if final_dir.exists() => {
                make_writable(&staging);
                let _ = std::fs::remove_dir_all(&staging);
                self.verify_object(expected_sha256)?;
                Ok(Admitted::Identical)
            }
            Err(e) => {
                make_writable(&staging);
                let _ = std::fs::remove_dir_all(&staging);
                Err(io("publish", "rename", e))
            }
        }
    }

    fn extract_into(
        &self,
        staging: &Path,
        name: &str,
        version: &str,
        sha: &str,
        crate_bytes: &[u8],
        operator: &str,
    ) -> R<()> {
        use std::os::unix::fs::PermissionsExt;
        let top = format!("{name}-{version}");
        let (files, total, has_manifest) = self.validate_archive(&top, crate_bytes)?;
        if !has_manifest {
            return Err(CacheError::new(
                "archive-shape",
                "package has no Cargo.toml",
            ));
        }
        std::fs::create_dir(staging.join("crate")).map_err(|e| io("staging", "mkdir", e))?;
        let cp = staging
            .join("crate")
            .join(format!("{name}-{version}.crate"));
        std::fs::write(&cp, crate_bytes).map_err(|e| io("staging", "write", e))?;
        std::fs::set_permissions(&cp, std::fs::Permissions::from_mode(0o444))
            .map_err(|e| io("staging", "chmod", e))?;
        let prov = Provenance {
            cache_version: CACHE_VERSION.to_owned(),
            name: name.to_owned(),
            version: version.to_owned(),
            sha256: sha.to_owned(),
            crate_bytes: crate_bytes.len() as u64,
            unpacked_files: files as u64,
            unpacked_bytes: total,
            admitted_at_unix: unix_now(),
            operator: operator.chars().take(64).collect(),
            source: "operator-supplied-crate-file".to_owned(),
        };
        let pj = staging.join("PROVENANCE.json");
        std::fs::write(
            &pj,
            serde_json::to_string_pretty(&prov)
                .map_err(|e| CacheError::new("manifest", e.to_string()))?,
        )
        .map_err(|e| io("manifest", "write", e))?;
        std::fs::set_permissions(&pj, std::fs::Permissions::from_mode(0o444))
            .map_err(|e| io("manifest", "chmod", e))?;
        make_readonly_tree(staging).map_err(|e| io("extract", "seal", e))?;
        Ok(())
    }

    /// Strictly walk the archive in memory (nothing is written): safe
    /// paths, no links/devices, single top-level directory, no duplicates,
    /// quotas. Returns (files, bytes, has Cargo.toml).
    fn validate_archive(&self, top: &str, crate_bytes: &[u8]) -> R<(usize, u64, bool)> {
        let gz = flate2::read::GzDecoder::new(crate_bytes);
        // Hard ceiling on decompressed bytes (zip-bomb defence).
        let mut tar = TarReader::new(
            gz.take(self.quota.max_unpacked_bytes + 1024 * 1024),
            self.quota.max_unpacked_bytes,
        );
        let (mut files, mut total, mut manifest) = (0usize, 0u64, false);
        let mut seen = std::collections::HashSet::new();
        while let Some(entry) = tar.next_entry()? {
            let comps = safe_rel(&entry.path, self.quota.max_path_len)?;
            if comps[0] != top {
                return Err(CacheError::new(
                    "archive-path",
                    format!("entry {:?} is outside {top}/", entry.path),
                ));
            }
            let rel = comps[1..].join("/");
            match entry.kind {
                EntryKind::Dir => {}
                EntryKind::File => {
                    if rel.is_empty() {
                        return Err(CacheError::new("archive-path", "file at package root name"));
                    }
                    if !seen.insert(rel.to_ascii_lowercase()) {
                        return Err(CacheError::new(
                            "archive-path",
                            format!("duplicate or case-colliding path {rel:?}"),
                        ));
                    }
                    files += 1;
                    total += entry.data.len() as u64;
                    if files > self.quota.max_files_per_crate
                        || total > self.quota.max_unpacked_bytes
                    {
                        return Err(CacheError::new(
                            "quota",
                            "unpacked size/file quota exceeded",
                        ));
                    }
                    if rel == "Cargo.toml" {
                        manifest = true;
                    }
                }
            }
        }
        if files == 0 {
            return Err(CacheError::new(
                "archive-empty",
                "archive contains no files",
            ));
        }
        Ok((files, total, manifest))
    }

    // ------------------------------------------------ index entries

    fn index_dir(&self) -> PathBuf {
        self.root.join("index")
    }

    /// Admit one crates.io index line (JSON) for a locked package. It must
    /// name exactly this package and carry the lockfile checksum.
    pub fn admit_index_entry(&self, name: &str, version: &str, cksum: &str, line: &str) -> R<()> {
        use std::os::unix::fs::PermissionsExt;
        if !valid_pkg_token(name) || !valid_pkg_token(version) || !is_sha256(cksum) {
            return Err(CacheError::new("admit-input", "invalid package identity"));
        }
        if line.len() > 256 * 1024 || line.contains('\n') {
            return Err(CacheError::new(
                "index-entry",
                "index line too large or multi-line",
            ));
        }
        let v: serde_json::Value = serde_json::from_str(line)
            .map_err(|e| CacheError::new("index-entry", format!("invalid JSON: {e}")))?;
        let ok = v["name"] == name && v["vers"] == version && v["cksum"] == cksum;
        if !ok {
            return Err(CacheError::new(
                "index-entry",
                format!(
                    "{name} {version}: index entry does not match name/version/lockfile checksum"
                ),
            ));
        }
        let dir = self.index_dir();
        std::fs::create_dir_all(&dir).map_err(|e| io("index", "mkdir", e))?;
        let dst = dir.join(format!("{cksum}.json"));
        if let Ok(existing) = std::fs::read_to_string(&dst) {
            return if existing == line {
                Ok(())
            } else {
                Err(CacheError::new(
                    "index-entry",
                    "a different entry is already admitted (immutable)",
                ))
            };
        }
        let tmp = dir.join(format!(".tmp-{}", rand_hex()?));
        std::fs::write(&tmp, line).map_err(|e| io("index", "write", e))?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o444))
            .map_err(|e| io("index", "chmod", e))?;
        // link() fails if the name exists: no replacement, race-safe.
        let r = std::fs::hard_link(&tmp, &dst);
        let _ = std::fs::remove_file(&tmp);
        match r {
            Ok(()) => Ok(()),
            Err(_) if dst.exists() => {
                if std::fs::read_to_string(&dst).ok().as_deref() == Some(line) {
                    Ok(())
                } else {
                    Err(CacheError::new(
                        "index-entry",
                        "a different entry is already admitted (immutable)",
                    ))
                }
            }
            Err(e) => Err(io("index", "publish", e)),
        }
    }

    /// Read an index entry without following symlinks and re-bind it to
    /// the lockfile identity at use time (not only at admission).
    fn read_index_entry(&self, name: &str, version: &str, cksum: &str) -> R<String> {
        let bytes = read_nofollow(&self.index_dir().join(format!("{cksum}.json")), 256 * 1024)
            .map_err(|e| io("dependency-unavailable", "index entry", e))?;
        let line = String::from_utf8(bytes)
            .map_err(|_| CacheError::new("cache-corrupt", "index entry is not UTF-8"))?;
        let v: serde_json::Value = serde_json::from_str(&line)
            .map_err(|e| CacheError::new("cache-corrupt", format!("index entry: {e}")))?;
        if line.contains('\n') || v["name"] != name || v["vers"] != version || v["cksum"] != cksum {
            return Err(CacheError::new(
                "cache-corrupt",
                format!("index entry for {name} {version} does not match the lockfile"),
            ));
        }
        Ok(line)
    }

    /// Admit every registry package of `lock` from `dir` (a flat or nested
    /// directory of `<name>-<version>.crate` files, e.g. a copy of
    /// `~/.cargo/registry/cache/<index>/`). All-or-report: nothing is
    /// admitted for a package that fails verification.
    pub fn admit_from_dir(
        &self,
        dir: &Path,
        index_cache: Option<&Path>,
        lock: &LockFile,
        operator: &str,
    ) -> AdmitReport {
        let mut rep = AdmitReport::default();
        if !lock.unsupported.is_empty() {
            for u in &lock.unsupported {
                rep.rejected
                    .push((u.clone(), "unsupported source (not crates.io)".into()));
            }
        }
        let index = index_crate_files(dir);
        for p in &lock.registry {
            let ident = format!("{}-{}", p.name, p.version);
            if let Some(ic) = index_cache {
                match read_index_cache_line(ic, &p.name, &p.version) {
                    Some(line) => {
                        if let Err(e) =
                            self.admit_index_entry(&p.name, &p.version, &p.checksum, &line)
                        {
                            rep.rejected.push((ident.clone(), e.to_string()));
                            continue;
                        }
                    }
                    None => rep.index_missing.push(ident.clone()),
                }
            }
            let Some(path) = index.get(&ident) else {
                rep.missing.push(ident);
                continue;
            };
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(e) => {
                    rep.rejected.push((ident, format!("unreadable: {e}")));
                    continue;
                }
            };
            match self.admit(&p.name, &p.version, &p.checksum, &bytes, operator) {
                Ok(Admitted::Created) => rep.created.push(ident),
                Ok(Admitted::Identical) => rep.identical.push(ident),
                Err(e) => rep.rejected.push((ident, e.to_string())),
            }
        }
        rep
    }

    /// Re-hash an object: the stored archive must equal its content address
    /// and contain nothing else.
    pub fn verify_object(&self, sha: &str) -> R<Provenance> {
        if !is_sha256(sha) {
            return Err(CacheError::new("verify", "invalid object id"));
        }
        let dir = self.object_dir(sha);
        let prov: Provenance = serde_json::from_slice(
            &std::fs::read(dir.join("PROVENANCE.json"))
                .map_err(|e| io("cache-corrupt", "provenance", e))?,
        )
        .map_err(|e| CacheError::new("cache-corrupt", format!("provenance: {e}")))?;
        if prov.sha256 != sha || prov.cache_version != CACHE_VERSION {
            return Err(CacheError::new(
                "cache-corrupt",
                "provenance does not match object id/version",
            ));
        }
        let want = format!("{}-{}.crate", prov.name, prov.version);
        let mut names: Vec<String> = Vec::new();
        for e in std::fs::read_dir(dir.join("crate"))
            .map_err(|e| io("cache-corrupt", "readdir", e))?
            .flatten()
        {
            let ft = e.file_type().map_err(|e| io("cache-corrupt", "type", e))?;
            if !ft.is_file() {
                return Err(CacheError::new(
                    "cache-corrupt",
                    "non-regular entry in object",
                ));
            }
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        if names != [want.clone()] {
            return Err(CacheError::new(
                "cache-corrupt",
                "object file set differs from provenance",
            ));
        }
        let bytes = read_nofollow(&dir.join("crate").join(&want), self.quota.max_crate_bytes)
            .map_err(|e| io("cache-corrupt", "read", e))?;
        if hex::encode(Sha256::digest(&bytes)) != sha {
            return Err(CacheError::new(
                "cache-corrupt",
                format!(
                    "object {} {} no longer matches its content address",
                    prov.name, prov.version
                ),
            ));
        }
        Ok(prov)
    }

    /// Build the per-execution, read-only `local-registry` view for
    /// `lock`. Fails closed if any locked package lacks a verified index
    /// entry, or any source is unsupported, or an object fails
    /// re-verification. `.crate` files are linked for every admitted
    /// package; a package without one is only an error if Cargo needs it.
    pub fn materialize(&self, lock: &LockFile, dest: &Path) -> R<MaterializeReport> {
        if !lock.unsupported.is_empty() {
            return Err(CacheError::new(
                "dependency-unavailable",
                format!(
                    "unsupported dependency sources: {}",
                    lock.unsupported.join(", ")
                ),
            ));
        }
        let no_index: Vec<String> = lock
            .registry
            .iter()
            .filter(|p| {
                !self
                    .index_dir()
                    .join(format!("{}.json", p.checksum))
                    .exists()
            })
            .map(|p| format!("{}-{}", p.name, p.version))
            .collect();
        if !no_index.is_empty() {
            let shown: Vec<_> = no_index.iter().take(20).cloned().collect();
            return Err(CacheError::new(
                "dependency-unavailable",
                format!(
                    "{} locked package(s) have no verified index entry in the cache: {}{}",
                    no_index.len(),
                    shown.join(", "),
                    if no_index.len() > 20 { ", …" } else { "" }
                ),
            ));
        }
        std::fs::create_dir_all(dest.join("index")).map_err(|e| io("materialize", "mkdir", e))?;
        let mut rep = MaterializeReport::default();
        let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for p in &lock.registry {
            by_name
                .entry(p.name.clone())
                .or_default()
                .push(self.read_index_entry(&p.name, &p.version, &p.checksum)?);
            let obj = self.object_dir(&p.checksum);
            if !obj.join("PROVENANCE.json").exists() {
                rep.crates_absent += 1;
                continue;
            }
            let prov = self.verify_object(&p.checksum)?;
            if prov.name != p.name || prov.version != p.version {
                return Err(CacheError::new(
                    "cache-corrupt",
                    format!(
                        "object {} is {} {}, lockfile wants {} {}",
                        p.checksum, prov.name, prov.version, p.name, p.version
                    ),
                ));
            }
            let file = format!("{}-{}.crate", p.name, p.version);
            let to = dest.join(&file);
            let from = obj.join("crate").join(&file);
            let len = std::fs::metadata(&from).map(|m| m.len()).unwrap_or(0);
            if std::fs::hard_link(&from, &to).is_err() {
                std::fs::copy(&from, &to).map_err(|e| io("materialize", "copy", e))?;
                rep.copied_instead_of_linked += 1;
            }
            // Close the verify→use window: what the sandbox will consume is
            // the *view* file. Hash that exact inode/copy (no symlinks) now.
            let linked = read_nofollow(&to, self.quota.max_crate_bytes)
                .map_err(|e| io("cache-corrupt", "re-read view", e))?;
            if hex::encode(Sha256::digest(&linked)) != p.checksum {
                let _ = std::fs::remove_file(&to);
                return Err(CacheError::new(
                    "cache-corrupt",
                    format!(
                        "{} {} changed between verification and use",
                        p.name, p.version
                    ),
                ));
            }
            rep.files += 1;
            rep.bytes += len;
            rep.packages += 1;
        }
        for (name, lines) in by_name {
            let rel = index_rel_path(&name);
            let path = dest.join("index").join(&rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io("materialize", "mkdir", e))?;
            }
            std::fs::write(&path, lines.join("\n") + "\n")
                .map_err(|e| io("materialize", "index", e))?;
        }
        Ok(rep)
    }

    pub fn list(&self) -> Vec<Provenance> {
        let mut v = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.objects()) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if is_sha256(&n) {
                    if let Ok(b) = std::fs::read(e.path().join("PROVENANCE.json")) {
                        if let Ok(p) = serde_json::from_slice::<Provenance>(&b) {
                            v.push(p);
                        }
                    }
                }
            }
        }
        v.sort_by(|a, b| (&a.name, &a.version).cmp(&(&b.name, &b.version)));
        v
    }

    /// Verify every object; returns `(ok, failures)`.
    pub fn verify_all(&self) -> (usize, Vec<(String, String)>) {
        let (mut ok, mut bad) = (0, Vec::new());
        if let Ok(rd) = std::fs::read_dir(self.objects()) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if is_sha256(&n) {
                    match self.verify_object(&n) {
                        Ok(_) => ok += 1,
                        Err(err) => bad.push((n, err.to_string())),
                    }
                }
            }
        }
        (ok, bad)
    }
}

fn index_crate_files(dir: &Path) -> BTreeMap<String, PathBuf> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut visited = 0;
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            visited += 1;
            if visited > 100_000 {
                return out;
            }
            // Never follow symlinks while indexing operator input.
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                let n = e.file_name().to_string_lossy().into_owned();
                if let Some(id) = n.strip_suffix(".crate") {
                    out.entry(id.to_owned()).or_insert_with(|| e.path());
                }
            }
        }
    }
    out
}

fn make_readonly_tree(root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    // children first, then directories read-only (0555).
    fn walk(p: &Path) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        for e in std::fs::read_dir(p)? {
            let e = e?;
            if e.file_type()?.is_dir() {
                walk(&e.path())?;
                std::fs::set_permissions(e.path(), std::fs::Permissions::from_mode(0o555))?;
            }
        }
        Ok(())
    }
    walk(root)?;
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o555))
}

fn make_writable(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push(e.path());
                }
            }
        }
    }
}

/// Read a regular file without following a final symlink, bounded.
fn read_nofollow(path: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let md = f.metadata()?;
    if !md.is_file() || md.nlink() == 0 {
        return Err(std::io::Error::other("not a regular file"));
    }
    if md.len() > max {
        return Err(std::io::Error::other("file exceeds size bound"));
    }
    let mut buf = Vec::with_capacity(md.len() as usize);
    f.take(max + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max {
        return Err(std::io::Error::other("file exceeds size bound"));
    }
    Ok(buf)
}

/// crates.io index layout path for `name`.
pub fn index_rel_path(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    match n.len() {
        1 => format!("1/{n}"),
        2 => format!("2/{n}"),
        3 => format!("3/{}/{n}", &n[..1]),
        _ => format!("{}/{}/{n}", &n[..2], &n[2..4]),
    }
}

/// Read the JSON line for `name`/`version` from a Cargo sparse-index cache
/// file (`<index>/.cache/<ab>/<cd>/<name>`). The result is unauthenticated
/// metadata: [`DepCache::admit_index_entry`] binds it to the lockfile
/// checksum.
fn read_index_cache_line(cache_root: &Path, name: &str, version: &str) -> Option<String> {
    let p = cache_root.join(index_rel_path(name));
    let md = std::fs::symlink_metadata(&p).ok()?;
    if !md.is_file() || md.len() > 64 * 1024 * 1024 {
        return None;
    }
    let data = std::fs::read(&p).ok()?;
    // [cache-version u8][index-format u32][index-version\0] then
    // repeated [version\0][json\0].
    if data.len() < 6 {
        return None;
    }
    let mut it = data[5..].split(|b| *b == 0);
    let _index_version = it.next()?;
    while let (Some(v), Some(json)) = (it.next(), it.next()) {
        if v == version.as_bytes() {
            return String::from_utf8(json.to_vec()).ok();
        }
    }
    None
}

// ------------------------------------------------------- strict tar reader

enum EntryKind {
    File,
    Dir,
}

struct Entry {
    path: String,
    kind: EntryKind,
    data: Vec<u8>,
}

struct TarReader<Rd: Read> {
    r: Rd,
    /// Largest member (and total stream) accepted; checked before any
    /// allocation so a header cannot request a huge buffer.
    limit: u64,
    consumed: u64,
    pax_path: Option<String>,
    gnu_long: Option<String>,
    done: bool,
}

fn oct(b: &[u8]) -> R<u64> {
    if !b.is_empty() && b[0] & 0x80 != 0 {
        // base-256 (big sizes)
        let mut v: u64 = (b[0] & 0x7f) as u64;
        for x in &b[1..] {
            v = v
                .checked_mul(256)
                .ok_or_else(|| CacheError::new("archive-format", "size overflow"))?
                + *x as u64;
        }
        return Ok(v);
    }
    let s: String = b
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as char)
        .collect();
    let t = s.trim();
    if t.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(t, 8).map_err(|_| CacheError::new("archive-format", "bad octal field"))
}

fn cstr(b: &[u8]) -> String {
    String::from_utf8_lossy(&b[..b.iter().position(|c| *c == 0).unwrap_or(b.len())]).into_owned()
}

impl<Rd: Read> TarReader<Rd> {
    fn new(r: Rd, limit: u64) -> Self {
        Self {
            r,
            limit,
            consumed: 0,
            pax_path: None,
            gnu_long: None,
            done: false,
        }
    }

    fn read_exact_or_eof(&mut self, buf: &mut [u8]) -> R<bool> {
        let mut got = 0;
        while got < buf.len() {
            match self.r.read(&mut buf[got..]) {
                Ok(0) => {
                    if got == 0 {
                        return Ok(false);
                    }
                    if self.consumed > self.limit {
                        return Err(CacheError::new(
                            "quota",
                            "decompressed size exceeds the quota",
                        ));
                    }
                    return Err(CacheError::new("archive-format", "truncated archive"));
                }
                Ok(n) => {
                    got += n;
                    self.consumed += n as u64;
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    return Err(CacheError::new(
                        "archive-format",
                        format!("gzip/tar read: {e}"),
                    ))
                }
            }
        }
        Ok(true)
    }

    fn read_data(&mut self, size: u64) -> R<Vec<u8>> {
        if size > self.limit || self.consumed.saturating_add(size) > self.limit + 1024 * 1024 {
            return Err(CacheError::new(
                "quota",
                "archive member exceeds the unpacked-size quota",
            ));
        }
        let padded = size.div_ceil(512) * 512;
        let mut data = vec![0u8; padded as usize];
        if padded > 0 && !self.read_exact_or_eof(&mut data)? {
            return Err(CacheError::new("archive-format", "truncated member"));
        }
        data.truncate(size as usize);
        Ok(data)
    }

    fn next_entry(&mut self) -> R<Option<Entry>> {
        loop {
            if self.done {
                return Ok(None);
            }
            let mut h = [0u8; 512];
            if !self.read_exact_or_eof(&mut h)? {
                self.done = true;
                return Ok(None);
            }
            if h.iter().all(|b| *b == 0) {
                self.done = true;
                return Ok(None);
            }
            // header checksum
            let sum: u64 = h
                .iter()
                .enumerate()
                .map(|(i, b)| {
                    if (148..156).contains(&i) {
                        32u64
                    } else {
                        *b as u64
                    }
                })
                .sum();
            if sum != oct(&h[148..156])? {
                return Err(CacheError::new(
                    "archive-format",
                    "tar header checksum mismatch",
                ));
            }
            let size = oct(&h[124..136])?;
            let typ = h[156];
            let mut path = cstr(&h[0..100]);
            if &h[257..262] == b"ustar" {
                let prefix = cstr(&h[345..500]);
                if !prefix.is_empty() {
                    path = format!("{prefix}/{path}");
                }
            }
            match typ {
                b'x' => {
                    let d = self.read_data(size)?;
                    // PAX records: "<len> key=value\n"
                    let mut i = 0;
                    while i < d.len() {
                        let sp = match d[i..].iter().position(|c| *c == b' ') {
                            Some(p) => p,
                            None => break,
                        };
                        let len: usize = std::str::from_utf8(&d[i..i + sp])
                            .ok()
                            .and_then(|s| s.parse().ok())
                            .ok_or_else(|| CacheError::new("archive-format", "bad pax record"))?;
                        if len == 0 || i + len > d.len() {
                            return Err(CacheError::new("archive-format", "bad pax length"));
                        }
                        let rec = &d[i + sp + 1..i + len - 1];
                        if let Some(v) = rec.strip_prefix(b"path=") {
                            self.pax_path = Some(String::from_utf8_lossy(v).into_owned());
                        }
                        i += len;
                    }
                    continue;
                }
                b'g' => {
                    let _ = self.read_data(size)?;
                    continue;
                }
                b'L' => {
                    let d = self.read_data(size)?;
                    self.gnu_long = Some(cstr(&d));
                    continue;
                }
                b'0' | 0 | b'7' => {
                    let data = self.read_data(size)?;
                    let p = self
                        .pax_path
                        .take()
                        .or_else(|| self.gnu_long.take())
                        .unwrap_or(path);
                    return Ok(Some(Entry {
                        path: p,
                        kind: EntryKind::File,
                        data,
                    }));
                }
                b'5' => {
                    let p = self
                        .pax_path
                        .take()
                        .or_else(|| self.gnu_long.take())
                        .unwrap_or(path);
                    return Ok(Some(Entry {
                        path: p.trim_end_matches('/').to_owned(),
                        kind: EntryKind::Dir,
                        data: Vec::new(),
                    }));
                }
                b'1' | b'2' => {
                    return Err(CacheError::new(
                        "archive-link",
                        format!("hard/symbolic links are refused: {path:?}"),
                    ))
                }
                other => {
                    return Err(CacheError::new(
                        "archive-type",
                        format!("unsupported tar entry type {other:#x}: {path:?}"),
                    ))
                }
            }
        }
    }
}

/// Cargo `local-registry` source configuration for a vendor view mounted at
/// `vendor_mount` (generated, never taken from the project).
pub fn cargo_source_config(vendor_mount: &str) -> String {
    format!(
        "[source.crates-io]\nreplace-with = \"nexus-local\"\n\n[source.nexus-local]\nlocal-registry = \"{vendor_mount}\"\n\n[net]\noffline = true\n"
    )
}
