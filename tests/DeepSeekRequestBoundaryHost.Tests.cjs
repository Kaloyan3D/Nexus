'use strict'
// Real DSH 0.2.x host, mounted presets and scoped dispatch. The terminal
// records admission without handing a prompt or request to a provider.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { createBoundaryFixture, removeBoundaryFixture } = require('./lib/DeepSeekBoundaryFixture.cjs')

async function runHost(base, fault) {
  const fixture = await createBoundaryFixture(process.env.NEXUS_RUNTIME_ROOT, base, fault)
  try {
    console.log('DSH boundary fixture booted: ' + fixture.dshVersion)
    const records = await fullMatrix(fixture)
    assert.equal(records.length, 29, 'full request-boundary matrix executed')
    for (const { case: name, result } of records) {
      console.log('BOUNDARY CASE: ' + name + ' terminal=' + result.nextCount + ' code=' + (result.result?.code || 'none'))
    }
  } finally { await fixture.dispose() }
  assert.equal(fixture.outboundAttempts(), 0, 'DSH attempted an outbound connection')
}

function main(fault) {
  assert([undefined, 'startup', 'bypass'].includes(fault), 'unknown fixture fault')
  assert(process.env.NEXUS_RUNTIME_ROOT, 'NEXUS_RUNTIME_ROOT must name a composed DSH installation')
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nexus-boundary-'))
  let result
  try {
    result = spawnSync(process.execPath, [__filename, '--worker', base, ...(fault ? [fault] : [])],
      { stdio: 'inherit', windowsHide: true })
    assert.ifError(result.error)
  } finally {
    console.log('DSH boundary worker exited; removing the owned fixture')
    removeBoundaryFixture(base)
  }
  assert.equal(result.status, 0, 'boundary worker failed')
  console.log('PASS: actual host security matrix 29 cases; zero outbound socket attempts or provider dispatches')
  console.log('NEXUS SUITE COMPLETE: DeepSeekRequestBoundaryHost')
}

async function fullMatrix({ base, install, data, createSession, probe: dispatch, restart }) {
  await restart()
  const profiles = require(path.join(install, 'config/Engineering-Profiles.cjs'))
  const shadow = require(path.join(install, 'config/registry/shadow-binding.cjs'))
  const policy = require(path.join(install, 'config/registry/session-binding.cjs'))
  const probe = (sid, action, extra = {}) => dispatch(sid, action, extra)
  const read = file => JSON.parse(fs.readFileSync(file))
  const bindingFile = path.join(data, 'routing/session-bindings.json')
  const records = []
  async function prepare(engine, profile) {
    const sid = 'r75b1b-matrix-' + engine + '-' + crypto.randomUUID()
    const cwd = path.join(base, 'workspaces', engine)
    await createSession({ sessionId: sid, cwd, agentPreset: 'aih-' + engine })
    const result = await probe(sid, 'prepare', { profileId: profile }); assert(result.ok, JSON.stringify(result))
    return { sid, binding: read(bindingFile).bindings[sid] }
  }
  const deep = await prepare('deepseek', 'deepseek-codex')
  assert.match(deep.binding.taskInstanceId, /^task_[0-9a-f]{32}$/)
  const ledgerFile = path.join(deep.binding.workspace, '.ai-harness/state/tasks.json')
  let result = await probe(deep.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  result = await probe(deep.sid, 'guard-resolved')
  assert.equal(result.nextCount, 1); assert.equal(result.result.provider, 'flash-max-direct'); assert.equal(result.result.reasoningEffort, 'max')
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
  fs.mkdirSync(path.dirname(statusFile), { recursive: true })
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
    assert.equal(refused.nextCount, 0, 'persisted pending authority reached the request terminal'); assert.equal(refused.result.code, 'registry-pending')
    assert.deepEqual(fs.readFileSync(ledgerFile), ledger)
    records.push({ case: 'peer-preparation-preserves-newer-authority', peer, result: refused })
    current.bindings[deep.sid] = originalDoc.bindings[deep.sid]
    baseline = Buffer.from(JSON.stringify(current))
  } finally { fs.writeFileSync(bindingFile, baseline) }
  await denied('pending-after-prestep', () => pending('registry-pending'))
  const beforeWarmCheck = fs.readFileSync(ledgerFile)
  try {
    pending('registry-pending')
    const refreshed = await probe(deep.sid, 'arm')
    assert.equal(refreshed.nextCount, 0, 'warm pre-step must observe pending authority')
    assert.equal(refreshed.result.kind, 'reject')
    assert.deepEqual(fs.readFileSync(ledgerFile), beforeWarmCheck)
  } finally { fs.writeFileSync(bindingFile, baseline) }
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
  const host = process.platform === 'win32' ? 'powershell.exe' : path.join(install, 'runtime', 'pwsh', 'pwsh')
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScript, '-Action', 'begin-attempt', '-Workspace', deep.binding.workspace, '-TaskId', deep.binding.taskId, '-TaskInstanceId', deep.binding.taskInstanceId, '-SessionId', deep.sid, '-StartedByTurn', 'r75b1b-open-attempt-fixture']
  const attempt = JSON.parse(execFileSync(host, args, { encoding: 'utf8', timeout: 30000 }).replace(/^\uFEFF/, ''))
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
  await restart()
  await createSession({ sessionId: deep.sid, cwd: deep.binding.workspace, agentPreset: 'aih-deepseek' }, true)
  result = await probe(deep.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  await denied('pending-after-restart', () => pending('registry-pending'))
  const muse = await prepare('muse', 'muse-spark-1.3-contributor')
  const museTarget = installPin(muse)
  result = await probe(muse.sid, 'arm'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  result = await probe(muse.sid, 'guard-resolved'); assert.equal(result.nextCount, 1, JSON.stringify(result))
  assert.equal(result.result.provider, museTarget.provider); assert.equal(result.result.model, museTarget.model); assert.equal(result.result.reasoningEffort, museTarget.reasoning)
  records.push({ case: 'muse-valid-pin', result })
  return records
}

const [mode, base, fault] = process.argv.slice(2)
if (mode === '--worker') {
  // Flush the worker's output before exiting to release all host OS handles.
  runHost(base, fault).then(
    () => process.stdout.write('', () => process.exit(0)),
    error => process.stderr.write('FAIL: actual DeepSeek host boundary: ' + (error.stack || error) + '\n', () => process.exit(1)),
  )
} else {
  try { main(mode) }
  catch (error) {
    console.error('FAIL: actual DeepSeek host boundary: ' + (error.stack || error))
    process.exitCode = 1
  }
}
