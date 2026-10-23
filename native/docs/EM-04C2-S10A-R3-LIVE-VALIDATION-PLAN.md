# EM-04C2 S10-A — R3 live-provider validation plan (NOT EXECUTED; needs separate owner authorization)

Status of real-provider compatibility: **UNVERIFIED**. No live request was made in S10-A.

## 0. Preconditions (owner)
1. Written authorization naming: provider (OpenCode Go), one model, one route, the **spending cap**, the time window.
2. Pricing/availability checked **at authorization time** (not assumed here): choose a model and a cap such that a worst-case run (budget 440,000 B requests × turn limit × `xhigh` output) stays below the cap. Record the figures in the run log.
3. Credentials only in the existing credential store; never in the repo or logs.

## 1. Setup (no inference)
Operator catalog: `saveModel` (engines `["nexus-adaptive-v1"]`, tier as declared by the provider, capabilities tool calling + reasoning), `saveRoute` (provider `opencode-go`, transport `openai-responses`, wire profile `opencode-go-responses`), then `verifyProviderRoute` (a minimal capability probe — **this is the first live call**, counted against the cap). Save an explicit `engineering-v2-adaptive` ModeConfiguration: default `low`, `allowedReasoning` `[low, medium, high, xhigh]` (or a narrower set for the first run). A disposable repo workspace with a deliberately multi-step task and a failing test.

## 2. Test matrix (each with abort criteria)
| # | Check | Pass criterion |
|---|---|---|
| T1 | Real Responses compatibility | streaming completes; tool calls round-trip; no protocol error |
| T2 | Authorized model/route only | request log shows the Registry-issued model and route; any other → ABORT |
| T3 | Effort changes up | `low → medium → high` occur only when the limiter selects them (events `effort-selected`), each bound before the request (`attempt-bound`), provider echoes the effort |
| T4 | Downward transitions | after the cause clears the effort returns toward default; recorded |
| T5 | Tool calling + continuation | edits/commands need approvals as in `muse-v0`; interrupted run continues with authenticated state (SEC-1), same engine identity |
| T6 | Reasoning-state replay | encrypted reasoning items replayed within a run when the effort changes mid-conversation (risk **R3**): provider accepts or the failure is classified; no silent fallback |
| T7 | Persistence across interruption | kill/cancel mid-run; `resume`; limiter history (`dropped_before`, tokens) preserved |
| T8 | Token and cost accounting | usage per attempt recorded; total ≤ cap; compare to provider invoice later |
| T9 | No unauthorized fallback | forced model/route failure ends the run (`provider-failed`/refusal), never another engine/model |
| T10 | Request budget | no request > 450,000 B; compaction events appear on a long task |
| T11 | Baseline comparison | the same task on `muse-v0` (same model) for the S10-B decision: quality, tokens, cost, wall time |

## 3. Abort conditions (stop immediately, preserve logs)
Cumulative cost ≥ 80% of cap; any request to a model/route not issued by the Registry; any unexplained authorization failure; request > 450,000 B; provider error rate > 2 consecutive; a run exceeding the turn/time limits; any credential appearing in a log.

## 4. Outputs
Run log (request counts, efforts per attempt, usage, cost), the state records, a verdict per test, and a recommendation for S10-B. Until all of T1–T10 pass, compatibility stays UNVERIFIED and the engine stays opt-in.
