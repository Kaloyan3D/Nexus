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
and direct routing explicitly blocked. No merge without explicit
authorization.
