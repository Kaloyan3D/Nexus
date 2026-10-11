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
