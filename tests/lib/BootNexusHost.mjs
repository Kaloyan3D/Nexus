// BootNexusHost.mjs — boot one REAL pinned DSH `web` host (port 0) for
// multi-process ownership tests. Environment (DSH_HOME, AIH_INSTALL_ROOT,
// AIH_HOST_APP, proxy and placeholder key) is supplied by the parent.
// Prints one JSON line with the host's ownership/authority view, then waits:
// "exit\n" on stdin shuts down cleanly; SIGKILL simulates a crash.
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const appDir = process.env.AIH_HOST_APP
const appRequire = createRequire(path.join(appDir, 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)
const { runProfile } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
const booted = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'] })
const ctx = booted.ctx
const controllerModule = createRequire(import.meta.url)(path.join(process.env.AIH_INSTALL_ROOT, 'config', 'nexus', 'controller.cjs'))
const core = ctx.get('nexusController')
for (let i = 0; i < 400 && core && core.ownership.state === 'not-acquired'; i += 1) await new Promise((r) => setTimeout(r, 10))
const access = controllerModule.resolveControllerAccess(ctx).get()
let bindingWrite
try {
  const mountId = core.attachBridge({ plane: 'probe' }).mountId
  core.bindings.commit(mountId, { cache: {}, observed: new Map() })
  bindingWrite = 'written'
} catch (error) { bindingWrite = error.code || String(error) }
const readiness = core ? core.readiness() : null
process.stdout.write(JSON.stringify({
  pid: process.pid,
  port: ctx.get('webServer').port,
  ownership: core ? core.ownership.state : 'no-controller',
  enforced: core ? core.ownership.enforced : null,
  ready: readiness ? readiness.ready : false,
  problems: readiness ? readiness.problems : [],
  accessReason: access.reason,
  bindingWrite,
  transport: core ? core.transport.state : null,
}) + '\n')
process.stdin.on('data', async (chunk) => {
  if (String(chunk).includes('exit')) {
    try { await booted.shutdown.shutdown(0) } catch { /* bounded */ }
    process.exit(0)
  }
})
