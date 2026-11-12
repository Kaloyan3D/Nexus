# Nexus plugin-first P2-B2A report · DSH authorization boundary

Continues the [P1](NEXUS-PLUGIN-FIRST-P1-IMPLEMENTATION-REPORT.md), [P2-A](NEXUS-PLUGIN-FIRST-P2A-IMPLEMENTATION-REPORT.md) and [P2-B1](NEXUS-PLUGIN-FIRST-P2B1-IMPLEMENTATION-REPORT.md) reports. **Result:** a 91-line, opt-in, deny-wins `gateway/authorize` hook in DSH's API gateway closes every owner-peer mutation path that reaches the gateway; with a test-only Nexus policy it refused **28/28** protected operations on a real pinned host with byte-identical before/after state, while ordinary sessions kept working. It does **not** cover ten Connection fetch routes, raw web routes, in-process host code, or managed status across restarts — those have explicit Nexus-side or P2-B2B dispositions (§3, §8). The production dependency was **not** changed.

## 1. Revisions and isolated setup

| Item | Value |
|---|---|
| Nexus | `feature/nexus-plugin-first-p1`, base `dev` @ `7448ac9a`, all P1/P2-A/P2-B1 work preserved, nothing committed (new `config/nexus/*` staged only for the closure tool). |
| DSH | `dsh-v0.2.2-rc.1` = `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. Upstream TypeScript of `packages/api/gateway/src/index.ts` fetched read-only at that commit for the proposal diff. |
| Prototype | Disposable APFS clone of the isolated test installation (`<scratch>/poc/root`). Only **its own copy** of `@deepseek-ai/dsh-api-gateway/lib/index.js` was edited (SHA-256 prefix `5e48ef…`); the test installation and every Nexus clone keep the pinned file (`91abae…`, verified). Nothing was vendored into Nexus. |
| Test hygiene | Private thin install roots (installed dirs linked, private `data/`), private `HOME`/`TMPDIR`, synthetic PowerShell host, `llm/stream` blocked and counted, placeholder key, dead proxy, ports 3195/3196 for launcher races; the user's instances on 3080 (pid 96363) and 3081 (pid 73608) verified untouched. |

**Step 0 — P2-B1 lane re-run (fresh isolated root, before any P2-B2A change):** 117 rows, **115 pass**, 3,330 assertions; failures only `ContextRestrictedProductionV2` and `Harness` (pre-existing). The corrected `NexusHostOwnership` **passes inside the full lane** (`evidence/p2b2a/production-lane-p2b1-confirm.json`).

## 1a. Nexus source changes in P2-B2A

| File | Change |
|---|---|
| `scripts/Startup.ps1` | `Enter-AihLaunchLock` cross-process launcher mutex (kernel-held exclusive open, released on exit/crash). |
| `scripts/aih.ps1` | Holds the launcher mutex for the whole run; refuses a launch on a different URL while a verified host for this installation is live. |
| `tests/diagnostics/NexusGatewaySurface.mjs` (new) | Real-host enumeration of gateway endpoints, resource kinds and non-gateway routes. |
| `tests/lib/NexusGatewayPolicy.cjs` (new, test-only) | Managed-session policy for the proposed hook. |
| `tests/NexusGatewayAuthorization.Tests.mjs` (new, prototype-only) | Real-host before/after security proof. |
| `docs/architecture/evidence/p2b2a/*` | Diffs, surface, security evidence, race log, lane summaries. |

No product code depends on the proposed hook; the production DSH dependency is unchanged.

## 2. Real mutation surface (pinned DSH, Nexus composition)

`tests/diagnostics/NexusGatewaySurface.mjs` booted the real composition and enumerated (`evidence/p2b2a/gateway-surface.json`):

- **144 Typert remote endpoints** through the gateway (unary over HTTP `/api/<ns>/<method>`, stream over the `/api/remote.mux` WebSocket), plus gateway-owned `$events` and `$events/result`.
- **Resource attribution** already exists: kinds `session` (resolver: a `sessionId` parameter, `request.sessionId` or a session `address`) and `workspace` (`workspaceId` field); anything else attributes as `global`. Many mutations address an **`agentId`** (`terminal/*`, `commands/execute`, `goals/*`, `userQuestions/answer`, `agentPresets/select`, `fileUploads/upload`, `dynamicCordisRunner/*`) and attribute as `global` — the hook passes the validated arguments so a listener can map `agentId` to its session.
- **Outside the gateway:** 10 Connection exact Fetch routes (owner-only; e.g. `/api/session/uploadFileBinary`, `/api/session.export`, `/api/changes.open`, `/api/present.open`, `/api/file`), raw web routes (Nexus's own `/nexus/*` including `gate-action.json` and `registry/v1/*` mutations, `/open-in-app/*`, `/plugins*`), and in-process host code. The only WebSocket upgrade is the gateway mux (covered).

## 3. Proposed DSH hook

Exact upstream diff: `evidence/p2b2a/dsh-gateway-authorize.ts.diff` (91 changed lines, no new dependency; not compiled here — the prototype equivalent below is what was tested). Prototype diff of the compiled package: `evidence/p2b2a/dsh-gateway-authorize.prototype-lib.diff`.

- **One new event**, `gateway/authorize(request)`, dispatched with Cordis `serial` from a private `authorizeOperation`:
  - listeners return `undefined` to **abstain** or `{ kind: 'deny', reason }` to **refuse**; the first refusal wins regardless of registration order;
  - a throwing listener, or any other return value (including "allow"), **refuses** (`authorization-failed` / `authorization-invalid`) — no listener can allow, skip another listener, or relax anything;
  - with no listener every operation keeps today's behavior.
- **Request** (deep-frozen clone): `principal`, `action` (`<ns>/<method>`, `$events`, `$events/result`), `resources` (as computed by DSH; `undefined` when unattributable), validated `args`, `transport` (`unary` / `stream`).
- **Placement:**
  1. `prepareInvocation` — shared by HTTP unary and WebSocket stream calls — after argument validation and after the existing non-owner `remoteAccess.decide` (which therefore still runs first and cannot be overridden), **before** receiver resolution: a refusal activates nothing. Resources are now computed for owners too.
  2. `dispatchRpc` for `$events/result` (approval/question answers) after the existing peer checks and before `receiveRemoteEventResult`, attributed to the waiting agent's session (`pending.frame.agentId`); an unknown event id is unattributed.
  3. `openWireStream` for `$events` (read; global).
- **Exactly once:** each invocation passes `prepareInvocation` once; no side effect precedes the hook.

## 4. Nexus managed-session policy (test-only)

`tests/lib/NexusGatewayPolicy.cjs` (not used by the product). Reads abstain. With the Controller unavailable or closed, every non-read operation is refused. Operations attributed — by session resource, `agentId`, `childSessionId` or `parentSessionId` — to a managed session or its subagent lineage are refused. Workspace delete/rename are refused while the workspace contains a managed session; ordering and pinning of other sessions abstain. Terminal mutations are refused for any session whose cwd is a managed session's cwd (a PTY can rewrite the task's source snapshot). Host-level mutations (plugin manager, settings, credentials, host runner, schedules, jobs, model discovery, goals) are refused **while any managed session exists** and abstain otherwise, so ordinary maintenance is unchanged. Unattributable mutations while a managed session exists are refused: a missing resource is never permission. The Connection fetch route `/api/session/uploadFileBinary` is guarded through the **existing** `connection/request` seam by its `sessionId` query parameter.

## 5. Real-host security evidence

`tests/NexusGatewayAuthorization.Tests.mjs` on the prototype root, authenticated owner peer (launch-token cookie) over real HTTP plus the gateway's own stream/`$events` entry points with a real owner `Peer`. Every protected row compares a before/after snapshot of: durable session event counts and titles (managed M, unmanaged U in the same workspace, unmanaged U2 elsewhere), the workspace registry (ids, paths, titles, sessions, archive state), job state, the protected task/evidence tree (`.ai-harness`, digest) and the binding document (digest). A row passes only with DSH's own `remote-access/denied` **and** an identical snapshot (`evidence/p2b2a/gateway-authorization-real-host.json`).

| Owner operation | DSH response | Reason | State unchanged | Disposition |
|---|---|---|---|---|
| `session/prompt` — session/prompt (queue) | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `session/prompt` — session/prompt (steer) | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `session/updateQueue` — session/updateQueue | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `session/cancel` — session/cancel | denied-by-hook | `nexus-managed-session` | yes | Prevented (owner cancel of a managed task is refused; cancellation belongs to the Controller task API) |
| `session/rename` — session/rename | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `session/selectModel` — session/selectModel | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `session/fork` — session/fork | denied-by-hook | `nexus-managed-session` | yes | Prevented (forking a managed session would copy managed history into an unmanaged session; policy choice — could be relaxed to authorized delegation) |
| `session/create` — session/create (reuse managed id) | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `workspace/archiveSession` — workspace/archiveSession | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `workspace/pinSession` — workspace/pinSession | denied-by-hook | `nexus-managed-session` | yes | Prevented (attributed to the managed session) |
| `workspace/insertSessionBefore` — workspace/insertSessionBefore | denied-by-hook | `nexus-managed-session` | yes | Prevented (attributed to the managed session) |
| `workspace/delete` — workspace/delete (contains managed) | denied-by-hook | `nexus-managed-workspace` | yes | Prevented (workspace authority) |
| `workspace/rename` — workspace/rename (contains managed) | denied-by-hook | `nexus-managed-workspace` | yes | Prevented (workspace authority) |
| `agentPresets/select` — agentPresets/select | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `commands/execute` — commands/execute | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `goals/create` — goals/create | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `userQuestions/answer` — userQuestions/answer | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `subagents/interruptByParent` — subagents/interruptByParent | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `terminal/create` — terminal/create (managed agent) | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `terminal/create` — terminal/create (unmanaged agent, same cwd) | denied-by-hook | `nexus-managed-workspace` | yes | Prevented (managed workspace protection) |
| `fileUploads/upload` — fileUploads/upload | denied-by-hook | `nexus-managed-session` | yes | Prevented |
| `dynamicCordisRunner/invoke` — dynamicCordisRunner/invoke (host code) | denied-by-hook | `nexus-host-protected-while-managed` | yes | Prevented while managed sessions exist (host-level policy) |
| `pluginManager/setPluginEnabled` — pluginManager/setPluginEnabled (disable Nexus) | denied-by-hook | `nexus-host-protected-while-managed` | yes | Prevented while managed sessions exist |
| `settings/update` — settings/update | denied-by-hook | `nexus-host-protected-while-managed` | yes | Prevented while managed sessions exist |
| `credentials/set` — credentials/set | denied-by-hook | `nexus-host-protected-while-managed` | yes | Prevented while managed sessions exist |
| `schedule/create` — schedule/create | denied-by-hook | `nexus-host-protected-while-managed` | yes | Prevented while managed sessions exist (target not attributable) |
| `schedule/run` — schedule/run | denied-by-hook | `nexus-host-protected-while-managed` | yes | Prevented while managed sessions exist (schedule id not attributable) |
| `job/kill` — job/kill | denied-by-hook | `nexus-managed-session` | yes | Prevented (job request carries sessionId) |
| `$events/result` (approval/question answer) | denied-by-hook (owner Peer, gateway entry point) | `nexus-unattributed-while-managed` | yes | Prevented; attributed answers to a managed agent are refused by session; P2-B1 already keeps managed approvals from reaching peers |
| `terminal/attach` (stream, uplink) | denied-by-hook (owner Peer, gateway entry point) | `nexus-managed-session` | n/a (no side effect possible before receiver) | Prevented |
| `/api/session/uploadFileBinary` (Connection fetch route, not gateway) | HTTP 403 from `connection/request` guard | — | yes | Prevented through the existing supported seam |
| Other fetch routes (`session.export`, `session.markdown`, `file`, `changes.diff/summary`, `plugin-manager/detail-file`) | not guarded | — | — | Read-only — no protection needed |
| `changes.open`, `present.open`, `/open-in-app/open` | not guarded | — | — | Opens a file in a desktop application (owner desktop action, no task/session mutation) — accepted owner capability |
| Nexus `/nexus/gate-action.json`, `/nexus/registry/v1/*` mutations, `/nexus/mode-default.json`, `/nexus/workspace-registration.json` | outside the DSH gateway | — | — | **Nexus-owned**: must consult Controller admission for managed sessions (P2-B2B); no DSH change needed |
| `/plugins*` routes | outside the gateway | — | — | Plugin client assets/events; not a session mutation (re-verify per added plugin) |
| In-process host plugins | outside the gateway | — | — | Trusted host code by design (not a security boundary) |
| Managed status after host restart | — | — | — | **Unresolved in P2-B2A**: registry is in memory → durable registry required (P2-B2B) |

| Scenario | Result |
|---|---|
| Missing listener | Owner rename succeeds exactly as on pinned DSH (state changed) — hook inert. |
| Throwing listener | Every operation refused `authorization-failed` (fail closed). |
| "Allow" listener prepended | Still refused: no listener can allow or skip the Nexus refusal. |
| Concurrent operations | 20 managed renames all refused, 20 unmanaged renames all succeed, managed state unchanged. |
| Stale / unknown session identity | No mutation (`session/not-found`). |
| Approval vs cancel race (managed agent) | Approval answered `rejected` by the Controller (P2-B1 gate); concurrent owner cancel refused by the hook. |
| Stream transport / `$events/result` | `terminal/attach` (uplink, stream) refused; unattributed event answer refused. |
| Mixed managed/unmanaged | Same- and other-workspace unmanaged renames succeed; terminal for an unmanaged session in another workspace not refused by Nexus. |
| Controller disposal | Every non-read operation refused `nexus-controller-unavailable`; reads served. |
| Restart and replay | Session history persists, but the session is **no longer managed** after restart — the managed registry is in memory (P2-B2B prerequisite). |
| Model requests | 0 in the whole suite. |
| Archive during active managed work | Not exercisable: managed sessions cannot run work while admission is disabled; archive of the managed session is refused (row above). |

## 6. Other required validation

**Full `aih` two-launcher race** (real `scripts/aih.ps1` processes with pinned PowerShell 7.5.3, disposable installation, ports 3195/3196; evidence `evidence/p2b2a/aih-launcher-race.log`):

| Run | Result |
|---|---|
| First race (P2-B1 launcher) | One host, but **defect found**: both launchers passed the pre-spawn probe and both spawned; the loser's host was correctly refused and stopped by its launcher, but the shared `aih-state.json` was overwritten by the loser's FAILED record, so `aih-stop` targeted the dead pid and left the real owner running untracked; later launches refused until a manual kill. |
| Fix 1 | `Enter-AihLaunchLock` (Startup.ps1): kernel-held exclusive open of `data/routing/aih-launch.lock` for the launcher's whole run (verified: second process refused, released on exit and on SIGKILL). |
| Second defect, fixed | The waiting launcher (other port) "resumed readiness" on its own port for 120 s and rewrote state to STARTING. Fix 2: a live verified host serving another URL is refused explicitly ("already running for this installation at <url>"). |
| Five races after both fixes | Every round: exactly **one** host process, winner READY, loser waits on the mutex then refuses without spawning, state file = real owner pid and URL, stop releases ownership (`free`). |
| Host death and restart | SIGKILL of the owner → kernel releases ownership (`free`), stale READY state remains; the next `aih` reclassifies it and starts a new owner (READY); stop releases. |

Single-host ownership across host death/restart is therefore re-verified with the real launcher, in addition to P2-B1's direct two-host test. Read-only CLI and authenticated IPC are unchanged (their suites are in the lane below).

## 7. Regression results

| Lane (isolated installed clone, `Test-Harness.ps1 -Lane production`) | Rows | Pass | Assertions | Failing rows |
|---|---:|---:|---:|---|
| P2-B1 confirmation (before P2-B2A changes) | 117 | 115 | 3,330 / 2 | `ContextRestrictedProductionV2`, `Harness` (pre-existing) |
| **Branch with P2-B2A launcher fixes** (pinned DSH) | 117 | **115** | 3,330 / 2 | same two |
| **Prototype root: DSH gateway with the hook, no listener** | 117 | **115** | 3,330 / 2 | same two — identical row for row: the inert hook changes no existing behavior |

The lane includes every P1/P2-A/P2-B1 suite (bridge parity, binding authority, host ownership/enforcement with real hosts, IPC, CLI, intake contracts, owner-peer gate, launcher lifecycle suites `StartupLifecycle`/`PlatformDetachedLifecycle`, composition, compaction and CCv2 restriction suites). `NexusGatewayAuthorization.Tests.mjs` (11 groups, all passing) is **not** in the lane because it requires the prototype hook; on pinned DSH it fails by design (hook absent). Out-of-lane `RegistryR631/R632/R74` remain red as on the baseline. Evidence: `evidence/p2b2a/production-lane-*.json`.

## 8. Deployment comparison and upstream verdict

| Option | Assessment |
|---|---|
| **A. Version-pinned compatibility patch** (apply the diff to the installed `dsh-api-gateway` at install time) | Works today (prototype). Cost: Nexus owns a patch of DSH's security boundary; install-time integrity checks (file digest before/after), refusal to admit managed sessions when the hook is absent, re-validation on every DSH upgrade (the patched function bodies changed in recent RCs), and the DSH composition tests in §7 on every platform. Rollback: reinstall the unpatched package (closures publish atomically); managed admission must refuse without the hook. |
| **B. Upstream contribution** | Preferred end state: same 91-line change, owned and tested upstream (upstream test list: owner and non-owner reach the hook for unary, stream, `$events/result`; no-listener parity; deny-wins/order independence; throwing listener fails closed; legacy deny not relaxable; no side effect before refusal; per-call overhead). Nexus then pins the first DSH release that ships it and asserts its presence at startup. |
| **C. Different managed-session composition** (separate gateway-less DSH host/store for managed sessions) | Avoids the owner peer but contradicts the approved single shared host, duplicates session stores/writers, and splits GUI visibility — rejected. |

**Is an upstream change unavoidable?** Yes for the gateway paths: pinned DSH offers no supported per-call seam for owner principals (P2-A/P2-B1 evidence), and the prototype shows the smallest change that provides one. The remaining non-gateway paths need no DSH change: fetch routes via `connection/request` (path + query), Nexus routes inside Nexus, host code is trusted by design.

## 9. Remaining blockers

1. **DSH hook not shipped**: requires either upstream acceptance (B) or an explicitly authorized pinned patch (A).
2. **Durable managed registry**: managed status must survive host restart (owned by the P2-B2B durable intake partition); today it is in memory.
3. **Non-gateway surfaces**: guard the other Connection fetch routes that can mutate managed sessions (only `uploadFileBinary` is mutating among the ten; it is guarded in the test policy via `connection/request`), and route Nexus's own `/nexus/gate-action.json` and registry mutation routes through Controller authorization for managed sessions.
4. **Production policy**: the test-only policy must become a product listener with an agreed host-level policy (which owner maintenance is blocked while managed tasks exist) and its UI explanation.
5. **Platforms**: all evidence is macOS arm64. Linux and Windows not run (Windows ownership mechanism and IPC remain unverified/unavailable from P2-B1).

## 10. GO/NO-GO for applying the DSH compatibility change

**GO for the hook design and for pursuing it upstream (option B). NO-GO for applying a pinned compatibility patch to Nexus production now (option A).**

- The design is proven: smallest change (91 lines, one event, no new dependency), inert without listeners (identical 117-row lane), owner and non-owner both reach it on unary, stream and `$events/result`, deny-wins/order-independent, fail-closed, cannot relax DSH's own decision, no side effect before refusal, 28/28 real-host refusals with unchanged durable state.
- Applying it to production now buys nothing: managed admission still needs the durable managed registry, Nexus-route guards and the production policy (§9), so a patched security boundary would be carried without being used. Ship it when P2-B2B is ready — preferably from an upstream DSH release; only if that is unavailable in time, as an explicitly authorized, digest-checked pinned patch with the safeguards in §8 (installer verifies the patched digest and the presence of `gateway/authorize` at startup; managed admission refuses when absent; the gateway lane above runs on every platform and DSH upgrade).
- Upgrade impact: any DSH bump must re-run `NexusGatewaySurface.mjs` (new endpoints, new resource kinds, new non-gateway routes) and `NexusGatewayAuthorization`; a pinned patch must be re-based whenever `prepareInvocation`/`dispatchRpc` change upstream.

## 11. Prerequisites for P2-B2B (durable intake) and active CLI submission

Before P2-B2B durable intake may begin implementation:
1. Decision between upstream hook (B) and an authorized pinned patch (A), including who maintains it.
2. Production `gateway/authorize` listener derived from the test policy, with the host-level maintenance policy agreed (what owners may still do while managed tasks exist) and surfaced in the UI.

Before `nexus submit` / active CLI submission:
3. **Durable managed registry** in a Controller-owned intake partition (idempotency, delivery, managed session ids and lineage only — no task state), loaded before the gateway listener serves, so managed status survives restart (today it does not — §5).
4. Durable intake implemented from the P2-B1 contract model: exact session creation via `ctx.agents.create` with pre-publication setup, one durable flushed and read-back input per key, restart reconciliation for each crash window.
5. Approval broker activated (replacing P2-B1's reject-all for managed sessions) with first-valid-response arbitration across GUI and CLI.
6. Nexus routes (`/nexus/gate-action.json`, registry mutations) and the `uploadFileBinary` fetch route guarded for managed sessions in product code.
7. Linux and Windows runs of ownership, launcher mutex, IPC (Windows named-pipe ACL), gateway hook and policy; macOS-only evidence does not establish cross-platform readiness.

P2-B2B was not started.
