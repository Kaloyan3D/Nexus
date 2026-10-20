# EM-04 — Muse Reasoning Governor handoff (study only; nothing executed or integrated)

Sources studied (read-only):
- `config/Muse-ReasoningGovernor.cjs` (403 lines)
- `config/Muse-ReasoningRuntime.cjs` (569)
- `config/Muse-ReasoningSignals.cjs` (555)
- `config/Muse-ReasoningActivity.cjs` (548)

They were not executed or loaded by EM-03 code.

## 1. What each module is

| Module | Role | Purity | DSH coupling |
|---|---|---|---|
| Governor | effort policy: phase default → strong escalation (≥2 active failed hypotheses or implementation attempts, or conflicting evidence → `xhigh`) → implement de-escalation (root cause + solution established → `medium`) → explicit max → **downward-only** capability clamp; fails closed on unknown capabilities | pure, deterministic | none |
| Runtime | owns the task-local `museReasoning` block (phase, currentEffort, rootCause/solutionEstablished, active and total failure counters, conflictingEvidence, requestMax, lastResolution, processed signal ids). Validated transitions with progress-window resets on false→true establishment edges. `prepareMuseRequestEffort` resolves per request | logic pure; persistence is the **DSH routing-state file** | file location only |
| Signals | the model-facing tool `muse_update_reasoning_state`: structured state events only (no effort field), deduplicated on a trusted dispatch identity, affecting FUTURE requests only | schema pure; registration via DSH `ctx.tools.register` | registration |
| Activity | trusted operational evidence (mutation succeeded, verification started/passed/failed, revision-ordered against semantic transitions) and `reduceEffectiveState` → effective phase (`recovery-needed` / `implementation-active` / `verification-passed` / semantic) | reducer pure; observer reads DSH tool results | observer input |

## 2. Mapping onto EngineExtension v2

An EM-04 engine `muse-v1` (new id; `muse-v0` stays the compatibility adapter) would be:

| Muse concept | EngineExtension v2 / EM-03 home |
|---|---|
| descriptor | `may_propose_effort: true`, `inherits_state: true`, own `state_schema` |
| `museReasoning` block | `EngineStateData::MuseV1(..)` payload (typed, ≤ 16 KiB, validated by `check_transition`). Persisted through `persist_state` into `EngineStateRecord.payload`, **never** the DSH routing-state file |
| `museActivity` block | part of the same payload. Its inputs come ONLY from Core receipts in `EngineSnapshot`, never from model prose. The snapshot already carries `applied_edits`, `last_test`, `dirty_since_test` and `failed_checks`; EM-04 must add a revision-ordered activity feed: per-attempt receipts of mutations and verifications |
| `prepareMuseRequestEffort` (per request) | the engine's `propose` at `Hook::BeforeRequest`: reduce the effective phase → resolve the effort (Governor, ported verbatim to Rust or called through a pure bridge) → `EffortProposal::Change(e)` when `e ≠ snapshot.current_effort`, else `KeepPinned`. It is effective from the NEXT attempt; at `BeforeRequest`, the next attempt is the one about to be issued (`attempts_dispatched + 1`) |
| Governor capability input (`supportedReasoningLevels`) | **`snapshot.authorized_efforts`** = TaskBindingV1 levels = the operator's slot policy ∩ route (EM-02), never the route alone |
| downward-only clamp | must clamp into `authorized_efforts`. If no authorized level is ≤ the requested one, return `KeepPinned` (the Governor's fail-closed throw becomes "no change"). Never propose an unauthorized level: the host would refuse it, which fails the run closed |
| `currentEffort` / `lastResolution` | host-owned `EffortSelection` + record events (`effort-selected` with proposal id and attempt). The engine payload may keep `lastResolution.trace` (bounded; no model text) |
| progress-window resets | `check_transition` rules (counters move only by validated events; resets only on establishment edges) |
| signal deduplication (processed ids) | payload FIFO of processed signal ids. Proposal-id idempotency is already enforced by the host |
| `requestMax` (trusted-only) | a Core/operator action, never a model signal (as in DSH); out of scope until designed |
| DSH session binding → taskInstanceId | already structural: one record per task generation, identity-checked |
| a signal affects FUTURE requests only | the same semantics as v2 "from the next attempt on" |

**Ladder decision (made at the EM-03 review; binding for EM-04).**
- **Preserve** the historical Governor ladder `medium < high < xhigh < max`; `low` is NOT added
  to its core policy.
- Existing default-only Native configurations keep `low`: no slot policy means the default only.
  `muse-v0` is unchanged.
- Adaptive reasoning requires explicit authorization. The operator's slot `allowedReasoning`
  must list the Governor levels, and the result stays within the Registry-captured
  `authorized_efforts`.
- Downward clamping is deterministic and never escalates beyond the Governor's proposal. The
  Governor's own downward-only clamp is applied against `authorized_efforts`. If no authorized
  level is at or below the requested one, the engine proposes `KeepPinned`; it never picks a
  higher level.

## 3. State schema readiness (EM-03 → EM-04)

Representable today without changing the record schema:
- **Cognitive phase:** payload field.
- **Active and total failure counters:** payload fields plus `check_transition` rules.
- **Established root cause and solution:** payload booleans (flags only, never model text).
- **Trusted activity signals:** payload activity block, plus record events for audit.

Required changes:
- a new `EngineStateData` variant;
- `state_schema` 1 for `muse-v1`;
- `restore_state` validation.

## 4. Signals tool and the request-size budget (prerequisite)

| Fact | Value |
|---|---|
| A614 long-loop max request (current and EM-03) | 449,944 B |
| A614 regression bound | 450,000 B → **56 B headroom** |
| Transport hard limit (`nexus-model::request::MAX_REQUEST_BYTES`) | 4 MiB |
| `muse_update_reasoning_state` definition as an OpenAI Responses tool (computed statically from the Signals source; 9 properties, 1,174-char description) | **≈ 2,881 B per request** |
| Compaction budget accounting (`context::compact`) | conversation items only. Instructions + tool schemas (~150 KB in A614) are outside it |

Adding the tool as-is would break the A614 guard by about 2.8 KB, and it would silently eat
conversation budget in real runs. Required mechanism, before the tool:

1. **RequestBudgetV1** computed per request from the PREPARED body. Fixed overhead
   (instructions + tool schemas + reasoning replay reserve) is measured exactly from what the
   executor will send. The compaction budget becomes `target_request_bytes − fixed_overhead`
   instead of a constant.
2. **Per-mode tool-schema allowance**, declared with the mode (e.g. `toolSchemaBytes` ceiling),
   checked at task start. A mode whose catalog exceeds its allowance fails closed. The signals
   tool exists only in the `muse-v1` catalog (Muse-scoped, as in DSH).
3. **Guards updated deliberately**:
   - the EM-01 request-shape guard gets a second frozen catalog digest for `muse-v1` (the `muse-v0`
     digest stays unchanged);
   - the A614 guard is re-baselined as `max_request ≤ target_request_bytes` for each mode, with the
     overhead printed.
4. **Tool execution path**: Signals become a Core-validated tool whose result is a typed engine
   event (never a direct state write). The engine consumes the event through its next proposal;
   the host validates and commits it as in EM-03.

## 5. EM-04 work list (in order)

1. Request-size budgeting (§4.1–4.3), with tests. No behaviour change for `muse-v0`.
2. Activity receipts feed in `EngineSnapshot` (Core-observed mutations and verifications with
   revisions).
3. Governor port (Rust or pure bridge), golden-vector tested against the JS Governor's existing
   deterministic suite (52 assertions; it passes standalone per the parity audit).
4. `muse-v1` engine: payload, `check_transition` (progress windows), `persist/restore_state`,
   proposals at `BeforeRequest`; Registry mode/engine declaration (a new engine id, scoped
   models). The ladder decision of §2 is made explicitly.
5. Signals tool (§4.4), Muse-scoped, behind the budget.
6. Live A/B with an explicit paid-inference budget, only after 1–5.

Out of EM-04 unless separately approved: Dual (EMv1), EMv3, CCv2, `requestMax` exposure,
revocation of a running task's policy.
