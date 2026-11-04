# EM-04C2 S10 preflight — negative controls and mutation evidence

A control is valid only if the defective variant FAILS. All mutants were applied to a copy of the source, the named test run, and the source restored (byte-compared).

## Rust (SEC-1/3/4)
| Mutant | Killed by |
|---|---|
| inheriting engine always allowed a fresh start (`examine_predecessor` bypass) | unit `an_inheriting_engine_never_silently_starts_a_fresh_history` |
| engine-binding proof dropped (`state_source`) | same unit test; E2E `s10_a_run_record…` (the engine-binding variant is refused even earlier by `engine-continuity-mismatch`) |
| dispatch-evidence check dropped (unit) / `may_have_dispatched` always false (E2E) | unit test; E2E `s10_a_run_record_that_cannot_prove…` |
| chain-cut / depth guard dropped | unit test |
| `engineStateStarted` marker ignored | `s10_a_lost_or_damaged…`, `s10_a_chain_of…`, `s10_a_run_record…` |
| `predecessor_of` returns no ancestors | `s10_a_chain_of_state_less_continuations…` |
| SEC-3 ceiling removed | `s10_a_sealed_adaptive_budget_above_the_hard_guard…` |
| SEC-4 de-dup removed | `a_repeated_execution_id_in_the_feed…` (host refuses: "changed without an evaluation") |

## JavaScript (SEC-2): 8/8 killed by `RegistryAdaptiveMode`
unknown contract passes · any transport · any data-use tier · default outside ladder · any wireProfile · any execution kind · capabilities ignored · allowedReasoning outside ladder. (Four are also killed by `RegistryCore`.)

## Gates (`tests/EM04C2GateNegativeControls.Tests.cjs`, 13 checks; also run by the gate)
| Defect | Required result |
|---|---|
| each test-only symbol in a binary | scan FAIL |
| missing / empty / tiny executable, no artifacts (the old missing-`strings` hole) | UNVERIFIED, never PASS |
| a section SKIPPED or UNVERIFIED, empty run, unknown status | INCOMPLETE, exit 2 |
| `--allow-skip` | PASS but not an acceptance run; excuses only the named section |
| filter matching nothing / renamed test / non-zero exit / failed test | FAIL |
| empty dump dirs, missing dir, missing baseline test, < 116 tests, unequal counts, unreadable dump, changed non-input field | FAIL / UNVERIFIED |
| polling-count rule used on another test or with another change | UNEXPLAINED |
| real CLI with no tools on PATH and no `--bodies` | exit 2 `INCOMPLETE`, never PASS; empty dumps → exit 1 |
| leaky build (`selftest-leak`) | production gate tests fail (≥4) AND scanner detects it — checked inside the gate |
| gate caught a genuine leak-looking symbol in a prodgate test binary on its first full run (then fixed) | FAIL → fixed |

## R74 classification boundary
`EM04C2GateNegativeControls` check 14: a crashed PowerShell host (`Task.ps1 failed … Unhandled exception. System.IO.FileLoadException`) → `env:pwsh-host-runtime-fault` (UNVERIFIED); a lock-file version mismatch, an *allowed* authorization outcome, a wrong refusal code and empty text → not environmental (REAL).
