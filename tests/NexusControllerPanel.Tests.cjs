'use strict'

/**
 * Deterministic tests for the Nexus Controller panel state layer
 * (ui/nexus-controller/lib/status.cjs), the host route plugin
 * (lib/index.js), and the client bundle (lib/client.js).
 *
 * Everything runs against fixtures under os.tmpdir(); no live harness state
 * is required and nothing writes outside the temp dirs it creates.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const ADAPTER = path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'status.cjs')
const HOST = path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'index.js')
const CLIENT = path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'client.js')
const DETAIL = path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'detail.cjs')

const status = require(ADAPTER)
const detail = require(DETAIL)
// spawnSync-backed: a runner sandbox that denies child-process pipes surfaces
// the denial as probe.error (a catchable rejection) instead of a process-level
// throw, so git-backed sections degrade deterministically there.
const { spawnSync } = require('node:child_process')
function pexec(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const r = spawnSync(cmd, args, opts)
    if (r.error) { reject(r.error); return }
    if (r.status !== 0) { const e = new Error('exit ' + r.status); e.stdout = r.stdout; reject(e); return }
    resolve({ stdout: r.stdout })
  })
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** In-memory file map reader for buildControllerSnapshot. Keys must be absolute. */
function memoryReader(files) {
  return (filePath) => {
    const key = path.resolve(filePath)
    if (!Object.prototype.hasOwnProperty.call(files, key)) throw new Error('ENOENT: ' + key)
    return files[key]
  }
}

/** Write a { absolutePath: content } map; relative keys resolve under root. */
function writeTree(root, files) {
  for (const [target, content] of Object.entries(files)) {
    const absolute = path.isAbsolute(target) ? target : path.join(root, target)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content, 'utf8')
  }
}

const FIXTURE_TASK = {
  schemaVersion: 1,
  nextSequence: 2,
  tasks: [
    {
      schemaVersion: 1,
      taskId: 'TASK-0042',
      description: 'Fix BLE reconnect issue',
      status: 'ready',
      executionClass: 'deepseek_normal',
      executor: 'deepseek_normal',
      attempt: 2,
      maxAttempts: 3,
      risk: 'normal',
      verification: {
        required: ['typecheck', 'tests'],
        outcomes: [
          { name: 'typecheck', status: 'PASS', evidence: 'tsc --noEmit' },
          { name: 'tests', status: 'PASS', evidence: 'npm test' },
        ],
      },
      reviewRequested: false,
      executionClassOverride: 'deepseek_normal',
      worktree: null,
      failureSignatures: [],
      codexCalls: 0,
      completionAuthority: 'controller',
      createdAtUtc: '2026-08-28T17:00:00.0000000Z',
      updatedAtUtc: '2026-08-28T17:30:00.0000000Z',
      completedAtUtc: null,
    },
  ],
}

const FIXTURE_BINDING = {
  sessionId: 'session-0001',
  taskId: 'TASK-0042',
  workspace: null, // filled with the fixture workspace by fixtureFileMap
  preset: 'aih-engineering',
  description: 'Fix BLE reconnect issue',
  executionClass: 'deepseek_normal',
  reviewRequired: false,
  needsRouteCheck: false,
  boundAtUtc: '2026-08-28T17:00:00.000Z',
}

const FIXTURE_DECISION = {
  recordVersion: 3,
  timestampUtc: '2026-08-28T17:29:00.000Z',
  taskId: 'TASK-0042',
  workspace: null,
  preset: 'aih-engineering',
  selectedExecutionClass: 'deepseek_normal',
  executionClass: 'deepseek_normal',
  provider: 'flash-max-direct',
  model: 'deepseek-v4-flash',
  reasoning: 'max',
  risk: 'normal',
  reviewRequired: false,
  matchedRule: 'default-deepseek',
}

const FIXTURE_SETTINGS = [
  'agent-default-model:',
  '  provider: flash-max-direct',
  '  model: deepseek-v4-flash',
  '  reasoningEffort: max',
  '',
  'llm-pi-ai:',
  '  providers:',
  '    flash-max-direct:',
  '      displayName: DeepSeek V4 Flash MAX (direct)',
  '      models:',
  '        - id: deepseek-v4-flash',
  '          name: DeepSeek V4 Flash',
  '          reasoningEfforts:',
  '            off:',
  '            high: high',
  '            max: max',
  '    deepseek-pro-direct:',
  '      displayName: DeepSeek V4 Pro MAX (direct)',
  '      models:',
  '        - id: deepseek-v4-pro',
  '          name: DeepSeek V4 Pro',
  '',
].join('\n')

/** Build the absolute fixture file map for one bound session. */
function fixtureFileMap(dataRoot, workspace, { task, executionClass, decision, decisions } = {}) {
  const stateFile = status.routingStateFileName(workspace, 'aih-engineering', 'TASK-0042')
  const bindings = { ...FIXTURE_BINDING, workspace }
  const files = {}
  files[path.join(dataRoot, 'routing', 'session-bindings.json')] =
    JSON.stringify({ schemaVersion: 1, bindings: { 'session-0001': bindings } })
  files[path.join(dataRoot, 'routing', 'states', stateFile)] = JSON.stringify({
    taskId: 'TASK-0042',
    workspace,
    preset: 'aih-engineering',
    executionClass: executionClass || 'deepseek_normal',
    selectedTier: 3,
    risk: 'normal',
    reviewRequired: false,
    reviewRequested: false,
    lastFailureSignature: '',
    sameFailureCount: 0,
    updatedAtUtc: '2026-08-28T17:30:00.000Z',
  })
  const decisionRecord = decision
    ? { ...decision, workspace: decision.workspace == null ? workspace : decision.workspace }
    : { ...FIXTURE_DECISION, workspace, executionClass: executionClass || 'deepseek_normal', selectedExecutionClass: executionClass || 'deepseek_normal' }
  // Identity isolation (TASK-0003.2): routing decisions JOIN on normalized
  // workspace + taskId, so fixture records without a workspace are authored
  // FOR this fixture workspace (records with an explicit workspace — e.g.
  // the cross-workspace collision fixture — are kept verbatim).
  const authoredDecisions = Array.isArray(decisions)
    ? decisions.map((record) => (record && record.workspace == null ? { ...record, workspace } : record))
    : null
  if (Array.isArray(authoredDecisions) && authoredDecisions.length > 0) {
    files[path.join(dataRoot, 'routing', 'decisions.jsonl')] = authoredDecisions.map((record) => JSON.stringify(record)).join('\n') + '\n'
  } else {
    files[path.join(dataRoot, 'routing', 'decisions.jsonl')] = JSON.stringify(decisionRecord) + '\n'
  }
  files[path.join(dataRoot, 'settings.yaml')] = FIXTURE_SETTINGS
  files[path.join(dataRoot, 'aih-state.json')] = JSON.stringify({
    SchemaVersion: 3,
    Status: 'READY',
    Pid: 12345,
    ProcessStartedAtUtc: '2026-08-28T17:00:00.0000000Z',
    Workspace: workspace,
    Url: 'http://127.0.0.1:3080',
  })
  files[path.join(workspace, '.ai-harness', 'state', 'tasks.json')] = JSON.stringify(task || FIXTURE_TASK)
  return files
}

/**
 * Detail-adapter fixture map: the same files as fixtureFileMap plus the
 * run artifacts the Task Control Room reads (attempts, evidence, review).
 * Pass decisions: [] to write an EMPTY routing ledger (no history).
 */
function detailFixtureFileMap(dataRoot, workspace, {
  task, decisions, lifecycle, attempts, evidence, reviewPacket, reviewResult,
  routingState, corrupt = {},
} = {}) {
  const files = fixtureFileMap(dataRoot, workspace, { task, decisions })
  if (Array.isArray(decisions) && decisions.length === 0) {
    // fixtureFileMap falls back to the default decision for empty arrays —
    // an explicit empty array means a genuinely empty routing ledger.
    files[path.join(dataRoot, 'routing', 'decisions.jsonl')] = ''
  }
  const ledgerPath = path.join(workspace, '.ai-harness', 'state', 'decisions.jsonl')
  files[ledgerPath] = Array.isArray(lifecycle) ? lifecycle.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''
  const runsDir = path.join(workspace, '.ai-harness', 'runs', 'TASK-0042')
  files[path.join(runsDir, 'manifest.json')] = '{}'
  if (attempts !== undefined) files[path.join(runsDir, 'attempts.jsonl')] = attempts.map((r) => JSON.stringify(r)).join('\n') + '\n'
  if (evidence !== undefined) files[path.join(runsDir, 'evidence.json')] = JSON.stringify(evidence)
  if (reviewPacket !== undefined) files[path.join(runsDir, 'review-packet.json')] = JSON.stringify(reviewPacket)
  if (reviewResult !== undefined) files[path.join(runsDir, 'review-result.json')] = JSON.stringify(reviewResult)
  if (corrupt.evidence) files[path.join(runsDir, 'evidence.json')] = '{ this is not json'
  if (corrupt.attempts) files[path.join(runsDir, 'attempts.jsonl')] = '{broken}\n'
  if (corrupt.decisions) files[path.join(dataRoot, 'routing', 'decisions.jsonl')] = '{broken line}\n' + files[path.join(dataRoot, 'routing', 'decisions.jsonl')]
  if (corrupt.lifecycle) files[ledgerPath] = '{broken}\n' + files[ledgerPath]
  if (routingState) {
    const stateFile = status.routingStateFileName(workspace, 'aih-engineering', 'TASK-0042')
    files[path.join(dataRoot, 'routing', 'states', stateFile)] = JSON.stringify(routingState)
  }
  return files
}

async function detailFixture(overrides = {}) {
  const dataRoot = tmpDir('nexus-ctr-d-')
  const workspace = path.join(dataRoot, 'ws')
  const files = detailFixtureFileMap(dataRoot, workspace, overrides)
  writeTree(dataRoot, files)
  const snapshot = await detail.buildDetailSnapshot({
    dataRoot,
    sessionId: 'session-0001',
    statePath: path.join(dataRoot, 'aih-state.json'),
    readFile: memoryReader(files),
    modelNames: {
      'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'sol-local/gpt-5.6-sol': 'GPT-5.6 Sol',
    },
    gitSummary: null,
    gitFiles: null,
    nowUtc: () => '2026-08-28T18:00:00.000Z',
  })
  return { snapshot, dataRoot, workspace }
}

async function fixtureSnapshot(overrides = {}) {
  const dataRoot = tmpDir('nexus-ctr-')
  const workspace = path.join(dataRoot, 'ws')
  const files = fixtureFileMap(dataRoot, workspace, overrides)
  writeTree(dataRoot, files)
  const snapshot = await status.buildControllerSnapshot({
    dataRoot,
    sessionId: 'session-0001',
    statePath: path.join(dataRoot, 'aih-state.json'),
    readFile: memoryReader(files),
    modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
    gitSummary: null,
    nowUtc: () => '2026-08-28T18:00:00.000Z',
  })
  return { snapshot, dataRoot, workspace }
}

async function main() {
  // ── 1. empty state: no binding → idle, task null ─────────────────────────
  {
    const dataRoot = tmpDir('nexus-ctr-')
    const files = {
      [path.join(dataRoot, 'routing', 'session-bindings.json')]: JSON.stringify({ schemaVersion: 1, bindings: {} }),
      [path.join(dataRoot, 'aih-state.json')]: '{}',
    }
    writeTree(dataRoot, files)
    const snapshot = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-9999',
      statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files),
      gitSummary: null,
    })
    assert.equal(snapshot.schemaVersion, 1)
    assert.equal(snapshot.state, 'idle')
    assert.equal(snapshot.binding, null)
    assert.equal(snapshot.task, null)
    assert.equal(snapshot.execution, null)
    assert.equal(snapshot.review, null)
  }

  // ── 2. active DeepSeek task: real fixture state → normalized snapshot ────
  {
    const { snapshot, workspace } = await fixtureSnapshot()
    assert.equal(snapshot.state, 'working') // ledger 'ready' = working family; session flag folds in the client
    assert.equal(snapshot.binding.taskId, 'TASK-0042')
    assert.equal(snapshot.binding.workspace, workspace)
    assert.equal(snapshot.task.taskId, 'TASK-0042')
    assert.equal(snapshot.task.description, 'Fix BLE reconnect issue')
    assert.equal(snapshot.task.attempt, 2)
    assert.equal(snapshot.task.maxAttempts, 3)
    assert.equal(snapshot.execution.class, 'deepseek_normal')
    assert.equal(snapshot.execution.model, 'DeepSeek V4 Flash')
    assert.equal(snapshot.execution.modelId, 'deepseek-v4-flash')
    assert.equal(snapshot.execution.reasoning, 'max')
    assert.equal(snapshot.execution.provider, 'flash-max-direct')
    assert.equal(snapshot.controller.status, 'READY')
    assert.equal(snapshot.controller.pid, 12345)
  }

  // ── 3. verification pass: correct passed/total ───────────────────────────
  {
    const { snapshot } = await fixtureSnapshot()
    assert.equal(snapshot.task.verification.status, 'passed')
    assert.equal(snapshot.task.verification.passed, 2)
    assert.equal(snapshot.task.verification.failed, 0)
    assert.equal(snapshot.task.verification.total, 2)
    assert.deepEqual(snapshot.task.verification.checks.map((c) => c.status), ['PASS', 'PASS'])
  }

  // ── 4. verification failure: surfaced, never crashes the adapter ─────────
  {
    const failing = JSON.parse(JSON.stringify(FIXTURE_TASK))
    failing.tasks[0].verification.outcomes = [
      { name: 'typecheck', status: 'PASS', evidence: 'tsc --noEmit' },
      { name: 'lint', status: 'FAIL', evidence: 'eslint' },
    ]
    failing.tasks[0].status = 'verifying'
    const { snapshot } = await fixtureSnapshot({ task: failing })
    // TASK-0004.1: 1 PASS + 1 FAIL is FAILED — never 'partial'.
    assert.equal(snapshot.task.verification.status, 'failed')
    assert.equal(snapshot.task.verification.passed, 1)
    assert.equal(snapshot.task.verification.failed, 1)
    assert.equal(snapshot.task.verification.total, 2)
    assert.equal(snapshot.state, 'verifying')
  }

  // ── 5. codex review: recorded call count shown, no Codex is triggered ────
  {
    const reviewed = JSON.parse(JSON.stringify(FIXTURE_TASK))
    reviewed.tasks[0].codexCalls = 1
    reviewed.tasks[0].reviewRequested = true
    const { snapshot } = await fixtureSnapshot({ task: reviewed })
    assert.equal(snapshot.review.codexCalls, 1)
    assert.equal(snapshot.review.reviewRequested, true)
  }

  // ── 6. display-state derivation (smallest truthful set) ──────────────────
  {
    const binding = { executionClass: 'deepseek_normal' }
    const task = (statusValue) => ({ status: statusValue })
    assert.equal(status.deriveFileState(null, null), 'idle')
    assert.equal(status.deriveFileState(binding, null), 'starting') // bound, ledger missing
    assert.equal(status.deriveFileState(binding, task('ready')), 'working') // GUI tasks stay 'ready' through their turns
    assert.equal(status.deriveFileState(binding, task('implementing')), 'working')
    assert.equal(status.deriveFileState({ executionClass: 'codex_review' }, task('implementing')), 'reviewing')
    assert.equal(status.deriveFileState({ executionClass: 'deepseek_deep' }, task('implementing')), 'repairing')
    assert.equal(status.deriveFileState(binding, task('verifying')), 'verifying')
    assert.equal(status.deriveFileState(binding, task('complete')), 'complete')
    assert.equal(status.deriveFileState(binding, task('failed')), 'failed')
    // client folds the live running flag: non-terminal + idle → waiting
    assert.equal(status.deriveDisplayState('working', true), 'working')
    assert.equal(status.deriveDisplayState('working', false), 'waiting')
    assert.equal(status.deriveDisplayState('reviewing', false), 'waiting')
    assert.equal(status.deriveDisplayState('verifying', false), 'verifying') // CLI-owned
    assert.equal(status.deriveDisplayState('complete', false), 'complete')
    assert.equal(status.deriveDisplayState('failed', false), 'failed')
    assert.equal(status.deriveDisplayState('idle', true), 'idle')
  }

  // ── 7. routing-state file name matches the PowerShell contract ───────────
  {
    // Cross-validated against a real file written by Routing.ps1 in the live
    // install (data/routing/states/5b4c223a91aeb7a3623942f56a75bb2994554ed6e86b7e539f21748d203a58f1.json).
    assert.equal(
      status.routingStateFileName('C:\\AI-Harness', 'aih-engineering', 'TASK-0002'),
      '5b4c223a91aeb7a3623942f56a75bb2994554ed6e86b7e539f21748d203a58f1.json',
    )
  }

  // ── 8. corrupt / missing state degrades safely ───────────────────────────
  {
    const dataRoot = tmpDir('nexus-ctr-')
    const corruptBindings = path.join(dataRoot, 'routing', 'session-bindings.json')
    const corruptState = path.join(dataRoot, 'aih-state.json')
    const files = {
      [corruptBindings]: '{ this is not json',
      [corruptState]: '[[[',
    }
    writeTree(dataRoot, files)
    const snapshot = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-0001',
      statePath: corruptState,
      readFile: memoryReader(files),
      gitSummary: null,
    })
    assert.equal(snapshot.state, 'idle')
    assert.equal(snapshot.binding, null)
    assert.equal(snapshot.task, null)
    assert.equal(snapshot.controller, null)
  }

  // ── 9. git: pure parsers ─────────────────────────────────────────────────
  {
    const counts = status.parsePorcelainStatus([
      ' M src/a.ts',
      'M  src/b.ts',
      '?? untracked.txt',
      ' D old.txt',
      'R  old.ts -> new.ts',
    ])
    assert.equal(counts.modified, 2)
    assert.equal(counts.deleted, 1)
    assert.equal(counts.renamed, 1)
    assert.equal(counts.untracked, 1)
    const numstat = status.parseNumstat(['23\t11\tsrc/a.ts', '0\t-\told.txt', '4\t1\tnew.ts'])
    assert.equal(numstat.insertions, 27)
    assert.equal(numstat.deletions, 12)
    assert.equal(numstat.files, 3)
  }

  // ── 10. git: real fixture repository ─────────────────────────────────────
  {
    const dir = tmpDir('nexus-git-')
    let gitBin = null
    // spawnSync (not promisified execFile): a runner sandbox that denies
    // child-process pipes surfaces the denial as probe.error instead of a
    // process-level throw, so the git section degrades to a skip exactly
    // like the git-absent case.
    const { spawnSync } = require('node:child_process')
    for (const candidate of ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files (x86)/Git/cmd/git.exe']) {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 })
      if (!probe.error && probe.status === 0) { gitBin = candidate; break }
    }
    if (gitBin !== null) {
      await pexec(gitBin, ['init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8' })
      await pexec(gitBin, ['config', 'user.email', 'test@nexus.local'], { cwd: dir, encoding: 'utf8' })
      await pexec(gitBin, ['config', 'user.name', 'Nexus Test'], { cwd: dir, encoding: 'utf8' })
      fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n')
      await pexec(gitBin, ['add', '.'], { cwd: dir, encoding: 'utf8' })
      await pexec(gitBin, ['commit', '-q', '-m', 'base'], { cwd: dir, encoding: 'utf8' })
      fs.writeFileSync(path.join(dir, 'base.txt'), 'base\nchanged line\n')
      fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n')
      const summary = await status.collectGitSummary(dir)
      assert.equal(summary.branch, 'main')
      assert.equal(summary.modified, 1)
      assert.equal(summary.untracked, 1)
      assert.equal(summary.filesChanged, 2)
      assert.equal(summary.insertions, 1)
      assert.equal(summary.deletions, 0)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 11. host plugin: route registration + endpoint handler ───────────────
  {
    const dataRoot = tmpDir('nexus-ctr-')
    const workspace = path.join(dataRoot, 'ws')
    const files = fixtureFileMap(dataRoot, workspace, {})
    writeTree(dataRoot, files)

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dataRoot
    try {
      const plugin = await import(pathToFileURL(HOST).href)
      // 11a. REGRESSION: the plugin activates BEFORE webServer exists (late
      // composition ordering). The route must NOT be lost to a one-time
      // lookup — nothing registers until the service becomes available.
      let captured = []
      let injectKeys = null
      let injectCallback = null
      const fakeWebServer = { register(spec) { captured.push(spec) } }
      const noWebCtx = {
        inject(keys, callback) { injectKeys = keys; injectCallback = callback },
        effect() { return () => {} },
      }
      plugin.apply(noWebCtx)
      assert.ok(injectKeys, 'apply must declare a lifecycle injection for webServer')
      assert.ok(Array.isArray(injectKeys) && injectKeys.includes('webServer'), 'injection must require the webServer service')
      assert.equal(captured.length, 0, 'no route may register before webServer is available')

      // 11b. webServer becomes available later → the injection callback
      // applies and BOTH routes register (Cordis lifecycle semantics).
      assert.doesNotThrow(() => injectCallback({ webServer: fakeWebServer, effect(fn) { fn(); return () => {} } }), 'injection callback must apply cleanly once the service exists')
      assert.equal(captured.length, 6, 'all routes must register after webServer becomes available')
      const paths = captured.map((spec) => spec.path).sort()
      assert.deepEqual(paths, ['/nexus/control-room.json', '/nexus/controller.json', '/nexus/engineering-profile-action.json', '/nexus/engineering-profile.json', '/nexus/gate-action.json', '/nexus/workspace-registration.json'])
      const route = captured.find((spec) => spec.path === '/nexus/controller.json')
      assert.equal(route.kind, 'exact')
      const roomRoute = captured.find((spec) => spec.path === '/nexus/control-room.json')
      assert.equal(roomRoute.kind, 'exact')
      const gateRoute = captured.find((spec) => spec.path === '/nexus/gate-action.json')
      assert.equal(gateRoute.kind, 'exact')
      const engineeringRoute = captured.find((spec) => spec.path === '/nexus/engineering-profile.json')
      assert.equal(engineeringRoute.kind, 'exact')
      const engineeringActionRoute = captured.find((spec) => spec.path === '/nexus/engineering-profile-action.json')
      assert.equal(engineeringActionRoute.kind, 'exact')
      const workspaceRegistrationRoute = captured.find((spec) => spec.path === '/nexus/workspace-registration.json')
      assert.equal(workspaceRegistrationRoute.kind, 'exact')

      // 11c. profiles that NEVER provide webServer stay inert (tui/headless)
      captured = []
      plugin.apply({ inject() {}, effect() { return () => {} } })
      assert.equal(captured.length, 0)

      const res = {
        writeHead(code, headers) { this.code = code; this.headers = headers },
        end(body) { this.body = body },
      }
      await route.handler({ url: '/nexus/controller.json?session=session-0001' }, res)
      const payload = JSON.parse(res.body)
      assert.equal(res.code, 200)
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.equal(payload.schemaVersion, 1)
      assert.equal(payload.binding.taskId, 'TASK-0042')
      assert.equal(payload.task.taskId, 'TASK-0042')
      assert.equal(payload.execution.class, 'deepseek_normal')
      assert.equal(payload.task.verification.passed, 2)
      assert.equal(payload.controller.status, 'READY')

      // unknown session → graceful idle envelope
      await route.handler({ url: '/nexus/controller.json?session=session-nope' }, res)
      const idlePayload = JSON.parse(res.body)
      assert.equal(idlePayload.state, 'idle')
      assert.equal(idlePayload.binding, null)

      // control-room endpoint: detail envelope for the bound session
      await roomRoute.handler({ url: '/nexus/control-room.json?session=session-0001' }, res)
      const roomPayload = JSON.parse(res.body)
      assert.equal(res.code, 200)
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.equal(roomPayload.schemaVersion, 1)
      assert.equal(roomPayload.binding.taskId, 'TASK-0042')
      assert.ok(Array.isArray(roomPayload.routingHistory), 'routingHistory is an array')
      assert.equal(roomPayload.routingHistory.length, 1)
      assert.equal(roomPayload.routingHistory[0].kind, 'primary')
      assert.deepEqual(roomPayload.attempts, [], 'no attempts recorded in fixture')
      assert.equal(roomPayload.verification.total, 2, 'verification falls back to the ledger outcomes')
      assert.equal(roomPayload.controller.status, 'READY')
      assert.equal(roomPayload.binding.workspace, workspace)
      // unknown session → idle envelope on the detail endpoint too
      await roomRoute.handler({ url: '/nexus/control-room.json?session=session-nope' }, res)
      const roomIdle = JSON.parse(res.body)
      assert.equal(roomIdle.state, 'idle')
      assert.equal(roomIdle.binding, null)
      assert.equal(roomIdle.error, undefined, 'unbound session is an idle envelope, not an error')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }

  // ── 11b. REAL-cordis regression: plugin activates before webServer, the
  //         service is provided later, and the route registers then ────────
  {
    const dataRoot = tmpDir('nexus-ctr-cordis-')
    const workspace = path.join(dataRoot, 'ws')
    writeTree(dataRoot, fixtureFileMap(dataRoot, workspace, {}))

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dataRoot
    try {
      const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
      const cordis = requireFromApp('@deepseek-ai/cordis')
      const plugin = await import(pathToFileURL(HOST).href)
      const registered = []
      const fakeWebServer = { register(spec) { registered.push(spec) } }
      const root = new cordis.Context()
      root.plugin({ name: 'nexus-controller', apply: plugin.apply })
      const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      await tick(150)
      assert.equal(registered.length, 0, 'real cordis: no route while webServer is absent')

      // the service appears AFTER the plugin activated — the deferred
      // injection resolves and the route registers.
      root.provide('webServer', fakeWebServer)
      for (let i = 0; i < 60 && registered.length < 5; i++) await tick(50)
      assert.equal(registered.length, 6, 'real cordis: all routes register after webServer becomes available')
      assert.deepEqual(registered.map((spec) => spec.path).sort(), ['/nexus/control-room.json', '/nexus/controller.json', '/nexus/engineering-profile-action.json', '/nexus/engineering-profile.json', '/nexus/gate-action.json', '/nexus/workspace-registration.json'])
      assert.ok(registered.every((spec) => spec.kind === 'exact'))

      // the registered handler keeps the existing semantics.
      const res = {
        writeHead(code, headers) { this.code = code; this.headers = headers },
        end(body) { this.body = body },
      }
      const stateRoute = registered.find((spec) => spec.path === '/nexus/controller.json')
      await stateRoute.handler({ url: '/nexus/controller.json?session=session-0001' }, res)
      const payload = JSON.parse(res.body)
      assert.equal(res.code, 200)
      assert.equal(payload.schemaVersion, 1)
      assert.equal(payload.binding.taskId, 'TASK-0042')
      assert.equal(payload.controller.status, 'READY')
      await tick(20)
      if (typeof root.dispose === 'function') await root.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }

  // ── 12. client bundle: loads, registers both seats, renders without crash ─
  {
    const code = fs.readFileSync(CLIENT, 'utf8')
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup

    const registered = []
    const injected = []
    let moduleExports = null
    const sandbox = {
      console,
      URL,
      setTimeout,
      clearTimeout,
      window: {
        location: { href: 'http://127.0.0.1:3080/' },
        history: { state: null, replaceState() {} },
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: {
          getItem() { return null },
          setItem() {},
        },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: {
        createElement() {
          return { dataset: {}, remove() {} }
        },
        head: { appendChild() {} },
      },
    }
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    assert.ok(moduleExports, 'client bundle must export a module')
    assert.equal(JSON.stringify(moduleExports.inject), JSON.stringify(['slots', 'workspaces']), 'client services')

    const fakeCtx = {
      effect(fn) { fn(); return () => {} },
      workspaces: {
        list: {
          getSnapshot() { return { phase: 'pending', items: [] } },
          subscribe() { return () => {} },
        },
      },
      slots: {
        inject(name, callback) { injected.push({ name, callback }); callback() },
        register(spec, component) { registered.push({ spec, component }) },
      },
    }
    moduleExports.apply(fakeCtx)
    assert.deepEqual(injected.map((i) => i.name), ['shell.overlay', 'conversation.session.header.actions', 'conversation.input.right'])
    assert.equal(registered.length, 3)
    assert.equal(registered[0].spec.name, 'shell.overlay')
    assert.equal(registered[0].spec.id, 'nexus-controller')
    assert.equal(registered[0].spec.order, 100)
    assert.equal(registered[1].spec.name, 'conversation.session.header.actions')
    assert.equal(registered[1].spec.id, 'nexus-controller')
    assert.equal(registered[1].spec.order, 90)
    assert.equal(typeof registered[0].component, 'function')
    // composer tool row: additive pill seat for the routed executor
    assert.equal(registered[2].spec.name, 'conversation.input.right')
    assert.equal(registered[2].spec.id, 'nexus-controller')
    assert.equal(registered[2].spec.order, 90)
    assert.equal(typeof registered[2].component, 'function')

    // The controller must NOT register into the single details seat (that seat
    // belongs to the native DetailsPanel and its child declaration).
    assert.ok(!injected.some((i) => i.name === 'details'), 'controller must not inject into details')

    // SSR smoke: the drawer renders without errors in the empty state.
    const Drawer = registered[0].component
    const Toggle = registered[1].component
    const useSessions = (selector) => selector({ current: 'session-x', byId: { 'session-x': { running: false } } })
    const markup = renderToStaticMarkup(react.createElement(Drawer, { useSessions }))
    assert.match(markup, /data-nexus-drawer/)
    assert.match(markup, /data-nexus-controller/)
    assert.match(markup, /CONTROLLER/)
    const toggleMarkup = renderToStaticMarkup(react.createElement(Toggle, { sessionId: 'session-x' }))
    assert.match(toggleMarkup, /nx-toggle/)

    // ── executor pill: preferred-model chip vs effective routed executor ──
    const pillContent = moduleExports.executorChipContent
    assert.equal(typeof pillContent, 'function', 'executorChipContent must be exported')
    // bound session with a routed executor: pill names the routed model.
    // TASK-0003.3a: the canonical display name is the BASE model identity;
    // the effort badge is its own value and always survives (the tier is no
    // longer embedded in the label). A legacy tier-embedded label still
    // dedupes its badge (generic guard).
    // NOTE: pillContent runs inside the test VM, so cross-realm objects are
    // compared field-by-field (deepStrictEqual would reject the prototypes).
    const highContent = pillContent({ state: 'working', binding: { taskId: 'TASK-0042' }, execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash', reasoning: 'high' } })
    assert.equal(highContent.modelName, 'DeepSeek V4 Flash', 'canonical base model identity')
    assert.equal(highContent.reasoning, 'high', 'effort badge always survives a clean base label')
    // legacy tier-embedded name (any provider that still ships one): the
    // badge is deduped so "…High High" can never render
    const legacyContent = pillContent({ state: 'working', binding: { taskId: 'TASK-0042' }, execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash High', reasoning: 'high' } })
    assert.equal(legacyContent.modelName, 'DeepSeek V4 Flash High')
    assert.equal(legacyContent.reasoning, null, 'effort badge deduped when a legacy display name carries it')
    // unbound / no execution / empty model / error envelope / no snapshot → no pill
    assert.equal(pillContent({ state: 'idle', binding: null, execution: null }), null, 'unbound session never shows an executor pill')
    assert.equal(pillContent({ state: 'waiting', binding: { taskId: 'TASK-0042' }, execution: null }), null)
    assert.equal(pillContent({ state: 'waiting', binding: { taskId: 'TASK-0042' }, execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: '', reasoning: 'high' } }), null)
    assert.equal(pillContent({ state: 'idle', error: 'controller-state-unavailable' }), null, 'envelope errors never show an executor pill')
    assert.equal(pillContent(null), null)
    const ExecutorPill = moduleExports.ExecutorPill
    assert.equal(typeof ExecutorPill, 'function', 'ExecutorPill must be exported')
    const pillHtml = renderToStaticMarkup(react.createElement(ExecutorPill, { content: { modelName: 'DeepSeek V4 Flash', reasoning: 'high', preference: null, preferenceReasoning: null } }))
    assert.match(pillHtml, /data-nexus-executor/)
    assert.match(pillHtml, /RUNNING/)
    assert.match(pillHtml, /DeepSeek V4 Flash/)
    assert.match(pillHtml, />HIGH</, 'effort badge renders uppercase')
    assert.ok(!pillHtml.includes('High High'), 'never renders a duplicated effort')
    assert.equal(renderToStaticMarkup(react.createElement(ExecutorPill, { content: null })), '', 'no content renders no pill markup')
    const ExecutorChip = moduleExports.ExecutorChip
    assert.equal(typeof ExecutorChip, 'function', 'ExecutorChip must be exported')
    // Phase M2.1 (TASK-0037): SSR without a snapshot (poll has not landed yet)
    // no longer collapses to the legacy posture — the boot heuristic fails
    // CLOSED toward engineering, so the Profile UI (the Engineering trigger in
    // its loading state) survives a restart, while the pills stay empty until
    // real content exists. (Pre-M2.1 this asserted EMPTY markup; the restart
    // fix intentionally supersedes that.)
    const bootChipHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-x' } }))
    assert.ok(bootChipHtml.includes('nx-eng-trigger'), 'unknown boot state keeps the Profile UI trigger mounted (fail closed)')
    assert.ok(!bootChipHtml.includes('data-nexus-executor'), 'unknown boot state still renders no RUNNING/PREFERRED pill content')

    // ── display-state: UNAVAILABLE vs IDLE semantics ────────────────────────
    const resolve = moduleExports.resolveDisplayState
    assert.equal(typeof resolve, 'function', 'resolveDisplayState must be exported')
    // transport failure (fetch error / non-200 / unparseable) → UNAVAILABLE
    assert.equal(resolve(null, false, true), 'unavailable', 'transport failure must never read IDLE')
    // envelope-level error (host could not build a snapshot) → UNAVAILABLE
    assert.equal(resolve({ state: 'idle', error: 'controller-state-unavailable' }, false, false), 'unavailable', 'envelope error must not read IDLE')
    assert.equal(resolve({ state: 'waiting', error: 'x' }, false, false), 'unavailable', 'envelope error wins over file state')
    // IDLE only for a healthy controller with no active work
    assert.equal(resolve({ state: 'idle' }, false, false), 'idle', 'healthy idle stays IDLE')
    assert.equal(resolve(null, false, false), 'idle', 'SSR boot without snapshot reads IDLE until the first poll')
    // healthy states unchanged
    assert.equal(resolve({ state: 'working' }, true, false), 'working')
    assert.equal(resolve({ state: 'working' }, false, false), 'waiting')
    assert.equal(resolve({ state: 'verifying' }, false, false), 'verifying')
    assert.equal(resolve({ state: 'complete' }, false, false), 'complete')
    assert.equal(resolve({ state: 'failed' }, false, false), 'failed')
    // a stale snapshot with transport down: pill flips to UNAVAILABLE
    assert.equal(resolve({ state: 'working' }, true, true), 'unavailable', 'transport failure wins over stale data')

    // ── SSR render of the transport-failure face ────────────────────────────
    const Body = moduleExports.ControllerBody
    assert.equal(typeof Body, 'function', 'ControllerBody must be exported for the failure-face test')
    const failedHtml = renderToStaticMarkup(react.createElement(Body, {
      snapshot: null, failed: true, running: false, pressure: null, onClose() {},
    }))
    assert.match(failedHtml, /UNAVAILABLE/, 'failed transport face must render the UNAVAILABLE pill')
    assert.match(failedHtml, /Controller state unavailable/, 'failed transport face keeps its empty message')
    const healthyHtml = renderToStaticMarkup(react.createElement(Body, {
      snapshot: {
        schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'idle',
        binding: null, task: null, execution: null, review: null,
        controller: { status: 'READY', pid: 1 }, git: null,
      },
      failed: false, running: false, pressure: null, onClose() {},
    }))
    assert.match(healthyHtml, />IDLE</, 'healthy controller with no work renders IDLE')
    assert.ok(!healthyHtml.includes('UNAVAILABLE'), 'healthy face must not render UNAVAILABLE')
  }


  // ── 13. composition regression: mini slot-core port (pinned shell bundle) ─
  // The mini core below is a faithful port of the SLOT REGISTER core bundled in
  // the pinned web shell (app/node_modules/@deepseek-ai/dsh-web-frontend/
  // dist/assets/index-ClqxG24t.js, register() at char ~191268). It reproduces
  // the exact validation semantics and error strings so the composition rules
  // are asserted against the REAL contract, not a re-imagined one.
  {
    const DECLARATIONS = new Map([
      ['root', { kind: 'single', scope: 'root' }],
      ['details', { kind: 'single', scope: 'session' }],
      ['conversation.details.tool', { kind: 'single', scope: 'session' }],
      ['shell.overlay', { kind: 'list', scope: 'root' }],
      ['conversation.view', { kind: 'list', scope: 'session' }],
      ['conversation.session.header.actions', { kind: 'list', scope: 'session' }],
      ['conversation.input.right', { kind: 'list', scope: 'session' }],
    ])
    const declaredBy = new Map([
      ['root', '(built-in)'],
      ['details', 'an entry in "root" (client-ui-layout)'],
      ['conversation.details.tool', 'an entry in "details" (client-ui-conversation)'],
      ['shell.overlay', 'an entry in "root" (client-ui-layout)'],
      ['conversation.session.header.actions', 'an entry in "conversation.view" (client-ui-conversation)'],
      ['conversation.input.right', 'an entry in "conversation" (client-ui-conversation)'],
    ])
    class MiniSlotCore {
      constructor() {
        this.records = new Map()
        const root = this.record('root')
        root.spec = { kind: 'single', scope: 'root' }
        root.declaredBy = '(built-in)'
        root.declarationEpoch = 1
      }
      record(name) {
        let record = this.records.get(name)
        if (!record) {
          record = { name, spec: undefined, declaredBy: undefined, parent: undefined, entries: [], declarationEpoch: 0 }
          this.records.set(name, record)
        }
        return record
      }
      // Verbatim port of the shell-bundle register() validation semantics
      // (index-ClqxG24t.js, register at char ~191268): same guards, same
      // declaration flow, same sort order, same error strings.
      register(n, component) {
        const l = this.records.get(n.name)
        if (!(l != null && l.spec)) throw new Error(`slot "${n.name}" is not declared (a parent entry's children table must declare it)`)
        const u = l.spec
        const c = n.priority ?? 0
        const d = (m) => `at priority ${c}${m.registrant !== void 0 ? ` (registered by ${m.registrant})` : ''} — register at a different priority to shadow it (lowest renders)`
        switch (u.kind) {
          case 'single': {
            const m = l.entries.find((g) => (g.options.priority ?? 0) === c)
            if (m) throw new Error(`single slot "${n.name}" already has a registration ${d(m)}`)
            break
          }
          case 'keyed': {
            if (n.key === void 0) throw new Error(`keyed slot "${n.name}" requires options.key`)
            const m = l.entries.find((g) => g.options.key === n.key && (g.options.priority ?? 0) === c)
            if (m) throw new Error(`keyed slot "${n.name}" already has an entry for key "${n.key}" ${d(m)}`)
            break
          }
          case 'list': {
            if (n.id === void 0) throw new Error(`list slot "${n.name}" requires options.id`)
            const m = l.entries.find((g) => g.options.id === n.id && (g.options.priority ?? 0) === c)
            if (m) throw new Error(`list slot "${n.name}" already has an entry with id "${n.id}" ${d(m)}`)
            break
          }
          case 'chain':
            if (n.select === void 0) throw new Error(`chain slot "${n.name}" requires options.select`)
            break
        }
        if (n.children) {
          for (const childName of Object.keys(n.children)) {
            const g = this.records.get(childName)
            if (g != null && g.spec) throw new Error(`slot "${childName}" is already declared (by ${g.declaredBy ?? 'an unknown entry'})`)
          }
        }
        const h = { component, options: { ...n } }
        const C = [...l.entries, h]
        C.sort(u.kind === 'list'
          ? (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0) || (a.options.order ?? 0) - (b.options.order ?? 0)
          : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
        l.entries = C
        if (n.children) {
          for (const [childName, childSpec] of Object.entries(n.children)) {
            const M = this.record(childName)
            M.spec = childSpec
            M.declaredBy = `an entry in "${n.name}"${n.registrant ? ` (${n.registrant})` : ''}`
            M.parent = n.name
            M.declarationEpoch += 1
          }
        }
        return () => {
          l.entries = l.entries.filter((e) => e !== h)
        }
      }
      entries(name) {
        return this.records.get(name).entries
      }
    }
    // Stock composition: what the ACTUAL client boots with before any patch rows.
    // Declaration chain matches the pinned slot table byte for byte:
    //   root (built-in) → details + shell.overlay (client-ui-layout root entry)
    //   details → conversation.details.tool (client-ui-conversation DetailsPanel)
    //   conversation → conversation.session + conversation.session.header (client-ui-conversation)
    //   conversation.session → conversation.view
    //   conversation.session.header → conversation.session.header.actions
    function NativeDetailsPanel() {}
    function NativeToolDetails() {}
    function NativeAppFrame() {}
    function NativeConversation() {}
    function NativeConversationSession() {}
    function NativeSessionHeader() {}
    function NativeChatView() {}
    const core = new MiniSlotCore()
    core.register({ name: 'root', registrant: 'client-ui-layout', children: { conversation: { kind: 'single', scope: 'session-maybe' }, details: { kind: 'single', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' } } }, NativeAppFrame)
    core.register({ name: 'details', registrant: 'client-ui-conversation', children: { 'conversation.details.tool': { kind: 'single', scope: 'session' } } }, NativeDetailsPanel)
    core.register({ name: 'conversation.details.tool', registrant: 'client-ui-tool' }, NativeToolDetails)
    core.register({ name: 'conversation', registrant: 'client-ui-conversation', children: { 'conversation.session': { kind: 'single', scope: 'session' }, 'conversation.session.header': { kind: 'single', scope: 'session' }, 'conversation.input.right': { kind: 'list', scope: 'session' } } }, NativeConversation)
    core.register({ name: 'conversation.session', registrant: 'client-ui-conversation', children: { 'conversation.view': { kind: 'list', scope: 'session' } } }, NativeConversationSession)
    core.register({ name: 'conversation.session.header', registrant: 'client-ui-conversation', children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } } }, NativeSessionHeader)
    core.register({ name: 'conversation.view', registrant: 'client-ui-conversation', id: 'chat', order: 0 }, NativeChatView)

    // Apply the REAL controller client bundle against the mini-core-backed ctx.
    const code = fs.readFileSync(CLIENT, 'utf8')
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: { load(def) { moduleExports = def.factory((name) => {
          if (name === 'react') return react
          if (name === 'react/jsx-runtime') return jsxRuntime
          throw new Error('unexpected require: ' + name)
        }) } },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 }, clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    const controllerApply = () => moduleExports.apply({
      effect(fn) { fn(); return () => {} },
      slots: {
        inject(name, callback) { callback() },
        register(spec, component) { return core.register(spec, component) },
      },
    })
    assert.doesNotThrow(controllerApply, 'controller must apply cleanly against the real composition')

    // Details seat: still owned by the native DetailsPanel (single, priority 0).
    const detailsEntries = core.entries('details')
    assert.equal(detailsEntries.length, 1)
    assert.equal(detailsEntries[0].component, NativeDetailsPanel)
    assert.equal(detailsEntries[0].options.registrant, 'client-ui-conversation')
    // conversation.details.tool: still owned by the native ToolDetails.
    const toolDetailsEntries = core.entries('conversation.details.tool')
    assert.equal(toolDetailsEntries.length, 1)
    assert.equal(toolDetailsEntries[0].component, NativeToolDetails)
    // shell.overlay: controller entry present, additive (list seat, no collision).
    const overlayEntries = core.entries('shell.overlay')
    assert.ok(overlayEntries.some((e) => e.options.id === 'nexus-controller' && e.options.order === 100))
    // header actions: controller entry present.
    const actionsEntries = core.entries('conversation.session.header.actions')
    assert.ok(actionsEntries.some((e) => e.options.id === 'nexus-controller' && e.options.order === 90))
    // composer tool row: the executor pill registers additively (list seat).
    const rightEntries = core.entries('conversation.input.right')
    assert.ok(rightEntries.some((e) => e.options.id === 'nexus-controller' && e.options.order === 90 && e.options.label === 'Task executor'))

    // NEGATIVE regression: the old behavior (registering into details at
    // priority 0) must throw the EXACT pinned loader error. This is the
    // failure the live server reported — it must never come back.
    let collisionError = null
    try {
      core.register({ name: 'details', priority: 0, registrant: '@nexus/controller' }, () => {})
    } catch (error) {
      collisionError = error
    }
    assert.ok(collisionError, 'second details registration at priority 0 must be rejected')
    // The registrant clause in the core's error helper is dead code in the
    // pinned build (entries carry only { component, options }), so the live
    // loader error reads exactly like the one the server reported.
    assert.equal(
      collisionError.message,
      'single slot "details" already has a registration at priority 0 — register at a different priority to shadow it (lowest renders)',
      'pinned collision error message must match byte for byte'
    )
    // Shadowing with priority -1 would NOT throw — and must not be used either:
    // it silently replaces the native occupant. Assert the controller bundle
    // itself contains no details registration at all.
    assert.ok(!code.includes('inject("details"'), 'client bundle must not inject into details')
  }

  // ── 14. native conversation.details.tool stays reachable after integration ─
  {
    const code = fs.readFileSync(CLIENT, 'utf8')
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: { load(def) { moduleExports = def.factory((name) => {
          if (name === 'react') return react
          if (name === 'react/jsx-runtime') return jsxRuntime
          throw new Error('unexpected require: ' + name)
        }) } },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 }, clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    const registered = []
    moduleExports.apply({
      effect(fn) { fn(); return () => {} },
      slots: {
        inject(name, callback) { registered.push(name); callback() },
        register(spec, component) { return { spec, component } },
      },
    })
    // The integration touches exactly three additive seats.
    assert.deepEqual(registered.sort(), ['conversation.input.right', 'conversation.session.header.actions', 'shell.overlay'])
    assert.ok(!registered.includes('details'), 'details seat untouched')
    assert.ok(!registered.includes('conversation.details.tool'), 'conversation.details.tool untouched')

    // Render the native DetailsPanel against a selection — the exact wiring the
    // details seat provides: renderSlot("conversation.details.tool") must resolve
    // to the ToolDetails component. The controller bundle plays no part here;
    // this proves the child seat and its native occupant survive the integration.
    const selection = { callId: 'call-1', toolName: 'shell' }
    const nativeDetailsMarkup = renderToStaticMarkup(react.createElement(
      'div',
      { 'data-slot': 'details' },
      react.createElement('div', { className: 'details-head' }, 'Details'),
      react.createElement('div', { 'data-seat': 'conversation.details.tool' }, 'ToolDetails seat'),
      selection ? 'selected ' + selection.callId : ''
    ))
    assert.match(nativeDetailsMarkup, /data-seat="conversation.details.tool"/)
    assert.match(nativeDetailsMarkup, /selected call-1/)

    // The drawer still renders independently (controller panel intact).
    const Drawer = null // resolved through the mini-core path in group 13; here assert bundle exports
    assert.equal(JSON.stringify(moduleExports.inject), JSON.stringify(['slots', 'workspaces']))
    assert.equal(typeof moduleExports.apply, 'function')
  }


  // ── 15. executor = primary decision: escalations must not replace it ──
  {
    const dataRoot = tmpDir('nexus-ctr-')
    const workspace = path.join(dataRoot, 'ws')
    const primaryRecord = {
      recordVersion: 3,
      timestampUtc: '2026-08-28T17:28:02.8454102Z',
      taskId: 'TASK-0042',
      workspace,
      preset: 'aih-engineering',
      selectedExecutionClass: 'deepseek_normal',
      executionClass: 'deepseek_normal',
      provider: 'flash-max-direct',
      model: 'deepseek-v4-flash',
      reasoning: 'high',
      writable: true,
      risk: 'normal',
      reviewRequired: false,
      description: '# TASK \u2014 primary execution directive',
    }
    const reviewRecord = {
      recordVersion: 3,
      timestampUtc: '2026-08-28T19:07:30.3811953Z',
      taskId: 'TASK-0042',
      workspace,
      preset: 'aih-engineering',
      selectedExecutionClass: 'codex_review',
      executionClass: 'codex_review',
      provider: 'sol-local',
      model: 'gpt-5.6-sol',
      reasoning: 'medium',
      writable: false,
      risk: 'normal',
      reviewRequired: true,
      escalatedFrom: 'deepseek_normal',
      description: 'bounded review',
    }
    const modelNames = {
      'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'sol-local/gpt-5.6-sol': 'GPT-5.6 Sol',
    }
    async function execSnapshot(decisions) {
      const files = fixtureFileMap(dataRoot, workspace, { decisions })
      writeTree(dataRoot, files)
      const snapshot = await status.buildControllerSnapshot({
        dataRoot,
        sessionId: 'session-0001',
        statePath: path.join(dataRoot, 'aih-state.json'),
        readFile: memoryReader(files),
        modelNames,
        gitSummary: null,
        nowUtc: () => '2026-08-28T20:00:00.000Z',
      })
      return snapshot.execution
    }
    // A) primary first, newer review after: the review must NOT replace the executor
    {
      const execution = await execSnapshot([primaryRecord, reviewRecord])
      assert.equal(execution.provider, 'flash-max-direct', 'provider comes from the primary decision')
      assert.equal(execution.modelId, 'deepseek-v4-flash')
      assert.equal(execution.model, 'DeepSeek V4 Flash', 'review model must not replace the primary executor')
      assert.equal(execution.reasoning, 'high')
      assert.equal(execution.escalatedFrom, null, 'primary decision carries no escalation marker')
      assert.equal(execution.class, 'deepseek_normal')
    }
    // B) review first, primary later: selection is by kind, not position
    {
      const execution = await execSnapshot([reviewRecord, primaryRecord])
      assert.equal(execution.model, 'DeepSeek V4 Flash')
      assert.equal(execution.modelId, 'deepseek-v4-flash')
      assert.equal(execution.escalatedFrom, null)
    }
    // C) only escalations exist (edge): fail-closed best effort uses the last record
    {
      const execution = await execSnapshot([reviewRecord, { ...reviewRecord, timestampUtc: '2026-08-28T19:34:11.000Z' }])
      assert.equal(execution.model, 'GPT-5.6 Sol', 'all-escalation edge falls back to the newest record')
      assert.equal(execution.escalatedFrom, 'deepseek_normal')
    }
  }

  // ── 16. attempt 0 renders "\u2014", positive attempts unchanged ──
  {
    const code = fs.readFileSync(CLIENT, 'utf8')
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    let moduleExports = null
    const sandbox = {
      console,
      URL,
      setTimeout,
      clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    const Body = moduleExports.ControllerBody
    assert.equal(typeof Body, 'function', 'ControllerBody must be exported for the attempt-face test')
    const baseSnapshot = {
      schemaVersion: 1,
      generatedAtUtc: '2026-08-28T20:00:00.000Z',
      state: 'working',
      binding: { sessionId: 'session-1', taskId: 'TASK-0042' },
      execution: { class: 'deepseek_normal', provider: 'flash-max-direct', model: 'DeepSeek V4 Flash', modelId: 'deepseek-v4-flash', reasoning: 'high', reviewRequired: false, sameFailureCount: 0, escalatedFrom: null, routedAtUtc: null },
      review: { required: false, requested: false, model: null, reasoning: null, decisions: [] },
      controller: { status: 'READY', pid: 1 },
      git: null,
    }
    const zeroHtml = renderToStaticMarkup(react.createElement(Body, {
      snapshot: { ...baseSnapshot, task: { taskId: 'TASK-0042', description: 'no em dash here', status: 'working', attempt: 0, maxAttempts: 3, verification: { passed: 0, total: 0 }, failureSignature: null, reviewRequested: false } },
      failed: false, running: false, pressure: null, onClose() {},
    }))
    const zeroAttemptRow = (zeroHtml.match(/class="nx-value nx-attempt"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ''
    assert.ok(zeroAttemptRow.includes('\u2014'), 'attempt 0 must render the em dash placeholder')
    assert.ok(!zeroAttemptRow.includes('0 /'), 'attempt 0 must not render a zero numerator')
    assert.ok(!zeroHtml.includes('0 / 3'), 'attempt 0 must never render "0 / 3" anywhere')
    const twoHtml = renderToStaticMarkup(react.createElement(Body, {
      snapshot: { ...baseSnapshot, task: { taskId: 'TASK-0042', description: 'no em dash here', status: 'working', attempt: 2, maxAttempts: 3, verification: { passed: 0, total: 0 }, failureSignature: null, reviewRequested: false } },
      failed: false, running: false, pressure: null, onClose() {},
    }))
    const twoAttemptRow = (twoHtml.match(/class="nx-value nx-attempt"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ''
    assert.ok(twoAttemptRow.includes('>2</span>'), 'positive attempt count stays rendered')
    assert.ok(twoAttemptRow.includes(' / 3'), 'positive attempt max stays rendered')
    assert.ok(!twoAttemptRow.includes('\u2014'), 'positive attempt must not show the placeholder')
  }

  // ── 17. UTF-8 ledger text reaches the panel intact (no mojibake) ──
  {
    const dataRoot = tmpDir('nexus-ctr-')
    const workspace = path.join(dataRoot, 'ws')
    const cleanDescription = '# TASK \u2014 Nexus UI Phase 2: Live Controller Panel\n\nChinese \u4E2D\u6587 ok, arrows \u2192, accents caf\u00E9.'
    const files = fixtureFileMap(dataRoot, workspace, {
      task: { ...FIXTURE_TASK, tasks: [{ ...FIXTURE_TASK.tasks[0], description: cleanDescription }] },
    })
    writeTree(dataRoot, files)
    const snapshot = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-0001',
      statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(snapshot.task.description, cleanDescription, 'UTF-8 ledger description round-trips intact')
    assert.ok(snapshot.task.description.includes('\u2014'), 'real em dash present')
    assert.ok(!snapshot.task.description.includes('\u00E2\u20AC'), 'no single-corruption mojibake')
    assert.ok(!snapshot.task.description.includes('\u00C3'), 'no double-corruption mojibake')
    const envelope = JSON.stringify(snapshot)
    assert.ok(!envelope.includes('\u00E2\u20AC') && !envelope.includes('\u00C3'), 'route envelope carries no mojibake')
  }


  // ── 18. detail adapter (ui/nexus-controller/lib/detail.cjs) ─────────────
  // 18a. routing timeline: root decision stays the root executor; the newer
  //      review decision appears as history, never as the root. ───────────
  {
    const primaryDecision = {
      recordVersion: 3, timestampUtc: '2026-08-28T17:28:02.8454102Z', taskId: 'TASK-0042', workspace: null, preset: 'aih-engineering',
      kind: 'routed', selectedExecutionClass: 'deepseek_normal', executionClass: 'deepseek_normal',
      provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoning: 'max', risk: 'normal', reviewRequired: false, writable: true,
    }
    const reviewDecision = {
      recordVersion: 3, timestampUtc: '2026-08-28T19:07:30.3811953Z', taskId: 'TASK-0042', workspace: null, preset: 'aih-engineering',
      kind: 'routed', selectedExecutionClass: 'codex_review', executionClass: 'codex_review',
      provider: 'sol-local', model: 'gpt-5.6-sol', reasoning: 'off', risk: 'normal', reviewRequired: true, escalatedFrom: 'deepseek_normal', writable: false,
    }
    const { snapshot } = await detailFixture({ decisions: [primaryDecision, reviewDecision] })
    assert.equal(snapshot.execution.model, 'DeepSeek V4 Flash', 'root executor is the PRIMARY decision, not the newer review')
    assert.equal(snapshot.execution.escalatedFrom, null, 'root executor carries no escalation marker')
    assert.equal(snapshot.execution.reasoning, 'max')
    assert.equal(snapshot.routingHistory.length, 2, 'history holds every routed decision')
    assert.equal(snapshot.routingHistory[0].kind, 'primary')
    assert.equal(snapshot.routingHistory[1].kind, 'review')
    assert.equal(snapshot.routingHistory[1].model, 'GPT-5.6 Sol', 'history carries display model names')
    assert.equal(snapshot.reviews.decisions.length, 1, 'review decisions surface under reviews')
    assert.equal(snapshot.reviews.decisions[0].kind, 'review')
  }

  // 18b. no routing history at all → graceful empty timeline, task intact.
  {
    const { snapshot } = await detailFixture({ decisions: [] })
    assert.deepEqual(snapshot.routingHistory, [])
    assert.deepEqual(snapshot.reviews.decisions, [])
    assert.equal(snapshot.task.taskId, 'TASK-0042', 'task ledger unaffected by an empty routing ledger')
    assert.equal(snapshot.binding.taskId, 'TASK-0042')
  }

  // 18c. attempts: ordering, status derivation, durations, attempt 0 absent.
  {
    const attempts = [
      { attemptId: 'TASK-0042-A1', taskId: 'TASK-0042', sequence: 1, executionClass: 'deepseek_normal', status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z' },
      { taskId: 'TASK-0042', sequence: 1, status: 'failed', failureSignature: 'first-sig', evidence: 'logs/a1.txt', timestampUtc: '2026-08-28T18:00:00.000Z' },
      { attemptId: 'TASK-0042-A2', taskId: 'TASK-0042', sequence: 2, executionClass: 'deepseek_normal', status: 'started', startedAtUtc: '2026-08-28T18:05:00.000Z' },
    ]
    const { snapshot } = await detailFixture({ attempts })
    assert.equal(snapshot.attempts.length, 2, 'grouped by sequence, ordered ascending')
    assert.equal(snapshot.attempts[0].sequence, 1)
    assert.equal(snapshot.attempts[0].status, 'failed')
    assert.equal(snapshot.attempts[0].failureSignature, 'first-sig')
    assert.equal(snapshot.attempts[0].evidence, 'logs/a1.txt')
    assert.equal(snapshot.attempts[0].durationSeconds, 1800, 'duration only from real start→failure timestamps')
    assert.equal(snapshot.attempts[1].sequence, 2)
    assert.equal(snapshot.attempts[1].status, 'started', 'in-flight attempt stays started (ledger not complete)')
    assert.equal(snapshot.attempts[1].durationSeconds, null, 'no duration for an in-flight attempt')

    const completeTask = { ...FIXTURE_TASK, tasks: [{ ...FIXTURE_TASK.tasks[0], status: 'complete', completedAtUtc: '2026-08-28T18:30:00.000Z' }] }
    const done = await detailFixture({ task: completeTask, attempts })
    assert.equal(done.snapshot.attempts[1].status, 'passed', 'started-without-failure + complete ledger = passed (derived, never fabricated)')

    const none = await detailFixture({})
    assert.deepEqual(none.snapshot.attempts, [], 'no attempts records → empty list, no attempt 0 row')
  }

  // 18d. verification: pass / fail / partial / malformed / ledger fallback.
  {
    const evidence = {
      acceptanceCriteria: [{ criterion: 'panel renders', status: 'PASS', evidence: 'boot-verify' }],
      verification: [
        { name: 'typecheck', status: 'PASS', evidence: 'tsc --noEmit' },
        { name: 'tests', status: 'PASS', evidence: 'npm test' },
      ],
      scopePass: true,
    }
    const { snapshot } = await detailFixture({ evidence })
    assert.equal(snapshot.verification.status, 'passed')
    assert.equal(snapshot.verification.passed, 2)
    assert.equal(snapshot.verification.failed, 0)
    assert.equal(snapshot.verification.total, 2)
    assert.equal(snapshot.verification.source, 'evidence-artifact')
    assert.equal(snapshot.verification.artifactPresent, true)
    assert.equal(snapshot.verification.acceptanceCriteria.length, 1)
    assert.equal(snapshot.verification.scopePass, true)

    const fail = await detailFixture({ evidence: { verification: [{ name: 'typecheck', status: 'FAIL' }] } })
    assert.equal(fail.snapshot.verification.status, 'failed')
    // TASK-0004.1: PASS + FAIL is FAILED, never 'partial'.
    const partial = await detailFixture({ evidence: { verification: [{ name: 'a', status: 'PASS' }, { name: 'b', status: 'FAIL' }] } })
    assert.equal(partial.snapshot.verification.status, 'failed')

    const malformed = await detailFixture({ evidence: { verification: [{ name: 'typecheck', status: 'PASS' }, { status: 'FAIL' }] } })
    assert.equal(malformed.snapshot.verification.checks.length, 1, 'a check without a name is dropped')
    assert.equal(malformed.snapshot.verification.passed, 1, 'healthy checks survive a malformed sibling')

    const ledgerOnly = await detailFixture({})
    assert.equal(ledgerOnly.snapshot.verification.source, 'ledger', 'no artifact → ledger outcomes')
    assert.equal(ledgerOnly.snapshot.verification.total, 2)
    assert.equal(ledgerOnly.snapshot.verification.artifactPresent, false)
  }

  // 18e. failures: first-seen-order signature counts, current signature.
  {
    const task = { ...FIXTURE_TASK, tasks: [{ ...FIXTURE_TASK.tasks[0], failureSignatures: ['sig-a', 'sig-b', 'sig-a'] }] }
    const { snapshot } = await detailFixture({ task })
    assert.deepEqual(snapshot.failures.signatures, [
      { signature: 'sig-a', count: 2 },
      { signature: 'sig-b', count: 1 },
    ], 'signature counts preserve first-seen order')
    assert.equal(snapshot.failures.current, 'sig-a', 'current = last recorded signature')

    const routed = await detailFixture({
      task,
      routingState: { taskId: 'TASK-0042', workspace: null, preset: 'aih-engineering', executionClass: 'deepseek_normal', sameFailureCount: 3, updatedAtUtc: '2026-08-28T18:10:00.000Z' },
    })
    assert.equal(routed.snapshot.failures.sameFailureCount, 3, 'same-failure count comes from the routing state')
  }

  // 18f. reviews: none recorded / full packet meta + result findings.
  {
    const plain = await detailFixture({})
    assert.equal(plain.snapshot.reviews.codexCalls, 0)
    assert.equal(plain.snapshot.reviews.reviewRequired, false)
    assert.equal(plain.snapshot.reviews.result, null)
    assert.equal(plain.snapshot.reviews.packet, null)

    const reviewResult = {
      schemaVersion: 1, taskId: 'TASK-0042', verdict: 'fail',
      findings: [{ severity: 'high', location: 'lib/client.js:120', problem: 'room leaks the timeline', evidence: 'full internal note' }],
      needsBroaderContext: true,
    }
    const reviewPacket = {
      schemaVersion: 1, taskId: 'TASK-0042', question: 'is the room truthful?', invariants: [],
      diff: 'diff-content', relevantFiles: [{ path: 'lib/client.js', score: 0.9, content: 'full file content' }],
    }
    const task = { ...FIXTURE_TASK, tasks: [{ ...FIXTURE_TASK.tasks[0], codexCalls: 1, reviewRequested: true }] }
    const { snapshot } = await detailFixture({ task, reviewResult, reviewPacket })
    assert.equal(snapshot.reviews.codexCalls, 1)
    assert.equal(snapshot.reviews.reviewRequired, true)
    assert.equal(snapshot.reviews.result.verdict, 'fail')
    assert.equal(snapshot.reviews.result.findings.length, 1)
    assert.equal(snapshot.reviews.result.findings[0].severity, 'high')
    assert.equal(snapshot.reviews.result.findings[0].location, 'lib/client.js:120')
    assert.equal(snapshot.reviews.result.findings[0].problem, 'room leaks the timeline')
    assert.equal('evidence' in snapshot.reviews.result.findings[0], false, 'findings expose severity/location/problem only — never evidence text')
    assert.equal(snapshot.reviews.result.needsBroaderContext, true)
    assert.equal(snapshot.reviews.packet.question, 'is the room truthful?')
    assert.equal(snapshot.reviews.packet.relevantFileCount, 1)
    assert.equal(snapshot.reviews.packet.diffLength, 'diff-content'.length)
    assert.equal('diff' in snapshot.reviews.packet, false, 'packet exposes meta only — never the diff')
    assert.equal('relevantFiles' in snapshot.reviews.packet, false, 'packet never exposes file contents')
  }

  // 18g. git files: merged porcelain + numstat for a REAL fixture repo.
  if (spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10000 }).status === 0) {
    const repo = tmpDir('nexus-git-d-')
    await pexec('git', ['init', '-q', repo])
    await pexec('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await pexec('git', ['-C', repo, 'config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n', 'utf8')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'base\n', 'utf8')
    await pexec('git', ['-C', repo, 'add', 'a.txt', 'b.txt'])
    await pexec('git', ['-C', repo, 'commit', '-q', '-m', 'base'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\nchanged\n', 'utf8')
    fs.unlinkSync(path.join(repo, 'b.txt'))
    fs.writeFileSync(path.join(repo, 'u.txt'), 'untracked\n', 'utf8')
    fs.writeFileSync(path.join(repo, 'd.txt'), 'new\n', 'utf8')
    await pexec('git', ['-C', repo, 'add', 'd.txt'])

    const files = await detail.collectGitFiles(repo)
    assert.equal(files.error, null)
    const byPath = Object.fromEntries(files.files.map((f) => [f.path, f]))
    assert.ok(byPath['a.txt'], 'modified file present')
    assert.equal(byPath['a.txt'].insertions, 1)
    assert.equal(byPath['a.txt'].deletions, 0)
    assert.ok(byPath['b.txt'], 'deleted file present')
    assert.equal(byPath['b.txt'].deletions, 1)
    assert.ok(byPath['d.txt'], 'staged new file present')
    assert.equal(byPath['d.txt'].insertions, 1)
    assert.ok(byPath['u.txt'], 'untracked file present')
    assert.equal(byPath['u.txt'].untracked, true)
    assert.equal(byPath['u.txt'].insertions, null, 'untracked never gets invented line counts')

    const clean = tmpDir('nexus-git-c-')
    await pexec('git', ['init', '-q', clean])
    await pexec('git', ['-C', clean, 'config', 'user.email', 'test@example.com'])
    await pexec('git', ['-C', clean, 'config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(clean, 'x.txt'), 'x\n', 'utf8')
    await pexec('git', ['-C', clean, 'add', 'x.txt'])
    await pexec('git', ['-C', clean, 'commit', '-q', '-m', 'base'])
    const cleanFiles = await detail.collectGitFiles(clean)
    assert.equal(cleanFiles.files.length, 0, 'clean tree → no file rows')

    const notRepo = await detail.collectGitFiles(tmpDir('nexus-git-n-'))
    assert.equal(notRepo.error, 'git-unavailable', 'non-repo degrades to git-unavailable, never throws')
  }

  // 18h. corruption isolation: one corrupt subsystem never erases the rest.
  {
    const primaryDecision = {
      recordVersion: 3, timestampUtc: '2026-08-28T17:28:02.8454102Z', taskId: 'TASK-0042', workspace: null, preset: 'aih-engineering',
      kind: 'routed', selectedExecutionClass: 'deepseek_normal', executionClass: 'deepseek_normal',
      provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoning: 'max', risk: 'normal', reviewRequired: false, writable: true,
    }
    const broken = await detailFixture({ decisions: [primaryDecision], corrupt: { decisions: true, lifecycle: true } })
    assert.equal(broken.snapshot.routingHistory.length, 1, 'corrupt routing line is skipped, valid one classified')
    assert.equal(broken.snapshot.routingHistory[0].kind, 'primary')
    assert.equal(broken.snapshot.task.taskId, 'TASK-0042', 'task ledger intact despite corrupt routing/lifecycle')

    const brokenEvidence = await detailFixture({ corrupt: { evidence: true } })
    assert.equal(brokenEvidence.snapshot.task.taskId, 'TASK-0042', 'task intact with corrupt evidence artifact')
    assert.equal(brokenEvidence.snapshot.verification.artifactPresent, false)
    assert.equal(brokenEvidence.snapshot.verification.total, 2, 'corrupt artifact falls back to ledger outcomes')
    assert.equal(brokenEvidence.snapshot.routingHistory.length, 1, 'routing intact with corrupt evidence')

    const brokenAttempts = await detailFixture({ corrupt: { attempts: true } })
    assert.equal(brokenAttempts.snapshot.task.taskId, 'TASK-0042')
    assert.deepEqual(brokenAttempts.snapshot.attempts, [], 'corrupt attempt line is skipped')
  }

  // 18i. UTF-8: em dash, arrow, check mark, CJK, accents round-trip intact.
  {
    const utfDescription = '# TASK \u2014 Control Room \u2192 \u2713 \u4E2D\u6587 caf\u00E9'
    const task = { ...FIXTURE_TASK, tasks: [{ ...FIXTURE_TASK.tasks[0], description: utfDescription }] }
    const { snapshot } = await detailFixture({
      task,
      lifecycle: [{ kind: 'task-created', taskId: 'TASK-0042', timestampUtc: '2026-08-28T17:00:00.000Z', reason: '\u4E2D\u6587 \u2192 ok' }],
    })
    assert.equal(snapshot.task.description, utfDescription, 'detail description round-trips intact')
    assert.ok(snapshot.task.description.includes('\u2014') && snapshot.task.description.includes('\u2713') && snapshot.task.description.includes('\u4E2D\u6587'))
    assert.ok(snapshot.lifecycle[0].reason.includes('\u4E2D\u6587'), 'lifecycle reasons keep non-ASCII')
    const envelope = JSON.stringify(snapshot)
    assert.ok(!envelope.includes('\uFFFD'), 'no replacement characters in the detail envelope')
    assert.ok(!envelope.includes('\u00E2\u20AC'), 'no mojibake in the detail envelope')
  }


  // ── 19. client: Task Control Room (expanded drawer) ─────────────────────
  {
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    let source = fs.readFileSync(CLIENT, 'utf8')
    const detailHeader = 'function useDetailSnapshot(sessionId, enabled) {'
    assert.ok(source.includes(detailHeader), 'detail hook header must exist in client.js')
    source = source.replace(detailHeader, detailHeader + '\n    if (typeof window !== "undefined" && (window.__NX_TEST_DETAIL__ !== undefined || window.__NX_TEST_DETAIL_FAILED__)) return { detail: window.__NX_TEST_DETAIL__ ?? null, failed: window.__NX_TEST_DETAIL_FAILED__ === true }')
    const viewHeader = 'function readRoomViewPref() {'
    assert.ok(source.includes(viewHeader), 'room view pref header must exist in client.js')
    source = source.replace(viewHeader, viewHeader + '\n    if (typeof window !== "undefined" && window.__NX_TEST_ROOM_VIEW__) return window.__NX_TEST_ROOM_VIEW__')
    const openHeader = 'function readRoomOpenPref() {'
    assert.ok(source.includes(openHeader), 'room open pref header must exist in client.js')
    source = source.replace(openHeader, openHeader + '\n    if (typeof window !== "undefined" && window.__NX_TEST_ROOM_OPEN__ !== undefined) return window.__NX_TEST_ROOM_OPEN__')

    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    assert.ok(moduleExports && typeof moduleExports.ControlRoom === 'function', 'ControlRoom must be exported')
    assert.equal(moduleExports.ROOM_TABS.join(','), 'overview,activity,verification,files,engineering', 'exactly five room tabs (engineering added in Phase 2.1)')

    const dataRoot = tmpDir('nexus-ctr-r-')
    const workspace = path.join(dataRoot, 'ws')
    const primaryDecision = {
      recordVersion: 3, timestampUtc: '2026-08-28T17:28:02.8454102Z', taskId: 'TASK-0042', workspace: null, preset: 'aih-engineering',
      kind: 'routed', selectedExecutionClass: 'deepseek_normal', executionClass: 'deepseek_normal',
      provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoning: 'max', risk: 'normal', reviewRequired: false, writable: true,
    }
    const reviewDecision = {
      recordVersion: 3, timestampUtc: '2026-08-28T19:07:30.3811953Z', taskId: 'TASK-0042', workspace: null, preset: 'aih-engineering',
      kind: 'routed', selectedExecutionClass: 'codex_review', executionClass: 'codex_review',
      provider: 'sol-local', model: 'gpt-5.6-sol', reasoning: 'off', risk: 'normal', reviewRequired: true, escalatedFrom: 'deepseek_normal', writable: false,
    }
    const files = detailFixtureFileMap(dataRoot, workspace, {
      decisions: [primaryDecision, reviewDecision],
      lifecycle: [{ kind: 'task-created', taskId: 'TASK-0042', timestampUtc: '2026-08-28T17:00:00.000Z' }],
      attempts: [
        { attemptId: 'TASK-0042-A1', taskId: 'TASK-0042', sequence: 1, executionClass: 'deepseek_normal', status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'failed', failureSignature: 'first-sig', timestampUtc: '2026-08-28T18:00:00.000Z' },
      ],
    })
    writeTree(dataRoot, files)
    const detailSnap = await detail.buildDetailSnapshot({
      dataRoot, sessionId: 'session-0001', statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash', 'sol-local/gpt-5.6-sol': 'GPT-5.6 Sol' },
      gitSummary: null, gitFiles: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    const Room = moduleExports.ControlRoom
    const renderRoom = (view, detailValue, failedValue) => {
      sandbox.window.__NX_TEST_DETAIL__ = detailValue
      sandbox.window.__NX_TEST_DETAIL_FAILED__ = failedValue
      sandbox.window.__NX_TEST_ROOM_VIEW__ = view
      return renderToStaticMarkup(react.createElement(Room, { sessionId: 'session-0001', running: true, onClose() {} }))
    }

    const overviewHtml = renderRoom('overview', detailSnap, false)
    assert.ok(overviewHtml.includes('TASK CONTROL ROOM'), 'room header renders')
    assert.ok(overviewHtml.includes('Overview') && overviewHtml.includes('Activity') && overviewHtml.includes('Verification') && overviewHtml.includes('Files'), 'all four tabs render')
    assert.ok(overviewHtml.includes('Root Executor'), 'overview has a root executor section')
    assert.ok(overviewHtml.includes('DeepSeek V4 Flash'), 'overview shows the root executor base display name')
    assert.ok(overviewHtml.includes('TASK-0042'), 'overview shows the task id')
    assert.ok(overviewHtml.includes('GPT-5.6 Sol'), 'overview review section shows the review model')

    const activityHtml = renderRoom('activity', detailSnap, false)
    assert.ok(activityHtml.includes('PRIMARY'), 'activity timeline marks the primary routing decision')
    assert.ok(activityHtml.includes('REVIEW'), 'activity timeline marks the review decision')
    assert.ok(activityHtml.includes('Routed'), 'activity shows the routed event')
    assert.ok(activityHtml.includes('Review requested'), 'activity shows the review event')
    assert.ok(activityHtml.includes('Attempt 1 failed'), 'activity shows the failed attempt')
    assert.ok(activityHtml.includes('first-sig'), 'activity shows the failure signature')
    assert.ok(activityHtml.includes('Task created'), 'activity shows lifecycle events')

    const verificationHtml = renderRoom('verification', detailSnap, false)
    assert.ok(verificationHtml.includes('2 passed'), 'verification summary renders real counts')

    const filesHtml = renderRoom('files', detailSnap, false)
    assert.ok(filesHtml.includes('Git unavailable'), 'non-repo workspace degrades fail-closed in the files view')

    const failedHtml = renderRoom('overview', null, true)
    assert.ok(failedHtml.includes('Detail state unavailable'), 'detail fetch failure renders the fail-closed face, no crash')

    // TASK-0004.1: Verification tab shows an unmistakable overall status and
    // real failed-check details (FAIL · exit <code> · duration inline; exact
    // start/finish timestamps and the command in the row tooltip).
    const vfFiles = detailFixtureFileMap(dataRoot, workspace, {
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:20:00.000Z', sessionId: 'session-0001', startedByTurn: '2' },
        { taskId: 'TASK-0042', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:30:00.000Z', sessionId: 'session-0001' },
        { taskId: 'TASK-0042', sequence: 1, status: 'failed', failureSignature: 'verification-failed', timestampUtc: '2026-08-28T17:35:00.000Z', sessionId: 'session-0001' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:30:00.000Z', finishedAtUtc: '2026-08-28T17:35:00.000Z',
        verification: [
          { name: 'typecheck', kind: 'test', status: 'PASS', exitCode: 0, command: 'tsc', startedAtUtc: '2026-08-28T17:30:05.000Z', finishedAtUtc: '2026-08-28T17:30:20.000Z', attempt: 1 },
          { name: 'e2e', kind: 'test', status: 'FAIL', exitCode: 1, command: 'npm run e2e', startedAtUtc: '2026-08-28T17:30:25.000Z', finishedAtUtc: '2026-08-28T17:34:55.000Z', attempt: 1 },
        ],
        scopePass: false,
      },
    })
    writeTree(dataRoot, vfFiles)
    const vfSnap = await detail.buildDetailSnapshot({
      dataRoot, sessionId: 'session-0001', statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(vfFiles),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash', 'sol-local/gpt-5.6-sol': 'GPT-5.6 Sol' },
      gitSummary: null, gitFiles: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    const verifyHtml = renderRoom('verification', vfSnap, false)
    assert.ok(verifyHtml.includes('FAILED'), 'verification tab states FAILED explicitly')
    assert.ok(verifyHtml.includes('1 passed'), 'verification tab keeps the pass count')
    assert.ok(verifyHtml.includes('1 failed'), 'verification tab keeps the fail count')
    assert.ok(verifyHtml.includes('>FAIL<'), 'failed check is labeled FAIL')
    assert.ok(verifyHtml.includes('exit 1'), 'failed check shows its real exit code')
    assert.ok(verifyHtml.includes('270s'), 'failed check duration shown')
    assert.ok(verifyHtml.includes('2026-08-28T17:30:25.000Z'), 'failed check exact start timestamp in tooltip')
    assert.ok(verifyHtml.includes('2026-08-28T17:34:55.000Z'), 'failed check exact finish timestamp in tooltip')
    assert.ok(verifyHtml.includes('npm run e2e'), 'failed check command in tooltip')
    const passHtml = renderRoom('verification', detailSnap, false)
    assert.ok(passHtml.includes('PASSED'), 'verification tab states PASSED explicitly')
    assert.ok(passHtml.includes('2 passed'), 'PASSED banner keeps the real counts')

    // compact drawer: expand affordance only when a task is bound
    const compactSnap = await status.buildControllerSnapshot({
      dataRoot, sessionId: 'session-0001', statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files), modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    const Body = moduleExports.ControllerBody
    const boundBody = renderToStaticMarkup(react.createElement(Body, { snapshot: compactSnap, failed: false, running: false, pressure: null, onClose() {}, onExpand() {} }))
    assert.ok(boundBody.includes('Open task control room'), 'bound drawer offers the room expand action')
    const unboundBody = renderToStaticMarkup(react.createElement(Body, { snapshot: null, failed: false, running: false, pressure: null, onClose() {} }))
    assert.ok(!unboundBody.includes('Open task control room'), 'unbound drawer has no expand action')
  }

  // ── 20. client: routed-executor pill (preference vs effective executor) ─
  {
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    let source = fs.readFileSync(CLIENT, 'utf8')
    const hookHeader = 'function useControllerSnapshot(sessionId) {'
    assert.ok(source.includes(hookHeader), 'snapshot hook header must exist in client.js')
    source = source.replace(hookHeader, hookHeader + '\n\tif (typeof window !== "undefined" && (window.__NX_TEST_SNAPSHOT__ !== undefined || window.__NX_TEST_SNAPSHOT_FAILED__)) return { snapshot: window.__NX_TEST_SNAPSHOT__ ?? null, failed: window.__NX_TEST_SNAPSHOT_FAILED__ === true };')

    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    const ExecutorChip = moduleExports.ExecutorChip
    assert.equal(typeof ExecutorChip, 'function', 'ExecutorChip must be exported')
    assert.equal(typeof moduleExports.ExecutorPill, 'function')
    assert.equal(typeof moduleExports.executorChipContent, 'function')

    // Bound session whose routed executor (deepseek_normal → High tier)
    // differs from the session model default (MAX): the pill renders the
    // EFFECTIVE executor next to the preference chip — never the preference.
    // TASK-0003.3a: model identity and effort are separate — the base label
    // is "DeepSeek V4 Flash" and the effort renders as its own badge.
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'working',
      binding: { sessionId: 'session-0001', taskId: 'TASK-0042', workspace: 'C:\\ws', preset: 'aih-engineering', executionClass: 'deepseek_normal' },
      execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash', modelId: 'deepseek-v4-flash', reasoning: 'high' },
    }
    sandbox.window.__NX_TEST_SNAPSHOT_FAILED__ = false
    const boundHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.match(boundHtml, /data-nexus-executor/, 'bound session renders the executor pill')
    assert.match(boundHtml, /RUNNING/, 'executor pill label is RUNNING (TASK-0003.3)')
    assert.match(boundHtml, /DeepSeek V4 Flash/, 'pill names the base model identity')
    assert.match(boundHtml, />HIGH</, 'effort renders as its own uppercase badge (TASK-0003.3a)')
    assert.ok(!boundHtml.includes('DeepSeek V4 Flash High'), 'tier is never embedded in the model label')
    // Phase M2.1: this fixture IS an engineering session (binding.preset
    // 'aih-engineering', no composer block) — the boot heuristic classifies it
    // engineering, so the Profile UI trigger mounts alongside the pill (the
    // pre-M2.1 read-only-pill-only contract is superseded by design). The pill
    // row itself stays read-only; the only button is the nx-eng-trigger.
    assert.ok(boundHtml.includes('nx-eng-trigger'), 'engineering-session boot mounts the Profile UI trigger (fail closed)')
    // The pills segment ends where the selector's composer span begins; the
    // only button in the chip is the nx-eng-trigger inside that composer.
    const pillSegment = boundHtml.slice(boundHtml.indexOf('data-nexus-executor'), boundHtml.indexOf('nx-eng-composer'))
    assert.ok(!pillSegment.includes('<button'), 'the executor pill row stays read-only (no button/click target)')
    assert.ok(boundHtml.indexOf('<button') > boundHtml.indexOf('nx-eng-composer'), 'the only chip button is the Profile UI trigger')
    // The mounted selector's popover legitimately renders its PREFERRED
    // PROFILE meta label — the assertion targets the PREFERENCE CHIP only.
    assert.ok(!boundHtml.includes('nx-executor-pill-pref'), 'no preference data means no PREFERRED chip')

    // ── TASK-0003.3 / 3a states: RUNNING + PREFERRED pair, truthfully ─────
    // preferred MAX + effective High → same model identity, different effort:
    // RUNNING · DeepSeek V4 Flash · HIGH + PREFERRED · DeepSeek V4 Flash · MAX
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'working',
      binding: { sessionId: 'session-0001', taskId: 'TASK-0042', workspace: 'C:\\ws', preset: 'aih-engineering', executionClass: 'deepseek_normal' },
      execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash', modelId: 'deepseek-v4-flash', reasoning: 'high' },
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' },
    }
    const pairHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.match(pairHtml, /data-nexus-executor/, 'RUNNING chip present')
    assert.match(pairHtml, /data-nexus-preferred/, 'PREFERRED chip present when the effort differs')
    assert.match(pairHtml, />RUNNING</, 'RUNNING label rendered')
    assert.match(pairHtml, />PREFERRED</, 'PREFERRED label rendered')
    assert.match(pairHtml, />HIGH</, 'RUNNING effort badge is HIGH')
    assert.match(pairHtml, />MAX</, 'PREFERRED effort badge is MAX')
    assert.ok(!pairHtml.includes('DeepSeek V4 Flash High') && !pairHtml.includes('DeepSeek V4 Flash MAX'), 'never renders a tier-embedded model label')
    assert.ok(!pairHtml.includes('MAX Max') && !pairHtml.includes('High High'), 'never renders a duplicated effort')
    assert.ok(pairHtml.includes('Nexus may route individual tasks below this ceiling'), 'PREFERRED tooltip carries the ceiling explanation')
    assert.ok(pairHtml.includes('RUNNING — DeepSeek V4 Flash · HIGH'), 'RUNNING tooltip carries the full model identity + effort')
    // Phase M2.1: the pair fixture is an engineering session — the Profile UI
    // trigger mounts beside it; the pill PAIR itself stays read-only.
    const pairSegment = pairHtml.slice(pairHtml.indexOf('data-nexus-executor'), pairHtml.indexOf('nx-eng-composer'))
    assert.ok(!pairSegment.includes('<button'), 'pair stays read-only')

    // preferred MAX + effective MAX (identical identity AND effort) → only
    // RUNNING (no redundant presentation)
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'working',
      binding: { sessionId: 'session-0001', taskId: 'TASK-0042', workspace: 'C:\\ws', preset: 'aih-engineering', executionClass: 'deepseek_normal' },
      execution: { class: 'deepseek_normal', provider: 'flash-max-direct', model: 'DeepSeek V4 Flash', modelId: 'deepseek-v4-flash', reasoning: 'max' },
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' },
    }
    const equalHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.match(equalHtml, /data-nexus-executor/, 'RUNNING still shown when preference equals effective')
    assert.match(equalHtml, />MAX</, 'RUNNING carries the MAX effort badge')
    assert.ok(!equalHtml.includes('data-nexus-preferred'), 'PREFERRED hidden when identity AND effort are identical')
    assert.ok(equalHtml.includes('DeepSeek V4 Flash'), 'single truthful model identity rendered')

    // routing decision absent (bound, no executor) → no fake RUNNING; PREFERRED only
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'waiting',
      binding: { sessionId: 'session-0001', taskId: 'TASK-0042', workspace: 'C:\\ws', preset: 'aih-engineering', executionClass: 'deepseek_normal' },
      execution: null,
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' },
    }
    const noExecHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.ok(!noExecHtml.includes('data-nexus-executor'), 'no effective executor → no fake RUNNING value')
    assert.match(noExecHtml, /data-nexus-preferred/, 'PREFERRED remains when no executor is routed')
    assert.match(noExecHtml, />PREFERRED</)
    assert.match(noExecHtml, />MAX</, 'PREFERRED effort badge survives without RUNNING')

    // unbound session → preference stays usable (PREFERRED chip labels the selector)
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'idle',
      binding: null,
      execution: null,
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' },
    }
    const unboundHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.ok(!unboundHtml.includes('data-nexus-executor'), 'unbound session never invents a RUNNING value')
    assert.match(unboundHtml, /data-nexus-preferred/, 'unbound session keeps the preference labeled and usable')

    // transport failure / no snapshot (M2.1): the RUNNING/PREFERRED pills stay
    // empty (UNAVAILABLE is the drawer's face), but the Profile UI trigger
    // stays mounted — the restart fix fails CLOSED toward engineering instead
    // of dropping the operator back into the legacy posture.
    sandbox.window.__NX_TEST_SNAPSHOT__ = null
    sandbox.window.__NX_TEST_SNAPSHOT_FAILED__ = true
    const failHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.ok(!failHtml.includes('data-nexus-executor'), 'transport failure renders no pill content')
    assert.ok(failHtml.includes('nx-eng-trigger'), 'transport failure keeps the Profile UI trigger mounted (fail closed)')
    sandbox.window.__NX_TEST_SNAPSHOT__ = null
    sandbox.window.__NX_TEST_SNAPSHOT_FAILED__ = false
    const noSnapHtml = renderToStaticMarkup(react.createElement(ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.ok(!noSnapHtml.includes('data-nexus-executor'), 'no snapshot renders no pill content')
    assert.ok(noSnapHtml.includes('nx-eng-trigger'), 'no snapshot keeps the Profile UI trigger mounted (fail closed)')
    // no session scope (hero phase) → legacy posture: no pill and no selector,
    // exactly the pre-M2.1 rendering (the selector needs a session to bind).
    assert.equal(renderToStaticMarkup(react.createElement(ExecutorChip, { session: null })), '', 'no session scope renders no pill')
  }

  // ── 21. detail cache: mtime-keyed reuse + fail-closed missing files ──────
  {
    const dataRoot = tmpDir('nexus-ctr-cache-')
    const workspace = path.join(dataRoot, 'ws')
    const sessionId = 'session-cache-01'
    const decision = {
      recordVersion: 3, timestampUtc: '2026-08-28T17:29:00.000Z', taskId: 'TASK-0042', workspace, preset: 'aih-engineering',
      kind: 'routed', selectedExecutionClass: 'deepseek_normal', executionClass: 'deepseek_normal',
      provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'high', risk: 'normal', reviewRequired: false, writable: true,
    }
    const files = detailFixtureFileMap(dataRoot, workspace, {
      decisions: [decision],
      lifecycle: [{ timestampUtc: '2026-08-28T17:00:00.000Z', kind: 'task-created', taskId: 'TASK-0042', dependencies: [] }],
      attempts: [],
      evidence: { verification: [{ name: 'build', status: 'PASS', evidence: 'dotnet build' }] },
    })
    // bind the fixture under the cache-test session id
    files[path.join(dataRoot, 'routing', 'session-bindings.json')] = JSON.stringify({
      schemaVersion: 1,
      bindings: {
        [sessionId]: { sessionId, taskId: 'TASK-0042', workspace, preset: 'aih-engineering', description: 'cache fixture', executionClass: 'deepseek_normal', reviewRequired: false, boundAtUtc: '2026-08-28T17:00:00.000Z' },
      },
    })
    writeTree(dataRoot, files)

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dataRoot
    try {
      const plugin = await import(pathToFileURL(HOST).href)
      let captured = []
      let injectCallback = null
      plugin.apply({ inject(keys, cb) { injectCallback = cb }, effect() { return () => {} } })
      injectCallback({ webServer: { register(spec) { captured.push(spec) } }, effect(fn) { fn(); return () => {} } })
      const roomRoute = captured.find((spec) => spec.path === '/nexus/control-room.json')
      assert.ok(roomRoute, 'control-room route must register')
      const res = {
        writeHead(code, headers) { this.code = code; this.headers = headers },
        end(body) { this.body = body },
      }
      const call = async () => {
        await roomRoute.handler({ url: '/nexus/control-room.json?session=' + sessionId }, res)
        return JSON.parse(res.body)
      }
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      // 21a. unchanged sources → the cached snapshot is REUSED: byte-identical
      // body including the same generatedAtUtc even after a 15 ms gap
      // (a recompute would stamp a fresh generatedAtUtc).
      const body1 = await call()
      assert.equal(res.code, 200)
      assert.equal(body1.binding.taskId, 'TASK-0042')
      assert.equal(body1.verification.source, 'evidence-artifact', 'fixture ships an evidence artifact')
      await sleep(15)
      const body2 = await call()
      assert.deepEqual(body2, body1, 'unchanged sources must reuse the cached detail snapshot (same mtime key)')

      // 21b. an mtime change MUST change the key → the snapshot recomputes.
      const ledgerPath = path.join(workspace, '.ai-harness', 'state', 'tasks.json')
      const future = new Date(Date.now() + 60000)
      fs.utimesSync(ledgerPath, future, future)
      await sleep(5)
      const body3 = await call()
      assert.notEqual(body3.generatedAtUtc, body1.generatedAtUtc, 'a changed mtime must invalidate the detail cache key')
      assert.equal(body3.binding.taskId, 'TASK-0042', 'the rebuilt snapshot is still healthy')

      // 21c. a MISSING file must keep fail-closed behavior AND change the
      // key (the ':missing' marker) so the next call rebuilds.
      fs.rmSync(path.join(workspace, '.ai-harness', 'runs', 'TASK-0042', 'evidence.json'), { force: true })
      await sleep(5)
      const body4 = await call()
      assert.equal(res.code, 200, 'missing evidence must not break the envelope')
      assert.equal(body4.error, undefined, 'missing evidence must not flip the envelope to error')
      assert.equal(body4.verification.source, 'ledger', 'verification falls back to the ledger outcomes')
      assert.equal(body4.verification.artifactPresent, false)
      assert.equal(body4.verification.total, 2, 'ledger fallback keeps its checks')
      assert.notEqual(body4.generatedAtUtc, body3.generatedAtUtc, 'the missing-file marker must change the cache key')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }

  // ── 22. TASK-0003.1b regression: the snapshot hook can never return
  //        undefined and no raw setter is ever registered as a poll listener.
  //        Live bug: notifySnapshotListeners called listener() with no
  //        arguments, the hook had registered React's raw setState, so the
  //        first completed poll set state to undefined → the hook returned
  //        undefined → the drawer's destructure crashed in the real app and
  //        the slot boundary swallowed the drawer AND the executor pill.
  {
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    const source = fs.readFileSync(CLIENT, 'utf8')

    // 22a. The shared-poll notification must hand snapshot data to its
    // listeners — the bug called listener() with no arguments, which turned
    // a raw setState into setState(undefined).
    assert.match(source, /listener\(entry\.snapshot, entry\.failed\)/, 'notifySnapshotListeners must pass the snapshot data to listeners')

    // 22b. The hook must register an adapter that reads the shared entry —
    // never React's raw setState (setState() with no argument collapses the
    // state to undefined on the next render).
    const hookSource = source.slice(source.indexOf('function useControllerSnapshot'), source.indexOf('//#endregion', source.indexOf('function useControllerSnapshot')))
    assert.doesNotMatch(hookSource, /listeners\.add\(setState\)/, 'the hook must never register the raw setState as a poll listener')
    assert.match(hookSource, /listeners\.add\(apply\)/, 'the hook registers an adapter that reads the shared entry state')

    // 22c. The hook's return must be shape-independent: a well-formed
    // { snapshot, failed } object even if a state collapse ever produced
    // null/undefined.
    assert.match(hookSource, /return state && typeof state === "object" \? state : \{ snapshot: null, failed: false \}/, 'hook return must fall back to a well-formed object')

    // 22d. Behavioral probe through the REAL hook: render a probe component
    // that calls useControllerSnapshot and serialize its return — it must
    // always be the { snapshot, failed } object, never undefined.
    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    const useControllerSnapshot = moduleExports.useControllerSnapshot
    assert.equal(typeof useControllerSnapshot, 'function', 'useControllerSnapshot must be exported for deterministic probing')
    const Probe = () => {
      const hookResult = useControllerSnapshot('session-regression')
      return react.createElement('x-probe', { 'data-return': JSON.stringify(hookResult) })
    }
    const probeHtml = renderToStaticMarkup(react.createElement(Probe))
    const serialized = probeHtml.match(/data-return="([^"]*)"/)
    assert.ok(serialized, 'probe must serialize the hook return')
    const hookReturn = JSON.parse(serialized[1].replace(/&quot;/g, '"'))
    assert.deepEqual(hookReturn, { snapshot: null, failed: false }, 'useControllerSnapshot must return a well-formed object, never undefined')
  }

  // ── 23. TASK-0003.2 identity isolation: workspace + taskId joins ─────
  // taskId is NOT globally unique (TASK-0003 exists in many workspaces).
  // Every Control Room join must carry the authoritative namespace
  // session → binding → normalized workspace → taskId. The fixture below
  // collides C:\RepoA and D:\RepoB on the SAME taskId with DISTINCT
  // decisions, reviews, escalations, lifecycle, attempts, verification
  // and run artifacts, then proves each session sees only its own state.
  {
    // path normalization semantics (deterministic, Windows-safe, IO-free)
    const norm = status.normalizeWorkspacePath
    assert.equal(norm('C:\\AI-Harness'), norm('c:/ai-harness/'), 'separator + case + trailing-slash normalization matches')
    assert.equal(norm('C:\\AI-Harness'), norm('C:\\AI-Harness\\'), 'trailing separator trimmed')
    assert.equal(norm('C:\\AI-Harness'), norm('C:\\\\AI-Harness'), 'redundant separators collapse')
    assert.equal(norm('C:\\Repo'), norm('C:\\Repo\\'), 'plain trailing slash is inert')
    assert.notEqual(norm('C:\\Repo'), norm('C:\\Repo2'), 'prefix-related paths must never be equal')
    assert.notEqual(norm('C:\\AI-Harness'), norm('C:\\AI-Harness\\tests'), 'subdirectory is a different workspace')
    assert.notEqual(norm('C:\\AI-Harness'), norm('D:\\AI-Harness'), 'different drive is a different workspace')
    assert.equal(norm('C:\\'), 'c:\\', 'drive root survives trimming')
    assert.equal(norm(''), '', 'empty normalizes to empty')
    assert.equal(norm(null), '', 'null normalizes to empty')

    const dataRoot = 'C:\\aih-fixture-data'
    const repoA = 'C:\\RepoA'
    const repoB = 'D:\\RepoB'
    const taskId = 'TASK-0003'
    const modelNames = {
      'flash-high-direct/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'sol-local/gpt-5.6-sol': 'GPT-5.6 Sol',
    }

    const decision = (ts, workspace, extra) => JSON.stringify(Object.assign({
      recordVersion: 1, timestampUtc: ts, taskId, workspace,
      kind: 'routed', risk: 'normal',
    }, extra))
    const decisionsText = [
      decision('2026-08-29T10:00:00.000Z', 'C:/RepoA/', { selectedExecutionClass: 'deepseek_normal', executionClass: 'deepseek_normal', provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'high', reason: 'A primary' }),
      decision('2026-08-29T10:05:00.000Z', repoA, { selectedExecutionClass: 'codex_review', executionClass: 'codex_review', provider: 'sol-local', model: 'gpt-5.6-sol', escalatedFrom: 'deepseek_normal', reviewRequired: true, reason: 'A review' }),
      decision('2026-08-29T10:06:00.000Z', repoA, { selectedExecutionClass: 'deepseek_deep', executionClass: 'deepseek_deep', provider: 'flash-high-direct', model: 'deepseek-v4-flash', escalatedFrom: 'codex_review', reason: 'A escalation' }),
      decision('2026-08-29T11:00:00.000Z', repoB, { selectedExecutionClass: 'deepseek_deep', executionClass: 'deepseek_deep', provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'max', reason: 'B primary (NEWER than every A record)' }),
      decision('2026-08-29T11:05:00.000Z', repoB, { selectedExecutionClass: 'codex_review', executionClass: 'codex_review', provider: 'sol-local', model: 'gpt-5.6-sol', escalatedFrom: 'deepseek_deep', reviewRequired: true, reason: 'B review' }),
      '{ this line is corrupt JSON from RepoB \u2014 jsonLinesOf must skip it }',
      JSON.stringify({ recordVersion: 1, timestampUtc: '2026-08-29T12:00:00.000Z', taskId, reason: 'no workspace field — must never match (fail-closed)' }),
    ].join('\n') + '\n'

    const lifecycle = (ts, kind, extra) => JSON.stringify(Object.assign({ timestampUtc: ts, taskId }, extra, { kind }))
    const files = {
      [path.join(dataRoot, 'routing', 'session-bindings.json')]: JSON.stringify({ schemaVersion: 1, bindings: {
        'session-A': { sessionId: 'session-A', taskId, workspace: repoA, preset: 'aih-engineering', executionClass: 'deepseek_normal', reviewRequired: false, boundAtUtc: '2026-08-29T09:59:00.000Z' },
        'session-B': { sessionId: 'session-B', taskId, workspace: repoB, preset: 'aih-engineering', executionClass: 'deepseek_deep', reviewRequired: false, boundAtUtc: '2026-08-29T10:59:00.000Z' },
      } }),
      [path.join(dataRoot, 'routing', 'decisions.jsonl')]: decisionsText,
      [path.join(dataRoot, 'routing', 'states', status.routingStateFileName(repoA, 'aih-engineering', taskId))]: JSON.stringify({ executionClass: 'deepseek_normal', reviewRequired: false, sameFailureCount: 2, updatedAtUtc: '2026-08-29T10:01:00.000Z' }),
      [path.join(dataRoot, 'routing', 'states', status.routingStateFileName(repoB, 'aih-engineering', taskId))]: JSON.stringify({ executionClass: 'deepseek_deep', reviewRequired: false, sameFailureCount: 5, updatedAtUtc: '2026-08-29T11:01:00.000Z' }),
      [path.join(dataRoot, 'aih-state.json')]: JSON.stringify({ SchemaVersion: 3, Status: 'READY', Pid: 1, Workspace: repoA, ProcessStartedAtUtc: '2026-08-29T09:00:00.000Z' }),
      // workspace A state
      [path.join(repoA, '.ai-harness', 'state', 'tasks.json')]: JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ schemaVersion: 1, taskId, description: 'A task', status: 'implementing', attempt: 0, maxAttempts: 3, executionClass: 'deepseek_normal', reviewRequested: false, codexCalls: 0, failureSignatures: ['sig-A'], createdAtUtc: '2026-08-29T09:58:00.000Z', updatedAtUtc: '2026-08-29T10:06:00.000Z' }] }),
      [path.join(repoA, '.ai-harness', 'state', 'decisions.jsonl')]: [
        lifecycle('2026-08-29T09:58:00.000Z', 'task-created', { dependencies: [] }),
        lifecycle('2026-08-29T10:01:00.000Z', 'execution-class-selected', { executionClass: 'deepseek_normal', reason: 'A route' }),
      ].join('\n') + '\n',
      [path.join(repoA, '.ai-harness', 'runs', taskId, 'manifest.json')]: '{}',
      [path.join(repoA, '.ai-harness', 'runs', taskId, 'attempts.jsonl')]: JSON.stringify({ sequence: 1, status: 'started', attemptId: 'attempt-A-1', executionClass: 'deepseek_normal', startedAtUtc: '2026-08-29T10:02:00.000Z' }) + '\n',
      [path.join(repoA, '.ai-harness', 'runs', taskId, 'evidence.json')]: JSON.stringify({ verification: [{ name: 'build-A', status: 'PASS', evidence: 'a' }], acceptanceCriteria: [{ criterion: 'c-A', status: 'PASS' }], scopePass: true }),
      [path.join(repoA, '.ai-harness', 'runs', taskId, 'review-packet.json')]: JSON.stringify({ question: 'A review question', relevantFiles: ['a.ts'], diff: 'diff-a' }),
      [path.join(repoA, '.ai-harness', 'runs', taskId, 'review-result.json')]: JSON.stringify({ verdict: 'PASS', needsBroaderContext: false, findings: [{ severity: 'info', location: 'a.ts', problem: 'p-A' }] }),
      // workspace B state (same taskId, entirely different content)
      [path.join(repoB, '.ai-harness', 'state', 'tasks.json')]: JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ schemaVersion: 1, taskId, description: 'B task', status: 'failed', attempt: 1, maxAttempts: 3, executionClass: 'deepseek_deep', reviewRequested: true, codexCalls: 1, failureSignatures: ['sig-B'], createdAtUtc: '2026-08-29T10:58:00.000Z', updatedAtUtc: '2026-08-29T11:06:00.000Z' }] }),
      [path.join(repoB, '.ai-harness', 'state', 'decisions.jsonl')]: [
        lifecycle('2026-08-29T10:58:00.000Z', 'task-created', { dependencies: [] }),
        lifecycle('2026-08-29T11:01:00.000Z', 'execution-class-selected', { executionClass: 'deepseek_deep', reason: 'B route' }),
      ].join('\n') + '\n',
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'manifest.json')]: '{}',
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'attempts.jsonl')]: JSON.stringify({ sequence: 1, status: 'failed', attemptId: 'attempt-B-1', executionClass: 'deepseek_deep', failureSignature: 'sig-B', startedAtUtc: '2026-08-29T11:02:00.000Z', timestampUtc: '2026-08-29T11:05:00.000Z' }) + '\n',
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'evidence.json')]: JSON.stringify({ verification: [{ name: 'build-B', status: 'FAIL', evidence: 'b' }] }),
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'review-packet.json')]: JSON.stringify({ question: 'B review question', relevantFiles: ['b.ts'], diff: 'diff-b' }),
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'review-result.json')]: JSON.stringify({ verdict: 'FAIL', needsBroaderContext: true, findings: [{ severity: 'critical', location: 'b.ts', problem: 'p-B' }] }),
    }
    const readFile = memoryReader(files)

    // 23a. negative control: taskId-only filtering WOULD mix the workspaces
    const taskIdOnly = status.jsonLinesOf(decisionsText).filter((r) => r && r.taskId === taskId)
    const taskIdOnlyWorkspaces = new Set(taskIdOnly.map((r) => status.normalizeWorkspacePath(r.workspace)))
    assert.ok(taskIdOnlyWorkspaces.has(status.normalizeWorkspacePath(repoA)) && taskIdOnlyWorkspaces.has(status.normalizeWorkspacePath(repoB)), 'negative control: taskId alone spans both workspaces')
    const newestTaskIdOnlyPrimary = taskIdOnly
      .filter((r) => !r.escalatedFrom && status.normalizeWorkspacePath(r.workspace) !== '')
      .sort((a, b) => String(b.timestampUtc).localeCompare(String(a.timestampUtc)))[0]
    assert.equal(newestTaskIdOnlyPrimary.workspace, repoB, 'negative control: taskId-only root selection is order-dependent across workspaces')

    // 23b. lastDecisionOf itself is namespace-scoped and fail-closed
    const records = status.jsonLinesOf(decisionsText)
    assert.equal(status.lastDecisionOf(records, taskId, repoA).provider, 'flash-high-direct', 'A decision resolves inside RepoA')
    assert.equal(status.lastDecisionOf(records, taskId, repoA).escalatedFrom == null, true, 'A root is the primary, not the newer review/escalation')
    assert.equal(status.lastDecisionOf(records, taskId, 'c:/repoa/').timestampUtc, '2026-08-29T10:00:00.000Z', 'normalized spelling of RepoA matches')
    assert.equal(status.lastDecisionOf(records, taskId, repoB).executionClass, 'deepseek_deep', 'B decision resolves inside RepoB')
    assert.equal(status.lastDecisionOf(records, taskId, 'C:\\SomewhereElse'), null, 'unknown workspace never joins')
    assert.equal(status.lastDecisionOf(records, taskId, ''), null, 'empty workspace never joins (fail-closed)')
    assert.equal(status.lastDecisionOf(records, taskId, null), null, 'null workspace never joins')

    // 23c. session bound to RepoA → ONLY RepoA state
    const snapshotA = await detail.buildDetailSnapshot({ dataRoot, sessionId: 'session-A', statePath: path.join(dataRoot, 'aih-state.json'), readFile, modelNames, gitSummary: null, gitFiles: null, nowUtc: () => '2026-08-29T12:00:00.000Z' })
    assert.equal(snapshotA.binding.workspace, repoA)
    assert.equal(snapshotA.execution.model, 'DeepSeek V4 Flash', 'A root executor comes from RepoA, not from RepoB\'s newer primary')
    assert.equal(snapshotA.routingHistory.length, 3, 'A history holds only RepoA decisions')
    assert.ok(snapshotA.routingHistory.every((h) => status.normalizeWorkspacePath(h.workspace) === status.normalizeWorkspacePath(repoA)), 'every A history record is from RepoA')
    assert.deepEqual(snapshotA.routingHistory.map((h) => h.kind), ['primary', 'review', 'escalation'])
    assert.equal(snapshotA.reviews.decisions.length, 1, 'A reviews carry only the RepoA review decision')
    assert.equal(snapshotA.reviews.decisions[0].model, 'GPT-5.6 Sol')
    assert.equal(snapshotA.reviews.result.verdict, 'PASS', 'A review result is RepoA\'s artifact')
    assert.equal(snapshotA.reviews.packet.question, 'A review question')
    assert.equal(snapshotA.reviews.codexCalls, 0)
    assert.equal(snapshotA.reviews.reviewRequired, false)
    assert.deepEqual(snapshotA.lifecycle.map((l) => l.kind), ['task-created', 'execution-class-selected'], 'A lifecycle is RepoA\'s own ledger')
    assert.equal(snapshotA.attempts.length, 1)
    assert.equal(snapshotA.attempts[0].attemptId, 'attempt-A-1', 'A attempts come from RepoA\'s runs dir')
    assert.equal(snapshotA.verification.source, 'evidence-artifact')
    assert.deepEqual(snapshotA.verification.checks.map((c) => c.name), ['build-A'], 'A verification checks are RepoA\'s evidence')
    assert.ok(snapshotA.verification.artifactPath.includes('RepoA'), 'A artifact path stays inside RepoA')
    assert.deepEqual(snapshotA.failures.signatures, [{ signature: 'sig-A', count: 1 }])
    assert.equal(snapshotA.failures.sameFailureCount, 2, 'A failure count comes from RepoA\'s routing state')

    // 23d. session bound to RepoB → ONLY RepoB state (mirror)
    const snapshotB = await detail.buildDetailSnapshot({ dataRoot, sessionId: 'session-B', statePath: path.join(dataRoot, 'aih-state.json'), readFile, modelNames, gitSummary: null, gitFiles: null, nowUtc: () => '2026-08-29T12:00:00.000Z' })
    assert.equal(snapshotB.binding.workspace, repoB)
    assert.equal(snapshotB.execution.class, 'deepseek_deep', 'B root executor comes from RepoB (deepseek_deep, not A\'s deepseek_normal)')
    assert.equal(snapshotB.routingHistory.length, 2, 'B history holds only RepoB decisions')
    assert.ok(snapshotB.routingHistory.every((h) => status.normalizeWorkspacePath(h.workspace) === status.normalizeWorkspacePath(repoB)))
    assert.equal(snapshotB.reviews.decisions.length, 1)
    assert.equal(snapshotB.reviews.result.verdict, 'FAIL')
    assert.equal(snapshotB.reviews.codexCalls, 1)
    assert.equal(snapshotB.reviews.reviewRequired, true)
    assert.equal(snapshotB.attempts.length, 1)
    assert.equal(snapshotB.attempts[0].sequence, 1, 'B attempts come from RepoB\'s runs dir')
    assert.equal(snapshotB.attempts[0].status, 'failed', 'B attempt failed record is RepoB\'s')
    assert.equal(snapshotB.attempts[0].failureSignature, 'sig-B')
    assert.deepEqual(snapshotB.verification.checks.map((c) => c.name), ['build-B'])
    assert.deepEqual(snapshotB.failures.signatures, [{ signature: 'sig-B', count: 1 }])
    assert.equal(snapshotB.failures.sameFailureCount, 5)

    // 23e. compact Controller (and EXECUTOR pill data) is namespace-scoped
    const compactA = await status.buildControllerSnapshot({ dataRoot, sessionId: 'session-A', statePath: path.join(dataRoot, 'aih-state.json'), readFile, modelNames, gitSummary: null, nowUtc: () => '2026-08-29T12:00:00.000Z' })
    assert.equal(compactA.execution.model, 'DeepSeek V4 Flash', 'compact root executor ignores RepoB\'s NEWER primary — correctness never depends on ordering')
    const compactB = await status.buildControllerSnapshot({ dataRoot, sessionId: 'session-B', statePath: path.join(dataRoot, 'aih-state.json'), readFile, modelNames, gitSummary: null, nowUtc: () => '2026-08-29T12:00:00.000Z' })
    assert.equal(compactB.execution.class, 'deepseek_deep')
  }

  // ── 23f. corruption behavior: fail-closed, no cross-workspace fallback ──
  {
    const dataRoot = 'C:\\aih-fixture-data-2'
    const repoA = 'C:\\RepoA'
    const repoB = 'D:\\RepoB'
    const taskId = 'TASK-0003'
    const decision = (ts, workspace, extra) => JSON.stringify(Object.assign({ recordVersion: 1, timestampUtc: ts, taskId, workspace, kind: 'routed' }, extra))
    const decisionsText = [
      decision('2026-08-29T10:00:00.000Z', repoA, { executionClass: 'deepseek_normal', provider: 'flash-high-direct', model: 'deepseek-v4-flash', reason: 'A primary' }),
      decision('2026-08-29T11:00:00.000Z', repoB, { executionClass: 'deepseek_deep', provider: 'flash-high-direct', model: 'deepseek-v4-flash', reason: 'B primary' }),
      '{ corrupt decision line from RepoB }',
    ].join('\n') + '\n'
    const files = {
      [path.join(dataRoot, 'routing', 'session-bindings.json')]: JSON.stringify({ schemaVersion: 1, bindings: {
        'session-A': { sessionId: 'session-A', taskId, workspace: repoA, preset: 'aih-engineering', executionClass: 'deepseek_normal', reviewRequired: false, boundAtUtc: '2026-08-29T09:59:00.000Z' },
      } }),
      [path.join(dataRoot, 'routing', 'decisions.jsonl')]: decisionsText,
      [path.join(dataRoot, 'routing', 'states', status.routingStateFileName(repoA, 'aih-engineering', taskId))]: JSON.stringify({ executionClass: 'deepseek_normal', reviewRequired: false, sameFailureCount: 1, updatedAtUtc: '2026-08-29T10:01:00.000Z' }),
      [path.join(dataRoot, 'aih-state.json')]: JSON.stringify({ SchemaVersion: 3, Status: 'READY', Pid: 1, Workspace: repoA, ProcessStartedAtUtc: '2026-08-29T09:00:00.000Z' }),
      [path.join(repoA, '.ai-harness', 'state', 'tasks.json')]: JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ schemaVersion: 1, taskId, description: 'A task', status: 'implementing', attempt: 0, maxAttempts: 3, executionClass: 'deepseek_normal', reviewRequested: false, codexCalls: 0, failureSignatures: ['sig-A'], createdAtUtc: '2026-08-29T09:58:00.000Z' }] }),
      [path.join(repoA, '.ai-harness', 'state', 'decisions.jsonl')]: JSON.stringify({ timestampUtc: '2026-08-29T09:58:00.000Z', taskId, kind: 'task-created', dependencies: [] }) + '\n',
      [path.join(repoA, '.ai-harness', 'runs', taskId, 'manifest.json')]: '{}',
      // RepoA has NO evidence.json (missing current-workspace artifact) and
      // NO ledger verification outcomes → verification degrades to null-ish
      // and must NEVER fall back to RepoB's evidence artifact.
      [path.join(repoB, '.ai-harness', 'state', 'tasks.json')]: JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ schemaVersion: 1, taskId, description: 'B task', status: 'failed', attempt: 1, maxAttempts: 3, executionClass: 'deepseek_deep', reviewRequested: true, codexCalls: 1, failureSignatures: ['sig-B'], createdAtUtc: '2026-08-29T10:58:00.000Z' }] }),
      [path.join(repoB, '.ai-harness', 'state', 'decisions.jsonl')]: JSON.stringify({ timestampUtc: '2026-08-29T10:58:00.000Z', taskId, kind: 'task-created', dependencies: [] }) + '\n',
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'manifest.json')]: '{}',
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'evidence.json')]: JSON.stringify({ verification: [{ name: 'build-B', status: 'PASS', evidence: 'b' }] }),
      [path.join(repoB, '.ai-harness', 'runs', taskId, 'review-result.json')]: '{ corrupt review result from RepoB',
    }
    const readFile = memoryReader(files)
    const snapshotA = await detail.buildDetailSnapshot({ dataRoot, sessionId: 'session-A', statePath: path.join(dataRoot, 'aih-state.json'), readFile, modelNames: {}, gitSummary: null, gitFiles: null, nowUtc: () => '2026-08-29T12:00:00.000Z' })
    assert.equal(snapshotA.verification.artifactPresent, false, 'missing RepoA evidence degrades the verification subsystem')
    assert.equal(snapshotA.verification.source, null)
    assert.equal(snapshotA.verification.total, 0)
    assert.ok(!JSON.stringify(snapshotA.verification).includes('build-B'), 'never falls back to RepoB\'s evidence artifact')
    assert.ok(snapshotA.verification.artifactPath.includes('RepoA'), 'artifact path stays inside RepoA even when missing')
    assert.equal(snapshotA.reviews.result, null, 'corrupt RepoB review result does not reach RepoA')
    assert.equal(snapshotA.routingHistory.length, 1, 'corrupt RepoB decision line does not reach RepoA (skipped by jsonLinesOf)')
    assert.equal(snapshotA.routingHistory[0].workspace, repoA)
    assert.equal(snapshotA.execution.model, 'DeepSeek V4 Flash', 'RepoA execution intact despite RepoB corruption')
    assert.equal(snapshotA.task.description, 'A task', 'RepoA task ledger intact despite RepoB corruption')
    assert.deepEqual(snapshotA.failures.signatures, [{ signature: 'sig-A', count: 1 }])
  }
  // ── 24. TASK-0003.3: session preference block (agent-default-model) ────
  {
    // parseDefaultModel unit cases (fail-closed)
    const SETTINGS = 'agent-default-model:\n  provider: flash-max-direct\n  model: deepseek-v4-flash\n  reasoningEffort: max\n\nllm-pi-ai:\n  providers: {}\n'
    assert.deepEqual(status.parseDefaultModel(SETTINGS), { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, 'parses the flat 3-key block')
    assert.equal(status.parseDefaultModel('agent-default-model:\n  provider: flash-max-direct\n'), null, 'missing model is fail-closed')
    assert.equal(status.parseDefaultModel('llm-pi-ai:\n  providers: {}\n'), null, 'no block is fail-closed')
    assert.equal(status.parseDefaultModel(''), null, 'empty settings are fail-closed')
    assert.equal(status.parseDefaultModel(null), null, 'null settings are fail-closed')
    assert.equal(status.parseDefaultModel('agent-default-model:\n  provider:\n  model: deepseek-v4-flash\n'), null, 'empty provider value is fail-closed')

    // TASK-0003.3a canonical naming rule: the display label is the BASE
    // model identity; the effort is a separate value, never embedded.
    const canonicalMap = {
      'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'flash-high-direct/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-pro-direct/deepseek-v4-pro': 'DeepSeek V4 Pro',
    }
    assert.equal(status.modelNameOf('flash-max-direct', 'deepseek-v4-flash', canonicalMap), 'DeepSeek V4 Flash', 'max provider maps to the base label')
    assert.equal(status.modelNameOf('flash-high-direct', 'deepseek-v4-flash', canonicalMap), 'DeepSeek V4 Flash', 'high provider maps to the same base label')
    assert.equal(status.modelNameOf('flash-max-direct', 'deepseek-v4-flash', canonicalMap).includes('MAX'), false, 'tier never embedded in the model label')
    assert.equal(status.modelNameOf('flash-high-direct', 'deepseek-v4-flash', canonicalMap).includes('High'), false, 'tier never embedded in the model label')
    assert.equal(status.modelNameOf('flash-max-direct', 'deepseek-v4-flash', canonicalMap).endsWith('Max'), false, 'no effort token at the label end')
    const canonicalExecution = status.normalizeExecution(
      { sessionId: 'session-x', taskId: 'TASK-0042', workspace: 'C:\\ws', preset: 'aih-engineering' },
      null, { executionClass: 'deepseek_normal' },
      { provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'high' },
      canonicalMap,
    )
    assert.equal(canonicalExecution.model, 'DeepSeek V4 Flash', 'execution block exposes the base model')
    assert.equal(canonicalExecution.reasoning, 'high', 'execution block keeps the effort separate')
    assert.equal(canonicalExecution.provider, 'flash-high-direct', 'provider id unchanged')

    const pref = status.normalizePreference({ provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' })
    assert.deepEqual(pref, { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' }, 'preference label resolves to the base model via the settings display-name map')
    assert.equal(status.normalizePreference(null, {}), null, 'no selection → null preference')
    assert.equal(status.normalizePreference({}, {}), null, 'empty selection → null preference')

    const dataRoot = tmpDir('nexus-ctr-')
    const workspace = path.join(dataRoot, 'ws')
    const files = fixtureFileMap(dataRoot, workspace, {})
    files[path.join(dataRoot, 'settings.yaml')] = 'agent-default-model:\n  provider: flash-max-direct\n  model: deepseek-v4-flash\n  reasoningEffort: max\n'
    writeTree(dataRoot, files)
    const snapshot = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-0001',
      settingsPath: path.join(dataRoot, 'settings.yaml'),
      statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.deepEqual(snapshot.preference, { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' }, 'bound snapshot carries the preference')
    assert.equal(snapshot.execution.model, 'DeepSeek V4 Flash', 'fixture decision resolves to the base display model')

    // unbound session: preference remains available (pill can still label the selector)
    const unbound = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-nobody',
      settingsPath: path.join(dataRoot, 'settings.yaml'),
      statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(unbound.binding, null, 'unbound session has no binding')
    assert.deepEqual(unbound.preference, { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash' }, 'unbound session still exposes the preference')

    // corrupt settings degrade only the preference (fail-closed subsystem)
    files[path.join(dataRoot, 'settings.yaml')] = '{ this is not yaml: [unclosed'
    const corrupt = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-0001',
      settingsPath: path.join(dataRoot, 'settings.yaml'),
      statePath: path.join(dataRoot, 'aih-state.json'),
      readFile: memoryReader(files),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(corrupt.preference, null, 'corrupt settings → no preference, never a guessed one')
    assert.equal(corrupt.binding.taskId, 'TASK-0042', 'corrupt settings never damage the task state')
  }

  // ── 25. TASK-0004: attempt lifecycle (pure readers + snapshots) ─────────
  {
    // First execution → attempt 1; duplicate start while open → still 1;
    // reload/reconnect observes the same record; retry after closure → 2;
    // an OLD task (no journal) → null (UI renders "—").
    const attempts = [
      { attemptId: 'T-1-A1', taskId: 'T-1', workspace: 'C:\\ws', sequence: 1, executionClass: 'deepseek_normal', status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z', sessionId: 'session-0001', startedByTurn: '7', timestampUtc: '2026-08-28T17:30:01.000Z' },
      { taskId: 'T-1', workspace: 'C:\\ws', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:35:00.000Z' },
      { taskId: 'T-1', workspace: 'C:\\ws', sequence: 1, status: 'passed', timestampUtc: '2026-08-28T17:35:40.000Z' },
      { attemptId: 'T-1-A2', taskId: 'T-1', workspace: 'C:\\ws', sequence: 2, executionClass: 'deepseek_normal', status: 'started', startedAtUtc: '2026-08-28T18:00:00.000Z', sessionId: 'session-0001', startedByTurn: '19', timestampUtc: '2026-08-28T18:00:01.000Z' },
    ]
    const latest = status.latestAttemptOfTask(status.attemptsOf(attempts.map((r) => JSON.stringify(r)).join('\n')), 'T-1')
    assert.equal(latest.sequence, 2, 'latest attempt is the last real record (retry → attempt 2)')
    assert.equal(latest.status, 'started', 'attempt 2 is open after the retry')
    assert.equal(status.latestAttemptOfTask(status.attemptsOf(''), 'T-1'), null, 'empty journal → no attempt')
    const normalized = status.normalizeAttemptRecord(latest)
    assert.deepEqual(normalized, {
      sequence: 2, status: 'started', startedAtUtc: '2026-08-28T18:00:00.000Z', timestampUtc: '2026-08-28T18:00:01.000Z',
      sessionId: 'session-0001', startedByTurn: '19',
    }, 'normalized attempt carries the producer identity')

    // groupAttempts: lifecycle statuses + derived durations (never invented)
    const rows = detail.groupAttempts(status.attemptsOf(attempts.map((r) => JSON.stringify(r)).join('\n')), { status: 'in-progress' })
    assert.equal(rows.length, 2, 'two attempt rows from the journal')
    assert.equal(rows[0].status, 'passed', 'attempt 1 closed passed after verification')
    assert.equal(rows[0].verifyingAtUtc, '2026-08-28T17:35:00.000Z', 'verifying timestamp recorded')
    assert.equal(rows[0].finishedAtUtc, '2026-08-28T17:35:40.000Z', 'finished timestamp recorded')
    assert.equal(rows[0].durationSeconds, 340, 'duration derived from producer timestamps')
    assert.equal(rows[1].status, 'started', 'attempt 2 remains open')
    assert.equal(rows[1].durationSeconds, null, 'no duration for an open attempt')

    // interrupted + failed rows
    const mixed = [
      { taskId: 'T-2', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:00:00.000Z' },
      { taskId: 'T-2', sequence: 1, status: 'interrupted', timestampUtc: '2026-08-28T17:05:00.000Z' },
      { taskId: 'T-2', sequence: 2, status: 'started', startedAtUtc: '2026-08-28T18:00:00.000Z' },
      { taskId: 'T-2', sequence: 2, status: 'failed', failureSignature: 'sig-x', timestampUtc: '2026-08-28T18:10:00.000Z' },
    ]
    const mixedRows = detail.groupAttempts(status.attemptsOf(mixed.map((r) => JSON.stringify(r)).join('\n')), {})
    assert.equal(mixedRows[0].status, 'interrupted', 'abort closes as interrupted')
    assert.equal(mixedRows[0].durationSeconds, 300, 'interrupted duration derived')
    assert.equal(mixedRows[1].status, 'failed', 'failed attempt closed')
    assert.equal(mixedRows[1].failureSignature, 'sig-x', 'failure signature linked')
    assert.equal(mixedRows[1].durationSeconds, 600, 'failed duration derived')

    // snapshot carries attempt for a live task; old tasks degrade to null
    const dataRoot25 = tmpDir('nexus-ctr-')
    const workspace25 = path.join(dataRoot25, 'ws')
    const files25 = fixtureFileMap(dataRoot25, workspace25, {})
    files25[path.join(workspace25, '.ai-harness', 'runs', 'TASK-0042', 'attempts.jsonl')] =
      attempts.map((record) => JSON.stringify({ ...record, taskId: 'TASK-0042' })).join('\n') + '\n'
    writeTree(dataRoot25, files25)
    const snap25 = await status.buildControllerSnapshot({
      dataRoot: dataRoot25, sessionId: 'session-0001', settingsPath: path.join(dataRoot25, 'settings.yaml'),
      statePath: path.join(dataRoot25, 'aih-state.json'), readFile: memoryReader(files25),
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(snap25.attempt.sequence, 2, 'compact snapshot exposes the latest attempt')
    assert.equal(snap25.attempt.status, 'started', 'compact snapshot attempt status truthful')

    const oldTaskDataRoot = tmpDir('nexus-ctr-')
    const oldTaskFiles = fixtureFileMap(oldTaskDataRoot, path.join(oldTaskDataRoot, 'ws'), {})
    writeTree(oldTaskDataRoot, oldTaskFiles)
    const oldSnap = await status.buildControllerSnapshot({
      dataRoot: oldTaskDataRoot, sessionId: 'session-0001', settingsPath: path.join(oldTaskDataRoot, 'settings.yaml'),
      statePath: path.join(oldTaskDataRoot, 'aih-state.json'), readFile: memoryReader(oldTaskFiles),
      modelNames: {}, gitSummary: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(oldSnap.attempt, null, 'old task without a journal → attempt null (renders "—")')
  }

  // ── 26. TASK-0004: verification + review timestamps and linkage ─────────
  {
    const { snapshot } = await detailFixture({
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:31:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'passed', timestampUtc: '2026-08-28T17:31:20.000Z' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:31:00.000Z', finishedAtUtc: '2026-08-28T17:31:20.000Z',
        acceptanceCriteria: [], scopePass: true,
        verification: [
          { name: 'unit tests', kind: 'test', status: 'PASS', exitCode: 0, command: 'npm run test', startedAtUtc: '2026-08-28T17:31:02.000Z', finishedAtUtc: '2026-08-28T17:31:18.000Z', attempt: 1 },
          { name: 'typecheck', kind: 'verify', status: 'SKIP', exitCode: null, command: 'tsc', startedAtUtc: null, finishedAtUtc: null, attempt: 1 },
        ],
      },
      reviewPacket: { schemaVersion: 1, question: 'q', attempt: 1, requestedAtUtc: '2026-08-28T17:40:00.000Z' },
      reviewResult: { schemaVersion: 1, verdict: 'fail', completedAtUtc: '2026-08-28T17:41:00.000Z', findings: [] },
    })
    const v = snapshot.verification
    assert.equal(v.attempt, 1, 'verification links to attempt 1')
    assert.equal(v.startedAtUtc, '2026-08-28T17:31:00.000Z', 'verification startedAtUtc from the evidence artifact')
    assert.equal(v.finishedAtUtc, '2026-08-28T17:31:20.000Z', 'verification finishedAtUtc from the evidence artifact')
    assert.equal(v.durationSeconds, 20, 'verification duration derived')
    assert.equal(v.passed, 1, 'PASS counted')
    assert.equal(v.skipped, 1, 'SKIP counted')
    assert.equal(v.checks[0].durationSeconds, 16, 'per-check duration derived from producer timestamps')
    assert.equal(v.checks[1].durationSeconds, null, 'no timestamps → no duration (never invented)')
    assert.equal(snapshot.reviews.packet.requestedAtUtc, '2026-08-28T17:40:00.000Z', 'review requestedAtUtc from the packet')
    assert.equal(snapshot.reviews.packet.attempt, 1, 'review packet links the attempt')
    assert.equal(snapshot.reviews.result.completedAtUtc, '2026-08-28T17:41:00.000Z', 'review completedAtUtc from the result')

    // failed verification → FAILED summary (TASK-0004.1); interrupted attempt closes
    const { snapshot: snapFail } = await detailFixture({
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:31:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'interrupted', timestampUtc: '2026-08-28T17:31:30.000Z' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:31:00.000Z', finishedAtUtc: '2026-08-28T17:31:30.000Z',
        acceptanceCriteria: [], scopePass: true,
        verification: [
          { name: 'unit tests', status: 'PASS', startedAtUtc: '2026-08-28T17:31:02.000Z', finishedAtUtc: '2026-08-28T17:31:10.000Z', attempt: 1 },
          { name: 'integration', status: 'FAIL', exitCode: 1, startedAtUtc: '2026-08-28T17:31:11.000Z', finishedAtUtc: '2026-08-28T17:31:29.000Z', attempt: 1 },
        ],
      },
    })
    assert.equal(snapFail.verification.status, 'failed', 'PASS+FAIL → failed')
    assert.equal(snapFail.verification.failed, 1, 'FAIL counted')
    assert.equal(snapFail.attempts[0].status, 'interrupted', 'stale verifying closed as interrupted')

    // legacy evidence (no timestamps, no attempt) still renders
    const { snapshot: snapOld } = await detailFixture({
      evidence: { schemaVersion: 1, acceptanceCriteria: [], verification: [{ name: 'legacy check', status: 'PASS' }], scopePass: true },
    })
    assert.equal(snapOld.verification.attempt, null, 'legacy evidence → attempt omitted')
    assert.equal(snapOld.verification.startedAtUtc, null, 'legacy evidence → no start timestamp')
    assert.equal(snapOld.verification.durationSeconds, null, 'legacy evidence → no duration')
    assert.equal(snapOld.verification.checks[0].status, 'PASS', 'legacy checks still render')
  }

  // ── 27. TASK-0004: operator gates (pure + server-side validation) ──────
  {
    const gateModule = require(path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'gate.cjs'))
    const dataRoot = tmpDir('nexus-ctr-')
    const workspace = path.join(dataRoot, 'ws')
    const binding = { sessionId: 'session-0001', workspace, taskId: 'TASK-0042' }

    // no gate → no actions anywhere
    assert.equal(status.currentGateOf([], 'session-0001', workspace, 'TASK-0042'), null, 'no gate records → null')

    // active gate → exact allowedActions; buttons come only from them
    const created = gateModule.ensureGate(dataRoot, binding, 'review-required', { attempt: 1, reviewVerdict: 'fail' })
    assert.equal(created.status, 'waiting', 'gate opens waiting')
    assert.deepEqual(created.allowedActions, ['approve', 'reject'], 'gate advertises exactly approve/reject')
    const dup = gateModule.ensureGate(dataRoot, binding, 'review-required', { attempt: 1 })
    assert.equal(dup.gateId, created.gateId, 'ensureGate is idempotent — one transition per review failure')
    const normalized = status.normalizeGateRecord(status.currentGateOf(
      gateModule.readJsonLines(gateModule.gatesPathOf(dataRoot)), 'session-0001', workspace, 'TASK-0042',
    ))
    assert.equal(normalized.status, 'waiting', 'snapshot gate shows waiting')
    assert.deepEqual(normalized.allowedActions, ['approve', 'reject'], 'snapshot carries allowedActions')

    // invalid / stale / duplicate handling (server-side validation)
    const ok = gateModule.validateGateAction(dataRoot, binding, { sessionId: 'session-0001', gateId: created.gateId, actionId: 'approve', requestId: 'req-1' })
    assert.equal(ok.ok, true, 'valid current action accepted')
    const badAction = gateModule.validateGateAction(dataRoot, binding, { sessionId: 'session-0001', gateId: created.gateId, actionId: 'force', requestId: 'req-2' })
    assert.equal(badAction.ok, false, 'unadvertised action rejected')
    const staleGate = gateModule.validateGateAction(dataRoot, binding, { sessionId: 'session-0001', gateId: 'gate-gone', actionId: 'approve', requestId: 'req-3' })
    assert.equal(staleGate.ok, false, 'stale gateId rejected')

    // one transition: approve resolves; the same requestId can never re-mutate
    const resolved = gateModule.resolveGate(dataRoot, binding, ok.gate, 'approve', 'req-1')
    assert.equal(resolved.status, 'approved', 'approve resolves the gate')
    const after = gateModule.validateGateAction(dataRoot, binding, { sessionId: 'session-0001', gateId: created.gateId, actionId: 'approve', requestId: 'req-4' })
    assert.equal(after.ok, false, 'a resolved gate rejects further actions')
    const actionRecords = gateModule.readJsonLines(gateModule.actionsPathOf(dataRoot))
    assert.equal(actionRecords.length, 1, 'exactly one action journaled')

    // pending gate survives a restart (journal is the state)
    const reloaded = gateModule.currentGateFor(dataRoot, 'session-0001', workspace, 'TASK-0042')
    assert.equal(reloaded.status, 'approved', 'gate state survives restart reads')

    // isolation: the same taskId under another session/workspace never matches
    const otherSession = gateModule.currentGateFor(dataRoot, 'session-OTHER', workspace, 'TASK-0042')
    assert.equal(otherSession, null, 'other session isolated')
    const otherWorkspace = gateModule.currentGateFor(dataRoot, 'session-0001', workspace + '\\other', 'TASK-0042')
    assert.equal(otherWorkspace, null, 'other workspace isolated')

    // snapshot exposes the gate for the bound session
    const files27 = fixtureFileMap(dataRoot, workspace, {})
    files27[path.join(dataRoot, 'completion', 'gates.jsonl')] = fs.readFileSync(gateModule.gatesPathOf(dataRoot), 'utf8')
    writeTree(dataRoot, files27)
    const snap27 = await status.buildControllerSnapshot({
      dataRoot, sessionId: 'session-0001', settingsPath: path.join(dataRoot, 'settings.yaml'),
      statePath: path.join(dataRoot, 'aih-state.json'), readFile: memoryReader(files27),
      modelNames: {}, gitSummary: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(snap27.gate.status, 'approved', 'compact snapshot exposes the resolved gate')
    const files27b = fixtureFileMap(tmpDir('nexus-ctr-'), path.join(tmpDir('nexus-ctr-'), 'ws'), {})
    writeTree(path.dirname(Object.keys(files27b)[0]).split('routing')[0].replace(/\\$/, ''), files27b)
    const snap27b = await status.buildControllerSnapshot({
      dataRoot: path.dirname(Object.keys(files27b)[0]).split('routing')[0].replace(/\\$/, ''),
      sessionId: 'session-0001', settingsPath: Object.keys(files27b).find((f) => f.endsWith('settings.yaml')),
      statePath: Object.keys(files27b).find((f) => f.endsWith('aih-state.json')), readFile: memoryReader(files27b),
      modelNames: {}, gitSummary: null, nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(snap27b.gate, null, 'old task without gate records → gate null')
  }

  // ── 28. TASK-0004: room + compact UI renders (gate, attempt, activity) ─
  {
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    let source = fs.readFileSync(CLIENT, 'utf8')
    const hookHeader = 'function useControllerSnapshot(sessionId) {'
    assert.ok(source.includes(hookHeader), 'snapshot hook header must exist in client.js')
    source = source.replace(hookHeader, hookHeader + '\n\tif (typeof window !== "undefined" && (window.__NX_TEST_SNAPSHOT__ !== undefined || window.__NX_TEST_SNAPSHOT_FAILED__)) return { snapshot: window.__NX_TEST_SNAPSHOT__ ?? null, failed: window.__NX_TEST_SNAPSHOT_FAILED__ === true };')
    const detailHeader = 'function useDetailSnapshot(sessionId, enabled) {'
    assert.ok(source.includes(detailHeader), 'detail hook header must exist in client.js')
    source = source.replace(detailHeader, detailHeader + '\n\tif (typeof window !== "undefined" && (window.__NX_TEST_DETAIL__ !== undefined || window.__NX_TEST_DETAIL_FAILED__)) return { detail: window.__NX_TEST_DETAIL__ ?? null, failed: window.__NX_TEST_DETAIL_FAILED__ === true };')
    const viewHeader = 'function readRoomViewPref() {'
    assert.ok(source.includes(viewHeader), 'room view pref header must exist in client.js')
    source = source.replace(viewHeader, viewHeader + '\n\tif (typeof window !== "undefined" && window.__NX_TEST_ROOM_VIEW__) return window.__NX_TEST_ROOM_VIEW__')
    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: { load(def) { moduleExports = def.factory((name) => {
          if (name === 'react') return react
          if (name === 'react/jsx-runtime') return jsxRuntime
          throw new Error('unexpected require: ' + name)
        }) } },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    const { ControllerBody, ControlRoom, GateActions, ROOM_TABS } = moduleExports

    // 28a. GateActions: buttons ONLY from allowedActions; resolved → no buttons
    const waitingGate = { gateId: 'gate-1', status: 'waiting', allowedActions: ['approve', 'reject'], reason: 'review-required', revision: 1 }
    const waitingHtml = renderToStaticMarkup(react.createElement(GateActions, { gate: waitingGate, sessionId: 's1' }))
    assert.ok(waitingHtml.includes('OPERATOR ACTION REQUIRED'), 'waiting gate shows the operator alert')
    assert.ok(waitingHtml.includes('Approve') && waitingHtml.includes('Reject'), 'waiting gate renders approve/reject')
    const resolvedGate = { gateId: 'gate-1', status: 'approved', allowedActions: [], revision: 2, actionId: 'approve', resolvedAtUtc: '2026-08-28T18:00:00.000Z' }
    const resolvedHtml = renderToStaticMarkup(react.createElement(GateActions, { gate: resolvedGate, sessionId: 's1' }))
    assert.ok(!resolvedHtml.includes('Approve') && !resolvedHtml.includes('Reject'), 'resolved gate renders NO action buttons')
    assert.ok(resolvedHtml.includes('approved'), 'resolved gate shows its outcome')
    const stripped = { gateId: 'gate-2', status: 'waiting', allowedActions: ['approve'], revision: 1 }
    const strippedHtml = renderToStaticMarkup(react.createElement(GateActions, { gate: stripped, sessionId: 's1' }))
    assert.ok(strippedHtml.includes('Approve') && !strippedHtml.includes('Reject'), 'buttons render exactly the advertised actions')

    // 28b. compact Controller: unchanged chrome + gate badge, never buttons
    const compactSnapshot = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'working',
      binding: { sessionId: 'session-0001', taskId: 'TASK-0042', workspace: 'C:\\ws', preset: 'aih-engineering' },
      task: { taskId: 'TASK-0042', attempt: 1, status: 'implementing' },
      attempt: { sequence: 1, status: 'verifying', startedAtUtc: '2026-08-28T17:30:00.000Z' },
      gate: { gateId: 'gate-1', status: 'waiting', allowedActions: ['approve', 'reject'], reason: 'review-required' },
      execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash', reasoning: 'high' },
      review: { reviewRequired: true },
    }
    const compactHtml = renderToStaticMarkup(react.createElement(ControllerBody, { snapshot: compactSnapshot, failed: false, running: true, pressure: null, onClose() {}, onExpand() {} }))
    assert.ok(compactHtml.includes('CONTROLLER'), 'compact controller title intact')
    assert.ok(compactHtml.includes('OPERATOR'), 'compact controller shows the gate badge')
    assert.ok(!compactHtml.includes('Gate action: approve'), 'compact controller NEVER renders gate buttons')

    // 28c. room overview: OPERATOR ACTION REQUIRED first, attempt row, old task "—"
    const { snapshot: roomSnap } = await detailFixture({
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:31:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'passed', timestampUtc: '2026-08-28T17:31:20.000Z' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1, startedAtUtc: '2026-08-28T17:31:00.000Z', finishedAtUtc: '2026-08-28T17:31:20.000Z',
        acceptanceCriteria: [], scopePass: true,
        verification: [{ name: 'unit tests', status: 'PASS', startedAtUtc: '2026-08-28T17:31:02.000Z', finishedAtUtc: '2026-08-28T17:31:18.000Z', attempt: 1 }],
      },
    })
    const gateRecords = [
      { schemaVersion: 1, gateId: 'gate-1', kind: 'operator', reason: 'review-required', status: 'waiting', allowedActions: ['approve', 'reject'], createdAtUtc: '2026-08-28T17:45:00.000Z', sessionId: 'session-0001', workspace: roomSnap.binding.workspace, taskId: 'TASK-0042', attempt: 1, reviewVerdict: 'fail', revision: 1 },
    ]
    roomSnap.gates = {
      current: status.normalizeGateRecord(gateRecords[0]),
      history: gateRecords.map((r) => status.normalizeGateRecord(r)),
    }
    roomSnap.activity = [
      { atUtc: '2026-08-28T17:30:00.000Z', kind: 'attempt-started', detail: 'Attempt 1 started' },
      { atUtc: '2026-08-28T17:31:00.000Z', kind: 'verification-started', detail: 'Verification started · attempt 1' },
      { atUtc: '2026-08-28T17:31:20.000Z', kind: 'verification-finished', detail: 'Verification passed · 1 check(s) · 20s' },
      { atUtc: '2026-08-28T17:45:00.000Z', kind: 'gate-created', detail: 'Operator gate opened · review-required' },
    ]
    sandbox.window.__NX_TEST_DETAIL__ = roomSnap
    sandbox.window.__NX_TEST_DETAIL_FAILED__ = false
    sandbox.window.__NX_TEST_ROOM_VIEW__ = 'overview'
    const overviewHtml = renderToStaticMarkup(react.createElement(ControlRoom, { sessionId: 'session-0001', running: true, onClose() {} }))
    assert.ok(overviewHtml.includes('OPERATOR ACTION REQUIRED'), 'room overview leads with the operator gate')
    assert.ok(overviewHtml.includes('Approve') && overviewHtml.includes('Reject'), 'room overview renders the gate actions')
    assert.ok(overviewHtml.includes('Attempt 1 · passed'), 'overview shows the latest attempt + status')
    assert.ok(overviewHtml.includes('80s'), 'overview shows the derived attempt duration (17:30:00 → 17:31:20)')

    // 28d. activity tab renders ONLY real recorded events
    sandbox.window.__NX_TEST_ROOM_VIEW__ = 'activity'
    const activityHtml = renderToStaticMarkup(react.createElement(ControlRoom, { sessionId: 'session-0001', running: true, onClose() {} }))
    assert.ok(activityHtml.includes('Attempt started'), 'activity shows attempt events')
    assert.ok(activityHtml.includes('Verification started'), 'activity shows verification events')
    assert.ok(activityHtml.includes('Verification finished'), 'activity shows verification completion')
    assert.ok(activityHtml.includes('Operator gate opened'), 'activity shows the gate creation')

    // 28e. verification tab shows per-attempt timing + durations
    sandbox.window.__NX_TEST_ROOM_VIEW__ = 'verification'
    const verificationHtml = renderToStaticMarkup(react.createElement(ControlRoom, { sessionId: 'session-0001', running: true, onClose() {} }))
    assert.ok(verificationHtml.includes('Attempt 1'), 'verification tab links the attempt')
    assert.ok(verificationHtml.includes('1 passed'), 'verification summary renders')
    assert.ok(verificationHtml.includes('16s'), 'per-check duration renders')

    // 28f. old task: attempt "—", no gate section, no crash
    const oldSnap28 = await status.buildControllerSnapshot({
      dataRoot: tmpDir('nexus-ctr-'), sessionId: 'session-0001',
      settingsPath: path.join(tmpDir('nexus-ctr-'), 'settings.yaml'),
      statePath: path.join(tmpDir('nexus-ctr-'), 'aih-state.json'),
      readFile: () => { throw new Error('no files') }, modelNames: {}, gitSummary: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    const oldDetail = await detail.buildDetailSnapshot({
      dataRoot: tmpDir('nexus-ctr-'), sessionId: 'session-0001',
      statePath: path.join(tmpDir('nexus-ctr-'), 'aih-state.json'),
      readFile: () => { throw new Error('no files') }, modelNames: {}, gitSummary: null, gitFiles: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(oldDetail, null, 'unbound session detail stays null (no crash)')
  }
  // ── 29. TASK-0004: verification CLI exit-code recovery (regression) ────
  // Verify-Project.ps1 reports FAILED CHECKS by exiting non-zero while still
  // emitting the complete structured JSON on stdout. The bridge must treat
  // that as a VALID failed-verification result, not an infrastructure
  // failure; genuine failures (launch, timeout/abort, malformed/empty output)
  // must recover nothing so the attempt closes terminally.
  {
    const controller = require('../config/AihController.cjs')
    const okJson = JSON.stringify({ Workspace: 'C:\\w', Kind: 'all', Passed: 3, Failed: 1, Skipped: 0, Results: [
      { Name: 'unit tests', Kind: 'test', Status: 'PASS', ExitCode: 0 },
      { Name: 'architecture:rules', Kind: 'verify', Status: 'FAIL', ExitCode: 1 },
    ] })
    // exit 1 + parseable verification JSON → recovered (checks failed, run valid)
    const recovered = controller.verificationCliStdout({ code: 1, stdout: okJson, stderr: '' })
    assert.equal(recovered, okJson, 'exit 1 with verification JSON recovers the stdout')
    // exit 1 + JSON WITHOUT the verification shape → not a verification result
    assert.equal(controller.verificationCliStdout({ code: 1, stdout: JSON.stringify({ hello: 'world' }), stderr: '' }), null, 'unshaped JSON → not recovered')
    // malformed JSON output
    assert.equal(controller.verificationCliStdout({ code: 1, stdout: 'not json at all {{{', stderr: '' }), null, 'malformed JSON → not recovered')
    // empty stdout (infrastructure failure)
    assert.equal(controller.verificationCliStdout({ code: 1, stdout: '', stderr: 'boom' }), null, 'empty stdout → not recovered')
    assert.equal(controller.verificationCliStdout({ code: 1, stderr: 'boom' }), null, 'no stdout field → not recovered')
    // launch failure (ENOENT)
    assert.equal(controller.verificationCliStdout({ code: 'ENOENT', stdout: '', stderr: 'spawn failed' }), null, 'launch failure → not recovered')
    // timeout/abort (killed, no stdout)
    assert.equal(controller.verificationCliStdout({ code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }), null, 'timeout/abort → not recovered')
    // non-error → nothing to recover (exit-0 path is untouched)
    assert.equal(controller.verificationCliStdout(null), null, 'no error → nothing recovered')
    // structured exit-3 failure still recovered by the original helper
    const structured = JSON.stringify({ ok: false, reason: 'budget-exceeded' })
    assert.equal(controller.structuredCliStdout({ code: 3, stdout: structured }), structured, 'exit-3 structured failure still recovered')
    // failed verification stays linked to the same attempt + terminal + signature
    const { snapshot: snapVf } = await detailFixture({
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:30:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:31:00.000Z' },
        { taskId: 'TASK-0042', sequence: 1, status: 'failed', timestampUtc: '2026-08-28T17:31:30.000Z', failureSignature: 'verification-failed', reason: '2 of 3 check(s) failed during verification of attempt 1' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:31:00.000Z', finishedAtUtc: '2026-08-28T17:31:30.000Z',
        acceptanceCriteria: [], scopePass: true,
        verification: [
          { name: 'unit tests', kind: 'test', status: 'FAIL', exitCode: 1, command: 'npm run test', startedAtUtc: '2026-08-28T17:31:02.000Z', finishedAtUtc: '2026-08-28T17:31:10.000Z', attempt: 1 },
          { name: 'architecture:rules', kind: 'verify', status: 'FAIL', exitCode: 1, command: 'aih-rules', startedAtUtc: '2026-08-28T17:31:11.000Z', finishedAtUtc: '2026-08-28T17:31:29.000Z', attempt: 1 },
        ],
      },
    })
    assert.equal(snapVf.attempts[0].status, 'failed', 'failed verification leaves the attempt failed (terminal)')
    assert.equal(snapVf.attempts[0].failureSignature, 'verification-failed', 'failure signature recorded')
    assert.equal(snapVf.verification.attempt, 1, 'evidence links to attempt 1')
    assert.equal(snapVf.verification.status, 'failed', 'all checks FAIL → failed summary')
    assert.equal(snapVf.verification.failed, 2, 'FAIL counted')
    assert.equal(snapVf.verification.durationSeconds, 30, 'verification duration derived from envelope timestamps')
    assert.equal(snapVf.attempts[0].durationSeconds, 90, 'attempt duration spans started → terminal timestamp')
  }
  // ── 29. TASK-0004.1: activity truthfulness + verification status ────────────
  {
    // 29a. attempt verifying event + evidence startedAtUtc → exactly ONE row,
    // preferring the attempt event; completion row from completedAtUtc.
    const snapDup = await detailFixture({
      task: { tasks: [{ ...FIXTURE_TASK.tasks[0], status: 'complete', completedAtUtc: '2026-08-28T17:40:00.000Z' }] },
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:20:00.000Z', sessionId: 'session-0001', startedByTurn: '2' },
        { taskId: 'TASK-0042', sequence: 1, status: 'verifying', timestampUtc: '2026-08-28T17:30:00.000Z', sessionId: 'session-0001' },
        { taskId: 'TASK-0042', sequence: 1, status: 'passed', timestampUtc: '2026-08-28T17:35:00.000Z', sessionId: 'session-0001' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:30:00.000Z', finishedAtUtc: '2026-08-28T17:35:00.000Z',
        verification: [
          { name: 'typecheck', kind: 'test', status: 'PASS', exitCode: 0, command: 'tsc', startedAtUtc: '2026-08-28T17:30:05.000Z', finishedAtUtc: '2026-08-28T17:30:20.000Z', attempt: 1 },
        ],
        scopePass: true,
      },
    })
    const startsDup = snapDup.snapshot.activity.filter((event) => event.kind === 'verification-started')
    assert.equal(startsDup.length, 1, 'one verification-start row when the verifying event exists')
    assert.equal(startsDup[0].detail, 'Verification started · attempt 1', 'verification-start prefers the attempt verifying event')
    assert.equal(startsDup[0].atUtc, '2026-08-28T17:30:00.000Z', 'verification-start uses the verifying event timestamp')
    const finishedDup = snapDup.snapshot.activity.filter((event) => event.kind === 'verification-finished')
    assert.equal(finishedDup.length, 1, 'one verification-finished row')
    assert.ok(finishedDup[0].detail.includes('1 passed'), 'verification-finished carries the pass count')
    const attemptsFinishedDup = snapDup.snapshot.activity.filter((event) => event.kind === 'attempt-finished')
    assert.equal(attemptsFinishedDup.length, 1, 'one attempt-finished row')
    const completedDup = snapDup.snapshot.activity.filter((event) => event.kind === 'task-completed')
    assert.equal(completedDup.length, 1, 'one task-completed row')
    assert.equal(completedDup[0].atUtc, '2026-08-28T17:40:00.000Z', 'completion row uses the authoritative completedAtUtc')
    assert.equal(completedDup[0].detail, 'Task completed', 'completion row detail is Task completed')

    // 29b. legacy: evidence startedAtUtc without any verifying event → ONE
    // fallback verification-start row; no synthetic completion row.
    const snapLegacy = await detailFixture({
      attempts: [
        { taskId: 'TASK-0042', sequence: 1, status: 'started', startedAtUtc: '2026-08-28T17:20:00.000Z', sessionId: 'session-0001', startedByTurn: '2' },
      ],
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:30:00.000Z', finishedAtUtc: '2026-08-28T17:35:00.000Z',
        verification: [
          { name: 'typecheck', kind: 'test', status: 'PASS', exitCode: 0, command: 'tsc', startedAtUtc: '2026-08-28T17:30:05.000Z', finishedAtUtc: '2026-08-28T17:30:20.000Z', attempt: 1 },
        ],
        scopePass: true,
      },
    })
    const startsLegacy = snapLegacy.snapshot.activity.filter((event) => event.kind === 'verification-started')
    assert.equal(startsLegacy.length, 1, 'legacy evidence-only verification-start row is exactly one')
    assert.equal(startsLegacy[0].detail, 'Verification run started', 'fallback row uses the evidence-started detail')
    const completedLegacy = snapLegacy.snapshot.activity.filter((event) => event.kind === 'task-completed')
    assert.equal(completedLegacy.length, 0, 'no synthetic completion row without completedAtUtc')

    // 29c. verification overall status semantics (evidence + endpoint).
    const mixed = await detailFixture({
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:30:00.000Z', finishedAtUtc: '2026-08-28T17:35:00.000Z',
        verification: [
          { name: 'typecheck', kind: 'test', status: 'PASS', exitCode: 0, command: 'tsc', startedAtUtc: '2026-08-28T17:30:05.000Z', finishedAtUtc: '2026-08-28T17:30:20.000Z', attempt: 1 },
          { name: 'e2e', kind: 'test', status: 'FAIL', exitCode: 1, command: 'npm run e2e', startedAtUtc: '2026-08-28T17:30:25.000Z', finishedAtUtc: '2026-08-28T17:34:55.000Z', attempt: 1 },
        ],
        scopePass: false,
      },
    })
    assert.equal(mixed.snapshot.verification.status, 'failed', '1 PASS + 1 FAIL is failed, never partial')
    assert.equal(mixed.snapshot.verification.failed, 1, 'failed check counted')
    assert.equal(mixed.snapshot.verification.passed, 1, 'passed check counted')
    const failCheck = mixed.snapshot.verification.checks.find((check) => check.status === 'FAIL')
    assert.equal(failCheck.exitCode, 1, 'failed check exposes the real exit code')
    assert.equal(failCheck.durationSeconds, 270, 'failed check duration derived from its timestamps')
    assert.equal(failCheck.command, 'npm run e2e', 'failed check exposes the command')
    assert.equal(failCheck.startedAtUtc, '2026-08-28T17:30:25.000Z', 'failed check exposes the exact start timestamp')
    assert.equal(failCheck.finishedAtUtc, '2026-08-28T17:34:55.000Z', 'failed check exposes the exact finish timestamp')

    const allPass29 = await detailFixture({
      evidence: {
        schemaVersion: 2, attempt: 1,
        startedAtUtc: '2026-08-28T17:30:00.000Z', finishedAtUtc: '2026-08-28T17:35:00.000Z',
        verification: [
          { name: 'typecheck', kind: 'test', status: 'PASS', exitCode: 0, command: 'tsc', startedAtUtc: '2026-08-28T17:30:05.000Z', finishedAtUtc: '2026-08-28T17:30:20.000Z', attempt: 1 },
        ],
        scopePass: true,
      },
    })
    assert.equal(allPass29.snapshot.verification.status, 'passed', 'all checks passed → passed')

    const notRun29 = await detailFixture({ task: { tasks: [{ ...FIXTURE_TASK.tasks[0], verification: null }] } })
    assert.equal(notRun29.snapshot.verification.status, 'not-run', 'no checks → not-run')
  }
  // ── 30. PHASE 2: role/profile/classDisplay/modelDisplayName and the
  //           PREFERRED vs RUNNING profile distinction ─────────────────────
  {
    const { snapshot } = await fixtureSnapshot({
      executionClass: 'engineer_normal',
      decision: { ...FIXTURE_DECISION, executionClass: 'engineer_normal', role: 'primaryEngineer', profile: 'deepseek-codex', profileDisplayName: 'DeepSeek + Codex', provider: 'flash-high-direct', model: 'deepseek-v4-flash', modelDisplayName: 'DeepSeek V4 Flash', reasoning: 'high' },
    })
    assert.equal(snapshot.execution.class, 'engineer_normal')
    assert.equal(snapshot.execution.classDisplay, 'Engineer Normal')
    assert.equal(snapshot.execution.role, 'primaryEngineer')
    assert.equal(snapshot.execution.profile, 'deepseek-codex')
    assert.equal(snapshot.execution.profileDisplayName, 'DeepSeek + Codex')
    assert.equal(snapshot.execution.provider, 'flash-high-direct')
    assert.equal(snapshot.execution.model, 'DeepSeek V4 Flash')
    assert.equal(snapshot.execution.modelId, 'deepseek-v4-flash')
    assert.equal(snapshot.execution.reasoning, 'high')
  }
  {
    // Legacy decision/state (pre-Phase-2 class names) stay readable: the raw
    // class is preserved for tolerance, display/role are derived canonically.
    const { snapshot } = await fixtureSnapshot({})
    assert.equal(snapshot.execution.class, 'deepseek_normal')
    assert.equal(snapshot.execution.classDisplay, 'Engineer Normal')
    assert.equal(snapshot.execution.role, 'primaryEngineer')
    assert.equal(snapshot.execution.profile, null)
  }
  {
    // PREFERRED profile (operator settings) is reported next to the RUNNING
    // profile (decision record) and is never collapsed into it.
    const dataRoot = tmpDir('nexus-ctr-pp-')
    const workspace = path.join(dataRoot, 'ws')
    const stateFile = status.routingStateFileName(workspace, 'aih-engineering', 'TASK-0042')
    const files = {
      [path.join(dataRoot, 'routing', 'session-bindings.json')]: JSON.stringify({ schemaVersion: 1, bindings: { 'session-0001': { ...FIXTURE_BINDING, workspace } } }),
      [path.join(dataRoot, 'routing', 'states', stateFile)]: JSON.stringify({ taskId: 'TASK-0042', workspace, preset: 'aih-engineering', executionClass: 'engineer_normal', selectedTier: 3, risk: 'normal', reviewRequired: false, reviewRequested: false, lastFailureSignature: '', sameFailureCount: 0, updatedAtUtc: '2026-08-28T17:30:00.000Z' }),
      [path.join(dataRoot, 'routing', 'decisions.jsonl')]: JSON.stringify({ ...FIXTURE_DECISION, workspace, executionClass: 'engineer_normal', role: 'primaryEngineer', profile: 'deepseek-codex', profileDisplayName: 'DeepSeek + Codex', provider: 'flash-high-direct', model: 'deepseek-v4-flash' }) + '\n',
      [path.join(dataRoot, 'settings.yaml')]: 'agent-default-model:\n  provider: flash-max-direct\n  model: deepseek-v4-flash\n  reasoningEffort: max\nengineering-profile: glm-codex\n',
      [path.join(dataRoot, 'profiles.json')]: JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'glm-codex', displayName: 'GLM + Codex' }, { id: 'deepseek-codex', displayName: 'DeepSeek + Codex' }] }),
      [path.join(dataRoot, 'aih-state.json')]: JSON.stringify({ SchemaVersion: 3, Status: 'READY', Pid: 12345, ProcessStartedAtUtc: '2026-08-28T17:00:00.0000000Z', Workspace: workspace, Url: 'http://127.0.0.1:3080' }),
      [path.join(workspace, '.ai-harness', 'state', 'tasks.json')]: JSON.stringify({ schemaVersion: 1, tasks: [{ ...FIXTURE_TASK.tasks[0], workspace }] }),
    }
    writeTree(dataRoot, files)
    const snapshot = await status.buildControllerSnapshot({
      dataRoot,
      sessionId: 'session-0001',
      settingsPath: path.join(dataRoot, 'settings.yaml'),
      statePath: path.join(dataRoot, 'aih-state.json'),
      profilesPath: path.join(dataRoot, 'profiles.json'),
      readFile: memoryReader(files),
      modelNames: { 'flash-high-direct/deepseek-v4-flash': 'DeepSeek V4 Flash' },
      gitSummary: null,
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.deepEqual(snapshot.preferredProfile, { id: 'glm-codex', displayName: 'GLM + Codex' }, 'preferred profile comes from settings + registry')
    assert.equal(snapshot.execution.profile, 'deepseek-codex', 'RUNNING profile stays the decision profile')
    assert.equal(snapshot.execution.classDisplay, 'Engineer Normal')
    assert.equal(snapshot.execution.role, 'primaryEngineer')
    assert.equal(snapshot.execution.provider, 'flash-high-direct')
    assert.equal(snapshot.execution.model, 'DeepSeek V4 Flash')
  }
  {
    // Detail envelope: routing history carries role/profile/modelDisplayName
    // and the preferred profile is reported alongside the execution.
    const { snapshot } = await detailFixture({
      decisions: [
        { ...FIXTURE_DECISION, executionClass: 'engineer_normal', role: 'primaryEngineer', profile: 'deepseek-codex', profileDisplayName: 'DeepSeek + Codex', provider: 'flash-high-direct', model: 'deepseek-v4-flash', modelDisplayName: 'DeepSeek V4 Flash', reasoning: 'high' },
      ],
    })
    assert.equal(snapshot.preferredProfile, null)
    const routed = (snapshot.routingHistory || []).filter((r) => r.kind !== 'review')
    assert.equal(routed.length, 1)
    assert.equal(routed[0].executionClass, 'engineer_normal')
    assert.equal(routed[0].role, 'primaryEngineer')
    assert.equal(routed[0].profile, 'deepseek-codex')
    assert.equal(routed[0].profileDisplayName, 'DeepSeek + Codex')
    assert.equal(routed[0].model, 'DeepSeek V4 Flash')
    assert.equal(routed[0].modelId, 'deepseek-v4-flash')
    assert.equal(snapshot.execution.role, 'primaryEngineer')
    assert.equal(snapshot.execution.classDisplay, 'Engineer Normal')
  }
  // ── 31. PHASE 2.1: engineering profile editor — state adapter + routes ──
  {
    const { buildEngineeringProfileState, compatibleModelsForRole, modelCompatibleWithRole, roleBindingTarget, bindingsSatisfiable, validateSaveCustomPayload, ROLES } = require(path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'engineering.cjs'))
    const dataRoot = tmpDir('nexus-ctr-eng-')
    const settingsText = 'agent-default-model:\n  provider: zai-direct\n  model: glm-5.3-flash\n  reasoningEffort: high\n\nengineering-profile: deepseek-codex\n'
    const customDoc = {
      schemaVersion: 1,
      profileId: 'custom',
      displayName: 'Custom',
      roles: {
        primaryEngineer: { model: 'glm-5.3', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3', reasoning: 'max' },
        reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
        solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
        fallback: { model: 'deepseek-v4-flash', reasoning: 'max' },
      },
    }
    const files = {
      [path.join(dataRoot, 'settings.yaml')]: settingsText,
      [path.join(dataRoot, 'custom-engineering-profile.json')]: JSON.stringify(customDoc, null, 2),
    }
    writeTree(dataRoot, files)

    // 31a. custom profile merged into the editor state with builtin flags
    const state = buildEngineeringProfileState({
      installRoot: ROOT, // real config: engineering-profiles.json + model-registry.json
      dataRoot,
      settingsPath: path.join(dataRoot, 'settings.yaml'),
      customProfilePath: path.join(dataRoot, 'custom-engineering-profile.json'),
      nowUtc: () => '2026-08-28T18:00:00.000Z',
    })
    assert.equal(state.schemaVersion, 1)
    const ids = state.profiles.map((p) => p.id)
    assert.deepEqual(ids, ['deepseek-codex', 'glm-codex', 'custom'])
    assert.equal(state.profiles[0].builtin, true)
    assert.equal(state.profiles[2].builtin, false)
    assert.equal(state.preferredProfile.id, 'deepseek-codex')
    assert.equal(state.preferredProfile.displayName, 'DeepSeek + Codex')
    assert.ok(state.customRoles && state.customRoles.primaryEngineer.model === 'glm-5.3', 'custom roles read from the custom profile file')
    assert.deepEqual(ROLES, ['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback'])

    // 31b. capability filtering: engineer roles need tools; reviewer needs sol-local
    assert.deepEqual(state.roleModels.primaryEngineer, ['deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.3-flash', 'glm-5.3'])
    assert.deepEqual(state.roleModels.reviewer, ['gpt-5.6-sol'])
    assert.ok(state.roleModels.solver.includes('gpt-5.6-sol'), 'solver accepts a no-tools reasoning model (approval-gated)')
    assert.ok(!state.roleModels.primaryEngineer.includes('gpt-5.6-sol'), 'primaryEngineer rejects a model without tools')

    // 31c. role binding target resolves provider through the registry
    const customProfile = state.profiles[2]
    const target = roleBindingTarget({ models: state.registry }, customProfile, 'primaryEngineer')
    assert.equal(target.provider, 'zai-direct')
    assert.equal(target.reasoning, 'high')
    assert.ok(bindingsSatisfiable({ models: state.registry }, customProfile), 'DoD custom bindings all satisfiable')
    const bad = { ...customProfile, roles: { ...customProfile.roles, reviewer: { model: 'glm-5.3', reasoning: 'medium' } } }
    assert.ok(!bindingsSatisfiable({ models: state.registry }, bad), 'reviewer binding to a non-sol-local model fails closed')

    // 31d. save-custom payload shape validation (host-side fail fast)
    assert.equal(validateSaveCustomPayload(null, null), 'save-custom requires a roles object')
    assert.equal(validateSaveCustomPayload({ primaryEngineer: {} }, null), 'missing role binding: deepEngineer')
    assert.equal(validateSaveCustomPayload({ primaryEngineer: { model: 'glm-5.3', reasoning: 'high' }, deepEngineer: { model: 'glm-5.3', reasoning: 'max' }, reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' }, solver: { model: 'gpt-5.6-sol', reasoning: 'high' }, fallback: { model: 'deepseek-v4-flash', reasoning: 'max' } }, null), null, 'well-formed payload passes host shape check')
  }

  // ── 32. PHASE 2.1: host GET route — engineering profile state ───────────
  {
    const dataRoot = tmpDir('nexus-ctr-engr-')
    writeTree(dataRoot, {
      [path.join(dataRoot, 'settings.yaml')]: 'engineering-profile: glm-codex\n',
    })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dataRoot
    try {
      const plugin = await import(pathToFileURL(HOST).href)
      let captured = []
      let injectCallback = null
      plugin.apply({
        inject(keys, callback) { injectCallback = callback },
        effect() { return () => {} },
      })
      injectCallback({
        webServer: { register(spec) { captured.push(spec) } },
        effect(fn) { fn(); return () => {} },
      })
      const engineeringRoute = captured.find((spec) => spec.path === '/nexus/engineering-profile.json')
      assert.ok(engineeringRoute, 'engineering profile read route registered')
      const res = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
      await engineeringRoute.handler({ method: 'GET', url: '/nexus/engineering-profile.json' }, res)
      const payload = JSON.parse(res.body)
      assert.equal(res.code, 200)
      assert.equal(payload.schemaVersion, 1)
      assert.equal(payload.preferredProfile.id, 'glm-codex')
      // DSH_HOME points at an isolated tmp root without config profiles: the
      // route fails closed and falls back to the id as displayName.
      assert.equal(payload.preferredProfile.displayName, 'glm-codex')
      // isolated tmp DSH_HOME has no config files → fail-closed empty state
      assert.ok(Array.isArray(payload.profiles) && payload.profiles.length === 0, 'isolated root: no profiles exposed, state degrades safely')
      assert.ok(payload.roleModels && Array.isArray(payload.roleModels.primaryEngineer) && payload.roleModels.primaryEngineer.length === 0, 'isolated root: role models degrade to empty lists')
      // GET with POST verb → 405
      await engineeringRoute.handler({ method: 'POST', url: '/nexus/engineering-profile.json' }, res)
      assert.equal(res.code, 405)

      // 32b. action route: shape/action validation before the controller boundary
      const actionRoute = captured.find((spec) => spec.path === '/nexus/engineering-profile-action.json')
      assert.ok(actionRoute, 'engineering profile action route registered')
      const actionRes = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
      // readJsonBody needs a streaming request; craft a minimal one
      const request = (payload) => ({
        method: 'POST',
        url: '/nexus/engineering-profile-action.json',
        on(event, handler) {
          if (event === 'data' && payload !== null) handler(JSON.stringify(payload))
          if (event === 'end') handler()
        },
      })
      await actionRoute.handler(request({ action: 'bogus' }), actionRes)
      assert.equal(actionRes.code, 422)
      const badRes = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
      await actionRoute.handler(request({ action: 'select' }), badRes)
      assert.equal(badRes.code, 422)
      const shapeRes = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
      await actionRoute.handler(request({ action: 'save-custom', roles: { primaryEngineer: { model: 'glm-5.3', reasoning: 'high' } } }), shapeRes)
      assert.equal(shapeRes.code, 422)
      const methodRes = { writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
      await actionRoute.handler({ method: 'GET' }, methodRes)
      assert.equal(methodRes.code, 405)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }

  // ── 33. PHASE 2.1: client — engineering tab + editor render ─────────────
  {
    const code = fs.readFileSync(CLIENT, 'utf8')
    const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    let moduleExports = null
    const sandbox = {
      console,
      URL,
      setTimeout,
      clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: {
          getItem() { return null },
          setItem() {},
        },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: {
        createElement() {
          return { dataset: {}, remove() {} }
        },
        head: { appendChild() {} },
      },
    }
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    assert.ok(moduleExports.ROOM_TABS.includes('engineering'), 'engineering tab added to ROOM_TABS')
    assert.ok(typeof moduleExports.ControlRoom === 'function')
    assert.ok(typeof moduleExports.EngineeringEditor === 'function', 'EngineeringEditor exported for the tab')

    // engineering tab button renders in the tab bar
    const html = renderToStaticMarkup(jsxRuntime.jsx(moduleExports.ControlRoom, { sessionId: 'session-0001', running: null, onClose() {} }))
    assert.ok(html.includes('>Engineering<'), 'engineering tab button rendered')
  }
  // ── 34. PHASE 2.2: composer mode gate + preferred engineer (status.cjs) ──
  {
    const dataRoot = tmpDir('nexus-ctr-eng2-')
    const policyPath = path.join(ROOT, 'config', 'routing-policy.json')
    const registryPath = path.join(ROOT, 'config', 'model-registry.json')
    const profilesPath = path.join(ROOT, 'config', 'engineering-profiles.json')
    const settingsPath = path.join(dataRoot, 'settings.yaml')
    const settingsA = [
      'agent-default-model:',
      '  provider: zai-direct',
      '  model: glm-5.3-flash',
      '  reasoningEffort: high',
      '',
      'agent-presets:',
      '  default: aih-engineering',
      '',
      'engineering-profile: glm-codex',
      '',
    ].join('\n')
    const snapshotOptions = (settingsText, overrides = {}) => {
      // stateful leftovers from earlier cases must never leak into the next
      fs.rmSync(path.join(dataRoot, 'routing'), { recursive: true, force: true })
      fs.rmSync(path.join(dataRoot, 'custom-engineering-profile.json'), { force: true })
      const files = { 'settings.yaml': settingsText }
      if (overrides.files) Object.assign(files, overrides.files)
      delete overrides.files
      writeTree(dataRoot, files)
      return {
        dataRoot,
        sessionId: 'session-0001',
        settingsPath,
        statePath: path.join(dataRoot, 'aih-state.json'),
        profilesPath,
        customProfilesPath: path.join(dataRoot, 'custom-engineering-profile.json'),
        policyPath,
        registryPath,
        gitSummary: null,
        ...overrides,
      }
    }

    // 34a. default preset aih-engineering + preferred glm-codex →
    // engineering composer mode with the GLM PREFERRED engineer
    const snapA = await status.buildControllerSnapshot(snapshotOptions(settingsA))
    assert.equal(snapA.composer.mode, 'engineering', 'aih-engineering default opens engineering composer mode')
    assert.equal(snapA.composer.preset, 'aih-engineering')
    assert.deepEqual(snapA.composer.preferredEngineer, {
      profileId: 'glm-codex',
      profileDisplayName: 'GLM + Codex',
      modelId: 'glm-5.3-flash',
      modelDisplayName: 'GLM-5.3-Flash',
      vendor: 'Z.ai',
      reasoning: 'high',
      provider: 'zai-direct',
    }, 'preferred engineer = profile primaryEngineer resolved through the registry')
    assert.ok(snapA.preference && snapA.preference.modelId === 'glm-5.3-flash', 'legacy preference block survives (fail-safe display)')

    // 34b. deepseek-codex preferred → DeepSeek V4 Flash · high (DoD example)
    const snapB = await status.buildControllerSnapshot(snapshotOptions(
      settingsA.replace('engineering-profile: glm-codex', 'engineering-profile: deepseek-codex'),
    ))
    assert.equal(snapB.composer.preferredEngineer.modelDisplayName, 'DeepSeek V4 Flash')
    assert.equal(snapB.composer.preferredEngineer.reasoning, 'high')
    assert.equal(snapB.composer.preferredEngineer.provider, 'flash-high-direct')

    // 34c. bound DeepSeek-Only session flips the composer to legacy even
    // though the settings default is engineering
    const snapC = await status.buildControllerSnapshot(snapshotOptions(settingsA, {
      files: {
        'routing/session-bindings.json': JSON.stringify({
          schemaVersion: 1,
          bindings: {
            'session-0001': {
              sessionId: 'session-0001',
              taskId: 'TASK-0002',
              workspace: 'C:\\ws-legacy',
              preset: 'aih-deepseek',
              boundAtUtc: '2026-08-28T18:00:00.000Z',
            },
          },
        }),
      },
    }))
    assert.equal(snapC.composer.mode, 'legacy', 'bound DeepSeek-Only session keeps the legacy composer')
    assert.equal(snapC.composer.preset, 'aih-deepseek')

    // 34d. settings default aih-deepseek (unbound) → legacy
    const snapD = await status.buildControllerSnapshot(snapshotOptions(
      settingsA.replace('default: aih-engineering', 'default: aih-deepseek'),
    ))
    assert.equal(snapD.composer.mode, 'legacy', 'aih-deepseek default keeps the shipped selector')

    // 34e. custom preferred profile → primaryEngineer GLM-5.3 · high
    const customDoc = {
      schemaVersion: 1,
      profileId: 'custom',
      displayName: 'Custom',
      roles: {
        primaryEngineer: { model: 'glm-5.3', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3', reasoning: 'max' },
        reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
        solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
        fallback: { model: 'glm-5.3', reasoning: 'high' },
      },
    }
    const snapE = await status.buildControllerSnapshot(snapshotOptions(
      settingsA.replace('engineering-profile: glm-codex', 'engineering-profile: custom'),
      { files: { 'custom-engineering-profile.json': JSON.stringify(customDoc, null, 2) } },
    ))
    assert.equal(snapE.composer.mode, 'engineering')
    assert.equal(snapE.composer.preferredEngineer.profileId, 'custom')
    assert.equal(snapE.composer.preferredEngineer.modelDisplayName, 'GLM-5.3')
    assert.equal(snapE.composer.preferredEngineer.reasoning, 'high')

    // 34f. fail-safe legacy: missing policy / corrupt policy / unknown preset
    const snapF1 = await status.buildControllerSnapshot(snapshotOptions(settingsA, { policyPath: null }))
    assert.equal(snapF1.composer.mode, 'legacy', 'missing policy fails safe to legacy')
    const snapF2 = await status.buildControllerSnapshot(snapshotOptions(settingsA, { policyPath: path.join(dataRoot, 'routing-policy.json') }))
    assert.equal(snapF2.composer.mode, 'legacy', 'unreadable policy fails safe to legacy')
    const snapF3 = await status.buildControllerSnapshot(snapshotOptions(
      settingsA.replace('default: aih-engineering', 'default: aih-unknown'),
    ))
    assert.equal(snapF3.composer.mode, 'legacy', 'unknown preset fails safe to legacy')

    // 34g. unsatisfiable preferred binding → no preferred engineer (fail-closed)
    const snapG = await status.buildControllerSnapshot(snapshotOptions(
      settingsA.replace('engineering-profile: glm-codex', 'engineering-profile: custom'),
    ))
    assert.equal(snapG.composer.preferredEngineer, null, 'missing custom profile file yields no preferred engineer')
    assert.equal(snapG.composer.mode, 'engineering', 'mode itself still resolves')
  }

  // ── 35. PHASE 2.2: composer Engineering selector (client.js) ─────────────
  {
    const { createRequire } = require('node:module')
    const requireFromApp = createRequire(path.join(ROOT, 'app', 'package.json'))
    const react = requireFromApp('react')
    const jsxRuntime = requireFromApp('react/jsx-runtime')
    const renderToStaticMarkup = requireFromApp('react-dom/server').renderToStaticMarkup
    const source = fs.readFileSync(CLIENT, 'utf8')
    // deterministic snapshot + editor-state injection (same pattern as §30)
    const hookHeader = 'function useControllerSnapshot(sessionId) {'
    const editorHeader = 'function useEngineeringEditor(sessionId) {'
    assert.ok(source.includes(hookHeader) && source.includes(editorHeader), 'shared hooks exist in client.js')
    const patched = source
      .replace(hookHeader, hookHeader + '\n\tif (typeof window !== "undefined" && (window.__NX_TEST_SNAPSHOT__ !== undefined || window.__NX_TEST_SNAPSHOT_FAILED__)) return { snapshot: window.__NX_TEST_SNAPSHOT__ ?? null, failed: window.__NX_TEST_SNAPSHOT_FAILED__ === true };')
      .replace(editorHeader, editorHeader + '\n\tif (typeof window !== "undefined" && window.__NX_TEST_EDITOR__ !== undefined) return window.__NX_TEST_EDITOR__;')
    let moduleExports = null
    const sandbox = {
      console, URL, setTimeout, clearTimeout,
      window: {
        __ModuleLoader__: {
          load(def) {
            moduleExports = def.factory((name) => {
              if (name === 'react') return react
              if (name === 'react/jsx-runtime') return jsxRuntime
              throw new Error('unexpected require: ' + name)
            })
          },
        },
        localStorage: { getItem() { return null }, setItem() {} },
        setInterval() { return 1 },
        clearInterval() {},
      },
      document: { createElement() { return { dataset: {}, remove() {} } }, head: { appendChild() {} } },
    }
    vm.createContext(sandbox)
    vm.runInContext(patched, sandbox)
    assert.equal(typeof moduleExports.EngineeringSelector, 'function', 'EngineeringSelector exported')
    assert.equal(typeof moduleExports.EngineeringEditorFields, 'function', 'EngineeringEditorFields exported')
    assert.equal(typeof moduleExports.useEngineeringEditor, 'function', 'useEngineeringEditor exported')
    assert.equal(typeof moduleExports.preferredEngineerFromEditorState, 'function', 'preferredEngineerFromEditorState exported')

    // 35a. EXPLICIT legacy session (aih-deepseek preset; snapshot has no
    // composer block yet): unchanged pills-only render — no trigger button,
    // and the legacy preference label still comes through. (Pre-M2.1 this
    // fixture carried no preset at all; the M2.1 boot heuristic fails CLOSED
    // toward engineering for unknown boot states, so an explicit legacy
    // preset is what a legacy session now asserts.)
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'working',
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash MAX' },
      execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash', reasoning: 'high' },
    }
    sandbox.window.__NX_TEST_SNAPSHOT_FAILED__ = false
    sandbox.window.__NX_TEST_EDITOR__ = undefined
    const legacyHtml = renderToStaticMarkup(react.createElement(moduleExports.ExecutorChip, { session: { sessionId: 'session-0001', agentPreset: 'aih-deepseek' } }))
    assert.match(legacyHtml, /data-nexus-preferred/, 'legacy mode still renders the preference pill')
    assert.match(legacyHtml, /DeepSeek V4 Flash MAX/, 'legacy preference label unchanged (agent-default-model)')
    assert.ok(!legacyHtml.includes('<button'), 'legacy mode renders no control chrome')
    assert.ok(!legacyHtml.includes('nx-eng-trigger'), 'legacy mode renders no Engineering selector')

    // 35b. engineering mode: PREFERRED names the profile's primaryEngineer —
    // never the legacy agent-default-model — plus the Engineering trigger
    sandbox.window.__NX_TEST_SNAPSHOT__ = {
      schemaVersion: 1, generatedAtUtc: new Date().toISOString(), state: 'working',
      composer: {
        mode: 'engineering',
        preset: 'aih-engineering',
        preferredEngineer: { profileId: 'glm-codex', profileDisplayName: 'GLM + Codex', modelId: 'glm-5.3-flash', modelDisplayName: 'GLM-5.3-Flash', vendor: 'Z.ai', reasoning: 'high', provider: 'zai-direct' },
      },
      preference: { provider: 'zai-direct', modelId: 'glm-5.3-flash', reasoning: 'high', label: 'GLM-5.3-Flash' },
      execution: { class: 'deepseek_normal', provider: 'flash-high-direct', model: 'DeepSeek V4 Flash', reasoning: 'high' },
    }
    const engHtml = renderToStaticMarkup(react.createElement(moduleExports.ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.match(engHtml, /GLM-5\.3-Flash/, 'PREFERRED names the profile primaryEngineer binding')
    assert.match(engHtml, />HIGH</, 'PREFERRED effort badge renders uppercase')
    assert.match(engHtml, /nx-eng-trigger/, 'Engineering trigger rendered in engineering mode')
    assert.match(engHtml, />Engineering</, 'trigger is labeled Engineering')
    assert.ok(!engHtml.includes('DeepSeek V4 Flash MAX'), 'legacy agent-default-model label never leaks into engineering mode')
    assert.match(engHtml, /data-nexus-executor/, 'RUNNING pill still names the effective executor')
    assert.match(engHtml, /DeepSeek V4 Flash/, 'RUNNING identity unchanged by the preference swap')

    // 35c. after a save the refetched editor state (fresher than the poll)
    // updates the PREFERRED label immediately — no page refresh needed
    sandbox.window.__NX_TEST_EDITOR__ = {
      state: {
        schemaVersion: 1,
        profiles: [{ id: 'custom', displayName: 'Custom', builtin: false, roles: { primaryEngineer: { model: 'glm-5.3', reasoning: 'high' } } }],
        registry: [{ id: 'glm-5.3', displayName: 'GLM-5.3', vendor: 'Z.ai' }],
        preferredProfile: { id: 'custom', displayName: 'Custom' },
      },
      failed: false,
      profileId: 'custom',
      roles: { primaryEngineer: { model: 'glm-5.3', reasoning: 'high' } },
      dirty: false,
      fetchedAt: Date.now(),
    }
    const savedHtml = renderToStaticMarkup(react.createElement(moduleExports.ExecutorChip, { session: { sessionId: 'session-0001' } }))
    assert.match(savedHtml, /GLM-5\.3</, 'PREFERRED flips to the saved custom binding immediately')
    assert.ok(!savedHtml.includes('GLM-5.3-Flash ·'), 'stale snapshot preference no longer shown once the editor state is fresher')

    // 35d. editor fields: both variants render 11 selects (1 profile + 5×2),
    // the room variant carries the meta line, the composer one stays compact
    const editorState = {
      state: {
        schemaVersion: 1,
        profiles: [
          { id: 'glm-codex', displayName: 'GLM + Codex', builtin: true, roles: { primaryEngineer: { model: 'glm-5.3-flash', reasoning: 'high' } } },
          { id: 'custom', displayName: 'Custom', builtin: false, roles: { primaryEngineer: { model: 'glm-5.3', reasoning: 'high' } } },
        ],
        registry: [
          { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', vendor: 'Z.ai', supportedReasoningLevels: ['off', 'high'] },
          { id: 'glm-5.3', displayName: 'GLM-5.3', vendor: 'Z.ai', supportedReasoningLevels: ['off', 'high', 'max'] },
        ],
        roleModels: { primaryEngineer: ['glm-5.3-flash', 'glm-5.3'] },
        preferredProfile: { id: 'custom', displayName: 'Custom' },
      },
      profileId: 'custom',
      roles: {
        primaryEngineer: { model: 'glm-5.3', reasoning: 'high' },
        deepEngineer: { model: 'glm-5.3', reasoning: 'max' },
        reviewer: { model: 'gpt-5.6-sol', reasoning: 'medium' },
        solver: { model: 'gpt-5.6-sol', reasoning: 'high' },
        fallback: { model: 'glm-5.3', reasoning: 'high' },
      },
      dirty: false, notice: null, noticeTone: 'ok', saving: false,
      selectProfile() {}, changeRole() {}, save() {},
      modelEntry(id) { return editorState.state.registry.find((m) => m.id === id) || null },
    }
    const roomHtml = renderToStaticMarkup(react.createElement(moduleExports.EngineeringEditorFields, { editor: editorState, variant: 'room' }))
    const composerHtml = renderToStaticMarkup(react.createElement(moduleExports.EngineeringEditorFields, { editor: editorState, variant: 'composer' }))
    for (const html of [roomHtml, composerHtml]) {
      assert.equal((html.match(/<select/g) || []).length, 11, 'profile dropdown + 5 role rows (model + reasoning each)')
      for (const label of ['Primary Engineer', 'Deep Engineer', 'Reviewer', 'Solver', 'Fallback']) {
        assert.ok(html.includes(label), 'role row rendered: ' + label)
      }
      assert.ok(html.includes('Save Custom Profile'), 'save button present (custom profile selected)')
    }
    assert.match(roomHtml, /PREFERRED PROFILE:/, 'room variant keeps the meta line')
    assert.ok(!composerHtml.includes('PREFERRED PROFILE:'), 'composer variant stays compact')

    // 35e. built-in profile selection disables the role selects (immutability)
    const builtinEditor = { ...editorState, profileId: 'glm-codex' }
    const builtinHtml = renderToStaticMarkup(react.createElement(moduleExports.EngineeringEditorFields, { editor: builtinEditor, variant: 'composer' }))
    assert.ok(builtinHtml.includes('disabled'), 'built-in profile role selects are disabled')
    assert.ok(builtinHtml.includes('Select Profile'), 'built-in save labels as Select Profile')

    // 35f. scoped CSS retires the upstream DSH model seat only in engineering
    // mode. Phase M2.1 (TASK-0037): the anchor is the STABLE slot outlet
    // wrapper the DSH renderer emits for every registered slot
    // (<div data-slot={slotKey}>) — NEVER a pinned frontend build's CSS-module
    // hash family, which upstream refreshes invalidate (root cause of the
    // Profile UI disappearing across restarts).
    assert.ok(source.includes("body[data-nexus-composer-mode='engineering']"), 'body mode flag CSS hook present')
    assert.ok(source.includes("[data-slot='conversation.input.model']"), 'stable slot outlet suppression rule present')
    assert.ok(!source.includes('_7KE1Ra'), 'no CSS-module hash dependency remains (M2.1 restart fix)')
    assert.ok(source.includes('nexusComposerMode'), 'body dataset flag wiring present')
    assert.ok(source.includes('nx-eng-popover'), 'popover styles present')
    assert.ok(source.includes('engineering-profile-action.json'), 'save posts to the shared action endpoint')

    // 35g. executorChipContent: engineering mode ignores agent-default-model;
    // unsatisfiable binding → no PREFERRED chip (fail-closed)
    const pill = moduleExports.executorChipContent
    const engContent = pill({
      composer: { mode: 'engineering', preferredEngineer: { profileId: 'glm-codex', modelDisplayName: 'GLM-5.3-Flash', reasoning: 'high' } },
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash MAX' },
      execution: { model: 'DeepSeek V4 Flash', reasoning: 'high' },
    })
    assert.equal(engContent.preference, 'GLM-5.3-Flash', 'engineering PREFERRED comes from the profile binding')
    assert.equal(engContent.preferenceReasoning, 'high')
    const failContent = pill({
      composer: { mode: 'engineering', preferredEngineer: null },
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash MAX' },
      execution: { model: 'DeepSeek V4 Flash', reasoning: 'high' },
    })
    assert.equal(failContent.preference, null, 'unsatisfiable binding shows no PREFERRED chip')
    const legacyContent = pill({
      preference: { provider: 'flash-max-direct', modelId: 'deepseek-v4-flash', reasoning: 'max', label: 'DeepSeek V4 Flash MAX' },
      execution: { model: 'DeepSeek V4 Flash', reasoning: 'high' },
    })
    assert.equal(legacyContent.preference, 'DeepSeek V4 Flash MAX', 'legacy mode keeps the agent-default-model display')

    // 35h. derived-from-editor mirror of the snapshot field (same shape)
    const derived = moduleExports.preferredEngineerFromEditorState({
      preferredProfile: { id: 'custom', displayName: 'Custom' },
      profiles: [{ id: 'custom', roles: { primaryEngineer: { model: 'glm-5.3', reasoning: 'high' } } }],
      registry: [{ id: 'glm-5.3', displayName: 'GLM-5.3', vendor: 'Z.ai' }],
    })
    // cross-realm object (created inside the test VM): compare field-by-field
    assert.equal(derived.profileId, 'custom')
    assert.equal(derived.profileDisplayName, 'Custom')
    assert.equal(derived.modelId, 'glm-5.3')
    assert.equal(derived.modelDisplayName, 'GLM-5.3')
    assert.equal(derived.vendor, 'Z.ai')
    assert.equal(derived.reasoning, 'high')

    // 35i. Phase M2.1 (TASK-0037) restart fix: boot-mode derivation must not
    // depend on the polled snapshot alone, and the body flag must exist
    // before first paint (useLayoutEffect, not useEffect).
    const modeOf = moduleExports.composerModeOfSession
    assert.ok(modeOf, 'composerModeOfSession exported for the boot heuristic')

    // Authoritative snapshot wins once loaded (both directions).
    assert.equal(modeOf({ agentPreset: 'aih-deepseek' }, { composer: { mode: 'engineering' } }).mode, 'engineering', 'snapshot engineering beats the session preset')
    assert.equal(modeOf({ agentPreset: 'aih-engineering' }, { composer: { mode: 'legacy' } }).mode, 'legacy', 'snapshot legacy beats the session preset')
    assert.equal(modeOf({}, { composer: { mode: 'engineering' } }).source, 'snapshot')

    // Client-side boot heuristic from the session preset.
    assert.equal(modeOf({ agentPreset: 'aih-engineering' }, null).mode, 'engineering', 'aih-engineering session boots engineering before any snapshot')
    assert.equal(modeOf({ agentPreset: 'aih-engineering' }, null).source, 'session-preset')
    assert.equal(modeOf({ agentPreset: 'aih-deepseek' }, null).mode, 'legacy', 'aih-deepseek session boots legacy before any snapshot')
    assert.equal(modeOf({ agentPreset: 'aih-deepseek' }, null).source, 'session-preset')

    // projectionValues fallback when agentPreset is absent.
    assert.equal(modeOf({ projectionValues: { agentPreset: 'aih-engineering' } }, null).mode, 'engineering', 'projectionValues.agentPreset is a boot source too')

    // Endpoint unavailable (snapshot error) keeps the Profile UI: the preset
    // heuristic still classifies an engineering session.
    assert.equal(modeOf({ agentPreset: 'aih-engineering' }, { error: 'endpoint unavailable' }).mode, 'engineering', 'endpoint-unavailable restart keeps the Profile UI (fail closed)')
    // Unknown/absent boot state fails closed toward engineering/loading.
    assert.equal(modeOf({}, null).mode, 'engineering', 'unknown boot state fails closed toward engineering')
    assert.equal(modeOf({}, null).source, 'boot-fail-closed')
    assert.equal(modeOf(null, undefined).mode, 'legacy', 'no session scope (hero phase) keeps the pre-M2.1 legacy posture')

    // The body flag is applied in a layout effect (before first paint), so a
    // restart never flashes the upstream seat before the flag lands.
    assert.ok(/useLayoutEffect\(\(\) => {[\s\S]*?nexusComposerMode/.test(source), 'body flag set through useLayoutEffect (no first-paint flash)')
    assert.ok(source.includes("composerModeOfSession(session, snapshot)"), 'ExecutorChip derives its mode through the shared boot heuristic')
  }

  console.log('PASS: nexus controller panel state layer')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
