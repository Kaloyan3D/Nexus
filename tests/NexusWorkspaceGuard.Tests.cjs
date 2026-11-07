'use strict'
// NexusWorkspaceGuard.Tests.cjs — workspace-transition composer guard on DSH 0.2.x.
// Drives the real client plugin against a fake uiWorkspace/conversation/sessions host and
// asserts: block raised on every known session while a pick is pending, cleared on
// success / rejection, a superseded pick cannot unblock a newer one (stale rejection),
// sessions created mid-pick are blocked, dispose restores the original method and clears.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function main() {
  let plugin
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/nexus-mode-selector/lib/client.js'), 'utf8'),
    { window: { __ModuleLoader__: { load(def) { plugin = def.factory(() => ({})) } } } })
  let passed = 0
  const pass = (m) => { passed++; console.log('PASS: ' + m) }
  const make = () => {
    const state = { byId: { a: {}, b: {} } }
    const subs = new Set()
    const blocks = new Map()
    const deferreds = []
    const uiWorkspace = {
      openWorkspace(id) { return new Promise((resolve, reject) => deferreds.push({ id, resolve, reject })) },
    }
    const original = uiWorkspace.openWorkspace
    const sessions = { list: { getSnapshot: () => state, subscribe(fn) { subs.add(fn); return () => subs.delete(fn) } } }
    const conversation = { blocks: { set(id, block) { if (block === undefined) blocks.delete(id); else blocks.set(id, block) } } }
    const guard = plugin.createWorkspaceTransitionGuard({ uiWorkspace, blocks: conversation.blocks, sessions })
    return { state, subs, blocks, deferreds, uiWorkspace, original, guard }
  }
  const tick = () => new Promise((r) => setImmediate(r))

  { // success path
    const h = make()
    const p = h.uiWorkspace.openWorkspace('w1')
    assert.deepEqual([...h.blocks.keys()].sort(), ['a', 'b'])
    assert.match(h.blocks.get('a').reason, /Switching workspace/)
    h.state.byId = { ...h.state.byId, c: {} }
    for (const fn of h.subs) fn()
    assert.ok(h.blocks.has('c'), 'a session created mid-pick is blocked too')
    h.deferreds[0].resolve(); await p; await tick()
    assert.equal(h.blocks.size, 0)
    assert.equal(h.guard.pending(), false)
    pass('block covers every session during the pick, including new ones, and clears on success')
  }
  { // rejection path
    const h = make()
    const p = h.uiWorkspace.openWorkspace('w1')
    h.deferreds[0].reject(new Error('refused'))
    await assert.rejects(p, /refused/)
    assert.equal(h.blocks.size, 0)
    pass('a failed pick still unblocks (fail open only after the pick is over, error preserved)')
  }
  { // stale rejection: old pick settling must not unblock the newer pick
    const h = make()
    const first = h.uiWorkspace.openWorkspace('w1')
    const second = h.uiWorkspace.openWorkspace('w2')
    h.deferreds[0].resolve(); await first; await tick()
    assert.equal(h.guard.pending(), true)
    assert.equal(h.blocks.size, 2, 'superseded pick settling late must not clear the newer pick\'s block')
    h.deferreds[1].resolve(); await second; await tick()
    assert.equal(h.blocks.size, 0)
    pass('stale superseded pick cannot unblock a newer pending pick')
  }
  { // synchronous throw in the wrapped method
    const h = make()
    h.uiWorkspace.openWorkspace = function guardedOpenWorkspace() { throw new Error('x') }
    // rewrap on a throwing original
    const throwing = { openWorkspace() { throw new Error('sync boom') } }
    const set = new Map()
    const g = plugin.createWorkspaceTransitionGuard({ uiWorkspace: throwing, blocks: { set(i, b) { if (b) set.set(i, b); else set.delete(i) } }, sessions: h.sessions || { list: { getSnapshot: () => ({ byId: { a: {} } }) } } })
    await assert.rejects(throwing.openWorkspace('w'), /sync boom/)
    assert.equal(set.size, 0)
    g.dispose()
    pass('a synchronous throw from openWorkspace never leaves a block behind')
  }
  { // dispose
    const h = make()
    const wrapped = h.uiWorkspace.openWorkspace
    assert.notEqual(wrapped, h.original)
    h.uiWorkspace.openWorkspace('w1')
    h.guard.dispose()
    assert.equal(h.uiWorkspace.openWorkspace, h.original)
    assert.equal(h.blocks.size, 0)
    assert.equal(h.subs.size, 0)
    pass('dispose restores the original method, clears blocks and unsubscribes')
  }
  { // version lock: unsupported shape wraps nothing
    const g = plugin.createWorkspaceTransitionGuard({ uiWorkspace: {}, blocks: { set() {} }, sessions: {} })
    assert.equal(g.pending(), false)
    const u = { openWorkspace: 'not-a-function' }
    plugin.createWorkspaceTransitionGuard({ uiWorkspace: u, blocks: { set() {} }, sessions: {} })
    assert.equal(u.openWorkspace, 'not-a-function')
    pass('an unsupported uiWorkspace shape is left untouched')
  }
  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
