//! Versioned project-transfer protocol (carried by `bridge_proto::ToGuest::Sync`).
//!
//! Every request names an authorized project id; the guest resolves it only under its own
//! Nexus-owned staging root. There is no verb that takes a path outside a project, runs a program
//! or reads anything that was not first described by a transfer or export plan.

use super::manifest::{Change, FileEntry, SkipNote};
use serde::{Deserialize, Serialize};

pub const SYNC_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum SyncReq {
    /// Start (or resume) staging generation `generation` of a project.
    StageBegin {
        project_id: String,
        /// Folder name the project is shown with (also the working-copy directory name).
        label: String,
        generation: u64,
        /// Digest of the baseline the host believes the guest holds (`None` = first staging).
        base_digest: Option<String>,
        target_digest: String,
        change_count: u64,
    },
    /// A page of the change list, `start` = index of the first change in the page.
    StageChanges {
        project_id: String,
        generation: u64,
        start: u64,
        changes: Vec<Change>,
    },
    /// A bounded slice of one file's new content (base64), at `offset`.
    StageChunk {
        project_id: String,
        generation: u64,
        path: String,
        offset: u64,
        data: String,
    },
    StageStatus {
        project_id: String,
    },
    /// Verify everything, publish to the working copy, advance the guest baseline.
    StageCommit {
        project_id: String,
        generation: u64,
        target_digest: String,
    },
    StageAbort {
        project_id: String,
    },
    /// Derive the changed-file set from the real working copy against the guest baseline.
    ExportPlan {
        project_id: String,
    },
    ExportRead {
        project_id: String,
        plan_digest: String,
        path: String,
        offset: u64,
        len: u64,
    },
    /// The host applied the plan: advance the guest baseline by exactly that plan.
    ExportAck {
        project_id: String,
        plan_digest: String,
        generation: u64,
    },
    /// Remove every guest file of the project.
    Discard {
        project_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageStatus {
    pub baseline_generation: Option<u64>,
    pub baseline_digest: Option<String>,
    pub in_progress: Option<InProgress>,
    pub work_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InProgress {
    pub generation: u64,
    pub target_digest: String,
    pub change_count: u64,
    pub changes_received: u64,
    /// Files fully received and verified.
    pub files_done: Vec<String>,
    /// The file being received, with the bytes already held (resume point).
    pub partial: Option<(String, u64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub base_generation: u64,
    pub plan_digest: String,
    pub changes: Vec<Change>,
    /// Digest of the whole working copy at planning time.
    pub workspace_digest: String,
    /// Things in the working copy that are not synchronized (symlinks, sockets, ...), bounded.
    pub ignored: Vec<SkipNote>,
    pub ignored_total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadReply {
    pub data: String,
    pub eof: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitReply {
    pub work_path: String,
    pub generation: u64,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncErr {
    pub code: String,
    pub message: String,
}

impl SyncErr {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SyncErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// The new content a change carries (None for deletions).
pub fn new_entry(c: &Change) -> Option<&FileEntry> {
    c.new.as_ref()
}
