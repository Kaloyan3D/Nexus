'use strict'

/**
 * P2-B2C: DSH 0.2 session-durability invariants that Nexus writers must keep.
 *   1. Source kinds: every Nexus message writer passes DSH's own format-v4 row
 *      admission (the pinned `dsh-session-format-v3-to-v4` code, not a copy);
 *      the retired `plugin` kind is refused by that same code.
 *   2. Notice ordering: on a DSH 0.2 session without the protected
 *      `system/message` head, the bridge never appends a surface notice; it
 *      publishes it through the pre-step `enter` decision (DSH appends it after
 *      the head) or queues it durably when the step is rejected, and publishes
 *      the queue at the next entered step exactly once.
 *   3. Managed identity retention: deleted/missing intake records never release
 *      a managed session; keys stay taken; retirement keeps protection.
 * Synthetic PowerShell host; no DSH host, no model, no network.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')

const sourceRoot = path.join(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-session-durability-'))
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
process.env.AIH_INSTALL_ROOT = sourceRoot
delete process.env.AIH_TOOLCHAIN_ROOT
delete process.env.AIH_ENABLE_REGISTRY_BINDING
const messageSource = require('../config/Nexus-MessageSource.cjs')
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }

function locateApp() {
  const candidates = [process.env.AIH_HOST_APP, path.join(sourceRoot, 'app')].filter(Boolean)
  for (const dir of candidates) if (fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-session-format-v3-to-v4'))) return dir
  throw new Error('pinned DSH app with dsh-session-format-v3-to-v4 not found (set AIH_HOST_APP); this suite never skips the real v4 admission check')
}

/** A DSH 0.2-shaped session: private log behind snapshotEvents(), append(type, data, opts). */
function v4Session(id, workspace, preset) {
  const log = []
  return {
    log,
    session: {
      id,
      header: { version: 4, cwd: workspace, agentPreset: preset },
      snapshotEvents() { return log.slice() },
      append(type, data, opts) { const event = { type, seq: log.length, data, ...(opts && opts.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}) }; log.push(event); return event },
    },
  }
}

function seedBinding(dataRoot, workspace, sessionId, engine) {
  const preset = engine === 'muse' ? 'aih-muse' : 'aih-engineering'
  const binding = {
    sessionId, taskInstanceId: 'task_' + crypto.randomBytes(16).toString('hex'), taskId: 'TASK-0001', workspace,
    workspaceId: 'ws-1', repositoryId: 'repo-1', checkoutId: 'co-1', checkoutRootPath: workspace, executionRoot: workspace,
    preset, engine, description: 'synthetic task', executionClass: engine === 'muse' ? 'muse_main' : 'engineer_normal',
    reviewRequired: false, needsRouteCheck: false, boundAtUtc: new Date(0).toISOString(),
  }
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: binding } }))
  return binding
}

function canned(workspace, binding) {
  return {
    'NexusWorkspace.ps1:resolve': { json: { workspaceId: 'ws-1', repositoryId: 'repo-1', checkoutId: 'co-1', executionRoot: workspace, checkoutRootPath: workspace } },
    'Task.ps1:test-task': { json: { exists: true, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, instanceMatches: true, boundEngine: binding.engine } },
    'Task.ps1:begin-attempt': { json: { taskId: binding.taskId, sequence: 1, status: 'started' } },
    'Route.ps1': { json: { executionClass: binding.executionClass, reviewRequired: false } },
    '*': { json: {} },
  }
}

function mountBridge(extra = {}) {
  const bridgePath = path.join(sourceRoot, 'config', 'AihController.cjs')
  delete require.cache[bridgePath]
  const bridge = require(bridgePath)
  const handlers = {}
  const ctx = { on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return () => {} }, shellEnv: { list() { return [] }, register() {} }, ...extra }
  bridge.apply(ctx)
  return { handlers, bridge }
}

const userPrompt = (text) => ({ id: 'msg-' + crypto.randomUUID(), role: 'user', source: { kind: 'user', rpcId: crypto.randomUUID() }, content: [{ type: 'text', text }] })
const surfaceUserMessages = (log) => log.filter((e) => e.type === 'user/message' && e.surfaceOp !== undefined)

async function main() {
  const appDir = locateApp()
  const appRequire = createRequire(path.join(appDir, 'package.json'))
  const v4 = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)

  // ── 1. Real DSH v4 source admission for every Nexus writer ───────────────
  {
    const { createControllerMessage } = require('../config/AihController.cjs')
    const admitted = (message, type = 'user/message') => { v4.assertV4RowAdmission({ type, seq: 1, time: 1, data: message, surfaceOp: 'append' }); return true }
    const notice = createControllerMessage('Controller: task bound', 'controller-binding')
    assert.equal(notice.source.kind, 'aih-controller')
    assert.equal(admitted(notice), true)
    const writers = {
      'context-checkpoint (V1 bridge apply)': messageSource.controllerSource({ form: 'context-checkpoint', operationId: 'op-1' }),
      'context-checkpoint (CCv2 lab writer)': messageSource.controllerSource({ form: 'context-checkpoint', operationId: 'op-1', generation: 1, taskInstanceId: 'task_x' }),
      'context-continuation (CCv2 lab writer)': messageSource.controllerSource({ form: 'context-continuation', operationId: 'op-1', generation: 1 }),
    }
    for (const [label, source] of Object.entries(writers)) assert.equal(admitted({ id: 'm', role: 'user', content: [{ type: 'text', text: 'x' }], source }), true, label)
    // The same DSH code refuses the retired shape (the check is real, not vacuous).
    assert.throws(() => admitted({ id: 'm', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'aih-controller', form: 'notice' } }), /producer-owned source kind/)
    assert.equal(messageSource.isRefusedSourceKind({}), true, 'a kindless source is refused by the v4 relationship check (mirrored)')
    // Readers keep the legacy shape.
    assert.equal(messageSource.isControllerSource({ kind: 'plugin', plugin: 'aih-controller' }), true)
    assert.equal(messageSource.isControllerSource({ kind: 'aih-controller', plugin: 'aih-controller' }), true)
    assert.equal(messageSource.isControllerSource({ kind: 'user' }), false)
    assert.equal(messageSource.isRuntimeContextSource({ kind: 'runtime-context', form: 'snapshot' }), true, 'DSH 0.2 runtime context')
    assert.equal(messageSource.isRuntimeContextSource({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }), true, 'DSH 0.1 runtime context')
    assert.deepEqual(messageSource.controllerSource({ kind: 'plugin', plugin: 'other', form: 'f' }), { kind: 'aih-controller', plugin: 'aih-controller', form: 'f' }, 'writers cannot be coaxed into another kind')
    // No production source writes the retired kind any more.
    const offenders = []
    for (const file of fs.readdirSync(path.join(sourceRoot, 'config')).filter((name) => name.endsWith('.cjs'))) {
      const text = fs.readFileSync(path.join(sourceRoot, 'config', file), 'utf8')
      if (/kind:\s*'plugin'/.test(text) && file !== 'Nexus-MessageSource.cjs') offenders.push(file)
    }
    assert.deepEqual(offenders, [], 'no config module writes source.kind "plugin"')
    pass('every Nexus message writer passes the pinned DSH format-v4 source admission; the retired plugin kind is refused by the same code; readers accept both shapes')
  }

  // ── 2. Protected-head detection ──────────────────────────────────────────
  {
    assert.equal(messageSource.hasProtectedSurfaceHead([]), false)
    assert.equal(messageSource.hasProtectedSurfaceHead([{ type: 'turn/start' }, { type: 'agent/inbox/spliced' }]), false)
    assert.equal(messageSource.hasProtectedSurfaceHead([{ type: 'turn/start' }, { type: 'system/message', surfaceOp: 'append' }, { type: 'user/message', surfaceOp: 'append' }]), true)
    assert.equal(messageSource.hasProtectedSurfaceHead([{ type: 'user/message', surfaceOp: 'append' }, { type: 'system/message', surfaceOp: 'append' }]), false, 'an already-invalid prefix is never treated as safe')
    assert.equal(messageSource.hasProtectedSurfaceHead(undefined), false)
    pass('protected surface head detection follows the v4 rule (first surface event must be system/message)')
  }

  // ── 3. Notice ordering through the real bridge pre-step ──────────────────
  for (const engine of ['muse', 'dual']) {
    fake.reset()
    const dataRoot = path.join(scratch, 'order-' + engine, 'data'); const workspace = path.join(scratch, 'order-' + engine, 'ws')
    fs.mkdirSync(dataRoot, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
    process.env.DSH_HOME = dataRoot
    const sessionId = 'session-order-' + engine
    const binding = seedBinding(dataRoot, workspace, sessionId, engine)
    fake.respond(canned(workspace, binding))
    const { handlers } = mountBridge()
    const { session, log } = v4Session(sessionId, workspace, binding.preset)
    log.push({ type: 'turn/start', seq: 0, data: { turn: 1 } })
    const prompt = userPrompt('Implement the change.')
    const result = await handlers['agent/pre-step'][0]({ agent: { session }, step: 1, turn: 1, messages: [prompt] }, async () => ({ kind: 'enter', messages: [prompt] }))
    assert.equal(surfaceUserMessages(log).length, 0, engine + ': no surface notice was appended before the protected system head')
    assert.equal(result.kind, 'enter')
    const notices = result.messages.filter((m) => messageSource.isControllerSource(m.source))
    assert.ok(notices.length >= 1, engine + ': the first-turn Controller notice is published in the enter decision: ' + JSON.stringify(result.messages.map((m) => m.source)))
    assert.equal(result.messages[result.messages.length - 1], prompt, engine + ': the claimed prompt keeps its place after the notices')
    for (const m of notices) v4.assertV4RowAdmission({ type: 'user/message', seq: 1, time: 1, data: m, surfaceOp: 'append' })
    // Emulate DSH runStep: protected head, then the decision messages.
    session.append('system/message', { turn: 1, step: 1, message: { role: 'system' } }, { surfaceOp: 'append' })
    for (const m of result.messages) session.append('user/message', m, { surfaceOp: 'append' })
    for (const event of log.filter((e) => e.type === 'user/message')) for (const h of handlers['session/event'] || []) await h(session, event)
    assert.equal(log.find((e) => e.surfaceOp !== undefined).type, 'system/message', engine + ': the first surface event is the system head')
    // After the head exists notices are appended directly, as before P2-B2C.
    const before = log.length
    const continuation = await handlers['agent/pre-step'][0]({ agent: { session }, step: 2, turn: 1, messages: [] }, async () => ({ kind: 'continue' }))
    assert.ok(continuation)
    assert.ok(log.length >= before)
    pass(engine + ': first-turn Controller notices are published after the protected system head via the pre-step enter decision; prompt order and v4 validity preserved')
  }

  // ── 4. Rejected first turn: durable queue, published once at the next entered step ──
  {
    fake.reset()
    const dataRoot = path.join(scratch, 'queue', 'data'); const workspace = path.join(scratch, 'queue', 'ws')
    fs.mkdirSync(dataRoot, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
    process.env.DSH_HOME = dataRoot
    const sessionId = 'session-queue'
    const binding = seedBinding(dataRoot, workspace, sessionId, 'muse')
    fake.respond(canned(workspace, binding))
    // A Cordis host whose Controller service is absent: every step is refused
    // with a visible notice (P1 fail-closed path).
    const missing = () => undefined
    const first = mountBridge({ get: missing, reflect: { get: missing } })
    const { session, log } = v4Session(sessionId, workspace, 'aih-muse')
    let nextRan = false
    const refused = await first.handlers['agent/pre-step'][0]({ agent: { session }, step: 1, turn: 1, messages: [userPrompt('x')] }, async () => { nextRan = true; return { kind: 'enter', messages: [] } })
    assert.equal(refused.kind, 'reject'); assert.equal(nextRan, false)
    assert.equal(surfaceUserMessages(log).length, 0, 'a rejected first turn appends no surface notice')
    const queueFile = path.join(dataRoot, 'routing', 'pending-notices', encodeURIComponent(sessionId) + '.json')
    const queued = JSON.parse(fs.readFileSync(queueFile, 'utf8'))
    assert.ok(queued.notices.length >= 1 && queued.notices.every((n) => n.source.kind === 'aih-controller'), 'the refusal notice is queued durably')
    if (process.platform !== 'win32') assert.equal(fs.statSync(queueFile).mode & 0o777, 0o600)
    // A fresh bridge (host restart, Controller back) publishes it at the next entered step.
    const second = mountBridge()
    const prompt = userPrompt('retry')
    const entered = await second.handlers['agent/pre-step'][0]({ agent: { session }, step: 1, turn: 2, messages: [prompt] }, async () => ({ kind: 'enter', messages: [prompt] }))
    assert.equal(entered.kind, 'enter')
    const ids = queued.notices.map((n) => n.id)
    assert.deepEqual(entered.messages.slice(0, ids.length).map((m) => m.id), ids, 'queued notices lead the next entered step, in order')
    assert.equal(surfaceUserMessages(log).length, 0, 'still nothing appended before the head')
    session.append('system/message', { turn: 2, step: 1, message: { role: 'system' } }, { surfaceOp: 'append' })
    for (const m of entered.messages) { const event = session.append('user/message', m, { surfaceOp: 'append' }); for (const h of second.handlers['session/event'] || []) await h(session, event) }
    assert.equal(fs.existsSync(queueFile), false, 'the queue is cleared only after DSH appended the notices')
    const third = await second.handlers['agent/pre-step'][0]({ agent: { session }, step: 1, turn: 3, messages: [userPrompt('again')] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal((third.messages || []).filter((m) => ids.includes(m.id)).length, 0, 'a published notice is never published twice')
    assert.equal(log.find((e) => e.surfaceOp !== undefined).type, 'system/message')
    pass('a rejected first turn queues its notice durably (0600, no surface append); after restart the next entered step publishes it once, after the head')
  }

  // ── 5. Legacy/test sessions (DSH 0.1-shaped `events` array) keep direct append ──
  {
    fake.reset()
    const dataRoot = path.join(scratch, 'legacy', 'data'); const workspace = path.join(scratch, 'legacy', 'ws')
    fs.mkdirSync(dataRoot, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
    process.env.DSH_HOME = dataRoot
    const sessionId = 'session-legacy'
    seedBinding(dataRoot, workspace, sessionId, 'muse')
    const missing = () => undefined
    const { handlers } = mountBridge({ get: missing, reflect: { get: missing } })
    const appended = []
    const session = { id: sessionId, header: { version: 4, cwd: workspace, agentPreset: 'aih-muse' }, events: [], append(type, data) { appended.push({ type, data }) } }
    const result = await handlers['agent/pre-step'][0]({ agent: { session }, step: 1, turn: 1, messages: [userPrompt('x')] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(result.kind, 'reject')
    assert.ok(appended.some((e) => e.type === 'user/message' && e.data.source.kind === 'aih-controller'), 'legacy-shaped sessions are unchanged: notice appended directly')
    assert.equal(fs.existsSync(path.join(dataRoot, 'routing', 'pending-notices')), false)
    pass('sessions without the v4 private log (legacy/test doubles) keep the pre-P2-B2C direct append')
  }

  // ── 6. Managed identity retention (tombstones) ───────────────────────────
  {
    const { createIntakeStore } = require('../config/nexus/intake-store.cjs')
    const controllerModule = require('../config/nexus/controller.cjs')
    const dataRoot = path.join(scratch, 'ledger')
    const canonical = { workspaceId: 'ws', workspacePath: '/ws', mode: 'engineering-v2', promptDigest: 'sha256:1', promptBytes: 1, sourceKind: 'text' }
    const reserve = (store, key, fp = 'f') => store.reserve({ principalId: 'local-owner', idempotencyKey: key, fingerprint: fp, canonical, preset: 'aih-muse', profileId: 'p', promptText: 'x' }).record
    let store = createIntakeStore({ dataRoot, canWrite: () => true }); store.load()
    const a = reserve(store, 'key-a'); const b = reserve(store, 'key-b')
    const ledger = fs.readFileSync(store.ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(ledger.map((e) => [e.op, e.sessionId]), [['identity', a.sessionId], ['identity', b.sessionId]])
    if (process.platform !== 'win32') assert.equal(fs.statSync(store.ledgerPath).mode & 0o777, 0o600)
    // Retirement keeps protection.
    store.retire(b.intakeId, 'completed')
    // Cleanup deletes record A: never a downgrade.
    fs.rmSync(path.join(store.dir, a.intakeId + '.json'))
    store = createIntakeStore({ dataRoot, canWrite: () => true })
    const health = store.load()
    assert.equal(health.state, 'corrupt'); assert.ok(health.problems.includes('record-missing:' + a.intakeId))
    assert.equal(store.isQuarantined(a.sessionId), true, 'a deleted record leaves its session managed (quarantined)')
    assert.ok(store.managedSessionIds().includes(a.sessionId))
    assert.deepEqual(store.identityStatus().map((s) => [s.sessionId, s.disposition]).sort(), [[a.sessionId, 'record-missing'], [b.sessionId, 'retired']].sort())
    assert.throws(() => reserve(store, 'key-a'), (error) => ['intake-store-unhealthy', 'IDEMPOTENCY_RETIRED'].includes(error.code), 'the deleted key cannot be reused')
    // Authorization stays effective through the Controller and the policy.
    const legacyCli = { pwshHost: 'x', toolchainRoot: 'x', timeoutMs: 1, stats: () => ({}) }
    const core = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot, managedIntake: true, legacyCli })
    assert.equal(core.admission.isManaged(a.sessionId), true, 'deleted record: still managed')
    assert.equal(core.admission.isManaged(b.sessionId), true, 'retired: still managed')
    assert.equal((await core.admission.admit({ id: a.sessionId, header: {} }, { step: 1, messages: [] })).allowed, false)
    assert.ok(core.activation().problems.includes('intake-store-corrupt'), 'a missing record disables managed activation')
    const { createGatewayPolicy } = require('../config/nexus/gateway-policy.cjs')
    const policy = createGatewayPolicy({ controller: () => core, sessionOf: () => undefined, workspaceSessions: () => [] })
    assert.equal(policy.decide({ principal: { kind: 'owner' }, action: 'session/rename', resources: [{ kind: 'session', id: a.sessionId }], args: {}, transport: 'unary' }).reason, 'nexus-managed-session')
    assert.equal(policy.decide({ principal: { kind: 'owner' }, action: 'session/rename', resources: [{ kind: 'session', id: b.sessionId }], args: {}, transport: 'unary' }).reason, 'nexus-managed-session')
    await core.dispose()
    // Crash between record and ledger (or a P2-B2B store): repaired, adds protection.
    const upgradeRoot = path.join(scratch, 'ledger-upgrade')
    let fresh = createIntakeStore({ dataRoot: upgradeRoot, canWrite: () => true }); fresh.load()
    const c = reserve(fresh, 'key-c')
    fs.rmSync(fresh.ledgerPath)
    fresh = createIntakeStore({ dataRoot: upgradeRoot, canWrite: () => true })
    assert.equal(fresh.load().state, 'ok', 'a record without a ledger entry is healthy (still managed by its record)')
    assert.equal(fresh.repairLedger(), 1)
    assert.equal(JSON.parse(fs.readFileSync(fresh.ledgerPath, 'utf8').trim()).sessionId, c.sessionId)
    // A torn final ledger append is ignorable.
    fs.appendFileSync(fresh.ledgerPath, '{"op":"identity","intakeId":"x')
    fresh = createIntakeStore({ dataRoot: upgradeRoot, canWrite: () => true })
    assert.equal(fresh.load().state, 'ok')
    // Retired tasks never run again.
    const { createManagedTasks } = require('../config/nexus/managed-tasks.cjs')
    const { createApprovalBroker } = require('../config/nexus/broker.cjs')
    fresh.retire(c.intakeId, 'done')
    const engine = createManagedTasks({ store: fresh, broker: createApprovalBroker({}), ports: {}, activation: () => ({ active: true, problems: [] }) })
    assert.equal((await engine.admitStep(c.sessionId, { id: c.sessionId }, { step: 1, messages: [] })).code, 'managed-task-retired')
    pass('identity ledger: deleted records stay managed and keep their key; retirement keeps protection and blocks turns; missing ledger entries are repaired (protection only); torn tail tolerated')
  }

  console.log(`NexusSessionDurability: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
