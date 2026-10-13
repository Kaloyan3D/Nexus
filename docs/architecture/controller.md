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
7. handles explicit controller-owned commands such as `/verify` and independent review paths;
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

A generic feeling that a task is difficult is not enough to hand authority to a reviewer model.

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

Review is intentionally narrow, regardless of which model the active profile
binds to the reviewer role (this phase: the local Codex/OAuth adapter):

- fresh review request;
- bounded packet;
- read-only by default;
- enforced call/file/diff/context/output limits;
- no global completion authority;
- review result returns to controller/deep-engineer repair flow (same profile);
- reviewer is never the task's root executor.

Writable `solver` execution is exceptional and requires explicit user
approval (`-UserApprovedCodexSolve` — parameter name kept for compatibility).

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

## Preparing an engineering session before its first prompt

The controller publishes a Cordis host extension in its mounted scope:

```js
const controller = require('./config/AihController.cjs')
const authority = await controller.prepareSession(ctx, {
  sessionId,                    // existing root session in ctx.sessions
  cwd,                          // absolute, exact immutable session cwd
  preset: 'aih-muse',            // effective host session preset
  profileId: 'muse-spark-1.3-contributor-opencode',
})
// { sessionId, taskId, taskInstanceId, engine, profile, provider, model }
```

This is an in-process host API over the bounded `nexus/session-prepare` Cordis
waterfall extension. It registers no process-global service from the preset.
Hosts must mount the production controller and
load/create the session in the DSH session store before calling it. It does not
add a DSH RPC method or change `session.create`. The caller cannot supply task
IDs, engine, provider, model, messages, or arbitrary options. Supported presets
are `aih-engineering`, `aih-deepseek`, and `aih-muse`; DeepSeek retains its locked
`deepseek-codex` profile. Selection uses the existing production router, including
Muse provider availability and Dual role validation, with an explicit session
profile instead of changing the global preference.

Both preparation and the ordinary first prompt call `bindSession`. Preparation
uses the same workspace resolver, TaskController allocator, routing decision,
and engineering lifecycle initializer. It creates the normal task ledger,
run manifest/native authority, session binding, and routing state. The initial
task description is the content-free label `Prepare engineering session`.
Preparation emits no session message, starts no attempt, constructs no agent,
and invokes no model, provider, remote counter, or reasoning step.

The binding and task allocation retain the selected profile; subsequent routing
and Dual step resolution consume that controller selection. Repeated compatible
calls return the same seven authority fields and immutable task instance.
Compatible ordinary bindings can be reused.
Controllers mounted before preparation reread the committed prepared binding
before binding their first turn and preserve prepared entries during writes.
Wrong cwd/preset, stale task identity, profile/engine/target drift, conflicting binding or routing state,
and malformed persisted authority reject without replacing existing authority.
The session allocation key is generated inside the controller and committed
under the task-ledger mutex. A retry after interruption resumes that allocation
and completes missing creation/routing artifacts instead of allocating another
task. Preparation calls sharing this controller module and install are serialized.

Success follows atomic binding persistence, file durability barriers for task
and routing authority, and a flushed content-free `nexus-session-prepared`
controller diagnostic containing the returned authority plus `new`/`reused`
status. Write failures reject; retries preserve the allocated instance. The
ordinary lazy-binding caller continues using its existing guard and defaults.
No existing file migration is required; added fields and routing arguments are
optional. There is no separate binding schema or benchmark-specific path.

The contract tests use isolated config/data/workspaces, real PowerShell
controller commands, and real DSH sessions with provider/network transports
blocked. They cover creation, reuse, conflicts, restart/interruption, first-turn
compatibility, exact DeepSeek/Muse selection, and unchanged isolation enforcement.
