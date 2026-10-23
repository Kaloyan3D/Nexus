# EM-04C2 S10 preflight corrections

Baseline `d90bbf0faa29da89e4883f126b321cbba278320c`, worktree `Nexus-s10-preflight`, branch `feature/native-s10-preflight-fixes`. **Uncommitted. NO ACTIVATION**: `MUSE_V1_PRODUCTION_ENABLED = false`, the adaptive definition stays `planned` / `selectable:false` / `runnable:false`, the default `engineering-v2` still runs `muse-v0`, no ModeConfiguration is created, no provider was contacted.

## 1. SEC-1 — fail-closed continuation recovery

Rule: a continuation of an engine that **inherits state** never starts a fresh logical-task limiter state unless the broker's own records PROVE nothing was ever spent.

| Situation (predecessor run has no authentic engine record) | Outcome |
|---|---|
| record exists but is tampered / truncated / garbage / empty | `engine-state-corrupt` (never skipped) |
| record deleted after the run created it (`engineStateStarted == true`) | `engine-state-missing`, before authorization, 0 requests |
| run record predates the marker (`engineStateStarted` absent) | `engine-state-missing` (unknown ≠ empty) |
| bound to another / no engine | `engine-continuity-mismatch` / `engine-state-missing` |
| any dispatch sign (turn, HTTP status, provider ids, usage, non-quiet state) | `engine-state-missing` |
| chain cut, cyclic, or deeper than 8 | `engine-state-missing` |
| run bound to this engine, marker `false`, no dispatch sign (crash before the first durable engine-state commit) | proven-fresh start, rule `no-state-proven-undispatched`, default effort, no tokens granted |
| state-less run(s) in between, all proven quiet, and an ancestor with authenticated state | history inherited from the ancestor (event `predecessor-state-from-ancestor`) |

Nothing is inferred from model-authored data; `droppedBefore`/tokens are never cleared or granted by the recovery path.

Code: `engine_state.rs:482` (`Predecessor`), `:746` (`examine_predecessor`), `:871` (`state_source`); `inspect.rs:1606` (`may_have_dispatched`), `:1637` (`predecessor_of`, bounded chain walk), `:1151` (new fault point `before-engine-state`), `:1173` + `server.rs:199` (`mark_engine_state_started`), `store.rs:47` (`engine_state_started: Option<bool>`, `Some(false)` at creation). Non-inheriting engines (`muse-v0`) keep rule `pre-em03-no-state` unchanged.
Tests: unit `engine_state.rs:1124`; E2E `code_a56.rs:14699` (crash before first state → continued), `:14751` (5 damage variants + replay: second resume refused, 0 requests), `:14818` (chain: ancestor inheritance / ancestor destroyed), `:14912` (7 run-record fact variants). Every refusal asserts zero provider requests.

## 2. SEC-2 — enforced adaptive compatibility
`config/registry/resolver.cjs:149` `ADAPTIVE_CONTRACTS` + `:161` `checkAdaptiveContract`: closed table; unknown contract → `slot-capability-not-satisfied`; `muse-v0` keeps its legacy `contributor` rule untouched; `muse-v1` requires declared data-use tier ∈ {standard, contributor}, tool calling + reasoning, `raw-model`, transport `openai-responses`, optional wireProfile `opencode-go-responses`, ladder low/medium/high/xhigh. Tests: `RegistryAdaptiveMode` (22 checks, SEC-2 block from line 479), `RegistryCore` (46).
**Blockers stated, not hidden:** only the Responses transport is implemented/tested — **no Gemini / chat-completions / Anthropic / local transport is claimed**; with the shipped catalog only Muse Spark via OpenCode Go qualifies; whether `standard` data-use should be allowed is an owner decision; provider behaviour on mid-conversation effort change (R3) is unprovable offline.

## 3. SEC-3/4/5
* SEC-3: `request_budget.rs:43` `MAX_REQUIRED_SEALED_BUDGET_BYTES = 450_000`, enforced at `inspect.rs:1554`; test `code_a56.rs:14875` (450,001 and 4,194,304 refused with 0 requests; 450,000 runs).
* SEC-4: `engine/muse_v1.rs:1127` execution-id de-dup in the host recount; test `muse_v1_active_tests.rs:1465` (fails without the fix — verified by mutation).
* SEC-5: `NativeTargetV2` (mode/engine table + saved-config + unsupported scopes) and `RegistryR3UI` assertions added.

## 4. Release gates (RG-1…RG-8)
* New decision library `scripts/lib/em04c2-gate-lib.cjs`; verdicts PASS/FAIL/UNVERIFIED/SKIPPED; overall FAIL=exit 1, INCOMPLETE=exit 2 (any UNVERIFIED/SKIPPED, empty run), PASS=0; `--allow-skip <name>` passes but is never an acceptance run. **RG-3**
* **RG-2**: no `strings` dependency — Node byte scan; unreadable/empty/tiny artifact = UNVERIFIED.
* **RG-1**: section `release-binaries` builds `nexus-broker`, `nexusd`, `nexus` (release, default features, `--offline`), requires `cargo tree` to show no `test-engines`/`test-fixtures`, scans each executable, and asks the shipped binary (`nexus-broker engines`, new read-only subcommand, `engine/mod.rs:500`, `main.rs:404`) what it registers: exactly `["muse-v0"]`, resolvable pairs exactly `[engineering-v2, muse-v0]`, gate closed. Records path, size, sha256, profile. Bundled definitions read. `desktop-binary`: crate does not depend on `nexus-broker`; the release Tauri executable was built (`apps/nexus-desktop/src-tauri/target/release/nexus-desktop`) and scanned. Other targets (macOS/Windows) are **UNVERIFIED**.
* **RG-4**: `EM04C2-CompareBodies.cjs` fails on 0 tests/bodies, any baseline test missing, < 116 tests / < 1000 bodies, unreadable dumps, unequal request counts (never "identical"), non-input field difference; the cargo-output multiset rule needs the harness grammar.
* **RG-5**: per-filter minimum counts (`ENGINE_FILTERS`, `E2E_FILTERS`). **RG-6**: `selftest-leak` build must be rejected by the prodgate tests AND detected by the scanner, inside the gate. **RG-7**: `ControllerPresetCleanInstall`, `ControllerSessionBootstrap`, `AihControllerHost`, and the gate's own negative controls are in the suite list; JsEnvironment also globs `Controller|Aih|EM04C2Gate`. **RG-8**: the R751 "toolchain differs" classifier is removed.
* The gate caught a real defect of its own on first full run: a prodgate test binary embedded the fixture-key file name (`TEST-ONLY-throwaway`); the test now locates the file by suffix.

## 5. Request-body parity investigation
The polling test `rn2_a_conversation_whose_target_is_no_longer_issued…` loops until the broker's 30 s catalogue cache expires; each rejected poll becomes a `### Run N` entry in the next request's conversation memory. Measured on the **same tree**: 6 `### Run` entries in 9 runs, 7 in 5 runs (14 runs). So the count is test-timing, not protocol. Handling: no normalization of anything else; a single named exception (`TIMING_DEPENDENT_TESTS`) collapses rejected-poll entries in `input[0].content` of that test only, reported as `polling-count-only`, never "identical". Same difference in any other test, or any other change in that test, is UNEXPLAINED (negative controls). Result with separate target dirs (baseline `50a24d7` in its own worktree/target): **116 tests, 1,170 bodies: 1,078 identical, 88 volatile tool-output only, 4 order-only, 0 polling-count-only, 0 unexplained; non-input fields identical 1,170/1,170**.

## 6. Environment / coverage
* Crash-injection tests (`a56_crash_after_*`) pass (2/2) when built via `--workspace` (feature unification); the gate and baseline run use `cargo test --workspace --test code_a56`. Baseline `50a24d7`: 126 passed/0 failed; this tree: 159 → see §7.
* Lock-file-pinned JS environment: `runtime/package-lock.json` installed with `npm ci --omit=dev --legacy-peer-deps --offline` (local npm cache, no network) into `~/.cache/s10-pinned-app`; **`RegistryR751DependencyCompatibility` PASSES against it** (D-2 evidence). Install scripts remain blocked by the bundled npm (SEC-7, unchanged, not analysed).

## 7. Validation results
Final numbers and statuses: `EM-04C2-S10-REVALIDATION-HANDOFF.md` §3. Verdict there: CHANGES REQUIRED (R74 unexplained; one final-tree battery).

## 8. R74 follow-up
`EM-04C2-R74-ROOT-CAUSE-REPORT.md`: diagnostics added to the R74 child, JS-environment report keeps failure output, new `env:pwsh-host-runtime-fault` class (UNVERIFIED, never PASS); no assertion or expected code changed. Final tree: full pinned JS 54/54, gate PASS, battery 1,232/0/57, fmt/clippy clean.
