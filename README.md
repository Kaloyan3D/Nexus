# Nexus

**A deterministic AI engineering harness with profile-driven engineering execution (DeepSeek + Codex by default, GLM + Codex optional), independent review, durable task state, and a live Control Room.**

Nexus turns a coding-agent session into a controller-owned engineering workflow. The model implements; the controller owns routing, attempts, verification, completion, and operator gates. The UI observes authoritative state instead of guessing from chat history.

> Windows-first. Built on the DeepSeek Harness (DSH) runtime without replacing its sessions, tools, permissions, Git integration, or web UI.

## Why Nexus

Most coding agents are conversation-first: the model decides what to do, remembers progress in context, and often decides for itself when the task is finished. Nexus moves the important engineering state out of the model and into deterministic controller records.

```mermaid
flowchart LR
    U[User] --> UI[Nexus / DSH UI]
    UI --> C[Deterministic Controller]
    C --> R[Routing Policy]
    R --> E[engineer_normal]
    E --> P[Active Engineering Profile]
    P --> M[Model Registry]
    M --> MD[(Provider: DeepSeek / Z.ai / Codex)]
    E --> V[Deterministic Verification]
    V -->|PASS| C
    V -->|failure / critical boundary| RV[Independent Reviewer]
    RV --> E
    C --> G[Operator Gate]
    C --> S[Durable Task State]
    S --> CR[Control Room]
```

DeepSeek (or the profile's primary engineer) remains the normal root executor. The reviewer is not a parent agent and is not required for ordinary completion.

## Core features

- **Deterministic task controller** — task identity, execution class, attempts, evidence, verification, failures, review requirements, and completion live outside the model.
- **Execution classes** — mechanical checks (`deterministic`), normal engineering (`engineer_normal`), deeper reasoning (`engineer_deep`), independent review (`reviewer`), and explicit user-approved solve (`solver`). Classes are vendor-neutral; models are chosen by the active engineering profile (see [docs/architecture/engineering-profiles.md](docs/architecture/engineering-profiles.md)).
- **Engineering Profile editor (Phase 2.1)** — the Control Room's Engineering tab lets the operator pick the preferred profile (DeepSeek + Codex / GLM + Codex / Custom) and bind each role to a registered model with a supported reasoning level. All writes are validated by the controller and applied at the next safe execution boundary; RUNNING execution is never rewritten (see [docs/architecture/engineering-profiles.md](docs/architecture/engineering-profiles.md)).
- **Real attempt lifecycle** — GUI engineering turns create bounded attempts; reloads and reconnects do not create fake retries.
- **Verification evidence** — `/verify` records per-check command, status, exit code, attempt linkage, timestamps, and overall evidence.
- **Crash-safe reconciliation** — an interrupted verification is closed truthfully instead of remaining `verifying` forever or silently creating a new attempt.
- **Independent Review (read-only)** — fresh, read-only review packets with a policy-driven budget: `codex.automaticReview.enforceLimits` defaults to `false` (unlimited review context), and the legacy file/diff/context/output/call-count limits stay available behind `enforceLimits=true`; reviewer model bound by the active profile (this phase: the local Codex/OAuth adapter).
- **Operator gates** — controller-advertised actions such as Approve / Reject are validated server-side with stale/duplicate protection.
- **Control Room** — live Overview, Activity, Verification, and Files views backed by authoritative records.
- **RUNNING vs PREFERRED model visibility** — the UI separates the executor actually routed for the task from the session's preferred model/effort ceiling, and adds the preferred **engineering profile** and the decision's role/profile/provider/model.
- **Workspace isolation** — identity is resolved as `session -> binding -> normalized workspace + taskId`; same task IDs in different repositories cannot contaminate each other.
- **Durable state** — JSON/JSONL task records survive model context limits, browser reloads, and Nexus restarts.
- **Fail-closed behavior** — missing, stale, corrupt, or unauthorized state is not silently converted into successful-looking UI state.

## Control Room

Nexus adds a lightweight compact Controller drawer plus an expanded **Task Control Room**.

| Surface | What it answers |
| --- | --- |
| **Overview** | What task is active, what state is it in, which attempt is running, which executor was routed, and whether operator action is required? |
| **Activity** | What authoritative lifecycle transitions happened, and when? |
| **Verification** | What checks actually ran, did verification PASS or FAIL, and what command/exit/timing data exists? |
| **Files** | What does Git currently report as changed for the bound workspace? |

The Control Room does not manufacture events from polling deltas. It reads controller/task records and renders them. Operator buttons are shown only when the current gate explicitly advertises those actions.

## Quick start

### Requirements

- Windows 10/11
- PowerShell 5.1+
- Internet access during installation
- A DeepSeek API key
- Optional ChatGPT/Codex authentication for independent review

### Install

```powershell
git clone https://github.com/Kaloyan3D/Nexus.git
cd Nexus
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
aih-key
aih-auth   # optional: independent Codex review
```

Then open Nexus from a project repository:

```powershell
aih -Open
```

Useful commands:

```powershell
aih-doctor -Offline
aih-test
aih-test-tiers       # live provider probes; may consume quota
aih-detect
aih-stop
```

Bulgarian quick start: **[docs/quick-start-bg.md](docs/quick-start-bg.md)**.

## Engineering modes

### Normal Engineering

DeepSeek V4 Flash is the root engineer. The controller may permit independent Codex review when deterministic policy requires it.

### DeepSeek Only

DeepSeek V4 Flash remains the root engineer, while OpenAI/Codex inference is disabled and the policy fails closed instead of silently substituting another model.

## Execution classes

| Class | Purpose | Writable |
| --- | --- | ---: |
| `deterministic` | Mechanical lookup / verification with no LLM | No |
| `deepseek_normal` | Default implementation and debugging | Yes |
| `deepseek_deep` | Expanded DeepSeek reasoning after evidence-backed escalation | Yes |
| `codex_review` | Fresh, independent review (read-only) | No |
| `codex_solve` | Exceptional explicit user-approved solve | Yes |

The default routing path is intentionally simple:

```text
deepseek_normal
  -> verify
  -> deepseek_deep repair when policy/evidence justifies escalation
  -> independent codex_review when required
  -> DeepSeek repair
  -> deterministic completion
```

## Controller-owned completion

A model cannot mark its own task complete.

```text
acceptance criteria accounted for
+ required verification PASS
+ scope / architecture rules PASS
+ evidence present
+ policy-required review PASS (when applicable)
= controller COMPLETE
```

Critical or review-required failures may open an **operator gate**. The browser submits only bounded identifiers; the controller validates session binding, gate identity/revision, advertised actions, request identity, and current gate state before any transition.

## State and storage

Project-scoped engineering state lives under `.ai-harness`:

```text
.ai-harness/
  state/
    objective.json
    tasks.json
    decisions.jsonl
    learnings.jsonl
  runs/TASK-NNNN/
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

Runtime bindings, routing history, gate journals, logs, credentials, installed packages, and sessions live outside committed project source. Credentials are never meant to be stored in task ledgers.

## Independent Codex review

`codex_review` is an independent review service, not an unrestricted subagent. The review is always a fresh, read-only, controller-owned packet scoped to the task instance; the reviewer never gains completion authority.

Review budget enforcement is policy-driven (`codex.automaticReview.enforceLimits`). The shipped Nexus default is `false`: the review context is **unlimited** — Nexus does not reject reviews for file count, diff size, estimated context tokens, or calls per task, and no `max_output_tokens` is sent to the provider. The Context Engine treats `0` as an explicit "unlimited" value and still ranks/selects relevant files instead of blindly dumping the repository. Provider/model context windows remain the provider's own capacity boundary and surface as provider-capacity errors. The legacy hard budgets (8 files / 2500 diff lines / 30000 context tokens / 1 call per task / capped output) stay available behind `enforceLimits=true` for operators or tests that want them.

Full-repository context and writable Codex solve paths still require explicit user approval; this authorization boundary is separate from budget enforcement and stays active when budgets are disabled.

Automatic review is intended for repeated evidence-backed failure or critical boundaries—not simply because a task feels difficult.

## Security model

Nexus intentionally keeps authority narrow:

- the browser cannot directly edit task ledgers;
- session bindings resolve workspace/task identity server-side;
- stale or mismatched operator gates fail closed;
- verification failures are distinct from verification infrastructure failures;
- review results do not gain global completion authority;
- workspace escapes and sensitive external operations remain subject to controller/tool policy;
- `SEC001` detects potential persisted secret material while allowing explicit placeholder forms;
- `MIG001` surfaces tracked migration changes for explicit review.

See **[SECURITY.md](SECURITY.md)** for credential and reporting guidance.

## Documentation

Start at **[docs/README.md](docs/README.md)**.

- [Architecture overview](docs/architecture/overview.md)
- [Controller and authority](docs/architecture/controller.md)
- [Routing and execution classes](docs/architecture/routing.md)
- [Task, attempt, verification, review, and gate lifecycle](docs/architecture/task-lifecycle.md)
- [Control Room architecture](docs/architecture/control-room.md)
- [State and storage reference](docs/reference/state-and-storage.md)
- [HTTP endpoint reference](docs/reference/endpoints.md)
- [Setup, testing, and troubleshooting](docs/operations/setup-testing-troubleshooting.md)
- [Architecture decisions](docs/decisions/README.md)

Detailed implementation/history notes remain available in [docs/nexus-ui.md](docs/nexus-ui.md) and [docs/vnext-architecture.md](docs/vnext-architecture.md).

## Testing

Nexus includes deterministic PowerShell and Node regression suites for the controller, routing, lifecycle, verification contracts, gates, UI adapters, workspace isolation, patch idempotency, and architecture rules.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\Harness.Tests.ps1
node .\tests\NexusControllerPanel.Tests.cjs
```

Live provider probes are separate because they can consume quota.

## Design principle

> **The model performs engineering work. The controller owns engineering truth.**

That principle drives routing, attempts, verification, review, completion, persistence, and the Control Room.