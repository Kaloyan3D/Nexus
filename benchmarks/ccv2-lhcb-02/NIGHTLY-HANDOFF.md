# LHCB-02 morning handoff

Branch: `benchmark/ccv2-lhcb-02`. Production freeze SHA: `081c54070ee0ae62a8ae303bbcde9f930174cbed`.

Tonight's commit chain:

- `b98a3d6f535ccb586bbd9c9e2fda3d346bcdcb22` — `test(bench): harden LHCB-02 benchmark validity` (includes Task 1 architecture and calibration implementation).
- `6e61eeea6a8bae98ed46d46123eaf704d29b427c` — `feat(bench): build full LHCB-02 engineering workload`.
- This handoff's commit — `test(bench): prove LHCB-02 offline lifecycle`. Its exact SHA is available from local `git log -1` after committing; a file cannot include its own commit SHA.

Nothing was pushed. Production CCv2 sources, DSH and CCv2 thresholds remain unchanged. LHCB-01 mutable state was not used or changed; only its pinned Node binary was executed.

Implemented: deterministic 24 engineering phases plus T00/T99, progressive fixture release, causal contracts and host-only hidden obligation grading, six-phase calibration with durable per-request telemetry, conservative validation, checkpoint equivalence helpers and an explicitly offline full lifecycle driver. The rehearsal initializes a fresh root, commits the initial fixture deterministically with the user's Git identity, runs real cumulative graders, flushes fake durable events, seals a simulated checkpoint, restores the same canonical workspace for A/native, B/production and C/forced, collects T99 telemetry, grades each result and writes a deterministic report.

UNFROZEN: the manifest and workload remain UNFROZEN / LIVE_CALIBRATION_REQUIRED. Official execution is disabled. Natural CP-500, real compiler capability, production benefit and reasoning continuity remain unmeasured. The simulated checkpoint is never an official CP-500. Every simulated request carries its origin and is ineligible for live calibration. Reports keep independent capability, benefit and safety verdicts at NOT_MEASURED; live workload validity stays INADEQUATE. There is no combined score.

Final verification, using `/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node` (v24.18.1):

| Gate | Result | Executed evidence |
| --- | --- | --- |
| All LHCB-02 tests | PASS: 147/147, zero skipped | `--test tests/Ccv2Lhcb02*.cjs` (includes 27 new rehearsal/adversarial tests) |
| Affected LHCB-01 infrastructure regressions | PASS: 112/112, zero skipped | `--test tests/Ccv2Lhcb.Tests.cjs tests/Ccv2Lhcb.AutoRunner.Tests.cjs` |
| Whitespace/diff integrity | PASS | `git diff --check` and staged diff check |
| Production source guard | PASS: zero differing paths | `load('doctor').sourceGuard()` against production freeze SHA; installed frozen sources also verified by rehearsal tests |
| Provider/network audit | PASS: zero attempts | Offline blocker assertions in every test suite |
| Standalone clean-room lifecycle | PASS | Offline-preloaded CLI `rehearse`, fresh `/tmp/lhcb02-task4/final-rehearsal` |
| Live calibration / natural CP-500 / official benchmark | UNVERIFIED | Deliberately not executed |

Total: **259 passing tests**, no failures/skips. The standalone report is `/tmp/lhcb02-task4/final-rehearsal/reports/offline-rehearsal.json`; temporary files may be removed later, so the durable handoff records its results here. It reports PASS for offline lifecycle, 28 stage submissions, exactly three T99 submissions (one per arm), identical arm origin authority, and three passing final graders. Capability, benefit and safety are each NOT_MEASURED; workload validity is INADEQUATE.

The initial fixture commit is `026f5c555f6166ad086d1201c4207ffb93da13d3`, tree `33188686202f20633992c3e48f7f9f3acbd23448`, reproducible under the configured human Git identity. The standalone simulated checkpoint seal is `59ffe998ed4ba3e6f82b0b388d2fabf1af98e065d4ededd050e7dd336b18e3e5`. Root-bound namespace hashes intentionally differ for another root. Pre-checkpoint telemetry has 50 simulated requests; E01–E06 simulated pressure growth is respectively 19,398 / 19,383 / 19,366 / 19,382 / 19,381 / 19,355. These numbers are plumbing evidence only, never provider calibration metrics.

Important gaps fixed tonight: there was no full offline checkpoint-to-arms driver; interrupted restore needed recovery before normal root initialization; fake pressure anchors needed actual durable message IDs; simulation required explicit rejection by live calibration and its validator; completed grades needed collection and final-workspace corruption checks. Regression tests preserve those boundaries. Installed code hashes include all copied production code, and normalized policy hashes permit only the intended mode/activation differences. Reconstructed T99 request hashes, bytes and history counts match across arms.

Offline dress rehearsal exercises eleven crash boundaries: before prompt intent, after intent, after RPC provenance, before durable flush, after flush, checkpoint creation, completed checkpoint, partial restore, restore before T99, T99 before collection, and collection before grading. Resume must preserve one T00 and one submission for each E phase, one T99 per arm, 28 submissions total, and identical checkpoint origin authority across arms. Duplicate invocation must reproduce the report byte-for-byte without submitting again. Corrupt seals, journals and collections fail closed.

Remaining risks: these are synchronous simulated crashes, not machine power loss or live RPC faults. Fake repairs use a known correct positive control and say nothing about model performance. Fake usage exercises decoder/pressure/telemetry plumbing but cannot predict provider pressure or cache behavior. The decoder uses installed local DSH code; its dependency link is outside snapshot authority. Grader VM isolation is not an OS sandbox, and unrestricted model tools could discover host grader metadata without a separate live tool-access boundary. Official orchestration remains blocked. Live calibration may find that genuine evidence is too weak or too verbose for useful pressure; do not infer adequate workload from fixture bytes or this rehearsal.

The first command tomorrow is exactly this one. It has **not** been executed tonight. Run it from the existing checkout, with the branch above still selected and the existing provider setup available to the human operator:

```bash
/home/kaloyan/nexus-bench/ccv2-lhcb-01/nexus-root/runtime/node/bin/node /home/kaloyan/Projects/Nexus/scripts/bench/ccv2-lhcb-02/cli.cjs calibrate-fresh /home/kaloyan/nexus-bench/ccv2-lhcb-02-calibration-morning-20261005
```

The entry point refuses an existing target root, uses Node 24.18.1, prepares an isolated LHCB-02 calibration root, runs T00 followed by E01–E06 only, and stops with a calibration verdict plus per-phase pressure metrics. It cannot execute official arms or T99. No shell chaining, automatic deletion, retry loop, freeze, push or LHCB-01 state reuse is included. If the root already exists, inspect it; never delete it merely to make this command succeed.

Acceptance criteria: all six representative phases pass actual objective checks; each and average pressure growth is at least 10,000 authoritative tokens (15–25k is the target); inspect minimum, median and each phase, with no phase over 40% of total growth. Require unique terminal hashes, distinct meaningful evidence/tool observations, zero compiler executions, NATIVE mode, no DSH compaction or history replacement, monotonic provider input, contiguous identity-bound durable telemetry, and explicit availability for every metric. Cache read/write count once. Failed/unobserved requests cannot disappear. Missing evidence or unavailable required fields fail calibration. Even calibration PASS does not freeze or authorize an official benchmark.

If calibration fails: preserve the root, journal and reports, inspect the actual per-phase failures and useful evidence, then improve benchmark-only engineering work and repeat offline verification before a new isolated calibration. Do not lower thresholds, change production sources, count estimates as provider usage, pad prompts/tool outputs, force verbose responses, fabricate compiler metrics, discard failed requests, overwrite provenance, patch sources between arms, or continue into the official benchmark. Do not claim CCv2 benefit or reasoning safety.
