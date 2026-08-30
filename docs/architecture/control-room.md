# Control Room architecture

The Nexus Control Room is an observer/operator surface over controller-owned state.

It exists in two layers:

1. a lightweight **compact Controller drawer** for current status;
2. an expanded **Task Control Room** for lifecycle detail.

The key design rule is that the UI renders authoritative records; it does not reconstruct engineering truth from conversation text or polling deltas.

## Compact Controller

The compact drawer answers: **what is Nexus doing right now?**

Typical fields include:

- controller state (`READY`, `WORKING`, `VERIFYING`, `WAITING`, `IDLE`, etc.);
- bound task;
- current attempt;
- effective executor/model effort;
- execution class;
- operator-gate signal.

It uses the lightweight endpoint:

```text
GET /nexus/controller.json?session=<id>
```

The compact path polls more frequently than the detailed room and intentionally avoids expensive detail reads.

## Full Task Control Room

The expanded room answers: **how did this task get here, what actually happened, what verification ran, and is operator action required?**

It contains four tabs.

### Overview

Shows high-level task truth:

- task identity/state;
- attempt sequence/status;
- root executor;
- execution class;
- routing/review/gate summary;
- operator-action panel when a gate is waiting.

### Activity

Shows lifecycle events in chronological order.

The adapter composes rows from authoritative routing, task-decision, attempt, evidence, completion, and gate records.

Important truthfulness rules:

- a verification run has one semantic `Verification started` row;
- the attempt `verifying` event is preferred over evidence-start fallback;
- verification completion includes real pass/fail counts and derived duration;
- task completion appears only when an authoritative `completedAtUtc` exists;
- reload does not create activity events.

### Verification

Shows verification evidence for the bound task/attempt.

For completed verification it renders an explicit overall status:

```text
PASSED
N passed · 0 failed
```

or:

```text
FAILED
N passed · M failed
```

Per-check data comes from evidence records and can include:

- check name/kind;
- PASS/FAIL;
- command;
- exit code;
- start/finish timestamps;
- derived duration;
- attempt linkage.

Missing values are omitted; the UI does not invent timestamps or durations.

### Files

Shows live Git working-tree/index state for the bound workspace using porcelain/numstat-derived data.

It is intended for visibility, not as an unrestricted Git mutation surface.

## Detailed endpoint

The expanded room uses:

```text
GET /nexus/control-room.json?session=<id>
```

The server resolves the session binding to the authoritative workspace/task identity before reading detail state.

Typical envelope sections include:

- state / binding / task;
- execution;
- routing history;
- lifecycle/activity;
- attempts;
- verification;
- failures;
- reviews;
- gates;
- Git/files;
- controller health.

The detail path is cached against source-file changes with a bounded lifetime; Git detail has its own shorter cache.

## Execution class, role, profile, provider, model (Phase 2)

The Control Room reports the **effective** execution, never the configured
name alone:

- **Execution class** — canonical semantics (`engineer_normal`,
  `engineer_deep`, `reviewer`, `solver`, `deterministic`); legacy class
  names in old records stay readable and display through the canonical labels;
- **Role** — `primaryEngineer`, `deepEngineer`, `reviewer`, `solver` —
  from the routing decision when present, else derived from the class;
- **Profile** — the active engineering profile (id + display name) that
  produced the running model;
- **Provider / model / reasoning** — the concrete endpoint and effort from
  the routing record.

Additionally the room shows a **Preferred profile** (operator choice from
`engineering-profile:` in settings.yaml) next to the preferred root executor.
PREFERRED (configuration) and RUNNING (decision record) are never collapsed:
a GLM preferred profile can coexist with a running DeepSeek decision and vice
versa.

## RUNNING vs PREFERRED

Nexus intentionally shows two different concepts near the composer:

- **RUNNING** — the model/effort effectively routed for this task;
- **PREFERRED** — the session-preferred model/effort ceiling.

Example:

```text
RUNNING   · DeepSeek V4 Flash · HIGH
PREFERRED · DeepSeek V4 Flash · MAX
```

A MAX preference does not force every task to execute at MAX if deterministic routing selects HIGH.

## Root executor semantics

The root executor is the task's primary route. Later review/escalation records do not replace it.

A `reviewer` record remains review metadata; it does not make the reviewer model appear as the task's root engineer.

## Operator gates

Phase 4 extended the Control Room from pure observation to **bounded operator control**.

When the controller exposes a waiting gate, Overview can render:

```text
OPERATOR ACTION REQUIRED

[ Approve ] [ Reject ]
```

Only actions present in the gate's `allowedActions` are rendered.

The browser sends a bounded request to:

```text
POST /nexus/gate-action.json
```

The server validates the session/gate/action/request against current controller state before mutation.

The browser never edits gate/task ledger files directly.

## Extension-seat decision

The Control Room does **not** register into DSH's native `details` single-seat surface.

Nexus uses additive extension points (notably `shell.overlay` plus header/composer seats) so native DSH Details remains intact.

This avoids the earlier single-slot ownership conflict and keeps Nexus additive instead of replacing upstream functionality.

## Responsive behavior

The compact drawer and expanded room are responsive overlays rather than shell-grid replacements.

The Control Room has been acceptance-tested at desktop, medium, and narrow/mobile widths. Narrow layouts may collapse model text while retaining effort/state and full tooltip information.

## Polling model

Nexus currently uses polling rather than SSE/WebSockets for Control Room state.

This is intentional: lifecycle truth is already durable and append-only where needed, so polling is a presentation transport rather than the source of events.

A future SSE/delta transport can reduce repeated reads without changing the producer/storage contracts.

## Fail-closed rendering

Subsystems degrade independently.

Examples:

- corrupt routing history does not erase valid attempts;
- corrupt/missing evidence becomes unavailable/not-run rather than fabricated PASS;
- Git failure affects Files rather than the whole room;
- unbound sessions return idle/unavailable state;
- stale gate actions are rejected;
- old tasks without modern fields remain readable.

## Source files

The current Control Room implementation is centered around:

```text
config/AihController.cjs
ui/nexus-controller/lib/index.js
ui/nexus-controller/lib/status.cjs
ui/nexus-controller/lib/detail.cjs
ui/nexus-controller/lib/gate.cjs
ui/nexus-controller/lib/engineering.cjs
ui/nexus-controller/lib/client.js
```

## Phase 2.1: Engineering Profile editor

The room gained an **Engineering** tab: a compact operator editor that picks
the PREFERRED engineering profile (built-ins or Custom) and binds each role to
a registered model. Reads are served by
`ui/nexus-controller/lib/engineering.cjs` (pure adapter over the same files
the controller reads); writes go through
`POST /nexus/engineering-profile-action.json` → `scripts/EngineeringProfile.ps1`
which validates capabilities and writes atomically. See
[engineering-profiles.md](engineering-profiles.md) for the full contract.

For detailed phase history and upstream-patching notes, see [../nexus-ui.md](../nexus-ui.md).