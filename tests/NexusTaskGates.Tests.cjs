'use strict'

/**
 * P2-B2F: review and visual gates through the shared Task API. Active
 * Controller core, TaskController-shaped ledger fixture, the REAL controller
 * gate journal module (ui/nexus-controller/lib/gate.cjs) and fake bridge
 * hooks that mirror reviewForTaskApi / gateForTaskApi / the completion tail
 * (visual first, then review/gate, then TaskController completion).
 * No DSH, no model, no reviewer service.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const controllerModule = require('../config/nexus/controller.cjs')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-gates-'))
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const digestOf = (text) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const legacyCli = { pwshHost: 'x', toolchainRoot: 'x', timeoutMs: 1, stats: () => ({}) }
const cli = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read', 'tasks:submit', 'tasks:cancel', 'tasks:respond'] }
const gui = { kind: 'local-owner', via: 'gui', capabilities: ['tasks:read', 'tasks:submit', 'tasks:cancel', 'tasks:respond'] }
const readOnly = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read'] }


const passingVerify = async ({ binding, setTask, addAttempt }) => {
  addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'passed'); setTask(binding.taskInstanceId, 'complete')
  return { verification: 'passed', checks: { total: 1, passed: 1, failed: 0, skipped: 0 }, completion: { complete: true }, attemptStatus: 'passed' }
}

const gateModule = require('../ui/nexus-controller/lib/gate.cjs')
// Mirrors executeVerifyTurn + runCompletionTail: evidence, then the visual
// requirement, then review (only when usable for this candidate) / gate.
const tailVerify = async ({ binding, setTask, addAttempt, completeTask, readVisual, visualPath, reviewUsable, faults }) => {
  if (faults.verifyHang) return new Promise(() => {})
  addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'passed')
  if (faults.visual) { fs.mkdirSync(path.dirname(visualPath(binding)), { recursive: true }); fs.writeFileSync(visualPath(binding), typeof faults.visual === 'string' ? faults.visual : JSON.stringify(faults.visual)) }
  const visual = readVisual(binding)
  if (visual && visual.required && visual.status !== 'pass') return { verification: 'passed', checks: { total: 1, passed: 1, failed: 0, skipped: 0 }, completion: { complete: false, visualBlocked: true, visualStatus: visual.status }, attemptStatus: 'passed' }
  let review = null
  try { review = reviewUsable === false ? null : JSON.parse(fs.readFileSync(path.join(path.dirname(visualPath(binding)), '..', 'review-result.json'), 'utf8')) } catch { review = null }
  const completion = completeTask(binding, Boolean(review && review.verdict === 'pass'))
  if (!completion.complete && review && review.verdict === 'fail') gateModule.ensureGate(faults.dataRoot, binding, 'review-required', { attempt: 1, reviewVerdict: 'fail' })
  return { verification: 'passed', checks: { total: 1, passed: 1, failed: 0, skipped: 0 }, completion: { complete: completion.complete, ...(completion.reason ? { reason: completion.reason } : {}) }, attemptStatus: 'passed' }
}

function fixture(name, verifyBehavior = tailVerify, faults = {}) {
  const dataRoot = path.join(scratch, name, 'data')
  faults.dataRoot = dataRoot
  const workspace = path.join(scratch, name, 'ws')
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'state'), { recursive: true })
  const ledgerPath = path.join(workspace, '.ai-harness', 'state', 'tasks.json')
  const attemptsPath = (displayId) => path.join(workspace, '.ai-harness', 'runs', displayId, 'attempts.jsonl')
  const bindingsPath = path.join(dataRoot, 'routing', 'session-bindings.json')
  const sessions = new Map()
  let counter = 0
  const calls = { verify: 0, closeAttempt: 0, prompt: 0, review: 0, gate: 0, verifyArgs: [] }
  // TaskController `complete` (subset): evidence must pass; a required review
  // must have passed (or the gate approval stands in, as -CodexReviewPassed).
  const completeTask = (binding, reviewPassed) => {
    const doc = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    const task = doc.tasks.find((t) => t.taskInstanceId === binding.taskInstanceId)
    const visual = readVisual(binding)
    if (visual && visual.required && visual.status !== 'pass') return { complete: false, reason: 'Visual verification is required but not satisfied (status: ' + visual.status + ').' }
    if (task.reviewRequested && !reviewPassed) return { complete: false, reason: 'This task requires a passing independent review.', reviewRequired: true }
    task.status = 'complete'; fs.writeFileSync(ledgerPath, JSON.stringify(doc))
    return { complete: true }
  }
  const visualPath = (binding) => path.join(path.dirname(attemptsPath(binding.taskId)), 'visual', 'state.json')
  const readVisual = (binding) => { try { return JSON.parse(fs.readFileSync(visualPath(binding), 'utf8')) } catch { return null } }
  const setTask = (instance, status) => { const doc = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); doc.tasks.find((t) => t.taskInstanceId === instance).status = status; fs.writeFileSync(ledgerPath, JSON.stringify(doc)) }
  const addAttempt = (displayId, status, extra = {}) => fs.appendFileSync(attemptsPath(displayId), JSON.stringify({ taskId: displayId, sequence: 1, status, ...extra }) + '\n')
  const ports = {
    resolveWorkspace: async (p) => (p === workspace ? { workspaceId: 'ws-' + name, path: workspace } : null),
    resolveProfile: (preset) => ('profile' in faults ? faults.profile : preset === 'aih-muse' ? 'muse-spark-1.3-contributor' : 'deepseek-codex'),
    sessionExists: async (id) => sessions.has(id),
    createSession: async ({ sessionId }) => { sessions.set(sessionId, { live: [] }); return sessionId },
    // The real bridge prepare binds a TaskController task with an open attempt.
    prepare: async ({ sessionId, preset }) => {
      counter += 1
      const displayId = 'TASK-' + String(counter).padStart(4, '0')
      const taskInstanceId = 'task_' + crypto.randomBytes(16).toString('hex')
      const doc = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { schemaVersion: 1, tasks: [] }
      doc.tasks.push({ taskId: displayId, taskInstanceId, status: 'implementing' })
      fs.writeFileSync(ledgerPath, JSON.stringify(doc))
      const bindings = fs.existsSync(bindingsPath) ? JSON.parse(fs.readFileSync(bindingsPath, 'utf8')) : { schemaVersion: 1, bindings: {} }
      bindings.bindings[sessionId] = { sessionId, taskInstanceId, taskId: displayId, workspace, workspaceId: 'ws-' + name, engine: preset === 'aih-muse' ? 'muse' : 'dual', preset }
      fs.writeFileSync(bindingsPath, JSON.stringify(bindings))
      fs.mkdirSync(path.dirname(attemptsPath(displayId)), { recursive: true })
      addAttempt(displayId, 'started')
      return { taskId: displayId, taskInstanceId }
    },
    prompt: async ({ sessionId, requestId, text }) => { calls.prompt += 1; const s = sessions.get(sessionId); s.live.push({ type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user', rpcId: requestId }, content: text }] } }) },
    flush: async () => {},
    readDurable: async (id) => sessions.get(id).live.slice(),
    cancelTurn: async () => {},
    lastReply: async () => ({ text: 'Done.' }),
    // Mirrors executeVerifyTurn + runCompletionTail ledger effects.
    verify: async ({ sessionId, taskInstanceId, attempt, reviewUsable }) => {
      calls.verify += 1
      const binding = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')).bindings[sessionId]
      assert.equal(binding.taskInstanceId, taskInstanceId)
      calls.verifyArgs.push({ sessionId, taskInstanceId, attempt, reviewUsable })
      return verifyBehavior({ binding, attempt, setTask, addAttempt, calls, completeTask, readVisual, visualPath, reviewUsable, faults })
    },
    // Mirrors reviewForTaskApi -> executeReviewTurn (explicit /review): marks
    // the task review-requested, writes review-result.json, opens/supersedes
    // the controller gate through the REAL gate module.
    review: async ({ sessionId, taskInstanceId, attempt }) => {
      calls.review += 1
      if (faults.reviewHang) return new Promise(() => {})
      const binding = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')).bindings[sessionId]
      assert.equal(binding.taskInstanceId, taskInstanceId)
      const doc = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); doc.tasks.find((t) => t.taskInstanceId === taskInstanceId).reviewRequested = true; fs.writeFileSync(ledgerPath, JSON.stringify(doc))
      if (faults.reviewError) return { attempt, review: 'incomplete', reason: faults.reviewError }
      const verdict = faults.verdict || 'pass'
      fs.mkdirSync(path.dirname(attemptsPath(binding.taskId)), { recursive: true })
      fs.writeFileSync(path.join(path.dirname(attemptsPath(binding.taskId)), 'review-result.json'), JSON.stringify({ verdict, findings: verdict === 'fail' ? [{ severity: 'high', title: 'x' }] : [], completedAtUtc: new Date().toISOString(), taskInstanceId }))
      if (verdict === 'fail') gateModule.ensureGate(dataRoot, binding, 'review-required', { attempt: Number(attempt), reviewVerdict: 'fail' })
      else gateModule.supersedeGate(dataRoot, binding, 'review-passed')
      return { attempt, review: verdict === 'pass' ? 'passed' : 'failed', verdict, findings: verdict === 'fail' ? 1 : 0, blockingFindings: verdict === 'fail' ? 1 : 0, gateOpened: verdict === 'fail' }
    },
    // Mirrors gateForTaskApi with the REAL gate module and a TaskController
    // completion that honors evidence + review requirement.
    gate: async ({ sessionId, gateId, choice, mode, requestId }) => {
      calls.gate += 1
      const binding = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')).bindings[sessionId]
      if (mode === 'complete-approved') {
        const current = gateModule.currentGateFor(dataRoot, sessionId, binding.workspace, binding.taskId, binding.taskInstanceId)
        if (!current || current.gateId !== gateId || current.status !== 'approved') return { disposition: 'stale', reason: 'gate-not-approved' }
        return { disposition: 'completion-rerun', gateStatus: 'approved', completion: completeTask(binding, true) }
      }
      const validation = gateModule.validateGateAction(dataRoot, binding, { sessionId, gateId, actionId: choice, requestId })
      if (!validation.ok) return validation.replay ? { disposition: 'duplicate' } : { disposition: 'stale', reason: validation.error }
      if (faults.gateDelayMs) await new Promise((r) => setTimeout(r, faults.gateDelayMs))
      const revalidated = gateModule.validateGateAction(dataRoot, binding, { sessionId, gateId, actionId: choice, requestId })
      if (!revalidated.ok) return revalidated.replay ? { disposition: 'duplicate' } : { disposition: 'stale', reason: revalidated.error }
      const resolved = gateModule.resolveGate(dataRoot, binding, validation.gate, choice, requestId, 'operator-task-api')
      if (faults.gateCrashAfterJournal) return new Promise(() => {})
      return { disposition: 'resolved', gateStatus: resolved.status, ...(choice === 'approve' ? { completion: completeTask(binding, true) } : {}) }
    },
    closeAttempt: async ({ sessionId }) => {
      calls.closeAttempt += 1
      const binding = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')).bindings[sessionId]
      const lines = fs.readFileSync(attemptsPath(binding.taskId), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const open = ['started', 'verifying'].includes(lines[lines.length - 1].status)
      if (open) addAttempt(binding.taskId, 'interrupted', { reason: 'operator-closed' })
      return { attemptClosed: open }
    },
  }
  function core() {
    const c = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot, enforceOwnership: true, legacyCli, qualifiedPlatforms: [process.platform], workspaceAuthorizer: async (principal, p) => !faults.denyWorkspace, managedFaultPoint: async (point, detail) => { if (faults.crashAt === point) { faults.crashAt = null; throw Object.assign(new Error('injected crash at ' + point), { code: 'injected-crash' }) } } })
    c.setOwnership({ state: 'held', lockPath: '/x' })
    c.bindManagedPorts(ports)
    for (const gate of ['policyInstalled', 'fetchGuardInstalled', 'brokerInstalled', 'workspaceGuardInstalled', 'dshServicesReady']) c.setManagedGate(gate, true)
    c.attachRouteGuard('test')
    c.setManagedGate('hook', { ok: true })
    return c
  }
  return { readVisual, visualPath, faults, dataRoot, workspace, ports, calls, sessions, core, setTask, addAttempt, attemptsPath, ledgerPath, bindingsPath }
}

/** Submit, admit the first step and end the turn normally. */
async function executedTask(f, c, key, mode = 'engineering-v2') {
  await c.managedTasks.reconcile()
  const text = 'Task ' + key
  const submitted = await c.tasks.submit(cli, { idempotencyKey: key, workspace: f.workspace, mode, prompt: { kind: 'text', text, digest: digestOf(text) } })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  const { taskId, sessionId } = submitted.data
  const record = c.intake.byTaskId(taskId)
  const ticket = await c.managedTasks.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [{ source: { kind: 'user', rpcId: record.requestId } }] })
  assert.equal(ticket.allowed, true, JSON.stringify(ticket))
  c.managedTasks.onTurnEnd(sessionId, 'completed')
  return { taskId, sessionId }
}


const settle = async (c, taskId) => { for (let i = 0; i < 400 && (c.managedTasks.isVerifying(taskId) || c.managedTasks.isReviewing(taskId)); i += 1) await new Promise((r) => setTimeout(r, 5)) }
const actionOf = (view, kind) => view.operatorActions.find((a) => a.kind === kind)
const promptOf = (text) => ({ kind: 'text', text, digest: digestOf(text) })
const statusOf = async (c, taskId, who = cli) => (await c.tasks.getStatus(who, { taskId })).data
const answer = (c, taskId, action, choiceId, who = cli, revision) => c.tasks.respond(who, { taskId, actionId: action.id, choiceId, expectedRevision: revision !== undefined ? revision : action.revision })
async function cont(c, taskId, key, text) { return c.tasks.continueTask(cli, { taskId, idempotencyKey: key, prompt: promptOf(text), expectedRevision: (await statusOf(c, taskId)).revision }) }
async function endTurn(c, taskId, turnId) {
  const record = c.intake.byTaskId(taskId)
  const requestId = turnId ? record.continuations.find((t) => t.turnId === turnId).requestId : record.requestId
  const ticket = await c.managedTasks.admitStep(record.sessionId, { id: record.sessionId }, { step: 1, messages: [{ source: { kind: 'user', rpcId: requestId } }] })
  assert.equal(ticket.allowed, true, JSON.stringify(ticket))
  c.managedTasks.onTurnEnd(record.sessionId, 'completed')
}
const ledgerTask = (f, c, taskId) => JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).tasks.find((t) => t.taskInstanceId === c.intake.byTaskId(taskId).taskInstanceId)

async function main() {
  const keepAlive = setInterval(() => {}, 1000)

  // 1. EMv1 Dual: explicit review of the current candidate -> verification -> completed.
  {
    const f = fixture('dual-pass')
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'dual-pass', 'engineering-v1')
    let view = await statusOf(c, taskId)
    assert.equal(view.gates.review.policy, 'independent-review'); assert.equal(view.gates.review.state, 'not-run')
    const review = actionOf(view, 'review')
    assert.ok(review && actionOf(view, 'verification'), 'review offered next to verification: ' + JSON.stringify(view.operatorActions))
    const [a, b] = await Promise.all([answer(c, taskId, review, 'run', gui), answer(c, taskId, review, 'run', cli)])
    assert.deepEqual([a.ok && a.data.disposition, b.ok && b.data.disposition].sort(), ['accepted', 'duplicate'], JSON.stringify([a, b]))
    await settle(c, taskId)
    assert.equal(f.calls.review, 1, 'one reviewer request')
    view = await statusOf(c, taskId)
    assert.equal(view.gates.review.state, 'passed'); assert.equal(view.gates.review.current, true); assert.equal(view.gates.review.required, true)
    assert.equal(actionOf(view, 'review'), undefined, 'a verdict is not re-requested for the same candidate')
    const dupAfter = await answer(c, taskId, review, 'run', cli, view.revision)
    assert.equal(dupAfter.ok && dupAfter.data.disposition, 'duplicate', JSON.stringify(dupAfter))
    await answer(c, taskId, actionOf(view, 'verification'), 'run', gui)
    await settle(c, taskId)
    assert.equal(f.calls.verifyArgs[0].reviewUsable, true)
    view = await statusOf(c, taskId)
    assert.equal(view.status, 'completed', JSON.stringify(view)); assert.equal(ledgerTask(f, c, taskId).status, 'complete')
    assert.deepEqual({ ...(await statusOf(c, taskId, gui)), updatedAt: 0 }, { ...view, updatedAt: 0 })
  }
  pass('Dual: explicit review of the current candidate (concurrent GUI+CLI answers start one reviewer request), verdict recorded, not repeated, verification counts it, TaskController completes')

  // 2. EMv2 Muse: no independent reviewer — typed, never invented.
  {
    const f = fixture('muse-policy')
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'muse-policy', 'engineering-v2')
    const view = await statusOf(c, taskId)
    assert.equal(view.gates.review.policy, 'unavailable-for-engine'); assert.equal(view.gates.review.state, 'unavailable')
    assert.equal(actionOf(view, 'review'), undefined)
    const forged = await c.tasks.respond(cli, { taskId, actionId: 'act_review_' + taskId.slice(3, 15) + '_t1_n1', choiceId: 'run', expectedRevision: view.revision })
    assert.equal(forged.ok, false); assert.equal(forged.error.code, 'STALE_ACTION')
    assert.equal(f.calls.review, 0)
    await answer(c, taskId, actionOf(view, 'verification'), 'run')
    await settle(c, taskId)
    assert.equal((await statusOf(c, taskId)).status, 'completed')
  }
  pass('Muse: review policy reported as unavailable-for-engine, no review action, forged review action refused, no reviewer request, Muse completion unchanged')

  // 3. Failed review -> verification -> the existing gate (approve / reject).
  {
    const f = fixture('gate', tailVerify, { verdict: 'fail' })
    const c = f.core()
    const t = await executedTask(f, c, 'gate-approve', 'engineering-v1')
    let view = await statusOf(c, t.taskId)
    await answer(c, t.taskId, actionOf(view, 'review'), 'run'); await settle(c, t.taskId)
    view = await statusOf(c, t.taskId)
    assert.equal(view.gates.review.state, 'failed'); assert.equal(view.statusReason, 'turn-completed-awaiting-verification')
    assert.equal(actionOf(view, 'gate'), undefined, 'the gate is not offered before verification')
    await answer(c, t.taskId, actionOf(view, 'verification'), 'run'); await settle(c, t.taskId)
    view = await statusOf(c, t.taskId)
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'review-gate-pending', JSON.stringify(view))
    const gate = actionOf(view, 'gate')
    assert.deepEqual(gate.choices.map((x) => x.id), ['approve', 'reject'])
    assert.equal((await answer(c, t.taskId, gate, 'approve', readOnly)).error.code, 'AUTH_REQUIRED')
    assert.equal((await answer(c, t.taskId, gate, 'approve', cli, '999')).error.code, 'STALE_ACTION')
    assert.equal((await answer(c, t.taskId, gate, 'maybe')).error.code, 'USAGE')
    const [g1, g2] = await Promise.all([answer(c, t.taskId, gate, 'approve', gui), answer(c, t.taskId, gate, 'approve', cli)])
    const outcomes = [g1.ok ? g1.data.disposition : g1.error.code, g2.ok ? g2.data.disposition : g2.error.code]
    assert.equal(outcomes.filter((o) => o === 'resolved').length, 1, JSON.stringify([g1, g2]))
    view = await statusOf(c, t.taskId)
    assert.equal(view.status, 'completed', JSON.stringify(view)); assert.equal(view.gates.gate.status, 'approved'); assert.equal(view.gates.gate.resolvedBy, 'operator-task-api')
    const journal = gateModule.readJsonLines(gateModule.gatesPathOf(f.dataRoot)).filter((r) => r.taskInstanceId === c.intake.byTaskId(t.taskId).taskInstanceId)
    assert.deepEqual(journal.map((r) => r.status), ['waiting', 'approved'], 'exactly one resolution in the journal')
    // Reject path.
    const r = await executedTask(f, c, 'gate-reject', 'engineering-v1')
    view = await statusOf(c, r.taskId)
    await answer(c, r.taskId, actionOf(view, 'review'), 'run'); await settle(c, r.taskId)
    view = await statusOf(c, r.taskId)
    await answer(c, r.taskId, actionOf(view, 'verification'), 'run'); await settle(c, r.taskId)
    view = await statusOf(c, r.taskId)
    assert.equal((await answer(c, r.taskId, actionOf(view, 'gate'), 'reject', gui)).data.gateStatus, 'rejected')
    view = await statusOf(c, r.taskId)
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'review-rejected'); assert.deepEqual(view.operatorActions.map((x) => x.kind), ['recovery'])
    assert.notEqual(ledgerTask(f, c, r.taskId).status, 'complete')
  }
  pass('failed review: gate offered only after verification passed; approve (Control Room policy) completes once — concurrent GUI+CLI resolve exactly one journal record; unauthorized/stale/unknown choice refused; reject keeps completion blocked (close only)')

  // 4. Multi-turn freshness: a review of turn 1 never certifies turn 2.
  {
    const f = fixture('fresh')
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'fresh', 'engineering-v1')
    let view = await statusOf(c, taskId)
    const firstReview = actionOf(view, 'review')
    await answer(c, taskId, firstReview, 'run'); await settle(c, taskId)
    const r2 = await cont(c, taskId, 'fresh-2', 'turn 2 changes the candidate')
    assert.equal(r2.ok, true, JSON.stringify(r2))
    await endTurn(c, taskId, r2.data.turnId)
    view = await statusOf(c, taskId)
    assert.equal(view.gates.review.current, false, 'the turn-1 review is stale for turn 2')
    const secondReview = actionOf(view, 'review')
    assert.ok(secondReview && secondReview.id !== firstReview.id, 'a new review action for the new candidate')
    assert.equal((await answer(c, taskId, firstReview, 'run', cli, view.revision)).data.disposition, 'duplicate', 'the old action id is answered by its old receipt, it does not run again')
    assert.equal(f.calls.review, 1)
    await answer(c, taskId, actionOf(view, 'verification'), 'run'); await settle(c, taskId)
    assert.equal(f.calls.verifyArgs[0].reviewUsable, false, 'verification is told the review is not for this candidate')
    view = await statusOf(c, taskId)
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'review-required', JSON.stringify(view))
    assert.notEqual(ledgerTask(f, c, taskId).status, 'complete', 'no completion with a stale review')
  }
  pass('multi-turn: a new turn makes the earlier review stale (new review action, old id inert), verification of the newer candidate ignores the stale review and completion is denied (review-required)')

  // 5. Races: review vs verification, review vs continuation, review vs close.
  {
    const f = fixture('races', tailVerify, { reviewHang: false })
    const c = f.core()
    const a = await executedTask(f, c, 'race-a', 'engineering-v1')
    let view = await statusOf(c, a.taskId)
    const [x, y] = await Promise.all([answer(c, a.taskId, actionOf(view, 'review'), 'run', gui), answer(c, a.taskId, actionOf(view, 'verification'), 'run', cli)])
    assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]))
    await settle(c, a.taskId)
    const b = await executedTask(f, c, 'race-b', 'engineering-v1')
    view = await statusOf(c, b.taskId)
    const [p, q] = await Promise.all([answer(c, b.taskId, actionOf(view, 'review'), 'run', gui), c.tasks.continueTask(cli, { taskId: b.taskId, idempotencyKey: 'rb', prompt: promptOf('race'), expectedRevision: view.revision })])
    assert.equal([p, q].filter((r) => r.ok).length, 1, JSON.stringify([p, q]))
    await settle(c, b.taskId)
    // While a review runs: continuation, verification and close all refuse.
    f.faults.reviewHang = true
    const d = await executedTask(f, c, 'race-d', 'engineering-v1')
    view = await statusOf(c, d.taskId)
    await answer(c, d.taskId, actionOf(view, 'review'), 'run')
    view = await statusOf(c, d.taskId)
    assert.equal(view.status, 'verifying'); assert.equal(view.statusReason, 'review-running'); assert.deepEqual(view.operatorActions, [])
    assert.equal(view.continuation.reason, 'review-running')
    assert.equal(c.managedTasks.runVerification(d.taskId, { actionId: 'x', attempt: '1' }).reason, 'review-running')
    assert.equal((await c.managedTasks.closeTask(d.taskId, { actionId: 'y' })).reason, 'operation-running')
    f.faults.reviewHang = false
  }
  pass('races: review vs verification and review vs continuation at one revision — exactly one wins; while a review runs, continuation / verification / close are refused')

  // 6. Visual requirement: unavailable / pending / unreadable never complete; pass completes.
  for (const [label, visual, expected] of [
    ['unavailable', { required: true, status: 'unavailable', iteration: 1, maxIterations: 3, reasons: ['reviewer not invoked: runtime capture failed'] }, 'visual-unavailable'],
    ['revise', { required: true, status: 'revise', iteration: 1, maxIterations: 3, reasons: [] }, 'visual-revise'],
    ['exhausted', { required: true, status: 'exhausted', iteration: 3, maxIterations: 3, reasons: [] }, 'visual-exhausted'],
    ['pending', { required: true, status: 'pending', iteration: 0, maxIterations: 3, reasons: [] }, 'visual-pending'],
    ['pass', { required: true, status: 'pass', iteration: 1, maxIterations: 3, reasons: [] }, null],
  ]) {
    const f = fixture('visual-' + label, tailVerify, { visual })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'visual-' + label, 'engineering-v2')
    let view = await statusOf(c, taskId)
    await answer(c, taskId, actionOf(view, 'verification'), 'run'); await settle(c, taskId)
    view = await statusOf(c, taskId)
    if (expected) {
      assert.equal(view.status, 'blocked', label); assert.equal(view.statusReason, expected, label + ': ' + JSON.stringify(view))
      assert.equal(view.gates.visual.status, visual.status); assert.ok(view.guidance)
      assert.deepEqual(view.operatorActions.map((a) => a.kind), ['recovery'], label + ': close only — no invented visual action')
      assert.notEqual(ledgerTask(f, c, taskId).status, 'complete')
    } else assert.equal(view.status, 'completed', label)
  }
  {
    const f = fixture('visual-corrupt', tailVerify, { visual: '{"required": true, "status": "pa' })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'visual-corrupt', 'engineering-v2')
    let view = await statusOf(c, taskId)
    // The fake TaskController treats unreadable state as absent (as the
    // real one does); the projection must still never report completion
    // unless the ledger says complete.
    await answer(c, taskId, actionOf(view, 'verification'), 'run'); await settle(c, taskId)
    view = await statusOf(c, taskId)
    assert.equal(view.gates.visual, null, 'unreadable visual state is not presented as a status')
    assert.equal(view.status === 'completed', ledgerTask(f, c, taskId).status === 'complete')
  }
  pass('visual: unavailable / revise / exhausted / pending block completion with typed reasons and guidance, close only (no invented visual action); pass completes; unreadable state is never shown as a status and completion follows only the ledger')

  // 7. Restart during review and during a gate action (after the journal write).
  {
    const f = fixture('restart-review', tailVerify, { reviewHang: true })
    let c = f.core()
    const { taskId } = await executedTask(f, c, 'rr', 'engineering-v1')
    let view = await statusOf(c, taskId)
    await answer(c, taskId, actionOf(view, 'review'), 'run')
    await c.dispose()
    f.faults.reviewHang = false
    c = f.core(); await c.managedTasks.reconcile()
    view = await statusOf(c, taskId)
    assert.equal(view.gates.review.state, 'interrupted'); assert.equal(f.calls.review, 1, 'never re-run automatically')
    const rerun = actionOf(view, 'review')
    assert.ok(rerun && /_n2$/.test(rerun.id), 'an explicit re-run is offered: ' + JSON.stringify(view.operatorActions))
    await c.dispose()
  }
  {
    const f = fixture('restart-gate', tailVerify, { verdict: 'fail' })
    let c = f.core()
    const { taskId } = await executedTask(f, c, 'rg', 'engineering-v1')
    let view = await statusOf(c, taskId)
    await answer(c, taskId, actionOf(view, 'review'), 'run'); await settle(c, taskId)
    view = await statusOf(c, taskId)
    await answer(c, taskId, actionOf(view, 'verification'), 'run'); await settle(c, taskId)
    view = await statusOf(c, taskId)
    f.faults.gateCrashAfterJournal = true
    const gate = actionOf(view, 'gate')
    answer(c, taskId, gate, 'approve').catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    await c.dispose()
    f.faults.gateCrashAfterJournal = false
    c = f.core(); await c.managedTasks.reconcile()
    view = await statusOf(c, taskId)
    assert.equal(c.intake.byTaskId(taskId).gateAction.state, 'interrupted')
    assert.equal(view.statusReason, 'review-approved-completion-pending', JSON.stringify(view))
    assert.notEqual(ledgerTask(f, c, taskId).status, 'complete', 'no completion was fabricated by the restart')
    const again = await answer(c, taskId, gate, 'approve', cli, view.revision)
    assert.equal(again.ok && again.data.disposition, 'duplicate', 'the answered gate action returns its receipt; it is not resolved again: ' + JSON.stringify(again))
    assert.notEqual(ledgerTask(f, c, taskId).status, 'complete', 'the duplicate receipt does not complete either')
    const complete = actionOf(view, 'completion')
    const done = await answer(c, taskId, complete, 'run')
    assert.equal(done.data.disposition, 'completion-rerun'); assert.equal((await statusOf(c, taskId)).status, 'completed')
    const journal = gateModule.readJsonLines(gateModule.gatesPathOf(f.dataRoot)).filter((r) => r.taskInstanceId === c.intake.byTaskId(taskId).taskInstanceId)
    assert.deepEqual(journal.map((r) => r.status), ['waiting', 'approved'])
    await c.dispose()
  }
  pass('restart: a review interrupted by a restart is never re-run or counted (explicit re-run offered); a gate approved just before a crash is not resolved twice and completion is only reached through the explicit completion re-run')

  // 8. Foreign workspace and unknown task stay concealed.
  {
    const faults = {}
    const f = fixture('foreign', tailVerify, faults)
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'foreign', 'engineering-v1')
    const view = await statusOf(c, taskId)
    faults.denyWorkspace = true
    assert.equal((await answer(c, taskId, actionOf(view, 'review'), 'run')).error.code, 'NOT_FOUND')
    assert.equal(f.calls.review, 0)
  }
  pass('authorization: an unauthorized workspace conceals the task (NOT_FOUND) and starts no review')


  // 9. Concurrency and provenance semantics of the review gate.
  {
    const describeTask = require('../scripts/nexus-cli.cjs').describeTask
    const f = fixture('gate-concurrency', tailVerify, { verdict: 'fail' })
    const c = f.core()
    const ready = async (key) => {
      const t = await executedTask(f, c, key, 'engineering-v1')
      let view = await statusOf(c, t.taskId)
      await answer(c, t.taskId, actionOf(view, 'review'), 'run'); await settle(c, t.taskId)
      view = await statusOf(c, t.taskId)
      await answer(c, t.taskId, actionOf(view, 'verification'), 'run'); await settle(c, t.taskId)
      view = await statusOf(c, t.taskId)
      assert.equal(view.statusReason, 'review-gate-pending')
      return { ...t, view, gate: actionOf(view, 'gate') }
    }
    const journalOf = (taskId) => gateModule.readJsonLines(gateModule.gatesPathOf(f.dataRoot)).filter((r) => r.taskInstanceId === c.intake.byTaskId(taskId).taskInstanceId)
    // a) Concurrent approve (CLI) vs reject (GUI) on one revision: one decision.
    const a = await ready('conc-a')
    const work = { verify: f.calls.verify, review: f.calls.review }
    f.faults.gateDelayMs = 30
    const [approve, reject] = await Promise.all([answer(c, a.taskId, a.gate, 'approve', cli), answer(c, a.taskId, a.gate, 'reject', gui)])
    f.faults.gateDelayMs = 0
    const winners = [approve, reject].filter((r) => r.ok && r.data.disposition === 'resolved')
    assert.equal(winners.length, 1, JSON.stringify([approve, reject]))
    const loser = [approve, reject].find((r) => r !== winners[0])
    assert.ok(!loser.ok && loser.error.code === 'STALE_ACTION', 'the in-flight competitor is refused, not queued: ' + JSON.stringify(loser))
    assert.deepEqual(journalOf(a.taskId).map((r) => r.status), ['waiting', winners[0].data.gateStatus], 'the journal resolves exactly once')
    let view = await statusOf(c, a.taskId)
    assert.equal(view.status, winners[0].data.gateStatus === 'approved' ? 'completed' : 'blocked', 'final status follows the winning decision')
    // b) The accepted identity again: receipt only, no second completion.
    const gateCalls = f.calls.gate
    const ledgerBefore = ledgerTask(f, c, a.taskId).status
    const dup = await answer(c, a.taskId, a.gate, winners[0] === approve ? 'approve' : 'reject', cli, view.revision)
    assert.equal(dup.ok && dup.data.disposition, 'duplicate'); assert.equal(f.calls.gate, gateCalls, 'no second gate/completion call'); assert.equal(ledgerTask(f, c, a.taskId).status, ledgerBefore)
    // c) Different identities cannot override the winner.
    const binding = JSON.parse(fs.readFileSync(f.bindingsPath, 'utf8')).bindings[a.sessionId]
    const direct = gateModule.validateGateAction(f.dataRoot, binding, { sessionId: a.sessionId, gateId: a.gate.gateId, actionId: 'reject', requestId: 'another-request-id' })
    assert.equal(direct.ok, false); assert.equal(direct.error, 'gate-not-waiting', 'a new request id sees the resolved gate (instance-bound journal lookup)')
    const forged = await c.tasks.respond(gui, { taskId: a.taskId, actionId: 'act_gate_000000000000_r9', choiceId: 'reject', expectedRevision: view.revision })
    assert.equal(forged.error.code, 'STALE_ACTION')
    assert.deepEqual(journalOf(a.taskId).map((r) => r.status), ['waiting', winners[0].data.gateStatus], 'journal unchanged by stale and forged answers')
    // d) No extra verification or review work from any stale reply.
    assert.deepEqual({ verify: f.calls.verify, review: f.calls.review }, work)
    // e) Same identity while the first answer is still in flight: refused (in progress), then its receipt.
    const b = await ready('conc-b')
    f.faults.gateDelayMs = 40
    const first = answer(c, b.taskId, b.gate, 'approve', cli)
    await new Promise((r) => setTimeout(r, 5))
    const inflight = await answer(c, b.taskId, b.gate, 'approve', gui)
    assert.equal(inflight.ok, false, JSON.stringify(inflight)); assert.equal(inflight.error.code, 'STALE_ACTION', JSON.stringify(inflight)); assert.match(inflight.error.message, /revision|in progress|could not/i, 'the winner\'s durable intent already changed the task revision')
    const firstDone = await first
    f.faults.gateDelayMs = 0
    assert.equal(firstDone.data.disposition, 'resolved')
    view = await statusOf(c, b.taskId)
    assert.equal((await answer(c, b.taskId, b.gate, 'approve', gui, view.revision)).data.disposition, 'duplicate')
    // f) Provenance: override vs reviewer PASS vs Muse.
    assert.equal(view.status, 'completed')
    assert.equal(view.gates.review.verdict, 'fail'); assert.equal(view.gates.review.disposition, 'operator-override-of-reviewer-fail')
    assert.equal(view.completionProvenance.authority, 'task-controller'); assert.equal(view.completionProvenance.reviewBasis, 'operator-override-of-reviewer-fail')
    assert.equal(view.completionProvenance.gate.resolvedBy, 'operator-task-api'); assert.equal(view.completionProvenance.gate.reviewVerdict, 'fail')
    const human = describeTask(view)
    assert.match(human, /operator OVERRIDE of an independent reviewer FAIL/); assert.doesNotMatch(human, /independent reviewer PASS/)
    assert.match(human, /completed by: the TaskController/)
    f.faults.verdict = 'pass'
    const p = await executedTask(f, c, 'prov-pass', 'engineering-v1')
    let pv = await statusOf(c, p.taskId)
    await answer(c, p.taskId, actionOf(pv, 'review'), 'run'); await settle(c, p.taskId)
    pv = await statusOf(c, p.taskId)
    await answer(c, p.taskId, actionOf(pv, 'verification'), 'run'); await settle(c, p.taskId)
    pv = await statusOf(c, p.taskId)
    assert.equal(pv.status, 'completed'); assert.equal(pv.completionProvenance.reviewBasis, 'reviewer-pass'); assert.equal(pv.completionProvenance.gate, undefined)
    assert.match(describeTask(pv), /review basis: independent reviewer PASS/)
    const m = await executedTask(f, c, 'prov-muse', 'engineering-v2')
    let mv = await statusOf(c, m.taskId)
    await answer(c, m.taskId, actionOf(mv, 'verification'), 'run'); await settle(c, m.taskId)
    mv = await statusOf(c, m.taskId)
    assert.equal(mv.completionProvenance.reviewBasis, 'not-available-for-engine')
  }
  pass('gate concurrency + provenance: approve vs reject on one revision resolves the journal exactly once and the final status follows the winner; the in-flight competitor is refused (STALE_ACTION: the winner durable intent already changed the revision), the accepted identity later gets a duplicate receipt with no second completion; new request ids, forged ids and stale replies change nothing and create no verification/review work; an approved gate over a reviewer FAIL is reported as an operator override, never as a reviewer PASS')

  clearInterval(keepAlive)
  console.log(`NexusTaskGates: ${passed} assertion groups passed.`)
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
