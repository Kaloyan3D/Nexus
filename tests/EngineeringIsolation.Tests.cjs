'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const isolation = require('../config/Engineering-Isolation.cjs')
const profiles = require('../config/Engineering-Profiles.cjs')

let passed = 0
function pass(name) {
  passed += 1
  console.log('PASS: ' + name)
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function writeBinding(root, binding) {
  writeJson(path.join(root, 'data', 'routing', 'session-bindings.json'), {
    schemaVersion: 1,
    bindings: { [binding.sessionId]: binding },
  })
}

function writeRoutingState(root, binding, value) {
  const statePath = profiles.routingStatePath(root, binding)
  writeJson(statePath, value)
  return statePath
}

function writeStep(workspace, taskId, record) {
  const filePath = path.join(workspace, '.ai-harness', 'runs', taskId, 'step-routing.jsonl')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-isolation-'))
  const dataRoot = path.join(root, 'data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })

  const savedDshHome = process.env.DSH_HOME
  const savedInstallRoot = process.env.AIH_INSTALL_ROOT
  process.env.DSH_HOME = dataRoot
  process.env.AIH_INSTALL_ROOT = root

  try {
    const binding = {
      sessionId: 'session-glm',
      taskId: 'TASK-0001',
      taskInstanceId: 'task_11111111111111111111111111111111',
      workspace,
      preset: 'aih-engineering',
      executionClass: 'engineer_normal',
    }
    writeBinding(root, binding)
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

    let requestHandler = null
    const ctx = {
      on(name, handler) {
        if (name === 'agent/request') requestHandler = handler
      },
    }
    isolation.apply(ctx)
    assert.equal(typeof requestHandler, 'function')

    const session = {
      id: binding.sessionId,
      header: { agentPreset: 'aih-engineering', cwd: workspace },
      events: [],
    }
    const upstreamDeepSeek = {
      provider: 'flash-max-direct',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      temperature: 0,
    }

    const routed = await requestHandler({ agent: { session } }, async () => upstreamDeepSeek)
    assert.equal(routed.provider, 'zai-direct')
    assert.equal(routed.model, 'glm-5.3-flash')
    assert.equal(routed.reasoningEffort, 'high')
    assert.equal(routed.temperature, 0)
    pass('controller routing target overrides the upstream DeepSeek default at the actual agent/request boundary')

    // Step routing is the current-turn authority. A Deep step may legitimately
    // differ from the task-level Normal target; the already-resolved roleTarget
    // must be enforced verbatim, with no second profile/model resolution.
    const statePath = profiles.routingStatePath(root, binding)
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.stepRole = 'engineer_deep'
    writeJson(statePath, state)
    writeStep(workspace, binding.taskId, {
      recordVersion: 1,
      taskId: binding.taskId,
      taskInstanceId: binding.taskInstanceId,
      stepId: 'step-deep',
      selectedRole: 'engineer_deep',
      roleTarget: {
        role: 'deepEngineer',
        profileId: 'glm-codex',
        profileDisplayName: 'GLM + Codex',
        provider: 'zai-direct',
        model: 'glm-5.3',
        modelDisplayName: 'GLM-5.3',
        vendor: 'Z.ai',
        reasoning: 'max',
      },
    })
    const deep = await requestHandler({ agent: { session } }, async () => upstreamDeepSeek)
    assert.equal(deep.provider, 'zai-direct')
    assert.equal(deep.model, 'glm-5.3')
    assert.equal(deep.reasoningEffort, 'max')
    pass('current step roleTarget is the single execution target for Deep/Normal step routing')

    // A role change without its controller-resolved step target is unsafe.
    // The old implementation silently fell back to DeepSeek MAX here; the new
    // contract must reject the request instead.
    fs.rmSync(path.join(workspace, '.ai-harness', 'runs', binding.taskId, 'step-routing.jsonl'), { force: true })
    await assert.rejects(
      () => requestHandler({ agent: { session } }, async () => upstreamDeepSeek),
      (error) => error && error.code === 'nexus-execution-target-unavailable' && /step-target-missing-for-role-change/.test(error.message),
    )
    pass('missing target for a changed step role fails closed instead of silently falling back to DeepSeek')

    // Missing controller state is also fatal for a top-level engineering
    // request: there is no second resolver and no hidden provider fallback.
    fs.rmSync(statePath, { force: true })
    await assert.rejects(
      () => requestHandler({ agent: { session } }, async () => upstreamDeepSeek),
      (error) => error && error.code === 'nexus-execution-target-unavailable' && /missing-routing-state/.test(error.message),
    )
    pass('missing routing state blocks top-level execution instead of choosing an unrelated default model')

    // Subagents remain owned by delegation configuration and bypass the root
    // engineering enforcement layer exactly as before.
    const workerSession = {
      id: 'worker',
      header: { origin: 'subagent', delegationDepth: 1, agentPreset: 'aih-engineering', cwd: workspace },
      events: [],
    }
    const worker = await requestHandler({ agent: { session: workerSession } }, async () => upstreamDeepSeek)
    assert.deepEqual(worker, upstreamDeepSeek)
    pass('subagent execution remains untouched by root engineering target enforcement')

    console.log(`RESULT: ${passed} Engineering-Isolation assertions passed.`)
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedInstallRoot === undefined) delete process.env.AIH_INSTALL_ROOT
    else process.env.AIH_INSTALL_ROOT = savedInstallRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('FAIL: ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
