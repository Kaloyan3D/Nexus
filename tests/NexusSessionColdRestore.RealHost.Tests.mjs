// P2-B2C real-host proof: fresh Nexus engineering sessions are durably
// readable and resumable under pinned DSH 0.2.2 (format v4).
//
// For EMv1 Dual (aih-engineering) and EMv2 Muse (aih-muse) ordinary Web
// sessions: first turn through the supported path (owner session/create +
// session/prompt, real bridge, real PowerShell controller scripts) → flush →
// complete host shutdown → audit the stored log with DSH's own reader → fresh
// host process → second turn on the SAME session (DSH resumes it from disk) →
// verify task identity, history, model binding and attempts → another restart.
// With NEXUS_TEST_GATEWAY=patched (PoC root) the managed path is exercised too.
// Synthetic local model transport, blocked egress, placeholder credential.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cold-restore-'))
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
const evidence = { mode, platform: process.platform, arch: process.arch, runs: {} }
const settingsFile = path.join(dataRoot, 'nexus-settings.yaml')
const originalSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null
// null keeps the installation's own preference (the Muse preset's configured profile).
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
  async function next(predicate, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = lines.findIndex(predicate)
      if (index >= 0) return lines.splice(index, 1)[0]
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('host message timeout/exit; stderr: ' + stderr.slice(-1500))
      await Promise.race([new Promise((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 200))])
    }
  }
  return {
    next,
    async inspect(id) { child.stdin.write('inspect ' + id + '\n'); return next((m) => m.type === 'inspect' && m.sessionId === id) },
    async stop() { if (child.exitCode === null) { child.stdin.write('exit\n'); await exited } },
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
  }
}
const waitFor = async (fn, label, timeoutMs = 90000) => { const deadline = Date.now() + timeoutMs; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error('timeout: ' + label); await new Promise((r) => setTimeout(r, 300)) } }
const readBindings = () => { try { return JSON.parse(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), 'utf8')).bindings || {} } catch { return {} } }
const ledgerTasks = (ws) => { try { return JSON.parse(fs.readFileSync(path.join(ws, '.ai-harness', 'state', 'tasks.json'), 'utf8')).tasks || [] } catch { return [] } }
const attemptsOf = (ws, displayId) => { try { return fs.readFileSync(path.join(ws, '.ai-harness', 'runs', displayId, 'attempts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
function audit() {
  const out = execFileSync(node, [path.join(root, 'scripts', 'NexusSessionAudit.cjs'), '--data', dataRoot, '--app', path.join(root, 'app'), '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  return JSON.parse(out)
}
function auditAllowingHeld() {
  try { return audit() } catch (error) { return JSON.parse(String(error.stdout)) }
}

async function ordinaryRun(label, preset, profile) {
  setPreference(profile)
  const workspace = makeRepo(label)
  let host = startHost()
  let ready = await host.next((m) => m.type === 'ready')
  let owner = await ownerClient(ready)
  const ws = await owner.api('workspace/create', { path: workspace })
  const workspaceId = ws.value && ws.value.workspace && ws.value.workspace.workspaceId
  assert.ok(workspaceId, label + ': workspace registered')
  const created = await owner.api('session/create', { workspaceId, agentPreset: preset })
  assert.equal(created.ok, true, label + ': session created ' + JSON.stringify(created))
  const sessionId = created.value.sessionId
  const turn1 = await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'First turn: add a CHANGELOG entry.' }] })
  assert.equal(turn1.ok, true, label + ': first prompt accepted')
  const first = await waitFor(async () => { const r = await host.inspect(sessionId); return r.turnEnds.length >= 1 ? r : null }, label + ' first turn end')
  assert.equal(first.readable, true, label + ': first-turn log readable by DSH while live: ' + first.readError)
  assert.equal(first.firstSurface.type, 'system/message', label + ': the protected system head is the first surface event: ' + JSON.stringify(first.surfaceOrder))
  assert.deepEqual(first.retiredSourceSeqs, [], label + ': no retired source kind')
  assert.ok(first.controllerNotices.length >= 1, label + ': the first-turn Controller notice is still published: ' + JSON.stringify(first))
  const binding1 = readBindings()[sessionId]
  assert.ok(binding1 && binding1.taskInstanceId, label + ': task bound on the first turn')
  const tasks1 = ledgerTasks(workspace)
  const attempts1 = attemptsOf(workspace, binding1.taskId)
  await host.stop()
  // Complete shutdown; audit the stored log with DSH's own reader (on a copy).
  const audit1 = auditAllowingHeld().sessions.find((s) => s.sessionId === sessionId)
  assert.equal(audit1.class, 'valid', label + ': stored log audits valid after shutdown: ' + JSON.stringify(audit1))
  // Fresh host process: same session, second turn (DSH resumes it from disk).
  host = startHost()
  ready = await host.next((m) => m.type === 'ready')
  owner = await ownerClient(ready)
  const cold = await host.inspect(sessionId)
  assert.equal(cold.readable, true, label + ': cold read in a fresh host: ' + cold.readError)
  const turn2 = await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Second turn: also update the README.' }] })
  assert.equal(turn2.ok, true, label + ': second prompt accepted on the resumed session ' + JSON.stringify(turn2))
  const second = await waitFor(async () => { const r = await host.inspect(sessionId); return r.turnEnds.length >= 2 ? r : null }, label + ' second turn end')
  assert.equal(second.readable, true)
  assert.deepEqual(second.userPrompts, ['First turn: add a CHANGELOG entry.', 'Second turn: also update the README.'], label + ': history carries both turns in order')
  assert.equal(second.llmCalls, 1, label + ': the fresh host made exactly one model request (second turn only)')
  const binding2 = readBindings()[sessionId]
  assert.equal(binding2.taskInstanceId, binding1.taskInstanceId, label + ': task identity survives the restart')
  assert.equal(binding2.engine, binding1.engine); assert.equal(binding2.preset, binding1.preset)
  assert.equal(ledgerTasks(workspace).length, tasks1.length, label + ': no duplicate task')
  const attempts2 = attemptsOf(workspace, binding1.taskId)
  assert.ok(attempts2.length >= attempts1.length, label + ': attempt history is append-only')
  assert.ok(!ledgerTasks(workspace).some((t) => t.taskInstanceId === binding1.taskInstanceId && t.status === 'complete'), label + ': no inferred success (a finished turn never completes the task)')
  assert.deepEqual(second.modelSelections.slice(0, first.modelSelections.length), first.modelSelections, label + ': model binding unchanged')
  await host.stop()
  // Repeated restart: still readable.
  host = startHost()
  await host.next((m) => m.type === 'ready')
  const again = await host.inspect(sessionId)
  assert.equal(again.readable, true, label + ': readable after a second restart')
  await host.stop()
  const audit2 = auditAllowingHeld().sessions.find((s) => s.sessionId === sessionId)
  assert.equal(audit2.class, 'valid')
  evidence.runs[label] = { sessionId, first: { surfaceOrder: first.surfaceOrder, notices: first.controllerNotices, turnEnds: first.turnEnds }, cold: { readable: cold.readable, dshEvents: cold.dshEvents }, second: { userPrompts: second.userPrompts, turnEnds: second.turnEnds, llmCalls: second.llmCalls, notices: second.controllerNotices }, binding: { taskId: binding1.taskId, taskInstanceId: binding1.taskInstanceId, engine: binding1.engine }, attempts: { before: attempts1.length, after: attempts2.length }, audit: audit2.class }
  if (originalSettings !== null) fs.writeFileSync(settingsFile, originalSettings)
}

let exitCode = 0
try {
  await ordinaryRun('emv2-muse', 'aih-muse', null)
  pass('EMv2 Muse ordinary session: first turn, flush, full shutdown, valid audit, fresh-host cold read, second turn on the same session, identity/history/model/attempts intact, readable after a repeated restart')
  await ordinaryRun('emv1-dual', 'aih-engineering', 'deepseek-codex')
  pass('EMv1 Dual ordinary session: first turn, flush, full shutdown, valid audit, fresh-host cold read, second turn on the same session, identity/history/model/attempts intact, readable after a repeated restart')

  if (mode === 'patched') {
    // Managed sessions (PoC gateway): durable, resumable, still one admitted turn.
    const workspace = makeRepo('managed')
    let host = startHost()
    let ready = await host.next((m) => m.type === 'ready')
    assert.equal(ready.activation.active, true, JSON.stringify(ready.activation))
    let owner = await ownerClient(ready)
    await owner.api('workspace/create', { path: workspace })
    const run = (args) => new Promise((resolve) => {
      const cli = path.join(installRoot, 'scripts', 'nexus-cli.cjs')
      const child = spawn(node, ['-e', `require(${JSON.stringify(cli)}).run(process.argv.slice(1),{installRoot:${JSON.stringify(installRoot)},dataRoot:${JSON.stringify(dataRoot)},cwd:${JSON.stringify(workspace)},stdout:(t)=>process.stdout.write(t),stderr:(t)=>process.stderr.write(t),readStdin:()=>Buffer.alloc(0)}).then((c)=>{process.exitCode=c})`, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; child.stdout.on('data', (c) => { stdout += c }); child.on('exit', (code) => { let json = null; try { json = JSON.parse(stdout) } catch { /* */ } resolve({ code, json }) })
    })
    const results = {}
    for (const [label, modeId, profile] of [['managed-emv2', 'engineering-v2', null], ['managed-emv1', 'engineering-v1', 'deepseek-codex']]) {
      setPreference(profile)
      const submitted = await run(['submit', '--workspace', workspace, '--mode', modeId, '--prompt', label + ' task', '--idempotency-key', label, '--json'])
      assert.equal(submitted.code, 0, label + ' submit ' + JSON.stringify(submitted.json))
      const sessionId = submitted.json.data.sessionId
      const first = await waitFor(async () => { const r = await host.inspect(sessionId); return r.turnEnds.length >= 1 ? r : null }, label + ' turn end')
      assert.equal(first.firstSurface.type, 'system/message', label + ': protected head first: ' + JSON.stringify(first.surfaceOrder))
      assert.equal(first.readable, true)
      results[label] = { taskId: submitted.json.data.taskId, sessionId, first }
    }
    if (originalSettings !== null) fs.writeFileSync(settingsFile, originalSettings)
    await host.stop()
    host = startHost()
    ready = await host.next((m) => m.type === 'ready')
    owner = await ownerClient(ready)
    for (const [label, r] of Object.entries(results)) {
      const cold = await host.inspect(r.sessionId)
      assert.equal(cold.readable, true, label + ': managed session cold-readable: ' + cold.readError)
      const state = await owner.api('session/state', { sessionId: r.sessionId })
      assert.equal(state.ok, true, label + ': the managed session resumes for reads in a fresh host ' + JSON.stringify(state))
      const status = await run(['status', r.taskId, '--json'])
      assert.equal(status.json.data.taskId, r.taskId, label + ': managed identity restored')
      const prompt = await owner.api('session/prompt', { requestId: crypto.randomUUID(), sessionId: r.sessionId, mode: 'queue', content: [{ type: 'text', text: 'x' }] })
      assert.equal(prompt.reason, 'nexus-managed-session', label + ': a direct GUI prompt stays mediated (further turns only through the Task API continueTask)')
      evidence.runs[label] = { surfaceOrder: r.first.surfaceOrder, coldReadable: cold.readable, status: status.json.data.status }
    }
    await host.stop()
    pass('managed EMv2 and EMv1 sessions (PoC gateway): protected head first, cold-readable and resumable for reads in a fresh host, identity restored, further turns still mediated')
  }
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  for (const name of ['aih-controller.log', 'nexus-controller.log']) {
    try { console.error('--- ' + name + '\n' + fs.readFileSync(path.join(dataRoot, 'logs', name), 'utf8').split('\n').filter((l) => /fail|error|refus|reject|notice/i.test(l)).slice(-15).join('\n')) } catch { /* none */ }
  }
} finally {
  if (process.env.NEXUS_EVIDENCE_OUT) fs.writeFileSync(process.env.NEXUS_EVIDENCE_OUT, JSON.stringify(evidence, null, 2))
  if (exitCode === 0 || !process.env.NEXUS_KEEP_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('scratch kept: ' + scratch)
}
console.log(`NexusSessionColdRestore.RealHost (${mode}): ${passed} assertion groups passed.`)
process.exit(exitCode)
