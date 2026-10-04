# CCv2 LHCB-02 live outcome — 2026-10-04

The complete finite native workflow (T00, E01–E24, T99) ran against the frozen production runtime. Calibration passed. The official attempt ended WORKLOAD_INADEQUATE: no natural CP-500 checkpoint was reached. This is not a scientifically valid CCv2 comparison and provides no benefit or reasoning-continuity verdict.

Tested implementation: `726e32e63c490f9fc1a0bb0bec95cb9529606487` on `benchmark/ccv2-lhcb-02`. Frozen production: `e0282c11d5bee29359c277cd5a9568ca13d62885`. Provider/model: `opencode-go` / `muse-spark-1.3-contributor`. Production behavior and frozen acceptance thresholds were not changed.

## Calibration

Fresh root: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261004-run7`. All six phases passed correctness, exceeded the frozen 10,000-token minimum, and showed no compiler execution, history replacement, or compaction.

| Phase | Pressure growth |
| --- | ---: |
| E01 | 14380 |
| E02 | 12308 |
| E03 | 14022 |
| E04 | 23659 |
| E05 | 15536 |
| E06 | 16113 |

Average: 16,003; median: 14,958; minimum: 12,308 tokens.

## Official attempt

Fresh root: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261004-run3`. All 26 prompts completed. E24 pressure was 165,998 tokens, 314,002 below the frozen CP-500 lower bound of 480,000. T99 ended at 192,995 tokens and is diagnostic only: neither its solution nor its pressure enables a checkpoint.

Native final task: SUCCESS. Overall correctness: FAIL. Passed 31/32 obligations (96.875%), including 19/19 critical obligations; zero evidence/tool modifications. The rollback-readers obligation failed: the submitted implementation migrates the canonical version-2 document to version 3 rather than preserving the original document. Frozen acceptance also requires every correctness test to pass, so the obligation ratio alone does not make this result PASS.

Production CCv2 and Forced CCv2 comparison arms: NOT RUN; correctness UNVERIFIED. No fair checkpoint baseline exists. Context/token reduction, comparative latency impact, CCv2 benefit, and reasoning continuity: NOT MEASURED. Native agent-turn latency totaled 1,831,372 ms (30.52 minutes), excluding host grading. There were 226 durable request rows; three have unavailable provider usage, so complete aggregate token totals remain null.

The first six phases produce meaningful context growth, but E07–E22 and E24 mostly add only a few thousand tokens. E23 added 11,355 after genuine atomic batch caller tests were introduced. The full finite workload needs substantive redesign to support the long-context scientific question; passing the six-phase calibration is insufficient. No filler, repeated completed phases, fabricated pressure, lowered thresholds, or T99-derived checkpoint was used.

| Phase | Pressure | Cumulative acceptance |
| --- | ---: | --- |
| T00 | 10330 | PASS |
| E01 | 21458 | PASS |
| E02 | 37431 | PASS |
| E03 | 51294 | PASS |
| E04 | 72937 | PASS |
| E05 | 89129 | PASS |
| E06 | 106069 | PASS |
| E07 | 108657 | PASS |
| E08 | 110808 | PASS |
| E09 | 113413 | PASS |
| E10 | 116302 | PASS |
| E11 | 118817 | PASS |
| E12 | 121402 | PASS |
| E13 | 123983 | PASS |
| E14 | 127428 | PASS |
| E15 | 130824 | PASS |
| E16 | 134545 | FAIL |
| E17 | 138829 | FAIL |
| E18 | 141120 | FAIL |
| E19 | 143825 | FAIL |
| E20 | 146944 | FAIL |
| E21 | 149367 | FAIL |
| E22 | 151941 | FAIL |
| E23 | 163296 | FAIL |
| E24 | 165998 | FAIL |
| T99 | 192995 | FAIL |

## Verification

| Gate | Result | Evidence |
| --- | --- | --- |
| LHCB-02 suite | PASS: 217/217 | `reports/full-test-results.log` in official run3 |
| Predecessor regressions on matching frozen source | PASS: 112/112 | `reports/lhcb01-frozen-test-results.log` in official run3 |
| Real calibration | PASS | observer run7 `reports/calibration.json` |
| Frozen runtime, source guard, normal OC01 and production preparation | PASS | official run3 `reports/execution-source.json`, durable stage reports |
| Official natural checkpoint and three-arm comparison | FAIL / UNVERIFIED | official run3 `reports/benchmark.json` |

329 relevant tests passed. Predecessor checks used an isolated clone with the predecessor’s matching frozen files; they are not a claim that old-freeze tests pass against a different freeze. No production source changed, so a new production build was not needed. Physical snapshot/restore, asynchronous accepted-before-header behavior, and real namespace isolation have executed test evidence; snapshot tests are not presented as live CP-500 proof.

## Architectural corrections

- Dedicated fresh-root calibration observer replaces inherited official lifecycle and recovery semantics.
- Production preparation owns pre-request routing authority; durable request routing is verified after the request exists.
- Off-mode policy and durable postconditions prove zero compiler use without inventing an active-decision event.
- Completed-turn/flush/provenance checks and frozen wire replay make telemetry faithful to actual asynchronous execution.
- Real namespace isolation prevents model access to hidden graders, host reports, and benchmark state.
- Official eligibility derives from real calibration evidence, actual pressure, and exact physical snapshot restoration; caller-supplied PASS cannot enable it.
- Public import, concurrency, batch, and final-coordinator contracts exercise real caller boundaries without lowering hidden acceptance.

## Reports

- Calibration: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-observer-20261004-run7/reports/calibration.json`
- Official result: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261004-run3/reports/benchmark.json`
- Full journal: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261004-run3/state/official-journal.json`
- Native usage availability: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261004-run3/reports/native-diagnostic-usage.json`
- Preserved run index and report hashes: `/home/kaloyan/nexus-bench/ccv2-lhcb-02-official-20261004-run3/reports/runs.json`

Each final root preserves the executed harness archive and verification logs. Earlier failed roots remain diagnostic evidence and were never resumed or promoted as successful results.
