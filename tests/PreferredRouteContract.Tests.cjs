'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const engineering = require('../ui/nexus-controller/lib/engineering.cjs')
const profiles = require('../config/Engineering-Profiles.cjs')
const muse = require('../config/Muse-Isolation.cjs')
const { resolveAihPowerShellHost } = require('./lib/AihTestTransport.cjs')

const source = path.resolve(__dirname, '..')
const pwsh = resolveAihPowerShellHost(source)
function cli(script, args) {
  return JSON.parse(execFileSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(source, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, DSH_AIH_PROFILE: '', AIH_ACTIVE_PROFILE: '' } }))
}
function client(file) {
  let module
  const context = { window: { __ModuleLoader__: { load(def) { module = def.factory(() => ({})) } } } }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(source, 'ui', file, 'lib', 'client.js'), 'utf8'), context)
  return module
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-contract-'))
const workspace = path.join(root, 'workspace')
const data = path.join(root, 'data')
fs.mkdirSync(workspace)
fs.mkdirSync(data)
fs.cpSync(path.join(source, 'config'), path.join(root, 'config'), { recursive: true })
const controller = client('nexus-controller')
const selector = client('nexus-mode-selector')
const known = new Set(['aih-engineering', 'aih-deepseek', 'aih-muse'])

function webState(preferredId) {
  const template = fs.readFileSync(path.join(root, 'config', 'settings.yaml'), 'utf8')
  fs.writeFileSync(path.join(data, 'settings.yaml'), template.replace(/^engineering-profile:.*$/m, 'engineering-profile: ' + preferredId))
  const contract = cli('EngineeringProfile.ps1', ['-Action', 'get', '-InstallRoot', root])
  const built = engineering.buildEngineeringProfileState({ installRoot: root, dataRoot: data, profileContract: contract })
  const response = JSON.parse(JSON.stringify(built)) // actual Web serialization boundary
  assert.equal(response.preferredProfile.id, preferredId)
  assert.equal(response.preferredEngine, contract.preferredEngine)
  assert.deepEqual(response.preferredRoute, contract.preferredRoute)
  controller.publishNexusEngineState(response)
  const snapshot = controller.nexusEngineStateSnapshot()
  const preset = selector.resolveEnginePreset({ getSnapshot: () => snapshot }, known, 'aih-engineering')
  return { response, preset }
}

try {
  // A pre-Nexus catalog install still exposes the existing engineering editor.
  // Missing engine metadata cannot authorize or guess a Muse request route.
  const legacy = path.join(root, 'legacy')
  fs.mkdirSync(path.join(legacy, 'config'), { recursive: true })
  fs.mkdirSync(path.join(legacy, 'data'), { recursive: true })
  for (const name of ['engineering-profiles.json', 'model-registry.json', 'routing-policy.json']) {
    fs.copyFileSync(path.join(source, 'config', name), path.join(legacy, 'config', name))
  }
  fs.copyFileSync(path.join(source, 'config', 'settings.yaml'), path.join(legacy, 'data', 'settings.yaml'))
  const legacyState = cli('EngineeringProfile.ps1', ['-Action', 'get', '-InstallRoot', legacy])
  assert.ok(legacyState.roleRequirements, 'legacy editor requirements remain available without a Nexus catalog')
  assert.equal(legacyState.roleRequirements.visualReviewer.requiresVision, true)
  assert.equal(legacyState.preferredRoute, null)
  assert.deepEqual(legacyState.engineAgentPresets, {})
  console.log('PASS: legacy editor preserves role requirements without inventing engine authority')
  fs.writeFileSync(path.join(legacy, 'config', 'nexus-profiles.json'), '{')
  assert.throws(() => cli('EngineeringProfile.ps1', ['-Action', 'get', '-InstallRoot', legacy]),
    'a present but corrupt catalog must still fail closed')
  console.log('PASS: corrupt engine catalog still fails closed')

  for (const [id, provider] of [
    ['muse-spark-1.3-contributor-opencode', 'opencode-go'],
    ['muse-spark-1.3-contributor', 'meta-model-api'],
  ]) {
    const { response, preset } = webState(id)
    assert.equal(response.preferredEngine, 'muse')
    assert.equal(preset, 'aih-muse')
    assert.equal(response.preferredRoute.profileId, id)
    assert.equal(response.preferredRoute.provider, provider)
    assert.equal(response.preferredRoute.model, 'muse-spark-1.3-contributor')
    console.log('PASS: serialized Web contract maps ' + id + ' to aih-muse and ' + provider)
  }

  const dual = webState('deepseek-codex')
  assert.equal(dual.response.preferredEngine, 'dual')
  assert.equal(dual.preset, 'aih-engineering')
  assert.equal(selector.resolveEnginePreset({ getSnapshot: () => controller.nexusEngineStateSnapshot() }, known, 'aih-deepseek'), 'aih-deepseek')
  console.log('PASS: Dual and DeepSeek-only preset resolution')

  const broken = webState('muse-spark-1.3-contributor-opencode')
  broken.response.preferredRoute = null
  controller.publishNexusEngineState(broken.response)
  assert.equal(selector.resolveEnginePreset({ getSnapshot: () => controller.nexusEngineStateSnapshot() }, known, 'aih-engineering'), 'aih-engineering')
  console.log('PASS: missing route never guesses a Muse plane')

  // Complete persistence path: TaskController creates the immutable instance;
  // Routing.ps1 must bind the exact OpenCode route to that instance.
  webState('muse-spark-1.3-contributor-opencode')
  const task = cli('Task.ps1', ['-Action', 'create-task', '-Workspace', workspace, '-Description', 'hi', '-Engine', 'muse', '-ExecutionClass', 'muse_main'])
  const decision = cli('Route.ps1', ['-Description', 'hi', '-Workspace', workspace, '-TaskId', task.taskId, '-TaskInstanceId', task.taskInstanceId, '-Preset', 'aih-muse', '-RequestedEngine', 'muse', '-InstallRoot', root])
  const binding = { taskId: task.taskId, taskInstanceId: task.taskInstanceId, workspace, preset: 'aih-muse', engine: 'muse' }
  const state = JSON.parse(fs.readFileSync(profiles.routingStatePath(root, binding), 'utf8'))
  const reconstructed = muse.controllerTargetFor(root, binding)
  for (const item of [decision, state, reconstructed]) {
    assert.equal(item.profile, 'muse-spark-1.3-contributor-opencode')
    assert.equal(item.provider, 'opencode-go')
    assert.equal(item.model, 'muse-spark-1.3-contributor')
  }
  assert.equal(decision.taskId, task.taskId)
  assert.equal(decision.taskInstanceId, task.taskInstanceId)
  assert.equal(state.taskInstanceId, task.taskInstanceId)
  console.log('PASS: fresh task decision, persisted state, and request authority agree on OpenCode')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
