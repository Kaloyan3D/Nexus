# Routing and execution classes

Nexus routing is deterministic policy over task signals. It does not treat model choice as a free-form conversational preference.

The policy lives in `config/routing-policy.json` and maps work into an **execution class**.

## Execution classes

Execution classes describe **semantics**, never a model or vendor. The actual
model for each class is resolved per **engineering profile** (see
[engineering-profiles.md](engineering-profiles.md)): execution class → role →
profile → model registry → provider.

| Execution class | Role | Typical purpose | Writable | Profile-bound model (DeepSeek + Codex) |
| --- | --- | --- | ---: | --- |
| `deterministic` | — | Mechanical checks or lookups that need no LLM | No | none |
| `engineer_normal` | primaryEngineer | Normal implementation and debugging | Yes | DeepSeek V4 Flash, HIGH |
| `engineer_deep` | deepEngineer | Expanded reasoning after evidence-backed escalation / critical work | Yes | DeepSeek V4 Flash, MAX |
| `reviewer` | reviewer | Fresh, bounded, independent review | No | GPT/Codex review path |
| `solver` | solver | Exceptional explicit user-approved solve | Yes | GPT/Codex solve path |

Legacy tier names and pre-Phase-2 class names (`deepseek_normal`,
`deepseek_deep`, `codex_review`, `codex_solve`) remain compatibility
aliases only; they are never rewritten in persisted records and normalize on
read.

## Normal route

The intended ordinary path is:

```text
user engineering request
-> engineer_normal
-> deterministic verification
-> complete
```

When evidence justifies escalation:

```text
engineer_normal
-> verification/failure evidence
-> engineer_deep
-> verification
-> bounded reviewer when policy requires it
-> deep-engineer repair (same profile)
-> deterministic completion
```

Codex is not a permanent parent agent.

## Critical boundaries

Current policy can mark critical areas such as security, authentication/authorization, permission boundaries, migration safety, concurrency correctness, or similar high-risk architectural boundaries for deeper work and bounded review.

These are policy signals, not a permission for arbitrary model escalation.

## Repeated failure

Routing may use normalized repeated-failure evidence. The configured same-failure threshold is checked before ordinary escalation.

This protects against two opposite failure modes:

- escalating to expensive review because of a single minor error;
- retrying the same failing approach indefinitely without changing execution depth.

## Mechanical work

Requests that can be answered by deterministic tools (for example selected test/status/diff checks) can route to `deterministic` with no model execution.

The controller should not spend model tokens on work that is already an executable fact.

## Review limits

The routing policy enforces bounds on automatic Codex review, including call count, file count, diff size, estimated context, and output size. The current policy permits at most one automatic review call per task.

Full-repository review context and writable Codex solve behavior are not default paths and require explicit approval.

## RUNNING vs PREFERRED

The Nexus UI intentionally distinguishes:

- **RUNNING** — the effective model + effort selected by controller routing for the current task;
- **PREFERRED** — the session's preferred/root model + effort ceiling.

Example:

```text
PREFERRED · DeepSeek V4 Flash · MAX
RUNNING   · DeepSeek V4 Flash · HIGH
```

This is not a contradiction. The session permits MAX, while deterministic routing selected HIGH for the current execution class.

The UI must not silently rewrite the preferred model to match the current route, and the preferred model must not override deterministic routing semantics.

## Root executor invariant

Review/escalation decisions do not replace the root executor in the Control Room.

The root executor is the primary non-review/non-escalation route for the task. A later `reviewer` decision remains a review event, not evidence that the reviewer model became the task's root engineer.

## DeepSeek Only mode

In **DeepSeek Only** mode, OpenAI/Codex inference is disabled. The same task/controller architecture remains; policy fails closed rather than silently substituting an unavailable reviewer.

## Routing records

Routing history is append-only and includes workspace identity. The Control Room scopes records by the authoritative binding's normalized workspace + task ID.

A record with the same task ID from another workspace is not part of the current task.

## Profile resolution

The active engineering profile is resolved in this order (first match wins):

1. `DSH_AIH_PROFILE` environment variable
2. `AIH_ACTIVE_PROFILE` environment variable
3. `engineering-profile:` in `data/settings.yaml`
4. Preset `profile` binding
5. Policy `defaultProfile`

Presets with `profileOverrideAllowed: false` (DeepSeek Only) ignore global
overrides. Routing decisions record `profile`, `profileDisplayName`, `role`,
`provider`, `model`, `modelDisplayName`, `vendor` and `reasoning` (record
version 4) so the Control Room can report the effective execution without
re-deriving it.

## When changing routing

A routing change should update, together:

1. `config/routing-policy.json`;
2. deterministic routing/controller tests;
3. UI semantics if execution-class presentation changes;
4. documentation for any authority or escalation-contract change.

Model display-name changes should remain separate from execution-class semantics.