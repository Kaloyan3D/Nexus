# EM-04C1 — Implementation report

**Status:** worktree `~/Projects/Nexus-muse-production-prep`, branch
`feature/native-muse-production-prep`, created at exactly `49026e8e0fd7564a6bbffe8d016fcfebd1965afe`.
**Uncommitted**, for architectural review. No push, merge or deploy; no paid inference; no live
provider; no other worktree modified (a throwaway detached worktree of the baseline in the session
scratchpad was used for comparisons and removed).

Companions: `EM-04C1-ARCHITECTURE.md`, `EM-04C1-IPC-SECURITY-MATRIX.md`,
`EM-04C2-ACTIVATION-HANDOFF.md`.

## 1. Scope delivered

| Phase | Delivered | Not done (by design) |
|---|---|---|
| 1 Persistent worker | per-run supervised Node worker, versioned bounded IPC, restart/timeout/cancel/backpressure, parity on both transports | no shared/background daemon; one-shot bridge kept as reference |
| 2 Registry-sealed budget | `requestBudgetBytes` on the Registry mode → binding → sealed target → task binding → broker; tighten-only broker value; continuation identity | no shipped mode declares one; `muse-v0` untouched |
| 3 Catalog integrity | frozen digests per profile, single selector, run-start guard, digest on the run record, wire-level tests | production `muse-v1` row deferred to C2 |
| 4 Anti-thrash review | 10 executable findings; bounded policy proposed | Governor unmodified |
| 5 Testing/perf | below | no paid inference |

Explicit exclusions respected: no `muse-v1` activation, no adaptive effort, no flags, no
model/provider/route changes, no EMv1/EMv3/CCv2 change, no Governor rewrite, no Kernel/permission
change, no commit.

## 2. Focused diff

`git diff --stat` (tracked): 22 files, +1,271 / −36; plus 6 new files.

| Area | Files | Notes |
|---|---|---|
| Worker | new `engine/worker_bridge.rs` (supervisor, ~740 lines incl. the test evaluator), `engine/muse_bridge_worker.cjs` (~200), `engine/worker_tests.rs` | `governor_bridge.rs`: one visibility change (`berr`) |
| Registry JS | `config/registry/{schemas,resolver,native-issuer}.cjs` (+27 lines) | additive; new `tests/RegistryRequestBudget.Tests.cjs` |
| Contracts | `nexus-contracts/src/{target,lib,task_binding}.rs` | `request_budget_bytes: Option<u64>` (skipped when `None`), bounds, 3 tests |
| Model | `nexus-model/src/{repo_tools,target}.rs` | frozen digests, `verify_catalog`, 3 tests |
| Broker | `attempt_target.rs` (sealed budget, identity), `inspect.rs` (worker lease, budget, catalog), `server.rs`/`store.rs` (catalog digest on the run record), `engine/mod.rs` (`tool_catalog_profile`) | `engine/muse_v0.rs`, Kernel, daemon, `config/Muse-Reasoning*.cjs`: untouched |
| Tests | engine test modules now take the evaluator from `worker_bridge::test_evaluator`; `catalog_tests.rs`, `anti_thrash_review.rs`; 9 E2E in `code_a56.rs`; an inert body-dump harness | `broker_a53.rs`/`inspect_a55.rs`: one struct field each |

## 3. Test results

All offline; `NEXUS_REQUIRE_SANDBOX=1` for the battery.

| Gate | Result |
|---|---|
| `cargo fmt --all` / `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| Full battery `cargo test --workspace --no-fail-fast` | **1,110 passed, 0 failed, 54 ignored** (EM-04B baseline reported 1,053 / 0 / 53: +57 tests, +1 ignored benchmark) |
| `code_a56` | 124 passed, 5 ignored (9 new EM-04C1 tests) |
| Engine suites on the **one-shot** transport (`NEXUS_TEST_BRIDGE=oneshot`) | 107 passed, 2 ignored (all EM-04A/04B Governor/Signals differential and adversarial suites, unchanged) |
| Engine suites on the **worker** (default) | same suites inside the battery: pass |
| Original Muse CommonJS suites | Governor 52/52, Runtime 30/30, Ordering 28/28; Activity 33/33 and Signals 34/34 on a `git archive` copy with the installed app deps and preset files linked (as in EM-04A §1) |
| Registry / Native JS suites (33 at baseline + the new one), pwsh on `PATH` | **all exit 0 on baseline and on this tree**; new `RegistryRequestBudget` 6/6 |
| EM-02 authorization, EM-03 recovery matrix, EM-03 record fixtures, historical Engine state compatibility | inside the battery: pass (records reopen byte for byte; binding identity of budget-less modes is unchanged) |
| Desktop Tauri (`CARGO_INCREMENTAL=0`) | 27 passed, 2 ignored (= EM-04B) |
| Release/production gate (separate crate, `--release`, **no** `test-engines`) | `muse-v0` selectable; `muse-v1`, `muse-v1-shadow`, `muse-v1-signals`, `effort-test-v0` → `engine-unavailable`; the published EM-03 fixture key is **refused** (`key_admissible = false`) |
| A614 (59 requests, `muse-v0`, no budget) | max **449,944 B** (< 450,000; unchanged); bodies identical to baseline |
| A614, signals catalog (55 reads) under a Registry-sealed 400,000 B | max **380,514 B**, completes, pairs intact, task message kept |
| A614, signals catalog, EM-04B guard (broker 449,999) | pass (428,722 B, as recorded in EM-04B) |

Notable new tests: worker (24): parity corpus vs one-shot, statelessness, run isolation, empty
environment and flat memory, kill between/mid-request, crash retried once, crash loop stops,
hang/timeout, cancellation, shutdown/drop, bounded input and waiters, 12+12 hostile response/raw
frame shapes, duplicate/stale/foreign responses, partial/truncated/oversized frames, wrong digests,
EOF. Engine: signal acceptance and Governor evaluation with the worker dying once (same state as a
healthy worker, applied once) and dying always (unrecorded, never applied later). E2E: SIGKILL
storm during a real run (run unaffected, one record per decision, worker gone afterwards), one
process per run.

## 4. Baseline vs changed build

| Comparison | Method | Result |
|---|---|---|
| Request-body compatibility | same inert dump harness patched into `code_a56.rs` of both builds; 105 tests, **944 request bodies** compared | `model`, `tools`, `reasoning` identical in **944/944**; whole body identical modulo tool-output text in 940/944. The 4 remaining are one test whose own conversation history contains a timing-dependent number of rejected runs (it varies 8/12/14 across runs of the *same* tree) and one test whose two concurrent runs arrive in another order (same multiset). Raw-body differences elsewhere are tool outputs (cargo timings, test ordering, `wallMs`). Max body 449,944 B. |
| Catalog identity | frozen digests computed on the baseline | `RepoInspectV1` `b06d9c9f…2ff6` and `RepoCodeV1` `58f513de…d90b` equal at baseline and now; signals `5f7d19e2…4510` distinct |
| Budget-less targets | contract + Registry tests | key absent; same digests; same issuance |
| Baseline note | superseded by §8.3: the two `a56_crash_*` failures were an artifact of how I built the baseline daemon, not a baseline defect and not a flake |

## 5. Performance (release, offline, this machine)

| Measurement | One-shot bridge | Persistent worker |
|---|---|---|
| Governor evaluation, median (n = 60 / 300) | 79.8 ms (p95 93.3) | **1.35 ms** (p95 2.60) — ×59 |
| Signal evaluation, median | 82.1 ms (p95 112.0) | **1.45 ms** (p95 2.31) — ×57 |
| Cold start (spawn + handshake + first request), once per run | n/a | 65 ms |
| Worker RSS | per call, transient | 49 MiB after the first request, 119 MiB after 600 requests, plateau ≈ 132 MiB (heap capped at 96 MiB; RSS = cap + ≈ 35 MiB; see §8.1) |
| Processes | one per evaluation | one per run, none after it |

(EM-04B's 174/81 ms were measured on another day; the one-shot numbers above are this session's.)
A614 (59 requests, shadow evaluating at each) therefore spends ≈ 0.08 s instead of ≈ 4.7 s in the
bridge.

## 6. Risks and limitations

1. **Worker memory** plateaus at ≈ 132 MiB RSS (§8.1), per Governor-capable run, 16 workers max; none
   for `muse-v0`. Size it for C2.
2. **The retry is a design choice**: one transparent retry on crash/protocol failure. It is safe
   because the worker is a pure function, but it hides a single crash from the engine (it is
   counted in `stats()`, not surfaced in the run). EM-04C2 may want the counters in the run record.
3. **Restart-rate limit** (6/60 s) turns a worker that dies on every request into
   `bridge-restart-limit` for the rest of the window; the shadow records it, a signal reports
   "not recorded".
4. **The budget is Registry policy but only as strong as mode-file custody**; mode files live in
   the install root like every other Registry definition.
5. **`BrokerConfig.request_budget_bytes`** remains as a tighten-only test seam (`None` in `main.rs`).
6. **Anti-thrash (Phase 4)**: the policy does not stop model-signal-driven effort flapping. This is
   benign while adaptive effort is off and must be resolved in C2 (handoff §3).
7. The `Provider` body-dump harness in `code_a56.rs` is inert unless `NEXUS_BODY_DUMP_DIR` is set.
8. Not exercised: live providers, paid inference, a real TLS/OpenCode run (out of scope).

## 7. Recommendation

**APPROVE** (for architectural review; uncommitted).

Evidence: production `muse-v0` requests are unchanged (944/944 model/tools/reasoning; A614 449,944 B
identical); no flag or engine became selectable (release gate, `engine-unavailable`, fixture key
refused); the bridge is ≈ 57–59× faster, supervised, bounded and stateless, with every IPC attack in
the matrix refused and crashes proven neither to lose nor duplicate a signal; the budget is sealed
by the Registry and cannot be loosened by the broker, a continuation, a model or a tool; catalogs
have frozen, distinct identities and a single selector; all historical suites (5 Muse JS, EM-01..04B
Rust, Registry JS, Tauri) are green; fmt and strict clippy are clean.

Conditions for the reviewer: decide the anti-thrash limiter (handoff §3) before C2. The final review
(§8) closed the three open points; see there for the corrected statements.

## 8. Final review before local commit

Source changes since the preliminary validation: **tests only** (2 E2E tests in `code_a56.rs`, 1
ignored measurement in `worker_tests.rs`). No production source file changed. Gates re-run after
the edits are in §8.4.

### 8.1 Worker lifecycle and resource overhead

**Is the worker started for every run?** No, and it never was. `inspect.rs` creates a
`WorkerGovernorBridge` only when the sealed engine is `muse-v1-shadow` or `muse-v1-signals`
(`test-engines` builds); the process itself is spawned **lazily at the first `call`** (first
`BeforeRequest` evaluation or first accepted signal), not when the bridge object is created.

Proof (`code_a56`):
* `em04c1_production_muse_v0_runs_never_start_a_governor_worker`: a complete `muse-v0` run,
  sampled every 3 ms for the run's task generation: **0 worker processes at any time.**
* `em04c1_the_worker_is_lazy_and_inherits_neither_environment_nor_descriptors`: the shadow run's
  worker first appears ≈ 1.0 s after submit, i.e. after workspace/Registry/Kernel setup, at the
  first evaluation; exactly one process serves the run.

Therefore legacy production runs pay **no** Node start-up and **no** worker memory. No source
change was required. (The same holds for the Rust cost of the unused code: nothing is allocated.)

**Start-up and memory** (release, `the_worker_memory_plateaus`, `the_persistent_worker_is_faster…`):

| Point | Value |
|---|---|
| spawn + handshake + first request | 64–65 ms (once per run, only for Governor-capable engines) |
| RSS / VmHWM after the first request | 49.3 MiB (50,456 KiB) |
| after 501 requests | 120.7 MiB (123,576 KiB) |
| after 1,001 / 2,001 / 4,001 requests | 128.3 / 130.4 / 131.9 MiB |

Samples every 500 requests from 1,001 to 4,001 (KiB): 131,372 → 132,848 → 133,544 → 134,096 →
134,484 → 134,964 → 135,112 (VmHWM equals RSS at every sample). Growth after the first 500 requests
is ≈ 11 MiB over the next 3,500, so RSS **plateaus near 132 MiB**. This corrects the preliminary
statement: the 96 MiB V8 old-space cap bounds the JavaScript heap, **not** RSS; RSS ≈ heap cap +
≈ 35 MiB for the Node runtime, code and external buffers. Budget **≈ 135 MiB peak per worker**.

**Concurrent runs.** One worker per Governor-capable run, at most `MAX_LIVE_WORKERS = 16` per
broker (`bridge-busy` beyond). Worst case ≈ 16 × 135 MiB ≈ 2.1 GiB; two or three concurrent adaptive
runs ≈ 0.27–0.4 GiB; zero for `muse-v0`. In the EM-04C2 activation this number is the real cost of
adaptive effort per concurrent task and should be sized (or the cap lowered) in the Registry/ops
configuration. A recycle-after-N-requests would only trim the plateau by a few MiB and is not
needed.

**Isolation: what is and is not claimed.**
* *IPC-level isolation* (enforced and tested): the worker's only input is frames from the broker; it
  receives Muse state, never credentials, grants, Kernel/Registry handles or paths; every answer is
  validated in Rust.
* *Not OS-level isolation*: the worker runs as the broker's user, in the same PID/mount/network
  namespaces, with no seccomp/landlock/cgroup. A compromised Node binary could act as the broker's
  user. `trust::resolve_node` pins the binary (same trust as the Registry bridge and the one-shot
  bridge, which had identical exposure). OS confinement is future work, not part of C1's claims.
* *What the child inherits* (measured on a live worker, 1.0 s into a real run): environment **0
  bytes** (`env_clear`; `/proc/<pid>/environ` empty); command line = `node --max-old-space-size=96
  -e <script> -- <task-generation id>` (no credential material; the id is an opaque identifier);
  descriptors = stdin/stdout pipes, `/dev/null`, and Node's own pipes/anonymous inodes (event loop,
  thread pool; plus a transient `/proc/<pid>/maps` read by V8) — **no regular file, directory or
  socket**, and **none of the worker's descriptors points at an object the broker holds** (lock
  files, Kernel socket, credential file, transcripts): the test intersects the worker's descriptor
  targets with the broker's `/proc/self/fd`, excluding only stdin/stdout/stderr. Rust opens its own
  descriptors close-on-exec, which is why nothing leaks despite the broker's `flock`ed state files.

### 8.2 The four request discrepancies

The earlier comparison (944 bodies, 105 tests) left four bodies "not identical modulo tool output":
two in `a56_two_concurrent_runs_get_separate_working_copies_and_independent_diffs` and two in
`rn2_a_conversation_whose_target_is_no_longer_issued_is_refused_before_any_run_and_never_falls_back`.
(The first comparison's dump directory was inside a scratch worktree that I then removed, so I
re-ran both tests three times on each build, 12 fresh dumps, to inspect the fields.)

| Test | Result of 3 baseline + 3 new runs | Differing field |
|---|---|---|
| `a56_two_concurrent_…` | all 6 runs have identical bodies, identical order and identical skeletons; the one earlier mismatch was the **arrival order** of the two concurrent runs' requests (the multiset was equal) | none in these runs; in the earlier one: only which run's request reached the provider first |
| `rn2_a_conversation_whose_target_…` | 7 bodies each; base: 10, 12, 12 `### Run` entries; new: 12, 12, 12 | only the **conversation working-memory text** (`### Run N …` history lines that `threads.rs` renders into the user message): the number of rejected follow-up runs the test itself had created by the time of the request varies **within the baseline** (10 vs 12) |

For all 12 dumps and every body: the non-`input` fields (`model`, `tools`, `tool_choice`,
`parallel_tool_calls`, `stream`, `max_output_tokens`, `reasoning`) form exactly **two** distinct sets,
identical in baseline and changed builds — `e2e-mock-model-2` / 512 tokens and `e2e-mock-model` /
1024 tokens, both `reasoning.effort = low`, both with the same 6-tool `RepoCodeV1` catalog — the two
models the test deliberately uses. Input items are identical in type, role and order, with
`function_call_output` text excluded (cargo timings, test ordering, `wallMs`). `threads.rs`,
`context.rs`, `request_budget.rs` (the context-budget code) and `muse_v0.rs` are **not modified**
(`git diff --stat`), and no budget is configured in these runs. Authorization (grants, approvals,
issuance) is not carried in request bodies; it is covered by the EM-02/EM-03 suites in the battery.
Conclusion: no protocol, authorization, context-budget or reasoning semantics changed; the original
`muse-v0` request contract and tool catalog (digest `58f513de…d90b`) are unchanged.

### 8.3 The two `a56_crash_*` failures: cause found

They were **not** a baseline flake and **not** an unexplained discrepancy: they are an artifact of
how I built the baseline daemon.

* `a56_crash_*` kill the real `nexusd` at a fault point compiled in only with the `nexus-tools`
  feature `crash-injection`, which Cargo enables for a **test-profile** workspace build
  (`cargo test --workspace`, as in the battery) but not for a plain `cargo build`.
* My isolated baseline target directory held a `nexusd` from `cargo build --workspace`. With it the
  tests fail deterministically with "the crash point … never fired (is nexusd built with
  crash-injection?)":
  * baseline + `cargo build` daemon: **3 / 3 runs fail** (both tests);
  * **this tree + `cargo build` daemon** (`NEXUSD_BIN`, separate target dir): **fails identically**;
  * baseline + test-profile daemon (`cargo test --workspace --no-run`): **3 / 3 pass**;
  * this tree + test-profile daemon: 3 / 3 pass (and in the full battery).
* So the behaviour is a function of the daemon build flavor, identical on both trees; the test even
  states the requirement in its failure message. The statement in the preliminary report that these
  were "baseline failures I did not root-cause" is withdrawn; there is no baseline defect here.
  (The `a56` suite is documented as needing the test-profile daemon; running it standalone after a
  plain `cargo build` is the pitfall.)

### 8.4 Gates after the final edits

Production source unchanged since the 1,110 / 0 / 54 battery; only test code was added. Re-run:
`cargo fmt --check`, strict clippy (`--workspace --all-targets -D warnings`): clean; engine suites
107 passed / 0 failed / 3 ignored; both new E2E tests pass; full `cargo test --workspace
--no-fail-fast` result: see §8.5.

### 8.5 Full battery after the final edits

`NEXUS_REQUIRE_SANDBOX=1 cargo test --workspace --no-fail-fast`: **1,111 passed, 1 failed, 55 ignored**
(1,110 / 0 / 54 before; +2 E2E tests, +1 ignored measurement). The one failure was
`rn2_a_coding_run_on_the_second_model_is_bound_to_it_and_its_connection_on_every_provider_call`,
which stopped at its sandbox precondition, not at an assertion about behavior:

> NEXUS_REQUIRE_SANDBOX is set but the sandbox or toolchain is unavailable: functional probe failed:
> sandbox-unavailable: systemd scope was not created; kernel-enforced limits unavailable

That is a transient host condition (the systemd user scope could not be created at that moment,
while other runs were active). The same test passed **3 / 3** when re-run alone immediately
afterwards, and passed in the earlier full battery of the same code. I count it as an environment
flake with the evidence above, not as a pass: the full battery has not been observed to be 1,112 / 0
in a single run. No production source differs between the two batteries.

### 8.6 Conclusion of the final review

All three points are closed with evidence, and no production source change was needed. Corrections to
the preliminary report: RSS plateaus at ≈ 132 MiB (not bounded by the heap cap), and the two
`a56_crash_*` failures were a daemon build-flavor artifact of my comparison, not a baseline defect.
