# EM-04C2 S9.5 — pre-activation test hardening (follow-up to the independent audit's Low findings)

Branch `feature/native-s95-test-hardening`, based on the S9.5 identity commit `b3244c04ee1f06dd419f9046e09782cc3096d55c` (parent `cb2edbc`). **Uncommitted, for review.** Additions only (438 insertions, 0 deletions across 14 files): **no engine behavior, routing, transport, data-use tier, budget or production-gate change.** `MUSE_V1_PRODUCTION_ENABLED = false`; adaptive mode still `planned` / non-selectable / non-runnable; release binaries still register only `muse-v0`.

## F1 — Registry identity regression tests (`tests/RegistryAdaptiveMode.Tests.cjs`, +5 checks → 27; Rust `engine/tests.rs`)
* `nexus-adaptive-v1` is the adaptive scope's only engine, not issuable under `engineering-v2`; the former id and 20 near misses (case, whitespace, `_`, `-v2`, shadow/signals, `__proto__`, empty, path tricks, non-strings) are refused by `engineAllowed` in both scopes.
* `ADAPTIVE_CONTRACTS` = exactly `muse-v0` + `nexus-adaptive-v1`; the former contract id and near misses are unknown contracts (`slot-capability-not-satisfied`); a real `compileModeConfig` of a slot requiring the former contract is refused.
* No shipped definition or Registry code names the former id (outside comments that say "former/previous/old").
* Legacy import: with a stale `engineering-v2-adaptive.json` (former engine and contract, and each near-miss engine id) the built snapshot has exactly the three legacy modes, no error; `isOptionalModeDefinition` is false; the current file is listed.
* F4 evidence: a model scoped only to `muse-v1` (or `muse-v1` + `muse-v0`) fails `engine-scope-mismatch` for the adaptive mode; scoping to `nexus-adaptive-v1` is the required explicit operator update.
* Rust `the_adaptive_identity_resolves_in_one_pair_and_nothing_resembling_it_resolves_anywhere`: across 7 mode spellings × 17 near misses + the current id, exactly `(engineering-v2-adaptive, nexus-adaptive-v1)` resolves (test-engines build); every near miss → `engine-unavailable`; a production-shaped registry (`engines(false)`) contains neither id.

## F2 — authenticated predecessor tests (`code_a56.rs`, +3 E2E; harness key = the throwaway key of the test broker's own temp state dir; no production secret)
* `s95_an_authenticated_state_record_with_the_former_identity_is_refused_with_no_side_effects`: the crashed adaptive run's record is re-committed with `engine_id = "muse-v1"` (loads as authentic) → continuation `rejected` / `engine-state-identity`, turn 0, **0 provider requests**, engine-state directory listing unchanged (no new state), old record's revision not advanced (no new budget).
* `s95_a_run_record_with_the_former_identity_is_refused_even_when_its_state_is_authentic` → `engine-continuity-mismatch`, 0 requests, no new state.
* `s95_repeated_continuation_cannot_launder_the_former_identity`: three consecutive resumes along the chain (original → refused → refused → refused) are each `rejected` / `engine-state-identity` at turn 0, 0 requests, no state anywhere.

## F3 — supersession
A one-paragraph banner (identity is now `nexus-adaptive-v1`, no alias) was added at the top of nine historical reports that name `muse-v1` as live (activation plan/handoffs, S6, S7–S9, S7–S10, registry-authority, recovery matrix, production-gate results). Their bodies are untouched.

## F4 — operator note
Models scoped to the former engine id require an explicit operator update to `nexus-adaptive-v1` before the adaptive mode can use them; there is no alias or automatic rewrite (tested above). Include this in the S10 operator documentation.

## F6 — sealed digests before/after (`attempt_target.rs`, +1 test `the_rename_changes_exactly_the_digests_that_name_the_adaptive_engine`)
The same digest code was executed in the pre-rename tree (`cb2edbc`, temporary worktree, since removed) and in this tree for four representative `TaskBindingV1`s; identity (v2), identity (v1/legacy) and `binding_digest`:
| Binding | identity v2 | identity v1 | binding digest | before → after |
|---|---|---|---|---|
| `muse-v0`, default | `b367efc6…` | `b367efc6…` | `5c273dd3…` | **identical** |
| `muse-v0`, policy+budget 440000 | `90aeabe8…` | `4f7d6e82…` | `a562a159…` | **identical** |
| adaptive, former id `muse-v1` | `09c9dfd1…` | `483cf1c7…` | `ad8e8d95…` | (pre-rename value) |
| adaptive, `nexus-adaptive-v1` | `426db16e…` | `424d2b53…` | `61b45a03…` | **all three differ** from the former |
Asserted: every identity-dependent digest changes; the engine id is the only difference between the two bindings (renaming the field of the old binding reproduces the new digests exactly); `identity_matches(old digest, new binding)` is false in both the versioned and the legacy path (a run recorded under the old identity cannot be continued). The pre-rename values were reproduced by the unmodified code in `cb2edbc`, confirming the rename touches digests only through the engine-id input.

## Mutation checks (new tests fail when old-id acceptance is reintroduced)
| Mutant | Killed by |
|---|---|
| engine-state identity comparison dropped (`engine_state.rs`) | 2 of 3 `s95_` E2E (state-record, chain) |
| run-record continuity checks dropped (`inspect.rs`) | `s95_a_run_record…` |
| alias `muse-v1 → nexus-adaptive-v1` in `resolve` | Rust `the_adaptive_identity_resolves…` |
| former id added to the adaptive scope's experimental list | RegistryAdaptiveMode |
| former id added as a contract key | RegistryAdaptiveMode |
| legacy import accepts the former engine id (literal, and obfuscated so the string scan cannot see it) | RegistryAdaptiveMode (behavioral legacy-import check kills it independently) |
All sources were restored byte-identically after each mutant.

## Executed validation (this tree, uncommitted)
| Check | Result |
|---|---|
| `code_a56` (workspace build, own body dump) | 162 passed / 0 failed / 5 ignored (+3) |
| Release gate with `--bodies` (registry-js 22/22, engines 148/0 incl. new filters, e2e 36/0 incl. `s95_`, production 14 + negative control, real release binaries, desktop binary, bodies) | **PASS (acceptance run)** |
| Legacy body parity vs `50a24d7` | 116 tests, 1,170 bodies: 1,076 identical, 88 volatile tool output, 4 order-only, 2 polling-count-only (the one named timing test), **0 unexplained** |
| Full lock-file-pinned JS suite | 54/54 (R74 passed; issue #35 unchanged) |
| fmt, strict clippy (workspace, prodgate) | clean |
| Tauri tests | pass (exit 0) |
| Full offline workspace battery | **1,238 passed / 0 failed / 57 ignored** (91 result lines; +5 = the new tests) |
Failures: none observed in this checkpoint (the one adjustment: my first F1 draft asserted the default scope refused `muse-v1-shadow/-signals`, which are its by-design experimental ids; corrected in the test, not in code).
Not claimed: two consecutive batteries on an S10 activation commit; R74 root cause.
