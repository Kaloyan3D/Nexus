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
 * Phase M1 (Nexus Profiles): the user-facing PROFILE LIST is classified by
 * the top-level Nexus Profile catalog
 * (<installRoot>/config/nexus-profiles.json). Dual entries keep delegating
 * their role details to this module's Engineering Profile state; Muse
 * entries expose Muse registry metadata only
 * (<installRoot>/config/muse-profiles.json) and are never shaped into Dual
 * role semantics. A missing/invalid catalog degrades to an EMPTY list —
 * the editor never guesses an engine classification.
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

/** Mirrors Nexus-Profiles.cjs SOURCE_KIND_BY_ENGINE (kept in lockstep by tests). */
const NEXUS_SOURCE_KIND_BY_ENGINE = { dual: 'engineering-profile', muse: 'muse-profile' }

function normalizeNexusId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Validate the top-level catalog contract only (same rules as
 * Nexus-Profiles.cjs validateCatalogDocument). Engine-specific registries
 * resolve separately so a missing provider-phase artifact fails closed.
 */
function validateNexusCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return false
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.profiles) || catalog.profiles.length === 0) return false
  const seen = new Set()
  for (const profile of catalog.profiles) {
    if (!profile || typeof profile !== 'object') return false
    const id = normalizeNexusId(profile.id)
    if (id === '' || seen.has(id)) return false
    seen.add(id)
    const engine = normalizeNexusId(profile.engine)
    if (engine !== 'dual' && engine !== 'muse') return false
    const source = profile.source
    if (!source || typeof source !== 'object') return false
    if (source.kind !== NEXUS_SOURCE_KIND_BY_ENGINE[engine]) return false
    if (normalizeNexusId(source.profileId) === '') return false
  }
  return true
}

function museProfileMetadataOf(museDocument, profileId) {
  if (!museDocument || museDocument.schemaVersion !== 1 || !Array.isArray(museDocument.profiles)) return null
  const wanted = normalizeNexusId(profileId)
  for (const profile of museDocument.profiles) {
    if (profile && normalizeNexusId(profile.id) === wanted) return profile
  }
  return null
}

function cloneRoles(roles) {
  return roles && typeof roles === 'object' ? JSON.parse(JSON.stringify(roles)) : null
}

/**
 * Classify the user-facing profile list (Phase M1). The catalog decides the
 * ENGINE; Dual role bindings come from the already-merged Dual registry
 * (built-ins + operator Custom), Muse metadata comes from the Muse registry.
 * An entry whose engine-specific source cannot be resolved (missing Dual
 * registry config or missing Muse registry profile) is SKIPPED — never
 * partially resolved. The operator
 * Custom profile is dynamically classified Dual exactly like the catalog
 * resolver does (never duplicated into the immutable catalog).
 */
function buildNexusProfileEntries(options) {
  const { catalogDocument, museDocument, dualProfiles } = options || {}
  if (!validateNexusCatalog(catalogDocument)) return []
  const dualById = new Map()
  for (const profile of Array.isArray(dualProfiles) ? dualProfiles : []) {
    if (profile && profile.id !== undefined) dualById.set(normalizeNexusId(String(profile.id)), profile)
  }
  const entries = []
  for (const profile of catalogDocument.profiles) {
    const id = normalizeNexusId(profile.id)
    const engine = normalizeNexusId(profile.engine)
    const sourceProfileId = normalizeNexusId(profile.source.profileId)
    const entry = {
      id,
      displayName: typeof profile.displayName === 'string' && profile.displayName !== '' ? profile.displayName : id,
      engine,
      selectable: engine === 'dual' ? profile.selectable !== false : profile.selectable === true,
      runnable: engine === 'dual' ? profile.runnable !== false : profile.runnable === true,
      availability: typeof profile.availability === 'string' && profile.availability !== '' ? profile.availability : null,
      source: { kind: profile.source.kind, profileId: sourceProfileId },
      builtin: profile.builtin === undefined ? true : profile.builtin !== false,
      roles: null,
      muse: null,
    }
    if (engine === 'dual') {
      const dual = dualById.get(sourceProfileId)
      if (!dual) continue
      entry.displayName = typeof profile.displayName === 'string' && profile.displayName !== '' ? profile.displayName : String(dual.displayName || id)
      entry.roles = cloneRoles(dual.roles)
      if (entry.availability === null) entry.availability = 'ready'
    } else {
      // M1.1 parity with the PowerShell resolver: a Muse catalog entry is
      // only user-facing together with its muse-profiles.json source. A
      // missing engine-specific source is unresolved — the entry is skipped,
      // never exposed partially resolved with muse: null.
      const muse = museProfileMetadataOf(museDocument, sourceProfileId)
      if (!muse) continue
      entry.muse = JSON.parse(JSON.stringify(muse))
      if (entry.availability === null) {
        entry.availability = typeof muse.status === 'string' && muse.status !== '' ? muse.status : 'unavailable'
      }
    }
    entries.push(entry)
  }
  if (!entries.some((entry) => entry.id === 'custom')) {
    const custom = dualById.get('custom')
    if (custom) {
      entries.push({
        id: 'custom',
        displayName: String(custom.displayName || 'Custom'),
        engine: 'dual',
        selectable: true,
        runnable: true,
        availability: 'ready',
        source: { kind: 'engineering-profile', profileId: 'custom' },
        builtin: false,
        roles: cloneRoles(custom.roles),
        muse: null,
      })
    }
  }
  return entries
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
  // Phase M2 engine scope: a registry entry MAY declare `agentEngines`.
  // Absence keeps Dual behavior exactly as before (every pre-M2 entry); a
  // declaration that does not list 'dual' excludes the entry from every Dual
  // role dropdown, so a Muse-registry model (agentEngines: ['muse']) can
  // never leak into the Dual role editor. Capability/metadata driven — no
  // model-id conditionals.
  if (Array.isArray(entry.agentEngines) && !entry.agentEngines.includes('dual')) return false
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
    nexusProfilesPath,
    museProfilesPath,
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
  // Phase M1: top-level Nexus Profile classification for the editor list.
  // The catalog decides the engine; Dual details stay in `profiles`/`roles`,
  // Muse details stay in the Muse registry. Missing/invalid → empty list.
  const nexusCatalog = readJson(
    nexusProfilesPath || (installRoot ? path.join(installRoot, 'config', 'nexus-profiles.json') : null),
    readFile
  )
  const museDocument = readJson(
    museProfilesPath || (installRoot ? path.join(installRoot, 'config', 'muse-profiles.json') : null),
    readFile
  )
  const nexusProfiles = buildNexusProfileEntries({
    catalogDocument: nexusCatalog,
    museDocument,
    dualProfiles: profiles ? profiles.profiles : [],
  })
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
    nexusProfiles,
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
  NEXUS_SOURCE_KIND_BY_ENGINE,
  normalizeNexusId,
  parseEngineeringProfile,
  loadProfilesDocument,
  loadRegistryDocument,
  validateNexusCatalog,
  museProfileMetadataOf,
  buildNexusProfileEntries,
  modelResolvedProvider,
  modelCompatibleWithRole,
  compatibleModelsForRole,
  roleBindingTarget,
  bindingsSatisfiable,
  preferredProfileOf,
  buildEngineeringProfileState,
  validateSaveCustomPayload,
}
