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
 *   writers (same or other processes, any mode), a single store-wide
 *   exclusive lock file serializes mutations while per-mode revisions
 *   stay independent; the loser reports 'stale-revision' (rival already
 *   committed) or 'write-conflict' (live contender), and a stale lock is
 *   reclaimed only when provably inactive — never stolen from an alive
 *   owner merely for lasting past CLAIM_STALE_MS. Bounded retries only.
 * - Atomic replacement: uniquely-named temp file (pid + timestamp +
 *   counter + crypto randomness, so concurrent writers cannot collide)
 *   in the same directory + rename, so a crash or failed validation never
 *   leaves a half-written document. Failed attempts remove their own temp
 *   and lock files.
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
// R3.1.1: store-wide exclusive mutation ownership. All mode entries share
// one physical document, so per-(mode, revision) claims cannot serialize
// writers: two modes' claims could both win and the later rename would
// discard the first writer's update. A single lock file serializes EVERY
// mutation while per-mode revisions stay independent. The lock is created
// with exclusive ('wx') semantics; stale locks are reclaimed only when
// safe (see readLockOwner/isPidAlive). Bounded: CLAIM_MAX_ATTEMPTS rounds,
// no spinning, no blocking locks.
const CLAIM_STALE_MS = 30000
const LOCK_HARD_STALE_MS = 600000
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

function lockFilePath(target) {
  return target + '.lock'
}

function readLockOwner(hooks, lockPath) {
  try {
    const raw = hooks.readFileSync(lockPath, 'utf8')
    const doc = JSON.parse(raw)
    if (doc && typeof doc === 'object') return doc
    return null
  } catch {
    return null
  }
}

// Conservative liveness: only a definitive ESRCH means dead. Any other
// outcome (including EPERM and platform quirks) counts as alive, so an
// active writer is never mistaken for a crashed one.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !e || e.code !== 'ESRCH'
  }
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
 * 1. Win the store-wide exclusive lock via atomic 'wx' creation. A live
 *    contender fails closed here with 'write-conflict' — concurrent
 *    mutations of the shared document are serialized, on any mode. A lock
 *    is reclaimed only when it is provably not active: unreadable past a
 *    hard age, or older than CLAIM_STALE_MS with a dead/invalid owner pid
 *    (liveness is conservative — an alive pid is never stolen, however
 *    long the operation runs). One bounded retry, then fail closed.
 * 2. Re-read the LATEST complete store UNDER the lock, re-validate our
 *    mode's revision against it, and build the new document FROM that
 *    re-read (preserving unrelated mode entries committed meanwhile). A
 *    writer that loaded stale bytes fails with 'stale-revision' and never
 *    overwrites the winner — on any mode.
 * 3. Write a uniquely-named temp file (pid + timestamp + counter +
 *    crypto randomness, so names cannot collide) + atomic rename, then
 *    release our lock. Any failure removes what this attempt created and
 *    leaves the previous file (or its absence) intact.
 *
 * No blocking locks, no retries beyond one bounded lock round.
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
  const storedEntry = {
    revision: nextRevision,
    config: storedConfig,
    savedAtUtc: nowUtc(),
    source,
    adoptedFrom,
  }
  const dir = path.join(String(dataRoot), STORE_DIR)
  const target = storeFilePath(dataRoot)
  const lockPath = lockFilePath(target)
  const lockToken = process.pid + '-' + crypto.randomBytes(8).toString('hex')
  const lockPayload = JSON.stringify({ pid: process.pid, token: lockToken, modeId, nextRevision, at: new Date().toISOString() })
  const conflict = () => ({
    ok: false,
    errors: [err('write-conflict', 'expectedRevision', 'a concurrent writer holds the store mutation lock; reload and retry with the current revision')],
  })
  // Release ONLY our own lock: verify the token first so a reap-and-replace
  // by another writer can never make us delete a lock we do not own.
  const releaseOwnLock = () => {
    try {
      const owner = readLockOwner(hooks, lockPath)
      if (owner && owner.token === lockToken) hooks.unlinkSync(lockPath)
    } catch { /* best-effort lock cleanup */ }
  }
  for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt += 1) {
    let held = false
    try {
      hooks.mkdirSync(dir, { recursive: true })
      hooks.writeFileExclusive(lockPath, lockPayload, { encoding: 'utf8', mode: 0o600 })
      held = true
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return { ok: false, errors: [err('registry-store-unwritable', 'store', 'mode configuration store cannot be written')] }
      }
      // A lock already exists. A completed rival on OUR mode shows up as a
      // moved revision — report it precisely instead of a generic conflict.
      const fresh = loadStore(dataRoot, hooks)
      if (!fresh.store) return { ok: false, errors: fresh.errors }
      const freshEntry = fresh.store.modes[modeId] || null
      const freshRevision = freshEntry ? freshEntry.revision : null
      if (freshRevision !== currentRevision) {
        return { ok: false, errors: [err('stale-revision', 'expectedRevision', 'stale revision for mode ' + modeId + ': stored revision moved to ' + String(freshRevision))] }
      }
      const age = claimAgeMs(hooks, lockPath)
      if (age === null) continue // lock vanished mid-race; one bounded retry
      if (age > LOCK_HARD_STALE_MS) {
        // Older than any legitimate operation by orders of magnitude:
        // reclaim even if the pid looks alive (covers pid reuse after a
        // crash). Legitimate saves finish in milliseconds.
        try {
          hooks.unlinkSync(lockPath)
        } catch {
          return conflict()
        }
        continue
      }
      if (age > CLAIM_STALE_MS) {
        const owner = readLockOwner(hooks, lockPath)
        // Reclaim ONLY from a provably inactive owner. An alive pid is
        // never stolen, however long its operation runs; neither is an
        // unreadable lock whose owner cannot be checked.
        if (owner && (owner.pid === undefined || !isPidAlive(owner.pid))) {
          try {
            hooks.unlinkSync(lockPath)
          } catch {
            return conflict()
          }
          continue // seized back from a crashed writer; retry the lock
        }
        return conflict()
      }
      return conflict() // live contender owns the mutation lock
    }
    if (!held) return conflict()
    // Re-read the LATEST complete store under the lock and build the new
    // document FROM it: unrelated entries committed meanwhile survive.
    const guarded = loadStore(dataRoot, hooks)
    if (!guarded.store) {
      releaseOwnLock()
      return { ok: false, errors: guarded.errors }
    }
    const guardedEntry = guarded.store.modes[modeId] || null
    const guardedRevision = guardedEntry ? guardedEntry.revision : null
    if (guardedRevision !== currentRevision) {
      releaseOwnLock()
      return { ok: false, errors: [err('stale-revision', 'expectedRevision', 'stale revision for mode ' + modeId + ': stored revision moved to ' + String(guardedRevision))] }
    }
    const next = {
      schemaVersion: STORE_SCHEMA_VERSION,
      updatedAtUtc: nowUtc(),
      modes: Object.assign({}, guarded.store.modes),
    }
    next.modes[modeId] = JSON.parse(JSON.stringify(storedEntry))
    let text = null
    try {
      text = JSON.stringify(next, null, 2) + '\n'
    } catch {
      releaseOwnLock()
      return { ok: false, errors: [err('registry-store-unwritable', 'store', 'mode configuration cannot be serialized')] }
    }
    const tmp = nextTempPath(target)
    try {
      hooks.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      try { hooks.chmodSync(tmp, 0o600) } catch { /* best effort; Windows ACLs differ */ }
      hooks.renameSync(tmp, target)
    } catch {
      try { hooks.unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
      releaseOwnLock()
      return { ok: false, errors: [err('registry-store-unwritable', 'store', 'mode configuration store cannot be written')] }
    }
    releaseOwnLock()
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
