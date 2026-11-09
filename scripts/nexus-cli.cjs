#!/usr/bin/env node
'use strict'

/**
 * nexus — first-party Nexus CLI (P2-B1 subset of the v1 contract).
 *
 * Implemented (read-only, over the authenticated local IPC transport to the
 * SAME host Controller the GUI uses):
 *   nexus host status [--json]
 *   nexus modes [--json]
 *   nexus status <task-id> [--json]
 *   nexus result <task-id> [--json]
 *   nexus wait <task-id> [--timeout <duration>] [--json]
 * Parsed and validated, then explicitly UNAVAILABLE (exit 4,
 * REQUIRED_CAPABILITY_UNAVAILABLE) until managed admission is proven safe:
 *   nexus submit | run | cancel | respond | workspace add | host start
 * Nothing is ever routed around the Controller and no DSH API is called.
 *
 * Installation discovery: the installation that contains this script
 * (<root>/scripts/nexus-cli.cjs -> <root>/data). No environment variable or
 * argument can point the CLI at another endpoint.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PROMPT_MAX_BYTES = 256 * 1024
const EXIT = Object.freeze({ ok: 0, usage: 2, connection: 3, refused: 4, failed: 5, cancelled: 6, pending: 7, internal: 8 })
const CODE_EXIT = Object.freeze({
  USAGE: 2, PROMPT_UNREADABLE: 2, PROMPT_INVALID_UTF8: 2, PROMPT_LIMIT: 2, PROMPT_BUDGET_UNVERIFIABLE: 2, WORKSPACE_INVALID: 2, MODE_UNKNOWN: 2,
  HOST_UNAVAILABLE: 3, HOST_NOT_READY: 3, HOST_IDENTITY_MISMATCH: 3, PROTOCOL_UNSUPPORTED: 3,
  AUTH_REQUIRED: 4, FORBIDDEN: 4, NOT_FOUND: 4, MODE_UNAVAILABLE: 4, REQUIRED_CAPABILITY_UNAVAILABLE: 4, IDEMPOTENCY_CONFLICT: 4, STALE_ACTION: 4,
  SUBMISSION_REJECTED: 5,
  CREDENTIAL_REJECTED: 4,
  INTERNAL: 8, STORAGE_UNAVAILABLE: 8, SUBMISSION_UNCERTAIN: 8,
})
const TASK_ID = /^(task|nt)_[0-9a-f]{32}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/
const TERMINAL_EXIT = Object.freeze({ completed: 0, failed: 5, cancelled: 6, interrupted: 6 })

class CliError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function exitFor(code) { return Object.prototype.hasOwnProperty.call(CODE_EXIT, code) ? CODE_EXIT[code] : EXIT.internal }

function parseDuration(text) {
  const match = /^(\d+)(ms|s|m)?$/.exec(String(text || ''))
  if (!match) throw new CliError('USAGE', 'duration must look like 500ms, 30s or 5m')
  const value = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000 }[match[2] || 's'])
  if (value <= 0 || value > 24 * 3600 * 1000) throw new CliError('USAGE', 'duration out of range')
  return value
}

/** Strict argv parser for the v1 command set. */
function parseArgs(argv) {
  const args = [...argv]
  const positional = []
  const flags = {}
  const takesValue = new Set(['--workspace', '--mode', '--prompt', '--prompt-file', '--idempotency-key', '--timeout', '--request', '--choice', '--revision', '--path', '--port'])
  const booleans = new Set(['--json', '--stdin', '--interactive', '--open'])
  while (args.length) {
    const item = args.shift()
    if (item === '--') { positional.push(...args); break }
    if (item.startsWith('--')) {
      if (booleans.has(item)) { if (flags[item]) throw new CliError('USAGE', `${item} given twice`); flags[item] = true; continue }
      if (!takesValue.has(item)) throw new CliError('USAGE', `unknown option ${item}`)
      if (Object.prototype.hasOwnProperty.call(flags, item)) throw new CliError('USAGE', `${item} given twice`)
      if (!args.length) throw new CliError('USAGE', `${item} needs a value`)
      flags[item] = args.shift()
      continue
    }
    positional.push(item)
  }
  const [command, ...rest] = positional
  if (!command) throw new CliError('USAGE', 'missing command')
  return { command, rest, flags, json: Boolean(flags['--json']) }
}

/** Read and validate prompt bytes (v1 contract §3). Never follows links. */
function readPromptBytes(flags, io) {
  const sources = ['--prompt', '--prompt-file', '--stdin'].filter((flag) => flags[flag] !== undefined)
  if (sources.length !== 1) throw new CliError('USAGE', 'exactly one of --prompt, --prompt-file or --stdin is required')
  let bytes
  let kind
  if (flags['--prompt'] !== undefined) {
    kind = 'text'
    bytes = Buffer.from(String(flags['--prompt']), 'utf8')
    if (bytes.length > PROMPT_MAX_BYTES) throw new CliError('PROMPT_LIMIT', `prompt exceeds ${PROMPT_MAX_BYTES} bytes`)
  } else if (flags['--prompt-file'] !== undefined) {
    kind = 'file'
    const file = path.resolve(io.cwd, flags['--prompt-file'])
    let before
    try { before = fs.lstatSync(file) } catch { throw new CliError('PROMPT_UNREADABLE', 'prompt file is not readable') }
    if (before.isSymbolicLink()) throw new CliError('PROMPT_UNREADABLE', 'prompt file must not be a symbolic link')
    if (!before.isFile()) throw new CliError('PROMPT_UNREADABLE', 'prompt file must be a regular file')
    let fd
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)) } catch { throw new CliError('PROMPT_UNREADABLE', 'prompt file could not be opened safely') }
    try {
      const opened = fs.fstatSync(fd)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new CliError('PROMPT_UNREADABLE', 'prompt file changed while it was opened')
      const buffer = Buffer.alloc(PROMPT_MAX_BYTES + 1)
      let total = 0
      for (;;) {
        const read = fs.readSync(fd, buffer, total, buffer.length - total, null)
        if (read === 0) break
        total += read
        if (total > PROMPT_MAX_BYTES) throw new CliError('PROMPT_LIMIT', `prompt exceeds ${PROMPT_MAX_BYTES} bytes`)
      }
      bytes = buffer.subarray(0, total)
    } finally { fs.closeSync(fd) }
  } else {
    kind = 'stdin'
    bytes = io.readStdin(PROMPT_MAX_BYTES + 1)
    if (bytes.length > PROMPT_MAX_BYTES) throw new CliError('PROMPT_LIMIT', `prompt exceeds ${PROMPT_MAX_BYTES} bytes`)
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new CliError('PROMPT_INVALID_UTF8', 'prompt is not valid UTF-8') }
  if (text.includes('\u0000')) throw new CliError('PROMPT_INVALID_UTF8', 'prompt contains NUL')
  if (text.trim() === '') throw new CliError('USAGE', 'prompt is empty')
  return { kind, text, bytes: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') }
}

function validateWorkspace(value, io) {
  if (typeof value !== 'string' || value === '') throw new CliError('USAGE', '--workspace is required')
  const resolved = path.resolve(io.cwd, value)
  let real
  try { real = fs.realpathSync(resolved) } catch { throw new CliError('WORKSPACE_INVALID', 'workspace does not exist') }
  if (!fs.statSync(real).isDirectory()) throw new CliError('WORKSPACE_INVALID', 'workspace is not a directory')
  return real
}

function unavailable(command) {
  return new CliError('REQUIRED_CAPABILITY_UNAVAILABLE', `nexus ${command} is not available in this version: managed Nexus tasks are disabled until their security prerequisites (owner-peer authorization, durable intake, approval broker) are proven. Use the Nexus app.`)
}

async function connect(io) {
  const ipc = io.ipc || require(path.join(io.installRoot, 'config', 'nexus', 'ipc.cjs'))
  try {
    return await ipc.connectIpc({ dataRoot: io.dataRoot })
  } catch (error) {
    throw new CliError(error && error.code && CODE_EXIT[error.code] !== undefined ? error.code : 'HOST_UNAVAILABLE', error && error.message ? error.message : 'host unavailable')
  }
}

async function call(io, operation, input) {
  const client = await connect(io)
  try {
    const response = await client.request(operation, input)
    if (!response || typeof response !== 'object' || response.schemaVersion !== 1) throw new CliError('PROTOCOL_UNSUPPORTED', 'unexpected host response')
    return response
  } finally { client.close() }
}

function render(io, json, envelope, human) {
  if (json) io.stdout(JSON.stringify(envelope) + '\n')
  else if (envelope.ok) io.stdout(human(envelope.data) + '\n')
  else io.stderr(`nexus: ${envelope.error.code}: ${envelope.error.message}\n`)
}

const MODE_PRESET = Object.freeze({ 'engineering-v1': 'aih-engineering', 'engineering-v2': 'aih-muse' })
const PRESET_IDS = Object.freeze(['aih-engineering', 'aih-deepseek', 'aih-muse'])

/**
 * `nexus host start` — start (or reuse) THIS installation's Nexus host through
 * the existing launcher (scripts/aih.ps1: launch lock, single-host election,
 * pinned DSH, product composition), then confirm Controller readiness over the
 * authenticated IPC. Never starts a second host: a running host is reused.
 */
async function hostStart(io, json, requestId, flags) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(io.installRoot, 'scripts', 'aih.ps1'), '-InstallRoot', io.installRoot]
  if (flags['--mode'] !== undefined) {
    const preset = MODE_PRESET[flags['--mode']] || flags['--mode']
    if (!PRESET_IDS.includes(preset)) throw new CliError('MODE_UNKNOWN', 'unknown mode ' + flags['--mode'])
    args.push('-Preset', preset)
  }
  if (flags['--port'] !== undefined) {
    if (!/^\d{2,5}$/.test(String(flags['--port'])) || Number(flags['--port']) > 65535) throw new CliError('USAGE', '--port must be a TCP port')
    args.push('-Port', String(flags['--port']))
  }
  if (flags['--open']) args.push('-Open')
  if (flags['--workspace'] !== undefined) args.push(validateWorkspace(flags['--workspace'], io))
  const launched = await (io.launch || launchProcess)(io.pwshHost || defaultPwshHost(io.installRoot), args, { cwd: io.installRoot })
  if (!json) io.stderr(launched.stdout.split('\n').filter(Boolean).map((line) => 'nexus: ' + line).join('\n') + (launched.stdout ? '\n' : ''))
  if (launched.code !== 0) {
    const tail = (launched.stderr || launched.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)
    throw new CliError('HOST_UNAVAILABLE', 'the Nexus launcher failed (exit ' + launched.code + ')' + (tail ? ': ' + tail : ''))
  }
  const url = (launched.stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/\S*/g) || []).pop() || null
  const deadline = Date.now() + (flags['--timeout'] ? parseDuration(flags['--timeout']) : 60000)
  let hello = null
  let lastError = null
  for (;;) {
    try { hello = await call(io, 'hello', {}); if (hello.ok && hello.data.ready) break } catch (error) { lastError = error }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!hello || !hello.ok || !hello.data.ready) throw new CliError('HOST_NOT_READY', 'the host started but the Nexus Controller did not become ready' + (lastError ? ': ' + lastError.message : ''))
  const data = { started: true, url, ready: true, controllerBuild: hello.data.controllerBuild, ownership: hello.data.ownership.state, managedAdmission: hello.data.managedAdmission, operations: hello.data.operations }
  render(io, json, { schemaVersion: 1, ok: true, requestId, data }, (d) => `Nexus host READY · ${d.url || 'url unknown'} · managed tasks ${d.managedAdmission}`)
  return EXIT.ok
}

function defaultPwshHost(installRoot) {
  if (process.env.AIH_PWSH_HOST) return process.env.AIH_PWSH_HOST
  if (process.platform === 'win32') return 'powershell.exe'
  const pinned = path.join(installRoot, 'runtime', 'pwsh', 'pwsh')
  return fs.existsSync(pinned) ? pinned : 'pwsh'
}

function launchProcess(file, args, options) {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process')
    let child
    try { child = spawn(file, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) } catch (error) { resolve({ code: 127, stdout: '', stderr: String(error.message) }); return }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr + String(error.message) }))
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }))
  })
}

/** Human summary of a task view: status, any turn error, operator actions and Nexus's last reply. */
function describeTask(d) {
  const label = d.status === 'blocked' && d.statusReason === 'turn-completed-awaiting-verification'
    ? 'turn completed (awaiting verification)'
    : d.status + (d.statusReason ? ` (${d.statusReason})` : '')
  let text = `${d.taskId}\t${label}`
  if (d.turn && d.turn.error) text += `\n  turn error: ${d.turn.error.message}`
  for (const a of d.operatorActions || []) text += `\n  action ${a.id} rev ${a.revision}: ${a.label} [${a.choices.map((c) => c.id).join('|')}]`
  if (d.reply && d.reply.text) text += `\n\n── Nexus ──\n${d.reply.text}`
  return text
}

/** Follow a task to a terminal state, a hold or the deadline (non-interactive). */
async function followTask(io, json, requestId, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let after
  for (;;) {
    const waitMs = Math.max(0, Math.min(30000, deadline - Date.now()))
    const response = await call(io, 'follow', after === undefined ? { taskId, waitMs } : { taskId, afterRevision: after, waitMs })
    if (!response.ok) { render(io, json, { ...response, requestId }, () => ''); return exitFor(response.error.code) }
    const view = response.data.view
    if (view) {
      after = view.revision
      if (!json) io.stderr(`nexus: ${view.taskId} ${view.status} (revision ${view.revision})\n`)
      if (Object.prototype.hasOwnProperty.call(TERMINAL_EXIT, view.status)) {
        render(io, json, { schemaVersion: 1, ok: true, requestId, data: view }, describeTask)
        return TERMINAL_EXIT[view.status]
      }
      if (view.status === 'blocked' || view.status === 'awaiting_operator') {
        // Non-interactive: report the pending action truthfully; never answer it.
        render(io, json, { schemaVersion: 1, ok: true, requestId, data: view }, describeTask)
        return EXIT.pending
      }
    }
    if (Date.now() >= deadline) {
      render(io, json, { schemaVersion: 1, ok: true, requestId, data: { taskId, status: 'pending', revision: after || null, timedOut: true } }, (d) => `${d.taskId}\twait deadline reached`)
      return EXIT.pending
    }
  }
}

/** Run one CLI invocation. Returns the exit code; never throws. */
async function run(argv, io) {
  const requestId = crypto.randomUUID()
  let json = argv.includes('--json')
  try {
    const parsed = parseArgs(argv)
    json = parsed.json
    const { command, rest, flags } = parsed
    const taskArg = () => {
      if (rest.length !== 1 || !TASK_ID.test(rest[0])) throw new CliError('USAGE', 'a single Nexus task id (task_<32 hex> or nt_<32 hex>) is required')
      return rest[0]
    }
    if (command === 'host') {
      const sub = rest[0]
      if (sub === 'start') {
        if (rest.length !== 1) throw new CliError('USAGE', 'host start takes flags only')
        return await hostStart(io, json, requestId, flags)
      }
      if (sub !== 'status' || rest.length !== 1) throw new CliError('USAGE', 'expected: nexus host status')
      const response = await call(io, 'hello', {})
      render(io, json, { ...response, requestId }, (d) => `Nexus host ${d.ready ? 'READY' : 'NOT READY'} · controller ${d.controllerBuild} · ownership ${d.ownership.state} · managed tasks ${d.managedAdmission}`)
      return response.ok ? (response.data.ready ? EXIT.ok : EXIT.connection) : exitFor(response.error.code)
    }
    if (command === 'modes') {
      if (rest.length) throw new CliError('USAGE', 'modes takes no arguments')
      const response = await call(io, 'listModes', {})
      render(io, json, { ...response, requestId }, (d) => d.modes.map((m) => `${m.id}\t${m.ready ? 'ready' : 'not ready'}\t${m.submittable ? 'submittable' : 'not submittable (' + m.blockedReason + ')'}`).join('\n'))
      return response.ok ? EXIT.ok : exitFor(response.error.code)
    }
    if (command === 'status' || command === 'result') {
      const taskId = taskArg()
      const response = await call(io, command === 'status' ? 'getStatus' : 'getResult', { taskId })
      render(io, json, { ...response, requestId }, describeTask)
      if (!response.ok) return exitFor(response.error.code)
      if (command === 'status') return EXIT.ok
      return Object.prototype.hasOwnProperty.call(TERMINAL_EXIT, response.data.status) ? TERMINAL_EXIT[response.data.status] : EXIT.pending
    }
    if (command === 'wait') {
      const taskId = taskArg()
      if (flags['--interactive']) throw new CliError('USAGE', '--interactive is not available')
      return await followTask(io, json, requestId, taskId, flags['--timeout'] ? parseDuration(flags['--timeout']) : 24 * 3600 * 1000)
    }
    if (command === 'submit' || command === 'run') {
      if (rest.length) throw new CliError('USAGE', `${command} takes no positional arguments`)
      validateWorkspace(flags['--workspace'], io)
      if (typeof flags['--mode'] !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(flags['--mode'])) throw new CliError('USAGE', '--mode is required')
      if (flags['--idempotency-key'] !== undefined && !IDEMPOTENCY_KEY.test(flags['--idempotency-key'])) throw new CliError('USAGE', '--idempotency-key must be 1-128 printable characters')
      if (command === 'run' && flags['--timeout'] !== undefined) parseDuration(flags['--timeout'])
      if (command === 'run' && flags['--interactive']) throw new CliError('USAGE', '--interactive is not available in this version; answer operator actions with nexus respond')
      const workspace = validateWorkspace(flags['--workspace'], io)
      const prompt = readPromptBytes(flags, io)
      const generatedKey = flags['--idempotency-key'] === undefined
      const idempotencyKey = generatedKey ? 'cli-' + crypto.randomUUID() : flags['--idempotency-key']
      if (generatedKey && !json) io.stderr(`nexus: idempotency key ${idempotencyKey} (reuse it to retry this exact submission)\n`)
      const response = await call(io, 'submit', { idempotencyKey, workspace, mode: flags['--mode'], prompt: { kind: prompt.kind, text: prompt.text, digest: prompt.digest } })
      if (!response.ok || command === 'submit') {
        render(io, json, { ...response, requestId }, (d) => `${d.taskId}\t${d.status}\tsession ${d.sessionId}`)
        return response.ok ? EXIT.ok : exitFor(response.error.code)
      }
      if (!json) io.stderr(`nexus: accepted ${response.data.taskId}\n`)
      return await followTask(io, json, requestId, response.data.taskId, flags['--timeout'] ? parseDuration(flags['--timeout']) : 24 * 3600 * 1000)
    }
    if (command === 'cancel') {
      const taskId = taskArg()
      const response = await call(io, 'cancel', { taskId })
      render(io, json, { ...response, requestId }, (d) => `${d.taskId}\t${d.status}\t${d.disposition}`)
      return response.ok ? EXIT.ok : exitFor(response.error.code)
    }
    if (command === 'respond') {
      const taskId = taskArg()
      for (const flag of ['--request', '--choice', '--revision']) if (typeof flags[flag] !== 'string') throw new CliError('USAGE', `${flag} is required`)
      if (!/^\d+$/.test(flags['--revision'])) throw new CliError('USAGE', '--revision must be a decimal string')
      const response = await call(io, 'respond', { taskId, actionId: flags['--request'], expectedRevision: flags['--revision'], choiceId: flags['--choice'] })
      render(io, json, { ...response, requestId }, (d) => `${d.taskId}\t${d.actionId}\t${d.disposition}`)
      return response.ok ? EXIT.ok : exitFor(response.error.code)
    }
    if (command === 'credentials') {
      const sub = rest[0]
      if (sub === 'list') {
        const refs = rest.slice(1)
        const response = await call(io, 'listCredentials', refs.length ? { refs } : {})
        render(io, json, { ...response, requestId }, (d) => d.credentials.map((c) => `${c.ref}\t${c.configured ? 'set' : 'missing'}${c.source ? '\t' + c.source : ''}`).join('\n'))
        return response.ok ? EXIT.ok : exitFor(response.error.code)
      }
      if (sub === 'set') {
        if (rest.length !== 2) throw new CliError('USAGE', 'expected: nexus credentials set <NAME> --stdin')
        if (!flags['--stdin']) throw new CliError('USAGE', 'the value is read from stdin only (never from arguments): nexus credentials set <NAME> --stdin')
        const raw = io.readStdin(16 * 1024 + 2)
        let value
        try { value = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { throw new CliError('USAGE', 'the value is not valid UTF-8') }
        value = value.replace(/\r?\n$/, '')
        if (value.trim() === '') throw new CliError('USAGE', 'empty value on stdin')
        if (/[\r\n\u0000]/.test(value) || Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new CliError('USAGE', 'the value must be one line of at most 16 KiB')
        const response = await call(io, 'setCredential', { ref: rest[1], value })
        render(io, json, { ...response, requestId }, (d) => `${d.ref}\t${d.configured ? 'set' : 'not set'}`)
        return response.ok ? EXIT.ok : exitFor(response.error.code)
      }
      if (sub === 'unset') {
        if (rest.length !== 2) throw new CliError('USAGE', 'expected: nexus credentials unset <NAME>')
        const response = await call(io, 'unsetCredential', { ref: rest[1] })
        render(io, json, { ...response, requestId }, (d) => `${d.ref}\tremoved`)
        return response.ok ? EXIT.ok : exitFor(response.error.code)
      }
      throw new CliError('USAGE', 'expected: nexus credentials list [NAME...] | set <NAME> --stdin | unset <NAME>')
    }
    if (command === 'workspace') {
      if (rest[0] !== 'add' || rest.length !== 1) throw new CliError('USAGE', 'expected: nexus workspace add --path <dir>')
      const target = validateWorkspace(flags['--path'], io)
      const response = await call(io, 'registerWorkspace', { path: target })
      render(io, json, { ...response, requestId }, (d) => `${d.workspaceId}\t${d.path}\t${d.disposition}`)
      return response.ok ? EXIT.ok : exitFor(response.error.code)
    }
    throw new CliError('USAGE', `unknown command ${command}`)
  } catch (error) {
    const code = error instanceof CliError ? error.code : 'INTERNAL'
    const message = error instanceof CliError ? error.message : 'internal error'
    const envelope = { schemaVersion: 1, ok: false, requestId, error: { code, message, retryable: code === 'HOST_UNAVAILABLE' || code === 'HOST_NOT_READY' } }
    if (json) io.stdout(JSON.stringify(envelope) + '\n')
    else io.stderr(`nexus: ${code}: ${message}\n`)
    return exitFor(code)
  }
}

function defaultIo() {
  const installRoot = path.resolve(__dirname, '..')
  return {
    installRoot,
    dataRoot: path.join(installRoot, 'data'),
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin(limit) {
      const chunks = []
      let total = 0
      const buffer = Buffer.alloc(65536)
      for (;;) {
        let read
        try { read = fs.readSync(0, buffer, 0, buffer.length, null) } catch (error) { if (error.code === 'EAGAIN') continue; if (error.code === 'EOF') break; throw error }
        if (read === 0) break
        chunks.push(Buffer.from(buffer.subarray(0, read)))
        total += read
        if (total >= limit) break
      }
      return Buffer.concat(chunks).subarray(0, limit)
    },
  }
}

module.exports = { run, parseArgs, readPromptBytes, exitFor, EXIT, PROMPT_MAX_BYTES, CliError }

if (require.main === module) {
  run(process.argv.slice(2), defaultIo()).then((code) => { process.exitCode = code })
}
