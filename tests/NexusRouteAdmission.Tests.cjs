'use strict'

// NexusRouteAdmission.Tests.cjs — every Nexus web route is admission-gated.
//
// DSH 0.2.x authenticates only /api and the app shell (per-process Web token,
// Host/Origin fence). Routes a plugin registers on webServer are its own
// responsibility. @nexus/controller's routes read controller state and take
// operator actions (gate decisions, profile changes, workspace registration,
// provider/credential management), so each must go through
// ctx.connection.admit(). Offline: the plugin is applied to a fake Cordis
// context that records the registered routes and supplies a scripted
// connection service. The same property is verified on a real server by the
// session evidence (unauth 401 / authed 200 / bad Host 403).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let passed = 0
const pass = (message) => { passed += 1; console.log('PASS: ' + message) }

function response() {
  const out = { status: null, headers: null, body: '' }
  return Object.assign(out, {
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(chunk) { out.body += chunk === undefined ? '' : String(chunk) },
  })
}

async function collect(pluginFile, admit) {
  const routes = []
  const plugin = await import(pathToFileURL(pluginFile).href)
  const webCtx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) { fn() },
  }
  if (admit !== undefined) webCtx.connection = { admit }
  const ctx = { inject(_services, callback) { callback(webCtx) } }
  plugin.apply(ctx)
  return routes
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-admission-'))
  const oldHome = process.env.DSH_HOME
  const oldRoot = process.env.AIH_INSTALL_ROOT
  process.env.DSH_HOME = path.join(root, 'data')
  process.env.AIH_INSTALL_ROOT = root
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    // The controller plugin loads the Registry service from the install's config tree.
    fs.cpSync(path.resolve(__dirname, '..', 'config', 'registry'), path.join(root, 'config', 'registry'), { recursive: true })
    const plugins = {
      controller: path.resolve(__dirname, '..', 'ui', 'nexus-controller', 'lib', 'index.js'),
      brand: path.resolve(__dirname, '..', 'ui', 'nexus-ui', 'lib', 'index.js'),
    }
    for (const [label, file] of Object.entries(plugins)) {
      for (const [mode, admit, expected] of [
        ['unauthenticated', () => ({ rejection: 401 }), 401],
        ['untrusted host/origin', () => ({ rejection: 403 }), 403],
        ['connection service absent', undefined, 503],
      ]) {
        const routes = await collect(file, admit)
        assert.ok(routes.length >= (label === 'controller' ? 12 : 2), `${label}: expected the full route set, saw ${routes.length}`)
        for (const route of routes) {
          assert.equal(route.kind, 'exact')
          for (const method of ['GET', 'POST']) {
            const res = response()
            await route.handler({ method, url: route.path, headers: { host: '127.0.0.1:3080' }, on() {}, socket: {} }, res)
            assert.equal(res.status, expected, `${label} ${method} ${route.path} (${mode}) must answer ${expected}, answered ${res.status}`)
          }
        }
        pass(`${label}: all ${routes.length} routes refuse ${mode} requests with ${expected} (GET and POST)`)
      }
    }
    // Admitted request reaches the handler (the brand asset route answers from its own files).
    const routes = await collect(plugins.brand, () => ({ peer: { id: 'browser' } }))
    const res = response()
    await routes[0].handler({ method: 'GET', headers: {} }, res)
    assert.ok(res.status === 200 || res.status === 404, 'an admitted request must reach the handler, not a refusal')
    assert.ok(![401, 403, 503].includes(res.status))
    pass('an admitted request is passed through to the route handler')
    console.log(`SUITE RESULT: PASS ${passed} | FAIL 0 | total ${passed}`)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = oldRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
