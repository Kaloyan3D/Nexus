# Task 3 candidate report

UNFROZEN / LIVE_CALIBRATION_REQUIRED. Offline engineering candidate only. No provider/network calls, live calibration, official benchmark, freeze, production edits, threshold reductions or push.

Implemented: 24 engineering phases plus T00 and T99; deterministic full-fixture reconstruction; all-phase acceptance; hidden final integration/obligation grader; content-free inspector and semantic fingerprints; offline byte-equivalent A/B/C fixture/state/durable clones. E01–E06 keep their existing order. E07–E24 implement the CLI, legacy import, segment quarantine, observability, review checks, reservations, index, retry, grants, rollback, gateway, reconciliation, export, operations, cancellation, client, batch and readiness paths. T99 implements the coordinator and exercises earlier decisions without changing its prompt.

## Offline measurements (NON-AUTHORITATIVE)

| Property | Observed value |
| --- | --- |
| Phases | 26 total; 24 engineering |
| Released artifact files | 119 |
| Released bytes | 664,879 |
| Unique complete artifact hashes | 119; zero repeated hashes |
| Unique exact and semantic evidence sets | 26 each |
| Public behavioral cases | 2,071, including two coarse T99 smoke cases; trusted grader adds 10 private workflows |
| Dependency edges | 98 |
| Maximum dependency distance | 24 phase positions |
| Early-to-late edges | 22 |
| Hidden obligations | 32 across nine categories |
| Critical obligations | 19 |
| T99 obligation coverage | 32/32; critical 19/19 |
| T99 prompt SHA-256 | e34bafce498b56aa99bd382a644ecfe71b30ad24302384b712d0ef70035c3069 |

Hashes measure novelty of complete bytes. Semantic source/case sets ignore paths and generated case IDs so renaming cannot create new business evidence. They do not prove useful reasoning depth. No token or pressure estimate is derived from these numbers. The inspector exposes counts/categories/hashes rather than hidden rules or probe names.

Concrete integration probes exercise import→API→store, migration/authorization→recovery, timeout-after-commit→same-key replay, migration/grant/reservation/CLI→gateway→service, and batch→atomic store publication. All earlier suites run at final grading. Some graph edges express contract/data provenance rather than a separately instrumented necessary effect; graph validity does not prove every declared edge causally necessary.

T99 releases only coarse status/commit smoke expectations; detailed early/middle/late workflows and expected answers remain in the trusted grader. Public T99 examples cannot restate replay, recovery, migration or security answers. Its CLI grader runs in an isolated, credential-free worker with a 30-second outer limit and treats unavailable observations as failure.

The positive control repairs the candidate using reference implementations retained outside the released workspace. The unmodified reconstructed candidate deliberately fails. Tests replace early/middle/late implementations, forge superficial success, mutate protected evidence and alter snapshot bytes to verify failure. Progressive checks require observed intended source/incident bytes, a pre-work inventory, real source changes and cumulative correctness; they do not grade prose.

## Executed gates

Pinned executable: `/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node`, v24.18.1.

| Gate | Result |
| --- | --- |
| `--test tests/Ccv2Lhcb02.Tests.cjs` | PASS: 32 |
| `--test tests/Ccv2Lhcb02.AutoRunner.Tests.cjs` | PASS: 31 |
| `--test tests/Ccv2Lhcb02.Workload.Tests.cjs` | PASS: 57 |
| All three LHCB-02 suites together | PASS: 120 |
| `--test tests/Ccv2Lhcb.Tests.cjs tests/Ccv2Lhcb.AutoRunner.Tests.cjs` | PASS: 112 |
| Total | 232 passed; zero failures, skips, cancellations or todo |
| `git diff --check` and staged equivalent | PASS |
| Production source guard vs `081c54070ee0ae62a8ae303bbcde9f930174cbed` | PASS; differing paths `[]` |
| Native pressure / live calibration / official benefit | UNVERIFIED; not executed |

The new 57-test suite covers every phase's determinism, ordering/graph corruption, hidden/critical coverage, exact and semantic novelty, prompt/T99 stability, deliberately failing incidents, grader determinism, lost-contract mutants, immutable evidence, inspection/change gates, progressive acceptance, clean source-bundle reconstruction without installed dependencies, and offline clone equivalence. Existing 63 LHCB-02 hardening tests remain intact.

## Before live calibration

450k–600k native pressure remains a hypothesis, not a measured result. Compact modules and clustered failures may yield much less than the unchanged 10k-per-phase floor. Enrich actual engineering incidents after measuring; never force exhaustive reads, verbose output or duplicate work.

The live submission runner still calibrates the original six phases only. All-phase acceptance is implemented as an offline authority validator and must be bound to durable runtime provenance before any full live execution. Its current inspection receipt requires complete original source/incident tool-result bytes; missing/partial/decorated reads fail closed rather than being inferred. A runtime without ordered native compiler decisions cannot claim an observed zero.

Offline snapshot clones prove supplied fixture/state/session bytes equal, including T99 bytes. They do not implement progressive runtime CP-500 checkpoints or demonstrate resumability. Natural pressure, exact runtime restore authority and grader tool confinement remain blockers; official eligibility remains false. Restricted Node realms do not replace OS-level isolation. The in-memory store, explicit crash-cut journals and schedule simulator test deterministic contracts, not fsync or real distributed concurrency.
