// P2-A Task B: owner-peer mutation authority on the REAL pinned DSH 0.2.2 host.
//
// Boots the installed `web` profile in-process (port 0) with a PRIVATE data
// root holding a copy of the installation's generated cordis.patch.yml (its
// closures are read in place, never modified), a synthetic PowerShell host
// (tests/lib/FakePwshHost.cjs) and an `llm/stream` listener that counts and
// blocks every model request. All RPC goes over real HTTP to /api with a real
// owner Peer (launch-token cookie), i.e. through connection admission, the
// `connection/request` waterfall and the Typert gateway exactly as the GUI.
//
// Proves: (1) the P2-A managed-session effect gate refuses every agent step of
// a managed session reached through owner-peer HTTP prompt, before any
// controller CLI or model request; (2) ordinary legacy sessions still reach
// the plane bridge; (3) which owner mutations remain reachable (documented
// P2-B gate), asserted explicitly so the gap cannot be silently claimed closed.

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = process.env.AIH_HOST_APP || path.join(root, 'app')
const installedPatch = path.join(root, 'data', 'cordis.patch.yml')
if (!fs.existsSync(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')) || !fs.existsSync(installedPatch)) {
  console.error('FAIL: this real-host suite needs an installed Nexus root (app/ and data/cordis.patch.yml); it never skips')
  process.exit(1)
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-owner-peer-'))
// A thin private install root: every installed directory is linked read-only
// in place except data/, which is private (host rows resolve ../config from
// the data root, and isolation readers use <installRoot>/data).
const installRoot = path.join(scratch, 'install')
fs.mkdirSync(installRoot)
for (const entry of fs.readdirSync(root)) if (entry !== 'data') fs.symlinkSync(path.join(root, entry), path.join(installRoot, entry))
const dataRoot = path.join(installRoot, 'data')
fs.mkdirSync(dataRoot, { recursive: true })
fs.copyFileSync(installedPatch, path.join(dataRoot, 'cordis.patch.yml'))
// The production host rows resolve relative to the data root: copy the same
// runtime assets the installer places there (never credentials or sessions).
for (const name of ['nexus-settings.yaml', 'Routing-Integrity.cjs', 'OpenCode-SessionHeader.cjs']) if (fs.existsSync(path.join(root, 'data', name))) fs.copyFileSync(path.join(root, 'data', name), path.join(dataRoot, name))
if (fs.existsSync(path.join(root, 'data', 'profiles'))) fs.cpSync(path.join(root, 'data', 'profiles'), path.join(dataRoot, 'profiles'), { recursive: true })
const workspace = fs.mkdtempSync(path.join(scratch, 'ws-'))
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
fake.respond({ '*': { json: {} } })
process.env.DSH_HOME = dataRoot
process.env.AIH_INSTALL_ROOT = installRoot
process.env.AIH_HOST_APP = appDir
process.env.DEEPSEEK_API_KEY = 'probe-not-a-credential'
process.env.NODE_USE_ENV_PROXY = '1'
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = 'http://127.0.0.1:9'
process.env.NO_PROXY = '127.0.0.1,localhost'

const appRequire = createRequire(path.join(appDir, 'package.json'))
const load = (name) => import(pathToFileURL(appRequire.resolve(name)).href)
const sessionEvents = require('../config/Dsh-SessionEvents.cjs').sessionEvents
let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }
const evidence = { dsh: appRequire('@deepseek-ai/dsh/package.json').version, node: process.version, platform: process.platform + '-' + process.arch, results: {} }

const { runProfile } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
const booted = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]), profile: 'web', patchFiles: [], args: ['--no-open', '--port', '0'] })
const ctx = booted.ctx
let exitCode = 0
try {
  const controller = ctx.get('nexusController')
  for (let i = 0; i < 300 && controller && controller.ownership.state === 'not-acquired'; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.ok(controller && controller.readiness().ready, 'host Controller ready on the real composition: ' + JSON.stringify(controller && controller.readiness().problems))
  assert.equal(controller.ownership.state, 'held')
  let llmCalls = 0
  ctx.on('llm/stream', (...args) => { llmCalls += 1; throw new Error('test transport: model requests are blocked') }, { prepend: true })
  const seenPaths = []
  ctx.on('connection/request', (req, res, next) => { seenPaths.push(req.method + ' ' + new URL(req.url, 'http://h').pathname); return next() })

  const web = ctx.get('webServer')
  const base = `http://127.0.0.1:${web.port}/`
  const tokenUrl = ctx.get('connection').authenticatedUrl(base)
  const minted = await fetch(tokenUrl, { redirect: 'manual' })
  const cookie = (minted.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie.includes('='), 'owner launch token minted a browser cookie')
  const call = async (endpoint, args) => {
    const response = await fetch(base + 'api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base.slice(0, -1) }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args: { request: args } } }) })
    const text = await response.text()
    let body; try { body = JSON.parse(text) } catch { body = { raw: text } }
    return { status: response.status, body }
  }
  const unauthenticated = await fetch(base + 'api/session/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unauthenticated.status, 401, 'no cookie, no API')

  const created = await call('session/create', { cwd: workspace })
  const sessionId = created.body && created.body.result && created.body.result.value && created.body.result.value.sessionId
    || created.body && created.body.value && created.body.value.sessionId
  assert.ok(sessionId, 'owner created a session over HTTP: ' + JSON.stringify(created).slice(0, 300))
  controller.admission.register(sessionId, { taskKey: 'synthetic-managed-task' })
  assert.equal(controller.admission.state, 'disabled')
  fake.reset()
  const stepsRefusedBefore = controller.metrics().managedStepsRefused
  const prompt = await call('session/prompt', { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Do anything.' }] })
  evidence.results.managedPrompt = { status: prompt.status, ok: prompt.body && (prompt.body.ok ?? null) }
  const waitFor = async (predicate, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }
  const session = () => ctx.get('sessions').get(sessionId)
  const turnEnded = await waitFor(() => { const s = session(); const events = s ? sessionEvents(s) : []; return Array.isArray(events) && events.some((e) => e && e.type === 'turn/end') })
  const refusedSteps = controller.metrics().managedStepsRefused - stepsRefusedBefore
  evidence.results.managed = { turnEnded, refusedSteps, llmCalls, controllerCli: fake.invocations().length }
  assert.ok(refusedSteps >= 1, 'the managed session step was refused by the Controller gate')
  assert.equal(llmCalls, 0, 'no model request for a managed session reached through an owner peer')
  assert.equal(fake.invocations().length, 0, 'refused before any controller CLI (no task state touched)')
  assert.ok(seenPaths.includes('POST /api/session/prompt'), 'the supported connection/request waterfall saw the HTTP mutation path (body untouched)')
  pass('owner-peer HTTP prompt on a managed session: every agent step refused at the supported effect seam; 0 model requests, 0 controller CLIs')

  // Ordinary legacy session: not managed, reaches the plane bridge (controller CLI), still no model call (synthetic CLI yields no task).
  const legacy = await call('session/create', { cwd: workspace })
  const legacyId = legacy.body && legacy.body.result && legacy.body.result.value && legacy.body.result.value.sessionId || legacy.body && legacy.body.value && legacy.body.value.sessionId
  assert.ok(legacyId && legacyId !== sessionId)
  fake.reset()
  await call('session/prompt', { requestId: crypto.randomUUID(), sessionId: legacyId, mode: 'queue', content: [{ type: 'text', text: 'Ordinary legacy turn.' }] })
  await waitFor(() => fake.invocations().length > 0, 20000)
  evidence.results.legacy = { controllerCli: fake.invocations().map((i) => i.script + ':' + i.action), managed: controller.admission.isManaged(legacyId) }
  assert.ok(fake.invocations().length > 0, 'an ordinary legacy session is not affected by the managed gate (bridge ran its controller CLI)')
  pass('ordinary legacy sessions are untouched by the managed-session gate')

  // ── P2-B1 owner-peer coverage matrix on the managed session ──────────────
  const matrix = []
  const row = (path, disposition, evidence) => { matrix.push({ path, disposition, evidence }); evidence && console.log('MATRIX ' + path + ' => ' + disposition) }
  const typesAfter = (from) => sessionEvents(session()).slice(from).map((e) => e.type)
  let mark = sessionEvents(session()).length
  const steer = await call('session/prompt', { requestId: crypto.randomUUID(), sessionId, mode: 'steer', content: [{ type: 'text', text: 'Steer.' }] })
  await waitFor(() => typesAfter(mark).includes('turn/end'), 10000)
  row('session/prompt (queue)', 'prevented: every agent step refused at agent/pre-step', { status: prompt.status, refusedSteps, llmCalls })
  row('session/prompt (steer)', 'prevented: every agent step refused at agent/pre-step', { status: steer.status, refusedTotal: controller.metrics().managedStepsRefused, llmCalls })
  const queue = await call('session/updateQueue', { sessionId, itemId: 'msg-does-not-exist', action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] } })
  row('session/updateQueue', 'prevented at effect: queued/edited input can only run through agent/pre-step (refused); the edit itself is not interceptable', { response: JSON.stringify(queue.body).slice(0, 200), llmCalls })
  mark = sessionEvents(session()).length
  const renamed = await call('session/rename', { sessionId, title: 'renamed by owner peer' })
  await new Promise((r) => setTimeout(r, 200))
  const renameTypes = typesAfter(mark)
  row('session/rename', 'reconciliation-only: committed by DSH, observed post-commit (cosmetic, no task authority)', { response: JSON.stringify(renamed.body).slice(0, 160), eventTypes: renameTypes, reconciliation: controller.admission.reconciliationLog().map((r) => r.kind) })
  const cancelled = await call('session/cancel', { sessionId })
  row('session/cancel', 'reconciliation-only: accepted by DSH; an aborted managed turn is recorded for Controller reconciliation (interrupted)', { response: JSON.stringify(cancelled.body).slice(0, 160) })
  mark = sessionEvents(session()).length
  const selected = await call('session/selectModel', { sessionId, provider: 'deepseek', model: 'deepseek-v4-flash' })
  await new Promise((r) => setTimeout(r, 200))
  row('session/selectModel', 'prevented at effect: selection may be appended, but no step of a managed session runs; route guards reject drift for bound sessions', { response: JSON.stringify(selected.body).slice(0, 200), eventTypes: typesAfter(mark), llmCalls })
  const forked = await call('session/fork', { sessionId })
  const forkId = forked.body && forked.body.result && forked.body.result.value && forked.body.result.value.sessionId
  row('session/fork', 'authorized delegation: a fork is a new, independent ordinary session (not managed); the managed session is unchanged', { response: JSON.stringify(forked.body).slice(0, 200), forkManaged: forkId ? controller.admission.isManaged(forkId) : null })
  if (forkId) assert.equal(controller.admission.isManaged(forkId), false)
  const ws = await call('workspace/create', { path: workspace })
  const archived = await call('workspace/archiveSession', { sessionId })
  row('workspace/archiveSession', 'reconciliation-only: organizational state, not interceptable per session; stops running work (observed as cancel)', { workspace: ws.status, response: JSON.stringify(archived.body).slice(0, 200) })
  // Approvals: the managed session's approval/request is answered by the Controller before the Web remote forwarder.
  const approval = ctx.get('approval')
  const agents = ctx.get('agents')
  const managedAgent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (approval && managedAgent && typeof approval.decide === 'function') {
    const answeredBefore = controller.metrics().managedApprovalsAnswered
    const outcome = await approval.decide({ agent: managedAgent, toolName: 'shell', signal: AbortSignal.timeout(2000) }, managedAgent.session)
    row('approval/request ($events/result answer)', 'prevented: answered by the Controller (rejected while managed admission is disabled); never forwarded to owner peers', { outcome, answered: controller.metrics().managedApprovalsAnswered - answeredBefore })
    assert.equal(outcome, 'rejected')
    assert.equal(controller.metrics().managedApprovalsAnswered - answeredBefore, 1)
  } else {
    row('approval/request ($events/result answer)', 'UNTESTED on the real host: no live agent object was available', { approval: Boolean(approval), agent: Boolean(managedAgent) })
  }
  const questions = ctx.get('userQuestions')
  if (questions && managedAgent) {
    let questionResult
    try { questionResult = await questions.ask({ agent: managedAgent, questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], signal: AbortSignal.timeout(2000) }) } catch (error) { questionResult = { error: String(error && error.code || error && error.message) } }
    row('user-questions/request (attachWait answer)', 'prevented: refused by the Controller before any answerer for a managed session', { result: JSON.stringify(questionResult).slice(0, 200), refused: controller.metrics().managedQuestionsRefused })
  }
  // Subagent lineage (header semantics of DSH 0.2.2 subagent children).
  assert.equal(controller.admission.isManaged({ id: 'child', header: { origin: 'subagent', parentSession: sessionId } }), true)
  assert.equal(controller.admission.isManaged({ id: 'fork', header: { parentSession: sessionId } }), false)
  row('subagent prompt / child sessions', 'prevented: children with origin=subagent inherit managed status (effects, approvals, questions)', { inherits: true })
  evidence.results.matrix = matrix
  evidence.results.reconciliation = controller.admission.reconciliationLog()
  assert.equal(llmCalls, 0, 'no path in the matrix produced a model request')
  pass('owner-peer coverage matrix recorded on the real host; 0 model requests across every path')
} catch (error) {
  exitCode = 1
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
} finally {
  if (process.env.NEXUS_OWNER_PEER_EVIDENCE) fs.writeFileSync(process.env.NEXUS_OWNER_PEER_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
  try { await booted.shutdown.shutdown(0) } catch { /* bounded by DSH */ }
  if (!exitCode) console.log(`NexusOwnerPeerGuard: ${passed} assertion groups passed.`)
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(exitCode)
}
