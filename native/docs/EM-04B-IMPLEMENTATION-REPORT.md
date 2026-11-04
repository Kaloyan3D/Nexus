# EM-04B — Implementation report

**Status:**
- Worktree `~/Projects/Nexus-muse-signals`, branch `feature/native-muse-signals`, base `3941bd0`.
- **Uncommitted**, for architectural review.
- No push, merge or deploy; no paid inference; no live provider; no other worktree modified.

Other documents: `EM-04B-ARCHITECTURE.md` (design), `EM-04B-SIGNALS-PARITY.md` (parity),
`EM-04C-ACTIVATION-HANDOFF.md` (next step).

## 1. Changed files

New (3 code files, 1,415 lines; plus 4 documents):

| File | Lines | Purpose |
|---|---|---|
| `nexus-broker/src/signals.rs` | 350 | Core side: strict historical validation, ECMAScript trim, trusted dispatch key, historical ack render, summary |
| `nexus-broker/src/engine/signals_parity.rs` | 673 | three-way differential harness (DSH, bridge, engine) and 9 tests |
| `nexus-broker/src/engine/signals_tests.rs` | 392 | engine and host boundary: admission, stale/cross-task/replay, forged outcomes, hostile engine, continuation, bounds |
| `native/docs/EM-04B-*.md`, `EM-04C-ACTIVATION-HANDOFF.md` | — | deliverables |

Modified (14 tracked files, +1,562 / −294; `inspect.rs` is +142 / −13 ignoring re-indentation of
the wrapped tool block):

| File | Change |
|---|---|
| `nexus-model/src/request.rs`, `repo_tools.rs`, `prepare.rs` | `ToolProfile::RepoCodeMuseSignalsV1`; `muse_signals_definition()`; the code catalog stays a byte-identical prefix |
| `nexus-client/src/inspect_run.rs` | the experimental profile maps to Kernel scope `repo-code` |
| `nexus-broker/src/inspect.rs` | `Shared.signals` / `profile` (from the sealed engine id); snapshot `signals`; `signal_call` intercepts the tool for `muse-v1-signals` only; Governor lent to both shadow engines |
| `nexus-broker/src/engine/mod.rs` | `SignalObservation`; `Acknowledge`; `propose_signal` (default `None`); `consult_signal`; `admit_next_state` shared with `accept`; `ProposalReceipt.signal`; `MUSE_V1_SIGNALS` registered in test builds only |
| `nexus-broker/src/engine/muse_v1.rs` | `muse-v1-signals`; `take_signals`; `fold_signal` (historical transition re-stated for host validation); signal frontier and counters; EM-04A payloads still restore |
| `nexus-broker/src/engine/muse_bridge.cjs`, `governor_bridge.rs` | `Muse-ReasoningSignals.cjs` embedded (byte-equality test); `signal` events through the historical `applyReasoningSignal`; `node:module` refused |
| `nexus-broker/src/engine_state.rs` | `EngineRun::consult_signal` (durable before ack); `persist-signal` test fault; `key_admissible`, which refuses the published fixture key in production; measurement |
| `nexus-broker/src/engine/dsh_reference.cjs`, `governor_parity.rs` | signal steps; helpers shared |
| `nexus-broker/tests/code_a56.rs` | 5 EM-04B E2E tests |

**Not modified:**
- `engine/muse_v0.rs`, `config/`, Registry, Kernel, daemon (`driver.cjs` included), store,
  contracts, tools, Desktop;
- every other worktree. `Nexus-governor-shadow/native/target` was only reflink-copied for the
  throwaway base comparison.

## 2. Behaviour

| Path | EM-04B |
|---|---|
| `muse-v0` (production) and all non-opt-in runs | unchanged: 66/66 bodies identical to `3941bd0`; no tool; the budget stays inactive |
| `muse-v1-shadow` | unchanged (tool-free; a signals call is an unknown tool) |
| `muse-v1-signals` (test builds, fixture mode only) | tool offered; each valid signal is validated → applied by the historical code → host-validated → **durable** → acknowledged; refused signals record nothing; the shadow Governor decides on the signals; effort stays pinned; no Kernel call for signals |

## 3. Tests and gates (`NEXUS_REQUIRE_SANDBOX=1`, final code)

**New tests:**
- unit: 9 signals parity, 3 Core parser, 9 engine and host boundary, 1 fixture key, 1 catalog;
- E2E: 5;
- measurement: 1.

| E2E (`code_a56`) | Proves |
|---|---|
| `em04b_signals_are_validated_durable_and_observed_but_never_select_effort` | the catalog is `RepoCodeV1` + the exact tool; 3 acks (no effort) and 1 `forbidden-field` refusal; 3 `signal-accepted` events, each before the next `attempt-bound`; the shadow reaches escalation `would: change:xhigh`, never applied; every body `low`; Kernel receipts = model requests; signals have no execution ids; the failed `cargo test` is still the trusted evidence |
| `em04b_production_and_shadow_runs_never_offer_or_accept_the_signals_tool` | `muse-v0` and `muse-v1-shadow`: no tool in any body; the call is refused; no signal event |
| `em04b_a_crash_around_durable_acceptance_never_loses_or_invents_a_signal` | before: absent everywhere; after: durable and inherited; the continuation accepts exactly its own calls |
| `em04b_a_signal_that_cannot_be_persisted_is_never_acknowledged` | fails closed (`engine-state-unpersisted`); 1 request only; no event |
| `em04b_a614_long_loop_with_the_signals_tool_stays_under_the_guard` | max **428,722 B** < 450,000 with the real tool in every request (budget 449,999, reserve 0); 55 calls; pairs intact |

| Gate | Result |
|---|---|
| `cargo fmt --check`; strict clippy (`--workspace --all-targets -D warnings`) | clean |
| Full battery `cargo test --workspace --no-fail-fast` | **1,053 passed, 0 failed, 53 ignored** (EM-04A: 1,025/0/52; +28 new, +1 ignored measurement) |
| `code_a56` | 115 passed, 5 ignored |
| EM-01 differential / request-shape guard, EM-02 authorization, EM-03 recovery matrix, EM-03 record fixtures, EM-04A parity and adversarial | inside the battery: pass |
| Production request shape vs `3941bd0` (throwaway copies, same dump harness) | **66/66 byte-identical** (max 449,944 B) |
| Original Muse JS suites | Governor 52, Runtime 30, Ordering 28, Activity 33, Signals 34: all pass |
| Registry / Native JS suites (no JS changed) | 31/33 with the installed pwsh on PATH (plus the 5 Muse suites above). R7.5 and R7.5.1 need a disposable `repo/tmp` installation and fail identically on the baselines; no JS changed. |
| Desktop Tauri (`CARGO_INCREMENTAL=0`) | 27 passed, 2 ignored (= EM-04A) |
| Release build | no `test-engines` cfg; 0 bytes of the fixture key or records; 0 test-engine / fault symbols. The shadow engine ids are present as strings but unselectable: `engines(false) == ["muse-v0"]`, tested. The tool definition is present (offered only under that engine). |
| Fixture key | a production build refuses it (`engine-state-key-refused`; both branches tested). The installer never copies `native/*/tests`. |

## 4. Performance (offline)

| Measurement | debug | release |
|---|---|---|
| Core validation + dispatch key, per signal (n = 50) | 98 µs | 10 µs |
| Signal acceptance: bridge (historical code) + host fold + durable commit (n = 50) | median 131.9 ms, p95 146.9 ms | median 80.6 ms, p95 92.3 ms |
| Catalog serialization, `RepoCodeV1` (4,797 B) → with signals (7,679 B), n = 200 | 704 → 1,053 µs | 98 → 137 µs (+38 µs per request) |
| A614 with the tool (55 reads; the shadow evaluates at every request) | 70.1 s wall, debug, mock provider | — |

## 5. Risks and limitations

1. **Per-signal latency** (≈ 81 ms in release) comes from the per-call bridge process. This is
   acceptable for the experimental path; the persistent worker is required before activation.
2. **Mixed invalid fields** report `forbidden-field` (parity S-2). Both systems refuse.
3. **A failed acceptance fails the run closed.** That is the strict choice. The alternative (keep
   running without the signal) is documented as not taken.
4. **The experimental engine's strategy** counts signals as tool calls (`muse-v0` steer cadence).
5. **The shadow engine ids** appear as strings in the release binary. They stay unselectable by
   construction and test.

## 6. Recommendation

**APPROVE** (for architectural review; uncommitted).
- Production is unchanged: 66/66 bodies identical; `muse-v0` source untouched; no tool; the budget
  is inactive.
- The tool's semantics are the historical ones: three-way parity, identical refusal codes and ack
  text, a byte-identical definition.
- Durable before acknowledgement; replay-safe; crash, recovery and persist-failure behaviour
  proven E2E.
- Model claims never select effort, never reach the Kernel, never override verified receipts.
- A614 with the real tool: 428,722 B < 450,000.
- Battery 1,053/0/53; fmt and strict clippy clean; Tauri 27/0/2; the published fixture key is
  refused in production.
