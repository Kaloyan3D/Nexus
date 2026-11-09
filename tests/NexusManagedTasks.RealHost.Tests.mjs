// P2-B2B real-host proof: durable managed task admission and the shared
// CLI/GUI task lifecycle on REAL DSH hosts (child processes) with the real
// Nexus composition, real PowerShell controller scripts, real IPC, the real
// `nexus` CLI and the GUI task route. Model traffic is a synthetic local
// transport (tests/lib/NexusManagedHost.mjs); egress is blocked; no credential.
//
// NEXUS_TEST_GATEWAY=patched  — PoC root whose dsh-api-gateway carries the
//   proposed `gateway/authorize` hook (the allowlisted build): activation must
//   become active and every scenario below runs.
// NEXUS_TEST_GATEWAY=production (default) — pinned DSH 0.2.2: activation must
//   stay inactive (hook absent), submit must be refused fail-closed through
//   both CLI and GUI, and nothing is created.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.env.NEXUS_TEST_GATEWAY || 'production'
const node = process.execPath
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-managed-realhost-'))
const installRoot = path.join(scratch, 'install')
fs.mkdirSync(installRoot)
for (const entry of fs.readdirSync(root)) if (entry !== 'data') fs.symlinkSync(path.join(root, entry), path.join(installRoot, entry))
const dataRoot = path.join(installRoot, 'data')
fs.mkdirSync(dataRoot)
for (const name of fs.readdirSync(path.join(root, 'data'))) {
  const from = path.join(root, 'data', name)
  if (['sessions', 'logs', 'aih-state.json', 'routing', 'nexus'].includes(name)) continue
  fs.cpSync(from, path.join(dataRoot, name), { recursive: true })
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
function makeRepo(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, name + '-')))
  git(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n'); git(dir, 'add', '.'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'init')
  return dir
}
const workspace = makeRepo('ws')
const env = { ...process.env, DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: path.join(root, 'app'), AIH_PWSH_HOST: path.join(root, 'runtime', 'pwsh', 'pwsh'), DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
delete env.NEXUS_IPC
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = { mode, platform: process.platform, arch: process.arch, dsh: require(path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).version, gatewayDigest: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'index.js'))).digest('hex'), scenarios: {} }
const digestOf = (text) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/** One child host. */
function startHost(extraEnv = {}) {
  const child = spawn(node, [path.join(root, 'tests', 'lib', 'NexusManagedHost.mjs')], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  const waiters = []
  let stderr = ''
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += chunk
    let index
    while ((index = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, index); out = out.slice(index + 1)
      let message; try { message = JSON.parse(line) } catch { continue }
      lines.push(message)
      for (const waiter of waiters.splice(0)) waiter()
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  async function next(predicate, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = lines.findIndex(predicate)
      if (index >= 0) return lines.splice(index, 1)[0]
      if (Date.now() > deadline) throw new Error('host message timeout; stderr: ' + stderr.slice(-2000))
      await Promise.race([new Promise((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 200)), exited])
      if (child.exitCode !== null || child.signalCode !== null) { const index2 = lines.findIndex(predicate); if (index2 >= 0) return lines.splice(index2, 1)[0]; throw Object.assign(new Error('host exited; stderr: ' + stderr.slice(-2000)), { exited: true }) }
    }
  }
  return {
    child, exited, next,
    send: (line) => child.stdin.write(line + '\n'),
    async report() { child.stdin.write('report\n'); return next((m) => m.type === 'report') },
    async stop() { if (child.exitCode === null && child.signalCode === null) { child.stdin.write('exit\n'); await exited } },
    get stderr() { return stderr },
  }
}

// The CLI resolves the installation from its own location; point it at this
// isolated install through the same layout (scripts/ -> install root).
const cliEntry = path.join(installRoot, 'scripts', 'nexus-cli.cjs')
function nexus(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(node, ['-e', `const cli=require(${JSON.stringify(cliEntry)});const fs=require('fs');const path=require('path');cli.run(process.argv.slice(1),{installRoot:${JSON.stringify(installRoot)},dataRoot:${JSON.stringify(dataRoot)},cwd:${JSON.stringify(workspace)},stdout:(t)=>process.stdout.write(t),stderr:(t)=>process.stderr.write(t),readStdin:()=>Buffer.alloc(0)}).then((c)=>{process.exitCode=c})`, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs || 120000)
    child.on('exit', (code) => { clearTimeout(timer); let json = null; try { json = JSON.parse(stdout) } catch { /* human */ } resolve({ code, json, stdout, stderr }) })
  })
}

/** Owner HTTP client (launch-token cookie) for /api and the GUI task route. */
async function ownerClient(ready) {
  const base = `http://127.0.0.1:${ready.port}/`
  // The host's own launch URL (owner) mints the browser cookie, as the app does.
  const minted = await fetch(ready.authUrl, { redirect: 'manual' })
  const cookie = (minted.headers.get('set-cookie') || '').split(';')[0]
  const headers = { 'content-type': 'application/json', cookie, origin: base.slice(0, -1) }
  return {
    cookie,
    async api(endpoint, args, raw = false) {
      const response = await fetch(base + 'api/' + endpoint, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args: raw ? args : { request: args } } }) })
      const text = await response.text(); let body; try { body = JSON.parse(text) } catch { body = { raw: text } }
      const result = body && body.result
      return { status: response.status, ok: Boolean(result && result.ok), code: result && result.error ? result.error.code : null, reason: result && result.error && result.error.details ? result.error.details.reason : null, value: result && result.value }
    },
    async task(operation, input) {
      const response = await fetch(base + 'nexus/tasks/v1/' + operation, { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), input }) })
      const text = await response.text()
      let body; try { body = JSON.parse(text) } catch { body = { ok: false, unparsed: text.slice(0, 300), httpStatus: response.status } }
      return { status: response.status, body }
    },
    async raw(pathname, init = {}) { return fetch(base + pathname.replace(/^\//, ''), { ...init, headers: { ...headers, ...(init.headers || {}) } }) },
  }
}

const waitFor = async (fn, label, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > deadline) throw new Error('timeout: ' + label); await new Promise((r) => setTimeout(r, 250)) }
}
const prompt = (text) => ({ kind: 'text', text, digest: digestOf(text) })

let host = startHost()
let exitCode = 0
try {
  let ready = await host.next((m) => m.type === 'ready', 120000)
  assert.equal(ready.ownership, 'held')
  let owner = await ownerClient(ready)
  const registered = await owner.api('workspace/create', { path: workspace })
  const workspaceId = registered.value && registered.value.workspace && registered.value.workspace.workspaceId
  assert.ok(workspaceId, 'workspace registered: ' + JSON.stringify(registered).slice(0, 300))

  if (mode === 'production') {
    // ── Pinned DSH: fail closed ─────────────────────────────────────────
    assert.equal(ready.activation.active, false)
    assert.ok(ready.activation.problems.some((p) => p.startsWith('gateway-hook-unverified:gateway-build-not-allowlisted')), JSON.stringify(ready.activation))
    const refused = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Implement it.', '--idempotency-key', 'prod-1', '--json'])
    assert.equal(refused.code, 4, refused.stdout + refused.stderr); assert.equal(refused.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    assert.ok(refused.json.error.details.problems.some((p) => p.startsWith('gateway-hook-unverified')))
    const gui = await owner.task('submit', { idempotencyKey: 'prod-2', workspace, mode: 'engineering-v1', prompt: prompt('x') })
    assert.equal(gui.body.ok, false); assert.equal(gui.body.error && gui.body.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE', JSON.stringify(gui))
    const modes = await nexus(['modes', '--json'])
    assert.ok(modes.json.data.modes.every((m) => m.submittable === false && m.blockedReason === 'managed-admission-disabled'))
    const status = await nexus(['host', 'status', '--json'])
    assert.equal(status.json.data.managedAdmission, 'disabled')
    const after = await host.report()
    assert.deepEqual(after.intake, [], 'nothing was reserved, created or delivered')
    assert.equal(fs.existsSync(path.join(dataRoot, 'nexus', 'intake')) ? fs.readdirSync(path.join(dataRoot, 'nexus', 'intake')).length : 0, 0)
    assert.deepEqual(after.llm.conversation, {})
    const noGuiForged = await (await fetch(`http://127.0.0.1:${ready.port}/nexus/tasks/v1/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status
    assert.equal(noGuiForged, 401, 'the GUI task route requires connection admission')
    evidence.scenarios.production = { activation: ready.activation, cli: refused.json.error, gui: gui.body.error }
    pass('pinned DSH 0.2.2 (hook absent): activation inactive, CLI and GUI submit refused fail-closed (exit 4), nothing created, no model call, GUI route requires admission')
  } else {
    // ── Patched PoC: activation and lifecycle ───────────────────────────
    assert.equal(ready.activation.active, true, JSON.stringify({ activation: ready.activation, gates: ready.gates }))
    assert.equal(ready.gates.hook.ok, true); assert.equal(ready.gates.hook.build, 'dsh-v0.2.2-rc.1+nexus-gateway-authorize-1')
    evidence.scenarios.activation = { activation: ready.activation, gates: ready.gates }
    pass('patched gateway: digest allowlisted + live self-test refusal observed; every activation gate holds; managed admission active')

    // 1. Concurrent GUI + CLI submission under one idempotency key.
    const text = '# Managed task\n\nAdd a CHANGELOG entry.\n'
    const [viaCli, viaGui] = await Promise.all([
      nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', text, '--idempotency-key', 'shared-1', '--json']),
      owner.task('submit', { idempotencyKey: 'shared-1', workspace, mode: 'engineering-v2', prompt: prompt(text) }),
    ])
    if (viaCli.code !== 0) console.error('intake: ' + JSON.stringify((await host.report()).intake))
    assert.equal(viaCli.code, 0, viaCli.stdout + viaCli.stderr)
    assert.equal(viaGui.body.ok, true, JSON.stringify(viaGui.body))
    assert.equal(viaCli.json.data.taskId, viaGui.body.data.taskId)
    const taskA = viaCli.json.data
    assert.match(taskA.taskId, /^nt_[0-9a-f]{32}$/); assert.equal(taskA.status, 'accepted')
    let rep = await waitFor(async () => { const r = await host.report(); const d = r.durable[taskA.taskId]; if (d && d.error) throw new Error('durable read failed: ' + d.error); return d && d.turnEnds.length ? r : null }, 'managed turn end')
    // An idle agent may claim the queued input directly (no inbox splice); either
    // way the exact request id is durable exactly once.
    assert.equal(rep.durable[taskA.taskId].claimed, 1, JSON.stringify(rep.durable[taskA.taskId])); assert.ok(rep.durable[taskA.taskId].inserted <= 1)
    assert.equal(rep.durable[taskA.taskId].userMessages, 1, 'no other user input entered the managed session')
    assert.equal(rep.llm.conversation[taskA.sessionId], 1, 'exactly one model request for one admitted text turn (EMv2)')
    evidence.scenarios.concurrentSubmit = { taskId: taskA.taskId, durable: rep.durable[taskA.taskId], llm: rep.llm }
    pass('concurrent GUI + CLI submit with one key: one task, one durable user message, one model request; identical receipts')

    // 2. Repeated key: original receipt; different payload: conflict.
    const replay = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', text, '--idempotency-key', 'shared-1', '--json'])
    assert.equal(replay.code, 0); assert.equal(replay.json.data.taskId, taskA.taskId); assert.equal(replay.json.data.replay, true)
    const conflict = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'other', '--idempotency-key', 'shared-1', '--json'])
    assert.equal(conflict.code, 4); assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT')
    rep = await host.report()
    assert.equal(rep.durable[taskA.taskId].claimed, 1); assert.equal(rep.llm.conversation[taskA.sessionId], 1)
    pass('repeated idempotency key returns the original receipt (no second message or model call); a different payload is IDEMPOTENCY_CONFLICT')

    // 3. Exact status/completion reporting (a DSH turn never completes a task).
    const statusA = await nexus(['status', taskA.taskId, '--json'])
    assert.equal(statusA.code, 0); assert.equal(statusA.json.data.cohort, 'managed')
    assert.ok(['blocked', 'running', 'verifying'].includes(statusA.json.data.status), JSON.stringify(statusA.json.data))
    const resultA = await nexus(['result', taskA.taskId, '--json'])
    assert.notEqual(resultA.code, 0, 'result never exits 0 unless the TaskController ledger completed the task')
    const guiStatus = await owner.task('getStatus', { taskId: taskA.taskId })
    assert.equal(guiStatus.body.data.status, statusA.json.data.status, 'GUI and CLI see the same authority')
    evidence.scenarios.statusAfterTurn = statusA.json.data
    pass('status/result: exact managed view from intake + TaskController ledger; GUI and CLI identical; a finished DSH turn is not completion')

    // 4. EMv1 (dual) submission: no extra inference either. The operator's
    // single profile preference selects the engine's profile (no silent
    // cross-engine fallback): with a Muse preference EMv1 is not submittable.
    const settingsFile = path.join(dataRoot, 'nexus-settings.yaml')
    const settings = fs.readFileSync(settingsFile, 'utf8')
    const preference = (settings.match(/^engineering-profile:\s*(\S+)/m) || [])[1]
    const modesBefore = await nexus(['modes', '--json'])
    const v1Before = modesBefore.json.data.modes.find((m) => m.id === 'engineering-v1')
    if (preference && preference.startsWith('muse')) {
      assert.equal(v1Before.submittable, false); assert.equal(v1Before.blockedReason, 'mode-profile-unresolved')
      const unavailable = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v1', '--prompt', 'x', '--idempotency-key', 'dual-0', '--json'])
      assert.equal(unavailable.code, 4); assert.equal(unavailable.json.error.code, 'MODE_UNAVAILABLE')
    }
    fs.writeFileSync(settingsFile, settings.replace(/^engineering-profile:.*$/m, 'engineering-profile: deepseek-codex'))
    assert.equal((await nexus(['modes', '--json'])).json.data.modes.find((m) => m.id === 'engineering-v1').submittable, true)
    const dual = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v1', '--prompt', 'Fix the typo.', '--idempotency-key', 'dual-1', '--json'])
    fs.writeFileSync(settingsFile, settings)
    assert.equal(dual.code, 0, dual.stdout + dual.stderr)
    rep = await waitFor(async () => { const r = await host.report(); return r.durable[dual.json.data.taskId] && r.durable[dual.json.data.taskId].turnEnds.length ? r : null }, 'dual turn end')
    assert.equal(rep.llm.conversation[dual.json.data.sessionId], 1, 'exactly one model request for one admitted text turn (EMv1)')
    evidence.scenarios.dual = { durable: rep.durable[dual.json.data.taskId], llm: rep.llm.conversation[dual.json.data.sessionId] }
    pass('EMv1 (dual) managed submission: one durable message, one model request; no extra inference')

    // 5. Owner-peer unauthorized mutations of a managed session are refused with no state change.
    const beforeEvents = rep.durable[taskA.taskId].events
    const rows = [
      ['session/prompt', { requestId: crypto.randomUUID(), sessionId: taskA.sessionId, mode: 'queue', content: [{ type: 'text', text: 'owner prompt' }] }],
      ['session/rename', { sessionId: taskA.sessionId, title: 'owner rename' }],
      ['session/cancel', { sessionId: taskA.sessionId }],
      ['session/selectModel', { sessionId: taskA.sessionId, provider: 'deepseek', model: 'deepseek-v4-flash' }],
      ['session/fork', { sessionId: taskA.sessionId }],
      ['workspace/archiveSession', { sessionId: taskA.sessionId, stop: true }],
    ]
    const refusals = {}
    for (const [endpoint, args] of rows) { const r = await owner.api(endpoint, args); refusals[endpoint] = r.reason; assert.equal(r.code, 'remote-access/denied', endpoint + ' ' + JSON.stringify(r)); assert.equal(r.reason, 'nexus-managed-session', endpoint) }
    const upload = await owner.raw('api/session/uploadFileBinary?sessionId=' + encodeURIComponent(taskA.sessionId) + '&name=a.txt', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })
    assert.equal(upload.status, 403)
    const gate = await owner.raw('nexus/gate-action.json', { method: 'POST', body: JSON.stringify({ sessionId: taskA.sessionId, gateId: 'g', actionId: 'a', requestId: 'r' }) })
    assert.equal(gate.status, 403)
    rep = await host.report()
    assert.equal(rep.durable[taskA.taskId].events, beforeEvents, 'no durable event was appended by any refused owner mutation')
    evidence.scenarios.ownerPeer = { refusals, upload: upload.status, gateAction: gate.status }
    pass('owner-peer mutations of a managed session (prompt/rename/cancel/model/fork/archive, binary upload, Nexus gate route) refused with no durable change')

    // 6. Approval broker on a live turn: forged/stale refused, first valid wins, disconnect never grants.
    host.send('hold'); await host.next((m) => m.type === 'ack' && m.line === 'hold')
    const live = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Run the build.', '--idempotency-key', 'live-1', '--json'])
    assert.equal(live.code, 0, live.stdout + live.stderr)
    const taskB = live.json.data
    await waitFor(async () => (await host.report()).managedLive.includes(taskB.sessionId), 'live managed turn')
    host.send('approve ' + taskB.sessionId); await host.next((m) => m.type === 'ack' && m.line.startsWith('approve'))
    const pending = await waitFor(async () => { const r = await nexus(['status', taskB.taskId, '--json']); return r.json.data.status === 'awaiting_operator' ? r.json.data : null }, 'awaiting_operator')
    const [action] = pending.operatorActions
    assert.deepEqual(action.choices.map((c) => c.id), ['allow-once', 'reject'])
    // Non-interactive wait reports the pending action truthfully (exit 7) and answers nothing.
    const waited = await nexus(['wait', taskB.taskId, '--timeout', '5s', '--json'])
    assert.equal(waited.code, 7); assert.equal(waited.json.data.status, 'awaiting_operator')
    const forged = await nexus(['respond', taskB.taskId, '--request', 'act_' + 'f'.repeat(24), '--choice', 'allow-once', '--revision', '1', '--json'])
    assert.equal(forged.code, 4); assert.equal(forged.json.error.code, 'NOT_FOUND')
    const stale = await nexus(['respond', taskB.taskId, '--request', action.id, '--choice', 'allow-once', '--revision', '9', '--json'])
    assert.equal(stale.json.error.code, 'STALE_ACTION')
    const foreign = await nexus(['respond', taskA.taskId, '--request', action.id, '--choice', 'allow-once', '--revision', action.revision, '--json'])
    assert.equal(foreign.json.error.code, 'NOT_FOUND', 'an action id is bound to its task')
    const [guiAnswer, cliAnswer] = await Promise.all([
      owner.task('respond', { taskId: taskB.taskId, actionId: action.id, expectedRevision: action.revision, choiceId: 'reject' }),
      nexus(['respond', taskB.taskId, '--request', action.id, '--choice', 'allow-once', '--revision', action.revision, '--json']),
    ])
    const winners = [guiAnswer.body.ok, cliAnswer.code === 0].filter(Boolean).length
    assert.equal(winners, 1, 'exactly one of the racing GUI/CLI answers wins: ' + JSON.stringify([guiAnswer.body, cliAnswer.json]))
    const approval = await host.next((m) => m.type === 'approval' && m.sessionId === taskB.sessionId)
    assert.equal(approval.outcome, guiAnswer.body.ok ? 'rejected' : 'allowed-once')
    evidence.scenarios.broker = { action, winner: guiAnswer.body.ok ? 'gui:reject' : 'cli:allow-once', outcome: approval.outcome, forged: forged.json.error.code, stale: stale.json.error.code }
    pass('approval broker on a real DSH approval request: shared GUI/CLI action, non-interactive wait reports it (exit 7), forged/stale/foreign refused, exactly one racing answer wins')

    // 7. Pending approval across a client disconnect, then cancellation during execution.
    host.send('approve ' + taskB.sessionId); await host.next((m) => m.type === 'ack' && m.line.startsWith('approve'))
    await waitFor(async () => (await nexus(['status', taskB.taskId, '--json'])).json.data.status === 'awaiting_operator', 'second approval pending')
    // CLI clients connect per command and have all disconnected: still pending, never granted.
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal((await nexus(['status', taskB.taskId, '--json'])).json.data.status, 'awaiting_operator')
    const cancel = await nexus(['cancel', taskB.taskId, '--json'])
    assert.equal(cancel.code, 0); assert.ok(['cancelling', 'cancelled'].includes(cancel.json.data.status)); assert.equal(cancel.json.data.disposition, 'requested')
    const withdrawn = await host.next((m) => m.type === 'approval' && m.sessionId === taskB.sessionId)
    assert.equal(withdrawn.outcome, 'rejected', 'a cancelled task withdraws its pending approval without granting it')
    host.send('release'); await host.next((m) => m.type === 'ack' && m.line === 'release')
    const settled = await waitFor(async () => { const r = await nexus(['status', taskB.taskId, '--json']); return r.json.data.status === 'cancelled' ? r : null }, 'cancelled')
    const waitCancelled = await nexus(['wait', taskB.taskId, '--timeout', '5s', '--json'])
    assert.equal(waitCancelled.code, 6)
    assert.equal((await nexus(['cancel', taskB.taskId, '--json'])).json.data.disposition, 'already_terminal')
    rep = await host.report()
    assert.ok(rep.durable[taskB.taskId].turnEnds.length >= 1)
    assert.ok((rep.llm.conversation[taskB.sessionId] || 0) <= 1, 'the cancelled turn made no further model request: ' + JSON.stringify(rep.llm))
    evidence.scenarios.cancel = { status: settled.json.data.status, turnEnds: rep.durable[taskB.taskId].turnEnds, approvals: rep.approvals, modelRequests: rep.llm.conversation[taskB.sessionId] || 0 }
    pass('pending approval survives client disconnects without a grant; cancel during execution withdraws it, stops the turn, settles cancelled (exit 6), idempotent')

    // 8. Cross-session workspace writes: an ordinary session in the managed workspace cannot run while a managed task is live.
    host.send('hold'); await host.next((m) => m.type === 'ack' && m.line === 'hold')
    const liveC = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Long task.', '--idempotency-key', 'live-2', '--json'])
    const taskC = liveC.json.data
    await waitFor(async () => (await host.report()).managedLive.includes(taskC.sessionId), 'live managed turn C')
    const ordinary = await owner.api('session/create', { workspaceId })
    assert.equal(ordinary.ok, true, JSON.stringify(ordinary))
    const ordinaryId = ordinary.value.sessionId
    const prompted = await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: ordinaryId, mode: 'queue', content: [{ type: 'text', text: 'edit the managed snapshot' }] })
    assert.equal(prompted.ok, true, 'ordinary sessions are still promptable')
    await new Promise((r) => setTimeout(r, 2500))
    rep = await host.report()
    assert.equal(rep.llm.conversation[ordinaryId] || 0, 0, 'no model/tool step ran for an ordinary session in the live managed workspace')
    const terminal = await owner.api('terminal/create', { agentId: ordinaryId, request: { id: 'term-x', cols: 80, rows: 24 } }, true)
    assert.equal(terminal.reason, 'nexus-managed-workspace', JSON.stringify(terminal))
    const hostMaintenance = await owner.api('pluginManager/setPluginEnabled', { id: 'nexus-controller-host', enabled: false }, true)
    assert.equal(hostMaintenance.reason, 'nexus-host-protected-while-active', JSON.stringify(hostMaintenance))
    const settingsUpdate = await owner.api('settings/update', { ns: 'agent-default-model', patch: {}, expectedRevision: 0 }, true)
    assert.equal(settingsUpdate.reason, 'nexus-host-protected-while-active', JSON.stringify(settingsUpdate))
    const registryRoute = await owner.raw('nexus/registry/v1/models', { method: 'POST', body: '{}' })
    assert.equal(registryRoute.status, 403)
    host.send('release'); await host.next((m) => m.type === 'ack' && m.line === 'release')
    await waitFor(async () => !(await host.report()).managedLive.includes(taskC.sessionId), 'turn C ended')
    evidence.scenarios.workspaceExclusivity = { ordinaryLlm: rep.llm.conversation[ordinaryId] || 0, terminal: terminal.reason, plugin: hostMaintenance.reason, settings: settingsUpdate.reason, registryRoute: registryRoute.status }
    pass('cross-session workspace protection: ordinary session steps refused while a managed task is live; terminals, host maintenance and registry routes refused')

    // 9. Restart: managed status restored before serving remote mutations.
    await host.stop()
    host = startHost()
    ready = await host.next((m) => m.type === 'ready', 120000)
    owner = await ownerClient(ready)
    assert.equal(ready.activation.active, true, JSON.stringify(ready.activation))
    const renameAfter = await owner.api('session/rename', { sessionId: taskA.sessionId, title: 'after restart' })
    assert.equal(renameAfter.reason, 'nexus-managed-session', 'managed identity restored before the first remote mutation')
    const restored = await nexus(['status', taskA.taskId, '--json'])
    assert.equal(restored.code, 0); assert.equal(restored.json.data.taskId, taskA.taskId)
    assert.equal((await nexus(['status', taskB.taskId, '--json'])).json.data.status, 'cancelled')
    pass('graceful restart: managed registry and statuses restored from the durable intake before any remote mutation is served')

    // 10. Evidence/snapshot tampering: a modified intake record disables activation and quarantines sessions.
    await host.stop()
    const intakeDir = path.join(dataRoot, 'nexus', 'intake')
    const victim = fs.readdirSync(intakeDir).find((name) => JSON.parse(fs.readFileSync(path.join(intakeDir, name), 'utf8')).taskId === taskA.taskId)
    const original = fs.readFileSync(path.join(intakeDir, victim), 'utf8')
    fs.writeFileSync(path.join(intakeDir, victim), original.replace('"schemaVersion": 1', '"schemaVersion": 99'))
    host = startHost()
    ready = await host.next((m) => m.type === 'ready', 120000)
    owner = await ownerClient(ready)
    assert.equal(ready.activation.active, false)
    assert.ok(ready.activation.problems.includes('intake-store-corrupt'))
    assert.equal((await owner.api('session/rename', { sessionId: taskA.sessionId, title: 'x' })).reason, 'nexus-managed-session', 'a tampered record never releases its session')
    const blocked = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'x', '--idempotency-key', 'tamper', '--json'])
    assert.equal(blocked.code, 4)
    await host.stop()
    fs.writeFileSync(path.join(intakeDir, victim), original)
    pass('tampered intake record: store corrupt → activation inactive, submit refused, affected session quarantined as managed')

    // 11. Crash before DSH message persistence (after durable intent) → redelivered once under the same ids.
    host = startHost({ NEXUS_TEST_CRASH_AT: 'delivering' })
    ready = await host.next((m) => m.type === 'ready', 120000)
    const crash1 = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Crash one.', '--idempotency-key', 'crash-1', '--json'])
    assert.notEqual(crash1.code, 0, 'the client was never told accepted')
    const crashed1 = await host.exited
    assert.equal(crashed1.signal, 'SIGKILL')
    host = startHost()
    ready = await host.next((m) => m.type === 'ready', 120000)
    rep = await waitFor(async () => { const r = await host.report(); const rec = r.intake.find((x) => x.idempotencyKey === 'crash-1' && x.state === 'accepted'); return rec && r.durable[rec.taskId] && r.durable[rec.taskId].turnEnds.length ? { r, rec } : null }, 'redelivered crash-1')
    const retry1 = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Crash one.', '--idempotency-key', 'crash-1', '--json'])
    assert.equal(retry1.code, 0); assert.equal(retry1.json.data.taskId, rep.rec.taskId)
    assert.equal(rep.r.durable[rep.rec.taskId].claimed, 1); assert.ok(rep.r.durable[rep.rec.taskId].inserted <= 1); assert.equal(rep.r.llm.conversation[rep.rec.sessionId], 1)
    evidence.scenarios.crashBeforePersistence = { taskId: rep.rec.taskId, durable: rep.r.durable[rep.rec.taskId] }
    await host.stop()
    pass('host SIGKILL after the durable intent, before the DSH write: restart proves absence and redelivers under the same ids — one message, one model call; retry returns the receipt')

    // 12. Crash after DSH message persistence, before acknowledgement → accepted once, held, never replayed.
    host = startHost({ NEXUS_TEST_CRASH_AT: 'accepted' })
    ready = await host.next((m) => m.type === 'ready', 120000)
    const crash2 = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Crash two.', '--idempotency-key', 'crash-2', '--json'])
    assert.notEqual(crash2.code, 0)
    assert.equal((await host.exited).signal, 'SIGKILL')
    host = startHost()
    ready = await host.next((m) => m.type === 'ready', 120000)
    rep = await host.report()
    const held = rep.intake.find((x) => x.idempotencyKey === 'crash-2' && x.state === 'parked' && ['interrupted', 'restored-input-not-resumed'].includes(x.hold) && x.acceptedAt)
    assert.ok(held, JSON.stringify(rep.intake))
    assert.equal(Math.max(rep.durable[held.taskId].inserted, rep.durable[held.taskId].claimed), 1, 'exactly one durable copy of the input: ' + JSON.stringify(rep.durable[held.taskId]))
    await new Promise((r) => setTimeout(r, 2000))
    rep = await host.report()
    assert.ok((rep.llm.conversation[held.sessionId] || 0) === 0, 'the restarted host made no model call for the held task')
    const heldStatus = await nexus(['status', held.taskId, '--json'])
    assert.ok(['interrupted', 'blocked'].includes(heldStatus.json.data.status))
    const retry2 = await nexus(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'Crash two.', '--idempotency-key', 'crash-2', '--json'])
    assert.equal(retry2.code, 0, 'the intake was accepted (durable once); the retry returns its receipt'); assert.equal(retry2.json.data.taskId, held.taskId)
    assert.ok((await host.report()).durable[held.taskId].claimed <= 1)
    evidence.scenarios.crashAfterPersistence = { taskId: held.taskId, hold: held.hold, status: heldStatus.json.data.status, durable: rep.durable[held.taskId] }
    pass('host SIGKILL after the flushed DSH message, before acknowledgement: restart accepts it once and holds it (' + held.hold + '); no replay, no model call; retry returns the receipt')

    // 13. Missing Controller: disposing the Controller closes admission (policy fails closed).
    const finalRep = await host.report()
    evidence.scenarios.final = { llm: finalRep.llm, metrics: finalRep.metrics }
  }
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  try { console.error('host stderr tail: ' + host.stderr.slice(-3000)) } catch { /* none */ }
  for (const name of ['nexus-controller.log', 'aih-controller.log']) {
    try { console.error('--- ' + name + '\n' + fs.readFileSync(path.join(dataRoot, 'logs', name), 'utf8').split('\n').filter((line) => /refused|managed|failed|error|reject/i.test(line)).slice(-25).join('\n')) } catch { /* none */ }
  }
} finally {
  try { await host.stop() } catch { /* already gone */ }
  const out = process.env.NEXUS_EVIDENCE_OUT
  if (out) fs.writeFileSync(out, JSON.stringify(evidence, null, 2))
  if (exitCode === 0 || !process.env.NEXUS_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('scratch kept: ' + scratch)
}
console.log(`NexusManagedTasks.RealHost (${mode}): ${passed} assertion groups passed.`)
process.exit(exitCode)
