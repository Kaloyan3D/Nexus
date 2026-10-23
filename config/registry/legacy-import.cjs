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
const schemas = require('./schemas.cjs')

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

// The three legacy definitions are REQUIRED and keep their exact historical loading semantics.
const REQUIRED_MODE_IDS = ['engineering-v1', 'engineering-v2', 'engineering-v3']

// EM-04C2: the adaptive definition is OPTIONAL and recognized only through this closed identity: the
// fixed file name, the fixed mode id, the fixed engine, and a valid Registry mode schema. Anything else
// at that path (another id, another engine, a malformed or schema-invalid document, invalid JSON) is
// treated as ABSENT: it can neither break the three legacy modes nor become listable or importable.
// No other file in the modes directory is ever read (there is no directory scan).
const OPTIONAL_MODE = Object.freeze({ file: 'engineering-v2-adaptive.json', id: 'engineering-v2-adaptive', engineId: 'nexus-adaptive-v1' })
function isOptionalModeDefinition(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  if (doc.id !== OPTIONAL_MODE.id || doc.orchestrationEngineId !== OPTIONAL_MODE.engineId) return false
  return schemas.validateModeDefinition(doc, 'mode').length === 0
}

function loadModeDefinitions() {
  const dir = path.join(__dirname, 'modes')
  const modes = []
  for (const file of ['engineering-v1.json', 'engineering-v2.json', OPTIONAL_MODE.file, 'engineering-v3.json']) {
    const doc = readJson(path.join(dir, file))
    if (!doc) continue
    if (file === OPTIONAL_MODE.file && !isOptionalModeDefinition(doc)) continue
    modes.push(doc)
  }
  return modes
}

const KNOWN_LEGACY_ENGINES = { dual: 'dual-v1', muse: 'muse-v0' }

/**
 * Fail-closed engine scope (H2). A genuinely absent declaration keeps the
 * backward-compatible Dual scope. Any explicit declaration that is empty,
 * malformed, or names an unknown engine is NEVER guessed as Dual: the model
 * normalizes with an empty scope (eligible for no engine) and an actionable
 * import error is reported.
 */
function engineScopeOfLegacyEntry(entry) {
  const declared = entry.agentEngines
  if (declared === undefined) return { scope: ['dual-v1'], error: null }
  if (declared === null) return { scope: [], error: 'legacy-engine-scope-malformed:' + String(entry.id) }
  if (!Array.isArray(declared)) {
    return { scope: [], error: 'legacy-engine-scope-malformed:' + String(entry.id) }
  }
  if (declared.length === 0) {
    return { scope: [], error: 'legacy-engine-scope-empty:' + String(entry.id) }
  }
  const scope = []
  for (const name of declared) {
    if (typeof name !== 'string' || !KNOWN_LEGACY_ENGINES[name]) {
      return { scope: [], error: 'legacy-engine-scope-unknown:' + String(entry.id) + ':' + String(name) }
    }
    const mapped = KNOWN_LEGACY_ENGINES[name]
    if (!scope.includes(mapped)) scope.push(mapped)
  }
  return { scope, error: null }
}

function validCapacity(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Preserve legacy capacity metadata (H3) without inventing limits: valid
 * positive integers round-trip with 'declared' provenance; present-but-
 * invalid values are omitted and reported, never coerced; absent values
 * stay absent (unknown capacity, never infinite). Security-relevant
 * declarations (dataUseTier, readOnlyDefault) survive alongside.
 */
function normalizeLogicalModel(entry) {
  const errors = []
  const { scope, error } = engineScopeOfLegacyEntry(entry)
  if (error) errors.push(error)
  const model = {
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
    engines: scope,
  }
  let capacityDeclared = false
  for (const key of ['contextWindow', 'maxOutputTokens']) {
    if (entry[key] === undefined) continue
    const valid = validCapacity(entry[key])
    if (valid === null) errors.push('legacy-model-capacity-invalid:' + String(entry.id) + ':' + key)
    else {
      model[key] = valid
      capacityDeclared = true
    }
  }
  if (capacityDeclared) model.capacityProvenance = 'declared'
  if (entry.readOnlyDefault !== undefined) {
    if (typeof entry.readOnlyDefault !== 'boolean') errors.push('legacy-model-capacity-invalid:' + String(entry.id) + ':readOnlyDefault')
    else model.readOnlyDefault = entry.readOnlyDefault
  }
  return { model, errors }
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

/**
 * R2: canonical Provider records carry no DSH-specific identifiers.
 * Projection of a canonical provider id onto an installed DSH provider key
 * lives exclusively in the adapter-private map in dsh-adapter.cjs.
 * Canonical lookups use `id` only.
 */
// R5: known providers describe their real substrate (transport, auth type,
// non-secret base URL). Ids and status are unchanged, so saved
// configurations and resolver eligibility behave exactly as before.
const R5_PROVIDER_SPECIALIZATION = {
  'sol-local': { transportId: 'local-openai-compatible', authType: 'local-server', baseUrl: 'http://127.0.0.1:10531/v1' },
  'opencode-go': { transportId: 'openai-responses', authType: 'api-key', baseUrl: 'https://opencode.ai/zen/go/v1' },
  'meta-model-api': { transportId: 'openai-chat-completions', authType: 'api-key', baseUrl: 'https://api.meta.ai/v1' },
};

function normalizeProvider(providerId) {
  const record = {
    schemaVersion: 1,
    id: providerId,
    name: providerId,
    transportId: 'unknown',
    status: 'enabled',
  };
  const spec = R5_PROVIDER_SPECIALIZATION[providerId];
  if (spec) {
    record.transportId = spec.transportId;
    record.authType = spec.authType;
    record.baseUrl = spec.baseUrl;
  }
  return record;
}

// R5: the Codex OAuth connection is a third-party subscription-delegated
// integration (NOT official Sign in with ChatGPT); API-key providers keep
// their kind. Ids, credential refs, status and provenance are unchanged.
const R5_CONNECTION_SPECIALIZATION = {
  'sol-local': { connectionKind: 'subscription-delegated', authMethod: 'codex-oauth (third-party openai-oauth package: PKCE loopback flow, Codex-compatible auth file, local service on 127.0.0.1:10531; Nexus holds no token; NOT official Sign in with ChatGPT delegation)' },
  'opencode-go': { connectionKind: 'api-key', authMethod: 'api-key (OPENCODE_API_KEY; OpenCode Go API billing, not a subscription)' },
  'meta-model-api': { connectionKind: 'api-key', authMethod: 'api-key (MODEL_API_KEY; Meta direct API billing, not a subscription)' },
};

function normalizeConnection(providerId) {
  const record = {
    schemaVersion: 1,
    id: 'conn-' + providerId,
    providerId,
    connectionKind: 'api-key',
    authMethod: 'api-key',
    credentialRef: 'credential://connections/conn-' + providerId,
    status: 'unknown',
    provenance: 'legacy-production-use',
  };
  const spec = R5_CONNECTION_SPECIALIZATION[providerId];
  if (spec) {
    record.connectionKind = spec.connectionKind;
    record.authMethod = spec.authMethod;
  }
  return record;
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
      accessType: providerId === 'sol-local' ? 'subscription-delegated' : 'api-key',
      connectionId: 'conn-' + providerId,
      executionKind: 'raw-model',
      reasoningLevels,
      compatibility: {
        transport: providerId === 'sol-local' ? 'local-openai-compatible' : (providerId === 'opencode-go' ? 'openai-responses' : (providerId === 'meta-model-api' ? 'openai-chat-completions' : 'unknown')),
        toolRoundTrip: 'declared',
        streaming: 'declared',
        vision: entry.supportsVision === true ? 'declared' : 'unknown',
      },
      availability: 'verified',
      enabled: entry.enabled !== false,
      provenance: 'legacy-production-use',
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
  const models = []
  for (const entry of legacy.models) {
    const { model, errors: modelErrors } = normalizeLogicalModel(entry)
    errors.push(...modelErrors)
    models.push(model)
  }
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
  // The three legacy mode definitions are REQUIRED; the dormant adaptive definition is OPTIONAL (it may
  // be present or absent), so completeness is judged by id, not by count.
  const present = new Set(modes.map((m) => m && m.id))
  if (!REQUIRED_MODE_IDS.every((id) => present.has(id))) errors.push('registry-mode-definitions-incomplete')
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
  isOptionalModeDefinition,
  OPTIONAL_MODE_ID: OPTIONAL_MODE.id,
  buildRegistrySnapshot,
  importLegacyProfiles,
  importDualProfile,
  importMuseProfile,
  normalizeLogicalModel,
  normalizeRoutes,
  routeIdForLegacyBinding,
}
