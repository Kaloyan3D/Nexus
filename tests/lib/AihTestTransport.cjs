'use strict'
// TASK-0025 RC4: ONE shared test CLI transport + platform PowerShell host
// resolution for the controller bridge suites.
//
// resolveAihPowerShellHost mirrors the PRODUCTION precedence in
// scripts/Platform.ps1 (Get-AihPowerShellHost) so the suites exercise the
// same host strategy as production on every OS:
//   Windows -> powershell.exe (production contract, unchanged)
//   POSIX   -> AIH_PWSH_HOST > <installRoot>/runtime/pwsh/pwsh > system pwsh
//
// createAihCliRunner preserves the TASK-0017 transport contract: sandboxed
// Windows environments deny anonymous-pipe/fd-redirected stdio capture from
// Node children (spawn EPERM), so each CLI runs through cmd.exe with
// cmd-side redirection into temporary files (no pipes anywhere). POSIX has
// no such restriction and captures directly. Both branches return the same
// shapes promisify(execFile) would produce, including the rejection shape
// (error.code/.stdout/.stderr/.signal).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const defaultToolchainRoot = () => path.join(__dirname, '..', '..')

// TASK-0026: the TOOLCHAIN root (owns runtime/) is resolved ahead of the
// logical InstallRoot so fixture-scoped CLIs still find the pinned runtime:
// AIH_TOOLCHAIN_ROOT > the tree that owns this transport (the repo root) >
// the caller-supplied root.
function resolveAihToolchainRoot(installRoot) {
  const candidates = []
  const fromEnv = process.env.AIH_TOOLCHAIN_ROOT
  if (fromEnv && String(fromEnv).trim() !== '') candidates.push(path.resolve(String(fromEnv)))
  candidates.push(defaultToolchainRoot())
  if (installRoot) candidates.push(path.resolve(installRoot))
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'runtime', 'node')).isDirectory()) return candidate
    } catch (_) { /* candidate does not own a runtime */ }
  }
  return installRoot || defaultToolchainRoot()
}

function resolveAihPowerShellHost(installRoot) {
  if (process.platform === 'win32') {
    return 'powershell.exe'
  }
  const fromEnv = process.env.AIH_PWSH_HOST
  if (fromEnv && String(fromEnv).trim() !== '') {
    return fromEnv
  }
  const root = resolveAihToolchainRoot(installRoot)
  const pinned = path.join(root, 'runtime', 'pwsh', 'pwsh')
  if (fs.existsSync(pinned)) {
    return pinned
  }
  const probe = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' })
  if (!probe.error) {
    return 'pwsh'
  }
  throw new Error('Nexus requires a PowerShell 7 runtime (pwsh). Run the Nexus installer (./setup.sh) to install the pinned runtime, or install pwsh and re-run it.')
}

function createAihCliRunner() {
  let runSeq = 0
  return async (file, args, opts) => {
    // Every spawned CLI child carries the TOOLCHAIN anchor so fixture-copy
    // scripts resolve the real pinned runtime (TASK-0026). The caller's
    // env, when supplied, wins.
    const childEnv = Object.assign(
      {},
      process.env,
      { AIH_TOOLCHAIN_ROOT: defaultToolchainRoot() },
      (opts && opts.env) || {},
    )
    const childOpts = Object.assign({}, opts, { env: childEnv })
    if (process.platform !== 'win32') {
      // POSIX: direct capture is safe there (the TASK-0017 anonymous-pipe
      // EPERM boundary is a Windows-sandbox restriction, not a POSIX one).
      // Keep the same result/failure shapes as the Windows cmd.exe transport.
      const direct = spawnSync(file, args, Object.assign({}, childOpts, { encoding: 'utf8' }))
      const stdout = direct.stdout || ''
      const stderr = direct.stderr || ''
      if (direct.error) {
        direct.error.stdout = stdout
        direct.error.stderr = stderr
        throw direct.error
      }
      if (direct.status !== 0) {
        const failure = new Error('Command failed: ' + file)
        failure.code = direct.status === null ? -1 : direct.status
        failure.killed = direct.signal != null
        failure.signal = direct.signal
        failure.stdout = stdout
        failure.stderr = stderr
        throw failure
      }
      return { stdout, stderr }
    }
    const seq = ++runSeq
    const token = process.pid + '-' + seq
    const outPath = path.join(os.tmpdir(), 'aih-cli-out-' + token + '.txt')
    const errPath = path.join(os.tmpdir(), 'aih-cli-err-' + token + '.txt')
    const batchPath = path.join(os.tmpdir(), 'aih-cli-' + token + '.cmd')
    const q = (value) => '"' + String(value) + '"'
    const command = [q(file)].concat(args.map(q)).join(' ') + ' > ' + q(outPath) + ' 2> ' + q(errPath)
    fs.writeFileSync(batchPath, '@echo off\r\n' + command + '\r\n', 'utf8')
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', batchPath], Object.assign({}, childOpts, { stdio: 'ignore', windowsHide: true }))
    const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (_) { return '' } }
    const stdout = read(outPath)
    const stderr = read(errPath)
    try { fs.rmSync(outPath, { force: true }) } catch (_) { }
    try { fs.rmSync(errPath, { force: true }) } catch (_) { }
    try { fs.rmSync(batchPath, { force: true }) } catch (_) { }
    if (result.error) {
      result.error.stdout = stdout
      result.error.stderr = stderr
      throw result.error
    }
    if (result.status !== 0) {
      const failure = new Error('Command failed: ' + file)
      failure.code = result.status === null ? -1 : result.status
      failure.killed = result.signal != null
      failure.signal = result.signal
      failure.stdout = stdout
      failure.stderr = stderr
      throw failure
    }
    return { stdout, stderr }
  }
}

module.exports = { resolveAihPowerShellHost, resolveAihToolchainRoot, createAihCliRunner }
