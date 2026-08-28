'use strict'

/**
 * Renders the REAL ControllerDrawer component (lib/client.js) to static markup
 * for visual verification. The drawer registers into the ADDITIVE shell.overlay
 * list seat (the details seat is native-only — never touched by the plugin).
 *
 * The bundle is loaded in a VM exactly as the browser would load it (same
 * ModuleLoader shape, real react/react-dom from the app closure). The only
 * transform is a TEST-ONLY early return inside useControllerSnapshot that
 * serves a caller-provided snapshot instead of polling — the component tree,
 * styles, state mapping and markup all come from the real code. Nothing here
 * is shipped or loaded by the product.
 *
 * Usage:
 *   node render-panel-markup.cjs <output.json>
 *
 * Output: { css, variants: { name: html }, toggles: { open, closed } }
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const CLIENT = path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'client.js')
const ADAPTER = path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'status.cjs')
const requireFromApp = require('node:module').createRequire(path.join(ROOT, 'app', 'package.json'))
const react = requireFromApp('react')
const jsxRuntime = requireFromApp('react/jsx-runtime')
const { renderToStaticMarkup } = requireFromApp('react-dom/server')
const status = require(ADAPTER)
const detail = require(path.join(ROOT, 'ui', 'nexus-controller', 'lib', 'detail.cjs'))

const HOOK_HEADER = 'function useControllerSnapshot(sessionId) {'
const HOOK_PATCHED =
  'function useControllerSnapshot(sessionId) {\n' +
  "    if (typeof window !== 'undefined' && (window.__NX_TEST_SNAPSHOT__ !== undefined || window.__NX_TEST_FAILED__)) {\n" +
  '      return { snapshot: window.__NX_TEST_SNAPSHOT__ ?? null, failed: window.__NX_TEST_FAILED__ === true }\n' +
  '    }'

const DETAIL_HOOK_HEADER = 'function useDetailSnapshot(sessionId, enabled) {'
const DETAIL_HOOK_PATCHED =
  'function useDetailSnapshot(sessionId, enabled) {\n' +
  "    if (typeof window !== 'undefined' && (window.__NX_TEST_DETAIL__ !== undefined || window.__NX_TEST_DETAIL_FAILED__)) {\n" +
  '      return { detail: window.__NX_TEST_DETAIL__ ?? null, failed: window.__NX_TEST_DETAIL_FAILED__ === true }\n' +
  '    }'
const VIEW_PREF_HEADER = 'function readRoomViewPref() {'
const VIEW_PREF_PATCHED =
  'function readRoomViewPref() {\n' +
  "    if (typeof window !== 'undefined' && window.__NX_TEST_ROOM_VIEW__) return window.__NX_TEST_ROOM_VIEW__"

function loadBundle() {
  let source = fs.readFileSync(CLIENT, 'utf8')
  if (!source.includes(HOOK_HEADER)) throw new Error('renderer: hook header not found; client.js changed')
  source = source.replace(HOOK_HEADER, HOOK_PATCHED)
  if (!source.includes(DETAIL_HOOK_HEADER)) throw new Error('renderer: detail hook header not found; client.js changed')
  source = source.replace(DETAIL_HOOK_HEADER, DETAIL_HOOK_PATCHED)
  if (!source.includes(VIEW_PREF_HEADER)) throw new Error('renderer: view pref header not found; client.js changed')
  source = source.replace(VIEW_PREF_HEADER, VIEW_PREF_PATCHED)

  const registered = []
  const moduleExports = { value: null }
  const sandboxWindow = {
    __NX_TEST_SNAPSHOT__: undefined,
    __NX_TEST_FAILED__: undefined,
    __NX_TEST_DETAIL__: undefined,
    __NX_TEST_DETAIL_FAILED__: undefined,
    __NX_TEST_ROOM_VIEW__: undefined,
    __ModuleLoader__: {
      load(def) {
        moduleExports.value = def.factory((name) => {
          if (name === 'react') return react
          if (name === 'react/jsx-runtime') return jsxRuntime
          throw new Error('renderer: unexpected require ' + name)
        })
      },
    },
    localStorage: { getItem() { return null }, setItem() {} },
    setInterval() { return 1 },
    clearInterval() {},
  }
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    window: sandboxWindow,
    document: {
      createElement() { return { dataset: {}, remove() {} } },
      head: { appendChild() {} },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  // apply() to capture the details-seat registration + the injected stylesheet
  let panelCss = ''
  const fakeCtx = {
    effect(fn) { const dispose = fn(); return dispose || (() => {}) },
    slots: {
      inject(name, callback) {
        if (name === 'shell.overlay') callback()
        else if (name === 'conversation.session.header.actions') callback()
      },
      register(spec, component) { registered.push({ spec, component }) },
    },
  }
  const styleProbe = {
    dataset: {},
    set textContent(value) { panelCss = value },
    remove() {},
  }
  sandbox.document.createElement = () => styleProbe
  sandbox.document.head.appendChild = () => {}
  moduleExports.value.apply(fakeCtx)
  if (!panelCss) throw new Error('renderer: no panel stylesheet captured')
  const overlay = registered.find((r) => r.spec.name === 'shell.overlay')
  const actions = registered.find((r) => r.spec.name === 'conversation.session.header.actions')
  if (!overlay || !actions) throw new Error('renderer: seat registrations missing')
  return { Drawer: overlay.component, Toggle: actions.component, Room: moduleExports.value && moduleExports.value.ControlRoom, css: panelCss, window: sandboxWindow }
}

function renderVariant(bundle, snapshot, { running = false, pressure, failed = false } = {}) {
  bundle.window.__NX_TEST_SNAPSHOT__ = snapshot
  bundle.window.__NX_TEST_FAILED__ = failed
  bundle.window.__NX_TEST_DETAIL__ = undefined
  bundle.window.__NX_TEST_DETAIL_FAILED__ = undefined
  bundle.window.__NX_TEST_ROOM_VIEW__ = undefined
  const session = { current: 'session-visual', byId: { 'session-visual': { running } } }
  if (pressure !== undefined) {
    session.byId['session-visual'].projections = { values: { contextPressure: pressure } }
  }
  const useSessions = (selector) => selector(session)
  return renderToStaticMarkup(react.createElement(bundle.Drawer, { useSessions }))
}

function renderRoomVariant(bundle, detail, view, { running = false, failed = false } = {}) {
  bundle.window.__NX_TEST_DETAIL__ = detail
  bundle.window.__NX_TEST_DETAIL_FAILED__ = failed
  bundle.window.__NX_TEST_ROOM_VIEW__ = view
  bundle.window.__NX_TEST_SNAPSHOT__ = undefined
  bundle.window.__NX_TEST_FAILED__ = false
  return renderToStaticMarkup(react.createElement(bundle.Room, { sessionId: 'session-visual', running, onClose() {} }))
}

async function main() {
  const outPath = process.argv[2]
  if (!outPath) throw new Error('usage: node render-panel-markup.cjs <output.json>')
  const bundle = loadBundle()
  const { Drawer, Toggle, css } = bundle

  const variants = {}

  // 1. LIVE controller state for the current session (real data root).
  const { execFile } = require('node:child_process')
  const { promisify } = require('node:util')
  const pexec = promisify(execFile)
  const execGit = (command, args, options) => new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })
  const liveGit = await status.collectGitSummary('C:\\AI-Harness', execGit).catch(() => null)
  let liveModelNames = {}
  try {
    const yaml = requireFromApp('js-yaml')
    const document = yaml.load(fs.readFileSync(path.join(ROOT, 'data', 'settings.yaml'), 'utf8'))
    const providers = document['llm-pi-ai'] && document['llm-pi-ai'].providers
    for (const [providerId, provider] of Object.entries(providers || {})) {
      for (const model of provider.models || []) {
        if (model.id && model.name) liveModelNames[providerId + '/' + model.id] = model.name
      }
    }
  } catch { /* fall back to prettified ids */ }
  const liveSnapshot = await status.buildControllerSnapshot({
    dataRoot: path.join(ROOT, 'data'),
    sessionId: 'session-239a6df4-46da-4537-9622-99c1e7eaf6b5',
    statePath: path.join(ROOT, 'data', 'aih-state.json'),
    modelNames: liveModelNames,
    gitSummary: liveGit,
    nowUtc: () => new Date().toISOString(),
  })
  variants['live-working'] = renderVariant(bundle, liveSnapshot, { running: true, pressure: { projectedTokens: 18400, contextWindow: 200000 } })

  // 2. idle: no binding.
  variants.idle = renderVariant(bundle, {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    state: 'idle',
    binding: null,
    task: null,
    execution: null,
    review: null,
    controller: { status: 'READY', pid: 11484 },
    git: null,
  })

  // 3. complete: ledger complete + verification passed.
  const complete = JSON.parse(JSON.stringify(liveSnapshot))
  complete.state = 'complete'
  complete.task.status = 'complete'
  complete.task.verification = {
    status: 'passed', passed: 2, failed: 0, skipped: 0, total: 2,
    checks: [
      { name: 'Typecheck', status: 'PASS', evidence: '' },
      { name: 'Tests', status: 'PASS', evidence: '' },
    ],
    required: [],
  }
  variants.complete = renderVariant(bundle, complete, { running: false })

  // 4. failed: ledger failed + a failing verification check.
  const failed = JSON.parse(JSON.stringify(complete))
  failed.state = 'failed'
  failed.task.status = 'failed'
  failed.task.verification = {
    status: 'failed', passed: 1, failed: 1, skipped: 0, total: 2,
    checks: [
      { name: 'Typecheck', status: 'PASS', evidence: '' },
      { name: 'Lint', status: 'FAIL', evidence: '' },
    ],
    required: [],
  }
  failed.task.attempt = 3
  variants.failed = renderVariant(bundle, failed, { running: false })

  // 5. reviewing: codex_review + running (pulse animation present).
  const reviewing = JSON.parse(JSON.stringify(complete))
  reviewing.state = 'reviewing'
  reviewing.execution.class = 'codex_review'
  reviewing.task.status = 'implementing'
  reviewing.task.verification = { status: 'not-run', passed: 0, failed: 0, skipped: 0, total: 0, checks: [], required: [] }
  reviewing.task.attempt = 1
  reviewing.review = { codexCalls: 1, reviewRequested: true, required: true }
  variants.reviewing = renderVariant(bundle, reviewing, { running: true })

  // 6. unavailable-transport: fetch failure — UNAVAILABLE, never IDLE.
  variants['unavailable-transport'] = renderVariant(bundle, null, { failed: true })

  // 8. CONTROL ROOM variants from a LIVE detail snapshot (real data root).
  const liveDetail = await detail.buildDetailSnapshot({
    dataRoot: path.join(ROOT, 'data'),
    sessionId: 'session-239a6df4-46da-4537-9622-99c1e7eaf6b5',
    statePath: path.join(ROOT, 'data', 'aih-state.json'),
    modelNames: liveModelNames,
    gitSummary: liveGit,
    gitFiles: await detail.collectGitFiles(path.join(ROOT), execGit),
    nowUtc: () => new Date().toISOString(),
  })
  if (!bundle.Room) throw new Error('renderer: ControlRoom export missing; client.js changed')
  variants['room-overview'] = renderRoomVariant(bundle, liveDetail, 'overview', { running: true })
  variants['room-activity'] = renderRoomVariant(bundle, liveDetail, 'activity', { running: true })
  variants['room-verification'] = renderRoomVariant(bundle, liveDetail, 'verification', { running: true })
  variants['room-files'] = renderRoomVariant(bundle, liveDetail, 'files', { running: true })
  variants['room-unavailable'] = renderRoomVariant(bundle, null, 'overview', { failed: true })

  // 7. unavailable-error: the host could not build a snapshot (envelope error).
  variants['unavailable-error'] = renderVariant(bundle, {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    state: 'idle',
    binding: null,
    task: null,
    execution: null,
    review: null,
    controller: null,
    git: null,
    error: 'controller-state-unavailable',
  })

  // Toggle in open and closed states.
  bundle.window.__NX_TEST_SNAPSHOT__ = undefined
  bundle.window.__NX_TEST_FAILED__ = false
  const toggleOpen = renderToStaticMarkup(react.createElement(Toggle, { sessionId: 'session-visual' }))
  const toggleClosed = renderToStaticMarkup(react.createElement(Toggle, { sessionId: 'session-visual' }))

  const output = { css, variants, toggles: { open: toggleOpen, closed: toggleClosed } }
  fs.writeFileSync(outPath, JSON.stringify(output), 'utf8')
  console.log('rendered variants:', Object.keys(variants).join(', '))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
