'use strict'

/**
 * nexus/strategy-index — the in-memory strategy extension boundary (P1, C02).
 *
 * A strategy is a replaceable engineering policy (EMv1 Dual compatibility,
 * EMv2 Muse, later Nova Simple/Complex/Parallel). The index stores
 * implementations only:
 *   - no model/provider/entitlement mapping (the Nexus Model Registry and the
 *     existing route/session-binding modules stay the only authority);
 *   - no durable writes and no task authority — a strategy returns typed
 *     decisions, the Controller validates and executes them;
 *   - no `complete` decision exists in contract major 1.
 *
 * Owned by the host Controller composition. Registration returns an exact
 * disposer; disposal is idempotent and closes the strategy for new opens.
 */

const STRATEGY_CONTRACT_MAJOR = 1

// Decision kinds a StrategyV1 may return. Completion is deliberately absent:
// only the Controller (through the legacy TaskController completion path)
// may mark a task complete.
const DECISION_KINDS = Object.freeze([
  'runRoot',        // admit the root engineering turn ({ stepRouting, executionLabel })
  'runReview',      // dispatch the existing independent review path
  'refuse',         // fail closed with a controller notice ({ code, notice })
  'degradeLegacy',  // historical legacy degradation (Dual only): continue without controller state
])

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

class StrategyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

function freezeList(value, field, id) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new StrategyError('strategy-descriptor-invalid', `${id}: ${field} must be an array of non-empty strings`)
  }
  return Object.freeze([...value])
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new StrategyError('strategy-descriptor-invalid', 'descriptor must be an object')
  const id = descriptor.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new StrategyError('strategy-descriptor-invalid', `invalid strategy id ${JSON.stringify(id)}`)
  if (!Number.isInteger(descriptor.contractMajor) || descriptor.contractMajor < 1) {
    throw new StrategyError('strategy-descriptor-invalid', `${id}: contractMajor must be a positive integer`)
  }
  if (descriptor.contractMajor !== STRATEGY_CONTRACT_MAJOR) {
    throw new StrategyError('strategy-contract-unsupported', `${id}: contract major ${descriptor.contractMajor} is not supported (host supports ${STRATEGY_CONTRACT_MAJOR})`)
  }
  if (typeof descriptor.build !== 'string' || descriptor.build === '') throw new StrategyError('strategy-descriptor-invalid', `${id}: build is required`)
  const engines = freezeList(descriptor.engines, 'engines', id)
  if (engines.length === 0) throw new StrategyError('strategy-descriptor-invalid', `${id}: at least one engine is required`)
  return Object.freeze({
    id,
    contractMajor: descriptor.contractMajor,
    build: descriptor.build,
    label: typeof descriptor.label === 'string' ? descriptor.label : id,
    engines,
    roles: freezeList(descriptor.roles, 'roles', id),
    planes: freezeList(descriptor.planes, 'planes', id),
    mandatory: descriptor.mandatory !== false,
    capabilities: Object.freeze({
      independentReview: Boolean(descriptor.capabilities && descriptor.capabilities.independentReview),
      delegation: Boolean(descriptor.capabilities && descriptor.capabilities.delegation),
      workers: Boolean(descriptor.capabilities && descriptor.capabilities.workers),
      fallback: Boolean(descriptor.capabilities && descriptor.capabilities.fallback),
    }),
  })
}

function validateImplementation(id, implementation) {
  if (!implementation || typeof implementation !== 'object') throw new StrategyError('strategy-implementation-invalid', `${id}: factory returned no implementation`)
  if (typeof implementation.decide !== 'function') throw new StrategyError('strategy-implementation-invalid', `${id}: decide() is required`)
  if (implementation.readiness !== undefined && typeof implementation.readiness !== 'function') {
    throw new StrategyError('strategy-implementation-invalid', `${id}: readiness must be a function`)
  }
  return implementation
}

/** Validate one strategy decision against the contract (shape only). */
function validateDecision(id, decision) {
  if (!decision || typeof decision !== 'object' || typeof decision.kind !== 'string') {
    throw new StrategyError('strategy-decision-invalid', `${id}: decision must be an object with a kind`)
  }
  if (!DECISION_KINDS.includes(decision.kind)) {
    throw new StrategyError('strategy-decision-forbidden', `${id}: decision kind ${JSON.stringify(decision.kind)} is not permitted by contract major ${STRATEGY_CONTRACT_MAJOR}`)
  }
  if (decision.kind === 'refuse' && (typeof decision.code !== 'string' || decision.code === '')) {
    throw new StrategyError('strategy-decision-invalid', `${id}: refuse requires a code`)
  }
  if (decision.kind === 'runRoot' && typeof decision.stepRouting !== 'boolean') {
    throw new StrategyError('strategy-decision-invalid', `${id}: runRoot requires a boolean stepRouting`)
  }
  return Object.freeze({ ...decision })
}

function createStrategyIndex(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const entries = new Map() // id -> { descriptor, implementation, disposed }
  let closed = false

  function key(id) { return id }

  /**
   * Register a strategy. Returns an exact, idempotent disposer.
   * Rejects duplicates (same id under this composition), unsupported contract
   * majors and engine claims already owned by another registered strategy.
   */
  function register(descriptorInput, factory) {
    if (closed) throw new StrategyError('strategy-index-closed', 'the strategy index is disposed')
    const descriptor = validateDescriptor(descriptorInput)
    if (entries.has(key(descriptor.id))) {
      throw new StrategyError('strategy-duplicate', `${descriptor.id} is already registered`)
    }
    for (const entry of entries.values()) {
      const overlap = entry.descriptor.engines.filter((engine) => descriptor.engines.includes(engine))
      if (overlap.length) throw new StrategyError('strategy-engine-conflict', `${descriptor.id}: engine ${overlap[0]} is already served by ${entry.descriptor.id}`)
    }
    if (typeof factory !== 'function') throw new StrategyError('strategy-implementation-invalid', `${descriptor.id}: factory must be a function`)
    const implementation = validateImplementation(descriptor.id, factory(descriptor))
    const entry = { descriptor, implementation, disposed: false }
    entries.set(key(descriptor.id), entry)
    log({ event: 'strategy-registered', strategyId: descriptor.id, contractMajor: descriptor.contractMajor, build: descriptor.build })
    return function dispose() {
      if (entry.disposed) return false
      entry.disposed = true
      if (entries.get(key(descriptor.id)) === entry) entries.delete(key(descriptor.id))
      try { if (typeof implementation.dispose === 'function') implementation.dispose() } catch (error) {
        log({ event: 'strategy-dispose-failed', strategyId: descriptor.id, error: String(error && error.message ? error.message : error) })
      }
      log({ event: 'strategy-disposed', strategyId: descriptor.id })
      return true
    }
  }

  function list() {
    return [...entries.values()].map((entry) => entry.descriptor)
  }

  /** Resolve the strategy that serves an engine. Missing => typed failure. */
  function forEngine(engine) {
    for (const entry of entries.values()) {
      if (entry.descriptor.engines.includes(engine)) return entry
    }
    throw new StrategyError('strategy-missing', `no registered strategy serves engine ${JSON.stringify(engine)}`)
  }

  /** Open by exact id and contract major (a persisted pin). */
  function open(id, contractMajor = STRATEGY_CONTRACT_MAJOR) {
    const entry = entries.get(key(id))
    if (!entry) throw new StrategyError('strategy-missing', `strategy ${id} is not registered`)
    if (entry.descriptor.contractMajor !== contractMajor) {
      throw new StrategyError('strategy-contract-unsupported', `${id}: pinned major ${contractMajor} differs from registered ${entry.descriptor.contractMajor}`)
    }
    return entry
  }

  function readiness(context) {
    return list().map((descriptor) => {
      const entry = entries.get(key(descriptor.id))
      let result = { ready: true, reason: null }
      try {
        if (entry && typeof entry.implementation.readiness === 'function') {
          const value = entry.implementation.readiness(context || {})
          result = { ready: Boolean(value && value.ready), reason: value && value.reason ? String(value.reason) : null }
        }
      } catch (error) {
        result = { ready: false, reason: String(error && error.message ? error.message : error) }
      }
      return { id: descriptor.id, contractMajor: descriptor.contractMajor, build: descriptor.build, engines: descriptor.engines, mandatory: descriptor.mandatory, ...result }
    })
  }

  /** Require the given strategy ids to be registered (mandatory set). */
  function assertMandatory(ids) {
    const missing = ids.filter((id) => !entries.has(key(id)))
    if (missing.length) throw new StrategyError('strategy-missing', `mandatory strategies not registered: ${missing.join(', ')}`)
  }

  function dispose() {
    if (closed) return
    closed = true
    for (const entry of [...entries.values()]) {
      entry.disposed = true
      try { if (typeof entry.implementation.dispose === 'function') entry.implementation.dispose() } catch { /* contained */ }
    }
    entries.clear()
  }

  return Object.freeze({ register, list, forEngine, open, readiness, assertMandatory, dispose, get closed() { return closed } })
}

module.exports = {
  STRATEGY_CONTRACT_MAJOR,
  DECISION_KINDS,
  StrategyError,
  createStrategyIndex,
  validateDescriptor,
  validateDecision,
}
