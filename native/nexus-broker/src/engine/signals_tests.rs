//! EM-04B: reasoning signals at the engine boundary. Admission is limited to the experimental
//! engine; stale, cross-task, replayed and forged signals are refused; the host validates every
//! semantic move; a signal never changes effort or an issued target; acceptance is durable.

use super::governor_bridge::{BridgeError, GovernorEvaluator};
use super::muse_v0::MUSE_V0;
use super::muse_v1::{MuseV1State, MUSE_V1, MUSE_V1_SIGNALS};
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

fn sig(seq: u32, generation: &str, signal: Value) -> SignalObservation {
    SignalObservation {
        seq,
        attempt: 1,
        generation: generation.into(),
        call_id: format!("call_{seq}"),
        dispatch_key: crate::signals::dispatch_key(generation, 1, &format!("call_{seq}"), &signal),
        signal,
    }
}

fn snap(signals: Vec<SignalObservation>) -> EngineSnapshot {
    EngineSnapshot {
        kind: Some(RunKind::Code),
        interactive: true,
        current_effort: "low".into(),
        authorized_efforts: vec!["low".into(), "medium".into(), "high".into(), "xhigh".into()],
        generation: "task-A".into(),
        signals,
        ..Default::default()
    }
}

fn st(h: &EngineHost) -> &MuseV1State {
    match &h.state().data {
        EngineStateData::MuseV1(d) => d,
        _ => panic!("not a nexus-adaptive-v1 state"),
    }
}

fn ack(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

#[test]
fn only_the_experimental_engine_takes_signals() {
    let s = snap(vec![sig(1, "task-A", json!({"phase": "verify"}))]);
    for ext in [&MUSE_V0 as &'static dyn EngineExtension, &MUSE_V1] {
        let mut h = EngineHost::new(ext);
        let before = h.state().clone();
        let r = h.consult_signal(&s, &EngineEnv::default()).unwrap_err();
        assert_eq!(
            r.code,
            "engine-signals-unsupported",
            "{}",
            ext.descriptor().engine_id
        );
        assert_eq!(h.state(), &before);
    }
    assert!(!MUSE_V1_SIGNALS.descriptor().may_propose_effort);
    assert_eq!(MUSE_V1_SIGNALS.descriptor().request_reserve_bytes, 0);
    const { assert!(MUSE_V1_PRODUCTION_ENABLED) };
    // the signals-capable ACTIVE engine is registered since S10-A; the EXPERIMENTAL signals engine never is
    let prod: Vec<&str> = engines(false)
        .iter()
        .map(|e| e.descriptor().engine_id)
        .collect();
    assert_eq!(prod, ["muse-v0", "muse-v0-jobs", "nexus-adaptive-v1"]);
    assert!(!prod.contains(&"muse-v1-signals"));
}

#[test]
fn an_accepted_signal_is_applied_once_and_never_changes_effort() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    let one = sig(
        1,
        "task-A",
        json!({"phase": "diagnose", "recordHypothesisFailure": true}),
    );
    let a = ack(&h.consult_signal(&snap(vec![one.clone()]), &env).unwrap());
    assert_eq!(a["ok"], true);
    assert_eq!(a["duplicate"], false);
    assert!(a.get("effort").is_none() && !a.to_string().contains("xhigh"));
    let r = st(&h).reasoning.clone().unwrap();
    assert_eq!(
        (r["phase"].as_str(), r["failedHypotheses"].as_u64()),
        (Some("diagnose"), Some(1))
    );
    assert_eq!(st(&h).signals_through, 1);
    // a replay of the same delivery under a new seq: recognized, nothing applied twice
    let mut again = one.clone();
    again.seq = 2;
    let a = ack(&h.consult_signal(&snap(vec![one, again]), &env).unwrap());
    assert_eq!(a["duplicate"], true);
    assert_eq!(st(&h).reasoning.as_ref().unwrap()["failedHypotheses"], 1);
    assert_eq!((st(&h).signals_accepted, st(&h).signals_duplicate), (1, 1));
    // no effort selection, no issued target touched
    assert!(h.effort_selection().is_none());
    assert!(h.receipts().iter().all(|x| x.effort.is_none() && x.signal));
}

#[test]
fn stale_cross_task_and_out_of_order_signals_change_nothing() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    let s3 = sig(3, "task-A", json!({"phase": "implement"}));
    h.consult_signal(&snap(vec![s3.clone()]), &env).unwrap();
    let after = st(&h).reasoning.clone();
    // an older call delivered late (seq below the frontier), another task's signal, and the
    // already-consumed one: nothing new to consume
    for feed in [
        vec![
            s3.clone(),
            sig(2, "task-A", json!({"recordHypothesisFailure": true})),
        ],
        vec![
            s3.clone(),
            sig(9, "task-B", json!({"recordHypothesisFailure": true})),
        ],
        vec![s3.clone()],
    ] {
        let a = ack(&h.consult_signal(&snap(feed), &env).unwrap());
        assert_eq!(a["code"], "signal-stale", "{a}");
        assert_eq!(st(&h).reasoning, after);
    }
}

#[test]
fn a_forged_signal_that_bypassed_the_core_is_refused_by_the_historical_path() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    // never produced by the Core (it fails `signals::validate`); the historical validator refuses it
    // again and the host's fold skips it because it is reported unapplied
    let forged = sig(1, "task-A", json!({"effort": "max", "phase": "review"}));
    let a = ack(&h.consult_signal(&snap(vec![forged]), &env).unwrap());
    assert_eq!(a["ok"], false);
    assert_eq!(a["code"], "signal-forbidden-field");
    assert!(st(&h).reasoning.is_none(), "nothing applied");
    assert_eq!(st(&h).last_unapplied, [1]);
}

/// An evaluator that returns a doctored semantic state.
struct Doctored(Mutex<Value>);
impl GovernorEvaluator for Doctored {
    fn call(&self, _op: &str, _args: &Value) -> Result<Value, BridgeError> {
        Ok(self.0.lock().unwrap().clone())
    }
}

fn block(failed: u64, phase: &str) -> Value {
    json!({"phase": phase, "currentEffort": null, "rootCauseEstablished": false,
        "solutionEstablished": false, "failedHypotheses": failed, "failedImplementationAttempts": 0,
        "totalFailedHypotheses": failed, "totalFailedImplementationAttempts": 0,
        "conflictingEvidence": false, "requestMax": false, "lastResolution": null,
        "processedSignalIds": []})
}

#[test]
fn the_host_refuses_any_semantic_move_the_signal_does_not_imply() {
    let s = sig(1, "task-A", json!({"recordHypothesisFailure": true}));
    let activity = json!({"schemaVersion": 1, "revision": 0, "semanticRevision": 0,
        "lastMutationRevision": 0, "mutationCount": 0,
        "verification": {"status": "none", "revision": 0, "family": null}});
    for (name, forged) in [
        ("counted twice", {
            let mut b = block(2, "discover");
            b["processedSignalIds"] = json!([s.dispatch_key]);
            b
        }),
        ("phase invented", {
            let mut b = block(1, "implement");
            b["processedSignalIds"] = json!([s.dispatch_key]);
            b
        }),
        ("not recorded as processed", block(1, "discover")),
        ("max smuggled", {
            let mut b = block(1, "discover");
            b["requestMax"] = json!(true);
            b["processedSignalIds"] = json!([s.dispatch_key]);
            b
        }),
    ] {
        let env = EngineEnv {
            governor: Some(Arc::new(Doctored(Mutex::new(json!({
                "museReasoning": forged, "museActivity": activity,
                "acks": [{"ok": true, "duplicate": false, "applied": ["recordHypothesisFailure"]}],
            }))))),
        };
        let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
        let before = h.state().clone();
        let r = h.consult_signal(&snap(vec![s.clone()]), &env).unwrap_err();
        assert_eq!(r.code, "engine-state-transition", "{name}: {}", r.message);
        assert_eq!(h.state(), &before, "{name}");
    }
}

#[test]
fn an_unavailable_bridge_records_nothing_and_never_applies_the_signal_later() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    let first = sig(1, "task-A", json!({"recordHypothesisFailure": true}));
    let a = ack(&h
        .consult_signal(&snap(vec![first.clone()]), &EngineEnv::default())
        .unwrap());
    assert_eq!(
        (a["ok"].as_bool(), a["code"].as_str()),
        (Some(false), Some("bridge-unavailable"))
    );
    assert!(st(&h).reasoning.is_none());
    // the next signal is applied; the unrecorded one is never applied behind the model's back
    let second = sig(2, "task-A", json!({"phase": "diagnose"}));
    h.consult_signal(&snap(vec![first, second]), &env).unwrap();
    let r = st(&h).reasoning.clone().unwrap();
    assert_eq!(
        (r["phase"].as_str(), r["failedHypotheses"].as_u64()),
        (Some("diagnose"), Some(0))
    );
}

/// A hostile engine: the host's signal admission rules.
struct Hostile(&'static str);
static HOSTILE_DESC: EngineDescriptor = EngineDescriptor {
    engine_id: "hostile",
    contract_version: ENGINE_CONTRACT_VERSION,
    mode_ids: &["engineering-v2"],
    roles: &["muse_main"],
    state_schema: 1,
    may_propose_effort: true,
    inherits_state: false,
    request_reserve_bytes: 0,
};
impl EngineExtension for Hostile {
    fn descriptor(&self) -> &EngineDescriptor {
        &HOSTILE_DESC
    }
    fn initial_state(&self) -> EngineState {
        let mut s = MUSE_V0.initial_state();
        s.engine_id = "hostile";
        s
    }
    fn propose(&self, h: Hook, s: &EngineSnapshot, st: &EngineState, id: u64) -> EngineProposal {
        let mut p = MUSE_V0.propose(h, s, st, id);
        p.next_state.engine_id = "hostile";
        p
    }
    fn check_transition(
        &self,
        _: &EngineState,
        _: &EngineState,
        _: &EngineSnapshot,
    ) -> Result<(), String> {
        Ok(())
    }
    fn persist_state(&self, _: &EngineState) -> Value {
        json!({})
    }
    fn propose_signal(
        &self,
        s: &EngineSnapshot,
        st: &EngineState,
        id: u64,
        _env: &EngineEnv,
    ) -> Option<EngineProposal> {
        let mut p = self.propose(Hook::AfterToolPhase, s, st, id);
        match self.0 {
            "effort" => {
                p.action = EngineAction::Acknowledge("{}".into());
                p.effort = EffortProposal::Change("high".into());
            }
            "guide" => {}
            "huge" => p.action = EngineAction::Acknowledge("x".repeat(MAX_SIGNAL_ACK_BYTES + 1)),
            "stale" => {
                p.action = EngineAction::Acknowledge("{}".into());
                p.based_on_revision = 99;
            }
            _ => p.action = EngineAction::Acknowledge("{}".into()),
        }
        Some(p)
    }
}
static H_EFFORT: Hostile = Hostile("effort");
static H_GUIDE: Hostile = Hostile("guide");
static H_HUGE: Hostile = Hostile("huge");
static H_STALE: Hostile = Hostile("stale");
static H_OK: Hostile = Hostile("ok");

#[test]
fn the_host_admits_only_a_bounded_acknowledgement_and_never_an_effort_change() {
    let s = snap(vec![sig(1, "task-A", json!({}))]);
    for (e, code) in [
        (&H_EFFORT, "engine-effort-not-admitted"),
        (&H_GUIDE, "engine-action-not-admitted"),
        (&H_HUGE, "engine-ack-invalid"),
        (&H_STALE, "engine-state-stale"),
    ] {
        let mut h = EngineHost::new(e);
        assert_eq!(
            h.consult_signal(&s, &EngineEnv::default())
                .unwrap_err()
                .code,
            code
        );
        assert!(h.receipts().is_empty() && h.effort_selection().is_none());
    }
    let mut h = EngineHost::new(&H_OK);
    assert_eq!(h.consult_signal(&s, &EngineEnv::default()).unwrap(), "{}");
    // and an Acknowledge is never admitted at a hook
    let mut p = H_OK.propose(Hook::AfterToolPhase, &s, h.state(), h.next_proposal_id());
    p.action = EngineAction::Acknowledge("{}".into());
    assert_eq!(
        h.accept(Hook::AfterToolPhase, &s, p).unwrap_err().code,
        "engine-action-not-admitted"
    );
}

#[test]
fn a_continuation_inherits_applied_signals_and_starts_a_new_signal_frontier() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    let s1 = sig(
        4,
        "task-A",
        json!({"phase": "diagnose", "recordHypothesisFailure": true}),
    );
    h.consult_signal(&snap(vec![s1.clone()]), &env).unwrap();
    let payload = MUSE_V1_SIGNALS.persist_state(h.state());
    let restored = MUSE_V1_SIGNALS.restore_state(&payload, 0).unwrap();
    let mut h2 = EngineHost::restored(&MUSE_V1_SIGNALS, restored, 0, None);
    // the new generation's calls start at seq 1; the predecessor's delivery is still a duplicate
    let mut replay = s1.clone();
    replay.seq = 1;
    replay.generation = "task-C".into();
    let mut s = snap(vec![replay]);
    s.generation = "task-C".into();
    let a = ack(&h2.consult_signal(&s, &env).unwrap());
    assert_eq!(a["duplicate"], true);
    assert_eq!(st(&h2).reasoning.as_ref().unwrap()["failedHypotheses"], 1);
    assert_eq!(st(&h2).generation, "task-C");
    // an EM-04A shadow payload (no signal keys) still restores under the new reader
    let mut old = payload.clone();
    for k in [
        "signalsThrough",
        "signalsAccepted",
        "signalsDuplicate",
        "lastUnapplied",
    ] {
        old.as_object_mut().unwrap().remove(k);
    }
    assert!(MUSE_V1_SIGNALS.restore_state(&old, 0).is_some());
    assert!(MUSE_V1.restore_state(&old, 0).is_some());
}

#[test]
fn the_state_stays_bounded_with_the_full_processed_window() {
    let Some(env) = node_env() else { return };
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    let mut feed = Vec::new();
    for i in 1..=130u32 {
        feed.push(sig(
            i,
            "task-A",
            json!({"phase": if i % 2 == 0 { "verify" } else { "implement" }}),
        ));
        h.consult_signal(&snap(feed.clone()), &env).unwrap();
        if i % 10 == 0 {
            let mut s = snap(feed.clone());
            s.attempts_dispatched = i;
            h.consult_in(Hook::BeforeRequest, &s, &env).unwrap();
        }
    }
    let r = st(&h).reasoning.clone().unwrap();
    assert_eq!(r["processedSignalIds"].as_array().unwrap().len(), 100);
    assert!(
        st(&h).encoded_len() <= MAX_STATE_BYTES,
        "{}",
        st(&h).encoded_len()
    );
}

// ---- EM-04C1: the persistent worker dying under the engine -------------------------------

/// A worker whose first process dies (once, process-wide marker file) when it is about to answer.
pub(super) fn crash_once_env_for_governor(marker: &std::path::Path) -> EngineEnv {
    crash_once_env(marker, false)
}

fn crash_once_env(marker: &std::path::Path, always: bool) -> EngineEnv {
    use super::worker_bridge::{WorkerConfig, WorkerGovernorBridge, WORKER_SOURCE};
    let m = marker
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    let action = if always {
        "process.exit(9);".to_owned()
    } else {
        format!(
            "const fs = require('node:fs'); if (!fs.existsSync('{m}')) {{ fs.writeFileSync('{m}', '1'); process.exit(9); }}"
        )
    };
    let script = format!(
        "(function(){{ let w = 0; const orig = process.stdout.write.bind(process.stdout);\
         process.stdout.write = function (b) {{ w += 1; if (w === 2) {{ {action} }} return orig(b); }}; }})();\n{WORKER_SOURCE}"
    );
    let mut cfg = WorkerConfig::new("node".into());
    cfg.script = script;
    cfg.timeout = std::time::Duration::from_secs(10);
    // TEST HOOK ONLY: the crash-once marker is a file, and the worker runs under the deny-all
    // permission mode, so this one path (and nothing else) is granted to the TEST script. The
    // product configuration never carries an `--allow-*` flag (`worker_flags_..._grant_nothing`).
    cfg.node_flags
        .push(format!("--allow-fs-read={}", marker.display()));
    cfg.node_flags
        .push(format!("--allow-fs-write={}", marker.display()));
    EngineEnv {
        governor: Some(Arc::new(WorkerGovernorBridge::with_config(
            cfg,
            "test",
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ))),
    }
}

fn marker(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("nexus-c1-{}-{name}", std::process::id()));
    let _ = std::fs::remove_file(&d);
    d
}

/// The worker dies while it is evaluating a signal: the supervisor re-asks a clean worker, the
/// signal is applied ONCE (the state travels with the request, so a restart loses and duplicates
/// nothing), and the host's state equals a run on a worker that never failed.
#[test]
fn a_worker_dying_during_signal_acceptance_neither_loses_nor_doubles_the_signal() {
    let Some(healthy) = node_env() else { return };
    let m = marker("sig");
    let crashing = crash_once_env(&m, false);
    let s = sig(
        1,
        "task-A",
        json!({"phase": "diagnose", "recordHypothesisFailure": true}),
    );
    let mut a = EngineHost::new(&MUSE_V1_SIGNALS);
    let mut b = EngineHost::new(&MUSE_V1_SIGNALS);
    let ra = ack(&a.consult_signal(&snap(vec![s.clone()]), &crashing).unwrap());
    let rb = ack(&b.consult_signal(&snap(vec![s.clone()]), &healthy).unwrap());
    assert!(m.exists(), "the first worker really died");
    assert_eq!(
        ra, rb,
        "the acknowledgement is the one a healthy worker gives"
    );
    assert_eq!(ra["duplicate"], false);
    assert_eq!(st(&a).reasoning, st(&b).reasoning);
    assert_eq!(st(&a).reasoning.as_ref().unwrap()["failedHypotheses"], 1);
    // a replay of the same delivery is still a duplicate afterwards
    let mut again = s.clone();
    again.seq = 2;
    let r2 = ack(&a.consult_signal(&snap(vec![s, again]), &crashing).unwrap());
    assert_eq!(r2["duplicate"], true);
    assert_eq!(st(&a).reasoning.as_ref().unwrap()["failedHypotheses"], 1);
    let _ = std::fs::remove_file(&m);
}

/// A worker that keeps dying: the signal is reported "not recorded", nothing is applied, and the
/// signal is never applied later behind the model's back (the same fail-safe as an absent bridge).
#[test]
fn a_worker_that_keeps_dying_leaves_the_signal_unrecorded_and_never_applied_later() {
    let Some(healthy) = node_env() else { return };
    let m = marker("sig-always");
    let dying = crash_once_env(&m, true);
    let first = sig(1, "task-A", json!({"recordHypothesisFailure": true}));
    let mut h = EngineHost::new(&MUSE_V1_SIGNALS);
    let a = ack(&h
        .consult_signal(&snap(vec![first.clone()]), &dying)
        .unwrap());
    assert_eq!(a["ok"], false, "{a}");
    assert!(st(&h).reasoning.is_none(), "nothing applied");
    let second = sig(2, "task-A", json!({"phase": "diagnose"}));
    h.consult_signal(&snap(vec![first, second]), &healthy)
        .unwrap();
    let r = st(&h).reasoning.clone().unwrap();
    assert_eq!(
        (r["phase"].as_str(), r["failedHypotheses"].as_u64()),
        (Some("diagnose"), Some(0)),
        "the unrecorded signal stayed unrecorded"
    );
}
