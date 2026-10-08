'use strict'

// R0: offline, read-only golden regression for legacy Nexus model routing.
// These fixtures intentionally freeze the pre-Registry semantic outputs.
// NEVER regenerate expected values from the implementation under test.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const engineering = require('../config/Engineering-Profiles.cjs')
const nexus = require('../config/Nexus-Profiles.cjs')

const sourceRoot = path.resolve(__dirname, '..')
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'registry', 'legacy-targets.json'), 'utf8'))
const configNames = ['routing-policy.json', 'engineering-profiles.json', 'model-registry.json', 'nexus-profiles.json', 'muse-profiles.json']
const savedEnv = Object.fromEntries(['DSH_AIH_PROFILE', 'AIH_ACTIVE_PROFILE', 'DSH_HOME', 'AIH_INSTALL_ROOT'].map((name) => [name, process.env[name]]))
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-r0-'))
let passed = 0

function check(label, fn) {
  fn()
  passed++
  console.log('PASS: ' + label)
}
function shape(target) {
  if (!target) return null
  return {
    modelId: target.modelId,
    model: target.model,
    provider: target.provider,
    reasoning: target.reasoning,
  }
}
function restoreEnv() {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
}

try {
  delete process.env.DSH_HOME
  delete process.env.AIH_INSTALL_ROOT
  delete process.env.DSH_AIH_PROFILE
  delete process.env.AIH_ACTIVE_PROFILE

  fs.mkdirSync(path.join(fixtureRoot, 'config'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'data'), { recursive: true })
  for (const name of configNames) {
    fs.copyFileSync(path.join(sourceRoot, 'config', name), path.join(fixtureRoot, 'config', name))
  }
  fs.writeFileSync(path.join(fixtureRoot, 'data', 'settings.yaml'), 'engineering-profile: deepseek-codex\n')

  check('fixture format and legacy profile catalog', () => {
    assert.equal(golden.schemaVersion, 1)
    assert.deepEqual(nexus.validateCatalogDocument(nexus.loadNexusProfileCatalog(fixtureRoot)), [])
    assert.equal(golden.dualProfiles.length, 2)
    assert.equal(golden.museProfiles.length, 2)
    assert.equal(new Set([...golden.dualProfiles, ...golden.museProfiles].map((x) => x.id)).size, 4)
  })

  const registry = engineering.loadRegistry(fixtureRoot)
  for (const profile of golden.dualProfiles) {
    check('Dual engine identity: ' + profile.id, () => {
      const resolved = nexus.resolveNexusProfile(fixtureRoot, profile.id)
      assert.ok(resolved, profile.id + ': missing')
      assert.equal(resolved.engine, 'dual')
      assert.equal(resolved.runnable, true)
      assert.ok(engineering.bindingsSatisfiable(registry, resolved.config))
      assert.deepEqual(Object.keys(profile.roles).sort(), [...engineering.CORE_ROLES, ...engineering.OPTIONAL_ROLES].sort())
    })

    for (const [role, target] of Object.entries(profile.roles)) {
      check(profile.id + '/' + role + ' golden route', () => {
        const actual = engineering.resolveTarget(fixtureRoot, profile.id, role)
        assert.deepEqual(shape(actual), target)
        const active = nexus.resolveNexusProfile(fixtureRoot, profile.id)
        const validated = engineering.roleBindingTarget(registry, active.config, role)
        assert.deepEqual(shape(validated), target)
      })
    }
  }

  for (const profile of golden.museProfiles) {
    check('Muse engine route: ' + profile.id, () => {
      const active = nexus.resolveNexusProfile(fixtureRoot, profile.id)
      assert.ok(active)
      assert.equal(active.engine, 'muse')
      assert.equal(active.runnable, true)
      assert.equal(active.config.subagents.enabled, false)
      assert.equal(active.config.review.independent, false)
      const target = nexus.resolveMuseProfileModel(fixtureRoot, profile.id)
      assert.deepEqual({ ...shape(target), dataUseTier: target && target.dataUseTier }, {
        modelId: profile.modelId,
        model: profile.model,
        provider: profile.provider,
        reasoning: profile.reasoning,
        dataUseTier: profile.dataUseTier,
      })
      assert.equal(nexus.resolveMuseProfileModel(fixtureRoot, profile.id, 'max'), null,
        'Muse Contributor must fail closed for unsupported max effort')
    })
  }

  check('Muse and Dual engine scopes are disjoint', () => {
    for (const entry of nexus.loadModelRegistry(fixtureRoot).models) {
      const muse = engineering.modelEngineCompatible(entry, 'muse')
      const dual = engineering.modelEngineCompatible(entry, 'dual')
      assert.equal(muse && dual, false, 'entry unexpectedly crosses engine boundary: ' + entry.id)
    }
  })

  check('routing policy preserves reviewer and solver authorization', () => {
    const policy = engineering.loadPolicy(fixtureRoot)
    assert.equal(policy.executionClasses.reviewer.writable, false)
    assert.equal(policy.executionClasses.solver.requiresUserApproval, true)
    assert.equal(policy.executionClasses.solver.writable, true)
    assert.equal(policy.presets['aih-deepseek'].profileOverrideAllowed, false)
    assert.equal(policy.executionClassAliases.codex_review, 'reviewer')
    assert.equal(policy.executionClassAliases.codex_solve, 'solver')
  })

  check('legacy preferred-profile order and locked preset', () => {
    assert.equal(nexus.resolveActiveNexusProfile(fixtureRoot, 'aih-engineering').id, 'deepseek-codex')
    process.env.AIH_ACTIVE_PROFILE = 'glm-codex'
    assert.equal(nexus.resolveActiveNexusProfile(fixtureRoot, 'aih-engineering').id, 'glm-codex')
    process.env.DSH_AIH_PROFILE = 'muse-spark-1.3-contributor-opencode'
    assert.equal(nexus.resolveActiveNexusProfile(fixtureRoot, 'aih-engineering').id, 'muse-spark-1.3-contributor-opencode')
    assert.equal(nexus.resolveActiveNexusProfile(fixtureRoot, 'aih-deepseek').id, 'deepseek-codex')
    process.env.DSH_AIH_PROFILE = 'invalid-profile'
    assert.equal(nexus.resolveActiveNexusProfile(fixtureRoot, 'aih-engineering'), null)
  })

  check('unknown model/profile/role fails closed', () => {
    assert.equal(nexus.resolveNexusProfile(fixtureRoot, 'nonexistent'), null)
    assert.equal(nexus.resolveMuseProfileModel(fixtureRoot, 'nonexistent'), null)
    assert.equal(engineering.resolveTarget(fixtureRoot, 'deepseek-codex', 'nonexistent'), null)
  })

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
} finally {
  restoreEnv()
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
}
