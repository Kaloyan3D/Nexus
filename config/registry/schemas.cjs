'use strict'

/**
 * Registry Core schemas (R1) — versioned, runtime-independent data contracts.
 *
 * Pure CommonJS. No fs, no process.env, no DSH/PowerShell/Rust imports.
 * Every validator is a pure function of its input and returns an array of
 * { code, message, path } errors (empty = valid). Callers fail closed.
 */

const SCHEMA_VERSION = 1

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const MODE_STATUSES = ['deprecated', 'active-legacy', 'active', 'planned']
const TRANSPORT_IDS = ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'local-openai-compatible', 'agent-sdk', 'unknown']
const PROVIDER_STATUSES = ['enabled', 'disabled']
const ACCESS_TYPES = ['api-key', 'subscription-agent', 'subscription-delegated', 'local-server', 'manual-unknown']
const EXECUTION_KINDS = ['raw-model', 'agent-sdk', 'agent-tool']
const ROUTE_AVAILABILITY = ['discovered', 'auth-required', 'probe-required', 'verified', 'unavailable', 'disabled', 'policy-blocked', 'unknown']
const DATA_USE_TIERS = ['standard', 'contributor']
const CONNECTION_KINDS = ['api-key', 'subscription-agent', 'subscription-delegated', 'local-server', 'manual-unknown']
const CONNECTION_STATUSES = ['connected', 'not-connected', 'unknown', 'revoked', 'disabled']

function err(code, path, message) {
  return { code, path, message }
}

function checkSchemaVersion(value, path, errors) {
  if (!value || typeof value !== 'object') {
    errors.push(err('schema-invalid', path, 'document must be an object'))
    return false
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push(err('unsupported-schema-version', path + '.schemaVersion', 'expected schemaVersion 1'))
    return false
  }
  return true
}

function checkId(value, path, errors, pattern) {
  if (typeof value !== 'string' || value === '' || !(pattern || ID_PATTERN).test(value)) {
    errors.push(err('invalid-id', path, 'immutable id must match ' + (pattern || ID_PATTERN)))
    return false
  }
  return true
}

function rejectUnknown(value, allowed, path, errors) {
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(err('unknown-field', path + '.' + key, 'unknown field is rejected by strict schema'))
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/* ── AgentSlot (embedded in ModeDefinition) ─────────────────────────── */

const SLOT_FIELDS = new Set(['id', 'label', 'required', 'internalRoles', 'requirements'])

function validateAgentSlot(slot, path) {
  const errors = []
  if (!isPlainObject(slot)) return [err('slot-invalid', path, 'slot must be an object')]
  rejectUnknown(slot, SLOT_FIELDS, path, errors)
  checkId(slot.id, path + '.id', errors, PROVIDER_ID_PATTERN)
  if (typeof slot.label !== 'string' || slot.label === '') errors.push(err('slot-invalid', path + '.label', 'slot label must be a non-empty string'))
  if (typeof slot.required !== 'boolean') errors.push(err('slot-invalid', path + '.required', 'slot required must be boolean'))
  if (!Array.isArray(slot.internalRoles) || slot.internalRoles.length === 0) {
    errors.push(err('slot-invalid', path + '.internalRoles', 'slot must map at least one internal role'))
  } else {
    for (let i = 0; i < slot.internalRoles.length; i += 1) {
      if (typeof slot.internalRoles[i] !== 'string' || slot.internalRoles[i] === '') {
        errors.push(err('slot-invalid', path + '.internalRoles[' + i + ']', 'internal role must be a non-empty string'))
      }
    }
  }
  if (slot.requirements !== undefined && !isPlainObject(slot.requirements)) {
    errors.push(err('slot-invalid', path + '.requirements', 'slot requirements must be an object'))
  }
  return errors
}

/* ── ModeDefinition ─────────────────────────────────────────────────── */

const MODE_FIELDS = new Set(['schemaVersion', 'id', 'displayName', 'status', 'orchestrationEngineId', 'selectable', 'runnable', 'slots', 'internalRoles', 'optionalCapabilities'])

function validateModeDefinition(doc, path) {
  const errors = []
  const where = path || 'mode'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, MODE_FIELDS, where, errors)
  checkId(doc.id, where + '.id', errors, PROVIDER_ID_PATTERN)
  if (typeof doc.displayName !== 'string' || doc.displayName === '') errors.push(err('mode-invalid', where + '.displayName', 'displayName must be a non-empty string'))
  if (!MODE_STATUSES.includes(doc.status)) errors.push(err('mode-invalid', where + '.status', 'status must be one of ' + MODE_STATUSES.join(', ')))
  if (typeof doc.orchestrationEngineId !== 'string' || doc.orchestrationEngineId === '') errors.push(err('mode-invalid', where + '.orchestrationEngineId', 'orchestrationEngineId must be a non-empty string'))
  if (doc.selectable !== undefined && typeof doc.selectable !== 'boolean') errors.push(err('mode-invalid', where + '.selectable', 'selectable must be boolean'))
  if (doc.runnable !== undefined && typeof doc.runnable !== 'boolean') errors.push(err('mode-invalid', where + '.runnable', 'runnable must be boolean'))
  if (!Array.isArray(doc.slots) || doc.slots.length === 0) {
    errors.push(err('mode-invalid', where + '.slots', 'mode must declare at least one slot'))
  } else {
    const seen = new Set()
    for (let i = 0; i < doc.slots.length; i += 1) {
      const slot = doc.slots[i]
      errors.push(...validateAgentSlot(slot, where + '.slots[' + i + ']').map((e) => e))
      if (slot && typeof slot.id === 'string' && slot.id !== '') {
        if (seen.has(slot.id)) errors.push(err('duplicate-id', where + '.slots[' + i + '].id', 'duplicate slot id: ' + slot.id))
        seen.add(slot.id)
      }
    }
  }
  if (!Array.isArray(doc.internalRoles) || doc.internalRoles.length === 0) {
    errors.push(err('mode-invalid', where + '.internalRoles', 'mode must declare internal roles'))
  } else {
    const covered = new Set()
    for (const slot of doc.slots || []) {
      if (slot && Array.isArray(slot.internalRoles)) for (const r of slot.internalRoles) covered.add(r)
    }
    for (const role of doc.internalRoles) {
      if (typeof role !== 'string' || role === '') errors.push(err('mode-invalid', where + '.internalRoles', 'internal role must be a non-empty string'))
    }
  }
  if (doc.optionalCapabilities !== undefined) {
    if (!Array.isArray(doc.optionalCapabilities)) errors.push(err('mode-invalid', where + '.optionalCapabilities', 'optionalCapabilities must be an array'))
    else for (let i = 0; i < doc.optionalCapabilities.length; i += 1) {
      if (typeof doc.optionalCapabilities[i] !== 'string' || doc.optionalCapabilities[i] === '') {
        errors.push(err('mode-invalid', where + '.optionalCapabilities[' + i + ']', 'capability must be a non-empty string'))
      }
    }
  }
  return errors
}

/* ── ModeConfiguration ──────────────────────────────────────────────── */

const MODE_CONFIG_FIELDS = new Set(['schemaVersion', 'modeId', 'revision', 'slots', 'roleOverrides'])
const SLOT_ASSIGNMENT_FIELDS = new Set(['logicalModelId', 'routeId', 'reasoning'])

function validateSlotAssignment(assignment, path) {
  const errors = []
  if (!isPlainObject(assignment)) return [err('slot-assignment-invalid', path, 'slot assignment must be an object')]
  rejectUnknown(assignment, SLOT_ASSIGNMENT_FIELDS, path, errors)
  if (typeof assignment.logicalModelId !== 'string' || assignment.logicalModelId === '') errors.push(err('slot-assignment-invalid', path + '.logicalModelId', 'logicalModelId is required'))
  if (typeof assignment.routeId !== 'string' || assignment.routeId === '') errors.push(err('slot-assignment-invalid', path + '.routeId', 'routeId is required'))
  if (typeof assignment.reasoning !== 'string' || assignment.reasoning === '') errors.push(err('slot-assignment-invalid', path + '.reasoning', 'reasoning is required'))
  return errors
}

function validateModeConfiguration(doc, path) {
  const errors = []
  const where = path || 'modeConfiguration'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, MODE_CONFIG_FIELDS, where, errors)
  if (typeof doc.modeId !== 'string' || doc.modeId === '') errors.push(err('mode-config-invalid', where + '.modeId', 'modeId is required'))
  if (!Number.isInteger(doc.revision) || doc.revision < 0) errors.push(err('mode-config-invalid', where + '.revision', 'revision must be an integer >= 0'))
  if (!isPlainObject(doc.slots) || Object.keys(doc.slots).length === 0) {
    errors.push(err('mode-config-invalid', where + '.slots', 'at least one slot assignment is required'))
  } else {
    for (const [slotId, assignment] of Object.entries(doc.slots)) {
      errors.push(...validateSlotAssignment(assignment, where + '.slots.' + slotId))
    }
  }
  if (doc.roleOverrides !== undefined) {
    if (!isPlainObject(doc.roleOverrides)) {
      errors.push(err('mode-config-invalid', where + '.roleOverrides', 'roleOverrides must be an object'))
    } else {
      for (const [role, override] of Object.entries(doc.roleOverrides)) {
        if (!isPlainObject(override)) {
          errors.push(err('mode-config-invalid', where + '.roleOverrides.' + role, 'role override must be an object'))
          continue
        }
        for (const key of Object.keys(override)) {
          if (!SLOT_ASSIGNMENT_FIELDS.has(key)) errors.push(err('unknown-field', where + '.roleOverrides.' + role + '.' + key, 'unknown field is rejected by strict schema'))
        }
        if (override.logicalModelId !== undefined && (typeof override.logicalModelId !== 'string' || override.logicalModelId === '')) {
          errors.push(err('mode-config-invalid', where + '.roleOverrides.' + role + '.logicalModelId', 'logicalModelId must be a non-empty string'))
        }
        if (override.routeId !== undefined && (typeof override.routeId !== 'string' || override.routeId === '')) {
          errors.push(err('mode-config-invalid', where + '.roleOverrides.' + role + '.routeId', 'routeId must be a non-empty string'))
        }
        if (override.reasoning !== undefined && (typeof override.reasoning !== 'string' || override.reasoning === '')) {
          errors.push(err('mode-config-invalid', where + '.roleOverrides.' + role + '.reasoning', 'reasoning must be a non-empty string'))
        }
      }
    }
  }
  return errors
}

/* ── LogicalModel ───────────────────────────────────────────────────── */

const LOGICAL_MODEL_FIELDS = new Set(['schemaVersion', 'id', 'vendor', 'displayName', 'checkpoint', 'capabilities', 'dataUseTier', 'enabled', 'engines'])
const CAPABILITY_KEYS = ['textInput', 'imageInput', 'toolCalling', 'streaming', 'reasoning']

function validateLogicalModel(doc, path) {
  const errors = []
  const where = path || 'logicalModel'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, LOGICAL_MODEL_FIELDS, where, errors)
  checkId(doc.id, where + '.id', errors)
  if (typeof doc.vendor !== 'string' || doc.vendor === '') errors.push(err('model-invalid', where + '.vendor', 'vendor must be a non-empty string'))
  if (typeof doc.displayName !== 'string' || doc.displayName === '') errors.push(err('model-invalid', where + '.displayName', 'displayName must be a non-empty string'))
  if (typeof doc.checkpoint !== 'string' || doc.checkpoint === '') errors.push(err('model-invalid', where + '.checkpoint', 'checkpoint must be a non-empty string'))
  if (!isPlainObject(doc.capabilities)) {
    errors.push(err('model-invalid', where + '.capabilities', 'capabilities must be an object'))
  } else {
    for (const key of CAPABILITY_KEYS) {
      if (typeof doc.capabilities[key] !== 'boolean') errors.push(err('model-invalid', where + '.capabilities.' + key, key + ' must be boolean'))
    }
  }
  if (doc.dataUseTier !== undefined && !DATA_USE_TIERS.includes(doc.dataUseTier)) {
    errors.push(err('model-invalid', where + '.dataUseTier', 'dataUseTier must be one of ' + DATA_USE_TIERS.join(', ')))
  }
  if (typeof doc.enabled !== 'boolean') errors.push(err('model-invalid', where + '.enabled', 'enabled must be boolean'))
  if (doc.engines !== undefined) {
    if (!Array.isArray(doc.engines) || doc.engines.length === 0) errors.push(err('model-invalid', where + '.engines', 'engines must be a non-empty array when present'))
    else for (let i = 0; i < doc.engines.length; i += 1) {
      if (typeof doc.engines[i] !== 'string' || doc.engines[i] === '') errors.push(err('model-invalid', where + '.engines[' + i + ']', 'engine id must be a non-empty string'))
    }
  }
  return errors
}

/* ── Provider ───────────────────────────────────────────────────────── */

const PROVIDER_FIELDS = new Set(['schemaVersion', 'id', 'name', 'transportId', 'baseUrl', 'discovery', 'status', 'legacyDshProviderId'])

function validateProvider(doc, path) {
  const errors = []
  const where = path || 'provider'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, PROVIDER_FIELDS, where, errors)
  checkId(doc.id, where + '.id', errors, PROVIDER_ID_PATTERN)
  if (typeof doc.name !== 'string' || doc.name === '') errors.push(err('provider-invalid', where + '.name', 'name must be a non-empty string'))
  if (!TRANSPORT_IDS.includes(doc.transportId)) errors.push(err('provider-invalid', where + '.transportId', 'transportId must be one of ' + TRANSPORT_IDS.join(', ')))
  if (doc.baseUrl !== undefined) {
    if (typeof doc.baseUrl !== 'string' || doc.baseUrl === '') {
      errors.push(err('provider-invalid', where + '.baseUrl', 'baseUrl must be a non-empty string'))
    } else {
      try {
        const parsed = new URL(doc.baseUrl)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          errors.push(err('provider-invalid', where + '.baseUrl', 'baseUrl must use http or https'))
        }
      } catch {
        errors.push(err('provider-invalid', where + '.baseUrl', 'baseUrl must be a valid URL'))
      }
    }
  }
  if (!PROVIDER_STATUSES.includes(doc.status)) errors.push(err('provider-invalid', where + '.status', 'status must be one of ' + PROVIDER_STATUSES.join(', ')))
  if (doc.legacyDshProviderId !== undefined && (typeof doc.legacyDshProviderId !== 'string' || doc.legacyDshProviderId === '')) {
    errors.push(err('provider-invalid', where + '.legacyDshProviderId', 'legacyDshProviderId must be a non-empty string'))
  }
  return errors
}

/* ── ModelRoute ─────────────────────────────────────────────────────── */

const ROUTE_FIELDS = new Set(['schemaVersion', 'id', 'providerId', 'logicalModelId', 'remoteModelId', 'accessType', 'connectionId', 'executionKind', 'reasoningLevels', 'compatibility', 'availability', 'enabled'])

function validateModelRoute(doc, path) {
  const errors = []
  const where = path || 'route'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, ROUTE_FIELDS, where, errors)
  checkId(doc.id, where + '.id', errors)
  if (typeof doc.providerId !== 'string' || doc.providerId === '') errors.push(err('route-invalid', where + '.providerId', 'providerId is required'))
  if (typeof doc.logicalModelId !== 'string' || doc.logicalModelId === '') errors.push(err('route-invalid', where + '.logicalModelId', 'logicalModelId is required'))
  if (typeof doc.remoteModelId !== 'string' || doc.remoteModelId === '') errors.push(err('route-invalid', where + '.remoteModelId', 'remoteModelId is required'))
  if (!ACCESS_TYPES.includes(doc.accessType)) errors.push(err('route-invalid', where + '.accessType', 'accessType must be one of ' + ACCESS_TYPES.join(', ')))
  if (doc.connectionId !== undefined && doc.connectionId !== null && (typeof doc.connectionId !== 'string' || doc.connectionId === '')) {
    errors.push(err('route-invalid', where + '.connectionId', 'connectionId must be a non-empty string or null'))
  }
  if (!EXECUTION_KINDS.includes(doc.executionKind)) errors.push(err('route-invalid', where + '.executionKind', 'executionKind must be one of ' + EXECUTION_KINDS.join(', ')))
  if (!Array.isArray(doc.reasoningLevels) || doc.reasoningLevels.length === 0) {
    errors.push(err('route-invalid', where + '.reasoningLevels', 'at least one reasoning level is required'))
  } else {
    for (let i = 0; i < doc.reasoningLevels.length; i += 1) {
      if (typeof doc.reasoningLevels[i] !== 'string' || doc.reasoningLevels[i] === '') {
        errors.push(err('route-invalid', where + '.reasoningLevels[' + i + ']', 'reasoning level must be a non-empty string'))
      }
    }
  }
  if (doc.compatibility !== undefined && !isPlainObject(doc.compatibility)) {
    errors.push(err('route-invalid', where + '.compatibility', 'compatibility must be an object'))
  }
  if (!ROUTE_AVAILABILITY.includes(doc.availability)) errors.push(err('route-invalid', where + '.availability', 'availability must be one of ' + ROUTE_AVAILABILITY.join(', ')))
  if (doc.enabled !== undefined && typeof doc.enabled !== 'boolean') errors.push(err('route-invalid', where + '.enabled', 'enabled must be boolean'))
  return errors
}

/* ── Connection ─────────────────────────────────────────────────────── */

const CONNECTION_FIELDS = new Set(['schemaVersion', 'id', 'providerId', 'connectionKind', 'authMethod', 'credentialRef', 'status'])

function validateConnection(doc, path) {
  const errors = []
  const where = path || 'connection'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, CONNECTION_FIELDS, where, errors)
  checkId(doc.id, where + '.id', errors, PROVIDER_ID_PATTERN)
  if (typeof doc.providerId !== 'string' || doc.providerId === '') errors.push(err('connection-invalid', where + '.providerId', 'providerId is required'))
  if (!CONNECTION_KINDS.includes(doc.connectionKind)) errors.push(err('connection-invalid', where + '.connectionKind', 'connectionKind must be one of ' + CONNECTION_KINDS.join(', ')))
  if (doc.authMethod !== undefined && (typeof doc.authMethod !== 'string' || doc.authMethod === '')) {
    errors.push(err('connection-invalid', where + '.authMethod', 'authMethod must be a non-empty string'))
  }
  if (doc.credentialRef !== undefined && doc.credentialRef !== null) {
    if (typeof doc.credentialRef !== 'string' || !doc.credentialRef.startsWith('credential://')) {
      errors.push(err('connection-invalid', where + '.credentialRef', 'credentialRef must be an opaque credential:// reference, never secret material'))
    }
  }
  if (!CONNECTION_STATUSES.includes(doc.status)) errors.push(err('connection-invalid', where + '.status', 'status must be one of ' + CONNECTION_STATUSES.join(', ')))
  return errors
}

/* ── ResolvedModeConfiguration / RuntimeModelBinding ─────────────────── */

const SNAPSHOT_FIELDS = new Set(['schemaVersion', 'modeId', 'orchestrationEngineId', 'configurationRevision', 'resolutionId', 'roles'])
const BINDING_FIELDS = new Set(['schemaVersion', 'resolutionId', 'modeId', 'orchestrationEngineId', 'modeConfigRevision', 'roleId', 'logicalModelId', 'routeId', 'providerId', 'remoteModelId', 'connectionId', 'executionKind', 'protocolId', 'reasoning', 'requiredCapabilities', 'dataUseTier'])

function validateRuntimeModelBinding(doc, path) {
  const errors = []
  const where = path || 'binding'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, BINDING_FIELDS, where, errors)
  if (typeof doc.resolutionId !== 'string' || !/^[0-9a-f]{64}$/.test(doc.resolutionId)) errors.push(err('binding-invalid', where + '.resolutionId', 'resolutionId must be 64-hex sha256'))
  for (const key of ['modeId', 'orchestrationEngineId', 'roleId', 'logicalModelId', 'routeId', 'providerId', 'remoteModelId', 'executionKind', 'protocolId', 'reasoning']) {
    if (typeof doc[key] !== 'string' || doc[key] === '') errors.push(err('binding-invalid', where + '.' + key, key + ' is required'))
  }
  if (!Number.isInteger(doc.modeConfigRevision) || doc.modeConfigRevision < 0) errors.push(err('binding-invalid', where + '.modeConfigRevision', 'modeConfigRevision must be an integer >= 0'))
  if (doc.connectionId !== undefined && doc.connectionId !== null && (typeof doc.connectionId !== 'string' || doc.connectionId === '')) {
    errors.push(err('binding-invalid', where + '.connectionId', 'connectionId must be a non-empty string or null'))
  }
  if (!Array.isArray(doc.requiredCapabilities)) errors.push(err('binding-invalid', where + '.requiredCapabilities', 'requiredCapabilities must be an array'))
  return errors
}

function validateResolvedModeConfiguration(doc, path) {
  const errors = []
  const where = path || 'resolved'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, SNAPSHOT_FIELDS, where, errors)
  if (typeof doc.modeId !== 'string' || doc.modeId === '') errors.push(err('snapshot-invalid', where + '.modeId', 'modeId is required'))
  if (typeof doc.orchestrationEngineId !== 'string' || doc.orchestrationEngineId === '') errors.push(err('snapshot-invalid', where + '.orchestrationEngineId', 'orchestrationEngineId is required'))
  if (!Number.isInteger(doc.configurationRevision) || doc.configurationRevision < 0) {
    errors.push(err('snapshot-invalid', where + '.configurationRevision', 'configurationRevision must be an integer >= 0'))
  }
  if (typeof doc.resolutionId !== 'string' || !/^[0-9a-f]{64}$/.test(doc.resolutionId)) {
    errors.push(err('snapshot-invalid', where + '.resolutionId', 'resolutionId must be 64-hex sha256'))
  }
  if (!isPlainObject(doc.roles) || Object.keys(doc.roles).length === 0) {
    errors.push(err('snapshot-invalid', where + '.roles', 'at least one role binding is required'))
  } else {
    for (const [role, binding] of Object.entries(doc.roles)) {
      errors.push(...validateRuntimeModelBinding(binding, where + '.roles.' + role))
    }
  }
  return errors
}

/* ── Registry snapshot (cross-reference + duplicate checks) ─────────── */

const SNAPSHOT_DOC_FIELDS = new Set(['schemaVersion', 'modes', 'models', 'providers', 'routes', 'connections'])

function collectDuplicates(items, path, errors) {
  const seen = new Set()
  for (let i = 0; i < items.length; i += 1) {
    const id = items[i] && typeof items[i].id === 'string' ? items[i].id : ''
    if (id === '') continue
    if (seen.has(id)) errors.push(err('duplicate-id', path + '[' + i + '].id', 'duplicate id: ' + id))
    seen.add(id)
  }
}

function validateRegistrySnapshot(doc, path) {
  const errors = []
  const where = path || 'registry'
  if (!checkSchemaVersion(doc, where, errors)) return errors
  rejectUnknown(doc, SNAPSHOT_DOC_FIELDS, where, errors)
  for (const key of ['modes', 'models', 'providers', 'routes', 'connections']) {
    if (!Array.isArray(doc[key])) errors.push(err('registry-invalid', where + '.' + key, key + ' must be an array'))
  }
  if (errors.length > 0) return errors
  collectDuplicates(doc.modes, where + '.modes', errors)
  collectDuplicates(doc.models, where + '.models', errors)
  collectDuplicates(doc.providers, where + '.providers', errors)
  collectDuplicates(doc.routes, where + '.routes', errors)
  collectDuplicates(doc.connections, where + '.connections', errors)
  doc.modes.forEach((m, i) => errors.push(...validateModeDefinition(m, where + '.modes[' + i + ']')))
  doc.models.forEach((m, i) => errors.push(...validateLogicalModel(m, where + '.models[' + i + ']')))
  doc.providers.forEach((p, i) => errors.push(...validateProvider(p, where + '.providers[' + i + ']')))
  doc.routes.forEach((r, i) => errors.push(...validateModelRoute(r, where + '.routes[' + i + ']')))
  doc.connections.forEach((c, i) => errors.push(...validateConnection(c, where + '.connections[' + i + ']')))
  if (errors.length > 0) return errors
  const models = new Set(doc.models.map((m) => m.id))
  const providers = new Set(doc.providers.map((p) => p.id))
  const connections = new Map(doc.connections.map((c) => [c.id, c]))
  doc.routes.forEach((r, i) => {
    if (!models.has(r.logicalModelId)) errors.push(err('unknown-reference', where + '.routes[' + i + '].logicalModelId', 'unknown logical model: ' + r.logicalModelId))
    if (!providers.has(r.providerId)) errors.push(err('unknown-reference', where + '.routes[' + i + '].providerId', 'unknown provider: ' + r.providerId))
    if (r.connectionId !== undefined && r.connectionId !== null) {
      const conn = connections.get(r.connectionId)
      if (!conn) errors.push(err('unknown-reference', where + '.routes[' + i + '].connectionId', 'unknown connection: ' + r.connectionId))
      else if (conn.providerId !== r.providerId) errors.push(err('connection-provider-mismatch', where + '.routes[' + i + '].connectionId', 'connection provider mismatch for route ' + r.id))
    }
  })
  return errors
}

module.exports = {
  SCHEMA_VERSION,
  validateAgentSlot,
  validateModeDefinition,
  validateModeConfiguration,
  validateLogicalModel,
  validateProvider,
  validateModelRoute,
  validateConnection,
  validateRuntimeModelBinding,
  validateResolvedModeConfiguration,
  validateRegistrySnapshot,
}
