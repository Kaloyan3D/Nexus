'use strict'

/**
 * nexus/ipc — authenticated local task transport (P2-B1, Priority C).
 *
 * The future Nexus CLI connects to the SAME host Controller as the GUI through
 * this transport. It dispatches ONLY the shared task API (never arbitrary DSH
 * operations) and is started only by a host that holds installation ownership.
 *
 * POSIX (macOS, Linux):
 *   - endpoint: a Unix domain socket in a private per-user directory
 *     /tmp/nexus-ipc-<uid>/ (mode 0700, owned by the user, not a symlink;
 *     a squatted or widened directory is refused). The socket name is derived
 *     from the canonical data root, so independent installations never meet.
 *     The directory lives under /tmp because AF_UNIX paths are limited to
 *     104 bytes on macOS.
 *   - capability: 32 random bytes per host generation in
 *     <data>/routing/nexus-ipc.cap (0600), never on argv, in logs or URLs.
 *   - discovery: <data>/routing/nexus-ipc.json (endpoint, protocol,
 *     generation, pid) — informational; trust comes from the handshake.
 *   - authentication: mutual HMAC-SHA256 challenge-response over fresh nonces
 *     bound to role, protocol and host generation, constant-time comparison,
 *     5 s handshake deadline, close on failure. A client proves the capability
 *     before any request; the server proves it back before the client sends
 *     anything else. A restarted host has a new generation and capability, so
 *     old clients fail closed.
 * Windows: a named pipe with a verified owner-only ACL is required by the CLI
 * contract and is NOT implemented; the transport reports unavailable.
 *
 * Wire: newline-delimited JSON, each frame <= 2 MiB. Requests use the strict v1
 * envelope { schemaVersion: 1, requestId, operation, input }; unknown fields
 * (including any client-supplied principal) are refused. The principal is
 * derived from the authenticated connection: local-owner with tasks:read.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const PROTOCOL = 'nexus-task-ipc/1'
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 5000
const MAX_CONNECTIONS = 16
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const OPERATIONS = Object.freeze(['hello', 'listModes', 'getStatus', 'getResult', 'follow', 'submit', 'continueTask', 'cancel', 'respond', 'registerWorkspace', 'listCredentials', 'setCredential', 'unsetCredential', 'checkSession'])
const INPUT_FIELDS = Object.freeze({ hello: [], listModes: [], getStatus: ['taskId'], getResult: ['taskId'], follow: ['taskId', 'afterRevision', 'waitMs'], submit: ['idempotencyKey', 'workspace', 'mode', 'prompt'], continueTask: ['taskId', 'idempotencyKey', 'prompt', 'expectedRevision'], cancel: ['taskId'], respond: ['taskId', 'actionId', 'expectedRevision', 'choiceId'], registerWorkspace: ['path'], listCredentials: ['refs'], setCredential: ['ref', 'value'], unsetCredential: ['ref'], checkSession: ['sessionId'] })

class IpcError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function proof(capability, role, generation, first, second) {
  return crypto.createHmac('sha256', capability).update(`${PROTOCOL}\n${role}\n${generation}\n${first}\n${second}`).digest('hex')
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

function uid() { return typeof process.getuid === 'function' ? process.getuid() : null }

/** Create or validate the private socket directory; refuse squatting. */
function privateSocketDir() {
  const dir = path.join('/tmp', `nexus-ipc-${uid()}`)
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IpcError('ipc-endpoint-unsafe', 'IPC directory is not a real directory')
  if (stat.uid !== uid()) throw new IpcError('ipc-endpoint-unsafe', 'IPC directory is owned by another user')
  if ((stat.mode & 0o077) !== 0) throw new IpcError('ipc-endpoint-unsafe', 'IPC directory is accessible to other users')
  return dir
}

function endpointFor(dataRoot) {
  const canonical = fs.realpathSync(dataRoot)
  return path.join(privateSocketDir(), crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24) + '.sock')
}

function discoveryPaths(dataRoot) {
  return { descriptor: path.join(dataRoot, 'routing', 'nexus-ipc.json'), capability: path.join(dataRoot, 'routing', 'nexus-ipc.cap') }
}

function writePrivate(file, contents) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  fs.writeFileSync(temporary, contents, { mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, file)
}

function readPrivate(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new IpcError('HOST_IDENTITY_MISMATCH', 'IPC metadata is not a regular file')
  if (uid() !== null && stat.uid !== uid()) throw new IpcError('HOST_IDENTITY_MISMATCH', 'IPC metadata is owned by another user')
  if ((stat.mode & 0o077) !== 0) throw new IpcError('HOST_IDENTITY_MISMATCH', 'IPC metadata is readable by other users')
  return fs.readFileSync(file)
}

/** Line framer with a hard per-frame bound. */
function frames(socket, onFrame, onOverflow) {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) {
        if (buffer.length > MAX_FRAME_BYTES) { buffer = Buffer.alloc(0); onOverflow() }
        return
      }
      if (newline > MAX_FRAME_BYTES) { buffer = Buffer.alloc(0); onOverflow(); return }
      const line = buffer.subarray(0, newline).toString('utf8')
      buffer = buffer.subarray(newline + 1)
      let message
      try { message = JSON.parse(line) } catch { message = Symbol.for('invalid') }
      onFrame(message)
    }
  })
}

function send(socket, value) { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n') }

function envelopeError(requestId, code, message, retryable = false) {
  return { schemaVersion: 1, ok: false, requestId: typeof requestId === 'string' ? requestId : null, error: { code, message, retryable } }
}

/** Validate one request envelope (strict). Returns { error } or { request }. */
function validateRequest(message) {
  if (message === Symbol.for('invalid') || !message || typeof message !== 'object' || Array.isArray(message)) return { error: envelopeError(null, 'USAGE', 'request is not a JSON object') }
  const requestId = message.requestId
  const allowed = ['schemaVersion', 'requestId', 'operation', 'input']
  if (Object.keys(message).some((key) => !allowed.includes(key))) return { error: envelopeError(requestId, 'USAGE', 'unknown envelope field') }
  if (message.schemaVersion !== 1) return { error: envelopeError(requestId, 'PROTOCOL_UNSUPPORTED', 'schemaVersion must be 1') }
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return { error: envelopeError(null, 'USAGE', 'requestId is required') }
  if (!OPERATIONS.includes(message.operation)) return { error: envelopeError(requestId, 'USAGE', 'unknown operation') }
  const input = message.input === undefined ? {} : message.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: envelopeError(requestId, 'USAGE', 'input must be an object') }
  const fields = INPUT_FIELDS[message.operation]
  if (fields && Object.keys(input).some((key) => !fields.includes(key))) return { error: envelopeError(requestId, 'USAGE', 'unknown input field') }
  return { request: { requestId, operation: message.operation, input } }
}

async function startIpcServer(options) {
  if (process.platform === 'win32') throw new IpcError('ipc-transport-unsupported-platform', 'Windows named-pipe ACL is not implemented; the IPC transport is unavailable')
  const { core, dataRoot, generation } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const endpoint = endpointFor(dataRoot)
  const capability = crypto.randomBytes(32)
  const { descriptor, capability: capabilityFile } = discoveryPaths(dataRoot)
  // Our host holds installation ownership: a stale socket at our private
  // endpoint belongs to a dead generation of this same installation.
  try { if (fs.lstatSync(endpoint).isSocket()) fs.rmSync(endpoint) } catch (error) { if (error.code !== 'ENOENT') throw error }
  writePrivate(capabilityFile, capability.toString('hex'))
  const principal = Object.freeze({ kind: 'local-owner', via: 'ipc', capabilities: Object.freeze(['tasks:read', 'tasks:submit', 'tasks:cancel', 'tasks:respond', 'workspaces:register', 'credentials:read', 'credentials:write']) })
  const stats = { connections: 0, authenticated: 0, authFailures: 0, requests: 0, refused: 0, overflows: 0 }
  const sockets = new Set()

  const server = net.createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) { socket.destroy(); stats.refused += 1; return }
    sockets.add(socket)
    stats.connections += 1
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    const serverNonce = crypto.randomBytes(32).toString('hex')
    let authenticated = false
    const deadline = setTimeout(() => { if (!authenticated) { stats.authFailures += 1; socket.destroy() } }, HANDSHAKE_TIMEOUT_MS)
    send(socket, { type: 'challenge', protocol: PROTOCOL, generation, serverNonce })
    const queue = []
    let busy = false
    const pump = async () => {
      if (busy) return
      busy = true
      while (queue.length) {
        const message = queue.shift()
        const checked = validateRequest(message)
        if (checked.error) { send(socket, checked.error); continue }
        stats.requests += 1
        const { requestId, operation, input } = checked.request
        let result
        try {
          if (core.closed || !core.ownershipHeld) result = envelopeError(requestId, 'HOST_NOT_READY', 'the host Controller is not serving', true)
          else result = await core.tasks[operation](principal, input)
        } catch (error) {
          result = envelopeError(requestId, 'INTERNAL', 'internal error')
          log({ event: 'ipc-request-failed', operation, error: String(error && error.message ? error.message : error) })
        }
        send(socket, { ...result, requestId })
      }
      busy = false
    }
    frames(socket, (message) => {
      if (authenticated === null) return
      if (!authenticated) {
        const ok = message && typeof message === 'object' && message.type === 'auth' && typeof message.clientNonce === 'string' && /^[0-9a-f]{64}$/.test(message.clientNonce) &&
          safeEqualHex(message.proof, proof(capability, 'client', generation, serverNonce, message.clientNonce))
        if (!ok) {
          stats.authFailures += 1
          send(socket, { type: 'error', code: 'AUTH_REQUIRED', message: 'authentication failed' })
          // Flush the refusal, accept nothing further, then force-close.
          socket.end()
          setTimeout(() => socket.destroy(), 250).unref()
          authenticated = null
          return
        }
        authenticated = true
        clearTimeout(deadline)
        stats.authenticated += 1
        send(socket, { type: 'authenticated', proof: proof(capability, 'server', generation, message.clientNonce, serverNonce) })
        return
      }
      queue.push(message)
      pump()
    }, () => {
      stats.overflows += 1
      send(socket, envelopeError(null, 'PROMPT_LIMIT', 'frame exceeds 2 MiB'))
      socket.destroy()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    const previous = process.umask(0o177)
    try { server.listen(endpoint, () => resolve()) } finally { process.umask(previous) }
  })
  fs.chmodSync(endpoint, 0o600)
  writePrivate(descriptor, JSON.stringify({ schemaVersion: 1, protocol: PROTOCOL, endpoint, generation, pid: process.pid, startedAtUtc: new Date().toISOString() }, null, 2) + '\n')
  log({ event: 'ipc-listening', endpoint, generation })
  let closed = false
  return {
    endpoint,
    stats: () => ({ ...stats }),
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
      for (const file of [descriptor, capabilityFile]) {
        try {
          if (file === descriptor) { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current.generation !== generation) continue }
          fs.rmSync(file, { force: true })
        } catch { /* already gone */ }
      }
      try { fs.rmSync(endpoint, { force: true }) } catch { /* already gone */ }
    },
  }
}

/** Client side: discover, authenticate both ways, then send bounded requests. */
async function connectIpc(options) {
  const { dataRoot } = options
  const timeoutMs = options.timeoutMs || HANDSHAKE_TIMEOUT_MS
  const { descriptor: descriptorPath, capability: capabilityPath } = discoveryPaths(dataRoot)
  let descriptor
  let capability
  try {
    descriptor = JSON.parse(readPrivate(descriptorPath).toString('utf8'))
    capability = Buffer.from(readPrivate(capabilityPath).toString('utf8').trim(), 'hex')
  } catch (error) {
    if (error instanceof IpcError) throw error
    throw new IpcError('HOST_UNAVAILABLE', 'no Nexus host is serving this installation')
  }
  if (descriptor.protocol !== PROTOCOL) throw new IpcError('PROTOCOL_UNSUPPORTED', 'host speaks ' + String(descriptor.protocol))
  if (descriptor.endpoint !== endpointFor(dataRoot)) throw new IpcError('HOST_IDENTITY_MISMATCH', 'descriptor endpoint is not this installation\'s private endpoint')
  const socket = net.createConnection(descriptor.endpoint)
  const inbox = []
  let waiter = null
  let failure = null
  const deliver = (message) => { if (waiter) { const w = waiter; waiter = null; w(message) } else inbox.push(message) }
  socket.on('error', (error) => { failure = error; deliver(null) })
  socket.on('close', () => { failure = failure || new IpcError('HOST_UNAVAILABLE', 'connection closed'); deliver(null) })
  frames(socket, deliver, () => { failure = new IpcError('INTERNAL', 'oversized frame from host'); socket.destroy() })
  const next = (ms) => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift())
    const timer = setTimeout(() => { waiter = null; reject(new IpcError('HOST_UNAVAILABLE', 'host did not answer in time')) }, ms)
    waiter = (message) => { clearTimeout(timer); message === null ? reject(failure && failure.code ? failure : new IpcError('HOST_UNAVAILABLE', String(failure && failure.message))) : resolve(message) }
  })
  try {
    const challenge = await next(timeoutMs)
    if (!challenge || challenge.type !== 'challenge' || challenge.protocol !== PROTOCOL) throw new IpcError('PROTOCOL_UNSUPPORTED', 'unexpected host greeting')
    if (challenge.generation !== descriptor.generation) throw new IpcError('HOST_IDENTITY_MISMATCH', 'host generation changed')
    const clientNonce = crypto.randomBytes(32).toString('hex')
    send(socket, { type: 'auth', clientNonce, proof: proof(capability, 'client', challenge.generation, challenge.serverNonce, clientNonce) })
    const answer = await next(timeoutMs)
    if (!answer || answer.type !== 'authenticated' || !safeEqualHex(answer.proof, proof(capability, 'server', challenge.generation, clientNonce, challenge.serverNonce))) {
      throw new IpcError(answer && answer.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'HOST_IDENTITY_MISMATCH', 'host authentication failed')
    }
    const generation = challenge.generation
    return {
      generation,
      async request(operation, input = {}, requestTimeoutMs = 35000) {
        const requestId = crypto.randomUUID()
        send(socket, { schemaVersion: 1, requestId, operation, input })
        return next(requestTimeoutMs)
      },
      sendRaw(text) { socket.write(text) },
      next,
      close() { socket.end(); socket.destroy() },
    }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

module.exports = { PROTOCOL, MAX_FRAME_BYTES, OPERATIONS, IpcError, startIpcServer, connectIpc, validateRequest, endpointFor, discoveryPaths, proof }
