'use strict'

/**
 * Nexus-Profiles.cjs — top-level user-facing profile -> agent-engine resolver.
 *
 * Phase M1 introduces the architectural boundary only:
 *
 *   Engineering mode
 *        -> Nexus profile
 *             -> engine: dual | muse
 *
 * Existing role-based Engineering Profiles remain the sole source of truth
 * for the Dual engine. Muse has its own registry and is intentionally not
 * coerced into primary/deep/reviewer/solver/fallback role semantics.
 *
 * Muse is foundation-only in M1. The resolver can identify it, but the
 * catalog marks it non-selectable/non-runnable until provider transport and
 * the Muse execution path land in later phases.
 */

const fs = require('node:fs')
const path = require('node:path')
const engineering = require('./Engineering-Profiles.cjs')

const SUPPORTED_ENGINES = new Set(['dual', 'muse'])
const SOURCE_KIND_BY_ENGINE = Object.freeze({
  dual: 'engineering-profile',
  muse: 'muse-profile',
})

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function catalogPathOf(installRoot) {
  return path.join(installRoot, 'config', 'nexus-profiles.json')
}

function museProfilesPathOf(installRoot) {
  return path.join(installRoot, 'config', 'muse-profiles.json')
}

function modelRegistryPathOf(installRoot) {
  return path.join(installRoot, 'config', 'model-registry.json')
}

function loadNexusProfileCatalog(installRoot) {
  return readJson(catalogPathOf(installRoot))
}

function loadModelRegistry(installRoot) {
  const document = readJson(modelRegistryPathOf(installRoot))
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.models)) return null
  return document
}

function loadMuseProfiles(installRoot) {
  return readJson(museProfilesPathOf(installRoot))
}

function museProfileById(document, id) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.profiles)) return null
  const wanted = normalizeId(id)
  if (!wanted) return null
  for (const profile of document.profiles) {
    if (profile && normalizeId(profile.id) === wanted) return profile
  }
  return null
}

/**
 * Validate only the top-level catalog contract. Engine-specific registries
 * are resolved separately so a missing provider-phase artifact fails closed
 * at resolution rather than silently changing engines.
 */
function validateCatalogDocument(document) {
  const errors = []
  if (!document || typeof document !== 'object') return ['catalog-unavailable']
  if (document.schemaVersion !== 1) errors.push('unsupported-schema-version')
  if (!Array.isArray(document.profiles)) return errors.concat('profiles-must-be-array')

  const seen = new Set()
  for (let index = 0; index < document.profiles.length; index += 1) {
    const profile = document.profiles[index]
    const prefix = 'profiles[' + index + ']'
    if (!profile || typeof profile !== 'object') {
      errors.push(prefix + ':invalid-profile')
      continue
    }
    const id = normalizeId(profile.id)
    if (!id) errors.push(prefix + ':missing-id')
    else if (seen.has(id)) errors.push(prefix + ':duplicate-id:' + id)
    else seen.add(id)

    const engine = normalizeId(profile.engine)
    if (!SUPPORTED_ENGINES.has(engine)) {
      errors.push(prefix + ':unsupported-engine:' + engine)
      continue
    }
    const source = profile.source
    if (!source || typeof source !== 'object') {
      errors.push(prefix + ':missing-source')
      continue
    }
    const expectedKind = SOURCE_KIND_BY_ENGINE[engine]
    if (source.kind !== expectedKind) errors.push(prefix + ':source-kind-mismatch')
    if (!normalizeId(source.profileId)) errors.push(prefix + ':missing-source-profile-id')
  }
  return errors
}

function dynamicCustomProfile(engineeringProfiles) {
  const custom = engineering.profileById(engineeringProfiles, 'custom')
  if (!custom) return null
  return {
    id: 'custom',
    displayName: String(custom.displayName || 'Custom'),
    engine: 'dual',
    source: { kind: 'engineering-profile', profileId: 'custom' },
    selectable: true,
    runnable: true,
    builtin: false,
  }
}

/**
 * Return user-facing catalog entries. A valid operator Custom profile is
 * dynamically classified as Dual instead of being duplicated into the
 * immutable top-level catalog.
 */
function listNexusProfiles(installRoot) {
  const catalog = loadNexusProfileCatalog(installRoot)
  if (validateCatalogDocument(catalog).length > 0) return []
  const entries = catalog.profiles.map((profile) => ({ ...profile, id: normalizeId(profile.id), engine: normalizeId(profile.engine) }))
  const engineeringProfiles = engineering.loadProfiles(installRoot)
  const hasCustomEntry = entries.some((profile) => profile.id === 'custom')
  if (!hasCustomEntry) {
    const custom = dynamicCustomProfile(engineeringProfiles)
    if (custom) entries.push(custom)
  }
  return entries
}

/** Resolve one catalog entry to its engine-specific configuration. */
function resolveNexusProfile(installRoot, profileId) {
  const id = normalizeId(profileId)
  if (!id) return null
  const catalogEntries = listNexusProfiles(installRoot)
  const entry = catalogEntries.find((candidate) => candidate && candidate.id === id)
  if (!entry) return null

  if (entry.engine === 'dual') {
    const profiles = engineering.loadProfiles(installRoot)
    const sourceId = normalizeId(entry.source && entry.source.profileId)
    const config = engineering.profileById(profiles, sourceId)
    if (!config) return null
    return {
      id,
      displayName: String(entry.displayName || config.displayName || id),
      engine: 'dual',
      selectable: entry.selectable !== false,
      runnable: entry.runnable !== false,
      availability: entry.availability || 'ready',
      source: { ...entry.source, profileId: sourceId },
      config,
      catalog: entry,
    }
  }

  if (entry.engine === 'muse') {
    const profiles = loadMuseProfiles(installRoot)
    const sourceId = normalizeId(entry.source && entry.source.profileId)
    const config = museProfileById(profiles, sourceId)
    if (!config) return null
    return {
      id,
      displayName: String(entry.displayName || config.displayName || id),
      engine: 'muse',
      selectable: entry.selectable === true,
      runnable: entry.runnable === true,
      availability: entry.availability || config.status || 'unavailable',
      source: { ...entry.source, profileId: sourceId },
      config,
      catalog: entry,
    }
  }

  return null
}

/**
 * Resolve the preferred profile id using the EXISTING precedence contract:
 *
 * 1. DSH_AIH_PROFILE
 * 2. AIH_ACTIVE_PROFILE
 * 3. data/settings.yaml engineering-profile
 * 4. preset profile binding
 * 5. policy defaultProfile
 *
 * A preset with profileOverrideAllowed:false stays locked to its own profile.
 */
function requestedProfileId(installRoot, presetId) {
  const policy = engineering.loadPolicy(installRoot)
  if (!policy) return null
  const preset = policy.presets && typeof policy.presets === 'object' && presetId
    ? policy.presets[presetId]
    : null
  const overrideAllowed = !preset || preset.profileOverrideAllowed !== false

  let requested = null
  if (overrideAllowed) {
    if (process.env.DSH_AIH_PROFILE) requested = process.env.DSH_AIH_PROFILE
    else if (process.env.AIH_ACTIVE_PROFILE) requested = process.env.AIH_ACTIVE_PROFILE
    else requested = engineering.settingsEngineeringProfile(installRoot)
  }
  if (!requested && preset && typeof preset.profile === 'string') requested = preset.profile
  if (!requested && typeof policy.defaultProfile === 'string') requested = policy.defaultProfile
  return normalizeId(requested) || null
}

function resolveActiveNexusProfile(installRoot, presetId) {
  const requested = requestedProfileId(installRoot, presetId)
  if (!requested) return null
  // Intentionally no fallback: an unknown or not-yet-runnable profile is
  // visible as such to callers and must never silently become a Dual profile.
  return resolveNexusProfile(installRoot, requested)
}

function profileEngineOf(installRoot, profileId) {
  const resolved = resolveNexusProfile(installRoot, profileId)
  return resolved ? resolved.engine : null
}

// ── Phase M2: Muse profile → model registry → provider resolution ────────
//
// The Muse plane resolves its transport the same way the Dual plane does:
// the profile names a MODEL REGISTRY id (never a provider id), and the
// registry maps the model to a settings.yaml llm-pi-ai.providers route.
// RESOLUTION ONLY — this never dispatches execution and the Muse profile
// stays selectable=false / runnable=false until the Muse agent plane lands.

/** The muse model binding of a profile document entry, or null. */
function museModelBindingOf(museProfile) {
  if (!museProfile || !museProfile.model || typeof museProfile.model !== 'object') return null
  const primary = String(museProfile.model.primary || '').trim()
  return primary === '' ? null : primary
}

/**
 * Resolve a Muse profile's model binding through the registry. Returns
 * { modelId, model, modelDisplayName, vendor, provider, reasoning,
 *   dataUseTier } or null when the chain cannot be satisfied (missing
 * binding, unknown/disabled model, model not scoped to the muse engine, or
 * unsupported reasoning level). Callers fail closed.
 */
function resolveMuseProfileModel(installRoot, profileId, reasoningOverride) {
  const museDocument = loadMuseProfiles(installRoot)
  const registry = loadModelRegistry(installRoot)
  if (!museDocument || !registry) return null
  const sourceId = normalizeId(profileId)
  if (!sourceId) return null
  const museProfile = museProfileById(museDocument, sourceId)
  if (!museProfile) return null
  const modelId = museModelBindingOf(museProfile)
  if (!modelId) return null
  let entry = null
  for (const candidate of registry.models || []) {
    if (candidate && String(candidate.id) === modelId) { entry = candidate; break }
  }
  if (!entry || entry.enabled === false) return null
  // Phase M2.1 defense in depth: the binding may only resolve to a model
  // EXPLICITLY scoped to the muse engine (the shared asymmetric engine
  // contract from Engineering-Profiles.cjs). Absence of `agentEngines` fails
  // closed on the Muse plane: an unscoped or Dual-only entry is a
  // configuration error and must not silently serve the Muse transport.
  if (!engineering.modelEngineCompatible(entry, 'muse')) return null
  const requested = typeof reasoningOverride === 'string' && reasoningOverride !== ''
    ? reasoningOverride
    : String((museProfile.reasoning && museProfile.reasoning.default) || '')
  if (requested !== '') {
    const levels = Array.isArray(entry.supportedReasoningLevels) ? entry.supportedReasoningLevels : []
    if (!levels.includes(requested)) return null
  }
  const providers = entry.providers && typeof entry.providers === 'object' ? entry.providers : null
  let provider = null
  if (providers) {
    if (requested !== '' && providers[requested]) provider = String(providers[requested])
    else if (providers.default) provider = String(providers.default)
  }
  if (!provider && typeof entry.provider === 'string' && entry.provider !== '') provider = entry.provider
  if (!provider) return null
  return {
    modelId,
    model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : modelId,
    modelDisplayName: typeof entry.displayName === 'string' ? entry.displayName : modelId,
    vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
    provider,
    reasoning: requested,
    dataUseTier: typeof entry.dataUseTier === 'string' ? entry.dataUseTier : null,
  }
}

module.exports = {
  SUPPORTED_ENGINES,
  SOURCE_KIND_BY_ENGINE,
  normalizeId,
  catalogPathOf,
  museProfilesPathOf,
  modelRegistryPathOf,
  loadModelRegistry,
  loadNexusProfileCatalog,
  loadMuseProfiles,
  museProfileById,
  validateCatalogDocument,
  listNexusProfiles,
  resolveNexusProfile,
  requestedProfileId,
  resolveActiveNexusProfile,
  profileEngineOf,
  museModelBindingOf,
  resolveMuseProfileModel,
}
