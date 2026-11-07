// Verify-NexusComposition.mjs: real DSH 0.2.x boot verification of the Nexus composition
//
//   node scripts/Verify-NexusComposition.mjs <InstallRoot> [evidence.json]
//
// Boots the REAL `web` profile in-process through DSH's own `runProfile` (the
// same entry `dsh web` uses) with DSH_HOME = <InstallRoot>/data, so the Nexus
// home patch (data/cordis.patch.yml) is composed exactly as in production.
// Then reads the live preset registry and reports, per plane, whether the
// preset mounted (a failed activation stays visible as `broken`).
// No provider request is made: this proves composition and activation only.
//
// Exit codes: 0 = every Nexus plane mounted, every stock preset is absent and the registry default is the
// default declared in nexus-settings.yaml;
// 1 = composition failure; 2 = usage error. The process always exits itself.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!root) { console.error('usage: NexusRuntimeBootProbe.mjs <InstallRoot> [evidence.json]'); process.exit(2) }
process.env.DSH_HOME = join(root, 'data')
process.env.AIH_INSTALL_ROOT = root
process.env.DEEPSEEK_API_KEY ??= 'probe-not-a-credential'
const appRequire = createRequire(join(root, 'app', 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)

const NEXUS_PLANES = ['aih-engineering', 'aih-deepseek', 'aih-muse']
const STOCK = ['standard', 'ptc', 'minimal', 'cordis']
const evidence = { dshVersion: appRequire('@deepseek-ai/dsh/package.json').version, node: process.version, platform: process.platform }
let shutdown
try {
  const { runProfile } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh/profile-boot')).href)
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const booted = await runProfile({
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'],
  })
  shutdown = booted.shutdown
  const registry = booted.ctx.agentPresets
  const roster = await registry.list()
  evidence.defaultPreset = registry.defaultId
  evidence.roster = roster.map((row) => ({ id: row.id, broken: row.broken ?? null, name: row.name ?? null }))
  const byId = new Map(roster.map((row) => [row.id, row]))
  evidence.planes = Object.fromEntries(NEXUS_PLANES.map((id) => [id, byId.has(id) ? (byId.get(id).broken ? 'BROKEN: ' + byId.get(id).broken : 'mounted') : 'ABSENT']))
  evidence.stockPresetsPresent = STOCK.filter((id) => byId.has(id))
  const inspections = registry.inspectCompositions()
  evidence.compositions = inspections.map((c) => ({ preset: c.presetId ?? c.agentPreset ?? c.id ?? null, keys: Object.keys(c), modules: (c.modules ?? c.activeModules ?? []).length, leakedServices: c.leakedServices ?? [] }))
  // The composition's default must be exactly the default the Nexus settings declare (the operator's
  // saved choice, one of the Nexus planes), not a hard-coded plane.
  const settingsFile = [join(root, 'data', 'nexus-settings.yaml'), join(root, 'config', 'settings.yaml')].find((file) => existsSync(file))
  const declared = settingsFile ? (appRequire('js-yaml').load(readFileSync(settingsFile, 'utf8')) || {})['agent-presets']?.default : undefined
  evidence.expectedDefaultPreset = declared ?? null
  evidence.ok = NEXUS_PLANES.every((id) => evidence.planes[id] === 'mounted') && evidence.stockPresetsPresent.length === 0 && NEXUS_PLANES.includes(declared) && evidence.defaultPreset === declared
} catch (error) {
  evidence.ok = false
  evidence.error = String(error && error.stack ? error.stack : error).slice(0, 2000)
}
const text = JSON.stringify(evidence, null, 2)
if (process.argv[3]) writeFileSync(process.argv[3], text + '\n')
console.log(text)
try { await shutdown?.shutdown(0) } catch { /* bounded by DSH */ }
process.exit(evidence.ok ? 0 : 1)
