'use strict'
// Explicit disposable actual-host integration. The HTTP overlay only invokes
// production scoped middleware and stops at a terminal, never provider I/O.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
async function main() {
  const fixture = process.env.NEXUS_BOUNDARY_FIXTURE_ROOT
  if (!fixture) { console.log('SKIP: disposable actual DSH host required (NEXUS_BOUNDARY_FIXTURE_ROOT)'); return }
  const base = fs.realpathSync(fixture)
  assert.match(base, /\/tmp\/r75b1b$/)
  const install = path.join(base, 'source/tmp/install'), data = path.join(install, 'data')
  const state = JSON.parse(fs.readFileSync(path.join(base, 'evidence/supervisor-state.json')))
  assert.equal(state.installRoot, install); assert.equal(state.flag, 'unset')
  assert(!state.routeTable.split('\n').slice(1).some(line => line.trim()))
  const url = 'http://127.0.0.1:43081'
  const deadline = Date.now() + 120000
  while (true) {
    try {
      const response = await fetch(url + '/nexus/registry/v1/modes')
      if (response.ok) break
    } catch {}
    assert(Date.now() < deadline, 'owned host readiness deadline')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await restart(base) // reset only test-owned caches after a previous fault-injection run
  const sid = 'r75b1b-boundary-' + crypto.randomUUID()
  async function call(endpoint, body) {
    const response = await fetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(body) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  async function rpc(method, payload) {
    const v = await call('/api/' + method, { type: 'client-request', rpcId: crypto.randomUUID(), method, payload })
    assert.equal(v.result.ok, true, JSON.stringify(v)); return v.result.value
  }
  const probe = (action, extra = {}) => call('/__r75b1b/preflight', { sessionId: sid, action, ...extra })
  await rpc('session.create', { sessionId: sid, cwd: path.join(base, 'workspaces/boundary'), agentPreset: 'aih-deepseek' })
  const prepared = await probe('prepare', { profileId: 'deepseek-codex' }); assert.equal(prepared.ok, true)
  const bindingFile = path.join(data, 'routing/session-bindings.json')
  const original = fs.readFileSync(bindingFile)
  const doc = JSON.parse(original), binding = doc.bindings[sid]
  assert.match(binding.taskInstanceId, /^task_[0-9a-f]{32}$/)
  const ledgerFile = path.join(binding.workspace, '.ai-harness/state/tasks.json')
  const ledger = fs.readFileSync(ledgerFile)
  const before = await probe('arm'); assert.equal(before.nextCount, 1, JSON.stringify(before))
  const outputs = []
  try {
    binding.registryRefused = { code: 'registry-pending', generation: { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId }, reasons: [], atUtc: new Date().toISOString() }
    fs.writeFileSync(bindingFile, JSON.stringify(doc))
    const result = await probe('guard'); outputs.push(result)
    if (process.argv.includes('--expect-bypass')) {
      assert.equal(result.nextCount, 1); assert.equal(result.result.code, 'preflight-terminal-sentinel')
      console.log('REPRODUCED: persisted pending authority reaches downstream in actual DeepSeek composition')
    } else {
      assert.equal(result.nextCount, 0, JSON.stringify(result)); assert.equal(result.result.code, 'registry-pending')
      const worker = await probe('guard', { worker: true }); outputs.push(worker)
      assert.equal(worker.nextCount, 0); assert.equal(worker.result.code, 'registry-pending')
      const refreshed = await probe('arm'); outputs.push(refreshed)
      assert.equal(refreshed.nextCount, 0); assert.equal(refreshed.result.kind, 'reject')
      console.log('PASS: actual scoped DeepSeek request and warm controller observe durable pending authority; worker header cannot bypass')
    }
    assert.deepEqual(fs.readFileSync(ledgerFile), ledger, 'guard must not start an attempt or modify generations')
  } finally { fs.writeFileSync(bindingFile, original) }
  fs.writeFileSync(path.join(base, 'evidence', process.argv.includes('--expect-bypass') ? 'before-security-regression.json' : 'after-security-regression.json'), JSON.stringify({ sid, binding: prepared.result, before, outputs, attemptsUnchanged: true, providerDispatches: 0 }, null, 2))
  if (!process.argv.includes('--expect-bypass')) await fullMatrix({ base, install, data, call, rpc })
}

async function restart(base) {
  const file = path.join(base, 'evidence/supervisor-state.json')
  const old = JSON.parse(fs.readFileSync(file)).boot
  fs.writeFileSync(path.join(base, 'evidence/control.json'), JSON.stringify({ action: 'restart' }))
  const deadline = Date.now() + 120000
  while (true) {
    if (JSON.parse(fs.readFileSync(file)).boot > old) {
      try {
        const res = await fetch('http://127.0.0.1:43081/nexus/registry/v1/modes')
        if (res.ok) {
          const host = await fetch('http://127.0.0.1:43081/api/host.describe', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:43081' }, body: JSON.stringify({ type: 'client-request', rpcId: 'readiness', method: 'host.describe', payload: {} }) })
          const hook = await fetch('http://127.0.0.1:43081/__r75b1b/preflight')
          if (host.ok && (await host.json()).result.ok && hook.status === 405) return
        }
      } catch {}
    }
    assert(Date.now() < deadline, 'owned restart readiness deadline')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
async function fullMatrix({ base, install, data, call, rpc }) {
  await restart(base)
  const profiles = require(path.join(install, 'config/Engineering-Profiles.cjs'))
  const shadow = require(path.join(install, 'config/registry/shadow-binding.cjs'))
  const policy = require(path.join(install, 'config/registry/session-binding.cjs'))
  const probe = (sid, action, extra = {}) => call('/__r75b1b/preflight', { sessionId: sid, action, ...extra })
  const read = file => JSON.parse(fs.readFileSync(file))
  const bindingFile = path.join(data, 'routing/session-bindings.json')
  const records = []
  async function prepare(engine, profile) {
    const sid = 'r75b1b-matrix-' + engine + '-' + crypto.randomUUID()
    const cwd = path.join(base, 'workspaces', engine)
    await rpc('session.create', { sessionId: sid, cwd, agentPreset: 'aih-' + engine })
    const result = await probe(sid, 'prepare', { profileId: profile }); assert(result.ok, JSON.stringify(result))
    return { sid, binding: read(bindingFile).bindings[sid] }
  }
  const deep = await prepare('deepseek', 'deepseek-codex')
  const ledgerFile = path.join(deep.binding.workspace, '.ai-harness/state/tasks.json')
  let result = await probe(deep.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  result = await probe(deep.sid, 'guard-resolved')
  assert.equal(result.nextCount, 1); assert.equal(result.result.provider, 'flash-max-direct'); assert.equal(result.result.reasoningEffort, 'high')
  records.push({ case: 'genuine-legacy', result })
  function installPin(f) {
    const doc = read(bindingFile), binding = doc.bindings[f.sid]
    const state = read(profiles.routingStatePath(install, binding))
    const diagnostic = shadow.runShadowComparison({ ...state, writable: true }, { installRoot: install, dataRoot: data })
    const evaluated = policy.evaluateRegistryBinding(state, diagnostic, { bindTask: binding })
    assert(evaluated.ok, JSON.stringify({ evaluated, diagnostic }))
    binding.registryPin = evaluated.pin; binding.bindingAuthority = 'registry'; delete binding.registryRefused
    fs.writeFileSync(bindingFile, JSON.stringify(doc))
    return state
  }
  const target = installPin(deep)
  result = await probe(deep.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  result = await probe(deep.sid, 'guard-resolved'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  assert.equal(result.result.provider, target.provider); assert.equal(result.result.model, target.model); assert.equal(result.result.reasoningEffort, target.reasoning)
  records.push({ case: 'valid-pin', result })
  let baseline = fs.readFileSync(bindingFile)
  const originalDoc = JSON.parse(baseline)
  const routingFile = profiles.routingStatePath(install, originalDoc.bindings[deep.sid])
  const routing = fs.readFileSync(routingFile)
  const statusFile = path.join(data, 'registry/connection-status.json')
  const statuses = fs.existsSync(statusFile) ? fs.readFileSync(statusFile) : null
  const taskScript = path.join(install, 'scripts/Task.ps1')
  const taskBytes = fs.readFileSync(taskScript)
  const clone = () => JSON.parse(baseline)
  const pending = code => {
    const doc = clone(), binding = doc.bindings[deep.sid]
    delete binding.registryPin; delete binding.bindingAuthority
    binding.registryRefused = { code, generation: { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId }, reasons: [], atUtc: new Date().toISOString() }
    fs.writeFileSync(bindingFile, JSON.stringify(doc))
  }
  async function denied(name, change, extra = {}, expectedCode = null) {
    const ledger = fs.readFileSync(ledgerFile)
    try {
      change()
      const injectedLedger = fs.readFileSync(ledgerFile)
      const result = await probe(deep.sid, 'guard-resolved', extra)
      assert.equal(result.nextCount, 0, JSON.stringify({ name, result }))
      assert(result.result.refused && typeof result.result.code === 'string', JSON.stringify(result))
      if (expectedCode) assert.equal(result.result.code, expectedCode)
      assert(!['preflight-terminal-sentinel'].includes(result.result.code))
      assert.deepEqual(fs.readFileSync(ledgerFile), injectedLedger, 'guard must not modify injected ledger: ' + name)
      records.push({ case: name, result })
      console.log('PASS: actual DeepSeek denial ' + name + ' / ' + result.result.code)
    } finally {
      fs.writeFileSync(bindingFile, baseline); fs.writeFileSync(routingFile, routing)
      if (statuses) fs.writeFileSync(statusFile, statuses); else fs.rmSync(statusFile, { force: true })
      fs.writeFileSync(ledgerFile, ledger)
      if (!fs.existsSync(taskScript)) fs.writeFileSync(taskScript, taskBytes)
    }
  }
  // Another preparation on the same standing mount must not resurrect its
  // old cached pin over a newer durable refusal belonging to this task.
  try {
    pending('registry-pending')
    const peer = await prepare('deepseek', 'deepseek-codex')
    const current = read(bindingFile)
    assert.equal(current.bindings[deep.sid].registryRefused.code, 'registry-pending')
    assert(!current.bindings[deep.sid].registryPin)
    const ledger = fs.readFileSync(ledgerFile)
    const refused = await probe(deep.sid, 'guard-resolved')
    assert.equal(refused.nextCount, 0); assert.equal(refused.result.code, 'registry-pending')
    assert.deepEqual(fs.readFileSync(ledgerFile), ledger)
    records.push({ case: 'peer-preparation-preserves-newer-authority', peer, result: refused })
    current.bindings[deep.sid] = originalDoc.bindings[deep.sid]
    baseline = Buffer.from(JSON.stringify(current))
  } finally { fs.writeFileSync(bindingFile, baseline) }
  await denied('pending-after-prestep', () => pending('registry-pending'))
  await denied('pinned-refusal-conflict', () => { const doc = clone(), binding = doc.bindings[deep.sid]; binding.registryRefused = { code: 'registry-pending', generation: { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId }, reasons: [], atUtc: new Date().toISOString() }; fs.writeFileSync(bindingFile, JSON.stringify(doc)) }, {}, 'registry-authority-unverifiable')
  await denied('refused', () => pending('registry-binding-mismatch'))
  await denied('missing-session-header', () => pending('registry-pending'), { noHeader: true }, 'engine-binding-violation')
  await denied('worker-marked-parent', () => pending('registry-pending'), { worker: true })
  await denied('corrupt-document', () => fs.writeFileSync(bindingFile, '{corrupt'))
  await denied('malformed-entry', () => { const doc = clone(); doc.bindings[deep.sid] = null; fs.writeFileSync(bindingFile, JSON.stringify(doc)) })
  await denied('missing-binding', () => { const doc = clone(); delete doc.bindings[deep.sid]; fs.writeFileSync(bindingFile, JSON.stringify(doc)) })
  await denied('removed-authority', () => { const doc = clone(); delete doc.bindings[deep.sid].registryPin; delete doc.bindings[deep.sid].bindingAuthority; fs.writeFileSync(bindingFile, JSON.stringify(doc)) })
  await denied('malformed-pin-authority', () => { const doc = clone(); doc.bindings[deep.sid].registryPin.authority = 'unknown'; fs.writeFileSync(bindingFile, JSON.stringify(doc)) }, {}, 'registry-pin-mismatch')
  await denied('pin-engine-mismatch', () => { const doc = clone(); doc.bindings[deep.sid].registryPin.engine = 'muse'; fs.writeFileSync(bindingFile, JSON.stringify(doc)) }, {}, 'registry-pin-mismatch')
  await denied('task-bound-engine-mismatch', () => { const doc = read(ledgerFile); doc.tasks.find(t => t.taskInstanceId === deep.binding.taskInstanceId).boundEngine = 'muse'; fs.writeFileSync(ledgerFile, JSON.stringify(doc)) }, {}, 'engine-binding-violation')
  await denied('role-unpinned', () => { const state = JSON.parse(routing); state.role = 'unmapped-role'; fs.writeFileSync(routingFile, JSON.stringify(state)) }, {}, 'registry-role-unpinned')
  await denied('invalid-generation', () => { const doc = clone(); doc.bindings[deep.sid].registryPin.taskInstanceId = 'task_' + 'f'.repeat(32); fs.writeFileSync(bindingFile, JSON.stringify(doc)) })
  for (const field of ['provider', 'model', 'reasoning']) await denied('changed-' + field, () => { const state = JSON.parse(routing); state[field] = field === 'provider' ? 'flash-max-direct' : 'different'; fs.writeFileSync(routingFile, JSON.stringify(state)) })
  const connection = originalDoc.bindings[deep.sid].registryPin.roleTarget.connectionId
  for (const status of ['revoked', 'unknown', 'not-connected']) await denied('connection-' + status, () => fs.writeFileSync(statusFile, JSON.stringify({ schemaVersion: 1, statuses: { [connection]: { status, updatedAtUtc: new Date().toISOString() } } })), {}, status === 'revoked' ? 'registry-authorization-revoked' : 'registry-authorization-unavailable')
  await denied('unverifiable-task-identity', () => fs.unlinkSync(taskScript))
  const { execFileSync } = require('node:child_process')
  const args = ['Task.ps1', '-Action', 'begin-attempt', '-Workspace', deep.binding.workspace, '-TaskId', deep.binding.taskId, '-TaskInstanceId', deep.binding.taskInstanceId, '-SessionId', deep.sid, '-StartedByTurn', 'r75b1b-open-attempt-fixture']
  const attempt = JSON.parse(execFileSync('/usr/bin/python', [path.join(base, 'fixture-cli.py'), JSON.stringify(args)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }))
  assert.equal(attempt.taskInstanceId, deep.binding.taskInstanceId)
  await denied('open-attempt-pending', () => pending('registry-pending'))
  result = await probe(deep.sid, 'guard-resolved'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  records.push({ case: 'open-attempt-valid-pin', result })
  const pinnedDoc = fs.readFileSync(bindingFile)
  try {
    pending('registry-pending')
    const refusal = await probe(deep.sid, 'guard-resolved'); assert.equal(refusal.nextCount, 0)
    const transition = await probe(deep.sid, 'prestep')
    const persisted = read(bindingFile).bindings[deep.sid]
    assert.equal(persisted.bindingAuthority, 'legacy-rollback', JSON.stringify(transition))
    assert.equal(persisted.taskInstanceId, deep.binding.taskInstanceId)
    result = await probe(deep.sid, 'guard-resolved'); assert.equal(result.nextCount, 1, JSON.stringify(result))
    records.push({ case: 'explicit-controller-rollback', transition, persisted, result })
  } finally { fs.writeFileSync(bindingFile, pinnedDoc) }
  await restart(base)
  await rpc('session.create', { sessionId: deep.sid, cwd: deep.binding.workspace, agentPreset: 'aih-deepseek' })
  result = await probe(deep.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  await denied('pending-after-restart', () => pending('registry-pending'))
  const muse = await prepare('muse', 'muse-spark-1.3-contributor')
  const museTarget = installPin(muse)
  result = await probe(muse.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  result = await probe(muse.sid, 'guard-resolved'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  assert.equal(result.result.provider, museTarget.provider); assert.equal(result.result.model, museTarget.model); assert.equal(result.result.reasoningEffort, museTarget.reasoning)
  records.push({ case: 'muse-valid-pin', result })
  fs.writeFileSync(path.join(base, 'evidence/security-matrix.json'), JSON.stringify({ records, defaultFlagOff: true, providerDispatches: 0, realTaskControllerOpenAttempt: attempt }, null, 2))
  console.log('PASS: actual host security matrix ' + records.length + ' cases; zero provider dispatches')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
