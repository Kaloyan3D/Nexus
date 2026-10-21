# EM-04C2 Checkpoint 1 — Security & Registry foundations: report

Worktree `~/Projects/Nexus-muse-adaptive-foundations`, branch `feature/native-muse-adaptive-foundations`,
created at exactly `50a24d791cdb3c1a4b00eb15b24843c4b45d9798`. **Uncommitted**, for architectural review.
No push, merge or deploy; no paid inference; no live provider; no other worktree modified (read-only
use of `Nexus-muse-production-prep` for a baseline comparison run).

Scope: **S0–S4** of `EM-04C2-ACTIVATION-PLAN.md` (governing sequence), decisions D1–D4 as approved
(D1 limiter: deferred to Checkpoint 2). The three planning documents were copied from the
production-prep worktree with SHA-256 verification (identical; originals untouched):
`EM-04C2-SECURITY-REVIEW.md 57dd8f11…`, `EM-04C2-ANTI-THRASH-POLICY.md b6baf3e0…`,
`EM-04C2-ACTIVATION-PLAN.md bb54a28d…`. Companion documents: `EM-04C2-REGISTRY-AUTHORITY-REVIEW.md`,
`EM-04C2-WORKER-SECURITY-RESULTS.md`.

**Nothing adaptive is active.** `MUSE_V1_PRODUCTION_ENABLED` is still `false`, no `muse-v1` engine is
registered, `engineering-v2-adaptive` is dormant and unreachable (Registry review §3), `muse-v0` is
untouched, and the historical Governor is byte-identical (`git diff` over
`config/Muse-Reasoning{Governor,Runtime,Activity,Signals}.cjs`, `muse_bridge.cjs`, `muse_v0.rs`,
`muse_v1.rs`: empty; the embedded sources and `sources_digest()` are therefore unchanged).

## 1. Results by step

| Step | Delivered | Evidence (all pass) |
|---|---|---|
| **S0** test-environment stability | `sandbox_ready` (test helper, `code_a56.rs`) probes once per binary under a lock, caches a success, retries ONLY the "systemd scope was not created" class up to 3× with back-off, fails permanently-unavailable hosts at once, and **still fails the test when `NEXUS_REQUIRE_SANDBOX` is set**; the product error now appends the sanitised, bounded `systemd-run` stderr (`sandbox.rs`), the helper appends the user-manager state and load; product sandbox unchanged (fail-closed, no retry, no fallback) | 4 helper tests; 2 sanitiser tests (no secret survives; bounded; control characters removed; a stuck reader never blocks); forced-unavailable proof: with `NEXUS_REQUIRE_SANDBOX=1` + `NEXUS_TEST_FORCE_SANDBOX_UNAVAILABLE=1` the test **FAILS** (`NEXUS_REQUIRE_SANDBOX is set but the sandbox is unavailable after 1 probe(s) … (systemd user manager: degraded; loadavg …)`), without the requirement it is skipped; **`code_a56` three consecutive runs on the final code: 137 passed / 0 failed / 5 ignored each** (274 s, 273 s, 271 s) |
| **S1** worker hardening | `--permission --max-old-space-size=48 --max-semi-space-size=2`; start-up permission proof (scopes + 4 canaries) verified by worker and supervisor; fail closed on old Node / missing proof; supervisor refuses any non-reviewed flag set outside test builds; allowance = `min(max_active,16)` | 11 new worker tests + the C1 suites unchanged; see `EM-04C2-WORKER-SECURITY-RESULTS.md`; **RSS after 10,000 requests 77.0 MiB (bundled Node 24.18.1) / 74.1 MiB (system Node 26.10.0)**, target ≤ 100 MiB |
| **S2** audit + no-op | E-1: `signal-handled` events with `applied | duplicate | stale | refused:<code> | unrecorded:<code>`; historical `signal-accepted` untouched and readable. E-2: `engine-effort-noop` in `EngineHost::accept` | 3 audit tests (all five outcomes distinct and durable; a malformed ack is never "applied"; historical records readable), 3 host tests (+1 ordering), 1 durable-record test (byte-identical file after the refusal), E2E assertions on the 3 applied signals |
| **S3** `allowedReasoning` in the identity | identity v2; `taskBindingIdentityVersion: 2` recorded; legacy rule | 3 unit tests (baseline-computed digests pinned), E2E 7 cases + legacy record |
| **S4** adaptive mode, closed table | see the Registry authority review | JS suite `RegistryAdaptiveMode` 9/9; 5 E2E; contract test; identity-mode unit test |

## 2. Changed files (28 modified + 7 new; +2,554 / −82 before this report's additions)

**Registry (JS):** `config/registry/{native-issuer,native-target-v2,native-intent-bridge,service,legacy-import}.cjs`;
new `config/registry/modes/engineering-v2-adaptive.json`; new `tests/RegistryAdaptiveMode.Tests.cjs`.
**Contracts:** `nexus-contracts/src/intent.rs` (`ModelSelection.mode_id`, validation, test).
**Broker:** `attempt_target.rs` (identity v2), `inspect.rs` (worker config + slots, selection `modeId`,
continuity before engine), `pipeline.rs` (selection `modeId`), `server.rs` (slots, mode choice carry-through,
continuation mode, identity version), `store.rs` (`task_binding_identity_version`), `engine_state.rs`
(`signal_outcome`, `signal-handled`, 2 test modules), `engine/mod.rs` (E-2), `engine/worker_bridge.rs`
(flags, slots, proof, flag check), `engine/muse_bridge_worker.cjs` (permission proof);
mechanical `mode_id: None` in `resolution.rs`, `threads.rs`, `nexus-cli/src/main.rs` and tests.
**Tests:** `worker_tests.rs`, `signals_tests.rs` (test hook grants one marker path), `engine/tests.rs`,
`code_a56.rs`, `broker_a53.rs`, `inspect_a55.rs`, `rn2_binding.rs`, `nexus-daemon/tests/e2e/driver.cjs`
(`registry-save-mode`, `issue` selection, install-root Registry code).
**Tools:** `nexus-tools/src/sandbox.rs` (diagnostic text + sanitiser + tests).
**Desktop:** `apps/nexus-desktop/src-tauri/src/lib.rs` (one field, `mode_id: None`; the crate lives outside the
workspace, so the workspace battery does not build it - found and fixed by the Tauri run).
**Docs:** the three copied planning documents (unchanged) and the three checkpoint documents.

## 3. Validation

| Gate | Result |
|---|---|
| fmt `--check`; strict clippy `--workspace --all-targets -D warnings` | clean |
| `code_a56` × 3 consecutive (`NEXUS_REQUIRE_SANDBOX=1`) | **137 / 0 / 5, 137 / 0 / 5, 137 / 0 / 5** |
| Full workspace battery `cargo test --workspace --no-fail-fast` (`NEXUS_REQUIRE_SANDBOX=1`) on the final code | **1,146 passed / 0 failed / 56 ignored** (exit 0) |
| Desktop Tauri (`CARGO_INCREMENTAL=0`) | 27 passed / 0 failed / 2 ignored |
| EM-04A Governor + EM-04B Signals parity and adversarial suites, **one-shot transport** (`NEXUS_TEST_BRIDGE=oneshot`) | 119 passed / 4 ignored |
| Same suites on the **worker** transport (the default) | inside the battery |
| EM-02 authorization, EM-03 recovery matrix and record fixtures, historical engine-state compatibility, sealed budget & continuation, worker IPC/crash/restart/permission, A614 | inside the battery and `code_a56` (pass) |
| Registry / Native JS suites + closure and clean-install suites + the new suite (40 suites) | all exit 0 |
| Original Muse JS suites | Governor 52, Runtime 30, Ordering 28 (plain Node, exit 0); Activity 33 and Signals 34 on a copy with the installed app deps and preset files (as in EM-04A parity §1) |
| `muse-v0` request compatibility vs the baseline commit | see §4 |

**Validation history, preserved and not rewritten:** the last full battery of EM-04C1 was
**1,111 passed / 1 failed / 55 ignored** (the failure was a transient host sandbox/systemd-scope probe that
passed 3/3 in isolation); that result is not a clean baseline and is not described as one. The batteries
of *this* checkpoint are reported separately above. The complete final production acceptance gates —
**two consecutive green full batteries on the final C2 commit** — remain mandatory after S10 and are not
claimed here (this checkpoint has one green battery on uncommitted code).

**Honest account of the failures seen while producing this checkpoint** (none hidden, none hand-waved):

1. *Harness race in one of my own C1 E2E tests* (`em04c1_the_worker_is_lazy_…`): the sampler re-read
   `/proc/<pid>/cmdline` of a worker being torn down and got an empty string (1 of 3 early runs). Fixed
   (skip an empty command line); the three final runs are green.
2. *Disk exhaustion*: one battery run failed 6 tests with `No space left on device` (`/tmp` is a 7.3 GiB
   tmpfs and my scratch build directories had filled it): a host condition, unrelated to the code. I
   freed the space and re-ran; those 6 tests pass in the final battery.
3. *The environment flake S0 targets reproduced on the baseline*: in a full baseline run (50a24d7,
   without S0) `em04c1_the_broker_can_only_tighten_a_sealed_budget` failed with exactly
   `sandbox-unavailable: systemd scope was not created` (1 of 126 tests). The same harness on this tree
   had that class of failure 0 times in 4 full `code_a56` runs. This is small-sample evidence that
   S0 helps, not proof; the root cause of the host condition is still unproven (see the activation plan §5),
   and the diagnostic text added by S0 will say why if it recurs.
4. *Desktop compile break*: the contract field addition broke `apps/nexus-desktop/src-tauri` (outside the
   workspace); caught by the Tauri run, fixed, green.

## 4. Compatibility results

| Subject | Result |
|---|---|
| Provider request bodies of `code_a56` vs the baseline commit (same dump harness, same suite) | 115 tests / **1,111 bodies**: non-`input` fields (`model`, `tools`, `tool_choice`, `parallel_tool_calls`, `stream`, `max_output_tokens`, `reasoning`) identical **1,111/1,111**; whole body identical modulo tool-output text 1,104/1,111; the 7 remaining are two tests with two **concurrent** runs, whose request multisets are identical (arrival order only). Max body 449,944 B. |
| `muse-v0` tool catalog | `58f513de…` unchanged (E2E digest assertion in the adaptive test, every request) |
| Policy-less task-binding identity | byte-identical to the baseline (constants computed by baseline code) |
| Default issuance with / without `modeId: engineering-v2` | identical resolution, core, extension, binding, issuance id |
| Intent serialization without a mode choice | no `modeId` key; payload digests unchanged |
| Historical engine-state records (`signal-accepted`, no identity version) | readable; legacy run without version continues |
| EM-03 record fixtures | reopen byte for byte (inside the battery) |

## 5. Deviations from the plan (and why)

1. **Adaptive definition shipped dormant** (`planned`, non-runnable, non-selectable) instead of "selectable,
   runnable": two independent gates beyond the missing engine; S6 flips it and adds it to the installation
   closure. The plan's S4 text allowed either; the D2 requirement "no production run may gain adaptive
   behavior" favours the dormant form.
2. **Experimental engine ids are listed in the `engineering-v2` table entry** (they drive existing
   fixtures; narrower than the baseline, which accepted any string) — Registry review §6.1.
3. **`parity.cjs` was not changed** (legacy DSH isolation check; belongs with the engine in S6).
4. **Supervisor-level flag lock** (`check_worker_flags`) goes beyond the plan: it makes "no `--allow-*`
   ever" a property of the code.
5. **Order of two continuity checks swapped** so that mode changes surface as `task-binding-mismatch`
   (required by S4); error precedence for "identity changed and engine unavailable" therefore changed.

## 6. Remaining concerns

1. **Residual worker trust boundary** (same uid; network not restricted; Node's permission model is a
   safeguard, not a sandbox) — an open EM-04C2 review gate; not closed here.
2. **Legacy runs with an explicit policy cannot be continued** (fail closed); only engines that can change
   effort could have used the levels, and none shipped.
3. **No client surface chooses the adaptive mode** (conversations, CLI, Desktop send none); the intent
   field exists for coding runs only.
4. **Sandbox flake root cause unproven**; mitigation is diagnostic + test-helper only. Other test files
   that call `sandbox::preflight()` directly (daemon/tools tests) were left unchanged (out of the plan's scope).
5. **`/tmp` capacity**: a full battery plus several worktree builds can exhaust a 7 GiB tmpfs. A host
   operations note, not a code issue.
6. **The limiter (D1), `muse-v1` engine, catalog row, budget declaration** are Checkpoint 2.

## 7. Recommendation

**APPROVE** for architectural review (uncommitted).

Evidence: S0–S4 are implemented as specified, each with positive and negative tests; the adaptive mode is
structurally defined, validated, sealed and unreachable (six independent gates, one E2E run proving the
runtime refusal with a fully activated fixture); continuations can no longer silently change mode or reasoning
authorization; the worker starts only under proven deny-all permission mode at 74–77 MiB after 10,000 requests;
the Governor and `muse-v0` are byte-identical; `code_a56` is green three times in a row and the full battery is
green (1,146 / 0 / 56), Tauri is green, one-shot parity is green. The production-acceptance gates (two
consecutive green batteries on the final C2 commit, OS-confinement decision, limiter) remain ahead.

## 8. Final confirmations before the local commit

1. **A production build cannot issue or select an experimental engine.** A separate crate depending on
   `nexus-broker` WITHOUT `test-engines`, built `--release`, answers: `resolve(engineering-v2, muse-v0)` = Ok;
   `muse-v1`, `muse-v1-shadow`, `muse-v1-signals`, `effort-test-v0` = `engine-unavailable` under
   `engineering-v2` AND under `engineering-v2-adaptive`; `muse-v0` under the adaptive mode =
   `engine-mode-mismatch`; the published EM-03 fixture key is refused (`key_admissible = false`). The Registry
   JavaScript table may let a *fixture* install root name an experimental id in `engineering-v2` (it is
   narrower than the baseline, which accepted any string), but the runtime refuses it, so no run starts; the
   worker's flag lock (`check_worker_flags`) is also active in that build. Existing in-tree evidence for the list:
   `catalog_tests::the_signals_catalog_cannot_be_reached_from_a_production_engine_list`.
2. **The baseline comparison's differences are ordering only.** Non-`input` fields (model, tools, reasoning
   effort, stream, limits) were identical in 1,111 of 1,111 bodies; the input items (task message, reasoning
   replay items, function calls/results, their order and structure) were identical modulo tool-output text in
   1,104; the other 7 bodies belong to two tests that run two runs concurrently
   (`a56_two_concurrent_runs_…`, `a71_two_conversations_running_at_the_same_time_…`), and their request
   multisets are identical - only arrival order differs. The earlier comparison's variable conversation-history
   text (`### Run N` lines) varies between runs of the BASELINE itself. No required task content, reasoning
   replay or serialization difference exists; no new test was needed.

The historical "systemd scope was not created" host condition is **not** claimed eliminated: S0 added
diagnostics and a test-helper retry, and its root cause remains unproven.
