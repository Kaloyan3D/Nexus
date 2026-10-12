# Registry R7.0 - Release Readiness

Branch: feature/model-registry-v1. Baseline for this check: 35d177f. PR #33 stays Draft.
Flag default: OFF (unchanged). No DSH replacement, no Claude orchestration, no follow-on phases.

## 1. Registry catalog and UI readiness: READY

- R0-R5 registry suites green in this check: Core 45, LegacyBaseline 21,
  R2Compatibility 41, R3Hardening 19, R3UI 29, R4ProbeSecurity 16,
  R4Providers 27, R4TransportBinding 19, R5Connections 14, R51Auth 20,
  R511CliContract 10, InstalledRuntime 3.
- Controller panel suite passes against the clean install (one stale
  expectation corrected with justification: route count 30 to 33, matching
  the products own 33-route list; the count dated to R4 while routes grew
  in R5, predating R6 and R7).
- Protected production trees verified clean apart from reviewed R6 and R7
  files; no credential material in diagnostics or pins (suite-asserted).

## 2. Connection and discovery readiness: READY STATIC, LIVE UNVERIFIED

- Billing separation (subscription vs API vs Bedrock and Vertex overrides)
  proven by R5.1 and R6.0 negative suites, including explicit-login and
  negative-first ordering in JS and PowerShell.
- sol-local subscription-delegated parity proven live at the routing
  boundary (reviewer role, R6.5 matrix); opencode-go route parity proven
  under staged config (R6.5 matrix); Muse target parity proven (R6.2).
- Live OAuth flow, live OpenCode discovery, live Claude CLI auth, and any
  paid provider request are UNVERIFIED here: no account, key, CLI, or
  authorization was available, and none was initiated.

## 3. Compatibility-bridge execution readiness: READY (flag OFF default)

- R6.2 shadow parity 9 of 9, R6.3 flagged binding 10 of 10, R6.3.1
  lockdown 15 of 15, R6.3.1 step-pin PS 11 of 11, R6.5 matrix 7 of 7,
  R7.0 execution boundary 9 of 9, all on real pre-step turns with next()
  counters and attempt-file deltas plus real child-process restarts.
- Every Registry refusal returns reject with no next() and no attempt:
  initial bind, retry, restart, review-findings, step-target, revoked
  authorization (Dual and Muse), visual-review and verify command turns,
  and failed attempt starts. Valid pinned sessions proceed exactly once;
  legacy and authorized diagnostics (pinned verify outcomes) proceed.
- Rollback is proven and documented: flag OFF converts refused generations
  once to legacy-rollback with history retained; new sessions bind pure
  legacy; pins continue to be enforced under legacy-rollback authority.
- Controller authority and identity suites green including the DoD
  end-to-end scenario; routing authority, Muse isolation, and engine
  suites green; installed-runtime preset suites green on the clean root.

## 4. Direct Registry-authoritative routing: NOT COMPLETE (BLOCKED)

The Route and DSH execution substrate exposes no controller-owned target-override input, so a registry-only target cannot reach the consumer except through the legacy decision record. Equality-gating (execute if and only if the legacy decision equals the pinned target) is the shipped safe form. Building a target-override consumer contract plus per-turn re-verification is explicitly out of scope. No flag activation, no default-path change.
## 5. Claude orchestrator readiness: NOT COMPLETE (BLOCKED)

Unchanged from the R6.4 assessment: empty engine scope kept, no role enabled, no tool-control weakened. Missing capabilities (Nexus-owned spawn host, resume-id pinning, role-to-permission policy, tool-execution audit, model-selection policy, live CLI verification) remain unimplemented. The subscription-agent route is pinned by test as never parity-matching a mode role.
## Gate table (this check, commit 35d177f plus R7 working tree)

PASS with executed evidence: R70Readiness 9 of 9; R62Shadow 9 of 9;
R63Binding 10 of 10; R631Lockdown 15 of 15; R631StepPin PS 11 of 11;
R65Matrix 7 of 7; R0 to R5 registry suites listed above;
ComposedRoutingAuthority and Matrix; PreferredRouteContract;
RoutingIntegrity; MuseRoutingAuthorityOrdering 28; MuseIsolation 20;
MuseReasoningRuntime 30; MuseReasoningGovernor 52; MuseProvider 33 and
PS 111; MuseOpenCodeGo 19 and PS 54; MuseOpenCodeSession 29;
MuseEgressCleanup 2; MusePresetDependencyClosure 11;
ControllerPresetCleanInstall 3; AihController bridge unit;
AihControllerIdentity end to end including the DoD scenario;
ControllerSessionBootstrap 32; AihControllerHost 159; MuseAgentPlane
PS 65; Intelligence.Registry PS 65; CCv2 authority sample 35; clean
install execution of ControllerPresetInstalled 2 of 2,
ControllerRouting PS 83 of 83 on the installed root with harness
profile env scrubbed, MuseInstall PS 8 of 8 on the installed root,
NexusControllerPanel exit 0 with the corrected route count.
CCv2 compaction battery: the large majority passes; 25 suites fail
identically on the 35d177f baseline worktree (pre-existing, caused by
the documented durable-mutation freeze and live-host requirements, in
modules untouched by R6 and R7). ContextCompactionV2 PS fails
identically on baseline for the same freeze reason.

BLOCKED with evidence, not regressions: the 25 CCv2 freeze and
live-host suites above; the NexusSkills manifest install step (HOME is
read-only in this sandbox, unrelated to registry code); live Windows
PowerShell 5.1 runtime, GUI runs, live provider auth, and paid calls
(no host, account, key, or CLI here; Linux pwsh 7.5 syntax plus the
R5.1.1 PS 5.1 syntax suite and a 5.1-operator scan stand in); full
native DSH loop startup beyond installation (installed but not launched
as a live session here).

UNVERIFIED: nothing required for this milestone beyond the list above.
No gate is claimed PASS without executed evidence in this task.

## Installation evidence (P2)

A clean isolated install ran to exit 0 via setup.sh with an isolated
install root plus skipped interactive logins: pinned Node 24.18.1 and
pinned pwsh 7.5.3 provisioned and executed; npm dependencies installed
(npm cache redirected to workspace storage because HOME is read-only);
engineering, DeepSeek, and Muse presets installed atomically and
validated; data agent-presets and the preset closure generated. The
four previously blocking suites now execute against that root. Live
developer state was not touched; the isolated root is removed after
this check (reproducible with the same setup.sh invocation).

## Decision

The compatibility bridge is release-ready under its documented terms:
flag default OFF, equality-gated binding only, rollback proven, Claude
and direct routing explicitly blocked.

## R7.1.1 - Registry mode manifest closure (Live E2E blocker, fixed - awaiting user retest)

### Live failure (user-executed, pre-fix)

With NEXUS_REGISTRY_BINDING=1 the live run produced shadow-compile-failed /
registry-binding-unavailable with inner cause unknown-mode, and neither
inference nor Muse fallback executed. Read-only investigation showed all three
mode definitions present in the installed config/registry/modes/ but missing
from data/.agent-presets/aih-muse/registry/modes/, while compiling the saved
EMv2 revision 2 through the main installed Registry service succeeded.

### Root cause

Managed dependency-closure defect, not OAuth or model authentication:
config/registry/legacy-import.cjs loads the mode definitions with a
__dirname-relative fs read (loadModeDefinitions), not with require, so
the require-graph walk in scripts/MusePresetDependencyClosure.cjs never
discovered them and no preset copy shipped them. The preset-local Registry
then compiled every known mode to unknown-mode.

### Fix (this branch, PR #33 still Draft)

- scripts/MusePresetDependencyClosure.cjs: new pinned REGISTRY_MODE_ASSETS
  (registry/modes/engineering-v1.json, engineering-v2.json,
  engineering-v3.json) included in all four closure profiles (muse,
  engineering, deepseek, controller). Tokenizer assets, source tracking, graph
  validation, SHA-256 integrity, and path-boundary protections unchanged.
- config/registry/shadow-binding.cjs: new fail-closed diagnostic
  shadow-mode-definitions-missing (with inner
  registry-mode-definitions-missing) when a known mode compiles to
  unknown-mode (or the snapshot is unavailable) while mode asset files are
  absent. Unrecognized mode ids, invalid saved configs (shadow-compile-failed)
  and genuine routing mismatches (shadow-mismatch) keep their existing codes;
  missing configuration is never compiled successfully and never falls back silently.
- tests/MusePresetRegistryModes.Tests.cjs (new, 8 checks): builds real
  isolated installs with the actual closure tooling, loads the Registry service
  from the preset-local copied module, proves preset-local shadow parity on a
  saved EMv2 config with contributor data-use tier, validates manifests/hashes
  for all four profiles, and proves removing a mode asset fails validation.
  Failing-first demonstrated: 0/8 on the pre-fix baseline (inner unknown-mode)
  versus 8/8 after the fix.
- tests/ControllerPresetCleanInstall.Tests.cjs: synthetic controller fixture now
  carries the three pinned mode assets (spec change with justification: the
  controller profile now requires them); suite passes 3/3.

### Reproduction

1. node scripts/MusePresetDependencyClosure.cjs plan . muse - pre-fix the
   listing contains no registry/modes JSON; post-fix all three are pinned
   in every profile.
2. node tests/MusePresetRegistryModes.Tests.cjs - 8/8 post-fix; stash the
   two source fixes and it falls to 0/8 with unknown-mode, matching the live
   failure signature.
3. Install paths unchanged: setup.sh / scripts/Setup.ps1 still publish the
   full config/registry tree recursively, and Install-MusePreset.ps1 /
   Install-ControllerPresets.ps1 call the corrected closure without bypassing
   validation (see RegistryInstalledRuntime 3/3).

### Status

NOT live-verified: no Live E2E PASS is claimed. The operator retest of the
installed runtime (reinstall presets, set NEXUS_REGISTRY_BINDING=1) is still
required. Remaining failures in this check: RegistryR632Execution 11/12
(muse-pin case fails identically on the pre-fix baseline - pre-existing,
unrelated to this fix) and RegistryR65Matrix tree-cleanliness (flags task-scoped
scripts edits while uncommitted; clears once committed).
Flag default OFF, PR #33 stays Draft, no routing-policy or credential changes. No merge without explicit
authorization.


## R7.4 — Rollback and recovery hardening (2026-10-12)

Scope: `feature/model-registry-v1`, based on preserved fixture-repair commit
`8015037`. The earlier sections are historical checks, not results of this
milestone. In particular, their R6.3.2 11/12 limitation predates `8015037`.
PR #33 remains Draft. Registry remains default OFF.

### Transition policy

The flag is evaluated at an execution/transition boundary; changing the
process environment alone does not mutate persisted session authority.

| Persisted state | Flag ON | Flag OFF | Durable result / execution boundary |
| --- | --- | --- | --- |
| Genuine unmarked legacy generation | Continue legacy | Continue legacy | Same identity; no fabricated pin or authority marker |
| Pending or refused current generation | Fresh parity evaluation; mismatch remains parked | Explicit authorized rollback at routing or command boundary | ON success creates its own pin; OFF persists `legacy-rollback`, retains refusal history and creates no pin |
| Valid current-generation pin | Verify effective persisted target and exact connection entitlement | Same verification; flag does not discard pin | Identity, resolution ID and role-target map remain immutable; valid continuation reaches `next()` |
| Current pin with provider/model/reasoning drift | Reject | Reject | `registry-pin-mismatch`, zero `next()` and zero attempt delta |
| Current pin with revoked/unavailable connection | Reject | Reject | Exact pinned connection checked; no provider fallback or new attempt |
| Current pin with unreadable/missing execution target | Reject | Reject | `registry-execution-target-unavailable`; pin and identity retained |
| Pin from A carried into replacement generation B | Retire A authority, persist pending B, evaluate fresh B | Retire A authority, persist pending B, explicitly roll back B | A never authorizes B; no contradictory `legacy-rollback` plus stale pin; re-enabling requires fresh evaluation |
| Marked generation with inconclusive task identity | Reject before recovery or execution | Reject before rollback or execution | Durable binding preserved; no task/attempt allocation |
| Requested Muse ↔ Dual switch, including stale recovery | Reject | Reject | Immutable engine guard runs before invalidation or recovery |
| Interrupted pending/refused/pin/rollback snapshot before attempt | Resume the corresponding policy above | Resume the corresponding policy above | Exactly one first attempt when allowed; open-attempt restart adds none |

Rollback does not erase the security history of a refused generation. A
successful fresh evaluation replaces the refusal with a verified pin. A
retired stale pin is removed from current authority; the structured
`registry-generation-retired` event retains its old/current task identities
and resolution ID. The original run artifacts remain historical evidence.

### Confirmed defects and minimal changes

- The entry gate checked role and entitlement but did not compare the actual
  persisted execution target on an already-open attempt. Provider drift
  reached `next()` despite a valid pin. The controller now reads the same
  target as Engineering/Muse isolation and applies `verifyTransitionTarget()`
  before ordinary or command execution, even when a route check is pending.
- Stale recovery carried A's pin into B. `rollback-pinned` wrote
  `legacy-rollback` without clearing that pin; classification prioritized the
  pin and rejected B. Failed fresh evaluation similarly left A's pin shadowing
  B's refusal. Retirement now persists a B pending marker before evaluation or
  rollback, including recovery from an interrupted pre-route snapshot.
- Inconclusive TaskController validation rejected Muse but allowed Dual via
  `next()`, including Registry-marked Dual sessions. Marked sessions now fail
  closed with either flag. Genuine unmarked Dual legacy behavior is preserved.

Production changes are confined to `config/AihController.cjs`.
`tests/RegistryR74RollbackRecovery.Tests.cjs` exercises real middleware,
TaskController-created lifecycle records, real Route persistence, fresh
processes for every turn, exact pin-derived connection IDs, structured logs,
`next()` counters and attempt ledgers. The model boundary is counted without
calling any provider. Crash checks reconstruct durable boundary snapshots;
these are not fault-injected disk failures or power-loss tests.

The R6.3.2 Muse fixture now persists the real canonical task route instead of
using a dry route. This supplies the target that the strengthened gate and
actual Muse isolation consume; all original R6.3.2 assertions are retained.

The older R6.3 rollback integration test deleted generation A and expected B
to retain A's pin. Its initial run was 9 PASS / 1 FAIL after the fix. That
expectation contradicts the explicit R7.4 stale-generation policy. The test
now verifies complete same-generation pin retention under flag OFF first,
then explicit retirement, current-generation pending identity and historical
retirement logging for B. This is a documented policy correction, not removal
of an execution-safety assertion; R7.4 independently proves allowed/rejected
boundaries and task/attempt counts.

The initial R6.3.1 run was 14 PASS / 1 FAIL: its reviewer mismatch test left
Route's refused candidate persisted, so the strengthened entry gate rejected
that target before the following independent revocation check could reach its
expected authorization diagnostic. Fixture cleanup now restores the prior
routing snapshot as well as the mutated profile. Both original negative
assertions remain intact; no production guard is bypassed.

The clean-install packaging test previously forbade `Muse-Isolation.cjs` in
Dual preset closures. The shared controller now requires its pure target
reader, so the closure must ship that dependency. The test now verifies
presence, copied-module loading and rejection of a Dual binding with the exact
`engine-binding-violation` code, alongside all original closure integrity,
tokenizer and missing-file checks. Importing this module does not call its
`apply()` function or register Muse middleware; engine activation and the
consumer routing contract are unchanged.

### Architecture review

| Question | R7.4 answer |
| --- | --- |
| Source of truth | TaskController owns canonical task/generation/engine identity; Route and step-routing records own effective legacy targets; the Registry pin owns immutable execution equality constraints |
| Ownership | Controller remains the session-binding writer; existing TaskController/Route writers remain unchanged |
| Dependency direction | Controller orchestrates existing pure isolation target readers and Registry validators; neither reader depends on the controller; no cycle |
| Boundary contracts | Plain persisted target fields enter `verifyTransitionTarget()`; live session objects and credentials never enter pins |
| Failure semantics | Inconclusive identity, unavailable target, drift and ineligible connection reject before `next()` or attempt creation; no automatic fallback |
| State lifecycle | Stale pin → current pending marker → fresh pin or explicit rollback; atomic binding persistence and existing task/attempt lifecycle remain authoritative |
| Test seams | Temporary install/data/workspace roots, real CLI tasks and fresh controller processes; only the downstream `next()` model boundary is counted |
| Compatibility / migration | No schema migration, new authority type, default flag change or legacy retroactive pin; existing pin/refusal shapes remain supported |
| Observability | Retirement logs old/current IDs and resolution; existing bound/refused/rollback/execution-refused events distinguish transitions |
| Security | Flag OFF cannot waive an established generation's target equality or connection authorization; replacement generation requires its own transition; no credentials or production status writes |

### Executed evidence

The three regression cases were also executed against an isolated copy of
`8015037:config/AihController.cjs`, using the new integration suite and the
unchanged Task/Route/Registry implementation. Each selected case produced
**0 PASS / 1 FAIL** with an actual assertion failure: provider drift returned
`next` instead of `reject`; stale OFF recovery returned `reject` instead of
`next`; inconclusive pinned identity returned `next` instead of `reject`.
These expected baseline failures are not counted as acceptance PASS results.
They are retained in `tmp/r74-evidence/baseline-C.log`, `baseline-E.log` and
`baseline-F.log` on the checking workspace.

Final results for the R7.4 tree based on `8015037` (the commit containing this
section), CachyOS Linux, bundled Node and PowerShell:

| Gate | PASS | FAIL | Status |
| --- | ---: | ---: | --- |
| RegistryR74RollbackRecovery | 21 | 0 | PASS |
| RegistryR632Execution | 12 | 0 | PASS |
| RegistryR62Shadow | 9 | 0 | PASS (0 skipped) |
| RegistryR63Binding | 10 | 0 | PASS, policy-corrected test rerun |
| RegistryR631Lockdown | 15 | 0 | PASS, isolated fixture cleanup rerun |
| RegistryR631StepPin (PowerShell) | 11 | 0 | PASS |
| RegistryR65Matrix | 7 | 0 | PASS |
| RegistryR70Readiness | 9 | 0 | PASS |
| MusePresetDependencyClosure | 11 | 0 | PASS |
| MusePresetRegistryModes | 8 | 0 | PASS |
| ControllerPresetCleanInstall | 3 | 0 | PASS, reader-dependency assertion updated and rerun |
| RegistryInstalledRuntime | 3 | 0 | PASS |
| AihControllerHost | 159 assertions | 0 | PASS |
| AihControllerIdentity | 7 scenario groups | 0 | PASS, includes real bridge DoD scenario |
| Node syntax / Git whitespace checks | — | 0 | PASS |
| R7.4 live installed host / paid inference | — | — | UNVERIFIED, intentionally outside isolated scope |
| Full native build / application release smoke | — | — | UNVERIFIED, not release qualification |

The final counted Registry/packaging acceptance checks total **119 PASS /
0 FAIL**: 21 new, 73 existing Registry and 25 packaging. The host assertions
and identity scenario groups are listed separately rather than conflated with
that count. Superseded failed runs and expected baseline failures above are
excluded. No skipped/unexecuted check is counted as PASS.

The executed checks used `DOTNET_PROCESSOR_COUNT=2` to bound workers in
isolated PowerShell hosts, `PATH` including the bundled PowerShell, and
`AIH_TOOLCHAIN_ROOT="$HOME/.local/share/nexus"` (executables read only).
Reproduce their individual commands with:

```bash
export DOTNET_PROCESSOR_COUNT=2
export PATH="$HOME/.local/share/nexus/runtime/pwsh:$PATH"
export AIH_TOOLCHAIN_ROOT="$HOME/.local/share/nexus"
NEXUS_TEST_NODE="$HOME/.local/share/nexus/runtime/node/bin/node"
for suite in RegistryR74RollbackRecovery RegistryR632Execution RegistryR62Shadow \
  RegistryR63Binding RegistryR631Lockdown RegistryR65Matrix RegistryR70Readiness \
  MusePresetDependencyClosure MusePresetRegistryModes ControllerPresetCleanInstall \
  RegistryInstalledRuntime AihControllerHost AihControllerIdentity; do
  "$NEXUS_TEST_NODE" "tests/$suite.Tests.cjs"
done
"$HOME/.local/share/nexus/runtime/pwsh/pwsh" -NoLogo -NoProfile \
  -File tests/RegistryR631StepPin.Tests.ps1
"$NEXUS_TEST_NODE" --check config/AihController.cjs
"$NEXUS_TEST_NODE" --check tests/RegistryR74RollbackRecovery.Tests.cjs
git diff --check
```

Raw outputs are retained in the checking workspace's ignored
`tmp/r74-evidence/`. Use `RegistryR63Binding-final.log`,
`RegistryR631Lockdown-final.log` and `ControllerPresetCleanInstall-verified.log`
for their final runs; other final logs use the suite name, with `R74.log` for
R7.4. The table records durable reviewable results independently of those
local logs.

`R74.log` records immutable restart evidence for Dual `conn-flash-high-direct`
and Muse `conn-meta-model-api`, with task instance and resolution IDs. Both
flags retain complete pins; revoked and unavailable status cases use those
exact IDs and prove rejection/zero next/zero attempt delta after closing the
initial attempt. It also records A → B stale rollback with explicit authority
and no retained pin. Positive restarts reach `next()` once without allocating
another task or open attempt. The A–G scenarios exercise both positive and
negative boundaries; command rollback reaches safe diagnostic machinery
without calling a reviewer or provider.

Self-review found no remaining correctness, data-loss/security or lifecycle
blocker in this bounded change. R7.4's **isolated integration acceptance is
complete**; the live and full-release limitations below remain explicit.

### Live scope and remaining release gates

The operator-reported R7.1.1 live parity, R7.2 inference continuation and R7.3
provider mismatch are baseline context, not live runs performed in R7.4.
R7.4 live installed-host verification is **UNVERIFIED**. No running Nexus
application was stopped/restarted, no live sessions (including TASK-0052),
credentials or production connection statuses were changed, and no paid
inference ran. Bundled Node/PowerShell were read as executables; all mutable
fixture state was isolated outside the installed application.

Direct Registry-authoritative target overrides and Claude orchestration remain
blocked as documented above and are outside R7.4. Full native/application
release gates and real power-loss/storage-failure injection were not performed.
This milestone's isolated integration assessment does not qualify the whole
product for release. No push or merge is authorized by this task.
