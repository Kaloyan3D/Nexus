'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const profiles = require('../config/Engineering-Profiles.cjs')
const muse = require('../config/Muse-Isolation.cjs')

async function main() {
  const runtimeRoot = process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local', 'share', 'nexus')
  const dshAgent = path.join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh-agent', 'lib', 'index.js')
  const { installModelSelection } = await import(pathToFileURL(dshAgent).href)
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-composed-route-'))
  const previousHome = process.env.DSH_HOME
  const previousRoot = process.env.AIH_INSTALL_ROOT
  try {
    fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'model-registry.json'), path.join(installRoot, 'config', 'model-registry.json'))
    const binding = {
      workspace: path.join(installRoot, 'workspace'),
      taskId: 'TASK-0009', taskInstanceId: 'test-instance', preset: 'aih-muse', engine: 'muse',
    }
    const state = {
      ...binding, profile: 'muse-spark-1.3-contributor-opencode',
      provider: 'opencode-go', model: 'muse-spark-1.3-contributor', reasoning: 'high',
    }
    const routing = path.join(installRoot, 'data', 'routing')
    fs.mkdirSync(routing, { recursive: true })
    fs.writeFileSync(path.join(routing, 'session-bindings.json'), JSON.stringify({
      schemaVersion: 1, bindings: { 'session-muse': binding },
    }))
    const statePath = profiles.routingStatePath(installRoot, binding)
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(state))
    process.env.DSH_HOME = path.join(installRoot, 'data')
    process.env.AIH_INSTALL_ROOT = installRoot

    const hooks = new Map()
    const ctx = {
      on(name, listener) {
        const entries = hooks.get(name) || []
        entries.push(listener)
        hooks.set(name, entries)
        return () => {}
      },
      shellEnv: { register() {} },
    }
    const selection = {
      current: { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      assembled: undefined,
    }
    installModelSelection(ctx, selection)
    muse.apply(ctx)
    await hooks.get('system-prompt/assemble')[0]({}, {}, async () => ({ variables: {} }))
    const session = { id: 'session-muse', header: { agentPreset: 'aih-muse' }, events: [] }
    let payload = { agent: { session } }
    const handlers = hooks.get('agent/request')
    async function next(index) {
      return index === handlers.length
        ? { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max', maxTokens: 32768 }
        : handlers[index](payload, () => next(index + 1))
    }
    const finalRequest = await next(0)
    assert.equal(finalRequest.provider, 'opencode-go')
    assert.equal(finalRequest.model, 'muse-spark-1.3-contributor')
    console.log('PASS: composed DSH session selection preserves the Muse controller target')
    ctx.on('agent/request', async (laterPayload, laterNext) => {
      laterPayload.routingAuthority = {
        source: 'session',
        target: { provider: 'flash-max-direct', model: 'deepseek-v4-flash' },
      }
      return laterNext()
    })
    payload = { agent: { session } }
    await assert.rejects(next(0), /lower routing authority cannot replace a higher route/)
    console.log('PASS: installed DSH rejects a later lower-authority route claim')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot
    fs.rmSync(installRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
