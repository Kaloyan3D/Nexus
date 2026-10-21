'use strict'

// EM-04C2 S4: the closed Native mode/engine table, the dormant `engineering-v2-adaptive` mode, the
// saved-configuration requirement, and the selection grammar. Pure and offline: the issuer is driven
// through injected services; the bridge's selection parser is exercised through the real script.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const issuer = require('../config/registry/native-issuer.cjs')
const schemas = require('../config/registry/schemas.cjs')
const serviceModule = require('../config/registry/service.cjs')

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('PASS: ' + label)
}

function readMode(file) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'modes', file), 'utf8'))
}

check('the Native scope table is closed, frozen and exactly the two reviewed modes', () => {
  assert.deepEqual(Object.keys(issuer.NATIVE_SCOPES).sort(), ['engineering-v2', 'engineering-v2-adaptive'])
  assert.ok(Object.isFrozen(issuer.NATIVE_SCOPES))
  for (const s of Object.values(issuer.NATIVE_SCOPES)) assert.ok(Object.isFrozen(s))
  assert.equal(issuer.scopeOf('engineering-v2').engineId, 'muse-v0')
  assert.equal(issuer.scopeOf('engineering-v2').requiresSavedConfiguration, false)
  assert.equal(issuer.scopeOf('engineering-v2-adaptive').engineId, 'muse-v1')
  assert.equal(issuer.scopeOf('engineering-v2-adaptive').requiresSavedConfiguration, true)
  // nothing else is a mode: unknown, planned, inherited and non-string names
  for (const bad of ['engineering-v3', 'engineering-v1', 'engineering-v2-adaptive ', 'ENGINEERING-V2', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 3, {}, []]) {
    assert.equal(issuer.scopeOf(bad), null, JSON.stringify(bad))
  }
  assert.equal(issuer.SUPPORTED_MODE_ID, 'engineering-v2', 'the default mode is unchanged')
})

check('the shipped adaptive definition is valid, names muse-v1 and is DORMANT; engineering-v2 is untouched', () => {
  const adaptive = readMode('engineering-v2-adaptive.json')
  assert.deepEqual(schemas.validateModeDefinition(adaptive, 'mode'), [])
  assert.equal(adaptive.id, 'engineering-v2-adaptive')
  assert.equal(adaptive.orchestrationEngineId, 'muse-v1')
  assert.equal(adaptive.runnable, false)
  assert.equal(adaptive.selectable, false)
  assert.equal(adaptive.status, 'planned')
  assert.equal('requestBudgetBytes' in adaptive, false, 'no budget is declared before C2 step S7')
  const v2 = readMode('engineering-v2.json')
  assert.equal(v2.orchestrationEngineId, 'muse-v0')
  assert.equal(v2.runnable, true)
  assert.equal(v2.selectable, true)
  assert.equal(v2.status, 'active-legacy')
})

// ---- the issuer, through injected services --------------------------------------------------

function fakeService(opts) {
  const o = opts || {}
  const binding = Object.assign({
    resolutionId: 'a'.repeat(64), modeId: o.modeId, orchestrationEngineId: o.engineId, modeConfigRevision: 1, roleId: 'muse_main',
    logicalModelId: 'm', routeId: 'p/m', providerId: 'p', remoteModelId: 'r', connectionId: 'c', executionKind: 'raw-model', accessType: 'api-key',
    protocolId: 'openai-responses', reasoning: 'low', requiredCapabilities: ['toolCalling'], slotRequirements: { toolCalling: true }, dataUseTier: 'standard',
  }, o.binding || {})
  const calls = []
  return {
    calls,
    getModeConfiguration(modeId) {
      calls.push(['get', modeId])
      if (o.unresolved) return { result: null, errors: [{ code: 'legacy-profile-unavailable' }] }
      return { result: { modeId, persisted: o.persisted === true, revision: 1, config: { schemaVersion: 1, modeId, revision: 1, slots: {}, roleOverrides: {} } }, errors: [] }
    },
    compilePreview(config) {
      calls.push(['compile', config.modeId])
      return { ok: true, snapshot: { schemaVersion: 1, modeId: config.modeId, orchestrationEngineId: o.snapshotEngine !== undefined ? o.snapshotEngine : o.engineId, configurationRevision: 1, resolutionId: 'a'.repeat(64), roles: { muse_main: binding } }, errors: [] }
    },
  }
}

const OPTS = { installRoot: '/x', dataRoot: '/y' }

check('engineering-v2 compiles exactly as before: unsaved is fine, engine muse-v0', () => {
  const svc = fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0', persisted: false })
  const c = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2' }, OPTS), { service: svc })
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(c.binding.orchestrationEngineId, 'muse-v0')
  // the default (no modeId) is the same mode
  const d = issuer.compileTrustedMode(OPTS, { service: fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0' }) })
  assert.equal(d.ok, true)
  assert.equal(d.snapshot.modeId, 'engineering-v2')
})

check('the adaptive mode requires an operator-SAVED configuration; nothing is created or previewed for it', () => {
  const unsaved = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'muse-v1', persisted: false })
  const r = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: unsaved })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'registry-mode-configuration-required')
  assert.ok(!unsaved.calls.some((c) => c[0] === 'compile'), 'it never even compiled a preview')
  const unresolved = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'muse-v1', unresolved: true })
  assert.equal(issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: unresolved }).code, 'registry-mode-configuration-required')
  // while engineering-v2 keeps its own code for an unresolvable configuration
  assert.equal(issuer.compileTrustedMode(OPTS, { service: fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0', unresolved: true }) }).code, 'registry-unresolved')
  const saved = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'muse-v1', persisted: true })
  const ok = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: saved })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.persisted, true)
})

check('the shipped definition must declare an engine the reviewed table allows for its mode', () => {
  // the adaptive mode may name only muse-v1; engineering-v2 only muse-v0 or a listed experimental engine
  for (const [mode, engine] of [['engineering-v2-adaptive', 'muse-v0'], ['engineering-v2', 'muse-v1'], ['engineering-v2-adaptive', 'dual-v1'], ['engineering-v2', 'nova-v3'], ['engineering-v2', 'dual-v1'], ['engineering-v2-adaptive', 'muse-v1-shadow'], ['engineering-v2-adaptive', 'effort-test-v0'], ['engineering-v2', '']]) {
    const svc = fakeService({ modeId: mode, engineId: engine, persisted: true })
    const r = issuer.compileTrustedMode(Object.assign({ modeId: mode }, OPTS), { service: svc })
    assert.equal(r.ok, false, mode + '/' + engine)
    assert.equal(r.code, 'registry-unsupported-scope', mode + '/' + engine)
  }
  // the experimental engines remain usable in the default mode (fixtures drive them end to end)
  for (const engine of ['muse-v0', 'effort-test-v0', 'muse-v1-shadow', 'muse-v1-signals']) {
    const r = issuer.compileTrustedMode(OPTS, { service: fakeService({ modeId: 'engineering-v2', engineId: engine }) })
    assert.equal(r.ok, true, engine)
  }
  assert.equal(issuer.engineAllowed(issuer.scopeOf('engineering-v2-adaptive'), 'muse-v1'), true)
  assert.equal(issuer.engineAllowed(issuer.scopeOf('engineering-v2'), 'muse-v1'), false, 'production muse-v1 is never issuable in the default mode')
})

check('unknown modes, inherited names and foreign roles are refused with the scope code', () => {
  for (const bad of ['engineering-v3', 'engineering-v1', '__proto__', 'constructor', 'nonsense', 'engineering-v2-adaptive ']) {
    const r = issuer.compileTrustedMode(Object.assign({ modeId: bad }, OPTS), { service: fakeService({ modeId: bad, engineId: 'muse-v0', persisted: true }) })
    assert.equal(r.ok, false, bad)
    assert.equal(r.code, 'registry-unsupported-scope', bad)
  }
  const r = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2', role: 'reviewer' }, OPTS), { service: fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0' }) })
  assert.equal(r.code, 'registry-unsupported-scope')
})

check('issuance seals the mode and engine of the chosen scope, and refuses any mismatched binding', () => {
  const svc = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'muse-v1', persisted: true })
  const c = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: svc })
  const out = issuer.issueForGeneration(c, 'task-1')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.issuance.modeId, 'engineering-v2-adaptive')
  assert.equal(out.issuance.resolution.target.modeId, 'engineering-v2-adaptive')
  assert.equal(out.issuance.resolution.target.orchestrationEngineId, 'muse-v1')
  const def = issuer.issueForGeneration(issuer.compileTrustedMode(OPTS, { service: fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0' }) }), 'task-1')
  assert.equal(def.ok, true)
  assert.equal(def.issuance.modeId, 'engineering-v2')
  // a binding whose engine disagrees with its mode's reviewed engines
  for (const [mode, engine] of [['engineering-v2-adaptive', 'muse-v0'], ['engineering-v2', 'muse-v1'], ['engineering-v2-adaptive', 'muse-v1-signals']]) {
    const forged = { ok: true, binding: Object.assign({}, c.binding, { modeId: mode, orchestrationEngineId: engine }), snapshot: c.snapshot, modeConfig: c.modeConfig, persisted: true }
    const r = issuer.issueForGeneration(forged, 'task-1')
    assert.equal(r.ok, false, mode + '/' + engine)
    assert.equal(r.code, 'registry-role-unauthorized')
  }
  // a mode outside the table
  const outside = { ok: true, binding: Object.assign({}, c.binding, { modeId: 'engineering-v3', orchestrationEngineId: 'nova-v3' }), snapshot: c.snapshot, modeConfig: c.modeConfig, persisted: true }
  assert.equal(issuer.issueForGeneration(outside, 'task-1').ok, false)
  // identities differ: the two modes can never share an issuance
  assert.notEqual(out.issuance.issuanceId, def.issuance.issuanceId)
})

// ---- the real service ------------------------------------------------------------------------

function listing(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

check('the real Registry has no default for the adaptive mode, cannot adopt a legacy profile for it and writes nothing', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-s4-'))
  try {
    const svc = serviceModule.createService({ installRoot: repoRoot, dataRoot })
    assert.ok(serviceModule.SUPPORTED_MODES.includes('engineering-v2-adaptive'))
    const before = listing(dataRoot)
    const got = svc.getModeConfiguration('engineering-v2-adaptive', {})
    assert.equal(got.result, null)
    assert.equal(got.errors[0].code, 'mode-configuration-required')
    for (const adopt of ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode', 'deepseek-codex', 'custom']) {
      const a = svc.getModeConfiguration('engineering-v2-adaptive', { adopt })
      assert.equal(a.result, null, adopt)
      assert.ok(a.errors.length > 0, adopt)
    }
    assert.deepEqual(listing(dataRoot), before, 'reading a mode never creates a configuration')
    // while dormant the Registry will not even save one
    const cfg = { schemaVersion: 1, modeId: 'engineering-v2-adaptive', revision: null, slots: { main: { logicalModelId: 'x', routeId: 'y', reasoning: 'low' } }, roleOverrides: {} }
    const saved = svc.save('engineering-v2-adaptive', cfg, null, {})
    assert.equal(saved.ok, false)
    assert.deepEqual(listing(dataRoot), before, 'a refused save writes nothing')
    // the mode is listed honestly: present, engine muse-v1, not executable, not persisted
    const modes = svc.listModes().modes
    const m = modes.find((x) => x.id === 'engineering-v2-adaptive')
    assert.ok(m && m.present)
    assert.equal(m.orchestrationEngineId, 'muse-v1')
    assert.equal(m.executable, false)
    assert.equal(m.persisted, false)
    assert.equal(m.selectable, false)
    // engineering-v2 is as before: a preview exists without any saved configuration
    const v2 = svc.getModeConfiguration('engineering-v2', {})
    assert.ok(v2.result && v2.result.persisted === false && v2.result.config)
    assert.equal(modes.find((x) => x.id === 'engineering-v2').executable, true)
    assert.deepEqual(listing(dataRoot), before)
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

// ---- the selection grammar, through the real bridge script ----------------------------------

function parsed(selection) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'config', 'registry', 'native-intent-bridge.cjs'), 'target-info', '/nonexistent-install', '/nonexistent-data', typeof selection === 'string' ? selection : JSON.stringify(selection)], { encoding: 'utf8' })
  const line = String(r.stdout || '').trim().split('\n').pop()
  try { return JSON.parse(line) } catch { return { ok: false, code: 'unparseable', raw: line } }
}

check('the selection accepts exactly three closed shapes; any other is refused as bad-args', () => {
  const accepted = (s) => parsed(s).code !== 'bad-args'
  // accepted (they go on to fail later because the roots do not exist, never as bad-args)
  assert.ok(accepted({ logicalModelId: 'm', routeId: 'r' }))
  assert.ok(accepted({ logicalModelId: 'm', routeId: 'r', modeId: 'engineering-v2' }))
  assert.ok(accepted({ logicalModelId: 'm', routeId: 'r', modeId: 'engineering-v2-adaptive' }))
  assert.ok(accepted({ modeId: 'engineering-v2' }))
  assert.ok(accepted({ modeId: 'engineering-v2-adaptive' }))
  // refused: unknown or non-string modes, extra and missing keys, wrong types
  for (const bad of [
    { modeId: 'engineering-v3' }, { modeId: 'nonsense' }, { modeId: '' }, { modeId: '__proto__' }, { modeId: 'constructor' },
    { modeId: 3 }, { modeId: null }, { modeId: ['engineering-v2'] }, { modeId: 'engineering-v2-adaptive ' }, { modeId: 'ENGINEERING-V2' },
    { logicalModelId: 'm', routeId: 'r', modeId: 'engineering-v3' }, { logicalModelId: 'm', modeId: 'engineering-v2' }, { routeId: 'r', modeId: 'engineering-v2' },
    { logicalModelId: 'm', routeId: 'r', modeId: 'engineering-v2', extra: 1 }, { modeId: 'engineering-v2', extra: 1 },
    { logicalModelId: 'm' }, { routeId: 'r' }, {}, { logicalModelId: 1, routeId: 'r' }, { logicalModelId: 'm', routeId: 'r', mode: 'engineering-v2-adaptive' },
    [], 'engineering-v2-adaptive', 7,
  ]) {
    assert.equal(parsed(bad).code, 'bad-args', JSON.stringify(bad))
  }
  assert.equal(parsed('{not json').code, 'bad-args')
})

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
