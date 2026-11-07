'use strict'
// NexusModeDefaultRoute.Tests.cjs - POST /nexus/mode-default.json (default mode for NEW sessions).
//
// DSH 0.2.x pins `agent-preset-registry` from the generated home patch, so the picker can no
// longer save the default through the DSH settings namespace. The Nexus host route writes the
// Nexus-owned nexus-settings.yaml, regenerates the home patch and verifies it on the REAL DSH
// composition, all on a DISPOSABLE install root (app/runtime linked, everything Nexus writes in
// the disposable data directory). Proves: admission gate, method, whitelist (no path accepted),
// persistence into settings AND patch, byte-stable on refusal, and rollback when verification fails.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const SOURCE = path.resolve(__dirname, '..')
const toolchain = process.env.NEXUS_RUNTIME_ROOT || process.env.AIH_INSTALL_ROOT || process.argv[2] || path.join(os.homedir(), '.local/share/nexus')
const pwsh = process.env.AIH_PWSH_HOST || process.env.AIH_TEST_PWSH || path.join(toolchain, 'runtime', 'pwsh', 'pwsh')
const nodeBin = path.join(toolchain, 'runtime', 'node', 'bin', 'node')

let passed = 0
const pass = (name) => { passed += 1; console.log('PASS: ' + name) }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-modedefault-'))
  const data = path.join(root, 'data')
  const previousHome = process.env.DSH_HOME
  try {
    for (const dir of ['config', 'scripts', 'ui']) fs.cpSync(path.join(SOURCE, dir), path.join(root, dir), { recursive: true, filter: (file) => !file.split(path.sep).includes('node_modules') })
    fs.symlinkSync(path.join(toolchain, 'app'), path.join(root, 'app'))
    fs.symlinkSync(path.join(toolchain, 'runtime'), path.join(root, 'runtime'))
    fs.mkdirSync(data, { recursive: true })
    fs.copyFileSync(path.join(SOURCE, 'config', 'settings.yaml'), path.join(data, 'nexus-settings.yaml'))
    const install = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-File', path.join(root, 'scripts', 'Install-NexusPresets.ps1'), '-InstallRoot', root], { encoding: 'utf8' })
    assert.equal(install.status, 0, 'disposable plane install must succeed: ' + (install.stderr || install.stdout).slice(-300))

    process.env.DSH_HOME = data
    process.env.AIH_PWSH_HOST = pwsh
    const plugin = await import(pathToFileURL(path.join(root, 'ui', 'nexus-controller', 'lib', 'index.js')).href)
    const captured = []
    let injectCallback = null
    plugin.apply({ inject(keys, callback) { injectCallback = callback }, effect() { return () => {} } })
    let admitted = true
    injectCallback({
      webServer: { register(spec) { captured.push(spec) } },
      connection: { admit: () => (admitted ? { peer: {} } : { rejection: 401 }) },
      effect(fn) { fn(); return () => {} },
    })
    const route = captured.find((spec) => spec.path === '/nexus/mode-default.json')
    assert.ok(route, 'the default-mode route is registered')
    const call = async (method, body) => {
      const req = {
        method, url: '/nexus/mode-default.json', headers: {},
        on(event, fn) { if (event === 'data' && body !== undefined) fn(typeof body === 'string' ? body : JSON.stringify(body)); if (event === 'end') fn() },
      }
      const res = { writeHead(code) { this.code = code }, end(text) { this.body = text ? JSON.parse(text) : null } }
      await route.handler(req, res)
      return res
    }
    const settingsFile = path.join(data, 'nexus-settings.yaml')
    const patchFile = path.join(data, 'cordis.patch.yml')
    const bytes = () => [fs.readFileSync(settingsFile, 'utf8'), fs.readFileSync(patchFile, 'utf8')]
    const defaultOf = (text) => (/^agent-presets:\s*\n\s+default:\s*(\S+)/m.exec(text) || [])[1]
    const patchDefault = (text) => (/- id: agent-preset-registry\s*\n\s+config:\s*\n\s+default:\s*(\S+)/.exec(text) || [])[1]

    assert.equal(defaultOf(bytes()[0]), 'aih-engineering')
    assert.equal(patchDefault(bytes()[1]), 'aih-engineering')

    admitted = false
    const denied = await call('POST', { preset: 'aih-deepseek' })
    admitted = true
    assert.equal(denied.code, 401)
    assert.deepEqual(bytes(), bytes())
    assert.equal(defaultOf(bytes()[0]), 'aih-engineering')
    pass('an unadmitted request is refused and changes nothing')

    const before = bytes()
    assert.equal((await call('GET')).code, 405)
    for (const bad of [{ preset: 'aih-muse' }, { preset: '../../etc/passwd' }, { preset: '' }, { path: '/tmp/x' }, 'not json']) {
      const r = await call('POST', bad)
      assert.equal(r.code, 400, 'rejects ' + JSON.stringify(bad))
    }
    assert.deepEqual(bytes(), before)
    pass('wrong method, unsupported presets, paths and malformed bodies are refused byte-stably')

    const ok = await call('POST', { preset: 'aih-deepseek' })
    assert.equal(ok.code, 200)
    assert.deepEqual(ok.body, { ok: true, preset: 'aih-deepseek' })
    assert.equal(defaultOf(bytes()[0]), 'aih-deepseek')
    assert.equal(patchDefault(bytes()[1]), 'aih-deepseek')
    pass('a supported preset is saved to nexus-settings.yaml and the verified home patch')

    // Rollback: break the composition verifier; the save must fail and both files stay as they were.
    const verifier = path.join(root, 'scripts', 'Verify-NexusComposition.mjs')
    const goodVerifier = fs.readFileSync(verifier)
    fs.writeFileSync(verifier, 'process.exit(3)\n')
    const beforeFail = bytes()
    const failed = await call('POST', { preset: 'aih-engineering' })
    fs.writeFileSync(verifier, goodVerifier)
    assert.equal(failed.code, 500)
    assert.deepEqual(bytes(), beforeFail)
    assert.equal(defaultOf(bytes()[0]), 'aih-deepseek')
    pass('a failed verification rolls back settings and patch (no half-saved default)')

    assert.ok(fs.existsSync(nodeBin))
    console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
