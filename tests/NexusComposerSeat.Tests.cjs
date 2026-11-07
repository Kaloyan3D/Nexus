'use strict'
// NexusComposerSeat.Tests.cjs — composer preference seat on DSH 0.2.x.
// The Nexus controller must occupy `conversation.input.model` through the supported
// slot registry (priority election, no bundle patch), outrank upstream's ModelSelect,
// bind each session to its own ModelDirectory, refuse subagent sessions, and degrade
// without breaking the controller when the model directory service is absent.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function load() {
  let plugin
  const sandbox = { console: { error() {}, log() {}, warn() {} }, window: { __ModuleLoader__: { load(def) { plugin = def.factory(() => ({})) } } } }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/nexus-controller/lib/client.js'), 'utf8'), sandbox)
  return plugin
}
let passed = 0
const pass = (m) => { passed++; console.log('PASS: ' + m) }

const plugin = load()
const registered = []
const loads = [], selects = []
const directories = new Map()
const modelDirectories = { directoryFor(id) {
  if (!directories.has(id)) directories.set(id, { store: { getSnapshot: () => ({ current: null, groups: [] }), subscribe: () => () => {} }, load: async () => { loads.push(id) }, select: async (s) => { selects.push([id, s]) } })
  return directories.get(id)
} }
const sessions = { subagentAddress: (id) => (id === 'child' ? { parent: 'p' } : undefined) }
const ctx = {
  slots: { inject(_n, fn) { fn() }, register(spec, component) { registered.push({ spec, component }); return () => {} } },
  provide() {}, effect() {}, workspaces: undefined,
  inject(names, fn) { const all = { modelDirectories: this.modelDirectories, sessions, nexusModeState: undefined }; const scope = { provide() {}, effect() {} }; for (const n of names) scope[n] = all[n]; fn(scope) },
  modelDirectories,
}
plugin.apply(ctx)
const seat = registered.find((r) => r.spec.name === 'conversation.input.model')
assert.ok(seat, 'controller registers the composer model seat')
assert.ok(seat.spec.priority < 0, 'Nexus seat shadows upstream ModelSelect (slot shadowing is ascending; lowest priority renders; upstream is 0)')
assert.equal(typeof seat.component, 'function')
pass('controller occupies conversation.input.model through the supported slot registry with election priority')

const props = seat.spec.inject('s1')
assert.equal(props.available, true)
props.load(); props.select({ provider: 'p', model: 'm' })
assert.deepEqual(loads, ['s1']); assert.deepEqual(selects, [['s1', { provider: 'p', model: 'm' }]])
assert.notEqual(modelDirectories.directoryFor('s1'), modelDirectories.directoryFor('s2'))
pass('each session binds to its own ModelDirectory (load/select scoped by session id)')

const child = seat.spec.inject('child')
assert.equal(child.available, false)
child.load(); await_select(child)
function await_select(c) { c.select({ provider: 'p', model: 'm' }) }
assert.equal(loads.length, 1); assert.equal(selects.length, 1)
pass('subagent sessions never load or change a model directory')

const registeredBefore = registered.length
const ctx2 = { ...ctx, inject(names, fn) { /* modelDirectories absent: nested inject never fires */ } }
plugin.apply(ctx2)
assert.equal(registered.length > registeredBefore, true, 'controller still mounts its other seats')
assert.ok(!registered.slice(registeredBefore).some((r) => r.spec.name === 'conversation.input.model'))
pass('without the model directory service the controller still boots and leaves the upstream seat alone')
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
