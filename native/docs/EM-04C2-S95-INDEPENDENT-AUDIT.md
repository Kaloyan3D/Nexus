# EM-04C2 S9.5 — Independent security and identity audit

**Verdict: APPROVE FOR LOCAL COMMIT** (no blocking finding; recommendations below are for before S10).

## 1. What was reviewed
Worktree `~/Projects/Nexus-s95-identity`, `HEAD = cb2edbc4b5c7711591a154df84332a977da92df7` (baseline), uncommitted tree = 23 modified files (+171/−106) plus the untracked `EM-04C2-S95-IDENTITY-MIGRATION.md`; `git diff | sha256sum` begins `e9424ed44ef79cfd`. Read-only audit: the only changes I made to tracked files were two temporary audit probes appended to `code_a56.rs`, each removed afterwards (`cmp` against a saved copy confirmed byte-identical restoration). No implementation was fixed. No feature was activated; no provider was contacted.

## 2. A. Scope: identity migration only — verified independently
Method: for every modified non-doc file I reverse-substituted `nexus-adaptive-v1 → muse-v1` and diffed against the baseline blob.
* **12 production/config/script files: residual diff 0 lines** — `legacy-import.cjs`, `engineering-v2-adaptive.json`, `native-issuer.cjs`, `resolver.cjs`, `attempt_target.rs` (test-only text), `effort_limiter.rs`, `governor_parity.rs`, `engine/mod.rs`, `engine/muse_v1.rs`, `muse_v1_adaptive.rs`, `signals_tests.rs`, `engine_state.rs` (a panic string), plus `EM04C2-ReleaseGate.cjs` and `NativeTargetV2.Tests.cjs`. So the change in those files is **exactly** the token rename; no logic, constants, ladders, budgets, contract content or ordering changed.
* `inspect.rs`, `store.rs`, `server.rs`, `engine_state.rs` logic, the Governor (`muse_v0.rs`, JS Governor), `effort_limiter.rs` algorithm, `request_budget.rs`: **not modified** (SEC-1 predecessor logic untouched).
* Residual diffs exist only in tests and are the intended additions: `catalog_tests.rs` (+2 near-miss ids), `engine/tests.rs` (+old id refused in 4 modes), `muse_v1_active_tests.rs` (+1 test), `code_a56.rs` (+1 case), `production_gate.rs` (+old id in two lists), `RegistryAdaptiveMode`/`RegistryCore` (old id now the *unknown-contract* example).
* Unchanged and confirmed: `muse-v0` (`engineering-v2.json` and Rust descriptor), mode ids, `MUSE_V1_PRODUCTION_ENABLED = false` (`engine/mod.rs:66`), contract content (Responses transport, tiers, ladder, raw-model), budgets, routing, Kernel ordering.
* Retained internal names (type/module/static names `MuseV1State`, `MUSE_V1_ACTIVE`, `muse_v1*.rs`, the Governor, `MUSE_V1_PRODUCTION_ENABLED`), test-only engines (`muse-v1-shadow`, `muse-v1-signals`, `effort-test-v0`) and `context-compiler-active-muse-v1` are intentional and unrelated to the sealed identity. `git grep -E "muse-v1([^-a-zA-Z0-9_]|$)"` outside `native/docs` returns only the context-compiler string. No missed runtime reference found.

## 3. B. Closed Registry, installation, no re-entry of the old id
* Rust: one source of identity (`ACTIVE_ENGINE_ID`), used by registration, `resolve`, `tool_catalog_profile`, `build_report` and `inspect.rs`. `resolve` matches `engine_id` exactly; `safe()` only sanitizes messages. No alias, fallback, cache or migration code exists for the old id (grep of engine/, inspect.rs, engine_state.rs).
* Registry: `NATIVE_SCOPES` is a closed frozen table; `engineAllowed` is exact equality — **verified by execution**: `engineAllowed(adaptive,'muse-v1') = false`, `(adaptive,'nexus-adaptive-v1') = true`, `(engineering-v2,'nexus-adaptive-v1') = false`, and six near-miss spellings (trailing/leading space, upper case, `-v2`, newline, empty) all `false`.
* Contract table: `checkAdaptiveContract('muse-v1', …)` → `slot-capability-not-satisfied` (unknown contract).
* Legacy import/installers: I copied `config/registry` to a scratch dir, set a stale `engineering-v2-adaptive.json` with `orchestrationEngineId` and contract `muse-v1`: `isOptionalModeDefinition(stale) = false` (treated as absent — cannot be listed or imported); the real file → `true`. The installers copy the directory recursively (so a reinstall replaces a stale file); preset closure still excludes the adaptive mode. Engine-id grammar in schemas is "non-empty string" only, so the hyphenated new id needs no grammar change. CLI/Tauri/UI sources contain no engine ids.
* Operator side effect (by design, Info): models scoped `engines:['muse-v1']` no longer qualify for the adaptive mode (`checkEngineScope` exact membership) — fail-closed, must be re-scoped.

## 4. C. Persistence and security — independent probes (temporary, restored)
Probe 1 (`code_a56`, mock provider, sandbox): crash an adaptive run after its binding (authentic state exists); load the state record, set `engine_id = "muse-v1"`, `commit()` it under the real HMAC key (it loads as authentic), then resume:
* resume → run `rejected`, `error_code = engine-state-identity`, `turn = 0`, **provider request count unchanged**, no engine state created for the continuation.
* same plus the run record's `engineId` set to the old id → `engine-continuity-mismatch` (earlier gate), `turn 0`, **0 requests**.
Probe 2: after the first refusal, resume the *rejected continuation* (chain through a state-less run to the authentic old-identity ancestor) → again `rejected / engine-state-identity`, `turn 0`, **0 requests** — the chain walk does not launder the old identity and does not start a fresh limiter history (SEC-1: a found-but-foreign record is an error, not "absent").
* Committed tests cover the same ground (unit `a_predecessor_with_the_previous_engine_identity_is_refused_even_when_authentic`; E2E "PREVIOUS adaptive identity" case) and the SEC-1 suite (deleted/damaged/unknown predecessor → `engine-state-missing`) is unchanged and passes. Effort-limiter history cannot be reset or tokens granted through the rename: every path where the old record would be skipped (deleted, unmarked, unproven) is refused by SEC-1, and the identity mismatch is refused before authorization/dispatch.
* Sealed identity: the id flows into task binding, run record and HMAC state from the single constant; E2E asserts the new id in `engineId` and the state. I did not independently recompute binding digests (the report's claim that only adaptive binding digests change is plausible, not executed by me; the muse-v0 request-body parity below supports the `muse-v0` half).

## 5. D. Production dormancy — verified
`MUSE_V1_PRODUCTION_ENABLED = false`; mode file `status planned / selectable false / runnable false`, budget 440000; release gate section `release-binaries` read it and asked the **rebuilt** release `nexus-broker engines`: registered `["muse-v0"]`, resolvable `[["engineering-v2","muse-v0"]]`, no test features, gate closed; no test-only symbol in `nexus-broker`, `nexusd`, `nexus`. Byte check of the release `nexus-broker`: contains `nexus-adaptive-v1` (static descriptor), **no** exact old id, no `armed_for_task`. No operator configuration was created by any run.

## 6. E. Independent test runs (fresh targets; not stale)
To rule out reuse of the implementer's artifacts I ran the gate with **fresh** `--bins-target` and `--prodgate-target` directories (release binaries and prodgate rebuilt from the reviewed tree; the earlier binary's hash and mtime also differed from the pre-rename build), regenerated my own body dump, and rebuilt the desktop release.
| Check | Result |
|---|---|
| `code_a56` incl. crash injection (workspace build, own body dump) | 159 passed / 0 failed / 5 ignored |
| Release gate (fresh targets, `--bodies` vs `50a24d7`): registry-js 22/22, engines 142/0, e2e 33/0, production 14/0 + negative control rejected and detected, release-binaries, desktop-binary, bodies | **PASS (acceptance run)** |
| Body parity vs `50a24d7` | 116 tests, 1,170 bodies: 1,080 identical, 88 volatile tool output, 0 order-only, 2 polling-count-only (the one named timing-dependent test), **0 unexplained**; non-input fields identical (the gate enforces it) |
| Full lock-file-pinned JS suite | 54/54 (R74 passed; the accepted risk, issue #35, is untouched and not re-classified) |
| fmt, strict clippy (workspace + prodgate) | clean |
| Tauri tests | 26 + 1 passed, 2 ignored, 0 failed |
| Full offline workspace battery | **1,233 passed / 0 failed / 57 ignored** (91 result lines) |
Focused suites (`RegistryAdaptiveMode` 22, `RegistryCore` 46, `NativeTargetV2`, `RegistryR3UI`) are inside the gate/JS runs and passed. The body-comparison category mix differs run to run (order-only 0–6, polling-count 0–2); all are the explained categories and unexplained was 0 every time.

## 7. Findings
| # | Severity | Finding | Recommendation |
|---|---|---|---|
| F1 | Low | The old-id rejections at the Registry layer (`engineAllowed` false for the old id; a stale `engineering-v2-adaptive.json` carrying the old id is treated as absent) are true and I verified them by execution, but no committed test pins them (the mechanical rename converted the previous assertions to the new id). | Add 2–3 JS assertions (RegistryAdaptiveMode/NativeTargetV2) before S10. |
| F2 | Low | The committed E2E for an authenticated old-identity predecessor only edits the *run record*; the authenticated-*state* case is covered by a unit test. My probe showed the E2E behaviour is correct (`engine-state-identity`, 0 requests, also through the rejected-continuation chain) but it is not committed. | Promote probes 1–2 into `code_a56.rs`. |
| F3 | Low | Historical reports (EM-04A…S10) and the activation plan/handoffs still name `muse-v1` as the live id. Only the S10 checklist was updated. | Add a supersession note to the activation docs/index so S10 operators do not follow stale names. |
| F4 | Info | Operators with models scoped to `muse-v1` must re-scope; no alias by design. | State it in the S10 operator documentation. |
| F5 | Info | Rust internals keep `muse_v1*` names; reviewers may find the mixed naming confusing. | Optional cosmetic rename after S10. |
| F6 | Info | The report's digest-impact claim (adaptive binding digests change, `muse-v0` unchanged) was not recomputed by me. | Pin with a test when S10 touches binding digests. |
No Critical/High/Medium findings. No evidence of behavior change, authorization bypass, alias, or accidental activation.

## 8. Remaining unverified
Provider behaviour on mid-conversation effort change (R3, live, out of scope); non-Linux targets; R74 root cause (issue #35); two consecutive batteries on the S10 activation commit; binding-digest recomputation (F6); the full-tree check that no *deployed* installation still carries a stale adaptive definition (a reinstall replaces it; a stale one is ignored).

## 9. Activation boundary status
**Closed and unchanged.** Adaptive mode dormant, engine unregistered in production, default `engineering-v2 → muse-v0`, no automatic operator configuration, test-only engines absent from release binaries.

## 10. Before S10
F1–F3 (cheap); the S10 checklist items in `EM-04C2-S10-ACTIVATION-CHECKLIST.md` (gate flip with deliberate updates to the prodgate and catalog tests, mode activation + preset pinning, operator docs, two consecutive batteries on the activation commit); decide on R74 handling per issue #35.
