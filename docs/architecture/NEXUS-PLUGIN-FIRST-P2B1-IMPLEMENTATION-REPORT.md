# Nexus plugin-first P2-B1 implementation report · Secure host and managed-admission prerequisites

Builds on the [P1](NEXUS-PLUGIN-FIRST-P1-IMPLEMENTATION-REPORT.md) and [P2-A](NEXUS-PLUGIN-FIRST-P2A-IMPLEMENTATION-REPORT.md) reports, the [architecture](NEXUS-PLUGIN-FIRST-ARCHITECTURE.md), [roadmap](NEXUS-PLUGIN-FIRST-MIGRATION-ROADMAP.md) and [CLI contract](NEXUS-CLI-CONTRACT.md). Branch `feature/nexus-plugin-first-p1` (base `dev` @ `7448ac9a`), all P1/P2-A changes preserved, **nothing committed**; new `config/nexus/*` files are staged only because the closure tool refuses untracked closure files. Pinned DSH `0.2.2-rc.1` (`66491b05`) unmodified.

**Verdict in one line:** single-host ownership is now enforced and proven with real processes, the read-only CLI and authenticated IPC work end to end, and agent effects, approvals and questions of managed sessions are prevented on the real host — but **`nexus submit` is NO-GO**: several owner-peer mutations of a managed session cannot be authorized per session through any supported DSH 0.2.2 seam (§3, §4), and durable intake / the approval broker are only contract models.

## 1. Implemented source changes

| File | Change |
|---|---|
| `config/nexus/controller.cjs` | Host core created with `enforceOwnership: true`: a host that does not hold the installation lock (pending, contended, unavailable) is not an authority — bridges resolve `nexus-host-ownership-<state>`, binding writes are refused, readiness is false, IPC is not started. Bounded acquisition retry (5 attempts, 1.5 s total) so a launcher probe can never displace a starting host; no self-promotion after contention. `peek()` for bridge attachment (registration, not authority). Admission: subagent-lineage inheritance (`origin: 'subagent'` + `parentSession`), `approvalOutcome`, `questionRefusal`, `recordOwnerMutation`/`reconciliationLog`. Host listeners (all `prepend`): `agent/pre-step` (effect gate), `approval/request` (answered `rejected` for managed sessions before the Web remote forwarder), `user-questions/request` (refused `NO_PROVIDER`), `session/event` (post-commit reconciliation of owner mutations: rename/`session/title`, preset/model selection, queue updates, aborted turns). Workspace authorizer backed by DSH `workspaceRegistry.resolveByPath`. IPC server lifecycle; transport state in readiness. |
| `config/nexus/ipc.cjs` (new) | Authenticated local task transport (§5). |
| `config/nexus/task-api.cjs` | Async; principals `internal` (host code) or `local-owner` (IPC-derived, `tasks:read`); server-side workspace authorization (unregistered/foreign → `NOT_FOUND`, concealed); `hello` reports ownership state/generation and transport. |
| `config/nexus/intake.cjs` (new) | **Inactive** contract models for durable intake and the interaction broker (§6). |
| `config/AihController.cjs` | Passes the whole session (header) to admission checks; attaches via `peek()`. No other behavior change (traces identical). |
| `scripts/NexusHostProbe.cjs` (new) | Non-blocking ownership probe (`free`/`owned`/`unavailable`). |
| `scripts/Startup.ps1` | `Get-AihHostOwnership` (strict-mode-safe parsing; a probe bug that would have reported a live owner as `unavailable` was found and fixed by the real-host test). |
| `scripts/aih.ps1` | Pre-spawn election: refuse if any live host owns the installation (covers a different `AIH_PORT`); unusable probe → warning (the host still enforces). Pre-READY: the started process must be the lock holder, otherwise FAILED and the started process is stopped. `OwnershipEvidence` in state. |
| `scripts/Stop.ps1` | Records `OwnershipAfterStop`; warns if another host still owns the installation. Never deletes locks. |
| `scripts/Verify-NexusComposition.mjs` | Boots the real composition over a **private thin root** (installed dirs linked in place, private `data/` with the generated patch and host-row assets, `NEXUS_IPC=0`) so verification never competes with a live host's lock; requires ownership `held` and `enforced`. |
| `scripts/nexus-cli.cjs` (new) | Read-only CLI subset (§5); mutating commands validated then refused (exit 4). |
| `scripts/Test-Harness.ps1` | Registers `NexusHostEnforcement`, `NexusIpc`, `NexusCli`, `NexusIntakeContract`. |
| Tests | New: `NexusHostEnforcement.Tests.mjs` (+ `tests/lib/BootNexusHost.mjs`), `NexusIpc`, `NexusCli`, `NexusIntakeContract`; extended `NexusOwnerPeerGuard` (full matrix); P2-A tests updated to wait for ownership before asserting authority (semantics changed by design) and to assert enforcement. |

## 2. Owner-peer mutation coverage matrix (pinned DSH 0.2.2)

Dispositions: **Prevented** (Controller refuses before effect), **Authorized delegation** (allowed because it creates independent ordinary state), **Reconciliation-only** (DSH commits; the Controller observes and must reconcile), **Unresolved** (no supported seam; blocks managed admission). Evidence: `evidence/p2b1/owner-peer-matrix-real-host.json` (real HTTP owner peer on the pinned Web host, full production composition, 0 model requests across all rows).

| Path (owner peer) | Disposition | Evidence |
|---|---|---|
| `session/prompt` queue and steer | **Prevented** (every `agent/pre-step` refused) | Real host: steps refused, 0 model requests, 0 controller CLIs. |
| Queued-input edits `session/updateQueue` | **Prevented at effect** (edited input can only run through `agent/pre-step`); the edit itself is unresolved | Real host: no pending item to edit (steps never run); effect path proven via prompt rows. |
| Direct agent execution by host code, schedule `run`, resume + prompt | **Prevented at effect** (same seam) | By construction; not individually exercised. |
| Subagent children / subagent `prompt` | **Prevented** (lineage: `origin: 'subagent'` inherits managed status for effects, approvals, questions) | Unit on DSH header semantics; real child spawn needs inference (not run). |
| `approval/request` answers (`$events/result`) | **Prevented**: Controller answers `rejected` before `dsh-api-remotes` forwards to peers | Real host: `approval.decide` on the live managed agent → `rejected`, answered by Nexus. |
| `user-questions/request` answers (`attachWait`) | **Prevented**: Controller refuses (`NO_PROVIDER`) before any answerer | Real host: `userQuestions.ask` → `NO_PROVIDER`. |
| `session/rename` | **Reconciliation-only** (cosmetic) | Real host: committed; `session/title` recorded as `rename`. |
| `session/cancel` | **Reconciliation-only** (aborted managed turn recorded as `cancel` → future `interrupted`) | Real host: accepted while idle (no-op); aborted-turn observation unit-level only. |
| `session/selectModel` | **Prevented at effect**; selection history itself unresolved | Real host: refused here by DSH (`model-unavailable` in the fixture) — inconclusive for acceptance. |
| Agent preset select | **Prevented at effect** (engine immutability rejects next step); selection itself unresolved | Existing engine-binding tests; not exercised over HTTP. |
| `session/fork` | **Authorized delegation** (fork has no subagent origin → independent ordinary session) | Unit on header semantics; real-host fork refused by DSH in this fixture (no completed turn). |
| `workspace/archiveSession` (stops turn, subagents, jobs, schedules) | **Unresolved**: committed, and archive itself leaves no session event to reconcile | Real host: archived; not observed by the Controller. |
| Workspace create/rename/delete/insertSessionBefore/pin | **Reconciliation-only** (organizational, not task authority) | Source-level. |
| Terminal `attach` (PTY input), `cordis-host-runner invoke`, liveshare, file upload | **Unresolved / owner capability**: can mutate the workspace or run host code outside task scope | Source-level; not exercised. |
| Job `kill`, schedule `create/edit/deleteInactive` | **Unresolved** (job kill can stop task-owned work; schedules can enqueue prompts — those prompts are prevented at effect) | Source-level. |
| Ordinary legacy sessions | Unchanged | Real host: bridge still runs its controller CLI; parity traces identical. |

**Not interceptable by any supported seam** (gateway skips `remoteAccess.decide` for owners; `connection/request` sees no body; WebSocket mux bypasses `connection/request`; no per-method waterfall): updateQueue/selectModel/preset-select commits, archive, job kill, schedule create/edit, terminal input, host-runner invoke.

## 3. Required upstream change (proposal, not applied)

**Problem (source evidence).** `dsh-api-gateway` `prepareInvocation` (installed `lib/index.js` lines 1200–1221; upstream `packages/api/gateway/src/index.ts` around the owner branch referenced in the architecture §3) computes resources and calls `ctx.remoteAccess.decide` **only when `peer.principal.kind !== 'owner'`**. Browser and launch-token peers are owners (`dsh-client-connection` `publishPeer`). The `/api` channel allows exactly one interceptor (`registerInterceptor` throws on a second). Hence no supported per-call authorization exists for owner calls.

**Smallest change (option B).** Add one documented, per-operation authorization waterfall evaluated for **every** principal after argument validation and before receiver resolution:

```ts
// in prepareInvocation, after `validated` and before resolveReceiverContext:
const resources = callResources(this.ctx.typert, this.resourceReaders(descriptor), descriptor, validated, signal)
const verdict = await this.ctx.waterfall('gateway/authorize',
  { principal: request.peer.principal, action: `${descriptor.namespace}/${descriptor.method}`, resources, args: validated, transport },
  () => request.peer.principal.kind === 'owner' ? { kind: 'allow' } : this.ctx.remoteAccess.decide({...}))
if (verdict.kind === 'deny') throw new RemoteError('remote-access/denied', ...)
```

- Default behavior is byte-for-byte unchanged (owners allowed, non-owners through `remoteAccess.decide`) when no listener is registered.
- Must cover unary HTTP **and** stream-mode invocations (`openStream` shares `prepareInvocation`), plus `$events/result` (currently answered in `dispatchRpc` before `prepareInvocation`) — that path needs the same hook or an equivalent check.
- Resource readers already exist for session-scoped methods; methods without readers (terminal, host-runner, schedule) need `resources` declarations so a listener can scope them.
- Nexus would register one host listener: deny or delegate to the Controller for any action whose resources include a managed session (or its subagent lineage), allow everything else (legacy GUI unchanged).

**Required tests (upstream + Nexus):** owner denied for each managed-session endpoint (unary and stream), non-owner path identical to today, no-listener default identical, `$events/result` covered, listener exceptions fail closed, performance budget per call. **Upgrade implications:** a new public hook in the pinned RC → Nexus must pin the DSH version that ships it, keep the composition test that asserts the hook is present, and refuse managed admission on hosts without it. Alternatives evaluated: **C** (separate non-owner principal for the CLI) does not stop the browser owner; **D** (managed sessions in a separate, gateway-less DSH host/store) avoids the bypass but contradicts the approved single shared host and doubles writers — rejected; **A** (supported seams only) is what P2-B1 implemented, and it leaves the rows marked Unresolved. No monkey-patch was added.

## 4. Single-host ownership proof

| Property | Proof |
|---|---|
| One authoritative host per canonical installation/store | `NexusHostEnforcement` (real pinned hosts): host A `held`, ready, writes bindings; host B on a **different port, same data root** → `contended`, not ready, bridges resolve `nexus-host-ownership-contended` (every turn refused), binding write `binding-writer-detached`, no IPC. |
| Real cross-process exclusion, no TTL/PID takeover | Kernel `flock` (DSH's pinned addon) with inode re-check; `NexusHostOwnership` (child holder excludes parent; SIGKILL releases; symlink alias contended). |
| No second authorized binding writer | Store refuses writes unless ownership is held (enforced core); verified on host B. |
| Ownership across launcher exit | Lock lives in the detached host process; the launcher only probes. |
| Shutdown and release | Clean `exit` releases; descriptor removed by its own generation only (`NexusHostEnforcement`). |
| Recovery after host death | After SIGKILL of A, probe reports `free`; a newly started host C acquires; refused host B never self-promotes (explicit restart only). |
| Refusal on contention or uncertainty | `contended`/`unavailable`/pending → not an authority. Launcher refuses a second start when the probe sees a live owner, and fails READY if the started process is not the owner. |
| Independent installations | Lock and IPC endpoint derive from the canonical data root; nothing shared across roots. |
| Verification does not compete | `Verify-NexusComposition` boots on a private thin root (installer run verified `ok: true`, ownership `held`/`enforced`). |
| Launcher primitive | `Get-AihHostOwnership` returns the live owner's pid in the real two-host test. |

## 5. IPC and task API contracts implemented

- **Transport** (`config/nexus/ipc.cjs`, POSIX only): private socket under `/tmp/nexus-ipc-<uid>/` (0700, owner, not a symlink; widened/squatted dir refused), socket 0600, name derived from the canonical data root (AF_UNIX length safe); per-generation 32-byte capability in `data/routing/nexus-ipc.cap` (0600); discovery `data/routing/nexus-ipc.json` (informational). Mutual HMAC-SHA256 challenge-response over fresh nonces bound to role, protocol `nexus-task-ipc/1` and host generation; constant-time compare; 5 s handshake deadline; refusal flushed then socket closed. Started only by an owning host; stopped and files removed at disposal.
- **Envelope:** NDJSON, ≤ 2 MiB per frame; `{ schemaVersion: 1, requestId, operation, input }` strict (unknown envelope/input fields, client-supplied principals, unknown operations → `USAGE`; other majors → `PROTOCOL_UNSUPPORTED`). Responses `{ schemaVersion: 1, ok, requestId, data | error{code,message,retryable} }`.
- **Operations:** `hello`, `listModes`, `getStatus`, `getResult`, `follow` (read-only); `submit`, `cancel`, `respond` → `REQUIRED_CAPABILITY_UNAVAILABLE`. No DSH operation is dispatchable.
- **Principal:** server-derived `local-owner` with `tasks:read`; task reads require the task's workspace to be registered in the host's DSH workspace registry, else `NOT_FOUND`. A non-owning host answers `HOST_NOT_READY`.
- **CLI** (`scripts/nexus-cli.cjs`): `host status`, `modes`, `status`, `result`, `wait [--timeout]` with v1 JSON envelopes and exit classes (0/2/3/4/5/6/7/8); installation discovered from the script's own location only. `submit`/`run` validate workspace, mode, idempotency key and prompt (exactly one source; no-follow open with descriptor re-check; 256 KiB bound read limit+1; strict UTF-8; one BOM removed; NUL and blank rejected; SHA-256 digest) and then refuse with exit 4; `cancel`/`respond`/`workspace add`/`host start` likewise.
- **Contract amendments (justified):** (1) `host start` is unavailable in this phase (the approved launcher `aih` remains the only start path); (2) POSIX IPC endpoint lives under `/tmp/nexus-ipc-<uid>` instead of the data root because of the 104-byte AF_UNIX path limit on macOS — ownership and mode checks preserve the contract's owner-only requirement; (3) Windows IPC unavailable until a named-pipe ACL is proven (contract already requires this).

## 6. Approval and durable-intake design (contract models, inactive)

`config/nexus/intake.cjs` (`ACTIVE: false`, no persistence, no wiring) encodes and tests: idempotent reservation scoped per principal (same payload replays the original identities, different payload → `IDEMPOTENCY_CONFLICT`); acceptance only after exactly one durable, flushed and read-back DSH user message carrying the reserved request id (duplicates park); restart reconciliation for every crash window (deliver only when never admitted; park when the input was claimed, a turn started, evidence is unreadable or duplicated); interaction broker with first-valid-response, duplicate-same-decision receipts, stale revision/expiry/foreign task/principal mismatch refusals and "silence never approves". The live gates already enforce the disabled state on the real host (approvals rejected, questions refused). Activating any of this requires a Controller-owned durable intake partition (idempotency + delivery only, no task state), exact-session creation through `ctx.agents.create` with pre-publication setup, and proof of the restored-inbox wake path — all P2-B2.

## 7. Tests and results

All runs: APFS clones of the isolated test installation, closures and patch regenerated inside the clone (installer verification `ok: true`, ownership `held`/`enforced`), private `HOME`/`TMPDIR`, synthetic PowerShell host or dead `HTTPS_PROXY`, placeholder key, no paid call, ports 3080/3081 and both running Nexus instances untouched. Commands: `pwsh scripts/Test-Harness.ps1 -InstallRoot <clone> -Lane production -ContinueOnFailure`; single suites with the pinned `runtime/node/bin/node tests/<Suite>`.

**Production lane** (evidence `evidence/p2b1/production-lane-p2b1.json`):

| Lane | Rows | Pass | Assertions passed / failed | Failing rows |
|---|---:|---:|---:|---|
| pre-P1 | 106 | 104 | 3,250 / 2 | `ContextRestrictedProductionV2`, `Harness` (pre-existing, environmental) |
| P2-A | 113 | 111 | 3,307 / 2 | same two |
| **P2-B1 (final run)** | **117** | **114** | **3,329 / 3** | same two + `NexusHostOwnership` (**test race, fixed**) |

Failure classification during P2-B1:

| Run | Row | Classification | Resolution |
|---|---|---|---|
| Installer verification | composition `ok: false` | **Introduced**: bridges attached through the authority check, which refuses while ownership is pending | Attachment uses `peek()` (registration only); turns and writes still require ownership. |
| Real-host owner-peer | readiness asserted before ownership settled | Test timing (semantics changed by design) | Wait for ownership, assert `held`. |
| `NexusHostEnforcement` | launcher primitive reported `unavailable` for a live owner | **Introduced product bug** (strict-mode property read in `Get-AihHostOwnership`) | Fixed; primitive now reports the owner. |
| First P2-B1 lane | `NexusIntakeContract` | **Introduced**: inactive module not in any closure | Listed as a host-closure entry. |
| First P2-B1 lane | `ControllerSessionBootstrap` | Test timing: crash child called `prepareSession` before ownership | Child waits for ownership (as a real host). Passes (32 checks). |
| Final lane | `NexusHostOwnership` | **Test race**: the test started a second host before the first had acquired; either may legitimately win | Wait for the first host; 5/5 consecutive passes afterwards. A full lane was not re-run for this test-only change. |
| P2-A tests (`NexusControllerCore`, `NexusBindingAuthority`, `NexusHostOwnership`) | assumed authority immediately after host load / unenforced ownership | Semantics changed by design | Wait for ownership; assert enforcement. Safety assertions unchanged. |

**New and extended suites** (all in the production lane):

| Requirement | Suite | Result |
|---|---|---|
| Competing hosts, different ports, same data root | `NexusHostEnforcement` (real pinned hosts) | pass |
| Cross-process contention and crash recovery | `NexusHostEnforcement`, `NexusHostOwnership` | pass |
| Owner-peer bypass attempts | `NexusOwnerPeerGuard` (13-row matrix, real host) | pass; dispositions §2 |
| Missing or unloaded Controller | P1 B1/B2, `NexusBindingAuthority` remount, host B in enforcement test | pass |
| Unauthorized IPC clients | `NexusIpc` (wrong/widened capability, unauthenticated request, squatted dir) | pass |
| Host generation changes | `NexusIpc` (capability rotation, stale descriptor) | pass |
| GUI/CLI principal mismatch | `NexusIpc` (client-supplied principal refused), `NexusIntakeContract` (broker) | pass |
| Stale session and task revisions | `NexusBindingAuthority`, `NexusIntakeContract` | pass |
| Restart during partial admission | `NexusIntakeContract` (six crash windows) | pass (contract model) |
| Incorrectly reported acceptance or completion | `NexusIntakeContract`, `NexusCli` (non-terminal `result` exits 7; completion only from ledger), `NexusTaskApi` | pass |
| Untrusted prompt and workspace paths | `NexusCli` (symlink, dir, size, UTF-8, NUL, blank, BOM, missing workspace) | pass |
| No additional inference or PowerShell calls in EMv1/EMv2 | `NexusControllerBridge` traces pre-P1 vs P2-B1 identical (`evidence/p2b1/bridge-trace-p2b1.json`); 0 model requests in all real-host suites | pass |

**Performance** (`evidence/p2b1/controller-overhead.json`, synthetic transport): host core 0.94 ms / ~62 KiB; root-turn admission pre-P1 → P2-B1 Muse p95 148.7 → 140.2 ms, Dual p95 185.2 → 176.3 ms (noise-dominated; P2-B1 adds no per-turn work beyond in-memory checks); controller CLIs per turn unchanged (Muse 4, Dual 5).

Out-of-lane, pre-existing and unchanged: `RegistryR631Lockdown`, `RegistryR632Execution`, `RegistryR74RollbackRecovery` (red on the baseline; see the P1 report).

## 8. Cross-platform coverage

| Cell | macOS arm64 | Linux aarch64/x86_64 | Windows |
|---|---|---|---|
| Ownership lock (flock / semaphore) | **Pass** (real processes, real hosts) | Not run (same POSIX code; DSH ships glibc/musl addon) | **Unverified**: semaphore path untested; with enforcement on, a failing mechanism makes the host refuse all engineering turns — Windows run is a release blocker |
| Launcher election (`aih.ps1`, `Get-AihHostOwnership`) | Primitive verified with pinned pwsh 7.5.3 against real hosts; full `aih` launch not executed | Not run | Not run |
| IPC transport | **Pass** | Not run | **Unavailable** by design (no proven pipe ACL) |
| CLI read-only commands | **Pass** | Not run | Not run (transport unavailable) |
| Owner-peer matrix | **Pass** (real host) | Not run | Not run |

## 9. Remaining managed-admission blockers

1. **Owner-peer per-session authorization** for: queue edits, model/preset selection, archive, job kill, schedule create/edit, terminal input, host-runner invoke, `$events/result` (currently prevented only because approvals never reach peers). Requires the upstream hook in §3 (or an explicit, approved policy accepting specific rows as owner maintenance with reconciliation).
2. **Reconciliation completeness**: archive leaves no session event; cancel-of-running-turn observation is unit-level only.
3. **Durable intake** (Controller-owned partition, exact session creation, flush/read-back, restart reconciliation) — contract model only.
4. **Approval broker** delivering requests to authorized GUI/CLI clients with revisions — contract model only (current live behavior: managed approvals rejected).
5. **Windows**: ownership mechanism and named-pipe IPC unverified/unavailable; Linux cells not run.
6. **Launcher end-to-end**: full `aih` start/stop race with two launchers not executed (primitive and host-level enforcement are proven).

## 10. Rollback

1. Uncommitted: restore `config/AihController.cjs`, `config/nexus/{controller,task-api}.cjs`, `scripts/{aih,Startup,Stop}.ps1`, `scripts/Verify-NexusComposition.mjs`, `scripts/Test-Harness.ps1` and the four edited tests to their P2-A content; remove `config/nexus/{ipc,intake}.cjs`, `scripts/{NexusHostProbe,nexus-cli}.cjs` and the new tests (`git rm --cached` for staged files).
2. Data: no schema change. New files: `data/routing/nexus-ipc.{json,cap}` (removed on clean shutdown), `/tmp/nexus-ipc-<uid>/*.sock`; P2-A's `nexus-host.lock` (empty) remains harmless.
3. Emergency: there is deliberately **no** runtime switch to disable ownership enforcement. Rolling back means reinstalling the P2-A revision (closures and patch publish atomically).

## 11. GO/NO-GO for activating `nexus submit`

**NO-GO.** What is proven: one enforced host per installation with real processes; agent effects, approvals and questions of managed sessions prevented on the real host; authenticated read-only IPC and CLI; EMv1/EMv2 unchanged. What blocks activation: (1) owner-peer mutations without a supported per-session seam (queue edits, model/preset selection commits, archive, job kill, schedule create/edit, terminal input, host-runner invoke) — needs the upstream `gateway/authorize` hook in §3 or an explicit policy decision per row; (2) archive is not observable for reconciliation; (3) durable intake and the approval broker are contract models only; (4) Windows ownership/IPC and Linux cells are unverified; (5) the full two-launcher `aih` race was not executed end to end. Read-only CLI commands working does **not** make the CLI feature GO. P2-B2 was not started.
