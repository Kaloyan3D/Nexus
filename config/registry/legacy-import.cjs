'use strict'

/**
 * Registry legacy import (R1) — read-only normalization helper.
 *
 * Reads the EXISTING configuration files (engineering-profiles.json,
 * muse-profiles.json, model-registry.json, plus the built-in Registry mode
 * definitions) and normalizes them into Registry Core snapshots. It performs
 * NO writes, NO migrations, and replaces NO existing resolver: production
 * routing keeps using config/Engineering-Profiles.cjs and
 * config/Nexus-Profiles.cjs until R2 demonstrates parity.
 *
 * The install root is an injected parameter (a Nexus-owned configuration
 * root). This helper never consults host-specific environment variables or
 * process.env, so relocated installs behave identically and Registry Core
 * stays runtime-independent. Returns plain data; all validation lives in
 * the pure resolver.
 */

const fs = require('node:fs')
const path = require('node:path')

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function loadModeDefinitions() {
  const dir = path.join(__dirname, 'modes')
  const modes = []
  for (const file of ['engineering-v1.json', 'engineering-v2.json', 'engineering-v3.json']) {
    const doc = readJson(path.join(dir, file))
    if (doc) modes.push(doc)
  }
  return modes
}

function engineScopeOfLegacyEntry(entry) {
  const declared = Array.isArray(entry.agentEngines) ? entry.agentEngines : null
  if (declared === null) return ['dual-v1']
  const scope = []
  if (declared.includes('dual')) scope.push('dual-v1')
  if (declared.includes('muse')) scope.push('muse-v0')
  return scope.length > 0 ? scope : ['dual-v1']
}

function normalizeLogicalModel(entry) {
  return {
    schemaVersion: 1,
    id: String(entry.id),
    vendor: typeof entry.vendor === 'string' && entry.vendor !== '' ? entry.vendor : 'unknown',
    displayName: typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : String(entry.id),
    checkpoint: typeof entry.model === 'string' && entry.model !== '' ? entry.model : String(entry.id),
    capabilities: {
      textInput: true,
      imageInput: entry.supportsVision === true,
      toolCalling: entry.supportsTools !== false,
      streaming: entry.supportsStreaming !== false,
      reasoning: entry.supportsReasoning !== false,
    },
    ...(typeof entry.dataUseTier === 'string' ? { dataUseTier: entry.dataUseTier } : {}),
    enabled: entry.enabled !== false,
    engines: engineScopeOfLegacyEntry(entry),
  }
}

function providerKeysOf(entry) {
  const keys = new Set()
  if (typeof entry.provider === 'string' && entry.provider !== '') keys.add(entry.provider)
  const providers = entry.providers && typeof entry.providers === 'object' ? entry.providers : {}
  for (const value of Object.values(providers)) {
    if (typeof value === 'string' && value !== '') keys.add(value)
  }
  return [...keys]
}

function normalizeProvider(providerId) {
  return {
    schemaVersion: 1,
    id: providerId,
    name: providerId,
    transportId: 'unknown',
    status: 'enabled',
    legacyDshProviderId: providerId,
  }
}

function normalizeConnection(providerId) {
  return {
    schemaVersion: 1,
    id: 'conn-' + providerId,
    providerId,
    connectionKind: 'api-key',
    authMethod: 'api-key',
    credentialRef: 'credential://connections/conn-' + providerId,
    status: 'unknown',
  }
}

/**
 * One route per (model, provider) pair actually referenced by the legacy
 * entry. reasoningLevels are the exact levels that resolve to that provider
 * under legacy semantics (explicit per-level mapping, else the default).
 * Distinct providers stay distinct routes even for the same checkpoint.
 */
function normalizeRoutes(entry) {
  const providers = entry.providers && typeof entry.providers === 'object' ? entry.providers : {}
  const fallback = typeof providers.default === 'string' && providers.default !== ''
    ? providers.default
    : (typeof entry.provider === 'string' && entry.provider !== '' ? entry.provider : null)
  if (!fallback) return []
  const levels = Array.isArray(entry.supportedReasoningLevels) ? entry.supportedReasoningLevels : []
  const byProvider = new Map()
  for (const level of levels) {
    const target = (typeof providers[level] === 'string' && providers[level] !== '') ? providers[level] : fallback
    if (!byProvider.has(target)) byProvider.set(target, [])
    byProvider.get(target).push(level)
  }
  const routes = []
  for (const [providerId, reasoningLevels] of byProvider) {
    routes.push({
      schemaVersion: 1,
      id: providerId + '/' + String(entry.id),
      providerId,
      logicalModelId: String(entry.id),
      remoteModelId: typeof entry.model === 'string' && entry.model !== '' ? entry.model : String(entry.id),
      accessType: 'api-key',
      connectionId: 'conn-' + providerId,
      executionKind: 'raw-model',
      reasoningLevels,
      compatibility: {
        transport: 'unknown',
        toolRoundTrip: 'declared',
        streaming: 'declared',
        vision: entry.supportsVision === true ? 'declared' : 'unknown',
      },
      availability: 'verified',
      enabled: entry.enabled !== false,
    })
  }
  return routes
}

function buildRegistrySnapshot(installRoot) {
  const errors = []
  const legacy = readJson(path.join(installRoot, 'config', 'model-registry.json'))
  if (!legacy || legacy.schemaVersion !== 1 || !Array.isArray(legacy.models)) {
    return { snapshot: null, errors: ['legacy-model-registry-unavailable'] }
  }
  const models = legacy.models.map(normalizeLogicalModel)
  const providerIds = []
  const seenProviders = new Set()
  for (const entry of legacy.models) {
    for (const key of providerKeysOf(entry)) {
      if (!seenProviders.has(key)) {
        seenProviders.add(key)
        providerIds.push(key)
      }
    }
  }
  const providers = providerIds.map(normalizeProvider)
  const connections = providerIds.map(normalizeConnection)
  const routes = legacy.models.flatMap(normalizeRoutes)
  const modes = loadModeDefinitions()
  if (modes.length !== 3) errors.push('registry-mode-definitions-incomplete')
  const snapshot = {
    schemaVersion: 1,
    modes,
    models,
    providers,
    routes,
    connections,
  }
  return { snapshot, errors }
}

function routeIdForLegacyBinding(snapshot, modelId, providerId, reasoning) {
  const candidates = (snapshot.routes || []).filter((r) =>
    r.logicalModelId === modelId &&
    r.providerId === providerId &&
    Array.isArray(r.reasoningLevels) && r.reasoningLevels.includes(reasoning))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return candidates[0].id
}

/**
 * Normalize one legacy Dual engineering profile to an R1 ModeConfiguration
 * for engineering-v1. The UI-facing engineer slot carries primaryEngineer;
 * deepEngineer/fallback ride as per-role overrides so intentionally different
 * models/reasoning survive losslessly. visualReviewer rides as an override
 * when present.
 */
function importDualProfile(profile, snapshot) {
  const roles = (profile && profile.roles) || {}
  const get = (role) => (roles[role] && typeof roles[role] === 'object' ? roles[role] : null)
  const primary = get('primaryEngineer')
  const reviewer = get('reviewer')
  const solver = get('solver')
  if (!primary || !reviewer || !solver) return { config: null, error: 'dual-profile-missing-required-role:' + String(profile && profile.id) }
  const bind = (binding) => {
    if (!binding || typeof binding.model !== 'string' || typeof binding.reasoning !== 'string') return null
    const providerId = providerForLegacyReasoning(snapshot, binding.model, binding.reasoning)
    if (!providerId) return null
    const routeId = routeIdForLegacyBinding(snapshot, binding.model, providerId, binding.reasoning)
    if (!routeId) return null
    return { logicalModelId: binding.model, routeId, reasoning: binding.reasoning }
  }
  const engineer = bind(primary)
  const reviewerSlot = bind(reviewer)
  const solverSlot = bind(solver)
  if (!engineer || !reviewerSlot || !solverSlot) return { config: null, error: 'dual-profile-unresolvable-role:' + String(profile && profile.id) }
  const roleOverrides = {}
  for (const role of ['deepEngineer', 'fallback', 'visualReviewer']) {
    const binding = get(role)
    if (!binding) continue
    const normalized = bind(binding)
    if (!normalized) return { config: null, error: 'dual-profile-unresolvable-role:' + String(profile && profile.id) + '/' + role }
    roleOverrides[role] = normalized
  }
  return {
    config: {
      schemaVersion: 1,
      modeId: 'engineering-v1',
      revision: 0,
      slots: { engineer, reviewer: reviewerSlot, solver: solverSlot },
      roleOverrides,
    },
    error: null,
  }
}

function providerForLegacyReasoning(snapshot, modelId, reasoning) {
  const candidates = (snapshot.routes || []).filter((r) =>
    r.logicalModelId === modelId &&
    Array.isArray(r.reasoningLevels) && r.reasoningLevels.includes(reasoning))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return candidates[0].providerId
}

function importMuseProfile(museProfile, snapshot) {
  const primary = museProfile && museProfile.model && typeof museProfile.model.primary === 'string'
    ? museProfile.model.primary.trim()
    : ''
  const reasoning = museProfile && museProfile.reasoning && typeof museProfile.reasoning.default === 'string'
    ? museProfile.reasoning.default
    : ''
  if (primary === '' || reasoning === '') return { config: null, error: 'muse-profile-missing-binding:' + String(museProfile && museProfile.id) }
  const providerId = providerForLegacyReasoning(snapshot, primary, reasoning)
  if (!providerId) return { config: null, error: 'muse-profile-unresolvable:' + String(museProfile && museProfile.id) }
  const routeId = routeIdForLegacyBinding(snapshot, primary, providerId, reasoning)
  if (!routeId) return { config: null, error: 'muse-profile-unresolvable:' + String(museProfile && museProfile.id) }
  return {
    config: {
      schemaVersion: 1,
      modeId: 'engineering-v2',
      revision: 0,
      slots: { main: { logicalModelId: primary, routeId, reasoning } },
    },
    error: null,
  }
}

/**
 * Import every legacy Dual + Muse profile (including the operator custom
 * profile when present) into R1 mode configurations. Read-only: the legacy
 * files are never written.
 */
function importLegacyProfiles(installRoot, snapshot) {
  const errors = []
  const configs = {}
  const engineeringDoc = readJson(path.join(installRoot, 'config', 'engineering-profiles.json'))
  const customDoc = readJson(path.join(installRoot, 'data', 'custom-engineering-profile.json'))
  const profiles = engineeringDoc && Array.isArray(engineeringDoc.profiles) ? engineeringDoc.profiles.slice() : []
  if (customDoc && customDoc.schemaVersion === 1 && customDoc.roles && typeof customDoc.roles === 'object') {
    profiles.push({ id: 'custom', displayName: 'Custom', description: 'Operator-defined.', roles: customDoc.roles })
  }
  for (const profile of profiles) {
    if (!profile || typeof profile.id !== 'string') continue
    const { config, error } = importDualProfile(profile, snapshot)
    if (error) errors.push(error)
    else configs[profile.id] = config
  }
  const museDoc = readJson(path.join(installRoot, 'config', 'muse-profiles.json'))
  const museProfiles = museDoc && Array.isArray(museDoc.profiles) ? museDoc.profiles : []
  for (const museProfile of museProfiles) {
    if (!museProfile || typeof museProfile.id !== 'string') continue
    const { config, error } = importMuseProfile(museProfile, snapshot)
    if (error) errors.push(error)
    else configs[museProfile.id] = config
  }
  return { configs, errors }
}

module.exports = {
  buildRegistrySnapshot,
  importLegacyProfiles,
  importDualProfile,
  importMuseProfile,
  normalizeLogicalModel,
  normalizeRoutes,
  routeIdForLegacyBinding,
}
