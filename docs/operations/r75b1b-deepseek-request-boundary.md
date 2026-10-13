# Nexus R7.5B.1b — DeepSeek request authorization and isolated preflight

**READY FOR R7.5B.2 CONTROLLED INFERENCE**

Scope: the combined R7.5B.1a ownership repair and R7.5B.1b request security correction on `feature/model-registry-v1`, based on `ffcf79c7d942483e86a4b43fbf6797a1f930fe69`. The candidate source hashes and final commit identity are recorded in [candidate-file-identity.json](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/candidate-file-identity.json) and [completion.json](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/completion.json); the tracked report does not embed its own recursive commit hash. A local commit follows acceptance. No push or merge, live installation update/restart, production OAuth access, production TASK-0052 access, provider inference or external model probe occurred. Binding remains default OFF; PR #33 is unchanged and Draft.

## Root causes and final architecture

The actual DeepSeek preset mounts DeepSeek-Isolation and AihController, without Engineering-Isolation. Its historical request handler forced the DeepSeek legacy default and worker whitelist, but did not call the common Registry authorization boundary. An already-mounted controller also retained prepared bindings in memory and could miss newer durable refusal markers. A later preparation on the same standing mount could merge an old cached pin with a new refusal and overwrite authority on persistence.

DeepSeek now reuses the existing Dual controller-target readers and `Controller-RequestBoundary.cjs`. It does not resolve Registry routes independently. Genuine unmarked legacy requests retain the original provider/model/effort and worker rules. Marked requests retain the exact controller-approved provider, model, effort and role. DeepSeek's existing provider/model whitelist also constrains marked targets. Scope-local observations only reject missing or removed authority; they cannot grant permission or provide a route.

The shared final guard validates the real TaskController task id, immutable generation and bound engine, then rereads durable binding and routing after that asynchronous CLI validation. It verifies the pin's schema, authority, task id, generation, engine, preset, role map, provider/model/reasoning/data-use target and current connection status through the existing common policy. It confirms the effective request matches the approved route and pinned effort. An earlier pre-step, an open attempt or worker-shaped header cannot replace this request-time check. The guard allocates no task, begins no attempt, repairs no identity and clears no marker.

A separate reviewed defect existed in the pure common classifier: a valid pin and a newer refusal could coexist, and the pin won. The actual host reached the terminal with nextCount=1 in [pin-refusal-conflict-before.json](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/pin-refusal-conflict-before.json). Both active records now classify as unverifiable authority; successful controller evaluation already clears its refusal, so conflicting active records cannot grant permission. The final host regression proves nextCount=0 for this case.

Controller binding reads refresh durable fields on each warm continuation. Absence of a durable authority field is meaningful; optional pin/refusal/authority fields are removed from the derived cache rather than merged from an older object. Removal of known marked authority without a durable explicit rollback fails closed. Generation changes conflicting with prepared authority fail closed. Atomic persistence retains the existing temporary-file/fsync/rename layout and adds per-mount read-version metadata to reject conflicting authority writes. Preparation adopts newer durable authority before modifying its own session. No persistent schema, storage layout, global routing variable or second policy engine was added.

The host-scoped `DSH_AIH_PRESET` owner from R7.5B.1a remains intact. Its session resolver uses the latest selected-preset event, then the header, without ambient process-global selection. Values are `aih-engineering`, `aih-deepseek`, and `aih-muse`. Controller-only packaging now also references this module, so all four managed closure profiles contain it. SDK key uniqueness and disposal semantics are unchanged.

Retries and continuation use the same `agent/request` boundary. The loop builds provider requests through that waterfall before stream dispatch. The unchanged DeepSeek request-error handler stops recovery outside its whitelist and introduces no fallback. Scope carriers in the integration fixture use the real SDK `scopeTarget(agent, agent)`.

## Before and after evidence

The permanent test is `tests/DeepSeekRequestBoundaryHost.Tests.cjs`, registered in Test-Harness. It requires an explicit disposable owned host; without that environment it reports SKIP, which cannot establish release acceptance. This phase explicitly executed it against the real mounted DSH host.

Before the fix, a real prepared DeepSeek task completed pre-step; a generation-correct pending marker was persisted; actual scoped request middleware reached the terminal. The expected refusal assertion failed: [before-failing-regression.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/before-failing-regression.log). The explicit reproducer also confirmed the bypass: [before-security-regression.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/before-security-regression.log), [before-security-regression.json](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/before-security-regression.json).

Reproducer commands, from the repository:

```sh
NEXUS_BOUNDARY_FIXTURE_ROOT="$PWD/tmp/r75b1b" node tests/DeepSeekRequestBoundaryHost.Tests.cjs --expect-bypass
NEXUS_BOUNDARY_FIXTURE_ROOT="$PWD/tmp/r75b1b" node tests/DeepSeekRequestBoundaryHost.Tests.cjs
```

The first command is only an expected-before check and fails on the repaired candidate. The second is the actual acceptance regression. Host setup and every executed argv are retained in `tmp/r75b1b/` and the evidence JSON files. The final result is [acceptance-security.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-security.log), [security-matrix.json](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/security-matrix.json): **29 actual-host cases**, zero provider dispatches.

| Actual-host case | Result | Downstream next |
|---|---|---:|
| genuine-legacy | PASS | 1 |
| valid-pin | PASS | 1 |
| peer-preparation-preserves-newer-authority | PASS (registry-pending) | 0 |
| pending-after-prestep | PASS (registry-pending) | 0 |
| pinned-refusal-conflict | PASS (registry-authority-unverifiable) | 0 |
| refused | PASS (registry-binding-mismatch) | 0 |
| missing-session-header | PASS (engine-binding-violation) | 0 |
| worker-marked-parent | PASS (registry-pending) | 0 |
| corrupt-document | PASS (bindings-unverifiable) | 0 |
| malformed-entry | PASS (bindings-unverifiable) | 0 |
| missing-binding | PASS (bindings-unverifiable) | 0 |
| removed-authority | PASS (registry-authority-unverifiable) | 0 |
| malformed-pin-authority | PASS (registry-pin-mismatch) | 0 |
| pin-engine-mismatch | PASS (registry-pin-mismatch) | 0 |
| task-bound-engine-mismatch | PASS (engine-binding-violation) | 0 |
| role-unpinned | PASS (registry-role-unpinned) | 0 |
| invalid-generation | PASS (registry-generation-mismatch) | 0 |
| changed-provider | PASS (registry-pin-mismatch) | 0 |
| changed-model | PASS (deepseek-provider-not-allowed) | 0 |
| changed-reasoning | PASS (registry-pin-mismatch) | 0 |
| connection-revoked | PASS (registry-authorization-revoked) | 0 |
| connection-unknown | PASS (registry-authorization-unavailable) | 0 |
| connection-not-connected | PASS (registry-authorization-unavailable) | 0 |
| unverifiable-task-identity | PASS (binding-validation-inconclusive) | 0 |
| open-attempt-pending | PASS (registry-pending) | 0 |
| open-attempt-valid-pin | PASS | 1 |
| explicit-controller-rollback | PASS | 1 |
| pending-after-restart | PASS (registry-pending) | 0 |
| muse-valid-pin | PASS | 1 |

Every denial snapshots the real ledger after deliberate fault injection and verifies that the guard leaves it byte-for-byte unchanged, with no additional attempts or generation. Injected files are restored in `finally`. Tasks are allocated by actual controller preparation and TaskController; they are not incomplete handwritten tasks. The open-attempt case explicitly seeds one real attempt through the isolated TaskController CLI, then proves no guard adds an attempt. Positive tests stop at a config-returning terminal, never at a provider. Offline Registry snapshot approvals prove policy behavior, not live provider entitlement.

The explicit rollback positive invokes the actual controller's `/verify` command pre-step, observes durable `legacy-rollback` and retained generation/history, then authorizes continuation. No request handler creates this transition independently. Pending/refused authority inserted after pre-step rejects before next, including after restart. The warm controller rejects it without needing restart. Peer preparation preserves a newer refusal rather than resurrecting its cached pin.

## Isolated installation and host acceptance

Disposable source: `tmp/r75b1b/source`; install/data: `tmp/r75b1b/source/tmp/install/{app,data}`; private home: `tmp/r75b1b/home`; workspaces: `tmp/r75b1b/workspaces`. A distinct clean `source/tmp/security-audit-install` holds destructive installer fixture tests. Only task-owned processes and state were used.

The pinned private DSH **0.1.1-rc.2**, Node **24.18.1**, PowerShell **7.5.3** and dependency tree were reused from the previously fresh isolated npm install. No claim is made that another npm ci ran. The supported shared installer and closure preparation were rerun with the repaired candidate. Real mounted presets, native dependencies, manifest/lock identity and source hashes were checked.

Bubblewrap hides the real home and normal Nexus state, clears credentials/environment, isolates mount/user/PID/network/IPC/UTS/cgroup namespaces, mounts candidate code read-only, and permits only task-owned writable state. Actual host networking has private loopback and no external route. Inner port 43080 is bridged by a 0600 Unix socket to outer loopback 43081. The host receives inbound HTTP/WebSocket bytes; it gains no external egress. Full and production npm audit metadata used a separate installer-only network invocation with the same masked home; the actual host never shared networking.

Actual process identifiers, namespaces, routes and hidden production paths are in `actual-host-isolation.json`; cleanup status is in `cleanup.json`. All owned processes are stopped at completion; no owned PID, relay port or socket remains. Full compressed session logs were decoded after shutdown: 70 sessions, four controller diagnostic user-message events, and zero model turn or provider-dispatch events. The normal application was untouched.

| Acceptance gate | Status | Evidence |
|---|---|---|
| Actual DeepSeek common request enforcement | PASS | acceptance-security.log; security-matrix.json |
| All requested denials, open attempt, worker/header protection | PASS | security-matrix.json |
| Pinned DeepSeek, legacy and explicit rollback, pinned Muse positives | PASS | security-matrix.json |
| Production composition in four creation orders / twenty persisted sessions | PASS | production-matrix-accepted.log; vanilla-host-matrix.json |
| Correct per-session actual shell consumer | PASS | final-preflight.json; MixedPresetShellEnv logs |
| GUI / Registry catalog and mode APIs | PASS | gui-health.json; stable-health.json |
| EMv1/EMv2 staging and restart; legacy data unaffected | PASS | final-preflight.json |
| Unique real task generations and no guard-induced attempt | PASS | security-matrix.json; final-session-events.log |
| All four managed closures contain shared shell module | PASS | closure-shared-module.json; installation-verified.json |
| Clean install, upgrade preservation and failed-upgrade rollback | PASS | final-installation-audit.log (7 checks) |
| Installed and canonical source Linux platform support | PASS | platform-installed.log; platform-source-canonical.log; final-suite-PlatformSupport.log |
| Dependency/native compatibility | PASS | final-native-compatibility.log |
| Dependency security remediation preserved | PASS | npm-audit.log; npm-audit-production.log: zero vulnerabilities |
| Syntax / whitespace | PASS | syntax.json; whitespace.json |
| Native Windows / PowerShell 5.1 execution | UNVERIFIED | Outside this isolated Linux host preflight; those native lanes did not run here. |
| Provider entitlement and inference latency | UNVERIFIED | Explicitly excluded; zero inference budget and no provider probes. |
| Unrelated full Test-Harness research campaigns | SKIP | This check covers the affected authorization, Registry, packaging and platform suites below. |

## Executed regression gates

All **44 broader affected suites** passed in `final-suites.json`. The final contradictory-authority correction was then checked by rerunning every directly affected policy/Registry boundary suite in `acceptance-suites.json`; those results are listed alongside the full run. Exact commands, exit codes, times and logs are recorded; no required host result is inferred from a permissive fake registration API.

| Suite | Status | Evidence |
|---|---|---|
| MixedPresetShellEnv | PASS | [final-suite-MixedPresetShellEnv.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MixedPresetShellEnv.log) |
| EngineeringIsolation | PASS | [final-suite-EngineeringIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-EngineeringIsolation.log) |
| DeepSeekIsolation | PASS | [final-suite-DeepSeekIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-DeepSeekIsolation.log) |
| MuseIsolation | PASS | [final-suite-MuseIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MuseIsolation.log) |
| MuseRoutingAuthorityOrdering | PASS | [final-suite-MuseRoutingAuthorityOrdering.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MuseRoutingAuthorityOrdering.log) |
| ComposedRoutingAuthority | PASS | [final-suite-ComposedRoutingAuthority.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-ComposedRoutingAuthority.log) |
| ComposedRoutingMatrix | PASS | [final-suite-ComposedRoutingMatrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-ComposedRoutingMatrix.log) |
| NexusEngineContract | PASS | [final-suite-NexusEngineContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-NexusEngineContract.log) |
| ControllerSessionBootstrap | PASS | [final-suite-ControllerSessionBootstrap.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-ControllerSessionBootstrap.log) |
| AihControllerIdentity | PASS | [final-suite-AihControllerIdentity.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-AihControllerIdentity.log) |
| AihController | PASS | [final-suite-AihController.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-AihController.log) |
| AihControllerHost | PASS | [final-suite-AihControllerHost.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-AihControllerHost.log) |
| ControllerPresetInstalled | PASS | [final-suite-ControllerPresetInstalled.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-ControllerPresetInstalled.log) |
| ControllerPresetCleanInstall | PASS | [final-suite-ControllerPresetCleanInstall.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-ControllerPresetCleanInstall.log) |
| MusePresetDependencyClosure | PASS | [final-suite-MusePresetDependencyClosure.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MusePresetDependencyClosure.log) |
| MusePresetCleanInstall | PASS | [final-suite-MusePresetCleanInstall.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MusePresetCleanInstall.log) |
| MusePresetRegistryModes | PASS | [final-suite-MusePresetRegistryModes.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MusePresetRegistryModes.log) |
| MuseOpenCodeGo | PASS | [final-suite-MuseOpenCodeGo.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-MuseOpenCodeGo.log) |
| RegistryCore | PASS | [final-suite-RegistryCore.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryCore.log) |
| RegistryLegacyBaseline | PASS | [final-suite-RegistryLegacyBaseline.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryLegacyBaseline.log) |
| RegistryR2Compatibility | PASS | [final-suite-RegistryR2Compatibility.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR2Compatibility.log) |
| RegistryR3Hardening | PASS | [final-suite-RegistryR3Hardening.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR3Hardening.log) |
| RegistryR3UI | PASS | [final-suite-RegistryR3UI.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR3UI.log) |
| RegistryR4ProbeSecurity | PASS | [final-suite-RegistryR4ProbeSecurity.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR4ProbeSecurity.log) |
| RegistryR4Providers | PASS | [final-suite-RegistryR4Providers.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR4Providers.log) |
| RegistryR4TransportBinding | PASS | [final-suite-RegistryR4TransportBinding.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR4TransportBinding.log) |
| RegistryR511CliContract | PASS | [final-suite-RegistryR511CliContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR511CliContract.log) |
| RegistryR51Auth | PASS | [final-suite-RegistryR51Auth.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR51Auth.log) |
| RegistryR5Connections | PASS | [final-suite-RegistryR5Connections.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR5Connections.log) |
| RegistryR62Shadow | PASS | [final-suite-RegistryR62Shadow.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR62Shadow.log) |
| RegistryR63Binding | PASS | [final-suite-RegistryR63Binding.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR63Binding.log) |
| RegistryR631Lockdown | PASS | [final-suite-RegistryR631Lockdown.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR631Lockdown.log) |
| RegistryR632Execution | PASS | [final-suite-RegistryR632Execution.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR632Execution.log) |
| RegistryR65Matrix | PASS | [final-suite-RegistryR65Matrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR65Matrix.log) |
| RegistryR70Readiness | PASS | [final-suite-RegistryR70Readiness.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR70Readiness.log) |
| RegistryR74RollbackRecovery | PASS | [final-suite-RegistryR74RollbackRecovery.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR74RollbackRecovery.log) |
| RegistryInstalledRuntime | PASS | [final-suite-RegistryInstalledRuntime.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryInstalledRuntime.log) |
| SourceCompleteness | PASS | [final-suite-SourceCompleteness.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-SourceCompleteness.log) |
| PreferredRouteContract | PASS | [final-suite-PreferredRouteContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-PreferredRouteContract.log) |
| RoutingIntegrity | PASS | [final-suite-RoutingIntegrity.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RoutingIntegrity.log) |
| RuntimeRoutingTrace | PASS | [final-suite-RuntimeRoutingTrace.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RuntimeRoutingTrace.log) |
| PlatformSupport | PASS | [final-suite-PlatformSupport.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-PlatformSupport.log) |
| RegistryR631StepPin | PASS | [final-suite-RegistryR631StepPin.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR631StepPin.log) |
| RegistryR75PrivatePath | PASS | [final-suite-RegistryR75PrivatePath.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/final-suite-RegistryR75PrivatePath.log) |

Final policy correction reruns:

| Suite | Status | Evidence |
|---|---|---|
| MixedPresetShellEnv | PASS | [acceptance-suite-MixedPresetShellEnv.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-MixedPresetShellEnv.log) |
| DeepSeekIsolation | PASS | [acceptance-suite-DeepSeekIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-DeepSeekIsolation.log) |
| EngineeringIsolation | PASS | [acceptance-suite-EngineeringIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-EngineeringIsolation.log) |
| MuseIsolation | PASS | [acceptance-suite-MuseIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-MuseIsolation.log) |
| ComposedRoutingAuthority | PASS | [acceptance-suite-ComposedRoutingAuthority.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-ComposedRoutingAuthority.log) |
| ComposedRoutingMatrix | PASS | [acceptance-suite-ComposedRoutingMatrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-ComposedRoutingMatrix.log) |
| MuseRoutingAuthorityOrdering | PASS | [acceptance-suite-MuseRoutingAuthorityOrdering.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-MuseRoutingAuthorityOrdering.log) |
| NexusEngineContract | PASS | [acceptance-suite-NexusEngineContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-NexusEngineContract.log) |
| RegistryCore | PASS | [acceptance-suite-RegistryCore.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryCore.log) |
| RegistryR63Binding | PASS | [acceptance-suite-RegistryR63Binding.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryR63Binding.log) |
| RegistryR631Lockdown | PASS | [acceptance-suite-RegistryR631Lockdown.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryR631Lockdown.log) |
| RegistryR632Execution | PASS | [acceptance-suite-RegistryR632Execution.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryR632Execution.log) |
| RegistryR65Matrix | PASS | [acceptance-suite-RegistryR65Matrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryR65Matrix.log) |
| RegistryR70Readiness | PASS | [acceptance-suite-RegistryR70Readiness.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryR70Readiness.log) |
| RegistryR74RollbackRecovery | PASS | [acceptance-suite-RegistryR74RollbackRecovery.log](/home/kaloyan/Projects/Nexus/tmp/r75b1b/evidence/acceptance-suite-RegistryR74RollbackRecovery.log) |

RegistryR65Matrix retains the protected-tree guard. The exact reviewed Setup change packages the shared shell module; the exact Test-Harness changes register both regressions. Only those two named script paths were added to its allowance. Unrelated scripts, data, UI, catalogs, settings and policy definitions remain protected. No broad guard suppression occurred.

Source-layout launchers are part of the supported contract: existing platform tests intentionally invoke `bin/linux/aih-update.sh` directly. All seventeen shared templates now distinguish `<checkout>/bin/linux` from installed `<install>/bin`, while baked launcher roots retain priority. No live launcher was rewritten. The source test's later toolkit assertions require a canonical source runtime; the disposable source was provisioned with private copies of the exact pinned runtimes. Installed layout independently passes. The failed partial fixture lacked that runtime and is retained as diagnostic evidence, not a product defect or PASS.

The initial R7.4 fixture invoked arming outside its structured denial capture. Arming now correctly rejects malformed authority early, so the fixture moves it inside that capture. Its zero-next, zero-attempt and preserved-history assertions are unchanged. The acceptance host regression independently proves requests refuse changes introduced after successful pre-step.

The installer audit uses the required explicit root and a fresh separate install; it is never run against the live test host's staged data. Fresh/upgrade preservation and corruption rollback pass. Both fresh dependency audits report zero vulnerabilities, and package manifest/lock files are unchanged.

Other failed diagnostics are retained: an early request raced host startup; readiness now verifies Registry plus actual host RPC and observer registration. An early status fixture used `version` rather than the canonical `schemaVersion`; the corrected revocation/unknown/not-connected cases assert their exact codes. Reusing a warm fault-injection host after restoring older bytes correctly triggered authority-removal protection; the isolated harness explicitly restarts its owned host between such runs. No production expectation was changed to hide a defect.

## Final review and persistence invariants

The complete combined diff was reviewed for correctness, data loss/security, lifecycle/concurrency, compatibility and architecture using the code-review skill. The reproduced bypasses and contradictory-authority blocker are resolved by executed actual-host regressions. No unresolved blocker was accepted. No SDK uniqueness check, provider transport or model registry catalog was modified. No arbitrary Registry route, Claude orchestration, Rust runtime or real credentials were introduced.

Durable bindings, routing state and TaskController remain canonical. The controller cache and read-version map are re-derivable metadata; they cannot authorize a request. JSON schema version and atomic fsync/rename persistence are unchanged, so no migration/backfill or destructive data operation is needed. The existing install audit executes both fresh and upgrade paths and protects settings, fake credentials, pin identity and staged configuration. A rollback restores the prior source and rebuilds managed closures in an isolated installation; it does not erase task or pin history.

Architecture decisions:

1. Source of truth: TaskController ledger proves generation; durable session binding, routing state and Registry connection snapshot prove final entitlement. Controller cache is a projection, never permission.
2. Ownership: controller alone performs evaluation/rollback and task allocation. Final guard reads only. Existing common Registry policy is reused for all engines.
3. Dependencies: DeepSeek imports the existing Dual execution target read helpers and shared request boundary; no second policy engine or route registry.
4. Boundary: binding/target/connection verdict, exact provider/model/effort and role, scoped agent context. No credentials or global route state.
5. Failure: malformed/missing required authority, identity failure, stale generation or revoked/unknown authorization raises a structured refusal before downstream. No guard repairs or fallback.
6. Lifecycle: per-agent boundary composition disposed with SDK scope; durable authority reread on each request and warm pre-step. Host shell owner from R7.5B.1a is preserved. Cache write conflicts fail rather than erase newer authority.
7. Tests: real production mounted DeepSeek host with scopeTarget; TaskController-created tasks; no-dispatch terminal; before-fix pending marker reaches terminal. Full negative matrix plus pinned/legacy/rollback positives after fix.
8. Compatibility: unmarked legacy DeepSeek routing whitelist/default/worker behavior remains unchanged. Pinned requests retain exact controller target and effort, independent of flag OFF. No data migration. Source and installed launcher paths are both supported.
9. Observability: coded refusal and controller structured log; fixture records next counts, generation and attempt counts, before/after source hashes and installation identity.
10. Security: private namespaces, home masking, no external routes, no production credentials, no model dispatch, default flag OFF. Authorization snapshots used for offline fixtures do not claim provider entitlement.

## Files changed

- `bin/linux/aih-auth.sh`
- `bin/linux/aih-complete.sh`
- `bin/linux/aih-context.sh`
- `bin/linux/aih-detect.sh`
- `bin/linux/aih-doctor.sh`
- `bin/linux/aih-key.sh`
- `bin/linux/aih-review.sh`
- `bin/linux/aih-route.sh`
- `bin/linux/aih-rules.sh`
- `bin/linux/aih-stop.sh`
- `bin/linux/aih-task.sh`
- `bin/linux/aih-test-tiers.sh`
- `bin/linux/aih-test.sh`
- `bin/linux/aih-update.sh`
- `bin/linux/aih-verify.sh`
- `bin/linux/aih-visual-review.sh`
- `bin/linux/aih.sh`
- `config/AihController.cjs`
- `config/Controller-RequestBoundary.cjs`
- `config/DeepSeek-Isolation.cjs`
- `config/Engineering-Isolation.cjs`
- `config/Muse-Isolation.cjs`
- `config/registry/session-binding.cjs`
- `scripts/Setup.ps1`
- `scripts/Test-Harness.ps1`
- `setup.sh`
- `tests/AihControllerIdentity.Tests.cjs`
- `tests/ContextCompilerActiveHostV2.Tests.cjs`
- `tests/ContextCompilerActiveOpencodeHostV2.Tests.cjs`
- `tests/ContextCompilerShadowHostV2.Tests.cjs`
- `tests/ContextCompilerShadowV2.Tests.cjs`
- `tests/ControllerSessionBootstrap.Tests.cjs`
- `tests/DeepSeekIsolation.Tests.cjs`
- `tests/MuseIsolation.Tests.cjs`
- `tests/MuseOpenCodeGo.Tests.cjs`
- `tests/MuseRoutingAuthorityOrdering.Tests.cjs`
- `tests/RegistryR631Lockdown.Tests.cjs`
- `tests/RegistryR632Execution.Tests.cjs`
- `tests/RegistryR63Binding.Tests.cjs`
- `tests/RegistryR65Matrix.Tests.cjs`
- `tests/RegistryR70Readiness.Tests.cjs`
- `tests/RegistryR74RollbackRecovery.Tests.cjs`
- `tests/VisualControllerLifecycle.Tests.cjs`
- `tests/lib/AgentRequestComposition.cjs`
- `tests/lib/ContextCompactionProdHarness.cjs`
- `config/Preset-ShellEnvironment.cjs`
- `tests/MixedPresetShellEnv.Tests.cjs`
- `tests/DeepSeekRequestBoundaryHost.Tests.cjs`
- `docs/operations/r75b1a-mixed-preset-shell-environment.md`
- `docs/operations/r75b1b-deepseek-request-boundary.md`

## Completion and next phase

This is readiness for a separate controlled-inference phase on the verified Linux host. It does not authorize paid requests, production credentials access or external provider probes. R7.5B.2 needs its own isolated authentication, approved endpoints/data-use tier and bounded inference budget. Native Windows execution and real provider latency remain unverified here.

A scoped local commit preserves the R7.5B.1a repair and add the R7.5B.1b enforcement/platform correction after required acceptance succeeds. Final SHA, identity verification and clean worktree status are in completion.json and the final chat response. No push or merge occurred; PR #33 remains Draft.
