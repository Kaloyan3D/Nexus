# HTTP endpoint reference

Nexus exposes a small local HTTP surface for the Controller / Control Room UI. These endpoints are registered through the DSH/Cordis web-server lifecycle and are intended for the local Nexus client.

They are not a general remote-control API.

## `GET /nexus/controller.json`

Lightweight current-state endpoint used by the compact Controller and composer executor indicators.

### Request

```text
GET /nexus/controller.json?session=<sessionId>
```

The server resolves the session ID to its authoritative binding. The browser does not supply a trusted workspace/task path.

### Typical responsibilities

- controller readiness/state;
- bound task identity;
- current task/attempt summary;
- effective executor / execution class;
- compact verification/gate signal;
- preferred-vs-running model information where available.

This endpoint is intentionally cheap enough for frequent polling.

### State semantics

Display states may include values such as:

```text
idle
ready
working
verifying
waiting-for-operator
unavailable/error
```

Exact serialized names are implementation authority. The important rule is that a waiting operator gate must not be collapsed into a generic healthy/idle state.

## `GET /nexus/control-room.json`

Detailed endpoint used by the expanded Task Control Room.

### Request

```text
GET /nexus/control-room.json?session=<sessionId>
```

The session resolves server-side to normalized workspace + task identity.

### Typical envelope

The detailed snapshot can include sections such as:

```text
schemaVersion
generatedAtUtc
state
binding
task
execution
routingHistory
lifecycle / activity
attempts
verification
failures
reviews
gates
git / files
controller
```

### Activity

Activity is derived from authoritative lifecycle records rather than UI polling changes.

Current semantics include one verification-start row per run, a verification-finished summary, attempt terminal events, and task completion only when `completedAtUtc` exists.

### Verification

Verification summary reflects evidence truth:

```text
any required FAIL -> failed
all required executed checks PASS -> passed
not executed -> not-run
```

Per-check fields can include name, kind, status, command, exit code, attempt, timestamps, and derived duration.

### Failure isolation

A broken detail subsystem should degrade independently. For example, unavailable Git data should not erase valid attempts or verification.

### Caching

The detailed snapshot is cached against source-file changes with a bounded maximum lifetime; Git detail uses a shorter cache. Polling is transport, not the producer of lifecycle events.

## `POST /nexus/gate-action.json`

Bounded operator-gate action endpoint.

### Request body

The browser sends identifiers only:

```json
{
  "sessionId": "session-...",
  "gateId": "gate-...",
  "actionId": "approve",
  "requestId": "client-generated-id"
}
```

The browser does not send an authoritative workspace, task mutation, completion flag, or arbitrary ledger patch.

### Validation

The server validates the request against current controller state, including:

1. session binding;
2. session/gate identity;
3. gate staleness/current revision;
4. gate waiting state;
5. whether the action is advertised in `allowedActions`;
6. request replay/idempotency state;
7. the bounded controller transition for that action.

### Expected failure classes

Depending on validation order/current state, failures can include concepts such as:

```text
session-unbound
session-mismatch
gate-stale
gate-not-waiting
action-not-advertised
action-not-allowed
request replay/idempotency result
```

Stale/invalid actions fail closed.

### Approve / Reject

Current operator gates can advertise bounded actions such as `approve` and `reject`.

Approval may invoke a controller completion path only when the underlying deterministic requirements permit it. It is not a browser-side force-complete operation.

Reject resolves the gate according to controller policy; it does not rewrite arbitrary task history.

## HTTP behavior

Controller endpoints are local UI infrastructure and use JSON with UTF-8 semantics. Detailed/compact read paths are designed to return a controlled idle/unavailable envelope rather than crash the entire client for common missing-data conditions.

## Security notes

- Treat `sessionId` as a lookup key, not as sufficient authority by itself.
- Resolve workspace/task identity server-side.
- Do not add endpoints that accept raw file paths or arbitrary ledger mutations from the browser.
- Do not expose review packets, evidence artifacts, or filesystem contents without an explicit authorization/design decision.
- Preserve stale/duplicate gate protection when extending operator actions.

## Transport roadmap

The Control Room currently polls. A future SSE/delta endpoint may improve efficiency, but it should preserve the same producer/storage contracts and server-side identity rules.