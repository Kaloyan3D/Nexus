// P2-B2F real-host proof: review and visual gates through the shared Task
// API. Real child DSH hosts (pinned 0.2.2-rc.1), real PowerShell controller
// scripts (Review.ps1 / CodexReview.ps1, VisualLoop.ps1, Task.ps1, the
// controller gate journal), real IPC + `nexus` CLI and the GUI task route.
// Synthetic engineering model transport; the independent reviewer is a local
// synthetic HTTP endpoint (AIH_OAUTH_BASE_URL on 127.0.0.1) that returns a
// configured verdict and counts requests; blocked egress; no credential.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.env.NEXUS_TEST_GATEWAY || 'production'
const node = process.execPath
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-gates-'))
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
function makeRepo(name, exitCode, visualPolicy) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, name + '-')))
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n\nA small token helper library with tests.\n')
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'test'))
  fs.writeFileSync(path.join(dir, 'src', 'token.js'), "'use strict'\n// Issues and verifies opaque session tokens.\nconst crypto = require('node:crypto')\nfunction issue(userId) { return userId + '.' + crypto.randomBytes(8).toString('hex') }\nfunction verify(token) { return typeof token === 'string' && token.includes('.') }\nmodule.exports = { issue, verify }\n")
  fs.writeFileSync(path.join(dir, 'test', 'token.test.js'), "'use strict'\nconst assert = require('node:assert')\nconst { issue, verify } = require('../src/token.js')\nassert.ok(verify(issue('u1')))\n")
  fs.mkdirSync(path.join(dir, '.ai-harness'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.ai-harness', 'verification.yml'), [
    'version: 1', 'mode: replace', 'commands:',
    '  - name: fixture-check', '    kind: test', `    command: node -e "process.exit(${exitCode})"`, '    workingDirectory: .', '    required: true', '    timeoutSeconds: 120', '',
  ].join('\n'))
  if (visualPolicy) fs.writeFileSync(path.join(dir, '.ai-harness', 'visual-policy.json'), JSON.stringify(visualPolicy))
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'init')
  return dir
}
const env = { ...process.env, DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: path.join(root, 'app'), AIH_PWSH_HOST: path.join(root, 'runtime', 'pwsh', 'pwsh'), DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', NEXUS_TEST_ECHO_TURNS: '1' }
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



// Synthetic reviewer (the existing review client speaks the Responses shape).
const reviewer = { verdict: 'pass', requests: 0, hold: false, waiters: [] }
const reviewServer = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.method === 'GET' && req.url.startsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6-sol', object: 'model' }] })); return }
  if (req.method === 'POST' && req.url.startsWith('/responses')) {
    reviewer.requests += 1
    if (reviewer.hold) await new Promise((r) => reviewer.waiters.push(r))
    const text = JSON.stringify({ verdict: reviewer.verdict, summary: 'Synthetic review: ' + reviewer.verdict, findings: reviewer.verdict === 'fail' ? [{ severity: 'high', title: 'Synthetic blocking finding', detail: 'fixture' }] : [] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'resp_synthetic', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text, usage: { input_tokens: 1, output_tokens: 1 } }))
    return
  }
  res.writeHead(404); res.end()
})
await new Promise((r) => reviewServer.listen(0, '127.0.0.1', r))
env.AIH_OAUTH_BASE_URL = 'http://127.0.0.1:' + reviewServer.address().port

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
  const repoA = makeRepo('gates', 0)
  assert.equal((await nexus(['workspace', 'add', '--path', repoA, '--json'])).code, 0)

  // ── Ordinary GUI explicit /review on a Dual session (both modes) ─────────
  {
    setPreference('deepseek-codex')
    const workspaceId = (await nexus(['workspace', 'add', '--path', repoA, '--json'])).json.data.workspaceId
    const id = (await owner.api('session/create', { workspaceId, agentPreset: 'aih-engineering' })).value.sessionId
    await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: '[turn-1] Improve token verification in src/token.js.' }] })
    await waitFor(async () => (await host.inspect(id)).turnEnds.length >= 1, 'ordinary dual turn')
    const before = reviewer.requests
    const callsBefore = (await host.inspect(id)).llmCalls
    await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: '/review Is token verification correct?' }] })
    const after = await waitFor(async () => { const r = await host.inspect(id); return r.controllerNotices.some((n) => /:review-(result|error|context-quality)$/.test(n)) ? r : null }, 'ordinary review notice')
    const binding = JSON.parse(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), 'utf8')).bindings[id]
    const result = (() => { try { return JSON.parse(fs.readFileSync(path.join(repoA, '.ai-harness', 'runs', binding.taskId, 'review-result.json'), 'utf8')) } catch { return null } })()
    assert.ok(after.controllerNotices.some((n) => n.endsWith(':review-result')), 'ordinary /review produced a review result notice: ' + JSON.stringify(after.controllerNotices))
    assert.equal(result && result.verdict, 'pass'); assert.equal(reviewer.requests, before + 1, 'exactly one reviewer request')
    assert.equal((await host.inspect(id)).llmCalls, callsBefore, 'review makes no engineering model request')
    setPreference(null)
    evidence.runs.ordinaryReview = { notices: after.controllerNotices, verdict: result.verdict, reviewerRequests: reviewer.requests - before }
    pass('ordinary GUI /review on a Dual session: the existing review path runs unchanged (one reviewer request, review-result.json, no engineering model call)')
  }

  if (mode === 'production') {
    const refused = await nexus(['submit', '--workspace', repoA, '--mode', 'engineering-v1', '--prompt', 'x', '--idempotency-key', 'prod', '--json'])
    assert.equal(refused.code, 4); assert.equal(refused.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    const cont = await nexus(['continue', 'nt_' + '0'.repeat(32), '--prompt', 'x', '--revision', '1', '--json'])
    assert.equal(cont.code, 4); assert.equal(cont.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE')
    pass('standard unpatched DSH: managed submit and continue are refused fail-closed')
  } else {
    assert.equal(ready.activation.active, true, JSON.stringify(ready.activation))
    const statusOf = async (taskId) => { const r = await nexus(['status', taskId, '--json']); assert.ok(r.json && r.json.ok, r.stdout + r.stderr); return r.json.data }
    const actionOf = (view, kind) => view.operatorActions.find((a) => a.kind === kind)
    const respond = (taskId, a, choice) => nexus(['respond', taskId, '--request', a.id, '--choice', choice, '--revision', a.revision, '--json'])
    async function submitted(label, ws, modeId, preference) {
      setPreference(preference)
      const s = await nexus(['submit', '--workspace', ws, '--mode', modeId, '--prompt', `[turn-1] Make token verification correct and hardened (${label})`, '--idempotency-key', 'p2b2f-' + label, '--json'])
      assert.equal(s.code, 0, label + ': ' + s.stdout + s.stderr)
      await waitFor(async () => (await host.inspect(s.json.data.sessionId)).turnEnds.length >= 1, label + ' turn 1')
      // The engine's profile stays active while its task is worked on (the
      // explicit review re-routes against the active profile, as in the GUI).
      return s.json.data
    }
    const reviewSettled = (taskId) => waitFor(async () => { const v = await statusOf(taskId); return v.statusReason !== 'review-running' ? v : null }, 'review settled', 240000)
    const journalFor = (sessionId) => { try { return fs.readFileSync(path.join(dataRoot, 'completion', 'gates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.sessionId === sessionId) } catch { return [] } }

    // 1. Dual: review action -> verdict PASS -> verification -> completed.
    {
      reviewer.verdict = 'pass'
      const t = await submitted('dual-pass', repoA, 'engineering-v1', 'deepseek-codex')
      let view = await statusOf(t.taskId)
      assert.equal(view.gates.review.policy, 'independent-review')
      const review = actionOf(view, 'review')
      assert.ok(review && actionOf(view, 'verification'), JSON.stringify(view.operatorActions))
      const guiView = (await owner.task('getStatus', { taskId: t.taskId })).data
      assert.deepEqual(guiView.operatorActions.map((a) => a.id), view.operatorActions.map((a) => a.id), 'GUI shows the same actions')
      const before = reviewer.requests
      const llmBefore = (await host.inspect(t.sessionId)).llmCalls
      assert.equal((await respond(t.taskId, review, 'run')).json.data.disposition, 'accepted')
      view = await reviewSettled(t.taskId)
      assert.equal(view.gates.review.state, 'passed', JSON.stringify(view.gates)); assert.equal(view.gates.review.current, true)
      assert.equal(reviewer.requests, before + 1, 'one reviewer request')
      const verify = actionOf(view, 'verification')
      assert.equal((await respond(t.taskId, verify, 'run')).json.data.disposition, 'accepted')
      const waited = await nexus(['wait', t.taskId, '--timeout', '5m', '--json'])
      assert.equal(waited.json.data.status, 'completed', JSON.stringify(waited.json.data)); assert.equal(waited.code, 0)
      assert.equal((await host.inspect(t.sessionId)).llmCalls, llmBefore, 'review + verification make no engineering model request')
      const human = await nexus(['result', t.taskId])
      assert.match(human.stdout, /review: passed \(verdict pass\)/)
      assert.match(human.stdout, /review basis: independent reviewer PASS/)
      assert.equal(waited.json.data.completionProvenance.reviewBasis, 'reviewer-pass'); assert.equal(waited.json.data.completionProvenance.authority, 'task-controller')
      evidence.runs.dualPass = { taskId: t.taskId, review: view.gates.review, final: waited.json.data.status, reviewerRequests: reviewer.requests - before, ledger: JSON.parse(fs.readFileSync(path.join(repoA, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks.find((x) => x.taskId === waited.json.data.displayId).status }
    }
    pass('managed Dual: run-review (existing reviewer, one request) -> verdict PASS for the current candidate -> verification -> TaskController completed; same actions in GUI and CLI; no engineering model call')

    // 2. Muse: no independent reviewer (typed), nothing invented.
    {
      const t = await submitted('muse-policy', repoA, 'engineering-v2', null)
      const view = await statusOf(t.taskId)
      assert.equal(view.gates.review.policy, 'unavailable-for-engine'); assert.equal(actionOf(view, 'review'), undefined)
      const before = reviewer.requests
      const forged = await nexus(['respond', t.taskId, '--request', 'act_review_' + t.taskId.slice(3, 15) + '_t1_n1', '--choice', 'run', '--revision', view.revision, '--json'])
      assert.equal(forged.code, 4); assert.equal(forged.json.error.code, 'STALE_ACTION')
      assert.equal(reviewer.requests, before)
      const human = await nexus(['status', t.taskId])
      assert.match(human.stdout, /review: not available for this engine/)
      const close = actionOf(view, 'recovery')
      await respond(t.taskId, close, 'close')
      evidence.runs.musePolicy = { policy: view.gates.review.policy, actions: view.operatorActions.map((a) => a.kind), forged: forged.json.error.code }
    }
    pass('managed Muse: review policy unavailable-for-engine, no review action, a forged review action is refused (exit 4), no reviewer request')

    // 3. Dual review FAIL -> verification -> the existing gate (concurrent GUI + CLI approve).
    {
      reviewer.verdict = 'fail'
      const repoG = makeRepo('gate', 0)
      assert.equal((await nexus(['workspace', 'add', '--path', repoG, '--json'])).code, 0)
      const t = await submitted('dual-gate', repoG, 'engineering-v1', 'deepseek-codex')
      let view = await statusOf(t.taskId)
      await respond(t.taskId, actionOf(view, 'review'), 'run')
      view = await reviewSettled(t.taskId)
      assert.equal(view.gates.review.state, 'failed', JSON.stringify(view.gates))
      assert.equal(actionOf(view, 'gate'), undefined, 'no gate action before verification')
      await respond(t.taskId, actionOf(view, 'verification'), 'run')
      view = await waitFor(async () => { const v = await statusOf(t.taskId); return v.status !== 'verifying' ? v : null }, 'verification')
      assert.equal(view.statusReason, 'review-gate-pending', JSON.stringify(view))
      const gate = actionOf(view, 'gate')
      const [cliAnswer, guiAnswer] = await Promise.all([
        respond(t.taskId, gate, 'approve'),
        owner.task('respond', { taskId: t.taskId, actionId: gate.id, expectedRevision: gate.revision, choiceId: 'approve' }),
      ])
      const outcomes = [cliAnswer.json.ok ? cliAnswer.json.data.disposition : cliAnswer.json.error.code, guiAnswer.ok ? guiAnswer.data.disposition : guiAnswer.error.code]
      assert.equal(outcomes.filter((o) => o === 'resolved').length, 1, JSON.stringify(outcomes))
      const final = await statusOf(t.taskId)
      assert.equal(final.status, 'completed', JSON.stringify(final))
      const journal = journalFor(t.sessionId)
      assert.deepEqual(journal.map((r) => r.status), ['waiting', 'approved'], JSON.stringify(journal))
      assert.equal(journal[1].resolvedBy, 'operator-task-api')
      // Provenance: an operator override of a reviewer FAIL, never a reviewer PASS.
      assert.equal(final.gates.review.verdict, 'fail'); assert.equal(final.gates.review.disposition, 'operator-override-of-reviewer-fail')
      assert.equal(final.completionProvenance.reviewBasis, 'operator-override-of-reviewer-fail'); assert.equal(final.completionProvenance.gate.resolvedBy, 'operator-task-api')
      const guiFinal = (await owner.task('getStatus', { taskId: t.taskId })).data
      assert.deepEqual(guiFinal.completionProvenance, final.completionProvenance, 'GUI shows the same provenance')
      const humanFinal = await nexus(['result', t.taskId])
      assert.match(humanFinal.stdout, /operator OVERRIDE of an independent reviewer FAIL/); assert.doesNotMatch(humanFinal.stdout, /independent reviewer PASS/)
      const reviewFile = JSON.parse(fs.readFileSync(path.join(repoG, '.ai-harness', 'runs', final.displayId, 'review-result.json'), 'utf8'))
      assert.equal(reviewFile.verdict, 'fail', 'the reviewer evidence on disk still says FAIL')
      evidence.runs.dualGateProvenance = { reviewVerdict: reviewFile.verdict, disposition: final.gates.review.disposition, completionProvenance: final.completionProvenance, cliLine: humanFinal.stdout.split('\n').filter((l) => /review basis|completed by/.test(l)) }
      evidence.runs.dualGate = { taskId: t.taskId, outcomes, journal: journal.map((r) => ({ status: r.status, revision: r.revision, resolvedBy: r.resolvedBy || null, reviewVerdict: r.reviewVerdict || null })), final: final.status }
      reviewer.verdict = 'pass'
    }
    pass('managed Dual review FAIL: gate offered only after verification passed; concurrent CLI + GUI approve resolve the existing gate exactly once (journal waiting -> approved by operator-task-api); TaskController completion follows the Control Room policy')

    // 4. Multi-turn: a turn-1 review never certifies turn 2.
    {
      const repoM = makeRepo('multi', 0)
      assert.equal((await nexus(['workspace', 'add', '--path', repoM, '--json'])).code, 0)
      const t = await submitted('dual-multi', repoM, 'engineering-v1', 'deepseek-codex')
      let view = await statusOf(t.taskId)
      await respond(t.taskId, actionOf(view, 'review'), 'run')
      view = await reviewSettled(t.taskId)
      assert.equal(view.gates.review.state, 'passed')
      const c2 = await nexus(['continue', t.taskId, '--prompt', '[turn-2] also reject empty user ids', '--idempotency-key', 'multi-2', '--json'])
      assert.equal(c2.code, 0, c2.stdout + c2.stderr)
      await waitFor(async () => (await host.inspect(t.sessionId)).turnEnds.length >= 2, 'turn 2')
      view = await statusOf(t.taskId)
      assert.equal(view.gates.review.current, false, JSON.stringify(view.gates))
      assert.ok(actionOf(view, 'review'), 'a review of the new candidate is offered')
      await respond(t.taskId, actionOf(view, 'verification'), 'run')
      view = await waitFor(async () => { const v = await statusOf(t.taskId); return v.status !== 'verifying' ? v : null }, 'verification')
      assert.equal(view.status, 'blocked'); assert.equal(view.statusReason, 'review-required', JSON.stringify(view))
      const ledger = JSON.parse(fs.readFileSync(path.join(repoM, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks.find((x) => x.taskId === view.displayId)
      assert.notEqual(ledger.status, 'complete', 'a stale review never completes a newer candidate')
      evidence.runs.multiTurnStale = { status: view.status, reason: view.statusReason, completion: view.taskVerification.completion, ledger: ledger.status }
    }
    pass('multi-turn: a review of turn 1 is stale for turn 2 (new review action offered); verifying turn 2 without re-review is denied (review-required) — no completion with stale review evidence')

    // 5. Visual requirement: deferred to the operator's verification, then
    //    unavailable in this environment -> blocked, never a fabricated PASS.
    {
      const repoV = makeRepo('visual', 0, { requirement: 'required' })
      assert.equal((await nexus(['workspace', 'add', '--path', repoV, '--json'])).code, 0)
      const t = await submitted('dual-visual', repoV, 'engineering-v1', 'deepseek-codex')
      await new Promise((r) => setTimeout(r, 2000))
      let view = await statusOf(t.taskId)
      assert.equal(view.statusReason, 'turn-completed-awaiting-verification', 'no automatic verification between managed turns: ' + JSON.stringify(view))
      assert.equal(view.taskVerification, undefined); assert.equal(view.attemptId && (await statusOf(t.taskId)).operatorActions.some((a) => a.kind === 'verification'), true)
      const visualBeforeVerify = view.gates.visual
      await respond(t.taskId, actionOf(view, 'verification'), 'run')
      view = await waitFor(async () => { const v = await statusOf(t.taskId); return v.status !== 'verifying' ? v : null }, 'visual verification', 300000)
      assert.equal(view.status, 'blocked', JSON.stringify(view)); assert.match(view.statusReason, /^visual-/)
      assert.deepEqual(view.operatorActions.map((a) => a.kind), ['recovery'], 'close only — no invented visual action')
      const ledger = JSON.parse(fs.readFileSync(path.join(repoV, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks.find((x) => x.taskId === view.displayId)
      assert.notEqual(ledger.status, 'complete')
      const human = await nexus(['status', t.taskId])
      assert.match(human.stdout, /visual verification: required/)
      const controllerLog = (() => { try { return fs.readFileSync(path.join(dataRoot, 'logs', 'aih-controller.log'), 'utf8').split('\n').filter((l) => l.includes(t.sessionId) || l.includes(view.displayId)) } catch { return [] } })()
      assert.ok(controllerLog.some((l) => l.includes('managed-visual-required-deferred')), 'the Dual turn-end visual auto-verification was deferred for the managed task')
      assert.equal(visualBeforeVerify && visualBeforeVerify.required, true, 'the requirement is detected and shown before verification')
      evidence.runs.visual = { deferredEvents: controllerLog.filter((l) => l.includes('managed-visual-required-deferred')).length, autoVisualEvents: controllerLog.filter((l) => l.includes('automatic-visual')).length, visualBeforeVerify, reason: view.statusReason, visual: view.gates.visual, completion: view.taskVerification.completion, ledger: ledger.status, actions: view.operatorActions.map((a) => a.kind) }
    }
    pass('visual-required managed Dual task: the turn-end visual auto-verification is deferred (requirement detected and shown, attempt open, no verification record); the operator\'s verification runs the controller-owned visual loop; evidence unavailable here -> blocked with a typed visual reason, close only, ledger not complete')

    // 6. Restart during review: never re-run automatically, never counted.
    {
      const repoR = makeRepo('restart', 0)
      assert.equal((await nexus(['workspace', 'add', '--path', repoR, '--json'])).code, 0)
      const t = await submitted('dual-restart', repoR, 'engineering-v1', 'deepseek-codex')
      let view = await statusOf(t.taskId)
      reviewer.hold = true
      const before = reviewer.requests
      await respond(t.taskId, actionOf(view, 'review'), 'run')
      await waitFor(async () => reviewer.requests > before, 'reviewer request in flight', 240000)
      await restart({}, true)
      reviewer.hold = false
      for (const w of reviewer.waiters.splice(0)) w()
      await new Promise((r) => setTimeout(r, 4000))
      view = await statusOf(t.taskId)
      assert.equal(view.gates.review.state, 'interrupted', JSON.stringify(view.gates))
      assert.equal(reviewer.requests, before + 1, 'no automatic second reviewer request')
      const rerun = actionOf(view, 'review')
      assert.ok(rerun && /_n2$/.test(rerun.id), 'explicit re-run offered: ' + JSON.stringify(view.operatorActions))
      // Even if the orphaned reviewer process wrote a verdict, it does not count.
      await respond(t.taskId, actionOf(view, 'verification'), 'run')
      view = await waitFor(async () => { const v = await statusOf(t.taskId); return v.status !== 'verifying' ? v : null }, 'verification')
      assert.notEqual(view.status, 'completed', 'an interrupted review never certifies the candidate: ' + JSON.stringify(view))
      evidence.runs.restartDuringReview = { review: view.gates.review, reviewerRequests: reviewer.requests - before, status: view.status, reason: view.statusReason }
    }
    pass('restart during review: interrupted, no automatic second reviewer request, explicit re-run offered, and a verdict written by the orphaned reviewer never certifies the candidate')
  }
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  try { console.error('host stderr tail: ' + host.stderr.slice(-1500)) } catch { /* none */ }
  for (const name of ['nexus-controller.log', 'aih-controller.log']) {
    try { console.error('--- ' + name + '\n' + fs.readFileSync(path.join(dataRoot, 'logs', name), 'utf8').split('\n').filter((l) => /review|gate|visual|refus|fail|error/i.test(l)).slice(-25).join('\n')) } catch { /* none */ }
  }
} finally {
  try { if (host) await host.stop() } catch { /* gone */ }
  reviewServer.close()
  setPreference(null)
  if (process.env.NEXUS_EVIDENCE_OUT) fs.writeFileSync(process.env.NEXUS_EVIDENCE_OUT, JSON.stringify(evidence, null, 2))
  if (exitCode === 0 || !process.env.NEXUS_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('scratch kept: ' + scratch)
}
console.log(`NexusTaskGates.RealHost (${mode}): ${passed} assertion groups passed.`)
process.exit(exitCode)
