'use strict'

/**
 * P2-B1 Priority D: first-party CLI subset (read-only commands over the real
 * authenticated IPC transport; mutating commands explicitly unavailable).
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sourceRoot = path.join(__dirname, '..')
const cli = require('../scripts/nexus-cli.cjs')
const ipc = require('../config/nexus/ipc.cjs')
const controllerModule = require('../config/nexus/controller.cjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-test-'))
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }

function io(dataRoot, stdin = Buffer.alloc(0)) {
  const out = { stdout: '', stderr: '' }
  return { out, value: { installRoot: sourceRoot, dataRoot, cwd: scratch, stdout: (t) => { out.stdout += t }, stderr: (t) => { out.stderr += t }, readStdin: (limit) => stdin.subarray(0, limit) } }
}
async function exec(argv, dataRoot, stdin) {
  const harness = io(dataRoot, stdin)
  const code = await cli.run(argv, harness.value)
  let json = null
  try { json = JSON.parse(harness.out.stdout) } catch { /* human output */ }
  return { code, json, ...harness.out }
}

async function main() {
  const noHost = path.join(scratch, 'none', 'data')
  fs.mkdirSync(path.join(noHost, 'routing'), { recursive: true })

  // Usage and input validation (exit 2), one JSON document on stdout.
  for (const argv of [[], ['frobnicate'], ['status'], ['status', 'TASK-0001'], ['modes', 'extra'], ['status', 'task_' + 'a'.repeat(32), '--bogus'], ['wait', 'task_' + 'a'.repeat(32), '--timeout', 'soon']]) {
    const result = await exec([...argv, '--json'], noHost)
    assert.equal(result.code, 2, JSON.stringify(argv)); assert.equal(result.json.ok, false); assert.equal(result.json.error.code, 'USAGE')
  }
  pass('usage errors exit 2 with a single JSON envelope')

  const ws = fs.mkdtempSync(path.join(scratch, 'ws-'))
  const write = (name, data) => { const file = path.join(scratch, name); fs.writeFileSync(file, data); return file }
  const submit = (extra) => ['submit', '--workspace', ws, '--mode', 'engineering-v2', ...extra, '--json']
  const cases = [
    [submit([]), 'USAGE'],
    [submit(['--prompt', 'a', '--stdin']), 'USAGE'],
    [submit(['--prompt-file', path.join(scratch, 'missing.md')]), 'PROMPT_UNREADABLE'],
    [submit(['--prompt-file', scratch]), 'PROMPT_UNREADABLE'],
    [submit(['--prompt-file', write('big.md', Buffer.alloc(cli.PROMPT_MAX_BYTES + 1, 0x61))]), 'PROMPT_LIMIT'],
    [submit(['--prompt-file', write('bad.md', Buffer.from([0x66, 0xff, 0xfe]))]), 'PROMPT_INVALID_UTF8'],
    [submit(['--prompt-file', write('nul.md', Buffer.from('a\u0000b'))]), 'PROMPT_INVALID_UTF8'],
    [submit(['--prompt-file', write('blank.md', ' \r\n\t ')]), 'USAGE'],
    [['submit', '--workspace', path.join(scratch, 'nope'), '--mode', 'engineering-v2', '--prompt', 'x', '--json'], 'WORKSPACE_INVALID'],
    [['submit', '--workspace', ws, '--mode', 'engineering-v2', '--prompt', 'x', '--idempotency-key', 'has space', '--json'], 'USAGE'],
  ]
  fs.symlinkSync(write('target.md', 'hello'), path.join(scratch, 'link.md'))
  cases.push([submit(['--prompt-file', path.join(scratch, 'link.md')]), 'PROMPT_UNREADABLE'])
  for (const [argv, expected] of cases) {
    const result = await exec(argv, noHost)
    assert.equal(result.json.error.code, expected, JSON.stringify(argv) + ' -> ' + result.stdout)
    assert.equal(result.code, 2)
  }
  const stdinLimit = await exec(submit(['--stdin']), noHost, Buffer.alloc(cli.PROMPT_MAX_BYTES + 5, 0x62))
  assert.equal(stdinLimit.json.error.code, 'PROMPT_LIMIT')
  const prompt = cli.readPromptBytes({ '--prompt-file': write('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Idea\r\nline ✓\n')])) }, { cwd: scratch })
  assert.equal(prompt.text, '# Idea\r\nline ✓\n', 'one BOM removed, CRLF and Unicode preserved')
  assert.equal(prompt.digest, 'sha256:' + crypto.createHash('sha256').update(Buffer.from('# Idea\r\nline ✓\n')).digest('hex'))
  pass('untrusted prompt sources are validated (symlink, directory, size, UTF-8, NUL, blank, BOM) and workspaces must exist')

  // P2-B2B: task mutations go only to the host Controller (no host => exit 3,
  // nothing written locally); workspace add / host start stay unavailable.
  const mutations = [submit(['--prompt', 'Implement it.']), ['run', '--workspace', ws, '--mode', 'engineering-v1', '--prompt', 'x', '--json'], ['cancel', 'nt_' + 'b'.repeat(32), '--json'], ['respond', 'nt_' + 'b'.repeat(32), '--request', 'act_1', '--choice', 'allow-once', '--revision', '3', '--json']]
  for (const argv of mutations) {
    const result = await exec(argv, noHost)
    assert.equal(result.code, 3, JSON.stringify(argv)); assert.equal(result.json.error.code, 'HOST_UNAVAILABLE')
  }
  {
    // workspace add is an owner operation on the host (never a local write).
    const result = await exec(['workspace', 'add', '--path', ws, '--json'], noHost)
    assert.equal(result.code, 3); assert.equal(result.json.error.code, 'HOST_UNAVAILABLE')
  }
  // host start goes through the existing launcher (aih.ps1) with mapped flags;
  // a launcher failure is HOST_UNAVAILABLE (exit 3) and nothing else starts.
  {
    const calls = []
    const harness = io(noHost)
    harness.value.launch = async (file, args) => { calls.push({ file, args }); return { code: 1, stdout: '', stderr: 'boom' } }
    harness.value.pwshHost = '/fake/pwsh'
    const code = await cli.run(['host', 'start', '--workspace', ws, '--mode', 'engineering-v2', '--port', '3090', '--open', '--json'], harness.value)
    assert.equal(code, 3)
    assert.equal(JSON.parse(harness.out.stdout).error.code, 'HOST_UNAVAILABLE')
    assert.equal(calls.length, 1); assert.equal(calls[0].file, '/fake/pwsh')
    const a = calls[0].args
    assert.ok(a.includes(path.join(sourceRoot, 'scripts', 'aih.ps1')))
    assert.deepEqual(a.slice(a.indexOf('-Preset'), a.indexOf('-Preset') + 2), ['-Preset', 'aih-muse'])
    assert.deepEqual(a.slice(a.indexOf('-Port'), a.indexOf('-Port') + 2), ['-Port', '3090'])
    assert.ok(!a.includes('-Open'), 'the CLI opens the tokenized URL itself'); assert.equal(a[a.length - 1], fs.realpathSync(ws))
    const bad = await exec(['host', 'start', '--mode', 'nova', '--json'], noHost)
    assert.equal(bad.code, 2); assert.equal(bad.json.error.code, 'MODE_UNKNOWN')
  }
  const interactive = await exec(['run', '--workspace', ws, '--mode', 'engineering-v1', '--prompt', 'x', '--interactive', '--json'], noHost)
  assert.equal(interactive.code, 2); assert.equal(interactive.json.error.code, 'USAGE')
  assert.deepEqual(fs.readdirSync(path.join(noHost)).sort(), ['routing'], 'the CLI never writes intake or task state itself')
  pass('submit/run/cancel/respond go only to the host Controller (exit 3 without one); host start runs only the existing launcher; workspace add goes only to the host')

  // No host: read commands fail with connection class (exit 3).
  const unavailable = await exec(['host', 'status', '--json'], noHost)
  assert.equal(unavailable.code, 3); assert.equal(unavailable.json.error.code, 'HOST_UNAVAILABLE')
  pass('read commands without a serving host exit 3 (HOST_UNAVAILABLE) and start nothing')

  // Real host Controller + IPC.
  const dataRoot = path.join(scratch, 'host', 'data')
  const workspace = path.join(scratch, 'host', 'ws')
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.mkdirSync(path.join(workspace, '.ai-harness', 'state'), { recursive: true })
  const running = 'task_' + crypto.randomBytes(16).toString('hex')
  const done = 'task_' + crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {
    s1: { sessionId: 's1', taskInstanceId: running, taskId: 'TASK-0001', workspace, engine: 'dual', preset: 'aih-engineering' },
    s2: { sessionId: 's2', taskInstanceId: done, taskId: 'TASK-0002', workspace, engine: 'muse', preset: 'aih-muse' },
  } }))
  const ledger = path.join(workspace, '.ai-harness', 'state', 'tasks.json')
  fs.writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, tasks: [{ taskId: 'TASK-0001', taskInstanceId: running, status: 'implementing' }, { taskId: 'TASK-0002', taskInstanceId: done, status: 'complete' }] }))
  // Fake DSH credentials controller: records writes, describes without values.
  const vault = new Map()
  const credentials = {
    async describe(refs) { return Object.fromEntries(refs.map((ref) => [ref, { configured: vault.has(ref), writable: true, ...(vault.has(ref) ? { source: 'file' } : {}) }])) },
    async set(ref, value) { vault.set(ref, value) },
    async unset(ref) { vault.delete(ref) },
  }
  const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot, workspaceAuthorizer: async () => true, credentials })
  const server = await ipc.startIpcServer({ core, dataRoot, generation: 'cli-gen' })
  const hostStatus = await exec(['host', 'status', '--json'], dataRoot)
  assert.equal(hostStatus.code, 0); assert.equal(hostStatus.json.data.managedAdmission, 'disabled')
  const modes = await exec(['modes', '--json'], dataRoot)
  assert.deepEqual(modes.json.data.modes.map((m) => m.id).sort(), ['engineering-v1', 'engineering-v2'])
  const status = await exec(['status', running, '--json'], dataRoot)
  assert.equal(status.code, 0); assert.equal(status.json.data.status, 'running')
  const pending = await exec(['result', running, '--json'], dataRoot)
  assert.equal(pending.code, 7, 'a non-terminal result exits 7, never 0')
  const completed = await exec(['result', done, '--json'], dataRoot)
  assert.equal(completed.code, 0); assert.equal(completed.json.data.outcome, 'completed')
  const unknown = await exec(['status', 'task_' + 'c'.repeat(32), '--json'], dataRoot)
  assert.equal(unknown.code, 4); assert.equal(unknown.json.error.code, 'NOT_FOUND')
  const waitTimeout = await exec(['wait', running, '--timeout', '300ms', '--json'], dataRoot)
  assert.equal(waitTimeout.code, 7); assert.equal(waitTimeout.json.data.timedOut, true)
  setTimeout(() => fs.writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, tasks: [{ taskId: 'TASK-0001', taskInstanceId: running, status: 'failed' }, { taskId: 'TASK-0002', taskInstanceId: done, status: 'complete' }] })), 300)
  const waited = await exec(['wait', running, '--timeout', '10s', '--json'], dataRoot)
  assert.equal(waited.code, 5, 'an authoritative failure exits 5'); assert.equal(waited.json.data.status, 'failed')
  const human = await exec(['status', running], dataRoot)
  assert.equal(human.code, 0); assert.match(human.stdout, /failed/)
  pass('read-only host status, modes, status, result and wait over authenticated IPC with contract exit codes (0/4/5/7)')

  // The host refuses submit while managed activation is inactive (exit 4).
  const refusedSubmit = await exec(['submit', '--workspace', workspace, '--mode', 'engineering-v2', '--prompt', 'x', '--idempotency-key', 'k1', '--json'], dataRoot)
  assert.equal(refusedSubmit.code, 4); assert.equal(refusedSubmit.json.error.code, 'REQUIRED_CAPABILITY_UNAVAILABLE'); assert.equal(refusedSubmit.json.error.details.reason, 'managed-admission-disabled')
  const refusedRun = await exec(['run', '--workspace', workspace, '--mode', 'engineering-v1', '--prompt', 'x', '--json'], dataRoot)
  assert.equal(refusedRun.code, 4)
  const legacyCancel = await exec(['cancel', running, '--json'], dataRoot)
  assert.equal(legacyCancel.code, 4); assert.equal(legacyCancel.json.error.details.reason, 'legacy-task')
  const missingAction = await exec(['respond', running, '--request', 'act_x', '--choice', 'allow-once', '--revision', '1', '--json'], dataRoot)
  assert.equal(missingAction.code, 4); assert.equal(missingAction.json.error.code, 'NOT_FOUND')
  pass('host refuses submit/run while managed activation is inactive; legacy cancel and unknown actions are refused')

  // Unified keys: set through stdin only, stored via the host's credentials service, never echoed.
  const secret = 'sk-test-' + crypto.randomBytes(12).toString('hex')
  const listed = await exec(['credentials', 'list', '--json'], dataRoot)
  assert.equal(listed.code, 0); assert.deepEqual(listed.json.data.credentials.map((c) => [c.ref, c.configured]), [['OPENCODE_API_KEY', false], ['DEEPSEEK_API_KEY', false], ['ZAI_API_KEY', false], ['MODEL_API_KEY', false]])
  const noStdin = await exec(['credentials', 'set', 'OPENCODE_API_KEY', '--json'], dataRoot)
  assert.equal(noStdin.code, 2, 'the value is never taken from arguments')
  const argvValue = await exec(['credentials', 'set', 'OPENCODE_API_KEY', secret, '--json'], dataRoot)
  assert.equal(argvValue.code, 2)
  const stored = await exec(['credentials', 'set', 'OPENCODE_API_KEY', '--stdin', '--json'], dataRoot, Buffer.from(secret + '\n'))
  assert.equal(stored.code, 0, stored.stdout); assert.deepEqual(stored.json.data, { ref: 'OPENCODE_API_KEY', configured: true, disposition: 'stored' })
  assert.equal(vault.get('OPENCODE_API_KEY'), secret, 'stored exactly (one trailing newline stripped)')
  const humanList = await exec(['credentials', 'list', 'OPENCODE_API_KEY'], dataRoot)
  assert.match(humanList.stdout, /OPENCODE_API_KEY\tset/)
  for (const output of [stored.stdout, stored.stderr, humanList.stdout, listed.stdout]) assert.equal(output.includes(secret), false, 'the value never appears in output')
  assert.equal((await exec(['credentials', 'set', 'BAD-NAME', '--stdin', '--json'], dataRoot, Buffer.from('x'))).json.error.code, 'USAGE')
  assert.equal((await exec(['credentials', 'set', 'OPENCODE_API_KEY', '--stdin', '--json'], dataRoot, Buffer.from('a\nb\n'))).code, 2, 'multi-line values are refused')
  // Refused while a managed task is live or pending.
  core.admission.register('session-running-task', { taskKey: 'demo' })
  const blocked = await exec(['credentials', 'set', 'OPENCODE_API_KEY', '--stdin', '--json'], dataRoot, Buffer.from('other'))
  assert.equal(blocked.code, 4); assert.equal(blocked.json.error.details.reason, 'nexus-host-protected-while-active')
  assert.equal(vault.get('OPENCODE_API_KEY'), secret)
  core.admission.unregister('session-running-task')
  const removed = await exec(['credentials', 'unset', 'OPENCODE_API_KEY', '--json'], dataRoot)
  assert.equal(removed.code, 0); assert.equal(vault.has('OPENCODE_API_KEY'), false)
  pass('credentials: list shows set/missing only, set reads stdin only and never echoes the value, unset removes; changes refused while a task runs')

  // host start success path: the launcher only printed the bare URL (host already
  // running); the CLI recovers the running host's login link from its own stdout
  // log (aih-state.json -> StdoutLog), confirms readiness over IPC and opens it.
  {
    const token = crypto.randomBytes(16).toString('base64url')
    const stdoutLog = path.join(dataRoot, 'dsh.out.log')
    fs.writeFileSync(stdoutLog, 'dsh web: http://127.0.0.1:3090/?token=' + token + '\n')
    fs.writeFileSync(path.join(dataRoot, 'aih-state.json'), JSON.stringify({ Url: 'http://127.0.0.1:3090', StdoutLog: stdoutLog }))
    const opened = []
    const harness = io(dataRoot)
    harness.value.launch = async () => ({ code: 0, stdout: 'Nexus status: READY (universal runtime already running)\nhttp://127.0.0.1:3090\n', stderr: '' })
    harness.value.pwshHost = '/fake/pwsh'
    harness.value.openUrl = (url) => opened.push(url)
    const code = await cli.run(['host', 'start', '--open', '--json'], harness.value)
    const envelope = JSON.parse(harness.out.stdout)
    assert.equal(code, 0, harness.out.stdout + harness.out.stderr)
    assert.equal(envelope.data.ready, true); assert.equal(envelope.data.url, 'http://127.0.0.1:3090/?token=' + token)
    assert.deepEqual(opened, ['http://127.0.0.1:3090/?token=' + token], '--open opens the tokenized login URL, not the bare URL')
    // A log from another port is never used.
    fs.writeFileSync(path.join(dataRoot, 'aih-state.json'), JSON.stringify({ Url: 'http://127.0.0.1:3091', StdoutLog: stdoutLog }))
    const other = io(dataRoot)
    other.value.launch = harness.value.launch; other.value.pwshHost = '/fake/pwsh'; other.value.openUrl = () => {}
    await cli.run(['host', 'start', '--json'], other.value)
    assert.equal(JSON.parse(other.out.stdout).data.url, 'http://127.0.0.1:3090', 'a login link for a different port is not reused')
    fs.rmSync(path.join(dataRoot, 'aih-state.json')); fs.rmSync(stdoutLog)
  }
  pass('host start: recovers the running host\'s login link from its own log (same port only), confirms readiness over IPC, --open opens the tokenized URL')

  // session check (read-only): held/healthy verdicts map to exit 7/0, no session -> NOT_FOUND.
  {
    const verdicts = new Map([['session-ok', { state: 'healthy', reason: null, repair: null, source: 'durable' }], ['session-held', { state: 'held', reason: 'session-history-notice-before-head', repair: 'not-repairable-losslessly', source: 'durable' }]])
    const hc = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot: path.join(scratch, 'health', 'data'), workspaceAuthorizer: async () => true, sessionHealth: { check: async (id) => verdicts.get(id) || { state: 'unknown' }, checkLive: () => null, peek: () => null, cwdOf: async () => workspace } })
    fs.mkdirSync(path.join(scratch, 'health', 'data', 'routing'), { recursive: true })
    const hs = await ipc.startIpcServer({ core: hc, dataRoot: path.join(scratch, 'health', 'data'), generation: 'health-gen' })
    const ok = await exec(['session', 'check', 'session-ok', '--json'], path.join(scratch, 'health', 'data'))
    assert.equal(ok.code, 0); assert.equal(ok.json.data.state, 'healthy')
    const held = await exec(['session', 'check', 'session-held', '--json'], path.join(scratch, 'health', 'data'))
    assert.equal(held.code, 7); assert.equal(held.json.data.reason, 'session-history-notice-before-head')
    const missing = await exec(['session', 'check', 'session-missing', '--json'], path.join(scratch, 'health', 'data'))
    assert.equal(missing.code, 4); assert.equal(missing.json.error.code, 'NOT_FOUND')
    await hs.close(); await hc.dispose()
  }
  pass('session check: healthy exit 0, typed hold exit 7, unknown session NOT_FOUND; read-only')

  await server.close()
  await core.dispose()
  console.log(`NexusCli: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error('FAIL: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
