'use strict'

/**
 * TASK-0023 (native Linux support): JS-plane platform assertions.
 *
 * Deterministic, no network, no real runtime spawns:
 *   - the controller bridge and the Nexus UI controller resolve the
 *     PowerShell host platform-aware (Windows keeps powershell.exe; POSIX
 *     prefers AIH_PWSH_HOST, the setup.sh-pinned runtime/pwsh/pwsh, then a
 *     system pwsh),
 *   - every Windows .cmd launcher has a Linux twin that delegates to the
 *     SAME scripts/<X>.ps1 entrypoint,
 *   - the Linux update path delegates to setup.sh,
 *   - the pinned versions files agree about PowerShellVersion.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sourceRoot = path.join(__dirname, '..')
let passed = 0
function ok(condition, name) {
  if (!condition) {
    console.error('FAIL: ' + name)
    process.exit(1)
  }
  passed += 1
  console.log('PASS: ' + name)
}

function read(rel) {
  return fs.readFileSync(path.join(sourceRoot, rel), 'utf8')
}

// ── controller bridge host resolution ──────────────────────────────────────
const controllerSource = read('config/AihController.cjs')
ok(controllerSource.includes('const resolvePowerShellHost = (root) => {'), 'controller bridge contains the platform host resolver')
ok(controllerSource.includes("if (process.platform === 'win32') return 'powershell.exe'"), 'controller bridge keeps powershell.exe on Windows')
ok(controllerSource.includes("path.join(root, 'runtime', 'pwsh', 'pwsh')"), 'controller bridge prefers the setup.sh-pinned runtime/pwsh/pwsh on POSIX')
ok(!controllerSource.includes("spawnCaptured(\n        'powershell.exe'"), 'invokePowerShell spawns through the resolved host, not a hardcoded powershell.exe')
ok(controllerSource.includes('executable: pwshHost'), 'verification plan executable uses the resolved host')
ok(controllerSource.includes("if (process.platform !== 'win32') return runCli(file, args, options)"), 'spawnCaptured keeps the direct POSIX transport (TASK-0017 symmetry)')

// ── Nexus UI controller host resolution ────────────────────────────────────
const uiSource = read('ui/nexus-controller/lib/index.js')
ok(uiSource.includes("if (process.platform === 'win32') return 'powershell.exe'"), 'UI controller keeps powershell.exe on Windows')
ok(uiSource.includes('accessSync(pinned, constants.X_OK)'), 'UI controller probes the pinned pwsh for executability')
ok(!uiSource.includes("execFile('powershell.exe'"), 'UI controller execFile sites use the resolved host')
ok(uiSource.includes("execFile(pwshHost, "), 'UI controller Task.ps1/EngineeringProfile.ps1 calls go through pwshHost')

// ── launcher parity (layout-plane aware, TASK-0025 Class C) ────────────────
// The launcher-layout abstraction (tests/lib/AihLauncherLayout.cjs, JS twin
// of scripts/Platform.ps1 Get-AihLauncherLayout) distinguishes the planes by
// TREE CONTENT, never by OS alone:
//   source            - the checkout (Windows AND Linux) asserts the full
//                       .cmd -> POSIX twin parity plus the POSIX template
//                       hygiene contract.
//   installed-posix   - the installed Linux tree asserts its OWN extensionless
//                       launcher contract (entrypoints, executability, POSIX
//                       hygiene) instead of demanding source artifacts that
//                       must never be copied into an install, and asserts the
//                       absence of both fake .cmd artifacts and the
//                       source-layout bin/linux twin directory.
//   installed-windows - the installed Windows tree asserts its .cmd set and
//                       the absence of the twin directory.
const { detectLauncherLayout } = require('./lib/AihLauncherLayout.cjs')
const binDir = path.join(sourceRoot, 'bin')
const linuxBinDir = path.join(binDir, 'linux')
const cmdScriptRe = /scripts[\\/]+([A-Za-z0-9._-]+\.ps1)/
const layout = detectLauncherLayout(sourceRoot)
ok(layout.kind !== 'unknown', 'launcher layout plane is detectable from the tree')
if (layout.kind === 'source') {
  const cmdLaunchers = fs.readdirSync(binDir).filter((name) => name.endsWith('.cmd'))
  ok(cmdLaunchers.length >= 15, 'bin contains the expected set of .cmd launchers')
  const shTemplates = fs.readdirSync(linuxBinDir).filter((name) => name.endsWith('.sh'))
  for (const shName of shTemplates) {
    const shText = fs.readFileSync(path.join(linuxBinDir, shName), 'utf8')
    ok(shText.startsWith('#!/bin/sh'), shName + ' has a POSIX shebang')
    ok(!shText.includes('\r'), shName + ' is LF-only')
    ok(!shText.includes('cmd.exe'), shName + ' never invokes cmd.exe')
    ok(shText.includes('exec "$AIH_PWSH" -NoLogo -NoProfile -File'), shName + ' execs the resolved host with a fixed argument vector')
    ok(shText.includes('AIH_BAKED_ROOT=""'), shName + ' keeps the bake marker for ~/.local/bin installs')
  }
  for (const cmdName of cmdLaunchers) {
    const base = cmdName.slice(0, -4)
    const twinPath = path.join(linuxBinDir, base + '.sh')
    ok(fs.existsSync(twinPath), 'Linux twin exists for ' + cmdName)
    const cmdText = fs.readFileSync(path.join(binDir, cmdName), 'utf8')
    const twinText = fs.readFileSync(twinPath, 'utf8')
    const cmdMatch = cmdText.match(cmdScriptRe)
    ok(cmdMatch !== null, cmdName + ' references a scripts/*.ps1 entrypoint')
    ok(twinText.includes('scripts/' + cmdMatch[1]), base + '.sh delegates to the same entrypoint as ' + cmdName)
  }
  const strayLinuxCmd = fs.readdirSync(linuxBinDir).filter((name) => name.endsWith('.cmd'))
  ok(strayLinuxCmd.length === 0, 'bin/linux contains no fake Windows .cmd launchers')
}
else if (layout.kind === 'installed-posix') {
  ok(!fs.existsSync(linuxBinDir), 'the installed POSIX tree does not carry the source-layout bin/linux twin templates')
  const launchers = fs.readdirSync(binDir).filter((name) => name.startsWith('aih') && !name.includes('.'))
  ok(launchers.length >= 15, 'the installed POSIX tree publishes the extensionless launcher set')
  for (const name of launchers) {
    const launcherPath = path.join(binDir, name)
    const text = fs.readFileSync(launcherPath, 'utf8')
    ok(text.startsWith('#!/bin/sh'), name + ' has a POSIX shebang')
    ok(!text.includes('\r'), name + ' is LF-only')
    ok(!text.includes('cmd.exe'), name + ' never invokes cmd.exe')
    ok(text.includes('exec "$AIH_PWSH" -NoLogo -NoProfile -File'), name + ' execs the resolved host with a fixed argument vector')
    ok(text.includes('AIH_BAKED_ROOT='), name + ' keeps the bake marker')
    const match = text.match(/scripts\/([A-Za-z0-9._-]+\.ps1)/)
    ok(match !== null, name + ' references a scripts/*.ps1 entrypoint')
    if (match !== null) {
      ok(fs.existsSync(path.join(sourceRoot, 'scripts', match[1])), name + ' entrypoint ' + match[1] + ' exists in the installed tree')
    }
    let executable = false
    try { fs.accessSync(launcherPath, fs.constants.X_OK); executable = true } catch (_) { }
    ok(executable, name + ' is executable in the installed tree')
  }
  const strayCmd = fs.readdirSync(binDir).filter((name) => name.endsWith('.cmd'))
  ok(strayCmd.length === 0, 'the installed Linux tree contains no fake Windows .cmd launchers')
}
else {
  ok(layout.windowsLauncherCount >= 15, 'the installed Windows tree contains the .cmd launcher set')
  ok(!fs.existsSync(linuxBinDir), 'the installed Windows tree does not carry the source-layout bin/linux twin templates')
}

// ── update flow parity ─────────────────────────────────────────────────────
const updateSource = read('scripts/Update.ps1')
ok(updateSource.includes("Test-AihIsWindows"), 'Update.ps1 branches on the platform helper (never $IsWindows)')
ok(updateSource.includes("Join-Path $SourceRoot 'setup.sh'"), 'Update.ps1 delegates the Linux update to setup.sh')
const setupSh = read('setup.sh')
ok(setupSh.startsWith('#!/bin/sh'), 'setup.sh is a POSIX sh script')
ok(setupSh.includes('Complete-Install.ps1'), 'setup.sh runs the shared install composition')
ok(setupSh.includes('$HOME/.local/bin'), 'setup.sh installs user launchers into ~/.local/bin')
ok(fs.existsSync(path.join(sourceRoot, 'scripts', 'Complete-Install.ps1')), 'Complete-Install.ps1 exists')

// ── pinned versions: plane-aware composition (TASK-0026) ──────────────────
// config/versions.json is the AUTHORITATIVE version metadata in EVERY plane
// (the install composition copies it into both installed trees).
// config/versions.psd1 is a SOURCE-ONLY mirror - Setup.ps1's config copy
// list never includes it, so the installed POSIX tree legitimately has no
// such file (reading it unconditionally crashed this suite on CachyOS with
// ENOENT). The source plane asserts the two files agree; installed planes
// assert versions.json alone and treat a present psd1 as an optional
// mirror that must still agree.
const versions = JSON.parse(read('config/versions.json'))
ok(typeof versions.PowerShellVersion === 'string' && /^\d+\.\d+\.\d+$/.test(versions.PowerShellVersion), 'versions.json pins an exact PowerShellVersion')
ok(typeof versions.NodeVersion === 'string' && /^\d+\.\d+\.\d+$/.test(versions.NodeVersion), 'versions.json pins an exact NodeVersion')
if (layout.kind === 'source') {
  const psd1 = read('config/versions.psd1')
  ok(psd1.includes("PowerShellVersion = '" + versions.PowerShellVersion + "'"), 'versions.psd1 agrees with versions.json about PowerShellVersion (source plane)')
  ok(psd1.includes("NodeVersion = '" + versions.NodeVersion + "'"), 'versions.psd1 agrees with versions.json about NodeVersion (source plane)')
} else {
  const psd1Path = path.join(sourceRoot, 'config', 'versions.psd1')
  if (fs.existsSync(psd1Path)) {
    const psd1 = fs.readFileSync(psd1Path, 'utf8')
    ok(psd1.includes("PowerShellVersion = '" + versions.PowerShellVersion + "'"), 'installed plane: present versions.psd1 mirror agrees about PowerShellVersion')
    ok(psd1.includes("NodeVersion = '" + versions.NodeVersion + "'"), 'installed plane: present versions.psd1 mirror agrees about NodeVersion')
  } else {
    ok(true, 'installed plane: versions.json is the authoritative version metadata (versions.psd1 is source-only)')
  }
}

console.log('RESULT: ' + passed + ' controller-host platform assertions passed.')
