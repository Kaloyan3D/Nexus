'use strict'

/**
 * MuseIsolation.Tests.cjs — Phase M3 (TASK-0040) coverage for the Muse V0
 * request boundary (config/Muse-Isolation.cjs).
 *
 * Fully OFFLINE: every scenario runs against fixture data roots on disk.
 *
 * Layers covered:
 *   - controllerTargetFor: the one target authority (controller state only),
 *     the muse-engine invariant, and every fail-closed branch.
 *   - The agent/request handler: exact provider/model/reasoning enforcement,
 *     the Nexus V0 maxTokens cap, and NO worker exemption.
 *   - The DSH_AIH_PRESET shellEnv registration for the muse plane.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const { createPresetCtx } = require('./lib/AgentRequestComposition.cjs')
const isolation = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'))

let passed = 0
function pass(name) { passed++; console.log('PASS: ' + name) }

function makeFixture() {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-iso-'))
  fs.mkdirSync(path.join(installRoot, 'data', 'routing', 'states'), { recursive: true })
  // Phase 2: the adaptive request boundary resolves capabilities from the
  // real model registry, so the fixture stages the production registry.
  fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true })
  fs.copyFileSync(
    path.join(repoRoot, 'config', 'model-registry.json'),
    path.join(installRoot, 'config', 'model-registry.json'),
  )
  return installRoot
}

function statePathFor(installRoot, binding) {
  const resolvedWorkspace = path.resolve(binding.workspace)
  const workspace = process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace
  const preset = String(binding.preset || 'aih-muse').toLowerCase()
  const identity = binding.taskInstanceId || String(binding.taskId || '')
  const key = workspace + '\n' + preset + '\n' + identity
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex')
  return path.join(installRoot, 'data', 'routing', 'states', hash + '.json')
}

function writeState(installRoot, binding, state) {
  fs.writeFileSync(statePathFor(installRoot, binding), JSON.stringify(state), 'utf8')
}

function writeBindings(installRoot, sessionId, binding) {
  const bindingsPath = path.join(installRoot, 'data', 'routing', 'session-bindings.json')
  let document = { schemaVersion: 1, bindings: {} }
  try { document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')) } catch { /* fresh fixture */ }
  document.bindings = document.bindings || {}
  document.bindings[sessionId] = Object.assign({ engine: 'muse' }, binding)
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true })
  fs.writeFileSync(bindingsPath, JSON.stringify(document), 'utf8')
}

function museState(overrides) {
  return Object.assign({
    taskId: 'TASK-4001',
    preset: 'aih-muse',
    engine: 'muse',
    executionClass: 'muse_main',
    role: null,
    profile: 'muse-spark-1.3-contributor',
    profileDisplayName: 'Muse Spark 1.3 Contributor',
    provider: 'meta-model-api',
    model: 'muse-spark-1.3-contributor',
    modelDisplayName: 'Muse Spark 1.3 Contributor',
    reasoning: 'xhigh',
    dataUseTier: 'contributor',
  }, overrides || {})
}

function makeCtx() {
  const registrations = []
  return createPresetCtx({
    registrations,
    shellEnv: { register: (definition) => { registrations.push(definition) } },
  })
}

async function runRequest(ctx, session, proposed, nextImpl) {
  const handler = ctx.handlers['agent/request']
  assert.ok(handler, 'agent/request handler registered')
  return handler({ agent: { session } }, nextImpl || (async () => proposed))
}

async function main() {
  const previousHome = process.env.DSH_HOME
  const previousInstallRoot = process.env.AIH_INSTALL_ROOT
  try {
    // ── 1. The output bound is the documented V0 constant ───────────────────
    assert.equal(isolation.MUSE_V0_MAX_OUTPUT_TOKENS, 32768)
    pass('1: Nexus V0 effective max output tokens is 32768 (vendor hard max is a separate, larger number)')

    // ── 2. controllerTargetFor enforces the exact controller target ─────────
    const installRoot = makeFixture()
    process.env.DSH_HOME = path.join(installRoot, 'data')
    process.env.AIH_INSTALL_ROOT = installRoot
    const binding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-4001', preset: 'aih-muse', taskInstanceId: 'inst-1' }
    writeBindings(installRoot, 'sess-muse', binding)
    writeState(installRoot, binding, museState())
    const target = isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-muse'))
    assert.equal(target.provider, 'meta-model-api')
    assert.equal(target.model, 'muse-spark-1.3-contributor')
    assert.equal(target.reasoning, 'xhigh')
    assert.equal(target.profile, 'muse-spark-1.3-contributor')
    assert.equal(target.engine, 'muse')
    assert.equal(target.dataUseTier, 'contributor')
    assert.equal('contributorProtectionRequired' in target, false)
    assert.equal(target.source, 'routing-state')
    pass('2: controllerTargetFor enforces the complete controller-produced muse target')

    // ── 3. Fail closed: no binding / no state ───────────────────────────────
    assert.throws(() => isolation.controllerTargetFor(installRoot, null), (error) => error.code === 'nexus-execution-target-unavailable')
    pass('3a: missing session binding fails closed')
    writeBindings(installRoot, 'sess-ghost', { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-NOPE', preset: 'aih-muse' })
    assert.throws(() => isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-ghost')), (error) => error.code === 'nexus-execution-target-unavailable')
    pass('3b: missing routing state fails closed')

    // ── 4. Fail closed: the state must BE a muse-engine state ───────────────
    // 4a. A legacy/Dual state predating the engine field (engine missing).
    const legacyBinding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-LEGACY', preset: 'aih-muse', taskInstanceId: 'inst-2' }
    writeBindings(installRoot, 'sess-legacy', legacyBinding)
    writeState(installRoot, legacyBinding, museState({ engine: undefined }))
    delete legacyBinding.engine
    assert.throws(
      () => isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-legacy')),
      (error) => error.code === 'nexus-muse-engine-mismatch',
    )
    pass('4a: legacy state without an engine field fails closed (nexus-muse-engine-mismatch)')
    // 4b. An explicit Dual engine on the muse plane.
    const dualBinding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-DUAL', preset: 'aih-muse', taskInstanceId: 'inst-3' }
    writeBindings(installRoot, 'sess-dual', dualBinding)
    writeState(installRoot, dualBinding, museState({ engine: 'dual', role: 'primaryEngineer', provider: 'flash-high-direct', model: 'deepseek-v4-flash' }))
    assert.throws(
      () => isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-dual')),
      (error) => error.code === 'nexus-muse-engine-mismatch',
    )
    pass('4b: a Dual routing state on the muse plane fails closed')

    // ── 5. Fail closed: incomplete target (never a fallback) ────────────────
    for (const [field, label] of [['provider', 'provider'], ['model', 'model'], ['reasoning', 'reasoning']]) {
      const broken = museState()
      delete broken[field]
      const brokenBinding = { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-BROKEN-' + field, preset: 'aih-muse', taskInstanceId: 'inst-' + field }
      writeBindings(installRoot, 'sess-broken-' + field, brokenBinding)
      writeState(installRoot, brokenBinding, broken)
      assert.throws(
        () => isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-broken-' + field)),
        (error) => error.code === 'nexus-execution-target-unavailable',
      )
      pass('5.' + label + ': incomplete routing target (no ' + label + ') fails closed')
    }

    // ── 6. The request handler enforces the target and caps maxTokens ───────
    const ctx = makeCtx()
    isolation.apply(ctx)
    assert.equal(ctx.registrations.length, 1, 'shellEnv registration present')
    const session = { id: 'sess-muse', events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: { agentPreset: 'aih-engineering' } }
    const enforced = await runRequest(ctx, session, {
      provider: 'flash-max-direct',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      maxTokens: 131072,
      tools: [{ name: 'read' }],
    })
    assert.equal(enforced.provider, 'meta-model-api')
    assert.equal(enforced.model, 'muse-spark-1.3-contributor')
    // Phase 2 (spec change, TASK-0049): the Governor owns the per-call
    // effort. A routing state without a museReasoning block initializes to
    // the discover phase, so the enforced effort is medium -- the legacy
    // profile-default xhigh no longer passes through untouched.
    assert.equal(enforced.reasoningEffort, 'medium')
    assert.equal(enforced.maxTokens, 32768)
    assert.ok(Object.isFrozen(enforced))
    pass('6: request boundary enforces the muse target (adaptive medium) and caps vendor 131072 at the 32768 V0 bound')

    const guardSymbol = Symbol.for('nexus.museContributorPayloadGuard.v1')
    assert.equal(globalThis[guardSymbol], undefined)
    const toolOutput = 'git diff --binary\0GIT binary patch\nliteral 3\nYWJj\nbase64-like: SGVsbG8gV29ybGQ='
    const outputRequest = await runRequest(ctx, session, {
      provider: 'x',
      model: 'y',
      reasoningEffort: 'max',
      messages: [{ role: 'tool', content: toolOutput }],
    })
    assert.equal(outputRequest.messages[0].content, toolOutput)
    assert.equal(globalThis[guardSymbol], undefined)
    pass('6a: normal Git/tool output passes byte-for-byte without installing a contributor payload guard')
    const smaller = await runRequest(ctx, session, { provider: 'x', model: 'y', reasoningEffort: 'max', maxTokens: 1024 })
    assert.equal(smaller.maxTokens, 1024)
    pass('6b: the V0 bound is a ceiling — a smaller requested bound passes through')
    const unbounded = await runRequest(ctx, session, { provider: 'x', model: 'y', reasoningEffort: 'max' })
    assert.equal(unbounded.maxTokens, 32768)
    pass('6c: a request without maxTokens gets the deterministic 32768 bound')

    // ── 7. No worker exemption: every request on the plane is the one agent ─
    const workerSession = Object.assign({}, session, { header: { agentPreset: 'aih-muse', origin: 'subagent', delegationDepth: 3 } })
    const workerEnforced = await runRequest(ctx, workerSession, { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max', maxTokens: 131072 })
    assert.equal(workerEnforced.provider, 'meta-model-api')
    assert.equal(workerEnforced.maxTokens, 32768)
    pass('7: worker-shaped requests are NOT exempted — the muse plane has no workers')

    // ── 8. Non-muse sessions pass through untouched ─────────────────────────
    const dualSession = { id: 'sess-other', events: [], header: { agentPreset: 'aih-engineering' } }
    const untouched = await runRequest(ctx, dualSession, { provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 4096 })
    assert.equal(untouched.provider, 'flash-high-direct')
    assert.equal(untouched.maxTokens, 4096)
    pass('8: a non-muse session is not modified by the muse boundary')
    writeBindings(installRoot, 'sess-bound-dual', { workspace: path.join(installRoot, 'ws'), taskId: 'TASK-BOUND-DUAL', preset: 'aih-engineering', taskInstanceId: 'inst-dual', engine: 'dual' })
    const changedToMuse = { id: 'sess-bound-dual', events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: { agentPreset: 'aih-engineering' } }
    await assert.rejects(() => runRequest(ctx, changedToMuse, {}), (error) => error.code === 'engine-binding-violation')
    const changedToDual = { id: 'sess-muse', events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-engineering' } }], header: { agentPreset: 'aih-muse' } }
    await assert.rejects(() => runRequest(ctx, changedToDual, {}), (error) => error.code === 'engine-binding-violation')
    pass('8b: changing either bound session to the other engine fails closed before request execution')

    // ── 9. Headerless/unknown session fails closed on the muse plane ────────
    await assert.rejects(() => runRequest(ctx, null, {}), (error) => error.code === 'nexus-execution-target-unavailable')
    pass('9a: a request without a session fails closed')
    const unboundSession = { id: 'sess-unbound', events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: {} }
    await assert.rejects(() => runRequest(ctx, unboundSession, {}), (error) => error.code === 'nexus-execution-target-unavailable')
    pass('9b: a muse-plane session without a controller binding fails closed (API-created sessions are visible, never silently wrong tools)')

    // ── 10. shellEnv publishes DSH_AIH_PRESET for muse sessions only ────────
    const registration = ctx.registrations[0]
    assert.equal(registration.name, 'aih-muse-preset')
    const execution = { agent: { session } }
    const variables = registration.resolve(execution)
    assert.equal(variables.DSH_AIH_PRESET, 'aih-muse')
    const dualVariables = registration.resolve({ agent: { session: dualSession } })
    assert.deepEqual(dualVariables, {})
    assert.deepEqual(registration.resolve({}), {})
    pass('10: shellEnv publishes DSH_AIH_PRESET=aih-muse exactly for muse-plane sessions')

    // ── 11. Session preset resolution: events win over stale headers ────────
    assert.equal(isolation.sessionPreset(session), 'aih-muse')
    assert.equal(isolation.sessionPreset(dualSession), 'aih-engineering')
    const headerOnly = { id: 'h', events: [], header: { agentPreset: 'aih-muse' } }
    assert.equal(isolation.sessionPreset(headerOnly), 'aih-muse')
    pass('11: sessionPreset resolves the recomposed plane from events, falling back to the header')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousInstallRoot
  }

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
}

main().then(
  () => { /* harness reads the SUITE RESULT line */ },
  (error) => {
    console.error('SUITE RESULT: PASS ' + passed + ' | FAIL 1 | total ' + (passed + 1))
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
  },
)
