'use strict'

/**
 * Registry Core resolver (R1) — pure deterministic compiler.
 *
 * Pure CommonJS: no fs, no process.env, no network, no inference, no session
 * mutation, no DSH/PowerShell/Rust imports. Only dependency is node:crypto
 * (for the stable resolutionId) and ./schemas.cjs (validators).
 *
 * Validation order follows NEXUS_REGISTRY_ARCHITECTURE.md section 6:
 * schema/version -> mode runnable -> required slots bound -> model/route/
 * provider/connection references -> capability/role compatibility -> reasoning
 * support -> runtime-host compatibility -> immutable snapshot compilation.
 *
 * Every failure is fail-closed: { ok: false, errors } with actionable codes.
 * No substitution, fallback, or silent downshift is ever performed.
 */

const crypto = require('node:crypto')
const schemas = require('./schemas.cjs')

const LEGACY_PROVENANCE = 'legacy-production-use'

/**
 * Explicit route eligibility (H1). Only 'verified' routes are executable.
 * Legacy production descriptors arrive as 'verified' with legacy provenance
 * (see legacy-import.cjs); every other state fails closed with an
 * actionable code. A merely 'discovered' route is never execution access.
 */
const NON_EXECUTABLE_AVAILABILITY = {
  unavailable: 'route-unavailable',
  disabled: 'route-unavailable',
  'auth-required': 'route-not-verified',
  'probe-required': 'route-not-verified',
  'policy-blocked': 'route-not-verified',
  discovered: 'route-not-verified',
  unknown: 'route-not-verified',
}
const BLOCKED_CONNECTION_STATUS = new Set(['revoked', 'disabled'])

function routeEligibility(route) {
  if (!route) return { code: 'unknown-reference', message: 'unknown route' }
  if (route.enabled === false) return { code: 'route-unavailable', message: 'route is disabled: ' + route.id }
  if (route.availability === 'verified') return null
  const code = NON_EXECUTABLE_AVAILABILITY[route.availability] || 'route-not-verified'
  return { code, message: 'route is not executable (' + route.availability + '): ' + route.id }
}

/**
 * Connection eligibility, applied identically at compile and listing time.
 * Live 'connected' Jewelry always qualifies. Offline legacy descriptors
 * (status 'unknown' + legacy provenance) are accepted as runnable
 * descriptors only: the runtime adapter must still revalidate the underlying
 * credential reference at request time. Anything else fails closed.
 */
function connectionEligibility(connection) {
  if (!connection) return { code: 'connection-auth-required', message: 'unknown connection' }
  if (BLOCKED_CONNECTION_STATUS.has(connection.status)) {
    return { code: 'connection-auth-required', message: 'connection is ' + connection.status + ': ' + connection.id }
  }
  if (connection.status === 'connected') return null
  if (connection.status === 'unknown' && connection.provenance === LEGACY_PROVENANCE) return null
  return { code: 'connection-auth-required', message: 'connection is not authorized (' + connection.status + '): ' + connection.id }
}

function err(code, path, message) {
  return { code, path, message }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function resolutionIdOf(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex')
}

function indexById(items) {
  const map = new Map()
  for (const item of items || []) {
    if (item && typeof item.id === 'string') map.set(item.id, item)
  }
  return map
}

function findMode(registry, modeId) {
  for (const mode of (registry && registry.modes) || []) {
    if (mode && mode.id === modeId) return mode
  }
  return null
}

function slotForRole(mode, role) {
  for (const slot of (mode && mode.slots) || []) {
    if (slot && Array.isArray(slot.internalRoles) && slot.internalRoles.includes(role)) return slot
  }
  return null
}

function isOptionalRole(mode, role) {
  return !!mode && Array.isArray(mode.optionalCapabilities) && mode.optionalCapabilities.includes(role)
}

/**
 * Portable role/capability contract. Slot requirements are declarative;
 * enforcement of read-only/approval behavior stays with the controller —
 * the compiler records the requirement and refuses models that cannot
 * satisfy the model's share of the contract.
 */
function checkRoleCapability(slot, role, model, route) {
  const errors = []
  const requirements = (slot && slot.requirements) || {}
  const capabilities = (model && model.capabilities) || {}
  if (requirements.toolCalling === true && capabilities.toolCalling !== true) {
    errors.push(err('slot-capability-not-satisfied', 'roles.' + role, 'role ' + role + ' requires toolCalling; model ' + (model && model.id) + ' does not declare it'))
  }
  if (role === 'visualReviewer' && capabilities.imageInput !== true) {
    errors.push(err('slot-capability-not-satisfied', 'roles.' + role, 'visualReviewer requires imageInput; model ' + (model && model.id) + ' does not declare it'))
  }
  if (requirements.adaptiveReasoningContract === 'muse-v0' && model.dataUseTier !== 'contributor') {
    errors.push(err('slot-capability-not-satisfied', 'roles.' + role, 'muse-v0 single-agent contract requires the contributor data-use tier'))
  }
  if (requirements.singleAgent === true && route && route.executionKind !== 'raw-model') {
    errors.push(err('slot-capability-not-satisfied', 'roles.' + role, 'single-agent slot requires a raw-model route, not ' + route.executionKind))
  }
  if (typeof requirements.pinnedProvider === 'string' && requirements.pinnedProvider !== '' && route) {
    if (route.providerId !== requirements.pinnedProvider) {
      errors.push(err('slot-capability-not-satisfied', 'roles.' + role, 'slot ' + ((slot && slot.id) || role) + ' pins provider ' + requirements.pinnedProvider + '; route ' + route.id + ' uses ' + route.providerId))
    }
  }
  if (capabilities.reasoning !== true) {
    errors.push(err('slot-capability-not-satisfied', 'roles.' + role, 'role ' + role + ' requires reasoning support'))
  }
  return errors
}

function checkEngineScope(mode, model, role) {
  const engineId = mode && mode.orchestrationEngineId
  const engines = model && model.engines
  if (!model || typeof engineId !== 'string' || engineId === '') {
    return [err('engine-scope-mismatch', 'roles.' + role, 'engine scope cannot be established; Dual/Muse isolation fails closed')]
  }
  if (!Array.isArray(engines)) {
    return [err('engine-scope-mismatch', 'roles.' + role, 'model ' + model.id + ' declares no explicit engine scope and never implicitly qualifies; Dual/Muse isolation fails closed')]
  }
  if (!engines.includes(engineId)) {
    return [err('engine-scope-mismatch', 'roles.' + role, 'model ' + model.id + ' is not scoped to orchestration engine ' + engineId + '; Dual/Muse isolation fails closed')]
  }
  return []
}

function checkRuntimeCompatibility(route, runtime, role) {
  if (!runtime) return []
  const errors = []
  if (Array.isArray(runtime.executionKinds) && !runtime.executionKinds.includes(route.executionKind)) {
    errors.push(err('runtime-capability-unsatisfied', 'roles.' + role, 'runtime ' + (runtime.adapterId || 'unknown') + ' does not support execution kind ' + route.executionKind))
  }
  const transport = route.compatibility && route.compatibility.transport
  if (typeof transport === 'string' && transport !== 'unknown' && Array.isArray(runtime.protocols) && !runtime.protocols.includes(transport)) {
    errors.push(err('runtime-capability-unsatisfied', 'roles.' + role, 'runtime ' + (runtime.adapterId || 'unknown') + ' does not support protocol ' + transport))
  }
  return errors
}

function resolveRoleBinding(registry, mode, role, assignment, runtime) {
  const errors = []
  const models = indexById(registry.models)
  const routes = indexById(registry.routes)
  const providers = indexById(registry.providers)
  const connections = indexById(registry.connections)

  let slot = slotForRole(mode, role)
  if (!slot && isOptionalRole(mode, role)) {
    slot = { id: role, label: role, required: false, internalRoles: [role], requirements: {} }
  }
  if (!slot) {
    return { errors: [err('unknown-role', 'roles.' + role, 'role ' + role + ' is not part of mode ' + mode.id)], binding: null }
  }
  if (!assignment) {
    return { errors: [err('mode-config-incomplete', 'roles.' + role, 'slot ' + slot.id + ' (role ' + role + ') has no assignment')], binding: null }
  }

  const model = models.get(assignment.logicalModelId)
  if (!model) {
    return { errors: [err('unknown-reference', 'roles.' + role + '.logicalModelId', 'unknown logical model: ' + assignment.logicalModelId)], binding: null }
  }
  if (model.enabled === false) {
    errors.push(err('model-disabled', 'roles.' + role + '.logicalModelId', 'logical model is disabled: ' + model.id))
  }
  const route = routes.get(assignment.routeId)
  if (!route) {
    return { errors: [err('unknown-reference', 'roles.' + role + '.routeId', 'unknown route: ' + assignment.routeId)], binding: null }
  }
  const eligibility = routeEligibility(route)
  if (eligibility) {
    errors.push(err(eligibility.code, 'roles.' + role + '.routeId', eligibility.message))
  }
  if (route.logicalModelId !== model.id) {
    errors.push(err('route-model-identity-mismatch', 'roles.' + role + '.routeId', 'route ' + route.id + ' offers ' + route.logicalModelId + ', not ' + model.id))
  }
  const provider = providers.get(route.providerId)
  if (!provider) {
    errors.push(err('unknown-reference', 'roles.' + role + '.providerId', 'unknown provider: ' + route.providerId))
  } else if (provider.status !== 'enabled') {
    errors.push(err('provider-disabled', 'roles.' + role + '.providerId', 'provider is not enabled: ' + provider.id))
  }
  let connectionId = null
  if (route.connectionId === undefined || route.connectionId === null) {
    errors.push(err('connection-auth-required', 'roles.' + role + '.connectionId', 'route ' + route.id + ' declares no connection; authenticated routes require an explicit connection and never compile connectionless'))
  } else {
    const connection = connections.get(route.connectionId)
    if (!connection) {
      errors.push(err('connection-auth-required', 'roles.' + role + '.connectionId', 'unknown connection: ' + route.connectionId))
    } else {
      const access = connectionEligibility(connection)
      if (access) errors.push(err(access.code, 'roles.' + role + '.connectionId', access.message))
      if (connection.providerId !== route.providerId) {
        errors.push(err('connection-provider-mismatch', 'roles.' + role + '.connectionId', 'connection provider mismatch for route ' + route.id))
      }
      connectionId = connection.id
    }
  }
  errors.push(...checkEngineScope(mode, model, role))
  errors.push(...checkRoleCapability(slot, role, model, route))
  if (!Array.isArray(route.reasoningLevels) || !route.reasoningLevels.includes(assignment.reasoning)) {
    errors.push(err('reasoning-level-not-supported', 'roles.' + role + '.reasoning', 'reasoning ' + JSON.stringify(assignment.reasoning) + ' is not supported by route ' + route.id + '; never downshifted'))
  }
  // EM-02: operator-authorized levels for this slot must be route-declared and include the
  // default; the authorized set is the operator's policy, never the route's whole capability.
  let allowedReasoning
  if (assignment.allowedReasoning !== undefined) {
    const policy = Array.isArray(assignment.allowedReasoning) ? assignment.allowedReasoning : []
    for (const level of policy) {
      if (!Array.isArray(route.reasoningLevels) || !route.reasoningLevels.includes(level)) {
        errors.push(err('reasoning-level-not-supported', 'roles.' + role + '.allowedReasoning', 'reasoning ' + JSON.stringify(level) + ' is not supported by route ' + route.id + '; never authorized beyond the route'))
      }
    }
    if (!policy.includes(assignment.reasoning)) {
      errors.push(err('slot-assignment-invalid', 'roles.' + role + '.allowedReasoning', 'allowedReasoning must include the assignment reasoning'))
    }
    allowedReasoning = Array.from(new Set(policy)).sort()
  }
  errors.push(...checkRuntimeCompatibility(route, runtime, role))
  if (errors.length > 0) return { errors, binding: null }

  const binding = {
    schemaVersion: 1,
    resolutionId: '',
    modeId: mode.id,
    orchestrationEngineId: mode.orchestrationEngineId,
    modeConfigRevision: 0,
    roleId: role,
    logicalModelId: model.id,
    routeId: route.id,
    providerId: provider.id,
    remoteModelId: route.remoteModelId,
    connectionId,
    executionKind: route.executionKind,
    accessType: route.accessType,
    protocolId: (route.compatibility && route.compatibility.transport) || 'unknown',
    reasoning: assignment.reasoning,
    ...(allowedReasoning !== undefined ? { allowedReasoning } : {}),
    requiredCapabilities: Object.keys((slot && slot.requirements) || {}).sort(),
    slotRequirements: { ...((slot && slot.requirements) || {}) },
    dataUseTier: model.dataUseTier || null,
  }
  return { errors: [], binding }
}

/**
 * Compile a ModeConfiguration against a registry snapshot into an immutable,
 * runtime-neutral ResolvedModeConfiguration. Pure and deterministic: the same
 * inputs always yield the same resolutionId.
 */
function compileModeConfig(modeConfig, registry, options) {
  const runtime = (options && options.runtime) || null
  let errors = []
  errors.push(...schemas.validateModeConfiguration(modeConfig, 'modeConfiguration'))
  errors.push(...schemas.validateRegistrySnapshot(registry, 'registry'))
  if (runtime) errors.push(...schemas.validateRuntimeCapabilities(runtime, 'runtime'))
  if (errors.length > 0) return { ok: false, errors }

  const mode = findMode(registry, modeConfig.modeId)
  if (!mode) return { ok: false, errors: [err('unknown-mode', 'modeConfiguration.modeId', 'unknown mode: ' + modeConfig.modeId)] }
  if (mode.runnable === false || mode.status === 'planned') {
    return { ok: false, errors: [err('mode-not-runnable', 'modeConfiguration.modeId', 'mode ' + mode.id + ' is planned/preview and cannot be compiled for execution')] }
  }

  const slotsById = new Map((mode.slots || []).map((s) => [s.id, s]))
  for (const slotId of Object.keys(modeConfig.slots)) {
    if (!slotsById.has(slotId)) {
      errors.push(err('unknown-slot', 'modeConfiguration.slots.' + slotId, 'slot ' + slotId + ' is not declared by mode ' + mode.id))
    }
  }
  for (const slot of mode.slots || []) {
    if (slot.required === true && !modeConfig.slots[slot.id]) {
      errors.push(err('mode-config-incomplete', 'modeConfiguration.slots.' + slot.id, 'required slot ' + slot.id + ' has no assignment'))
    }
  }
  const knownRoles = new Set(mode.internalRoles || [])
  for (const slot of mode.slots || []) {
    for (const r of slot.internalRoles || []) knownRoles.add(r)
  }
  for (const role of Object.keys((modeConfig && modeConfig.roleOverrides) || {})) {
    if (!knownRoles.has(role) && !isOptionalRole(mode, role)) {
      errors.push(err('unknown-role', 'modeConfiguration.roleOverrides.' + role, 'role ' + role + ' is not part of mode ' + mode.id))
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const bindings = {}
  const roleErrors = []
  const fanout = []
  for (const slot of mode.slots || []) {
    const assignment = modeConfig.slots[slot.id]
    if (!assignment) continue
    for (const role of slot.internalRoles || []) fanout.push([role, assignment])
  }
  const overrides = (modeConfig && modeConfig.roleOverrides) || {}
  for (const role of Object.keys(overrides)) {
    if (!fanout.some(([r]) => r === role) && (knownRoles.has(role) || isOptionalRole(mode, role))) {
      const slot = slotForRole(mode, role)
      const base = slot && modeConfig.slots[slot.id]
      if (base) fanout.push([role, base])
      else if (overrides[role].logicalModelId && overrides[role].routeId && overrides[role].reasoning) {
        fanout.push([role, overrides[role]])
      }
    }
  }
  for (const [role, base] of fanout) {
    const override = overrides[role] || {}
    const assignment = {
      logicalModelId: override.logicalModelId || base.logicalModelId,
      routeId: override.routeId || base.routeId,
      reasoning: override.reasoning || base.reasoning,
    }
    // EM-02: the operator's reasoning policy follows the assignment it was written for
    const policy = override.allowedReasoning !== undefined ? override.allowedReasoning : base.allowedReasoning
    if (policy !== undefined) assignment.allowedReasoning = policy
    const result = resolveRoleBinding(registry, mode, role, assignment, runtime)
    if (result.errors.length > 0) roleErrors.push(...result.errors)
    else bindings[role] = result.binding
  }
  const requiredRoles = mode.internalRoles || []
  for (const role of requiredRoles) {
    if (!bindings[role] && !roleErrors.some((e) => String(e.path).startsWith('roles.' + role))) {
      roleErrors.push(err('mode-config-incomplete', 'roles.' + role, 'required internal role ' + role + ' was not resolved'))
    }
  }
  if (roleErrors.length > 0) return { ok: false, errors: roleErrors }

  const payload = {
    modeId: mode.id,
    orchestrationEngineId: mode.orchestrationEngineId,
    configurationRevision: modeConfig.revision,
    roles: Object.fromEntries(Object.keys(bindings).sort().map((role) => {
      const b = bindings[role]
      return [role, {
        logicalModelId: b.logicalModelId,
        routeId: b.routeId,
        providerId: b.providerId,
        remoteModelId: b.remoteModelId,
        connectionId: b.connectionId,
        executionKind: b.executionKind,
        accessType: b.accessType,
        protocolId: b.protocolId,
        reasoning: b.reasoning,
        ...(b.allowedReasoning !== undefined ? { allowedReasoning: b.allowedReasoning } : {}),
        requiredCapabilities: b.requiredCapabilities,
        slotRequirements: b.slotRequirements,
        dataUseTier: b.dataUseTier,
      }]
    })),
  }
  const resolutionId = resolutionIdOf(payload)
  for (const role of Object.keys(bindings)) {
    bindings[role].resolutionId = resolutionId
    bindings[role].modeConfigRevision = modeConfig.revision
  }
  const snapshot = deepFreeze({
    schemaVersion: 1,
    modeId: mode.id,
    orchestrationEngineId: mode.orchestrationEngineId,
    configurationRevision: modeConfig.revision,
    resolutionId,
    roles: Object.fromEntries(Object.keys(bindings).sort().map((role) => [role, bindings[role]])),
  })
  const snapshotErrors = schemas.validateResolvedModeConfiguration(snapshot, 'resolved')
  if (snapshotErrors.length > 0) return { ok: false, errors: snapshotErrors }
  return { ok: true, snapshot }
}

function validateModeConfig(modeConfig, registry, options) {
  const result = compileModeConfig(modeConfig, registry, options)
  if (result.ok) return []
  return result.errors
}

/**
 * Routes eligible for one slot: correct logical-model match, slot capability
 * contract, engine scope, enabled provider/route, and optional runtime fit.
 * Never throws; unknown mode/slot yields an empty list.
 */
function listEligibleRoutes(modeId, slotId, registry, runtime) {
  if (!registry || !Array.isArray(registry.routes)) return []
  const mode = findMode(registry, modeId)
  if (!mode) return []
  const slot = (mode.slots || []).find((s) => s && s.id === slotId)
  if (!slot) return []
  if (runtime && schemas.validateRuntimeCapabilities(runtime, 'runtime').length > 0) return []
  const models = indexById(registry.models)
  const providers = indexById(registry.providers)
  const connections = indexById(registry.connections)
  const out = []
  for (const route of registry.routes) {
    if (!route || routeEligibility(route)) continue
    const model = models.get(route.logicalModelId)
    if (!model || model.enabled === false) continue
    const provider = providers.get(route.providerId)
    if (!provider || provider.status !== 'enabled') continue
    if (route.connectionId === undefined || route.connectionId === null) continue
    {
      const connection = connections.get(route.connectionId)
      if (!connection || connectionEligibility(connection)) continue
      if (connection.providerId !== route.providerId) continue
    }
    if (checkEngineScope(mode, model, slotId).length > 0) continue
    if (checkRoleCapability(slot, slotId, model, route).length > 0) continue
    if (checkRuntimeCompatibility(route, runtime || null, slotId).length > 0) continue
    out.push(route)
  }
  return out
}

module.exports = {
  compileModeConfig,
  validateModeConfig,
  listEligibleRoutes,
  resolveRoleBinding,
  routeEligibility,
  connectionEligibility,
  deepFreeze,
  canonicalize,
}
