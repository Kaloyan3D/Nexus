'use strict'

/**
 * P2-A Task D: internal shared task API on the host Controller.
 * Read-only projections over existing authorities; refused mutations; no
 * transport, no subprocess, no model.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')

const sourceRoot = path.join(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-api-'))
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
delete process.env.AIH_TOOLCHAIN_ROOT
const controllerModule = require('../config/nexus/controller.cjs')
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const internal = { kind: 'internal' }

async function main() {
  const dataRoot = path.join(scratch, 'data')
  const workspace = path.join(scratch, 'ws')
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'state'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'runs', 'TASK-0001'), { recursive: true })
  const dualId = 'task_' + crypto.randomBytes(16).toString('hex')
  const museId = 'task_' + crypto.randomBytes(16).toString('hex')
  const binding = (sessionId, taskInstanceId, engine) => ({ sessionId, taskInstanceId, taskId: engine === 'muse' ? 'TASK-0002' : 'TASK-0001', workspace, workspaceId: 'ws-1', preset: engine === 'muse' ? 'aih-muse' : 'aih-engineering', engine, executionClass: engine === 'muse' ? 'muse_main' : 'engineer_normal', reviewRequired: false, needsRouteCheck: false })
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: { sd: binding('sd', dualId, 'dual'), sm: binding('sm', museId, 'muse') } }))
  const ledgerPath = path.join(workspace, '.ai-harness', 'state', 'tasks.json')
  const writeLedger = (dualStatus) => fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ taskId: 'TASK-0001', taskInstanceId: dualId, status: dualStatus }, { taskId: 'TASK-0002', taskInstanceId: museId, status: 'implementing' }] }))
  writeLedger('implementing')
  fs.writeFileSync(path.join(workspace, '.ai-harness', 'runs', 'TASK-0001', 'attempts.jsonl'), JSON.stringify({ taskId: 'TASK-0001', sequence: 1, status: 'started' }) + '\n')
  const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
  const api = core.tasks
  fake.reset()

  // Authorization: internal only.
  for (const principal of [undefined, null, { kind: 'owner' }, { kind: 'browser' }, { kind: 'local-owner' }, { kind: 'local-owner', capabilities: ['tasks:write'] }]) {
    const denied = (await api.getStatus(principal, { taskId: dualId }))
    assert.equal(denied.ok, false); assert.equal(denied.error.code, 'AUTH_REQUIRED')
  }
  // A local-owner (IPC-derived) principal sees only tasks in registered workspaces.
  const localOwner = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read'] }
  const concealed = await api.getStatus(localOwner, { taskId: dualId })
  assert.equal(concealed.error.code, 'NOT_FOUND', 'no workspace authorizer => concealed, never data')
  pass('only host-derived principals are accepted; IPC principals need tasks:read and an authorized workspace')

  const hello = api.hello(internal)
  assert.equal(hello.ok, true)
  assert.deepEqual(hello.data.operations, ['hello', 'listModes', 'getStatus', 'getResult', 'follow', 'cancel', 'respond'])
  assert.deepEqual(hello.data.refusedOperations, ['submit'])
  assert.equal(hello.data.managedAdmission, 'disabled')
  const modes = api.listModes(internal).data.modes
  assert.deepEqual(modes.map((m) => [m.id, m.strategyId, m.submittable]).sort(), [['engineering-v1', 'nexus.legacy-dual', false], ['engineering-v2', 'nexus.muse', false]])
  pass('hello/listModes advertise the read operations, the refused mutations and the real strategies')

  const dual = (await api.getStatus(internal, { taskId: dualId }))
  assert.equal(dual.ok, true)
  assert.equal(dual.data.status, 'running')
  assert.equal(dual.data.mode, 'engineering-v1')
  assert.equal(dual.data.strategyId, 'nexus.legacy-dual')
  assert.equal(dual.data.attemptId, '1')
  assert.equal(dual.data.revision, '1')
  assert.equal(dual.data.cohort, 'legacy')
  const muse = (await api.getStatus(internal, { taskId: museId }))
  assert.equal(muse.data.mode, 'engineering-v2')
  assert.equal(muse.data.review.state, 'not_required')
  assert.equal(muse.data.review.policyReason, 'muse-engine-has-no-independent-reviewer')
  pass('status projects the binding, TaskController ledger and attempts for EMv1 Dual and EMv2 Muse')

  // A DSH turn ending changes nothing; only the ledger's `complete` completes.
  assert.equal((await api.getResult(internal, { taskId: dualId })).data.outcome, 'pending')
  writeLedger('verifying')
  fs.writeFileSync(path.join(workspace, '.ai-harness', 'runs', 'TASK-0001', 'evidence.json'), JSON.stringify({ attempt: 1, verification: [{ name: 'test', status: 'PASS' }] }))
  const verifying = (await api.getStatus(internal, { taskId: dualId })).data
  assert.equal(verifying.status, 'verifying')
  assert.equal(verifying.verification.state, 'passed')
  assert.equal(verifying.revision, '2', 'revision advances when an authoritative record changes')
  assert.equal((await api.getStatus(internal, { taskId: dualId })).data.revision, '2', 'revision is stable without a change')
  assert.equal((await api.getResult(internal, { taskId: dualId })).data.outcome, 'pending', 'passing verification alone is not completion')
  writeLedger('complete')
  const completed = (await api.getResult(internal, { taskId: dualId })).data
  assert.equal(completed.status, 'completed'); assert.equal(completed.outcome, 'completed')
  pass('completion is reported only from the TaskController ledger, never from verification or a turn ending')

  // follow: unchanged within the wait window, then the change is delivered.
  const unchanged = await api.follow(internal, { taskId: museId, afterRevision: '1', waitMs: 150 })
  assert.equal(unchanged.data.unchanged, true)
  setTimeout(() => fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ taskId: 'TASK-0001', taskInstanceId: dualId, status: 'complete' }, { taskId: 'TASK-0002', taskInstanceId: museId, status: 'failed' }] })), 100)
  const changed = await api.follow(internal, { taskId: museId, afterRevision: '1', waitMs: 3000 })
  assert.equal(changed.data.unchanged, false); assert.equal(changed.data.view.status, 'failed')
  assert.equal((await api.follow(internal, { taskId: museId, afterRevision: 'x' })).error.code, 'USAGE')
  pass('follow long-polls a monotonic revision and returns the change or unchanged at the deadline')

  // Lookup and corruption.
  assert.equal((await api.getStatus(internal, { taskId: 'TASK-0001' })).error.code, 'USAGE', 'display ids are never lookup keys')
  assert.equal((await api.getStatus(internal, { taskId: 'task_' + '0'.repeat(32) })).error.code, 'NOT_FOUND')
  fs.writeFileSync(ledgerPath, '{ torn')
  const torn = (await api.getStatus(internal, { taskId: dualId })).data
  assert.equal(torn.status, 'blocked'); assert.equal(torn.statusReason, 'ledger-unreadable')
  pass('unknown and display ids are refused; an unreadable ledger projects blocked, never completed')

  // Mutations refused with typed codes.
  // P2-B2B: submit stays refused without an active managed activation; cancel
  // applies to managed tasks only; respond needs a live broker action.
  const submitted = await api.submit(internal, { idempotencyKey: 'k', workspace, mode: 'engineering-v2', prompt: { kind: 'text', text: 'x', digest: 'sha256:00' } })
  assert.equal(submitted.ok, false); assert.equal(submitted.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE'); assert.equal(submitted.error.details.reason, 'managed-admission-disabled')
  assert.ok(submitted.error.details.problems.includes('managed-intake-not-configured'))
  const cancelled = await api.cancel(internal, { taskId: dualId })
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE'); assert.equal(cancelled.error.details.reason, 'legacy-task')
  const responded = await api.respond(internal, { taskId: dualId })
  assert.equal(responded.ok, false); assert.equal(responded.error.code, 'USAGE')
  assert.deepEqual(fake.invocations(), [], 'the task API never starts a controller CLI')
  assert.equal(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), 'utf8').includes('"sd"'), true)
  assert.equal(core.bindings.metrics().writes, 0, 'the task API never writes bindings')
  pass('submit refused (managed admission disabled), legacy cancel/respond refused; no subprocess, no write')

  await core.dispose()
  console.log(`NexusTaskApi: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
