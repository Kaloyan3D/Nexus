# CCV2-LHCB-01 implementation handoff

CCV2-LHCB-01 environment ready for review and dry-run.

The isolated installation is staged at `/home/kaloyan/nexus-bench/ccv2-lhcb-01`.
No real Muse/OpenCode benchmark, live provider call, push or commit was performed.
The fixture remains intentionally unsolved. There are no live runs or snapshots;
the empty report has three independent `INSUFFICIENT_DATA` verdicts.

## Exact repository changes

All 35 files below are additions, currently untracked. No existing tracked file
was changed. The installation, generated workspace and receipts are outside Git.

```text
benchmarks/ccv2-lhcb-01/CONTRACT.md
benchmarks/ccv2-lhcb-01/IMPLEMENTATION.md
benchmarks/ccv2-lhcb-01/REVIEW.md
benchmarks/ccv2-lhcb-01/RUNBOOK.md
benchmarks/ccv2-lhcb-01/fixture/create-fixture.cjs
benchmarks/ccv2-lhcb-01/grader/cases.cjs
benchmarks/ccv2-lhcb-01/grader/grade.cjs
benchmarks/ccv2-lhcb-01/grader/offline.cjs
benchmarks/ccv2-lhcb-01/manifest.json
benchmarks/ccv2-lhcb-01/obligations.json
benchmarks/ccv2-lhcb-01/prompts/P01-architecture-audit.md
benchmarks/ccv2-lhcb-01/prompts/P02-storage-audit.md
benchmarks/ccv2-lhcb-01/prompts/P03-api-audit.md
benchmarks/ccv2-lhcb-01/prompts/P04-test-audit.md
benchmarks/ccv2-lhcb-01/prompts/P05-failure-audit.md
benchmarks/ccv2-lhcb-01/prompts/P06-security-audit.md
benchmarks/ccv2-lhcb-01/prompts/P07-regression-audit.md
benchmarks/ccv2-lhcb-01/prompts/T00-contract.md
benchmarks/ccv2-lhcb-01/prompts/T99-final-challenge.md
benchmarks/ccv2-lhcb-01/schema/report.schema.json
benchmarks/ccv2-lhcb-01/schema/result.schema.json
benchmarks/ccv2-lhcb-01/schema/snapshot.schema.json
scripts/bench/ccv2-lhcb/arms.cjs
scripts/bench/ccv2-lhcb/cli.cjs
scripts/bench/ccv2-lhcb/collect.cjs
scripts/bench/ccv2-lhcb/doctor.cjs
scripts/bench/ccv2-lhcb/init.cjs
scripts/bench/ccv2-lhcb/metrics.cjs
scripts/bench/ccv2-lhcb/report.cjs
scripts/bench/ccv2-lhcb/restore.cjs
scripts/bench/ccv2-lhcb/score.cjs
scripts/bench/ccv2-lhcb/session.cjs
scripts/bench/ccv2-lhcb/snapshot.cjs
scripts/bench/ccv2-lhcb/state.cjs
tests/Ccv2Lhcb.Tests.cjs
```

## Architecture

The harness is an external CommonJS observer/orchestrator. Production code never
imports it. `state.cjs` owns root safety, contract seals, frozen-source checks and
state layout. Initialization stages frozen Git source and locally installed
pinned dependencies without credentials or user data. Existing installer
composition authorities generate the isolated presets; their outputs are also
fingerprinted. No new package or framework is required.

Snapshots seal the workspace/Git, durable sessions, controller/task bindings,
CCv2 state and mapped mutable data. Restore verifies every hash and mode, preserves
installed runtime and credentials, and locks the root after incomplete restoration.
Each arm requires a fresh restore and sets routing policy through existing config
semantics. Every trial has a unique evidence directory.

Session decoding uses the existing `Ccv2SessionLog` and pinned DSH codec. Activation
uses existing replay exports and `ContextActivationPressureV2`; DSH replacements
use its canonical surface fold. Derived thresholds are window 1,048,576, DSH
838,860 and native-unsendable activation 907,018. Production accounting is input
plus cache read plus cache write; reasoning is an output subdivision.

The moderate TypeScript Ledger Lab fixture has domain, persistence, migration,
service, CLI, audit and tests. Creation records deterministic files, Git tree and
commit using the existing user identity. The hidden grader stays outside the
workspace and checks O01–O20; O01–O10 are critical. A reference implementation
passes all 20; the untouched fixture fails task success as expected while its
public suite passes.

Collection verifies prompt delivery, durable identity, frozen source, certification,
policy and observable arm behavior. Infrastructure failures remain visible as
`INFRA_INVALID`; forced without compilation is `INVALID`. Unavailable measurements
have null values and reasons. Reports retain invalid runs and refuse ambiguous or
invalid comparators. Capability, production benefit and continuity safety have
separate verdicts. Contract gates are frozen at full critical retention, at least
19/20 obligations, task success, passing tests and zero protocol violations;
meaningful benefit requires at least 30% input reduction and at most 25% step
increase, with a separate 50% headline threshold.

## CLI examples

Run from the Nexus checkout with pinned Node 24.18.1. The default isolated root is
already initialized; `init` intentionally refuses an existing nonempty root.
Use `CCV2_LHCB_ROOT=/absolute/safe/path` for a separate new dry-run environment.

```sh
node scripts/bench/ccv2-lhcb/cli.cjs doctor
node scripts/bench/ccv2-lhcb/cli.cjs status
node scripts/bench/ccv2-lhcb/cli.cjs report
# For a new isolated root only:
node scripts/bench/ccv2-lhcb/cli.cjs init
```

Future live operator procedure, after certification and contract review:

```sh
node scripts/bench/ccv2-lhcb/cli.cjs prompt T00
node scripts/bench/ccv2-lhcb/cli.cjs bind nexus-root/data/sessions/WORKSPACE_KEY/SESSION_ID/session.jsonl.zstd
node scripts/bench/ccv2-lhcb/cli.cjs prompt next
node scripts/bench/ccv2-lhcb/cli.cjs snapshot CP-500 --stopped
node scripts/bench/ccv2-lhcb/cli.cjs restore CP-500 --stopped
node scripts/bench/ccv2-lhcb/cli.cjs arm native --stopped
node scripts/bench/ccv2-lhcb/cli.cjs prompt T99
node scripts/bench/ccv2-lhcb/cli.cjs collect RUN_ID --stopped
node scripts/bench/ccv2-lhcb/cli.cjs grade RUN_ID
node scripts/bench/ccv2-lhcb/cli.cjs report
```

Restore the same checkpoint again before `arm production` and `arm forced`.
Prompt delivery/start/stop are operator-assisted; see RUNBOOK.md for the complete
sequence and checkpoint admission requirements.

## Executed validation

| Command / check | Exact result |
|---|---|
| `/home/kaloyan/.local/share/nexus/runtime/node/bin/node --test tests/Ccv2Lhcb.Tests.cjs` | 32 passed, 0 failed, 0 skipped; 157602.023456 ms |
| `node --require ./benchmarks/ccv2-lhcb-01/grader/offline.cjs tests/ContextActivationPressureV2.Tests.cjs` | 74 passed, 0 failed |
| `node --require ./benchmarks/ccv2-lhcb-01/grader/offline.cjs tests/ContextAuthorityCertificationV2.Tests.cjs` | 35 passed, 0 failed |
| Initial `node tests/ContextActivationPressureV2.Tests.cjs` | 74 passed, 0 failed |
| Initial `node tests/ContextCompilerActiveOpencodeHostV2.Tests.cjs` | 221 passed, 0 failed; localhost fake provider |
| Syntax checks of all 17 added CJS modules | PASS |
| `git diff --check` | exit 0 |
| Default `doctor` | exit 0; initialized true, runtime ready true, source guard PASS |
| Staged DSH agent vs frozen vendored tarball | 22 files checked, 0 differing paths |

The 32-test suite exercises temporary roots, deterministic fixture/grader, real
packed DSH decoding, activation replay, full fake three-arm restore/collect/grade/
report, corrupt logs/snapshots, credential exclusions, actual source and generated
preset drift, correctness/benefit gates, schemas and unchanged normal Nexus state.
It installs a network blocker before benchmark modules load. The audit records
**0 network attempts**; subprocesses are limited to local Git and Node with the
same blocker. No live provider calls occurred anywhere in this implementation.

The initial pre-existing host suite did use localhost HTTP fakes. Therefore the
zero-network claim applies to the benchmark suite and the strict offline checks,
not to every historical baseline command. Strict blocked-network attempts at the
existing host and wire suites stopped at server listen (exit 98); those suites'
network conformance is UNVERIFIED under the strict no-network policy. The host's
ordinary local-fake baseline passed as recorded above. No external provider was
contacted to resolve this limitation.

Receipts are in the isolated root's `state/verification.json` and
`state/verification/`. They contain aggregate results and safe logs only.

## Frozen production proof

Branch: `benchmark/ccv2-lhcb-01`. HEAD:
`081c54070ee0ae62a8ae303bbcde9f930174cbed` (the requested freeze).

```sh
git rev-parse HEAD
git diff --exit-code 081c54070ee0ae62a8ae303bbcde9f930174cbed -- config scripts/lib scripts/CCv2-ActivationReplay.cjs runtime ui bin
```

The diff command exited 0 with no output. `git diff --name-only` is empty;
all repository work consists of the additions listed above. Doctor's explicit
241-path protected-source guard reported `pass: true`, `differingPaths: []`.
It also checks installed source and fingerprints effective generated runtime
composition. The guard respects Git attributes when hashing source files.
No replay refactoring or production hook was necessary.

## Limitations and operator work

- Live readiness is **UNVERIFIED**: doctor reports missing certification,
  `QUARANTINED`, `liveReady: false`. Before live work, supply credentials only
  through existing isolated Nexus mechanisms and run the existing full OC01
  canary from the isolated installation. This future canary makes provider calls;
  it was not executed during setup. Obtain current identity-matching HEALTHY
  certification and rerun doctor.
- Review CONTRACT.md and prompts before the first live trial. Start the isolated
  launcher in the fixture workspace, verify installation/data environment paths,
  deliver exact prompts in one durable session, and stop/flush at each boundary.
  The `--stopped` flag is an operator assertion, not proof of process termination.
- Pressure bands require genuine read-only investigations. Natural DSH compaction
  may prevent CP-OVERFLOW; production NOT_TRIGGERED is valid. No thresholds were
  lowered. No live outcome or real session transport is claimed verified.
- Native zero-compiler evidence combines frozen off-policy behavior, exclusive
  session scope and absence of compiler events because the frozen native host
  does not emit compiler telemetry. Missing telemetry cannot be invented.
- First useful edit and exact file reads embedded in `run_code` remain unavailable
  when not structurally observable. Ambiguous native comparators need operator
  trial selection before any valid reduction can be stated.
- Staging is exercised on Linux. Snapshots are tied to their original absolute
  root and cannot be transplanted. Unexpected mutable layouts fail closed.
- Secret detection is conservative, not universal. Only dedicated credential-free
  fixture sessions belong in snapshots. Workspace separation and the Node grader
  blocker provide cooperative benchmark isolation, not hostile-code containment.

No remaining operator action is needed for the offline infrastructure review.
Certification, real history generation and live trials are explicitly future work.
