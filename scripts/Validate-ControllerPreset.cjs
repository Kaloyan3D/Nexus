'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { validate } = require('./MusePresetDependencyClosure.cjs')

const [install, preset, kind] = process.argv.slice(2)
if (!install || !preset || !['aih-engineering', 'aih-deepseek'].includes(kind)) throw new Error('Expected install, preset, and managed controller preset name')
const appRequire = createRequire(path.join(path.resolve(install), 'app/package.json'))
const yaml = appRequire('js-yaml')
const { entryListSchema } = appRequire('@deepseek-ai/cordis-plugin-include')
const composition = path.join(path.resolve(preset), 'agent.cordis.yml')
const rows = yaml.load(fs.readFileSync(composition, 'utf8'), { schema: entryListSchema })
if (!Array.isArray(rows)) throw new Error('Controller preset composition is not a row list')
function flatten(items) { return items.flatMap(row => row && row.group === true && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row]) }
const all = flatten(rows)
for (const id of ['aih-controller', kind === 'aih-engineering' ? 'aih-engineering-isolation' : 'aih-deepseek-isolation']) {
  if (all.filter(row => row && row.id === id).length !== 1) throw new Error(`Controller preset requires exactly one ${id} row`)
}
const presetRequire = createRequire(composition)
for (const row of all) {
  if (!row || typeof row.name !== 'string') throw new Error('Invalid controller preset row')
  if (row.name.startsWith('./') || row.name.startsWith('../')) presetRequire(row.name)
}
validate(path.resolve(install), path.resolve(preset), { profile: kind === 'aih-engineering' ? 'engineering' : 'deepseek' })
process.stdout.write(JSON.stringify({ ok: true, kind, localPluginsLoaded: all.filter(row => row.name.startsWith('.')).length }) + '\n')
