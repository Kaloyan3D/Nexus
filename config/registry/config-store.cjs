'use strict'

/**
 * Registry R3 — Nexus-owned mode-configuration persistence.
 *
 * Minimal durable store for staged Registry ModeConfigurations. Location:
 *
 *   <dataRoot>/registry/mode-configurations.json
 *
 * deliberately separate from git-managed built-ins (config/), DSH-generated
 * settings (data/settings.yaml), legacy user settings, DSH session state and
 * credential storage. The file holds operator staged preferences ONLY — it is
 * never consulted by the production controller until R6, and a save here
 * never modifies an active session binding (see R3.6 session-pinning).
 *
 * Document shape:
 *
 *   { schemaVersion: 1, updatedAtUtc: <iso>,
 *     modes: { <modeId>: { revision: <int>=0, config: ModeConfiguration,
 *                           savedAtUtc: <iso>, source: 'operator-save'|'legacy-adopt',
 *                           adoptedFrom: <legacyProfileId|null> } } }
 *
 * Guarantees (each covered by tests/RegistryR3UI.Tests.cjs):
 *
 * - Per-mode independence: modes are sibling keys; saving one mode never
 *   touches another entry.
 * - Monotonic revisions + optimistic concurrency: every write carries the
 *   expected revision (null only for create). A mismatch fails closed with
 *   'stale-revision' and the file is left untouched. Under concurrent
 *   writers (same or other processes), an exclusive per-(mode, revision)
 *   claim file decides the single winner; the loser reports
 *   'stale-revision' (rival already committed) or 'write-conflict' (live
 *   contender), and a stale claim from a crashed writer is reaped after
 *   CLAIM_STALE_MS with one bounded retry — no locks, no spinning.
 * - Atomic replacement: uniquely-named temp file (pid + timestamp +
 *   counter + crypto randomness, so concurrent writers cannot collide)
 *   in the same directory + rename, so a crash or failed validation never
 *   leaves a half-written document. Failed attempts remove their own temp
 *   and claim files.
 * - No partial save: schema validation, secret scan and revision checks all
 *   run BEFORE any filesystem mutation.
 * - Secret-free: values that look like real credentials fail the write with
 *   'secret-material-rejected'. Opaque 'credential://' references and
 *   'conn-*' connection ids are the only credential-adjacent values allowed.
 * - Malformed files fail closed: load reports 'registry-store-corrupt' and
 *   callers surface it instead of guessing configuration.
 *
 * Pure Nexus-owned CommonJS: only node:fs / node:path / node:crypto-adjacent
 * stdlib plus sibling schemas.cjs. No DSH, PowerShell, network or env reads.
 * filesystem access is injectable (fsHooks) so tests run fully offline.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const schemas = require('./schemas.cjs')

const STORE_SCHEMA_VERSION = 1
const STORE_DIR = 'registry'
const STORE_FILE = 'mode-configurations.json'
const STORE_SOURCES = ['operator-save', 'legacy-adopt']
// R3.1 H2: cross-process write arbitration. Claim files are created with
// exclusive ('wx') semantics so exactly one contender wins a given next
// revision; stale claims (crashed writers) age out and are reaped.
// Bounded: at most CLAIM_MAX_ATTEMPTS claim rounds, no spinning, no locks.
const CLAIM_STALE_MS = 30000
const CLAIM_MAX_ATTEMPTS = 2
let tempCounter = 0

function storeFilePath(dataRoot) {
  return path.join(String(dataRoot), STORE_DIR, STORE_FILE)
}

function defaultFsHooks() {
  return {
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    writeFileExclusive: (p, data, opts) => fs.writeFileSync(p, data, { ...(opts || {}), flag: 'wx' }),
    renameSync: (a, b) => fs.renameSync(a, b),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    unlinkSync: (p) => fs.unlinkSync(p),
    chmodSync: (p, mode) => fs.chmodSync(p, mode),
    statSync: (p) => fs.statSync(p),
  }
}

function sanitizeForFile(name) {
  const clean = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return clean === '' ? 'mode' : clean
}

function claimFilePath(target, modeId, nextRevision) {
  return target + '.claim-' + sanitizeForFile(modeId) + '-r' + nextRevision
}

function nextTempPath(target) {
  tempCounter = (tempCounter + 1) % 1000000
  return target + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + tempCounter + '-' + crypto.randomBytes(8).toString('hex')
}

function claimAgeMs(hooks, claimPath) {
  try {
    return Date.now() - hooks.statSync(claimPath).mtimeMs
  } catch {
    return null
  }
}

function err(code, p, message) {
  return { code, path: p, message }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Secret scan. Forbidden KEYS (case-insensitive) whose VALUES must never be
 * persisted, plus suspicious VALUE shapes (live key prefixes). Explicitly
 * allowed: connectionId ('conn-*'), credentialRef ('credential://...'),
 * connection/provider/route/model/mode ids, reasoning levels, digests.
 */
const FORBIDDEN_KEY_PATTERN = /^(api[_-]?key|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer|password|passwd|pwd|private[_-]?key|cookie|session[_-]?token|authorization)$/i
const SUSPICIOUS_VALUE_PATTERN = /^(sk-(live|proj|svcacct)-|xox[bap]-|ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

function scanForSecrets(value, trail, hits) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scanForSecrets(value[i], trail + '[' + i + ']', hits)
    return
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const child = trail === '' ? key : trail + '.' + key
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        hits.push(err('secret-material-rejected', child, 'refusing to persist secret-bearing field: ' + key))
        continue
      }
      scanForSecrets(value[key], child, hits)
    }
    return
  }
  if (typeof value === 'string' && SUSPICIOUS_VALUE_PATTERN.test(value)) {
    hits.push(err('secret-material-rejected', trail, 'refusing to persist value with secret material shape'))
  }
}

function validateStoreEntry(modeId, entry) {
  const errors = []
  if (!isPlainObject(entry)) return [err('registry-store-corrupt', 'modes.' + modeId, 'mode entry must be an object')]
  if (!Number.isInteger(entry.revision) || entry.revision < 0) {
    errors.push(err('registry-store-corrupt', 'modes.' + modeId + '.revision', 'revision must be an integer >= 0'))
  }
  if (typeof entry.savedAtUtc !== 'string' || entry.savedAtUtc === '') {
    errors.push(err('registry-store-corrupt', 'modes.' + modeId + '.savedAtUtc', 'savedAtUtc must be a non-empty string'))
  }
  if (typeof entry.source !== 'string' || STORE_SOURCES.indexOf(entry.source) === -1) {
    errors.push(err('registry-store-corrupt', 'modes.' + modeId + '.source', 'source must be one of ' + STORE_SOURCES.join(', ')))
  }
  errors.push(...schemas.validateModeConfiguration(entry.config, 'modes.' + modeId + '.config'))
  if (entry.config && typeof entry.config.modeId === 'string' && entry.config.modeId !== modeId) {
    errors.push(err('registry-store-corrupt', 'modes.' + modeId + '.config.modeId', 'stored config modeId ' + entry.config.modeId + ' does not match its key ' + modeId))
  }
  if (entry.config && typeof entry.config.revision === 'number' && entry.revision !== entry.config.revision) {
    errors.push(err('registry-store-corrupt', 'modes.' + modeId + '.revision', 'entry revision ' + entry.revision + ' disagrees with config revision ' + entry.config.revision))
  }
  return errors
}

/**
 * Load the store. Returns { store, errors } where store is null on any
 * failure. A missing file is the legitimate initial state ({ modes: {} }),
 * never an error. Corrupt JSON, wrong schema version or invalid entries fail
 * closed; invalid per-mode entries are reported and the whole load fails
 * closed (callers fall back to legacy previews, never to guessed configs).
 */
function loadStore(dataRoot, fsHooks) {
  const hooks = fsHooks || defaultFsHooks()
  const filePath = storeFilePath(dataRoot)
  let raw = null
  try {
    raw = hooks.readFileSync(filePath, 'utf8')
  } catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT/.test(String((e && e.message) || '')))) {
      return { store: { schemaVersion: STORE_SCHEMA_VERSION, updatedAtUtc: null, modes: {} }, errors: [] }
    }
    return { store: null, errors: [err('registry-store-unreadable', 'store', 'mode-configuration store cannot be read')] }
  }
  let doc = null
  try {
    doc = JSON.parse(raw)
  } catch {
    return { store: null, errors: [err('registry-store-corrupt', 'store', 'mode-configuration store is not valid JSON')] }
  }
  if (!isPlainObject(doc) || doc.schemaVersion !== STORE_SCHEMA_VERSION || !isPlainObject(doc.modes)) {
    return { store: null, errors: [err('registry-store-corrupt', 'store', 'mode-configuration store has an unsupported schema; expected schemaVersion 1 with a modes object')] }
  }
  const errors = []
  for (const modeId of Object.keys(doc.modes)) {
    errors.push(...validateStoreEntry(modeId, doc.modes[modeId]))
  }
  if (errors.length > 0) return { store: null, errors }
  return { store: { schemaVersion: STORE_SCHEMA_VERSION, updatedAtUtc: typeof doc.updatedAtUtc === 'string' ? doc.updatedAtUtc : null, modes: doc.modes }, errors: [] }
}

function loadModeEntry(dataRoot, modeId, fsHooks) {
  const loaded = loadStore(dataRoot, fsHooks)
  if (!loaded.store) return { entry: null, errors: loaded.errors }
  const entry = loaded.store.modes[modeId] || null
  return { entry, errors: [] }
}

/**
 * Persist one mode configuration. All checks run before any write:
 * schema, mode-id match, secret scan, revision match. The write itself is
 * a three-phase commit safe under concurrent writers in THIS or OTHER
 * processes (the host is single-process today, but operator tooling and
 * future workers share the same data root):
 *
 * 1. Win an exclusive claim file for (mode, nextRevision) via atomic
 *    'wx' creation. A competing live claim fails closed here with
 *    'write-conflict' — two writers on the same revision can never both
 *    succeed. A claim older than CLAIM_STALE_MS is a crashed writer and
 *    is reaped once before a single bounded retry.
 * 2. Re-read the store UNDER the claim and re-check the revision, closing
 *    the load-then-write race: a writer that loaded stale bytes fails with
 *    'stale-revision' and never overwrites the winner.
 * 3. Write a uniquely-named temp file (pid + timestamp + counter +
 *    crypto randomness, so names cannot collide) + atomic rename, then
 *    remove the claim. Any failure removes what this attempt created and
 *    leaves the previous file (or its absence) intact.
 *
 * No cross-process locks, no retries beyond one bounded claim round.
 * Returns { ok: true, revision } or { ok: false, errors }.
 */
function saveModeConfig(dataRoot, modeId, config, expectedRevision, options) {
  const opts = options || {}
  const hooks = opts.fsHooks || defaultFsHooks()
  const nowUtc = typeof opts.nowUtc === 'function' ? opts.nowUtc : () => new Date().toISOString()
  const source = opts.source || 'operator-save'
  const adoptedFrom = Object.prototype.hasOwnProperty.call(opts, 'adoptedFrom') ? opts.adoptedFrom : null
  const errors = []
  if (typeof modeId !== 'string' || modeId === '') {
    return { ok: false, errors: [err('mode-config-invalid', 'modeId', 'modeId is required')] }
  }
  if (STORE_SOURCES.indexOf(source) === -1) {
    return { ok: false, errors: [err('mode-config-invalid', 'source', 'source must be one of ' + STORE_SOURCES.join(', '))] }
  }
  errors.push(...schemas.validateModeConfiguration(config, 'modeConfiguration'))
  if (errors.length > 0) return { ok: false, errors }
  if (config.modeId !== modeId) {
    return { ok: false, errors: [err('mode-mismatch', 'modeConfiguration.modeId', 'config modeId ' + config.modeId + ' does not match target mode ' + modeId)] }
  }
  const secretHits = []
  scanForSecrets(config, 'modeConfiguration', secretHits)
  if (secretHits.length > 0) return { ok: false, errors: secretHits }

  const loaded = loadStore(dataRoot, hooks)
  if (!loaded.store) return { ok: false, errors: loaded.errors }
  const current = loaded.store.modes[modeId] || null
  const currentRevision = current ? current.revision : null
  if (current === null) {
    if (expectedRevision !== null && expectedRevision !== undefined) {
      return { ok: false, errors: [err('stale-revision', 'expectedRevision', 'mode ' + modeId + ' has no saved configuration; expectedRevision must be omitted for the first save')] }
    }
  } else if (expectedRevision === null || expectedRevision === undefined || expectedRevision !== currentRevision) {
    return { ok: false, errors: [err('stale-revision', 'expectedRevision', 'stale revision for mode ' + modeId + ': expected ' + String(expectedRevision) + ', stored ' + String(currentRevision))] }
  }
  const nextRevision = current === null ? 0 : currentRevision + 1
  const storedConfig = JSON.parse(JSON.stringify(config))
  storedConfig.revision = nextRevision
  const next = {
    schemaVersion: STORE_SCHEMA_VERSION,
    updatedAtUtc: nowUtc(),
    modes: Object.assign({}, loaded.store.modes),
  }
  next.modes[modeId] = {
    revision: nextRevision,
    config: storedConfig,
    savedAtUtc: nowUtc(),
    source,
    adoptedFrom,
  }
  let text = null
  try {
    text = JSON.stringify(next, null, 2) + '\n'
  } catch {
    return { ok: false, errors: [err('registry-store-unwritable', 'store', 'mode configuration cannot be serialized')] }
  }
  const dir = path.join(String(dataRoot), STORE_DIR)
  const target = storeFilePath(dataRoot)
  const claimPath = claimFilePath(target, modeId, nextRevision)
  const claimPayload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
  const conflict = () => ({
    ok: false,
    errors: [err('write-conflict', 'expectedRevision', 'a concurrent writer holds the write claim for mode ' + modeId + '; reload and retry with the current revision')],
  })
  for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt += 1) {
    let claimed = false
    try {
      hooks.mkdirSync(dir, { recursive: true })
      hooks.writeFileExclusive(claimPath, claimPayload, { encoding: 'utf8', mode: 0o600 })
      claimed = true
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return { ok: false, errors: [err('registry-store-unwritable', 'store', 'mode configuration store cannot be written')] }
      }
      // A claim already exists: decide between a completed rival, a live
      // contender, and a crashed writer's leftover — from a fresh read,
      // never from our possibly stale view.
      const fresh = loadStore(dataRoot, hooks)
      if (!fresh.store) return { ok: false, errors: fresh.errors }
      const freshEntry = fresh.store.modes[modeId] || null
      const freshRevision = freshEntry ? freshEntry.revision : null
      if (freshRevision !== currentRevision) {
        return { ok: false, errors: [err('stale-revision', 'expectedRevision', 'stale revision for mode ' + modeId + ': stored revision moved to ' + String(freshRevision))] }
      }
      const age = claimAgeMs(hooks, claimPath)
      if (age === null) continue // claim vanished mid-race; one bounded retry
      if (age > CLAIM_STALE_MS) {
        try {
          hooks.unlinkSync(claimPath)
        } catch {
          return conflict()
        }
        continue // seized back from a crashed writer; retry the claim
      }
      return conflict() // live contender owns this revision
    }
    if (!claimed) return conflict()
    // Re-validate under the claim: our load may predate a rival's commit.
    const guarded = loadStore(dataRoot, hooks)
    if (!guarded.store) {
      try { hooks.unlinkSync(claimPath) } catch { /* best-effort claim cleanup */ }
      return { ok: false, errors: guarded.errors }
    }
    const guardedEntry = guarded.store.modes[modeId] || null
    const guardedRevision = guardedEntry ? guardedEntry.revision : null
    if (guardedRevision !== currentRevision) {
      try { hooks.unlinkSync(claimPath) } catch { /* best-effort claim cleanup */ }
      return { ok: false, errors: [err('stale-revision', 'expectedRevision', 'stale revision for mode ' + modeId + ': stored revision moved to ' + String(guardedRevision))] }
    }
    const tmp = nextTempPath(target)
    try {
      hooks.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      try { hooks.chmodSync(tmp, 0o600) } catch { /* best effort; Windows ACLs differ */ }
      hooks.renameSync(tmp, target)
    } catch {
      try { hooks.unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
      try { hooks.unlinkSync(claimPath) } catch { /* best-effort claim cleanup */ }
      return { ok: false, errors: [err('registry-store-unwritable', 'store', 'mode configuration store cannot be written')] }
    }
    try { hooks.unlinkSync(claimPath) } catch { /* best-effort claim cleanup */ }
    return { ok: true, revision: nextRevision }
  }
  return conflict()
}

module.exports = {
  STORE_SCHEMA_VERSION,
  STORE_DIR,
  STORE_FILE,
  STORE_SOURCES,
  storeFilePath,
  loadStore,
  loadModeEntry,
  saveModeConfig,
  scanForSecrets,
}
