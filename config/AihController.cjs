'use strict'

/**
 * aih-controller — the GUI -> deterministic-controller bridge for AI Harness.
 *
 * The vNext controller (TaskController.ps1 / Routing.ps1 / CodexReview.ps1)
 * lives on the PowerShell plane and is invoked by the CLI (aih-task,
 * aih-route, aih-context, aih-review). Previously the Web GUI message path
 * went straight from the chat to the root DeepSeek model with no task state,
 * no routing decision, and no way for an explicit user review request to
 * reach the independent review service.
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
 *    TaskController -> execution class reviewer -> review packet (budget
 *    enforcement is POLICY-DRIVEN via codex.automaticReview.enforceLimits,
 *    disabled by default) -> ONE fresh read-only independent review ->
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
 * controller bridge, always through New-AihReviewPacket policy-driven
 * enforcement (TASK-0007: unlimited review context unless the policy opts
 * back into the legacy hard budgets with enforceLimits=true).
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
// TASK-0007: these are NOT the review budget anymore. They are the LEGACY
// hard-budget fallbacks, used ONLY when the routing policy cannot be read or
// opts back into enforcement with codex.automaticReview.enforceLimits=true.
// The shipped Nexus policy sets enforceLimits=false: the controller bridge
// must not impose a file count or a context-token ceiling on its own.
const LEGACY_MAX_FILES = 8
const LEGACY_MAX_CONTEXT_TOKENS = 30000
const CLI_TIMEOUT_MS = 320000

// ── review budget policy (TASK-0007) ────────────────────────────────────────
//
// codex.automaticReview.enforceLimits decides whether the LEGACY hard budgets
// (file count / diff lines / context tokens / calls per task / output tokens)
// apply to the independent review. The shipped default is FALSE: unlimited
// review context, with only the provider/model context window as a real
// capacity boundary (surfaced as a provider-capacity error by the review
// transport). A missing flag or an unreadable policy fails SAFE to the
// legacy enforced behavior.
const REVIEW_BUDGET_POLICY_CACHE = new Map()

function reviewBudgetPolicy(installRoot) {
  // Direct helper calls (including checkout-local diagnostics/tests) resolve
  // from configured runtime state first, then from this checked-out module.
  // The live plugin path always supplies apply()'s validated installRoot.
  const root = installRoot
    ? path.resolve(String(installRoot))
    : process.env.AIH_INSTALL_ROOT
      ? path.resolve(process.env.AIH_INSTALL_ROOT)
      : process.env.DSH_HOME
        ? path.dirname(path.resolve(process.env.DSH_HOME))
        : path.resolve(__dirname, '..')
  const policyPath = path.join(root, 'config', 'routing-policy.json')
  const fallback = { enforceLimits: true, maxFiles: LEGACY_MAX_FILES, maxContextTokens: LEGACY_MAX_CONTEXT_TOKENS, source: 'fallback' }
  let mtimeMs = null
  try { mtimeMs = fs.statSync(policyPath).mtimeMs } catch { return fallback }
  const cached = REVIEW_BUDGET_POLICY_CACHE.get(policyPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.value
  let value = fallback
  try {
    const document = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
    const review = document && document.codex && document.codex.automaticReview
    if (review && typeof review === 'object') {
      value = {
        enforceLimits: review.enforceLimits === undefined ? true : Boolean(review.enforceLimits),
        maxFiles: Number.isFinite(Number(review.maxFiles)) ? Number(review.maxFiles) : LEGACY_MAX_FILES,
        maxContextTokens: Number.isFinite(Number(review.maxContextTokens)) ? Number(review.maxContextTokens) : LEGACY_MAX_CONTEXT_TOKENS,
        source: 'policy',
      }
    }
  } catch { value = fallback }
  REVIEW_BUDGET_POLICY_CACHE.set(policyPath, { mtimeMs, value })
  return value
}

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

// TASK-0007: maxFiles is the policy-derived cap (LEGACY_MAX_FILES only when
// the policy enforces limits); null or 0 means UNLIMITED.
function referencedFilesOf(question, maxFiles = LEGACY_MAX_FILES) {
  if (typeof question !== 'string') return []
  const tokens = []
  const seen = new Set()
  for (const raw of question.match(REVIEW_FILE_TOKEN_RE) || []) {
    const token = raw.replace(/^[`"'']+|[`"'']+$/g, '').replace(/\\/g, '/')
    if (seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
    if (maxFiles !== null && maxFiles > 0 && tokens.length >= maxFiles) break
  }
  return tokens
}

function hasInlineCode(question) {
  return typeof question === 'string' && REVIEW_INLINE_CODE_RES.some((re) => re.test(question))
}

function resolveReviewFiles(workspace, question, maxFiles = LEGACY_MAX_FILES) {
  const root = path.resolve(String(workspace || ''))
  const slices = []
  for (const token of referencedFilesOf(question, maxFiles)) {
    if (maxFiles !== null && maxFiles > 0 && slices.length >= maxFiles) break
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

function classifyReviewContext(workspace, question, maxFiles = LEGACY_MAX_FILES) {
  if (referencedFilesOf(question, maxFiles).length > 0) {
    return resolveReviewFiles(workspace, question, maxFiles).length > 0 ? 'files' : 'bundle'
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
// TASK-0007: the review class is "Independent Review (read-only)" — it is
// called "bounded" ONLY when the policy enforces the legacy hard budgets
// (enforceLimits=true), which is not the shipped default.
const EXECUTION_CLASS_LABELS = {
  deterministic: 'Deterministic',
  engineer_normal: 'Engineer \u00b7 Normal',
  engineer_deep: 'Engineer \u00b7 Deep',
  reviewer: 'Independent Review (read-only)',
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
 * TASK-0007: review result notice. With budget enforcement disabled the
 * Control Room must NOT report the obsolete budget numbers ("8 files /
 * 30000 context tokens / 1 call"); it reports the enforcement state instead:
 * "Budget enforcement: disabled" next to the unchanged read-only/fresh facts.
 */
function reviewResultText(binding, summary, raw) {
  const budget = summary && summary.budget ? summary.budget : null
  const enforced = Boolean(budget && budget.enforceLimits)
  const budgetLine = enforced && budget
    ? 'Budget enforcement: enabled (' + budget.maxFiles + ' files / ' + budget.maxContextTokens + ' context tokens / ' + budget.maxCallsPerTask + ' call)'
    : 'Budget enforcement: disabled'
  const lines = [
    'Controller review result · task ' + binding.taskId,
    'Execution: Independent Review (read-only)',
    'Verdict: ' + summary.verdict,
    'Findings: ' + summary.findings + (summary.severities.length ? ' (' + summary.severities.join(', ') + ')' : ''),
    'Provider: ' + summary.provider + ' · model: ' + summary.model + ' · calls: ' + summary.callCount,
    budgetLine,
    'Read-only: true · fresh context: true · completion authority: controller (reviewer cannot complete the task)',
  ]
  if (raw && typeof raw === 'object') lines.push('Result JSON: ' + JSON.stringify(raw))
  return lines.join('\n')
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

// ── TASK-0005: task identity / session binding validation ───────────────────
//
// Core invariants implemented here:
//   > TaskController state is authoritative. Session bindings are references
//     only.
//   > TASK DISPLAY IDENTITY != TASK LIFECYCLE IDENTITY.
//   > Once a task has an immutable lifecycle identity, no controller operation
//     may silently target another task merely because it shares TASK-NNNN.
//
//   taskId          'TASK-NNNN' — human-facing label (UI, logs, local
//                   sequencing). NEVER sufficient for durable identity.
//   taskInstanceId  'task_<32 hex>' — immutable lifecycle identity of exactly
//                   one task generation (routing identity, session binding
//                   identity, attempts, review identity, completion identity,
//                   operator gates, telemetry, cross-record joins). Generated
//                   once by TaskController; never reused.

/**
 * Normalize a workspace path for IDENTITY COMPARISON ONLY (never for display
 * or filesystem access). Mirrors status.cjs normalizeWorkspacePath:
 *   - forward slashes become backslashes; separators collapse
 *   - trailing separators are trimmed (a drive root like C:\ stays)
 *   - comparison is case-insensitive (Windows path semantics)
 * Equivalent forms compare equal (C:\Repo == c:\repo\) while
 * prefix-related paths never do (C:\Repo != C:\Repo2). Repository-relative
 * source path case semantics are untouched — this is workspace identity only.
 */
function normalizeWorkspaceIdentity(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return ''
  let normalized = workspace.replace(/[\\/]+/g, '\\')
  while (normalized.length > 3 && normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized.toLowerCase()
}

/**
 * Compare the workspace recorded in a binding with the CURRENT session
 * workspace. Returns 'workspace-mismatch' when they differ, null otherwise.
 * A missing workspace on either side never compares equal (fail-closed).
 */
function classifyBindingWorkspace(binding, workspace) {
  const bindingWorkspace = binding && typeof binding.workspace === 'string' ? binding.workspace : ''
  const normalizedBinding = normalizeWorkspaceIdentity(bindingWorkspace)
  const normalizedCurrent = normalizeWorkspaceIdentity(workspace)
  if (normalizedBinding === '' || normalizedCurrent === '') return 'workspace-mismatch'
  return normalizedBinding === normalizedCurrent ? null : 'workspace-mismatch'
}

/**
 * Classify a persisted binding against an authoritative TaskController
 * identity result (Task.ps1 -Action test-task). PURE and deterministic:
 *
 *   binding has taskInstanceId + exact instance exists  -> { verdict: 'valid' }
 *   task missing from the ledger                        -> stale 'task-missing'
 *   task exists under a DIFFERENT taskInstanceId        -> stale 'instance-mismatch'
 *   binding has NO taskInstanceId (legacy)              -> stale 'ambiguous-legacy-binding'
 *                                                          (its lifecycle generation
//                                                           cannot be proven, so it
//                                                           must never silently
//                                                           attach to a new
//                                                           generation)
 *
 * An unusable identity result (CLI failure, malformed output, missing ledger,
 * timeout — anything the TaskController could not answer authoritatively)
 * THROWS with code 'binding-validation-inconclusive': the caller must then
 * PRESERVE the binding, create NO replacement task and classify NOTHING as
 * missing. 'exists=false' is trusted only because the TaskController contract
 * guarantees it means 'ledger successfully read, task absent'.
 */
function classifyBindingIdentity(binding, identity) {
  if (!binding || typeof binding !== 'object') {
    const error = new Error('binding identity classification requires a binding')
    error.code = 'binding-validation-inconclusive'
    throw error
  }
  if (!identity || typeof identity !== 'object' || typeof identity.exists !== 'boolean') {
    const error = new Error('task identity could not be validated: the TaskController returned no authoritative answer (validation infrastructure failure)')
    error.code = 'binding-validation-inconclusive'
    throw error
  }
  const bindingInstance = typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : ''
  if (bindingInstance === '') {
    return { verdict: 'stale', reason: 'ambiguous-legacy-binding' }
  }
  if (!identity.exists) {
    return { verdict: 'stale', reason: 'task-missing' }
  }
  if (identity.instanceMatches !== true) {
    return { verdict: 'stale', reason: 'instance-mismatch' }
  }
  return { verdict: 'valid' }
}

/**
 * Session-scoped binding validation/recovery lock (Part 13). One stale
 * session + two simultaneous controller events = ONE replacement task: the
 * second event waits for the first recovery to settle and then re-validates
 * against the fresh binding. The lock is PER SESSION — different sessions
 * never block each other.
 */
function createBindingGuard(deps) {
  const locks = new Map()
  async function withSessionBindingLock(sessionId, operation) {
    const key = String(sessionId || '')
    const previous = locks.get(key) || Promise.resolve()
    const run = previous.then(() => operation())
    const tail = run.then(() => null, () => null)
    locks.set(key, tail)
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  async function recoverStaleBinding(agent, session, workspace, promptText, stale, reason) {
    // Part 10: structured detection event with the full identity context,
    // removal from memory, persisted removal, then a FRESH authoritative task
    // through the normal binding flow. The stale binding is never pointed at
    // another task that merely shares its taskId, and no task is ever
    // reconstructed from binding contents.
    deps.log({
      event: 'stale-binding-detected',
      sessionId: session && session.id ? session.id : null,
      taskId: stale.taskId,
      oldTaskInstanceId: stale.taskInstanceId ?? null,
      oldWorkspace: stale.workspace ?? null,
      currentWorkspace: workspace,
      reason,
    })
    deps.invalidateBinding(stale)
    const created = await deps.createBinding(agent, session, workspace, promptText)
    return { binding: created, outcome: 'recovered', stale: { taskId: stale.taskId, reason } }
  }

  /**
   * Validate (and if deterministically proven stale, recover) the session
   * binding under the session-scoped lock. Returns
   *   { binding, outcome: 'valid' | 'bound' | 'recovered', stale? }
   * and THROWS with code 'binding-validation-inconclusive' when validation
   * infrastructure fails (binding preserved, nothing created — Part 12).
   */
  async function ensureBinding(agent, session, workspace, promptText) {
    return withSessionBindingLock(session.id, async () => {
      const binding = deps.bindingFor(session)
      if (!binding) {
        const created = await deps.createBinding(agent, session, workspace, promptText)
        return { binding: created, outcome: 'bound' }
      }
      const workspaceReason = classifyBindingWorkspace(binding, workspace)
      if (workspaceReason) {
        return recoverStaleBinding(agent, session, workspace, promptText, binding, workspaceReason)
      }
      // Part 21: a legacy binding WITHOUT taskInstanceId can never prove its
      // lifecycle generation, so it must not silently attach to (possibly
      // different) current controller state. It is stale/ambiguous by
      // definition and is safely rebound through the normal flow.
      const bindingInstance = typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : ''
      if (bindingInstance === '') {
        return recoverStaleBinding(agent, session, workspace, promptText, binding, 'ambiguous-legacy-binding')
      }
      // Part 5/8: the authoritative identity test. A TaskController failure
      // here THROWS (inconclusive) — it must never become 'task missing'.
      let identity
      try {
        identity = await deps.testTaskIdentity(workspace, binding.taskId, binding.taskInstanceId)
      } catch (error) {
        if (error && error.code === 'binding-validation-inconclusive') throw error
        // Centralized Part 12 semantics: any validation-infrastructure
        // failure (CLI launch failure, timeout, corrupt ledger, malformed
        // JSON) is INCONCLUSIVE. The caller must preserve the binding, create
        // no replacement task, and classify nothing as missing.
        const wrapped = new Error('task identity could not be validated: ' + String(error && error.message ? error.message : error))
        wrapped.code = 'binding-validation-inconclusive'
        wrapped.cause = error
        throw wrapped
      }
      const verdict = classifyBindingIdentity(binding, identity)
      if (verdict.verdict === 'stale') {
        return recoverStaleBinding(agent, session, workspace, promptText, binding, verdict.reason)
      }
      return { binding, outcome: 'valid' }
    })
  }

  return { ensureBinding, withSessionBindingLock, locks }
}

// ── plugin ──────────────────────────────────────────────────────────────────

function resolveInstallRoot() {
  if (process.env.AIH_INSTALL_ROOT) return path.resolve(process.env.AIH_INSTALL_ROOT)
  if (process.env.DSH_HOME) return path.dirname(path.resolve(process.env.DSH_HOME))
  throw new Error('Nexus install root is unavailable; launch through the repo-local aih entrypoint.')
}

function apply(ctx) {
  const installRoot = resolveInstallRoot()
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
          // TASK-0005 Part 7: the binding is an identity REFERENCE into
          // TaskController state. taskInstanceId is the lifecycle identity it
          // is bound to (immutable, never reused); taskId remains display.
          taskInstanceId: binding.taskInstanceId ?? null,
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
    // TASK-0005 Part 16: route requests carry the lifecycle instance; Route.ps1
    // re-validates it against the authoritative ledger (fail closed).
    if (options.taskInstanceId) payload.taskInstanceId = options.taskInstanceId
    const args = ['-TaskId', taskId, '-Preset', options.preset ?? 'aih-engineering', '-InstallRoot', installRoot]
    const decision = await invokePowerShell('Route.ps1', args, { payload })
    if (!decision || !decision.executionClass) throw new Error('aih-controller: routing returned no execution class')
    return decision
  }

  async function markReviewRequested(workspace, taskId, taskInstanceId) {
    const args = ['-Action', 'set-review-requested', '-TaskId', taskId]
    if (taskInstanceId) args.push('-TaskInstanceId', taskInstanceId)
    await invokePowerShell('Task.ps1', args, {
      payload: { workspace },
    })
  }

  /**
   * TASK-0005 Part 5: authoritative task identity lookup through the
   * TaskController CLI (Task.ps1 -Action test-task). Returns the identity
   * contract { exists, taskId, taskInstanceId, instanceMatches } where
   * exists=false means ONLY 'ledger successfully read and task absent'.
   * Any validation-infrastructure failure (launch failure, timeout, corrupt
   * ledger, malformed JSON, non-zero exit) THROWS here — it must never be
   * misread as a missing task (Part 12).
   */
  async function testTaskIdentity(workspace, taskId, taskInstanceId) {
    const args = ['-Action', 'test-task', '-TaskId', taskId]
    if (taskInstanceId) args.push('-TaskInstanceId', taskInstanceId)
    const identity = await invokePowerShell('Task.ps1', args, { payload: { workspace } })
    if (!identity || typeof identity !== 'object' || typeof identity.exists !== 'boolean') {
      const error = new Error('aih-controller: test-task returned no authoritative identity result')
      error.code = 'binding-validation-inconclusive'
      throw error
    }
    return identity
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

  // ── TASK-0005: session binding validation / recovery guard ────────────────
  // Part 13: ONE session-scoped in-flight validation/recovery per session id.
  // Two overlapping controller events for the same stale session therefore
  // create exactly ONE replacement task; different sessions never block each
  // other (no global lock).
  const bindingGuard = createBindingGuard({
    bindingFor: (session) => bindingFor(session),
    createBinding: (agent, session, workspace, promptText) => bindSession(agent, session, workspace, promptText),
    testTaskIdentity,
    log,
    invalidateBinding: (stale) => {
      const key = stale && stale.sessionId ? stale.sessionId : null
      if (key && bindings[key]) {
        delete bindings[key]
        persistBindings()
      }
    },
  })

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

  // TASK-0005 Part 6: every task-scoped mutation carries the lifecycle
  // instance when the binding has one; TaskController fails closed on a
  // generation mismatch. Centralized at the bridge boundary by always passing
  // binding.taskInstanceId through the payload.
  function instancePayloadOf(binding) {
    return binding && binding.taskInstanceId ? { taskInstanceId: binding.taskInstanceId } : {}
  }

  async function beginAttempt(binding, turn) {
    return invokePowerShell('Task.ps1', ['-Action', 'begin-attempt', '-TaskId', binding.taskId, '-ExecutionClass', binding.executionClass || 'engineer_normal'], {
      payload: {
        workspace: binding.workspace,
        sessionId: binding.sessionId,
        startedByTurn: String(turn ?? ''),
        requireNoOpenAttempt: true,
        ...instancePayloadOf(binding),
      },
    })
  }

  async function attemptEvent(binding, status, extra) {
    const payload = { workspace: binding.workspace, taskId: binding.taskId, status, ...instancePayloadOf(binding) }
    if (extra && extra.reason) payload.reason = extra.reason
    if (extra && extra.failureSignature) payload.failureSignature = extra.failureSignature
    if (extra && extra.evidence) payload.evidence = extra.evidence
    return invokePowerShell('Task.ps1', ['-Action', 'attempt-event', '-TaskId', binding.taskId], { payload })
  }

  async function recordFailure(binding, signature, evidence) {
    return invokePowerShell('Task.ps1', ['-Action', 'failure', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, failureSignature: signature, evidence: evidence || '', ...instancePayloadOf(binding) },
    })
  }

  async function writeEvidence(binding, evidenceDoc) {
    return invokePowerShell('Task.ps1', ['-Action', 'evidence', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, evidenceDoc, ...instancePayloadOf(binding) },
    })
  }

  async function completionCheck(binding, codexReviewPassed) {
    const args = ['-Action', 'complete', '-TaskId', binding.taskId]
    if (codexReviewPassed) args.push('-CodexReviewPassed')
    return invokePowerShell('Task.ps1', args, { payload: { workspace: binding.workspace, ...instancePayloadOf(binding) } })
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
          'Controller: task ' + binding.taskId + ' COMPLETE.\nCompletion authority: deterministic controller. Verification passed' + (reviewPass ? '; independent review passed.' : '.'),
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
        // TASK-0005 Part 19: the verification artifact names the lifecycle
        // instance it evidences.
        taskInstanceId: binding.taskInstanceId || null,
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
    // TASK-0007: the routing policy decides the review budget. With
    // enforcement disabled (shipped default) the controller imposes NO file
    // count and NO context-token ceiling: it passes the explicit unlimited
    // semantic (0 = unlimited) to the Context Engine. Retrieval still ranks
    // and selects relevant files; unlimited never means a blind full-repo
    // dump, and full-repository consent stays a separate authorization gate.
    const budget = reviewBudgetPolicy(installRoot)
    // Progressive disclosure: the explicit review question decides how much
    // repository context is gathered. 'inline' (self-contained code in the
    // question) gathers none; 'files' (explicitly named workspace files)
    // gathers exactly those; 'bundle' falls through to the Context Engine.
    const maxFiles = budget.enforceLimits ? budget.maxFiles : null
    const contextMode = classifyReviewContext(workspace, question, maxFiles)
    if (contextMode === 'inline') return { contextMode, fileSlices: [] }
    if (contextMode === 'files') return { contextMode, fileSlices: resolveReviewFiles(workspace, question, maxFiles) }
    const bundleArgs = ['-Operation', 'bundle', '-TaskId', taskId]
    if (budget.enforceLimits) {
      bundleArgs.push('-MaxContextTokens', String(budget.maxContextTokens), '-MaxFiles', String(budget.maxFiles))
    } else {
      bundleArgs.push('-MaxContextTokens', '0', '-MaxFiles', '0')
    }
    const bundle = await invokePowerShell('Context.ps1', bundleArgs, { payload: { workspace, query: question } })
    if (!bundle || !Array.isArray(bundle.fileSlices)) throw new Error('aih-controller: context bundle returned no file slices')
    return { contextMode, fileSlices: bundle.fileSlices }
  }

  async function runReview(workspace, taskId, question, filesSlices, contextMode, attempt, taskInstanceId) {
    fs.mkdirSync(tmpRoot, { recursive: true })
    const filesPath = path.join(tmpRoot, 'review-' + taskId + '-' + Date.now() + '.json')
    fs.writeFileSync(filesPath, JSON.stringify(filesSlices))
    const args = ['-TaskId', taskId, '-FilesPath', filesPath, '-Execute', '-InstallRoot', installRoot]
    if (attempt && Number.isInteger(Number(attempt))) args.push('-Attempt', String(attempt))
    // TASK-0005: the review is identity-scoped to exactly this lifecycle instance.
    if (taskInstanceId) args.push('-TaskInstanceId', taskInstanceId)
    return invokePowerShell('Review.ps1', args, { payload: { workspace, question, contextMode, taskInstanceId: taskInstanceId || undefined } })
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
      binding.taskInstanceId ? 'Task instance: ' + binding.taskInstanceId : null,
      'Execution: ' + executionClassLabel(binding.executionClass),
      'Review: ' + (binding.reviewRequired ? 'required (policy or explicit request)' : 'not required'),
      'Completion authority: deterministic controller.',
    ].filter(Boolean).join('\n')
  }

  async function executeReviewTurn(agent, binding, question, options) {
    const session = agent.session
    const workspace = binding.workspace
    const taskId = binding.taskId
    const taskInstanceId = binding.taskInstanceId || null
    try {
      if (options.explicit) {
        const decision = await routeTask(workspace, taskId, question, {
          preset: binding.preset,
          reviewRequested: true,
          taskInstanceId,
        })
        binding.executionClass = decision.executionClass
        binding.reviewRequired = Boolean(decision.reviewRequired)
        await markReviewRequested(workspace, taskId, taskInstanceId)
      }
      const { contextMode, fileSlices } = await contextBundle(workspace, taskId, question)
      const latest = latestAttemptOf(workspace, taskId)
      const reviewAttempt = latest && Number.isInteger(latest.sequence) ? latest.sequence : null
      const review = await runReview(workspace, taskId, question, fileSlices, contextMode, reviewAttempt, taskInstanceId)
      if (review && review.ok === false && review.kind === 'packet-too-large') {
        appendMessage(
          session,
          createControllerMessage(
            'Controller review rejected · task ' + taskId + '\nThe reviewer was NOT called (the review packet was rejected by policy).\nViolations: ' +
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
    // TASK-0005 Part 1: every newly created task carries an immutable
    // taskInstanceId from the TaskController; the binding references it.
    const taskInstanceId = task.taskInstanceId ?? null
    const decision = await routeTask(workspace, task.taskId, task.description, {
      preset: agentPresetOf(session),
      reviewRequested,
      taskInstanceId,
    })
    const binding = {
      sessionId: session.id,
      taskInstanceId,
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
    log({ event: 'session-bound', sessionId: session.id, taskId: task.taskId, taskInstanceId, executionClass: binding.executionClass })
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
          DSH_AIH_TASK_INSTANCE_ID: { description: 'Immutable lifecycle instance identity of the bound task (task_<32hex>).' },
          DSH_AIH_EXECUTION_CLASS: { description: 'Execution class selected by the deterministic routing policy.' },
          DSH_AIH_REVIEW_REQUIRED: { description: '1 when an independent review is required for completion.' },
        },
        resolve: (execution) => {
          const agent = execution && execution.agent
          const session = agent && agent.session
          if (!session) return {}
          const binding = bindingFor(session)
          if (!binding) return {}
          return {
            DSH_AIH_TASK_ID: binding.taskId,
            DSH_AIH_TASK_INSTANCE_ID: binding.taskInstanceId || undefined,
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
          taskInstanceId: binding.taskInstanceId || undefined,
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

      // ── TASK-0005: binding validation before ANY reuse ──────────────────
      // TaskController state is authoritative; a persisted binding is a
      // reference only. Validation/recovery runs under the session-scoped
      // lock (exactly one replacement task per stale session), and a
      // validation-infrastructure failure fails SAFE (binding preserved, no
      // replacement task, nothing classified as missing).
      let ensured
      try {
        ensured = await bindingGuard.ensureBinding(agent, session, workspace, promptText)
      } catch (error) {
        if (error && error.code === 'binding-validation-inconclusive') {
          const reason = String(error && error.message ? error.message : error)
          log({ event: 'binding-validation-inconclusive', sessionId: session.id, error: reason })
          if (explicitReview) {
            // Part 12: explicit /review keeps its fail-closed behavior —
            // no engineer fallback, no fake review result, no model call.
            appendMessage(
              session,
              createControllerMessage(
                'Independent review unavailable: the controller could not validate the session binding against the authoritative task ledger (validation infrastructure failure).\n' + reason + '\nThe existing binding was preserved; no task was created or removed; no model call was made; completion authority remains with the controller.',
                'controller-error',
              ),
            )
            return { kind: 'reject' }
          }
          if (isVerifyCommand(promptText)) {
            appendMessage(
              session,
              createControllerMessage(
                'Controller verification unavailable: the session binding could not be validated against the authoritative task ledger.\n' + reason + '\nThe existing binding was preserved; no task was created or removed; no verification ran.',
                'controller-verify-error',
              ),
            )
            return { kind: 'reject' }
          }
          appendMessage(
            session,
            createControllerMessage(
              'Controller: the session binding could not be validated (validation infrastructure failure).\n' + reason + '\nThe existing binding was preserved; no task was created or removed; controller state was not recorded for this turn.',
              'controller-error',
            ),
          )
          return next()
        }
        throw error
      }
      let binding = ensured.binding
      if (ensured.outcome === 'recovered') {
        // Part 10: the stale binding self-healed into a FRESH authoritative
        // task; nothing from the old generation is carried over.
        appendMessage(
          session,
          createControllerMessage(
            'Controller: the previous session binding was stale (' + ensured.stale.reason + ' · task ' + ensured.stale.taskId + ').\nA fresh authoritative task was created and bound: ' + binding.taskId + (binding.taskInstanceId ? ' (instance ' + binding.taskInstanceId + ')' : '') + '.\nNo record from the previous task generation was carried over.',
            'controller-recovery',
          ),
        )
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
          taskInstanceId: binding.taskInstanceId || undefined,
        })
        binding.executionClass = decision.executionClass
        appendMessage(
          session,
          createControllerMessage(
            'Controller: independent review findings returned to the Deep Engineer for repair. Execution: ' + executionClassLabel(decision.executionClass) + '. The reviewer does not remain the parent.',
            'controller-repair',
          ),
        )
        return next()
      }

      if (binding.needsRouteCheck) {
        binding.needsRouteCheck = false
        const decision = await routeTask(binding.workspace, binding.taskId, promptText, { preset: binding.preset, taskInstanceId: binding.taskInstanceId || undefined })
        if (isReviewClass(decision.executionClass)) {
          binding.executionClass = decision.executionClass
          appendMessage(
            session,
            createControllerMessage(
              'Controller: repeated identical failure reached the configured threshold; escalating to independent review. Execution: ' + executionClassLabel('reviewer'),
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
module.exports.normalizeWorkspaceIdentity = normalizeWorkspaceIdentity
module.exports.classifyBindingWorkspace = classifyBindingWorkspace
module.exports.classifyBindingIdentity = classifyBindingIdentity
module.exports.createBindingGuard = createBindingGuard
module.exports.structuredCliStdout = structuredCliStdout
module.exports.verificationCliStdout = verificationCliStdout
module.exports.referencedFilesOf = referencedFilesOf
module.exports.hasInlineCode = hasInlineCode
module.exports.resolveReviewFiles = resolveReviewFiles
module.exports.classifyReviewContext = classifyReviewContext
module.exports.reviewBudgetPolicy = reviewBudgetPolicy
module.exports.reviewResultText = reviewResultText
