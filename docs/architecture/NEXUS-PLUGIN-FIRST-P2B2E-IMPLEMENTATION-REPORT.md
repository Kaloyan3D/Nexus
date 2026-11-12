# Nexus Plugin-First — P2-B2E implementation report: durable multi-turn task continuation

Continues [P2-B2D](NEXUS-PLUGIN-FIRST-P2B2D-IMPLEMENTATION-REPORT.md). Branch `feature/nexus-plugin-first-p1`, HEAD `2070c617`. Pinned DSH `dsh-v0.2.2-rc.1`. macOS arm64. Nothing was committed, pushed, merged or deployed.

**Verdict: GO for P2-B2E.**
- An existing managed task accepts several sequential, explicitly authorized user turns through one shared Controller operation: `continueTask`, used by both CLI/IPC and the GUI route.
- Every turn is durably reserved, uniquely identified, delivered exactly once into the **same** DSH session, and admitted turn by turn.
- Verification is the existing `/verify` pipeline, applied to the latest completed candidate; completion is still the TaskController's decision.
- Crashes at each delivery boundary reconcile without duplicating or replaying anything.
- Production managed submission and continuation remain refused on the standard DSH, and a production release is still NO-GO (§15).

---

## 1. Working-tree state

**Start:** the P2-B2D end state.
- Modified: `config/AihController.cjs`, `config/nexus/{controller,intake-store,ipc,managed-tasks,task-api}.cjs`, `scripts/{NexusSessionAudit,nexus-cli}.cjs`, `scripts/Test-Harness.ps1`, and tests `NexusCli`, `NexusManagedIntake`, `NexusSessionDurability`, `lib/NexusManagedHost.mjs`.
- Staged: `config/nexus/session-health.cjs`.
- Untracked: the P2-B2C and P2-B2D reports and evidence, plus tests `NexusDurabilityRestart.RealHost`, `NexusTaskVerification{,.RealHost}`.

**End:** everything above is preserved; nothing was reset, stashed or overwritten. Full listing: `evidence/p2b2e/source-state-final.txt`.

P2-B2E added or changed:

| File | Change |
|---|---|
| `config/nexus/managed-tasks.cjs` | Turn model (`turnsOf`, `currentTurn`, `publicTurn`). `continueTask` with durable continuation records. Per-turn delivery (`advanceTurn` / `decideTurn` / `parkTurn`). Turn-scoped `admitStep` and `onTurnEnd`. Continuation reconcile and resume. `continuationRefusal` (the single eligibility rule). Arbitration locks in `runVerification` and `closeTask`. Test-only `faultPoint` hook. |
| `config/nexus/task-api.cjs` | `continueTask` operation with a synchronous expected-revision precheck. Projection over the *current* turn. View fields `turns` and `continuation`. `continuation-delivering` state and guidance. `verifying` is now reported until the outcome is durable (fix in §10). |
| `config/nexus/ipc.cjs` | `continueTask` added to the operation and input-field tables. The GUI route validates through the same table, so both transports serve it. |
| `config/nexus/controller.cjs` | Passes an in-process `managedFaultPoint` function (code-only; no environment variable or flag can set it). |
| `scripts/nexus-cli.cjs` | `nexus continue <task> (--prompt\|--prompt-file\|--stdin) [--idempotency-key] [--revision] [--json]`. Status shows turns and whether another turn is allowed. Exit code mapping for `TASK_NOT_CONTINUABLE`. |
| `scripts/Test-Harness.ps1` | Lane rows `NexusTaskContinuation` and `NexusTaskContinuationRealHost`. |
| `tests/lib/NexusManagedHost.mjs` | Opt-in `NEXUS_TEST_ECHO_TURNS`: the synthetic model echoes the `[turn-N]` markers it received. Real SIGKILL crash points `turn-delivering` and `turn-accepted`. |
| `tests/NexusSessionColdRestore.RealHost.Tests.mjs` | Assertion message only: a direct GUI prompt to a managed session is still refused; continuation goes through the Task API. |
| `tests/NexusTaskContinuation.Tests.cjs` (new) | 6 groups (§8). |
| `tests/NexusTaskContinuation.RealHost.Tests.mjs` (new) | Production: 2 groups. Patched PoC: 7 groups (§7, §8, §10). |

There is no new ledger, no TaskController or PowerShell change, no DSH change, no new CCv2 mutation and no routing change.

## 2. TaskController multi-turn compatibility

The ledger semantics were traced in `AihController.cjs`:
- engineering pre-step: `latestAttemptOf` / `attemptIsOpen` / `beginAttempt` with `requireNoOpenAttempt`;
- turn end: `attemptEvent('interrupted')` on abort or interrupt; nothing on a clean end;
- `executeVerifyTurn`: `verifying` → evidence → `passed`/failed → `runCompletionTail`.

What the trace shows:
- **An attempt stays open (`started`) after a clean DSH turn.** Turn end never closes it; only verification (`verifying` → `passed`/failure) or an abort or interrupt does.
- **A second user turn on a session with an open attempt starts no new attempt.** The pre-step only calls `beginAttempt` when no attempt is open (`requireNoOpenAttempt`). This is exactly how ordinary GUI multi-turn engineering sessions already work.
- A new attempt starts only after the previous one closed (passed, failed or interrupted).
- Evidence and completion bind to the open attempt at verification time, so they cover whatever the workspace holds then: the latest candidate.

**Chosen lifecycle (no ledger extension needed):**
1. All user turns of a managed task run inside **one open attempt** (one evolving candidate).
2. Final verification closes that attempt and the TaskController decides completion.
3. Continuation is refused once verification has begun, so a new attempt can never be opened behind a verified, failed or interrupted one.

Real-host proof, Muse and Dual:

| When | Attempt records |
|---|---|
| After three turns | `["started"]` |
| After verification | `["started","verifying","passed"]` |

The ledger reads `complete`.

## 3. Per-turn state machine and durability

Turn 1 is the original intake: its fields stay on the record, so P2-B2B/B2C behaviour is unchanged. Turn *n* ≥ 2 is an entry in `record.continuations[]`, written atomically with the record (temp + fsync + rename + dir fsync) and compare-and-swapped on the record revision.

Each continuation entry holds:

| Field | Meaning |
|---|---|
| `turnId` (`nturn_…`), `seq` | Controller-allocated turn identity |
| `principalId`, `idempotencyKey` | Key scoped to task + principal |
| `fingerprint` | sha256 of principal, task and prompt digest |
| `requestId` | DSH source request identity |
| `prompt` | `{digest, bytes, kind}`; the protected text is kept only until acceptance |
| `expectedRevision` | Task revision the turn was reserved against |
| `state` | `reserved` → `delivering` → `accepted`, or `failed` (no DSH effect), or `parked` (uncertain) |
| `reservedAt`, `deliveringAt`, `acceptedAt` | Lifecycle timestamps |
| `deliveryEvidence` | Inserted / claimed / discarded counts |
| `executionStartedAt`, `turnEndedAt`, `turnEndReason`, `turnError` | Execution and terminal observations |
| `hold` / `failure` | Recovery disposition |

Admission sequence (`continueTask`):
1. Authorize (`tasks:submit`, workspace).
2. Resolve the exact task.
3. Validate the prompt (UTF-8, 256 KiB, no NUL, digest).
4. Replay check by (principal, key).
5. Mode/profile check.
6. **Synchronous section:**
   - the expected revision equals the view revision;
   - `continuationRefusal` passes;
   - the reservation is persisted.
7. Delivery intent persisted (`delivering`).
8. The exact message is enqueued in the same session (`prompt`, mode `queue`, the turn's `requestId`).
9. Flush, then durable read-back.
10. Accepted only if the request id appears exactly once.

Step 1 of the turn waits for that acceptance commit, then the turn is tracked until `turn/end`. Delivery reuses the P2-B2B evidence rule (`deliveryEvidence`) and the same restart outcomes: proven absent → finish later under the same ids; present → accepted and held.

Turn-scoped tickets (`admitStep`):

| Situation | Outcome |
|---|---|
| Step 1 claims anything other than the current turn's reserved `requestId` | Refused `managed-input-mismatch` |
| Turn already executed and not live | Refused `managed-turn-already-run` |
| Turn not yet committed | Waits up to 30 s, then `managed-admission-uncommitted` |

- Later steps and subagent children run only while that turn is live, and they inherit its live entry.
- `onTurnEnd` settles the turn named by the **live ticket**, so a late or duplicate end cannot touch a newer turn. Proven by the test where `onTurnEnd(…, 'error')` after a completed turn changes nothing.
- The bridge's route, model, permission and budget checks run on every new turn as before.
- Restart rebuilds turn state from the records before activation: no turn is live, so a turn whose end was not seen is held.

## 4. New Controller, CLI and GUI contracts

**Task API**

```
continueTask(principal, { taskId, idempotencyKey, prompt:{kind,text,digest}, expectedRevision })
→ ok { taskId, sessionId, turnId, turnSeq, status:"accepted", mode, idempotencyKey, replay, revision, taskStatus }
```

| Error code | Exit | When |
|---|---|---|
| `TASK_NOT_CONTINUABLE` | 4 | `details.reason` is one of: `turn-live`, `turn-not-started`, `turn-pending`, `turn-held`, `turn-not-clean`, `approval-pending`, `verification-running`, `verification-started`, `task-terminal`, `task-closed`, `task-closing`, `task-cancelled`, `interrupted`, `restored-input-not-resumed`, `session-history-*`, `turn-limit` |
| `STALE_ACTION` | 4 | Revision changed |
| `IDEMPOTENCY_CONFLICT` | 4 | Same key, different payload |
| `MODE_UNAVAILABLE` | 4 | `mode-unavailable` or `profile-changed` |
| `REQUIRED_CAPABILITY_UNAVAILABLE` | 4 | Activation gate failed, legacy task, or orphan |
| `NOT_FOUND`, `AUTH_REQUIRED` | 4 | Unknown/foreign task; missing capability |
| `USAGE` | 2 | Invalid input |
| `SUBMISSION_UNCERTAIN` | 8 | Retry with the same key |

**Status and result additions** (bounded):
- `turns`: `{ total, current: { turnId, seq, status, acceptedAt, startedAt, endedAt, endReason, hold? } }`;
- `continuation`: `{ allowed, reason? }`;
- the latest Nexus reply (`reply.text`, max 8 KB) and the operator actions;
- guidance text mentions `nexus continue`.

**CLI**

```
nexus continue <task> --prompt <text> | --prompt-file <file> | --stdin [--idempotency-key k] [--revision n] [--json]
```

- It reuses the existing prompt reader: no-follow, UTF-8, size, digest, no shell interpretation.
- Without `--revision`, the CLI binds the turn to the revision it reads first.
- It never starts a host, Controller or session.

**GUI:** `POST /nexus/tasks/v1/continueTask` uses the same validation table and the same internal operation, and returns the same receipt.

## 5. Authorization and idempotency invariants

- Only host-derived local-owner principals with `tasks:submit` may continue. Workspace authorization is re-checked on every request; a foreign task returns `NOT_FOUND`.
- A continuation key is scoped to (task, principal):
  - same key and same payload return the original receipt (`replay: true`, same `turnId`), even after the task moved on;
  - same key with a different payload returns `IDEMPOTENCY_CONFLICT`.
- The original submit key still maps to the original task (tested).
- Continuations add no identities: the tombstone ledger keeps exactly one identity per task (tested).
- A deleted record stays quarantined as before.
- **Same mode:** the mode's profile must still resolve, and to the profile the task was bound with. Otherwise `MODE_UNAVAILABLE` (`mode-unavailable` / `profile-changed`): never re-routed.
- **No extra authority:** activation gates (gateway hook digest and self-test, ownership, platform) are checked per request. With a failed gate nothing is reserved.
- A message in DSH's inbox is never admitted for its own sake: step 1 must carry the reserved request id of a committed turn.

## 6. Verification-versus-continuation arbitration

- One rule, `continuationRefusal`, is used both by the projection (`continuation.allowed`) and by the reservation.
- After a clean turn, the view offers both `continuation.allowed: true` and the P2-B2D actions `run-verification` and `close-task`.
- **Atomicity.** The host runs JS on one thread. The revision check, the eligibility rule and the reservation run synchronously with no `await` between them, and the reservation is a compare-and-swap on the record revision. `runVerification` annotates the record synchronously too. `closeTask` sets a synchronous `closing` lock before its first `await`. Whichever transition runs first changes the record or lock; the others see a new revision or a refusal reason.
- A reserved continuation withdraws all derived actions, so the view revision changes and earlier action ids become `STALE_ACTION` (tested).
- Verification is refused while a turn is pending, live, held or not yet ended (`turn-not-settled`).
- Continuation is refused once verification has begun (`verification-running` / `verification-started`).
- Close is refused while a continuation is being delivered (`turn-pending`).
- Earlier evidence can never certify a later candidate: continuation is impossible after any verification outcome.

Real-host race: a CLI `continue` and a GUI `respond run-verification` at the same revision produced exactly one winner (verify). Unit races: continuation vs verification, continuation vs close, and two different keys — one winner each time.

## 7. Managed Muse and Dual three-turn traces

Source: real host, patched PoC (`evidence/p2b2e/continuation-realhost-patched-poc.json`).

The synthetic model replies with the `[turn-N]` markers present in the user messages of the request it received, so each reply proves which conversation history reached the model.

| Turn | turnId | Status after the turn | Reply (Nexus) | Revision |
|---|---|---|---|---|
| Muse 1 | `t1` | blocked / turn-completed-awaiting-verification | `Seen: [turn-1]` | 1 |
| Muse 2 | `nturn_186aec1c…` | same | `Seen: [turn-1],[turn-2]` | 3 |
| Muse 3 | `nturn_55673714…` | same | `Seen: [turn-1],[turn-2],[turn-3]` | 5 |
| Dual 1 | `t1` | same | `Seen: [turn-1]` | 1 |
| Dual 2 | `nturn_2af6ab71…` | same | `Seen: [turn-1],[turn-2]` | 3 |
| Dual 3 | `nturn_ce87d91a…` | same | `Seen: [turn-1],[turn-2],[turn-3]` | 5 |

For both engines:
- same task id and same DSH session id across all turns;
- 3 durable user messages in order, each exactly once; turn ends `completed ×3`;
- the format-v4 log is readable and the protected system head comes first;
- 1 paired tool call and result;
- **4 model requests**: one per turn, plus the tool follow-up step;
- verification: 2/2 checks passed, ledger `complete`, status `completed`, `nexus wait` exit 0, no model request during verification;
- a 4th `nexus continue` is refused with `TASK_NOT_CONTINUABLE` / `task-terminal`;
- the GUI view has the same `turns` and action ids as the CLI.

## 8. Crash and restart reconciliation evidence

Covered by the unit suite (U) and the real host with real SIGKILL (R).

| # | Boundary | Result |
|---|---|---|
| 1 | Before reservation | Nothing durable; a retry is a new reservation (U: refusals deliver nothing) |
| 2 | After reservation, before delivery | U: restart → `resumePending` delivers under the same `turnId`/`requestId`, exactly once. R (`turn-delivering`): CLI exit 8 at the crash; after restart the turn is delivered and run once; same-key retry returns `replay:true` |
| 3 | After DSH inbox insertion, before flush | U: accepted exactly once, held `restored-input-not-resumed`, no further delivery |
| 4 | After flush, before acceptance | U: same as 3. R (`turn-accepted`): held `restored-input-not-resumed`, close only, 0 model requests after restart, retry returns the receipt, a further turn is refused |
| 5 | After the user message is claimed | Reconcile reads `claimed`: held `interrupted` (U: accepted-not-started vs claimed) |
| 6 | During model execution | R: refused `turn-live` while running; after SIGKILL `interrupted`, close only, 0 model requests, a further turn refused `interrupted` |
| 7 | During tool execution | Same mechanism as 6 (any live step: the turn's end was not seen, so it is held). Not separately crash-tested mid-tool; the tool call/result pair stays intact in the 3-turn runs |
| 8 | After turn end, before Controller settlement | Not settled = not ended: held `interrupted`, never assumed clean (U: crash during turn 2) |
| 9 | During verification-vs-continuation arbitration | The synchronous section has no await, so nothing is partially written; one winner (U and R). A verification running at restart becomes `interrupted` (P2-B2D rule) and blocks continuation (`verification-started`) |
| 10 | Shutdown and restart between clean turns | U and R: continuation allowed after restart, same session; the reply after the restart shows `[turn-1],[turn-2]`, so the model received the cold-restored history |

**Never:** a duplicated message, a replayed model call, or a re-admitted turn. A same-key retry never triggers another model request.

## 9. Full production regression

Full production lane on a fresh disposable install with the standard DSH (`evidence/p2b2e/production-lane-final.json`, 1,156 s):

| Metric | P2-B2D final | P2-B2E final |
|---|---|---|
| Lane rows | 124 | **126** (+`NexusTaskContinuation`, +`NexusTaskContinuationRealHost`) |
| Rows passing | 122 | **124** |
| Assertions passed | 3,369 | **3,377** |
| Assertions failed | 2 | 2 |

The two failing rows are the same pre-existing failures as the P2-B2C and P2-B2D baselines, unrelated to this phase:
- `ContextRestrictedProductionV2` fails on load;
- `Harness` has 230 passed and 1 failed, on `source contains no credential values`.

New and affected rows all pass:

| Row | Passed | Duration |
|---|---|---|
| `NexusTaskContinuation` | 6/6 | 1.8 s |
| `NexusTaskContinuationRealHost` (production mode) | 2/2 | 9.1 s |
| `NexusTaskVerification` | 8 | |
| `NexusTaskVerificationRealHost` | 2 | |
| `NexusManagedTasksRealHost` | pass | |
| `NexusDurabilityRestartRealHost` | pass | |
| `NexusManagedIntake` | 11 | |
| `NexusCli` | 9 | |
| `NexusTaskApi` | 7 | |
| `AihController` | pass | |

The lane install was built just before the final one-line projection reorder (§10) and a test-message edit. Every suite those two changes touch was then re-run directly on the final code and passes: the unit `NexusTaskVerification` / `NexusTaskContinuation` suites and the patched real-host suites in §10.

## 10. Patched PoC real-host results

Disposable installation with the allowlisted compiled gateway PoC, final code (`evidence/p2b2e/`):

| Suite | Result |
|---|---|
| `NexusTaskContinuation.RealHost` | **7/7** |
| `NexusManagedTasks.RealHost` | 13/13 |
| `NexusDurabilityRestart.RealHost` | 6/6 |
| `NexusSessionColdRestore.RealHost` | 3/3 (a direct GUI prompt to a managed session is still refused) |
| `NexusTaskVerification.RealHost` | 5/5 |

The production-mode `NexusTaskContinuation.RealHost` passes 2/2: the ordinary GUI multi-turn session still works, and managed `submit` and `continue` are both refused (`REQUIRED_CAPABILITY_UNAVAILABLE`).

**Defect found and fixed in this phase (pre-existing since P2-B2D).** The ledger turns `failed` inside the verification pipeline before the outcome is written to the intake record. During that window the projection reported `failed` without `verification-failed`, which could end `nexus wait` early. A managed verification in flight is now reported as `verifying` until its outcome is durable. After the fix, `NexusTaskVerification.RealHost` passes 5/5.

## 11. Performance and subprocess observations

- A continuation costs:
  - 2–3 atomic record writes (reserve, delivering, accepted) and one more at step 1 and at turn end;
  - one DSH `prompt`, one flush and one full durable-log read for evidence. The read is O(log size), the same as the initial submission.
- **No new attempt-start subprocess** per continuation: the attempt is already open, so the bridge does not call `Task.ps1 begin-attempt`. Any other per-turn engineering work in the bridge pre-step (route check, epistemic step) runs as it does for an ordinary GUI follow-up turn; it was not profiled separately.
- Verification spawns the same `Verify-Project.ps1` / `Task.ps1` processes as the GUI `/verify`.
- The CLI makes 2 IPC calls per `continue` without `--revision` (getStatus + continueTask) and 1 with it. It never spawns a host.
- Model requests: exactly one per admitted turn, plus tool follow-up steps (§7). Continuation adds no inference.
- Each turn adds one bounded entry to the task record (ids, digest, timestamps and evidence counts, under 1 KB; the prompt text is dropped at acceptance). Turns are capped at 64 per task (`turn-limit`).

## 12. Remaining limitations and unsupported states

- One active turn per task; no queued or overlapping user messages: refused `turn-live` / `turn-pending`.
- No continuation after verification has started. Iterate first, verify last. A failed verification is terminal for the task; start a new task.
- Turns that are held cannot be continued or resumed: `interrupted`, `restored-input-not-resumed`, delivery holds, damaged history. Close only, as in P2-B2D.
- Mode or profile changes mid-task are refused (`profile-changed`); there is no migration contract.
- At most 64 turns per task.
- Approvals block continuation until answered; no multi-question approvals.
- Turn 1's accepted-but-never-started state after a restart keeps its P2-B2B handling. The new reconcile rule (held `restored-input-not-resumed`) applies to continuation turns.
- The reply is the latest assistant text only (8 KB); there is no per-turn reply history in the API.
- Native evidence covers macOS arm64 only.

## 13. Rollback guidance

1. Revert the P2-B2E hunks listed in §1:
   - in `managed-tasks.cjs`: the turn model, `continueTask`, per-turn admit/settle, reconcile/resume and the arbitration locks;
   - in `task-api.cjs`: `continueTask`, the turn projection and the `verifying`-first ordering;
   - `continueTask` in `ipc.cjs`;
   - the CLI `continue` command;
   - the lane rows and the two new tests.
2. P2-B2D/C/B behaviour returns. Records that hold `continuations[]` stay readable (unknown field), and older code treats their task as turn 1 only. A task whose turn 1 ran then refuses all further steps (`managed-turn-already-run`), so rollback can only refuse; it cannot run anything.
3. Any continuation message that reached DSH but never ran stays unrun.
4. No DSH, TaskController or session-log change needs undoing.

## 14. Verdict

**P2-B2E: GO.** Every success criterion has evidence:

| Criterion | Evidence |
|---|---|
| Several sequential instructions on an existing task | §7 |
| Durable, uniquely identified turns | §3 |
| Same task id and DSH session | §7 |
| No duplicate execution under retries or concurrency | §5, §6, §8 |
| Cold restart keeps history and allows an explicit follow-up | §8 row 10 |
| Interrupted or ambiguous work is held, never replayed | §8 |
| Verification applies to the latest candidate | §6, §7 |
| Authoritative completion | §2, §7 |
| CLI/GUI parity | §6, §7 |
| Ordinary Muse/Dual GUI behaviour unchanged | §10 |
| Regression gates satisfied | §9 |
| Unpatched DSH still refuses managed submission and continuation | §10 |

Stopping at the end of P2-B2E. No production activation and no Nova work.

## 15. Remaining requirements for a production release

- DSH `gateway/authorize` shipped upstream, or an explicitly authorized pinned gateway build with installer integration and digest pinning.
- Linux and Windows native real-host qualification.
- Task API actions for review and visual gates (currently resolved in the Nexus app).
- Multi-question and long-lived approval UX.
- A production decision on task linkage after a terminal outcome: today a new request means a new, unlinked task.
- Workspace protection after a managed task ends; retention and cleanup policy for intake records and tombstones.
- An optional authorized migration for retired-kind historical session logs (P2-B2C).
- Signed CLI release packaging and a production admission switch reviewed by security.
