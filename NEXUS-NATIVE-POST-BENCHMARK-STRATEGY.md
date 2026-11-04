# Nexus Native — Post-Benchmark Engineering Review & Strategy

Date: 2026-11-03 · Branch: `feature/linux-arm64-port` (uncommitted M4.6 tree) · Scope: the first fully instrumented Job Scheduler run (`run_faf5b5f83191930c9ed1b07707702790`) against the Nexus DSH run of the same task.

Nothing was committed, pushed, rebuilt or changed in the product. All findings below come from the recorded trace, the source code, the two generated projects and DSH's own logs. Where something could not be measured, it is listed as a suspicion with the measurement that would settle it.

---

## 1. Executive summary

1. **The `verified-failed` verdict was a false negative that the controller created itself.** The generated project built cleanly and passed its own 16 integration tests repeatedly on the final source. The model ran a diagnostic, `touch … && cargo build 2>&1 | grep -i 'warn' ; echo …; ls …`. M4.2 rightly treated it as unattested because of the `;` list. But the re-check the controller *derived* for it was `touch src/lib.rs src/main.rs && cargo build 2>&1 | grep -i 'warn'`. The Kernel prepends `set -o pipefail`, so on a warning-free build that command can only exit 1 (grep: no lines selected). The controller handed the model that command in call 102's result, then three more times at the final boundary, each time with "run exactly this command… do not change it". The model ran it four times, and each run was recorded as a new failed check. Two older failures stayed open only because their command text did not match later passes, and the model was never told they were still open. End state: 3 "failed" and 2 "unattested" checks, all artefacts of matching rules. Writeback to the Mac was blocked under every policy. The run's 30 minutes of work never reached the user.
2. **The cache gap (96% vs 76.9%) is real, uses the same definition on both sides, and is entirely self-inflicted.** Two mechanisms predict every cache miss in the trace:
   - **Reasoning replay window.** Native keeps only the newest 12 replayed reasoning items (`REASONING_REPLAY_ITEMS = 12`). Every response with reasoning therefore deletes an item from the middle of the conversation and breaks the cached prefix there. This accounts for 78.8% of uncached input, with 54 of 55 such requests missing.
   - **Adaptive effort switching.** Each medium↔high switch re-keys the cache. This accounts for 18.3%, with 11 of 11 switches missing.
   - **All other requests hit the cache:** 58 of 58.
   
   DSH turns reasoning replay off for exactly this route (`opencode-go` + `muse-spark-1.3-contributor` → `none`) and runs a constant xhigh effort. A perfectly stable prefix would give Native **98.6%** on this very trace.
3. **The throughput gap (138 vs 77.5 tok/s) comes from the metric definitions, not the provider.** DSH divides by decode time only, from first token to completion. Native divides by full request latency, including time-to-first-token and the model's hidden reasoning. On matched definitions:
   - Native decode rate for visible output is ≈ **144.5 tok/s**.
   - DSH end-to-end rate is ≈ **91.8 tok/s**.
   - Nothing suggests the provider served Native more slowly.
4. **The 2× wall-time gap (+908 s) splits into four parts. Only about 125–175 s of it is controller waste.**

   | Part | Extra seconds | Cause |
   |---|---|---|
   | Dependency fetch | +282 | `cargo fetch` took 283 s inside the VM; DSH's 63 crates downloaded in about 1 s on the Mac. |
   | Synchronous builds and tests | +268 | Native runs them synchronously in a 4-vCPU / 2 GB VM. DSH runs them as *background jobs* on the M1 Pro host, so its 27 s "tool time" excludes compilation. |
   | Model time | +271 | Native did 116 operations against DSH's 62, plus a 20-request controller tail after the model's first final report. |
   | Controller and approval overhead | +86 | Per-step overhead; not yet broken down (see §5.6). |

5. **Most of Native's extra work was justified.** Repeated verification found and fixed three genuine defects:
   - SQLite lock contention silently dropped outcomes and left jobs stuck in `running`.
   - `cancel` did not stop running child processes.
   - A test-data race in the SIGKILL recovery test.
   
   The exception is the post-report loop: 20 requests, 175 s of wall time and **24% of all input tokens**. Its last 13 requests (107 s, 1.1 M input tokens) were pure waste.
6. **Neither generated scheduler is clearly better.** Each has hidden defects the other lacks, and both share two:
   - Neither stops a second scheduler instance from re-queuing jobs that are still running.
   - Neither kills a job's whole process group on timeout or cancel.
   
   DSH's "completed" rested on masked commands such as `cargo build … | tail -5 || cargo build …` and `cargo test 2>&1 | tail -60`, which its harness does not check. Self-written test counts (21 vs 16) say nothing about quality.

**Decision.** The next milestone should be **M4.7 — Evidence Precision and Prefix Stability**:
- **Phase 0:** a deterministic replay harness built from this trace.
- **Phase 1:** make the verification controller unable to *manufacture* failures or issue re-checks that can't be satisfied, without weakening any masked-failure protection.
- **Phase 2:** stabilise the prompt prefix (reasoning-replay policy, cache-aware effort changes), behind configuration and validated by A/B runs.
- **Phase 3:** measurement only for dependency fetch, VM sizing, transport and controller overhead, to decide M4.8.

Things not recommended now: parallel tool calls or a code-mode tool (DSH did not batch either), background verification builds, VM resizing, and any relaxation of the M4.2 rules.

---

## 2. Evidence base and method

| Source | What it gave |
|---|---|
| Run record `intent_status` (Native) | Completion, coding outcome, unresolved counts, verification ledger, dependency ledger, permission events |
| Analytics export `nexus.run-analytics` v1 | 125 per-request records (tokens, cached, reasoning, effort, phase, latency, TTFT), phases, tool timings (first 50 commands) |
| Tool activity (116 records) | Every call's args summary, exit code, verdict, composition class, assessment |
| Model transcript (716 events) | Exact tool inputs and results the model saw, every controller nudge, every assistant message |
| Guest working copy (9 files, via an un-acknowledged export plan) | The generated Native scheduler |
| Two earlier Native scheduler runs (`run_dbdb…`, `run_ba08…`) | Run-to-run variance |
| DSH `.ai-harness/runs/TASK-0002/context-pressure.json` | DSH cumulative uncached / cache-read / output tokens, 64 model calls |
| DSH session log (1,111 events, zstd JSONL) | DSH step timeline, tool calls, background jobs, injected messages |
| DSH sources: `dsh-session-stats`, `config/ContextWireProjectorResponsesV2.cjs`, pi-ai `openai-responses.js` | DSH metric definitions, `prompt_cache_key`, reasoning-replay policy |
| `~/benchmarks/nexus dsh/` | The generated DSH scheduler and its file timestamps |
| Native source | `compose.rs`, `inspect.rs`, `completion.rs`, `claims.rs`, `engine/muse_v0.rs`, `verification/*`, `nexus-tools/src/process.rs`, `nexus-model/src/prepare.rs`, `transport.rs`, `telemetry.rs`, `sync/host.rs` |

**How the Native evidence was obtained.** Nexus.app was quit, with permission. A read-only client then spoke the bridge's JSON-lines protocol through `nexus-vm attach`. It called `intent_status`, `run_analytics_export`, `intent_activity`, `thread_get`, `conversation_read` and the sync `export-plan`/`export-read` pair. It never sent `export-ack`, a confirm reply or a secret reply. The only guest-side effect was that `export-plan` refreshed its own plan file, which the next real writeback regenerates anyway. The bridge accepts one host connection at a time, which is why the app had to be closed.

**Limits of this evidence:**
- There is one run per harness, and Native's own runs vary widely (18.2, 24.0 and 29.8 minutes on the same task).
- The environments differ: a Linux microVM with sandbox and egress control, against the macOS host.
- The efforts differ: adaptive medium/high against constant xhigh.
- No test in either generated project was executed during this review.
- Native TTFT exists for only 53 of 125 requests.
- DSH's first-token definition (`isTokenDelta`) was not reproduced exactly.

---

## 3. Benchmark comparison

| Metric | DSH | Native | Comparable? | Note |
|---|---|---|---|---|
| Wall clock | 877 s (14m37s) | 1,785 s (29m45s) | As wall clock, yes; as harness quality, no | Host vs VM, network path, CPU, background vs synchronous builds |
| Model time | 845 s (64 calls) | 1,116 s (125 requests) | Roughly | Both are the sum of per-call start→end |
| Tool time | 27.2 s | 578 s | **No** | DSH counts *blocking* tool time only. Its `cargo build`/`cargo test` ran as 7 background jobs polled with `job_output`. Native runs everything synchronously, including a 283 s `cargo fetch` |
| Input tokens | 4,124,264 | 6,969,413 | Yes | Provider-reported, same provider and model |
| Uncached input | 165,770 | 1,612,041 | Yes | **9.7×**; mechanism in §5.4 |
| Cache hit | 95.98% | 76.87% | **Yes** | Both are cache_read ÷ input. DSH: 3,958,494 ÷ 4,124,264 |
| Output tokens | 77,567 | 86,521 (31,854 reasoning) | Yes | |
| Throughput | 138 tok/s | 77.5 tok/s | **No** | DSH: decode only. Native: end to end with TTFT. Matched: DSH ≈ 91.8 end to end; Native ≈ 144.5 decode (visible output) |
| TTFT | (not reported; ≈1.7 s first chunk) | 9.6 s avg (53 samples) | **No** | Native TTFT is first *visible* token and includes hidden reasoning; requests that only proposed tools have none |
| "Tool steps" | 64 | 116 | **No** | DSH 64 = model steps (63 `run_code` calls, 62 sub-operations). Native 116 = atomic tool calls |
| Effort | xhigh (constant) | medium 59 / high 66, 11 switches | No | Changes reasoning volume, latency and cache behaviour |
| Tests | 21/21 (self-written) | 16/16 integration (self-written) | **No** | Different suites; neither was independently checked |
| Final state | completed (model's claim) | verified-failed (controller false negative), not written back | No | DSH's harness never checked its verification commands; Native's checked too strictly and wrongly (§4) |

---

## 4. Verification-controller findings (trace-based)

### 4.1 The closing phase, request by request

| Request | What happened |
|---|---|
| A105 (t = 1,610 s) | Model's first final report. Two hazards are open: call 96 (a `for` loop over the test binary) and call 102 (`… \| grep -i 'warn' ; echo …; ls …`). |
| A105 → A111 | `hazard_guard` on call 96 (1st of 3; hazards are taken in call order): "run each check as its own plain command". The model reruns `touch && cargo build`, each timing-sensitive test, and `cargo test`. All pass. Hazard 96 does **not** clear (§4.4). |
| A112 → A114 | `hazard_guard` on call 96 (2nd). The model also runs the `nexusRecheck` that call 102's result carried, "exactly as Nexus specified": `touch src/lib.rs src/main.rs && cargo build 2>&1 \| grep -i 'warn'` (call 111). Exit 1, empty output. Recorded as **failed**. It explains that exit 1 means "no warnings" and runs plain `cargo build` (call 112): exit 0. Neither the failure nor either hazard clears. |
| A115 → A116 | `hazard_guard` on call 96 (3rd). `touch … && cargo test` (call 113) passes the full suite. Hazard 96 is still open. |
| A117 → A122 | `hazard_guard` on call 102, three times: "Run exactly this command on its own… do not change it", followed by the grep command. The model runs it verbatim each time (calls 114–116): exit 1 each time. |
| A123, A124 | The engine's `premature_stop` sends "last verification failed" twice (`MAX_FAIL_NUDGES = 2`). |
| A125 | The model's final answer correctly explains grep's exit contract. The run ends `completed` / `failing-checks` / `verified-failed`. Writeback reason: *"a verification check ran inside a compound command that cannot show it passed"*. |

Cost of the tail after the first final report: 174.8 s of wall time, 20 requests, 1,693,852 input tokens (24.3% of the run) and 268,232 uncached. Of that, A113→A125 (13 requests, 106.9 s, 1,110,690 input) was a loop with no possible exit.

### 4.2 Why these commands counted as verification checks

- `is_verification_command` / `segment_verifies` ([inspect.rs:5298](native/nexus-broker/src/inspect.rs:5298)) recognises a `cargo build` segment anywhere in a script. Diagnostic intent is not modelled, and cannot be: the controller sees text, not purpose.
- For an exit-0 check, `compose::analyze` ([compose.rs:926](native/nexus-broker/src/compose.rs:926)) decides trust. Call 102 is a `;` list, so it is `Unattested(command-list)`. That is correct and must stay.
- For a non-zero exit, no composition analysis runs: "a non-zero status is always a real signal" ([inspect.rs:5196-5203](native/nexus-broker/src/inspect.rs:5196)). The command lands in `failed_checks` under its exact text.

### 4.3 What exit 1 meant

`apply_pipefail` ([process.rs:1003](native/nexus-tools/src/process.rs:1003)) prepends `set -o pipefail`, and the receipt says `"pipefail":"applied"`. A pipeline's status is then the rightmost non-zero stage. With `cargo build` exiting 0 and `grep` exiting 1 (no lines selected), the pipeline returns 1. The empty stdout and stderr confirm it. The derived re-check therefore fails exactly when the build is *clean*. It was never a statement about the build. The Kernel's `verdict` already handles one such ambiguity: exit 141 under pipefail, a stage cut off by SIGPIPE, is `unverified` ([process.rs:1017](native/nexus-tools/src/process.rs:1017)). There is no equivalent rule for a trailing selecting filter.

### 4.4 The five open items at run end, and why none could close

| Item | Actual state of the project | Why it stayed open | Rule responsible |
|---|---|---|---|
| Failed: call 27, `sh -c "grep …; echo ---; cargo build --offline \| tail -5"` (exit 101) | A real failure at the time: offline, dependencies not yet fetched. The controller itself labelled it `needs-network`. `cargo fetch` then succeeded and `cargo build` passed 6+ times | A `sh -c` script's identity is its exact text ([completion.rs:556](native/nexus-broker/src/completion.rs:556)); the model never re-ran that string | Exact-identity supersession |
| Failed: call 44, `cargo test --test integration simultaneous_job_completion -- --nocapture --test-threads=1` (exit 101) | A real bug at the time (lock contention), fixed. The full suite and the same test without `--test-threads=1` later passed | `--test-threads` is part of the identity (by design), so neither a narrower nor a broader pass clears it | Identity granularity, plus the fact that nobody told the model (§4.5) |
| Failed: `touch … && cargo build 2>&1 \| grep -i 'warn'` (×4, exit 1) | Build clean, zero warnings | A filter's exit code was recorded as the check's failure. Only a pass of the same text clears it, and that text cannot pass on a clean build | Derived re-check keeps the filter; no ambiguity rule |
| Hazard: call 96, `for i in 1 2 3; do <test-binary> recovery… simultaneous… --test-threads=4 2>&1 \| tail -1; done` | The same tests passed via `cargo test --test integration <name>` and the full suite | Unanalysable, so `required` = the binary invocation's exact words. `satisfies` ([compose.rs:1101](native/nexus-broker/src/compose.rs:1101)) needs those members verbatim, yet the guidance said "run each check as its own plain command", which the model did | Guidance and satisfaction rule disagree |
| Hazard: call 102 | Build clean | Its derived command is the item above; it can only pass if the build *emits* warnings | Derived re-check keeps the filter |

### 4.5 How compound-command trust and failure tracking interact

- **Two ledgers, two resolution rules.** Hazards clear only by an *attested pass* whose members match `required` member for member. Failed checks clear only by a *pass of the same `check_identity`*. A failing derived re-check of a hazard is recorded in the *other* ledger under a new identity, so one bad re-check creates two open items.
- **Asymmetric analysis.** Composition is analysed only on exit 0, which is correct for masking. On non-zero exit the whole script's status is attributed to the check, which is wrong when the failing stage is a trailing filter.
- **Nudge budget spent on the wrong item.** The final-boundary order is: `hazard_guard` (3 per hazard) → `invalid_check_guard` → engine `premature_stop` → verification feedback ([inspect.rs:3909](native/nexus-broker/src/inspect.rs:3909) onwards). In `premature_stop` ([muse_v0.rs:275-299](native/nexus-broker/src/engine/muse_v0.rs:275)), rule 3a ("failed checks never re-run", which names them via `unresolved_checks_message`) fires only when the *last* check passed. Because the last check was the false grep failure, rule 3 ("last verification failed", generic) used both nudges. **The model was never told that calls 27 and 44 were still open.** Re-running each would have taken one request.
- **The new Verification Engine would have classified this correctly but has no authority.** `verification::evidence::classify_command` ([evidence.rs:488](native/nexus-broker/src/verification/evidence.rs:488)) treats any shell composition, pipelines included, as `Indeterminate`, which becomes `Inconclusive` and not `Failed`. It also supports freshness-based supersession. But it runs as a shadow, and in a direct workspace with in-place execution its freshness is always `Indeterminate` ("other-writers-possible", freshness.rs rule 5). Its verdict was `inconclusive`, so it could not supersede anything. Writeback ([sync/host.rs:476](apps/nexus-desktop/src-tauri/src/sync/host.rs:476)) gates on the legacy `codingOutcome`.

### 4.6 Was the controller too conservative, or correct under its contract?

- **To the letter of its contract, it behaved as specified.** It never credited an unattested pass, never credited a narrower pass, and required exact re-establishment. Those are the right instincts for avoiding false *positives*.
- **The contract itself is unsound in three places:**
  1. It **manufactures** failures: a filter's exit code is treated as the check's.
  2. It issues re-check instructions it will not accept: hazard 96, and hazard 102 on any clean build.
  3. It labels open obligations "verified-failed" when the evidence shows the latest run of every real check passing. "Unverified" is the strongest negative claim the evidence supports.
- **Conservative should mean "credit nothing you cannot prove", not "invent failures you cannot prove".**

### 4.7 Should the model have run a better diagnostic instead?

Partly, but that is not the fix:
- The original diagnostic was reasonable engineering: look for warnings after a forced rebuild.
- The controller then *dictated* the bad command and forbade changing it.
- When the model did run better commands, the controller did not accept them. These included plain `cargo build` (call 112), `touch … && cargo build` (call 105) and `touch … && cargo test` (call 113).

A short tool-description hint is cheap and worth adding (§9, 1g): "to inspect warnings, run the check plainly and read its output; don't pipe checks into grep or chain them with `;`/`||`". It lowers how often this happens. It cannot fix a controller that turns any `check | grep` into a trap, and other models will write such commands.

### 4.8 Masked-failure protections that must survive

`check; echo done`, `check || true` and `check && echo ok; echo end` are `command-list` / `or-list` → `Unattested` (compose tests at [compose.rs:1135](native/nexus-broker/src/compose.rs:1135)). Every change proposed in §9 acts only *within one pipeline*, on its trailing filter stages, or on *how a re-check is phrased and matched*. None changes how `;`, newline, `||`, control flow or substitution are trusted, and none promotes a non-zero exit to a pass.

---

## 5. Bottleneck analysis

### 5.1 Wall-time decomposition

| Component | Native | DSH | Δ | Attributable to |
|---|---|---|---|---|
| Dependency fetch | 283 s | ≈1 s (inside a background build) | +282 | VM network/egress path (cause unknown, §5.2) |
| Other tool execution (blocking) | 295 s | 27 s | +268 | Synchronous builds/tests in a 4 vCPU / 2 GB VM vs background jobs on an 8-core host; more test runs (justified, §5.3) |
| Model requests | 1,116 s | 845 s | +271 | 116 vs 62 operations; 20-request controller tail (125 s of latency) |
| Controller + approval | 91 s | ≈5 s | +86 | Per-step overhead, not yet broken down (§5.6) |
| **Total** | **1,785 s** | **877 s** | **+908** | |

### 5.2 Tool execution (578 s)

- **`cargo fetch`: 282.7 s, the single largest item (16% of wall).** DSH's 63 `.crate` files have modification times spanning about 1 s (08:02:42–43). Native's fetch went through the VM's egress path. The cause is **not established**. Candidates: proxy throughput, per-request TLS or connection setup for the sparse index, DNS, or VM networking. It is also unknown whether `CARGO_HOME` persists across projects on the state disk. Measure before changing anything (§9, Phase 3).
- **Failing runs that waited on hung children: 61.7 s.** `cargo test` (call 43, 31.2 s) and the isolated `simultaneous_job_completion` run (call 44, 30.5 s) waited on a child process the code under test never killed. This is genuine product debugging, not overhead.
- **Repeated full and partial suites: about 15 × 8–10 s.** These include three consecutive full integration runs and a 3× loop (24.8 s). The model said it was stress-testing for flakiness, and **that found a real test-data race**. This is the extra verification paying off, not controller inefficiency.
- **Manual CLI reproductions: about 36 s** (calls 47, 52, 89; 15.3 / 10.3 / 10.4 s). They led to the lock-contention fix.
- **VM resources: suspected, not measured.** The VM has 4 vCPUs and 2 GB, the host 8 cores and 32 GB. A first build of `rusqlite` (bundled SQLite C) plus `clap` and `chrono` in 2 GB is a plausible slowdown.
- **Not attributable to the controller:** the Kernel's own overhead per command was small. For example, `rustc --version` took 357 ms and simple `sed` reads about 250 ms. That includes sandbox setup but is negligible in total.

### 5.3 Model requests (125 requests, 1,116 s)

- **One tool per request.** `parallel_tool_calls: false` ([prepare.rs:188](native/nexus-model/src/prepare.rs:188)). But **DSH was not batching either**: 62 sub-operations in 64 steps. The real difference is *how many operations* each harness ran.

  | Harness | Operations |
  |---|---|
  | Native (116) | 66 `proc_run`, 22 `fs_edit`, 15 `fs_read`, 9 `fs_write`, 3 reasoning-state, 1 `fs_list` |
  | DSH (62) | 34 bash, 8 read, 7 edit, 7 job_output, 3 write, 3 todo |

  DSH wrote files in large heredoc chunks and debugged less.
- **Small requests:** 56 requests produced fewer than 200 output tokens and fewer than 50 reasoning tokens. They took 186 s in total (median 3.0 s), the fixed per-request cost.
- **Big writes:** 11 requests produced ≥ 2,000 output tokens each (48 k tokens, 473 s). That is generation inherent to the task.
- **The controller tail:** 20 requests and 125 s of latency after the first final report (§4.1).
- **Effort** split 59 medium / 66 high with 11 switches. On cache, see §5.4. On quality, it is not measurable from one run.

### 5.4 Context and cache efficiency

The context is append-only apart from two mutations. Classifying every request by what changed since the previous one:

| Class | Requests | Hits / misses | Uncached input | Share |
|---|---|---|---|---|
| Stable (no reasoning item dropped, same effort) | 58 | 58 / 0 | 41,419 | 2.6% |
| Oldest replayed reasoning item dropped (previous response had reasoning, more than 12 items held) | 55 | 1 / 54 | 1,270,525 | 78.8% |
| Effort switch | 11 | 0 / 11 | 294,889 | 18.3% |
| Cold first request | 1 | n/a | 5,208 | 0.3% |

**Mechanism 1: reasoning replay window.** `push_model_reasoning` ([inspect.rs:3142](native/nexus-broker/src/inspect.rs:3142)) appends each response's reasoning items and then drops the *oldest* ones to keep `REASONING_REPLAY_ITEMS = 12` ([inspect.rs:3136](native/nexus-broker/src/inspect.rs:3136)). Each drop deletes an item from the middle of the conversation, so the provider's cached prefix ends right there.
- The signature is exact. Request 16 is the first after the 13th reasoning item, and its cache stops at 5,105 tokens, which is where the first reasoning item sat, just after the task.
- Later misses stop at 37,361 → 39,409 → 40,049 → … tokens, moving forward exactly as the oldest surviving item does.
- The ten "context shrank" requests are the cases where the dropped item was larger than what was appended.

**Mechanism 2: effort is part of the cache key.**
- Request 5, the first `high`, cached 113 tokens.
- Request 7, back to `medium`, cached 6,257 tokens. That is the medium prefix of request 4 (6,261 tokens), still warm.
- Every switch re-prefills the whole conversation.
- The effort limiter ([effort_limiter.rs](native/nexus-broker/src/engine/effort_limiter.rs), `DWELL_DECISIONS = 2`) dampens thrashing, but its policy does not price cache invalidation.

**What DSH does** ([ContextWireProjectorResponsesV2.cjs:70](config/ContextWireProjectorResponsesV2.cjs:70)):
- `reasoningReplay: none` for this exact route. The file's own note says OpenCode Go serves Muse from pooled upstream callers whose encrypted reasoning content is not countable on this route.
- Constant xhigh effort.
- `prompt_cache_key = sessionId` ([:769](config/ContextWireProjectorResponsesV2.cjs:769)), plus an `x-client-request-id` header from pi-ai.

Native sends only `x-opencode-session`. The comment above `push_model_reasoning` says replay works "as DSH's adapter does"; that is no longer true for this route.

**Counterfactual.** With a stable prefix, Native's uncached input on this trace would be about 96,866 tokens, a **98.6%** hit rate. No `prompt_cache_key` change is needed to explain the gap: stable requests already hit 58 of 58.

**Latency effect is small; cost effect is large.**
- Among small requests, median latency was 2.83 s on a hit and 3.11 s on a miss: about 0.3 s per miss, roughly 20–30 s over this run.
- Uncached input would fall by about 90%. On this plan the billed cost was $0; the list-price equivalent was $0.189.

**Cache granularity (observation).** Cached counts are always 113 + 128·k. The provider caches in 128-token blocks after a 113-token header.

### 5.5 Model throughput

| Definition | DSH | Native |
|---|---|---|
| Output ÷ full request latency (TTFT included) | 91.8 tok/s (77,567 / 845 s) | **77.5 tok/s** (reported) |
| Output ÷ decode window (first token → end) | **138** (reported, DSH's own first-token filter); 105 by my recount using the first chunk of any kind | 144.5 (visible output, first visible token; 53 requests) |

DSH computes `decodeTokens / decodeMs` with `decodeMs = completion − firstTokenTime` (`dsh-session-stats`). Native's figure is end to end by design (M4.6 §3). Native's TTFT includes hidden reasoning, because reasoning summaries are not requested. **Do not optimise on the 138 vs 77.5 comparison.** On matched definitions Native is not slower per token. It makes more requests and pays the fixed per-request cost more often.

### 5.6 Controller overhead (81 s) and transport

- **Controller overhead:** 0.65 s per request on average. The remainder covers grant sealing and daemon redemption ("Sealed agentic grant presented; redeeming with the daemon" on every attempt), Registry issuance, approval-policy evaluation, persistence and telemetry. It is not broken down per step, so it is a **suspicion, not a finding**.
- **Transport:** every request opens a new TCP and TLS connection (`connection: close`, [transport.rs:530](native/nexus-model/src/transport.rs:530)). At 125 requests that is plausibly 10–40 s. Unmeasured.
- **Approval wait:** 10 s in Full Access, about 87 ms per call. Negligible.

---

## 6. Engineering quality of the generated code

Neither project's tests were run during this review. The findings below come from reading the code.

| Criterion | Native (`job-scheduler`, 1,697 source lines + 806 test lines) | DSH (`sched`, 1,618 source lines + 469 test lines) |
|---|---|---|
| Transactions | Deferred (`unchecked_transaction`) for read-then-write; a 40× retry loop on outcome recording (added after the model *found* lost outcomes under contention); dependency-failure propagation not transactional | IMMEDIATE everywhere (claim, finish, cancel, recovery); per-attempt `runs` rows |
| Duplicate execution | **No single-instance guard.** `run()` → `recover_interrupted()` re-queues every `running` row, so a second scheduler re-runs live jobs (`scheduler.rs:76`; the comment at `:642` admits "recovered by another scheduler") | **Same defect.** `startup_recovery` re-queues all running jobs; `finish_run` does not check the attempt is still current, so stale workers overwrite newer state. The module doc's claim that two schedulers "cannot double-run a job" is false |
| Timeout / cancel | SIGKILL to the `sh` pid only, so grandchildren of compound commands survive and hold the pipes; the drain threads then block. Cross-process cancel uses the stored `worker_pid`, a PID-reuse risk after a crash | SIGKILL to `sh` only (`start_kill`, `scheduler.rs:355`), the same grandchild issue; cooperative cancel flag (no PID-reuse risk) |
| Output handling | **Panics on non-ASCII output over 8 KB:** `String::truncate(8000)` and `s[..8000]` split UTF-8 (`scheduler.rs:500-502, 541-547`), so the worker panics on every retry and the job fails as "worker crashed". Concurrent stdout/stderr draining | **Deadlocks on stderr over ~64 KB:** stdout is read to EOF before stderr (`scheduler.rs:311-319`), so the child blocks and the job hangs until timeout, forever when none is set (`timeout_secs: Option`). Char-safe truncation |
| DB failure handling | Errors logged; loop continues; outcomes retried | A `finish_run` error propagates out of the scheduler loop (`scheduler.rs:144`), so the whole scheduler exits mid-run |
| Graceful shutdown | SIGINT/SIGTERM flag; waits for workers without bound; the handler locks a Mutex (not async-signal-safe, acknowledged in `main.rs:343`) | SIGINT/SIGTERM; bounded 30 s drain, then leaves jobs for recovery |
| Tests | 16 integration tests, including SIGKILL of the real binary, SIGTERM shutdown and a CLI smoke test; repeated under stress | 21 tests (15 integration, 1 SIGKILL recovery, 5 unit) |
| Verification evidence behind "pass" | Plain, attested `cargo test` / `cargo build` runs (the controller's ledger) | Masked commands (`… \| tail -5 \|\| cargo build …`, `cargo test 2>&1 \| tail -60`) that the harness never checked |

**Assessment.**
- Each implementation has one serious hidden defect the other avoids: Native's UTF-8 panic, DSH's stderr deadlock. They also share two (no instance lease, no process-group kill).
- The quality of the generated code is **comparable**. The harnesses differ more than the code.
- **Neither result is independently verified.** A fair comparison needs a black-box acceptance suite run against both outputs (§8, item 9).
- **Harness vs code.** Native's harness found and fixed three real defects through verification. DSH's harness accepted masked verification. Native's harness then refused a valid result for reasons unrelated to the code.

---

## 7. Metric comparability: what was misleading

1. **Throughput 138 vs 77.5:** different formulas (§5.5).
2. **Tool time 27.2 s vs 578 s:** DSH measures blocking time only, and its builds and tests ran as background jobs. Native's figure includes a 283 s dependency fetch on a different network path.
3. **"Tool steps" 64 vs 116:** DSH's figure counts model steps, Native's counts atomic tool calls.
4. **TTFT:** Native's is the first visible token (hidden reasoning included) for 53 of 125 requests; DSH's is the first streamed chunk.
5. **Tests 21/21 vs 16/16:** self-written suites of different scope.
6. **Final state "completed" vs "verified-failed":** different evidence contracts. DSH's is the model's claim; Native's is a controller false negative.
7. **Comparable and real:** input/uncached/output tokens and the cache-hit rate (same provider, same definition). Wall clock is comparable as a user experience, but not as a measure of harness efficiency.
8. **Instrumentation gap:** the M4.6 export lists only the first 50 commands ([telemetry.rs:685](native/nexus-broker/src/telemetry.rs:685)); 16 of 66 are missing here.

---

## 8. Ranked improvement opportunities

| # | Improvement | Expected impact | Complexity | Regression risk | Security | Confidence | Relevance |
|---|---|---|---|---|---|---|---|
| 1 | **Verification precision**: filter-aware re-checks, an ambiguity class for `check \| filter` exit 1, satisfiable hazards, name every open item at the final boundary, loop breaker, "unverified" ≠ "failed" (§9 Phase 1) | Removes this run's false negative and writeback block; −13 to −20 wasted requests in such runs; applies to any task | Medium (compose.rs, inspect.rs, completion.rs, muse_v0.rs; replay tests) | Medium; guarded by the replay corpus and masked-failure tests | Neutral if no non-zero exit becomes a pass (enforced by tests) | **Very high** (exact trace) | Direct |
| 2 | **Prefix stability**: reasoning replay none or append-only per certified route; cache-aware effort changes; a prefix-stability invariant test (§9 Phase 2) | Uncached input −80 to −94%; hit rate ≥ 95%; ≈20–30 s less prefill per long run; large cost reduction on metered plans | Low (one constant/policy, limiter dwell or pinning, a test) | Medium: possible quality change without reasoning replay; must be A/B tested | None | **Very high** for tokens; low for quality impact | Direct; general |
| 3 | **Dependency-fetch path**: measure, then fix the proxy/connection behaviour or persist a shared registry cache | Up to −280 s per cold project (16% of this run) | Unknown until measured | Low–medium | **Sensitive**: egress policy must stay intact | Low (cause unknown) | High for new projects |
| 4 | **Instrumentation**: decode tok/s (DSH-compatible), cache-break attribution per request, foreground/background tool split, lift the 50-command cap, controller-step breakdown | Makes the next benchmark honest; required to validate 2, 3, 6, 7 | Low | Very low | None | High | High |
| 5 | **Tool-description hint** for plain verification commands | Fewer compound checks (frequency to be measured) | Very low | Low; changes the frozen catalog digest, so a versioned profile is needed | None | Medium | Medium |
| 6 | **VM sizing** (vCPU/RAM) after measurement | Possibly 30–50% of non-fetch tool time | Low (vm.json) | Low; costs host resources | None | Low (unmeasured) | Medium |
| 7 | **Connection reuse** (keep-alive) in the provider transport | Plausibly 10–40 s per run | Low–medium | Low | Review: keep the transport's pinning and attestation guarantees | Low (unmeasured) | Medium |
| 8 | Parallel tool calls / code-mode tool | Uncertain: DSH did not batch; its code mode caused its own quoting failures | High (approval sequencing, edit pinning, receipts) | High | Approval semantics must hold per call | Low | Low now |
| 9 | Independent black-box acceptance suite for benchmark outputs (both harnesses) | Makes quality comparisons meaningful; would have caught the UTF-8 panic, stderr deadlock and double-run | Medium | None (outside the product) | None | High | High for benchmarking |
| 10 | Background verification builds (DSH-style) | Would hide compile time behind generation | High | High: freshness rule 5 makes background writers "indeterminate" | Medium | Low | Defer |

---

## 9. Recommended milestone: M4.7 — Evidence Precision and Prefix Stability

**Goal.**
- Native must never report a working, verified-by-its-own-receipts change as failed.
- Native must never tell a model to run a command it will not accept.
- Native must stop discarding its own prompt cache, all without weakening the M4.2 masked-failure guarantees or any security boundary.

**Non-goals:** changing writeback policy for genuinely unattested or failed checks; sandbox, egress or permission changes; batching or code-mode; background builds; VM resizing (Phase 3 only measures it).

### Phase 0 — Deterministic replay harness (gate for everything else)

- Extend the existing replay corpus (`native/nexus-broker/tests/fixtures/recorded_checks.json`, consumed at [compose.rs:1391](native/nexus-broker/src/compose.rs:1391)) with all 66 `proc_run` receipts of `run_faf5…`: argv, cwd, exit code, Kernel verdict, pipefail flag.
- Add a broker-level replay test that drives the receipt sequence through the same classification path as `inspect.rs:5100-5215` (assessment, `failed_checks`, `hazards`, `satisfies`) and through `decide_run_attested`.
- **Baseline assertion (must pass first):** today's code reproduces `failed = {27, 44, grep-derived}`, `hazards = {96, 102}` and completion `failing-checks`.
- Add a **prefix-stability fixture**: the 125-request item sequence (shapes and lengths only) to test Phase 2.

### Phase 1 — Verification precision

**1a. Filter-aware re-establishment** ([compose.rs](native/nexus-broker/src/compose.rs): `analyze_script`, the `required`/`derived` construction at :1017–1061, `satisfies` at :1101).
- Within a check-bearing pipeline, stages *after* the check stage whose program is a pure output filter are not part of the check: `grep`/`egrep`/`fgrep`/`rg`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`, `tr`, and `sed` without `-i`. Never `tee` or anything that writes.
- `required` and the derived re-check keep the check stage with its own redirects (`2>&1`) and drop the trailing filters. For call 102 the derived command becomes `touch src/lib.rs src/main.rs && cargo build 2>&1`.
- `satisfies` compares the required pipeline's prefix up to the check stage, so `cargo build`, `cargo build 2>&1 | tail -5` and the derived command all satisfy it.
- **Why this is sound:** under pipefail an attested exit 0 means every stage exited 0. A direct `cargo build` exit 0 is the check's own status. Separators (`;`, newline, `||`) and control flow are untouched, so the three masked shapes stay `Unattested`.

**1b. Ambiguous filter status** ([inspect.rs](native/nexus-broker/src/inspect.rs) assessment block around :5136, mirroring the 141 rule in [process.rs:1017](native/nexus-tools/src/process.rs:1017)).
- A check-bearing command whose final pipeline ends in a *selecting* filter (the grep family, `rg`) and exits **1** (or **2**, a grep error) under applied pipefail gets the assessment `unverified`, class `filter-status`, and becomes a **hazard** whose derived re-check is the filter-stripped command from 1a. It is **not** inserted into `failed_checks`, and `last_test` is not set to `fail`.
- Exit codes a selecting filter cannot produce (101, 2+ from cargo, and so on) remain failures.
- **Why this is safe:**
  - A real check failure masked as grep's 1 becomes an open obligation, never a pass.
  - The run cannot be `verified-passed` until the plain check passes.
  - If the plain re-check fails, a real failure is recorded under the check's own identity.

**1c. Every hazard has a re-check the controller will accept.**
- For unanalysable scripts (call 96), derive the plain check command found by the lenient scan, without the loop and without trailing filters, whenever that is a single direct invocation. Put it in `nexusRecheck`.
- Make `hazard_guard`'s text ([inspect.rs:1926](native/nexus-broker/src/inspect.rs:1926)) state exactly what `satisfies` will accept.
- **Invariant test over the whole corpus:** simulating a passing run of each hazard's stated re-check must resolve that hazard.

**1d. Name every open item at the final boundary.**
- Before the engine's generic rule 3 ([muse_v0.rs:288](native/nexus-broker/src/engine/muse_v0.rs:288)), emit one message listing every unresolved failed check and hazard with its exact re-run command, reusing `unresolved_checks_message` ([completion.rs:612](native/nexus-broker/src/completion.rs:612)).
- Give each item its own small budget instead of sharing `MAX_FAIL_NUDGES` across all of them.
- This would have closed calls 27 and 44 with one request each, *without* relaxing their identity rules.

**1e. Loop breaker.**
- If the same re-check produces the same non-pass result twice with no edit receipts in between, stop re-issuing it.
- Record the item as `recheck-inconclusive`, and show the person the receipts.
- This bounds the cost of any future controller defect at about two requests.

**1f. Outcome vocabulary.**
- `verified-failed` only when a check's *latest* result is a failure.
- Open obligations (hazards, filter-status, `recheck-inconclusive`) produce `unverified`.
- Writeback gating in `sync/host.rs:476` is unchanged: unattested and unverified results are still not applied automatically. Phase 1 fixes the *label* and the *path to resolution*, not the policy.

**1g. Optional tool-description hint.** One sentence in the `proc_run` description: run checks plainly; don't pipe them into grep or chain with `;`/`||`. It changes the frozen catalog digest, so it ships as a versioned profile and its effect on the frequency of compound checks is measured.

**Expected result on this trace.**
- Hazard 102 resolves at call 111: the model ran the controller's exact re-check there, and the corrected re-check passes.
- The grep "failure" is never recorded.
- Hazard 96 resolves with one exact re-run.
- Calls 27 and 44 close with one request each.
- The run ends about 10 requests earlier, roughly 80–110 s and 1.0 M input tokens less, as `verified-passed`, and is written back.

These figures are estimates from the trace; the Phase 0 replay is the authority.

### Phase 2 — Prefix stability (behind configuration, A/B validated)

**2a. Reasoning replay policy as a route capability** (replacing the constant at [inspect.rs:3136](native/nexus-broker/src/inspect.rs:3136)):
- `none` (DSH parity for `opencode-go`/`muse-spark-1.3-contributor`).
- `append-only`: never drop mid-run, only at compaction or memory fold, where the prefix changes anyway.
- `window` (today's behaviour), kept for comparison.

**2b. Cache-aware effort.** Options to A/B:
- Pin the effort per run, chosen at task start.
- Pin it per phase, with long dwell.
- Keep adaptive, but charge each switch its re-prefill cost.

Any change to limiter constants is a new `state_schema` under the existing policy-versioning rules ([effort_limiter.rs](native/nexus-broker/src/engine/effort_limiter.rs)).

**2c. Prefix-stability invariant test.** Each request's serialised input must extend the previous one byte for byte, except at declared compaction, memory-fold or effort-change points.

**2d. Telemetry.** A per-request `cacheBreak` cause (`reasoning-drop`, `effort-switch`, `compaction`, `unknown`) in the analytics export.

**2e. `prompt_cache_key`: not now.** Stable requests already hit 58 of 58. Add it only if hit rates fall after 2a and 2b.

### Phase 3 — Measurement only (decides M4.8)

- **3a. Dependency fetch.** Fetch the same `Cargo.lock` in the VM through the current egress path, cold and warm, against the host. Record proxy connection counts, bytes, per-request latency and sparse-index request count. Establish whether `CARGO_HOME` persists across runs and projects.
- **3b. Compute.** Run the same `cargo build` / `cargo test` in the VM at 4 vCPU / 2 GB and 8 vCPU / 4 GB, and on the host. Watch memory pressure.
- **3c. Transport.** Break down connect, TLS and first-byte time per request (`connection: close` at [transport.rs:530](native/nexus-model/src/transport.rs:530)).
- **3d. Controller.** Time grant sealing, issuance, policy evaluation and persistence per step (81 s unexplained).
- **3e. Export.** Lift the 50-command cap ([telemetry.rs:685](native/nexus-broker/src/telemetry.rs:685)), add DSH-compatible decode tok/s, and split tool time into foreground and background.

### Files and components

| Area | Files |
|---|---|
| Composition and re-check derivation | `native/nexus-broker/src/compose.rs` |
| Check assessment, hazards, guards, reasoning replay | `native/nexus-broker/src/inspect.rs` (≈:1795–1960, :3136–3158, :3900–3990, :5100–5215) |
| Identity, run decision, messages | `native/nexus-broker/src/completion.rs`, `native/nexus-broker/src/claims.rs` |
| Final-boundary engine nudges | `native/nexus-broker/src/engine/muse_v0.rs` (and the adaptive engine's equivalent) |
| Effort policy | `native/nexus-broker/src/engine/effort_limiter.rs`, `muse_v1_adaptive.rs` |
| Kernel verdict (only if 1b is placed there instead) | `native/nexus-tools/src/process.rs` |
| Telemetry | `native/nexus-broker/src/telemetry.rs` |
| Replay fixtures and tests | `native/nexus-broker/tests/fixtures/recorded_checks.json`, `compose.rs` tests, `tests/code_a56.rs` |
| UI wording for new classes (`filter-status`, `recheck-inconclusive`, `unverified`) | `apps/nexus-desktop/src/lib/progress.ts`, `lib/outcome.ts` |
| Unchanged by design | `apps/nexus-desktop/src-tauri/src/sync/host.rs` (writeback policy), sandbox, egress, permissions |

### A/B experiments

| Experiment | Arms | Runs | Primary metric | Guardrail metrics |
|---|---|---|---|---|
| E1 Verification replay (offline) | before / after Phase 1 | deterministic | Open items on `run_faf5`: 5 → 0 false | Full masked-failure corpus unchanged; no non-zero exit becomes a pass |
| E2 Reasoning replay | window / append-only / none | ≥ 3 each on the scheduler task + ≥ 1 other task family (a web app, a refactor) | Cache hit, uncached tokens | Independent acceptance pass rate, request count, fix-loop count |
| E3 Effort | adaptive / pinned-high / pinned-medium (with the best E2 arm) | ≥ 3 each | Wall time, uncached tokens | Same as E2 |
| E4 Fetch / compute / transport (Phase 3) | current vs variants | ≥ 3 timings each | Seconds per operation | Egress policy denials unchanged |

Run every live arm with the same model and route, a fresh project, the same permission mode, and the same independent acceptance suite applied to the output.

---

## 10. Regression and security validation

- **Masked failures.** The existing `compose` tests (the three shapes, newline lists, substitution, `find -exec`, `set -e` lists, 15 unanalysable shapes) pass unchanged. New adversarial tests:
  - `cargo test 2>&1 | grep FAILED` with failing tests and a matching grep → **fail**.
  - Failing tests and no match → **filter-status hazard, never a pass**; its re-check is `cargo test 2>&1`.
  - `check | grep -q ok || true` and `check 2>&1 | tail -5; echo` → still **unattested**.
  - `check | tee log | grep x` → `tee` is never stripped.
  - Exit 141 behaviour unchanged.
  - A filter-status hazard whose plain re-check *fails* → a recorded failure under the check's own identity.
- **Satisfiability invariant.** Every hazard in the corpus is resolved by a simulated pass of its stated re-check.
- **Loop bound.** No re-check instruction is repeated more than twice after identical results.
- **Writeback.** The `sync/host.rs` qualification tests are unchanged. A genuinely unattested or failed run is still never applied, under any policy.
- **Suites.** On the Fedora builder via `systemd-run --user` with `NEXUS_REQUIRE_SANDBOX=1`: nexus-tools, hostexec_m8, kernel + daemon, broker lib, code_a56, a53/a55/prodgate, plus the Mac `src-tauri` suite and vitest.
- **Catalog and baselines.** Any tool-description or effort-policy change gets a versioned profile and a new provider baseline, as the A5.x/M8.x practice requires.
- **Security.** No change to sandbox confinement, egress allowlisting, approval flow or credential handling. Phase 3's fetch work is measurement only; any later fix must keep the egress policy.

---

## 11. Expected measurable outcomes

| Outcome | Baseline (this run) | Target after M4.7 |
|---|---|---|
| False failed checks on replay of `run_faf5` | 3 failed + 2 unattested, all spurious | 0; outcome `verified-passed` (or at most one documented extra re-check) |
| Re-check instructions the controller would refuse | 2 of 2 hazards | 0 (invariant test) |
| Post-report requests in such runs | 20 | ≤ 5 |
| Cache hit (same route) | 76.9% | ≥ 95% (98.6% is the trace's ceiling) |
| Uncached input per long run | 1.61 M | ≤ 0.3 M |
| Wall time | 29m45s | −2 to −3 min from Phases 1–2 alone. **The 2× gap will not close without Phase 3 follow-ups:** dependency fetch alone is about 4.7 min |
| Benchmark comparability | 4 of 9 headline metrics not comparable | Export carries DSH-compatible decode tok/s, foreground/background tool time, cache-break causes |

---

## 12. Success criteria (M4.7 is done when)

1. Phase 0's baseline replay reproduces today's outcome, and the post-Phase-1 replay yields no spurious open items on `run_faf5…`.
2. Every existing masked-failure test passes unmodified, plus the new adversarial tests in §10.
3. The satisfiability invariant and the loop bound hold over the whole recorded corpus.
4. The prefix-stability invariant test passes for the chosen reasoning policy and effort rule.
5. E2/E3: the chosen arm reaches ≥ 95% cache hit across ≥ 3 runs, with no drop in the independent acceptance pass rate and no more than +10% requests. If `none` loses quality, `append-only` must meet the cache target instead.
6. All suites in §10 are green on Fedora with the sandbox required, and on the Mac.
7. Phase 3 produces a measured breakdown for fetch, compute, transport and controller time, with a costed M4.8 proposal.

---

## 13. Risks and trade-offs

- **The filter list is too broad.** `npm test | grep -q passing`, where the runner always exits 0, would lose its grep assertion on re-check. Mitigation: stripping affects only *re-establishment* and the ambiguity class, never turns a non-zero exit into a pass, and a runner that always exits 0 is outside the controller's guarantees today.
- **No reasoning replay may hurt quality.** There was an earlier incident on this route ("CCv2 RC1", cited in `inspect.rs`). DSH's projector notes that no-replay continuation was proven live on this route, but that is DSH's evidence, not Native's. Hence `append-only` as a fallback, and the A/B gate.
- **Effort pinning trades cost against quality.** Pinned-high costs more reasoning per request; pinned-medium may need more fix loops. The A/B decides.
- **Two verification systems.** Patching the legacy gate widens its divergence from the Verification Engine ledger. The ledger already has the better model (Inconclusive, freshness), but cannot be authoritative in direct workspaces, where freshness is always indeterminate. A later milestone should make it authoritative once end-of-run content attestation can settle freshness there. Phase 1 should reuse its vocabulary (`inconclusive`/`unverified`) so the migration stays cheap.
- **Benchmark overfitting.** Every proposed change is task-independent: any `check | filter`, any long run with reasoning, any effort switching. None is specific to Rust or schedulers.
- **One run is weak evidence for timings.** Native's own runs vary from 18 to 30 minutes. Timing claims must come from repeated runs (E2–E4). Token and cache findings are deterministic properties of the code and do not need repetition to be believed.

---

## Appendix A — Root causes established vs suspected

**Established by evidence (code and trace agree):**
- **R1.** The derived re-check keeps a trailing `grep`, which under pipefail exits 1 on a clean build (compose.rs derivation; process.rs pipefail; receipts 111, 114–116).
- **R2.** A non-zero exit from a filter is attributed to the check, with no ambiguity class (inspect.rs:5196–5203).
- **R3.** Hazard guidance does not match hazard satisfaction (`satisfies` member-exact; call 96).
- **R4.** The final-boundary nudge budget went to the false failure; calls 27 and 44 were never named to the model (muse_v0.rs:275–299).
- **R5.** The 12-item reasoning replay window rewrites the middle of the prompt (inspect.rs:3136–3158): 78.8% of uncached input, 54 of 55 misses predicted.
- **R6.** Effort switches re-key the provider cache: 18.3% of uncached input, 11 of 11 misses.
- **R7.** Throughput and tool-time figures use different definitions in DSH and Native (dsh-session-stats; DSH background jobs).

**Suspected, needs measurement:**
- **S1.** Why `cargo fetch` took 283 s in the VM: proxy, TLS, DNS, sparse-index request pattern, or no persistent cache.
- **S2.** How much 4 vCPU / 2 GB slows builds and tests compared with the host.
- **S3.** Per-request TLS setup from `connection: close`.
- **S4.** The composition of the 81 s of controller time.
- **S5.** Whether replayed reasoning content is used at all on this pooled route (if not, `none` is free).
- **S6.** Whether adaptive effort improves task outcomes enough to justify its cache cost.

## Appendix B — Reproducing the evidence pull

With Nexus.app closed, spawn `<Nexus.app>/Contents/MacOS/nexus-vm attach --state-dir "~/Library/Application Support/ai.arthurlabs.nexus.desktop/engine"`, read the guest `hello` line, and wait for `runtime_state.phase == "ready"`. Then send read-only `call` lines:
- `intent_status {runId}`
- `run_analytics_export {runId, hostPlatform, appVersion}`
- `intent_activity {runId, offset, limit ≤ 200}`
- `thread_get {threadId}`
- `conversation_read {taskInstanceId: <conversationId>, beforeSeq, limit}`

Optionally send `sync` `export-plan` / `export-read` for the working copy. Never send `export-ack`. The bridge serves one host at a time; a second client displaces the app's connection.
