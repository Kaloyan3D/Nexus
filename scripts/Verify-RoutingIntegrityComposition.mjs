/** Verify the installed Web composition can import Nexus's routing gate. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const installRoot = process.argv[2]
if (!installRoot) throw new Error('Usage: Verify-RoutingIntegrityComposition.mjs <install-root>')

const root = path.resolve(installRoot)
const home = path.join(root, 'data')
const profileDir = path.join(home, 'profiles', 'web')
const launcher = path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(launcher)) throw new Error(`DSH launcher is missing: ${launcher}`)

// DSH itself composes every bundle and the managed home patch. Reading only
// cordis.patch.yml would miss a path rewritten by another layer.
const composed = execFileSync(process.execPath, [launcher, '--profile', 'web', '--dump-config'], {
  cwd: root,
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
})
if (!fs.existsSync(profileDir)) throw new Error(`DSH Web profile is missing after composition: ${profileDir}`)
const rows = [...composed.matchAll(/^\s*- id: nexus-routing-integrity\s*\r?\n\s+name:\s*([^\r\n]+)\s*$/gm)]
if (rows.length !== 1) {
  throw new Error(`Expected exactly one nexus-routing-integrity row in the composed Web profile; found ${rows.length}`)
}
const name = rows[0][1].trim().replace(/^['"]|['"]$/g, '')
if (!name.startsWith('./') && !name.startsWith('../')) {
  throw new Error(`nexus-routing-integrity must use an installed relative module path; got ${name}`)
}
const entry = path.resolve(profileDir, name)
if (!fs.existsSync(entry)) {
  throw new Error(`Composed nexus-routing-integrity module is missing: ${entry} (entry ${name})`)
}
const imported = await import(pathToFileURL(entry).href)
const plugin = imported.default ?? imported
if (plugin.name !== 'nexus-routing-integrity' || typeof plugin.apply !== 'function') {
  throw new Error(`Composed nexus-routing-integrity entry did not load the expected plugin: ${entry}`)
}
console.log(`PASS: composed Web routing-integrity entry imports ${entry}`)
