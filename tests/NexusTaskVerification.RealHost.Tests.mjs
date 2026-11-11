// P2-B2D real-host proof: managed tasks reach (or are denied) authoritative
// completion through the shared Task API, using the EXISTING Nexus /verify
// pipeline (Verify-Project.ps1 + Engineering verification plan + Task.ps1
// evidence/failure/complete) via the plane bridge. Real child DSH hosts,
// real PowerShell controller scripts, real IPC + `nexus` CLI and the GUI task
// route; synthetic local model transport; blocked egress; no credential.
//
// Both modes: legacy GUI `/verify` on an ordinary session still works (parity
// reference). Patched mode (PoC gateway build): Muse and Dual managed
// verification to completion, failed verification, concurrent GUI+CLI
// responses, duplicate requests, verification after a host restart, an
// interrupted task closed safely, no additional inference.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-verification-'))
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
const env = { ...process.env, DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: path.join(root, 'app'), AIH_PWSH_HOST: path.join(root, 'runtime', 'pwsh', 'pwsh'), DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
delete env.NEXUS_IPC
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = { mode, platform: process.platform, arch: process.arch, runs: {} }
const settingsFile = path.join(dataRoot, 'nexus-settings.yaml')
const originalSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null
const setPreference = (profile) => { if (originalSettings !== null) fs.writeFileSync(settingsFile, profile === null ? originalSettings : originalSettings.replace(/^engineering-profile:.*$/m, 'engineering-profile: ' + profile)) }

function startHost() {
  const child = spawn(node, [path.join(root, 'tests', 'lib', 'NexusManagedHost.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
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

let host = null
let exitCode = 0
try {
  host = startHost()
  let ready = await host.next((m) => m.type === 'ready')
  let owner = await ownerClient(ready)
  const passing = makeRepo('pass', 0)
  for (const ws of [passing]) assert.equal((await nexus(['workspace', 'add', '--path', ws, '--json'])).code, 0)

  // ── Legacy GUI /verify parity (ordinary session, both modes) ──────────────
  {
    const created = await owner.api('session/create', { workspaceId: (await nexus(['workspace', 'add', '--path', passing, '--json'])).json.data.workspaceId, agentPreset: 'aih-muse' })
    const id = created.value.sessionId
    await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: 'Ordinary task turn.' }] })
    await waitFor(async () => (await host.inspect(id)).turnEnds.length >= 1, 'ordinary turn')
    const callsBefore = totalModelCalls(await host.report())
    await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: '/verify' }] })
    const after = await waitFor(async () => { const r = await host.inspect(id); return r.controllerNotices.some((n) => n.endsWith(':controller-verify-result')) ? r : null }, 'legacy verify notice')
    const binding = JSON.parse(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), 'utf8')).bindings[id]
    const legacyEvidence = evidenceOf(passing, binding.taskId)
    assert.ok(legacyEvidence && legacyEvidence.verification.some((c) => c.name === 'fixture-check' && c.status === 'PASS'), 'legacy /verify ran the declared check: ' + JSON.stringify(legacyEvidence))
    assert.equal(totalModelCalls(await host.report()), callsBefore, 'legacy /verify makes no model request')
    evidence.runs.legacyVerify = { notices: after.controllerNotices, checks: legacyEvidence.verification.map((c) => c.name + ':' + c.status), attempts: attemptsOf(passing, binding.taskId).map((a) => a.status) }
    pass('legacy GUI /verify parity: the ordinary-session command still runs the existing pipeline (declared check PASS, evidence written, verify notice), no model request')
  }

  if (mode === 'production') {
    const refused = await nexus(['submit', '--workspace', passing, '--mode', 'engineering-v2', '--prompt', 'x', '--idempotency-key', 'prod', '--json'])
    assert.equal(refused.code, 4); assert.equal(refused.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    pass('standard unpatched DSH: managed submission still refused fail-closed')
  } else {
    assert.equal(ready.activation.active, true, JSON.stringify(ready.activation))
    const failing = makeRepo('fail', 1)
    const passingDual = makeRepo('pass-dual', 0)
    for (const ws of [failing, passingDual]) assert.equal((await nexus(['workspace', 'add', '--path', ws, '--json'])).code, 0)
    async function executed(label, ws, modeId, preference) {
      setPreference(preference)
      const text = `Managed ${label}: add a line to README.md.`
      const submitted = await nexus(['submit', '--workspace', ws, '--mode', modeId, '--prompt', text, '--idempotency-key', 'p2b2d-' + label, '--json'])
      assert.equal(submitted.code, 0, label + ': ' + submitted.stdout + submitted.stderr)
      await waitFor(async () => (await host.inspect(submitted.json.data.sessionId)).turnEnds.length >= 1, label + ' turn')
      setPreference(null)
      return submitted.json.data
    }
    const statusOf = async (taskId) => (await nexus(['status', taskId, '--json'])).json.data

    // 1. Muse and Dual: verification to authoritative completion.
    for (const [label, ws, modeId, preference] of [['muse-pass', passing, 'engineering-v2', null], ['dual-pass', passingDual, 'engineering-v1', 'deepseek-codex']]) {
      const t = await executed(label, ws, modeId, preference)
      const before = await statusOf(t.taskId)
      assert.equal(before.statusReason, 'turn-completed-awaiting-verification', JSON.stringify(before))
      const verify = before.operatorActions.find((a) => a.kind === 'verification')
      assert.ok(verify, label + ': run-verification offered: ' + JSON.stringify(before.operatorActions))
      const guiView = (await owner.task('getStatus', { taskId: t.taskId })).data
      assert.deepEqual(guiView.operatorActions.map((a) => a.id), before.operatorActions.map((a) => a.id), label + ': GUI shows the same actions')
      const callsBefore = totalModelCalls(await host.report())
      const answered = await nexus(['respond', t.taskId, '--request', verify.id, '--choice', 'run', '--revision', verify.revision, '--json'])
      assert.equal(answered.code, 0, answered.stdout); assert.equal(answered.json.data.disposition, 'accepted')
      const waited = await nexus(['wait', t.taskId, '--timeout', '5m', '--json'])
      const final = waited.json.data
      const displayId = final.displayId || before.displayId
      const ev = evidenceOf(ws, displayId)
      assert.ok(ev && ev.verification.some((c) => c.name === 'fixture-check' && c.status === 'PASS'), label + ': real evidence recorded: ' + JSON.stringify(ev))
      assert.equal(final.taskVerification.state, 'passed', label + ': ' + JSON.stringify(final))
      const ledger = JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks.find((x) => x.taskId === displayId)
      if (final.taskVerification.completion && final.taskVerification.completion.complete) {
        assert.equal(final.status, 'completed'); assert.equal(waited.code, 0); assert.equal(ledger.status, 'complete', 'completion is the TaskController ledger\'s')
      } else {
        assert.equal(final.status, 'blocked'); assert.equal(final.statusReason, 'completion-denied'); assert.notEqual(ledger.status, 'complete')
      }
      assert.equal(totalModelCalls(await host.report()), callsBefore, label + ': verification makes no model request')
      const guiFinal = (await owner.task('getStatus', { taskId: t.taskId })).data
      assert.equal(guiFinal.status, final.status, label + ': GUI and CLI report the same outcome')
      const result = await nexus(['result', t.taskId])
      assert.match(result.stdout, /verification: passed/)
      evidence.runs[label] = { taskId: t.taskId, status: final.status, statusReason: final.statusReason || null, verification: final.taskVerification, ledgerStatus: ledger.status, attempts: attemptsOf(ws, displayId).map((a) => a.status), cliExit: waited.code }
    }
    pass('managed Muse + Dual: run-verification after the turn, same actions in GUI/CLI, the existing pipeline records real evidence, the TaskController decides the outcome, no model request')

    // 2. Failed verification (required check fails) never completes.
    {
      const t = await executed('muse-fail', failing, 'engineering-v2', null)
      const verify = (await statusOf(t.taskId)).operatorActions.find((a) => a.kind === 'verification')
      await nexus(['respond', t.taskId, '--request', verify.id, '--choice', 'run', '--revision', verify.revision, '--json'])
      const waited = await nexus(['wait', t.taskId, '--timeout', '5m', '--json'])
      const final = waited.json.data
      assert.equal(final.status, 'failed', JSON.stringify(final)); assert.equal(final.statusReason, 'verification-failed')
      assert.ok(final.taskVerification.failingChecks.includes('fixture-check'))
      assert.equal(waited.code, 5); assert.deepEqual(final.operatorActions, [])
      evidence.runs.failed = { status: final.status, statusReason: final.statusReason, failingChecks: final.taskVerification.failingChecks, cliExit: waited.code }
    }
    pass('failed required check: status failed / verification-failed (exit 5) with the failing check; no action can convert it into a pass')

    // 3. Concurrent GUI + CLI answers and duplicates; verification after restart.
    {
      const t = await executed('race', passing, 'engineering-v2', null)
      // Restart between the turn and the verification: the action is reconstructed.
      await host.stop()
      host = startHost()
      ready = await host.next((m) => m.type === 'ready')
      owner = await ownerClient(ready)
      const view = await statusOf(t.taskId)
      const verify = view.operatorActions.find((a) => a.kind === 'verification')
      assert.ok(verify, 'the verification action is reconstructed after a restart')
      const [gui, cli] = await Promise.all([
        owner.task('respond', { taskId: t.taskId, actionId: verify.id, expectedRevision: verify.revision, choiceId: 'run' }),
        nexus(['respond', t.taskId, '--request', verify.id, '--choice', 'run', '--revision', verify.revision, '--json']),
      ])
      const outcomes = [gui.ok ? gui.data.disposition : gui.error.code, cli.json.ok ? cli.json.data.disposition : cli.json.error.code]
      assert.equal(outcomes.filter((o) => o === 'accepted').length, 1, 'exactly one concurrent answer starts verification: ' + JSON.stringify(outcomes))
      const waited = await nexus(['wait', t.taskId, '--timeout', '5m', '--json'])
      const displayId = waited.json.data.displayId
      const verifyingRecords = attemptsOf(passing, displayId).filter((a) => a.status === 'verifying').length
      assert.equal(verifyingRecords, 1, 'verification ran once')
      const dup = await nexus(['respond', t.taskId, '--request', verify.id, '--choice', 'run', '--revision', verify.revision, '--json'])
      assert.equal(dup.json.data.disposition, 'duplicate')
      await host.stop()
      host = startHost()
      ready = await host.next((m) => m.type === 'ready')
      owner = await ownerClient(ready)
      const afterRestart = await statusOf(t.taskId)
      assert.equal(afterRestart.status, waited.json.data.status, 'status survives restart'); assert.equal(afterRestart.taskVerification.state, 'passed')
      assert.equal(attemptsOf(passing, displayId).filter((a) => a.status === 'verifying').length, 1, 'completed verification is not executed again after restart')
      evidence.runs.concurrency = { outcomes, statusAfterRestart: afterRestart.status, verifyingRecords }
    }
    pass('verification after restart: action reconstructed, concurrent GUI+CLI answers start it once, duplicates return the receipt, outcome survives the next restart without re-running')

    // 4. Interrupted execution: close only, no resume, no inference.
    {
      host.send('hold'); await host.next((m) => m.type === 'ack' && m.line === 'hold')
      const live = await nexus(['submit', '--workspace', passing, '--mode', 'engineering-v2', '--prompt', 'Interrupted managed task.', '--idempotency-key', 'p2b2d-interrupted', '--json'])
      await waitFor(async () => (await host.report()).managedLive.includes(live.json.data.sessionId), 'live turn')
      await host.kill()
      host = startHost()
      ready = await host.next((m) => m.type === 'ready')
      owner = await ownerClient(ready)
      const view = await statusOf(live.json.data.taskId)
      assert.equal(view.status, 'interrupted'); assert.deepEqual(view.operatorActions.map((a) => a.kind), ['recovery'], 'close only: no resume, no verification')
      const human = await nexus(['status', live.json.data.taskId])
      assert.match(human.stdout, /never resumed automatically/); assert.match(human.stdout, /nexus respond/)
      const close = view.operatorActions[0]
      const liveBinding = Object.values(JSON.parse(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), 'utf8')).bindings).find((b) => b.sessionId === live.json.data.sessionId)
      const attemptsBefore = liveBinding ? attemptsOf(passing, liveBinding.taskId) : []
      const openBefore = attemptsBefore.length > 0 && ['started', 'verifying'].includes(attemptsBefore[attemptsBefore.length - 1].status)
      const closed = await nexus(['respond', live.json.data.taskId, '--request', close.id, '--choice', 'close', '--revision', close.revision, '--json'])
      assert.equal(closed.json.data.disposition, 'closed', closed.stdout)
      const final = await statusOf(live.json.data.taskId)
      assert.equal(final.status, 'cancelled'); assert.equal(final.closed.attemptClosed, openBefore, 'an open attempt (if any) is closed as interrupted')
      if (openBefore) { const after = attemptsOf(passing, liveBinding.taskId); assert.equal(after[after.length - 1].status, 'interrupted') }
      await new Promise((r) => setTimeout(r, 1500))
      assert.equal((await host.inspect(live.json.data.sessionId)).llmCalls, 0, 'no model request after restart or close')
      assert.equal((await owner.api('session/rename', { sessionId: live.json.data.sessionId, title: 'x' })).reason, 'nexus-managed-session', 'the closed task\'s session stays managed')
      const replay = await nexus(['submit', '--workspace', passing, '--mode', 'engineering-v2', '--prompt', 'Interrupted managed task.', '--idempotency-key', 'p2b2d-interrupted', '--json'])
      assert.equal(replay.json.data.taskId, live.json.data.taskId, 'the protected key keeps the original task')
      evidence.runs.interrupted = { statusAfterRestart: view.status, actions: view.operatorActions.map((a) => a.kind), finalStatus: final.status, attemptOpenBefore: openBefore, attemptClosed: final.closed.attemptClosed }
    }
    pass('interrupted task after SIGKILL: close is the only action, CLI explains why execution cannot continue, closing interrupts the open attempt, nothing re-runs, session stays managed, key keeps the task')
  }
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  try { console.error('host stderr tail: ' + host.stderr.slice(-1500)) } catch { /* none */ }
  for (const name of ['nexus-controller.log', 'aih-controller.log']) {
    try { console.error('--- ' + name + '\n' + fs.readFileSync(path.join(dataRoot, 'logs', name), 'utf8').split('\n').filter((l) => /verif|close|fail|error|refus/i.test(l)).slice(-15).join('\n')) } catch { /* none */ }
  }
} finally {
  try { if (host) await host.stop() } catch { /* gone */ }
  if (process.env.NEXUS_EVIDENCE_OUT) fs.writeFileSync(process.env.NEXUS_EVIDENCE_OUT, JSON.stringify(evidence, null, 2))
  if (exitCode === 0 || !process.env.NEXUS_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('scratch kept: ' + scratch)
}
console.log(`NexusTaskVerification.RealHost (${mode}): ${passed} assertion groups passed.`)
process.exit(exitCode)
