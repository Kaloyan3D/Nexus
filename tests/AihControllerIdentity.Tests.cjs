'use strict'

/**
 * TASK-0005: controller identity hardening - Node-plane regression suite.
 *
 * Covers:
 *   Part 7/8/10/12/13  session binding validation, stale recovery, session-
 *                      scoped recovery lock, validation-inconclusive fail-safe
 *   Part 9/22E/F       workspace identity normalization + mismatch tests
 *   Part 11            explicit /review recovery keeps the reviewer path
 *   Part 14/15/20      instance-aware routing joins + legacy compatibility
 *   Part 16/17         instance-guarded routing + generation-aware live
 *                      execution-class lookup
 *   Part 18/24         Control Room identity joins + impossible-tuple guard
 *   Part 21            legacy binding upgrade safety
 *   Part 22 A-J        the full binding-matrix regression set
 *   Part 23 + DoD      the full generation-collision scenario through the
 *                      REAL bridge (AihController.apply) and TaskController.
 *
 * The unit sections are pure Node with injected dependencies (fast,
 * deterministic). The end-to-end section runs the real PowerShell
 * TaskController against isolated fixtures and never calls a model: the
 * review probe enables the LEGACY hard budgets in the fixture's copied
 * routing policy (enforceLimits=true) and uses the packet-too-large
 * rejection, which is enforced BEFORE any reviewer transport. Under the
 * shipped default (enforceLimits=false) the same turn would proceed to the
 * review transport gate instead.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const controller = require('../config/AihController.cjs')
const status = require('../ui/nexus-controller/lib/status.cjs')
const detail = require('../ui/nexus-controller/lib/detail.cjs')
const profiles = require('../config/Engineering-Profiles.cjs')

function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

// -- fixture harness for the binding guard (Parts 8/10/12/13) ---------------
function makeHarness(initialBindings) {
  const ledger = new Map() // display id -> authoritative taskInstanceId
  const bindings = Object.assign({}, initialBindings)
  const calls = { createBinding: [], testTaskIdentity: 0, invalidate: 0, staleEvents: [] }
  let created = 100 // fresh instances must never collide with fixture instances
  const guard = controller.createBindingGuard({
    bindingFor: (session) => (bindings[session.id] ? bindings[session.id] : null),
    createBinding: async (agent, session, workspace, promptText) => {
      calls.createBinding.push({ promptText, workspace })
      created += 1
      const reviewRequested = controller.isReviewCommand(promptText)
      const displayId = 'TASK-0004' // deliberately constant: identity != label
      const instance = 'task_' + String(created).padStart(32, '0')
      ledger.set(displayId, instance)
      const binding = {
        sessionId: session.id,
        taskInstanceId: instance,
        taskId: displayId,
        workspace,
        preset: 'aih-engineering',
        description: promptText,
        executionClass: reviewRequested ? 'reviewer' : 'engineer_normal',
        reviewRequired: reviewRequested,
        boundAtUtc: new Date().toISOString(),
      }
      bindings[session.id] = binding
      return binding
    },
    testTaskIdentity: async (workspace, taskId, taskInstanceId) => {
      calls.testTaskIdentity += 1
      if (workspace === 'infra-failure') {
        throw new Error('Task ledger is invalid: ' + workspace)
      }
      const actual = ledger.has(taskId) ? ledger.get(taskId) : null
      return {
        exists: actual !== null,
        taskId,
        taskInstanceId: actual,
        instanceMatches: taskInstanceId ? actual === taskInstanceId : null,
      }
    },
    log: (entry) => {
      if (entry && entry.event === 'stale-binding-detected') calls.staleEvents.push(entry)
    },
    invalidateBinding: (stale) => {
      calls.invalidate += 1
      delete bindings[stale.sessionId]
    },
  })
  return { guard, bindings, calls, ledger }
}

const instance = (n) => 'task_' + String(n).padStart(32, '0')

async function unitBindingGuard() {
  const session = { id: 's1' }

  // A. Valid binding: exact instance exists -> reuse, no new task.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\WS' } })
    h.ledger.set('TASK-0004', instance(1))
    const result = await h.guard.ensureBinding(null, session, 'C:\\WS', 'continue the work')
    assert.equal(result.outcome, 'valid')
    assert.equal(h.calls.createBinding.length, 0, 'valid binding never creates a new task')
  }

  // B. Missing task: stale -> fresh task, fresh instance, binding replaced.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\WS' } })
    const result = await h.guard.ensureBinding(null, session, 'C:\\WS', 'continue the work')
    assert.equal(result.outcome, 'recovered')
    assert.equal(result.stale.reason, 'task-missing')
    assert.equal(h.calls.createBinding.length, 1, 'exactly one replacement task')
    assert.equal(h.calls.staleEvents.length, 1)
    const event = h.calls.staleEvents[0]
    assert.equal(event.reason, 'task-missing')
    assert.equal(event.taskId, 'TASK-0004')
    assert.equal(event.oldTaskInstanceId, instance(1))
    assert.equal(event.currentWorkspace, 'C:\\WS')
    assert.notEqual(h.bindings.s1.taskInstanceId, instance(1), 'fresh instance is not the old one')
    assert.equal(h.calls.invalidate, 1, 'stale binding removed and persisted')
  }

  // C. Same display id, different generation: NEVER valid.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\WS' } })
    h.ledger.set('TASK-0004', instance(2))
    const result = await h.guard.ensureBinding(null, session, 'C:\\WS', 'continue the work')
    assert.equal(result.outcome, 'recovered')
    assert.equal(result.stale.reason, 'instance-mismatch')
  }

  // D. Explicit /review recovery reuses the normal explicit-review flow.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\WS' } })
    const result = await h.guard.ensureBinding(null, session, 'C:\\WS', '/review inspect Phase 3.2')
    assert.equal(result.outcome, 'recovered')
    assert.equal(h.calls.createBinding[0].promptText, '/review inspect Phase 3.2', 'the review question drives the fresh task')
    assert.equal(h.bindings.s1.executionClass, 'reviewer', 'the fresh task routes as reviewer (zero engineer calls)')
    assert.equal(h.bindings.s1.reviewRequired, true)
  }

  // E. Workspace mismatch: fail closed even when the other workspace has the task.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\RepoA' } })
    h.ledger.set('TASK-0004', instance(1)) // RepoB even contains the same task
    await assert.rejects(
      () => h.guard.ensureBinding(null, session, 'C:\\RepoB', 'continue the work'),
      (error) => error.code === 'session-workspace-mismatch'
    )
    assert.equal(h.calls.testTaskIdentity, 0, 'workspace mismatch never consults the other workspace ledger')
    assert.equal(h.calls.createBinding.length, 0, 'workspace mismatch never silently rebinds the session')
    assert.equal(h.calls.invalidate, 0, 'workspace mismatch preserves the original binding')
  }

  // F. Equivalent Windows paths validate as the same workspace.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'c:\\ai-harness\\' } })
    h.ledger.set('TASK-0004', instance(1))
    const result = await h.guard.ensureBinding(null, session, 'C:\\AI-Harness', 'continue the work')
    assert.equal(result.outcome, 'valid', 'C:\\AI-Harness == c:\\ai-harness\\')
    assert.equal(h.calls.createBinding.length, 0)
  }

  // G. Invalid ledger: validation infrastructure failure -> fail safe.
  {
    const binding = { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'infra-failure' }
    const h = makeHarness({ s1: binding })
    await assert.rejects(
      () => h.guard.ensureBinding(null, session, 'infra-failure', 'continue the work'),
      (error) => error.code === 'binding-validation-inconclusive'
    )
    assert.equal(h.calls.invalidate, 0, 'binding preserved on infrastructure failure')
    assert.equal(h.calls.createBinding.length, 0, 'no replacement task on infrastructure failure')
    assert.equal(h.bindings.s1, binding, 'the original binding object is untouched')
  }

  // H. Restart + valid binding: no duplicate task.
  // I. Restart + stale binding: self-heals exactly once.
  {
    const persisted = { s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\WS' } }
    const h = makeHarness(persisted) // a fresh plugin instance loads the persisted binding
    h.ledger.set('TASK-0004', instance(1))
    const valid = await h.guard.ensureBinding(null, session, 'C:\\WS', 'turn after restart')
    assert.equal(valid.outcome, 'valid')
    assert.equal(h.calls.createBinding.length, 0, 'restart with a valid binding creates no duplicate task')
    // now the workspace generation changes under the binding (restore scenario)
    h.ledger.delete('TASK-0004')
    const stale = await h.guard.ensureBinding(null, session, 'C:\\WS', 'turn after restore')
    assert.equal(stale.outcome, 'recovered')
    assert.equal(h.calls.createBinding.length, 1)
    const again = await h.guard.ensureBinding(null, session, 'C:\\WS', 'next turn')
    assert.equal(again.outcome, 'valid')
    assert.equal(h.calls.createBinding.length, 1, 'recovery happens exactly once')
  }

  // J. Concurrent stale recovery: exactly one replacement task.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', taskInstanceId: instance(1), workspace: 'C:\\WS' } })
    const results = await Promise.all([
      h.guard.ensureBinding(null, session, 'C:\\WS', 'event one'),
      h.guard.ensureBinding(null, session, 'C:\\WS', 'event two'),
    ])
    assert.equal(h.calls.createBinding.length, 1, 'one stale session + two simultaneous events = one replacement task')
    const outcomes = results.map((r) => r.outcome).sort()
    assert.deepEqual(outcomes, ['recovered', 'valid'])
  }

  // Part 21: legacy binding without taskInstanceId is stale/ambiguous.
  {
    const h = makeHarness({ s1: { sessionId: 's1', taskId: 'TASK-0004', workspace: 'C:\\WS' } })
    h.ledger.set('TASK-0004', instance(9)) // a NEW instance-aware generation exists
    const result = await h.guard.ensureBinding(null, session, 'C:\\WS', 'continue the work')
    assert.equal(result.outcome, 'recovered')
    assert.equal(result.stale.reason, 'ambiguous-legacy-binding')
    assert.notEqual(h.bindings.s1.taskInstanceId, instance(9), 'an ambiguous legacy binding never attaches to a new generation')
    assert.equal(h.calls.testTaskIdentity, 0, 'an unprovable generation is stale without consulting the ledger')
  }
}

function unitIdentityHelpers() {
  // Part 9: workspace identity normalization.
  assert.equal(controller.normalizeWorkspaceIdentity('C:\\AI-Harness'), controller.normalizeWorkspaceIdentity('c:\\ai-harness\\'))
  assert.equal(controller.normalizeWorkspaceIdentity('C:\\AI-Harness'), controller.normalizeWorkspaceIdentity('C:\\AI-Harness\\'))
  assert.notEqual(controller.normalizeWorkspaceIdentity('C:\\Repo'), controller.normalizeWorkspaceIdentity('C:\\Repo2'))
  assert.notEqual(controller.normalizeWorkspaceIdentity('C:\\Repo'), controller.normalizeWorkspaceIdentity('C:\\Repo\\sub'))
  assert.equal(controller.classifyBindingWorkspace({ workspace: 'c:\\ai-harness\\' }, 'C:\\AI-Harness'), null)
  assert.equal(controller.classifyBindingWorkspace({ workspace: 'C:\\Repo' }, 'C:\\Repo2'), 'workspace-mismatch')
  assert.equal(controller.classifyBindingWorkspace({ workspace: null }, 'C:\\Repo'), 'workspace-mismatch')
  const repositoryIdentity = { workspaceId: 'ws_1', repositoryId: 'repo_1', checkoutId: 'checkout_1', checkoutRootPath: 'C:\\Repo', executionRoot: 'C:\\Repo\\app' }
  assert.equal(controller.classifyBindingRepositoryIdentity({ ...repositoryIdentity }, repositoryIdentity), null)
  assert.equal(controller.classifyBindingRepositoryIdentity({ ...repositoryIdentity, checkoutId: 'checkout_2' }, repositoryIdentity), 'repository-identity-mismatch')
  assert.equal(controller.classifyBindingRepositoryIdentity({ workspace: 'C:\\Repo\\app' }, repositoryIdentity), null, 'legacy path-only binding may be upgraded in place')

  // Part 5 contract classification (mirror of the TaskController answer).
  assert.deepEqual(controller.classifyBindingIdentity({ taskInstanceId: instance(1) }, { exists: true, taskInstanceId: instance(1), instanceMatches: true }), { verdict: 'valid' })
  assert.deepEqual(controller.classifyBindingIdentity({ taskInstanceId: instance(1) }, { exists: false }), { verdict: 'stale', reason: 'task-missing' })
  assert.deepEqual(controller.classifyBindingIdentity({ taskInstanceId: instance(1) }, { exists: true, taskInstanceId: instance(2), instanceMatches: false }), { verdict: 'stale', reason: 'instance-mismatch' })
  assert.deepEqual(controller.classifyBindingIdentity({ taskId: 'TASK-0004' }, { exists: true, taskInstanceId: instance(2), instanceMatches: true }), { verdict: 'stale', reason: 'ambiguous-legacy-binding' })
  let threw = false
  try { controller.classifyBindingIdentity({ taskInstanceId: instance(1) }, null) } catch (error) { threw = error.code === 'binding-validation-inconclusive' }
  assert.equal(threw, true, 'an unusable identity answer is inconclusive, never stale')
}

function unitControlRoomJoins() {
  const records = [
    { taskId: 'TASK-0004', workspace: 'C:\\WS', taskInstanceId: instance(1), executionClass: 'reviewer', model: 'gpt-5.6-sol', provider: 'sol-local', timestampUtc: '2026-01-01T00:00:00.000Z' },
    { taskId: 'TASK-0004', workspace: 'C:\\WS', taskInstanceId: instance(2), executionClass: 'engineer_deep', model: 'glm-5.3', provider: 'glm-direct', timestampUtc: '2026-01-02T00:00:00.000Z' },
  ]
  // Part 15: instance joins.
  assert.equal(status.lastDecisionOf(records, 'TASK-0004', 'C:\\WS', instance(2)).model, 'glm-5.3')
  assert.equal(status.lastDecisionOf(records, 'TASK-0004', 'C:\\WS', instance(1)).model, 'gpt-5.6-sol')
  assert.equal(status.lastDecisionOf(records, 'TASK-0004', 'C:\\WS', instance(3)), null, 'unknown instance never joins')
  assert.equal(status.lastDecisionOf(records.filter((r) => r.taskInstanceId === instance(1)), 'TASK-0004', 'C:\\WS', instance(2)), null, 'NO fallback from an instance-aware task to another generation\'s records')
  // legacy compatibility (Part 20): the old workspace+taskId join still works.
  const legacyRecords = [{ taskId: 'TASK-0004', workspace: 'C:\\WS', executionClass: 'deepseek_normal', model: 'deepseek-v4-flash' }]
  assert.equal(status.lastDecisionOf(legacyRecords, 'TASK-0004', 'C:\\WS').executionClass, 'deepseek_normal')
  // workspace scoping unchanged.
  assert.equal(status.lastDecisionOf(records, 'TASK-0004', 'C:\\Other', instance(2)), null)

  // Part 14: routing state file identity.
  const legacyName = status.routingStateFileName('C:\\WS', 'aih-engineering', 'TASK-0004')
  const aName = status.routingStateFileName('C:\\WS', 'aih-engineering', 'TASK-0004', instance(1))
  const bName = status.routingStateFileName('C:\\WS', 'aih-engineering', 'TASK-0004', instance(2))
  assert.notEqual(aName, legacyName, 'instance-aware state file differs from the legacy key')
  assert.notEqual(aName, bName, 'two generations never share a state file')

  // Attempts + gates are lifecycle-scoped.
  const attempts = [
    { taskId: 'TASK-0004', taskInstanceId: instance(1), sequence: 1, status: 'passed' },
    { taskId: 'TASK-0004', taskInstanceId: instance(2), sequence: 1, status: 'started' },
  ]
  assert.equal(status.latestAttemptOfTask(attempts, 'TASK-0004', instance(2)).sequence, 1)
  assert.equal(status.latestAttemptOfTask(attempts, 'TASK-0004', instance(1)).status, 'passed')
  assert.equal(status.latestAttemptOfTask(attempts, 'TASK-0004', instance(3)), null)
  const gates = [
    { sessionId: 's1', workspace: 'C:\\WS', taskId: 'TASK-0004', taskInstanceId: instance(1), status: 'waiting', gateId: 'gate-old' },
    { sessionId: 's1', workspace: 'C:\\WS', taskId: 'TASK-0004', taskInstanceId: instance(2), status: 'waiting', gateId: 'gate-new' },
  ]
  assert.equal(status.currentGateOf(gates, 's1', 'C:\\WS', 'TASK-0004', instance(2)).gateId, 'gate-new')
  assert.equal(status.currentGateOf(gates, 's1', 'C:\\WS', 'TASK-0004', instance(1)).gateId, 'gate-old')
  assert.equal(status.currentGateOf(gates, 's1', 'C:\\WS', 'TASK-0004', instance(3)), null)
}

function unitImpossibleTuple() {
  // Part 24: a snapshot built from records of two different task generations
  // must fail closed instead of assembling a contradictory tuple.
  const binding = { taskInstanceId: instance(2), executionClass: 'engineer_deep', reviewRequired: false }
  const stateA = { taskInstanceId: instance(1), executionClass: 'engineer_deep', role: 'deepEngineer', model: 'glm-5.3' }
  const decisionA = { taskInstanceId: instance(1), executionClass: 'reviewer', role: 'reviewer', model: 'gpt-5.6-sol' }
  const execution = status.normalizeExecution(binding, null, stateA, decisionA, null)
  assert.equal(execution.identityInconsistent, true, 'cross-generation sources fail closed')
  assert.equal(execution.model, null, 'no model is presented from the wrong generation')
  assert.equal(execution.class, null, 'no execution class is presented from the wrong generation')
  // disagreeing modern records also fail closed.
  const stateB = { taskInstanceId: instance(2), executionClass: 'engineer_deep' }
  assert.equal(status.normalizeExecution(binding, null, stateB, decisionA, null).identityInconsistent, true)
  // a generation-blind (legacy) state file is never merged into an
  // instance-aware task either.
  assert.equal(status.normalizeExecution(binding, null, { executionClass: 'engineer_deep' }, null, null).identityInconsistent, true)
  // consistent same-generation sources keep the normal tuple.
  const decisionB = { taskInstanceId: instance(2), executionClass: 'engineer_deep', role: 'deepEngineer', model: 'glm-5.3', provider: 'glm-direct', reasoning: 'max' }
  const consistent = status.normalizeExecution(binding, null, stateB, decisionB, null)
  assert.equal(consistent.identityInconsistent, undefined)
  assert.equal(consistent.class, 'engineer_deep')
  assert.equal(consistent.modelId, 'glm-5.3')
  assert.equal(consistent.role, 'deepEngineer')
  // legacy tasks (no instance expectation) keep the historical behavior.
  const legacy = status.normalizeExecution({ executionClass: 'engineer_normal' }, null, { executionClass: 'engineer_normal' }, { model: 'deepseek-v4-flash' }, null)
  assert.equal(legacy.class, 'engineer_normal')
}

function unitEngineeringIsolation() {
  // Part 17: the live execution-class lookup is generation-aware and never
  // falls back to the legacy taskId-keyed state of another generation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-profiles-'))
  try {
    const statesDir = path.join(root, 'data', 'routing', 'states')
    fs.mkdirSync(statesDir, { recursive: true })
    const binding = { sessionId: 's1', workspace: root, preset: 'aih-engineering', taskId: 'TASK-0004', taskInstanceId: instance(2) }
    const legacyPath = profiles.routingStatePath(root, { workspace: root, preset: 'aih-engineering', taskId: 'TASK-0004' })
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, JSON.stringify({ taskId: 'TASK-0004', executionClass: 'reviewer' })) // decoy from generation A
    assert.equal(profiles.liveExecutionClassOf(root, binding), null, 'the legacy taskId-keyed state is NOT used for an instance-aware task')
    const instancePath = profiles.routingStatePath(root, binding)
    assert.notEqual(instancePath, legacyPath)
    fs.writeFileSync(instancePath, JSON.stringify({ taskId: 'TASK-0004', taskInstanceId: instance(2), executionClass: 'engineer_deep' }))
    assert.equal(profiles.liveExecutionClassOf(root, binding), 'engineer_deep', 'the generation-aware state file wins')
    // legacy bindings keep the compatibility path.
    const legacyBinding = { workspace: root, preset: 'aih-engineering', taskId: 'TASK-0004' }
    assert.equal(profiles.liveExecutionClassOf(root, legacyBinding), 'reviewer', 'legacy taskId-keyed behavior is preserved (Part 20)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function unitDetailJoins() {
  // Part 18: detail-level joins respect instance identity (routing history).
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-detail-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-detail-ws-'))
  try {
    fs.mkdirSync(path.join(dataRoot, 'routing', 'states'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.ai-harness', 'state'), { recursive: true })
    const binding = { sessionId: 's1', workspace, preset: 'aih-engineering', taskId: 'TASK-0004', taskInstanceId: instance(2), executionClass: 'engineer_deep' }
    fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: { s1: binding } }))
    fs.writeFileSync(path.join(dataRoot, 'aih-state.json'), JSON.stringify({ running: false }))
    fs.writeFileSync(path.join(workspace, '.ai-harness', 'state', 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ taskId: 'TASK-0004', taskInstanceId: instance(2), description: 'gen B', status: 'ready' }] }))
    const decisions = [
      { recordVersion: 4, taskId: 'TASK-0004', taskInstanceId: instance(1), workspace, executionClass: 'reviewer', model: 'gpt-5.6-sol', timestampUtc: '2026-01-01T00:00:00.000Z' },
      { recordVersion: 4, taskId: 'TASK-0004', taskInstanceId: instance(2), workspace, executionClass: 'engineer_deep', role: 'deepEngineer', model: 'glm-5.3', timestampUtc: '2026-01-02T00:00:00.000Z' },
    ]
    fs.writeFileSync(path.join(dataRoot, 'routing', 'decisions.jsonl'), decisions.map((d) => JSON.stringify(d)).join('\n') + '\n')
    const snapshot = await detail.buildDetailSnapshot({
      dataRoot,
      sessionId: 's1',
      binding,
      settingsPath: null,
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      gitSummary: null,
    })
    assert.equal(snapshot.execution.class, 'engineer_deep')
    assert.equal(snapshot.execution.modelId, 'glm-5.3', 'the snapshot tuple comes from generation B only')
    assert.equal(snapshot.execution.role, 'deepEngineer')
    assert.equal(snapshot.routingHistory.length, 1, 'generation A reviewer history is not merged into B')
    assert.equal(snapshot.routingHistory[0].modelId, 'glm-5.3')
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

// -- end-to-end: the full DoD scenario through the REAL bridge ---------------
async function runBridgeEndToEnd() {
  const { execFile } = require('node:child_process')
  const { spawnSync } = require('node:child_process')
  const { promisify } = require('node:util')
  const fs = require('node:fs')
  // Transport note (TASK-0017): sandboxed environments deny anonymous-pipe and
  // fd-redirected stdio capture from Node children (spawn EPERM), while
  // stdio:'inherit' spawns are allowed. This wrapper runs each CLI through
  // cmd.exe with cmd-side redirection into temporary files (no pipes anywhere)
  // and preserves the promisify(execFile) result and rejection shapes.
  let runSeq = 0
  const run = async (file, args, opts) => {
    const seq = ++runSeq
    const token = process.pid + '-' + seq
    const outPath = path.join(os.tmpdir(), 'aih-cli-out-' + token + '.txt')
    const errPath = path.join(os.tmpdir(), 'aih-cli-err-' + token + '.txt')
    const batchPath = path.join(os.tmpdir(), 'aih-cli-' + token + '.cmd')
    const q = (value) => '"' + String(value) + '"'
    const command = [q(file)].concat(args.map(q)).join(' ') + ' > ' + q(outPath) + ' 2> ' + q(errPath)
    fs.writeFileSync(batchPath, '@echo off\r\n' + command + '\r\n', 'utf8')
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', batchPath], Object.assign({}, opts, { stdio: 'ignore', windowsHide: true }))
    const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (_) { return '' } }
    const stdout = read(outPath)
    const stderr = read(errPath)
    try { fs.rmSync(outPath, { force: true }) } catch (_) { }
    try { fs.rmSync(errPath, { force: true }) } catch (_) { }
    try { fs.rmSync(batchPath, { force: true }) } catch (_) { }
    if (result.error) {
      result.error.stdout = stdout
      result.error.stderr = stderr
      throw result.error
    }
    if (result.status !== 0) {
      const failure = new Error('Command failed: ' + file)
      failure.code = result.status === null ? -1 : result.status
      failure.killed = result.signal != null
      failure.signal = result.signal
      failure.stdout = stdout
      failure.stderr = stderr
      throw failure
    }
    return { stdout, stderr }
  }
  const repoRoot = path.join(__dirname, '..')
  const homeName = '.aih-e2e-home-' + crypto.randomUUID().slice(0, 8)
  const installRoot = path.join(repoRoot, homeName)
  const dataHome = path.join(installRoot, 'data')
  fs.mkdirSync(dataHome, { recursive: true })
  // isolated install root: the bridge resolves scripts/config/data relative
  // to DSH_HOME, so the fixture can never touch production routing data.
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(installRoot, 'scripts'), { recursive: true })
  fs.cpSync(path.join(repoRoot, 'config'), path.join(installRoot, 'config'), { recursive: true })
  // TASK-0007: this end-to-end probe must stay deterministic and never reach
  // the reviewer transport, so the fixture's ISOLATED copy of the routing
  // policy opts back into the legacy hard budgets (enforceLimits=true). The
  // oversized packet then fails closed pre-transport exactly as before; the
  // shipped default (enforceLimits=false) is covered by the packet-build
  // regressions in AihController.Tests.cjs.
  {
    const fixturePolicyPath = path.join(installRoot, 'config', 'routing-policy.json')
    const fixturePolicy = JSON.parse(fs.readFileSync(fixturePolicyPath, 'utf8'))
    fixturePolicy.codex.automaticReview.enforceLimits = true
    fs.writeFileSync(fixturePolicyPath, JSON.stringify(fixturePolicy))
  }
  fs.mkdirSync(path.join(installRoot, 'ui', 'nexus-controller', 'lib'), { recursive: true })
  fs.cpSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'), path.join(installRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'))
  // GLM + Codex active profile (route through the copied settings).
  fs.writeFileSync(path.join(dataHome, 'settings.yaml'), 'engineering-profile: glm-codex\n')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-identity-e2e-'))
  fs.mkdirSync(path.join(fixture, 'src'))
  fs.writeFileSync(path.join(fixture, 'src', 'huge.js'), 'x'.repeat(140000))
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dataHome
  const bindingsPath = path.join(dataHome, 'routing', 'session-bindings.json')
  const ledgerPath = path.join(fixture, '.ai-harness', 'state', 'tasks.json')
  function boot() {
    const handlers = {}
    const ctx = { on: (event, fn) => { handlers[event] = fn }, shellEnv: { register() {} } }
    controller.apply(ctx)
    return handlers['agent/pre-step']
  }
  const readLedger = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  const readBinding = () => JSON.parse(fs.readFileSync(bindingsPath, 'utf8')).bindings['e2e-session-1']
  try {
    // 1. Create the task + bind the GUI session (real TaskController + routing).
    const preStep1 = boot()
    const session = {
      id: 'e2e-session-1',
      header: { cwd: fixture, agentPreset: 'aih-engineering' },
      messages: [],
      append(kind, message) { this.messages.push({ kind, message }) },
    }
    const agent = { session }
    const turn = (preStep, text) => preStep({ agent, messages: [userMessage(text)], step: 1, turn: 'x' }, () => 'next')
    await turn(preStep1, 'identity hardening turn one')
    const bindingA = readBinding()
    assert.match(bindingA.taskInstanceId, /^task_[0-9a-f]{32}$/, 'the binding carries an immutable instance identity')
    assert.equal(bindingA.taskId, 'TASK-0001')

    // 2. Codex reviewer routing records for generation A (routing only; no model).
    const payloadDir = path.join(dataHome, 'tmp')
    fs.mkdirSync(payloadDir, { recursive: true })
    const routePayload = path.join(payloadDir, 'route-a.json')
    fs.writeFileSync(routePayload, JSON.stringify({ workspace: fixture, description: 'review the hardening', reviewRequested: true, taskInstanceId: bindingA.taskInstanceId }))
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(installRoot, 'scripts', 'Route.ps1'), '-TaskId', bindingA.taskId, '-Preset', 'aih-engineering', '-ReviewRequested', '-InstallRoot', installRoot, '-PayloadFile', routePayload], { timeout: 320000, windowsHide: true })

    // 3-4. Stop Nexus (fresh plugin instance) + restore the workspace ledger to
    //      an older state where the task is gone and nextSequence regressed.
    //      Runtime routing history/state stays intact. Reuse the SAME session.
    const preStep2 = boot()
    fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, nextSequence: 1, tasks: [] }))
    fs.rmSync(path.join(fixture, '.ai-harness', 'runs'), { recursive: true, force: true })

    // 5-12. Stale binding detection + exactly one fresh task with instance B.
    await turn(preStep2, 'identity hardening turn two')
    const ledgerB = readLedger()
    assert.equal(ledgerB.tasks.length, 1, 'exactly one fresh task was created')
    const taskB = ledgerB.tasks[0]
    assert.equal(taskB.taskId, bindingA.taskId, 'the fixture reproduces the display-id collision')
    assert.notEqual(taskB.taskInstanceId, bindingA.taskInstanceId, 'B != A')
    const bindingB = readBinding()
    assert.equal(bindingB.taskInstanceId, taskB.taskInstanceId, 'the fresh binding references instance B')
    const runRootB = path.join(fixture, '.ai-harness', 'runs', taskB.taskId)
    const workingSetB = JSON.parse(fs.readFileSync(path.join(runRootB, 'working-set.json'), 'utf8'))
    const requirementsB = JSON.parse(fs.readFileSync(path.join(runRootB, 'requirements.json'), 'utf8'))
    const metricsB = JSON.parse(fs.readFileSync(path.join(runRootB, 'engineering-metrics.json'), 'utf8'))
    const epistemicStateB = JSON.parse(fs.readFileSync(path.join(runRootB, 'epistemic-state.json'), 'utf8'))
    const epistemicActionsB = fs.readFileSync(path.join(runRootB, 'epistemic-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const stepRoutingB = fs.readFileSync(path.join(runRootB, 'step-routing.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    for (const artifact of [workingSetB, requirementsB, metricsB, epistemicStateB, epistemicActionsB[epistemicActionsB.length - 1], stepRoutingB[stepRoutingB.length - 1]]) {
      assert.equal(artifact.taskInstanceId, taskB.taskInstanceId, 'production Engineering artifact is scoped to generation B')
    }
    assert.equal(workingSetB.objective, taskB.description, 'the real GUI binding initializes the Working Set objective')
    assert.equal(requirementsB.requirements.length, 1, 'the real GUI binding compiles the user request as a stable requirement')
    assert.equal(requirementsB.requirements[0].text, taskB.description, 'the Requirement Compiler preserves the original user wording')
    assert.equal(epistemicStateB.uncertainties.length, 1, 'the real GUI pre-step creates task-local uncertainty state')
    assert.equal(epistemicStateB.uncertainties[0].selectedAction, 'reason', 'the controller records the deterministic epistemic action before model work')
    assert.equal(epistemicActionsB.find((record) => record.event === 'action-routed').selectedRole, 'engineer_normal', 'Epistemic Policy composes with the real StepRouting role')
    assert.equal(workingSetB.epistemic.currentUncertaintyId, epistemicStateB.uncertainties[0].id, 'Working Set mirrors the production uncertainty identity')
    assert.equal(stepRoutingB[stepRoutingB.length - 1].selectedRole, 'engineer_normal', 'the real GUI pre-step records its current engineering role')
    assert.ok(!JSON.stringify([workingSetB, requirementsB, metricsB, epistemicStateB, epistemicActionsB, stepRoutingB]).includes(bindingA.taskInstanceId), 'generation B engineering state cannot consume generation A identity')
    const bridgeLog = fs.readFileSync(path.join(dataHome, 'logs', 'aih-controller.log'), 'utf8')
    const staleEvents = bridgeLog.split('\n').filter((l) => l.indexOf('"event":"stale-binding-detected"') !== -1).map((l) => JSON.parse(l))
    assert.equal(staleEvents.length, 1, 'the stale binding self-heals exactly once')
    assert.equal(staleEvents[0].reason, 'task-missing')
    assert.equal(staleEvents[0].oldTaskInstanceId, bindingA.taskInstanceId, 'the structured event carries the old instance')
    assert.equal(staleEvents[0].currentWorkspace, fixture)
    const activeProfile = profiles.resolveActiveProfile(installRoot, 'aih-engineering')
    assert.ok(activeProfile, 'the fixture resolves an active Engineering Profile')
    const normalTarget = profiles.resolveTarget(installRoot, activeProfile.id, 'primaryEngineer')
    const deepTarget = profiles.resolveTarget(installRoot, activeProfile.id, 'deepEngineer')
    const reviewerTarget = profiles.resolveTarget(installRoot, activeProfile.id, 'reviewer')
    // 13. Normal engineering resolves through the active profile's primaryEngineer role.
    const attemptText = fs.readFileSync(path.join(fixture, '.ai-harness', 'runs', taskB.taskId, 'attempts.jsonl'), 'utf8')
    const attemptB = JSON.parse(attemptText.trim().split('\n').pop())
    assert.equal(attemptB.taskInstanceId, taskB.taskInstanceId, 'attempt records carry instance B')
    assert.equal(attemptB.executionClass, 'engineer_normal')

    // 16. Control Room reports ONE internally consistent execution tuple.
    const snapshot = await status.buildControllerSnapshot({
      dataRoot: dataHome,
      sessionId: session.id,
      statePath: path.join(dataHome, 'aih-state.json'),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      gitSummary: null,
    })
    assert.equal(snapshot.binding.taskInstanceId, taskB.taskInstanceId)
    assert.equal(snapshot.task.taskId, taskB.taskId)
    assert.equal(snapshot.task.taskInstanceId, taskB.taskInstanceId, 'the ledger task joins by instance')
    assert.equal(snapshot.execution.identityInconsistent, undefined)
    assert.equal(snapshot.execution.class, 'engineer_normal')
    assert.equal(snapshot.execution.modelId, normalTarget.modelId, 'Engineer Normal resolves through the active profile primaryEngineer binding')
    assert.equal(snapshot.execution.model, normalTarget.modelDisplayName, 'the reported executor display name comes from the active profile registry target')
    assert.equal(snapshot.execution.role, 'primaryEngineer')
    // 8. No reviewer record of generation A can attach to B.
    const decisionsText = fs.readFileSync(path.join(dataHome, 'routing', 'decisions.jsonl'), 'utf8')
    const allDecisions = decisionsText.trim().split('\n').map((l) => JSON.parse(l))
    const forB = status.lastDecisionOf(allDecisions, taskB.taskId, fixture, taskB.taskInstanceId)
    assert.equal(forB.executionClass, 'engineer_normal')
    assert.notEqual(forB.modelId, reviewerTarget.modelId, 'the A reviewer decision never becomes B\'s executor')

    // 14. Engineer Deep resolves through the ACTIVE profile configuration
    //     (the state-level regression lives in TaskIdentity.Tests.ps1): the
    //     expected targets are DERIVED from the fixture's copied glm-codex
    //     profile + model registry, so the configuration layer is validated
    //     and no model identity is hardcoded here — Phase 3.2.5 remapped the
    //     deep role with zero controller changes.
    assert.ok(deepTarget && reviewerTarget, 'deepEngineer and reviewer targets resolve through the active profile + registry')

    // 14b. The real controller /verify path mirrors its result into the
    // Phase 3.2.5 verification log, updates requirements, exposes telemetry,
    // and lets deterministic completion consume the verified requirement.
    const verifyOutcome = await turn(preStep2, '/verify')
    assert.equal(verifyOutcome && verifyOutcome.kind, 'reject', 'controller-owned /verify completes without an engineer model turn')
    const verificationRecords = fs.readFileSync(path.join(runRootB, 'verification-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(verificationRecords.length, 1, 'production /verify records one Phase 3.2.5 verification')
    assert.equal(verificationRecords[0].taskInstanceId, taskB.taskInstanceId, 'verification record preserves taskInstanceId')
    assert.equal(verificationRecords[0].result, 'pass', 'verification record consumes the successful project verification')
    assert.deepEqual(verificationRecords[0].requirementIds, [requirementsB.requirements[0].id], 'verification record links the compiled requirement identity')
    const verifiedRequirementsB = JSON.parse(fs.readFileSync(path.join(runRootB, 'requirements.json'), 'utf8'))
    assert.equal(verifiedRequirementsB.requirements[0].status, 'verified', 'linked PASS verification moves the required requirement to verified')
    assert.equal(verifiedRequirementsB.requirements[0].verificationEvidence[0].verificationId, verificationRecords[0].verificationId, 'requirement state links back to the exact verification record')
    assert.equal(readLedger().tasks.find((item) => item.taskInstanceId === taskB.taskInstanceId).status, 'complete', 'controller completion consumes verified requirement state')
    const telemetryResult = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(installRoot, 'scripts', 'Engineering.ps1'), '-Action', 'telemetry-snapshot', '-TaskId', taskB.taskId, '-Workspace', fixture, '-TaskInstanceId', taskB.taskInstanceId], { timeout: 320000, windowsHide: true })
    const engineeringTelemetry = JSON.parse(telemetryResult.stdout)
    assert.equal(engineeringTelemetry.taskInstanceId, taskB.taskInstanceId, 'engineering telemetry remains generation-scoped')
    assert.equal(engineeringTelemetry.totalModelCalls, 1, 'telemetry derives the real GUI engineering step count')
    assert.deepEqual(engineeringTelemetry.verificationCommands, ['aih-verify-project'], 'telemetry consumes the production verification record')
    assert.equal(engineeringTelemetry.epistemicActions.reason, 1, 'telemetry counts the production GUI reasoning action')
    assert.equal(engineeringTelemetry.epistemicActions.verify, 1, 'telemetry counts controller-owned VERIFY without fabricating a model call')
    const epistemicAfterVerify = fs.readFileSync(path.join(runRootB, 'epistemic-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(epistemicAfterVerify.some((record) => record.event === 'action-completed' && record.result === 'succeeded'), 'production verification closes its epistemic action lifecycle')

    // 15. Explicit /review routes ONLY through the independent reviewer: the
    //     packet-too-large rejection (legacy enforceLimits=true, set in this
    //     fixture's isolated policy) is enforced BEFORE any model transport,
    //     so the turn proves reviewer routing + zero engineer calls + fail-closed.
    const tasksBefore = readLedger().tasks.length
    const reviewOutcome = await turn(preStep2, '/review Review src/huge.js for correctness edge cases')
    assert.equal(reviewOutcome && reviewOutcome.kind, 'reject', 'the review turn fails closed on the oversized packet')
    const ledgerReview = readLedger()
    assert.equal(ledgerReview.tasks.length, tasksBefore, 'explicit review does NOT create an engineer replacement task')
    const reviewTask = ledgerReview.tasks.find((t) => t.taskId === taskB.taskId)
    assert.equal(reviewTask.reviewRequested, true, 'the bound task carries reviewRequested=true')
    // The explicit review is an ESCALATION record on top of the engineer root:
    // the instance-scoped history must contain the reviewer decision for B,
    // and only for B.
    const bDecisions = fs.readFileSync(path.join(dataHome, 'routing', 'decisions.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.taskId === taskB.taskId && r.taskInstanceId === taskB.taskInstanceId)
    const reviewDecision = bDecisions[bDecisions.length - 1]
    assert.equal(reviewDecision.executionClass, 'reviewer', 'the explicit review routed the reviewer class')
    assert.equal(reviewDecision.model, reviewerTarget.model, 'reviewer resolves through the active profile reviewer target')
    assert.equal(bDecisions.filter((r) => r.executionClass === 'reviewer').length, 1, 'exactly one reviewer decision, instance-scoped')
    const stepRoutingAfterReview = fs.readFileSync(path.join(runRootB, 'step-routing.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(stepRoutingAfterReview.length, 1, 'review does not create an engineering step-selection record')
    assert.ok(stepRoutingAfterReview.every((record) => record.selectedRole !== 'reviewer'), 'reviewer remains outside engineering step selection')
    const epistemicAfterReview = fs.readFileSync(path.join(runRootB, 'epistemic-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(epistemicAfterReview.every((record) => record.selectedAction !== 'reviewer'), 'reviewer never becomes an epistemic action in production')
    const attemptsForReview = fs.existsSync(path.join(fixture, '.ai-harness', 'runs', taskB.taskId, 'attempts.jsonl'))
      ? fs.readFileSync(path.join(fixture, '.ai-harness', 'runs', taskB.taskId, 'attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.status === 'started').length
      : 0
    assert.equal(attemptsForReview, 1, 'zero engineer calls before review (the only attempt predates the review turn)')
    assert.ok(session.messages.some((m) => m.message && m.message.source && m.message.source.form === 'review-packet-too-large'), 'the oversized packet was rejected by budget enforcement')

    // 22J/Part 13 (real bridge): two simultaneous controller events for one
    // stale session create exactly one replacement task.
    fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, nextSequence: 1, tasks: [] }))
    await Promise.all([
      turn(preStep2, 'concurrent event one'),
      turn(preStep2, 'concurrent event two'),
    ])
    const ledgerFinal = readLedger()
    assert.equal(ledgerFinal.tasks.length, 1, 'one stale session + two simultaneous events = one replacement task')
    const taskC = ledgerFinal.tasks[0]
    assert.notEqual(taskC.taskInstanceId, taskB.taskInstanceId, 'the replacement task has a fresh instance')

    // 17. No manual deletion of session-bindings.json or routing state was
    //     required at any point; the same session id kept working throughout.
    console.log('PASS: aih-controller identity end-to-end (DoD scenario)')
  } finally {
    process.env.DSH_HOME = previousHome
    fs.rmSync(installRoot, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

async function main() {
  unitIdentityHelpers()
  console.log('PASS: identity helpers (workspace normalization + classification)')
  await unitBindingGuard()
  console.log('PASS: binding guard matrix (22A/B/C/D/E/F/G/H/I/J + Part 21)')
  unitControlRoomJoins()
  console.log('PASS: Control Room instance joins (routing state/decisions/attempts/gates)')
  unitImpossibleTuple()
  console.log('PASS: impossible execution tuple fails closed (Part 24)')
  unitEngineeringIsolation()
  console.log('PASS: Engineering Isolation generation-aware executor selection (Part 17)')
  await unitDetailJoins()
  console.log('PASS: detail snapshot instance joins (Part 18)')
  await runBridgeEndToEnd()
  console.log('RESULT: all controller identity regressions passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
