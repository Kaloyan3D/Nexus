// NexusGatewaySurface.mjs — P2-B2A diagnostic: enumerate the real remote
// mutation surface of an installed Nexus composition (pinned DSH Web).
//
//   node tests/diagnostics/NexusGatewaySurface.mjs <InstallRoot> [evidence.json]
//
// Boots the composition over a private thin root (installed directories
// linked in place, private data/), then lists:
//   - every Typert remote endpoint the gateway claims, with mode (unary or
//     stream), parameters and declared resource readers;
//   - raw web routes (exact/prefix), WebSocket upgrade routes and Connection
//     exact Fetch routes, i.e. paths that never reach the gateway.
// No request is sent; read-only.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] || '.')
const appDir = path.join(root, 'app')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-surface-'))
const installRoot = path.join(scratch, 'install')
fs.mkdirSync(installRoot)
for (const entry of fs.readdirSync(root)) if (entry !== 'data') fs.symlinkSync(path.join(root, entry), path.join(installRoot, entry))
fs.mkdirSync(path.join(installRoot, 'data'))
for (const name of ['cordis.patch.yml', 'nexus-settings.yaml', 'Routing-Integrity.cjs', 'OpenCode-SessionHeader.cjs']) if (fs.existsSync(path.join(root, 'data', name))) fs.copyFileSync(path.join(root, 'data', name), path.join(installRoot, 'data', name))
if (fs.existsSync(path.join(root, 'data', 'profiles'))) fs.cpSync(path.join(root, 'data', 'profiles'), path.join(installRoot, 'data', 'profiles'), { recursive: true })
Object.assign(process.env, { DSH_HOME: path.join(installRoot, 'data'), AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: appDir, NEXUS_IPC: '0', DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' })
const appRequire = createRequire(path.join(appDir, 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)
const { runProfile } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
const booted = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'] })
const ctx = booted.ctx
const gateway = ctx.get('typertGateway')
const endpoints = []
for (const endpoint of [...gateway.collectSrcClaims()].sort()) {
  const [namespace, method] = endpoint.split('/')
  let descriptor
  try { descriptor = gateway.resolveDescriptor(namespace, method, endpoint) } catch (error) { endpoints.push({ endpoint, error: String(error.message).slice(0, 120) }); continue }
  const readers = gateway.resourceReaders(descriptor)
  endpoints.push({
    endpoint,
    mode: descriptor.mode === undefined ? 'unary' : descriptor.mode,
    uplink: Boolean(descriptor.uplink),
    parameters: descriptor.parameters.map((p) => p.wire),
    readers: readers ? Object.keys(readers) : [],
  })
}
const web = ctx.get('webServer')
const connection = ctx.get('connection')
const evidence = {
  dsh: appRequire('@deepseek-ai/dsh/package.json').version,
  gatewayHookPresent: typeof gateway.authorizeOperation === 'function',
  resourceKinds: [...ctx.typert.resources.entries()].map((d) => d.kind),
  endpoints,
  webRoutes: { exact: [...web.exact.keys()].sort(), prefixes: [...web.prefixes.keys()].sort(), upgrades: [...web.upgrades.keys()].sort() },
  connection: { fetchRoutes: [...connection.fetchRoutes.keys()].sort(), interceptors: [...connection.interceptors.keys()].sort() },
}
const text = JSON.stringify(evidence, null, 2)
if (process.argv[3]) fs.writeFileSync(process.argv[3], text + '\n')
console.log(text)
try { await booted.shutdown.shutdown(0) } catch { /* bounded */ }
fs.rmSync(scratch, { recursive: true, force: true })
process.exit(0)
