'use strict'

/**
 * P1 diagnostic: measured overhead of the host Controller boundary.
 *
 *   node tests/diagnostics/NexusControllerOverhead.cjs [<baseline AihController.cjs>] [evidence.json]
 *
 * Synthetic transport only (tests/lib/FakePwshHost.cjs): no PowerShell, no
 * network, no model. Reports:
 *   1. core micro-costs (host service resolution, strategy dispatch, an empty
 *      serialized transition, event claim) over 20,000 warm iterations;
 *   2. warm root-turn admission through the real agent/pre-step hook for the
 *      new bridge and, when given, the pre-P1 bridge (same fake CLI latency),
 *      with the controller-CLI subprocess count per turn;
 *   3. host core construction time and retained heap.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { createFakePwshHost } = require('../lib/FakePwshHost.cjs')

const sourceRoot = path.join(__dirname, '..', '..')
const baselinePath = process.argv[2] && process.argv[2] !== '-' ? path.resolve(process.argv[2]) : null
const evidencePath = process.argv[3] || null
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-overhead-'))
const fake = createFakePwshHost(path.join(scratch, 'pwsh'))
fake.install()
process.env.AIH_INSTALL_ROOT = sourceRoot
delete process.env.AIH_TOOLCHAIN_ROOT

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { n: sorted.length, p50: +at(0.5).toFixed(4), p95: +at(0.95).toFixed(4), max: +sorted[sorted.length - 1].toFixed(4), mean: +(sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(4) }
}

async function microCosts() {
  const controllerModule = require('../../config/nexus/controller.cjs')
  const dataRoot = path.join(scratch, 'micro')
  fs.mkdirSync(dataRoot, { recursive: true })
  if (global.gc) global.gc()
  const heapBefore = process.memoryUsage().heapUsed
  const t0 = performance.now()
  const core = controllerModule.createControllerCore({ installRoot: sourceRoot, dataRoot })
  const constructMs = performance.now() - t0
  if (global.gc) global.gc()
  const heapAfter = process.memoryUsage().heapUsed
  const ctx = { get: (name) => (name === 'nexusController' ? core : undefined) }
  const access = controllerModule.resolveControllerAccess(ctx)
  const N = 20000
  const resolve = []; const decide = []; const transition = []; const claim = []
  for (let i = 0; i < N; i += 1) {
    let s = performance.now(); access.get(); resolve.push(performance.now() - s)
    s = performance.now(); core.decide(i % 2 ? 'muse' : 'dual', { sessionId: 's' }, { type: 'engineering-turn' }); decide.push(performance.now() - s)
    s = performance.now(); await core.transition('task_' + (i % 8), 'noop', () => null); transition.push(performance.now() - s)
    s = performance.now(); core.claimEvent('s' + (i % 16), { seq: i, type: 'turn/end' }); claim.push(performance.now() - s)
  }
  await core.dispose()
  return { constructMs: +constructMs.toFixed(3), retainedHeapKiB: Math.round((heapAfter - heapBefore) / 1024), gcExposed: Boolean(global.gc), resolveMs: stats(resolve), decideMs: stats(decide), emptyTransitionMs: stats(transition), claimEventMs: stats(claim) }
}

function seed(dataRoot, workspace, sessionId, engine) {
  const binding = {
    sessionId, taskInstanceId: 'task_' + crypto.randomBytes(16).toString('hex'), taskId: 'TASK-0001', workspace,
    workspaceId: 'ws-1', repositoryId: 'repo-1', checkoutId: 'co-1', checkoutRootPath: workspace, executionRoot: workspace,
    preset: engine === 'muse' ? 'aih-muse' : 'aih-engineering', engine, description: 'synthetic',
    executionClass: engine === 'muse' ? 'muse_main' : 'engineer_normal', reviewRequired: false, needsRouteCheck: false, boundAtUtc: new Date(0).toISOString(),
  }
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: { [sessionId]: binding } }))
  return binding
}

async function admission(label, bridgePath, engine, iterations) {
  const bridge = require(bridgePath)
  const samples = []
  const cliPerTurn = []
  for (let i = 0; i < iterations; i += 1) {
    const dataRoot = path.join(scratch, label + '-' + engine + '-' + i, 'data')
    const workspace = path.join(scratch, label + '-' + engine + '-' + i, 'ws')
    fs.mkdirSync(dataRoot, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
    process.env.DSH_HOME = dataRoot
    const sessionId = 'session-' + i
    const binding = seed(dataRoot, workspace, sessionId, engine)
    fake.respond({
      'NexusWorkspace.ps1:resolve': { json: { workspaceId: 'ws-1', repositoryId: 'repo-1', checkoutId: 'co-1', executionRoot: workspace, checkoutRootPath: workspace } },
      'Task.ps1:test-task': { json: { exists: true, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, instanceMatches: true, boundEngine: engine } },
      'Task.ps1:begin-attempt': { json: { taskId: binding.taskId, sequence: 1, status: 'started' } },
      '*': { json: {} },
    })
    const handlers = {}
    bridge.apply({ on(event, handler) { (handlers[event] = handlers[event] || []).push(handler) }, shellEnv: { list() { return [] }, register() {} } })
    const session = { id: sessionId, header: { version: 4, cwd: workspace, agentPreset: binding.preset }, events: [], append() {} }
    fake.reset()
    const start = performance.now()
    await handlers['agent/pre-step'][0]({ agent: { session }, step: 1, turn: 1, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement the change.' }] }] }, async () => ({ kind: 'continue' }))
    const elapsed = performance.now() - start
    if (i > 0) samples.push(elapsed) // first iteration warms module caches
    cliPerTurn.push(fake.invocations().length)
  }
  return { label, engine, wallMs: stats(samples), controllerCliPerTurn: [...new Set(cliPerTurn)] }
}

async function main() {
  const evidence = { node: process.version, platform: process.platform + '-' + process.arch, cpus: os.cpus().length, startedAt: new Date().toISOString() }
  evidence.micro = await microCosts()
  const iterations = Number(process.env.NEXUS_OVERHEAD_ITERATIONS || 21)
  evidence.admission = []
  // Interleave old and new per engine to share machine conditions.
  for (const engine of ['muse', 'dual']) {
    if (baselinePath) evidence.admission.push(await admission('pre-p1', baselinePath, engine, iterations))
    evidence.admission.push(await admission('p1', path.join(sourceRoot, 'config', 'AihController.cjs'), engine, iterations))
  }
  if (baselinePath) {
    evidence.deltas = ['muse', 'dual'].map((engine) => {
      const old = evidence.admission.find((row) => row.label === 'pre-p1' && row.engine === engine)
      const neu = evidence.admission.find((row) => row.label === 'p1' && row.engine === engine)
      return { engine, p50DeltaMs: +(neu.wallMs.p50 - old.wallMs.p50).toFixed(3), p95DeltaMs: +(neu.wallMs.p95 - old.wallMs.p95).toFixed(3), p95DeltaPct: +(100 * (neu.wallMs.p95 - old.wallMs.p95) / old.wallMs.p95).toFixed(2), cliPerTurnOld: old.controllerCliPerTurn, cliPerTurnNew: neu.controllerCliPerTurn }
    })
  }
  const text = JSON.stringify(evidence, null, 2)
  if (evidencePath) fs.writeFileSync(evidencePath, text + '\n')
  console.log(text)
  fs.rmSync(scratch, { recursive: true, force: true })
}

main().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1) })
