// P2-B2E real-host proof: durable multi-turn continuation of managed tasks.
// Real child DSH hosts (pinned 0.2.2-rc.1), real PowerShell controller
// scripts, real IPC + `nexus` CLI and the GUI task route; synthetic local
// model transport that echoes which `[turn-N]` markers it received (proof of
// the conversation history per turn) and makes one read-only tool call per
// session (paired tool call/result in the durable log); blocked egress; no
// credential.
//
// Production mode: ordinary GUI multi-turn sessions keep working and managed
// submit/continue stay refused. Patched mode (PoC gateway build): Muse and Dual
// three-turn tasks to verified completion, restart between turns, SIGKILL at
// continuation delivery boundaries, interrupted continued turn, concurrent and
// duplicate continuations, continuation vs verification.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-continuation-'))
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
// A workspace whose deterministic verification passes or fails (declared in
// .ai-harness/verification.yml, mode replace, one required check).
function makeRepo(name, exitCode) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, name + '-')))
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  fs.mkdirSync(path.join(dir, '.ai-harness'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.ai-harness', 'verification.yml'), [
    'version: 1', 'mode: replace', 'commands:',
    '  - name: fixture-check', '    kind: test', `    command: node -e "process.exit(${exitCode})"`, '    workingDirectory: .', '    required: true', '    timeoutSeconds: 120', '',
  ].join('\n'))
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'init')
  return dir
}
const env = { ...process.env, DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: path.join(root, 'app'), AIH_PWSH_HOST: path.join(root, 'runtime', 'pwsh', 'pwsh'), DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', NEXUS_TEST_ECHO_TURNS: '1', NEXUS_TEST_TOOL_CALL: '1' }
delete env.NEXUS_IPC
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = { mode, platform: process.platform, arch: process.arch, runs: {} }
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
  async function next(predicate, timeoutMs = 180000) {
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
    next, send,
    async inspect(id) { send('inspect ' + id); return next((m) => m.type === 'inspect' && m.sessionId === id) },
    async report() { send('report'); return next((m) => m.type === 'report') },
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
      return { ok: Boolean(result && result.ok), code: result && result.error ? result.error.code : null, reason: result && result.error && result.error.details ? result.error.details.reason : null, value: result && result.value }
    },
    async task(operation, input) {
      const response = await fetch(base + 'nexus/tasks/v1/' + operation, { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, requestId: crypto.randomUUID(), input }) })
      return response.json()
    },
  }
}
function nexus(args) {
  return new Promise((resolve) => {
    const cli = path.join(installRoot, 'scripts', 'nexus-cli.cjs')
    const code = `require(${JSON.stringify(cli)}).run(process.argv.slice(1),{installRoot:${JSON.stringify(installRoot)},dataRoot:${JSON.stringify(dataRoot)},cwd:process.cwd(),stdout:(t)=>process.stdout.write(t),stderr:(t)=>process.stderr.write(t),readStdin:()=>Buffer.alloc(0)}).then((c)=>{process.exitCode=c})`
    const child = spawn(node, ['-e', code, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000)
    child.on('exit', (exit) => { clearTimeout(timer); let json = null; try { json = JSON.parse(stdout) } catch { /* human */ } resolve({ code: exit, json, stdout, stderr }) })
  })
}
const waitFor = async (fn, label, timeoutMs = 180000) => { const deadline = Date.now() + timeoutMs; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error('timeout: ' + label); await new Promise((r) => setTimeout(r, 400)) } }
const attemptsOf = (ws, displayId) => { try { return fs.readFileSync(path.join(ws, '.ai-harness', 'runs', displayId, 'attempts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const evidenceOf = (ws, displayId) => { try { return JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'runs', displayId, 'evidence.json'), 'utf8')) } catch { return null } }
const totalModelCalls = (report) => Object.values(report.llm.conversation).reduce((a, b) => a + b, 0)


const userIdsOf = (inspected) => inspected.userPrompts
let host = null
let exitCode = 0
try {
  host = startHost()
  let ready = await host.next((m) => m.type === 'ready')
  let owner = await ownerClient(ready)
  const restart = async (extraEnv = {}, kill = false) => {
    if (kill) await host.kill(); else await host.stop()
    host = startHost(extraEnv)
    ready = await host.next((m) => m.type === 'ready')
    owner = await ownerClient(ready)
  }
  const repoA = makeRepo('muse', 0)
  assert.equal((await nexus(['workspace', 'add', '--path', repoA, '--json'])).code, 0)

  // ── Ordinary GUI multi-turn session (both modes): unchanged behavior ──────
  {
    const workspaceId = (await nexus(['workspace', 'add', '--path', repoA, '--json'])).json.data.workspaceId
    const id = (await owner.api('session/create', { workspaceId, agentPreset: 'aih-muse' })).value.sessionId
    for (const n of [1, 2]) {
      await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: `[turn-${n}] ordinary turn ${n}` }] })
      await waitFor(async () => (await host.inspect(id)).turnEnds.length >= n, 'ordinary turn ' + n)
    }
    const r = await host.inspect(id)
    assert.deepEqual(r.turnEnds, ['completed', 'completed'], JSON.stringify(r))
    evidence.runs.ordinaryGui = { turnEnds: r.turnEnds, llmCalls: r.llmCalls, readable: r.readable }
    pass('ordinary GUI multi-turn session: both user turns run as before (no managed gate on unmanaged sessions)')
  }

  if (mode === 'production') {
    const refused = await nexus(['submit', '--workspace', repoA, '--mode', 'engineering-v2', '--prompt', 'x', '--idempotency-key', 'prod', '--json'])
    assert.equal(refused.code, 4); assert.equal(refused.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    const cont = await nexus(['continue', 'nt_' + '0'.repeat(32), '--prompt', 'x', '--revision', '1', '--json'])
    assert.equal(cont.code, 4); assert.equal(cont.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    pass('standard unpatched DSH: managed submit and continue are both refused fail-closed')
  } else {
    assert.equal(ready.activation.active, true, JSON.stringify(ready.activation))
    const statusOf = async (taskId) => { const r = await nexus(['status', taskId, '--json']); assert.ok(r.json && r.json.ok, 'status ' + taskId + ': ' + r.stdout + r.stderr); return r.json.data }
    const turnEndsOf = async (sessionId) => (await host.inspect(sessionId)).turnEnds.length
    async function submitTurn1(label, ws, modeId, preference) {
      setPreference(preference)
      const submitted = await nexus(['submit', '--workspace', ws, '--mode', modeId, '--prompt', `[turn-1] ${label}: implement JWT authentication.`, '--idempotency-key', 'p2b2e-' + label, '--json'])
      assert.equal(submitted.code, 0, label + ': ' + submitted.stdout + submitted.stderr)
      await waitFor(async () => (await turnEndsOf(submitted.json.data.sessionId)) >= 1, label + ' turn 1')
      return submitted.json.data
    }
    async function continueTurn(t, n, key, text) {
      const before = await turnEndsOf(t.sessionId)
      const r = await nexus(['continue', t.taskId, '--prompt', `[turn-${n}] ${text}`, '--idempotency-key', key, '--json'])
      assert.equal(r.code, 0, 'continue ' + n + ': ' + r.stdout + r.stderr)
      await waitFor(async () => (await turnEndsOf(t.sessionId)) > before, 'turn ' + n)
      return r.json.data
    }

    // 1. Muse and Dual: three sequential turns -> verification -> completed.
    const repoB = makeRepo('dual', 0)
    assert.equal((await nexus(['workspace', 'add', '--path', repoB, '--json'])).code, 0)
    for (const [label, ws, modeId, preference] of [['muse-3', repoA, 'engineering-v2', null], ['dual-3', repoB, 'engineering-v1', 'deepseek-codex']]) {
      const t = await submitTurn1(label, ws, modeId, preference)
      const trace = []
      let view = await statusOf(t.taskId)
      assert.equal(view.continuation.allowed, true, label + ': ' + JSON.stringify(view))
      assert.ok(view.operatorActions.some((a) => a.kind === 'verification'), label + ': verification offered next to continuation')
      trace.push({ turn: 1, status: view.status, reason: view.statusReason, reply: (await nexus(['result', t.taskId, '--json'])).json.data.reply.text, revision: view.revision })
      const receipts = []
      for (const [n, text] of [[2, 'Add refresh token support.'], [3, 'Now add integration tests.']]) {
        const receipt = await continueTurn(t, n, `${label}-followup-00${n - 1}`, text)
        assert.equal(receipt.taskId, t.taskId); assert.equal(receipt.sessionId, t.sessionId); assert.equal(receipt.turnSeq, n)
        receipts.push(receipt)
        view = await statusOf(t.taskId)
        const reply = (await nexus(['result', t.taskId, '--json'])).json.data.reply.text
        const expected = Array.from({ length: n }, (_, i) => `[turn-${i + 1}]`).join(',')
        assert.equal(reply, 'Synthetic reply. Seen: ' + expected, label + ' turn ' + n + ': the model received the whole conversation history')
        assert.equal(view.turns.total, n); assert.equal(view.turns.current.status, 'completed')
        trace.push({ turn: n, turnId: receipt.turnId, status: view.status, reason: view.statusReason, reply, revision: view.revision })
      }
      const guiView = (await owner.task('getStatus', { taskId: t.taskId })).data
      assert.deepEqual(guiView.turns, view.turns, label + ': GUI shows the same turns'); assert.deepEqual(guiView.operatorActions.map((a) => a.id), view.operatorActions.map((a) => a.id))
      const inspected = await host.inspect(t.sessionId)
      assert.equal(inspected.userPrompts.length, 3, label + ': three durable user messages, no duplicate')
      assert.ok(inspected.userPrompts.every((p, i) => p.startsWith(`[turn-${i + 1}]`)), JSON.stringify(inspected.userPrompts))
      assert.deepEqual(inspected.turnEnds, ['completed', 'completed', 'completed'])
      assert.equal(inspected.readable, true, label + ': the format-v4 log stays readable'); assert.equal(inspected.firstSurface.type, 'system/message')
      assert.deepEqual([...inspected.toolResults].sort(), [...inspected.toolCalls].sort(), label + ': tool calls and results stay paired')
      assert.equal(inspected.llmCalls, 4, label + ': exactly one model request per admitted turn (+1 for the tool step), no extra inference')
      const record = JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks.find((x) => x.taskId === view.displayId)
      const attempts = attemptsOf(ws, view.displayId)
      assert.deepEqual(attempts.map((a) => a.status), ['started'], label + ': one open attempt for the whole multi-turn candidate')
      // Final verification of the latest candidate.
      const verify = view.operatorActions.find((a) => a.kind === 'verification')
      const callsBefore = totalModelCalls(await host.report())
      assert.equal((await nexus(['respond', t.taskId, '--request', verify.id, '--choice', 'run', '--revision', verify.revision, '--json'])).json.data.disposition, 'accepted')
      const waited = await nexus(['wait', t.taskId, '--timeout', '5m', '--json'])
      const final = waited.json.data
      assert.equal(final.taskVerification.state, 'passed', label + ': ' + JSON.stringify(final))
      assert.equal(final.status, 'completed', label + ': ' + JSON.stringify(final)); assert.equal(waited.code, 0)
      const ledger = JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks.find((x) => x.taskId === view.displayId)
      assert.equal(ledger.status, 'complete', 'completion is the TaskController ledger\'s')
      assert.equal(totalModelCalls(await host.report()), callsBefore, 'verification makes no model request')
      const after = await nexus(['continue', t.taskId, '--prompt', '[turn-4] reopen', '--idempotency-key', label + '-after', '--json'])
      assert.equal(after.code, 4); assert.equal(after.json.error.code, 'TASK_NOT_CONTINUABLE'); assert.equal(after.json.error.details.reason, 'task-terminal')
      const human = await nexus(['status', t.taskId])
      assert.match(human.stdout, /turns: 3 admitted/)
      evidence.runs[label] = { taskId: t.taskId, sessionId: t.sessionId, trace, receipts, userPrompts: inspected.userPrompts, turnEnds: inspected.turnEnds, llmCalls: inspected.llmCalls, toolPairs: inspected.toolCalls.length, attemptsBeforeVerify: attempts.map((a) => a.status), attemptsFinal: attemptsOf(ws, view.displayId).map((a) => a.status), verification: final.taskVerification, finalStatus: final.status, ledger: ledger.status, ledgerBefore: record && record.status, afterTerminal: after.json.error }
      setPreference(null)
    }
    pass('managed Muse + Dual: three sequential turns in one task and DSH session, each reply shows the full history, one model request per turn, paired tool call, one open attempt, final verification -> completed (TaskController), terminal task refuses continuation')

    // 2. Restart between clean turns: same session, cold-restored history.
    {
      const t = await submitTurn1('restart', repoA, 'engineering-v2', null)
      await restart()
      const view = await statusOf(t.taskId)
      assert.equal(view.continuation.allowed, true, 'clean turn continuable after restart: ' + JSON.stringify(view))
      const receipt = await continueTurn(t, 2, 'restart-2', 'Continue after the host restart.')
      assert.equal(receipt.sessionId, t.sessionId)
      const reply = (await nexus(['result', t.taskId, '--json'])).json.data.reply.text
      assert.equal(reply, 'Synthetic reply. Seen: [turn-1],[turn-2]', 'history restored from the durable log')
      const inspected = await host.inspect(t.sessionId)
      assert.equal(inspected.readable, true); assert.equal(inspected.userPrompts.length, 2)
      evidence.runs.restartBetweenTurns = { taskId: t.taskId, reply, userPrompts: inspected.userPrompts, turnEnds: inspected.turnEnds }
    }
    pass('restart between clean turns: continuation reuses the same DSH session after a cold restart and the model receives the restored history')

    // 3. SIGKILL after the continuation's delivery intent is durable (no DSH effect).
    {
      await restart({ NEXUS_TEST_CRASH_AT: 'turn-delivering' })
      const t = await submitTurn1('crash-delivering', repoA, 'engineering-v2', null)
      const crashed = await nexus(['continue', t.taskId, '--prompt', '[turn-2] after crash', '--idempotency-key', 'crash-d-2', '--json'])
      assert.notEqual(crashed.code, 0, 'the host died mid-continuation')
      await restart({}, true)
      // Proven never inserted: finished once under the same ids.
      await waitFor(async () => (await turnEndsOf(t.sessionId)) >= 2, 'resumed turn 2')
      const retry = await nexus(['continue', t.taskId, '--prompt', '[turn-2] after crash', '--idempotency-key', 'crash-d-2', '--json'])
      assert.equal(retry.code, 0, retry.stdout); assert.equal(retry.json.data.replay, true)
      const inspected = await host.inspect(t.sessionId)
      assert.equal(inspected.userPrompts.filter((p) => p.startsWith('[turn-2]')).length, 1, 'delivered exactly once')
      evidence.runs.crashTurnDelivering = { crashExit: crashed.code, retry: retry.json.data, userPrompts: inspected.userPrompts, turnEnds: inspected.turnEnds }
    }
    pass('SIGKILL after the continuation intent is durable, before DSH delivery: reconciled under the same ids after restart, delivered and run exactly once; same-key retry returns the receipt')

    // 4. SIGKILL after DSH insertion, before the acceptance commit.
    {
      await restart({ NEXUS_TEST_CRASH_AT: 'turn-accepted' })
      const t = await submitTurn1('crash-accepted', repoA, 'engineering-v2', null)
      const callsAfterTurn1 = (await host.inspect(t.sessionId)).llmCalls
      const crashed = await nexus(['continue', t.taskId, '--prompt', '[turn-2] inserted then crash', '--idempotency-key', 'crash-a-2', '--json'])
      assert.notEqual(crashed.code, 0)
      await restart({}, true)
      await new Promise((r) => setTimeout(r, 1500))
      const view = await statusOf(t.taskId)
      assert.equal(view.status, 'blocked', JSON.stringify(view)); assert.equal(view.statusReason, 'restored-input-not-resumed')
      assert.equal(view.continuation.allowed, false); assert.deepEqual(view.operatorActions.map((a) => a.kind), ['recovery'])
      const inspected = await host.inspect(t.sessionId)
      assert.equal(inspected.llmCalls, 0, 'nothing runs after the restart'); assert.equal(inspected.turnEnds.length, 1)
      const retry = await nexus(['continue', t.taskId, '--prompt', '[turn-2] inserted then crash', '--idempotency-key', 'crash-a-2', '--json'])
      assert.equal(retry.json.data && retry.json.data.replay, true, 'the accepted message keeps its receipt: ' + retry.stdout)
      const further = await nexus(['continue', t.taskId, '--prompt', '[turn-3] more', '--idempotency-key', 'crash-a-3', '--json'])
      assert.equal(further.json.error.code, 'TASK_NOT_CONTINUABLE')
      evidence.runs.crashTurnAccepted = { status: view.status, reason: view.statusReason, actions: view.operatorActions.map((a) => a.kind), llmCallsTurn1: callsAfterTurn1, llmCallsAfterRestart: inspected.llmCalls, further: further.json.error }
    }
    pass('SIGKILL after DSH insertion, before acceptance: held restored-input-not-resumed, never duplicated or run, close is the only action, retry returns the receipt, further turns refused')

    // 5. Crash during the model step of a continued turn: interrupted, never replayed.
    {
      const t = await submitTurn1('interrupted', repoA, 'engineering-v2', null)
      host.send('hold'); await host.next((m) => m.type === 'ack' && m.line === 'hold')
      const live = await nexus(['continue', t.taskId, '--prompt', '[turn-2] long running', '--idempotency-key', 'int-2', '--json'])
      assert.equal(live.code, 0, live.stdout)
      await waitFor(async () => (await host.report()).managedLive.includes(t.sessionId), 'live continued turn')
      const during = await nexus(['continue', t.taskId, '--prompt', '[turn-3] while live', '--idempotency-key', 'int-3', '--json'])
      assert.equal(during.json.error.code, 'TASK_NOT_CONTINUABLE'); assert.equal(during.json.error.details.reason, 'turn-live')
      await restart({}, true)
      const view = await statusOf(t.taskId)
      assert.equal(view.status, 'interrupted', JSON.stringify(view)); assert.deepEqual(view.operatorActions.map((a) => a.kind), ['recovery'])
      const refused = await nexus(['continue', t.taskId, '--prompt', '[turn-3] after crash', '--idempotency-key', 'int-3b', '--json'])
      assert.equal(refused.json.error.code, 'TASK_NOT_CONTINUABLE'); assert.equal(refused.json.error.details.reason, 'interrupted')
      await new Promise((r) => setTimeout(r, 1500))
      assert.equal((await host.inspect(t.sessionId)).llmCalls, 0, 'interrupted execution never replayed')
      evidence.runs.interruptedContinuation = { status: view.status, actions: view.operatorActions.map((a) => a.kind), duringLive: during.json.error, afterCrash: refused.json.error }
    }
    pass('crash during a continued turn\'s model step: continuation refused while live (turn-live), held interrupted after restart, close only, nothing replayed')

    // 6. Concurrency: duplicate keys over CLI+GUI, different keys, continuation vs verification.
    {
      const t = await submitTurn1('concurrent', repoA, 'engineering-v2', null)
      const text = '[turn-2] concurrent duplicate'
      const digest = 'sha256:' + crypto.createHash('sha256').update(text).digest('hex')
      let view = await statusOf(t.taskId)
      const [cliDup, guiDup] = await Promise.all([
        nexus(['continue', t.taskId, '--prompt', text, '--idempotency-key', 'dup', '--revision', view.revision, '--json']),
        owner.task('continueTask', { taskId: t.taskId, idempotencyKey: 'dup', expectedRevision: view.revision, prompt: { kind: 'text', text, digest } }),
      ])
      assert.equal(cliDup.json.ok && guiDup.ok, true, JSON.stringify([cliDup.json, guiDup]))
      assert.equal(cliDup.json.data.turnId, guiDup.data.turnId)
      await waitFor(async () => (await turnEndsOf(t.sessionId)) >= 2, 'dup turn')
      view = await statusOf(t.taskId)
      const verify = view.operatorActions.find((a) => a.kind === 'verification')
      const [contRace, verifyRace] = await Promise.all([
        nexus(['continue', t.taskId, '--prompt', '[turn-3] race', '--idempotency-key', 'race', '--revision', view.revision, '--json']),
        owner.task('respond', { taskId: t.taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' }),
      ])
      const winners = [contRace.json.ok ? 'continue' : null, verifyRace.ok ? 'verify' : null].filter(Boolean)
      assert.equal(winners.length, 1, 'exactly one transition wins: ' + JSON.stringify([contRace.json, verifyRace]))
      await new Promise((r) => setTimeout(r, 3000))
      const inspected = await host.inspect(t.sessionId)
      assert.equal(inspected.userPrompts.filter((p) => p === text).length, 1, 'the duplicate continuation was delivered once')
      evidence.runs.concurrency = { duplicateTurnIds: [cliDup.json.data.turnId, guiDup.data.turnId], raceWinner: winners[0], userPrompts: inspected.userPrompts }
    }
    pass('concurrency: CLI and GUI duplicates with one key deliver one turn; continuation vs run-verification at one revision — exactly one wins')
  }
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  try { console.error('host stderr tail: ' + host.stderr.slice(-1500)) } catch { /* none */ }
  for (const name of ['nexus-controller.log', 'aih-controller.log']) {
    try { console.error('--- ' + name + '\n' + fs.readFileSync(path.join(dataRoot, 'logs', name), 'utf8').split('\n').filter((l) => /turn|continu|refus|fail|error|park/i.test(l)).slice(-20).join('\n')) } catch { /* none */ }
  }
} finally {
  try { if (host) await host.stop() } catch { /* gone */ }
  setPreference(null)
  if (process.env.NEXUS_EVIDENCE_OUT) fs.writeFileSync(process.env.NEXUS_EVIDENCE_OUT, JSON.stringify(evidence, null, 2))
  if (exitCode === 0 || !process.env.NEXUS_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('scratch kept: ' + scratch)
}
console.log(`NexusTaskContinuation.RealHost (${mode}): ${passed} assertion groups passed.`)
process.exit(exitCode)
