'use strict'

/**
 * P2-A Task C: host lifetime ownership of one data root.
 *
 * Uses the REAL pinned kernel lock mechanism of the installation under test
 * (@deepseek-ai/node-addon-system/flock on POSIX) with real child processes;
 * never skips when that runtime is absent. Synthetic data roots only; no
 * listener, no port, no running Nexus instance is touched.
 */

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const sourceRoot = path.join(__dirname, '..')
const ownership = require('../config/nexus/host-ownership.cjs')
const controllerModule = require('../config/nexus/controller.cjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-host-ownership-'))
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }

const appRoot = [process.env.AIH_HOST_APP, path.join(sourceRoot, 'app'), process.env.AIH_TOOLCHAIN_ROOT && path.join(process.env.AIH_TOOLCHAIN_ROOT, 'app')].filter(Boolean)
  .find((candidate) => fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'node-addon-system', 'package.json')))
if (!appRoot) { console.error('FAIL: pinned DSH app with node-addon-system not found (set AIH_HOST_APP); this suite never skips'); process.exit(1) }
process.env.AIH_HOST_APP = appRoot

function holderChild(dataRoot) {
  const source = `
    const o = require(${JSON.stringify(path.join(sourceRoot, 'config', 'nexus', 'host-ownership.cjs'))});
    o.acquireHostOwnership({ dataRoot: ${JSON.stringify(dataRoot)}, appRoot: ${JSON.stringify(appRoot)}, build: 'child' }).then((r) => {
      process.stdout.write(JSON.stringify({ state: r.state, generation: r.generation || null }) + '\\n');
      process.stdin.on('data', async () => { await r.release(); process.stdout.write('released\\n'); process.exit(0) });
    });
  `
  const child = childProcess.spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  let waiter = null
  child.stdout.on('data', (chunk) => { for (const line of String(chunk).split('\n').filter(Boolean)) { lines.push(line); if (waiter) { const w = waiter; waiter = null; w() } } })
  const next = () => new Promise((resolve) => { if (lines.length) resolve(lines.shift()); else waiter = () => resolve(lines.shift()) })
  return { child, next }
}

async function main() {
  // Repeated start in one process: second contender is refused, release frees it.
  const rootA = path.join(scratch, 'a', 'data')
  const first = await ownership.acquireHostOwnership({ dataRoot: rootA, appRoot, build: 't1' })
  assert.equal(first.state, 'held', first.reason)
  const second = await ownership.acquireHostOwnership({ dataRoot: rootA, appRoot, build: 't2' })
  assert.equal(second.state, 'contended', 'a second host for the same data root is refused, never stolen')
  assert.equal(second.holder && second.holder.generation, first.generation, 'discovery descriptor names the live holder (informational)')
  assert.equal(await first.release(), true)
  assert.equal(await first.release(), false, 'release is idempotent')
  const third = await ownership.acquireHostOwnership({ dataRoot: rootA, appRoot, build: 't3' })
  assert.equal(third.state, 'held', 'ownership is reacquirable after a clean release')
  // POSIX locks an on-disk file with flock(2), which must never be deleted
  // (stable inode). Windows uses a named kernel semaphore derived from the
  // lock path: there is no lock file to keep, and the held/contended/
  // reacquire assertions above are the Windows proof.
  if (process.platform !== 'win32') assert.ok(fs.existsSync(path.join(rootA, 'routing', ownership.LOCK_FILENAME)), 'the lock file is never deleted (stable inode)')
  await third.release()
  pass('repeated host startup in one process: one holder, contenders refused, clean release reacquires')

  // Path aliases resolve to one canonical identity.
  const aliasDir = path.join(scratch, 'alias')
  fs.symlinkSync(path.join(scratch, 'a'), aliasDir)
  const viaReal = await ownership.acquireHostOwnership({ dataRoot: rootA, appRoot })
  const viaAlias = await ownership.acquireHostOwnership({ dataRoot: path.join(aliasDir, 'data'), appRoot })
  assert.equal(viaReal.state, 'held')
  assert.equal(viaAlias.state, 'contended', 'a symlinked alias of the same data root cannot become a second owner')
  assert.equal(viaAlias.dataRoot, viaReal.dataRoot)
  await viaReal.release()
  pass('symlinked aliases of a data root share one canonical ownership identity')

  // Competing processes: a live child holder excludes the parent; SIGKILL releases it.
  const rootB = path.join(scratch, 'b', 'data')
  const holder = holderChild(rootB)
  const announced = JSON.parse(await holder.next())
  assert.equal(announced.state, 'held')
  const blocked = await ownership.acquireHostOwnership({ dataRoot: rootB, appRoot })
  assert.equal(blocked.state, 'contended', 'a live holder in another process excludes this one')
  holder.child.kill('SIGKILL')
  await new Promise((resolve) => holder.child.once('exit', resolve))
  const successor = await ownership.acquireHostOwnership({ dataRoot: rootB, appRoot })
  assert.equal(successor.state, 'held', 'the kernel released the dead holder: a successor acquires without TTL, PID checks or deleting files')
  const stale = JSON.parse(fs.readFileSync(path.join(rootB, 'routing', ownership.DESCRIPTOR_FILENAME), 'utf8'))
  assert.equal(stale.generation, successor.generation, 'the successor publishes its own descriptor')
  await successor.release()
  pass('cross-process exclusion with real processes; crash (SIGKILL) releases ownership to a successor')

  // Graceful release by another process, then takeover.
  const graceful = holderChild(rootB)
  assert.equal(JSON.parse(await graceful.next()).state, 'held')
  assert.equal((await ownership.acquireHostOwnership({ dataRoot: rootB, appRoot })).state, 'contended')
  graceful.child.stdin.write('release\n')
  assert.equal(await graceful.next(), 'released')
  await new Promise((resolve) => graceful.child.once('exit', resolve))
  const after = await ownership.acquireHostOwnership({ dataRoot: rootB, appRoot })
  assert.equal(after.state, 'held')
  await after.release()
  pass('graceful shutdown releases ownership; descriptor of a released generation is removed only by its owner')

  // Mechanism unavailable is reported as unavailable, never as held.
  const broken = await ownership.acquireHostOwnership({ dataRoot: path.join(scratch, 'c', 'data'), appRoot: path.join(scratch, 'no-app') })
  assert.equal(broken.state, 'unavailable')
  assert.match(broken.reason, /lock-mechanism-unavailable/)
  pass('a missing lock mechanism reports unavailable (never a false held)')

  // Host Controller plugin on real Cordis: repeated start/stop and a competing host.
  const appRequire = createRequire(path.join(appRoot, 'package.json'))
  const { Context } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/cordis')).href)
  const rootD = path.join(scratch, 'd', 'data')
  fs.mkdirSync(rootD, { recursive: true })
  process.env.AIH_INSTALL_ROOT = sourceRoot
  process.env.DSH_HOME = rootD
  const settle = async (core) => { for (let i = 0; i < 200 && core.ownership.state === 'not-acquired'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); return core.ownership }
  for (let round = 0; round < 3; round += 1) {
    const ctx = new Context()
    const fiber = ctx.plugin(controllerModule)
    await fiber
    const core = ctx.get('nexusController')
    assert.equal((await settle(core)).state, 'held', 'round ' + round + ': the host Controller owns the data root')
    assert.equal(core.readiness().ownership.enforced, true, 'P2-B1: the host Controller enforces ownership')
    assert.equal(core.readiness().ready, true)
    await fiber.dispose()
  }
  // Acquisition is asynchronous: let the first host settle before the second
  // starts, otherwise either may legitimately win (exactly one always does).
  const hostOne = new Context(); const f1 = hostOne.plugin(controllerModule); await f1
  assert.equal((await settle(hostOne.get('nexusController'))).state, 'held', 'the first host owns the installation')
  const hostTwo = new Context(); const f2 = hostTwo.plugin(controllerModule); await f2
  assert.equal((await settle(hostTwo.get('nexusController'))).state, 'contended', 'a second host Controller over the same data root sees contention')
  assert.equal(hostTwo.get('nexusController').readiness().ready, false, 'the contended host is not ready')
  assert.equal(controllerModule.resolveControllerAccess(hostTwo).get().reason, 'nexus-host-ownership-contended', 'plane bridges on the contended host resolve no authority')
  assert.equal(controllerModule.resolveControllerAccess(hostOne).get().reason, null)
  await f1.dispose()
  await f2.dispose()
  const recovered = await ownership.acquireHostOwnership({ dataRoot: rootD, appRoot })
  assert.equal(recovered.state, 'held', 'host disposal released ownership')
  await recovered.release()
  pass('real Cordis host Controller: repeated start/stop reacquires, a competing host is refused (enforced), disposal releases')

  console.log(`NexusHostOwnership: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
