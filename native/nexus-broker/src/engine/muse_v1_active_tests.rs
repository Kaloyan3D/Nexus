//! EM-04C2 S6: the ACTIVE `nexus-adaptive-v1` engine, driven through the real durable EM-03 machinery
//! (`EngineRun`: host admission, HMAC-protected record, write-ahead attempt binding, continuation
//! with `examine_predecessor`) and the REAL, unchanged historical Governor (through the Node
//! worker). No provider, no Registry, no network: those layers are covered by the end-to-end suite
//! in `tests/code_a56.rs`.
//!
//! What is proven here:
//! * the engine path reproduces the pinned S5 results trace by trace (Governor -> clamp ->
//!   Policy V2 -> proposal -> host admission -> durable selection);
//! * every durable state is re-derived by the host (limiter, baseline, trusted evidence, flag);
//! * forged proposals and states are refused and nothing is committed;
//! * a worker failure never bypasses the limiter; evidence is not lost, replayed or double-counted;
//! * continuations inherit the budget and the drop history, and an implicit reset is a drop;
//! * the complete Governor answer, not its eight-entry audit copy, decides `strong_escalation`.

use super::anti_thrash_review::{trace_scenarios, TStep};
use super::effort_limiter::REARM_TOKENS;
use super::governor_bridge::{BridgeError, GovernorEvaluator};
use super::muse_v1::{MuseV1State, ACTIVE_ENGINE_ID, ADAPTIVE_MODE_ID, MUSE_V1_ACTIVE};
use super::muse_v1_adaptive::*;
use super::worker_bridge::test_evaluator;
use super::*;
use crate::engine_state::{EngineRun, EngineStateStore, Predecessor, StateError};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const FIXTURE: &str = include_str!("../../tests/fixtures/em04c2-governor-traces.json");

fn have_node() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

macro_rules! need_node {
    () => {
        if !have_node() {
            eprintln!("node unavailable: skipped");
            return;
        }
    };
}

/// One logical task driven through successive generations.
struct Drive {
    dir: tempfile::TempDir,
    run: EngineRun,
    gen_no: u32,
    dispatched: u32,
    seq: u32,
    activity: Vec<ActivityObservation>,
    signals: Vec<SignalObservation>,
    auth: Vec<String>,
    evaluator: Arc<dyn GovernorEvaluator>,
    /// effort used by every attempt of the whole task, in order
    used: Vec<String>,
}

fn levels(l: &[&str]) -> Vec<String> {
    l.iter().map(|x| (*x).to_owned()).collect()
}

impl Drive {
    fn new(auth: &[&str]) -> Self {
        Self::with_evaluator(auth, test_evaluator("node".into()))
    }

    fn with_evaluator(auth: &[&str], evaluator: Arc<dyn GovernorEvaluator>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut run = start(dir.path(), 1, None);
        run.env.governor = Some(Arc::clone(&evaluator));
        Drive {
            dir,
            run,
            gen_no: 1,
            dispatched: 0,
            seq: 0,
            activity: vec![],
            signals: vec![],
            auth: levels(auth),
            evaluator,
            used: vec![],
        }
    }

    fn generation(&self) -> String {
        format!("task-{}", self.gen_no)
    }

    fn snap(&self) -> EngineSnapshot {
        EngineSnapshot {
            kind: Some(RunKind::Code),
            interactive: true,
            attempts_dispatched: self.dispatched,
            current_effort: self
                .run
                .host
                .effort_for_attempt(self.dispatched + 1)
                .unwrap_or("low")
                .to_owned(),
            authorized_efforts: self.auth.clone(),
            generation: self.generation(),
            activity: self.activity.clone(),
            signals: self.signals.clone(),
            ..Default::default()
        }
    }

    /// A model signal consulted at once (as the broker does after each tool call).
    fn signal(&mut self, signal: Value) -> Value {
        self.seq += 1;
        let g = self.generation();
        let call = format!("call_{}", self.seq);
        let attempt = self.dispatched + 1;
        self.signals.push(SignalObservation {
            seq: self.seq,
            attempt,
            generation: g.clone(),
            dispatch_key: crate::signals::dispatch_key(&g, attempt, &call, &signal),
            call_id: call,
            signal,
        });
        let ack = self.run.consult_signal(&self.snap()).expect("signal");
        serde_json::from_str(&ack).unwrap()
    }

    /// A Kernel-backed fact: `mutation` | `fail` | `pass` | `started`.
    fn act(&mut self, kind: &str) {
        self.seq += 1;
        self.activity.push(ActivityObservation {
            seq: self.seq,
            attempt: self.dispatched + 1,
            generation: self.generation(),
            execution_id: format!("exec-{}-{}", self.gen_no, self.seq),
            kind: match kind {
                "mutation" => ObservationKind::Mutation,
                "fail" | "pass" | "started" => ObservationKind::Verification {
                    outcome: match kind {
                        "fail" => VerificationOutcome::Failed,
                        "pass" => VerificationOutcome::Passed,
                        _ => VerificationOutcome::Started,
                    },
                    family: "cargo".into(),
                },
                other => panic!("unknown activity {other}"),
            },
        });
    }

    /// One model attempt: consult at BeforeRequest, make a change durable, bind, dispatch.
    fn try_attempt(&mut self) -> Result<String, StateError> {
        let n = self.dispatched + 1;
        let snap = self.snap();
        self.run.consult(Hook::BeforeRequest, &snap)?;
        let eff = self
            .run
            .host
            .effort_for_attempt(n)
            .unwrap_or("low")
            .to_owned();
        self.run.bind_attempt(
            n,
            &format!("att-{}-{n}", self.gen_no),
            &eff,
            "issuance",
            "ext",
        )?;
        self.dispatched += 1;
        self.used.push(eff.clone());
        Ok(eff)
    }

    fn attempt(&mut self) -> String {
        self.try_attempt().expect("attempt")
    }

    /// An interruption and a continuation: a NEW task generation, the interrupted record's payload
    /// inherited through the real `examine_predecessor`/`restore_state_in` path.
    fn interrupt(&mut self) {
        let prev = self.gen_no;
        self.gen_no += 1;
        self.run = start(self.dir.path(), self.gen_no, Some(prev));
        self.run.env.governor = Some(Arc::clone(&self.evaluator));
        self.dispatched = 0;
        self.seq = 0;
        self.activity.clear();
        self.signals.clear();
    }

    fn state(&self) -> &MuseV1State {
        st(&self.run.host)
    }

    fn adaptive(&self) -> Adaptive {
        self.state().adaptive.expect("adaptive state")
    }

    fn selections(&self) -> Vec<(Option<u32>, String, Option<String>)> {
        self.run
            .rec
            .events
            .iter()
            .filter(|e| e.kind == "effort-selected")
            .map(|e| (e.attempt, e.effort.clone().unwrap(), e.detail.clone()))
            .collect()
    }

    /// Run a scenario script of the S5 trace generator against the engine.
    fn script(&mut self, steps: &[TStep]) -> Vec<String> {
        let mut applied = Vec::new();
        for s in steps {
            match s {
                TStep::Sig(v) => {
                    let ack = self.signal(v.clone());
                    assert_eq!(ack["ok"], true, "{ack}");
                }
                TStep::Act(k) => self.act(k),
                TStep::Res => applied.push(self.attempt()),
                TStep::Restart => unreachable!("restart-bearing traces are driven separately"),
            }
        }
        applied
    }
}

fn start(dir: &std::path::Path, gen_no: u32, prev: Option<u32>) -> EngineRun {
    EngineRun::start(
        EngineStateStore::open(dir).unwrap(),
        &MUSE_V1_ACTIVE,
        &format!("run_task-{gen_no}"),
        &format!("task-{gen_no}"),
        ADAPTIVE_MODE_ID,
        &"b".repeat(64),
        "low",
        prev.map(|p| Predecessor::new(format!("run_task-{p}"), Some(format!("task-{p}")))),
    )
    .expect("start")
}

fn st(h: &EngineHost) -> &MuseV1State {
    match &h.state().data {
        EngineStateData::MuseV1(d) => d,
        _ => panic!("not a nexus-adaptive-v1 state"),
    }
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

// ---------------------------------------------------------------------------------------------
// identity and gating
// ---------------------------------------------------------------------------------------------

#[test]
fn the_active_engine_has_the_reserved_identity_one_mode_and_the_gates() {
    let d = MUSE_V1_ACTIVE.descriptor();
    assert_eq!(
        (d.engine_id, d.mode_ids),
        ("nexus-adaptive-v1", &["engineering-v2-adaptive"][..])
    );
    assert_eq!(d.roles, &["muse_main"]);
    assert_eq!(
        d.state_schema, 2,
        "a new schema: the shadow/signals engines stay at 1"
    );
    assert_eq!(d.contract_version, ENGINE_CONTRACT_VERSION);
    assert!(d.may_propose_effort && d.inherits_state);
    assert_eq!(
        d.request_reserve_bytes, 0,
        "the signals tool is in the measured catalog"
    );
    assert!(MUSE_V1_ACTIVE.requires_sealed_request_budget());
    for other in [
        &super::muse_v0::MUSE_V0 as &dyn EngineExtension,
        &super::muse_v1::MUSE_V1,
        &super::muse_v1::MUSE_V1_SIGNALS,
    ] {
        assert!(!other.requires_sealed_request_budget());
        assert!(!other.descriptor().may_propose_effort);
        assert_ne!(
            other.descriptor().state_schema,
            2,
            "{}",
            other.descriptor().engine_id
        );
    }
    assert_eq!(ACTIVE_ENGINE_ID, "nexus-adaptive-v1");
}

#[test]
fn the_production_gate_registers_only_muse_v1_and_only_when_opened() {
    let ids = |test_build, enabled| -> Vec<&'static str> {
        engines_with(test_build, enabled)
            .iter()
            .map(|e| e.descriptor().engine_id)
            .collect()
    };
    // the production build since S10-A: exactly these two, never an experimental engine
    assert_eq!(
        ids(false, MUSE_V1_PRODUCTION_ENABLED),
        ["muse-v0", "muse-v0-jobs", "nexus-adaptive-v1"]
    );
    // with the gate closed (the rollback state) the default pair remains (M7D's jobs engine
    // is not part of the adaptive gate)
    assert_eq!(ids(false, false), ["muse-v0", "muse-v0-jobs"]);
    assert_eq!(
        ids(false, true),
        ["muse-v0", "muse-v0-jobs", "nexus-adaptive-v1"]
    );
    // test builds also carry the experimental engines
    let t = ids(true, false);
    for want in [
        "muse-v0",
        "nexus-adaptive-v1",
        "muse-v1-shadow",
        "muse-v1-signals",
    ] {
        assert!(t.contains(&want), "{want} in {t:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// the engine reproduces the pinned S5 traces
// ---------------------------------------------------------------------------------------------

#[test]
fn the_engine_reproduces_every_pinned_s5_trace_through_the_whole_durable_path() {
    need_node!();
    let fx = fixture();
    let pinned = fx["traces"].as_array().unwrap();
    for (id, name, steps) in trace_scenarios() {
        if steps.iter().any(|s| matches!(s, TStep::Restart)) {
            continue; // P4: continuation semantics are Policy V2's, tested separately below
        }
        let want = pinned.iter().find(|t| t["id"] == id).unwrap();
        let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
        let applied = d.script(&steps);
        let expected: Vec<String> = want["l3"]["applied"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(applied, expected, "{id} ({name}): engine vs pinned L3");
        // one durable selection per applied change, each explained by its limiter rule
        let sel = d.selections();
        assert_eq!(
            sel.len(),
            want["l3"]["changes"].as_u64().unwrap() as usize,
            "{id}"
        );
        assert!(
            sel.iter()
                .all(|(_, _, detail)| detail.as_deref().is_some_and(|x| x.starts_with("limiter:"))),
            "{id}: {sel:?}"
        );
        // the history records the rule of every judged attempt
        let rules: Vec<String> = want["l3"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect();
        let recorded: Vec<String> = d
            .state()
            .history
            .iter()
            .filter_map(|x| x.limiter.as_ref().map(|l| l.rule.clone()))
            .collect();
        let tail = &rules[rules.len().saturating_sub(recorded.len())..];
        assert_eq!(recorded, tail, "{id}: retained rules");
        println!(
            "ENGINE {id}: {} attempts, {} durable selections, final {}",
            applied.len(),
            sel.len(),
            applied.last().unwrap()
        );
    }
}

#[test]
fn a1_phase_flapping_is_bounded_to_one_durable_selection() {
    need_node!();
    let (_, _, steps) = trace_scenarios().into_iter().find(|t| t.0 == "A1").unwrap();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    let applied = d.script(&steps);
    assert_eq!(applied.len(), 24);
    assert_eq!(
        d.selections().len(),
        1,
        "24 flips of the Governor, one durable change"
    );
    assert!(
        d.run
            .rec
            .events
            .iter()
            .filter(|e| e.kind == "effort-selected")
            .count()
            <= 1
    );
    assert_eq!(
        d.run.rec.attempts.len(),
        24,
        "every attempt is bound before dispatch"
    );
}

// ---------------------------------------------------------------------------------------------
// continuations: the budget is per logical task
// ---------------------------------------------------------------------------------------------

fn escalate_in_this_generation(d: &mut Drive) -> String {
    // two hypothesis failures claim the strong escalation; the attempt judges it
    d.signal(json!({"recordHypothesisFailure": true}));
    d.signal(json!({"recordHypothesisFailure": true}));
    d.attempt()
}

#[test]
fn a4_claim_only_re_arming_is_bounded_across_generations() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    let mut xhigh_selections = 0;
    let mut efforts = Vec::new();
    for generation in 1..=8 {
        let e = escalate_in_this_generation(&mut d);
        efforts.push(e.clone());
        if e == "xhigh" {
            xhigh_selections += 1;
        }
        // the generation is interrupted while at the elevated effort (when it has one)
        let tokens = d.adaptive().limiter.core.rearm_tokens_used;
        assert!(tokens <= REARM_TOKENS, "generation {generation}");
        d.interrupt();
    }
    // 1 free (the first strong escalation of the task) + R tokens, then holds; the claims never
    // stop being made (the inherited Governor block keeps asking for xhigh)
    assert_eq!(
        xhigh_selections,
        1 + usize::from(REARM_TOKENS),
        "{efforts:?}"
    );
    assert_eq!(&efforts[..3], ["xhigh", "xhigh", "xhigh"]);
    assert!(efforts[3..].iter().all(|e| e != "xhigh"), "{efforts:?}");
    let a = d.adaptive();
    assert!(a.limiter.dropped_before);
    assert_eq!(a.limiter.core.rearm_tokens_used, REARM_TOKENS);
}

#[test]
fn fresh_kernel_verified_failures_are_not_blocked_after_the_budget_is_spent() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    for _ in 0..6 {
        escalate_in_this_generation(&mut d);
        d.interrupt();
    }
    // spent: the claims alone are held
    let held = escalate_in_this_generation(&mut d);
    assert_ne!(held, "xhigh");
    d.interrupt();
    // a Kernel-verified failed check in this generation: the same claims escalate immediately
    d.act("fail");
    let e = escalate_in_this_generation(&mut d);
    assert_eq!(
        e, "xhigh",
        "trusted evidence bypasses the claim-only budget"
    );
    assert_eq!(
        d.adaptive().limiter.core.rearm_tokens_used,
        REARM_TOKENS,
        "budget untouched"
    );
}

#[test]
fn a_trusted_failure_folded_by_the_signal_path_still_counts_as_evidence() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    for _ in 0..6 {
        escalate_in_this_generation(&mut d);
        d.interrupt();
    }
    // the failed check happens BEFORE the model's signals: the signal consultation folds it (a
    // trusted observation made before the newest signal is folded with it), so the next
    // evaluation finds nothing "fresh" - the persisted pending evidence is what carries it
    d.act("fail");
    d.signal(json!({"recordHypothesisFailure": true}));
    assert_eq!(
        d.adaptive().pending_trusted,
        1,
        "folded by the signal path, not yet judged"
    );
    d.signal(json!({"recordHypothesisFailure": true}));
    let e = d.attempt();
    assert_eq!(e, "xhigh");
    assert_eq!(d.adaptive().pending_trusted, 0, "judged and consumed");
    // a model signal NEVER creates trusted evidence
    let mut m = Drive::new(&["low", "medium", "high", "xhigh"]);
    for _ in 0..6 {
        escalate_in_this_generation(&mut m);
        m.interrupt();
    }
    m.signal(json!({"recordHypothesisFailure": true, "recordImplementationFailure": true}));
    m.signal(json!({"recordHypothesisFailure": true}));
    assert_eq!(m.adaptive().pending_trusted, 0);
    assert_ne!(m.attempt(), "xhigh");
}

#[test]
fn default_only_authorization_never_changes_the_effort() {
    need_node!();
    let mut d = Drive::new(&["low"]);
    for step in 0..12 {
        match step % 3 {
            0 => {
                d.signal(json!({"recordHypothesisFailure": true}));
            }
            1 => d.act("fail"),
            _ => {
                d.signal(json!({"conflictingEvidence": true}));
            }
        }
        assert_eq!(d.attempt(), "low");
    }
    assert!(d.selections().is_empty());
    assert!(d.run.host.effort_selection().is_none());
    assert!(d
        .state()
        .history
        .iter()
        .all(|h| h.outcome == "capability-unavailable" && h.limiter.is_none()));
    // the limiter never ran: its state is the initial one (trusted evidence merely pending)
    assert_eq!(
        d.adaptive().limiter,
        super::effort_limiter::LimiterStateV2::new()
    );
}

#[test]
fn an_implicit_reset_is_a_drop_recorded_in_the_continuation() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    assert_eq!(escalate_in_this_generation(&mut d), "xhigh");
    assert!(
        !d.adaptive().limiter.dropped_before,
        "no drop inside the generation"
    );
    d.interrupt();
    let a = d.adaptive();
    assert!(
        a.limiter.dropped_before,
        "the reset of xhigh to low is a drop"
    );
    assert_eq!(a.limiter.core.last_attempt, 0);
    assert_eq!(a.limiter.core.last_down_attempt, None);
    assert!(
        d.run
            .rec
            .events
            .iter()
            .any(|e| e.kind == "effort-reset-continuation"),
        "the existing EM-03 note is still written"
    );
    // an interruption that never elevated anything is not a drop
    let mut n = Drive::new(&["low", "medium", "high", "xhigh"]);
    n.interrupt();
    assert!(!n.adaptive().limiter.dropped_before);
}

// ---------------------------------------------------------------------------------------------
// F-3: the complete Governor result
// ---------------------------------------------------------------------------------------------

type Rewrite = Box<dyn FnMut(&mut Value) + Send>;

/// Wraps the real Governor and rewrites its answer (hostile bridge).
struct Tamper {
    inner: Arc<dyn GovernorEvaluator>,
    how: Mutex<Rewrite>,
    calls: Mutex<u32>,
}

impl GovernorEvaluator for Tamper {
    fn call(&self, op: &str, args: &Value) -> Result<Value, BridgeError> {
        let mut r = self.inner.call(op, args)?;
        if op == "evaluate" && args["resolve"] == true {
            *self.calls.lock().unwrap() += 1;
            (self.how.lock().unwrap())(&mut r);
        }
        Ok(r)
    }
}

fn tampered(how: impl FnMut(&mut Value) + Send + 'static) -> Drive {
    let e: Arc<dyn GovernorEvaluator> = Arc::new(Tamper {
        inner: test_evaluator("node".into()),
        how: Mutex::new(Box::new(how)),
        calls: Mutex::new(0),
    });
    Drive::with_evaluator(&["low", "medium", "high", "xhigh"], e)
}

#[test]
fn an_escalation_entry_beyond_the_eighth_position_still_counts() {
    need_node!();
    // 12 harmless entries before the real `escalation:` entry (the audit copy keeps only 8)
    let mut d = tampered(|r| {
        let t = r["decision"]["trace"].as_array_mut().unwrap();
        let real = t.clone();
        t.clear();
        for i in 0..12 {
            t.push(json!(format!("phase:filler{i}->medium")));
        }
        t.extend(real);
    });
    d.signal(json!({"recordHypothesisFailure": true}));
    d.signal(json!({"recordHypothesisFailure": true}));
    // the first strong escalation of a task is immediate: only a TRUE strong flag can make a
    // later claim-only re-arm cost a token, so first prove the flag itself through the record
    let e = d.attempt();
    assert_eq!(e, "xhigh");
    let last = d.state().history.last().unwrap();
    assert_eq!(last.trace.len(), 8, "the audit trace is truncated");
    assert!(
        !last.trace.iter().any(|t| t.starts_with("escalation")),
        "the escalation entry is NOT in the audit copy: {:?}",
        last.trace
    );
    let rec = last.limiter.as_ref().unwrap();
    assert!(rec.strong, "but the limiter saw it in the complete trace");
    assert_eq!(rec.trace_len, 15);
    // and the retained flag survives persistence and restoration unchanged
    let payload = MUSE_V1_ACTIVE.persist_state(d.run.host.state());
    let back = MUSE_V1_ACTIVE.restore_state(&payload, 0).expect("restores");
    let EngineStateData::MuseV1(b) = back.data else {
        panic!()
    };
    assert!(b.history.last().unwrap().limiter.as_ref().unwrap().strong);
    assert_eq!(b.history.last().unwrap().trace.len(), 8);
}

#[test]
fn a_malformed_or_forged_governor_answer_is_rejected_whole() {
    need_node!();
    type Tamperer = Box<dyn Fn(&mut Value) + Send + Sync>;
    let cases: Vec<(&str, Tamperer)> = vec![
        (
            "trace longer than its bound",
            Box::new(|r| {
                let t = r["decision"]["trace"].as_array_mut().unwrap();
                for i in 0..40 {
                    t.push(json!(format!("x{i}")));
                }
            }),
        ),
        (
            "an oversized entry",
            Box::new(|r| {
                r["decision"]["trace"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("y".repeat(600)));
            }),
        ),
        (
            "a non-string entry",
            Box::new(|r| {
                r["decision"]["trace"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"escalation": true}));
            }),
        ),
        (
            "a trace that is not an array",
            Box::new(|r| {
                r["decision"]["trace"] = json!("escalation:[x]->xhigh");
            }),
        ),
        (
            "an escalation entry the Governor's own condition does not justify",
            Box::new(|r| {
                r["decision"]["trace"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("escalation:[forged]->xhigh"));
            }),
        ),
        (
            "an escalation hidden from the trace",
            Box::new(|r| {
                let t = r["decision"]["trace"].as_array_mut().unwrap();
                t.retain(|x| !x.as_str().unwrap().starts_with("escalation"));
            }),
        ),
    ];
    for (why, how) in cases {
        let mut d = tampered(move |r| how(r));
        d.signal(json!({"recordHypothesisFailure": true}));
        // a forged escalation entry is only a lie when the block is NOT escalated (one failure)
        if !why.starts_with("an escalation entry the Governor's own") {
            d.signal(json!({"recordHypothesisFailure": true}));
        }
        let before_adaptive = d.adaptive();
        let e = d.attempt();
        assert_eq!(e, "low", "{why}: no change on an invalid answer");
        let last = d.state().history.last().unwrap();
        assert_eq!(last.outcome, "bridge-output-invalid", "{why}");
        assert!(last.limiter.is_none(), "{why}");
        assert_eq!(
            d.adaptive(),
            before_adaptive,
            "{why}: nothing judged, nothing consumed"
        );
        assert!(d.selections().is_empty(), "{why}");
    }
}

// ---------------------------------------------------------------------------------------------
// worker failure, replay, persistence
// ---------------------------------------------------------------------------------------------

/// Fails `evaluate(resolve)` for the first `n` calls, then delegates.
struct FailFirst {
    inner: Arc<dyn GovernorEvaluator>,
    left: Mutex<u32>,
    code: &'static str,
}

impl GovernorEvaluator for FailFirst {
    fn call(&self, op: &str, args: &Value) -> Result<Value, BridgeError> {
        if op == "evaluate" && args["resolve"] == true {
            let mut l = self.left.lock().unwrap();
            if *l > 0 {
                *l -= 1;
                return Err(BridgeError {
                    code: self.code.into(),
                    message: "injected".into(),
                });
            }
        }
        self.inner.call(op, args)
    }
}

#[test]
fn a_failing_worker_never_bypasses_the_limiter_and_loses_no_evidence() {
    need_node!();
    for code in [
        "bridge-timeout",
        "bridge-died",
        "bridge-unavailable",
        "bridge-busy",
    ] {
        let e: Arc<dyn GovernorEvaluator> = Arc::new(FailFirst {
            inner: test_evaluator("node".into()),
            left: Mutex::new(3),
            code,
        });
        let mut d = Drive::with_evaluator(&["low", "medium", "high", "xhigh"], e);
        d.signal(json!({"recordHypothesisFailure": true}));
        d.signal(json!({"recordHypothesisFailure": true}));
        d.act("fail");
        let before = d.adaptive();
        for _ in 0..3 {
            assert_eq!(d.attempt(), "low", "{code}: the effort stays pinned");
            assert_eq!(d.state().history.last().unwrap().outcome, code);
            assert_eq!(
                d.adaptive(),
                before,
                "{code}: limiter, baseline and evidence untouched"
            );
        }
        assert!(d.selections().is_empty());
        // recovered: the SAME claims and the SAME failed check are judged now (not lost)
        assert_eq!(d.attempt(), "xhigh", "{code}");
        let rec = d.state().history.last().unwrap().limiter.clone().unwrap();
        assert_eq!(
            (rec.claims, rec.trusted, rec.strong),
            (2, 1, true),
            "{code}"
        );
        assert_eq!(d.selections().len(), 1);
    }
}

#[test]
fn a_replayed_attempt_is_judged_once_and_consumes_no_evidence() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    d.signal(json!({"recordHypothesisFailure": true}));
    d.signal(json!({"recordHypothesisFailure": true}));
    // consult the SAME attempt twice (a retried preparation before dispatch)
    let snap = d.snap();
    d.run.consult(Hook::BeforeRequest, &snap).unwrap();
    assert_eq!(d.selections().len(), 1);
    d.act("fail");
    d.signal(json!({"recordImplementationFailure": true}));
    let snap2 = d.snap();
    let selected = d.run.host.effort_selection().cloned();
    d.run.consult(Hook::BeforeRequest, &snap2).unwrap();
    let a = d.adaptive();
    let rec = d.state().history.last().unwrap().limiter.clone().unwrap();
    assert_eq!(rec.rule, "replay-guard");
    assert_eq!(
        d.run.host.effort_selection(),
        selected.as_ref(),
        "no second selection"
    );
    assert_eq!(d.selections().len(), 1);
    // the evidence of the replayed consultation is still pending, judged by the next attempt
    assert!(a.pending_trusted >= 1, "{a:?}");
    assert_eq!(
        a.baseline.total_failures, 2,
        "baseline not advanced by the replay"
    );
    d.run
        .bind_attempt(1, "att-1", "xhigh", "issuance", "ext")
        .unwrap();
    d.dispatched = 1;
    d.attempt();
    let rec = d.state().history.last().unwrap().limiter.clone().unwrap();
    assert_eq!(
        (rec.claims, rec.trusted),
        (1, 1),
        "judged exactly once, here"
    );
    assert_eq!(d.adaptive().baseline.total_failures, 3);
}

#[test]
fn the_baseline_and_limiter_survive_persistence_and_continuation_together() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    escalate_in_this_generation(&mut d);
    d.signal(json!({"recordImplementationFailure": true})); // an unjudged claim after the last evaluation
    let before = d.adaptive();
    // durable form: one payload, one revision, the limiter and the baseline together
    let loaded = EngineStateStore::open(d.dir.path())
        .unwrap()
        .load("task-1")
        .unwrap()
        .unwrap();
    let a = Adaptive::from_value(&loaded.payload["adaptive"]).expect("durable adaptive state");
    assert_eq!(a.limiter.core.last_attempt, 1);
    assert_eq!(a.baseline.total_failures, 2);
    assert_eq!(loaded.state_schema, 2);
    assert_eq!(loaded.payload["adaptive"]["policyVersion"], 2);
    d.interrupt();
    let c = d.adaptive();
    assert_eq!(
        c.baseline, before.baseline,
        "the baseline is inherited as it was last JUDGED"
    );
    assert_eq!(c.pending_trusted, before.pending_trusted);
    // so the claim made after the last evaluation is still new evidence for the next one
    d.attempt();
    let rec = d.state().history.last().unwrap().limiter.clone().unwrap();
    assert!(rec.claims >= 1, "{rec:?}");
}

#[test]
fn unversioned_or_foreign_adaptive_payloads_are_refused() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    escalate_in_this_generation(&mut d);
    let good = MUSE_V1_ACTIVE.persist_state(d.run.host.state());
    let ctx = RestoreContext {
        effort_in_force: Some("xhigh".into()),
        default_effort: "low".into(),
    };
    assert!(MUSE_V1_ACTIVE.restore_state_in(&good, 0, &ctx).is_some());
    let bad = |f: &dyn Fn(&mut Value)| {
        let mut p = good.clone();
        f(&mut p);
        MUSE_V1_ACTIVE.restore_state_in(&p, 0, &ctx).is_none()
    };
    assert!(
        bad(&|p| {
            p.as_object_mut().unwrap().remove("adaptive");
        }),
        "unversioned (no adaptive block)"
    );
    assert!(
        bad(&|p| p["adaptive"]["policyVersion"] = json!(1)),
        "policy 1"
    );
    assert!(
        bad(&|p| p["adaptive"]["policyVersion"] = json!(3)),
        "policy 3"
    );
    assert!(
        bad(&|p| p["adaptive"]["policyVersion"] = json!("2")),
        "policy as text"
    );
    assert!(bad(&|p| p["adaptive"]["extra"] = json!(1)), "unknown key");
    assert!(
        bad(&|p| p["adaptive"]["limiter"]["droppedBefore"] = json!(null)),
        "flag type"
    );
    assert!(
        bad(&|p| p["adaptive"]["limiter"]["rearmTokensUsed"] = json!(3)),
        "tokens beyond R"
    );
    assert!(
        bad(&|p| p["adaptive"]["baseline"]["totalFailures"] = json!(9_999)),
        "baseline ahead of the Governor"
    );
    assert!(
        bad(&|p| p["adaptive"]["pendingTrusted"] = json!(1_001)),
        "pending beyond bound"
    );
    assert!(
        bad(&|p| p["history"][0]["limiter"]["policy"] = json!(1)),
        "record of policy 1"
    );
    assert!(
        bad(&|p| p["history"][0]["limiter"]["rule"] = json!("anything")),
        "unknown rule"
    );
    assert!(
        bad(&|p| p["history"][0]["limiter"]["action"] = json!("change:max")),
        "max"
    );
    // the other engines never accept an adaptive block, nor the active engine a payload without one
    for other in [
        &super::muse_v1::MUSE_V1 as &dyn EngineExtension,
        &super::muse_v1::MUSE_V1_SIGNALS,
    ] {
        assert!(
            other.restore_state(&good, 0).is_none(),
            "{}",
            other.descriptor().engine_id
        );
    }
    let shadow = super::muse_v1::MUSE_V1_SIGNALS
        .persist_state(&super::muse_v1::MUSE_V1_SIGNALS.initial_state());
    assert!(MUSE_V1_ACTIVE.restore_state_in(&shadow, 0, &ctx).is_none());
    // an effort that cannot be compared is treated as a drop (fail closed)
    let weird = RestoreContext {
        effort_in_force: Some("ultra".into()),
        default_effort: "low".into(),
    };
    let EngineStateData::MuseV1(w) = MUSE_V1_ACTIVE
        .restore_state_in(&good, 0, &weird)
        .unwrap()
        .data
    else {
        panic!()
    };
    assert!(w.adaptive.unwrap().limiter.dropped_before);
}

// ---------------------------------------------------------------------------------------------
// host-side validation: forged proposals and states
// ---------------------------------------------------------------------------------------------

#[test]
fn forged_proposals_and_states_are_refused_and_nothing_is_committed() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    d.signal(json!({"recordHypothesisFailure": true}));
    d.signal(json!({"recordHypothesisFailure": true}));
    d.act("fail");
    let snap = d.snap();
    let env = d.run.env.clone();
    let genuine = MUSE_V1_ACTIVE.propose_in(
        Hook::BeforeRequest,
        &snap,
        d.run.host.state(),
        d.run.host.next_proposal_id(),
        &env,
    );
    assert_eq!(genuine.effort, EffortProposal::Change("xhigh".into()));
    let tamper = |f: &dyn Fn(&mut EngineProposal)| {
        let mut p = genuine.clone();
        f(&mut p);
        p
    };
    fn mv(p: &mut EngineProposal) -> &mut MuseV1State {
        match &mut p.next_state.data {
            EngineStateData::MuseV1(s) => s,
            _ => unreachable!(),
        }
    }
    let revision = d.run.host.state().revision;
    let forged: Vec<(&str, EngineProposal, &str)> = vec![
        (
            "a different level",
            tamper(&|p| p.effort = EffortProposal::Change("high".into())),
            "engine-effort-unjustified",
        ),
        (
            "the change dropped",
            tamper(&|p| p.effort = EffortProposal::KeepPinned),
            "engine-effort-unjustified",
        ),
        (
            "max",
            tamper(&|p| p.effort = EffortProposal::Change("max".into())),
            "engine-effort-not-authorized",
        ),
        (
            "a token refunded",
            tamper(&|p| {
                let a = mv(p).adaptive.as_mut().unwrap();
                a.limiter.core.rearm_tokens_used = 1;
            }),
            "engine-state-transition",
        ),
        (
            "the flag set for free",
            tamper(&|p| {
                let a = mv(p).adaptive.as_mut().unwrap();
                a.limiter.dropped_before = true;
            }),
            "engine-state-transition",
        ),
        (
            "the baseline not advanced",
            tamper(&|p| {
                let a = mv(p).adaptive.as_mut().unwrap();
                a.baseline = Default::default();
            }),
            "engine-state-transition",
        ),
        (
            "the baseline inflated",
            tamper(&|p| {
                let a = mv(p).adaptive.as_mut().unwrap();
                a.baseline.total_failures += 5;
            }),
            "engine-state-transition",
        ),
        (
            "pending evidence invented",
            tamper(&|p| {
                let a = mv(p).adaptive.as_mut().unwrap();
                a.pending_trusted = 7;
            }),
            "engine-state-transition",
        ),
        (
            "last_attempt forged ahead",
            tamper(&|p| {
                let a = mv(p).adaptive.as_mut().unwrap();
                a.limiter.core.last_attempt = 9;
            }),
            "engine-state-transition",
        ),
        (
            "trusted count inflated in the record",
            tamper(&|p| {
                mv(p)
                    .history
                    .last_mut()
                    .unwrap()
                    .limiter
                    .as_mut()
                    .unwrap()
                    .trusted = 0;
            }),
            "engine-state-transition",
        ),
        (
            "strong flag cleared in the record",
            tamper(&|p| {
                mv(p)
                    .history
                    .last_mut()
                    .unwrap()
                    .limiter
                    .as_mut()
                    .unwrap()
                    .strong = false;
            }),
            "engine-state-transition",
        ),
        (
            "a rule the policy did not apply",
            tamper(&|p| {
                mv(p)
                    .history
                    .last_mut()
                    .unwrap()
                    .limiter
                    .as_mut()
                    .unwrap()
                    .rule = "down-progress".into();
            }),
            "engine-state-transition",
        ),
        (
            "the limiter record removed",
            tamper(&|p| {
                mv(p).history.last_mut().unwrap().limiter = None;
            }),
            "engine-state-transition",
        ),
        (
            "the adaptive block removed",
            tamper(&|p| {
                mv(p).adaptive = None;
            }),
            "engine-state-transition",
        ),
        (
            "the Governor effort rewritten",
            tamper(&|p| {
                mv(p).history.last_mut().unwrap().governor_effort = Some("high".into());
            }),
            "engine-state-transition",
        ),
    ];
    for (why, p, code) in forged {
        let r = d.run.host.accept(Hook::BeforeRequest, &snap, p);
        let e = r.expect_err(why);
        assert_eq!(e.code, code, "{why}: {}", e.message);
        assert_eq!(
            d.run.host.state().revision,
            revision,
            "{why}: nothing committed"
        );
        assert!(d.run.host.effort_selection().is_none(), "{why}");
    }
    // the genuine proposal is admitted
    d.run
        .host
        .accept(Hook::BeforeRequest, &snap, genuine)
        .expect("genuine");
    assert_eq!(d.run.host.effort_selection().unwrap().effort, "xhigh");
    // and a second, redundant Change to the effort now in force is the host's `engine-effort-noop`
    let snap2 = EngineSnapshot {
        current_effort: "xhigh".into(),
        ..d.snap()
    };
    let mut again = MUSE_V1_ACTIVE.propose_in(
        Hook::BeforeRequest,
        &snap2,
        d.run.host.state(),
        d.run.host.next_proposal_id(),
        &env,
    );
    again.effort = EffortProposal::Change("xhigh".into());
    assert_eq!(
        d.run
            .host
            .accept(Hook::BeforeRequest, &snap2, again)
            .unwrap_err()
            .code,
        "engine-effort-noop"
    );
}

#[test]
fn the_shadow_engines_still_cannot_change_the_effort_and_carry_no_limiter() {
    need_node!();
    for ext in [
        &super::muse_v1::MUSE_V1 as &'static dyn EngineExtension,
        &super::muse_v1::MUSE_V1_SIGNALS,
    ] {
        let mut h = EngineHost::new(ext);
        let env = EngineEnv {
            governor: Some(test_evaluator("node".into())),
        };
        let snap = EngineSnapshot {
            kind: Some(RunKind::Code),
            current_effort: "low".into(),
            authorized_efforts: levels(&["low", "medium", "high", "xhigh"]),
            generation: "g".into(),
            ..Default::default()
        };
        h.consult_in(Hook::BeforeRequest, &snap, &env).unwrap();
        assert!(h.effort_selection().is_none());
        let s = st(&h);
        assert!(s.adaptive.is_none() && s.history.iter().all(|d| d.limiter.is_none()));
        assert!(!ext
            .persist_state(h.state())
            .as_object()
            .unwrap()
            .contains_key("adaptive"));
    }
}

// ---------------------------------------------------------------------------------------------
// the host's independent expectation of the strong flag equals the real Governor's
// ---------------------------------------------------------------------------------------------

#[test]
fn the_hosts_strong_escalation_condition_equals_the_real_governors_on_random_blocks() {
    need_node!();
    let ev = test_evaluator("node".into());
    let mut rng = super::effort_limiter_tests::Rng(0xE5CA_1A7E);
    let mut strong_seen = 0;
    for i in 0..400 {
        let n = |r: &mut super::effort_limiter_tests::Rng| r.below(4);
        let phases = [
            "discover",
            "diagnose",
            "design",
            "implement",
            "verify",
            "recover",
            "review",
        ];
        let phase = phases[rng.below(7) as usize];
        let block = json!({
            "phase": phase,
            "rootCauseEstablished": rng.chance(1, 2), "solutionEstablished": rng.chance(1, 2),
            "failedHypotheses": n(&mut rng), "failedImplementationAttempts": n(&mut rng),
            "totalFailedHypotheses": 9, "totalFailedImplementationAttempts": 9,
            "conflictingEvidence": rng.chance(1, 3), "requestMax": false,
            "currentEffort": null, "lastResolution": null, "processedSignalIds": [],
        });
        let r = ev
            .call(
                "evaluate",
                &json!({"museReasoning": block, "museActivity": null, "events": [],
                        "capabilities": ["low", "medium", "high", "xhigh"], "resolve": true}),
            )
            .unwrap();
        let (strong, _) = strong_escalation_of_decision(&r["decision"]).unwrap();
        assert_eq!(
            strong,
            strong_escalation_of_block(Some(&r["museReasoning"])),
            "case {i}: {block}"
        );
        strong_seen += usize::from(strong);
    }
    assert!(
        strong_seen > 50 && strong_seen < 350,
        "both outcomes exercised: {strong_seen}"
    );
    // and on every row of every pinned trace the recorded flag is what the block implies
    assert!(!strong_escalation_of_block(None));
    assert!(!strong_escalation_of_block(Some(&Value::Null)));
}

// ---------------------------------------------------------------------------------------------
// crash points: nothing is duplicated or misapplied
// ---------------------------------------------------------------------------------------------

#[test]
fn a_crash_after_the_durable_selection_before_the_binding_is_a_clean_continuation() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    d.signal(json!({"recordHypothesisFailure": true}));
    d.signal(json!({"recordHypothesisFailure": true}));
    // the proposal is accepted and the selection committed; the process dies before bind_attempt
    let snap = d.snap();
    d.run.consult(Hook::BeforeRequest, &snap).unwrap();
    assert_eq!(d.selections().len(), 1);
    let durable = EngineStateStore::open(d.dir.path())
        .unwrap()
        .load("task-1")
        .unwrap()
        .unwrap();
    assert_eq!(durable.effort.as_ref().unwrap().effort, "xhigh");
    assert!(durable.attempts.is_empty(), "never bound, never dispatched");
    d.interrupt();
    // the continuation restarts at the default; the elevated effort that was selected-but-never-used
    // is still a reset elevated effort - a drop; the earlier claims were judged (baseline advanced)
    let a = d.adaptive();
    assert!(a.limiter.dropped_before);
    assert_eq!(a.baseline.total_failures, 2);
    assert_eq!(
        d.selections().len(),
        0,
        "no selection is replayed into the new record"
    );
    assert_eq!(
        d.attempt(),
        "xhigh",
        "re-asked: a token (claim-only after a drop)"
    );
    assert_eq!(d.adaptive().limiter.core.rearm_tokens_used, 1);
}

#[test]
fn a_crash_before_any_commit_loses_the_evaluation_and_the_continuation_redoes_it_identically() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    assert_eq!(
        d.attempt(),
        "medium",
        "the Governor's phase default, committed and bound"
    );
    d.signal(json!({"recordHypothesisFailure": true}));
    // an evaluation that selects nothing is staged in memory only (no commit until the binding)
    let snap = d.snap();
    d.run.consult(Hook::BeforeRequest, &snap).unwrap();
    assert_eq!(d.state().evaluations, 2);
    assert_eq!(d.selections().len(), 1, "no new selection");
    let durable = EngineStateStore::open(d.dir.path())
        .unwrap()
        .load("task-1")
        .unwrap()
        .unwrap();
    // what the continuation inherits is the LAST COMMIT (the signal's), not the staged evaluation
    assert_eq!(durable.payload["evaluations"].as_u64(), Some(1));
    let judged_baseline = Adaptive::from_value(&durable.payload["adaptive"])
        .unwrap()
        .baseline;
    assert_eq!(
        judged_baseline.total_failures, 0,
        "the claim of the lost evaluation is still unjudged"
    );
    d.interrupt();
    assert_eq!(
        d.state().evaluations,
        1,
        "the evaluation is redone, not replayed"
    );
    d.attempt();
    let rec = d.state().history.last().unwrap().limiter.clone().unwrap();
    assert_eq!(rec.claims, 1, "the unjudged claim is judged now - once");
}

#[test]
fn a_signal_whose_commit_fails_is_not_acknowledged_and_changes_no_durable_evidence() {
    need_node!();
    // the host-level contract: `consult_signal` returns the ack only after the durable commit; a
    // failed commit (injected through the store's directory) surfaces as an error
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    d.signal(json!({"recordHypothesisFailure": true}));
    let good = EngineStateStore::open(d.dir.path())
        .unwrap()
        .load("task-1")
        .unwrap()
        .unwrap();
    let dir = d.dir.path().join("engine");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let writable = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("probe"))
        .is_ok();
    if writable {
        // running as a user the permission bits do not bind (root): nothing to prove here
        let _ = std::fs::remove_file(dir.join("probe"));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        return;
    }
    d.seq += 1;
    let g = d.generation();
    let sig = json!({"recordHypothesisFailure": true});
    d.signals.push(SignalObservation {
        seq: d.seq,
        attempt: 1,
        generation: g.clone(),
        call_id: "late".into(),
        dispatch_key: crate::signals::dispatch_key(&g, 1, "late", &sig),
        signal: sig,
    });
    assert!(
        d.run.consult_signal(&d.snap()).is_err(),
        "no acknowledgement without a durable record"
    );
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let after = EngineStateStore::open(d.dir.path())
        .unwrap()
        .load("task-1")
        .unwrap()
        .unwrap();
    assert_eq!(
        after.revision, good.revision,
        "the durable record is the last good one"
    );
    assert_eq!(after.payload["adaptive"], good.payload["adaptive"]);
}

// ---------------------------------------------------------------------------------------------
// size and cost
// ---------------------------------------------------------------------------------------------

#[test]
fn the_adaptive_payload_stays_inside_the_engine_state_bound_and_costs_little() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    // saturate every bounded structure: 8 retained decisions with limiter records, 64 executions,
    // 100 processed signal ids
    for i in 0..110 {
        d.signal(json!({"phase": if i % 2 == 0 { "diagnose" } else { "implement" }}));
        if i % 3 == 0 {
            d.act("mutation");
        }
        if i % 7 == 0 {
            d.act("fail");
        }
        if i % 11 == 0 {
            d.attempt();
        }
    }
    for _ in 0..10 {
        d.attempt();
    }
    let s = d.state();
    assert_eq!(s.history.len(), 8);
    let size = MUSE_V1_ACTIVE
        .persist_state(d.run.host.state())
        .to_string()
        .len();
    println!("ADAPTIVE payload at saturation: {size} bytes (bound {MAX_STATE_BYTES})");
    assert!(size <= MAX_STATE_BYTES, "{size}");
    // overhead of the limiter itself and of one full attempt (worker + host + durable commits)
    let a = Adaptive::default();
    let snap = d.snap();
    let block = s.reasoning.clone();
    let t = std::time::Instant::now();
    for _ in 0..20_000 {
        std::hint::black_box(evaluate_limiter(
            &a,
            &snap,
            Some("high"),
            false,
            block.as_ref(),
            0,
            3,
        ));
    }
    println!("LIMITER judge: {:?} per evaluation", t.elapsed() / 20_000);
    let t = std::time::Instant::now();
    for _ in 0..20 {
        d.attempt();
    }
    println!(
        "FULL attempt (Governor + limiter + host checks + 1-2 durable commits): {:?}",
        t.elapsed() / 20
    );
}

// ---------------------------------------------------------------------------------------------
// `max` is unreachable
// ---------------------------------------------------------------------------------------------

#[test]
fn a_governor_max_is_never_applied_even_when_the_binding_authorizes_it() {
    need_node!();
    // a hostile or buggy Governor answer: `max` (the historical `requestMax` outcome)
    let e: Arc<dyn GovernorEvaluator> = Arc::new(Tamper {
        inner: test_evaluator("node".into()),
        how: Mutex::new(Box::new(|r: &mut Value| {
            r["decision"]["effort"] = json!("max");
        })),
        calls: Mutex::new(0),
    });
    let mut d = Drive::with_evaluator(&["low", "medium", "high", "xhigh", "max"], e);
    for _ in 0..3 {
        assert_eq!(d.attempt(), "low", "max is never applied");
        let rec = d.state().history.last().unwrap().limiter.clone().unwrap();
        assert_eq!(rec.rule, "error:limiter-input-invalid");
        assert_eq!(rec.action, "keep");
    }
    assert!(d.selections().is_empty());
    // the model cannot ask for it either: the Core's validator (not the engine) refuses the field
    for forbidden in [
        json!({"requestMax": true}),
        json!({"effort": "max"}),
        json!({"max": true}),
    ] {
        assert!(
            crate::signals::validate(&forbidden, forbidden.to_string().len()).is_err(),
            "{forbidden}"
        );
    }
}

/// EM-04C2 S10 SEC-4: a feed that repeats an execution id is one observation for the engine AND for
/// the host's independent recount - the transition is accepted, and the failure counts once.
#[test]
fn a_repeated_execution_id_in_the_feed_is_one_observation_for_engine_and_host_alike() {
    need_node!();
    let mut d = Drive::new(&["low", "medium", "high", "xhigh"]);
    for _ in 0..6 {
        escalate_in_this_generation(&mut d);
        d.interrupt();
    }
    d.act("fail");
    let mut dup = d.activity.last().unwrap().clone();
    d.seq += 1;
    dup.seq = d.seq; // a later position of the SAME execution
    d.activity.push(dup);
    d.act("mutation"); // a later, distinct observation moves the frontier past the repeat
    let e = escalate_in_this_generation(&mut d);
    assert_eq!(e, "xhigh", "the single failed check is trusted evidence");
    assert_eq!(d.adaptive().pending_trusted, 0);
}

/// S9.5: a record that carries the PREVIOUS engine identity (`muse-v1`), even one that is perfectly
/// authenticated, is never reinterpreted by `nexus-adaptive-v1` - there is no alias and no migration.
#[test]
fn a_predecessor_with_the_previous_engine_identity_is_refused_even_when_authentic() {
    let dir = tempfile::tempdir().unwrap();
    let first = start(dir.path(), 1, None);
    drop(first);
    let store = EngineStateStore::open(dir.path()).unwrap();
    let mut rec = store.load("task-1").unwrap().expect("generation 1 record");
    assert_eq!(rec.engine_id, ACTIVE_ENGINE_ID);
    rec.engine_id = "muse-v1".into();
    store
        .commit(&mut rec)
        .expect("re-authenticated under the real key");
    assert!(
        store.load("task-1").unwrap().is_some(),
        "the forged-identity record is authentic"
    );
    let r = EngineRun::start(
        EngineStateStore::open(dir.path()).unwrap(),
        &MUSE_V1_ACTIVE,
        "run_task-2",
        "task-2",
        ADAPTIVE_MODE_ID,
        &"b".repeat(64),
        "low",
        Some(Predecessor::new("run_task-1", Some("task-1".into()))),
    );
    assert_eq!(r.err().expect("refused").code, "engine-state-identity");
    assert!(
        EngineStateStore::open(dir.path())
            .unwrap()
            .load("task-2")
            .unwrap()
            .is_none(),
        "a refused continuation creates nothing"
    );
}
