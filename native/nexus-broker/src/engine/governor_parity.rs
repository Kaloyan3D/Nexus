//! EM-04A differential validation: the historical Muse Governor under DSH vs under Native.
//!
//! Each scenario runs twice from the same inputs:
//! * **DSH reference** (`dsh_reference.cjs`): the ORIGINAL modules from `config/`, driven through
//!   their public DSH API against a real temporary routing-state file and model registry, with
//!   DSH-shaped tool executions for the activity observer and a module reload for "restart";
//! * **Native**: the embedded sources through the Native bridge (`muse_bridge.cjs`), the state
//!   carried between requests exactly as `muse-v1` carries it in its engine payload, tool outcomes
//!   turned into observations by the Core's own derivation (`inspect::observe` with Native's
//!   verification classifier), and "restart" = `muse-v1`'s persist/restore round trip.
//!
//! Compared: the selected effort, requested effort, reason, trace, effective phase and source of
//! every resolution (or the capability refusal), and the final semantic and activity blocks. The
//! only fields excluded are the resolution timestamp (DSH wall clock vs the bridge's fixed clock)
//! and the activity `verification.family` label (DSH's text classifier names a family, Native
//! records the program) - both are recorded in EM-04A-GOVERNOR-PARITY.md. Known classification
//! differences are asserted AS differences, never hidden.

use super::muse_v1::{classification, MuseV1State, MUSE_V1};
use super::worker_bridge::test_evaluator;
use super::{EngineExtension, EngineState, EngineStateData};
use nexus_client::intent_client::ToolActivity;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const ALL: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub(crate) fn node() -> Option<PathBuf> {
    let out = Command::new("node").arg("--version").output().ok()?;
    out.status.success().then(|| PathBuf::from("node"))
}

pub(crate) fn config_dir() -> String {
    std::fs::canonicalize(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config"))
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Tool {
    Edit,
    EditFailed,
    Read,
    TestPass,
    TestFail,
    /// DSH: a background verification launch; Native: a verification whose status proves nothing.
    TestUnproven,
    Listing,
    /// `sh -c "cargo test"` failing (classified differently: see the parity report).
    ShellWrappedTestFail,
}

#[derive(Clone, Debug)]
pub(crate) enum Step {
    Sem(&'static str, Option<&'static str>),
    Tool(Tool),
    Resolve,
    Restart,
}
use Step::*;

pub(crate) fn dsh_tool(t: Tool) -> (Value, Value) {
    let bash = |c: &str| json!({"name": "bash", "arguments": {"command": c}});
    match t {
        Tool::Edit => (
            json!({"name": "edit", "arguments": {"path": "src/a.rs"}}),
            json!({"isError": false, "value": {}}),
        ),
        Tool::EditFailed => (
            json!({"name": "edit", "arguments": {"path": "src/a.rs"}}),
            json!({"isError": true}),
        ),
        Tool::Read => (
            json!({"name": "read", "arguments": {"path": "src/a.rs"}}),
            json!({"isError": false, "value": {}}),
        ),
        Tool::TestPass => (
            bash("cargo test"),
            json!({"isError": false, "value": {"exitCode": 0}}),
        ),
        Tool::TestFail => (
            bash("cargo test"),
            json!({"isError": false, "value": {"exitCode": 101}}),
        ),
        Tool::TestUnproven => (
            bash("cargo test"),
            json!({"isError": false, "value": {"kind": "background"}}),
        ),
        Tool::Listing => (
            bash("ls -la"),
            json!({"isError": false, "value": {"exitCode": 0}}),
        ),
        Tool::ShellWrappedTestFail => (
            bash("sh -c \"cargo test\""),
            json!({"isError": false, "value": {"exitCode": 101}}),
        ),
    }
}

/// The Native receipt for the same outcome, and the proc_run arguments Native classifies.
pub(crate) fn native_tool(t: Tool, index: u32) -> (ToolActivity, Value) {
    let mut a = ToolActivity {
        index,
        turn: 1,
        call_id: format!("call_{index}"),
        status: "executed".into(),
        execution_id: Some(format!("ex-{index:04}")),
        ..Default::default()
    };
    let mut args = json!({});
    match t {
        Tool::Edit => a.tool = "fs_edit".into(),
        Tool::EditFailed => {
            a.tool = "fs_edit".into();
            a.status = "failed".into();
        }
        Tool::Read => a.tool = "fs_read".into(),
        Tool::TestPass | Tool::TestFail | Tool::TestUnproven => {
            a.tool = "proc_run".into();
            a.args_summary = "cargo test".into();
            args = json!({"program": "cargo", "args": ["test"]});
            a.verification = Some(
                match t {
                    Tool::TestPass => "pass",
                    Tool::TestFail => "fail",
                    _ => "unverified",
                }
                .into(),
            );
        }
        Tool::Listing => {
            a.tool = "proc_run".into();
            a.args_summary = "ls -la".into();
            args = json!({"program": "ls", "args": ["-la"]});
            a.verification = Some("run-pass".into());
        }
        Tool::ShellWrappedTestFail => {
            a.tool = "proc_run".into();
            a.args_summary = "sh -c cargo test".into();
            args = json!({"program": "sh", "args": ["-c", "cargo test"]});
            a.verification = Some("fail".into());
        }
    }
    (a, args)
}

pub(crate) struct Outcome {
    pub resolutions: Vec<Value>,
    pub reasoning: Value,
    pub activity: Value,
}

pub(crate) fn run_dsh(caps: &[&str], steps: &[Step]) -> Outcome {
    let node = node().expect("node");
    let steps_json: Vec<Value> = steps
        .iter()
        .map(|s| match s {
            Sem(op, v) => json!({"t": "sem", "op": op, "value": v}),
            Tool(t) => {
                let (exec, result) = dsh_tool(*t);
                json!({"t": "tool", "exec": exec, "result": result})
            }
            Resolve => json!({"t": "resolve"}),
            Restart => json!({"t": "restart"}),
        })
        .collect();
    let input = json!({"configDir": config_dir(), "capabilities": caps, "steps": steps_json});
    let mut child = Command::new(node)
        .arg("-e")
        .arg(include_str!("dsh_reference.cjs"))
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
    Outcome {
        resolutions: v["resolutions"].as_array().unwrap().clone(),
        reasoning: v["final"]["museReasoning"].clone(),
        activity: v["final"]["museActivity"].clone(),
    }
}

pub(crate) fn run_native(caps: &[&str], steps: &[Step]) -> Outcome {
    let bridge = test_evaluator(node().expect("node"));
    let mut reasoning = Value::Null;
    let mut activity = Value::Null;
    let mut pending: Vec<Value> = Vec::new();
    let mut resolutions = Vec::new();
    let mut index = 0;
    let eval =
        |reasoning: &mut Value, activity: &mut Value, pending: &mut Vec<Value>, resolve: bool| {
            let r = bridge
                .call(
                    "evaluate",
                    &json!({
                        "museReasoning": reasoning, "museActivity": activity,
                        "events": pending, "capabilities": caps, "resolve": resolve,
                    }),
                )
                .unwrap();
            pending.clear();
            *reasoning = r["museReasoning"].clone();
            *activity = r["museActivity"].clone();
            r["decision"].clone()
        };
    for s in steps {
        match s {
            Sem(op, v) => pending.push(json!({"type": "semantic", "op": op, "value": v})),
            Tool(t) => {
                index += 1;
                let (act, args) = native_tool(*t, index);
                let verification =
                    act.tool == "proc_run" && crate::inspect::is_verification_command(&args);
                if let Some(o) = crate::inspect::observe(&act, verification, 1, "gen-1") {
                    pending.push(
                        json!({"type": "activity", "classification": classification(&o.kind)}),
                    );
                }
            }
            Resolve => resolutions.push(eval(&mut reasoning, &mut activity, &mut pending, true)),
            Restart => {
                if !pending.is_empty() {
                    eval(&mut reasoning, &mut activity, &mut pending, false);
                }
                // the durable round trip a continuation takes
                let st = EngineState {
                    engine_id: super::muse_v1::ENGINE_ID,
                    schema: 1,
                    revision: 7,
                    data: EngineStateData::MuseV1(MuseV1State {
                        reasoning: (!reasoning.is_null()).then(|| reasoning.clone()),
                        activity: (!activity.is_null()).then(|| activity.clone()),
                        generation: "gen-1".into(),
                        ..Default::default()
                    }),
                };
                let payload = MUSE_V1.persist_state(&st);
                let back = MUSE_V1.restore_state(&payload, 0).expect("restores");
                let EngineStateData::MuseV1(d) = back.data else {
                    unreachable!()
                };
                reasoning = d.reasoning.unwrap_or(Value::Null);
                activity = d.activity.unwrap_or(Value::Null);
            }
        }
    }
    if !pending.is_empty() {
        eval(&mut reasoning, &mut activity, &mut pending, false);
    }
    Outcome {
        resolutions,
        reasoning,
        activity,
    }
}

pub(crate) fn comparable_reasoning(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(l) = v.get_mut("lastResolution").and_then(Value::as_object_mut) {
        l.remove("atUtc");
    }
    v
}

pub(crate) fn comparable_activity(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(ver) = v.get_mut("verification").and_then(Value::as_object_mut) {
        ver.remove("family");
    }
    v
}

/// Run both sides and require identical decisions and state.
pub(crate) fn parity(name: &str, caps: &[&str], steps: &[Step]) -> Outcome {
    let d = run_dsh(caps, steps);
    let n = run_native(caps, steps);
    assert_eq!(d.resolutions, n.resolutions, "{name}: resolutions differ");
    assert_eq!(
        comparable_reasoning(&d.reasoning),
        comparable_reasoning(&n.reasoning),
        "{name}: museReasoning differs"
    );
    assert_eq!(
        comparable_activity(&d.activity),
        comparable_activity(&n.activity),
        "{name}: museActivity differs"
    );
    n
}

fn efforts(o: &Outcome) -> Vec<String> {
    o.resolutions
        .iter()
        .map(|r| match r["outcome"].as_str() {
            Some("resolved") => r["effort"].as_str().unwrap().to_owned(),
            other => format!("refused:{}", other.unwrap_or("?")),
        })
        .collect()
}

macro_rules! need_node {
    () => {
        if node().is_none() {
            eprintln!("node unavailable: parity test skipped");
            return;
        }
    };
}

#[test]
fn parity_phase_defaults_for_every_cognitive_phase() {
    need_node!();
    let mut steps = vec![Resolve];
    for p in [
        "discover",
        "diagnose",
        "design",
        "implement",
        "verify",
        "recover",
        "review",
    ] {
        steps.push(Sem("setPhase", Some(p)));
        steps.push(Resolve);
    }
    let o = parity("phase-defaults", ALL, &steps);
    assert_eq!(
        efforts(&o),
        ["medium", "medium", "high", "high", "medium", "medium", "high", "high"]
    );
}

#[test]
fn parity_failure_escalation_and_progress_based_de_escalation() {
    need_node!();
    let o = parity(
        "escalation",
        ALL,
        &[
            Sem("setPhase", Some("diagnose")),
            Sem("recordHypothesisFailure", None),
            Resolve,
            Sem("recordHypothesisFailure", None),
            Resolve,
            // root cause newly established: the active window resets (history kept)
            Sem("markRootCauseEstablished", None),
            Resolve,
            Sem("setPhase", Some("implement")),
            Sem("recordImplementationFailure", None),
            Sem("recordImplementationFailure", None),
            Resolve,
            Sem("markSolutionEstablished", None),
            Resolve,
        ],
    );
    assert_eq!(efforts(&o), ["high", "xhigh", "high", "xhigh", "medium"]);
    assert_eq!(o.resolutions[1]["reason"], "escalation");
    assert_eq!(o.resolutions[4]["reason"], "de-escalation");
    assert_eq!(o.reasoning["totalFailedHypotheses"], 2);
    assert_eq!(o.reasoning["failedHypotheses"], 0);
    assert_eq!(o.reasoning["totalFailedImplementationAttempts"], 2);
}

#[test]
fn parity_root_cause_established_conflict_and_invalidation() {
    need_node!();
    let o = parity(
        "root-cause",
        ALL,
        &[
            Sem("setPhase", Some("implement")),
            Sem("markRootCauseEstablished", None),
            Resolve,
            Sem("markSolutionEstablished", None),
            Resolve,
            Sem("setConflictingEvidence", None),
            Resolve,
            Sem("resolveConflictingEvidence", None),
            Resolve,
            Sem("invalidateRootCause", None),
            Resolve,
            // re-marking an established flag never resets anything
            Sem("markRootCauseEstablished", None),
            Sem("markRootCauseEstablished", None),
            Resolve,
            Sem("invalidateSolution", None),
            Resolve,
        ],
    );
    assert_eq!(
        efforts(&o),
        ["medium", "medium", "xhigh", "medium", "medium", "medium", "medium"]
    );
}

#[test]
fn parity_capability_limits_clamp_down_only_and_fail_closed() {
    need_node!();
    // escalation to xhigh clamped DOWN to high when the binding authorizes up to high
    let o = parity(
        "clamp",
        &["low", "medium", "high"],
        &[
            Sem("setPhase", Some("diagnose")),
            Sem("recordHypothesisFailure", None),
            Sem("recordHypothesisFailure", None),
            Resolve,
            Sem("requestMax", Some("true")),
            Resolve,
        ],
    );
    assert_eq!(efforts(&o), ["high", "high"]);
    assert!(o.resolutions[0]["trace"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t.as_str().unwrap().contains("clamped-down-to-high")));
    // default-only binding: no Governor level at or below the request -> refused (fail closed)
    let o = parity(
        "default-only",
        &["low"],
        &[Resolve, Sem("setPhase", Some("diagnose")), Resolve],
    );
    assert_eq!(
        efforts(&o),
        [
            "refused:capability-unavailable",
            "refused:capability-unavailable"
        ]
    );
    assert!(o.reasoning.is_null() || o.reasoning["currentEffort"].is_null());
    // a floor above the request is never used upward
    let o = parity("floor", &["high", "xhigh"], &[Resolve]);
    assert_eq!(efforts(&o), ["refused:capability-unavailable"]);
    // max only when authorized
    let o = parity("max", ALL, &[Sem("requestMax", Some("true")), Resolve]);
    assert_eq!(efforts(&o), ["max"]);
}

#[test]
fn parity_trusted_activity_reductions() {
    need_node!();
    let o = parity(
        "activity",
        ALL,
        &[
            Sem("setPhase", Some("diagnose")),
            Resolve,
            Tool(Tool::Read),
            Tool(Tool::Listing),
            Tool(Tool::EditFailed),
            Resolve,
            Tool(Tool::Edit),
            Resolve,
            Tool(Tool::Edit),
            Tool(Tool::Edit),
            Resolve,
            Tool(Tool::TestFail),
            Resolve,
            Tool(Tool::TestFail),
            Resolve,
            Tool(Tool::Edit),
            Resolve,
            Sem("setPhase", Some("verify")),
            Tool(Tool::TestPass),
            Resolve,
            Tool(Tool::TestUnproven),
            Resolve,
            Sem("setPhase", Some("review")),
            Resolve,
        ],
    );
    let phases: Vec<&str> = o
        .resolutions
        .iter()
        .map(|r| r["effectiveSource"].as_str().unwrap())
        .collect();
    assert_eq!(
        phases,
        [
            "semantic",
            "semantic",
            "implementation-active",
            "implementation-active",
            "recovery-needed",
            "recovery-needed",
            // historical behaviour (finding O-1 in the parity report): the mutation milestone fires
            // once per active period, so an edit after a failed verification in the SAME period does
            // not re-stamp the mutation and the failure stays the newest evidence
            "recovery-needed",
            "verification-passed",
            "semantic",
            "semantic"
        ]
    );
    assert_eq!(
        efforts(&o),
        ["high", "high", "medium", "medium", "high", "high", "high", "medium", "medium", "high"]
    );
    // anti-thrash: four edits counted, one mutation milestone in the period
    assert_eq!(o.activity["mutationCount"], 4);
}

#[test]
fn parity_restart_and_continuation_preserve_the_cognitive_state() {
    need_node!();
    let steps = [
        Sem("setPhase", Some("diagnose")),
        Sem("recordHypothesisFailure", None),
        Resolve,
        Restart,
        Sem("recordHypothesisFailure", None),
        Resolve,
        Tool(Tool::Edit),
        Restart,
        Resolve,
        Tool(Tool::TestFail),
        Restart,
        Resolve,
    ];
    let o = parity("restart", ALL, &steps);
    assert_eq!(efforts(&o), ["high", "xhigh", "xhigh", "xhigh"]);
    // the same steps without restarts decide identically
    let flat: Vec<Step> = steps
        .iter()
        .filter(|s| !matches!(s, Restart))
        .cloned()
        .collect();
    assert_eq!(run_native(ALL, &flat).resolutions, o.resolutions);
}

#[test]
fn known_difference_shell_wrapped_verification_is_recognized_only_by_native() {
    need_node!();
    // DSH's text classifier sees `sh` in command position and ignores the command; Native's
    // verification classifier judges the script of `sh -c` (A6.1.x) and records a failed check.
    // Recorded in EM-04A-GOVERNOR-PARITY.md (difference P-1); not "fixed" in either policy.
    let steps = [
        Sem("setPhase", Some("implement")),
        Tool(Tool::ShellWrappedTestFail),
        Resolve,
    ];
    let d = run_dsh(ALL, &steps);
    let n = run_native(ALL, &steps);
    assert_eq!(d.resolutions[0]["effectiveSource"], "semantic");
    assert_eq!(d.resolutions[0]["effort"], "medium");
    assert_eq!(n.resolutions[0]["effectiveSource"], "recovery-needed");
    assert_eq!(n.resolutions[0]["effort"], "high");
}

#[test]
fn the_unchanged_ladder_never_contains_low() {
    need_node!();
    let r = test_evaluator(node().unwrap())
        .call("ladder", &json!({}))
        .unwrap();
    assert!(!r["efforts"].as_array().unwrap().iter().any(|e| e == "low"));
    assert_eq!(
        super::muse_v1::MUSE_LADDER.to_vec(),
        r["efforts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_str().unwrap())
            .collect::<Vec<_>>()
    );
}

/// The two verification vocabularies over one command corpus: DSH's text classifier
/// (`classifyVerificationCommand`, the historical observer) vs Native's `is_verification_command`
/// (the Core's own verification truth, which feeds the shadow). Every disagreement is pinned here
/// and listed in EM-04A-GOVERNOR-PARITY.md (P-1); a change on either side fails this test.
#[test]
fn the_verification_vocabularies_differ_exactly_as_documented() {
    need_node!();
    let corpus: Vec<(&str, Vec<&str>)> = vec![
        ("cargo", vec!["test"]),
        ("cargo", vec!["test", "--offline"]),
        ("cargo", vec!["build"]),
        ("cargo", vec!["check"]),
        ("cargo", vec!["clippy"]),
        ("npm", vec!["test"]),
        ("npm", vec!["run", "test"]),
        ("npm", vec!["run", "build"]),
        ("npm", vec!["run", "lint"]),
        ("npm", vec!["run", "verify"]),
        ("npm", vec!["run", "typecheck"]),
        ("npm", vec!["install"]),
        ("pnpm", vec!["test"]),
        ("yarn", vec!["test"]),
        ("npx", vec!["vitest"]),
        ("npx", vec!["jest"]),
        ("npx", vec!["tsc"]),
        ("npx", vec!["eslint", "."]),
        ("eslint", vec!["."]),
        ("tsc", vec!["--noEmit"]),
        ("node", vec!["--test"]),
        ("pytest", vec![]),
        ("python", vec!["-m", "pytest"]),
        ("python3", vec!["-m", "pytest"]),
        ("python", vec!["-m", "unittest"]),
        ("go", vec!["test", "./..."]),
        ("go", vec!["vet", "./..."]),
        ("dotnet", vec!["test"]),
        ("dotnet", vec!["build"]),
        ("mypy", vec!["."]),
        ("make", vec!["test"]),
        ("ls", vec!["-la"]),
        ("cat", vec!["README.md"]),
        ("git", vec!["status"]),
        ("sh", vec!["-c", "cargo test"]),
        ("bash", vec!["-lc", "npm test"]),
    ];
    let texts: Vec<String> = corpus
        .iter()
        .map(|(p, a)| {
            std::iter::once(p.to_string())
                .chain(a.iter().map(|x| {
                    if x.contains(' ') {
                        format!("\"{x}\"")
                    } else {
                        x.to_string()
                    }
                }))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let script = format!(
        "const a = require({:?}); process.stdout.write(JSON.stringify({}.map((c) => a.classifyVerificationCommand(c))));",
        format!("{}/Muse-ReasoningActivity.cjs", config_dir()),
        serde_json::to_string(&texts).unwrap()
    );
    let out = Command::new(node().unwrap())
        .arg("-e")
        .arg(script)
        .output()
        .unwrap();
    let dsh: Vec<Value> = serde_json::from_slice(&out.stdout).unwrap();
    let mut differences = Vec::new();
    for (((p, a), text), d) in corpus.iter().zip(&texts).zip(&dsh) {
        let native = crate::inspect::is_verification_command(&json!({"program": p, "args": a}));
        let historical = !d.is_null();
        println!(
            "{text:<28} DSH {:<14} Native {}",
            d.as_str().unwrap_or("-"),
            if native { "verification" } else { "-" }
        );
        if native != historical {
            differences.push((text.clone(), historical, native));
        }
    }
    let expected: Vec<(&str, bool, bool)> = vec![
        ("cargo check", false, true),
        ("cargo clippy", false, true),
        ("npm run verify", true, false),
        ("npx eslint .", true, false),
        ("eslint .", true, false),
        ("python3 -m pytest", false, true),
        ("go vet ./...", false, true),
        ("mypy .", false, true),
        ("make test", false, true),
        ("sh -c \"cargo test\"", false, true),
        ("bash -lc \"npm test\"", false, true),
    ];
    let got: Vec<(&str, bool, bool)> = differences
        .iter()
        .map(|(t, h, n)| (t.as_str(), *h, *n))
        .collect();
    assert_eq!(got, expected, "the documented vocabulary differences (P-1)");
}
