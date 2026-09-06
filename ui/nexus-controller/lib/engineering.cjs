'use strict'

/**
 * engineering.cjs — pure editor-state adapter for the Phase 2.1 Engineering
 * Profile editor (Nexus Control Room).
 *
 * READ-ONLY configuration adapter: it assembles the editor state from the
 * same authoritative files the PowerShell controller plane reads:
 *
 *   <dataRoot>/settings.yaml                          (engineering-profile key)
 *   <installRoot>/config/engineering-profiles.json    (built-in profiles)
 *   <installRoot>/config/model-registry.json          (model capabilities)
 *   <dataRoot>/custom-engineering-profile.json        (operator custom profile)
 *
 * The browser NEVER edits config files or ledgers directly. Every write for
 * the editor goes through the validated controller boundary
 * (scripts/EngineeringProfile.ps1 via the host POST route); this module only
 * mirrors the controller's capability rules so the UI can filter dropdowns
 * and the host can fail fast on obviously invalid payloads. The controller
 * re-validates authoritatively on every save.
 */

const path = require('node:path')

/** Mirrors Routing.ps1 Get-AihRoleRequirements (kept in lockstep by tests). */
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
const ROLES = ['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback']

/** Optional roles: exposed to the editor, validated only when declared. */
const OPTIONAL_ROLES = ['visualReviewer']

function defaultReadFile(filePath) {
  return require('node:fs').readFileSync(filePath, 'utf8')
}

function readJson(filePath, readFile) {
  if (!filePath) return null
  try {
    const text = readFile(filePath)
    return text.trim() === '' ? null : JSON.parse(text)
  } catch {
    return null
  }
}

function readJsonSafeText(filePath, readFile) {
  try {
    return readFile(filePath)
  } catch {
    return null
  }
}

/** Parse the settings.yaml engineering-profile key. */
function parseEngineeringProfile(settingsText) {
  if (typeof settingsText !== 'string' || settingsText === '') return null
  const match = /^engineering-profile:\s*([^\s#\r\n]+)/m.exec(settingsText)
  if (!match) return null
  const id = match[1].replace(/^['"]|['"]$/g, '').trim()
  return id === '' ? null : id
}

/** Load built-in profiles, merging the operator custom profile when present. */
function loadProfilesDocument(profilesPath, customProfilePath, readFile) {
  const document = readJson(profilesPath, readFile)
  if (!document || !Array.isArray(document.profiles)) return null
  const profiles = document.profiles.slice()
  if (customProfilePath) {
    const custom = readJson(customProfilePath, readFile)
    if (custom && custom.schemaVersion === 1 && custom.roles && typeof custom.roles === 'object') {
      profiles.push({
        id: 'custom',
        displayName: 'Custom',
        description: 'Operator-defined engineering profile (Phase 2.1 editor).',
        roles: custom.roles,
        builtin: false,
      })
    }
  }
  for (const profile of profiles) {
    if (profile && typeof profile === 'object' && profile.builtin === undefined) profile.builtin = true
  }
  return { ...document, profiles }
}

function loadRegistryDocument(registryPath, readFile) {
  return readJson(registryPath, readFile)
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
  const req = ROLE_REQUIREMENTS[role]
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
  for (const entry of registry && Array.isArray(registry.models) ? registry.models : []) {
    if (modelCompatibleWithRole(entry, role, reasoning)) ids.push(String(entry.id))
  }
  return ids
}

/** Role binding -> { modelId, provider, reasoning } when satisfiable. */
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
  return { modelId, provider, reasoning }
}

function bindingsSatisfiable(registry, profile) {
  for (const role of ROLES) {
    if (!roleBindingTarget(registry, profile, role)) return false
  }
  return true
}

/** Preferred profile (settings key) with displayName from profiles/custom. */
function preferredProfileOf(settingsText, profilesDocument, readFile) {
  const profileId = parseEngineeringProfile(settingsText)
  if (!profileId) return null
  let displayName = profileId
  if (profilesDocument && Array.isArray(profilesDocument.profiles)) {
    for (const profile of profilesDocument.profiles) {
      if (profile && String(profile.id) === profileId) {
        displayName = String(profile.displayName || profileId)
        break
      }
    }
  }
  return { id: profileId, displayName }
}

/**
 * Build the complete editor state. All reads are optional: when any
 * authoritative file is missing the state is assembled from what exists and
 * the UI degrades gracefully (never guesses model/provider identities).
 */
function buildEngineeringProfileState(options) {
  const {
    installRoot,
    dataRoot,
    settingsPath,
    profilesPath,
    registryPath,
    customProfilePath,
    readFile = defaultReadFile,
    nowUtc = () => new Date().toISOString(),
  } = options || {}
  const settingsText = readJsonSafeText(settingsPath || (dataRoot ? path.join(dataRoot, 'settings.yaml') : null), readFile)
  const profiles = loadProfilesDocument(
    profilesPath || (installRoot ? path.join(installRoot, 'config', 'engineering-profiles.json') : null),
    customProfilePath || (dataRoot ? path.join(dataRoot, 'custom-engineering-profile.json') : null),
    readFile
  )
  const registry = loadRegistryDocument(
    registryPath || (installRoot ? path.join(installRoot, 'config', 'model-registry.json') : null),
    readFile
  )
  const roleRequirements = {}
  const roleModels = {}
  for (const role of ROLES.concat(OPTIONAL_ROLES)) {
    roleRequirements[role] = ROLE_REQUIREMENTS[role]
    roleModels[role] = compatibleModelsForRole(registry, role)
  }
  let customRoles = null
  if (customProfilePath || (dataRoot && profiles)) {
    const customDoc = readJson(
      customProfilePath || (dataRoot ? path.join(dataRoot, 'custom-engineering-profile.json') : null),
      readFile
    )
    if (customDoc && customDoc.schemaVersion === 1 && customDoc.roles) customRoles = customDoc.roles
  }
  return {
    schemaVersion: 1,
    generatedAtUtc: nowUtc(),
    profiles: profiles ? profiles.profiles : [],
    registry: registry ? registry.models : [],
    preferredProfile: settingsText ? preferredProfileOf(settingsText, profiles, readFile) : null,
    customRoles,
    roleRequirements,
    roleModels,
    roles: ROLES,
  }
}

/** Fail-fast host-side validation for a save-custom payload (controller is
 *  still the authority; this only prevents obviously malformed round-trips).
 *  Core roles are mandatory; OPTIONAL_ROLES are validated only when the
 *  payload actually declares them (backward compatibility, Phase V0/V1). */
function validateSaveCustomPayload(roles, registry) {
  if (!roles || typeof roles !== 'object') return 'save-custom requires a roles object'
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(roles, role) || roles[role] == null) return 'missing role binding: ' + role
  }
  const declared = ROLES.concat(OPTIONAL_ROLES.filter((role) => Object.prototype.hasOwnProperty.call(roles, role) && roles[role] != null))
  for (const role of declared) {
    const binding = roles[role]
    if (typeof binding !== 'object') return 'missing role binding: ' + role
    if (typeof binding.model !== 'string' || binding.model === '') return 'role ' + role + ' has no model'
    if (typeof binding.reasoning !== 'string' || binding.reasoning === '') return 'role ' + role + ' has no reasoning level'
  }
  return null
}

module.exports = {
  ROLE_REQUIREMENTS,
  ROLES,
  OPTIONAL_ROLES,
  parseEngineeringProfile,
  loadProfilesDocument,
  loadRegistryDocument,
  modelResolvedProvider,
  modelCompatibleWithRole,
  compatibleModelsForRole,
  roleBindingTarget,
  bindingsSatisfiable,
  preferredProfileOf,
  buildEngineeringProfileState,
  validateSaveCustomPayload,
}
