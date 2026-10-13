'use strict'
// Exercise the pinned ownership registry and Cordis disposal, never a fake register().
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const plugins = {
  'aih-engineering': require('../config/Engineering-Isolation.cjs'),
  'aih-deepseek': require('../config/DeepSeek-Isolation.cjs'),
  'aih-muse': require('../config/Muse-Isolation.cjs'),
}
async function main() {
  const runtime = process.env.NEXUS_RUNTIME_ROOT
  assert.ok(runtime, 'NEXUS_RUNTIME_ROOT must point to the disposable pinned runtime')
  const modules = path.join(runtime, 'app/node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(path.join(modules, 'cordis/lib/index.js')))
  const { ShellEnvRegistry } = await import(pathToFileURL(path.join(modules, 'dsh-shell-env/lib/index.js')))
  for (const order of [
    ['aih-engineering', 'aih-deepseek', 'aih-muse'],
    ['aih-muse', 'aih-deepseek', 'aih-engineering'],
    ['aih-deepseek', 'aih-muse'], ['aih-muse', 'aih-deepseek'],
    ['aih-engineering'], ['aih-deepseek'], ['aih-muse'],
  ]) {
    const ctx = new Context()
    new ShellEnvRegistry(ctx, { dshHome: path.join(runtime, 'data') })
    const scopes = []
    try {
      for (const preset of [...order, ...order]) {
        const fiber = ctx.plugin(plugins[preset]); await fiber; scopes.push(fiber)
      }
      const env = ctx.get('shellEnv')
      assert.equal(env.list().filter(v => v.key === 'DSH_AIH_PRESET').length, 1)
      for (let round = 0; round < 3; round++) for (const preset of order) {
        const session = { header: { id: `${preset}-${round}`, agentPreset: preset }, events: [] }
        assert.equal(env.collect({ agent: { session } }).DSH_AIH_PRESET, preset)
        session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } })
        assert.equal(env.collect({ agent: { session } }).DSH_AIH_PRESET, 'aih-muse')
      }
      assert.equal(env.collect({}).DSH_AIH_PRESET, undefined)
      assert.equal(env.collect({ agent: { session: { header: { id: 'worker', origin: 'subagent' }, events: [] } } }).DSH_AIH_PRESET, undefined)
      const collect = (header, events = []) => env.collect({ agent: { session: { header: { id: 'identity', ...header }, events } } })
      assert.equal(collect({ agentPreset: 'native-dsh' }).DSH_AIH_PRESET, undefined)
      assert.equal(collect({ agentPreset: 'aih-muse' }, [{ type: 'agent-preset/selected', data: { agentPreset: 'unknown' } }]).DSH_AIH_PRESET, undefined)
      for (const selected of ['', null, 42, {}]) {
        assert.throws(() => collect({ agentPreset: selected }), { code: 'shell-preset-identity-invalid' })
        assert.throws(() => collect({ agentPreset: 'aih-muse' }, [{ type: 'agent-preset/selected', data: { agentPreset: selected } }]), { code: 'shell-preset-identity-invalid' })
      }
      assert.throws(() => env.collect({ agent: {} }), TypeError, 'upstream rejects missing session before contributor resolution')
      assert.throws(() => require('../config/Preset-ShellEnvironment.cjs').resolve({ agent: {} }), { code: 'shell-preset-identity-invalid' })
      assert.equal(collect({ agentPreset: 'aih-deepseek', origin: 'subagent', delegationDepth: 1 }).DSH_AIH_PRESET, 'aih-deepseek')
      const snapshots = await Promise.all(order.map(async preset => collect({ agentPreset: preset })))
      assert.deepEqual(snapshots.map(v => v.DSH_AIH_PRESET), order)
      for (const scope of scopes) await scope.dispose()
      assert.equal(env.list().filter(v => v.key === 'DSH_AIH_PRESET').length, 1, 'host owns registration after preset disposal')
      const again = ctx.plugin(plugins[order[0]]); await again; await again.dispose()
      await ctx.fiber.dispose()
      assert.equal(env.list().length, 0, 'host disposal releases ownership')
      console.log('PASS: real registry ' + order.join(' -> '))
    } finally { await ctx.fiber.dispose() }
  }
  const ctx = new Context()
  new ShellEnvRegistry(ctx, { dshHome: path.join(runtime, 'data') })
  try {
    ctx.get('shellEnv').register({ name: 'foreign-owner', variables: { DSH_AIH_PRESET: { description: 'Foreign ownership fixture.' } }, resolve: () => ({}) })
    await assert.rejects(async () => await ctx.plugin(plugins['aih-muse']), { code: 'shell-preset-owner-conflict' })
    assert.equal(ctx.get('shellEnv').list()[0].contributor, 'foreign-owner')
    assert.throws(() => ctx.get('shellEnv').register({ name: 'second-owner', variables: { DSH_AIH_PRESET: { description: 'Must fail.' } }, resolve: () => ({}) }), /already owned/)
    console.log('PASS: foreign ownership fails closed and SDK uniqueness stays enforced')
  } finally { await ctx.fiber.dispose() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
