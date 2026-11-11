'use strict'

/**
 * P2-B2E: durable multi-turn continuation of managed tasks through the shared
 * Task API (CLI/IPC and GUI call the same operation). Active Controller core,
 * TaskController-shaped ledger fixture and fake DSH ports that record every
 * delivery, so duplicate deliveries and replays are counted exactly.
 * Deterministic crash injection uses the in-process `managedFaultPoint` hook.
 * No DSH, no model.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const controllerModule = require('../config/nexus/controller.cjs')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-continuation-'))
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

function fixture(name, verifyBehavior = passingVerify, faults = {}) {
  const dataRoot = path.join(scratch, name, 'data')
  const workspace = path.join(scratch, name, 'ws')
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'state'), { recursive: true })
  const ledgerPath = path.join(workspace, '.ai-harness', 'state', 'tasks.json')
  const attemptsPath = (displayId) => path.join(workspace, '.ai-harness', 'runs', displayId, 'attempts.jsonl')
  const bindingsPath = path.join(dataRoot, 'routing', 'session-bindings.json')
  const sessions = new Map()
  let counter = 0
  const calls = { verify: 0, closeAttempt: 0, prompt: 0 }
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
    verify: async ({ sessionId, taskInstanceId, attempt }) => {
      calls.verify += 1
      const binding = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')).bindings[sessionId]
      assert.equal(binding.taskInstanceId, taskInstanceId)
      return verifyBehavior({ binding, attempt, setTask, addAttempt, calls })
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
  return { dataRoot, workspace, ports, calls, sessions, core, setTask, addAttempt, attemptsPath, ledgerPath, bindingsPath }
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

const settle = async (c, taskId) => { for (let i = 0; i < 200 && c.managedTasks.isVerifying(taskId); i += 1) await new Promise((r) => setTimeout(r, 5)) }
const actionOf = (view, kind) => view.operatorActions.find((a) => a.kind === kind)
const promptOf = (text) => ({ kind: 'text', text, digest: digestOf(text) })
const statusOf = async (c, taskId, who = cli) => (await c.tasks.getStatus(who, { taskId })).data
async function cont(c, taskId, key, text, who = cli, revision) {
  const rev = revision !== undefined ? revision : (await statusOf(c, taskId)).revision
  return c.tasks.continueTask(who, { taskId, idempotencyKey: key, prompt: promptOf(text), expectedRevision: rev })
}
/** Admit step 1 of the task's current turn (the reserved request id) and optionally end it. */
async function runTurn(c, sessionId, turnRequestId, end = 'completed') {
  const ticket = await c.managedTasks.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [{ source: { kind: 'user', rpcId: turnRequestId } }] })
  if (ticket.allowed && end) c.managedTasks.onTurnEnd(sessionId, end)
  return ticket
}
const turnRequest = (c, taskId, turnId) => c.intake.byTaskId(taskId).continuations.find((t) => t.turnId === turnId).requestId
const sessionUserIds = (f, sessionId) => f.sessions.get(sessionId).live.flatMap((e) => e.data.inserted.map((m) => m.source.rpcId))

async function main() {
  const keepAlive = setInterval(() => {}, 1000)

  // 1. Muse and Dual: three sequential user turns, one task / session / attempt,
  //    final verification after the last turn, authoritative completion.
  for (const mode of ['engineering-v2', 'engineering-v1']) {
    const f = fixture('three-' + mode)
    const c = f.core()
    const { taskId, sessionId } = await executedTask(f, c, 'three-' + mode, mode)
    let view = await statusOf(c, taskId)
    assert.equal(view.continuation.allowed, true, JSON.stringify(view.continuation))
    assert.equal(view.turns.total, 1)
    assert.ok(actionOf(view, 'verification'), 'run-verification offered next to continuation')
    const turnIds = []
    for (const [n, text] of [[2, 'Add refresh token support.'], [3, 'Now add integration tests.']]) {
      const before = await statusOf(c, taskId)
      const r = await cont(c, taskId, 'followup-00' + (n - 1), text)
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(r.data.taskId, taskId); assert.equal(r.data.sessionId, sessionId); assert.equal(r.data.turnSeq, n); assert.equal(r.data.replay, false)
      turnIds.push(r.data.turnId)
      view = await statusOf(c, taskId)
      assert.equal(view.status, 'accepted'); assert.equal(view.continuation.allowed, false); assert.equal(view.continuation.reason, 'turn-not-started')
      assert.equal(view.operatorActions.length, 0, 'pending actions of the previous revision are withdrawn')
      // The previous revision's verification action is now stale.
      const staleVerify = await c.tasks.respond(cli, { taskId, actionId: actionOf(before, 'verification').id, choiceId: 'run', expectedRevision: before.revision })
      assert.equal(staleVerify.ok, false); assert.equal(staleVerify.error.code, 'STALE_ACTION')
      // Step 1 of the new turn must carry exactly that turn's request id.
      const wrong = await runTurn(c, sessionId, c.intake.byTaskId(taskId).requestId)
      assert.equal(wrong.allowed, false); assert.equal(wrong.code, 'managed-input-mismatch')
      const ticket = await runTurn(c, sessionId, turnRequest(c, taskId, r.data.turnId), null)
      assert.equal(ticket.allowed, true, JSON.stringify(ticket))
      assert.equal((await statusOf(c, taskId)).status, 'running')
      assert.equal((await statusOf(c, taskId)).continuation.reason, 'turn-live')
      c.managedTasks.onTurnEnd(sessionId, 'completed')
      c.managedTasks.onTurnEnd(sessionId, 'error') // a late end of the same turn changes nothing
      view = await statusOf(c, taskId)
      assert.equal(view.statusReason, 'turn-completed-awaiting-verification')
      assert.equal(view.turns.total, n); assert.equal(view.turns.current.seq, n); assert.equal(view.turns.current.status, 'completed')
    }
    // A finished turn cannot be admitted twice.
    assert.equal((await runTurn(c, sessionId, turnRequest(c, taskId, turnIds[1]))).code, 'managed-turn-already-run')
    // Same session, three distinct durable user submissions, each delivered once.
    const record = c.intake.byTaskId(taskId)
    assert.equal(record.sessionId, sessionId)
    assert.deepEqual(sessionUserIds(f, sessionId), [record.requestId, ...record.continuations.map((t) => t.requestId)])
    assert.equal(new Set(sessionUserIds(f, sessionId)).size, 3)
    assert.equal(f.calls.prompt, 3)
    assert.ok(record.continuations.every((t) => !t.prompt.text), 'the protected prompt copy is dropped once DSH owns the message')
    // One attempt for the whole multi-turn candidate.
    const attempts = fs.readFileSync(f.attemptsPath(record.displayId), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(attempts.map((a) => a.status), ['started'])
    // Final verification of the latest candidate -> TaskController completion.
    view = await statusOf(c, taskId)
    const act = actionOf(view, 'verification')
    assert.equal((await c.tasks.respond(gui, { taskId, actionId: act.id, choiceId: 'run', expectedRevision: view.revision })).data.disposition, 'accepted')
    // Once verification began, continuation is refused.
    const during = await cont(c, taskId, 'late', 'one more thing')
    assert.equal(during.ok, false); assert.equal(during.error.code, 'TASK_NOT_CONTINUABLE')
    await settle(c, taskId)
    view = await statusOf(c, taskId)
    assert.equal(view.status, 'completed')
    assert.equal(f.calls.verify, 1)
    const after = await cont(c, taskId, 'after', 'reopen please')
    assert.equal(after.ok, false); assert.equal(after.error.code, 'TASK_NOT_CONTINUABLE'); assert.equal(after.error.details.reason, 'task-terminal')
    assert.equal(f.calls.prompt, 3, 'no delivery after verification or completion')
    // CLI and GUI see the same state.
    assert.deepEqual({ ...(await statusOf(c, taskId, gui)), updatedAt: 0 }, { ...(await statusOf(c, taskId, cli)), updatedAt: 0 })
  }
  pass('Muse and Dual: three sequential user turns in one task and DSH session, one attempt, turn-scoped tickets, stale actions withdrawn, final verification -> completed; continuation refused once verification began and after completion')

  // 2. Idempotency: replay, conflict, concurrent duplicates, scoped keys.
  {
    const f = fixture('idem')
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'idem')
    const rev = (await statusOf(c, taskId)).revision
    const [a, b] = await Promise.all([cont(c, taskId, 'k1', 'Add refresh tokens.', cli, rev), cont(c, taskId, 'k1', 'Add refresh tokens.', gui, rev)])
    assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]))
    assert.equal(a.data.turnId, b.data.turnId)
    assert.deepEqual([a.data.replay, b.data.replay].sort(), [false, true])
    assert.equal(f.calls.prompt, 2, 'concurrent duplicates deliver once')
    const replay = await cont(c, taskId, 'k1', 'Add refresh tokens.', cli, '1')
    assert.equal(replay.ok, true); assert.equal(replay.data.replay, true); assert.equal(replay.data.turnId, a.data.turnId)
    const conflict = await cont(c, taskId, 'k1', 'Something different.')
    assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
    assert.equal(f.calls.prompt, 2)
    // The original submission key still maps to the original task.
    const original = await c.tasks.submit(cli, { idempotencyKey: 'idem', workspace: f.workspace, mode: 'engineering-v2', prompt: promptOf('Task idem') })
    assert.equal(original.data.taskId, taskId); assert.equal(original.data.replay, true)
    // Concurrent continuations with different keys: exactly one wins.
    await runTurn(c, c.intake.byTaskId(taskId).sessionId, turnRequest(c, taskId, a.data.turnId))
    const rev2 = (await statusOf(c, taskId)).revision
    const both = await Promise.all([cont(c, taskId, 'k2', 'Variant A', cli, rev2), cont(c, taskId, 'k3', 'Variant B', gui, rev2)])
    assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both))
    const loser = both.find((r) => !r.ok)
    assert.ok(['STALE_ACTION', 'TASK_NOT_CONTINUABLE'].includes(loser.error.code))
    assert.equal(f.calls.prompt, 3)
  }
  pass('idempotency: concurrent duplicates deliver once, replay returns the original receipt, a different payload under the key is IDEMPOTENCY_CONFLICT, the original submit key keeps its task, concurrent different keys admit exactly one')

  // 3. Arbitration: continuation vs run-verification vs close for one revision.
  {
    const f = fixture('arbitrate')
    const c = f.core()
    const t1 = await executedTask(f, c, 'arb-1')
    let view = await statusOf(c, t1.taskId)
    const [v, k] = await Promise.all([
      c.tasks.respond(gui, { taskId: t1.taskId, actionId: actionOf(view, 'verification').id, choiceId: 'run', expectedRevision: view.revision }),
      cont(c, t1.taskId, 'race', 'continue instead', cli, view.revision),
    ])
    assert.equal([v, k].filter((r) => r.ok).length, 1, JSON.stringify([v, k]))
    await settle(c, t1.taskId)
    const t2 = await executedTask(f, c, 'arb-2')
    view = await statusOf(c, t2.taskId)
    const [x, y] = await Promise.all([
      c.tasks.respond(gui, { taskId: t2.taskId, actionId: actionOf(view, 'recovery').id, choiceId: 'close', expectedRevision: view.revision }),
      cont(c, t2.taskId, 'race2', 'continue instead', cli, view.revision),
    ])
    assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]))
    const final = await statusOf(c, t2.taskId)
    if (x.ok) { assert.equal(final.status, 'cancelled'); assert.equal(c.intake.byTaskId(t2.taskId).continuations, undefined) } else assert.equal(final.turns.current.seq, 2)
    // Close then continue: refused.
    const t3 = await executedTask(f, c, 'arb-3')
    view = await statusOf(c, t3.taskId)
    await c.tasks.respond(cli, { taskId: t3.taskId, actionId: actionOf(view, 'recovery').id, choiceId: 'close', expectedRevision: view.revision })
    const closed = await cont(c, t3.taskId, 'after-close', 'more')
    assert.equal(closed.ok, false); assert.equal(closed.error.code, 'TASK_NOT_CONTINUABLE')
  }
  pass('arbitration: continuation vs run-verification and continuation vs close at the same revision — exactly one transition wins; a closed task refuses continuation')

  // 4. Refusals: stale revision, live turn, approval, unauthorized, foreign, mode, gate, interrupted.
  {
    const faults = {}
    const f = fixture('refuse', passingVerify, faults)
    const c = f.core()
    const { taskId, sessionId } = await executedTask(f, c, 'refuse')
    const stale = await cont(c, taskId, 's1', 'x', cli, '999')
    assert.equal(stale.error.code, 'STALE_ACTION')
    assert.equal((await cont(c, taskId, 's2', 'x', readOnly)).error.code, 'AUTH_REQUIRED')
    faults.denyWorkspace = true
    assert.equal((await cont(c, taskId, 's3', 'x', cli, '1')).error.code, 'NOT_FOUND')
    faults.denyWorkspace = false
    assert.equal((await cont(c, 'nt_' + '0'.repeat(32), 's4', 'x', cli, '1')).error.code, 'NOT_FOUND')
    assert.equal((await c.tasks.continueTask(cli, { taskId, idempotencyKey: 's5', prompt: { kind: 'text', text: 'abc', digest: digestOf('abd') }, expectedRevision: '1' })).error.code, 'USAGE')
    faults.profile = null
    assert.equal((await cont(c, taskId, 's6', 'x')).error.code, 'MODE_UNAVAILABLE')
    faults.profile = 'some-other-profile'
    const changed = await cont(c, taskId, 's7', 'x')
    assert.equal(changed.error.code, 'MODE_UNAVAILABLE'); assert.equal(changed.error.details.reason, 'profile-changed')
    delete faults.profile
    // A pending approval blocks continuation.
    const approval = c.broker.request({ taskId, sessionId, kind: 'approval', label: 'run tool', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] })
    approval.catch(() => {})
    const during = await cont(c, taskId, 's8', 'x')
    assert.equal(during.ok, false); assert.equal(during.error.code, 'TASK_NOT_CONTINUABLE'); assert.ok(['approval-pending'].includes(during.error.details.reason), JSON.stringify(during))
    c.broker.cancelTask(taskId)
    // Live model/tool step of a continued turn blocks a further continuation.
    const r = await cont(c, taskId, 's9', 'Add more.')
    assert.equal(r.ok, true, JSON.stringify(r))
    await runTurn(c, sessionId, turnRequest(c, taskId, r.data.turnId), null)
    const live = await cont(c, taskId, 's10', 'and more')
    assert.equal(live.error.details.reason, 'turn-live')
    // Missing gateway authorization (activation gate fails) refuses.
    c.setManagedGate('hook', { ok: false, reason: 'digest-mismatch' })
    const gate = await cont(c, taskId, 's11', 'x', cli, '1')
    assert.equal(gate.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    assert.equal(f.calls.prompt, 2, 'refusals never deliver')
  }
  pass('refusals: stale revision, read-only principal, foreign workspace and unknown task (NOT_FOUND), bad digest, revoked or changed engineering profile, pending approval, live turn, missing gateway activation — none deliver a message')

  // 5. Crash at every delivery boundary + restart reconciliation.
  for (const [point, expectation] of [
    ['continuation-reserved', 'resumed'],
    ['continuation-before-prompt', 'resumed'],
    ['continuation-after-prompt', 'held-restored'],
    ['continuation-after-flush', 'held-restored'],
  ]) {
    const faults = {}
    const f = fixture('crash-' + point, passingVerify, faults)
    let c = f.core()
    const { taskId, sessionId } = await executedTask(f, c, 'crash-' + point)
    faults.crashAt = point
    // The injected crash aborts the operation where the process would die.
    const crashed = await cont(c, taskId, 'crash-key', 'Follow-up after crash.').catch((error) => ({ ok: false, error: { code: error.code === 'injected-crash' ? 'CRASHED' : String(error) } }))
    assert.equal(crashed.ok, false, JSON.stringify(crashed)); assert.ok(['SUBMISSION_UNCERTAIN', 'CRASHED'].includes(crashed.error.code), JSON.stringify(crashed))
    const promptsBefore = f.calls.prompt
    await c.dispose()
    c = f.core() // host restart over the same data and DSH session
    await c.managedTasks.reconcile()
    await c.managedTasks.resumePending()
    const record = c.intake.byTaskId(taskId)
    const turn = record.continuations[0]
    if (expectation === 'resumed') {
      // No DSH effect before the crash: finished under the SAME ids, once.
      assert.equal(turn.state, 'accepted', JSON.stringify(turn)); assert.equal(f.calls.prompt, promptsBefore + 1)
      assert.equal(record.state, 'accepted')
    } else {
      // The message reached DSH: never duplicated, never resumed automatically.
      assert.equal(f.calls.prompt, promptsBefore)
      assert.equal(record.state, 'parked'); assert.equal(record.hold.reason, 'restored-input-not-resumed')
      const view = await statusOf(c, taskId)
      assert.equal(view.continuation.allowed, false); assert.ok(actionOf(view, 'recovery'))
    }
    assert.equal(sessionUserIds(f, sessionId).filter((id) => id === turn.requestId).length, 1, 'exactly one durable copy of the message')
    // A retry with the same key (lost acknowledgement) delivers nothing new.
    const retry = await cont(c, taskId, 'crash-key', 'Follow-up after crash.', cli, '1')
    assert.equal(retry.ok, true, JSON.stringify(retry)); assert.equal(retry.data.replay, true); assert.equal(retry.data.turnId, turn.turnId)
    assert.equal(sessionUserIds(f, sessionId).length, 2)
    await c.dispose()
  }
  pass('crash boundaries: after reservation / before delivery -> finished once under the same ids after restart; after DSH insertion / after flush -> accepted exactly once and held (restored-input-not-resumed); same-key retry returns the receipt, no duplicate message')

  // 6. Restart between clean turns, crash during a continued turn, accepted-not-started.
  {
    const f = fixture('restart')
    let c = f.core()
    const { taskId, sessionId } = await executedTask(f, c, 'restart')
    await c.dispose()
    c = f.core(); await c.managedTasks.reconcile()
    let view = await statusOf(c, taskId)
    assert.equal(view.continuation.allowed, true, 'a clean turn is continuable after a restart')
    const r2 = await cont(c, taskId, 'r2', 'Second turn after restart.')
    assert.equal(r2.ok, true); assert.equal(r2.data.sessionId, sessionId); assert.equal(r2.data.turnSeq, 2)
    // Crash during model/tool execution of turn 2.
    await runTurn(c, sessionId, turnRequest(c, taskId, r2.data.turnId), null)
    await c.dispose()
    c = f.core(); await c.managedTasks.reconcile()
    view = await statusOf(c, taskId)
    assert.equal(view.status, 'interrupted'); assert.equal(view.continuation.allowed, false); assert.equal(view.continuation.reason, 'interrupted')
    assert.equal((await runTurn(c, sessionId, turnRequest(c, taskId, r2.data.turnId))).allowed, false, 'an interrupted turn is never re-admitted')
    assert.equal(actionOf(view, 'verification'), undefined, 'no verification of uncertain execution')
    assert.ok(actionOf(view, 'recovery'))
    const refused = await cont(c, taskId, 'r3', 'try to continue anyway')
    assert.equal(refused.error.code, 'TASK_NOT_CONTINUABLE'); assert.equal(refused.error.details.reason, 'interrupted')
    assert.equal(f.calls.prompt, 2, 'interrupted execution never replayed')
    // Accepted but never started at restart: restored input is not resumed.
    const g = fixture('accepted-not-started')
    let d = g.core()
    const t = await executedTask(g, d, 'ans')
    assert.equal((await cont(d, t.taskId, 'a2', 'queued turn')).ok, true)
    await d.dispose()
    d = g.core(); await d.managedTasks.reconcile()
    assert.equal(d.intake.byTaskId(t.taskId).hold.reason, 'restored-input-not-resumed')
    assert.equal((await runTurn(d, t.sessionId, d.intake.byTaskId(t.taskId).continuations[0].requestId)).allowed, false)
    // Identity ledger: one identity per task, continuations add none.
    const ledger = fs.readFileSync(path.join(f.dataRoot, 'nexus', 'managed-identities.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(ledger.filter((e) => e.taskId === taskId).length, 1)
  }
  pass('restart: a clean task continues in the same session after restart; a crash during a continued turn holds it interrupted (never re-admitted, verified or continued); an accepted-but-unstarted turn is held restored-input-not-resumed; tombstones unchanged')

  clearInterval(keepAlive)
  console.log(`NexusTaskContinuation: ${passed} assertion groups passed.`)
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
