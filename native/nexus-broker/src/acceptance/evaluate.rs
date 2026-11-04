//! Deterministic acceptance evaluation: contract journals + the run's evidence ledger -> an
//! [`AcceptanceSummary`]. No model, no tool, no clock.
//!
//! Rules (all must hold for `verified-within-scope`):
//!
//! 1. the requirement is ACTIVE (a superseded one is history, not an obligation);
//! 2. it has at least one TRUSTED binding (a party with authority said which check covers it);
//! 3. EVERY bound check has a trusted result in this run that is a clean exit AND is `Current`
//!    under the Phase 03/04 freshness rules (stale, indeterminate or never-run is not enough).
//!
//! A bound check that failed currently makes the requirement `failed`. Anything the model asserted
//! (a proposed requirement, an evidence claim) is shown and never counted. The overall status is
//! decided by AUTHORITATIVE requirements only; with none it is `not-assessed`. A contract journal
//! that is damaged, or an unreadable ledger, never yields a verified status.

use super::contract::*;
use super::store::{self, Anchor};
use crate::verification::{freshness, persistence};
use nexus_client::intent_client::{AcceptanceSummary, EvidenceView, RequirementView};
use std::path::Path;

pub const SUMMARY_VERSION: u32 = 1;
/// Requirements listed in one summary (a presentation window; the counts cover all).
pub const LISTED: usize = 40;
const SCOPE_NOTE: &str = "Evidence considered: this run's ledger only. A passing check shows that command exited cleanly, not that a feature works: a requirement is verified only through a check a trusted party bound to it. Model proposals and model coverage claims are advisory.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Bound {
    Verified,
    Failed,
    Stale,
    Indeterminate,
    NeverRan,
}

fn entry_state(e: &freshness::FreshnessEntry) -> Bound {
    use freshness::Freshness as F;
    match (&e.freshness, e.original_result) {
        (F::Current, "process-exited-zero") => Bound::Verified,
        (F::Current, _) => Bound::Failed,
        (F::Stale { .. }, _) => Bound::Stale,
        _ => Bound::Indeterminate,
    }
}

fn digest_of_identity(identity: &str) -> &str {
    identity.split_once(':').map(|x| x.1).unwrap_or(identity)
}

fn view_of(
    c: &Contract,
    r: &Requirement,
    latest: &[freshness::FreshnessEntry],
    run_id: &str,
    all_intact: bool,
) -> RequirementView {
    let mut v = RequirementView {
        id: r.id.clone(),
        description: r.description.chars().take(200).collect(),
        origin: r.provenance.label().into(),
        authoritative: r.provenance.authoritative(),
        revision: r.revision,
        ..Default::default()
    };
    if let State::Superseded { by } = &r.state {
        v.status = "superseded".into();
        v.superseded_by = by.clone();
        return v;
    }
    let mut states: Vec<Bound> = Vec::new();
    let mut advisory = 0usize;
    for l in c.links.iter().filter(|l| l.requirement_id == r.id) {
        match (&l.origin, &l.target) {
            (LinkOrigin::TrustedBinding { .. }, LinkTarget::Check { digest, label }) => {
                let hit = latest.iter().rev().find(|e| {
                    e.identity.as_deref().map(digest_of_identity) == Some(digest.as_str())
                });
                let st = hit.map(entry_state).unwrap_or(Bound::NeverRan);
                states.push(st);
                v.evidence.push(EvidenceView {
                    origin: "trusted-binding".into(),
                    check: Some(label.clone()),
                    evidence_id: hit.map(|e| e.evidence_id.clone()),
                    result: hit.map(|e| e.original_result.to_owned()),
                    freshness: hit.map(|e| e.freshness.label().to_owned()),
                    counted: true,
                });
            }
            (
                LinkOrigin::ModelAsserted { .. },
                LinkTarget::Evidence {
                    run_id: rid,
                    evidence_id,
                },
            ) => {
                advisory += 1;
                let hit = (rid == run_id)
                    .then(|| latest.iter().find(|e| &e.evidence_id == evidence_id))
                    .flatten();
                v.evidence.push(EvidenceView {
                    origin: "model-asserted".into(),
                    check: hit.map(|e| e.check.clone()),
                    evidence_id: Some(evidence_id.clone()),
                    result: hit.map(|e| e.original_result.to_owned()),
                    freshness: hit.map(|e| e.freshness.label().to_owned()),
                    counted: false,
                });
            }
            _ => {}
        }
    }
    if !all_intact {
        v.status = "inconclusive".into();
        v.missing = Some(
            "the contract journal or the evidence ledger is damaged; nothing can be verified"
                .into(),
        );
        return v;
    }
    let (status, missing) = if states.is_empty() {
        (
            "unverified",
            Some(if advisory > 0 {
                "no trusted party has said which check covers this; the model's coverage claim is advisory".to_owned()
            } else {
                "no trusted party has said which check covers this requirement".to_owned()
            }),
        )
    } else if states.contains(&Bound::Failed) {
        ("failed", None)
    } else if states.iter().all(|s| *s == Bound::Verified) {
        ("verified-within-scope", None)
    } else if states
        .iter()
        .any(|s| matches!(s, Bound::Stale | Bound::Indeterminate))
    {
        (
            "inconclusive",
            Some("a bound check has a result that no longer applies to the current source, or cannot be attributed".to_owned()),
        )
    } else {
        (
            "unverified",
            Some("a bound check has not run in this run".to_owned()),
        )
    };
    v.status = status.into();
    v.missing = missing;
    v
}

/// The reading for `run_id`, or `None` when the task has no contract at all.
pub fn evaluate(
    state_dir: &Path,
    project_id: &str,
    anchor: Option<&Anchor>,
    run_id: &str,
) -> Option<AcceptanceSummary> {
    let proj = store::load(state_dir, &store::project_key(project_id));
    let task = anchor.and_then(|a| store::load(state_dir, &store::task_key(a)));
    if proj.is_none() && task.is_none() {
        return None;
    }
    let loaded = persistence::load(state_dir, run_id);
    let ledger_ok = loaded.is_intact();
    let mut latest: Vec<freshness::FreshnessEntry> = Vec::new();
    for e in freshness::report(&loaded.ledger) {
        latest.retain(|o| o.identity != e.identity);
        latest.push(e);
    }
    let contracts: Vec<&Contract> = proj.iter().chain(task.iter()).collect();
    let all_intact = ledger_ok && contracts.iter().all(|c| c.intact());
    let mut views: Vec<RequirementView> = Vec::new();
    for c in &contracts {
        for r in &c.requirements {
            views.push(view_of(c, r, &latest, run_id, all_intact));
        }
    }
    let mut s = AcceptanceSummary {
        schema_version: SUMMARY_VERSION,
        contract_id: task
            .as_ref()
            .or(proj.as_ref())
            .map(|c| c.contract_id.clone())
            .unwrap_or_default(),
        revision: contracts.iter().map(|c| c.revision).sum(),
        source_request_digest: task
            .as_ref()
            .and_then(|c| c.source_request_digest.clone())
            .unwrap_or_default(),
        scope_note: SCOPE_NOTE.into(),
        contract_intact: all_intact,
        ..Default::default()
    };
    let (mut auth_active, mut verified, mut failed, mut inconclusive, mut unverified) =
        (0u32, 0u32, 0u32, 0u32, 0u32);
    for v in &views {
        match (v.status.as_str(), v.authoritative) {
            ("superseded", _) => s.superseded += 1,
            (_, false) => s.candidates += 1,
            (st, true) => {
                auth_active += 1;
                match st {
                    "verified-within-scope" => verified += 1,
                    "failed" => failed += 1,
                    "inconclusive" => inconclusive += 1,
                    _ => unverified += 1,
                }
            }
        }
    }
    s.authoritative = auth_active;
    (s.verified, s.failed, s.inconclusive, s.unverified) =
        (verified, failed, inconclusive, unverified);
    s.overall = if !all_intact {
        "inconclusive"
    } else if auth_active == 0 {
        "not-assessed"
    } else if failed > 0 {
        "failed"
    } else if verified == auth_active {
        "verified-within-scope"
    } else if verified > 0 {
        "partially-verified"
    } else if inconclusive > 0 {
        "inconclusive"
    } else {
        "unverified"
    }
    .into();
    // active first, then history, in id order within each
    views.sort_by_key(|v| (v.status == "superseded", v.id.clone()));
    s.requirements_omitted = views.len().saturating_sub(LISTED) as u32;
    views.truncate(LISTED);
    s.requirements = views;
    Some(s)
}
