# EM-04A — Implementation report

**Status:**
- Worktree `~/Projects/Nexus-governor-shadow`, branch `feature/native-muse-governor-shadow`, base
  `b5a939a`.
- **Uncommitted**, for architectural review.
- No push, merge or deploy; no paid inference; no other worktree modified.

**Design:** `EM-04A-ARCHITECTURE.md`. **Parity:** `EM-04A-GOVERNOR-PARITY.md`. **Next:**
`EM-04B-SIGNALS-TOOL-HANDOFF.md`.

## 1. Changed files

New (7 code files, 3,338 lines; plus 4 documents):

| File | Lines | Purpose |
|---|---|---|
| `nexus-broker/src/request_budget.rs` | 592 | RequestBudgetV1: exact sizing, safe-boundary `fit`, 10 tests + 1 measurement |
| `nexus-broker/src/engine/governor_bridge.rs` | 346 | embedded historical sources, `GovernorEvaluator`, bounded `NodeGovernorBridge`, 7 tests |
| `nexus-broker/src/engine/muse_bridge.cjs` | 219 | Native adapters for the three traced DSH hooks; `evaluate` / `ladder` |
| `nexus-broker/src/engine/muse_v1.rs` | 754 | `muse-v1-shadow` engine: delegation to `muse-v0`, shadow evaluation, block validators, transition rules, persist/restore, decision chain |
| `nexus-broker/src/engine/muse_v1_tests.rs` | 651 | shadow guarantee, adversarial, bounds, reserve re-measurement, latency measurement |
| `nexus-broker/src/engine/governor_parity.rs` | 683 | DSH-vs-Native differential harness, 9 scenario tests, vocabulary pinning |
| `nexus-broker/src/engine/dsh_reference.cjs` | 93 | TEST-ONLY DSH reference driver (original modules, real files) |
| `nexus-broker/tests/fixtures/em03-engine-state/` | 5 files | 3 records written by the `b5a939a` code, the throwaway TEST-ONLY HMAC key of their directory (renamed so the `*.key` ignore rule is respected, not bypassed), README |
| `native/docs/EM-04A-ARCHITECTURE.md`, `EM-04A-IMPLEMENTATION-REPORT.md`, `EM-04A-GOVERNOR-PARITY.md`, `EM-04B-SIGNALS-TOOL-HANDOFF.md` | — | deliverables |

Modified (16 tracked files, +826 / −43):

| File | Change |
|---|---|
| `nexus-model/src/prepare.rs` (+45/−29) | per-item serializer extracted as `responses_input_item` (+ `_bytes`); `prepare` calls it (byte-identical output) |
| `nexus-client/src/model_run.rs`, `inspect_run.rs` (+4) | `PreparedModelRun.request_bytes`: exact serialized length |
| `nexus-broker/src/inspect.rs` (+108/−2) | budget step after `prepare` (opt-in); `observe` (receipt → observation); snapshot `generation` / `activity`; Governor lent only to the shadow engine; `is_verification_command` made crate-visible |
| `nexus-broker/src/engine/mod.rs` | `ENGINE_CONTRACT_VERSION` comment: persisted-schema vs API evolution; observation types; `EngineEnv`; `propose_in`, `consult_in`; descriptor `request_reserve_bytes`; `MUSE_V1_PRODUCTION_ENABLED = false`; `engines(test_build)`; `MuseV1` state variant |
| `nexus-broker/src/engine_state.rs` | `EngineRun.env`, used by `consult`; 4 EM-03 record compatibility tests (§3) |
| `nexus-broker/src/context.rs` (+17/−6) | `stub_output` / `shortened` shared with the budget (same bytes) |
| `nexus-broker/src/config.rs`, `main.rs` (+7) | `request_budget_bytes` (`None` in production) |
| `engine/muse_v0.rs`, `test_engine.rs`, `tests.rs` (+3) | `request_reserve_bytes: 0` |
| `nexus-broker/src/lib.rs` | `pub mod request_budget` |
| `tests/code_a56.rs` (+518/−1) | `fixture_engine_with`; 6 EM-04A E2E tests + 1 measurement |
| `tests/broker_a53.rs`, `inspect_a55.rs` (+3) | the new config field |

**Not modified:**
- `config/` (the historical CJS modules, Registry, modes);
- Kernel, daemon (incl. `driver.cjs`), store, contracts, tools, transcript, runtime crates;
- Desktop;
- the original `~/Projects/Nexus` and every other worktree. The EM-03 worktree was only read: its
  `target/` was reflink-copied for the base comparison.

## 2. Behaviour

| Path | EM-04A behaviour |
|---|---|
| `muse-v0`, every production configuration | Unchanged: 66/66 provider bodies byte-identical to `b5a939a`. No budget configured. The activity feed is computed in memory and ignored. |
| `muse-v0` with a budget that is not needed | Byte-identical requests (A614: 59/59, asserted). |
| Budget needed | Exact reduction at safe boundaries, re-prepared and re-checked; otherwise `request-budget-exceeded` before dispatch (0 provider requests, 0 Kernel acceptances). |
| `muse-v1-shadow` (test builds, fixture mode only) | `muse-v0`'s decisions (60×3 identical), plus a durable Governor decision per request. Every request carries the pinned effort; no `effort-selected` event; one Kernel issuance per run. |

## 3. Tests

**New tests:**
- unit: 10 budget, 7 bridge, 9 parity, 11 shadow engine, 4 EM-03 record compatibility;
- end-to-end: 6;
- measurement (`#[ignore]`, run explicitly): 3.

| E2E test (`code_a56`) | Proves |
|---|---|
| `em04a_the_shadow_governor_decides_on_trusted_receipts_but_never_changes_a_request` | discover → medium; a failed `cargo test` → `recovery-needed` / high; a write → `implementation-active` / medium; all decisions durable with evidence and chain; every body `low`; no selection; one issuance; no signals tool; no model text |
| `em04a_a_default_only_binding_keeps_low_and_the_governor_fails_closed` | no slot policy: every decision `capability-unavailable`, `would: keep`, all `low` |
| `em04a_a614_long_loop_leaves_measured_room_for_the_signals_tool` | max 425,840 B ≤ 447,117 (449,999 − 2,882); + tool = 428,722 < 450,000; 55 calls; pairs intact; task message kept |
| `em04a_a_request_that_cannot_fit_the_budget_fails_before_dispatch` | explicit failure; 0 requests; 0 Kernel receipts; reserve > target refused |
| `em04a_a_lost_answer_under_the_budget_is_retried_within_it` | lost answer under an active budget: recovered once, every body within budget and paired, no command dispatched twice |
| `em04a_the_shadow_state_survives_a_crash_restart_and_continuation` | injected crash, restart, resume: lineage `inherited`, history and chain continue, evidence inherited, all `low` |

**Validation gates** (`NEXUS_REQUIRE_SANDBOX=1`):

| Gate | Result |
|---|---|
| `cargo fmt --check`; `cargo clippy --workspace --all-targets -D warnings` (includes test-engine code) | clean |
| Full battery `cargo test --workspace --no-fail-fast` (final code) | **1,021 passed, 0 failed, 52 ignored** (EM-03: 979/0/49; +42 new, +3 ignored measurements; the 49 multi-UID tests unchanged). After review: +4 compatibility tests and comment and doc edits only, validated in a targeted run (§3). |
| `code_a56` | 110 passed, 5 ignored (104 + 6 EM-04A; +1 ignored measurement) |
| EM-01 differential (48,000 decisions) and request-shape guard; EM-02 authorization suites; EM-03 recovery matrix (all 28 rows) | inside the battery: pass, unchanged |
| A614 regression (`a614_a_long_loop…`) | pass; max 449,944 B (unchanged) |
| Provider request shape vs `b5a939a` (throwaway copies, same harness as EM-02/03) | **66/66 byte-identical** (read-only + reasoning replay: 2; coding + nudges: 5; A614: 59) |
| Desktop Tauri (`CARGO_INCREMENTAL=0`) | 27 passed, 2 ignored (= EM-03) |
| EM-03 record compatibility (after review): `engine_state::em03_records_compatibility` against records written by `b5a939a` | 4/4: byte-exact reopen, authenticate, continue (`muse-v0` interrupted / completed, `effort-test-v0` inherited + reset + re-proposed), shadow refuses to reinterpret |
| Release build | no `--cfg feature="test-engines"` in either rustc invocation; 0 test-engine symbols; `muse-v1-shadow` absent (gate `false`) |
| Original Muse JS suites | Governor 52/52, Runtime 30/30, Ordering 28/28, Activity 33/33, Signals 34/34 (parity §1) |
| Registry / Native JS suites (no JS changed) | 34 of 36 pass. With the installed `pwsh` on PATH: R6.2, R6.3, R6.3.1, R6.3.2, R6.5, R7.0, NativeShadowA12/A13 pass, and R7.4 passes 36/36 uncapped. R7.5 / R7.5.1 need a disposable `repo/tmp` installation and fail identically on the `b5a939a` copy. |

## 4. Parity with DSH

All scenarios decide identically:
- phases, escalation, de-escalation, root cause, capability limits, restart/continuation,
  trusted reductions;
- 11 verification-vocabulary differences, pinned by a test;
- one historical behaviour preserved (O-1).

Details: `EM-04A-GOVERNOR-PARITY.md`.

## 5. Performance (measured separately, offline)

| Measurement | debug (test build) | release |
|---|---|---|
| Governor bridge evaluation, n = 60 (consult incl. node spawn + compile) | median 159 ms, p95 196 ms | median 174 ms, p95 211 ms |
| Budget: exact sizing of a 453,952 B / 111-item conversation, n = 50 | median 70.6 ms, p95 88.4 ms | 2.23 ms, p95 4.06 ms |
| Budget: reducing `fit` on it | median 71.9 ms, p95 89.1 ms | 2.77 ms, p95 4.87 ms |
| Budget on a request that already fits | 0 (decided by the exact prepared length) | 0 |

A614 (59 requests, debug test build, same fixture type, two alternating rounds; steady-state
round 2):

| Configuration | Wall | Max request |
|---|---|---|
| `muse-v0`, no budget | 44.89 s | 449,944 B |
| `muse-v0`, budget 449,999 (not needed) | 45.41 s | 449,944 B (bodies identical) |
| `muse-v1-shadow`, no budget | 51.62 s | 449,944 B |
| `muse-v1-shadow`, budget 449,999 (reserve 2,882) | 54.95 s | 425,840 B |

Round 1 (warm-up) ranged 51–74 s. Shadow bridge ≈ +6.7 s per 59 requests; budget reductions
≈ +3 s (debug).

**Paid provider requests: none.** Existing non-opt-in runs incur no new request of any kind; the
bridge runs only for the shadow engine.

## 6. Risks and limitations

1. **Bridge latency** (≈ 0.17 s per request) is acceptable for a test-only shadow. Activation needs
   a persistent worker or a parity-gated Rust port (handoff §3.4).
2. **Vocabulary differences** (parity P-1) mean the shadow's `recovery-needed` /
   `verification-passed` follow Native's verdicts, which differ from DSH's for 11 of 36 corpus
   commands.
3. **Engine contract version** stays 2 with additive changes (architecture §7). This is flagged
   for review.
4. **`request_budget_bytes` is broker-wide**, not per mode. EM-04B moves it into the sealed mode.
5. **A single step larger than the budget** fails the run explicitly. The latest step is never
   cut.
6. **Activity and Signals JS suites** need the DSH app dependencies and were run in a read-only
   scratch copy with the installed app linked in. Several Registry suites need `pwsh` (installed
   runtime used) or a `tmp/` directory (run in the throwaway copy).
7. **Run-store directory sync** (EM-03 follow-up `task_158c3cc1`) is unchanged and out of scope.

## 7. Recommendation

**APPROVE** (for architectural review; uncommitted). Evidence:
- **Unchanged production path:** 66/66 provider bodies identical to `b5a939a`; A614 449,944 B;
  muse-v0 decisions unchanged (EM-01 differential); default `low`.
- **No new request fields, tools, model, provider or route switching;** no paid request.
- **Exact budget:** proven at and across the byte boundary, for multibyte text, long results,
  reasoning replay, retries and failure. It fits the future tool with measured headroom: 428,722 B
  with the tool, under the 450,000 B A614 guard.
- **Historical Governor reused unchanged** through a bounded bridge, with DSH == Native in every
  scenario. All differences are pinned by tests and documented.
- **Trusted feed and durable shadow state:** no second ledger; the state survives crash, restart
  and continuation. Every adversarial case is refused by its specific rule.
- **Authority unchanged:** Registry and Kernel keep authorization; `may_propose_effort: false`;
  the shadow engine is not selectable in production.

**Review decisions** (applied before the commit):
1. **Contract version:** it stays 2. There is no migration, because persisted records and their
   recovery interpretation are unchanged. This is proven by the EM-03 record compatibility tests
   and stated in the code comment and architecture §7.
2. **Verification classification:** Native's receipts stay authoritative and the Governor is
   unchanged. The 11/36 differences are documented, and algorithmic parity is separated from
   end-to-end activity-semantic parity (parity §0, P-1).
3. **Bridge performance:** the validated CJS process stays. The measured latency and the
   persistent, stateless, supervised worker with versioned contracts are documented and not
   implemented (handoff §3.4).
