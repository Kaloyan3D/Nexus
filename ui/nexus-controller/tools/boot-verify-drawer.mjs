// Boot verification for the @nexus/controller drawer (TASK-0002 repair).
// Boots the ACTUAL live client composition (headless Edge via CDP) and verifies:
//   1. the composition loads with NO single-slot loader error;
//   2. the controller toggle renders in the session header actions;
//   3. the controller drawer opens with REAL controller data;
//   4. the native details column still mounts the native DetailsPanel
//      (the controller does NOT shadow it);
//   5. coherence: opening the native details column closes the drawer;
//   6. toggle open/close + Escape close still work;
//   7. tool rows still render/expand (input + output visible);
//   8. narrow viewport: the drawer clamps to the window.
//
// Usage: node boot-verify-drawer.mjs <out-dir>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9335
const PROFILE = path.join(os.tmpdir(), 'nexus-boot-profile-' + Date.now())
const [outDir] = process.argv.slice(2)
if (!outDir) { console.error('usage: node boot-verify-drawer.mjs <out-dir>'); process.exit(1) }
fs.mkdirSync(outDir, { recursive: true })

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

// Kill stray Edge instances first: a running singleton swallows new
// invocations and the CDP endpoint never comes up.
async function killStrayEdge() {
  const { execFile } = await import('node:child_process')
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('tasklist', ['/FI', 'IMAGENAME eq msedge.exe', '/FO', 'CSV'], (err, out) => err ? reject(err) : resolve({ stdout: out }))
    })
    const pids = [...stdout.matchAll(/"msedge\.exe","(\d+)"/g)].map((m) => Number(m[1]))
    for (const pid of new Set(pids)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    console.log('killed stray Edge processes:', new Set(pids).size)
  } catch (error) {
    console.log('stray-edge scan skipped:', error.message)
  }
  await sleep(500)
}

async function launch() {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1920,1080', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return { child, wsUrl: page.webSocketDebuggerUrl }
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('CDP endpoint did not come up')
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.consoleErrors = []
    this.exceptions = []
    this.httpFailures = []
    this.controllerFetches = []
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const entry = this.pending.get(message.id)
        if (entry) {
          this.pending.delete(message.id)
          message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
        }
      } else {
        this.events.push(message)
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
          this.consoleErrors.push(JSON.stringify(message.params.args || []).slice(0, 400))
        }
        if (message.method === 'Runtime.exceptionThrown') {
          this.exceptions.push((message.params.exceptionDetails && message.params.exceptionDetails.text || '') + ' ' + (message.params.exceptionDetails && message.params.exceptionDetails.exception && message.params.exceptionDetails.exception.description || ''))
        }
        if (message.method === 'Network.loadingFailed') {
          this.httpFailures.push('loadingFailed: ' + message.params.errorText + ' ' + (message.params.blockedReason || ''))
        }
        if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
          this.httpFailures.push('http ' + message.params.response.status + ' ' + message.params.response.url.slice(0, 160))
        }
        if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('nexus/controller.json')) {
          this.controllerFetches.push(message.params.request.url)
        }
      }
    }
  }
  async open() {
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function main() {
  await killStrayEdge()
  const { child, wsUrl } = await launch()
  const cdp = new Cdp(wsUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  // Seed the app's OWN persisted current-session key so the fresh profile
  // resumes the controller-bound session (session-239a6df4 = TASK-0002)
  // instead of creating an unbound one. Runs before any page script.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      try {
        const bound = 'session-239a6df4-46da-4537-9622-99c1e7eaf6b5'
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: bound }))
      } catch (e) {}
    })()`,
  })
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080' })

  const evalInPage = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
    return r.result.value
  }
  const shot = async (name) => {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(res.data, 'base64'))
    console.log('shot:', name + '.png')
  }

  // wait for the shell + composer (boot can take 10-40s)
  let composerReady = false
  for (let i = 0; i < 160; i++) {
    const state = await evalInPage('!!document.querySelector("[data-composer-card]")')
    if (state === true) { composerReady = true; break }
    await sleep(500)
  }
  console.log('composer ready:', composerReady)
  await sleep(4000)

  // 1. loader error check
  const loaderError = [...cdp.consoleErrors, ...cdp.exceptions, ...cdp.httpFailures].filter((t) => /already has a registration|failed to apply loader entry|not declared|composition/i.test(t))
  console.log('loader errors:', JSON.stringify(loaderError))
  console.log('console errors:', JSON.stringify(cdp.consoleErrors.slice(0, 5)))
  console.log('http failures:', JSON.stringify(cdp.httpFailures.slice(0, 10)))

  // 2. toggle presence
  const toggleInfo = await evalInPage(`(() => {
    const toggle = document.querySelector('[aria-label="Controller panel"][type="button"]')
    if (!toggle) return null
    const actions = toggle.closest('[data-slot="conversation.session.header.actions"]') ? 'in-header-actions' : 'elsewhere'
    return { inActions: actions, pressed: toggle.getAttribute('aria-pressed'), title: toggle.getAttribute('title') }
  })()`)
  console.log('toggle:', JSON.stringify(toggleInfo))

  // 3. drawer auto-open + real data
  let drawerSeen = false
  for (let i = 0; i < 40; i++) {
    const present = await evalInPage('!!document.querySelector("[data-nexus-drawer]")')
    if (present) { drawerSeen = true; break }
    await sleep(500)
  }
  console.log('drawer auto-open seen:', drawerSeen)
  // wait for real data to arrive (poll 1.5s cadence + render)
  for (let i = 0; i < 12; i++) {
    const hasTask = await evalInPage('!!document.querySelector("[data-nexus-drawer]") && (document.querySelector("[data-nexus-drawer]").textContent.includes("TASK-0002") || document.querySelector("[data-nexus-drawer]").textContent.includes("No managed task"))')
    if (hasTask) break
    await sleep(1000)
  }
  const drawerInfo = await evalInPage(`(() => {
    const drawer = document.querySelector('[data-nexus-drawer]')
    if (!drawer) return null
    return {
      text: drawer.textContent.replace(/\s+/g, ' ').slice(0, 400),
      hasController: drawer.textContent.includes('CONTROLLER'),
      hasTask: drawer.textContent.includes('TASK-0002'),
      hasModel: drawer.textContent.includes('DeepSeek'),
      hasPill: /IDLE|STARTING|WORKING|WAITING|VERIFYING|REVIEWING|REPAIRING|COMPLETE|FAILED/.test(drawer.textContent),
    }
  })()`)
  console.log('drawer info:', JSON.stringify(drawerInfo, null, 1))
  console.log('controller fetches:', JSON.stringify(cdp.controllerFetches.slice(0, 4)))
  await shot('1-boot-drawer-open')

  // 4. native details cell intact
  const detailsInfo = await evalInPage(`(() => {
    const cell = document.querySelector('[data-slot="details"]')
    if (!cell) return null
    const text = cell.textContent.replace(/\s+/g, ' ').trim()
    return { text: text.slice(0, 300), hasNativeEmpty: text.includes('Click a tool row') || text.includes('详情'), hasControllerTitle: text.includes('CONTROLLER') }
  })()`)
  console.log('details cell:', JSON.stringify(detailsInfo))

  // 5. coherence: force the native details column open -> drawer closes.
  //    Snapshot the pristine grid template + column width first and restore them
  //    EXACTLY afterwards (clearing inline styles is not enough — the column must
  //    measurably return to its closed width before the toggle step).
  const pristine = await evalInPage(`(() => {
    const cell = document.querySelector('[data-slot="details"]')
    const column = cell ? cell.parentElement : null
    let grid = column ? column.parentElement : null
    while (grid && getComputedStyle(grid).display !== 'grid') grid = grid.parentElement
    return {
      gridInline: grid ? grid.style.gridTemplateColumns : null,
      gridComputed: grid ? getComputedStyle(grid).gridTemplateColumns : null,
      columnInline: column ? column.style.width : null,
      columnWidth: column ? column.getBoundingClientRect().width : null,
      tag: grid ? grid.tagName : null,
      cls: grid ? String(grid.className).slice(0, 80) : null,
    }
  })()`)
  console.log('pristine grid:', JSON.stringify(pristine))
  const coherence = await evalInPage(`(() => {
    const cell = document.querySelector('[data-slot="details"]')
    const column = cell ? cell.parentElement : null
    let grid = column ? column.parentElement : null
    while (grid && getComputedStyle(grid).display !== 'grid') grid = grid.parentElement
    if (!column || !grid) return 'no-grid'
    column.style.width = '360px'
    column.style.minWidth = '360px'
    grid.style.gridTemplateColumns = '288px minmax(0,1fr) 360px'
    return 'forced-open'
  })()`)
  console.log('coherence force:', coherence)
  await sleep(1200)
  const drawerAfterDetails = await evalInPage('!!document.querySelector("[data-nexus-drawer]")')
  console.log('drawer after details opened:', drawerAfterDetails, '(expect false)')
  const nativeDetailsOpen = await evalInPage(`(() => {
    const cell = document.querySelector('[data-slot="details"]')
    return cell ? cell.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : null
  })()`)
  console.log('native details text while open:', nativeDetailsOpen)
  await shot('2-details-open-drawer-closed')
  // restore the exact pristine layout
  await evalInPage(`(() => {
    const cell = document.querySelector('[data-slot="details"]')
    const column = cell ? cell.parentElement : null
    let grid = column ? column.parentElement : null
    while (grid && getComputedStyle(grid).display !== 'grid') grid = grid.parentElement
    if (grid && ${JSON.stringify(pristine.gridInline)} !== null) grid.style.gridTemplateColumns = ${JSON.stringify(pristine.gridInline)}
    if (column) { column.style.width = ${JSON.stringify(pristine.columnInline)}; column.style.minWidth = '' }
    return 'restored'
  })()`)
  // wait until the details column measurably closes (<= 2px) — the app may
  // re-render and settle asynchronously
  for (let i = 0; i < 20; i++) {
    const w = await evalInPage(`(() => {
      const cell = document.querySelector('[data-slot="details"]')
      return cell ? cell.parentElement.getBoundingClientRect().width : -1
    })()`)
    if (w <= 2) break
    await sleep(400)
  }
  const closedWidth = await evalInPage(`(() => {
    const cell = document.querySelector('[data-slot="details"]')
    return cell ? cell.parentElement.getBoundingClientRect().width : -1
  })()`)
  console.log('details column width after restore:', closedWidth, '(expect <= 2)')

  // 6. toggle reopens, Escape closes
  await evalInPage("document.querySelector('[aria-label=\"Controller panel\"][type=\"button\"]').click(); 'clicked'")
  await sleep(700)
  const reopened = await evalInPage('!!document.querySelector("[data-nexus-drawer]")')
  console.log('toggle reopen:', reopened, '(expect true)')
  await evalInPage('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"')
  await sleep(700)
  const afterEsc = await evalInPage('!!document.querySelector("[data-nexus-drawer]")')
  console.log('after Escape:', afterEsc, '(expect false)')
  await evalInPage("document.querySelector('[aria-label=\"Controller panel\"][type=\"button\"]').click(); 'clicked'")
  await sleep(700)
  const reopened2 = await evalInPage('!!document.querySelector("[data-nexus-drawer]")')
  console.log('toggle reopen #2:', reopened2, '(expect true)')

  // 7. tool row: click a SETTLED tool call row (not running) and verify its
  //    input/output body expands inline — tool rows are the native surface for
  //    tool input/output in the conversation.
  const toolRow = await evalInPage(`(() => {
    const rows = [...document.querySelectorAll('[data-tool]')]
    if (rows.length === 0) return { found: false, count: 0 }
    const settled = rows.filter((r) => r.getAttribute('data-state') !== 'running')
    const row = settled.length > 0 ? settled[settled.length - 1] : rows[rows.length - 1]
    row.scrollIntoView()
    // the toggle handler lives on the inner [data-disclosure-row] element
    const disclosure = row.querySelector('[data-disclosure-row]') || row
    const beforeHeight = disclosure.offsetHeight
    disclosure.click()
    return { found: true, count: rows.length, settled: settled.length, beforeHeight, tool: row.getAttribute('data-tool'), state: row.getAttribute('data-state'), title: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) }
  })()`)
  console.log('tool row click:', JSON.stringify(toolRow))
  await sleep(1000)
  const afterExpand = await evalInPage(`(() => {
    const rows = [...document.querySelectorAll('[data-tool]')]
    if (rows.length === 0) return null
    const settled = rows.filter((r) => r.getAttribute('data-state') !== 'running')
    const row = settled.length > 0 ? settled[settled.length - 1] : rows[rows.length - 1]
    return { afterHeight: row.offsetHeight, grew: row.offsetHeight > 28, sample: (row.textContent || '').replace(/\s+/g, ' ').slice(0, 200) }
  })()`)
  console.log('tool row after:', JSON.stringify(afterExpand))
  await shot('3-tool-row')

  // 8. narrow viewport: the drawer never exceeds the window (340 + 2px borders)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const widthInfo = await evalInPage(`(() => {
    const drawer = document.querySelector('[data-nexus-drawer]')
    if (!drawer) return null
    const rect = drawer.getBoundingClientRect()
    return { width: rect.width, viewport: window.innerWidth, fits: rect.width <= 344 && rect.width <= window.innerWidth }
  })()`)
  console.log('narrow 1280:', JSON.stringify(widthInfo))
  await shot('4-narrow-1280')
  // true clamp: viewport narrower than the drawer width
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const clampInfo = await evalInPage(`(() => {
    const drawer = document.querySelector('[data-nexus-drawer]')
    if (!drawer) return null
    const rect = drawer.getBoundingClientRect()
    return { width: rect.width, viewport: window.innerWidth, clamped: rect.width <= window.innerWidth }
  })()`)
  console.log('narrow 320:', JSON.stringify(clampInfo))
  await shot('5-narrow-320')

  await cdp.send('Browser.close').catch(() => {})
  cdp.close()
  try { child.kill() } catch { /* already gone */ }
  console.log('done; profile:', PROFILE)
}

main().catch((error) => { console.error('boot-verify failed:', error); process.exitCode = 1 })
