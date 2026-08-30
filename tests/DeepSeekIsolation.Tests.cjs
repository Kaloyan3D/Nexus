'use strict'

const assert = require('node:assert/strict')
const isolation = require('../config/DeepSeek-Isolation.cjs')
const engineeringIsolation = require('../config/Engineering-Isolation.cjs')

async function main() {
  // Hermetic profile pin: with no task binding the engineering isolation
  // resolves the ACTIVE profile from the live data/settings.yaml — an
  // operator who switches profiles (Phase 2.1 editor / composer selector)
  // must not flip this suite. Pin the profile these assertions were written
  // against via the documented top-priority env override, then restore.
  const previousProfileEnv = process.env.DSH_AIH_PROFILE
  process.env.DSH_AIH_PROFILE = 'deepseek-codex'
  try {
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

  const topLevel = { agent: { session: { header: {} } } }
  const worker = { agent: { session: { header: { origin: 'subagent', delegationDepth: 1 } } } }
  const sol = { provider: 'sol-local', model: 'gpt-5.6-sol', reasoningEffort: 'medium' }
  const flashMax = { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
  const proHigh = { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

  const replacedSol = await handlers['agent/request'](topLevel, async () => sol)
  assert.deepEqual({ provider: replacedSol.provider, model: replacedSol.model, reasoningEffort: replacedSol.reasoningEffort }, { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  const replacedTopFlash = await handlers['agent/request'](topLevel, async () => flashMax)
  assert.equal(replacedTopFlash.provider, 'flash-max-direct')
  const retainedTopHigh = await handlers['agent/request'](topLevel, async () => proHigh)
  assert.equal(retainedTopHigh.provider, 'flash-max-direct')
  const retainedWorker = await handlers['agent/request'](worker, async () => flashMax)
  assert.equal(retainedWorker.provider, 'flash-max-direct')

  const engineeringHandlers = {}
  engineeringIsolation.apply({
    on(name, handler) { engineeringHandlers[name] = handler },
  })
  assert.equal(engineeringIsolation.inject, undefined)
  // Phase 2: the engineering isolation is profile-driven. With no task
  // binding the default profile (DeepSeek + Codex) applies, and the
  // primaryEngineer role declares DeepSeek V4 Flash HIGH — enforcement now
  // matches the routing semantics instead of forcing MAX on every root call.
  const normalizedEngineering = await engineeringHandlers['agent/request'](topLevel, async () => flashMax)
  assert.deepEqual(
    { provider: normalizedEngineering.provider, model: normalizedEngineering.model, reasoningEffort: normalizedEngineering.reasoningEffort },
    { provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
  )
  const retainedEngineeringWorker = await engineeringHandlers['agent/request'](worker, async () => flashMax)
  assert.equal(retainedEngineeringWorker.provider, 'flash-max-direct')

  let fallbackCalled = false
  const retry = await handlers['agent/request-error']({ provider: 'deepseek-pro-direct' }, async () => { fallbackCalled = true; return { kind: 'retry' } })
  assert.equal(retry, undefined)
  assert.equal(fallbackCalled, false)

  assert.equal(handlers['llm/stream'], undefined)

  console.log('PASS: DeepSeek isolation runtime guard behavior')
  } finally {
    if (previousProfileEnv === undefined) delete process.env.DSH_AIH_PROFILE
    else process.env.DSH_AIH_PROFILE = previousProfileEnv
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
