'use strict'

// RuntimeRoutingTrace.Tests.cjs — REAL DSH 0.2.x agent loop, offline transport.
//
// Builds the actual installed runtime stack (LlmRuntime, SessionStore,
// SessionProjectionRegistry, SystemPrompt, ToolRuntime, native tool executor,
// AgentRegistry, AgentLoop, the shell-env registry) and mounts the Nexus
// Engineering plane (Engineering-Isolation + Routing-Integrity) on it. The
// only stub is the provider transport (an `llm/stream` interceptor), so no
// network and no credential is used.
//
// It proves, against the real loop and the real session log:
//   A. the controller route reaches the final llm/stream request, the durable
//      request/header, and request/context (route integrity end to end);
//   B. the controller route is recorded as ONE durable `model/selection`
//      event (the DSH 0.2.x selection model), not as a request-local claim;
//   C. a second turn on the same agent adds no new selection event;
//   D. a listener that changes the route after the controller boundary is
//      refused (fail closed) and no provider request is produced;
//   E. a controller target that changes between turns is applied at the next
//      turn boundary with one durable selection and the upstream
//      "[model changed: ...]" notice (documented durable-selection behaviour).
// Step-level mid-turn refusal is asserted in ControllerRouteSelection.Tests.cjs.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const profiles = require('../config/Engineering-Profiles.cjs')
const integrity = require('../config/Routing-Integrity.cjs')
const engineering = require('../config/Engineering-Isolation.cjs')

async function main() {
  const runtimeRoot = process.env.NEXUS_RUNTIME_ROOT || process.env.AIH_INSTALL_ROOT || path.join(os.homedir(), '.local/share/nexus')
  const appRequire = createRequire(path.join(runtimeRoot, 'app/package.json'))
  const { Context } = appRequire('@deepseek-ai/cordis')
  const llmPackage = appRequire('@deepseek-ai/dsh-llm')
  const LlmRuntime = llmPackage.default
  const { createUserMessage } = llmPackage
  const SessionStore = appRequire('@deepseek-ai/dsh-session').default
  const { SessionId } = appRequire('@deepseek-ai/dsh-session')
  const SessionProjectionRegistry = appRequire('@deepseek-ai/dsh-session-projection').default
  const SystemPrompt = appRequire('@deepseek-ai/dsh-system-prompt').default
  const ToolRuntime = appRequire('@deepseek-ai/dsh-tools').default
  const NativeToolExecutor = appRequire('@deepseek-ai/dsh-tool-executor-native')
  const AgentRegistry = appRequire('@deepseek-ai/dsh-agent').default
  const AgentLoop = appRequire('@deepseek-ai/dsh-agent-loop').default
  const ShellEnv = appRequire('@deepseek-ai/dsh-shell-env')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-runtime-trace-'))
  const oldHome = process.env.DSH_HOME
  const oldRoot = process.env.AIH_INSTALL_ROOT
  const sessionId = SessionId('nexus-runtime-route-probe')
  const first = { provider: 'zai-direct', model: 'glm-5.3-flash' }
  const second = { provider: 'flash-high-direct', model: 'deepseek-v4-flash' }
  let ctx
  let passed = 0
  const pass = (message) => { passed += 1; console.log('PASS: ' + message) }
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '../config/model-registry.json'), path.join(root, 'config/model-registry.json'))
    const binding = {
      workspace: path.join(root, 'workspace'), taskId: 'TASK-RUNTIME-PROBE',
      taskInstanceId: 'runtime-probe', preset: 'aih-engineering', engine: 'dual',
    }
    const bindingFile = path.join(root, 'data/routing/session-bindings.json')
    fs.mkdirSync(path.dirname(bindingFile), { recursive: true })
    fs.writeFileSync(bindingFile, JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: binding } }))
    const stateFile = profiles.routingStatePath(root, binding)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    const writeState = (target, reasoning) => fs.writeFileSync(stateFile, JSON.stringify({
      ...binding, profile: 'glm-codex', executionClass: 'engineer_normal', ...target, reasoning,
    }))
    writeState(first, 'high')
    process.env.DSH_HOME = path.join(root, 'data')
    process.env.AIH_INSTALL_ROOT = root

    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { persona: 'routing probe' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(ShellEnv)
    integrity.apply(ctx)
    engineering.apply(ctx)
    const requests = []
    ctx.on('llm/stream', (options) => {
      requests.push(options)
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })

    const agent = await ctx.agentLoop.create(sessionId, { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
    // The web session controller, headless and ACP hosts install DSH's model-switch
    // notice listener on each agent; do the same here (same supported API).
    appRequire('@deepseek-ai/dsh-agent').installModelSelection(agent.ctx)
    const events = () => agent.session.snapshotEvents()
    const selections = () => events().filter((event) => event.type === 'model/selection').map((event) => event.data)
    const turn = (text) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runtime routing probe timed out')), 15000)
      const errors = []
      const offError = ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) errors.push(error) })
      const offStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); offError(); offStatus(); resolve({ errors }) }
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    })

    // A + B. First turn: the controller route (not the AgentOptions default) is used.
    const a = await turn('route probe')
    assert.deepEqual(a.errors, [])
    const header = events().findLast((event) => event.type === 'request/header')
    const context = events().findLast((event) => event.type === 'request/context')
    const lastRequest = requests[requests.length - 1]
    assert.deepEqual({ provider: header.data.header.config.provider, model: header.data.header.config.model }, first)
    assert.deepEqual({ provider: context.data.provider, model: context.data.model }, first)
    assert.deepEqual({ provider: lastRequest.provider, model: lastRequest.model }, first)
    assert.equal(lastRequest.reasoningEffort, 'high')
    pass('A: controller route reaches request/header, request/context and the final llm/stream request')
    assert.equal(selections().length, 1)
    assert.deepEqual({ provider: selections()[0].provider, model: selections()[0].model, reasoningEffort: selections()[0].reasoningEffort }, { ...first, reasoningEffort: 'high' })
    pass('B: the controller route is exactly one durable model/selection event')

    // C. Same target again: no new selection.
    await turn('second turn same target')
    assert.equal(selections().length, 1)
    pass('C: an unchanged controller target adds no further model/selection event')

    // D. A downstream listener that rewrites the route is refused; no request is produced.
    const before = requests.length
    const offRogue = ctx.on('agent/request', async (_payload, next) => ({ ...(await next()), provider: 'flash-max-direct', model: 'deepseek-v4-flash' }))
    const d = await turn('rogue rewrite')
    offRogue()
    assert.equal(requests.length, before)
    assert.ok(d.errors.length >= 1, 'the rewrite must surface as an agent error')
    pass('D: a route rewritten after the controller boundary fails closed before any provider request')

    // E. Target changes between turns: applied at the next turn, notice in the transcript.
    writeState(second, 'high')
    const e = await turn('after controller reroute')
    assert.deepEqual(e.errors, [])
    const e2 = requests[requests.length - 1]
    assert.deepEqual({ provider: e2.provider, model: e2.model }, second)
    assert.equal(selections().length, 2)
    assert.equal(JSON.stringify(events()).split('[model changed:').length - 1, 1)
    pass('E: a changed controller target applies at the next turn with one durable selection and one model-changed notice')

    console.log('Controller decision: ' + first.provider + ' / ' + first.model)
    console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
  } finally {
    if (ctx) await ctx.fiber.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = oldRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
