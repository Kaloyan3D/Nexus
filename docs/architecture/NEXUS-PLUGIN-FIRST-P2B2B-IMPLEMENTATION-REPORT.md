# Nexus Plugin-First — P2-B2B implementation report: durable managed task admission and the CLI/GUI task lifecycle

Continues the [P1](NEXUS-PLUGIN-FIRST-P1-IMPLEMENTATION-REPORT.md), [P2-A](NEXUS-PLUGIN-FIRST-P2A-IMPLEMENTATION-REPORT.md), [P2-B1](NEXUS-PLUGIN-FIRST-P2B1-IMPLEMENTATION-REPORT.md) and [P2-B2A](NEXUS-PLUGIN-FIRST-P2B2A-REPORT.md) reports. Branch `feature/nexus-plugin-first-p1` (working tree, nothing committed). DSH is pinned at `dsh-v0.2.2-rc.1` (`66491b05`).

**Result.** The full managed-task path is implemented behind fail-closed activation gates:

- a durable Controller-owned intake and managed registry
- exactly-once delivery with crash reconciliation
- step-level admission tickets
- an approval broker shared by GUI and CLI
- product gateway, fetch-route and Nexus-route policy
- active `submit`/`cancel`/`respond` over IPC and a GUI route

The compiled DSH `gateway/authorize` hook was built from source, tested upstream (621/621) and proven on real hosts in a disposable PoC root, where every scenario passed (13/13). On the **pinned production DSH the hook is absent**, so `submit` stays refused with no side effect, proven on a real host.

Two **pre-existing DSH 0.2 durability defects** in the legacy plane were found along the way (§10). One is fixed here. The other blocks cold restore of every first-turn Nexus session and is a prerequisite for production.

**Verdict: GO for a macOS-only internal canary on a PoC root carrying the allowlisted gateway build. NO-GO for production `nexus submit`** until the §12 prerequisites are met.

---

## 1. Files and contracts

| File | Role |
|---|---|
| `config/nexus/intake-store.cjs` (new) | Durable intake partition `<data>/nexus/intake/<sha256(principal\nkey)>.json`. Directory 0700, files 0600, atomic temp+fsync+rename+dir-fsync. CAS state transitions, immutable identities, owner-only writes. The prompt copy is dropped once a record is `accepted`. A corrupt record makes the store `corrupt` and quarantines every session id it names. This store **is** the managed-session registry, loaded synchronously when the Controller core is created. |
| `config/nexus/managed-tasks.cjs` (new) | Intake state machine, delivery verification, startup reconciliation and resumption, admission tickets (`admitStep`, idempotent per turn), turn end, cancel. DSH is reached only through injected ports. |
| `config/nexus/broker.cjs` (new) | Live task-bound operator actions. The first valid authorized answer wins. Duplicates return the original receipt. Stale, foreign, unauthorized and unknown-choice answers are refused. Expiry, abort, cancel and disposal never grant. Only `allow-once` grants. |
| `config/nexus/gateway-policy.cjs` (new) | Product policy for `gateway/authorize`, the Connection fetch-route guard (`uploadFileBinary`) and the `/nexus/*` route verdict. Reason codes are listed in the module header and in §7. |
| `config/nexus/controller.cjs` | Builds the store, broker and engine into the core. Adds activation gates, `admission.admit`, `verifyGatewayHook` (digest allowlist plus live self-test), the DSH ports, policy and fetch guard registered before serving, broker-backed `approval/request` and `user-questions/request`, the workspace exclusivity gate, turn-end tracking, the GUI task route `/nexus/tasks/v1/<op>`, deferred reconcile and resume. Build `nexus-controller-p2b2b-1`. |
| `config/nexus/task-api.cjs` | Operation-scoped capabilities (`tasks:read`, `tasks:submit`, `tasks:cancel`, `tasks:respond`). Adds `submit`/`cancel`/`respond`, managed `nt_` views (intake state overlaid on the TaskController projection, broker actions as `operatorActions`), and truthful `hello`/`listModes`. |
| `config/nexus/ipc.cjs` | Strict input fields for `submit`/`cancel`/`respond`. The local-owner principal now gets all four task capabilities. |
| `scripts/nexus-cli.cjs` | `submit`, `run` (submit then follow), `cancel` and `respond` go to the host only. Generated idempotency keys are surfaced on stderr. Non-interactive follow reports pending actions and exits 7. `--interactive` is refused. `nt_` ids are accepted. |
| `config/AihController.cjs` | The bridge asks the same async ticket (`admission.admit`). Controller notices use the producer-owned source kind `aih-controller` (§10.1). |
| `config/ContextCompaction.cjs`, `config/ContextGenerationRuntimeV2.cjs` | Controller-source readers accept both the `plugin` and `aih-controller` shapes. |
| `ui/nexus-controller/lib/index.js` | Every non-GET Nexus route and `gate-action.json` asks `controller.routeVerdict`. Without a Controller service the routes keep their legacy behavior. The plugin announces its route guard while it and the Controller are both live (an activation gate); contexts without `inject`, such as unit stubs, skip the announcement. |
| `scripts/MusePresetDependencyClosure.cjs`, `scripts/Test-Harness.ps1` | Closure note; two new lane rows. |
| `tests/NexusManagedIntake.Tests.cjs` (new, lane) | 11 groups: store, submit, park, 8 crash boundaries, tickets, commit ordering, cancel, broker races, policy, activation gates, task API end to end. |
| `tests/NexusManagedTasks.RealHost.Tests.mjs` (new, lane in production mode) + `tests/lib/NexusManagedHost.mjs` | Real child hosts, real PowerShell controller scripts, real IPC, the real CLI, the GUI route, a synthetic model transport and test-only crash instrumentation. |
| `tests/NexusTaskApi`, `NexusIpc`, `NexusCli`, `AihController` tests | Updated to the new contracts. |
| `docs/architecture/NEXUS-GATEWAY-AUTHORIZE-COMPATIBILITY-SPEC.md` (new) | Hook contract, integrity verification, absent-hook behavior, gates, upgrade and rollback. |
| `docs/architecture/evidence/p2b2b/*` | Upstream patch, built-lib diff, real-host evidence, compiled-build gateway evidence, lane summaries. |

Stable JSON shapes follow [NEXUS-CLI-CONTRACT.md](NEXUS-CLI-CONTRACT.md) §4. The submit receipt is `{ taskId: "nt_<32hex>", sessionId, status: "accepted", mode, revision, idempotencyKey, replay }`. The managed task view adds `cohort: "managed"` and `intake: { state, acceptedAt, hold }`. `cancel` returns `{ taskId, revision, status, disposition: requested|already_requested|already_terminal }`. `respond` returns `{ taskId, actionId, revision, disposition: accepted|duplicate }`.

## 2. Track A — the compiled DSH hook

| Step | Result |
|---|---|
| Disposable checkout of `66491b05`, `pnpm install --frozen-lockfile --ignore-scripts` (isolated HOME) | ok |
| Upstream gateway and connection suites, unpatched | 27 files, **609/609** |
| Patch applied: `authorizeOperation`, `$events`/`$events/result` presentation, typed denial guard, exported `GatewayAuthorizeRequest`/`GatewayAuthorizeDenial` | `tsc -b` clean |
| New upstream spec `gateway-authorize.host.spec.ts` (12 tests: parity without listener, request shape/frozen/once, owner deny before method, legacy deny first, listener refuses an allowed guest, throw→`authorization-failed`, allow→`authorization-invalid`, order independence, args immutability, HTTP carrier, WebSocket stream `transport:'stream'`, `$events` + `$events/result`, unattributable → `undefined`) | 28 files, **621/621** |
| Upstream toolchain build (`tsc -b` + `tsdown`) of the **unpatched** source | byte-identical to the published lib (`91abae7e…f52b`) |
| Same pipeline, patched | `12e5577b…14c8` (60-line lib diff, `evidence/p2b2b/dsh-gateway-built.lib.diff`) |
| Compiled lib in a disposable PoC root (never the user's runtime): P2-B2A owner-peer matrix | **28/28 refused by the hook**, durable state unchanged. Also covered: fetch upload, stream `terminal/attach`, `$events/result`, mixed sessions, 40 concurrent operations, stale ids, approval/cancel race, throwing listener, disposal (`evidence/p2b2b/gateway-authorization-compiled-build.json`, 11/11 groups) |
| Legacy behavior when unused | Upstream parity test, plus the P2-B2A inert-hook lane (row-identical) |
| Upstream-ready patch | `evidence/p2b2b/dsh-gateway-authorize.upstream.patch` (source and spec). Not pushed, no PR. |

The compatibility and integrity spec is [NEXUS-GATEWAY-AUTHORIZE-COMPATIBILITY-SPEC.md](NEXUS-GATEWAY-AUTHORIZE-COMPATIBILITY-SPEC.md). Nexus verifies **both** the allowlisted digest and a live owner self-test refusal through `typertGateway.invoke`. Anything else leaves admission disabled with a recorded reason.

## 3. Intake state machine

Every state is persisted **before** the externally visible step it guards.

```
reserved ──create exact DSH session (same id; blank reuse ok)──▶ session-created
session-created ──nexus/session-prepare (existing Controller binding path)──▶ bound
bound ──persist intent──▶ delivering ──session.prompt(requestId) + flush + durable read-back──▶ accepted
any pre-delivery failure with no DSH effect ─▶ failed
any doubt about whether work may have run   ─▶ parked (explicit hold, reason recorded)
```

- **Validation.** Principal (host-derived; GUI and CLI share `local-owner`), workspace (must resolve through DSH `workspaceRegistry`), mode (`engineering-v1`→`aih-engineering`, `engineering-v2`→`aih-muse`), profile (the active Nexus profile under the existing precedence, which must match the mode's engine with no cross-engine fallback), prompt (≤256 KiB, UTF-8, no NUL, digest recomputed). The idempotency fingerprint is (principal, workspaceId, mode, promptDigest). A different payload under the same key is `IDEMPOTENCY_CONFLICT`.
- **Acknowledgement.** `accepted` only after the exact request id is found in DSH's durable log after a flush. That means one `agent/inbox/spliced` insertion or one claimed `user/message`. More than one copy parks the intake. DSH's own prompt acknowledgement is never trusted alone.
- **No provider call before commit.** DSH 0.2 hands claimed input to `agent/pre-step` before appending it. The first step's ticket waits for the intake commit, and the unit test proves the order flush → ticket.
- **Admission tickets.** A model or tool step of a managed session runs only when all of these hold:
  - activation is active
  - the intake is accepted
  - the task isn't cancelled or held
  - the step-1 claimed user input is **exactly** the reserved request id (an extra input riding along is refused)
  - no earlier turn of the task executed

  `executionStartedAt` is persisted at admission. Continuation steps and subagent children run only while the admitted turn is live. The host gate and the plane bridge both ask in either order, and the ticket is idempotent per turn.

## 4. Recovery and idempotency evidence

Unit evidence uses synthetic DSH with an explicit flushed prefix (crash drops the unflushed tail). Real-host evidence uses child hosts killed with SIGKILL.

| Crash boundary | Safe outcome | Unit | Real host |
|---|---|---|---|
| After reserve, before session creation | Resumable; delivered once after activation | ✓ | — |
| After durable intent, before DSH write | Proven absent → redelivered under the **same** ids, once | ✓ | ✓ one message, one model call, retry returns the receipt |
| Insertion flushed, before ack | Accepted once, then held `restored-input-not-resumed` (never auto-resumed) | ✓ | ✓ held, no model call, retry returns the receipt |
| Turn claimed input, before ack | Held `interrupted` | ✓ | (covered by the row above: either hold) |
| Executing when the host died | Held `interrupted`; no further turn | ✓ | — |
| Unflushed insertion | Proven absent → redelivered once | ✓ | — |
| Unreadable durable log | Held `delivery-evidence-unreadable` | ✓ | — |
| Duplicate durable input | Held `duplicate-input` | ✓ | — |
| DSH session controller missing at delivery time | Stays `delivering` (never attempted), resumed when services return | (real-host regression found and fixed) | ✓ |

Idempotency on the real host: concurrent GUI and CLI submits with one key gave one task, one durable user message and one model request, with identical receipts. A repeated key returned the original receipt with no new message or model call. A different payload gave `IDEMPOTENCY_CONFLICT`. Restart restored the registry and statuses from the intake before the first remote mutation. A tampered record made the store corrupt, deactivated admission and quarantined the session.

## 5. Approval broker

Managed `approval/request` is answered by the host listener (prepended, ahead of DSH's Web remote forwarder) through the broker while the task's turn is live. Choices are `allow-once` and `reject`, and the outcome is `allowed-once` only for an explicit grant. Otherwise the result is `rejected`, or `cancelled` on abort. DSH permissions still decide whether a tool needs approval at all.

`user-questions/request` is supported for **one question with options and no multi-select**, mapped to `{ answers: [{ id, selected: [label] }] }`. Other shapes are refused (`NO_PROVIDER`, `unsupported-question-shape`). That is a documented limitation.

Real-host evidence (real DSH `approval.request` for the managed agent):

- the action appears in both CLI and GUI status (`awaiting_operator`)
- non-interactive `wait` exits 7 and answers nothing
- forged, stale and foreign answers are refused
- of a racing GUI `reject` and CLI `allow-once`, exactly one wins, and DSH receives the winner's outcome
- a pending action survives client disconnects without a grant
- cancel withdraws it as `rejected`

A broker answer cannot complete a task: completion remains the TaskController ledger's `complete`.

## 6. CLI/GUI parity

Both adapters call the same `core.tasks` operations with a transport-derived principal:

- **IPC:** HMAC handshake, owner-only socket.
- **GUI:** `/nexus/tasks/v1/<op>`, `connection.admit` (Host/Origin fence + launch cookie). A forged request without the cookie gets 401.

Both use the same envelope validation (`ipc.validateRequest`). The CLI never writes intake or task state and never invokes legacy TaskController writers itself. Status and result views are identical across adapters (asserted on the real host). The read-only CLI commands are unchanged.

## 7. Security coverage and gaps

| Surface | Disposition |
|---|---|
| Owner-peer gateway mutations of managed sessions and lineage (prompt, queue, cancel, rename, model, preset, fork, create-reuse, archive, delete, pin, `$events/result` for managed agents) | Refused `nexus-managed-session` by the verified hook (real host, compiled build) |
| Workspace delete/rename holding a managed session | `nexus-managed-workspace` |
| Terminals in a live managed task's cwd | `nexus-managed-workspace` (real host) |
| Host maintenance while a managed task is live or pending (plugin manager, settings, credentials, schedules, jobs, model discovery, goals) | `nexus-host-protected-while-active` (real host: `setPluginEnabled`, `settings/update`). Unchanged otherwise. |
| Unattributable mutation while active | `nexus-unattributed-while-active` |
| Controller absent or closed | Every non-read refused `nexus-controller-unavailable` |
| Fetch route `uploadFileBinary` | `connection/request` guard, 403 (real host) |
| `/nexus/gate-action.json` for a managed session; registry, profile and mode-default routes while active | 403 (real host) |
| Ordinary sessions writing into a live or pending managed workspace | Steps refused at `agent/pre-step` (real host: 0 model calls) |
| Unmanaged sessions writing into managed task or authority data | Covered by the workspace gate while the task is live or pending. **Gap:** after the task ends, the workspace is open again. The managed agent itself can still write its own evidence (the gateway hook is not a filesystem sandbox). |
| Owner prompts bypassing the gateway (pinned DSH) | Activation is off, and admission tickets refuse any input that isn't the reserved request id |
| Plugin unload | Route plugin unload detaches its guard and deactivates admission (unit). Controller disposal fails closed (real host, compiled-build suite). |

## 8. OS matrix

| Platform | Evidence | Claim |
|---|---|---|
| macOS arm64 (Darwin 27.2, this machine) | Unit suites, real-host production (fail-closed) and patched PoC (13/13), compiled-build gateway matrix (28/28), full lane | Qualified for the canary (`QUALIFIED_PLATFORMS = ['darwin']`) |
| Linux | Not run in P2-B2B | **Unavailable.** Admission refuses (`platform-not-qualified:linux`). |
| Windows | Not run | **Unavailable.** Admission refuses (`platform-not-qualified:win32`). |

## 9. Regression and real-host results

| Lane (isolated installed clone, pinned DSH, `Test-Harness.ps1 -Lane production`) | Rows | Pass | Assertions pass / fail | Failing rows |
|---|---:|---:|---:|---|
| P2-B2A reference | 117 | 115 | 3,330 / 2 | `ContextRestrictedProductionV2`, `Harness` (pre-existing) |
| P2-B2B first run | 119 | 110 | 3,261 / 9 | baseline two, plus 4 UI-route suites (stub context without `inject`) and `NexusControllerPanel` ×2, `ContextCompactionF2Prod`/`F5Prod` (controller-source readers) — all fixed |
| **P2-B2B final** | **119** | **117** | **3,343 / 2** | baseline two only (`evidence/p2b2b/production-lane-p2b2b.json`) |

The two new rows, `NexusManagedIntake` (11) and `NexusManagedTasksRealHost` (production, fail-closed), pass inside the lane, as do every P1/P2-A/P2-B1/P2-B2A suite (`NexusHostEnforcement`, `NexusIpc`, `NexusCli`, bridge, binding authority, ownership).

Real-host suites: `NexusManagedTasks.RealHost` production **1/1**, patched PoC **13/13**. `NexusGatewayAuthorization` on the compiled build: **11/11** (28/28 rows). `NexusManagedIntake`: **11/11**. The EMv1 and EMv2 managed turns each made exactly one model request through the synthetic transport. No paid inference, no credential, egress blocked.

## 10. Defects found (pre-existing on `dev`)

1. **Retired `plugin` message source kind (fixed).** DSH 0.2's format v4 refuses `source.kind: 'plugin'` on every durable read: cold restore, resume and persistence reads. Nexus controller notices used it, so any session with a notice failed durable reads. Notices, including the bridge's compaction checkpoint message built by `createControllerMessage`, now use the producer kind `aih-controller` (the `plugin` field is kept). Every controller-source reader (`ContextCompaction.cjs` ×3, `ContextGenerationRuntimeV2.cjs`) accepts both shapes, so older logs still match. The first lane run caught exactly this coupling: `ContextCompactionF2Prod` and `F5Prod` failed until the readers were updated. **Not fixed:** the direct compaction and shadow writers (`ContextCompaction.cjs` ~L995/L1021, `ContextShadowV2.cjs` ~L636/L834) still write `plugin`-kind messages. Several compaction test suites assert that shape, so it is left for a dedicated change.
2. **Controller notice before the first system message (not fixed — production blocker).** The bridge appends a surface `user/message` notice (`controller-attempt`) during step-1 pre-step, before DSH appends the first `system/message`. Format v4 then refuses the log ("system/message requires a protected first surface head"). **Every first-turn Nexus engineering session written by DSH 0.2.2 cannot be cold-read or restored after a restart.** Live sessions keep working in memory. Evidence: a decoded real-host log (seq 7 notice before seq 9 system message). The fix needs a product decision about how notices render under 0.2: a non-surface audit event, deferral after the system message, or a DSH notice form. Managed acceptance is unaffected because the commit happens before the bridge runs, but restoring a managed session after restart is affected.

Real-host bugs found and fixed in P2-B2B code:

- the GUI route prefix
- the self-test argument name
- the profile resolver for Muse
- a ticket that checked the log instead of the claimed pre-step input
- bridge-before-host ordering (now an idempotent async ticket)
- resumption when gates complete late
- delivery attempted before DSH services were ready

## 11. Rollback

Every change is in the working tree, and nothing is committed.

- **Code.** Revert the P2-B2B files. Earlier phases are unaffected.
- **Activation.** On production nothing to undo: the hook is absent, so admission was never active.
- **On a canary root:** reinstall the unpatched gateway package, or drop its digest from `GATEWAY_HOOK_DIGESTS`. Admission refuses immediately. Managed sessions stay protected and observable from the durable intake.
- **Data.** Intake records live in `<data>/nexus/intake/`. Removing a record releases its session to ordinary behavior, which is an explicit operator action (no tombstone is kept yet; see §12).

## 12. GO/NO-GO and remaining prerequisites for production `nexus submit`

**GO — macOS internal canary.** This applies to an isolated installation that carries the allowlisted gateway build, installed with explicit authorization. Every activation gate is proven on real hosts, and failure modes are fail-closed holds, never silent loss or duplicate.

**NO-GO — production.** Remaining prerequisites:

1. An upstream DSH release with `gateway/authorize`, or an explicitly authorized digest-checked pinned patch, plus installer integration (digest before and after) per the spec. The production dependency was not modified.
2. Fix §10.2 (first-turn notice ordering) so managed and ordinary sessions survive cold restore. Fix the compaction `plugin` writers from §10.1.
3. A supported operator recovery for held tasks (`restored-input-not-resumed`, `interrupted`): resume or close actions through `respond`. Today they are visible holds with cancel only.
4. Legacy completion through the task API (`run-verification` operator action per the contract). Today a finished managed turn without ledger completion projects `blocked: turn-ended-without-ledger-completion`.
5. Intake retention and tombstones (contract §4: keep key and receipt mappings as long as tasks).
6. Native Linux and Windows real-host evidence before widening `QUALIFIED_PLATFORMS`.
7. Multi-question and multi-select user questions in the broker, or an explicit mode policy that forbids them.
8. Workspace protection after a managed task ends (evidence snapshot isolation beyond the live/pending window).

Nova, Sentry, Studio and the CCv2 replacement are out of scope. P2-B2B stops here.
