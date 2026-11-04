# Resumed Test 4 run — verification loop investigation

Read-only investigation of the durable records (`runs/run_69feafd6…`, `run_4b26aa61…`, engine records
`task-8344e796…`, `task-afb5a9d6…`, transcript `model_1f37a1bd…`). No source was changed.

## Verdict
**Implementation defect in the host's completion gate (inherited from the Muse v0 completion logic), not model
misbehaviour, not the Governor/Policy V2, and not recovery.** The model was *told not to finish* seven-plus times and
complied by re-verifying with commands that could never satisfy the rule.

## What actually happened
* Run 2 did the real work in its first ~19 tool calls: initial `cargo test -- --nocapture` (exit 101), two edits
  (the third edit/format fix at #27–31), then plain `cargo test` passed (#19, 4 passed). It gave its final report at that point.
* The host refused to accept it. The model's replies ("Understood — re-running the verification steps until
  everything is green", "no failures remain unexplained") echo the host message
  `MSG_UNRESOLVED_CHECKS`: *"Some verification commands failed and were never re-run successfully … Do not finish
  while they are unexplained."* (`engine/muse_v0.rs` rule 3a; `completion.rs`).
* Why that rule kept firing: the host records a failed check under the **exact command identity** (`args_digest`,
  `inspect.rs` ~3324) and clears it only when that exact command later passes. The only failed key was
  `cargo test -- --nocapture` (#10). The model passed `cargo test`, `cargo test --verbose`, build, clippy, fmt …
  seven times (a different command each time, so the key never cleared). The run **finished immediately after #94
  re-ran `cargo test -- --nocapture` and it passed** — the one command the gate was waiting for. Everything between
  #19 and #94 (about 75 of 98 tool calls, ~70 of 106 turns) was the loop.
* Why the safety bound never tripped: the nudge budgets (`MAX_FAIL_NUDGES = 2`, `MAX_NUDGES = 7`) are meant to bound
  *consecutive stalls*, but `refresh_stall_budget` resets all of them whenever `edits_used + tests_used` grows — and
  every re-run test in this loop counted as "progress". The engine record ends with all nudge counters 0.
* The model's `muse_update_reasoning_state phase=verify` claims (4 retained, 13 accepted) were harmless claims; effort
  stayed `medium` all run. Policy V2 and the ladder played no part.

## The numbers on screen
* **Attempt numbers 75–106 vs "1–4" in run 1:** run 2 is a separate task with its own attempt counter starting at A1
  (`INTENT-00089-A106` is its 106th turn); run 1's 4 attempts were a different run. The engine record keeps only the
  **newest 32 attempts** (`MAX_ATTEMPTS = 32`) and the run keeps the newest **64 tool steps** (`MAX_ACTIVITY = 64`,
  indexes 35–98 of 98). So "32 attempts / 64 steps" were retention windows; the true totals are **106 turns / 98
  tool calls**. The three edits are not visible in the retained 64 steps (they were in steps 1–34).
* **Lineage:** verified. Run 2's engine record has `lineage {inherited: true, rule: "inherited", predecessorRun:
  run_69fe…, predecessorTask: task-8344…, predecessorRevision: 7}` and revision 7 is exactly run 1's final revision
  (authenticated record; the run-1 attempt 4 was recorded `failed`, as expected after cancellation).
* Run 1's resume prompt said "no file has been changed yet; no command has run yet", so run 2 correctly started from
  scratch; "Implementation fixes (from prior runs, retained)" in its summaries is the model's own wording.

## Recommended smallest correction (NOT implemented — needs your go-ahead)
1. **Primary:** in `refresh_stall_budget`, stop treating a re-run of an already-passing check as progress for the
   *stall* budgets: reset `fail_nudges`/`nudges` only when `edits_used` grows or the set of unresolved failed checks
   shrinks. Effect here: the gate would have yielded after two nudges (~#43 instead of #94).
2. **Optionally, with 1:** when the budget is exhausted with unresolved checks, the completion label already says so
   honestly ("failing-checks"); to keep it truthful when a *broader* command passed, normalise the failed-check key
   so output-only flags (`--nocapture`, `--show-output`, `--verbose`, `-q`) don't change identity.
These touch the completion gate only; no Policy V2, ladder, Registry/Kernel or authorization code. Both need tests
(an E2E that fails one command spelling and passes another) and the release gate's historical-body parity.

Unverified: the exact count of host refusals (the nudge messages are not stored in the transcript; ≥7 final reports are
visible); I did not reproduce the loop with the mock provider.
