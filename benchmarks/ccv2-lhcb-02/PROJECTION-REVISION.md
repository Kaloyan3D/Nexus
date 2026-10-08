# Request projection revision and execution plan

This revision has not executed a qualification or official run. Previous
qualification and arm results remain evidence for their original executed HEAD.

## Scientific questions

Production policy benefit, Forced projection capability, correctness effect and
provider reliability are four separate results. An inactive Production input
difference is observational variation, never CCv2 savings. A compiled request
does not require durable compaction or surface replacement. All original
correctness and critical obligations, ratios, provider/model, production policy,
retry policy, scratch rules and calibration E01–E06 remain intact.

The user explicitly accepted a valid `NOT_TRIGGERED_BY_PRODUCTION_POLICY` production result when
unchanged DSH pressure relief precedes the CCv2 threshold. This supersedes the
earlier requirement that a final workload must necessarily activate Production.
It does not permit attributing savings to a policy that never compiled.

## Tokenizer classification before live execution

The three archived Forced attempts have 154 tokenizer-unavailable decisions:
128 enumeration, 21 reserve, five payload. Their counter failures are 131
deadline, 21 gate-open, one rate-limit (HTTP 429, deadline exhaustion) and one
transient transport failure (retry-budget exhaustion). All classify as
`TRANSIENT_TOKENIZER_AVAILABILITY`, including intentional bounded availability
fallbacks; this classification does not assert an endpoint outage.

The authority is Meta's `api.meta.ai/v1/responses/input_tokens` for
`muse-spark-1.3-contributor`. OpenCode inference is separately routed. There is
no local tokenizer installation to repair. All 131 deadline cases had already
successfully counted the reserve payload (`counterSource: live`). 49 compiled
decisions also demonstrate supported mapping and successful initialization.
The whole foreground counting operation has an unchanged 8,000 ms deadline;
text work has 5,000 ms before the 3,000 ms payload reserve. Cold enumeration
and changing context can exceed that budget despite a working endpoint.
The process-wide exact-count cache is credential/transport/contract scoped;
fresh arm processes start cold. Prewarm counts only text, skips a cooling gate,
never retries, and cannot replace live reserve/final payload counts. Preserved
prewarm evidence includes rate-limit/deadline/transient failures and gate skips.
No unsupported/auth/malformed counter verdict was observed in these 154 rows.
No production defect is demonstrated; deadlines, retries and fallback remain.

## Checkpoint design before measuring the new workload

Use the already declared CP-750 band **720,000–790,000**. This is below both
DSH's 838,860 pressure point and CCv2's 907,018 activation point. The window is
70,000 wide, larger than the largest archived post-CP engineering phase growth
(45,238 at E46). The completed Native arm's E37–E46 growth ranged from 10,014
to 45,238 and averaged 20,968.3; E46 ended at 690,367. Those are historical
observations, not predicted counts for the new execution. The band leaves
117,018–187,018 tokens to CCv2 activation and 48,860–118,860 to DSH relief.

The finite workload will add substantive dependent engineering phases and
require at least four engineering phases remaining after the checkpoint.
The planned finite extension is E47–E54: canonical balance proof, settlement dry
run, reversal dispute proof, multi-account statement cut, scheduled funding
preview, recovery export, closing evidence and aggregate release readiness.
These are read-only consumers of earlier ledger, replay, migration, grant,
statement and scheduling contracts. Their reference implementations must call
the earlier candidate interfaces; independent host oracles own expected values.
Each phase has its own business failure cases and a hidden canonical-store
caller. They introduce no alternative writer or synthetic pressure input.
No checkpoint may use T99, synthetic pressure, exact token targeting or a
post-qualification adjustment. A skipped/exhausted band is inadequate workload,
not permission to append phases. Production activation is observed if it occurs;
DSH may correctly prevent it. DSH's pre-step pressure handling precedes request
construction and the CCv2 llm/stream seam. A deterministic local test executes
the actual DSH pressure method and demonstrates relief at 850,000, below the
CCv2 point. This is policy ordering evidence, not a live activation experiment.

## Architecture decisions (ten questions)

1. Source of truth: frozen production code owns projection and session events;
   the host owns immutable workload/oracles, archive seals and derived metrics.
2. Ownership: only OfficialRunner captures a completed arm; archives never write
   back to the live candidate, settings, session or checkpoint payload.
3. Dependencies: official orchestration depends on archive/metric modules;
   production modules do not depend on benchmark code on disk. The preload
   adds capture-only observation in memory, preserving production source bytes.
4. Boundaries: archive copies contain candidate and session evidence. Telemetry
   stores only sizes, identities and decisions, never prompt/source text.
   Grader caller/output diagnostics are separate host evidence and never gates.
5. Failure semantics: unavailable tokenizer counts fall back unchanged. Archive
   failure prevents a subsequent destructive restore. Missing projection sizes
   remain unavailable; no estimated token reduction becomes measured savings.
6. Lifecycle: close runtime, finish grading, copy/hash/verify/seal/protect archive,
   publish receipt, then permit restore. Interrupted pending archives are evidence
   only and cannot authorize restore. Existing failed-attempt policy is unchanged.
7. Test seams: injected counting transports, synthetic durable unit sessions,
   actual snapshot restore, sandbox evaluator and isolated candidate mounts.
   No live provider calls are needed for these deterministic checks.
8. Compatibility: old execution artifacts remain immutable. Legacy metric names
   stay as compatibility aliases; new source/workload/protocol hashes are honest.
   Qualification must execute the final new revision, never reuse old PASS.
9. Observability: separate compiler attempts, compiled requests, fallback stages,
   counter failures, request byte reduction, provider tokens, durable events,
   persistent replacements, threshold crossing and latch traces. Measurement
   overhead is reported separately and is not full observer overhead.
10. Security: completed archives live under host reports, excluded from snapshot
    selection and from bwrap mounts. They are read-only and independently sealed.
    Sensitive filenames/content and links are rejected by existing inventory
    guards; observer redaction remains. No credential file is archived.

## Metric contract

`compilerAttempts` sums the binary compiler-pipeline execution marker, including
post-planning failures. `compiledRequests` counts final CCV2_COMPILED decisions.
Success rate is compiledRequests/compilerAttempts, unavailable when no pipeline
attempt occurred; pre-pipeline fallbacks are separately visible. Projection
reduction measures exact UTF8 JSON bytes of the request's system/messages/tools
before and after successful projection; these are not wire bytes or tokenizer
tokens. Provider input is separately measured from accepted provider usage,
including cache reads/writes. `durableCompactions` counts real compaction/*
events, not inferred successes; `surfaceReplacements` counts persistent surface
mutation events. Neither is a projection-success requirement. Effective arm input
reduction uses cumulative accepted provider input, subject to unchanged quality,
step and benefit thresholds and an actually compiled arm.

## Remaining gates

Complete finite workload/checkpoint implementation, all deterministic gates,
review and honest freeze; then exactly one new qualification. Only a PASS
permits the common natural prefix and Native/Production/Forced execution. Do
not change this design in response to qualification pressure measurements.

## Scope of the qualification-only task

ArchiveCompletedArm and its fail-closed pre-restore guard are unchanged from the
validated implementation. Physical restore retains the same verify-before-delete,
copy, exact inventory/session equality and lock behavior. Only checkpoint ID/band
selection is parameterized: legacy CP-500 defaults remain testable; the official
runner explicitly selects CP-750. No completed archive enters candidate mounts.

The finite workload is E01–E54 plus T00/T99. E01–E46 release artifacts and all
existing prompt bytes, including T99, remain identical. Eight noncritical
obligations extend total coverage to62; all19 original critical obligations and
their probes/gates remain intact. Existing exact-count tests are updated solely
for this authorized finite extension; original phase and critical coverage are
checked separately. This revision changes execution/source identity and workload
semantics (eight phases plus CP-750 selection), and therefore receives new source,
workload and official protocol hashes. scratch-v1 remains its unchanged scratch
protocol label, not an assertion that the whole official protocol hash is old.

Run all applicable deterministic Node gates, then commit/freeze source and run
exactly one fresh E01–E06 qualification. This task ends after qualification and
does not invoke official-runner, even if qualification passes. No edits or live
retuning based on qualification output are allowed.
