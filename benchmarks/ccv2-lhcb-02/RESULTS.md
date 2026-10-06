# CCv2 LHCB-02 scratch revision qualification — 2026-10-06

**WORKLOAD_INADEQUATE for the required representative-calibration qualification.** The new scratch protocol passed all eight regression suites (290/290) but its first fresh real calibration failed the unchanged per-phase pressure-growth floor: **E05 = 9,864 < 10,000**, a 136-token shortfall. All six functional phases passed; no provider retry, unauthorized persistent mutation, compilation or durable compaction occurred. New official execution was not started, so the requested three-arm result remains incomplete.

This verdict is scoped to the calibration eligibility gate. Full 46-phase length on this new revision is UNVERIFIED. Official15 had already proved the old workload naturally reached CP-500; that historical observation remains intact and cannot replace a passing calibration under the new hashes. No conclusion about CCv2 benefit or failure follows from this pre-comparison qualification result.

## Frozen identity

Branch `benchmark/ccv2-lhcb-02`; executed implementation **`3fbbd38b087b5491c7212046fac1ad0f49737446`**. This report is a later documentation-only commit, not the implementation executed by tests/calibration.

| Item | Frozen identity |
| --- | --- |
| Protocol revision | `scratch-v1` |
| Frozen production | `e0282c11d5bee29359c277cd5a9568ca13d62885` |
| Harness / contract hash | `587989f5911a14c3e133733e048448ccd7918159fbecd33856ab105099a05abe` |
| Workload hash | `ca7b35b8d6427ea6008ab89816a3bab21d9e75f91d07e41c45aa1a5091e604db` |
| Official protocol hash | `7f1477e1d0915e4a353ad7ff369ec96df9d97e5fc1a4aba426301a1dfd9fbae0` |
| Provider / model | `opencode-go` / `muse-spark-1.3-contributor` |
| Node | 24.18.1 |
| Workload | 46 engineering phases, 48 prompts including T00/T99 |
| Correctness obligations | 54 total, 19 critical; unchanged |
| Calibration root | `/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19` |
| New CP-500 pressure / phase | NOT MEASURED; no new official execution |

Production code, provider failure policy, fixture/case algorithms, grader set, obligations, phase graph, acceptance ratios and CP thresholds are byte-identical to the preceding revision. Each of the 48 prompts appends exactly the same scratch contract; all previous functional bodies remain unchanged. New prompt/workload hashes are intentional and no old prompt-byte identity is claimed. No E47+ was added.

## Scratch boundary and lifecycle

See [the scratch protocol and ten architecture answers](/home/kaloyan/Projects/Nexus/benchmarks/ccv2-lhcb-02/SCRATCH-PROTOCOL.md).

The benchmark owns `ROOT/scratch`, outside `workspace`, mounts it into the isolated namespace and supplies `$LHCB_SCRATCH`. Persistent implementation edits remain `src/` only. Scratch contents are validated/reset before and after every phase, including T00/T99, and at arm restore. Scratch is absent from candidate grading and physical snapshot payload; seal requires it empty. Symlinks, hardlinks, special files and path traversal are rejected. Source aliases to scratch fail before inventory. Repository-root probes, protected additions/deletions/mutations and moving scratch to unauthorized persistent paths remain protocol failures. Runtime-owned `.ai-harness` and Git metadata retain existing treatment, including traversal rejection of nested Git symlinks.

Executed tests cover actual namespace scratch creation and Python execution, deterministic reset without candidate changes, root probes, protected mutation, unauthorized moves, traversal, symlink/hardlink escapes, candidate aliases, snapshot exclusion/empty seal, and no carryover at physical restore. Focused result: **84/84 PASS**. The calibration records an empty scratch reset before/after all seven prompts; the model did not retain any temporary artifact in these six early tasks. Tests prove the scratch behavior; no claim is made that late-phase model behavior has been observed on this revision.

## Fresh calibration19 — FAIL

Actual CLI exit **2**, journal COMPLETE, all T00/E01–E06 cumulative acceptance PASS. The failed eligibility condition is pressure growth, not an incomplete turn or provider error.

| Phase | Final pressure | Pressure growth | Functional acceptance | Growth floor |
| --- | ---: | ---: | --- | --- |
| E01 | 32,306 | 19,334 | PASS | PASS |
| E02 | 53,351 | 21,045 | PASS | PASS |
| E03 | 72,296 | 18,945 | PASS | PASS |
| E04 | 97,838 | 25,542 | PASS | PASS |
| E05 | 107,702 | 9,864 | PASS | FAIL |
| E06 | 123,281 | 15,579 | PASS | PASS |

Mean **18,384.833333**, median **19,139.5**, minimum **9,864** tokens. Exact failure reasons: `['E05:growth-below-10000']`. The target 15k–25k range and overall mean do not override the mandatory per-phase minimum. Growth uses authoritative durable provider pressure boundaries; first E05 before = 97,838 and last after = 107,702. No 136-token rounding allowance exists in the frozen criteria.

The official runner requires `calibration.status === PASS` with matching new workload/harness identity and scratch receipts. Running official16 from this FAIL report or using old calibration18 would violate that requirement. Repeating this unchanged revision to select a chance PASS, removing the failed phase, modifying pressure telemetry, adding pressure-only work, or lowering the floor was not performed. The fresh calibration result is preserved as the actual qualification outcome. The remaining three-arm work cannot be scientifically executed under this failed qualification.

Calibration-only supplemental metrics: **65 steps**, **4,463,026 provider input tokens**, peak provider prompt **123,019**; successful model/agent execution **380,308 ms** from durable turn boundaries. Submitted calibration wall interval **438,703 ms**, from first T00 submission to report publication, excluding preparation/bootstrap. Provider retries **0**, observer status failures **0**, compiler executions **0**, durable compaction events **0**, surface replacements **0**. These are calibration observations, not a full Native arm or comparative CCv2 latency/token result. Input includes uncached plus cache read/write once; unavailable reasoning metrics remain null.

## Three-arm status

| Required result | Native | Production CCv2 | Forced CCv2 |
| --- | --- | --- | --- |
| Full arm executed | NO | NO | NO |
| Final correctness / critical ratio | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| New revision rollback result | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Compiler executions / compiled requests | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Durable compaction count | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Effective context / total input tokens | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Successful model latency / full wall latency | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Provider retries for full arm | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Absolute / percentage reduction | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Critical reasoning / continuity after CCv2 | UNVERIFIED | UNVERIFIED | UNVERIFIED |

No full-arm zero or PASS is inferred from calibration. No old/partial Native evidence is paired with an unexecuted CCv2 arm.

## Ten scientific answers

1. **Does CCv2 reduce effective context/token usage?** UNVERIFIED; no new three-arm comparison.
2. **By how many tokens?** UNVERIFIED; no paired absolute delta.
3. **By what percentage?** UNVERIFIED; no paired percentage.
4. **Does Production preserve all critical obligations?** UNVERIFIED; not run.
5. **Does Forced preserve them?** UNVERIFIED; not run.
6. **Does rollback survive compaction?** UNVERIFIED on this revision; E16/full arms and compaction comparison were not executed.
7. **Measurable latency cost or benefit?** UNVERIFIED comparatively. Calibration-only clean and wall intervals above are supplemental.
8. **Reasoning continuity preserved?** UNVERIFIED across CCv2; neither CCv2 arm ran.
9. **Did an arm fail because of CCv2 rather than provider instability?** No observed CCv2 failure or provider instability. The new attempt stopped at the frozen calibration growth gate, before any arm.
10. **Scientifically valid under frozen criteria?** **No.** Verdict **WORKLOAD_INADEQUATE**, scoped to failed representative qualification; mandatory calibration PASS, new CP-500 and three completed valid arms are absent.

## Gates and evidence

| Gate | Actual result | Evidence |
| --- | --- | --- |
| Tests + Workload | PASS: 138/138, exit 0 | `lhcb02-scratch-reviewed-full-workload.log`, 942,196.724957 ms |
| AutoRunner + Bootstrap + Certification + Isolation + Official + Rehearsal | PASS: 152/152, exit 0 | `lhcb02-scratch-reviewed-full-observers.log`, 810,752.598562 ms |
| Focused scratch/runtime/official checks | PASS: 84/84, exit 0 | `lhcb02-scratch-boundary-reviewed-focused.log` |
| Fresh real calibration19 | **FAIL**, exit 2 | `reports/calibration.json`, `state/calibration-journal.json` |
| Normal OC-01 / source / route preparation | PASS for calibration | certification bootstrap and durable request records |
| New natural CP-500 / full Native validation | UNVERIFIED | new official run not started |
| Three equal-baseline completed arms / benefit | UNVERIFIED | no new arm reports |
| Official15 immutable history | PASS: 2,214 unchanged file hashes | `lhcb02-scratch-official15-history-integrity.json` |

Raw commands and log hashes for all eight suites are in [the gate ledger](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19/reports/lhcb02-scratch-frozen-gates.json). No required FAIL/UNVERIFIED gate is presented as ready. Production source did not change; production build/release/migration work is outside this benchmark-only revision.

The first pre-live implementation `76bcdd2` briefly started full gates but self-review found a dropped nested Git symlink traversal check. Its owned test processes were stopped and logs classified **CANCELLED_UNVERIFIED**, before any live call. A permanent regression test demonstrated RED before restoring the original traversal; final `3fbbd38` then passed focused checks and all eight complete suites. Cancelled logs are retained and do not count toward the 290 passes. The T99 functional-body hash anchor remains unchanged; its new scratch addendum is explicitly tested rather than replacing the old correctness oracle.

## Official15 stays permanently invalid

Official15, `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15`, remains **INFRASTRUCTURE_INVALID / CANDIDATE_PROTOCOL_VIOLATION** under the old frozen protocol. E43 reached the first natural CP-500 at **480,825**; E44 and E45 passed at **495,517** and **519,293**. E46 had a durable completed turn and diagnostic pressure **554,375**; independent post-stop E01–E46/holdout grading passed **47/47**, but it created eight Python probes outside `src/`, so the old strict guard correctly stopped. That result is neither repaired nor reinterpreted.

The new revision was created to give temporary diagnostics a distinct ephemeral boundary. Its source and calibration identity differ honestly from official15. The old physical checkpoint, session, source archive, candidate and reports remain untouched; 2,214 stored file hashes were verified unchanged. Old rollback/pressure/diagnostic evidence is historical only. All future CCv2 claims must come solely from a new-qualified frozen revision and its three completed arms; no such claims are made here.

## Reports and at most five changes

- [Machine-readable qualification outcome](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19/reports/scratch-revision-qualification-outcome.json), [actual calibration](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19/reports/calibration.json), [calibration-only metrics](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19/reports/calibration-only-metrics.json).
- [Executed source and archived gates](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19/reports/execution-source.json), `harness-source.tar.gz`; [preservation proof](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run19/reports/lhcb02-scratch-preservation-proof.json).
- [Official15's original report](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/RESULTS.md); its candidate/probe/session evidence remains at that original root.

Changes: explicit isolated scratch directory/environment; deterministic phase/arm reset and empty-snapshot rules; uniform prompt addendum/new revision hashes; strict persistent guard with preserved Git link rejection; deterministic boundary regressions and immutable-history archival. No production, CCv2, functional task, obligation, grader, threshold, provider/model or provider-retry-policy change.
