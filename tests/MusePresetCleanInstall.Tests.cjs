'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepare, copy, validate } = require('../scripts/MusePresetDependencyClosure.cjs')
const source = path.resolve(__dirname, '..')
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-clean-install-'))
try {
  const install = path.join(isolated, 'installed')
  const preset = path.join(isolated, 'preset')
  let expected
  if (fs.existsSync(path.join(source, '.git'))) expected = prepare(source, install).map(row => row.name)
  else {
    fs.cpSync(path.join(source, 'config'), path.join(install, 'config'), { recursive: true })
    expected = JSON.parse(fs.readFileSync(path.join(install, 'config', '.muse-preset-closure.json'), 'utf8')).files.map(row => row.name)
  }
  assert.deepEqual(copy(install, preset).map(row => row.name), expected)
  assert.deepEqual(validate(install, preset).map(row => row.name), expected)
  fs.rmSync(path.join(install, 'config'), { recursive: true, force: true })
  for (const entry of ['AihController.cjs', 'Muse-Isolation.cjs', 'Muse-ReasoningSignals.cjs', 'ContextCompilerActiveMuseV2.cjs']) {
    require(path.join(preset, entry))
  }
  console.log(`SUITE RESULT: PASS 1 | FAIL 0 | total 1 (${expected.length} isolated files)`)
} finally { fs.rmSync(isolated, { recursive: true, force: true }) }
