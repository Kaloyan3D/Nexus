'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const profiles = require('../config/Engineering-Profiles.cjs')
const muse = require('../config/Muse-Isolation.cjs')
const engineering = require('../config/Engineering-Isolation.cjs')

async function main() {
  const runtimeRoot = process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local', 'share', 'nexus')
  const agentFile = path.join(runtimeRoot, 'app/node_modules/@deepseek-ai/dsh-agent/lib/index.js')
  const { installModelSelection } = await import(pathToFileURL(agentFile).href)
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-matrix-'))
  const oldHome = process.env.DSH_HOME
  const oldRoot = process.env.AIH_INSTALL_ROOT
  let passed = 0
  try {
    fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '../config/model-registry.json'), path.join(installRoot, 'config/model-registry.json'))
    process.env.DSH_HOME = path.join(installRoot, 'data')
    process.env.AIH_INSTALL_ROOT = installRoot

    async function run(name, engine, target) {
      const sessionTarget = { provider: 'flash-max-direct', model: 'deepseek-v4-flash' }
      const sessionId = 'session-' + passed
      const preset = engine === 'muse' ? 'aih-muse' : 'aih-engineering'
      if (engine) {
        const binding = {
          workspace: path.join(installRoot, 'workspace'), taskId: 'TASK-' + passed,
          taskInstanceId: 'instance-' + passed, preset, engine,
        }
        const bindingsFile = path.join(installRoot, 'data/routing/session-bindings.json')
        fs.mkdirSync(path.dirname(bindingsFile), { recursive: true })
        const document = fs.existsSync(bindingsFile)
          ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))
          : { schemaVersion: 1, bindings: {} }
        document.bindings[sessionId] = binding
        fs.writeFileSync(bindingsFile, JSON.stringify(document))
        const stateFile = profiles.routingStatePath(installRoot, binding)
        fs.mkdirSync(path.dirname(stateFile), { recursive: true })
        fs.writeFileSync(stateFile, JSON.stringify({
          ...binding, profile: engine === 'muse' ? 'muse-spark-1.3-contributor' : 'glm-codex',
          executionClass: engine === 'muse' ? 'muse_main' : 'engineer_normal',
          ...target, reasoning: 'high',
        }))
      }
      const hooks = new Map()
      const ctx = {
        on(event, handler) {
          const entries = hooks.get(event) || []
          entries.push(handler)
          hooks.set(event, entries)
          return () => {}
        },
        shellEnv: { register() {} },
      }
      installModelSelection(ctx, { current: { ...sessionTarget, reasoningEffort: 'max' }, assembled: undefined })
      if (engine === 'muse') muse.apply(ctx)
      if (engine === 'dual') engineering.apply(ctx)
      await hooks.get('system-prompt/assemble')[0]({}, {}, async () => ({ variables: {} }))
      const payload = { agent: { session: { id: sessionId, header: { agentPreset: preset }, events: [] } } }
      const handlers = hooks.get('agent/request')
      async function next(index) {
        return index === handlers.length
          ? { provider: 'default', model: 'default-model', reasoningEffort: 'low', maxTokens: 32768 }
          : handlers[index](payload, () => next(index + 1))
      }
      const actual = await next(0)
      const expected = target || sessionTarget
      assert.equal(actual.provider, expected.provider)
      assert.equal(actual.model, expected.model)
      passed += 1
      console.log(`PASS: ${name}: ${actual.provider} / ${actual.model}`)
    }

    await run('Muse OpenCode Go beats DeepSeek session', 'muse', { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' })
    await run('Muse direct beats DeepSeek session', 'muse', { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' })
    await run('Dual GLM beats DeepSeek session', 'dual', { provider: 'zai-direct', model: 'glm-5.3-flash' })
    await run('Matching DeepSeek controller', 'dual', { provider: 'flash-max-direct', model: 'deepseek-v4-flash' })
    await run('Session-only selection', null, null)
    console.log(`SUITE RESULT: PASS ${passed} | FAIL 0 | total ${passed}`)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = oldRoot
    fs.rmSync(installRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
