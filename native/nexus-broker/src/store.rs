//! Durable run records and the idempotency index.
//!
//! One JSON file per run, written atomically (temp + fsync + rename +
//! directory fsync). The idempotency index maps `sha256(clientId|key)` to a
//! run id and is created with `O_EXCL`, so a key can never map to two runs.

use nexus_client::intent_client::IntentRun;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run: IntentRun,
    pub payload_digest: String,
    pub idempotency_key: String,
    /// The task text, kept so an interrupted task can be continued (never sent anywhere).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// EM-01: the Registry mode and orchestration engine this run was bound to (absent on
    /// records written before EM-01). Broker-internal: not part of the run view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    /// EM-02: digest of the task binding the Kernel sealed for this run, and the identity a
    /// continuation must keep (absent on records written before EM-02). Broker-internal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_binding_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_binding_identity: Option<String>,
    /// EM-04C2 S3: the version of the identity digest above (2 = includes the slot's
    /// `allowedReasoning`). Absent on runs recorded before EM-04C2 (legacy digest).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_binding_identity_version: Option<u32>,
    /// EM-04C1: digest of the exact tool catalog this run was offered (the frozen identity of its
    /// profile). Absent on records written before EM-04C1. Broker-internal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_catalog_digest: Option<String>,
    /// EM-04C2 S10 (SEC-1): whether the run's durable engine state was created. `Some(false)` from
    /// the moment the run is recorded; `Some(true)` right after `EngineRun::start` returns (before any
    /// attempt can exist). `None` = a record written before S10: unknown, so a continuation that finds
    /// no authentic engine record treats it as possibly LOST. Broker-internal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_state_started: Option<bool>,
}

pub struct Store {
    dir: PathBuf,
    lock: Mutex<()>,
}

pub fn valid_run_id(id: &str) -> bool {
    id.len() == 36
        && id.starts_with("run_")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn fsync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(p) = path.parent() {
        fsync_dir(p);
    }
    Ok(())
}

impl Store {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        for sub in ["runs", "idem"] {
            std::fs::create_dir_all(dir.join(sub))?;
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            lock: Mutex::new(()),
        })
    }

    fn run_path(&self, id: &str) -> PathBuf {
        self.dir.join("runs").join(format!("{id}.json"))
    }

    fn idem_path(&self, client: &str, key: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(client.as_bytes());
        h.update([0u8]);
        h.update(key.as_bytes());
        self.dir.join("idem").join(hex::encode(h.finalize()))
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Caller holds [`Store::lock`].
    pub fn put(&self, rec: &RunRecord) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(rec).map_err(std::io::Error::other)?;
        write_atomic(&self.run_path(&rec.run.run_id), &bytes)
    }

    pub fn load(&self, id: &str) -> Option<RunRecord> {
        if !valid_run_id(id) {
            return None;
        }
        let raw = std::fs::read(self.run_path(id)).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    pub fn all(&self) -> Vec<RunRecord> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.dir.join("runs")) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(id) = name.strip_suffix(".json") {
                    if let Some(r) = self.load(id) {
                        out.push(r);
                    }
                }
            }
        }
        out.sort_by_key(|r| std::cmp::Reverse(r.run.created_at_ms));
        out
    }

    pub fn idem_lookup(&self, client: &str, key: &str) -> Option<String> {
        let raw = std::fs::read_to_string(self.idem_path(client, key)).ok()?;
        let id = raw.trim().to_owned();
        valid_run_id(&id).then_some(id)
    }

    /// Create the key -> run mapping exclusively. `false` if it exists.
    pub fn idem_create(&self, client: &str, key: &str, run_id: &str) -> std::io::Result<bool> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = self.idem_path(client, key);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(run_id.as_bytes())?;
                f.sync_all()?;
                if let Some(p) = path.parent() {
                    fsync_dir(p);
                }
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    }
}
