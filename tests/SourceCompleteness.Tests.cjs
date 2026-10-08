'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { closure, validate } = require('../scripts/MusePresetDependencyClosure.cjs')
const root = path.resolve(__dirname, '..')
const files = fs.existsSync(path.join(root, '.git')) ? closure(root) : validate(root, path.join(root, 'data', '.agent-presets', 'aih-muse')).map(row => row.name)
if (!files.includes('ContextCompilerActiveHostV2.cjs') || !files.includes('ContextCompilerShadowAdapterV2.cjs') || !files.includes('tokenizers/deepseek-v4-tokenizer.json')) {
  throw new Error('required CCv2 production dependency is absent from closure')
}
console.log(`SUITE RESULT: PASS 1 | FAIL 0 | total 1 (${files.length} tracked files)`)
