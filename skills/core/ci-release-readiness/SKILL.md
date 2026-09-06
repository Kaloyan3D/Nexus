---
name: ci-release-readiness
description: >
  Use before a release or phase closure, when a report claims the system is
  ready, or when summarizing gate status. Requires actual results for every
  relevant gate, distinguishes PASS, FAIL, and UNVERIFIED, and forbids "all
  green" claims when a required gate did not run.
---

# CI / Release Readiness

## When to use

Use when preparing a release, closing a phase, or reporting readiness: the
moment when unverified claims become other people's assumptions.

## The gates

Enumerate the gates that apply to this release and give each an honest label:

| Label | Meaning |
| --- | --- |
| PASS | The gate ran in this readiness check and succeeded. |
| FAIL | The gate ran and failed; release is not ready. |
| UNVERIFIED | The gate did not run here; no claim is made. |

Standard gates to consider; drop or add per repository reality, and say why:

- Full automated test suite (unit, integration, end-to-end as configured).
- Lint, type, and format checks.
- Build/packaging of the actual release artifact.
- Native build verification for native applications (Gradle/Xcode/EAS) —
  JS bundling is not a native build.
- Migration/upgrade path exercised from the previously shipped state.
- Smoke test of the packaged artifact in a clean environment.
- Documentation and version metadata updated.

## Rules

- Every gate claim names its evidence: the command or job, where it ran, and
  the result. A gate without evidence is UNVERIFIED, regardless of belief.
- NEVER say "all green", "fully passing", or "ready" while any required gate
  is UNVERIFIED or FAIL. Partial readiness is reported as partial, with the
  remaining gates listed.
- Failures are reported with their diagnosis, not hidden in a summary.
- If a gate cannot run in the current environment, state the missing
  capability and who/what must run it. Do not approximate one gate with
  another (type-check is not a test suite; export is not a native build).
- Readiness is a snapshot: it is scoped to the commit and configuration
  actually checked, and the report says so.

## Report shape

1. Scope: commit hash, branch, and what "this release" includes.
2. Gate table: every gate with PASS/FAIL/UNVERIFIED and its evidence.
3. Known issues: every FAIL that is being accepted, with the acceptance
   authority (who decided, on what basis).
4. Remaining gates before release, with owners or commands.

## Verify completion

- No gate is claimed PASS without executed evidence in this check.
- The report contains zero unqualified "green"/"ready" claims.
- UNVERIFIED gates are listed as remaining work, not implied away.
