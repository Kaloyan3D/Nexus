'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fail(message) {
  throw new Error('Muse preset validation failed: ' + message)
}

function flatten(rows, output = []) {
  for (const row of rows) {
    output.push(row)
    if (row && row.group === true && Array.isArray(row.config)) flatten(row.config, output)
  }
  return output
}

async function main() {
  const installRoot = path.resolve(process.argv[2] || '')
  const presetRoot = path.resolve(process.argv[3] || '')
  if (!process.argv[2] || !process.argv[3]) fail('InstallRoot and preset path are required')

  const requireFromApp = createRequire(path.join(installRoot, 'app', 'package.json'))
  const yaml = requireFromApp('js-yaml')
  const { entryListSchema } = requireFromApp('@deepseek-ai/cordis-plugin-include')
  const compositionPath = path.join(presetRoot, 'agent.cordis.yml')
  let rows
  try {
    rows = yaml.load(fs.readFileSync(compositionPath, 'utf8'), { schema: entryListSchema })
  } catch (error) {
    fail('the composition is not valid in the installed DSH YAML dialect: ' + error.message)
  }
  if (!Array.isArray(rows)) fail('composition must be a top-level row list')

  const allRows = flatten(rows)
  for (const row of allRows) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string' || row.name === '') {
      fail('every composition entry must be a plugin row with a name')
    }
  }

  const requiredIds = ['aih-muse-isolation', 'aih-controller']
  for (const id of requiredIds) {
    const count = allRows.filter((row) => row.id === id).length
    if (count !== 1) fail(`required row ${id} must exist exactly once (found ${count})`)
  }

  const forbidden = [
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-subagent-fork',
    'tool-subagent-codex',
    'workflow-worker-thread',
    'tool-workflow',
    'tool-ralph',
    'deepseek_normal',
    'deepseek_deep',
    'explorer',
    'critic',
  ]
  const serializedRows = JSON.stringify(allRows)
  for (const name of forbidden) {
    if (serializedRows.includes(name)) fail(`forbidden delegation/workflow surface remains: ${name}`)
  }

  const managed = [
    ['preset.yml', 'preset-muse.yml'],
    ['Muse-Isolation.cjs', 'Muse-Isolation.cjs'],
    ['Muse-ContributorProtection.cjs', 'Muse-ContributorProtection.cjs'],
    ['AihController.cjs', 'AihController.cjs'],
    ['Engineering-Profiles.cjs', 'Engineering-Profiles.cjs'],
  ]
  for (const [runtimeName, sourceName] of managed) {
    const runtime = path.join(presetRoot, runtimeName)
    const source = path.join(installRoot, 'config', sourceName)
    if (!fs.existsSync(runtime)) fail(`managed runtime file is missing: ${runtimeName}`)
    if (digest(runtime) !== digest(source)) fail(`managed runtime file differs from source: ${runtimeName}`)
  }

  const persona = allRows.find((row) => row.id === 'persona')
  assert.ok(persona && persona.config && persona.config.text && typeof persona.config.text === 'object')
  const expression = persona.config.text.__jsExpr
  if (typeof expression !== 'string' || !expression.includes('single engineering agent')) {
    fail('Muse persona did not parse as the expected !!js expression')
  }
  process.stdout.write(JSON.stringify({ ok: true, rows: allRows.length, managedFiles: managed.length }))
}

main().catch((error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n')
  process.exit(1)
})
