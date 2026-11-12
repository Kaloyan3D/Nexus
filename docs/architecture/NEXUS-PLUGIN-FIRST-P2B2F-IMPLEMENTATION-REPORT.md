# Nexus Plugin-First — P2-B2F implementation report: review and visual gate integration

Continues [P2-B2E](NEXUS-PLUGIN-FIRST-P2B2E-IMPLEMENTATION-REPORT.md). Branch `feature/nexus-plugin-first-p1`, HEAD `2070c617`. Pinned DSH `dsh-v0.2.2-rc.1`. macOS arm64. Nothing was committed, pushed, merged, reset, stashed or deployed. The P2-B2C/D/E working-tree changes are preserved (`evidence/p2b2f/source-state-final.txt`).

**Verdict: GO for P2-B2F.**
- Supported review gates now run through the shared Controller Task API, using the **existing** authorities:
  - the existing explicit independent review (EMv1 Dual only, by strategy);
  - the existing controller review gate (approve/reject, Control Room policy);
  - the existing controller-owned visual loop at the verification completion tail;
  - the TaskController completion check.
- Muse and Dual keep their policies.
- Missing, stale, failed, interrupted or unverifiable evidence never completes a task.
- A production release remains NO-GO (§13).

---

## 1. Existing review and visual gate behavior (traced)

| Mechanism | Where | Behavior |
|---|---|---|
| Explicit review | `/review` → strategy decision `explicit-review` → `executeReviewTurn` | Dual (`independentReview: true`) runs the existing reviewer. It routes with `reviewRequested`, marks the ledger task review-requested, builds a context bundle (a quality guard can reject it, with no reviewer call), and makes **one** request to the review service (`CodexReview.ps1`, `/responses` on the local OAuth endpoint), writing `runs/<task>/review-result.json`. A FAIL verdict with review required opens a gate; PASS supersedes a waiting gate. Muse (`independentReview: false`) refuses with its notice and makes no call. |
| Review requirement | `TaskController.ps1 complete` | Required if risk is critical, the task is review-requested, or the execution class is `reviewer`. Satisfied only by `-CodexReviewPassed` / `-CodexFindingsResolved`. |
| Completion tail | `runCompletionTail` (inside `/verify`) | Visual loop first: if visual is required and not `pass`, it blocks before review is considered. Then `complete` runs, with review passed only if the on-disk verdict is `pass`. A failed required review opens a gate. |
| Review gate | `gate.cjs` journal (`data/completion/gates.jsonl`) + Control Room action route | Statuses waiting / approved / rejected / superseded, with revision and request-id replay protection. **Approve = the one bounded transition `complete -CodexReviewPassed`** (an operator override of a failed review). Reject keeps completion blocked. The GUI route refuses managed sessions. |
| Visual requirement | `VisualRequirement.ps1` / `VisualLoop.ps1` | Required by path/extension rules or project `visual-policy.json`. Loop statuses: pending / reviewing / revise / exhausted / unavailable / pass. The TaskController blocks anything but `pass`, and rejects a self-claimed human acceptance. Repair requires a new turn and a fresh `/verify`. There is no operator override for `exhausted`. |
| Turn-end visual auto-verify | `automaticallyVerifyVisualTask` (Dual step-routed turns only) | When the requirement is detected after an engineering turn, it **runs `/verify` automatically**. |

Where a managed task reached `completion-denied` before P2-B2F:
- a required review that was missing, failed or stale;
- an unanswered gate (the GUI route refuses managed sessions);
- visual not at `pass`.

The P2-B2D API showed only a generic `completion-denied`.

Classification used from now on:

| Case | Managed status |
|---|---|
| Pending and actionable | `run-review` before verification; gate `approve`/`reject` after a passed verification; completion re-run for an approved gate |
| Already failed | `review-rejected`; visual `revise`/`exhausted`; `verification-failed` |
| Unavailable for the mode | Muse review: `policy: unavailable-for-engine` |
| Environment cannot produce the evidence | `visual-unavailable` (e.g. no capture runtime) |
| Terminal | completed / failed / cancelled (unchanged) |

## 2. Implemented Controller actions

All actions are derived from durable state, bound to the view revision, workspace-authorized, answered through `respond`, and the same for CLI/IPC and GUI. There is no new ledger, reviewer or verification engine.

| Action id | Kind / choices | Offered when | Effect |
|---|---|---|---|
| `act_review_<task>_t<turnSeq>_n<run>` | `review` / `run` | Engine strategy has an independent reviewer (Dual); turn completed, awaiting verification; attempt `started`; no verification; no verdict yet for **this turn**. A re-run (`n2`, …) only if the previous review produced no verdict (incomplete, interrupted, rejected) | Durable `review.state = running` (turn-bound), then the bridge hook `nexus/task-review` runs `executeReviewTurn(explicit)`. The question is the task's own user instructions. Background flight; outcome recorded. One reviewer request |
| `act_gate_<gate>_r<rev>` | `gate` / `approve`, `reject` | Verification passed for the current candidate, the current review failed, and the journal gate is `waiting` | Durable `gateAction` intent, then `nexus/task-gate`: `validateGateAction` (current gate, advertised action, request-id replay with request id = action id) and `resolveGate` (`resolvedBy: operator-task-api`). On approve: `complete -CodexReviewPassed`, exactly the Control Room transition |
| `act_complete_<gate>_r<rev>` | `completion` / `run` | Journal gate `approved` but the ledger is not complete (crash between approval and completion) | Re-runs the same completion transition, only for an approved gate |
| `act_verify_*`, `act_close_*` | P2-B2D | Unchanged | Verification now passes `reviewUsable` (freshness, §5) |

Arbitration (single-threaded synchronous sections plus revision compare-and-swap, as in P2-B2E):
- a running review refuses continuation (`review-running`), verification (`review-running`) and close (`operation-running`);
- a running gate action refuses continuation and close;
- reviews are refused once verification started, while a turn is pending/live/unsettled, or while closing.

Restart:
- a review that was `running` → `interrupted` (never re-run automatically, never a verdict);
- a gate action that was `running` → `interrupted`; the journal decides what happened.

**Bridge changes** (`config/AihController.cjs`):
- hooks `nexus/task-review` and `nexus/task-gate`;
- an optional `report` in `executeReviewTurn`;
- `runCompletionTail(…, { reviewUsable:false })` treats a stale review as absent;
- `completionSummary` now carries the TaskController `reasons`, `reviewRequired` and the visual block.

**Visual deferral for managed sessions:** the Dual turn-end visual auto-verification only records the requirement (`managed-visual-required-deferred`) and does not run `/verify`. A managed task verifies only through its explicit action after its last turn. The requirement itself is unchanged and is enforced by that verification's completion tail. Ordinary sessions are unchanged.

**Review provenance (evidence closure).** Projections now separate what the independent reviewer said from what the operator decided:
- `gates.review.disposition` is one of `reviewer-pass`, `reviewer-fail`, `operator-override-of-reviewer-fail`, `reviewer-fail-gate-rejected`, `stale-review-ignored`, `missing`, `not-required` or `not-available-for-engine`;
- a completed task carries `completionProvenance`: authority `task-controller`, ledger status, the verification it rests on, `reviewBasis`, and the approved gate's id, revision, `resolvedBy` and `reviewVerdict`.

The TaskController still records a gate approval with its existing `-CodexReviewPassed` flag (unchanged Control Room policy). The Task API never presents that as a reviewer PASS: the basis comes from the reviewer's `review-result.json` verdict and the gate journal, both kept as the authorities. The CLI prints `review basis: operator OVERRIDE of an independent reviewer FAIL (gate approved; the reviewer did not pass)` and `completed by: the TaskController … approved by operator-task-api`.

**Defects fixed:**
1. `gate.cjs resolveGate` dropped `taskInstanceId`. An instance-bound lookup then still saw the *waiting* record, so a second approval with a new request id would validate. The resolution now carries the instance (as `supersedeGate` already did), and the `resolvedBy` parameter is optional with default `operator-gui`.
2. `respondDerived` used the record snapshot from before its `await`, so a concurrent duplicate answer was reported `STALE_ACTION` instead of `duplicate`. It now re-reads the record after the await.

## 3. CLI and GUI contracts

`getStatus` / `getResult` / `follow` add `gates`:

```
gates: {
  review: { policy: "independent-review"|"unavailable-for-engine", required, disposition, state, verdict, attempt, current, findings, blockingFindings, startedAt, finishedAt, reason? },
  gate:   { gateId, status, revision, attempt, reviewVerdict, resolvedBy, createdAt, resolvedAt } | null,
  visual: { required, requirement, status, iteration, maxIterations, reasons[≤3], updatedAt } | null
}
```

A completed managed task adds:

```
completionProvenance: { authority: "task-controller", ledgerStatus, verification: { state, checks, attempt }, reviewBasis, gate?: { gateId, revision, resolvedBy, resolvedAt, reviewVerdict } }
```

New typed status reasons, each with guidance text:

| Status | Reasons |
|---|---|
| `verifying` | `review-running` (`nexus wait` keeps waiting) |
| `blocked` | `review-gate-pending`, `review-rejected`, `review-required`, `review-approved-completion-pending`, `visual-revise`, `visual-exhausted`, `visual-unavailable`, `visual-pending` |

The plain `completion-denied` remains for other TaskController denials.

`respond` accepts the new action ids:

| Answer | Receipt |
|---|---|
| Review | `disposition: accepted, review: running`, or `duplicate` |
| Gate / completion | `disposition: resolved \| completion-rerun \| duplicate`, plus `gateStatus`, `status` and `completion` |
| Refused | `AUTH_REQUIRED`, `NOT_FOUND`, `STALE_ACTION`, `USAGE` (exit 4 or 2) |

The CLI human output prints review, gate and visual lines, the guidance, and one `nexus respond …` line per choice. Non-interactive mode never answers anything. The GUI route serves the same operations through the same table. JSON envelopes and exit codes are unchanged (additive fields only).

## 4. Engine-specific policy differences

| | EMv1 Dual | EMv2 Muse |
|---|---|---|
| Independent review | Yes (strategy `independentReview: true`), only as an explicit operator action; no extra model calls in engineering turns | **None** (strategy `false`): `policy: unavailable-for-engine`, no action, forged action ids `STALE_ACTION`, no reviewer request (real host) |
| Review gate | Existing gate, Control Room approve/reject semantics | n/a (Muse never opens review gates) |
| Visual | Existing loop at verification; turn-end auto-verify **deferred** for managed tasks | Existing loop at verification (Muse had no turn-end auto-verify) |
| Completion | TaskController only | TaskController only |

A reviewer decision never completes a task by itself: completion happens only at verification or through the gate's TaskController transition.

## 5. Evidence provenance and freshness

- **Review candidate binding.** `record.review` carries `turnId`, `attempt`, `actionId`, operator and timestamps. A review counts only if its `turnId` is the current turn and its state is a verdict (`reviewIsCurrent`). Verification passes `reviewUsable`; when it is false, the completion tail treats `review-result.json` as **absent**, so a stale PASS cannot pass and a stale FAIL cannot open a gate.
- **Proven on the real host:**
  - a turn-1 PASS followed by turn 2 and verification gave `review-required`, with the ledger not complete;
  - after a restart killed a running review, even a verdict written later by the orphaned reviewer process did not certify the candidate.
- **Lifecycle instance.** The review result and gate journal are joined by `taskInstanceId` (the existing TASK-0005 rule). Gate resolutions now carry it too (fix 1).
- **Gate provenance.** The journal records `resolvedBy: operator-task-api`, the revision, timestamps and the request id (= action id, replay-protected).
- **Visual.** The status comes only from the controller-owned `visual/state.json` with its reasons and iteration. An unreadable state is shown as `null`, never as a status, and completion follows only the ledger. `unavailable` gives no PASS; the real-host reason recorded was `reviewer not invoked: runtime capture failed (adb was not found…)`.

## 6. Multi-turn interactions

| Invariant | Mechanism / evidence |
|---|---|
| A new turn invalidates stale review and gate action ids | Action ids embed turn seq and run; the old id gets its old receipt (`duplicate`) and never runs again (unit) |
| Older review evidence cannot verify a newer candidate | §5 (unit and real host) |
| Review / gate cannot race a continuation | One winner at the same revision (unit); a running review or gate refuses continuation |
| Verification cannot complete with unresolved gates | The TaskController still decides; projection reasons explain the gate (unit and real host) |
| After verification started, P2-B2E restrictions hold | Unchanged (`verification-started`) |
| No silent reopening; no replay after uncertain reviewer work | Interrupted review is not re-run; re-run only as an explicit new action |

## 7. Restart and crash outcomes

| Boundary | Outcome |
|---|---|
| Gate action reservation | Durable intent, then the journal; restart → `interrupted`, journal is the truth |
| Review startup / in flight | Restart → `interrupted`; **no second reviewer request** (real host: 1 request); explicit re-run `n2` offered |
| Review evidence write after the crash (orphaned reviewer) | Ignored: the review is not current, so it never counts (real host) |
| Gate journal written, completion not run | Restart → `review-approved-completion-pending`; the old action returns `duplicate` with no second resolution (journal `waiting → approved` once); completion only via `act_complete` (unit) |
| Completion tail during verification | P2-B2D rule: the verification becomes `interrupted` and blocks; never a PASS |
| Shutdown and restart | Actions are reconstructed from durable state where safe (review re-run, completion re-run); otherwise typed holds |

Managed identity, idempotency keys and tombstones are untouched; this phase adds no identity writes.

## 8. Full final-tree regression

**Source identity.** HEAD `2070c617`, plus the working tree (`evidence/p2b2f/source-identity-final-lane.txt`). Both hashes cover all non-docs source: `git diff HEAD` over staged and unstaged changes, and the untracked files (name and content).

| Hash | Captured before the lane | Re-checked after it finished |
|---|---|---|
| Tracked diff sha256 | `d5ac9788…bf8cdc8` | identical |
| Untracked source sha256 | `fd738264…91e26428` | identical |

The lane therefore ran on the exact final code; only `docs/` changed afterwards (this report and evidence).

**Run** (`evidence/p2b2f/lane-environment.txt`):

| | |
|---|---|
| Command | `pwsh -NoLogo -NoProfile -File scripts/Test-Harness.ps1 -InstallRoot <fresh root> -Lane production -ContinueOnFailure -ReportPath …/production-p2b2f-final.json` |
| Install | Fresh disposable root (`mkroot.sh`, then `Install-NexusPresets.ps1`) with the **standard production DSH** `@deepseek-ai/dsh@0.2.2-rc.1` |
| Runtimes | node v24.18.1, pwsh 7.5.3 |
| Platform | macOS 27.2 arm64 |
| Isolation | Isolated HOME/TMPDIR; egress proxied to a dead port; provider keys unset |
| Window | 2026-11-11 09:24:01Z → 09:41:56Z (**1,075 s**) |
| Raw results | `evidence/p2b2f/production-lane-final.json` |

| Metric | P2-B2E final | **P2-B2F final tree** |
|---|---|---|
| Lane rows | 126 | **128** (+`NexusTaskGates`, +`NexusTaskGatesRealHost`) |
| Rows passing | 124 | **126** |
| Assertions passed | 3,377 | **3,388** |
| Assertions failed | 2 | **2** |

**Failures (2), both pre-existing, unchanged since the P2-B2C baseline and unrelated to any P2-B2F file:**

| Row | Result | Classification |
|---|---|---|
| `ContextRestrictedProductionV2` | 0 passed / 1 failed; fails on load | Pre-existing (P2-B2C, P2-B2D and P2-B2E lanes identical) |
| `Harness` | 230 passed / 1 failed: `source contains no credential values` | Pre-existing (identical message in every baseline) |

Neither is weakened, excluded or reclassified as passing. No failure is environmental, and none was introduced.

**Rows touched by P2-B2F, all passing in the lane:**

| Row | Passed | Duration |
|---|---|---|
| `NexusTaskGates` | 9/9 | 3.1 s |
| `NexusTaskGatesRealHost` (production mode) | 2/2 | 13.1 s |
| `NexusTaskContinuation` | 6 | |
| `NexusTaskContinuationRealHost` | 2 | |
| `NexusTaskVerification` | 8 | |
| `NexusTaskVerificationRealHost` | 2 | |
| `NexusControllerPanel` (exercises `gate.cjs`) | pass | |
| `AihControllerIdentity` (gate identity) | 7 | |
| `NexusCli` | 9 | |
| `NexusTaskApi` | 7 | |

Patched-PoC real-host suites run on the same final code are in §9.

## 8a. Gate concurrency semantics (duplicate receipt vs stale refusal)

The real-host concurrent CLI + GUI approval produced `["STALE_ACTION","resolved"]`. This is **expected** under the revision and replay contracts:
1. The winner first persists its durable intent (`gateAction.state = running`). That annotation is a compare-and-swap on the record revision, so the task's view revision changes immediately.
2. A competitor whose answer is checked after that point is refused `STALE_ACTION`, because the revision changed or the action is no longer offered. It is refused, not queued, and has no effect.
3. A request with the **same action identity** arriving **after** the winner settled gets a `duplicate` receipt (the recorded outcome), with no second gate call and no second completion.

So `duplicate` = "this exact answer was already accepted; here is its result", and `STALE_ACTION` = "your view is out of date; nothing happened". Both are non-mutating.

Proven by `NexusTaskGates` unit group 9 (final code):

| Claim | Evidence |
|---|---|
| The journal resolves at most once | Concurrent approve (CLI) vs reject (GUI) on one revision: exactly one `resolved`, the loser `STALE_ACTION`, journal `[waiting, <winner>]` |
| Final status follows the winning decision | completed after approve / blocked after reject |
| The same accepted identity does not repeat completion | `duplicate`; gate-port call count and ledger unchanged |
| Different identities cannot override the winner | A new request id against the journal gives `gate-not-waiting` (needs the `taskInstanceId` fix); a forged action id gives `STALE_ACTION`; journal unchanged |
| Stale replies create no work | Verification and review call counts unchanged across all stale, forged and duplicate answers |
| In-flight duplicate | The same action id answered while the first is in flight gives `STALE_ACTION`; the first resolves; afterwards the same id gives `duplicate` |

## 9. Patched PoC real-host evidence

Disposable install with the allowlisted gateway PoC and final code (`evidence/p2b2f/`). The reviewer is a local synthetic endpoint (`AIH_OAUTH_BASE_URL` on 127.0.0.1) that counts requests.

`NexusTaskGates.RealHost` patched: **7/7**

| Group | Result |
|---|---|
| Ordinary GUI `/review` (Dual) | Unchanged: `review-result` notice, verdict pass, 1 reviewer request, 0 engineering model calls |
| Managed Dual | run-review gives verdict PASS for the current candidate (1 request); verification → **completed** (ledger `complete`); same action ids in GUI and CLI; 0 engineering model calls during review and verification |
| Managed Muse | `unavailable-for-engine`; forged review action exit 4 `STALE_ACTION`; 0 reviewer requests |
| Managed Dual FAIL | Gate offered only after verification passed; concurrent CLI + GUI approve gave outcomes `["STALE_ACTION","resolved"]` (§8a); journal `waiting → approved (operator-task-api)`; **completed**. Provenance: `review-result.json` verdict still `fail`; `disposition` and `completionProvenance.reviewBasis` = `operator-override-of-reviewer-fail`; gate r2 resolved by `operator-task-api`; GUI provenance identical; CLI prints the override line and never "reviewer PASS". The Dual PASS task shows `reviewBasis: reviewer-pass` |
| Multi-turn stale review | `review-required`; ledger `verifying`, not complete |
| Visual-required Dual | Turn-end auto-verify **deferred** (1 deferral event, 0 automatic-visual events; requirement shown as `pending` before verification). Operator verification runs the visual loop → `visual-unavailable` (no capture runtime); close only; ledger not complete |
| Restart during review | `interrupted`; 1 reviewer request in total; re-run `n2` offered; never completed |

Other real-host suites:
- `NexusTaskGates.RealHost` production: 2/2 (ordinary `/review` parity; managed submit and continue refused).
- Patched regressions on the final code: Continuation 7/7, Verification 5/5, ManagedTasks 13/13, DurabilityRestart 6/6, ColdRestore 3/3.

Unit coverage (`NexusTaskGates`, **9/9**; log `evidence/p2b2f/unit-NexusTaskGates.log`). Group 9 covers concurrency and provenance (§8a); groups 1–8:
- Dual lifecycle, including a concurrent duplicate review;
- Muse policy;
- the gate's approve/reject, unauthorized, stale and unknown-choice answers, and a concurrent approve producing exactly one journal resolution;
- multi-turn freshness;
- races (review vs verification, review vs continuation, refusals while a review runs);
- visual unavailable / revise / exhausted / pending / pass / unreadable;
- restart during review and during a gate action;
- foreign workspace.

## 10. Remaining functional limitations

- Review is only available **before** verification, for the current candidate. A review-required task verified without a review is `review-required` with close only (the GUI flow also reviews before `/verify`).
- No re-verification after an outcome (P2-B2D/E rule). A visual `revise` or `unavailable`, or a rejected gate, cannot be repaired inside the managed task: close and start a new task. The guidance says so.
- Visual `exhausted` has no operator override (existing policy). No visual capture or upload action exists for managed tasks (none exists in the existing gate system to reuse).
- The review question is the task's user instructions; there is no free-text question parameter in `respond`.
- The context-quality guard can reject a review (`rejected`, re-run offered); that is existing reviewer behavior.
- The real-host reviewer is synthetic. The real review service, OAuth and model are not exercised (no paid calls).
- Native evidence covers macOS arm64 only.

## 11. Rollback guidance

1. Revert the P2-B2F hunks:
   - `AihController.cjs`: the two hooks, the `report`/`reviewUsable` plumbing, `completionSummary`, the visual deferral and `turnControllerManaged`;
   - `managed-tasks.cjs`: `runReview`, `resolveGateAction`, the review/gate locks and reconcile, the `reviewUsable` pass-through;
   - `task-api.cjs`: the gate snapshot, reasons, actions and the `respondDerived` re-read;
   - `controller.cjs`: the `review`/`gate` ports;
   - CLI rendering (including the provenance lines and the `describeTask` export), lane rows and the two new tests;
   - the review-provenance fields (`gates.review.disposition`, `completionProvenance`), which are additive and read-only.
2. Keep or revert the `gate.cjs` fix independently. Keeping it is recommended: it only adds `taskInstanceId` to resolution records and defaults `resolvedBy`.
3. Records with `review` / `gateAction` fields stay readable by older code (unknown fields). Journal records written by the Task API look like Control Room records (`resolvedBy` differs).
4. With the deferral removed, Dual managed visual tasks would again auto-verify at turn end (the pre-P2-B2F behavior).

## 12. Verdict

**P2-B2F: GO — complete** (evidence closed on 2026-11-11). It rests on completed tests, all on the identical final source (§8 identity):

| Area | Evidence |
|---|---|
| Final-tree lane | 128 rows, 126 pass, 3,388 assertions passed; only the 2 documented pre-existing failures (§8) |
| Unit | `NexusTaskGates` 9/9, `NexusTaskVerification` 8/8, `NexusTaskContinuation` 6/6 |
| Real host, patched PoC | `NexusTaskGates` 7/7; Continuation 7/7, Verification 5/5, ManagedTasks 13/13, DurabilityRestart 6/6, ColdRestore 3/3 |
| Real host, standard DSH | `NexusTaskGates` 2/2: managed submit and continue refused |
| Provenance | An operator override is reported as such, never as a reviewer PASS (§2, §9) |
| Concurrency | The gate journal resolves at most once (§8a) |

No placeholders remain.

Supporting conclusions:
- Supported review gates (Dual explicit review, existing gate, completion re-run) and visual gates (status, typed reasons, enforcement at verification) are handled through the shared Task API without weakening any requirement.
- Muse and Dual policies are preserved.
- CLI and GUI expose the same outcomes and action ids.
- No task completed with missing, stale, failed, interrupted or unverifiable evidence in any test.
- All real-host proofs pass, the full final-tree lane is within the documented baseline (§8), and unpatched DSH still refuses managed submission and continuation.

Stopping at P2-B2F.

## 13. Remaining prerequisites for a production release

- DSH `gateway/authorize` upstream, or an authorized pinned gateway build with installer integration.
- Linux and Windows native real-host qualification.
- Real review-service integration test (OAuth/provider) in a controlled environment.
- A repair path after a visual `revise` and post-verification review for managed tasks (needs an explicit design for re-verification and a new attempt).
- A visual evidence capture and upload UX for environments without a capture runtime.
- Multi-question approvals; task linkage after terminal outcomes; retention policy for intake records, tombstones and gate journals.
- Signed CLI packaging and a security-reviewed production admission switch.
