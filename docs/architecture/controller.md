# Controller and authority

The Nexus controller is the deterministic authority layer between the user-facing DSH session and the model/provider execution paths.

Its job is not to replace the coding model. Its job is to make engineering state, policy, and completion explicit and durable.

## What the controller owns

The controller owns:

- session -> workspace/task binding;
- task creation and task state;
- routing decisions and execution classes;
- attempt start, sequence, and terminal outcome;
- failure signatures and bounded escalation inputs;
- verification invocation and evidence registration;
- completion checks;
- review requirement and review packet policy;
- operator-gate creation/resolution;
- persistent state needed to resume after reload/restart;
- notices exposed to the GUI.

The model does **not** become authoritative by stating that a task is complete, verified, reviewed, or safe.

## GUI bridge

`config/AihController.cjs` connects DSH's GUI turn lifecycle to the controller.

For normal engineering turns it:

1. resolves/binds the session;
2. ensures the current task identity;
3. records/runs routing as needed;
4. reconciles any stale open verification state;
5. starts a real attempt at the producer boundary when appropriate;
6. exposes the selected execution class to the model/runtime;
7. handles explicit controller-owned commands such as `/verify` and bounded review paths;
8. emits controller notices back into the session.

The GUI does not call `begin-attempt` directly. This keeps attempt creation tied to the real execution producer rather than browser behavior.

## Attempt producer rule

A real engineering execution creates one attempt:

```text
Attempt 1: started
  -> verifying
  -> passed | failed | interrupted
```

A second attempt may begin only after the prior attempt has closed and policy still allows another attempt.

The following do **not** create an attempt:

- browser reload;
- reconnect;
- Control Room polling;
- opening or closing the Controller drawer;
- switching Control Room tabs;
- reading state.

## Completion authority

Completion is controller-owned and evidence-based.

A simplified completion contract is:

```text
acceptance criteria accounted for
+ required verification PASS
+ required architecture/scope checks PASS
+ evidence present
+ review PASS when policy requires review
= complete
```

The exact implementation remains the authority; documentation should not be used to weaken controller checks.

## Failure and escalation

A failure is recorded as controller state, including a normalized signature where applicable. Routing policy can use repeated evidence-backed failure or critical signals to select deeper DeepSeek reasoning or bounded review.

A generic feeling that a task is difficult is not enough to hand authority to Codex.

## Verification authority

`/verify` is controller-owned. Verification output is treated as data, not as model prose.

An important contract is that a verification process may:

- execute successfully,
- produce valid structured JSON,
- report one or more failed checks,
- and exit non-zero.

That is a **valid failed verification**, not automatically an infrastructure crash.

The GUI bridge recovers verification-shaped JSON from the non-zero process result, records evidence, and closes the same attempt truthfully.

If the verifier cannot produce valid evidence because of launch failure, malformed output, interruption, or similar infrastructure failure, Nexus must not fabricate normal failed-check evidence.

## Crash reconciliation

At a later producer boundary, an attempt left `verifying` is reconciled before a new attempt may start.

```text
verifying + matching finished evidence
  -> passed or failed from evidence

verifying + no finished matching evidence
  -> interrupted (verification-incomplete)
```

This prevents restarts from creating silent Attempt N+1 records or leaving permanent zombie `verifying` state.

## Review authority

Codex review is intentionally narrow:

- fresh review request;
- bounded packet;
- read-only by default;
- enforced call/file/diff/context/output limits;
- no global completion authority;
- review result returns to controller/DeepSeek repair flow.

Writable `codex_solve` is exceptional and requires explicit user approval.

## Operator-gate authority

A gate is controller state, not a UI prompt invented by the browser.

The current gate declares its `allowedActions`. The UI renders only those actions.

A gate action request is validated server-side against:

- session binding;
- gate identity;
- workspace/task identity;
- current revision/state;
- whether the action was advertised;
- request identity/replay state.

The browser sends bounded identifiers. It does not edit task/gate ledgers directly.

## Persistence boundary

Only durable binding fields are written to the binding store. Runtime-only objects such as live DSH session handles must never be serialized.

This is a deliberate whitelist boundary: adding a runtime field to an in-memory binding must not silently make it persistent.

## Fail-closed rule

When controller truth is unavailable or ambiguous, the preferred behavior is to expose unavailable/idle/error state rather than invent success, a route, a duration, a gate, or an execution event.