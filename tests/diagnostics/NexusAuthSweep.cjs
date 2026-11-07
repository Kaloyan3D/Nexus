'use strict'
// NexusAuthSweep.cjs — authenticated/unauthenticated sweep of EVERY Nexus HTTP route against a
// RUNNING server (live DSH 0.2.x, disposable install).
//
//   node tests/diagnostics/NexusAuthSweep.cjs <baseUrl> [cookieHeader] [out.json]
//
// Without a cookie (and with a forged cookie / foreign Host / foreign Origin) every route, for
// every method, must answer 401/403 and carry no Nexus data. With a valid cookie, no route may
// answer 401/403 (it may answer 200/400/404/405/422/503 depending on method and body).
// The route list is read from the plugin sources so a new route cannot escape the sweep.
const fs = require('node:fs')
const path = require('node:path')
const [base, cookie, outPath] = process.argv.slice(2)
if (!base) { console.error('usage: NexusAuthSweep.cjs <baseUrl> [cookie] [out.json]'); process.exit(2) }
const sources = ['../../ui/nexus-controller/lib/index.js', '../../ui/nexus-ui/lib/index.js'].map((rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8')).join('\n')
const routes = new Set()
for (const m of sources.matchAll(/path:\s*'(\/nexus\/[^']*?)'(\s*\+\s*file)?/g)) routes.add(m[2] ? m[1] + 'nexus-mark.png' : m[1])
routes.add('/nexus/assets/nexus-favicon.svg')
const methods = ['GET', 'POST', 'PUT', 'DELETE']
const variants = [
  { name: 'no-cookie', headers: {} },
  { name: 'forged-cookie', headers: { cookie: 'dsh_session=forged; token=forged' } },
  { name: 'query-token-only', headers: {}, query: '?token=not-the-token' },
  { name: 'foreign-origin', headers: { origin: 'http://evil.example' } },
]
if (cookie) variants.push({ name: 'valid-cookie', headers: { cookie }, expectAdmitted: true })
const results = []
let failures = 0
;(async () => {
  for (const route of [...routes].sort()) {
    for (const variant of variants) {
      for (const method of methods) {
        const response = await fetch(base + route + (variant.query || ''), {
          method, headers: { ...variant.headers, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'HEAD' ? undefined : '{}', redirect: 'manual',
        })
        const body = await response.text()
        const denied = response.status === 401 || response.status === 403
        const leaks = !denied && !variant.expectAdmitted && body.length > 0 && /"schemaVersion"|taskId|binding/.test(body)
        const ok = variant.expectAdmitted ? !denied : (denied && !leaks)
        if (!ok) failures++
        results.push({ route, variant: variant.name, method, status: response.status, ok })
      }
    }
  }
  const summary = { base: base.replace(/\/\/.*@/, '//'), routes: routes.size, checks: results.length, failures,
    deniedAll: results.filter((r) => !r.variant.startsWith('valid')).every((r) => r.ok),
    admittedWithCookie: cookie ? results.filter((r) => r.variant === 'valid-cookie').every((r) => r.ok) : 'not-run' }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1))
  console.log(JSON.stringify(summary))
  if (failures) { for (const r of results.filter((x) => !x.ok).slice(0, 15)) console.log('FAIL', r.route, r.variant, r.method, r.status); process.exitCode = 1 }
})().catch((error) => { console.error(error); process.exitCode = 1 })
