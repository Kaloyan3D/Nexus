'use strict'

/**
 * P2-B1 Priority C: authenticated local IPC transport to the host Controller.
 * Real Unix sockets and real separate client processes; synthetic data roots.
 */

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sourceRoot = path.join(__dirname, '..')
const ipc = require('../config/nexus/ipc.cjs')
const controllerModule = require('../config/nexus/controller.cjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ipc-test-'))
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
if (process.platform === 'win32') { console.log('UNSUPPORTED: Windows named-pipe transport is not implemented (reported as unavailable)'); process.exit(0) }

function fixture(name, authorized) {
  const dataRoot = path.join(scratch, name, 'data')
  const workspace = path.join(scratch, name, 'ws')
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'state'), { recursive: true })
  const taskId = 'task_' + crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: { s1: { sessionId: 's1', taskInstanceId: taskId, taskId: 'TASK-0001', workspace, engine: 'muse', preset: 'aih-muse', executionClass: 'muse_main' } } }))
  fs.writeFileSync(path.join(workspace, '.ai-harness', 'state', 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [{ taskId: 'TASK-0001', taskInstanceId: taskId, status: 'implementing' }] }))
  const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot, workspaceAuthorizer: async (p) => authorized(p) })
  return { dataRoot, workspace, taskId, core }
}

async function main() {
  const f = fixture('main', (p) => p.endsWith(path.join('main', 'ws')))
  const server = await ipc.startIpcServer({ core: f.core, dataRoot: f.dataRoot, generation: 'gen-1' })
  const dirStat = fs.lstatSync(path.dirname(server.endpoint))
  assert.equal(dirStat.mode & 0o777, 0o700, 'socket directory is owner-only')
  assert.equal(fs.lstatSync(server.endpoint).mode & 0o777, 0o600, 'socket is owner-only')
  assert.equal(fs.lstatSync(path.join(f.dataRoot, 'routing', 'nexus-ipc.cap')).mode & 0o777, 0o600, 'capability is owner-only')
  assert.ok(Buffer.byteLength(server.endpoint) < 104, 'endpoint fits AF_UNIX limits')
  pass('endpoint, directory and capability are owner-only; endpoint is derived per installation')

  const client = await ipc.connectIpc({ dataRoot: f.dataRoot })
  const hello = await client.request('hello')
  assert.equal(hello.ok, true); assert.equal(hello.schemaVersion, 1)
  assert.deepEqual(hello.data.refusedOperations, ['submit'])
  const status = await client.request('getStatus', { taskId: f.taskId })
  assert.equal(status.ok, true); assert.equal(status.data.status, 'running')
  pass('mutual authentication, then hello/getStatus over the same Controller')

  // Client-supplied principal or unknown fields are refused, never trusted.
  client.sendRaw(JSON.stringify({ schemaVersion: 1, requestId: 'r1', operation: 'getStatus', input: { taskId: f.taskId }, principal: { kind: 'internal' } }) + '\n')
  assert.equal((await client.next(5000)).error.code, 'USAGE')
  client.sendRaw(JSON.stringify({ schemaVersion: 1, requestId: 'r2', operation: 'getStatus', input: { taskId: f.taskId, principal: 'internal' } }) + '\n')
  assert.equal((await client.next(5000)).error.code, 'USAGE')
  client.sendRaw(JSON.stringify({ schemaVersion: 2, requestId: 'r3', operation: 'hello' }) + '\n')
  assert.equal((await client.next(5000)).error.code, 'PROTOCOL_UNSUPPORTED')
  client.sendRaw(JSON.stringify({ schemaVersion: 1, requestId: 'r4', operation: 'invokeDsh', input: {} }) + '\n')
  assert.equal((await client.next(5000)).error.code, 'USAGE', 'arbitrary operations (e.g. DSH APIs) are not dispatchable')
  client.sendRaw('not json\n')
  assert.equal((await client.next(5000)).error.code, 'USAGE')
  assert.equal((await client.request('submit', {})).error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE', 'submit is refused while managed activation is inactive')
  for (const op of ['cancel', 'respond']) assert.equal((await client.request(op, {})).error.code, 'USAGE')
  client.sendRaw(JSON.stringify({ schemaVersion: 1, requestId: 'r5', operation: 'submit', input: { idempotencyKey: 'k', principal: 'internal' } }) + '\n')
  assert.equal((await client.next(5000)).error.code, 'USAGE', 'unknown submit fields are refused')
  pass('client-supplied principals, unknown fields/operations and bad envelopes are refused deterministically; mutations unavailable')

  // Workspace authorization is server-side: a task in an unregistered workspace is concealed.
  const foreign = fixture('foreign', () => false)
  const foreignServer = await ipc.startIpcServer({ core: foreign.core, dataRoot: foreign.dataRoot, generation: 'gen-f' })
  const foreignClient = await ipc.connectIpc({ dataRoot: foreign.dataRoot })
  assert.equal((await foreignClient.request('getStatus', { taskId: foreign.taskId })).error.code, 'NOT_FOUND')
  assert.equal((await client.request('getStatus', { taskId: foreign.taskId })).error.code, 'NOT_FOUND', 'another installation\'s task id is unknown here')
  foreignClient.close(); await foreignServer.close()
  pass('task ids never bypass workspace authorization (unregistered or foreign => NOT_FOUND)')

  // Unauthorized clients: wrong capability, raw socket without auth, handshake timeout.
  const capFile = path.join(f.dataRoot, 'routing', 'nexus-ipc.cap')
  const realCap = fs.readFileSync(capFile, 'utf8')
  fs.writeFileSync(capFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  await assert.rejects(ipc.connectIpc({ dataRoot: f.dataRoot }), (error) => error.code === 'AUTH_REQUIRED' || error.code === 'HOST_UNAVAILABLE')
  fs.writeFileSync(capFile, realCap, { mode: 0o600 })
  fs.chmodSync(capFile, 0o644)
  await assert.rejects(ipc.connectIpc({ dataRoot: f.dataRoot }), (error) => error.code === 'HOST_IDENTITY_MISMATCH')
  fs.chmodSync(capFile, 0o600)
  // Async child: the server under test runs in this process's event loop.
  const raw = await new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, ['-e', `
    const net = require('node:net'); const s = net.createConnection(${JSON.stringify(server.endpoint)});
    let data = ''; s.on('data', (c) => { data += c; if (data.split('\\n').length > 1) s.write(JSON.stringify({ schemaVersion: 1, requestId: 'x', operation: 'hello' }) + '\\n') });
    s.on('close', () => { process.stdout.write(data); process.exit(0) });
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000)
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ stdout, stderr, status, signal }) })
  })
  assert.match(raw.stdout, /"type":"error","code":"AUTH_REQUIRED"/, 'a request before authentication is refused and the socket closed: ' + JSON.stringify({ out: raw.stdout, err: raw.stderr, status: raw.status, signal: raw.signal }))
  assert.ok(!raw.stdout.includes('"ok":true'))
  pass('unauthorized clients (wrong capability, widened capability file, unauthenticated request) are refused')

  // Oversized frame.
  const big = await ipc.connectIpc({ dataRoot: f.dataRoot })
  big.sendRaw('{"pad":"' + 'x'.repeat(ipc.MAX_FRAME_BYTES + 10) + '"}\n')
  const overflow = await big.next(5000).catch(() => null)
  assert.ok(overflow === null || overflow.error.code === 'PROMPT_LIMIT', 'oversized frame rejected and connection closed')
  pass('frames above 2 MiB are rejected before parsing')

  // Host generation change: restart => new capability; old client and stale descriptor fail closed.
  client.close()
  await server.close()
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'routing', 'nexus-ipc.cap')), false, 'capability removed on clean shutdown')
  await assert.rejects(ipc.connectIpc({ dataRoot: f.dataRoot }), (error) => error.code === 'HOST_UNAVAILABLE')
  const restarted = await ipc.startIpcServer({ core: f.core, dataRoot: f.dataRoot, generation: 'gen-2' })
  const fresh = await ipc.connectIpc({ dataRoot: f.dataRoot })
  assert.equal(fresh.generation, 'gen-2')
  const descriptorFile = path.join(f.dataRoot, 'routing', 'nexus-ipc.json')
  const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'))
  fs.writeFileSync(descriptorFile, JSON.stringify({ ...descriptor, generation: 'gen-stale' }), { mode: 0o600 })
  await assert.rejects(ipc.connectIpc({ dataRoot: f.dataRoot }), (error) => error.code === 'HOST_IDENTITY_MISMATCH', 'a stale descriptor generation is refused')
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 })
  pass('host generation change rotates the capability; stale clients and descriptors fail closed')

  // A Controller that does not hold ownership does not serve.
  const enforced = fixture('enforced', () => true)
  const notOwner = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot: enforced.dataRoot, enforceOwnership: true })
  notOwner.setOwnership({ state: 'contended' })
  const blockedServer = await ipc.startIpcServer({ core: notOwner, dataRoot: enforced.dataRoot, generation: 'gen-c' })
  const blockedClient = await ipc.connectIpc({ dataRoot: enforced.dataRoot })
  assert.equal((await blockedClient.request('hello')).error.code, 'HOST_NOT_READY')
  blockedClient.close(); await blockedServer.close()
  pass('a host Controller without installation ownership answers HOST_NOT_READY')

  // A squatted or widened socket directory is refused.
  const dir = path.dirname(restarted.endpoint)
  fs.chmodSync(dir, 0o755)
  try { await assert.rejects(ipc.startIpcServer({ core: f.core, dataRoot: path.join(scratch, 'other', 'data') }), (error) => error.code === 'ipc-endpoint-unsafe') } finally { fs.chmodSync(dir, 0o700) }
  pass('a widened private socket directory is refused (no squatting)')

  fresh.close(); big.close()
  await restarted.close()
  await f.core.dispose()
  console.log(`NexusIpc: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

fs.mkdirSync(path.join(scratch, 'other', 'data', 'routing'), { recursive: true })
main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
