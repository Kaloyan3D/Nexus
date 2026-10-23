# EM-04C2 S10 preflight — revalidation handoff

Uncommitted work in `~/Projects/Nexus-s10-preflight` (branch `feature/native-s10-preflight-fixes`, base `d90bbf0`). Nothing pushed, merged, deployed or activated; no provider contacted.

## 1. Closure matrix
| Finding | Status | Code | Tests / evidence |
|---|---|---|---|
| SEC-1 fail-closed continuation | **CLOSED** (offline) | `engine_state.rs:482,746,871`; `inspect.rs:1151,1173,1606,1637`; `store.rs:47`; `server.rs:199` | unit `engine_state.rs:1124`; E2E `code_a56.rs:14699,14751,14818,14912`; 8 mutants killed |
| SEC-2 adaptive compatibility | **CLOSED for the implemented transport**; non-Responses transports / Gemini **not supported, not claimed** | `resolver.cjs:149,161` | `RegistryAdaptiveMode` 22, `RegistryCore` 46; 8 mutants killed |
| SEC-3 budget ceiling | CLOSED | `request_budget.rs:43`, `inspect.rs:1554` | `code_a56.rs:14875` |
| SEC-4 execution-id de-dup | CLOSED | `muse_v1.rs:1127` | `muse_v1_active_tests.rs:1465` (mutation-verified) |
| SEC-5 single-suite reliance | CLOSED | — | `NativeTargetV2`, `RegistryR3UI` additions |
| RG-1 real artifacts | CLOSED for linux-x86_64 | gate `release-binaries`, `desktop-binary`; `nexus-broker engines` | hashes below. Other targets **UNVERIFIED** |
| RG-2/3/4 fail-closed | CLOSED | `scripts/lib/em04c2-gate-lib.cjs`, `EM04C2-ReleaseGate.cjs`, `EM04C2-CompareBodies.cjs` | `EM04C2GateNegativeControls` 13 checks |
| RG-5/6/7/8 | CLOSED | gate filters, `selftest-leak` control, suite list, R751 classifier removed | gate run |
| Parity (2 bodies) | **EXPLAINED** | `TIMING_DEPENDENT_TESTS` (one test) | same-tree 6 vs 7 `### Run` entries in 14 runs; 0 unexplained in 1,170 |
| Crash tests / env | CLOSED | `--workspace` build | `a56_crash_after_*` 2/2 |

## 2. Shipped artifacts (release, default features, linux-x86_64)
| artifact | bytes | sha256 |
|---|---|---|
| nexus-broker | 7,638,112 | 814743d77243649abc965db7ec96e81e8b79ca4535eaf977c9059f9de1c9dea9 |
| nexusd | 6,209,688 | ba9bb28750e3104bae989a50972e62edac68030e4fcfdaebe3e5222eb0d247a1 |
| nexus | 10,202,392 | 9bc2b95fc2ca6ff8a00792f588ec10cd7075dbb0bdbb3930de1605bb7e9caa81 |
| nexus-desktop (Tauri, release) | 7,205,192 | 4cae4f37b30bad95fa3ff5e2fcdb1bb0ddbbe032051cbae60a47f651eed473e3 |
`nexus-broker engines` → registered `["muse-v0"]`, resolvable `[["engineering-v2","muse-v0"]]`, no test features, gate closed. Paths: `native/target/release-gate-bins/release/`, `apps/nexus-desktop/src-tauri/target/release/`. Report: `native/target/release-gate.json`.

## 3. Executed validation (honest statuses)
| Check | Result |
|---|---|
| `cargo fmt --check` (workspace, prodgate); strict clippy (workspace, prodgate, Tauri) | clean |
| Full `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast` | **1,232 passed / 0 failed / 57 ignored** (91 result lines) — twice. Run 1 predates two last small edits (a replay assertion in one test, a prodgate test file lookup); **run 2 is on the final tree. One green battery on the final tree, not two.** |
| `node scripts/EM04C2-ReleaseGate.cjs --bodies …` | **PASS (acceptance run)**: registry-js 22/22, engines 141/0, e2e 33/0, production 14/0 + negative control rejected+detected, release-binaries, desktop-binary, bodies 116 tests / 1,170 bodies / 0 unexplained |
| Prodgate release tests | 14/0 (6+8) |
| Tauri | 27 passed / 0 / 2 ignored |
| JS disposable env, system toolchain | 52/54; 2 REAL failures: R74, R751 (older toolchain) |
| JS disposable env, **lock-pinned** deps (offline `npm ci`) | **53/54 pass; R751 PASSES (D-2 evidence)**; **`RegistryR74RollbackRecovery` FAILS** |

**R74 update (see `EM-04C2-R74-ROOT-CAUSE-REPORT.md`):** investigated; no authorization bypass found; one failure diagnosed as a bundled PowerShell host crash that the controller refused (fail-closed); full pinned JS suite now 54/54 on the final tree; R74 classified env-UNVERIFIED (not PASS) on that signature. Earlier text kept for the record:

**Open: R74.** It fails inside the full JS run (twice here; also failed in S9's run, then called transient) but passes alone (4×) and after R65/R70. Failing check: `R75A actual request boundary rejects drift after pre-step` (reject returned `errorCode: null`). Root cause not found (my attempt to bisect the preceding suites was lost when scratch logs were cleaned). It exercises the legacy Muse request boundary, not the Rust paths changed here. I have **not** shown it is pre-existing on `d90bbf0` in the full run; do that first.

## 4. Naming boundary: `muse-v1` → `nexus-adaptive-v1` (NOT migrated)
Impacted identifiers: engine id `muse-v1` (Rust `engine/mod.rs`, `muse_v1.rs` `ACTIVE_ENGINE_ID`, `MUSE_V1_ACTIVE`, `engine_state.rs`, `attempt_target.rs`, `inspect.rs`, `nexus-model/src/request.rs` catalog row); `muse-v1-shadow`/`-signals` (test-only); `config/registry/modes/engineering-v2-adaptive.json` `orchestrationEngineId`; `native-issuer.cjs` `NATIVE_SCOPES`; `resolver.cjs` `ADAPTIVE_CONTRACTS['muse-v1']` and requirement value `adaptiveReasoningContract`; `legacy-import.cjs`; prodgate and gate scripts; tests (`RegistryAdaptiveMode`, `RegistryCore`, `NativeTargetV2`, `code_a56`). Compatibility: the id is inside the sealed task-binding identity and the HMAC'd engine-state records and run records, so a rename makes any in-flight adaptive task a `task-binding-mismatch` / `engine-continuity-mismatch` (fail-closed). Because the engine has never been enabled in production, renaming before S10 activation has no live data to migrate; do it as one atomic change and re-pin the catalog/identity digests.

## 5. Not claimed
Live-provider behaviour on mid-conversation effort change (R3); non-Responses transports; non-linux targets; multi-tenant isolation; that the sandbox "systemd scope" historical failure is eliminated (it did not occur).

## 6. Verdict
**CHANGES REQUIRED** — narrowly (unchanged after the R74 investigation: root cause of the pwsh host fault and of two earlier undiagnosed failures remains unproven): (1) the full-JS-run failure of `RegistryR74RollbackRecovery` is unexplained; (2) only one full Rust battery is green on the exact final tree. All audit findings SEC-1…5 and RG-1…8 are fixed and verified; the release gate passes as an acceptance run. If the owner accepts R74 as a known non-Native flake (after confirming it fails identically on `d90bbf0`), this is **APPROVE** for S10 revalidation.

## 7. Owner decision on R74 (recorded at commit time)
The owner has accepted the narrowly scoped R74 environmental risk for continued development; it is tracked in GitHub issue #35. This does **not** mean the R74 root cause is solved (it is not; see `EM-04C2-R74-ROOT-CAUSE-REPORT.md`), and it does **not** mean two consecutive green batteries have passed on an S10 activation commit (that requirement is separate and still open). Latest recorded results on this tree: full lock-file-pinned JS suite 54/54, release gate PASS (acceptance run), Rust battery 1,232 passed / 0 failed / 57 ignored (one run).
