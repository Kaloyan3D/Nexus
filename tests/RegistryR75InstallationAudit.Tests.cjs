'use strict'
// Requires an already provisioned, disposable install under repo/tmp. Never
// provisions runtimes, changes HOME, contacts providers, or uses a live host.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const closure = require('../scripts/MusePresetDependencyClosure.cjs')
const registry = require('../config/registry/index.cjs')
const source = path.resolve(__dirname, '..')
const install = fs.realpathSync(process.argv[2] || '')
assert(install.startsWith(fs.realpathSync(path.join(source, 'tmp')) + path.sep), 'disposable repo/tmp install required')
assert.notEqual(install, source)
const data = path.join(install, 'data')
const env = { ...process.env, AIH_INSTALL_ROOT: install, DSH_HOME: data, AIH_TOOLCHAIN_ROOT: install, DOTNET_PROCESSOR_COUNT: '2' }
delete env.NEXUS_REGISTRY_BINDING
for (const key of Object.keys(env)) if (/^(DSH_AIH_|AIH_ACTIVE_)/.test(key) || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)) delete env[key]
const host = process.platform === 'win32' ? 'powershell.exe' : path.join(install, 'runtime/pwsh/pwsh')
function compose() {
  execFileSync(host, ['-NoLogo', '-NoProfile', '-File', path.join(install, 'scripts/Complete-Install.ps1'), '-InstallRoot', install], { env, timeout: 180000, stdio: 'pipe' })
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
let passed = 0
function pass(label) { passed++; console.log('PASS: ' + label) }
for (const profile of ['muse', 'engineering', 'deepseek', 'controller']) {
  closure.prepare(source, install, { profile })
  const preset = path.join(install, 'audit-presets', profile)
  closure.copy(install, preset, { profile })
  const rows = closure.validate(install, preset, { profile })
  for (const mode of ['engineering-v1', 'engineering-v2', 'engineering-v2-adaptive', 'engineering-v3']) {
    const name = 'registry/modes/' + mode + '.json'
    const file = path.join(preset, name)
    const bytes = fs.readFileSync(file)
    assert.equal(sha(file), rows.find(row => row.name === name).sha256)
    assert.equal(JSON.parse(bytes).id, mode)
    try {
      fs.unlinkSync(file)
      assert.throws(() => closure.validate(install, preset, { profile }), /closure-missing/)
      fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(' ')]))
      assert.throws(() => closure.validate(install, preset, { profile }), /closure-(hash|installed)/)
    } finally { fs.writeFileSync(file, bytes) }
  }
  const local = require(path.join(preset, 'registry/service.cjs')).createService({ installRoot: install, dataRoot: data })
  assert.deepEqual(local.listModes().errors, [])
  assert.equal(local.listModes().modes.length, 4)
  closure.validate(install, preset, { profile })
  pass(profile + ': all four mode assets hash-verified; missing and corrupt assets rejected')
}
compose()
pass('shared clean-install composition with actual pinned npm dependencies')
const svc = registry.service.createService({ installRoot: install, dataRoot: data })
const initial = svc.getModeConfiguration('engineering-v2', {}).result
let config = initial.config
// A repeat audit preserves the previous isolated revision-2 fixture too.
if (!initial.persisted) {
  for (const expected of [null, 0, 1]) {
    const saved = svc.save('engineering-v2', config, expected, {})
    assert.equal(saved.ok, true, JSON.stringify(saved))
    config = svc.getModeConfiguration('engineering-v2', {}).result.config
  }
}
assert.equal(config.revision, 2)
const settings = path.join(data, 'settings.yaml')
fs.appendFileSync(settings, '\n# R75A operator-owned preservation sentinel\n')
const credentials = path.join(data, '.credentials.yaml')
fs.writeFileSync(credentials, 'R75A_FAKE_ONLY: isolated-preservation-sentinel\n')
const bindings = path.join(data, 'routing/session-bindings.json')
// Opaque persistence sentinel, never passed to execution. Canonical executable
// pins and TaskController generations are exercised by the R74 suite.
fs.writeFileSync(bindings, JSON.stringify({ schemaVersion: 1, bindings: { audit: { taskId: 'audit-only', taskInstanceId: 'audit-generation', registryPin: { taskInstanceId: 'audit-generation', resolutionId: 'immutable-install-sentinel' } } } }))
const store = registry.configStore.storeFilePath(data)
const files = [settings, credentials, bindings, store]
const before = files.map(sha)
compose()
assert.deepEqual(files.map(sha), before)
assert.equal(svc.getModeConfiguration('engineering-v2', {}).result.config.revision, 2)
pass('actual shared upgrade preserves settings, credentials, opaque pin identity and saved EMv2 revision 2 byte-for-byte')
const managed = path.join(data, '.agent-presets/aih-muse')
const published = closure.validate(install, managed).map(row => [row.name, sha(path.join(managed, row.name))])
const asset = path.join(install, 'config/registry/modes/engineering-v2.json')
const original = fs.readFileSync(asset)
try {
  fs.appendFileSync(asset, ' ')
  assert.throws(() => execFileSync(host, ['-NoLogo', '-NoProfile', '-File', path.join(install, 'scripts/Install-MusePreset.ps1'), '-InstallRoot', install], { env, timeout: 60000, stdio: 'pipe' }))
  assert.deepEqual(published.map(([name]) => [name, sha(path.join(managed, name))]), published)
  assert.deepEqual(files.map(sha), before)
} finally { fs.writeFileSync(asset, original) }
closure.validate(install, managed)
pass('failed corrupt-asset upgrade preserves published preset and operator data')
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
