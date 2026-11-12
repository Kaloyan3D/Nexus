// P2-B1 Priority B: enforced single-host ownership with REAL pinned DSH hosts.
//
// Two real `web` host processes (different ports, port 0) over ONE private
// data root, plus crash recovery. Uses a thin private install root linked to
// the installation under test (only data/ is private); never touches the
// installation's own data, any running Nexus instance, or ports 3080/3081.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = process.env.AIH_HOST_APP || path.join(root, 'app')
if (!fs.existsSync(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')) || !fs.existsSync(path.join(root, 'data', 'cordis.patch.yml'))) {
  console.error('FAIL: this real-host suite needs an installed Nexus root (app/ and data/cordis.patch.yml); it never skips')
  process.exit(1)
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-host-enforce-'))
const installRoot = path.join(scratch, 'install')
fs.mkdirSync(installRoot)
for (const entry of fs.readdirSync(root)) if (entry !== 'data') fs.symlinkSync(path.join(root, entry), path.join(installRoot, entry))
const dataRoot = path.join(installRoot, 'data')
fs.mkdirSync(dataRoot)
for (const name of ['cordis.patch.yml', 'nexus-settings.yaml', 'Routing-Integrity.cjs', 'OpenCode-SessionHeader.cjs']) if (fs.existsSync(path.join(root, 'data', name))) fs.copyFileSync(path.join(root, 'data', name), path.join(dataRoot, name))
if (fs.existsSync(path.join(root, 'data', 'profiles'))) fs.cpSync(path.join(root, 'data', 'profiles'), path.join(dataRoot, 'profiles'), { recursive: true })
const env = { ...process.env, DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: appDir, DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
const bootScript = path.join(root, 'tests', 'lib', 'BootNexusHost.mjs')
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = {}
const children = new Set()

function startHost(label) {
  const child = spawn(process.execPath, [bootScript], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(label + ' did not report within 90 s')), 90000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      const line = out.split('\n').find((l) => l.startsWith('{"pid"'))
      if (line) { clearTimeout(timer); resolve({ child, report: JSON.parse(line) }) }
    })
    child.stderr.on('data', () => {})
    child.on('exit', (code) => { clearTimeout(timer); if (!out.includes('{"pid"')) reject(new Error(label + ' exited ' + code)) })
  })
}
const probe = () => JSON.parse(spawnSync(process.execPath, [path.join(root, 'scripts', 'NexusHostProbe.cjs'), dataRoot, appDir], { encoding: 'utf8' }).stdout.trim())

let exitCode = 0
try {
  assert.equal(probe().state, 'free', 'no host owns the fresh private installation')
  const a = await startHost('host A')
  evidence.hostA = a.report
  assert.equal(a.report.ownership, 'held'); assert.equal(a.report.enforced, true)
  assert.equal(a.report.ready, true, JSON.stringify(a.report.problems))
  assert.equal(a.report.accessReason, null); assert.equal(a.report.bindingWrite, 'written')
  pass('host A owns the installation: ready, authoritative, single binding writer')

  const b = await startHost('host B')
  evidence.hostB = b.report
  assert.notEqual(b.report.port, a.report.port, 'the competing host listens on a different port')
  assert.equal(b.report.ownership, 'contended')
  assert.equal(b.report.ready, false)
  assert.equal(b.report.accessReason, 'nexus-host-ownership-contended', 'plane bridges on host B resolve no authority (every turn refused)')
  assert.equal(b.report.bindingWrite, 'binding-writer-detached', 'host B cannot write bindings')
  assert.notEqual(b.report.transport, 'listening', 'host B does not serve the task IPC')
  const owned = probe()
  assert.equal(owned.state, 'owned'); assert.equal(owned.holder.pid, a.report.pid)
  pass('a second host on a different port over the same data root is refused: no turns, no binding writes, no IPC')

  // Launcher primitive (PowerShell) sees the same owner.
  const pwsh = path.join(root, 'runtime', 'pwsh', process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')
  if (fs.existsSync(pwsh)) {
    const layout = `@{ Scripts = '${path.join(root, 'scripts')}'; Node = '${process.execPath}'; Data = '${dataRoot}'; App = '${appDir}' }`
    const ps = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-Command', `. '${path.join(root, 'scripts', 'Startup.ps1')}'; (Get-AihHostOwnership -Layout ${layout}) | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 60000 })
    const view = JSON.parse(ps.stdout.trim().split('\n').pop())
    assert.equal(view.State, 'owned', JSON.stringify(view) + ' stderr=' + ps.stderr.slice(0, 400)); assert.equal(view.Holder.pid, a.report.pid)
    pass('the launcher primitive Get-AihHostOwnership reports the live owner (used by aih.ps1 to refuse a second start)')
  } else {
    console.log('INFO: pinned PowerShell not present; launcher primitive not exercised')
  }

  // Crash of the owner: the kernel releases ownership; B does NOT take over (explicit restart only).
  a.child.kill('SIGKILL')
  await new Promise((r) => a.child.once('exit', r))
  assert.equal(probe().state, 'free', 'a crashed owner leaves no lock behind (no TTL, no PID guess)')
  const c = await startHost('host C')
  evidence.hostC = c.report
  assert.equal(c.report.ownership, 'held'); assert.equal(c.report.ready, true)
  pass('after the owner crashes, a newly started host acquires ownership; the refused host never self-promotes')

  // Clean shutdown releases ownership.
  b.child.stdin.write('exit\n'); c.child.stdin.write('exit\n')
  await Promise.all([new Promise((r) => b.child.once('exit', r)), new Promise((r) => c.child.once('exit', r))])
  assert.equal(probe().state, 'free')
  assert.equal(fs.existsSync(path.join(dataRoot, 'routing', 'nexus-host.json')), false, 'the owner removed its discovery descriptor on clean shutdown')
  pass('clean shutdown releases ownership and removes the owner descriptor')
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
} finally {
  for (const child of children) { try { child.kill('SIGKILL') } catch { /* gone */ } }
  if (process.env.NEXUS_HOST_ENFORCEMENT_EVIDENCE) fs.writeFileSync(process.env.NEXUS_HOST_ENFORCEMENT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
  if (!exitCode) console.log(`NexusHostEnforcement: ${passed} assertion groups passed.`)
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(exitCode)
}
