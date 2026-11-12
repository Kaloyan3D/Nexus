# Nexus Plugin-First — P2-B2D implementation report: end-to-end task verification and operator recovery

Continues [P2-B2C](NEXUS-PLUGIN-FIRST-P2B2C-IMPLEMENTATION-REPORT.md). Branch `feature/nexus-plugin-first-p1`, revision `2070c617` plus uncommitted P2-B2C and P2-B2D changes (nothing committed, pushed or deployed). Pinned DSH `0.2.2-rc.1`. macOS arm64.

**Verdict: GO for P2-B2D.** Managed Muse and Dual tasks reach **authoritative completion** through the shared Controller Task API, using the existing Nexus `/verify` pipeline. CLI and GUI report the same outcome. A failed required check blocks completion. Held and interrupted tasks expose safe, revision-checked operator actions. Uncertain execution is never replayed. Identity, evidence and outcomes survive host restart. The standard unpatched DSH still refuses managed submission. Production `nexus submit` remains NO-GO for the blockers in §10.

---

## 1. Source changes (uncommitted, on top of P2-B2C)

| File | Change |
|---|---|
| `config/AihController.cjs` | `executeVerifyTurn(agent, binding, report?)`: an optional report object receives the structured outcome (verification state, check counts, failing checks, evidence path, completion summary). The `/verify` chat path passes none and is unchanged. `completionSummary()` gives a bounded projection of the `Task.ps1 complete` result. Two host hooks re-validate identity and use the same authorities as the GUI: `nexus/task-verify` (binding ↔ task instance, `testTaskIdentity`, attempt match, registry guard, then `executeVerifyTurn`) and `nexus/task-close` (closes an open attempt as `interrupted` / `operator-closed` via `Task.ps1 attempt-event`). |
| `config/nexus/managed-tasks.cjs` | `runVerification()`: durable intent (`verification.state = running`) before dispatch; per-task single flight; the outcome recorded on the intake record. `closeTask()`: refused on a live turn or a running verification; withdraws approvals; keeps the record and tombstone. Reconcile turns a verification that was `running` at restart into `interrupted`. `admitStep` refuses closed tasks. `cancel` on a closed task returns `already_terminal`. |
| `config/nexus/task-api.cjs` | Verification and close states projected into `status`/`result`/`follow` (`taskVerification`, `closed`, `guidance`). Controller-derived operator actions (`run-verification`, `close-task`) bound to the view revision. `respond` routes `act_verify_*` / `act_close_*` to a revision-checked path with duplicate receipts. `HOLD_GUIDANCE` explains each hold. The legacy view exposes `attemptStatus`. Orphans refuse `respond` with `intake-record-missing`. |
| `config/nexus/controller.cjs` | Managed ports `verify` and `closeAttempt` (waterfall to the plane bridge). |
| `scripts/nexus-cli.cjs` | Human output shows verification state and checks, failing checks, the completion decision and reason, the close disposition, guidance, and a ready-to-run `nexus respond …` line per advertised action. No new flags; JSON is unchanged apart from additive fields. |
| `scripts/Test-Harness.ps1` | Lane rows `NexusTaskVerification` and `NexusTaskVerificationRealHost`. |
| `tests/NexusTaskVerification.Tests.cjs` (new) | 8 groups (§7). |
| `tests/NexusTaskVerification.RealHost.Tests.mjs` (new) | Production: 2 groups. Patched PoC: 5 groups (§7). |

No new task ledger, verification engine, model routing, DSH change or CCv2 mutation.

## 2. Shared verification action contract

Operator actions in `operatorActions` come from two sources:
- the live approval broker (unchanged: tool approvals and questions);
- the Controller, derived from durable state (new).

| Action | Offered when | Choices | Effect |
|---|---|---|---|
| `run-verification`, id `act_verify_<task>_a<attempt>` | The turn ended `completed`, the TaskController attempt is `started`, no verification is recorded or running, the task isn't closed and the session isn't held | `run` | The existing `/verify` pipeline through the bridge (Verify-Project + Engineering verification plan + `Task.ps1` evidence/failure/complete). The TaskController alone decides completion. |
| `close-task`, id `act_close_<task>_r<revision>` | `blocked` or `interrupted` (awaiting verification, verification failed-but-open, incomplete or rejected, completion denied, interrupted, restored input, delivery holds, historical damage) | `close` | Closes an open attempt as `interrupted` (`operator-closed`), withdraws approvals and marks the task closed. Nothing resumes. Identity, intake history and tombstone are kept. |

`respond` checks, in order:
1. the operation-scoped capability (`tasks:respond`);
2. task identity (workspace authorization);
3. the orphan state (refused with `intake-record-missing`);
4. a duplicate of an already-accepted answer (returns the prior receipt);
5. that the action is currently offered (`STALE_ACTION` otherwise);
6. that `expectedRevision` equals the current view revision (`STALE_ACTION` otherwise);
7. that the choice is valid (`USAGE` otherwise).

A verification answer returns `accepted` immediately, and the result is observed through `status`/`wait`, since the pipeline can take longer than a client request. Never offered: resume of an interrupted turn, re-verification after an outcome, actions on a live turn, actions on completed, failed or cancelled tasks.

## 3. End-to-end managed task lifecycle

```
nexus submit ─► intake accepted ─► admitted DSH engineering turn ─► turn completed
   status: blocked / turn-completed-awaiting-verification   actions: run-verification, close-task
nexus respond --request act_verify_… --choice run --revision N   (CLI)   = GUI respond (same API)
   status: verifying            (intent durable on the intake record before dispatch)
existing /verify pipeline ─► evidence.json + Engineering verification + attempt verifying→passed|failed
TaskController completion policy (Task.ps1 complete)
   ├─ complete      ─► status: completed             nexus wait/result exit 0
   ├─ check failed  ─► status: failed / verification-failed (failing checks listed)   exit 5
   ├─ denied        ─► status: blocked / completion-denied (+ TaskController reason)  actions: close-task
   └─ error/restart ─► status: blocked / verification-incomplete (never PASS)         actions: close-task
```

A DSH turn ending is never treated as completion. Real host: Muse and Dual both reached `completed` with the ledger `complete`, and the `fixture-check` and architecture rules PASS (`evidence/p2b2d/verification-realhost-patched-poc.json`).

## 4. Operator recovery state transitions

| Hold | Actions | After `close` |
|---|---|---|
| `turn-completed-awaiting-verification` | run-verification, close | `cancelled / operator-closed`; open attempt → `interrupted` |
| `verification-failed` (ledger `failed`) | none (terminal) | n/a |
| `verification-incomplete` (pipeline error, or host restart during verification) | close | `cancelled / operator-closed` |
| `completion-denied` | close | `cancelled / operator-closed` |
| `interrupted` (turn executing when the host stopped) | close | `cancelled`; open attempt → `interrupted` |
| `restored-input-not-resumed`, `delivery-*`, `duplicate-input` | close | `cancelled` |
| `session-history-*` (held historical session) | close | `cancelled`; the session stays managed and held |
| `intake-record-missing` (orphan) | none: restore the record file from backup | n/a |

Closing preserves the task id, the intake record and its history (`closedAt`, `closeReason`, `closeActionId`, `closedBy`), the identity ledger entry and the idempotency key: a replay returns the original task. A closed task is never admitted to run again.

## 5. Safety decisions for interrupted tasks

- An interrupted model or tool turn may have had side effects, so it is **never resumed or verified**. Verifying it could complete partial work from the current workspace state; its only action is `close-task`, and the guidance says why execution cannot continue.
- A verification running at host restart is recorded as `interrupted`. It is not re-run (re-running would start from a `verifying` attempt, which TaskController refuses) and never becomes PASS.
- `restored-input-not-resumed` offers close only. DSH 0.2.2 has no documented wake-only operation that would prove a single execution.
- No operator action converts a failed verification into completion: a failed task has no actions, and close produces `cancelled`, never `completed`.

## 6. CLI/GUI parity

The GUI task route and IPC call the same `core.tasks` operations. On the real host, the GUI `getStatus` returned the same action ids and the same final status as the CLI for Muse and Dual. Concurrent GUI and CLI answers to the same action started verification exactly once (`accepted` / `duplicate`). The legacy GUI `/verify` command on an ordinary session still runs the same pipeline: check PASS, evidence written, verify notice, no model request.

CLI experience:
- `status`, `result` and `wait` print the verification outcome, the completion decision and its reason, guidance, and a copy-paste `nexus respond …` line per action.
- `run` and `wait` stop at a hold with exit 7 and **never answer anything** in non-interactive mode.
- `wait` follows `verifying` to the authoritative outcome: exit 0 completed, 5 failed, 7 blocked.

## 7. Restart and crash evidence

**Unit** (`NexusTaskVerification`, 8/8):
- verified completion (Muse and Dual), failed verification, missing required check (completion denied), incomplete verification;
- host restart during verification (intent durable, then `interrupted`, no PASS, no re-run);
- unauthorized, forged, stale and unknown-choice answers refused;
- concurrent GUI and CLI answers start verification once; duplicates return the receipt; actions invalidate on a state change;
- an interrupted task offers close only; close interrupts the open attempt; the session stays managed; the key keeps the task; nothing re-runs;
- an orphan refuses respond.

**Real host** (`NexusTaskVerification.RealHost`):

| Run | Groups | Covers |
|---|---|---|
| Production | 2/2 | legacy `/verify` parity; submit refused |
| Patched PoC | 5/5 | parity; Muse and Dual verified completion; failed required check (exit 5); restart between turn and verification (action reconstructed), concurrent GUI+CLI, duplicate, outcome survives a further restart without re-running; SIGKILL mid-turn, then close only, no model call, session managed, key preserved |

Regression of the earlier patched suites on the same PoC root, after this change: `NexusManagedTasks.RealHost` 13/13, `NexusDurabilityRestart.RealHost` 6/6, `NexusSessionColdRestore.RealHost` 3/3 (`evidence/p2b2d/regression-*.json`).

No additional inference: verification made no model request in the managed or legacy paths (`totalModelCalls` unchanged across verification).

## 8. Full regression

Full production lane on a disposable install (`evidence/p2b2d/production-lane-final.json`), 942 s:

| Metric | P2-B2C final | P2-B2D final |
|---|---|---|
| Lane rows | 122 | **124** (+`NexusTaskVerification`, +`NexusTaskVerificationRealHost`) |
| Rows passing | 120 | **122** |
| Assertions passed | 3,359 | **3,369** |
| Assertions failed | 2 | 2 |

The two failing rows are the same pre-existing failures as the P2-B2C baseline; neither involves a file touched in this phase:
- `ContextRestrictedProductionV2`, which fails on load (0 passed, 1 failed);
- `Harness`, 230 passed and 1 failed, on `source contains no credential values`.

New and affected rows all pass:

| Row | Passed |
|---|---|
| `NexusTaskVerification` | 8/8 |
| `NexusTaskVerificationRealHost` (production mode) | 2/2 |
| `NexusManagedTasksRealHost` | pass |
| `NexusDurabilityRestartRealHost` | pass |
| `NexusSessionDurability` | 8 |
| `NexusCli` | 9 |
| `NexusManagedIntake` | 11 |
| `NexusTaskApi` | 7 |
| `AihController` | pass |

The patched-mode proofs in §7 ran separately, because the lane installs the standard production DSH.

## 9. Known limitations

- One admitted turn per managed task. After a failed verification or an interrupted turn, the task can only be closed; a new attempt needs a new task (multi-turn continuation is out of scope).
- `restored-input-not-resumed` cannot be resumed (no DSH wake-only operation); close only.
- Visual verification and review gates are as in the GUI: if `runCompletionTail` reports visual or review blocking, the task shows `completion-denied` with the reason. There is no separate gate action in the Task API yet (resolve in the Nexus app).
- An orphan (deleted intake record) has no API recovery; the operator restores the record file.
- A real-host interrupted task in this run had no TaskController attempt yet (`attemptOpenBefore: false`). Closing an *open* attempt is proven in the unit suite and through the bridge hook code path.
- Platform: only macOS arm64 has native evidence.

## 10. Remaining production blockers

- DSH `gateway/authorize` shipped upstream, or an explicitly authorized pinned patch with installer integration.
- Multi-turn continuation (`nexus continue`).
- Task API actions for review and visual gates.
- An authorized migration for retired-kind historical logs (optional).
- Linux and Windows real-host evidence.
- Multi-question approvals.
- Workspace protection after a managed task ends.

## 11. Rollback

Revert the files in §1; P2-B2C is unaffected:
- revert the bridge hooks and the `report` parameter in `AihController.cjs`;
- remove `runVerification`, `closeTask` and the reconcile branch from `managed-tasks.cjs`;
- remove the derived actions and the verification projection from `task-api.cjs`;
- remove the two managed ports from `controller.cjs`;
- revert the CLI rendering.

Records written with the new `verification` and `closed*` fields are ignored by older code (unknown fields). A closed task would then show its pre-close hold again, but it is still never admitted, because the managed one-turn rule refuses it. Nothing is written to session logs or TaskController files beyond what the existing `/verify` and attempt-event paths write.

## 12. Verdict

**P2-B2D: GO.**
- Managed Muse and Dual reach verified completion through the shared Task API; the existing pipeline and the TaskController decide.
- CLI and GUI report the same outcome.
- A failed required check blocks completion.
- Held and interrupted tasks expose safe close actions.
- Uncertain execution is never replayed.
- Identity and evidence survive restart.
- The P1–P2-B2C gates stay green (§8).
- Unpatched DSH refuses managed submission.

Production rollout remains NO-GO (§10). Stopping at the P2-B2D boundary.
