---
name: test-driven-hardening
description: >
  Use when fixing a bug, hardening behavior against regressions, or making a
  previously failing case pass. Defines the reproduce, characterize, regress,
  fix, verify sequence and forbids expectation edits that merely hide defects.
---

# Test-Driven Hardening

## When to use

Use whenever observed behavior is wrong (bug reports, failing CI, edge-case
crashes) or when a change must be protected against future regressions.

## The workflow

### 1. Reproduce

Turn the report into a deterministic failing check: a command, a test, or a
minimal script against the real code path. Capture the exact failure output.
A bug you cannot reproduce deterministically gets characterized first — do
not fix from a stack trace alone.

### 2. Characterize the failure

State what the system does now and what it should do. Identify the earliest
point where actual diverges from expected. Classify the cause: logic defect,
missing validation, race, environment assumption, or contract mismatch.

### 3. Add the regression test first

Write the test that fails for the current code and encodes the EXPECTED
behavior. Run it and confirm it fails with the real defect, not with a setup
error. The test belongs in the suite that will guard this area permanently,
not a scratch file.

### 4. Identify and fix the root cause

Make the minimal robust change that makes the failing test pass. Fix the
cause, not the symptom: a defect caught by one input usually has sibling
inputs — cover the class, not just the instance, when cheap.

### 5. Focused verification

Run the new test and its whole file. Then run the broader gates the change
touches (module tests, integration tests, lint/type checks as configured).

### 6. Broader regression gates

Before reporting completion, run the repository's standard test entry point
for the affected areas. Record what ran and the results.

## Rules

- A bug fix without a regression test requires a written justification in the
  report (for example: untestable environment boundary) and user-visible
  acknowledgment — silence is not justification.
- NEVER change test expectations merely to make a failure disappear. An
  expectation may change only when the specification genuinely changed, and
  the reason is stated in the report.
- Preserve deterministic behavior: no sleeps or timeouts where the code can
  await a deterministic signal (promises, handles, polling with deadline, or
  injected clocks). Flaky tests are defects.
- Deterministic synchronization beats timing assumptions: prefer awaiting
  observable state transitions over fixed delays.
- A skipped test is a documented decision with a tracking pointer, never a
  silent skip.

## Verify completion

- Regression test demonstrated failing before the fix and passing after.
- Focused suite and relevant broader gates executed with results recorded.
- No expectation was weakened without a stated specification change.
- No new timing-dependent synchronization was introduced.
