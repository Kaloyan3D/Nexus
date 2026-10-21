# EM-04C2 — Effort Transition Limiter: policy, evidence and acceptance tests

Baseline `50a24d791cdb3c1a4b00eb15b24843c4b45d9798`. Design only; nothing here is implemented.
The historical Governor (`config/Muse-ReasoningGovernor.cjs`, `…Runtime.cjs`, `…Activity.cjs`) is
**not modified**. The limiter is a separate, deterministic host-side component of the future
`muse-v1` engine with durable state under the existing Engine-state authority.

All numbers below were produced by driving the **real, unchanged** Governor/Runtime/Activity
modules through the real worker with 13 traces (the ten EM-04C1 anti-thrash scenarios, two
"genuine evidence" scenarios, and four traces transcribed from `engine/governor_parity.rs`), then
replaying the Governor's per-attempt decision through each candidate policy in a small Python model
(scratch tooling, not committed). The trace data and the model are specified in §6 so Sonnet 5.5
can regenerate them as Rust fixtures.

---

## 1. What the Governor does (source-verified), and why the user's four rules are not enough

* `resolveMuseReasoningEffort` (`Muse-ReasoningGovernor.cjs`) is a **memoryless** function of
  `(phase, active counters, flags, requestMax, capabilities)`: phase default → strong escalation to
  `xhigh` (`failedHypotheses ≥ 2 ∨ failedImplementationAttempts ≥ 2 ∨ conflictingEvidence`) →
  implement carve-out → explicit max → downward-only clamp. No dwell, no hysteresis.
* **Active** counters reset only on the *false→true* establishment edge of `rootCauseEstablished`
  (resets `failedHypotheses`, `conflictingEvidence`) and `solutionEstablished` (resets
  `failedImplementationAttempts`) — `Muse-ReasoningRuntime.cjs` `transitionMuseReasoningState`.
  **Historical** totals (`totalFailedHypotheses`, `totalFailedImplementationAttempts`) are monotonic
  and never influence effort.
* **Trusted** operational evidence (Kernel-backed receipts folded by the Activity reducer) can move
  the effective phase to `recover` (→ `high`) or `implement`; it can never produce `xhigh`. Every
  `xhigh` the Governor ever produces is therefore justified by **model claims** (failure counts or a
  conflict flag), each carrying a Core-computed, replay-protected dispatch key (`signals.rs:193`).
* `requestMax` is unreachable from the model (`FORBIDDEN_SIGNAL_FIELDS`, test A10).

Measured behaviour of the unmodified policy (applied directly, L0):

| Scenario (attempts) | effort changes | attempts at `xhigh` | property |
|---|---|---|---|
| A1 phase flapping `diagnose/implement` (24) | 24 | 0 | one change per attempt |
| A3 sticky escalation (20) | 3 | 16 | no decay until a root-cause edge |
| A4 claim-only re-arm lap ×6 (24) | 13 | 6 | an `xhigh` episode every 4 attempts, forever |
| A4s slow lap ×4 (32) | 9 | 4 | same, slower |
| G1 genuine laps: failing tests each lap ×4 (20) | 10 | 4 | legitimate |
| G2 genuine second problem after progress (10) | 5 | 3 | legitimate |
| A6 edit/test loop (16) | 3 | 0 | operational path is already anti-thrash |

Two distinct harms: **(H1) churn** — each change costs a Registry `issue-attempt` (cached per
effort), two Kernel seals and a durable engine commit (≈ 190 ms first issuance per effort);
**(H2) claim-driven spend** — a model that reports two failures buys `xhigh` for the rest of the
task (A3). H2 cannot be removed by any host policy without distrusting every claim; it is bounded
by the operator's `allowedReasoning` and is the product's explicit model of "claims". H1, and the
*repetition* of H2 (A4), can be bounded.

The four proposed rules (up immediate; down after two consecutive lower decisions from distinct
attempts; new escalation evidence resets pending; identical = no-op) fix A1 (24 → 1 changes) but,
measured as rule set **L1**, **do not fix A4 (13 → 13) and they roughly double the time spent at
`xhigh`** (A4: 6 → 12 attempts; G1: 4 → 8; P1: 2 → 4) because every legitimate drop is delayed by one
attempt. Two amendments, both small and both evaluated below, address that.

## 2. Evidence model for a minimal A4 solution

The limiter needs to know *why* the Governor wants a higher effort. Evidence has two kinds with
different trust:

| Kind | Identity (replay-protected by) | Source in the existing engine |
|---|---|---|
| **Trusted** | Kernel `execution_id` (unique), `seq` (monotonic per run), generation | `ActivityObservation` folded by `evaluate`: accepted only if `generation == s.generation ∧ seq > observed_through ∧ execution_id ∉ seen` (`muse_v1.rs:520-535`) — replays/foreign are counted `refused`, never folded |
| **Claimed** | Core dispatch key `n1:<sha256(generation,attempt,call_id,stableSignalHash)[..29]>` + processed-id window (FIFO 100) in the Governor state; **historical totals are the monotonic evidence counter** | `signals.rs:193`; `processedSignalIds`; `totalFailed*` |

Definitions the limiter uses (all derivable from the Governor's per-evaluation output plus the
engine's own state; no new model-facing surface):

* `new_trusted_failures` — number of Kernel-verified **Failed** verifications *freshly folded* in this
  evaluation (counted in `evaluate` only for observations that passed the checks above).
* `new_claim_units` — `Δ(totalFailedHypotheses + totalFailedImplementationAttempts)` since the
  previous evaluation, plus 1 if `conflictingEvidence` rose false→true. The totals are monotonic and
  unaffected by progress resets (the *historical* counters are the identity; the *active* counters
  are not used because they reset), and a replayed signal is a `duplicate` that leaves them unchanged.
* `strong_escalation` — the Governor trace contains `escalation:[…]` (the only way to reach `xhigh`).
* `progress_edge` — `rootCauseEstablished` or `solutionEstablished` went false→true since the
  previous evaluation (the Governor's own reset condition).
* `attempt` — `attempts_dispatched + 1`, strictly monotonic; the host already admits **at most one
  evaluation per consultation for attempt `dispatched+1`** (`check_transition`, EM-04A rule table),
  so one attempt cannot be counted twice.

## 3. The policy

Levels order: `low < medium < high < xhigh < max` (the Governor's ladder never yields `low`; the
default `low` is *below* every Governor output, so the first adaptive decision is always an "up").

State (`LimiterState`, part of the engine payload, bounded, HMAC-protected by the EM-03 record):

```
pending_down:        Option<{ target: Level, attempt: u32 }>
last_down_attempt:   Option<u32>
trusted_since_down:  bool            // a fresh trusted failure was folded after last_down_attempt
rearm_tokens_used:   u8              // per task (inherited by continuations)
last_attempt:        u32             // monotonic guard
```

Parameters (constants of the engine version, **not** flags; changing them = new `state_schema`):
`D = 2` consecutive lower decisions, `R = 2` uncorroborated re-arms per task.

Algorithm, per `BeforeRequest` evaluation with `n = attempt`, `gov = Governor effort`
(already clamped and ∈ authorized), `cur = effort in force` (default if no selection):

```
0. if n ≤ last_attempt            → KeepPinned (replay / out-of-order guard); stop
   last_attempt = n
   if new_trusted_failures > 0 and last_down_attempt.is_some(): trusted_since_down = true

1. gov == cur                      → pending_down = None; KeepPinned                         [identical = no-op]

2. gov  > cur   (escalation)       → pending_down = None
     if !strong_escalation or last_down_attempt.is_none():            Change(gov)             [first / non-claim escalation: never delayed]
     else (a claim-driven RE-ARM after an earlier de-escalation):
        if trusted_since_down:                                         Change(gov); trusted_since_down = false   [genuine new evidence: free]
        elif rearm_tokens_used < R:                                    rearm_tokens_used += 1; Change(gov)       [bounded re-arming]
        else:                                                          KeepPinned (hold; re-evaluated every attempt)

3. gov  < cur   (de-escalation)
     if progress_edge and new_claim_units == 0 and new_trusted_failures == 0:
                                                                       Change(gov); last_down_attempt = n; trusted_since_down = false   [progress-based drop is immediate]
     elif new_claim_units > 0 or new_trusted_failures > 0:            pending_down = None; KeepPinned                                 [new escalation evidence resets]
     elif pending_down == Some{target, attempt = n-1}:                 Change(max(target, gov)); last_down_attempt = n; pending_down = None   [2nd consecutive, distinct attempt]
     else:                                                             pending_down = Some{target: gov, attempt: n}; KeepPinned
```

Invariants: output ∈ authorized and ≠ `cur` and ≠ `max`; escalations never delayed except step 2's
claim-only re-arm beyond the token budget; at most `1 + R` claim-driven strong-escalation *episodes*
per task are ever applied without trusted corroboration.

### 3.1 Why these amendments to the four proposed rules

| Amendment | Reason (measured) |
|---|---|
| **A-1. Progress-edge de-escalation is immediate.** | The "two lower decisions" dwell is the right brake for *phase flapping* (no edge involved), but when the Governor's own reset condition fired this very attempt the drop is the intended progress signal. Without A-1 the dwell doubles `xhigh` time in A4/G1/P1 (excess effort-attempts: A4 12 → 0). The edge is a claim, so abusing it is handled by A-2, not by delaying the drop. |
| **A-2. Bounded re-arming by tokens + trusted-evidence bypass.** | A4 is a *repetition* of H2, not a new capability: the model can always buy `xhigh` once (A3). The limiter bounds repetition: an escalation that follows a de-escalation and rests on claims alone consumes one of `R` tokens; **fresh Kernel-verified failures bypass the budget** (so genuine second problems escalate at once). No time cooldown: a cooldown `W` also delays honest claims (measured: the P1 parity trace lost its second escalation for every `W ≥ 1`), whereas the token cap alone leaves every genuine/parity trace unchanged. |

Both amendments are consistent with the stated principles (Registry/Kernel remain the authorization
boundaries; upward authorized transitions are immediate except the narrow claim-only re-arm case;
identical proposals are no-ops; new escalation evidence resets pending de-escalation). **Decision D1
for the owner:** accept A-1 and A-2, or run with the four rules only (L1) and accept that A4 is not
bounded and `xhigh` dwell grows.

## 4. Candidate comparison (real Governor traces)

Columns: `c` = effort changes applied from `low` (including the first), `x` = attempts at `xhigh`,
`e` = "excess effort-attempts" (Σ over attempts of levels the limiter keeps *above* what the
Governor wants — the cost of delay), `h` = attempts at which an escalation the Governor wanted was
held (quality risk).

| Trace | L0 Governor | L1 = four rules | L2 = L1 + tokens (R=2) | **L3 = L2 + A-1 (recommended)** |
|---|---|---|---|---|
| A1 phase flapping | 24c 0x | 1c 0x e12 | 1c 0x e12 | **1c 0x e12 h0** |
| A3 sticky escalation | 3c 16x | 3c 17x e2 | 3c 17x e2 | **3c 16x e0 h0** |
| A4 re-arm lap ×6 (claims) | 13c 6x | 13c 12x e12 | 7c 6x e6 h3 | **7c 3x e0 h3** |
| A4s slow lap ×4 (claims) | 9c 4x | 9c 8x e8 | 7c 6x e6 h1 | **7c 3x e0 h1** |
| G1 genuine laps (failing tests) ×4 | 10c 4x | 10c 8x e4 | 10c 8x e4 | **10c 4x e0 h0** |
| G2 genuine second problem | 5c 3x | 5c 4x e2 | 5c 4x e2 | **5c 3x e0 h0** |
| A5 conflict then resolve | 2c 6x | 1c 7x e2 | 1c 7x e2 | 1c 7x e2 h0 |
| A6 edit/test loop then pass | 3c 0x | 2c 0x e1 | 2c 0x e1 | 2c 0x e1 h0 |
| A7 ordinary session (14) | 8c 0x | 4c 0x e3 | 4c 0x e3 | **4c 0x e2 h0** |
| P1 parity: failure escalation + progress | 5c 2x | 2c 4x e3 | 2c 4x e3 | **5c 2x e0 h0** |
| P2 parity: root cause / conflict / invalidation | 3c 1x | 3c 2x e2 | 3c 2x e2 | 3c 2x e2 h0 |
| P3 parity: trusted activity | 5c 0x | 5c 0x e2 | 5c 0x e2 | 5c 0x e2 h0 |
| P4 parity: restart and continuation | 2c 3x | 2c 3x e0 | 2c 3x e0 | 2c 3x e0 h0 |

Reading:
* **A1:** 24 → 1 change under every limiter (the flapping case is fully solved by the dwell).
* **A4:** applied `xhigh` episodes are `1 + R = 3` out of 6 laps; changes 13 → 7; `xhigh` attempts
  6 → 3. Increasing `R` raises both linearly (R=3: 9c/4x; R=1: 5c/2x). Time cooldown `W∈{2..6}` made no
  difference to A4 and hurt P1, so it is excluded.
* **Genuine evidence is never suppressed:** G1 (4 laps each with failing tests) and G2 apply the
  same changes as the Governor with `h0`. The only held escalations are the claim-only A4 laps beyond
  the budget.
* **The existing parity traces:** under L3, P1 and P4 apply exactly the Governor's changes (P1 5c/2x,
  P4 2c/3x, no excess, no held escalation); P2 and P3 differ only by the dwell (excess ≤ 2
  effort-attempts, nothing held). Under L1/L2 P1 would lose its second escalation episode's
  immediacy and double its `xhigh` time, which is what A-1 repairs.
* **Residual cost:** the dwell leaves excess in A1/A5/A6/A7/P2/P3 (≤ 12 effort-attempts in the
  24-attempt flapping trace; ≤ 2 elsewhere): one extra attempt at the higher level per confirmed drop.

Stability of the parameters (L3, cooldown 0): `R` is the only knob that matters on these traces:
`R=1` → A4 5c/2x/h4; `R=2` → 7c/3x/h3; `R=3` → 9c/4x/h2; genuine traces unchanged for all `R`.

## 5. Interaction with the host and the rest of the engine

* **Placement.** After the shadow `evaluate` in the active `muse-v1` engine's `BeforeRequest`
  (`engine/muse_v1.rs`), consuming the already-recorded `ShadowDecision` fields (`governorEffort`,
  `trace`, `effectiveSource`, `folded`) plus the deltas listed in §2; output is the
  `EffortProposal`. No Governor code or sources change; `sources_digest()` stays.
* **Host defence in depth (required, E-2 in the security review):** `EngineHost::accept` must refuse
  `Change(level)` when `level` equals the effort that would apply to the next attempt
  (`engine-effort-noop`), independent of the limiter.
* **Audit.** The rule that fired (`up`, `down-progress`, `down-confirmed`, `down-pending`,
  `hold-rearm`, `reset-evidence`, `noop`, `replay-guard`) is recorded in the retained decision history
  and in the `effort-selected` event detail (`limiter:<rule>`); `hold-rearm` and `noop` are recorded
  in the history only (they select nothing).
* **Persistence & validation.** The limiter state is part of the engine payload (still ≤ 16 KiB,
  `state_schema` bumped for `muse-v1`; the `muse-v1-shadow`/`-signals` schemas are untouched).
  `check_transition` refuses: `last_attempt` decreasing or beyond `dispatched+1`; `pending_down.attempt >
  dispatched+1` or `target ≥` effort in force or `∉ authorized`; `rearm_tokens_used > R` or decreasing;
  `trusted_since_down` set without `last_down_attempt`; any change not equal to the pure function of
  (previous state, this evaluation's recorded inputs) — the host recomputes `limit()` from the
  recorded decision and compares, exactly as `fold_signal` is recomputed for signals.
* **Replay / out-of-order.** Rule 0 plus the existing one-evaluation-per-attempt host rule; trusted
  evidence identity by `execution_id`/`seq`; claim identity by dispatch key and monotonic totals.
* **Restart / continuation.** The effort restarts at the default under the new binding (EM-03
  `effort-reset-continuation`); the limiter inherits `rearm_tokens_used` (a continuation must not
  reset the budget), clears `pending_down`, `last_down_attempt`, `trusted_since_down`, and restarts
  `last_attempt` with the new generation's attempt counter. The Governor's semantic and activity
  blocks (windows, processed ids) are inherited as in EM-04A.
* **Authorization.** Unchanged and unconditional: every `Change(e)` still requires `e ∈
  binding.supportedReasoning`, a Registry `issue-attempt` under the sealed binding, Kernel
  sealing, and a write-ahead `bind_attempt` before dispatch.
* **`requestMax`.** The limiter never outputs `max`; the model cannot request it; the Governor can
  only produce `max` from `requestMax`, which the signals path refuses.

## 6. Acceptance tests (exact)

### 6.1 Pure table tests (`engine/effort_limiter_tests.rs`, no node)

Inputs are `LimiterInput` literals, state is threaded explicitly.

| # | Case | Expected |
|---|---|---|
| T1 | `gov == cur` at every level | `KeepPinned`, `pending_down == None` |
| T2 | `gov > cur`, `!strong_escalation` | `Change(gov)` immediately, any pending cleared |
| T3 | first strong escalation (`last_down_attempt == None`) | `Change(gov)` |
| T4 | after a drop: claim-only strong escalation, `rearm_tokens_used = 0,1` | `Change(gov)`, tokens → 1, 2 |
| T5 | same, `rearm_tokens_used = 2` | `KeepPinned`, rule `hold-rearm`, state unchanged except `last_attempt` |
| T6 | same as T5 but `trusted_since_down = true` or `new_trusted_failures > 0` | `Change(gov)`, tokens unchanged, `trusted_since_down = false` |
| T7 | `gov < cur`, no evidence, first time | `KeepPinned`, `pending_down = {gov, n}` |
| T8 | next attempt `n+1`, `gov' < cur` | `Change(max(gov, gov'))`, `last_down_attempt = n+1` |
| T9 | next attempt is `n+2` (a skipped evaluation) | `pending_down` replaced, `KeepPinned` |
| T10 | pending exists, next attempt has `new_claim_units > 0` or `new_trusted_failures > 0` | `pending_down = None`, `KeepPinned` |
| T11 | pending exists, next `gov ≥ cur` | `pending_down = None` |
| T12 | `progress_edge`, no evidence, `gov < cur` | `Change(gov)` immediately |
| T13 | `progress_edge` together with new evidence | rule T10 (no immediate drop) |
| T14 | same `attempt` twice, or `attempt` smaller | second call is `KeepPinned`, state unchanged (`replay-guard`) |
| T15 | `gov ∉ authorized` or `gov == max` | rejected by the caller's validation; limiter never returns such a `Change` (`debug_assert` + test) |
| T16 | tie: two different lower decisions | applied target is the **higher** of the two, and is `< cur` |

### 6.2 Property tests (deterministic PRNG, ≥ 5,000 random traces of 60 attempts each)

For arbitrary `(gov, flags, evidence)` traces and any authorized set:
P1 `changes ≤ number of Governor up-moves + ⌈attempts / 2⌉`;
P2 no `A→B→A` with `B < A` unless `B` was confirmed by two consecutive distinct attempts or a progress edge;
P3 no escalation (`gov > cur`) is held when `!strong_escalation`, when it is the first strong
escalation, or when trusted corroboration exists;
P4 `Change(e)` implies `e ≠ cur`, `e ∈ authorized`, `e ≠ max`;
P5 claim-only strong re-arms applied per task ≤ `R`;
P6 idempotence: replaying any prefix of the trace with the same attempt numbers changes nothing
(`attempt` guard);
P7 the limiter is a pure function: equal inputs ⇒ equal outputs.

### 6.3 Pinned trace replay (regression of the numbers in §4)

Fixture `nexus-broker/tests/fixtures/em04c2-governor-traces.json`: for each of the 13 traces, the
per-attempt records `{effort, source, esc:[…], claim_delta, trusted_fail, root_edge, sol_edge}`
generated **from the real Governor** by a generator in `anti_thrash_review.rs` (extend `Sim`, already
there). Test asserts exactly the L3 column of §4: `(changes, xhigh_attempts, excess, held_up)` for every
trace. Also assert, for G1, G2 and P1–P4, that the limiter output equals the Governor's effort
sequence except where §4 lists `e > 0`. Fixture regeneration is a separate, reviewed command, never
part of the test run.

### 6.4 Host and state tests

H1 the host refuses `Change(e)` with `e == effort in force` (`engine-effort-noop`) and nothing is
   committed; H2 the retained history records `hold-rearm` and `noop` without an `effort-selected`
   event; S1 payload round-trip and 16 KiB bound with a full limiter state; S2 forged limiter state
   refused by `check_transition` (each invariant in §5), state unchanged; S3 crash before/after the
   durable `effort-selected` commit (fault points `before-accept`, `after-accept`): continuation
   clears pending/last_down, keeps tokens; S4 HMAC tamper refuses the continuation; S5 EM-03 records
   from `49026e8`, `50a24d7` still reopen byte for byte.

### 6.5 End-to-end on the mock provider (no paid inference)

E1 alternating phase signals for 24 attempts: ≤ 1 durable `effort-selected` event; every non-default
   attempt has a durable selection, a Registry issuance under the task binding and a Kernel seal
   before dispatch (existing EM-03 assertions). E2 six claim-only laps: at most `1 + R` `xhigh`
   selections. E3 laps with failing `cargo test` between claims: no `hold-rearm`. E4 default-only slot
   (`allowedReasoning` absent): no selection ever, every body `reasoning.effort == "low"`.
E5 continuation after a widened slot policy is refused (`task-binding-mismatch`, activation plan G-1).
