# Registry R6.1 — Controller Authority Mapping (audit, no production change)

Branch: feature/model-registry-v1. Baseline: 0c1ac01. R6.0 preflight committed as f21d9bd.
Status: audit only. No production execution path was modified for this document.

## 1. Where the immutable session configuration is established

Two layers, both controller-owned:

1. Session binding — config/AihController.cjs bindSession (~line 2595). For each
   GUI session it verifies the workspace execution-root identity, selects the
   agent-plane preset (authoritative recovery identity wins; otherwise the live
   session preset), derives and validates the engine (dual|muse), resolves the
   preferred profile through EngineeringProfile.ps1, creates the task, then
   persists an immutable binding record keyed by session.id (in-memory
   bindings plus disk via persistBindings). The record carries sessionId,
   taskInstanceId, taskId, workspace identity, preset, engine, executionClass,
   boundAtUtc, and optional preparationAuthority.
2. Task lifecycle identity — scripts/TaskController.ps1 New-AihTask (line 215).
   Every task carries an immutable taskInstanceId plus boundEngine in
   .ai-harness/state/tasks.json. Routing state files are keyed by
   SHA256(workspace, preset, taskInstanceId) (scripts/Routing.ps1 line 320), so
   a re-resolved generation can never silently share state with its predecessor.
   Assert-AihEngineBinding (Routing.ps1 line 338) refuses any request whose
   engine disagrees with the preset plane or the ledger boundEngine.

## 2. Which component selects each Engineering Mode role

- Routing selects semantics only: Invoke-AihRoutingDecision (Routing.ps1 line 507)
  picks the execution class; the policy maps class to role
  (Get-AihRoleForExecutionClass, line 143). Exactly one engine-dispatch seam
  exists: preset aih-muse enters Invoke-AihMuseRoutingDecision, everything else
  takes the Dual path.
- The active engineering profile binds roles: Resolve-AihProfile (line 106) with
  locked-preset precedence (profileOverrideAllowed:false wins over env and
  settings.yaml). Resolve-AihModelTarget (line 150) is the ONLY place routing
  touches model identity: role -> model -> provider via model-registry.json.
- Muse has no roles: exactly one main agent, resolved once by
  Resolve-AihMuseRoutingTarget (line 397) through Nexus profile (engine: muse)
  -> muse profile -> registry (agentEngines:[muse]) -> settings.yaml provider
  route. No fallback, no reviewer, no overrides (lines 454+ reject them).

## 3. How provider and model IDs reach the runtime

- Dual: the resolved target (Model/ModelId/Provider/Reasoning) is persisted in
  the routing decision/state records; execution consumes the provider through
  the settings.yaml llm-pi-ai.providers transport substrate.
- Muse: config/Muse-Isolation.cjs ENFORCES the controller-produced target at the
  request boundary and never re-resolves it. Per-call reasoning effort comes
  from the Muse Reasoning Governor against task-local state, bounded by the
  profile ceiling validated at resolution time.
- Registry-compiled equivalents already exist without touching production:
  compileModeConfig (config/registry/resolver.cjs line 271) emits canonical
  RuntimeModelBindings; bindingToLegacyTarget (config/registry/dsh-adapter.cjs
  line 85) projects a binding onto the legacy {modelId, model, provider,
  reasoning} target shape with fail-closed errors for unknown providers.

## 4. Approvals, reviewer permissions, solver restrictions

- Solver is writable only under explicit approval: routing throws unless the
  -UserApprovedCodexSolve operator flag is present (Routing.ps1 line 573).
- Reviewer is read-only by construction: Get-AihRoleRequirements marks reviewer
  writable=false (line 194); the reviewer is never exposed to the model as a
  tool (AihController.cjs line 34); independent-review signals (ReviewRequested,
  user-codex, review-findings) are rejected outright on the Muse plane.
- Visual reviewer is an optional logical role (read-only, no tools).

## 5. How active sessions remain pinned

- bindings[session.id] plus controllerSessionKey = SHA256(bindingsPath, session.id)
  (AihController.cjs ~line 2632).
- TASK-0056 stale recovery carries the ORIGINAL bound engine/preset forward and
  never re-resolves from mutable preferences; preparation-authority conflicts
  against prior routing state fail closed (session-prepare-conflict).
- Consequence for R6: a compiled Registry target must be pinned at bind time.
  Re-resolving a running session when catalog data changes is forbidden.

## 6. Legacy profiles, presets, Muse isolation preserved

- aih-deepseek preset is locked: profileOverrideAllowed:false
  (config/routing-policy.json line 81; enforced in Resolve-AihProfile) so
  DeepSeek-only routing can never silently change vendor.
- Preset aliases (normal/engineering->aih-engineering, deepseek->aih-deepseek)
  and legacy tier/class aliases keep old callers working
  (Resolve-AihPreset; ConvertTo-AihExecutionClass).
- Dual-side guard rejects muse-engine profiles on a Dual agent plane and vice
  versa. Muse isolation never re-resolves (see section 3).
- R2 compatibility suite (41 tests) pins that no legacy production file is
  modified; legacy baseline suite (21 tests) pins fail-closed unknown routes.

## 7. Smallest valid insertion point for the Registry compiler

bindSession in config/AihController.cjs, immediately after preset/engine/profile
resolution and around the existing routeTask call (~line 2670):

legacy session configuration -> existing DSH target (unchanged, stays active);
staged Registry configuration -> compileModeConfig -> host-neutral
RuntimeModelBinding -> dsh-adapter bindingToLegacyTarget -> projected DSH
target (shadow: compare only).

Why this point: it is the single place where preset, engine, profile, task
identity, and routing meet; the immutable binding record is created here; both
JS resolver mirrors (config/Engineering-Profiles.cjs, config/Nexus-Profiles.cjs)
and the Registry compiler are importable here without touching PowerShell
productionsemantics. A PowerShell-side mirror inside Invoke-AihRoutingDecision
after Assert-AihEngineBinding is the symmetric second seam, not the first.

Rules for the insertion (carried into R6.2/R6.3): legacy precedence and locked
presets win every disagreement; any mismatch is reported and never silently
alters execution; fail closed on invalid, revoked, missing, or incompatible
routes; never substitute provider or reasoning; no re-resolution of running
sessions; feature flag defaults OFF with explicit rollback.

## 8. Architecture review notes (new boundary)

- Source of truth stays the controller ledger + routing state; the compiled
  Registry target is derived and re-derivable, never a second writer.
- Dependency direction: shadow/binding code depends on stable Registry Core and
  the narrow dsh-adapter; Core never imports DSH specifics.
- Failure semantics: compiler or adapter error keeps the legacy target active
  and surfaces a visible mismatch (shadow) or fails the bind closed (flagged).
- Migration/rollback: flag OFF restores byte-identical legacy behavior; no
  schema change to ledger or routing state in R6.
- Security: snapshots carry credential:// references only; existing secret scans
  (dsh-adapter snapshotHasSecrets, subscription assertNoSecrets) stay in force.
## 9. R6.2 implementation evidence (shipped)

- Module config/registry/shadow-binding.cjs: runShadowComparison(decision,
  {installRoot, dataRoot}) compares the authoritative Route.ps1 record with
  the staged mode config via service.compilePreview plus
  dsh-adapter.bindingToLegacyTarget. Read-only (no writes,verified by an
  empty-dataRoot test) and never throws: every failure is a structured
  diagnostic (shadow-decision-invalid, shadow-preset-unmapped,
  shadow-compile-failed, shadow-projection-failed, shadow-role-unmapped).
  Compared fields: provider, model, reasoning (exact equality, so no
  downgrade can hide), role, engine, reviewer writable vs
  readOnlyEnforced, executionKind (raw-model required; agent-sdk never
  parity-matches a mode role), dataUseTier where both planes record it.
- Wiring: bindSession (config/AihController.cjs) runs the shadow after
  routeTask, attaches diagnostics to the in-memory binding only
  (persistBindings serializes a whitelist, so sessions are untouched), and
  logs a shadow-parity event. Shadow failure cannot interrupt legacy flow.
- Evidence: tests/RegistryR62Shadow.Tests.cjs 9/9 PASS on real -DryRun
  decisions, including dual parity (flash-high-direct/deepseek-v4-flash/high),
  muse parity in isolation (meta-model-api, contributor tier), locked
  aih-deepseek reporting, revoked-connection compile failure with the exact
  connection-auth-required code, Claude subscription-agent route pinned as
  never-parity (compile/projection fail-closed), and determinism.

## 10. R6.3 implementation evidence (shipped, default OFF)

- Module config/registry/session-binding.cjs: isRegistryBindingEnabled reads
  only NEXUS_REGISTRY_BINDING=1 from process env (no UI reference anywhere;
  asserted by test). evaluateRegistryBinding demands shadowOk plus full
  parity plus pinned resolutionId/revision, then mints a generation pin
  (authority, mode, resolution, revision, exact role target, execution
  contract, legacy counterpart values). Optional connection evidence must be
  fresh (5-minute bound) and non-revoked; absent evidence records
  deferred-to-request-time per the R5 request-time revalidation contract.
  verifyPinnedBinding re-checks provider/model/reasoning/role/engine;
  rollbackPinnedBinding flips authority to legacy-rollback with identical
  targets.
- Wiring: new sessions with the flag ON pin or fail closed (exact codes
  registry-binding-mismatch / registry-binding-unavailable); recovery
  carries the pin via authoritative.registryPin (persisted through an
  additive whitelist extension - flag-OFF bindings serialize byte-identical
  shapes, proven by test) and re-verifies instead of re-resolving; rollback
  (flag OFF) keeps enforcing an existing pin until the generation ends while
  new sessions bind pure legacy. Reviewer/solver/approval, engine binding,
  and DeepSeek-lock enforcement stay on the legacy path and are never
  bypassed: the executed decision is always the legacy one.
- Consumer boundary (exact blocker analysis): Route.ps1 and the DSH
  execution substrate expose no target-override input - a registry-only
  target cannot reach the consumer except through the legacy decision
  record. Equality-gating (execute if and only if legacy equals pinned) is
  therefore the safe binding form; direct substitution would need a new
  controller-owned target input plus per-turn re-verification, which is
  deliberately out of R6 scope. Known limitation: a refused bind surfaces
  as a loud pre-step-error and pins nothing, but the turn pipeline's
  pre-existing bind-failure resilience may still complete the session over
  legacy authority on later re-routes; late-turn escalation (reviewer
  findings, failure thresholds) likewise stays legacy-authored. No registry
  target is ever executed off-parity.
- Evidence: tests/RegistryR63Binding.Tests.cjs 10/10 PASS, including real
  bridge turns for OFF byte-identical, ON pinned (cross-checked against the
  JS legacy mirror), rollback legacy-rollback with identical targets, and
  drifted-stage refusal with the exact code in the controller log.

## 11. R6.5 matrix verdicts

- tests/RegistryR65Matrix.Tests.cjs 7/7 PASS: reviewer/solver-approved/deep
  live parity (reviewer read-only on both planes), solver-without-approval
  still throws at Routing.ps1:573, opencode muse parity under staged opencode
  config, corrupt-store and unknown-route fail-closed codes, no credential
  material in diagnostics/pins, protected trees (scripts, data, ui,
  config json/yaml) unmodified.
- Regression battery executed in this task, all PASS: R0-R5 registry suites
  (45+21+41+19+29+16+27+19+14+20+10+3), ComposedRoutingAuthority/Matrix,
  PreferredRouteContract, RoutingIntegrity, RuntimeRoutingTrace,
  MuseRoutingAuthorityOrdering (28), MuseIsolation (20),
  MuseReasoningRuntime (30), MuseReasoningGovernor (52), MuseProvider (33),
  MuseOpenCodeGo (19), MuseOpenCodeSession (29), MuseEgressCleanup (2),
  MusePresetDependencyClosure (11), ControllerPresetCleanInstall (3),
  AihController.Tests, AihControllerIdentity e2e (incl. DoD scenario),
  ControllerSessionBootstrap (32), AihControllerHost (159),
  MuseAgentPlane PS (65), MuseProvider PS (111), MuseOpenCodeGo PS (54),
  Intelligence.Registry PS (65), CCv2 authority sample (35), R6.2 (9),
  R6.3 (10), R6.5 matrix (7).
- BLOCKED by pre-existing environment gaps (verified unrelated to R6:
  missing generated/install artifacts, absent node_modules):
  ControllerPresetInstalled (needs generated
  config/.engineering-preset-closure.json), NexusControllerPanel (needs
  @deepseek-ai/cordis under app/), ControllerRouting.Tests.ps1 (needs
  installed data/.agent-presets), MuseInstall.Tests.ps1 (needs pinned
  runtime/node).
- UNVERIFIED: live Windows PowerShell 5.1 and GUI runs (Linux pwsh 7.5 only
  executed here), live Claude CLI shapes/billing (no CLI in this
  environment), the full CCv2 compaction battery beyond the authority
  sample (outside the R6 change surface), and Windows/GUI paths generally.
- R6 verdicts: R6.2 PASS, R6.3 PASS (flag OFF default, rollback path proven),
  R6.5 PASS with the BLOCKED/UNVERIFIED items above. Claude
  subscription-agent stays non-executable for Engineering Modes per the R6.4
  assessment; its empty engine scope is unchanged.

