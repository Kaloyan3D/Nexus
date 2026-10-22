# EM-04C2 S9 — Automated production gates: design and results

Baseline `0eabd202aec8239133675e8997bd85dd73eef807`. Uncommitted. No live provider, no credentials, no
network, no downloads. The accepted worker threat model is **a single-user trusted Governor worker confined
by Node's permission mode — defence in depth, not an OS sandbox**. Nothing below claims OS confinement.

## 1. The reproducible commands

| Purpose | Command | Result of the last run |
|---|---|---|
| Production-build gates (functional, release mode, no `test-engines`) | `cargo test --release --manifest-path native/tools/prodgate/Cargo.toml` | **14 passed, 0 failed** (6 production + 8 worker) |
| The gate fails when the build leaks (self-test) | `cargo test --release --features selftest-leak --manifest-path native/tools/prodgate/Cargo.toml --test production_gate` | **must fail**: 4 of 6 fail (activation gate, only-muse-v0, experimental engines, published key) |
| One-command compatibility report | `node scripts/EM04C2-ReleaseGate.cjs [--report f.json] [--bodies <base> <new>]` | all sections PASS: registry-js 18/18 suites; engines 124 passed / 0 failed / 2 ignored; e2e 15 passed / 0 failed (sandbox); production 14 passed + clean symbol scan; bodies 1,170 compared / 0 unexplained |
| Request-body comparison against a baseline | `NEXUS_BODY_DUMP_DIR=<d> cargo test -p nexus-broker --test code_a56` on each build, then `node scripts/EM04C2-CompareBodies.cjs <base> <new>` | see the recovery matrix §3 |
| JavaScript suites in a disposable environment | `node scripts/EM04C2-JsEnvironment.cjs [--keep] [--report f.json]` | **46 of 47 pass; 0 REAL failures; 1 UNVERIFIED (environment)** |
| Tauri (Desktop) | `cd apps/nexus-desktop/src-tauri && cargo test` | **27 passed, 0 failed, 2 ignored** (26 unit + 1 integration; same as the baseline) |
| Full offline workspace battery | `cd native && NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast` | **1,225 passed, 0 failed, 57 ignored** (91 result lines, exit 0; S6 was 1,215/0/57: +10 = the new end-to-end tests). One green battery, run once on the final tree; two consecutive ones remain an S10 requirement. The historical sandbox failure did not occur and is not claimed eliminated. |

`native/tools/prodgate` is a separate package (own `[workspace]`, own `Cargo.lock`) on purpose: the broker's own
test targets carry a `test-engines` dev-dependency on themselves, so nothing built inside the workspace can prove
what a production binary contains. Here `nexus-broker` is linked with its **default features**, as a production
build links it.

## 2. Production binary gate (`tests/production_gate.rs`)

Functional tests of the real production code paths first; symbol scanning is a second, weaker line.

| Property | Test | Evidence |
|---|---|---|
| `muse-v0` is available under `engineering-v2`, and **only** that pair resolves | `only_the_default_mode_with_muse_v0_resolves` | 6 modes × 12 engine spellings (incl. `MUSE-V0`, `muse-v0 `, `muse-v1\n`, `../muse-v1`, empty): exactly `("engineering-v2","muse-v0")` is `Ok` |
| `muse-v1`, `-shadow`, `-signals`, `effort-test-v0` unavailable under every mode | `every_experimental_and_adaptive_engine_is_unavailable_under_every_mode` | `engine-unavailable` + "nothing was sent"; `muse-v0` in the adaptive mode → `engine-mode-mismatch` |
| experimental identities cannot be selected through the Registry | same + `MODES × ENGINES` | a Registry resolution naming them reaches `engine::resolve_issued → resolve` and is refused before any request |
| the activation gate is a closed compile-time constant; no environment switch opens it | `the_activation_gate_is_a_closed_compile_time_constant` | `MUSE_V1_PRODUCTION_ENABLED == false` (checked at compile time); five plausible environment variables set to `1` change nothing |
| the published test HMAC key is refused | `the_published_test_hmac_key_is_refused_by_the_real_store` | fingerprint matches the fixture file; `EngineStateStore::open` on a state root whose key *is* the published key → `engine-state-key-refused`; a fresh key is accepted |
| test fault hooks and experimental engines are not executable from production | the four rows above + `EM04C2-ReleaseGate.cjs` symbol scan | `test_faults` / `test_engine` / `EffortTestState` / `EFFORT_TEST_V0` / `armed_for_task` are absent from the **freshly built** release test binaries (the scan locates them through `cargo --message-format=json`; an earlier version scanned stale artifacts and flagged the *self-test* build — the scanner therefore demonstrably detects a leak) |
| the adaptive mode cannot dispatch without its complete authorization chain | `the_shipped_adaptive_definition_is_dormant_and_budgeted` + the closed gate | in a production build the engine is unregistered (gate 1); additionally the shipped definition is `planned`, not selectable/runnable, absent from the preset closure, carries `requestBudgetBytes 440000`, and the default mode still names `muse-v0`. The runtime sealed-budget gate (`engine-budget-required`) and the operator-configuration requirement are exercised by the test-engines E2E suites (`s4_*`, `s7_*`) because they sit *behind* gate 1 |
| catalog identity | `the_frozen_tool_catalog_digests_are_the_pinned_ones` | `RepoCodeV1` `58f513de…`, inspect `b06d9c9f…`, signals/adaptive `5f7d19e2…`; every profile verifies against its frozen bytes; `muse-v1` row by exact id only |

Self-test: with `--features selftest-leak` (broker linked **with** `test-engines`) the same tests fail
(`the_activation_gate…`, `only_the_default_mode_with_muse_v0_resolves`, `every_experimental…`,
`the_published_test_hmac_key…`): the gate is not vacuous.

## 3. Worker security gate (`tests/worker_gate.rs`, release build, bundled Node 24.18.1 **and** system Node 26.10.0)

| Property | Test | Result |
|---|---|---|
| reviewed flag set, deny-all, bounded | `the_reviewed_flag_set_is_deny_all_and_bounded` | `--permission --max-old-space-size=48 --max-semi-space-size=2`, no `--allow*` |
| Node permission mode enforced | `the_permission_mode_denies_filesystem_process_and_addon_access` | under exactly those flags: read, readdir, write, spawn, worker-thread → `ERR_ACCESS_DENIED`; native addon refused; `process.permission.has(fs.read/fs.write/child/worker/addon)` all false; nothing written |
| the worker's start-up proof / no unsafe fallback | `a_node_without_permission_enforcement_never_answers_and_nothing_is_kept` | a `node` shim that drops `--permission` (the worker's own proof fails) and one that rejects it (an old Node) → no answer, `pid() == None`, an error that says why |
| the supervisor refuses any other flag set | `the_supervisor_refuses_every_other_flag_set` | 9 flag sets (permission dropped, `--allow-fs-read=*`, `--allow-child-process`, `--allow-addons`, `--allow-worker`, heap-only, empty, `--inspect`, reordered) → refused, **no process started**; the reviewed set works |
| credentials are not passed | `a_production_worker_runs_under_the_reviewed_flags_with_nothing_inherited` | with `OPENAI_API_KEY` and a planted secret in the parent: worker command line has the reviewed flags only, `/proc/<pid>/environ` is **empty**, descriptors are pipes/anonymous inodes//dev/null only, same uid (stated, not hidden) |
| memory limit | `worker_memory_stays_under_the_budget` | RSS after 2,000 requests: **75.8 MiB** (Node 26.10.0), **77.6 MiB** (Node 24.18.1); budget 100 MiB |
| concurrency limit | `worker_concurrency_is_bounded_by_the_brokers_allowance` | `for_max_active(0)=1`, `(2)=2`, `(10000)=16`; third worker with allowance 2 → `bridge-busy`; a refused spawn takes nothing; the slot returns after shutdown |
| restart, cancellation, crash loop | `restart_cancellation_and_the_crash_loop_limit_hold` | killed worker replaced once; kills in a loop end in `bridge-restart-limit` after **6** spawns; cancel flag → `bridge-cancelled`; shutdown → `bridge-closed`, `pid() == None` |
| durable-state invariants under restart/cancel | `s8_*` E2E (recovery matrix) | see `EM-04C2-RECOVERY-AND-STRESS-MATRIX.md` |

Residual boundary (unchanged, accepted): the worker runs as the broker's user in the same namespaces; the
network is not restricted; Node's permission model is a safeguard, not a hostile-code sandbox. Multi-tenant
deployment is **not** authorized by this gate.

## 4. JavaScript test environment

`scripts/EM04C2-JsEnvironment.cjs` builds a **disposable** environment — a copy of the working tree under
`~/.cache/em04c2-jsenv` (not under the OS temp directory: `RegistryR2Compatibility` asserts that), an isolated
`HOME`, read-only links to the pieces an installation provides and a checkout lacks (`app/` from
`~/.cache/nexus-release-toolchain/app`, `runtime/node`, `runtime/pwsh` from `~/.local/share/nexus/runtime`, the
checkout's `native/target`), the repository's own installer steps (`MusePresetDependencyClosure.cjs prepare` ×3,
`Complete-Install.ps1`), and a second disposable install under `<repo>/tmp/install` for the two suites that take an
install path. Nothing is downloaded; no manifest or lock file is touched; the real installation and credentials
are never read.

Result (47 suites: `tests/Muse*`, `Registry*`, `Native*`): **46 pass; 0 REAL failures; 1 UNVERIFIED** —
`RegistryR751DependencyCompatibility` compares the lock file's pinned dependency versions with the linked
toolchain's (`'0.35.3' !== '0.35.5'`): the only toolchain on this machine is an older installation, and obtaining
the pinned set needs a network download that was not performed. It is **reported as unverified, not passed**.

Plain checkout (no environment), the comparison that matters for regressions (47 suites `Muse*`, `Registry*`,
`Native*`):

| Tree | pass | fail |
|---|---|---|
| `50a24d7` (true pre-adaptive baseline) | 32 (46 suites exist) | 14, all environmental (no `dsh-tools`, no `pwsh`, unbuilt binaries, parameterized suites without their argument) |
| `c292a0e` (Checkpoint 1, S4) | — | the 7 suites `RegistryCore`, `RegistryR2Compatibility`, `RegistryRequestBudget`, `MusePresetRegistryModes`, `RegistryR3UI`, `RegistryInstalledRuntime`, `NativeTargetV2` pass at `50a24d7` and FAIL here for real reasons (implementation report §4) |
| this tree | **34 pass / 13 fail** — the 13 are environmental: `@deepseek-ai/dsh-tools` ×2 (`MuseReasoningActivity`, `MuseReasoningSignals`), no `pwsh` ×9 (`RegistryR62Shadow`, `R631Lockdown`, `R632Execution`, `R63Binding`, `R65Matrix`, `R70Readiness`, `R74RollbackRecovery`, `NativeShadowA12`, `NativeShadowA13`), suites that take an install path argument ×2 (`R75InstallationAudit`, `R751DependencyCompatibility`). None is a regression. They are NOT green: they are exactly the suites the disposable environment executes (46/47) |

## 5. What this gate does not prove

* No live provider: provider behaviour when `reasoning.effort` changes mid-conversation is unobserved.
* The production-build proof is for the library surface and the worker; the *binary* `nexusd`/CLI with a real
  Registry is exercised by the test-engines E2E suites, whose build differs by exactly the `test-engines` feature.
* Two consecutive green batteries on the final S10 commit remain a separate activation requirement.
