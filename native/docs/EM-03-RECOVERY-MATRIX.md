# EM-03 — Recovery matrix

All tests are offline, using a mock provider and the real Registry, Kernel, daemon, sandbox and
broker.
- **Crash simulation:** a test-only fault point (`engine::test_faults`, feature `test-engines`)
  panics inside the run's worker. The pipeline catches it and closes the run; nothing else is
  written. That reproduces the durable state of a crash at that point.
- **Restart:** `shutdown()` + `start()` on the same state directory (R-LOCK-1 lock lifecycle).
  Continuation is user-initiated `resume`.

Test locations:
- `a56` = `nexus-broker/tests/code_a56.rs`
- `es` = `nexus-broker/src/engine_state.rs` unit tests
- `et` = `nexus-broker/src/engine/tests.rs` (`v2` module)

| # | Failure point / case | Durable state afterwards | Expected | Result | Test |
|---|---|---|---|---|---|
| 1 | Restart **before proposal acceptance** (attempt 2's proposal never validated) | record at attempt 1 (bound); no `effort-selected` | nothing about attempt 2 anywhere; continuation starts at the default | ✓ | a56 `em03_restart_before_a_proposal_is_accepted_leaves_no_trace_of_it` |
| 2 | Restart **after durable acceptance, before Registry authorization** | `effort-selected(high, attempt 2)` committed; no `attempt-bound 2` | no target issued; 1 request; 1 Kernel receipt; continuation records `effort-reset-continuation(high)`; the inherited engine re-proposes, which is committed and re-authorized under the NEW binding before its attempt is bound | ✓ | a56 `em03_restart_after_durable_acceptance_before_authorization_never_sends_it` |
| 3 | Restart **after authorization, before dispatch** | as 2 (the Kernel holds a sealed high target, never bound) | never sent; Kernel receipts = 1 | ✓ | a56 `em03_restart_after_authorization_before_dispatch_never_sends_it` |
| 4 | Restart **during an active attempt** (bound, sent, answered, outcome not recorded) | `attempt 2: bound` | continuation records `predecessor-attempt-unresolved(2, high)`; never re-sent; old/new Kernel command sets are disjoint; old task has 2 receipts | ✓ | a56 `em03_restart_during_an_active_attempt_never_resends_it` |
| 5 | Restart **after a completed attempt** | `attempt 2: answered` (durable with attempt 3's binding), `attempt 3: bound` | outcome kept; attempt 3 never sent | ✓ | a56 `em03_restart_after_a_completed_attempt_keeps_its_recorded_outcome` |
| — | Shared checks for 1-5 | — | the crashed record authenticates; lineage names its exact revision; each task's requests carry exactly the efforts its record bound, in order; every non-default attempt has a durable selection before its binding; event `seq` monotonic; Kernel receipts match the record's issuance and attempt ids | ✓ | a56 `em03_crash_then_continue` |
| 6 | **Duplicate proposal id** (incl. after restore) | unchanged | `engine-proposal-replayed` | ✓ | et `a_restored_host_refuses_replayed_stale_and_reordered_proposals`; EM-01 tests |
| 7 | **Stale state revision** | unchanged | `engine-state-stale` | ✓ | et (same); EM-01 tests |
| 8 | **Reordered proposals** (two built on one revision) | first applies, second refused | `engine-state-stale` | ✓ | et (same) |
| 9 | **Tampered persisted state** (escalated selection smuggled in) | — | continuation refused before any working copy or request: `engine-state-unauthenticated` | ✓ | a56 `em03_a_tampered_engine_state_refuses_the_continuation_before_dispatch`; es `tampered_foreign_versioned_or_oversized_records_are_refused` |
| 10 | **Invalid state version** (record schema, engine contract, state schema) | — | `engine-state-version` (never reinterpreted) | ✓ | a56 `em03_an_engine_state_of_another_version_refuses_the_continuation`; es `continuations_inherit_reset_or_refuse_exactly_by_rule` |
| 11 | **Task or engine identity mismatch** | — | `engine-state-identity` (another task's authentic record; another engine's record); engine change across a continuation is also refused by EM-01 | ✓ | es (both tests); a56 `em01_a_continuation_under_another_engine_is_refused_before_dispatch` |
| 12 | **Unsupported effort** (`xhigh`, not in the binding) | unchanged | `engine-effort-not-authorized` (host); the Registry and Kernel would also refuse (EM-02) | ✓ | et `unauthorized_changes_are_refused_and_change_nothing`; EM-02 suites |
| 13 | **Effort outside the slot policy** (route declares `high`, no policy) | no `effort-selected` | run fails closed after the default attempt; only `low` sent | ✓ | a56 `em03_an_effort_outside_the_slot_policy_is_refused_and_never_sent` |
| 14 | **Failure to persist state** | none written | run fails before any request: `engine-state-unpersisted` | ✓ | a56 `em03_a_failure_to_persist_engine_state_fails_closed_before_dispatch` |
| 15 | **Ambiguous provider delivery and retry** | lost attempt `uncertain`; retry is a new attempt | each request carries its own attempt's effort; one Kernel command per request; none twice | ✓ | a56 `em03_an_ambiguous_delivery_is_recovered_as_a_new_attempt_never_a_resend` |
| 16 | **Continuation of a pre-EM-03 run** (no engine state) | — | explicit rule `pre-em03-no-state`; same engine (EM-01), initial state, default effort | ✓ | a56 `em03_a_pre_em03_run_is_continued_under_an_explicit_rule`; es |
| 17 | Engine that does not inherit (`muse-v0`) continuing | — | `fresh-engine-does-not-inherit` | ✓ | es |
| 18 | Invalid inherited payload | — | `engine-state-corrupt` | ✓ | es |
| 19 | Same task generation started twice | — | `engine-state-identity` (records are never overwritten by `create`) | ✓ | es |
| 20 | Oversized payload / record; unknown fields; path traversal | unchanged | `engine-state-oversized` / `engine-state-corrupt` / `engine-state-identity` | ✓ | es |
| 21 | Bounded history across long runs | 64 events / 32 attempts | `seq` monotonic after truncation | ✓ | es `history_is_bounded_and_sequence_stays_monotonic` |
| 22 | `muse-v0` production path | record written, no selections, all attempts `low` | no model or task text persisted; bodies byte-identical to `2403a8d` | ✓ | a56 `em03_muse_v0_keeps_its_default_effort_and_persists_no_model_text`; byte comparison |
| 23 | low → high → low with an authorized fixture | 3 attempts, 2 selections | each selection durable before its binding; Kernel issuances A1 = A3 ≠ A2; bodies `low, high, low` | ✓ | a56 `em03_a_test_engine_moves_low_high_low_through_registry_and_kernel_one_attempt_at_a_time` |

| 24 | **End-of-run engine write fails** (completed run), restart | record without `run-ended`, authentic | the run record says completed (authoritative); not continuable; receipts = attempts | ✓ | a56 `em03_a_failed_terminal_write_never_contradicts_a_completed_run` |
| 25 | End-of-run engine write fails (failed run), restart, continuation | as 24 | the continuation authenticates it, records attempt 1 unresolved, never re-sends, default effort | ✓ | a56 `em03_a_failed_terminal_write_on_a_failed_run_continues_safely` |
| 26 | Crash between the authoritative verdict and the engine end | record without `run-ended`; run record terminal | no contradictory terminal state (engine end written after the verdict) | ✓ | a56 `em03_a_crash_between_the_verdict_and_the_engine_end_leaves_the_verdict_authoritative` |
| 27 | **Accepted proposal, Registry/Kernel authorization fails**, restart, continuation | `effort-selected(2)`, no `attempt-bound 2` | nothing bound or sent for it; continuation resets, re-proposes and re-authorizes under its own binding | ✓ | a56 `em03_an_accepted_proposal_whose_authorization_fails_never_dispatches` |
| 28 | HMAC key lost with existing records / symlinked / group-readable / malformed / reopened | — | refused, never regenerated or followed; preserved across reopen | ✓ | es `the_key_is_never_regenerated_replaced_or_followed` |

**Not reconcilable → fail closed.**
- *A record that fails authentication, version, identity or payload validation* refuses the
  continuation before it creates anything.
- *A commit that fails* stops the run before the effect it authorizes.
- *A bound attempt with an unknown outcome* is recorded and never re-sent; its Kernel intent is
  single-use.
