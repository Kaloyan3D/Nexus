//! EM-04A: `muse-v1-shadow` - the shadow guarantee and adversarial inputs (forged activity,
//! stale or replayed observations, cross-task events, forged transitions, corrupt state).

use super::governor_bridge::{BridgeError, GovernorEvaluator};
use super::muse_v0::MUSE_V0;
use super::muse_v1::{
    extend_chain, valid_activity_block, MuseV1State, ShadowDecision, ENGINE_ID,
    MAX_DECISION_HISTORY, MUSE_V1, SIGNALS_TOOL_RESERVE_BYTES,
};
use super::worker_bridge::test_evaluator;
use super::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn node_env() -> Option<EngineEnv> {
    let ok = std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()?
        .status
        .success();
    ok.then(|| EngineEnv {
        governor: Some(test_evaluator("node".into())),
    })
}

/// A scripted evaluator (records what it was asked).
struct Fake {
    answer: Mutex<Result<Value, BridgeError>>,
    calls: Mutex<Vec<Value>>,
}

impl GovernorEvaluator for Fake {
    fn call(&self, _op: &str, args: &Value) -> Result<Value, BridgeError> {
        self.calls.lock().unwrap().push(args.clone());
        self.answer.lock().unwrap().clone()
    }
}

fn fake(answer: Result<Value, BridgeError>) -> (Arc<Fake>, EngineEnv) {
    let f = Arc::new(Fake {
        answer: Mutex::new(answer),
        calls: Mutex::new(Vec::new()),
    });
    (f.clone(), EngineEnv { governor: Some(f) })
}

fn obs(seq: u32, generation: &str, exec: &str, kind: ObservationKind) -> ActivityObservation {
    ActivityObservation {
        seq,
        attempt: 1,
        generation: generation.into(),
        execution_id: exec.into(),
        kind,
    }
}

fn failed_check() -> ObservationKind {
    ObservationKind::Verification {
        outcome: VerificationOutcome::Failed,
        family: "cargo".into(),
    }
}

fn snap(dispatched: u32, activity: Vec<ActivityObservation>) -> EngineSnapshot {
    EngineSnapshot {
        kind: Some(RunKind::Code),
        interactive: true,
        attempts_dispatched: dispatched,
        current_effort: "low".into(),
        authorized_efforts: vec!["low".into(), "medium".into(), "high".into(), "xhigh".into()],
        generation: "task-A".into(),
        activity,
        ..Default::default()
    }
}

fn st(h: &EngineHost) -> &MuseV1State {
    match &h.state().data {
        EngineStateData::MuseV1(d) => d,
        _ => panic!("not muse-v1-shadow state"),
    }
}

fn last(h: &EngineHost) -> ShadowDecision {
    st(h).history.last().cloned().expect("a decision")
}

#[test]
fn the_shadow_engine_is_not_selectable_in_a_production_build() {
    const { assert!(MUSE_V1_PRODUCTION_ENABLED) };
    let prod: Vec<&str> = engines(false)
        .iter()
        .map(|e| e.descriptor().engine_id)
        .collect();
    assert_eq!(
        prod,
        ["muse-v0", "nexus-adaptive-v1"],
        "production builds register the default engine and the opt-in adaptive engine, never an experimental one"
    );
    assert!(engines(true)
        .iter()
        .any(|e| e.descriptor().engine_id == ENGINE_ID));
    let d = MUSE_V1.descriptor();
    assert!(!d.may_propose_effort, "shadow: no effort authority");
    assert!(d.inherits_state);
    assert_eq!(d.request_reserve_bytes, SIGNALS_TOOL_RESERVE_BYTES);
    assert_eq!(MUSE_V0.descriptor().request_reserve_bytes, 0);
}

#[test]
fn the_governor_decision_is_recorded_but_never_applied() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    let d = h
        .consult_in(Hook::BeforeRequest, &snap(0, vec![]), &env)
        .unwrap();
    assert_eq!(d, EngineDecision::Continue);
    let s = last(&h);
    assert_eq!(s.outcome, "resolved");
    assert_eq!(s.governor_effort.as_deref(), Some("medium"));
    assert_eq!(
        s.would, "change:medium",
        "an active Governor would raise low -> medium"
    );
    assert_eq!(s.in_force, "low");
    assert_eq!(s.attempt, 1);
    // ...but nothing is selected: the attempt keeps the pinned effort
    assert!(h.effort_selection().is_none());
    assert_eq!(h.effort_for_attempt(1), None);
    assert!(h.receipts().iter().all(|r| r.effort.is_none()));
    // a failed check later: the shadow escalates to the recover policy, still not applied
    let s2 = snap(1, vec![obs(3, "task-A", "ex-1", failed_check())]);
    h.consult_in(Hook::BeforeRequest, &s2, &env).unwrap();
    let s = last(&h);
    assert_eq!(s.effective_phase.as_deref(), Some("recover"));
    assert_eq!(s.governor_effort.as_deref(), Some("high"));
    assert_eq!(s.folded, 1);
    assert!(h.effort_selection().is_none());
    // even a forged Change proposal from this engine is refused by the host
    let mut p = MUSE_V1.propose(Hook::BeforeRequest, &s2, h.state(), h.next_proposal_id());
    p.effort = EffortProposal::Change("high".into());
    let r = h.accept(Hook::BeforeRequest, &s2, p).unwrap_err();
    assert_eq!(r.code, "engine-effort-not-authorized");
}

#[test]
fn the_strategy_is_muse_v0_decision_for_decision() {
    let (_, env) = fake(Err(BridgeError {
        code: "bridge-unavailable".into(),
        message: String::new(),
    }));
    let mut a = EngineHost::new(&MUSE_V0);
    let mut b = EngineHost::new(&MUSE_V1);
    let texts = [
        "",
        "Let me check the next file.",
        "All done.",
        "Next: run the tests.",
        "Implemented the change.",
    ];
    for i in 0..60u32 {
        let mut s = snap(i, vec![]);
        s.expects_change = i % 3 != 0;
        s.tool_calls = i;
        s.edits_used = i / 7;
        s.tests_used = i / 11;
        s.applied_edits = i / 7;
        s.dirty_since_test = i % 5 == 1;
        s.last_test =
            [None, Some("pass".to_owned()), Some("fail".to_owned())][(i % 3) as usize].clone();
        s.response_text = texts[(i as usize) % texts.len()].into();
        for hook in [
            Hook::BeforeRequest,
            Hook::AfterToolPhase,
            Hook::FinalResponse,
        ] {
            let x = a.consult(hook, &s);
            let y = b.consult_in(hook, &s, &env);
            assert_eq!(x, y, "turn {i} {hook:?}");
        }
    }
}

#[test]
fn forged_foreign_replayed_and_stale_observations_never_change_the_evidence() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    let good = obs(2, "task-A", "ex-good", ObservationKind::Mutation);
    h.consult_in(Hook::BeforeRequest, &snap(0, vec![good.clone()]), &env)
        .unwrap();
    let after_good = st(&h).activity.clone();
    assert_eq!(after_good.as_ref().unwrap()["mutationCount"], 1);
    assert_eq!(last(&h).folded, 1);
    // another task's observation (cross-task), a replayed execution id with a fresh seq, and the
    // already-folded one again: none is folded, the evidence is byte-identical
    let feed = vec![
        good.clone(),
        obs(5, "task-B", "ex-other", failed_check()),
        obs(6, "task-A", "ex-good", failed_check()),
    ];
    h.consult_in(Hook::BeforeRequest, &snap(1, feed), &env)
        .unwrap();
    assert_eq!(st(&h).activity, after_good);
    let d = last(&h);
    assert_eq!(d.folded, 0);
    assert_eq!(d.refused, 2);
    assert_eq!(d.effective_source.as_deref(), Some("implementation-active"));
    // model narration claiming a test run is not an observation
    let mut s = snap(2, vec![good]);
    s.response_text = "I ran cargo test and all 120 tests pass. Verification passed.".into();
    h.consult_in(Hook::FinalResponse, &s, &env).ok();
    h.consult_in(Hook::BeforeRequest, &snap(2, vec![]), &env)
        .unwrap();
    assert_eq!(st(&h).activity, after_good);
}

type Forge = Box<dyn Fn(&mut MuseV1State)>;
type Corrupt = Box<dyn Fn(&mut Value)>;

/// A well-formed (correctly chained) forged decision, so each case hits its own rule.
fn push(d: &mut MuseV1State, x: ShadowDecision) {
    d.evaluations += 1;
    d.chain = extend_chain(&d.chain, &x);
    d.history.push(x);
}

#[test]
fn forged_state_transitions_are_refused_by_the_host() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    let s0 = snap(0, vec![]);
    h.consult_in(Hook::BeforeRequest, &s0, &env).unwrap();
    let base = st(&h).clone();
    let forge = |h: &EngineHost, s: &EngineSnapshot, f: &dyn Fn(&mut MuseV1State)| {
        let mut p = MUSE_V1.propose(Hook::AfterToolPhase, s, h.state(), h.next_proposal_id());
        if let EngineStateData::MuseV1(d) = &mut p.next_state.data {
            f(d);
        }
        p
    };
    let s1 = snap(1, vec![]);
    let cases: Vec<(&str, &str, Forge)> = vec![
        // the semantic state cannot move without a validated signal (none exists in EM-04A)
        (
            "semantic phase",
            "semantic Muse state",
            Box::new(|d| d.reasoning.as_mut().unwrap()["phase"] = json!("implement")),
        ),
        (
            "failure counter",
            "semantic Muse state",
            Box::new(|d| d.reasoning.as_mut().unwrap()["failedHypotheses"] = json!(2)),
        ),
        (
            "max request",
            "semantic Muse state",
            Box::new(|d| d.reasoning.as_mut().unwrap()["requestMax"] = json!(true)),
        ),
        // evidence without an observation
        (
            "activity",
            "activity evidence changed",
            Box::new(|d| {
                d.activity = Some(
                    json!({"schemaVersion": 1, "revision": 1, "semanticRevision": 0, "lastMutationRevision": 0, "mutationCount": 0, "verification": {"status": "failed", "revision": 1, "family": null}}),
                )
            }),
        ),
        (
            "frontier",
            "frontier must follow",
            Box::new(|d| d.observed_through = 9),
        ),
        (
            "foreign generation",
            "frontier may only move",
            Box::new(|d| d.generation = "task-B".into()),
        ),
        (
            "unauthorized shadow",
            "within the authorized levels",
            Box::new(|d| {
                push(
                    d,
                    ShadowDecision {
                        attempt: 2,
                        in_force: "low".into(),
                        would: "change:max".into(),
                        ..Default::default()
                    },
                )
            }),
        ),
        (
            "wrong attempt",
            "describe the next attempt",
            Box::new(|d| {
                push(
                    d,
                    ShadowDecision {
                        attempt: 7,
                        in_force: "low".into(),
                        would: "keep".into(),
                        ..Default::default()
                    },
                )
            }),
        ),
        (
            "off-ladder",
            "historical ladder",
            Box::new(|d| {
                push(
                    d,
                    ShadowDecision {
                        attempt: 2,
                        in_force: "low".into(),
                        would: "keep".into(),
                        governor_effort: Some("low".into()),
                        ..Default::default()
                    },
                )
            }),
        ),
        (
            "broken chain",
            "extend the previous",
            Box::new(|d| {
                push(
                    d,
                    ShadowDecision {
                        attempt: 2,
                        in_force: "low".into(),
                        would: "keep".into(),
                        ..Default::default()
                    },
                );
                d.chain = "0".repeat(64);
            }),
        ),
        (
            "rewritten chain",
            "moves only with an evaluation",
            Box::new(|d| d.chain = "f".repeat(64)),
        ),
        (
            "two evaluations",
            "at most one",
            Box::new(|d| d.evaluations += 2),
        ),
        (
            "invalid block",
            "invalid museReasoning",
            Box::new(|d| d.reasoning.as_mut().unwrap()["currentEffort"] = json!("ultra")),
        ),
    ];
    for (name, rule, f) in cases {
        let p = forge(&h, &s1, &*f);
        let r = h.accept(Hook::AfterToolPhase, &s1, p).unwrap_err();
        assert_eq!(r.code, "engine-state-transition", "{name}: {}", r.message);
        assert!(
            r.message.contains(rule),
            "{name}: refused by another rule: {}",
            r.message
        );
        assert_eq!(st(&h), &base, "{name}: nothing changed");
    }
    // a stale proposal (based on an older revision) is refused as well
    let mut p = MUSE_V1.propose(Hook::BeforeRequest, &s1, h.state(), h.next_proposal_id());
    p.based_on_revision = 0;
    assert_eq!(
        h.accept(Hook::BeforeRequest, &s1, p).unwrap_err().code,
        "engine-state-stale"
    );
}

#[test]
fn an_unavailable_or_misbehaving_governor_changes_nothing_and_never_blocks_the_run() {
    let feed = vec![obs(1, "task-A", "ex-1", ObservationKind::Mutation)];
    // no evaluator lent: decision recorded as unavailable, observation stays unfolded
    let mut h = EngineHost::new(&MUSE_V1);
    let d = h
        .consult(Hook::BeforeRequest, &snap(0, feed.clone()))
        .unwrap();
    assert_eq!(d, EngineDecision::Continue);
    assert_eq!(last(&h).outcome, "bridge-unavailable");
    assert_eq!(st(&h).observed_through, 0);
    assert!(st(&h).activity.is_none());
    // the evaluator answers with a forged block: refused as invalid output, nothing adopted
    let (f, env) = fake(Ok(json!({
        "museReasoning": {"phase": "implement", "evil": true},
        "museActivity": null,
        "decision": {"outcome": "resolved", "effort": "max"},
    })));
    h.consult_in(Hook::BeforeRequest, &snap(0, feed.clone()), &env)
        .unwrap();
    assert_eq!(last(&h).outcome, "bridge-output-invalid");
    assert!(st(&h).reasoning.is_none());
    assert_eq!(st(&h).observed_through, 0);
    // folding an observation that produced no evidence is an invalid answer: nothing is folded
    *f.answer.lock().unwrap() = Ok(json!({
        "museReasoning": null, "museActivity": null,
        "decision": {"outcome": "resolved", "effort": "max"},
    }));
    h.consult_in(Hook::BeforeRequest, &snap(0, feed.clone()), &env)
        .unwrap();
    assert_eq!(last(&h).outcome, "bridge-output-invalid");
    assert_eq!(st(&h).observed_through, 0);
    // the evaluator's answer is never trusted for authorization: an unauthorized effort (max is
    // not in the binding) never becomes a "would change"
    let block = json!({"schemaVersion": 1, "revision": 1, "semanticRevision": 0,
        "lastMutationRevision": 1, "mutationCount": 1,
        "verification": {"status": "none", "revision": 0, "family": null}});
    *f.answer.lock().unwrap() = Ok(json!({
        "museReasoning": null, "museActivity": block,
        "decision": {"outcome": "resolved", "effort": "max"},
    }));
    h.consult_in(Hook::BeforeRequest, &snap(0, feed.clone()), &env)
        .unwrap();
    assert_eq!(last(&h).would, "keep");
    assert_eq!(last(&h).folded, 1);
    // every unfolded observation was offered again until it was folded
    let calls = f.calls.lock().unwrap().clone();
    assert!(calls
        .iter()
        .all(|c| c["events"].as_array().unwrap().len() == 1));
    // a timeout-like error
    *f.answer.lock().unwrap() = Err(BridgeError {
        code: "bridge-timeout".into(),
        message: String::new(),
    });
    let d = h
        .consult_in(Hook::BeforeRequest, &snap(0, feed), &env)
        .unwrap();
    assert_eq!(d, EngineDecision::Continue);
    assert_eq!(last(&h).outcome, "bridge-timeout");
}

#[test]
fn corrupt_or_foreign_persisted_state_is_refused_and_a_valid_one_round_trips() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    h.consult_in(
        Hook::BeforeRequest,
        &snap(0, vec![obs(1, "task-A", "ex-1", failed_check())]),
        &env,
    )
    .unwrap();
    let payload = MUSE_V1.persist_state(h.state());
    // no model text in the payload
    assert!(!payload.to_string().contains("tests pass"));
    let back = MUSE_V1
        .restore_state(&payload, 3)
        .expect("valid payload restores");
    let EngineStateData::MuseV1(d) = &back.data else {
        panic!()
    };
    assert_eq!(d.activity, st(&h).activity, "the evidence is inherited");
    assert_eq!(d.history, st(&h).history);
    assert!(
        d.reasoning.as_ref().unwrap()["currentEffort"].is_null(),
        "effort restarts at the default"
    );
    assert_eq!(
        d.observed_through, 0,
        "the frontier restarts with the new generation"
    );
    assert_eq!(
        d.v0,
        Default::default(),
        "muse-v0 counters start over (as under muse-v0)"
    );
    let corrupt: Vec<(&str, Corrupt)> = vec![
        (
            "phase",
            Box::new(|p| p["museReasoning"]["phase"] = json!("hacking")),
        ),
        (
            "negative counter",
            Box::new(|p| p["museReasoning"]["failedHypotheses"] = json!(-1)),
        ),
        (
            "effort off-ladder",
            Box::new(|p| p["museReasoning"]["currentEffort"] = json!("low")),
        ),
        (
            "activity schema",
            Box::new(|p| p["museActivity"]["schemaVersion"] = json!(2)),
        ),
        (
            "activity revision",
            Box::new(|p| p["museActivity"]["verification"]["revision"] = json!(999)),
        ),
        ("unknown field", Box::new(|p| p["extra"] = json!(1))),
        (
            "missing field",
            Box::new(|p| {
                p.as_object_mut().unwrap().remove("seen");
            }),
        ),
        (
            "history bound",
            Box::new(|p| {
                let one = p["history"][0].clone();
                p["history"] = json!(vec![one; MAX_DECISION_HISTORY + 1]);
            }),
        ),
        (
            "history shape",
            Box::new(|p| p["history"][0]["attempt"] = json!("one")),
        ),
        (
            "model text smuggled",
            Box::new(|p| p["history"][0]["trace"] = json!(["x".repeat(500)])),
        ),
    ];
    for (name, f) in corrupt {
        let mut p = payload.clone();
        f(&mut p);
        assert!(MUSE_V1.restore_state(&p, 3).is_none(), "{name}");
    }
    assert!(valid_activity_block(&payload["museActivity"]));
}

#[test]
fn a_continuation_starts_a_new_frontier_and_keeps_folding_only_its_own_receipts() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    h.consult_in(
        Hook::BeforeRequest,
        &snap(
            0,
            vec![obs(4, "task-A", "ex-a4", ObservationKind::Mutation)],
        ),
        &env,
    )
    .unwrap();
    let payload = MUSE_V1.persist_state(h.state());
    let restored = MUSE_V1.restore_state(&payload, 0).unwrap();
    let mut h2 = EngineHost::restored(&MUSE_V1, restored, 0, None);
    // the new generation's seq starts at 1 again; the predecessor's execution id is still refused
    let mut s = snap(
        0,
        vec![
            obs(1, "task-C", "ex-c1", failed_check()),
            obs(2, "task-C", "ex-a4", ObservationKind::Mutation),
        ],
    );
    s.generation = "task-C".into();
    h2.consult_in(Hook::BeforeRequest, &s, &env).unwrap();
    let d = last(&h2);
    assert_eq!(d.folded, 1);
    assert_eq!(d.refused, 1);
    assert_eq!(d.effective_source.as_deref(), Some("recovery-needed"));
    assert_eq!(st(&h2).generation, "task-C");
    assert_eq!(st(&h2).evaluations, 2);
}

#[test]
fn the_state_stays_bounded_over_a_long_run() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    let mut feed = Vec::new();
    for i in 1..=40u32 {
        feed.push(obs(
            i * 2,
            "task-A",
            &format!("ex-{i:06}-{}", "z".repeat(40)),
            if i % 3 == 0 {
                failed_check()
            } else {
                ObservationKind::Mutation
            },
        ));
        h.consult_in(Hook::BeforeRequest, &snap(i, feed.clone()), &env)
            .unwrap();
    }
    let s = st(&h);
    assert_eq!(s.evaluations, 40);
    assert!(s.history.len() <= MAX_DECISION_HISTORY);
    assert!(s.encoded_len() <= MAX_STATE_BYTES, "{}", s.encoded_len());
}

/// The reserve is the EXACT wire size of the future signals tool: re-measured here from
/// `config/Muse-ReasoningSignals.cjs` in the Native tool-definition shape (canonical JSON, as
/// `prepare` serializes the `tools` array), plus its array separator. If the tool or its shape
/// changes, this fails and the reserve must be re-measured (EM-04B activation contract).
#[test]
fn the_signals_reserve_is_the_measured_wire_size_of_the_future_tool() {
    if node_env().is_none() {
        return;
    }
    let config = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config");
    let script = r#"
        const s = require(process.argv[1] + '/Muse-ReasoningSignals.cjs');
        const raw = s.defineReasoningSignalTool((d) => d);
        process.stdout.write(JSON.stringify({ type: 'function', name: raw.name,
          description: raw.description,
          parameters: { type: 'object', properties: raw.parameters, additionalProperties: false } }));
    "#;
    let out = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(std::fs::canonicalize(config).unwrap())
        .env("AIH_INSTALL_ROOT", std::env::temp_dir())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let def: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(def["name"], "muse_update_reasoning_state");
    let wire = nexus_contracts::canonical_json(&def).len();
    assert_eq!(wire, 2_881);
    assert_eq!(
        wire + 1,
        SIGNALS_TOOL_RESERVE_BYTES,
        "tool + its separator in `tools`"
    );
}

/// MEASUREMENT (run explicitly: `cargo test -p nexus-broker --lib -- --ignored --nocapture
/// em04a_measure`): latency of one shadow evaluation through the Node bridge, on a realistic
/// state (an evaluation with one new observation).
#[test]
#[ignore]
fn em04a_measure_bridge_latency() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1);
    let mut feed = Vec::new();
    let mut ms = Vec::new();
    for i in 1..=60u32 {
        feed.push(obs(
            i,
            "task-A",
            &format!("ex-{i}"),
            if i % 4 == 0 {
                failed_check()
            } else {
                ObservationKind::Mutation
            },
        ));
        let t = std::time::Instant::now();
        h.consult_in(Hook::BeforeRequest, &snap(i, feed.clone()), &env)
            .unwrap();
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "EM-04A bridge evaluation (consult incl. node spawn): n=60 median {:.1} ms p95 {:.1} ms max {:.1} ms",
        ms[30], ms[56], ms[59]
    );
}

// ---- EM-04C1: the persistent worker dying under a Governor evaluation --------------------

/// The worker dies while evaluating the Governor for a request: the decision is the same one a
/// worker that never failed gives, recorded once, and the shadow is still never applied.
#[test]
fn a_worker_dying_during_a_governor_evaluation_yields_the_same_single_decision() {
    let Some(healthy) = node_env() else { return };
    let m = std::env::temp_dir().join(format!("nexus-c1-{}-gov", std::process::id()));
    let _ = std::fs::remove_file(&m);
    let crashing = super::signals_tests::crash_once_env_for_governor(&m);
    let mut a = EngineHost::new(&MUSE_V1);
    let mut b = EngineHost::new(&MUSE_V1);
    let s1 = snap(0, vec![]);
    a.consult_in(Hook::BeforeRequest, &s1, &crashing).unwrap();
    b.consult_in(Hook::BeforeRequest, &s1, &healthy).unwrap();
    assert!(m.exists(), "the first worker really died");
    assert_eq!(last(&a), last(&b));
    assert_eq!(a.state(), b.state());
    assert_eq!(last(&a).outcome, "resolved");
    assert_eq!(a.state().data, b.state().data);
    assert!(a.effort_selection().is_none(), "shadow: nothing applied");
    let _ = std::fs::remove_file(&m);
}
