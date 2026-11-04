# EM-04C2 S6 — Active Muse v1 integration: implementation report

> **Superseded identity (S9.5, commit `b3244c0`):** the adaptive engine described here as `muse-v1` is now **`nexus-adaptive-v1`** (mode `engineering-v2-adaptive` is unchanged). The old id is not an alias anywhere. This document is kept as written; see `EM-04C2-S95-IDENTITY-MIGRATION.md`.


Baseline `34d84756c5390ac147180a45896e2d6bf8c8f1c6` (S5, committed). Worktree
`~/Projects/Nexus-muse-v1-integration`, branch `feature/native-muse-v1-integration`. **Uncommitted.**
Companions: `EM-04C2-S6-AUTHORIZATION-AND-RECOVERY.md`, `EM-04C2-S6-POLICY-V2-VALIDATION.md`,
`EM-04C2-S7-S10-HANDOFF.md`. The S6 handoff of S5 is superseded where this report says so (F-2).

## 1. Outcome

The active `muse-v1` EngineExtension exists, is fully tested on the mock provider and through the real
durable EM-03 machinery, and is **not reachable by any user**: it is registered only in `test-engines`
builds, the mode is dormant, and an adaptive run refuses to dispatch without a Registry-sealed request
budget. `muse-v0` is untouched.

```
Governor → authorized clamp → Limiter (Policy V2) → EngineExtension proposal → host admission
  → durable effort selection → Registry issuance → Kernel seal → write-ahead bind → provider dispatch
```

## 2. What changed (11 modified, 5 new files, +1,294 / −102 before new files)

| File | Change |
|---|---|
| `nexus-broker/src/engine/effort_limiter.rs` | **Policy V2**: `LimiterStateV2` (+ `dropped_before`), `limit_v2`, `verify_transition_v2`, `continued`/`continued_after_reset`, strict 6-key codec; the S5 algorithm is refactored into one shared `step` (V1's public behaviour is unchanged) |
| `nexus-broker/src/engine/muse_v1_adaptive.rs` (new) | `Adaptive` (limiter + `EvidenceBaseline` + `pending_trusted`), `LimiterRecord`, `evaluate_limiter`, `check_adaptive`, F-3 helpers (`strong_escalation_of_decision/_block`) |
| `nexus-broker/src/engine/muse_v1.rs` | `MUSE_V1_ACTIVE` (`muse-v1`, mode `engineering-v2-adaptive`, schema 2, `may_propose_effort`); adaptive branches in `evaluate`, `take_signals`, `propose_with`, `check_transition`, `restore`; `check_effort`, `effort_detail`, `requires_sealed_request_budget`, `restore_state_in`; shadow/signals engines byte-identical in behaviour and persisted form |
| `nexus-broker/src/engine/mod.rs` | additive trait methods (`restore_state_in`, `check_effort`, `effort_detail`, `requires_sealed_request_budget`) with defaults; `RestoreContext`; `engines_with`; catalog row for `muse-v1`; `check_effort` call in `accept` |
| `nexus-broker/src/engine_state.rs` | `examine_predecessor` passes the predecessor's selection to `restore_state_in`; `effort-selected` carries `limiter:<rule>` |
| `nexus-broker/src/inspect.rs` | sealed-budget gate in `engine_for_run`; the Governor worker is lent to `muse-v1` |
| tests: `effort_limiter_v2_tests.rs`, `muse_v1_active_tests.rs` (new); `catalog_tests.rs`, `tests.rs` (deliberate EM-01 "reserved id" updates), `anti_thrash_review.rs`/`effort_limiter_tests.rs` (visibility of test helpers only), `code_a56.rs` (+7 E2E, 1 updated), `nexus-daemon/tests/e2e/driver.cjs` (optional expected revision for a configuration re-save) |

Untouched, byte-identical to the baseline: the four historical CommonJS sources and `muse_bridge*.cjs`,
`muse_v0.rs`, `governor_bridge.rs`, `worker_bridge.rs`, Kernel, contracts, tools, client, model, Registry
(JS), the common EM-03 record format and schema version, and the S5 fixture.

## 3. F-1 — durable `EvidenceBaseline` (`muse_v1_adaptive.rs`)

* `Adaptive { limiter, baseline, pending_trusted }` is persisted under `payload.adaptive` as ONE block
  `{policyVersion: 2, limiter{6 keys}, baseline{4 keys}, pendingTrusted}` in the same EM-03 revision
  as everything else (there is no second store). The new `muse-v1` payload is `state_schema 2`; the
  shadow/signals schemas and the EM-03 record format are untouched.
* Initial baseline = the Governor's default state (`EvidenceBaseline::default()`).
* **Advanced only by a judged evaluation**: a limiter error, a replayed attempt, a failed/invalid Governor
  answer or a capability refusal leave it where it was, so the evidence is judged by the next attempt
  (tests: worker failures ×4 codes, replay, invalid answers).
* Claim evidence = `previous durable baseline → validated reasoning block` (`delta_to`); replayed signals are
  `duplicate`s that leave the historical totals unchanged, hence yield no delta.
* The host re-derives and compares everything before commit (`check_adaptive`; AUTH doc §3).
* Restored across crash/restart and continuation (`unversioned_or_foreign_adaptive_payloads_are_refused`,
  `the_baseline_and_limiter_survive_persistence_and_continuation_together`); a baseline ahead of the
  Governor's totals is refused.

## 4. F-2 — Policy V2 (`effort_limiter.rs`; evidence in the Policy V2 validation doc)

`dropped_before` (logical-task flag, monotonic), tokens and flag inherited, generation-local fields reset,
an elevated effort silently reset to the default counts as a drop, trusted evidence still bypasses the
budget, R = 2 per logical task, an unchanged level never yields a `Change`. S5's V1 tests and fixture are
kept as historical regression evidence and **not rewritten**. Real engine, 8 generations of the same claims:
`xhigh` is applied in exactly three (1 free + R).

## 5. F-3 — the complete Governor result

`strong_escalation_of_decision` examines every entry of the full trace (≤ 32 entries, ≤ 512 bytes each —
a real Governor emits ≤ 5); anything outside the bounds, any non-string entry, an escalation the Governor's own
condition over the returned block does not justify, or a missing one, rejects the whole evaluation
(`bridge-output-invalid`, nothing judged or consumed). `ShadowDecision.trace` (8 entries) stays an audit
copy and is never read for the decision. Tests in the Policy V2 validation doc §3.

## 6. The engine

* Identity `muse-v1`, mode `engineering-v2-adaptive`, role `muse_main`, `inherits_state`, schema 2,
  `request_reserve_bytes 0` (the signals tool is in the measured catalog), `may_propose_effort true`.
* Strategy = `muse-v0`'s (guidance/finish, delegated decision for decision); Governor/Signals via the hardened
  supervised worker (`inspect.rs` lends it to `muse-v1` exactly as to the experimental engines); no
  Registry/Kernel/provider credential reaches the worker (S1 isolation unchanged).
* Tool catalog: `tool_catalog_profile("muse-v1", code_run)` → `RepoCodeMuseSignalsV1` (frozen digest
  `5f7d19e2…`); no direct effort selector exists anywhere; `requestMax` stays refused by the Core validator
  and, defence in depth, `max` is never applied by the limiter even if the binding authorizes it
  (`a_governor_max_is_never_applied_even_when_the_binding_authorizes_it`).
* `Change(e)` is produced only when the limiter approves an authorized new effort; every other outcome —
  failed/invalid Governor, limiter error, replay, hold, noop — is `KeepPinned`; there is no fallback to an
  unchecked effort anywhere.

## 7. Findings

| ID | Finding | Disposition |
|---|---|---|
| F-4 | **Trusted failures can be folded by the signal path.** `take_signals` folds Kernel-verified observations that precede the newest signal, so at the next `BeforeRequest` they are no longer "fresh"; counting only fresh failures (as S5's trace model did) would hide a legitimate failed check behind any signal call — the commonest ordering. | Fixed by a fourth durable field, `pending_trusted` (bounded 1,000, derived by the host from `snapshot.activity`, consumed only by a judged evaluation). It extends the owner-approved four-value baseline; **needs explicit acknowledgement**. |
| F-5 | The Governor never yields `low`, so its first evaluation raises `low → medium`; under the approved wording any interruption after attempt 1 resets an elevated effort and is therefore a drop: after the first interruption a claim-only `xhigh` costs a token. | Implemented literally; softer definition (elevated = above the Governor floor) is a policy decision, not taken. See AUTH doc §4. |
| F-6 | A capability refusal (default-only slot) runs the Governor but not the limiter; baseline does not advance, trusted failures stay pending. | Harmless in that configuration (the effort can never change); documented. |
| F-7 | `check_transition` cannot call the Governor. The recorded strong flag is verified against the Governor's own condition over the validated block (differentially tested), not by re-running it. | Mitigation, recorded as a residual risk. |
| F-8 | The S6 handoff of S5 said a continuation grants one free strong escalation. | Superseded by F-2/Policy V2. |
| F-9 | `MuseV1State` grew; clippy `large_enum_variant` on `EngineStateData` is allowed with a justification (one value per run, never in a hot path). | Reviewer may prefer boxing. |

## 8. Security posture and remaining risks

See AUTH doc §6. In short: worker OS confinement remains an open gate; provider behaviour under mid-conversation
effort changes is unobserved; F-4/F-5 need owner decisions; the activation constant is closed.

## 9. Validation (summary; details in the companion documents)

* Focused: limiter V1 29 / V2 10 / engine 23 / E2E 7+1 — all green; mutation checks for each new rule.
* Existing EM-01/02/03/04A/04B contracts, parity and recovery suites, Registry mode/issuer: in the battery.
* Production gate: a release crate **without** `test-engines`: `muse-v1` (either mode), `muse-v1-shadow`,
  `muse-v1-signals`, `effort-test-v0` → `engine-unavailable`; `muse-v0` OK; `muse-v0` in the adaptive mode →
  `engine-mode-mismatch`; no `test_faults`/`test_engine` symbols in the binary.
* Tauri: 27 passed, 0 failed, 2 ignored (same as the baseline).
* fmt, strict clippy: clean.
* Full offline workspace battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`, final tree): **1,215 passed, 0 failed, 57 ignored** (S5: 1,175/0/57; +40 = the new tests). One green battery; two consecutive are an S10 requirement. The historical sandbox failure is not claimed eliminated.
* JS: 41 suites (`MuseReasoning*`, `MusePreset*`, `Registry*`, `Native*`): 21 pass / 20 fail, **the identical pass/fail set as the S5 tree** (checked file by file). The 20 failures are environmental and pre-existing (missing `@deepseek-ai/dsh-tools` and `pwsh`) and are NOT reported as green; no failure is attributable to S6 (the only JS touched is a test-driver option).

## 9a. Owner decisions recorded at approval

* **F-4 approved:** `pending_trusted` stays a separate durable field in the versioned adaptive payload; host-derived from Kernel-backed receipts only, bounded, replay-safe, independently validated and persisted atomically with the baseline and `LimiterStateV2`.
* **F-5 approved:** "elevated" means strictly above the pinned task default; an interruption that resets an elevated effort is a drop. Not to be redefined (e.g. above `medium`) without new evidence.
* **F-7 accepted residual risk:** trusted-worker model with digest-pinned Governor sources and strict output validation; the host does not execute the full Governor algorithm for each transition. Registry authorization, limiter verification and Kernel sealing remain mandatory.
* **Worker confinement:** the single-user trusted-worker model with enforced Node permissions is accepted for this milestone; no new sandbox architecture. This does not authorize multi-tenant deployment.

## 10. Recommendation

**APPROVE** for review and a local commit of S6, with conditions: (1) acknowledge F-4 (`pending_trusted`, a fourth durable field) and decide F-5; (2) the activation constant stays `false` and the mode dormant until S10; (3) S7–S10 as in `EM-04C2-S7-S10-HANDOFF.md`, including two consecutive green batteries on the final commit and the open worker-confinement decision. Evidence: the adaptive engine executes authorized effort transitions on the mock provider through durable selection, Registry issuance and Kernel seal before every request; limiter and evidence baseline are re-derived by the host from independent inputs; Policy V2 closes the continuation loophole (1 free + R=2 over any number of generations); `muse-v0` behaviour and bodies are unchanged; no incomplete adaptive mode is dispatchable (compile-time gate, closed Registry table, dormant definition, operator configuration and the new sealed-budget gate).

## Erratum (added in S7–S9)

The JS line of §9 ("the identical pass/fail set as the S5 tree") shares the error described in
`EM-04C2-CHECKPOINT-1-REPORT.md`: S5 and S6 were compared with Checkpoint 1, which already contained seven real
JS regressions from S4. They are fixed in S7–S9. The installation statement in
`EM-04C2-S6-AUTHORIZATION-AND-RECOVERY.md` §1 (gate 2) is superseded by owner decision D-1: installations carry the
dormant definition.
