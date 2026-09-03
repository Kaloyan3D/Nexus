'use strict'

/**
 * Engineering-Profiles.cjs — the shared JS configuration layer for the
 * Phase 2 generalized engineering model (Nexus).
 *
 * This module is PURE COMMONJS with no DSH runtime dependencies. It reads the
 * same configuration files the PowerShell controller plane reads:
 *
 *   <installRoot>/config/routing-policy.json       (execution classes + aliases)
 *   <installRoot>/config/engineering-profiles.json (role -> model bindings)
 *   <installRoot>/config/model-registry.json       (model -> provider config)
 *   <installRoot>/data/settings.yaml               (engineering-profile key only)
 *
 * It is used by the preset enforcement plugins (Engineering-Isolation.cjs)
 * and the controller bridge (AihController.cjs) so that profile/model
 * resolution is configuration-driven in BOTH planes. Routing semantics are
 * owned by the deterministic controller (Routing.ps1); this module only
 * resolves configuration — it never makes routing decisions.
 *
 * Contract: MODEL != ROLE != EXECUTION CLASS != PROVIDER.
 * An execution class describes semantics; the active Engineering Profile
 * decides WHICH model fulfills the mapped role; the Model Registry maps the
 * model to a provider configuration identifier. No vendor conditionals.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** Legacy execution-class names -> canonical names (compatibility aliases). */
const LEGACY_CLASS_ALIASES = {
  deepseek_normal: 'engineer_normal',
  deepseek_deep: 'engineer_deep',
  codex_review: 'reviewer',
  codex_solve: 'solver',
}

/** Canonical class -> human display label (generic, vendor-free). */
const CLASS_DISPLAY_NAMES = {
  deterministic: 'Deterministic',
  engineer_normal: 'Engineer Normal',
  engineer_deep: 'Engineer Deep',
  reviewer: 'Independent Review',
  solver: 'Solve',
}

/** Canonical class -> logical role (mirrors routing-policy executionClasses). */
const CLASS_ROLES = {
  deterministic: null,
  engineer_normal: 'primaryEngineer',
  engineer_deep: 'deepEngineer',
  reviewer: 'reviewer',
  solver: 'solver',
}

function findInstallRoot(startDir) {
  let current = path.resolve(startDir)
  for (;;) {
    if (
      fs.existsSync(path.join(current, 'config', 'routing-policy.json')) &&
      fs.existsSync(path.join(current, 'scripts', 'Common.ps1'))
    ) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function installRootOf() {
  // Phase 3.2.5: the LIVE runtime data root (DSH_HOME) owns install-root
  // identity, exactly like the controller bridge. AIH_INSTALL_ROOT remains
  // the fallback for tooling that runs without the DSH runtime. When both
  // are present they are set consistently by the aih entrypoints; when they
  // disagree (isolated fixtures, relocated data roots), the DSH runtime root
  // must win so enforcement reads the SAME data plane the controller writes.
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    return path.dirname(path.resolve(process.env.DSH_HOME))
  }
  if (typeof process.env.AIH_INSTALL_ROOT === 'string' && process.env.AIH_INSTALL_ROOT !== '') {
    return path.resolve(process.env.AIH_INSTALL_ROOT)
  }
  const discovered = findInstallRoot(__dirname)
  if (discovered) return discovered
  throw new Error('Nexus install root is unavailable; launch through the repo-local aih entrypoint.')
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function canonicalExecutionClass(value) {
  if (typeof value !== 'string' || value === '') return value
  const key = value.trim().toLowerCase()
  return LEGACY_CLASS_ALIASES[key] || key
}

function classDisplayName(value) {
  const canonical = canonicalExecutionClass(value)
  return CLASS_DISPLAY_NAMES[canonical] || canonical
}

function roleOfExecutionClass(value) {
  const canonical = canonicalExecutionClass(value)
  return CLASS_ROLES[canonical] || null
}

function loadPolicy(installRoot) {
  return readJson(path.join(installRoot, 'config', 'routing-policy.json'))
}

function loadProfiles(installRoot) {
  let document = readJson(path.join(installRoot, 'config', 'engineering-profiles.json'))
  if (!document) return document
  // Phase 2.1: the operator-defined CUSTOM profile lives next to the
  // built-in registry as data/custom-engineering-profile.json. It is merged
  // as id 'custom' so every resolver (bridge + enforcement) sees it without
  // code changes. Built-in registry files are never mutated.
  const customPath = path.join(installRoot, 'data', 'custom-engineering-profile.json')
  const custom = readJson(customPath)
  if (custom && custom.schemaVersion === 1 && custom.roles && typeof custom.roles === 'object') {
    const profiles = Array.isArray(document.profiles) ? document.profiles.slice() : []
    profiles.push({
      id: 'custom',
      displayName: 'Custom',
      description: 'Operator-defined engineering profile (Phase 2.1 editor).',
      roles: custom.roles,
    })
    document = { ...document, profiles }
  }
  return document
}

function loadRegistry(installRoot) {
  return readJson(path.join(installRoot, 'config', 'model-registry.json'))
}

function profileById(profiles, id) {
  if (!profiles || !Array.isArray(profiles.profiles)) return null
  for (const profile of profiles.profiles) {
    if (profile && String(profile.id) === id) return profile
  }
  return null
}

/** Read the `engineering-profile:` key from data/settings.yaml, or null. */
function settingsEngineeringProfile(installRoot) {
  try {
    const text = fs.readFileSync(path.join(installRoot, 'data', 'settings.yaml'), 'utf8')
    const match = /^engineering-profile:\s*([^\s#\r\n]+)/m.exec(text)
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    /* settings missing/corrupt: profile falls back to preset/default */
  }
  return null
}

/**
 * Resolve the ACTIVE engineering profile.
 * Priority: DSH_AIH_PROFILE env -> AIH_ACTIVE_PROFILE env -> settings.yaml
 * `engineering-profile:` -> preset profile binding -> policy defaultProfile.
 * A preset with profileOverrideAllowed:false (DeepSeek-only) is locked to its
 * own binding. Returns { id, displayName, config } or null when the profile
 * layer is unavailable (callers fail closed).
 */
function resolveActiveProfile(installRoot, presetId) {
  const policy = loadPolicy(installRoot)
  const profiles = loadProfiles(installRoot)
  if (!policy || !profiles) return null
  const preset = policy.presets && typeof policy.presets === 'object' && presetId
    ? policy.presets[presetId]
    : null
  const overrideAllowed = !preset || preset.profileOverrideAllowed !== false
  let requested = null
  if (overrideAllowed) {
    if (process.env.DSH_AIH_PROFILE) requested = process.env.DSH_AIH_PROFILE
    else if (process.env.AIH_ACTIVE_PROFILE) requested = process.env.AIH_ACTIVE_PROFILE
    else requested = settingsEngineeringProfile(installRoot)
  }
  if (!requested && preset && typeof preset.profile === 'string') requested = preset.profile
  if (!requested && typeof policy.defaultProfile === 'string') requested = policy.defaultProfile
  if (!requested) return null
  const profile = profileById(profiles, String(requested).trim().toLowerCase())
  if (!profile) return null
  return {
    id: String(profile.id),
    displayName: String(profile.displayName || profile.id),
    config: profile,
  }
}

// ── Phase 2.1: role capability contract (mirrors Routing.ps1) ──────────
// A model may be assigned to a role only when the registry entry supports the
// capabilities that role needs. The UI filters on these rules; the controller
// re-validates on every save (fail closed, atomic, never partial).

const ROLE_REQUIREMENTS = {
  primaryEngineer: { writable: true, requiresTools: true, requiresSolLocal: false, requiresReasoning: true, requiresVision: false },
  deepEngineer: { writable: true, requiresTools: true, requiresSolLocal: false, requiresReasoning: true, requiresVision: false },
  fallback: { writable: true, requiresTools: true, requiresSolLocal: false, requiresReasoning: true, requiresVision: false },
  reviewer: { writable: false, requiresTools: false, requiresSolLocal: true, requiresReasoning: true, requiresVision: false },
  solver: { writable: true, requiresTools: false, requiresSolLocal: false, requiresReasoning: true, requiresVision: false },
  // Phase V0/V1: OPTIONAL visual-review role (orthogonal verification
  // capability, never an execution class). Requires explicit vision support;
  // absence from a profile is valid everywhere bindings are checked.
  visualReviewer: { writable: false, requiresTools: false, requiresSolLocal: false, requiresReasoning: true, requiresVision: true },
}

/** Core roles every profile MUST bind (profile satisfiability contract). */
const CORE_ROLES = ['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback']

/** Optional roles: validated only when a profile declares them. */
const OPTIONAL_ROLES = ['visualReviewer']

function roleRequirementsOf(role) {
  return ROLE_REQUIREMENTS[String(role || '')] || null
}

function modelResolvedProvider(entry, reasoning) {
  if (!entry) return null
  const providers = entry.providers && typeof entry.providers === 'object' ? entry.providers : null
  if (providers) {
    if (reasoning && providers[reasoning]) return String(providers[reasoning])
    if (providers.default) return String(providers.default)
  }
  if (typeof entry.provider === 'string' && entry.provider !== '') return entry.provider
  return null
}

function modelCompatibleWithRole(entry, role, reasoning) {
  if (!entry) return false
  if (entry.enabled === false) return false
  const req = roleRequirementsOf(role)
  if (!req) return false
  if (req.requiresReasoning && entry.supportsReasoning === false) return false
  if (req.requiresTools && entry.supportsTools === false) return false
  // A vision role fails closed unless the registry entry EXPLICITLY declares
  // supportsVision=true — a missing capability declaration is never treated
  // as vision-capable.
  if (req.requiresVision && entry.supportsVision !== true) return false
  if (req.requiresSolLocal && modelResolvedProvider(entry, reasoning) !== 'sol-local') return false
  if (reasoning) {
    const levels = Array.isArray(entry.supportedReasoningLevels) ? entry.supportedReasoningLevels : []
    if (!levels.includes(reasoning)) return false
    if (!modelResolvedProvider(entry, reasoning)) return false
  }
  return true
}

function compatibleModelsForRole(registry, role, reasoning) {
  const ids = []
  for (const entry of (registry && Array.isArray(registry.models) ? registry.models : [])) {
    if (modelCompatibleWithRole(entry, role, reasoning)) ids.push(String(entry.id))
  }
  return ids
}

/**
 * Non-throwing role binding target through the registry: returns
 * { modelId, model, modelDisplayName, vendor, provider, reasoning } or null
 * when the binding cannot be satisfied (unknown/disabled/incompatible model
 * or unsupported reasoning).
 */
function roleBindingTarget(registry, profile, role, reasoningOverride) {
  if (!registry || !profile || !profile.roles || !profile.roles[role]) return null
  const binding = profile.roles[role]
  const modelId = String(binding.model || '')
  if (!modelId) return null
  const reasoning = typeof reasoningOverride === 'string' && reasoningOverride !== '' ? reasoningOverride : String(binding.reasoning || '')
  let entry = null
  for (const candidate of registry.models || []) {
    if (candidate && String(candidate.id) === modelId) { entry = candidate; break }
  }
  if (!entry || !modelCompatibleWithRole(entry, role, reasoning)) return null
  const provider = modelResolvedProvider(entry, reasoning)
  if (!provider) return null
  return {
    modelId,
    model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : modelId,
    modelDisplayName: typeof entry.displayName === 'string' ? entry.displayName : modelId,
    vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
    provider: String(provider),
    reasoning,
  }
}

function bindingsSatisfiable(registry, profile) {
  // Only CORE roles are mandatory; OPTIONAL_ROLES (visualReviewer) never
  // invalidate a legacy/custom profile by their absence.
  for (const role of CORE_ROLES) {
    if (!roleBindingTarget(registry, profile, role)) return false
  }
  return true
}

/**
 * Resolve provider/model/reasoning for one role through the profile + model
 * registry. Returns { modelId, model, modelDisplayName, vendor, provider,
 * reasoning } or null when unresolvable. This is the only JS place where
 * model identity is computed from configuration; no vendor conditionals.
 */
function resolveTarget(installRoot, profileId, role) {
  const profiles = loadProfiles(installRoot)
  const registry = loadRegistry(installRoot)
  if (!profiles || !registry) return null
  const profile = profileById(profiles, String(profileId || ''))
  if (!profile || !profile.roles || !profile.roles[role]) return null
  const binding = profile.roles[role]
  const modelId = String(binding.model || '')
  const reasoning = String(binding.reasoning || '')
  if (!modelId) return null
  let entry = null
  for (const candidate of registry.models || []) {
    if (candidate && String(candidate.id) === modelId) { entry = candidate; break }
  }
  if (!entry || entry.enabled === false) return null
  const providers = entry.providers && typeof entry.providers === 'object' ? entry.providers : {}
  const provider = providers[reasoning] || providers.default || (typeof entry.provider === 'string' ? entry.provider : null)
  if (!provider) return null
  return {
    modelId,
    model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : modelId,
    modelDisplayName: typeof entry.displayName === 'string' ? entry.displayName : modelId,
    vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
    provider: String(provider),
    reasoning,
  }
}

/**
 * Mirrors Routing.ps1 Get-AihRoutingStatePath for one binding.
 * TASK-0005 Part 17: for a binding that carries an immutable taskInstanceId
 * the state file is keyed by normalized workspace + preset + taskInstanceId
 * (the SAME composition the PowerShell plane uses), so stale routing state
 * from an older lifecycle generation of the same display id can never select
 * the root executor. Legacy bindings (no instance) keep the explicit
 * workspace+taskId compatibility key.
 */
function routingStatePath(installRoot, binding) {
  try {
    const workspace = path.resolve(String((binding && binding.workspace) || '')).toLowerCase()
    const preset = String((binding && binding.preset) || 'aih-engineering').toLowerCase()
    const instance = binding && typeof binding.taskInstanceId === 'string' && binding.taskInstanceId !== ''
      ? binding.taskInstanceId
      : null
    const identity = instance || String((binding && binding.taskId) || '')
    const key = workspace + '\n' + preset + '\n' + identity
    const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex')
    return path.join(installRoot, 'data', 'routing', 'states', hash + '.json')
  } catch {
    return null
  }
}

/** The persisted LIVE execution class for a binding (state wins over binding
 *  copy: the routing state file is written on every decision, while the
 *  in-memory binding is only persisted at session teardown). */
function liveExecutionClassOf(installRoot, binding) {
  const statePath = routingStatePath(installRoot, binding)
  const state = statePath ? readJson(statePath) : null
  if (state && typeof state.executionClass === 'string' && state.executionClass !== '') {
    return state.executionClass
  }
  if (binding && typeof binding.executionClass === 'string' && binding.executionClass !== '') {
    return binding.executionClass
  }
  return null
}

/**
 * Phase 3.2.5: the CURRENT STEP role for a binding, when the deterministic
 * step router mirrored one into the routing state. Only the two engineering
 * roles are honored - the reviewer (and any other class) is NEVER selected
 * through this mechanism. Returns null when no valid step role exists.
 */
function liveStepRoleOf(installRoot, binding) {
  const statePath = routingStatePath(installRoot, binding)
  const state = statePath ? readJson(statePath) : null
  if (!state || typeof state.stepRole !== 'string') return null
  const stepRole = state.stepRole
  return stepRole === 'engineer_normal' || stepRole === 'engineer_deep' ? stepRole : null
}

module.exports = {
  LEGACY_CLASS_ALIASES,
  CLASS_DISPLAY_NAMES,
  CLASS_ROLES,
  installRootOf,
  canonicalExecutionClass,
  classDisplayName,
  roleOfExecutionClass,
  loadPolicy,
  loadProfiles,
  loadRegistry,
  ROLE_REQUIREMENTS,
  CORE_ROLES,
  OPTIONAL_ROLES,
  roleRequirementsOf,
  modelResolvedProvider,
  modelCompatibleWithRole,
  compatibleModelsForRole,
  roleBindingTarget,
  bindingsSatisfiable,
  profileById,
  settingsEngineeringProfile,
  resolveActiveProfile,
  resolveTarget,
  routingStatePath,
  liveExecutionClassOf,
  liveStepRoleOf,
}
