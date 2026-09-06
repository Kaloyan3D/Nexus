---
name: nexus-engineering-workflow
description: >
  Use for any substantial engineering task that will inspect or change
  repository files: bug fix, feature, refactor, migration, or investigation.
  Defines the required UNDERSTAND, INSPECT, PLAN, IMPLEMENT, VERIFY, REPORT
  workflow, the evidence each stage must produce, and the claims that are
  forbidden without executed verification.
---

# Nexus Engineering Workflow

## When to use

Use this skill for any task beyond a trivial single-line edit: implementing a
feature, fixing a bug, refactoring, migrating, or investigating behavior. Skip
it for pure questions you can answer from one file.

## The workflow

### 1. UNDERSTAND

Restate the task as a bounded objective with explicit success criteria and
explicit out-of-scope items. If the task text implies scope you cannot honor
(for example "continue the previous phase"), treat the written scope as
authoritative and surface the conflict instead of silently expanding.

### 2. INSPECT

Inspect actual repository state before assuming anything:

- Read the files you are about to change, their callers, and their tests.
- Check branch, status, and recent history before any Git operation.
- Run the relevant existing tests once to establish a green baseline where
  practical.

Record what you inspected. An assumption that was never checked against the
repository is not evidence.

### 3. PLAN

Decompose into concrete steps with the file paths each step touches. Choose
root cause over symptom patch: if a fix cannot be stated as "the defect is X,
so the minimal correct change is Y", keep investigating. Preserve scope
boundaries from UNDERSTAND; unrelated improvements become separate tasks, not
drive-by edits.

### 4. IMPLEMENT

Make the smallest complete change that satisfies the plan. Follow existing
repository conventions (naming, error handling, test layout, formatting).
Never modify Git identity, hooks, or CI configuration to make a step easier.

### 5. VERIFY

Verification means execution, not intention:

- Run the focused tests for the changed area.
- Run the repository's standard broader gates that the change could plausibly
  affect.
- Re-run anything that failed until it passes for the right reason.

A claim of verification requires the command that ran and its result. If a
gate could not run, say so explicitly.

### 6. REPORT

Distinguish exactly three labels:

- **implemented** — the code exists in the working tree.
- **verified** — you executed the check and observed the pass.
- **unverified** — real but not executed; name what would verify it.

Never present "implemented" as "verified". Leave the working tree clean when
the task requires a commit; otherwise state what remains modified and why.

## Forbidden

- Editing files without reading their current content first.
- Fixing a symptom while leaving the cause (for example deleting an assertion
  that fails instead of fixing the defect it caught).
- Expanding scope across modules without stating the expansion explicitly.
- Claiming test, build, or smoke results that were not executed in this task.
- Committing on the wrong branch or with modified identity configuration.

## Verify completion

- Every success criterion from UNDERSTAND is mapped to implemented/verified.
- Focused tests and relevant broader gates ran with results recorded.
- Working tree state is stated and matches the task's commit requirement.
- The report lists any deviation from the original scope with its reason.
