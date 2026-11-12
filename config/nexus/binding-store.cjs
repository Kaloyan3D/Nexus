'use strict'

/**
 * nexus/binding-store — the single authoritative writer of
 * data/routing/session-bindings.json (P2-A, Task A).
 *
 * Before P2-A every standing `aih-controller` plane mount (aih-engineering,
 * aih-deepseek, aih-muse) carried its own copy of `persistBindings` and wrote
 * the whole document from its own cache. The host Controller now owns exactly
 * one store per data root; plane bridges are writers only through it and keep
 * their caches as consumers.
 *
 * The persistence algorithm, whitelist, schema and error codes are moved
 * VERBATIM from the pre-P2-A bridge (`loadBindings`, `authorityStamp`,
 * `persistBindings`): the store re-reads the durable document before every
 * write, adopts authority committed by another writer when the caller did not
 * change it, refuses a stale caller that did (`bindings-write-conflict`),
 * refuses a disappeared Registry authority (`registry-authority-unverifiable`)
 * and replaces the file atomically (temp file + fsync + rename + directory
 * fsync on POSIX). Readers (Muse/Engineering isolation, Routing Integrity,
 * StepRouting.ps1, the UI) keep reading the same file and schema.
 *
 * Serialization and freshness:
 *   - commit() is synchronous end to end (read, merge, write, rename), so two
 *     commits in one host process can never interleave on the JS thread;
 *   - every commit re-reads the durable document, so a write by anything else
 *     (an old process, a test) is merged or refused exactly as before;
 *   - cross-process exclusion is NOT provided by this module: a second host on
 *     the same data root could still race between read and rename. That is
 *     the job of the host lifetime lock (nexus/host-ownership.cjs).
 * One deliberate addition, possible only with a single owner: a removal
 * committed through this store records a tombstone, and a later stale cached
 * copy with the same authority stamp is dropped instead of being written back
 * (pre-P2-A, another plane's cache resurrected disposed bindings). A session
 * re-bound with a different authority is written normally.
 * Lifecycle:
 *   - only attached plane bridges may write (`binding-writer-detached` for a
 *     writer whose mount was detached, e.g. a late continuation after remount);
 *   - disposal closes the store first (`binding-store-closed`), so no write
 *     can land after the host Controller starts shutting down.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const registrySessionBinding = require('../registry/session-binding.cjs')

// ── verbatim from the pre-P2-A AihController.cjs ────────────────────────────
function loadBindings(bindingsPath) {
  try {
    const document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'))
    if (document && document.schemaVersion === 1 && document.bindings && typeof document.bindings === 'object' && !Array.isArray(document.bindings)) {
      for (const binding of Object.values(document.bindings)) {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('Invalid session binding entry')
        for (const field of ['registryPin', 'registryRefused']) {
          if (Object.prototype.hasOwnProperty.call(binding, field) && (!binding[field] || typeof binding[field] !== 'object' || Array.isArray(binding[field]))) throw new Error('Invalid Registry authority entry')
        }
        if (binding.bindingAuthority === 'registry' && !binding.registryPin) throw new Error('Registry authority requires its pin')
      }
      return document.bindings
    }
    throw new Error('Unsupported session binding schema')
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return {}
    const error = new Error('Session bindings are unreadable; execution is quarantined until the durable document is repaired.')
    error.code = 'bindings-unverifiable'
    throw error
  }
}

// Read-version metadata detects another writer's authority write.
// It cannot authorize a request; only current durable state can do that.
function authorityStamp(binding) {
  const result = {}
  for (const key of ['taskId', 'taskInstanceId', 'engine', 'preparationAuthority', 'bindingAuthority', 'registryPin', 'registryRefused']) {
    if (Object.prototype.hasOwnProperty.call(binding, key)) result[key] = binding[key]
  }
  return JSON.stringify(result)
}

// Persist ONLY the durable binding fields (whitelist): the live `_session`
// reference and any other runtime-only property must never be serialized.
function serializableBinding(binding) {
  return {
    sessionId: binding.sessionId,
    // TASK-0005 Part 7: the binding is an identity REFERENCE into
    // TaskController state. taskInstanceId is the lifecycle identity it
    // is bound to (immutable, never reused); taskId remains display.
    taskInstanceId: binding.taskInstanceId ?? null,
    taskId: binding.taskId,
    workspace: binding.workspace,
    workspaceId: binding.workspaceId ?? null,
    repositoryId: binding.repositoryId ?? null,
    checkoutId: binding.checkoutId ?? null,
    checkoutRootPath: binding.checkoutRootPath ?? null,
    executionRoot: binding.executionRoot ?? binding.workspace,
    preset: binding.preset,
    engine: binding.engine,
    description: binding.description,
    executionClass: binding.executionClass,
    reviewRequired: binding.reviewRequired,
    needsRouteCheck: binding.needsRouteCheck,
    boundAtUtc: binding.boundAtUtc,
    ...(binding.preparationAuthority ? { preparationAuthority: binding.preparationAuthority } : {}),
    // R6.3: generation-scoped Registry pin (present only for flagged binds).
    // Absent fields keep legacy persisted bindings byte-identical.
    ...(binding.bindingAuthority ? { bindingAuthority: binding.bindingAuthority } : {}),
    ...(binding.registryPin ? { registryPin: binding.registryPin } : {}),
    // R6.3.1: refusal/pending markers persist so a rejected generation can
    // never restart or recover as an ordinary legacy bind. Absent markers
    // keep legacy persisted bindings byte-identical.
    ...(binding.registryRefused ? { registryRefused: binding.registryRefused } : {}),
  }
}
// ─────────────────────────────────────────────────────────────────────────────

class BindingStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {object} options
 * @param {string} options.bindingsPath canonical data/routing/session-bindings.json
 * @param {(mountId: string) => boolean} options.isWriterAttached host bridge registry check
 * @param {Function} [options.log]
 */
function createBindingStore(options) {
  const bindingsPath = path.resolve(options.bindingsPath)
  const isWriterAttached = options.isWriterAttached
  const log = typeof options.log === 'function' ? options.log : () => {}
  const revisions = new Map()   // sessionId -> monotonic revision of its durable record (this host)
  const lastRecords = new Map() // sessionId -> last serialized record written or observed
  // Removals this single writer performed: sessionId -> authority stamp at
  // removal. Lets the store refuse a stale cached copy of a removed binding
  // (same authority) instead of resurrecting it from another plane's cache.
  const tombstones = new Map()
  const TOMBSTONE_LIMIT = 4096
  const metrics = { commits: 0, writes: 0, adopted: 0, conflicts: 0, refusedDetached: 0, refusedClosed: 0, failures: 0, removed: 0, resurrectionsPrevented: 0, revision: 0 }
  let closed = false

  function noteRecord(sessionId, record) {
    const text = JSON.stringify(record)
    if (lastRecords.get(sessionId) !== text) {
      lastRecords.set(sessionId, text)
      revisions.set(sessionId, (revisions.get(sessionId) || 0) + 1)
    }
  }

  /**
   * Commit a writer's cache. `view.cache` (sessionId -> live binding) and
   * `view.observed` (sessionId -> authority stamp the writer last saw) are the
   * writer's own maps and are updated in place exactly as the pre-P2-A
   * persistBindings updated them. Throws on refusal; the caller decides
   * whether a refusal is fatal (strict) or logged.
   */
  function commit(mountId, view, commitOptions = {}) {
    metrics.commits += 1
    if (closed) {
      metrics.refusedClosed += 1
      throw new BindingStoreError('binding-store-closed', 'The Nexus Controller binding store is closed; the binding write was refused.')
    }
    if (typeof mountId !== 'string' || !isWriterAttached(mountId)) {
      metrics.refusedDetached += 1
      throw new BindingStoreError('binding-writer-detached', 'Only an attached plane bridge may write session bindings.')
    }
    if (commitOptions.bindingsPath && path.resolve(commitOptions.bindingsPath) !== bindingsPath) {
      throw new BindingStoreError('binding-store-path-mismatch', 'The writer addresses a different binding document than the host Controller owns.')
    }
    const bindings = view.cache
    const observedBindingAuthority = view.observed
    const removedSessionId = commitOptions.removedSessionId || null
    try {
      // ── verbatim merge from the pre-P2-A persistBindings ──
      const durable = loadBindings(bindingsPath)
      for (const [id, binding] of Object.entries(durable)) {
        if (id === removedSessionId) continue
        const cached = bindings[id]
        const observed = observedBindingAuthority.get(id)
        if (cached && observed !== undefined && authorityStamp(binding) !== observed) {
          if (registrySessionBinding.classifyRegistryState(cached).state !== 'legacy' &&
              registrySessionBinding.classifyRegistryState(binding).state === 'legacy' && binding.bindingAuthority !== 'legacy-rollback') {
            const error = new Error('Durable Registry authority disappeared without explicit rollback; refusing cache overwrite.')
            error.code = 'registry-authority-unverifiable'
            throw error
          }
          if (authorityStamp(cached) !== observed) {
            metrics.conflicts += 1
            const error = new Error('Concurrent durable binding authority changed; refusing to overwrite it.')
            error.code = 'bindings-write-conflict'
            throw error
          }
          for (const field of ['preparationAuthority', 'registryPin', 'registryRefused', 'bindingAuthority']) {
            if (!Object.prototype.hasOwnProperty.call(binding, field)) delete cached[field]
          }
          Object.assign(cached, binding)
          metrics.adopted += 1
        } else if (!cached) bindings[id] = binding
        observedBindingAuthority.set(id, authorityStamp(binding))
      }
      // ── P2-A addition (single-owner fix): a removal performed through this
      // store wins over a stale cached copy with the same authority stamp.
      // A genuinely re-bound session (different authority) is written.
      const removedStamp = removedSessionId && Object.prototype.hasOwnProperty.call(durable, removedSessionId)
        ? authorityStamp(durable[removedSessionId]) : null
      for (const [id, cached] of Object.entries(bindings)) {
        if (Object.prototype.hasOwnProperty.call(durable, id) || !tombstones.has(id)) continue
        if (authorityStamp(cached) === tombstones.get(id)) {
          delete bindings[id]
          observedBindingAuthority.delete(id)
          metrics.resurrectionsPrevented += 1
          log({ event: 'binding-resurrection-prevented', mountId, sessionId: id })
        }
      }
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true })
      const serializable = {}
      for (const [sessionId, binding] of Object.entries(bindings)) serializable[sessionId] = serializableBinding(binding)
      const temporary = bindingsPath + '.' + crypto.randomUUID() + '.tmp'
      const fd = fs.openSync(temporary, 'w')
      try {
        fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, bindings: serializable }, null, 2))
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, bindingsPath)
      observedBindingAuthority.clear()
      for (const [id, binding] of Object.entries(serializable)) observedBindingAuthority.set(id, authorityStamp(binding))
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(bindingsPath), 'r')
        try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
      }
      // ── end verbatim ──
      metrics.writes += 1
      metrics.revision += 1
      for (const id of Object.keys(serializable)) tombstones.delete(id)
      if (removedSessionId && !Object.prototype.hasOwnProperty.call(serializable, removedSessionId)) {
        if (removedStamp !== null) {
          tombstones.set(removedSessionId, removedStamp)
          while (tombstones.size > TOMBSTONE_LIMIT) tombstones.delete(tombstones.keys().next().value)
        }
        metrics.removed += 1
        lastRecords.delete(removedSessionId)
        revisions.set(removedSessionId, (revisions.get(removedSessionId) || 0) + 1)
      }
      for (const [id, record] of Object.entries(serializable)) noteRecord(id, record)
      return { revision: metrics.revision }
    } catch (error) {
      metrics.failures += 1
      log({ event: 'binding-store-commit-refused', mountId, code: error && error.code ? error.code : null, error: String(error && error.message ? error.message : error) })
      throw error
    }
  }

  /** Durable read-only view of one binding (no cache, no write). */
  function read(sessionId) {
    const durable = loadBindings(bindingsPath)
    const record = Object.prototype.hasOwnProperty.call(durable, sessionId) ? durable[sessionId] : null
    if (record) noteRecord(sessionId, serializableBinding(record))
    return record ? Object.freeze({ ...record }) : null
  }

  function list() {
    return Object.freeze(Object.keys(loadBindings(bindingsPath)))
  }

  function revisionOf(sessionId) { return revisions.get(sessionId) || 0 }

  function close() { closed = true }

  return Object.freeze({
    bindingsPath,
    commit,
    read,
    list,
    revisionOf,
    close,
    metrics: () => ({ ...metrics }),
    get closed() { return closed },
  })
}

module.exports = { createBindingStore, loadBindings, authorityStamp, serializableBinding, BindingStoreError }
