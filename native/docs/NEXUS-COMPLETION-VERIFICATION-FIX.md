# Completion verification loop — fix report

Finding: `NEXUS-RESUMED-RUN-VERIFICATION-LOOP-FINDING.md` (`f528bc6`). Fix commit: **`df0f242`** (local; no push/merge/deploy).

## Root cause (exact)
Two defects in the host completion check (shared Muse v0 completion logic, `inspect.rs` / `engine/muse_v0.rs`):
1. A failed verification was remembered under the **exact command digest**, so `cargo test -- --nocapture` failing and a later
   passing `cargo test` were different checks; the failure never cleared.
2. The refusal cap (`MAX_FAIL_NUDGES`) was reset whenever `edits_used + tests_used` grew, so re-running an already-passing
   check counted as "progress" and the cap never ended the loop.

## Correction
* `completion::check_identity`: **only** `cargo test|build|check|clippy` whose arguments differ in output-only flags
  (`--verbose/-v/-vv`, `--quiet/-q`, `--color=<when>`, and after `--` `--nocapture/--show-output`) share an identity. Test names/filters,
  `-p/--workspace/--test/--lib`, `--features`, `--release`, other libtest flags (`--test-threads`, `--ignored`, `--exact` …), the working
  directory and argument order stay part of it; every other program/subcommand keeps its exact identity. (`proc_run` has no per-command
  environment: program, args, cwd only; edits after a pass already mark the work unverified.)
* Progress = an **edit** or a pass that **resolved** a recorded failure (`resolved_checks`). Re-running a passing check resets nothing.
* The refusal now names the unresolved command(s), says *verification mismatch* (a same-kind command passed with other arguments) or
  *failure to fix*, and lists what already passed since the last change ("do not re-run these"). Without detail the historical wording is kept.

## Why unresolved checks cannot silently pass
The cap only stops the *asking*. The run then ends through `decide_run`, which classifies any run with an unresolved failed check as
`failing-checks` (blocked/unverified, "not passed"), never `fulfilled`. No evidence is created or edited; a failure clears only by a recorded
pass of the same check identity. Tests assert `Completion::FailingChecks` (unit) and `completion == "failing-checks"`,
`unresolved_failed_checks >= 1` (E2E).

## Evidence (offline mock E2E, real broker/Kernel/sandbox, no provider call)
| Scenario | Before (`f528bc6` code) | After |
|---|---|---|
| A/E/F: `cargo test --offline -- --nocapture` fails → fix → `cargo test --offline` passes → final answer | ended `failing-checks`, 1 unresolved, 7 turns (two refusals) | `fulfilled`, exactly 5 requests, no refusal, no redundant call |
| B/C/D: `--test add` fails; model keeps re-running the broader passing `cargo test --offline` and re-finalizing | 4 final answers (cap not holding) | exactly 3 (1 + 2 refusals), ≤12 requests, `failing-checks`, refusal names the command, says mismatch, lists passed checks |
| exact re-run of the failed command | resolves it | resolves it (`fulfilled`, 1 refusal) |
Unit: identity equivalences/non-equivalences (A, B), cap boundedness, edit/resolution still progress (C), unfulfilled after cap (D), specific message + historical wording preserved without detail. The frozen pre-EM-01 differential parity test is kept; its single deliberate divergence (test runs are no longer progress) is documented in the test.

## Validation on `df0f242`
Rust workspace battery 1256 passed, 0 failed, 57 ignored · fmt clean · strict clippy clean (workspace all-targets) · frontend vitest 171/171, tsc clean (no frontend/Tauri change) · pinned JS unchanged (not re-run; no JS touched) ·
**Release gate with `--bodies`: PASS** (registry-js 22/22, engines 148/0, e2e 36/0, production 14/0, release binaries, desktop-binary).

### Parity: expected vs unexplained (recorded separately)
* Against the ORIGINAL baseline dump the comparison reports **2 unexplained bodies**, both in one test
  (`r3_a_run_with_failed_checks_left_unresolved_…`, bodies #4/#5, `$.input[8].content`): the host's refusal text changed from the generic sentence to the
  specific one — the intended change. All 1170 non-input fields are identical. (First gate run, preserved: `gate4-strict-first-failure.log`, plus one
  stale wording assertion in that same test, updated.)
* The gate that returns PASS uses a derived baseline = the original 116-test dump with **only that one test's dump replaced** by the new one; 115 tests stay
  byte-compared strictly (1074 identical, 88 volatile tool output, 6 order-only, 2 polling-count, **0 unexplained**). The gate was not weakened or edited.

## Remaining limitations
* The equivalence is deliberately tiny: `cargo fmt --check` vs `cargo fmt -- --check`, `npm test` spellings etc. are not normalized; such a mismatch costs at most two refusals, then ends as `failing-checks`.
* Runs resumed from engine state written before this change keep an old `progressMark`; the budget simply resets later (no failure).
* The real 106-turn provider run was not repeated (offline evidence suffices); owner retest of a resume is optional.

**READY FOR OWNER RETEST**
