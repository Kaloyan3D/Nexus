'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const profiles = require('../config/Engineering-Profiles.cjs')
const integrity = require('../config/Routing-Integrity.cjs')

async function main() {
  const runtimeRoot = process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local/share/nexus')
  const appRequire = createRequire(path.join(runtimeRoot, 'app/package.json'))
  const { Context } = appRequire('@deepseek-ai/cordis')
  const LlmRuntime = appRequire('@deepseek-ai/dsh-llm').default
  const { createUserMessage } = appRequire('@deepseek-ai/dsh-llm')
  const SessionStore = appRequire('@deepseek-ai/dsh-session').default
  const { SessionId } = appRequire('@deepseek-ai/dsh-session')
  const SystemPrompt = appRequire('@deepseek-ai/dsh-system-prompt').default
  const ToolRuntime = appRequire('@deepseek-ai/dsh-tools').default
  const agentPackage = appRequire('@deepseek-ai/dsh-agent')
  const AgentLoop = appRequire('@deepseek-ai/dsh-agent-loop').default
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-runtime-trace-'))
  const oldHome = process.env.DSH_HOME
  const oldRoot = process.env.AIH_INSTALL_ROOT
  const sessionId = SessionId('nexus-runtime-route-probe')
  const expected = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }
  let ctx
  try {
    const binding = {
      workspace: path.join(root, 'workspace'), taskId: 'TASK-RUNTIME-PROBE',
      taskInstanceId: 'runtime-probe', preset: 'aih-muse', engine: 'muse',
    }
    const bindingFile = path.join(root, 'data/routing/session-bindings.json')
    fs.mkdirSync(path.dirname(bindingFile), { recursive: true })
    fs.writeFileSync(bindingFile, JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: binding } }))
    const stateFile = profiles.routingStatePath(root, binding)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ ...binding, profile: 'muse-spark-1.3-contributor', ...expected, reasoning: 'high' }))
    process.env.DSH_HOME = path.join(root, 'data')
    process.env.AIH_INSTALL_ROOT = root

    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'routing probe' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(agentPackage.default)
    await ctx.plugin(AgentLoop, { agents: [] })
    integrity.apply(ctx)
    let finalRequest
    ctx.on('llm/stream', (options) => {
      finalRequest = options
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })

    const agent = ctx.agentLoop.create(sessionId, { provider: 'flash-max-direct', model: 'deepseek-v4-flash' })
    agentPackage.installModelSelection(agent.ctx, {
      current: { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      assembled: undefined,
    })
    agent.ctx.on('agent/request', async (payload, next) => {
      payload.routingAuthority = { source: 'controller', target: expected }
      return { ...await next(), ...expected, reasoningEffort: 'high' }
    })
    const idle = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runtime routing probe timed out')), 10000)
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'route probe' }], source: { kind: 'user' } }))
    await idle
    const header = agent.session.events.findLast((event) => event.type === 'request/header')
    const context = agent.session.events.findLast((event) => event.type === 'request/context')
    assert.deepEqual({ provider: header.data.header.config.provider, model: header.data.header.config.model }, expected)
    assert.deepEqual({ provider: context.data.provider, model: context.data.model }, expected)
    assert.deepEqual({ provider: finalRequest.provider, model: finalRequest.model }, expected)
    console.log('Controller decision: ' + expected.provider + ' / ' + expected.model)
    console.log('Final request/header: ' + header.data.header.config.provider + ' / ' + header.data.header.config.model)
    console.log('Final request/context: ' + context.data.provider + ' / ' + context.data.model)
    console.log('Final llm/stream: ' + finalRequest.provider + ' / ' + finalRequest.model)
    console.log('PASS: real DSH loop, installed artifact, offline transport stub')
  } finally {
    if (ctx) await ctx.fiber.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = oldRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
