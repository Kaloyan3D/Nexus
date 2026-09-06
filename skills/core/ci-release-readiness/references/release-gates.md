# Release Gates Reference (companion to SKILL.md)

## Gate evidence format

Record each gate as:

    gate: <name>
    label: PASS | FAIL | UNVERIFIED
    evidence: <command or CI job> @ <commit/branch> -> <result summary>

## Typical gate sets

### Pure JavaScript service

- unit + integration suite
- lint + typecheck
- build/packaging
- smoke: start the packaged artifact, hit the health/entry point

### Native mobile app (Expo/React Native)

- unit suite
- lint + typecheck
- JS bundle (expo export) — labeled JS-only
- NATIVE build: Gradle assemble / Xcode archive / EAS build — PASS required
  for release
- device or emulator smoke of the real build

### Schema-bearing service

- everything above, plus:
- migration chain from empty
- migration from previously shipped schema
- rollback/forward-fix rehearsal

## Honesty rules

- UNVERIFIED is a first-class result: the release is not ready until the gate
  is PASS or the failure is explicitly accepted by the release authority.
- An accepted FAIL requires a named acceptance authority and a tracked
  follow-up.
