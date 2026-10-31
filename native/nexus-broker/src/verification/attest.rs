//! Independent attestation of receipted file contents (Phase 04 audit of Phase 03).
//!
//! The run-end cross-check compares the daemon's changed PATHS with the receipted paths. That
//! cannot see a second writer changing the content of a path the Kernel already edited: the path
//! is in both sets. This module closes that gap narrowly: at run end it hashes only the files the
//! Kernel's receipts touched (never the whole tree, never after each tool call) and compares each
//! with the post-image hash the receipt claimed.
//!
//! * `Attested`: every receipted file has exactly the receipted content (or is absent, for a
//!   receipted delete). The receipts are independently confirmed at that moment.
//! * `Mismatch`: at least one file differs from its receipt: someone else wrote it.
//! * `Unavailable`: the files could not be read safely; nothing is claimed either way.
//!
//! Safety: read-only; components are checked with `symlink_metadata` and the final open uses
//! `O_NOFOLLOW`, only regular files are hashed, nothing is stored but the verdict. It is a
//! point-in-time read of a directory another process could still be changing; it attests the
//! state at the read, not afterwards.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Attestation {
    Attested { files: u32 },
    Mismatch { paths: u32 },
    Unavailable { reason: String },
}

impl Default for Attestation {
    fn default() -> Self {
        Self::Unavailable {
            reason: "not-recorded".into(),
        }
    }
}

enum Observed {
    Absent,
    Hash(String),
}

fn observe(root: &Path, rel: &str) -> Result<Observed, String> {
    let mut cur = root.to_path_buf();
    let comps: Vec<&str> = rel.split('/').collect();
    for (i, c) in comps.iter().enumerate() {
        cur.push(c);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => return Err("symlink-in-path".into()),
            Ok(m) if i + 1 < comps.len() && !m.is_dir() => return Err("not-a-directory".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Observed::Absent),
            Err(_) => return Err("unreadable".into()),
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&cur)
        .map_err(|_| "unreadable".to_owned())?;
    if !f.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err("not-a-regular-file".into());
    }
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => h.update(&buf[..n]),
            Err(_) => return Err("unreadable".into()),
        }
    }
    Ok(Observed::Hash(hex::encode(h.finalize())))
}

/// `expected`: (workspace-relative path, receipted content hash or `None` for "absent").
pub fn attest<'a>(
    root: &Path,
    expected: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Attestation {
    let (mut files, mut bad) = (0u32, 0u32);
    for (rel, want) in expected {
        match (observe(root, rel), want) {
            (Ok(Observed::Absent), None) => {}
            (Ok(Observed::Hash(h)), Some(w)) if h == w => {}
            (Ok(_), _) => bad += 1,
            (Err(reason), _) => return Attestation::Unavailable { reason },
        }
        files += 1;
    }
    if bad > 0 {
        Attestation::Mismatch { paths: bad }
    } else {
        Attestation::Attested { files }
    }
}
