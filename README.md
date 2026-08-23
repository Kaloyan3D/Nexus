# A.R.T.H.U.R. — AI Harness vNext.1

A Windows-first coding harness with a deterministic task controller, DeepSeek V4 Flash as the primary engineer, deterministic verification, and rare bounded Codex review. The web GUI, DSH runtime, provider integrations, filesystem/shell tools, permissions, sessions, Git support, and project-aware verification remain intact.

```text
User -> deterministic controller -> budgeted context -> DeepSeek Flash
                                                |          |
                                                |     targeted verification
                                                |          |
                                                +---- PASS -> controller completion
                                                           |
                                             repeated/critical failure
                                                           v
                                               bounded Codex review
                                                           |
                                                   DeepSeek repair
```

Codex is not a parent agent and ordinary completion never requires it.

## Requirements and setup

- Windows 10/11 and PowerShell 5.1+
- Internet access during installation
- A DeepSeek API key
- Optional ChatGPT/Codex login for bounded review

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
aih-key
aih-auth   # optional bounded Codex review
```

The setup installs pinned portable dependencies, protects local credentials, adds `bin` to the user PATH, and composes the DSH presets. Credentials, sessions, state under `data`, logs, installed packages, and portable Node are excluded from Git.

From a project repository:

```powershell
aih -Open
```

Both **Normal Engineering** and **DeepSeek Only** use DeepSeek V4 Flash as the root executor. Normal Engineering permits controller-approved bounded Codex review; DeepSeek Only fails closed without any OpenAI/Codex inference. Mode changes in the Control Room apply atomically to blank/new sessions without restarting a healthy GUI.

## Controller commands

```powershell
aih-task -Action create-objective -Description "Add retry safety"
aih-task -Action create-task -Description "Implement retry guard" -AcceptanceCriteria "test passes"
aih-task -Action begin-attempt -TaskId TASK-0001
aih-route "Implement retry guard" -TaskId TASK-0001
aih-context -Operation bundle -TaskId TASK-0001 -Query "retry guard"
aih-verify -Kind test -TaskId TASK-0001
aih-complete -TaskId TASK-0001 -Objective "Add retry safety" -AcceptanceCriteriaPath criteria.json
```

The project ledger lives under `.ai-harness/state` and task artifacts under `.ai-harness/runs/<task-id>`. JSON documents use atomic replacement where state can be rewritten; decisions, attempts, and learnings are append-only JSONL. Model sessions can terminate at task boundaries because the ledger, context manifest, evidence, telemetry, and summaries are durable.

## Execution classes and compatibility

| Execution class | Purpose | Writable |
|---|---|---:|
| `deterministic` | Mechanical lookup or checks without an LLM | No |
| `deepseek_normal` | Default implementation and debugging | Yes |
| `deepseek_deep` | Expanded DeepSeek reasoning after evidence-backed failure | Yes |
| `codex_review` | Fresh, bounded, independent review | No |
| `codex_solve` | Exceptional explicit user-approved solve | Yes |

Deprecated flags remain temporarily compatible: `tier3 -> deepseek_normal`, `tier2 -> deepseek_deep`, and `tier1 -> codex_review`. They no longer imply management authority. `-EnableCodexSubagent` is deprecated and raw Codex delegation remains disabled.

## Context and coding interface

`aih-context` exposes `map`, `search_code`, `find_symbol`, `find_references`, `file_outline`, and `bundle`. Bundles rank lexical matches, include compact symbols/imports, relevant repository documents, and Git state, enforce file/token budgets, and persist `context-manifest.json`. Repository contents are never dumped automatically and no vector database is required.

Raw `read`, `grep`, `glob`, editing, PowerShell, background jobs, and filesystem tools remain escape hatches. Higher-value command paths include context lookup, `aih-verify -Kind ...` for targeted tests, `git diff`, task checkpoints in the ledger, and architecture rules through `aih-rules`.

Large task-scoped verification output is written to `.ai-harness/runs/<task-id>/artifacts`; the executor receives a bounded digest containing failures and a raw artifact path.

## Routing, completion, and Codex protection

Normal policy is:

```text
deepseek_normal -> verify -> deepseek_deep repair -> bounded codex_review -> DeepSeek repair
```

The same normalized failure must repeat at the configured threshold before ordinary escalation. Critical security, concurrency, migration, auth/permission boundaries, or an explicit user request may create a scoped review requirement. “Hard task” alone is not a Codex route.

Ordinary completion requires all acceptance criteria evidenced, required deterministic checks passing, scope constraints passing, and controller-owned evaluation. Critical tasks can additionally require a passing bounded review. Models and routing records have `completionAuthority=false`.

`aih-review` creates `review-packet.json` before any call. Code enforces one automatic call per task, at most 8 files, 2,500 diff lines, 30,000 estimated input tokens, and 2,500 output tokens. It rejects an oversized packet with `DO NOT CALL CODEX`. Full-repository context requires explicit approval. Each call is a fresh tool-free Responses request and persists a structured result; it cannot modify files or complete the task.

## Worktrees, sandbox, and rules

Parallel writes use task worktrees created from the exact recorded `baseCommit`; the ledger records branch and worktree path. The controller detects declared overlapping write paths. Workspace resolution and verification working directories reject escapes, sensitive external operations still require explicit permission, and no unrestricted secret set is inherited by task state.

`aih-rules` provides an executable rule seam. vNext.1 includes:

- `SEC001`: potential secrets may not be persisted in source/tool records.
- `MIG001`: tracked migration edits are surfaced for explicit safety review.

Add rules as deterministic findings in `scripts/ArchitectureRules.ps1`, cover them in `tests/Harness.Tests.ps1`, and document the remediation. Review findings can be recorded as a proposed test, static rule, tool improvement, documentation, or routing-policy learning; they are never activated automatically from model output.

## Telemetry and evaluation

Per-task `telemetry.json` can record execution class, model/provider, input/cached/output token usage, cost proxy, context and file counts, diff size, attempts, failure signatures, verification, Codex calls/findings, result, and elapsed time. `New-AihEvaluationResult` defines the initial comparison record for `current`, `deepseek-only`, and `deepseek-codex-review`; learned routing and replay orchestration are intentionally deferred.

## Diagnostics and security

```powershell
aih-doctor -Offline
aih-test
aih-test-tiers       # live provider probes; may consume quota
aih-detect
aih-stop
```

The local OAuth adapter stays bound to `127.0.0.1`. Every user must authenticate their own account. Never copy `.codex/auth.json`, `data/.credentials.yaml`, or another user’s environment files.

See [docs/vnext-architecture.md](docs/vnext-architecture.md) for contracts, lifecycle details, migration decisions, state schemas, and deferred work.

Кратко ръководство на български: [docs/quick-start-bg.md](docs/quick-start-bg.md).
