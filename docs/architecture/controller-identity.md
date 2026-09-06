# Controller identity: display labels vs immutable instances

TASK-0005. This document records the identity contract every controller-plane
component must preserve. When implementation and this document disagree,
implementation plus the deterministic tests are authoritative — and one of
them is wrong.

## The core rule

```
TASK-NNNN is a label. taskInstanceId is identity.
```

- `taskId` (`TASK-0004`) is a human-facing label allocated from a sequence.
  It is **not** unique across time: a Git restore can roll the sequence back
  and re-allocate a display id that a previous lifecycle generation already
  used. Nothing may join, cache, or route on the display id alone.
- `taskInstanceId` (`task_<32 hex chars>`, UUID-based) is minted exactly
  once per lifecycle generation, is immutable, and is never re-allocated.
  Every durable artifact joins on it.

## Where the instance is minted and carried

- `New-AihTask` (scripts/TaskController.ps1) mints the instance, writes it to
  the ledger task, the run manifest, and the `task-created` decision record.
  Sequence allocation is hardened: the next id skips every id used by the
  ledger **or** claimed by an existing run directory, so a rolled-back
  `nextSequence` cannot re-allocate a live id.
- Every mutation helper (`Update-AihTaskRecord`, `Start-AihTaskAttempt`,
  `Add-AihAttemptEvent`, `Add-AihTaskFailure`,
  `Set-AihTaskExecutionClass`, `Set-AihTaskReviewRequested`,
  `Set-AihTaskEvidence`, `Test-AihTaskCompletion`, `Add-AihLearning`)
  accepts `-TaskInstanceId` and **fails closed** with
  `Task identity mismatch` when the ledger task holds a different instance.
- `Task.ps1 -Action test-task` is the authoritative, deterministic lookup:
  `{ exists, taskId, taskInstanceId, instanceMatches, expectedTaskInstanceId }`.
  A malformed ledger, a CLI failure, or a timeout THROWS — a validation
  failure must never be reported as "task missing".

## Session bindings

- `data/routing/session-bindings.json` binds a GUI session to
  `(workspace, preset, taskId, taskInstanceId)`.
- Before every controller step the bridge validates the binding against the
  ledger (`test-task`). Verdicts: `valid` (exact instance exists), `stale`
  (`task-missing`, `instance-mismatch`, `ambiguous-legacy-binding`),
  or inconclusive (validation-infrastructure failure — the binding is
  preserved and **no replacement task is created**).
- Recovery is controller-owned: log `stale-binding-detected` (structured,
  with old/new instance), invalidate the binding, create a fresh task, and
  rebind. Recovery never reconstructs state from the stale binding and never
  runs an engineer model. A legacy binding without `taskInstanceId` is
  always ambiguous — it is rebound, never auto-attached to a new generation.
- A per-session lock serializes recovery: two simultaneous events for one
  stale session produce exactly **one** replacement task.
- Session bindings can never resurrect a deleted task: the ledger is the
  authority, and a vanished task is stale by definition.

## Routing and Control Room

- Routing state is keyed `normalized(workspace) + preset + taskInstanceId`
  (instance-aware) or `normalized(workspace) + preset + taskId` (legacy
  compatibility). `C:\AI-Harness` and `c:\ai-harness\` normalize equal;
  `C:\Repo` and `C:\Repo2` do not.
- Decision records carry `taskInstanceId`. The panel joins state files,
  decisions, attempts, gates, and the ledger by exact instance. When an
  expected instance is known, legacy (instance-blind) records never join.
- If the joined tuple is internally inconsistent (state class vs decision
  class vs generation), the Control Room reports the inconsistency and
  suppresses the display fields instead of inventing a plausible tuple.

## Engineering Isolation

Executor selection resolves the profile from the instance-aware routing
state, so a stale state file of generation A can never make generation B
execute with A's reviewer model. Under GLM + Codex: `engineer_normal` →
GLM-5.3-Flash (primaryEngineer), `engineer_deep` → GLM-5.3 (deepEngineer),
reviewer → GPT-5.6 Sol.

## Invariants (test-enforced)

1. Session bindings cannot resurrect deleted tasks.
2. taskId reuse cannot cause lifecycle cross-contamination.
3. New tasks are joined by taskInstanceId.
4. /review remains controller-owned, fresh, independent and read-only.
5. Engineer Deep under GLM + Codex cannot accidentally execute GPT-5.6 Sol
   because of stale routing state.

Tests: `tests/TaskIdentity.Tests.ps1`, `tests/AihControllerIdentity.Tests.cjs`
(plus the pre-existing `NexusControllerPanel.Tests.cjs` shape guarantees).
