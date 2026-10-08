'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const profiles = require('../config/Engineering-Profiles.cjs')
const integrity = require('../config/Routing-Integrity.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-integrity-'))
const previousHome = process.env.DSH_HOME
const previousRoot = process.env.AIH_INSTALL_ROOT
let passed = 0

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function addBinding(sessionId, engine, provider, model) {
  const binding = {
    taskId: 'TASK-' + sessionId, taskInstanceId: 'instance-' + sessionId,
    workspace: path.join(root, 'workspace'), preset: engine === 'muse' ? 'aih-muse' : 'aih-engineering', engine,
  }
  const file = path.join(root, 'data', 'routing', 'session-bindings.json')
  const document = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schemaVersion: 1, bindings: {} }
  document.bindings[sessionId] = binding
  writeJson(file, document)
  writeJson(profiles.routingStatePath(root, binding), {
    ...binding, profile: engine === 'muse' ? 'muse-spark-1.3-contributor' : 'glm-codex',
    executionClass: engine === 'muse' ? 'muse_main' : 'engineer_normal',
    provider, model, reasoning: 'high',
  })
  return binding
}

function pass(name) { passed += 1; console.log('PASS: ' + name) }

try {
  process.env.DSH_HOME = path.join(root, 'data')
  process.env.AIH_INSTALL_ROOT = root
  const hooks = new Map()
  integrity.apply({ on(name, handler) { hooks.set(name, handler) } })
  const gate = hooks.get('llm/stream')
  assert.equal(typeof gate, 'function')
  let transports = 0
  const transport = () => { transports += 1; return 'sent' }

  const muse = addBinding('session-muse', 'muse', 'opencode-go', 'muse-spark-1.3-contributor')
  assert.equal(gate({ sessionId: 'session-muse', provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }, transport), 'sent')
  pass('Muse OpenCode Go controller target reaches transport')
  assert.throws(
    () => gate({ sessionId: 'session-muse', provider: 'flash-max-direct', model: 'deepseek-v4-flash' }, transport),
    (error) => error.code === 'nexus-routing-integrity-violation' && error.message.includes(muse.taskId),
  )
  assert.equal(transports, 1)
  pass('corruption after Muse routing aborts before transport')
  let deferredTransports = 0
  const laterRequest = { sessionId: 'session-muse', provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }
  assert.throws(() => gate(laterRequest, () => {
    laterRequest.provider = 'flash-max-direct'
    laterRequest.model = 'deepseek-v4-flash'
    return (async function* () { deferredTransports += 1; yield 'sent' })()
  }), { code: 'nexus-routing-integrity-violation' })
  assert.equal(deferredTransports, 0)
  pass('later middleware corruption is rejected before stream iteration')

  addBinding('session-glm', 'dual', 'zai-direct', 'glm-5.3-flash')
  assert.equal(gate({ sessionId: 'session-glm', provider: 'zai-direct', model: 'glm-5.3-flash' }, transport), 'sent')
  assert.throws(() => gate({ sessionId: 'session-glm', provider: 'flash-max-direct', model: 'deepseek-v4-flash' }, transport), { code: 'nexus-routing-integrity-violation' })
  assert.equal(transports, 2)
  pass('Dual GLM route is protected from the same overwrite')

  addBinding('session-deepseek', 'dual', 'flash-max-direct', 'deepseek-v4-flash')
  assert.equal(gate({ sessionId: 'session-deepseek', provider: 'flash-max-direct', model: 'deepseek-v4-flash' }, transport), 'sent')
  pass('matching DeepSeek route continues unchanged')
  assert.equal(gate({ sessionId: 'session-muse', purpose: 'session-title', provider: 'flash-max-direct', model: 'deepseek-v4-flash' }, transport), 'sent')
  pass('auxiliary title inference remains outside task-step routing')

  fs.writeFileSync(path.join(root, 'data', 'routing', 'session-bindings.json'), '{broken')
  assert.throws(() => gate({ sessionId: 'session-muse', provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }, transport))
  assert.equal(transports, 4)
  pass('corrupt binding registry aborts before transport')

  fs.writeFileSync(path.join(root, 'data', 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }))
  let missingBindingGate
  integrity.apply({
    sessions: { get() { return { header: { agentPreset: 'aih-muse' } } } },
    on(_name, handler) { missingBindingGate = handler },
  })
  assert.throws(() => missingBindingGate({ sessionId: 'session-muse', provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }, transport), { code: 'nexus-routing-integrity-violation' })
  assert.equal(transports, 4)
  pass('missing binding for a controller preset aborts before transport')

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot
  fs.rmSync(root, { recursive: true, force: true })
}
