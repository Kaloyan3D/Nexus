'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { prepare, copy, validate, closure } = require('../scripts/MusePresetDependencyClosure.cjs')

const source = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-preset-install-'))
try {
  const install = path.join(root, 'install')
  const trackedSource = fs.existsSync(path.join(source, '.git'))
  if (!trackedSource) fs.cpSync(path.join(source, 'config'), path.join(install, 'config'), { recursive: true })
  for (const [name, profile, isolation] of [
    ['aih-engineering', 'engineering', 'Engineering-Isolation.cjs'],
    ['aih-deepseek', 'deepseek', 'DeepSeek-Isolation.cjs'],
  ]) {
    const expected = trackedSource
      ? prepare(source, install, { profile }).map(row => row.name)
      : JSON.parse(fs.readFileSync(path.join(install, 'config', `.${profile}-preset-closure.json`), 'utf8')).files.map(row => row.name)
    assert(expected.includes('ContextCompilerShadowHostV2.cjs'))
    assert(expected.includes(isolation))
    assert(!expected.includes('Muse-Isolation.cjs'))
    const preset = path.join(root, name)
    assert.deepEqual(copy(install, preset, { profile }).map(row => row.name), expected)
    assert.deepEqual(closure(preset, { rootIsConfig: true, requireTracked: false, profile }), expected)
    assert.deepEqual(validate(install, preset, { profile }).map(row => row.name), expected)
    require(path.join(preset, 'AihController.cjs'))
    fs.rmSync(path.join(preset, 'ContextCompilerShadowHostV2.cjs'))
    assert.throws(() => validate(install, preset, { profile }), /closure-(missing|installed)/)
  }
  const fixture = path.join(root, 'fixture')
  const fixtureConfig = path.join(fixture, 'config')
  fs.mkdirSync(fixtureConfig, { recursive: true })
  execFileSync('git', ['-C', fixture, 'init', '-q'])
  for (const [name, contents] of Object.entries({
    'AihController.cjs': "require('./A.cjs')\n",
    'A.cjs': "require('./B.cjs')\n",
    'B.cjs': "require('./C.cjs')\n",
    'C.cjs': 'module.exports = true\n',
  })) {
    fs.writeFileSync(path.join(fixtureConfig, name), contents)
    execFileSync('git', ['-C', fixture, 'add', '--', 'config/' + name])
  }
  const fixtureInstall = path.join(root, 'fixture-install')
  const fixturePreset = path.join(root, 'fixture-preset')
  assert.deepEqual(prepare(fixture, fixtureInstall, { profile: 'controller' }).map(row => row.name), ['A.cjs', 'AihController.cjs', 'B.cjs', 'C.cjs'])
  const requiredSource = path.join(fixtureInstall, 'config/C.cjs')
  fs.rmSync(requiredSource)
  assert.throws(() => copy(fixtureInstall, fixturePreset, { profile: 'controller' }), /closure-missing/)
  assert(!fs.existsSync(fixturePreset))
  fs.copyFileSync(path.join(fixtureConfig, 'C.cjs'), requiredSource)
  copy(fixtureInstall, fixturePreset, { profile: 'controller' })
  assert(fs.existsSync(path.join(fixturePreset, 'C.cjs')))
  fs.rmSync(path.join(fixturePreset, 'C.cjs'))
  assert.throws(() => validate(fixtureInstall, fixturePreset, { profile: 'controller' }), /closure-missing/)
  console.log('SUITE RESULT: PASS 3 | FAIL 0 | total 3')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
