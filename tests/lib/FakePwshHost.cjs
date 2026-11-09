'use strict'

/**
 * Synthetic PowerShell host for Controller tests (no PowerShell, no network,
 * no model). Installed through AIH_PWSH_HOST, which the legacy runner honours
 * on POSIX. Every invocation appends one JSON line to FAKE_PWSH_LOG:
 *   { script, action, args, payload, start, end, pid }
 * and answers from the FAKE_PWSH_RESPONSES map keyed by "<Script>:<Action>"
 * (fallback "<Script>", then "*"). A response may be:
 *   { json: <value> }                      stdout = JSON, exit 0
 *   { stdout: "<raw>", exit: <n> }          raw stdout and exit code
 *   { sleepMs: <n>, ... }                   delay before answering
 *   { hang: true }                          never answers (timeout tests)
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = `#!${process.execPath}
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
const fileIndex = argv.indexOf('-File')
const script = fileIndex >= 0 ? path.basename(argv[fileIndex + 1] || '') : ''
const rest = fileIndex >= 0 ? argv.slice(fileIndex + 2) : argv
const actionIndex = rest.indexOf('-Action')
const action = actionIndex >= 0 ? rest[actionIndex + 1] : ''
const payloadIndex = rest.indexOf('-PayloadFile')
let payload = null
if (payloadIndex >= 0) { try { payload = JSON.parse(fs.readFileSync(rest[payloadIndex + 1], 'utf8')) } catch { payload = 'unreadable' } }
let responses = {}
try { responses = JSON.parse(fs.readFileSync(process.env.FAKE_PWSH_RESPONSES, 'utf8')) } catch {}
const response = responses[script + ':' + action] || responses[script] || responses['*'] || { json: {} }
const start = Date.now()
const finish = () => {
  const record = { script, action, args: rest.filter((_, i) => i !== payloadIndex && i !== payloadIndex + 1), payload, start, end: Date.now(), pid: process.pid,
    envProfile: process.env.DSH_AIH_PROFILE || null, toolchain: process.env.AIH_TOOLCHAIN_ROOT || null }
  if (process.env.FAKE_PWSH_LOG) fs.appendFileSync(process.env.FAKE_PWSH_LOG, JSON.stringify(record) + '\\n')
  if (response.stderr) process.stderr.write(response.stderr)
  if (response.json !== undefined) process.stdout.write(JSON.stringify(response.json))
  else if (response.stdout !== undefined) process.stdout.write(response.stdout)
  process.exit(response.exit || 0)
}
if (response.hang) setInterval(() => {}, 1000)
else if (response.sleepMs) setTimeout(finish, response.sleepMs)
else finish()
`

function createFakePwshHost(root) {
  const dir = root || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fake-pwsh-'))
  fs.mkdirSync(dir, { recursive: true })
  const host = path.join(dir, 'fake-pwsh')
  fs.writeFileSync(host, SCRIPT, { mode: 0o755 })
  const logPath = path.join(dir, 'invocations.jsonl')
  const responsesPath = path.join(dir, 'responses.json')
  fs.writeFileSync(responsesPath, '{}')
  return {
    dir,
    host,
    logPath,
    responsesPath,
    install(env = process.env) {
      env.AIH_PWSH_HOST = host
      env.FAKE_PWSH_LOG = logPath
      env.FAKE_PWSH_RESPONSES = responsesPath
    },
    respond(map) { fs.writeFileSync(responsesPath, JSON.stringify(map)) },
    reset() { try { fs.rmSync(logPath, { force: true }) } catch {} },
    invocations() {
      try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
    },
  }
}

module.exports = { createFakePwshHost }
