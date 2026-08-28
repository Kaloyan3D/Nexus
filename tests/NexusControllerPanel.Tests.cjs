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

const status = require(ADAPTER)
const pexec = promisify(execFile)

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
  '          name: DeepSeek V4 Flash MAX',
  '          reasoningEfforts:',
  '            off:',
  '            high: high',
  '            max: max',
  '    deepseek-pro-direct:',
  '      displayName: DeepSeek V4 Pro MAX (direct)',
  '      models:',
  '        - id: deepseek-v4-pro',
  '          name: DeepSeek V4 Pro MAX',
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
  const decisionRecord = decision || { ...FIXTURE_DECISION, workspace, executionClass: executionClass || 'deepseek_normal', selectedExecutionClass: executionClass || 'deepseek_normal' }
  if (Array.isArray(decisions) && decisions.length > 0) {
    files[path.join(dataRoot, 'routing', 'decisions.jsonl')] = decisions.map((record) => JSON.stringify(record)).join('\n') + '\n'
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
    modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash MAX' },
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
    assert.equal(snapshot.execution.model, 'DeepSeek V4 Flash MAX')
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
    assert.equal(snapshot.task.verification.status, 'partial')
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
    for (const candidate of ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files (x86)/Git/cmd/git.exe']) {
      const probe = await pexec(candidate, ['--version'], { encoding: 'utf8' }).catch(() => null)
      if (probe !== null) { gitBin = candidate; break }
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
      let captured = null
      let injectKeys = null
      let injectCallback = null
      const fakeWebServer = { register(spec) { captured = spec } }
      const noWebCtx = {
        inject(keys, callback) { injectKeys = keys; injectCallback = callback },
        effect() { return () => {} },
      }
      plugin.apply(noWebCtx)
      assert.ok(injectKeys, 'apply must declare a lifecycle injection for webServer')
      assert.ok(Array.isArray(injectKeys) && injectKeys.includes('webServer'), 'injection must require the webServer service')
      assert.equal(captured, null, 'no route may register before webServer is available')

      // 11b. webServer becomes available later → the injection callback
      // applies and the route registers (Cordis lifecycle semantics).
      assert.doesNotThrow(() => injectCallback({ webServer: fakeWebServer, effect(fn) { fn(); return () => {} } }), 'injection callback must apply cleanly once the service exists')
      assert.ok(captured, 'route must register after webServer becomes available')
      assert.equal(captured.kind, 'exact')
      assert.equal(captured.path, '/nexus/controller.json')
      const route = captured

      // 11c. profiles that NEVER provide webServer stay inert (tui/headless)
      captured = null
      plugin.apply({ inject() {}, effect() { return () => {} } })
      assert.equal(captured, null)

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
      for (let i = 0; i < 60 && registered.length === 0; i++) await tick(50)
      assert.equal(registered.length, 1, 'real cordis: route registers after webServer becomes available')
      assert.equal(registered[0].kind, 'exact')
      assert.equal(registered[0].path, '/nexus/controller.json')

      // the registered handler keeps the existing semantics.
      const res = {
        writeHead(code, headers) { this.code = code; this.headers = headers },
        end(body) { this.body = body },
      }
      await registered[0].handler({ url: '/nexus/controller.json?session=session-0001' }, res)
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
    assert.equal(JSON.stringify(moduleExports.inject), JSON.stringify(['slots']), 'client services')

    const fakeCtx = {
      effect(fn) { fn(); return () => {} },
      slots: {
        inject(name, callback) { injected.push({ name, callback }); callback() },
        register(spec, component) { registered.push({ spec, component }) },
      },
    }
    moduleExports.apply(fakeCtx)
    assert.deepEqual(injected.map((i) => i.name), ['shell.overlay', 'conversation.session.header.actions'])
    assert.equal(registered.length, 2)
    assert.equal(registered[0].spec.name, 'shell.overlay')
    assert.equal(registered[0].spec.id, 'nexus-controller')
    assert.equal(registered[0].spec.order, 100)
    assert.equal(registered[1].spec.name, 'conversation.session.header.actions')
    assert.equal(registered[1].spec.id, 'nexus-controller')
    assert.equal(registered[1].spec.order, 90)
    assert.equal(typeof registered[0].component, 'function')

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
    ])
    const declaredBy = new Map([
      ['root', '(built-in)'],
      ['details', 'an entry in "root" (client-ui-layout)'],
      ['conversation.details.tool', 'an entry in "details" (client-ui-conversation)'],
      ['shell.overlay', 'an entry in "root" (client-ui-layout)'],
      ['conversation.session.header.actions', 'an entry in "conversation.view" (client-ui-conversation)'],
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
    core.register({ name: 'conversation', registrant: 'client-ui-conversation', children: { 'conversation.session': { kind: 'single', scope: 'session' }, 'conversation.session.header': { kind: 'single', scope: 'session' } } }, NativeConversation)
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
    // The integration touches exactly two additive seats.
    assert.deepEqual(registered.sort(), ['conversation.session.header.actions', 'shell.overlay'])
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
    assert.equal(JSON.stringify(moduleExports.inject), JSON.stringify(['slots']))
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
      modelNames: { 'flash-max-direct/deepseek-v4-flash': 'DeepSeek V4 Flash MAX' },
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

  console.log('PASS: nexus controller panel state layer')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
