'use strict'

/**
 * nexus/legacy-cli — the single bounded runner for the legacy PowerShell
 * controller CLIs (Task.ps1, Route.ps1, NexusWorkspace.ps1, Engineering.ps1,
 * Verify-Project.ps1, Review.ps1, VisualReview.ps1, ...).
 *
 * P1 extraction of the runner that lived inline in AihController.cjs. The
 * semantics are preserved byte-for-byte:
 *   - platform PowerShell host resolution (Windows PowerShell on Windows; on POSIX
 *     AIH_PWSH_HOST, then the pinned runtime/pwsh/pwsh, then `pwsh`);
 *   - toolchain root resolution (AIH_TOOLCHAIN_ROOT > owner tree > logical root)
 *     and AIH_TOOLCHAIN_ROOT exported to every child;
 *   - user-derived text travels only in a UTF-8 payload file (-PayloadFile),
 *     never on argv; the payload file is always removed;
 *   - fixed argv `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
 *     -File <scripts>/<script> ...args`, 320 s timeout, 64 MiB buffer;
 *   - Windows captures stdout/stderr through command-shell file redirection;
 *   - structured failure recovery: exit-3 JSON stdout is returned as a result,
 *     verification JSON on a non-zero exit is returned only when the caller
 *     opts in (tolerateNonZeroJson), anything else throws
 *     `aih-controller-cli-failed` with a redacted bounded diagnostic;
 *   - stdout is parsed leniently (parseCliJson), empty stdout returns null.
 *
 * It is an ordinary module (no Cordis lifetime). The host Nexus Controller owns
 * one instance; callers reach it only through typed controller adapters.
 */

const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const CLI_TIMEOUT_MS = 320000
const CLI_MAX_BUFFER = 64 * 1024 * 1024

// ── exact copies of the helpers that were inline in AihController.cjs ──────
/**
 * Parse JSON produced by Windows PowerShell 5.1 CLIs.
 *
 * PowerShell 5.1's ConvertTo-Json escapes most control characters but NOT all
 * of them (observed: raw U+001A inside a string). The controller bridge must
 * therefore accept JSON documents whose string values contain raw control
 * characters and recover the exact original text. Only control characters
 * INSIDE double-quoted strings are escaped; structural whitespace outside
 * strings is left untouched (JSON.parse already accepts it).
 */
function parseCliJson(text) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  if (source.trim() === '') return null
  let parsed = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        parsed += char
        escaped = false
        continue
      }
      if (char === '\\') {
        parsed += char
        escaped = true
        continue
      }
      if (char === '"') {
        parsed += char
        inString = false
        continue
      }
      const code = source.charCodeAt(index)
      if (code < 0x20) {
        parsed += '\\u' + code.toString(16).padStart(4, '0')
        continue
      }
      parsed += char
      continue
    }
    if (char === '"') {
      parsed += char
      inString = true
      continue
    }
    parsed += char
  }
  return JSON.parse(parsed)
}

/**
 * Recover a structured CLI result from a non-zero child exit.
 *
 * PowerShell CLIs in this controller emit JSON on stdout and exit non-zero
 * to report a STRUCTURED failure (hard budget rejection, packet-too-large).
 * Returns the stdout text when the exit code is the structured-failure
 * contract (3) and stdout is non-empty; returns null otherwise so the caller
 * rethrows the original error.
 */
function structuredCliStdout(error) {
  if (!error || typeof error !== 'object') return null
  if (Number(error.code) !== 3) return null
  const stdout = typeof error.stdout === 'string' ? error.stdout : ''
  return stdout.trim() === '' ? null : stdout
}

/**
 * TASK-0004: verification CLIs (Verify-Project.ps1) report FAILED CHECKS by
 * exiting non-zero while still emitting the complete structured JSON on
 * stdout (`exit 1` after `$summary | ConvertTo-Json`). A non-zero exit with
 * parseable verification-shaped JSON is therefore a VALID result (checks
 * failed), NOT an infrastructure failure. Returns the stdout when it parses
 * as a verification document (an array or an object carrying a `Results`
 * array); returns null otherwise so the caller rethrows the original error
 * (launch failure, timeout/abort, malformed output — genuine infrastructure
 * failures).
 */
function verificationCliStdout(error) {
  if (!error || typeof error !== 'object') return null
  const stdout = typeof error.stdout === 'string' ? error.stdout : ''
  if (stdout.trim() === '') return null
  try {
    const parsed = parseCliJson(stdout)
    if (Array.isArray(parsed) || (parsed && typeof parsed === 'object' && Array.isArray(parsed.Results))) return stdout
  } catch {
    /* not a structured verification result */
  }
  return null
}

function redactControllerDiagnostic(value) {
  return String(value == null ? '' : value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<redacted>')
    .replace(/((?:MODEL_API_KEY|API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|AUTHORIZATION)\s*[:=]\s*)([^\s,;]+)/gi, '$1<redacted>')
    .replace(/("(?:apiKey|api_key|accessToken|access_token|clientSecret|client_secret|password|authorization)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
}

function boundedControllerDiagnostic(value) {
  const redacted = redactControllerDiagnostic(value).trim()
  return redacted.length <= 2000 ? redacted : redacted.slice(0, 2000) + '…<truncated>'
}

/** Safe, structured child-process diagnostics. Payload contents and secrets
 * never enter this object; only the script, non-payload args, process status,
 * bounded redacted streams, and structured failure discriminator are kept. */
function controllerCliFailure(script, args, error) {
  const stdout = boundedControllerDiagnostic(error && error.stdout)
  const stderr = boundedControllerDiagnostic(error && error.stderr)
  let structuredKind = null
  let structuredCode = null
  try {
    const parsed = stdout === '' ? null : parseCliJson(stdout)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.kind === 'string') structuredKind = parsed.kind
      if (typeof parsed.code === 'string') structuredCode = parsed.code
    }
  } catch {
    /* ordinary diagnostic output */
  }
  return {
    script: path.basename(String(script || 'unknown')),
    args: Array.isArray(args) ? args.map((arg) => boundedControllerDiagnostic(arg)) : [],
    exitCode: error && error.code !== undefined ? error.code : null,
    signal: error && error.signal ? String(error.signal) : null,
    killed: Boolean(error && error.killed),
    stdout,
    stderr,
    structuredKind,
    structuredCode,
  }
}


/**
 * Create the runner.
 * @param {object} options
 * @param {string} options.installRoot logical InstallRoot (scripts/ lives here)
 * @param {string} options.dataRoot DSH_HOME data root (payload files go to <dataRoot>/tmp)
 * @param {string} [options.ownerRoot] tree that owns the calling module (toolchain candidate)
 * @param {number} [options.timeoutMs] test-only override of the 320 s CLI timeout
 * The child environment is process.env captured once at creation, exactly as
 * the pre-P1 bridge captured it at plugin apply.
 */
function createLegacyCli(options) {
  const installRoot = options.installRoot
  const dataRoot = options.dataRoot
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CLI_TIMEOUT_MS
  const scriptsRoot = path.join(installRoot, 'scripts')
  // Platform-aware PowerShell host resolution (mirror of scripts/Platform.ps1
  // Get-AihPowerShellHost): Windows keeps powershell.exe; POSIX prefers the
  // AIH_PWSH_HOST override, then the setup.sh-pinned runtime/pwsh/pwsh, then a
  // system pwsh on PATH. (Verbatim from the pre-P1 AihController bridge.)
  const resolvePowerShellHost = (root) => {
    if (process.platform === 'win32') return 'powershell.exe'
    const override = process.env.AIH_PWSH_HOST
    if (override) return override
    const pinned = path.join(root, 'runtime', 'pwsh', 'pwsh')
    try { fs.accessSync(pinned, fs.constants.X_OK); return pinned } catch { /* fall through */ }
    return 'pwsh'
  }
  // TASK-0026: the toolchain root (owns runtime/) is distinct from the logical
  // InstallRoot. Resolution chain: AIH_TOOLCHAIN_ROOT > the tree that owns the
  // calling controller module (options.ownerRoot) > the logical root.
  const resolveToolchainRoot = (logicalRoot) => {
    const candidates = []
    const fromEnv = process.env.AIH_TOOLCHAIN_ROOT
    if (fromEnv && String(fromEnv).trim() !== '') candidates.push(path.resolve(String(fromEnv)))
    if (options.ownerRoot) candidates.push(path.resolve(options.ownerRoot))
    if (logicalRoot) candidates.push(path.resolve(logicalRoot))
    for (const candidate of candidates) {
      try {
        if (fs.statSync(path.join(candidate, 'runtime', 'node')).isDirectory()) return candidate
      } catch (_) { /* candidate does not own a runtime */ }
    }
    return logicalRoot
  }
  const toolchainRoot = resolveToolchainRoot(installRoot)
  const childCliEnv = Object.assign({}, process.env, { AIH_TOOLCHAIN_ROOT: toolchainRoot })
  const pwshHost = resolvePowerShellHost(toolchainRoot)

  const runCli = promisify(execFile)
  const stats = { invocations: 0, failures: 0, timeouts: 0, inFlight: 0, maxInFlight: 0, byScript: Object.create(null) }
  // Capture transport (TASK-0017): on Windows each CLI runs through cmd.exe
  // with cmd-side redirection into temporary files (no pipes anywhere);
  // non-Windows platforms keep the original pipe transport.
  const quoteWindowsArg = (value) => {
    const text = String(value)
    if (text !== '' && !/[\s"]/.test(text)) return text
    return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
  }
  const readCliFile = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
  const spawnCaptured = (file, args, options) => {
    if (process.platform !== 'win32') return runCli(file, args, options)
    const token = process.pid + '-' + crypto.randomUUID()
    const outPath = path.join(os.tmpdir(), 'aih-cli-out-' + token + '.txt')
    const errPath = path.join(os.tmpdir(), 'aih-cli-err-' + token + '.txt')
    const batchPath = path.join(os.tmpdir(), 'aih-cli-' + token + '.cmd')
    const command = [file].concat(args).map(quoteWindowsArg).join(' ') + ' > "' + outPath + '" 2> "' + errPath + '"'
    fs.writeFileSync(batchPath, '@echo off\r\n' + command + '\r\n', 'utf8')
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn) => { if (!settled) { settled = true; fn() } }
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', batchPath], {
        stdio: 'ignore',
        windowsHide: !!(options && options.windowsHide),
        timeout: (options && options.timeout) || 0,
        env: (options && options.env) || process.env,
      })
      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', (code, signal) => finish(() => {
        const stdout = readCliFile(outPath)
        const stderr = readCliFile(errPath)
        try { fs.rmSync(outPath, { force: true }) } catch { /* best effort */ }
        try { fs.rmSync(errPath, { force: true }) } catch { /* best effort */ }
        try { fs.rmSync(batchPath, { force: true }) } catch { /* best effort */ }
        if (code === 0 && signal === null) return resolve({ stdout, stderr })
        const failure = new Error('Command failed: ' + file)
        failure.code = code === null ? null : code
        failure.killed = signal != null
        failure.signal = signal
        failure.stdout = stdout
        failure.stderr = stderr
        reject(failure)
      }))
    })
  }

  async function writePayloadFile(payload) {
    fs.mkdirSync(path.join(dataRoot, 'tmp'), { recursive: true })
    const payloadPath = path.join(dataRoot, 'tmp', 'aih-payload-' + crypto.randomUUID() + '.json')
    fs.writeFileSync(payloadPath, JSON.stringify(payload))
    return payloadPath
  }

  /**
   * Invoke one controller CLI.
   * @param {string} script file name under <installRoot>/scripts
   * @param {string[]} args fixed argv (never user free text)
   * @param {object} [invokeOptions]
   * @param {object} [invokeOptions.payload] UTF-8 payload file contents
   * @param {boolean} [invokeOptions.tolerateNonZeroJson] verification CLIs
   * @param {object} [invokeOptions.envOverlay] child-only environment additions
   */
  async function invoke(script, args, invokeOptions) {
    const diagnosticArgs = Array.isArray(args) ? [...args] : []
    const payload = invokeOptions && invokeOptions.payload
    let payloadPath = null
    let argv = Array.isArray(args) ? [...args] : []
    if (payload && typeof payload === 'object') {
      payloadPath = await writePayloadFile(payload)
      argv = [...argv, '-PayloadFile', payloadPath]
    }
    stats.invocations += 1
    stats.byScript[script] = (stats.byScript[script] || 0) + 1
    stats.inFlight += 1
    if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight
    try {
      const overlay = invokeOptions && invokeOptions.envOverlay
      const invocationEnv = overlay && Object.keys(overlay).length ? { ...childCliEnv, ...overlay } : childCliEnv
      const result = await spawnCaptured(
        pwshHost,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, script), ...argv],
        { timeout: timeoutMs, maxBuffer: CLI_MAX_BUFFER, windowsHide: true, env: invocationEnv },
      ).catch((error) => {
        // Structured failures (e.g. packet-too-large) exit 3 with JSON stdout.
        const recovered = structuredCliStdout(error)
        if (recovered !== null) return { stdout: recovered, stderr: (error && error.stderr) || '' }
        // Verification CLIs exit non-zero on FAILED checks with full JSON.
        if (invokeOptions && invokeOptions.tolerateNonZeroJson && verificationCliStdout(error) !== null) {
          const stdout = typeof error.stdout === 'string' ? error.stdout : ''
          return { stdout, stderr: (error && error.stderr) || '' }
        }
        stats.failures += 1
        if (error && error.killed) stats.timeouts += 1
        const failure = controllerCliFailure(script, diagnosticArgs, error)
        const detail = failure.structuredKind || failure.structuredCode || failure.stderr || failure.stdout || boundedControllerDiagnostic(error && error.message)
        const wrapped = new Error(`aih-controller: ${failure.script} failed (exit ${failure.exitCode == null ? 'unknown' : failure.exitCode})${detail ? ': ' + detail : ''}`)
        wrapped.code = 'aih-controller-cli-failed'
        wrapped.cause = error
        wrapped.cliFailure = failure
        throw wrapped
      })
      const text = (result.stdout || '').trim()
      if (!text) return null
      try {
        return parseCliJson(text)
      } catch (error) {
        throw new Error('aih-controller: ' + script + ' returned non-JSON output: ' + text.slice(0, 400) + ' (' + String(error && error.message) + ')')
      }
    } finally {
      stats.inFlight -= 1
      if (payloadPath) {
        try { fs.unlinkSync(payloadPath) } catch { /* best effort */ }
      }
    }
  }

  return Object.freeze({
    invoke,
    pwshHost,
    scriptsRoot,
    toolchainRoot,
    timeoutMs,
    stats: () => ({ ...stats, byScript: { ...stats.byScript } }),
  })
}

module.exports = {
  CLI_TIMEOUT_MS,
  createLegacyCli,
  parseCliJson,
  structuredCliStdout,
  verificationCliStdout,
  controllerCliFailure,
  redactControllerDiagnostic,
  boundedControllerDiagnostic,
}
