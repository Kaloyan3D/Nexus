# EM-04A — Muse Governor shadow integration: architecture

Baseline `b5a939a` (EM-03). Worktree `~/Projects/Nexus-governor-shadow`, branch
`feature/native-muse-governor-shadow`. Uncommitted, for architectural review.

EM-04A adds three things to the Native runtime:
1. an **exact request-size budget**;
2. a **trusted activity feed**;
3. the **historical Muse Reasoning Governor in shadow mode**.

The Governor is evaluated on Native receipts, compared against DSH, and its state is durable.
Its decisions are never applied: every production request keeps the authorized effort and the
tool surface it had in EM-03.

Companion documents:
- `EM-04A-IMPLEMENTATION-REPORT.md`: files, tests, gates and measurements.
- `EM-04A-GOVERNOR-PARITY.md`: the differential validation against DSH.
- `EM-04B-SIGNALS-TOOL-HANDOFF.md`: the activation contract for the next step.

## 0. What did not change

| Area | State |
|---|---|
| `muse-v0` (the production engine) | Unchanged: same decisions, same state. 66/66 provider request bodies are byte-identical to `b5a939a`, including all 59 A614 requests. |
| Default reasoning | `low`; Registry model assignments are untouched. |
| Model-facing tool catalog, request fields, providers, routes, connections | Unchanged. No signals tool. |
| Registry, Kernel, daemon, store, contracts | Not modified (no file in those crates or in `config/` changed). |
| Authorization | Registry and Kernel keep it. The shadow engine declares `may_propose_effort: false`, so the host refuses any effort change it might produce. |
| EM-03 durable record format, HMAC key, commit points | Unchanged. EM-03 records continue to load. |
| Production configuration | `request_budget_bytes = None`, so the budget is never invoked. `MUSE_V1_PRODUCTION_ENABLED = false`, so the shadow engine is not selectable. |

## 1. RequestBudgetV1 (`nexus-broker/src/request_budget.rs`)

### 1.1 Why the existing bound is not enough

`context::compact` bounds the conversation by an approximation, and it never touches the newest
36 items. In A614 the protected tail alone is ≈ 430 KB, so the real request reaches 449,944 B
under a 300,000 B conversation budget. The future signals tool (2,882 B) would break the
450,000 B A614 guard, and a real run would lose that context silently.

### 1.2 Contract

```
RequestBudget { target_bytes, reserve_bytes }      limit = target - reserve   (None => fail closed)
fit(items, exact_request_bytes, limit) -> Ok(BudgetReport) | Err(BudgetExceeded)
```

**Exact, not estimated.**
- The decision input is the length of the bytes `nexus_model::prepare` serialized:
  `PreparedModelRun.request_bytes`, the same bytes the request digest covers.
- A request at or under the limit costs nothing more.
- Only when a reduction is needed is every item sized, with
  `nexus_model::prepare::responses_input_item_bytes`. That is the same per-item canonical
  serialization `prepare` now calls (the code was extracted from `prepare`, and the output is
  byte-identical).
- The fixed overhead is computed exactly: `total − Σ items − separators` (model, tool schemas,
  effort, stream and limit fields).
- After a reduction, the turn loop **prepares again** and requires the new length to equal the
  predicted one and to be at or under the limit. Otherwise nothing is sent.

**Reduction order.** Reductions apply oldest first and stop as soon as the request fits.
1. A replayed `reasoning` item is dropped **whole**. Items are never edited, so every remaining
   encrypted item is byte-for-byte the provider's.
2. An old `function_call_output` is replaced by the context manager's valid JSON stub (the same
   helper writes it). Its `function_call` stays, so call and result remain paired.
3. An old assistant message is shortened at a character boundary. Its provider `phase` label is
   kept.

**Never touched:**
- every `user` message: the task, guidance, working memory and runtime notes (instructions and
  authorization-relevant content);
- every `function_call`;
- the **latest step**: the latest response's reasoning, text and calls, the results answering
  them, and any user message after them.

**Failure.** If the request still does not fit, the run fails with `request-budget-exceeded`
**before** the attempt is bound, published or dispatched. The conversation is left exactly as it
was.

**Determinism.** `fit` is a pure function of (items, length, limit).
- A retry after a lost answer is a new attempt prepared from the same items under the same
  budget.
- A second `fit` on an already-fitted conversation is a no-op (unit-tested).

### 1.3 Where it runs

The budget runs in `inspect.rs`, immediately after `prepare_inspect_turn` and before EM-03's
write-ahead `bind_attempt`, and only if `BrokerConfig.request_budget_bytes` is `Some`. The reserve
comes from the engine descriptor's new `request_reserve_bytes`:
- `0` for `muse-v0` and the test engine;
- `2,882` for the shadow engine, the measured future signals tool.

A reduction counts as a context compaction in the run record.

### 1.4 Activation status

No production configuration sets the budget (`main.rs` sets `None`). EM-04B activates it per
mode (handoff §2). The A614 evidence:
- With the shadow engine's reserve and a 449,999 B target, the largest request is 425,840 B, or
  428,722 B with the future tool.
- With `muse-v0` and the same target (an active but unneeded budget), all 59 requests are
  **byte-identical** to the run without a budget.

## 2. Trusted activity feed

`EngineSnapshot` gains `generation` (the task instance id) and `activity: Vec<ActivityObservation>`.
Engines can only read them.

```
ActivityObservation { seq, attempt, generation, execution_id, kind: Mutation | Verification{outcome, family} }
```

The Core derives an observation (`inspect::observe`) from the receipt it already records for every
tool call. **No second ledger exists.** The observation is computed from the same `ToolActivity`
record, the Kernel's execution id and Native's own verification verdict that the completion logic
uses.

| Receipt | Observation |
|---|---|
| `fs_write` / `fs_edit`, status `executed`, Kernel execution id present | `Mutation` |
| `proc_run`, `executed`, `is_verification_command(args)`, verdict `pass` / `fail` | `Verification{Passed / Failed}` |
| the same with verdict `unverified` (pipeline status proves nothing) | `Verification{Started}` |
| reads, non-verification commands, refused, failed, cancelled or uncertain calls, no execution id | none |

**Identity and ordering.**
- `seq` is the call's index: strictly increasing within the run.
- `attempt` is the dispatch ordinal of the response that proposed the call.
- The replay identity is the Kernel `execution_id`.
- The observation is recorded only when the tool call completes normally, after its receipt.

**What can change state.** The shadow engine folds only observations of its own generation, with
a `seq` above its frontier and an execution id it has not folded before. Duplicates, stale and
foreign observations are counted as refused and change nothing (§4.3).

The feed is produced for every run because it is cheap and in-memory. Only an engine that folds
it persists anything about it; `muse-v0` ignores it.

## 3. Governor bridge (`engine/governor_bridge.rs`, `engine/muse_bridge.cjs`)

**Reuse, not rewrite.**
- `Muse-Reasoning{Governor,Runtime,Activity}.cjs` are embedded in the broker byte for byte with
  `include_str!`. A test compares them with `config/`.
- A short-lived `node -e muse_bridge.cjs` evaluates them **unchanged** with `vm.compileFunction`.
- `sources_digest()` (SHA-256 over the three sources and the bridge) is part of every decision's
  evidence.

**Traced dependencies, replaced by Native adapters.** The three modules use exactly the following
hooks; nothing else is reachable, and every other `require` throws.

| DSH hook | Used by | Native adapter |
|---|---|---|
| `node:fs` (`readFileSync`, `writeFileSync`, `renameSync`, `rmSync`, `mkdirSync`) | Runtime: routing-state file, model registry | an in-memory store with ONE virtual routing-state document, built from the engine's EM-03 payload, and ONE virtual registry entry whose `supportedReasoningLevels` are the task binding's authorized levels. Writes elsewhere are refused; the real filesystem is never touched (tested). |
| `./Engineering-Profiles.cjs` → `routingStatePath` | Runtime | returns the virtual document path |
| `Date` (`new Date().toISOString()`) | Runtime (`lastResolution.atUtc`) | a fixed clock (epoch), so decision evidence is deterministic |
| DSH tool-result observer (`classifyToolOutcome` on DSH `exec`/`result`) | Activity / Runtime observer | the Native observation (§2) becomes the historical classification and is folded with the historical `applyClassification` |

**Bridge operations.**
- `evaluate`: ordered events, either `activity` classifications or `semantic` transitions through
  the Runtime's own transition API, then optionally the Runtime's per-request seam
  `prepareMuseRequestEffort`.
- `ladder`: the Governor's ladder and phases.

`MuseReasoningCapabilityError` becomes `outcome: capability-unavailable`. A `TypeError` from the
historical validators becomes `state-invalid`.

**Bounds.**
- `env_clear` (no environment); the trusted node binary from `trust::resolve_node` (the same one
  the Registry bridge uses);
- stdin ≤ 1 MiB, stdout ≤ 256 KiB, stderr discarded, killed after 10 s.

Every failure is an `Err` with a code, never a guess.

**Capability lending.**
- The bridge reaches an engine only as `EngineEnv.governor`, an `Arc<dyn GovernorEvaluator>`.
  `EngineHost::consult_in` and `EngineRun.env` lend it for each consultation.
- The extension boundary carries no path or process.
- `inspect.rs` lends it **only** when the engine is `muse-v1-shadow`. All other engines get the
  default (empty) environment, and `propose_in` defaults to `propose`.

**Cost.** One evaluation (node spawn + compile of ≈ 66 KB) takes 159 ms (median) in a debug test
build and 174 ms in release. Implementation report §5 has the details.

## 4. The shadow engine `muse-v1-shadow` (`engine/muse_v1.rs`)

### 4.1 Descriptor

| Field | Value | Why |
|---|---|---|
| `engine_id` | `muse-v1-shadow` | `muse-v1` stays reserved for the ACTIVE Governor engine. The EM-01 test asserting that `muse-v1` is not an available engine stays unchanged. |
| `may_propose_effort` | `false` | Shadow. A `Change` proposal is refused by the host (tested). |
| `inherits_state` | `true` | The cognitive state continues with the task (§6). |
| `request_reserve_bytes` | `2,882` | The future signals tool, measured exactly (§1, handoff). |
| `mode_ids` / `roles` | `engineering-v2` / `muse_main` | As `muse-v0`. |

**Production gate.**
- `MUSE_V1_PRODUCTION_ENABLED = false`, and `engines(test_build)` registers the engine only in
  `test-engines` builds.
- A unit test proves a production build's engine list is `["muse-v0"]`.
- Only a fixture Registry mode can issue the id. No shipped mode names it.

### 4.2 Behaviour

- **Strategy.** Guidance and finish are `muse-v0`'s, delegated to `MUSE_V0.propose` on
  `muse-v0`'s own counters. A test runs 60 turns × 3 hooks through both engines: identical
  decisions.
- **`BeforeRequest`:**
  1. fold the new trusted observations;
  2. call the bridge with the historical blocks, those events, `capabilities` = the binding's
     authorized levels, and `resolve: true`;
  3. record a `ShadowDecision`:
     `{attempt, outcome, governorEffort, requested, reason, effectivePhase, effectiveSource, trace, inForce, would, folded, refused, evidence}`.
- **`would`** is `change:<level>` only if the Governor's (clamped) effort is on the historical
  ladder, differs from the effort in force, and is authorized. Otherwise it is `keep`. It is
  recorded and **never applied**: the proposal is always `KeepPinned`.
- **An unavailable or failing bridge** (absent, timeout, invalid output, or an answer that folded
  observations but produced no evidence) records its error code as the outcome. The observations
  stay unfolded and are offered again. The run continues unaffected.

### 4.3 Transition rules (`check_transition`, enforced by the host before any commit)

| Rule | Refuses |
|---|---|
| `muse-v0` rules on the strategy counters | any invalid nudge or steer transition |
| semantic fields (phase, establishment flags, active and total failure counters, conflict, `requestMax`, processed signal ids) never change | every semantic move (no signals tool exists in EM-04A) |
| both blocks structurally valid (closed key sets, ladder, bounds) | invalid or forged blocks |
| the frontier moves only to the run's generation and within its receipts | a foreign generation, or a frontier beyond the feed |
| the activity block changes only when new observations were folded | evidence without a trusted observation (narration, replay) |
| activity revision never decreases | rollback |
| at most one evaluation per consultation, for attempt `dispatched + 1`, with `inForce` = the effort in force | wrong-attempt or duplicated decisions |
| the Governor effort is on the historical ladder; `would` stays within the authorized levels | off-ladder or unauthorized shadow proposals |
| the decision chain extends exactly by the recorded decision | a rewritten or broken history |
| bounded bookkeeping (≤ 64 seen ids, ≤ 8 decisions) and the generic 16 KiB state bound | growth |

The host's generic rules (proposal id, revision, foreign state) also apply. Each rule above has
an adversarial unit test that asserts it is the rule that refused (`muse_v1_tests.rs`).

## 5. Reasoning policy

| Decision (binding) | Implementation |
|---|---|
| The historical ladder is unchanged; `low` is not added | The bridge runs the unchanged Governor. `MUSE_LADDER = [medium, high, xhigh, max]`, asserted against the bridge's own export. |
| Default-only configurations stay `low` | No slot policy means `authorized = [low]`. The Governor finds no ladder level and fails closed (`capability-unavailable`); the shadow keeps `low` (E2E-tested). |
| Adaptive mode requires explicit Registry slot authorization | Capabilities are exactly `snapshot.authorized_efforts` (TaskBindingV1: slot policy ∩ route). |
| Proposals never override Registry capability limits | The Governor's own downward-only clamp runs against the authorized levels, and `would` requires membership. In EM-04A nothing is proposed at all. |
| Clamping is deterministic, downward-only and observable | The historical `clampMuseEffortToCapabilities` is recorded in the trace (`capabilities:xhigh->high(clamped-down-to-high)`). If nothing fits at or below the request, it fails closed (`capability-unavailable`) and the effort in force is kept. |
| No model, provider, route or connection switching | No such field exists in the decision or the proposal. |
| No automatic effort change in production runs | The shadow is not selectable in production, and is not applied even where selected. |

## 6. Durable state and continuation (EM-03 mapping)

**Payload** (`EngineStateRecord.payload`, HMAC-authenticated, revisioned, ≤ 16 KiB):

```
{ v0: {muse-v0 counters, narration digests},
  museReasoning: <historical block> | null,     museActivity: <historical block> | null,
  generation, observedThrough, seen: [execution ids ≤ 64],
  evaluations, history: [ShadowDecision ≤ 8], chain: sha256-chain, sourcesDigest }
```

**Commit points** are EM-03's.
- Every `BeforeRequest` decision is part of the state that `bind_attempt` writes ahead of the
  dispatch. A decision is therefore durable before the attempt it describes is sent.
- The engine end is written after the run's authoritative verdict.
- No model text is persisted: the trace holds policy strings, the family holds a program name,
  and `v0` holds narration only as digests (tested).

**DSH routing-state file:** never used. The historical blocks live only in the engine payload.

**Continuation** (`restore_state`; EM-03 authenticates the record, checks identity and version,
and fails closed on anything invalid):

| Part | On continuation |
|---|---|
| semantic block (phase, flags, counters) | **inherited** (the task's understanding continues) |
| activity block | **inherited** (evidence remains true) |
| `currentEffort` | cleared to `null` (EM-03: the effort restarts at the default under the new binding) |
| `lastResolution`, decision history, chain, evaluation count | inherited (audit continues; the chain keeps extending) |
| `seen` execution ids | inherited (a predecessor's execution can never be folded again) |
| frontier (`generation`, `observedThrough`) | restarts with the new generation's own receipts |
| `muse-v0` strategy counters | start over (as under `muse-v0`) |

The parity tests prove that a persist/restore round trip between requests yields exactly the
decisions of the uninterrupted DSH run (Governor parity §3, "restart").

## 7. Contract version: API evolution vs persisted schema (decision)

Two kinds of change must not be confused.

| Kind | Examples | Version effect |
|---|---|---|
| **Rust API evolution** (in-process types; nothing persisted) | EM-04A: the snapshot's `generation` and `activity`, the defaulted `propose_in`, `request_reserve_bytes`, the `EngineEnv` capability | none |
| **Persisted-schema or recovery evolution** | the record's serialized form; the meaning of `effort`, `attempts`, `events` or lineage; how a continuation interprets them | bump `ENGINE_CONTRACT_VERSION` (and the record schema if the envelope changes), with an explicit continuation rule |

**Decision: keep `ENGINE_CONTRACT_VERSION = 2` and record schema 1. No migration.**
- EM-04A changes nothing in the record envelope, the HMAC, the commit points or the continuation
  rules.
- The new `muse-v1-shadow` payload is a new engine's own `state_schema` 1 inside the unchanged
  envelope. EM-03's identity rule refuses to reinterpret any other engine's record as it.
- The code comment on `ENGINE_CONTRACT_VERSION` now states this distinction.

**Regression evidence** (`engine_state::em03_records_compatibility`, 4 tests):
- Fixtures: records **written by the `b5a939a` code itself**, with that build's broker-local
  test key, in `nexus-broker/tests/fixtures/em03-engine-state`. They hold an interrupted `muse-v0`
  task, an `effort-test-v0` task with a durable `high` selection and an unresolved attempt, and a
  completed run.
- Results:
  1. the EM-03 key is accepted and never regenerated;
  2. every record authenticates and re-serializes **byte for byte** with this build's types;
  3. tampering is still refused;
  4. the interrupted `muse-v0` task continues: the rule is `fresh-engine-does-not-inherit`,
     `predecessor-attempt-unresolved(2)` is recorded and never re-sent, a new attempt binds and
     the run finishes, and the predecessor file is unchanged;
  5. the effort selection is inherited, reset (`effort-reset-continuation(high)`), re-proposed
     and made durable before its new binding; it is never carried over or escalated;
  6. the shadow engine refuses to reinterpret an EM-03 `muse-v0` record (`engine-state-identity`).

## 8. Authority boundaries (unchanged)

- **Registry:** effort levels per slot and route; the only issuer.
- **Kernel:** seals and accepts every attempt. The shadow never reaches either.
- **Controller (Core):** task lifecycle and completion verdict. The shadow engine has
  `muse-v0`'s action set only.
- **Core:** tool execution, approvals, verification truth. The activity feed is derived from the
  Core's receipts; engines cannot write it.
- **Engine state:** written only through host-validated proposals. EM-03's HMAC and revision rules
  apply.

## 9. Limitations

1. Bridge latency (median 159 ms debug / 174 ms release per evaluation, ≈ +6.7 s over A614's 59
   requests) is acceptable for a test-only shadow, not for production activation.
   - The validated per-evaluation process stays in EM-04A.
   - The optimization to make before activation is a persistent, stateless, supervised Node worker
     with versioned request and response contracts. It is documented in handoff §3.4 and NOT
     implemented here.
2. The two verification vocabularies differ on 11 of 36 corpus commands (parity P-1).
   - Native's trusted receipts and classification are authoritative.
   - The historical Governor is not modified to imitate DSH's command classification.
   - Parity is algorithmic (same inputs → same decisions); end-to-end activity semantics differ
     exactly on those commands.
3. The historical anti-thrash rule means an edit after a failed check in the same period does not
   leave `recovery-needed` (parity O-1). It is preserved as is.
4. The budget protects the latest step absolutely. A single step larger than the limit fails the
   run explicitly rather than being cut.
5. `request_budget_bytes` is a broker-wide setting in EM-04A. Per-mode activation is EM-04B's.
