'use strict'

/**
 * NexusEngineContract.Tests.cjs — Phase M3 (TASK-0040) client contract for
 * the shared engine mapping:
 *   - @nexus/controller publishes nexusEngineState (preferred profile engine
 *     plus the catalog's internal engine -> agent-preset map).
 *   - @nexus/mode-selector maps the Normal Engineering mode onto the engine's
 *     internal agent plane for NEW (blank) sessions only, and falls back to
 *     the unmodified mode id whenever the mapping is not provably available.
 * Fully OFFLINE: everything runs against in-memory stubs.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
let passed = 0
function pass(name) { passed++; console.log('PASS: ' + name) }

function loadModule(relPath, requireMap) {
  let plugin = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) { plugin = def.factory((name) => (requireMap && requireMap[name] !== undefined) ? requireMap[name] : (() => ({}))) },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), sandbox)
  return plugin
}

function makeModeScope(options) {
  const opts = options || {}
  const state = { current: opts.noSession ? undefined : 's', byId: {} }
  if (opts.noSession) {
    /* the pre-session hero posture: no current session at all */
  } else if (opts.session) {
    state.byId.s = { ...opts.session, id: 's' }
  } else {
    state.byId.s = { id: 's', blank: true, agentPreset: 'aih-engineering' }
  }
  const subscribers = new Set()
  const selectCalls = []
  const defaultPatches = []
  let failSelection = false
  const scope = {
    slots: { inject(_name, fn) { return fn() }, register(spec, component) { scope._registered.push({ spec, component }); return () => {} } },
    connection: {
      api: {
        agentPresets: {
          async list() { return { result: { ok: true, value: { presets: opts.installedPresets || [{ id: 'aih-engineering', name: 'Normal Engineering', isDefault: true }, { id: 'aih-deepseek', name: 'DeepSeek Only' }, { id: 'aih-muse', name: 'Muse Agent Plane' }] } } } },
          async select(arg) { if (failSelection) return { result: { ok: false, error: { message: 'refused' } } }; selectCalls.push(arg); return { result: { ok: true, value: { agentPreset: arg.agentPreset } } } },
        },
        settings: { async update(arg) { defaultPatches.push(arg.patch.default); return { result: { ok: true, value: {} } } } },
      },
    },
    remote: { $on() { return () => {} } },
    sessions: {
      list: {
        getSnapshot: () => state,
        subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
      },
      noteAgentPreset(id, preset) {
        state.byId = { ...state.byId, [id]: { ...state.byId[id], agentPreset: preset } }
        for (const fn of subscribers) fn()
      },
    },
    modelDirectories: { directoryFor() { return { load: async () => {}, select: async () => {}, store: { getSnapshot: () => ({ current: null }) } } } },
    inject(names, fn) { if (names.every((name) => Object.hasOwn(this, name))) fn(this) },
    get(name) { return this[name] },
    provide(name, value) { this[name] = value },
    effect() {},
    _registered: [],
    _registeredSeat: null,
    _state: state,
    _selectCalls: selectCalls,
    _defaultPatches: defaultPatches,
    _newSession(session) { state.byId[session.id] = session; state.current = session.id; for (const fn of subscribers) fn() },
  }
  return scope
}

function engineFacade(snapshot) {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

function seatControls(scope) {
  const seatEntry = scope._registered.find((entry) => entry.spec.name === 'conversation.hero.agentPreset')
  if (!seatEntry) throw new Error('mode picker seat not registered')
  return seatEntry.spec.inject()
}

async function main() {
  // ── Part A: the mode selector ──────────────────────────────────────────
  const modePlugin = loadModule('ui/nexus-mode-selector/lib/client.js')
  const resolveEnginePreset = modePlugin.resolveEnginePreset
  assert.equal(typeof resolveEnginePreset, 'function')

  const museSnapshot = { engine: 'muse', engineAgentPreset: 'aih-muse', preferredProfileId: 'muse-spark-1.3-contributor' }
  const known = new Set(['aih-engineering', 'aih-deepseek', 'aih-muse'])
  const facade = engineFacade(museSnapshot)

  assert.equal(resolveEnginePreset(facade, known, 'aih-engineering'), 'aih-muse')
  pass('A1: muse preferred maps the Normal Engineering mode onto aih-muse')
  assert.equal(resolveEnginePreset(facade, known, 'aih-deepseek'), 'aih-deepseek')
  pass('A2: the DeepSeek Only mode never maps (it is its own agent plane)')
  assert.equal(resolveEnginePreset(null, known, 'aih-engineering'), 'aih-engineering')
  pass('A3: an absent engine service maps to the unmodified mode id (pre-M3 behavior)')
  assert.equal(resolveEnginePreset(engineFacade(null), known, 'aih-engineering'), 'aih-engineering')
  pass('A4: a null engine snapshot maps to the unmodified mode id')
  assert.equal(resolveEnginePreset(engineFacade({ engine: 'dual', engineAgentPreset: null }), known, 'aih-engineering'), 'aih-engineering')
  pass('A5: a dual preference maps to the unmodified mode id')
  assert.equal(resolveEnginePreset(engineFacade({ engine: 'muse', engineAgentPreset: 'Muse Plane!' }), known, 'aih-engineering'), 'aih-engineering')
  pass('A6: a malformed agent preset id maps to the unmodified mode id (fail closed)')
  assert.equal(resolveEnginePreset(engineFacade(museSnapshot), new Set(['aih-engineering', 'aih-deepseek']), 'aih-engineering'), 'aih-engineering')
  pass('A7: a host without the aih-muse preset maps to the unmodified mode id')

  {
    const scope = makeModeScope({})
    scope.nexusEngineState = facade
    modePlugin.apply(scope)
    const controls = seatControls(scope)
    await controls.load()
    await controls.select('aih-engineering')
    assert.equal(JSON.stringify(scope._selectCalls), JSON.stringify([{ sessionId: 's', agentPreset: 'aih-muse' }]))
    pass('A8: a muse preference applies the aih-muse agent plane to the blank session')
    assert.deepEqual(scope._defaultPatches, ['aih-engineering'])
    pass('A9: the persisted default stays the user-facing mode id')
    assert.equal(scope._state.byId.s.agentPreset, 'aih-muse')
    pass('A10: the host-confirmed session summary carries the applied agent plane')
    assert.equal(scope.nexusModeState.getSnapshot().current, 'aih-engineering')
    pass('A11: the visible mode remains Normal Engineering (display unchanged)')
  }

  {
    const scope = makeModeScope({ noSession: true })
    scope.nexusEngineState = facade
    modePlugin.apply(scope)
    const controls = seatControls(scope)
    await controls.load()
    scope._newSession({ id: 's2', blank: true, agentPreset: 'aih-engineering' })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(JSON.stringify(scope._selectCalls), JSON.stringify([{ sessionId: 's2', agentPreset: 'aih-muse' }]))
    pass('A12: a muse preference auto-applies the engine plane to a NEW blank session without an explicit re-selection')
    scope._newSession({ id: 's3', blank: false, agentPreset: 'aih-engineering' })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scope._selectCalls.length, 1)
    pass('A13: a non-blank session keeps its existing plane (the engine applies from the next session)')
  }

  {
    const scope = makeModeScope({ installedPresets: [{ id: 'aih-engineering', name: 'Normal Engineering', isDefault: true }, { id: 'aih-deepseek', name: 'DeepSeek Only' }] })
    scope.nexusEngineState = facade
    modePlugin.apply(scope)
    const controls = seatControls(scope)
    await controls.load()
    await controls.select('aih-engineering')
    assert.deepEqual(scope._selectCalls, [])
    pass('A14: on a host without the muse preset the mode applies exactly as before (no engine plane, no error)')
  }

  // ── Part B: the controller's engine bridge ─────────────────────────────
  const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
  const controller = loadModule('ui/nexus-controller/lib/client.js', {
    react: requireFromApp('react'),
    'react/jsx-runtime': requireFromApp('react/jsx-runtime'),
  })
  assert.equal(typeof controller.publishNexusEngineState, 'function')
  assert.equal(typeof controller.nexusEngineStateSnapshot, 'function')
  assert.equal(typeof controller.subscribeNexusEngine, 'function')

  controller.publishNexusEngineState(null)
  assert.equal(controller.nexusEngineStateSnapshot(), null)
  pass('B1: with no editor state the shared snapshot is null (no mapping)')
  const editorState = {
    preferredProfile: { id: 'muse-spark-1.3-contributor', displayName: 'Muse Spark 1.3 Contributor' },
    nexusProfiles: [
      { id: 'glm-codex', engine: 'dual' },
      { id: 'deepseek-codex', engine: 'dual' },
      { id: 'muse-spark-1.3-contributor', engine: 'muse' },
    ],
    engineAgentPresets: { muse: 'aih-muse' },
  }
  let announced = 0
  const detach = controller.subscribeNexusEngine(() => { announced += 1 })
  controller.publishNexusEngineState(editorState)
  assert.equal(JSON.stringify(controller.nexusEngineStateSnapshot()), JSON.stringify({ engine: 'muse', engineAgentPreset: 'aih-muse', preferredProfileId: 'muse-spark-1.3-contributor' }))
  assert.ok(announced >= 1)
  pass('B2: the muse preference publishes engine=muse with the catalog agent-preset binding')
  controller.publishNexusEngineState({ ...editorState, preferredProfile: { id: 'glm-codex', displayName: 'GLM Codex' } })
  assert.equal(JSON.stringify(controller.nexusEngineStateSnapshot()), JSON.stringify({ engine: 'dual', engineAgentPreset: null, preferredProfileId: 'glm-codex' }))
  pass('B3: a dual preference publishes engine=dual with NO agent-preset mapping')
  detach()
  controller.publishNexusEngineState({ ...editorState, engineAgentPresets: { muse: 'Bad Id!' } })
  assert.equal(controller.nexusEngineStateSnapshot().engineAgentPreset, null)
  pass('B4: a malformed catalog binding publishes no mapping (fail closed downstream)')

  {
    const provided = {}
    const fakeCtx = {
      provide(name, value) { provided[name] = value },
      effect(fn) { return () => {} },
      inject(deps, callback) { for (const name of deps) void name },
      slots: { inject() {}, register() { return () => {} } },
    }
    controller.apply(fakeCtx)
    assert.ok(provided.nexusEngineState, 'controller publishes the shared nexusEngineState service')
    assert.equal(typeof provided.nexusEngineState.getSnapshot, 'function')
    assert.equal(typeof provided.nexusEngineState.subscribe, 'function')
    pass('B5: the controller apply() publishes the nexusEngineState service')
  }

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
}

main().catch((error) => {
  console.error('SUITE RESULT: PASS ' + passed + ' | FAIL 1 | total ' + (passed + 1))
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
