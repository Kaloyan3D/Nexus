//! EM-04C2 S6: the adaptive half of the active `nexus-adaptive-v1` engine - the durable limiter state, the
//! durable evidence baseline, the audit record of every limiter decision, and the pure functions
//! that produce AND re-validate them.
//!
//! Authority map (nothing here widens it):
//! * the Governor (historical, unchanged, through the worker) says which effort it wants;
//! * the Registry-sealed binding says which levels exist (`snapshot.authorized_efforts`);
//! * [`evaluate_limiter`] (Policy V2, `effort_limiter.rs`) decides keep-or-change;
//! * the host re-derives the same decision from INDEPENDENT inputs (`check_adaptive`) before the
//!   state is committed, and `EngineHost::accept` still applies its own effort rules;
//! * the Registry issues and the Kernel seals every attempt, as for any engine.
//!
//! Trusted and claimed evidence stay apart: `trusted` counts Kernel-verified failed verifications
//! folded from `snapshot.activity` (Core receipts); `claims` is the growth of the Governor's
//! historical failure totals (model signals, validated by the Core). Nothing a model sends is ever
//! counted as trusted.

use super::effort_limiter::{
    is_escalation_entry, limit_v2, verify_transition_v2, EvidenceBaseline, Level, LimiterAction,
    LimiterInput, LimiterRule, LimiterStateV2, LIMITER_POLICY_VERSION_V2,
};
use super::{EngineSnapshot, ObservationKind, VerificationOutcome};
use serde_json::{json, Map, Value};

/// State schema of the active `nexus-adaptive-v1` payload (the shadow and signals engines stay at 1).
pub const ACTIVE_STATE_SCHEMA: u32 = 2;
/// F-3: the complete Governor trace is bounded, not truncated. The real Governor emits at most
/// five short entries; anything beyond these bounds is a malformed (or forged) answer and the whole
/// evaluation is rejected - never silently shortened.
pub const MAX_FULL_TRACE_ENTRIES: usize = 32;
pub const MAX_FULL_TRACE_ENTRY_BYTES: usize = 512;
/// Trusted failures carried between limiter evaluations (saturating).
pub const MAX_PENDING_TRUSTED: u32 = 1_000;

/// The adaptive part of the engine payload. Persisted and validated as ONE unit, in the same EM-03
/// state revision as everything else (there is no second store).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Adaptive {
    /// Policy V2 limiter state (five S5 fields plus `dropped_before`).
    pub limiter: LimiterStateV2,
    /// What the Governor's semantic block looked like at the last JUDGED evaluation.
    pub baseline: EvidenceBaseline,
    /// Kernel-verified failures folded since the last judged evaluation. They may be folded by the
    /// signal path (a trusted observation made before a signal is folded with it), so they cannot
    /// be recovered from the evaluation alone.
    pub pending_trusted: u32,
}

/// One limiter decision as recorded in the retained decision history (audit and re-validation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimiterRecord {
    pub policy: u32,
    /// The Governor's effort for the attempt ("" when it produced none).
    pub governor: String,
    /// `escalation:` entry in the COMPLETE trace (F-3).
    pub strong: bool,
    pub claims: u32,
    pub trusted: u32,
    pub edge: bool,
    /// A [`LimiterRule`] name, or `error:<code>` when the limiter refused its inputs/state.
    pub rule: String,
    /// `keep` | `change:<level>`.
    pub action: String,
    /// Entries in the complete trace (the audit trace keeps only the first eight).
    pub trace_len: u32,
}

impl LimiterRecord {
    pub fn to_value(&self) -> Value {
        json!({
            "policy": self.policy, "governor": self.governor, "strong": self.strong,
            "claims": self.claims, "trusted": self.trusted, "edge": self.edge,
            "rule": self.rule, "action": self.action, "traceLen": self.trace_len,
        })
    }

    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let keys = [
            "policy", "governor", "strong", "claims", "trusted", "edge", "rule", "action",
            "traceLen",
        ];
        if o.len() != keys.len() || !keys.iter().all(|k| o.contains_key(*k)) {
            return None;
        }
        let u = |k: &str| o[k].as_u64().and_then(|n| u32::try_from(n).ok());
        let s = |k: &str, max: usize| {
            o[k].as_str()
                .filter(|x| x.len() <= max && x.bytes().all(|b| b.is_ascii_graphic()))
                .map(str::to_owned)
        };
        let governor = o["governor"].as_str().filter(|x| x.len() <= 16)?.to_owned();
        let action = s("action", 24)?;
        if action != "keep"
            && !action
                .strip_prefix("change:")
                .is_some_and(|l| Level::parse(l).is_some_and(|l| l != Level::Max))
        {
            return None;
        }
        let rule = s("rule", 48)?;
        if !is_known_rule(&rule) {
            return None;
        }
        Some(LimiterRecord {
            policy: u("policy").filter(|p| *p == LIMITER_POLICY_VERSION_V2)?,
            governor,
            strong: o["strong"].as_bool()?,
            claims: u("claims")?,
            trusted: u("trusted")?,
            edge: o["edge"].as_bool()?,
            rule,
            action,
            trace_len: u("traceLen").filter(|n| *n as usize <= MAX_FULL_TRACE_ENTRIES)?,
        })
    }
}

fn is_known_rule(r: &str) -> bool {
    [
        "up",
        "down-progress",
        "down-confirmed",
        "down-pending",
        "hold-rearm",
        "reset-evidence",
        "noop",
        "replay-guard",
    ]
    .contains(&r)
        || r.strip_prefix("error:").is_some_and(|c| {
            [
                "limiter-input-invalid",
                "limiter-state-invalid",
                "limiter-invariant",
            ]
            .contains(&c)
        })
}

impl Adaptive {
    pub fn to_value(&self) -> Value {
        json!({
            "policyVersion": LIMITER_POLICY_VERSION_V2,
            "limiter": self.limiter.to_value(),
            "baseline": {
                "totalFailures": self.baseline.total_failures,
                "conflictingEvidence": self.baseline.conflicting_evidence,
                "rootCauseEstablished": self.baseline.root_cause_established,
                "solutionEstablished": self.baseline.solution_established,
            },
            "pendingTrusted": self.pending_trusted,
        })
    }

    /// Strict decoder: unknown policy versions, missing/extra keys, wrong types and out-of-range
    /// values are refused (there is no migration; an unversioned payload is not accepted).
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let keys = ["policyVersion", "limiter", "baseline", "pendingTrusted"];
        if o.len() != keys.len() || !keys.iter().all(|k| o.contains_key(*k)) {
            return None;
        }
        if o["policyVersion"].as_u64() != Some(u64::from(LIMITER_POLICY_VERSION_V2)) {
            return None;
        }
        let limiter = LimiterStateV2::from_value(&o["limiter"]).ok()?;
        let b: &Map<String, Value> = o["baseline"].as_object()?;
        let bk = [
            "totalFailures",
            "conflictingEvidence",
            "rootCauseEstablished",
            "solutionEstablished",
        ];
        if b.len() != bk.len() || !bk.iter().all(|k| b.contains_key(*k)) {
            return None;
        }
        let baseline = EvidenceBaseline {
            total_failures: b["totalFailures"].as_u64().filter(|n| *n < 2_000_000)?,
            conflicting_evidence: b["conflictingEvidence"].as_bool()?,
            root_cause_established: b["rootCauseEstablished"].as_bool()?,
            solution_established: b["solutionEstablished"].as_bool()?,
        };
        let pending_trusted = u32::try_from(o["pendingTrusted"].as_u64()?)
            .ok()
            .filter(|n| *n <= MAX_PENDING_TRUSTED)?;
        Some(Adaptive {
            limiter,
            baseline,
            pending_trusted,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// F-3: the strong-escalation flag
// ---------------------------------------------------------------------------------------------

/// `strong_escalation` from the COMPLETE, validated Governor decision: every trace entry is
/// examined (never the eight-entry audit copy). A malformed trace (not an array of strings, more
/// than [`MAX_FULL_TRACE_ENTRIES`] entries, an entry beyond [`MAX_FULL_TRACE_ENTRY_BYTES`]) is an
/// error: the caller rejects the whole evaluation instead of dropping evidence. Returns
/// `(strong, trace_len)`.
pub fn strong_escalation_of_decision(decision: &Value) -> Result<(bool, u32), &'static str> {
    let trace = decision["trace"]
        .as_array()
        .ok_or("the Governor trace is not an array")?;
    if trace.len() > MAX_FULL_TRACE_ENTRIES {
        return Err("the Governor trace is longer than its bound");
    }
    let mut strong = false;
    for t in trace {
        let t = t.as_str().ok_or("a Governor trace entry is not a string")?;
        if t.len() > MAX_FULL_TRACE_ENTRY_BYTES {
            return Err("a Governor trace entry is longer than its bound");
        }
        strong |= is_escalation_entry(t);
    }
    Ok((strong, trace.len() as u32))
}

/// The historical Governor's strong-escalation condition, restated over a `museReasoning` block
/// (`hasStrongEscalation`: ACTIVE-window counters or open conflicting evidence; the historical
/// totals never count). Used by the host as the independent expectation of the flag; a
/// differential test pins it to the real Governor.
pub fn strong_escalation_of_block(block: Option<&Value>) -> bool {
    let Some(b) = block.filter(|b| !b.is_null()) else {
        return false;
    };
    let n = |k: &str| b[k].as_u64().unwrap_or(0);
    n("failedHypotheses") >= 2
        || n("failedImplementationAttempts") >= 2
        || b["conflictingEvidence"] == Value::Bool(true)
}

// ---------------------------------------------------------------------------------------------
// the pure judgement
// ---------------------------------------------------------------------------------------------

fn action_text(a: LimiterAction) -> String {
    match a {
        LimiterAction::KeepPinned => "keep".into(),
        LimiterAction::Change(l) => format!("change:{}", l.as_str()),
    }
}

/// Judge one resolved Governor evaluation. Pure; used by the engine to PRODUCE its decision and by
/// the host to RE-DERIVE it from independently obtained inputs.
///
/// * `reasoning_after`: the Governor's semantic block after this evaluation (the baseline target);
/// * `fresh_failed`: Kernel-verified failures folded by THIS evaluation;
/// * the persisted `pending_trusted` (folded earlier, by the signal path) is added here.
///
/// Evidence is CONSUMED (baseline advanced, pending reset) only by a judged evaluation: a limiter
/// error or a replayed attempt leaves the baseline where it was, so the evidence is judged by the
/// next attempt instead of being lost.
pub fn evaluate_limiter(
    a: &Adaptive,
    snap: &EngineSnapshot,
    governor: Option<&str>,
    strong: bool,
    reasoning_after: Option<&Value>,
    fresh_failed: u32,
    trace_len: u32,
) -> (Adaptive, LimiterRecord) {
    let trusted = a
        .pending_trusted
        .saturating_add(fresh_failed)
        .min(MAX_PENDING_TRUSTED);
    let mut rec = LimiterRecord {
        policy: LIMITER_POLICY_VERSION_V2,
        governor: governor.unwrap_or("").to_owned(),
        strong,
        claims: 0,
        trusted,
        edge: false,
        rule: String::new(),
        action: "keep".into(),
        trace_len,
    };
    // evidence not (yet) judged stays pending
    let carry = Adaptive {
        pending_trusted: trusted,
        ..*a
    };
    let fail = |mut rec: LimiterRecord, code: &str| {
        rec.rule = format!("error:{code}");
        rec
    };
    let block = reasoning_after.filter(|b| !b.is_null());
    let after = match EvidenceBaseline::from_reasoning(block) {
        Ok(b) => b,
        Err(e) => return (carry, fail(rec, e.code())),
    };
    let (claims, edge) = a.baseline.delta_to(&after);
    rec.claims = claims;
    rec.edge = edge;
    let authorized: Vec<Level> = snap
        .authorized_efforts
        .iter()
        .filter_map(|l| Level::parse(l))
        .collect();
    let (Some(gov), Some(cur)) = (
        governor.and_then(Level::parse),
        Level::parse(&snap.current_effort),
    ) else {
        return (carry, fail(rec, "limiter-input-invalid"));
    };
    let input = LimiterInput {
        attempt: snap.attempts_dispatched + 1,
        governor: gov,
        current: cur,
        authorized: &authorized,
        strong_escalation: strong,
        new_claim_units: claims,
        new_trusted_failures: trusted,
        progress_edge: edge,
    };
    match limit_v2(&a.limiter, &input) {
        Err(e) => (carry, fail(rec, e.code())),
        Ok(d) => {
            rec.rule = d.rule.as_str().to_owned();
            rec.action = action_text(d.action);
            if d.rule == LimiterRule::ReplayGuard {
                // the attempt was already judged: nothing is consumed
                (
                    Adaptive {
                        limiter: d.state,
                        ..carry
                    },
                    rec,
                )
            } else {
                (
                    Adaptive {
                        limiter: d.state,
                        baseline: after,
                        pending_trusted: 0,
                    },
                    rec,
                )
            }
        }
    }
}

/// The effort proposal a limiter record stands for.
pub fn record_effort(rec: &LimiterRecord) -> Option<String> {
    rec.action.strip_prefix("change:").map(str::to_owned)
}

/// Kernel-verified FAILED verifications among observations (trusted evidence only).
pub fn failed_verifications<'a>(obs: impl Iterator<Item = &'a super::ActivityObservation>) -> u32 {
    obs.filter(|o| {
        matches!(
            o.kind,
            ObservationKind::Verification {
                outcome: VerificationOutcome::Failed,
                ..
            }
        )
    })
    .count()
    .min(u32::MAX as usize) as u32
}

/// The host's independent re-validation of the adaptive part of a transition `a -> b`.
///
/// * `folded`: the observations that THIS transition folded, derived by the caller from the Core's
///   own feed (`snapshot.activity`) and the two states' frontiers - not from anything the engine
///   claims;
/// * `evaluated`: the transition recorded exactly one evaluation (the last history entry).
#[allow(clippy::too_many_arguments)]
pub fn check_adaptive(
    a: &Adaptive,
    b: &Adaptive,
    snap: &EngineSnapshot,
    reasoning_after: Option<&Value>,
    last_decision: Option<&super::muse_v1::ShadowDecision>,
    evaluated: bool,
    folded_failed: u32,
) -> Result<(), String> {
    let carried = a
        .pending_trusted
        .saturating_add(folded_failed)
        .min(MAX_PENDING_TRUSTED);
    if !evaluated {
        // the signal path may fold trusted observations; nothing else may move
        let want = Adaptive {
            pending_trusted: carried,
            ..*a
        };
        return if *b == want {
            Ok(())
        } else {
            Err(
                "the limiter state, baseline or pending evidence changed without an evaluation"
                    .into(),
            )
        };
    }
    let d = last_decision.ok_or("an evaluation must be recorded")?;
    let Some(rec) = &d.limiter else {
        // the Governor did not resolve an effort (capability refusal, bridge error, invalid
        // answer): the limiter did not run, so only carried evidence may differ
        if d.outcome == "resolved" {
            return Err("a resolved evaluation must carry its limiter record".into());
        }
        let want = Adaptive {
            pending_trusted: carried,
            ..*a
        };
        return if *b == want {
            Ok(())
        } else {
            Err("the limiter moved without a limiter record".into())
        };
    };
    if d.outcome != "resolved" {
        return Err("a limiter record needs a resolved Governor decision".into());
    }
    // every input re-derived: the flag from the validated semantic block, the failures from the
    // Core's receipts, the claims from the durable baseline and the block
    let strong = strong_escalation_of_block(reasoning_after);
    if rec.strong != strong {
        return Err(
            "the recorded strong-escalation flag does not match the Governor's own condition"
                .into(),
        );
    }
    let (want, want_rec) = evaluate_limiter(
        a,
        snap,
        d.governor_effort.as_deref(),
        strong,
        reasoning_after,
        folded_failed,
        rec.trace_len,
    );
    if want_rec != *rec {
        return Err(format!(
            "the recorded limiter decision is not the policy's result (expected rule {})",
            want_rec.rule
        ));
    }
    if want != *b {
        return Err("the limiter state or evidence baseline is not the policy's result".into());
    }
    if d.would != rec.action {
        return Err("the recorded proposal does not match the limiter decision".into());
    }
    // a second, independent run of the V2 transition check for judged decisions
    if !rec.rule.starts_with("error:") && rec.rule != "replay-guard" {
        let authorized: Vec<Level> = snap
            .authorized_efforts
            .iter()
            .filter_map(|l| Level::parse(l))
            .collect();
        let (Some(gov), Some(cur)) = (
            d.governor_effort.as_deref().and_then(Level::parse),
            Level::parse(&snap.current_effort),
        ) else {
            return Err("the limiter inputs are not levels".into());
        };
        let (claims, edge) = a.baseline.delta_to(&b.baseline);
        let input = LimiterInput {
            attempt: snap.attempts_dispatched + 1,
            governor: gov,
            current: cur,
            authorized: &authorized,
            strong_escalation: strong,
            new_claim_units: claims,
            new_trusted_failures: carried,
            progress_edge: edge,
        };
        let action = match record_effort(rec).and_then(|l| Level::parse(&l)) {
            Some(l) => LimiterAction::Change(l),
            None => LimiterAction::KeepPinned,
        };
        let rule = verify_transition_v2(
            &a.limiter,
            &input,
            action,
            &b.limiter,
            snap.attempts_dispatched + 1,
        )
        .map_err(|e| e.to_string())?;
        if rule.as_str() != rec.rule {
            return Err("the recorded rule is not the one the policy applied".into());
        }
    }
    Ok(())
}
