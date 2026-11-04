# EM-04C2 S6 — Policy Version 2 validation record

Baseline `34d84756c5390ac147180a45896e2d6bf8c8f1c6`. Branch `feature/native-muse-v1-integration`, uncommitted.
Commands ran in `native/` of that worktree. No live provider, no paid inference.

## 1. What Policy V2 is

V1 (S5) remembers "the task has dropped" only in the generation-local `last_down_attempt`, which a
continuation clears: each continuation would grant another FREE claim-only strong escalation (S5 finding
F-2, reproduced by `v1_would_have_refilled_the_privilege_and_v2_does_not`: V1 escalates with 0 tokens in six
consecutive generations). V2 adds one persisted logical-task flag:

| Rule | V1 | V2 |
|---|---|---|
| "has the task dropped?" (free vs claim-driven strong escalation; crediting trusted failures) | `last_down_attempt.is_some()` (this generation) | `dropped_before` (this **logical task**, any generation) |
| `dropped_before` | — | `false` at task start; set by the first applied move down or by a continuation that resets an elevated effort to the default; **never cleared** |
| `rearm_tokens_used` (R = 2) | inherited | inherited (per logical task) |
| generation-local fields on continuation | cleared | cleared (`pending_down`, `last_down_attempt`, `trusted_since_down`, `last_attempt = 0`) |
| effort reset at continuation | not a drop | a drop iff `in_force > default` (`continued_after_reset`); an incomparable level is treated as a drop |
| trusted failure | bypasses the budget | bypasses the budget (unchanged) |
| state invariants | 5 fields | + `lastDownAttempt ⇒ droppedBefore`, `trustedSinceDown ⇒ droppedBefore`, `rearmTokensUsed > 0 ⇒ droppedBefore` |

The algorithm is the same function (`effort_limiter.rs` `step`, parameterised by where the drop history
comes from); V1's code path, tests and pinned fixture are unchanged (29 S5 tests still pass; the fixture
file is byte-identical to the S5 commit — checked with `git diff --stat` against `34d8475`).

## 2. Results

| Check | Result |
|---|---|
| S5 limiter tests (T1–T16, properties, pinned traces; V1) | 29 passed, 1 ignored (regeneration action), unchanged |
| **V2 pure tests** (`effort_limiter_v2_tests`) | **10 passed** |
| Engine tests through the durable host + real Governor (`muse_v1_active_tests`) | **23 passed** |
| New end-to-end tests on the mock provider (`code_a56` `s6_*`) | **7 new passed** + the updated S4 gate test |
| Whole `engine::` lib suite | included in the battery (§6) |
| Full offline workspace battery | 1,215 passed / 0 failed / 57 ignored (§6) |
| fmt / strict clippy (`--workspace --all-targets -D warnings`, and the production lib with `--no-default-features`) | clean |

### 2.1 Pure V2 tests

| Test | Proves |
|---|---|
| `inside_one_generation_policy_v2_is_policy_v1_on_5000_traces` | V2 ≡ V1 inside a generation: identical action, rule and V1 fields on 5,000 × 60-step traces; `dropped_before ⇔ last_down_attempt.is_some()` |
| `across_generations_the_claim_only_budget_is_never_refilled_on_5000_tasks` | 5,000 multi-generation tasks (1–4 generations, random effort resets), judged by an independent oracle: `dropped_before` equals the oracle at every step; tokens and the flag never go back; free/corroborated escalations are never delayed; **claim-only re-arms ≤ R = 2 across all generations**; holds occur only with the budget spent. Coverage asserts: >100 holds, >500 implicit-reset drops, >100 tasks with re-arms |
| `an_implicit_reset_of_an_elevated_effort_is_a_drop_and_each_continuation_costs_a_token` | gen 1 free; gens 2 and 3 cost token 1 and 2; gens 4–11 held; tokens kept across every continuation |
| `v1_would_have_refilled_the_privilege_and_v2_does_not` | V1: 6/6 generations escalate token-free; V2: exactly `1 + R` |
| `an_effort_at_or_below_the_default_is_not_a_drop` | at/below default → no drop; the flag is never cleared by continuations; a never-dropped task keeps its privilege |
| `a_kernel_verified_failure_still_escalates_at_once_after_the_budget_is_spent` | trusted evidence (this attempt, or earlier in the new generation) bypasses the exhausted budget without touching it; no credit without a prior drop |
| `an_unchanged_level_never_produces_a_change_in_any_generation` | 29 attempts, every pairing: always `noop` |
| `the_v2_state_round_trips_strictly_and_stays_small`, `forged_v2_states_are_refused_…`, `the_policy_versions_are_distinct_and_pinned` | canonical 6-key encoding pinned; a V1 state is not a V2 state and vice-versa; forged `droppedBefore` (type, missing, history without flag, flag set for free, cleared, token refunded, state ahead of the host) refused by decoder, validator and `verify_transition_v2` |

### 2.2 Mutation checks (the tests are not vacuous)

Each mutation was applied to the source, the relevant suite run, and the source restored.

| Mutation | Caught by |
|---|---|
| V2 uses the generation-local drop again (the S5 loophole) | 4 V2 tests fail |
| a continuation reset is not a drop | 4 V2 tests fail |
| tokens not inherited by a continuation | 3 V2 tests fail |
| `strong_escalation` read from an audit-length (8-entry) trace | `an_escalation_entry_beyond_the_eighth_position_still_counts` fails |
| `pending_trusted` ignored | 5 engine tests fail |
| (S5, re-checked) no replay guard / no trusted bypass / edge ignoring evidence / unlimited tokens / newer-proposal-only dwell | S5 suites fail, as recorded |

### 2.3 Engine path equals the pinned S5 traces

`the_engine_reproduces_every_pinned_s5_trace_through_the_whole_durable_path` drives the 12 restart-free
S5 scenarios through `EngineRun` (host admission, `check_transition`, `check_effort`, HMAC-protected record,
write-ahead binding) with the real Governor, and requires for every attempt the pinned L3 effort, the pinned
number of durable `effort-selected` events, a `limiter:<rule>` detail on each, and the pinned rule sequence.
All 12 reproduce exactly (A1 1 change; A4 7 changes; G1/G2/P1 unchanged vs the Governor; …). P4 (contains a
restart) is covered by the continuation tests because V2 deliberately differs there (a restart that resets an
elevated effort is a drop).

### 2.4 Across generations on the real engine

| Scenario | Result |
|---|---|
| A4: 8 generations, each interrupted while at `xhigh`, same claims every time | `xhigh` selected in generations 1, 2, 3 only (`1 + R`); 4–8 held; `droppedBefore = true`, tokens = 2 |
| then a Kernel-verified failed check in generation 9 | `xhigh` immediately; tokens untouched |
| failed check folded by the signal path *before* the model's signals | counted via `pending_trusted` (see report finding F-4); a model signal alone never creates trusted evidence |
| default-only slot (`["low"]`), 12 mixed claims/failures | effort `low` on every attempt, zero selections, limiter never runs |
| real brokers (mock provider): one crash after the durable selection, then continuation | continuation: `droppedBefore = true`, `rearmTokensUsed = 1`, `xhigh` re-asked and applied exactly once |

## 3. F-3 (complete Governor trace) evidence

| Case | Result |
|---|---|
| `escalation:` as the 14th of 15 entries | recorded `strong = true`, `trace_len = 15`; the 8-entry audit copy contains **no** escalation entry; survives persist/restore |
| 33 entries / a 600-byte entry / a non-string entry / a non-array trace | whole evaluation `bridge-output-invalid`, nothing judged, nothing consumed, effort pinned |
| forged `escalation:` entry the block does not justify; escalation removed from the trace | rejected the same way (flag must equal the Governor's own condition over the returned block) |
| the host's restated condition vs the real Governor | identical on 400 random blocks (both outcomes exercised) and all pinned traces |

## 4. Overhead (measured; **debug** build, 8 cores, shared machine — an order of magnitude, not a benchmark)

| Quantity | Measured |
|---|---|
| `evaluate_limiter` (pure judge) | 4.7 µs per evaluation |
| one full attempt: signal-less `BeforeRequest` = worker round trip (Governor) + limiter + host checks + 1–2 durable HMAC commits with fsync | 29.7 ms per attempt (dominated by the two fsync commits; the C1 release measurement of the Governor round trip alone is 1.19 ms) |
| adaptive payload at saturation (8 retained decisions with limiter records, 64 executions, 100 processed signal ids) | 9,856 bytes (bound 16,384) |
| added to `muse-v0` runs | none: no code path, no worker, no bytes |
| limiter state / baseline on disk | ≈ 270 bytes (`adaptive` block) |

## 5. What this validation does NOT show

* No live provider: how a provider treats `reasoning.effort` changing mid-conversation (R3) is unobserved.
* The historical sandbox failure ("systemd scope was not created") is **not** claimed eliminated.
* JS suites: unchanged from the baseline tree (see the implementation report); the 20 environmental
  failures are pre-existing and are not claimed green.
* Two consecutive green batteries on the final commit are a Checkpoint 2 exit requirement (S10), not met here.

## 6. Battery

**Full offline workspace battery** `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`, run once on the final tree: **1,215 passed, 0 failed, 57 ignored** (91 result lines, exit 0). The S5 battery was 1,175 / 0 / 57: +40 passed = 10 V2 pure + 23 engine + 7 new end-to-end tests; ignored unchanged. This is one green battery; two consecutive ones are required only on the final S10 commit. The historical sandbox failure did not occur in this run and is not claimed eliminated.

## Erratum (added in S7–S9)

§5's JS bullet ("unchanged from the baseline tree … pre-existing") is superseded by
`EM-04C2-S7-S9-IMPLEMENTATION-REPORT.md` §4: part of those failures were real S4 regressions, now fixed.
