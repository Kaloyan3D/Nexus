use super::legacy_reference as legacy;
use super::muse_v0::{self, MuseV0State, MUSE_V0};
use super::*;

fn snap() -> EngineSnapshot {
    EngineSnapshot {
        kind: Some(RunKind::Code),
        interactive: true,
        ..Default::default()
    }
}

fn host() -> EngineHost {
    EngineHost::new(&MUSE_V0)
}

fn muse(s: &EngineState) -> &MuseV0State {
    match &s.data {
        EngineStateData::MuseV0(d) => d,
        #[allow(unreachable_patterns)]
        _ => panic!("not muse-v0 state"),
    }
}

/// A proposal from the current state with a hand-made action/state (to test the validator).
fn proposal(h: &EngineHost, action: EngineAction, data: MuseV0State) -> EngineProposal {
    EngineProposal {
        proposal_id: h.receipts().len() as u64 + 1,
        based_on_revision: h.state().revision,
        action,
        effort: EffortProposal::KeepPinned,
        next_state: EngineState {
            engine_id: "muse-v0",
            schema: 1,
            revision: h.state().revision + 1,
            data: EngineStateData::MuseV0(data),
        },
    }
}

fn nudge(text: &str, ordinal: u32) -> EngineAction {
    EngineAction::Guide(Guidance {
        message: text.into(),
        reason: "r".into(),
        kind: GuidanceKind::Nudge,
        ordinal,
    })
}

// ------------------------------------------------------------------ selection

#[test]
fn the_registry_selected_mode_resolves_to_its_extension_and_anything_else_fails_closed() {
    let e = resolve("engineering-v2", "muse-v0").expect("muse-v0");
    assert_eq!(e.descriptor().engine_id, "muse-v0");
    assert_eq!(e.descriptor().contract_version, ENGINE_CONTRACT_VERSION);
    assert_eq!(e.descriptor().roles, &["muse_main"]);
    assert!(
        !e.descriptor().may_propose_effort,
        "contract v1: no effort authority"
    );
    // engines this runtime does not have: Dual, Nova, typos, empty (a resolution without the field)
    for (mode, engine) in [
        ("engineering-v1", "dual-v1"),
        ("engineering-v3", "nova-v3"),
        ("engineering-v2", "muse-v1"),
        ("engineering-v2", "muse"),
        ("engineering-v2", ""),
    ] {
        let r = resolve(mode, engine).err().expect(engine);
        assert_eq!(r.code, "engine-unavailable", "{engine}");
        assert!(r.message.contains("nothing was sent"));
    }
    // a known engine asked to run a mode it does not declare
    assert_eq!(
        resolve("engineering-v1", "muse-v0").err().unwrap().code,
        "engine-mode-mismatch"
    );
    assert_eq!(
        resolve("", "muse-v0").err().unwrap().code,
        "engine-mode-mismatch"
    );
    // a hostile id never reaches a message unfiltered
    let r = resolve("engineering-v2\n<x>", "eng\u{1b}ine")
        .err()
        .unwrap();
    assert!(!r.message.contains('\n') && !r.message.contains('\u{1b}') && !r.message.contains('<'));
}

// ------------------------------------------------------------------ validation

#[test]
fn a_proposal_cannot_change_the_reasoning_effort_of_the_pinned_target() {
    let mut h = host();
    let mut p = proposal(&h, EngineAction::Continue, MuseV0State::default());
    p.effort = EffortProposal::Change("xhigh".into());
    let r = h.accept(Hook::BeforeRequest, &snap(), p).unwrap_err();
    assert_eq!(r.code, "engine-effort-not-authorized");
    assert_eq!(h.state().revision, 0, "nothing was committed");
    assert!(h.receipts().is_empty());
}

#[test]
fn only_the_actions_admitted_at_a_hook_are_accepted() {
    let refused = [
        (Hook::BeforeRequest, EngineAction::Finish),
        (Hook::BeforeRequest, nudge("x", 1)),
        (Hook::AfterToolPhase, EngineAction::Finish),
        (Hook::AfterToolPhase, nudge("x", 1)),
        (Hook::FinalResponse, EngineAction::Continue),
        (
            Hook::FinalResponse,
            EngineAction::Guide(Guidance {
                message: "x".into(),
                reason: "r".into(),
                kind: GuidanceKind::Steer,
                ordinal: 1,
            }),
        ),
        // reserved for later contracts: never admitted in v1, at any hook
        (Hook::FinalResponse, EngineAction::RequestVerification),
        (Hook::FinalResponse, EngineAction::AskOperator),
        (Hook::AfterToolPhase, EngineAction::RequestChildRun),
        (Hook::BeforeRequest, EngineAction::RequestChildRun),
    ];
    for (hook, action) in refused {
        let mut h = host();
        let p = proposal(&h, action.clone(), MuseV0State::default());
        let r = h.accept(hook, &snap(), p).unwrap_err();
        assert_eq!(r.code, "engine-action-not-admitted", "{hook:?} {action:?}");
        assert_eq!(h.state().revision, 0);
    }
    // and the admitted ones are
    let mut h = host();
    let s1 = MuseV0State {
        nudges: 1,
        ..Default::default()
    };
    assert_eq!(
        h.accept(
            Hook::FinalResponse,
            &snap(),
            proposal(&h, nudge("go on", 1), s1)
        )
        .unwrap(),
        EngineDecision::Guide(Guidance {
            message: "go on".into(),
            reason: "r".into(),
            kind: GuidanceKind::Nudge,
            ordinal: 1
        })
    );
}

#[test]
fn replayed_stale_foreign_or_jumping_proposals_are_refused_and_change_nothing() {
    let mut h = host();
    // one accepted proposal first
    let ok = proposal(&h, EngineAction::Continue, MuseV0State::default());
    h.accept(Hook::BeforeRequest, &snap(), ok.clone()).unwrap();
    assert_eq!(h.state().revision, 1);
    // the same proposal again (replay)
    assert_eq!(
        h.accept(Hook::BeforeRequest, &snap(), ok).unwrap_err().code,
        "engine-proposal-replayed"
    );
    // based on an older revision
    let mut p = proposal(&h, EngineAction::Continue, MuseV0State::default());
    p.based_on_revision = 0;
    assert_eq!(
        h.accept(Hook::BeforeRequest, &snap(), p).unwrap_err().code,
        "engine-state-stale"
    );
    // another engine's state
    let mut p = proposal(&h, EngineAction::Continue, MuseV0State::default());
    p.next_state.engine_id = "dual-v1";
    assert_eq!(
        h.accept(Hook::BeforeRequest, &snap(), p).unwrap_err().code,
        "engine-state-foreign"
    );
    // a revision that skips
    let mut p = proposal(&h, EngineAction::Continue, MuseV0State::default());
    p.next_state.revision += 1;
    assert_eq!(
        h.accept(Hook::BeforeRequest, &snap(), p).unwrap_err().code,
        "engine-state-revision"
    );
    assert_eq!(h.state().revision, 1);
    assert_eq!(h.receipts().len(), 1);
}

#[test]
fn guidance_must_be_bounded() {
    for (msg, ordinal) in [
        ("", 1),
        ("   ", 1),
        (&*"x".repeat(MAX_GUIDANCE_BYTES + 1), 1),
        ("fine", 0),
    ] {
        let mut h = host();
        let s = MuseV0State {
            nudges: 1,
            ..Default::default()
        };
        let p = proposal(&h, nudge(msg, ordinal), s);
        assert_eq!(
            h.accept(Hook::FinalResponse, &snap(), p).unwrap_err().code,
            "engine-guidance-invalid"
        );
    }
}

#[test]
fn invalid_engine_state_transitions_are_rejected() {
    let bad: Vec<(&str, MuseV0State, EngineSnapshot)> = vec![
        (
            "a counter jumps by two",
            MuseV0State {
                nudges: 2,
                ..Default::default()
            },
            snap(),
        ),
        (
            "a counter above its cap",
            MuseV0State {
                tidy_nudges: 2,
                ..Default::default()
            },
            snap(),
        ),
        (
            "the progress mark runs ahead of the receipts",
            MuseV0State {
                progress_mark: 5,
                ..Default::default()
            },
            snap(),
        ),
        (
            "the narration window overflows",
            MuseV0State {
                recent_narration: vec!["a".into(); 5],
                ..Default::default()
            },
            snap(),
        ),
    ];
    for (why, state, s) in bad {
        let mut h = host();
        let p = proposal(&h, EngineAction::Continue, state);
        assert_eq!(
            h.accept(Hook::BeforeRequest, &s, p).unwrap_err().code,
            "engine-state-transition",
            "{why}"
        );
    }
    // a reset is valid only when the receipts show progress
    let mut h = host();
    for _ in 0..3 {
        let next = MuseV0State {
            nudges: muse(h.state()).nudges + 1,
            ..muse(h.state()).clone()
        };
        let n = next.nudges;
        h.accept(
            Hook::FinalResponse,
            &snap(),
            proposal(&h, nudge("go", n), next),
        )
        .unwrap();
    }
    let reset = MuseV0State::default();
    assert_eq!(
        h.accept(
            Hook::BeforeRequest,
            &snap(),
            proposal(&h, EngineAction::Continue, reset.clone())
        )
        .unwrap_err()
        .code,
        "engine-state-transition",
        "no progress: no reset"
    );
    let progressed = EngineSnapshot {
        edits_used: 1,
        ..snap()
    };
    let reset = MuseV0State {
        progress_mark: 1,
        ..reset
    };
    h.accept(
        Hook::BeforeRequest,
        &progressed,
        proposal(&h, EngineAction::Continue, reset),
    )
    .unwrap();
}

#[test]
fn engine_state_never_crosses_runs() {
    let mut a = host();
    let b = host();
    let s = EngineSnapshot {
        expects_change: true,
        tool_calls: 3,
        ..snap()
    };
    let d = a.consult(
        Hook::FinalResponse,
        &EngineSnapshot {
            response_text: "Now I will edit the file.".into(),
            ..s
        },
    );
    assert!(matches!(d, Ok(EngineDecision::Guide(_))));
    assert!(muse(a.state()).nudges == 1 && a.state().revision == 1);
    // the other run is untouched, and a new run starts from scratch
    assert_eq!(b.state(), &MUSE_V0.initial_state());
    assert_eq!(host().state(), &MUSE_V0.initial_state());
}

/// A hostile engine (compiled into the test only) gets nothing past the host: it cannot change
/// the effort, ask for a child run or skip the revision.
#[test]
fn a_hostile_engine_cannot_bypass_the_host() {
    struct Hostile;
    static DESC: EngineDescriptor = EngineDescriptor {
        engine_id: "muse-v0",
        contract_version: ENGINE_CONTRACT_VERSION,
        mode_ids: &["engineering-v2"],
        roles: &["muse_main"],
        state_schema: 1,
        may_propose_effort: true, // even a descriptor that claims effort authority
        inherits_state: false,
    };
    impl EngineExtension for Hostile {
        fn descriptor(&self) -> &EngineDescriptor {
            &DESC
        }
        fn initial_state(&self) -> EngineState {
            MUSE_V0.initial_state()
        }
        fn propose(
            &self,
            hook: Hook,
            _snapshot: &EngineSnapshot,
            state: &EngineState,
            proposal_id: u64,
        ) -> EngineProposal {
            EngineProposal {
                proposal_id,
                based_on_revision: state.revision,
                action: if hook == Hook::AfterToolPhase {
                    EngineAction::RequestChildRun
                } else {
                    EngineAction::Continue
                },
                effort: if hook == Hook::BeforeRequest {
                    EffortProposal::Change("max".into())
                } else {
                    EffortProposal::KeepPinned
                },
                next_state: EngineState {
                    revision: state.revision + 1,
                    ..state.clone()
                },
            }
        }
        fn check_transition(
            &self,
            _: &EngineState,
            _: &EngineState,
            _: &EngineSnapshot,
        ) -> Result<(), String> {
            Ok(())
        }
        fn persist_state(&self, _: &EngineState) -> serde_json::Value {
            serde_json::Value::Null
        }
    }
    static HOSTILE: Hostile = Hostile;
    let mut h = EngineHost::new(&HOSTILE);
    assert_eq!(
        h.consult(Hook::BeforeRequest, &snap()).unwrap_err().code,
        "engine-effort-not-authorized"
    );
    assert_eq!(
        h.consult(Hook::AfterToolPhase, &snap()).unwrap_err().code,
        "engine-action-not-admitted"
    );
    assert_eq!(h.state().revision, 0);
    // and it is not selectable: built-in engines only
    assert!(std::ptr::eq(
        resolve("engineering-v2", "muse-v0").unwrap().descriptor(),
        MUSE_V0.descriptor()
    ));
}

// ------------------------------------------------------------------ muse-v0 policy (ported)

fn final_response(h: &mut EngineHost, s: &EngineSnapshot) -> Option<(String, String)> {
    match h.consult(Hook::FinalResponse, s).expect("accepted") {
        EngineDecision::Guide(g) => Some((g.message, g.reason)),
        EngineDecision::Finish => None,
        EngineDecision::Continue => unreachable!(),
    }
}

/// `premature_stop` alone (the old unit tests called it without the outer nudge gate).
fn stop(
    state: &mut MuseV0State,
    s: &EngineSnapshot,
    text: &str,
) -> Option<(&'static str, &'static str)> {
    muse_v0::premature_stop(state, s, text)
}

#[test]
fn the_harness_does_not_accept_an_announcement_or_an_unverified_change_as_the_end() {
    let base = EngineSnapshot {
        tool_calls: 12,
        ..snap()
    };
    assert!(stop(
        &mut MuseV0State::default(),
        &base,
        "Let me check the remaining files now."
    )
    .is_some());
    let narr = "Collecting evidence and validating findings. ".repeat(10);
    let s30 = EngineSnapshot {
        tool_calls: 30,
        ..snap()
    };
    assert!(stop(&mut MuseV0State::default(), &s30, &narr).is_some());
    let report = format!(
        "# Report\n\n- finding one\n- finding two\n\n{}",
        "Evidence and analysis. ".repeat(100)
    );
    assert!(stop(&mut MuseV0State::default(), &s30, &report).is_none());
    let changed = EngineSnapshot {
        tool_calls: 5,
        edits_used: 2,
        dirty_since_test: true,
        ..snap()
    };
    let done = "Implemented the change in two files and added tests.";
    let mut st = MuseV0State::default();
    assert!(stop(&mut st, &changed, done).is_some());
    assert!(stop(&mut st, &changed, done).is_none(), "asked only once");
    let failing = EngineSnapshot {
        tool_calls: 5,
        edits_used: 1,
        last_test: Some("fail".into()),
        ..snap()
    };
    let mut st = MuseV0State::default();
    assert!(stop(&mut st, &failing, done).is_some());
    assert!(stop(&mut st, &failing, done).is_some());
    assert!(stop(&mut st, &failing, done).is_none());
    let verified = EngineSnapshot {
        tool_calls: 9,
        edits_used: 1,
        last_test: Some("pass".into()),
        ..snap()
    };
    assert!(stop(&mut MuseV0State::default(), &verified, done).is_none());
}

const INCIDENT: &str = include_str!("../../tests/fixtures/planning-loop-final-answer.txt");

#[test]
fn a_planning_ramble_is_no_longer_accepted_as_the_finished_task() {
    assert!(muse_v0::looks_like_report(INCIDENT));
    let s40 = EngineSnapshot {
        tool_calls: 40,
        ..snap()
    };
    assert!(stop(&mut MuseV0State::default(), &s40, INCIDENT).is_none());
    let impl40 = EngineSnapshot {
        expects_change: true,
        ..s40.clone()
    };
    let mut st = MuseV0State::default();
    for _ in 0..3 {
        let (msg, why) = stop(&mut st, &impl40, INCIDENT).expect("nudged");
        assert!(
            msg.contains("IMPLEMENT") || msg.contains("plain text"),
            "{msg}"
        );
        assert!(why.contains("plan") || why.contains("text"), "{why}");
    }
    assert_eq!(st.plan_nudges, 3);
    let passed = EngineSnapshot {
        last_test: Some("pass".into()),
        ..impl40
    };
    let mut st = MuseV0State::default();
    assert!(stop(&mut st, &passed, INCIDENT).is_none());
    assert_eq!(st.plan_nudges, 0);
    let mut st = MuseV0State::default();
    let _ = stop(&mut st, &s40, INCIDENT);
    assert_eq!(st.plan_nudges, 0);
}

#[test]
fn stall_budgets_start_over_when_the_run_makes_progress() {
    let mut h = host();
    let mut s = EngineSnapshot {
        expects_change: true,
        tool_calls: 30,
        edits_used: 1,
        applied_edits: 1,
        response_text: "Next: inspect the stub. Proceeding.".into(),
        ..snap()
    };
    let stops = |h: &mut EngineHost, s: &EngineSnapshot| -> u32 {
        let mut n = 0;
        while final_response(h, s).is_some() {
            n += 1;
        }
        n
    };
    let first = stops(&mut h, &s);
    assert!(
        (1..=muse_v0::MAX_NUDGES).contains(&first),
        "bounded: {first}"
    );
    assert_eq!(stops(&mut h, &s), 0, "no progress: the next stop is final");
    for _ in 0..6 {
        s.edits_used += 1;
        assert!(stops(&mut h, &s) >= 1);
        assert_eq!(stops(&mut h, &s), 0);
    }
}

#[test]
fn unresolved_failed_checks_are_asked_about_whatever_the_length_of_the_closing_text() {
    let text = include_str!("../../tests/fixtures/run14-terminal-response.txt");
    let mut s = EngineSnapshot {
        expects_change: true,
        tool_calls: 184,
        edits_used: 41,
        last_test: Some("pass".into()),
        ..snap()
    };
    let mut st = MuseV0State::default();
    assert!(stop(&mut st, &s, text).is_none());
    s.failed_checks = 5;
    let (msg, why) = stop(&mut st, &s, text).expect("asked about the failed checks");
    assert!(msg.contains("were never re-run successfully"), "{msg}");
    assert!(why.contains("failed checks"), "{why}");
    assert!(stop(&mut st, &s, text).is_some());
    assert!(stop(&mut st, &s, text).is_none());
    let short = EngineSnapshot {
        expects_change: true,
        tool_calls: 10,
        edits_used: 3,
        last_test: Some("pass".into()),
        failed_checks: 1,
        ..snap()
    };
    assert!(stop(&mut MuseV0State::default(), &short, "All done.").is_some());
}

// ------------------------------------------------------------------ differential parity

/// Deterministic xorshift (no dependency, reproducible).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[(self.next() % v.len() as u64) as usize]
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
}

/// The extension must make EXACTLY the decisions the pre-EM-01 loop made, with the same
/// counters, over long random runs that mix every reply shape and every receipt change.
#[test]
fn muse_v0_makes_exactly_the_decisions_of_the_pre_extension_loop() {
    let run14 = include_str!("../../tests/fixtures/run14-terminal-response.txt");
    let texts: Vec<String> = vec![
        String::new(),
        "All done.".into(),
        "Implemented the change in two files and added tests.".into(),
        "Let me check the remaining files now.".into(),
        "Now I will edit src/lib.rs.".into(),
        "Next: inspect the stub. Proceeding.".into(),
        "Item 9 is green (68 tests). Now the final item 10, version 0.5.0.".into(),
        "Plan:\n1. read the file\n2. edit it\n3. run the tests".into(),
        "I'll call fs_edit with {\"path\":\"a.rs\",\"edits\":[]} next.".into(),
        "Collecting evidence and validating findings. ".repeat(10),
        format!("# Report\n\n- one\n- two\n\n{}", "Evidence. ".repeat(200)),
        INCIDENT.into(),
        run14.into(),
        "Reading the file.".into(),
        "Reading the file.".into(),
        "Released version 0.5.0. All tests pass.".into(),
    ];
    let files: Vec<String> = vec!["src/a.rs".into(), "notes.tmp".into(), "x.bak".into()];
    let mut checked = 0u32;
    let mut guided = 0u32;
    for seed in 1..=400u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let interactive = rng.chance(80);
        let kind = if rng.chance(80) {
            RunKind::Code
        } else {
            RunKind::Inspect
        };
        let expects_change = rng.chance(70);
        let carried_work = rng.chance(20);
        let mut old = legacy::LegacyState {
            expects_change,
            carried_work,
            ..Default::default()
        };
        let mut h = host();
        for _step in 0..120 {
            // the receipts move as a run would
            if rng.chance(40) {
                old.tool_calls += 1 + (rng.next() % 4) as u32;
            }
            if rng.chance(12) {
                old.edits_used += 1;
                old.dirty_since_test = true;
                if rng.chance(85) {
                    old.applied += 1;
                }
            }
            if rng.chance(10) {
                old.tests_used += 1;
                old.dirty_since_test = false;
                old.last_test = Some(rng.pick(&["pass", "fail", "unverified"]).to_string());
                if old.last_test.as_deref() == Some("fail") {
                    old.failed_checks.insert(format!("c{}", rng.next() % 3));
                } else if rng.chance(50) {
                    old.failed_checks.clear();
                }
            }
            if rng.chance(5) {
                old.created.insert(rng.pick(&files).clone());
            }
            let text = rng.pick(&texts).clone();
            let s = EngineSnapshot {
                kind: Some(kind),
                interactive,
                turn: 0,
                tool_calls: old.tool_calls,
                edits_used: old.edits_used,
                tests_used: old.tests_used,
                applied_edits: old.applied,
                last_test: old.last_test.clone(),
                dirty_since_test: old.dirty_since_test,
                failed_checks: old.failed_checks.len() as u32,
                created_files: old.created.iter().cloned().collect(),
                expects_change,
                carried_work,
                response_text: text.clone(),
                ..Default::default()
            };
            let (new_decision, old_decision) = if rng.chance(55) {
                // a reply with tool calls: the steer after the tool phase
                let old_decision =
                    legacy::steer(&mut old, &text).map(|m| (m, String::new(), old.steers));
                let new_decision = match h.consult(Hook::AfterToolPhase, &s).expect("valid") {
                    EngineDecision::Guide(g) => Some((g.message, String::new(), g.ordinal)),
                    _ => None,
                };
                (new_decision, old_decision)
            } else {
                // a reply without a tool call: the old gate + premature_stop
                legacy::refresh_stall_budget(&mut old);
                let old_decision =
                    if interactive && kind == RunKind::Code && old.nudges < legacy::MAX_NUDGES {
                        legacy::premature_stop(&mut old, &text).map(|(m, r)| {
                            old.nudges += 1;
                            (m.to_string(), r.to_string(), old.nudges)
                        })
                    } else {
                        None
                    };
                let new_decision = match h.consult(Hook::FinalResponse, &s).expect("valid") {
                    EngineDecision::Guide(g) => Some((g.message, g.reason, g.ordinal)),
                    EngineDecision::Finish => None,
                    EngineDecision::Continue => unreachable!(),
                };
                (new_decision, old_decision)
            };
            assert_eq!(new_decision, old_decision, "seed {seed}: {text:.60}");
            guided += new_decision.is_some() as u32;
            let st = muse(h.state());
            assert_eq!(
                (
                    st.nudges,
                    st.plan_nudges,
                    st.report_nudges,
                    st.verify_nudges,
                    st.fail_nudges,
                    st.tidy_nudges,
                    st.steers,
                    st.progress_mark,
                    &st.recent_narration
                ),
                (
                    old.nudges,
                    old.plan_nudges,
                    old.report_nudges,
                    old.verify_nudges,
                    old.fail_nudges,
                    old.tidy_nudges,
                    old.steers,
                    old.progress_mark,
                    &old.recent_narration
                ),
                "seed {seed}"
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 400 * 120);
    assert!(
        guided > 1000,
        "the corpus must exercise the guidance paths: {guided}"
    );
}

#[test]
fn an_oversized_engine_state_is_refused_before_the_engine_rules_run() {
    let mut h = host();
    let big = MuseV0State {
        recent_narration: vec!["n".repeat(MAX_STATE_BYTES / 2); 3],
        ..Default::default()
    };
    let p = proposal(&h, EngineAction::Continue, big);
    assert_eq!(
        h.accept(Hook::BeforeRequest, &snap(), p).unwrap_err().code,
        "engine-state-oversized"
    );
    assert_eq!(h.state(), &MUSE_V0.initial_state());
}

// ------------------------------------------------------------------ sealed identity (check 1)

/// A Registry resolution as the issuer produces it: its issuanceId is the digest of its content.
fn issued(mode: &str, engine: &str) -> serde_json::Value {
    let mut target =
        nexus_contracts::ExecutionTargetCoreV1::sample("muse_main", mode, serde_json::json!(1));
    target.orchestration_engine_id = engine.into();
    let mut r = nexus_contracts::RegistryResolutionV1 {
        schema_version: target.schema_version,
        issuer: "registry".into(),
        task_instance_id: "task-1".into(),
        role: "muse_main".into(),
        target,
        provenance: nexus_contracts::RegistryProvenanceV1 {
            issuer: "registry".into(),
            resolution_id_compat: "r".into(),
            registry_snapshot_digest: "s".into(),
            target_digest: "t".into(),
            mode_config_revision: serde_json::json!(1),
            issuance_id: String::new(),
        },
    };
    r.provenance.issuance_id = r.issuance_id_of();
    serde_json::to_value(r).unwrap()
}

#[test]
fn the_engine_comes_from_the_issued_resolution_and_a_tampered_one_is_refused() {
    let (e, mode) = resolve_issued(&issued("engineering-v2", "muse-v0")).expect("issued muse");
    assert_eq!(
        (e.descriptor().engine_id, mode.as_str()),
        ("muse-v0", "engineering-v2")
    );
    // a genuine issuance of an engine this runtime does not have
    assert_eq!(
        resolve_issued(&issued("engineering-v1", "dual-v1"))
            .err()
            .unwrap()
            .code,
        "engine-unavailable"
    );
    // the engine id swapped after issuance (to one that IS available): digest mismatch
    let mut v = issued("engineering-v2", "dual-v1");
    v["target"]["orchestrationEngineId"] = "muse-v0".into();
    assert_eq!(
        resolve_issued(&v).err().unwrap().code,
        "engine-identity-invalid"
    );
    // the mode swapped after issuance
    let mut v = issued("engineering-v1", "muse-v0");
    v["target"]["modeId"] = "engineering-v2".into();
    assert_eq!(
        resolve_issued(&v).err().unwrap().code,
        "engine-identity-invalid"
    );
    // not a resolution at all (what an unexpected bridge reply would look like)
    for v in [
        serde_json::json!({}),
        serde_json::json!(null),
        serde_json::json!({"target": {"modeId": "engineering-v2", "orchestrationEngineId": "muse-v0"}}),
    ] {
        assert_eq!(
            resolve_issued(&v).err().unwrap().code,
            "engine-identity-invalid"
        );
    }
}

// ------------------------------------------------------------------ atomicity and replay (check 6)

/// Thousands of mutated proposals: whatever the host refuses leaves the state, the receipts and
/// the next expected proposal id exactly as they were (no partial application).
#[test]
fn a_refused_proposal_applies_nothing() {
    let mut rng = Rng(0x5EED_0E01);
    let mut h = host();
    let base = EngineSnapshot {
        expects_change: true,
        tool_calls: 30,
        response_text: "Now I will edit the file.".into(),
        ..snap()
    };
    let (mut accepted, mut refused) = (0u32, 0u32);
    for _ in 0..5000 {
        let hook = *rng.pick(&[
            Hook::BeforeRequest,
            Hook::AfterToolPhase,
            Hook::FinalResponse,
        ]);
        let mut p = MUSE_V0.propose(hook, &base, h.state(), h.receipts().len() as u64 + 1);
        #[allow(irrefutable_let_patterns)]
        let EngineStateData::MuseV0(d) = &mut p.next_state.data
        else {
            unreachable!()
        };
        match rng.next() % 12 {
            0 => p.proposal_id += 1 + rng.next() % 3,
            1 => p.based_on_revision = p.based_on_revision.wrapping_add(1),
            2 => p.effort = EffortProposal::Change("high".into()),
            3 => p.next_state.revision += 1,
            4 => p.next_state.engine_id = "nova-v3",
            5 => d.nudges += 2,
            6 => d.steers = 99,
            7 => d.progress_mark += 7,
            8 => d.recent_narration = vec!["x".into(); 9],
            9 => p.action = EngineAction::RequestChildRun,
            10 => p.next_state.schema = 2,
            _ => {} // unmodified: must be accepted
        }
        let before = (h.state().clone(), h.receipts().to_vec());
        match h.accept(hook, &base, p) {
            Ok(_) => accepted += 1,
            Err(_) => {
                refused += 1;
                assert_eq!((h.state().clone(), h.receipts().to_vec()), before);
            }
        }
    }
    assert!(accepted > 300 && refused > 3000, "{accepted} {refused}");
}

/// A restarted run (a new host) or a replayed proposal id never skips the transition rules: the
/// host checks every proposal against ITS state, so another run's state is either stale, a
/// replay, or an invalid jump.
#[test]
fn a_restart_or_a_repeated_proposal_id_cannot_bypass_the_transition_checks() {
    let s = EngineSnapshot {
        expects_change: true,
        tool_calls: 30,
        response_text: "Now I will edit the file.".into(),
        ..snap()
    };
    let mut a = host();
    let mut proposals = Vec::new();
    for _ in 0..3 {
        let p = MUSE_V0.propose(
            Hook::FinalResponse,
            &s,
            a.state(),
            a.receipts().len() as u64 + 1,
        );
        proposals.push(p.clone());
        assert!(matches!(
            a.accept(Hook::FinalResponse, &s, p),
            Ok(EngineDecision::Guide(_))
        ));
    }
    assert_eq!(muse(a.state()).nudges, 3);
    // the same id again on the same host
    assert_eq!(
        a.accept(Hook::FinalResponse, &s, proposals[2].clone())
            .unwrap_err()
            .code,
        "engine-proposal-replayed"
    );
    // a "restarted" host: the old run's later proposals are stale for it
    let mut b = host();
    for p in &proposals[1..] {
        assert_eq!(
            b.accept(Hook::FinalResponse, &s, p.clone())
                .unwrap_err()
                .code,
            "engine-proposal-replayed"
        );
    }
    // re-labelled to look fresh, the old run's state is an invalid jump from the initial state
    let mut forged = proposals[2].clone();
    forged.proposal_id = 1;
    forged.based_on_revision = 0;
    forged.next_state.revision = 1;
    assert_eq!(
        b.accept(Hook::FinalResponse, &s, forged).unwrap_err().code,
        "engine-state-transition"
    );
    assert_eq!(b.state(), &MUSE_V0.initial_state());
    // the old run's FIRST proposal is valid from scratch only because it is a valid first step
    // (identical to what the new host's engine proposes itself)
    let own = MUSE_V0.propose(Hook::FinalResponse, &s, b.state(), 1);
    assert_eq!(own, proposals[0]);
}

// ------------------------------------------------------------------ contract v2 (EM-03)

mod v2 {
    use super::super::test_engine::{EffortTestState, EFFORT_TEST_V0};
    use super::super::*;

    fn snap2(dispatched: u32, current: &str) -> EngineSnapshot {
        EngineSnapshot {
            kind: Some(RunKind::Code),
            interactive: true,
            attempts_dispatched: dispatched,
            current_effort: current.into(),
            authorized_efforts: vec!["high".into(), "low".into()],
            ..Default::default()
        }
    }

    fn prop(
        h: &EngineHost,
        effort: EffortProposal,
        action: EngineAction,
        dispatched: u32,
    ) -> EngineProposal {
        let mut p = EFFORT_TEST_V0.propose(
            Hook::BeforeRequest,
            &snap2(dispatched, "low"),
            h.state(),
            h.next_proposal_id(),
        );
        p.effort = effort;
        p.action = action;
        p
    }

    #[test]
    fn an_accepted_change_designates_the_next_attempt_and_never_an_earlier_one() {
        let mut h = EngineHost::new(&EFFORT_TEST_V0);
        // one attempt dispatched; the change is for attempt 2 on
        let p = prop(
            &h,
            EffortProposal::Change("high".into()),
            EngineAction::Continue,
            1,
        );
        h.accept(Hook::BeforeRequest, &snap2(1, "low"), p).unwrap();
        let sel = h.effort_selection().unwrap().clone();
        assert_eq!(
            (sel.effort.as_str(), sel.from_attempt, sel.proposal_id),
            ("high", 2, 1)
        );
        assert_eq!(h.effort_for_attempt(1), None, "never retroactive");
        assert_eq!(h.effort_for_attempt(2), Some("high"));
        assert_eq!(
            h.effort_for_attempt(9),
            Some("high"),
            "in force until changed"
        );
        assert_eq!(h.receipts()[0].effort.as_ref(), Some(&sel));
    }

    #[test]
    fn unauthorized_changes_are_refused_and_change_nothing() {
        let cases: Vec<(
            &dyn EngineExtension,
            EffortProposal,
            EngineAction,
            Hook,
            &str,
        )> = vec![
            // a level outside the task binding
            (
                &EFFORT_TEST_V0,
                EffortProposal::Change("xhigh".into()),
                EngineAction::Continue,
                Hook::BeforeRequest,
                "engine-effort-not-authorized",
            ),
            // a change while finishing
            (
                &EFFORT_TEST_V0,
                EffortProposal::Change("high".into()),
                EngineAction::Finish,
                Hook::FinalResponse,
                "engine-effort-not-admitted",
            ),
            // an engine without effort authority (muse-v0)
            (
                &muse_v0::MUSE_V0,
                EffortProposal::Change("high".into()),
                EngineAction::Continue,
                Hook::BeforeRequest,
                "engine-effort-not-authorized",
            ),
        ];
        for (ext, effort, action, hook, code) in cases {
            let mut h = EngineHost::new(ext);
            let mut p = ext.propose(hook, &snap2(0, "low"), h.state(), 1);
            p.effort = effort;
            p.action = action;
            assert_eq!(h.accept(hook, &snap2(0, "low"), p).unwrap_err().code, code);
            assert_eq!(h.state(), &ext.initial_state());
            assert!(h.effort_selection().is_none() && h.receipts().is_empty());
            assert_eq!(h.next_proposal_id(), 1);
        }
    }

    #[test]
    fn a_restored_host_refuses_replayed_stale_and_reordered_proposals() {
        let mut state = EFFORT_TEST_V0.initial_state();
        state.revision = 5;
        if let EngineStateData::EffortTestV0(d) = &mut state.data {
            d.proposals = 5;
        }
        let sel = EffortSelection {
            effort: "high".into(),
            from_attempt: 2,
            proposal_id: 5,
        };
        let mut h = EngineHost::restored(&EFFORT_TEST_V0, state, 5, Some(sel.clone()));
        assert_eq!(h.next_proposal_id(), 6);
        assert_eq!(
            h.effort_for_attempt(3),
            Some("high"),
            "the durable selection is restored"
        );
        // the same id as before the restart: a replay
        let mut p = prop(&h, EffortProposal::KeepPinned, EngineAction::Continue, 3);
        p.proposal_id = 5;
        assert_eq!(
            h.accept(Hook::BeforeRequest, &snap2(3, "high"), p)
                .unwrap_err()
                .code,
            "engine-proposal-replayed"
        );
        // two proposals built on the same revision (reordered): the second is stale
        let a = prop(
            &h,
            EffortProposal::Change("low".into()),
            EngineAction::Continue,
            3,
        );
        let mut b = a.clone();
        b.proposal_id = 7;
        h.accept(Hook::BeforeRequest, &snap2(3, "high"), a).unwrap();
        assert_eq!(
            h.accept(Hook::BeforeRequest, &snap2(3, "low"), b)
                .unwrap_err()
                .code,
            "engine-state-stale"
        );
        assert_eq!(h.effort_for_attempt(4), Some("low"));
        // a proposal skipping ahead
        let mut c = prop(&h, EffortProposal::KeepPinned, EngineAction::Continue, 3);
        c.proposal_id = 99;
        assert_eq!(
            h.accept(Hook::BeforeRequest, &snap2(3, "low"), c)
                .unwrap_err()
                .code,
            "engine-proposal-replayed"
        );
        let _ = EffortTestState::default();
    }

    #[test]
    fn the_test_engine_payload_round_trips_and_refuses_foreign_shapes() {
        let mut s = EFFORT_TEST_V0.initial_state();
        if let EngineStateData::EffortTestV0(d) = &mut s.data {
            d.attempts_total = 3;
            d.root_causes = vec!["off-by-one in add()".into()];
        }
        let v = EFFORT_TEST_V0.persist_state(&s);
        let r = EFFORT_TEST_V0.restore_state(&v, 0).unwrap();
        let EngineStateData::EffortTestV0(d) = &r.data else {
            panic!()
        };
        assert_eq!(
            (d.attempts_total, d.attempts_here, d.root_causes.len()),
            (3, 0, 1)
        );
        let mut bad = v.clone();
        bad["governorEffort"] = "max".into();
        assert!(
            EFFORT_TEST_V0.restore_state(&bad, 0).is_none(),
            "unknown field"
        );
        let mut bad = v.clone();
        bad["rootCauses"] = serde_json::json!(vec!["x"; 9]);
        assert!(
            EFFORT_TEST_V0.restore_state(&bad, 0).is_none(),
            "out of bounds"
        );
        // muse-v0 never inherits, and persists no model text
        assert!(muse_v0::MUSE_V0.restore_state(&v, 0).is_none());
        let mut m = muse_v0::MUSE_V0.initial_state();
        if let EngineStateData::MuseV0(d) = &mut m.data {
            d.recent_narration = vec!["Now I will edit src/lib.rs".into()];
        }
        let pv = muse_v0::MUSE_V0.persist_state(&m).to_string();
        assert!(!pv.contains("edit src/lib.rs") && pv.contains("narrationDigests"));
    }
}
