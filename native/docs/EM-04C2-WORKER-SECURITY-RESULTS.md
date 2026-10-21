# EM-04C2 Checkpoint 1 — Worker security results (S1)

Branch `feature/native-muse-adaptive-foundations`, baseline `50a24d791cdb3c1a4b00eb15b24843c4b45d9798`.
Uncommitted. Decision D3 (approved): every Governor-capable worker runs under Node's **deny-all
permission mode**, proves it in the versioned start-up handshake, and fails closed if it cannot.

**Important framing, as required:** the Node permission model is **defence in depth, not an OS
sandbox.** It closes filesystem access, process spawning, native addons, worker threads and the
inspector. It does **not** restrict the network, does not change the user id, and is not a boundary
against a memory-safety bug in Node itself. §7 states the residual trust boundary.

## 1. What changed

| Item | Before (C1) | Now | Source |
|---|---|---|---|
| Node flags | `--max-old-space-size=96` | `--permission --max-old-space-size=48 --max-semi-space-size=2`; **no** `--allow-*` flag exists in the product configuration | `engine/worker_bridge.rs` `worker_node_flags()` |
| Permission proof | none | `ready` must carry a report (§2); the worker refuses to answer without it and the supervisor re-verifies it | `engine/muse_bridge_worker.cjs` `permissionReport`, `worker_bridge.rs` `verify_permission` |
| Old / unprotected Node | n/a | the option is rejected by Node (`bad option`) or the proof is missing → the worker never answers; error `bridge-failed` "… needs Node >= 23.5 with --permission … no unprotected fallback" | `worker_bridge.rs` `spawn` |
| Concurrency | fixed 16 | per broker `min(max_active, 16)` (`WorkerSlots`), process-wide backstop 16 | `worker_bridge.rs` `WorkerSlots`, `server.rs` (`worker_slots`), `inspect.rs` |
| Unchanged | | statelessness, versioned bounded IPC, timeout/cancel/restart limits, scope echo, one process per run | |

## 2. The start-up proof

`ready` carries `permission: { enforced, scopes, canaries }`. The worker computes it from inside its own
realm; it exits with `fatal permission-not-enforced` (and never sends `ready`) unless **all** hold:

* `process.permission.has(scope)` is `false` for `fs.read`, `fs.write`, `child`, `worker`, `addon`
  (an absent API counts as not enforced);
* four canary operations are refused: `fs.accessSync(node binary)` and `fs.openSync(<missing dir>/x,'w')`
  and `child_process.spawnSync(node,['-v'])` → `ERR_ACCESS_DENIED`; `process.dlopen(<missing .node>)` →
  `ERR_DLOPEN_DISABLED` (or `ERR_ACCESS_DENIED`).

The canaries are harmless if enforcement were absent (an access check, a write into a directory that
does not exist, `node -v`, a file that does not exist). The supervisor **independently** requires the
exact shape (`enforced: true`, the five scopes all `false`, the four canary codes, no extra fields) and
treats anything else as a protocol violation: the process is killed and never used.

## 3. Tests (all pass)

| Claim | Test (`engine/worker_tests.rs`) |
|---|---|
| The reviewed flag set grants nothing | `the_worker_flags_are_exactly_the_reviewed_set_and_grant_nothing` |
| **The supervisor itself refuses any other flag set outside test builds** (any `--allow-*`, a dropped or reordered `--permission`, extra flags): a property of the code, not of how the default is built | `production_refuses_any_worker_flag_set_but_the_reviewed_one` (`check_worker_flags`, consulted by `spawn`) |
| Under the worker's exact flags, on **both** Nodes: read of a 0600 same-uid file, `/proc/self/environ`, write, delete, `child_process`, `worker_threads`, inspector, `process.binding` → `ERR_ACCESS_DENIED`; native addon → `ERR_DLOPEN_DISABLED`; nothing written or deleted; a control run **without** the flag does all of it; the network socket **is** allowed (documented residual) | `the_worker_denies_filesystem_process_and_addon_access_on_every_node` |
| The real worker proves it in the handshake (both Nodes) | `the_real_worker_proves_the_permission_mode_in_its_handshake` |
| A worker started without the mode never answers; error text explains; nothing is kept | `a_worker_without_the_permission_mode_never_starts_to_answer`, `the_real_worker_without_the_permission_mode_answers_its_hello_with_a_fatal` |
| A `ready` with a missing, disabled, partial or doctored proof (10 shapes) is rejected and the process killed | `a_ready_without_a_complete_permission_proof_is_rejected` |
| A Node that rejects `--permission` (an old Node) fails closed, with the version hint, no retry | `a_node_that_rejects_the_permission_flag_fails_closed` |
| Concurrency follows `max_active`, clamped 1..16; a refused spawn takes nothing; ending a worker returns its slot | `the_worker_allowance_follows_max_active_and_never_exceeds_sixteen` |
| Memory budget on every Node | `the_worker_stays_inside_its_memory_budget_on_every_node` (2,000 requests) and `…_after_ten_thousand_requests` (ignored measurement) |
| Real runs: environment 0 bytes, command line = node + the three flags + the task id, descriptors only pipes/anonymous inodes//dev/null, none shared with the broker, one worker per run, gone afterwards | `code_a56` `em04c1_the_worker_is_lazy_…`, `em04c1_one_worker_…`, `em04c1_production_muse_v0_runs_never_start_a_governor_worker` |
| Everything C1 proved about IPC, crash, restart, cancel, backpressure still holds under the new flags | the 30 pre-existing worker tests (the raw-frame suite now starts the real worker with the flags) |

The two tests that need to grant the worker a file (the "crash once" marker used by the restart tests)
add `--allow-fs-read/--allow-fs-write=<that one marker path>` to a **test-only** configuration; the
product configuration is asserted to contain no `--allow*` flag.

## 4. Memory and latency

Workload: the specified test workload — an `evaluate` request every time, with a recorded hypothesis
failure signal on every second request, state carried by the caller — 10,000 requests per runtime,
**release** build, `RSS` read from `/proc/<pid>/status` at the end.

| Runtime | RSS after 10,000 | VmHWM | median | p95 | p99 |
|---|---|---|---|---|---|
| Bundled Node 24.18.1 (`~/.local/share/nexus/runtime/node/bin/node`) | **77.0 MiB** | 77.0 MiB | 1.44 ms | 2.47 ms | 3.72 ms |
| System Node 26.10.0 (`/usr/bin/node`) | **74.1 MiB** | 77.2 MiB | 1.19 ms | 2.19 ms | 3.23 ms |

Target ≤ 100 MiB: **met on both**. Compared with the C1 flags on the same workload and the bundled Node
(measured in the pre-activation review): 208–214 MiB RSS, median 1.17 ms — a **63 % memory
reduction for ≈ +0.2 ms**. Cold start (spawn + handshake + permission canaries + first request) is **77.9 ms**
(65 ms in C1; the canaries cost ≈ 13 ms), once per run, only for Governor-capable engines. Release
round trips on the one-shot comparison run: Governor 1.19 ms vs 97.7 ms (×82), signal 1.38 ms vs 82.9 ms (×60).
With `max_active` = 8 the worst case is 8 × ≈ 80 MiB ≈ 0.64 GiB (0.16 GiB at 2).

## 5. Fail-closed behaviour (summary)

| Situation | Result |
|---|---|
| Node without `--permission` (old) | exits at start; `bridge-failed` + hint; engine falls back (shadow records the error, signals "not recorded"); no unprotected worker |
| Permission flag absent in the argv | worker exits `fatal permission-not-enforced`; same |
| A worker claiming enforcement it lacks | supervisor rejects the report (`bridge-protocol`), kills it |
| Scope or canary result outside the exact expectation | rejected |
| More runs than the broker's `max_active` allowance | `bridge-busy` for the extra run's Governor; the run itself continues |

## 6. Interaction with C1 guarantees

Unchanged and re-run: byte-identical `muse-v0` requests (no worker for `muse-v0`), one process per
run, empty environment, bounded frames, id/scope validation, restart limit, cancellation, durable-before-
ack semantics, the parity of Governor and Signals on **both** bridge transports (one-shot: 118 engine
tests pass; worker: inside the battery).

## 7. Residual trust boundary (accurate statement)

* The worker runs as the **broker's user**, in the same PID/mount/network namespaces. The permission
  mode removes its ability to read or write files, spawn processes, load native code or start threads
  **through Node**; it is not enforced by the kernel, and Node documents it as a safeguard rather than a
  hostile-code sandbox. A memory-safety bug in V8/Node reachable through the JSON the worker parses could
  still escape it.
* **The network is not restricted.** A compromised worker could open sockets. It would hold no secret
  (empty environment, no readable file, no credential in its inputs) and the only Kernel-bound capability
  file is unreadable to it, but this is a mitigation, not a guarantee.
* What the worker receives is limited to Core-validated, enumerated or bounded values (no free model text),
  so the parsing surface is small (see the pre-activation security review §A.3).
* Hence the control is "required, necessary, not sufficient": OS-level confinement stays an **open
  review gate** for EM-04C2 (handoff §5.1) and is not claimed here.
* The proof is only as good as Node's implementation: `process.permission` and the canaries verify the
  behaviour of the Node that actually started, on every worker start.

## 8. Findings

1. Node 24.18.1 and 26.10.0 behave identically for the flags, the API and the canaries (checked).
2. The old heap-only flag left the young generation unbounded: the previous cap was not a memory cap.
3. The unchanged worker script ran under `--permission` without modification; the only addition is the
   proof.
4. The wiring `WorkerSlots::for_max_active(cfg.max_active)` is verified by unit tests and by the broker
   construction (`server.rs`); a broker-level test that saturates the allowance with concurrent adaptive
   runs is not possible until an adaptive engine can run (S6) and is listed for Checkpoint 2.

## 9. Verdict

The persistent worker now starts only under proven deny-all permission mode, cannot be coaxed into an
unprotected fallback, uses ~63 % less memory within the 100 MiB target on both Node runtimes, and keeps every
C1 IPC guarantee. **APPROVE**, with the residual boundary of §7 recorded as an open review gate.
