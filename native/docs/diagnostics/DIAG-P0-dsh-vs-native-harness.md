# P0 — DSH vs Native harness: why the same OpenCode Go model coded worse under Native

Branch `investigate/dsh-vs-native-p0` (worktree `~/Projects/Nexus-p0-dsh-native`, base `c4de337`). Committed locally as five code commits plus this document (§6); nothing is pushed.

**Outcome.** Two harness defects explain the regression; both are confirmed and fixed:
1. Native dropped the provider's `phase` label on the model's own narration.
2. Native's request upload gave up after 100 ms of provider backpressure.

Reasoning replay (DSH Legacy behaviour) was ported after the forward A/B supported it. Two smaller robustness defects found during the benchmark are also fixed.

**Forward A/B on real coding tasks.** Shipped `c4de337` vs fixed vs fixed + reasoning replay; isolated runtimes; same model, route and effort.
* Long tasks: the shipped build stalled mid-task 8 times and lost 12 answers in 2 runs; both fixed builds had **0 stalls and 0 lost answers**.
* Short and medium tasks: all 30 runs passed independent acceptance on every arm (no regressions).

## Summary of findings
| # | Finding | Rank | State |
|---|---|---|---|
| 1 | Provider `phase: "commentary"` dropped from replayed narration; the model treats its own preambles as final answers | **Confirmed defect, primary behavioural cause** | Fixed (`InputItem::AssistantPhase`, `push_model_text`) |
| 2 | 100 ms socket write timeout turned upload backpressure into `send-uncertain` (all 77 Run 14 lost answers) | **Confirmed defect** | Fixed (`write_all_bounded`/`flush_bounded`) |
| 3 | No reasoning replay (DSH Legacy replays encrypted reasoning items) | **Supported by the A/B**: 3.2× fewer reasoning tokens and 16% fewer responses on long tasks, no regressions | Ported (`InputItem::Reasoning`, latest 12 items) |
| 4 | Transport detail replaced by a fixed sentence on `Uncertain`/`TimedOut` | Confirmed observability defect | Fixed |
| 5 | `announcement()` split sentences at every `.`; "Now the final item 10, version 0.5.0." ended on "0" and was accepted as the final answer | Confirmed detection defect (found in the A/B) | Fixed (no split between digits) |
| 6 | An empty `arguments` in `output_item.done` after complete `arguments.done` was a fatal "conflict"; DSH falls back to the streamed arguments | Confirmed parsing difference (found in the A/B, 2 re-asks) | Fixed (empty neither conflicts nor wins; non-empty conflicts still fail closed) |
| 7 | Effort: Native's mode slot is `low`; DSH ran `medium`/`high` | Configuration difference | **Unchanged: operator decision** (benchmark kept `low` on all arms) |
| 8 | `parallel_tool_calls: false` injects the "one tool call per message" text | **Ruled out**: injected for `false`, omitted and `true` | — |
| 9 | Lost-answer re-asks cause stalls | **Ruled out**: identical request; size-stratified rates equal | — |
| 10 | Native drops or mis-assembles tool calls (Run 14) | Ruled out: no call-shaped text in any text-only turn | — |

## 1. Architectures (source-grounded)
DSH = installed `@deepseek-ai/dsh-llm-pi-ai` → `@earendil-works/pi-ai` 0.82.1 (`api/openai-responses*.js`). Native = `nexus-model/src/{prepare,sse,transport,egress}.rs`, `nexus-client/src/inspect_run.rs`, `nexus-broker/src/{inspect,context,completion}.rs`.

| Aspect | DSH (pi-ai) | Native `c4de337` | Native after this work |
|---|---|---|---|
| Endpoint | `opencode.ai/zen/go/v1/responses` | `opencode.ai/inference/go/openai/v1/responses` | unchanged |
| Upload | Node fetch, async writes, keep-alive, SDK + DSH retry | fresh TLS connection, 100 ms socket slices; `write_all` aborts on the first slow slice | waits out backpressure (exchange deadline, `read_timeout_ms` stall bound, cancellation) |
| Instructions | 27.8 KB system prompt as `developer` | preamble + thread context in the first **user** message | unchanged |
| Tools | one `run_code` (TypeScript, `Promise.all`, curated output) | six functions, results ≤ 24 KB | unchanged |
| Assistant text replay | each `message` item verbatim with `id` and **`phase`** | concatenated, ≤ 8 KB, plain `{"role":"assistant"}` | phase-labelled items kept (`type: message`, `phase`, `output_text`), same 8 KB total |
| Reasoning | `include` encrypted content, items replayed | not parsed, not replayed | `reasoning` items replayed verbatim (canonical, validated, latest 12) |
| Tool-call assembly | empty final `arguments` → falls back to streamed | empty final `arguments` = fatal conflict | empty ignored; non-empty conflicts still fatal |
| Effort | governor: medium / high | `low` (mode slot) | unchanged (operator) |

## 2. Run 14 forensics (unchanged conclusions)
* The 279 attempts were 202 answered turns plus 77 `send-uncertain` failures. Every failure hit 0.80–1.12 s after the request started, before any byte arrived, and no two failures were consecutive.
* A re-ask resends identical `items`; the aborted upload never reached the model.
* Failures scale with request size (0 below ~50 KB) and stop after the working-memory fold.
* **Text-only turns vs re-asks:** 10/77 vs 8/125 overall, but equal within size bands. The correlation is confounded by size. This corrects `DIAG-r-native-3-run14.md`.
* The longest monologues (A106, A137, A279) are visible reasoning about the tool format ("each assistant message = 1 tool call … GO.").
* No text-only turn contains tool-call syntax.

## 3. Baselines from history (same model and provider)
| | Native, 63 runs, 2,761 responses (Oct 18–19) | DSH, 17 sessions, 4,628 responses (Oct 10–14) |
|---|---|---|
| text-only responses | 4.4% (2.6% mid-task) | 0.97% (≈ genuine final answers only) |
| lost / retried requests | 8.0% (time-of-day dependent) | 0.45% |
| visible narration per response | median 73 chars | median 0 |

The provider has emitted `phase: "commentary"` since about 2026-10-10. DSH logs carry it on nearly every text block, and DSH replays it.

## 4. Causal evidence
1. **Decision-point replay.** The real Run 14 history was rebuilt before 4 stalled turns (Native's own `guidance` + `threads::build_context`), 5 samples each, interleaved; only the narration serialization differs.

   | | text-only stalls |
   |---|---|
   | phase dropped (shipped) | **14/20** |
   | phase kept | **0/20** |

   One-sided Fisher p = 1.7×10⁻⁶. Vendor guidance agrees: dropping `phase` causes "early stopping on longer-running tasks" ([OpenRouter](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/gpt-5-4.md)).
2. **Upload backpressure.**
   * Offline: `nexus-model/tests/p0_transport_upload.rs`. Before the fix a healthy slow peer gave `SendUncertain "body send outcome unknown: Resource temporarily unavailable (os error 11)"`; after the fix it passes.
   * Live probes: about 17% of 130–350 KB requests stall ~0.6 s on **both** endpoint paths. The old client fails at 914/922 ms, Run 14's signature.
3. **Injection probe**: the one-tool-call instruction is present for every `parallel_tool_calls` value.
4. **Replay probe**: the provider accepts replayed encrypted reasoning.

## 5. Forward A/B (isolated runtimes)
**Setup.** Three isolated `NEXUS_HOME`s with copies of the dev Registry (route `opencode-go-native/muse`, effort **low**), the credential (0600) and the user's provider consent. Each arm ran its frozen binaries through the real supervisor → `nexusd` + `nexus-broker` → Kernel → sandbox → OpenCode Go, driven by `nexus-runtime/examples/p0_bench.rs` exactly as the Desktop does.

**Arms:**
* **base** = `c4de337`
* **fix** = phase + upload + detail + trace
* **replay** = fix + reasoning replay

**Project:** `ledgerlite` (stdlib Python, 17 tests) and a seeded-bug copy.

**Scenarios:**
* A — `--version`
* B — tags across parser/model/report/CLI/docs
* E — follow-up in B's conversation: CSV export
* D — seeded bugs, with the task naming non-existent files (deliberate tool failures)
* C — budgets: 7 parts
* L — a 10-item release, verbose suite after every item

Trials: A–E ×2 per arm, L ×2 per arm, run concurrently across arms in the same order. Acceptance is independent of the model's claims (`accept.py`: copies the final working copy, runs the suite and hidden spec checks, and checks tests are unchanged in D). F (provider errors) is covered by the deterministic fixtures (`a614_*` interruption tests, `p0_transport_upload.rs`).

**Long task L (2 runs per arm):**

| | base | fix | replay |
|---|---|---|---|
| independent acceptance | **1/2** (run 1 skipped item 10 yet reported `fulfilled`) | 2/2 | 2/2 |
| mid-task text-only stalls | **8** in 217 responses | **0** / 228 | **0** / 191 |
| lost answers | **12** | 0 (8 provider upload stalls absorbed) | 0 (11 absorbed) |
| longest narration | 11,177 chars | 3,123 | 2,849 |
| narrated responses | 75 | 60 | 29 |
| reasoning tokens | n/a | 43,623 | **13,502** |
| input tokens | 8.19M | 9.10M (98% cached) | **7.03M** (88% cached) |
| wall time | 835 s | 945 s | **646 s** |

Stalls 8/217 vs 0/419: one-sided Fisher p = 1.7×10⁻⁴. The base runs reproduce Run 14's whole symptom set:
* announcement stalls ("Item 5 is green. Now building item 6.")
* an 11 KB monologue reasoning about the label ("(commentary) — Hmm, need exactly one tool call … END.")
* lost answers
* a false `fulfilled`

**Short and medium A–E (10 runs per arm):** acceptance 10/10, 10/10, 10/10.

| | base | fix | replay |
|---|---|---|---|
| mid-task stalls | 2 | 1 | 2 |
| lost answers | 0 | 0 | 2 (`sse-malformed`, finding #6, fixed afterwards) |
| reasoning tokens | n/a | 16.7K | 9.0K |

**Interpretation and limits:**
* The phase and upload defects show up when history is long and requests are large. That is where the fixed arms remove the stalls and the lost answers.
* On short tasks all arms are equivalent.
* Reasoning replay's gains are consistent in 2/2 long runs (n = 2): fewer reasoning tokens, responses, tokens and wall time.
* Repeated reads did not fall (8 vs 8) and narration fell; one run of each pair is small evidence.
* The DSH arm is historical (same model, provider and phase era, different tool paradigm and tasks), not a live run.
* Effort stayed `low` on all arms, so `medium` was not measured.

## 6. Changes and local commits
* `nexus-model/src/transport.rs`: bounded upload; trace hook.
* `nexus-model/src/sse.rs`: `MessageDone` (phase), `ReasoningDone`, `replayable_reasoning` (id ≤ 128 token chars, base64-only content ≤ 128 KiB, `summary_text` parts only), bounded; empty final arguments tolerated.
* `nexus-model/src/request.rs` / `prepare.rs`: `InputItem::AssistantPhase` (documented phases only) and `InputItem::Reasoning`. Reasoning must equal its own canonical capture (anything else is refused before a byte exists). Neither may end a request.
* `nexus-model/src/trace.rs` (**new, opt-in**): `NEXUS_PROVIDER_TRACE=<file>` writes one structural line per exchange. It records request shape (item kinds, sizes, tool digest, effort, flags), timings (connect, upload, held slices, first byte), stream event types, output item kinds (phase, reasoning size, call names), usage incl. cached/reasoning tokens, and the error. No text, no arguments, no headers, no credential; 0600; 64 MiB cap. Test-verified.
* `nexus-client`: `TurnOutput.messages` / `.reasoning`; transport detail kept in `Uncertain`/`TimedOut` text.
* `nexus-broker/src/inspect.rs`: `push_model_reasoning` + `push_model_text`; recovery note 320 chars. `context.rs`: new items sized and compacted (old reasoning dropped first). `completion.rs`: `sentences_of`.
* Diagnostic tools (not product, committed): `nexus-broker/examples/p0_first_message.rs` (rebuilds a run's exact first message from a preserved thread with the real `guidance` + `threads::build_context`) and `nexus-runtime/examples/p0_bench.rs` (drives an isolated `NEXUS_HOME` runtime through the supervisor, the Kernel and the normal consent/grant path).
* **Kept out of the tree:** `nexus-model/examples/p0_provider_probe.rs` stays an untracked local file. It loads the dev credential file directly and calls the provider outside the Kernel grant path; that is acceptable for a supervised investigation, but not as product tooling.

**Review-time hardening** (applied before committing):
* The trace file is opened with `O_NOFOLLOW` and is only appended to when it is a regular file. Provider response ids are truncated to 80 characters.
* `prepare` refuses a malformed reasoning item explicitly instead of ever serializing a placeholder. It was unreachable behind `validate_shape`, but now fails closed on its own.
* An empty final `arguments` no longer conflicts with arguments that arrived as streamed *deltas*. Before, only the `arguments.done` order was tolerated.
* A provider repeating the same completed message or reasoning item replays it once.

**Local commits** (each built, passed strict clippy and its targeted tests at that point):
| Commit | Change |
|---|---|
| `d4e5221` | fix: wait out provider upload backpressure instead of reporting a lost answer (+ transport detail in uncertain/timeout text, recovery note) |
| `63bd3d8` | feat: opt-in structural provider trace |
| `1c60c82` | fix: replay the model's own messages with the provider's phase label |
| `f705e50` | feat: replay the model's own encrypted reasoning items within a run |
| `4cd19d3` | fix: two robustness defects found in the P0 benchmark (version-number sentence split; empty duplicate tool arguments) |
| (this commit) | docs + offline diagnostic tools |

Phase and reasoning touch the same structures, and transport and trace share hunks, so the commits were produced as verified snapshots. The final tree is byte-identical to the reviewed and benchmarked state plus the hardening above.
* Security: no new endpoint, header, proxy or credential path. Replayed reasoning goes only to the same pinned origin within the same run and target. Bounds are unchanged or tighter. Fail-closed rules are kept: only an *empty* duplicate completion is now ignored.

## 7. Verification
* **Native workspace**, `NEXUS_REQUIRE_SANDBOX=1`, on the committed branch (`4cd19d3`): **907 passed, 1 failed, 49 ignored** (the 49 are the multi-UID tests, which need a prepared host). That is 908 tests: the earlier 906 plus 2 review-time tests.
  * The one failure is `broker_a53::a53_broker_crash_and_daemon_restart_never_duplicate_a_billable_submission`: `"another broker already owns this state directory"` when the test restarts a broker on the same state directory immediately after `shutdown()`.
  * It **predates this branch.** No P0 commit touches broker startup, locking or that test.
  * **Correction (R-LOCK-1, 2026-10-20):** the cause given here originally - the lock outliving `shutdown()` in a detached thread that still holds `Arc<Broker>` after the 20 s worker-join deadline - is **wrong**. A probe showed the previous broker was never alive after `shutdown()`. The actual cause: the lock is an `flock`, which belongs to the open file description, and a child process forked by *any* thread of the test process (sibling tests spawn daemons, node bridges, git and sandboxes) holds a copy of that description between `fork` and `exec`. Closing the broker's descriptor therefore did not release the lock while such a child existed. The same rate was reproduced on `a497b87` and on EM-01 (about 45% of restarts under an in-process spawn storm, 0% without one). R-LOCK-1 (`nexus-broker/src/state_lock.rs`) releases the lock explicitly when the broker is dropped. See R-LOCK-1 for the evidence.
  * It passed 5/5 in isolation and 3/3 as a full suite, and in all three earlier batteries.
* `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` are clean. Each commit also passed strict clippy and its targeted tests on its own.
* **New tests (21 + the existing suites):**
  * upload ×3 and trace ×1, including the symlink check (`p0_transport_upload.rs`)
  * phase ×4, reasoning ×2, empty arguments ×2, repeated completion ×1 (`opencode_go_a54.rs`)
  * broker unit ×3 (phase replay, bound, reasoning window)
  * completion ×1 (version-number sentence)
  * sandbox E2E ×3 (`code_a56.rs`: preamble with phase before its call, unlabelled text unchanged, reasoning before its call)
* `a614` request-size test: max 449,944 bytes, **unchanged** (56 B headroom). Fixtures emit no phase or reasoning, and no request field was added.
* **Desktop Tauri backend** (`CARGO_INCREMENTAL=0`): 27 passed, 0 failed. Desktop TS untouched (no frontend change).
* **Live**: the provider accepts the exact minimal phase item and reasoning items Native now sends (HTTP 200 throughout the A/B).

## 8. Budget
* Investigation probes: ~5.1M input / 0.2M output.
* Forward A/B: 30.4M input (fix and replay arms ≈ 95% cache hits; base not measurable) / 0.43M output.
* **Total ≈ 35.5M input tokens and 0.6M output.**

The isolated homes, which held credential copies, were deleted after the runs. Evidence is archived in the session scratchpad (`bench/archive`, `analysis.json`, traces).

## 9. Detection vs prevention
* **Prevention:** #1 removes the measured cause of the stalls (0 in 419 long-task responses vs 8 in 217), and #2 removes the lost-answer class.
* **Detection only:** #5 closes one acceptance gap (a version number hid an announcement), and #6 removes one needless re-ask. Neither changes the model's behaviour.

## 10. Remaining risks and follow-up
1. The effort default for this route (`low` vs DSH's `medium`) is an operator decision; the A/B did not measure `medium`.
2. Reasoning replay rests on n = 2 long runs plus the CCv2 RC1 incident. Watch reasoning tokens and responses per task with `NEXUS_PROVIDER_TRACE` in normal use.
3. Instructions still travel as a user message (DSH: `developer`). Not tested; no evidence it matters after #1.
4. Provider upload stalls (~0.6 s on 2–3% of large requests) now only cost latency. Keep-alive reuse might avoid them (untested; it would change the transport's per-request connection model).
5. A response that mixes phase-labelled message items with text that never arrived as a completed item replays only the labelled items. OpenCode Go always completes its items, but a provider that streams text without completing the item would lose that text from the replay. It would still be recorded in the transcript.
