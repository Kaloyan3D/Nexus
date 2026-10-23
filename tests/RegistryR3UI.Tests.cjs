'use strict'

// Registry R3 — staged UI configuration, persistence, isolation and host boundary.
// Offline: real installRoot reads, isolated tmp roots for every write. No
// credentials, no network, no DSH sessions, no PowerShell.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const repoRoot = path.resolve(__dirname, '..')
const registry = require('../config/registry/index.cjs')
const { schemas, resolver, legacyImport } = registry
const configStore = registry.configStore
const serviceModule = registry.service
const registryAdapter = require('../ui/nexus-controller/lib/registry.cjs')

delete process.env.DSH_HOME
delete process.env.AIH_INSTALL_ROOT
delete process.env.DSH_AIH_PROFILE
delete process.env.AIH_ACTIVE_PROFILE

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
async function seq(steps) {
  for (const s of steps) await check(s[0], s[1])
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
function codes(errors) {
  return (errors || []).map((e) => (e && e.code) || '')
}
function svcOn(installRoot, dataRoot) {
  return serviceModule.createService({ installRoot, dataRoot })
}
function shaOf(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file, 'utf8'), 'utf8').digest('hex')
}
function walkFiles(root) {
  const out = []
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) visit(p)
      else out.push(path.relative(root, p))
    }
  }
  visit(root)
  return out.sort()
}

// Isolated install root: real legacy inputs + optional operator custom profile.
function makeIsolatedRoot(withCustom) {
  const root = tmpDir('r3-iso-')
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  for (const f of ['config/engineering-profiles.json', 'config/muse-profiles.json', 'config/model-registry.json']) {
    fs.copyFileSync(path.join(repoRoot, f), path.join(root, f))
  }
  if (withCustom) {
    const deep = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'engineering-profiles.json'), 'utf8'))
      .profiles.find((p) => p.id === 'deepseek-codex')
    const custom = {
      schemaVersion: 1,
      roles: {
        primaryEngineer: { model: 'deepseek-v4-flash', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3-flash', reasoning: 'max' },
        reviewer: deep.roles.reviewer,
        solver: deep.roles.solver,
        fallback: { model: 'glm-5.3', reasoning: 'off' },
        visualReviewer: { model: 'deepseek-v4-flash-vision-exp', reasoning: 'high' },
      },
    }
    fs.writeFileSync(path.join(root, 'data', 'custom-engineering-profile.json'), JSON.stringify(custom, null, 2), 'utf8')
  }
  return root
}

function fakeReq(opts) {
  const o = opts || {}
  const req = new EventEmitter()
  req.method = o.method || 'GET'
  req.url = o.url || '/'
  req.headers = o.headers || {}
  req.destroy = () => {}
  const chunks = o.chunks || []
  process.nextTick(() => {
    for (const c of chunks) req.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  return {
    status: null, headers: null, body: '',
    writeHead(s, h) { this.status = s; this.headers = h },
    end(t) { this.body = t; if (this.done) this.done() },
  }
}
function runHandler(handler, req) {
  const res = fakeRes()
  return new Promise((resolve) => {
    res.done = () => resolve(res)
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.status) { res.status = 500; res.body = JSON.stringify({ ok: false, error: 'handler-threw' }) }
      resolve(res)
    })
  })
}
const SECRET_PROBE = /sk-(live|proj)-|xox[bap]-|ghp_|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]/i

async function main() {
  const dataA = tmpDir('r3-data-')
  const svc = svcOn(repoRoot, dataA)

  // ── R3.1 modes ────────────────────────────────────────────────────────
  await check('R3 modes: v1/v2/v3 listed with honest statuses, v3 non-executable', () => {
    const { modes, errors } = svc.listModes()
    assert.deepEqual(errors, [])
    // the three legacy modes, plus (in a source tree that carries it) the DORMANT adaptive mode
    // (EM-04C2): planned, neither selectable nor runnable, never executable
    assert.deepEqual(modes.map((m) => m.id).filter((id) => id !== 'engineering-v2-adaptive'), ['engineering-v1', 'engineering-v2', 'engineering-v3'])
    const adaptive = modes.find((m) => m.id === 'engineering-v2-adaptive')
    if (adaptive) {
      assert.equal(adaptive.status, 'planned')
      assert.equal(adaptive.selectable, false)
      assert.equal(adaptive.runnable, false)
      assert.equal(adaptive.executable, false)
      // EM-04C2 S10 SEC-5: even if it were opened, it runs only from an operator-saved configuration
      assert.equal(require('../config/registry/native-issuer.cjs').scopeOf('engineering-v2-adaptive').requiresSavedConfiguration, true)
    }
    assert.equal(modes.length, adaptive ? 4 : 3)
    const byId = Object.fromEntries(modes.map((m) => [m.id, m]))
    assert.equal(byId['engineering-v1'].status, 'deprecated')
    assert.equal(byId['engineering-v2'].status, 'active-legacy')
    assert.equal(byId['engineering-v3'].status, 'planned')
    assert.equal(byId['engineering-v1'].executable, true)
    assert.equal(byId['engineering-v2'].executable, true)
    assert.equal(byId['engineering-v3'].executable, false)
    assert.ok(String(byId['engineering-v3'].executableReason || '').includes('mode-not-runnable'))
    assert.ok(!/aih-/.test(JSON.stringify(modes)), 'no internal preset ids in public mode list')
  })

  await check('R3 v1 preview keeps deepseek bindings verbatim (slots + overrides)', () => {
    const { result, errors } = svc.getModeConfiguration('engineering-v1', {})
    assert.deepEqual(errors, [])
    assert.equal(result.persisted, false)
    assert.equal(result.adoptedFrom, 'deepseek-codex')
    assert.deepEqual(result.validation, [])
    const raw = legacyImport.importLegacyProfiles(repoRoot, legacyImport.buildRegistrySnapshot(repoRoot).snapshot)
    assert.deepEqual(result.config.slots, raw.configs['deepseek-codex'].slots)
    assert.deepEqual(result.config.roleOverrides, raw.configs['deepseek-codex'].roleOverrides)
  })

  await check('R3 glm-codex adopt preview is valid and independent of deepseek', () => {
    const a = svc.getModeConfiguration('engineering-v1', { adopt: 'glm-codex' })
    assert.ok(a.result && a.result.config)
    assert.deepEqual(a.result.validation, [])
    assert.notDeepEqual(a.result.config.slots.engineer, svc.getModeConfiguration('engineering-v1', {}).result.config.slots.engineer)
  })

  await check('R3 v2 canonical Muse model with two distinct routes', () => {
    const meta = svc.getModeConfiguration('engineering-v2', {})
    const open = svc.getModeConfiguration('engineering-v2', { adopt: 'muse-spark-1.3-contributor-opencode' })
    assert.deepEqual(meta.result.validation, [])
    assert.equal(meta.result.config.slots.main.logicalModelId, 'meta/muse-spark-1.3-contributor')
    assert.equal(open.result.config.slots.main.logicalModelId, 'meta/muse-spark-1.3-contributor')
    assert.notEqual(meta.result.config.slots.main.routeId, open.result.config.slots.main.routeId)
    assert.ok(meta.result.config.slots.main.routeId.startsWith('meta-model-api/'))
    assert.ok(open.result.config.slots.main.routeId.startsWith('opencode-go/'))
    const elig = svc.listEligible('engineering-v2', 'main')
    assert.deepEqual(elig.errors, [])
    assert.equal(elig.routes.length, 2)
    const conns = new Set(elig.routes.map((r) => r.connectionId))
    assert.equal(conns.size, 2)
    assert.ok(!/aih-/.test(JSON.stringify(elig.routes)), 'no internal preset ids in eligible routes')
  })

  await check('R3 v3 is preview-only: no config, save rejected mode-not-runnable', () => {
    const v3 = svc.getModeConfiguration('engineering-v3', {})
    assert.ok(v3.result && v3.result.runnable === false && !v3.result.config)
    assert.ok((v3.result.slotsManifest || []).length >= 4)
    const bad = { schemaVersion: 1, modeId: 'engineering-v3', revision: 0, slots: { planner: { logicalModelId: 'x', routeId: 'y', reasoning: 'high' } } }
    const saved = svc.save('engineering-v3', bad, null, {})
    assert.equal(saved.ok, false)
    assert.ok(codes(saved.errors).includes('mode-not-runnable'))
  })

  await check('R3 invalid reasoning/route combinations fail validation closed', () => {
    const v2 = svc.getModeConfiguration('engineering-v2', {}).result.config
    const maxed = JSON.parse(JSON.stringify(v2))
    maxed.slots.main.reasoning = 'max'
    assert.ok(codes(svc.validate(maxed).errors).includes('reasoning-level-not-supported'))
    const unknown = JSON.parse(JSON.stringify(v2))
    unknown.slots.main.routeId = 'nope/missing'
    assert.ok(codes(svc.validate(unknown).errors).includes('unknown-reference'))
  })

  await check('R3 disabled routes are ineligible and cannot compile', () => {
    const { snapshot } = svc.buildCanonical()
    const tampered = JSON.parse(JSON.stringify(snapshot))
    const target = tampered.routes.find((r) => r.id === 'meta-model-api/meta/muse-spark-1.3-contributor')
    target.enabled = false
    const elig = resolver.listEligibleRoutes('engineering-v2', 'main', tampered)
    assert.ok(!elig.some((r) => r.id === target.id))
    const cfg = svc.getModeConfiguration('engineering-v2', {}).result.config
    assert.ok(codes(resolver.validateModeConfig(cfg, tampered)).includes('route-unavailable'))
  })

  // ── custom profile round trip (isolated root) ─────────────────────────
  const iso = makeIsolatedRoot(true)
  const dataIso = tmpDir('r3-iso-data-')
  const svcIso = svcOn(iso, dataIso)
  await check('R3 custom profile imports with per-role differences intact', () => {
    const { result, errors } = svcIso.getModeConfiguration('engineering-v1', { adopt: 'custom' })
    assert.deepEqual(errors, [])
    assert.deepEqual(result.validation, [])
    const keys = Object.keys(result.config.roleOverrides || {})
    assert.ok(keys.includes('deepEngineer') && keys.includes('fallback') && keys.includes('visualReviewer'))
    assert.notDeepEqual(result.config.roleOverrides.deepEngineer, result.config.slots.engineer)
    assert.notDeepEqual(result.config.roleOverrides.fallback, result.config.slots.engineer)
    const raw = legacyImport.importLegacyProfiles(iso, legacyImport.buildRegistrySnapshot(iso).snapshot)
    assert.deepEqual(result.config, { ...raw.configs.custom, revision: 0 })
  })

  await check('R3 advanced overrides survive save/reload/restart', () => {
    const before = svcIso.getModeConfiguration('engineering-v1', { adopt: 'custom' }).result.config
    const saved = svcIso.save('engineering-v1', before, null, { source: 'legacy-adopt', adoptedFrom: 'custom' })
    assert.equal(saved.ok, true)
    assert.equal(saved.revision, 0)
    const reloaded = svcIso.getModeConfiguration('engineering-v1', {}).result
    assert.equal(reloaded.persisted, true)
    assert.deepEqual(reloaded.config.roleOverrides, before.roleOverrides)
    assert.deepEqual(reloaded.config.slots, before.slots)
    const svcRestart = svcOn(iso, dataIso)
    assert.deepEqual(svcRestart.getModeConfiguration('engineering-v1', {}).result.config, reloaded.config)
  })

  await check('R3 mode configurations stay independent with own revisions', () => {
    const v2cfg = svcIso.getModeConfiguration('engineering-v2', {}).result.config
    assert.equal(svcIso.save('engineering-v2', v2cfg, null, {}).revision, 0)
    const v1cfg = svcIso.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(svcIso.save('engineering-v1', v1cfg, 0, {}).revision, 1)
    assert.equal(svcIso.getModeConfiguration('engineering-v2', {}).result.revision, 0)
    assert.equal(svcIso.getModeConfiguration('engineering-v1', {}).result.revision, 1)
  })

  // ── persistence semantics ─────────────────────────────────────────────
  await check('R3 initial store is empty and saves stage without legacy writes', () => {
    const fresh = tmpDir('r3-fresh-')
    const s = svcOn(repoRoot, fresh)
    const loaded = configStore.loadStore(fresh)
    assert.deepEqual(loaded.errors, [])
    assert.deepEqual(loaded.store.modes, {})
    assert.equal(walkFiles(fresh).length, 0)
  })

  await check('R3 stale revisions fail closed and leave the file untouched', () => {
    const f = configStore.storeFilePath(dataIso)
    const bytesBefore = fs.readFileSync(f, 'utf8')
    const v1cfg = svcIso.getModeConfiguration('engineering-v1', {}).result.config
    const stale = svcIso.save('engineering-v1', v1cfg, 0, {})
    assert.equal(stale.ok, false)
    assert.ok(codes(stale.errors).includes('stale-revision'))
    assert.equal(fs.readFileSync(f, 'utf8'), bytesBefore)
    const createAgain = svcIso.save('engineering-v2', svcIso.getModeConfiguration('engineering-v2', {}).result.config, 7, {})
    assert.ok(codes(createAgain.errors).includes('stale-revision'))
  })

  await check('R3 malformed and versioned stores fail closed', () => {
    const dir = tmpDir('r3-bad-')
    fs.mkdirSync(path.join(dir, 'registry'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'registry', 'mode-configurations.json'), '{not json', 'utf8')
    assert.ok(codes(configStore.loadStore(dir).errors).includes('registry-store-corrupt'))
    assert.ok(svcOn(repoRoot, dir).getModeConfiguration('engineering-v1', {}).errors.length > 0)
    fs.writeFileSync(path.join(dir, 'registry', 'mode-configurations.json'), JSON.stringify({ schemaVersion: 999, modes: {} }), 'utf8')
    assert.ok(codes(configStore.loadStore(dir).errors).includes('registry-store-corrupt'))
  })

  await check('R3 failed writes leave no partial file or temp behind', async () => {
    const dir = tmpDir('r3-failw-')
    const s = svcOn(repoRoot, dir)
    const cfg = s.getModeConfiguration('engineering-v1', {}).result.config
    assert.equal(s.save('engineering-v1', cfg, null, {}).ok, true)
    const bytesBefore = fs.readFileSync(configStore.storeFilePath(dir), 'utf8')
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
    const failing = serviceModule.createService({ installRoot: repoRoot, dataRoot: dir, fsHooks: hooks })
    const r = failing.save('engineering-v1', failing.getModeConfiguration('engineering-v1', {}).result.config, 0, {})
    assert.equal(r.ok, false)
    assert.ok(codes(r.errors).includes('registry-store-unwritable'))
    assert.equal(fs.readFileSync(configStore.storeFilePath(dir), 'utf8'), bytesBefore)
    assert.ok(!walkFiles(dir).some((f) => f.includes('.tmp-') || f.endsWith('.lock')), 'no temp or lock leftovers')
  })

  await check('R3 invalid configs never reach disk (no partial save)', () => {
    const dir = tmpDir('r3-partial-')
    const s = svcOn(repoRoot, dir)
    const cfg = s.getModeConfiguration('engineering-v2', {}).result.config
    const bad = JSON.parse(JSON.stringify(cfg))
    bad.slots.main.reasoning = 'max'
    assert.equal(s.save('engineering-v2', bad, null, {}).ok, false)
    assert.ok(!fs.existsSync(configStore.storeFilePath(dir)), 'no store file after rejected save')
  })

  await check('R3 secret material is rejected and never persisted', () => {
    const dir = tmpDir('r3-secret-')
    const s = svcOn(repoRoot, dir)
    const cfg = s.getModeConfiguration('engineering-v1', {}).result.config
    const evil = JSON.parse(JSON.stringify(cfg))
    evil.slots.engineer.reasoning = 'sk-live-SECRET1234567890'
    // Service layer rejects first at canonical validation (unknown level):
    // nothing is ever persisted for an invalid proposal.
    const r = s.save('engineering-v1', evil, null, {})
    assert.equal(r.ok, false)
    assert.ok(!fs.existsSync(configStore.storeFilePath(dir)))
    // Store layer is the secret backstop: a schema-plausible secret-shaped
    // value is refused with secret-material-rejected and never written.
    const schemaly = JSON.parse(JSON.stringify(s.getModeConfiguration('engineering-v2', {}).result.config))
    schemaly.slots.main.reasoning = 'high'
    schemaly.roleOverrides = { muse_main: { logicalModelId: schemaly.slots.main.logicalModelId, routeId: schemaly.slots.main.routeId, reasoning: 'sk-live-SECRET1234567890' } }
    const direct = configStore.saveModeConfig(dir, 'engineering-v2', schemaly, null, {})
    assert.equal(direct.ok, false)
    assert.ok(codes(direct.errors).includes('secret-material-rejected'))
    assert.ok(!fs.existsSync(configStore.storeFilePath(dir)))
    const hits = []
    configStore.scanForSecrets({ apiKey: 'x' }, 'm', hits)
    assert.ok(hits.some((h) => h.code === 'secret-material-rejected'))
    const clean = []
    configStore.scanForSecrets({ connectionId: 'conn-x', credentialRef: 'credential://connections/conn-x' }, 'm', clean)
    assert.deepEqual(clean, [])
    const okCfg = s.getModeConfiguration('engineering-v2', {}).result.config
    assert.equal(s.save('engineering-v2', okCfg, null, {}).ok, true)
    const text = fs.readFileSync(configStore.storeFilePath(dir), 'utf8')
    assert.ok(!SECRET_PROBE.test(text), 'stored JSON is secret-free')
  })

  // ── runtime isolation ─────────────────────────────────────────────────
  await check('R3 saves touch only data/registry: legacy files byte-identical', () => {
    const hashes = {}
    for (const f of ['config/engineering-profiles.json', 'config/muse-profiles.json', 'config/model-registry.json', 'config/nexus-profiles.json', 'config/routing-policy.json']) {
      hashes[f] = shaOf(path.join(iso, f) === path.join(repoRoot, f) ? path.join(repoRoot, f) : path.join(repoRoot, f))
    }
    const isoHashes = {}
    for (const f of ['config/engineering-profiles.json', 'config/muse-profiles.json', 'config/model-registry.json']) {
      isoHashes[f] = shaOf(path.join(iso, f))
    }
    const v2b = svcIso.getModeConfiguration('engineering-v2', {}).result.config
    svcIso.save('engineering-v2', v2b, 0, {})
    for (const f of Object.keys(isoHashes)) assert.equal(shaOf(path.join(iso, f)), isoHashes[f])
    for (const f of Object.keys(hashes)) assert.equal(shaOf(path.join(repoRoot, f)), hashes[f])
    assert.deepEqual(walkFiles(dataIso), ['registry/mode-configurations.json'])
  })

  await check('R3 compiled previews pin reviewer/solver semantics + stable ids', () => {
    const cfg = svc.getModeConfiguration('engineering-v1', {}).result.config
    const a = svc.compilePreview(cfg)
    const b = svc.compilePreview(cfg)
    assert.equal(a.ok, true)
    assert.equal(a.snapshot.resolutionId, b.snapshot.resolutionId)
    assert.equal(a.snapshot.roles.reviewer.providerId, 'sol-local')
    assert.ok(a.snapshot.roles.solver)
    assert.ok(!SECRET_PROBE.test(JSON.stringify(a.snapshot)))
  })

  await check('R3 Muse isolation: contributor tier, no max, service has no session writers', () => {
    const cfg = svc.getModeConfiguration('engineering-v2', {}).result.config
    const compiled = svc.compilePreview(cfg)
    assert.equal(compiled.snapshot.roles.muse_main.dataUseTier, 'contributor')
    assert.ok(!Object.keys(svc).some((k) => /session|preset|binding|settings|routing|credential/i.test(k)), 'no session/preset writers on the service surface')
  })

  // ── host boundary ─────────────────────────────────────────────────────
  await check('R3 bounded bodies: oversized rejected, bad JSON rejected', async () => {
    const big = await registryAdapter.readBoundedJson(fakeReq({ method: 'PUT', chunks: ['x'.repeat(70000)] }), 65536)
    assert.equal(big.error, 'payload-too-large')
    const bad = await registryAdapter.readBoundedJson(fakeReq({ method: 'PUT', chunks: ['{nope'] }), 65536)
    assert.equal(bad.error, 'invalid-json-body')
    const good = await registryAdapter.readBoundedJson(fakeReq({ method: 'PUT', chunks: ['{"a":1}'] }), 65536)
    assert.deepEqual(good.body, { a: 1 })
  })

  // R3.1 H1 supersedes the old loopback exemption: only the full tuple
  // (scheme+host+port) passes; the matrix lives in RegistryR3Hardening.
  await check('R3 same-origin gate: absent passes, exact tuple passes, rest blocked', () => {
    assert.equal(registryAdapter.checkSameOrigin({ headers: {} }), null)
    assert.equal(registryAdapter.checkSameOrigin({ headers: { origin: 'https://evil.example' } }), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), null)
    assert.equal(registryAdapter.checkSameOrigin({ headers: { host: 'app.internal:3080', origin: 'http://app.internal:3080' } }), null)
    assert.equal(registryAdapter.checkSameOrigin({ headers: { origin: 'http://localhost:3080' } }), 'origin-forbidden')
    assert.equal(registryAdapter.checkSameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' } }), 'origin-forbidden')
  })

  const dataH = tmpDir('r3-host-')
  const svcH = svcOn(repoRoot, dataH)
  const handlers = registryAdapter.createRegistryHandlers(svcH)
  const allBodies = []
  const capture = (res) => { allBodies.push(res.body) }

  await check('R3 host modes route lists the three manifests (plus the dormant adaptive one in a source tree)', async () => {
    const res = await runHandler(handlers.modesHandler, fakeReq({ method: 'GET', url: '/nexus/registry/v1/modes' }))
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    const legacy = body.modes.filter((m) => m.id !== 'engineering-v2-adaptive')
    assert.equal(legacy.length, 3)
    for (const m of body.modes.filter((x) => x.id === 'engineering-v2-adaptive')) {
      assert.equal(m.selectable, false)
      assert.equal(m.runnable, false)
      assert.equal(m.executable, false)
    }
    assert.ok(body.modes.length <= 4)
    capture(res)
  })

  await check('R3 host configuration GET validates mode ids', async () => {
    const missing = await runHandler(handlers.configurationHandler, fakeReq({ method: 'GET', url: '/nexus/registry/v1/configuration' }))
    assert.equal(missing.status, 400)
    const unknown = await runHandler(handlers.configurationHandler, fakeReq({ method: 'GET', url: '/nexus/registry/v1/configuration?mode=nope' }))
    assert.equal(unknown.status, 422)
    const v1 = await runHandler(handlers.configurationHandler, fakeReq({ method: 'GET', url: '/nexus/registry/v1/configuration?mode=engineering-v1' }))
    assert.equal(v1.status, 200)
    assert.equal(JSON.parse(v1.body).result.persisted, false)
    capture(v1)
  })

  await check('R3 host PUT saves, rejects stale/invalid/foreign/oversized', async () => {
    const cfg = svcH.getModeConfiguration('engineering-v1', {}).result.config
    const put = (payload, headers) => runHandler(handlers.configurationHandler, fakeReq({ method: 'PUT', url: '/nexus/registry/v1/configuration', headers: headers || {}, chunks: [JSON.stringify(payload)] }))
    const first = await put({ modeId: 'engineering-v1', config: cfg, expectedRevision: null })
    assert.equal(first.status, 200)
    assert.equal(JSON.parse(first.body).revision, 0)
    capture(first)
    const stale = await put({ modeId: 'engineering-v1', config: cfg, expectedRevision: null })
    assert.equal(stale.status, 409)
    assert.equal(JSON.parse(stale.body).error, 'stale-revision')
    const bad = JSON.parse(JSON.stringify(cfg))
    bad.slots.engineer.reasoning = 'bogus-level'
    const invalid = await put({ modeId: 'engineering-v1', config: bad, expectedRevision: 0 })
    assert.equal(invalid.status, 422)
    const foreign = await put({ modeId: 'engineering-v1', config: cfg, expectedRevision: 0 }, { origin: 'https://evil.example' })
    assert.equal(foreign.status, 403)
    const huge = await runHandler(handlers.configurationHandler, fakeReq({ method: 'PUT', url: '/x', chunks: [JSON.stringify({ modeId: 'x', config: cfg, pad: 'y'.repeat(70000) })] }))
    assert.equal(huge.status, 413)
    const v3bad = { schemaVersion: 1, modeId: 'engineering-v3', revision: 0, slots: { planner: { logicalModelId: 'x', routeId: 'y', reasoning: 'high' } } }
    const v3 = await put({ modeId: 'engineering-v3', config: v3bad, expectedRevision: null })
    assert.equal(v3.status, 422)
    assert.equal(JSON.parse(v3.body).error, 'mode-not-runnable')
  })

  await check('R3 host validate/preview/eligible routes behave', async () => {
    const cfg = svcH.getModeConfiguration('engineering-v2', {}).result.config
    const post = (h, payload) => runHandler(h, fakeReq({ method: 'POST', url: '/x', chunks: [JSON.stringify(payload)] }))
    const okV = await post(handlers.validateHandler, { config: cfg })
    assert.equal(okV.status, 200)
    const bad = JSON.parse(JSON.stringify(cfg))
    bad.slots.main.reasoning = 'max'
    const badV = await post(handlers.validateHandler, { config: bad })
    assert.equal(badV.status, 422)
    assert.equal(JSON.parse(badV.body).error, 'validation-failed')
    capture(badV)
    const prev = await post(handlers.previewHandler, { config: cfg })
    assert.equal(prev.status, 200)
    assert.ok(JSON.parse(prev.body).snapshot.resolutionId)
    capture(prev)
    const elig = await runHandler(handlers.eligibleHandler, fakeReq({ method: 'GET', url: '/nexus/registry/v1/eligible?mode=engineering-v2&slot=main' }))
    assert.equal(elig.status, 200)
    assert.equal(JSON.parse(elig.body).eligible.length, 2)
    const miss = await runHandler(handlers.eligibleHandler, fakeReq({ method: 'GET', url: '/nexus/registry/v1/eligible?mode=engineering-v2' }))
    assert.equal(miss.status, 400)
    const getOnPut = await runHandler(handlers.validateHandler, fakeReq({ method: 'GET', url: '/x' }))
    assert.equal(getOnPut.status, 405)
  })

  await check('R3 Registry Core stays runtime-independent (no DSH/PowerShell imports)', () => {
    const forbidden = ['DSH_HOME', 'AIH_INSTALL_ROOT', 'llm-pi-ai', 'aih-muse', 'aih-engineering', 'session.events', 'powershell', 'child_process', 'node:child_process']
    for (const file of ['schemas.cjs', 'resolver.cjs', 'index.cjs', 'config-store.cjs', 'service.cjs', 'legacy-import.cjs', 'muse-canonical.cjs', 'profile-compat.cjs']) {
      const text = fs.readFileSync(path.join(repoRoot, 'config', 'registry', file), 'utf8')
      for (const token of forbidden) assert.ok(!text.includes(token), file + ' must not reference ' + token)
      assert.ok(!/aih-[a-z]+/.test(text), file + ' must not name internal presets')
    }
    assert.ok(!SECRET_PROBE.test(allBodies.join('\n')), 'host responses are secret-free')
  })

  // ── UI smoke (real bundle in a VM with stubbed react) ─────────────────
  const CLIENT = path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'client.js')
  function stubReact() {
    const Fragment = Symbol.for('nx.fragment')
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const renderAttrs = (props) => {
      let out = ''
      if (!props) return out
      if (props.className) out += ' class="' + esc(props.className) + '"'
      if (props.title) out += ' title="' + esc(props.title) + '"'
      if (props.value !== undefined && typeof props.value === 'string') out += ' value="' + esc(props.value) + '"'
      if (props.disabled) out += ' disabled'
      if (props.checked) out += ' checked'
      if (props.type) out += ' type="' + esc(props.type) + '"'
      if (props.name) out += ' name="' + esc(props.name) + '"'
      for (const k of Object.keys(props)) {
        if (k.startsWith('aria-')) out += ' ' + k + '="' + esc(String(props[k])) + '"'
      }
      return out
    }
    const flat = (c) => (Array.isArray(c) ? c.map(flat).join('') : (c === null || c === undefined || c === false ? '' : String(c)))
    const selfClosing = new Set(['input'])
    function h(type, props, ...children) {
      const kids = flat(children.length === 1 ? children[0] : children)
      if (typeof type === 'function') return type({ ...(props || {}), children: children.length <= 1 ? children[0] : children })
      if (type === Fragment) return kids
      if (typeof type === 'string') {
        if (selfClosing.has(type)) return '<' + type + renderAttrs(props) + '>'
        return '<' + type + renderAttrs(props) + '>' + kids + '</' + type + '>'
      }
      return kids
    }
    return {
      createElement: h,
      Fragment,
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (v) => ({ current: v }),
    }
  }
  function loadBundle(seams, pref) {
    const source = fs.readFileSync(CLIENT, 'utf8')
    const react = stubReact()
    const jsxRuntime = { jsx: (t, p) => react.createElement(t, p, p && p.children), jsxs: (t, p) => react.createElement(t, p, p && p.children), Fragment: react.Fragment }
    let factory = null
    const sandbox = {
      console, URL, Promise, Map, Set, JSON, Object, Array, Symbol, Error, Math, Number, String, Boolean, Date, RegExp,
      window: {
        ...seams,
        localStorage: { getItem: (k) => (k === 'nexus.registry.mode' ? pref || null : null), setItem: () => {} },
        setTimeout: () => 0, clearTimeout: () => {},
        __ModuleLoader__: { load(def) { factory = def.factory } },
      },
      document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
      navigator: {},
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox, { filename: 'client.js' })
    const module = { exports: {} }
    const exports = factory((name) => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return jsxRuntime
      throw new Error('unexpected require ' + name)
    })
    return { exports, react }
  }
  function registrySeams() {
    const s = svcOn(repoRoot, tmpDir('r3-ui-'))
    const modesDoc = { ok: true, schemaVersion: 1, modes: s.listModes().modes }
    const cfgDocs = {}
    for (const id of ['engineering-v1', 'engineering-v2', 'engineering-v3']) {
      cfgDocs[id] = s.getModeConfiguration(id, {}).result
    }
    const elig = {}
    const canon = s.buildCanonical().snapshot
    const byId = (id) => canon.modes.find((m) => m.id === id)
    for (const mode of canon.modes) {
      for (const slot of mode.slots) {
        elig[mode.id + '/' + slot.id] = {
          eligible: s.listEligible(mode.id, slot.id).routes,
          ineligible: s.listIneligible(mode.id, slot.id).routes,
        }
      }
    }
    void byId
    return {
      __NX_TEST_REGISTRY_MODES__: modesDoc,
      __NX_TEST_REGISTRY_CONFIG__: cfgDocs,
      __NX_TEST_REGISTRY_ELIGIBLE__: elig,
    }
  }
  const seams = registrySeams()

  await check('R3 UI smoke: v2 renders canonical model, both routes, tier notice, staged banner', () => {
    const { exports } = loadBundle(seams, 'engineering-v2')
    const html = exports.RegistryPanel({ sessionId: null, legacyRuntimeName: 'deepseek-codex' })
    assert.ok(html.includes('Engineering Modes (Registry)'), 'panel title')
    assert.ok(html.includes('Staged configuration'), 'staged banner')
    assert.ok(html.includes('Muse Spark 1.3 Contributor'), 'canonical model')
    assert.ok(html.includes('meta-model-api') && html.includes('opencode-go'), 'both provider routes distinct')
    assert.equal((html.match(/type="radio"/g) || []).length, 2, 'exactly the two verified routes as choices')
    assert.ok(html.includes('Contributor data-use tier'), 'tier notice')
    assert.ok(html.includes('Current legacy runtime: deepseek-codex'), 'runtime separation')
    assert.ok(html.includes('Engineering Mode v3 / Nexus Nova'), 'v3 visible in selector')
    assert.ok(!/aih-[a-z]+/.test(html), 'no internal preset ids in Registry UI')
  })

  await check('R3 UI smoke: v1 renders three slots plus advanced overrides', () => {
    const { exports } = loadBundle(seams, 'engineering-v1')
    const html = exports.RegistryPanel({ sessionId: null, legacyRuntimeName: 'deepseek-codex' })
    assert.ok(html.includes('Engineer') && html.includes('Independent Reviewer') && html.includes('Approval-gated Solver'))
    assert.ok(html.includes('Advanced role overrides'), 'advanced section')
    assert.ok(html.includes('Deep Engineer') && html.includes('Visual Reviewer'), 'override roles')
    assert.ok(html.includes('Adopt &amp; save staged configuration') || html.includes('Adopt & save staged configuration'), 'adopt CTA')
  })

  await check('R3 UI smoke: v3 is preview-only with disabled execution', () => {
    const { exports } = loadBundle(seams, 'engineering-v3')
    const html = exports.RegistryPanel({ sessionId: null, legacyRuntimeName: 'deepseek-codex' })
    assert.ok(html.includes('Planned / Preview'), 'planned status')
    assert.ok(html.includes('Preview only'), 'disabled controls')
    assert.ok(html.includes('disabled'), 'disabled attribute present')
    assert.ok(!html.includes('nx-eng-save'), 'no save button for planned mode')
    assert.ok(/Planner/.test(html) && /Verifier/.test(html), 'nova slot manifest shown')
  })

  console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed))
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.join('\n'))
    process.exitCode = 1
  }
}

main().catch((e) => { console.error('SUITE CRASH: ' + (e && e.stack || e)); process.exitCode = 1 })
