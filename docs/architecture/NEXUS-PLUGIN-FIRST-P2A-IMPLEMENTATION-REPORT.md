# Nexus plugin-first P2-A implementation report · Controller authority consolidation

P2-A is the safety foundation for the first-party Nexus CLI. It builds on the [P1 report](NEXUS-PLUGIN-FIRST-P1-IMPLEMENTATION-REPORT.md), the approved [architecture](NEXUS-PLUGIN-FIRST-ARCHITECTURE.md), the [roadmap](NEXUS-PLUGIN-FIRST-MIGRATION-ROADMAP.md) and the [CLI contract](NEXUS-CLI-CONTRACT.md). **Implemented** means code plus tests in this change; **blocked** means a property that could not be proven with a supported seam and therefore stays disabled.

## 1. Revisions and scope

| Item | Value |
|---|---|
| Branch | `feature/nexus-plugin-first-p1` in `/Users/kaloyannikolov/Projects/Nexus`, base `dev` @ `7448ac9a`. P1 changes preserved; nothing reset, stashed, switched or committed. New `config/nexus/*` files are staged (`git add`) only because the closure tool refuses untracked closure files. |
| Pins | DSH `0.2.2-rc.1` (`66491b05`), Cordis `4.1.0`, Node `24.18.1`, PowerShell `7.5.3`, unchanged. |
| Test roots | APFS clones of the isolated test install (`~/Nexus-DSH-0.2.2-Test/root`, never modified), private `HOME`/`TMPDIR`, closures and patch regenerated inside the clone, synthetic PowerShell host or dead proxy, no credential. Ports 3080/3081 and both running Nexus instances untouched. |
| Not in scope (not started) | Public CLI commands, packaging, IPC transport, managed CLI sessions, Nova, journal, Sentry, Studio, CCv2 mutation, loop/factory replacement, routing changes. |

## 2. Task A — single authoritative session-binding writer

### Before and after

| | Before P2-A (P1) | After P2-A |
|---|---|---|
| Writers of `data/routing/session-bindings.json` | Three: each standing `aih-controller` mount (`aih-engineering`, `aih-deepseek`, `aih-muse`) ran its own `persistBindings` and rewrote the whole document from its own cache. | **One**: the host Controller's `bindings` store (`config/nexus/binding-store.cjs`). Bridges hand their cache and observed stamps to `core.bindings.commit(mountId, …)`. The bridge source contains no binding writer (asserted by test). |
| Readers | Muse/Engineering isolation, Routing Integrity, `StepRouting.ps1`, UI status/detail, bridges. | Unchanged (same file, same schema 1). |
| Algorithm | Re-read durable → adopt foreign authority / refuse stale authority change / refuse vanished Registry authority → whitelist → temp + fsync + rename + dir fsync. | **Verbatim** (diffed against `7448ac9a`: only the whitelist moved into a function with an identical body; `loadBindings` byte-identical). |
| Disposed-session removal across planes | **Defect**: another plane's stale cache resurrected a removed binding on its next write (reproduced on the pre-P2-A bridge: removing `a` and `b` through two mounts left `a` durable). | Fixed by single ownership: the store tombstones removals it commits and drops a later stale copy with the **same** authority stamp; a re-bound session (different authority) is written. |
| Writers after host unload / remount | Each mount kept writing with its own closure. | Store closes on disposal (`binding-store-closed`); a mount id from a previous host generation is refused (`binding-writer-detached`); the bridge re-attaches once to the new host. |
| Missing host | n/a | Strict callers throw, others log `bindings-persist-failed … nexus-controller-unavailable`; no local fallback writer. |

### Serialization, freshness, atomicity, disposal

- **Serialization:** `commit()` is synchronous from read to rename, so commits from all three bridges in one host process cannot interleave on the JS thread. A per-host revision counter and per-session revisions are kept in memory for consumers (Task D).
- **Freshness:** every commit re-reads the durable document; anything written outside the store (a crashed or older process, a test) is adopted or refused exactly as before.
- **Atomic replacement:** temp file in the same directory, `fsync`, `rename`, then directory `fsync` on POSIX. Killing the writer after `fsync` but before `rename`, or during a torn temp write, leaves the previous document intact and readable; orphan `*.tmp` files are inert and ignored (test).
- **Disposal:** the host closes the store **before** draining transitions and releasing ownership, so no binding write can land during shutdown.
- **Cross-process (unsafe assumption avoided):** the store does **not** claim cross-process exclusion. Two host processes on one data root could still race between read and rename. That property belongs to host ownership (Task C), which is implemented and reported but not yet enforced (§4, §8).
- **No behavior change otherwise:** schema, field whitelist, error codes and call sites are unchanged; no PowerShell call or inference was added.

## 3. Task B — DSH owner-peer mutation authority

### Source findings (pinned DSH 0.2.2-rc.1)

- **Transports.** Unary Remote methods run only over HTTP `POST /api/<namespace>/<method>`: admission (launch-token cookie) → the `connection/request` waterfall (`dsh-client-connection`) → the gateway interceptor → `prepareInvocation`. Stream-mode methods run only over the WebSocket mux (`REMOTE_STREAM_MUX_PATH`), admitted by `admitConnection`, and never pass `connection/request`. The gateway refuses to open unary methods on the stream carrier and vice versa.
- **Owner bypass.** `prepareInvocation` skips resource resolution and `remoteAccess.decide` when `peer.principal.kind === 'owner'`; browser and launch-token peers are created as `owner`. Registering an extra `/api` interceptor is impossible (one per channel).
- **Supported per-call seams.** `connection/request` exposes `(req, res, next)` before the body is read; the JSON-RPC body is consumed downstream, so a guard there sees only the path and cannot tell a managed session from an ordinary one without consuming or re-implementing the request (not supported). There is no supported per-method waterfall in the session, workspace, preset, job, schedule or subagent controllers (only `api-session/added` is emitted).
- **Effect seam.** Every route that makes an agent infer or run tools (prompt, queue/steer, schedule run, subagent prompt, fork followed by a prompt, resume) converges on the documented `agent/pre-step` waterfall, which may reject.

### Implemented guard (minimum defensible for P2-A)

`nexusController.admission` holds the set of Nexus-managed sessions. Managed admission is **disabled** in P2-A, and no product path registers a managed session yet. Every agent step of a managed session is refused twice over: by the host Controller's own `agent/pre-step` listener (prepended, independent of the bridges) and by the bridge's check at the top of its pre-step (before any controller CLI). Ordinary legacy sessions are untouched.

### Coverage (real-host test `tests/NexusOwnerPeerGuard.Tests.mjs`, owner peer over real HTTP)

| Owner mutation path | Managed session (P2-A) | How / evidence |
|---|---|---|
| `session/prompt` (HTTP, owner) and every agent step | **Refused**, 0 model requests, 0 controller CLIs | Effect gate at `agent/pre-step`; measured on the pinned host (`evidence/p2a/owner-peer-real-host.json`). |
| Queue/steer, schedule `run`, subagent `prompt`, fork + prompt, resume then prompt | Refused at the same effect seam (all inference crosses `agent/pre-step`) | By construction of the loop; only the HTTP prompt route was exercised end to end. |
| Direct agent execution by host code | Refused at `agent/pre-step` (same seam) | Host code is trusted; it is not a security boundary. |
| `session/rename` | **Reachable** (title changed, HTTP 200) | Asserted as a known gap in the real-host test. |
| `session/cancel` | **Reachable** (accepted) | Bypasses future Controller cancel semantics. |
| `session/updateQueue`, `session/fork`, `session/selectModel`, `session/create` reuse | Reachable (no per-session seam) | `selectModel` cannot change an already captured request, but appends selection history. |
| Agent preset `select` (preset change) | Reachable at transport; a bound session's engine immutability still rejects the next step | Existing `assertEngineBinding`. |
| Tool approvals / user questions (`$events/result`, `user-questions/attachWait`) | Reachable for owner peers | Requires the P2-B approval broker over `approval/request` and `user-questions/request` waterfalls. |
| Workspace controller mutations (create/rename/delete/archive/pin, insertSessionBefore) | Reachable | Not session-scoped through a supported seam. |
| Terminal `attach` (stream uplink into a PTY), `cordis-host-runner invoke`, job `kill`, schedule `create/edit`, liveshare | Reachable for owner peers | Owner capabilities outside agent effects; terminal input can mutate the workspace without the agent. |
| Ordinary legacy sessions | Unchanged | Real-host test: bridge still runs its controller CLI. |

**Verdict for Task B:** agent **effects** of managed sessions are enforced and proven on the real host. Non-effect owner mutations of a managed session **cannot be intercepted per session through a supported DSH 0.2.2 seam**. This is a **blocking P2-B gate**: managed admission stays disabled until one of these exists: a narrowly pinned per-call hook (upstream extension or version-pinned compatibility change at `prepareInvocation`), a separate non-owner principal for the managed task client with an access policy, or an explicit decision to accept those operations as owner-only maintenance with Controller reconciliation (e.g. cancel → interrupted). No monkey-patch was added.

## 4. Task C — shared-host ownership

### Findings on the existing launcher

| Topic | Finding |
|---|---|
| Discovery | `scripts/aih.ps1` reads `data/aih-state.json` and accepts a running host only if PID, executable and process start time match (`Test-AihTrackedProcessIdentity`; macOS via .NET `Process.StartTime`, Linux via `/proc`). |
| Startup races | **No cross-process election.** Two concurrent `aih` starts can both find no live state and both spawn; the same port makes the second fail to bind, but two hosts with different `AIH_PORT` on one `DSH_HOME` both run and both write Nexus authority files. DSH's JSONL per-session lock protects only session logs. |
| Persistence after the launcher exits | The host is started detached (`Start-AihDetachedProcess`) with `cwd = data`, so it outlives the launcher; any ownership must therefore live in the host process, not the launcher. |
| Shutdown / crash | `Stop.ps1` stops the tracked process (force fallback exists). A crashed host leaves `aih-state.json` stale; the next launch reclassifies it. No lock is held today. |

### Implemented foundation

`config/nexus/host-ownership.cjs` acquires host lifetime ownership of the **canonical** data root (`realpath`, lower-cased on Windows) using the same kernel arbiters DSH uses for session write leases, with no TTL, no PID guessing and no lock deletion:

- **POSIX:** non-blocking `flock(2)` through the pinned `@deepseek-ai/node-addon-system/flock` on `<data>/routing/nexus-host.lock`, with DSH's post-lock inode/device re-check. Verified on macOS arm64 with real processes.
- **Windows:** named kernel semaphore `Local\nexus-host-lock-<sha256(path)>` through the pinned `koffi`, mirroring DSH's `acquireLockHandleWin32`. **Not executed** (no Windows host); a mechanism failure reports `unavailable`, never `held`.
- `nexus-host.json` is informational discovery data (pid, generation, build); it is removed only by its own generation and never proves ownership.

The host Controller acquires ownership at startup without blocking or stealing, releases it after admission closes, and reports it in `readiness().ownership` (`held | contended | unavailable`). **Enforcement is off** (`enforced: false`): legacy GUI behavior is unchanged when ownership is contended or unavailable. P2-B must make `nexus host start`, managed admission and binding writes depend on `held`, and must adapt in-process verification boots (`Verify-NexusComposition`) that may run beside a live host.

## 5. Task D — shared task API foundation

`nexusController.tasks` (`config/nexus/task-api.cjs`) is an **in-process** contract on the same trusted Controller for both future adapters (GUI routes and CLI IPC). No transport, no endpoint, internal principal only (`AUTH_REQUIRED` otherwise).

| Operation | P2-A | Notes |
|---|---|---|
| `hello` | Implemented | Controller build, readiness, ownership state, available and refused operations, `managedAdmission: disabled`, `transport: none`. |
| `listModes` | Implemented | `engineering-v1` → `nexus.legacy-dual`, `engineering-v2` → `nexus.muse`, readiness, `submittable: false`. |
| `getStatus` / `getResult` | Implemented (read-only) | Projection over the binding store, the TaskController ledger (schema 1), `attempts.jsonl`, `evidence.json`, `review-result.json`. Ledger `ready/implementing/verifying/complete/failed` → `queued/running/verifying/completed/failed`; unreadable/missing/unknown → `blocked` with a reason. **Completed only when the ledger says `complete`.** Muse review is `not_required` with policy reason. Opaque id = immutable `taskInstanceId`; display ids are refused as keys. |
| `follow` | Implemented | Bounded long-poll (≤ 30 s) over a per-host monotonic revision that advances only when an authoritative record changes. Projection counters are in memory (persisting them is P2-B). |
| `submit`, `cancel`, `respond` | **Refused** | `REQUIRED_CAPABILITY_UNAVAILABLE` with `reason: managed-admission-disabled`. |

No second ledger, no second Controller, no subprocess, no write.

## 6. New Controller contracts (`nexusController`, contract major 1, additive)

| Member | Contract |
|---|---|
| `bindings.commit(mountId, { cache, observed }, { bindingsPath?, removedSessionId? })` | Single writer (§2). Refusals: `binding-store-closed`, `binding-writer-detached`, `binding-store-path-mismatch`, `bindings-write-conflict`, `registry-authority-unverifiable`, `bindings-unverifiable`. |
| `bindings.read(sessionId)`, `list()`, `revisionOf(sessionId)`, `metrics()`, `closed` | Durable read-only access and counters. |
| `attachBridge(info)` → `detach` with `detach.mountId` | The mount id is the bridge's writer identity. |
| `admission.register/unregister/isManaged/check`, `admission.state` | Managed-session effect gate; `state: 'disabled'`. Registration is trusted host code only. |
| `ownership`, `setOwnership`, `readiness().ownership` | Host lifetime ownership state; `enforced: false`. |
| `tasks.hello/listModes/getStatus/getResult/follow/submit/cancel/respond` | §5. |

## 7. Tests and results

Production lane (`scripts/Test-Harness.ps1 -Lane production`, installed P2-A clone; evidence `evidence/p2a/production-lane-p2a.json`):

| Lane | Rows | Pass | Assertions passed / failed | Failing rows |
|---|---:|---:|---:|---|
| pre-P1 baseline | 106 | 104 | 3,250 / 2 | `ContextRestrictedProductionV2`, `Harness` |
| P1 | 109 | 107 | 3,285 / 2 | same two |
| **P2-A** | **113** | **111** | **3,307 / 2** | **same two** (pre-existing, environmental: lab modules omitted by the installer; credential-shaped fixtures) |

No existing row changed result against P1. The P1 suites (`NexusControllerCore`, `NexusLegacyCli`, `NexusControllerBridge`, `AihControllerHost`) and every roadmap suite in the lane pass (Muse isolation/governor/runtime/signals/activity, composed routing authority/matrix, runtime routing trace, task identity, controller routing, route admission, mode contract, session bootstrap, identity, visual lifecycle, compaction and CCv2 restriction suites).

New P2-A suites (all in the production lane):

| Requirement | Suite / evidence | Result |
|---|---|---|
| 1. Three bridges share one binding writer | `NexusBindingAuthority`: every rename of the document originates in `nexus/binding-store.cjs`; bridge source has no writer | pass |
| 2. Concurrent binding requests | 50 interleaved commits, no lost update, no temp leftovers | pass |
| 3. Stale binding updates | foreign authority adopted; stale authority change → `bindings-write-conflict`, file untouched; vanished Registry authority refused | pass |
| 4. Crash / interrupted atomic writes | child killed before rename and mid-write (SIGKILL): previous document intact and readable, next commit succeeds | pass |
| 5. Duplicate session events | `NexusControllerBridge` B3 (P1, still passing) | pass |
| 6. Controller unload/remount | real Cordis 4.1.0: store closed with its host, old mount ids refused, single re-attachment to the new writer | pass |
| 7. Missing Controller rejection | binding writes refused and logged; P1 B1/B2 turn refusals still pass | pass |
| 8. Repeated host startup | `NexusHostOwnership`: in-process repeat, three real Cordis start/stop rounds | pass |
| 9. Competing host ownership | real child process holds, parent contended; SIGKILL releases to a successor; symlink alias contended; competing host Controller reports `contended` | pass |
| 10. Supported DSH mutation guard coverage | `NexusOwnerPeerGuard` (pinned DSH Web, real HTTP, full production composition): managed step refused, 0 model requests, 0 controller CLIs; legacy unaffected | pass |
| 11. Owner-peer bypass attempts | same suite: owner `rename` and `cancel` of a managed session reach DSH (asserted as the documented gap) and produce no model request | pass (gap documented) |
| 12. EMv1/EMv2 equivalence | `NexusControllerBridge` Part A traces: pre-P1 vs P2-A identical (`evidence/p2a/bridge-trace-p2a.json`) | identical |
| 13. No additional model requests or subprocesses | identical controller-CLI sequences and `next()` counts per turn; task API starts no CLI and writes nothing | pass |
| Task D contract | `NexusTaskApi`: internal principal only, Dual/Muse projections, completion only from ledger, follow revisions, typed refusals | pass |

Reference run with `NEXUS_PRE_P2A_BRIDGE` set to the pre-P1 bridge: two per-mount writers removing `a` and `b` left `["a"]` durable — the resurrection defect fixed in §2. In the lane the reference is not configured and the suite reports 6 groups.

Pre-existing, unchanged and out of lane: `RegistryR631Lockdown`, `RegistryR632Execution`, `RegistryR74RollbackRecovery` (red on the baseline, see P1 report).

## 8. Cross-platform limitations

- **macOS arm64:** everything in §7 executed natively.
- **Linux (aarch64/x86_64):** same POSIX code path (`flock` addon ships glibc and musl builds), **not executed** in P2-A.
- **Windows:** the binding store's atomic replace uses the unchanged pre-P2-A sequence (no directory fsync on Windows, as before). The ownership semaphore path is untested and reports `unavailable` on any failure; ownership is not enforced, so Windows behavior is unchanged. A Windows run is a P2-B release gate.
- In-process verification boots beside a live host will see `contended` once enforcement exists; P2-B must handle that explicitly.

## 9. Remaining blockers (P2-B gates)

1. **Per-session authorization of non-effect owner mutations** (rename, cancel, queue/fork/model/preset changes, approvals/questions answers, workspace mutations, terminal input) — no supported seam in DSH 0.2.2 (§3). Managed admission stays disabled until resolved.
2. **Ownership enforcement**: make `held` mandatory for `nexus host start`, managed admission and binding writes; single-host election in the launcher (`NexusHost.ps1`); Windows and Linux real-process proofs.
3. **Approval broker** over `approval/request` / `user-questions/request` for managed sessions.
4. **Authenticated local IPC transport** for the task API (POSIX socket, Windows pipe ACL) — not started, by scope.
5. Pre-existing out-of-lane suites `RegistryR631Lockdown`, `RegistryR632Execution`, `RegistryR74RollbackRecovery` remain red on the baseline (classified in the P1 report).

## 10. Performance comparison

Synthetic transport, pinned Node 24.18.1, darwin-arm64 (`evidence/p2a/controller-overhead.json`, `binding-commit-bench.json`).

| Measure | Result |
|---|---|
| Host core construction (now including binding store, admission, task API) | 0.98 ms, ~57 KiB retained heap (P1: 0.80 ms, ~38 KiB) |
| Root-turn admission, EMv2 Muse, pre-P1 → P2-A | p50 135.2 → 133.0 ms, p95 138.5 → 135.3 ms (Δp95 −3.2 ms) |
| Root-turn admission, EMv1 Dual, pre-P1 → P2-A | p50 166.8 → 169.1 ms, p95 173.4 → 175.7 ms (Δp95 +2.3 ms, +1.3%) |
| Controller-CLI subprocesses per turn | Muse 4 → 4, Dual 5 → 5 |
| Binding commit with 50 live bindings (200 commits, two runs each) | pre-P2A inline writer p50 11.9 / 12.0 ms, p95 17.7 / 15.7 ms; P2-A host store p50 12.1 / 12.1 ms, p95 15.3 / 15.9 ms — dominated by the two fsyncs, no measurable difference |
| Model requests | none in any build or scenario |

Differences are within run-to-run noise (n = 20 admissions, single outliers set p95) and well inside the architecture's budget (larger of 20 ms or 5%). Not measured: 100-iteration runs on a quiet machine, cold boots, live-host memory, non-macOS platforms.

## 11. Rollback

1. Uncommitted: `git restore config/AihController.cjs config/nexus/controller.cjs scripts/Test-Harness.ps1` and remove `config/nexus/{binding-store,host-ownership,task-api}.cjs` and the new tests (`git rm --cached` for staged files). That returns the tree to the P1 state described in the P1 report.
2. Data: no schema or format change. `session-bindings.json` stays schema 1. New files are `data/routing/nexus-host.lock` (empty, safe to leave) and `nexus-host.json` (informational, removed on clean shutdown) and `data/logs/nexus-controller.log` entries.
3. Installed trees: reinstall the previous revision (closures and patch are published atomically with rollback). Ship host row, host closure and bridges together.

## 12. P2-A GO/NO-GO

**GO for P2-A, with managed admission deliberately disabled.**

| Success criterion | Status |
|---|---|
| One authoritative host-owned session-binding writer | **Met**: one store per data root in the host Controller; bridges are consumers; verified on three bridges, real Cordis remount and crash fault injection. |
| EMv1/EMv2 remain compatible | **Met**: identical normalized traces versus pre-P1, production lane unchanged except new suites. |
| Remaining shared-host authorization requirements validated or explicitly blocked | **Met**: agent effects of managed sessions validated on the real host; non-effect owner mutations **blocked** (no supported per-session seam), host ownership implemented but **not enforced**. Both are explicit P2-B gates (§9). |

One behavior change beyond a pure move, intentional and tested: a binding removed by one plane can no longer be resurrected by another plane's stale cache.

## 13. Readiness for P2-B

**P2-B may start**, limited to work that does not create managed CLI sessions until gates 1 and 2 in §9 pass:

- **Ready now:** the single binding writer, the in-process task API (`hello/listModes/getStatus/getResult/follow`) that a CLI adapter can wrap, typed refusals for `submit/cancel/respond`, host ownership with real-process proofs on macOS, and the managed-session effect gate.
- **Must precede managed admission (`submit`):** (1) a supported or narrowly pinned per-session guard for owner mutations, or an approved policy for them; (2) enforced single-host ownership in the host and launcher, with Linux and Windows proofs; (3) the approval broker; (4) the authenticated IPC transport (POSIX socket / Windows pipe ACL); (5) persisted projection counters and intake records.
- **Can proceed in parallel:** CLI argument parsing, JSON envelopes and exit codes against the frozen task API, packaging shims, the launcher election script, and read-only `nexus status/result/wait` over the in-process API once IPC exists.

P2-B was not started.
