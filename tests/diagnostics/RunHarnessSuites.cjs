'use strict'

// RunHarnessSuites.cjs — runs the suites listed in scripts/Test-Harness.ps1
// one by one against an INSTALLED tree and records a per-suite verdict.
//
//   node tests/diagnostics/RunHarnessSuites.cjs <InstallRoot> <out.json> [tmpDir] [nameRegex]
//
// Why not just Test-Harness.ps1: it has no resume, and a few suites leak large
// temp trees (Intelligence tree fixtures, CCv2 research checkouts). This runner
// reads the harness's own suite table (so the suite set cannot drift), uses the
// installed Node/PowerShell, gives every suite a private TMPDIR that is emptied
// afterwards, a 20-minute timeout, and never stops on a failure. The verdict is
// the process exit code, exactly like the harness. No assertion is altered.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const [installRootArg, outPath, tmpArg, filter] = process.argv.slice(2)
if (!installRootArg || !outPath) { console.error('usage: RunHarnessSuites.cjs <InstallRoot> <out.json> [tmpDir] [nameRegex]'); process.exit(2) }
const root = path.resolve(installRootArg)
const tmpRoot = path.resolve(tmpArg || path.join(os.tmpdir(), 'harness-suites-' + process.pid))
fs.mkdirSync(tmpRoot, { recursive: true })
const node = path.join(root, 'runtime', 'node', 'bin', 'node')
const pwsh = path.join(root, 'runtime', 'pwsh', 'pwsh')
const harness = fs.readFileSync(path.join(root, 'scripts', 'Test-Harness.ps1'), 'utf8')
const suites = []
for (const match of harness.matchAll(/\[ordered\]@\{\s*name='([^']+)';\s*script='([^']+)';[^}]*?kind='(node|powershell)'(?:;\s*env=@\{([^}]*)\})?/g)) {
  const env = {}
  for (const pair of String(match[4] || '').matchAll(/'([^']+)'\s*=\s*'([^']*)'/g)) env[pair[1]] = pair[2]
  suites.push({ name: match[1], script: match[2], kind: match[3], env })
}
if (suites.length === 0) { console.error('no suites parsed from Test-Harness.ps1'); process.exit(2) }
const results = []
for (const suite of suites) {
  if (filter && !new RegExp(filter).test(suite.name)) continue
  const started = Date.now()
  const scratch = fs.mkdtempSync(path.join(tmpRoot, 'suite-'))
  const env = {
    ...process.env, ...suite.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    AIH_INSTALL_ROOT: root, NEXUS_RUNTIME_ROOT: root, DSH_HOME: '', HOME: process.env.HOME,
    PATH: path.dirname(node) + path.delimiter + process.env.PATH,
  }
  const command = suite.kind === 'node' ? node : pwsh
  const args = suite.kind === 'node'
    ? [path.join(root, suite.script), root]
    : ['-NoLogo', '-NoProfile', '-File', path.join(root, suite.script), '-InstallRoot', root]
  const run = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 })
  const output = (run.stdout || '') + (run.stderr || '')
  const lines = output.split('\n')
  const passes = lines.filter((line) => /^\s*(PASS|OK)\b/.test(line.replace(/\x1b\[[0-9;]*m/g, ''))).length
  const firstFailure = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).find((line) => /(^|\s)(FAIL|Error|AssertionError|Exception)\b/.test(line)) || ''
  results.push({
    name: suite.name, kind: suite.kind, status: run.status, signal: run.signal || null,
    verdict: run.status === 0 ? 'PASS' : 'FAIL', passLines: passes, ms: Date.now() - started,
    firstFailure: firstFailure.trim().slice(0, 240),
    tail: lines.filter(Boolean).slice(-3).join(' | ').slice(0, 300),
  })
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.writeFileSync(outPath, JSON.stringify(results, null, 1))
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'} ${suite.name} (${suite.kind}) ${Date.now() - started}ms`)
}
const failed = results.filter((r) => r.verdict !== 'PASS')
console.log(`HARNESS SUITES: ${results.length - failed.length} PASS | ${failed.length} FAIL | ${results.length} total`)
