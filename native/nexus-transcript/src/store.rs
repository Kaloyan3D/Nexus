//! Durable native transcript store: one append-only, hash-chained JSONL file
//! per task instance. Only the backend process appends; there is no renderer
//! write path. A torn trailing line (crash mid-append) is tolerated and
//! skipped; any chain break fails closed from the break onward.

use crate::contract::{Source, TranscriptEventV1, TRANSCRIPT_SCHEMA};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StoreError {
    #[error("invalid task instance id")]
    BadTaskId,
    #[error("event belongs to a different task than the target transcript")]
    CrossTask,
    #[error("event conflicts with an existing record of the same id and revision")]
    Conflict,
    #[error("invalid event: {0}")]
    Invalid(String),
    #[error("transcript integrity failure at line {0}")]
    Integrity(u64),
    #[error("io: {0}")]
    Io(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppendOutcome {
    pub seq: u64,
    pub duplicate: bool,
}

#[derive(Serialize, Deserialize)]
struct Line {
    v: u32,
    prev: String,
    hash: String,
    event: TranscriptEventV1,
}

/// Result of loading a task file.
pub struct Loaded {
    pub events: Vec<TranscriptEventV1>,
    /// Number of unusable trailing/invalid lines skipped.
    pub skipped: u64,
    pub integrity_failure_at: Option<u64>,
}

struct Cache {
    file_len: u64,
    last_hash: String,
    next_seq: u64,
    seen: HashMap<(String, u32), TranscriptEventV1>,
}

pub struct TranscriptStore {
    root: PathBuf,
    // Append fast path, revalidated against the on-disk length each call so a
    // foreign writer or torn tail forces a full verified reload.
    cache: Mutex<HashMap<String, Cache>>,
}

const GENESIS: &str = "genesis";

pub fn valid_task_id(id: &str) -> bool {
    let rest = id
        .strip_prefix("task_")
        .or_else(|| id.strip_prefix("mock_"))
        .or_else(|| id.strip_prefix("model_"));
    match rest {
        Some(r) => {
            r.len() == 32
                && r.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
        None => false,
    }
}

fn digest(prev: &str, event: &TranscriptEventV1) -> String {
    let body = serde_json::to_string(event).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(prev.as_bytes());
    h.update(b"\n");
    h.update(body.as_bytes());
    hex::encode(h.finalize())
}

impl TranscriptStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| StoreError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&root, fs::Permissions::from_mode(0o700));
        }
        Ok(Self {
            root,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path_for(&self, task: &str) -> Result<PathBuf, StoreError> {
        if !valid_task_id(task) {
            return Err(StoreError::BadTaskId);
        }
        Ok(self.root.join(format!("{task}.jsonl")))
    }

    pub fn exists(&self, task: &str) -> bool {
        self.path_for(task).map(|p| p.is_file()).unwrap_or(false)
    }

    /// Append one event. `event.seq` is assigned here. Re-appending the same
    /// id + revision with identical content is an idempotent duplicate.
    pub fn append(
        &self,
        task: &str,
        mut event: TranscriptEventV1,
    ) -> Result<AppendOutcome, StoreError> {
        let path = self.path_for(task)?;
        if event.task_instance_id != task {
            return Err(StoreError::CrossTask);
        }
        if event.schema != TRANSCRIPT_SCHEMA {
            return Err(StoreError::Invalid("schema".into()));
        }
        if event.event_id.is_empty() || event.message_id.is_empty() {
            return Err(StoreError::Invalid("empty id".into()));
        }
        if event.source == Source::DshSessionLog {
            return Err(StoreError::Invalid(
                "historical DSH records are read in place, never copied into the native store"
                    .into(),
            ));
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .map_err(|e| StoreError::Io(e.to_string()))?;
        file.lock_exclusive()
            .map_err(|e| StoreError::Io(e.to_string()))?;
        let result = (|| {
            let on_disk = file
                .metadata()
                .map_err(|e| StoreError::Io(e.to_string()))?
                .len();
            let mut cache = self
                .cache
                .lock()
                .map_err(|_| StoreError::Io("poisoned".into()))?;
            let fresh = match cache.get(task) {
                Some(c) => c.file_len == on_disk,
                None => false,
            };
            if !fresh {
                let loaded = load_file(&path)?;
                if let Some(at) = loaded.integrity_failure_at {
                    return Err(StoreError::Integrity(at));
                }
                let mut seen = HashMap::new();
                let next_seq = loaded.events.last().map(|e| e.seq + 1).unwrap_or(0);
                for e in loaded.events {
                    seen.insert((e.event_id.clone(), e.revision), e);
                }
                cache.insert(
                    task.to_owned(),
                    Cache {
                        file_len: on_disk,
                        last_hash: last_hash(&path)?,
                        next_seq,
                        seen,
                    },
                );
            }
            let c = cache.get_mut(task).ok_or(StoreError::Io("cache".into()))?;
            if let Some(existing) = c.seen.get(&(event.event_id.clone(), event.revision)) {
                let mut a = existing.clone();
                let mut b = event.clone();
                a.seq = 0;
                b.seq = 0;
                return if a == b {
                    Ok(AppendOutcome {
                        seq: existing.seq,
                        duplicate: true,
                    })
                } else {
                    Err(StoreError::Conflict)
                };
            }
            let seq = c.next_seq;
            event.seq = seq;
            let prev = c.last_hash.clone();
            let hash = digest(&prev, &event);
            let line = Line {
                v: 1,
                prev,
                hash: hash.clone(),
                event: event.clone(),
            };
            let mut text =
                serde_json::to_string(&line).map_err(|e| StoreError::Io(e.to_string()))?;
            text.push('\n');
            // A torn previous write may leave no trailing newline.
            let mut w = &file;
            let mut written = text.len() as u64;
            if needs_leading_newline(&path) {
                w.write_all(b"\n")
                    .map_err(|e| StoreError::Io(e.to_string()))?;
                written += 1;
            }
            w.write_all(text.as_bytes())
                .map_err(|e| StoreError::Io(e.to_string()))?;
            file.sync_all().map_err(|e| StoreError::Io(e.to_string()))?;
            c.file_len = on_disk + written;
            c.last_hash = hash;
            c.next_seq = seq + 1;
            c.seen
                .insert((event.event_id.clone(), event.revision), event);
            Ok(AppendOutcome {
                seq,
                duplicate: false,
            })
        })();
        let _ = FileExt::unlock(&file);
        result
    }

    /// Load every valid event of one task (chain verified).
    pub fn load(&self, task: &str) -> Result<Loaded, StoreError> {
        let path = self.path_for(task)?;
        if !path.is_file() {
            return Ok(Loaded {
                events: Vec::new(),
                skipped: 0,
                integrity_failure_at: None,
            });
        }
        let loaded = load_file(&path)?;
        // Cross-task defense: a record naming another task is an integrity failure.
        if let Some(bad) = loaded
            .events
            .iter()
            .position(|e| e.task_instance_id != task)
        {
            return Ok(Loaded {
                events: loaded.events[..bad].to_vec(),
                skipped: loaded.skipped,
                integrity_failure_at: Some(bad as u64 + 1),
            });
        }
        Ok(loaded)
    }
}

fn needs_leading_newline(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return false;
    };
    if len == 0 || f.seek(SeekFrom::Start(len - 1)).is_err() {
        return false;
    }
    let mut b = [0u8; 1];
    f.read_exact(&mut b).is_ok() && b[0] != b'\n'
}

fn last_hash(path: &Path) -> Result<String, StoreError> {
    let f = File::open(path).map_err(|e| StoreError::Io(e.to_string()))?;
    let mut last = GENESIS.to_owned();
    for l in BufReader::new(f).lines().map_while(Result::ok) {
        if let Ok(line) = serde_json::from_str::<Line>(&l) {
            last = line.hash;
        }
    }
    Ok(last)
}

fn load_file(path: &Path) -> Result<Loaded, StoreError> {
    let f = File::open(path).map_err(|e| StoreError::Io(e.to_string()))?;
    let mut events = Vec::new();
    let mut prev = GENESIS.to_owned();
    let mut skipped = 0u64;
    let mut failure = None;
    let lines: Vec<String> = BufReader::new(f).lines().map_while(Result::ok).collect();
    for (idx, l) in lines.into_iter().enumerate() {
        if l.trim().is_empty() {
            continue;
        }
        let n = idx as u64 + 1;
        match serde_json::from_str::<Line>(&l) {
            Ok(line) => {
                if line.prev != prev || digest(&prev, &line.event) != line.hash {
                    failure = Some(n);
                    break;
                }
                prev = line.hash.clone();
                events.push(line.event);
            }
            Err(_) => {
                // Unparseable lines (torn writes) are skipped and counted; they
                // cannot forge records because every parsed line must chain.
                skipped += 1;
            }
        }
    }
    Ok(Loaded {
        events,
        skipped,
        integrity_failure_at: failure,
    })
}
