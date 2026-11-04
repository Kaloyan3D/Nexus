# EM-04C2 S9.5 — Adaptive engine identity migration: `muse-v1` → `nexus-adaptive-v1`

Base `cb2edbc4b5c7711591a154df84332a977da92df7`. Worktree `~/Projects/Nexus-s95-identity`, branch `feature/native-s95-identity-migration`. **Uncommitted, for independent review. No activation.** `MUSE_V1_PRODUCTION_ENABLED = false` (constant name kept: it names the feature boundary, not the engine id), adaptive definition still `planned` / `selectable:false` / `runnable:false`, default `engineering-v2` → `muse-v0` unchanged, mode id `engineering-v2-adaptive` unchanged, no routing change, no new transport/provider/data-use tier/ladder level, no paid inference, no other worktree touched.

## 1. Identity map (runtime / persistent identities only)
| Where | Old | New | Notes |
|---|---|---|---|
| Rust engine id, `engine/muse_v1.rs` `ACTIVE_ENGINE_ID` (descriptor `engine_id`) | `muse-v1` | `nexus-adaptive-v1` | single source: registration, `resolve`, `build_report`, `tool_catalog_profile`, run-record `engine_id`, engine-state records, task-binding `orchestrationEngineId` all derive from it |
| Registry mode definition `engineering-v2-adaptive.json` `orchestrationEngineId` | `muse-v1` | `nexus-adaptive-v1` | still dormant |
| Same file, slot requirement `adaptiveReasoningContract` | `muse-v1` | `nexus-adaptive-v1` | contract table key renamed with the engine |
| `native-issuer.cjs` `NATIVE_SCOPES['engineering-v2-adaptive'].engineId` | `muse-v1` | `nexus-adaptive-v1` | closed table; `engineering-v2` still only `muse-v0` + experimental ids |
| `resolver.cjs` `ADAPTIVE_CONTRACTS` key | `muse-v1` | `nexus-adaptive-v1` | contract content **unchanged** (Responses transport only; tiers standard/contributor; ladder low…xhigh; raw-model; toolCalling+reasoning) |
| `legacy-import.cjs` `OPTIONAL_MODE.engineId` | `muse-v1` | `nexus-adaptive-v1` | optional dormant-mode handling |
| Model scoping value (`model.engines[]`) accepted for the adaptive mode | `muse-v1` | `nexus-adaptive-v1` | operator-owned; the shipped catalog scopes none |

**Deliberately NOT renamed**
* `muse-v0` (production default); `muse-v1-shadow`, `muse-v1-signals`, `effort-test-v0` (test-only engines; separate identities; still absent from production builds — verified by the release binary report and prodgate).
* The Muse Reasoning Governor, `MuseV1State`/`MUSE_V1_ACTIVE`/`muse_v1*.rs` Rust names and module paths, `LimiterState`, Policy V2, `MUSE_V1_PRODUCTION_ENABLED` — internal implementation names, not identity; renaming them is cosmetic and was left out to keep the diff reviewable.
* `config/ContextCompilerActiveMuseV2.cjs` (`context-compiler-active-muse-v1`, an unrelated context-compiler revision string).
* Historical documents (EM-04A…S10 reports) keep the old name as history; only `EM-04C2-S10-ACTIVATION-CHECKLIST.md` (forward-looking instructions) was updated and `EM-04C2-S10-REVALIDATION-HANDOFF.md` §4 got a pointer to this document.

## 2. Modified files and why
Registry: `config/registry/{modes/engineering-v2-adaptive.json, native-issuer.cjs, resolver.cjs, legacy-import.cjs}` (identity + contract key). Rust: `engine/muse_v1.rs` (the constant; comments), `engine/mod.rs` (production-gate/`build_report` list; comments), `engine/{effort_limiter,governor_parity,muse_v1_adaptive,signals_tests}.rs`, `engine_state.rs` (comments/panic text only), `attempt_target.rs` (test uses the id as an "other engine"). Tests: `engine/{catalog_tests,tests,muse_v1_active_tests}.rs`, `tests/code_a56.rs`, `native/tools/prodgate/tests/production_gate.rs`, `tests/{RegistryAdaptiveMode,RegistryCore,NativeTargetV2}.Tests.cjs`. Gate: `scripts/EM04C2-ReleaseGate.cjs` (expected definition). Docs: this file, the checklist and handoff pointer. The change is a token-exact replacement (no occurrence of `muse-v1-shadow`/`-signals` or the context-compiler string was touched), followed by manual review of every test that used the old or the new name as an *unknown* example.

## 3. Sealed identity and persistence implications
* The engine id is part of the sealed task-binding identity, the Kernel-sealed `orchestrationEngineId`, the run record (`engineId`) and the HMAC'd engine-state record (`engine_id`). All derive from the one constant, so a new run is consistent end to end (E2E asserts `engineId` in the run record and `st["engineId"]` in the state).
* **No alias, no data migration.** Anything recorded under `muse-v1` (none can exist in production: the gate has never been open) is simply an unknown engine: `resolve` → `engine-unavailable`; a run record bound to it → `engine-continuity-mismatch`; an authenticated engine-state record carrying it → `engine-state-identity`; `ADAPTIVE_CONTRACTS['muse-v1']` → unknown contract, refused. A verified migration would need a separate, explicit design.
* Digests: the tool-catalog digests are of the frozen tool bytes, not of the engine id (unchanged: `58f513de…`, `b06d9c9f…`, `5f7d19e2…`). The task-binding identity digest changes for adaptive bindings only (it contains the engine id); `muse-v0` binding digests are unchanged (body parity below).

## 4. Security invariants (each has a test)
1. `nexus-adaptive-v1` resolves only in `engineering-v2-adaptive` and only in test-engines builds / after the compile-time gate opens: `engine/tests.rs`, `muse_v1_active_tests` (production gate registers only it, only when opened).
2. The old id, near-miss spellings (`muse-v11`, `NEXUS-ADAPTIVE-V1`, whitespace, path tricks) are refused / get no signals catalog: `engine/tests.rs` (4 modes × old id → `engine-unavailable`), `catalog_tests.rs`, prodgate `ENGINES`/unavailable lists, `RegistryAdaptiveMode` + `RegistryCore` (unknown contract).
3. A predecessor with the previous identity fails closed, even if authenticated: new unit `a_predecessor_with_the_previous_engine_identity_is_refused_even_when_authentic` (record re-committed under the real HMAC key with `engine_id = "muse-v1"` → `engine-state-identity`, nothing created); E2E `s10_a_run_record_that_cannot_prove…` new case "PREVIOUS adaptive identity" → `engine-continuity-mismatch`, **0 provider requests**.
4. Kernel seal / task binding / HMAC state remain mutually consistent: `s6_*`, `s7_*`, `s8_*`, `s10_*`, em03 compatibility tests unchanged and green.
5. Dormancy: mode file `planned/false/false`, budget 440000, default `muse-v0` — checked by the gate (`release-binaries`), prodgate, `RegistryAdaptiveMode`, `RegistryR3UI`.
6. Production artifacts: `nexus-broker engines` on the real release binary → registered `["muse-v0"]`, resolvable `[[engineering-v2, muse-v0]]`, no test features, gate closed; no test-only symbol in any release executable.

## 5. Executed validation (this tree, uncommitted)
| Check | Result |
|---|---|
| `nexus-broker` lib tests | 290 passed / 0 failed / 7 ignored |
| Registry JS (`RegistryAdaptiveMode` 22, `RegistryCore` 46, `NativeTargetV2` 18, `RegistryR3UI` 29, InstalledRuntime, PresetRegistryModes, R2Compatibility 41, IntentBridge, RegistryCatalog, TaskBinding, DispatchIntent, RequestBudget) | all pass |
| Full lock-file-pinned JS suite (54 suites) | **54/54** (`RegistryR74` passed in this run; its accepted environmental risk, issue #35, is unchanged and unresolved) |
| `code_a56` (workspace build, incl. crash injection) | 159 passed / 0 failed / 5 ignored |
| Release gate with `--bodies` (registry-js 22/22, engines 142, e2e 33, production 14 + negative control, release binaries, desktop binary, bodies) | **PASS (acceptance run)** |
| Legacy request bodies vs `50a24d7` | 116 tests, 1,170 bodies: 1,076 identical, 88 volatile tool output, 6 order-only (concurrent arrival), 0 polling-count, **0 unexplained**; non-input fields identical 1,170/1,170 (previous run: 1,078/…/4 order-only: the shift is arrival order of concurrent runs, same category) |
| fmt, strict clippy (workspace, prodgate) | clean |
| Full offline workspace battery | **1,233 passed / 0 failed / 57 ignored** (91 result lines; +1 = the new identity test) — one run on this tree |
Exceptions: R74 environmental risk (issue #35) unchanged; two consecutive batteries on an S10 activation commit are **not** claimed.

## 6. Still required in S10 (activation) — unchanged by this migration
Flip `MUSE_V1_PRODUCTION_ENABLED`; update the production-gate tests deliberately (`only_the_default_mode_with_muse_v0_resolves` now also `(engineering-v2-adaptive, nexus-adaptive-v1)`, the "unavailable under every mode" list, the gate-constant test, `catalog_tests`/`signals_tests` assertions); make the mode `active/selectable/runnable` and pin it in `MusePresetDependencyClosure.cjs`; update the suites that count assets / assert dormancy; operator documentation (cost, F-5, threat model, rollback incl. the identity change: rolling back leaves `nexus-adaptive-v1` records unresolvable by design); two consecutive green batteries on the activation commit; the live provider observation (R3) separately.
