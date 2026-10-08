'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const isolation = require('../config/DeepSeek-Isolation.cjs')
const engineeringIsolation = require('../config/Engineering-Isolation.cjs')
const profiles = require('../config/Engineering-Profiles.cjs')
const { createPresetCtx } = require('./lib/AgentRequestComposition.cjs')

let passed = 0
function pass(name) {
  passed += 1
  console.log('PASS: ' + name)
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

// Realistic controller-format fixture writers (the SAME files and document
// shapes the deterministic controller plane produces). Nothing here mocks
// controllerTargetFor or bindingFor: the enforcement handler below exercises
// the real binding and routing-state resolution against this fixture state.
function writeBinding(root, binding) {
  writeJson(path.join(root, 'data', 'routing', 'session-bindings.json'), {
    schemaVersion: 1,
    bindings: { [binding.sessionId]: Object.assign({ engine: 'dual' }, binding) },
  })
}

function writeRoutingState(root, binding, value) {
  writeJson(profiles.routingStatePath(root, binding), Object.assign({ engine: 'dual' }, value))
}

async function main() {
  // ── DeepSeek-only plugin: self-contained preset enforcement ──────────────
  // This plugin reads no ambient state (no settings.yaml, no profile env, no
  // install root), so these assertions are hermetic by construction.
  const handlers = {}
  let contributor
  isolation.apply({
    on(name, handler) { handlers[name] = handler },
    shellEnv: { register(value) { contributor = value } },
  })
  assert.equal(isolation.inject[0], 'shellEnv')
  const deepSession = { header: { agentPreset: 'aih-deepseek' }, events: [] }
  const normalSession = { header: { agentPreset: 'aih-engineering' }, events: [] }
  assert.equal(contributor.resolve({ agent: { session: deepSession } }).DSH_AIH_PRESET, 'aih-deepseek')
  assert.deepEqual(contributor.resolve({ agent: { session: normalSession } }), {})
  assert.deepEqual(contributor.resolve({ agent: { session: { header: { agentPreset: 'aih-deepseek' }, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-engineering' } }] } } }), {})

  const worker = { agent: { session: { header: { origin: 'subagent', delegationDepth: 1 } } } }
  const sol = { provider: 'sol-local', model: 'gpt-5.6-sol', reasoningEffort: 'medium' }
  const flashMax = { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
  const proHigh = { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

  const replacedSol = await handlers['agent/request']({ agent: { session: deepSession } }, async () => sol)
  assert.deepEqual({ provider: replacedSol.provider, model: replacedSol.model, reasoningEffort: replacedSol.reasoningEffort }, { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  const replacedTopFlash = await handlers['agent/request']({ agent: { session: normalSession } }, async () => flashMax)
  assert.equal(replacedTopFlash.provider, 'flash-max-direct')
  const retainedTopHigh = await handlers['agent/request']({ agent: { session: normalSession } }, async () => proHigh)
  assert.equal(retainedTopHigh.provider, 'flash-max-direct')
  const retainedWorker = await handlers['agent/request'](worker, async () => flashMax)
  assert.equal(retainedWorker.provider, 'flash-max-direct')

  const engineeringCtx = createPresetCtx()
  delete engineeringCtx.shellEnv
  engineeringIsolation.apply(engineeringCtx)
  const engineeringHandlers = engineeringCtx.handlers
  assert.equal(engineeringIsolation.inject, undefined)

  // ── Engineering enforcement: controller-owned targets, fail-closed ───────
  //
  // MODEL SELECTION HAS ONE AUTHORITY: the deterministic controller plane.
  // Routing.ps1 / Engineering StepRouting persist the resolved target in
  // controller state; Engineering-Isolation only ENFORCES that target at the
  // agent/request boundary and FAILS CLOSED when the controller did not
  // produce one. There is no profile fallback and no default-model fallback:
  // an unbound top-level engineering session must be blocked, never silently
  // routed to an unrelated model while the UI reports the requested profile.
  //
  // The fixture below binds a session the way the controller does
  // (data/routing/session-bindings.json + the hashed routing-state document
  // under data/routing/states/), entirely inside a temp install root. The
  // environment is restored afterwards and nothing outside the fixture is
  // read - no live ~/.local/share/nexus/data state, no credentials, no
  // network.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-deepseek-isolation-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })

  const savedDshHome = process.env.DSH_HOME
  const savedInstallRoot = process.env.AIH_INSTALL_ROOT
  process.env.DSH_HOME = path.join(root, 'data')
  process.env.AIH_INSTALL_ROOT = root

  try {
    // An unbound top-level engineering session FAILS CLOSED. This covers both
    // realistic unbound shapes: a session with an id the controller never
    // bound, and the legacy no-id session shape. The reason carried in the
    // message must be the missing session binding - execution is blocked
    // instead of silently falling back to another model.
    const unboundRequestId = { agent: { session: { id: 'session-never-bound', header: {} } } }
    await assert.rejects(
      () => engineeringHandlers['agent/request'](unboundRequestId, async () => flashMax),
      (error) => error
        && error.code === 'nexus-execution-target-unavailable'
        && /missing-session-binding/.test(error.message)
        && /Execution was blocked instead of silently falling back/.test(error.message),
    )
    pass('an unbound top-level engineering session fails closed with missing-session-binding')

    const unboundNoId = { agent: { session: { header: {} } } }
    await assert.rejects(
      () => engineeringHandlers['agent/request'](unboundNoId, async () => flashMax),
      (error) => error
        && error.code === 'nexus-execution-target-unavailable'
        && /missing-session-binding/.test(error.message),
    )
    pass('a top-level engineering session without a controller binding id fails closed the same way')

    // Realistic BOUND session: session.id -> controller session binding ->
    // controller-resolved routing-state target, through the production files.
    const binding = {
      sessionId: 'session-bound-001',
      taskId: 'TASK-0001',
      taskInstanceId: 'task_11111111111111111111111111111111',
      workspace,
      preset: 'aih-engineering',
      executionClass: 'engineer_normal',
    }
    writeBinding(root, binding)
    // The routing-state target is deliberately NOT a DeepSeek default: only
    // the real controller state resolution can produce this target, so the
    // assertion proves the enforcement path, never a hidden fallback.
    writeRoutingState(root, binding, {
      taskId: binding.taskId,
      taskInstanceId: binding.taskInstanceId,
      workspace,
      preset: binding.preset,
      executionClass: 'engineer_normal',
      role: 'primaryEngineer',
      profile: 'glm-codex',
      profileDisplayName: 'GLM + Codex',
      provider: 'zai-direct',
      model: 'glm-5.3-flash',
      modelDisplayName: 'GLM-5.3-Flash',
      reasoning: 'high',
    })

    const boundSession = {
      id: binding.sessionId,
      header: { agentPreset: 'aih-engineering', cwd: workspace },
      events: [],
    }
    const upstreamDeepSeek = { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max', temperature: 0 }
    const routed = await engineeringHandlers['agent/request']({ agent: { session: boundSession } }, async () => upstreamDeepSeek)
    assert.deepEqual(
      { provider: routed.provider, model: routed.model, reasoningEffort: routed.reasoningEffort },
      { provider: 'zai-direct', model: 'glm-5.3-flash', reasoningEffort: 'high' },
    )
    assert.equal(routed.temperature, 0)
    pass('the bound top-level request resolves to the controller-owned routing-state target')

    // Worker (subagent) requests keep bypassing top-level enforcement: their
    // models are configured by delegation rows, and an unbound worker must
    // pass through untouched (no binding lookup, no enforcement, no error).
    const workerSession = {
      id: 'worker-unbound',
      header: { origin: 'subagent', delegationDepth: 1, agentPreset: 'aih-engineering', cwd: workspace },
      events: [],
    }
    const workerProposed = await engineeringHandlers['agent/request']({ agent: { session: workerSession } }, async () => upstreamDeepSeek)
    assert.deepEqual(workerProposed, upstreamDeepSeek)
    pass('subagent requests continue to bypass top-level engineering enforcement')

    let fallbackCalled = false
    const retry = await handlers['agent/request-error']({ provider: 'deepseek-pro-direct' }, async () => { fallbackCalled = true; return { kind: 'retry' } })
    assert.equal(retry, undefined)
    assert.equal(fallbackCalled, false)

    assert.equal(handlers['llm/stream'], undefined)

    console.log('RESULT: ' + passed + ' DeepSeek/engineering isolation assertions passed.')
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT
    else process.env.AIH_INSTALL_ROOT = savedInstallRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
