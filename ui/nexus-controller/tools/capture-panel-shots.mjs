// ⚠️ SUPERSEDED by boot-verify-drawer.mjs (TASK-0002 repair): this capture
// driver injected the panel into the details column, which the drawer
// architecture no longer uses. The real panel now lives in shell.overlay and
// the boot verification drives the REAL composition end to end (no markup
// injection). Keep this file only as the historical Phase-2 capture record.
//
// Visual verification capture: injects the REAL ControllerPanel markup injects the REAL ControllerPanel markup
// (rendered by tools/render-panel-markup.cjs) into the live GUI's real
// details column + header action row, then captures screenshots at multiple
// viewport sizes, both themes, and the collapsed/narrow states.
//
// Usage: node capture-panel-shots.mjs <markup.json> <out-dir>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const PROFILE = path.join(os.tmpdir(), 'nexus-cdp-profile-' + Date.now())

const [markupPath, outDir] = process.argv.slice(2)
if (!markupPath || !outDir) { console.error('usage: node capture-panel-shots.mjs <markup.json> <out-dir>'); process.exit(1) }
const markup = JSON.parse(fs.readFileSync(markupPath, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function launch() {
  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=1920,1080',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' })
  // wait for the debugging endpoint
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
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const entry = this.pending.get(message.id)
        if (entry) { this.pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result) }
      } else {
        this.events.push(message)
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
  const { child, wsUrl } = await launch()
  const cdp = new Cdp(wsUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080' })
  // wait for the app shell, then for the conversation to finish mounting
  for (let i = 0; i < 80; i++) {
    const state = await cdp.send('Runtime.evaluate', { expression: '!!document.querySelector("[data-slot=sidebar]")', returnByValue: true })
    if (state.result.value === true) break
    await sleep(250)
  }
  let composerReady = false
  for (let i = 0; i < 150; i++) {
    const state = await cdp.send('Runtime.evaluate', {
      expression: '!!document.querySelector("[data-composer-card]") || !!document.querySelector("[data-slot=\"conversation.hero\"]")',
      returnByValue: true,
    })
    if (state.result.value === true) { composerReady = true; break }
    await sleep(500)
  }
  console.log('composer ready:', composerReady)
  await sleep(3000)

  const css = markup.css
  const variants = markup.variants
  const evalInPage = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r.result.value
  }

  // ── inject panel CSS + the details-column mount + toggles ────────────────
  const mountScript = `
    (() => {
      if (document.getElementById('nx-visual-style')) return 'already'
      const style = document.createElement('style')
      style.id = 'nx-visual-style'
      style.textContent = __CSS__
      document.head.appendChild(style)
      const details = document.querySelector('[data-slot="details"]')
      if (!details) return 'no-details-cell'
      const detailsColumn = details.parentElement
      let appGrid = detailsColumn ? detailsColumn.parentElement : null
      while (appGrid && getComputedStyle(appGrid).display !== 'grid') appGrid = appGrid.parentElement
      if (!appGrid) return 'no-app-grid'
      detailsColumn.style.width = '360px'
      detailsColumn.style.minWidth = '360px'
      detailsColumn.style.overflow = 'visible'
      detailsColumn.style.background = 'var(--dsw-alias-bg-base)'
      appGrid.style.gridTemplateColumns = '288px minmax(0,1fr) 360px'
      const mount = document.createElement('div')
      mount.id = 'nx-visual-mount'
      mount.style.height = '100%'
      details.insertBefore(mount, details.firstChild)
      const actions = document.querySelector('[data-slot="conversation.session.header.actions"]')
      if (actions) {
        const a1 = document.createElement('span'); a1.id = 'nx-toggle-open'; a1.innerHTML = __TOGGLE_OPEN__
        const a2 = document.createElement('span'); a2.id = 'nx-toggle-closed'; a2.innerHTML = __TOGGLE_CLOSED__
        a2.style.marginLeft = '6px'
        actions.appendChild(a1); actions.appendChild(a2)
      } else {
        // fallback: show the toggles in a scratch strip above the panel so the
        // open/closed styling is still captured
        const strip = document.createElement('div')
        strip.id = 'nx-toggle-strip'
        strip.style.cssText = 'position:fixed;top:8px;right:376px;z-index:9999;display:flex;gap:8px;padding:6px 8px;background:var(--dsw-alias-bg-module);border:1px solid var(--dsw-alias-border-l1);border-radius:10px'
        const s1 = document.createElement('span'); s1.innerHTML = __TOGGLE_OPEN__
        const s2 = document.createElement('span'); s2.innerHTML = __TOGGLE_CLOSED__
        strip.appendChild(s1); strip.appendChild(s2)
        document.body.appendChild(strip)
      }
      return 'mounted'
    })()
  `.replaceAll('__CSS__', JSON.stringify(css)).replaceAll('__TOGGLE_OPEN__', JSON.stringify(markup.toggles.open)).replaceAll('__TOGGLE_CLOSED__', JSON.stringify(markup.toggles.closed))

  const shot = async (name, { width, height }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(res.data, 'base64'))
    console.log('shot:', name + '.png', width + 'x' + height)
  }

  const setVariant = async (html) => {
    return evalInPage(`document.getElementById('nx-visual-mount').innerHTML = ${JSON.stringify(html)}; 'ok'`)
  }
  const setTheme = async (dark) => {
    return evalInPage(`document.body.toggleAttribute('data-ds-dark-theme', ${dark}); 'ok'`)
  }

  console.log(await evalInPage(mountScript))

  // ── dark theme, 1920×1080: every state in the real details column ────────
  await setTheme(true)
  for (const [name, html] of Object.entries(variants)) {
    await setVariant(html)
    await shot('dark-1920-' + name, { width: 1920, height: 1080 })
  }

  // ── light theme on the live variant ──────────────────────────────────────
  await setTheme(false)
  await setVariant(variants['live-working'])
  await evalInPage(`document.body.removeAttribute('data-ds-dark-theme'); 'ok'`)
  await shot('light-1920-live-working', { width: 1920, height: 1080 })

  // ── 1440×900 (details can stay open: 288+360+640 <= 1440) ────────────────
  await setTheme(true)
  await setVariant(variants['live-working'])
  await shot('dark-1440-live-working', { width: 1440, height: 900 })

  // ── narrow desktop 1280×800: real rule force-closes details; the panel
  //    stays mounted but invisible; toggles remain in the header ───────────
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(outDir, 'dark-1280-auto-hidden.png'), Buffer.from(r.data, 'base64'))
  console.log('shot: dark-1280-auto-hidden.png')

  // collapsed panel: details track 0 → same as above; also capture the
  // close-button interaction state by hiding the mount (panel collapsed)
  await evalInPage(`document.getElementById('nx-visual-mount').style.display = 'none'; 'ok'`)
  const r2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(outDir, 'dark-1280-collapsed-toggle.png'), Buffer.from(r2.data, 'base64'))
  console.log('shot: dark-1280-collapsed-toggle.png')

  await cdp.send('Browser.close').catch(() => {})
  cdp.close()
  try { child.kill() } catch { /* already gone */ }
  console.log('done; profile:', PROFILE)
}

main().catch((error) => { console.error('capture failed:', error); process.exitCode = 1 })
