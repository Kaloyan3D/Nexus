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
 *    execution path (NORMAL ENGINEERING vs CODEX REVIEW);
 *  - implements the explicit /codex-review command: TaskController ->
 *    executionClass codex_review -> bounded Review Packet -> hard budget
 *    validation -> ONE fresh read-only Codex review -> ReviewResult ->
 *    telemetry. No DeepSeek audit runs first; the turn is rejected so the
 *    review is controller-owned (0 DeepSeek calls);
 *  - feeds deterministic failure signals (turn errors) into the routing
 *    state, so the same normalized-failure escalation to codex_review works
 *    from GUI sessions;
 *  - returns review findings to DeepSeek repair (review-findings signal).
 *
 * Codex is never exposed to the model as a tool: the preset keeps
 * tool-subagent-codex disabled and the review service is invoked only by this
 * controller bridge, always through New-AihReviewPacket budget enforcement.
 */

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const REVIEW_COMMAND = /^\s*\/codex-review\b/i
const MAX_FILES = 8
const MAX_CONTEXT_TOKENS = 30000
const CLI_TIMEOUT_MS = 320000

// ── pure helpers (exported for deterministic tests) ─────────────────────────

function isReviewCommand(text) {
  return typeof text === 'string' && REVIEW_COMMAND.test(text)
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

function reviewQuestionOf(text) {
  if (typeof text !== 'string') return ''
  const match = text.match(/^\s*\/codex-review\b[\s:]*(.*)$/is)
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

function executionClassLabel(executionClass) {
  switch (executionClass) {
    case 'codex_review':
      return 'Codex Review (read-only, bounded)'
    case 'deepseek_deep':
      return 'DeepSeek Deep'
    case 'deterministic':
      return 'Deterministic'
    case 'codex_solve':
      return 'Codex Solve (writable, approval-gated)'
    default:
      return 'DeepSeek Normal'
  }
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
      const temporary = bindingsPath + '.' + crypto.randomUUID() + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, bindings }, null, 2))
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

  async function runReview(workspace, taskId, question, filesSlices, contextMode) {
    fs.mkdirSync(tmpRoot, { recursive: true })
    const filesPath = path.join(tmpRoot, 'review-' + taskId + '-' + Date.now() + '.json')
    fs.writeFileSync(filesPath, JSON.stringify(filesSlices))
    return invokePowerShell('Review.ps1', [
      '-TaskId', taskId,
      '-FilesPath', filesPath,
      '-Execute',
    ], { payload: { workspace, question, contextMode } })
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
      'Execution: Codex Review (read-only, bounded)',
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
      const review = await runReview(workspace, taskId, question, fileSlices, contextMode)
      if (review && review.ok === false && review.kind === 'packet-too-large') {
        appendMessage(
          session,
          createControllerMessage(
            'Controller review rejected · task ' + taskId + '\nCodex was NOT called (hard budget validation failed).\nViolations: ' +
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

      if (binding.executionClass === 'codex_review') {
        const decision = await routeTask(binding.workspace, binding.taskId, promptText, {
          preset: binding.preset,
          signal: 'review-findings',
        })
        binding.executionClass = decision.executionClass
        appendMessage(
          session,
          createControllerMessage(
            'Controller: bounded review findings returned to DeepSeek for repair. Execution: ' + executionClassLabel(decision.executionClass) + '. Codex does not remain the parent.',
            'controller-repair',
          ),
        )
        return next()
      }

      if (binding.needsRouteCheck) {
        binding.needsRouteCheck = false
        const decision = await routeTask(binding.workspace, binding.taskId, promptText, { preset: binding.preset })
        if (decision.executionClass === 'codex_review') {
          binding.executionClass = decision.executionClass
          appendMessage(
            session,
            createControllerMessage(
              'Controller: repeated identical failure reached the configured threshold; escalating to bounded Codex review. Execution: ' + executionClassLabel('codex_review'),
              'controller-escalation',
            ),
          )
          return executeReviewTurn(agent, binding, binding.description, { explicit: false })
        }
        binding.executionClass = decision.executionClass
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
              'Codex review unavailable: controller bridge failed.\n' + message + '\nNo files were modified; no model call was made; completion authority remains with the controller.',
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
module.exports.isWorkerAgent = isWorkerAgent
module.exports.createControllerMessage = createControllerMessage
module.exports.parseCliJson = parseCliJson
module.exports.structuredCliStdout = structuredCliStdout
module.exports.referencedFilesOf = referencedFilesOf
module.exports.hasInlineCode = hasInlineCode
module.exports.resolveReviewFiles = resolveReviewFiles
module.exports.classifyReviewContext = classifyReviewContext
