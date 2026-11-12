'use strict'

/**
 * nexus/session-health — explicit holds for DSH 0.2 session histories that
 * pre-P2-B2C Nexus writers made invalid (P2-B2C, Task C).
 *
 * DSH 0.2 enforces two format-v4 rules ONLY when a log is read back (cold
 * restore, resume, persistence reads), never on live append:
 *   1. every message source has a producer-owned kind (`plugin` is retired);
 *   2. the first surface event is the protected `system/message` head.
 * Older Nexus wrote Controller notices that broke both. Consequences:
 *   - a persisted log with a violation cannot be opened at all after a restart
 *     (DSH refuses it); the GUI/CLI would otherwise only see a generic failure;
 *   - a LATENT log (a surface notice first, no system message yet) is still
 *     readable, but its next model step would append the system message after
 *     the notice and make the log permanently unreadable.
 *
 * Verdicts (typed hold reasons):
 *   healthy                                       readable and valid
 *   session-history-retired-source-kind           DSH refuses: `plugin` source kind
 *   session-history-notice-before-head            DSH refuses: surface event before the system head
 *   session-history-notice-before-head-pending    latent: readable, next step would corrupt it
 *   session-history-unreadable                    DSH refuses for another reason (corrupt/partial)
 * Policy: held sessions are never resumed or executed by Nexus (the host gate
 * refuses their steps); files are never modified; checking is read-only (a
 * persistence READ handle or the live in-memory log; no agent is activated).
 * Repair: none is implemented. The retired-kind case has a deterministic,
 * lossless mapping (`plugin`+`aih-controller` -> `aih-controller`) but applying
 * it means rewriting a log, which needs a separate, authorized migration with
 * backups and identity checks. Notice-before-head cannot be repaired without
 * reordering events (not lossless).
 */

const SURFACE = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
const HOLD = Object.freeze({
  RETIRED_SOURCE_KIND: 'session-history-retired-source-kind',
  NOTICE_BEFORE_HEAD: 'session-history-notice-before-head',
  NOTICE_BEFORE_HEAD_PENDING: 'session-history-notice-before-head-pending',
  UNREADABLE: 'session-history-unreadable',
})
const REPAIR = Object.freeze({
  [HOLD.RETIRED_SOURCE_KIND]: 'mappable-not-implemented',
  [HOLD.NOTICE_BEFORE_HEAD]: 'not-repairable-losslessly',
  [HOLD.NOTICE_BEFORE_HEAD_PENDING]: 'not-repairable-losslessly',
  [HOLD.UNREADABLE]: 'unknown',
})

function messagesOf(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return []
  if (event.type === 'user/message') return [data]
  if (event.type === 'agent/inbox/spliced') return Array.isArray(data.inserted) ? data.inserted : []
  if (['system/message', 'assistant/message', 'tool/result'].includes(event.type)) return data.message ? [data.message] : []
  return []
}

/** Classify an ordered event list (raw durable rows or the live log). Pure. */
function classifyEvents(events) {
  const list = Array.isArray(events) ? events : []
  const retiredSourceSeqs = list.filter((event) => messagesOf(event).some((m) => m && m.source && m.source.kind === 'plugin')).map((event) => event.seq)
  const surface = list.filter((event) => event && SURFACE.has(event.type) && event.surfaceOp !== undefined)
  const first = surface[0]
  const hasSystem = surface.some((event) => event.type === 'system/message')
  const beforeHead = Boolean(first && first.type !== 'system/message')
  let reason = null
  if (retiredSourceSeqs.length) reason = HOLD.RETIRED_SOURCE_KIND
  else if (beforeHead && hasSystem) reason = HOLD.NOTICE_BEFORE_HEAD
  else if (beforeHead) reason = HOLD.NOTICE_BEFORE_HEAD_PENDING
  return {
    state: reason ? 'held' : 'healthy',
    reason,
    retiredSourceSeqs,
    firstSurface: first ? { seq: first.seq, type: first.type } : null,
  }
}

/** Map a DSH durable-read refusal to a typed hold reason. */
function reasonOfReadError(message) {
  const text = String(message || '')
  if (/producer-owned source kind/.test(text)) return HOLD.RETIRED_SOURCE_KIND
  if (/protected first surface head/.test(text)) return HOLD.NOTICE_BEFORE_HEAD
  return HOLD.UNREADABLE
}

function verdict(sessionId, state, reason, extra = {}) {
  return Object.freeze({ sessionId, state, reason, repair: reason ? REPAIR[reason] : null, checkedAt: new Date().toISOString(), ...extra })
}

/**
 * @param {object} ports
 * @param {(sessionId: string) => Promise<object[]>} ports.readDurable DSH persistence READ (throws on refusal)
 * @param {(sessionId: string) => object[] | undefined} ports.liveEvents live in-memory log, when the session is open
 * @param {Function} [ports.log]
 */
function createSessionHealth(ports) {
  const cache = new Map() // sessionId -> verdict (held verdicts are sticky for the host lifetime)
  const log = typeof ports.log === 'function' ? ports.log : () => {}
  const metrics = { checks: 0, held: 0 }

  function record(result) {
    const previous = cache.get(result.sessionId)
    cache.set(result.sessionId, result)
    if (result.state === 'held' && (!previous || previous.state !== 'held')) {
      metrics.held += 1
      log({ event: 'session-history-held', sessionId: result.sessionId, reason: result.reason, repair: result.repair })
    }
    return result
  }

  /** Synchronous check of an OPEN session (its live log). Used by the step gate. */
  function checkLive(sessionId) {
    // Verdicts are stable: current writers never produce either violation, so
    // a session found healthy (or held) stays so for the host's lifetime.
    const cached = cache.get(sessionId)
    if (cached && cached.state !== 'unknown') return cached
    const events = ports.liveEvents(sessionId)
    if (!Array.isArray(events)) return cached || null
    metrics.checks += 1
    const facts = classifyEvents(events)
    return record(verdict(sessionId, facts.state, facts.reason, { source: 'live', firstSurface: facts.firstSurface, retiredSourceSeqs: facts.retiredSourceSeqs }))
  }

  /** Read-only check of any stored session (live log if open, else a persistence READ). */
  async function check(sessionId) {
    const live = checkLive(sessionId)
    if (live) return live
    const cached = cache.get(sessionId)
    if (cached) return cached
    metrics.checks += 1
    let events
    try { events = await ports.readDurable(sessionId) } catch (error) {
      const message = String(error && error.message ? error.message : error)
      if (/not found|ENOENT|no such session/i.test(message)) return verdict(sessionId, 'unknown', null, { source: 'durable', detail: 'session not stored' })
      return record(verdict(sessionId, 'held', reasonOfReadError(message), { source: 'durable', detail: message.slice(0, 300) }))
    }
    const facts = classifyEvents(events)
    return record(verdict(sessionId, facts.state, facts.reason, { source: 'durable', firstSurface: facts.firstSurface, retiredSourceSeqs: facts.retiredSourceSeqs }))
  }

  /** The session's immutable cwd (live header or stored header); null when unknown. */
  async function cwdOf(sessionId) {
    if (typeof ports.sessionCwd !== 'function') return null
    try { return (await ports.sessionCwd(sessionId)) || null } catch { return null }
  }

  return Object.freeze({
    check,
    checkLive,
    cwdOf,
    peek: (sessionId) => cache.get(sessionId) || null,
    metrics: () => ({ ...metrics, cached: cache.size }),
  })
}

module.exports = { createSessionHealth, classifyEvents, reasonOfReadError, messagesOf, HOLD, REPAIR }
