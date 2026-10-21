//! EM-04B differential validation of the reasoning-signals tool: DSH vs Native, three ways.
//!
//! * **DSH**: the ORIGINAL `Muse-ReasoningSignals.cjs` `applyReasoningSignal` (what the DSH tool's
//!   `execute` calls), on a real routing-state file, with the historical observer for tools.
//! * **Bridge**: the Core's strict validation (`signals::validate`), then the historical code through
//!   the Native bridge with the blocks carried as the engine carries them.
//! * **Engine**: the full Native path: `SignalObservation`s and activity observations in the
//!   snapshot, `muse-v1-signals` through `EngineHost::consult_signal` (the host validates every
//!   semantic move against the Rust re-statement `fold_signal`), shadow decisions at
//!   `BeforeRequest`, and "restart" = the EM-03 persist/restore round trip into a new generation.
//!
//! All three use the SAME trusted dispatch keys (computed from the Core's identity facts), so the
//! historical deduplication is compared too. Compared: every acknowledgement or refusal code,
//! every resolution (effort, requested, reason, trace, effective phase and source), and the final
//! semantic and activity state (timestamp and family label excluded, as in EM-04A).

use super::governor_bridge::{GovernorEvaluator, NodeGovernorBridge};
use super::governor_parity::{
    comparable_activity, comparable_reasoning, config_dir, dsh_tool, native_tool, node, Tool,
};
use super::muse_v1::{MuseV1State, MUSE_V1_SIGNALS};
use super::{EngineEnv, EngineExtension, EngineHost, EngineSnapshot, EngineStateData, Hook};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

const ALL: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug)]
pub(crate) enum S {
    Signal(Value),
    /// The previous valid signal delivered again with its SAME dispatch identity (a replay).
    Redeliver,
    Tool(Tool),
    Resolve,
    /// A restart / continuation: DSH reloads its modules on the same file; Native persists,
    /// restores and continues in a NEW task generation.
    Restart,
}
use S::*;

/// The trusted key of every signal step (None for an invalid signal), as the Core computes it.
fn keys(steps: &[S]) -> Vec<Option<(String, Value)>> {
    let (mut gen, mut index, mut resolves) = (1u32, 0u32, 0u32);
    let mut last: Option<(String, Value)> = None;
    let mut out = Vec::new();
    for s in steps {
        match s {
            Signal(v) => {
                index += 1;
                let valid = crate::signals::validate(v, v.to_string().len()).is_ok();
                let k = valid.then(|| {
                    (
                        crate::signals::dispatch_key(
                            &format!("gen-{gen}"),
                            resolves + 1,
                            &format!("call_{index}"),
                            v,
                        ),
                        v.clone(),
                    )
                });
                if k.is_some() {
                    last = k.clone();
                }
                out.push(k);
            }
            Redeliver => {
                index += 1;
                out.push(last.clone());
            }
            Tool(_) => {
                index += 1;
                out.push(None);
            }
            Resolve => {
                resolves += 1;
                out.push(None);
            }
            Restart => {
                gen += 1;
                index = 0;
                resolves = 0;
                out.push(None);
            }
        }
    }
    out
}

pub(crate) struct Run {
    pub acks: Vec<Value>,
    pub resolutions: Vec<Value>,
    pub reasoning: Value,
    pub activity: Value,
}

fn subset(r: &Value) -> Value {
    if r["outcome"] == "resolved" {
        json!({
            "outcome": "resolved", "effort": r["effort"], "requested": r["requested"],
            "reason": r["reason"], "trace": r["trace"], "effectivePhase": r["effectivePhase"],
            "effectiveSource": r["effectiveSource"],
        })
    } else {
        json!({"outcome": r["outcome"], "requested": r["requested"]})
    }
}

pub(crate) fn run_dsh(caps: &[&str], steps: &[S]) -> Run {
    let ks = keys(steps);
    let steps_json: Vec<Value> = steps
        .iter()
        .zip(&ks)
        .map(|(s, k)| match s {
            Signal(v) => json!({"t": "signal", "signal": v,
                "dispatchKey": k.as_ref().map(|x| x.0.clone()).unwrap_or_else(|| "invalid".into())}),
            Redeliver => {
                let (key, sig) = k.clone().expect("a previous valid signal");
                json!({"t": "signal", "signal": sig, "dispatchKey": key})
            }
            Tool(t) => {
                let (exec, result) = dsh_tool(*t);
                json!({"t": "tool", "exec": exec, "result": result})
            }
            Resolve => json!({"t": "resolve"}),
            Restart => json!({"t": "restart"}),
        })
        .collect();
    let input = json!({"configDir": config_dir(), "capabilities": caps, "steps": steps_json});
    let mut child = Command::new(node().unwrap())
        .arg("-e")
        .arg(include_str!("dsh_reference.cjs"))
        .env("AIH_INSTALL_ROOT", std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["ok"], true, "{v}");
    Run {
        acks: v["acks"].as_array().unwrap().clone(),
        resolutions: v["resolutions"]
            .as_array()
            .unwrap()
            .iter()
            .map(subset)
            .collect(),
        reasoning: v["final"]["museReasoning"].clone(),
        activity: v["final"]["museActivity"].clone(),
    }
}

fn env() -> EngineEnv {
    EngineEnv {
        governor: Some(Arc::new(NodeGovernorBridge::new(node().unwrap()))),
    }
}

/// The full Native path through the experimental engine.
pub(crate) fn run_engine(caps: &[&str], steps: &[S]) -> Run {
    let ks = keys(steps);
    let env = env();
    let mut host = EngineHost::new(&MUSE_V1_SIGNALS);
    let (mut gen, mut index, mut resolves) = (1u32, 0u32, 0u32);
    let mut snap = EngineSnapshot {
        current_effort: "low".into(),
        authorized_efforts: caps.iter().map(|x| x.to_string()).collect(),
        generation: "gen-1".into(),
        ..Default::default()
    };
    let (mut acks, mut resolutions) = (Vec::new(), Vec::new());
    for (s, k) in steps.iter().zip(&ks) {
        match s {
            Signal(_) | Redeliver => {
                index += 1;
                let v = match s {
                    Signal(v) => v.clone(),
                    _ => k.clone().unwrap().1,
                };
                if let Err(r) = crate::signals::validate(&v, v.to_string().len()) {
                    acks.push(json!({"refused": r.code}));
                    continue;
                }
                snap.attempts_dispatched = resolves;
                snap.signals.push(super::SignalObservation {
                    seq: index,
                    attempt: resolves + 1,
                    generation: snap.generation.clone(),
                    call_id: format!("call_{index}"),
                    dispatch_key: k.clone().unwrap().0,
                    signal: v,
                });
                let ack = host.consult_signal(&snap, &env).expect("admitted");
                acks.push(serde_json::from_str(&ack).unwrap());
            }
            Tool(t) => {
                index += 1;
                let (mut act, args) = native_tool(*t, index);
                act.execution_id = act.execution_id.map(|e| format!("{e}-{}", snap.generation));
                let verification =
                    act.tool == "proc_run" && crate::inspect::is_verification_command(&args);
                if let Some(o) =
                    crate::inspect::observe(&act, verification, resolves + 1, &snap.generation)
                {
                    snap.activity.push(o);
                }
            }
            Resolve => {
                snap.attempts_dispatched = resolves;
                host.consult_in(Hook::BeforeRequest, &snap, &env).unwrap();
                let EngineStateData::MuseV1(d) = &host.state().data else {
                    unreachable!()
                };
                let dec = d.history.last().unwrap();
                resolutions.push(if dec.outcome == "resolved" {
                    json!({
                        "outcome": "resolved", "effort": dec.governor_effort,
                        "requested": dec.requested, "reason": dec.reason, "trace": dec.trace,
                        "effectivePhase": dec.effective_phase, "effectiveSource": dec.effective_source,
                    })
                } else {
                    json!({"outcome": dec.outcome, "requested": dec.requested})
                });
                resolves += 1;
            }
            Restart => {
                let payload = MUSE_V1_SIGNALS.persist_state(host.state());
                let st = MUSE_V1_SIGNALS
                    .restore_state(&payload, 0)
                    .expect("restores");
                host = EngineHost::restored(&MUSE_V1_SIGNALS, st, 0, None);
                gen += 1;
                index = 0;
                resolves = 0;
                snap.generation = format!("gen-{gen}");
                snap.activity.clear();
                snap.signals.clear();
            }
        }
    }
    let EngineStateData::MuseV1(d) = &host.state().data else {
        unreachable!()
    };
    let d: &MuseV1State = d;
    Run {
        acks,
        resolutions,
        reasoning: d.reasoning.clone().unwrap_or(Value::Null),
        activity: d.activity.clone().unwrap_or(Value::Null),
    }
}

/// The Core + bridge path without the engine (the historical code with carried blocks).
pub(crate) fn run_bridge(caps: &[&str], steps: &[S]) -> Vec<Value> {
    let ks = keys(steps);
    let b = NodeGovernorBridge::new(node().unwrap());
    let (mut reasoning, mut activity) = (Value::Null, Value::Null);
    let mut acks = Vec::new();
    let mut pending: Vec<Value> = Vec::new();
    let mut index = 0;
    for (s, k) in steps.iter().zip(&ks) {
        match s {
            Signal(_) | Redeliver => {
                let v = match s {
                    Signal(v) => v.clone(),
                    _ => k.clone().unwrap().1,
                };
                if let Err(r) = crate::signals::validate(&v, v.to_string().len()) {
                    acks.push(json!({"refused": r.code}));
                    continue;
                }
                pending.push(
                    json!({"type": "signal", "signal": v, "dispatchKey": k.clone().unwrap().0}),
                );
                let r = b
                    .call(
                        "evaluate",
                        &json!({"museReasoning": reasoning, "museActivity": activity,
                        "events": pending, "capabilities": caps, "resolve": false}),
                    )
                    .unwrap();
                pending.clear();
                reasoning = r["museReasoning"].clone();
                activity = r["museActivity"].clone();
                acks.push(r["acks"].as_array().unwrap().last().unwrap().clone());
            }
            Tool(t) => {
                index += 1;
                let (act, args) = native_tool(*t, index);
                let verification =
                    act.tool == "proc_run" && crate::inspect::is_verification_command(&args);
                if let Some(o) = crate::inspect::observe(&act, verification, 1, "g") {
                    pending.push(json!({"type": "activity",
                        "classification": super::muse_v1::classification(&o.kind)}));
                }
            }
            Resolve | Restart => {}
        }
    }
    acks
}

/// All three paths agree.
pub(crate) fn parity(name: &str, caps: &[&str], steps: &[S]) -> Run {
    let d = run_dsh(caps, steps);
    let e = run_engine(caps, steps);
    assert_eq!(
        d.acks, e.acks,
        "{name}: acknowledgements differ (DSH vs engine)"
    );
    assert_eq!(d.resolutions, e.resolutions, "{name}: resolutions differ");
    assert_eq!(
        comparable_reasoning(&d.reasoning),
        comparable_reasoning(&e.reasoning),
        "{name}: museReasoning differs"
    );
    assert_eq!(
        comparable_activity(&d.activity),
        comparable_activity(&e.activity),
        "{name}: museActivity differs"
    );
    if !steps.iter().any(|s| matches!(s, Restart | Resolve)) {
        assert_eq!(
            d.acks,
            run_bridge(caps, steps),
            "{name}: bridge path differs"
        );
    }
    e
}

fn efforts(r: &Run) -> Vec<String> {
    r.resolutions
        .iter()
        .map(|x| {
            x["effort"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("refused:{}", x["outcome"].as_str().unwrap_or("?")))
        })
        .collect()
}

macro_rules! need_node {
    () => {
        if node().is_none() {
            eprintln!("node unavailable: signals parity skipped");
            return;
        }
    };
}

#[test]
fn signals_parity_the_historical_escalation_and_progress_windows_through_the_tool() {
    need_node!();
    let r = parity(
        "escalation",
        ALL,
        &[
            Resolve,
            Signal(json!({"phase": "diagnose"})),
            Resolve,
            Signal(json!({"recordHypothesisFailure": true})),
            Signal(json!({"recordHypothesisFailure": true})),
            Resolve,
            Signal(json!({"markRootCauseEstablished": true, "phase": "Design"})),
            Resolve,
            Signal(json!({"phase": "implement", "markSolutionEstablished": true})),
            Resolve,
            Signal(json!({"recordImplementationFailure": true})),
            Signal(json!({"recordImplementationFailure": true})),
            Resolve,
            Signal(json!({"invalidateSolution": true})),
            Resolve,
        ],
    );
    assert_eq!(
        efforts(&r),
        ["medium", "high", "xhigh", "high", "medium", "xhigh", "xhigh"]
    );
    assert_eq!(r.reasoning["totalFailedHypotheses"], 2);
    assert_eq!(r.reasoning["failedHypotheses"], 0);
    assert_eq!(r.acks.len(), 8);
    assert!(r
        .acks
        .iter()
        .all(|a| a["ok"] == true && a.get("effort").is_none()));
}

#[test]
fn signals_parity_malformed_forbidden_and_effort_selecting_input_is_refused_identically() {
    need_node!();
    let bad = [
        json!({"effort": "xhigh"}),
        json!({"reasoningEffort": "max"}),
        json!({"reasoning_effort": "high"}),
        json!({"high": true}),
        json!({"max": true}),
        json!({"requestMax": true}),
        json!({"failedHypotheses": 9}),
        json!({"currentEffort": "max"}),
        json!({"state": {}}),
        json!({"taskInstanceId": "other-task"}),
        json!({"model": "x"}),
        json!({"provider": "x"}),
        json!({"phase": "hacking"}),
        json!({"phase": 7}),
        json!({"phase": ""}),
        json!({"recordHypothesisFailure": 1}),
        json!({"markSolutionEstablished": "true"}),
        json!({"unknown": true}),
        json!([]),
        json!("phase"),
        json!(null),
    ];
    let mut steps: Vec<S> = bad.iter().cloned().map(Signal).collect();
    steps.push(Signal(
        json!({"phase": "verify", "conflictingEvidence": false}),
    ));
    steps.push(Resolve);
    let r = parity("refusals", ALL, &steps);
    let codes: Vec<&str> = r
        .acks
        .iter()
        .filter_map(|a| a["refused"].as_str())
        .collect();
    assert_eq!(codes.len(), bad.len(), "every malformed signal refused");
    assert_eq!(r.acks.last().unwrap()["ok"], true);
    assert_eq!(
        efforts(&r),
        ["medium"],
        "a refused signal never changed the state"
    );
}

#[test]
fn signals_parity_duplicate_delivery_applies_once_distinct_calls_apply_again() {
    need_node!();
    let r = parity(
        "duplicates",
        ALL,
        &[
            Signal(json!({"phase": "diagnose", "recordHypothesisFailure": true})),
            Redeliver,
            Redeliver,
            Signal(json!({"phase": "diagnose", "recordHypothesisFailure": true})),
            Resolve,
        ],
    );
    let dup: Vec<bool> = r.acks.iter().map(|a| a["duplicate"] == true).collect();
    assert_eq!(dup, [false, true, true, false]);
    assert_eq!(
        r.reasoning["failedHypotheses"], 2,
        "replays never count twice"
    );
    assert_eq!(efforts(&r), ["xhigh"]);
}

#[test]
fn signals_parity_conflicting_model_claims_follow_the_historical_precedence() {
    need_node!();
    let r = parity(
        "conflicts",
        ALL,
        &[
            // marking and invalidating in one call: invalidation wins (no reset)
            Signal(json!({"phase": "diagnose", "recordHypothesisFailure": true,
                "markRootCauseEstablished": true, "invalidateRootCause": true})),
            Resolve,
            // conflict and a new root cause in one call: the establishment edge clears the conflict
            Signal(json!({"conflictingEvidence": true, "markRootCauseEstablished": true})),
            Resolve,
            Signal(json!({"conflictingEvidence": true})),
            Resolve,
            Signal(json!({"resolveConflictingEvidence": true, "conflictingEvidence": true})),
            Resolve,
            // explicit false is a no-op, never a reset
            Signal(json!({"markRootCauseEstablished": false, "conflictingEvidence": false})),
            Resolve,
        ],
    );
    assert_eq!(efforts(&r), ["high", "high", "xhigh", "high", "high"]);
}

#[test]
fn signals_parity_verified_activity_overrides_unsupported_claims() {
    need_node!();
    let r = parity(
        "claims-vs-evidence",
        ALL,
        &[
            // the model claims its solution is established and moves to verify ...
            Signal(json!({"phase": "verify", "markRootCauseEstablished": true,
                "markSolutionEstablished": true})),
            Resolve,
            // ... but the Kernel-verified check FAILS: trusted evidence is newer than the claim
            Tool(Tool::TestFail),
            Resolve,
            // claiming "review" does not erase the failure; it is an explicit semantic transition,
            // which supersedes OLDER evidence only (historical ordering rule)
            Signal(json!({"phase": "review"})),
            Resolve,
            // a later verified edit is evidence of implementation
            Tool(Tool::Edit),
            Resolve,
            // an unproven claim of success changes nothing about the evidence
            Signal(json!({"markSolutionEstablished": true})),
            Resolve,
        ],
    );
    let sources: Vec<&str> = r
        .resolutions
        .iter()
        .map(|x| x["effectiveSource"].as_str().unwrap())
        .collect();
    assert_eq!(
        sources,
        [
            "semantic",
            "recovery-needed",
            "semantic",
            "implementation-active",
            "implementation-active"
        ]
    );
    assert_eq!(efforts(&r), ["medium", "high", "high", "medium", "medium"]);
}

#[test]
fn signals_parity_restart_inherits_signals_and_recovery_never_manufactures_one() {
    need_node!();
    let r = parity(
        "restart",
        ALL,
        &[
            Signal(json!({"phase": "diagnose", "recordHypothesisFailure": true})),
            Resolve,
            Restart,
            // the same delivery replayed after the restart: still a duplicate (inherited window)
            Redeliver,
            Resolve,
            Signal(json!({"recordHypothesisFailure": true})),
            Resolve,
            Restart,
            Resolve,
        ],
    );
    assert_eq!(efforts(&r), ["high", "high", "xhigh", "xhigh"]);
    assert_eq!(r.acks[1]["duplicate"], true);
    assert_eq!(r.reasoning["totalFailedHypotheses"], 2);
}

#[test]
fn signals_parity_the_acknowledgement_text_is_the_historical_render() {
    need_node!();
    let script = format!(
        "const s = require({:?}); const d = s.defineReasoningSignalTool((x) => x);\
         const vals = [{{ok:true,duplicate:false,applied:['phase'],phase:'verify',activityState:'none',\
         rootCauseEstablished:true,solutionEstablished:false,failedHypotheses:0,failedImplementationAttempts:2,\
         totalFailedHypotheses:3,totalFailedImplementationAttempts:2,conflictingEvidence:false}},\
         {{ok:true,duplicate:true,applied:[],phase:'diagnose',activityState:'recovery-needed',\
         rootCauseEstablished:false,solutionEstablished:false,failedHypotheses:1,failedImplementationAttempts:0,\
         totalFailedHypotheses:1,totalFailedImplementationAttempts:0,conflictingEvidence:true}}];\
         process.stdout.write(JSON.stringify(vals.map((v) => [v, d.output.render({{}}, v)[0].text])));",
        format!("{}/Muse-ReasoningSignals.cjs", config_dir())
    );
    let out = Command::new(node().unwrap())
        .arg("-e")
        .arg(script)
        .env("AIH_INSTALL_ROOT", std::env::temp_dir())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let pairs: Vec<(Value, String)> = serde_json::from_slice(&out.stdout).unwrap();
    for (v, text) in pairs {
        assert_eq!(crate::signals::render_ack(&v), text);
    }
}

#[test]
fn the_native_tool_definition_is_the_historical_one_byte_for_byte() {
    need_node!();
    let script = format!(
        "const s = require({:?}); const raw = s.defineReasoningSignalTool((d) => d);\
         process.stdout.write(JSON.stringify({{ type: 'function', name: raw.name, description: raw.description,\
         parameters: {{ type: 'object', properties: raw.parameters, additionalProperties: false }} }}));",
        format!("{}/Muse-ReasoningSignals.cjs", config_dir())
    );
    let out = Command::new(node().unwrap())
        .arg("-e")
        .arg(script)
        .env("AIH_INSTALL_ROOT", std::env::temp_dir())
        .output()
        .unwrap();
    let dsh: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        nexus_contracts::canonical_json(&dsh),
        nexus_contracts::canonical_json(&nexus_model::repo_tools::muse_signals_definition())
    );
}

#[test]
fn the_core_validator_agrees_with_the_historical_validator_on_a_corpus() {
    need_node!();
    let corpus = vec![
        json!({}),
        json!({"phase": " VERIFY "}),
        json!({"phase": "verify", "effort": "max"}),
        json!({"bogus": 1, "effort": "max"}),
        json!({"effort": "max", "bogus": 1}),
        json!({"phase": null}),
        json!({"recordHypothesisFailure": null}),
        json!({"recordHypothesisFailure": false}),
        json!({"recordImplementationFailure": true, "invalidateSolution": true}),
        json!({"conflictingEvidence": "yes"}),
        json!({"Phase": "verify"}),
        json!({"phase": "verify\u{0000}"}),
        json!({"phase": "rEvIeW"}),
        json!({"phase": "\u{FEFF}verify\u{3000}"}),
        json!({"phase": "\u{0085}verify"}),
        json!({"phase": "\tdesign\n"}),
        json!(42),
        json!({"sessionId": "s"}),
        json!({"routingState": {}}),
    ];
    let script = format!(
        "const s = require({:?}); process.stdout.write(JSON.stringify({}.map((x) => {{\
         try {{ s.validateReasoningSignal(x); return null; }} catch (e) {{ return e.code; }} }})));",
        format!("{}/Muse-ReasoningSignals.cjs", config_dir()),
        serde_json::to_string(&corpus).unwrap()
    );
    let out = Command::new(node().unwrap())
        .arg("-e")
        .arg(script)
        .env("AIH_INSTALL_ROOT", std::env::temp_dir())
        .output()
        .unwrap();
    let dsh: Vec<Value> = serde_json::from_slice(&out.stdout).unwrap();
    for (x, d) in corpus.iter().zip(dsh) {
        let native = crate::signals::validate(x, x.to_string().len())
            .err()
            .map(|r| r.code);
        let mixed = x.as_object().is_some_and(|o| {
            o.keys()
                .any(|k| crate::signals::FORBIDDEN_SIGNAL_FIELDS.contains(&k.as_str()))
                && o.keys().any(|k| {
                    !crate::signals::FORBIDDEN_SIGNAL_FIELDS.contains(&k.as_str())
                        && !crate::signals::SIGNAL_FIELDS.contains(&k.as_str())
                })
        });
        if mixed {
            // parity S-2: both refuse; Native names the forbidden field first
            assert!(d.is_string(), "{x}");
            assert_eq!(native, Some("forbidden-field"), "{x}");
        } else {
            assert_eq!(native, d.as_str(), "{x}");
        }
    }
}
