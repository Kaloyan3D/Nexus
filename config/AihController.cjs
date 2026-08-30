'use strict'

/**
 * aih-controller — the GUI -> deterministic-controller bridge for AI Harness.
 *
 * The vNext controller (TaskController.ps1 / Routing.ps1 / CodexReview.ps1)
 * lives on the PowerShell plane and is invoked by the CLI (aih-task,
 * aih-route, aih-context, aih-review). Previously the Web GUI message path
 * went straight from the chat to the root DeepSeek model with no task state,
 * no routing decision, and no way for an explicit user review request to
 * reach the bounded Codex Review Service.
 *
 * This plugin is mounted in the aih-engineering and aih-deepseek agent
 * presets (see Setup.ps1). It:
 *
 *  - binds every GUI session to a TaskController task and records the routing
 *    decision (execution class) as real controller state;
 *  - exposes DSH_AIH_TASK_ID / DSH_AIH_EXECUTION_CLASS / DSH_AIH_REVIEW_REQUIRED
 *    to the agent environment so the selected execution path is visible;
 *  - posts a visible controller notice into the session so the UI shows the
 *    execution path (ENGINEER NORMAL vs INDEPENDENT REVIEW);
 *  - implements the explicit /review (legacy /codex-review) command:
 *    TaskController -> execution class reviewer -> bounded Review Packet ->
 *    hard budget validation -> ONE fresh read-only independent review ->
 *    ReviewResult -> telemetry. No engineering audit runs first; the turn is
 *    rejected so the review is controller-owned (0 engineer calls);
 *  - feeds deterministic failure signals (turn errors) into the routing
 *    state, so the same normalized-failure escalation to the reviewer works
 *    from GUI sessions;
 *  - returns review findings to the Deep Engineer for repair
 *    (review-findings signal).
 *
 * The reviewer is never exposed to the model as a tool: the preset keeps
 * tool-subagent-codex disabled and the review service is invoked only by this
 * controller bridge, always through New-AihReviewPacket budget enforcement.
 * The reviewer model is resolved from the ACTIVE ENGINEERING PROFILE (the
 * reviewer role); it can never become the root engineering model.
 */

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const REVIEW_COMMAND = /^\s*\/(?:codex-)?review\b/i
const VERIFY_COMMAND = /^\s*\/verify\b/i
const MAX_FILES = 8
const MAX_CONTEXT_TOKENS = 30000
const CLI_TIMEOUT_MS = 320000

// ── pure helpers (exported for deterministic tests) ─────────────────────────

function isReviewCommand(text) {
  return typeof text === 'string' && REVIEW_COMMAND.test(text)
}

function isVerifyCommand(text) {
  return typeof text === 'string' && VERIFY_COMMAND.test(text)
}

/** True when an execution class is the read-only reviewer class (canonical
 *  or legacy alias), so old persisted classes keep working. */
function isReviewClass(executionClass) {
  return canonicalExecutionClass(executionClass) === 'reviewer'
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

function reviewQuestionOf(text) {
  if (typeof text !== 'string') return ''
  const match = text.match(/^\s*\/(?:codex-)?review\b[\s:]*(.*)$/is)
  return match ? match[1].trim() : text.trim()
}

// ── deterministic review context classification ─────────────────────────────
//
// Progressive disclosure for explicit reviews: the packet starts from the
// question itself and repository context is added only when the question
// actually needs it.
//
//   A. self-contained inline review  -> 'inline'  (question-only packet)
//   B. explicitly referenced files   -> 'files'   (exactly the named files)
//   C. repository/task review        -> 'bundle'  (Context Engine, in budget)
//
// Classification is deterministic request metadata, not keyword guessing:
// path-shaped tokens that resolve to real workspace files win; otherwise an
// inline code definition (fenced block or function/class/arrow) marks a
// self-contained question; everything else falls through to the Context
// Engine. Existence checks make the decision reproducible for tests.

const REVIEW_FILE_EXTENSIONS =
  'js|cjs|mjs|ts|tsx|jsx|py|ps1|psm1|cs|fs|go|rs|java|kt|rb|php|sh|bat|cmd|sql|md|json|yml|yaml|toml|xml|html|css|vue|svelte|ini|cfg|conf|txt|env'
const REVIEW_FILE_TOKEN_RE = new RegExp('[\\w@][\\w.\/\\\\@+_-]*\.(?:' + REVIEW_FILE_EXTENSIONS + ')(?![\\w.])', 'gi')
const REVIEW_INLINE_CODE_RES = [
  /\`\`\`[\s\S]*?\`\`\`/,
  /\bfunction\s+[\w$]+\s*\([^)]*\)\s*\{/,
  /\bclass\s+[\w$]+\s*\{/,
  /\b(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/,
]
const REVIEW_FILE_MAX_BYTES = 64 * 1024 * 1024

function referencedFilesOf(question) {
  if (typeof question !== 'string') return []
  const tokens = []
  const seen = new Set()
  for (const raw of question.match(REVIEW_FILE_TOKEN_RE) || []) {
    const token = raw.replace(/^[`"'']+|[`"'']+$/g, '').replace(/\\/g, '/')
    if (seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
    if (tokens.length >= MAX_FILES) break
  }
  return tokens
}

function hasInlineCode(question) {
  return typeof question === 'string' && REVIEW_INLINE_CODE_RES.some((re) => re.test(question))
}

function resolveReviewFiles(workspace, question) {
  const root = path.resolve(String(workspace || ''))
  const slices = []
  for (const token of referencedFilesOf(question)) {
    if (slices.length >= MAX_FILES) break
    const candidate = path.resolve(root, token)
    if (candidate !== root && !candidate.startsWith(root + path.sep)) continue
    let stat
    try { stat = fs.statSync(candidate) } catch { continue }
    if (!stat.isFile() || stat.size > REVIEW_FILE_MAX_BYTES) continue
    let content
    try { content = fs.readFileSync(candidate, 'utf8') } catch { continue }
    slices.push({ path: token, score: 0, content, truncated: false })
  }
  return slices
}

function classifyReviewContext(workspace, question) {
  if (referencedFilesOf(question).length > 0) {
    return resolveReviewFiles(workspace, question).length > 0 ? 'files' : 'bundle'
  }
  return hasInlineCode(question) ? 'inline' : 'bundle'
}

function textOf(message) {
  if (!message || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  const textBlock = blocks.find((block) => block && block.type === 'text' && typeof block.text === 'string')
  return textBlock ? textBlock.text : ''
}

function isUserPrompt(message) {
  return Boolean(
    message &&
      message.role === 'user' &&
      message.source &&
      message.source.kind === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block && block.type === 'text'),
  )
}

function userPromptMessages(messages) {
  return Array.isArray(messages) ? messages.filter(isUserPrompt) : []
}

function isWorkerAgent(header) {
  return Boolean(header && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0))
}

// Phase 2: labels describe EXECUTION SEMANTICS, never model identity. The
// actual model/provider for a run is reported separately (routing decision
// fields), so the UI never implies a vendor from the execution class.
const EXECUTION_CLASS_LABELS = {
  deterministic: 'Deterministic',
  engineer_normal: 'Engineer \u00b7 Normal',
  engineer_deep: 'Engineer \u00b7 Deep',
  reviewer: 'Independent Review (read-only, bounded)',
  solver: 'Solve (writable, approval-gated)',
}
const LEGACY_EXECUTION_CLASS_ALIASES = {
  deepseek_normal: 'engineer_normal',
  deepseek_deep: 'engineer_deep',
  codex_review: 'reviewer',
  codex_solve: 'solver',
}

function canonicalExecutionClass(executionClass) {
  if (typeof executionClass !== 'string' || executionClass === '') return executionClass
  const key = executionClass.trim().toLowerCase()
  return LEGACY_EXECUTION_CLASS_ALIASES[key] || key
}

function executionClassLabel(executionClass) {
  return EXECUTION_CLASS_LABELS[canonicalExecutionClass(executionClass)] || 'Engineer \u00b7 Normal'
}

function createControllerMessage(text, form) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'aih-controller', form: form ?? 'notice' },
  }
}

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

// ── plugin ──────────────────────────────────────────────────────────────────

function apply(ctx) {
  const installRoot = process.env.DSH_HOME
    ? path.dirname(path.resolve(process.env.DSH_HOME))
    : 'C:\\AI-Harness'
  const dataRoot = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(installRoot, 'data')
  const bindingsPath = path.join(dataRoot, 'routing', 'session-bindings.json')
  const tmpRoot = path.join(dataRoot, 'tmp')
  const scriptsRoot = path.join(installRoot, 'scripts')

  const runCli = promisify(execFile)
  const bindings = loadBindings(bindingsPath)

  function log(entry) {
    try {
      const logDir = path.join(dataRoot, 'logs')
      fs.mkdirSync(logDir, { recursive: true })
      const line = JSON.stringify({ ts: new Date().toISOString(), plugin: 'aih-controller', ...entry })
      fs.appendFileSync(path.join(logDir, 'aih-controller.log'), line + '\n')
    } catch {
      /* logging must never break the agent loop */
    }
  }

  function persistBindings() {
    try {
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true })
      // Persist ONLY the durable binding fields (whitelist): the live
      // `_session` reference (assigned per turn for completion notices) and
      // any other runtime-only property must never be serialized.
      const serializable = {}
      for (const [sessionId, binding] of Object.entries(bindings)) {
        serializable[sessionId] = {
          sessionId: binding.sessionId,
          taskId: binding.taskId,
          workspace: binding.workspace,
          preset: binding.preset,
          description: binding.description,
          executionClass: binding.executionClass,
          reviewRequired: binding.reviewRequired,
          needsRouteCheck: binding.needsRouteCheck,
          boundAtUtc: binding.boundAtUtc,
        }
      }
      const temporary = bindingsPath + '.' + crypto.randomUUID() + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, bindings: serializable }, null, 2))
      fs.renameSync(temporary, bindingsPath)
    } catch (error) {
      log({ event: 'bindings-persist-failed', error: String(error) })
    }
  }

  async function writePayloadFile(payload) {
    fs.mkdirSync(path.join(dataRoot, 'tmp'), { recursive: true })
    const payloadPath = path.join(dataRoot, 'tmp', 'aih-payload-' + crypto.randomUUID() + '.json')
    fs.writeFileSync(payloadPath, JSON.stringify(payload))
    return payloadPath
  }

  /**
   * Invoke one controller CLI. User-derived free text (descriptions, review
   * questions) NEVER travels on the command line: Windows PowerShell decodes
   * argv through the ANSI codepage (mangling non-ASCII text) and its
   * ConvertTo-Json leaves some control characters raw, so a strict JSON.parse
   * of the CLI stdout can fail even though the CLI itself succeeded. The
   * bridge passes user text in a UTF-8 payload file named by -PayloadFile and
   * parses the CLI's stdout leniently.
   */
  async function invokePowerShell(script, args, options) {
    const payload = options && options.payload
    let payloadPath = null
    if (payload && typeof payload === 'object') {
      payloadPath = await writePayloadFile(payload)
      args = [...args, '-PayloadFile', payloadPath]
    }
    try {
      const result = await runCli(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, script), ...args],
        { timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      ).catch((error) => {
        // PowerShell CLIs report STRUCTURED failures (hard budget rejection,
        // e.g. packet-too-large) by emitting JSON on stdout and exiting 3.
        // execFile rejects on any non-zero exit; recover the stdout so the
        // structured reason reaches the GUI instead of a bare "Command failed".
        const recovered = structuredCliStdout(error)
        if (recovered !== null) return { stdout: recovered, stderr: (error && error.stderr) || '' }
        // TASK-0004: verification CLIs exit non-zero when checks FAIL while
        // still emitting the full structured JSON on stdout. Recover that
        // stdout so the caller consumes the real result (failed checks)
        // instead of treating a VALID failed verification as an
        // infrastructure exception.
        if (options && options.tolerateNonZeroJson && verificationCliStdout(error) !== null) {
          const stdout = typeof error.stdout === 'string' ? error.stdout : ''
          return { stdout, stderr: (error && error.stderr) || '' }
        }
        throw error
      })
      const text = (result.stdout || '').trim()
      if (!text) return null
      try {
        return parseCliJson(text)
      } catch (error) {
        throw new Error('aih-controller: ' + script + ' returned non-JSON output: ' + text.slice(0, 400) + ' (' + String(error && error.message) + ')')
      }
    } finally {
      if (payloadPath) {
        try { fs.unlinkSync(payloadPath) } catch { /* best effort */ }
      }
    }
  }

  async function createTask(workspace, description, reviewRequested) {
    const task = await invokePowerShell('Task.ps1', ['-Action', 'create-task'], {
      payload: { workspace, description, reviewRequested: Boolean(reviewRequested) },
    })
    if (!task || !task.taskId) throw new Error('aih-controller: task creation returned no taskId')
    return task
  }

  async function routeTask(workspace, taskId, description, options = {}) {
    const payload = { workspace, description }
    if (options.signal) payload.signal = options.signal
    if (options.failureReason) payload.failureReason = options.failureReason
    if (options.reviewRequested) payload.reviewRequested = true
    const args = ['-TaskId', taskId, '-Preset', options.preset ?? 'aih-engineering']
    const decision = await invokePowerShell('Route.ps1', args, { payload })
    if (!decision || !decision.executionClass) throw new Error('aih-controller: routing returned no execution class')
    return decision
  }

  async function markReviewRequested(workspace, taskId) {
    await invokePowerShell('Task.ps1', ['-Action', 'set-review-requested', '-TaskId', taskId], {
      payload: { workspace },
    })
  }

  // ── TASK-0004: controller-owned attempt/verification/gate lifecycle ─────
  // Every GUI lifecycle event below is a REAL producer boundary: attempts and
  // verification records come from the PowerShell controller CLIs (which own
  // the ledger), gates come from the shared gate module, and the browser is
  // never a producer. Nothing here is derived from polling or timestamps.

  function loadGateModule() {
    try {
      const requireFromApp = createRequire(path.join(installRoot, 'app', 'package.json'))
      try {
        return requireFromApp(path.join(dataRoot, 'profiles', 'node_modules', '@nexus', 'controller', 'lib', 'gate.cjs'))
      } catch {
        return requireFromApp(path.join(installRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'))
      }
    } catch {
      return null
    }
  }

  const gateModule = loadGateModule()

  function attemptsRecordsOf(workspace, taskId) {
    const filePath = path.join(workspace, '.ai-harness', 'runs', taskId, 'attempts.jsonl')
    try {
      const records = []
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try { records.push(JSON.parse(trimmed)) } catch { /* skip corrupt line */ }
      }
      return records
    } catch {
      return []
    }
  }

  function latestAttemptOf(workspace, taskId) {
    const records = attemptsRecordsOf(workspace, taskId)
    let latest = null
    for (const record of records) {
      if (record && record.taskId === taskId) latest = record
    }
    return latest
  }

  function attemptIsOpen(record) {
    return Boolean(record && (record.status === 'started' || record.status === 'verifying'))
  }

  async function beginAttempt(binding, turn) {
    return invokePowerShell('Task.ps1', ['-Action', 'begin-attempt', '-TaskId', binding.taskId, '-ExecutionClass', binding.executionClass || 'engineer_normal'], {
      payload: {
        workspace: binding.workspace,
        sessionId: binding.sessionId,
        startedByTurn: String(turn ?? ''),
        requireNoOpenAttempt: true,
      },
    })
  }

  async function attemptEvent(binding, status, extra) {
    const payload = { workspace: binding.workspace, taskId: binding.taskId, status }
    if (extra && extra.reason) payload.reason = extra.reason
    if (extra && extra.failureSignature) payload.failureSignature = extra.failureSignature
    if (extra && extra.evidence) payload.evidence = extra.evidence
    return invokePowerShell('Task.ps1', ['-Action', 'attempt-event', '-TaskId', binding.taskId], { payload })
  }

  async function recordFailure(binding, signature, evidence) {
    return invokePowerShell('Task.ps1', ['-Action', 'failure', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, failureSignature: signature, evidence: evidence || '' },
    })
  }

  async function writeEvidence(binding, evidenceDoc) {
    return invokePowerShell('Task.ps1', ['-Action', 'evidence', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, evidenceDoc },
    })
  }

  async function completionCheck(binding, codexReviewPassed) {
    const args = ['-Action', 'complete', '-TaskId', binding.taskId]
    if (codexReviewPassed) args.push('-CodexReviewPassed')
    return invokePowerShell('Task.ps1', args, { payload: { workspace: binding.workspace } })
  }

  function readReviewResult(workspace, taskId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(workspace, '.ai-harness', 'runs', taskId, 'review-result.json'), 'utf8'))
    } catch {
      return null
    }
  }

  function readEvidence(workspace, taskId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(workspace, '.ai-harness', 'runs', taskId, 'evidence.json'), 'utf8'))
    } catch {
      return null
    }
  }

  function ensureGateFor(binding, verdict, attempt) {
    if (!gateModule) {
      log({ event: 'gate-module-unavailable' })
      return null
    }
    try {
      return gateModule.ensureGate(dataRoot, binding, 'review-required', { attempt, reviewVerdict: verdict })
    } catch (error) {
      log({ event: 'gate-ensure-failed', error: String(error) })
      return null
    }
  }

  function supersedeGateFor(binding, reason) {
    if (!gateModule) return null
    try {
      return gateModule.supersedeGate(dataRoot, binding, reason)
    } catch (error) {
      log({ event: 'gate-supersede-failed', error: String(error) })
      return null
    }
  }

  /**
   * Crash reconciliation (restart-safe): an attempt left in 'verifying' by a
   * process crash must never stay open forever. Truth comes only from real
   * records: a completed evidence artifact for that attempt closes it
   * (passed/failed from the artifact); a missing artifact marks it
   * interrupted. Runs at the producer boundary (pre-step), before any new
   * attempt can begin — so a restart never silently creates Attempt N+1.
   */
  async function reconcileAttempt(binding) {
    const latest = latestAttemptOf(binding.workspace, binding.taskId)
    if (!latest || latest.status !== 'verifying') return null
    const evidence = readEvidence(binding.workspace, binding.taskId)
    const evidenceMatches = evidence && evidence.attempt === latest.sequence && typeof evidence.finishedAtUtc === 'string'
    if (evidenceMatches) {
      const checks = Array.isArray(evidence.verification) ? evidence.verification : []
      const failed = checks.some((check) => check && String(check.status || '').toUpperCase() === 'FAIL')
      if (failed) {
        await recordFailure(binding, 'verification-failed', 'verification completed before restart but failed ' + checks.filter((c) => c && String(c.status || '').toUpperCase() === 'FAIL').length + ' check(s)').catch(() => null)
      } else {
        await attemptEvent(binding, 'passed').catch(() => null)
        await runCompletionTail(binding, binding._session).catch((error) => log({ event: 'reconcile-completion-failed', error: String(error) }))
      }
      return { reconciled: true, outcome: failed ? 'failed' : 'passed' }
    }
    await attemptEvent(binding, 'interrupted', { reason: 'verification-incomplete' }).catch(() => null)
    return { reconciled: true, outcome: 'interrupted' }
  }

  /** Completion decision after a passed verification (review disposition aware). */
  async function runCompletionTail(binding, session) {
    const review = readReviewResult(binding.workspace, binding.taskId)
    const reviewPass = Boolean(review && String(review.verdict) === 'pass')
    const completion = await completionCheck(binding, reviewPass)
    const complete = Boolean(completion && completion.complete)
    if (complete) {
      appendMessage(
        session,
        createControllerMessage(
          'Controller: task ' + binding.taskId + ' COMPLETE.\nCompletion authority: deterministic controller. Verification passed' + (reviewPass ? '; bounded review passed.' : '.'),
          'controller-complete',
        ),
      )
    } else if (binding.reviewRequired && review && String(review.verdict) === 'fail') {
      const latest = latestAttemptOf(binding.workspace, binding.taskId)
      ensureGateFor(binding, 'fail', latest ? latest.sequence : null)
      appendMessage(
        session,
        createControllerMessage(
          'Controller: operator action required · task ' + binding.taskId + '\nReview approval required (verdict: FAIL). The Control Room shows the gate with Approve / Reject actions.',
          'controller-gate',
        ),
      )
    }
    return completion
  }

  /** Controller-owned deterministic verification (explicit /verify command). */
  async function executeVerifyTurn(agent, binding) {
    const session = agent.session
    const latest = latestAttemptOf(binding.workspace, binding.taskId)
    if (!latest || !attemptIsOpen(latest)) {
      appendMessage(
        session,
        createControllerMessage(
          'Controller: verification rejected · task ' + binding.taskId + '\nNo open attempt exists to verify. Run an engineering prompt first; verification records only real executions.',
          'controller-verify-error',
        ),
      )
      return { kind: 'reject' }
    }
    const verificationStartedAtUtc = new Date().toISOString()
    try {
      await attemptEvent(binding, 'verifying')
      const result = await invokePowerShell('Verify-Project.ps1', [
        '-Workspace', binding.workspace,
        '-InstallRoot', installRoot,
        '-TaskId', binding.taskId,
        '-Kind', 'all',
        '-ContinueOnFailure',
        '-Json',
      ], { tolerateNonZeroJson: true })
      const checks = Array.isArray(result) ? result : (result && Array.isArray(result.Results) ? result.Results : [])
      const finishedAtUtc = new Date().toISOString()
      const normalized = checks.map((check) => {
        if (!check || typeof check !== 'object') return null
        const name = String(check.Name ?? check.name ?? '')
        if (name === '') return null
        const status = String(check.Status ?? check.status ?? 'FAIL').toUpperCase()
        return {
          name,
          kind: String(check.Kind ?? check.kind ?? 'verify'),
          status,
          exitCode: Number.isFinite(Number(check.ExitCode)) ? Number(check.ExitCode) : null,
          command: String(check.Command ?? check.command ?? ''),
          startedAtUtc: String(check.StartedAtUtc ?? check.startedAtUtc ?? '') || null,
          finishedAtUtc: String(check.FinishedAtUtc ?? check.finishedAtUtc ?? '') || null,
          attempt: latest.sequence,
        }
      }).filter(Boolean)
      const failed = normalized.filter((check) => check.status === 'FAIL').length
      const skipped = normalized.filter((check) => check.status === 'SKIP').length
      const passed = normalized.length - failed - skipped
      const evidence = {
        schemaVersion: 2,
        attempt: latest.sequence,
        startedAtUtc: verificationStartedAtUtc,
        finishedAtUtc,
        acceptanceCriteria: [],
        verification: normalized,
        scopePass: true,
      }
      await writeEvidence(binding, evidence)
      if (failed > 0) {
        await recordFailure(binding, 'verification-failed', failed + ' of ' + normalized.length + ' check(s) failed during verification of attempt ' + latest.sequence)
      } else {
        await attemptEvent(binding, 'passed')
        await runCompletionTail(binding, session).catch((error) => log({ event: 'verify-completion-failed', error: String(error) }))
      }
      appendMessage(
        session,
        createControllerMessage(
          'Controller verification · task ' + binding.taskId + ' · attempt ' + latest.sequence + ' · ' + (failed > 0 ? 'FAILED' : 'PASSED') +
            ' (' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped)' +
            (failed > 0 ? '\nFailing checks: ' + normalized.filter((c) => c.status === 'FAIL').map((c) => c.name).join('; ') : '') +
            '\nEvidence: .ai-harness/runs/' + binding.taskId + '/evidence.json',
          'controller-verify-result',
        ),
      )
      return { kind: 'reject' }
    } catch (error) {
      // Infrastructure failure (launch failure, timeout/abort, or no
      // parseable structured result): the attempt must NEVER stay
      // live-looking in 'verifying'. The smallest truthful terminal state is
      // interrupted (verification-incomplete) — the same record the
      // crash-reconcile path writes for a stale verifying attempt without
      // evidence.
      const latestAfter = latestAttemptOf(binding.workspace, binding.taskId)
      if (latestAfter && latestAfter.status === 'verifying') {
        await attemptEvent(binding, 'interrupted', { reason: 'verification-incomplete' }).catch(() => null)
      }
      appendMessage(
        session,
        createControllerMessage(
          'Controller verification failed · task ' + binding.taskId + '\n' + String(error && error.message ? error.message : error) + '\nThe attempt was closed as interrupted (verification incomplete); no evidence artifact was written.',
          'controller-verify-error',
        ),
      )
      log({ event: 'verify-failed', taskId: binding.taskId, error: String(error) })
      return { kind: 'reject' }
    }
  }

  async function contextBundle(workspace, taskId, question) {
    // Progressive disclosure: the explicit review question decides how much
    // repository context is gathered. 'inline' (self-contained code in the
    // question) gathers none; 'files' (explicitly named workspace files)
    // gathers exactly those; 'bundle' falls through to the Context Engine.
    const contextMode = classifyReviewContext(workspace, question)
    if (contextMode === 'inline') return { contextMode, fileSlices: [] }
    if (contextMode === 'files') return { contextMode, fileSlices: resolveReviewFiles(workspace, question) }
    const bundle = await invokePowerShell('Context.ps1', [
      '-Operation', 'bundle',
      '-TaskId', taskId,
      '-MaxContextTokens', String(MAX_CONTEXT_TOKENS),
      '-MaxFiles', String(MAX_FILES),
    ], { payload: { workspace, query: question } })
    if (!bundle || !Array.isArray(bundle.fileSlices)) throw new Error('aih-controller: context bundle returned no file slices')
    return { contextMode, fileSlices: bundle.fileSlices }
  }

  async function runReview(workspace, taskId, question, filesSlices, contextMode, attempt) {
    fs.mkdirSync(tmpRoot, { recursive: true })
    const filesPath = path.join(tmpRoot, 'review-' + taskId + '-' + Date.now() + '.json')
    fs.writeFileSync(filesPath, JSON.stringify(filesSlices))
    const args = ['-TaskId', taskId, '-FilesPath', filesPath, '-Execute']
    if (attempt && Number.isInteger(Number(attempt))) args.push('-Attempt', String(attempt))
    return invokePowerShell('Review.ps1', args, { payload: { workspace, question, contextMode } })
  }

  function reviewSummary(review) {
    if (!review || review.ok === false) return review
    const result = review.result || {}
    const findings = Array.isArray(result.findings) ? result.findings : []
    const severities = findings.map((f) => f.severity).filter(Boolean)
    return {
      verdict: result.verdict ?? 'unknown',
      findings: findings.length,
      severities: severities.length ? severities : [],
      provider: review.provider,
      model: review.model,
      callCount: review.callCount,
      budget: review.budget,
    }
  }

  function appendMessage(session, message) {
    if (!session || typeof session.append !== 'function') return
    session.append('user/message', message, { surfaceOp: 'append' })
  }

  function noticeText(binding) {
    return [
      'Controller: task ' + binding.taskId + ' bound to this session.',
      'Execution: ' + executionClassLabel(binding.executionClass),
      'Review: ' + (binding.reviewRequired ? 'required (policy or explicit request)' : 'not required'),
      'Completion authority: deterministic controller.',
    ].join('\n')
  }

  function reviewResultText(binding, summary, raw) {
    const lines = [
      'Controller review result · task ' + binding.taskId,
      'Execution: Independent Review (read-only, bounded)',
      'Verdict: ' + summary.verdict,
      'Findings: ' + summary.findings + (summary.severities.length ? ' (' + summary.severities.join(', ') + ')' : ''),
      'Provider: ' + summary.provider + ' · model: ' + summary.model + ' · calls: ' + summary.callCount,
      'Budget: ' + (summary.budget ? summary.budget.maxFiles + ' files / ' + summary.budget.maxContextTokens + ' context tokens / ' + summary.budget.maxCallsPerTask + ' call' : 'controller-enforced'),
      'Read-only: true · fresh context: true · completion authority: controller (reviewer cannot complete the task)',
    ]
    if (raw && typeof raw === 'object') lines.push('Result JSON: ' + JSON.stringify(raw))
    return lines.join('\n')
  }

  async function executeReviewTurn(agent, binding, question, options) {
    const session = agent.session
    const workspace = binding.workspace
    const taskId = binding.taskId
    try {
      if (options.explicit) {
        const decision = await routeTask(workspace, taskId, question, {
          preset: binding.preset,
          reviewRequested: true,
        })
        binding.executionClass = decision.executionClass
        binding.reviewRequired = Boolean(decision.reviewRequired)
        await markReviewRequested(workspace, taskId)
      }
      const { contextMode, fileSlices } = await contextBundle(workspace, taskId, question)
      const latest = latestAttemptOf(workspace, taskId)
      const reviewAttempt = latest && Number.isInteger(latest.sequence) ? latest.sequence : null
      const review = await runReview(workspace, taskId, question, fileSlices, contextMode, reviewAttempt)
      if (review && review.ok === false && review.kind === 'packet-too-large') {
        appendMessage(
          session,
          createControllerMessage(
            'Controller review rejected · task ' + taskId + '\nThe reviewer was NOT called (hard budget validation failed).\nViolations: ' +
              (Array.isArray(review.violations) ? review.violations.join('; ') : 'unknown') +
              '\nRead-only: true · completion authority: controller',
            'review-packet-too-large',
          ),
        )
        log({ event: 'review-packet-too-large', taskId, contextMode, violations: review.violations })
        return { kind: 'reject' }
      }
      if (!review || review.ok !== true) {
        throw new Error('aih-controller: review service returned no result')
      }
      appendMessage(session, createControllerMessage(reviewResultText(binding, reviewSummary(review), review.result), 'review-result'))
      // TASK-0004: the review disposition drives the operator gate at the
      // producer boundary. FAIL (and completion actually blocked) → ensure a
      // waiting gate (idempotent); PASS → supersede any waiting gate.
      const verdict = review.result && String(review.result.verdict)
      if (verdict === 'fail' && binding.reviewRequired) {
        ensureGateFor(binding, 'fail', reviewAttempt)
        appendMessage(
          session,
          createControllerMessage(
            'Controller: operator action required · task ' + taskId + '\nReview verdict FAIL. The Control Room shows the gate with Approve / Reject actions.',
            'controller-gate',
          ),
        )
      } else if (verdict === 'pass') {
        supersedeGateFor(binding, 'review-passed')
      }
      log({ event: 'review-completed', taskId, contextMode, summary: reviewSummary(review) })
      return { kind: 'reject' }
    } catch (error) {
      appendMessage(
        session,
        createControllerMessage(
          'Controller review failed · task ' + taskId + '\n' + String(error.message) + '\nNo files were modified; completion authority remains with the controller.',
          'review-error',
        ),
      )
      log({ event: 'review-failed', taskId, error: String(error) })
      return { kind: 'reject' }
    }
  }

  async function bindSession(agent, session, workspace, promptText) {
    const reviewRequested = isReviewCommand(promptText)
    const task = await createTask(workspace, reviewRequested ? reviewQuestionOf(promptText) : promptText, reviewRequested)
    const decision = await routeTask(workspace, task.taskId, task.description, {
      preset: agentPresetOf(session),
      reviewRequested,
    })
    const binding = {
      sessionId: session.id,
      taskId: task.taskId,
      workspace,
      preset: agentPresetOf(session),
      description: task.description,
      executionClass: decision.executionClass,
      reviewRequired: Boolean(decision.reviewRequired),
      needsRouteCheck: false,
      boundAtUtc: new Date().toISOString(),
    }
    bindings[session.id] = binding
    persistBindings()
    registerShellEnvironment()
    appendMessage(session, createControllerMessage(noticeText(binding), 'controller-binding'))
    log({ event: 'session-bound', sessionId: session.id, taskId: task.taskId, executionClass: binding.executionClass })
    return binding
  }

  function agentPresetOf(session) {
    try {
      const header = session.header || {}
      if (header.agentPreset === 'aih-deepseek') return 'aih-deepseek'
    } catch {
      /* fall through */
    }
    return 'aih-engineering'
  }

  function bindingFor(session) {
    return bindings[session.id] || null
  }

  let environmentRegistered = false
  function registerShellEnvironment() {
    if (environmentRegistered) return
    environmentRegistered = true
    try {
      ctx.shellEnv.register({
        name: 'aih-controller-task-state',
        variables: {
          DSH_AIH_TASK_ID: { description: 'TaskController task id bound to this session.' },
          DSH_AIH_EXECUTION_CLASS: { description: 'Execution class selected by the deterministic routing policy.' },
          DSH_AIH_REVIEW_REQUIRED: { description: '1 when a bounded Codex review is required for completion.' },
        },
        resolve: (execution) => {
          const agent = execution && execution.agent
          const session = agent && agent.session
          if (!session) return {}
          const binding = bindingFor(session)
          if (!binding) return {}
          return {
            DSH_AIH_TASK_ID: binding.taskId,
            DSH_AIH_EXECUTION_CLASS: binding.executionClass,
            DSH_AIH_REVIEW_REQUIRED: binding.reviewRequired ? '1' : '0',
          }
        },
      })
    } catch (error) {
      log({ event: 'shell-env-register-failed', error: String(error) })
    }
  }

  ctx.on('session/event', (subject, event) => {
    if (!subject || !event) return
    const binding = bindings[subject.id]
    if (!binding) return
    if (event.type === 'turn/end' && event.data && event.data.reason) {
      const reason = event.data.reason
      if (reason.kind === 'error' && reason.error && reason.error.message) {
        // TASK-0004: a genuinely failed turn records the attempt failure at
        // the producer boundary (the controller owns the ledger).
        const latest = latestAttemptOf(binding.workspace, binding.taskId)
        if (latest && attemptIsOpen(latest)) {
          recordFailure(binding, 'attempt-failed', String(reason.error.message))
            .then(() => log({ event: 'attempt-failure-recorded', sessionId: subject.id, taskId: binding.taskId }))
            .catch((error) => log({ event: 'attempt-failure-record-failed', sessionId: subject.id, error: String(error) }))
        }
        binding.needsRouteCheck = true
        routeTask(binding.workspace, binding.taskId, binding.description, {
          preset: binding.preset,
          signal: 'attempt-failure',
          failureReason: String(reason.error.message),
        })
          .then((decision) => {
            binding.executionClass = decision.executionClass
            log({ event: 'failure-signal-routed', sessionId: subject.id, taskId: binding.taskId, executionClass: decision.executionClass })
          })
          .catch((error) => log({ event: 'failure-signal-failed', sessionId: subject.id, error: String(error) }))
      } else if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
        // TASK-0004: a user abort or system interrupt closes the open attempt
        // as interrupted (smallest truthful state) instead of leaving it open.
        const latest = latestAttemptOf(binding.workspace, binding.taskId)
        if (latest && attemptIsOpen(latest)) {
          attemptEvent(binding, 'interrupted', { reason: 'turn-' + reason.kind })
            .then(() => log({ event: 'attempt-interrupted-recorded', sessionId: subject.id, taskId: binding.taskId }))
            .catch((error) => log({ event: 'attempt-interrupt-record-failed', sessionId: subject.id, error: String(error) }))
        }
      }
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    let promptText = ''
    let explicitReview = false
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (!session) return next()
      if (isWorkerAgent(session.header)) return next()
      if (payload.step !== 1) return next()
      const prompts = userPromptMessages(payload.messages)
      if (prompts.length === 0) return next()
      promptText = textOf(prompts[0])
      if (!promptText) return next()
      explicitReview = isReviewCommand(promptText)
      const workspace = session.header && session.header.cwd
      if (!workspace) return next()

      registerShellEnvironment()

      let binding = bindingFor(session)
      if (!binding) {
        binding = await bindSession(agent, session, workspace, promptText)
      }

      if (explicitReview) {
        return executeReviewTurn(agent, binding, reviewQuestionOf(promptText), { explicit: true })
      }

      if (isVerifyCommand(promptText)) {
        return executeVerifyTurn(agent, binding)
      }

      // TASK-0004: crash-safe reconciliation at the producer boundary. An
      // attempt left in 'verifying' by a dead process is closed from real
      // records (evidence artifact when present, interrupted otherwise)
      // BEFORE any new attempt may open — a restart never creates Attempt N+1.
      binding._session = session
      try {
        await reconcileAttempt(binding)
      } catch (error) {
        log({ event: 'attempt-reconcile-failed', sessionId: session.id, taskId: binding.taskId, error: String(error) })
      }

      if (isReviewClass(binding.executionClass)) {
        const decision = await routeTask(binding.workspace, binding.taskId, promptText, {
          preset: binding.preset,
          signal: 'review-findings',
        })
        binding.executionClass = decision.executionClass
        appendMessage(
          session,
          createControllerMessage(
            'Controller: bounded review findings returned to the Deep Engineer for repair. Execution: ' + executionClassLabel(decision.executionClass) + '. The reviewer does not remain the parent.',
            'controller-repair',
          ),
        )
        return next()
      }

      if (binding.needsRouteCheck) {
        binding.needsRouteCheck = false
        const decision = await routeTask(binding.workspace, binding.taskId, promptText, { preset: binding.preset })
        if (isReviewClass(decision.executionClass)) {
          binding.executionClass = decision.executionClass
          appendMessage(
            session,
            createControllerMessage(
              'Controller: repeated identical failure reached the configured threshold; escalating to bounded independent review. Execution: ' + executionClassLabel('reviewer'),
              'controller-escalation',
            ),
          )
          return executeReviewTurn(agent, binding, binding.description, { explicit: false })
        }
        binding.executionClass = decision.executionClass
      }

      // Engineering turns own the attempt lifecycle: one execution = exactly
      // one attempt. Reload/reconnect/restart never adds an attempt — the
      // ledger's open-attempt guard is authoritative and the durable turn
      // identity (startedByTurn) makes the same execution idempotent.
      const latest = latestAttemptOf(binding.workspace, binding.taskId)
      if (!latest || !attemptIsOpen(latest)) {
        const nextSequence = latest ? latest.sequence + 1 : 1
        try {
          await beginAttempt(binding, payload.turn)
          appendMessage(
            session,
            createControllerMessage(
              'Controller: attempt ' + nextSequence + ' started · task ' + binding.taskId + ' (execution ' + executionClassLabel(binding.executionClass) + ').',
              'controller-attempt',
            ),
          )
        } catch (error) {
          log({ event: 'begin-attempt-failed', sessionId: session.id, taskId: binding.taskId, error: String(error) })
          appendMessage(
            session,
            createControllerMessage(
              'Controller: attempt start rejected for task ' + binding.taskId + '\n' + String(error && error.message ? error.message : error),
              'controller-error',
            ),
          )
        }
      }

      return next()
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      log({ event: 'pre-step-error', error: message })
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (explicitReview) {
        // FAIL CLOSED: an explicit /codex-review must never degrade into a
        // DeepSeek review while appearing to the user as Codex. Surface the
        // controller failure visibly and end the turn without any model call.
        if (session) {
          appendMessage(
            session,
            createControllerMessage(
              'Independent review unavailable: controller bridge failed.\n' + message + '\nNo files were modified; no model call was made; completion authority remains with the controller.',
              'controller-error',
            ),
          )
        }
        return { kind: 'reject' }
      }
      // Normal prompts: surface the failure visibly, then continue the session
      // rather than silently dropping controller state.
      if (session && promptText) {
        appendMessage(
          session,
          createControllerMessage(
            'Controller: task binding failed for this session.\n' + message + '\nThe session continues without controller routing; controller state was not recorded.',
            'controller-error',
          ),
        )
      }
      return next()
    }
  })

  ctx.on('agent/disposed', (agent) => {
    const session = agent && agent.session
    if (session && bindings[session.id]) {
      delete bindings[session.id]
      persistBindings()
    }
  })
}

function loadBindings(bindingsPath) {
  try {
    if (!fs.existsSync(bindingsPath)) return {}
    const document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'))
    if (document && document.schemaVersion === 1 && document.bindings && typeof document.bindings === 'object') {
      return document.bindings
    }
  } catch {
    /* corrupt bindings file: start fresh; task ledger remains the source of truth */
  }
  return {}
}

module.exports = { name: 'aih-controller', inject: ['shellEnv'], apply }
module.exports.isReviewCommand = isReviewCommand
module.exports.reviewQuestionOf = reviewQuestionOf
module.exports.textOf = textOf
module.exports.isUserPrompt = isUserPrompt
module.exports.userPromptMessages = userPromptMessages
module.exports.executionClassLabel = executionClassLabel
module.exports.canonicalExecutionClass = canonicalExecutionClass
module.exports.isReviewClass = isReviewClass
module.exports.isWorkerAgent = isWorkerAgent
module.exports.createControllerMessage = createControllerMessage
module.exports.parseCliJson = parseCliJson
module.exports.structuredCliStdout = structuredCliStdout
module.exports.verificationCliStdout = verificationCliStdout
module.exports.referencedFilesOf = referencedFilesOf
module.exports.hasInlineCode = hasInlineCode
module.exports.resolveReviewFiles = resolveReviewFiles
module.exports.classifyReviewContext = classifyReviewContext
