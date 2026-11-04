# Nexus Native — execution limits audit

Branch `feature/rust-native-core`. Scope: every limit that can stop, refuse or truncate legitimate long-running
engineering work, across `nexus-broker`, `nexus-client`, `nexus-runtime`, `nexus-model`, `nexus-tools`,
`nexus-contracts`, `nexus-daemon`, `nexus-kernel`, the Registry bridge (`config/registry`), `apps/nexus-desktop` and the
Tauri commands. About 260 numeric constants and every counter compared against a configured value were read and
classified. "Before" = the code at `83acf06` (Release 1); "Now" = this change.

## 1. The ForgeFlow failure: exact cause (confirmed from the run records, not assumed)

The stress run is `run_bb5c449eb62cfda3fed9ee67fa3f1b43` (and an earlier one, `run_5bb4158…`) in the dev broker's
`runs/`. Both end with `fs_write src/styles.css.new` and `fs_edit src/styles.css` refused `budget-exhausted`.

| Counter (from the record) | Value | Its configured limit | Exhausted? |
|---|---|---|---|
| `editsUsed` | 30 | `maxEdits` 2000 (interactive) | **no** |
| `testsUsed` | 29 | `maxTests` 1000 | **no** |
| `toolCalls` | 100 | `maxToolCalls` 4000 | **no** |
| `turn` | 103 | `maxTurns` 500 | **no** |
| `toolResultBytes` | 155,126 | 256 MiB | **no** |
| **cumulative bytes written** | ≈ 128 KiB+ | **`MAX_TOTAL_WRITE_BYTES = 128 * 1024`**, hard-wired in `code.rs`, **ignoring the interactive limits** | **yes** |

`budget-exhausted` has exactly one producer, `inspect.rs::budget_refusal`, with three arms (edit count, cumulative
write bytes, command count). Only the middle arm could fire for those counters. It fired on the first write or edit that
would take the run's running total past 128 KiB, so the failure was **not** the 2000-edit limit and not any limit the
interactive profile advertised: it was a prototype quota from the first coding milestone (5 edits / 5 commands / 128 KiB
per run) that survived as a constant while everything around it was raised. The same refusal also reported a *read-only*
request as an exhausted "budget" (a different cause behind one name). The "64 execution steps" the stress report quotes
was a third, separate limit: the run record kept only its last 64 tool calls (`MAX_ACTIVITY`), so the Desktop silently
showed 64 of 100.

## 2. Classification

Legend — **Q** artificial quota (removed) · **O** per-operation physical bound (kept, made actionable) · **S** security
or authorization boundary (kept) · **U** limit a person may choose (kept, opt-in, default none) · **C** context /
memory management (kept; never refuses work) · **P** provider-imposed or provider-facing.

### 2.1 Artificial quotas — removed

| Limit | Defined | Enforced | Why it existed | Could it block real work? | Now |
|---|---|---|---|---|---|
| Cumulative bytes written per run, **128 KiB** | `broker/code.rs` `MAX_TOTAL_WRITE_BYTES`, `CodePolicy.max_total_write_bytes` | `inspect.rs::budget_refusal` | First coding milestone: bound an unattended run. | **Yes — this was the ForgeFlow failure.** A 130 KiB app is ordinary. | **Deleted** (field, constant, check). |
| Edits per run (5 strict / 2000 interactive) | `code.rs` `DEFAULT_MAX_EDITS`, `INTERACTIVE_CODE_LIMITS.max_edits`, `IntentLimits.max_edits`, `CodeCaps.max_edits` | `budget_refusal` | Same. | Yes. 2000 edits is one afternoon of work. | **Deleted** everywhere (contract field, caps, CLI flag, Settings, run record `maxEdits`). `editsUsed` stays as a *count*. |
| Commands / test runs per run (5 / 1000) | `DEFAULT_MAX_TESTS`, `max_tests` | `budget_refusal` | Same. | Yes (debug loops). | **Deleted** likewise. `testsUsed` stays as a count. |
| Model turns per run (12 strict / 500) | `DEFAULT_CODE_TURNS`, `*_CODE_LIMITS.max_turns` | loop head, `Limit("max-turns")` | Bound paid calls. | Yes. | Default **none**. Only a limit a person/operator chose (`U`). |
| Tool calls per run (30 / 4000) | `DEFAULT_CODE_TOOL_CALLS`, `max_tool_calls` | per call, `Limit("max-tool-calls")` | Same. | Yes. | Default **none**; opt-in (`U`). |
| Total tool-result bytes per run (128 KiB / 256 MiB) | `DEFAULT_CODE_RESULT_BYTES`, `max_tool_result_bytes` | per call, `Limit("max-tool-result-bytes")` | Bound transcript growth. | Yes; context size is already managed (2.4). | Default **none**. |
| Elapsed time per run (30 min / 8 h) | `DEFAULT_CODE_RUNTIME_SECS`, `max_runtime_secs` | loop head + approval deadline | Bound a runaway. | Yes (a large build + review is hours). | Default **none**; opt-in (`U`). The approval wait keeps its own 5-minute TTL. |
| Contract ceilings on those limits (`MAX_CODE_TURNS 2000`, `…TOOL_CALLS 10000`, `…RESULT_BYTES 512 MiB`, `…RUNTIME 24 h`, `…EDITS 5000`, `…TESTS 2000`) | `nexus-contracts/intent.rs` | `NexusIntentV1::parse` | Reject absurd client limits. | Capped even a *chosen* limit. | **Deleted** (a `repo-code` limit is any number ≥ 1). `repo-inspect` keeps its small fixed bounds (read-only product). |
| Live-authorization ceilings (`consent.rs` `MAX_TURNS 2000`, `MAX_TOOL_CALLS 10000`, `MAX_TOOL_RESULT_BYTES`) | `consent.rs` | `authorize_run` | Sealed per-run ceilings. | Yes. | **Deleted.** Only the per-call output ceiling (`MAX_OUTPUT_TOKENS`, a request parameter) remains. |
| Operator session record caps (repo-code ≤ 24 turns / 80 calls) | `live_auth.rs` | `write_session_record_for` | Early operator acceptance. | Yes. | **Deleted** for `repo-code` (limits optional); `repo-inspect` keeps its bounds. |
| Daemon automated policy: **5000 edits / 2000 commands per task** | `daemon/server.rs` `AutonomousConfig` | `evaluate_autonomous_policy` | Second, independent copy of the same quota, deeper in the stack. | Yes — a second ceiling hiding behind the first. | **Deleted** (also removed from the policy digest). |
| **Attempts per task: 5000** (once 96) | `config/registry/native-intent-bridge.cjs` `MAX_ATTEMPTS` | `attempt-add` → `LoopEnd::Limit("max-attempts")` | "Stop a runaway ledger". | Yes: it ended a real self-development run at 92 turns + recoveries. | **Deleted**; the ledger is now append-only (it rewrote the whole file every turn, O(n²)). |
| **Distinct files touched per direct task: 4000** | `tools/direct.rs` `MAX_TOUCHED` | `Store::record_pre` → `scope-refused` | Bound the manifest. | Yes: refuses the 4001st file; also 8 MiB manifest read cap, and the manifest was rewritten wholesale per operation. | **Redesigned**: per-file records (`ent/`), appended `dirs.jsonl`; no count limit; cost per operation constant. Legacy stores still read. |
| Run view kept the **last 64** tool calls only | `inspect.rs` `MAX_ACTIVITY` | `Ctx::progress`, final update | Keep the run record small. | Silently lost receipts from the view ("64 steps" of 100). | Kept as a **window**; every call is appended to a durable per-run log, `activityTotal` says how many, `intent_activity` pages the rest, the Desktop shows "N earlier steps". |
| Memory-fold receipts named **every** changed file | `inspect.rs::receipts_summary` | context fold | Tell the model what exists. | At thousands of files it consumes the context window (and was O(n²)). | Names the latest 40, counts the rest (byte-identical below 40 files). |
| Consecutive refused calls → stop (3 strict / 25) | `MAX_CONSECUTIVE_REFUSALS` | per call | No-progress guard. | It punished *quota* refusals, so one quota produced a failure cascade. | Kept as a generic backstop; **evidence-based stagnation** added (2.6). |

### 2.2 Per-operation physical bounds — kept (they bound ONE operation, never the task)

| Bound | Where | Reason | Response when exceeded |
|---|---|---|---|
| One `fs_write` ≤ 98,304 bytes; one `fs_edit` ≤ 16 operations, ≤ 64 KiB per text | `nexus-model/repo_tools.rs` (frozen provider schema), `code.rs`, `nexus-tools/contract.rs` | A single operation is validated and applied atomically in memory; the schema is a **frozen catalog** and must not change. | Now an **actionable** refusal naming the way to split ("a limit of a single operation, not of the task: write the file in parts … or split it into several modules"). |
| One file ≤ 2 MiB result (policy), ≤ 1 MiB read (`maxFileBytes`), ≤ 16 MiB pre-image kept | `daemon/server.rs` `AutonomousConfig.max_write_bytes`, kernel grant budgets, `direct.rs` `MAX_PRE_BYTES` | Whole-file atomic write / digest verification must fit memory. | `file-too-large` / `scope-refused` with the reason; the model works in smaller files. |
| Command wall clock 15 min, memory 4 GiB, 512 processes, output 256 KiB, scratch 1 GiB (`proc*` budgets); install/build 15 min | `inspect.rs::budgets_for`, `workbench.rs` | Kill a runaway child; bound memory. | Truncated output flagged `truncated`; timeout reported as such. |
| One tool result handed to the model ≤ 24 KiB (`PER_RESULT_BYTES`); one read ≤ 800 lines; one search ≤ 100 matches | `inspect.rs`, `repo_tools.rs` | Keep a single result inside the context window. | Truncation flag; the model pages with line ranges. |
| One provider response: ≤ 3 MiB text, ≤ 768 KiB tool arguments, ≤ 32,768 events, 180 s idle / 900 s total (interactive profile) | `main.rs --interactive-profile`, `transport.rs` | Bound one HTTP exchange. | Recovered as a provider interruption (`payload-too-large`); nothing is charged to the task. |
| One request body ≤ 4 MiB, ≤ 480 input items | `nexus-model/request.rs` | Provider-facing size. | Handled by context management (2.4), never by refusing work. |
| IPC frames (80 KiB client, 1 MiB / 4 MiB daemon), 32 daemon clients, 128 broker connections, 4 in-flight tools | `server.rs`, `daemon/protocol.rs` | Memory / DoS bounds on local sockets. | Protocol errors with codes. |
| Path length 4096, component 255, depth 64, ≤ 8 new directories per write | `workspace.rs` | Filesystem sanity, path-validation surface. | `path-invalid`. |
| Command observation lists ≤ 2000 paths per execution, effects scan ≤ 60,000 entries, ledger rings (64 observations, 32 engine attempts, 64 engine events) | `direct.rs`, `process.rs`, `engine_state.rs` | **Bounded memory for evidence**, always flagged `complete: false` with the true counts when exceeded. | Honest "not all listed"; nothing is refused. |

### 2.3 Security and authorization boundaries — kept, untouched

Kernel-sealed grants (fs scratch/workspace/full, net offline/install/controlled/full, approval auto/ask, `devPorts`,
checkpoints, hard links, git write), bubblewrap/seccomp/Landlock sandbox, cgroup limits, workspace/path validation
(symlinks and hard links refused, protected names), network egress policy, native consent dialogs, provider
authentication, schema/argument validation, the daemon's per-file policy, the revocation watcher, approval TTL
(5 min, `approval_ttl_ms`), `CONSENT_TTL_MS` (90 days), grant validity (≤ 366 days). **None of these is a work quota.**

### 2.4 Context and conversation growth — kept; they never refuse work

`context.rs` (compact at 440 items / 1.2 MB, working-memory fold at 330 items / 800 KB, keep the last 36 items, stub
old results above 600 bytes), the conversation memory budget (`CONTEXT_BUDGET_BYTES` 48 KiB, `MAX_RECEIPTS` 120 per
thread), request-size budget (off by default). These shorten what is *re-sent* while the runtime's own receipts and
the durable logs keep everything; they are why a task can be unbounded while each request is bounded. The memory-fold
receipt list was the only part that scaled with the task (fixed, 2.1).

### 2.5 Limits a person may choose — kept, opt-in, default none

`maxTurns`, `maxToolCalls`, `maxRuntimeSecs` (Settings → "Optional: limit your own cost or time"; broker
`--code-cap-turns/-tool-calls/-minutes`; CLI flags; `intent-limits-set`). They are the only way a loop ends at a count
or a clock, are shown as the person's own ("Your limits …", "stopped at the limit **you** set"), and a stopped run keeps
all its work and continues on the next message. Per-call `max_output_tokens` (1024 strict / 32,768 interactive) is a
provider request parameter and stays byte-identical (provider-body baselines).

### 2.6 Loop termination

| Ends the loop | Kind | Status |
|---|---|---|
| User cancel, shutdown | user | unchanged; tested at 3,000-operation scale |
| Authorization revoked / grant inactive / authority failure | security | unchanged; tested |
| Provider outage: 14 consecutive failures, exponential backoff 2 s → 60 s, context squeeze | provider | unchanged — **no unbounded paid retry** |
| Provider refusal / unavailable | provider | unchanged |
| A limit the person chose | user | opt-in |
| Same refused call repeated **8×** unchanged | evidence-based stagnation | **new**: nudge at 3 repeats (guidance, never authority), stop at 8 with the call, the reason and what to do; any executed call resets it |
| Consecutive refused calls (3 strict / 25) | backstop | message now actionable; no longer fed by quotas |
| Many edits, many tests, many turns, large output, repeated verification | activity | **never a termination reason** |

### 2.7 Things examined and deliberately left

`MAX_PROJECTS 64` (registry file size; a different product surface), `repo-inspect` bounds (12 turns / 40 calls: the
read-only inspection product, not engineering), nudge counts in engines (`MAX_NUDGES`, `MAX_STEERS`: how often a
*reminder* may be repeated), Adaptive governor ring sizes, `MAX_CHAIN_DEPTH 8` (how many *state-less* predecessors are
examined when proving a continuation; a long conversation has state at every run, tested with 12 runs and a restart),
Kernel grant TTLs (120 s / 5 min per operation, renewed per call).

## 3. Rule applied

A limit may exist only if it is (a) a per-operation physical bound with an actionable response, (b) a security or
authorization boundary, (c) provider-imposed, or (d) chosen by the person. Anything else — including every cumulative
count, byte total or wall-clock ceiling over a whole task — is removed, not enlarged.
