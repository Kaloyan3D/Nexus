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
  assert.equal(issuer.scopeOf('engineering-v2-adaptive').engineId, 'nexus-adaptive-v1')
  assert.equal(issuer.scopeOf('engineering-v2-adaptive').requiresSavedConfiguration, true)
  // nothing else is a mode: unknown, planned, inherited and non-string names
  for (const bad of ['engineering-v3', 'engineering-v1', 'engineering-v2-adaptive ', 'ENGINEERING-V2', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 3, {}, []]) {
    assert.equal(issuer.scopeOf(bad), null, JSON.stringify(bad))
  }
  assert.equal(issuer.SUPPORTED_MODE_ID, 'engineering-v2', 'the default mode is unchanged')
})

check('the shipped adaptive definition is valid, names nexus-adaptive-v1 and is DORMANT; engineering-v2 is untouched', () => {
  const adaptive = readMode('engineering-v2-adaptive.json')
  assert.deepEqual(schemas.validateModeDefinition(adaptive, 'mode'), [])
  assert.equal(adaptive.id, 'engineering-v2-adaptive')
  assert.equal(adaptive.orchestrationEngineId, 'nexus-adaptive-v1')
  assert.equal(adaptive.runnable, false)
  assert.equal(adaptive.selectable, false)
  assert.equal(adaptive.status, 'planned')
  assert.equal(adaptive.requestBudgetBytes, 440000, 'EM-04C2 S7: the intended sealed request budget (measured A614 maximum with the real catalog stays below it)')
  assert.ok(adaptive.requestBudgetBytes < 450000, 'strictly below the unchanged A614 guard')
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
  const unsaved = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'nexus-adaptive-v1', persisted: false })
  const r = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: unsaved })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'registry-mode-configuration-required')
  assert.ok(!unsaved.calls.some((c) => c[0] === 'compile'), 'it never even compiled a preview')
  const unresolved = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'nexus-adaptive-v1', unresolved: true })
  assert.equal(issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: unresolved }).code, 'registry-mode-configuration-required')
  // while engineering-v2 keeps its own code for an unresolvable configuration
  assert.equal(issuer.compileTrustedMode(OPTS, { service: fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0', unresolved: true }) }).code, 'registry-unresolved')
  const saved = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'nexus-adaptive-v1', persisted: true })
  const ok = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: saved })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.persisted, true)
})

check('the shipped definition must declare an engine the reviewed table allows for its mode', () => {
  // the adaptive mode may name only nexus-adaptive-v1; engineering-v2 only muse-v0 or a listed experimental engine
  for (const [mode, engine] of [['engineering-v2-adaptive', 'muse-v0'], ['engineering-v2', 'nexus-adaptive-v1'], ['engineering-v2-adaptive', 'dual-v1'], ['engineering-v2', 'nova-v3'], ['engineering-v2', 'dual-v1'], ['engineering-v2-adaptive', 'muse-v1-shadow'], ['engineering-v2-adaptive', 'effort-test-v0'], ['engineering-v2', '']]) {
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
  assert.equal(issuer.engineAllowed(issuer.scopeOf('engineering-v2-adaptive'), 'nexus-adaptive-v1'), true)
  assert.equal(issuer.engineAllowed(issuer.scopeOf('engineering-v2'), 'nexus-adaptive-v1'), false, 'production nexus-adaptive-v1 is never issuable in the default mode')
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
  const svc = fakeService({ modeId: 'engineering-v2-adaptive', engineId: 'nexus-adaptive-v1', persisted: true })
  const c = issuer.compileTrustedMode(Object.assign({ modeId: 'engineering-v2-adaptive' }, OPTS), { service: svc })
  const out = issuer.issueForGeneration(c, 'task-1')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.issuance.modeId, 'engineering-v2-adaptive')
  assert.equal(out.issuance.resolution.target.modeId, 'engineering-v2-adaptive')
  assert.equal(out.issuance.resolution.target.orchestrationEngineId, 'nexus-adaptive-v1')
  const def = issuer.issueForGeneration(issuer.compileTrustedMode(OPTS, { service: fakeService({ modeId: 'engineering-v2', engineId: 'muse-v0' }) }), 'task-1')
  assert.equal(def.ok, true)
  assert.equal(def.issuance.modeId, 'engineering-v2')
  // a binding whose engine disagrees with its mode's reviewed engines
  for (const [mode, engine] of [['engineering-v2-adaptive', 'muse-v0'], ['engineering-v2', 'nexus-adaptive-v1'], ['engineering-v2-adaptive', 'muse-v1-signals']]) {
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
    // the mode is listed honestly: present, engine nexus-adaptive-v1, not executable, not persisted
    const modes = svc.listModes().modes
    const m = modes.find((x) => x.id === 'engineering-v2-adaptive')
    assert.ok(m && m.present)
    assert.equal(m.orchestrationEngineId, 'nexus-adaptive-v1')
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


// ---- EM-04C2 S7: the sealed request budget is Registry policy, validated, and the mode stays dormant ----
check('the budget is validated by the Registry: missing is legal, forged values are rejected', () => {
  const base = readMode('engineering-v2-adaptive.json')
  assert.deepEqual(schemas.validateModeDefinition(base, 'mode'), [])
  const without = { ...base }
  delete without.requestBudgetBytes
  assert.deepEqual(schemas.validateModeDefinition(without, 'mode'), [], 'a mode may declare none (the runtime then refuses to dispatch it)')
  for (const bad of [0, -1, 65535, 4194305, 440000.5, '440000', null, true, [], {}, NaN, Infinity]) {
    const errors = schemas.validateModeDefinition({ ...base, requestBudgetBytes: bad }, 'mode')
    assert.ok(errors.some((e) => e.code === 'mode-invalid' && /requestBudgetBytes/.test(e.path)), 'rejected: ' + JSON.stringify(bad))
  }
  for (const ok of [65536, 440000, 449999, 4194304]) {
    assert.deepEqual(schemas.validateModeDefinition({ ...base, requestBudgetBytes: ok }, 'mode'), [], String(ok))
  }
})

check('the budget survives resolution into the sealed target and a forged binding budget is rejected', () => {
  const resolver = require('../config/registry/resolver.cjs')
  assert.equal(typeof resolver, 'object')
  const src = fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'resolver.cjs'), 'utf8')
  assert.match(src, /requestBudgetBytes: mode\.requestBudgetBytes/, 'the compiled target carries the mode budget')
  assert.match(src, /b\.requestBudgetBytes !== undefined/, 'the binding carries it too')
  const errors = schemas.validateRuntimeModelBinding({ schemaVersion: 1, requestBudgetBytes: 1 }, 'binding')
  assert.ok(errors.some((e) => /requestBudgetBytes/.test(e.path || '')), 'a binding budget below the minimum is invalid')
  for (const bad of [65535, 4194305, 1.5, '440000']) {
    assert.ok(schemas.validateRuntimeModelBinding({ schemaVersion: 1, requestBudgetBytes: bad }, 'binding').some((e) => /requestBudgetBytes/.test(e.path || '')), 'forged binding budget ' + JSON.stringify(bad))
  }
})

check('the adaptive mode stays dormant: planned, not selectable/runnable, absent from every install closure', () => {
  const adaptive = readMode('engineering-v2-adaptive.json')
  assert.equal(adaptive.status, 'planned')
  assert.equal(adaptive.selectable, false)
  assert.equal(adaptive.runnable, false)
  const closureSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'MusePresetDependencyClosure.cjs'), 'utf8')
  assert.equal(closureSrc.includes('engineering-v2-adaptive'), false, 'not pinned by the installer closure')
  const closure = require('../scripts/MusePresetDependencyClosure.cjs')
  for (const profile of ['muse', 'controller', 'engineering', 'deepseek']) {
    const c = closure.closure(repoRoot, { profile })
    assert.equal(JSON.stringify(c).includes('engineering-v2-adaptive'), false, profile)
  }
})


// ---- EM-04C2 S7: the optional adaptive definition must not disturb installations that lack it ----
check('snapshot completeness is judged by REQUIRED legacy modes, not by a count (3-file install and 4-file tree)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-optional-mode-'))
  try {
    const copyRegistry = (tag, drop) => {
      const dir = path.join(tmp, tag, 'config')
      fs.mkdirSync(dir, { recursive: true })
      fs.cpSync(path.join(repoRoot, 'config', 'registry'), path.join(dir, 'registry'), { recursive: true })
      for (const f of ['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']) {
        fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(dir, f))
      }
      for (const f of drop) fs.rmSync(path.join(dir, 'registry', 'modes', f))
      return path.join(tmp, tag)
    }
    const build = (root) => require(path.join(root, 'config', 'registry', 'legacy-import.cjs')).buildRegistrySnapshot(root)
    const full = copyRegistry('tree', [])
    const installed = copyRegistry('installed', ['engineering-v2-adaptive.json'])
    const broken = copyRegistry('broken', ['engineering-v2.json'])
    for (const root of [full, installed]) {
      const r = build(root)
      assert.equal(r.errors.includes('registry-mode-definitions-incomplete'), false, root)
    }
    assert.equal(build(full).snapshot.modes.length, 4)
    assert.equal(build(installed).snapshot.modes.length, 3)
    assert.equal(build(broken).errors.includes('registry-mode-definitions-incomplete'), true, 'a missing REQUIRED mode is still incomplete')
    // listing: an installation without the adaptive definition shows no phantom row for it
    const list = (root) => require(path.join(root, 'config', 'registry', 'service.cjs')).createService({ installRoot: root, dataRoot: path.join(root, 'data') }).listModes()
    assert.deepEqual(list(installed).modes.map((m) => m.id), ['engineering-v1', 'engineering-v2', 'engineering-v3'])
    const withIt = list(full).modes.map((m) => m.id)
    assert.deepEqual(withIt, ['engineering-v1', 'engineering-v2', 'engineering-v2-adaptive', 'engineering-v3'])
    const adaptive = list(full).modes.find((m) => m.id === 'engineering-v2-adaptive')
    assert.equal(adaptive.selectable, false)
    assert.equal(adaptive.runnable, false)
    assert.equal(adaptive.executable, false)
    // a missing REQUIRED definition is still reported, as before
    const gone = list(broken).modes.find((m) => m.id === 'engineering-v2')
    assert.equal(gone.present, false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})


// ---- EM-04C2 S7-S9 Registry review: the optional definition's closed identity and its invariants ----
{
  const reviewTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-review-'))
  const install = (tag, mutate) => {
    const root = path.join(reviewTmp, tag)
    const dir = path.join(root, 'config')
    fs.mkdirSync(dir, { recursive: true })
    fs.cpSync(path.join(repoRoot, 'config', 'registry'), path.join(dir, 'registry'), { recursive: true })
    for (const f of ['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(dir, f))
    if (mutate) mutate(path.join(dir, 'registry', 'modes'))
    return root
  }
  const service = (root, data) => require(path.join(root, 'config', 'registry', 'service.cjs')).createService({ installRoot: root, dataRoot: data || path.join(reviewTmp, 'data-' + path.basename(root)) })
  const legacy = (root) => require(path.join(root, 'config', 'registry', 'legacy-import.cjs'))
  const LEGACY_IDS = ['engineering-v1', 'engineering-v2', 'engineering-v3']
  const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : [])

  check('the adaptive definition is recognized only through its closed identity; anything else is absent', () => {
    const good = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'modes', 'engineering-v2-adaptive.json'), 'utf8'))
    const cases = {
      'another mode id (a duplicate of the default mode)': { ...good, id: 'engineering-v2' },
      'an unknown mode id': { ...good, id: 'engineering-v9' },
      'another engine': { ...good, orchestrationEngineId: 'muse-v0' },
      'schema-invalid (no slots)': { ...good, slots: [] },
      'schema-invalid (unknown field)': { ...good, executionGrant: true },
      'schema-invalid (budget out of range)': { ...good, requestBudgetBytes: 5 },
      'an array': [good],
      'an empty object': {},
    }
    const files = { 'not JSON': '{"id": "engineering-v2-adaptive",' }
    const run = (label, body) => {
      const root = install('closed-' + label.replace(/\W+/g, '-'), (dir) => fs.writeFileSync(path.join(dir, 'engineering-v2-adaptive.json'), body))
      const built = legacy(root).buildRegistrySnapshot(root)
      assert.deepEqual(built.snapshot.modes.map((m) => m.id), LEGACY_IDS, label)
      assert.equal(built.errors.includes('registry-mode-definitions-incomplete'), false, label)
      const svc = service(root)
      assert.deepEqual(svc.listModes().modes.map((m) => m.id), LEGACY_IDS, label)
      // the real default mode is untouched by the bad document
      assert.equal(svc.listModes().modes.find((m) => m.id === 'engineering-v2').executable, true, label)
      assert.equal(svc.getModeConfiguration('engineering-v2-adaptive', {}).result, null, label)
    }
    for (const [label, doc] of Object.entries(cases)) run(label, JSON.stringify(doc))
    for (const [label, body] of Object.entries(files)) run(label, body)
  })

  check('unknown or stray files and mode ids never become importable, listable or executable', () => {
    const root = install('stray', (dir) => {
      for (const f of ['engineering-v9.json', 'engineering-v4.json', 'engineering-v2-adaptive.json.bak', 'engineering-v2-adaptive.json~', 'ENGINEERING-V2-ADAPTIVE.json', 'extra.json']) {
        fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(dir, 'engineering-v2-adaptive.json')))
      }
    })
    const built = legacy(root).buildRegistrySnapshot(root)
    assert.deepEqual(built.snapshot.modes.map((m) => m.id), ['engineering-v1', 'engineering-v2', 'engineering-v2-adaptive', 'engineering-v3'])
    const svc = service(root)
    assert.deepEqual(svc.listModes().modes.map((m) => m.id), ['engineering-v1', 'engineering-v2', 'engineering-v2-adaptive', 'engineering-v3'])
    for (const id of ['engineering-v9', 'engineering-v4', 'extra', 'ENGINEERING-V2-ADAPTIVE', '__proto__', 'constructor', '']) {
      const r = svc.getModeConfiguration(id, {})
      assert.equal(r.result, null, id)
      assert.ok(r.errors.some((e) => e.code === 'unknown-mode'), id)
      const saved = svc.save(id, { schemaVersion: 1, modeId: id, revision: 0, slots: {}, roleOverrides: {} }, undefined, {})
      assert.equal(saved.ok, false, 'save ' + id)
    }
  })

  check('listing, snapshot, preview and import are read-only and carry no execution authorization', () => {
    const root = install('readonly')
    const data = path.join(reviewTmp, 'data-readonly')
    const svc = service(root, data)
    const before = tree(data)
    const outputs = [
      svc.listModes(),
      svc.getModeConfiguration('engineering-v2-adaptive', {}),
      svc.getModeConfiguration('engineering-v2-adaptive', { adopt: 'anything' }),
      legacy(root).buildRegistrySnapshot(root),
    ]
    assert.deepEqual(tree(data), before, 'no file was created under the data root')
    const text = JSON.stringify(outputs)
    for (const forbidden of ['issuanceId', 'taskBinding', 'taskInstanceId', 'dispatch', 'extensionDigest', '"grant"']) {
      assert.equal(text.includes(forbidden), false, forbidden)
    }
    // the adaptive row is honest, and nothing about it is adoptable or preset
    const row = outputs[0].modes.find((m) => m.id === 'engineering-v2-adaptive')
    assert.equal(row.status, 'planned')
    assert.equal(row.selectable, false)
    assert.equal(row.runnable, false)
    assert.equal(row.executable, false)
    assert.equal(row.savedRevision, null)
    assert.equal(outputs[1].result, null)
    assert.deepEqual(outputs[1].errors.map((e) => e.code), ['mode-configuration-required'])
    assert.equal(outputs[2].result, null)
    // an operator configuration exists only after an explicit save, and a save of the dormant mode is refused
    assert.equal(svc.save('engineering-v2-adaptive', { schemaVersion: 1, modeId: 'engineering-v2-adaptive', revision: 0, slots: { main: { logicalModelId: 'x', routeId: 'y', reasoning: 'low' } }, roleOverrides: {} }, undefined, {}).ok, false)
    assert.deepEqual(tree(data), before, 'a refused save created nothing')
  })

  check('saved Registry configurations survive the adaptive definition appearing and disappearing', () => {
    const data = path.join(reviewTmp, 'data-shared')
    const three = install('upgrade-three', (dir) => fs.rmSync(path.join(dir, 'engineering-v2-adaptive.json')))
    const four = install('upgrade-four')
    const s3 = service(three, data)
    const staged = s3.getModeConfiguration('engineering-v2', {})
    const saved = s3.save('engineering-v2', staged.result.config, undefined, {})
    assert.equal(saved.ok, true, JSON.stringify(saved.errors || []))
    const rowOf = (svc, id) => svc.listModes().modes.find((m) => m.id === id)
    assert.equal(rowOf(s3, 'engineering-v2').savedRevision, 0)
    // "upgrade": the same data root under an installation that now carries the dormant definition
    const s4 = service(four, data)
    assert.equal(rowOf(s4, 'engineering-v2').savedRevision, 0)
    assert.equal(rowOf(s4, 'engineering-v2').savedValid, true)
    assert.equal(s4.getModeConfiguration('engineering-v2', {}).result.persisted, true)
    assert.deepEqual(s4.getModeConfiguration('engineering-v2', {}).result.config, staged.result.config)
    assert.equal(rowOf(s4, 'engineering-v2-adaptive').savedRevision, null, 'nothing was created for the adaptive mode')
    // "downgrade": and back
    const again = service(three, data)
    assert.equal(rowOf(again, 'engineering-v2').savedRevision, 0)
    assert.equal(rowOf(again, 'engineering-v2').savedValid, true)
    // the stored document is untouched by all of it
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'registry', 'mode-configurations.json'), 'utf8')).modes), ['engineering-v2'])
  })

  check('the default engineering-v2 compiles identically with and without the dormant definition', () => {
    const data = path.join(reviewTmp, 'data-default')
    const three = install('default-three', (dir) => fs.rmSync(path.join(dir, 'engineering-v2-adaptive.json')))
    const four = install('default-four')
    const cfg = service(three, data).getModeConfiguration('engineering-v2', {}).result.config
    const strip = (r) => JSON.stringify(r, (k, v) => (k === 'modes' ? undefined : v))
    const a = service(three, data).compilePreview(cfg)
    const b = service(four, data).compilePreview(cfg)
    assert.equal(a.ok, true)
    assert.equal(strip(a), strip(b))
    // the engine the default mode names is still muse-v0, and the issuer's closed table is unchanged
    assert.equal(JSON.parse(fs.readFileSync(path.join(four, 'config', 'registry', 'modes', 'engineering-v2.json'), 'utf8')).orchestrationEngineId, 'muse-v0')
    assert.equal(issuer.scopeOf('engineering-v2').engineId, 'muse-v0')
    // the three legacy definitions are byte-identical to the pre-adaptive baseline's? (pinned by digest)
    const crypto = require('node:crypto')
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(four, 'config', 'registry', 'modes', f))).digest('hex')
    assert.equal(sha('engineering-v2.json'), crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'modes', 'engineering-v2.json'))).digest('hex'))
  })

  process.on('exit', () => fs.rmSync(reviewTmp, { recursive: true, force: true }))
}


// ---- EM-04C2 S10 preflight SEC-2: the adaptive reasoning contract is a closed, enforced table ----
{
  const resolver = require('../config/registry/resolver.cjs')
  const okModel = { id: 'm', dataUseTier: 'standard', capabilities: { toolCalling: true, reasoning: true } }
  const okRoute = { id: 'r', executionKind: 'raw-model', compatibility: { transport: 'openai-responses' }, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }
  const okProvider = { id: 'p', metadata: {} }
  const okAssign = { reasoning: 'low', allowedReasoning: ['low', 'medium', 'high', 'xhigh'] }
  const judge = (over) => resolver.checkAdaptiveContract('nexus-adaptive-v1', {}, 'muse_main', Object.assign({}, okModel, over.model), Object.assign({}, okRoute, over.route), { provider: Object.assign({}, okProvider, over.provider), assignment: over.assignment === null ? undefined : Object.assign({}, okAssign, over.assignment) })
  const codes = (errs) => errs.map((e) => e.code)

  check('the contract table is closed and frozen: muse-v0 (legacy) and nexus-adaptive-v1 only; unknown contracts fail closed', () => {
    assert.deepEqual(Object.keys(resolver.ADAPTIVE_CONTRACTS).sort(), ['muse-v0', 'nexus-adaptive-v1'])
    assert.ok(Object.isFrozen(resolver.ADAPTIVE_CONTRACTS) && Object.isFrozen(resolver.ADAPTIVE_CONTRACTS['nexus-adaptive-v1']))
    for (const bad of ['muse-v2', 'MUSE-V1', 'NEXUS-ADAPTIVE-V1', 'nexus-adaptive-v1 ', 'muse-v1', 'muse-v1 ', '', '__proto__', 'constructor', 'toString', null, 7, {}]) {
      const e = resolver.checkAdaptiveContract(bad, {}, 'muse_main', okModel, okRoute, {})
      assert.deepEqual(codes(e), ['slot-capability-not-satisfied'], JSON.stringify(bad))
      assert.match(e[0].message, /unknown adaptiveReasoningContract/)
    }
    assert.deepEqual(resolver.checkAdaptiveContract('muse-v0', {}, 'muse_main', okModel, okRoute, {}), [], 'muse-v0 is judged by its own, unchanged rule')
  })

  check('nexus-adaptive-v1: a model, route and policy that meet the engine\'s real requirements are accepted', () => {
    assert.deepEqual(judge({}), [])
    // both data-use tiers the Registry defines are acceptable when DECLARED; the legacy contributor-only rule is not imposed
    assert.deepEqual(judge({ model: { dataUseTier: 'contributor' } }), [])
    assert.deepEqual(judge({ model: { dataUseTier: 'standard' } }), [])
    // the one known provider wire profile is fine; so is none
    assert.deepEqual(judge({ provider: { metadata: { wireProfile: 'opencode-go-responses' } } }), [])
    // a default-only slot is legal (an adaptive mode that never adapts)
    assert.deepEqual(judge({ assignment: { allowedReasoning: undefined } }), [])
    // listing routes (no assignment yet) judges the model/route/provider part only
    assert.deepEqual(judge({ assignment: null }), [])
  })

  check('nexus-adaptive-v1: every unmet requirement is refused, each for its own reason', () => {
    const refuse = (over, rx) => {
      const e = judge(over)
      assert.ok(e.length >= 1 && e.every((x) => x.code === 'slot-capability-not-satisfied'), JSON.stringify(over))
      assert.ok(e.some((x) => rx.test(x.message)), JSON.stringify(over) + ' :: ' + e.map((x) => x.message).join(' | '))
    }
    refuse({ model: { dataUseTier: undefined } }, /data-use tier/)
    refuse({ model: { dataUseTier: 'public' } }, /data-use tier/)
    refuse({ model: { dataUseTier: null } }, /data-use tier/)
    refuse({ model: { capabilities: { toolCalling: false, reasoning: true } } }, /toolCalling/)
    refuse({ model: { capabilities: { toolCalling: true, reasoning: false } } }, /reasoning/)
    refuse({ model: { capabilities: {} } }, /toolCalling/)
    refuse({ route: { executionKind: 'agent-sdk' } }, /execution kind/)
    // transports with no implemented, tested adaptive path (Gemini included) are refused, never assumed
    for (const t of ['openai-chat-completions', 'anthropic-messages', 'gemini-generate-content', 'local-openai-compatible', 'agent-sdk', 'unknown', '', undefined]) {
      refuse({ route: { compatibility: { transport: t } } }, /only openai-responses/)
    }
    refuse({ route: { compatibility: {} } }, /only openai-responses/)
    refuse({ provider: { metadata: { wireProfile: 'gemini-native' } } }, /wireProfile/)
    // levels outside the Governor ladder can never be applied
    for (const lvl of ['off', 'minimal', 'max', 'managed', 'ultra']) {
      refuse({ assignment: { reasoning: lvl, allowedReasoning: [lvl] } }, /Governor ladder/)
      refuse({ assignment: { allowedReasoning: ['low', lvl] } }, /could never be applied/)
    }
    refuse({ assignment: { reasoning: undefined } }, /default reasoning/)
  })

  check('the contract is enforced by the Registry itself on the real catalog: compile and eligible-route listing', () => {
    // the shipped catalog, in memory: the adaptive definition ACTIVATED and every model scoped to
    // nexus-adaptive-v1 (what an operator would have to do; the built-in catalog scopes none)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-contract-'))
    try {
      const root = path.join(tmp, 'inst')
      const cfg = path.join(root, 'config')
      fs.mkdirSync(cfg, { recursive: true })
      fs.cpSync(path.join(repoRoot, 'config', 'registry'), path.join(cfg, 'registry'), { recursive: true })
      for (const f of ['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(cfg, f))
      const svc = require(path.join(cfg, 'registry', 'service.cjs')).createService({ installRoot: root, dataRoot: path.join(tmp, 'data') })
      const snap = JSON.parse(JSON.stringify(svc.effectiveSnapshot().snapshot))
      for (const model of snap.models) model.engines = Array.from(new Set((model.engines || []).concat(['nexus-adaptive-v1'])))
      const mode = snap.modes.find((x) => x.id === 'engineering-v2-adaptive')
      Object.assign(mode, { status: 'active', selectable: true, runnable: true })
      const compile = (routeId, modelId, reasoning, allowed) => {
        const config = { schemaVersion: 1, modeId: 'engineering-v2-adaptive', revision: 0, slots: { main: { logicalModelId: modelId, routeId, reasoning } }, roleOverrides: {} }
        if (allowed) config.slots.main.allowedReasoning = allowed
        return resolver.compileModeConfig(config, snap, null)
      }
      const codesOf = (r) => (r.errors || []).map((e) => e.code)
      // the only catalog route on the Native Responses transport: Muse Spark through OpenCode Go
      const ok = compile('opencode-go/meta/muse-spark-1.3-contributor', 'meta/muse-spark-1.3-contributor', 'low', ['low', 'medium', 'high', 'xhigh'])
      assert.equal(ok.ok, true, JSON.stringify(ok.errors || ok))
      // ... and the binding it seals carries the contract and the allowed levels
      const binding = Object.values(ok.snapshot.roles)[0]
      assert.equal(binding.slotRequirements.adaptiveReasoningContract, 'nexus-adaptive-v1')
      assert.deepEqual(binding.allowedReasoning, ['high', 'low', 'medium', 'xhigh'])
      // a ladder-external default or authorized level is refused (the route declares minimal)
      let r = compile('opencode-go/meta/muse-spark-1.3-contributor', 'meta/muse-spark-1.3-contributor', 'minimal', ['minimal', 'low'])
      assert.ok(codesOf(r).includes('slot-capability-not-satisfied'), JSON.stringify(r))
      // the same model on a chat-completions route has no implemented adaptive transport
      r = compile('meta-model-api/meta/muse-spark-1.3-contributor', 'meta/muse-spark-1.3-contributor', 'low')
      assert.ok(codesOf(r).includes('slot-capability-not-satisfied') && /openai-responses/.test(JSON.stringify(r)), JSON.stringify(r))
      // models that lack tool calling / a declared transport / a data-use tier are refused
      for (const [route, model] of [['sol-local/gpt-5.6-sol', 'gpt-5.6-sol'], ['zai-direct/glm-5.3', 'glm-5.3'], ['deepseek-pro-direct/deepseek-v4-pro', 'deepseek-v4-pro']]) {
        r = compile(route, model, 'high')
        assert.equal(r.ok, false, route)
        assert.ok(codesOf(r).includes('slot-capability-not-satisfied'), route + ' ' + JSON.stringify(r))
      }
      // eligible-route listing offers exactly the routes the contract (and the shared checks) accept
      assert.deepEqual(resolver.listEligibleRoutes('engineering-v2-adaptive', 'main', snap, null).map((x) => x.id), ['opencode-go/meta/muse-spark-1.3-contributor'])
      // an unknown contract in a (hand-edited) definition fails closed at compile time
      const original = mode.slots[0].requirements.adaptiveReasoningContract
      mode.slots[0].requirements.adaptiveReasoningContract = 'nexus-adaptive-v9'
      r = compile('opencode-go/meta/muse-spark-1.3-contributor', 'meta/muse-spark-1.3-contributor', 'low')
      assert.ok(/unknown adaptiveReasoningContract/.test(JSON.stringify(r)), JSON.stringify(r))
      mode.slots[0].requirements.adaptiveReasoningContract = original
      // muse-v0's own restriction is untouched: a model without the contributor tier is still refused for engineering-v2
      for (const model of snap.models) model.engines = Array.from(new Set((model.engines || []).concat(['muse-v0'])))
      const v2 = resolver.compileModeConfig({ schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'high' } }, roleOverrides: {} }, snap, null)
      assert.equal(v2.ok, false)
      assert.ok(/contributor data-use tier/.test(JSON.stringify(v2)), JSON.stringify(v2))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}

// ---- EM-04C2 S9.5: the FORMER adaptive engine identity (muse-v1) never re-enters the Registry ----
{
  const resolver95 = require('../config/registry/resolver.cjs')
  const FORMER = 'muse-v1'
  const CURRENT = 'nexus-adaptive-v1'
  const NEAR = [FORMER, FORMER + ' ', ' ' + FORMER, FORMER.toUpperCase(), 'Muse-V1', 'muse-v1-shadow', 'muse-v1-signals', 'muse-v11', 'muse_v1', 'nexus-adaptive-v2', 'nexus-adaptive-v1 ', ' nexus-adaptive-v1', 'NEXUS-ADAPTIVE-V1', 'nexus_adaptive_v1', 'nexus-adaptive-v1\n', 'nexus-adaptive', 'nexus-adaptive-v1/../muse-v0', '', '__proto__', 'constructor', 'effort-test-v0']
  const model95 = { id: 'm', dataUseTier: 'standard', capabilities: { toolCalling: true, reasoning: true } }
  const route95 = { id: 'r', executionKind: 'raw-model', compatibility: { transport: 'openai-responses' } }

  check('S9.5: the current identity is the adaptive scope\'s only engine; the former id and every near miss resolve nowhere', () => {
    const adaptive = issuer.scopeOf('engineering-v2-adaptive')
    const dflt = issuer.scopeOf('engineering-v2')
    assert.equal(adaptive.engineId, CURRENT)
    assert.deepEqual([...adaptive.experimentalEngineIds], [])
    assert.equal(issuer.engineAllowed(adaptive, CURRENT), true)
    assert.equal(issuer.engineAllowed(dflt, CURRENT), false, 'the adaptive engine is never issuable under the default mode')
    for (const id of NEAR.concat([null, undefined, 7, {}, []])) {
      if (id === CURRENT) continue
      assert.equal(issuer.engineAllowed(adaptive, id), false, 'adaptive scope: ' + JSON.stringify(id))
      if (!['effort-test-v0', 'muse-v1-shadow', 'muse-v1-signals'].includes(id)) assert.equal(issuer.engineAllowed(dflt, id), false, 'default scope: ' + JSON.stringify(id))
    }
    // no scope, in any mode, names the former id
    for (const mode of ['engineering-v2', 'engineering-v2-adaptive']) {
      const sc = issuer.scopeOf(mode)
      assert.notEqual(sc.engineId, FORMER)
      assert.ok(!sc.experimentalEngineIds.includes(FORMER))
    }
    assert.equal(issuer.scopeOf(FORMER), null)
  })

  check('S9.5: only the current adaptive contract exists; the former contract id and near misses are unknown contracts and are refused', () => {
    assert.deepEqual(Object.keys(resolver95.ADAPTIVE_CONTRACTS).sort(), ['muse-v0', CURRENT])
    for (const bad of NEAR.filter((x) => x !== CURRENT && x !== '')) {
      const e = resolver95.checkAdaptiveContract(bad, {}, 'muse_main', model95, route95, {})
      assert.deepEqual(e.map((x) => x.code), ['slot-capability-not-satisfied'], JSON.stringify(bad))
      assert.match(e[0].message, /unknown adaptiveReasoningContract/)
    }
  })

  check('S9.5: no shipped Registry definition or code names the former identity', () => {
    const rx = /(?<![\w-])muse-v1(?![-\w])/
    for (const f of ['modes/engineering-v1.json', 'modes/engineering-v2.json', 'modes/engineering-v2-adaptive.json', 'modes/engineering-v3.json', 'native-issuer.cjs', 'resolver.cjs', 'legacy-import.cjs', 'service.cjs', 'schemas.cjs']) {
      const text = fs.readFileSync(path.join(repoRoot, 'config', 'registry', f), 'utf8')
      const hits = text.split('\n').filter((l) => rx.test(l) && !/(former|previous|old)/i.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      assert.deepEqual(hits, [], f)
    }
    const adaptive = readMode('engineering-v2-adaptive.json')
    assert.equal(adaptive.orchestrationEngineId, CURRENT)
    assert.equal(adaptive.slots[0].requirements.adaptiveReasoningContract, CURRENT)
    assert.equal(readMode('engineering-v2.json').orchestrationEngineId, 'muse-v0')
  })

  check('S9.5: legacy import cannot resurrect the former identity; a stale definition is ignored, never listed or imported', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-former-id-'))
    try {
      const build = (mutate) => {
        const root = path.join(tmp, 'inst' + Math.random().toString(16).slice(2))
        const cfg = path.join(root, 'config')
        fs.mkdirSync(cfg, { recursive: true })
        fs.cpSync(path.join(repoRoot, 'config', 'registry'), path.join(cfg, 'registry'), { recursive: true })
        for (const f of ['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(cfg, f))
        const file = path.join(cfg, 'registry', 'modes', 'engineering-v2-adaptive.json')
        if (mutate) {
          const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
          mutate(doc)
          fs.writeFileSync(file, JSON.stringify(doc, null, 2))
        }
        const li = require(path.join(cfg, 'registry', 'legacy-import.cjs'))
        const { snapshot, errors } = li.buildRegistrySnapshot(root)
        return { ids: snapshot.modes.map((m) => m.id).sort(), errors, li, doc: JSON.parse(fs.readFileSync(file, 'utf8')) }
      }
      const withIds = ['engineering-v1', 'engineering-v2', 'engineering-v2-adaptive', 'engineering-v3']
      const current = build(null)
      assert.deepEqual(current.ids, withIds)
      assert.deepEqual(current.errors, [])
      // the stale definition of the previous release (former engine and contract): absent, legacy modes intact
      const stale = build((d) => { d.orchestrationEngineId = FORMER; d.slots[0].requirements.adaptiveReasoningContract = FORMER })
      assert.deepEqual(stale.ids, ['engineering-v1', 'engineering-v2', 'engineering-v3'])
      assert.deepEqual(stale.errors, [], 'the optional definition being absent is not an error')
      assert.equal(stale.li.isOptionalModeDefinition(stale.doc), false)
      // each near-miss engine id on that file is equally absent
      for (const id of NEAR.filter((x) => x !== CURRENT)) {
        const r = build((d) => { d.orchestrationEngineId = id })
        assert.deepEqual(r.ids, ['engineering-v1', 'engineering-v2', 'engineering-v3'], JSON.stringify(id))
      }
      // the former id cannot be smuggled in through the other (required) definitions either
      const dflt = build(null)
      assert.equal(dflt.li.isOptionalModeDefinition(readMode('engineering-v2.json')), false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  check('S9.5: a model scoped only to the former engine id does not qualify for the adaptive mode (explicit operator update required)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-former-scope-'))
    try {
      const root = path.join(tmp, 'inst')
      const cfg = path.join(root, 'config')
      fs.mkdirSync(cfg, { recursive: true })
      fs.cpSync(path.join(repoRoot, 'config', 'registry'), path.join(cfg, 'registry'), { recursive: true })
      for (const f of ['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(cfg, f))
      const svc = require(path.join(cfg, 'registry', 'service.cjs')).createService({ installRoot: root, dataRoot: path.join(tmp, 'data') })
      const snap = JSON.parse(JSON.stringify(svc.effectiveSnapshot().snapshot))
      Object.assign(snap.modes.find((x) => x.id === 'engineering-v2-adaptive'), { status: 'active', selectable: true, runnable: true })
      const compile = (engines) => {
        for (const m of snap.models) m.engines = engines
        const config = { schemaVersion: 1, modeId: 'engineering-v2-adaptive', revision: 0, slots: { main: { logicalModelId: 'meta/muse-spark-1.3-contributor', routeId: 'opencode-go/meta/muse-spark-1.3-contributor', reasoning: 'low', allowedReasoning: ['low', 'medium', 'high', 'xhigh'] } }, roleOverrides: {} }
        return resolver95.compileModeConfig(config, snap, null)
      }
      const former = compile([FORMER])
      assert.equal(former.ok, false)
      assert.ok((former.errors || []).some((e) => e.code === 'engine-scope-mismatch'), JSON.stringify(former.errors))
      assert.equal(compile([FORMER, 'muse-v0']).ok, false)
      assert.equal(compile([CURRENT]).ok, true, 'scoping to the current identity (the operator update) qualifies')
      // a mode slot that REQUIRES the former contract id is refused by the real compile, even for a fully scoped model
      const mode = snap.modes.find((x) => x.id === 'engineering-v2-adaptive')
      const saved = mode.slots[0].requirements.adaptiveReasoningContract
      mode.slots[0].requirements.adaptiveReasoningContract = FORMER
      const oldContract = compile([CURRENT])
      assert.equal(oldContract.ok, false)
      assert.ok(/unknown adaptiveReasoningContract/.test(JSON.stringify(oldContract.errors)), JSON.stringify(oldContract.errors))
      mode.slots[0].requirements.adaptiveReasoningContract = saved
      assert.equal(compile([CURRENT]).ok, true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
