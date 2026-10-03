# Task 2 adversarial audit (historical)

This records commit b98a3d6. Task 3 supersedes the missing full-workload/final-grader statements; live pressure, runtime checkpoint/restore and tool confinement remain blocked.

LHCB-02 is not currently a valid measurement of CCv2 benefit. Its offline calibration harness is hardened, but native pressure growth, progressive checkpoint/restore, full causal coverage and agent-tool isolation remain unverified or unimplemented. Official eligibility always fails closed. No provider/network calls, live calibration, official benchmark, production changes, threshold changes, push or merge were performed.

## Findings and corrections

| Audit area | Weakness found | Correction and evidence |
| --- | --- | --- |
| Workload validity | Cartesian diagnostics could inflate history without useful new evidence; graph edges alone did not demonstrate causality. | Cap diagnostics at eight distinct signatures, remove exhaustive-read/output pressure instructions, add migration → service/API and migration/authorization/committed-history → recovery consumer probes. Document E07–E24 as proposals and concurrency as a deterministic simulator. Reference implementation still passes visible cases and independent probes. |
| Grader independence | Candidate modules ran beside trusted assertions and could print a forged PASS, exit, modify assertions, or conceal mutation with serialization hooks. | Trusted parent owns expected cases and compares outputs and post-execution inputs. Candidate modules execute in a restricted realm without host objects, process, filesystem or arbitrary require. Trusted helpers live in a separate lexical closure; serializer rejects hooks/accessors/cycles. Regression attacks fail; correct reference behavior passes. This is not proof of OS-level secrecy from agent tools. |
| Arm fairness | Mutable caller claims could certify a snapshot and invoke the incompatible LHCB-01 scorer. No actual LHCB-02 restore chain proved equal histories. | Remove claim-based authorization and old fixed-obligation scoring. Prospective comparison requires identical snapshot/workspace/durable/session/source/grader/contract/route/T99 hashes and identities, with only intended compiler policy differences. Metadata consistency is necessary, not proof; official arm execution is unavailable. |
| Checkpoints | Reused LHCB-01 snapshot implementation expects pristine fixtures, incompatible with progressive LHCB-02 edits. Synthetic pressure claims could enable a verdict. | Disable public checkpoint/restore/official scoring seams before mutation. Natural CP-500 at 480k–550k and exact restored authority hashes remain UNVERIFIED. No checkpoint can be declared from calibration or submitted claims. |
| Calibration | Average-only statistics, editable journal pressure, transient IDs in duplicate detection, missing/failed requests and hardcoded compiler labels could produce a false PASS. | Every phase and mean must exceed the fixed 10k floor; report median/minimum and reject a phase contributing over 40%. Summaries derive from durable request evidence. Content hashes ignore transport IDs. Failed/interrupted/unobserved requests remain represented and fail validity. Require a corresponding durable native controller decision for every request, not just an off policy; missing or contradictory observations are unavailable/failing. |
| Telemetry | Response-only accounting omitted unsuccessful attempts; cache categories, identities and missing measurements were insufficiently constrained. | Rebuild telemetry from durable authority rather than mutable cached reports. Capture every step/retry, unique request/attempt identity and non-overlapping durable ranges, cache categories once, output and optional reasoning, pressure/delta, message/wire/historical-tool counts, reconstructed canonical bytes/hash, compiler mode/count. Nulls carry explicit availability reasons. Frozen wire projection is reconstruction, not a captured socket payload. |
| Failure/resume | Stale runner objects could replace sessions; malformed journals, empty grades, missing release evidence, partial preparation and concurrent invocations were unsafe. Later fixes could upgrade earlier failures. | Reload and validate the journal under an exclusive PID/start-token lease; validate identity/provenance/prefixes; atomically publish owned staging; validate release receipts and immutable evidence; reject empty grades; seal acceptance at its completion source state. An unresolved saved intent is never resent. |
| Gaming | Forged certification, histories, grader output, evidence freshness, pressure and omitted requests could manufacture success. | Regression attacks cover these paths; official benefit remains NOT_MEASURED even when offline calibration evidence passes. T99 remains byte-identical in prospective arm checks and does not enumerate prior obligations. No production source patching is used. |

## Failure tests and limits

Executed offline tests cover crashes before intent/submission, after intent before RPC, after RPC, after idle before durable flush and after flush; lost submission response; duplicate and concurrent invocation; PID reuse; foreign listener and listener substitution; cold API polling; malformed journal/lease; partial fixture/release/preparation; missing evidence; compressed-session truncation; drifted durable prefixes; interrupted-restore marker rejection; and immutable historical acceptance. Transport tests use mocks, never a provider or socket.

A crash after saved intent but before RPC is intentionally unresolved: there is insufficient authority to safely distinguish it from an accepted RPC with lost evidence, so resume blocks instead of duplicating the prompt. Use a fresh root for a new calibration after investigating the incomplete run.

Crash-during-checkpoint and crash-during-restore cannot be exercised as real LHCB-02 transitions because those transitions are unimplemented and disabled. Tests prove rejection before destructive action and rejection of an incomplete restore marker. LHCB-01 regression results do not certify an LHCB-02 progressive snapshot. These remain explicit prerequisites for any future official implementation.

Hash diversity measures byte novelty, not engineering meaning. Unique source incidents and causal consumer probes improve workload evidence, but do not prove 10k useful tokens per phase. Bounded diagnostics may make real growth fall below the floor; that must require workload redesign. Hidden grader placement outside the workspace does not stop unrestricted tools from reading it. A restricted Node VM does not replace a hardened OS process boundary or resource limits. A runtime that does not emit durable native compiler decisions cannot pass calibration: off policy alone does not manufacture an observed zero. Future official work must establish tool confinement, full critical-obligation integration grading and restored baseline evidence before removing the blocker.

## Executed gates

Pinned runtime: Node v24.18.1 at `~/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node`.

| Gate | Result |
| --- | --- |
| `--test tests/Ccv2Lhcb02.Tests.cjs` | PASS: 32 tests |
| `--test tests/Ccv2Lhcb02.AutoRunner.Tests.cjs` | PASS: 31 tests |
| `--test tests/Ccv2Lhcb.Tests.cjs tests/Ccv2Lhcb.AutoRunner.Tests.cjs` | PASS: 112 tests |
| Total | 175 passed; zero failed, skipped, cancelled or todo |
| `git diff --check` and staged equivalent | PASS |
| Production source guard against `081c54070ee0ae62a8ae303bbcde9f930174cbed` | PASS; differing paths `[]` |
| Live pressure/calibration, natural CP-500, official A/B/C benefit | UNVERIFIED / NOT_MEASURED; not executed |

The original 27 LHCB-02 tests were expanded by 36 adversarial/regression cases. Real weaknesses were reproduced before repair, including forged grader output, host assertion access, serialization concealment and trusted-helper replacement. The final suites include both rejection attacks and passing reference behavior; acceptance expectations were not weakened.
