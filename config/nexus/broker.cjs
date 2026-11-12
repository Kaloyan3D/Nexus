'use strict'

/**
 * nexus/broker — live, task-bound operator interaction broker (P2-B2B).
 *
 * Managed sessions' DSH `approval/request` (and the bounded subset of
 * `user-questions/request` the broker supports) are answered HERE instead of
 * by Web remote peers. DSH permissions still decide whether a tool needs
 * approval at all; the broker only arbitrates who may answer and how:
 *   - each request becomes one operator action bound to the exact task,
 *     session and a revision, offered through the shared task API to GUI and
 *     CLI alike;
 *   - the first valid authorized response wins; a duplicate identical
 *     response returns the prior receipt; anything else is STALE_ACTION;
 *   - expired, aborted (turn cancelled), cancelled-task or unanswered requests
 *     resolve without a grant ('rejected' for approvals); a disconnected
 *     client never approves anything;
 *   - only an explicit `allow-once` choice grants an approval.
 * The broker holds no durable state: a pending request belongs to a live DSH
 * turn and dies with it (after a restart the interrupted turn is reconciled,
 * never re-approved).
 */

const crypto = require('node:crypto')

const DEFAULT_TTL_MS = 10 * 60 * 1000

function createApprovalBroker(options = {}) {
  const now = options.now || (() => Date.now())
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
  const actions = new Map() // actionId -> action
  let version = 0
  const metrics = { offered: 0, granted: 0, refused: 0, expired: 0, aborted: 0, stale: 0, duplicates: 0 }

  function bump() { version += 1; onChange() }

  function settle(action, outcome, reason) {
    if (action.settled) return
    action.settled = { outcome, reason, at: now() }
    clearTimeout(action.timer)
    if (action.signal && action.onAbort) action.signal.removeEventListener('abort', action.onAbort)
    action.resolve(outcome)
    bump()
  }

  /**
   * Offer one interaction and wait for its outcome.
   * @returns {Promise<{ choiceId: string | null, reason: string }>}
   */
  function request(input) {
    const id = 'act_' + crypto.randomBytes(12).toString('hex')
    const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS
    return new Promise((resolve) => {
      const action = {
        id,
        taskId: input.taskId,
        sessionId: input.sessionId,
        kind: input.kind,
        label: input.label,
        choices: input.choices.map((choice) => ({ id: String(choice.id), label: String(choice.label) })),
        revision: '1',
        deadline: now() + ttlMs,
        decision: null,
        settled: null,
        signal: input.signal,
        resolve,
      }
      action.timer = setTimeout(() => { metrics.expired += 1; settle(action, { choiceId: null, reason: 'expired' }) }, ttlMs)
      if (typeof action.timer.unref === 'function') action.timer.unref()
      if (input.signal) {
        if (input.signal.aborted) { metrics.aborted += 1; settle(action, { choiceId: null, reason: 'aborted' }); return }
        action.onAbort = () => { metrics.aborted += 1; settle(action, { choiceId: null, reason: 'aborted' }) }
        input.signal.addEventListener('abort', action.onAbort, { once: true })
      }
      actions.set(id, action)
      metrics.offered += 1
      log({ event: 'broker-offered', actionId: id, taskId: action.taskId, kind: action.kind })
      bump()
    })
  }

  /** First valid authorized response wins. */
  function respond(principal, input) {
    const action = actions.get(input.actionId)
    if (!action || action.taskId !== input.taskId || !principal || principal.kind !== 'local-owner' || !Array.isArray(principal.capabilities) || !principal.capabilities.includes('tasks:respond')) {
      return { ok: false, code: 'NOT_FOUND' }
    }
    if (action.decision) {
      if (action.decision.choiceId === input.choiceId && action.decision.revision === String(input.expectedRevision)) { metrics.duplicates += 1; return { ok: true, disposition: 'duplicate', receipt: action.decision } }
      metrics.stale += 1
      return { ok: false, code: 'STALE_ACTION' }
    }
    if (action.settled) { metrics.stale += 1; return { ok: false, code: 'STALE_ACTION', reason: action.settled.reason } }
    if (String(input.expectedRevision) !== action.revision) { metrics.stale += 1; return { ok: false, code: 'STALE_ACTION' } }
    if (!action.choices.some((choice) => choice.id === input.choiceId)) return { ok: false, code: 'USAGE' }
    action.decision = Object.freeze({ actionId: action.id, choiceId: input.choiceId, revision: action.revision, principal: principal.via || principal.kind, at: new Date(now()).toISOString() })
    if (input.choiceId === 'allow-once') metrics.granted += 1; else metrics.refused += 1
    settle(action, { choiceId: input.choiceId, reason: 'answered' })
    log({ event: 'broker-answered', actionId: action.id, taskId: action.taskId, choiceId: input.choiceId, via: principal.via || null })
    return { ok: true, disposition: 'accepted', receipt: action.decision }
  }

  /** Withdraw every pending action of a task (cancellation). */
  function cancelTask(taskId) {
    for (const action of actions.values()) if (action.taskId === taskId && !action.settled) settle(action, { choiceId: null, reason: 'task-cancelled' })
  }

  function pendingFor(taskId) {
    return [...actions.values()].filter((action) => action.taskId === taskId && !action.settled).map((action) => ({
      id: action.id, kind: action.kind, label: action.label, revision: action.revision, deadline: new Date(action.deadline).toISOString(), choices: action.choices.map((c) => ({ ...c })),
    }))
  }

  function dispose() { for (const action of actions.values()) if (!action.settled) settle(action, { choiceId: null, reason: 'host-disposed' }) }

  return Object.freeze({ request, respond, cancelTask, pendingFor, dispose, version: () => version, metrics: () => ({ ...metrics }) })
}

module.exports = { createApprovalBroker, DEFAULT_TTL_MS }
