'use strict'

/**
 * P1 plugin-first foundation: host Nexus Controller core, strategy index and
 * EMv2 Muse / EMv1 Dual strategies.
 *
 * Deterministic, no PowerShell, no network, no model. The Cordis lifecycle
 * part uses the REAL pinned @deepseek-ai/cordis from the installation under
 * test (located like the other host suites); it fails, never skips, when that
 * runtime is absent.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const sourceRoot = path.join(__dirname, '..')
const controllerModule = require('../config/nexus/controller.cjs')
const indexModule = require('../config/nexus/strategy-index.cjs')
const muse = require('../config/nexus/strategies/muse.cjs')
const dual = require('../config/nexus/strategies/legacy-dual.cjs')
const governor = require('../config/Muse-ReasoningGovernor.cjs')
const activity = require('../config/Muse-ReasoningActivity.cjs')

let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-core-'))
const dataRoot = path.join(scratch, 'data')
fs.mkdirSync(dataRoot, { recursive: true })
const stubCli = { invoke: async () => null, pwshHost: 'stub', toolchainRoot: scratch, timeoutMs: 1, stats: () => ({ invocations: 0 }) }
const core = (extra = {}) => controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot, legacyCli: stubCli, ...extra })
const waitOwned = async (core) => { for (let i = 0; i < 400 && core && core.ownership.state === 'not-acquired'; i += 1) await new Promise((r) => setTimeout(r, 10)); return core && core.ownership.state }
const code = (expected) => (error) => { assert.equal(error && error.code, expected, String(error && error.message)); return true }

function descriptor(overrides = {}) {
  return { id: 'test.alpha', contractMajor: 1, build: 'b1', engines: ['alpha'], ...overrides }
}
const impl = (decisions) => () => ({ decide: () => decisions, readiness: () => ({ ready: true }) })

async function strategyIndexContract() {
  const index = indexModule.createStrategyIndex()
  const dispose = index.register(descriptor(), impl([{ kind: 'runRoot', stepRouting: false }]))
  assert.equal(index.forEngine('alpha').descriptor.id, 'test.alpha')
  assert.equal(index.open('test.alpha', 1).descriptor.build, 'b1')
  pass('strategy registration resolves by engine and by exact id/major pin')

  assert.throws(() => index.register(descriptor(), impl([])), code('strategy-duplicate'))
  assert.throws(() => index.register(descriptor({ id: 'test.beta' }), impl([])), code('strategy-engine-conflict'))
  pass('duplicate strategy id and duplicate engine claims are rejected')

  assert.throws(() => index.register(descriptor({ id: 'test.v2', engines: ['v2'], contractMajor: 2 }), impl([])), code('strategy-contract-unsupported'))
  assert.throws(() => index.open('test.alpha', 2), code('strategy-contract-unsupported'))
  assert.throws(() => index.register({ id: 'Bad Id', contractMajor: 1, build: 'x', engines: ['x'] }, impl([])), code('strategy-descriptor-invalid'))
  assert.throws(() => index.register(descriptor({ id: 'test.noimpl', engines: ['n'] }), () => ({})), code('strategy-implementation-invalid'))
  pass('unsupported contract majors, invalid descriptors and invalid implementations are rejected')

  assert.equal(dispose(), true)
  assert.equal(dispose(), false, 'disposer is exact and idempotent')
  assert.throws(() => index.forEngine('alpha'), code('strategy-missing'))
  assert.throws(() => index.assertMandatory(['test.alpha']), code('strategy-missing'))
  const again = index.register(descriptor(), impl([]))
  again()
  index.dispose()
  assert.throws(() => index.register(descriptor(), impl([])), code('strategy-index-closed'))
  pass('disposal releases the id, missing mandatory strategies fail, a closed index refuses registration')

  for (const forbidden of ['complete', 'markComplete', 'writeLedger']) {
    assert.throws(() => indexModule.validateDecision('x', { kind: forbidden }), code('strategy-decision-forbidden'))
  }
  assert.ok(!indexModule.DECISION_KINDS.some((kind) => /complete/i.test(kind)))
  assert.throws(() => indexModule.validateDecision('x', { kind: 'refuse' }), code('strategy-decision-invalid'))
  assert.throws(() => indexModule.validateDecision('x', { kind: 'runRoot' }), code('strategy-decision-invalid'))
  pass('contract major 1 has no completion decision; malformed decisions are rejected')
}

async function controllerCoreContract() {
  const c = core()
  const readiness = c.readiness()
  assert.equal(readiness.ready, true, JSON.stringify(readiness.problems))
  assert.deepEqual(readiness.strategies.map((row) => row.id).sort(), ['nexus.legacy-dual', 'nexus.muse'])
  assert.equal(readiness.contractMajor, 1)
  const planeReadiness = c.readiness({ requirePlanes: true })
  assert.equal(planeReadiness.ready, false, 'Muse is not ready until its plane bridge is attached')
  const detach = c.attachBridge({ plane: 'aih-muse' })
  assert.equal(c.readiness({ requirePlanes: true }).ready, true)
  assert.equal(detach(), true)
  assert.equal(detach(), false)
  assert.equal(c.readiness({ requirePlanes: true }).ready, false)
  pass('readiness checks mandatory strategies and attached plane bridges, attach/detach are exact')

  assert.throws(() => c.decide('nova', {}, { type: 'engineering-turn' }), code('strategy-missing'))
  pass('a request for an unregistered engine fails with strategy-missing (no silent substitution)')

  const rogue = controllerModule.createControllerCore({
    installRoot: sourceRoot, dataRoot, legacyCli: stubCli, mandatoryStrategies: false,
    strategies: [
      { descriptor: { id: 'test.rogue', contractMajor: 1, build: 'r', engines: ['rogue'] }, create: () => ({ decide: () => [{ kind: 'complete' }] }) },
      { descriptor: { id: 'test.multi', contractMajor: 1, build: 'm', engines: ['multi'] }, create: () => ({ decide: () => [{ kind: 'runReview' }, { kind: 'runReview' }] }) },
      { descriptor: { id: 'test.throws', contractMajor: 1, build: 't', engines: ['throws'] }, create: () => ({ decide: () => { throw new Error('boom') } }) },
    ],
  })
  assert.throws(() => rogue.decide('rogue', {}, { type: 'engineering-turn' }), code('strategy-decision-forbidden'))
  assert.throws(() => rogue.decide('multi', {}, { type: 'engineering-turn' }), code('strategy-decision-invalid'))
  assert.throws(() => rogue.decide('throws', {}, { type: 'engineering-turn' }), code('strategy-decide-failed'))
  assert.ok(rogue.metrics().decisionRejections >= 3)
  assert.throws(() => controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot, legacyCli: stubCli, strategies: [dual] }), code('strategy-missing'))
  pass('a strategy cannot complete a task, return several decisions or crash dispatch; mandatory Muse is enforced')

  // Event claims.
  assert.equal(c.claimEvent('s1', { seq: 7, type: 'turn/end' }), true)
  assert.equal(c.claimEvent('s1', { seq: 7, type: 'turn/end' }), false)
  assert.equal(c.claimEvent('s1', { seq: 7, type: 'assistant/chunk' }), true)
  assert.equal(c.claimEvent('s2', { seq: 7, type: 'turn/end' }), true)
  assert.equal(c.claimEvent('s1', { type: 'turn/end' }), true, 'events without seq are never deduplicated')
  assert.equal(c.claimEvent('s1', { type: 'turn/end' }), true)
  c.forgetSession('s1')
  assert.equal(c.claimEvent('s1', { seq: 7, type: 'turn/end' }), true)
  for (let seq = 100; seq < 100 + 600; seq += 1) c.claimEvent('s3', { seq, type: 'x' })
  assert.equal(c.claimEvent('s3', { seq: 100, type: 'x' }), true, 'dedup memory is bounded per session')
  assert.equal(c.claimEvent('s3', { seq: 699, type: 'x' }), false)
  pass('session events are claimed once per (session, seq, type) with bounded memory')

  // Lanes: serialization, failure isolation, ordering.
  const order = []
  const slow = (label, ms, fail) => () => new Promise((resolve, reject) => setTimeout(() => { order.push(label); fail ? reject(new Error(label)) : resolve(label) }, ms))
  const results = await Promise.allSettled([
    c.transition('task_a', 'one', slow('a1', 40)),
    c.transition('task_a', 'two', slow('a2', 1, true)),
    c.transition('task_a', 'three', slow('a3', 1)),
    c.transition('task_b', 'other', slow('b1', 5)),
  ])
  assert.deepEqual(order.filter((label) => label.startsWith('a')), ['a1', 'a2', 'a3'], 'same-lane transitions run in submission order')
  assert.ok(order.indexOf('b1') < order.indexOf('a1'), 'other lanes are not blocked')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[2].status, 'fulfilled', 'a failed transition does not poison its lane')
  assert.throws(() => c.transition('', 'x', () => 1), code('transition-lane-invalid'))
  pass('per-generation transition lanes serialize writers, isolate failures and never block other tasks')

  // Disposal closes admission first, drains in-flight work, then refuses everything.
  let drained = false
  const pending = c.transition('task_c', 'slow', () => new Promise((resolve) => setTimeout(() => { drained = true; resolve() }, 60)))
  const disposal = c.dispose()
  assert.equal(c.dispose(), disposal, 'dispose is idempotent')
  assert.throws(() => c.transition('task_c', 'late', () => 1), code('nexus-controller-closed'))
  assert.throws(() => c.decide('muse', {}, { type: 'engineering-turn' }), code('nexus-controller-closed'))
  assert.throws(() => c.attachBridge({ plane: 'aih-muse' }), code('nexus-controller-closed'))
  await disposal
  await pending
  assert.equal(drained, true, 'in-flight transition completed before disposal settled')
  assert.equal(c.readiness().ready, false)
  assert.ok(c.metrics().admissionsRefused >= 3)
  pass('disposal closes admission, drains in-flight transitions and leaves no usable strategy')
}

async function strategyParity() {
  const museDecision = core().decide('muse', { sessionId: 's' }, { type: 'explicit-review' })
  assert.equal(museDecision.kind, 'refuse')
  assert.equal(museDecision.code, 'muse-review-unavailable')
  assert.equal(museDecision.strategyId, 'nexus.muse')
  const preP1Source = fs.readFileSync(path.join(sourceRoot, 'docs', 'architecture', 'evidence', 'p1', 'muse-review-notice.txt'), 'utf8')
  assert.equal(museDecision.notice, preP1Source.replace(/\n$/, ''), 'notice equals the pre-P1 literal byte for byte')
  const c = core()
  assert.deepEqual(
    ['explicit-review', 'engineering-turn', 'routing-failure', 'binding-inconclusive'].map((type) => { const d = c.decide('muse', {}, { type }); return [d.kind, d.stepRouting ?? null, d.executionLabel ?? null, d.noticeSuffix ?? null] }),
    [['refuse', null, null, null], ['runRoot', false, ' · engine=muse', null], ['refuse', null, null, '\nNo Muse fallback was attempted.'], ['refuse', null, null, null]],
  )
  assert.deepEqual(
    ['explicit-review', 'engineering-turn', 'routing-failure', 'binding-inconclusive'].map((type) => { const d = c.decide('dual', {}, { type }); return [d.kind, d.stepRouting ?? null, d.executionLabel ?? null, d.noticeSuffix ?? null] }),
    [['runReview', null, null, null], ['runRoot', true, ' · step-routed', null], ['refuse', null, null, ''], ['degradeLegacy', null, null, null]],
  )
  pass('EMv2 Muse and EMv1 Dual decisions reproduce the pre-P1 branch outcomes exactly')

  assert.deepEqual(muse.descriptor.roles, ['muse_main'])
  assert.deepEqual(muse.descriptor.capabilities, { independentReview: false, delegation: false, workers: false, fallback: false })
  const reasoning = muse.create().reasoning
  assert.equal(reasoning.governor, governor, 'Muse strategy reuses the existing Adaptive Reasoning Governor module')
  assert.equal(reasoning.activity, activity, 'Muse strategy reuses the existing trusted tool-activity module')
  assert.equal(reasoning.governor.resolveMuseReasoningEffortForRequest, governor.resolveMuseReasoningEffortForRequest)
  assert.ok(!Object.keys(muse).some((key) => /model|provider|registry|entitle/i.test(key)), 'the strategy carries no model/provider mapping')
  assert.ok(!fs.readFileSync(path.join(sourceRoot, 'config', 'nexus', 'strategies', 'muse.cjs'), 'utf8').match(/require\([^)]*(registry|Routing|Task|writeFile|appendFile)/), 'the strategy imports no registry or writer')
  pass('Muse strategy: one muse_main role, no review/delegation/workers/fallback, existing reasoning modules, no model registry duplicate')
}

function locateApp() {
  const candidates = [process.env.AIH_HOST_APP, path.join(sourceRoot, 'app'), process.env.AIH_TOOLCHAIN_ROOT && path.join(process.env.AIH_TOOLCHAIN_ROOT, 'app'), process.env.NEXUS_RUNTIME_ROOT && path.join(process.env.NEXUS_RUNTIME_ROOT, 'app')].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'))) return candidate
  throw new Error('pinned DSH app with @deepseek-ai/cordis not found (set AIH_HOST_APP); this suite never skips the real Cordis lifecycle')
}

async function realCordisLifecycle() {
  const appRoot = locateApp()
  const appRequire = createRequire(path.join(appRoot, 'package.json'))
  const { Context } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/cordis')).href)
  const version = appRequire('@deepseek-ai/cordis/package.json').version
  process.env.AIH_INSTALL_ROOT = sourceRoot
  process.env.DSH_HOME = dataRoot
  const root = new Context()
  const fiber = root.plugin(controllerModule)
  await fiber
  const service = root.get('nexusController')
  assert.ok(service, 'host plugin provides nexusController')
  // P2-B1: the host is authoritative only once it owns the installation.
  assert.equal(await waitOwned(service), 'held', 'the host Controller acquires installation ownership')
  assert.equal(service.ownership.enforced, true)
  assert.equal(service.contractMajor, 1)
  assert.equal(service.readiness().ready, true)

  const duplicate = root.plugin({ name: 'nexus-controller-duplicate', apply: controllerModule.apply })
  await assert.rejects(Promise.resolve(duplicate), /service "nexusController" has been registered/)
  assert.equal(root.get('nexusController'), service, 'the first host Controller remains the only provider')
  pass(`real Cordis ${version}: one host Controller service; a duplicate host row is rejected`)

  // A dependent bridge that resolves (not injects) the service survives host unload and fails closed.
  const access = controllerModule.resolveControllerAccess(root)
  assert.equal(access.mode, 'host')
  assert.equal(access.get().core, service)
  const detach = service.attachBridge({ plane: 'aih-muse' })
  await fiber.dispose()
  assert.equal(root.get('nexusController'), undefined, 'service unregistered with its fiber')
  assert.equal(service.closed, true, 'core admission closed by the composite effect')
  assert.equal(access.get().core, null)
  assert.equal(access.get().reason, 'nexus-controller-unavailable')
  assert.equal(detach(), false, 'disposal already released bridge attachments')
  assert.throws(() => service.transition('task_x', 'late', () => 1), code('nexus-controller-closed'))

  // Remount: a fresh generation with no carried-over attachments or claims.
  const remount = root.plugin(controllerModule)
  await remount
  const fresh = root.get('nexusController')
  assert.notEqual(fresh, service)
  assert.equal(fresh.readiness().bridges.length, 0, 'no duplicate attachments survive a remount')
  assert.equal(fresh.claimEvent('s', { seq: 1, type: 'turn/end' }), true)
  await remount.dispose()
  assert.equal(root.get('nexusController'), undefined)
  pass('real Cordis: unload closes admission and unregisters; resolving bridges fail closed; remount starts clean')
}

async function main() {
  await strategyIndexContract()
  await controllerCoreContract()
  await strategyParity()
  await realCordisLifecycle()
  console.log(`NexusControllerCore: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => {
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
