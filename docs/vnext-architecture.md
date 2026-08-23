# AI Harness vNext.1 architecture

## Decision

The authoritative lifecycle moved from a permanent GPT-5.6 Sol lead into deterministic PowerShell modules. This follows the harness’s existing language and operational conventions and avoids replacing the DSH runtime or GUI. DeepSeek V4 Flash owns ordinary planning, implementation, debugging, self-review, and repair within a bounded task. The controller owns state and completion. Codex is a separate, fresh, bounded expert review service.

```text
                         .ai-harness/state + runs
                                    ^
                                    |
User -> TaskController -> Routing policy -> ContextEngine
           |                    |              |
           |                    v              v
           |              DeepSeek Flash <-> targeted tools
           |                    |
           v                    v
      completion <------- deterministic verification + rules
                                    |
                              repeated/critical only
                                    v
                         ReviewPacket -> Codex review
                                           |
                                           v
                                    DeepSeek repair
```

## Phase map

| Phase | Implementation |
|---|---|
| H1 | `TaskController.ps1`: objective, DAG tasks, attempts, failures, evidence, atomic ledger |
| H2 | GUI presets and runtime isolation force DeepSeek V4 Flash as root; prompts are implementation-only |
| H3 | Routing policy v2 uses execution classes; completion accepts ordinary deterministic evidence without Sol |
| H4 | `ContextEngine.ps1`: repository map, symbols, references, lexical ranking, docs, Git, budgets/manifests |
| H5 | `OutputDigest.ps1`, targeted `aih-verify`, and `aih-context` provide compact tool paths |
| H6 | `CodexReview.ps1` creates and enforces bounded packets and fresh read-only review calls |
| H7 | `WorktreeManager.ps1` records exact-base worktrees; `ArchitectureRules.ps1` adds sandbox/static seams |
| H8 | `Telemetry.ps1` records cost/quality inputs and defines configuration comparison records |

Every phase preserves a runnable PowerShell/DSH harness. Existing project discovery, verification commands, provider configuration, browser UI, runtime tools, logs, background jobs, permissions, credentials, Git integration, and command wrappers were reused.

## GUI bridge (aih-controller)

The Web GUI message path is wired to the controller by a small agent-plane plugin
(`config/AihController.cjs`, mounted in both generated presets by `Setup.ps1`). It keeps
DeepSeek as the normal root engineer while making the controller real:

- Every GUI session is bound to a `TaskController` task; the first user prompt is routed
  through the routing policy and the decision is persisted. The selected execution path is
  posted into the session as a controller notice and exposed as
  `DSH_AIH_TASK_ID` / `DSH_AIH_EXECUTION_CLASS` / `DSH_AIH_REVIEW_REQUIRED`.
- `/codex-review <question>` is the deterministic explicit review path: TaskController task
  with `reviewRequested=true` -> routing selects `codex_review` -> bounded Review Packet
  (context bundle capped at the Codex budget) -> hard budget validation -> one fresh read-only
  Codex call -> ReviewResult + telemetry posted to the session. The turn is rejected, so no
  DeepSeek audit runs first (DeepSeek calls = 0). Oversized packets produce a structured
  packet-too-large result and Codex is not called.
- Turn errors are routed as `attempt-failure` signals, so the same normalized-failure
  escalation (`deepseek_normal` -> `deepseek_deep` -> `codex_review`) works from GUI
  sessions; review findings return to DeepSeek repair via the `review-findings` signal.
- Codex is never exposed to the model as a tool: `tool-subagent-codex` stays disabled and
  the review service is invoked only by the controller through packet enforcement.

## State and lifecycle

```text
.ai-harness/
  project.md / architecture.md / conventions.md
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
    artifacts/*.log
    summary.md
```

Task states are `ready`, `implementing`, `failed`, `verifying`, and `complete` (with `cancelled` reserved). Each attempt is bounded by `maxAttempts`; dependencies must be complete before an attempt begins. JSON replacements are atomic and histories are JSONL. The ledger stores no credentials and does not rely on chat history.

Fresh sessions receive task description, acceptance criteria, compact repository map, ranked file slices, relevant local documents, Git metadata, and the explicit budget. A handoff can be persisted in the run directory before terminating a large context. Lazy tool discovery is an extension seam; vNext.1 exposes focused CLIs without rewriting DSH as MCP.

## Completion contract

```text
criteria accounted for
+ required verification PASS
+ architecture/scope rules PASS
+ evidence present
+ optional policy-required review PASS
= controller COMPLETE
```

Ordinary tasks have `Codex calls = 0`. Critical tasks are incomplete until a passing review result is supplied. A review result itself has no global completion authority.

## Review packet and enforced limits

The packet contains only the task ID, exact question, invariants, bounded diff, selected file slices, failing evidence, concise DeepSeek assessment, requested action, and budget. It excludes prior conversations, the entire repository/specification, unrelated tools, and raw large logs.

Limits in `config/routing-policy.json` are evaluated before a call and rechecked at registration time. A cached packet cannot bypass the current per-task call count. `codex_solve` is writable only through explicit execution-class override; automatic routing never selects it. Full-repository context requires an explicit approval flag.

## Worktree and command boundary

`New-AihTaskWorktree` refuses tasks without a recorded commit, creates from that exact commit, and writes `{baseCommit, branch, worktreePath}` to the task. Declared overlapping write paths are conflict-checked. Existing command policy, workspace-scoped verification paths, user approvals, and protected credential storage remain security boundaries. A future container/VM runner can implement the same execution contract without changing task state.

## Telemetry and cost comparison

`telemetry.json` supports comparisons by configuration and records tokens when providers expose them. A representative ordinary run records DeepSeek as executor, one bounded context, one or more DeepSeek calls, and zero Codex calls. A critical/repeated-failure run records DeepSeek normal/deep, one bounded Codex review maximum, then DeepSeek repair. The deterministic test suite reproduces both route shapes without consuming model quota.

## Deprecations

- Permanent Sol parent ownership and mandatory model semantic completion review are removed.
- Tier organizational semantics are deprecated; old tier flags map to execution classes for compatibility.
- Raw `subagent_codex` is disabled even when the old launcher flag is passed.
- DeepSeek V4 Pro is no longer required as a root or semantic gate.

## Deferred after vNext.1

- Tree-sitter adapters beyond the current language-aware regex outlines.
- Full BM25/SQLite FTS scoring (vNext.1 uses deterministic lexical term-frequency ranking).
- Automatic task replay across evaluation variants.
- Learned routing.
- Stronger process containers/VM isolation.
- Dynamic DSH tool-schema discovery and one bounded review-context expansion protocol.
