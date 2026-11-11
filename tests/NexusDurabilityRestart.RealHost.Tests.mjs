// P2-B2C real-host proof (child DSH hosts, real Nexus composition, real
// PowerShell controller scripts, real IPC + `nexus` CLI, synthetic local model
// transport, blocked egress, placeholder credential).
//
// Part C (both modes) — historical broken-session holds:
//   latent  : a pre-P2-B2C Controller notice before any system message;
//   retired : a stored notice with the retired `plugin` source kind.
//   Both are held with typed reasons, never executed, files untouched; a valid
//   session in the same host keeps working.
// Part B (NEXUS_TEST_GATEWAY=patched, PoC gateway build) — managed CLI tasks
//   (EMv1 Dual, EMv2 Muse) across a complete host restart: registry and
//   tombstones restored before remote mutation, exact session cold-read and
//   valid, same identities/attempts/status via CLI, no duplicate prompt,
//   attempt or model request; interrupted execution reconciled to an explicit
//   hold without replay; a deleted intake record never releases its session.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.env.NEXUS_TEST_GATEWAY || 'production'
const node = process.execPath
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-durability-restart-'))
const installRoot = path.join(scratch, 'install')
fs.mkdirSync(installRoot)
for (const entry of fs.readdirSync(root)) if (entry !== 'data') fs.symlinkSync(path.join(root, entry), path.join(installRoot, entry))
const dataRoot = path.join(installRoot, 'data')
fs.mkdirSync(dataRoot)
for (const name of fs.readdirSync(path.join(root, 'data'))) {
  if (['sessions', 'logs', 'aih-state.json', 'routing', 'nexus'].includes(name)) continue
  fs.cpSync(path.join(root, 'data', name), path.join(dataRoot, name), { recursive: true })
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
function makeRepo(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, name + '-')))
  git(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n'); git(dir, 'add', '.'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'init')
  return dir
}
const env = { ...process.env, DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: path.join(root, 'app'), AIH_PWSH_HOST: path.join(root, 'runtime', 'pwsh', 'pwsh'), DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
delete env.NEXUS_IPC
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = { mode, platform: process.platform, arch: process.arch, holds: {}, managed: {} }
const settingsFile = path.join(dataRoot, 'nexus-settings.yaml')
const originalSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null
const setPreference = (profile) => { if (originalSettings !== null) fs.writeFileSync(settingsFile, profile === null ? originalSettings : originalSettings.replace(/^engineering-profile:.*$/m, 'engineering-profile: ' + profile)) }

function startHost(extraEnv = {}) {
  const child = spawn(node, [path.join(root, 'tests', 'lib', 'NexusManagedHost.mjs')], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []; const waiters = []; let stderr = ''; let out = ''
  child.stdout.on('data', (chunk) => {
    out += chunk
    let index
    while ((index = out.indexOf('\n')) >= 0) { const line = out.slice(0, index); out = out.slice(index + 1); try { lines.push(JSON.parse(line)) } catch { continue } for (const w of waiters.splice(0)) w() }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  async function next(predicate, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = lines.findIndex(predicate)
      if (index >= 0) return lines.splice(index, 1)[0]
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) throw new Error('host message timeout/exit; stderr: ' + stderr.slice(-1500))
      await Promise.race([new Promise((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 200))])
    }
  }
  const send = (line) => child.stdin.write(line + '\n')
  return {
    next, send, exited,
    async inspect(id) { send('inspect ' + id); return next((m) => m.type === 'inspect' && m.sessionId === id) },
    async report() { send('report'); return next((m) => m.type === 'report') },
    async inject(kind, id) { send('inject ' + kind + ' ' + id); return next((m) => m.type === 'injected' && m.sessionId === id) },
    async stop() { if (child.exitCode === null && child.signalCode === null) { send('exit'); await exited } },
    async kill() { child.kill('SIGKILL'); await exited },
    get stderr() { return stderr },
  }
}

async function ownerClient(ready) {
  const base = `http://127.0.0.1:${ready.port}/`
  const minted = await fetch(ready.authUrl, { redirect: 'manual' })
  const cookie = (minted.headers.get('set-cookie') || '').split(';')[0]
  const headers = { 'content-type': 'application/json', cookie, origin: base.slice(0, -1) }
  return {
    async api(endpoint, args) {
      const response = await fetch(base + 'api/' + endpoint, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args: { request: args } } }) })
      const body = await response.json().catch(() => ({}))
      const result = body && body.result
      return { ok: Boolean(result && result.ok), code: result && result.error ? result.error.code : null, reason: result && result.error && result.error.details ? result.error.details.reason : null, message: result && result.error ? result.error.message : null, value: result && result.value }
    },
  }
}

/** The real `nexus` CLI against this isolated install (argument array, no shell). */
function nexus(args, stdin = '') {
  return new Promise((resolve) => {
    const cli = path.join(installRoot, 'scripts', 'nexus-cli.cjs')
    const code = `const cli=require(${JSON.stringify(cli)});cli.run(process.argv.slice(1),{installRoot:${JSON.stringify(installRoot)},dataRoot:${JSON.stringify(dataRoot)},cwd:process.cwd(),stdout:(t)=>process.stdout.write(t),stderr:(t)=>process.stderr.write(t),readStdin:()=>Buffer.from(${JSON.stringify(stdin)})}).then((c)=>{process.exitCode=c})`
    const child = spawn(node, ['-e', code, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('exit', (exit) => { clearTimeout(timer); let json = null; try { json = JSON.parse(stdout) } catch { /* human */ } resolve({ code: exit, json, stdout, stderr }) })
  })
}

const waitFor = async (fn, label, timeoutMs = 90000) => { const deadline = Date.now() + timeoutMs; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error('timeout: ' + label); await new Promise((r) => setTimeout(r, 300)) } }
const readBindings = () => { try { return JSON.parse(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), 'utf8')).bindings || {} } catch { return {} } }
const ledgerTasks = (ws) => { try { return JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks || [] } catch { return [] } }
const attemptsOf = (ws, displayId) => { try { return fs.readFileSync(path.join(ws, '.ai-harness', 'runs', displayId, 'attempts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }
function sessionFiles(sessionId) {
  const found = []
  const walk = (dir) => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (path.basename(path.dirname(f)) === sessionId && e.name.startsWith('session.')) found.push(f) } }
  walk(path.join(dataRoot, 'sessions'))
  return found.sort()
}
const digestFiles = (files) => crypto.createHash('sha256').update(files.map((f) => f + '\0' + fs.readFileSync(f).toString('base64')).join('\0')).digest('hex')
function audit() {
  try { return JSON.parse(execFileSync(node, [path.join(root, 'scripts', 'NexusSessionAudit.cjs'), '--data', dataRoot, '--app', path.join(root, 'app'), '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) } catch (error) { return JSON.parse(String(error.stdout)) }
}
// Reproduce a historical (pre-P2-B2C) stored log: append one surface Controller
// notice with the retired `plugin` source kind to a STOPPED test session's
// durable log, as older Nexus/DSH builds left it. Current DSH refuses such an
// append on a live session, so stored logs are the only place it exists.
async function appendRetiredOnDisk(sessionId) {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const zlib = req('node:zlib')
  const { rawRows } = req(path.join(root, 'scripts', 'NexusSessionAudit.cjs'))
  const file = sessionFiles(sessionId).find((f) => /session\.v4\.jsonl(\.zstd)?$/.test(f))
  const rows = rawRows(file)
  const seq = Math.max(...rows.events.map((e) => e.seq)) + 1
  const event = { type: 'user/message', seq, time: Date.now(), data: { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: 'Controller: legacy notice (retired kind)' }], source: { kind: 'plugin', plugin: 'aih-controller', form: 'notice' } }, surfaceOp: 'append' }
  const line = Buffer.from(JSON.stringify(event) + '\n')
  fs.appendFileSync(file, file.endsWith('.zstd') ? zlib.zstdCompressSync(line) : line)
  return seq
}
const intakeFiles = () => { const dir = path.join(dataRoot, 'nexus', 'intake'); return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)) : [] }
const identityLines = () => { const file = path.join(dataRoot, 'nexus', 'managed-identities.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] }

let host = null
let exitCode = 0
try {
  host = startHost()
  let ready = await host.next((m) => m.type === 'ready')
  assert.equal(ready.ownership, 'held')
  let owner = await ownerClient(ready)
  const workspace = makeRepo('ws')
  const added = await nexus(['workspace', 'add', '--path', workspace, '--json'])
  assert.equal(added.code, 0, 'CLI workspace add: ' + added.stdout + added.stderr)
  const workspaceId = added.json.data.workspaceId

  // ── Part C: historical broken sessions are held ─────────────────────────
  const mk = async () => { const r = await owner.api('session/create', { workspaceId, agentPreset: 'aih-muse' }); assert.equal(r.ok, true, JSON.stringify(r)); return r.value.sessionId }
  const prompt = (id, text) => owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text }] })
  // Valid reference session (first turn through the normal path).
  const valid = await mk()
  await prompt(valid, 'Valid session first turn.')
  await waitFor(async () => (await host.inspect(valid)).turnEnds.length >= 1, 'valid first turn')
  // Latent: an old-style notice before any system message.
  const latent = await mk()
  const injectedLatent = await host.inject('latent', latent)
  assert.equal(injectedLatent.ok, true, JSON.stringify(injectedLatent))
  await prompt(latent, 'This must not run.')
  const latentAfter = await waitFor(async () => { const r = await host.inspect(latent); return r.turnEnds.length >= 1 ? r : null }, 'latent turn end')
  assert.equal(latentAfter.turnEnds[0], 'blocked', 'the latent session\'s turn is refused')
  assert.equal(latentAfter.llmCalls, 0, 'no model request for a held session')
  assert.equal(latentAfter.firstSurface.type, 'user/message'); assert.ok(!latentAfter.surfaceOrder.some((s) => s.includes('system/message')), 'no system message was appended: the history was not corrupted')
  assert.equal(latentAfter.readable, true, 'the held latent session stays readable')
  const latentCheck = await nexus(['session', 'check', latent, '--json'])
  assert.equal(latentCheck.code, 7, latentCheck.stdout + latentCheck.stderr); assert.equal(latentCheck.json.data.reason, 'session-history-notice-before-head-pending'); assert.equal(latentCheck.json.data.repair, 'not-repairable-losslessly')
  // Retired kind: stored notice with `plugin` source after the head.
  const retired = await mk()
  await prompt(retired, 'Retired-kind session first turn.')
  await waitFor(async () => (await host.inspect(retired)).turnEnds.length >= 1, 'retired first turn')
  const refusedLive = await host.inject('retired', retired)
  assert.equal(refusedLive.ok, false, 'current DSH refuses a retired source kind on live append')
  assert.equal((await nexus(['session', 'check', valid, '--json'])).json.data.state, 'healthy', 'a valid session checks healthy')
  await host.stop()
  await appendRetiredOnDisk(retired)
  const auditAfter = audit()
  const auditOf = (id) => auditAfter.sessions.find((s) => s.sessionId === id)
  assert.equal(auditOf(valid).class, 'valid'); assert.equal(auditOf(latent).class, 'latent-notice-before-head'); assert.equal(auditOf(retired).class, 'invalid-retired-source-kind')
  assert.equal(auditOf(retired).holdReason, 'session-history-retired-source-kind')
  const retiredDigest = digestFiles(sessionFiles(retired)); const latentDigest = digestFiles(sessionFiles(latent))

  host = startHost()
  ready = await host.next((m) => m.type === 'ready')
  owner = await ownerClient(ready)
  const retiredCheck = await nexus(['session', 'check', retired, '--json'])
  assert.equal(retiredCheck.code, 7); assert.equal(retiredCheck.json.data.state, 'held'); assert.equal(retiredCheck.json.data.reason, 'session-history-retired-source-kind'); assert.equal(retiredCheck.json.data.source, 'durable')
  const retiredPrompt = await prompt(retired, 'Must not run after restart.')
  await new Promise((r) => setTimeout(r, 2500))
  const retiredInspect = await host.inspect(retired)
  assert.equal(retiredInspect.llmCalls, 0, 'no model request for a session DSH cannot restore')
  assert.equal(retiredInspect.readable, false)
  const latentPrompt = await prompt(latent, 'Still must not run.')
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal((await host.inspect(latent)).llmCalls, 0)
  assert.equal(digestFiles(sessionFiles(retired)), retiredDigest, 'the retired-kind history files are byte-identical (never rewritten)')
  const latentNow = await host.inspect(latent)
  assert.ok(!latentNow.surfaceOrder.some((s) => s.includes('system/message')), 'the latent history is still uncorrupted')
  const validTurn = await prompt(valid, 'Valid session second turn after restart.')
  assert.equal(validTurn.ok, true)
  const validAfter = await waitFor(async () => { const r = await host.inspect(valid); return r.turnEnds.length >= 2 ? r : null }, 'valid second turn')
  assert.equal(validAfter.llmCalls, 1, 'valid historical sessions keep working')
  evidence.holds = { latent: { check: latentCheck.json.data, audit: auditOf(latent).class, digestBefore: latentDigest, promptAfterRestart: { ok: latentPrompt.ok, code: latentPrompt.code } }, retired: { check: retiredCheck.json.data, audit: auditOf(retired).class, dshError: auditOf(retired).dshError, filesUnchanged: true, promptAfterRestart: { ok: retiredPrompt.ok, code: retiredPrompt.code, message: retiredPrompt.message && retiredPrompt.message.slice(0, 200) } }, valid: { audit: auditOf(valid).class, secondTurnModelCalls: validAfter.llmCalls } }
  pass('historical holds: latent (notice before head) refused with a typed reason and never corrupted; retired-kind history held after restart (typed, durable), files byte-identical, no model call; valid sessions unaffected')

  // ── Part D: tool-call/result pairing next to first-turn notices, across restart ──
  await host.stop()
  host = startHost({ NEXUS_TEST_TOOL_CALL: '1' })
  ready = await host.next((m) => m.type === 'ready')
  owner = await ownerClient(ready)
  const tooled = await mk()
  await prompt(tooled, 'First turn with a tool call.')
  const toolTurn = await waitFor(async () => { const r = await host.inspect(tooled); return r.turnEnds.length >= 1 ? r : null }, 'tool turn')
  assert.equal(toolTurn.turnEnds[0], 'completed', JSON.stringify(toolTurn))
  assert.equal(toolTurn.toolCalls.length, 1); assert.deepEqual(toolTurn.toolResults, toolTurn.toolCalls, 'each tool call has exactly its result')
  assert.equal(toolTurn.firstSurface.type, 'system/message'); assert.ok(toolTurn.controllerNotices.length >= 1, 'first-turn notices still published'); assert.equal(toolTurn.llmCalls, 2)
  await host.stop()
  assert.equal(audit().sessions.find((x) => x.sessionId === tooled).class, 'valid', 'the stored tool-call history audits valid')
  host = startHost()
  ready = await host.next((m) => m.type === 'ready')
  owner = await ownerClient(ready)
  const toolCold = await host.inspect(tooled)
  assert.equal(toolCold.readable, true); assert.deepEqual(toolCold.toolResults, toolTurn.toolCalls)
  await prompt(tooled, 'Second turn after restart.')
  const toolSecond = await waitFor(async () => { const r = await host.inspect(tooled); return r.turnEnds.length >= 2 ? r : null }, 'tool session second turn')
  assert.equal(toolSecond.turnEnds[1], 'completed'); assert.deepEqual(toolSecond.toolResults, toolTurn.toolCalls)
  evidence.toolPairing = { surfaceOrder: toolTurn.surfaceOrder, notices: toolTurn.controllerNotices, toolCalls: toolTurn.toolCalls.length, toolResults: toolTurn.toolResults.length, afterRestart: toolSecond.turnEnds }
  pass('tool-call/result pairing preserved next to first-turn notices; the stored history audits valid, cold-reads after restart and continues')

  if (mode === 'production') {
    const refused = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'x', '--idempotency-key', 'prod', '--json'])
    assert.equal(refused.code, 4); assert.equal(refused.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    pass('standard unpatched DSH: managed submission still refused fail-closed')
  } else {
    // ── Part B: managed CLI tasks across a complete restart ────────────────
    assert.equal(ready.activation.active, true, JSON.stringify(ready.activation))
    assert.equal(ready.gates.hook.ok, true); assert.equal(ready.gates.hook.build, 'dsh-v0.2.2-rc.1+nexus-gateway-authorize-1')
    evidence.managed.activation = { activation: ready.activation, hook: ready.gates.hook }
    const tasks = {}
    for (const [label, modeId, preference] of [['emv2-muse', 'engineering-v2', null], ['emv1-dual', 'engineering-v1', 'deepseek-codex']]) {
      setPreference(preference)
      const text = `Managed ${label} task: add a NOTES.md line.`
      const submitted = await nexus(['submit', '--workspace', workspace, '--mode', modeId, '--prompt', text, '--idempotency-key', 'managed-' + label, '--json'])
      assert.equal(submitted.code, 0, label + ' submit: ' + submitted.stdout + submitted.stderr)
      const { taskId, sessionId } = submitted.json.data
      const turn = await waitFor(async () => { const r = await host.inspect(sessionId); return r.turnEnds.length >= 1 ? r : null }, label + ' managed turn')
      setPreference(null)
      const report = await host.report()
      const record = report.intake.find((r) => r.taskId === taskId)
      assert.equal(report.intake.filter((r) => r.idempotencyKey === 'managed-' + label).length, 1, label + ': one durable intake record')
      assert.equal(record.sessionId, sessionId, label + ': one reserved session identity')
      assert.equal(report.durable[taskId].claimed, 1); assert.ok(report.durable[taskId].inserted <= 1); assert.equal(report.durable[taskId].userMessages, 1, label + ': one accepted user message')
      assert.equal(turn.llmCalls, 1, label + ': one model request')
      assert.equal(turn.firstSurface.type, 'system/message'); assert.deepEqual(turn.retiredSourceSeqs, [])
      const status = await nexus(['status', taskId, '--json'])
      const binding = Object.values(readBindings()).find((b) => b.sessionId === sessionId)
      tasks[label] = { taskId, sessionId, text, requestId: record.requestId, status: status.json.data, displayId: binding && binding.taskId, taskInstanceId: binding && binding.taskInstanceId, attempts: attemptsOf(workspace, binding && binding.taskId), turn }
    }
    // A third managed task whose stored history gets old-style damage while live.
    const damagedSubmit = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Managed task with damaged history.', '--idempotency-key', 'managed-damaged', '--json'])
    assert.equal(damagedSubmit.code, 0, damagedSubmit.stdout + damagedSubmit.stderr)
    const damaged = damagedSubmit.json.data
    await waitFor(async () => (await host.inspect(damaged.sessionId)).turnEnds.length >= 1, 'damaged task turn')
    const identitiesBefore = identityLines()
    // Interrupted execution: SIGKILL while the admitted turn is live.
    host.send('hold'); await host.next((m) => m.type === 'ack' && m.line === 'hold')
    const live = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Interrupted managed task.', '--idempotency-key', 'managed-interrupted', '--json'])
    assert.equal(live.code, 0, live.stdout + live.stderr)
    await waitFor(async () => (await host.report()).managedLive.includes(live.json.data.sessionId), 'live managed turn')
    const ledgerBefore = ledgerTasks(workspace).length
    await host.kill()
    await appendRetiredOnDisk(damaged.sessionId)

    host = startHost()
    ready = await host.next((m) => m.type === 'ready')
    owner = await ownerClient(ready)
    // Registry restored before the first remote mutation.
    for (const t of Object.values(tasks)) assert.equal((await owner.api('session/rename', { sessionId: t.sessionId, title: 'after restart' })).reason, 'nexus-managed-session')
    const reportAfter = await host.report()
    assert.equal(reportAfter.intake.length, 4, 'no intake record was added or lost by the restart')
    assert.deepEqual(identityLines().map((e) => e.sessionId), identitiesBefore.map((e) => e.sessionId).concat(identityLines().slice(identitiesBefore.length).map((e) => e.sessionId)), 'tombstone ledger is append-only across restart')
    for (const [label, t] of Object.entries(tasks)) {
      const cold = await host.inspect(t.sessionId)
      assert.equal(cold.readable, true, label + ': exact session cold-read through the persistence API: ' + cold.readError)
      assert.equal(cold.firstSurface.type, 'system/message'); assert.deepEqual(cold.retiredSourceSeqs, [])
      assert.deepEqual(cold.userPrompts, [t.text], label + ': history intact, no duplicate prompt')
      assert.deepEqual(cold.turnEnds, t.turn.turnEnds, label + ': no new turn')
      assert.equal(cold.llmCalls, 0, label + ': no model request in the restarted host')
      const status = await nexus(['status', t.taskId, '--json'])
      assert.equal(status.json.data.taskId, t.taskId); assert.equal(status.json.data.sessionId, t.sessionId)
      assert.equal(status.json.data.attemptId, t.status.attemptId); assert.equal(status.json.data.status, t.status.status); assert.equal(status.json.data.statusReason, t.status.statusReason)
      assert.equal(status.json.data.reply && status.json.data.reply.text, t.status.reply && t.status.reply.text, label + ': same Nexus reply')
      assert.equal(reportAfter.intake.find((r) => r.taskId === t.taskId).requestId, t.requestId, label + ': same prompt identity')
      assert.equal(attemptsOf(workspace, t.displayId), t.attempts, label + ': no duplicate attempt')
      const state = await owner.api('session/state', { sessionId: t.sessionId })
      assert.equal(state.ok, true, label + ': session restores for reads')
      const replay = await nexus(['submit', '--workspace', workspace, '--mode', label === 'emv2-muse' ? 'engineering-v2' : 'engineering-v1', '--prompt', t.text, '--idempotency-key', 'managed-' + label, '--json'])
      assert.equal(replay.code, 0, label + ' replay: ' + replay.stdout); assert.equal(replay.json.data.taskId, t.taskId); assert.equal(replay.json.data.replay, true)
      const second = await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: t.sessionId, mode: 'queue', content: [{ type: 'text', text: 'x' }] })
      assert.equal(second.reason, 'nexus-managed-session', label + ': further turns stay mediated (one admitted turn per managed task)')
      const after = await host.inspect(t.sessionId)
      assert.deepEqual(after.userPrompts, [t.text]); assert.equal(after.llmCalls, 0)
      evidence.managed[label] = { taskId: t.taskId, sessionId: t.sessionId, statusBefore: { status: t.status.status, statusReason: t.status.statusReason, attemptId: t.status.attemptId }, statusAfter: { status: status.json.data.status, statusReason: status.json.data.statusReason, attemptId: status.json.data.attemptId }, attempts: t.attempts, cold: { readable: cold.readable, surfaceOrder: cold.surfaceOrder, userPrompts: cold.userPrompts.length, turnEnds: cold.turnEnds, modelCallsAfterRestart: after.llmCalls }, replayKept: replay.json.data.replay }
    }
    assert.equal(ledgerTasks(workspace).length, ledgerBefore, 'no duplicate TaskController task')
    pass('managed Dual + Muse: registry restored before remote mutation; exact sessions cold-read and valid; same task/session/attempt/prompt/status/reply via CLI; no duplicate prompt, attempt, task or model request; replay keeps the receipt; further turns mediated')
    const interrupted = await nexus(['status', live.json.data.taskId, '--json'])
    assert.equal(interrupted.json.data.status, 'interrupted', JSON.stringify(interrupted.json.data)); assert.equal(interrupted.json.data.statusReason, 'interrupted')
    await new Promise((r) => setTimeout(r, 2000))
    const interruptedInspect = await host.inspect(live.json.data.sessionId)
    assert.equal(interruptedInspect.llmCalls, 0, 'an interrupted turn is never replayed automatically')
    assert.ok(interruptedInspect.userPrompts.length <= 1)
    evidence.managed.interrupted = { status: interrupted.json.data.status, statusReason: interrupted.json.data.statusReason, modelCallsAfterRestart: interruptedInspect.llmCalls, readable: interruptedInspect.readable }
    pass('interrupted managed execution (host SIGKILL mid-turn): reconciled to an explicit "interrupted" hold reported by the CLI; no automatic replay or model request')
    // Historical damage inside a managed session: held, still managed.
    const heldStatus = await nexus(['status', damaged.taskId, '--json'])
    assert.equal(heldStatus.json.data.status, 'blocked'); assert.equal(heldStatus.json.data.statusReason, 'session-history-retired-source-kind', JSON.stringify(heldStatus.json.data))
    assert.equal((await owner.api('session/rename', { sessionId: damaged.sessionId, title: 'x' })).reason, 'nexus-managed-session', 'a held managed session stays managed')
    assert.equal((await host.inspect(damaged.sessionId)).llmCalls, 0)
    evidence.managed.historicalHold = { status: heldStatus.json.data.status, statusReason: heldStatus.json.data.statusReason, sessionHealth: heldStatus.json.data.sessionHealth }
    pass('a managed session with damaged history is reported blocked (session-history-retired-source-kind), never healthy, stays managed, no model call')
    // Tombstones: deleting an intake record never releases the session.
    await host.stop()
    const dual = tasks['emv1-dual']
    const victim = intakeFiles().find((f) => JSON.parse(fs.readFileSync(f, 'utf8')).taskId === dual.taskId)
    const saved = fs.readFileSync(victim)
    fs.rmSync(victim)
    host = startHost()
    ready = await host.next((m) => m.type === 'ready')
    owner = await ownerClient(ready)
    assert.equal(ready.activation.active, false); assert.ok(ready.activation.problems.includes('intake-store-corrupt'))
    assert.equal((await owner.api('session/rename', { sessionId: dual.sessionId, title: 'x' })).reason, 'nexus-managed-session', 'a deleted record never releases its session')
    const orphan = await nexus(['status', dual.taskId, '--json'])
    assert.equal(orphan.json.data.status, 'blocked'); assert.equal(orphan.json.data.statusReason, 'intake-record-missing')
    const reuse = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v1', '--prompt', dual.text, '--idempotency-key', 'managed-emv1-dual', '--json'])
    assert.equal(reuse.code, 4, 'the key cannot create a new task while its identity is retained')
    await host.stop()
    fs.writeFileSync(victim, saved, { mode: 0o600 })
    host = startHost()
    ready = await host.next((m) => m.type === 'ready')
    assert.equal(ready.activation.active, true, 'restoring the record restores activation: ' + JSON.stringify(ready.activation))
    evidence.managed.tombstone = { activationWhileMissing: 'intake-store-corrupt', orphanStatus: orphan.json.data.statusReason, keyReuseExit: reuse.code }
    pass('tombstones survive restart: a deleted intake record keeps the session managed, reports blocked/intake-record-missing, keeps the key taken, and restoring the record restores activation')
  }
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  try { console.error('host stderr tail: ' + host.stderr.slice(-1500)) } catch { /* none */ }
  for (const name of ['nexus-controller.log', 'aih-controller.log']) {
    try { console.error('--- ' + name + '\n' + fs.readFileSync(path.join(dataRoot, 'logs', name), 'utf8').split('\n').filter((l) => /held|refus|fail|error|reject/i.test(l)).slice(-15).join('\n')) } catch { /* none */ }
  }
} finally {
  try { if (host) await host.stop() } catch { /* gone */ }
  if (process.env.NEXUS_EVIDENCE_OUT) fs.writeFileSync(process.env.NEXUS_EVIDENCE_OUT, JSON.stringify(evidence, null, 2))
  if (exitCode === 0 || !process.env.NEXUS_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('scratch kept: ' + scratch)
}
console.log(`NexusDurabilityRestart.RealHost (${mode}): ${passed} assertion groups passed.`)
process.exit(exitCode)
