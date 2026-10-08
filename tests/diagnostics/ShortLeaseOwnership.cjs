'use strict'

// Manual regression against an explicit, unchanged CCv2 checkout. This is not
// a dependency of the dev-only harness. Preserve its failed ownership assertion.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { execFileSync } = require('node:child_process')

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node ShortLeaseOwnership.cjs <CCv2 checkout> <evidence.json>')
}
const root = path.resolve(process.argv[2])
const evidencePath = path.resolve(process.argv[3])
const pwsh = process.env.AIH_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh')
const area = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-post-renew-'))
const observations = []
function record(name, data) {
  const row = { name, at: new Date().toISOString(), ...data }
  observations.push(row)
  console.log(JSON.stringify(row))
}

async function main() {
  const payload = path.join(area, 'payload.json')
  fs.writeFileSync(payload, JSON.stringify({ workspace: area, description: 'post-renew scheduling probe', reviewRequested: false, engine: 'dual' }))
  const task = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-File', path.join(root, 'scripts/Task.ps1'), '-Action', 'create-task', '-PayloadFile', payload], { encoding: 'utf8', timeout: 60000 }))

  // Load the accepted A10 fixture builders in memory with this temporary task's
  // IDs. No file or production authority is edited, patched or replaced.
  const fixtureFile = path.join(root, 'tests/ContextActiveApplyV2.Tests.cjs')
  const source = fs.readFileSync(fixtureFile, 'utf8')
  const mainOffset = source.indexOf('async function main() {')
  assert(mainOffset > 0, 'Expected the frozen A10 unit fixture builders')
  const prefix = source.slice(0, mainOffset)
    .replaceAll("'TASK-A10'", JSON.stringify(task.taskId))
    .replaceAll("'task_a10_0001'", JSON.stringify(task.taskInstanceId))
  const fixtureModule = new Module(fixtureFile)
  fixtureModule.filename = fixtureFile
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
  fixtureModule._compile(prefix + '\nmodule.exports = { buildHappy, applyInputFor };', fixtureFile)
  const { buildHappy, applyInputFor } = fixtureModule.exports
  const active = require(path.join(root, 'config/ContextActiveApplyV2.cjs'))
  const { createCliApplyLockClient } = require(path.join(root, 'config/ContextActiveApplyLockClientV2.cjs'))
  const client = createCliApplyLockClient({ installRoot: root, workspace: area, pwshPath: pwsh, leaseSeconds: 4 })
  const lockPath = path.join(area, '.ai-harness', 'runs', task.taskId, 'context-compaction-apply.lock')
  const readLock = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  let taker = null
  const schedulingSeam = {
    acquire: call => client.acquire(call),
    release: call => client.release(call),
    async renew(call) {
      const result = await client.renew(call)
      assert.equal(result.renewed, true)
      record('renew-authority-succeeded', { result, lock: readLock() })
      // Model suspension after the authority replied. Await its actual expiry,
      // not a guessed delay; never alter lease bytes or the successful result.
      const expiresAt = Date.parse(result.expiresAtUtc)
      assert(Number.isFinite(expiresAt), 'Authority returned a real expiry')
      while (Date.now() <= expiresAt + 100) await new Promise(resolve => setTimeout(resolve, 50))
      taker = await client.acquire({ ...call, leaseSeconds: 60 })
      assert.equal(taker.acquired, true)
      record('other-owner-took-over-before-caller-resumed', { result: taker })
      return result
    },
  }
  const fx = buildHappy('single')
  const input = applyInputFor(fx, {
    serialization: schedulingSeam, lockLeaseSeconds: 4,
    checkpointDir: path.join(area, 'checkpoint'), operationDir: path.join(area, 'operation'),
  })
  const before = input.session.events.length
  const result = await active.applyActiveCompactionV2(input)
  const current = readLock()
  record('post-renew-resume-result', {
    status: result.status, mutated: result.mutated, eventCountBefore: before,
    eventCountAfter: input.session.events.length, lockOwnerIsTaker: current.ownerId === taker.ownerId,
    blockerCodes: result.blockerCodes,
  })
  record('verdict', {
    demonstratedStaleOwnerMutation: result.mutated === true && current.ownerId === taker.ownerId,
    concurrentCorruptionTested: false,
  })
  await client.release({ taskId: task.taskId, ownerId: taker.ownerId })
  assert.equal(result.mutated, false, 'An owner that lost its lease before resuming must not mutate the session')
}
main().catch(error => {
  record('diagnostic-error', { error: error.stack })
  process.exitCode = 1
}).finally(() => {
  try { fs.writeFileSync(evidencePath, JSON.stringify(observations, null, 2) + '\n') }
  finally { fs.rmSync(area, { recursive: true, force: true }) }
})
