// cold-restart-verify.mjs — TASK: cold-restart Nexus and verify the real route.
//
// This driver runs DETACHED (spawned via Start-Process from the agent worker,
// surviving the dsh process death it provokes):
//   1. waits a flush window so the agent's final message is delivered,
//   2. cold-restarts the live instance through the official launcher
//      (scripts/aih.ps1 -Restart — kills the tracked dsh PID and starts a
//      fresh one with the same env, logs, readiness probe and aih-state),
//   3. polls the REAL URL
//      http://127.0.0.1:3080/nexus/controller.json?session=<bound-session>
//      until it returns HTTP 200 JSON (or fails with the last error),
//   4. sanity-checks the served boot graph + client bundle,
//   5. re-runs the CDP boot verification (boot-verify-drawer.mjs) against the
//      fresh server.
//
// Everything is appended to logs/cold-restart-verify.log; the route payload is
// written to logs/cold-restart-route.json.

import { execFile } from 'node:child_process'
import fs from 'node:fs'

const LOG = 'C:/AI-Harness/logs/cold-restart-verify.log'
const ROUTE_OUT = 'C:/AI-Harness/logs/cold-restart-route.json'
const BOOT_OUT = 'C:/AI-Harness/logs/boot-cold'
const SESSION = 'session-239a6df4-46da-4537-9622-99c1e7eaf6b5'
const URL = 'http://127.0.0.1:3080/nexus/controller.json?session=' + SESSION
const FLUSH_WAIT_MS = Number(process.argv[2] || 60000)
const POWER_SHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

const log = (...parts) => {
  const line = new Date().toISOString() + ' ' + parts.join(' ')
  try { fs.appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 300000, ...opts }, (error, stdout, stderr) => {
    resolve({
      error: error ? String(error.message || error) : null,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    })
  })
})

async function main() {
  log('cold-restart-verify begin; flush window', FLUSH_WAIT_MS, 'ms')
  await sleep(FLUSH_WAIT_MS)

  log('--- restart: aih.ps1 -Restart (official launcher) ---')
  const rs = await run(POWER_SHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/AI-Harness/scripts/aih.ps1', '-Restart'], { cwd: 'C:/AI-Harness' })
  log('aih.ps1 finished; error:', rs.error === null ? 'none' : rs.error)
  for (const line of rs.stdout.trim().split('\n').filter(Boolean).slice(-10)) log('aih>', line.trim())
  for (const line of rs.stderr.trim().split('\n').filter(Boolean).slice(-10)) log('aih-err>', line.trim())

  let stateInfo = ''
  try {
    const state = JSON.parse(fs.readFileSync('C:/AI-Harness/data/aih-state.json', 'utf8'))
    stateInfo = 'status=' + state.Status + ' pid=' + state.Pid + ' readyAt=' + (state.ReadyAtUtc || '?')
  } catch (e) { stateInfo = 'aih-state unreadable: ' + e.message }
  log('aih-state after restart:', stateInfo)

  log('--- route verification:', URL, '---')
  let payload = null
  let lastError = 'no attempt'
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(URL, { cache: 'no-store' })
      const text = await res.text()
      if (res.status === 200) {
        const data = JSON.parse(text)
        if (data && data.schemaVersion === 1) { payload = data; break }
        lastError = '200 but no schemaVersion envelope: ' + text.slice(0, 160)
      } else {
        lastError = 'http ' + res.status + ' ' + text.slice(0, 120)
      }
    } catch (e) {
      lastError = String(e.message || e)
    }
    await sleep(1000)
  }
  if (payload) {
    log('ROUTE OK: HTTP 200 JSON')
    log('  state:', payload.state)
    log('  binding:', JSON.stringify(payload.binding))
    log('  task:', payload.task ? payload.task.taskId : null)
    log('  execution:', JSON.stringify(payload.execution))
    log('  controller:', JSON.stringify(payload.controller))
    try { fs.writeFileSync(ROUTE_OUT, JSON.stringify(payload, null, 2), 'utf8') } catch {}
  } else {
    log('ROUTE FAILED after 240s: ' + lastError)
  }

  log('--- served composition sanity ---')
  try {
    const page = await (await fetch('http://127.0.0.1:3080/', { cache: 'no-store' })).text()
    const mark = page.indexOf('globalThis["__DSH_BOOT__"]')
    if (mark < 0) { log('boot graph marker not found') }
    else {
      const j2 = page.indexOf('{', mark)
      const je = page.indexOf('</script>', j2)
      const boot = JSON.parse(page.slice(j2, je))
      const ctrl = boot.entries.find((e) => e.id === '@nexus/controller')
      log('boot entries:', boot.entries.length)
      log('controller entry:', JSON.stringify(ctrl))
      if (ctrl) {
        const client = await (await fetch('http://127.0.0.1:3080' + ctrl.url.split('?')[0], { cache: 'no-store' })).text()
        log('served client.js: UNAVAILABLE =', client.includes('UNAVAILABLE'), '| details inject =', client.includes('inject("details"'), '| shell.overlay =', client.includes('"shell.overlay"'))
      }
    }
  } catch (e) { log('composition sanity failed:', String(e.message || e)) }

  log('--- CDP boot verification against the fresh server ---')
  const bv = await run('C:/AI-Harness/runtime/node/node.exe', ['C:/AI-Harness/ui/nexus-controller/tools/boot-verify-drawer.mjs', BOOT_OUT], { cwd: 'C:/AI-Harness' })
  log('boot-verify exit:', bv.error === null ? 'ok' : bv.error)
  const lines = bv.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines.slice(0, 46)) log('boot>', line)
  if (lines.length > 46) log('boot> …', lines.length - 46, 'more lines')
  for (const line of bv.stderr.trim().split('\n').filter(Boolean).slice(-8)) log('boot-err>', line.trim())

  log('cold-restart-verify done')
}

main().catch((e) => {
  log('cold-restart-verify crashed:', String(e && e.stack || e))
  process.exitCode = 1
})
