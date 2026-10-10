'use strict'

/**
 * Registry R2.2 - canonical Muse model identity.
 *
 * Pure CommonJS. No fs, no process.env, no DSH/PowerShell/Rust imports,
 * no network, no credentials.
 *
 * Historical record (frozen R0 fixtures, config/model-registry.json):
 * two legacy model entries share the declared checkpoint
 * muse-spark-1.3-contributor but ride different providers:
 *
 *   legacy model muse-spark-1.3-contributor            -> provider meta-model-api
 *   legacy model muse-spark-1.3-contributor-opencode -> provider opencode-go
 *
 * Canonical identity: logical model meta/muse-spark-1.3-contributor with
 * route A (Meta Direct, provider meta-model-api) and route B (OpenCode Go,
 * provider opencode-go). Both historical profile ids are preserved as
 * import aliases. Both historical model ids resolve through the explicit
 * versioned alias map below, never by string guessing.
 *
 * Unification is FAIL-CLOSED: the two legacy entries must agree on every
 * substantive checkpoint/capability field before they may share one logical
 * model. Any mismatch yields actionable errors and NO snapshot, so an
 * identity merge is never forced across a real capability difference.
 * Connections, entitlements and access statuses are never merged: each
 * provider keeps its own connection record and each route keeps its own
 * availability/reasoning/compatibility metadata.
 */

const CANONICAL_MUSE_MODEL_ID = 'meta/muse-spark-1.3-contributor'
const CANONICAL_MUSE_CHECKPOINT = 'muse-spark-1.3-contributor'
const ALIAS_SCHEMA_VERSION = 1

const LEGACY_MODEL_ALIASES = Object.freeze({
  'muse-spark-1.3-contributor': CANONICAL_MUSE_MODEL_ID,
  'muse-spark-1.3-contributor-opencode': CANONICAL_MUSE_MODEL_ID,
})

const LEGACY_PROFILE_ALIASES = Object.freeze({
  'muse-spark-1.3-contributor': Object.freeze({
    canonicalModelId: CANONICAL_MUSE_MODEL_ID,
    providerId: 'meta-model-api',
  }),
  'muse-spark-1.3-contributor-opencode': Object.freeze({
    canonicalModelId: CANONICAL_MUSE_MODEL_ID,
    providerId: 'opencode-go',
  }),
})

function canonicalModelIdOf(legacyModelId) {
  if (typeof legacyModelId !== 'string') return null
  if (legacyModelId === CANONICAL_MUSE_MODEL_ID) return CANONICAL_MUSE_MODEL_ID
  const mapped = LEGACY_MODEL_ALIASES[legacyModelId]
  return typeof mapped === 'string' ? mapped : null
}

function isMuseLegacyModelId(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_MODEL_ALIASES, value)
}

function aliasRecord() {
  return {
    schemaVersion: ALIAS_SCHEMA_VERSION,
    canonicalModelId: CANONICAL_MUSE_MODEL_ID,
    canonicalCheckpoint: CANONICAL_MUSE_CHECKPOINT,
    legacyModelIds: Object.keys(LEGACY_MODEL_ALIASES).sort(),
    legacyProfileIds: Object.keys(LEGACY_PROFILE_ALIASES).sort(),
  }
}

function checkMuseUnificationEligible(models) {
  const errors = []
  const byId = new Map((models || []).map((m) => [m && m.id, m]))
  const legacyIds = Object.keys(LEGACY_MODEL_ALIASES)
  const entries = legacyIds.map((id) => byId.get(id)).filter(Boolean)
  if (entries.length !== legacyIds.length) {
    const missing = legacyIds.filter((id) => !byId.get(id))
    return { ok: false, errors: ['muse-canonical-missing-legacy-entry:' + missing.join(',')] }
  }
  const a = entries[0]
  const b = entries[1]
  const eq = (label, va, vb) => {
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      errors.push('muse-canonical-mismatch:' + label + ':' + JSON.stringify(va) + '!=' + JSON.stringify(vb))
    }
  }
  eq('checkpoint', a.checkpoint, b.checkpoint)
  eq('vendor', a.vendor, b.vendor)
  eq('capabilities', a.capabilities, b.capabilities)
  eq('dataUseTier', a.dataUseTier, b.dataUseTier)
  eq('engines', a.engines, b.engines)
  eq('contextWindow', a.contextWindow, b.contextWindow)
  eq('maxOutputTokens', a.maxOutputTokens, b.maxOutputTokens)
  eq('capacityProvenance', a.capacityProvenance, b.capacityProvenance)
  eq('enabled', a.enabled, b.enabled)
  eq('readOnlyDefault', a.readOnlyDefault, b.readOnlyDefault)
  if (a.checkpoint !== CANONICAL_MUSE_CHECKPOINT || b.checkpoint !== CANONICAL_MUSE_CHECKPOINT) {
    errors.push('muse-canonical-checkpoint-unexpected:' + String(a.checkpoint) + '/' + String(b.checkpoint))
  }
  return { ok: errors.length === 0, errors }
}

function normalizeMuseSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { snapshot: null, aliases: null, errors: ['muse-canonical-invalid-snapshot'] }
  }
  const errors = []
  const models = Array.isArray(snapshot.models) ? snapshot.models : []
  const routes = Array.isArray(snapshot.routes) ? snapshot.routes : []
  const legacyIds = Object.keys(LEGACY_MODEL_ALIASES)
  const present = legacyIds.filter((id) => models.some((m) => m && m.id === id))
  if (present.length !== legacyIds.length) {
    return { snapshot: null, aliases: null, errors: ['muse-canonical-missing-legacy-entry:' + legacyIds.filter((id) => present.indexOf(id) === -1).join(',')] }
  }
  const eligibility = checkMuseUnificationEligible(models)
  if (!eligibility.ok) return { snapshot: null, aliases: null, errors: eligibility.errors }
  const first = models.find((m) => m && m.id === legacyIds[0])
  const routesByProvider = new Map()
  for (const route of routes) {
    if (!route || !isMuseLegacyModelId(route.logicalModelId)) continue
    if (!routesByProvider.has(route.providerId)) routesByProvider.set(route.providerId, [])
    routesByProvider.get(route.providerId).push(route)
  }
  for (const providerId of ['meta-model-api', 'opencode-go']) {
    if (!routesByProvider.has(providerId) || routesByProvider.get(providerId).length === 0) {
      errors.push('muse-canonical-missing-route:' + providerId)
    }
  }
  if (errors.length > 0) return { snapshot: null, aliases: null, errors }
  const legacyRouteIds = []
  for (const list of routesByProvider.values()) for (const r of list) legacyRouteIds.push(r.id)
  if (new Set(legacyRouteIds).size !== legacyRouteIds.length) {
    return { snapshot: null, aliases: null, errors: ['muse-canonical-duplicate-route-id'] }
  }
  const canonicalModel = {
    schemaVersion: 1,
    id: CANONICAL_MUSE_MODEL_ID,
    vendor: first.vendor,
    displayName: 'Muse Spark 1.3 Contributor',
    checkpoint: CANONICAL_MUSE_CHECKPOINT,
    capabilities: JSON.parse(JSON.stringify(first.capabilities)),
    dataUseTier: first.dataUseTier,
    enabled: first.enabled,
    engines: first.engines.slice(),
  }
  for (const key of ['contextWindow', 'maxOutputTokens', 'capacityProvenance', 'readOnlyDefault']) {
    if (first[key] !== undefined) canonicalModel[key] = first[key]
  }
  const legacyRouteIdMap = {}
  const canonicalRoutes = []
  const sortedProviders = Array.from(routesByProvider.keys()).sort()
  for (const providerId of sortedProviders) {
    const list = routesByProvider.get(providerId).slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    for (const route of list) {
      const canonicalRouteId = providerId + '/' + CANONICAL_MUSE_MODEL_ID
      legacyRouteIdMap[route.id] = canonicalRouteId
      canonicalRoutes.push({
        schemaVersion: 1,
        id: canonicalRouteId,
        providerId: route.providerId,
        logicalModelId: CANONICAL_MUSE_MODEL_ID,
        remoteModelId: route.remoteModelId,
        accessType: route.accessType,
        connectionId: route.connectionId,
        executionKind: route.executionKind,
        reasoningLevels: route.reasoningLevels.slice(),
        compatibility: JSON.parse(JSON.stringify(route.compatibility || {})),
        availability: route.availability,
        enabled: route.enabled,
        provenance: route.provenance || 'legacy-production-use',
      })
    }
  }
  const nextModels = models.filter((m) => m && !isMuseLegacyModelId(m.id)).concat([canonicalModel])
  const nextRoutes = routes.filter((r) => r && !isMuseLegacyModelId(r.logicalModelId)).concat(canonicalRoutes)
  if (nextModels.filter((m) => m && m.id === CANONICAL_MUSE_MODEL_ID).length !== 1) {
    return { snapshot: null, aliases: null, errors: ['muse-canonical-duplicate-model'] }
  }
  const aliases = {
    schemaVersion: ALIAS_SCHEMA_VERSION,
    canonicalModelId: CANONICAL_MUSE_MODEL_ID,
    canonicalCheckpoint: CANONICAL_MUSE_CHECKPOINT,
    legacyModelIds: legacyIds.slice().sort(),
    legacyProfileIds: Object.keys(LEGACY_PROFILE_ALIASES).slice().sort(),
    legacyRouteIds: legacyRouteIdMap,
  }
  const next = { schemaVersion: snapshot.schemaVersion, modes: snapshot.modes, models: nextModels, providers: snapshot.providers, routes: nextRoutes, connections: snapshot.connections }
  return { snapshot: next, aliases, errors: [] }
}

function resolveModelId(modelId) {
  return canonicalModelIdOf(modelId)
}

module.exports = {
  CANONICAL_MUSE_MODEL_ID,
  CANONICAL_MUSE_CHECKPOINT,
  LEGACY_MODEL_ALIASES,
  LEGACY_PROFILE_ALIASES,
  canonicalModelIdOf,
  isMuseLegacyModelId,
  resolveModelId,
  aliasRecord,
  checkMuseUnificationEligible,
  normalizeMuseSnapshot,
}
