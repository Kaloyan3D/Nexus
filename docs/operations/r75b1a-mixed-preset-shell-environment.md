> **R7.5B.1b final recheck: READY FOR R7.5B.2 CONTROLLED INFERENCE.** The DeepSeek request-boundary and stale-authority defects are repaired; actual-host security, mixed-preset, Registry, installation and Linux platform acceptance pass. See [the final report](/home/kaloyan/Projects/Nexus/docs/operations/r75b1b-deepseek-request-boundary.md). The blocked status and no-commit statements below describe the earlier candidate and are preserved as historical evidence.

# R7.5B.1a — Mixed-preset shell environment repair and preflight recheck

**BLOCKED — MIXED-PRESET HOST COMPOSITION**

The original shared-key ownership defect is implemented and verified fixed. All requested engine combinations are available in the real DSH host. Release acceptance remains blocked by a separately exposed actual-host DeepSeek Registry request-boundary failure and failing source/release checks listed below. No local commit was created because the requested acceptance condition has not passed. No push, merge, paid inference, production installation update, real credentials access, or production TASK-0052 access occurred.

## Candidate and isolation

Base HEAD: `ffcf79c7d942483e86a4b43fbf6797a1f930fe69`; branch: `feature/model-registry-v1`. Verification covers the working changes listed below, matched byte-for-byte to the private source and installed isolation modules by [candidate-file-identity.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/candidate-file-identity.json). The final regression test adds hostile identity and foreign-owner cases after the initial broad run; its final isolated execution is [final-real-registry.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/final-real-registry.json).

Private source: `/home/kaloyan/Projects/Nexus/tmp/r75b1a/source`; install: `/home/kaloyan/Projects/Nexus/tmp/r75b1a/source/tmp/install`; DSH_HOME/data: `/home/kaloyan/Projects/Nexus/tmp/r75b1a/source/tmp/install/data`; home mounted privately at `/home/kaloyan` from `/home/kaloyan/Projects/Nexus/tmp/r75b1a/home`; workspaces: `/home/kaloyan/Projects/Nexus/tmp/r75b1a/workspaces/{engineering,deepseek,muse}`; evidence: `/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence`. A separate `/home/kaloyan/Projects/Nexus/tmp/r75b1a/source/tmp/audit-install` is used for destructive **fixture-only** installer-preservation checks.

The previously verified private pinned runtime/app dependencies were copied from `tmp/r75b1/source/tmp/install`, not from production data or credentials. Data and logs were freshly reset in this new private fixture. The actual shared `Complete-Install.ps1` stage and `MusePresetDependencyClosure.cjs prepare` for all four profiles ran here. This is reuse of the prior fresh `npm ci` runtime, not a claim that another npm install ran. Manifest, lock, installed dependency/native compatibility and all closures were reverified: [installation-verified.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/installation-verified.json), [complete-install.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/complete-install.json), [dependency-compatibility.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/dependency-compatibility.json), [audit-clean-isolated.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/audit-clean-isolated.json).

Actual CLI: DSH **0.1.1-rc.2**, Node **24.18.1**, PowerShell **7.5.3**. The host's API version is a different generic version contract. Bubblewrap uses private mount/user/PID/network/IPC/UTS/cgroup namespaces, clears the environment, hides the real home, and mounts only task-owned writable data/logs/workspaces/evidence/home. The candidate is read-only during actual host execution. The actual host has no external routes. The outer loopback relay allows inbound HTTP/WebSocket access through a 0600 Unix socket; it does not supply outbound networking to the host.

Last observed actual host PID **34282**, namespace PID **690**, supervisor boot **17**; inner loopback port **43080**, outer relay **127.0.0.1:43081**. These are historical process identifiers after cleanup. Actual process-tree namespace and hidden production-path checks: [actual-host-isolation.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/actual-host-isolation.json). The normal Nexus installation was never stopped, restarted or updated. Registry binding remains unset/OFF.

## Root cause and supported ownership contract

`DeepSeek-Isolation.cjs` registered contributor `aih-deepseek-preset`; `Muse-Isolation.cjs` registered `aih-muse-preset`. Both declared `DSH_AIH_PRESET`. The pinned SDK validates unique contributor names AND unique declared keys **at registration**, before it ever calls per-execution resolvers. Giving contributors identical names would instead fail name uniqueness.

The actual ShellEnv service's `register()` uses Cordis `ctx.effect`: registration acquires name/key ownership synchronously; the calling fiber's disposal releases them. `collect(execution)` starts a new snapshot for each execution, evaluates contributors and returns an immutable overlay. The actual bash and pwsh tools call this consumer API (`dsh-tool-bash/lib/index.js:395`, `dsh-tool-pwsh/lib/index.js:373`). Ambient DSH values are discarded by the shell executor.

DSH agent presets use standing shared mounts, with per-agent scope ancestry; plugin instances are not recreated for every session. Session disposal and preset disposal therefore differ. Cordis event dispatch requires the actual scope carrier; simply invoking `agent.ctx.waterfall(event, ...)` does not filter to the agent's preset. The final diagnostic request probes use the public `scopeTarget(agent, agent)` carrier.

Existing related ownership: SDK built-ins own DSH_HOME/DSH_SHELL/DSH_SESSION_ID; session-persistence owns DSH_SESSION_JSONL; web-runtime owns DSH_WEB_URL. AihController declares DSH_AIH_TASK_ID, DSH_AIH_TASK_INSTANCE_ID, DSH_AIH_EXECUTION_CLASS, DSH_AIH_REVIEW_REQUIRED and workspace/repository/checkout IDs under `aih-controller-task-state`. Multiple controller mounts currently suppress duplicate task-state contributor registration and retain the first contributor; this pre-existing lifecycle/read-cache design was inspected but not redesigned in this narrowly scoped repair. No other contributor declares DSH_AIH_PRESET. The SDK has no shared-key multi-owner exemption; public `list()` plus host-root `register()` is the supported single-owner mechanism used here. Upstream validation is unchanged.

## New shared owner

`config/Preset-ShellEnvironment.cjs` provides a pure session resolver and synchronous acquisition function. Engineering, DeepSeek and Muse isolation plugins all call it. It inspects the public declarations and registers exactly one contributor, `aih-session-preset`, through the **host root's** ShellEnv service. This binds disposal to the host fiber, not the first preset or first session. Installed copies coordinate through the registry inventory rather than module identity, mutable global session state, or a new process-global Cordis service.

Known session values:

| Engine | Actual bash stdout / DSH_AIH_PRESET |
|---|---|
| Engineering | `aih-engineering` |
| DeepSeek | `aih-deepseek` |
| Muse | `aih-muse` |

The newest `agent-preset/selected` event takes precedence over the header. Unknown non-Nexus identities emit no Nexus key; malformed selected identities throw `shell-preset-identity-invalid`. No fallback selects another engine. Workers use their own explicit preset if present, and receive no inherited Nexus preset when absent. No process environment variable is changed or read to choose this value. Existing engine binding/provider/model/reasoning/data-use/Registry routing implementations are unchanged. A foreign owner fails with `shell-preset-owner-conflict`; duplicate SDK ownership still throws normally.

Evidence: [shell-consumer-engineering.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/shell-consumer-engineering.json), [shell-consumer-deepseek.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/shell-consumer-deepseek.json), [shell-consumer-muse.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/shell-consumer-muse.json), [lifecycle-performance.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/lifecycle-performance.json), [actual-sdk-session-disposal.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/actual-sdk-session-disposal.json). The actual tool body executes only a fixed read-only `printf` of the environment in an isolated workspace; no prompt or model is involved.

## Before/after actual host and permanent regression

Before any production fix, `tests/MixedPresetShellEnv.Tests.cjs` failed against the real pinned ShellEnv registry and Cordis fibers with the original duplicate-owner error: [before-registry.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/before-registry.log). A fresh **unmodified candidate host**, using production composition without an overlay, also rejected Muse after DeepSeek with `agent-preset-invalid`: [before-actual-host.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/before-actual-host.json).

After rebuilding the installed presets, the production-composition-only host (no overlay) passed Engineering→DeepSeek→Muse, Muse→DeepSeek→Engineering, DeepSeek→Muse, and Muse→DeepSeek. Each order created two sessions per engine. A later restart resumed **all 20 sessions together**. Evidence: [vanilla-host-matrix.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/vanilla-host-matrix.json), [vanilla-host-matrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/vanilla-host-matrix.log).

The permanent regression is wired into the standard test harness. Eight checks cover those four orders, three standalone engines, repeated mounts, interleaved/concurrent resolution, latest-event identity, malformed/unknown identity, worker identity, preset teardown/recreation, fresh host registries and final host teardown, plus foreign ownership refusal. The SDK uniqueness implementation is never mocked for this regression. Final result: [after-registry.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/after-registry.log), [final-real-registry.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/final-real-registry.log).

A test-owned HTTP observer/driver row was used later to collect actual session environments, invoke the actual read-only bash consumer, prepare controllers, and terminate middleware probes at a no-dispatch sentinel. It changes no production preset rows, registry owner, route handler or SDK validation. Vanilla-host co-presence, rather than that overlay alone, establishes final production ownership correctness. Public SDK handles also released each real agent and session; subsequent actual `session.create` RPC resumed each identity with its correct shell value.

## Repeated preflight gates

| Gate | Result | Evidence |
|---|---|---|
| Pinned isolated installation / all preset closures / native dependencies | PASS | installation-verified.json; dependency-compatibility.log; audit-clean-isolated.log |
| Actual DSH startup, production composition | PASS | vanilla-host-matrix.json; host-boot logs |
| All mixed orders and multiple sessions / persisted co-presence | PASS | vanilla-host-matrix.json |
| Actual session-aware shell consumer / interleaving / disposal | PASS | shell-consumer-*.json; actual-sdk-session-disposal.json; lifecycle-performance.json |
| GUI and Registry API / catalog and three modes | PASS | gui-health.json; api.jsonl; stable-health.json |
| EMv1/EMv2 staging, legacy data unaffected, restart persistence | PASS | staged.json; acceptance.json; acceptance-positive.log |
| EMv3 planned/non-runnable status | PASS | api.jsonl; no fabricated EMv3 configuration or activation |
| Three unique controller task generations, repeated preparation, restart | PASS | prepared-all-engines.json; acceptance.json |
| Engineering/Muse pending-marker and malformed-entry request refusals | PASS | refusals.json (nextCount=0) |
| Corrupt durable bindings: structured controller refusal / no new attempt | PASS | refusals.json; controller logs |
| DeepSeek pending-marker request-boundary recheck after pre-step | **FAIL** | deepseek-request-boundary-gap.json |
| Zero provider dispatch / no inference events / task attempts remain zero | PASS | session-event-counts.json; acceptance.json; deepseek-request-boundary-gap.json |
| Native Windows / Windows PowerShell 5.1 | UNVERIFIED | This Linux host cannot execute those platform lanes. |
| Paid provider entitlement / live inference / R7.5B.2 | UNVERIFIED | Explicitly out of scope, zero budget; no network probes or paid requests. |
| Full unrelated Test-Harness inventory | UNVERIFIED | Affected suites and all Registry CJS suites executed below; unrelated subsystem campaigns were not run. |

## Separate security blocker discovered in the actual composition

With the real DeepSeek preset and controller prepared, a valid no-message step-2 pre-step reached its terminal without starting an attempt. The test then added a generation-correct `registryRefused: registry-pending` marker to the durable binding. The actual scoped `agent/request` waterfall reached the terminal sentinel (`nextCount=1`) instead of a Registry refusal. A further pre-step also reached its terminal because the mounted prepared controller retained its cached legacy binding. After restart with that marker still present, the controller's pre-step rejected (`nextCount=0`). All injected bytes were restored in `finally`; task attempts were unchanged and the sentinel prevented every provider dispatch.

The installed DeepSeek composition mounts DeepSeek-Isolation and AihController, but not Engineering-Isolation. DeepSeek-Isolation's unchanged request handler enforces its historical default provider whitelist/route without using Controller-RequestBoundary or re-reading Registry authority. The changed code only replaces shell registration; no request-routing statement changed. This is a previously masked security gap exposed by correct scoped mixed-host validation, not evidence that the shell owner changed routing. Evidence: [deepseek-request-boundary-gap.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/deepseek-request-boundary-gap.json), [deepseek-boundary-final.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/deepseek-boundary-final.log), installed DeepSeek `agent.cordis.yml` and source `DeepSeek-Isolation.cjs`.

The earlier unscoped overlay invoked handlers from unrelated presets and produced misleading engine-binding errors. Correcting it to use `scopeTarget` exposed this real DeepSeek gap. Existing Registry suites exercise Engineering/Muse boundaries and cannot establish DeepSeek boundary coverage. Fixing request enforcement or controller caching would exceed this task's explicit shell-ownership-only change scope; those production components were not altered. This required gate prevents controlled inference and the acceptance-conditioned local commit.

## Executed regression suites

Exact argv, exit and elapsed values are in [suites.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suites.json); logs use `suite-<name>.log`. Additional commands are in [extra-suites.json](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/extra-suites.json) and the named JSON files below. A suite's exit result is reported even when its assertions mostly passed.

| Suite | Result | Exit | Log |
|---|---|---:|---|
| MixedPresetShellEnv | PASS | 0 | [suite-MixedPresetShellEnv.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MixedPresetShellEnv.log) |
| EngineeringIsolation | PASS | 0 | [suite-EngineeringIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-EngineeringIsolation.log) |
| DeepSeekIsolation | PASS | 0 | [suite-DeepSeekIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-DeepSeekIsolation.log) |
| MuseIsolation | PASS | 0 | [suite-MuseIsolation.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MuseIsolation.log) |
| MuseRoutingAuthorityOrdering | PASS | 0 | [suite-MuseRoutingAuthorityOrdering.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MuseRoutingAuthorityOrdering.log) |
| ComposedRoutingAuthority | PASS | 0 | [suite-ComposedRoutingAuthority.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-ComposedRoutingAuthority.log) |
| ComposedRoutingMatrix | PASS | 0 | [suite-ComposedRoutingMatrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-ComposedRoutingMatrix.log) |
| NexusEngineContract | PASS | 0 | [suite-NexusEngineContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-NexusEngineContract.log) |
| ControllerSessionBootstrap | PASS | 0 | [suite-ControllerSessionBootstrap.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-ControllerSessionBootstrap.log) |
| AihControllerIdentity | PASS | 0 | [suite-AihControllerIdentity.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-AihControllerIdentity.log) |
| AihController | PASS | 0 | [suite-AihController.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-AihController.log) |
| ControllerPresetInstalled | PASS | 0 | [suite-ControllerPresetInstalled.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-ControllerPresetInstalled.log) |
| ControllerPresetCleanInstall | PASS | 0 | [suite-ControllerPresetCleanInstall.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-ControllerPresetCleanInstall.log) |
| MusePresetDependencyClosure | PASS | 0 | [suite-MusePresetDependencyClosure.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MusePresetDependencyClosure.log) |
| MusePresetCleanInstall | PASS | 0 | [suite-MusePresetCleanInstall.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MusePresetCleanInstall.log) |
| MusePresetRegistryModes | PASS | 0 | [suite-MusePresetRegistryModes.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MusePresetRegistryModes.log) |
| MuseOpenCodeGo | PASS | 0 | [suite-MuseOpenCodeGo.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-MuseOpenCodeGo.log) |
| RegistryCore | PASS | 0 | [suite-RegistryCore.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryCore.log) |
| RegistryLegacyBaseline | PASS | 0 | [suite-RegistryLegacyBaseline.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryLegacyBaseline.log) |
| RegistryR2Compatibility | PASS | 0 | [suite-RegistryR2Compatibility.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR2Compatibility.log) |
| RegistryR3Hardening | PASS | 0 | [suite-RegistryR3Hardening.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR3Hardening.log) |
| RegistryR3UI | PASS | 0 | [suite-RegistryR3UI.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR3UI.log) |
| RegistryR4ProbeSecurity | PASS | 0 | [suite-RegistryR4ProbeSecurity.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR4ProbeSecurity.log) |
| RegistryR4Providers | PASS | 0 | [suite-RegistryR4Providers.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR4Providers.log) |
| RegistryR4TransportBinding | PASS | 0 | [suite-RegistryR4TransportBinding.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR4TransportBinding.log) |
| RegistryR511CliContract | PASS | 0 | [suite-RegistryR511CliContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR511CliContract.log) |
| RegistryR51Auth | PASS | 0 | [suite-RegistryR51Auth.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR51Auth.log) |
| RegistryR5Connections | PASS | 0 | [suite-RegistryR5Connections.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR5Connections.log) |
| RegistryR62Shadow | PASS | 0 | [suite-RegistryR62Shadow.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR62Shadow.log) |
| RegistryR63Binding | PASS | 0 | [suite-RegistryR63Binding.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR63Binding.log) |
| RegistryR631Lockdown | PASS | 0 | [suite-RegistryR631Lockdown.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR631Lockdown.log) |
| RegistryR632Execution | PASS | 0 | [suite-RegistryR632Execution.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR632Execution.log) |
| RegistryR65Matrix | FAIL | 1 | [suite-RegistryR65Matrix.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR65Matrix.log) |
| RegistryR70Readiness | PASS | 0 | [suite-RegistryR70Readiness.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR70Readiness.log) |
| RegistryR74RollbackRecovery | PASS | 0 | [suite-RegistryR74RollbackRecovery.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR74RollbackRecovery.log) |
| RegistryR75InstallationAudit | FAIL | 1 | [suite-RegistryR75InstallationAudit.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR75InstallationAudit.log) |
| RegistryInstalledRuntime | PASS | 0 | [suite-RegistryInstalledRuntime.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryInstalledRuntime.log) |
| SourceCompleteness | PASS | 0 | [suite-SourceCompleteness.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-SourceCompleteness.log) |
| PreferredRouteContract | PASS | 0 | [suite-PreferredRouteContract.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-PreferredRouteContract.log) |
| RoutingIntegrity | PASS | 0 | [suite-RoutingIntegrity.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RoutingIntegrity.log) |
| RuntimeRoutingTrace | PASS | 0 | [suite-RuntimeRoutingTrace.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RuntimeRoutingTrace.log) |
| PlatformSupport | FAIL | 1 | [suite-PlatformSupport.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-PlatformSupport.log) |
| RegistryR631StepPin | PASS | 0 | [suite-RegistryR631StepPin.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR631StepPin.log) |
| RegistryR75PrivatePath | PASS | 0 | [suite-RegistryR75PrivatePath.log](/home/kaloyan/Projects/Nexus/tmp/r75b1a/evidence/suite-RegistryR75PrivatePath.log) |

Corrected fixture runs / additional gates:

| Gate | Result | Evidence |
|---|---|---|
| Actual installed controller closure validation | PASS | extra-ControllerPresetInstalled.log |
| Actual installed native dependency compatibility | PASS | extra-RegistryR751DependencyCompatibility.log |
| Controller host platform bridge contracts | PASS | extra-AihControllerHost.log |
| Installer preservation / corruption rollback on separate clean private install | PASS | audit-clean-isolated.log (7 checks) |
| PlatformSupport installed Linux layout | PASS | platform-installed.log |
| Final expanded real-registry regression | PASS | final-real-registry.log (8 checks) |

Source PlatformSupport fails because the unchanged source `bin/linux/aih-update.sh` resolves its parent as `<source>/bin`, then looks for `<source>/bin/scripts/Update.ps1`. The installed Linux layout passes. Only test-owned empty update sources were supplied; no normal installation was updated. This source-layout failure remains visible and was not patched in a shell-environment repair.

RegistryR65Matrix's routing checks pass, but its protected-worktree check rejects the task's `scripts/Setup.ps1` and `scripts/Test-Harness.ps1` modifications. Its old allowlist was not expanded to hide that failure. RegistryR70Readiness and the R7.4 outcomes are recorded in the table rather than inferred from other suites.

The initial RegistryR75InstallationAudit invocation lacked the required explicit install argument and treated its working data directory as an install, failing the legacy Registry asset prerequisite; a second run against already-staged host data failed its fixture's revision-2 prerequisite. It was rerun on a separate clean private audit install and passed clean install, upgrade preservation and corrupt-asset rollback. Those failed diagnostic invocations are retained, not counted as candidate defects or passing runs. The runtime fixture reused the prior pinned npm dependencies; no extra npm install or audit network operation ran.

Other corrected instrumentation attempts: the first shell echo omitted the required tool description; a CJS require of an ESM scope module raced the host loader and failed one diagnostic boot; async setup mistakenly returned a mount value instead of void; one no-message pre-step probe lacked its required AbortSignal. The accepted probes use the actual contracts, and the failed attempts remain in logs. Production source was not changed to accommodate them.

## Architecture review

1. Source of truth: latest selected-preset event, otherwise explicit session header; no ambient environment lookup.
2. Ownership: one host-root ShellEnv contributor owns DSH_AIH_PRESET. Isolation plugins acquire it synchronously through public list/register APIs. No new Cordis service or process-global session state.
3. Dependencies: isolation modules depend on the shared pure environment module; it does not depend on routing or its callers. Closure walker packages each copy; copies coordinate through the actual registry declarations.
4. Boundary: per-execution session in, immutable registry snapshot out. No provider/model/effort changes or persisted authority crossing.
5. Failure: malformed selected identity throws a coded local error; unknown non-Nexus preset emits no Nexus key; foreign ownership fails loudly. No duplicate-owner suppression.
6. Lifecycle: first Nexus isolation mount registers through root context, releasing only with host root. Preset/session disposal cannot remove the owner used by other sessions. Restart rebuilds it. Scope is intentionally host lifetime, not a reference-counted preset lifetime.
7. Tests: real pinned registry + real Cordis fibers, followed by actual host APIs and passive collect observer. No mocked uniqueness acceptance.
8. Compatibility: all three standalone presets acquire same owner; Engineering now explicitly supplies its existing preset name. Workers use only their own explicit identity; no parent fallback. No data migration. Rollback restores prior source and recompiles isolated preset closures.
9. Observability: public registry list exposes exactly one owner; actual collect exposes per-session values. Foreign/malformed errors retain clear codes; before/after outputs retained.
10. Security: registration changes no routing authority. Unknown identities cannot select another engine. Production home is hidden, host network private, credentials inaccessible, flag OFF, zero inference.

## Request-local observations

Actual ShellEnv collection across 30 interleaved snapshots: median **0.497 ms**, range **0.364–2.232 ms**. This includes all contributors and controller binding reads, not only the new pure resolver. Actual warm mode API n=10: median **5.845 ms**, range **4.799–28.250 ms**, including loopback/Unix relay transport. Full system test activity and V8 coverage were present. These are local diagnostic observations, not percentiles, controlled comparisons, provider latency, or inference measurements. The new resolver adds no file I/O, subprocess, network, global session state, or asynchronous work.

## Files changed and completion

- `config/DeepSeek-Isolation.cjs`
- `config/Engineering-Isolation.cjs`
- `config/Muse-Isolation.cjs`
- `scripts/Setup.ps1`
- `scripts/Test-Harness.ps1`
- `setup.sh`
- `tests/DeepSeekIsolation.Tests.cjs`
- `tests/MuseIsolation.Tests.cjs`
- `tests/MuseOpenCodeGo.Tests.cjs`
- `tests/MuseRoutingAuthorityOrdering.Tests.cjs`
- `tests/RegistryR74RollbackRecovery.Tests.cjs`
- `tests/lib/AgentRequestComposition.cjs`
- `config/Preset-ShellEnvironment.cjs`
- `tests/MixedPresetShellEnv.Tests.cjs`
- `docs/operations/r75b1a-mixed-preset-shell-environment.md`

The helper is automatically included by the require-graph closure walker; explicit Linux/Windows setup copy lists were also updated. Request-boundary fixtures only gained the SDK declaration-inventory method. Existing tests now expect the shared owner to emit Engineering as well as Muse/DeepSeek; this follows the requested shared resolver contract, while routing expectations remain unchanged. No uniqueness assertion or authority expectation was weakened.

No candidate commit, push or merge was created. HEAD remains the base SHA above; the worktree contains these reviewable task changes. PR #33 was not modified. Binding stays OFF. The historical `tmp/r75b1/evidence/preflight-report.md` now links this recheck while preserving its original failure evidence. Final process cleanup and exact worktree status are in `tmp/r75b1a/evidence/cleanup.json` and `completion.json`.

Before R7.5B.2: repair DeepSeek's final request authority recheck and cached-binding visibility with a permanent actual-composition regression; resolve the source-platform and protected-worktree gates; repeat the isolated refusal and release checks. The shell-ownership gate itself passes, but controlled inference is not authorized by this report.
