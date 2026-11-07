'use strict'

/**
 * Dsh-SessionEvents.cjs — the one place Nexus reads a DSH session's events.
 *
 * DSH 0.1.x exposed `session.events` (a live array). DSH 0.2.x removed it:
 * the log is private and the only synchronous full reader is
 * `Session.snapshotEvents()` (upstream-deprecated for NEW code; existing
 * synchronous readers may remain, upstream note 2026-09-09). Nexus identity
 * and boundary logic is inherently synchronous (request-time authority), so
 * it keeps one synchronous reader here instead of scattering deprecated
 * calls. Test doubles and 0.1.x hosts with an `events` array keep working.
 *
 * Returns the full ordered event list (fork-inherited prefix included, as
 * `session.events` did), or `undefined` when the object exposes neither
 * reader. A present-but-malformed `events` is returned as-is so callers
 * keep their fail-closed type checks.
 */
function sessionEvents(session) {
  if (!session || typeof session !== 'object') return undefined
  if (session.events !== undefined) return session.events
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return undefined
}

/** Number of events in the log, or -1 when unreadable. */
function sessionEventCount(session) {
  const events = sessionEvents(session)
  return Array.isArray(events) ? events.length : -1
}

module.exports = { sessionEvents, sessionEventCount }
