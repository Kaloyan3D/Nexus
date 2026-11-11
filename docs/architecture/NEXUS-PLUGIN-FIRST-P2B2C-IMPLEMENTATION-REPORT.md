# Nexus Plugin-First — P2-B2C implementation report: session durability and DSH 0.2 format-v4 compatibility

Continues [P2-B2B](NEXUS-PLUGIN-FIRST-P2B2B-IMPLEMENTATION-REPORT.md). Branch `feature/nexus-plugin-first-p1`. Pinned DSH `0.2.2-rc.1` (`66491b05`). macOS arm64 (Darwin 27.x).

**Verdict: GO for P2-B2C.** Fresh Nexus engineering sessions (Dual and Muse; ordinary and managed) are durably readable and resumable under DSH 0.2.2, with valid event ordering and source kinds. Historical invalid sessions receive an explicit, typed, read-only hold. Managed identities and tombstones survive restarts and record deletion. The standard unpatched DSH still refuses managed submission. Production `nexus submit` remains NO-GO for reasons outside this phase (§14).

---

## 1. Revision and working tree

| | |
|---|---|
| Starting revision | `2070c617318f2c4990307d04100f4d3db08091a7` (clean tree; parent `2d84cc8f`, base `7448ac9a` = `dev`) |
| Final state | Same revision plus the uncommitted changes in §3. Nothing reset, stashed, committed or pushed. |
| Demo archive | `archive/nexus-demo-2026-11` (`75016684`, includes the Codex Sentry experiment). Not used here. |

## 2. Already implemented before this continuation (kept; verified)

- `config/Nexus-MessageSource.cjs`: producer-owned Controller source kind `aih-controller` (the `plugin` field is kept), dual-shape readers, and the protected-head rule.
- First-turn Controller notices are published through DSH's own `agent/pre-step` `enter` decision (after the system head). The durable pending queue covers rejected first turns.
- Every compaction, shadow, CCv2-lab and generation-runtime writer/reader moved to the shared helper. Test fixtures moved to the current shape.
- Identity ledger `<data>/nexus/managed-identities.jsonl` (tombstones). `retire()`. Repair of missing ledger entries.
- `scripts/NexusSessionAudit.cjs`: read-only audit using DSH's own reader on copies.
- First-message model arming for brand-new Muse/Dual sessions: an arm-only provisional selection at `agent/inbox/claimed`, with the guard still verifying the real target.
- CLI: `host start` (login link recovered from the running host's log), `workspace add`, `credentials list/set --stdin/unset`, and Nexus's last reply in `status`/`result`.

## 3. Changes made during this assignment

| Change | Files | Why |
|---|---|---|
| **Historical-session hold** (Task C) | `config/nexus/session-health.cjs` (new), `config/nexus/controller.cjs`, `config/AihController.cjs` | Typed verdicts. The host step gate and the bridge both refuse held sessions before any binding, attempt, notice or model call. The checks are read-only (live log or a DSH persistence READ handle). |
| Held managed tasks never look healthy | `config/nexus/task-api.cjs` | `status`/`result`/`follow` fill the health cache first. A held history projects `blocked` with the typed reason plus `sessionHealth { state, reason, repair }`. |
| Read-only `checkSession` operation and `nexus session check <id>` | `task-api.cjs`, `ipc.cjs`, `scripts/nexus-cli.cjs` | Exit 0 healthy, 7 held, 4 NOT_FOUND. Concealed unless the session's workspace is authorized (record, binding or the session's own cwd). |
| **Orphaned identities reported as a hold** | `task-api.cjs`, `intake-store.cjs` | A task whose intake record was deleted now reports `blocked / intake-record-missing` instead of NOT_FOUND. Ledger identities carry the workspace path for authorization. Cancel on an orphan is refused with the same reason. |
| **Idempotent replay independent of the current profile choice** (defect found by the managed restart test) | `managed-tasks.cjs`, `intake-store.cjs` (`existing()`) | A retry of an accepted Dual task failed with `MODE_UNAVAILABLE` after the operator's profile preference changed. The retry now returns the original receipt. A new submission still needs a resolvable profile. |
| Audit reports the same typed reasons | `scripts/NexusSessionAudit.cjs` | `holdReason` per session. |
| Tests | `tests/NexusDurabilityRestart.RealHost.Tests.mjs` (new; lane, production mode), `NexusSessionDurability` (+1 group), `NexusCli` (+2 groups), `NexusManagedIntake` (replay case), `tests/lib/NexusManagedHost.mjs` (test-only `inject`, opt-in synthetic tool call, `inspect` tool pairing) | Real-host and unit coverage for Tasks B to E. |

## 4. Root causes and resolutions of the two format-v4 bugs

DSH 0.2 format v4 enforces two rules **only when a log is read back** (cold restore, resume, persistence reads): `session-format-v3-to-v4/src/message-sources.ts` and `relationships.ts#foldSurface`. Live append (`Session.commit → SurfaceManager.validateNext`) does not check the protected head, so pre-P2-B2C sessions worked while live and broke at the next restart.

1. **Retired `source.kind: 'plugin'`.** Nexus wrote Controller notices and compaction checkpoints with the catch-all kind that DSH 0.2 retired ("each producer declares its own kind"). Resolution: the producer kind `aih-controller`, set by every writer through `controllerSource()`. Readers accept both shapes. Current DSH also refuses the retired kind on **live** append (observed in this phase), so new damage of this kind is impossible. It survives only in stored logs written earlier.
2. **Controller notice before the protected system head.** On the first step the bridge appended a surface `user/message` during `agent/pre-step`, before DSH appended the first `system/message` (P2-B2B decoded log: notice seq 7, system seq 9; DSH refused the read with "system/message requires a protected first surface head"). Resolution: before the head exists, notices travel in the pre-step `enter` decision, which DSH appends right after the head and before the prompt. Rejected first turns use a durable queue.

## 5. Before/after persistence evidence

- **Before** (pre-P2-B2C writers):
  - P2-B2B real-host log (report §10.2): notice at seq 7 before the system message at seq 9, and DSH refused to read it.
  - Reproduced here with DSH's own reader on a test log carrying a historical retired-kind notice: "stored log is corrupt: SessionFormatError: format v4 message requires a producer-owned source kind" (`evidence/p2b2c/durability-restart-*.json`, `holds.retired`).
  - An attempt to regenerate a fresh "before" log on an unmodified `dev`-era install produced no turns in this harness (environmental). No claim rests on it.
- **After** (current writers): the first surface event is always the system message, and the notices follow it. Example: the managed Muse session surface order `8:system/message, 9:user/message:aih-controller, 10:user/message:user, 11:runtime-context, 12:time-context, 17:assistant/message`. Every stored session from the real-host runs audits `valid` and cold-reads through DSH's persistence API.

## 6. Ordinary Muse/Dual cold restore

`NexusSessionColdRestore.RealHost` (lane; production and patched). For each engine:
- a fresh session (owner `session/create` + first `session/prompt`, the GUI path) runs its first turn;
- the log is flushed and the host shut down completely;
- `NexusSessionAudit` reports `valid`;
- a fresh host process cold-reads the session and runs a **second turn on the same session** (DSH agent restore from disk);
- task identity, preset and engine, history (both prompts in order), model selection and append-only attempts are verified;
- exactly one model request is made in the new host;
- the session is still readable after a further restart.

**Muse PASS, Dual PASS** (`evidence/p2b2c/cold-restore-patched-poc.json`, plus the lane rows).

## 7. Managed Muse/Dual cold restart (Task B)

`NexusDurabilityRestart.RealHost`, patched mode, on an isolated PoC install with the allowlisted gateway build (`12e5577b…`, verified by digest and a live self-test). Real `nexus` CLI and real IPC.

| Step | Result (Dual and Muse) |
|---|---|
| Host ownership `held`; activation `active`; hook `verified` | ✓ |
| `nexus workspace add`, then `nexus submit` | ✓ receipt with `nt_…` task, session and `accepted` |
| One intake record, one reserved session identity, one accepted user message (claimed 1, inserted ≤1, user inputs 1); one model request; system head first; no retired kinds | ✓ |
| Complete host shutdown (SIGKILL, with an interrupted task in flight), then a new host process on the same data root | ✓ |
| Managed registry and tombstones restored **before** the first remote mutation (owner `session/rename` → `nexus-managed-session`) | ✓ |
| Exact session cold-read through `sessionPersistence.open(id,'read')`; header and ordering valid; history = the single original prompt | ✓ |
| CLI `status`: same task id, session id, attempt id, status, reason and Nexus reply; same prompt request id; attempts and TaskController tasks unchanged | ✓ |
| No duplicate prompt, attempt, task or model request after restart (0 model calls in the new host) | ✓ |
| `submit` replay with the same key returns the original receipt (`replay: true`) | ✓ (after the §3 fix) |
| Supported continuation: further turns stay mediated (owner prompt → `nexus-managed-session`); session restores for reads (`session/state`) | ✓ |
| **Interrupted execution**: SIGKILL during a live admitted turn → after restart `status: interrupted / interrupted`; no automatic replay; 0 model calls | ✓ |
| Damaged history inside a managed session → `blocked / session-history-retired-source-kind`; still managed; no model call | ✓ |
| Tombstone: the intake record is deleted, then restart → activation off (`intake-store-corrupt`); session still managed; `status` → `blocked / intake-record-missing`; key not reusable; restoring the record restores activation | ✓ |

Results by capability:

| Capability | Result |
|---|---|
| Cold reading | Proven. |
| Agent/session restoration | Proven for ordinary sessions (a second turn after restart). For managed sessions, restoration for reads is proven, and agent re-activation is intentionally not performed: a managed task has one admitted turn. |
| Safe task reconciliation | Proven: accepted and completed tasks are unchanged; interrupted tasks become an explicit hold; damaged histories are held; orphans are held. |
| Actual continuation of a managed task's execution | **Not supported by design in this phase** (no `continue task`), and not claimed. |

## 8. Historical-session hold behavior (Task C)

| Reason | Detected when | Behavior | Repair |
|---|---|---|---|
| `session-history-notice-before-head-pending` | readable; a surface notice is first, with no system message yet (latent) | Step refused (host and bridge) before any binding, attempt or model call. The log stays uncorrupted (no system message is appended). | not repairable losslessly (it would need event reordering) |
| `session-history-notice-before-head` | DSH refuses the read (protected head) | Held; DSH cannot restore it; Nexus reports the typed reason | not repairable losslessly |
| `session-history-retired-source-kind` | DSH refuses the read (`plugin` kind) | Held; files byte-identical after restart and prompting | deterministic lossless mapping exists; **not implemented** (it needs an authorized migration) |
| `session-history-unreadable` | any other DSH read refusal | Held | unknown |

Surfaces:
- `nexus session check <id>` (read-only; exit 7 when held);
- managed `status`/`result`/`follow` show `blocked` with the reason and `sessionHealth`;
- host log events `session-history-held` and `session-held-step-refused`;
- the audit's `holdReason`.

Valid historical sessions are unaffected: a valid session ran its second turn after the restart in the same test. A held managed session stays managed, and tombstones and task identity are preserved.

**Operator recovery options** (none automatic):
1. Keep the session held and read it with the audit tool (on a copy), or export what is needed.
2. Start a new session or task for the work.
3. For retired-kind logs, a future authorized migration with backup, exact identity checks, durable verification, idempotency and rollback could apply the lossless kind mapping. Not done here.

## 9. Tombstones and idempotency

- The identity ledger is append-only across restarts.
- A deleted record:
  - keeps its session managed (quarantined);
  - disables managed activation (`intake-store-corrupt`);
  - reports `intake-record-missing`;
  - keeps the idempotency key taken.
- Restoring the record restores activation.
- Replays return the original receipt even if the profile preference changed. A conflicting payload is still `IDEMPOTENCY_CONFLICT`. Proven on a real host (§7) and in unit tests (`NexusSessionDurability` groups 6 to 8, `NexusManagedIntake`).

## 10. Full production regression

Command (per run): `pwsh scripts/Test-Harness.ps1 -InstallRoot <root> -Lane production -ContinueOnFailure`.

Environment:
- a fresh isolated installed root (a clone of the base test install, plus this working tree's `scripts/`, `tests/`, `docs/` and UI plugin, plus prepared closures, installed and verified with `Install-NexusPresets.ps1`);
- isolated HOME and TMPDIR;
- blocked egress (`HTTPS_PROXY=127.0.0.1:9`);
- no credentials;
- synthetic model transport in the real-host suites.

| Run | Source | Rows | Pass | Assertions pass / fail | Failing rows | Evidence |
|---|---|---:|---:|---:|---|---|
| Start of assignment | `2070c617` (clean) | 121 | 119 | 3,353 / 2 | `ContextRestrictedProductionV2`, `Harness` | `production-lane-start-2070c617.json` |
| Final run 1 | `2070c617` + §3 changes | 122 | 117 | 3,287 / 5 | the two above, plus `ContextCompactionF2Prod`, `F5Slow`, `F7Telemetry`: all `spawnSync pwsh ETIMEDOUT` while the machine ran about 6× slower (98 min against 16). Each passed alone in the same root (69/69, 10/10, 28/28). **Environmental.** | `production-lane-final-run1*.{json,txt}` |
| **Final run 2** | same | **122** | **120** | **3,359 / 2** | `ContextRestrictedProductionV2`, `Harness`: **pre-existing** (identical at the start and in every earlier phase) | `production-lane-final.json` |

The lane covers:
- P1 Controller and strategy contracts (`NexusControllerCore` 15);
- P2-A binding authority and host ownership (`NexusBindingAuthority` 6, `NexusHostOwnership` 6);
- P2-B1 enforcement, IPC and CLI (`NexusHostEnforcement` 5, `NexusIpc` 9, `NexusCli` 9);
- P2-B2B managed tasks (`NexusManagedIntake` 11, `NexusManagedTasksRealHost` with production fail-closed);
- P2-B2C (`NexusSessionDurability` 8, `NexusSessionColdRestoreRealHost` 2, `NexusDurabilityRestartRealHost` 3);
- routing (`ControllerRouteSelection` 9), Muse/Engineering/DeepSeek isolation, compaction, context and CCv2-restriction suites.

`NexusGatewayAuthorization` and the patched-mode real-host runs need the PoC gateway and ran outside the lane:
- `NexusDurabilityRestart.RealHost` patched: 6/6;
- `NexusSessionColdRestore.RealHost` patched: 3/3.

## 11. Gateway PoC and activation gates

- **Patched PoC:** digest allowlisted plus a live self-test refusal observed; every gate holds; activation `active`. Restart preserves activation, and a corrupt intake store disables it.
- **Standard pinned DSH** (lane, production mode): activation inactive (`gateway-hook-unverified:gateway-build-not-allowlisted`); CLI and GUI `submit` refused with exit 4 and nothing created (`NexusManagedTasksRealHost`, `NexusDurabilityRestartRealHost`).
- The PoC build was never placed in a production install.

## 12. CLI regression coverage

| Capability | Coverage |
|---|---|
| `host start` | Flag mapping and launcher failure; success path recovering the running host's login link from its own log (same port only); `--open` opens the tokenized URL; readiness confirmed over IPC (`NexusCli`). Reuse of a running host on a real host (demo and `aih` launcher path). |
| Login link | The test generates random tokens; no real token appears in tests or this report. |
| `workspace add` | Unit (host-only) and real host (`NexusDurabilityRestart`, both modes). |
| `credentials list/set --stdin/unset` | The value is never taken from arguments or echoed; multi-line values are refused; changes are refused while a task runs (`NexusCli`). Real DSH credentials controller verified earlier with a throwaway name. |
| Reply projection | `status.data.reply`, `result.data.summary` (`NexusManagedIntake`, real-host status comparison in §7). |
| Exit codes and JSON | 0, 2, 3, 4, 5, 6 and 7 classes asserted across `NexusCli`, `NexusManagedTasks.RealHost`, `NexusDurabilityRestart.RealHost`. |
| Hook absent | `submit` exits 4 with `REQUIRED_CAPABILITY_UNAVAILABLE` on pinned DSH. |
| Read-only commands | Without a host: exit 3, no files created; `session check` activates no agent. |

## 13. Cross-platform

Only macOS arm64 has native evidence. Linux and Windows were not run in P2-B2C, and managed activation refuses there (`platform-not-qualified`). The session-health logic is platform-neutral, but it is unverified natively.

## 14. Remaining production blockers (outside P2-B2C)

- DSH `gateway/authorize` shipped upstream, or an explicitly authorized digest-checked pinned patch with installer integration.
- Operator actions to resume or close held and interrupted tasks.
- Legacy verification through the task API (a finished turn shows `turn-completed-awaiting-verification`).
- A general `continue task` command (more than one admitted turn per managed task).
- An authorized migration for retired-kind historical logs, if wanted.
- Linux and Windows real-host evidence.
- Multi-question and multi-select approvals.
- Workspace protection after a managed task ends.

## 15. Rollback

All P2-B2C changes are uncommitted. To roll back, revert the files in §3; earlier phases are unaffected.

- Rolling back the hold integration restores the earlier behavior: invalid histories fail generically instead of being held.
- Rolling back the replay fix reintroduces `MODE_UNAVAILABLE` on retries after a profile change.
- No data migration was performed and no session log was modified, so nothing needs restoring on disk.
- Ledger entries written with the new `workspacePath` field are read by older code as before (the field is ignored).

## 16. Verdict

**P2-B2C: GO.** Every completion criterion is met, with real-host evidence:

- the full current production lane ran (§10);
- ordinary Dual and Muse sessions cold-restore and continue (§6);
- managed CLI-created Dual and Muse sessions survive a restart without duplicate admission or unauthorized execution (§7);
- both format-v4 bugs are fixed (§4);
- historical invalid sessions get an explicit, safe hold (§8);
- tombstones survive and cannot be bypassed by record deletion (§9);
- the CLI stays compatible (§12);
- unpatched DSH still refuses managed submission (§11).

Production `nexus submit` stays **NO-GO** pending §14. Stop at the P2-B2C boundary.
