'use strict'

/**
 * P2-A Task A: one host-owned session-binding writer.
 *
 * Deterministic, no PowerShell (synthetic host), no network, no model. The
 * remount part uses the REAL pinned @deepseek-ai/cordis (fails, never skips,
 * when it is absent). The crash part runs real child processes.
 */

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')

const sourceRoot = path.join(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-binding-authority-'))
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
fake.respond({ '*': { json: {} } })
process.env.AIH_INSTALL_ROOT = sourceRoot
delete process.env.AIH_TOOLCHAIN_ROOT
const controllerModule = require('../config/nexus/controller.cjs')
const storeModule = require('../config/nexus/binding-store.cjs')
const bridgePath = path.join(sourceRoot, 'config', 'AihController.cjs')
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const waitOwned = async (core) => { for (let i = 0; i < 400 && core && core.ownership.state === 'not-acquired'; i += 1) await new Promise((r) => setTimeout(r, 10)); return core && core.ownership.state }
const code = (expected) => (error) => { assert.equal(error && error.code, expected, String(error && error.message)); return true }

function binding(sessionId, workspace, overrides = {}) {
  return {
    sessionId, taskInstanceId: 'task_' + crypto.randomBytes(16).toString('hex'), taskId: 'TASK-0001', workspace,
    workspaceId: 'ws', repositoryId: 'repo', checkoutId: 'co', checkoutRootPath: workspace, executionRoot: workspace,
    preset: 'aih-engineering', engine: 'dual', description: 'd', executionClass: 'engineer_normal',
    reviewRequired: false, needsRouteCheck: false, boundAtUtc: new Date(0).toISOString(), ...overrides,
  }
}
function freshData(name) {
  const dataRoot = path.join(scratch, name, 'data')
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  process.env.DSH_HOME = dataRoot
  return { dataRoot, bindingsPath: path.join(dataRoot, 'routing', 'session-bindings.json'), workspace: fs.mkdtempSync(path.join(scratch, name + '-ws-')) }
}
function writeDoc(file, bindings) { fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, bindings }, null, 2)) }
function readDoc(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function cordisLikeCtx(get) {
  const handlers = {}
  return { handlers, ctx: { on(event, fn) { (handlers[event] = handlers[event] || []).push(fn) }, shellEnv: { list() { return [] }, register() {} }, get, reflect: { get } } }
}
function mountBridge(get) {
  delete require.cache[bridgePath]
  const bridge = require(bridgePath)
  const { handlers, ctx } = cordisLikeCtx(get)
  bridge.apply(ctx)
  return handlers
}

// Record every rename onto the binding document and which module did it.
const renames = []
const originalRename = fs.renameSync
fs.renameSync = function patchedRename(from, to) {
  if (String(to).endsWith(path.join('routing', 'session-bindings.json'))) {
    const stack = new Error().stack.split('\n').slice(2).map((line) => line.trim())
    renames.push({ to: String(to), writer: stack.find((line) => line.includes('.cjs')) || stack[0] })
  }
  return originalRename.apply(fs, arguments)
}

async function threeBridgesOneWriter() {
  const { dataRoot, bindingsPath, workspace } = freshData('three')
  const seeded = { a: binding('a', workspace), b: binding('b', workspace, { preset: 'aih-deepseek' }), c: binding('c', workspace, { preset: 'aih-muse', engine: 'muse', executionClass: 'muse_main' }) }
  writeDoc(bindingsPath, seeded)
  const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
  const get = (name) => (name === 'nexusController' ? core : undefined)
  const planes = [mountBridge(get), mountBridge(get), mountBridge(get)]
  assert.equal(core.readiness().bridges.length, 3, 'three plane bridges attached to one host Controller')
  renames.length = 0
  // Each plane disposes "its" session concurrently; every bridge cached all three.
  await Promise.all(['a', 'b', 'c'].map((id, index) => Promise.resolve().then(() => planes[index]['agent/disposed'][0]({ session: { id } }))))
  const doc = readDoc(bindingsPath)
  assert.deepEqual(Object.keys(doc.bindings), [], 'every removal is durable; no stale cache resurrects a removed binding')
  assert.equal(doc.schemaVersion, 1)
  assert.equal(renames.length, 3, 'one atomic replacement per commit')
  assert.ok(renames.every((item) => /nexus[\\/]binding-store\.cjs/.test(item.writer)), 'every write of the binding document comes from the host binding store: ' + JSON.stringify(renames.map((r) => r.writer)))
  const metrics = core.bindings.metrics()
  assert.equal(metrics.writes, 3)
  assert.ok(metrics.resurrectionsPrevented >= 2, 'stale copies of removed bindings were refused')
  assert.ok(!fs.readFileSync(bridgePath, 'utf8').includes("fs.renameSync(temporary, bindingsPath)"), 'the plane bridge contains no binding writer')
  pass('three plane bridges share exactly one host-owned binding writer; concurrent removals never resurrect')
  await core.dispose()
}

async function preP1ResurrectionReference() {
  // The pre-P2-A per-mount writer (git HEAD of this branch's base) resurrects a
  // binding removed by another mount. Evidence for the defect the single owner fixes.
  const baseline = process.env.NEXUS_PRE_P2A_BRIDGE
  if (!baseline) { console.log('INFO: NEXUS_PRE_P2A_BRIDGE not set; pre-P2-A resurrection reference not run'); return }
  const { bindingsPath, workspace } = freshData('pre-p2a')
  writeDoc(bindingsPath, { a: binding('a', workspace), b: binding('b', workspace) })
  const old = require(path.resolve(baseline))
  const mk = () => { const h = {}; old.apply({ on(e, f) { (h[e] = h[e] || []).push(f) }, shellEnv: { list() { return [] }, register() {} } }); return h }
  const one = mk(); const two = mk()
  one['agent/disposed'][0]({ session: { id: 'a' } })
  two['agent/disposed'][0]({ session: { id: 'b' } })
  const survivors = Object.keys(readDoc(bindingsPath).bindings)
  console.log('INFO: pre-P2-A per-mount writers left bindings ' + JSON.stringify(survivors) + ' after removing a and b')
  pass('pre-P2-A reference recorded (per-mount writers): ' + JSON.stringify(survivors))
}

async function staleAndConflicting() {
  const { dataRoot, bindingsPath, workspace } = freshData('stale')
  const x = binding('x', workspace)
  writeDoc(bindingsPath, { x })
  let attached = true
  const store = storeModule.createBindingStore({ bindingsPath, isWriterAttached: (id) => attached && id === 'm1' })
  const viewOf = () => { const cache = { x: { ...x } }; return { cache, observed: new Map([['x', storeModule.authorityStamp(x)]]) } }
  const writerA = viewOf()
  const writerB = viewOf()
  // B re-binds x to a new task generation and commits first.
  writerB.cache.x.taskInstanceId = 'task_' + 'b'.repeat(32)
  store.commit('m1', writerB)
  // A changed only non-authority fields: it adopts B's authority, keeps its own fields.
  writerA.cache.x.executionClass = 'engineer_deep'
  store.commit('m1', writerA)
  assert.equal(readDoc(bindingsPath).bindings.x.taskInstanceId, 'task_' + 'b'.repeat(32), 'authority committed by another writer is adopted, not overwritten')
  // C changed authority based on a stale observation: refused, file unchanged.
  const writerC = viewOf()
  writerC.cache.x.taskInstanceId = 'task_' + 'c'.repeat(32)
  const before = fs.readFileSync(bindingsPath, 'utf8')
  assert.throws(() => store.commit('m1', writerC), code('bindings-write-conflict'))
  assert.equal(fs.readFileSync(bindingsPath, 'utf8'), before, 'a stale conflicting update leaves the document untouched')
  // Registry authority cannot silently disappear.
  const pinned = binding('p', workspace, { bindingAuthority: 'registry', registryPin: { modeId: 'engineering-v1', generation: 1 } })
  writeDoc(bindingsPath, { p: { ...pinned, bindingAuthority: undefined, registryPin: undefined, taskInstanceId: 'task_' + 'd'.repeat(32) } })
  const writerR = { cache: { p: { ...pinned } }, observed: new Map([['p', storeModule.authorityStamp(pinned)]]) }
  assert.throws(() => store.commit('m1', writerR), code('registry-authority-unverifiable'))
  // Detached or closed writers are refused before any read or write.
  attached = false
  assert.throws(() => store.commit('m1', viewOf()), code('binding-writer-detached'))
  attached = true
  store.close()
  assert.throws(() => store.commit('m1', viewOf()), code('binding-store-closed'))
  assert.ok(store.metrics().conflicts >= 1)
  pass('stale revisions and conflicting authority are refused; non-authority writers adopt; detached/closed writers refused')
}

async function concurrentRequests() {
  const { dataRoot, bindingsPath, workspace } = freshData('concurrent')
  const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
  const mount = core.attachBridge({ plane: 'p' }).mountId
  const cache = {}
  const observed = new Map()
  await Promise.all(Array.from({ length: 50 }, (_, index) => Promise.resolve().then(() => {
    cache['s' + index] = binding('s' + index, workspace)
    core.bindings.commit(mount, { cache, observed })
  })))
  const doc = readDoc(bindingsPath)
  assert.equal(Object.keys(doc.bindings).length, 50, 'no lost update under 50 interleaved commit requests')
  assert.equal(core.bindings.metrics().writes, 50)
  assert.ok(core.bindings.revisionOf('s0') >= 1)
  assert.deepEqual(fs.readdirSync(path.dirname(bindingsPath)).filter((name) => name.endsWith('.tmp')), [], 'no temp file left behind')
  pass('concurrent binding requests serialize through the single writer with no lost update')
  await core.dispose()
}

function crashChild(bindingsPath, phase) {
  const source = `
    const fs = require('node:fs');
    const store = require(${JSON.stringify(path.join(sourceRoot, 'config', 'nexus', 'binding-store.cjs'))});
    const s = store.createBindingStore({ bindingsPath: ${JSON.stringify(bindingsPath)}, isWriterAttached: () => true });
    const doc = JSON.parse(fs.readFileSync(${JSON.stringify(bindingsPath)}, 'utf8'));
    const cache = { ...doc.bindings, crash: { ...doc.bindings.keep, sessionId: 'crash' } };
    const observed = new Map(Object.entries(doc.bindings).map(([k, v]) => [k, store.authorityStamp(v)]));
    if (${JSON.stringify(phase)} === 'before-rename') { fs.renameSync = () => process.exit(91) }
    if (${JSON.stringify(phase)} === 'during-write') { const w = fs.writeFileSync; fs.writeFileSync = (fd, data) => { w(fd, String(data).slice(0, 40)); process.kill(process.pid, 'SIGKILL') } }
    s.commit('m', { cache, observed });
    process.exit(0);
  `
  return childProcess.spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 30000 })
}

async function interruptedAtomicWrites() {
  const { dataRoot, bindingsPath, workspace } = freshData('crash')
  writeDoc(bindingsPath, { keep: binding('keep', workspace) })
  const original = fs.readFileSync(bindingsPath, 'utf8')
  const killedBeforeRename = crashChild(bindingsPath, 'before-rename')
  assert.equal(killedBeforeRename.status, 91, killedBeforeRename.stderr)
  assert.equal(fs.readFileSync(bindingsPath, 'utf8'), original, 'death after fsync but before rename leaves the previous document intact')
  const killedDuringWrite = crashChild(bindingsPath, 'during-write')
  assert.equal(killedDuringWrite.signal, 'SIGKILL', killedDuringWrite.stderr)
  assert.equal(fs.readFileSync(bindingsPath, 'utf8'), original, 'death during a torn temp write leaves the previous document intact')
  assert.deepEqual(Object.keys(storeModule.loadBindings(bindingsPath)), ['keep'], 'the durable document stays readable (no quarantine)')
  const orphans = fs.readdirSync(path.dirname(bindingsPath)).filter((name) => name.endsWith('.tmp'))
  assert.ok(orphans.length >= 1, 'interrupted writes leave only inert temp files')
  const store = storeModule.createBindingStore({ bindingsPath, isWriterAttached: () => true })
  const cache = { keep: storeModule.loadBindings(bindingsPath).keep, fresh: binding('fresh', workspace) }
  store.commit('m', { cache, observed: new Map([['keep', storeModule.authorityStamp(cache.keep)]]) })
  assert.deepEqual(Object.keys(readDoc(bindingsPath).bindings).sort(), ['fresh', 'keep'], 'the next commit after a crash succeeds and ignores orphans')
  pass('interrupted atomic writes (killed before rename, killed mid-write) never corrupt or lose the durable document')
}

async function missingAndRemount() {
  // Missing host Controller: strict persistence refuses, non-strict logs; file untouched.
  const { dataRoot, bindingsPath, workspace } = freshData('missing')
  writeDoc(bindingsPath, { m: binding('m', workspace) })
  const before = fs.readFileSync(bindingsPath, 'utf8')
  const absent = mountBridge(() => undefined)
  absent['agent/disposed'][0]({ session: { id: 'm' } })
  assert.equal(fs.readFileSync(bindingsPath, 'utf8'), before, 'no binding write without the host Controller')
  const log = fs.readFileSync(path.join(dataRoot, 'logs', 'aih-controller.log'), 'utf8')
  assert.ok(/bindings-persist-failed.*nexus-controller-unavailable/.test(log), 'the refused write is logged with its typed reason')
  pass('a missing host Controller refuses binding writes (typed, logged) and never falls back to a local writer')

  // Real Cordis unload/remount.
  const appRoot = [process.env.AIH_HOST_APP, path.join(sourceRoot, 'app'), process.env.AIH_TOOLCHAIN_ROOT && path.join(process.env.AIH_TOOLCHAIN_ROOT, 'app')].filter(Boolean).find((candidate) => fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')))
  if (!appRoot) throw new Error('pinned DSH app not found (set AIH_HOST_APP); the real Cordis remount test never skips')
  const appRequire = createRequire(path.join(appRoot, 'package.json'))
  const { Context } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/cordis')).href)
  const remount = freshData('remount')
  process.env.AIH_HOST_APP = appRoot
  writeDoc(remount.bindingsPath, { r1: binding('r1', remount.workspace), r2: binding('r2', remount.workspace), r3: binding('r3', remount.workspace) })
  const root = new Context()
  root.provide('shellEnv', { list() { return [] }, register() {} })
  const hostFiber = root.plugin(controllerModule)
  await hostFiber
  const first = root.get('nexusController')
  assert.equal(await waitOwned(first), 'held', 'the first host generation owns the installation')
  const handlers = {}
  delete require.cache[bridgePath]
  const bridgeFiber = root.plugin({ name: 'bridge', apply(ctx) { require(bridgePath).apply(new Proxy(ctx, { get(target, prop) { if (prop === 'on') return (event, fn, opts) => { (handlers[event] = handlers[event] || []).push(fn); return target.on(event, fn, opts) }; return Reflect.get(target, prop) } })) } })
  await bridgeFiber
  assert.equal(first.readiness().bridges.length, 1)
  handlers['agent/disposed'][0]({ session: { id: 'r1' } })
  assert.deepEqual(Object.keys(readDoc(remount.bindingsPath).bindings).sort(), ['r2', 'r3'])
  await hostFiber.dispose()
  assert.equal(first.bindings.closed, true, 'the old store is closed with its host')
  const afterUnload = fs.readFileSync(remount.bindingsPath, 'utf8')
  handlers['agent/disposed'][0]({ session: { id: 'r2' } })
  assert.equal(fs.readFileSync(remount.bindingsPath, 'utf8'), afterUnload, 'no write lands after the host Controller unloads')
  const secondFiber = root.plugin(controllerModule)
  await secondFiber
  const second = root.get('nexusController')
  assert.equal(await waitOwned(second), 'held', 'the remounted host reacquires ownership after the first released it')
  assert.notEqual(second, first)
  assert.throws(() => second.bindings.commit('bridge-1', { cache: {}, observed: new Map() }), code('binding-writer-detached'), 'a mount id from the previous host generation cannot write')
  handlers['agent/disposed'][0]({ session: { id: 'r3' } })
  assert.equal(second.readiness().bridges.length, 1, 'the bridge re-attached once to the new host (no duplicate attachment)')
  const doc = readDoc(remount.bindingsPath)
  assert.ok(!Object.prototype.hasOwnProperty.call(doc.bindings, 'r3'), 'the re-attached bridge writes through the new single store')
  assert.equal(first.bindings.metrics().writes, 1)
  assert.ok(second.bindings.metrics().writes >= 1)
  await secondFiber.dispose()
  await bridgeFiber.dispose()
  pass('real Cordis unload/remount: old store closed, old mount ids refused, bridge re-attaches once to the new single writer')
}

async function main() {
  await threeBridgesOneWriter()
  await preP1ResurrectionReference()
  await staleAndConflicting()
  await concurrentRequests()
  await interruptedAtomicWrites()
  await missingAndRemount()
  fs.renameSync = originalRename
  console.log(`NexusBindingAuthority: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
