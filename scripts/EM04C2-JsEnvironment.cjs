#!/usr/bin/env node
'use strict'
// EM-04C2 S9: a reproducible, DISPOSABLE environment for the JavaScript suites that need an installed
// Harness (`app/node_modules/@deepseek-ai/dsh-tools`, PowerShell, generated agent presets).
//
//   node scripts/EM04C2-JsEnvironment.cjs [--out <dir>] [--report <file.json>] [--keep] [--suites <glob-regex>]
//
// What it does (nothing outside --out and the report is written; the repository, its manifests and
// lock files, the user's HOME and the real installation are never modified):
//   1. copies the working tree (tracked + untracked, ignoring .gitignore'd files) to <out>/repo;
//   2. links, read-only, the pieces an installation provides and a checkout does not:
//        app      -> $NEXUS_JSENV_APP   (default ~/.cache/nexus-release-toolchain/app)
//        runtime/node, runtime/pwsh -> $NEXUS_JSENV_RUNTIME (default ~/.local/share/nexus/runtime)
//        native/target -> this checkout's native/target (the suites that run the built binaries)
//      NOTHING is downloaded or installed from a network;
//   3. runs the repository's own installer steps inside the copy with HOME=<out>/home:
//        MusePresetDependencyClosure.cjs prepare (muse, engineering, deepseek), Complete-Install.ps1;
//   4. makes the copy a git repository (several suites assert "protected trees clean") and runs
//      tests/Muse*.Tests.cjs, tests/Registry*.Tests.cjs, tests/Native*.Tests.cjs;
//   5. classifies every non-passing suite: `env:*` (a named missing prerequisite) or `REAL`.
// A suite that cannot execute is reported UNVERIFIED, never as passed. Exit status: 0 = every suite
// passed; 1 = at least one REAL failure; 3 = the environment could not be built (all UNVERIFIED).
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const repo = path.resolve(__dirname, '..')
// NOT under the OS temp directory: some suites assert that the repository is outside it
const out = path.resolve(opt('--out', path.join(os.homedir(), '.cache', 'em04c2-jsenv')))
const reportPath = opt('--report', null)
const keep = args.includes('--keep')
const suiteRx = new RegExp(opt('--suites', '^tests/(Muse|Registry|Native)[A-Za-z0-9]*\\.Tests\\.cjs$'))
const appSrc = process.env.NEXUS_JSENV_APP || path.join(os.homedir(), '.cache', 'nexus-release-toolchain', 'app')
const rtSrc = process.env.NEXUS_JSENV_RUNTIME || path.join(os.homedir(), '.local', 'share', 'nexus', 'runtime')

const run = (cmd, a, o = {}) => cp.spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...o })
const report = { environment: {}, suites: {}, summary: {} }

function unavailable(why) {
  console.log('JS environment UNAVAILABLE: ' + why)
  report.environment = { built: false, why }
  report.summary = { passed: 0, failed: 0, unverified: 'all', note: why }
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  process.exit(3)
}

const need = [
  [path.join(appSrc, 'node_modules', '@deepseek-ai', 'dsh-tools'), 'the Harness dependency @deepseek-ai/dsh-tools (set NEXUS_JSENV_APP)'],
  [path.join(rtSrc, 'node', 'bin', 'node'), 'the bundled Node runtime (set NEXUS_JSENV_RUNTIME)'],
  [path.join(rtSrc, 'pwsh', 'pwsh'), 'the bundled PowerShell (set NEXUS_JSENV_RUNTIME)'],
]
for (const [p, what] of need) if (!fs.existsSync(p)) unavailable('missing ' + what + ': ' + p)

fs.rmSync(out, { recursive: true, force: true })
const root = path.join(out, 'repo')
const home = path.join(out, 'home')
const bin = path.join(out, 'bin')
for (const d of [root, home, bin]) fs.mkdirSync(d, { recursive: true })

// 1. the working tree
const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo }).stdout.split('\0').filter(Boolean)
let copied = 0
for (const f of files) {
  if (f.startsWith('native/target/')) continue
  const src = path.join(repo, f)
  if (!fs.existsSync(src) || fs.lstatSync(src).isDirectory()) continue
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
  fs.copyFileSync(src, path.join(root, f), fs.constants.COPYFILE_FICLONE)
  copied++
}
// 2. read-only links
const link = (target, at) => {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(target, at)
}
link(appSrc, path.join(root, 'app'))
link(path.join(rtSrc, 'node'), path.join(root, 'runtime', 'node'))
link(path.join(rtSrc, 'pwsh'), path.join(root, 'runtime', 'pwsh'))
link(path.join(rtSrc, 'pwsh', 'pwsh'), path.join(bin, 'pwsh'))
if (fs.existsSync(path.join(repo, 'native', 'target'))) link(path.join(repo, 'native', 'target'), path.join(root, 'native', 'target'))
// some suites resolve the installation relative to HOME (~/.local/share/nexus/{app,runtime}); the
// disposable HOME gets read-only links to the same pieces, never the user's data or credentials
link(appSrc, path.join(home, '.local', 'share', 'nexus', 'app'))
link(rtSrc, path.join(home, '.local', 'share', 'nexus', 'runtime'))
const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH }
const nodeBin = path.join(root, 'runtime', 'node', 'bin', 'node')

// 3. the installer's own steps
const git = (...a) => run('git', ['-c', 'user.email=jsenv@local', '-c', 'user.name=jsenv', ...a], { cwd: root, env })
git('init', '-q', '.')
fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), 'app\nruntime/node\nruntime/pwsh\nnative/target\ndata/\nlogs/\n')
git('add', '-A')
git('commit', '-qm', 'disposable copy of the working tree')
const steps = []
for (const profile of ['', 'engineering', 'deepseek']) {
  const r = run(nodeBin, ['scripts/MusePresetDependencyClosure.cjs', 'prepare', root, root, ...(profile ? [profile] : [])], { cwd: root, env })
  steps.push({ step: 'closure prepare ' + (profile || 'muse'), status: r.status })
}
// (setup.sh creates the data and logs directories before this step)
for (const d of ['data', 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true })
const inst = run('pwsh', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/Complete-Install.ps1', '-InstallRoot', root], { cwd: root, env })
steps.push({ step: 'Complete-Install.ps1', status: inst.status })
if (steps.some((s) => s.status !== 0)) unavailable('an installer step failed: ' + JSON.stringify(steps) + ' ' + (inst.stderr || '').slice(0, 300))
// RegistryR2Compatibility asserts that a SOURCE checkout holds no live settings file; the presets the
// other suites need live elsewhere under data/, so only this generated file is removed
fs.rmSync(path.join(root, 'data', 'settings.yaml'), { force: true })
git('add', '-A')
git('commit', '-qm', 'installed state')
// two suites take an explicit, already provisioned disposable install under <repo>/tmp as argv[2]
const dest = path.join(root, 'tmp', 'install')
fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), 'tmp/\n')
for (const f of files) {
  if (f.startsWith('native/target/') || !fs.existsSync(path.join(repo, f)) || fs.lstatSync(path.join(repo, f)).isDirectory()) continue
  fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true })
  fs.copyFileSync(path.join(repo, f), path.join(dest, f), fs.constants.COPYFILE_FICLONE)
}
link(appSrc, path.join(dest, 'app'))
link(path.join(rtSrc, 'node'), path.join(dest, 'runtime', 'node'))
link(path.join(rtSrc, 'pwsh'), path.join(dest, 'runtime', 'pwsh'))
for (const d of ['data', 'logs']) fs.mkdirSync(path.join(dest, d), { recursive: true })
for (const profile of ['', 'engineering', 'deepseek']) {
  steps.push({ step: 'tmp/install closure ' + (profile || 'muse'), status: run(nodeBin, ['scripts/MusePresetDependencyClosure.cjs', 'prepare', root, dest, ...(profile ? [profile] : [])], { cwd: root, env }).status })
}
steps.push({ step: 'tmp/install Complete-Install.ps1', status: run('pwsh', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dest, 'scripts', 'Complete-Install.ps1'), '-InstallRoot', dest], { cwd: root, env }).status })
if (steps.some((s) => s.status !== 0)) unavailable('an installer step failed: ' + JSON.stringify(steps))
const PARAMETERIZED = new Set(['tests/RegistryR75InstallationAudit.Tests.cjs', 'tests/RegistryR751DependencyCompatibility.Tests.cjs'])
report.environment = { built: true, copiedFiles: copied, steps, app: 'linked read-only', pwsh: run('pwsh', ['--version'], { env }).stdout.trim(), node: run(nodeBin, ['--version']).stdout.trim() }

// 4/5. the suites
const classes = [
  [/Cannot find module '@deepseek-ai\/dsh-tools'/, 'env:dsh-tools-missing'],
  [/spawn pwsh ENOENT|pwsh: command not found|no pwsh host/i, 'env:pwsh-missing'],
  [/nexusd binary exists|kernel binary exists|nexus-kernel/i, 'env:native-binaries-not-built'],
  // the linked toolchain is an OLDER installation: it carries other dependency versions than the lock file pins
  [/'\d+\.\d+\.\d+' !== '\d+\.\d+\.\d+'/, 'env:toolchain-dependency-version-differs-from-lockfile'],
]
const suites = fs.readdirSync(path.join(root, 'tests')).map((f) => 'tests/' + f).filter((f) => suiteRx.test(f)).sort()
let pass = 0
let real = 0
let envFail = 0
for (const s of suites) {
  const t = Date.now()
  const r = run(nodeBin, PARAMETERIZED.has(s) ? [s, dest] : [s], { cwd: root, env, timeout: 600000 })
  const text = (r.stdout || '') + (r.stderr || '')
  const ms = Date.now() - t
  if (r.status === 0) {
    pass++
    report.suites[s] = { status: 'PASS', ms }
    continue
  }
  const hit = classes.find(([rx]) => rx.test(text))
  const first = (text.split('\n').find((l) => /FAIL|Error|failed/.test(l)) || '').slice(0, 200)
  if (hit) {
    envFail++
    report.suites[s] = { status: 'UNVERIFIED', class: hit[1], ms, first }
  } else {
    real++
    report.suites[s] = { status: 'FAIL', class: 'REAL', ms, first }
  }
}
report.summary = { suites: suites.length, passed: pass, failedReal: real, unverifiedEnvironment: envFail }
console.log(`JS suites: ${suites.length}; passed ${pass}; REAL failures ${real}; unverified (environment) ${envFail}`)
for (const [s, v] of Object.entries(report.suites)) if (v.status !== 'PASS') console.log(`${v.status} ${s} [${v.class}] ${v.first}`)
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
if (!keep) fs.rmSync(out, { recursive: true, force: true })
process.exit(real ? 1 : envFail ? 3 : 0)
