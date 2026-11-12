'use strict'

/**
 * nexus/intake — durable-intake and operator-interaction CONTRACT MODELS
 * (P2-B1 §6). INACTIVE: nothing in the product calls these; no persistence,
 * no DSH session write, no second task store. They encode the exact rules the
 * P2-B2 implementation must satisfy (NEXUS-CLI-CONTRACT.md §4 and §6) so they
 * can be tested now and reused as the reference model later.
 *
 * Intake (per installation + principal + idempotency key):
 *   reserve      -> allocates taskId/sessionId/requestId once; a retry with the
 *                   identical canonical payload returns the ORIGINAL receipt
 *                   state; a different payload is IDEMPOTENCY_CONFLICT.
 *   delivered    -> only durable evidence (the exact DSH user message carrying
 *                   the reserved requestId, flushed and read back) may move an
 *                   intake to `accepted`. A client is never told "accepted"
 *                   earlier.
 *   reconcile    -> after a restart, decide from the durable DSH evidence:
 *                   input absent and never claimed -> deliver (same ids);
 *                   input present -> accepted; input claimed/turn started or
 *                   evidence ambiguous -> park (interrupted hold), NEVER a
 *                   second accepted input.
 *   completion   -> never derived here; only the Controller's authority
 *                   (TaskController ledger for legacy) may complete a task.
 * Interaction broker (approval/request, user-questions/request, operator gates):
 *   first valid decision wins; same decision repeated returns the prior
 *   receipt; stale revision -> STALE_ACTION; expired -> fail closed; foreign
 *   or unknown -> NOT_FOUND; a disconnected client never grants approval.
 */

const crypto = require('node:crypto')

function canonicalSubmission(input) {
  const canonical = { workspaceId: String(input.workspaceId), mode: String(input.mode), promptDigest: String(input.promptDigest), principalId: String(input.principalId) }
  return { canonical, fingerprint: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }
}

function createIntakeModel(options = {}) {
  const now = options.now || (() => Date.now())
  const intakes = new Map() // principalId|key -> record
  const id = (prefix) => prefix + crypto.randomBytes(16).toString('hex')

  function reserve(principalId, idempotencyKey, submission) {
    if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) return { ok: false, code: 'USAGE' }
    const { canonical, fingerprint } = canonicalSubmission({ ...submission, principalId })
    const key = principalId + '|' + idempotencyKey
    const existing = intakes.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' }
      return { ok: true, replay: true, receipt: receiptOf(existing) }
    }
    const record = { key, fingerprint, canonical, taskId: id('task_'), sessionId: 'session-' + crypto.randomUUID(), requestId: crypto.randomUUID(), state: 'reserved', createdAt: now() }
    intakes.set(key, record)
    return { ok: true, replay: false, receipt: receiptOf(record) }
  }

  function receiptOf(record) {
    return Object.freeze({ taskId: record.taskId, sessionId: record.sessionId, requestId: record.requestId, status: record.state === 'accepted' ? 'accepted' : record.state === 'parked' ? 'interrupted' : 'pending-acceptance' })
  }

  /**
   * Durable evidence from the exact DSH session: the persisted user messages'
   * source request ids, whether a turn claimed input, and whether the
   * read-back after flush succeeded.
   */
  function delivered(principalId, idempotencyKey, evidence) {
    const record = intakes.get(principalId + '|' + idempotencyKey)
    if (!record) return { ok: false, code: 'NOT_FOUND' }
    if (!evidence || evidence.flushedReadBack !== true || !Array.isArray(evidence.persistedRequestIds)) return { ok: false, code: 'SUBMISSION_UNCERTAIN' }
    const copies = evidence.persistedRequestIds.filter((rid) => rid === record.requestId).length
    if (copies !== 1) { record.state = 'parked'; return { ok: false, code: copies === 0 ? 'SUBMISSION_UNCERTAIN' : 'INTERNAL', parked: copies > 1 } }
    record.state = 'accepted'
    return { ok: true, receipt: receiptOf(record) }
  }

  /** Restart reconciliation; returns the single safe next action. */
  function reconcile(principalId, idempotencyKey, evidence) {
    const record = intakes.get(principalId + '|' + idempotencyKey)
    if (!record) return { action: 'none', code: 'NOT_FOUND' }
    if (record.state === 'accepted') return { action: 'none', receipt: receiptOf(record) }
    if (!evidence || evidence.readable !== true) { record.state = 'parked'; return { action: 'park', reason: 'durable-evidence-unreadable' } }
    const copies = (evidence.persistedRequestIds || []).filter((rid) => rid === record.requestId).length
    if (copies === 1) { record.state = 'accepted'; return { action: 'complete-intake', receipt: receiptOf(record) } }
    if (copies > 1) { record.state = 'parked'; return { action: 'park', reason: 'duplicate-input' } }
    if (evidence.turnStarted || evidence.inputClaimed) { record.state = 'parked'; return { action: 'park', reason: 'work-may-have-run' } }
    return { action: 'deliver', sessionId: record.sessionId, requestId: record.requestId }
  }

  return Object.freeze({ reserve, delivered, reconcile, snapshot: () => [...intakes.values()].map((r) => ({ ...r })) })
}

function createInteractionBroker(options = {}) {
  const now = options.now || (() => Date.now())
  const actions = new Map()
  function offer(taskId, request) {
    const action = { id: 'act_' + crypto.randomBytes(12).toString('hex'), taskId, kind: request.kind, revision: String(request.revision), choices: request.choices.map((c) => c.id), deadline: now() + (request.ttlMs || 60000), decision: null }
    actions.set(action.id, action)
    return Object.freeze({ id: action.id, kind: action.kind, revision: action.revision, choices: action.choices.slice(), deadline: action.deadline })
  }
  function respond(principal, taskId, actionId, expectedRevision, choiceId) {
    const action = actions.get(actionId)
    if (!action || action.taskId !== taskId || !principal || principal.kind !== 'local-owner') return { ok: false, code: 'NOT_FOUND' }
    if (action.decision) {
      if (action.decision.choiceId === choiceId && action.decision.revision === String(expectedRevision)) return { ok: true, disposition: 'duplicate', receipt: action.decision }
      return { ok: false, code: 'STALE_ACTION' }
    }
    if (now() > action.deadline) return { ok: false, code: 'STALE_ACTION', expired: true }
    if (String(expectedRevision) !== action.revision) return { ok: false, code: 'STALE_ACTION' }
    if (!action.choices.includes(choiceId)) return { ok: false, code: 'USAGE' }
    action.decision = Object.freeze({ actionId, choiceId, revision: action.revision, at: now() })
    return { ok: true, disposition: 'accepted', receipt: action.decision }
  }
  /** Outcome for the waiting DSH request: only an explicit grant allows. */
  function outcome(actionId) {
    const action = actions.get(actionId)
    if (!action || !action.decision) return now() > (action ? action.deadline : 0) ? 'rejected' : 'pending'
    return action.decision.choiceId === 'allow-once' ? 'allowed-once' : 'rejected'
  }
  return Object.freeze({ offer, respond, outcome })
}

module.exports = { canonicalSubmission, createIntakeModel, createInteractionBroker, ACTIVE: false }
