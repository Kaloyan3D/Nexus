# Restricted CCv2 production scope

Base: PR #29 at 390af181c79df08e4da1ee91a408238767d70d81, plus the two
independent lock-authority corrections and preserved red evidence in PR #31
at 7a79294638b4aba22fa7e3130be7aca90a013360. Neither PR is merged by this task.

## Plan and architecture review (before production edits)

1. Source of truth: DSH remains the live session and ordinary compaction owner.
   CCv2 compilation reads validated checkpoints/pages and source snapshots.
   Existing durable CCv2 artifacts remain unchanged; no recovery adopts them.
2. Ownership: production CCv2 may compile/project requests, not append/flush
   sessions, allocate/finalize generations, repair heads or run the memory writer.
3. Dependencies: request compiler/hosts use pure build/validation and artifact
   readers. They have no A10/A11/A13 mutation dependency. M01's shared live-session
   registry must survive as a read-only event observer even when writing is barred.
4. Boundary: a fixed, immutable production guard rejects unsafe entry points with
   `ccv2-durable-mutation-disabled`. No environment variable, input option, owner
   token, serialization client or persisted artifact can enable the retired paths.
5. Failure: refuse before callbacks, lock acquisition and IO. Missing/invalid/stale
   projection material uses the existing original-request fallback. Persisted intent
   cannot cause recovery, flush, generation repair or successful finalization.
6. Lifecycle: startup installs a read-only session registry; restarts can read stored
   evidence but cannot replay the producer or repair A11 state. Operator artifacts
   are neither deleted nor migrated. DSH lifecycle and compaction remain unchanged.
7. Tests: production restriction tests run without fixture policy replacement.
   Legacy active-algorithm suites run in an explicitly marked tests-only laboratory;
   their assertions remain unchanged, including the still-red fencing campaign.
   That laboratory is not an installed config dependency or production env switch.
8. Compatibility: in-memory checkpoint building, immutable content-addressed page
   store and readers remain. Generation-scoped checkpoint/operation persistence is
   disabled because check-then-rename permits overwrite and does not establish
   ownership. Existing v1/DSH behavior and compiler algorithms/thresholds/routes stay.
   Rollback removes the restriction and reopens the reproduced safety defect.
9. Observability: explicit disabled code and read-only installation status distinguish
   restricted support from active durable support. Gate reports distinguish production
   restriction proofs from laboratory algorithm checks and known fencing failures.
10. Security: no prompt/provider-secret logging or new external IO. Tests use synthetic
    fixtures. Guarding shipped APIs is not a sandbox against arbitrary privileged
    JavaScript that directly alters require caches or writes filesystem/session state.

## Reachability audit

- Controller `AihController.apply` unconditionally installs M01, shadow projection,
  active projection and OpenCode projection. M01 defaults on independently of A13.
  It ingests events, flushes at turn boundaries/replay, writes ledger/state/staging,
  deletes obsolete staged pages and persists per-generation checkpoints.
- C07/C08/OpenCode hosts read sealed checkpoints, staged pages/coverage, native tail,
  exact session/page/blob backing and capability/counter/authority proofs; they derive
  a request rather than call A10/A11. `sessionSourceFor` and `liveSessionFor` currently
  come from M01's registry, so disabling the entire registry would remove read seams.
- `NEXUS_CCV2_COMPILER_MODE`, shadow mode and routing policy select projection only.
  `NEXUS_CCV2_PRODUCER` controls the automatic writer independently.
- A13 `NEXUS_CONTEXT_COMPACTION_V2` defaults
  v1, but explicit `compactionVersion:v2` and environment selection reach active work.
  Explicit A10/A02 and A11 APIs bypass A13 entirely. A13 resume/recovery has no v1
  selection barrier; resume reconstructs with repair and can retry A02 segments.
- A11 reconstruct defaults `repairHead:true`; read-only inspect forces false.
  Reserve, apply-current, supersede and commit all write; a reentrant lease snapshot
  does not fence their JavaScript writes or A10 mutation.
- A02 apply/retry use branded intent but no current ownership; persist/freeze/attempt
  persistence can write/overwrite artifacts. A03/A04 per-generation persistence is
  similarly not a writer fence. Pure build/seal/validate/read remain independent.
- PowerShell exposes `New-AihContextCompactionOperationV2` directly when dot-sourced.
  It is an additional durable writer even though the normal CLI freeze action is v1.
- B02 content-addressed blobs/pages/advisories/evidence use atomic claim/no-overwrite
  and read-back identity. These standalone immutable stores do not move a session or
  generation head. Automatic staging/producer state is a separate mutable writer.

## PR #31 review

The two changes are independently appropriate: failed mutex acquisition refuses the
critical section, and release re-reads owner and unlinks under the same mutex as
acquire/takeover. They protect lock-file operations, not Node session writes. The
original defect and production active durable support remain blocked. The scoped
restriction must not be described as a fencing repair or a DSH rewrite.


## Implemented boundary and retained capabilities

| Capability | Restricted production |
| --- | --- |
| Pure compiler, renderer, retriever, budget/retention logic | Retained unchanged |
| Request-time C07/C08/OpenCode projection | Retained; only validated existing material; unchanged native fallback |
| Pure in-memory task-state/checkpoint build, seal, validation and readers | Retained |
| Immutable content-addressed page/blob/evidence stores | Retained; no session/head advancement |
| Existing DSH compactor and Nexus v1 compaction | Retained unchanged |
| M01 ingestion/replay, structured memory ledger/state/staging, automatic checkpoint production | Disabled; shared live-session reader retained |
| A03/A04 durable generation checkpoint persistence | Disabled |
| A02 operation/attempt persistence, freeze, append, retry | Disabled in JS and direct PowerShell V2 writer |
| A10 active durable application | Disabled before callbacks, serialization or IO |
| A11 reserve/apply/supersede/commit and default/explicit head repair | Disabled; explicit `repairHead:false` inspection retained |
| A12/A13 mutating recovery/resume/finalization and explicit/environment v2 boundary | Disabled regardless of persisted intent or legacy flags |
| Pure reconciliation/classification of historical evidence and completion-health inspection | Retained; cannot authorize a guarded writer |

`ContextDurableMutationPolicyV2.cjs` is a fixed frozen source policy, not a
configurable flag. Refusal is `ccv2-durable-mutation-disabled`. The PowerShell V2
writer has the equivalent fixed first-entry refusal. All guarded exported writers
refuse before normalizing inputs or performing callbacks/IO. Reconstruct requires
explicit `repairHead:false`; inspect supplies it. The captured local repair decision is checked again before artifact reads; an
accessor that changes from false to repair cannot bypass refusal. Its new regression
first failed (49 PASS / 1 FAIL) and now passes. Active attempts cannot return
`committed` or `recovered` because they throw before executing work. Read-only
inspection may describe a previously committed artifact; it does not commit it.

Projection has no A10/A11 dependency. The shared M01 registry now observes bound
session objects only, keeping B03 exact-source and RC1.1 pressure readers without
opening a producer, replaying, staging, flushing or sealing. Auxiliary DSH
`purpose:compaction` calls pass through. With no new automatic staging, fresh tasks
usually use native/DSH execution; existing material can project only while all the
unchanged authority, coverage, source, tail and counter checks remain satisfied.
This is deliberately reduced functionality, not full active durable CCv2 support.

The seven existing mutation-authority modules differ from PR #31 only by guard
imports/calls, as mechanically verified in `unchanged-algorithm-proof.json`.
Compiler logic, activation thresholds, provider/model routing and retry policy
have no diff. No DSH source is edited. Frozen LHCB source/evidence is untouched.

## Executed gates (Linux, Node 24.18.1, PowerShell 7.5.3)

Evidence is archived in
[evidence/ccv2-restricted-production-scope](evidence/ccv2-restricted-production-scope).
The manifest also hashes all raw logs in the external task archive. The production
source manifest records actual file hashes, not an old benchmark qualification.

| Gate / command | Result |
| --- | --- |
| `node tests/ContextRestrictedProductionV2.Tests.cjs` | PASS 50/50; original pre-guard test version was 5 PASS / 28 FAIL on unchanged PR #31 |
| `node tests/ContextRestrictedProjectionV2.Tests.cjs` | PASS 13/13 on actual shipped policy, including request immutability, route/signal preservation, zero artifact writes, restart, stale/missing fallback and DSH auxiliary bypass |
| `node tests/ContextRestrictedDshCompaction.Tests.cjs` | PASS 7/7; real pinned BasicCompactionEngine and SessionStore, deterministic meter/summarizer, replacement/flush/restore, no inference |
| `node tests/ContextRestrictedInstallV2.Tests.cjs` | PASS 11/11; four installed dependency closures, real installed controller compositions, policy refusal, real three-suite harness dispatch/report subset; Linux fixture only |
| 24 retained production suites in `production-final-results.json` | PASS before final repair-selector guard, 1644 `PASS:` assertions; compiler, renderer, activation, immutable store, rehydration, real-session contracts and DSH/v1 regression suites |
| V1 F2 provenance/production matrix | PASS 69/69 complete; first runner deadline stopped it at 100 seconds with 18 PASS/no assertion FAIL, and is preserved separately |
| `ContextApplyLockAuthority.Tests.cjs` | PASS 4/4, included in production suite total; both independent PR #31 authority fixes remain effective |
| `TestHarness.Reporting.Tests.ps1` | PASS 9/9 |
| 27 legacy suites through `node tests/Ccv2ResearchRunner.cjs <suite>` | 26 PASS / 1 FAIL; 2531 PASS / 1 FAIL assertions; **research only** |
| `ContextCompactionV2.Tests.ps1` through the research runner | PASS 30/30, research only |
| Unfinished `ContextLeaseFencing.Tests.cjs` through research runner | **FAIL**, unchanged assertions: 29 PASS / 12 FAIL, five SIGSTOP boundaries |
| Original `diagnostics/ShortLeaseOwnership.cjs` through research runner | **FAIL**, stale owner still appends and reports `committed`/`mutated:true`; preserved unchanged |
| Complete repository harness on final revision | UNVERIFIED; only affected suites and explicit harness-dispatch subset executed |
| Native Windows install/upgrade/startup and Windows PowerShell 5.1 | UNVERIFIED; no Windows runner |
| Live inference / LHCB | NOT RUN, explicitly excluded |

The four production restriction/projection/DSH/install gates were rerun on committed
source `8489538c9c37b8b5f3402030dbbd9be70cfa7aa0` after the repair-selector correction
(50/13/7/11 PASS); the A11 laboratory unit suite also remained 155/155 PASS.
The broader 24-suite run preceded that final guard-only change.

The additional legacy A12 cross-process failure is apply-versus-supersede: an
applier reports committed while the supposedly late superseder reports SUPERSEDED.
Its 19 PASS / 1 FAIL raw result is preserved; no assertion, delay, lease invariant
or production algorithm was changed to conceal it. Those APIs are disabled under
the tested production policy. Laboratory passes do not establish writer fencing.

The original four integration-baseline failures remain recorded in
[the integration report](../integration/ccv2-dev-report.md#known-baseline-failures-and-remaining-gates).
They were not edited or waived here. Baseline stabilization PR #30 is a separate
change; its reconciliation into PR #29/dev must remain independently reviewable.

Harness adaptation changes no assertion or failure exit: the new production
restriction/projection/DSH proofs run on shipped source; named legacy active suites
run in a private copied checkout with explicitly replaced **test data** policy.
Reports label those suites `research-only-active-algorithms` and declare
`DISABLED_UNSAFE_FENCING_UNRESOLVED`. Production has no enable switch and no import
of the research runner. Known red fencing tests remain separate, unchanged and
archived as FAIL. Source/installation closure checks also pass; an initial attempt
to invoke the installed-preset test on the source checkout failed for missing
installed manifests, and is preserved. The actual installed fixture subsequently
passed; a checkout is not represented as an installation.

## Verdict, review findings and rollout prerequisites

**GO for the restricted safety boundary demonstrated on Linux; NO-GO for merging
current unrestricted PR #29 or claiming active durable CCv2 support.** A restricted
integration could safely progress to review with the above capabilities disabled.
Unconditional merge/release readiness is not established: full final-tree harness,
Windows gates and independent dev-baseline reconciliation remain required. PR #29
stays Draft/blocked until the restriction is reviewed/included and remaining gates
are dispositioned. PR #31 is not a complete fencing fix and is not merged here.

Review classifications:

- BLOCKER for unrestricted integration: stale-owner append/flush/false commit,
  retained 12-failure SIGSTOP evidence. Addressed here by eliminating production
  reachability, not by claiming the underlying algorithm was repaired.
- IMPORTANT: M01 is on independently of A13; A02 direct APIs, A11 default repair
  and A13 resume/recovery bypass version selection. Fixed by explicit source guards
  and read-only controller registry rather than relying on default v1.
- IMPORTANT: existing durable intent and checkpoints survive upgrade. Guards cover
  authentic branded persisted intent and recovery/finalization; bytes are preserved.
- IMPORTANT: native Windows and full release verification remain UNVERIFIED.

Before deployment, stop/drain every old unrestricted controller/writer process,
including any suspended process, and start the restricted revision consistently
in all installations/presets. A source guard cannot fence an already-running old
binary. This task does not deploy, resume old writers or touch durable user data.
Do not revert the guards or enable retired writers until actual mutation-time
fencing is implemented and the preserved security/correctness regressions pass.
These API restrictions are not a sandbox against arbitrary privileged JS/PS that
writes directly or alters module/function definitions.

On a native Windows runner, use a clean isolated install and a separate existing
install copy for upgrade (user settings/credentials must survive). From the reviewed
checkout, run `powershell.exe -NoProfile -File scripts/Setup.ps1 -InstallRoot <clean>`
and `powershell.exe -NoProfile -File scripts/Update.ps1 -SourceRoot <checkout>
-InstallRoot <upgrade-copy>`. Then run each installed `scripts/Test-Harness.ps1`
with `-ContinueOnFailure -ReportPath <report.json>` under Windows PowerShell 5.1
and the supported PowerShell 7 lane (`-PowerShellExecutable <pwsh.exe>`). Validate
actual installed presets using `node tests/ControllerPresetInstalled.Tests.cjs
<install>` and the fixed policy in each controller preset. Exercise runtime startup
and OpenCode Go routing deterministically with `StartupLifecycle.Tests.ps1`,
`MuseProvider.Tests.ps1`, `MuseInstall.Tests.ps1`, `RoutingIntegrity.Tests.cjs`,
`PreferredRouteContract.Tests.cjs` and the three production restriction gates on
that installation. Report native Windows results separately; Linux fixtures are
not Windows certification. No provider inference or LHCB run is required here.
