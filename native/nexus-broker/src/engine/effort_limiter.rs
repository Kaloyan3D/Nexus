//! EM-04C2 S5: the Effort Transition Limiter (policy L3, `EM-04C2-ANTI-THRASH-POLICY.md` §3).
//!
//! A small, PURE and deterministic decision function. Given the effort the (unchanged, historical)
//! Governor wants for the next attempt, the effort in force, the authorized levels and a handful of
//! evidence counters, it answers one question: change now, or keep the effort pinned?
//!
//! What it is NOT:
//! * It never chooses a level. A `Change(e)` is always the Governor's own proposal for this attempt
//!   (up moves), or the higher of two Governor proposals for consecutive attempts (confirmed
//!   moves down). It cannot output `max`, an unauthorized level or the level already in force.
//! * It performs no I/O, reads no clock and owns no storage. Its state is a tiny value
//!   ([`LimiterState`]) that the future `muse-v1` engine will carry inside the EM-03 engine state
//!   payload; this module adds no persistence of its own.
//! * It is not an authority. Every `Change` still has to pass `EngineHost::accept`, the durable
//!   selection, the Registry's `issue-attempt` under the sealed binding, the Kernel seal and the
//!   write-ahead bind. The host re-validates every transition with [`verify_transition`], i.e. by
//!   running THIS function again over the recorded inputs.
//!
//! Evidence vocabulary (see the policy document §2): `new_claim_units` are model CLAIMS (monotonic
//! failure totals, a conflict flag rising); `new_trusted_failures` are Kernel-verified failed
//! verifications freshly folded by the Activity reducer. A model event can never be a trusted
//! failure: the host derives that counter from receipts, never from signals.
//!
//! Parameters are constants of the engine policy version, not configuration. Changing any of them
//! (or the algorithm) is a new `state_schema` for `muse-v1`.

use serde_json::{json, Map, Value};

/// Version of the policy this module implements (recorded with the engine's `state_schema`).
pub const LIMITER_POLICY_VERSION: u32 = 1;
/// `D`: consecutive qualifying lower decisions, from distinct attempts, before an ordinary move
/// down. The algorithm's single `pending_down` slot is the two-decision form.
pub const DWELL_DECISIONS: u32 = 2;
/// `R`: uncorroborated (claim-only) strong re-escalations per TASK, inherited by continuations.
pub const REARM_TOKENS: u8 = 2;
/// Upper bound of a serialized [`LimiterState`], pinned so the engine payload bound (16 KiB) cannot
/// be endangered by it.
pub const LIMITER_STATE_MAX_BYTES: usize = 256;

const _: () = assert!(
    DWELL_DECISIONS == 2,
    "the algorithm is the two-decision form"
);

/// Reasoning levels in the Governor's ladder order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Level {
    pub const ALL: [Level; 5] = [
        Level::Low,
        Level::Medium,
        Level::High,
        Level::Xhigh,
        Level::Max,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Low => "low",
            Level::Medium => "medium",
            Level::High => "high",
            Level::Xhigh => "xhigh",
            Level::Max => "max",
        }
    }

    pub fn parse(s: &str) -> Option<Level> {
        Level::ALL.into_iter().find(|l| l.as_str() == s)
    }
}

/// A lower decision waiting for its confirmation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingDown {
    /// The lower level the Governor asked for.
    pub target: Level,
    /// The attempt that asked for it.
    pub attempt: u32,
}

/// The limiter's whole memory. Bounded (a few dozen bytes) and fully serializable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LimiterState {
    pub pending_down: Option<PendingDown>,
    /// The attempt of the last applied move down, if any (generation-local).
    pub last_down_attempt: Option<u32>,
    /// A Kernel-verified failure was folded after `last_down_attempt` and has not been spent.
    pub trusted_since_down: bool,
    /// Claim-only strong re-arms applied so far in this TASK (`<= REARM_TOKENS`).
    pub rearm_tokens_used: u8,
    /// Highest attempt evaluated (monotonic guard; generation-local).
    pub last_attempt: u32,
}

/// The part of the Governor's semantic block that the evidence deltas are measured against. The
/// limiter judges CHANGES since its previous evaluation, so the host keeps the values observed at
/// that evaluation (a first-class item of the S6 payload: signals are folded between evaluations,
/// so the block read at `BeforeRequest` already contains them and cannot yield the delta alone).
/// The initial baseline is the Governor's own initial state (nothing failed, nothing established).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvidenceBaseline {
    /// `totalFailedHypotheses + totalFailedImplementationAttempts`: monotonic, never reset by progress.
    pub total_failures: u64,
    pub conflicting_evidence: bool,
    pub root_cause_established: bool,
    pub solution_established: bool,
}

impl EvidenceBaseline {
    /// Reads the baseline from a historical `museReasoning` block. `None` (no block yet) is the
    /// initial baseline; a block missing a field the Governor always writes is refused.
    pub fn from_reasoning(block: Option<&Value>) -> Result<Self, LimiterError> {
        let Some(b) = block.filter(|b| !b.is_null()) else {
            return Ok(Self::default());
        };
        let bad = |k: &str| LimiterError::Input(format!("the reasoning block lacks a valid `{k}`"));
        let n = |k: &str| b[k].as_u64().ok_or_else(|| bad(k));
        let f = |k: &str| b[k].as_bool().ok_or_else(|| bad(k));
        Ok(EvidenceBaseline {
            total_failures: n("totalFailedHypotheses")?
                .saturating_add(n("totalFailedImplementationAttempts")?),
            conflicting_evidence: f("conflictingEvidence")?,
            root_cause_established: f("rootCauseEstablished")?,
            solution_established: f("solutionEstablished")?,
        })
    }

    /// `(new_claim_units, progress_edge)` between this baseline and a later one: the growth of the
    /// historical failure totals plus a conflict rising false -> true, and a false -> true edge of
    /// either establishment flag (the Governor's own reset condition).
    pub fn delta_to(&self, next: &EvidenceBaseline) -> (u32, bool) {
        let units = next.total_failures.saturating_sub(self.total_failures)
            + u64::from(next.conflicting_evidence && !self.conflicting_evidence);
        let edge = (next.root_cause_established && !self.root_cause_established)
            || (next.solution_established && !self.solution_established);
        (u32::try_from(units).unwrap_or(u32::MAX), edge)
    }
}

/// Whether one entry of the Governor's decision trace records a strong escalation (the only way
/// the historical policy reaches `xhigh`).
pub fn is_escalation_entry(trace_entry: &str) -> bool {
    trace_entry.starts_with("escalation")
}

/// What one evaluation asks the limiter to judge.
#[derive(Clone, Copy, Debug)]
pub struct LimiterInput<'a> {
    /// The attempt number the decision is for (`attempts_dispatched + 1`, `>= 1`).
    pub attempt: u32,
    /// The Governor's effort, already clamped to the authorized ladder.
    pub governor: Level,
    /// The effort in force for the attempt (the pinned default before any selection).
    pub current: Level,
    /// The binding's authorized levels.
    pub authorized: &'a [Level],
    /// The Governor's policy trace contained `escalation:[...]` (the only way to `xhigh`).
    pub strong_escalation: bool,
    /// New model claims since the previous evaluation (monotonic failure totals; a conflict rising).
    pub new_claim_units: u32,
    /// Kernel-verified failures freshly folded in this evaluation.
    pub new_trusted_failures: u32,
    /// `rootCauseEstablished` or `solutionEstablished` went false -> true since the previous
    /// evaluation (the Governor's own reset condition).
    pub progress_edge: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimiterAction {
    KeepPinned,
    Change(Level),
}

/// The rule that decided (recorded in the retained history; `Change`s also in the
/// `effort-selected` event detail as `limiter:<rule>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimiterRule {
    Up,
    DownProgress,
    DownConfirmed,
    DownPending,
    HoldRearm,
    ResetEvidence,
    Noop,
    ReplayGuard,
}

impl LimiterRule {
    pub fn as_str(self) -> &'static str {
        match self {
            LimiterRule::Up => "up",
            LimiterRule::DownProgress => "down-progress",
            LimiterRule::DownConfirmed => "down-confirmed",
            LimiterRule::DownPending => "down-pending",
            LimiterRule::HoldRearm => "hold-rearm",
            LimiterRule::ResetEvidence => "reset-evidence",
            LimiterRule::Noop => "noop",
            LimiterRule::ReplayGuard => "replay-guard",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimiterDecision {
    pub action: LimiterAction,
    pub rule: LimiterRule,
    /// The state after the evaluation (equal to the previous state for a replay).
    pub state: LimiterState,
}

impl LimiterDecision {
    /// The audit detail of a selection (`limiter:<rule>`).
    pub fn detail(&self) -> String {
        format!("limiter:{}", self.rule.as_str())
    }
}

/// Why the limiter (or a state check) refused. Every variant is fail-closed: the caller keeps the
/// effort pinned and commits nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LimiterError {
    /// Unusable input: attempt 0, a level that is `max` or unauthorized, a current level that is
    /// not authorized.
    Input(String),
    /// A state that violates an invariant of the policy.
    State(String),
    /// A recorded transition that is not the pure function of (previous state, recorded input).
    Transition(String),
    /// Defence in depth: the decision itself broke an output invariant (a bug, never expected).
    Invariant(String),
}

impl LimiterError {
    pub fn code(&self) -> &'static str {
        match self {
            LimiterError::Input(_) => "limiter-input-invalid",
            LimiterError::State(_) => "limiter-state-invalid",
            LimiterError::Transition(_) => "limiter-transition-mismatch",
            LimiterError::Invariant(_) => "limiter-invariant",
        }
    }
    pub fn detail(&self) -> &str {
        match self {
            LimiterError::Input(d)
            | LimiterError::State(d)
            | LimiterError::Transition(d)
            | LimiterError::Invariant(d) => d,
        }
    }
}

impl std::fmt::Display for LimiterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.detail())
    }
}

/// What a state is checked against.
#[derive(Clone, Copy, Debug)]
pub struct StateBounds<'a> {
    /// The effort in force.
    pub current: Level,
    pub authorized: &'a [Level],
    /// The highest attempt the host could have admitted (`attempts_dispatched + 1`). `None` skips
    /// the bound (the pure function does not know the host's counter).
    pub max_attempt: Option<u32>,
}

impl LimiterState {
    /// The state of a fresh task.
    pub const fn new() -> Self {
        LimiterState {
            pending_down: None,
            last_down_attempt: None,
            trusted_since_down: false,
            rearm_tokens_used: 0,
            last_attempt: 0,
        }
    }

    /// The state a CONTINUATION starts from. The per-task budget (`rearm_tokens_used`) is inherited
    /// so a restart cannot refill it; everything tied to the previous generation's attempt counter
    /// or to its pending decision is reset (`last_attempt` restarts with the new generation's
    /// counter, a pending lower decision and the "last move down" belong to attempts that no longer
    /// exist, and a trusted failure of the previous generation was already weighed by it).
    pub const fn continued(&self) -> Self {
        LimiterState {
            pending_down: None,
            last_down_attempt: None,
            trusted_since_down: false,
            rearm_tokens_used: self.rearm_tokens_used,
            last_attempt: 0,
        }
    }

    /// Strict invariant check (policy §5). A forged or corrupted state is refused, never repaired.
    pub fn validate(&self, b: &StateBounds<'_>) -> Result<(), LimiterError> {
        let bad = |m: String| Err(LimiterError::State(m));
        if self.rearm_tokens_used > REARM_TOKENS {
            return bad(format!(
                "rearmTokensUsed {} exceeds the budget {REARM_TOKENS}",
                self.rearm_tokens_used
            ));
        }
        if self.trusted_since_down && self.last_down_attempt.is_none() {
            return bad("trustedSinceDown without a previous move down".into());
        }
        if let Some(max) = b.max_attempt {
            if self.last_attempt > max {
                return bad(format!(
                    "lastAttempt {} is beyond the admitted attempt {max}",
                    self.last_attempt
                ));
            }
        }
        if let Some(d) = self.last_down_attempt {
            if d == 0 || d > self.last_attempt {
                return bad(format!(
                    "lastDownAttempt {d} is outside 1..={}",
                    self.last_attempt
                ));
            }
        }
        if let Some(p) = self.pending_down {
            if p.attempt == 0 || p.attempt > self.last_attempt {
                return bad(format!(
                    "pendingDown.attempt {} is outside 1..={}",
                    p.attempt, self.last_attempt
                ));
            }
            if p.target == Level::Max || !b.authorized.contains(&p.target) {
                return bad(format!(
                    "pendingDown.target {} is not an authorized level",
                    p.target.as_str()
                ));
            }
            if p.target >= b.current {
                return bad(format!(
                    "pendingDown.target {} is not below the effort in force {}",
                    p.target.as_str(),
                    b.current.as_str()
                ));
            }
        }
        Ok(())
    }

    /// Canonical JSON for the engine payload (fixed key set, camelCase like the neighbouring blocks).
    pub fn to_value(&self) -> Value {
        json!({
            "pendingDown": self.pending_down.map(|p| json!({
                "target": p.target.as_str(), "attempt": p.attempt })),
            "lastDownAttempt": self.last_down_attempt,
            "trustedSinceDown": self.trusted_since_down,
            "rearmTokensUsed": self.rearm_tokens_used,
            "lastAttempt": self.last_attempt,
        })
    }

    /// Strict decoder: exactly the five keys, exact types, levels from the closed set (never
    /// `max`), integers in range, the token budget respected. Anything else is refused.
    pub fn from_value(v: &Value) -> Result<Self, LimiterError> {
        let bad = |m: &str| LimiterError::State(m.to_owned());
        let o = v
            .as_object()
            .ok_or_else(|| bad("the limiter state is not an object"))?;
        exact_keys(
            o,
            &[
                "pendingDown",
                "lastDownAttempt",
                "trustedSinceDown",
                "rearmTokensUsed",
                "lastAttempt",
            ],
        )?;
        let uint = |k: &str| -> Result<u32, LimiterError> {
            o[k].as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| {
                    LimiterError::State(format!("{k} is not an unsigned 32-bit integer"))
                })
        };
        let opt_uint = |k: &str| -> Result<Option<u32>, LimiterError> {
            if o[k].is_null() {
                Ok(None)
            } else {
                uint(k).map(Some)
            }
        };
        let pending_down = match &o["pendingDown"] {
            Value::Null => None,
            Value::Object(p) => {
                exact_keys(p, &["target", "attempt"])?;
                let target = p["target"]
                    .as_str()
                    .and_then(Level::parse)
                    .filter(|l| *l != Level::Max)
                    .ok_or_else(|| bad("pendingDown.target is not a level below max"))?;
                let attempt = p["attempt"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| bad("pendingDown.attempt is not an unsigned integer"))?;
                Some(PendingDown { target, attempt })
            }
            _ => return Err(bad("pendingDown is neither null nor an object")),
        };
        let tokens = o["rearmTokensUsed"]
            .as_u64()
            .and_then(|n| u8::try_from(n).ok())
            .ok_or_else(|| bad("rearmTokensUsed is not a small unsigned integer"))?;
        let s = LimiterState {
            pending_down,
            last_down_attempt: opt_uint("lastDownAttempt")?,
            trusted_since_down: o["trustedSinceDown"]
                .as_bool()
                .ok_or_else(|| bad("trustedSinceDown is not a boolean"))?,
            rearm_tokens_used: tokens,
            last_attempt: uint("lastAttempt")?,
        };
        // the structural invariants that do not need the host's context
        if s.rearm_tokens_used > REARM_TOKENS {
            return Err(bad("rearmTokensUsed exceeds the budget"));
        }
        if s.trusted_since_down && s.last_down_attempt.is_none() {
            return Err(bad("trustedSinceDown without a previous move down"));
        }
        Ok(s)
    }
}

fn exact_keys(o: &Map<String, Value>, keys: &[&str]) -> Result<(), LimiterError> {
    if o.len() != keys.len() || !keys.iter().all(|k| o.contains_key(*k)) {
        return Err(LimiterError::State(format!(
            "expected exactly the keys {keys:?}"
        )));
    }
    Ok(())
}

fn check_input(i: &LimiterInput<'_>) -> Result<(), LimiterError> {
    let bad = |m: String| Err(LimiterError::Input(m));
    if i.attempt == 0 {
        return bad("attempt 0".into());
    }
    if i.governor == Level::Max {
        return bad("the Governor effort `max` is never applied by the limiter".into());
    }
    if !i.authorized.contains(&i.governor) {
        return bad(format!(
            "the Governor effort {} is not authorized",
            i.governor.as_str()
        ));
    }
    if !i.authorized.contains(&i.current) {
        return bad(format!(
            "the effort in force {} is not authorized",
            i.current.as_str()
        ));
    }
    Ok(())
}

fn out(
    action: LimiterAction,
    rule: LimiterRule,
    state: LimiterState,
    i: &LimiterInput<'_>,
) -> Result<LimiterDecision, LimiterError> {
    if let LimiterAction::Change(e) = action {
        if e == i.current || e == Level::Max || !i.authorized.contains(&e) {
            return Err(LimiterError::Invariant(format!(
                "refusing to emit Change({}) with {} in force",
                e.as_str(),
                i.current.as_str()
            )));
        }
    }
    Ok(LimiterDecision {
        action,
        rule,
        state,
    })
}

/// The policy. Pure: equal `(prev, input)` give equal results and `prev` is never touched.
pub fn limit(prev: &LimiterState, i: &LimiterInput<'_>) -> Result<LimiterDecision, LimiterError> {
    check_input(i)?;
    prev.validate(&StateBounds {
        current: i.current,
        authorized: i.authorized,
        max_attempt: None,
    })?;
    let n = i.attempt;

    // 0. replay / out-of-order guard: the attempt must advance the state
    if n <= prev.last_attempt {
        return out(
            LimiterAction::KeepPinned,
            LimiterRule::ReplayGuard,
            *prev,
            i,
        );
    }
    let mut s = *prev;
    s.last_attempt = n;
    if i.new_trusted_failures > 0 && s.last_down_attempt.is_some() {
        s.trusted_since_down = true;
    }
    let (gov, cur) = (i.governor, i.current);

    // 1. identical: nothing to do, and nothing pending any more
    if gov == cur {
        s.pending_down = None;
        return out(LimiterAction::KeepPinned, LimiterRule::Noop, s, i);
    }

    // 2. escalation
    if gov > cur {
        s.pending_down = None;
        let claim_rearm = i.strong_escalation && s.last_down_attempt.is_some();
        if !claim_rearm {
            // an ordinary, or the first strong, escalation: never delayed
            return out(LimiterAction::Change(gov), LimiterRule::Up, s, i);
        }
        if s.trusted_since_down {
            // fresh Kernel-verified failure since the drop: free
            s.trusted_since_down = false;
            return out(LimiterAction::Change(gov), LimiterRule::Up, s, i);
        }
        if s.rearm_tokens_used < REARM_TOKENS {
            s.rearm_tokens_used += 1;
            return out(LimiterAction::Change(gov), LimiterRule::Up, s, i);
        }
        return out(LimiterAction::KeepPinned, LimiterRule::HoldRearm, s, i);
    }

    // 3. de-escalation
    let evidence = i.new_claim_units > 0 || i.new_trusted_failures > 0;
    if i.progress_edge && !evidence {
        // A-1: the Governor's own reset condition fired on this attempt
        s.pending_down = None;
        s.last_down_attempt = Some(n);
        s.trusted_since_down = false;
        return out(LimiterAction::Change(gov), LimiterRule::DownProgress, s, i);
    }
    if evidence {
        s.pending_down = None;
        return out(LimiterAction::KeepPinned, LimiterRule::ResetEvidence, s, i);
    }
    if let Some(p) = s
        .pending_down
        .filter(|p| p.attempt.checked_add(1) == Some(n))
    {
        let target = p.target.max(gov);
        s.pending_down = None;
        s.last_down_attempt = Some(n);
        s.trusted_since_down = false;
        return out(
            LimiterAction::Change(target),
            LimiterRule::DownConfirmed,
            s,
            i,
        );
    }
    s.pending_down = Some(PendingDown {
        target: gov,
        attempt: n,
    });
    out(LimiterAction::KeepPinned, LimiterRule::DownPending, s, i)
}

/// The host's independent check of a recorded transition: `next` and `action` must be exactly the
/// pure function of `prev` and the recorded input, and `next` must satisfy every invariant against
/// the host's own counters. This is what makes a forged limiter state or decision unrepresentable.
pub fn verify_transition(
    prev: &LimiterState,
    input: &LimiterInput<'_>,
    action: LimiterAction,
    next: &LimiterState,
    max_attempt: u32,
) -> Result<LimiterRule, LimiterError> {
    // the new state must keep its own bounds against the level in force AFTER the decision
    let after = match action {
        LimiterAction::Change(e) => e,
        LimiterAction::KeepPinned => input.current,
    };
    next.validate(&StateBounds {
        current: after,
        authorized: input.authorized,
        max_attempt: Some(max_attempt),
    })?;
    let want = limit(prev, input)?;
    if want.action != action || want.state != *next {
        return Err(LimiterError::Transition(format!(
            "the recorded transition is not the policy's result (rule {})",
            want.rule.as_str()
        )));
    }
    Ok(want.rule)
}
