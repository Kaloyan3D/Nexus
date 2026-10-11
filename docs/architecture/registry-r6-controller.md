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
