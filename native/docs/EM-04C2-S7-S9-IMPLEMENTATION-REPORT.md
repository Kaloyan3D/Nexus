# EM-04C2 S7–S9 — Release readiness: implementation report

> **Superseded identity (S9.5, commit `b3244c0`):** the adaptive engine described here as `muse-v1` is now **`nexus-adaptive-v1`** (mode `engineering-v2-adaptive` is unchanged). The old id is not an alias anywhere. This document is kept as written; see `EM-04C2-S95-IDENTITY-MIGRATION.md`.


Baseline `0eabd202aec8239133675e8997bd85dd73eef807` (S6, committed). Worktree
`~/Projects/Nexus-muse-release-readiness`, branch `feature/native-muse-release-readiness`. **Uncommitted.**
Companions: `EM-04C2-RECOVERY-AND-STRESS-MATRIX.md`, `EM-04C2-PRODUCTION-GATE-RESULTS.md`,
`EM-04C2-S10-ACTIVATION-CHECKLIST.md`. No live provider, no paid inference, no network download.

## 1. Outcome

The adaptive `muse-v1` engine is release-candidate validated **and still inaccessible**:
`MUSE_V1_PRODUCTION_ENABLED = false`; the mode is `planned`, not selectable, not runnable; no ModeConfiguration is
created; `engineering-v2` still runs `muse-v0`; the Governor/Runtime/Activity/Signals sources are untouched.
The milestone also uncovered — through the first complete run of the JavaScript suites in a working
environment — **seven real regressions that Checkpoint 1 (S4) introduced into existing Registry/Native JS suites
and that had been masked as "environmental failures"**. They are fixed here (§4). Read §4 before trusting any
earlier "JS suites identical to baseline" statement.

## 2. Changed-file inventory

| File | Change | Why |
|---|---|---|
| `config/registry/modes/engineering-v2-adaptive.json` | `+ "requestBudgetBytes": 440000` | S7 sealed budget; mode stays `planned`/non-selectable/non-runnable |
| `config/registry/legacy-import.cjs` | snapshot completeness judged by the three REQUIRED legacy ids, not `modes.length === 3`; the optional adaptive definition is accepted only through a closed identity (fixed file, id and engine + valid mode schema), exported as `isOptionalModeDefinition` | S4 regression (§4), review (§4a) |
| `config/registry/service.cjs` | `listModes` skips the OPTIONAL adaptive mode when no valid definition exists (no phantom row); the on-disk fallback reader applies the same closed identity | S4 regression (§4), review (§4a) |
| `tests/RegistryAdaptiveMode.Tests.cjs` | +9 checks (18): shipped 440,000, validator rejects forged budgets, dormant/not-in-closure, optional-mode handling, closed identity, stray files, read-only/no authorization, saved-configuration compatibility, default compile identity | S7, review (§4a) |
| `tests/RegistryR3UI.Tests.cjs`, `tests/RegistryInstalledRuntime.Tests.cjs`, `tests/NativeTargetV2.Tests.cjs` | expectations updated to the truth (3 legacy modes + the dormant adaptive row; fixture engine `muse-v0`) | §4 |
| `native/nexus-broker/tests/code_a56.rs` | +10 end-to-end tests (`s7_*` ×6, `s8_*` ×4, some multi-part), helpers; the `s4_*` fixtures use the shipped budget | S7, S8 |
| `native/tools/prodgate/` (new package: `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `tests/production_gate.rs`, `tests/worker_gate.rs`) | functional release-mode gates | S9 |
| `scripts/EM04C2-ReleaseGate.cjs`, `scripts/EM04C2-CompareBodies.cjs`, `scripts/EM04C2-JsEnvironment.cjs` (new) | reproducible gate / comparison / JS environment | S9 |
| `native/docs/EM-04C2-S7-S9-IMPLEMENTATION-REPORT.md`, `-RECOVERY-AND-STRESS-MATRIX.md`, `-PRODUCTION-GATE-RESULTS.md`, `-S10-ACTIVATION-CHECKLIST.md` (new) | deliverables | — |

Not modified: any Rust source under `native/*/src` (this milestone changes **no production Rust**), the Governor
family, the bridges, Kernel, contracts, `MUSE_V1_PRODUCTION_ENABLED`, installers, `MusePresetDependencyClosure.cjs`,
manifests and lock files of the project.

## 3. S7 — Registry-sealed adaptive request budget (440,000 B)

| Requirement | Evidence |
|---|---|
| declared on the dormant mode and validated by the Registry | `engineering-v2-adaptive.json`; `RegistryAdaptiveMode` checks: accepted `65536 / 440000 / 449999 / 4194304`; rejected `0, -1, 65535, 4194305, 440000.5, "440000", null, true, [], {}, NaN, Infinity` (mode-invalid) and the same on a runtime binding |
| sealed (Registry → target → binding → Kernel) | `s4_…_a_sealed_budget_to_dispatch`: the issued resolution carries `requestBudgetBytes: 440000` |
| broker values only tighten | `s7_a_broker_value_can_only_tighten_the_adaptive_budget`: a 4,000,000 B broker value leaves max ≤ 440,000; a 380,000 B value gives max ≤ 380,000 |
| a continuation cannot silently change it | `s7_an_adaptive_continuation_keeps_the_sealed_budget_and_a_changed_one_is_refused`: unchanged → same identity, completes; 420,000 and 450,000 → `task-binding-mismatch`, 0 turns, 0 requests |
| applied to the exact serialized request incl. the real Signals tool | every request of the A614 run carries the adaptive catalog (digest `5f7d19e2…`, `muse_update_reasoning_state` present) and is measured as the serialized body |
| protocol-valid after compaction (messages, pairs, reasoning replay) | `s7_reasoning_replay_and_tool_pairs_stay_valid_under_compaction`: 55-read loop with an encrypted reasoning item before every call, under the shipped budget and under the 65,536 B minimum: every replayed reasoning item still immediately precedes the call it produced, calls/results pair, the task message is never cut; max 313,396 B (shipped) |
| oversized requests fail before dispatch | `s7_the_smallest_adaptive_budget_compacts_safely_and_an_impossible_one_fails_before_dispatch`: 65,536 B completes by compacting older steps; a 20,000 B tightening → `request-budget-exceeded`, no request over 20,000 B left the broker |
| the 450,000 B guard is not raised/disabled | untouched; `muse-v0` A614 max still **449,944 B** |
| missing or forged budget rejected | `s7_a_missing_or_forged_request_budget_never_dispatches`: missing → `engine-budget-required`; 1,000 / 5,000,000 / `"440000"` / 440000.5 / 0 → `mode-invalid`; each: 0 requests, 0 turns, no working copy |
| stays `planned`, non-runnable, out of the preset closure | JS check + `production_gate::the_shipped_adaptive_definition_is_dormant_and_budgeted`. **Not** absent from installations: see D-1 |

**Long A614 with the actual adaptive engine and catalog** (`s7_a614_with_the_real_adaptive_engine_…`, debug build):

| | |
|---|---|
| max request | **428,725 B** — against the budget 440,000 (−11,275) and the guard 450,000 (−21,275); EM-04B reference 428,722 (+3 B: the effort string) |
| requests / compactions / wall | 59 / 78 / 65.8 s (four tests running in parallel on 8 cores) |
| tool calls | 55, all paired; task message never cut |

## 4. The S4 regressions found by running the JS suites for real (blocker, fixed)

Checkpoint 1 reported the JavaScript result as "21 passed / 20 failed, identical to baseline". The "baseline"
was the Checkpoint-1 tree itself. Compared with the true pre-adaptive baseline `50a24d7` (plain checkout, no
special environment: 32 pass / 14 fail, every failure environmental), **seven suites that pass at `50a24d7` (each
verified individually) fail at `c292a0e` for real reasons**, which the missing `dsh-tools`/`pwsh` had hidden among
the environmental ones:

| Suite | Cause (S4: the adaptive definition joined the Registry's mode lists) | Fix |
|---|---|---|
| `RegistryCore`, `RegistryR2Compatibility`, `RegistryRequestBudget` | `legacy-import.buildRegistrySnapshot` reported `registry-mode-definitions-incomplete` whenever `modes.length !== 3` — i.e. in every source tree that carries the 4th definition | check the three REQUIRED ids (`legacy-import.cjs`), the optional one may be absent or present |
| `MusePresetRegistryModes`, `RegistryR3UI`, `RegistryInstalledRuntime` | `service.listModes` synthesised a "missing" row for the adaptive mode wherever its file is absent (preset-local copies); and a 4-file tree lists 4 modes | no row for an absent OPTIONAL mode (`service.cjs`); tests now expect 3 legacy + the dormant adaptive row when the tree carries it, which must be non-selectable/runnable/executable |
| `NativeTargetV2` | its fixture binding named engine `muse`, which the S4 closed table (correctly) refuses | fixture uses `muse-v0` |

These are correctness fixes of the Registry's snapshot/listing code (not authorization semantics: the closed
table, saved-configuration rule and sealed identity are unchanged), covered by the new
`RegistryAdaptiveMode` check "snapshot completeness is judged by REQUIRED legacy modes…" (3-file install, 4-file
tree, missing required mode, no phantom row). Tauri and every Rust suite were unaffected.

### 4a. Final Registry review (owner request; diff against the S6 parent and against `50a24d7`)

Acknowledgement: the earlier statements that the Registry JS result was "identical to baseline" / "all exit 0" were
**incorrect**; the seven suites above (`RegistryCore`, `RegistryR2Compatibility`, `RegistryRequestBudget`,
`MusePresetRegistryModes`, `RegistryR3UI`, `RegistryInstalledRuntime`, `NativeTargetV2`) were first broken by S4 and are
fixed in this milestone. Errata were appended to the Checkpoint-1, Registry-authority, S5 and S6 documents.

Diff against `50a24d7` for the two files: `legacy-import.cjs` — the fixed file list gains the optional definition (S4) and
the completeness check is id-based with a closed identity for it (S7–S9); the three legacy files are loaded exactly as
before. `service.cjs` — `SUPPORTED_MODES` and the fallback file list gain the optional id (S4), `previewFor` refuses to
preview/adopt it (S4), `listModes` skips it when no valid definition exists (S7–S9). Nothing else.

| # | Invariant | Verdict and evidence |
|---|---|---|
| 1 | The three historical modes keep their legacy-import semantics | HOLDS. Same files, same loading, same required-ness (a missing or unreadable legacy definition is still `registry-mode-definitions-incomplete`, and now also a legacy file *missing among four* — the old count check would have wrongly passed it). `RegistryCore` 45, `RegistryR2Compatibility` 41, `RegistryR3UI` 29 pass; legacy definitions byte-identical to the baseline's |
| 2 | The adaptive definition is recognized only through a closed, validated identity | HOLDS after a tightening made in this review: the fixed file only, `id == engineering-v2-adaptive`, `orchestrationEngineId == muse-v1`, valid mode schema; any other document at that path (another id incl. a duplicate of `engineering-v2`, another engine, schema-invalid, unknown field, out-of-range budget, array, `{}`, invalid JSON) is treated as absent. Test: `…recognized only through its closed identity…` (mutation-checked) |
| 3 | Unknown or malformed modes never become importable or executable | HOLDS. The loader reads four fixed file names and never scans the directory; stray files (`engineering-v9.json`, `…adaptive.json.bak`, upper-case, `extra.json`) are ignored; `getModeConfiguration`/`save` of unknown ids (incl. `__proto__`, `constructor`, empty) → `unknown-mode` / `ok:false`. Test: `unknown or stray files…` |
| 4 | Listing never invents a mode whose definition is absent | HOLDS for the optional mode (no row); a missing REQUIRED mode is still reported as before (`present:false`). Tests: 3-file install lists exactly the legacy three |
| 5 | When present, the listing reports its dormant status | HOLDS: `status planned`, `selectable false`, `runnable false`, `executable false`, `savedRevision null` (tests in `RegistryAdaptiveMode`, `RegistryR3UI`, `RegistryInstalledRuntime`) |
| 6 | No listing/snapshot/import issues execution authorization or creates operator configuration | HOLDS: `listModes`, `buildRegistrySnapshot`, `getModeConfiguration(adaptive[, adopt])` leave the data root byte-for-byte unchanged and their output contains no issuance/binding/grant/dispatch fields; the dormant mode returns `mode-configuration-required` (no default, nothing adoptable) and a `save` of it is refused. Test: `…read-only and carry no execution authorization` |
| 7 | Existing saved configurations remain compatible | HOLDS: a configuration saved under a 3-file installation is listed, valid and identical under a 4-file one and back (revision 0 preserved; no adaptive entry created). Test: `saved Registry configurations survive…` |
| 8 | Default `engineering-v2` issuance and `muse-v0` unchanged | HOLDS: `compilePreview` of the saved default configuration is identical (modulo the mode list) with and without the definition; the definition names `muse-v0`; the issuer table unchanged; Rust E2E `s4_a_selection_without_a_mode_is_exactly_what_it_was…`, `em01_…`, `em04c1_muse_v0_requests_are_byte_identical…` pass; 1,170 request bodies vs `50a24d7`, 0 unexplained |

Verdict of the focused review: **no invariant violated**; one tightening (item 2) was applied and tested.

### 4b. Installer and activation contracts (owner decision D-1: accepted)

Both installers (`setup.sh` `copy_tree "$AIH_SOURCE_ROOT/config/registry" …`, `Setup.ps1` Registry runtime closure block)
copy `config/registry/` recursively, so every installation physically carries `modes/engineering-v2-adaptive.json`
(`planned`, non-selectable, non-runnable, `requestBudgetBytes 440000`) and the Registry lists it as a non-executable
row. The preset dependency closure (`MusePresetDependencyClosure.cjs`) still excludes it. **Presence or listing grants
nothing**; each barrier below is independent and was exercised:

| Barrier | Why presence/listing cannot bypass it | Evidence |
|---|---|---|
| Engine availability | the engine is registered only in `test-engines` builds while `MUSE_V1_PRODUCTION_ENABLED = false`; no environment variable changes that | `tools/prodgate production_gate` (14/14 incl. self-test) |
| Closed Registry mode/engine mapping | `NATIVE_SCOPES` is a frozen two-entry table in the issuer; the definition file is data, not the table | `RegistryAdaptiveMode` (closed table, 8 mode/engine pairs) |
| Saved operator ModeConfiguration | never auto-created or adoptable; compile/issue fail with `registry-mode-configuration-required` | `s4_the_adaptive_mode_needs_a_saved_configuration…`, read-only check above |
| Allowed reasoning policy | sealed in the target and in the task-binding identity; a change refuses the continuation | `s3_*`, `s6_a_changed_slot_policy…`, `s8_a_real_a4…` |
| Sealed request budget | declared by the definition, validated by the Registry, enforced by the runtime (`engine-budget-required`), tighten-only | `s7_*` |
| Registry and Kernel attempt authorization | per-attempt issuance under the sealed binding, Kernel seal, write-ahead bind — independent of any listing | `s6_an_adaptive_run_changes_effort_only_through_registry_and_kernel…` |
| Definition `planned` / unselectable / unrunnable | `executableOf` refuses `planned`/`runnable:false` modes at compile time (`mode-not-runnable`) | S4 suites, `RegistryR3UI` |

Owner decision D-2: `RegistryR751DependencyCompatibility` must be verified against the lock-file-pinned dependencies
**before S10**; it does not block this commit.

## 5. S8 — recovery and stress (details in the matrix document)

A (crash before acceptance), B (real 6-generation A4 + trusted bypass + policy change), C (continuous worker
kills, stopped workers, cancellation, replays), D (full transaction matrix), E (legacy compatibility: 1,170 request
bodies vs `50a24d7`, **0 unexplained**, non-input fields identical 1,170/1,170): all pass. No new fault semantics.

## 6. S9 — automation (details in the production-gate document)

`native/tools/prodgate` (14 release-mode functional tests, self-tested to fail on leakage),
`scripts/EM04C2-ReleaseGate.cjs` (one command: registry-js 18/18, engines 124/0/2, e2e 15/0, production 14/0 +
symbol scan, bodies), `scripts/EM04C2-JsEnvironment.cjs` (**46/47 suites pass, 0 REAL failures, 1 UNVERIFIED**),
`scripts/EM04C2-CompareBodies.cjs`.

## 7. Findings

| ID | Finding | Disposition |
|---|---|---|
| F-1 | S4 introduced 7 real JS regressions, hidden as "environmental" (§4); the Checkpoint-1 claim "JS identical to baseline" was wrong | fixed + disclosed |
| F-2 | The installers copy `config/registry/` recursively, so **installations carry the dormant adaptive definition** (the S4 report said they do not) | owner decision D-1: accepted (§4b) |
| F-3 | `RegistryR751DependencyCompatibility` cannot be verified without the lock-file-pinned dependency set | UNVERIFIED; owner decision D-2: verify before S10, not a blocker for this commit |
| F-4 | The attempt record keeps the newest 32 attempts; long runs (33+ requests) cannot be compared by position | tests align by ordinal |
| F-5 | An earlier symbol scan of the release test binaries flagged the self-test build's stale artifact | scan now uses cargo's own artifact list |
| F-6 | Cargo's parallel test harness makes tool-result text nondeterministic (line/section order, durations) | the body comparison classifies it explicitly; it never hides a structural difference |
| F-7 | Resuming a *rejected* continuation is accepted and fails before dispatch (`workspace-missing`); that — and not an engine rule — is what stops a rejected continuation from starting the adaptive state from scratch | pinned by a test; a regression guard, not a redesign |
| F-8 | The worker allowance, restart limit and memory budget are as in S1/S6: single-user trusted worker; no OS sandbox | accepted by the owner |

## 8. Validation summary

| Item | Result |
|---|---|
| Full offline workspace battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`) | **1,225 passed, 0 failed, 57 ignored** (91 result lines, exit 0; S6 was 1,215/0/57: +10 = the new end-to-end tests). One green battery, run once on the final tree; two consecutive ones remain an S10 requirement. The historical sandbox failure did not occur and is not claimed eliminated. |
| `code_a56` (on this tree, run for the body comparison before the final edits) | 154 passed, 0 failed, 5 ignored (baseline `50a24d7`: 126/0/5) |
| fmt (workspace and `tools/prodgate`), strict clippy (`--workspace --all-targets -D warnings`; prodgate `--release --all-targets`) | clean |
| Production gates (release, no `test-engines`) | 14 / 14; self-test fails as designed |
| `EM04C2-ReleaseGate.cjs` | all sections PASS |
| JS (disposable environment, final tree, run alone) | 46 / 47 pass, 1 UNVERIFIED (R751), 0 REAL failures. Observation: one run that overlapped a heavy Rust end-to-end subset showed two transient failures (`RegistryR74RollbackRecovery`, `RegistryR75InstallationAudit`, both `pwsh`-driven and timing-sensitive); each passes alone (R74 36/36, R75 in the subset run) and in the clean re-run — load sensitivity, not a regression, but it is why the environment should be run on an otherwise idle machine |
| JS (plain checkout, this tree) | **34 pass / 13 fail** — the 13 are environmental: `@deepseek-ai/dsh-tools` ×2 (`MuseReasoningActivity`, `MuseReasoningSignals`), no `pwsh` ×9 (`RegistryR62Shadow`, `R631Lockdown`, `R632Execution`, `R63Binding`, `R65Matrix`, `R70Readiness`, `R74RollbackRecovery`, `NativeShadowA12`, `NativeShadowA13`), suites that take an install path argument ×2 (`R75InstallationAudit`, `R751DependencyCompatibility`). None is a regression. They are NOT green: they are exactly the suites the disposable environment executes (46/47) |
| Tauri | **27 passed, 0 failed, 2 ignored** (26 unit + 1 integration; same as the baseline) |
| EM-02 / EM-03 / EM-04A,B / Policy V1,V2 / adaptive E2E | inside the battery and the release-gate `engines` section (124 passed) |

## 9. Recommendation

**APPROVE**, with the conditions below.

Evidence for readiness: the sealed 440,000 B budget is Registry-validated, broker-tighten-only, continuation-stable and applied to the exact serialized request with the real adaptive catalog (A614 maximum 428,725 B against 440,000 and the unchanged 450,000 guard); the recovery/stress matrix passes with real brokers over six generations, continuous worker kills, stopped workers, cancellation and every EM-03 fault point; `muse-v0` request bodies are unchanged (1,170 compared against the pre-adaptive baseline, 0 unexplained; A614 max 449,944 B); the production gates are functional, release-mode and self-tested; the full battery is green (1,225 / 0 / 57), as are Tauri (27 / 0 / 2), fmt and strict clippy; the engine is still unreachable (constant closed, mode dormant, no configuration, sealed-budget gate, closed Registry table).

Conditions (all settled or carried to S10): (1) the Registry fixes of the seven S4 JS regressions were reviewed (§4a: no invariant violated, one tightening applied); (2) D-1 accepted, D-2 to be completed before S10; (3) the earlier "identical to baseline" JS statements are withdrawn (errata appended); (4) two consecutive green batteries on the final S10 commit remain a separate requirement.
