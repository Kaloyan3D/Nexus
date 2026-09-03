# Task, attempt, verification, review, and gate lifecycle

Nexus separates durable task state from model conversation state. This document describes the current lifecycle contract.

## Task lifecycle

A task is bound to a session/workspace and progresses through controller-owned state.

A simplified path is:

```text
ready
-> implementing
-> verifying
-> complete
```

Failure/recovery paths can include:

```text
implementing / verifying
-> failed
-> retry (new attempt when allowed)
```

`cancelled` is reserved by the task model where supported.

The task state and the attempt state are related but not identical. A task may survive multiple attempts.

## Attempt lifecycle

An attempt represents one real engineering execution cycle.

```text
started
-> verifying
-> passed | failed | interrupted
```

Key rules:

- attempts are sequential (`1`, `2`, ...);
- the open-attempt guard prevents duplicate starts;
- reload/reconnect does not create another attempt;
- a retry can begin only after the previous attempt is terminal;
- attempts are bounded by task policy (`maxAttempts`);
- old tasks with no attempt history remain readable; the UI renders missing attempt identity as `—` instead of inventing Attempt 0.

Attempt records may include the originating session and GUI turn (`sessionId`, `startedByTurn`) plus producer timestamps.

## Verification lifecycle

Verification is an executable controller path, not a semantic claim from the model.

```text
open attempt
-> verifying event
-> Verify-Project.ps1
-> per-check results
-> evidence.json
-> passed or failed attempt
-> completion/review/gate policy
```

### Verification evidence

Current evidence can include:

- evidence schema version;
- attempt number;
- overall start and finish timestamps;
- verification rows with name, kind, status, command, exit code, attempt, start, finish;
- scope/acceptance information when available.

The Control Room derives durations only when timestamp pairs exist.

### PASS / FAIL semantics

For a completed verification:

```text
any required failed check -> overall FAILED
all required executed checks pass -> overall PASSED
```

A completed run with one PASS and one FAIL is not displayed as a vague `partial`; it is failed.

### Non-zero verifier exit

`Verify-Project.ps1` may intentionally exit non-zero after producing valid structured JSON that contains failed checks.

The controller treats that as a valid failed verification when the output matches the verification contract. It is not automatically an infrastructure exception.

### Infrastructure/incomplete verification

If no trustworthy completed evidence exists, Nexus does not manufacture normal failed-check evidence.

A stale `verifying` attempt with no matching finished evidence is reconciled as:

```text
interrupted
reason = verification-incomplete
```

## Completion lifecycle

After a passed attempt/verification, the controller performs the completion check.

If all completion requirements are satisfied:

```text
attempt passed
-> task complete
-> completedAtUtc written
```

The Activity view may then render a `Task completed` event using the authoritative `completedAtUtc` timestamp.

No synthetic completion timestamp should be invented by the UI.

## Visual verification lifecycle (Phase V2)

Visual verification is a **separate controller state machine** layered on
top of the engineering attempt lifecycle — it never overloads attempt
identity, never reopens/rewrites terminal attempt history, and never
replaces deterministic verification:

```text
engineering attempt(s) → deterministic verification PASS
  → visual requirement detected (none | recommended | required)
    ├─ none / recommended → completion gate unaffected (no automatic vision)
    └─ required → automatic loop (controller-owned, max 3 iterations)
         pending → reviewing → (REVISE → revise → repair → fresh /verify →
                    reviewing)* → pass | exhausted | unavailable
```

### Completion requirement

`Test-AihTaskCompletion` enforces: a visual-REQUIRED task must not complete
while visual status is `pending`, `reviewing`, `revise`, `exhausted`, or
`unavailable`. Completion additionally requires deterministic verification
to be all-PASS. If a visual state ever claims `humanAcceptance: true`,
completion is blocked with a fabrication-guard reason — human acceptance is
EXTERNAL (V3 gate) and is never auto-recorded by any component.

### Ordering invariant

The loop runs in the bridge completion tail AFTER deterministic verification
passed, and after a repair handoff the loop requires a FRESH deterministic
verification (newer evidence attempt) before recapturing. The ordering
`repair → /verify → capture → review` is structural, not conventional.

### Convergence

- `pass` — the engineering task may complete; the controller message carries
  `VISUAL_REVIEW_PASS · HUMAN_REVIEW_PENDING` (no auto-commit).
- `exhausted` (3 iterations) / `unavailable` (capture or provider failure) —
  completion stays blocked; operator attention requested; attempt history
  remains untouched and terminal.
- verification failure — exits the visual loop into normal engineering
  failure semantics.

### Manual override

`/visual-review` remains a manual operator override with `trigger=manual`;
manual results are recorded in `state.manualReviews` and never advance or
corrupt the automatic iteration state. The trigger (manual vs automatic) is
never conflated anywhere in telemetry or messages.

## Review lifecycle

A task may require independent review because of policy, repeated evidence-backed failure, a critical boundary, or explicit user intent.

Typical path:

```text
DeepSeek work
-> verification/failure evidence
-> review requirement
-> review-packet.json
-> fresh independent Codex review
-> review-result.json
-> DeepSeek repair / completion policy
```

The review result is linked to task identity and, where available, the relevant attempt. Review is not the root executor and does not gain global completion authority.

## Operator gates

When policy requires explicit operator disposition, the controller creates an append-only gate transition.

Example:

```text
gate revision 1
status = waiting
allowedActions = [approve, reject]

operator approves
-> validated gate action
-> gate revision 2
status = approved
resolvedAtUtc / resolvedBy / actionId recorded
```

The UI displays `WAITING FOR OPERATOR` / `OPERATOR ACTION REQUIRED` when a live gate is waiting.

The browser renders only `allowedActions` from the gate. Generic actions such as force-complete, reroute, skip-verification, or arbitrary ledger editing are not implied by the Control Room.

## Gate idempotency / stale safety

Gate actions carry a request identity and are validated against current gate state.

Sequential duplicate actions after the gate already resolved fail as not-waiting. A replay path exists for the race window where identical requests arrive while the gate is still open.

Stale gate identities/revisions are rejected rather than applied to newer state.

## Activity semantics

Activity is lifecycle-oriented, not a raw dump of every stored record.

Typical rows include:

```text
Task created
Routed
Execution class selected
Attempt started
Verification started
Verification finished · N passed · M failed · Ns
Attempt finished
Task completed
Gate opened/resolved (when applicable)
```

Verification start is emitted once semantically. If an authoritative attempt `verifying` event exists, it wins; evidence start is a legacy fallback rather than a second activity event.

Individual verification checks belong in the Verification tab instead of flooding Activity.

## Reload/restart invariants

Reloading the UI must not add lifecycle rows.

Restarting Nexus must preserve durable task/attempt/evidence/gate state and must not silently increment the attempt number.

## Backward compatibility

Readers are schema/version/optional-field tolerant. Older tasks can lack:

- attempts;
- timestamps;
- evidence schema v2 fields;
- review metadata;
- gates.

The UI should omit unavailable data or show a neutral not-run/unknown state rather than inventing modern records.