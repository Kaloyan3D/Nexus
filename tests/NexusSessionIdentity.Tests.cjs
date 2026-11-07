'use strict'
// NexusSessionIdentity.Tests.cjs — regression found by real-browser acceptance on DSH 0.2.2-rc.1:
// the 0.2 sessions state has no `current`; the displayed session is the main-view-retained one.
// The Controller panel previously polled `session=` (empty) and showed "No managed task" for a
// bound session. The helper must pick the retained session, ignore stale legacy `current`, and
// return undefined when nothing is displayed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
let plugin
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/nexus-controller/lib/client.js'), 'utf8'),
  { console: { error() {}, log() {}, warn() {} }, window: { __ModuleLoader__: { load(def) { plugin = def.factory(() => ({})) } } } })
const pick = plugin.currentSessionIdOf
let passed = 0
const pass = (m) => { passed++; console.log('PASS: ' + m) }
assert.equal(pick({ byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: 1 } } } }), 'b'); pass('main-view-retained session is the displayed one')
assert.equal(pick({ byId: { a: { retainedBy: { mainView: 0 } } } }), undefined); pass('no retained session → undefined (hero/blank, never a guessed id)')
assert.equal(pick({ current: 'a', byId: { a: {}, b: { retainedBy: { mainView: 1 } } } }), 'a'); pass('a legacy `current` naming a known session is honoured')
assert.equal(pick({ current: 'gone', byId: { b: { retainedBy: { mainView: 2 } } } }), 'b'); pass('a stale `current` naming an unknown session is rejected')
assert.equal(pick(undefined), undefined); assert.equal(pick({}), undefined); pass('malformed state fails closed')
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
