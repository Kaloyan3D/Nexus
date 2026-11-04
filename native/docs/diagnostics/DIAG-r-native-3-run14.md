# R-NATIVE-3 run 14 — completed with 41 edits, an unfinished closing message and five failed checks

Evidence: the preserved run record, hash-chained transcript (2,129 events), conversation log and the isolated worktree of run 14 (conversation `thr_cf99…`, 202 turns, 184 tool calls, 77 lost provider answers, 13.5 M input tokens).

## What happened
* The run ended `completed / fulfilled`. Its last model message was 15 KB of reasoning about *making* a tool call ("I must make a tool call now…", "one tool per message…") with no tool call. HTTP 200, `finishReason: stop`: not truncated.
* Five verification commands were recorded as failed and never re-run to a pass: an `npx tsc` whose `npm install` ran inside `sh -c` (no network there), two Tauri `cargo test` runs (crates.io unreachable, `cargo fetch` never tried), and two workspace runs that hit a sandbox-only failure. The frontend toolchain therefore never ran; the patch was delivered with 5 TypeScript errors, 1 ESLint error and 6 failing Vitest tests.

## Provider/model versus runtime
* Structured tool calls worked 184 of 184 times (every call has a result); no text-only turn contains well-formed call arguments, so nothing dispatchable was dropped. 18 turns ended with text and no call; 16 were caught by the nudges and recovered. The 18th was not nudged.
* 10 of the 18 text-only turns directly followed a lost-answer re-ask (56 % against a 28 % base rate): suggestive of provider/transport instability. The raw provider stream is not stored, so a lost call frame cannot be ruled out.
* Verdict: the degeneration is the model/provider; **accepting it as the end of the task is a runtime defect**.

## Why it was accepted (reproduced with the real text)
`completion::plan_like(text) == true`, `announcement(text) == false` (a 500-character cap), `decide(...) == Fulfilled`. `plan_like` was consulted only when there were zero edits, the announcement gate and the "stopped mid-flight" gate are length-capped (500/700 characters), and `decide` ignored the failed verification commands that the run already tracked (D5). A long narration therefore bypassed every gate.

## Fixes (receipts, no new keyword rules)
* `decide_run`: a change with unresolved failed checks is never `fulfilled`; it is `failing-checks`, with a plain-language note ("blocked or unverified, not passed"). Only a genuine re-run of the *same* command to a pass clears a failed check (an environmental failure included).
* The "last verification failed" nudge also fires for unresolved failed checks, whatever the length of the closing text (bounded, reset by progress).
* The `proc_run` tool description now says installs must run directly (never inside `sh -c`) with `npm ci` / `cargo fetch`, and how pipelines are judged.
* The Desktop shows `failing-checks` as a warning with its reason visible (not only a tooltip).

## Regression tests
The actual terminal response is `native/nexus-broker/tests/fixtures/run14-terminal-response.txt`: text-only decision (blind spot documented), `decide_run`, the nudge with the real text and with a short text, and end-to-end runs (failed check left unresolved → nudged and `failing-checks`; the identical command re-run to a pass → `fulfilled`, nothing unresolved).

## Limits
* Clearing is exact-command: an equivalent but differently written passing command does not clear a failure (conservative; the failure stays visible).
* The fix does not stop a model from degenerating; it stops the run from being accepted as verified. Provider instability (77 lost answers in 279 attempts) remains.
* The `a614_a_long_loop…` request-size limit (450,000 bytes) has about 56 bytes of headroom: the tool descriptions are sent with every request, so the added documentation is deliberately compact.
