//! M4.7 Phase 1: deterministic replay of the Job Scheduler benchmark run `run_faf5b5f83191930c9ed1b07707702790`.
//!
//! The fixture holds every tool call of that run in order: the exact arguments the model sent, the Kernel's
//! receipt facts it saw (exit code, verdict, pipefail, output tails) and the points where the controller spoke at
//! a final answer. The replay drives the controller's own receipt fold (`record_receipts`), its final-boundary
//! hazard guard and its run decision (`decide_run_attested`) over that sequence. No model, provider, sandbox or
//! clock is involved, so the result is the controller's verdict on those receipts and nothing else.

use super::*;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../tests/fixtures/replay_run_faf5.json");

/// (call index, recorded verification, replayed verification, recorded composition, replayed composition)
pub(super) type PerCall = (
    u32,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// What the controller concluded from one replay.
pub(super) struct Replay {
    pub ls: LoopState,
    /// Every message the final-boundary guards produced, in order.
    pub boundary_messages: Vec<String>,
    /// (call index, recorded verification, replayed verification, recorded composition, replayed composition)
    pub per_call: Vec<PerCall>,
}

fn model_name(tool: &str) -> &'static str {
    match tool {
        "proc_run" => "proc_run",
        "fs_write" => "fs_write",
        "fs_edit" => "fs_edit",
        "fs_read" => "fs_read",
        "fs_list" => "fs_list",
        _ => "other",
    }
}

fn tool_id(tool: &str) -> nexus_tools::contract::ToolId {
    use nexus_tools::contract::ToolId::*;
    match tool {
        "proc_run" => ProcRun,
        "fs_write" => FsWrite,
        "fs_edit" => FsEdit,
        "fs_list" => FsList,
        _ => FsRead,
    }
}

fn summary(args: &Value) -> String {
    let mut s = args["program"].as_str().unwrap_or("").to_owned();
    for a in args["args"].as_array().into_iter().flatten() {
        s.push(' ');
        s.push_str(a.as_str().unwrap_or(""));
    }
    s
}

/// One executed tool call through the controller's receipt fold, exactly as the loop does it.
pub(super) fn fold(
    ls: &mut LoopState,
    index: u32,
    tool: &str,
    args: &Value,
    output: &Value,
) -> ToolActivity {
    let digest = nexus_contracts::sha256_hex(&nexus_contracts::canonical_json(args));
    let cp = crate::code::CodeProposal {
        inner: ValidProposal {
            tool_id: tool_id(tool),
            model_name: model_name(tool),
            args: args.clone(),
            args_digest: digest.clone(),
        },
        kind: if tool == "proc_run" {
            crate::code::Kind::Process
        } else if tool == "fs_write" || tool == "fs_edit" {
            crate::code::Kind::Write
        } else {
            crate::code::Kind::Read
        },
        path: None,
        bytes: 0,
        summary: String::new(),
    };
    let mut act = ToolActivity {
        index,
        turn: index,
        tool: tool.to_owned(),
        status: "executed".into(),
        args_summary: if tool == "proc_run" {
            summary(args)
        } else {
            format!("edit {}", output["path"].as_str().unwrap_or(""))
        },
        args_digest: Some(digest),
        ..Default::default()
    };
    record_receipts(ls, &mut act, &cp, &json!({ "output": output }));
    if tool == "proc_run" {
        ls.tests_used += u32::from(is_verification_command(args));
    }
    if (tool == "fs_write" || tool == "fs_edit") && output["postSha256"].is_string() {
        act.post_sha256 = output["postSha256"].as_str().map(str::to_owned);
    }
    ls.activity.push(act.clone());
    act
}

/// The final-boundary guard sequence for an answer without tool calls (the part of it that is controller-only).
pub(super) fn boundary(ls: &mut LoopState) -> Option<String> {
    final_obligations(ls)
}

pub(super) fn replay() -> Replay {
    let fx: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut ls = LoopState {
        mode_code: true,
        expects_change: true,
        ..Default::default()
    };
    let mut boundary_messages = Vec::new();
    let mut per_call = Vec::new();
    for s in fx["steps"].as_array().unwrap() {
        if s.get("boundary").is_some() {
            if s["boundary"].as_str().unwrap().contains("compound command") {
                boundary_messages.push(boundary(&mut ls).unwrap_or_default());
            }
            continue;
        }
        if s["status"] != "executed" {
            continue;
        }
        let tool = s["tool"].as_str().unwrap();
        let index = s["index"].as_u64().unwrap() as u32;
        let out = s.get("output").cloned().unwrap_or(Value::Null);
        if out.is_null() {
            continue;
        }
        let act = fold(&mut ls, index, tool, &s["args"], &out);
        if tool == "proc_run" {
            per_call.push((
                index,
                s["recorded"]["verification"].as_str().map(str::to_owned),
                act.verification.clone(),
                s["recorded"]["composition"].as_str().map(str::to_owned),
                act.composition.clone(),
            ));
        }
    }
    Replay {
        ls,
        boundary_messages,
        per_call,
    }
}

/// The run decision the controller makes from the replayed receipts.
pub(super) fn decision(ls: &LoopState) -> &'static str {
    crate::completion::decide_run_attested(
        true,
        applied_edits(ls),
        ls.last_test.as_deref(),
        "Implemented the scheduler, its CLI and its tests; the build and the test suite pass.",
        ls.failed_checks.len() as u32,
        ls.unexecuted.len() as u32,
        ls.hazards.len() as u32,
    )
    .as_str()
}

/// The client-side coding outcome (what the Mac's writeback gate reads) of the replayed receipts.
pub(super) fn outcome(ls: &LoopState) -> nexus_client::intent_client::CodingOutcome {
    let run = nexus_client::intent_client::IntentRun {
        intent_type: "repo-code".into(),
        state: "completed".into(),
        terminal: true,
        tool_activity: ls.activity.clone(),
        unresolved_failed_checks: ls.failed_checks.len() as u32,
        unresolved_unattested_checks: ls.hazards.len() as u32,
        ..Default::default()
    };
    nexus_client::intent_client::derive_coding_outcome(&run).unwrap()
}

/// The recorded M4.6 verdict for the baseline, kept in the fixture beside each step. The ONLY intended per-call
/// difference of M4.7 on this run: the four `touch … && cargo build 2>&1 | grep -i 'warn'` runs (exit 1 = no
/// warning line) are no longer failed checks but filter-status obligations. Every other verdict and composition
/// is reproduced exactly.
#[test]
fn m47_replay_changes_exactly_the_filter_status_calls() {
    let r = replay();
    assert_eq!(
        r.per_call.len(),
        66,
        "every proc_run of the run is replayed"
    );
    let mut diffs = Vec::new();
    for (i, rec_v, new_v, rec_c, new_c) in &r.per_call {
        assert_eq!(
            rec_v, new_v,
            "call {i}: the Kernel verdict is never rewritten"
        );
        if rec_c != new_c {
            diffs.push((*i, new_c.clone()));
        }
    }
    println!("REPLAY changed calls: {diffs:?}");
    assert_eq!(
        diffs,
        [111u32, 114, 115, 116]
            .iter()
            .map(|i| (*i, Some("unattested:filter-status".to_owned())))
            .collect::<Vec<_>>()
    );
    for a in
        r.ls.activity
            .iter()
            .filter(|a| [111, 114, 115, 116].contains(&a.index))
    {
        assert_eq!(a.assessed(), Some("unverified"));
        // the filter-free checks of these calls are exactly call 102's: they join its obligation, adding none
        assert_eq!(a.check_class.as_deref(), Some("filter-status-joined"));
        assert_eq!(r.ls.joined.get(&a.index), Some(&102));
    }
}

/// The recorded receipts alone, under M4.7. No false failure is left; what stays open is exactly what was never
/// re-established (two genuine historical failures the model was never told about, two compound checks), and
/// every open hazard now carries a re-check the controller accepts. The run is NOT reported verified: nothing was
/// reclassified into a pass.
#[test]
fn m47_recorded_receipts_leave_only_genuine_open_obligations() {
    let r = replay();
    let failed: Vec<String> = r.ls.failed_checks.values().cloned().collect();
    println!("REPLAY open failed checks: {failed:?}");
    assert_eq!(failed.len(), 2);
    assert!(
        failed.iter().all(|f| !f.contains("grep -i 'warn'")),
        "the filter status is not a failure"
    );
    assert!(failed.iter().any(|f| f.contains("cargo build --offline")));
    assert!(failed.iter().any(|f| f.contains("--test-threads=1")));
    assert_eq!(
        r.ls.hazards.keys().copied().collect::<Vec<_>>(),
        vec![96, 102]
    );
    // the re-checks: 102 without the filter, 96 as the plain test-binary invocation its loop ran
    let d102 = r.ls.hazards[&102].derived.clone().unwrap();
    assert_eq!(
        d102["args"][1],
        "touch src/lib.rs src/main.rs && cargo build 2>&1"
    );
    let d96 = r.ls.hazards[&96].derived.clone().unwrap();
    assert!(d96["args"][1]
        .as_str()
        .unwrap()
        .starts_with("/work/env/target/debug/deps/integration-"));
    for h in r.ls.hazards.values() {
        let d = h
            .derived
            .clone()
            .expect("every open hazard names a re-check");
        let a = crate::compose::analyze(&d);
        assert_eq!(a.trust, crate::compose::Trust::Attested, "{d}");
        assert!(
            crate::compose::satisfies(&h.required, &h.cwd, &a, &d),
            "re-check of call {} is not satisfiable",
            h.call_index
        );
    }
    // the final-boundary guard named all four obligations, bounded to three messages
    let spoken: Vec<&String> = r
        .boundary_messages
        .iter()
        .filter(|m| !m.is_empty())
        .collect();
    assert_eq!(spoken.len(), 3);
    for m in &spoken {
        assert!(
            m.starts_with("[Nexus] 4 verification obligation(s) are open"),
            "{m}"
        );
        assert!(
            m.contains("cargo build 2>&1\"")
                && m.contains("--test-threads=1")
                && m.contains("cargo build --offline")
        );
        assert!(
            !m.contains("grep -i 'warn'\"]"),
            "never the filter as a re-check: {m}"
        );
    }
    println!("REPLAY first boundary message:\n{}", spoken[0]);
    assert_eq!(decision(&r.ls), "failing-checks");
    let o = outcome(&r.ls);
    println!("REPLAY outcome verification: {}", o.verification);
    assert_eq!(
        o.verification, "unattested-checks",
        "unverified, not verified-failed and not verified-passed"
    );
    assert_eq!(o.checks_unattested_unresolved, 2);
}

/// COUNTERFACTUAL (labelled as such): at the first final answer the model runs every command the guard named. Each
/// re-check is given a passing receipt, because in the recorded run the same checks passed on the final source in
/// another form (plain `cargo build` at 112, the four timing tests at 106-109, the full suite at 110 and 113, the
/// offline build after `cargo fetch`). The controller then accepts the run as verified; the same simulation with a
/// FAILING re-check keeps it failed.
#[test]
fn m47_counterfactual_following_the_guard_resolves_every_obligation() {
    for pass in [true, false] {
        let mut r = replay_until_first_boundary();
        let msg = final_obligations(&mut r).expect("the guard speaks");
        let mut cmds: Vec<Value> = r
            .hazards
            .values()
            .filter_map(|h| h.derived.clone())
            .collect();
        // what the guard names for a failure: the attested form of a compound command, else the command itself
        cmds.extend(
            r.failed_checks
                .keys()
                .filter_map(|k| match r.failed_required.get(k) {
                    Some((_, _, d)) => d.clone(),
                    None => r.failed_args.get(k).cloned(),
                }),
        );
        assert_eq!(cmds.len(), 4, "{msg}");
        for (n, c) in cmds.iter().enumerate() {
            assert!(
                msg.contains(&nexus_contracts::canonical_json(c)),
                "the message names {c}"
            );
            let out = json!({"exitCode": if pass {0} else {101}, "verification": if pass {"pass"} else {"fail"}, "pipefail": "applied", "stderr": "", "stdout": ""});
            fold(&mut r, 200 + n as u32, "proc_run", c, &out);
        }
        if pass {
            assert!(r.hazards.is_empty() && r.failed_checks.is_empty());
            assert_eq!(decision(&r), "fulfilled");
            assert_eq!(outcome(&r).verification, "verified-passed");
        } else {
            assert!(!r.failed_checks.is_empty());
            assert_eq!(decision(&r), "failing-checks");
            assert_ne!(outcome(&r).verification, "verified-passed");
            // a re-check that failed is never named again
            assert!(r.hazards.values().all(|h| h.recheck_failed));
        }
    }
}

fn replay_until_first_boundary() -> LoopState {
    let fx: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut ls = LoopState {
        mode_code: true,
        expects_change: true,
        ..Default::default()
    };
    for s in fx["steps"].as_array().unwrap() {
        if s.get("boundary").is_some() {
            return ls;
        }
        if s["status"] != "executed" || s.get("output").is_none() {
            continue;
        }
        fold(
            &mut ls,
            s["index"].as_u64().unwrap() as u32,
            s["tool"].as_str().unwrap(),
            &s["args"],
            &s["output"],
        );
    }
    ls
}

// ---- M4.7 Phase 3: reasoning replay policies and prefix stability ---------------------------------------------

fn turn_output(n: usize) -> nexus_client::TurnOutput {
    nexus_client::TurnOutput {
        text: String::new(),
        messages: Vec::new(),
        reasoning: vec![format!(
            "{{\"type\":\"reasoning\",\"id\":\"rs_{n}\",\"encrypted_content\":\"e{n}\"}}"
        )],
        tool_calls: Vec::new(),
        usage: None,
        usage_detail: None,
        response_id: None,
        finish_reason: "stop".into(),
        http_status: Some(200),
        provider_request_id: None,
        first_token_ms: None,
        latency_ms: 0,
        request_digest: String::new(),
        partial_tool: false,
    }
}

/// A 120-turn loop (one reasoning item, one call, one output per turn) under each policy: how many requests keep
/// the previous request as an unchanged prefix, and what the attribution says about the others.
fn simulate(policy: ReasoningReplay, turns: usize) -> (usize, Vec<String>) {
    let mut items = vec![InputItem::Message {
        role: "user".into(),
        content: "task".into(),
    }];
    let mut prev: Option<PrevPrefix> = None;
    let (mut stable, mut causes) = (0, Vec::new());
    for n in 0..turns {
        let removed = push_model_reasoning(&mut items, &turn_output(n), policy);
        items.push(InputItem::FunctionCall {
            call_id: format!("c{n}"),
            name: "fs_read".into(),
            arguments: "{}".into(),
        });
        items.push(InputItem::FunctionCallOutput {
            call_id: format!("c{n}"),
            output: format!("out {n}"),
        });
        let digests: Vec<String> = items
            .iter()
            .map(|i| nexus_contracts::sha256_hex(&format!("{i:?}")))
            .collect();
        let rec = prefix_record(prev.as_ref(), &digests, "f", "medium", 0, 0, removed);
        if rec.stable {
            stable += 1;
        } else {
            causes.push(rec.cause.clone());
        }
        prev = Some(PrevPrefix {
            digests,
            format: "f".into(),
            effort: "medium".into(),
            compactions: 0,
            memories: 0,
        });
    }
    (stable, causes)
}

#[test]
fn m47_replay_policies_and_their_prefix_stability() {
    let (w, wc) = simulate(ReasoningReplay::Window, 120);
    let (a, ac) = simulate(ReasoningReplay::AppendOnly, 120);
    let (n, nc) = simulate(ReasoningReplay::None, 120);
    println!("PREFIX stable requests of 120: window {w}, append-only {a}, none {n}");
    // window: every request after the 12th reasoning item rewrites the middle of the prompt
    assert_eq!(w, 12);
    assert_eq!(wc.len(), 108);
    assert!(wc.iter().all(|c| c == "reasoning-replay"));
    // append-only: a batch trim (65 items held -> 32) at turn 65 and again 33 turns later
    assert_eq!(a, 118);
    assert_eq!(ac, vec!["reasoning-replay".to_owned(); 2]);
    // none: the prompt only ever grows at its end
    assert_eq!(n, 120);
    assert!(nc.is_empty());
}

#[test]
fn m47_none_replays_no_reasoning_and_keeps_every_call_and_output() {
    let mut items = vec![InputItem::Message {
        role: "user".into(),
        content: "task".into(),
    }];
    for n in 0..5 {
        assert_eq!(
            push_model_reasoning(&mut items, &turn_output(n), ReasoningReplay::None),
            0
        );
        items.push(InputItem::FunctionCall {
            call_id: format!("c{n}"),
            name: "proc_run".into(),
            arguments: "{}".into(),
        });
        items.push(InputItem::FunctionCallOutput {
            call_id: format!("c{n}"),
            output: "ok".into(),
        });
    }
    assert!(!items
        .iter()
        .any(|i| matches!(i, InputItem::Reasoning { .. })));
    assert_eq!(
        items
            .iter()
            .filter(|i| matches!(i, InputItem::FunctionCall { .. }))
            .count(),
        5
    );
    assert_eq!(
        items
            .iter()
            .filter(|i| matches!(i, InputItem::FunctionCallOutput { .. }))
            .count(),
        5
    );
}

#[test]
fn m47_prefix_attribution_names_each_cause() {
    let d = |n: usize| (0..n).map(|i| format!("d{i}")).collect::<Vec<_>>();
    let prev = PrevPrefix {
        digests: d(5),
        format: "f".into(),
        effort: "medium".into(),
        compactions: 0,
        memories: 0,
    };
    assert_eq!(
        prefix_record(None, &d(3), "f", "medium", 0, 0, 0).cause,
        "first-request"
    );
    let ok = prefix_record(Some(&prev), &d(7), "f", "medium", 0, 0, 0);
    assert!(ok.stable && ok.cause == "none" && ok.diverge_at.is_none());
    // an effort change keeps the content but changes the provider's cache key
    let e = prefix_record(Some(&prev), &d(7), "f", "high", 0, 0, 0);
    assert!(e.stable);
    assert_eq!(e.cause, "effort-change");
    let mut cut = d(7);
    cut.remove(2);
    let r = prefix_record(Some(&prev), &cut, "f", "medium", 0, 0, 1);
    assert!(!r.stable);
    assert_eq!(
        (r.diverge_at, r.cause.as_str()),
        (Some(2), "reasoning-replay")
    );
    assert_eq!(
        prefix_record(Some(&prev), &cut, "f", "medium", 1, 0, 0).cause,
        "context-compaction"
    );
    assert_eq!(
        prefix_record(Some(&prev), &cut, "f", "medium", 0, 1, 0).cause,
        "memory-fold"
    );
    assert_eq!(
        prefix_record(Some(&prev), &cut, "f", "medium", 0, 0, 0).cause,
        "unknown"
    );
    assert_eq!(
        prefix_record(Some(&prev), &d(7), "g", "medium", 0, 0, 0).cause,
        "request-format"
    );
    assert_eq!(
        prefix_record(Some(&prev), &cut, "f", "high", 0, 0, 1).cause,
        "effort-change+reasoning-replay"
    );
}

#[test]
fn m47_reasoning_replay_policy_parsing_is_closed() {
    for (s, p) in [
        ("window", ReasoningReplay::Window),
        ("append-only", ReasoningReplay::AppendOnly),
        ("none", ReasoningReplay::None),
    ] {
        assert_eq!(ReasoningReplay::parse(s), Some(p));
        assert_eq!(p.as_str(), s);
    }
    for bad in ["", "all", "Window", "none "] {
        assert!(ReasoningReplay::parse(bad).is_none());
    }
}
