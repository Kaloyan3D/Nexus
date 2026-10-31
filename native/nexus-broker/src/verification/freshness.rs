//! Evidence freshness (Verification Engine, Phase 03): does a recorded check result still
//! apply to the current observable state of the workspace?
//!
//! Freshness is separate from the result. A check that failed stays a recorded failure; it can
//! be `Current` (the failure still applies) or `Stale`. Nothing here deletes or rewrites a record,
//! reruns a check, or reaches the model: it is a pure function of the durable ledger.
//!
//! Rules, in order, for a trusted check result (a recognized check whose process ended with a
//! verdict, backed by a Kernel execution receipt):
//!
//! 1. no recorded target (version 1 record)                        -> Indeterminate
//! 2. check scope unknown (reaches outside the workspace)          -> Indeterminate
//! 3. recorded or latest source identity unknown                   -> Indeterminate
//! 4. the source digest differs from the latest one                -> Stale
//!    (a receipted content change happened after the check; this holds even when other writers
//!    exist, because a content change is a change)
//! 5. equal digests but a writer other than the Kernel's mediated tools was possible
//!    (Direct Workspace, in-place commands, background jobs, unknown mode)  -> Indeterminate
//! 6. equal digests but the run-end cross-check found changes no receipt explains -> Indeterminate
//! 7. equal digests but the run-end content attestation found a receipted file whose bytes differ
//!    from its receipt, or could not read them                     -> Indeterminate
//! 8. otherwise                                                    -> Current
//!
//! Rule 7 exists because rule 6 compares only PATHS: an outside write to a path the Kernel already
//! edited is invisible to it. Before the run ends there is no attestation yet; `Current` is then
//! receipt-consistent only (see `Basis`).
//!
//! `Current` therefore means: under `receipt-delta/v1` the workspace source the check ran
//! against is unchanged. It says nothing about ignored files, the toolchain, the environment
//! or the network, and nothing about whether the requirements are met.

use super::evidence::*;
use super::ledger::Ledger;
use super::target::SourceIdentity;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Freshness {
    Current,
    Stale {
        reason: String,
    },
    Indeterminate {
        reason: String,
    },
    /// The record is not a trusted check result (a mutation, a refused or cancelled call, an
    /// opaque command): freshness has no meaning for it.
    NotApplicable,
}

impl Freshness {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Stale { .. } => "stale",
            Self::Indeterminate { .. } => "indeterminate",
            Self::NotApplicable => "not-applicable",
        }
    }
}

fn indeterminate(r: impl Into<String>) -> Freshness {
    Freshness::Indeterminate { reason: r.into() }
}

/// The latest known state of the run: the target of the last tool record, and whether the
/// run-end cross-check found unexplained changes.
pub struct Latest<'a> {
    pub source: Option<&'a SourceIdentity>,
    pub unexplained_changes: bool,
    /// The run-end attestation of receipted file contents, once the run has ended.
    pub attestation: Option<&'a super::attest::Attestation>,
}

/// What a `Current` rests on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Basis {
    /// Receipts agree with each other; nothing independent has confirmed the file contents yet
    /// (the run is still going, or no attestation was recorded).
    ReceiptConsistent,
    /// The receipted files were hashed at run end and match their receipts.
    Attested,
}

pub fn latest(ledger: &Ledger) -> Latest<'_> {
    let recs = ledger.records();
    let source = recs
        .iter()
        .rev()
        .find(|r| r.kind != ObservationKind::RunBoundary && r.target.is_some())
        .and_then(|r| r.target.as_ref())
        .map(|t| &t.source);
    let unexplained_changes = recs.iter().any(|r| {
        r.boundary
            .as_ref()
            .is_some_and(|b| b.cross_check && b.unreceipted_paths > 0)
    });
    let attestation = recs
        .iter()
        .rev()
        .find_map(|r| r.boundary.as_ref())
        .map(|b| &b.attestation);
    Latest {
        source,
        unexplained_changes,
        attestation,
    }
}

pub fn basis(now: &Latest<'_>) -> Basis {
    match now.attestation {
        Some(super::attest::Attestation::Attested { .. }) => Basis::Attested,
        _ => Basis::ReceiptConsistent,
    }
}

pub fn evaluate(e: &EvidenceRecord, now: &Latest<'_>) -> Freshness {
    let Some(check) = &e.check else {
        return Freshness::NotApplicable;
    };
    let trusted_result = e.is_execution_evidence()
        && matches!(check.recognition, Recognition::Recognized { .. })
        && matches!(
            check.outcome,
            CheckOutcome::ProcessExitedZero | CheckOutcome::ProcessFailed
        );
    if !trusted_result {
        return Freshness::NotApplicable;
    }
    let Some(target) = &e.target else {
        return indeterminate("no-target-identity-recorded");
    };
    if let CheckScope::Unknown { reason } = &check.scope {
        return indeterminate(format!("check-scope-unknown: {reason}"));
    }
    let SourceIdentity::ReceiptDelta {
        digest: then,
        exclusive: then_exclusive,
        shared_reasons,
        ..
    } = &target.source
    else {
        let SourceIdentity::Unknown { reason } = &target.source else {
            unreachable!()
        };
        return indeterminate(format!("recorded-source-unknown: {reason}"));
    };
    let Some(now_src) = now.source else {
        return indeterminate("current-source-not-observed");
    };
    let SourceIdentity::ReceiptDelta {
        digest: current,
        exclusive: now_exclusive,
        shared_reasons: now_reasons,
        ..
    } = now_src
    else {
        let SourceIdentity::Unknown { reason } = now_src else {
            unreachable!()
        };
        return indeterminate(format!("current-source-unknown: {reason}"));
    };
    if then != current {
        return Freshness::Stale {
            reason: "source changed after the check".into(),
        };
    }
    if !then_exclusive || !now_exclusive {
        let mut why: Vec<&str> = shared_reasons
            .iter()
            .chain(now_reasons)
            .map(String::as_str)
            .collect();
        why.sort_unstable();
        why.dedup();
        return indeterminate(format!("other-writers-possible: {}", why.join(",")));
    }
    if now.unexplained_changes {
        return indeterminate("run-end-found-changes-no-receipt-explains");
    }
    match now.attestation {
        Some(super::attest::Attestation::Mismatch { .. }) => {
            return indeterminate("receipted-file-content-differs-from-its-receipt");
        }
        Some(super::attest::Attestation::Unavailable { reason }) => {
            return indeterminate(format!("receipted-file-content-not-attestable: {reason}"));
        }
        Some(super::attest::Attestation::Attested { .. }) | None => {}
    }
    Freshness::Current
}

/// One line of the shadow diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshnessEntry {
    pub evidence_id: String,
    pub call_index: u32,
    pub check: String,
    /// Check identity (family and exact-argument digest): the same command, rerun, has the same one.
    pub identity: Option<String>,
    pub execution_id: Option<String>,
    /// `process-exited-zero` | `process-failed`
    pub original_result: &'static str,
    pub recorded_target: String,
    pub current_target: String,
    pub freshness: Freshness,
    /// What a `Current` rests on (also reported for other states, as the evidence available).
    pub basis: Basis,
}

impl std::fmt::Display for FreshnessEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Check: {}\nExecution: {}\nOriginal result: {}\nRecorded target: {}\nCurrent target: {}\nFreshness: {}",
            self.check,
            self.execution_id.as_deref().unwrap_or("-"),
            self.original_result,
            self.recorded_target,
            self.current_target,
            self.freshness.label()
        )?;
        match &self.freshness {
            Freshness::Stale { reason } | Freshness::Indeterminate { reason } => {
                write!(f, " ({reason})")
            }
            _ => Ok(()),
        }
    }
}

fn short(s: Option<&SourceIdentity>) -> String {
    match s {
        Some(SourceIdentity::ReceiptDelta { digest, .. }) => {
            format!("source:{}", &digest[..12.min(digest.len())])
        }
        Some(SourceIdentity::Unknown { reason }) => format!("unknown({reason})"),
        None => "not-observed".into(),
    }
}

/// Freshness of every trusted check in the ledger, in call order. Deterministic: the same ledger
/// always gives the same report.
pub fn report(ledger: &Ledger) -> Vec<FreshnessEntry> {
    let now = latest(ledger);
    ledger
        .records()
        .into_iter()
        .filter_map(|e| {
            let f = evaluate(e, &now);
            if f == Freshness::NotApplicable {
                return None;
            }
            let check = e.check.as_ref()?;
            Some(FreshnessEntry {
                evidence_id: e.evidence_id.clone(),
                call_index: e.call_index,
                check: match &check.recognition {
                    Recognition::Recognized { family } => family.clone(),
                    _ => e.tool.clone(),
                },
                identity: check.identity.clone(),
                execution_id: e.receipt.execution_id.clone(),
                original_result: if check.outcome == CheckOutcome::ProcessExitedZero {
                    "process-exited-zero"
                } else {
                    "process-failed"
                },
                recorded_target: short(e.target.as_ref().map(|t| &t.source)),
                current_target: short(now.source),
                freshness: f,
                basis: basis(&now),
            })
        })
        .collect()
}
