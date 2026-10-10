'use strict'

// Registry R3.1 — write-transport and persistence hardening.
// H1: full origin-tuple checks (scheme/host/port) on every registry route.
// H2: cross-process-safe revision enforcement, unique temp files, stale-claim
// recovery. Offline; no credentials, no network, no DSH sessions.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const CHAR_LF = String.fromCharCode(10)
const repoRoot = path.resolve(__dirname, '..')
const registryAdapter = require('../ui/nexus-controller/lib/registry.cjs')
const registry = require('../config/registry/index.cjs')
const configStore = registry.configStore

delete process.env.DSH_HOME
delete process.env.AIH_INSTALL_ROOT

let passed = 0
let failed = 0
const failures = []
function check(label, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log('PASS: ' + label) })
        .catch((e) => { failed++; failures.push(label + ' :: ' + (e && e.message)); console.log('FAIL: ' + label + ' :: ' + (e && e.message)) })
    }
    passed++
    console.log('PASS: ' + label)
  } catch (e) {
    failed++
    failures.push(label + ' :: ' + (e && e.message))
    console.log('FAIL: ' + label + ' :: ' + (e && e.message))
  }
  return undefined
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Fake transport request: headers + socket like Node's http IncomingMessage.
function treq(headers, encrypted) {
  return { headers: headers || {}, socket: { encrypted: !!encrypted } }
}

async function main() {
  // ── H1: origin tuple ────────────────────────────────────────────────
  await check('H1 absent Origin/Referer still passes (non-browser callers)', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({})), null)
  })

  await check('H1 exact same-origin tuple passes (scheme+host+port)', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'localhost:3080', origin: 'http://localhost:3080/' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'LOCALHOST:3080', origin: 'HTTP://localhost:3080' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/gui' })), null)
  })

  await check('H1 cross-port localhost is rejected', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'localhost:3080', origin: 'http://localhost:9999' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '[::1]:3080', origin: 'http://[::1]:9999/' })), 'origin-forbidden')
  })

  await check('H1 foreign origins are rejected', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'https://evil.example' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'http://evil.example:3080' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', referer: 'https://evil.example/page' })), 'origin-forbidden')
  })

  await check('H1 scheme mismatch is rejected (https page vs http host)', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' })), 'origin-forbidden')
  })

  await check('H1 hostname aliasing is rejected (localhost vs 127.0.0.1)', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'localhost:3080', origin: 'http://127.0.0.1:3080' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'http://localhost:3080' })), 'origin-forbidden')
  })

  await check('H1 null, malformed and multiple origins are rejected', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'null' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'not-a-url' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: '' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080, http://127.0.0.1:3080' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: '127.0.0.1:3080', referer: ':::' })), 'origin-forbidden')
  })

  await check('H1 conflicting Origin and Referer are rejected', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      referer: 'http://evil.example/other',
    })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      referer: 'http://127.0.0.1:3080/same',
    })), null)
  })

  await check('H1 declared origin without a server Host tuple is rejected', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ origin: 'http://127.0.0.1:3080' })), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'not a host!!', origin: 'http://127.0.0.1:3080' })), 'origin-forbidden')
  })

  await check('H1 default ports normalize (http 80 / https 443)', () => {
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'example.internal', origin: 'http://example.internal/' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'example.internal:80', origin: 'http://example.internal/' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'example.internal', origin: 'http://example.internal:80/' })), null)
    assert.equal(registryAdapter.checkSameOrigin(treq({ host: 'example.internal', origin: 'http://example.internal:81/' })), 'origin-forbidden')
  })

  // ── H2: concurrency ─────────────────────────────────────────────────
  const svcOf = (installRoot, dataRoot, fsHooks) => registry.service.createService({ installRoot, dataRoot, ...(fsHooks ? { fsHooks } : {}) })

  // Deterministic TOCTOU interleave (no timing dependence): writer A loads
  // revision 0, writer B completes a full save mid-load, then A resumes.
  // Exactly one may succeed; the loser fails closed and B's update survives.
  await check('H2 interleaved writers with the same revision: exactly one wins', () => {
    const dataRoot = tmpDir('r31-race-')
    const seed = svcOf(repoRoot, dataRoot)
    const cfg = seed.getModeConfiguration('engineering-v2', {}).result.config
    assert.equal(seed.save('engineering-v2', cfg, null, {}).revision, 0)
    const svcB = svcOf(repoRoot, dataRoot)
    let bResult = null
    let bRan = false
    let armed = false
    const hooksA = {
      readFileSync: (p, enc) => {
        if (armed && !bRan && String(p) === configStore.storeFilePath(dataRoot)) {
          bRan = true
          // True TOCTOU: A keeps the pre-B bytes while B completes a save.
          const before = fs.readFileSync(p, enc)
          const cfgB = svcB.getModeConfiguration('engineering-v2', {}).result.config
          cfgB.roleOverrides = { muse_main: { logicalModelId: cfgB.slots.main.logicalModelId, routeId: cfgB.slots.main.routeId, reasoning: 'low' } }
          bResult = svcB.save('engineering-v2', cfgB, 0, {})
          return before
        }
        return fs.readFileSync(p, enc)
      },
      writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
      writeFileExclusive: (p, data, opts) => fs.writeFileSync(p, data, opts),
      renameSync: (a, b) => fs.renameSync(a, b),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      unlinkSync: (p) => fs.unlinkSync(p),
      chmodSync: () => {},
      statSync: (p) => fs.statSync(p),
    }
    const svcA = svcOf(repoRoot, dataRoot, hooksA)
    const cfgA = svcA.getModeConfiguration('engineering-v2', {}).result.config
    armed = true
    const aResult = svcA.save('engineering-v2', cfgA, 0, {})
    assert.ok(bRan, 'writer B ran inside writer A\'s load window')
    assert.equal(bResult.ok, true)
    assert.equal(bResult.revision, 1)
    assert.equal(aResult.ok, false, 'stale writer A must not succeed')
    assert.ok((aResult.errors || []).some((e) => e.code === 'stale-revision' || e.code === 'write-conflict'), 'loser fails closed')
    const final = configStore.loadStore(dataRoot)
    assert.deepEqual(final.errors, [])
    assert.equal(final.store.modes['engineering-v2'].revision, 1)
    assert.deepEqual(final.store.modes['engineering-v2'].config.roleOverrides, cfgB_roleOverrides(), 'winner B\'s update survives, no lost update')
    function cfgB_roleOverrides() {
      return { muse_main: { logicalModelId: cfg.slots.main.logicalModelId, routeId: cfg.slots.main.routeId, reasoning: 'low' } }
    }
  })

  // Cross-mode TOCTOU: writer A (v1) loads, writer B (v2) commits mid-load,
  // then A resumes. Both must succeed and NEITHER update may be lost, even
  // though they hold distinct per-mode claims on one shared document.
  await check('H2 interleaved writers on different modes: both win, nothing lost', () => {
    const dataRoot = tmpDir('r31-xmode-')
    const seed = svcOf(repoRoot, dataRoot)
    const cfgV1 = seed.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(seed.save('engineering-v1', cfgV1, null, {}).revision, 0)
    const svcB = svcOf(repoRoot, dataRoot)
    let bResult = null
    let bRan = false
    let armed = false
    const hooksA = {
      readFileSync: (p, enc) => {
        if (armed && !bRan && String(p) === configStore.storeFilePath(dataRoot)) {
          bRan = true
          const before = fs.readFileSync(p, enc)
          const cfgB = svcB.getModeConfiguration('engineering-v2', {}).result.config
          cfgB.roleOverrides = { muse_main: { logicalModelId: cfgB.slots.main.logicalModelId, routeId: cfgB.slots.main.routeId, reasoning: 'low' } }
          bResult = svcB.save('engineering-v2', cfgB, null, {})
          return before
        }
        return fs.readFileSync(p, enc)
      },
      writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
      writeFileExclusive: (p, data, opts) => fs.writeFileSync(p, data, opts),
      renameSync: (a, b) => fs.renameSync(a, b),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      unlinkSync: (p) => fs.unlinkSync(p),
      chmodSync: () => {},
      statSync: (p) => fs.statSync(p),
    }
    const svcA = svcOf(repoRoot, dataRoot, hooksA)
    const cfgA = svcA.getModeConfiguration('engineering-v1', {}).result.config
    armed = true
    const aResult = svcA.save('engineering-v1', cfgA, 0, {})
    assert.ok(bRan, 'writer B ran inside writer A\'s load window')
    assert.equal(bResult.ok, true)
    assert.equal(bResult.revision, 0)
    assert.equal(aResult.ok, true, 'different-mode writer A must also succeed')
    assert.equal(aResult.revision, 1)
    const final = configStore.loadStore(dataRoot)
    assert.deepEqual(final.errors, [])
    assert.deepEqual(Object.keys(final.store.modes).sort(), ['engineering-v1', 'engineering-v2'])
    assert.equal(final.store.modes['engineering-v1'].revision, 1)
    assert.equal(final.store.modes['engineering-v2'].revision, 0)
    assert.ok(final.store.modes['engineering-v2'].config.roleOverrides.muse_main.reasoning === 'low'
      && final.store.modes['engineering-v2'].config.roleOverrides.muse_main.logicalModelId === 'meta/muse-spark-1.3-contributor',
      'writer B\'s v2 bindings are intact')
    assert.deepEqual(final.store.modes['engineering-v1'].config.slots, cfgA.slots, 'writer A\'s v1 slots are intact')
  })

  await check('H2 temp files never collide across rapid saves', () => {
    const dataRoot = tmpDir('r31-tmp-')
    const seen = []
    const hooks = {
      readFileSync: (p, e) => fs.readFileSync(p, e),
      writeFileSync: (p, data, opts) => { seen.push(String(p)); return fs.writeFileSync(p, data, opts) },
      writeFileExclusive: (p, data, opts) => fs.writeFileSync(p, data, opts),
      renameSync: (a, b) => fs.renameSync(a, b),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      unlinkSync: (p) => fs.unlinkSync(p),
      chmodSync: () => {},
      statSync: (p) => fs.statSync(p),
    }
    const s = svcOf(repoRoot, dataRoot, hooks)
    for (let i = 0; i < 5; i++) {
      const cfg = s.getModeConfiguration('engineering-v2', {}).result.config
      const rev = s.getModeConfiguration('engineering-v2', {}).result.revision
      const r = s.save('engineering-v2', cfg, rev === null || rev === undefined ? null : rev, {})
      assert.equal(r.ok, true)
    }
    const temps = seen.filter((p) => p.includes('.tmp-'))
    assert.equal(temps.length, 5)
    assert.equal(new Set(temps).size, 5, 'every temp path is unique')
  })

  await check('H2 stale lock files recover instead of blocking writes', () => {
    const dataRoot = tmpDir('r31-claim-')
    const s = svcOf(repoRoot, dataRoot)
    const cfg = s.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(s.save('engineering-v1', cfg, null, {}).revision, 0)
    // Plant a stale store-wide lock with a provably dead owner and old mtime.
    const dir = path.join(dataRoot, 'registry')
    const staleLock = path.join(dir, 'mode-configurations.json.lock')
    fs.writeFileSync(staleLock, JSON.stringify({ pid: -5, token: 'dead-owner', modeId: 'engineering-v1', nextRevision: 1, at: new Date(Date.now() - 120000).toISOString() }), 'utf8')
    const old = new Date(Date.now() - 120000)
    fs.utimesSync(staleLock, old, old)
    const cfg2 = s.getModeConfiguration('engineering-v1', {}).result.config
    const r = s.save('engineering-v1', cfg2, 0, {})
    assert.equal(r.ok, true)
    assert.equal(r.revision, 1)
    assert.ok(!fs.existsSync(staleLock), 'stale lock is reaped')
  })

  await check('H2 live lock conflict fails closed without touching the store', () => {
    const dataRoot = tmpDir('r31-live-')
    const s = svcOf(repoRoot, dataRoot)
    const cfg = s.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(s.save('engineering-v1', cfg, null, {}).revision, 0)
    const dir = path.join(dataRoot, 'registry')
    const liveLock = path.join(dir, 'mode-configurations.json.lock')
    fs.writeFileSync(liveLock, JSON.stringify({ pid: process.pid, token: 'foreign-owner', modeId: 'engineering-v1', nextRevision: 1, at: new Date().toISOString() }), 'utf8')
    const bytesBefore = fs.readFileSync(configStore.storeFilePath(dataRoot), 'utf8')
    const cfg2 = s.getModeConfiguration('engineering-v1', {}).result.config
    const r = s.save('engineering-v1', cfg2, 0, {})
    assert.equal(r.ok, false)
    assert.ok((r.errors || []).some((e) => e.code === 'write-conflict'), 'live competing lock reports write-conflict')
    assert.equal(fs.readFileSync(configStore.storeFilePath(dataRoot), 'utf8'), bytesBefore)
    assert.ok(fs.existsSync(liveLock), 'foreign live lock is left for its owner')
    fs.unlinkSync(liveLock)
    const retry = s.save('engineering-v1', s.getModeConfiguration('engineering-v1', {}).result.config, 0, {})
    assert.equal(retry.ok, true)
    assert.equal(retry.revision, 1)
  })

  await check('H2 an old lock with a live owner is never stolen', () => {
    const dataRoot = tmpDir('r31-longop-')
    const s = svcOf(repoRoot, dataRoot)
    const cfg = s.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(s.save('engineering-v1', cfg, null, {}).revision, 0)
    // A long-running operation (older than CLAIM_STALE_MS) whose owner pid
    // is still alive must NOT be reaped merely for its age.
    const dir = path.join(dataRoot, 'registry')
    const oldLiveLock = path.join(dir, 'mode-configurations.json.lock')
    fs.writeFileSync(oldLiveLock, JSON.stringify({ pid: process.pid, token: 'long-op', modeId: 'engineering-v2', nextRevision: 0, at: new Date(Date.now() - 120000).toISOString() }), 'utf8')
    const old = new Date(Date.now() - 120000)
    fs.utimesSync(oldLiveLock, old, old)
    const cfg2 = s.getModeConfiguration('engineering-v1', {}).result.config
    const r = s.save('engineering-v1', cfg2, 0, {})
    assert.equal(r.ok, false)
    assert.ok((r.errors || []).some((e) => e.code === 'write-conflict'), 'aged-but-live lock reports write-conflict, not a steal')
    assert.ok(fs.existsSync(oldLiveLock), 'aged-but-live lock is left untouched')
    assert.equal(configStore.loadStore(dataRoot).store.modes['engineering-v1'].revision, 0)
  })

  // Genuine cross-process contention with deterministic synchronization:
  // a live sleeper process owns the lock (its pid is provably alive), so
  // the save must fail closed; after the owner exits and the lock ages
  // out, the same save succeeds. No sleeps: readiness and death are
  // signalled by process spawn and exit events.
  await check('H2 lock held by another live process blocks, then releases', async () => {
    const dataRoot = tmpDir('r31-xproc-')
    const s = svcOf(repoRoot, dataRoot)
    const cfg = s.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(s.save('engineering-v1', cfg, null, {}).revision, 0)
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      assert.ok(Number.isInteger(sleeper.pid) && sleeper.pid > 0, 'sleeper process spawned')
      const lockPath = path.join(dataRoot, 'registry', 'mode-configurations.json.lock')
      fs.writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, token: 'xproc-owner', modeId: 'engineering-v1', nextRevision: 1, at: new Date().toISOString() }), 'utf8')
      const cfg2 = s.getModeConfiguration('engineering-v1', {}).result.config
      const blocked = s.save('engineering-v1', cfg2, 0, {})
      assert.equal(blocked.ok, false)
      assert.ok((blocked.errors || []).some((e) => e.code === 'write-conflict'), 'live foreign process lock reports write-conflict')
      assert.ok(fs.existsSync(lockPath), 'foreign live lock is not stolen')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sleeper did not exit')), 15000)
        timer.unref()
        sleeper.once('exit', () => { clearTimeout(timer); resolve() })
        sleeper.once('error', (e) => { clearTimeout(timer); reject(e) })
        sleeper.kill()
      })
      const old = new Date(Date.now() - 120000)
      fs.utimesSync(lockPath, old, old)
      const cfg3 = s.getModeConfiguration('engineering-v1', {}).result.config
      const freed = s.save('engineering-v1', cfg3, 0, {})
      assert.equal(freed.ok, true)
      assert.equal(freed.revision, 1)
      assert.ok(!fs.existsSync(lockPath), 'reaped after owner death plus age')
    } finally {
      try { sleeper.kill('SIGKILL') } catch { /* already exited */ }
    }
  })

  await check('H2 failed temp write removes its claim and keeps the store', () => {
    const dataRoot = tmpDir('r31-claimfail-')
    const base = svcOf(repoRoot, dataRoot)
    const cfg = base.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(base.save('engineering-v1', cfg, null, {}).revision, 0)
    const hooks = {
      readFileSync: (p, e) => fs.readFileSync(p, e),
      writeFileSync: () => { throw new Error('disk full at temp stage') },
      writeFileExclusive: (p, data, opts) => fs.writeFileSync(p, data, opts),
      renameSync: (a, b) => fs.renameSync(a, b),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      unlinkSync: (p) => fs.unlinkSync(p),
      chmodSync: () => {},
      statSync: (p) => fs.statSync(p),
    }
    const failing = svcOf(repoRoot, dataRoot, hooks)
    const cfg2 = failing.getModeConfiguration('engineering-v1', {}).result.config
    const r = failing.save('engineering-v1', cfg2, 0, {})
    assert.equal(r.ok, false)
    const leftovers = fs.readdirSync(path.join(dataRoot, 'registry')).filter((n) => n.includes('.tmp-') || n.endsWith('.lock'))
    assert.deepEqual(leftovers, [], 'no temp or lock leftovers, store keeps revision 0')
    assert.equal(configStore.loadStore(dataRoot).store.modes['engineering-v1'].revision, 0)
  })

  await check('H2 write-conflict maps to HTTP 409 like stale-revision', () => {
    assert.equal(registryAdapter.errorStatusOf([{ code: 'write-conflict' }]), 409)
    assert.equal(registryAdapter.errorStatusOf([{ code: 'stale-revision' }]), 409)
  })

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed))
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'))
    process.exitCode = 1
  }
}

main().catch((e) => { console.error('SUITE CRASH: ' + (e && e.stack || e)); process.exitCode = 1 })
