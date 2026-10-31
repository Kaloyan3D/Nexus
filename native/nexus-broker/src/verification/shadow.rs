//! The Core-owned shadow recorder: turns confirmed tool outcomes into durable evidence.
//!
//! It only OBSERVES. It reads the broker's finished `ToolActivity` entries (pushed after the
//! Kernel answered, or after the call was refused/failed) plus the receipt facts captured at that
//! point; it never executes a tool, sends a request, blocks, or feeds anything back to the model
//! or the Engine. A failure to persist becomes a diagnostic and nothing else. It is independent
//! of `engine/`, so every Engineering Mode shares it.

use super::evidence::*;
use super::ledger::{Inserted, Ledger};
use super::persistence;
use super::target::{SourceTracker, WorkspaceBinding};
use nexus_client::intent_client::ToolActivity;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Recorder version stamped into provenance.
pub const RECORDER_VERSION: u32 = 2;

/// Tools whose outcomes are verification-relevant: file mutations and processes.
fn kind_of(tool: &str) -> Option<ObservationKind> {
    match tool {
        "proc_run" => Some(ObservationKind::Command),
        "fs_write" | "fs_edit" => Some(ObservationKind::FileMutation),
        t if t.starts_with("job_") => Some(ObservationKind::BackgroundJob),
        _ => None,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct ShadowRecorder {
    state_dir: PathBuf,
    run_id: String,
    ids: RefCell<(Option<String>, Option<String>)>,
    ledger: RefCell<Ledger>,
    tracker: RefCell<SourceTracker>,
    /// Built records not yet durable (a failed write is retried, never forgotten or invented).
    pending: RefCell<Vec<EvidenceRecord>>,
    /// The workspace directory, read (hashing receipted files only) at run end.
    root: RefCell<Option<std::path::PathBuf>>,
    /// How many `ToolActivity` entries have been handled.
    cursor: Cell<usize>,
    enabled: bool,
}

/// What the daemon's end-of-run change set said (read from the `worktree-diff` the broker
/// already requests at finalization; nothing extra is asked of the daemon).
pub struct FinalChangeSet<'a> {
    /// The daemon answered.
    pub available: bool,
    pub truncated: bool,
    pub paths: &'a [String],
    pub diff_digest: Option<&'a str>,
}

impl ShadowRecorder {
    /// Opens the run's log (replaying what is already durable, so a restarted run adds nothing twice).
    pub fn new(state_dir: &std::path::Path, run_id: &str, enabled: bool) -> Self {
        if !enabled {
            return Self::disabled(state_dir, run_id);
        }
        let loaded = persistence::load(state_dir, run_id);
        if !loaded.is_intact() {
            persistence::diagnostic(
                state_dir,
                run_id,
                "evidence-log-unreadable-lines",
                &format!("{} line(s) could not be read", loaded.unreadable.len()),
            );
        }
        Self {
            state_dir: state_dir.to_path_buf(),
            run_id: run_id.to_owned(),
            ids: RefCell::new((None, None)),
            tracker: RefCell::new(SourceTracker::default()),
            pending: RefCell::new(Vec::new()),
            root: RefCell::new(None),
            ledger: RefCell::new(loaded.ledger),
            cursor: Cell::new(0),
            enabled: true,
        }
    }

    fn disabled(state_dir: &std::path::Path, run_id: &str) -> Self {
        Self {
            state_dir: state_dir.to_path_buf(),
            run_id: run_id.to_owned(),
            ids: RefCell::new((None, None)),
            ledger: RefCell::new(Ledger::default()),
            tracker: RefCell::new(SourceTracker::default()),
            pending: RefCell::new(Vec::new()),
            root: RefCell::new(None),
            cursor: Cell::new(usize::MAX),
            enabled: false,
        }
    }

    pub fn set_task(&self, task_id: &str, task_instance: &str) {
        *self.ids.borrow_mut() = (Some(task_id.to_owned()), Some(task_instance.to_owned()));
    }

    /// Bind the recorder to the workspace the run uses, and rebuild the source identity from the
    /// mutation records already durable (a restarted recorder continues, it does not start over).
    pub fn set_workspace(&self, binding: WorkspaceBinding, root: Option<&std::path::Path>) {
        *self.root.borrow_mut() = root.map(std::path::Path::to_path_buf);
        let mut t = SourceTracker::new(binding);
        for r in self.ledger.borrow().records() {
            replay(&mut t, r);
        }
        *self.tracker.borrow_mut() = t;
    }

    /// Record the run-end boundary: the daemon's change set against what the receipts predicted.
    /// Idempotent. Never changes the run; a failure is a diagnostic.
    pub fn finish(&self, fin: &FinalChangeSet<'_>) {
        if !self.enabled {
            return;
        }
        let (task_id, task_instance_id) = self.ids.borrow().clone();
        let t = self.tracker.borrow();
        let b = t.binding();
        let predicted = t.changed();
        let unavailable = if !fin.available {
            Some("daemon-change-set-unavailable")
        } else if fin.truncated {
            Some("change-set-truncated")
        } else if b.kind != super::target::WorkspaceKind::Isolated {
            Some("not-an-isolated-copy")
        } else if b.baseline != super::target::Baseline::Fresh {
            Some("baseline-not-fresh")
        } else if !b.shared_writer_reasons().is_empty() {
            Some("other-writers-possible")
        } else {
            None
        };
        let unreceipted = if unavailable.is_none() {
            fin.paths
                .iter()
                .filter(|p| !predicted.contains(p.as_str()))
                .count() as u32
        } else {
            0
        };
        let attestation = match self.root.borrow().as_deref() {
            Some(root) => super::attest::attest(root, t.touched()),
            None => super::attest::Attestation::Unavailable {
                reason: "workspace-directory-unknown".into(),
            },
        };
        let rec = EvidenceRecord {
            schema_version: SCHEMA_VERSION,
            evidence_id: evidence_id(&self.run_id, u32::MAX, Some("run-boundary")),
            run_id: self.run_id.clone(),
            task_id,
            task_instance_id,
            call_index: u32::MAX,
            turn: 0,
            tool: "run-boundary".into(),
            kind: ObservationKind::RunBoundary,
            execution: ExecutionState::Executed,
            provenance: Provenance {
                source: "daemon-change-set".into(),
                backend: None,
                recorder: RECORDER_VERSION,
                observed_at_ms: now_ms(),
            },
            receipt: ReceiptRef::default(),
            process: None,
            check: None,
            mutation: None,
            shadow: None,
            target: Some(t.target()),
            boundary: Some(BoundaryObservation {
                cross_check: unavailable.is_none(),
                unavailable: unavailable.map(str::to_owned),
                diff_digest: fin.diff_digest.map(str::to_owned),
                changed_paths: fin.paths.len() as u32,
                unreceipted_paths: unreceipted,
                attestation,
            }),
        };
        drop(t);
        self.pending.borrow_mut().push(rec);
        self.flush();
    }

    /// Read-only, point-in-time check that every file the Kernel's receipts touched still has the
    /// receipted content. Hashes only those files; never the tree; never writes. Used at the
    /// final-response boundary so a feedback decision is not made on receipts alone.
    pub fn attest_now(&self) -> super::attest::Attestation {
        match self.root.borrow().as_deref() {
            Some(root) => super::attest::attest(root, self.tracker.borrow().touched()),
            None => super::attest::Attestation::Unavailable {
                reason: "workspace-directory-unknown".into(),
            },
        }
    }

    /// The freshness of every trusted check recorded so far (see `freshness`).
    pub fn freshness_report(&self) -> Vec<super::freshness::FreshnessEntry> {
        super::freshness::report(&self.ledger.borrow())
    }

    /// Record every not-yet-handled activity entry. `facts` maps a call index to what the Kernel
    /// receipt said (absent for calls that never got one).
    pub fn observe(&self, activity: &[ToolActivity], facts: &BTreeMap<u32, ReceiptFacts>) {
        if !self.enabled {
            return;
        }
        let from = self.cursor.get();
        if from < activity.len() {
            let (task_id, task_instance_id) = self.ids.borrow().clone();
            for act in &activity[from..] {
                let mut tracker = self.tracker.borrow_mut();
                let execution = ExecutionState::from_status(&act.status, act.error_code.as_deref());
                let f = facts.get(&act.index);
                // fold the call into the source identity BEFORE its record is built, so a
                // mutation's target is the state after it and a check's is the state it ran on
                if act.tool.starts_with("job_") {
                    tracker.note_shared("background-job");
                }
                if matches!(act.tool.as_str(), "fs_write" | "fs_edit") {
                    match execution {
                        ExecutionState::Executed => match f.and_then(|f| f.mutation.as_ref()) {
                            Some(m) if act.execution_id.is_some() => tracker.apply(m),
                            _ => tracker.note_unknown("applied-mutation-without-receipt"),
                        },
                        ExecutionState::Uncertain | ExecutionState::Unknown => {
                            tracker.note_unknown("mutation-outcome-unknown")
                        }
                        // refused / failed (no receipt) / cancelled before running: no change
                        _ => {}
                    }
                } else if act.tool == "proc_run"
                    && tracker.binding().in_place_execution
                    && matches!(
                        execution,
                        ExecutionState::Uncertain | ExecutionState::Cancelled
                    )
                {
                    tracker.note_unknown("in-place-command-interrupted");
                }
                let target = tracker.target();
                drop(tracker);
                if let Some(rec) = build(
                    &self.run_id,
                    task_id.clone(),
                    task_instance_id.clone(),
                    act,
                    f,
                    target,
                ) {
                    self.pending.borrow_mut().push(rec);
                }
            }
            self.cursor.set(activity.len());
        }
        self.flush();
    }

    /// Make pending records durable. Records already in the ledger are replays (dropped);
    /// the same id with different content is reported and the first kept. A write that fails
    /// leaves the records pending for the next attempt and the ledger unchanged.
    fn flush(&self) {
        let pending = std::mem::take(&mut *self.pending.borrow_mut());
        if pending.is_empty() {
            return;
        }
        let mut candidates: Vec<EvidenceRecord> = Vec::new();
        for rec in pending {
            match self.ledger.borrow().check(&rec) {
                Inserted::New => candidates.push(rec),
                Inserted::Duplicate => {}
                Inserted::Conflict => persistence::diagnostic(
                    &self.state_dir,
                    &self.run_id,
                    "evidence-conflict",
                    &format!(
                        "{} was re-observed with different content; first kept",
                        rec.evidence_id
                    ),
                ),
            }
        }
        if candidates.is_empty() {
            return;
        }
        let refs: Vec<&EvidenceRecord> = candidates.iter().collect();
        match persistence::append(&self.state_dir, &self.run_id, &refs) {
            Ok(()) => {
                let mut ledger = self.ledger.borrow_mut();
                for rec in candidates {
                    ledger.insert(rec);
                }
            }
            Err(e) => {
                *self.pending.borrow_mut() = candidates;
                persistence::diagnostic(
                    &self.state_dir,
                    &self.run_id,
                    "evidence-persist-failed",
                    &e.to_string(),
                );
            }
        }
    }

    pub fn len(&self) -> usize {
        self.ledger.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.ledger.borrow().is_empty()
    }
}

/// Fold a durable record back into a tracker (restart / replay). Only applied mutations count.
fn replay(t: &mut SourceTracker, r: &EvidenceRecord) {
    if r.kind == ObservationKind::FileMutation && r.execution == ExecutionState::Executed {
        match &r.mutation {
            Some(m) if r.receipt.execution_id.is_some() => t.apply(m),
            _ => t.note_unknown("applied-mutation-without-receipt"),
        }
    }
    if r.kind == ObservationKind::FileMutation
        && matches!(
            r.execution,
            ExecutionState::Uncertain | ExecutionState::Unknown
        )
    {
        t.note_unknown("mutation-outcome-unknown");
    }
    if r.tool.starts_with("job_") {
        t.note_shared("background-job");
    }
}

fn build(
    run_id: &str,
    task_id: Option<String>,
    task_instance_id: Option<String>,
    act: &ToolActivity,
    facts: Option<&ReceiptFacts>,
    target: super::target::VerificationTargetV1,
) -> Option<EvidenceRecord> {
    let kind = kind_of(&act.tool)?;
    let execution = ExecutionState::from_status(&act.status, act.error_code.as_deref());
    // Receipt facts describe what the Kernel returned; they only count for a call the Kernel ran.
    let ran = matches!(
        execution,
        ExecutionState::Executed | ExecutionState::ToolFailed
    ) && act.execution_id.is_some();
    let facts = facts.filter(|_| ran);
    let process = facts.and_then(|f| f.process.clone());
    let check = if kind == ObservationKind::Command {
        assess(
            execution,
            facts.and_then(|f| f.recognition.clone()),
            process.as_ref(),
            facts.and_then(|f| f.scope.clone()),
            act.args_digest.as_deref(),
            facts.and_then(|f| f.invocation),
            facts.and_then(|f| f.check_digest.as_deref()),
        )
    } else {
        None
    };
    let shadow = facts.and_then(|f| f.legacy_is_check).map(|legacy| {
        let new = matches!(
            check.as_ref().map(|c| &c.recognition),
            Some(Recognition::Recognized { .. })
        );
        ShadowComparison {
            legacy_is_check: legacy,
            evidence_is_check: new,
            difference: match (legacy, new) {
                (true, false) => Some("legacy-broader".into()),
                (false, true) => Some("evidence-broader".into()),
                _ => None,
            },
        }
    });
    Some(EvidenceRecord {
        schema_version: SCHEMA_VERSION,
        evidence_id: evidence_id(run_id, act.index, act.execution_id.as_deref()),
        run_id: run_id.to_owned(),
        task_id,
        task_instance_id,
        call_index: act.index,
        turn: act.turn,
        tool: act.tool.clone(),
        kind,
        execution,
        provenance: Provenance {
            source: if act.execution_id.is_some() {
                "kernel-receipt"
            } else {
                "broker-outcome"
            }
            .into(),
            backend: facts.and_then(|f| f.backend.clone()),
            recorder: RECORDER_VERSION,
            observed_at_ms: now_ms(),
        },
        receipt: ReceiptRef {
            execution_id: act.execution_id.clone(),
            journal_seq: act.journal_seq,
            args_digest: act.args_digest.clone(),
            result_digest: act.result_digest.clone(),
        },
        process,
        check,
        mutation: facts.and_then(|f| f.mutation.clone()),
        shadow,
        target: Some(target),
        boundary: None,
    })
}
