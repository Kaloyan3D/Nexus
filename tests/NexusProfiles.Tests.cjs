'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nexusProfiles = require('../config/Nexus-Profiles.cjs')

let passed = 0
function pass(name) {
  passed += 1
  console.log('PASS: ' + name)
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function setOrDelete(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makeFixture(repoRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profiles-'))
  for (const name of ['routing-policy.json', 'engineering-profiles.json', 'model-registry.json', 'nexus-profiles.json', 'muse-profiles.json']) {
    copyFile(path.join(repoRoot, 'config', name), path.join(root, 'config', name))
  }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'settings.yaml'), 'engineering-profile: glm-codex\n', 'utf8')
  return root
}

function main() {
  const repoRoot = path.resolve(__dirname, '..')
  const savedDsh = process.env.DSH_AIH_PROFILE
  const savedActive = process.env.AIH_ACTIVE_PROFILE

  try {
    const catalog = nexusProfiles.loadNexusProfileCatalog(repoRoot)
    assert.deepEqual(nexusProfiles.validateCatalogDocument(catalog), [])
    pass('top-level Nexus profile catalog validates')

    const listed = nexusProfiles.listNexusProfiles(repoRoot)
    const ids = listed.map((profile) => profile.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.includes('deepseek-codex'))
    assert.ok(ids.includes('glm-codex'))
    assert.ok(ids.includes('muse-spark-1.3'))
    pass('catalog ids are unique and expose both engine families')

    const deepSeek = nexusProfiles.resolveNexusProfile(repoRoot, 'deepseek-codex')
    assert.ok(deepSeek)
    assert.equal(deepSeek.engine, 'dual')
    assert.equal(deepSeek.runnable, true)
    assert.equal(deepSeek.config.id, 'deepseek-codex')
    assert.ok(deepSeek.config.roles.primaryEngineer)
    pass('DeepSeek + Codex resolves through the existing Dual profile registry')

    const glm = nexusProfiles.resolveNexusProfile(repoRoot, 'GLM-CODEX')
    assert.ok(glm)
    assert.equal(glm.engine, 'dual')
    assert.equal(glm.source.kind, 'engineering-profile')
    assert.ok(glm.config.roles.reviewer)
    pass('GLM + Codex resolves case-insensitively as a Dual profile')

    const muse = nexusProfiles.resolveNexusProfile(repoRoot, 'muse-spark-1.3')
    assert.ok(muse)
    assert.equal(muse.engine, 'muse')
    assert.equal(muse.source.kind, 'muse-profile')
    assert.equal(muse.selectable, false)
    assert.equal(muse.runnable, false)
    assert.equal(muse.availability, 'foundation')
    assert.equal(muse.config.reasoning.default, 'xhigh')
    assert.equal(muse.config.subagents.enabled, false)
    pass('Muse resolves to its own agent engine while remaining disabled in M1')

    assert.equal(nexusProfiles.resolveNexusProfile(repoRoot, 'does-not-exist'), null)
    pass('unknown profile fails closed with no fallback')

    const duplicateErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [
        { id: 'same', engine: 'dual', source: { kind: 'engineering-profile', profileId: 'a' } },
        { id: 'SAME', engine: 'muse', source: { kind: 'muse-profile', profileId: 'b' } },
      ],
    })
    assert.ok(duplicateErrors.some((error) => error.includes('duplicate-id:same')))
    pass('duplicate profile ids are rejected case-insensitively')

    const mismatchErrors = nexusProfiles.validateCatalogDocument({
      schemaVersion: 1,
      profiles: [
        { id: 'wrong', engine: 'muse', source: { kind: 'engineering-profile', profileId: 'wrong' } },
      ],
    })
    assert.ok(mismatchErrors.some((error) => error.includes('source-kind-mismatch')))
    pass('engine/source mismatches are rejected')

    const fixture = makeFixture(repoRoot)
    writeJson(path.join(fixture, 'data', 'custom-engineering-profile.json'), {
      schemaVersion: 1,
      profileId: 'custom',
      displayName: 'Custom',
      roles: {
        primaryEngineer: { model: 'glm-5.3-flash', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3-flash', reasoning: 'max' },
        reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
        solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
        fallback: { model: 'glm-5.3', reasoning: 'max' },
      },
    })
    const custom = nexusProfiles.resolveNexusProfile(fixture, 'custom')
    assert.ok(custom)
    assert.equal(custom.engine, 'dual')
    assert.equal(custom.selectable, true)
    assert.equal(custom.config.id, 'custom')
    pass('operator Custom profile is dynamically classified as Dual')

    setOrDelete('DSH_AIH_PROFILE', undefined)
    setOrDelete('AIH_ACTIVE_PROFILE', undefined)
    let active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active.id, 'glm-codex')
    pass('settings engineering-profile participates in active Nexus profile resolution')

    process.env.AIH_ACTIVE_PROFILE = 'deepseek-codex'
    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active.id, 'deepseek-codex')
    pass('AIH_ACTIVE_PROFILE overrides settings using the existing precedence')

    process.env.DSH_AIH_PROFILE = 'muse-spark-1.3'
    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active.id, 'muse-spark-1.3')
    assert.equal(active.engine, 'muse')
    assert.equal(active.runnable, false)
    pass('DSH_AIH_PROFILE can resolve Muse metadata without silently falling back to Dual')

    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-deepseek')
    assert.equal(active.id, 'deepseek-codex')
    assert.equal(active.engine, 'dual')
    pass('profileOverrideAllowed=false keeps the DeepSeek-only preset locked')

    process.env.DSH_AIH_PROFILE = 'unknown-profile'
    active = nexusProfiles.resolveActiveNexusProfile(fixture, 'aih-engineering')
    assert.equal(active, null)
    pass('invalid preferred profile fails closed instead of selecting a different engine')

    console.log('Nexus profile foundation tests passed: ' + passed)
  } finally {
    setOrDelete('DSH_AIH_PROFILE', savedDsh)
    setOrDelete('AIH_ACTIVE_PROFILE', savedActive)
  }
}

main()
