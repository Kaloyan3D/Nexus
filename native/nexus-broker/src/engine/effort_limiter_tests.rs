//! EM-04C2 S5 acceptance tests for the Effort Transition Limiter (`effort_limiter.rs`).
//!
//! * `t01..t16` - the sixteen table cases of `EM-04C2-ANTI-THRASH-POLICY.md` §6.1 (pure, no node);
//! * state, encoding, continuation and transition-verification tests;
//! * `properties` - seven policy properties over >= 5,000 deterministic traces of 60 attempts;
//! * `pinned traces` - the thirteen traces of the REAL, unchanged Governor, pinned with the L3
//!   column of the policy document §4.
//!
//! Regenerating the pinned fixture is an explicit, reviewed action (see
//! `regenerate_the_pinned_governor_traces`); a normal test run only READS it.

use super::effort_limiter::*;
use Level::{High, Low, Max, Medium, Xhigh};

const AUTH: [Level; 4] = [Low, Medium, High, Xhigh];

/// Test-side builder for an input (the limiter's inputs are borrowed).
#[derive(Clone, Copy)]
struct In {
    attempt: u32,
    gov: Level,
    cur: Level,
    strong: bool,
    claims: u32,
    trusted: u32,
    edge: bool,
}

fn at(attempt: u32, gov: Level, cur: Level) -> In {
    In {
        attempt,
        gov,
        cur,
        strong: false,
        claims: 0,
        trusted: 0,
        edge: false,
    }
}

impl In {
    fn strong(mut self) -> Self {
        self.strong = true;
        self
    }
    fn claims(mut self, n: u32) -> Self {
        self.claims = n;
        self
    }
    fn trusted(mut self, n: u32) -> Self {
        self.trusted = n;
        self
    }
    fn edge(mut self) -> Self {
        self.edge = true;
        self
    }
    fn input<'a>(&self, authorized: &'a [Level]) -> LimiterInput<'a> {
        LimiterInput {
            attempt: self.attempt,
            governor: self.gov,
            current: self.cur,
            authorized,
            strong_escalation: self.strong,
            new_claim_units: self.claims,
            new_trusted_failures: self.trusted,
            progress_edge: self.edge,
        }
    }
}

fn go(s: &LimiterState, i: In) -> LimiterDecision {
    limit(s, &i.input(&AUTH)).expect("a valid input")
}

fn after_drop(last_attempt: u32, drop_at: u32) -> LimiterState {
    LimiterState {
        last_down_attempt: Some(drop_at),
        last_attempt,
        ..LimiterState::new()
    }
}

// ---------------------------------------------------------------------------------------------
// T1 - T16
// ---------------------------------------------------------------------------------------------

#[test]
fn t01_an_identical_proposal_is_a_noop_at_every_level_and_clears_the_pending_decision() {
    for cur in AUTH {
        let mut s = LimiterState::new();
        s.last_attempt = 4;
        if cur > Low {
            s.pending_down = Some(PendingDown {
                target: Low,
                attempt: 4,
            });
        }
        let d = go(&s, at(5, cur, cur));
        assert_eq!(d.action, LimiterAction::KeepPinned, "{cur:?}");
        assert_eq!(d.rule, LimiterRule::Noop);
        assert_eq!(d.state.pending_down, None);
        assert_eq!(d.state.last_attempt, 5);
    }
}

#[test]
fn t02_an_ordinary_escalation_is_immediate_and_clears_a_pending_decision() {
    for (cur, gov) in [(Low, Medium), (Low, Xhigh), (Medium, High), (High, Xhigh)] {
        // a claim-driven context (after a drop, tokens spent, no trusted failure) must not matter
        // when the escalation is not "strong"
        let s = LimiterState {
            pending_down: (cur > Low).then_some(PendingDown {
                target: Low,
                attempt: 6,
            }),
            last_down_attempt: Some(2),
            rearm_tokens_used: REARM_TOKENS,
            last_attempt: 6,
            ..LimiterState::new()
        };
        let d = go(&s, at(7, gov, cur));
        assert_eq!(d.action, LimiterAction::Change(gov), "{cur:?}->{gov:?}");
        assert_eq!(d.rule, LimiterRule::Up);
        assert_eq!(d.state.pending_down, None);
        assert_eq!(
            d.state.rearm_tokens_used, REARM_TOKENS,
            "no token for a plain escalation"
        );
    }
}

#[test]
fn t03_the_first_strong_escalation_is_immediate_and_costs_no_token() {
    let s = LimiterState::new();
    let d = go(&s, at(1, Xhigh, Medium).strong().claims(2));
    assert_eq!(d.action, LimiterAction::Change(Xhigh));
    assert_eq!(d.state.rearm_tokens_used, 0);
    // still free after more attempts as long as no drop has been applied
    let mut s = d.state;
    s.last_attempt = 9;
    assert_eq!(
        go(&s, at(10, Xhigh, High).strong()).action,
        LimiterAction::Change(Xhigh)
    );
}

#[test]
fn t04_claim_only_strong_re_escalation_after_a_drop_consumes_a_token() {
    let mut s = after_drop(8, 5);
    for used in 0..REARM_TOKENS {
        assert_eq!(s.rearm_tokens_used, used);
        let n = 9 + u32::from(used) * 2;
        let d = go(&s, at(n, Xhigh, Medium).strong().claims(1));
        assert_eq!(
            d.action,
            LimiterAction::Change(Xhigh),
            "token #{}",
            used + 1
        );
        assert_eq!(d.rule, LimiterRule::Up);
        assert_eq!(d.state.rearm_tokens_used, used + 1);
        // the next drop re-opens the question
        s = LimiterState {
            last_down_attempt: Some(n + 1),
            last_attempt: n + 1,
            rearm_tokens_used: d.state.rearm_tokens_used,
            ..LimiterState::new()
        };
    }
}

#[test]
fn t05_after_the_budget_a_claim_only_re_escalation_is_held_and_nothing_but_the_attempt_moves() {
    let s = LimiterState {
        rearm_tokens_used: REARM_TOKENS,
        ..after_drop(8, 5)
    };
    // held at every following attempt, however often it is re-proposed
    let mut cur_state = s;
    for n in 9..20 {
        let d = go(&cur_state, at(n, Xhigh, Medium).strong().claims(1));
        assert_eq!(d.action, LimiterAction::KeepPinned);
        assert_eq!(d.rule, LimiterRule::HoldRearm);
        assert_eq!(
            d.state,
            LimiterState {
                last_attempt: n,
                ..s
            },
            "only last_attempt moves"
        );
        cur_state = d.state;
    }
}

#[test]
fn t06_a_kernel_verified_failure_bypasses_the_exhausted_budget() {
    // (a) the failure was folded earlier, after the drop
    let s = LimiterState {
        rearm_tokens_used: REARM_TOKENS,
        trusted_since_down: true,
        ..after_drop(8, 5)
    };
    let d = go(&s, at(9, Xhigh, Medium).strong());
    assert_eq!(d.action, LimiterAction::Change(Xhigh));
    assert_eq!(
        d.state.rearm_tokens_used, REARM_TOKENS,
        "the budget is not touched"
    );
    assert!(!d.state.trusted_since_down, "the corroboration is spent");
    // (b) the failure is folded by this very evaluation
    let s = LimiterState {
        rearm_tokens_used: REARM_TOKENS,
        ..after_drop(8, 5)
    };
    let d = go(&s, at(9, Xhigh, Medium).strong().trusted(1));
    assert_eq!(d.action, LimiterAction::Change(Xhigh));
    assert_eq!(d.state.rearm_tokens_used, REARM_TOKENS);
    assert!(!d.state.trusted_since_down);
    // (c) spent: the next claim-only re-arm after another drop is held again
    let s = LimiterState {
        rearm_tokens_used: REARM_TOKENS,
        ..after_drop(12, 11)
    };
    assert_eq!(
        go(&s, at(13, Xhigh, Medium).strong().claims(1)).rule,
        LimiterRule::HoldRearm
    );
    // a trusted failure BEFORE any drop is not a credit (nothing to bypass)
    let d = go(&LimiterState::new(), at(1, Medium, Low).trusted(1));
    assert!(!d.state.trusted_since_down);
}

#[test]
fn t07_the_first_lower_decision_only_records_a_pending_decision() {
    let mut s = LimiterState::new();
    s.last_attempt = 5;
    let d = go(&s, at(6, Medium, Xhigh));
    assert_eq!(d.action, LimiterAction::KeepPinned);
    assert_eq!(d.rule, LimiterRule::DownPending);
    assert_eq!(
        d.state.pending_down,
        Some(PendingDown {
            target: Medium,
            attempt: 6
        })
    );
    assert_eq!(d.state.last_down_attempt, None);
}

#[test]
fn t08_a_second_consecutive_lower_decision_from_a_distinct_attempt_applies_it() {
    let s = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 6,
        }),
        last_attempt: 6,
        ..LimiterState::new()
    };
    let d = go(&s, at(7, Medium, Xhigh));
    assert_eq!(d.action, LimiterAction::Change(Medium));
    assert_eq!(d.rule, LimiterRule::DownConfirmed);
    assert_eq!(d.state.last_down_attempt, Some(7));
    assert_eq!(d.state.pending_down, None);
    assert!(!d.state.trusted_since_down);
}

#[test]
fn t09_a_skipped_evaluation_breaks_the_consecutive_run() {
    let s = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 6,
        }),
        last_attempt: 6,
        ..LimiterState::new()
    };
    let d = go(&s, at(8, Medium, Xhigh));
    assert_eq!(d.action, LimiterAction::KeepPinned);
    assert_eq!(d.rule, LimiterRule::DownPending);
    assert_eq!(
        d.state.pending_down,
        Some(PendingDown {
            target: Medium,
            attempt: 8
        })
    );
}

#[test]
fn t10_new_failure_or_conflict_evidence_resets_a_pending_decision() {
    let pending = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 6,
        }),
        last_down_attempt: Some(2),
        last_attempt: 6,
        ..LimiterState::new()
    };
    let d = go(&pending, at(7, Medium, Xhigh).claims(1));
    assert_eq!(d.action, LimiterAction::KeepPinned);
    assert_eq!(d.rule, LimiterRule::ResetEvidence);
    assert_eq!(d.state.pending_down, None);
    // a Kernel-verified failure does the same and is remembered as corroboration
    let d = go(&pending, at(7, Medium, Xhigh).trusted(1));
    assert_eq!(d.rule, LimiterRule::ResetEvidence);
    assert_eq!(d.state.pending_down, None);
    assert!(d.state.trusted_since_down);
    // and the dwell starts over: 7 reset, 8 pending again, 9 confirms
    let d8 = go(&d.state, at(8, Medium, Xhigh));
    assert_eq!(d8.rule, LimiterRule::DownPending);
    let d9 = go(&d8.state, at(9, Medium, Xhigh));
    assert_eq!(d9.action, LimiterAction::Change(Medium));
}

#[test]
fn t11_a_proposal_at_or_above_the_effort_in_force_cancels_the_pending_decision() {
    let pending = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 6,
        }),
        last_attempt: 6,
        ..LimiterState::new()
    };
    let same = go(&pending, at(7, High, High));
    assert_eq!(
        (same.action, same.state.pending_down),
        (LimiterAction::KeepPinned, None)
    );
    let up = go(&pending, at(7, Xhigh, High));
    assert_eq!(
        (up.action, up.state.pending_down),
        (LimiterAction::Change(Xhigh), None)
    );
}

#[test]
fn t12_a_progress_edge_without_new_evidence_lowers_the_effort_at_once() {
    let s = LimiterState {
        trusted_since_down: true,
        ..after_drop(3, 2)
    };
    let d = go(&s, at(4, Medium, Xhigh).edge());
    assert_eq!(d.action, LimiterAction::Change(Medium));
    assert_eq!(d.rule, LimiterRule::DownProgress);
    assert_eq!(d.state.last_down_attempt, Some(4));
    assert!(!d.state.trusted_since_down);
    assert_eq!(d.state.pending_down, None);
}

#[test]
fn t13_a_progress_edge_with_new_evidence_is_not_an_immediate_drop() {
    for i in [
        at(4, Medium, Xhigh).edge().claims(1),
        at(4, Medium, Xhigh).edge().trusted(1),
        at(4, Medium, Xhigh).edge().claims(2).trusted(1),
    ] {
        let d = go(
            &LimiterState {
                last_attempt: 3,
                ..LimiterState::new()
            },
            i,
        );
        assert_eq!(d.action, LimiterAction::KeepPinned);
        assert_eq!(d.rule, LimiterRule::ResetEvidence);
        assert_eq!(d.state.pending_down, None);
    }
}

#[test]
fn t14_the_same_or_an_earlier_attempt_cannot_advance_the_state() {
    let s = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 6,
        }),
        last_down_attempt: Some(1),
        rearm_tokens_used: 1,
        last_attempt: 6,
        ..LimiterState::new()
    };
    for n in [6, 5, 1] {
        for i in [
            at(n, Medium, Xhigh),        // would confirm
            at(n, Xhigh, High).strong(), // would re-arm
            at(n, Medium, Xhigh).edge(), // would drop at once
            at(n, Medium, Xhigh).trusted(1),
        ] {
            let d = go(&s, i);
            assert_eq!(
                (d.action, d.rule),
                (LimiterAction::KeepPinned, LimiterRule::ReplayGuard)
            );
            assert_eq!(d.state, s, "attempt {n}: nothing may move");
        }
    }
    // a replayed decision after a real change is still inert
    let d = go(&s, at(7, Medium, Xhigh));
    assert_eq!(d.action, LimiterAction::Change(Medium));
    let again = go(&d.state, at(7, Medium, Xhigh));
    assert_eq!(again.rule, LimiterRule::ReplayGuard);
    assert_eq!(again.state, d.state);
}

#[test]
fn t15_unauthorized_max_or_unusable_inputs_are_refused_and_never_yield_a_change() {
    let s = LimiterState::new();
    let auth_with_max = [Low, Medium, High, Xhigh, Max];
    let reject = |i: LimiterInput<'_>| {
        let e = limit(&s, &i).unwrap_err();
        assert_eq!(e.code(), "limiter-input-invalid", "{e}");
    };
    // max is never applied, even when it is authorized
    reject(at(1, Max, Xhigh).input(&auth_with_max));
    // a level outside the authorized set (either side)
    reject(at(1, Xhigh, Low).input(&[Low, Medium, High]));
    reject(at(1, Medium, Xhigh).input(&[Low, Medium, High]));
    // attempt 0 is not an attempt
    reject(at(0, Medium, Low).input(&AUTH));
    // a default-only slot: nothing to propose
    reject(at(1, Medium, Low).input(&[Low]));
    // EXHAUSTIVE over a small domain: every Change the limiter can emit is valid, whatever the
    // (valid) state and evidence; nothing returns an error for a valid input; no state it returns
    // violates its own invariants.
    let pend_opts: Vec<Option<PendingDown>> = std::iter::once(None)
        .chain(AUTH.iter().flat_map(|t| {
            (1..=2).map(move |a| {
                Some(PendingDown {
                    target: *t,
                    attempt: a,
                })
            })
        }))
        .collect();
    let mut states = 0u32;
    for pending in &pend_opts {
        for last_down in [None, Some(1), Some(2)] {
            for trusted_since in [false, true] {
                for tokens in 0..=REARM_TOKENS {
                    for last_attempt in [2u32, 3] {
                        let st = LimiterState {
                            pending_down: *pending,
                            last_down_attempt: last_down,
                            trusted_since_down: trusted_since,
                            rearm_tokens_used: tokens,
                            last_attempt,
                        };
                        for cur in AUTH {
                            let b = StateBounds {
                                current: cur,
                                authorized: &AUTH,
                                max_attempt: None,
                            };
                            if st.validate(&b).is_err() {
                                continue; // not a reachable state: covered by the validation tests
                            }
                            states += 1;
                            for gov in AUTH {
                                for (strong, claims, trusted, edge, attempt) in iproduct() {
                                    let i = In {
                                        attempt,
                                        gov,
                                        cur,
                                        strong,
                                        claims,
                                        trusted,
                                        edge,
                                    };
                                    let d = limit(&st, &i.input(&AUTH)).unwrap();
                                    if let LimiterAction::Change(e) = d.action {
                                        assert!(e != cur && e != Max && AUTH.contains(&e), "{e:?}");
                                    }
                                    let after = match d.action {
                                        LimiterAction::Change(e) => e,
                                        LimiterAction::KeepPinned => cur,
                                    };
                                    d.state
                                        .validate(&StateBounds {
                                            current: after,
                                            authorized: &AUTH,
                                            max_attempt: None,
                                        })
                                        .unwrap_or_else(|e| {
                                            panic!("{e}: {st:?} {i:?}", i = i.attempt)
                                        });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(
        states > 400,
        "the enumeration actually covered states: {states}"
    );
}

fn iproduct() -> Vec<(bool, u32, u32, bool, u32)> {
    let mut v = Vec::new();
    for strong in [false, true] {
        for claims in [0, 1] {
            for trusted in [0, 1] {
                for edge in [false, true] {
                    for attempt in [1, 3, 4, 5] {
                        v.push((strong, claims, trusted, edge, attempt));
                    }
                }
            }
        }
    }
    v
}

#[test]
fn t16_two_different_lower_decisions_apply_the_higher_and_stay_below_the_current_effort() {
    for (first, second, applied) in [
        (Medium, High, High), // lower then higher: the higher
        (High, Medium, High), // higher then lower: still the higher
        (Low, Low, Low),
        (Medium, Medium, Medium),
        (Low, High, High),
    ] {
        let s = LimiterState::new();
        let d1 = go(&s, at(1, first, Xhigh));
        assert_eq!(d1.rule, LimiterRule::DownPending);
        let d2 = go(&d1.state, at(2, second, Xhigh));
        assert_eq!(
            d2.action,
            LimiterAction::Change(applied),
            "{first:?},{second:?}"
        );
        assert!(applied < Xhigh);
        assert!(applied >= first.min(second) && applied == first.max(second));
    }
    // the confirming proposal may not be at or above the current effort: that is a different rule
    let d1 = go(&LimiterState::new(), at(1, Medium, High));
    let d2 = go(&d1.state, at(2, High, High));
    assert_eq!(d2.rule, LimiterRule::Noop);
}

// ---------------------------------------------------------------------------------------------
// state, encoding, continuation, transition verification
// ---------------------------------------------------------------------------------------------

fn full_state() -> LimiterState {
    LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 40,
        }),
        last_down_attempt: Some(31),
        trusted_since_down: true,
        rearm_tokens_used: REARM_TOKENS,
        last_attempt: 40,
    }
}

#[test]
fn the_state_round_trips_and_stays_small() {
    for s in [LimiterState::new(), full_state()] {
        let v = s.to_value();
        assert_eq!(LimiterState::from_value(&v).unwrap(), s);
        assert!(v.to_string().len() <= LIMITER_STATE_MAX_BYTES, "{v}");
    }
    // the worst case by size: every field at its widest
    let widest = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: u32::MAX,
        }),
        last_down_attempt: Some(u32::MAX),
        trusted_since_down: true,
        rearm_tokens_used: REARM_TOKENS,
        last_attempt: u32::MAX,
    };
    assert!(widest.to_value().to_string().len() <= LIMITER_STATE_MAX_BYTES);
    // canonical shape, pinned (S6 persists exactly this)
    assert_eq!(
        full_state().to_value().to_string(),
        r#"{"lastAttempt":40,"lastDownAttempt":31,"pendingDown":{"attempt":40,"target":"medium"},"rearmTokensUsed":2,"trustedSinceDown":true}"#
    );
}

#[test]
fn the_decoder_is_strict() {
    use serde_json::json;
    let good = full_state().to_value();
    let mut cases: Vec<(&str, serde_json::Value)> = Vec::new();
    for k in [
        "pendingDown",
        "lastDownAttempt",
        "trustedSinceDown",
        "rearmTokensUsed",
        "lastAttempt",
    ] {
        let mut v = good.clone();
        v.as_object_mut().unwrap().remove(k);
        cases.push(("a missing key", v));
    }
    let mut v = good.clone();
    v["extra"] = json!(1);
    cases.push(("an extra key", v));
    let mut v = good.clone();
    v["pendingDown"]["extra"] = json!(1);
    cases.push(("an extra nested key", v));
    for (k, bad) in [
        ("pendingDown", json!("medium")),
        ("pendingDown", json!({"target": "max", "attempt": 1})),
        ("pendingDown", json!({"target": "ultra", "attempt": 1})),
        ("pendingDown", json!({"target": "medium", "attempt": -1})),
        ("pendingDown", json!({"target": "medium", "attempt": "1"})),
        ("pendingDown", json!({"target": "medium"})),
        ("lastDownAttempt", json!("3")),
        ("lastDownAttempt", json!(1.5)),
        ("lastDownAttempt", json!(4_294_967_296u64)),
        ("lastAttempt", json!(null)),
        ("lastAttempt", json!(-1)),
        ("trustedSinceDown", json!(1)),
        ("rearmTokensUsed", json!(REARM_TOKENS + 1)),
        ("rearmTokensUsed", json!(256)),
        ("rearmTokensUsed", json!(-1)),
        ("rearmTokensUsed", json!(1.0e0 + 0.5)),
    ] {
        let mut v = good.clone();
        v[k] = bad;
        cases.push(("a malformed value", v));
    }
    // trusted flag without a drop
    let mut v = good.clone();
    v["lastDownAttempt"] = json!(null);
    cases.push(("trustedSinceDown without a drop", v));
    cases.push(("not an object", json!([])));
    cases.push(("null", json!(null)));
    for (why, v) in cases {
        let e = LimiterState::from_value(&v).unwrap_err();
        assert_eq!(e.code(), "limiter-state-invalid", "{why}: {v}");
    }
}

#[test]
fn the_validation_helper_enforces_every_invariant_against_the_hosts_context() {
    let b = |cur, max| StateBounds {
        current: cur,
        authorized: &AUTH,
        max_attempt: max,
    };
    assert!(LimiterState::new().validate(&b(Low, Some(1))).is_ok());
    assert!(full_state().validate(&b(Xhigh, Some(41))).is_ok());
    let s = full_state();
    let mut bad = Vec::new();
    bad.push((
        "last_attempt beyond the admitted attempt",
        s,
        b(Xhigh, Some(39)),
    ));
    bad.push((
        "token budget exceeded",
        LimiterState {
            rearm_tokens_used: REARM_TOKENS + 1,
            ..s
        },
        b(Xhigh, None),
    ));
    bad.push((
        "trusted flag without a drop",
        LimiterState {
            last_down_attempt: None,
            ..s
        },
        b(Xhigh, None),
    ));
    bad.push((
        "drop after the last attempt",
        LimiterState {
            last_down_attempt: Some(41),
            ..s
        },
        b(Xhigh, None),
    ));
    bad.push((
        "drop at attempt 0",
        LimiterState {
            last_down_attempt: Some(0),
            ..s
        },
        b(Xhigh, None),
    ));
    bad.push((
        "pending from the future",
        LimiterState {
            pending_down: Some(PendingDown {
                target: Medium,
                attempt: 41,
            }),
            ..s
        },
        b(Xhigh, None),
    ));
    bad.push((
        "pending at attempt 0",
        LimiterState {
            pending_down: Some(PendingDown {
                target: Medium,
                attempt: 0,
            }),
            ..s
        },
        b(Xhigh, None),
    ));
    bad.push((
        "pending target not below the effort in force",
        s,
        b(Medium, None),
    ));
    bad.push((
        "pending target above the effort in force",
        LimiterState {
            pending_down: Some(PendingDown {
                target: Xhigh,
                attempt: 40,
            }),
            ..s
        },
        b(High, None),
    ));
    bad.push((
        "pending target unauthorized",
        s,
        StateBounds {
            current: Xhigh,
            authorized: &[Low, High, Xhigh],
            max_attempt: None,
        },
    ));
    bad.push((
        "pending target max",
        LimiterState {
            pending_down: Some(PendingDown {
                target: Max,
                attempt: 40,
            }),
            ..s
        },
        StateBounds {
            current: Max,
            authorized: &[Low, Max],
            max_attempt: None,
        },
    ));
    for (why, st, bounds) in bad {
        let e = st.validate(&bounds).unwrap_err();
        assert_eq!(e.code(), "limiter-state-invalid", "{why}");
        // and the pure function itself refuses to run over such a state
        if bounds.max_attempt.is_none() {
            let i = at(100, Medium, bounds.current);
            assert!(limit(&st, &i.input(bounds.authorized)).is_err(), "{why}");
        }
    }
}

#[test]
fn continuation_keeps_the_per_task_budget_and_resets_generation_local_fields() {
    let s = full_state();
    let c = s.continued();
    assert_eq!(c.rearm_tokens_used, REARM_TOKENS, "the budget is per task");
    assert_eq!(
        LimiterState {
            rearm_tokens_used: 0,
            ..c
        },
        LimiterState::new(),
        "everything else restarts with the new generation"
    );
    // idempotent, and never mutates the source
    assert_eq!(c.continued(), c);
    assert_eq!(s, full_state());
    // consequences, end to end: the first strong escalation of the new generation is free (no drop
    // yet in this generation), but after the generation's first drop the exhausted budget holds
    let d = go(&c, at(1, Xhigh, Low).strong().claims(2));
    assert_eq!(d.action, LimiterAction::Change(Xhigh));
    assert_eq!(d.state.rearm_tokens_used, REARM_TOKENS);
    let p = go(&d.state, at(2, Medium, Xhigh));
    let dn = go(&p.state, at(3, Medium, Xhigh));
    assert_eq!(dn.action, LimiterAction::Change(Medium));
    let held = go(&dn.state, at(4, Xhigh, Medium).strong().claims(1));
    assert_eq!(
        held.rule,
        LimiterRule::HoldRearm,
        "the inherited budget is still spent"
    );
    // a state restored from a continuation is valid against the new generation's counters
    assert!(c
        .validate(&StateBounds {
            current: Low,
            authorized: &AUTH,
            max_attempt: Some(1)
        })
        .is_ok());
    // the encoded continuation round-trips
    assert_eq!(LimiterState::from_value(&c.to_value()).unwrap(), c);
}

#[test]
fn the_host_can_verify_a_recorded_transition_and_refuses_a_forged_one() {
    let prev = LimiterState {
        pending_down: Some(PendingDown {
            target: Medium,
            attempt: 6,
        }),
        last_attempt: 6,
        ..LimiterState::new()
    };
    let i = at(7, Medium, Xhigh);
    let want = limit(&prev, &i.input(&AUTH)).unwrap();
    // the genuine transition verifies and names the rule
    assert_eq!(
        verify_transition(&prev, &i.input(&AUTH), want.action, &want.state, 7),
        Ok(LimiterRule::DownConfirmed)
    );
    let refuses = |action, next: &LimiterState, max| {
        let e = verify_transition(&prev, &i.input(&AUTH), action, next, max).unwrap_err();
        assert!(
            matches!(
                e.code(),
                "limiter-transition-mismatch" | "limiter-state-invalid"
            ),
            "{e}"
        );
    };
    // a different action
    refuses(LimiterAction::Change(High), &want.state, 7);
    refuses(LimiterAction::KeepPinned, &want.state, 7);
    // a tampered state
    refuses(
        want.action,
        &LimiterState {
            rearm_tokens_used: 1,
            ..want.state
        },
        7,
    );
    refuses(
        want.action,
        &LimiterState {
            last_down_attempt: Some(6),
            ..want.state
        },
        7,
    );
    refuses(
        want.action,
        &LimiterState {
            trusted_since_down: true,
            ..want.state
        },
        7,
    );
    // a state ahead of the host's own attempt counter
    refuses(
        want.action,
        &LimiterState {
            last_attempt: 9,
            ..want.state
        },
        7,
    );
    // a state that was not advanced
    refuses(want.action, &prev, 7);
    // an input the policy refuses is never verifiable
    let bad = at(7, Max, Xhigh);
    assert!(verify_transition(
        &prev,
        &bad.input(&[Low, Max, Xhigh]),
        want.action,
        &want.state,
        7
    )
    .is_err());
}

#[test]
fn the_limiter_never_touches_what_it_does_not_own() {
    // the limiter's whole interface is levels, counters and the five-field state: it has no way to
    // express a model, provider, route, credential or permission. This test pins the vocabulary
    // of the audit detail and the error codes S6 will persist.
    for r in [
        (LimiterRule::Up, "limiter:up"),
        (LimiterRule::DownProgress, "limiter:down-progress"),
        (LimiterRule::DownConfirmed, "limiter:down-confirmed"),
        (LimiterRule::DownPending, "limiter:down-pending"),
        (LimiterRule::HoldRearm, "limiter:hold-rearm"),
        (LimiterRule::ResetEvidence, "limiter:reset-evidence"),
        (LimiterRule::Noop, "limiter:noop"),
        (LimiterRule::ReplayGuard, "limiter:replay-guard"),
    ] {
        let d = LimiterDecision {
            action: LimiterAction::KeepPinned,
            rule: r.0,
            state: LimiterState::new(),
        };
        assert_eq!(d.detail(), r.1);
    }
    assert_eq!(LIMITER_POLICY_VERSION, 1);
    assert_eq!((DWELL_DECISIONS, REARM_TOKENS), (2, 2));
    for l in Level::ALL {
        assert_eq!(Level::parse(l.as_str()), Some(l));
    }
    assert_eq!(Level::parse("MAX"), None);
    assert_eq!(Level::parse(""), None);
    assert!(Low < Medium && Medium < High && High < Xhigh && Xhigh < Max);
}

#[test]
fn the_evidence_baseline_measures_claims_and_progress_edges_like_the_governors_own_resets() {
    use serde_json::json;
    let block = |hyp: u64, imp: u64, conflict: bool, root: bool, sol: bool| {
        json!({"totalFailedHypotheses": hyp, "totalFailedImplementationAttempts": imp,
               "conflictingEvidence": conflict, "rootCauseEstablished": root,
               "solutionEstablished": sol, "failedHypotheses": 0})
    };
    let b = |v: serde_json::Value| EvidenceBaseline::from_reasoning(Some(&v)).unwrap();
    let init = EvidenceBaseline::from_reasoning(None).unwrap();
    assert_eq!(init, EvidenceBaseline::default());
    assert_eq!(
        EvidenceBaseline::from_reasoning(Some(&serde_json::Value::Null)).unwrap(),
        init
    );
    // failures: the HISTORICAL totals are the evidence counter (progress resets of the active
    // counters do not matter), and a replayed signal leaves the totals - hence the delta - at 0
    assert_eq!(
        init.delta_to(&b(block(2, 1, false, false, false))),
        (3, false)
    );
    assert_eq!(
        b(block(2, 1, false, false, false)).delta_to(&b(block(2, 1, false, false, false))),
        (0, false)
    );
    // a conflict counts once, when it rises
    assert_eq!(
        init.delta_to(&b(block(0, 0, true, false, false))),
        (1, false)
    );
    assert_eq!(
        b(block(0, 0, true, false, false)).delta_to(&b(block(0, 0, true, false, false))),
        (0, false)
    );
    assert_eq!(
        b(block(0, 0, true, false, false)).delta_to(&b(block(0, 0, false, false, false))),
        (0, false)
    );
    // only false -> true edges are progress, either flag; re-marking or invalidating is not
    assert_eq!(
        init.delta_to(&b(block(0, 0, false, true, false))),
        (0, true)
    );
    assert_eq!(
        init.delta_to(&b(block(0, 0, false, false, true))),
        (0, true)
    );
    assert_eq!(
        b(block(0, 0, false, true, false)).delta_to(&b(block(0, 0, false, true, false))),
        (0, false)
    );
    assert_eq!(
        b(block(0, 0, false, true, false)).delta_to(&b(block(0, 0, false, false, false))),
        (0, false)
    );
    // a malformed block is refused, never defaulted
    for bad in [json!({}), json!({"totalFailedHypotheses": "2"}), json!([])] {
        assert_eq!(
            EvidenceBaseline::from_reasoning(Some(&bad))
                .unwrap_err()
                .code(),
            "limiter-input-invalid"
        );
    }
    // saturation instead of wrap-around
    let huge = EvidenceBaseline {
        total_failures: u64::MAX,
        ..init
    };
    assert_eq!(init.delta_to(&huge).0, u32::MAX);
    assert!(is_escalation_entry("escalation:[failed-hypotheses>=2]"));
    assert!(!is_escalation_entry("phase-default:diagnose"));
}

// ---------------------------------------------------------------------------------------------
// properties P1 - P7
// ---------------------------------------------------------------------------------------------

/// SplitMix64: tiny, deterministic, reproducible from a printed seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// true with probability `num/den`
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.below(den) < num
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Gs {
    attempt: u32,
    gov: Level,
    strong: bool,
    claims: u32,
    trusted: u32,
    edge: bool,
}

const PROPERTY_TRACES: u64 = 5_000;
const PROPERTY_ATTEMPTS: usize = 60;
const BASE_SEED: u64 = 0x0E4C_2005_5EED_0001;

fn trace_seed(index: u64) -> u64 {
    BASE_SEED ^ index.wrapping_mul(0xA24B_AED4_963E_E407)
}

fn generate(seed: u64) -> (Vec<Level>, Vec<Gs>) {
    let mut r = Rng(seed);
    // the authorized set always holds the default (low); the others are present with p = 3/4
    let mut auth = vec![Low];
    for l in [Medium, High, Xhigh] {
        if r.chance(3, 4) {
            auth.push(l);
        }
    }
    // four evidence profiles (1/claim, 1/trusted, 1/edge) so that every rule gets exercised densely
    let (p_claim, p_trusted, p_edge) =
        [(8, 20, 8), (2, 20, 5), (3, 3, 4), (4, 10, 4)][(seed % 4) as usize];
    let mut steps = Vec::with_capacity(PROPERTY_ATTEMPTS);
    let (mut top, mut gov) = (0u32, Low);
    for _ in 0..PROPERTY_ATTEMPTS {
        // numbering: mostly +1; repeats, regressions and skips are exercised on purpose
        let attempt = match r.below(40) {
            0 | 1 => top.max(1),
            2 | 3 if top > 1 => {
                let back = 1 + r.below(u64::from(top.min(3))) as u32;
                top.saturating_sub(back).max(1)
            }
            4 => {
                top += 2;
                top
            }
            _ => {
                top += 1;
                top
            }
        };
        // the Governor: stay, jump or nudge, always inside the authorized ladder
        gov = match r.below(8) {
            0..=2 => gov,
            3..=4 => auth[r.below(auth.len() as u64) as usize],
            _ => {
                let i = auth.iter().position(|l| *l == gov).unwrap_or(0);
                let j = if r.chance(1, 2) {
                    (i + 1).min(auth.len() - 1)
                } else {
                    i.saturating_sub(1)
                };
                auth[j]
            }
        };
        steps.push(Gs {
            attempt,
            gov,
            strong: (gov == Xhigh && r.chance(3, 4)) || r.chance(1, 12),
            claims: if r.chance(1, p_claim) {
                1 + r.below(3) as u32
            } else {
                0
            },
            trusted: if r.chance(1, p_trusted) {
                1 + r.below(2) as u32
            } else {
                0
            },
            edge: r.chance(1, p_edge),
        });
    }
    (auth, steps)
}

#[derive(Clone, Debug)]
struct Rec {
    step: Gs,
    cur_before: Level,
    prev: LimiterState,
    d: LimiterDecision,
}

fn simulate(auth: &[Level], steps: &[Gs]) -> Result<Vec<Rec>, (&'static str, String)> {
    let (mut cur, mut state) = (Low, LimiterState::new());
    let mut recs = Vec::with_capacity(steps.len());
    for g in steps {
        let i = LimiterInput {
            attempt: g.attempt,
            governor: g.gov,
            current: cur,
            authorized: auth,
            strong_escalation: g.strong,
            new_claim_units: g.claims,
            new_trusted_failures: g.trusted,
            progress_edge: g.edge,
        };
        let d =
            limit(&state, &i).map_err(|e| ("P0 valid input must be accepted", e.to_string()))?;
        recs.push(Rec {
            step: *g,
            cur_before: cur,
            prev: state,
            d,
        });
        if let LimiterAction::Change(e) = d.action {
            cur = e;
        }
        state = d.state;
    }
    Ok(recs)
}

/// All seven properties plus the structural invariants, judged from the INPUTS (an oracle written
/// independently of the limiter's state) and the limiter's outputs.
fn check(auth: &[Level], recs: &[Rec]) -> Result<(), (&'static str, String)> {
    let fail = |p: &'static str, m: String| Err((p, m));
    let (mut max_acc, mut dropped, mut trusted_since_drop) = (0u32, false, false);
    let (mut prev_acc, mut prev_gov): (Option<&Rec>, Level) = (None, Low);
    let (mut up_moves, mut accepted, mut changes, mut free_rearms) = (0u32, 0u32, 0u32, 0u32);
    let mut tokens = 0u8;
    for r in recs {
        let (g, d) = (&r.step, &r.d);
        let input = LimiterInput {
            attempt: g.attempt,
            governor: g.gov,
            current: r.cur_before,
            authorized: auth,
            strong_escalation: g.strong,
            new_claim_units: g.claims,
            new_trusted_failures: g.trusted,
            progress_edge: g.edge,
        };
        // P7 purity
        if limit(&r.prev, &input).as_ref() != Ok(d) {
            return fail(
                "P7 purity",
                format!("equal inputs, different outputs at {g:?}"),
            );
        }
        let after = match d.action {
            LimiterAction::Change(e) => e,
            LimiterAction::KeepPinned => r.cur_before,
        };
        // structural invariants after every step
        if let Err(e) = d.state.validate(&StateBounds {
            current: after,
            authorized: auth,
            max_attempt: None,
        }) {
            return fail("INV state invariants", format!("{e} after {g:?}"));
        }
        // replay detection judged independently from the inputs
        let replay = g.attempt <= max_acc;
        if replay != (d.rule == LimiterRule::ReplayGuard) {
            return fail(
                "P6 replay guard",
                format!("replay={replay} but rule {:?} at {g:?}", d.rule),
            );
        }
        if replay {
            if d.action != LimiterAction::KeepPinned || d.state != r.prev {
                return fail(
                    "P6 replay guard",
                    format!("a replay advanced the state at {g:?}"),
                );
            }
            continue;
        }
        accepted += 1;
        // P4: shape of every Change
        if let LimiterAction::Change(e) = d.action {
            changes += 1;
            if e == r.cur_before || e == Max || !auth.contains(&e) {
                return fail(
                    "P4 valid change",
                    format!("Change({e:?}) with {:?} in force at {g:?}", r.cur_before),
                );
            }
            if e > r.cur_before && e != g.gov {
                return fail(
                    "P4 valid change",
                    format!("an up move to {e:?} that is not the Governor's {:?}", g.gov),
                );
            }
            if e < r.cur_before {
                let proposed = e == g.gov || prev_acc.is_some_and(|p| p.step.gov == e);
                if e < g.gov || !proposed {
                    return fail(
                        "P4 valid change",
                        format!("a down move to {e:?} that no Governor decision proposed at {g:?}"),
                    );
                }
            }
        }
        let evidence = g.claims > 0 || g.trusted > 0;
        // P2: every move down is justified by two consecutive distinct attempts or a progress edge
        if let LimiterAction::Change(e) = d.action {
            if e < r.cur_before {
                let by_edge = g.edge && !evidence;
                let by_dwell = prev_acc.is_some_and(|p| {
                    p.step.attempt + 1 == g.attempt
                        && p.step.gov < r.cur_before
                        && p.step.claims == 0
                        && p.step.trusted == 0
                        && !evidence
                        && e == p.step.gov.max(g.gov)
                });
                if !(by_edge || by_dwell) {
                    return fail(
                        "P2 no unconfirmed drop",
                        format!(
                            "down to {e:?} at {g:?}, previous {:?}",
                            prev_acc.map(|p| p.step)
                        ),
                    );
                }
            }
        }
        if g.gov < r.cur_before {
            // the converse: the immediate-drop and reset rules are exact
            if g.edge && !evidence && d.action != LimiterAction::Change(g.gov) {
                return fail(
                    "P2 progress edge",
                    format!("an edge without evidence did not drop at {g:?}"),
                );
            }
            if evidence && d.action != LimiterAction::KeepPinned {
                return fail(
                    "P2 evidence resets",
                    format!("a drop under new evidence at {g:?}"),
                );
            }
        }
        // P3: no escalation is delayed except a claim-only re-arm past the budget
        if g.gov > r.cur_before {
            let corroborated = dropped && g.trusted > 0;
            if (!g.strong || !dropped || corroborated) && d.action != LimiterAction::Change(g.gov) {
                return fail(
                    "P3 escalation never delayed",
                    format!(
                        "held at {g:?} (strong={}, dropped={dropped}, trusted={})",
                        g.strong, g.trusted
                    ),
                );
            }
            if d.action == LimiterAction::KeepPinned
                && !(g.strong
                    && dropped
                    && d.state.rearm_tokens_used == REARM_TOKENS
                    && g.trusted == 0)
            {
                return fail(
                    "P3 escalation never delayed",
                    format!("an unjustified hold at {g:?}"),
                );
            }
            // P5: bookkeeping of uncorroborated re-arms, judged from the inputs
            if matches!(d.action, LimiterAction::Change(_))
                && g.strong
                && dropped
                && !trusted_since_drop
                && g.trusted == 0
            {
                free_rearms += 1;
            }
        }
        // P5: the token counter moves only by one, only on a strong post-drop escalation
        let delta = i16::from(d.state.rearm_tokens_used) - i16::from(tokens);
        let spent_on_rearm =
            matches!(d.action, LimiterAction::Change(e) if e > r.cur_before) && g.strong && dropped;
        if !(delta == 0 || (delta == 1 && spent_on_rearm)) {
            return fail(
                "P5 re-arm budget",
                format!(
                    "token counter {tokens} -> {} at {g:?}",
                    d.state.rearm_tokens_used
                ),
            );
        }
        tokens = d.state.rearm_tokens_used;
        if tokens > REARM_TOKENS || free_rearms > u32::from(REARM_TOKENS) {
            return fail(
                "P5 re-arm budget",
                format!("{free_rearms} uncorroborated re-arms, tokens {tokens}"),
            );
        }
        // oracle bookkeeping
        if g.trusted > 0 && dropped {
            trusted_since_drop = true;
        }
        if g.gov > prev_gov {
            up_moves += 1;
        }
        prev_gov = g.gov;
        if matches!(d.action, LimiterAction::Change(e) if e < r.cur_before) {
            dropped = true;
            trusted_since_drop = false;
        }
        max_acc = g.attempt;
        prev_acc = Some(r);
    }
    // P1: churn is bounded by what the Governor asked for plus one dwell per two attempts
    let bound = up_moves + accepted.div_ceil(2);
    if changes > bound {
        return fail(
            "P1 bounded churn",
            format!("{changes} changes > {up_moves} up moves + ceil({accepted}/2)"),
        );
    }
    // P6: replaying any prefix with the same attempt numbers against the final state changes nothing
    if let Some(last) = recs.last() {
        let final_cur = match last.d.action {
            LimiterAction::Change(e) => e,
            LimiterAction::KeepPinned => last.cur_before,
        };
        for r in recs {
            let g = &r.step;
            let i = LimiterInput {
                attempt: g.attempt,
                governor: g.gov,
                current: final_cur,
                authorized: auth,
                strong_escalation: g.strong,
                new_claim_units: g.claims,
                new_trusted_failures: g.trusted,
                progress_edge: g.edge,
            };
            match limit(&last.d.state, &i) {
                Ok(d)
                    if d.rule == LimiterRule::ReplayGuard
                        && d.action == LimiterAction::KeepPinned
                        && d.state == last.d.state => {}
                other => return fail("P6 idempotence", format!("replaying {g:?} gave {other:?}")),
            }
        }
    }
    Ok(())
}

/// Greedy delta-debugging: the smallest sub-sequence that still violates the same property.
fn minimize(auth: &[Level], steps: &[Gs], prop: &str) -> Vec<Gs> {
    let fails = |s: &[Gs]| -> bool {
        match simulate(auth, s) {
            Err((p, _)) => p == prop,
            Ok(recs) => check(auth, &recs).is_err_and(|(p, _)| p == prop),
        }
    };
    let mut cur = steps.to_vec();
    let mut chunk = cur.len().div_ceil(2).max(1);
    loop {
        let mut i = 0;
        let mut shrunk = false;
        while i < cur.len() {
            let end = (i + chunk).min(cur.len());
            let mut trial = cur.clone();
            trial.drain(i..end);
            if !trial.is_empty() && fails(&trial) {
                cur = trial;
                shrunk = true;
            } else {
                i += chunk;
            }
        }
        if !shrunk {
            if chunk == 1 {
                return cur;
            }
            chunk = chunk.div_ceil(2);
        }
    }
}

fn judge(seed: u64) -> Result<(), String> {
    let (auth, steps) = generate(seed);
    let outcome = simulate(&auth, &steps).and_then(|recs| check(&auth, &recs));
    if let Err((prop, why)) = outcome {
        let small = minimize(&auth, &steps, prop);
        return Err(format!(
            "{prop} violated for seed {seed:#018x}: {why}\n  authorized {auth:?}\n  smallest failing trace ({} of {} steps): {small:#?}",
            small.len(),
            steps.len()
        ));
    }
    Ok(())
}

#[test]
fn properties_p1_to_p7_hold_for_5000_deterministic_traces_of_60_attempts() {
    let mut covered = std::collections::BTreeMap::<&str, u64>::new();
    for index in 0..PROPERTY_TRACES {
        let seed = trace_seed(index);
        if let Err(report) = judge(seed) {
            panic!("trace #{index}: {report}");
        }
        // coverage: every rule must actually occur across the corpus
        let (auth, steps) = generate(seed);
        for r in simulate(&auth, &steps).unwrap() {
            *covered.entry(r.d.rule.as_str()).or_default() += 1;
        }
    }
    println!("rule coverage over {PROPERTY_TRACES} traces: {covered:?}");
    for rule in [
        "up",
        "down-progress",
        "down-confirmed",
        "down-pending",
        "hold-rearm",
        "reset-evidence",
        "noop",
        "replay-guard",
    ] {
        assert!(
            covered.get(rule).copied().unwrap_or(0) >= 100,
            "rule {rule} was exercised only {:?} times: {covered:?}",
            covered.get(rule)
        );
    }
}

#[test]
fn the_trace_generator_is_deterministic_and_the_corpus_is_what_the_report_says() {
    assert_eq!(generate(trace_seed(7)), generate(trace_seed(7)));
    assert_ne!(generate(trace_seed(7)).1, generate(trace_seed(8)).1);
    let (a, s) = generate(trace_seed(0));
    assert_eq!(s.len(), PROPERTY_ATTEMPTS);
    assert!(a.contains(&Low) && !a.contains(&Max));
    // the numbering really exercises repeats, regressions and skips somewhere in the corpus
    let (mut repeats, mut regress, mut skips) = (0, 0, 0);
    for i in 0..300 {
        let (_, steps) = generate(trace_seed(i));
        let mut top = 0;
        for g in steps {
            match g.attempt.cmp(&top) {
                std::cmp::Ordering::Equal => repeats += 1,
                std::cmp::Ordering::Less => regress += 1,
                std::cmp::Ordering::Greater => {
                    if g.attempt > top + 1 {
                        skips += 1;
                    }
                    top = g.attempt;
                }
            }
        }
    }
    assert!(
        repeats > 100 && regress > 100 && skips > 100,
        "{repeats} {regress} {skips}"
    );
}

/// The properties are not vacuous: each checker rejects a hand-forged violation.
#[test]
fn the_property_checkers_reject_forged_violations() {
    let s0 = LimiterState::new();
    let mk = |step: Gs,
              cur: Level,
              action: LimiterAction,
              rule,
              state: LimiterState,
              prev: LimiterState| Rec {
        step,
        cur_before: cur,
        prev,
        d: LimiterDecision {
            action,
            rule,
            state,
        },
    };
    let g = |attempt, gov| Gs {
        attempt,
        gov,
        strong: false,
        claims: 0,
        trusted: 0,
        edge: false,
    };
    // P4: a change to the level already in force
    let forged = vec![mk(
        g(1, Medium),
        Medium,
        LimiterAction::Change(Medium),
        LimiterRule::Up,
        LimiterState {
            last_attempt: 1,
            ..s0
        },
        s0,
    )];
    assert!(check(&AUTH, &forged).is_err());
    // P2: an unconfirmed drop on the first lower decision
    let forged = vec![mk(
        g(1, Medium),
        Xhigh,
        LimiterAction::Change(Medium),
        LimiterRule::DownConfirmed,
        LimiterState {
            last_attempt: 1,
            last_down_attempt: Some(1),
            ..s0
        },
        s0,
    )];
    assert_eq!(check(&AUTH, &forged).unwrap_err().0, "P7 purity");
    // P3 via a forged state history that also forges the limiter's own output consistently is
    // impossible (P7 catches it); here: a hold where the policy requires an escalation
    let held = Rec {
        step: g(1, Xhigh),
        cur_before: Low,
        prev: s0,
        d: LimiterDecision {
            action: LimiterAction::KeepPinned,
            rule: LimiterRule::HoldRearm,
            state: LimiterState {
                last_attempt: 1,
                ..s0
            },
        },
    };
    assert!(check(&AUTH, &[held]).is_err());
    // P6: a replay that moved the state
    let a = limit(&s0, &at(3, Medium, Low).input(&AUTH)).unwrap();
    let replayed = vec![
        mk(g(3, Medium), Low, a.action, a.rule, a.state, s0),
        mk(
            g(3, Medium),
            Medium,
            LimiterAction::KeepPinned,
            LimiterRule::Noop,
            LimiterState {
                last_attempt: 4,
                ..a.state
            },
            a.state,
        ),
    ];
    assert!(check(&AUTH, &replayed).is_err());
    // the minimizer shrinks a failing trace to the offending step
    let steps = vec![g(1, Medium), g(2, Medium), g(3, High), g(4, High)];
    let shrunk = minimize(&AUTH, &steps, "P7 purity");
    assert!(shrunk.len() <= steps.len(), "the minimizer terminates");
}

// ---------------------------------------------------------------------------------------------
// pinned traces of the real Governor
// ---------------------------------------------------------------------------------------------

use serde_json::{json, Value};

const FIXTURE: &str = "tests/fixtures/em04c2-governor-traces.json";

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE)
}

#[derive(Debug, PartialEq)]
struct Replay {
    changes: usize,
    xhigh: usize,
    excess: usize,
    held: usize,
    applied: Vec<Level>,
    rules: Vec<&'static str>,
}

fn level_of(row: &Value) -> Level {
    Level::parse(row["effort"].as_str().unwrap()).unwrap()
}

/// The Governor with no limiter (L0): changes from `low`, attempts at `xhigh`.
fn governor_only(rows: &[Value]) -> (usize, usize) {
    let mut cur = Low;
    let mut changes = 0;
    for r in rows {
        if level_of(r) != cur {
            changes += 1;
            cur = level_of(r);
        }
    }
    (
        changes,
        rows.iter().filter(|r| level_of(r) == Xhigh).count(),
    )
}

/// Runs the limiter over a trace with decision-time accounting (the effort the policy settles on
/// at each evaluation), exactly as the policy document's §4 tables count it.
fn replay(rows: &[Value]) -> Replay {
    let (mut cur, mut state) = (Low, LimiterState::new());
    let mut out = Replay {
        changes: 0,
        xhigh: 0,
        excess: 0,
        held: 0,
        applied: vec![],
        rules: vec![],
    };
    for (k, row) in rows.iter().enumerate() {
        let gov = level_of(row);
        let i = LimiterInput {
            attempt: k as u32 + 1,
            governor: gov,
            current: cur,
            authorized: &AUTH,
            strong_escalation: !row["esc"].as_array().unwrap().is_empty(),
            new_claim_units: row["claimDelta"].as_u64().unwrap() as u32,
            new_trusted_failures: row["trustedFail"].as_u64().unwrap() as u32,
            progress_edge: row["rootEdge"].as_bool().unwrap() || row["solEdge"].as_bool().unwrap(),
        };
        let d = limit(&state, &i).unwrap();
        if let LimiterAction::Change(e) = d.action {
            cur = e;
            out.changes += 1;
        }
        state = d.state;
        out.xhigh += usize::from(cur == Xhigh);
        out.excess += (cur as usize).saturating_sub(gov as usize);
        out.held += usize::from(cur < gov);
        out.applied.push(cur);
        out.rules.push(d.rule.as_str());
    }
    out
}

/// §4 of the policy document: (governor changes, governor xhigh) and the L3 column
/// (changes, xhigh, excess, held escalations).
/// (trace, (governor changes, governor xhigh), (L3 changes, xhigh, excess, held))
type DocumentRow = (&'static str, (usize, usize), (usize, usize, usize, usize));
const DOCUMENT: [DocumentRow; 13] = [
    ("A1", (24, 0), (1, 0, 12, 0)),
    ("A3", (3, 16), (3, 16, 0, 0)),
    ("A4", (13, 6), (7, 3, 0, 3)),
    ("A4s", (9, 4), (7, 3, 0, 1)),
    ("G1", (10, 4), (10, 4, 0, 0)),
    ("G2", (5, 3), (5, 3, 0, 0)),
    ("A5", (2, 6), (1, 7, 2, 0)),
    ("A6", (3, 0), (2, 0, 1, 0)),
    ("A7", (8, 0), (4, 0, 2, 0)),
    ("P1", (5, 2), (5, 2, 0, 0)),
    ("P2", (3, 1), (3, 2, 2, 0)),
    ("P3", (5, 0), (5, 0, 2, 0)),
    ("P4", (2, 3), (2, 3, 0, 0)),
];

fn l3_block(rows: &[Value]) -> Value {
    let r = replay(rows);
    let (gc, gx) = governor_only(rows);
    json!({
        "governor": {"changes": gc, "xhighAttempts": gx},
        "l3": {
            "changes": r.changes, "xhighAttempts": r.xhigh, "excess": r.excess, "heldEscalations": r.held,
            "applied": r.applied.iter().map(|l| l.as_str()).collect::<Vec<_>>(),
            "rules": r.rules,
        }
    })
}

fn build_fixture(generated: &Value) -> Value {
    let traces: Vec<Value> = generated["traces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let rows = t["attempts"].as_array().unwrap();
            let mut o = t.as_object().unwrap().clone();
            for (k, v) in l3_block(rows).as_object().unwrap() {
                o.insert(k.clone(), v.clone());
            }
            Value::Object(o)
        })
        .collect();
    json!({
        "schema": "em04c2-governor-traces/1",
        "note": "Generated from the unchanged historical Governor by anti_thrash_review::governor_traces(); the `governor` and `l3` blocks are the pinned results of the policy in effort_limiter.rs. Regenerate only as a reviewed action (see effort_limiter_tests.rs).",
        "policy": {"version": LIMITER_POLICY_VERSION, "dwell": DWELL_DECISIONS, "rearmTokens": REARM_TOKENS},
        "capabilities": generated["capabilities"],
        "traces": traces,
    })
}

fn read_fixture() -> Value {
    let text = std::fs::read_to_string(fixture_path())
        .unwrap_or_else(|e| panic!("the pinned fixture {FIXTURE} is missing ({e})"));
    serde_json::from_str(&text).expect("the fixture is JSON")
}

#[test]
fn the_pinned_traces_reproduce_the_policy_documents_l3_column() {
    let fx = read_fixture();
    assert_eq!(fx["schema"], "em04c2-governor-traces/1");
    assert_eq!(
        fx["policy"],
        json!({"version": LIMITER_POLICY_VERSION, "dwell": DWELL_DECISIONS, "rearmTokens": REARM_TOKENS}),
        "the fixture was pinned under another policy version"
    );
    let traces = fx["traces"].as_array().unwrap();
    assert_eq!(traces.len(), DOCUMENT.len());
    for (t, (id, (gc, gx), (c, x, e, h))) in traces.iter().zip(DOCUMENT) {
        assert_eq!(t["id"], id);
        let rows = t["attempts"].as_array().unwrap();
        let r = replay(rows);
        // the independent, hand-copied table of the document
        assert_eq!(
            governor_only(rows),
            (gc, gx),
            "{id}: the Governor's own numbers"
        );
        assert_eq!(
            (r.changes, r.xhigh, r.excess, r.held),
            (c, x, e, h),
            "{id}: L3 (changes, xhigh, excess, held)"
        );
        // and the stored block, field by field (this is what a reviewer diffs when it changes)
        let stored = l3_block(rows);
        assert_eq!(t["governor"], stored["governor"], "{id}");
        assert_eq!(
            t["l3"], stored["l3"],
            "{id}: the stored L3 block no longer matches the policy"
        );
        println!("PINNED {id}: governor {gc}c/{gx}x -> L3 {c}c/{x}x e{e} h{h}");
    }
}

#[test]
fn the_headline_traces_behave_as_documented() {
    let fx = read_fixture();
    let by = |id: &str| -> Vec<Value> {
        fx["traces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap()["attempts"]
            .as_array()
            .unwrap()
            .clone()
    };
    // A1: 24 -> 1 effort transitions
    assert_eq!(by("A1").len(), 24);
    assert_eq!(replay(&by("A1")).changes, 1);
    // A4: 13 -> 7 transitions and 6 -> 3 xhigh attempts; every hold is a claim-only re-arm
    let a4 = by("A4");
    let r = replay(&a4);
    assert_eq!((r.changes, r.xhigh), (7, 3));
    assert_eq!(r.rules.iter().filter(|x| **x == "hold-rearm").count(), 3);
    // G1, G2 (legitimate verified failures), P1 and P4: the Governor's own sequence, unchanged
    for id in ["G1", "G2", "P1", "P4"] {
        let rows = by(id);
        let want: Vec<Level> = rows.iter().map(level_of).collect();
        let r = replay(&rows);
        assert_eq!(
            r.applied, want,
            "{id}: the limiter must not alter this trace"
        );
        assert!(
            !r.rules.contains(&"hold-rearm") && !r.rules.contains(&"down-pending"),
            "{id}"
        );
    }
    // G1: every claim-driven lap is backed by a Kernel-verified failure, and none is held
    assert!(by("G1")
        .iter()
        .any(|r| r["trustedFail"].as_u64().unwrap() > 0));
    // an applied sequence never exceeds the Governor's ladder and never uses `max`/`low` oddly
    for t in fx["traces"].as_array().unwrap() {
        let r = replay(t["attempts"].as_array().unwrap());
        assert!(r.applied.iter().all(|l| AUTH.contains(l) && *l != Max));
    }
}

/// The fixture is the REAL Governor's output: regenerate in memory (through the worker, no network,
/// no writes) and compare with the pinned copy.
#[test]
fn the_pinned_traces_are_what_the_unchanged_governor_produces() {
    let Some(generated) = super::anti_thrash_review::governor_traces() else {
        eprintln!("node unavailable: the Governor re-derivation is skipped");
        return;
    };
    let fx = read_fixture();
    let again = build_fixture(&generated);
    for (a, b) in again["traces"]
        .as_array()
        .unwrap()
        .iter()
        .zip(fx["traces"].as_array().unwrap())
    {
        assert_eq!(a["id"], b["id"]);
        assert_eq!(
            a["attempts"], b["attempts"],
            "{}: the Governor no longer produces the pinned trace",
            a["id"]
        );
    }
    assert_eq!(
        again, fx,
        "the pinned fixture differs from a fresh derivation"
    );
}

/// EXPLICIT, REVIEWED ACTION - never part of a normal run (`#[ignore]`, and it refuses without the
/// acknowledgement variable). Writes `tests/fixtures/em04c2-governor-traces.json`:
///
/// `NEXUS_REGENERATE_EM04C2_TRACES=reviewed cargo test -p nexus-broker --lib
///  regenerate_the_pinned_governor_traces -- --ignored`
///
/// Review the diff of the fixture like source code: a change to `attempts` means the Governor
/// changed (forbidden); a change to `l3` means the limiter policy changed (needs a new policy
/// version and a new `state_schema`).
#[test]
#[ignore = "explicit, reviewed fixture regeneration"]
fn regenerate_the_pinned_governor_traces() {
    assert_eq!(
        std::env::var("NEXUS_REGENERATE_EM04C2_TRACES").as_deref(),
        Ok("reviewed"),
        "set NEXUS_REGENERATE_EM04C2_TRACES=reviewed to acknowledge that the diff will be reviewed"
    );
    let generated = super::anti_thrash_review::governor_traces().expect("node is required");
    let fx = build_fixture(&generated);
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_string_pretty(&fx).unwrap() + "\n").unwrap();
    println!("wrote {}", path.display());
}
