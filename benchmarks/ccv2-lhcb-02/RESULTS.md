# LHCB-02 — terminal report, 2026-10-07

**EXTERNAL_BLOCKER_PROVIDER_INSTABILITY.** The single fresh qualification passed; the official run captured a valid natural CP-500. Native exhausted the frozen three-abort provider budget before completion. Production CCv2 and Forced CCv2 did not execute. This is an incomplete scientific comparison; no CCv2 benefit or negative quality result can be inferred.

## Frozen execution identities

- Branch: `benchmark/ccv2-lhcb-02`.
- Executed implementation HEAD: `d714cd0233201af7cd026189c76212fc60494b05`. The later report commit changes documentation only and is not the executed source.
- Frozen production source: `e0282c11d5bee29359c277cd5a9568ca13d62885`.
- Harness/contract hash: `78e3a12b8fcb986fb79ac083444b42178e7eb77084f591a0f784b05568b13dff`.
- Workload hash: `35d3c092a83fe7a4d0565504290286c9f4516dc539a0a48b2816f8a44a7f71dc`.
- Official protocol hash: `7f57829e23ed8add06f99482692fdb4d36676610b789a3d086735d333d1683fd`.
- Workload revision: `e05-audit-v1`; protocol revision: `scratch-v1`.
- Provider/model: `opencode-go` / `muse-spark-1.3-contributor`.
- 46 engineering phases; 48 prompts including T00/T99; 54 obligations, 19 critical.

## Implemented scope and verification

One connected E05 responsibility adds an audited posting adapter: preserve existing authorization, idempotency, clock, ledger and full response semantics while emitting a detached allowlisted audit decision for every normal outcome. Public and independent hidden scenarios verify success, replay, denied access, conflicts, invalid requests and tenant isolation. The existing critical redact-audit obligation is extended; every previous obligation and probe remains.

All original E05 artifacts are preserved; all other phase artifacts and 47 other prompts remain byte-identical. Scratch boundaries, production source, provider policy, telemetry and the 10,000 floor remain unchanged. No E47+ or post-live adjustment was introduced. Design, prompts, obligations and source hashes were frozen before live qualification.

All eight relevant benchmark suites **PASS, 294/294**, on the executed HEAD: Tests/Workload 142/142 and AutoRunner/Bootstrap/Certification/Isolation/Official/Rehearsal 152/152. Both full groups exited 0 with zero failed, cancelled or skipped tests. Final focused regression checks passed 4/4. These are benchmark gates, not a whole-product release certification.

Pre-live review history is retained: an incorrectly assembled test mutation was corrected; then a real oracle omission was reproduced RED (discarded full service response incorrectly accepted) and fixed before qualification. Two earlier gate attempts were cancelled and remain `CANCELLED_UNVERIFIED`, never counted as passes. These corrections preserve the single E05 engineering design. No source change followed observation of live pressure.

## Exactly one fresh qualification

Calibration20: **PASS**. Every growth meets the unchanged minimum; T00 and all six cumulative functional boundaries pass.

| Phase | Durable pressure growth | Qualification |
| --- | ---: | --- |
| E01 | 14,076 | PASS |
| E02 | 16,339 | PASS |
| E03 | 27,357 | PASS |
| E04 | 33,850 | PASS |
| E05 | 23,882 | PASS |
| E06 | 17,508 | PASS |

Minimum 14,076; mean 22,168.666666666668; median 20,695. Compiler executions 0; durable compactions 0; surface replacements 0; provider retries 0. All observed scratch reset receipts are empty, with no scratch artifacts carried into grading or seal.

The observed E05 growth is 23,882; the design preference for roughly 1k–3k additional pressure was an estimate, not a qualification ceiling. This single measured qualification was accepted without tuning or rerunning against its output.

Qualification-only diagnostics: 81 steps, 6,018,810 provider input tokens (including cache), 35,768 output tokens, peak provider prompt 144,013; successful durable execution latency 363,775 ms. Submitted qualification wall time 421,146.7434082031 ms excludes preparation/bootstrap. Reasoning-token count is unavailable. These figures do not establish any paired-arm reduction or latency benefit.

## Natural sealed checkpoint

First eligible completed engineering boundary: **E34, pressure 495,397**. E33 was 479,602, below 480,000; every earlier completed boundary was also below the eligibility window. All 35 completed prefix stages accepted. No phase target, rounding or pressure adjustment was applied.

Physical payload: 1,294 files. Independent verification of payload hashes, closure and source authority passed when sealed and again after terminal failure. Scratch is excluded.

- Seal: `14a86a35ebb8ac427bc61f718135cec1acafbd9c1dd25ecec2ea7b62765c2040`.
- Baseline hash: `aaea0370500fc35b75b9f6ba93fc9676db04edf9b4834c2195f1cdb624fdad9b`.
- Session log hash: `d4e1a3a09365213d5d14e58252229853222f105b2ddb0e055b86fa5f4b5eb1e4`.

Each of the three Native attempts records these same authorities. Between discarded attempts the existing driver restored the exact physical sealed checkpoint. A shared baseline for three *completed* comparison arms is not established because no arm completed.

## Frozen provider budget exhausted

All three failed requests have `failedRequestHasCommittedResult=false`; prior completed steps belong to discarded partial attempts and are retained in their evidence archives. No candidate-visible result from the failed request was accepted.

| Native attempt | Failed phase | Step / turn | Error | SDK scheduled / started | Observed SDK backoff ms | Aborted attempt wall ms |
| --- | --- | --- | --- | --- | ---: | ---: |
| 1 | E38 | 1 / 39 | TRANSPORT | 1 / 0 | None | 452,147 |
| 2 | E43 | 19 / 44 | TRANSPORT | 1 / 1 | 466 | 1,465,176 |
| 3 | E35 | 1 / 36 | TIMEOUT | 1 / 0 | None | 28,175 |

Attempt 1 accepted E35–E37 before the E38 connection error. Attempt 2 accepted E35–E42 before E43 transport termination. Attempt 3 timed out on the first E35 step. Native therefore has no T99 completion or full final grade.

One SDK retry **started in the discarded second attempt**, with observed backoff 466 ms. The first and third only scheduled a retry; their actual delay is unavailable, not zero. There were two fresh restarts after the initial attempt, three whole-attempt aborts, three SDK retry schedules and one SDK retry start. No successful measured arm includes an SDK retry because there is no successful complete arm.

The three aborted-attempt wall intervals sum to 1,945,498 ms. This excludes checkpoint prefix, qualification and restore gaps; it is neither clean successful latency nor full-arm wall latency. Partial completed-turn latency was 363,224 ms in attempt 1, 920,864 ms in attempt 2, and 0 ms in attempt 3; these discarded diagnostics are excluded from paired metrics. Scheduled SDK delays are retained separately in the machine report and must not be substituted for observed delays.

The unchanged maximum is three provider-aborted runs per arm. The third exhausted that budget and the official driver recorded `EXTERNAL_BLOCKER_PROVIDER_INSTABILITY`. No fourth attempt, new calibration, provider switch, post-hoc repair or policy change was performed. The original driver/witness process handles were unavailable during final reporting; terminal state is evidenced by the durable journal, failure report and console/witness logs, not a fabricated process exit code.

## Requested arm metrics

| Metric | Native | Production CCv2 | Forced CCv2 |
| --- | --- | --- | --- |
| Execution | INCOMPLETE, three provider aborts | NOT_EXECUTED | NOT_EXECUTED |
| Full correctness / critical correctness | UNVERIFIED | NOT_EXECUTED | NOT_EXECUTED |
| Full rollback / reasoning continuity | UNVERIFIED | NOT_EXECUTED | NOT_EXECUTED |
| Full compaction count / context usage | UNVERIFIED | NOT_EXECUTED | NOT_EXECUTED |
| Successful full execution / total wall latency | UNVERIFIED | NOT_EXECUTED | NOT_EXECUTED |
| Provider retry metrics | Three aborts; two restarts; one SDK retry start, above | NOT_EXECUTED | NOT_EXECUTED |

Completed prefix and partial continuation acceptance do not constitute a full final obligation grade. Successful qualification and pre-checkpoint rollback checks do not establish rollback or reasoning continuity after CCv2 compaction. Unexecuted arms must not be reported as zero-compaction, zero-token, zero-retry, or correctness PASS.

Absolute context reduction, percentage reduction, latency delta, correctness delta and critical-obligation delta are all **NOT_MEASURED**. No paired denominator or completed common continuation is available.

## Ten scientific questions

1. Does CCv2 reduce context on this workload? **UNVERIFIED**; neither CCv2 arm executed.
2. What is the absolute context reduction? **NOT_MEASURED**.
3. What is the percentage context reduction? **NOT_MEASURED**.
4. Does Production CCv2 preserve critical correctness? **UNVERIFIED**.
5. Does Forced CCv2 preserve correctness and critical obligations? **UNVERIFIED**.
6. Does rollback remain correct after compaction? **UNVERIFIED**; accepted pre-checkpoint rollback cannot answer this.
7. Is there a successful execution latency benefit? **NOT_MEASURED**; qualification and discarded attempts are not paired measurements.
8. Does CCv2 retain reasoning continuity? **UNVERIFIED**; behavioral full-arm continuity checks did not run.
9. Does the observed termination identify a CCv2 defect? **No**. Two transport failures and one timeout exhausted Native's provider budget before a CCv2 arm started; this provides no CCv2 failure attribution.
10. Is this a scientifically valid completed comparison? **No**. Workload qualification and natural checkpoint are demonstrated; the required three-arm comparison remains incomplete due to the frozen external-blocker stop.

## Immutable earlier experiments

Official15 remains **INFRASTRUCTURE_INVALID** due to unauthorized persistent root files, despite its separate diagnostic functional pass. Its checkpoint was not reused. Calibration19 remains **WORKLOAD_INADEQUATE**: E05 growth 9,864, shortfall 136; no rounding or reinterpretation. Neither old experiment was rerun unchanged to select a lucky pass. Final integrity verification checked 2,214 official15 files and 40 calibration19 files with no mismatch. The prior repository results text is preserved in this run's historical report artifact.

## Evidence

- [Machine scientific report](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/final-scientific-report.json).
- [Official failure report](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/benchmark-failure.json) and [durable journal](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/state/official-journal.json).
- [Executed source identity](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/execution-source.json) and [frozen source archive](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/harness-source.tar.gz).
- [All eight gate results](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/lhcb02-e05-frozen-gates.json).
- [Qualification](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run20/reports/calibration.json) and [qualification-only diagnostics](/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261006-run20/reports/calibration-only-metrics.json).
- [Checkpoint audit](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/independent-checkpoint-audit.json) and [terminal payload verification](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/terminal-checkpoint-integrity.json).
- [Prior experiment integrity](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/terminal-history-integrity.json) and [preserved calibration19 results](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/historical-calibration19-results.md).
- [Native attempt 1](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/provider-aborted-native-1/attempt.json), [attempt 2](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/provider-aborted-native-2/attempt.json), [attempt 3](/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261006-run16/reports/provider-aborted-native-3/attempt.json); each adjacent directory contains archived workspace, session evidence and controller log.
