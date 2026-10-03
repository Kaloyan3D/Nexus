# NexusBench — CCv2 Long-Horizon Continuity Benchmark v1

Benchmark ID: **CCV2-LHCB-01**. Contract version: **1**.
Frozen production authority: `081c54070ee0ae62a8ae303bbcde9f930174cbed`.
This contract is frozen before any live trial. Changing an obligation, fixture,
metric definition, comparison rule or acceptance threshold requires a new
contract version. The implementation task builds and validates infrastructure;
it does **not** execute the live Muse/OpenCode benchmark.

The question is whether physical model-facing context can be reduced while
retaining the engineering decisions, constraints and correctness needed to
continue a large session. Compiler capability, production benefit, and reasoning
continuity safety are independent conclusions. This is one bounded engineering
fixture and route; it does not establish general model quality or broad CCv2
production maturity.

## Experimental arms and source authority

| Arm | Policy | Meaning |
| --- | --- | --- |
| A native | `contextCompiler.mode=off` | Native requests; zero compiler execution |
| B production | `mode=active, activation=pressure` | Real frozen RC1.1 pressure policy |
| C forced | `mode=active, activation=always` | Isolate compiler capability |

Pressure-building history uses the explicit production/pressure policy, so ambient compiler-mode variables cannot force early compilation. Generated runtime compositions are fingerprinted, including the effective DSH preset. The contract seal also binds prompts, fixture, obligations, hidden grader and scoring engine. Ungraded runs and ambiguous native comparators produce insufficient data.

Only the isolated installation's `config/routing-policy.json` is changed.
No production source patches, benchmark hooks, DSH threshold changes or tuning.
The explicit protected path list in `manifest.json` covers config authorities,
controller integration, baseline scripts/launchers and pinned dependency
manifests/vendor artifacts. Doctor compares Git-normalized source bytes to the
frozen objects (respecting the checkout's CRLF attributes), and installed bytes
to frozen blobs. Installed routing-policy changes are checked separately by
per-run policy hashes. Benchmark additions are outside this protected surface.

## Fixture and retained constraints

Ledger Lab is a moderate TypeScript/Node project: domain validation, versioned
JSON repository, migration, service, CLI, audit and public regression tests.
Node's built-in type stripping executes it without package downloads. Its final
challenge implements batch import. Fixture revision, deterministic Git tree and
commit, and all public source hashes are recorded outside the workspace.

T00 communicates exactly **20** requirements; O01–O10 are critical. The frozen
requirements are in `obligations.json`, with executable checks in the external
hidden grader. They cover stable IDs, existing duplicate no-ops, conflict
atomicity, backup, atomic writes, version compatibility, dry run, injected
clock, post-commit audit, repository ownership, CLI compatibility, error codes,
whole-batch rollback, deterministic order, in-batch duplicates, empty no-ops,
pure migration, safe integer amounts, audit privacy, and regression correctness.
Each check emits only its stable O01..O20 ID, pass/fail and concise evidence.
The original regression suite must remain byte-identical and pass. T99 asks for
the implementation without repeating the requirements. No copy of T00, the
obligation inventory, hidden checks or reference solution is generated in the
agent workspace. The operator confines the agent to that workspace; this tool
is not an operating-system sandbox.

P01–P07 are read-only architecture, persistence, API, tests, failure, security
and regression audits. They encourage grounded inspection and concise analysis.
No padding, manufactured token targets, or source edits during pressure growth.
Additional audit cycles are allowed through the documented repeat option;
repeating tool calls simply to grow tokens is prohibited.

## Checkpoints and restoration

| Checkpoint | Admission band |
| --- | --- |
| CP-500 | 480,000–550,000 measured pressure tokens |
| CP-750 | 720,000–790,000 |
| CP-PRE-DSH | Within one 65,536-token reserve below derived DSH threshold |
| CP-OVERFLOW | At or above the derived CCv2 activation threshold, reached naturally |

Labels are bands. Actual measured pressure and thresholds are always recorded.
`ContextActivationPressureV2` derives the route window, DSH region and
continuity-aware activation basis. The frozen Muse route derives 1,048,576,
838,860 and 907,018 respectively. Pressure is a conservative production bound,
not an invented precise billed prompt count.

The dedicated root defaults to `~/nexus-bench/ccv2-lhcb-01`, overridable by
absolute `CCV2_LHCB_ROOT`. Snapshot payloads contain workspace/Git/ledger/CCv2
memory, isolated DSH sessions/bindings and other explicitly mapped mutable
Nexus data, plus routing policy. Immutable installed dependencies, profiles,
credential stores and logs are excluded. Mutable top-level data files are
captured; unexpected mutable directories block capture. Settings identity is
hashed and must match before restore. Credential files are preserved outside
restore; never copied to snapshots or evidence.

Capture requires a stopped and flushed runtime. Every payload file has a
content hash and restored mode; metadata has a content seal. Snapshot files
are made read-only, existing names cannot be overwritten, and restore verifies
all hashes before destruction and after copying. A failed restore leaves a
lock which blocks further benchmark operations until a successful recovery.
Restoration occurs at the same absolute root, preserving workspace identity.
Each arm must restore the identical checkpoint; runs cannot silently reuse an
already-mutated baseline. Installed dependencies are not restored or archived.

## Metrics and evidence

Identity includes benchmark/version, frozen SHA, fixture revision, checkpoint,
arm, unique run, provider/model and task/task-instance/session IDs. Comparisons
also require identical snapshot seals and settings identities.

Correctness records task success, final tests, critical/total retained
obligations and tool/protocol violations. Execution records requests, steps,
tool calls, byte-exact repeated tool calls and durable event elapsed time.
First useful edit and repeated file reads are null unless structural evidence
can establish them; v1 does not interpret `run_code` semantically.

Usage is taken only from durable `assistant/message` TokenUsage:
**provider input = inputTokens + cacheReadTokens + cacheWriteTokens**.
Reasoning is an output subdivision and is never added to input or output again.
Missing/malformed usage makes aggregate accounting unavailable. Optional cache
fields follow production's zero-default semantics; absent reasoning accounting
is unavailable. Null values have explicit availability/reason entries.

CCv2 evidence comes from production content-free decision lines plus the
existing offline replay authority. Active arms require one decision per root
request. Replay evaluates the complete inherited session, then selects the run
suffix. Native off bypasses host telemetry by design: verification requires
frozen installed source, unchanged observed off policy, exclusive binding,
known model route and no CCv2 decision rows in the run interval. Observability
cannot prove a hostile runtime did not secretly perform unlogged work.

Rework Tax v1 exposes steps, tools, exact repeats, output and reasoning counts.
There is no LLM judge, fuzzy similarity, subjective score or weighted Nexus
score. Read-only pressure work before each restored continuation is excluded
from run-suffix accounting; all arms pay for exactly the same continuation.

## Frozen gates and verdicts

Correctness requires task success, final automated tests PASS, **100% critical**
obligations, **at least 95% total** (19/20), and **zero** protocol violations.
Meaningful compiler benefit requires **at least 30%** provider input reduction,
**at most 25%** step increase and the correctness gate for both comparator and
candidate. Headline compiler benefit requires **at least 50%** input reduction
while the full correctness gate holds; it is reported separately.

Only valid, matched native baselines with positive measured input and steps
can provide a percentage. Missing, invalid or mismatched comparators produce
null, never a manufactured percentage. All valid comparisons must meet the
meaningful gate for a PASS; a measured failure produces FAIL. No averaging
away a failed checkpoint, favorable run selection or denominator manipulation.

| Verdict | Outcomes |
| --- | --- |
| Compiler Capability | PASS / FAIL / INSUFFICIENT_DATA |
| Production Benefit on Muse/OpenCode | PASS / FAIL / NOT_TRIGGERED / INSUFFICIENT_DATA |
| Reasoning Continuity Safety | PASS / FAIL / INSUFFICIENT_DATA |

Forced capability runs require at least one `CCV2_COMPILED` request; otherwise
INVALID. Production with verified pressure decisions and zero compilation is
NOT_TRIGGERED, including natural DSH compaction before the CCv2 region.
Reasoning safety requires observed production policy agreement and the full
correctness gate. It is a bounded check for premature activation and retained
constraints, not a subjective evaluation of invisible reasoning.

## Invalidation and anti-gaming

Observable rate limit, overload, timeout, connection/authentication failure,
corrupt/missing log or telemetry, wrong route, source/settings/arm drift,
unhealthy certification, invalid restore or incomplete challenge produce
INFRA_INVALID. Such runs remain visible and are excluded from comparisons.
An otherwise readable policy contradiction is separately reported as a
benchmark violation. Retry events are counted; the harness never retries or
submits requests. Missing CCv2 evidence makes an arm INVALID.

No provider calls during implementation/tests. No production tuning, live
counter calls, credential copying/logging, obligation notes planted in the
workspace, padding, LLM scoring, grader access by the agent or selective
exclusion of valid unfavorable outcomes. Credentials use the existing managed
store or runtime environment only for future operator-authorized execution.
Secret scanning fails closed on recognizable credentials and decompresses
DSH state/checks Git objects; arbitrary unknown secret strings cannot be
recognized perfectly. Only a dedicated credential-free fixture session may be
snapshotted. Run outputs store content-free aggregates; raw transcript content
is confined to local safe-checked restore payloads, never copied to run reports.
