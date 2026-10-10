'use strict'

// Exercise Node's real ESM loader against the installed package, never a
// rewritten source entrypoint. Installer tests execute their actual copy blocks
// without provisioning dependencies or touching the operator's installation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-installed-'))
const savedEnv = { ...process.env }
let passed = 0, failed = 0
async function check(label, fn) {
  try { await fn(); passed++; console.log('PASS: ' + label) }
  catch (error) { failed++; console.error('FAIL: ' + label + '\n' + error.stack) }
}
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? files(path.join(root, e.name)).map(f => path.join(e.name, f)) : [e.name]).sort()
}
function fixture(name) {
  const root = path.join(scratch, name)
  fs.mkdirSync(path.join(root, 'data/registry'), { recursive: true })
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  for (const f of ['engineering-profiles.json', 'muse-profiles.json', 'model-registry.json']) {
    fs.copyFileSync(path.join(repo, 'config', f), path.join(root, 'config', f))
  }
  for (const f of ['data/registry/operator.json', 'data/settings.yaml', 'data/routing/session-bindings.json', 'config/settings.yaml']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), 'operator-owned: ' + f)
  }
  return root
}
function preserved(root) {
  for (const f of ['data/registry/operator.json', 'data/settings.yaml', 'data/routing/session-bindings.json', 'config/settings.yaml']) {
    assert.equal(fs.readFileSync(path.join(root, f), 'utf8'), 'operator-owned: ' + f)
  }
}
function closure(root) {
  const source = path.join(repo, 'config/registry'), dest = path.join(root, 'config/registry')
  assert.deepEqual(files(dest), files(source))
  for (const f of files(source)) assert.deepEqual(fs.readFileSync(path.join(dest, f)), fs.readFileSync(path.join(source, f)))
  const svc = require(path.join(dest, 'service.cjs')).createService({ installRoot: root, dataRoot: path.join(root, 'data') })
  assert.deepEqual(svc.listModes().errors, [])
  assert.equal(svc.listModes().modes.length, 3)
  preserved(root)
}
async function main() {
  await check('installed ESM controller initializes only after host injection and honors runtime root', async () => {
    const root = fixture('runtime with spaces')
    fs.cpSync(path.join(repo, 'config/registry'), path.join(root, 'config/registry'), { recursive: true })
    const pkg = path.join(root, 'data/profiles/node_modules/@nexus/controller')
    fs.cpSync(path.join(repo, 'ui/nexus-controller'), pkg, { recursive: true })
    // Bare package resolution starts in data/profiles, matching the host.
    const probe = path.join(root, 'data/profiles/probe.mjs')
    fs.writeFileSync(probe, "export * from '@nexus/controller'\n")
    delete process.env.DSH_HOME
    delete process.env.AIH_INSTALL_ROOT
    const controller = await import(pathToFileURL(probe).href)
    let initialize
    controller.apply({ inject(names, callback) { assert.deepEqual(names, ['webServer']); initialize = callback } })
    const boot = () => {
      const routes = new Map()
      initialize({ effect(fn) { fn() }, webServer: { register(route) {
        assert.equal(route.kind, 'exact'); assert.ok(!routes.has(route.path)); routes.set(route.path, route.handler); return () => {}
      } } })
      return routes
    }
    const verify = async routes => {
      const prefix = '/nexus/registry/v1/'
      // R4 (TASK-0048) extends the pinned route contract with the operator
      // catalog + explicit probe endpoints; the R3 five-route pin is
      // superseded by this list (spec change, not a regression).
      assert.deepEqual([...routes.keys()].filter(p => p.startsWith(prefix)).sort(),
        ['configuration', 'eligible', 'modes', 'preview', 'validate',
          'catalog',
          'providers', 'models', 'routes', 'connections',
          'providers/disable', 'models/disable', 'routes/disable', 'connections/disable',
          'providers/delete', 'models/delete', 'routes/delete', 'connections/delete',
          'connections/status',
          'providers/test', 'providers/discover', 'routes/verify',
          'routes/evidence', 'routes/project'].map(p => prefix + p).sort())
      let status, body
      await routes.get(prefix + 'modes')({ method: 'GET', url: prefix + 'modes', headers: {} }, {
        writeHead(code) { status = code }, end(text) { body = JSON.parse(text) }
      })
      assert.equal(status, 200)
      assert.deepEqual(body.modes.map(m => m.id).sort(), ['engineering-v1', 'engineering-v2', 'engineering-v3'])
      assert.ok(body.modes.find(m => m.id === 'engineering-v2').executable)
    }
    process.env.AIH_INSTALL_ROOT = root
    await verify(boot())
    process.env.DSH_HOME = path.join(root, 'data')
    process.env.AIH_INSTALL_ROOT = path.join(scratch, 'incorrect-fallback')
    await verify(boot())
    assert.ok(!fs.existsSync(path.join(root, 'data/profiles/node_modules/config')))
    preserved(root)
  })
  await check('Linux installer recursively publishes the Registry dependency closure and preserves operator files', () => {
    const text = fs.readFileSync(path.join(repo, 'setup.sh'), 'utf8')
    const helper = text.match(/^copy_tree\(\) \{[\s\S]*?^\}/m)
    const call = text.match(/^copy_tree "\$AIH_SOURCE_ROOT\/config\/registry" "\$AIH_INSTALL_ROOT\/config\/registry"$/m)
    assert.ok(helper && call, 'Registry copy must use the recursive installer helper')
    assert.match(helper[0], /find \. -type f/)
    assert.match(helper[0], /mkdir -p/)
    assert.match(helper[0], /cp -f/)
    // Windows verifies the POSIX source contract; the Linux lane executes it.
    if (process.platform === 'win32') return
    const root = fixture('linux')
    for (let i = 0; i < 2; i++) execFileSync('sh', ['-c', helper[0] + '\n' + call[0]], {
      env: { ...savedEnv, AIH_SOURCE_ROOT: repo, AIH_INSTALL_ROOT: root }
    })
    closure(root)
  })
  await check('Windows installer recursively publishes the Registry dependency closure and preserves operator files', () => {
    const text = fs.readFileSync(path.join(repo, 'scripts/Setup.ps1'), 'utf8').replace(/\r\n/g, '\n')
    const helper = text.match(/^function Copy-AihSourceFile \{[\s\S]*?^\}/m)
    const block = text.match(/^# TASK-0047\.1: Registry runtime closure[\s\S]*?(?=^# TASK-0009:)/m)
    assert.ok(helper && block, 'Registry recursive copy block must exist')
    assert.match(block[0], /Get-ChildItem.*-Recurse -File/)
    const root = fixture('windows')
    const script = path.join(scratch, 'copy-registry.ps1')
    fs.writeFileSync(script, "param($sourceRoot, $installRoot)\n$ErrorActionPreference = 'Stop'\n$layout = @{ Config = (Join-Path $installRoot 'config') }\n" + helper[0] + '\n' + block[0])
    const host = process.env.AIH_PWSH_HOST || (process.platform === 'win32' ? 'powershell.exe'
      : path.join(os.homedir(), '.local/share/nexus/runtime/pwsh/pwsh'))
    for (let i = 0; i < 2; i++) execFileSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, repo, root])
    closure(root)
    // Source-root installs must also be safe (Copy-AihSourceFile skips self-copy).
    execFileSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, root, root])
    closure(root)
  })
}
main().finally(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  fs.rmSync(scratch, { recursive: true, force: true })
  console.log(`SUITE RESULT: PASS ${passed} | FAIL ${failed} | total ${passed + failed}`)
  process.exitCode = failed ? 1 : 0
})
