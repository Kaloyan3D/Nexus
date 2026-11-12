'use strict'

/**
 * nexus/intake-store — Controller-owned durable intake partition and managed
 * session registry (P2-B2B).
 *
 * Holds ONLY what the CLI contract assigns to intake: idempotency, delivery
 * intent/state and managed identity (task id, exact DSH session id, request
 * id). It carries no execution status, budget or completion authority — the
 * TaskController ledger stays the legacy task authority and DSH stays the
 * conversation authority.
 *
 * Layout: <data>/nexus/intake/<sha256(principal|key)>.json (dir 0700, files
 * 0600), one record per idempotency key, written atomically (temp + fsync +
 * rename + directory fsync). Every state change is a compare-and-swap on the
 * current state, synchronous on the host's single JS thread; only an owning
 * host may write (installation ownership is the cross-process fence).
 *
 * The managed-session registry is derived from these records and loaded
 * synchronously when the Controller core is created, i.e. before the host
 * provides its service and before any remote mutation can be authorized.
 * A record that cannot be parsed makes the store `corrupt`: managed admission
 * is refused (never a silent loss), and the affected sessions stay unknown
 * rather than unmanaged — the activation gate fails.
 *
 * P2-B2C identity retention (fail-closed tombstones): every managed identity
 * is also appended, after its record, to an append-only ledger
 * `<data>/nexus/managed-identities.jsonl` (0600, fsync per entry). Cleanup can
 * never expand authority:
 *   - an identity whose record is missing (deleted, lost) stays MANAGED
 *     (quarantined: every step, approval and owner mutation refused), its
 *     idempotency key stays taken, and the store reports `corrupt`;
 *   - a record missing from the ledger (crash between record and ledger write,
 *     or a P2-B2B store) is re-entered into the ledger by `repairLedger()`
 *     (adds protection only, never removes it);
 *   - `retire()` is the only supported way to end a task's activity: the
 *     record stays (state unchanged, `retiredAt` set) and its session remains
 *     protected as a historical managed identity.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SCHEMA_VERSION = 1
const STATES = Object.freeze(['reserved', 'session-created', 'bound', 'delivering', 'accepted', 'parked', 'failed'])
const TRANSITIONS = Object.freeze({
  reserved: ['session-created', 'parked', 'failed'],
  'session-created': ['bound', 'parked', 'failed'],
  bound: ['delivering', 'parked', 'failed'],
  delivering: ['accepted', 'parked'],
  accepted: ['parked'],
  parked: [],
  failed: [],
})
const PENDING = new Set(['reserved', 'session-created', 'bound', 'delivering'])

class IntakeStoreError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function fileKey(principalId, idempotencyKey) {
  return crypto.createHash('sha256').update(String(principalId) + '\n' + String(idempotencyKey)).digest('hex')
}

function writeAtomic(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  const fd = fs.openSync(temporary, 'w', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, file)
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  }
}

function validRecord(record) {
  return record && record.schemaVersion === SCHEMA_VERSION && typeof record.intakeId === 'string' && typeof record.taskId === 'string' &&
    typeof record.sessionId === 'string' && typeof record.requestId === 'string' && STATES.includes(record.state) && typeof record.fingerprint === 'string'
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {() => boolean} options.canWrite installation ownership held (host enforced)
 * @param {Function} [options.log]
 */
function createIntakeStore(options) {
  const dir = path.join(options.dataRoot, 'nexus', 'intake')
  const canWrite = typeof options.canWrite === 'function' ? options.canWrite : () => true
  const log = typeof options.log === 'function' ? options.log : () => {}
  const records = new Map()      // intakeId -> record
  const bySession = new Map()    // sessionId -> intakeId
  const byTask = new Map()       // taskId -> intakeId
  const ledgerPath = path.join(options.dataRoot, 'nexus', 'managed-identities.jsonl')
  const identities = new Map()   // intakeId -> ledger identity { intakeId, taskId, sessionId, principalId, fingerprint }
  const orphans = new Set()      // intakeIds in the ledger without a record
  let ledgerRepairs = []         // records not yet in the ledger
  let health = { state: 'ok', problems: [] }
  // Session ids named by unreadable/invalid records: treated as managed (and
  // never admitted) so a corrupt record cannot silently release a session.
  const quarantined = new Set()
  let closed = false

  function index(record) {
    records.set(record.intakeId, record)
    bySession.set(record.sessionId, record.intakeId)
    byTask.set(record.taskId, record.intakeId)
  }

  function quarantine(raw) {
    for (const match of String(raw).matchAll(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) quarantined.add(match[0])
  }

  /** Synchronous load at Controller creation. */
  function load() {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch (error) { health = { state: 'unavailable', problems: [String(error.message)] }; return health }
    const problems = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      let record
      let raw = ''
      try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); record = JSON.parse(raw) } catch { problems.push('unreadable:' + name); quarantine(raw); continue }
      if (!validRecord(record) || record.intakeId !== name.slice(0, -5)) { problems.push('invalid:' + name); quarantine(raw); continue }
      index(record)
    }
    // Identity ledger: tombstones outlive records.
    let raw = null
    try { raw = fs.readFileSync(ledgerPath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') problems.push('ledger-unreadable') }
    if (raw !== null) {
      const lines = raw.split('\n')
      const tornTail = raw.length > 0 && !raw.endsWith('\n')
      lines.forEach((line, index) => {
        if (line.trim() === '') return
        let entry
        try { entry = JSON.parse(line) } catch { entry = null }
        if (!entry || typeof entry.intakeId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.taskId !== 'string') {
          // A torn final append (crash mid-write) is ignorable: its record was
          // written first and is re-entered by repairLedger().
          if (!(tornTail && index === lines.length - 1)) problems.push('ledger-invalid-line:' + (index + 1))
          return
        }
        if (entry.op === 'identity') identities.set(entry.intakeId, { intakeId: entry.intakeId, taskId: entry.taskId, sessionId: entry.sessionId, principalId: entry.principalId, fingerprint: entry.fingerprint, workspacePath: typeof entry.workspacePath === 'string' ? entry.workspacePath : null })
      })
    }
    for (const [intakeId, identity] of identities) {
      const record = records.get(intakeId)
      if (!record) { orphans.add(intakeId); quarantined.add(identity.sessionId); problems.push('record-missing:' + intakeId); continue }
      if (record.sessionId !== identity.sessionId || record.taskId !== identity.taskId) { quarantined.add(identity.sessionId); quarantined.add(record.sessionId); problems.push('identity-mismatch:' + intakeId) }
    }
    ledgerRepairs = [...records.values()].filter((record) => !identities.has(record.intakeId))
    health = problems.length ? { state: 'corrupt', problems } : { state: 'ok', problems: [] }
    if (problems.length) log({ event: 'intake-store-corrupt', problems })
    return health
  }

  function appendLedger(entry) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(ledgerPath, 'a', 0o600)
    try { fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  function ledgerIdentity(record) {
    return { op: 'identity', intakeId: record.intakeId, taskId: record.taskId, sessionId: record.sessionId, principalId: record.principalId, fingerprint: record.fingerprint, workspacePath: record.canonical && record.canonical.workspacePath ? record.canonical.workspacePath : null, at: new Date().toISOString() }
  }

  /** Re-enter records missing from the ledger (owner only; adds protection). */
  function repairLedger() {
    if (!canWrite() || closed) return 0
    let repaired = 0
    for (const record of ledgerRepairs.splice(0)) {
      if (identities.has(record.intakeId)) continue
      const entry = ledgerIdentity(record)
      appendLedger(entry)
      identities.set(record.intakeId, entry)
      repaired += 1
    }
    if (repaired) log({ event: 'intake-ledger-repaired', repaired })
    return repaired
  }

  function assertWritable() {
    if (closed) throw new IntakeStoreError('intake-store-closed', 'the intake store is closed')
    if (health.state !== 'ok') throw new IntakeStoreError('intake-store-unhealthy', 'the intake store is ' + health.state)
    if (!canWrite()) throw new IntakeStoreError('intake-store-not-owner', 'only the owning host may write intake records')
  }

  function persist(record) {
    writeAtomic(path.join(dir, record.intakeId + '.json'), record)
    index(record)
  }

  /**
   * Reserve (or replay) an intake. Returns { record, replay } or throws
   * IDEMPOTENCY_CONFLICT for the same key with a different canonical payload.
   */
  function reserve(input) {
    assertWritable()
    const intakeId = fileKey(input.principalId, input.idempotencyKey)
    // A key whose identity exists stays taken even if its record is gone.
    if (identities.has(intakeId) && !records.has(intakeId)) throw new IntakeStoreError('IDEMPOTENCY_RETIRED', 'the idempotency key belongs to a retained managed identity')
    const existing = records.get(intakeId)
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new IntakeStoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was used for a different submission')
      return { record: existing, replay: true }
    }
    const now = new Date().toISOString()
    const record = {
      schemaVersion: SCHEMA_VERSION,
      intakeId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      canonical: input.canonical,
      taskId: 'nt_' + crypto.randomBytes(16).toString('hex'),
      sessionId: 'session-' + crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      preset: input.preset,
      profileId: input.profileId,
      prompt: { text: input.promptText, digest: input.canonical.promptDigest, bytes: input.canonical.promptBytes, kind: input.canonical.sourceKind },
      state: 'reserved',
      history: [{ state: 'reserved', at: now }],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    persist(record)
    // Record first, then the tombstone: a crash in between is repaired from
    // the record; a ledger entry never exists without its record being written.
    const entry = ledgerIdentity(record)
    appendLedger(entry)
    identities.set(intakeId, entry)
    return { record, replay: false }
  }

  /**
   * Retire a task: its activity ends but its identity stays protected. The
   * record is kept (state unchanged) with `retiredAt`; nothing is deleted.
   */
  function retire(intakeId, reason) {
    assertWritable()
    const current = records.get(intakeId)
    if (!current) throw new IntakeStoreError('NOT_FOUND', 'unknown intake')
    if (current.retiredAt) return current
    const next = { ...current, retiredAt: new Date().toISOString(), retiredReason: String(reason || 'retired').slice(0, 200), revision: current.revision + 1, updatedAt: new Date().toISOString() }
    persist(next)
    appendLedger({ op: 'retired', intakeId, taskId: current.taskId, sessionId: current.sessionId, at: next.retiredAt })
    return next
  }

  /** Compare-and-swap transition. `patch` may add fields (never identities). */
  function transition(intakeId, fromStates, toState, patch = {}) {
    assertWritable()
    const current = records.get(intakeId)
    if (!current) throw new IntakeStoreError('NOT_FOUND', 'unknown intake')
    if (!fromStates.includes(current.state)) throw new IntakeStoreError('intake-state-conflict', `intake is ${current.state}, expected ${fromStates.join('|')}`)
    if (!TRANSITIONS[current.state].includes(toState) && current.state !== toState) throw new IntakeStoreError('intake-transition-forbidden', `${current.state} -> ${toState}`)
    for (const key of ['intakeId', 'taskId', 'sessionId', 'requestId', 'fingerprint', 'principalId', 'idempotencyKey']) if (key in patch) throw new IntakeStoreError('intake-identity-immutable', key)
    const now = new Date().toISOString()
    const next = { ...current, ...patch, state: toState, revision: current.revision + 1, updatedAt: now, history: [...current.history, { state: toState, at: now, ...(patch.hold ? { reason: patch.hold.reason } : {}) }] }
    // The protected prompt copy is dropped once DSH durably owns the message.
    if (toState === 'accepted' && next.prompt) next.prompt = { digest: next.prompt.digest, bytes: next.prompt.bytes, kind: next.prompt.kind }
    persist(next)
    return next
  }

  /** Non-state annotations (cancel request, operator data) with CAS on revision. */
  function annotate(intakeId, expectedRevision, patch) {
    assertWritable()
    const current = records.get(intakeId)
    if (!current) throw new IntakeStoreError('NOT_FOUND', 'unknown intake')
    if (current.revision !== expectedRevision) throw new IntakeStoreError('STALE_ACTION', 'intake revision changed')
    for (const key of ['intakeId', 'taskId', 'sessionId', 'requestId', 'fingerprint', 'principalId', 'idempotencyKey', 'state']) if (key in patch) throw new IntakeStoreError('intake-identity-immutable', key)
    const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() }
    persist(next)
    return next
  }

  return Object.freeze({
    dir,
    load,
    reserve,
    transition,
    annotate,
    get: (intakeId) => records.get(intakeId) || null,
    /** The record reserved under (principal, key), if any (read-only). */
    existing: (principalId, idempotencyKey) => records.get(fileKey(principalId, idempotencyKey)) || null,
    bySessionId: (sessionId) => { const id = bySession.get(sessionId); return id ? records.get(id) : null },
    byTaskId: (taskId) => { const id = byTask.get(taskId); return id ? records.get(id) : null },
    list: () => [...records.values()],
    pending: () => [...records.values()].filter((record) => PENDING.has(record.state)),
    managedSessionIds: () => [...new Set([...[...records.values()].map((record) => record.sessionId), ...[...identities.values()].map((identity) => identity.sessionId)])],
    /** Every retained managed identity with its disposition (active, retired, missing-record). */
    identityStatus: () => [...identities.values()].map((identity) => {
      const record = records.get(identity.intakeId)
      return { intakeId: identity.intakeId, taskId: identity.taskId, sessionId: identity.sessionId, workspacePath: identity.workspacePath || null, disposition: !record ? 'record-missing' : record.retiredAt ? 'retired' : 'active' }
    }),
    retire,
    repairLedger,
    ledgerPath,
    health: () => ({ ...health }),
    isQuarantined: (sessionId) => quarantined.has(sessionId),
    close() { closed = true },
  })
}

module.exports = { createIntakeStore, IntakeStoreError, STATES, TRANSITIONS, PENDING, SCHEMA_VERSION, fileKey }
