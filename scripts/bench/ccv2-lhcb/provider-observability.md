# Capture-only provider observability

Scope: fresh LHCB-02 runtime launches only. No live execution is part of this change.

1. Source of truth: original SDK/fetch exceptions and accepted DSH session events. Diagnostics are derived evidence, never retry/grade input.
2. Ownership: one process-local observer writes `nexus-root/logs/provider-observability.jsonl`; the transport writes a safe phase/RPC correlation sidecar derived from the existing benchmark journal.
3. Dependencies: launch staging → preload → observer; observer uses Node built-ins only. SDK and session objects are read, not repurposed as diagnostic stores.
4. Boundaries: safe scalar metadata, response status/headers, allowlisted exception fields and bounded sanitized error bodies cross to disk. Requests/prompts/source/credentials do not.
5. Failures: observer serialization, unsupported hook layout and sink failures are contained. Original values/exceptions, request count, deadlines and retry decisions remain authoritative. Unavailable metadata is null/omitted, never inferred as an upstream fault.
6. Lifecycle: modules are copied before a new owned child launches; in-memory loading hooks observe pinned dependency modules without changing files. Per-session metadata is bounded and private context references are released at completion. Process teardown removes hooks; no historical root is patched.
7. Test seams: injected sink/clock; scripted fetch/SDK exceptions; pinned actual pi-ai and DSH session modules in isolated child processes, baseline versus observed. No provider traffic.
8. Compatibility: original request payload, headers, signal, retry call and normalized output remain unchanged. Module-load transforms are limited to exact pinned anchors; mismatch produces a diagnostic and leaves original module source untouched. Rollback removes only launch preload/staging.
9. Observability: start, HTTP/fetch, SDK failure, pre-normalization stream failure, completion, scheduled retry and actual retry-start records share an observation ID. Raw capture remains outside session logs, workspace, grading and checkpoint payload.
10. Security: safe response-header/exception allowlists; known credentials and request-context text are masked before error persistence; content-bearing keys are removed; cycles/depth/string sizes bounded; diagnostic files are mode 0600 and symlinks are rejected. No candidate content or error chain is used to choose an action.

Logging adds bounded execution overhead, as any capture does; it adds no backoff, timer, retry, request or control decision. Existing workload/protocol/failure-policy files remain untouched. The harness identity changes to include the observer implementation; old experiment identities and evidence remain immutable.

## Actual capture points

The fresh LHCB-02 transport stages the two capture modules inside the already mounted installation and preloads them in the pinned Node child. `registerHooks` adds calls only to exact source anchors in the installed modules:

- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`: original caller/watchdog signals and configured deadlines, before `streamSimple`.
- `@earendil-works/pi-ai/dist/api/openai-responses.js`: original `client.responses.create(params, requestOptions).withResponse()` inside the existing `retryProviderRequest` callback. The fresh client retains its original fetch/status-error/retry methods; wrappers call each original once. Raw fetch rejection precedes SDK wrapping; the SDK's already parsed status body is observed without another body read; original SDK and iterator exceptions are captured before `formatOpenAIResponsesError`. Iteration returns the same values/exceptions and delegates the existing iterator lifecycle. Provider usage is read from actual SDK SSE response usage; missing components remain null.
- `@deepseek-ai/dsh-session/lib/index.js`: after the original accepted `this.log.push(event)`, observe turn/step/RPC and the unchanged `llm/retry` / `llm/retry-started` events. No additional session event is appended.

The JSONL is separate evidence in `nexus-root/logs/provider-observability.jsonl`. Observation IDs join request, HTTP, SDK, stream, completion and retry records. HTTP response headers preserve safe OpenCode/Muse/upstream request, log, trace and correlation IDs when exposed. A provider failure is not attributed automatically: missing upstream/gateway evidence remains missing. The existing normalized failure and policy are authoritative.

## Executed verification

Offline differential workers use the installed pinned DSH adapter, session, retry plugin, pi-ai Responses adapter and OpenAI SDK, with only a scripted fetch and deterministic test clock. Baseline and capture outputs are deep-equal: complete request URL/payload/headers/method/count, normalized Harness chunks and exceptions, existing immutable session events, retry decisions and timer arguments. The retry fixture schedules the original 500/1000 ms timer arguments and makes three requests in both modes; the test clock advances these timers without waiting. Logging adds execution overhead but no timer or scheduling-policy change.

Coverage includes 429/Retry-After, upstream rate-limit and quota bodies, 500/502/503, explicit SDK retry ineligibility, ECONNRESET, ETIMEDOUT, caller abort, SDK deadline abort, nested SDK/socket causes, remote termination, success/usage/IDs, credential-bearing bodies/headers, short source text, bounded/cyclic causes, sink failure, namespace launch and checkpoint exclusion. Existing standalone redaction tests are preserved and executed.

LHCB-02's production source guard passed. Workload hash remains `35d3c092a83fe7a4d0565504290286c9f4516dc539a0a48b2816f8a44a7f71dc`; official protocol hash remains `7f57829e23ed8add06f99482692fdb4d36676610b789a3d086735d333d1683fd`. The LHCB-01 legacy autorunner suite has one pre-existing production-drift failure against its older base; all six flagged paths match the task's starting commit under Git's configured filters. Its source guard was not weakened.

No live provider call or LHCB run was made. Historical benchmark roots, installed dependency files, provider policy, prompts, checkpoints, grading, thresholds and scientific reports were not modified.

Final results: **29/29 focused tests PASS** (15 real SDK differential scenarios), **88/88 LHCB-02 / existing redaction regression tests PASS**. The combined integration run passed **115/115** before the last two focused ID/lifecycle cases were added. The separate LHCB-01 legacy suite passed 76/77; its sole existing source-guard failure is documented above. `git diff --check` passed.

Executed focused command:

```sh
LHCB_OBSERVABILITY_TEST_APP=/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/nexus-root/app /home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node --test tests/ProviderObservability.Tests.cjs
```

The combined command additionally included `tests/Ccv2Lhcb02.AutoRunner.Tests.cjs`, `tests/Ccv2Lhcb02.Official.Tests.cjs`, `tests/Ccv2Lhcb02.Isolation.Tests.cjs` and the unchanged `/home/kaloyan/nexus-bench/provider-attribution-20261007-v1/observe.test.cjs`. These commands execute deterministic offline fixtures; they do not invoke the live benchmark.
