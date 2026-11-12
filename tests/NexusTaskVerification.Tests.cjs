'use strict'

/**
 * P2-B2D: verification and operator recovery through the shared Task API.
 * Active Controller core (enforced ownership + every gate), a real
 * TaskController-shaped ledger fixture (bindings, tasks.json, attempts.jsonl)
 * and fake bridge hooks (`verify`, `closeAttempt`) that write the ledger the
 * way the existing /verify pipeline and Task.ps1 do. No DSH, no model.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const controllerModule = require('../config/nexus/controller.cjs')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-verification-'))
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const digestOf = (text) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const legacyCli = { pwshHost: 'x', toolchainRoot: 'x', timeoutMs: 1, stats: () => ({}) }
const cli = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read', 'tasks:submit', 'tasks:cancel', 'tasks:respond'] }
const gui = { kind: 'local-owner', via: 'gui', capabilities: ['tasks:read', 'tasks:submit', 'tasks:cancel', 'tasks:respond'] }
const readOnly = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read'] }

function fixture(name, verifyBehavior) {
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
    resolveProfile: (preset) => (preset === 'aih-muse' ? 'muse-spark-1.3-contributor' : 'deepseek-codex'),
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
    const c = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot, enforceOwnership: true, legacyCli, qualifiedPlatforms: [process.platform], workspaceAuthorizer: async () => true })
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

async function main() {
  const keepAlive = setInterval(() => {}, 1000)

  // 1. Successful verification and completion (Muse and Dual).
  for (const mode of ['engineering-v2', 'engineering-v1']) {
    const f = fixture('success-' + mode, async ({ binding, setTask, addAttempt }) => {
      addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'passed'); setTask(binding.taskInstanceId, 'complete')
      return { verification: 'passed', checks: { total: 2, passed: 2, failed: 0, skipped: 0 }, completion: { complete: true }, evidencePath: '.ai-harness/runs/' + binding.taskId + '/evidence.json', attemptStatus: 'passed' }
    })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'ok-' + mode, mode)
    let view = (await c.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'turn-completed-awaiting-verification')
    const verify = actionOf(view, 'verification'); const close = actionOf(view, 'recovery')
    assert.ok(verify && close, JSON.stringify(view.operatorActions))
    assert.equal(verify.revision, view.revision, 'derived actions are bound to the view revision')
    assert.deepEqual(verify.choices.map((c2) => c2.id), ['run']); assert.equal(verify.attempt, '1')
    assert.ok(view.guidance.includes('Run verification'))
    // GUI sees the same state and actions as the CLI.
    const guiView = (await c.tasks.getStatus(gui, { taskId })).data
    assert.deepEqual(guiView.operatorActions.map((a) => a.id), view.operatorActions.map((a) => a.id)); assert.equal(guiView.status, view.status)
    const answered = await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })
    assert.equal(answered.ok, true, JSON.stringify(answered)); assert.equal(answered.data.disposition, 'accepted')
    assert.ok(['verifying', 'completed'].includes((await c.tasks.getStatus(cli, { taskId })).data.status))
    await settle(c, taskId)
    view = (await c.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'completed', 'the TaskController ledger decided completion: ' + JSON.stringify(view))
    assert.equal(view.taskVerification.state, 'passed'); assert.equal(view.taskVerification.completion.complete, true)
    assert.deepEqual(view.operatorActions, [], 'no actions on a completed task')
    const result = (await c.tasks.getResult(cli, { taskId })).data
    assert.equal(result.outcome, 'completed')
    assert.equal(f.calls.verify, 1)
    await c.dispose()
  }
  pass('verified completion (Muse and Dual): run-verification offered after a normal turn, same for GUI and CLI, runs once, TaskController completion -> completed')

  // 2. Failed verification never becomes completion.
  {
    const f = fixture('failed', async ({ binding, setTask, addAttempt }) => {
      addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'failed'); setTask(binding.taskInstanceId, 'failed')
      return { verification: 'failed', checks: { total: 3, passed: 2, failed: 1, skipped: 0 }, failingChecks: ['unit-tests'], attemptStatus: 'failed' }
    })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'fail')
    const view0 = (await c.tasks.getStatus(cli, { taskId })).data
    const verify = actionOf(view0, 'verification')
    await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })
    await settle(c, taskId)
    const view = (await c.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'failed'); assert.equal(view.statusReason, 'verification-failed')
    assert.deepEqual(view.taskVerification.failingChecks, ['unit-tests'])
    assert.deepEqual(view.operatorActions, [], 'no action can turn a failed verification into a pass')
    assert.notEqual((await c.tasks.getResult(cli, { taskId })).data.outcome, 'completed')
    await c.dispose()
  }
  pass('failed verification: status failed / verification-failed with the failing checks; no action is offered that could convert it into completion')

  // 3. Missing required check: verification passes but completion is denied.
  {
    const f = fixture('denied', async ({ binding, addAttempt }) => {
      addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'passed')
      return { verification: 'passed', checks: { total: 1, passed: 1, failed: 0, skipped: 0 }, completion: { complete: false, reason: 'missing: required check build' }, attemptStatus: 'passed' }
    })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'denied')
    const verify = actionOf((await c.tasks.getStatus(cli, { taskId })).data, 'verification')
    await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })
    await settle(c, taskId)
    const view = (await c.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'completion-denied')
    assert.equal(view.taskVerification.completion.complete, false); assert.ok(view.taskVerification.completion.reason.includes('missing: required check build'))
    assert.equal(actionOf(view, 'verification'), undefined, 'no re-verification of the same attempt')
    const close = actionOf(view, 'recovery')
    const closed = await c.tasks.respond(cli, { taskId, actionId: close.id, expectedRevision: close.revision, choiceId: 'close' })
    assert.equal(closed.data.disposition, 'closed')
    const after = (await c.tasks.getStatus(cli, { taskId })).data
    assert.equal(after.status, 'cancelled'); assert.equal(after.statusReason, 'operator-closed'); assert.equal(after.closed.reason, 'completion-denied')
    await c.dispose()
  }
  pass('missing required check: verification passed but completion denied with the TaskController reason; close is the only action; closed tasks stay closed')

  // 4. Interrupted / incomplete verification never becomes PASS.
  {
    const f = fixture('incomplete', async ({ binding, addAttempt }) => {
      addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'interrupted', { reason: 'verification-incomplete' })
      throw Object.assign(new Error('Verify-Project timed out'), { code: 'verify-timeout' })
    })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'incomplete')
    const verify = actionOf((await c.tasks.getStatus(cli, { taskId })).data, 'verification')
    await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })
    await settle(c, taskId)
    const view = (await c.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'verification-incomplete')
    assert.ok(view.taskVerification.reason.includes('verify-timeout'))
    assert.equal(actionOf(view, 'verification'), undefined); assert.ok(actionOf(view, 'recovery'))
    await c.dispose()
  }
  pass('incomplete verification (pipeline error): blocked / verification-incomplete, never a pass; only close is offered')

  // 5. Host restart during verification: recorded as interrupted, no PASS, no re-run.
  {
    let release
    const gate = new Promise((r) => { release = r })
    const f = fixture('restart', async () => { await gate; return { verification: 'passed', completion: { complete: true } } })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'restart')
    const verify = actionOf((await c.tasks.getStatus(cli, { taskId })).data, 'verification')
    await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })
    assert.equal(c.intake.byTaskId(taskId).verification.state, 'running', 'the verification intent is durable before dispatch')
    assert.equal((await c.tasks.getStatus(cli, { taskId })).data.status, 'verifying', 'a running verification is reported as verifying')
    // "Crash": a new Controller over the same data while verification was running.
    const c2 = f.core()
    await c2.managedTasks.reconcile()
    const view = (await c2.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'verification-incomplete'); assert.equal(view.taskVerification.state, 'interrupted')
    assert.equal(actionOf(view, 'verification'), undefined, 'an interrupted verification is not re-run automatically or offered as pass')
    release()
    await settle(c, taskId)
    await c.dispose(); await c2.dispose()
  }
  pass('host restart during verification: reconciled to interrupted / verification-incomplete; no fabricated PASS; not re-run')

  // 6. Stale, forged, unauthorized and concurrent responses; duplicates.
  {
    let release
    const gate = new Promise((r) => { release = r })
    const f = fixture('races', async ({ binding, setTask, addAttempt }) => { await gate; addAttempt(binding.taskId, 'verifying'); addAttempt(binding.taskId, 'passed'); setTask(binding.taskInstanceId, 'complete'); return { verification: 'passed', completion: { complete: true } } })
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'races')
    const view = (await c.tasks.getStatus(cli, { taskId })).data
    const verify = actionOf(view, 'verification')
    assert.equal((await c.tasks.respond(readOnly, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })).error.code, 'AUTH_REQUIRED')
    assert.equal((await c.tasks.respond(cli, { taskId, actionId: 'act_verify_forged_a9', expectedRevision: verify.revision, choiceId: 'run' })).error.code, 'STALE_ACTION')
    assert.equal((await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: String(Number(verify.revision) + 7), choiceId: 'run' })).error.code, 'STALE_ACTION')
    assert.equal((await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'pass' })).error.code, 'USAGE')
    const [fromGui, fromCli] = await Promise.all([
      c.tasks.respond(gui, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' }),
      c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' }),
    ])
    const dispositions = [fromGui, fromCli].map((r) => (r.ok ? r.data.disposition : r.error.code)).sort()
    assert.ok(dispositions.includes('accepted'), JSON.stringify(dispositions))
    assert.equal(dispositions.filter((d) => d === 'accepted').length, 1, 'exactly one concurrent answer starts verification: ' + JSON.stringify(dispositions))
    const duplicate = await c.tasks.respond(cli, { taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' })
    assert.equal(duplicate.data.disposition, 'duplicate', 'a repeated answer returns the prior receipt')
    release()
    await settle(c, taskId)
    assert.equal(f.calls.verify, 1, 'verification ran exactly once')
    // Stale after the state changed.
    assert.equal((await c.tasks.respond(cli, { taskId, actionId: actionOf(view, 'recovery').id, expectedRevision: view.revision, choiceId: 'close' })).error.code, 'STALE_ACTION')
    await c.dispose()
  }
  pass('respond safety: unauthorized refused, forged/stale/unknown-choice refused, concurrent GUI+CLI answers start verification once, duplicates return the receipt, actions invalidate on state change')

  // 7. Interrupted execution: close only; never verified from stale state; identity and tombstone kept.
  {
    const f = fixture('interrupted', async () => { throw new Error('must not be called') })
    const c = f.core()
    await c.managedTasks.reconcile()
    const text = 'Interrupted task'
    const submitted = await c.tasks.submit(cli, { idempotencyKey: 'interrupted', workspace: f.workspace, mode: 'engineering-v2', prompt: { kind: 'text', text, digest: digestOf(text) } })
    const { taskId, sessionId } = submitted.data
    const record = c.intake.byTaskId(taskId)
    await c.managedTasks.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [{ source: { kind: 'user', rpcId: record.requestId } }] })
    await c.dispose()
    // Host died mid-turn: reconcile parks it as interrupted.
    const c2 = f.core()
    await c2.managedTasks.reconcile()
    const view = (await c2.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.status, 'interrupted'); assert.ok(view.guidance.includes('never resumed automatically'))
    assert.deepEqual(view.operatorActions.map((a) => a.kind), ['recovery'], 'an interrupted task offers close only (no resume, no verification)')
    const close = actionOf(view, 'recovery')
    const closed = await c2.tasks.respond(cli, { taskId, actionId: close.id, expectedRevision: close.revision, choiceId: 'close' })
    assert.equal(closed.data.disposition, 'closed'); assert.equal(f.calls.closeAttempt, 1)
    const after = (await c2.tasks.getStatus(cli, { taskId })).data
    assert.equal(after.status, 'cancelled'); assert.equal(after.closed.attemptClosed, true)
    assert.equal(c2.admission.isManaged(sessionId), true, 'a closed task\'s session stays managed')
    assert.equal((await c2.managedTasks.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [] })).allowed, false)
    const replay = await c2.tasks.submit(cli, { idempotencyKey: 'interrupted', workspace: f.workspace, mode: 'engineering-v2', prompt: { kind: 'text', text, digest: digestOf(text) } })
    assert.equal(replay.data.taskId, taskId, 'the protected key returns the original task, never a new one')
    assert.equal(f.calls.prompt, 1, 'no second delivery or execution')
    assert.equal(f.calls.verify, 0)
    assert.equal((await c2.tasks.cancel(cli, { taskId })).data.disposition, 'already_terminal')
    await c2.dispose()
  }
  pass('interrupted execution: close only (no resume, no verification), open attempt closed as interrupted, session stays managed, key keeps the original task, nothing re-runs')

  // 8. Orphaned identity: no action possible.
  {
    const f = fixture('orphan', async () => ({}))
    const c = f.core()
    const { taskId } = await executedTask(f, c, 'orphan')
    const record = c.intake.byTaskId(taskId)
    await c.dispose()
    fs.rmSync(path.join(c.intake.dir, record.intakeId + '.json'))
    const c2 = f.core()
    const view = (await c2.tasks.getStatus(cli, { taskId })).data
    assert.equal(view.statusReason, 'intake-record-missing'); assert.deepEqual(view.operatorActions, []); assert.ok(view.guidance.includes('Restore the record'))
    assert.equal((await c2.tasks.respond(cli, { taskId, actionId: 'act_close_x', expectedRevision: '1', choiceId: 'close' })).error.details.reason, 'intake-record-missing')
    await c2.dispose()
  }
  pass('orphaned identity: guidance to restore the record; respond refused (intake-record-missing); tombstone kept')

  clearInterval(keepAlive)
  console.log(`NexusTaskVerification: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
