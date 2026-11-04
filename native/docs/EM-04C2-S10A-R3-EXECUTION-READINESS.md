# EM-04C2 S10-A — R3 live validation: execution readiness

**Status: prepared offline. No live request, capability probe or paid inference was made. Provider compatibility remains UNVERIFIED.** Nothing here is authorization to spend; the owner must approve the items in §7.

## 1. Provenance
* `HEAD` = `9f3ec3778ee9ff26ba4475df9c0076301453bcfc` (`docs(native): record S10-A final-SHA acceptance results`), branch `feature/rust-native-core`, tracked tree clean.
* **The acceptance evidence covers `a638c560cf3b73a5b0d70fe4bf4383e8915c77bf`** (2 × full battery 1,239/0/57, fresh-target release gate PASS, pinned JS 54/54, body parity 0 unexplained, Tauri/fmt/clippy). `HEAD` differs from it only in two files under `native/docs/` (`git diff --name-status a638c56 HEAD`: `A …ACCEPTANCE-RESULTS.md`, `M …ACTIVATION-REPORT.md`; `git diff --quiet a638c56 HEAD -- . ':!native/docs'` ⇒ identical). So all executable source, tests and gate definitions are byte-identical to the validated revision; **no test was run on `HEAD` itself, and none is needed to claim equivalence of non-doc content.**
* This preparation adds, **uncommitted**: `scripts/EM04C2-R3-Preflight.cjs` (offline rehearsal), one E2E test `r3_an_adaptive_task_selecting_an_unverified_route_is_refused_before_any_request` in `code_a56.rs`, and this document. The new test passes (focused run); the full battery/gate were **not** re-run on them (they are additive; re-run before committing).

## 2. Candidate model and route
| Field | Value (from the shipped catalog / provider documentation) |
|---|---|
| Provider / connection | `opencode-go` / `conn-opencode-go` |
| Remote model id | `muse-spark-1.3-contributor` (listed by OpenCode Go in both Go and Go Plus plans) |
| Transport | **OpenAI Responses**, endpoint `https://opencode.ai/inference/go/openai/v1/responses` (the only transport the adaptive contract accepts) |
| Built-in entries (NOT modified) | model `meta/muse-spark-1.3-contributor` (scope `["muse-v0"]`), route `opencode-go/meta/muse-spark-1.3-contributor`, availability `verified`, tool calling + reasoning declared, tier `contributor` |
| Operator entry (new, separate) | model `operator/muse-spark-1.3-contributor-adaptive`, **engines `["nexus-adaptive-v1"]` only**; route `opencode-go/operator/muse-spark-1.3-contributor-adaptive`, same provider/connection/remote model/transport/capabilities/tier, availability `probe-required` |
| Alternatives rejected | other OpenCode Go Responses models (GPT/Grok families) are not in the shipped Registry catalog and have no declared capabilities there: adding them would be unverified aliases; Chat-Completions / Anthropic / Google models are refused by the contract |
Why this one: it is the only built-in model whose route already satisfies every closed-contract requirement (Responses transport, tool calling, reasoning, declared tier).

## 3. Operator Registry configuration (exact, supported workflow)
Rehearsed offline in a disposable root by `node scripts/EM04C2-R3-Preflight.cjs` (13 checks, all PASS; `--json` prints the exact documents):
1. `service.saveModel(<operator model doc>)` — accepted; scope exactly `["nexus-adaptive-v1"]`.
2. `service.saveRoute(<operator route doc>)` — a route claiming `availability: verified` is **refused** (`route-not-verified`); `probe-required` is accepted.
3. **Live action (not performed):** `service.verifyProviderRoute('opencode-go/operator/muse-spark-1.3-contributor-adaptive')` — a real request using the stored OpenCode Go credential (see §4).
4. Save the adaptive ModeConfiguration: `engineering-v2-adaptive`, main slot = the operator model/route, default `low`, `allowedReasoning` `[low, medium, high, xhigh]` (`service.save`).
Verified offline: until step 3, the Registry refuses step 4 (`route-not-verified`, nothing written); selection of the unverified route is `registry-selection-not-issuable`; and the **real broker** refuses an adaptive intent for a saved-but-unverified route at submission (`model-not-available … route-not-verified`, zero provider requests — new E2E test). The built-in catalog is byte-identical before/after (digest check). In-memory only, the same documents with `availability: verified` compile to a binding sealing engine `nexus-adaptive-v1`, contract `nexus-adaptive-v1`, ladder `[low, medium, high, xhigh]` — a rehearsal, **not** evidence of provider behavior and no receipt is written.
Also checked: default `engineering-v2` still resolves to `muse-v0` and compiles with no adaptive state; the adaptive mode shows `persisted:false` (no implicit configuration); chat-completions, unscoped, other-provider models are refused (`engine-scope-mismatch`, `slot-capability-not-satisfied`); no `muse-v1` alias (issuer, contract table); Responses is the only accepted transport.
CLI contract (smallest existing path): `nexus intent submit --type repo-code --workspace <id> --model opencode-go/muse-spark-1.3-contributor/operator/muse-spark-1.3-contributor-adaptive --route opencode-go/operator/muse-spark-1.3-contributor-adaptive --engineering-mode engineering-v2-adaptive --input TASK.txt --max-turns N --max-tool-calls N --max-output-tokens N --max-runtime-secs N --follow` (`--model` is `provider/remote-model/logical-model-id`; the logical id of the operator entry itself contains a `/`, which the CLI keeps). The flag only fills `ModelSelection.mode_id`; the broker validates it against the Registry (`s4_…`, `r3_…` E2E tests use the identical selection structure).

## 4. Live-probe authorization requirements
The owner must explicitly authorize, in writing: (a) the single capability probe; (b) the credential to be used (the existing stored OpenCode Go credential; this preparation did not read, print or test it); (c) the account/plan and that **Extra Usage / pay-as-you-go stays OFF**; (d) the disposable repository; (e) the time window. Data-use warning: the `contributor` tier means OpenCode Go gives "heavily discounted token pricing in exchange for permission to use your prompts and completions to train future Meta models" — use **only** a disposable repo with no private code, secrets or personal data.

## 5. Provider facts, availability and cost (UNVERIFIED items marked)
Source: OpenCode Go documentation page fetched 2026-10-24 (read through a summarizing fetch tool, not the provider API): Go plan $10/month, Go Plus $40/month; Muse Spark 1.3 Contributor: **input $0.10 / 1M tokens, output $0.20 / 1M, cached read $0.002 / 1M**; monthly usage limit value Go $60, Go Plus $120; usage windows 20 % per 5 h and 50 % per week of the monthly limit; when limits are reached requests stop unless Extra Usage is enabled. Marked: **pricing — documented, to be re-checked on the page at authorization (UNVERIFIED by me against the invoice)**; **availability for the owner's account and region — UNVERIFIED** (the models are offered only "in regions permitted by Meta's Geographic Use Policy"; the owner's region must be confirmed, otherwise requests may be refused); **route verification — NOT DONE** (needs the live probe); **credential present — NOT CHECKED**.
**Proposed maximum spend: USD 3.00 for the whole R3 run** (abort at USD 2.40). Basis: request ≤ 450,000 B ≈ ≤ 150k input tokens worst case; at most ~150 provider requests across all scenarios (enforced with `--max-turns` per task) ⇒ ≤ 22.5 M input tokens ≈ $2.25; output ≤ ~2.4 M tokens ≈ $0.48; total worst case ≈ $2.73, rounded to $3.00. Expected real spend is a small fraction (typical requests are far below the ceiling and the cached-read price is 50× lower). With Extra Usage OFF the provider itself stops at the plan's limit, so the out-of-pocket exposure beyond the subscription is $0.

## 6. Smoke-test sequence
Order matters; stop at the first failed safety item. **Part A = safety/security validation (must all pass, independent of answer quality). Part B = coding-quality evaluation (informative, feeds S10-B; never a gate for A).**
**Part A**
| # | Step | Expected successful observations |
|---|---|---|
| A0 | Re-run `node scripts/EM04C2-R3-Preflight.cjs` and `nexus-broker engines` on the release binary | all PASS; registered `["muse-v0","nexus-adaptive-v1"]` |
| A1 | `verifyProviderRoute` (the only probe) | route becomes `verified` with a probe receipt; request log shows exactly one request to the Responses endpoint, model `muse-spark-1.3-contributor` |
| A2 | Save the adaptive ModeConfiguration; submit a trivial repo-code task (read a file, answer) at `low` | run completes; run record `engineId=nexus-adaptive-v1`, `engineModeId=engineering-v2-adaptive`; `effort` in every request body = `low`; Kernel receipt per attempt; sealed budget 440,000 recorded |
| A3 | A task with a failing test requiring several iterations (Kernel-verified failures) | durable `effort-selected` events with `detail limiter:<rule>` precede each `attempt-bound`; efforts only within `[low…xhigh]`; transitions up are explained by a limiter rule; downward transitions follow when evidence clears |
| A4 | Tool calls and continuation: edits/commands need approvals; interrupt (cancel) mid-run, then `resume` | continuation completes; lineage rule `inherited`, `dropped_before` and token counters preserved, no new tokens; predecessor state authenticated |
| A5 | Reasoning replay (risk R3): effort changes mid-conversation with encrypted reasoning items replayed | provider accepts, **or** the failure is classified and the run ends — never a silent retry on another model/engine; no request body contains a different model/route than issued |
| A6 | Interruption recovery: kill the broker process between `effort-selected` and the provider request | restart + resume ⇒ no duplicated attempt ordinal, no phantom selection |
| A7 | Budget and accounting | every request ≤ 450,000 B; compaction events on a long task; `usage` recorded per attempt; running cost estimate below the cap |
| A8 | Negative: unverified/other route, default mode | refused before any request (already proven offline; repeat live with zero provider traffic) |
**Part B (quality, after A passes):** the same 2–3 tasks on `muse-v0` with the same model: success rate, iterations, tokens, cost, wall time; adaptive vs `muse-v0` summary for S10-B. A fluent provider answer is **not** proof that a limiter/recovery property holds: each A-step is judged from the durable records, not from the model's text.

## 7. Abort criteria (stop at once, keep logs, no retry loops)
Cumulative cost ≥ USD 2.40 or request count ≥ 150; any request to a model/route/endpoint other than the issued one; any unexplained authorization failure (not classified under R74 — issue #35); a request > 450,000 B; ≥ 2 consecutive provider errors; refusal due to region/policy (then the validation is blocked, not failed); any engine fallback; any credential or key in logs/records; effort above the configured ladder or a selection without a preceding durable event; the run exceeding its turn/time limits.

## 8. Desktop (not implemented)
Smallest contract the Desktop would need, without a new execution path: list modes from the existing Registry list (`engineering-v2-adaptive` row: `selectable`, `runnable`, `persisted`); show it only when `persisted:true`; on send, build the existing `NexusIntentV1` (`intent_type: repo-code`, `workspace_id`, `model: ModelSelection{provider_id, remote_model_id, logical_model_id, route_id, mode_id:"engineering-v2-adaptive"}`) and call the existing `intent_client::submit` — exactly what `nexus intent submit --engineering-mode` does; surface the broker's refusal codes unchanged. No Desktop code was written.

## 9. Remaining blockers
1. **Owner authorization** of §4/§5 (probe, credential, account/plan with Extra Usage OFF, cap USD 3.00, window, disposable repo).
2. Confirm **region availability** of Muse Spark for the account (UNVERIFIED) and the **current pricing** on the provider page.
3. The live **route verification** (the one step that cannot be rehearsed).
4. Re-run the full battery/gate after committing the three new artifacts of this preparation (script, test, document).
5. R74 (issue #35) remains open and separate; S10-B and a Desktop selector are out of scope.

## 10. Verdict
**READY FOR OWNER-AUTHORIZED R3.**
