//! Durable, append-only evidence log: `<state>/verification/<run_id>.jsonl`.
//!
//! One line per record: `{"v":1,"sum":"<sha256 of body>","body":"<record json>"}`. The checksum
//! lets a reader tell a torn write or a damaged line from a real record; such lines are counted
//! and reported, never interpreted (and never read as success). A line of an unknown schema
//! version is likewise skipped and counted. Diagnostics go to a sibling `.diag.jsonl`.

use super::evidence::{EvidenceRecord, MIN_SCHEMA_VERSION, SCHEMA_VERSION};
use super::ledger::Ledger;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Line {
    v: u32,
    sum: String,
    body: String,
}

pub fn dir(state_dir: &Path) -> PathBuf {
    state_dir.join("verification")
}

fn safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty() && !run_id.contains(['/', '.', '\0'])
}

fn path(state_dir: &Path, run_id: &str, suffix: &str) -> Option<PathBuf> {
    safe_run_id(run_id).then(|| dir(state_dir).join(format!("{run_id}{suffix}")))
}

fn sum(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}

fn open_append(p: &Path) -> std::io::Result<std::fs::File> {
    if let Some(d) = p.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(d)?;
    }
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(p)
}

/// One log line (no newline) for `rec` under line version `v`. Tests use an older `v` to write
/// the lines an earlier build produced.
pub fn encode_line(rec: &EvidenceRecord, v: u32) -> std::io::Result<String> {
    let body = serde_json::to_string(rec).map_err(std::io::Error::other)?;
    encode_raw(body, v)
}

/// A log line around an already-serialized record body.
pub fn encode_raw(body: String, v: u32) -> std::io::Result<String> {
    let line = Line {
        v,
        sum: sum(&body),
        body,
    };
    serde_json::to_string(&line).map_err(std::io::Error::other)
}

/// Append records durably (write + fsync). On error nothing is claimed as recorded.
pub fn append(state_dir: &Path, run_id: &str, recs: &[&EvidenceRecord]) -> std::io::Result<()> {
    let p = path(state_dir, run_id, ".jsonl")
        .ok_or_else(|| std::io::Error::other("run id is not a safe file name"))?;
    let mut buf = String::new();
    for r in recs {
        buf.push_str(&encode_line(r, SCHEMA_VERSION)?);
        buf.push('\n');
    }
    // A crash can leave a torn last line without its newline; the next record must not be glued
    // onto it (that would destroy a good record). Start a fresh line instead.
    if ends_mid_line(&p) {
        buf.insert(0, '\n');
    }
    let mut f = open_append(&p)?;
    f.write_all(buf.as_bytes())?;
    f.sync_all()
}

fn ends_mid_line(p: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(p) else {
        return false;
    };
    let Ok(len) = f.seek(SeekFrom::End(0)) else {
        return false;
    };
    if len == 0 || f.seek(SeekFrom::End(-1)).is_err() {
        return false;
    }
    let mut last = [0u8; 1];
    f.read_exact(&mut last).is_ok() && last[0] != b'\n'
}

/// A line that could not be read as evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    pub line: usize,
    /// `damaged` | `checksum-mismatch` | `unsupported-version` | `unreadable-record`
    pub reason: &'static str,
}

#[derive(Debug, Default)]
pub struct Loaded {
    pub ledger: Ledger,
    pub unreadable: Vec<Unreadable>,
    /// Records skipped because their id was already present (replays in the log).
    pub duplicates: usize,
}

impl Loaded {
    /// The log is complete and trustworthy only if every line was read.
    pub fn is_intact(&self) -> bool {
        self.unreadable.is_empty()
    }
}

/// Rebuild the run's ledger from disk. A missing log is an empty, intact ledger.
pub fn load(state_dir: &Path, run_id: &str) -> Loaded {
    let mut out = Loaded::default();
    let Some(p) = path(state_dir, run_id, ".jsonl") else {
        return out;
    };
    let Ok(f) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&p)
    else {
        return out;
    };
    for (i, raw) in std::io::BufReader::new(f).split(b'\n').enumerate() {
        let bad = |out: &mut Loaded, reason| {
            out.unreadable.push(Unreadable {
                line: i + 1,
                reason,
            })
        };
        let Ok(raw) = raw else {
            bad(&mut out, "damaged");
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let Ok(line) = serde_json::from_slice::<Line>(&raw) else {
            bad(&mut out, "damaged");
            continue;
        };
        if !(MIN_SCHEMA_VERSION..=SCHEMA_VERSION).contains(&line.v) {
            bad(&mut out, "unsupported-version");
            continue;
        }
        if sum(&line.body) != line.sum {
            bad(&mut out, "checksum-mismatch");
            continue;
        }
        match serde_json::from_str::<EvidenceRecord>(&line.body) {
            Ok(r) if (MIN_SCHEMA_VERSION..=SCHEMA_VERSION).contains(&r.schema_version) => {
                if out.ledger.insert(r) != super::ledger::Inserted::New {
                    out.duplicates += 1;
                }
            }
            Ok(_) => bad(&mut out, "unsupported-version"),
            Err(_) => bad(&mut out, "unreadable-record"),
        }
    }
    out
}

/// Best-effort diagnostic line (never fails the caller).
pub fn diagnostic(state_dir: &Path, run_id: &str, code: &str, detail: &str) {
    eprintln!("[verification] run {run_id}: {code}: {detail}");
    let Some(p) = path(state_dir, run_id, ".diag.jsonl") else {
        return;
    };
    if let Ok(mut f) = open_append(&p) {
        let line = serde_json::json!({ "code": code, "detail": detail.chars().take(300).collect::<String>() });
        let _ = writeln!(f, "{line}");
    }
}

/// Diagnostics recorded for the run (empty when none).
pub fn read_diagnostics(state_dir: &Path, run_id: &str) -> Vec<serde_json::Value> {
    let Some(p) = path(state_dir, run_id, ".diag.jsonl") else {
        return Vec::new();
    };
    let Ok(f) = std::fs::File::open(p) else {
        return Vec::new();
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// Does the run have a durable evidence log at all?
pub fn exists(state_dir: &Path, run_id: &str) -> bool {
    path(state_dir, run_id, ".jsonl").is_some_and(|p| p.is_file())
}

/// Append opaque, checksummed bodies to a sibling log of the run (`<run><suffix>`), durably.
/// Same line format and torn-line handling as the evidence log; used by the feedback journal.
pub fn append_bodies(
    state_dir: &Path,
    run_id: &str,
    suffix: &str,
    bodies: &[String],
) -> std::io::Result<()> {
    let p = path(state_dir, run_id, suffix)
        .ok_or_else(|| std::io::Error::other("run id is not a safe file name"))?;
    let mut buf = String::new();
    if ends_mid_line(&p) {
        buf.push('\n');
    }
    for b in bodies {
        buf.push_str(&encode_raw(b.clone(), SCHEMA_VERSION)?);
        buf.push('\n');
    }
    let mut f = open_append(&p)?;
    f.write_all(buf.as_bytes())?;
    f.sync_all()
}

/// Read the bodies of a sibling log. `unreadable` counts lines that failed their checksum or were
/// torn; those are never interpreted. A missing log is empty and intact.
pub fn read_bodies(state_dir: &Path, run_id: &str, suffix: &str) -> (Vec<String>, usize) {
    let (mut out, mut bad) = (Vec::new(), 0usize);
    let Some(p) = path(state_dir, run_id, suffix) else {
        return (out, 0);
    };
    let Ok(f) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&p)
    else {
        return (out, 0);
    };
    for raw in std::io::BufReader::new(f).split(b'\n') {
        let Ok(raw) = raw else {
            bad += 1;
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        match serde_json::from_slice::<Line>(&raw) {
            Ok(l)
                if (MIN_SCHEMA_VERSION..=SCHEMA_VERSION).contains(&l.v)
                    && sum(&l.body) == l.sum =>
            {
                out.push(l.body)
            }
            _ => bad += 1,
        }
    }
    (out, bad)
}

/// Does a sibling log of the run exist?
pub fn exists_suffix(state_dir: &Path, run_id: &str, suffix: &str) -> bool {
    path(state_dir, run_id, suffix).is_some_and(|p| p.is_file())
}
