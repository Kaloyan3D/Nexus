'use strict'

/**
 * P2-B2B: durable managed intake, admission tickets, approval broker, product
 * gateway policy and activation gates. Synthetic DSH ports (in-memory session
 * logs with an explicit durable/flushed prefix) — no DSH, no model, no network.
 * Crash boundaries are simulated by discarding the engine and the unflushed
 * tail, then reloading the store from disk and reconciling.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createIntakeStore } = require('../config/nexus/intake-store.cjs')
const { createApprovalBroker } = require('../config/nexus/broker.cjs')
const { createManagedTasks, deliveryEvidence } = require('../config/nexus/managed-tasks.cjs')
const { createGatewayPolicy, nexusRouteVerdict } = require('../config/nexus/gateway-policy.cjs')
const controllerModule = require('../config/nexus/controller.cjs')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-managed-intake-'))
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const digestOf = (text) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const submission = (key, text = 'Implement the acceptance criteria.', mode = 'engineering-v2') => ({ idempotencyKey: key, workspace: '/ws/a', mode, prompt: { kind: 'text', text, digest: digestOf(text) } })

/** Synthetic DSH: sessions with a live log and a durable (flushed) prefix. */
function createFakeDsh(options = {}) {
  const sessions = new Map() // id -> { live: [], durable: number, header }
  const calls = []
  const dsh = {
    sessions,
    calls,
    failPrompt: false,
    skipInsert: false,
    autoStartTurn: options.autoStartTurn !== false,
    onTurnStart: null,
    sessionExists: async (id) => sessions.has(id),
    createSession: async ({ sessionId, workspaceId, agentPreset }) => {
      calls.push(['create', sessionId])
      if (!sessions.has(sessionId)) sessions.set(sessionId, { live: [], durable: 0, header: { cwd: '/ws/a', workspaceId, agentPreset } })
      return sessionId
    },
    prepare: async ({ sessionId }) => { calls.push(['prepare', sessionId]); return { taskId: 'TASK-0001', taskInstanceId: 'task_' + crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32) } },
    prompt: async ({ sessionId, requestId, text }) => {
      calls.push(['prompt', sessionId, requestId])
      if (dsh.failPrompt) throw new Error('prompt refused')
      const session = sessions.get(sessionId)
      const message = { content: text, source: { kind: 'user', rpcId: requestId } }
      const dedup = session.live.some((event) => (event.type === 'agent/inbox/spliced' && event.data.inserted.some((m) => m.source.rpcId === requestId)))
      if (dedup || dsh.skipInsert) return
      session.live.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } })
      if (dsh.autoStartTurn) queueMicrotask(() => { if (dsh.onTurnStart) dsh.onTurnStart(sessionId, message); session.live.push({ type: 'user/message', data: message }) })
    },
    flush: async (sessionId) => { const session = sessions.get(sessionId); if (session) session.durable = session.live.length },
    readDurable: async (sessionId) => { const session = sessions.get(sessionId); if (!session) throw new Error('no such session'); if (session.unreadable) throw new Error('corrupt log'); return session.live.slice(0, session.durable) },
    cancelTurn: async (sessionId) => { calls.push(['cancel', sessionId]) },
    liveEvents: (sessionId) => { const session = sessions.get(sessionId); return session ? session.live : undefined },
    resolveWorkspace: async (workspacePath) => (workspacePath === '/ws/a' ? { workspaceId: 'ws-a', path: '/ws/a' } : null),
    resolveProfile: (preset) => (preset === 'aih-muse' ? 'muse-spark-1.3-contributor' : 'deepseek-codex'),
    lastReply: async (sessionId) => (sessions.has(sessionId) ? { text: 'Synthetic reply for ' + sessionId, at: null, seq: 1 } : null),
    /** Crash: drop every unflushed event. */
    crash() { for (const session of sessions.values()) session.live = session.live.slice(0, session.durable) },
  }
  return dsh
}

function engineFor(dir, dsh, active = { value: true }) {
  const store = createIntakeStore({ dataRoot: dir, canWrite: () => true })
  store.load()
  const broker = createApprovalBroker({})
  const engine = createManagedTasks({ store, broker, ports: dsh, activation: () => ({ active: active.value, problems: active.value ? [] : ['test-inactive'] }) })
  return { store, broker, engine }
}

async function main() {
  // Broker/admission timers are unref'd in product code (the host keeps the
  // loop alive); keep this test process alive while it awaits them.
  const keepAlive = setInterval(() => {}, 1000)
  // ── Intake store ─────────────────────────────────────────────────────
  {
    const dir = path.join(scratch, 'store')
    const store = createIntakeStore({ dataRoot: dir, canWrite: () => true })
    assert.equal(store.load().state, 'ok')
    const canonical = { workspaceId: 'ws', workspacePath: '/ws', mode: 'engineering-v2', promptDigest: 'sha256:1', promptBytes: 3, sourceKind: 'text' }
    const first = store.reserve({ principalId: 'local-owner', idempotencyKey: 'k', fingerprint: 'f1', canonical, preset: 'aih-muse', profileId: 'p', promptText: 'abc' })
    assert.equal(first.replay, false)
    assert.match(first.record.taskId, /^nt_[0-9a-f]{32}$/)
    assert.equal(store.reserve({ principalId: 'local-owner', idempotencyKey: 'k', fingerprint: 'f1', canonical, preset: 'aih-muse', profileId: 'p', promptText: 'abc' }).record.taskId, first.record.taskId)
    assert.throws(() => store.reserve({ principalId: 'local-owner', idempotencyKey: 'k', fingerprint: 'f2', canonical, preset: 'aih-muse', profileId: 'p', promptText: 'x' }), { code: 'IDEMPOTENCY_CONFLICT' })
    assert.throws(() => store.transition(first.record.intakeId, ['bound'], 'delivering'), { code: 'intake-state-conflict' })
    assert.throws(() => store.transition(first.record.intakeId, ['reserved'], 'accepted'), { code: 'intake-transition-forbidden' })
    assert.throws(() => store.transition(first.record.intakeId, ['reserved'], 'session-created', { taskId: 'nt_x' }), { code: 'intake-identity-immutable' })
    const file = path.join(store.dir, first.record.intakeId + '.json')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700)
    }
    assert.deepEqual(fs.readdirSync(store.dir).filter((name) => name.endsWith('.tmp')), [], 'atomic writes leave no temp files')
    // Accepted drops the protected prompt copy.
    let record = store.transition(first.record.intakeId, ['reserved'], 'session-created')
    record = store.transition(record.intakeId, ['session-created'], 'bound', { taskInstanceId: 'task_' + 'a'.repeat(32) })
    record = store.transition(record.intakeId, ['bound'], 'delivering')
    record = store.transition(record.intakeId, ['delivering'], 'accepted')
    assert.equal(record.prompt.text, undefined)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).prompt.text, undefined)
    assert.throws(() => store.annotate(record.intakeId, record.revision - 1, { x: 1 }), { code: 'STALE_ACTION' })
    // A second process with the same records sees the same registry.
    const again = createIntakeStore({ dataRoot: dir, canWrite: () => false })
    again.load()
    assert.equal(again.bySessionId(record.sessionId).taskId, record.taskId)
    assert.throws(() => again.reserve({ principalId: 'local-owner', idempotencyKey: 'k2', fingerprint: 'f', canonical, preset: 'aih-muse', profileId: 'p', promptText: 'y' }), { code: 'intake-store-not-owner' })
    // Corruption: unhealthy, quarantined session ids stay managed.
    fs.writeFileSync(path.join(store.dir, 'f'.repeat(64) + '.json'), '{"sessionId":"session-11111111-2222-3333-4444-555555555555", broken')
    const corrupt = createIntakeStore({ dataRoot: dir, canWrite: () => true })
    assert.equal(corrupt.load().state, 'corrupt')
    assert.equal(corrupt.isQuarantined('session-11111111-2222-3333-4444-555555555555'), true)
    assert.throws(() => corrupt.reserve({ principalId: 'local-owner', idempotencyKey: 'k3', fingerprint: 'f', canonical, preset: 'aih-muse', profileId: 'p', promptText: 'y' }), { code: 'intake-store-unhealthy' })
    pass('intake store: idempotent reserve, conflict, CAS transitions, immutable ids, 0600/0700, atomic, prompt dropped on accept, owner-only writes, corruption quarantined')
  }

  // ── Happy path, replay and conflict ──────────────────────────────────
  {
    const dir = path.join(scratch, 'happy')
    const dsh = createFakeDsh()
    const { store, engine } = engineFor(dir, dsh)
    await engine.reconcile()
    const result = await engine.submit('local-owner', submission('key-1'))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.data.status, 'accepted')
    const record = store.byTaskId(result.data.taskId)
    assert.equal(record.state, 'accepted')
    assert.equal(deliveryEvidence(await dsh.readDurable(record.sessionId), record.requestId).inserted, 1, 'acknowledged only after the durable insertion')
    const replay = await engine.submit('local-owner', submission('key-1'))
    assert.equal(replay.ok, true); assert.equal(replay.data.taskId, result.data.taskId); assert.equal(replay.data.replay, true)
    assert.equal(dsh.calls.filter((call) => call[0] === 'prompt').length, 1, 'a replay never re-delivers')
    const resolveProfile = dsh.resolveProfile
    dsh.resolveProfile = () => null
    const replayWithoutProfile = await engine.submit('local-owner', submission('key-1'))
    assert.equal(replayWithoutProfile.ok, true, 'a retry of an accepted intake does not depend on the current profile choice: ' + JSON.stringify(replayWithoutProfile))
    assert.equal(replayWithoutProfile.data.taskId, result.data.taskId)
    assert.equal((await engine.submit('local-owner', submission('key-new'))).code, 'MODE_UNAVAILABLE', 'a NEW submission still needs a resolvable profile')
    dsh.resolveProfile = resolveProfile
    const conflict = await engine.submit('local-owner', submission('key-1', 'different text'))
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')
    // Concurrent GUI + CLI submissions under one key: one task, one message.
    const [a, b] = await Promise.all([engine.submit('local-owner', submission('key-2')), engine.submit('local-owner', submission('key-2'))])
    assert.equal(a.ok && b.ok, true); assert.equal(a.data.taskId, b.data.taskId)
    const second = store.byTaskId(a.data.taskId)
    assert.equal(deliveryEvidence(dsh.sessions.get(second.sessionId).live, second.requestId).inserted, 1)
    // Validation is fail closed and exact.
    for (const [input, code] of [
      [{ ...submission('k'), extra: 1 }, 'USAGE'],
      [{ ...submission('k'), prompt: { kind: 'text', text: 'x', digest: digestOf('y') } }, 'USAGE'],
      [{ ...submission('k'), mode: 'nova' }, 'MODE_UNAVAILABLE'],
      [{ ...submission('k'), workspace: '/elsewhere' }, 'NOT_FOUND'],
      [{ ...submission('has space') }, 'USAGE'],
    ]) assert.equal((await engine.submit('local-owner', input)).code, code)
    pass('submit: acknowledged only after durable read-back; replay returns the original receipt; conflict refused; concurrent same-key submissions yield one task and one message')
  }

  // ── Delivery failures park, never ack ────────────────────────────────
  {
    const dsh = createFakeDsh()
    const { engine, store } = engineFor(path.join(scratch, 'park'), dsh)
    await engine.reconcile()
    dsh.skipInsert = true
    const notDurable = await engine.submit('local-owner', submission('k-park'))
    assert.equal(notDurable.ok, false); assert.equal(notDurable.code, 'SUBMISSION_UNCERTAIN')
    assert.equal(store.byTaskId(notDurable.details.taskId).hold.reason, 'delivery-not-durable')
    dsh.skipInsert = false
    dsh.failPrompt = true
    const rejected = await engine.submit('local-owner', submission('k-rej'))
    assert.equal(store.byTaskId(rejected.details.taskId).hold.reason, 'delivery-rejected')
    pass('a delivery that is not durably found (or rejected) parks the intake and is never acknowledged')
  }

  // ── Crash boundaries and reconciliation ──────────────────────────────
  {
    // Each case: drive the intake to a boundary, crash (drop unflushed log),
    // reload store + engine, reconcile, and check the single safe outcome.
    async function crashAt(name, prepare) {
      const dir = path.join(scratch, 'crash-' + name)
      const dsh = createFakeDsh({ autoStartTurn: false })
      const first = engineFor(dir, dsh)
      await first.engine.reconcile()
      const record = await prepare(first, dsh)
      dsh.crash()
      const second = engineFor(dir, dsh)
      await second.engine.reconcile()
      return { dsh, store: second.store, engine: second.engine, record: second.store.get(record.intakeId) }
    }
    const reserveOnly = async ({ store }) => store.reserve({ principalId: 'local-owner', idempotencyKey: 'k', fingerprint: 'f', canonical: { workspaceId: 'ws-a', workspacePath: '/ws/a', mode: 'engineering-v2', promptDigest: digestOf('p'), promptBytes: 1, sourceKind: 'text' }, preset: 'aih-muse', profileId: 'muse-spark-1.3-contributor', promptText: 'p' }).record
    const toBound = async (ctx, dsh) => {
      let record = await reserveOnly(ctx)
      await dsh.createSession({ sessionId: record.sessionId, workspaceId: 'ws-a', agentPreset: 'aih-muse' })
      record = ctx.store.transition(record.intakeId, ['reserved'], 'session-created')
      return ctx.store.transition(record.intakeId, ['session-created'], 'bound', { taskInstanceId: 'task_' + 'b'.repeat(32) })
    }
    // (1) crash after reserve, before session creation -> resumable, then delivered once.
    let c = await crashAt('reserved', reserveOnly)
    assert.equal(c.record.state, 'reserved')
    await c.engine.resumePending()
    assert.equal(c.store.get(c.record.intakeId).state, 'accepted')
    assert.equal(c.dsh.calls.filter((call) => call[0] === 'prompt').length, 1)
    // (2) crash after durable intent, before DSH insertion -> redelivered under the same ids, once.
    c = await crashAt('delivering-absent', async (ctx, dsh) => ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering'))
    assert.equal(c.record.state, 'delivering')
    await c.engine.resumePending()
    const redelivered = c.store.get(c.record.intakeId)
    assert.equal(redelivered.state, 'accepted')
    assert.deepEqual(c.dsh.calls.filter((call) => call[0] === 'prompt').map((call) => call[2]), [c.record.requestId], 'same request id, exactly one delivery')
    // (3) crash after insertion was flushed, before ack -> accepted once + held (never resumed or replayed).
    c = await crashAt('inserted', async (ctx, dsh) => {
      const record = ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering')
      await dsh.prompt({ sessionId: record.sessionId, requestId: record.requestId, text: 'p' }); await dsh.flush(record.sessionId)
      return record
    })
    assert.equal(c.record.state, 'parked'); assert.equal(c.record.hold.reason, 'restored-input-not-resumed'); assert.ok(c.record.acceptedAt)
    await c.engine.resumePending()
    assert.equal(c.dsh.calls.filter((call) => call[0] === 'prompt').length, 1, 'no second delivery after a durable insertion')
    // (4) crash after the turn claimed the input -> interrupted (work may have run).
    c = await crashAt('claimed', async (ctx, dsh) => {
      const record = ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering')
      await dsh.prompt({ sessionId: record.sessionId, requestId: record.requestId, text: 'p' })
      dsh.sessions.get(record.sessionId).live.push({ type: 'user/message', data: { source: { kind: 'user', rpcId: record.requestId } } })
      await dsh.flush(record.sessionId)
      return record
    })
    assert.equal(c.record.hold.reason, 'interrupted')
    // (5) insertion not flushed before the crash -> proven absent -> redelivered once.
    c = await crashAt('unflushed', async (ctx, dsh) => {
      const record = ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering')
      await dsh.prompt({ sessionId: record.sessionId, requestId: record.requestId, text: 'p' })
      return record
    })
    await c.engine.resumePending()
    assert.equal(c.store.get(c.record.intakeId).state, 'accepted')
    // (6) unreadable durable log -> explicit hold.
    c = await crashAt('unreadable', async (ctx, dsh) => {
      const record = ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering')
      dsh.sessions.get(record.sessionId).unreadable = true
      return record
    })
    assert.equal(c.record.hold.reason, 'delivery-evidence-unreadable')
    // (7) duplicate durable input -> held.
    c = await crashAt('duplicate', async (ctx, dsh) => {
      const record = ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering')
      const session = dsh.sessions.get(record.sessionId)
      for (let i = 0; i < 2; i += 1) session.live.push({ type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user', rpcId: record.requestId } }] } })
      await dsh.flush(record.sessionId)
      return record
    })
    assert.equal(c.record.hold.reason, 'duplicate-input')
    // (8) accepted and executing when the host died -> interrupted, no further turn.
    c = await crashAt('executing', async (ctx, dsh) => {
      let record = ctx.store.transition((await toBound(ctx, dsh)).intakeId, ['bound'], 'delivering')
      record = ctx.store.transition(record.intakeId, ['delivering'], 'accepted', { acceptedAt: new Date().toISOString() })
      return ctx.store.annotate(record.intakeId, record.revision, { executionStartedAt: new Date().toISOString() })
    })
    assert.equal(c.record.state, 'parked'); assert.equal(c.record.hold.reason, 'interrupted')
    const ticket = await c.engine.admitStep(c.record.sessionId, { id: c.record.sessionId }, { step: 1 })
    assert.equal(ticket.allowed, false, 'an interrupted task never runs another turn automatically')
    pass('crash boundaries reconcile to one safe state: resume (no DSH effect yet), redeliver same ids (proven absent), accept+hold (durable once), interrupted (claimed/executing), hold (unreadable/duplicate)')
  }

  // ── Admission tickets ────────────────────────────────────────────────
  {
    const dsh = createFakeDsh()
    const active = { value: true }
    const { engine, store } = engineFor(path.join(scratch, 'tickets'), dsh, active)
    await engine.reconcile()
    const tickets = []
    dsh.onTurnStart = (sessionId, message) => { tickets.push(engine.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [message] })) }
    const result = await engine.submit('local-owner', submission('k-ticket'))
    const record = store.byTaskId(result.data.taskId)
    const first = await tickets[0]
    assert.equal(first.allowed, true, JSON.stringify(first))
    assert.ok(store.get(record.intakeId).executionStartedAt, 'execution start is persisted at admission')
    assert.equal(engine.stepAdmitted(record.sessionId), true)
    assert.equal((await engine.admitStep(record.sessionId, { id: record.sessionId }, { step: 2 })).allowed, true, 'continuation steps of the admitted turn run')
    const child = { id: 'session-child', header: { origin: 'subagent', parentSession: record.sessionId } }
    assert.equal((await engine.admitStep(record.sessionId, child, { step: 1 })).allowed, true, 'subagents run only inside the admitted turn')
    engine.onTurnEnd(record.sessionId, 'completed')
    assert.equal((await engine.admitStep(record.sessionId, child, { step: 1 })).code, 'managed-lineage-inactive')
    assert.equal((await engine.admitStep(record.sessionId, { id: record.sessionId }, { step: 1 })).code, 'managed-turn-already-run', 'a managed task gets exactly one admitted turn')
    assert.equal((await engine.admitStep(record.sessionId, { id: record.sessionId }, { step: 3 })).code, 'managed-turn-not-admitted')
    // Foreign input (e.g. an owner prompt that bypassed the gateway) is refused.
    dsh.onTurnStart = null
    const other = await engine.submit('local-owner', submission('k-ticket-2'))
    await new Promise((resolve) => setImmediate(resolve))
    const otherRecord = store.byTaskId(other.data.taskId)
    const forgedInput = { source: { kind: 'user', rpcId: 'forged' } }
    const genuine = { source: { kind: 'user', rpcId: otherRecord.requestId } }
    assert.equal((await engine.admitStep(otherRecord.sessionId, { id: otherRecord.sessionId }, { step: 1, messages: [forgedInput] })).code, 'managed-input-mismatch')
    assert.equal((await engine.admitStep(otherRecord.sessionId, { id: otherRecord.sessionId }, { step: 1, messages: [genuine, forgedInput] })).code, 'managed-input-mismatch', 'an extra owner input riding along is refused')
    assert.equal((await engine.admitStep(otherRecord.sessionId, { id: otherRecord.sessionId }, { step: 1 })).code, 'managed-input-mismatch', 'no claimed input is refused')
    active.value = false
    assert.equal((await engine.admitStep(otherRecord.sessionId, { id: otherRecord.sessionId }, { step: 1, messages: [genuine] })).code, 'managed-admission-inactive')
    assert.equal((await engine.submit('local-owner', submission('k-off'))).code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    assert.equal(engine.stepAdmitted(record.sessionId), false)
    active.value = true
    assert.equal((await engine.admitStep('session-unknown', { id: 'session-unknown' }, { step: 1 })).code, 'managed-registry-unknown')
    pass('admission tickets: step 1 only for the exact reserved input after commit; one turn per task; continuation/subagents only while live; inactive/unknown/forged refused')
  }

  // ── Step 1 waits for the commit (no provider call before acceptance) ──
  {
    const dsh = createFakeDsh()
    const { engine, store } = engineFor(path.join(scratch, 'commit-order'), dsh)
    await engine.reconcile()
    const order = []
    const realFlush = dsh.flush
    dsh.flush = async (id) => { order.push('flush'); await new Promise((resolve) => setTimeout(resolve, 50)); return realFlush(id) }
    let ticket
    dsh.onTurnStart = (sessionId, message) => { order.push('turn-start'); ticket = engine.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [message] }).then((v) => { order.push('ticket:' + v.allowed); return v }) }
    const result = await engine.submit('local-owner', submission('k-order'))
    order.push('acked')
    await ticket
    assert.equal(store.byTaskId(result.data.taskId).state, 'accepted')
    assert.ok(order.indexOf('ticket:true') > order.indexOf('flush'), 'the step ticket is issued only after the flush + read-back: ' + order.join(','))
    pass('the first managed step waits for the durable intake commit; no model step precedes acceptance')
  }

  // ── Cancellation ─────────────────────────────────────────────────────
  {
    const dsh = createFakeDsh()
    const { engine, store, broker } = engineFor(path.join(scratch, 'cancel'), dsh)
    await engine.reconcile()
    const tickets = []
    dsh.onTurnStart = (sessionId, message) => { tickets.push(engine.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [message] })) }
    const result = await engine.submit('local-owner', submission('k-cancel'))
    await tickets[0]
    const record = store.byTaskId(result.data.taskId)
    const pending = broker.request({ taskId: record.taskId, sessionId: record.sessionId, kind: 'approval', label: 'shell', choices: [{ id: 'allow-once', label: 'Allow' }, { id: 'reject', label: 'Reject' }] })
    const cancel = await engine.cancel(record.taskId)
    assert.equal(cancel.data.disposition, 'requested')
    assert.deepEqual(await pending, { choiceId: null, reason: 'task-cancelled' }, 'cancellation withdraws pending approvals without granting them')
    assert.deepEqual(dsh.calls.filter((call) => call[0] === 'cancel'), [['cancel', record.sessionId]])
    assert.equal((await engine.cancel(record.taskId)).data.disposition, 'already_requested')
    assert.equal((await engine.admitStep(record.sessionId, { id: record.sessionId }, { step: 2 })).code, 'managed-task-cancelled')
    engine.onTurnEnd(record.sessionId, 'cancelled')
    assert.ok(store.get(record.intakeId).cancelledAt)
    assert.equal((await engine.cancel(record.taskId)).data.disposition, 'already_terminal')
    assert.equal((await engine.cancel('nt_' + '0'.repeat(32))).code, 'NOT_FOUND')
    pass('cancel: committed request, live turn cancelled, broker actions withdrawn (no grant), later steps refused, settled on turn end; idempotent dispositions')
  }

  // ── Broker races ─────────────────────────────────────────────────────
  {
    const broker = createApprovalBroker({})
    const owner = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:respond'] }
    const gui = { kind: 'local-owner', via: 'gui', capabilities: ['tasks:respond'] }
    const choices = [{ id: 'allow-once', label: 'Allow' }, { id: 'reject', label: 'Reject' }]
    const outcome = broker.request({ taskId: 'nt_a', sessionId: 's', kind: 'approval', label: 'x', choices })
    const [action] = broker.pendingFor('nt_a')
    assert.equal(broker.respond({ kind: 'local-owner', via: 'x', capabilities: ['tasks:read'] }, { taskId: 'nt_a', actionId: action.id, expectedRevision: '1', choiceId: 'allow-once' }).code, 'NOT_FOUND', 'unauthorized principals cannot answer')
    assert.equal(broker.respond(owner, { taskId: 'nt_b', actionId: action.id, expectedRevision: '1', choiceId: 'allow-once' }).code, 'NOT_FOUND', 'foreign task ids are refused')
    assert.equal(broker.respond(owner, { taskId: 'nt_a', actionId: action.id, expectedRevision: '2', choiceId: 'allow-once' }).code, 'STALE_ACTION')
    assert.equal(broker.respond(owner, { taskId: 'nt_a', actionId: action.id, expectedRevision: '1', choiceId: 'always' }).code, 'USAGE')
    const results = [broker.respond(gui, { taskId: 'nt_a', actionId: action.id, expectedRevision: '1', choiceId: 'reject' }), broker.respond(owner, { taskId: 'nt_a', actionId: action.id, expectedRevision: '1', choiceId: 'allow-once' })]
    assert.equal(results[0].disposition, 'accepted'); assert.equal(results[1].code, 'STALE_ACTION', 'first valid answer wins (GUI reject beats CLI allow)')
    assert.deepEqual(await outcome, { choiceId: 'reject', reason: 'answered' })
    assert.equal(broker.respond(owner, { taskId: 'nt_a', actionId: action.id, expectedRevision: '1', choiceId: 'reject' }).disposition, 'duplicate')
    const expiring = broker.request({ taskId: 'nt_e', sessionId: 's', kind: 'approval', label: 'x', choices, ttlMs: 20 })
    assert.deepEqual(await expiring, { choiceId: null, reason: 'expired' })
    const [expired] = [...broker.pendingFor('nt_e')]
    assert.equal(expired, undefined, 'an expired action is no longer offered')
    const controller = new AbortController()
    const aborted = broker.request({ taskId: 'nt_d', sessionId: 's', kind: 'approval', label: 'x', choices, signal: controller.signal })
    const [disconnect] = broker.pendingFor('nt_d')
    controller.abort()
    assert.deepEqual(await aborted, { choiceId: null, reason: 'aborted' })
    assert.equal(broker.respond(owner, { taskId: 'nt_d', actionId: disconnect.id, expectedRevision: '1', choiceId: 'allow-once' }).code, 'STALE_ACTION', 'a late answer after the turn ended cannot grant')
    const disposed = broker.request({ taskId: 'nt_x', sessionId: 's', kind: 'approval', label: 'x', choices })
    broker.dispose()
    assert.equal((await disposed).choiceId, null)
    pass('broker: first valid answer wins across GUI/CLI; duplicate returns receipt; stale/foreign/unauthorized/unknown-choice refused; expiry, abort and disposal never grant')
  }

  // ── Product gateway policy ───────────────────────────────────────────
  {
    const managedIds = new Set(['M'])
    const live = new Set(['M'])
    const sessions = { M: { header: { cwd: '/ws/a' } }, U: { header: { cwd: '/ws/a' } }, U2: { header: { cwd: '/ws/b' } }, C: { header: { cwd: '/ws/a', origin: 'subagent', parentSession: 'M' } } }
    const isManaged = (s) => { const id = typeof s === 'string' ? s : s.id; return managedIds.has(id) || (sessions[id] && sessions[id].header.parentSession && managedIds.has(sessions[id].header.parentSession)) }
    let closed = false
    const controller = { get closed() { return closed }, admission: { isManaged, activeManagedSessions: () => [...live], isManagedTaskInstance: (id) => id === 'task_m' } }
    const policy = createGatewayPolicy({ controller: () => controller, sessionOf: (id) => sessions[id], workspaceSessions: (id) => (id === 'ws-a' ? ['M', 'U'] : ['U2']) })
    const owner = { kind: 'owner' }
    const decide = (action, resources, args = {}) => policy.decide({ principal: owner, action, resources, args, transport: 'unary' })
    const session = (id) => [{ kind: 'session', id }]
    assert.equal(decide('session/state', session('M')), undefined, 'reads abstain')
    for (const action of ['session/prompt', 'session/updateQueue', 'session/cancel', 'session/rename', 'session/selectModel', 'session/fork', 'session/create', 'workspace/archiveSession', 'workspace/pinSession', 'session/selectAgentPreset']) assert.equal(decide(action, session('M')).reason, 'nexus-managed-session', action)
    assert.equal(decide('session/rename', session('C')).reason, 'nexus-managed-session', 'subagent lineage is managed')
    assert.equal(decide('session/delete', [], { childSessionId: 'M' }).reason, 'nexus-managed-session')
    assert.equal(decide('$events/result', [{ kind: 'global' }], { event: 'approval/request', agentId: 'M', outcome: 'resolved' }).reason, 'nexus-managed-session', 'forwarded approval answers for managed agents are refused')
    assert.equal(decide('workspace/delete', [{ kind: 'workspace', id: 'ws-a' }]).reason, 'nexus-managed-workspace')
    assert.equal(decide('workspace/pinSession', session('U')), undefined, 'ordinary sessions keep owner maintenance')
    assert.equal(decide('terminal/create', session('U')).reason, 'nexus-managed-workspace', 'terminals in the managed cwd are refused')
    assert.equal(decide('terminal/create', session('U2')), undefined)
    assert.equal(decide('pluginManager/install', [{ kind: 'global' }]).reason, 'nexus-host-protected-while-active')
    assert.equal(decide('session/rename', undefined).reason, 'nexus-unattributed-while-active', 'a missing resource is never permission')
    assert.equal(policy.fetchRouteVerdict('POST', new URL('http://h/api/session/uploadFileBinary?sessionId=M')).reason, 'nexus-managed-session')
    assert.equal(policy.fetchRouteVerdict('POST', new URL('http://h/api/session/uploadFileBinary?sessionId=U')), undefined)
    assert.equal(nexusRouteVerdict(controller, '/nexus/gate-action.json', { sessionId: 'M' }).reason, 'nexus-managed-session')
    assert.equal(nexusRouteVerdict(controller, '/nexus/registry/v1/models', {}).reason, 'nexus-host-protected-while-active')
    assert.equal(nexusRouteVerdict(controller, '/nexus/mode-default.json', {}).reason, 'nexus-host-protected-while-active')
    assert.equal(nexusRouteVerdict(controller, '/nexus/workspace-registration.json', {}).allowed, true)
    live.clear(); managedIds.clear()
    assert.equal(decide('pluginManager/install', [{ kind: 'global' }]), undefined, 'host maintenance is unchanged without a live managed task')
    assert.equal(decide('session/rename', undefined), undefined)
    closed = true
    assert.equal(decide('session/rename', session('U')).reason, 'nexus-controller-unavailable', 'fail closed without a Controller')
    assert.equal(decide('session/state', session('U')), undefined)
    assert.equal(nexusRouteVerdict(null, '/nexus/gate-action.json', {}).reason, 'nexus-controller-unavailable')
    pass('product gateway policy: managed sessions/lineage/approval answers/workspaces/terminals/host maintenance/fetch upload/Nexus routes refused with reasons; ordinary maintenance unchanged; fail closed')
  }

  // ── Activation gates (no bypass) ─────────────────────────────────────
  {
    const dataRoot = path.join(scratch, 'gates')
    const legacyCli = { pwshHost: 'x', toolchainRoot: 'x', timeoutMs: 1, stats: () => ({}) }
    process.env.NEXUS_MANAGED_ADMISSION = '1'; process.env.NEXUS_FORCE_SUBMIT = '1'; process.env.AIH_MANAGED = 'active'
    const core = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot, enforceOwnership: true, legacyCli, qualifiedPlatforms: [process.platform] })
    assert.equal(core.admission.state, 'disabled')
    core.setOwnership({ state: 'held', lockPath: '/x' })
    core.bindManagedPorts(createFakeDsh())
    for (const gate of ['policyInstalled', 'fetchGuardInstalled', 'brokerInstalled', 'workspaceGuardInstalled', 'dshServicesReady']) core.setManagedGate(gate, true)
    const detach = core.attachRouteGuard('test')
    await core.managedTasks.reconcile()
    assert.deepEqual(core.activation().problems, ['gateway-hook-unverified:not-verified'], 'environment variables do not satisfy any gate')
    core.setManagedGate('hook', { ok: false, reason: 'gateway-build-not-allowlisted' })
    assert.equal(core.admission.state, 'disabled')
    assert.equal((await core.tasks.submit({ kind: 'internal' }, submission('k'))).error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    core.setManagedGate('hook', { ok: true, reason: 'verified' })
    assert.equal(core.admission.state, 'active')
    detach()
    assert.deepEqual(core.activation().problems, ['nexus-route-guard-not-attached'], 'unloading the Nexus route plugin deactivates admission')
    core.attachRouteGuard('test')
    core.setOwnership({ state: 'contended', lockPath: '/x' })
    assert.equal(core.admission.state, 'disabled')
    core.setOwnership({ state: 'held', lockPath: '/x' })
    core.setManagedGate('dshServicesReady', false)
    assert.deepEqual(core.activation().problems, ['dsh-session-services-unavailable'], 'losing the DSH session services deactivates admission')
    core.setManagedGate('dshServicesReady', true)
    const other = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot: path.join(scratch, 'gates-unqualified'), enforceOwnership: true, legacyCli, qualifiedPlatforms: ['plan9'] })
    assert.ok(other.activation().problems.includes('platform-not-qualified:' + process.platform))
    assert.throws(() => core.bindManagedPorts({}), { code: 'managed-ports-bound' })
    assert.throws(() => core.setManagedGate('everything', true), { code: 'managed-gate-unknown' })
    const unenforced = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot: path.join(scratch, 'gates-unit'), managedIntake: true, legacyCli })
    assert.ok(unenforced.activation().problems.includes('ownership-not-held-and-enforced'), 'an unenforced core can never activate')
    await core.dispose()
    assert.equal(core.admission.state, 'disabled')
    await other.dispose(); await unenforced.dispose()
    delete process.env.NEXUS_MANAGED_ADMISSION; delete process.env.NEXUS_FORCE_SUBMIT; delete process.env.AIH_MANAGED
    pass('activation requires every gate (hook verified, policy, fetch guard, broker, route guard, workspace guard, DSH services, ports, reconcile, enforced ownership, qualified platform); env vars, unload and ownership loss deactivate')
  }

  // ── Task API end to end on an active core (synthetic DSH) ────────────
  {
    const dataRoot = path.join(scratch, 'api')
    const legacyCli = { pwshHost: 'x', toolchainRoot: 'x', timeoutMs: 1, stats: () => ({}) }
    const core = controllerModule.createControllerCore({ installRoot: dataRoot, dataRoot, enforceOwnership: true, legacyCli, qualifiedPlatforms: [process.platform], workspaceAuthorizer: async () => true })
    core.setOwnership({ state: 'held', lockPath: '/x' })
    const dsh = createFakeDsh()
    core.bindManagedPorts(dsh)
    for (const gate of ['policyInstalled', 'fetchGuardInstalled', 'brokerInstalled', 'workspaceGuardInstalled', 'dshServicesReady']) core.setManagedGate(gate, true)
    core.attachRouteGuard('test')
    core.setManagedGate('hook', { ok: true })
    await core.managedTasks.reconcile()
    const cli = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read', 'tasks:submit', 'tasks:cancel', 'tasks:respond'] }
    const readOnly = { kind: 'local-owner', via: 'ipc', capabilities: ['tasks:read'] }
    assert.equal((await core.tasks.submit(readOnly, submission('k'))).error.code, 'AUTH_REQUIRED', 'submit needs tasks:submit')
    let ticket
    dsh.onTurnStart = (sessionId, message) => { ticket = core.managedTasks.admitStep(sessionId, { id: sessionId }, { step: 1, messages: [message] }) }
    const submitted = await core.tasks.submit(cli, submission('api-1'))
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    await ticket
    const taskId = submitted.data.taskId
    let status = await core.tasks.getStatus(cli, { taskId })
    assert.equal(status.data.status, 'running'); assert.equal(status.data.cohort, 'managed')
    assert.equal(core.admission.isManaged(submitted.data.sessionId), true, 'the managed registry is the durable intake')
    const approval = core.broker.request({ taskId, sessionId: submitted.data.sessionId, kind: 'approval', label: 'bash: rm', choices: [{ id: 'allow-once', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] })
    status = await core.tasks.getStatus(cli, { taskId })
    assert.equal(status.data.status, 'awaiting_operator')
    const [action] = status.data.operatorActions
    const answered = await core.tasks.respond(cli, { taskId, actionId: action.id, expectedRevision: action.revision, choiceId: 'allow-once' })
    assert.equal(answered.data.disposition, 'accepted')
    assert.equal((await approval).choiceId, 'allow-once')
    assert.equal((await core.tasks.respond(readOnly, { taskId, actionId: action.id, expectedRevision: '1', choiceId: 'allow-once' })).error.code, 'AUTH_REQUIRED')
    core.managedTasks.onTurnEnd(submitted.data.sessionId, 'completed')
    status = await core.tasks.getStatus(cli, { taskId })
    assert.equal(status.data.status, 'blocked', 'a finished DSH turn never completes a Nexus task by itself')
    assert.equal(status.data.statusReason, 'turn-completed-awaiting-verification')
    assert.equal(status.data.reply.text, 'Synthetic reply for ' + submitted.data.sessionId, 'status carries Nexus\'s last reply')
    assert.equal((await core.tasks.getResult(cli, { taskId })).data.summary, 'Synthetic reply for ' + submitted.data.sessionId, 'result summary is the last reply')
    const result = await core.tasks.getResult(cli, { taskId })
    assert.equal(result.data.outcome, 'pending')
    const cancelled = await core.tasks.cancel(cli, { taskId })
    assert.equal(cancelled.data.disposition, 'requested'); assert.equal(cancelled.data.status, 'cancelled')
    await core.dispose()
    pass('task API on an active core: capability-checked submit, running → awaiting_operator → respond → turn end (not completed) → cancel; status/result never derived from a DSH turn')
  }

  clearInterval(keepAlive)
  console.log(`NexusManagedIntake: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
