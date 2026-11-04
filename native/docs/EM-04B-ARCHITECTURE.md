# EM-04B — Muse reasoning signals tool: architecture

Baseline `3941bd0` (EM-04A). Worktree `~/Projects/Nexus-muse-signals`, branch
`feature/native-muse-signals`. Uncommitted, for architectural review.

EM-04B integrates the historical `muse_update_reasoning_state` tool into the Native Muse path. It
is offered only under an isolated, test-only experimental engine. The model may report bounded
**cognitive claims**:
- phase;
- established or invalidated root cause and solution;
- failed hypotheses and implementation attempts;
- conflicting evidence.

They are validated, made durable, replayable and observable by the shadow Governor. A claim never
selects an effort, asserts an execution outcome, touches task authority or reaches the Kernel.
Adaptive effort stays disabled (EM-04C).

## 0. Unchanged

| Area | State |
|---|---|
| `muse-v0` and every production run | 66/66 provider bodies byte-identical to `3941bd0` (read-only + reasoning replay, coding + nudges, all 59 A614 requests at 449,944 B). The source of `engine/muse_v0.rs` is untouched. |
| `RepoCodeV1` / `RepoInspectV1` catalogs | byte-identical (tested as an exact prefix) |
| EM-04A `muse-v1-shadow` | still tool-free. A call naming the signals tool is an unknown tool there, as in production (E2E). |
| Default effort, Registry assignments, Kernel, daemon, Registry JS, `config/` | not modified |
| Request budget | still `None` in production |
| Persisted record schema / `ENGINE_CONTRACT_VERSION` | unchanged (1 / 2). EM-03 fixtures still reopen byte for byte. |

## 1. The tool and its catalog

- **Definition:** `nexus_model::repo_tools::muse_signals_definition()`. The historical name, the
  1,174-character description and the nine event fields are closed with
  `additionalProperties: false`. There is no effort, counter, identity or provider field.
  - A test compares it byte for byte with what `config/Muse-ReasoningSignals.cjs`
    `defineReasoningSignalTool` produces.
  - Size: 2,881 B canonical, +1 separator. This is exactly EM-04A's measured reserve.
- **Catalog:** `ToolProfile::RepoCodeMuseSignalsV1` = `RepoCodeV1` followed by the tool. It maps to
  the Kernel scope `repo-code`, because the tool is not a Kernel tool:
  `tool_id_for_profile(..., "muse_update_reasoning_state")` is `None`.
- **Selection:** `Shared.profile` is `RepoCodeMuseSignalsV1` only when the run's sealed engine is
  `muse-v1-signals` and the run is a coding run. Every other run keeps `mode.profile()`. The
  catalog and the request digest therefore follow the Registry-issued engine; no switch exists.

## 2. Core handling (`signals.rs`, `inspect.rs::signal_call`)

A call of the tool in a `muse-v1-signals` run is **broker-handled control-plane input**. It is
intercepted before the Kernel tool path and never reaches the daemon. Its `ToolActivity` has no
execution id and no journal sequence.

1. **Strict validation**, with the historical rules and codes (`validateReasoningSignal`):
   - an object (`invalid-signal`);
   - forbidden fields first, over all keys (`forbidden-field`): effort selectors, raw counters and
     state, identity, provider, model;
   - unknown fields (`unknown-field`);
   - `phase` a string naming one of the 7 phases after ECMAScript `trim` + lowercase
     (`invalid-phase`);
   - event fields `true`, `false` (a no-op) or absent (`invalid-field`);
   - arguments ≤ 1,024 B (`signal-oversized`).

   A refused signal records nothing. The model gets a tool error with the code. It counts as a
   tool call but is not a signal.
2. **Identity from the Core only.** The `SignalObservation` is
   `{seq, attempt, generation, call_id, dispatch_key, signal}`:
   - `seq` is the call index, shared with the activity feed's ordering;
   - `attempt` is the dispatching attempt;
   - `generation` is the task instance;
   - `dispatch_key = "n1:" + sha256(generation, attempt, call_id, stableSignalHash)[..29]`. It is
     the historical `rootCallId|callId|signalHash` identity, bounded so the historical 100-id
     processed window stays small.

   The model supplies only `signal`.
3. **Claims vs evidence.** Signals travel in `EngineSnapshot.signals`, separate from
   `EngineSnapshot.activity`, the trusted receipts. Engines can read but never write either.
4. **Durable acceptance**, then the acknowledgement (§3). The model receives the historical
   acknowledgement text (`renderAck`, reproduced and compared byte for byte): state labels and
   counters, never an effort. A signal the engine could not apply is reported as "not recorded"
   (a tool error).
5. **A failed acceptance** (refused transition, failed durable write) **fails the run closed**,
   before the acknowledgement and before any further request.

## 3. Engine contract additions (API evolution; no persisted-schema change)

| Addition | Purpose |
|---|---|
| `EngineSnapshot.signals: Vec<SignalObservation>` | read-only claims feed |
| `EngineExtension::propose_signal(...) -> Option<EngineProposal>`, default `None` | only the experimental engine answers |
| `EngineAction::Acknowledge(String)` | admitted ONLY by `consult_signal`; refused at every hook |
| `EngineHost::consult_signal` | admission: proposal id, revision, `EffortProposal::KeepPinned` only (else `engine-effort-not-admitted`), `Acknowledge` ≤ 1,024 B, then the SAME state invariants and engine transition rules as every proposal (`admit_next_state`, shared with `accept`) |
| `EngineRun::consult_signal` | host acceptance → stage → event `signal-accepted` (proposal id + dispatch key) → **durable commit** → acknowledgement |
| `ProposalReceipt.signal` | marks receipts of signal proposals |

**No new `Hook`.** A `Signal` hook would have required an edit to `muse_v0.rs`'s exhaustive match.
Signals have their own admission path instead, and `muse_v0` is untouched.

**Contract version.** The record envelope, HMAC and continuation rules are unchanged, so
`ENGINE_CONTRACT_VERSION` stays 2 (EM-04A §7 rule). The new event kind `signal-accepted` is
written only by the test-only engine; event kinds are free labels in the EM-03 record schema.

## 4. The experimental engine `muse-v1-signals` (`engine/muse_v1.rs`)

It is the EM-04A shadow engine with signals enabled:
- the same `muse-v0` strategy;
- the same shadow Governor, never applied;
- `may_propose_effort: false`;
- `inherits_state: true`;
- `request_reserve_bytes: 0`: the tool is real, so its bytes are in every measured request.

Registered only in `test-engines` builds (`MUSE_V1_PRODUCTION_ENABLED = false`; a production
build's engine list is `["muse-v0"]`, tested).

**`propose_signal` (`take_signals`):**
1. New signals are those of this generation with `seq` above the signal frontier. If there are
   none, the acknowledgement is `signal-stale` and nothing changes. This covers out-of-order,
   cross-task and already-consumed calls.
2. Trusted observations with a `seq` **below** the newest signal are folded first, so the
   historical event order (activity recorded at tool time) holds.
3. Events go to the bridge, where the **historical `applyReasoningSignal`** applies each signal
   (the embedded `Muse-ReasoningSignals.cjs`, with `node:module` refused). This covers validation
   again, dispatch-key deduplication, one Runtime transition with the progress-window resets, and
   the acknowledgement.
4. Any failure (bridge unavailable, historical refusal, invalid output) applies **nothing**:
   - the signals are recorded in `last_unapplied`;
   - the frontier moves past them, so they are never applied later behind the model's back;
   - the acknowledgement says not recorded.

**Host validation (`check_transition`).** The semantic state must equal `fold_signal` applied to
the consumed signals, skipping the unapplied ones. `fold_signal` re-states the historical
transition in Rust:
- duplicates change nothing;
- flags move false → true only; invalidation is the only way back;
- failures count +1 (active and total);
- a newly established root cause resets the hypothesis window and the conflict; a newly
  established solution resets the implementation window;
- the processed window (FIFO 100) records the key.

The parity harness proves the fold equal to the historical code on every scenario, since a
mismatch would have been refused. The adversarial tests prove it refuses doctored outcomes.

Further rules:
- activity may change only by folded observations or an applied signal (a phase re-baselines the
  frontier, historically);
- counters follow the applied and duplicate signals;
- the signal frontier never goes back and follows the snapshot;
- `muse-v1-shadow` can never move a signal frontier.

**Continuation.** The semantic and activity blocks and the processed-id window are inherited, so
a replay of a predecessor's delivery is a duplicate. Counters are inherited. The signal frontier
restarts with the new generation. EM-04A payloads without the signal keys still restore.

## 5. Request size

- The tool adds exactly 2,882 B to every `muse-v1-signals` request.
- A614 with the real tool, budget 449,999 B (reserve 0): max **428,722 B** (< 450,000), 55 calls,
  every request paired, task message kept.
- Serialization of the larger catalog costs +38 µs per request in release (98 → 137 µs for
  4,797 → 7,679 B).
- `muse-v0` requests contain no new byte.

## 6. Recovery

| Point | Durable state | Outcome (E2E) |
|---|---|---|
| Crash before acceptance (`before-signal-accept`) | no `signal-accepted`, no semantic change | continuation: the signal does not exist; the continuation accepts exactly its own calls |
| Crash after acceptance, before the ack (`after-signal-accept`) | `signal-accepted` + state durable | continuation inherits it (the model never saw the ack); no signal manufactured |
| Durable write fails (`persist-signal`) | nothing | run fails closed (`engine-state-unpersisted`); no ack; no further request |
| Replay of a delivery (same dispatch key) | unchanged | `duplicate: true`, nothing applied (also across a continuation) |

Recovery never creates a signal. Signals exist only as the Core's `SignalObservation`s of the
live run, and the frontier plus the processed window prevent re-application.

## 7. Authority boundaries

- **Effort:** a signal never names an effort. `consult_signal` refuses any `Change`, and the
  engine cannot propose effort at all.
- **Already-issued target:** a signal never alters one. Effort is decided only at `BeforeRequest`
  through EM-02/03, and the experimental engine has no effort authority.
- **Execution outcomes:** a signal cannot assert one. Verified outcomes are the Kernel-backed
  activity feed, and a newer receipt overrides an older claim under the historical recency rule
  (parity: claims vs evidence).
- **Registry and Kernel:** unchanged. The tool has no Kernel id and no daemon call.

## 8. Test fixture key protection

- `engine_state::key_admissible`: a **production build refuses** an engine-state key whose
  fingerprint is that of the published EM-03 fixture key (`engine-state-key-refused`). Only
  `test-engines` builds accept it, and both branches are tested.
- Fixtures are read at test time only; there is no `include_str!` in production code.
- The installer (`setup.sh` `copy_tree`) never copies `native/*/tests`.
- The release binary contains neither the fixture key nor the record contents (implementation
  report §3).

## 9. Limitations

1. **Latency:** each accepted signal costs one bridge evaluation plus one durable commit, ≈ 81 ms
   median in release (132 ms debug). That is acceptable for the experimental path. The
   persistent-worker plan of the EM-04B handoff §3.4 applies.
2. **Mixed invalid fields:** when a signal carries both a forbidden and an unknown field, Native
   reports `forbidden-field` where DSH reports whichever comes first in insertion order. Both
   refuse (parity S-2).
3. **Strategy counting:** signals count as tool calls, so the `muse-v0` steer cadence counts them
   in the experimental path only.
4. **No Hook::Signal:** engines that would need a signal hook in the regular proposal flow must use
   `propose_signal`.
