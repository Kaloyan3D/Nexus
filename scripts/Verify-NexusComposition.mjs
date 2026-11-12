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
// P1: also resolves the live host `nexusController` service through the composed context and requires its
// readiness (contract major 1, mandatory strategies nexus.muse + nexus.legacy-dual ready) and one attached
// aih-controller bridge per Nexus plane. A parsed patch row or an installed file is not accepted as proof.
//
// Exit codes: 0 = every Nexus plane mounted, every stock preset is absent, the registry default is the
// default declared in nexus-settings.yaml, and the host Nexus Controller is ready with every plane attached;
// 1 = composition failure; 2 = usage error. The process always exits itself.

import { createRequire } from 'node:module'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!root) { console.error('usage: NexusRuntimeBootProbe.mjs <InstallRoot> [evidence.json]'); process.exit(2) }
// P2-B1: the host Controller enforces single-host ownership of its data root.
// Verification must never compete for a live production host's lock (that
// would make an install verify fail, or worse, delay a starting host), so the
// REAL composition is booted over a private thin root: every installed
// directory is linked in place (app, config, closures referenced by the
// generated patch are the real ones), and only data/ is private, holding a
// copy of the generated patch, settings and the host-row assets.
const verifyRoot = mkdtempSync(join(tmpdir(), 'nexus-verify-'))
for (const entry of readdirSync(root)) if (entry !== 'data') symlinkSync(join(root, entry), join(verifyRoot, entry))
mkdirSync(join(verifyRoot, 'data'))
for (const name of ['cordis.patch.yml', 'nexus-settings.yaml', 'Routing-Integrity.cjs', 'OpenCode-SessionHeader.cjs']) {
  if (existsSync(join(root, 'data', name))) copyFileSync(join(root, 'data', name), join(verifyRoot, 'data', name))
}
if (existsSync(join(root, 'data', 'profiles'))) cpSync(join(root, 'data', 'profiles'), join(verifyRoot, 'data', 'profiles'), { recursive: true })
process.env.DSH_HOME = join(verifyRoot, 'data')
process.env.AIH_INSTALL_ROOT = verifyRoot
process.env.AIH_HOST_APP = join(root, 'app')
process.env.NEXUS_IPC = '0'
process.env.DEEPSEEK_API_KEY ??= 'probe-not-a-credential'
const appRequire = createRequire(join(root, 'app', 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)

const NEXUS_PLANES = ['aih-engineering', 'aih-deepseek', 'aih-muse']
const STOCK = ['standard', 'ptc', 'minimal', 'cordis']
const evidence = { dshVersion: appRequire('@deepseek-ai/dsh/package.json').version, node: process.version, platform: process.platform, bootRoot: 'private-thin-root' }
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
  // P1 host Controller readiness (actual service lookup, not package presence).
  const controller = typeof booted.ctx.get === 'function' ? booted.ctx.get('nexusController') : undefined
  if (controller && typeof controller.readiness === 'function') {
    for (let i = 0; i < 300 && controller.ownership.state === 'not-acquired'; i += 1) await new Promise((r) => setTimeout(r, 10))
    const readiness = controller.readiness({ requirePlanes: true })
    const attached = new Set(readiness.attachedPlanes)
    evidence.controller = {
      build: controller.build,
      contractMajor: controller.contractMajor,
      ready: readiness.ready,
      problems: readiness.problems,
      strategies: readiness.strategies.map((row) => ({ id: row.id, contractMajor: row.contractMajor, ready: row.ready, reason: row.reason })),
      bridges: readiness.bridges,
      planesAttached: Object.fromEntries(NEXUS_PLANES.map((id) => [id, attached.has(id)])),
      ownership: { state: readiness.ownership.state, enforced: readiness.ownership.enforced },
    }
  } else {
    evidence.controller = { ready: false, problems: ['nexus-controller-service-absent'] }
  }
  const controllerOk = evidence.controller.ready === true && evidence.controller.contractMajor === 1 &&
    evidence.controller.ownership && evidence.controller.ownership.state === 'held' && evidence.controller.ownership.enforced === true &&
    NEXUS_PLANES.every((id) => evidence.controller.planesAttached && evidence.controller.planesAttached[id] === true)
  evidence.ok = NEXUS_PLANES.every((id) => evidence.planes[id] === 'mounted') && evidence.stockPresetsPresent.length === 0 && NEXUS_PLANES.includes(declared) && evidence.defaultPreset === declared && controllerOk
} catch (error) {
  evidence.ok = false
  evidence.error = String(error && error.stack ? error.stack : error).slice(0, 2000)
}
const text = JSON.stringify(evidence, null, 2)
if (process.argv[3]) writeFileSync(process.argv[3], text + '\n')
console.log(text)
try { await shutdown?.shutdown(0) } catch { /* bounded by DSH */ }
try { rmSync(verifyRoot, { recursive: true, force: true }) } catch { /* best effort */ }
process.exit(evidence.ok ? 0 : 1)
