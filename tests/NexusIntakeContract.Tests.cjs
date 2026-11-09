'use strict'

/**
 * P2-B1 §6: durable-intake and interaction CONTRACT MODELS (inactive).
 * Encodes the rules P2-B2 must satisfy; nothing here is wired into the product.
 */

const assert = require('node:assert/strict')
const intake = require('../config/nexus/intake.cjs')
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }

const submission = { workspaceId: 'ws-1', mode: 'engineering-v2', promptDigest: 'sha256:' + 'a'.repeat(64) }

assert.equal(intake.ACTIVE, false, 'the contract models are not active in the product')

{
  const model = intake.createIntakeModel()
  const first = model.reserve('owner', 'studio-613', submission)
  assert.equal(first.ok, true); assert.equal(first.receipt.status, 'pending-acceptance', 'reservation is never reported as accepted')
  const retry = model.reserve('owner', 'studio-613', submission)
  assert.equal(retry.replay, true); assert.deepEqual(retry.receipt, first.receipt, 'a retry returns the original identities')
  assert.equal(model.reserve('owner', 'studio-613', { ...submission, promptDigest: 'sha256:' + 'b'.repeat(64) }).code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(model.reserve('owner', 'studio-613', { ...submission, mode: 'engineering-v1' }).code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(model.reserve('other-principal', 'studio-613', submission).receipt.taskId !== first.receipt.taskId, true, 'keys are scoped per principal')
  assert.equal(model.reserve('owner', 'bad key', submission).code, 'USAGE')
  pass('idempotent reservation: same payload replays, different payload conflicts, keys scoped per principal')
}

{
  const model = intake.createIntakeModel()
  const { receipt } = model.reserve('owner', 'k1', submission)
  assert.equal(model.delivered('owner', 'k1', { persistedRequestIds: [receipt.requestId] }).code, 'SUBMISSION_UNCERTAIN', 'no acceptance without flush and read-back')
  assert.equal(model.delivered('owner', 'k1', { flushedReadBack: true, persistedRequestIds: [] }).code, 'SUBMISSION_UNCERTAIN')
  const accepted = model.delivered('owner', 'k1', { flushedReadBack: true, persistedRequestIds: ['other', receipt.requestId] })
  assert.equal(accepted.ok, true); assert.equal(accepted.receipt.status, 'accepted')
  const { receipt: dup } = model.reserve('owner', 'k2', submission)
  const doubled = model.delivered('owner', 'k2', { flushedReadBack: true, persistedRequestIds: [dup.requestId, dup.requestId] })
  assert.equal(doubled.ok, false); assert.equal(doubled.parked, true, 'two accepted inputs park the task')
  pass('acceptance is reported only after exactly one durable, read-back input carrying the reserved request id')
}

{
  // Restart during partial admission: every crash window has exactly one safe action.
  const model = intake.createIntakeModel()
  const windows = [
    ['before-session-write', { readable: true, persistedRequestIds: [], turnStarted: false }, 'deliver'],
    ['after-durable-input', { readable: true, persistedRequestIds: ['RID'], turnStarted: false }, 'complete-intake'],
    ['after-claim-before-ack', { readable: true, persistedRequestIds: [], inputClaimed: true }, 'park'],
    ['turn-started', { readable: true, persistedRequestIds: [], turnStarted: true }, 'park'],
    ['evidence-unreadable', { readable: false }, 'park'],
    ['duplicate-input', { readable: true, persistedRequestIds: ['RID', 'RID'] }, 'park'],
  ]
  for (const [name, evidence, expected] of windows) {
    const { receipt } = model.reserve('owner', 'crash-' + name, submission)
    const ids = (evidence.persistedRequestIds || []).map((rid) => (rid === 'RID' ? receipt.requestId : rid))
    const decision = model.reconcile('owner', 'crash-' + name, { ...evidence, persistedRequestIds: ids })
    assert.equal(decision.action, expected, name)
    if (expected === 'deliver') { assert.equal(decision.requestId, receipt.requestId); assert.equal(decision.sessionId, receipt.sessionId, 'redelivery reuses the exact reserved identities') }
  }
  pass('restart reconciliation: deliver only when never admitted, park whenever work may have run, never a second input')
}

{
  let clock = 1000
  const broker = intake.createInteractionBroker({ now: () => clock })
  const owner = { kind: 'local-owner' }
  const action = broker.offer('task_a', { kind: 'approval', revision: 4, choices: [{ id: 'allow-once' }, { id: 'reject' }], ttlMs: 500 })
  assert.equal(broker.outcome(action.id), 'pending')
  assert.equal(broker.respond(owner, 'task_a', action.id, '3', 'allow-once').code, 'STALE_ACTION', 'stale revision refused')
  assert.equal(broker.respond(owner, 'task_b', action.id, '4', 'allow-once').code, 'NOT_FOUND', 'foreign task concealed')
  assert.equal(broker.respond({ kind: 'internal-browser' }, 'task_a', action.id, '4', 'allow-once').code, 'NOT_FOUND', 'GUI/CLI principal mismatch refused')
  assert.equal(broker.respond(owner, 'task_a', action.id, '4', 'maybe').code, 'USAGE')
  const won = broker.respond(owner, 'task_a', action.id, '4', 'reject')
  assert.equal(won.disposition, 'accepted')
  assert.equal(broker.respond(owner, 'task_a', action.id, '4', 'reject').disposition, 'duplicate', 'same decision returns the prior receipt')
  assert.equal(broker.respond(owner, 'task_a', action.id, '4', 'allow-once').code, 'STALE_ACTION', 'first valid decision wins')
  assert.equal(broker.outcome(action.id), 'rejected')
  const late = broker.offer('task_a', { kind: 'approval', revision: 5, choices: [{ id: 'allow-once' }], ttlMs: 100 })
  clock += 1000
  assert.equal(broker.respond(owner, 'task_a', late.id, '5', 'allow-once').code, 'STALE_ACTION', 'expired requests fail closed')
  assert.equal(broker.outcome(late.id), 'rejected', 'no answer never becomes approval')
  pass('interaction broker: first valid response wins, stale/expired/foreign/mismatched principals refused, silence never approves')
}

console.log(`NexusIntakeContract: ${passed} assertion groups passed.`)
