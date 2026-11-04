# EM-04B — Signals parity: DSH vs Native

**Result:** the three paths agree on every acknowledgement, refusal code, resolution and final
state, in every scenario:
1. **DSH:** the original `applyReasoningSignal`.
2. **Bridge:** the Core's validation followed by the historical code through the bridge.
3. **Engine:** the full Native path through `muse-v1-signals` and the host.

The remaining differences are three documented, test-pinned items (§4).

## 1. Original DSH suites (unchanged sources, this tree)

| Suite | Result |
|---|---|
| `MuseReasoningSignals.Tests.cjs` | 34 / 34 (scratch copy with the installed DSH app deps; see EM-04A parity §1) |
| `MuseReasoningActivity.Tests.cjs` | 33 / 33 (same) |
| `MuseReasoningGovernor.Tests.cjs` | 52 / 52 |
| `MuseReasoningRuntime.Tests.cjs` | 30 / 30 |
| `MuseRoutingAuthorityOrdering.Tests.cjs` | 28 / 28 |

## 2. Method (`nexus-broker/src/engine/signals_parity.rs`)

Every step list (signal, replayed delivery, trusted tool outcome, request, restart) runs three
times **with the same trusted dispatch keys**, computed from the Core's identity facts. Details:

- **DSH:** `dsh_reference.cjs` drives `Muse-ReasoningSignals.cjs` `applyReasoningSignal` (exactly
  what the DSH tool's `execute` calls). It uses a real temporary routing-state file and real
  registry, `recordMuseToolOutcome` for tools, and a module reload for restart.
- **Bridge:** `signals::validate`, then `evaluate` with `signal` events.
- **Engine:**
  - snapshots carry `SignalObservation`s and activity observations built by `inspect::observe`;
  - `EngineHost::consult_signal` admits each signal, with the host's `fold_signal` validation;
  - `consult_in(BeforeRequest)` produces the shadow decisions;
  - restart = `persist_state` → `restore_state` → a new generation.

**Compared:**
- each acknowledgement object (`ok, duplicate, applied, phase, activityState`, flags, counters)
  or the refusal code;
- each resolution (`outcome, effort, requested, reason, trace, effectivePhase, effectiveSource`);
- the final `museReasoning` (timestamp excluded) and `museActivity` (family label excluded), as in
  EM-04A.

## 3. Scenarios (all equal on all three paths)

| Test | Covers | Efforts |
|---|---|---|
| `escalation and progress windows through the tool` | phase signals; failure events → xhigh; root cause establishment resets the window; solution → de-escalation; implementation failures; invalidation | medium, high, xhigh, high, medium, xhigh, xhigh |
| `malformed, forbidden and effort-selecting input` | 21 refusals with identical codes: `effort`, `reasoningEffort`, `reasoning_effort`, `high`, `max`, `requestMax`, raw counter, `currentEffort`, `state`, `taskInstanceId`, `model`, `provider`, bad, numeric and empty phase, non-boolean events, unknown field, array, string, null; state unchanged afterwards | medium |
| `duplicate delivery applies once` | the same delivery replayed twice (`duplicate: true`, nothing applied); an identical signal in a NEW call applies again (historical: distinct calls always apply) | xhigh |
| `conflicting model claims` | mark + invalidate in one call (invalidation wins, no reset); conflict + new root cause (the establishment edge clears the conflict); resolve + conflict in one call; explicit `false` is a no-op | high, high, xhigh, high, high |
| `verified activity overrides unsupported claims` | claimed solution and `verify`, then a Kernel-verified FAILED check → `recovery-needed`; claiming `review` is a newer semantic transition (historical recency rule); a verified edit → `implementation-active`; an unproven success claim changes no evidence | medium, high, high, medium, medium |
| `restart inherits signals; recovery never manufactures one` | a replay after a restart is still a duplicate (inherited window); new signals apply in the new generation | high, high, xhigh, xhigh |
| `the acknowledgement text is the historical render` | `render_ack` == DSH `output.render` byte for byte |
| `the native tool definition is the historical one` | canonical bytes equal |
| `the core validator agrees with the historical validator` | 19-input corpus, including ECMAScript `trim` edge cases (U+FEFF trimmed, U+0085 not) |

## 4. Differences (none hidden)

**S-1. Identity source** (by design, not a behaviour difference)
- DSH's dispatch key is `rootCallId|callId|signalHash` from the DSH tool context.
- Native's is `n1:` + a digest of generation, attempt, call id and the same `stableSignalHash`,
  computed by the Core.
- Deduplication semantics are equal: the same delivery is a duplicate, a new call is distinct.
  The parity runs use Native's keys on all three paths.

**S-2. Mixed invalid fields**
- With both a forbidden and an unknown field, DSH reports whichever comes first in the object's
  insertion order. Native receives a key-ordered map and checks forbidden fields first.
- Both refuse. Native's code is `forbidden-field` (pinned in the corpus test).

**S-3. Delivery path**
- DSH applies a signal inside the tool's `execute`. Native applies it through the engine and
  makes it **durable before** the acknowledgement.
- On a failed durable write Native fails the run closed. DSH's routing-state write would throw
  inside the tool.
- If the engine cannot apply a signal (bridge unavailable), Native tells the model "not recorded"
  and never applies it later (`last_unapplied`). DSH has no such state.

**Unchanged from EM-04A:** the verification-vocabulary differences (EM-04A parity P-1, 11/36) still
govern which commands are evidence. They are inputs to the activity reducer, not to the signals
path.

## 5. Adversarial and boundary results (`engine/signals_tests.rs`, `engine_state.rs`, E2E)

| Case | Result |
|---|---|
| Signals to `muse-v0`, `muse-v1-shadow` | `engine-signals-unsupported`; nothing changes. In E2E the call is an unknown tool and is refused. |
| Duplicate / replayed delivery | `duplicate: true`; counted once |
| Out-of-order (older seq delivered late), cross-task (another generation), already consumed | `signal-stale`; nothing changes |
| Forged signal that bypassed the Core (`effort` field) | refused again by the historical path (`signal-forbidden-field`); host fold skips it; nothing applied |
| Doctored engine outcome (counted twice, invented phase, key not recorded, `requestMax` smuggled) | `engine-state-transition`; state unchanged |
| Effort change, wrong action, oversized ack, stale revision at signal admission | `engine-effort-not-admitted` / `engine-action-not-admitted` / `engine-ack-invalid` / `engine-state-stale` |
| `Acknowledge` at a regular hook | `engine-action-not-admitted` |
| Bridge unavailable | "not recorded"; never applied later |
| Crash before / after durable acceptance; failed durable write | §6 of the architecture document (E2E) |
| 130 signals + 13 evaluations | processed window capped at 100; state ≤ 16 KiB |
| EM-03 records (EM-04A fixtures) | still reopen byte for byte and continue |
| Published fixture key in a production build | refused (`engine-state-key-refused`) |
