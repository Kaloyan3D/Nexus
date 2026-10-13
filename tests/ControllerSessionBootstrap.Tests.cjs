'use strict'

// Real controller + PowerShell authorities + DSH session store, isolated from
// the installed application's data. No provider or agent is constructed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const controller = require('../config/AihController.cjs')
const profiles = require('../config/Engineering-Profiles.cjs')
const isolation = require('../config/Engineering-Isolation.cjs')
const museIsolation = require('../config/Muse-Isolation.cjs')
const { createPresetCtx } = require('./lib/AgentRequestComposition.cjs')
const repo = path.resolve(__dirname, '..')
let passed = 0
function pass(name) { passed++; console.log('PASS: ' + name) }
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value))

async function main() {
  const installed = process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local/share/nexus')
  const modules = path.join(installed, 'app/node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(path.join(modules, 'cordis/lib/index.js')))
  const { SessionStore } = await import(pathToFileURL(path.join(modules, 'dsh-session/lib/index.js')))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-session-bootstrap-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  fs.cpSync(path.join(repo, 'config'), path.join(root, 'config'), { recursive: true })
  fs.cpSync(path.join(repo, 'scripts'), path.join(root, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'data/settings.yaml'), 'engineering-profile: glm-codex\nllm-pi-ai:\n  providers:\n    opencode-go:\n      baseUrl: https://blocked.invalid\n      apiKeyEnv: BLOCKED\n    meta-model-api:\n      baseUrl: https://blocked.invalid\n      apiKeyEnv: BLOCKED\n')
  const savedEnv = { ...process.env }
  process.env.DSH_HOME = path.join(root, 'data')
  process.env.AIH_INSTALL_ROOT = root
  process.env.AIH_TOOLCHAIN_ROOT = installed
  process.env.AIH_PWSH_HOST ||= path.join(installed, 'runtime/pwsh/pwsh')
  delete process.env.DSH_AIH_PROFILE
  delete process.env.AIH_ACTIVE_PROFILE
  const bindingsFile = path.join(root, 'data/routing/session-bindings.json')
  const ledgerFile = path.join(workspace, '.ai-harness/state/tasks.json')
  const contexts = []
  let networkAttempts = 0
  const originalFetch = global.fetch
  const http = require('node:http'), https = require('node:https'), net = require('node:net')
  const savedNetwork = [http.request, https.request, net.Socket.prototype.connect]
  const blocked = () => { networkAttempts++; throw new Error('Provider/network transport blocked') }
  global.fetch = blocked
  http.request = https.request = net.Socket.prototype.connect = blocked
  function boot() {
    const ctx = new Context()
    new SessionStore(ctx)
    contexts.push(ctx)
    ctx.provide('shellEnv', { list() { return [] }, register() {} })
    const listeners = {}
    const seam = {
      get: (name) => ctx.get(name),
      provide: (name, value) => ctx.provide(name, value),
      shellEnv: ctx.get('shellEnv'),
      on(name, fn) { listeners[name] = fn; return ctx.on(name, fn) },
    }
    controller.apply(seam)
    assert.equal(ctx.get('nexusController'), undefined, 'preset controller must not publish a process-global service')
    return { ctx, api: { prepareSession: (request) => controller.prepareSession(ctx, request) }, preStep: listeners['agent/pre-step'] }
  }
  function session(host, id, preset = 'aih-muse') {
    return host.ctx.get('sessions').create(id, { meta: { cwd: workspace, agentPreset: preset } })
  }
  const request = (s, profileId = 'muse-spark-1.3-contributor-opencode') => ({ sessionId: s.id, cwd: workspace, preset: s.header.agentPreset, profileId })
  const bindingOf = (id) => read(bindingsFile).bindings[id]
  const stateOf = (id) => profiles.routingStatePath(root, bindingOf(id))
  const reject = async (api, req, label) => { await assert.rejects(api.prepareSession(req)); pass(label) }
  try {
    let host = boot()
    assert.equal(typeof host.api.prepareSession, 'function')
    await assert.rejects(controller.prepareSession(new Context(), {}), { code: 'session-prepare-unavailable' })
    pass('supported Cordis host extension is mounted without leaking a service; absent controller fails closed')
    if (process.env.NEXUS_BOOTSTRAP_LIVE_PROBE === '1') {
      // Final provider-blocked production call on a fresh real blank DSH session.
      const blank = session(host, 'live-' + crypto.randomUUID())
      const count = blank.events.length
      const authority = await host.api.prepareSession(request(blank))
      assert.equal(blank.events.length, count)
      assert.equal(networkAttempts, 0)
      console.log('LIVE_PROBE: ' + JSON.stringify({ ...authority, binding: bindingsFile, routingState: stateOf(blank.id), promptCalls: 0, providerNetworkAttempts: networkAttempts }))
      return
    }
    // Model another standing preset mount loaded before preparation.
    const warmListeners = {}
    controller.apply({
      get: (name) => host.ctx.get(name), shellEnv: host.ctx.get('shellEnv'),
      on(name, listener) { warmListeners[name] = listener },
    })
    const s = session(host, 'bootstrap-muse')
    assert.equal(fs.existsSync(bindingsFile), false)
    const eventsBefore = s.events.length
    const first = await host.api.prepareSession(request(s))
    assert.deepEqual(Object.keys(first).sort(), ['engine', 'model', 'profile', 'provider', 'sessionId', 'taskId', 'taskInstanceId'].sort())
    assert.equal(first.provider, 'opencode-go')
    assert.equal(first.model, 'muse-spark-1.3-contributor')
    assert.equal(first.engine, 'muse')
    assert.equal(read(ledgerFile).tasks[0].attempt, 0)
    assert.match(first.taskInstanceId, /^task_[0-9a-f]{32}$/)
    assert.equal(read(ledgerFile).tasks.length, 1)
    assert.equal(read(stateOf(s.id)).taskInstanceId, first.taskInstanceId)
    assert.equal(s.events.length, eventsBefore)
    assert.equal(networkAttempts, 0)
    pass('new session produces task/binding/routing authority without prompts, providers or counters')
    const warmTurn = await warmListeners['agent/pre-step']({ agent: { session: s }, step: 1, turn: 'warm-first', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the change' }] }] }, () => 'next')
    assert.equal(warmTurn, 'next')
    assert.equal(bindingOf(s.id).taskInstanceId, first.taskInstanceId)
    assert.equal(read(ledgerFile).tasks.length, 1)
    pass('already mounted controller reads prepared authority on first turn without rebinding')
    assert.deepEqual(await host.api.prepareSession(request(s)), first)
    const parallel = await Promise.all([host.api.prepareSession(request(s)), host.api.prepareSession(request(s))])
    assert.deepEqual(parallel, [first, first])
    assert.equal(read(ledgerFile).tasks.length, 1)
    pass('repeat and concurrent requests reuse exactly one task instance')
    await reject(host.api, { ...request(s), cwd: root }, 'wrong cwd rejected')
    await reject(host.api, { ...request(s), preset: 'aih-engineering' }, 'wrong engine rejected')
    await reject(host.api, request(s, 'muse-spark-1.3-contributor'), 'profile/provider drift rejected')
    await reject(host.api, { ...request(s), provider: 'fallback' }, 'caller cannot assert provider or introduce fallback')
    await reject(host.api, { ...request(s), taskId: 'TASK-9999' }, 'caller cannot assert task identity')
    const routePath = stateOf(s.id), state = read(routePath)
    for (const [field, value] of [['provider', 'fallback'], ['model', 'other'], ['engine', 'dual'], ['taskInstanceId', 'other'], ['profile', 'other'], ['executionClass', 'reviewer']]) {
      write(routePath, { ...state, [field]: value })
      await reject(host.api, request(s), 'conflicting routing ' + field + ' rejected')
    }
    write(routePath, state)
    const registryFile = path.join(root, 'config/model-registry.json')
    const originalRegistry = fs.readFileSync(registryFile, 'utf8')
    const registry = JSON.parse(originalRegistry)
    registry.models.find(model => model.id === 'muse-spark-1.3-contributor-opencode').model = 'drifted-model'
    write(registryFile, registry)
    await reject(host.api, request(s), 'configured model drift rejected without fallback')
    fs.writeFileSync(registryFile, originalRegistry)
    const doc = read(bindingsFile)
    doc.bindings[s.id].engine = 'dual'
    write(bindingsFile, doc)
    host = boot()
    const restored = session(host, s.id)
    await reject(host.api, request(restored), 'incompatible persisted binding rejected on restart')
    doc.bindings[s.id].engine = 'muse'
    const originalInstance = doc.bindings[s.id].taskInstanceId
    doc.bindings[s.id].taskInstanceId = 'task_' + '0'.repeat(32)
    write(bindingsFile, doc)
    host = boot()
    const incompatibleInstance = session(host, s.id)
    await reject(host.api, request(incompatibleInstance), 'incompatible task generation rejected without replacement')
    doc.bindings[s.id].taskInstanceId = originalInstance
    write(bindingsFile, doc)
    host = boot()
    const restarted = session(host, s.id)
    assert.deepEqual(await host.api.prepareSession(request(restarted)), first)
    pass('restart preserves prepared authority')
    const result = await host.preStep({ agent: { session: restarted }, step: 1, turn: 'first', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the change' }] }] }, () => 'next')
    assert.equal(result, 'next')
    assert.equal(bindingOf(s.id).taskInstanceId, first.taskInstanceId)
    assert.equal(read(ledgerFile).tasks.length, 1)
    pass('ordinary first pre-step after bootstrap reuses authority')
    // Crash window: allocation committed, no session-binding write survived.
    const crash = session(host, 'crash-before-binding')
    const crashFirst = await host.api.prepareSession(request(crash))
    const afterCrash = read(bindingsFile)
    delete afterCrash.bindings[crash.id]
    write(bindingsFile, afterCrash)
    const run = path.join(workspace, '.ai-harness/runs', crashFirst.taskId)
    fs.rmSync(path.join(run, 'manifest.json'))
    fs.rmSync(path.join(run, 'ccv2-authority.json'))
    host = boot()
    const crashRestored = session(host, crash.id)
    assert.deepEqual(await host.api.prepareSession(request(crashRestored)), crashFirst)
    assert.equal(read(ledgerFile).tasks.length, 2)
    assert.equal(read(path.join(run, 'ccv2-authority.json')).taskInstanceId, crashFirst.taskInstanceId)
    pass('crash before binding resumes allocation and repairs missing creation artifacts without duplicate instances')
    const incomplete = read(bindingsFile)
    incomplete.bindings[crash.id].needsRouteCheck = true
    write(bindingsFile, incomplete)
    fs.rmSync(stateOf(crash.id))
    host = boot()
    const resumed = session(host, crash.id)
    assert.deepEqual(await host.api.prepareSession(request(resumed)), crashFirst)
    pass('interrupted routing resumes same generation')
    const dual = session(host, 'lazy-normal', 'aih-engineering')
    const lazy = await host.preStep({ agent: { session: dual }, step: 1, turn: 'lazy', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the requested change' }] }] }, () => 'next')
    assert.equal(lazy, 'next')
    const normalBinding = bindingOf(dual.id)
    assert.equal(normalBinding.description, 'Implement the requested change')
    assert.equal(normalBinding.preparationAuthority, undefined)
    pass('ordinary lazy first-turn behavior remains unchanged')
    const reused = await host.api.prepareSession(request(dual, 'glm-codex'))
    assert.equal(reused.taskInstanceId, normalBinding.taskInstanceId)
    pass('compatible ordinary binding reused')
    const preparedDual = session(host, 'prepared-dual', 'aih-engineering')
    const dualAuthority = await host.api.prepareSession(request(preparedDual, 'deepseek-codex'))
    assert.equal(dualAuthority.provider, profiles.resolveTarget(root, 'deepseek-codex', 'primaryEngineer').provider)
    assert.equal(await host.preStep({ agent: { session: preparedDual }, step: 1, turn: 'prepared-dual', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement this change' }] }] }, () => 'next'), 'next')
    assert.equal(read(stateOf(preparedDual.id)).profile, 'deepseek-codex')
    const stepRecords = fs.readFileSync(path.join(workspace, '.ai-harness/runs', dualAuthority.taskId, 'step-routing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(stepRecords.at(-1).roleTarget.profileId, 'deepseek-codex')
    assert.equal(stepRecords.at(-1).roleTarget.provider, dualAuthority.provider)
    pass('prepared Dual first prompt uses exact session profile despite differing global preference')
    const writeFailureSession = session(host, 'binding-write-failure')
    const originalRename = fs.renameSync
    fs.renameSync = (from, to) => { if (to === bindingsFile) throw new Error('Injected binding commit failure'); return originalRename(from, to) }
    try { await assert.rejects(host.api.prepareSession(request(writeFailureSession)), /Injected binding commit failure/) }
    finally { fs.renameSync = originalRename }
    const allocated = read(ledgerFile).tasks.at(-1).taskInstanceId
    host = boot()
    const retried = session(host, writeFailureSession.id)
    assert.equal((await host.api.prepareSession(request(retried))).taskInstanceId, allocated)
    pass('binding durability failure rejects and restart retry resumes same allocation')
    const killedSessionId = 'killed-before-binding'
    const childSource = `
      const fs = require('node:fs');
      (async () => {
        const { Context } = await import(${JSON.stringify(pathToFileURL(path.join(modules, 'cordis/lib/index.js')).href)});
        const { SessionStore } = await import(${JSON.stringify(pathToFileURL(path.join(modules, 'dsh-session/lib/index.js')).href)});
        const ctx = new Context(); new SessionStore(ctx); ctx.provide('shellEnv', { list() { return [] }, register() {} });
        const session = ctx.get('sessions').create(${JSON.stringify(killedSessionId)}, { meta: { cwd: ${JSON.stringify(workspace)}, agentPreset: 'aih-muse' } });
        require(${JSON.stringify(path.join(repo, 'config/AihController.cjs'))}).apply(ctx);
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => { if (to === ${JSON.stringify(bindingsFile)}) process.exit(77); return rename(from, to) };
        await require(${JSON.stringify(path.join(repo, 'config/AihController.cjs'))}).prepareSession(ctx, { sessionId: session.id, cwd: session.header.cwd, preset: 'aih-muse', profileId: 'muse-spark-1.3-contributor-opencode' });
        process.exit(1);
      })().catch(error => { console.error(error); process.exit(2) });
    `
    const killed = require('node:child_process').spawnSync(process.execPath, ['-e', childSource], { env: process.env, encoding: 'utf8', timeout: 120000 })
    assert.equal(killed.status, 77, killed.stderr)
    const killedInstance = read(ledgerFile).tasks.at(-1).taskInstanceId
    host = boot()
    const killedRestored = session(host, killedSessionId)
    assert.equal((await host.api.prepareSession(request(killedRestored))).taskInstanceId, killedInstance)
    assert.equal(read(ledgerFile).tasks.filter(task => task.taskInstanceId === killedInstance).length, 1)
    pass('actual creator process exit before binding commit restarts with one original task instance')
    const deep = session(host, 'deepseek', 'aih-deepseek')
    const deepAuthority = await host.api.prepareSession(request(deep, 'deepseek-codex'))
    assert.equal(deepAuthority.provider, profiles.resolveTarget(root, 'deepseek-codex', 'primaryEngineer').provider)
    assert.equal(deepAuthority.model, 'deepseek-v4-flash')
    await reject(host.api, request(deep, 'glm-codex'), 'DeepSeek locked profile cannot drift')
    pass('DeepSeek target selection remains exact')
    // Exercise unchanged enforcement plugins on their real prepared files.
    for (const [s2, plugin, expected] of [[deep, isolation, deepAuthority], [resumed, museIsolation, crashFirst]]) {
      const isolationCtx = createPresetCtx()
      plugin.apply(isolationCtx)
      const response = await isolationCtx.handlers['agent/request']({ agent: { session: s2 }, step: 1, turn: 'isolation' }, () => ({ provider: 'untrusted', model: 'untrusted' }))
      assert.equal(response.provider, expected.provider)
      assert.equal(response.model, expected.model)
    }
    pass('Engineering-Isolation and Muse-Isolation accept prepared authority exactly')
    assert.equal(networkAttempts, 0)
    pass('all preparation and enforcement probes made zero network attempts')
    const diagnostics = fs.readFileSync(path.join(root, 'data/logs/aih-controller.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((row) => row.event === 'nexus-session-prepared')
    assert.ok(diagnostics.some((row) => row.status === 'new'))
    assert.ok(diagnostics.some((row) => row.status === 'reused'))
    assert.ok(diagnostics.every((row) => !('description' in row) && !('prompt' in row)))
    pass('durable diagnostic is content-free and distinguishes new/reused')
    console.log('RESULT: ' + passed + ' bootstrap checks passed.')
  } finally {
    global.fetch = originalFetch
    ;[http.request, https.request, net.Socket.prototype.connect] = savedNetwork
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)

    for (const ctx of contexts) await ctx.fiber.dispose()
    if (process.env.NEXUS_BOOTSTRAP_KEEP_PROBE !== '1') fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
