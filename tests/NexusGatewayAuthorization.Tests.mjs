// P2-B2A: real-host security proof for the PROPOSED DSH `gateway/authorize`
// hook. Runs ONLY against an installation whose DSH gateway carries the
// prototype hook (disposable PoC root); on pinned DSH 0.2.2 it reports the
// hook as absent and fails. NOT part of the production lane.
//
// Owner peer over real HTTP (launch-token cookie) and the gateway's own
// stream / $events entry points with a real owner Peer. Every protected row
// compares a before/after snapshot of durable session events, titles, the
// workspace registry, jobs, schedules and protected task/evidence artifacts,
// and requires DSH's own `remote-access/denied` refusal.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = path.join(root, 'app')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gateway-authz-'))
const installRoot = path.join(scratch, 'install')
fs.mkdirSync(installRoot)
for (const entry of fs.readdirSync(root)) if (entry !== 'data') fs.symlinkSync(path.join(root, entry), path.join(installRoot, entry))
const dataRoot = path.join(installRoot, 'data')
fs.mkdirSync(dataRoot)
for (const name of ['cordis.patch.yml', 'nexus-settings.yaml', 'Routing-Integrity.cjs', 'OpenCode-SessionHeader.cjs']) if (fs.existsSync(path.join(root, 'data', name))) fs.copyFileSync(path.join(root, 'data', name), path.join(dataRoot, name))
if (fs.existsSync(path.join(root, 'data', 'profiles'))) fs.cpSync(path.join(root, 'data', 'profiles'), path.join(dataRoot, 'profiles'), { recursive: true })
const workspace = fs.mkdtempSync(path.join(scratch, 'ws-'))
const otherWorkspace = fs.mkdtempSync(path.join(scratch, 'ws2-'))
fs.mkdirSync(path.join(workspace, '.ai-harness', 'runs', 'TASK-0001'), { recursive: true })
fs.writeFileSync(path.join(workspace, '.ai-harness', 'runs', 'TASK-0001', 'evidence.json'), JSON.stringify({ attempt: 1, verification: [{ name: 'protected', status: 'PASS' }] }))
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')
const fake = createFakePwshHost(path.join(scratch, 'pwsh')); fake.install(); fake.respond({ '*': { json: {} } })
Object.assign(process.env, { DSH_HOME: dataRoot, AIH_INSTALL_ROOT: installRoot, AIH_HOST_APP: appDir, NEXUS_IPC: '0', DEEPSEEK_API_KEY: 'probe-not-a-credential', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' })
const appRequire = createRequire(path.join(appDir, 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)
const sessionEvents = require('../config/Dsh-SessionEvents.cjs').sessionEvents
const { createNexusGatewayPolicy } = require('./lib/NexusGatewayPolicy.cjs')
const { Peer } = await load('@deepseek-ai/dsh-client-connection')
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = { dsh: appRequire('@deepseek-ai/dsh/package.json').version, rows: [], scenarios: {} }

async function boot() {
  const { runProfile } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh/profile-boot')).href)
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const booted = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'] })
  const controller = booted.ctx.get('nexusController')
  for (let i = 0; i < 400 && controller.ownership.state === 'not-acquired'; i += 1) await new Promise((r) => setTimeout(r, 10))
  return booted
}

let booted = await boot()
let ctx = booted.ctx
let exitCode = 0
try {
  const gateway = ctx.get('typertGateway')
  assert.equal(typeof gateway.authorizeOperation, 'function', 'this installation carries the prototype gateway/authorize hook (PoC root only)')
  let controller = ctx.get('nexusController')
  assert.equal(controller.ownership.state, 'held')
  let llmCalls = 0
  ctx.on('llm/stream', () => { llmCalls += 1; throw new Error('test transport: model requests are blocked') }, { prepend: true })

  const base = `http://127.0.0.1:${ctx.get('webServer').port}/`
  const minted = await fetch(ctx.get('connection').authenticatedUrl(base), { redirect: 'manual' })
  const cookie = (minted.headers.get('set-cookie') || '').split(';')[0]
  const call = async (endpoint, args, raw = false) => {
    const response = await fetch(base + 'api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base.slice(0, -1) }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args: raw ? args : { request: args } } }) })
    const text = await response.text(); let body; try { body = JSON.parse(text) } catch { body = { raw: text } }
    const result = body && body.result
    return { status: response.status, ok: Boolean(result && result.ok), code: result && result.error ? result.error.code : null, reason: result && result.error && result.error.details ? result.error.details.reason : null, value: result && result.value }
  }
  const sessions = () => ctx.get('sessions')
  const registry = () => ctx.get('workspaceRegistry')
  const ws = await call('workspace/create', { path: workspace })
  const workspaceId = ws.value && ws.value.workspace && ws.value.workspace.workspaceId
  assert.ok(workspaceId, 'workspace registered: ' + JSON.stringify(ws).slice(0, 400))
  const mk = async () => (await call('session/create', { workspaceId })).value.sessionId
  const M = await mk(); const U = await mk()
  const U2 = (await call('session/create', { cwd: otherWorkspace })).value.sessionId
  // Give each session a live agent (the bridge refuses the synthetic turn: no model call).
  for (const id of [M, U, U2]) await call('session/prompt', { requestId: crypto.randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: 'hello' }] })
  await new Promise((r) => setTimeout(r, 1500))

  const digestTree = (dir) => {
    const hash = crypto.createHash('sha256')
    const walk = (d) => { for (const entry of fs.existsSync(d) ? fs.readdirSync(d).sort() : []) { const f = path.join(d, entry); const st = fs.lstatSync(f); if (st.isDirectory()) walk(f); else hash.update(path.relative(dir, f) + '\0' + fs.readFileSync(f).toString('base64') + '\0') } }
    walk(dir); return hash.digest('hex')
  }
  const snapshot = (ids) => {
    const view = {}
    for (const id of ids) {
      const s = sessions().get(id)
      const events = s ? sessionEvents(s) : []
      view[id] = { events: events.length, title: (events.filter((e) => e.type === 'session/title').pop() || { data: null }).data }
    }
    view.workspaces = registry().list().map((w) => ({ id: w.id ?? w.workspaceId, path: w.path, title: w.title, sessionIds: [...(w.sessionIds || [])].sort(), archived: w.archivedSessionIds ? [...w.archivedSessionIds].sort() : null }))
    try { const jobs = ctx.get('jobs'); view.jobs = jobs && typeof jobs.list === 'function' ? JSON.stringify(jobs.list()).length : null } catch { view.jobs = 'unreadable' }
    view.taskArtifacts = digestTree(path.join(workspace, '.ai-harness'))
    view.bindings = fs.existsSync(path.join(dataRoot, 'routing', 'session-bindings.json')) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'))).digest('hex') : null
    return JSON.stringify(view)
  }

  // ── 1. Missing listener: default DSH behavior unchanged ─────────────────
  const before0 = snapshot([U])
  const defaultRename = await call('session/rename', { sessionId: U, title: 'default-path rename' })
  assert.equal(defaultRename.ok, true, 'with no listener an owner rename succeeds exactly as on pinned DSH')
  assert.notEqual(snapshot([U]), before0)
  evidence.scenarios.missingListener = { renameOk: defaultRename.ok }
  pass('missing listener: the hook is inert and default owner behavior is unchanged')

  // ── 2. Install the test-only Nexus policy (gateway hook + fetch-route guard) ──
  controller.admission.register(M, { taskKey: 'managed-task' })
  const policy = createNexusGatewayPolicy({
    getController: () => ctx.get('nexusController'),
    sessionOf: (id) => { try { return sessions().get(id) } catch { return undefined } },
    managedIds: () => (ctx.get('nexusController') && !ctx.get('nexusController').closed && ctx.get('nexusController').admission.isManaged(M) ? [M] : []),
    workspaceHasManaged: (id) => registry().list().some((w) => (w.id ?? w.workspaceId) === id && [...(w.sessionIds || [])].includes(M)),
  })
  const disposePolicy = ctx.on('gateway/authorize', (request) => policy.listener(request))
  const disposeFetchGuard = ctx.on('connection/request', (req, res, next) => {
    const url = new URL(req.url, 'http://h')
    if (url.pathname === '/api/session/uploadFileBinary' && ctx.get('nexusController').admission.isManaged(url.searchParams.get('sessionId') || '')) { res.writeHead(403); res.end('nexus-managed-session'); return }
    return next()
  })

  // ── 3. Coverage matrix on the managed session ──────────────────────────
  const rows = [
    ['session/prompt (queue)', 'session/prompt', { requestId: crypto.randomUUID(), sessionId: M, mode: 'queue', content: [{ type: 'text', text: 'x' }] }],
    ['session/prompt (steer)', 'session/prompt', { requestId: crypto.randomUUID(), sessionId: M, mode: 'steer', content: [{ type: 'text', text: 'x' }] }],
    ['session/updateQueue', 'session/updateQueue', { sessionId: M, itemId: 'msg-1', action: { kind: 'edit', content: [{ type: 'text', text: 'x' }] } }],
    ['session/cancel', 'session/cancel', { sessionId: M }],
    ['session/rename', 'session/rename', { sessionId: M, title: 'owner rename' }],
    ['session/selectModel', 'session/selectModel', { sessionId: M, provider: 'deepseek', model: 'deepseek-v4-flash' }],
    ['session/fork', 'session/fork', { sessionId: M }],
    ['session/create (reuse managed id)', 'session/create', { sessionId: M, workspaceId }],
    ['workspace/archiveSession', 'workspace/archiveSession', { sessionId: M, stop: true }],
    ['workspace/pinSession', 'workspace/pinSession', { sessionId: M }],
    ['workspace/insertSessionBefore', 'workspace/insertSessionBefore', { sessionId: M, workspaceId }],
    ['workspace/delete (contains managed)', 'workspace/delete', { workspaceId }],
    ['workspace/rename (contains managed)', 'workspace/rename', { workspaceId, title: 'renamed ws' }],
  ]
  const rawRows = [
    ['agentPresets/select', 'agentPresets/select', { agentId: M, agentPreset: 'aih-engineering' }],
    ['commands/execute', 'commands/execute', { agentId: M, line: '/compact', submittedAttachments: [] }],
    ['goals/create', 'goals/create', { agentId: M, request: { objective: 'x' } }],
    ['userQuestions/answer', 'userQuestions/answer', { agentId: M, callId: 'call-1', answer: { kind: 'answered', answers: [] } }],
    ['subagents/interruptByParent', 'subagents/interruptByParent', { childSessionId: M, parentSessionId: U, mode: 'continuable' }],
    ['terminal/create (managed agent)', 'terminal/create', { agentId: M, request: { id: 'term-m', cols: 80, rows: 24 } }],
    ['terminal/create (unmanaged agent, same cwd)', 'terminal/create', { agentId: U, request: { id: 'term-u', cols: 80, rows: 24 } }],
    ['fileUploads/upload', 'fileUploads/upload', { agentId: M, request: { data: 'eA==', name: 'a.txt' } }],
    ['dynamicCordisRunner/invoke (host code)', 'dynamicCordisRunner/invoke', { pluginId: 'p', pluginRunId: 'r', method: 'm', args: [] }],
    ['pluginManager/setPluginEnabled (disable Nexus)', 'pluginManager/setPluginEnabled', { id: 'nexus-controller-host', enabled: false }],
    ['settings/update', 'settings/update', { ns: 'agent-default-model', patch: {}, expectedRevision: 0 }],
    ['credentials/set', 'credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'x' }],
    ['schedule/create', 'schedule/create', { request: { title: 'x', prompt: 'x', timing: { kind: 'after', after_seconds: 3600 }, target: { kind: 'session', sessionId: M } } }],
    ['schedule/run', 'schedule/run', { request: { id: 'sch-1' } }],
    ['job/kill', 'job/kill', { request: { sessionId: M, jobId: 'job-1' } }],
  ]
  const watched = [M, U, U2]
  const runRow = async (label, endpoint, args, raw) => {
    const before = snapshot(watched)
    const response = await call(endpoint, args, raw)
    await new Promise((r) => setTimeout(r, 100))
    const unchanged = snapshot(watched) === before
    const disposition = response.code === 'remote-access/denied' ? 'denied-by-hook' : response.ok ? 'ALLOWED' : 'refused-before-hook:' + response.code
    evidence.rows.push({ label, endpoint, disposition, reason: response.reason, stateUnchanged: unchanged })
    console.log('ROW ' + label.padEnd(48) + ' ' + disposition + (response.reason ? ' (' + response.reason + ')' : '') + (unchanged ? '' : ' STATE-CHANGED'))
    return { response, unchanged }
  }
  for (const [label, endpoint, args] of rows) { const { response, unchanged } = await runRow(label, endpoint, args, false); assert.equal(response.ok, false, label + ' must not succeed'); assert.ok(unchanged, label + ': protected state changed') }
  for (const [label, endpoint, args] of rawRows) { const { response, unchanged } = await runRow(label, endpoint, args, true); assert.equal(response.ok, false, label + ' must not succeed'); assert.ok(unchanged, label + ': protected state changed') }
  const deniedByHook = evidence.rows.filter((r) => r.disposition === 'denied-by-hook').length
  const unproven = evidence.rows.filter((r) => r.disposition.startsWith('refused-before-hook')).map((r) => r.label)
  evidence.unprovenRows = unproven
  assert.ok(deniedByHook >= 18, 'rows refused by the hook itself: ' + deniedByHook)
  pass(`owner-peer coverage matrix: every protected row refused with state unchanged (${deniedByHook}/${evidence.rows.length} refused by the hook itself; ${unproven.length} refused earlier by DSH argument validation: ${unproven.join(', ') || 'none'})`)

  // Fetch route outside the gateway (existing connection/request seam).
  const uploadBefore = snapshot(watched)
  const upload = await fetch(base + 'api/session/uploadFileBinary?sessionId=' + encodeURIComponent(M) + '&name=a.txt', { method: 'POST', headers: { cookie, origin: base.slice(0, -1), 'content-type': 'application/octet-stream' }, body: 'x' })
  assert.equal(upload.status, 403); assert.equal(snapshot(watched), uploadBefore)
  evidence.scenarios.fetchUpload = upload.status
  pass('owner file upload into a managed session (fetch route, not the gateway) refused by the connection/request guard')

  // Stream transport and $events/result through the gateway's own entry points (real owner Peer).
  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'answer' })
  const empty = { async *[Symbol.asyncIterator]() {} }
  await assert.rejects(gateway.openStream({ namespace: 'terminal', method: 'attach', args: { agentId: M, id: 'term-1' }, peer, signal: new AbortController().signal, uplink: empty }, new AbortController()), (error) => error && error.code === 'remote-access/denied')
  const events = await gateway.openWireStream('$events', { args: {} }, empty, peer, new AbortController().signal, new AbortController())
  const ready = (await events[Symbol.asyncIterator]().next()).value
  const answer = await gateway.dispatchRpc('$events/result', { args: { clientId: ready.clientId, eventId: crypto.randomUUID(), outcome: { kind: 'result', value: 'allowed-once' } } }, new AbortController().signal, peer)
  assert.equal(answer.ok, false); assert.equal(answer.error && answer.error.code, 'remote-access/denied')
  evidence.scenarios.streamAndEvents = { terminalAttach: 'denied', eventResult: answer.error && answer.error.code }
  pass('stream-mode terminal/attach (uplink) and an unattributed $events/result are refused by the hook (owner Peer)')

  // ── 4. Unmanaged sessions keep ordinary behavior ───────────────────────
  const u2Rename = await call('session/rename', { sessionId: U2, title: 'unmanaged rename' })
  const uRename = await call('session/rename', { sessionId: U, title: 'unmanaged same-workspace rename' })
  assert.equal(u2Rename.ok, true); assert.equal(uRename.ok, true)
  const u2Terminal = await call('terminal/create', { agentId: U2, request: { id: 'term-u2', cols: 80, rows: 24 } }, true)
  evidence.scenarios.unmanaged = { renameOtherWorkspace: u2Rename.ok, renameSameWorkspace: uRename.ok, terminalOtherWorkspace: u2Terminal.code || 'ok' }
  assert.notEqual(u2Terminal.code, 'remote-access/denied', 'a terminal for an unmanaged session in another workspace is not refused by Nexus')
  pass('mixed managed/unmanaged: ordinary sessions (same and other workspace) keep their behavior; only managed authority is protected')

  // ── 5. Concurrency ─────────────────────────────────────────────────────
  const mBefore = snapshot([M])
  const burst = await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => call('session/rename', { sessionId: M, title: 'race ' + i })),
    ...Array.from({ length: 20 }, (_, i) => call('session/rename', { sessionId: U2, title: 'ok ' + i })),
  ])
  assert.ok(burst.slice(0, 20).every((r) => r.code === 'remote-access/denied'))
  assert.ok(burst.slice(20).every((r) => r.ok))
  assert.equal(snapshot([M]), mBefore)
  pass('40 concurrent owner operations: all 20 managed mutations refused, all 20 unmanaged succeed, managed state unchanged')

  // ── 6. Stale identity and unknown resources ────────────────────────────
  const stale = await call('session/rename', { sessionId: 'session-' + crypto.randomUUID(), title: 'ghost' })
  assert.equal(stale.ok, false)
  evidence.scenarios.staleIdentity = stale.code
  pass('stale/unknown session identities never mutate anything (' + stale.code + ')')

  // ── 7. Approval and cancellation race on the managed agent ─────────────
  const agent = ctx.get('agents').get(M)
  if (agent) {
    const [outcome, cancel] = await Promise.all([ctx.get('approval').decide({ agent, toolName: 'shell', signal: AbortSignal.timeout(2000) }, agent.session), call('session/cancel', { sessionId: M })])
    assert.equal(outcome, 'rejected'); assert.equal(cancel.code, 'remote-access/denied')
    evidence.scenarios.approvalCancelRace = { outcome, cancel: cancel.code }
    pass('concurrent approval request and owner cancel: approval answered rejected by the Controller, cancel refused by the hook')
  } else console.log('INFO: no live managed agent; approval race not exercised')

  // ── 8. Throwing listener fails closed (and cannot be overridden) ───────
  const disposeThrower = ctx.on('gateway/authorize', () => { throw new Error('listener bug') })
  const thrown = await call('session/rename', { sessionId: U2, title: 'should fail' })
  assert.equal(thrown.code, 'remote-access/denied'); assert.equal(thrown.reason, 'authorization-failed')
  disposeThrower()
  const disposeAllower = ctx.on('gateway/authorize', () => ({ kind: 'allow' }), { prepend: true })
  const allowAttempt = await call('session/rename', { sessionId: M, title: 'allow override attempt' })
  assert.equal(allowAttempt.code, 'remote-access/denied', 'a listener returning anything but undefined/deny cannot allow; deny still wins')
  disposeAllower()
  pass('a throwing listener refuses (fail closed); a listener returning "allow" cannot override a refusal or skip other listeners')

  // ── 9. Controller disposal: protected mutations fail closed ────────────
  await controller.dispose()
  const afterDispose = await call('session/rename', { sessionId: U2, title: 'after disposal' })
  assert.equal(afterDispose.code, 'remote-access/denied'); assert.equal(afterDispose.reason, 'nexus-controller-unavailable')
  const readAfter = await call('session/state', { sessionId: U2 })
  assert.notEqual(readAfter.code, 'remote-access/denied', 'reads stay available')
  pass('after Controller disposal every non-read operation is refused (reads still served)')
  disposePolicy(); disposeFetchGuard()
  evidence.decisions = policy.decisions.length
  evidence.llmCalls = llmCalls
  assert.equal(llmCalls, 0)

  // ── 10. Restart and replay ─────────────────────────────────────────────
  const eventsBefore = sessionEvents(sessions().get(M)).length
  try { await booted.shutdown.shutdown(0) } catch { /* bounded */ }
  booted = await boot(); ctx = booted.ctx; controller = ctx.get('nexusController')
  const replayed = await (async () => { try { const s = await ctx.get('sessions').open?.(M); return s ? sessionEvents(s).length : null } catch { return null } })()
  evidence.scenarios.restart = { managedAfterRestart: controller.admission.isManaged(M), eventsBefore, replayedEvents: replayed }
  assert.equal(controller.admission.isManaged(M), false, 'KNOWN BLOCKER: the managed-session registry is in memory; after restart the session is no longer protected')
  pass('restart and replay: durable session history survives, but managed status does not (durable managed registry is a P2-B2B prerequisite)')
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
} finally {
  if (process.env.NEXUS_GATEWAY_EVIDENCE) fs.writeFileSync(process.env.NEXUS_GATEWAY_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
  try { await booted.shutdown.shutdown(0) } catch { /* bounded */ }
  if (!exitCode) console.log(`NexusGatewayAuthorization: ${passed} assertion groups passed.`)
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(exitCode)
}
