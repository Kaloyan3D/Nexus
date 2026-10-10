'use strict'

/**
 * Registry R4.1 — Nexus-owned operator catalog persistence.
 *
 * Operator-owned overlays for providers, logical models, model routes and
 * connections. Built-in records (derived read-only from legacy configs via
 * legacy-import + muse-canonical) are NEVER written here; this store holds
 * only operator data plus disable-overlays for built-in ids. The service
 * layer merges built-ins + operator docs into the effective snapshot, so
 * built-in identity is preserved and operator data is never blindly
 * overwritten by upgrades.
 *
 * Files (all under <dataRoot>/registry/):
 *   custom-providers.json   operator providers (no secrets, no DSH ids)
 *   custom-models.json      operator logical models
 *   routes.json             operator routes (materialized, non-secret)
 *   connections.json        operator connections (credential refs only)
 *
 * Each file: { schemaVersion: 1, revision, updatedAtUtc,
 *              items: { <id>: { record, provenance: 'operator',
 *                               recordVersion, updatedAtUtc } },
 *              disabledBuiltins: { <builtinId>: { disabled: true, updatedAtUtc } } }
 *
 * Guarantees:
 * - Revision-checked atomic writes (per-file revision + shared catalog.lock
 *   with the R4-corrected reclamation rule: a live owner never loses its
 *   lock at any age; reclaim only from dead/invalid pids or unreadable
 *   claims past the hard age). Temp file + atomic rename; no partial save.
 * - No destructive delete of anything referenced by a saved mode
 *   configuration (callers pass savedRefs); blocked deletes report the
 *   dependency with code 'dependency-blocked' for a separate safe-migration
 *   decision.
 * - Built-in ids cannot be overwritten (code 'duplicate-id'); built-ins are
 *   disabled via overlay, never mutated.
 * - Secret-free: scanForSecrets over every record; credential values are
 *   rejected, opaque credential:// references only on connections.
 *
 * Pure Nexus-owned CommonJS: node stdlib + sibling schemas/provider-config
 * only. No DSH, PowerShell, network, sessions. fs injectable for tests.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const schemas = require('./schemas.cjs')
const providerConfig = require('./provider-config.cjs')
const configStore = require('./config-store.cjs')

const CATALOG_SCHEMA_VERSION = 1
const STORE_DIR = 'registry'
const FILES = Object.freeze({
  providers: 'custom-providers.json',
  models: 'custom-models.json',
  routes: 'routes.json',
  connections: 'connections.json',
  evidence: 'route-evidence.json',
})
const CLAIM_STALE_MS = 30000
const LOCK_HARD_STALE_MS = 600000
const CLAIM_MAX_ATTEMPTS = 2
let tempCounter = 0

function err(code, p, message) {
  return { code, path: p, message }
}

function defaultFsHooks() {
  return {
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    writeFileExclusive: (p, data, opts) => fs.writeFileSync(p, data, Object.assign({}, opts || {}, { flag: 'wx' })),
    renameSync: (a, b) => fs.renameSync(a, b),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    unlinkSync: (p) => fs.unlinkSync(p),
    chmodSync: (p, mode) => fs.chmodSync(p, mode),
    statSync: (p) => fs.statSync(p),
  }
}

function docPath(dataRoot, kind) {
  return path.join(String(dataRoot), STORE_DIR, FILES[kind])
}
function lockPath(dataRoot) {
  return path.join(String(dataRoot), STORE_DIR, 'catalog.lock')
}
function readLockOwner(hooks, lp) {
  try {
    const raw = hooks.readFileSync(lp, 'utf8')
    const doc = JSON.parse(raw)
    if (doc && typeof doc === 'object') return doc
    return null
  } catch {
    return null
  }
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !e || e.code !== 'ESRCH'
  }
}
function lockAgeMs(hooks, lp) {
  try {
    return Date.now() - hooks.statSync(lp).mtimeMs
  } catch {
    return null
  }
}
function nextTempPath(target) {
  tempCounter = (tempCounter + 1) % 1000000
  return target + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + tempCounter + '-' + crypto.randomBytes(8).toString('hex')
}

function emptyDoc() {
  return { schemaVersion: CATALOG_SCHEMA_VERSION, revision: 0, updatedAtUtc: null, items: {}, disabledBuiltins: {} }
}

function loadDoc(dataRoot, kind, hooks) {
  const filePath = docPath(dataRoot, kind)
  let raw = null
  try {
    raw = hooks.readFileSync(filePath, 'utf8')
  } catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT/.test(String((e && e.message) || '')))) {
      return { doc: emptyDoc(), errors: [] }
    }
    return { doc: null, errors: [err('registry-store-unreadable', 'catalog.' + kind, 'operator catalog file cannot be read: ' + FILES[kind])] }
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { doc: null, errors: [err('registry-store-corrupt', 'catalog.' + kind, 'operator catalog file is not valid JSON: ' + FILES[kind])] }
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== CATALOG_SCHEMA_VERSION || !parsed.items || typeof parsed.items !== 'object') {
    return { doc: null, errors: [err('registry-store-corrupt', 'catalog.' + kind, 'operator catalog file has an unsupported schema: ' + FILES[kind])] }
  }
  return {
    doc: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
      updatedAtUtc: typeof parsed.updatedAtUtc === 'string' ? parsed.updatedAtUtc : null,
      items: parsed.items,
      disabledBuiltins: parsed.disabledBuiltins && typeof parsed.disabledBuiltins === 'object' ? parsed.disabledBuiltins : {},
    },
    errors: [],
  }
}

function loadOperatorDocs(dataRoot, fsHooks) {
  const hooks = fsHooks || defaultFsHooks()
  const out = {}
  const errors = []
  for (const kind of Object.keys(FILES)) {
    const loaded = loadDoc(dataRoot, kind, hooks)
    if (!loaded.doc) {
      errors.push(...loaded.errors)
    } else {
      out[kind] = loaded.doc
    }
  }
  if (errors.length > 0) return { docs: null, errors }
  return { docs: out, errors: [] }
}

// --- validation per kind (schema + R4 policy) ----------------------------

function validateRecord(kind, record, options) {
  switch (kind) {
    case 'providers': {
      const errors = schemas.validateProvider(record, 'provider')
      if (errors.length > 0) return errors
      // R4.2 onboarding policy: supported dialects + SSRF + no secrets.
      errors.push(...providerConfig.validateProviderInput({
        id: record.id,
        name: record.name,
        transportId: record.transportId,
        baseUrl: record.baseUrl,
        authType: record.authType,
        metadata: record.metadata,
      }, options))
      return errors
    }
    case 'models':
      return schemas.validateLogicalModel(record, 'model')
    case 'routes':
      return schemas.validateModelRoute(record, 'route')
    case 'connections': {
      const errors = schemas.validateConnection(record, 'connection')
      if (errors.length > 0) return errors
      // R4.3: credential refs only; subscription kinds belong to R5.
      if (record.connectionKind === 'subscription-agent' || record.connectionKind === 'subscription-delegated') {
        errors.push(err('connection-invalid', 'connection.connectionKind', 'subscription connection kinds belong to R5 and cannot be created through the R4 manual API flow'))
      }
      return errors
    }
    default:
      return [err('catalog-invalid', 'catalog', 'unknown catalog kind: ' + kind)]
  }
}

function scanRecord(kind, record) {
  const hits = []
  if (kind === 'evidence') return hits
  configStore.scanForSecrets(record, kind, hits)
  // Connections may carry credentialRef (credential://...) — the secret scan
  // allows that shape; anything else secret-shaped is already flagged.
  return hits
}

/**
 * Normalize a stored evidence envelope. R4 stored the evidence object
 * directly; R4.1 stores { current, attempts } so failed re-probes preserve
 * history for diagnostics while only the current attempt decides anything.
 */
function normalizeEvidenceEnvelope(record) {
  if (record && typeof record === 'object' && Array.isArray(record.attempts)) {
    return { current: record.current !== undefined ? record.current : null, attempts: record.attempts }
  }
  if (record && typeof record === 'object') return { current: record, attempts: [] }
  return { current: null, attempts: [] }
}

/**
 * Persist redacted verification evidence for a route. Evidence is
 * operator-owned diagnostics (checks, transport, timestamps) and never
 * carries secret material — scan enforced. Stored outside the canonical
 * route record so catalog data stays free of run-specific metadata.
 * History is preserved: each save appends the previous current attempt
 * (bounded to the last 10) so a failed re-probe never erases the
 * diagnostic trail — while eligibility only ever reads the current one.
 */
function saveEvidence(dataRoot, routeId, evidence, options) {
  const opts = options || {}
  const hooks = opts.fsHooks || defaultFsHooks()
  const nowUtc = typeof opts.nowUtc === 'function' ? opts.nowUtc : () => new Date().toISOString()
  if (typeof routeId !== 'string' || routeId === '') {
    return { ok: false, errors: [err('catalog-invalid', 'catalog.evidence', 'route id is required')] }
  }
  const text = JSON.stringify(evidence)
  if (/sk-(live|proj)-|xox[bap]-|ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /\"apiKey\"\s*:|\"token\"\s*:\"(?!credential:\/\/)/.test(text)) {
    return { ok: false, errors: [err('secret-material-rejected', 'catalog.evidence', 'verification evidence must be redacted; refusing to persist secret-shaped material')] }
  }
  return withCatalogLock(dataRoot, hooks, () => {
    const loaded = loadDoc(dataRoot, 'evidence', hooks)
    if (!loaded.doc) return { ok: false, errors: loaded.errors }
    const next = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: loaded.doc.revision,
      updatedAtUtc: loaded.doc.updatedAtUtc,
      items: Object.assign({}, loaded.doc.items),
      disabledBuiltins: {},
    }
    const prevEnvelope = next.items[routeId] ? normalizeEvidenceEnvelope(next.items[routeId].record) : { current: null, attempts: [] }
    const attempts = prevEnvelope.attempts.slice()
    if (prevEnvelope.current) attempts.push(prevEnvelope.current)
    const record = { current: JSON.parse(JSON.stringify(evidence)), attempts: attempts.slice(-10) }
    next.items[routeId] = { record, provenance: 'operator', recordVersion: (next.items[routeId] ? next.items[routeId].recordVersion + 1 : 1), updatedAtUtc: nowUtc() }
    if (!writeDocAtomic(dataRoot, 'evidence', hooks, next, nowUtc)) {
      return { ok: false, errors: [err('registry-store-unwritable', 'catalog.evidence', 'verification evidence cannot be written')] }
    }
    return { ok: true, revision: next.revision }
  })
}

function loadEvidence(dataRoot, fsHooks) {
  const hooks = fsHooks || defaultFsHooks()
  const loaded = loadDoc(dataRoot, 'evidence', hooks)
  if (!loaded.doc) return { evidence: null, errors: loaded.errors }
  const out = {}
  for (const id of Object.keys(loaded.doc.items)) {
    out[id] = loaded.doc.items[id].record
  }
  return { evidence: out, errors: [] }
}

function currentEvidence(envelope) {
  return normalizeEvidenceEnvelope(envelope).current
}

function evidenceAttempts(envelope) {
  return normalizeEvidenceEnvelope(envelope).attempts
}

// --- dependency guard ------------------------------------------------------

function dependencyOf(kind, id, savedRefs) {
  if (!savedRefs) return null
  const uses = []
  const sets = savedRefs.routeIds && savedRefs.routeIds.indexOf
    ? null
    : savedRefs
  function has(set, value) {
    if (!set) return false
    if (typeof set.has === 'function') return set.has(value)
    if (Array.isArray(set)) return set.indexOf(value) !== -1
    return !!set[value]
  }
  if (kind === 'routes' && has(savedRefs.routeIds, id)) uses.push('saved-configuration route ' + id)
  if (kind === 'providers') {
    if (has(savedRefs.providerIds, id)) uses.push('saved-configuration provider ' + id)
    // A provider with routes referenced anywhere is itself referenced.
    const routes = savedRefs.routeProviders || null
    if (routes && routes[id] && routes[id].length > 0) {
      uses.push('provider ' + id + ' owns referenced route(s): ' + routes[id].slice(0, 5).join(', '))
    }
  }
  if (kind === 'models' && has(savedRefs.modelIds, id)) uses.push('saved-configuration model ' + id)
  if (kind === 'connections' && has(savedRefs.connectionIds, id)) uses.push('saved-configuration connection ' + id)
  if (uses.length === 0) return null
  return uses
}

// --- locked write -----------------------------------------------------------

function withCatalogLock(dataRoot, hooks, mutate) {
  const lp = lockPath(dataRoot)
  const token = process.pid + '-' + crypto.randomBytes(8).toString('hex')
  const payload = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })
  const conflict = () => ({
    ok: false,
    errors: [err('write-conflict', 'catalog', 'a concurrent writer holds the catalog mutation lock; reload and retry')],
  })
  const releaseOwn = () => {
    try {
      const owner = readLockOwner(hooks, lp)
      if (owner && owner.token === token) hooks.unlinkSync(lp)
    } catch { /* best effort */ }
  }
  for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt += 1) {
    let held = false
    try {
      hooks.mkdirSync(path.join(String(dataRoot), STORE_DIR), { recursive: true })
      hooks.writeFileExclusive(lp, payload, { encoding: 'utf8', mode: 0o600 })
      held = true
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return { ok: false, errors: [err('registry-store-unwritable', 'catalog', 'operator catalog cannot be written')] }
      }
      const age = lockAgeMs(hooks, lp)
      if (age === null) continue
      // R4-corrected reclamation: live owners never lose the lock at any
      // age; reclaim only from dead/invalid pids or unreadable claims past
      // the hard age.
      if (age > CLAIM_STALE_MS) {
        const owner = readLockOwner(hooks, lp)
        const provablyInactive = !!owner && (owner.pid === undefined || !isPidAlive(owner.pid))
        const unreadablePastHard = !owner && age > LOCK_HARD_STALE_MS
        if (provablyInactive || unreadablePastHard) {
          try {
            hooks.unlinkSync(lp)
          } catch {
            return conflict()
          }
          continue
        }
        return conflict()
      }
      return conflict()
    }
    if (!held) return conflict()
    let result = null
    try {
      result = mutate()
    } catch {
      releaseOwn()
      return { ok: false, errors: [err('registry-store-unwritable', 'catalog', 'operator catalog mutation failed')] }
    }
    // mutate() performs its own file writes; we only release the lock here.
    // On failure mutate() must have left prior files intact (temp+rename).
    releaseOwn()
    return result
  }
  return conflict()
}

function writeDocAtomic(dataRoot, kind, hooks, next, nowUtc) {
  const target = docPath(dataRoot, kind)
  next.revision += 1
  next.updatedAtUtc = nowUtc()
  const tmp = nextTempPath(target)
  try {
    hooks.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    try { hooks.chmodSync(tmp, 0o600) } catch { /* Windows ACLs differ */ }
    hooks.renameSync(tmp, target)
  } catch {
    try { hooks.unlinkSync(tmp) } catch { /* best effort */ }
    return false
  }
  return true
}

// --- public mutations ---------------------------------------------------------

/**
 * Save (create or update) one operator record. options:
 *   { expectedRevision (file-level optimistic concurrency, null for any),
 *     builtInIds: { providers:[], models:[], routes:[], connections:[] },
 *     nowUtc, fsHooks, endpointOptions (trustedPrivateNetwork/allowPrivateLocal) }
 */
function saveRecord(dataRoot, kind, record, options) {
  const opts = options || {}
  const hooks = opts.fsHooks || defaultFsHooks()
  const nowUtc = typeof opts.nowUtc === 'function' ? opts.nowUtc : () => new Date().toISOString()
  if (!record || typeof record.id !== 'string' || record.id === '') {
    return { ok: false, errors: [err('catalog-invalid', 'catalog.' + kind, 'record id is required')] }
  }
  const builtInIds = opts.builtInIds || {}
  const builtins = builtInIds[kind] || []
  if (builtins.indexOf(record.id) !== -1) {
    return { ok: false, errors: [err('duplicate-id', 'catalog.' + kind + '.' + record.id, 'id ' + record.id + ' collides with a built-in ' + kind.slice(0, -1) + '; built-in identity is preserved and cannot be overwritten')] }
  }
  const shapeErrors = validateRecord(kind, record, opts.endpointOptions)
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors }
  const secretHits = scanRecord(kind, record)
  if (secretHits.length > 0) return { ok: false, errors: secretHits }

  return withCatalogLock(dataRoot, hooks, () => {
    const loaded = loadDoc(dataRoot, kind, hooks)
    if (!loaded.doc) return { ok: false, errors: loaded.errors }
    if (opts.expectedRevision !== null && opts.expectedRevision !== undefined && loaded.doc.revision !== opts.expectedRevision) {
      return { ok: false, errors: [err('stale-revision', 'catalog.' + kind, 'stale catalog revision for ' + kind + ': expected ' + String(opts.expectedRevision) + ', stored ' + String(loaded.doc.revision))] }
    }
    const prev = loaded.doc.items[record.id] || null
    const next = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: loaded.doc.revision,
      updatedAtUtc: loaded.doc.updatedAtUtc,
      items: Object.assign({}, loaded.doc.items),
      disabledBuiltins: Object.assign({}, loaded.doc.disabledBuiltins),
    }
    next.items[record.id] = {
      record: JSON.parse(JSON.stringify(record)),
      provenance: 'operator',
      recordVersion: prev ? prev.recordVersion + 1 : 1,
      updatedAtUtc: nowUtc(),
    }
    if (!writeDocAtomic(dataRoot, kind, hooks, next, nowUtc)) {
      return { ok: false, errors: [err('registry-store-unwritable', 'catalog.' + kind, 'operator catalog cannot be written')] }
    }
    return { ok: true, revision: next.revision, recordVersion: next.items[record.id].recordVersion }
  })
}

/**
 * Disable a provider / model / route. Operator records flip their own
 * status; built-in ids gain a disable-overlay (built-ins stay immutable).
 * Blocked when saved configurations reference the target.
 */
function disableRecord(dataRoot, kind, id, options) {
  const opts = options || {}
  const hooks = opts.fsHooks || defaultFsHooks()
  const nowUtc = typeof opts.nowUtc === 'function' ? opts.nowUtc : () => new Date().toISOString()
  const builtInIds = opts.builtInIds || {}
  const builtins = builtInIds[kind] || []
  const isBuiltin = builtins.indexOf(id) !== -1
  const dep = dependencyOf(kind, id, opts.savedRefs)
  if (dep) {
    return { ok: false, errors: [err('dependency-blocked', 'catalog.' + kind + '.' + id, 'cannot disable ' + kind.slice(0, -1) + ' ' + id + ': referenced by ' + dep.join('; ') + '; choose a safe migration first')] }
  }
  return withCatalogLock(dataRoot, hooks, () => {
    const loaded = loadDoc(dataRoot, kind, hooks)
    if (!loaded.doc) return { ok: false, errors: loaded.errors }
    if (opts.expectedRevision !== null && opts.expectedRevision !== undefined && loaded.doc.revision !== opts.expectedRevision) {
      return { ok: false, errors: [err('stale-revision', 'catalog.' + kind, 'stale catalog revision for ' + kind)] }
    }
    const next = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: loaded.doc.revision,
      updatedAtUtc: loaded.doc.updatedAtUtc,
      items: Object.assign({}, loaded.doc.items),
      disabledBuiltins: Object.assign({}, loaded.doc.disabledBuiltins),
    }
    if (isBuiltin) {
      next.disabledBuiltins[id] = { disabled: true, updatedAtUtc: nowUtc() }
    } else {
      const prev = next.items[id]
      if (!prev) return { ok: false, errors: [err('unknown-reference', 'catalog.' + kind + '.' + id, 'unknown operator ' + kind.slice(0, -1) + ': ' + id)] }
      const rec = JSON.parse(JSON.stringify(prev.record))
      if (kind === 'providers') rec.status = 'disabled'
      else if (kind === 'models') rec.enabled = false
      else if (kind === 'routes') { rec.availability = 'disabled'; rec.enabled = false }
      else if (kind === 'connections') rec.status = 'disabled'
      next.items[id] = { record: rec, provenance: 'operator', recordVersion: prev.recordVersion + 1, updatedAtUtc: nowUtc() }
    }
    if (!writeDocAtomic(dataRoot, kind, hooks, next, nowUtc)) {
      return { ok: false, errors: [err('registry-store-unwritable', 'catalog.' + kind, 'operator catalog cannot be written')] }
    }
    return { ok: true, revision: next.revision }
  })
}

/**
 * Delete an operator record. Built-ins can never be deleted. Blocked when
 * referenced by saved configurations (report + require safe migration).
 */
function deleteRecord(dataRoot, kind, id, options) {
  const opts = options || {}
  const hooks = opts.fsHooks || defaultFsHooks()
  const nowUtc = typeof opts.nowUtc === 'function' ? opts.nowUtc : () => new Date().toISOString()
  const builtInIds = opts.builtInIds || {}
  if ((builtInIds[kind] || []).indexOf(id) !== -1) {
    return { ok: false, errors: [err('dependency-blocked', 'catalog.' + kind + '.' + id, 'built-in ' + kind.slice(0, -1) + ' ' + id + ' cannot be deleted; disable it instead')] }
  }
  const dep = dependencyOf(kind, id, opts.savedRefs)
  if (dep) {
    return { ok: false, errors: [err('dependency-blocked', 'catalog.' + kind + '.' + id, 'cannot delete ' + kind.slice(0, -1) + ' ' + id + ': referenced by ' + dep.join('; ') + '; choose a safe migration first')] }
  }
  return withCatalogLock(dataRoot, hooks, () => {
    const loaded = loadDoc(dataRoot, kind, hooks)
    if (!loaded.doc) return { ok: false, errors: loaded.errors }
    if (!loaded.doc.items[id]) {
      return { ok: false, errors: [err('unknown-reference', 'catalog.' + kind + '.' + id, 'unknown operator ' + kind.slice(0, -1) + ': ' + id)] }
    }
    const next = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: loaded.doc.revision,
      updatedAtUtc: loaded.doc.updatedAtUtc,
      items: Object.assign({}, loaded.doc.items),
      disabledBuiltins: Object.assign({}, loaded.doc.disabledBuiltins),
    }
    delete next.items[id]
    if (!writeDocAtomic(dataRoot, kind, hooks, next, nowUtc)) {
      return { ok: false, errors: [err('registry-store-unwritable', 'catalog.' + kind, 'operator catalog cannot be written')] }
    }
    return { ok: true, revision: next.revision }
  })
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  FILES,
  saveEvidence,
  loadEvidence,
  normalizeEvidenceEnvelope,
  currentEvidence,
  evidenceAttempts,
  CLAIM_STALE_MS,
  LOCK_HARD_STALE_MS,
  docPath,
  loadDoc,
  loadOperatorDocs,
  validateRecord,
  saveRecord,
  disableRecord,
  deleteRecord,
  defaultFsHooks,
}
