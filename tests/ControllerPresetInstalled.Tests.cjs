'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { validate } = require('../scripts/MusePresetDependencyClosure.cjs')

const install = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const composition = path.join(install, 'scripts/Verify-NexusComposition.mjs')
for (const [name, profile] of [['aih-engineering', 'engineering'], ['aih-deepseek', 'deepseek']]) {
  const preset = path.join(install, 'data/.agent-presets', name)
  const rows = validate(install, preset, { profile })
  assert(rows.some(row => row.name === 'ContextCompilerShadowHostV2.cjs'))
  for (const row of rows) assert(fs.statSync(path.join(preset, row.name)).isFile())
  require(path.join(preset, 'AihController.cjs'))
}
// DSH 0.2.x: validate the REAL composed profile (all planes mount, stock presets absent)
// instead of the retired per-directory structural validators.
execFileSync(process.execPath, [composition, install], { stdio: 'pipe' })
console.log('SUITE RESULT: PASS 2 | FAIL 0 | total 2 installed controller planes + real composition')
