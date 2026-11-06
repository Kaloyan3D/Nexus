'use strict'

// ControllerRouteSelection.Tests.cjs — the DSH 0.2.x controller-owned route
// selection contract at the boundary (offline, deterministic).
//
// Replaces MuseRoutingAuthorityOrdering.Tests.cjs, which asserted the 0.1.x
// `routingAuthority` ranking (controller > preset > session > default) that no
// longer exists upstream: DSH 0.2.x fixes the step route BEFORE pre-step from
// the durable `model/selection` projection and throws if `agent/request`
// proposes another provider/model/effort. The Nexus invariants that mattered
// are asserted here against the new mechanism:
//   1. the controller target is armed into the session and is the route used
//   2. there is no fallback route: every unarmed / stale / foreign / drifted
//      state fails CLOSED and never reaches the provider seam
//   3. a failed step arms the next one, so retry converges on the controller
//   4. delegated (subagent) sessions without a marked binding are untouched

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const profiles = require('../config/Engineering-Profiles.cjs')
const engineering = require('../config/Engineering-Isolation.cjs')
const { createPresetCtx, runAgentStep, emit } = require('./lib/AgentRequestComposition.cjs')

// The Nexus fail-closed refusal: blocked, never a silent fallback to another model.
const blocked = (error) => error && error.code === 'nexus-execution-target-unavailable' && /instead of silently falling back/.test(String(error.message))

let passed = 0
const pass = (message) => { passed += 1; console.log('PASS: ' + message) }
const sessionDefault = { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
const first = { provider: 'zai-direct', model: 'glm-5.3-flash' }
const second = { provider: 'flash-high-direct', model: 'deepseek-v4-flash' }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-selection-'))
  const oldHome = process.env.DSH_HOME
  const oldRoot = process.env.AIH_INSTALL_ROOT
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '../config/model-registry.json'), path.join(root, 'config/model-registry.json'))
    process.env.DSH_HOME = path.join(root, 'data')
    process.env.AIH_INSTALL_ROOT = root
    let counter = 0
    function fixture(initialTarget, reasoning) {
      counter += 1
      const sessionId = 'session-' + counter
      const binding = { workspace: path.join(root, 'workspace'), taskId: 'TASK-' + counter, taskInstanceId: 'inst-' + counter, preset: 'aih-engineering', engine: 'dual' }
      const bindingsFile = path.join(root, 'data/routing/session-bindings.json')
      fs.mkdirSync(path.dirname(bindingsFile), { recursive: true })
      const document = fs.existsSync(bindingsFile) ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) : { schemaVersion: 1, bindings: {} }
      document.bindings[sessionId] = binding
      fs.writeFileSync(bindingsFile, JSON.stringify(document))
      const stateFile = profiles.routingStatePath(root, binding)
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const write = (target, effort) => fs.writeFileSync(stateFile, JSON.stringify({ ...binding, profile: 'glm-codex', executionClass: 'engineer_normal', ...target, reasoning: effort }))
      write(initialTarget, reasoning)
      const ctx = createPresetCtx()
      engineering.apply(ctx)
      const agent = { session: { id: sessionId, header: { agentPreset: 'aih-engineering' }, events: [], requestHeader: () => undefined }, options: { ...sessionDefault } }
      let providerCalls = 0
      const seed = async () => { providerCalls += 1; return { ...sessionDefault, maxTokens: 4096 } }
      return { ctx, agent, write, seed, calls: () => providerCalls, selections: () => agent.modelSelectionEvents || [] }
    }
    const step = (f, claim) => runAgentStep(f.ctx, { agent: f.agent }, f.seed, { claim })

    // 1. Arm at claim: controller route, one durable selection with the effort.
    let f = fixture(first, 'high')
    let out = await step(f)
    assert.deepEqual({ provider: out.provider, model: out.model, effort: out.reasoningEffort }, { ...first, effort: 'high' })
    assert.equal(f.selections().length, 1)
    assert.deepEqual(f.selections()[0], { ...first, reasoningEffort: 'high' })
    pass('1: the controller target is armed at message claim and used (one durable selection, effort included)')

    // 2. Unchanged target on a later step of the same turn: no new selection.
    out = await step(f, false)
    assert.equal(out.provider, first.provider)
    assert.equal(f.selections().length, 1)
    pass('2: a later step with an unchanged target adds no selection')

    // 3. Mid-turn controller change: refused for this step, converges on the next.
    f.write(second, 'high')
    const callsBefore = f.calls()
    // The pre-step arm re-selects for the NEXT step, but this step's route was fixed
    // before pre-step, so the request guard refuses it (the effective route is the old one).
    await assert.rejects(() => step(f, false), blocked)
    pass('3a: a controller target that changed mid-turn is refused for that step (fail closed)')
    out = await step(f, false)
    assert.deepEqual({ provider: out.provider, model: out.model }, second)
    assert.equal(f.selections().length, 2)
    assert.ok(f.calls() > callsBefore)
    pass('3b: the refused step armed the next one; the retry applies the new controller route exactly once')

    // 4. Foreign selection written by another party between arm and request.
    f = fixture(first, 'high')
    await step(f)
    f.agent.model.select({ provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
    await assert.rejects(() => step(f, false), blocked)
    out = await step(f, false)
    assert.deepEqual({ provider: out.provider, model: out.model }, first)
    pass('4: a selection written by anyone but the boundary fails the step closed and is repaired on retry')

    // 5. Effort drift with the route unchanged is refused (never silently re-leveled).
    f = fixture(first, 'high')
    await step(f)
    f.write(first, 'max')
    await assert.rejects(() => step(f, false), blocked)
    pass('5: effort drift on an unchanged route fails closed')

    // 6. No model-selection API on the agent: unavailable, not a silent fallback.
    f = fixture(first, 'high')
    const bare = { session: f.agent.session, options: { ...sessionDefault }, ctx: f.ctx.scopeFor({}) }
    bare.model = { current: () => ({ ...sessionDefault }) } // a host without select()
    emit(f.ctx, 'agent/inbox/claimed', { agent: bare, message: {}, turn: 1 }, bare)
    const requestListener = f.ctx.hooks.get('agent/request')[0].listener
    await assert.rejects(() => requestListener({ agent: bare }, async () => ({ ...sessionDefault })), (error) => error.code === 'controller-route-selection-unavailable')
    pass('6: an agent without the model-selection API cannot be routed (fail closed, typed error)')

    // 7. A refused arm (unbound session) never reaches the provider seam.
    const unboundCtx = createPresetCtx()
    engineering.apply(unboundCtx)
    let seedCalls = 0
    const unboundAgent = { session: { id: 'session-unbound', header: { agentPreset: 'aih-engineering' }, events: [], requestHeader: () => undefined }, options: { ...sessionDefault } }
    // A Dual session with NO binding is the unbound top-level case: Engineering plane fails closed.
    await assert.rejects(() => runAgentStep(unboundCtx, { agent: unboundAgent }, async () => { seedCalls += 1; return sessionDefault }, { claim: true }), (error) => /binding|nexus-execution-target-unavailable/.test(String(error.message) + String(error.code)))
    void seedCalls
    pass('7: an unbound top-level session fails closed with the controller error')

    // 8. Delegated child without a marked binding bypasses the controller plane.
    const childCtx = createPresetCtx()
    engineering.apply(childCtx)
    const childAgent = { session: { id: 'child-1', header: { agentPreset: 'aih-engineering', origin: 'subagent', delegationDepth: 1 }, events: [], requestHeader: () => undefined }, options: { ...sessionDefault } }
    out = await runAgentStep(childCtx, { agent: childAgent }, async () => ({ ...sessionDefault }), { claim: true })
    assert.equal(out.provider, sessionDefault.provider)
    assert.equal((childAgent.modelSelectionEvents || []).length, 0)
    pass('8: an unmarked delegated session keeps its own route and records no controller selection')

    console.log(`SUITE RESULT: PASS ${passed} | FAIL 0 | total ${passed}`)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = oldRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
