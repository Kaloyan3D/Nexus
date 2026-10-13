'use strict'

// R2: offline deterministic tests for legacy compatibility and migration.
// No credentials, no network, no DSH sessions, no PowerShell. Legacy files
// are read as migration input and never written. Frozen R0 fixtures are
// treated as an immutable historical record (read-only oracle).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const repoRoot = path.resolve(__dirname, '..')
const registry = require('../config/registry/index.cjs')
const schemas = registry.schemas
const resolver = registry.resolver
const legacyImport = registry.legacyImport
const museCanonical = registry.museCanonical
const dshAdapter = registry.dshAdapter
const profileCompat = registry.profileCompat
const parity = registry.parity
const migration = registry.migration
const engineering = require('../config/Engineering-Profiles.cjs')
const nexus = require('../config/Nexus-Profiles.cjs')

const savedEnv = {}
for (const name of ['DSH_AIH_PROFILE', 'AIH_ACTIVE_PROFILE', 'DSH_HOME', 'AIH_INSTALL_ROOT']) {
  savedEnv[name] = process.env[name]
  delete process.env[name]
}
const fixtureRoots = []
let passed = 0

function check(label, fn) {
  fn()
  passed++
  console.log('PASS: ' + label)
}
function shaOfFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}
const PROD_INPUTS = [
  'config/nexus-profiles.json',
  'config/engineering-profiles.json',
  'config/muse-profiles.json',
  'config/model-registry.json',
  'config/routing-policy.json',
  'config/settings.yaml',
]
const prodHashesBefore = PROD_INPUTS.map((rel) => shaOfFile(path.join(repoRoot, rel)))

const CONFIG_NAMES = [
  'routing-policy.json',
  'engineering-profiles.json',
  'model-registry.json',
  'nexus-profiles.json',
  'muse-profiles.json',
]
function makeFixture(o) {
  const opts = o || {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-'))
  fixtureRoots.push(root)
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  for (const name of CONFIG_NAMES) {
    fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(root, 'config', name))
  }
  if (typeof opts.registryMutate === 'function') {
    const p = path.join(root, 'config', 'model-registry.json')
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
    opts.registryMutate(doc)
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n')
  }
  if (opts.custom) {
    fs.writeFileSync(
      path.join(root, 'data', 'custom-engineering-profile.json'),
      JSON.stringify({ schemaVersion: 1, roles: opts.custom }, null, 2) + '\n',
    )
  }
  fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), 'engineering-profile: ' + (opts.settingsProfile || 'deepseek-codex') + '\n')
  return root
}
function withEnv(vars, fn) {
  const prev = {}
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k]
    if (vars[k] === null || vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}
function buildRaw(root) {
  const b = legacyImport.buildRegistrySnapshot(root)
  assert.deepEqual(b.errors, [])
  assert.deepEqual(schemas.validateRegistrySnapshot(b.snapshot, 'registry'), [])
  return b.snapshot
}
function buildNormalized(root) {
  const raw = buildRaw(root)
  const n = museCanonical.normalizeMuseSnapshot(raw)
  assert.deepEqual(n.errors, [])
  assert.ok(n.snapshot)
  assert.deepEqual(schemas.validateRegistrySnapshot(n.snapshot, 'registry'), [])
  return { snapshot: n.snapshot, aliases: n.aliases }
}
function shapeSubset(target) {
  return { modelId: target.modelId, model: target.model, provider: target.provider, reasoning: target.reasoning }
}
function bindingSubset(binding) {
  return { modelId: binding.logicalModelId, model: binding.remoteModelId, provider: binding.providerId, reasoning: binding.reasoning }
}
const DUAL_ROLES = ['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback', 'visualReviewer']
function snapshotSourceFiles(root) {
  const snap = {}
  for (const rel of ['config/nexus-profiles.json', 'config/engineering-profiles.json', 'config/muse-profiles.json', 'config/model-registry.json', 'config/routing-policy.json', 'data/settings.yaml', 'data/custom-engineering-profile.json']) {
    const p = path.join(root, rel)
    try {
      snap[rel] = { hash: shaOfFile(p), mode: fs.statSync(p).mode & 511 }
    } catch {
      snap[rel] = null
    }
  }
  return snap
}
function assertSourceUnchanged(root, snap) {
  for (const rel of Object.keys(snap)) {
    const p = path.join(root, rel)
    if (snap[rel] === null) {
      assert.ok(!fs.existsSync(p), rel + ' must stay absent')
    } else {
      assert.equal(shaOfFile(p), snap[rel].hash, rel + ' content must be untouched')
      assert.equal(fs.statSync(p).mode & 511, snap[rel].mode, rel + ' permissions must be untouched')
    }
  }
}
const CUSTOM_ROLES = {
  primaryEngineer: { model: 'glm-5.3', reasoning: 'high' },
  deepEngineer: { model: 'deepseek-v4-pro', reasoning: 'max' },
  reviewer: { model: 'gpt-5.6-sol', reasoning: 'low' },
  solver: { model: 'glm-5.3', reasoning: 'max' },
  fallback: { model: 'deepseek-v4-flash', reasoning: 'max' },
  visualReviewer: { model: 'glm-5.3-flash', reasoning: 'high' },
}

try {
  // ── R2.1: legacy profile compatibility ─────────────────────────────
  check('R2.1: all four built-in profiles import with zero errors', () => {
    const raw = buildRaw(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, raw, null)
    assert.deepEqual(c.errors, [])
    for (const id of ['deepseek-codex', 'glm-codex', 'muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode']) {
      assert.ok(c.configs[id], id + ' missing')
      assert.deepEqual(schemas.validateModeConfiguration(c.configs[id], 'cfg.' + id), [])
    }
    assert.equal(c.profileMeta['deepseek-codex'].modeId, 'engineering-v1')
    assert.equal(c.profileMeta['glm-codex'].modeId, 'engineering-v1')
    assert.equal(c.profileMeta['muse-spark-1.3-contributor'].modeId, 'engineering-v2')
    assert.equal(c.profileMeta['muse-spark-1.3-contributor-opencode'].modeId, 'engineering-v2')
  })

  check('R2.1: operator custom profile imports through the same contract', () => {
    const root = makeFixture({ custom: CUSTOM_ROLES })
    const raw = buildRaw(root)
    const c = profileCompat.importCompatibleProfiles(root, raw, null)
    assert.deepEqual(c.errors, [])
    assert.ok(c.configs.custom)
    assert.equal(c.configs.custom.modeId, 'engineering-v1')
    assert.equal(c.profileMeta.custom.source, 'data/custom-engineering-profile.json')
  })

  check('R2.1: dual v1 role bindings are lossless incl. deep/fallback/visual overrides', () => {
    const root = makeFixture({})
    const raw = buildRaw(root)
    const c = profileCompat.importCompatibleProfiles(root, raw, null)
    assert.deepEqual(c.errors, [])
    for (const profileId of ['deepseek-codex', 'glm-codex']) {
      const res = resolver.compileModeConfig(c.configs[profileId], raw, {})
      assert.equal(res.ok, true, profileId + ': ' + JSON.stringify(res.errors))
      for (const role of DUAL_ROLES) {
        const oracle = engineering.resolveTarget(root, profileId, role)
        assert.ok(oracle, profileId + '/' + role + ' has no legacy oracle')
        const compared = parity.compareExecutionTarget(oracle, res.snapshot.roles[role], null)
        assert.equal(compared.match, true, profileId + '/' + role + ': ' + JSON.stringify(compared.mismatches))
        assert.equal(compared.canonicalIdChangeOnly, false)
      }
      const legacyDoc = JSON.parse(fs.readFileSync(path.join(root, 'config', 'engineering-profiles.json'), 'utf8'))
      const legacyProfile = legacyDoc.profiles.find((p) => p.id === profileId)
      assert.deepEqual(profileCompat.verifyPreservedSemantics(profileId, c.configs[profileId], legacyProfile, raw), [])
    }
  })

  check('R2.1: reviewer stays read-only and solver stays approval-gated', () => {
    const raw = buildRaw(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, raw, null)
    const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'routing-policy.json'), 'utf8'))
    for (const profileId of ['deepseek-codex', 'glm-codex']) {
      const res = resolver.compileModeConfig(c.configs[profileId], raw, {})
      assert.equal(res.ok, true)
      assert.deepEqual(parity.checkRoleAuthorization('reviewer', res.snapshot.roles.reviewer, policy.executionClasses), [])
      assert.deepEqual(parity.checkRoleAuthorization('solver', res.snapshot.roles.solver, policy.executionClasses), [])
      assert.deepEqual(parity.checkEngineIsolation('dual-v1', res.snapshot.roles.primaryEngineer), [])
    }
  })

  check('R2.1: muse v2 stays single-agent, Contributor-scoped, xhigh-ceilinged', () => {
    const museDoc = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'muse-profiles.json'), 'utf8'))
    for (const p of museDoc.profiles) {
      assert.equal(p.subagents.enabled, false, p.id + ' must keep no-subagent policy')
      assert.equal(p.review.independent, false, p.id + ' must keep non-independent review')
      assert.equal(p.reasoning.default, 'xhigh', p.id + ' must keep the Contributor ceiling')
    }
    const built = buildNormalized(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, buildRaw(repoRoot), built.aliases)
    assert.deepEqual(c.errors, [])
    for (const profileId of ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode']) {
      assert.equal(c.profileMeta[profileId].singleAgent, true)
      assert.equal(c.profileMeta[profileId].dataUseTier, 'contributor')
      const res = resolver.compileModeConfig(c.configs[profileId], built.snapshot, {})
      assert.equal(res.ok, true, profileId + ': ' + JSON.stringify(res.errors))
      assert.deepEqual(Object.keys(res.snapshot.roles), ['muse_main'])
      assert.equal(res.snapshot.roles.muse_main.dataUseTier, 'contributor')
      assert.deepEqual(parity.checkEngineIsolation('muse-v0', res.snapshot.roles.muse_main), [])
    }
  })

  check('R2.1: custom roles with intentionally different values round-trip exactly', () => {
    const root = makeFixture({ custom: CUSTOM_ROLES })
    const raw = buildRaw(root)
    const c = profileCompat.importCompatibleProfiles(root, raw, null)
    assert.deepEqual(c.errors, [])
    const res = resolver.compileModeConfig(c.configs.custom, raw, {})
    assert.equal(res.ok, true, JSON.stringify(res.errors))
    for (const role of DUAL_ROLES) {
      const oracle = engineering.resolveTarget(root, 'custom', role)
      assert.ok(oracle, 'custom/' + role + ' has no legacy oracle')
      const compared = parity.compareExecutionTarget(oracle, res.snapshot.roles[role], null)
      assert.equal(compared.match, true, 'custom/' + role + ': ' + JSON.stringify(compared.mismatches))
    }
  })

  check('R2.1: legacy selection precedence is preserved (env, settings, preset lock)', () => {
    const root = makeFixture({ settingsProfile: 'glm-codex' })
    assert.equal(nexus.resolveActiveNexusProfile(root, 'aih-engineering').id, 'glm-codex')
    withEnv({ AIH_ACTIVE_PROFILE: 'deepseek-codex' }, () => {
      assert.equal(nexus.resolveActiveNexusProfile(root, 'aih-engineering').id, 'deepseek-codex')
    })
    withEnv({ DSH_AIH_PROFILE: 'glm-codex', AIH_ACTIVE_PROFILE: 'deepseek-codex' }, () => {
      assert.equal(nexus.resolveActiveNexusProfile(root, 'aih-engineering').id, 'glm-codex')
    })
    withEnv({ DSH_AIH_PROFILE: 'glm-codex' }, () => {
      assert.equal(nexus.resolveActiveNexusProfile(root, 'aih-deepseek').id, 'deepseek-codex')
    })
    withEnv({ DSH_AIH_PROFILE: 'invalid-profile' }, () => {
      assert.equal(nexus.resolveActiveNexusProfile(root, 'aih-engineering'), null)
    })
  })

  check('R2.1: unknown and malformed configurations fail with actionable errors, never a default', () => {
    const raw = buildRaw(repoRoot)
    assert.equal(nexus.resolveNexusProfile(repoRoot, 'no-such-profile'), null)
    const bad = profileCompat.importCompatibleProfiles(repoRoot, null, null)
    assert.ok(bad.errors.length > 0)
    const ghost = makeFixture({ custom: { primaryEngineer: { model: 'ghost-model', reasoning: 'high' }, deepEngineer: { model: 'ghost-model', reasoning: 'high' }, reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' }, solver: { model: 'gpt-5.6-sol', reasoning: 'high' }, fallback: { model: 'ghost-model', reasoning: 'high' } } })
    const ghostRaw = buildRaw(ghost)
    const ghostCompat = profileCompat.importCompatibleProfiles(ghost, ghostRaw, null)
    assert.ok(ghostCompat.errors.some((e) => e.indexOf('ghost-model') !== -1 || e.indexOf('custom') !== -1), JSON.stringify(ghostCompat.errors))
    assert.ok(!ghostCompat.configs.custom, 'unresolvable custom must not produce a config')
    withEnv({ DSH_AIH_PROFILE: 'invalid-profile' }, () => {
      assert.equal(nexus.resolveActiveNexusProfile(ghost, 'aih-engineering'), null)
    })
  })

  check('R2.1: import is deterministic and read-only', () => {
    const before = PROD_INPUTS.map((rel) => shaOfFile(path.join(repoRoot, rel)))
    const a = legacyImport.buildRegistrySnapshot(repoRoot)
    const b = legacyImport.buildRegistrySnapshot(repoRoot)
    assert.deepEqual(a.errors, [])
    assert.equal(JSON.stringify(a.snapshot), JSON.stringify(b.snapshot))
    const ca = profileCompat.importCompatibleProfiles(repoRoot, a.snapshot, null)
    const cb = profileCompat.importCompatibleProfiles(repoRoot, b.snapshot, null)
    assert.deepEqual(ca.errors, [])
    assert.equal(JSON.stringify(ca.configs), JSON.stringify(cb.configs))
    const after = PROD_INPUTS.map((rel) => shaOfFile(path.join(repoRoot, rel)))
    assert.deepEqual(after, before)
  })
  // ── R2.2: canonical Muse model identity ────────────────────────────
  check('R2.2: canonical Muse model unifies the checkpoint with two routes', () => {
    const built = buildNormalized(repoRoot)
    const models = built.snapshot.models.filter((m) => m.id === museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(models.length, 1, 'exactly one canonical Muse model must remain')
    const model = models[0]
    assert.equal(model.checkpoint, 'muse-spark-1.3-contributor')
    assert.equal(model.vendor, 'Meta')
    assert.equal(model.dataUseTier, 'contributor')
    assert.deepEqual(model.engines, ['muse-v0'])
    assert.ok(!built.snapshot.models.some((m) => museCanonical.isMuseLegacyModelId(m.id)), 'no legacy Muse model may remain')
    const routes = built.snapshot.routes.filter((x) => x.logicalModelId === museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(routes.length, 2)
    const byProvider = {}
    for (const x of routes) byProvider[x.providerId] = x
    assert.ok(byProvider['meta-model-api'])
    assert.ok(byProvider['opencode-go'])
    assert.equal(byProvider['meta-model-api'].id, 'meta-model-api/' + museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(byProvider['opencode-go'].id, 'opencode-go/' + museCanonical.CANONICAL_MUSE_MODEL_ID)
    for (const x of routes) {
      assert.equal(x.remoteModelId, 'muse-spark-1.3-contributor')
      assert.ok(x.reasoningLevels.indexOf('xhigh') !== -1)
      assert.equal(x.executionKind, 'raw-model')
    }
    assert.deepEqual(built.aliases.legacyModelIds, ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode'])
    assert.deepEqual(built.aliases.legacyProfileIds, ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode'])
  })

  check('R2.2: provider connections are never merged across Muse routes', () => {
    const built = buildNormalized(repoRoot)
    const routes = built.snapshot.routes.filter((x) => x.logicalModelId === museCanonical.CANONICAL_MUSE_MODEL_ID)
    const conns = routes.map((x) => x.connectionId).sort()
    assert.deepEqual(conns, ['conn-meta-model-api', 'conn-opencode-go'])
    for (const id of conns) {
      const conn = built.snapshot.connections.find((x) => x.id === id)
      assert.ok(conn, id + ' connection record must survive')
    }
  })

  check('R2.2: historical aliases resolve explicitly, unknowns fail closed', () => {
    assert.equal(museCanonical.canonicalModelIdOf('muse-spark-1.3-contributor'), museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(museCanonical.canonicalModelIdOf('muse-spark-1.3-contributor-opencode'), museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(museCanonical.canonicalModelIdOf(museCanonical.CANONICAL_MUSE_MODEL_ID), museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(museCanonical.canonicalModelIdOf('ghost-model'), null)
    assert.equal(museCanonical.canonicalModelIdOf(null), null)
    assert.deepEqual(museCanonical.aliasRecord().legacyModelIds.length, 2)
  })

  check('R2.2: Meta and OpenCode routes compile independently and stay distinct', () => {
    const built = buildNormalized(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, buildRaw(repoRoot), built.aliases)
    assert.deepEqual(c.errors, [])
    const meta = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor'], built.snapshot, {})
    const open = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor-opencode'], built.snapshot, {})
    assert.equal(meta.ok, true)
    assert.equal(open.ok, true)
    assert.equal(meta.snapshot.roles.muse_main.providerId, 'meta-model-api')
    assert.equal(open.snapshot.roles.muse_main.providerId, 'opencode-go')
    assert.ok(meta.snapshot.roles.muse_main.routeId !== open.snapshot.roles.muse_main.routeId)
    assert.ok(meta.snapshot.roles.muse_main.connectionId !== open.snapshot.roles.muse_main.connectionId)
    assert.equal(meta.snapshot.roles.muse_main.remoteModelId, open.snapshot.roles.muse_main.remoteModelId)
  })

  check('R2.2: checkpoint or capability mismatch fails closed without unification', () => {
    const root = makeFixture({ registryMutate: (doc) => {
      const entry = doc.models.find((m) => m.id === 'muse-spark-1.3-contributor-opencode')
      entry.maxOutputTokens = 1
    } })
    const raw = buildRaw(root)
    const n = museCanonical.normalizeMuseSnapshot(raw)
    assert.equal(n.snapshot, null)
    assert.ok(n.errors.some((e) => e.indexOf('muse-canonical-mismatch:maxOutputTokens') !== -1), JSON.stringify(n.errors))
    const missing = makeFixture({ registryMutate: (doc) => {
      doc.models = doc.models.filter((m) => m.id !== 'muse-spark-1.3-contributor-opencode')
    } })
    const missingRaw = legacyImport.buildRegistrySnapshot(missing)
    const n2 = museCanonical.normalizeMuseSnapshot(missingRaw.snapshot)
    assert.equal(n2.snapshot, null)
    assert.ok(n2.errors.some((e) => e.indexOf('muse-canonical-missing-legacy-entry') !== -1))
  })

  // ── R2.3: DSH anti-corruption adapter ────────────────────────────────
  check('R2.3: adapter maps every legacy provider and mode, locks stay reported', () => {
    for (const key of ['flash-max-direct', 'flash-high-direct', 'deepseek-pro-direct', 'sol-local', 'zai-direct', 'deepseek-vision-direct', 'meta-model-api', 'opencode-go']) {
      assert.equal(dshAdapter.dshProviderKeyOf(key), key)
      assert.deepEqual(dshAdapter.providerToDshKey(key), { key, error: null })
    }
    assert.equal(dshAdapter.dshProviderKeyOf('ghost-provider'), null)
    assert.ok(dshAdapter.providerToDshKey('ghost-provider').error)
    assert.equal(dshAdapter.dshPresetOfMode('engineering-v1'), 'aih-engineering')
    assert.equal(dshAdapter.dshPresetOfMode('engineering-v2'), 'aih-muse')
    assert.equal(dshAdapter.dshPresetOfMode('engineering-v3'), null)
    assert.equal(dshAdapter.isLockedDshPreset('aih-deepseek'), true)
    assert.equal(dshAdapter.isLockedDshPreset('aih-engineering'), false)
    for (const profile of ['deepseek-codex', 'glm-codex', 'custom', 'muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode']) {
      assert.ok(dshAdapter.canonicalModeOfLegacyProfile(profile), profile)
    }
    assert.equal(dshAdapter.canonicalModeOfLegacyProfile('ghost'), null)
  })

  check('R2.3: binding projection matches the legacy target shape without mutating', () => {
    const root = makeFixture({})
    const raw = buildRaw(root)
    const c = profileCompat.importCompatibleProfiles(root, raw, null)
    const res = resolver.compileModeConfig(c.configs['deepseek-codex'], raw, {})
    assert.equal(res.ok, true)
    const binding = res.snapshot.roles.primaryEngineer
    const frozen = JSON.stringify(binding)
    const projected = dshAdapter.bindingToLegacyTarget(binding)
    assert.equal(projected.error, null)
    assert.deepEqual(shapeSubset(projected.target), shapeSubset(engineering.resolveTarget(root, 'deepseek-codex', 'primaryEngineer')))
    assert.equal(JSON.stringify(binding), frozen, 'projection must not mutate the binding')
    const bad = dshAdapter.bindingToLegacyTarget({ providerId: 'ghost', remoteModelId: 'm', reasoning: 'high' })
    assert.equal(bad.target, null)
    assert.ok(bad.error)
  })

  check('R2.3: canonical providers carry no DSH identifiers; the field is rejected', () => {
    const raw = buildRaw(repoRoot)
    for (const p of raw.providers) {
      assert.ok(!Object.prototype.hasOwnProperty.call(p, 'legacyDshProviderId'), p.id)
    }
    const withLegacy = Object.assign({}, raw.providers[0], { legacyDshProviderId: raw.providers[0].id })
    assert.ok(schemas.validateProvider(withLegacy, 'p').some((e) => e.code === 'unknown-field'))
  })

  check('R2.3: core stays free of DSH, PowerShell, env and secret dependencies', () => {
    const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'A-Za-z0-9_])\/\/[^\n]*/g, '$1')
    const coreFiles = ['schemas.cjs', 'resolver.cjs', 'legacy-import.cjs', 'muse-canonical.cjs', 'profile-compat.cjs', 'parity.cjs', 'migration.cjs']
    for (const name of coreFiles) {
      const text = stripComments(fs.readFileSync(path.join(repoRoot, 'config', 'registry', name), 'utf8'))
      assert.ok(text.indexOf('process.env') === -1, name + ' must not read process.env')
      assert.ok(text.indexOf('DSH_HOME') === -1, name + ' must not reference DSH_HOME')
      assert.ok(text.indexOf('AIH_INSTALL_ROOT') === -1, name + ' must not reference AIH_INSTALL_ROOT')
      assert.ok(text.toLowerCase().indexOf('powershell') === -1, name + ' must not reference PowerShell')
      assert.ok(text.indexOf('.ps1') === -1, name + ' must not reference PowerShell scripts')
      const blessed = ['node:fs', 'node:path', 'node:crypto', 'node:os', './schemas.cjs', './resolver.cjs', './legacy-import.cjs', './muse-canonical.cjs', './dsh-adapter.cjs', './profile-compat.cjs', './parity.cjs', './migration.cjs']
      const found = Array.from(text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1])
      for (const dep of found) assert.ok(blessed.indexOf(dep) !== -1, name + ' requires unblessed module ' + dep)
    }
    const adapterCode = stripComments(fs.readFileSync(path.join(repoRoot, 'config', 'registry', 'dsh-adapter.cjs'), 'utf8'))
    assert.ok(adapterCode.indexOf('process.env') === -1, 'adapter must not read process.env')
    assert.ok(adapterCode.indexOf('require(') === -1, 'adapter must not require any module')
    assert.ok(adapterCode.indexOf('node:fs') === -1, 'adapter must not touch the filesystem')
    assert.ok(adapterCode.toLowerCase().indexOf('powershell') === -1, 'adapter must not reference PowerShell')
  })

  check('R2.3: snapshots carry no secret material and the scanner proves it', () => {
    const built = buildNormalized(repoRoot)
    assert.equal(dshAdapter.snapshotHasSecrets(built.snapshot), false)
    const plan = migration.planMigration(repoRoot)
    assert.ok(plan.preview)
    assert.equal(dshAdapter.snapshotHasSecrets(plan.preview), false)
    assert.equal(dshAdapter.snapshotHasSecrets({ token: 'sk-live-abc123' }), true)
    assert.equal(dshAdapter.snapshotHasSecrets({ credentialRef: 'sk-live-SECRET' }), true)
    assert.equal(dshAdapter.snapshotHasSecrets(built.snapshot.connections), false)
  })
  // ── R2.4: deterministic resolution parity ────────────────────────────
  check('R2.4: built-in dual parity matrix matches on every role', () => {
    const root = makeFixture({})
    const raw = buildRaw(root)
    const c = profileCompat.importCompatibleProfiles(root, raw, null)
    assert.deepEqual(c.errors, [])
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'config', 'routing-policy.json'), 'utf8'))
    const results = []
    for (const profileId of ['deepseek-codex', 'glm-codex']) {
      const res = resolver.compileModeConfig(c.configs[profileId], raw, {})
      assert.equal(res.ok, true)
      for (const role of DUAL_ROLES) {
        const oracle = engineering.resolveTarget(root, profileId, role)
        assert.ok(oracle)
        const compared = parity.compareExecutionTarget(oracle, res.snapshot.roles[role], null)
        results.push(Object.assign({ profile: profileId, role }, compared))
        results.push({ profile: profileId, role: role + ':auth', match: parity.checkRoleAuthorization(role, res.snapshot.roles[role], policy.executionClasses).length === 0, canonicalIdChangeOnly: false, mismatches: parity.checkRoleAuthorization(role, res.snapshot.roles[role], policy.executionClasses) })
        results.push({ profile: profileId, role: role + ':engine', match: parity.checkEngineIsolation('dual-v1', res.snapshot.roles[role]).length === 0, canonicalIdChangeOnly: false, mismatches: parity.checkEngineIsolation('dual-v1', res.snapshot.roles[role]) })
      }
    }
    const summary = parity.summarizeComparisons(results)
    assert.equal(summary.mismatched, 0, JSON.stringify(summary.failures).slice(0, 1000))
    assert.equal(summary.total, 36)
  })

  check('R2.4: muse parity matches with canonical-id-change distinguished', () => {
    const root = makeFixture({})
    const built = buildNormalized(root)
    const c = profileCompat.importCompatibleProfiles(root, buildRaw(root), built.aliases)
    assert.deepEqual(c.errors, [])
    const results = []
    for (const profileId of ['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-opencode']) {
      const oracle = nexus.resolveMuseProfileModel(root, profileId)
      assert.ok(oracle)
      const res = resolver.compileModeConfig(c.configs[profileId], built.snapshot, {})
      assert.equal(res.ok, true, profileId + ': ' + JSON.stringify(res.errors))
      const compared = parity.compareExecutionTarget(oracle, res.snapshot.roles.muse_main, museCanonical.CANONICAL_MUSE_MODEL_ID)
      assert.equal(compared.match, true, profileId + ': ' + JSON.stringify(compared.mismatches))
      assert.equal(compared.canonicalIdChangeOnly, true, profileId + ' must record the expected canonical id change')
      results.push(compared)
    }
    const raw = buildRaw(root)
    const rawCompat = profileCompat.importCompatibleProfiles(root, raw, null)
    const legacyOnly = parity.compareExecutionTarget(
      nexus.resolveMuseProfileModel(root, 'muse-spark-1.3-contributor'),
      resolver.compileModeConfig(rawCompat.configs['muse-spark-1.3-contributor'], raw, {}).snapshot.roles.muse_main,
      null,
    )
    assert.equal(legacyOnly.match, true)
    assert.equal(legacyOnly.canonicalIdChangeOnly, false)
    assert.equal(parity.summarizeComparisons(results).mismatched, 0)
  })

  check('R2.4: custom parity matrix matches with different values per role', () => {
    const root = makeFixture({ custom: CUSTOM_ROLES })
    const raw = buildRaw(root)
    const c = profileCompat.importCompatibleProfiles(root, raw, null)
    assert.deepEqual(c.errors, [])
    const res = resolver.compileModeConfig(c.configs.custom, raw, {})
    assert.equal(res.ok, true, JSON.stringify(res.errors))
    const results = []
    for (const role of DUAL_ROLES) {
      const oracle = engineering.resolveTarget(root, 'custom', role)
      assert.ok(oracle, 'custom/' + role)
      const compared = parity.compareExecutionTarget(oracle, res.snapshot.roles[role], null)
      assert.equal(compared.match, true, 'custom/' + role + ': ' + JSON.stringify(compared.mismatches))
      results.push(compared)
    }
    assert.equal(parity.summarizeComparisons(results).mismatched, 0)
  })

  check('R2.4: execution-target mismatches are never masked as canonical changes', () => {
    const root = makeFixture({})
    const built = buildNormalized(root)
    const tampered = JSON.parse(JSON.stringify(built.snapshot))
    tampered.routes.find((x) => x.id === 'meta-model-api/' + museCanonical.CANONICAL_MUSE_MODEL_ID).remoteModelId = 'tampered-checkpoint'
    const c = profileCompat.importCompatibleProfiles(root, buildRaw(root), built.aliases)
    const res = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor'], tampered, {})
    assert.equal(res.ok, true)
    const oracle = nexus.resolveMuseProfileModel(root, 'muse-spark-1.3-contributor')
    const compared = parity.compareExecutionTarget(oracle, res.snapshot.roles.muse_main, museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(compared.match, false)
    assert.equal(compared.canonicalIdChangeOnly, false)
    assert.ok(compared.mismatches.some((m) => m.code === 'parity-remote-model-mismatch'))
  })

  check('R2.4: failure parity across invalid states (no silent substitution)', () => {
    const root = makeFixture({})
    const raw = buildRaw(root)
    const failCases = []
    const unknownOracle = engineering.resolveTarget(root, 'deepseek-codex', 'no-such-role')
    const unknownCfg = JSON.parse(JSON.stringify(profileCompat.importCompatibleProfiles(root, raw, null).configs['deepseek-codex']))
    unknownCfg.roleOverrides['no-such-role'] = { reasoning: 'high' }
    const unknownRes = resolver.compileModeConfig(unknownCfg, raw, {})
    failCases.push(parity.compareFailure(unknownOracle, unknownRes.ok, 'unknown-role'))
    const badReasonOracle = engineering.roleBindingTarget(JSON.parse(fs.readFileSync(path.join(root, 'config', 'model-registry.json'), 'utf8')), { roles: { primaryEngineer: { model: 'deepseek-v4-flash', reasoning: 'ultra' } } }, 'primaryEngineer')
    const badReasonCfg = JSON.parse(JSON.stringify(profileCompat.importCompatibleProfiles(root, raw, null).configs['deepseek-codex']))
    badReasonCfg.slots.engineer.reasoning = 'ultra'
    const badReasonRes = resolver.compileModeConfig(badReasonCfg, raw, {})
    assert.equal(badReasonRes.ok, false)
    failCases.push(parity.compareFailure(badReasonOracle, badReasonRes.ok, 'invalid-reasoning'))
    const ghostOracle = engineering.resolveTarget(root, 'deepseek-codex', 'primaryEngineer')
    assert.ok(ghostOracle)
    const ghostCfg = JSON.parse(JSON.stringify(profileCompat.importCompatibleProfiles(root, raw, null).configs['deepseek-codex']))
    ghostCfg.slots.engineer.logicalModelId = 'ghost-model'
    const ghostRes = resolver.compileModeConfig(ghostCfg, raw, {})
    assert.equal(ghostRes.ok, false)
    const maxOracle = nexus.resolveMuseProfileModel(root, 'muse-spark-1.3-contributor', 'max')
    const built = buildNormalized(root)
    const museC = profileCompat.importCompatibleProfiles(root, buildRaw(root), built.aliases)
    const maxCfg = JSON.parse(JSON.stringify(museC.configs['muse-spark-1.3-contributor']))
    maxCfg.slots.main.reasoning = 'max'
    const maxRes = resolver.compileModeConfig(maxCfg, built.snapshot, {})
    assert.equal(maxRes.ok, false)
    failCases.push(parity.compareFailure(maxOracle, maxRes.ok, 'muse-max-ceiling'))
    const incompleteRoot = makeFixture({ custom: { primaryEngineer: { model: 'glm-5.3', reasoning: 'high' } } })
    const incompleteProfiles = engineering.loadProfiles(incompleteRoot)
    const incompleteRegistry = engineering.loadRegistry(incompleteRoot)
    const incompleteSatisfiable = engineering.bindingsSatisfiable(incompleteRegistry, engineering.profileById(incompleteProfiles, 'custom'))
    const incompleteRaw = buildRaw(incompleteRoot)
    const incompleteCompat = profileCompat.importCompatibleProfiles(incompleteRoot, incompleteRaw, null)
    assert.ok(!incompleteCompat.configs.custom)
    failCases.push(parity.compareFailure(incompleteSatisfiable ? {} : null, !!incompleteCompat.configs.custom, 'incomplete-custom'))
    const wrongReviewerOracle = engineering.roleBindingTarget(JSON.parse(fs.readFileSync(path.join(root, 'config', 'model-registry.json'), 'utf8')), { roles: { reviewer: { model: 'deepseek-v4-flash', reasoning: 'high' } } }, 'reviewer')
    const wrongReviewerCfg = JSON.parse(JSON.stringify(profileCompat.importCompatibleProfiles(root, raw, null).configs['deepseek-codex']))
    const deepRoute = raw.routes.find((x) => x.logicalModelId === 'deepseek-v4-flash' && x.reasoningLevels.indexOf('high') !== -1)
    wrongReviewerCfg.slots.reviewer = { logicalModelId: 'deepseek-v4-flash', routeId: deepRoute.id, reasoning: 'high' }
    const wrongReviewerRes = resolver.compileModeConfig(wrongReviewerCfg, raw, {})
    assert.equal(wrongReviewerRes.ok, false)
    failCases.push(parity.compareFailure(wrongReviewerOracle, wrongReviewerRes.ok, 'reviewer-provider-pin'))
    const crossOracle = engineering.roleBindingTarget(JSON.parse(fs.readFileSync(path.join(root, 'config', 'model-registry.json'), 'utf8')), { roles: { primaryEngineer: { model: 'muse-spark-1.3-contributor', reasoning: 'xhigh' } } }, 'primaryEngineer')
    const crossCfg = JSON.parse(JSON.stringify(profileCompat.importCompatibleProfiles(root, raw, null).configs['deepseek-codex']))
    const metaRoute = built.snapshot.routes.find((x) => x.id === 'meta-model-api/' + museCanonical.CANONICAL_MUSE_MODEL_ID)
    crossCfg.slots.engineer = { logicalModelId: museCanonical.CANONICAL_MUSE_MODEL_ID, routeId: metaRoute.id, reasoning: 'xhigh' }
    const crossRes = resolver.compileModeConfig(crossCfg, built.snapshot, {})
    assert.equal(crossRes.ok, false)
    assert.ok(crossRes.errors.some((e) => e.code === 'engine-scope-mismatch' || e.code === 'unknown-reference'))
    failCases.push(parity.compareFailure(crossOracle, crossRes.ok, 'contributor-in-dual-mode'))
    for (const f of failCases) assert.equal(f.match, true, JSON.stringify(f.detail))
  })

  check('R2.4: disabled routes and revoked connections fail closed (documented hardening)', () => {
    const root = makeFixture({})
    const built = buildNormalized(root)
    const c = profileCompat.importCompatibleProfiles(root, buildRaw(root), built.aliases)
    const disabled = JSON.parse(JSON.stringify(built.snapshot))
    disabled.routes.find((x) => x.id === 'meta-model-api/' + museCanonical.CANONICAL_MUSE_MODEL_ID).enabled = false
    const disabledRes = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor'], disabled, {})
    assert.equal(disabledRes.ok, false)
    assert.ok(disabledRes.errors.some((e) => e.code === 'route-unavailable'))
    const revoked = JSON.parse(JSON.stringify(built.snapshot))
    revoked.connections.find((x) => x.id === 'conn-meta-model-api').status = 'revoked'
    const revokedRes = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor'], revoked, {})
    assert.equal(revokedRes.ok, false)
    assert.ok(revokedRes.errors.some((e) => e.code === 'connection-auth-required'))
    assert.ok(nexus.resolveMuseProfileModel(root, 'muse-spark-1.3-contributor'), 'legacy oracle has no connection concept; registry hardening is intentionally stricter')
  })
  // ── R2.5: reversible migration plan and dry run ────────────────────────
  check('R2.5: legacy formats are detected without destructive changes', () => {
    const detected = migration.detectLegacyFormats(repoRoot)
    assert.equal(detected.malformed.length, 0)
    assert.deepEqual(detected.missing, [])
    assert.ok(detected.formats.length >= 5)
    assert.equal(detected.hasCustom, false)
    const customRoot = makeFixture({ custom: CUSTOM_ROLES })
    assert.equal(migration.detectLegacyFormats(customRoot).hasCustom, true)
  })

  check('R2.5: migration preview is deterministic, aliased and machine-readable', () => {
    const first = migration.planMigration(repoRoot)
    assert.ok(first.preview, JSON.stringify(first.errors))
    assert.deepEqual(first.errors, [])
    assert.ok(/^[0-9a-f]{64}$/.test(first.preview.planHash))
    assert.equal(first.preview.aliases.canonicalModelId, museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.ok(first.preview.proposedConfigs['deepseek-codex'])
    assert.ok(first.preview.proposedConfigs['muse-spark-1.3-contributor-opencode'])
    const museDiff = first.preview.diffs.find((d) => d.profileId === 'muse-spark-1.3-contributor')
    assert.ok(museDiff.changes.length > 0)
    assert.ok(museDiff.changes.every((x) => x.kind === 'canonical-id-change'))
    const dualDiff = first.preview.diffs.find((d) => d.profileId === 'deepseek-codex')
    assert.ok(dualDiff.changes.every((x) => x.kind === 'adopted-verbatim'))
    JSON.parse(JSON.stringify(first.preview))
    const second = migration.planMigration(repoRoot)
    assert.equal(second.preview.planHash, first.preview.planHash)
    assert.deepEqual(migration.verifyPlanIdempotent(repoRoot), { idempotent: true, errors: [] })
  })

  check('R2.5: rollback restores a byte-exact isolated copy', () => {
    const first = migration.planMigration(repoRoot)
    const made = migration.createLegacyBackup(repoRoot)
    assert.deepEqual(made.errors, [])
    assert.ok(made.backup)
    assert.equal(made.backup.sourceRoot, path.resolve(repoRoot))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-rollback-'))
    fixtureRoots.push(target)
    const restored = migration.restoreLegacySource(made.backup, target)
    assert.deepEqual(restored.errors, [])
    assert.equal(restored.restored, true)
    for (const rel of migration.KNOWN_LEGACY_FILES) {
      const entry = made.backup.files[rel]
      assert.ok(entry && entry.present, rel + ' must be backed up')
      const srcHash = shaOfFile(path.join(repoRoot, rel))
      assert.equal(srcHash, entry.sha256)
      assert.equal(shaOfFile(path.join(target, rel)), srcHash, rel + ' must restore byte-exact')
    }
    const replanned = migration.planMigration(target)
    assert.ok(replanned.preview, JSON.stringify(replanned.errors))
    assert.equal(replanned.preview.planHash, first.preview.planHash)
  })

  check('R2.5: preview applies to isolated roots and refuses production targets', () => {
    const first = migration.planMigration(repoRoot)
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-preview-'))
    fixtureRoots.push(isolated)
    const applied = migration.applyPlanToIsolatedRoot(first.preview, repoRoot, path.join(isolated, 'review'))
    assert.deepEqual(applied.errors, [])
    assert.equal(applied.applied, true)
    assert.ok(fs.existsSync(path.join(isolated, 'review', 'migration-preview.json')))
    const refused = migration.applyPlanToIsolatedRoot(first.preview, repoRoot, repoRoot)
    assert.equal(refused.applied, false)
    assert.ok(refused.errors.some((e) => e.indexOf('migration-refuses-production-target') !== -1))
  })

  // ── R2.6: session and controller boundary protection ───────────────────
  check('R2.6: compiled bindings are immutable snapshots', () => {
    const built = buildNormalized(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, buildRaw(repoRoot), built.aliases)
    const res = resolver.compileModeConfig(c.configs['deepseek-codex'], built.snapshot, {})
    assert.equal(res.ok, true)
    assert.ok(Object.isFrozen(res.snapshot))
    for (const role of Object.keys(res.snapshot.roles)) {
      assert.ok(Object.isFrozen(res.snapshot.roles[role]), role + ' binding must be frozen')
    }
  })

  check('R2.6: alias changes never silently retarget a pinned task', () => {
    const built = buildNormalized(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, buildRaw(repoRoot), built.aliases)
    const metaRes = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor'], built.snapshot, {})
    assert.equal(metaRes.ok, true)
    const pinned = metaRes.snapshot.roles.muse_main
    const pinnedCopy = JSON.parse(JSON.stringify(pinned))
    const openRes = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor-opencode'], built.snapshot, {})
    assert.equal(openRes.ok, true)
    assert.equal(profileCompat.pinnedBindingPreserved(pinned, openRes.snapshot.roles.muse_main), false)
    assert.equal(profileCompat.pinnedBindingPreserved(pinned, JSON.parse(JSON.stringify(pinned))), true)
    assert.deepEqual(JSON.parse(JSON.stringify(pinned)), pinnedCopy, 'pinned binding must be unchanged by later resolutions')
    const projected = dshAdapter.bindingToLegacyTarget(pinned)
    assert.equal(projected.error, null)
    assert.equal(projected.target.provider, 'meta-model-api')
    assert.deepEqual(JSON.parse(JSON.stringify(pinned)), pinnedCopy, 'projection must not mutate the pinned binding')
  })

  check('R2.6: active-task fixture survives route discovery without retargeting', () => {
    const built = buildNormalized(repoRoot)
    const c = profileCompat.importCompatibleProfiles(repoRoot, buildRaw(repoRoot), built.aliases)
    const res = resolver.compileModeConfig(c.configs['muse-spark-1.3-contributor'], built.snapshot, {})
    assert.equal(res.ok, true)
    const activeTask = {
      taskId: 'task-r2-fixture-001',
      executionClass: 'muse',
      binding: res.snapshot.roles.muse_main,
    }
    const eligible = resolver.listEligibleRoutes('engineering-v2', 'main', built.snapshot, null)
    assert.ok(eligible.length >= 2, 'newly discovered routes appear in listings')
    assert.deepEqual(JSON.parse(JSON.stringify(activeTask.binding)), JSON.parse(JSON.stringify(res.snapshot.roles.muse_main)))
    assert.equal(activeTask.binding.routeId, 'meta-model-api/' + museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(profileCompat.pinnedBindingPreserved(activeTask.binding, res.snapshot.roles.muse_main), true)
  })

  check('R2.1: previews never contain secret-bearing settings content', () => {
    const root = makeFixture({ settingsProfile: 'deepseek-codex' })
    const fakeA = 'sk-live-R2TEST-FAKE-AAA111'
    const fakeB = 'xoxb-R2TEST-FAKE-BBB222'
    const settingsBody = '# operator settings (fixture only)' + String.fromCharCode(10) + 'engineering-profile: deepseek-codex' + String.fromCharCode(10) + 'llm-pi-ai:' + String.fromCharCode(10) + '  providers:' + String.fromCharCode(10) + '    zai-direct:' + String.fromCharCode(10) + '      apiKey: ' + fakeA + String.fromCharCode(10) + '      token: ' + fakeB + String.fromCharCode(10)
    fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), settingsBody)
    const planned = migration.planMigration(root)
    assert.ok(planned.preview, JSON.stringify(planned.errors))
    const previewText = JSON.stringify(planned.preview)
    assert.ok(previewText.indexOf(fakeA) === -1, 'preview must not embed raw API keys')
    assert.ok(previewText.indexOf(fakeB) === -1, 'preview must not embed raw tokens')
    assert.equal(planned.preview.legacyDigest.settings.present, true)
    assert.equal(planned.preview.legacyDigest.settings.engineeringProfile, 'deepseek-codex')
    assert.ok(!('settingsYaml' in planned.preview.legacyDigest.settings), 'no settings body field may exist on the digest')
    const made = migration.createLegacyBackup(root)
    assert.deepEqual(made.errors, [])
    assert.ok(made.backup.files['data/settings.yaml'].content.indexOf(fakeA) !== -1, 'explicit backup must stay complete for restore')
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-secret-'))
    fixtureRoots.push(isolated)
    const applied = migration.applyPlanToIsolatedRoot(planned.preview, root, path.join(isolated, 'review'))
    assert.deepEqual(applied.errors, [])
    const onDisk = fs.readFileSync(path.join(isolated, 'review', 'migration-preview.json'), 'utf8')
    assert.ok(onDisk.indexOf(fakeA) === -1 && onDisk.indexOf(fakeB) === -1, 'preview artifact on disk must stay secret-free')
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-secret-rb-'))
    fixtureRoots.push(target)
    assert.deepEqual(migration.restoreLegacySource(made.backup, target).errors, [])
    assert.equal(fs.readFileSync(path.join(target, 'data', 'settings.yaml'), 'utf8'), settingsBody)
  }),

  check('R2.5: adversarial destinations and file keys are refused', () => {
    const src = makeFixture({ custom: CUSTOM_ROLES })
    const made = migration.createLegacyBackup(src)
    assert.deepEqual(made.errors, [])
    const nested = migration.restoreLegacySource(made.backup, path.join(src, 'nested-evil'))
    assert.equal(nested.restored, false)
    assert.ok(nested.errors.some((e) => e.indexOf('migration-refuses-production-target') !== -1))
    const selfHit = migration.restoreLegacySource(made.backup, src)
    assert.equal(selfHit.restored, false)
    const probe = path.join(repoRoot, 'tmp-r21-adversarial-probe')
    const outside = migration.restoreLegacySource(made.backup, probe)
    assert.equal(outside.restored, false)
    assert.ok(outside.errors.some((e) => e.indexOf('migration-outside-isolated-tmp') !== -1), JSON.stringify(outside.errors))
    assert.ok(!fs.existsSync(probe), 'refused destinations must stay untouched')
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-link-'))
    fixtureRoots.push(linkDir)
    fs.symlinkSync(src, path.join(linkDir, 'alias'))
    const viaLink = migration.restoreLegacySource(made.backup, path.join(linkDir, 'alias', 'sub'))
    assert.equal(viaLink.restored, false)
    assert.ok(viaLink.errors.some((e) => e.indexOf('migration-symlink-alias-refused') !== -1), JSON.stringify(viaLink.errors))
    const evilParent = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-evil-'))
    fixtureRoots.push(evilParent)
    const evilTarget = path.join(evilParent, 'target')
    for (const badKey of ['../evil-escape.json', '/tmp/abs-evil.json', 'config/extra.json', '..']) {
      const evil = JSON.parse(JSON.stringify(made.backup))
      evil.files[badKey] = { present: true, sha256: 'dead', content: '{}' }
      const attempt = migration.restoreLegacySource(evil, evilTarget)
      assert.equal(attempt.restored, false, badKey)
      assert.ok(attempt.errors.some((e) => e.indexOf('migration-unexpected-file') !== -1), badKey + ': ' + JSON.stringify(attempt.errors))
    }
    assert.ok(!fs.existsSync(path.join(evilParent, 'evil-escape.json')))
    assert.ok(!fs.existsSync('/tmp/abs-evil.json'))
    const okTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-overwrite-'))
    fixtureRoots.push(okTarget)
    assert.deepEqual(migration.restoreLegacySource(made.backup, okTarget).errors, [])
    assert.deepEqual(migration.restoreLegacySource(made.backup, okTarget).errors, [], 'identical re-restore is not an overwrite')
    const victim = path.join(okTarget, 'config', 'model-registry.json')
    fs.writeFileSync(victim, '{tampered}')
    const refused = migration.restoreLegacySource(made.backup, okTarget)
    assert.equal(refused.restored, false)
    assert.ok(refused.errors.some((e) => e.indexOf('migration-refuses-overwrite') !== -1))
    assert.equal(fs.readFileSync(victim, 'utf8'), '{tampered}')
    const forced = migration.restoreLegacySource(made.backup, okTarget, { overwrite: true })
    assert.deepEqual(forced.errors, [])
    assert.equal(shaOfFile(victim), made.backup.files['config/model-registry.json'].sha256.replace(/^/, ''))
  }),

  check('R2.5: rollback preserves formatting, comments, YAML and absence byte-exact', () => {
    const root = makeFixture({ custom: CUSTOM_ROLES, settingsProfile: 'glm-codex' })
    const engPath = path.join(root, 'config', 'engineering-profiles.json')
    const funky = JSON.stringify(JSON.parse(fs.readFileSync(engPath, 'utf8')), null, 4) + String.fromCharCode(10) + String.fromCharCode(10)
    fs.writeFileSync(engPath, funky)
    const hash = '# operator header comment, keep me' + String.fromCharCode(10) + 'engineering-profile: glm-codex   # trailing comment' + String.fromCharCode(10) + 'llm-pi-ai:' + String.fromCharCode(10) + '  providers: {}' + String.fromCharCode(10)
    fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), hash)
    fs.rmSync(path.join(root, 'data', 'custom-engineering-profile.json'))
    const planned = migration.planMigration(root)
    assert.ok(planned.preview, JSON.stringify(planned.errors))
    assert.equal(planned.preview.legacyDigest.settings.engineeringProfile, 'glm-codex')
    assert.equal(planned.preview.legacyDigest.customProfile.present, false)
    const made = migration.createLegacyBackup(root)
    assert.deepEqual(made.errors, [])
    assert.equal(made.backup.files['data/custom-engineering-profile.json'].present, false)
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r2-bytes-'))
    fixtureRoots.push(target)
    assert.deepEqual(migration.restoreLegacySource(made.backup, target).errors, [])
    for (const rel of migration.KNOWN_LEGACY_FILES.concat(['data/settings.yaml'])) {
      const entry = made.backup.files[rel]
      assert.ok(entry && entry.present, rel)
      assert.equal(shaOfFile(path.join(target, rel)), entry.sha256, rel + ' byte-exact')
      assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), fs.readFileSync(path.join(root, rel), 'utf8'))
    }
    assert.ok(!fs.existsSync(path.join(target, 'data', 'custom-engineering-profile.json')), 'absent files stay absent')
    assert.ok(fs.readFileSync(path.join(target, 'data', 'settings.yaml'), 'utf8').indexOf('# operator header comment, keep me') !== -1, 'YAML comments survive')
    const replanned = migration.planMigration(target)
    assert.ok(replanned.preview)
    assert.equal(replanned.preview.planHash, planned.preview.planHash)
  }),

  check('R2.4: arbitrary engine ids fail isolation closed', () => {
    assert.deepEqual(parity.KNOWN_ORCHESTRATION_ENGINES, ['dual-v1', 'muse-v0'])
    assert.deepEqual(parity.checkEngineIsolation('muse-v0', { orchestrationEngineId: 'muse-v0' }), [])
    assert.deepEqual(parity.checkEngineIsolation('dual-v1', { orchestrationEngineId: 'dual-v1' }), [])
    for (const weird of ['dual', 'muse', 'dual-v1-evil', 'muse-v0x', 'MUSE-V0', 'DUAL-V1', '', 'dual-v1,muse-v0']) {
      const got = parity.checkEngineIsolation(weird, { orchestrationEngineId: 'muse-v0' })
      assert.ok(got.length > 0 && got[0].code === 'parity-unknown-engine', String(weird))
    }
    for (const missing of [null, undefined, 42]) {
      assert.ok(parity.checkEngineIsolation(missing, { orchestrationEngineId: 'muse-v0' }).length > 0)
    }
    for (const badActual of ['dual-v1', 'dual', 'muse', 'muse-v0-x', '', null]) {
      const got = parity.checkEngineIsolation('muse-v0', { orchestrationEngineId: badActual })
      assert.ok(got.length > 0 && got[0].code === 'parity-engine-crossover', String(badActual))
    }
    assert.equal(parity.checkEngineIsolation('muse-v0', null)[0].code, 'parity-missing-binding')
  }),

  check('R2.2: canonical routes preserve capacityConstraints and provenance exactly', () => {
    const rawDoc = legacyImport.buildRegistrySnapshot(repoRoot)
    assert.deepEqual(rawDoc.errors, [])
    const withMeta = JSON.parse(JSON.stringify(rawDoc.snapshot))
    for (const r of withMeta.routes) {
      if (r.logicalModelId === 'muse-spark-1.3-contributor-opencode') {
        r.capacityConstraints = { maxOutputTokens: 4096 }
        r.provenance = 'vendor-docs-2026-10'
      }
    }
    const n = museCanonical.normalizeMuseSnapshot(withMeta)
    assert.deepEqual(n.errors, [])
    const open = n.snapshot.routes.find((x) => x.id === 'opencode-go/' + museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.deepEqual(open.capacityConstraints, { maxOutputTokens: 4096 })
    assert.equal(open.provenance, 'vendor-docs-2026-10')
    const meta = n.snapshot.routes.find((x) => x.id === 'meta-model-api/' + museCanonical.CANONICAL_MUSE_MODEL_ID)
    assert.equal(meta.provenance, 'legacy-production-use')
    assert.ok(!('capacityConstraints' in meta), 'absent constraints stay absent, never invented')
    assert.deepEqual(schemas.validateRegistrySnapshot(n.snapshot, 'registry'), [])
    const noProv = JSON.parse(JSON.stringify(rawDoc.snapshot))
    for (const r of noProv.routes) delete r.provenance
    const n2 = museCanonical.normalizeMuseSnapshot(noProv)
    assert.deepEqual(n2.errors, [])
    for (const r of n2.snapshot.routes.filter((x) => x.logicalModelId === museCanonical.CANONICAL_MUSE_MODEL_ID)) {
      assert.ok(!('provenance' in r), 'absent provenance stays absent, never invented')
    }
    assert.deepEqual(schemas.validateRegistrySnapshot(n2.snapshot, 'registry'), [])
  }),
  check('R2.1.1: nested directory symlinks cannot redirect restore writes', () => {
    const src = makeFixture({ custom: CUSTOM_ROLES })
    const before = snapshotSourceFiles(src)
    const made = migration.createLegacyBackup(src)
    assert.deepEqual(made.errors, [])
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r211-nested-'))
    fixtureRoots.push(target)
    fs.symlinkSync(path.join(src, 'config'), path.join(target, 'config'))
    const attempt = migration.restoreLegacySource(made.backup, target)
    assert.equal(attempt.restored, false)
    assert.ok(attempt.errors.some((e) => e.indexOf('migration-symlink-escape:') !== -1), JSON.stringify(attempt.errors))
    assert.ok(!fs.existsSync(path.join(target, 'data')), 'nothing may be written through the escape')
    assertSourceUnchanged(src, before)
  }),

  check('R2.1.1: destination-file symlinks are refused without touching link targets', () => {
    const src = makeFixture({ custom: CUSTOM_ROLES })
    const before = snapshotSourceFiles(src)
    const made = migration.createLegacyBackup(src)
    assert.deepEqual(made.errors, [])
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r211-filelink-'))
    fixtureRoots.push(target)
    fs.mkdirSync(path.join(target, 'data'), { recursive: true })
    const linkSrc = path.join(src, 'data', 'settings.yaml')
    const linkDst = path.join(target, 'data', 'settings.yaml')
    fs.symlinkSync(linkSrc, linkDst)
    const attempt = migration.restoreLegacySource(made.backup, target)
    assert.equal(attempt.restored, false)
    assert.ok(attempt.errors.some((e) => e.indexOf('migration-symlink-escape:data/settings.yaml') !== -1), JSON.stringify(attempt.errors))
    assert.ok(fs.lstatSync(linkDst).isSymbolicLink(), 'the link itself must survive, never be replaced')
    assertSourceUnchanged(src, before)
  }),

  check('R2.1.1: preview apply refuses symlinked destinations and honors authorized roots', () => {
    const src = makeFixture({ settingsProfile: 'deepseek-codex' })
    const before = snapshotSourceFiles(src)
    const planned = migration.planMigration(src)
    assert.ok(planned.preview)
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r211-previewlink-'))
    fixtureRoots.push(target)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r211-outside-'))
    fixtureRoots.push(outside)
    fs.symlinkSync(path.join(src, 'data', 'settings.yaml'), path.join(target, 'migration-preview.json'))
    const attempt = migration.applyPlanToIsolatedRoot(planned.preview, src, target)
    assert.equal(attempt.applied, false)
    assert.ok(attempt.errors.some((e) => e.indexOf('migration-symlink-escape:migration-preview.json') !== -1), JSON.stringify(attempt.errors))
    assertSourceUnchanged(src, before)
    const linkAlias = path.join(target, 'alias')
    fs.symlinkSync(outside, linkAlias)
    const viaAlias = migration.applyPlanToIsolatedRoot(planned.preview, src, path.join(linkAlias, 'review'))
    assert.equal(viaAlias.applied, true, 'non-protected aliases stay usable: ' + JSON.stringify(viaAlias.errors))
    const denied = migration.restoreLegacySource(migration.createLegacyBackup(src).backup, path.join(outside, 'x'), { authorizedRoots: [target] })
    assert.equal(denied.restored, false)
    assert.ok(denied.errors.some((e) => e.indexOf('migration-unauthorized-destination') !== -1))
    const allowed = migration.restoreLegacySource(migration.createLegacyBackup(src).backup, path.join(target, 'ok'), { authorizedRoots: [target] })
    assert.deepEqual(allowed.errors, [])
    assert.equal(allowed.restored, true)
  }),
  check('R2: no legacy production file was modified', () => {
    const after = PROD_INPUTS.map((rel) => shaOfFile(path.join(repoRoot, rel)))
    assert.deepEqual(after, prodHashesBefore)
    assert.ok(!fs.existsSync(path.join(repoRoot, 'data', 'settings.yaml')), 'no live settings file may be created')
  })

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
} finally {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  for (const root of fixtureRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort fixture cleanup
    }
  }
}
