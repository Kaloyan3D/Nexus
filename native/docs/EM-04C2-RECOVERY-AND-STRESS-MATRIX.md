# EM-04C2 S8 — Recovery and stress matrix for the adaptive `muse-v1` engine

> **Superseded identity (S9.5, commit `b3244c0`):** the adaptive engine described here as `muse-v1` is now **`nexus-adaptive-v1`** (mode `engineering-v2-adaptive` is unchanged). The old id is not an alias anywhere. This document is kept as written; see `EM-04C2-S95-IDENTITY-MIGRATION.md`.


Baseline `0eabd202aec8239133675e8997bd85dd73eef807` (S6). Branch `feature/native-muse-release-readiness`,
uncommitted. Everything here ran on the **mock provider** (no live provider, no paid inference), debug
builds, the real broker, the real Kernel and the real sandbox (`NEXUS_REQUIRE_SANDBOX=1`).
Test code: `native/nexus-broker/tests/code_a56.rs` (`s6_*`, `s7_*`, `s8_*`), `native/nexus-broker/src/engine/muse_v1_active_tests.rs`.

Run the whole matrix:

```bash
cd native && NEXUS_REQUIRE_SANDBOX=1 cargo test -p nexus-broker --test code_a56 -- s6_ s8_ --nocapture
```

## 1. Transaction ordering the matrix checks (EM-02/EM-03, unchanged)

`BeforeRequest` evaluation → host admission → **durable `effort-selected`** (committed before the Registry is
asked) → Registry `issue-attempt` under the sealed binding → Kernel seal/accept/dispatch-authorize →
**write-ahead `attempt-bound`** → provider request. For every non-default attempt of every run below,
`s6_crash_then_continue` / `s8_invariants` assert: (a) `effort-selected` precedes `attempt-bound` in the durable
event log; (b) each request carries exactly the effort its own record bound for that attempt (aligned by
ordinal; the record keeps the newest 32 attempts); (c) the Kernel receipt of an attempt names the issuance and
attempt id the record names; (d) no ordinal is bound twice; (e) the `adaptive` block and every limiter record
decode strictly; (f) no failed evaluation (no limiter record) selected an effort; (g) no worker outlives its run.

## 2. Scenarios

### A. Crash before acceptance — `s8_a_crash_before_acceptance_leaves_no_phantom_selection_and_no_double_counted_evidence`

Fault `before-accept` on the third proposal (the escalation to `xhigh`).

| Check | Observed |
|---|---|
| durable selections of the crashed task | exactly `[(attempt 1, medium)]`; the `xhigh` selection does not exist |
| requests sent before the crash | none carries `xhigh`; 2 attempts bound |
| continuation | starts from the authorized default (`default_effort low`, `effort-reset-continuation` note naming `medium`), new attempt ids; the elevated effort it replaced counts as a drop (`droppedBefore true`) |
| evidence | the crashed task had made 2 claims and judged 1 (baseline 1); the continuation judged the lost claim **once** (`claims [1, …]`) and the sum of all judged claims across both tasks equals the Governor's total growth (`old [0,1]`, `new [1,1,1,0]` = baseline 5): none invented, none double-counted |

### B. Real multi-continuation A4 — `s8_a_real_a4_over_six_generations_is_bounded_by_one_free_plus_r`

Real brokers, six task generations of the same two claims, each interrupted (cancel) while the provider
holds attempt 3; then a seventh generation with a Kernel-verified failing check; then a changed slot policy.

| Generation | `droppedBefore` | tokens used | `xhigh` applied |
|---|---|---|---|
| 1 | false | 0 | **yes** (the free escalation) |
| 2 | true | 1 | yes (token 1) |
| 3 | true | 2 | yes (token 2) |
| 4 | true | 2 | no (held) |
| 5 | true | 2 | no (held) |
| 6 | true | 2 | no (held) |
| 7 (Kernel-verified failed `cargo test` in the task) | true | 2 (untouched) | efforts per attempt `[low, low, low, xhigh]`: held until the check failed, then **immediate** `xhigh` |

`droppedBefore` is monotonic, tokens never decrease, `xhigh` was applied in exactly `1 + R = 3` of 6
generations. Changed slot authorization (policy narrowed between interruption and continuation): the
continuation is `rejected` with `task-binding-mismatch`, 0 turns, **0 provider requests**. Resuming that rejected
continuation is accepted and then fails before dispatch (`workspace-missing`, 0 turns) — pinned by the test,
because it is the only thing standing between a rejected continuation and an engine state that would start empty
(finding F-8 in the implementation report).

### C. Long-loop worker failure

Script `s8_long_script`: 33 requests mixing signals before and after a failing `cargo test`, reads and
claims (4 rounds), 8 retained evaluations in the record.

| Test | Disturbance | Result |
|---|---|---|
| `s8_a_long_adaptive_run_survives_continuous_worker_kills_without_bypassing_the_limiter` | `SIGKILL` of the run's worker every 40 ms (limit 400) | completed; 6 kills landed; control run 33 requests / 3 durable selections / 20.4 s; stressed run 33 requests, and all 8 retained evaluations were without a limiter decision (the restart limit tripped and stayed tripped, so the effort stayed pinned). All durable selections explained by recorded limiter decisions; evaluations that failed selected nothing; no effort above anything the control run reached; no ordinal bound twice; receipts match; worker gone |
| `s8_worker_timeouts_and_cancellation_leave_consistent_durable_state` (part 1) | two `SIGSTOP`s of the worker while idle/in flight → bridge timeouts (10 s each) | completed, wall **30.3 s** against 20.4 s undisturbed (one 10 s bridge timeout absorbed; a stop that lands while the worker is idle costs nothing until the next call); invariants hold |
| same (part 2) | cancel while attempt 5 is in flight, then continue the cancelled task | cancelled run terminal with an authentic, consistent record; the continuation completes and satisfies the invariants against its own slice of provider requests |
| `tools/prodgate worker_gate` (release build) | repeated `SIGKILL` of a standalone worker | transparent replacement once, then `bridge-restart-limit` after 6 spawns/minute; cancel flag → `bridge-cancelled`; shutdown → `bridge-closed` |
| `muse_v1_active_tests::a_failing_worker_never_bypasses_the_limiter_and_loses_no_evidence` | `bridge-timeout` / `-died` / `-unavailable` / `-busy` ×3 each | effort stays pinned, limiter/baseline/pending evidence unchanged, the same claims and failed check are judged after recovery |
| `muse_v1_active_tests::a_replayed_attempt_is_judged_once_and_consumes_no_evidence` | stale/replayed evaluation of one attempt | `replay-guard`; evidence stays pending; one selection |
| signals before / after a failed verification | `pending_trusted` | folded by the signal path, judged once (engine-level and in the long script) |

Backpressure (`bridge-busy` at 4 pending calls, the broker-level worker allowance) is asserted in
`worker_tests.rs` (C1/S1 suites, unchanged) and in `tools/prodgate worker_gate` (allowance of 2: third worker
refused with `bridge-busy`, slot returns on shutdown).

### D. Transaction recovery matrix (adaptive mode)

| Crash / failure point | Test | Durable state afterwards | Continuation |
|---|---|---|---|
| before acceptance (`before-accept`) | `s8_a_crash_before_acceptance…` | selection absent; evaluation lost | default effort, claim judged once |
| after durable acceptance (`after-accept`) | `s6_a_crash_after_the_durable_selection_never_duplicates_or_misapplies_it` | `effort-selected xhigh` committed; nothing issued or sent | default; drop; re-asked → token 1 |
| after Registry authorization (`after-authorize`) | same | same (the issuance is re-derivable) | same |
| after write-ahead binding (`after-bind`) | same | attempt `bound`, never re-sent | same, no ordinal twice |
| failed Signals persistence (`persist-signal`) | `s6_a_crash_around_signal_acceptance_never_loses_or_invents_evidence`, `muse_v1_active_tests::a_signal_whose_commit_fails…` | signal neither acknowledged nor counted | re-derived from its own validated signals |
| crash with an evaluation staged but uncommitted | `muse_v1_active_tests::a_crash_before_any_commit_loses_the_evaluation…` | previous commit | redone identically, claim judged once |
| cancellation | `s8_worker_timeouts_and_cancellation…` part 2 | consistent record | continues |

No new fault semantics were introduced: every point is an existing EM-03 hook (`engine/test_faults.rs`).

## 3. E. Legacy production compatibility (`muse-v0`)

`scripts/EM04C2-CompareBodies.cjs` compares the provider request bodies the mock provider received in the full
`code_a56` suite on the fixed pre-adaptive baseline `50a24d791cdb3c1a4b00eb15b24843c4b45d9798` (EM-04C1) with
this tree (`NEXUS_BODY_DUMP_DIR`, harness inert unless set):

| | |
|---|---|
| tests present in both | 116 (18 tests exist only on this tree) |
| request bodies compared | **1,170** |
| byte-identical | 1,078 |
| differ only in volatile tool-result text | 88 — cargo's `finished … in 0.41s`, `"wallMs":N`, and the order of the lines/sections of a **parallel** `cargo test` run inside a tool result (the line *multiset* is compared) |
| same multiset in another arrival order (concurrent runs) | 4 |
| **unexplained** | **0** |
| non-`input` fields (model, `tools` incl. bytes/digest, `tool_choice`, `parallel_tool_calls`, `stream`, limits, `reasoning`) identical | **1,170 of 1,170** |

Required task content, tool-call/result pairing and reasoning replay are inside `input` and identical in the
1,078 byte-identical bodies and in every "volatile" body (only the tool-result strings differ).
Pinned historical A614: `em04a_measure_a614_configurations` — `muse-v0` **max 449,944 B** with and without a
449,999 B budget, 59 requests, 40 compactions (unchanged); `muse-v1-shadow` with the same budget 425,840 B.
Adaptive A614 (S7): **max 428,725 B** (budget 440,000, guard 450,000), 59 requests, 78 compactions.

## 4. Overhead and limits observed

| Quantity | Value |
|---|---|
| attempt record window | newest 32 attempts (EM-03 bound) — invariants align by ordinal |
| worker RSS after 2,000 requests, release build | 75.8 MiB (system Node 26) / 77.6 MiB (bundled Node 24.18.1) |
| full adaptive attempt (debug, incl. 1–2 fsynced commits) | ≈ 30 ms (S6 measurement) |
| long script, undisturbed | 33 requests; completes in the same order of seconds as the `muse-v1-signals` runs |
| restart limit | 6 spawns / 60 s then `bridge-restart-limit`; evaluations stay `KeepPinned` |
