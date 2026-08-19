'use strict'

const assert = require('node:assert/strict')
const isolation = require('../config/DeepSeek-Isolation.cjs')

async function main() {
  const handlers = {}
  let contributor
  isolation.apply({
    on(name, handler) { handlers[name] = handler },
    shellEnv: { register(value) { contributor = value } },
  })
  assert.equal(isolation.inject[0], 'shellEnv')
  assert.equal(contributor.resolve({ agent: {} }).DSH_AIH_PRESET, 'aih-deepseek')

  const topLevel = { agent: { session: { header: {} } } }
  const worker = { agent: { session: { header: { origin: 'subagent', delegationDepth: 1 } } } }
  const sol = { provider: 'sol-local', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }
  const flashMax = { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }

  const replacedSol = await handlers['agent/request'](topLevel, async () => sol)
  assert.deepEqual({ provider: replacedSol.provider, model: replacedSol.model, reasoningEffort: replacedSol.reasoningEffort }, { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  const replacedTopFlash = await handlers['agent/request'](topLevel, async () => flashMax)
  assert.equal(replacedTopFlash.provider, 'deepseek-pro-direct')
  const retainedWorker = await handlers['agent/request'](worker, async () => flashMax)
  assert.equal(retainedWorker.provider, 'flash-max-direct')

  let fallbackCalled = false
  const retry = await handlers['agent/request-error']({ provider: 'deepseek-pro-direct' }, async () => { fallbackCalled = true; return { kind: 'retry' } })
  assert.equal(retry, undefined)
  assert.equal(fallbackCalled, false)

  await assert.rejects(async () => {
    const stream = handlers['llm/stream'](sol, async function* () { yield { type: 'text-delta', text: 'unsafe' } })
    await stream.next()
  }, /blocked model route/)

  console.log('PASS: DeepSeek isolation runtime guard behavior')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
