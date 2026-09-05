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

// ── launcher parity (platform-aware, TASK-0025 RC6) ────────────────────────
// The Windows checkout ships the full .cmd launcher set; the installed Linux
// tree intentionally does NOT contain Windows .cmd launchers. Windows keeps
// the full .cmd -> Linux twin parity coverage unchanged; the Linux installed
// tree asserts its OWN POSIX launcher set (entrypoints, executability, POSIX
// hygiene) instead of demanding Windows artifacts that must never be copied
// into a Linux install.
const binDir = path.join(sourceRoot, 'bin')
const linuxBinDir = path.join(binDir, 'linux')
const cmdScriptRe = /scripts[\\/]+([A-Za-z0-9._-]+\.ps1)/
if (process.platform === 'win32') {
  const cmdLaunchers = fs.readdirSync(binDir).filter((name) => name.endsWith('.cmd'))
  ok(cmdLaunchers.length >= 15, 'bin contains the expected set of .cmd launchers')
  for (const cmdName of cmdLaunchers) {
    const base = cmdName.slice(0, -4)
    const twinPath = path.join(linuxBinDir, base + '.sh')
    ok(fs.existsSync(twinPath), 'Linux twin exists for ' + cmdName)
    const cmdText = fs.readFileSync(path.join(binDir, cmdName), 'utf8')
    const twinText = fs.readFileSync(twinPath, 'utf8')
    const cmdMatch = cmdText.match(cmdScriptRe)
    ok(cmdMatch !== null, cmdName + ' references a scripts/*.ps1 entrypoint')
    ok(twinText.includes('scripts/' + cmdMatch[1]), base + '.sh delegates to the same entrypoint as ' + cmdName)
    ok(twinText.includes('exec "$AIH_PWSH" -NoLogo -NoProfile -File'), base + '.sh execs the resolved host with a fixed argument vector')
    ok(twinText.includes('AIH_BAKED_ROOT=""'), base + '.sh keeps the bake marker for ~/.local/bin installs')
    ok(!twinText.includes('\r'), base + '.sh is LF-only')
  }
}
else {
  const shLaunchers = fs.readdirSync(linuxBinDir).filter((name) => name.endsWith('.sh'))
  ok(shLaunchers.length >= 15, 'bin/linux contains the expected POSIX launcher set')
  for (const shName of shLaunchers) {
    const shPath = path.join(linuxBinDir, shName)
    const shText = fs.readFileSync(shPath, 'utf8')
    ok(shText.startsWith('#!/bin/sh'), shName + ' has a POSIX shebang')
    ok(!shText.includes('\r'), shName + ' is LF-only')
    ok(!shText.includes('cmd.exe'), shName + ' never invokes cmd.exe')
    ok(shText.includes('exec "$AIH_PWSH" -NoLogo -NoProfile -File'), shName + ' execs the resolved host with a fixed argument vector')
    ok(shText.includes('AIH_BAKED_ROOT=""'), shName + ' keeps the bake marker for ~/.local/bin installs')
    const shMatch = shText.match(/scripts\/([A-Za-z0-9._-]+\.ps1)/)
    ok(shMatch !== null, shName + ' references a scripts/*.ps1 entrypoint')
    if (shMatch !== null) {
      ok(fs.existsSync(path.join(sourceRoot, 'scripts', shMatch[1])), shName + ' entrypoint ' + shMatch[1] + ' exists in the installed tree')
    }
    let executable = false
    try { fs.accessSync(shPath, fs.constants.X_OK); executable = true } catch (_) { }
    ok(executable, shName + ' is executable in the installed tree')
  }
  const strayLinuxCmd = fs.readdirSync(linuxBinDir).filter((name) => name.endsWith('.cmd'))
  ok(strayLinuxCmd.length === 0, 'bin/linux contains no fake Windows .cmd launchers')
  // The installed tree (pinned runtime present) must never receive the
  // Windows launcher set; a checkout tree legitimately still has them.
  const installedTree = fs.existsSync(path.join(sourceRoot, 'runtime', 'pwsh', 'pwsh'))
  if (installedTree) {
    const strayCmd = fs.readdirSync(binDir).filter((name) => name.endsWith('.cmd'))
    ok(strayCmd.length === 0, 'the installed Linux tree contains no fake Windows .cmd launchers')
  }
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

// ── pinned versions agreement ──────────────────────────────────────────────
const versions = JSON.parse(read('config/versions.json'))
ok(typeof versions.PowerShellVersion === 'string' && /^\d+\.\d+\.\d+$/.test(versions.PowerShellVersion), 'versions.json pins an exact PowerShellVersion')
ok(typeof versions.NodeVersion === 'string' && /^\d+\.\d+\.\d+$/.test(versions.NodeVersion), 'versions.json pins an exact NodeVersion')
const psd1 = read('config/versions.psd1')
ok(psd1.includes("PowerShellVersion = '" + versions.PowerShellVersion + "'"), 'versions.psd1 agrees with versions.json about PowerShellVersion')
ok(psd1.includes("NodeVersion = '" + versions.NodeVersion + "'"), 'versions.psd1 agrees with versions.json about NodeVersion')

console.log('RESULT: ' + passed + ' controller-host platform assertions passed.')
