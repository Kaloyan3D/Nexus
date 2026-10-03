# AutoRunner architecture and operator interface

The runner is external benchmark tooling. Production, the v1 manifest, prompts,
obligations, fixture, grading, scoring and checkpoint definitions remain frozen.
Implementation verification uses fake transports only, with no provider calls.

## Boundary review and implementation plan

1. Truth: frozen prompt bytes/digests and contract seal own prompt identity;
   durable DSH events and controller bindings own session/task identity; existing
   pressure, snapshot, grade and report authorities own their respective outcomes.
   The runner journal records intentions and receipts, not a competing transcript.
2. Ownership: runner writes only its marked isolated root and journal. DSH alone
   writes session/memory data. Stop the runtime before snapshot, restore or policy
   changes; the existing functions retain their independent validation.
3. Dependencies: CLI -> runner -> injected transport and existing benchmark
   authorities. The transport uses the installed DSH host API, which delegates
   prompt submission to agent.followup and reports agent/status through running.
   Production never imports runner code.
4. Contract: transport start/resume/submit/status/flush/stop; fixed identity and
   aggregate pressure/usage evidence. No credentials, raw model responses or
   generated prompt content cross into the journal or reports.
5. Failures: malformed status, drift, ambiguous submission, missing flush evidence
   and timeouts fail closed with content-safe error codes. No automatic provider
   request retries, replacement sessions or workspace cleanup.
6. Lifecycle: persistent intent before submission, idle and durable completion
   receipts, immutable snapshot, fresh restoration per arm, collect, grade and
   report. A root-bound process lock prevents concurrent runners; dead locks may
   be reclaimed only with matching process identity evidence.
7. Seams: fake transport, clock/poll scheduler, preflight and operation adapters;
   real session decoder and pressure gate exercised with fixture events. Tests
   never require real provider credentials or a live DSH endpoint.
8. Compatibility: existing state/stages/binding and snapshots remain authorities;
   adopt proven manual stages, preserving their order. New journal can be removed
   only when no submission is pending. No contract migration is necessary.
9. Observability: run-status returns journal state, stage/arm receipts and measured
   pressure without launching or querying model/provider discovery endpoints.
10. Security: root guard, source/certification checks, isolated runtime process
    identity, exact bank digests, env-only keys, stripped child environment and
    exclusive-session validation. No normal-runtime state or secrets copied.

Plan: add frozen runner prompt authority; runner state machine/guards; installed
DSH API transport with runtime ownership; CLI integration; focused offline tests
and simulated three-arm sequence; execute existing LHCB suite and diff checks.

## Operator commands

These are future **live** commands. Implementation verification does not execute
any of them against the existing benchmark session. Use the pinned Node runtime
and supply `OPENCODE_API_KEY` and `MODEL_API_KEY` through the operator environment;
do not put values on command lines, in the journal, or in documentation.
`CCV2_LHCB_ROOT` optionally selects an absolute, marked isolated root.

```sh
# Resume the existing bound T00/P01 session and perform one exact next audit:
node scripts/bench/ccv2-lhcb/cli.cjs run-stage P02
node scripts/bench/ccv2-lhcb/cli.cjs run-stage P03

# Continue only up to the next reached, uncaptured checkpoint:
node scripts/bench/ccv2-lhcb/cli.cjs run-until CP-500 --max-stages 28
node scripts/bench/ccv2-lhcb/cli.cjs run-arms CP-500
node scripts/bench/ccv2-lhcb/cli.cjs run-until CP-750 --max-stages 28
node scripts/bench/ccv2-lhcb/cli.cjs run-arms CP-750
node scripts/bench/ccv2-lhcb/cli.cjs run-until CP-PRE-DSH --max-stages 28
node scripts/bench/ccv2-lhcb/cli.cjs run-arms CP-PRE-DSH
node scripts/bench/ccv2-lhcb/cli.cjs run-until CP-OVERFLOW --max-stages 28
# Only if CP-OVERFLOW was actually captured:
node scripts/bench/ccv2-lhcb/cli.cjs run-arms CP-OVERFLOW

# Or resume the complete orchestration (bounded budget per checkpoint):
node scripts/bench/ccv2-lhcb/cli.cjs run-all --max-stages 28
# This command is read only, needs no keys, and makes no agent/provider request:
node scripts/bench/ccv2-lhcb/cli.cjs run-status

# A fresh, unbound root only; reserves one persistent creation ID:
node scripts/bench/ccv2-lhcb/cli.cjs run-stage T00 --new-session
# Explicit repeated audits are allowed only after all seven initial audits:
node scripts/bench/ccv2-lhcb/cli.cjs run-stage P02 --repeat --stage-id stage-repeat-1
```

Unknown flags, repeated flags, missing arguments, invalid budgets and
`--trust-canary` are rejected. T99 is submitted only inside `run-arms`/`run-all`.
Repeating a plain `run-stage P02` command returns its verified existing receipt;
use `--repeat` only to request another legitimate audit. Give that operation a
stable `--stage-id stage-...` to make even a completed explicit repetition
idempotent across retries; choose a new ID for the next repetition. Without a
stage ID, a repeated `--repeat` command after successful completion explicitly
requests new work. An interrupted unresolved repetition is resumed either way. `run-until` selects
missing initial stages in order, then cycles the frozen P01–P07 bank.

A single `run-stage` captures a reached checkpoint after durable completion.
Further audit submissions are blocked while a reached checkpoint is uncaptured
or an arm is incomplete. `run-until CP-750` can first return CP-500: it stops at
the first uncaptured band, rather than sending through it. Finish its arms and
invoke `run-until` again. No audit is permitted under a trial arm policy. Completed arm groups retain a
durable baseline-restoration receipt; revisiting them verifies results without
restoring an older checkpoint or discarding subsequent accumulation.

## Durable states and recovery

The atomic, content-free journal is `<root>/state/autorunner.json`.

| Boundary | Durable evidence / next action |
| --- | --- |
| READY | Exact prompt hash, immutable identity, sequence prefix hash, workspace/Git evidence, before telemetry and reserved RPC ID. Reconcile the existing prompt-issuance receipt before sending. |
| SUBMITTED | Persisted **before** the prompt RPC; includes submit timestamp. Irreversible intent: restart never retransmits it. |
| AGENT_IDLE | Supported DSH status reports idle; wait for session export HEAD flush, completed containing turn and canonical memory producer/staged fences. |
| FLUSHED | Matching RPC provenance, exact prompt, stable identity, durable event hash, end sequence, outcome, completion timestamp, pressure/usage after and read-only workspace verification. |
| CHECKPOINTING → CHECKPOINTED | Idle/flush verified; runtime stopped; existing snapshot created or reconciled; integrity, namespace, exact pressure and immutable seal verified. |
| RESTORING → RUNNING | Persist unique arm run ID; stop runtime; existing restore; exact baseline/seal check; existing arm configuration; T99 stage intent persisted separately. |
| COLLECTED → GRADED | Stop runtime; existing collector and objective grader; persist results and grade hashes, then regenerate existing report before the next arm. |
| COMPLETE | Requested boundary or bounded orchestration completed; final trial restoration returns accumulation to its clean checkpoint baseline. |
| FAILED | Safe deterministic error plus preserved child stage/arm state. Restart reconciles evidence; the label never authorizes a retry of a prompt RPC. |

The automatic audit cursor advances in the same atomic journal write as its
FLUSHED receipt, so a crash cannot replay a completed cycle slot.

A crash after sending P02 or T99 but before a completion receipt is resolved
from the actual stored session, same task instance, exact user message RPC ID,
containing turn/end and memory flush fences. Completed event prefixes, arm manifests and graded
artifacts are hashed and rechecked. Unknown child phases fail closed. A submission with no durable evidence times
out and remains unresolved; deleting the journal or issuing a replacement is not
an automatic recovery procedure. An uncertain session-create intent likewise
requires the exact existing durable artifact; it cannot create a replacement.

Manual stages are adopted only with matching frozen prompt hashes and actual
completed durable turns. Their original submission/completion timestamps and
before/after telemetry were not recorded by manual issuance, so availability
reasons explicitly preserve that limitation. New runner stages record both
boundaries. No current timestamps or pressure numbers are invented for history.

A root-bound exclusive lock records PID and Linux process start token. A live
lock cannot be stolen; a dead owner can be reclaimed. Runtime process metadata
records only root, contract, PID/start token and environment-only credential
mode. A pending busy agent is left available for subsequent reconciliation;
cleanup failures are recorded with safe codes.

## Installed DSH interface and live limits

The transport uses the installed `@deepseek-ai/dsh-host-apiproxy` client and its
actual envelope/schema validation. Only `session.create`, `session.prompt` and
`session.list` RPCs plus HEAD `session.export` are used. Text is the exact bank
file, submitted as one text block. `session.create` selects the existing resume
path for a proven stored ID; a fresh ID is explicitly reserved only on request.
There is no model/provider discovery or credential-store RPC.

The Linux adapter owns an isolated pinned Node/DSH process on loopback port 3080.
It proves executable, entry point, PID/start token and listener ownership before
using or stopping it. A manually launched isolated runtime is stopped only after
those proofs and idle/session flush, then replaced with the same frozen DSH entry
point under a stripped environment containing the two validated environment
keys. It invokes neither the launcher's OAuth broker startup nor a provider
canary. Production source and compositions are unchanged. A foreign listener or
busy runtime fails closed; the operator must resolve it. Windows/macOS are not
implemented by this process ownership adapter.

Live provider execution and the adapter's actual process/RPC lifecycle are
**unverified** in implementation testing. Offline protocol tests use the real
installed API client with an in-process fetch; agent execution uses injected fake
transport. Future live use still requires current HEALTHY, identity-matching
certification, exact source guards, ready runtime and frozen route/thresholds.
No implementation test manufactures certification for the user's live root.

Snapshot v1 still requires T00 and **all seven initial audits**. Hitting a band
earlier stops progression and fails closed; the runner does not weaken that
requirement. Bands can also be missed by pressure jumps; they are never fabricated
or widened. A bounded overflow attempt is `NOT_TRIGGERED` only with successful
observed DSH compaction; without that evidence it is `INSUFFICIENT_DATA`.
Compaction errors do not qualify. These outcomes are recorded by `run-status`;
the existing report retains its existing interpretation of absent checkpoints.

The offline P02→P03 simulation therefore seeds the initial eight completed
stages and performs an additional frozen audit cycle. Synthetic pressure values
are confined to the fake transport. It uses the actual snapshot, restore, arm,
collect, grade and report implementations. The unsolved fixture deliberately
fails correctness; three VALID infrastructure results do not claim benchmark
success or compiler benefit. Re-running arms sends zero additional T99 prompts. The simulation also appends
an audit after the trials and proves that resumed `run-arms` and `run-all` retain
that uncheckpointed history.

## Implementation verification — 2026-10-03

Scope: uncommitted AutoRunner work on `benchmark/ccv2-lhcb-01`, starting at
`7da9befe48e696917ef570966fb5f214dfc61e85`; production remains frozen at
`081c54070ee0ae62a8ae303bbcde9f930174cbed`. The commands used Node 24.18.1
from the existing pinned installation (prepend its `runtime/node/bin` to PATH).

| Gate | Result | Executed evidence |
| --- | --- | --- |
| Existing LHCB regression suite | PASS | `node --test tests/Ccv2Lhcb.Tests.cjs`: 35 passed, 0 failed, 0 skipped. Existing test file unchanged. |
| AutoRunner focused and integration suite | PASS | `node --test tests/Ccv2Lhcb.AutoRunner.Tests.cjs`: 48 passed, 0 failed, 0 skipped. |
| Offline simulated sequence | PASS | Existing session → additional P02/P03 → CP-500 → actual immutable snapshot/restore → native/production/forced T99 → actual collect/grade/report. Interrupted T99 recovered; repeated commands sent zero additional T99; subsequent audits survived completed-arm and run-all resume. |
| Provider/network isolation | PASS | Both suites' inherited network/subprocess blocker recorded 0 network attempts; injected transport only. Normal installation and existing benchmark binding/stages hashes unchanged. |
| Frozen production source guard | PASS | `doctor.sourceGuard()`: pass=true, frozen base SHA, differingPaths=[]. |
| Whitespace and syntax | PASS | `git diff --check`; `node --check` for runner, transport and CLI. |
| Live agent/provider execution and platform process lifecycle | UNVERIFIED | Deliberately not executed during implementation. Linux adapter only; future operator live commands require environment keys and valid certification. |

The simulated fixture remains unsolved: all three collected infrastructure runs
are VALID and all three correctness gates are false. This is evidence for runner
plumbing and grading honesty, not benchmark success. No production files,
frozen contract/prompt/fixture/grader files, live session data, normal credentials
or certification were changed. No live benchmark, canary, push or commit ran.
