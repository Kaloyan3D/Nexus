# EM-04C1 — IPC security matrix

Scope: the persistent Governor worker (`engine/worker_bridge.rs` supervisor,
`engine/muse_bridge_worker.cjs` worker) and the three other trust boundaries EM-04C1 touches
(Registry-sealed budget, tool catalog, process lifecycle). Every row names the control and the test
that proves it. "Rust" = enforced by the supervisor in the broker, which never trusts the worker;
"Node" = a second, independent check inside the worker.

Test locations: `W` = `nexus-broker/src/engine/worker_tests.rs`, `S` = `signals_tests.rs`,
`G` = `muse_v1_tests.rs`, `C` = `catalog_tests.rs`, `E2E` = `nexus-broker/tests/code_a56.rs`,
`R` = `tests/RegistryRequestBudget.Tests.cjs`, `M` = `nexus-model/src/repo_tools.rs` tests,
`K` = `nexus-contracts/src/task_binding.rs` tests.

## 0. Trust model

| Party | Trusted for | Not trusted for |
|---|---|---|
| Broker (Rust) | task and engine state, Kernel/Registry calls, every decision | — |
| Worker (Node) | computing the historical Governor/Signals/Activity algorithms on the state it is handed | anything else: it holds no state, no credentials, no handle, no file, no socket, no environment |
| Model output, tool results, files in the repository | nothing | selecting effort, catalog, budget, engine, scope |

The worker is treated as an **untrusted, crashable calculator**: whatever it returns is validated
as if it came from the network; its answer changes state only through the same host validation
(`check_transition`, `fold_signal`, EM-03 durable commit) that validated the one-shot bridge's.

## 1. Worker IPC

| # | Threat | Control | Layer | Proof |
|---|---|---|---|---|
| 1 | Worker runs different algorithms than the broker embeds | `hello` carries the 4 historical sources + bridge; the worker answers SHA-256 of each; the supervisor requires an exact digest set equal to its own (extra/missing/other digest ⇒ refuse, kill) | Rust | `W a_worker_that_loaded_other_sources_is_refused_at_start` (governor tamper, extra, missing digest, extra field) |
| 2 | Embedded sources drift from `config/` | byte-equality test (EM-04A) + `sources_digest()` in every decision | build/test | `governor_bridge::the_embedded_sources_are_the_historical_files_byte_for_byte` |
| 3 | Worker adds behaviour (new `require`, fs, net) | the one-shot bridge's adapters are what runs: only `node:crypto/vm/path` shims, virtual fs, fixed clock; every other `require` throws | Node | `governor_bridge::the_bridge_refuses_any_dependency_outside_the_traced_set` |
| 4 | Partial message (TCP-style split frames) | length-prefixed frames; `read_exact`; the worker reassembles split input | Rust+Node | `W partial_and_truncated_frames_are_handled`, `W the_real_worker_survives_unknown_ops_split_frames…` (1 byte at a time) |
| 5 | Truncated frame then death | EOF inside a frame ⇒ `Died`; one retry on a clean worker; then `bridge-failed` | Rust | `W partial_and_truncated_frames_are_handled` |
| 6 | Oversized frame (memory exhaustion) | response ≤ 256 KiB (header checked before allocating; 0 and over-max refused); request ≤ 512 KiB args / 640 KiB frame; hello ≤ 1 MiB | Rust+Node | `W an_oversized_frame_is_refused_without_being_read`, `W oversized_input_is_refused_before_any_process_starts`, `W the_real_worker_refuses_every_malformed_or_replayed_frame` |
| 7 | Malformed JSON / wrong shape | strict envelope: closed key sets, version, type, id type, scope, `bridge.ok` boolean; anything else ⇒ `bridge-protocol`, worker killed | Rust+Node | `W a_stale_replayed_or_foreign_response_is_refused` (12 shapes), raw-frame suite (12 shapes) |
| 8 | Duplicate response (replay) | one request in flight; before each send the response channel must be empty; an extra frame ⇒ violation; the response must carry exactly the awaited id | Rust | `W a_duplicated_response_is_a_violation_never_a_second_answer` |
| 9 | Stale / future / foreign-id response | `id` must equal the request id (strictly increasing per process, from 1) | Rust | `W a_stale_replayed_or_foreign_response_is_refused` (older, newer, string id) |
| 10 | Replayed or skipped request id to the worker | worker requires `id = last + 1` and exits otherwise | Node | raw frames: replayed id, skipped id, id 0, fractional id |
| 11 | Cross-task / cross-run crossover | one worker process per run; its `scope` (task generation) is echoed and compared; a response for another scope ⇒ violation | Rust | `W two_runs_never_see_each_others_requests`; `W a_stale_replayed_or_foreign_response_is_refused` (foreign/missing scope) |
| 12 | State carried between requests (hidden ledger) | every request re-instantiates the historical modules in a fresh closure with a fresh virtual store and clock; the processed-signal window lives in the caller's state | Node | `W the_worker_keeps_no_state_between_requests`; parity corpus equality with the one-shot bridge |
| 13 | Duplicate accepted transition after a crash/retry | pure function of its arguments: a retried request returns the same answer; the host applies only the one answer it receives, durable-before-ack | Rust | `S a_worker_dying_during_signal_acceptance_neither_loses_nor_doubles_the_signal`; `G a_worker_dying_during_a_governor_evaluation_yields_the_same_single_decision` |
| 14 | Worker crash mid-evaluation | detected (EOF/exit); process reaped; ONE retry on a fresh worker; second failure ⇒ `bridge-failed`; engine fails safe (shadow: error code recorded; signals: "not recorded", never applied later) | Rust | `W a_crash_during_an_evaluation_is_retried_once_on_a_clean_worker`; `S a_worker_that_keeps_dying_leaves_the_signal_unrecorded…` |
| 15 | Crash loop | ≤ 6 spawns per 60 s per supervisor ⇒ `bridge-restart-limit` | Rust | `W a_crash_loop_stops_restarting` |
| 16 | Worker killed between requests | idle death detected before use; replaced | Rust | `W a_worker_killed_between_requests_is_replaced` |
| 17 | Hang / infinite loop | per-request deadline (10 s prod); on expiry the process is SIGKILLed and reaped; NOT retried | Rust | `W a_hung_worker_times_out_is_killed_and_replaced`, `W a_worker_that_never_starts_times_out` |
| 18 | Cancellation | the run's cancel flag is polled every ≤ 20 ms while waiting; set ⇒ worker killed, `bridge-cancelled`; nothing restarts afterwards | Rust | `W cancellation_stops_a_pending_request_and_kills_the_worker` |
| 19 | Unbounded queue / memory | ≤ 4 callers per worker (`bridge-busy`), 1 frame buffered per direction, ≤ 16 live workers per broker, `--max-old-space-size=96` | Rust | `W waiting_callers_are_bounded`; `W the_worker_environment_is_empty_and_its_memory_stays_flat` |
| 20 | Orphaned or leaked process | owner = the run: `shutdown` on lease drop, `Drop` kills + reaps + joins; worker exits on EOF of its stdin | Rust+Node | `W shutdown_and_drop_end_the_process`; raw: EOF ends the worker; `E2E em04c1_one_worker_serves_the_whole_run_and_ends_with_it` |
| 21 | Reader/writer thread deadlock on a stuck pipe | the receiver is dropped before joining the reader; a blocked writer ends when the child dies | Rust | found and fixed during development; `W a_duplicated_response…` (reproduced the hang) |
| 22 | Credentials / Kernel authority reachable | `env_clear`, `stderr` null, no fd inheritance, no Registry/Kernel client in the module graph; the worker receives only Muse blocks | Rust | `W the_worker_environment_is_empty…` (`/proc/<pid>/environ` empty) |
| 23 | Hostile input to the historical modules | unchanged validation: `state-invalid`, `event-invalid`, `signal-forbidden-field` etc. pass through verbatim | Rust+Node | `W the_worker_answers_exactly_like_the_one_shot_bridge` (same codes) |
| 24 | Spawn failure / no node | `bridge-unavailable`; no counter leak | Rust | `W a_missing_node_is_unavailable_and_leaks_nothing` |
| 25 | Run keeps working while the worker is attacked | shadow decisions are advisory; SIGKILL storm during a real run | Rust | `E2E em04c1_a_run_is_unaffected_when_its_governor_worker_is_killed_repeatedly` |

## 2. Registry-sealed request budget

| # | Threat | Control | Proof |
|---|---|---|---|
| 26 | Broker config widens a mode's budget | effective budget = `min(sealed, broker value)`; a broker value can only tighten | `E2E em04c1_the_broker_can_only_tighten_a_sealed_budget` |
| 27 | Model/tool output changes the budget | the budget exists only in the digest-covered Registry target; nothing in a run writes it | structural; `E2E …forged_profile_selection…` runs hostile text through the same path |
| 28 | Edited issuance (budget changed, digests untouched) | `selfConsistent` / issuance id derives from target bytes, Kernel seal verifies | `R the task binding and every attempt keep the budget; a changed budget is refused` |
| 29 | Issuance of another budget presented under the task's binding | `TaskBindingV1.admits` compares the projected target digest (budget included) | `R …`, `K a_binding_admits_only_targets_with_its_own_budget` |
| 30 | Out-of-range / non-integer budget | Registry schema, compile, contract `validate_complete` (Kernel seal), broker `request_budget_bytes()` range filter | `R the mode schema accepts…`, `R an out-of-range budget…`, `K a_budgeted_target_round_trips_and_is_bounded` |
| 31 | Continuation under a changed budget | budget is part of the binding identity | `E2E em04c1_a_sealed_budget_is_stable_across_continuation_and_a_changed_one_is_refused` |
| 32 | Attempt target budget ≠ task budget | broker refuses `request-budget-mismatch` before preparing the attempt | defense in depth (the Kernel/Registry paths in rows 28–29 reject first) |
| 33 | Budget truncates mandatory content | `request_budget::fit` never touches user messages, function calls, or the latest step; unmet ⇒ `request-budget-exceeded` before dispatch | `E2E em04c1_the_smallest_sealed_budget_compacts_safely_and_an_impossible_one_fails_before_dispatch`; EM-04A `request_budget` unit suite |
| 34 | Budget changes bytes of unbudgeted modes | key absent when unset; generous budget changes no byte | `K a_target_without_a_budget_is_byte_for_byte_what_it_was`; `E2E em04c1_muse_v0_requests_are_byte_identical…`; `R a mode without a budget compiles exactly as before` |

## 3. Tool catalog

| # | Threat | Control | Proof |
|---|---|---|---|
| 35 | Signals tool offered to production `muse-v0` | catalog = pure function of (run kind, sealed engine id); only the exact id `muse-v1-signals` selects it | `C the_catalog_follows_the_sealed_engine_identity_and_nothing_else` (17 look-alike ids) |
| 36 | Look-alike / padded engine ids | exact string match | same test |
| 37 | Production build selects the experimental engine | `engines(false) == ["muse-v0"]`; the id is only registered in `test-engines` builds | `C the_signals_catalog_cannot_be_reached_from_a_production_engine_list` |
| 38 | Catalog bytes drift | frozen SHA-256 per profile; `verify_catalog` at run start (`tool-catalog-mismatch`) | `M each_catalog_has_its_own_frozen_identity`, `M a_mismatched_catalog_is_detected` |
| 39 | Wrong catalog on the wire | digest of the actual request `tools` array equals the frozen identity of the sealed engine, for every request | `E2E em04c1_the_wire_catalog_is_the_frozen_identity_of_the_sealed_engine` |
| 40 | Forged profile selection via file text / model prose | no input channel exists; hostile file read by the agent, then calls naming profiles/engines | `E2E em04c1_forged_profile_selection_and_cross_engine_tool_calls_change_nothing` |
| 41 | Cross-engine tool call (signals tool in `muse-v0`; Kernel ids or invented tools in the signals engine) | validated against the run's profile; unknown ⇒ `refused`; no signal event | same test; EM-04B `em04b_production_and_shadow_runs_never_offer_or_accept_the_signals_tool` |
| 42 | Run silently re-bound to another catalog | the digest is bound once on the run record; a different one refuses | `Broker::bind_tool_catalog` (set-once) |

## 3b. Credential exposure and OS-level isolation (final review)

| Surface | Finding | Proof |
|---|---|---|
| Environment | empty (0 bytes) | `E2E em04c1_the_worker_is_lazy_and_inherits_neither_environment_nor_descriptors`, `W the_worker_environment_is_empty…` |
| Command line | node, heap flag, `-e <worker script>`, `--`, opaque task-generation id; no credential material | same E2E |
| Descriptors | stdin/stdout pipes, `/dev/null`, Node's own pipes/anonymous inodes; no file, directory or socket; **none shared with an object the broker holds** | same E2E (intersection with the broker's `/proc/self/fd`) |
| Data | Muse blocks, authorized levels, trusted observations; never credentials, grants, paths | construction (`inspect.rs`, `muse_v1.rs`) |
| **OS confinement** | **not provided**: same uid, namespaces, no seccomp/landlock/cgroup. IPC-level isolation is not OS isolation. | stated limitation; unchanged from the one-shot bridge |

## 4. Residual risks

1. The worker shares the broker's user and PID namespace. It cannot be given a sandbox without
   platform work; its capability is nevertheless nil (no environment, no fds, no inputs but frames),
   and a compromised Node binary would equally compromise the one-shot bridge. `trust::resolve_node`
   still pins the binary.
2. A request that makes the *historical module* slow (not hang) up to the timeout blocks that run's
   shadow evaluation for ≤ 10 s; callers fail safe, the run continues.
3. One retry doubles a poisoned request's cost once. A request that deterministically kills the
   worker costs two spawns per attempt until the restart window (6/60 s) trips.
4. The scope echo defends against implementation errors (a worker shared by mistake); it is not a
   cryptographic binding. Cross-run isolation is by construction (one process per run).
