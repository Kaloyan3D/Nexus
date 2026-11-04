//! What may travel between a Mac project folder and its Linux working copy.
//!
//! The rules mirror the engine's own snapshot rules (`nexus-tools::snapshot` / `workspace`): build and
//! cache directories, secret-shaped names, Git internals and anything that is not a regular file never
//! cross. The SAME functions filter the Mac scan, the guest export scan and the writeback targets, so
//! the three can never disagree about what belongs to the project.

use unicode_normalization::UnicodeNormalization;

pub const MAX_FILES: usize = 60_000;
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_NAME_BYTES: usize = 255;
/// Streaming chunk size on the wire (before base64).
pub const CHUNK_BYTES: usize = 256 * 1024;

/// Directory names whose contents are never synchronized (build output, caches, Git).
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
    "node_modules",
];

/// Names never synchronized in either direction (OS metadata).
const OS_JUNK: &[&str] = &[
    ".DS_Store",
    ".AppleDouble",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
];

/// Nexus's own state names (never project content).
const ALWAYS_DENIED: &[&str] = &[
    ".git",
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".nexus",
    ".nexus-a54",
    ".ai-harness",
    ".nexus-sync",
];

const HIDDEN_ALLOW: &[&str] = &[
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
];

fn is_source_file_name(lower: &str) -> bool {
    const EXT: [&str; 22] = [
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".go", ".java", ".kt", ".cs",
        ".rb", ".php", ".swift", ".c", ".h", ".cpp", ".md", ".mts", ".cts", ".sh",
    ];
    EXT.iter().any(|e| lower.ends_with(e))
}

/// Secret-shaped names (same classification as the engine's `NameClass::Sensitive`).
pub fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if ALWAYS_DENIED.contains(&lower.as_str()) {
        return true;
    }
    if HIDDEN_ALLOW.contains(&lower.as_str()) {
        return false;
    }
    const EXACT: [&str; 21] = [
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
    const PREFIX: [&str; 8] = [
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        ".env",
        "live-authorization",
        "live-session-authorization",
        "route-verification-authorization",
    ];
    const SUFFIX: [&str; 12] = [
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
        ".cap",
    ];
    EXACT.contains(&lower.as_str())
        || PREFIX.iter().any(|p| lower.starts_with(p))
        || SUFFIX.iter().any(|s| lower.ends_with(s))
        || (lower.contains("credential") && !is_source_file_name(&lower))
}

/// Why a directory entry does not travel (a stable code shown to the person).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    BuildOrCacheDirectory,
    SensitiveName,
    OsMetadata,
    Symlink,
    UnsafeSymlink,
    NotRegularFile,
    TooLarge,
    InvalidName,
}

/// Classify a directory component that is a directory.
pub fn skip_dir(name: &str) -> Option<SkipReason> {
    if SKIP_DIRS.contains(&name) {
        return Some(SkipReason::BuildOrCacheDirectory);
    }
    if is_sensitive_name(name) {
        return Some(SkipReason::SensitiveName);
    }
    if OS_JUNK.contains(&name) {
        return Some(SkipReason::OsMetadata);
    }
    None
}

/// Classify a file name (not size, not type).
pub fn skip_file_name(name: &str) -> Option<SkipReason> {
    if OS_JUNK.contains(&name) {
        return Some(SkipReason::OsMetadata);
    }
    if is_sensitive_name(name) {
        return Some(SkipReason::SensitiveName);
    }
    None
}

/// Whether a project-relative path may be written or deleted by a synchronization. Applies to
/// every component. Pure and lexical.
pub fn path_is_syncable(rel: &str) -> bool {
    if validate_rel(rel).is_err() {
        return false;
    }
    let comps: Vec<&str> = rel.split('/').collect();
    let (last, dirs) = comps.split_last().expect("validated non-empty");
    dirs.iter().all(|c| skip_dir(c).is_none()) && skip_file_name(last).is_none()
}

/// Lexical validation of a project-relative path: no escapes, no empty/dot components, bounded.
pub fn validate_rel(rel: &str) -> Result<(), &'static str> {
    if rel.is_empty() || rel.len() > MAX_PATH_BYTES {
        return Err("path length");
    }
    if rel.starts_with('/') || rel.contains('\0') || rel.contains('\\') {
        return Err("path form");
    }
    for c in rel.split('/') {
        if c.is_empty() || c == "." || c == ".." || c.len() > MAX_NAME_BYTES {
            return Err("path component");
        }
        if c.chars().any(|ch| ch.is_control()) {
            return Err("control character");
        }
    }
    Ok(())
}

/// Key under which two names are the same file on a case- and normalization-insensitive volume.
pub fn fold(rel: &str) -> String {
    rel.nfc().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_state_never_cross() {
        for n in [
            ".env",
            ".env.local",
            "id_rsa",
            "server.pem",
            "credentials.json",
            ".git",
            ".aws",
            "my.key",
            "token.cap",
        ] {
            assert!(is_sensitive_name(n), "{n}");
        }
        for n in [
            ".env.example",
            ".gitignore",
            "provider-credentials.ts",
            "README.md",
            "main.rs",
            ".github",
        ] {
            assert!(!is_sensitive_name(n), "{n}");
        }
    }

    #[test]
    fn rel_paths_are_validated() {
        for ok in ["a", "src/main.rs", "a/b/c.txt", "with space/ü.txt"] {
            assert!(validate_rel(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            "a//b",
            "./a",
            "a/.",
            "a\\b",
            "a\0b",
            "a/\n",
        ] {
            assert!(validate_rel(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn syncable_paths_exclude_git_secrets_and_build_output() {
        assert!(path_is_syncable("src/lib.rs"));
        for p in [
            ".git/config",
            "a/.git/HEAD",
            ".env",
            "src/.env.local",
            "node_modules/x/index.js",
            "target/debug/x",
            ".DS_Store",
            "keys/server.pem",
        ] {
            assert!(!path_is_syncable(p), "{p}");
        }
    }

    #[test]
    fn fold_unifies_case_and_normalization() {
        assert_eq!(fold("Readme.MD"), fold("README.md"));
        assert_eq!(fold("caf\u{e9}.txt"), fold("cafe\u{301}.txt"));
        assert_ne!(fold("a.txt"), fold("b.txt"));
    }
}
