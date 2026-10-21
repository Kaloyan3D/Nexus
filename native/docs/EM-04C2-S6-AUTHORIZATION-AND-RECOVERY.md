# EM-04C2 S6 — Authorization chain, activation gates and recovery

Baseline `34d84756c5390ac147180a45896e2d6bf8c8f1c6` (S5). Branch `feature/native-muse-v1-integration`.
Uncommitted. Code references are to this worktree. Companions: `EM-04C2-S6-IMPLEMENTATION-REPORT.md`,
`EM-04C2-S6-POLICY-V2-VALIDATION.md`.

This document answers two questions: **who can make an adaptive run change its reasoning effort, and
what stops each of them?**, and **what is the durable state after a crash at each transaction
boundary?**

## 1. The five activation gates (kept separate on purpose)

An adaptive run needs ALL of them; every one is independently enforced and independently tested.

| # | Gate | Enforced by | Today | Test |
|---|---|---|---|---|
| 1 | The engine is compiled into the production-capable runtime | `engine::engines_with` (`engine/mod.rs:481`): `muse-v1` is registered only if `test_build ∨ MUSE_V1_PRODUCTION_ENABLED`; the constant (`mod.rs:66`) is compile-time, **false**, and is not a runtime switch. `muse-v1-shadow`, `muse-v1-signals` and `effort-test-v0` are registered **only** in `test-engines` builds, whatever the constant says | closed | `the_production_gate_registers_only_muse_v1_and_only_when_opened`; release crate without `test-engines`: 9/9 pairs as expected (`muse-v1` in either mode → `engine-unavailable`) |
| 2 | The engine is in the Registry's closed mode mapping | `NATIVE_SCOPES` (`config/registry/native-issuer.cjs`, S4): `engineering-v2-adaptive → muse-v1` only; `engine::resolve` additionally requires `mode ∈ descriptor.mode_ids` (`["engineering-v2-adaptive"]`) | table entry exists; mode shipped `planned`, non-selectable, non-runnable, absent from the installer closure | S4 suites + `the_registry_selected_mode_resolves_to_its_extension_and_anything_else_fails_closed` |
| 3 | The operator configured the mode | The Registry refuses to compile a selection without a **saved** ModeConfiguration (`registry-mode-configuration-required`); nothing is ever auto-created | none exists | `s4_the_adaptive_mode_needs_a_saved_configuration_and_a_sealed_budget_to_dispatch` |
| 4 | The mode is fully authorized: effort policy **and** sealed request budget | models scoped to `muse-v1`; slot `allowedReasoning` (default-only is legal and never adapts); and **the new S6 gate**: `engine_for_run` (`inspect.rs:1548`) refuses an engine whose `requires_sealed_request_budget()` is true when the sealed resolution carries no `requestBudgetBytes` → `engine-budget-required`, before the run is bound to the engine, before any Kernel lease, engine state, working copy or request | **not met**: the shipped definition declares no budget (S7) | same test: 0 provider requests, 0 turns, no worktree, no engine state file |
| 5 | An actual run dispatch | EM-02/03: per-attempt Registry issuance under the sealed binding → Kernel seal → write-ahead bind → provider request | only reachable once 1–4 hold | `s6_an_adaptive_run_changes_effort_only_through_registry_and_kernel_before_each_request` |

A default selection (no `modeId`) still resolves to `engineering-v2` + `muse-v0`; this is asserted in the
same S4 test (4: reasoning `low`, catalog digest `58f513de…`), in the unchanged C1 byte-identity suite and
in the battery. No global flag, no new default, no auto-created configuration.

**Minimum additional gate required before real users — answered.** The S4 contract alone could not stop a
fully-configured-but-budgetless adaptive mode once the engine exists: the Registry accepts a mode with no
`requestBudgetBytes` (it is optional for `muse-v0`). Gate 4's runtime refusal is the minimum addition. It is
engine-declared (a trait method with default `false`), so it cannot affect any other engine.

## 2. Who can change an adaptive run's effort

```
Governor (historical, unchanged, in the Node worker; stateless; empty env; no fs/net authority of its own)
  └─ resolved effort, clamped DOWN to snapshot.authorized_efforts      <- sealed binding's supportedReasoning
      └─ Effort Transition Limiter, Policy V2 (pure; keep or one of the Governor's own levels)
          └─ EngineProposal { effort: Change(level) | KeepPinned }     <- the only effort vocabulary
              ├─ EngineHost::accept: may_propose_effort, level ∈ authorized, no Finish, not already in force
              ├─ check_transition: state re-derived from INDEPENDENT inputs           (§3)
              ├─ check_effort: the effort equals the decision the validated state records
              └─ commit  ->  durable `effort-selected` (detail `limiter:<rule>`)  BEFORE the Registry is asked
                  └─ Registry issue-attempt under the SEALED binding (level ∈ binding, identity digests pinned)
                      └─ Kernel seal / accept / dispatch-authorize (single-use grant bound to the target)
                          └─ write-ahead `attempt-bound`  ->  provider request
```

| Actor | Can it change the effort? | What stops it |
|---|---|---|
| The model | No. It can only send validated **claims** (`muse_update_reasoning_state`): closed schema, no effort/`requestMax`/model/provider fields (Core validator `signals::validate`, historical validator behind it) | claims move the Governor's counters; the limiter decides; a claim never counts as trusted evidence (`pending_trusted` and `trusted` come only from `snapshot.activity`, Core receipts) |
| The Governor / worker | It proposes a level; it cannot apply one. A killed, slow or lying worker yields `KeepPinned` | strict response validation (`adaptive_response_ok`), complete-trace bounds (F-3), the Governor-condition cross-check, the worker's own isolation (S1) |
| The engine (built in) | Only via the limiter's decision, and only what the host re-derives | `check_adaptive` + `check_effort` + the generic host rules; 15 forged proposals/states refused in `forged_proposals_and_states_are_refused_and_nothing_is_committed` |
| The limiter | Only a level the Governor proposed, never `max`/unauthorized/redundant | double output guard in `limit`'s `out()`; host `engine-effort-noop`/`-not-authorized`; hard `Err` on invalid input |
| The operator | Through the Registry only (slot policy); a change between interruption and continuation is `task-binding-mismatch` before any request | S3 identity v2 (`s6_a_changed_slot_policy_on_an_adaptive_continuation_fails_before_dispatch`) |
| A client | Can name `modeId` (bounded, closed set) — nothing else about reasoning | S4 selection grammar |

Nothing in this chain can choose a model, provider, route, credential or permission: `EffortProposal`
carries one level string; the Registry's `issue-attempt` accepts `requestedEffort` only and rejects
anything outside the sealed binding; the identity digest pins model/route/provider/connection/credential
reference/default effort/request budget/allowed reasoning.

## 3. What the host re-validates before committing (`check_transition` / `check_effort`)

For every transition `from -> to` of the active engine (`muse_v1.rs` `check_transition` →
`muse_v1_adaptive::check_adaptive`):

| Check | Independent source |
|---|---|
| exactly one evaluation, for attempt `attempts_dispatched + 1`, describing the effort in force | `snapshot` (Core counters) |
| trusted failures folded by this transition | `snapshot.activity` (Core receipts) filtered by the two states' frontiers — **not** the engine's claim |
| claim units / progress edge | previous **durable** baseline vs the new validated reasoning block |
| `strong_escalation` | recomputed from the new reasoning block with the Governor's own condition (`strong_escalation_of_block`, differentially tested against the real Governor on 400 random blocks and the 13 traces); the recorded flag must match |
| the limiter decision | `evaluate_limiter` re-run on those inputs must reproduce the recorded record, rule, action **and** both new states; then `verify_transition_v2` is run a second time on the judged decisions |
| baseline / pending-evidence movement | unchanged without an evaluation; advanced only by a judged, non-replayed evaluation; carried (never lost) otherwise |
| limiter-state invariants | `LimiterStateV2::validate` against the effort in force **after** the decision and `max_attempt = attempts_dispatched + 1` |
| the proposed effort | `check_effort`: equals the recorded decision's `change:<level>`, or `KeepPinned` — a proposal the audit trail does not justify is `engine-effort-unjustified` |
| policy version / schema / unknown keys | strict decoders (`Adaptive::from_value`, `LimiterRecord::from_value`); `state_schema = 2` (`admit_next_state`); policy `2` or the record is refused |
| continuation | `examine_predecessor` (engine, mode, contract, schema, HMAC) + task-binding identity v2 (mode, engine, slot policy) judged before engine selection |

**Honest limit.** `check_transition` has no Governor handle, so it cannot re-run the Governor; the host
therefore relies on (a) the cross-check of the recorded flag against the Governor's own condition over the
validated block, (b) the unchanged-sources digest recorded with every evaluation (`sourcesDigest`, pinned
by tests against the files on disk), and (c) the differential tests. A forged *Governor effort level* that
is still authorized and consistent with its own record cannot be detected by the host, but cannot do more
than the Governor itself could: it still passes the limiter, the clamp, Registry and Kernel.

## 4. Continuation semantics and the F-2 / EM-03 conflict analysis

EM-03 continuation = a NEW task generation: new task binding, new issuance, `effort: None` (restart at the
default), `effort-reset-continuation` event when the predecessor's selection differed from the default,
payload inherited only through the engine's `restore_state`, attempts restart at 1.

Potential conflicts examined before wiring the engine, and how they are resolved:

| Edge | Conflict | Resolution |
|---|---|---|
| `restore_state(payload, revision)` has no access to the predecessor's selection, but the reset must count as a drop | the engine cannot know whether the effort was elevated | **additive** trait method `restore_state_in(payload, revision, &RestoreContext)`; `examine_predecessor` passes the predecessor's last committed selection and default effort. Default implementation = `restore_state`, so every other engine is byte-for-byte unchanged. No durable-record change |
| "effort in force" at interruption | the selection committed for attempt *k* may never have been dispatched | the committed selection is what the limiter's own state reflects (they are staged and committed together), so it is the correct "in force" value; test `a_crash_after_the_durable_selection_before_the_binding_is_a_clean_continuation` |
| `last_attempt` and the new generation's attempt counter | counters restart at 1 | `continued()` sets `last_attempt = 0`; the replay guard is generation-local by construction |
| the Governor block inherited with `failedHypotheses ≥ 2` | the new generation immediately wants `xhigh` again | by design: that is the A4 loop; it now costs a token (`a4_claim_only_re_arming_is_bounded_across_generations`: 1 free + R = 2, then held, over 8 generations) |
| an elevated effort that cannot be compared (unparseable level) | cannot decide whether it was a drop | treated as a drop (fail closed) |
| an interruption when nothing was elevated | no drop, privilege intact | `an_implicit_reset_is_a_drop_recorded_in_the_continuation` (second half) |
| a record of another policy version or without the adaptive block | would be silently reinterpreted | refused (`engine-state-corrupt`); no migration exists or is needed |

**Consequence worth reviewing (finding F-5).** The historical Governor never yields `low`: its first
evaluation of any task raises `low → medium`. So *any* interruption after the first attempt resets an
elevated (above-default) effort and therefore counts as a drop. The "free first strong escalation"
survives only if it happens in the first generation before any interruption; afterwards claim-only
`xhigh` costs a token (2 available), then is held until a Kernel-verified failure. This follows the
approved wording ("above the pinned default") literally. A softer definition (elevated = above the
Governor's floor `medium`) is a policy decision, not made here.

## 5. Recovery matrix (durable state after a crash)

Fault points are the existing EM-03 test hooks (`engine/test_faults.rs`); each row is an executed test.

| Crash at | Durable state | Next run (continuation) | Test |
|---|---|---|---|
| before any commit of an evaluation that selects nothing | the previous commit; the evaluation and its judged evidence are **not** durable | the same evidence is judged exactly once by the continuation (baseline not advanced) | `a_crash_before_any_commit_loses_the_evaluation_and_the_continuation_redoes_it_identically` |
| after the proposal is accepted and the `effort-selected` event is committed (`after-accept`) | selection + limiter/baseline in one revision; no issuance, nothing sent | restarts at the default; the elevated effort is a drop; the same claims cost exactly one token | `s6_a_crash_after_the_durable_selection_never_duplicates_or_misapplies_it` |
| after Registry authorization (`after-authorize`) | same; the issuance is derived from the sealed binding and re-derivable | same | same |
| after the write-ahead bind (`after-bind`) | attempt `bound`, never re-sent (`predecessor-attempt-unresolved` note) | same; no ordinal bound twice | same |
| signal acceptance (`persist-signal`) | the signal is neither acknowledged nor counted | the continuation re-derives from its own validated signals; evidence neither lost nor invented | `s6_a_crash_around_signal_acceptance_never_loses_or_invents_evidence`, `a_signal_whose_commit_fails_is_not_acknowledged_and_changes_no_durable_evidence` |
| Governor worker killed / timed out / busy during evaluations | decision recorded with the bridge code; limiter, baseline, pending evidence **unchanged** | the SAME claims and the SAME failed check are judged when the Governor answers (not lost, not doubled) | `a_failing_worker_never_bypasses_the_limiter_and_loses_no_evidence` (4 failure codes), `s6_a_worker_killed_repeatedly_cannot_bypass_the_limiter` |
| a retried preparation of the same attempt | second evaluation = `replay-guard`; evidence stays pending; no second selection | — | `a_replayed_attempt_is_judged_once_and_consumes_no_evidence` |
| a record tampered with / another version / not authentic | refused before dispatch (EM-03, unchanged) | — | existing EM-03 suites (in the battery) |

Every request in every run carries exactly the effort its own record bound for that attempt; the Kernel
accepted exactly the bound attempts under the targets the record names (shared assertions of
`s6_crash_then_continue`).

## 6. Remaining security risks (not closed by S6)

1. **Worker OS-level confinement** (open review gate from Checkpoint 1): the worker is defence-in-depth
   (Node permission mode), not a sandbox; the network is unrestricted. The adaptive engine adds nothing
   the worker can read or write, but the gate remains open.
2. **The host cannot re-run the Governor** inside `check_transition` (§3). Mitigated, not eliminated.
3. **Provider behaviour when `reasoning.effort` changes mid-conversation with replayed encrypted
   reasoning** (policy risk R3) is unobserved: only the mock provider was used.
4. **F-5** (every post-interruption claim-only escalation costs a token) may feel strict in practice;
   F-4 (below) adds a fourth durable field beyond the four-value baseline the owner approved.
5. The activation constant must be flipped (S10) together with the installer-closure change and the
   final documentation; until then no user can reach the engine.
