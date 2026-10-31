//! Verification target identity (Verification Engine, Phase 03).
//!
//! What a check was run AGAINST, as far as the Core can establish it without trusting the
//! model and without adding a hashing subsystem or touching the project.
//!
//! # What the source identity is
//!
//! `SourceIdentity::ReceiptDelta`: a digest of the files the Kernel's own mutation receipts
//! (`fs_write` / `fs_edit`: path, pre-image hash, post-image hash) have changed, relative to
//! the content the run started with. A file written back to its original content drops out
//! of the digest again, so `A -> B -> A` is the same identity as `A`.
//!
//! It guarantees: any change made through the Kernel's mediated write tools changes the
//! identity, and the identity is derived from content hashes, never from timestamps, a
//! modification count, or Git `HEAD`.
//!
//! It does NOT guarantee that nothing else changed. It is only sound while the Kernel is the
//! sole writer of the workspace, which `exclusive` records. It is not exclusive when the
//! workspace is the user's real folder (Direct Workspace), when commands run in place, or when
//! background jobs exist; then equality of two identities proves nothing and freshness is
//! `Indeterminate` (a differing identity still proves staleness). The daemon's `worktree-diff`
//! is deliberately NOT called mid-run: it stages the copy into its Git index, which a model's
//! own `git` commands could observe. It is used once, at run end, as a cross-check
//! (see `BoundaryObservation`).
//!
//! Not covered, and recorded as such: ignored files (`.gitignore`d, `node_modules`, `target`),
//! the toolchain and environment variables (`environment` / `runtime` stay `None`), the
//! network, and anything a process reads outside the workspace.

use super::evidence::MutationObservation;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const TARGET_VERSION: u32 = 1;
/// Name of the source identity model, recorded so a future model never reads this one's records.
pub const SOURCE_MODEL: &str = "receipt-delta/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceKind {
    /// The daemon-owned isolated copy.
    Isolated,
    /// The user's real folder.
    Direct,
    #[default]
    Unknown,
}

/// How the run's starting content relates to `baseline_commit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Baseline {
    /// A fresh copy of the project at `baseline_commit`.
    Fresh,
    /// Earlier work was carried over onto the copy: `baseline_commit` alone does not describe it.
    Seeded,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBinding {
    pub kind: WorkspaceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_instance_id: Option<String>,
    /// The daemon's content-addressed snapshot commit the copy was created from (isolated only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_commit: Option<String>,
    pub baseline: Baseline,
    /// Commands of this task write the workspace in place (an explicit owner grant).
    pub in_place_execution: bool,
}

impl WorkspaceBinding {
    /// Why this workspace may be written by someone other than the Kernel's mediated tools.
    pub fn shared_writer_reasons(&self) -> Vec<String> {
        let mut r = Vec::new();
        match self.kind {
            WorkspaceKind::Isolated => {}
            WorkspaceKind::Direct => r.push("direct-workspace".to_owned()),
            WorkspaceKind::Unknown => r.push("workspace-mode-unknown".to_owned()),
        }
        if self.in_place_execution {
            r.push("in-place-execution".to_owned());
        }
        r
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SourceIdentity {
    ReceiptDelta {
        /// sha256 over the sorted (path, content hash) of every file that differs from the start.
        digest: String,
        /// Mutation receipts folded in so far (informational; never an identity by itself).
        mutations: u32,
        changed_paths: u32,
        /// The Kernel was the only possible writer for the whole run so far.
        exclusive: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        shared_reasons: Vec<String>,
    },
    /// The identity cannot be established; never treated as current.
    Unknown { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationTargetV1 {
    pub version: u32,
    pub workspace: WorkspaceBinding,
    /// `SOURCE_MODEL`
    pub source_model: String,
    pub source: SourceIdentity,
    /// Dependencies / toolchain identity: not observable by the Core today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// Runtime process / generated-artifact identity: not observable by the Core today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

/// Folds the Kernel's mutation receipts into a [`SourceIdentity`].
#[derive(Debug, Clone, Default)]
pub struct SourceTracker {
    binding: WorkspaceBinding,
    base: BTreeMap<String, String>,
    cur: BTreeMap<String, String>,
    mutations: u32,
    unknown: Option<String>,
    shared: BTreeSet<String>,
}

const ABSENT: &str = "absent";

fn normalize(path: &str) -> Option<String> {
    let p = path.replace('\\', "/");
    let p = p.trim_start_matches("./");
    if p.is_empty() || p.starts_with('/') || p.split('/').any(|c| c == ".." || c.is_empty()) {
        return None;
    }
    Some(p.to_owned())
}

impl SourceTracker {
    pub fn new(binding: WorkspaceBinding) -> Self {
        let shared = binding.shared_writer_reasons().into_iter().collect();
        Self {
            binding,
            shared,
            ..Default::default()
        }
    }

    pub fn binding(&self) -> &WorkspaceBinding {
        &self.binding
    }

    /// A Kernel-receipted mutation that was applied. An incomplete receipt makes the source
    /// identity unknowable from then on: it is never guessed.
    pub fn apply(&mut self, m: &MutationObservation) {
        self.mutations += 1;
        let Some(path) = m.path.as_deref().and_then(normalize) else {
            self.unknown
                .get_or_insert_with(|| "mutation-receipt-without-usable-path".into());
            return;
        };
        let op = m.operation.as_deref().unwrap_or("");
        let pre = match (&m.pre_sha256, op) {
            (Some(h), _) => h.clone(),
            (None, "create") => ABSENT.to_owned(),
            _ => {
                self.unknown
                    .get_or_insert_with(|| "mutation-receipt-without-pre-image".into());
                return;
            }
        };
        let post = match (&m.post_sha256, op) {
            // A delete leaves no file, whatever hash the receipt carries: the Kernel reports the
            // hash of EMPTY content there (e3b0c442...). Found by the first live provider run,
            // where reading it as "a file with empty content exists" made an honest run unattestable.
            (_, "delete") => ABSENT.to_owned(),
            (Some(h), _) => h.clone(),
            _ => {
                self.unknown
                    .get_or_insert_with(|| "mutation-receipt-without-post-image".into());
                return;
            }
        };
        self.base.entry(path.clone()).or_insert(pre);
        self.cur.insert(path, post);
    }

    /// A mutation or process whose effect on the workspace is not known (lost answer, cancelled
    /// while it may have been writing).
    pub fn note_unknown(&mut self, reason: &str) {
        self.unknown.get_or_insert_with(|| reason.to_owned());
    }

    /// Something other than the Kernel's mediated tools may write the workspace.
    pub fn note_shared(&mut self, reason: &str) {
        self.shared.insert(reason.to_owned());
    }

    /// Net-changed paths (current content differs from the start).
    pub fn changed(&self) -> BTreeSet<&str> {
        self.cur
            .iter()
            .filter(|(p, h)| self.base.get(*p) != Some(*h))
            .map(|(p, _)| p.as_str())
            .collect()
    }

    /// Every file a receipt touched with the content hash it must have now (`None` = absent).
    pub fn touched(&self) -> Vec<(&str, Option<&str>)> {
        self.cur
            .iter()
            .map(|(p, h)| (p.as_str(), (h != ABSENT).then_some(h.as_str())))
            .collect()
    }

    pub fn source(&self) -> SourceIdentity {
        if let Some(r) = &self.unknown {
            return SourceIdentity::Unknown { reason: r.clone() };
        }
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"nexus.verification.source.receipt-delta.v1\0");
        let mut n = 0u32;
        for (p, c) in &self.cur {
            if self.base.get(p) != Some(c) {
                h.update(p.as_bytes());
                h.update([0]);
                h.update(c.as_bytes());
                h.update(*b"\n");
                n += 1;
            }
        }
        SourceIdentity::ReceiptDelta {
            digest: hex::encode(h.finalize()),
            mutations: self.mutations,
            changed_paths: n,
            exclusive: self.shared.is_empty(),
            shared_reasons: self.shared.iter().cloned().collect(),
        }
    }

    pub fn target(&self) -> VerificationTargetV1 {
        VerificationTargetV1 {
            version: TARGET_VERSION,
            workspace: self.binding.clone(),
            source_model: SOURCE_MODEL.into(),
            source: self.source(),
            environment: None,
            runtime: None,
        }
    }
}
