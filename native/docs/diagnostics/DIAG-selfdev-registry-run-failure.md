# Diagnosis — first self-development run ended "Failed — run ended as failed"

Run `run_177c22c2a51d6a2ca17a764a3c1f2643` (task `INTENT-00051`, model transcript `model_2750baca1ab8d79293cf608bcd05491a`, conversation `thr_3137b3dc482b5d0ffaaf902698498746`, project `nexus-f98ffb`, interactive dev instance). Evidence: the run record, the hash-chained transcript (756 events), the Controller intent ledger and the daemon/broker logs.

## Verdict (evidence, not inference)
**Root cause: a hard-coded bound of 96 attempts per task in the Controller bridge** (`config/registry/native-intent-bridge.cjs`, `cmdAttemptAdd`: `if (seq > 96) return failOut('too-many-attempts', …)`), left over from A5.5 when a run had at most 12 turns. Every provider request is its own Controller attempt (model turns *and* re-asked recoveries). The run made 92 turns and 4 provider recoveries = 96 attempts (`INTENT-00051-A96`; the ledger `attempts.jsonl` holds exactly 96 `started` records). Right after the model said "Audit done — now building the Registry→Native bridge." and its last `fs_search` returned, the broker asked for attempt 97 and the bridge refused:

```
seq 754 tool-result  fs_search …ok
seq 755 error        code=too-many-attempts   "Failed: attempt limit reached"
```

The broker treated the bridge error as a malfunction and ended the run `failed`. The UI then showed only "run ended as failed" because the run record's generic fallback message replaced the real one.

## Ruled out (with evidence)
| Candidate | Finding |
|---|---|
| Provider transport / streaming | 4 recoveries (`send-uncertain`), all recovered; the last provider answer (turn 96) was complete and its tool call executed. |
| Context / token exhaustion | 2,378,077 tokens in over 92 turns, 38 context compactions, no `payload-too-large`/`output-limit`; the final request was accepted. |
| Turn / tool-call / time limits | limits were 500 turns, 4000 tool calls; elapsed 345 s. Not reached. |
| Context reconstruction / compaction | compactions succeeded every time; no `prepare-refused`. |
| Tool-call validation | the final call (`fs_search`) was valid and executed. |
| Daemon/broker lifecycle | no tool-runtime restart was recorded in the run (its only recovery reason is `send-uncertain`; a daemon restart would have produced a "the tool runtime restarted" recovery or an `uncertain` tool step), and the transcript hash chain is continuous to the last event. The process list cannot show the earlier daemon's start time, so this rests on the run's own records. |
| Workspace / Registry | no workspace error; the missing `config/registry/native-target.cjs` is not a file of this repository (the module is `native-target-v2.cjs`) and played no part in the failure. |
| Premature failure after a progress message | the progress sentence was an ordinary assistant message; the failure came from the *next* attempt request. |

Why "64 steps": the run record keeps only the last 64 tool activities (`MAX_ACTIVITY`); the run actually executed 92 tool calls.

## Why recovery did not help
The recovery mechanism (A7.0) only re-asks the provider for transient transport errors. A Controller bound is deterministic: asking again returns the same refusal, so it was correctly *not* retried — but it must never have been a failure at all. Two defects:
1. the bound (96) was far below the run limits (500 turns configured, 2000 allowed) and counted recoveries against it;
2. an exhausted bound was reported as a fault, with the reason hidden.

## Fixes (uncommitted) and regression coverage
* Bridge bound raised to 5000 provider requests per task, documented as a runaway guard only (`native-intent-bridge.cjs`). `tests/NativeRepoInspectBridge.Tests.cjs`: 100 attempts (past the old bound) succeed; attempt 5000 succeeds; 5001 is refused with `too-many-attempts`.
* The broker maps a refused attempt to a clean policy stop: run state `limit-reached`, `stopReason = max-attempts`, work and conversation kept (`inspect.rs`, `is_attempt_limit`). End-to-end test `a71_a_task_that_reaches_the_controllers_attempt_bound_ends_as_a_clean_limit_with_its_reason`.
* A failed/uncertain run now keeps its real reason in `errorMessage` instead of "run ended as failed" (`finalize`). Asserted in `a614_repeated_truncation_ends_the_run_with_a_clear_cause_and_never_loops`.

## Second defect found in the same investigation (the "unexplained Run 3")
The earlier A7.1 acceptance note recorded a failed coding Run 3 as unexplained. Run `run_5b8753e9b72904808dbb2ba685ffbd0f` (conversation `thr_7cc5d16d6cd2de2e6cdf90160f8ce8b4`) shows it: `prepare-refused: transport-refused: message content is empty or oversized`. The follow-up's first message (harness text ≈5 KB + conversation context 31.7 KB + request) exceeded the transport's 32 KiB per-message bound (`MAX_MESSAGE_CHARS`); the conversation context budget (48 KiB) did not account for it. Repeating the task succeeded only because the next context happened to be shorter (17 KB). Fixed: the context now gets only what the harness text and the request leave of the 32 KiB bound (`threads::fit_budget`); regression `a71_a_follow_up_after_very_long_answers_still_fits_the_transports_message_bound` fails without the fix with exactly this error and passes with it.
