# Nexus Native — unbounded engineering report

Branch `feature/rust-native-core` · local commits only, nothing pushed or merged.
**Final executable source SHA: `eba18c0`.** Later commits touch `native/docs/` only.
Companion: `NEXUS-EXECUTION-LIMITS-AUDIT.md` (classification of every limit, with where it is defined and enforced).

## 1. What was wrong (confirmed from the ForgeFlow run records)

ForgeFlow stopped at 30 edits / 29 commands / 100 tool calls / 103 turns while the configured limits were 2000 / 1000 /
4000 / 500: none of them was reached. The refusal came from a hard-wired **128 KiB cumulative write quota**
(`MAX_TOTAL_WRITE_BYTES`) that the interactive profile never overrode, behind the single code `budget-exhausted`
(which also mislabelled a *read-only request*). Two further hidden ceilings sat behind it, found by reading the whole
stack rather than the one constant: a **5000-edit / 2000-command per-task policy in the daemon**, and a **5000-attempt
cap in the Controller bridge** (once 96, and it had already ended a real run). A fourth, the Direct pre-image store,
**refused the 4001st distinct file** and rewrote its whole manifest on every operation. The "64 steps" in the stress report
was a fifth: the run record silently kept only its last 64 tool calls.

## 2. Architecture: ceilings are opt-in; operations are bounded, tasks are not

A limit now exists only if it is (a) a per-operation physical bound with an actionable response, (b) a security or
authorization boundary, (c) provider-imposed, or (d) chosen by the person. **No cumulative count, byte total or wall
clock exists over a task** unless a person or operator chose one. Nothing was replaced by a larger constant.

| Layer | Before | Now |
|---|---|---|
| Intent contract | per-run ceilings (2000 turns, 10,000 calls, 512 MiB, 24 h, 5000 edits, 2000 tests); `maxEdits`/`maxTests` | `maxTurns`/`maxToolCalls`/`maxToolResultBytes`/`maxRuntimeSecs` are any number ≥ 1 and optional; edit/test/write limits **do not exist** (the field is rejected) |
| Client profiles | `DESKTOP/INTERACTIVE_CODE_LIMITS` carried 12/30/5/5/… and 500/4000/2000/1000/… | carry **only** the per-call output ceiling (a provider request parameter, byte-identical for the body baselines) |
| Broker policy | `max_edits`, `max_tests`, `max_total_write_bytes` | none; only the operator write scope and the read-only request |
| Loop | defaults 12 turns / 30 calls / 512 KiB results / 30 min | `Option`: none unless chosen; a chosen limit ends the run **cleanly** (`limit-reached`, work kept, continues on the next message) |
| Live authorization | `consent.rs` ceilings; operator record ≤ 24 turns / 80 calls for `repo-code` | none for `repo-code`; an operator-created record may still state limits, which then bind a run that states none |
| Daemon automated policy | 5000 edits / 2000 commands per task | none (also out of the policy digest); the one-file result bound stays |
| Controller bridge | 5000 attempts, whole ledger rewritten per turn | no bound; **append-only** ledger |
| Direct store | ≤ 4000 files, one manifest rewritten per operation (8 MiB read cap) | per-file records + appended folder list; no bound; constant cost per operation; stores written before this change are still read and updated |
| Run view | last 64 tool calls | a **window** of the latest 64 plus `activityTotal`; every call is appended once to a durable per-run log; `intent_activity` pages it; the Desktop shows "N earlier steps" |
| Memory-fold receipts | named every changed file | latest 40 named, the rest counted (byte-identical below 40) |
| No-progress guard | 3 / 25 consecutive refusals, fed by quota refusals | **same refused call repeated unchanged**: nudged at 3 (guidance, never authority), stopped at 8 with the call, the reason and what to do; any executed call resets it. The old consecutive-refusal backstop stays but no longer counts quotas |

Durability and cancellation: each operation is receipted by the Kernel journal and the Direct store before the next one
starts; the run log is append-only; a cancel or revocation is honoured **between operations** (tested at scale, below);
a provider outage still stops after 14 consecutive failures with backoff 2 s → 60 s (no unbounded paid retry); a person's
own limits (cost/time) and the 5-minute approval TTL remain.

Per-operation bounds that stay, and now explain themselves: one `fs_write` ≤ 98,304 bytes ("a limit of a single
operation, not of the task: write the file in parts … or split it into several modules"), one `fs_edit` ≤ 16 operations
("send the operations in several fs_edit calls"), one file ≤ 2 MiB result / 1 MiB read, one command's wall clock, memory,
processes and output, one provider response and request. Provider tool schemas and frozen catalogs were **not**
touched, only the text a refusal returns.

Desktop: no quota text anywhere ("No limit on steps, edits or time — press Stop whenever you want."), Settings →
*Optional: limit your own cost or time* (turns, tool calls, minutes; "Remove limits"), "turn N" instead of "turn N of
500", a run that stopped at a limit says it is **the limit you set** and that nothing is lost, and every refused step names
its source (Nexus / your permissions / your request / the sandbox / the provider), whether the task goes on, and what to
do. The generic `budget-exhausted` is gone; the read-only refusal is `read-only-request`.

## 3. Evidence (all against the real broker, daemon, Kernel and sandbox with a scripted provider; no paid traffic)

| Required | Test | Result |
|---|---|---|
| A ≥ 2,000 successful mutations in one task | `rel2_a_marathon_task_is_never_stopped_by_a_quota_and_every_boundary_still_holds` | **2,023 mutations** (1,900 creates, 60 edits, 60 × 96,000-byte files, stylesheet), all `executed`, each with post-image digest and execution id; `editsUsed` = 2,023 |
| B > 5 MiB written | same | 60 × 96,000 B in `big/` = 5.76 MB, plus the rest; all on disk |
| C hundreds of tool calls | same | **2,143 calls**, 169 turns, 156 context compactions, 0 recoveries; `activityTotal` 2,143 and the paged durable log returns all 2,143 in order |
| D repeated failing/passing tests | same | 60 commands, 30 exit 0 / 30 exit 3, none refused |
| E long conversation, no loss | `rel2_a_long_conversation_continues_across_many_runs_and_a_restart_without_losing_project_state` | 12 runs in one conversation, broker restarted after run 6; every run sees every earlier run's files; context memory stays ≤ 64 KiB; messages identical across the restart |
| F cancellation during a large task | `rel2_cancelling_a_large_task_stops_it_between_operations_and_every_receipt_matches_the_folder` | 3,000-write plan cancelled at ≥ 300 calls: `cancelled`, executed receipts = files on disk, nothing continues, restore review names exactly those files |
| G revocation during an extended task | `rel2_revoking_permission_during_an_extended_task_stops_what_it_allowed` | grant revoked mid-run: ≤ in-flight operations land, then every operation is refused with a reason, grant shows `revoked` |
| H large operations, no cumulative quota | `rel2_large_operations_are_bounded_one_at_a_time_with_a_way_to_split_and_no_cumulative_quota` | a 98,400-byte write and a 17-operation edit are refused `invalid-arguments` and the split guidance reaches the model; a 3 MiB file made by a command is not loaded whole; 5 MB of command output is truncated, not fatal; 60 split parts (5.4 MB) all succeed |
| I Adaptive, body stability, catalog | `rel2_adaptive_runs_well_past_a_hundred_turns_with_a_stable_body_and_the_frozen_catalog` + the baseline comparison (§4) | 140 Adaptive turns: engine state authenticated, the frozen `RepoCodeAdaptiveJobsV1` catalog identical on every turn, model / tool_choice / max_output_tokens / cache prefix identical, a reasoning effort always stated |
| J the ForgeFlow stylesheet | marathon (after > 5 MiB of writes) | `fs_edit src/styles.css` and `fs_write src/styles.css.new` execute — the exact calls that were refused |
| strict profile | `rel2_there_is_no_edit_or_command_quota_every_approved_request_runs` | the old 5-edit/5-command acceptance script now runs all 5 operations |
| restore at scale | marathon | the whole 2,000+-file change set reviewed, confirmed and restored (`completed`); folders removed with it |
| negative boundaries | marathon (second broker) | `.git/hooks/*`, `../escape`, `/etc/…`, `.env`, `node_modules/../../x` refused (none `budget-exhausted`); a command writing `../sandbox-escape.txt` and `/nexus-rel2-root-write` leaves nothing on the host |
| unit / contract | contract (no ceiling, `maxEdits` rejected), consent/live-auth (no ceiling, zero refused, operator limits bind a limit-free run), daemon policy (100,000 prior edits are not refused; one file's size still is), direct store (6,000 files; legacy manifest read), bridge (6,000 attempts), activity log, 3 Desktop suites | all pass |

## 4. Compatibility (nothing frozen was touched)

* **Provider bodies.** Against the current approved baseline **M8.1-AJ the 203 dumps of the final `code_a56` run have 0 skeleton differences and 0 request-count differences** (prompts, tool schemas, model fields, request sequence). Differences reported by the comparator, all classified: 3 *missing* tests, deliberately deleted or rewritten because they tested removed quotas (`a56_budgets_cap_edits_and_commands…` → `rel2_there_is_no_edit_or_command_quota…`, `a613_operator_caps_lower_the_limits…` → `a613_operator_caps_are_optional…`, `a71_a_task_that_reaches_the_controllers_attempt_bound…` → removed with the bound) and 11 *new* tests with no baseline entry. Two scenarios (`a56_a_prompt_injected_model…`, `a614_the_automated_policy_refuses…`) had implicitly relied on the old default of 12 model turns (their baseline request count *was* 12); they now state `max_turns = 12` explicitly, so their bodies are unchanged. **No baseline file was edited.** Against M8.1-EG the 299 skeleton differences are the same already-classified job-tool catalog difference between EG and AJ that Release 1 reported (AJ = 0 proves none is new).
* **Frozen catalogs, `nexus-adaptive-v1`, caching.** `nexus-model` was not changed. The 140-turn Adaptive test asserts the frozen `RepoCodeAdaptiveJobsV1` catalog and an identical request shape and cache prefix on every turn. `max_output_tokens` per call is unchanged (1024 strict / 32,768 interactive), which is what the baselines pin.
* **Existing data.** Run records written before this change still load (`maxEdits`/`maxTests` are ignored; `maxTurns`/`maxToolCalls` read as the limit the person chose); a run with no activity log reports `activityTotal` 0 and the Desktop falls back to the window it has. Direct stores in the old layout (entries in `manifest.json`) are read and updated in place (tested). A stored `user-limits.json` keeps working for turns/tool calls/minutes; its edit/command keys are ignored. Conversations, engine state and the Controller ledger are untouched formats (the ledger only stops being rewritten).
* **Wire.** New verb `intent-activity` and field `activityTotal` (additive); `intent-code-config` now returns only the person's limits plus `maxOutputTokens`; `maxEdits`/`maxTests` are rejected in intents. The Desktop and broker ship together.

## 5. Performance finding (not a quota; reported because it governs long tasks)

Per-operation cost grew with the size of the task: ≈ 8 calls/s early, ≈ 1.4 calls/s by call 2,000. It was CPU in the daemon
(the Kernel's append-only chains use `COUNT(*)` and `OFFSET` scans for their anchors) amplified by an **unoptimised SQLite in
the dev/test profile**. Optimising SQLite/hash/JSON dependencies in the dev profile (`[profile.dev.package.*]`, behaviour
identical) raised the marathon to ≈ 4.7 calls/s end to end (10 minutes for 2,143 calls). The Kernel scans themselves are
integrity-chain code and were left untouched; in a release build they are far cheaper (not measured here). A real task is
dominated by model latency, not by this.

## 6. Remaining genuine technical limitations (none is a work quota)

1. **One `fs_write` ≤ 98,304 bytes, one `fs_edit` ≤ 16 operations**: the frozen provider schema; the model splits (the refusal says how).
2. **One file ≤ 2 MiB after an edit, ≤ 1 MiB per read, ≤ 16 MiB kept as a pre-image**: whole-file atomic write and digest verification must fit memory. A bigger single file must be split.
3. **One command**: wall clock 15 min, 4 GiB memory, 512 processes, 256 KiB of output kept (the rest truncated and flagged).
4. **One provider response ≤ 3 MiB text, ≤ 768 KiB tool arguments (counted per delta/done/item), 180 s idle, 900 s total; one request ≤ 4 MiB / 480 items**: the conversation is compacted and folded into the model's own working memory, so the model loses raw tool output (never the runtime's receipts) in very long tasks.
5. **Evidence lists are bounded in memory** (a command's observed paths ≤ 2,000, bulk dependency folders summarised, ring buffers in engine state); when a list is cut it says so (`complete: false`) with the real counts.
6. **A restore review is one IPC response (≤ 4 MiB)**: verified at 2,000+ files; a single task touching tens of thousands of files may exceed one review frame (not tested; it would fail as an error, not silently).
7. **Provider-imposed**: rate limits, context window, availability. After 14 consecutive failures the broker stops and says so.
8. **Not tested here**: a real-provider ForgeFlow re-run (paid) and a release-build throughput measurement.

## 7. Gate on `eba18c0`

| Gate | Result |
|---|---|
| `cargo build --workspace`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` (native) | clean on the final tree |
| `NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast` (run on `fc3323c`; the two commits after it change only test files) | **1,545 passed, 0 failed, 64 ignored** (Release 1: 1,538) |
| `code_a56` (the big broker suite) re-run on the final `eba18c0` | **233 passed, 0 failed, 5 ignored** (986 s, includes the 2,143-call marathon) |
| Provider-body comparison, final dump | AJ: **0 skeleton / 0 count** differences (3 missing deleted tests, 11 new); EG: the 299 known job-tool differences. Baselines unedited |
| Production gate (`native/tools/prodgate`, release) | 6 + 8 passed |
| Tauri `cargo fmt --check`, `clippy --all-targets -D warnings`, `cargo test` | clean; 51 passed, 0 failed, 5 ignored (billable live suites) |
| Desktop `tsc`, `eslint`, `vitest` | clean; **24 files, 251 tests** (Release 1: 246) |
| `npm run test:packaging`; `node tests/NativeRepoInspectBridge.Tests.cjs` (attempts unbounded, append-only) | 6 passed; 8 passed |
| Focused security/authorization regressions | the negative-boundary block of the marathon (protected paths, escapes, sandbox writes), the Git-neutraliser and restore suites of Release 1, grant revocation (`rel2_revoking…`), approvals/consent unit tests — all inside the green runs above |
| Leftover processes of mine after the gate | none (each interrupted run's orphaned test daemons were terminated by exact PID) |

Not re-done: the Release 1 `.deb` was **not rebuilt** (this change set is not packaged; the bridge file in it would need a rebuild to ship), so the package-content check in the gate still describes the Release 1 package. One intermittent failure was seen and is not caused by this change: `em04c1_the_worker_is_lazy_and_inherits_neither_environment_nor_descriptors` (a Node worker briefly holding `/etc/ssl/openssl.cnf` as fd 3) failed once in a body-dump run, passed in the main run and 4 of 4 times alone.
