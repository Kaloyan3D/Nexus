# EM-01 — Native EngineExtension foundation (contract v1)

Status: implemented on `feature/native-engine-extension` (base `a497b87`, the P0 reliability
head). **Uncommitted, awaiting independent architectural review.** No paid inference was used.

Scope: one versioned seam between Engineering Mode *strategy* and Native Core *execution*,
plus one adapter (`muse-v0`) that reproduces today's Native behaviour exactly. Nothing new is
activated: no governor, no adaptive effort, no `muse_update_reasoning_state`, no EMv1/EMv3/CCv2,
no new route or model, no engine-state persistence.

> **`muse-v0` is a Native compatibility adapter, NOT EMv2 parity.** It is the strategy the
> Native generic turn loop already applied, moved behind the boundary unchanged. The Muse
> Reasoning Governor remains **inactive**; see §4.1 for what `muse-v0` is not.

## 1. Authority model

| Authority | Owns | Engine may |
|---|---|---|
| Registry | mode → engine, provider, model, route, connection, **reasoning effort** (the run's issued target; `target.reasoning` is inside the digest-covered, Kernel-sealed content) | read nothing of it; propose `KeepPinned` only |
| Kernel | issuance seal, per-attempt intent/grant validation against the sealed issuance, permissions | nothing |
| Native Controller task (bridge `task-create`) | task / attempt identity and the ledger | nothing |
| Native completion policy (Core: `completion::decide_run`, receipts-based verification verdicts) | the run's completion and verification outcome | propose `Finish`; never decide completion or verification |
| Core | transport, tools and their schemas, sandbox, approvals, durability, credentials, request classification (`completion::expects_change`) | nothing; the engine holds no handle |
| Engine | strategy: whether a reply without a tool call ends the turn, bounded guidance to the model, its own revisioned state | propose; the host validates before any effect |

The engine is a pure function of `(hook, snapshot, own state)`. It sees **receipts** recorded by
the Core (counts, last verification verdict, names of files the run created), the Core's
classification of the request (`expects_change`, `carried_work`) and the text of the reply the
hook is about. It never sees credentials, the target, grants, paths outside the run's own
created files, or the tool catalog. Its non-test code imports only `super::*` (the contract)
and pure text classifiers/message constants of `crate::completion` (`plan_like`,
`announcement`, `text_tool_calls`, `normalize_narration`, `repeated_narration`,
`steer_message`, `MSG_*`, `MAX_*`, `STEER_EVERY`) — never `decide_run`, the Kernel, tools,
transport, store or Registry; `resolve_issued` additionally parses `nexus_contracts`'s
resolution type (read-only).

### 1.1 Native completion policy is not the DSH Controller

The historical DSH path is governed by the PowerShell `TaskController` / `AihController.cjs`
control plane (requirements traceability, controller-planned verification and review,
engineering-failure classification, `Test-AihTaskCompletion`). **None of it is on the Native
path**, before or after EM-01 (parity audit, `NEXUS-DSH-NATIVE-PARITY-AUDIT.md` §A). Native's
completion is the broker's own receipts-based policy (`completion::decide_run`, failing-checks
gate, `CodingOutcome`) — honest but narrower. EM-01 does not change it, does not move it into
the engine, and does not pretend it is the Controller: the engine's `Finish` only means "no
reason to keep the model working"; the Native completion policy then decides the outcome.
Restoring Controller authority (command/ack bridge, A0.3 §5.9) is a separate milestone.

## 2. Contract (`native/nexus-broker/src/engine/mod.rs`)

- `ENGINE_CONTRACT_VERSION = 1`; any change of the types below bumps it.
- `EngineDescriptor { engine_id, contract_version, mode_ids, roles, state_schema, may_propose_effort }`
  — `roles` lists Registry internal roles (single-role in v1, list-shaped for multi-role engines).
- Hooks: `BeforeRequest`, `AfterToolPhase`, `FinalResponse`.
- `EngineSnapshot` — read-only receipts (see §1).
- `EngineAction`: `Continue | Guide(Guidance) | Finish | RequestVerification | AskOperator | RequestChildRun`.
  The last three are **declared but never admitted** in v1 (reserved for Controller-run
  verification, operator questions and EMv3 child runs), so later contracts extend an existing
  vocabulary instead of reshaping it.
- `Guidance { message ≤ 2048 B, reason ≤ 200 B, kind: Nudge|Steer, ordinal ≥ 1 }`.
- `EffortProposal`: `KeepPinned | Change(level)`; `Change` is always refused in v1.
- `EngineState { engine_id, schema, revision, data: EngineStateData }` — typed per engine
  (`EngineStateData::MuseV0`), ≤ 16 KiB.
- `EngineProposal { proposal_id, based_on_revision, action, effort, next_state }`.
- `trait EngineExtension { descriptor, initial_state, propose, check_transition }`.
- `resolve(mode_id, orchestration_engine_id)` — compiled-in engines only (no runtime
  registration). Refusals: `engine-unavailable`, `engine-mode-mismatch`,
  `engine-contract-mismatch`. Ids are sanitized before they reach a message.
- `EngineHost` (one per run): `consult(hook, snapshot)` = `propose` + `accept`.

### Admission table (v1)

| Hook | Admitted |
|---|---|
| `BeforeRequest` | `Continue` |
| `AfterToolPhase` | `Continue`, `Guide(Steer)` |
| `FinalResponse` | `Finish`, `Guide(Nudge)` |

### Validation order in `EngineHost::accept` (all before any effect; a refusal changes nothing)

1. `proposal_id` is exactly the next one → else `engine-proposal-replayed`
2. `based_on_revision` = current revision → else `engine-state-stale`
3. effort is `KeepPinned` → else `engine-effort-not-authorized` (even if a descriptor claims `may_propose_effort`)
4. action admitted at the hook → else `engine-action-not-admitted`
5. guidance bounds → else `engine-guidance-invalid`
6. state belongs to this engine and schema → else `engine-state-foreign`
7. revision advances by exactly one → else `engine-state-revision`
8. size ≤ 16 KiB → else `engine-state-oversized`
9. engine-specific `check_transition(from, to, snapshot)` → else `engine-state-transition`
10. commit state, append a `ProposalReceipt { proposal_id, hook, revision }`, return the `EngineDecision`

In the turn loop any refusal ends the run as `Failed(code, message)` (fail closed, no retry).

## 3. Production wiring (`inspect.rs`)

### 3.1 Engine identity: from the sealed issuance, stable across restart/recovery

- `engine_for_run` → `engine::resolve_issued(resolution)`: the resolution is parsed as the
  **typed** `RegistryResolutionV1` and accepted only if `issuance_id_of()` (digest of its
  content, which includes `target.modeId`, `target.orchestrationEngineId` and
  `target.reasoning`) equals `provenance.issuanceId`. That is the same check and the same id
  the Kernel uses in `seal_issuance` (HMAC-sealed), and every later attempt is refused by the
  Kernel unless its intent agrees with that sealed issuance (`dispatch.rs`: "intent digests
  disagree with the sealed issuance"). The engine therefore cannot differ from the sealed one;
  a tampered or malformed resolution fails `engine-identity-invalid`.
- Within a run the engine is fixed: `Shared.engine` is a `&'static` chosen once; the same
  resolution value is sealed and sent with every attempt.
- A broker restart never resumes a run in place: `recover()` closes the interrupted run and
  `resume_run` (automatic or user) creates a **new** run with a fresh Controller task and a
  fresh Registry issuance. EM-01 records the binding on the run record
  (`engineModeId`, `engineId`; broker-internal, not in the run view) and refuses, before any
  working copy or provider request, a continuation whose issued engine or mode differs from the
  run it continues (`engine-continuity-mismatch`, start state `rejected`). Records written
  before EM-01 carry no binding; they ran the inline loop that `muse-v0` reproduces exactly
  (§7), so they continue only as `muse-v0` (`LEGACY_NATIVE_ENGINE`).
- This is identity binding, not engine-state persistence: the engine's counters remain
  in memory per run (§5.6), exactly as before EM-01.
- Failure is a start error before any working copy, grant or provider request exists. (The
  Registry's Native issuer only issues `engineering-v2`/`muse_main`, so every issuable run
  resolves to `muse-v0`; Dual/Nova would fail closed here rather than silently run Muse policy.)

### 3.2 Turn loop
- `turn_loop` owns one `EngineHost` per run, in a local variable.
  - `BeforeRequest` — consulted before every request; the request is built exactly as before.
  - `FinalResponse` — replaces the inline `refresh_stall_budget` + gate + `premature_stop`.
    `Guide` → the same session-state line, the model's reasoning and text replayed, the guidance
    as the next user message, `continue`. `Finish` → falls through to the Native completion
    policy (`decide_run`), unchanged.
  - `AfterToolPhase` — replaces the inline "start implementing" steer; same state line and message.
- `LoopState` lost the nine strategy fields (`nudges`, `plan_nudges`, `verify_nudges`,
  `fail_nudges`, `report_nudges`, `tidy_nudges`, `progress_mark`, `steers`,
  `recent_narration`); they live in `MuseV0State`. Receipts stay in `LoopState` (Core truth).

## 4. `muse-v0` (`engine/muse_v0.rs`)

Descriptor: `muse-v0`, modes `[engineering-v2]`, roles `[muse_main]`, state schema 1,
`may_propose_effort = false`. Policy code (`looks_like_report`, `refresh_stall_budget`,
`premature_stop`, steer) was **moved, not rewritten**; only `ls.<receipt>` reads became
`snap.<receipt>`. It always proposes `KeepPinned`. `check_transition` enforces:
counters move by 0 or +1 and respect their caps (nudges 7, plan 5, report 3, verify 3, fail 2, tidy 1, steers 3); resettable counters may drop to
≤1 only when receipts show progress (and `progress_mark` then equals the receipt progress);
`tidy_nudges` and `steers` are monotonic; narration window ≤ 4 entries of ≤ 1 KiB
(entries are normalized to ≤ 160 chars, so the bound is never hit by real replies).

### 4.1 What `muse-v0` is not

`muse-v0` is a **Native compatibility adapter**. It is not EMv2 (Muse) parity and must not be
reported as such. Absent, and inactive in EM-01:
- the Muse Reasoning Governor (`Muse-ReasoningGovernor.resolveMuseReasoningEffort`) and the
  reasoning runtime / effective-state reducer — effort is the Registry's static `low`;
- the `muse_update_reasoning_state` tool and the trusted activity observer;
- EMv2's controller-planned verification, review and requirements discipline (DSH Controller);
- Dual (EMv1) and Nova (EMv3) engines, child runs, CCv2.
The engine id `muse-v0` names this adapter in the Registry vocabulary; it is not a port of Muse.

### 4.2 `legacy_reference.rs` is test-only

It is declared `#[cfg(test)] mod legacy_reference;` and the file itself starts with
`#![cfg(test)]`, so it compiles to nothing outside tests even if a declaration loses its guard.
Artifact check: 0 `legacy_reference` symbols in the release and debug `libnexus_broker` rlibs
and in every workspace binary (`nexus-broker`, `nexusd`, `nexus`, `nexus-kernel`, …); 39 in
the lib test binary (positive control).

## 5. How future proposals will be validated (B3 — designed, not implemented)

1. **Stable assignments.** Mode, role → model/route bindings are resolved once and sealed by the
   Registry. An engine never names a model, route or provider; contract v1 has no field for it.
2. **Per-attempt authorization.** An effort (or, later, role/route) change becomes a *request to
   the Registry* for a new per-attempt issuance. The Core only sends a request whose target is a
   Registry-issued, sealed issuance for that attempt; the engine's proposal is an input to that
   issuance, never the authority.
3. **Immutable pins.** The run's issued target is never mutated. A per-attempt target is a new
   sealed issuance referencing the run's; credentials, connection and binding stay identical.
4. **Registry-authorized effort.** `Change(level)` will be admitted only when (a) the
   descriptor declares `may_propose_effort`, (b) the level is in the route's declared supported
   levels and inside the mode's policy bounds, (c) the Registry issues it. Anything else keeps
   today's refusal `engine-effort-not-authorized`. Effort changes are always visible in the
   timeline; never silent.
5. **Revisioned state.** Every accepted proposal advances `revision` by one and is receipted;
   proposals carry `based_on_revision` (optimistic concurrency).
6. **Idempotency and recovery.** v1 state is in memory per run: a broker restart continues
   the task in a new run whose engine starts from `initial_state` (identical to the pre-EM-01
   loop, whose counters were also in memory and also started over in the new run); its engine
   identity is bound to the interrupted run's (§3.1). Durable engine state is a governor dependency (§8): persist `(state, revision,
   receipts)` with the run record, re-apply by `proposal_id` (duplicates refused as replay),
   and on resume validate `engine_id`/`schema`; a mismatch fails closed.
7. **Unsupported modes.** Resolution fails closed (`engine-unavailable` /
   `engine-mode-mismatch`) before any effect; no fallback engine.
8. **Cross-engine isolation.** One host per run, typed state per engine, `engine-state-foreign`
   on any other engine's/schema's state, compiled-in engines only, no shared statics with
   mutable state.
9. **Failure behaviour.** Any refusal is terminal for the run with its code; the Core never
   "repairs" a proposal.

No second Controller or Registry exists: the host is a validator inside the Core's turn loop,
and completion stays the Native completion policy (`decide_run`).

### 5.1 Refusal atomicity and replay (validated now)

`EngineHost::accept` mutates nothing until every check has passed; the commit is three
assignments at the end. `propose` receives `&EngineState` (immutable borrow), so an engine
cannot touch committed state. Refusal codes are terminal for the run. Tests:
`a_refused_proposal_applies_nothing` (5,000 mutated proposals; every refusal leaves state,
receipts and the next expected id byte-equal) and
`a_restart_or_a_repeated_proposal_id_cannot_bypass_the_transition_checks` (same id again →
replayed; a previous run's later proposals on a new host → replayed/stale; the previous run's
state relabelled as a fresh revision-1 proposal → `engine-state-transition`).

## 6. Tests (all offline; mock provider)

Unit (`engine/tests.rs`, 17):
- sealed identity: a genuine issuance resolves; a genuine Dual issuance is unavailable; the
  engine or mode swapped after issuance, or a non-resolution, → `engine-identity-invalid`.
- atomicity (5,000 mutated proposals) and restart/replay (§5.1).
- resolution: `muse-v0` resolves; `dual-v1`, `nova-v3`, `muse-v1`, `muse`, `""` →
  `engine-unavailable`; `engineering-v1`+`muse-v0` and `""`+`muse-v0` → `engine-mode-mismatch`;
  hostile ids sanitized.
- effort change refused; non-admitted actions at every hook (incl. all three reserved actions);
  replay, stale, foreign, revision jump; empty/oversized/ordinal-0 guidance; invalid
  transitions (+2, cap, progress mark ahead of receipts, narration overflow, reset without
  progress) and a valid reset with progress; oversized state. Every refusal leaves state
  and receipts unchanged.
- a hostile engine (claims effort authority, proposes `max` effort and a child run) is refused
  by the host and is not selectable by `resolve`.
- two hosts: no state crosses runs.
- the four policy tests that lived in `inspect.rs`, ported to the snapshot/host API with
  identical expectations (announcement / unverified change, planning ramble fixture,
  stall budgets reset on progress, Run-14 failed-checks fixture).
- **differential parity**: 400 seeded runs × 120 steps (48,000 decisions) over a corpus of reply
  shapes (incl. both incident fixtures) and random receipt evolution, comparing the host
  against `legacy_reference.rs` — a verbatim, frozen copy of the `a497b87` functions — on
  every decision (message, reason, ordinal) and every counter.

E2E (`tests/code_a56.rs`):
- new `em01_the_engine_boundary_adds_no_request_field_and_no_tool_schema`: every request has
  exactly the P0 top-level keys, a tool-schema SHA-256 frozen from `a497b87`
  (`58f513de…d8d90b`, 6 tools), and `reasoning.effort = "low"`.
- new `em01_a_continuation_under_another_engine_is_refused_before_dispatch`: the binding is
  recorded before the first request; a continuation of a run bound to another engine is
  `rejected` with `engine-continuity-mismatch`, with no provider request, no turn and no
  working copy, and is not itself bound.
- the existing continuation E2E (`a614_an_interrupted_task_is_continued…`) additionally asserts
  both runs are bound to `engineering-v2`/`muse-v0`.
- the existing nudge/steer/completion/approval/recovery/verification E2Es run unchanged.

## 7. Behavioural parity report vs the P0 baseline (`a497b87`)

| Evidence | Result |
|---|---|
| Request bodies of the E2E run, B vs `a497b87` export, byte compare | identical (8,257 B and 9,009 B) |
| Top-level request keys | identical: `input, max_output_tokens, model, parallel_tool_calls, reasoning, stream, tool_choice, tools` |
| Tool schemas | identical SHA-256, same 6 tools; no new tool |
| Reasoning effort | `low` on every request; engine cannot change it |
| Differential decision parity | 48,000/48,000 decisions and counters equal |
| Ported policy tests | 4/4 pass with unchanged expectations |
| A614 long-loop request size | max request 449,944 B — identical to P0 (bound 450,000) |
| Full battery | 923 passed, 0 failed, 49 ignored (908 at P0 − 4 moved + 17 engine + 2 E2E); see §9 |

Intentional differences: (1) a run whose sealed resolution names an engine this runtime lacks
fails closed at start (unreachable today: the Native issuer only issues `engineering-v2`);
(2) a refused engine proposal fails the run (unreachable with `muse-v0`; covered by tests);
(3) a malformed resolution or one whose content does not match its issuanceId is refused by the
broker at start (before EM-01 the Kernel's seal refused it a few steps later, also before
dispatch); (4) a continuation whose engine differs from the interrupted run's is refused
(unreachable today); (5) run records gain two optional broker-internal fields.

## 8. Dependencies before EMv2 governor activation

1. **Registry per-attempt issuance** with effort ∈ the route's declared levels and the mode's
   policy bounds; issuer API + sealed per-attempt target; Kernel accepts only issued targets.
2. **Contract v2**: admit `EffortProposal::Change` under §5.4; timeline event for every effort
   change; tests for refusal of unsupported levels.
3. **Engine state durability**: persist state/revision/receipts with the run record; resume +
   replay-by-id; schema migration rule.
4. **Signals adapter**: richer receipts (activity classes, test deltas, error streaks) in the
   snapshot — receipts only, never model self-report.
5. **`muse_update_reasoning_state` (if kept)**: a tool schema is a request-size and
   prompt-surface change — needs its own byte budget against the A614 bound and its own
   E2E guard update (the EM-01 digest guard will fail by design).
6. **Controller-run verification** before admitting `RequestVerification`.
7. **Node-bridge / Desktop surface**: show engine id, revision and effort changes; operator
   override.
8. Live A/B on the paid provider with an explicit budget, after 1–7.

## 9. Validation (final, after the architectural-review changes)

- `cargo fmt --check`: clean. `cargo clippy --workspace --all-targets -D warnings`: clean.
- Battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`): **923 passed,
  0 failed, 49 ignored** (= the 908 tests of `a497b87` − 4 moved out of `inspect.rs` + 17 engine
  unit tests + 2 EM-01 E2E tests).
- `nexus-broker --lib`: 84 passed (17 engine). `code_a56`: 82 passed, 4 ignored.
  `broker_a53`: 23 passed, 1 ignored. `inspect_a55`: 17 passed.
- Desktop Tauri (`CARGO_INCREMENTAL=0`): 27 passed, 2 ignored — unchanged.
- A614: max request 449,944 B — unchanged.
- Restart race ("another broker already owns this state directory"): pre-existing in
  `a497b87`, not caused by EM-01 — reproduced at equal rates on both trees by a probe and
  eliminated on the baseline by an explicit `flock` unlock (root cause: the lock's open file
  description is inherited by children forked concurrently by other threads until they exec).
  Fix tracked separately; not part of EM-01. Evidence in the EM-01 review package.
