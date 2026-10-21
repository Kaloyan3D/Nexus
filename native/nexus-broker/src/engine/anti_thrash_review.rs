//! EM-04C1 Phase 4: review of the HISTORICAL Governor's anti-thrash behaviour, as executable facts.
//!
//! The Governor (`config/Muse-ReasoningGovernor.cjs`) is a pure function of the task's Muse state,
//! the Runtime owns the progress resets and the Activity reducer folds trusted operational
//! evidence. This module drives the real, unchanged modules (through the persistent worker) with
//! adversarial and ordinary trajectories and records what the policy does with them, request by
//! request. It does NOT change the policy and asserts only what the policy actually does today,
//! so that EM-04C2 can design a bounded change against pinned facts (see
//! `EM-04C2-ACTIVATION-HANDOFF.md`).
//!
//! Run with `--nocapture` to print the tables used by the review document.

use super::effort_limiter::{is_escalation_entry, EvidenceBaseline};
use super::worker_bridge::test_evaluator;
use serde_json::{json, Value};

fn node() -> Option<std::path::PathBuf> {
    let ok = std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()?
        .status
        .success();
    ok.then(|| "node".into())
}

macro_rules! need_node {
    () => {
        if node().is_none() {
            return;
        }
    };
}

const CAPS: [&str; 4] = ["low", "medium", "high", "xhigh"];

#[derive(Clone)]
enum Ev {
    /// a model signal (phase + flags), dispatch key unique per use
    Sig(Value),
    /// the same dispatch key replayed
    SigKey(Value, &'static str),
    /// a Kernel-verified mutation
    Mutation,
    /// a Kernel-verified check
    Check(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
struct Row {
    effort: String,
    phase: String,
    source: String,
}

struct Sim {
    b: std::sync::Arc<dyn super::governor_bridge::GovernorEvaluator>,
    reasoning: Value,
    activity: Value,
    n: u32,
}

impl Sim {
    fn new() -> Self {
        Self {
            b: test_evaluator("node".into()),
            reasoning: Value::Null,
            activity: Value::Null,
            n: 0,
        }
    }

    /// One request: fold the events that happened since the last one, resolve the effort.
    fn request(&mut self, events: &[Ev]) -> Row {
        let mut list = Vec::new();
        for e in events {
            self.n += 1;
            list.push(match e {
                Ev::Sig(s) => {
                    json!({"type": "signal", "signal": s, "dispatchKey": format!("n1:{}", self.n)})
                }
                Ev::SigKey(s, k) => json!({"type": "signal", "signal": s, "dispatchKey": k}),
                Ev::Mutation => json!({"type": "activity", "classification": {"kind": "mutation"}}),
                Ev::Check(o) => json!({"type": "activity", "classification":
                    {"kind": "verification", "outcome": o, "family": "native:cargo"}}),
            });
        }
        let r = self
            .b
            .call(
                "evaluate",
                &json!({"museReasoning": self.reasoning, "museActivity": self.activity,
                        "events": list, "capabilities": CAPS, "resolve": true}),
            )
            .unwrap();
        self.reasoning = r["museReasoning"].clone();
        self.activity = r["museActivity"].clone();
        let d = &r["decision"];
        Row {
            effort: d["effort"].as_str().unwrap_or("-").to_owned(),
            phase: d["effectivePhase"].as_str().unwrap_or("-").to_owned(),
            source: d["effectiveSource"].as_str().unwrap_or("-").to_owned(),
        }
    }

    /// Simulates a restart: the persisted blocks survive, the bridge/process does not.
    fn restart(&mut self) {
        // the engine's continuation clears currentEffort and keeps everything else
        if let Some(o) = self.reasoning.as_object_mut() {
            o.insert("currentEffort".into(), Value::Null);
        }
        self.b = test_evaluator("node".into());
    }
}

fn efforts(rows: &[Row]) -> Vec<&str> {
    rows.iter().map(|r| r.effort.as_str()).collect()
}

fn changes(rows: &[Row]) -> usize {
    rows.windows(2)
        .filter(|w| w[0].effort != w[1].effort)
        .count()
}

fn show(name: &str, rows: &[Row]) {
    println!(
        "REVIEW {name}: {} requests, {} effort changes: {}",
        rows.len(),
        changes(rows),
        efforts(rows).join(" ")
    );
}

fn ph(p: &str) -> Ev {
    Ev::Sig(json!({"phase": p}))
}

/// A1. Model-driven phase flapping: the pure policy has no memory of the previous effort, so a
/// phase signal that alternates every request flips the effort on EVERY request.
#[test]
fn a1_phase_flapping_flips_the_effort_every_request() {
    need_node!();
    let mut s = Sim::new();
    let rows: Vec<Row> = (0..24)
        .map(|i| s.request(&[ph(if i % 2 == 0 { "diagnose" } else { "implement" })]))
        .collect();
    show("A1 phase flapping diagnose/implement", &rows);
    assert_eq!(changes(&rows), 23, "no hysteresis: one change per request");
    assert_eq!(efforts(&rows)[..4], ["high", "medium", "high", "medium"]);
    // ... and the alternation is bounded by the ladder the phases map to, never beyond it
    assert!(rows
        .iter()
        .all(|r| r.effort == "high" || r.effort == "medium"));
}

/// A2. Repeating the SAME phase (or the same dispatch key) is idempotent.
#[test]
fn a2_repeated_identical_signals_and_evaluations_are_idempotent() {
    need_node!();
    let mut s = Sim::new();
    let first = s.request(&[ph("diagnose")]);
    let again: Vec<Row> = (0..20).map(|_| s.request(&[])).collect();
    assert!(
        again.iter().all(|r| *r == first),
        "re-evaluating changes nothing"
    );
    // the same dispatch key delivered 10 times is applied once
    let mut s = Sim::new();
    let sig = json!({"recordHypothesisFailure": true});
    let rows: Vec<Row> = (0..10)
        .map(|_| s.request(&[Ev::SigKey(sig.clone(), "n1:same")]))
        .collect();
    show("A2 one failure delivered 10 times", &rows);
    assert_eq!(s.reasoning["failedHypotheses"], 1);
    assert_eq!(s.reasoning["totalFailedHypotheses"], 1);
    assert!(rows.iter().all(|r| r.effort == rows[0].effort));
    // a distinct key each time is a distinct claim: the third failure only deepens the window
    let mut s = Sim::new();
    let rows: Vec<Row> = (0..6)
        .map(|_| s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))]))
        .collect();
    show("A2 six distinct hypothesis failures", &rows);
    assert_eq!(
        efforts(&rows),
        ["medium", "xhigh", "xhigh", "xhigh", "xhigh", "xhigh"]
    );
}

/// A3. Failure windows: two failures escalate to xhigh and STAY there (no decay with time or
/// requests); only meaningful progress - establishing the root cause (false -> true edge) - closes
/// the window.
#[test]
fn a3_failure_windows_are_sticky_until_progress() {
    need_node!();
    let mut s = Sim::new();
    let mut rows = vec![s.request(&[])];
    rows.push(s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))]));
    rows.push(s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))]));
    for _ in 0..15 {
        rows.push(s.request(&[])); // time passes, nothing else happens
    }
    let stuck = rows.len();
    rows.push(s.request(&[Ev::Sig(json!({"markRootCauseEstablished": true}))]));
    rows.push(s.request(&[]));
    show("A3 failure window then progress", &rows);
    assert!(
        rows[2..stuck].iter().all(|r| r.effort == "xhigh"),
        "no decay"
    );
    assert_eq!(
        rows[stuck].effort, "medium",
        "progress resets the window at once"
    );
    assert_eq!(s.reasoning["failedHypotheses"], 0);
    assert_eq!(
        s.reasoning["totalFailedHypotheses"], 2,
        "history is never erased"
    );
}

/// A4. The reset edge can be re-armed by the model: invalidate, then re-establish. Each lap costs
/// two model signals and two failures and produces two effort changes - bounded only by what the
/// model chooses to claim (the signals tool's authority is claims, not effort).
#[test]
fn a4_the_model_can_cycle_escalation_by_re_arming_the_progress_edge() {
    need_node!();
    let mut s = Sim::new();
    let mut rows = Vec::new();
    for _ in 0..6 {
        rows.push(s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))]));
        rows.push(s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))])); // -> xhigh
        rows.push(s.request(&[Ev::Sig(json!({"markRootCauseEstablished": true}))])); // reset
        rows.push(s.request(&[Ev::Sig(json!({"invalidateRootCause": true}))])); // re-arm
    }
    show("A4 escalate / reset / re-arm x6", &rows);
    assert_eq!(rows.iter().filter(|r| r.effort == "xhigh").count(), 6);
    assert!(changes(&rows) >= 12, "{}", changes(&rows));
    // every escalation is a CLAIM of two failures; the totals keep the honest count
    assert_eq!(s.reasoning["totalFailedHypotheses"], 12);
}

/// A5. Conflicting evidence alone escalates; it clears only on resolution or on a new root cause.
#[test]
fn a5_conflicting_evidence_is_a_sticky_escalation() {
    need_node!();
    let mut s = Sim::new();
    let mut rows = vec![s.request(&[Ev::Sig(json!({"conflictingEvidence": true}))])];
    for _ in 0..5 {
        rows.push(s.request(&[]));
    }
    rows.push(s.request(&[Ev::Sig(json!({"resolveConflictingEvidence": true}))]));
    show("A5 conflicting evidence then resolution", &rows);
    assert!(rows[..6].iter().all(|r| r.effort == "xhigh"));
    assert_eq!(rows[6].effort, "medium");
}

/// A6. Recovery-needed from trusted evidence. A failed check puts the next request on the recover
/// policy (high); an edit after it in the SAME period does not leave it (historical parity O-1:
/// mutation milestones fire once per period), so a fix-and-retry loop stays on `high` instead of
/// oscillating; a later PASS ends it. A semantic phase signal re-baselines the evidence.
#[test]
fn a6_recovery_needed_is_sticky_through_edits_until_a_verification_outcome() {
    need_node!();
    let mut s = Sim::new();
    let mut rows = vec![s.request(&[Ev::Mutation])]; // implementation-active (medium)
    rows.push(s.request(&[Ev::Check("failed")])); // recovery-needed
    for _ in 0..6 {
        rows.push(s.request(&[Ev::Mutation])); // fix attempts
        rows.push(s.request(&[Ev::Check("failed")])); // still failing
    }
    let loop_end = rows.len();
    rows.push(s.request(&[Ev::Mutation]));
    rows.push(s.request(&[Ev::Check("passed")]));
    show("A6 edit/test loop then pass", &rows);
    assert_eq!(rows[0].source, "implementation-active");
    assert!(rows[1..loop_end]
        .iter()
        .all(|r| r.source == "recovery-needed" && r.effort == "high"));
    assert_eq!(
        changes(&rows[..loop_end]),
        1,
        "one escalation, no oscillation in the loop"
    );
    assert_eq!(
        rows[loop_end + 1].source,
        "implementation-active",
        "a pass ends recovery"
    );
    // a semantic phase signal supersedes older evidence
    let mut s = Sim::new();
    s.request(&[Ev::Mutation]);
    s.request(&[Ev::Check("failed")]);
    let r = s.request(&[ph("verify")]);
    assert_eq!(
        (r.source.as_str(), r.effort.as_str()),
        ("semantic", "medium")
    );
}

/// A7. Operational evidence interleaved with model phase signals: the combined trajectory of a
/// typical session, to size the number of effort changes ordinary work causes.
#[test]
fn a7_an_ordinary_session_changes_effort_a_handful_of_times() {
    need_node!();
    let mut s = Sim::new();
    let script: Vec<Vec<Ev>> = vec![
        vec![],
        vec![ph("diagnose")],
        vec![],
        vec![Ev::Sig(
            json!({"markRootCauseEstablished": true, "phase": "design"}),
        )],
        vec![Ev::Sig(
            json!({"markSolutionEstablished": true, "phase": "implement"}),
        )],
        vec![Ev::Mutation],
        vec![Ev::Mutation],
        vec![ph("verify"), Ev::Check("failed")],
        vec![Ev::Mutation],
        vec![Ev::Check("failed")],
        vec![Ev::Mutation],
        vec![Ev::Check("passed")],
        vec![ph("review")],
        vec![],
    ];
    let rows: Vec<Row> = script.iter().map(|e| s.request(e)).collect();
    show("A7 ordinary session", &rows);
    assert!(changes(&rows) <= 8, "{}", changes(&rows));
}

/// A8. Restart inheritance: the semantic and activity blocks survive a restart, so an open failure
/// window still escalates on the first request of the continuation; `currentEffort` is not
/// carried (the continuation restarts at the default effort and re-proposes).
#[test]
fn a8_restart_inherits_the_windows_not_the_effort() {
    need_node!();
    let mut s = Sim::new();
    s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))]);
    let before = s.request(&[Ev::Sig(json!({"recordHypothesisFailure": true}))]);
    assert_eq!(before.effort, "xhigh");
    s.restart();
    let after = s.request(&[]);
    assert_eq!(after.effort, "xhigh", "the window is inherited");
    assert_eq!(s.reasoning["failedHypotheses"], 2);
    // a replay of a predecessor's delivery is a duplicate (the processed window is inherited)
    let mut s = Sim::new();
    s.request(&[Ev::SigKey(
        json!({"recordHypothesisFailure": true}),
        "n1:pred",
    )]);
    s.restart();
    s.request(&[Ev::SigKey(
        json!({"recordHypothesisFailure": true}),
        "n1:pred",
    )]);
    assert_eq!(s.reasoning["failedHypotheses"], 1);
}

/// A9. The authorized ladder bounds every outcome: a slot policy without xhigh clamps DOWN, never
/// up, and a policy that cannot hold the request fails closed (the shadow keeps the effort).
#[test]
fn a9_the_slot_policy_bounds_every_outcome() {
    need_node!();
    let b = test_evaluator("node".into());
    let escalated = json!({"phase": "diagnose", "currentEffort": null, "rootCauseEstablished": false,
        "solutionEstablished": false, "failedHypotheses": 3, "failedImplementationAttempts": 0,
        "totalFailedHypotheses": 3, "totalFailedImplementationAttempts": 0,
        "conflictingEvidence": false, "requestMax": false, "lastResolution": null, "processedSignalIds": []});
    for (caps, want) in [
        (json!(["low", "medium", "high", "xhigh"]), json!("xhigh")),
        (json!(["low", "medium", "high"]), json!("high")),
        (json!(["low", "medium"]), json!("medium")),
    ] {
        let r = b
            .call(
                "evaluate",
                &json!({"museReasoning": escalated, "museActivity": null, "events": [],
                        "capabilities": caps, "resolve": true}),
            )
            .unwrap();
        assert_eq!(r["decision"]["effort"], want, "{caps}");
    }
    let r = b
        .call(
            "evaluate",
            &json!({"museReasoning": escalated, "museActivity": null, "events": [],
                    "capabilities": ["low"], "resolve": true}),
        )
        .unwrap();
    assert_eq!(r["decision"]["outcome"], "capability-unavailable");
}

/// A10. `requestMax` is not model-reachable: the signals path refuses it, so `max` cannot be
/// requested through the tool even though the Governor can resolve it.
#[test]
fn a10_max_is_not_reachable_through_the_model_facing_path() {
    need_node!();
    let b = test_evaluator("node".into());
    for forbidden in [
        json!({"requestMax": true}),
        json!({"max": true}),
        json!({"effort": "max"}),
        json!({"reasoningEffort": "max"}),
    ] {
        let r = b.call(
            "evaluate",
            &json!({"events": [{"type": "signal", "signal": forbidden, "dispatchKey": "n1:x"}],
                    "capabilities": CAPS, "resolve": true}),
        );
        assert_eq!(r.unwrap_err().code, "signal-forbidden-field", "{forbidden}");
    }
}

// ---------------------------------------------------------------------------------------------
// EM-04C2 S5: per-attempt traces of the REAL Governor for the Effort Transition Limiter.
//
// `governor_traces()` drives the unchanged Governor/Runtime/Activity modules (through the worker)
// with the thirteen scenarios of `EM-04C2-ANTI-THRASH-POLICY.md` §4 and returns, per attempt, the
// Governor's decision plus the evidence deltas the limiter consumes. The pinned copy lives in
// `tests/fixtures/em04c2-governor-traces.json`; regenerating it is the explicit, reviewed action
// described in `effort_limiter_tests.rs` and never happens during a normal test run.
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
enum TStep {
    /// resolve now: one attempt
    Res,
    /// a model signal (dispatch key unique per use)
    Sig(Value),
    /// a Kernel-backed fact: `mutation` | `fail` | `pass` | `started`
    Act(&'static str),
    /// persisted blocks survive, `currentEffort` and the process do not
    Restart,
}
use TStep::{Act, Res, Restart, Sig};

fn failh() -> TStep {
    Sig(json!({"recordHypothesisFailure": true}))
}
fn faili() -> TStep {
    Sig(json!({"recordImplementationFailure": true}))
}
fn sg(v: Value) -> TStep {
    Sig(v)
}

fn trace_scenarios() -> Vec<(&'static str, &'static str, Vec<TStep>)> {
    let lap = || {
        vec![
            failh(),
            Res,
            failh(),
            Res,
            sg(json!({"markRootCauseEstablished": true})),
            Res,
            sg(json!({"invalidateRootCause": true})),
            Res,
        ]
    };
    let mut a1 = Vec::new();
    for i in 0..24 {
        a1.push(sg(
            json!({"phase": if i % 2 == 0 { "diagnose" } else { "implement" }}),
        ));
        a1.push(Res);
    }
    let mut a3 = vec![Res, failh(), Res, failh(), Res];
    a3.extend(std::iter::repeat_n(Res, 15));
    a3.extend([sg(json!({"markRootCauseEstablished": true})), Res, Res]);
    let a4: Vec<TStep> = (0..6).flat_map(|_| lap()).collect();
    let a4s: Vec<TStep> = (0..4)
        .flat_map(|_| {
            let mut l = lap();
            l.extend(std::iter::repeat_n(Res, 4));
            l
        })
        .collect();
    let g1: Vec<TStep> = (0..4)
        .flat_map(|_| {
            vec![
                Act("mutation"),
                Res,
                Act("fail"),
                failh(),
                Res,
                Act("fail"),
                failh(),
                Res,
                sg(json!({"markRootCauseEstablished": true})),
                Res,
                sg(json!({"invalidateRootCause": true})),
                Res,
            ]
        })
        .collect();
    let g2 = vec![
        failh(),
        Res,
        failh(),
        Res,
        sg(json!({"markRootCauseEstablished": true, "phase": "implement"})),
        Res,
        sg(json!({"markSolutionEstablished": true})),
        Res,
        Act("mutation"),
        Res,
        Res,
        Res,
        Act("fail"),
        faili(),
        Res,
        Act("fail"),
        faili(),
        Res,
        Res,
    ];
    let a5 = {
        let mut v = vec![sg(json!({"conflictingEvidence": true})), Res];
        v.extend(std::iter::repeat_n(Res, 5));
        v.extend([sg(json!({"resolveConflictingEvidence": true})), Res]);
        v
    };
    let a6 = {
        let mut v = vec![Act("mutation"), Res, Act("fail"), Res];
        for _ in 0..6 {
            v.extend([Act("mutation"), Res, Act("fail"), Res]);
        }
        v.extend([Act("mutation"), Res, Act("pass"), Res]);
        v
    };
    let a7 = vec![
        Res,
        sg(json!({"phase": "diagnose"})),
        Res,
        Res,
        sg(json!({"markRootCauseEstablished": true, "phase": "design"})),
        Res,
        sg(json!({"markSolutionEstablished": true, "phase": "implement"})),
        Res,
        Act("mutation"),
        Res,
        Act("mutation"),
        Res,
        sg(json!({"phase": "verify"})),
        Act("fail"),
        Res,
        Act("mutation"),
        Res,
        Act("fail"),
        Res,
        Act("mutation"),
        Res,
        Act("pass"),
        Res,
        sg(json!({"phase": "review"})),
        Res,
        Res,
    ];
    // transcribed from `governor_parity.rs`
    let p1 = vec![
        sg(json!({"phase": "diagnose"})),
        failh(),
        Res,
        failh(),
        Res,
        sg(json!({"markRootCauseEstablished": true})),
        Res,
        sg(json!({"phase": "implement"})),
        faili(),
        faili(),
        Res,
        sg(json!({"markSolutionEstablished": true})),
        Res,
    ];
    let p2 = vec![
        sg(json!({"phase": "implement"})),
        sg(json!({"markRootCauseEstablished": true})),
        Res,
        sg(json!({"markSolutionEstablished": true})),
        Res,
        sg(json!({"conflictingEvidence": true})),
        Res,
        sg(json!({"resolveConflictingEvidence": true})),
        Res,
        sg(json!({"invalidateRootCause": true})),
        Res,
        sg(json!({"markRootCauseEstablished": true})),
        Res,
        sg(json!({"invalidateSolution": true})),
        Res,
    ];
    let p3 = vec![
        sg(json!({"phase": "diagnose"})),
        Res,
        Res,
        Act("mutation"),
        Res,
        Act("mutation"),
        Act("mutation"),
        Res,
        Act("fail"),
        Res,
        Act("fail"),
        Res,
        Act("mutation"),
        Res,
        sg(json!({"phase": "verify"})),
        Act("pass"),
        Res,
        Act("started"),
        Res,
        sg(json!({"phase": "review"})),
        Res,
    ];
    let p4 = vec![
        sg(json!({"phase": "diagnose"})),
        failh(),
        Res,
        Restart,
        failh(),
        Res,
        Act("mutation"),
        Restart,
        Res,
        Act("fail"),
        Restart,
        Res,
    ];
    vec![
        ("A1", "phase flapping diagnose/implement x24", a1),
        ("A3", "sticky escalation then progress", a3),
        ("A4", "claim-only re-arm lap x6", a4),
        (
            "A4s",
            "claim-only re-arm lap x4, 4 quiet attempts each",
            a4s,
        ),
        ("G1", "genuine laps with failing tests x4", g1),
        ("G2", "genuine second problem after progress", g2),
        ("A5", "conflicting evidence then resolution", a5),
        ("A6", "edit/test loop then pass", a6),
        ("A7", "ordinary session", a7),
        ("P1", "parity: failure escalation and progress", p1),
        ("P2", "parity: root cause, conflict, invalidation", p2),
        ("P3", "parity: trusted activity", p3),
        ("P4", "parity: restart and continuation", p4),
    ]
}

/// Runs one scenario against the real Governor; one JSON row per attempt.
fn run_trace(steps: &[TStep]) -> Vec<Value> {
    let mut b = test_evaluator("node".into());
    let (mut reasoning, mut activity) = (Value::Null, Value::Null);
    let (mut pending, mut key, mut trusted) = (Vec::<Value>::new(), 0u32, 0u32);
    let mut baseline = EvidenceBaseline::default();
    let mut rows = Vec::new();
    for step in steps {
        match step {
            Sig(s) => {
                key += 1;
                pending.push(
                    json!({"type": "signal", "signal": s, "dispatchKey": format!("n1:{key}")}),
                );
            }
            Act(kind) => {
                let c = match *kind {
                    "mutation" => json!({"kind": "mutation"}),
                    "fail" | "pass" | "started" => {
                        let outcome = match *kind {
                            "fail" => "failed",
                            "pass" => "passed",
                            _ => "started",
                        };
                        json!({"kind": "verification", "outcome": outcome, "family": "native:cargo"})
                    }
                    other => panic!("unknown activity {other}"),
                };
                if *kind == "fail" {
                    trusted += 1;
                }
                pending.push(json!({"type": "activity", "classification": c}));
            }
            Restart => {
                if let Some(o) = reasoning.as_object_mut() {
                    o.insert("currentEffort".into(), Value::Null);
                }
                b = test_evaluator("node".into());
            }
            Res => {
                let r = b
                    .call(
                        "evaluate",
                        &json!({"museReasoning": reasoning, "museActivity": activity,
                                "events": std::mem::take(&mut pending),
                                "capabilities": CAPS, "resolve": true}),
                    )
                    .unwrap();
                reasoning = r["museReasoning"].clone();
                activity = r["museActivity"].clone();
                let d = &r["decision"];
                let now = EvidenceBaseline::from_reasoning(Some(&reasoning)).unwrap();
                let (claims, edge_any) = baseline.delta_to(&now);
                let edge_root = now.root_cause_established && !baseline.root_cause_established;
                let edge_sol = now.solution_established && !baseline.solution_established;
                debug_assert_eq!(edge_any, edge_root || edge_sol);
                let esc: Vec<Value> = d["trace"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|t| is_escalation_entry(t.as_str().unwrap()))
                    .cloned()
                    .collect();
                rows.push(json!({
                    "effort": d["effort"], "source": d["effectiveSource"],
                    "phase": d["effectivePhase"], "esc": esc,
                    "claimDelta": claims,
                    "trustedFail": trusted,
                    "rootEdge": edge_root, "solEdge": edge_sol,
                }));
                baseline = now;
                trusted = 0;
            }
        }
    }
    rows
}

/// All thirteen traces of the real Governor, in the fixture's shape (without the limiter's pinned
/// results, which the limiter tests add). `None` when no `node` is available.
pub(super) fn governor_traces() -> Option<Value> {
    node()?;
    let traces: Vec<Value> = trace_scenarios()
        .into_iter()
        .map(|(id, name, steps)| json!({"id": id, "name": name, "attempts": run_trace(&steps)}))
        .collect();
    Some(json!({ "capabilities": CAPS, "traces": traces }))
}
