//! State-aware verification feedback to the SAME model (Verification Engine, Phase 05).
//!
//! The Core reports evidence; the model decides. At the final-response boundary, after the
//! Engineering Mode has had its say, the Core may tell the active model that a recognized check
//! failed against the source it was run on. This module decides whether that is justified and
//! remembers, durably, that it was said. It never starts a model, runs a tool, scores progress or
//! decides what the model should do next.
//!
//! # Eligibility (every rule must hold)
//!
//! 1. the run can act: a coding run with its edit and command tools;
//! 2. it was not cancelled, and the user's own limits (turns, tool calls, result bytes, runtime)
//!    still leave room for one more turn, so feedback never turns a normal ending into a limit;
//! 3. the evidence ledger and the feedback journal are both readable (damage is never a license);
//! 4. some check's LATEST trusted result is a failure that is `Current`: not stale (the source
//!    changed since), not indeterminate (Direct Workspace, other writers, unattestable content);
//! 5. the receipted file contents were independently confirmed (read-only, receipted files only)
//!    at this very boundary: a mid-run `Current` rests on receipts alone and an outside writer
//!    could have invalidated it since. Not confirmed means not reported;
//! 6. the failure is classified (see [`FailureClass`]): a failure the shell reports as an
//!    invocation problem, or a check killed by a signal, is not reported as a source defect;
//! 7. the same relevant state has not been fed back before (see below).
//!
//! No acceptance contract exists, so there are no "required but missing" checks: missing
//! evidence never creates feedback by itself, and a model-chosen check is not an obligation.
//!
//! # Direct Workspace (not supported, on purpose)
//!
//! A failing check there is never `Current`, so nothing is fed back. The minimum a safe
//! implementation would need, none of which exists yet: (1) a content identity of the project
//! folder that the Core can obtain READ-ONLY without a Git index write (a pinned-descriptor walk of
//! the files the check can depend on, hashed before the command starts and again after it ends,
//! under the daemon's own lock so no Kernel write interleaves); (2) a way to tell a user's or a
//! background job's concurrent edit from the task's own, which today only the Kernel's receipts
//! distinguish; (3) a defined answer for files the project ignores. Receipt-only attestation, as
//! used for the isolated copy, is NOT enough there because the folder has other writers by design.
//!
//! # Identity and deduplication
//!
//! The key digests the task instance, and for every failing check its identity and the source
//! identity it failed on. It does not change with provider requests, time, reads, replays, log
//! text or a repeated final answer. A real change of the relevant state (an edit, then a rerun
//! that fails on the new source) is a different key and may be reported once more. A key that was
//! `admitted`, `incorporated` or left `outcome-uncertain` is never delivered again, even after the
//! failure was resolved and returned. `observed` and `prepared` do not count as delivered.
//!
//! # Journal
//!
//! `<state>/verification/<run>.feedback.jsonl`, append-only, checksummed, fsynced. A write that
//! fails means NO delivery: the decision fails closed to "let the run end". Delivery to the
//! provider is not exactly-once and is not claimed to be: `admitted` means the Core committed to
//! sending it, `incorporated` means a provider answer was received after it, and a run that ends
//! between them leaves `outcome-uncertain`. Nothing is ever re-sent to regenerate feedback.

use super::evidence::{Invocation, Recognition};
use super::freshness::{self, Freshness};
use super::persistence;
use super::target::SourceIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const JOURNAL_SUFFIX: &str = ".feedback.jsonl";

/// Broker-owned activation. Never reachable from the model, a tool argument or an Engineering Mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeedbackPolicy {
    /// Decide and record eligibility; change nothing the run does.
    #[default]
    Observe,
    /// Deliver an eligible, newly justified feedback to the same model at the final-response boundary.
    Active,
}

impl FeedbackPolicy {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "observe" => Some(Self::Observe),
            "active" => Some(Self::Active),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    /// Observe mode: this state was eligible; nothing was sent.
    Observed,
    /// Active mode: decided, not yet committed.
    Prepared,
    /// Committed durably BEFORE the message joined the conversation.
    Admitted,
    /// A provider answer was received after the message was sent.
    Incorporated,
    /// The run ended after admission without a provider answer: delivery is not known.
    OutcomeUncertain,
    /// The failure no longer stands as a current failure.
    Resolved,
}

impl Stage {
    fn delivered(self) -> bool {
        matches!(
            self,
            Self::Admitted | Self::Incorporated | Self::OutcomeUncertain
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub key: String,
    pub stage: Stage,
    /// The failing checks' identities (family + argument digest) the key covers.
    pub checks: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Journal {
    pub entries: Vec<JournalEntry>,
    pub unreadable: usize,
}

impl Journal {
    pub fn has_delivered(&self, key: &str) -> bool {
        self.entries
            .iter()
            .any(|e| e.key == key && e.stage.delivered())
    }
    pub fn has(&self, key: &str, stage: Stage) -> bool {
        self.entries
            .iter()
            .any(|e| e.key == key && e.stage == stage)
    }
    /// Keys admitted for delivery that never reached `incorporated`/`outcome-uncertain`.
    pub fn in_flight(&self) -> Vec<&JournalEntry> {
        self.entries
            .iter()
            .filter(|e| e.stage == Stage::Admitted)
            .filter(|e| {
                !self.entries.iter().any(|o| {
                    o.key == e.key
                        && matches!(o.stage, Stage::Incorporated | Stage::OutcomeUncertain)
                })
            })
            .collect()
    }
}

pub fn load_journal(state_dir: &Path, run_id: &str) -> Journal {
    let (bodies, unreadable) = persistence::read_bodies(state_dir, run_id, JOURNAL_SUFFIX);
    let entries = bodies
        .iter()
        .filter_map(|b| serde_json::from_str::<JournalEntry>(b).ok())
        .collect::<Vec<_>>();
    Journal {
        unreadable: unreadable + (bodies.len() - entries.len()),
        entries,
    }
}

/// Durably record one stage. An error means it was NOT recorded.
pub fn record(state_dir: &Path, run_id: &str, e: &JournalEntry) -> std::io::Result<()> {
    let body = serde_json::to_string(e).map_err(std::io::Error::other)?;
    persistence::append_bodies(state_dir, run_id, JOURNAL_SUFFIX, &[body])
}

/// What the execution evidence supports saying about a failed check. Decided from the process
/// status and how the Core started it; never from output text, never from anything the model wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    /// The process ended with a failing status the evidence does not tie to the environment.
    Observed,
    /// A shell ran the command and reported it could not find (127) or execute (126) it: the
    /// check never ran. Verified by the shell protocol, not guessed.
    InvocationFailure,
    /// The check was killed by a signal (timeout, resource kill): it produced no verdict.
    DidNotComplete,
    /// Exit status 126/127 from a directly started program: the program's own status, which test
    /// suites and environment problems both use. Reported, without saying which.
    Ambiguous,
}

/// `family` is the recognized check family. A package-manager script runner (`npm-*`, `pnpm-*`,
/// `yarn-*`) executes the project's script through `sh -c` and returns that shell's status, so its
/// 126 / 127 is the shell saying a command inside the script was not executable / not found: the
/// live campaign saw exactly this (`npm run build` -> `tsc: command not found`, exit 127) deliver
/// feedback about a missing tool as if it were a failed check.
pub fn classify_failure(
    exit: Option<i64>,
    signal: Option<&str>,
    invocation: Option<Invocation>,
    family: Option<&str>,
) -> FailureClass {
    if signal.is_some() {
        return FailureClass::DidNotComplete;
    }
    let script_runner = family
        .is_some_and(|f| f.starts_with("npm-") || f.starts_with("pnpm-") || f.starts_with("yarn-"));
    match (exit, invocation) {
        (Some(126 | 127), Some(Invocation::Direct)) if script_runner => {
            FailureClass::InvocationFailure
        }
        (Some(126 | 127), Some(Invocation::Shell | Invocation::ShellPipeline)) => {
            FailureClass::InvocationFailure
        }
        (Some(126 | 127), _) => FailureClass::Ambiguous,
        _ => FailureClass::Observed,
    }
}

/// What the caller knows about the run; none of it is model input.
pub struct Facts<'a> {
    pub task_instance: &'a str,
    /// A coding run that may edit and run commands.
    pub can_act: bool,
    pub cancelled: bool,
    /// The user's limits leave room for another turn.
    pub room_for_another_turn: bool,
    /// Receipted file contents were confirmed on disk just now (see `attest`).
    pub attested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eligible {
    pub key: String,
    pub checks: Vec<String>,
    /// The concise factual message for the model.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Eligible(Eligible),
    Ineligible(&'static str),
}

struct Failing {
    identity: String,
    family: String,
    call_index: u32,
    execution_id: Option<String>,
    exit_code: Option<i64>,
    source: String,
    class: FailureClass,
}

/// The decision, from the durable ledger and journal only.
pub fn decide(state_dir: &Path, run_id: &str, facts: &Facts<'_>) -> Decision {
    if !facts.can_act {
        return Decision::Ineligible("no-capability-to-act");
    }
    if facts.cancelled {
        return Decision::Ineligible("cancelled");
    }
    if !facts.room_for_another_turn {
        return Decision::Ineligible("user-limit-reached");
    }
    let loaded = persistence::load(state_dir, run_id);
    if !loaded.is_intact() || !persistence::exists(state_dir, run_id) {
        return Decision::Ineligible("evidence-unavailable");
    }
    let journal = load_journal(state_dir, run_id);
    if journal.unreadable > 0 {
        return Decision::Ineligible("feedback-journal-unreadable");
    }
    let report = freshness::report(&loaded.ledger);
    let recs = loaded.ledger.records();
    // newest trusted result per check identity
    let mut latest: Vec<&freshness::FreshnessEntry> = Vec::new();
    for e in &report {
        if let Some(i) = latest.iter().position(|o| o.identity == e.identity) {
            latest.remove(i);
        }
        latest.push(e);
    }
    let mut failing: Vec<Failing> = Vec::new();
    let mut environment_suspect = false;
    for e in latest {
        if e.original_result != "process-failed" || e.freshness != Freshness::Current {
            continue;
        }
        let Some(rec) = recs.iter().find(|r| r.evidence_id == e.evidence_id) else {
            continue;
        };
        let p = rec.process.as_ref();
        let (exit, signal) = (
            p.and_then(|p| p.exit_code),
            p.and_then(|p| p.signal.as_deref()),
        );
        let family_name = match rec.check.as_ref().map(|c| &c.recognition) {
            Some(Recognition::Recognized { family }) => Some(family.as_str()),
            _ => None,
        };
        let class = classify_failure(
            exit,
            signal,
            rec.check.as_ref().and_then(|c| c.invocation),
            family_name,
        );
        if matches!(
            class,
            FailureClass::InvocationFailure | FailureClass::DidNotComplete
        ) {
            environment_suspect = true;
            continue;
        }
        let source = match rec.target.as_ref().map(|t| &t.source) {
            Some(SourceIdentity::ReceiptDelta { digest, .. }) => digest.clone(),
            _ => continue,
        };
        failing.push(Failing {
            identity: e.identity.clone().unwrap_or_else(|| e.check.clone()),
            family: e.check.clone(),
            call_index: e.call_index,
            execution_id: e.execution_id.clone(),
            exit_code: exit,
            source,
            class,
        });
    }
    if failing.is_empty() {
        return Decision::Ineligible(if environment_suspect {
            "environment-or-verifier-failure"
        } else {
            "no-current-failing-check"
        });
    }
    if !facts.attested {
        return Decision::Ineligible("failing-check-content-not-attested");
    }
    failing.sort_by(|a, b| (&a.identity, &a.source).cmp(&(&b.identity, &b.source)));
    let mut h = Sha256::new();
    h.update(b"nexus.verification.feedback.v1\0");
    h.update(facts.task_instance.as_bytes());
    h.update([0]);
    for f in &failing {
        h.update(f.identity.as_bytes());
        h.update([0]);
        h.update(f.source.as_bytes());
        h.update([0]);
    }
    h.update(b"requirements:none");
    let key = format!("fbk_{}", hex::encode(h.finalize()));
    if journal.has_delivered(&key) {
        return Decision::Ineligible("already-delivered-for-equivalent-state");
    }
    Decision::Eligible(Eligible {
        message: message(&failing),
        checks: failing.iter().map(|f| f.identity.clone()).collect(),
        key,
    })
}

fn message(failing: &[Failing]) -> String {
    let mut m = String::from(
        "Nexus verification feedback\n\nA check executed against the current observable source state reported failure.\n",
    );
    for f in failing.iter().take(5) {
        m.push_str(&format!(
            "\nCheck: {}\nExecution: {} (tool call #{})\nResult: failed{}\nFreshness: current\n",
            f.family,
            f.execution_id.as_deref().unwrap_or("-"),
            f.call_index,
            f.exit_code
                .map(|c| format!(" (exit status {c})"))
                .unwrap_or_default(),
        ));
        if f.class == FailureClass::Ambiguous {
            m.push_str(
                "Cause: not established. This exit status is also used for environment problems; it may or may not reflect the source.\n",
            );
        }
    }
    if failing.len() > 5 {
        m.push_str(&format!(
            "\n(and {} more failing checks)\n",
            failing.len() - 5
        ));
    }
    m.push_str(
        "\nThe check failure remains unresolved. Its output is in that tool call's result earlier in this conversation.\n\nChoose the next engineering action. You may investigate, repair, rerun a relevant check, or explain a genuine blocker.\n\nDo not claim this check passed without new execution evidence.",
    );
    m
}

/// Close out the journal at the end of a run: anything admitted but never answered is
/// `outcome-uncertain`; any delivered key whose failure no longer stands is `resolved`.
/// Idempotent (a stage already recorded for a key is not recorded again).
pub fn settle(state_dir: &Path, run_id: &str) {
    let journal = load_journal(state_dir, run_id);
    if journal.unreadable > 0 || journal.entries.is_empty() {
        return;
    }
    let mut add: Vec<JournalEntry> = Vec::new();
    for e in journal.in_flight() {
        add.push(JournalEntry {
            stage: Stage::OutcomeUncertain,
            ..e.clone()
        });
    }
    let loaded = persistence::load(state_dir, run_id);
    if loaded.is_intact() {
        let standing: std::collections::BTreeSet<String> = freshness::report(&loaded.ledger)
            .into_iter()
            .filter(|e| e.original_result == "process-failed" && e.freshness == Freshness::Current)
            .filter_map(|e| e.identity)
            .collect();
        let mut seen: std::collections::BTreeSet<&str> = Default::default();
        for e in &journal.entries {
            if e.stage.delivered()
                && seen.insert(e.key.as_str())
                && !journal.has(&e.key, Stage::Resolved)
                && !e.checks.iter().any(|c| standing.contains(c))
            {
                add.push(JournalEntry {
                    stage: Stage::Resolved,
                    ..e.clone()
                });
            }
        }
    }
    for e in add {
        if let Err(err) = record(state_dir, run_id, &e) {
            persistence::diagnostic(
                state_dir,
                run_id,
                "feedback-journal-write-failed",
                &err.to_string(),
            );
            return;
        }
    }
}

/// Test-only deterministic crash points around feedback admission (feature `test-engines`; absent
/// from production builds). The environment variable is read by the broker PROCESS the test starts.
#[cfg(feature = "test-engines")]
pub fn crash_point(point: &str) {
    if std::env::var("NEXUS_TEST_FEEDBACK_CRASH_AT").as_deref() == Ok(point) {
        unsafe {
            libc::raise(libc::SIGKILL);
        }
    }
}
#[cfg(not(feature = "test-engines"))]
#[inline(always)]
pub fn crash_point(_point: &str) {}

/// Core-derived context for the compaction note: which failing checks the Core already reported
/// to the model and that they still stand. Built from the durable ledger and journal only, so it
/// cannot be replaced by anything the model wrote, and it is empty unless feedback was actually
/// delivered (Observe runs and runs without feedback are byte-for-byte unchanged).
pub fn compaction_note(state_dir: &Path, run_id: &str) -> Option<String> {
    let journal = load_journal(state_dir, run_id);
    if journal.unreadable > 0 || !journal.entries.iter().any(|e| e.stage.delivered()) {
        return None;
    }
    let loaded = persistence::load(state_dir, run_id);
    if !loaded.is_intact() {
        return None;
    }
    let mut latest: Vec<freshness::FreshnessEntry> = Vec::new();
    for e in freshness::report(&loaded.ledger) {
        latest.retain(|o| o.identity != e.identity);
        latest.push(e);
    }
    let standing: Vec<String> = latest
        .iter()
        .filter(|e| e.original_result == "process-failed" && e.freshness == Freshness::Current)
        .map(|e| format!("{} (tool call #{})", e.check, e.call_index))
        .collect();
    if standing.is_empty() {
        return Some(
            "verification feedback was given earlier in this run; no failing check stands on the current source."
                .into(),
        );
    }
    Some(format!(
        "verification feedback was given earlier in this run and these checks still fail on the current source: {}; it is not repeated, rerun a relevant check after changing the code.",
        standing.join(", ")
    ))
}
