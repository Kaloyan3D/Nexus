//! `muse-v1-shadow` (EM-04A): the historical Muse Reasoning Governor in SHADOW mode.
//!
//! What it does:
//! * its strategy (guidance, finish) is `muse-v0`'s, delegated decision for decision, so a run
//!   under `muse-v1-shadow` behaves exactly like one under `muse-v0`;
//! * before every request it folds the run's NEW trusted activity observations (Core receipts:
//!   verified mutations and verification outcomes) into the historical `museActivity` block and
//!   asks the historical Governor, through the Runtime's own per-request seam, which effort the next
//!   attempt would get - against the task binding's authorized levels as capabilities;
//! * it records that decision (deterministic evidence, bounded history) in its versioned EM-03
//!   engine state - and NEVER applies it: the proposal is always `KeepPinned`, its descriptor says
//!   `may_propose_effort: false` (the host would refuse a change anyway), and the provider request
//!   carries the pinned effort.
//!
//! It is not selectable in production (`MUSE_V1_PRODUCTION_ENABLED = false`): only `test-engines`
//! builds register it, and only a fixture Registry mode can issue it.
//!
//! State ownership: the historical `museReasoning` / `museActivity` blocks live in this engine's
//! payload (`<state>/engine/<task>.json`, HMAC-authenticated, revisioned), never in a DSH
//! routing-state file. In EM-04A there is no signals tool, so the SEMANTIC fields (phase,
//! establishment flags, failure counters, conflict, max request) can never change: the transition
//! rule refuses it. Only the trusted activity block, the resolution diagnostics and this engine's
//! own bookkeeping move.

use super::effort_limiter::Level;
use super::governor_bridge::{sources_digest, BridgeError};
use super::muse_v0::{MuseV0State, MUSE_V0};
use super::muse_v1_adaptive::{
    check_adaptive, evaluate_limiter, record_effort, strong_escalation_of_block,
    strong_escalation_of_decision, Adaptive, LimiterRecord, ACTIVE_STATE_SCHEMA,
    MAX_PENDING_TRUSTED,
};
use super::{
    EffortProposal, EngineAction, EngineDescriptor, EngineEnv, EngineExtension, EngineProposal,
    EngineSnapshot, EngineState, EngineStateData, Hook, ObservationKind, RestoreContext,
    SignalObservation,
};
use serde_json::{json, Value};

/// The shadow engine's Registry id (test-only).
pub const ENGINE_ID: &str = "muse-v1-shadow";
/// EM-04C2 S6: the ACTIVE adaptive engine's Registry id and its one mode.
pub const ACTIVE_ENGINE_ID: &str = "nexus-adaptive-v1";
pub const ADAPTIVE_MODE_ID: &str = "engineering-v2-adaptive";

/// Exact wire bytes of the future `muse_update_reasoning_state` tool in the request's `tools`
/// array, including its separator: measured from `config/Muse-ReasoningSignals.cjs` (9 properties,
/// 1,174-character description) in the Native definition format. Re-measured by a test.
pub const SIGNALS_TOOL_RESERVE_BYTES: usize = 2_882;

/// The historical Governor ladder (unchanged; `low` is NOT part of it).
pub const MUSE_LADDER: [&str; 4] = ["medium", "high", "xhigh", "max"];
pub const MUSE_PHASES: [&str; 7] = [
    "discover",
    "diagnose",
    "design",
    "implement",
    "verify",
    "recover",
    "review",
];

/// Kernel execution ids remembered for replay refusal.
pub const MAX_SEEN_EXECUTIONS: usize = 64;
/// EM-04B: the EXPERIMENTAL signals engine's Registry id (test-only, like the shadow engine).
pub const SIGNALS_ENGINE_ID: &str = "muse-v1-signals";
/// The historical processed-signal window (`MAX_PROCESSED_SIGNAL_IDS`).
pub const MAX_PROCESSED_SIGNAL_IDS: usize = 100;
/// Shadow decisions kept (newest last).
pub const MAX_DECISION_HISTORY: usize = 8;

pub static MUSE_V1: MuseV1 = MuseV1 {
    descriptor: EngineDescriptor {
        engine_id: ENGINE_ID,
        contract_version: super::ENGINE_CONTRACT_VERSION,
        mode_ids: &["engineering-v2"],
        roles: &["muse_main"],
        state_schema: 1,
        // SHADOW: the Governor's proposal is observed, never applied
        may_propose_effort: false,
        // the cognitive state continues with the task (see `restore_state`)
        inherits_state: true,
        // room for the future signals tool, so EM-04B adds no request bytes the budget did not hold
        request_reserve_bytes: SIGNALS_TOOL_RESERVE_BYTES,
    },
    signals: false,
    adaptive: false,
};

/// EM-04B: the shadow Governor PLUS the model-visible reasoning-signals tool. Same strategy, same
/// shadow (never applied); its catalog carries the tool, so nothing is reserved for it: the tool's
/// bytes are part of every prepared request the budget measures.
pub static MUSE_V1_SIGNALS: MuseV1 = MuseV1 {
    descriptor: EngineDescriptor {
        engine_id: SIGNALS_ENGINE_ID,
        contract_version: super::ENGINE_CONTRACT_VERSION,
        mode_ids: &["engineering-v2"],
        roles: &["muse_main"],
        state_schema: 1,
        may_propose_effort: false,
        inherits_state: true,
        request_reserve_bytes: 0,
    },
    signals: true,
    adaptive: false,
};

/// EM-04C2 S6: the ACTIVE adaptive engine. Same strategy, Governor and signals tool as the
/// experimental engines, but its limiter-approved effort proposals ARE applied (through the host's
/// admission, the Registry's attempt issuance and the Kernel's seal). Runs only in mode
/// `engineering-v2-adaptive`; registered in production builds only when
/// `MUSE_V1_PRODUCTION_ENABLED` is opened (S10); refuses to dispatch without a Registry-sealed
/// request-size budget.
pub static MUSE_V1_ACTIVE: MuseV1 = MuseV1 {
    descriptor: EngineDescriptor {
        engine_id: ACTIVE_ENGINE_ID,
        contract_version: super::ENGINE_CONTRACT_VERSION,
        mode_ids: &[ADAPTIVE_MODE_ID],
        roles: &["muse_main"],
        state_schema: ACTIVE_STATE_SCHEMA,
        may_propose_effort: true,
        inherits_state: true,
        // the signals tool is part of the active catalog: its bytes are in every measured request
        request_reserve_bytes: 0,
    },
    signals: true,
    adaptive: true,
};

pub struct MuseV1 {
    descriptor: EngineDescriptor,
    /// Takes reasoning signals (`muse-v1-signals` and `nexus-adaptive-v1`).
    signals: bool,
    /// The limiter-governed active engine (`nexus-adaptive-v1`): proposes efforts, carries `Adaptive` state.
    adaptive: bool,
}

/// One shadow evaluation (what the Governor decided for an attempt, and what was really used).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShadowDecision {
    /// The model attempt the decision is for (1-based).
    pub attempt: u32,
    /// `resolved` | `capability-unavailable` | a bridge error code (`bridge-unavailable`, ...).
    pub outcome: String,
    /// The Governor's effort after its own downward-only capability clamp (historical ladder).
    pub governor_effort: Option<String>,
    /// The effort the Governor's policy asked for before the clamp.
    pub requested: Option<String>,
    pub reason: Option<String>,
    pub effective_phase: Option<String>,
    pub effective_source: Option<String>,
    pub trace: Vec<String>,
    /// The effort that attempt actually carries (always the authorized effort in force).
    pub in_force: String,
    /// What an ACTIVE Governor would propose: `keep` or `change:<level>` (never applied here).
    pub would: String,
    /// Observations folded by this evaluation.
    pub folded: u32,
    /// Observations offered that were refused (another generation, replayed or stale).
    pub refused: u32,
    /// SHA-256 over the embedded sources, the bridge input and its output.
    pub evidence: String,
    /// EM-04C2 S6: the limiter's decision for this attempt (`nexus-adaptive-v1` only; `None` for every other
    /// engine and for evaluations the Governor did not resolve).
    pub limiter: Option<LimiterRecord>,
}

/// Engine state: `muse-v0`'s strategy counters plus the historical Muse blocks and the shadow
/// bookkeeping.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MuseV1State {
    pub v0: MuseV0State,
    /// Historical `museReasoning` block (None until the first resolution).
    pub reasoning: Option<Value>,
    /// Historical `museActivity` block (None until the first observation).
    pub activity: Option<Value>,
    /// Task generation the observation frontier belongs to.
    pub generation: String,
    /// Highest observation `seq` folded in `generation`.
    pub observed_through: u32,
    /// Kernel execution ids folded (bounded, oldest dropped first).
    pub seen: Vec<String>,
    /// Shadow evaluations so far (across generations).
    pub evaluations: u32,
    pub history: Vec<ShadowDecision>,
    /// Hash chain over EVERY decision's evidence (`sha256(previous chain || evidence)`), so the
    /// full sequence stays verifiable by replay although only the newest decisions are kept.
    pub chain: String,
    /// EM-04B: highest signal `seq` consumed in `generation`.
    pub signals_through: u32,
    /// Signals applied / recognized as duplicate deliveries (across generations).
    pub signals_accepted: u32,
    pub signals_duplicate: u32,
    /// Signals of the LAST signal consultation that were consumed but not applied (the historical
    /// path refused them or the bridge was unavailable); the model was told so.
    pub last_unapplied: Vec<u32>,
    /// EM-04C2 S6: limiter state, evidence baseline and pending trusted evidence (`nexus-adaptive-v1` only).
    pub adaptive: Option<Adaptive>,
}

impl MuseV1State {
    pub(super) fn encoded_len(&self) -> usize {
        persisted(self).to_string().len()
    }
}

fn v0_state(v0: &MuseV0State, like: &EngineState) -> EngineState {
    EngineState {
        engine_id: MUSE_V0.descriptor().engine_id,
        schema: MUSE_V0.descriptor().state_schema,
        revision: like.revision,
        data: EngineStateData::MuseV0(v0.clone()),
    }
}

fn data(s: &EngineState) -> Option<&MuseV1State> {
    match &s.data {
        EngineStateData::MuseV1(d) => Some(d),
        _ => None,
    }
}

fn decision_json(d: &ShadowDecision) -> Value {
    let mut v = json!({
        "attempt": d.attempt, "outcome": d.outcome, "governorEffort": d.governor_effort,
        "requested": d.requested, "reason": d.reason, "effectivePhase": d.effective_phase,
        "effectiveSource": d.effective_source, "trace": d.trace, "inForce": d.in_force,
        "would": d.would, "folded": d.folded, "refused": d.refused, "evidence": d.evidence,
    });
    // present only for the active engine, so every other engine's decision (and chain) is
    // byte-identical to what it always was
    if let Some(l) = &d.limiter {
        v["limiter"] = l.to_value();
    }
    v
}

/// The decision chain after `d` (see `MuseV1State::chain`).
pub(crate) fn extend_chain(previous: &str, d: &ShadowDecision) -> String {
    nexus_contracts::sha256_hex(&format!(
        "{previous}\n{}",
        nexus_contracts::canonical_json(&decision_json(d))
    ))
}

fn decision_from(v: &Value, adaptive: bool) -> Option<ShadowDecision> {
    let o = v.as_object()?;
    let limiter = match o.get("limiter") {
        None => None,
        Some(l) if adaptive => Some(LimiterRecord::from_value(l)?),
        Some(_) => return None,
    };
    let allowed = [
        "attempt",
        "outcome",
        "governorEffort",
        "requested",
        "reason",
        "effectivePhase",
        "effectiveSource",
        "trace",
        "inForce",
        "would",
        "folded",
        "refused",
        "evidence",
    ];
    if o.keys()
        .any(|k| k != "limiter" && !allowed.contains(&k.as_str()))
    {
        return None;
    }
    let opt = |k: &str| -> Option<Option<String>> {
        match o.get(k)? {
            Value::Null => Some(None),
            Value::String(s) if s.len() <= 64 => Some(Some(s.clone())),
            _ => None,
        }
    };
    let s = |k: &str| {
        o.get(k)?
            .as_str()
            .filter(|x| x.len() <= 64)
            .map(str::to_owned)
    };
    let u = |k: &str| o.get(k)?.as_u64().and_then(|x| u32::try_from(x).ok());
    let trace: Vec<String> = o
        .get("trace")?
        .as_array()?
        .iter()
        .map(|t| t.as_str().filter(|x| x.len() <= 160).map(str::to_owned))
        .collect::<Option<_>>()?;
    if trace.len() > 8 {
        return None;
    }
    Some(ShadowDecision {
        attempt: u("attempt")?,
        outcome: s("outcome")?,
        governor_effort: opt("governorEffort")?,
        requested: opt("requested")?,
        reason: opt("reason")?,
        effective_phase: opt("effectivePhase")?,
        effective_source: opt("effectiveSource")?,
        trace,
        in_force: s("inForce")?,
        would: s("would")?,
        folded: u("folded")?,
        refused: u("refused")?,
        evidence: s("evidence")?,
        limiter,
    })
}

fn persisted(s: &MuseV1State) -> Value {
    let mut v = json!({
        "v0": MUSE_V0.persist_state(&EngineState {
            engine_id: MUSE_V0.descriptor().engine_id,
            schema: 1,
            revision: 0,
            data: EngineStateData::MuseV0(s.v0.clone()),
        }),
        "museReasoning": s.reasoning,
        "museActivity": s.activity,
        "generation": s.generation,
        "observedThrough": s.observed_through,
        "seen": s.seen,
        "evaluations": s.evaluations,
        "history": s.history.iter().map(decision_json).collect::<Vec<_>>(),
        "chain": s.chain,
        "sourcesDigest": sources_digest(),
        "signalsThrough": s.signals_through,
        "signalsAccepted": s.signals_accepted,
        "signalsDuplicate": s.signals_duplicate,
        "lastUnapplied": s.last_unapplied,
    });
    if let Some(a) = &s.adaptive {
        v["adaptive"] = a.to_value();
    }
    v
}

// ---- the historical signal transition, re-stated for the host's validation (EM-04B) ----------

/// The semantic fields after one signal, exactly as the historical `applyReasoningSignal` +
/// `transitionMuseReasoningState` compute them: duplicate dispatch keys change nothing;
/// established and conflicting flags move false -> true only, and explicit invalidation is the
/// only way back; failure events count +1 (active and total); a NEWLY established root cause
/// resets the hypothesis window and conflict, and a newly established solution resets the
/// implementation window; the key joins the bounded processed window. Pure. `semantic` is a
/// `semantic_of` object; the signal was validated by the Core (`signals::validate`).
pub(crate) fn fold_signal(semantic: &Value, signal: &Value, key: &str) -> (Value, bool) {
    let mut out = semantic.clone();
    let ids: Vec<String> = semantic["processedSignalIds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if ids.iter().any(|x| x == key) {
        return (out, false);
    }
    let on = |f: &str| signal.get(f) == Some(&Value::Bool(true));
    let b = |k: &str| semantic[k].as_bool().unwrap_or(false);
    let n = |k: &str| semantic[k].as_u64().unwrap_or(0);
    let mut patch = serde_json::Map::new();
    if let Some(p) = signal.get("phase").and_then(Value::as_str) {
        if let Some(p) = crate::signals::normalized_phase(p) {
            patch.insert("phase".into(), json!(p));
        }
    }
    if on("markRootCauseEstablished") && !b("rootCauseEstablished") {
        patch.insert("rootCauseEstablished".into(), json!(true));
    }
    if on("markSolutionEstablished") && !b("solutionEstablished") {
        patch.insert("solutionEstablished".into(), json!(true));
    }
    if on("conflictingEvidence") && !b("conflictingEvidence") {
        patch.insert("conflictingEvidence".into(), json!(true));
    }
    if on("invalidateRootCause") {
        patch.insert("rootCauseEstablished".into(), json!(false));
        patch.insert("solutionEstablished".into(), json!(false));
    }
    if on("invalidateSolution") {
        patch.insert("solutionEstablished".into(), json!(false));
    }
    if on("resolveConflictingEvidence") {
        patch.insert("conflictingEvidence".into(), json!(false));
    }
    if on("recordHypothesisFailure") {
        patch.insert("failedHypotheses".into(), json!(n("failedHypotheses") + 1));
        patch.insert(
            "totalFailedHypotheses".into(),
            json!(n("totalFailedHypotheses") + 1),
        );
    }
    if on("recordImplementationFailure") {
        patch.insert(
            "failedImplementationAttempts".into(),
            json!(n("failedImplementationAttempts") + 1),
        );
        patch.insert(
            "totalFailedImplementationAttempts".into(),
            json!(n("totalFailedImplementationAttempts") + 1),
        );
    }
    // progress-window resets on the false -> true establishment edge only
    if patch.get("rootCauseEstablished") == Some(&json!(true)) && !b("rootCauseEstablished") {
        patch.insert("failedHypotheses".into(), json!(0));
        patch.insert("conflictingEvidence".into(), json!(false));
    }
    if patch.get("solutionEstablished") == Some(&json!(true)) && !b("solutionEstablished") {
        patch.insert("failedImplementationAttempts".into(), json!(0));
    }
    for (k, v) in patch {
        out[k.as_str()] = v;
    }
    let mut ids: Vec<String> = ids.into_iter().filter(|x| x != key).collect();
    ids.push(key.to_owned());
    let excess = ids.len().saturating_sub(MAX_PROCESSED_SIGNAL_IDS);
    ids.drain(..excess);
    out["processedSignalIds"] = json!(ids);
    (out, true)
}

// ---- validation of the historical blocks (Rust side; the bridge validates them again) -------

const SEMANTIC_FIELDS: [&str; 10] = [
    "phase",
    "rootCauseEstablished",
    "solutionEstablished",
    "failedHypotheses",
    "failedImplementationAttempts",
    "totalFailedHypotheses",
    "totalFailedImplementationAttempts",
    "conflictingEvidence",
    "requestMax",
    "processedSignalIds",
];

/// A structurally valid historical `museReasoning` block.
pub fn valid_reasoning_block(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let allowed: Vec<&str> = SEMANTIC_FIELDS
        .iter()
        .copied()
        .chain(["currentEffort", "lastResolution"])
        .collect();
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return false;
    }
    let phase_ok = o
        .get("phase")
        .and_then(Value::as_str)
        .is_some_and(|p| MUSE_PHASES.contains(&p));
    let counters_ok = [
        "failedHypotheses",
        "failedImplementationAttempts",
        "totalFailedHypotheses",
        "totalFailedImplementationAttempts",
    ]
    .iter()
    .all(|k| {
        o.get(*k)
            .and_then(Value::as_u64)
            .is_some_and(|n| n < 1_000_000)
    });
    let flags_ok = [
        "rootCauseEstablished",
        "solutionEstablished",
        "conflictingEvidence",
        "requestMax",
    ]
    .iter()
    .all(|k| o.get(*k).is_some_and(Value::is_boolean));
    let effort_ok = match o.get("currentEffort") {
        None | Some(Value::Null) => true,
        Some(Value::String(e)) => MUSE_LADDER.contains(&e.as_str()),
        _ => false,
    };
    let signals_ok = match o.get("processedSignalIds") {
        None => true,
        Some(Value::Array(a)) => {
            a.len() <= 100 && a.iter().all(|x| x.as_str().is_some_and(|s| s.len() <= 128))
        }
        _ => false,
    };
    let last_ok = match o.get("lastResolution") {
        None | Some(Value::Null) => true,
        Some(Value::Object(l)) => {
            l.len() <= 12 && Value::Object(l.clone()).to_string().len() <= 2048
        }
        _ => false,
    };
    phase_ok && counters_ok && flags_ok && effort_ok && signals_ok && last_ok
}

/// A structurally valid historical `museActivity` block (schema 1).
pub fn valid_activity_block(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let allowed = [
        "schemaVersion",
        "revision",
        "semanticRevision",
        "lastMutationRevision",
        "mutationCount",
        "verification",
    ];
    if o.len() != allowed.len() || o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return false;
    }
    let n = |k: &str| o.get(k).and_then(Value::as_u64);
    let Some(rev) = n("revision") else {
        return false;
    };
    let ok = o.get("schemaVersion") == Some(&json!(1))
        && n("semanticRevision").is_some_and(|x| x <= rev)
        && n("lastMutationRevision").is_some_and(|x| x <= rev)
        && n("mutationCount").is_some();
    let Some(ver) = o.get("verification").and_then(Value::as_object) else {
        return false;
    };
    let ver_ok = ver.len() == 3
        && ver
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| ["none", "started", "passed", "failed"].contains(&s))
        && ver
            .get("revision")
            .and_then(Value::as_u64)
            .is_some_and(|x| x <= rev)
        && match ver.get("family") {
            Some(Value::Null) => true,
            Some(Value::String(f)) => f.len() <= 64,
            _ => false,
        };
    ok && ver_ok
}

fn semantic_of(block: &Option<Value>) -> Value {
    // the historical initial state (discover, nothing established) when no block exists yet
    let base = json!({
        "phase": "discover", "rootCauseEstablished": false, "solutionEstablished": false,
        "failedHypotheses": 0, "failedImplementationAttempts": 0, "totalFailedHypotheses": 0,
        "totalFailedImplementationAttempts": 0, "conflictingEvidence": false, "requestMax": false,
        "processedSignalIds": [],
    });
    let mut out = serde_json::Map::new();
    for k in SEMANTIC_FIELDS {
        let v = block
            .as_ref()
            .and_then(|b| b.get(k))
            .cloned()
            .unwrap_or_else(|| base[k].clone());
        out.insert(k.to_owned(), v);
    }
    Value::Object(out)
}

pub(crate) fn classification(kind: &ObservationKind) -> Value {
    match kind {
        ObservationKind::Mutation => json!({ "kind": "mutation" }),
        ObservationKind::Verification { outcome, family } => json!({
            "kind": "verification", "outcome": outcome.as_str(), "family": format!("native:{family}"),
        }),
    }
}

/// The shadow evaluation at `BeforeRequest`: fold the new trusted observations, resolve, record.
fn evaluate(s: &mut MuseV1State, snap: &EngineSnapshot, env: &EngineEnv, adaptive: bool) {
    if s.generation != snap.generation {
        // a new task generation (continuation): its observations start at seq 1 again
        s.generation = snap.generation.clone();
        s.observed_through = 0;
    }
    let mut fresh = Vec::new();
    let mut refused = 0u32;
    let mut last_seq = s.observed_through;
    for o in &snap.activity {
        let acceptable = o.generation == s.generation
            && o.seq > last_seq
            && !s.seen.contains(&o.execution_id)
            && !fresh
                .iter()
                .any(|(_, id): &(Value, String)| *id == o.execution_id);
        if acceptable {
            last_seq = o.seq;
            fresh.push((classification(&o.kind), o.execution_id.clone()));
        } else if o.seq > s.observed_through || o.generation != s.generation {
            // anything not already folded that cannot be folded: forged, replayed or foreign
            refused += 1;
        }
    }
    let args = json!({
        "museReasoning": s.reasoning,
        "museActivity": s.activity,
        "events": fresh.iter().map(|(c, _)| json!({"type": "activity", "classification": c})).collect::<Vec<_>>(),
        "capabilities": snap.authorized_efforts,
        "resolve": true,
    });
    let attempt = snap.attempts_dispatched + 1;
    let result: Result<Value, BridgeError> = match &env.governor {
        Some(g) => g.call("evaluate", &args),
        None => Err(BridgeError {
            code: "bridge-unavailable".into(),
            message: "no Governor evaluator was lent to this run".into(),
        }),
    };
    let mut d = ShadowDecision {
        attempt,
        in_force: snap.current_effort.clone(),
        would: "keep".into(),
        refused,
        ..Default::default()
    };
    match result {
        // the answer must be well-formed, and folding observations must have produced evidence
        Ok(r)
            if (r["museReasoning"].is_null() || valid_reasoning_block(&r["museReasoning"]))
                && (r["museActivity"].is_null() || valid_activity_block(&r["museActivity"]))
                && (fresh.is_empty() || !r["museActivity"].is_null())
                && (!adaptive || adaptive_response_ok(&r)) =>
        {
            let dec = &r["decision"];
            let st = |k: &str| {
                dec[k]
                    .as_str()
                    .map(|x| x.chars().take(64).collect::<String>())
            };
            d.outcome = st("outcome").unwrap_or_else(|| "bridge-output-invalid".into());
            d.requested = st("requested");
            d.reason = st("reason");
            d.effective_phase = st("effectivePhase");
            d.effective_source = st("effectiveSource");
            d.trace = dec["trace"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .take(8)
                        .map(|t| t.chars().take(160).collect())
                        .collect()
                })
                .unwrap_or_default();
            if d.outcome == "resolved" {
                d.governor_effort = st("effort").filter(|e| MUSE_LADDER.contains(&e.as_str()));
                // the ladder decision: an active Governor would propose only an authorized level,
                // only when it differs from the effort in force; otherwise it keeps that effort
                if let Some(e) = &d.governor_effort {
                    if *e != snap.current_effort && snap.authorized_efforts.contains(e) {
                        d.would = format!("change:{e}");
                    }
                }
            }
            if !r["museReasoning"].is_null() {
                s.reasoning = Some(r["museReasoning"].clone());
            }
            if !r["museActivity"].is_null() {
                s.activity = Some(r["museActivity"].clone());
            }
            if adaptive {
                // EM-04C2 S6: the limiter judges the COMPLETE, validated Governor answer
                let fresh_failed = fresh
                    .iter()
                    .filter(|(c, _)| c["kind"] == "verification" && c["outcome"] == "failed")
                    .count() as u32;
                let a = s.adaptive.unwrap_or_default();
                if d.outcome == "resolved" {
                    let (strong, trace_len) =
                        strong_escalation_of_decision(dec).unwrap_or((false, 0));
                    let (next, rec) = evaluate_limiter(
                        &a,
                        snap,
                        d.governor_effort.as_deref(),
                        strong,
                        s.reasoning.as_ref(),
                        fresh_failed,
                        trace_len,
                    );
                    d.would = rec.action.clone();
                    d.limiter = Some(rec);
                    s.adaptive = Some(next);
                } else {
                    // the Governor resolved no effort (e.g. a default-only slot): the limiter does
                    // not run; trusted failures folded now stay pending for the next judgement
                    d.would = "keep".into();
                    s.adaptive = Some(Adaptive {
                        pending_trusted: a
                            .pending_trusted
                            .saturating_add(fresh_failed)
                            .min(MAX_PENDING_TRUSTED),
                        ..a
                    });
                }
            }
            d.folded = fresh.len() as u32;
            s.observed_through = last_seq;
            for (_, id) in fresh {
                s.seen.push(id);
            }
            let excess = s.seen.len().saturating_sub(MAX_SEEN_EXECUTIONS);
            s.seen.drain(..excess);
            d.evidence = nexus_contracts::sha256_hex(&format!(
                "{}\n{}\n{}",
                sources_digest(),
                nexus_contracts::canonical_json(&args),
                nexus_contracts::canonical_json(&r)
            ));
        }
        Ok(_) => {
            d.outcome = "bridge-output-invalid".into();
        }
        Err(e) => {
            // shadow: an unavailable or refusing Governor changes nothing; the observations stay
            // unfolded (they are offered again) and the attempt keeps its authorized effort
            d.outcome = e.code.chars().take(64).collect();
        }
    }
    s.evaluations += 1;
    s.chain = extend_chain(&s.chain, &d);
    s.history.push(d);
    let excess = s.history.len().saturating_sub(MAX_DECISION_HISTORY);
    s.history.drain(..excess);
}

/// F-3 + forged-answer defence for the active engine: a RESOLVED Governor answer is accepted only
/// if its complete trace is within bounds and its strong-escalation evidence agrees with the
/// Governor's own condition over the returned block. Anything else is `bridge-output-invalid`
/// (the observations stay unfolded and are offered again) - never a shortened or guessed answer.
fn adaptive_response_ok(r: &Value) -> bool {
    let dec = &r["decision"];
    if dec["outcome"].as_str() != Some("resolved") {
        return true;
    }
    match strong_escalation_of_decision(dec) {
        Ok((strong, _)) => {
            strong == strong_escalation_of_block(Some(&r["museReasoning"]))
                && dec["effort"].as_str().is_some()
        }
        Err(_) => false,
    }
}

/// EM-04B: consume the run's new signals (and the trusted observations made before the newest
/// one, so the historical event order holds) through the historical `applyReasoningSignal`.
/// Returns the acknowledgement for the newest signal.
fn take_signals(s: &mut MuseV1State, snap: &EngineSnapshot, env: &EngineEnv) -> Value {
    if s.generation != snap.generation {
        s.generation = snap.generation.clone();
        s.observed_through = 0;
        s.signals_through = 0;
    }
    let fresh: Vec<&SignalObservation> = snap
        .signals
        .iter()
        .filter(|x| x.generation == s.generation && x.seq > s.signals_through)
        .collect();
    let Some(newest) = fresh.last().map(|x| x.seq) else {
        return json!({"ok": false, "code": "signal-stale", "recorded": false});
    };
    // trusted observations that happened before the newest signal, in order
    let mut obs = Vec::new();
    let mut last_obs = s.observed_through;
    for o in &snap.activity {
        if o.generation == s.generation
            && o.seq > last_obs
            && o.seq < newest
            && !s.seen.contains(&o.execution_id)
            && !obs
                .iter()
                .any(|(_, id, _): &(Value, String, u32)| *id == o.execution_id)
        {
            last_obs = o.seq;
            obs.push((classification(&o.kind), o.execution_id.clone(), o.seq));
        }
    }
    let mut events: Vec<(u32, Value)> = obs
        .iter()
        .map(|(c, _, seq)| (*seq, json!({"type": "activity", "classification": c})))
        .collect();
    for x in &fresh {
        events.push((
            x.seq,
            json!({"type": "signal", "signal": x.signal, "dispatchKey": x.dispatch_key}),
        ));
    }
    events.sort_by_key(|(seq, _)| *seq);
    let args = json!({
        "museReasoning": s.reasoning,
        "museActivity": s.activity,
        "events": events.iter().map(|(_, e)| e.clone()).collect::<Vec<_>>(),
        "capabilities": snap.authorized_efforts,
        "resolve": false,
    });
    s.signals_through = newest;
    let result: Result<Value, BridgeError> = match &env.governor {
        Some(g) => g.call("evaluate", &args),
        None => Err(BridgeError {
            code: "bridge-unavailable".into(),
            message: String::new(),
        }),
    };
    match result {
        Ok(r)
            if valid_reasoning_block(&r["museReasoning"])
                && valid_activity_block(&r["museActivity"])
                && r["acks"].as_array().is_some_and(|a| a.len() == fresh.len()) =>
        {
            s.reasoning = Some(r["museReasoning"].clone());
            s.activity = Some(r["museActivity"].clone());
            s.observed_through = last_obs;
            if let Some(a) = s.adaptive.as_mut() {
                // trusted failures folded WITH the signal are still unjudged evidence
                let failed = obs
                    .iter()
                    .filter(|(c, _, _)| c["kind"] == "verification" && c["outcome"] == "failed")
                    .count() as u32;
                a.pending_trusted = a
                    .pending_trusted
                    .saturating_add(failed)
                    .min(MAX_PENDING_TRUSTED);
            }
            for (_, id, _) in obs {
                s.seen.push(id);
            }
            let excess = s.seen.len().saturating_sub(MAX_SEEN_EXECUTIONS);
            s.seen.drain(..excess);
            for a in r["acks"].as_array().unwrap() {
                if a["duplicate"] == true {
                    s.signals_duplicate += 1;
                } else {
                    s.signals_accepted += 1;
                }
            }
            r["acks"]
                .as_array()
                .unwrap()
                .last()
                .cloned()
                .unwrap_or(Value::Null)
        }
        other => {
            // nothing is applied; the model is told the signal was not recorded
            s.last_unapplied = fresh.iter().map(|x| x.seq).collect();
            let code = match other {
                Err(e) => e.code,
                Ok(_) => "bridge-output-invalid".into(),
            };
            json!({"ok": false, "code": code.chars().take(64).collect::<String>(), "recorded": false})
        }
    }
}

impl MuseV1 {
    fn propose_with(
        &self,
        hook: Hook,
        snap: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
        env: Option<&EngineEnv>,
    ) -> EngineProposal {
        let mut s = data(state).cloned().unwrap_or_default();
        if self.adaptive && s.adaptive.is_none() {
            s.adaptive = Some(Adaptive::default());
        }
        s.last_unapplied.clear();
        // the strategy: exactly muse-v0's decision on muse-v0's counters
        let v0 = MUSE_V0.propose(hook, snap, &v0_state(&s.v0, state), proposal_id);
        if let EngineStateData::MuseV0(next) = v0.next_state.data {
            s.v0 = next;
        }
        if hook == Hook::BeforeRequest {
            evaluate(
                &mut s,
                snap,
                env.unwrap_or(&EngineEnv::default()),
                self.adaptive,
            );
        }
        // SHADOW engines: never applied. The ACTIVE engine proposes only what its limiter decided
        // for THIS evaluation (the host re-derives and re-checks it before anything is committed).
        let effort = match (self.adaptive && hook == Hook::BeforeRequest)
            .then(|| s.history.last().and_then(|d| d.limiter.as_ref()))
            .flatten()
            .and_then(record_effort)
        {
            Some(level) => EffortProposal::Change(level),
            None => EffortProposal::KeepPinned,
        };
        EngineProposal {
            proposal_id,
            based_on_revision: state.revision,
            action: v0.action,
            effort,
            next_state: EngineState {
                engine_id: self.descriptor.engine_id,
                schema: self.descriptor.state_schema,
                revision: state.revision + 1,
                data: EngineStateData::MuseV1(s),
            },
        }
    }
}

impl EngineExtension for MuseV1 {
    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    fn initial_state(&self) -> EngineState {
        EngineState {
            engine_id: self.descriptor.engine_id,
            schema: self.descriptor.state_schema,
            revision: 0,
            data: EngineStateData::MuseV1(MuseV1State {
                adaptive: self.adaptive.then(Adaptive::default),
                ..MuseV1State::default()
            }),
        }
    }

    fn propose(
        &self,
        hook: Hook,
        snap: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
    ) -> EngineProposal {
        self.propose_with(hook, snap, state, proposal_id, None)
    }

    fn propose_in(
        &self,
        hook: Hook,
        snap: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
        env: &EngineEnv,
    ) -> EngineProposal {
        self.propose_with(hook, snap, state, proposal_id, Some(env))
    }

    fn propose_signal(
        &self,
        snap: &EngineSnapshot,
        state: &EngineState,
        proposal_id: u64,
        env: &EngineEnv,
    ) -> Option<EngineProposal> {
        if !self.signals {
            return None;
        }
        let mut s = data(state).cloned().unwrap_or_default();
        s.last_unapplied.clear();
        let ack = take_signals(&mut s, snap, env);
        Some(EngineProposal {
            proposal_id,
            based_on_revision: state.revision,
            action: EngineAction::Acknowledge(nexus_contracts::canonical_json(&ack)),
            effort: EffortProposal::KeepPinned,
            next_state: EngineState {
                engine_id: self.descriptor.engine_id,
                schema: self.descriptor.state_schema,
                revision: state.revision + 1,
                data: EngineStateData::MuseV1(s),
            },
        })
    }

    fn check_transition(
        &self,
        from: &EngineState,
        to: &EngineState,
        snap: &EngineSnapshot,
    ) -> Result<(), String> {
        let (Some(a), Some(b)) = (data(from), data(to)) else {
            return Err("state data of another engine".into());
        };
        MUSE_V0.check_transition(&v0_state(&a.v0, from), &v0_state(&b.v0, to), snap)?;
        // the generation the frontiers belong to
        let same_generation = a.generation == b.generation;
        if !same_generation && b.generation != snap.generation {
            return Err("the observation frontier may only move to the run's generation".into());
        }
        // EM-04B: the semantic state moves ONLY as the run's newly consumed, Core-validated signals
        // imply (historical transition, re-stated in `fold_signal`); without signals it is immutable
        let sfloor = if same_generation {
            a.signals_through
        } else {
            0
        };
        if !self.signals && b.signals_through != 0 && b.signals_through != a.signals_through {
            return Err("this engine takes no reasoning signals".into());
        }
        if b.signals_through < sfloor {
            return Err("the signal frontier never goes back".into());
        }
        let window: Vec<&SignalObservation> = snap
            .signals
            .iter()
            .filter(|x| {
                x.generation == b.generation && x.seq > sfloor && x.seq <= b.signals_through
            })
            .collect();
        if b.signals_through > sfloor && window.last().map(|x| x.seq) != Some(b.signals_through) {
            return Err("the signal frontier must follow the run's validated signals".into());
        }
        if b.last_unapplied
            .iter()
            .any(|q| !window.iter().any(|x| x.seq == *q))
        {
            return Err("only signals consumed now can be reported unapplied".into());
        }
        let mut expected = semantic_of(&a.reasoning);
        let mut applied = 0u32;
        for x in window.iter().filter(|x| !b.last_unapplied.contains(&x.seq)) {
            let (next, changed) = fold_signal(&expected, &x.signal, &x.dispatch_key);
            expected = next;
            applied += u32::from(changed);
        }
        if semantic_of(&b.reasoning) != expected {
            return Err(
                "the semantic Muse state can only change through a validated signal".into(),
            );
        }
        let consumed = (window.len() - b.last_unapplied.len()) as u32;
        if b.signals_accepted.checked_sub(a.signals_accepted) != Some(applied)
            || b.signals_duplicate.checked_sub(a.signals_duplicate) != Some(consumed - applied)
        {
            return Err("signal counters must follow the applied signals".into());
        }
        if let Some(r) = &b.reasoning {
            if !valid_reasoning_block(r) {
                return Err("invalid museReasoning block".into());
            }
        }
        if let Some(x) = &b.activity {
            if !valid_activity_block(x) {
                return Err("invalid museActivity block".into());
            }
        }
        // the observation frontier follows the Core's own feed
        let max_seq = snap
            .activity
            .iter()
            .filter(|o| o.generation == b.generation)
            .map(|o| o.seq)
            .max()
            .unwrap_or(0);
        let floor = if same_generation {
            a.observed_through
        } else {
            0
        };
        if b.observed_through < floor
            || (b.observed_through > floor && b.observed_through > max_seq)
        {
            return Err("the observation frontier must follow the run's receipts".into());
        }
        // activity evidence changes only by folding NEW observations (never by replay or narration)
        let advanced = b.observed_through > floor;
        // (an applied signal also writes the activity block: a phase re-baselines its frontier)
        if a.activity != b.activity && !advanced && applied == 0 {
            return Err("activity evidence changed without a new trusted observation".into());
        }
        let rev = |x: &Option<Value>| x.as_ref().and_then(|v| v["revision"].as_u64()).unwrap_or(0);
        if rev(&b.activity) < rev(&a.activity) {
            return Err("activity revisions never go back".into());
        }
        if b.seen.len() > MAX_SEEN_EXECUTIONS || b.history.len() > MAX_DECISION_HISTORY {
            return Err("shadow bookkeeping out of bounds".into());
        }
        // one evaluation at most, for the next attempt, and never an unauthorized proposal
        if b.evaluations != a.evaluations && b.evaluations != a.evaluations + 1 {
            return Err("at most one shadow evaluation per consultation".into());
        }
        if b.evaluations == a.evaluations && b.chain != a.chain {
            return Err("the decision chain moves only with an evaluation".into());
        }
        if b.evaluations == a.evaluations + 1 {
            let Some(d) = b.history.last() else {
                return Err("an evaluation must be recorded".into());
            };
            if b.chain != extend_chain(&a.chain, d) {
                return Err(
                    "the decision chain must extend the previous one by this decision".into(),
                );
            }
            if d.attempt != snap.attempts_dispatched + 1 || d.in_force != snap.current_effort {
                return Err("a shadow decision must describe the next attempt".into());
            }
            if let Some(e) = &d.governor_effort {
                if !MUSE_LADDER.contains(&e.as_str()) {
                    return Err("the Governor effort must be on the historical ladder".into());
                }
            }
            let would_ok = d.would == "keep"
                || d.would
                    .strip_prefix("change:")
                    .is_some_and(|e| snap.authorized_efforts.iter().any(|l| l == e));
            if !would_ok {
                return Err("a shadow proposal must stay within the authorized levels".into());
            }
        }
        // EM-04C2 S6: the limiter, its evidence baseline and its audit trail
        match (self.adaptive, &a.adaptive, &b.adaptive) {
            (false, None, None) => {
                if b.history.iter().any(|d| d.limiter.is_some()) {
                    return Err("this engine has no limiter".into());
                }
            }
            (true, Some(aa), Some(bb)) => {
                // the observations THIS transition folded, from the Core's own feed and the two
                // frontiers (never from the engine's claim)
                // SEC-4: one execution is one observation, however often the feed repeats it - the
                // same de-duplication `evaluate` applies, so the engine and the host cannot disagree
                let mut counted = std::collections::HashSet::new();
                let folded_failed = super::muse_v1_adaptive::failed_verifications(
                    snap.activity.iter().filter(|o| {
                        o.generation == b.generation
                            && o.seq > floor
                            && o.seq <= b.observed_through
                            && !a.seen.contains(&o.execution_id)
                            && counted.insert(o.execution_id.clone())
                    }),
                );
                let evaluated = b.evaluations == a.evaluations + 1;
                check_adaptive(
                    aa,
                    bb,
                    snap,
                    b.reasoning.as_ref(),
                    b.history.last(),
                    evaluated,
                    folded_failed,
                )?;
            }
            _ => return Err("adaptive state does not match the engine".into()),
        }
        Ok(())
    }

    fn check_effort(
        &self,
        from: &EngineState,
        to: &EngineState,
        effort: &EffortProposal,
        _snap: &EngineSnapshot,
    ) -> Result<(), String> {
        if !self.adaptive {
            return Ok(());
        }
        let (Some(a), Some(b)) = (data(from), data(to)) else {
            return Err("state data of another engine".into());
        };
        let expected = if b.evaluations == a.evaluations + 1 {
            b.history
                .last()
                .and_then(|d| d.limiter.as_ref())
                .and_then(record_effort)
        } else {
            None
        };
        match (effort, expected) {
            (EffortProposal::KeepPinned, None) => Ok(()),
            (EffortProposal::Change(l), Some(e)) if *l == e => Ok(()),
            _ => Err("the effort proposal is not the decision the limiter recorded".into()),
        }
    }

    fn effort_detail(&self, state: &EngineState) -> Option<String> {
        if !self.adaptive {
            return None;
        }
        let rec = data(state)?.history.last()?.limiter.as_ref()?;
        Some(format!("limiter:{}", rec.rule))
    }

    fn requires_sealed_request_budget(&self) -> bool {
        self.adaptive
    }

    fn persist_state(&self, state: &EngineState) -> Value {
        persisted(&data(state).cloned().unwrap_or_default())
    }

    /// A continuation inherits the cognitive state (semantic + activity blocks, shadow history);
    /// `muse-v0`'s strategy counters start over (as under `muse-v0`), the effort in force restarts
    /// at the default (EM-03 rule), so the historical `currentEffort` is cleared, and the
    /// observation frontier restarts with the new generation's own receipts.
    fn restore_state(&self, v: &Value, revision: u64) -> Option<EngineState> {
        self.restore(v, revision, None)
    }

    fn restore_state_in(
        &self,
        v: &Value,
        revision: u64,
        ctx: &RestoreContext,
    ) -> Option<EngineState> {
        self.restore(v, revision, Some(ctx))
    }
}

impl MuseV1 {
    /// A continuation inherits the cognitive state; `ctx` says what the interrupted run's effort
    /// was (the active engine accounts for the implicit reset, see `LimiterStateV2`).
    fn restore(
        &self,
        v: &Value,
        revision: u64,
        ctx: Option<&RestoreContext>,
    ) -> Option<EngineState> {
        let o = v.as_object()?;
        let allowed = [
            "v0",
            "museReasoning",
            "museActivity",
            "generation",
            "observedThrough",
            "seen",
            "evaluations",
            "history",
            "chain",
            "sourcesDigest",
        ];
        // EM-04B keys (absent in EM-04A payloads: read as zero)
        let optional = [
            "signalsThrough",
            "signalsAccepted",
            "signalsDuplicate",
            "lastUnapplied",
        ];
        if o.keys().any(|k| {
            !allowed.contains(&k.as_str())
                && !optional.contains(&k.as_str())
                && !(self.adaptive && k == "adaptive")
        }) || allowed.iter().any(|k| !o.contains_key(*k))
        {
            return None;
        }
        // the active engine's payload is versioned and complete; every other engine has none
        if self.adaptive != o.contains_key("adaptive") {
            return None;
        }
        let count = |k: &str| -> Option<u32> {
            match o.get(k) {
                None => Some(0),
                Some(v) => u32::try_from(v.as_u64()?).ok(),
            }
        };
        let signals_accepted = count("signalsAccepted")?;
        let signals_duplicate = count("signalsDuplicate")?;
        count("signalsThrough")?;
        if let Some(l) = o.get("lastUnapplied") {
            if l.as_array().is_none_or(|a| a.len() > 64) {
                return None;
            }
        }
        let mut reasoning = match o.get("museReasoning")? {
            Value::Null => None,
            r if valid_reasoning_block(r) => Some(r.clone()),
            _ => return None,
        };
        if let Some(Value::Object(r)) = reasoning.as_mut() {
            r.insert("currentEffort".into(), Value::Null);
        }
        let activity = match o.get("museActivity")? {
            Value::Null => None,
            x if valid_activity_block(x) => Some(x.clone()),
            _ => return None,
        };
        let seen: Vec<String> = o
            .get("seen")?
            .as_array()?
            .iter()
            .map(|x| x.as_str().filter(|s| s.len() <= 128).map(str::to_owned))
            .collect::<Option<_>>()?;
        let history: Vec<ShadowDecision> = o
            .get("history")?
            .as_array()?
            .iter()
            .map(|d| decision_from(d, self.adaptive))
            .collect::<Option<_>>()?;
        if seen.len() > MAX_SEEN_EXECUTIONS || history.len() > MAX_DECISION_HISTORY {
            return None;
        }
        let chain = o.get("chain")?.as_str()?;
        if !(chain.is_empty() || chain.len() == 64 && chain.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return None;
        }
        o.get("generation")?.as_str()?;
        o.get("observedThrough")?.as_u64()?;
        o.get("v0")?.as_object()?;
        let adaptive = if self.adaptive {
            let a = Adaptive::from_value(o.get("adaptive")?)?;
            // the baseline is a past view of the Governor's totals: it can never be ahead of them
            let totals =
                super::effort_limiter::EvidenceBaseline::from_reasoning(reasoning.as_ref())
                    .ok()?
                    .total_failures;
            if a.baseline.total_failures > totals {
                return None;
            }
            // the continuation: budget and drop history are per logical task and are kept; an
            // elevated effort silently reset to the default is itself a drop (policy V2)
            let limiter = match ctx.and_then(|c| c.effort_in_force.as_deref().map(|e| (e, c))) {
                Some((e, c)) => match (Level::parse(e), Level::parse(&c.default_effort)) {
                    (Some(e), Some(d)) => a.limiter.continued_after_reset(e, d),
                    _ => {
                        // an effort that cannot be compared is treated as a drop (fail closed)
                        let mut l = a.limiter.continued();
                        l.dropped_before = true;
                        l
                    }
                },
                None => a.limiter.continued(),
            };
            Some(Adaptive { limiter, ..a })
        } else {
            None
        };
        Some(EngineState {
            engine_id: self.descriptor.engine_id,
            schema: self.descriptor.state_schema,
            revision,
            data: EngineStateData::MuseV1(MuseV1State {
                v0: MuseV0State::default(),
                reasoning,
                activity,
                generation: String::new(),
                observed_through: 0,
                seen,
                evaluations: u32::try_from(o.get("evaluations")?.as_u64()?).ok()?,
                history,
                chain: chain.to_owned(),
                // a new generation consumes its own signals from seq 1
                signals_through: 0,
                signals_accepted,
                signals_duplicate,
                last_unapplied: Vec::new(),
                adaptive,
            }),
        })
    }
}
