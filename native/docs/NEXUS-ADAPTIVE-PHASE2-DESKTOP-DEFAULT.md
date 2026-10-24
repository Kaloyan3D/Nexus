# Nexus Adaptive — Phase 2: Desktop default engine (report)

**Verdict: READY FOR OWNER HANDS-ON TESTING** — with the caveat below that the GUI *window* has not been
driven by an automated test.

The real path **Desktop backend command → broker → Registry → Nexus Adaptive → OpenCode Go** was executed
live (the Tauri `thread_send` backend function against the owner's running runtime): engine
`nexus-adaptive-v1`, authenticated engine record, effort path medium → high → medium, observed in the
durable record. What no automated test did is click the buttons in the Tauri window; that is what
`NEXUS-USER-TESTING-GUIDE.md` asks the owner to do.

Tested code SHA: **`4acc3a0`** (`feature/rust-native-core`, local, not pushed).
Commits: `e5faeae` Phase 2 feature; `4acc3a0` clippy fix (redundant closure). Phase 1 commits `03b6d91`, `88a4f08`, `650fca7`. The docs commit follows.

## What Phase 2 delivers

| Requirement | Implementation |
|---|---|
| Adaptive preferred for new tasks | `nexus_runtime::engine_choice`: preference file `<home>/preferences.json` (0600, default Adaptive); the model/route come from the **saved adaptive ModeConfiguration** and must match an `issuable` Registry target. |
| `muse-v0` stays selectable | Engine selector "Stable (legacy)" → no engine selection sent → historical default route/mode. `engineering-v2 → muse-v0` mapping untouched. |
| No silent fallback | Adaptive chosen but unusable → `adaptive-not-configured` / `adaptive-route-missing` / `adaptive-route-not-issuable` refusal with the reason; UI banner. Never substitutes another route or engine. |
| Model / mode selection in Desktop | Selector in the code composer and Settings; a conversation shows `Engine: …` and keeps the engine it started with (`ThreadTarget.modeId`, persisted; absent for historical conversations, so the golden wire contract is unchanged). |
| Real submission via broker + Registry | `thread_send` / `intent_code_submit` build `provider/remote` + `route` + `modeId` and go through the existing broker verbs; no Registry bypass. |
| History, tools, effort events, errors | Existing run view + new Engine panel backed by broker verb `intent-engine`: reads only the **HMAC-authenticated** engine record; failed authentication shows nothing (`engine-state-unverified`). |
| Cancel / resume | Existing Stop; new Resume button → new Tauri `intent_resume` → existing `intent-resume` (the broker decides eligibility). |
| First-run setup without JSON editing | "Set up Nexus Adaptive…": native confirmation listing the billable checks, then `enable_adaptive` runs setup → authorize → verify (`--save-adaptive-config`). Key never printed. CLI equivalent: `nexus engine setup --acknowledge-billable`. |
| Existing tasks / conversations | Never migrated. Existing threads derive no engine; `mode_switched` note only on an explicit change. |

Also: CLI `nexus engine status|prefer|setup`, `nexus intent engine <run>`, `nexus code run --engine`.

## Validation on `4acc3a0`

| Check | Result |
|---|---|
| Rust workspace battery (`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast --offline`), run on `e5faeae` | 1246 passed, 0 failed, 57 ignored, exit 0 |
| `code_a56` with body dump, on `4acc3a0` | 164 passed, 0 failed, 5 ignored (includes new `p2_intent_engine_reports_only_the_authenticated_record`) |
| Pinned JS environment | 54 suites, 54 passed, 0 real failures, 0 unverified |
| Release gate with `--bodies` (fresh bins/prodgate targets) | **PASS**: registry-js 22/22, engines 148/0, e2e 36/0 (sandbox), production 14/0 (+negative controls), release-binaries (3 executables, no test-only symbol), desktop-binary, bodies: 116 tests, 1170 bodies, 1080 identical, 88 volatile-tool-output, 2 polling-count-only, **0 unexplained** (historical parity) |
| Registered engines (release `nexus-broker engines`) | `muse-v0`, `nexus-adaptive-v1`; `engineering-v2→muse-v0`, `engineering-v2-adaptive→nexus-adaptive-v1`; `testEnginesFeature=false`, `testFixturesFeature=false` — experimental engines unavailable |
| Desktop vitest / tsc / eslint | 165/165 (incl. 7 new engine tests); tsc and eslint clean |
| Tauri tests (`src-tauri`) | 27 passed, 1 ignored (+2 ignored live smokes) |
| `cargo fmt --check` | clean |
| Strict clippy (`-D warnings`): workspace all-targets, Tauri all-targets | clean after the fix below |
| Actual desktop release build (`cargo clean -p nexus-desktop --release`, `cargo build --release`) | built; `apps/nexus-desktop/src-tauri/target/release/nexus-desktop`, 7.27 MB, sha256 `29e60677d00a9bd0…` |
| Desktop-backend → broker → provider smoke (`live_desktop_backend_adaptive_smoke`) | PASS earlier in this session on the running runtime (pre-fmt/clippy; the only later source change is a clippy-only closure simplification) |

The battery ran on `e5faeae`; the only source change since is the one-line clippy fix in `nexus-cli`
(`4acc3a0`), after which clippy, `code_a56`, the JS suite and the release gate were run.

## First failures and fixes

1. Live smoke: `bad-intent: model must be provider/model` — a logical id contains `/`, so a 3-part model string was ambiguous. Fixed (Tauri and CLI send `provider/remote` + `route`).
2. Tauri authority test failed on the deliberately extended `intent_code_submit` signature — updated the pin and added assertions.
3. Strict clippy: `redundant_closure` in `nexus-cli/src/main.rs` (log preserved in the scratchpad `clippy-first-failure.log`) — fixed in `4acc3a0`.
4. Two vitest failures in my own new test (ambiguous label query) — test fixed.
5. New broker test first asserted the wrong error text — the client surfaces the broker message, not the code; assertion corrected.

## Remaining risks / not verified

- **GUI window not driven automatically**; the owner's hands-on test is the missing observation (`NEXUS-USER-TESTING-GUIDE.md`).
- `xhigh` effort never selected in a task (route verified at the provider only).
- macOS and Windows: **UNVERIFIED**. Linux only.
- R74 root cause **not fixed** (GitHub issue #35 stays open).
- The native confirmation dialog for adaptive setup is exercised through backend tests, not visually.
- Contributor model data-use policy permits training on submitted content: use only synthetic repositories.
- Small live samples (Phase 1: 5 runs; Phase 2 smoke: 1 run).
- No push, no merge to `main`, no deployment performed.
