# CCv2 LHCB-02 outcome — 2026-10-06

**INFRASTRUCTURE_INVALID.** The frozen 46-phase workload reached the first natural CP-500 after E43 at **480,825 tokens**. Native continuation then completed E44–E46, but E46 created eight Python probe files outside `src/`. The frozen official guard rejected that successful durable turn with `lhcb-lhcb02-evidence-modified`. Full Native validation and the three-arm comparison did not complete. No CCv2 benefit, reduction, or continuity claim is supported.

This classification means an invalid benchmark execution, not a proven production infrastructure defect. The observed cause is **CANDIDATE_PROTOCOL_VIOLATION**. All original protected files retain their hashes; the rejected change is file addition outside the allowed source directory. Independent diagnostic grading after the stop passes all E01–E46 plus holdout checks, 47/47. That diagnostic cannot override the live protocol failure.

## Frozen execution

Branch: `benchmark/ccv2-lhcb-02`. Executed source: `2612a767098e2dda2f7bff96452eb50d44e2b4fb`. This report is a later documentation-only change; its containing commit must not be represented as the source used by the live runs.

| Identity | Frozen value |
| --- | --- |
| Production source | `e0282c11d5bee29359c277cd5a9568ca13d62885` |
| Harness / contract hash | `fbd25650963c7b94e8556c5a17ecd3a390e09e897fe1cf77afadf4eb7bb27ff9` |
| Workload hash | `1be00777f80eca08804f24cfe481d91f5a773351b3b5d48d76febe65e93cbf98` |
| Official protocol hash | `a929880038c4e09f4261d5a1aec0758e7d738b5d5b798ff461648c3f181ebf1d` |
| Provider / model | `opencode-go` / `muse-spark-1.3-contributor` |
| Runtime | Node 24.18.1, normally certified OC-01 authority |
| Workload | 46 engineering phases; 48 prompts including T00 and T99; 54 obligations, 19 critical |

E46 was added only after the previous actual E45 completed below the checkpoint minimum at 473,747 tokens. It implements canonical journal pagination with grants, replay proof validation, tenant cuts, cursor consistency, and stateful caller checks. All 47 prior released artifact sets and prompts remain byte-identical. Source, graders, thresholds, workload and provider policy were frozen before calibration18 and official15, and unchanged after the first checkpoint. No additional phases or pressure were added to trigger Production.

## Fresh calibration — PASS

Root: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run18`. Actual CLI exit 0. All six phases passed cumulative acceptance, with zero compilation, durable history compaction, or surface replacement.

| Phase | Pressure growth |
| --- | ---: |
| E01 | 13,088 |
| E02 | 20,744 |
| E03 | 18,620 |
| E04 | 38,227 |
| E05 | 10,270 |
| E06 | 18,835 |

Mean **19,964**, median **18,727.5**, minimum **10,270** tokens. Frozen calibration status PASS, reasons `[]`; the aspirational 15k–25k range is not substituted for the unchanged acceptance rules.

## Checkpoint and terminal failure

Official root: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15`. Actual driver exit **1**; journal state FAILED. First eligible engineering boundary: **E43, 480,825 tokens**, all T00/E01–E43 cumulative acceptance PASS. CP snapshot contains **1,781 files** and independently verifies without restore or candidate changes.

- Snapshot seal: `04a742a59ad8df2fede71051c0d3b87eafa0207d6e6d851b64d95ccbe6ec0554`.
- Physical baseline hash: `29ab87517a9bb149862de830bab5d19769ea65444829957dcc9062ea53a03eda`.
- Durable session hash at CP: `49267862f0b2904a433b5d41700a7094eaa460268d22f2b1d62efe52dd78ac6a`.
- Native E44: PASS, pressure 495,517; E45: PASS, pressure 519,293.
- E46: durable turn 47 completed at sequence 13,654; protected-file equality failed before official grading/pressure publication. Read-only terminal pressure is 554,375, diagnostic only.
- T99: NOT RUN. Native final correctness and final critical ratio: UNVERIFIED.

The eight added files are `probe_cs_a.py` and `probe_cs2_a.py` through `probe_cs2_g.py`. Durable `run_code` tool calls beginning at sequence 13,072 show candidate creation. No existing protected file was removed or changed. The exact hashes, tool calls, successful turn/end, and zero retry evidence are in the [terminal audit](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/terminal-protocol-violation-audit.json).

The [E46 prompt](/home/kaloyan/Projects/Nexus/benchmarks/ccv2-lhcb-02/prompts/E46-engineering.md) explicitly says “Edit src only”; the [contract](/home/kaloyan/Projects/Nexus/benchmarks/ccv2-lhcb-02/CONTRACT.md) defines the same boundary. The [frozen policy](/home/kaloyan/Projects/Nexus/benchmarks/ccv2-lhcb-02/PROVIDER-FAILURE-POLICY.md) states: “Successful turns, grading failures, protocol errors and source drift never retry.” This was a successful provider turn with a candidate protocol error. There is no authorized transient-provider retry, and no candidate repair, file removal, ignored guard, new prompt, or arm-specific exception was used. Production/Forced execution requires full Native validation under the frozen runner and therefore did not start. The requested full comparison remains incomplete.

## Arm evidence and timing

| Measurement | Native | Production CCv2 | Forced CCv2 |
| --- | --- | --- | --- |
| Completed valid full arm | NO; T99 absent, protocol failure | UNVERIFIED; not run | UNVERIFIED; not run |
| Final correctness / critical ratio | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Rollback | contract-rollback and journey-rollback PASS in incomplete Native diagnostic | UNVERIFIED | UNVERIFIED |
| Input tokens | 37,910,933, partial E44–E46 only | UNVERIFIED | UNVERIFIED |
| Peak provider prompt | 553,963, partial only | UNVERIFIED | UNVERIFIED |
| Output tokens | 33,556, partial only | UNVERIFIED | UNVERIFIED |
| Model steps | 73, partial only | UNVERIFIED | UNVERIFIED |
| Successful agent execution | 617,385 ms, partial only | UNVERIFIED | UNVERIFIED |
| Raw arm elapsed until terminal report | 702,763 ms, partial only | UNVERIFIED | UNVERIFIED |
| Provider retries / aborted attempts | 0 / 0 | UNVERIFIED | UNVERIFIED |
| Provider retry delay / observer errors | 0 ms / 0 | UNVERIFIED | UNVERIFIED |
| CCv2 compiled requests / compiler executions | 0 / 0 | UNVERIFIED | UNVERIFIED |
| Durable history compaction events / surface replacements | 0 / 0 | UNVERIFIED | UNVERIFIED |
| Reduction / comparative latency / continuity | NOT MEASURED | NOT MEASURED | NOT MEASURED |

Input includes uncached input plus cache-read and cache-write tokens once per observed request. Partial Native cache read: 37,832,505; cache write: 0. Reasoning-token usage is unavailable, not zero. Clean agent execution sums durable turn boundaries; raw wall includes host grading, startup and observation. Prefix successful execution is 3,766,629 ms and is excluded from continuation metrics. No provider outage is attributed to CCv2. Compiler execution and durable history compaction are separate quantities.

## Explicit scientific answers

1. **Does CCv2 reduce context/token usage?** UNVERIFIED; no completed paired comparison.
2. **By how many tokens?** UNVERIFIED; no paired absolute delta.
3. **By what percentage?** UNVERIFIED; no paired percentage.
4. **Production preserves all critical obligations?** UNVERIFIED; Production did not run.
5. **Forced preserves all critical obligations?** UNVERIFIED; Forced did not run.
6. **Rollback survives compaction?** UNVERIFIED. Native rollback probes pass before any compaction; this does not prove the after-compaction claim.
7. **Latency cost or benefit?** UNVERIFIED comparatively. The partial Native execution and wall timings above are diagnostic only.
8. **Reasoning continuity preserved?** UNVERIFIED for CCv2. All 46 engineering behavioral checks pass on the preserved Native candidate, but T99 and both CCv2 arms are absent.
9. **Did an arm fail because of CCv2 rather than provider instability?** No observed CCv2 failure; neither CCv2 arm ran. Native violated the source-only protocol, with zero provider retry events or aborted runs.
10. **Scientifically valid under frozen criteria?** **No: INFRASTRUCTURE_INVALID.** A natural valid checkpoint exists, but full Native validation, three valid arms and baseline equality across three runs are missing.

## Executed gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Eight benchmark/regression suites | PASS with recheck: 280/280 unique tests | [gate ledger](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/lhcb02-e46-frozen-gates.json) and archived raw logs |
| Original E31 anchor and new E46 focused checks | PASS: 8/8 | `lhcb02-e46-original-regression-restored.log` |
| Fresh real calibration18 | PASS | [calibration](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run18/reports/calibration.json) |
| Normal OC-01/source/route preparation | PASS for executed Native | `certification-bootstrap.json`, execution-source archive and durable records |
| Natural live CP-500 and physical seal verification | PASS | `snapshots/CP-500/snapshot.json`, verified 1,781 files |
| Live source-only protocol in E46 | FAIL | terminal audit and immutable pre-work hashes |
| Full Native T99 / concentration validation | UNVERIFIED | T99 not submitted; no `native-candidate-validation.json` |
| Production/Forced/equal three-arm baseline/benefit | UNVERIFIED | neither CCv2 arm started |
| Read-only diagnostic engineering grade | PASS: 47/47 | [diagnostic](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/post-failure-engineering-grade.json), ineligible for comparison |

The suites are `Ccv2Lhcb02.Tests`, `Workload`, `AutoRunner`, `Bootstrap`, `Certification`, `Isolation`, `Official`, and `Rehearsal`, executed with pinned Node `--test` in groups of two (138 tests) and six (142 tests). The final 138-test group ran on 2612a76; the 142-test group ran on e3d6d7 with byte-proven unchanged runtime and six suites. A previous 137/138 result exposed an accidental E31 test target rename; the original target, input and expected result were restored before the final passing recheck. Interrupted earlier checks and raw red diagnostics remain archived; this is not a clean-first-pass claim. Frozen production did not change, so a new production build/migration/release was not part of this benchmark-only task. No release-readiness claim is made.

## Per-phase pressure and concentration

Shares below use the **observed incomplete** Native total of 554,375 tokens. E46 pressure is a read-only post-failure diagnostic; T99 is missing. Observed maximum share is 6.3282%; the mandatory full Native concentration gate remains UNVERIFIED.

| Phase | Pressure | Growth | Observed share | Official acceptance |
| --- | ---: | ---: | ---: | --- |
| T00 | 7,587 | 7,587 | 1.369% | PASS |
| E01 | 41,332 | 33,745 | 6.087% | PASS |
| E02 | 55,793 | 14,461 | 2.609% | PASS |
| E03 | 73,402 | 17,609 | 3.176% | PASS |
| E04 | 97,669 | 24,267 | 4.377% | PASS |
| E05 | 113,294 | 15,625 | 2.818% | PASS |
| E06 | 125,812 | 12,518 | 2.258% | PASS |
| E07 | 139,619 | 13,807 | 2.491% | PASS |
| E08 | 144,554 | 4,935 | 0.890% | PASS |
| E09 | 149,419 | 4,865 | 0.878% | PASS |
| E10 | 154,591 | 5,172 | 0.933% | PASS |
| E11 | 159,310 | 4,719 | 0.851% | PASS |
| E12 | 164,331 | 5,021 | 0.906% | PASS |
| E13 | 169,639 | 5,308 | 0.957% | PASS |
| E14 | 175,404 | 5,765 | 1.040% | PASS |
| E15 | 180,624 | 5,220 | 0.942% | PASS |
| E16 | 187,768 | 7,144 | 1.289% | PASS |
| E17 | 194,616 | 6,848 | 1.235% | PASS |
| E18 | 199,478 | 4,862 | 0.877% | PASS |
| E19 | 204,848 | 5,370 | 0.969% | PASS |
| E20 | 210,687 | 5,839 | 1.053% | PASS |
| E21 | 215,702 | 5,015 | 0.905% | PASS |
| E22 | 220,978 | 5,276 | 0.952% | PASS |
| E23 | 234,949 | 13,971 | 2.520% | PASS |
| E24 | 240,627 | 5,678 | 1.024% | PASS |
| E25 | 258,411 | 17,784 | 3.208% | PASS |
| E26 | 268,814 | 10,403 | 1.877% | PASS |
| E27 | 285,138 | 16,324 | 2.945% | PASS |
| E28 | 298,019 | 12,881 | 2.324% | PASS |
| E29 | 310,023 | 12,004 | 2.165% | PASS |
| E30 | 324,921 | 14,898 | 2.687% | PASS |
| E31 | 339,573 | 14,652 | 2.643% | PASS |
| E32 | 349,840 | 10,267 | 1.852% | PASS |
| E33 | 358,823 | 8,983 | 1.620% | PASS |
| E34 | 370,043 | 11,220 | 2.024% | PASS |
| E35 | 382,279 | 12,236 | 2.207% | PASS |
| E36 | 389,978 | 7,699 | 1.389% | PASS |
| E37 | 404,593 | 14,615 | 2.636% | PASS |
| E38 | 413,228 | 8,635 | 1.558% | PASS |
| E39 | 425,641 | 12,413 | 2.239% | PASS |
| E40 | 435,865 | 10,224 | 1.844% | PASS |
| E41 | 450,725 | 14,860 | 2.680% | PASS |
| E42 | 461,384 | 10,659 | 1.923% | PASS |
| E43 | 480,825 | 19,441 | 3.507% | PASS |
| E44 | 495,517 | 14,692 | 2.650% | PASS |
| E45 | 519,293 | 23,776 | 4.289% | PASS |
| E46 | 554,375 | 35,082 | 6.328% | PROTOCOL FAIL; diagnostic behavior PASS |
| T99 | — | — | — | NOT RUN |

## Preserved reports and changes

- [Machine-readable terminal result](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/final-scientific-report.json), [raw runner failure](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/benchmark-failure.json), [full journal](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/state/official-journal.json).
- [Execution source and test proof](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/execution-source.json); `harness-source.tar.gz` preserves executed source rather than this later report commit.
- [Per-phase observations](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/per-phase-pressure.json), [terminal protocol audit](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/terminal-protocol-violation-audit.json), [terminal candidate/session archive](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run15/reports/terminal-native-evidence/capture.json).
- Earlier results and failed attempts remain separate: `historical-results-20261004.md`, `prior-attempts.json`, old official14 below-CP proof, and all raw diagnostic logs. They are not mixed into this comparison.

At most five substantive changes in this completion sequence: one authorized E46 canonical pagination workflow; independent public/withheld stateful probes and malformed-proof regression; permanent preservation checks for all prior artifacts; restoration of the original E31 regression target; final evidence/report archival. The source-only guard, provider policy, frozen production and scientific thresholds were not changed after checkpoint. No source repair or measurement retry was performed after the candidate protocol violation.
