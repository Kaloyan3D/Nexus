'use strict'

// EM-04C1: the per-mode serialized-request budget is Registry policy. A mode may declare
// `requestBudgetBytes`; it is validated, compiled into the role binding, folded into the resolution
// identity and sealed with the issued target. A mode that declares nothing is byte-for-byte what it
// was before. Pure, offline, no network, no PowerShell.
const assert = require('node:assert/strict')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const registry = require('../config/registry/index.cjs')
const { schemas, resolver, legacyImport } = registry
const issuer = require('../config/registry/native-issuer.cjs')
const tb = require('../config/registry/native-task-binding.cjs')

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('PASS: ' + label)
}

const codes = (r) => (r.errors || []).map((e) => e.code)
const clone = (v) => JSON.parse(JSON.stringify(v))

function fixture() {
  const { snapshot, errors } = legacyImport.buildRegistrySnapshot(repoRoot)
  assert.deepEqual(errors, [])
  const { configs } = legacyImport.importLegacyProfiles(repoRoot, snapshot)
  const cfg = configs['muse-spark-1.3-contributor']
  assert.ok(cfg)
  return { snapshot, cfg }
}

function withBudget(snapshot, modeId, value) {
  const s = clone(snapshot)
  const mode = s.modes.find((m) => m.id === modeId)
  assert.ok(mode, 'mode ' + modeId)
  if (value === undefined) delete mode.requestBudgetBytes
  else mode.requestBudgetBytes = value
  return s
}

check('the mode schema accepts a budget in range and rejects everything else', () => {
  const { snapshot } = fixture()
  const mode = clone(snapshot.modes.find((m) => m.id === 'engineering-v2'))
  assert.deepEqual(schemas.validateModeDefinition(mode, 'mode'), [])
  for (const ok of [schemas.MIN_REQUEST_BUDGET_BYTES, 450000, 428722, schemas.MAX_REQUEST_BUDGET_BYTES]) {
    mode.requestBudgetBytes = ok
    assert.deepEqual(schemas.validateModeDefinition(mode, 'mode'), [], String(ok))
  }
  for (const bad of [0, -1, schemas.MIN_REQUEST_BUDGET_BYTES - 1, schemas.MAX_REQUEST_BUDGET_BYTES + 1, 1.5, '450000', null, NaN, Infinity, true, [], {}]) {
    mode.requestBudgetBytes = bad
    assert.ok(codes({ errors: schemas.validateModeDefinition(mode, 'mode') }).includes('mode-invalid'), JSON.stringify(bad))
  }
  // an unknown sibling is still refused: the field list stays closed
  delete mode.requestBudgetBytes
  mode.requestBudgetByte = 450000
  assert.ok(schemas.validateModeDefinition(mode, 'mode').length > 0)
})

check('a mode without a budget compiles exactly as before: no key anywhere, same identity', () => {
  const { snapshot, cfg } = fixture()
  const base = resolver.compileModeConfig(cfg, snapshot, {})
  assert.equal(base.ok, true)
  const explicitNone = resolver.compileModeConfig(cfg, withBudget(snapshot, cfg.modeId, undefined), {})
  assert.equal(explicitNone.snapshot.resolutionId, base.snapshot.resolutionId)
  for (const b of Object.values(base.snapshot.roles)) {
    assert.equal('requestBudgetBytes' in b, false)
  }
  assert.equal(JSON.stringify(base.snapshot).includes('requestBudgetBytes'), false)
})

check('a budgeted mode carries it into every role binding and into the resolution identity', () => {
  const { snapshot, cfg } = fixture()
  const base = resolver.compileModeConfig(cfg, snapshot, {})
  const a = resolver.compileModeConfig(cfg, withBudget(snapshot, cfg.modeId, 428722), {})
  assert.equal(a.ok, true, JSON.stringify(a.errors))
  for (const b of Object.values(a.snapshot.roles)) assert.equal(b.requestBudgetBytes, 428722)
  assert.deepEqual(schemas.validateResolvedModeConfiguration(a.snapshot, 'resolved'), [])
  assert.notEqual(a.snapshot.resolutionId, base.snapshot.resolutionId)
  const b2 = resolver.compileModeConfig(cfg, withBudget(snapshot, cfg.modeId, 428723), {})
  assert.notEqual(b2.snapshot.resolutionId, a.snapshot.resolutionId, 'a different budget is a different resolution')
  assert.equal(resolver.compileModeConfig(cfg, withBudget(snapshot, cfg.modeId, 428722), {}).snapshot.resolutionId, a.snapshot.resolutionId, 'deterministic')
})

check('an out-of-range budget in a snapshot fails compilation closed', () => {
  const { snapshot, cfg } = fixture()
  for (const bad of [1, 99999999, 1.5, '450000']) {
    const r = resolver.compileModeConfig(cfg, withBudget(snapshot, cfg.modeId, bad), {})
    assert.equal(r.ok, false, String(bad))
  }
})

// the issuer, on a compiled binding

function compiledFor(budget) {
  const { snapshot, cfg } = fixture()
  const s = budget === undefined ? snapshot : withBudget(snapshot, cfg.modeId, budget)
  const r = resolver.compileModeConfig(cfg, s, {})
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const binding = r.snapshot.roles.muse_main
  return { snapshot: r.snapshot, binding, modeConfig: cfg }
}

function issue(budget) {
  const c = compiledFor(budget)
  // engineering-v2 / muse_main are the only scope the issuer supports: re-label the binding
  const binding = Object.assign({}, c.binding, { modeId: 'engineering-v2', roleId: 'muse_main', executionKind: 'raw-model', orchestrationEngineId: 'muse-v0' })
  const out = issuer.issueForGeneration({ ok: true, binding, snapshot: c.snapshot, modeConfig: c.modeConfig, persisted: true }, 'task-1')
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.issuance
}

check('the issued target carries the budget only when the mode declares one', () => {
  const none = issue(undefined)
  assert.equal('requestBudgetBytes' in none.target, false)
  assert.equal('requestBudgetBytes' in none.resolution.target, false)
  const b = issue(428722)
  assert.equal(b.target.requestBudgetBytes, 428722)
  assert.equal(b.resolution.target.requestBudgetBytes, 428722)
  assert.notEqual(b.issuanceId, none.issuanceId)
  assert.notEqual(b.targetDigest, none.targetDigest)
  // the issuance identity is derivable from the sealed bytes, budget included
  assert.equal(tb.selfConsistent(b.resolution), true)
})

function extensionFor(resolution) {
  return {
    extensionVersion: 1, endpoint: { protocol: 'https', origin: 'https://api.example.test', path: '/v1/responses', method: 'POST', localLoopback: false },
    remoteModelIdConfirmed: resolution.target.remoteModelId, reasoningEffort: resolution.target.reasoning, billing: { tier: 'metered', dataUse: 'standard' },
    session: { sessionId: 'session-1' }, capabilities: ['toolCalling'], contextLimitTokens: 1000, outputLimitTokens: 100,
    connectionBinding: 'conn-1', credentialRef: 'credential://connections/conn-1',
  }
}

check('the task binding and every attempt keep the budget; a changed budget is refused', () => {
  const iss = issue(428722)
  const route = { id: iss.resolution.target.routeId, reasoningLevels: [iss.resolution.target.reasoning] }
  const target = { issuance: { resolution: iss.resolution }, extension: extensionFor(iss.resolution) }
  const built = tb.buildTaskBinding(target, route)
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.equal(built.binding.target.requestBudgetBytes, 428722, 'the binding projection keeps the budget')
  const att = tb.authorizeAttemptTarget({ taskBinding: built.binding, taskBindingDigest: built.bindingDigest, resolution: iss.resolution, extension: target.extension, requestedEffort: iss.resolution.target.reasoning })
  assert.equal(att.ok, true)
  assert.equal(att.attempt.resolution.target.requestBudgetBytes, 428722)
  // a presented issuance with another budget (re-derived digests and all) is not this task's
  const other = issue(100000)
  const forged = tb.authorizeAttemptTarget({ taskBinding: built.binding, taskBindingDigest: built.bindingDigest, resolution: other.resolution, extension: target.extension, requestedEffort: iss.resolution.target.reasoning })
  assert.equal(forged.ok, false)
  // editing the budget inside the issuance without re-deriving its digests is not self-consistent
  const edited = clone(iss.resolution)
  edited.target.requestBudgetBytes = 4194304
  assert.equal(tb.selfConsistent(edited), false)
  assert.equal(tb.authorizeAttemptTarget({ taskBinding: built.binding, taskBindingDigest: built.bindingDigest, resolution: edited, extension: target.extension, requestedEffort: iss.resolution.target.reasoning }).ok, false)
  // removing the budget from the issuance is a mismatch too
  const stripped = issue(undefined)
  assert.equal(tb.authorizeAttemptTarget({ taskBinding: built.binding, taskBindingDigest: built.bindingDigest, resolution: stripped.resolution, extension: target.extension, requestedEffort: iss.resolution.target.reasoning }).ok, false)
})

console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
