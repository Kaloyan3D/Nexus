//! The trusted Mac-side project registry: one record per project the person opened, the standing
//! consent they gave, the last accepted baseline, and the durable state of every run's
//! synchronization. Everything here is Mac-owned; the guest and the bridge can read none of it
//! and can change none of it.

use super::guest::write_atomic;
use super::manifest::{ChangeKind, FileEntry, Files, SkipNote};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCOPE_VERSION: &str = "project-writeback-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    pub granted_at_ms: u64,
    /// What the person agreed to; a change of scope needs a new consent.
    pub scope: String,
    /// The folder the consent was given for.
    pub root: String,
    /// The person also chose to have results applied when they could not be verified (a project
    /// without tests). Never covers a failed check, a cancelled run or an error.
    #[serde(default)]
    pub apply_unverified: bool,
}

/// Where a run's result is on its way to the Mac folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum SyncState {
    /// Folder being copied to the Linux engine.
    Staging,
    /// The engine is working.
    Running,
    /// Reading the finished result out of the engine.
    Exporting,
    /// Result received and verified; backups and journal written.
    Prepared,
    /// Writing to the Mac folder.
    Applying,
    /// Written to the Mac folder and recorded.
    Applied,
    /// The Mac folder changed too; nothing was overwritten.
    Conflict,
    /// An error stopped the synchronization; the Mac folder was restored.
    Failed,
    /// The run did not qualify (cancelled, failed, unverified); nothing was written.
    NotApplied { reason: String },
}

impl SyncState {
    pub fn active(&self) -> bool {
        matches!(
            self,
            Self::Staging | Self::Running | Self::Exporting | Self::Prepared | Self::Applying
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    pub thread_id: Option<String>,
    pub sync: SyncState,
    pub started_ms: u64,
    pub generation_at_start: u64,
    pub verification: Option<String>,
    pub changed: Vec<ChangedFile>,
    pub conflicts: Vec<ConflictInfo>,
    pub message: Option<String>,
    pub applied_ms: Option<u64>,
    /// Where Nexus's result is kept when it could not be applied (Mac-side, outside the project).
    pub saved_result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub label: String,
    /// Canonical Mac path at registration, and the folder's identity (survives renames of parents).
    pub root: String,
    pub root_dev: u64,
    pub root_ino: u64,
    pub created_ms: u64,
    pub consent: Option<Consent>,
    /// Broker project id of the engine-side working copy (what the renderer uses as `projectId`).
    pub guest_id: Option<String>,
    /// Accepted synchronization generation (host baseline == guest baseline).
    pub generation: u64,
    /// The folder has been staged and the engine holds `baseline`.
    pub staged: bool,
    pub last_sync_ms: Option<u64>,
    pub staging: bool,
    pub skipped: Vec<SkipNote>,
    pub skipped_total: u64,
    pub file_count: u64,
    pub total_bytes: u64,
    pub runs: Vec<RunRecord>,
}

impl Project {
    pub fn run(&self, id: &str) -> Option<&RunRecord> {
        self.runs.iter().find(|r| r.run_id == id)
    }
    pub fn active_run(&self) -> Option<&RunRecord> {
        self.runs.iter().find(|r| r.sync.active())
    }
    pub fn pending_conflict(&self) -> Option<&RunRecord> {
        self.runs.iter().find(|r| r.sync == SyncState::Conflict)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RegFile {
    schema: u32,
    projects: BTreeMap<String, Project>,
}

pub struct Store {
    dir: PathBuf,
    inner: Mutex<RegFile>,
}

#[derive(Debug)]
pub struct StoreError(pub String);
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
fn se(e: impl std::fmt::Display) -> StoreError {
    StoreError(e.to_string())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Store {
    pub fn open(dir: &Path) -> Result<Store, StoreError> {
        std::fs::create_dir_all(dir.join("projects")).map_err(se)?;
        let file = dir.join("registry.json");
        let reg = match std::fs::read(&file) {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| StoreError(format!("registry.json is damaged: {e}")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => RegFile {
                schema: 1,
                projects: BTreeMap::new(),
            },
            Err(e) => return Err(se(e)),
        };
        Ok(Store {
            dir: dir.to_owned(),
            inner: Mutex::new(reg),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn save(&self, reg: &RegFile) -> Result<(), StoreError> {
        write_atomic(
            &self.dir.join("registry.json"),
            &serde_json::to_vec_pretty(reg).map_err(se)?,
        )
        .map_err(se)
    }

    pub fn list(&self) -> Vec<Project> {
        self.inner
            .lock()
            .map(|r| r.projects.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<Project> {
        self.inner
            .lock()
            .ok()
            .and_then(|r| r.projects.get(id).cloned())
    }

    pub fn find_by_guest(&self, gid: &str) -> Option<Project> {
        self.list()
            .into_iter()
            .find(|p| p.guest_id.as_deref() == Some(gid))
    }

    pub fn find_by_identity(&self, dev: u64, ino: u64) -> Option<Project> {
        self.list()
            .into_iter()
            .find(|p| p.root_dev == dev && p.root_ino == ino)
    }

    pub fn insert(&self, p: Project) -> Result<(), StoreError> {
        let mut g = self.inner.lock().map_err(|_| se("poisoned"))?;
        g.projects.insert(p.id.clone(), p);
        self.save(&g)
    }

    /// Mutate one project and persist before returning.
    pub fn update<T>(&self, id: &str, f: impl FnOnce(&mut Project) -> T) -> Result<T, StoreError> {
        let mut g = self.inner.lock().map_err(|_| se("poisoned"))?;
        let p = g
            .projects
            .get_mut(id)
            .ok_or_else(|| se("unknown project"))?;
        let out = f(p);
        self.save(&g)?;
        Ok(out)
    }

    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        let mut g = self.inner.lock().map_err(|_| se("poisoned"))?;
        g.projects.remove(id);
        self.save(&g)?;
        let _ = std::fs::remove_dir_all(self.pdir(id));
        Ok(())
    }

    // ---- per-project files -----------------------------------------------------------------

    pub fn pdir(&self, id: &str) -> PathBuf {
        self.dir.join("projects").join(id)
    }

    pub fn baseline(&self, id: &str) -> Files {
        std::fs::read(self.pdir(id).join("baseline.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save_baseline(&self, id: &str, files: &Files) -> Result<(), StoreError> {
        std::fs::create_dir_all(self.pdir(id)).map_err(se)?;
        write_atomic(
            &self.pdir(id).join("baseline.json"),
            &serde_json::to_vec(files).map_err(se)?,
        )
        .map_err(se)
    }

    pub fn run_dir(&self, id: &str, run: &str) -> PathBuf {
        self.pdir(id).join("runs").join(run)
    }

    pub fn journal(&self, id: &str, run: &str) -> Option<Journal> {
        std::fs::read(self.run_dir(id, run).join("journal.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
    }

    pub fn save_journal(&self, j: &Journal) -> Result<(), StoreError> {
        let d = self.run_dir(&j.project_id, &j.run_id);
        std::fs::create_dir_all(&d).map_err(se)?;
        write_atomic(
            &d.join("journal.json"),
            &serde_json::to_vec_pretty(j).map_err(se)?,
        )
        .map_err(se)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpStatus {
    Todo,
    Done,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Op {
    pub path: String,
    pub kind: ChangeKind,
    pub old: Option<FileEntry>,
    pub new: Option<FileEntry>,
    pub status: OpStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JState {
    Prepared,
    Applying,
    RollingBack,
    Applied,
    Conflict,
    Failed,
}

/// Durable record of one writeback. Rewritten (atomically, fsynced) after every step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub run_id: String,
    pub project_id: String,
    pub plan_digest: String,
    pub base_generation: u64,
    pub new_generation: u64,
    pub state: JState,
    pub ops: Vec<Op>,
    pub conflicts: Vec<ConflictInfo>,
    pub message: Option<String>,
    pub created_ms: u64,
    pub baseline_saved: bool,
    pub acked: bool,
}
