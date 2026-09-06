# State and storage reference

Nexus keeps engineering truth outside model context. This document summarizes where current state lives and how readers should interpret it.

## Project-scoped state

The primary project ledger lives under the workspace's `.ai-harness` directory.

```text
.ai-harness/
  project.md
  architecture.md
  conventions.md
  state/
    objective.json
    tasks.json
    decisions.jsonl
    learnings.jsonl
  runs/
    TASK-NNNN/
      manifest.json
      attempts.jsonl
      evidence.json
      context-manifest.json
      review-packet.json
      review-result.json
      telemetry.json
      artifacts/
      summary.md
```

Not every task has every artifact. Readers must tolerate missing optional files and older schemas.

## `state/tasks.json`

Mutable task snapshot/ledger.

Typical task-level concerns include:

- task ID and description;
- acceptance criteria/dependencies;
- task status;
- attempt budget;
- verification/completion state;
- failure signatures;
- review requirements/counters;
- completion timestamp;
- worktree/base-commit metadata where applicable.

Mutable JSON state is written atomically where the controller may replace the snapshot.

## `state/decisions.jsonl`

Append-only project lifecycle/decision history.

Examples can include:

- task creation;
- execution-class selection;
- controller decisions associated with lifecycle progression.

The Control Room uses this as one source for Activity.

## `runs/<task>/attempts.jsonl`

Append-only attempt lifecycle records.

Current attempt statuses include:

```text
started
verifying
passed
failed
interrupted
```

Relevant fields may include:

- `sequence`;
- `status`;
- `startedAtUtc` or event `timestampUtc`;
- `sessionId`;
- `startedByTurn`;
- `failureSignature`;
- reason/evidence metadata where applicable.

An attempt is folded by sequence by readers. Old tasks may have no attempts file.

## `runs/<task>/evidence.json`

Verification and acceptance evidence.

Current verification evidence can include:

```text
schemaVersion
attempt
startedAtUtc
finishedAtUtc
verification[]
scopePass
```

Each verification row can include:

```text
name
kind
status
exitCode
command
attempt
startedAtUtc
finishedAtUtc
```

Readers derive durations only from real timestamp pairs.

A completed evidence artifact with any required failed check represents overall failed verification.

## Context artifacts

`context-manifest.json` records the context selected for a task (with an explicit `0 = unlimited` budget semantic; unlimited mode still records what was selected). Large verification/tool output can live under `artifacts/`, while the model receives compact digests and references instead of unbounded logs.

## Review artifacts

### `review-packet.json`

Request material for the independent review. Under the shipped default (`codex.automaticReview.enforceLimits=false`) the packet is not budget-bounded; it still never silently expands to full-repository context — the zero-file full-repository consent guard stays active regardless of budget enforcement.

### `review-result.json`

Structured review result/verdict. It may inform repair/completion/gating policy but does not itself gain global completion authority.

## Telemetry

`telemetry.json` can record per-task execution metadata such as execution class, provider/model, token/cost proxies when available, context size, diff size, attempts, verification, Codex calls/findings, result, and elapsed time.

## Runtime/global state

Some Nexus state is not project source and is intentionally stored outside committed `.ai-harness` project artifacts.

Important examples include:

- session bindings;
- global routing-decision history;
- routing state;
- completion gate journal;
- gate-action request journal;
- controller logs;
- DSH sessions;
- local credentials;
- generated profiles/packages.

These normally live under the Nexus `data` tree and are excluded from Git.

## Session bindings

`data/routing/session-bindings.json` is the durable bridge between a DSH session and the controller task identity.

Identity is resolved as:

```text
sessionId
-> binding.workspace
+ binding.taskId
```

Persisted bindings use an explicit field whitelist. Runtime-only objects (for example a live session object) must never be serialized.

## Routing decisions

Global routing history lives under the routing data tree and includes workspace/task identity. Readers must match normalized workspace + task ID rather than task ID alone.

Records without trustworthy workspace identity fail closed for cross-workspace joins.

## Operator gate journal

`data/completion/gates.jsonl` is append-only gate history.

Gate transitions can carry fields such as:

```text
schemaVersion
gateId
kind
reason
sessionId
workspace
taskId
attempt
reviewVerdict
allowedActions[]
status
revision
createdAtUtc
resolvedAtUtc
resolvedBy
actionId
```

The latest valid transition for the authoritative identity determines current gate state.

## Gate-action request journal

`data/completion/gate-actions.jsonl` records action request identity for replay/idempotency protection.

Typical fields include:

```text
requestId
gateId
actionId
sessionId
atUtc
```

## Mutable JSON vs append-only JSONL

General rule:

- use atomic replacement for mutable snapshots;
- use JSONL for histories where transition ordering/auditability matters.

Do not rewrite append-only history merely to make the UI prettier; adapters should fold records correctly.

## UTF-8 boundary

PowerShell 5.1 has historically made implicit encoding dangerous. Nexus producer/read boundaries that handle JSON/JSONL text should use explicit UTF-8 behavior where needed.

Unicode task descriptions and symbols must survive:

```text
producer -> disk -> reader -> endpoint -> browser -> restart
```

without relying on the system ANSI code page.

## Git policy

Runtime credentials, installed packages, browser profiles, logs, sessions, and local `data` state are not source artifacts and should remain excluded from source commits.

Project `.ai-harness` state may be intentionally tracked in some workflows, but runtime/test-generated ledger noise should not be mixed into unrelated source commits.

## Compatibility

Readers should be tolerant of:

- missing files;
- older schema versions;
- optional fields;
- old tasks with no attempts/evidence/gates;
- partially corrupt JSONL lines (skip the bad record without destroying healthy subsystems).

Missing data is not permission to synthesize a successful-looking record.