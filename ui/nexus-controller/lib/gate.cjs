'use strict'

/**
 * gate.cjs — controller-owned operator gates (TASK-0004).
 *
 * A gate is an authoritative record that the controller requires HUMAN input
 * before it can proceed. It lives in data/completion/gates.jsonl (append-only
 * journal; the LAST record for a session/workspace/task is the current gate)
 * and every mutation appends a new record with an incremented revision, so a
 * stale UI action (old gateId + revision) fails closed.
 *
 * The browser never edits controller state: it POSTs identifiers only
 * (sessionId, gateId, actionId, requestId) to the action route; the route
 * validates the gate is current, the action is allowed, the requestId is not
 * a replay, and then performs the bounded controller transition.
 *
 * Identity isolation (TASK-0003.2): gates are joined by sessionId AND
 * normalized workspace + taskId — never by taskId alone.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const GATE_OPEN_STATUSES = new Set(['waiting'])
const GATE_ALLOWED_ACTIONS = new Set(['approve', 'reject'])

/** Normalize a workspace path for identity joins (mirrors status.cjs). */
function normalizeWorkspacePath(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return ''
  let normalized = workspace.replace(/[\\/]+/g, '\\')
  while (normalized.length > 3 && normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized.toLowerCase()
}

function gatesPathOf(dataRoot) {
  return path.join(dataRoot, 'completion', 'gates.jsonl')
}

function actionsPathOf(dataRoot) {
  return path.join(dataRoot, 'completion', 'gate-actions.jsonl')
}

function readJsonLines(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const records = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        /* one corrupt line never breaks the journal */
      }
    }
    return records
  } catch {
    return []
  }
}

/** The current gate for a session binding, or null. */
function currentGateFor(dataRoot, sessionId, workspace, taskId) {
  const records = readJsonLines(gatesPathOf(dataRoot))
  const normalized = normalizeWorkspacePath(workspace)
  let current = null
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.sessionId !== sessionId) continue
    if (normalizeWorkspacePath(record.workspace) !== normalized) continue
    if (String(record.taskId) !== String(taskId)) continue
    current = record
  }
  return current
}

function appendGateRecord(dataRoot, record) {
  const filePath = gatesPathOf(dataRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
}

/**
 * Open an operator gate for a binding when none is currently waiting.
 * Returns the current gate (created or existing). Fails closed on invalid
 * input. This is the ONLY gate-creation entry point used by the controller.
 */
function ensureGate(dataRoot, binding, reason, extra) {
  if (!binding || typeof binding !== 'object') return null
  const sessionId = binding.sessionId
  const workspace = binding.workspace
  const taskId = binding.taskId
  if (!sessionId || !workspace || !taskId) return null
  const current = currentGateFor(dataRoot, sessionId, workspace, taskId)
  if (current && GATE_OPEN_STATUSES.has(String(current.status))) return current
  const gateId = 'gate-' + crypto.randomUUID()
  const revision = (current && Number.isInteger(current.revision) ? current.revision : 0) + 1
  const record = {
    schemaVersion: 1,
    gateId,
    kind: 'operator',
    reason: String(reason || 'review-required'),
    status: 'waiting',
    allowedActions: ['approve', 'reject'],
    createdAtUtc: new Date().toISOString(),
    sessionId,
    workspace,
    taskId,
    attempt: extra && Number.isInteger(extra.attempt) ? extra.attempt : null,
    reviewVerdict: extra && typeof extra.reviewVerdict === 'string' ? extra.reviewVerdict : null,
    revision,
  }
  appendGateRecord(dataRoot, record)
  return record
}

/**
 * Supersede a waiting gate (e.g. a newer review result changed the decision).
 * Appends a resolved record; the previous revision remains in the journal.
 */
function supersedeGate(dataRoot, binding, reason) {
  const current = currentGateFor(dataRoot, binding.sessionId, binding.workspace, binding.taskId)
  if (!current || !GATE_OPEN_STATUSES.has(String(current.status))) return null
  const record = {
    schemaVersion: 1,
    gateId: current.gateId,
    kind: current.kind,
    reason: current.reason,
    status: 'superseded',
    allowedActions: current.allowedActions,
    createdAtUtc: current.createdAtUtc,
    resolvedAtUtc: new Date().toISOString(),
    resolvedBy: 'controller',
    supersededReason: String(reason || 'decision-changed'),
    sessionId: current.sessionId,
    workspace: current.workspace,
    taskId: current.taskId,
    attempt: current.attempt,
    revision: (Number.isInteger(current.revision) ? current.revision : 0) + 1,
  }
  appendGateRecord(dataRoot, record)
  return record
}

/** Validate one operator action request. Returns {ok} or {ok:false, error}. */
function validateGateAction(dataRoot, binding, request) {
  if (!request || typeof request !== 'object') return { ok: false, error: 'missing-request' }
  const sessionId = String(request.sessionId || '')
  const gateId = String(request.gateId || '')
  const actionId = String(request.actionId || '')
  const requestId = String(request.requestId || '')
  if (!sessionId || !gateId || !actionId || !requestId) {
    return { ok: false, error: 'missing-identifier' }
  }
  if (!binding || !binding.workspace || !binding.taskId) return { ok: false, error: 'session-unbound' }
  if (String(binding.sessionId) !== sessionId) return { ok: false, error: 'session-mismatch' }
  if (!GATE_ALLOWED_ACTIONS.has(actionId)) return { ok: false, error: 'action-not-allowed' }
  const gate = currentGateFor(dataRoot, sessionId, binding.workspace, binding.taskId)
  if (!gate || String(gate.gateId) !== gateId) return { ok: false, error: 'gate-stale' }
  if (!GATE_OPEN_STATUSES.has(String(gate.status))) return { ok: false, error: 'gate-not-waiting' }
  if (!Array.isArray(gate.allowedActions) || !gate.allowedActions.includes(actionId)) {
    return { ok: false, error: 'action-not-advertised' }
  }
  // Duplicate request replay: the same requestId must never mutate twice.
  const actions = readJsonLines(actionsPathOf(dataRoot))
  for (const action of actions) {
    if (action && String(action.requestId) === requestId && String(action.gateId) === gateId) {
      return { ok: false, error: 'request-replay', replay: true }
    }
  }
  return { ok: true, gate }
}

/** Resolve a waiting gate with the operator action (append + journal the action). */
function resolveGate(dataRoot, binding, gate, actionId, requestId) {
  const record = {
    schemaVersion: 1,
    gateId: gate.gateId,
    kind: gate.kind,
    reason: gate.reason,
    status: actionId === 'approve' ? 'approved' : 'rejected',
    allowedActions: gate.allowedActions,
    createdAtUtc: gate.createdAtUtc,
    resolvedAtUtc: new Date().toISOString(),
    resolvedBy: 'operator-gui',
    actionId,
    sessionId: gate.sessionId,
    workspace: gate.workspace,
    taskId: gate.taskId,
    attempt: gate.attempt,
    reviewVerdict: gate.reviewVerdict,
    revision: (Number.isInteger(gate.revision) ? gate.revision : 0) + 1,
  }
  appendGateRecord(dataRoot, record)
  const actionPath = actionsPathOf(dataRoot)
  fs.mkdirSync(path.dirname(actionPath), { recursive: true })
  fs.appendFileSync(
    actionPath,
    JSON.stringify({ requestId, gateId: gate.gateId, actionId, sessionId: binding.sessionId, atUtc: record.resolvedAtUtc }) + '\n',
    'utf8',
  )
  return record
}

module.exports = {
  normalizeWorkspacePath,
  gatesPathOf,
  actionsPathOf,
  readJsonLines,
  currentGateFor,
  ensureGate,
  supersedeGate,
  validateGateAction,
  resolveGate,
}
