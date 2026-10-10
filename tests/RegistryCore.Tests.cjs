'use strict'

// R1: offline deterministic tests for the runtime-independent Registry Core.
// No API credentials, no network, no DSH sessions, no PowerShell. The Core
// modules under test perform no I/O; only the read-only legacy import helper
// reads the existing configuration files (and never writes them).
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const registry = require('../config/registry/index.cjs')
const { schemas, resolver, legacyImport } = registry
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'registry', 'legacy-targets.json'), 'utf8'))

// Registry Core must stay runtime-independent even when DSH variables leak in.
delete process.env.DSH_HOME
delete process.env.AIH_INSTALL_ROOT
delete process.env.DSH_AIH_PROFILE
delete process.env.AIH_ACTIVE_PROFILE

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('PASS: ' + label)
}

function codes(result) {
  return (result.errors || []).map((e) => e.code)
}

function buildTestSnapshot() {
  const { snapshot, errors } = legacyImport.buildRegistrySnapshot(repoRoot)
  assert.deepEqual(errors, [])
  assert.ok(snapshot)
  const schemaErrors = schemas.validateRegistrySnapshot(snapshot, 'registry')
  assert.deepEqual(schemaErrors, [])
  return snapshot
}

function importAll(snapshot) {
  const { configs, errors } = legacyImport.importLegacyProfiles(repoRoot, snapshot)
  assert.deepEqual(errors, [])
  return configs
}

// ── 1. Schema validation and invalid inputs ────────────────────────────

check('all nine contracts validate when well-formed', () => {
  const snapshot = buildTestSnapshot()
  assert.deepEqual(schemas.validateRegistrySnapshot(snapshot, 'registry'), [])
  const configs = importAll(snapshot)
  for (const id of Object.keys(configs)) {
    assert.deepEqual(schemas.validateModeConfiguration(configs[id], 'cfg.' + id), [])
  }
})

check('unsupported schema versions fail closed on every contract', () => {
  const snapshot = buildTestSnapshot()
  const badMode = { ...snapshot.modes[0], schemaVersion: 999 }
  assert.ok(schemas.validateModeDefinition(badMode, 'm').some((e) => e.code === 'unsupported-schema-version'))
  assert.ok(schemas.validateModeConfiguration({ ...importAll(snapshot)['deepseek-codex'], schemaVersion: 2 }, 'c').some((e) => e.code === 'unsupported-schema-version'))
  assert.ok(schemas.validateLogicalModel({ ...snapshot.models[0], schemaVersion: 0 }, 'm').some((e) => e.code === 'unsupported-schema-version'))
  assert.ok(schemas.validateProvider({ ...snapshot.providers[0], schemaVersion: 7 }, 'p').some((e) => e.code === 'unsupported-schema-version'))
  assert.ok(schemas.validateModelRoute({ ...snapshot.routes[0], schemaVersion: -1 }, 'r').some((e) => e.code === 'unsupported-schema-version'))
  assert.ok(schemas.validateConnection({ ...snapshot.connections[0], schemaVersion: 42 }, 'c').some((e) => e.code === 'unsupported-schema-version'))
})

check('strict schemas reject unknown fields with actionable errors', () => {
  const snapshot = buildTestSnapshot()
  const withExtra = { ...snapshot.models[0], dshPreset: 'aih-muse' }
  const errors = schemas.validateLogicalModel(withExtra, 'model')
  assert.ok(errors.some((e) => e.code === 'unknown-field'))
  assert.ok(errors[0].path.length > 0 && errors[0].message.length > 0)
  const cfg = { ...importAll(snapshot)['deepseek-codex'], bogus: true }
  assert.ok(schemas.validateModeConfiguration(cfg, 'c').some((e) => e.code === 'unknown-field'))
})

check('malformed ids, urls, and credential refs are rejected', () => {
  const snapshot = buildTestSnapshot()
  assert.ok(schemas.validateLogicalModel({ ...snapshot.models[0], id: '' }, 'm').some((e) => e.code === 'invalid-id'))
  assert.ok(schemas.validateProvider({ ...snapshot.providers[0], transportId: 'dsh-direct' }, 'p').some((e) => e.code === 'provider-invalid'))
  assert.ok(schemas.validateProvider({ ...snapshot.providers[0], baseUrl: 'not-a-url' }, 'p').some((e) => e.code === 'provider-invalid'))
  assert.ok(schemas.validateConnection({ ...snapshot.connections[0], credentialRef: 'sk-live-SECRET' }, 'c').some((e) => e.code === 'connection-invalid'))
  const route = { ...snapshot.routes[0], reasoningLevels: [] }
  assert.ok(schemas.validateModelRoute(route, 'r').some((e) => e.code === 'route-invalid'))
})

// ── 2. Duplicate IDs and unknown references ────────────────────────────

check('duplicate ids fail closed across catalogs', () => {
  const snapshot = buildTestSnapshot()
  const dup = JSON.parse(JSON.stringify(snapshot))
  dup.models.push({ ...dup.models[0] })
  assert.ok(schemas.validateRegistrySnapshot(dup, 'registry').some((e) => e.code === 'duplicate-id'))
  const dupRoute = JSON.parse(JSON.stringify(snapshot))
  dupRoute.routes.push({ ...dupRoute.routes[0] })
  assert.ok(schemas.validateRegistrySnapshot(dupRoute, 'registry').some((e) => e.code === 'duplicate-id'))
})

check('unknown model/provider/connection references fail closed', () => {
  const snapshot = buildTestSnapshot()
  const bad = JSON.parse(JSON.stringify(snapshot))
  bad.routes[0].logicalModelId = 'no-such-model'
  bad.routes[1].providerId = 'no-such-provider'
  bad.routes[2].connectionId = 'no-such-connection'
  const errors = schemas.validateRegistrySnapshot(bad, 'registry')
  assert.equal(errors.filter((e) => e.code === 'unknown-reference').length, 3)
})

check('unknown mode, slot, and role fail closed at compile time', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const noMode = { ...configs['deepseek-codex'], modeId: 'engineering-v9' }
  assert.ok(codes(resolver.compileModeConfig(noMode, snapshot, {})).includes('unknown-mode'))
  const badSlot = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  badSlot.slots.nonsense = badSlot.slots.engineer
  assert.ok(codes(resolver.compileModeConfig(badSlot, snapshot, {})).includes('unknown-slot'))
  const badRole = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  badRole.roleOverrides.nonsense = { reasoning: 'high' }
  assert.ok(codes(resolver.compileModeConfig(badRole, snapshot, {})).includes('unknown-role'))
  const incomplete = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  delete incomplete.slots.reviewer
  assert.ok(codes(resolver.compileModeConfig(incomplete, snapshot, {})).includes('mode-config-incomplete'))
})

// ── 3. Missing or incompatible routes ──────────────────────────────────

check('route/model identity mismatch fails closed without substitution', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const cfg = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  const otherRoute = snapshot.routes.find((r) => r.logicalModelId !== cfg.slots.engineer.logicalModelId)
  assert.ok(otherRoute)
  cfg.slots.engineer.routeId = otherRoute.id
  const result = resolver.compileModeConfig(cfg, snapshot, {})
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('route-model-identity-mismatch'))
})

check('disabled routes, providers, and revoked connections fail closed', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const disabledRoute = JSON.parse(JSON.stringify(snapshot))
  disabledRoute.routes.find((r) => r.id === configs['deepseek-codex'].slots.engineer.routeId).enabled = false
  assert.ok(codes(resolver.compileModeConfig(configs['deepseek-codex'], disabledRoute, {})).includes('route-unavailable'))
  const unavailable = JSON.parse(JSON.stringify(snapshot))
  unavailable.routes.find((r) => r.id === configs['deepseek-codex'].slots.engineer.routeId).availability = 'unavailable'
  assert.ok(codes(resolver.compileModeConfig(configs['deepseek-codex'], unavailable, {})).includes('route-unavailable'))
  const disabledProvider = JSON.parse(JSON.stringify(snapshot))
  disabledProvider.providers.find((p) => p.id === 'sol-local').status = 'disabled'
  assert.ok(codes(resolver.compileModeConfig(configs['deepseek-codex'], disabledProvider, {}).errors ? resolver.compileModeConfig(configs['deepseek-codex'], disabledProvider, {}) : { errors: [] }).includes('provider-disabled'))
  const revoked = JSON.parse(JSON.stringify(snapshot))
  const connId = snapshot.routes.find((r) => r.id === configs['deepseek-codex'].slots.engineer.routeId).connectionId
  revoked.connections.find((c) => c.id === connId).status = 'revoked'
  assert.ok(codes(resolver.compileModeConfig(configs['deepseek-codex'], revoked, {})).includes('connection-auth-required'))
})

// ── 4. Reasoning effort validation ─────────────────────────────────────

check('unsupported reasoning efforts are rejected, never downshifted', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const cfg = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  cfg.slots.engineer.reasoning = 'xhigh'
  const result = resolver.compileModeConfig(cfg, snapshot, {})
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('reasoning-level-not-supported'))
  const museCfg = JSON.parse(JSON.stringify(configs['muse-spark-1.3-contributor']))
  museCfg.slots.main.reasoning = 'max'
  const museResult = resolver.compileModeConfig(museCfg, snapshot, {})
  assert.equal(museResult.ok, false)
  assert.ok(codes(museResult).includes('reasoning-level-not-supported'))
})

// ── 5. Model capability and role requirements ──────────────────────────

check('engineer slot refuses models without tool calling', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const noTools = JSON.parse(JSON.stringify(snapshot))
  noTools.models.find((m) => m.id === 'gpt-5.6-sol').capabilities.toolCalling = true
  const cfg = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  const solRoute = snapshot.routes.find((r) => r.logicalModelId === 'gpt-5.6-sol')
  cfg.slots.engineer = { logicalModelId: 'gpt-5.6-sol', routeId: solRoute.id, reasoning: 'high' }
  const scoped = JSON.parse(JSON.stringify(snapshot))
  scoped.models.find((m) => m.id === 'gpt-5.6-sol').engines = ['dual-v1', 'muse-v0']
  const result = resolver.compileModeConfig(cfg, scoped, {})
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('slot-capability-not-satisfied'))
})

check('visualReviewer requires vision; non-visual models fail closed', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const cfg = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  const nonVisual = snapshot.routes.find((r) => r.logicalModelId === 'deepseek-v4-flash')
  cfg.roleOverrides.visualReviewer = { logicalModelId: 'deepseek-v4-flash', routeId: nonVisual.id, reasoning: 'high' }
  const result = resolver.compileModeConfig(cfg, snapshot, {})
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('slot-capability-not-satisfied'))
})

check('muse-v0 single-agent contract rejects non-contributor models', () => {
  const snapshot = buildTestSnapshot()
  const dualRoute = snapshot.routes.find((r) => r.logicalModelId === 'glm-5.3-flash')
  const cfg = {
    schemaVersion: 1,
    modeId: 'engineering-v2',
    revision: 0,
    slots: { main: { logicalModelId: 'glm-5.3-flash', routeId: dualRoute.id, reasoning: 'high' } },
  }
  const result = resolver.compileModeConfig(cfg, snapshot, {})
  assert.equal(result.ok, false)
  assert.ok(
    codes(result).includes('slot-capability-not-satisfied') || codes(result).includes('engine-scope-mismatch'),
    'expected capability or engine-scope rejection, got: ' + JSON.stringify(result.errors),
  )
})

// ── 6. Legacy resolution parity (frozen R0 fixtures) ───────────────────

check('legacy import is read-only: source files untouched', () => {
  const watched = [
    'config/engineering-profiles.json',
    'config/muse-profiles.json',
    'config/model-registry.json',
    'config/nexus-profiles.json',
  ].map((rel) => path.join(repoRoot, rel))
  const before = watched.map((p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
  const snapshot = buildTestSnapshot()
  importAll(snapshot)
  const after = watched.map((p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
  assert.deepEqual(after, before)
})

for (const profile of golden.dualProfiles) {
  check('parity: ' + profile.id + ' compiles to frozen Dual roles', () => {
    const snapshot = buildTestSnapshot()
    const configs = importAll(snapshot)
    const result = resolver.compileModeConfig(configs[profile.id], snapshot, {})
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    for (const [role, target] of Object.entries(profile.roles)) {
      const binding = result.snapshot.roles[role]
      assert.ok(binding, profile.id + '/' + role + ': missing binding')
      assert.equal(binding.logicalModelId, target.modelId)
      assert.equal(binding.remoteModelId, target.model)
      assert.equal(binding.providerId, target.provider)
      assert.equal(binding.reasoning, target.reasoning)
    }
  })
}

for (const profile of golden.museProfiles) {
  check('parity: ' + profile.id + ' compiles to frozen Muse route', () => {
    const snapshot = buildTestSnapshot()
    const configs = importAll(snapshot)
    const result = resolver.compileModeConfig(configs[profile.id], snapshot, {})
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    const binding = result.snapshot.roles.muse_main
    assert.ok(binding)
    assert.equal(binding.logicalModelId, profile.modelId)
    assert.equal(binding.remoteModelId, profile.model)
    assert.equal(binding.providerId, profile.provider)
    assert.equal(binding.reasoning, profile.reasoning)
  })
}

check('custom Dual configurations survive losslessly per role', () => {
  const snapshot = buildTestSnapshot()
  const { config, error } = legacyImport.importDualProfile({
    id: 'custom',
    roles: {
      primaryEngineer: { model: 'glm-5.3-flash', reasoning: 'high' },
      deepEngineer: { model: 'glm-5.3', reasoning: 'max' },
      reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
      solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
      fallback: { model: 'deepseek-v4-flash', reasoning: 'max' },
      visualReviewer: { model: 'deepseek-v4-flash-vision-exp', reasoning: 'high' },
    },
  }, snapshot)
  assert.equal(error, null)
  const result = resolver.compileModeConfig(config, snapshot, {})
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.snapshot.roles.deepEngineer.remoteModelId, 'glm-5.3')
  assert.equal(result.snapshot.roles.fallback.remoteModelId, 'deepseek-v4-flash')
  assert.equal(result.snapshot.roles.primaryEngineer.remoteModelId, 'glm-5.3-flash')
  assert.equal(result.snapshot.roles.visualReviewer.remoteModelId, 'deepseek-v4-flash-vision-exp')
})

// ── 7. Dual/Muse isolation ─────────────────────────────────────────────

check('Dual and Muse engine scopes are disjoint in the normalized catalog', () => {
  const snapshot = buildTestSnapshot()
  for (const model of snapshot.models) {
    const dual = (model.engines || []).includes('dual-v1')
    const muse = (model.engines || []).includes('muse-v0')
    assert.equal(dual && muse, false, 'model crosses engine boundary: ' + model.id)
  }
})

check('Muse-scoped models cannot compile in v1; Dual models cannot compile in v2', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const museRoute = snapshot.routes.find((r) => r.logicalModelId === 'muse-spark-1.3-contributor')
  const badDual = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  badDual.slots.engineer = { logicalModelId: 'muse-spark-1.3-contributor', routeId: museRoute.id, reasoning: 'xhigh' }
  assert.ok(codes(resolver.compileModeConfig(badDual, snapshot, {})).includes('engine-scope-mismatch'))
  const dualRoute = snapshot.routes.find((r) => r.logicalModelId === 'deepseek-v4-flash')
  const badMuse = {
    schemaVersion: 1,
    modeId: 'engineering-v2',
    revision: 0,
    slots: { main: { logicalModelId: 'deepseek-v4-flash', routeId: dualRoute.id, reasoning: 'high' } },
  }
  assert.ok(codes(resolver.compileModeConfig(badMuse, snapshot, {})).includes('engine-scope-mismatch'))
})

check('same upstream checkpoint via two routes stays distinguishable', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const meta = resolver.compileModeConfig(configs['muse-spark-1.3-contributor'], snapshot, {})
  const open = resolver.compileModeConfig(configs['muse-spark-1.3-contributor-opencode'], snapshot, {})
  assert.equal(meta.ok, true)
  assert.equal(open.ok, true)
  assert.equal(meta.snapshot.roles.muse_main.remoteModelId, open.snapshot.roles.muse_main.remoteModelId)
  assert.notEqual(meta.snapshot.roles.muse_main.routeId, open.snapshot.roles.muse_main.routeId)
  assert.notEqual(meta.snapshot.roles.muse_main.providerId, open.snapshot.roles.muse_main.providerId)
  assert.equal(meta.snapshot.roles.muse_main.providerId, 'meta-model-api')
  assert.equal(open.snapshot.roles.muse_main.providerId, 'opencode-go')
})

// ── 8. Deterministic compilation and immutability ──────────────────────

check('compilation is deterministic with stable resolution ids', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const first = resolver.compileModeConfig(configs['glm-codex'], snapshot, {})
  const second = resolver.compileModeConfig(JSON.parse(JSON.stringify(configs['glm-codex'])), JSON.parse(JSON.stringify(snapshot)), {})
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.snapshot.resolutionId, second.snapshot.resolutionId)
  assert.equal(first.snapshot.resolutionId, second.snapshot.roles.primaryEngineer.resolutionId)
  assert.match(first.snapshot.resolutionId, /^[0-9a-f]{64}$/)
})

check('compiled snapshots are deeply immutable', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const result = resolver.compileModeConfig(configs['deepseek-codex'], snapshot, {})
  assert.equal(result.ok, true)
  assert.ok(Object.isFrozen(result.snapshot))
  assert.ok(Object.isFrozen(result.snapshot.roles))
  assert.ok(Object.isFrozen(result.snapshot.roles.primaryEngineer))
  assert.throws(() => { result.snapshot.roles.primaryEngineer.reasoning = 'max' }, TypeError)
})

check('engineering-v3 is a planned preview: schema-valid but not compilable', () => {
  const snapshot = buildTestSnapshot()
  const v3 = snapshot.modes.find((m) => m.id === 'engineering-v3')
  assert.deepEqual(schemas.validateModeDefinition(v3, 'v3'), [])
  const result = resolver.compileModeConfig({
    schemaVersion: 1,
    modeId: 'engineering-v3',
    revision: 0,
    slots: { planner: { logicalModelId: 'x', routeId: 'y', reasoning: 'high' } },
  }, snapshot, {})
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('mode-not-runnable'))
})

// ── 9. Runtime independence ────────────────────────────────────────────

check('Registry Core source has no DSH, PowerShell, or session imports', () => {
  const forbidden = ['DSH_HOME', 'AIH_INSTALL_ROOT', 'llm-pi-ai', 'aih-muse', 'aih-engineering', 'session.events', 'powershell', 'child_process', 'node:child_process']
  for (const file of ['schemas.cjs', 'resolver.cjs', 'index.cjs']) {
    const text = fs.readFileSync(path.join(repoRoot, 'config', 'registry', file), 'utf8')
    for (const token of forbidden) {
      assert.ok(!text.includes(token), file + ' must not reference ' + token)
    }
  }
  const legacyText = fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'legacy-import.cjs'), 'utf8')
  for (const token of ['DSH_HOME', 'AIH_INSTALL_ROOT', 'llm-pi-ai', 'session.events', 'powershell', 'child_process']) {
    assert.ok(!legacyText.includes(token), 'legacy-import.cjs must not reference ' + token)
  }
})

check('Core compiles with DSH runtime variables absent', () => {
  assert.equal(process.env.DSH_HOME, undefined)
  assert.equal(process.env.AIH_INSTALL_ROOT, undefined)
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  assert.equal(resolver.compileModeConfig(configs['deepseek-codex'], snapshot, {}).ok, true)
})

check('runtime capability matrix: eligible host binds, incompatible host fails closed', () => {
  const snapshot = JSON.parse(JSON.stringify(buildTestSnapshot()))
  snapshot.providers.push({ schemaVersion: 1, id: 'probe-provider', name: 'Probe', transportId: 'openai-responses', status: 'enabled' })
  snapshot.connections.push({ schemaVersion: 1, id: 'conn-probe-provider', providerId: 'probe-provider', connectionKind: 'api-key', authMethod: 'api-key', credentialRef: 'credential://connections/conn-probe-provider', status: 'connected' })
  snapshot.models.push({
    schemaVersion: 1, id: 'probe-model', vendor: 'Probe', displayName: 'Probe', checkpoint: 'probe-1',
    capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true },
    enabled: true, engines: ['dual-v1'],
  })
  snapshot.routes.push({
    schemaVersion: 1, id: 'probe-provider/probe-model', providerId: 'probe-provider', logicalModelId: 'probe-model',
    remoteModelId: 'probe-1', accessType: 'api-key', connectionId: 'conn-probe-provider', executionKind: 'raw-model',
    reasoningLevels: ['high'], compatibility: { transport: 'openai-responses' }, availability: 'verified', enabled: true,
  })
  assert.deepEqual(schemas.validateRegistrySnapshot(snapshot, 'registry'), [])
  const configs = importAll(buildTestSnapshot())
  const cfg = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  cfg.slots.engineer = { logicalModelId: 'probe-model', routeId: 'probe-provider/probe-model', reasoning: 'high' }
  cfg.roleOverrides.deepEngineer = { logicalModelId: 'probe-model', routeId: 'probe-provider/probe-model', reasoning: 'high' }
  cfg.roleOverrides.fallback = { logicalModelId: 'probe-model', routeId: 'probe-provider/probe-model', reasoning: 'high' }
  const goodHost = { adapterId: 'mock-a', executionKinds: ['raw-model'], protocols: ['openai-responses'] }
  const badHost = { adapterId: 'mock-b', executionKinds: ['raw-model'], protocols: ['anthropic-messages'] }
  assert.equal(resolver.compileModeConfig(cfg, snapshot, { runtime: goodHost }).ok, true)
  const denied = resolver.compileModeConfig(cfg, snapshot, { runtime: badHost })
  assert.equal(denied.ok, false)
  assert.ok(codes(denied).includes('runtime-capability-unsatisfied'))
  assert.ok(resolver.listEligibleRoutes('engineering-v1', 'engineer', snapshot, goodHost).some((r) => r.id === 'probe-provider/probe-model'))
  assert.ok(!resolver.listEligibleRoutes('engineering-v1', 'engineer', snapshot, badHost).some((r) => r.id === 'probe-provider/probe-model'))
})


// ── H1: strict route availability enforcement ──────────────────────────

check('H1: every non-verified route status fails closed at compile time', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const expectations = {
    unavailable: 'route-unavailable',
    disabled: 'route-unavailable',
    'auth-required': 'route-not-verified',
    'probe-required': 'route-not-verified',
    'policy-blocked': 'route-not-verified',
    discovered: 'route-not-verified',
    unknown: 'route-not-verified',
  }
  for (const [availability, code] of Object.entries(expectations)) {
    const mutated = JSON.parse(JSON.stringify(snapshot))
    mutated.routes.find((r) => r.id === configs['deepseek-codex'].slots.engineer.routeId).availability = availability
    const result = resolver.compileModeConfig(configs['deepseek-codex'], mutated, {})
    assert.equal(result.ok, false, 'availability ' + availability + ' must not compile')
    assert.ok(codes(result).includes(code), 'availability ' + availability + ' must report ' + code + ', got ' + JSON.stringify(codes(result)))
  }
})

check('H1: discovered-only routes are never execution access, including listing', () => {
  const snapshot = JSON.parse(JSON.stringify(buildTestSnapshot()))
  const probe = snapshot.routes.find((r) => r.logicalModelId === 'deepseek-v4-flash')
  probe.availability = 'discovered'
  delete probe.provenance
  const configs = importAll(buildTestSnapshot())
  const cfg = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  cfg.slots.engineer = { logicalModelId: probe.logicalModelId, routeId: probe.id, reasoning: probe.reasoningLevels[0] }
  cfg.roleOverrides.deepEngineer = { logicalModelId: probe.logicalModelId, routeId: probe.id, reasoning: probe.reasoningLevels[0] }
  cfg.roleOverrides.fallback = { logicalModelId: probe.logicalModelId, routeId: probe.id, reasoning: probe.reasoningLevels[0] }
  const result = resolver.compileModeConfig(cfg, snapshot, {})
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('route-not-verified'))
  assert.ok(!resolver.listEligibleRoutes('engineering-v1', 'engineer', snapshot, null).some((r) => r.id === probe.id))
})

check('H1: missing, not-connected, and unverified connections fail closed', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const routeId = configs['deepseek-codex'].slots.engineer.routeId
  const connId = snapshot.routes.find((r) => r.id === routeId).connectionId
  const ghost = JSON.parse(JSON.stringify(snapshot))
  ghost.routes.find((r) => r.id === routeId).connectionId = 'conn-ghost'
  const ghostResult = resolver.compileModeConfig(configs['deepseek-codex'], ghost, {})
  assert.equal(ghostResult.ok, false, 'dangling connection reference must fail closed')
  assert.ok(
    codes(ghostResult).includes('unknown-reference') || codes(ghostResult).includes('connection-auth-required'),
    'dangling connection must be rejected, got ' + JSON.stringify(codes(ghostResult)),
  )
  for (const status of ['not-connected', 'revoked', 'disabled']) {
    const mutated = JSON.parse(JSON.stringify(snapshot))
    mutated.connections.find((c) => c.id === connId).status = status
    const result = resolver.compileModeConfig(configs['deepseek-codex'], mutated, {})
    assert.equal(result.ok, false, 'connection ' + status + ' must not compile')
    assert.ok(codes(result).includes('connection-auth-required'))
  }
  const naked = JSON.parse(JSON.stringify(snapshot))
  const nakedConn = naked.connections.find((c) => c.id === connId)
  nakedConn.status = 'unknown'
  delete nakedConn.provenance
  assert.ok(codes(resolver.compileModeConfig(configs['deepseek-codex'], naked, {})).includes('connection-auth-required'))
})

check('H1: legacy-provenance descriptors stay eligible in compile and listing', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  assert.equal(resolver.compileModeConfig(configs['deepseek-codex'], snapshot, {}).ok, true)
  const eligible = resolver.listEligibleRoutes('engineering-v1', 'engineer', snapshot, null)
  assert.ok(eligible.some((r) => r.id === configs['deepseek-codex'].slots.engineer.routeId))
})

// ── H2: fail-closed legacy engine scope ────────────────────────────────

check('H2: absent scope stays Dual; explicit bad scopes fail closed', () => {
  const { model: absent } = legacyImport.normalizeLogicalModel({ id: 'm', model: 'm' })
  assert.deepEqual(absent.engines, ['dual-v1'])
  for (const bad of [[], ['bogus-engine'], ['dual', 'bogus-engine'], 'muse', 42, ['']]) {
    const { model, errors } = legacyImport.normalizeLogicalModel({ id: 'm', model: 'm', agentEngines: bad })
    assert.deepEqual(model.engines, [], 'declaration ' + JSON.stringify(bad) + ' must scope to no engine')
    assert.equal(errors.length, 1, 'declaration ' + JSON.stringify(bad) + ' must report an import error')
    assert.ok(errors[0].startsWith('legacy-engine-scope-'), 'actionable error, got ' + errors[0])
  }
  assert.deepEqual(legacyImport.normalizeLogicalModel({ id: 'm', model: 'm', agentEngines: ['dual'] }).model.engines, ['dual-v1'])
  assert.deepEqual(legacyImport.normalizeLogicalModel({ id: 'm', model: 'm', agentEngines: ['muse'] }).model.engines, ['muse-v0'])
})

check('H2: invalid-scope models compile on no engine and surface import errors', () => {
  const snapshot = JSON.parse(JSON.stringify(buildTestSnapshot()))
  snapshot.models.push({
    schemaVersion: 1, id: 'scope-orphan', vendor: 'X', displayName: 'Orphan', checkpoint: 'orphan-1',
    capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true },
    enabled: true, engines: [],
  })
  snapshot.providers.push({ schemaVersion: 1, id: 'orphan-p', name: 'Orphan', transportId: 'unknown', status: 'enabled' })
  snapshot.connections.push({ schemaVersion: 1, id: 'conn-orphan-p', providerId: 'orphan-p', connectionKind: 'api-key', authMethod: 'api-key', credentialRef: 'credential://connections/conn-orphan-p', status: 'connected' })
  snapshot.routes.push({
    schemaVersion: 1, id: 'orphan-p/scope-orphan', providerId: 'orphan-p', logicalModelId: 'scope-orphan',
    remoteModelId: 'orphan-1', accessType: 'api-key', connectionId: 'conn-orphan-p', executionKind: 'raw-model',
    reasoningLevels: ['high'], compatibility: { transport: 'unknown' }, availability: 'verified', enabled: true,
  })
  const configs = importAll(buildTestSnapshot())
  for (const [modeId, slotId] of [['engineering-v1', 'engineer'], ['engineering-v2', 'main']]) {
    const cfg = modeId === 'engineering-v1'
      ? { schemaVersion: 1, modeId, revision: 0, slots: { engineer: { logicalModelId: 'scope-orphan', routeId: 'orphan-p/scope-orphan', reasoning: 'high' }, reviewer: configs['deepseek-codex'].slots.reviewer, solver: configs['deepseek-codex'].slots.solver } }
      : { schemaVersion: 1, modeId, revision: 0, slots: { main: { logicalModelId: 'scope-orphan', routeId: 'orphan-p/scope-orphan', reasoning: 'high' } } }
    const result = resolver.compileModeConfig(cfg, snapshot, {})
    assert.equal(result.ok, false)
    assert.ok(codes(result).includes('engine-scope-mismatch'))
  }
})

// ── H3: capacity metadata preservation ─────────────────────────────────

check('H3: legacy capacity metadata round-trips without invention', () => {
  const snapshot = buildTestSnapshot()
  const byId = new Map(snapshot.models.map((m) => [m.id, m]))
  assert.equal(byId.get('deepseek-v4-flash').contextWindow, 131072)
  assert.equal(byId.get('deepseek-v4-flash').maxOutputTokens, 8192)
  assert.equal(byId.get('gpt-5.6-sol').contextWindow, 400000)
  assert.equal(byId.get('gpt-5.6-sol').maxOutputTokens, 2500)
  assert.equal(byId.get('gpt-5.6-sol').readOnlyDefault, true)
  assert.equal(byId.get('deepseek-v4-flash-vision-exp').maxOutputTokens, 4096)
  assert.equal(byId.get('muse-spark-1.3-contributor').contextWindow, 1048576)
  for (const model of snapshot.models) {
    assert.equal(model.capacityProvenance, 'declared')
  }
})

check('H3: malformed capacity is omitted and reported, never coerced', () => {
  for (const bad of ['131072', -5, 0, 3.5, NaN]) {
    const { model, errors } = legacyImport.normalizeLogicalModel({ id: 'm', model: 'm', contextWindow: bad, maxOutputTokens: 8 })
    assert.equal(model.contextWindow, undefined, 'invalid contextWindow ' + String(bad) + ' must be omitted')
    assert.ok(errors.some((e) => e === 'legacy-model-capacity-invalid:m:contextWindow'))
    assert.equal(model.maxOutputTokens, 8)
  }
  const { model, errors } = legacyImport.normalizeLogicalModel({ id: 'm', model: 'm' })
  assert.equal(model.contextWindow, undefined)
  assert.equal(model.maxOutputTokens, undefined)
  assert.equal(model.capacityProvenance, undefined)
  assert.deepEqual(errors, [])
  assert.ok(schemas.validateLogicalModel({ schemaVersion: 1, id: 'm', vendor: 'V', displayName: 'M', checkpoint: 'm', capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true }, enabled: true, contextWindow: -1 }, 'm').some((e) => e.code === 'model-invalid'))
})

// ── H4: legacy reviewer compatibility ──────────────────────────────────

check('H4: reviewer pin preserves legacy contract without universal coupling', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  assert.equal(resolver.compileModeConfig(configs['deepseek-codex'], snapshot, {}).ok, true)
  const deepRoute = snapshot.routes.find((r) => r.logicalModelId === 'deepseek-v4-flash')
  const badReviewer = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  badReviewer.slots.reviewer = { logicalModelId: 'deepseek-v4-flash', routeId: deepRoute.id, reasoning: 'high' }
  const denied = resolver.compileModeConfig(badReviewer, snapshot, {})
  assert.equal(denied.ok, false)
  assert.ok(codes(denied).includes('slot-capability-not-satisfied'))
  assert.ok(denied.errors.some((e) => e.message.includes('sol-local')))
  const v1 = snapshot.modes.find((m) => m.id === 'engineering-v1')
  assert.equal(v1.slots.find((s) => s.id === 'reviewer').requirements.pinnedProvider, 'sol-local')
  const v2 = snapshot.modes.find((m) => m.id === 'engineering-v2')
  assert.equal(v2.slots[0].requirements.pinnedProvider, undefined)
})

check('H4: solver stays approval-gated but provider-open', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const deepRoute = snapshot.routes.find((r) => r.logicalModelId === 'deepseek-v4-flash' && r.reasoningLevels.includes('high'))
  const openSolver = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  openSolver.slots.solver = { logicalModelId: 'deepseek-v4-flash', routeId: deepRoute.id, reasoning: 'high' }
  const result = resolver.compileModeConfig(openSolver, snapshot, {})
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.ok(result.snapshot.roles.solver.requiredCapabilities.includes('writeRequiresApproval'))
  assert.ok(result.snapshot.roles.reviewer.requiredCapabilities.includes('readOnlyEnforced'))
})

// ── H5: security-relevant resolution fingerprint ───────────────────────

check('H5: fingerprint covers security semantics, ignores display names', () => {
  const snapshot = buildTestSnapshot()
  const configs = importAll(snapshot)
  const base = resolver.compileModeConfig(configs['deepseek-codex'], snapshot, {}).snapshot
  const renamed = JSON.parse(JSON.stringify(snapshot))
  renamed.models.find((m) => m.id === 'deepseek-v4-flash').displayName = 'Renamed Display'
  const same = resolver.compileModeConfig(configs['deepseek-codex'], renamed, {}).snapshot
  assert.equal(base.resolutionId, same.resolutionId)
  const retiered = JSON.parse(JSON.stringify(snapshot))
  retiered.models.find((m) => m.id === 'deepseek-v4-flash').dataUseTier = 'contributor'
  const changed = resolver.compileModeConfig(configs['deepseek-codex'], retiered, {}).snapshot
  assert.notEqual(base.resolutionId, changed.resolutionId)
  const recapped = JSON.parse(JSON.stringify(snapshot))
  recapped.modes.find((m) => m.id === 'engineering-v1').slots.find((s) => s.id === 'engineer').requirements.toolCalling = false
  const changedCaps = resolver.compileModeConfig(configs['deepseek-codex'], recapped, {}).snapshot
  assert.notEqual(base.resolutionId, changedCaps.resolutionId)
  const reReasoned = JSON.parse(JSON.stringify(configs['deepseek-codex']))
  const highRoute = snapshot.routes.find((r) => r.logicalModelId === 'deepseek-v4-flash' && r.reasoningLevels.includes('high'))
  reReasoned.roleOverrides.deepEngineer = { logicalModelId: 'deepseek-v4-flash', routeId: highRoute.id, reasoning: 'high' }
  const changedReasoning = resolver.compileModeConfig(reReasoned, snapshot, {})
  assert.equal(changedReasoning.ok, true, JSON.stringify(changedReasoning.errors))
  assert.notEqual(base.resolutionId, changedReasoning.snapshot.resolutionId)
  const text = JSON.stringify(base)
  assert.ok(!text.includes('credential://'), 'snapshots must not embed credential references')
  for (const binding of Object.values(base.roles)) {
    assert.ok(Array.isArray(binding.requiredCapabilities))
    assert.ok('dataUseTier' in binding && 'accessType' in binding && 'slotRequirements' in binding)
  }
})

// ── A3: schema validation completeness ─────────────────────────────────

check('A3: unknown capability/requirement keys are rejected', () => {
  const snapshot = buildTestSnapshot()
  const badCaps = JSON.parse(JSON.stringify(snapshot.models[0]))
  badCaps.capabilities.dshSessionAffinity = true
  assert.ok(schemas.validateLogicalModel(badCaps, 'm').some((e) => e.code === 'unknown-field'))
  const badReq = JSON.parse(JSON.stringify(snapshot.modes[0]))
  badReq.slots[0].requirements.preferredVendor = 'x'
  assert.ok(schemas.validateModeDefinition(badReq, 'm').some((e) => e.code === 'unknown-field'))
})

check('A3: ambiguous slot-to-role maps and uncovered roles are rejected', () => {
  const snapshot = buildTestSnapshot()
  const ambiguous = JSON.parse(JSON.stringify(snapshot.modes[0]))
  ambiguous.slots[2].internalRoles.push('primaryEngineer')
  assert.ok(schemas.validateModeDefinition(ambiguous, 'm').some((e) => e.code === 'mode-invalid'))
  const uncovered = JSON.parse(JSON.stringify(snapshot.modes[0]))
  uncovered.internalRoles.push('ghostRole')
  assert.ok(schemas.validateModeDefinition(uncovered, 'm').some((e) => e.code === 'mode-invalid'))
  assert.deepEqual(schemas.validateModeDefinition(snapshot.modes.find((m) => m.id === 'engineering-v1'), 'v1'), [])
  assert.deepEqual(schemas.validateModeDefinition(snapshot.modes.find((m) => m.id === 'engineering-v2'), 'v2'), [])
  assert.deepEqual(schemas.validateModeDefinition(snapshot.modes.find((m) => m.id === 'engineering-v3'), 'v3'), [])
})

check('A3: connection/provider mismatch and invalid runtime descriptors fail closed', () => {
  const snapshot = buildTestSnapshot()
  const badConn = JSON.parse(JSON.stringify(snapshot))
  badConn.connections[0].providerId = 'ghost-provider'
  assert.ok(schemas.validateRegistrySnapshot(badConn, 'registry').some((e) => e.code === 'unknown-reference'))
  assert.ok(schemas.validateRuntimeCapabilities(null, 'r').some((e) => e.code === 'runtime-invalid'))
  assert.ok(schemas.validateRuntimeCapabilities({ adapterId: '', executionKinds: ['telepathy'], protocols: ['carrier-pigeon'] }, 'r').some((e) => e.code === 'runtime-invalid'))
  const configs = importAll(snapshot)
  const badRuntime = resolver.compileModeConfig(configs['deepseek-codex'], snapshot, { runtime: { adapterId: 'x', executionKinds: ['telepathy'] } })
  assert.equal(badRuntime.ok, false)
  assert.ok(codes(badRuntime).includes('runtime-invalid'))
  assert.deepEqual(resolver.listEligibleRoutes('engineering-v1', 'engineer', snapshot, { adapterId: '' }), [])
})

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
