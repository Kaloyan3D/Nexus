---
name: code-review
description: >
  Use when reviewing a change, diff, or pull request, or when asked to audit
  recently written code. Prioritizes correctness and data-loss/security issues
  over style, requires evidence for findings, and classifies every finding as
  blocker, important, or minor.
---

# Code Review

## When to use

Use when examining code you did not write in this task: a diff under review,
a pull request, or a self-review before completion of a change.

## Review priority

Review in this order and spend effort accordingly:

1. **Correctness** — does the code do what it claims for the stated inputs,
   and the unstated ones (empty, huge, concurrent, re-entered)?
2. **Data loss and security** — can this destroy, corrupt, or expose data?
   Unvalidated writes, unchecked deletes, secret handling, injection paths.
3. **Concurrency and state lifecycle** — races, double-dispose, missing
   invalidation, leaked handles or subscriptions.
4. **Regression risk** — what previously working behavior could this break?
   Read the touched tests; check whether they still pin the old contract.
5. **Architecture** — does this add a second source of truth, invert
   dependencies, or blur an ownership boundary?
6. **Performance** — only for demonstrated hot paths or algorithmic
   regressions; speculation is not a finding.
7. **Maintainability** — naming, dead code, duplication that will drift.
8. **Style** — only where the repository's own conventions are violated.

## Evidence rule

Every finding states the evidence: the file and line, the input that triggers
the behavior, or the test that demonstrates it. "This looks wrong" is not a
finding. If you cannot articulate the failure mode, investigate until you can
or drop the point.

## Classification

- **blocker** — correctness defect, data loss, security hole, or a change
  that breaks an existing contract without a migration. Must be fixed before
  merge.
- **important** — real risk or clear improvement (missing test for the new
  behavior, weak error handling) that should land with or immediately after
  this change.
- **minor** — polish. Named only when it will not bury the blockers.

Do not produce cosmetic review noise while missing correctness issues. A
review with ten style notes and no analysis of the write path is a failed
review.

## Method

1. Read the task or description the change claims to satisfy.
2. Read the full diff once end-to-end before commenting on details.
3. Re-derive the data flow: where does each new value come from and go?
4. Check the tests: what new behavior do they pin; what old behavior did they
   stop pinning?
5. Run the change's tests if that has not happened in this task.

## Verify completion

- The review states what the change claims and whether the claim holds.
- Findings are classified and each carries evidence.
- The absence of findings in a priority area is stated, not implied.
