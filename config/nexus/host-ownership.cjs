'use strict'

/**
 * nexus/host-ownership — host lifetime ownership of one Nexus installation's
 * data root (P2-A, Task C foundation).
 *
 * Problem: the launcher (scripts/aih.ps1 + Startup.ps1) discovers an existing
 * host through data/aih-state.json and a PID/start-time identity check, with
 * no cross-process election. Two concurrent starts, or two hosts started with
 * different AIH_PORT values over the same DSH_HOME, can both run and both
 * write Nexus authority files (session bindings, task ledgers). DSH's own
 * per-session JSONL lock protects only session logs.
 *
 * Mechanism: the same kernel arbiters DSH 0.2.2 uses for its session write
 * lease (dsh-session-persistence-jsonl `SessionWriteLease`), never a TTL,
 * PID guess or lock-file deletion:
 *   - POSIX (macOS, Linux): non-blocking flock(2) through the pinned
 *     `@deepseek-ai/node-addon-system/flock` addon on
 *     <canonical data root>/routing/nexus-host.lock, with the same post-lock
 *     inode/device re-check (a replaced lock file proves nothing). The kernel
 *     releases the lock when the descriptor closes, including on any process
 *     death; a wedged live holder keeps it until it exits.
 *   - Windows: a named kernel semaphore (count 1) derived from the canonical
 *     lock path, through the pinned `koffi`, mirroring DSH's
 *     acquireLockHandleWin32. NOT executed in P2-A (no Windows host); any
 *     mechanism failure is reported as `unavailable`, never as `held`.
 * The descriptor file (nexus-host.json) is informational discovery data only;
 * ownership is proven by holding the kernel lock, never by reading the file.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const LOCK_FILENAME = 'nexus-host.lock'
const DESCRIPTOR_FILENAME = 'nexus-host.json'

function canonicalDataRoot(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true })
  const real = fs.realpathSync(dataRoot)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

function isContention(error) {
  const code = error && error.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EBUSY'
}

async function loadFlock(appRoot) {
  const appRequire = createRequire(path.join(appRoot, 'package.json'))
  const resolved = appRequire.resolve('@deepseek-ai/node-addon-system/flock')
  return import(pathToFileURL(resolved).href)
}

async function acquirePosix(lockPath, appRoot) {
  const { tryLockExclusive } = await loadFlock(appRoot)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await fs.promises.open(lockPath, 'w')
    try {
      try {
        await tryLockExclusive(handle.fd)
      } catch (error) {
        await handle.close()
        if (isContention(error)) return { state: 'contended' }
        throw error
      }
      const held = await handle.stat({ bigint: true })
      const current = await fs.promises.stat(lockPath, { bigint: true }).catch((error) => {
        if (error && error.code === 'ENOENT') return undefined
        throw error
      })
      if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
        return { state: 'held', release: async () => { await handle.close() } }
      }
      await handle.close()
    } catch (error) {
      try { await handle.close() } catch { /* already closed */ }
      throw error
    }
  }
  return { state: 'contended' }
}

async function acquireWin32(lockPath, appRoot) {
  const appRequire = createRequire(path.join(appRoot, 'package.json'))
  const koffi = (await import(pathToFileURL(appRequire.resolve('koffi')).href)).default
  const kernel32 = koffi.load('kernel32.dll')
  const createSemaphoreW = kernel32.func('void* __stdcall CreateSemaphoreW(void* attributes, long initial, long maximum, str16 name)')
  const waitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(void* handle, uint32 milliseconds)')
  const releaseSemaphore = kernel32.func('bool __stdcall ReleaseSemaphore(void* handle, long count, void* previous)')
  const closeHandle = kernel32.func('bool __stdcall CloseHandle(void* handle)')
  const name = 'Local\\nexus-host-lock-' + crypto.createHash('sha256').update(path.resolve(lockPath).toLowerCase()).digest('hex')
  const handle = createSemaphoreW(null, 1, 1, name)
  if (!handle) throw Object.assign(new Error('CreateSemaphoreW failed'), { code: 'EHOSTLOCK' })
  const wait = waitForSingleObject(handle, 0)
  if (wait === 0) return { state: 'held', release: async () => { releaseSemaphore(handle, 1, null); closeHandle(handle) } }
  closeHandle(handle)
  if (wait === 0x102) return { state: 'contended' }
  throw Object.assign(new Error('WaitForSingleObject failed: ' + wait), { code: 'EHOSTLOCK' })
}

function writeDescriptor(file, descriptor) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/**
 * Try to become the single host for `dataRoot`. Never blocks and never steals.
 * @returns {Promise<{state:'held'|'contended'|'unavailable', dataRoot, lockPath, generation?, reason?, release():Promise<boolean>}>}
 */
async function acquireHostOwnership(options) {
  const appRoot = options.appRoot
  const build = options.build || 'unknown'
  let dataRoot
  let lockPath
  try {
    dataRoot = canonicalDataRoot(options.dataRoot)
    const routing = path.join(dataRoot, 'routing')
    fs.mkdirSync(routing, { recursive: true, mode: 0o700 })
    lockPath = path.join(routing, LOCK_FILENAME)
  } catch (error) {
    return { state: 'unavailable', dataRoot: options.dataRoot, lockPath: null, reason: 'data-root-unavailable: ' + String(error && error.message), release: async () => false }
  }
  let acquired
  try {
    acquired = process.platform === 'win32' ? await acquireWin32(lockPath, appRoot) : await acquirePosix(lockPath, appRoot)
  } catch (error) {
    return { state: 'unavailable', dataRoot, lockPath, reason: 'lock-mechanism-unavailable: ' + String(error && error.message ? error.message : error), release: async () => false }
  }
  if (acquired.state !== 'held') {
    let holder = null
    try { holder = JSON.parse(fs.readFileSync(path.join(path.dirname(lockPath), DESCRIPTOR_FILENAME), 'utf8')) } catch { /* informational only */ }
    return { state: 'contended', dataRoot, lockPath, holder, release: async () => false }
  }
  const generation = crypto.randomBytes(16).toString('hex')
  const descriptorPath = path.join(path.dirname(lockPath), DESCRIPTOR_FILENAME)
  const descriptor = { schemaVersion: 1, pid: process.pid, generation, build, dataRoot, platform: process.platform, acquiredAtUtc: new Date().toISOString() }
  try { writeDescriptor(descriptorPath, descriptor) } catch { /* discovery data is optional */ }
  let released = false
  return {
    state: 'held',
    dataRoot,
    lockPath,
    generation,
    descriptor,
    async release() {
      if (released) return false
      released = true
      try {
        const current = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
        if (current && current.generation === generation) fs.rmSync(descriptorPath, { force: true })
      } catch { /* absent or replaced: never remove another generation's data */ }
      // The lock file itself is never removed (stable inode for later lockers).
      await acquired.release()
      return true
    },
  }
}

module.exports = { acquireHostOwnership, canonicalDataRoot, LOCK_FILENAME, DESCRIPTOR_FILENAME }
