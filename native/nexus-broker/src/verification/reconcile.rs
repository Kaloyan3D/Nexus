//! Completion reconciliation (Verification Engine, Phase 04), reporting only.
//!
//! A deterministic reading of a run's persisted evidence into a [`VerificationSummary`]. It is a
//! pure function of the ledger on disk: no model, no tool, no scheduling, no clock, and nothing
//! from the running recorder's memory. The same ledger always yields the same summary and digest.
//!
//! Four things are kept apart and never merged: the factual result of each check, whether it still
//! applies (freshness), what the evidence does not cover (limitations), and the task-level verdict.
//! The execution lifecycle and the legacy `completion` classification are not inputs.
//!
//! # Verdict rules
//!
//! Per check identity (family + exact arguments) only the LATEST trusted result counts: a rerun
//! supersedes an older result of the same check, failing or passing, and the older one stays in
//! the ledger. Results are then sorted by freshness:
//!
//! 1. not a code run                                              -> `not-applicable`
//! 2. the ledger has unreadable lines                             -> `inconclusive`
//! 3. the ledger is missing although the run made tool calls      -> `inconclusive`
//! 4. no trusted check result at all (including only opaque,
//!    interrupted or refused commands)                            -> `unverified`
//! 5. some latest result is a CURRENT failure                     -> `failed-verification`
//! 6. some CURRENT pass, nothing stale or indeterminate           -> `verified-within-scope`
//! 7. some CURRENT pass, plus stale or indeterminate results      -> `partially-verified`
//! 8. no current result, some indeterminate                       -> `inconclusive`
//! 9. no current result, only stale                               -> `unverified`
//!
//! `verified-within-scope` means: the listed checks passed against the current source under the
//! identity model. `acceptance` is always `not-assessed` here: no acceptance contract exists, so
//! nothing in this module can say the task was done.

use super::evidence::*;
use super::freshness::{self, Basis, Freshness, FreshnessEntry};
use super::persistence;
use nexus_client::intent_client::{CheckSummary, VerificationSummary};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const SUMMARY_VERSION: u32 = 1;
/// How many checks one summary lists (presentation window of the run record; counts cover all).
pub const LISTED_CHECKS: usize = 16;

/// What the reconciliation needs to know about the run, and nothing about its outcome.
pub struct RunFacts {
    /// A coding run (the only kind with a workspace to verify).
    pub code_run: bool,
    /// Tool calls the run made (evidence cannot be missing for a run that made none).
    pub tool_calls: u32,
}

pub fn evaluate(state_dir: &Path, run_id: &str, facts: &RunFacts) -> VerificationSummary {
    let mut s = VerificationSummary {
        schema_version: SUMMARY_VERSION,
        acceptance: "not-assessed".into(),
        ..Default::default()
    };
    if !facts.code_run {
        s.verdict = "not-applicable".into();
        s.ledger = "absent".into();
        return s;
    }
    let loaded = persistence::load(state_dir, run_id);
    let present = persistence::exists(state_dir, run_id);
    s.ledger = if !loaded.is_intact() {
        "damaged"
    } else if present {
        "intact"
    } else {
        "absent"
    }
    .into();
    let recs = loaded.ledger.records();

    // newest result per check identity
    let report = freshness::report(&loaded.ledger);
    let mut latest: Vec<&FreshnessEntry> = Vec::new();
    let mut superseded_failures = 0u32;
    for e in &report {
        if let Some(i) = latest.iter().position(|o| o.identity == e.identity) {
            if latest[i].original_result == "process-failed" {
                superseded_failures += 1;
            }
            latest.remove(i);
        }
        latest.push(e);
    }
    for e in &latest {
        match (&e.freshness, e.original_result) {
            (Freshness::Current, "process-exited-zero") => s.current_passing += 1,
            (Freshness::Current, _) => s.current_failing += 1,
            (Freshness::Stale { .. }, _) => s.stale += 1,
            _ => s.indeterminate += 1,
        }
    }
    s.verdict = verdict(&s, !latest.is_empty(), &s.ledger.clone(), facts.tool_calls).into();

    // limitations: what the evidence does not cover
    let mut lim: Vec<String> = vec!["no-acceptance-contract".into()];
    if !latest.is_empty() {
        lim.push("environment-and-toolchain-unobserved".into());
    }
    if latest
        .iter()
        .any(|e| e.freshness == Freshness::Current && e.basis == Basis::ReceiptConsistent)
    {
        lim.push("file-contents-not-independently-attested".into());
    }
    let n = |f: &dyn Fn(&EvidenceRecord) -> bool| recs.iter().filter(|r| f(r)).count();
    let interrupted = n(&|r| {
        r.kind == ObservationKind::Command
            && matches!(
                r.execution,
                ExecutionState::Cancelled | ExecutionState::Uncertain
            )
    });
    if interrupted > 0 {
        lim.push(format!("interrupted-commands:{interrupted}"));
    }
    let opaque = n(&|r| {
        r.check
            .as_ref()
            .is_some_and(|c| matches!(c.outcome, CheckOutcome::Inconclusive { .. }))
    });
    if opaque > 0 {
        lim.push(format!("opaque-check-commands-not-trusted:{opaque}"));
    }
    if superseded_failures > 0 {
        lim.push(format!(
            "earlier-failures-superseded-by-rerun:{superseded_failures}"
        ));
    }
    match s.ledger.as_str() {
        "damaged" => lim.push(format!(
            "ledger-damaged:{}-unreadable-lines",
            loaded.unreadable.len()
        )),
        "absent" if facts.tool_calls > 0 => lim.push("ledger-absent".into()),
        _ => {}
    }
    s.limitations = lim;

    // listed checks (windowed); counts above cover all of them
    let skip = latest.len().saturating_sub(LISTED_CHECKS);
    s.checks_omitted = skip as u32;
    s.checks = latest[skip..]
        .iter()
        .map(|e| CheckSummary {
            check: e.check.clone(),
            call_index: e.call_index,
            execution_id: e.execution_id.clone(),
            result: e.original_result.into(),
            freshness: e.freshness.label().into(),
            basis: match e.basis {
                Basis::Attested => "attested",
                Basis::ReceiptConsistent => "receipt-consistent",
            }
            .into(),
            reason: match &e.freshness {
                Freshness::Stale { reason } | Freshness::Indeterminate { reason } => {
                    Some(reason.clone())
                }
                _ => None,
            },
        })
        .collect();

    // digest of the evidence this reading rests on: record identities in order + their freshness
    if !recs.is_empty() {
        let mut h = Sha256::new();
        h.update(b"nexus.verification.summary.v1\0");
        for r in &recs {
            h.update(r.evidence_id.as_bytes());
            h.update([0]);
        }
        for e in &report {
            h.update(e.evidence_id.as_bytes());
            h.update(e.freshness.label().as_bytes());
            h.update([0]);
        }
        s.evidence_digest = Some(hex::encode(h.finalize()));
    }
    s
}

fn verdict(
    s: &VerificationSummary,
    any_check: bool,
    ledger: &str,
    tool_calls: u32,
) -> &'static str {
    if ledger == "damaged" {
        return "inconclusive";
    }
    if ledger == "absent" && tool_calls > 0 {
        return "inconclusive";
    }
    if !any_check {
        return "unverified";
    }
    if s.current_failing > 0 {
        return "failed-verification";
    }
    let others = s.stale + s.indeterminate;
    match (s.current_passing > 0, others > 0) {
        (true, false) => "verified-within-scope",
        (true, true) => "partially-verified",
        (false, _) if s.indeterminate > 0 => "inconclusive",
        _ => "unverified",
    }
}
