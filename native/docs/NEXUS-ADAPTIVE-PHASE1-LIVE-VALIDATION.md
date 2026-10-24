# Nexus Adaptive — Phase 1: Registry + real OpenCode Go provider (COMPLETE)

**Verdict: PASS.** Real Nexus Adaptive coding tasks ran end to end through the actual CLI → broker → daemon/Kernel → Registry → OpenCode Go path with the owner's stored credential (never printed), and the durable records show what happened. Security/fail-closed behavior: PASS. Provider compatibility: PASS. Recovery: PASS. Effort transitions: **OBSERVED** (up and down). Reasoning-item replay across a transition: **OBSERVED and accepted by the provider**.

## 1. Route onboarding (history)
First verification attempts failed twice with HTTP 403 on the first completion request (subscription lapsed; `GET /models` authenticated fine) — diagnosed with the new safe diagnostics, not a credential-store problem. After renewal one probe failed (continuation timed out at the fixed 15 s on a non-streaming request without a pinned effort); fixed (effort pinned like production, 45 s Go bound, connection status restored on failure — commit `88a4f08`). The owner's live retry: **8/8 PASS** (auth; text at low/medium/high/xhigh; streaming; tool-call emission; tool-result continuation) → route `opencode-go-native/muse-adaptive` verified at `[low, medium, high, xhigh]`, `engineering-v2-adaptive` bound. `muse` (default) route and its connection: verified/connected (restored earlier; the failed attempts had broken them).

## 2. Readiness (read from the saved Registry, `~/.nexus-interactive-dev/registry`)
Saved adaptive ModeConfiguration: persisted; main slot `meta/muse-spark-1.3-contributor-adaptive` via route `opencode-go-native/muse-adaptive`, default `low`, authorized `[low, medium, high, xhigh]`; mode `engineering-v2-adaptive` → engine `nexus-adaptive-v1` (active, selectable, runnable); model scoped only to `nexus-adaptive-v1`, tier `contributor`; compile OK; default `engineering-v2` compile OK (still `muse-v0`). Credentials file mode 600, owner = user, schema = `{credential://connections/conn-opencode-go-native: key}` (value never read by me).

## 3. Method
Disposable synthetic repository `~/nexus-test-repos/stats-kit` (Rust library, two seeded bugs, no dependencies, public material only), opened with `nexus project open` (a managed snapshot; the original is never modified). Runtime started by `nexus runtime start` (`NEXUS_HOME=~/.nexus-interactive-dev`). Submissions: `nexus intent submit --type repo-code --workspace stats-kit-460a74 --model opencode-go-native/muse-spark-1.3-contributor/meta/muse-spark-1.3-contributor-adaptive --route opencode-go-native/muse-adaptive --engineering-mode engineering-v2-adaptive …` — the identifiers were read from `nexus intent models --targets`, not guessed. Evidence: `scripts/Inspect-AdaptiveRun.cjs` (durable run record + HMAC-authenticated engine state), the opt-in structural provider trace (`NEXUS_PROVIDER_TRACE`, no text/credentials), and patches applied to CLEAN clones and tested outside Nexus. Sanitized artifacts: `native/docs/acceptance/phase1/`.

## 4. Results (all judged from durable records, not the model's narrative)
| # | Scenario | Run | Outcome |
|---|---|---|---|
| 1 | Read the repository and explain its structure | `run_f10baa73…` | completed, 10 turns / 9 tool calls, 0 edits; the explanation matched the files (checked against the sources) |
| 2 | Modify a small function and run its tests | `run_ac231ce0…` | completed, 12 turns, 2 edits, 1 test run; patch independently applied to a clean clone: the new and existing `clamp` tests pass, the two out-of-scope failing tests still fail as instructed |
| 3 | Fix the failing tests across turns | `run_b19bf4de…` (17 turns, 16 tools, 2 edits, 2 test runs) and a repeat (17 turns) | completed; the resumed variant's patch applied to a clean clone: **4/4 tests pass** |
| 4 | Effort selection / transitions | the two runs of 3 (+ the resumed one) | `effort-selected` events observed, every time: **attempt 1 → medium** (`limiter:up`), **→ high at attempt 9/10** after the verified test failures (`limiter:up`), **→ medium** after progress (`limiter:down-confirmed` / `down-progress`). Reproduced in 3 of 3 executions of task 3 |
| 5 | Tool calls, responses, continuation | all | request/response pairs complete; every tool-call round trip answered (trace: all HTTP 200, `completed`); catalog digest `5f7d19e2…` (the adaptive/signals catalog) |
| 6 | Interrupt and resume | `run_c3da58d6…` cancelled at turn 4 (attempt 4 recorded `failed`) → `intent resume` → `run_0128f7c0…` | continuation completed; engine record `lineage: inherited` from the AUTHENTICATED predecessor; `effort-reset-continuation` event (the continuation starts at the default under its own binding); `droppedBefore: true` carried (Policy V2) |
| 7 | Reasoning replay after an effort transition | provider trace | At the medium→high step the request carried **3 replayed reasoning items** (`sequence … R1 …`) with `effort: high`; HTTP 200, `completed`; the high attempts produced reasoning (365 tokens at attempt 11 vs 0–14 at medium). After high→medium, 4 reasoning items were replayed and accepted. 37 traced exchanges, **0 provider errors** except the one deliberate cancellation |
| 8 | Registry/Kernel authorization from durable records | all runs | run record: `engineId nexus-adaptive-v1`, `engineModeId engineering-v2-adaptive`, route `opencode-go-native/muse-adaptive`, `engineStateStarted true`; each attempt bound to the efforts the Registry authorized (only `medium` and `high` were ever used, both inside the saved ladder), every `effort-selected` event precedes its `attempt-bound`; requests carried model `muse-spark-1.3-contributor` at `/inference/go/openai/v1/responses` |

## 5. Separation of findings
* **Security / fail-closed:** PASS — no unauthorized dispatch, no fallback to another engine/model, no unsafe tool execution observed; cancelled attempt recorded as `failed`, never re-sent; continuation requires and used an authenticated predecessor.
* **Provider compatibility:** PASS — Responses requests, streaming, tool calls, reasoning replay and effort changes were all accepted by OpenCode Go.
* **Quality (informative only):** the model fixed both seeded bugs correctly in every task-3 run; the explanation task was accurate.
* Token usage per run: 42–93 k input / 1.4–1.8 k output tokens (subscription; Extra Usage never enabled).

## 6. Not covered / caveats
`high` was the only escalation seen; `xhigh` was never selected (the limiter needs sustained failure) — authorized and verified at the provider (route probe), **not observed in a task**. Small samples (5 recorded runs). Provider tracing was enabled only from the third run on. Linux only; macOS/Windows UNVERIFIED. R74 (issue #35) unchanged.

## 7. Incident (mine, resolved)
While creating the synthetic repository a shell-variable mistake ran `git init` + `git add -A` in `$HOME`. I stopped it immediately, confirmed it had created no commit and touched no existing file, and deleted exactly what it created (`~/.git`, `~/Cargo.toml`, `~/.gitignore`). Nothing else was altered.

## 8. Phase 1 engineering changes
`scripts/Setup-NativeOpenCodeGo.cjs --adaptive`, `scripts/Verify-NativeOpenCodeGoRoute.cjs --adaptive [--save-adaptive-config]`, probe diagnostics and timing (`config/registry/probes.cjs`), `scripts/Inspect-AdaptiveRun.cjs`, R3 preflight + unverified-route E2E. Commits: `03b6d91`, `88a4f08` and this commit. Full battery/gate/pinned JS for the Phase 1 + Phase 2 tree are run once, on the final Phase 2 SHA (see the Phase 2 report).
