'use strict'

/**
 * P1: the host Controller's single legacy PowerShell runner
 * (config/nexus/legacy-cli.cjs), exercised with real child processes through a
 * synthetic PowerShell host (tests/lib/FakePwshHost.cjs). No PowerShell, no
 * network, no model.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFakePwshHost } = require('./lib/FakePwshHost.cjs')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-legacy-cli-'))
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
delete process.env.AIH_TOOLCHAIN_ROOT
const legacyCli = require('../config/nexus/legacy-cli.cjs')
// A synthetic, credential-shaped value assembled at runtime: the installed
// source credential scan (Harness) must never see a literal token in source.
const SYNTHETIC_SECRET = 'sk-' + 'abcdefghijklmnopqrstuvwx'
const installRoot = path.join(scratch, 'install')
const dataRoot = path.join(scratch, 'data')
fs.mkdirSync(installRoot, { recursive: true })
let passed = 0
function pass(name) { passed += 1; console.log('PASS: ' + name) }
const payloadFiles = () => { try { return fs.readdirSync(path.join(dataRoot, 'tmp')).filter((name) => name.startsWith('aih-payload-')) } catch { return [] } }

async function main() {
  const cli = legacyCli.createLegacyCli({ installRoot, dataRoot, ownerRoot: scratch })
  if (process.platform === 'win32') {
    // Product contract (scripts/Platform.ps1 Get-AihPowerShellHost): Windows
    // keeps Windows PowerShell; AIH_PWSH_HOST is a POSIX-only override, so the
    // synthetic host cannot be installed here.
    const { resolveAihPowerShellHost } = require('./lib/AihTestTransport.cjs')
    assert.equal(cli.pwshHost, resolveAihPowerShellHost(installRoot), 'Windows keeps Windows PowerShell and ignores the POSIX-only AIH_PWSH_HOST override')
    assert.equal(cli.timeoutMs, legacyCli.CLI_TIMEOUT_MS)
    assert.equal(legacyCli.CLI_TIMEOUT_MS, 320000, 'pre-P1 timeout preserved')
    pass('win32: the legacy runner uses Windows PowerShell (AIH_PWSH_HOST is POSIX-only) with the pre-P1 timeout')
    console.log('INFO: win32 synthetic-PowerShell runner groups (payload files, failure redaction, timeouts, profile scoping, accounting) require the POSIX-only AIH_PWSH_HOST injection and run on Linux and macOS only')
    console.log(`NexusLegacyCli: ${passed} assertion groups passed.`)
    fs.rmSync(scratch, { recursive: true, force: true })
    return
  }
  assert.equal(cli.pwshHost, fake.host, 'AIH_PWSH_HOST override honoured on POSIX')
  assert.equal(cli.timeoutMs, legacyCli.CLI_TIMEOUT_MS)
  assert.equal(legacyCli.CLI_TIMEOUT_MS, 320000, 'pre-P1 timeout preserved')

  // Success, argv shape, payload file, unicode payload, cleanup.
  fake.reset()
  fake.respond({ 'Task.ps1:create-task': { json: { taskId: 'TASK-0007', note: 'ünïcødé ✓' } } })
  const created = await cli.invoke('Task.ps1', ['-Action', 'create-task'], { payload: { description: 'Fix ✓ «quotes» "and" $(shell) `ticks`' } })
  assert.deepEqual(created, { taskId: 'TASK-0007', note: 'ünïcødé ✓' })
  const [call] = fake.invocations()
  assert.equal(call.script, 'Task.ps1')
  assert.deepEqual(call.args, ['-Action', 'create-task'])
  assert.equal(call.payload.description, 'Fix ✓ «quotes» "and" $(shell) `ticks`', 'user text travels only in the UTF-8 payload file')
  assert.equal(call.toolchain, installRoot, 'AIH_TOOLCHAIN_ROOT exported to the child (fallback: logical root)')
  assert.deepEqual(payloadFiles(), [], 'payload file removed after success')
  pass('invoke: fixed argv, UTF-8 payload file with hostile text, toolchain env, payload cleanup')

  // Empty stdout returns null; control characters inside strings are recovered.
  fake.respond({ 'Task.ps1': { stdout: '' } })
  assert.equal(await cli.invoke('Task.ps1', ['-Action', 'noop']), null)
  fake.respond({ 'Task.ps1': { stdout: '{"text":"a\u001ab"}' } })
  assert.equal((await cli.invoke('Task.ps1', ['-Action', 'raw'])).text, 'a\u001ab')
  pass('empty stdout is null; raw control characters in JSON strings are recovered')

  // Structured failure (exit 3 + JSON) is a result, not an exception.
  fake.respond({ 'Review.ps1': { stdout: '{"kind":"packet-too-large","limit":8}', exit: 3 } })
  assert.deepEqual(await cli.invoke('Review.ps1', ['-TaskId', 'TASK-0007']), { kind: 'packet-too-large', limit: 8 })
  pass('exit 3 with structured JSON is returned to the caller')

  // Verification JSON with a non-zero exit only when the caller opts in.
  fake.respond({ 'Verify-Project.ps1': { stdout: '{"Results":[{"Name":"test","Status":"FAIL"}]}', exit: 1 } })
  const verification = await cli.invoke('Verify-Project.ps1', ['-Kind', 'all'], { tolerateNonZeroJson: true })
  assert.equal(verification.Results[0].Status, 'FAIL')
  await assert.rejects(cli.invoke('Verify-Project.ps1', ['-Kind', 'all']), (error) => error.code === 'aih-controller-cli-failed' && error.cliFailure.exitCode === 1)
  pass('failed verification JSON is a valid result only for tolerateNonZeroJson callers')

  // Partial / garbage output, non-zero exit with secrets in stderr.
  fake.respond({ 'Route.ps1': { stdout: '{"executionClass": "engi', exit: 0 } })
  await assert.rejects(cli.invoke('Route.ps1', ['-Preset', 'aih-muse']), /Route\.ps1 returned non-JSON output: \{"executionClass": "engi/)
  fake.respond({ 'Route.ps1': { stdout: 'partial', stderr: 'MODEL_API_KEY=' + SYNTHETIC_SECRET + ' failure', exit: 9 } })
  await assert.rejects(cli.invoke('Route.ps1', ['-Preset', 'aih-muse'], { payload: { secret: 'payload-secret' } }), (error) => {
    assert.equal(error.code, 'aih-controller-cli-failed')
    assert.equal(error.cliFailure.exitCode, 9)
    assert.ok(!JSON.stringify(error.cliFailure).includes(SYNTHETIC_SECRET), 'secrets redacted')
    assert.ok(!JSON.stringify(error.cliFailure).includes('payload-secret'), 'payload never enters diagnostics')
    assert.ok(!error.cliFailure.args.some((arg) => arg.includes('aih-payload-')), 'payload path is not part of diagnostic args')
    return true
  })
  assert.deepEqual(payloadFiles(), [], 'payload file removed after failure')
  pass('truncated JSON and non-zero exits fail typed with redacted, payload-free diagnostics')

  // Timeout: the child is killed, typed failure, payload cleaned, counters updated.
  const quick = legacyCli.createLegacyCli({ installRoot, dataRoot, timeoutMs: 400 })
  fake.respond({ 'Engineering.ps1': { hang: true } })
  const started = Date.now()
  await assert.rejects(quick.invoke('Engineering.ps1', ['-Action', 'epistemic-step'], { payload: { q: 1 } }), (error) => error.code === 'aih-controller-cli-failed' && error.cliFailure.killed === true)
  assert.ok(Date.now() - started < 5000, 'timeout is bounded')
  assert.equal(quick.stats().timeouts, 1)
  assert.equal(quick.stats().inFlight, 0)
  assert.deepEqual(payloadFiles(), [], 'payload file removed after timeout')
  pass('a hung CLI is killed at the timeout and reported as a typed failure')

  // Child-only environment overlay (DSH_AIH_PROFILE) never leaks to later calls or the parent.
  fake.reset()
  fake.respond({ '*': { json: {} } })
  await cli.invoke('Route.ps1', ['-Preset', 'aih-muse'], { envOverlay: { DSH_AIH_PROFILE: 'muse-spark-1.3-contributor' } })
  await cli.invoke('Route.ps1', ['-Preset', 'aih-muse'])
  const [scoped, plain] = fake.invocations()
  assert.equal(scoped.envProfile, 'muse-spark-1.3-contributor')
  assert.equal(plain.envProfile, null)
  assert.equal(process.env.DSH_AIH_PROFILE, undefined)
  pass('the selected-profile environment is scoped to exactly one child')

  // Concurrency accounting.
  fake.respond({ '*': { json: {}, sleepMs: 120 } })
  await Promise.all([1, 2, 3].map(() => cli.invoke('Task.ps1', ['-Action', 'test-task'])))
  const stats = cli.stats()
  assert.ok(stats.maxInFlight >= 2)
  assert.equal(stats.inFlight, 0)
  assert.ok(stats.invocations >= 12)
  assert.ok(stats.byScript['Task.ps1'] >= 5)
  pass('runner accounting reports invocations, failures, timeouts and concurrency')

  console.log(`NexusLegacyCli: ${passed} assertion groups passed.`)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => {
  console.error('FAIL: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
