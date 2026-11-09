'use strict'

/**
 * P1 plugin-first foundation: AihController plane bridge <-> host Nexus
 * Controller.
 *
 * Deterministic, synthetic transport only (tests/lib/FakePwshHost.cjs): no
 * PowerShell, no network, no model request. The bridge is driven through its
 * real DSH hook handlers (agent/pre-step, session/event).
 *
 * Part A (parity) runs against any bridge build. Set NEXUS_BRIDGE_UNDER_TEST
 * to a pre-P1 AihController.cjs and NEXUS_TRACE_OUT to a file to capture the
 * normalized trace (controller CLI sequence, hook outcome, next() count and
 * controller notices) for an old-vs-new comparison.
 * Part B (host boundary) requires the P1 bridge.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')

const sourceRoot = path.join(__dirname, '..')
const bridgePath = process.env.NEXUS_BRIDGE_UNDER_TEST ? path.resolve(process.env.NEXUS_BRIDGE_UNDER_TEST) : path.join(sourceRoot, 'config', 'AihController.cjs')
const partAOnly = Boolean(process.env.NEXUS_BRIDGE_UNDER_TEST)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bridge-'))
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
process.env.AIH_INSTALL_ROOT = sourceRoot
delete process.env.AIH_TOOLCHAIN_ROOT
delete process.env.AIH_ENABLE_REGISTRY_BINDING

const bridge = require(bridgePath)
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const traces = []

const MUSE_REVIEW_NOTICE =
  'Controller: independent review is not available for the Muse engine (engine=muse, review.independent=false).\n' +
  'The Muse plane never invokes Codex as reviewer, fallback, repair agent, or worker, and no Muse reviewer exists in V0.\n' +
  'Route the task through a Dual profile (Normal Engineering + GLM/Codex or DeepSeek/Codex) for independent review. No files were modified.'

function freshRoot(name) {
  const dataRoot = path.join(scratch, name, 'data')
  const workspace = path.join(scratch, name, 'workspace')
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  process.env.DSH_HOME = dataRoot
  return { dataRoot, workspace }
}

function seedBinding(dataRoot, workspace, sessionId, engine) {
  const preset = engine === 'muse' ? 'aih-muse' : 'aih-engineering'
  const binding = {
    sessionId,
    taskInstanceId: 'task_' + crypto.randomBytes(16).toString('hex'),
    taskId: 'TASK-0001',
    workspace,
    workspaceId: 'ws-1', repositoryId: 'repo-1', checkoutId: 'co-1', checkoutRootPath: workspace, executionRoot: workspace,
    preset, engine,
    description: 'synthetic task',
    executionClass: engine === 'muse' ? 'muse_main' : 'engineer_normal',
    reviewRequired: false, needsRouteCheck: false, boundAtUtc: new Date(0).toISOString(),
  }
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: binding } }))
  return binding
}

function cannedResponses(workspace, binding, overrides = {}) {
  return {
    'NexusWorkspace.ps1:resolve': { json: { workspaceId: 'ws-1', repositoryId: 'repo-1', checkoutId: 'co-1', executionRoot: workspace, checkoutRootPath: workspace } },
    'Task.ps1:test-task': { json: { exists: true, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, instanceMatches: true, boundEngine: binding.engine } },
    'Task.ps1:begin-attempt': { json: { taskId: binding.taskId, sequence: 1, status: 'started' } },
    'Route.ps1': { json: { executionClass: binding.executionClass, reviewRequired: false } },
    '*': { json: {} },
    ...overrides,
  }
}

function mount(options = {}) {
  const handlers = {}
  const ctx = {
    on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return () => {} },
    shellEnv: { list() { return [] }, register() {} },
  }
  // A Cordis context exposes reflect.get (the source of the ctx.get mixin);
  // options.plainGet models legacy harnesses that stub get on a plain object.
  if (options.get) { ctx.get = options.get; ctx.reflect = { get: options.get } }
  if (options.plainGet) ctx.get = options.plainGet
  bridge.apply(ctx)
  return { handlers, ctx }
}

function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function fakeSession(id, workspace, preset) {
  const appended = []
  return { appended, session: { id, header: { version: 4, cwd: workspace, agentPreset: preset }, events: [], append(type, data) { appended.push({ type, data }) } } }
}

function noticesOf(appended) {
  return appended.map((entry) => {
    const message = entry.data || {}
    const block = Array.isArray(message.content) ? message.content.find((item) => item && item.type === 'text') : null
    return { form: message.form || (message.metadata && message.metadata.form) || (message.source && message.source.form) || null, text: block ? block.text : JSON.stringify(message).slice(0, 400) }
  })
}

async function runPreStep(handlers, session, text) {
  let nextCalls = 0
  const handler = handlers['agent/pre-step'][0]
  const result = await handler({ agent: { session }, step: 1, turn: 1, messages: [userMessage(text)] }, async () => { nextCalls += 1; return { kind: 'continue' } })
  return { result, nextCalls }
}

function cliSequence() {
  return fake.invocations().map((item) => item.script + (item.action ? ':' + item.action : ''))
}

async function scenario(name, engine, prompt, overrides) {
  fake.reset()
  const { dataRoot, workspace } = freshRoot(name)
  const sessionId = 'session-' + name
  const binding = seedBinding(dataRoot, workspace, sessionId, engine)
  fake.respond(cannedResponses(workspace, binding, overrides))
  const { handlers } = mount()
  const { session, appended } = fakeSession(sessionId, workspace, binding.preset)
  const outcome = await runPreStep(handlers, session, prompt)
  const trace = { name, engine, prompt, result: outcome.result && outcome.result.kind ? outcome.result.kind : 'next-result', nextCalls: outcome.nextCalls, cli: cliSequence(), notices: noticesOf(appended).map((n) => n.text.replace(/TASK-\d+|task_[0-9a-f]{32}/g, '<id>')) }
  traces.push(trace)
  return trace
}

async function partA() {
  // A1 Muse explicit review: refused with the exact historical notice, no review CLI, no model.
  const museReview = await scenario('muse-review', 'muse', '/review is this correct?')
  assert.equal(museReview.result, 'reject')
  assert.equal(museReview.nextCalls, 0)
  assert.ok(museReview.notices.includes(MUSE_REVIEW_NOTICE), 'Muse review refusal notice is byte-identical')
  assert.ok(!museReview.cli.some((step) => /^Review\.ps1|^Context\.ps1/.test(step)), 'Muse never invokes the review CLI')
  pass('A1 EMv2 Muse explicit review is refused with the historical notice and no reviewer call')

  // A2 Muse engineering turn: one attempt, no Dual epistemic step router, inference admitted once.
  const museTurn = await scenario('muse-turn', 'muse', 'Implement the requested change.')
  assert.equal(museTurn.nextCalls, 1)
  assert.equal(museTurn.cli.filter((step) => step === 'Task.ps1:begin-attempt').length, 1)
  assert.ok(!museTurn.cli.some((step) => step.startsWith('Engineering.ps1:uncertainty-create') || step.startsWith('Engineering.ps1:epistemic-step')), 'Muse skips the Dual step router')
  assert.ok(museTurn.notices.some((text) => /attempt 1 started .*engine=muse/.test(text)), 'Muse attempt notice keeps engine=muse')
  pass('A2 EMv2 Muse engineering turn starts exactly one muse_main attempt without step routing')

  // A3 Dual engineering turn: step router consulted, one attempt, inference admitted once.
  const dualTurn = await scenario('dual-turn', 'dual', 'Implement the requested change.')
  assert.equal(dualTurn.nextCalls, 1)
  assert.ok(dualTurn.cli.includes('Engineering.ps1:uncertainty-create'), 'Dual consults the epistemic step router')
  assert.equal(dualTurn.cli.filter((step) => step === 'Task.ps1:begin-attempt').length, 1)
  assert.ok(dualTurn.notices.some((text) => /attempt 1 started .*step-routed/.test(text)), 'Dual attempt notice keeps step-routed')
  pass('A3 EMv1 Dual engineering turn keeps the step router and one attempt')

  // A4 Inconclusive binding validation: Muse rejects, unmarked Dual keeps its legacy degradation.
  const inconclusive = { 'Task.ps1:test-task': { json: {} } }
  const museInconclusive = await scenario('muse-inconclusive', 'muse', 'Implement the requested change.', inconclusive)
  assert.equal(museInconclusive.result, 'reject')
  assert.equal(museInconclusive.nextCalls, 0)
  const dualInconclusive = await scenario('dual-inconclusive', 'dual', 'Implement the requested change.', inconclusive)
  assert.equal(dualInconclusive.nextCalls, 1)
  pass('A4 inconclusive validation: Muse fails closed, unmarked Dual keeps legacy degradation')

  // A5 Routing failure: Muse notice states no Muse fallback; no inference.
  const routingFailure = { 'Task.ps1:begin-attempt': { stdout: 'not json at all', exit: 0 } }
  const museRouting = await scenario('muse-cli-garbage', 'muse', 'Implement the requested change.', routingFailure)
  assert.equal(museRouting.nextCalls, 1, 'a failed attempt start keeps the historical legacy continuation for unmarked sessions')
  pass('A5 attempt-start CLI failure keeps the historical unmarked-session behavior')
}

async function partB() {
  const controllerModule = require(path.join(sourceRoot, 'config', 'nexus', 'controller.cjs'))

  // B1 Host service absent inside a Cordis composition: fail closed, zero CLI, zero inference.
  {
    fake.reset()
    const { dataRoot, workspace } = freshRoot('host-absent')
    const binding = seedBinding(dataRoot, workspace, 'session-host-absent', 'muse')
    fake.respond(cannedResponses(workspace, binding))
    const { handlers } = mount({ get: () => undefined })
    const { session, appended } = fakeSession('session-host-absent', workspace, 'aih-muse')
    const outcome = await runPreStep(handlers, session, 'Implement the requested change.')
    assert.equal(outcome.result.kind, 'reject')
    assert.equal(outcome.nextCalls, 0)
    assert.deepEqual(cliSequence(), [])
    assert.ok(noticesOf(appended).some((n) => /trusted Nexus Controller service is not available \(nexus-controller-unavailable\)/.test(n.text)))
    // A continuation step is refused too (an unloaded host cannot be bypassed mid-turn).
    const continuation = await handlers['agent/pre-step'][0]({ agent: { session }, step: 2, turn: 1, messages: [] }, async () => ({ kind: 'continue' }))
    assert.equal(continuation.kind, 'reject')
    pass('B1 missing host Controller: bridge stays mounted and refuses with zero CLI and zero inference')
  }

  // B2 Closed host (disposed) and incompatible contract are refused the same way.
  {
    fake.reset()
    const { dataRoot, workspace } = freshRoot('host-closed')
    const binding = seedBinding(dataRoot, workspace, 'session-host-closed', 'dual')
    fake.respond(cannedResponses(workspace, binding))
    const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
    await core.dispose()
    const { handlers } = mount({ get: (name) => (name === 'nexusController' ? core : undefined) })
    const { session } = fakeSession('session-host-closed', workspace, 'aih-engineering')
    const outcome = await runPreStep(handlers, session, 'Implement the requested change.')
    assert.equal(outcome.result.kind, 'reject')
    assert.equal(outcome.nextCalls, 0)
    assert.deepEqual(cliSequence(), [])
    const incompatible = mount({ get: () => ({ contractMajor: 2, closed: false }) })
    const second = await runPreStep(incompatible.handlers, session, 'Implement the requested change.')
    assert.equal(second.result.kind, 'reject')
    assert.equal(second.nextCalls, 0)
    pass('B2 closed or incompatible host Controller is refused (no Dual legacy bypass)')
  }

  // B2b A plain (non-Cordis) object that merely stubs get for other services is
  // a unit harness, not a composition: it embeds a core instead of refusing.
  {
    assert.equal(controllerModule.isCordisContext({ get() {} }), false)
    assert.equal(controllerModule.isCordisContext({ get() {}, reflect: { get() {} } }), true)
    assert.equal(controllerModule.resolveControllerAccess({ get: () => null }, { installRoot: sourceRoot, dataRoot: path.join(scratch, 'plain') }).mode, 'embedded')
    pass('B2b only a Cordis context selects host mode; stubbed plain harnesses embed a core')
  }

  // B3 One host core, two standing plane mounts: a duplicated turn/end is processed once.
  {
    fake.reset()
    const { dataRoot, workspace } = freshRoot('dedup')
    const binding = seedBinding(dataRoot, workspace, 'session-dedup', 'dual')
    fake.respond(cannedResponses(workspace, binding, { 'Engineering.ps1:classify-failure': { json: { signature: 'sig-1', classification: 'unknown' } } }))
    fs.mkdirSync(path.join(workspace, '.ai-harness', 'runs', binding.taskId), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.ai-harness', 'runs', binding.taskId, 'attempts.jsonl'), JSON.stringify({ taskId: binding.taskId, sequence: 1, status: 'started' }) + '\n')
    const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
    const get = (name) => (name === 'nexusController' ? core : undefined)
    const first = mount({ get })
    const second = mount({ get })
    assert.equal(core.readiness().bridges.length, 2, 'both plane bridges attached to the one host Controller')
    const session = { id: 'session-dedup', header: { cwd: workspace, agentPreset: 'aih-engineering' } }
    const turnEnd = { seq: 41, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider exploded' } } } }
    await Promise.all([first.handlers['session/event'][0](session, turnEnd), second.handlers['session/event'][0](session, turnEnd)])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const afterFirst = cliSequence()
    assert.equal(afterFirst.filter((step) => step === 'Task.ps1:failure').length, 1, 'attempt failure recorded once')
    assert.equal(afterFirst.filter((step) => step.startsWith('Route.ps1')).length, 1, 'failure re-route requested once')
    await first.handlers['session/event'][0](session, turnEnd)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(cliSequence(), afterFirst, 'a replayed delivery of the same event is a no-op')
    assert.ok(core.metrics().eventsDeduplicated >= 2)
    pass('B3 duplicated/replayed turn/end across standing mounts is processed exactly once')
    await core.dispose()
  }

  // B4 Transitions of one generation are serialized across observers.
  {
    fake.reset()
    const { dataRoot } = freshRoot('lanes')
    const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
    fake.respond({ 'Task.ps1': { json: { ok: true }, sleepMs: 150 } })
    const lane = 'task_' + 'a'.repeat(32)
    await Promise.all([1, 2, 3].map((n) => core.transition(lane, 'attempt-event', () => core.legacy.invoke('Task.ps1', ['-Action', 'attempt-event', '-TaskId', 'TASK-0001'], { payload: { n } }))))
    const calls = fake.invocations().sort((a, b) => a.start - b.start)
    for (let i = 1; i < calls.length; i += 1) assert.ok(calls[i].start >= calls[i - 1].end, 'no overlapping transition in one lane')
    assert.equal(core.metrics().maxLaneDepth, 3)
    pass('B4 per-generation transition lane serializes concurrent writers')
    await core.dispose()
  }
}

async function main() {
  await partA()
  if (!partAOnly) await partB()
  if (process.env.NEXUS_TRACE_OUT) fs.writeFileSync(process.env.NEXUS_TRACE_OUT, JSON.stringify(traces, null, 2) + '\n')
  console.log(`NexusControllerBridge: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => {
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
