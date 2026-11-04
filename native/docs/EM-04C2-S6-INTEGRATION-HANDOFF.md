# EM-04C2 S6 — Integration handoff for the Effort Transition Limiter

Baseline `c292a0e0520d0a18e37e10cf156d721dfb25c6a6` (Checkpoint 1). Branch
`feature/native-muse-effort-limiter`. Uncommitted. Read together with
`EM-04C2-ANTI-THRASH-POLICY.md` (policy), `EM-04C2-ACTIVATION-PLAN.md` (step S6),
`EM-04C2-SECURITY-REVIEW.md` and `EM-04C2-S5-IMPLEMENTATION-REPORT.md`.

S5 delivered a pure component. **S6 consumes it; it must not redesign the policy or the
authorization semantics.** This document is the contract between the two.

## 1. What S5 provides (the surface S6 may call)

`nexus-broker/src/engine/effort_limiter.rs` (`pub mod effort_limiter`, no feature gate, no I/O):

| Item | Purpose |
|---|---|
| `limit(&LimiterState, &LimiterInput) -> Result<LimiterDecision, LimiterError>` | the policy; pure; `Err` = fail closed |
| `verify_transition(prev, input, action, next, max_attempt) -> Result<LimiterRule, LimiterError>` | the host's independent re-check of a recorded transition (§4) |
| `LimiterState` (+ `new`, `continued`, `validate`, `to_value`, `from_value`) | the five approved fields; ≤ 256 B encoded |
| `StateBounds` | what `validate` is judged against (level in force, authorized levels, host attempt counter) |
| `EvidenceBaseline` (+ `from_reasoning`, `delta_to`), `is_escalation_entry` | how the evidence counters are derived from the Governor's own output (§3) |
| `LIMITER_POLICY_VERSION = 1`, `DWELL_DECISIONS = 2`, `REARM_TOKENS = 2` | constants of the policy version — **not** environment-configurable |

Error codes (all fail closed; none selects an effort): `limiter-input-invalid`,
`limiter-state-invalid`, `limiter-transition-mismatch`, `limiter-invariant`.

## 2. The pipeline S6 must build, and where each authority sits

```
Governor decision (historical, unchanged, through the worker)
  → Registry-authorized effort clamp          (Governor `capabilities` = binding.supportedReasoning; downward-only)
  → Effort Transition Limiter                 (this module: KeepPinned | Change(level))
  → EngineExtension proposal                  (EffortProposal::Change(level) | KeepPinned; one level string, nothing else)
  → EngineHost::accept                        (id/revision, may_propose_effort, level ∈ authorized, engine-effort-noop, not with Finish)
  → durable selection                         (`effort-selected` committed BEFORE the broker asks the Registry)
  → Registry attempt issuance                 (`issue-attempt` under the SEALED binding; level ∈ binding.supportedReasoning)
  → Kernel seal + write-ahead `attempt-bound`
  → provider dispatch
```

* The limiter sits **after** the clamp and **before** the proposal. It sees `governor` already inside the
  authorized ladder (the Governor's `capabilities` argument is `snapshot.authorized_efforts`), and it
  re-checks that anyway (`check_input`).
* It outputs only a level the Governor proposed (this attempt, or — for a confirmed move down — the
  higher of two consecutive proposals). It cannot introduce a level, `max`, a model, provider, route,
  credential or permission: its interface has no vocabulary for them.
* Nothing downstream is relaxed. Every `Change` still needs host admission, a durable selection, a Registry
  issuance under the sealed binding, a Kernel seal and a write-ahead bind. A limiter bug can therefore
  produce *less* adaptation or a refused proposal, never an unauthorized request.
* `limit()` returning `Err` ⇒ **`KeepPinned`**, record `limiter-error:<code>` in the retained decision
  history, change nothing else. Never fall back to the Governor's raw effort.
* Governor outcomes other than `resolved` (`capability-unavailable`, a bridge error, an invalid answer)
  do **not** reach the limiter: `would = keep`, as in the shadow engine today. The limiter's state is
  untouched (no attempt consumed), so the next resolved evaluation is judged normally.

## 3. Deriving the `LimiterInput` (the only place judgement is needed)

All five inputs are derived by the **host from trusted material**, never from a model-supplied field.

| Input | Derivation in `BeforeRequest` | Source of trust |
|---|---|---|
| `attempt` | `snapshot.attempts_dispatched + 1` | Core counter |
| `governor` | the Governor's `decision.effort` (after its own clamp) | unchanged Governor |
| `current` | `snapshot.current_effort` (the pinned default before any selection) | EM-03 durable state |
| `authorized` | `snapshot.authorized_efforts` | sealed `TaskBindingV1.supportedReasoning` |
| `strong_escalation` | any entry of the **full** decision trace for which `is_escalation_entry` holds | Governor output |
| `new_claim_units`, `progress_edge` | `EvidenceBaseline::from_reasoning(previous block).delta_to(&EvidenceBaseline::from_reasoning(new block))` | Governor's semantic block (claims are model-authored but pass the Core's validator and carry replay-protected dispatch keys) |
| `new_trusted_failures` | number of freshly folded observations (`fresh` in `muse_v1::evaluate`) whose classification is `verification` with outcome `failed` | Kernel receipts folded by the Activity reducer; accepted only if `generation == s.generation ∧ seq > observed_through ∧ execution_id ∉ seen` |

Rules S6 must respect:

1. **Trusted vs claimed stays separate.** `new_trusted_failures` is computed from `snapshot.activity`
   (Core-derived from tool receipts and Kernel execution records). It must never be computed from
   `snapshot.signals`, from `signal-handled` events or from any model text. A model-authored event
   cannot impersonate a Kernel receipt because the two live in different snapshot fields with
   different producers; S6 must keep it that way (add a test that a signal carrying a "failed
   verification" shape changes `new_claim_units` but never `new_trusted_failures`).
2. **A baseline must be persisted with the limiter state — finding F-1.** Signals are folded into the
   Governor's block at tool-call time (`take_signals`), so the block read at `BeforeRequest` already
   contains the new claims; the delta cannot be recovered from the block alone. S6 must keep the
   `EvidenceBaseline` observed at the previous limiter evaluation (four values: `total_failures`,
   `conflicting_evidence`, `root_cause_established`, `solution_established`) **next to** the five
   `LimiterState` fields. This is a payload addition beyond the five approved fields; it needs the same
   `state_schema` bump, the same HMAC record and the same `check_transition` coverage (it must equal
   what the recorded Governor block yields). S5 deliberately did not invent a persistence format.
   The initial baseline is `EvidenceBaseline::default()` (the Governor's own initial state).
3. **The trace must not be the truncated one.** `ShadowDecision.trace` keeps 8 entries of 160 chars.
   Compute `strong_escalation` from the bridge answer *before* truncation, or record it as its own
   bounded field; otherwise a long trace could drop the `escalation:` entry.
4. **Evaluate once per attempt.** The host already admits at most one evaluation per consultation for
   attempt `dispatched + 1`; the limiter's replay guard (`n <= last_attempt`) is a second, independent line.
   A `ReplayGuard` result is recorded in the history only.
5. **The limiter state advances only when the Governor evaluation succeeded** (see §2); in that case the
   baseline advances too, in the same durable commit.

## 4. State, persistence and independent validation

* Store `LimiterState::to_value()` (camelCase, exactly five keys; the canonical form is pinned by the
  test `the_state_round_trips_and_stays_small`) plus the baseline inside the `muse-v1` engine payload.
  Reading must use `from_value` (strict: exact keys, exact types, never `max`, token budget respected).
  Do not add `serde` derives and do not tolerate unknown keys.
* `muse-v1` gets a **new `state_schema`**. The `muse-v1-shadow` / `muse-v1-signals` schemas and the EM-03
  record format are untouched; EM-03 fixtures from `49026e8` and `50a24d7` must still reopen byte for byte.
* `check_transition` for `muse-v1` must, for every evaluation it records:
  1. `LimiterState::validate(&StateBounds { current: <level in force after the decision>, authorized, max_attempt: Some(attempts_dispatched + 1) })` on the new state;
  2. rebuild the `LimiterInput` from the **recorded** Governor decision, recorded observations and the
     previous baseline, and call `verify_transition(prev, &input, recorded_action, &next, max_attempt)`.
     The host therefore never trusts the engine's claim about what the policy decided; it recomputes
     it with the same pure function (the same pattern as `fold_signal`).
  3. refuse any limiter or baseline change that arrives without a matching recorded evaluation.
* Audit: write `limiter:<rule>` (`LimiterDecision::detail()`) in the `effort-selected` event detail for
  every `Change`; record `hold-rearm`, `noop`, `down-pending`, `reset-evidence` and `replay-guard` in the
  retained decision history only (they select nothing).

## 5. Continuation — preserving the budget, resetting generation-local fields

On a continuation the engine must replace the previous generation's state with
`previous.continued()`:

| Field | Continued | Why |
|---|---|---|
| `rearm_tokens_used` | **kept** | the budget is per **task**; a restart must not refill it |
| `pending_down` | cleared | refers to an attempt of the previous generation |
| `last_down_attempt` | cleared | generation-local attempt numbers |
| `trusted_since_down` | cleared | the previous generation already weighed it |
| `last_attempt` | `0` | the new generation's attempt counter restarts |
| baseline | **kept** (it describes the inherited Governor block, which EM-04A also inherits) | otherwise the first evaluation would count the whole history as new claims |

The effort itself restarts at the pinned default (`effort-reset-continuation`, unchanged).
Consequences, tested in `continuation_keeps_the_per_task_budget_and_resets_generation_local_fields`:
the first strong escalation of a new generation is free (no drop yet in this generation), and after the
generation's first drop an exhausted budget still holds claim-only re-arms.

**Residual (finding F-2, accepted by the approved policy, recorded for the reviewer).** Because
`last_down_attempt` is cleared, each continuation gives the model one free strong escalation. A
continuation requires an interruption and a host/operator action, so this is not model-triggerable, and
the escalation remains bounded by the operator's `allowedReasoning`. Closing it fully would need a
sixth persisted field (`dropped_before: bool`, carried across continuations); that changes the approved
state contract and is **not** done here.

## 6. Tests S6 must add (in addition to the S5 suites, which must keep passing unchanged)

Policy §6.4 H1–H2 and S1–S5, plus:

| # | Test |
|---|---|
| L-1 | the strong-escalation flag is computed from the untruncated trace (a trace whose `escalation:` entry is the 9th still counts) |
| L-2 | a signal that *claims* a failed verification moves `new_claim_units` only; a Kernel-verified failed check moves `new_trusted_failures` only |
| L-3 | the baseline survives persist/restore and continuation and is validated by `check_transition` against the recorded Governor block |
| L-4 | `limit()` error ⇒ `KeepPinned` with a history record; no state change, no `effort-selected` |
| L-5 | a forged limiter state (each invariant of `validate`) and a forged transition (`verify_transition`) are refused and nothing is committed |
| L-6 | E2E on the mock provider: policy §6.5 E1–E5; every non-default attempt has `effort-selected` → Registry issuance → Kernel seal **before** the provider request |
| L-7 | `muse-v0` request bodies stay byte-identical (the C1 dump harness) and the pinned traces still pass |

## 7. Non-negotiable boundaries for S6

* No change to the Governor, Runtime, Activity or Signals sources; `sources_digest()` unchanged.
* The limiter's constants stay constants of `LIMITER_POLICY_VERSION`. Changing a constant or the algorithm
  is a new policy version, a new `state_schema` and a re-pinned fixture (a reviewed action).
* Do not let the limiter, the host or the engine choose a model, provider, route, credential or permission,
  and do not widen what `EffortProposal` can carry.
* `requestMax` stays unreachable; the limiter refuses `max` even when it is authorized.
* No new persistence system; no environment variable or global flag for any limiter parameter.
* Do not regenerate `tests/fixtures/em04c2-governor-traces.json` to make a test pass. A diff in the
  `attempts` blocks means the Governor changed; a diff in the `l3` blocks means the policy changed.
