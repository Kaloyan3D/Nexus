'use strict'
// ContextRestrictedDshCompaction.Tests.cjs — ORDINARY DSH 0.2.x compaction with the CCv2
// durable-mutation restriction left in force (ccv2-durable-mutation-disabled is never
// toggled, bypassed or mocked here).
//
// Real installed implementation: LlmRuntime, SessionStore, SessionProjectionRegistry,
// TokenMeter, AgentLoop, BasicCompactionEngine (real compactNow/compactSurfaceRegion,
// real session lifecycle events, real flush barrier). Only the summariser is
// deterministic (the documented single customization hook `summarize()`), and the LLM
// transport is a registered mock adapter, so no provider IO or credential is used.
//
// Proves: manual compaction commits through the supported idle-maintenance path;
// the 0.2 lifecycle (compaction/start → end) and checkpoint provenance are recorded;
// the summariser receives the shadowed region and returns a 0.2 SummaryResult; the
// surface shrinks around retained recent history; the result flushes through the
// supported barrier; the durable events restore into a fresh SessionStore with an
// identical derived conversation; and the CCv2 policy is still "disabled" throughout.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const policy = require('../config/ContextDurableMutationPolicyV2.cjs')

async function main() {
  const root = process.env.NEXUS_RUNTIME_ROOT || process.env.AIH_INSTALL_ROOT || path.join(os.homedir(), '.local/share/nexus')
  const appRequire = createRequire(path.join(root, 'app/package.json'))
  const { Context } = appRequire('@deepseek-ai/cordis')
  const llmPackage = appRequire('@deepseek-ai/dsh-llm')
  const LlmRuntime = llmPackage.default
  const { createUserMessage, LlmAdapter } = llmPackage
  const SessionStore = appRequire('@deepseek-ai/dsh-session').default
  const { SessionId } = appRequire('@deepseek-ai/dsh-session')
  const SessionProjectionRegistry = appRequire('@deepseek-ai/dsh-session-projection').default
  const SystemPrompt = appRequire('@deepseek-ai/dsh-system-prompt').default
  const ToolRuntime = appRequire('@deepseek-ai/dsh-tools').default
  const NativeToolExecutor = appRequire('@deepseek-ai/dsh-tool-executor-native')
  const AgentRegistry = appRequire('@deepseek-ai/dsh-agent').default
  const AgentLoop = appRequire('@deepseek-ai/dsh-agent-loop').default
  const TokenMeter = appRequire('@deepseek-ai/dsh-token-meter').default
  const { BasicCompactionEngine } = appRequire('@deepseek-ai/dsh-compaction-basic')

  let passed = 0
  const pass = (message) => { passed += 1; console.log('PASS: ' + message) }
  const dispose = []

  assert.equal(policy.durableMutationEnabledV2(), false, 'precondition: CCv2 durable mutation is disabled')

  const ctx = new Context()
  dispose.push(() => ctx.fiber.dispose())
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { persona: 'restricted compaction probe' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(AgentLoop, { agents: [] })

    class TextAdapter extends LlmAdapter {
      resolveModel(provider, model) {
        return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } })
      }
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new TextAdapter())

    const summaryCalls = []
    class DeterministicCompactor extends BasicCompactionEngine {
      async summarize(input, _agent, _signal) {
        summaryCalls.push(input)
        return { summary: [{ type: 'text', text: 'synthetic checkpoint summary' }], provider: 'synthetic', model: 'no-inference' }
      }
    }
    const engine = new DeterministicCompactor(ctx, { auto: false })

    const sessionId = SessionId('restricted-compaction-probe')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    const prompt = 'older conversation history '.repeat(60)
    const agentErrors = []
    ctx.on('agent/error', ({ error }) => { agentErrors.push(error) })
    const runTurn = (text) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), 15000)
      const offStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); offStatus(); resolve() }
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    })
    for (let index = 0; index < 4; index += 1) await runTurn(prompt + index)
    const session = agent.session
    assert.deepEqual(agentErrors, [], 'no agent error while building the history')
    const eventsBefore = session.snapshotEvents().length
    const messagesBefore = session.deriveMessages().length
    pass('real agent loop produced a multi-turn session to compact (' + messagesBefore + ' derived messages)')

    const result = await engine.compactNow(agent, new AbortController().signal)
    assert.notEqual(result, null, 'a useful range must exist for the long conversation')
    assert.equal(summaryCalls.length, 1, 'the summariser ran exactly once')
    assert.ok(Array.isArray(summaryCalls[0].messages) && summaryCalls[0].messages.length >= 2, 'summariser received the shadowed region')
    assert.equal(policy.durableMutationEnabledV2(), false)
    pass('supported manual compaction (compactNow → compactSurfaceRegion) commits once through the real engine')

    const added = session.snapshotEvents().slice(eventsBefore)
    const types = added.map((event) => event.type)
    assert.ok(types.includes('compaction/start') && types.includes('compaction/end'), 'compaction lifecycle markers present')
    assert.ok(types.indexOf('compaction/start') < types.lastIndexOf('compaction/end'))
    const endEvent = added.findLast((event) => event.type === 'compaction/end')
    assert.equal(endEvent.data.error, undefined, 'compaction closed without error')
    const checkpoint = added.find((event) => event.type === 'user/message' && event.data.source && event.data.source.kind === 'compact-checkpoint')
    assert.ok(checkpoint, 'checkpoint carries the compact-checkpoint source marker')
    assert.ok(types.includes('compaction/summary'), 'summary metering event recorded')
    pass('0.2 lifecycle markers and compact-checkpoint provenance are recorded')

    const messagesAfter = session.deriveMessages()
    assert.ok(messagesAfter.length < messagesBefore, 'derived history shrank (' + messagesBefore + ' → ' + messagesAfter.length + ')')
    assert.ok(JSON.stringify(messagesAfter).includes('synthetic checkpoint summary'), 'summary replaces the shadowed region')
    pass('the surface was replaced by the checkpoint and retained recent history')

    // A durability listener stands in for the persistence backend (the supported seam).
    let durableJson
    ctx.on('session/flush', (flushed) => { durableJson = JSON.stringify(flushed.snapshotEvents()) })
    assert.equal(await ctx.sessions.flush(session), true, 'supported durability barrier completes')
    assert.ok(durableJson, 'the listener received the compacted log')
    pass('compaction flushes through the supported session/flush barrier')

    const durable = JSON.parse(durableJson)
    const ctx2 = new Context()
    dispose.push(() => ctx2.fiber.dispose())
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    const restored = ctx2.sessions.create(SessionId('restricted-compaction-restored'), { seed: durable, meta: { cwd: session.header.cwd } })
    assert.equal(JSON.stringify(restored.deriveMessages()), JSON.stringify(session.deriveMessages()), 'restored conversation is identical')
    assert.equal(policy.durableMutationEnabledV2(), false)
    pass('durable events restore into a fresh SessionStore with an identical derived conversation')

    const source = fs.readFileSync(path.join(__dirname, '../config/ContextDurableMutationPolicyV2.cjs'), 'utf8')
    assert.ok(source.includes('ccv2-durable-mutation-disabled') && source.includes('durableMutationEnabledV2() { return false; }'), 'restriction unchanged')
    pass('the ccv2-durable-mutation-disabled policy is unchanged and still in force')
    console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
  } finally {
    for (const fn of dispose.reverse()) await fn()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
