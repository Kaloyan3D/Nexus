//! EM-04C2 S6: Policy Version 2 of the Effort Transition Limiter (decision F-2).
//!
//! V1 (S5) is untouched and keeps its own tests and pinned fixture as historical regression
//! evidence. V2 adds the persisted logical-task flag `dropped_before`; these tests prove
//!
//! * V2 IS V1 inside one generation (5,000 traces: same actions, rules and V1 fields);
//! * across generations the claim-only re-arm privilege cannot be refilled, whatever the number of
//!   continuations (5,000 multi-generation tasks judged by an independent oracle);
//! * an elevated effort silently reset to the default counts as a drop;
//! * Kernel-verified failures still escalate at once, and forged/mis-versioned state is refused.

use super::effort_limiter::*;
use super::effort_limiter_tests::{generate, trace_seed, Rng};
use Level::{High, Low, Medium, Xhigh};

const AUTH: [Level; 4] = [Low, Medium, High, Xhigh];

fn input<'a>(
    attempt: u32,
    gov: Level,
    cur: Level,
    strong: bool,
    claims: u32,
    trusted: u32,
    edge: bool,
) -> LimiterInput<'a> {
    LimiterInput {
        attempt,
        governor: gov,
        current: cur,
        authorized: &AUTH,
        strong_escalation: strong,
        new_claim_units: claims,
        new_trusted_failures: trusted,
        progress_edge: edge,
    }
}

fn go(s: &LimiterStateV2, i: LimiterInput<'_>) -> LimiterDecisionV2 {
    limit_v2(s, &i).expect("valid")
}

// ------------------------------------------------------------------------ V2 == V1 in a generation

#[test]
fn inside_one_generation_policy_v2_is_policy_v1_on_5000_traces() {
    for index in 0..PROPERTY_TRACES_V2 {
        let (auth, steps) = generate(trace_seed(index));
        let (mut cur1, mut s1) = (Low, LimiterState::new());
        let (mut cur2, mut s2) = (Low, LimiterStateV2::new());
        for g in &steps {
            let mk = |cur| LimiterInput {
                attempt: g.attempt,
                governor: g.gov,
                current: cur,
                authorized: &auth,
                strong_escalation: g.strong,
                new_claim_units: g.claims,
                new_trusted_failures: g.trusted,
                progress_edge: g.edge,
            };
            let d1 = limit(&s1, &mk(cur1)).unwrap();
            let d2 = limit_v2(&s2, &mk(cur2)).unwrap();
            assert_eq!(
                (d1.action, d1.rule, d1.state),
                (d2.action, d2.rule, d2.state.core),
                "seed {:#x} at {g:?}",
                trace_seed(index)
            );
            // within a generation "has dropped" is exactly "a move down was applied"
            assert_eq!(
                d2.state.dropped_before,
                d2.state.core.last_down_attempt.is_some()
            );
            if let LimiterAction::Change(e) = d1.action {
                cur1 = e;
                cur2 = e;
            }
            s1 = d1.state;
            s2 = d2.state;
        }
    }
}

const PROPERTY_TRACES_V2: u64 = 5_000;

// ------------------------------------------------------------------------ multi-generation tasks

/// A logical task of up to four generations. Each generation restarts its attempt counter and the
/// effort at the default; the state crosses generations only through `continued_after_reset`.
#[test]
fn across_generations_the_claim_only_budget_is_never_refilled_on_5000_tasks() {
    let (mut hold_seen, mut reset_drops, mut tasks_with_rearms) = (0u64, 0u64, 0u64);
    for index in 0..PROPERTY_TRACES_V2 {
        let mut rng = Rng(trace_seed(index) ^ 0x5EED_F00D);
        let auth: Vec<Level> = {
            let mut a = vec![Low];
            for l in [Medium, High, Xhigh] {
                if rng.chance(3, 4) {
                    a.push(l);
                }
            }
            a
        };
        let (mut state, mut cur) = (LimiterStateV2::new(), Low);
        // the independent oracle
        let (mut dropped, mut trusted_since_drop, mut rearms) = (false, false, 0u32);
        let generations = 1 + rng.below(4) as u32;
        for gen in 0..generations {
            if gen > 0 {
                // an interruption: the effort in force resets to the default
                let elevated = cur > Low;
                state = state.continued_after_reset(cur, Low);
                // the corroboration of the previous generation was weighed by it
                trusted_since_drop = false;
                if elevated {
                    dropped = true;
                    reset_drops += 1;
                }
                cur = Low;
                assert_eq!(state.dropped_before, dropped, "task {index} gen {gen}");
                assert_eq!(state.core.last_attempt, 0);
                assert_eq!(state.core.pending_down, None);
                assert_eq!(state.core.last_down_attempt, None);
                assert!(!state.core.trusted_since_down);
            }
            let mut top = 0u32;
            let mut gov = Low;
            for _ in 0..(5 + rng.below(20)) {
                let attempt = if rng.chance(1, 20) {
                    top.max(1)
                } else {
                    top + 1
                };
                top = top.max(attempt);
                gov = match rng.below(6) {
                    0..=1 => gov,
                    _ => auth[rng.below(auth.len() as u64) as usize],
                };
                let strong = gov == Xhigh && rng.chance(4, 5) || rng.chance(1, 10);
                let claims = if rng.chance(1, 3) {
                    1 + rng.below(2) as u32
                } else {
                    0
                };
                let trusted = u32::from(rng.chance(1, 8));
                let edge = rng.chance(1, 6);
                let i = LimiterInput {
                    attempt,
                    governor: gov,
                    current: cur,
                    authorized: &auth,
                    strong_escalation: strong,
                    new_claim_units: claims,
                    new_trusted_failures: trusted,
                    progress_edge: edge,
                };
                let before = state;
                let d = limit_v2(&state, &i).unwrap();
                // monotonic history: tokens and the drop flag never go back, in any generation
                assert!(d.state.core.rearm_tokens_used >= before.core.rearm_tokens_used);
                assert!(d.state.dropped_before >= before.dropped_before);
                assert!(d.state.core.rearm_tokens_used <= REARM_TOKENS);
                let replay = d.rule == LimiterRule::ReplayGuard;
                if !replay {
                    // oracle bookkeeping BEFORE applying
                    if trusted > 0 && dropped {
                        trusted_since_drop = true;
                    }
                    if gov > cur {
                        let free = !dropped || !strong;
                        let bypass = dropped && strong && trusted_since_drop;
                        if free || bypass {
                            assert_eq!(
                                d.action,
                                LimiterAction::Change(gov),
                                "task {index}: a free or corroborated escalation was delayed"
                            );
                        } else if before.core.rearm_tokens_used < REARM_TOKENS {
                            // a claim-only re-arm after a drop: costs a token, at most R per TASK
                            assert_eq!(d.action, LimiterAction::Change(gov));
                            rearms += 1;
                            assert!(
                                rearms <= u32::from(REARM_TOKENS),
                                "task {index} gen {gen}: {rearms} claim-only re-arms across generations"
                            );
                        } else {
                            hold_seen += 1;
                            assert_eq!(d.action, LimiterAction::KeepPinned);
                            assert_eq!(d.rule, LimiterRule::HoldRearm);
                        }
                    }
                }
                if let LimiterAction::Change(e) = d.action {
                    assert_ne!(e, cur);
                    assert!(auth.contains(&e) && e != Level::Max);
                    if e < cur {
                        dropped = true;
                        trusted_since_drop = false;
                    }
                    if e > cur && strong && dropped && trusted_since_drop {
                        trusted_since_drop = false; // the corroboration was spent by this escalation
                    }
                    cur = e;
                }
                assert_eq!(
                    d.state.dropped_before, dropped,
                    "task {index}: flag vs oracle"
                );
                state = d.state;
            }
        }
        tasks_with_rearms += u64::from(rearms > 0);
    }
    assert!(hold_seen > 100, "holds exercised: {hold_seen}");
    assert!(
        reset_drops > 500,
        "implicit resets exercised: {reset_drops}"
    );
    assert!(
        tasks_with_rearms > 100,
        "re-arms exercised: {tasks_with_rearms}"
    );
}

// ------------------------------------------------------------------------ named scenarios

fn escalate_strong_free(s: LimiterStateV2, n: u32) -> LimiterDecisionV2 {
    let d = go(&s, input(n, Xhigh, Low, true, 2, 0, false));
    assert_eq!(d.action, LimiterAction::Change(Xhigh));
    d
}

#[test]
fn an_implicit_reset_of_an_elevated_effort_is_a_drop_and_each_continuation_costs_a_token() {
    // generation 1: the first strong escalation of the task is free
    let g1 = escalate_strong_free(LimiterStateV2::new(), 1);
    assert_eq!(g1.state.core.rearm_tokens_used, 0);
    assert!(!g1.state.dropped_before);
    // interruption: xhigh silently resets to low -> a drop for this policy
    let mut s = g1.state.continued_after_reset(Xhigh, Low);
    assert!(s.dropped_before);
    // generation 2..: the same claims escalate again, but NOW they cost the budget
    for (gen, want_tokens) in [(2, 1u8), (3, 2u8)] {
        let d = go(&s, input(1, Xhigh, Low, true, 1, 0, false));
        assert_eq!(d.action, LimiterAction::Change(Xhigh), "generation {gen}");
        assert_eq!(d.rule, LimiterRule::Up);
        assert_eq!(
            d.state.core.rearm_tokens_used, want_tokens,
            "generation {gen}"
        );
        s = d.state.continued_after_reset(Xhigh, Low);
        assert_eq!(
            s.core.rearm_tokens_used, want_tokens,
            "kept across the continuation"
        );
    }
    // generation 4: R = 2 per LOGICAL task - held, however often it is interrupted and retried
    for gen in 4..12 {
        let d = go(&s, input(1, Xhigh, Low, true, 1, 0, false));
        assert_eq!(d.action, LimiterAction::KeepPinned, "generation {gen}");
        assert_eq!(d.rule, LimiterRule::HoldRearm);
        s = d.state.continued_after_reset(Low, Low); // nothing elevated to reset now
        assert_eq!(s.core.rearm_tokens_used, REARM_TOKENS);
        assert!(s.dropped_before);
    }
}

#[test]
fn v1_would_have_refilled_the_privilege_and_v2_does_not() {
    // the S5 finding F-2, reproduced: under V1 each continuation clears `last_down_attempt`, so the
    // strong escalation after it is "the first one" again, token-free, forever
    let mut v1 = LimiterState::new();
    for gen in 0..6 {
        let d = limit(&v1, &input(1, Xhigh, Low, true, 1, 0, false)).unwrap();
        assert_eq!(
            d.action,
            LimiterAction::Change(Xhigh),
            "V1 generation {gen}"
        );
        assert_eq!(
            d.state.rearm_tokens_used, 0,
            "V1 never spends a token across generations"
        );
        v1 = d.state.continued();
    }
    // the same history under V2 is bounded
    let mut v2 = LimiterStateV2::new();
    let mut changes = 0;
    for _ in 0..6 {
        let d = go(&v2, input(1, Xhigh, Low, true, 1, 0, false));
        changes += usize::from(matches!(d.action, LimiterAction::Change(_)));
        v2 = d.state.continued_after_reset(
            if matches!(d.action, LimiterAction::Change(_)) {
                Xhigh
            } else {
                Low
            },
            Low,
        );
    }
    assert_eq!(
        changes,
        1 + usize::from(REARM_TOKENS),
        "one free + R tokens, then nothing"
    );
}

#[test]
fn an_effort_at_or_below_the_default_is_not_a_drop() {
    let s = LimiterStateV2::new();
    assert!(!s.continued_after_reset(Low, Low).dropped_before);
    assert!(
        !s.continued_after_reset(Low, Medium).dropped_before,
        "below the default"
    );
    assert!(!s.continued_after_reset(Medium, Medium).dropped_before);
    assert!(s.continued_after_reset(High, Medium).dropped_before);
    // without an interruption nothing changes the flag; it can never be cleared
    let mut d = LimiterStateV2::new().continued_after_reset(Xhigh, Low);
    for _ in 0..5 {
        d = d.continued();
        assert!(d.dropped_before);
    }
    // a plain continuation of a never-dropped task keeps the privilege (nothing was consumed)
    let fresh = LimiterStateV2::new().continued();
    assert!(!fresh.dropped_before);
    assert_eq!(
        go(&fresh, input(1, Xhigh, Low, true, 1, 0, false)).action,
        LimiterAction::Change(Xhigh)
    );
}

#[test]
fn a_kernel_verified_failure_still_escalates_at_once_after_the_budget_is_spent() {
    let spent = LimiterStateV2 {
        core: LimiterState {
            rearm_tokens_used: REARM_TOKENS,
            ..LimiterState::new()
        },
        dropped_before: true,
    };
    // claim-only: held
    assert_eq!(
        go(&spent, input(1, Xhigh, Low, true, 3, 0, false)).rule,
        LimiterRule::HoldRearm
    );
    // this evaluation folded a Kernel-verified failure: immediate, budget untouched
    let d = go(&spent, input(1, Xhigh, Low, true, 3, 1, false));
    assert_eq!(d.action, LimiterAction::Change(Xhigh));
    assert_eq!(d.state.core.rearm_tokens_used, REARM_TOKENS);
    assert!(
        !d.state.core.trusted_since_down,
        "the corroboration was spent by the escalation"
    );
    // a failure folded EARLIER in the new generation (attempt 1) also credits attempt 3
    let h = go(&spent, input(1, Medium, Low, false, 0, 1, false));
    assert!(
        h.state.core.trusted_since_down,
        "credited because the task has dropped before"
    );
    let e = go(&h.state, input(3, Xhigh, High, true, 1, 0, false));
    assert_eq!(e.action, LimiterAction::Change(Xhigh));
    // ... and a never-dropped task gets no spurious credit
    let n = go(
        &LimiterStateV2::new(),
        input(1, Medium, Low, false, 0, 1, false),
    );
    assert!(!n.state.core.trusted_since_down);
}

#[test]
fn an_unchanged_level_never_produces_a_change_in_any_generation() {
    let mut s = LimiterStateV2::new().continued_after_reset(Xhigh, Low);
    for n in 1..30 {
        let cur = AUTH[(n as usize) % AUTH.len()];
        let d = go(
            &s,
            input(n, cur, cur, n % 2 == 0, n % 3, n % 5 % 2, n % 4 == 0),
        );
        assert_eq!(d.action, LimiterAction::KeepPinned);
        assert_eq!(d.rule, LimiterRule::Noop);
        s = d.state;
    }
}

// ------------------------------------------------------------------------ state and versions

fn spent_state() -> LimiterStateV2 {
    LimiterStateV2 {
        core: LimiterState {
            pending_down: Some(PendingDown {
                target: Medium,
                attempt: 7,
            }),
            last_down_attempt: Some(5),
            trusted_since_down: true,
            rearm_tokens_used: 2,
            last_attempt: 7,
        },
        dropped_before: true,
    }
}

#[test]
fn the_v2_state_round_trips_strictly_and_stays_small() {
    for s in [
        LimiterStateV2::new(),
        spent_state(),
        LimiterStateV2::new().continued_after_reset(Xhigh, Low),
    ] {
        assert_eq!(LimiterStateV2::from_value(&s.to_value()).unwrap(), s);
        assert!(s.to_value().to_string().len() <= LIMITER_STATE_MAX_BYTES + 24);
    }
    assert_eq!(
        spent_state().to_value().to_string(),
        r#"{"droppedBefore":true,"lastAttempt":7,"lastDownAttempt":5,"pendingDown":{"attempt":7,"target":"medium"},"rearmTokensUsed":2,"trustedSinceDown":true}"#
    );
    // a V1 state is NOT a V2 state (and the reverse): no silent reinterpretation
    assert!(LimiterStateV2::from_value(&spent_state().core.to_value()).is_err());
    assert!(LimiterState::from_value(&spent_state().to_value()).is_err());
}

#[test]
fn forged_v2_states_are_refused_by_the_decoder_the_validator_and_the_transition_check() {
    use serde_json::json;
    let good = spent_state().to_value();
    let mut forged: Vec<(&str, serde_json::Value)> = Vec::new();
    // flipped / missing / mistyped flag
    for v in [json!(0), json!("true"), json!(null)] {
        let mut x = good.clone();
        x["droppedBefore"] = v;
        forged.push(("droppedBefore type", x));
    }
    let mut x = good.clone();
    x.as_object_mut().unwrap().remove("droppedBefore");
    forged.push(("droppedBefore missing", x));
    // a drop history without the flag
    for (k, v) in [
        ("lastDownAttempt", json!(5)),
        ("trustedSinceDown", json!(true)),
        ("rearmTokensUsed", json!(1)),
    ] {
        let mut x = LimiterStateV2::new().to_value();
        x[k] = v;
        forged.push(("history without droppedBefore", x));
    }
    for (why, v) in forged {
        assert!(LimiterStateV2::from_value(&v).is_err(), "{why}: {v}");
    }
    // the validator (host context) agrees for states built in memory
    let b = StateBounds {
        current: Xhigh,
        authorized: &AUTH,
        max_attempt: None,
    };
    for bad in [
        LimiterStateV2 {
            dropped_before: false,
            ..spent_state()
        },
        LimiterStateV2 {
            core: LimiterState {
                rearm_tokens_used: 1,
                ..LimiterState::new()
            },
            dropped_before: false,
        },
    ] {
        assert!(bad.validate(&b).is_err(), "{bad:?}");
        assert!(limit_v2(&bad, &input(8, High, Xhigh, false, 0, 0, false)).is_err());
    }
    // the transition check: the flag may only be set by a move down, never cleared, never set for free
    let prev = LimiterStateV2::new();
    let i = input(1, Xhigh, Low, true, 1, 0, false);
    let want = go(&prev, i);
    assert_eq!(
        verify_transition_v2(&prev, &i, want.action, &want.state, 1),
        Ok(LimiterRule::Up)
    );
    let set_free = LimiterStateV2 {
        dropped_before: true,
        ..want.state
    };
    assert!(
        verify_transition_v2(&prev, &i, want.action, &set_free, 1).is_err(),
        "set without a drop"
    );
    let after_drop = LimiterStateV2 {
        dropped_before: true,
        core: LimiterState {
            last_down_attempt: Some(3),
            last_attempt: 3,
            ..LimiterState::new()
        },
    };
    let j = input(4, Xhigh, Low, true, 1, 0, false);
    let w = go(&after_drop, j);
    let cleared = LimiterStateV2 {
        dropped_before: false,
        ..w.state
    };
    assert!(
        verify_transition_v2(&after_drop, &j, w.action, &cleared, 4).is_err(),
        "cleared"
    );
    let refilled = LimiterStateV2 {
        core: LimiterState {
            rearm_tokens_used: 0,
            ..w.state.core
        },
        ..w.state
    };
    assert!(
        verify_transition_v2(&after_drop, &j, w.action, &refilled, 4).is_err(),
        "token refunded"
    );
    // a state ahead of the host's counter
    assert!(verify_transition_v2(&prev, &i, want.action, &want.state, 0).is_err());
}

#[test]
fn the_policy_versions_are_distinct_and_pinned() {
    assert_eq!(LIMITER_POLICY_VERSION, 1);
    assert_eq!(LIMITER_POLICY_VERSION_V2, 2);
    assert_eq!(REARM_TOKENS, 2, "R = 2 per logical task in both versions");
}
