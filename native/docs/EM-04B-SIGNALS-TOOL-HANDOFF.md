# EM-04B — Signals tool handoff, and the road to real adaptive reasoning

Starting point: EM-04A (`EM-04A-ARCHITECTURE.md`). Native evaluates the unchanged historical Muse
Governor in shadow, on trusted receipts, with durable state, and applies nothing. This document
fixes the contract the next steps must meet. **Nothing here is implemented.**

## 1. What EM-04A leaves ready

| Piece | Where | Status |
|---|---|---|
| Exact request budget with a per-engine reserve | `request_budget.rs`, `EngineDescriptor.request_reserve_bytes` | implemented, tested; not configured in production |
| Reserve for the signals tool | `muse_v1::SIGNALS_TOOL_RESERVE_BYTES = 2,882` | measured; re-measured by a test from `config/Muse-ReasoningSignals.cjs` |
| Trusted activity feed | `EngineSnapshot.activity` | live in every run (read-only, in memory) |
| Historical policy through the bridge, including the Runtime's semantic transition API (`semantic` events) | `muse_bridge.cjs` | implemented. Semantic events are exercised only by the parity tests; no production path sends them. |
| Shadow engine with durable cognitive state | `muse-v1-shadow` | test-only (`MUSE_V1_PRODUCTION_ENABLED = false`) |

## 2. Signals tool activation contract (EM-04B)

### 2.1 The definition on the wire, and its reserve

The future tool's definition must be exactly the shape EM-04A measured:

```
{"type":"function","name":"muse_update_reasoning_state",
 "description":<SIGNAL_DESCRIPTION, 1,174 chars>,
 "parameters":{"type":"object","properties":<the 9 historical SIGNAL fields>,"additionalProperties":false}}
```

- **Size:** 2,881 B canonical, +1 B array separator = **2,882 B**. This equals
  `SIGNALS_TOOL_RESERVE_BYTES` (`the_signals_reserve_is_the_measured_wire_size_of_the_future_tool`).
- **Shape changes:** any change re-opens the measurement, the constant and that test together
  (e.g. adding `"required":[]` costs +14 B, `strict` costs more). The reserve must never be
  estimated.
- **Catalog:** the tool exists ONLY in the Muse Governor catalog, through a new
  `ToolProfile::RepoCodeMuseV1` (or equivalent). `RepoCodeV1` and `RepoInspectV1` stay
  byte-identical.
- **Request-shape guard:** the EM-01 guard's `muse-v0` catalog digest stays frozen. A second
  frozen digest is added for the Muse catalog.
- **Budget source:** the budget becomes per mode. The Registry mode declares
  `requestBudgetBytes`, sealed in the issued resolution; the broker reads it from there instead of
  `BrokerConfig`.
  - A mode whose `fixed overhead + reserve` exceeds its budget fails closed at task start, before
    any request.
  - `request_budget_bytes = None` stays the default for every mode that does not declare a budget.
- **A614 guard:** re-baseline it per mode as `max_request ≤ requestBudgetBytes` with the overhead
  printed. For `muse-v0` it remains `< 450,000` with 449,944 B observed. The muse catalog's
  evidence is EM-04A's `em04a_a614_long_loop_leaves_measured_room_for_the_signals_tool`
  (425,840 B + 2,882 B < 450,000 B).

### 2.2 Execution path (a Core-validated event, never a state write)

```
model call muse_update_reasoning_state(args)
  -> Core: closed-schema validation (historical validateReasoningSignal rules: known fields only,
     booleans are events, no effort/model/provider field, FORBIDDEN_SIGNAL_FIELDS refused)
  -> Core: SemanticSignal { generation, attempt, call_id, seq, events[] }   (dispatch identity =
     generation + attempt + call_id; the replay identity, like the Kernel execution id for activity)
  -> tool result to the model: the historical acknowledgement (totals only, NEVER an effort)
  -> next BeforeRequest: snapshot.signals (read-only, like snapshot.activity)
  -> engine: bridge `semantic` events in order, interleaved with activity by seq, with the
     Runtime's own dedup (processedSignalIds <= 100 FIFO, recordSignalId = dispatch identity)
  -> host check_transition: semantic fields may move ONLY as the snapshot's signals explain
```

**Decisions to make in EM-04B (recommendations):**

1. **Core-local tool, no Kernel call.** The tool has no effect outside engine state, so the Kernel
   has nothing to authorize. It is recorded as a `ToolActivity` receipt (status `executed`,
   no execution id) and in the transcript. This keeps it out of the activity feed: a signal is
   semantic, never operational evidence.
2. **Validation of semantic moves.** EM-04A's rule "semantic fields never change" becomes "they
   change exactly as the signals in the snapshot imply". Two options:
   - a small Rust re-statement of the Runtime's transition rules: per event at most +1 per
     counter, totals monotonic, and resets only on false→true establishment edges (the historical
     §progress-window rule);
   - deterministic re-evaluation through the bridge (2× cost).

   Recommended: the Rust re-statement, golden-tested against the bridge with the parity harness.
3. **Ordering.** A signal affects only FUTURE requests (as in DSH). It is folded at the next
   `BeforeRequest`. A phase signal re-baselines the activity frontier through the historical
   `markSemanticTransition`, which the Runtime already applies.
4. **Prompt surface.** Native sends no system-instruction field. The tool's own description
   (1,174 chars, already in the reserve) is the guidance. Any further instruction text is request
   bytes and must be budgeted the same way.

### 2.3 Gates for EM-04B

- `muse-v0` bodies stay byte-identical (EM-04A harness: 66/66).
- The A614 guards stay per mode, as §2.1.
- The parity harness gains signal scenarios: the same signal sequence through DSH
  `observeMuseToolResult`/`applyReasoningSignal` and through the Native tool path give equal
  decisions and state.
- Adversarial cases:
  - forged signal fields (effort, model);
  - replayed dispatch identity;
  - a signal from another generation;
  - a signal smuggled in tool output or narration;
  - oversized arguments.

## 3. From shadow to real adaptive reasoning (EM-04C)

1. **The active engine `muse-v1`.**
   - It is the shadow engine with `may_propose_effort: true`.
   - At `BeforeRequest` it proposes `Change(e)` exactly when the shadow records
     `would = change:e`; otherwise `KeepPinned`.
   - EM-03's machinery then does the rest, unchanged: a durable `effort-selected` before
     authorization, Registry `issue-attempt` under the task binding, Kernel sealing, and
     write-ahead `bind_attempt`.
   - The shadow decision becomes the proposal's evidence.
2. **The ladder decision is already enforced.**
   - Capabilities = `authorized_efforts`.
   - The Governor's own downward-only clamp runs against them.
   - If no level fits, it proposes `KeepPinned`; it never picks a higher level.
   - Default-only bindings keep `low`, because the Governor fails closed on `[low]`.
3. **Registry.** A mode or engine declaration for `muse-v1` is required.
   - `config/registry/parity.cjs` `KNOWN_ORCHESTRATION_ENGINES` (`dual-v1`, `muse-v0`) and
     `legacy-import.cjs` must be extended deliberately.
   - The operator's slot policy must list the Governor levels.
   - Production gate: replace `MUSE_V1_PRODUCTION_ENABLED` with a Registry-issued engine id. The
     engine stays unselectable unless a shipped mode names it.
4. **Bridge cost and the planned worker** (documented only; EM-04A keeps the validated
   per-evaluation process).
   - **Measured** (n = 60): 159 ms median / 196 ms p95 in a debug test build, and 174 / 211 ms in
     release, per evaluation. That is node start-up plus compiling ≈ 66 KB of sources. Over A614's
     59 requests it adds ≈ +6.7 s (51.62 s vs 44.89 s).
   - **Optimization for activation:** a persistent, **stateless**, **supervised** Node worker per
     run (or per broker):
     - *Stateless:* every request carries the complete input (the engine's blocks, events,
       capabilities). The worker keeps no task state between requests. Durable state stays in the
       EM-03 record, the engine stays the only owner of state, and a restarted worker gives
       identical answers.
     - *Versioned contracts:* request
       `{v: 1, op, sourcesDigest, args}`; response `{v: 1, ok, result | code}`. The worker loads
       the embedded sources once and refuses a request whose `sourcesDigest` or `v` differs.
       JSON lines on stdin and stdout, each bounded as today (1 MiB in, 256 KiB out).
     - *Supervised:* the same adapters (virtual fs, fixed clock, require allow-list),
       `env_clear`, and the trusted node binary. There is a per-request deadline. On timeout,
       crash or malformed output the worker is killed and respawned, and the evaluation reports
       an error code: no guess, no retry that could reorder events. It ends with its run.
     - Target: under 10 ms per evaluation. Acceptance: the EM-04A parity harness and adversarial
       suite pass unchanged against the worker.
   - **Alternative:** a Rust port, accepted only if the parity harness passes as its conformance
     suite.
   - Separately, each effort change costs one Registry issuance per new effort (EM-02: ≈ 190 ms
     the first time) and two Kernel seals.
5. **Open policy decisions:**
   - the anti-thrash re-stamp (parity O-1);
   - `requestMax` exposure (out of scope, as in EM-04).

   Decided at the EM-04A review: Native's receipts and verification classification stay
   authoritative (parity §0), and the contract version stays 2 for additive API evolution
   (architecture §7).
6. **Live A/B.** Only after 1–5, with an explicit paid-inference budget approved in advance: the
   same tasks under `muse-v0` (low) and `muse-v1` (adaptive, authorized levels), comparing
   completion, verified edits, attempts, tokens and cost.
