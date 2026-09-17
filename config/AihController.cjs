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

const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const contextCompaction = require('./ContextCompaction.cjs')

const REVIEW_COMMAND = /^\s*\/(?:codex-)?review\b/i
const VERIFY_COMMAND = /^\s*\/verify\b/i
// Phase V0/V1: /visual-review is an ORTHOGONAL controller-owned command (the
// read-only visual reviewer capability). It is NOT an execution class, never
// changes routing semantics, and never hands the visual model a tool.
const VISUAL_REVIEW_COMMAND = /^\s*\/visual-review\b/i
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

function isVisualReviewCommand(text) {
  return typeof text === 'string' && VISUAL_REVIEW_COMMAND.test(text)
}

// Image path-shaped tokens inside a /visual-review prompt. Extensions cover
// the evidence the V1 packet budget accepts (screenshots + references).
const VISUAL_IMAGE_TOKEN_RE = /[^\s'"`]+\.(?:png|jpe?g|webp|gif)(?![\w.])/gi

/**
 * Deterministic /visual-review request decomposition: path-shaped tokens that
 * resolve to files become screenshot evidence (missing paths are KEPT so the
 * controller service fails closed with a structured 'invalid image path'
 * error instead of silently reviewing something else); the remaining text is
 * the review question. This is input metadata, never model reasoning.
 */
function visualReviewRequestOf(text, workspace) {
  const remainder = typeof text === 'string' ? text.replace(/^\s*\/visual-review\b[\s:]*/i, '').trim() : ''
  const tokens = []
  VISUAL_IMAGE_TOKEN_RE.lastIndex = 0
  let match
  while ((match = VISUAL_IMAGE_TOKEN_RE.exec(remainder)) !== null) tokens.push(match[0])
  const screenshots = []
  const seen = new Set()
  for (const token of tokens) {
    const candidate = path.isAbsolute(token) ? token : path.resolve(String(workspace || '.'), token)
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    screenshots.push(candidate)
  }
  let question = remainder
  for (const token of tokens) question = question.split(token).join(' ')
  question = question.replace(/\s+/g, ' ').trim()
  return { question, screenshots, references: [], platform: 'unknown' }
}

/**
 * Cheap deterministic INPUT classification for the controller's production
 * pre-step boundary. This classifies the requested operation, never model
 * reasoning text, and never calls another model. Rich clients can use the
 * PowerShell structured contract directly; this conservative adapter exists
 * for ordinary GUI prompts.
 */
const IMPLEMENTATION_REQUEST_RE = /^(implement|build|fix|change|update|create|add|remove|refactor|rename|apply|write|edit)\b/i
const EMPIRICAL_REQUEST_RE = /^(does|is|what (type|value|exit code)|how does).*\b(runtime|serialize|serialise|regex|path|command|powershell|node|exit code)\b/i
const REPOSITORY_REQUEST_RES = [
  /^(where|which (file|function|test|config|module|script|component|code path)|what does (the )?(current|repository|implementation)|find (the )?(symbol|references|callers|definition|implementation))\b/i,
  /^(inspect|locate|trace|show|identify)\b/i,
  /^(explain|describe|show)\s+how\s+(the\s+)?(current|existing|repository|implementation|controller|code)\b/i,
  /^how\s+does\s+(the\s+)?(current|existing|repository|implementation|controller|code)\b/i,
  /^what\s+currently\s+(handles|implements|writes|reads|routes|resolves|creates|updates)\b/i,
  /\b(current|existing)\s+(implementation|code|controller|architecture|code path|routing|verification)\b/i,
  /\b(where|how)\s+[^?\n]*\b(defined|implemented|wired|connected|resolved|handled|written|used|called)\b/i,
]
const PRESCRIPTIVE_JUDGMENT_RES = [
  /\bshould\b/i,
  /^(recommend|design|choose|propose|decide)\b/i,
  /\b(best|better|safer)\s+(architecture|approach|design|option|strategy)\b/i,
]

function classifyEpistemicPrompt(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (IMPLEMENTATION_REQUEST_RE.test(value)) {
    return { kind: 'judgment', implementationReady: true, probeAvailable: false, repositoryAvailable: true, subject: 'implementation.request' }
  }
  // Runtime-observable questions win over generic references to "current"
  // implementation: empirical uncertainty should be measured, not read or
  // reasoned about.
  if (EMPIRICAL_REQUEST_RE.test(value)) {
    return { kind: 'empirical', implementationReady: false, probeAvailable: true, probeCost: 'low', probeRisk: 'safe', expectedInformationGain: 'high', decisionRelevance: 'medium', repositoryAvailable: true, subject: 'runtime.question' }
  }
  const prescriptive = PRESCRIPTIVE_JUDGMENT_RES.some((re) => re.test(value))
  const repositoryDescriptive = REPOSITORY_REQUEST_RES.some((re) => re.test(value))
  if (repositoryDescriptive && !prescriptive) {
    return { kind: 'repository', implementationReady: false, probeAvailable: false, repositoryAvailable: true, subject: 'repository.question' }
  }
  if (prescriptive) {
    return { kind: 'judgment', implementationReady: false, probeAvailable: false, repositoryAvailable: true, subject: 'engineering.judgment' }
  }
  return { kind: 'judgment', implementationReady: false, probeAvailable: false, repositoryAvailable: true, subject: 'engineering.question' }
}

/**
 * Parse the authoritative DSH assistant/chunk usage event. DSH reports newly
 * processed (uncached) input in inputTokens and cache hits separately in
 * cacheReadTokens. Missing cacheReadTokens means no cache hit for that call.
 * No cost is inferred here.
 */
function engineeringUsageOfEvent(event) {
  if (!event || event.type !== 'assistant/chunk') return null
  const data = event.data
  const chunk = data && data.chunk
  const usage = chunk && chunk.type === 'usage' ? chunk.usage : null
  if (!usage || typeof usage !== 'object') return null
  const uncached = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  const cache = usage.cacheReadTokens === undefined || usage.cacheReadTokens === null ? 0 : Number(usage.cacheReadTokens)
  if (!Number.isFinite(uncached) || !Number.isFinite(output) || !Number.isFinite(cache)) return null
  const inputTokens = Math.max(0, Math.trunc(uncached))
  const cacheReadTokens = Math.max(0, Math.trunc(cache))
  const outputTokens = Math.max(0, Math.trunc(output))
  const turn = data && data.turn !== undefined && data.turn !== null ? String(data.turn) : ''
  const step = data && data.step !== undefined && data.step !== null ? String(data.step) : ''
  return {
    turn,
    step,
    stepId: turn || step ? turn + ':' + step : '',
    inputTokens,
    uncachedInputTokens: inputTokens,
    cacheReadTokens,
    outputTokens,
    usageAvailable: true,
  }
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
  muse_main: 'Muse · Main Agent',
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

function createSingleFlight(keyOf = (value) => String(value)) {
  const flights = new Map()
  return function runSingleFlight(value, operation) {
    const key = keyOf(value)
    const existing = flights.get(key)
    if (existing) return existing
    const run = Promise.resolve().then(operation)
    flights.set(key, run)
    run.finally(() => {
      if (flights.get(key) === run) flights.delete(key)
    }).catch(() => {})
    return run
  }
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

/** Compare a persisted Phase 3.1 session identity with a freshly resolved
 * identity for the immutable session cwd. Missing legacy identity is allowed
 * so it can be upgraded in place; any contradictory identity fails closed. */
function classifyBindingRepositoryIdentity(binding, identity) {
  if (!binding || !identity) return 'repository-identity-missing'
  const fields = ['workspaceId', 'repositoryId', 'checkoutId']
  const hasPersistedIdentity = fields.some((field) => typeof binding[field] === 'string' && binding[field] !== '')
  if (!hasPersistedIdentity) return null
  for (const field of fields) {
    if (typeof binding[field] !== 'string' || binding[field] === '' || binding[field] !== identity[field]) return 'repository-identity-mismatch'
  }
  if (normalizeWorkspaceIdentity(binding.executionRoot) !== normalizeWorkspaceIdentity(identity.executionRoot)) return 'repository-identity-mismatch'
  if (normalizeWorkspaceIdentity(binding.checkoutRootPath) !== normalizeWorkspaceIdentity(identity.checkoutRootPath)) return 'repository-identity-mismatch'
  return null
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

function engineForPreset(preset) {
  return preset === 'aih-muse' ? 'muse' : 'dual'
}

function assertEngineBinding(binding, requestedPreset, authoritativeEngine) {
  const requestedEngine = engineForPreset(requestedPreset)
  const boundEngine = binding && typeof binding.engine === 'string' ? binding.engine : ''
  const taskEngine = typeof authoritativeEngine === 'string' ? authoritativeEngine : boundEngine
  if (!['dual', 'muse'].includes(boundEngine) || !['dual', 'muse'].includes(taskEngine) || requestedEngine !== boundEngine || taskEngine !== boundEngine) {
    const error = new Error(`engine-binding-violation: bound='${boundEngine || 'missing'}', task='${taskEngine || 'missing'}', requested='${requestedEngine}'.`)
    error.code = 'engine-binding-violation'
    throw error
  }
  return boundEngine
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

  async function recoverStaleBinding(agent, session, workspace, promptText, stale, reason, authoritative) {
    // Part 10: structured detection event with the full identity context,
    // removal from memory, persisted removal, then a FRESH authoritative task
    // through the normal binding flow. The stale binding is never pointed at
    // another task that merely shares its taskId, and no task is ever
    // reconstructed from binding contents.
    // TASK-0056: engine immutability survives recovery. The replacement task
    // is created with the EXPLICIT authoritative engine/preset carried forward
    // from the stale binding — never re-resolved from the mutable session
    // preference. ensureBinding guarantees `authoritative` is present and that
    // the requested engine already matched it before any invalidation runs.
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
    const created = await deps.createBinding(agent, session, workspace, promptText, authoritative)
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
        const error = new Error(`session workspace mismatch: binding '${binding.workspace ?? ''}', session '${workspace ?? ''}'`)
        error.code = 'session-workspace-mismatch'
        throw error
      }
      if (typeof deps.validateWorkspaceIdentity === 'function') await deps.validateWorkspaceIdentity(binding, workspace)
      // TASK-0056: engine identity is immutable and is checked BEFORE any
      // stale-binding invalidation/recovery. A stale/missing task must NEVER
      // let the same session switch Muse <-> Dual during recovery. The
      // requested engine comes from the current session preset; the bound
      // engine comes from the persisted binding. Any mismatch — including a
      // legacy binding WITHOUT an engine, which cannot prove its identity —
      // fails closed with engine-binding-violation: no invalidation, no
      // replacement task, no downstream/model call.
      const staleEngine = deps.requestedPresetOf && typeof deps.requestedPresetOf === 'function'
        ? deps.requestedPresetOf(session)
        : binding.preset
      assertEngineBinding(binding, staleEngine)
      const authoritativeEngine = binding.engine
      const authoritativePreset = binding.preset
      // Part 21: a legacy binding WITHOUT taskInstanceId can never prove its
      // lifecycle generation, so it must not silently attach to (possibly
      // different) current controller state. It is stale/ambiguous by
      // definition and is safely rebound through the normal flow — with the
      // SAME engine identity carried forward explicitly.
      const bindingInstance = typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : ''
      if (bindingInstance === '') {
        return recoverStaleBinding(agent, session, workspace, promptText, binding, 'ambiguous-legacy-binding', { engine: authoritativeEngine, preset: authoritativePreset })
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
        // TASK-0056: the stale verdict is proven, but the engine check above
        // already ran BEFORE any invalidation. Recovery still carries the
        // original bound engine explicitly so createBinding cannot re-resolve
        // it from the mutable profile preference.
        return recoverStaleBinding(agent, session, workspace, promptText, binding, verdict.reason, { engine: authoritativeEngine, preset: authoritativePreset })
      }
      assertEngineBinding(binding, binding.preset, identity.boundEngine)
      return { binding, outcome: 'valid' }
    })
  }

  return { ensureBinding, withSessionBindingLock, locks }
}

// ── plugin ──────────────────────────────────────────────────────────────────

function resolveInstallRoot(env) {
  // Phase 3.2.5 (root-cause fix for the TASK-0005 e2e baseline failure):
  // the LIVE runtime data root (DSH_HOME) owns install-root identity.
  // AIH_INSTALL_ROOT is an operator override for CLIs that run WITHOUT the
  // DSH runtime. When both are present they are set consistently by the
  // aih entrypoints; when they DISAGREE (isolated test fixtures, relocated
  // data roots, alternate checkouts), resolving the install root from
  // AIH_INSTALL_ROOT sent this bridge's child controller CLIs (Route.ps1,
  // Task.ps1) to the PRODUCTION data root while the bridge itself wrote
  // runtime state under DSH_HOME - cross-root contamination, and the
  // documented fixture contract ("the bridge resolves relative to DSH_HOME")
  // was violated. Priority is therefore DSH_HOME first, AIH_INSTALL_ROOT
  // second. (PowerShell CLIs keep explicit -InstallRoot as the strongest
  // binding; resolveInstallRoot only fills what the caller omits.)
  const environment = env || process.env
  if (environment.DSH_HOME) return path.dirname(path.resolve(environment.DSH_HOME))
  if (environment.AIH_INSTALL_ROOT) return path.resolve(environment.AIH_INSTALL_ROOT)
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
  // Platform-aware PowerShell host resolution (mirror of scripts/Platform.ps1
  // Get-AihPowerShellHost): Windows keeps powershell.exe; POSIX prefers the
  // AIH_PWSH_HOST override, then the setup.sh-pinned runtime/pwsh/pwsh, then a
  // system pwsh on PATH.
  const resolvePowerShellHost = (root) => {
    if (process.platform === 'win32') return 'powershell.exe'
    const override = process.env.AIH_PWSH_HOST
    if (override) return override
    const pinned = path.join(root, 'runtime', 'pwsh', 'pwsh')
    try { fs.accessSync(pinned, fs.constants.X_OK); return pinned } catch { /* fall through */ }
    return 'pwsh'
  }
  // TASK-0026: the Nexus TOOLCHAIN root (owns runtime/) is formally distinct
  // from the LOGICAL InstallRoot (owns config/data identity). Isolated test
  // fixtures legitimately model config/data-only roots with no runtime, so
  // the bridge resolves its pinned PowerShell through the toolchain chain
  // (AIH_TOOLCHAIN_ROOT > the tree that owns this controller file > the
  // logical root) and names that root for every spawned CLI child, so
  // Nexus-owned nested children always resolve the real pinned runtime.
  const resolveToolchainRoot = (logicalRoot) => {
    const candidates = []
    const fromEnv = process.env.AIH_TOOLCHAIN_ROOT
    if (fromEnv && String(fromEnv).trim() !== '') candidates.push(path.resolve(String(fromEnv)))
    candidates.push(path.resolve(__dirname, '..'))
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
  // Capture transport (TASK-0017): sandboxed environments may deny
  // anonymous-pipe and fd-redirected stdio capture from Node children
  // (spawn EPERM) while stdio:'ignore'/'inherit' spawns remain allowed.
  // On Windows, run each CLI through cmd.exe with cmd-side redirection
  // into temporary files (no pipes anywhere) and return the same bytes,
  // preserving the promisify(execFile) result and rejection shapes
  // (.code/.stdout/.stderr/.killed/.signal). Non-Windows platforms keep
  // the original pipe transport.
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
  const bindings = loadBindings(bindingsPath)
  const resolveWorkspaceSingleFlight = createSingleFlight(normalizeWorkspaceIdentity)

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
          workspaceId: binding.workspaceId ?? null,
          repositoryId: binding.repositoryId ?? null,
          checkoutId: binding.checkoutId ?? null,
          checkoutRootPath: binding.checkoutRootPath ?? null,
          executionRoot: binding.executionRoot ?? binding.workspace,
          preset: binding.preset,
          engine: binding.engine,
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
    const diagnosticArgs = Array.isArray(args) ? [...args] : []
    const payload = options && options.payload
    let payloadPath = null
    if (payload && typeof payload === 'object') {
      payloadPath = await writePayloadFile(payload)
      args = [...args, '-PayloadFile', payloadPath]
    }
    try {
      const result = await spawnCaptured(
        pwshHost,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsRoot, script), ...args],
        { timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: childCliEnv },
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
      if (payloadPath) {
        try { fs.unlinkSync(payloadPath) } catch { /* best effort */ }
      }
    }
  }

  async function createTask(workspace, description, reviewRequested, engine) {
    const task = await invokePowerShell('Task.ps1', ['-Action', 'create-task'], {
      payload: { workspace, description, reviewRequested: Boolean(reviewRequested), engine },
    })
    if (!task || !task.taskId) throw new Error('aih-controller: task creation returned no taskId')
    return task
  }

  async function resolveWorkspaceIdentity(workspace) {
    return resolveWorkspaceSingleFlight(workspace, async () => {
      const identity = await invokePowerShell('NexusWorkspace.ps1', ['-Action', 'resolve'], {
        payload: { path: workspace },
      })
      if (!identity || !identity.workspaceId || !identity.repositoryId || !identity.checkoutId || !identity.executionRoot || !identity.checkoutRootPath) {
        const error = new Error('aih-controller: Phase 3.1 workspace identity could not be resolved')
        error.code = 'session-workspace-identity-unavailable'
        throw error
      }
      return identity
    })
  }

  async function routeTask(workspace, taskId, description, options = {}) {
    const payload = { workspace, description }
    if (options.signal) payload.signal = options.signal
    if (options.failureReason) payload.failureReason = options.failureReason
    if (options.reviewRequested) payload.reviewRequested = true
    // TASK-0005 Part 16: route requests carry the lifecycle instance; Route.ps1
    // re-validates it against the authoritative ledger (fail closed).
    if (options.taskInstanceId) payload.taskInstanceId = options.taskInstanceId
    if (options.requestedEngine) payload.requestedEngine = options.requestedEngine
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
    createBinding: (agent, session, workspace, promptText, authoritative) => bindSession(agent, session, workspace, promptText, authoritative),
    requestedPresetOf: (session) => agentPresetOf(session),
    testTaskIdentity,
    validateWorkspaceIdentity: async (binding, workspace) => {
      const identity = await resolveWorkspaceIdentity(workspace)
      const mismatch = classifyBindingRepositoryIdentity(binding, identity)
      if (mismatch) {
        const error = new Error(`session repository identity mismatch: expected ${binding.repositoryId || 'unrecorded'}/${binding.checkoutId || 'unrecorded'}, actual ${identity.repositoryId}/${identity.checkoutId}`)
        error.code = mismatch
        throw error
      }
      // In-place upgrade for pre-universal bindings. The session cwd is
      // immutable and the Phase 3.1 resolver just validated it, so this adds
      // identity without migrating the session or its task.
      if (!binding.repositoryId) {
        Object.assign(binding, identity)
        binding.workspace = identity.executionRoot
        persistBindings()
      }
    },
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

  // Phase 3.2.5: step/milestone-level role selection. EVERY engineering turn
  // selects its CURRENT role deterministically: engineer_normal is the
  // default; engineer_deep requires a task-local structured escalation
  // reason and de-escalates once its artifact is recorded. The task-level
  // classification is never overwritten by this (it stays the initial
  // planning/UI metadata); the step role applies to THIS step and is
  // mirrored into the routing state for the model enforcement layer. The
  // reviewer is never selected by this mechanism. Fail-safe: on any
  // engineering-plane failure the task-level class is used.
  async function selectEngineeringEpistemicStep(binding, turn, promptText) {
    const policyInput = classifyEpistemicPrompt(promptText)
    const uncertainty = await invokePowerShell('Engineering.ps1', ['-Action', 'uncertainty-create', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        question: promptText,
        uncertaintyKind: policyInput.kind,
        subject: policyInput.subject,
        decisionImpact: 'medium',
        probeAvailable: Boolean(policyInput.probeAvailable),
        probeCost: policyInput.probeCost || 'low',
        probeRisk: policyInput.probeRisk || 'safe',
        expectedInformationGain: policyInput.expectedInformationGain || 'medium',
        decisionRelevance: policyInput.decisionRelevance || 'medium',
        repositoryAvailable: policyInput.repositoryAvailable !== false,
      },
    })
    if (!uncertainty || !uncertainty.id) return null
    const decision = await invokePowerShell('Engineering.ps1', ['-Action', 'epistemic-step', '-TaskId', binding.taskId, '-Preset', binding.preset || 'aih-engineering'], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        uncertaintyId: uncertainty.id,
        question: promptText,
        implementationReady: Boolean(policyInput.implementationReady),
        stepKind: 'turn',
        milestoneId: turn ? String(turn) : undefined,
      },
    })
    if (!decision || !decision.selectedRole) return null
    if (decision.selectedRole !== 'engineer_normal' && decision.selectedRole !== 'engineer_deep') return null

    let retrieval = null
    let retrievalError = null
    if (decision.selectedAction === 'retrieve') {
      try {
        retrieval = await invokePowerShell('Engineering.ps1', ['-Action', 'working-set-retrieve', '-TaskId', binding.taskId], {
          payload: {
            workspace: binding.workspace,
            taskInstanceId: binding.taskInstanceId || undefined,
            query: promptText,
            maxResults: 20,
          },
        })
      } catch (error) {
        retrievalError = String(error && error.message ? error.message : error)
        log({ event: 'epistemic-retrieve-failed', taskId: binding.taskId, taskInstanceId: binding.taskInstanceId || null, error: retrievalError })
      }
    }
    return { ...decision, retrieval, retrievalError }
  }

  async function selectEngineeringVerificationAction(binding) {
    const question = 'Acquire final correctness evidence for the current implementation.'
    const uncertainty = await invokePowerShell('Engineering.ps1', ['-Action', 'uncertainty-create', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, ...instancePayloadOf(binding), question, uncertaintyKind: 'verification', subject: 'verification.final', probeAvailable: false },
    })
    if (!uncertainty || !uncertainty.id) return null
    return invokePowerShell('Engineering.ps1', ['-Action', 'epistemic-select', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, ...instancePayloadOf(binding), uncertaintyId: uncertainty.id, verificationRequired: true },
    })
  }

  async function completeEngineeringEpistemicAction(binding, actionId, result, summary, failureSignature) {
    if (!actionId) return null
    return invokePowerShell('Engineering.ps1', ['-Action', 'epistemic-complete', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, ...instancePayloadOf(binding), actionId, actionResult: result, summary: summary || '', failureSignature: failureSignature || '' },
    })
  }

  async function beginAttempt(binding, turn, executionClass) {
    return invokePowerShell('Task.ps1', ['-Action', 'begin-attempt', '-TaskId', binding.taskId, '-ExecutionClass', executionClass || binding.executionClass || 'engineer_normal'], {
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

  // Phase 3.2.5: normalize a raw failure text through the deterministic
  // failure classifier (Engineering.ps1 classify-failure) so equivalent
  // failures share ONE stable task-local signature. Never fatal: when the
  // engineering plane is unavailable the caller's label is kept as-is.
  async function classifyFailureSignature(binding, evidence) {
    try {
      const classified = await invokePowerShell('Engineering.ps1', ['-Action', 'classify-failure', '-TaskId', binding.taskId], {
        payload: {
          workspace: binding.workspace,
          taskInstanceId: binding.taskInstanceId || undefined,
          evidenceText: evidence || '',
          actionSummary: 'turn-error',
        },
      })
      if (classified && classified.signature) {
        return { signature: String(classified.signature), classification: String(classified.classification || 'unknown') }
      }
    } catch { /* fail-safe below */ }
    return null
  }

  async function recordFailure(binding, signature, evidence) {
    let failureSignature = signature
    const classified = await classifyFailureSignature(binding, evidence)
    if (classified && classified.signature) failureSignature = classified.signature
    return invokePowerShell('Task.ps1', ['-Action', 'failure', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, failureSignature, evidence: evidence || '', ...instancePayloadOf(binding) },
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

  // Phase 3.2.5 production integration: initialize the task-local Engineering
  // lifecycle once, at the same authoritative binding boundary that creates
  // taskInstanceId. The CLI action is idempotent and generation-aware.
  async function initializeEngineeringLifecycle(binding) {
    if (!binding || (binding.executionClass !== 'engineer_normal' && binding.executionClass !== 'engineer_deep')) return null
    return invokePowerShell('Engineering.ps1', ['-Action', 'lifecycle-init', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        text: binding.description || '',
      },
    })
  }

  async function planEngineeringVerification(binding) {
    await initializeEngineeringLifecycle(binding)
    const requirements = await invokePowerShell('Engineering.ps1', ['-Action', 'requirements-snapshot', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, ...instancePayloadOf(binding) },
    })
    const requirementIds = requirements && Array.isArray(requirements.requirements)
      ? requirements.requirements.filter((item) => item && item.required !== false).map((item) => String(item.id || '')).filter(Boolean)
      : []
    return invokePowerShell('Engineering.ps1', ['-Action', 'plan-verification', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        ...instancePayloadOf(binding),
        verificationScope: 'final',
        reason: 'Controller-owned /verify final project verification.',
        requirementIds,
        commands: [{
          name: 'aih-verify-project',
          executable: pwshHost,
          argv: ['-File', path.join(scriptsRoot, 'Verify-Project.ps1'), '-Kind', 'all'],
          cwd: binding.workspace,
          timeoutMs: 600000,
        }],
      },
    })
  }

  async function completeEngineeringVerification(binding, plan, result, summary) {
    if (!plan || !plan.verificationId) throw new Error('Engineering verification plan did not return a verificationId.')
    return invokePowerShell('Engineering.ps1', ['-Action', 'complete-verification', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        ...instancePayloadOf(binding),
        verificationId: plan.verificationId,
        status: result,
        summary,
      },
    })
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

  // ── Phase V2: controller-owned AUTOMATIC visual verification ───────────
  // Runs at the completion boundary (after deterministic verification has
  // passed): detect visual requirement -> bounded loop (capture -> visual
  // review -> adjudicate -> repair handoff / convergence). The engineering
  // session never types /visual-review; the loop is controller-owned.
  async function runVisualLoop(binding) {
    return invokePowerShell('VisualLoop.ps1', ['-Action', 'iterate', '-TaskId', binding.taskId, '-InstallRoot', installRoot], {
      payload: { workspace: binding.workspace, ...instancePayloadOf(binding) },
    })
  }

  async function detectVisualLoop(binding) {
    return invokePowerShell('VisualLoop.ps1', ['-Action', 'detect', '-TaskId', binding.taskId, '-InstallRoot', installRoot], {
      payload: { workspace: binding.workspace, ...instancePayloadOf(binding) },
    })
  }

  function persistVisualUnavailable(binding, reason) {
    const visualRoot = path.join(binding.workspace, '.ai-harness', 'runs', binding.taskId, 'visual')
    const statePath = path.join(visualRoot, 'state.json')
    let state = null
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { return null }
    if (!state || state.required !== true) return null
    const exactReason = 'controller invocation failed: ' + String(reason || 'unknown visual-loop failure')
    const reasons = Array.isArray(state.reasons) ? state.reasons.map(String) : []
    if (!reasons.includes(exactReason)) reasons.push(exactReason)
    state.status = 'unavailable'
    state.reasons = reasons.slice(-20)
    state.updatedAtUtc = new Date().toISOString()
    fs.mkdirSync(visualRoot, { recursive: true })
    const temporary = statePath + '.' + crypto.randomUUID() + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2))
    fs.renameSync(temporary, statePath)
    return state
  }

  function visualRepairPacketText(binding, loop) {
    const lines = [
      'Controller: visual verification requires repair · task ' + binding.taskId + ' · iteration ' + String(loop.iteration) + '/' + String(loop.maxIterations),
      '',
      String(loop.repairPacket || ''),
      '',
      'Repair in this session, then run /verify again: deterministic re-verification is required before the next automatic visual review.',
      'The visual reviewer never edits files; findings were adjudicated by controller policy (rejected findings are listed as IGNORED).',
    ]
    return lines.join('\n')
  }

  // ── Context Compaction V1: controller-owned checkpoint + apply ──────────
  // The task text below is historical context for the NEXT request, never
  // controller truth: routing and completion stay authoritative in
  // TaskController state. Every uncertain boundary keeps old context (KEEP).
  async function lifecycleCli(action, binding, extraArgs, extraPayload) {
    const args = ['-Action', action, '-TaskId', binding.taskId]
    if (Array.isArray(extraArgs)) args.push(...extraArgs)
    return invokePowerShell('ContextLifecycleCli.ps1', args, {
      payload: Object.assign({ workspace: binding.workspace, taskInstanceId: binding.taskInstanceId || undefined }, extraPayload || {}),
    })
  }

  async function evaluateContextCompactionAtCompletion(binding, session) {
    if (!binding || !binding.taskInstanceId) return null
    const sessionId = session && session.id ? String(session.id) : ''
    const eligibility = await lifecycleCli('eligibility', binding, [], { sessionId })
    if (!eligibility || eligibility.eligibilityDecision !== 'eligible') {
      // Never downgrade durable progress: a repeated completion check that
      // now reads keep (e.g. a small follow-up call lowered the volatile
      // latest signal) must not overwrite checkpoint-ready/applied telemetry.
      const existing = await lifecycleCli('snapshot', binding, [], {}).catch(() => null)
      if (!existing || existing.state === 'inactive' || existing.state === 'blocked') {
        await lifecycleCli('write-telemetry', binding, [], { sessionId }).catch(() => null)
      }
      log({ event: 'context-compaction-not-eligible', sessionId, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, reason: eligibility && eligibility.eligibilityReason })
      return eligibility
    }
    await lifecycleCli('transition', binding, [], { to: 'eligible', reason: eligibility.eligibilityReason, sessionId })
    const checkpoint = await lifecycleCli('build-checkpoint', binding, [], {
      continuityUserText: (binding && typeof binding.lastUserPrompt === 'string' && binding.lastUserPrompt !== '') ? binding.lastUserPrompt : contextCompaction.lastTextOfRole(session, 'user', 2000),
      continuityAssistantText: contextCompaction.lastTextOfRole(session, 'assistant', 4000),
      sessionId,
    })
    await lifecycleCli('transition', binding, [], { to: 'checkpoint-ready', reason: 'checkpoint constructed and validated', sessionId, checkpointPath: checkpoint && checkpoint.path ? String(checkpoint.path) : null })
    // Freeze the operation boundary NOW from the completion-time surface:
    // at this point no Task B work can exist yet, so the frozen range owns
    // exactly Task A bulk. Retry later reuses it verbatim, never recomputed.
    const frozen = freezeCompactionBoundary(session)
    if (frozen) {
      await lifecycleCli('freeze-operation', binding, [], {
        sessionId,
        replacementStart: frozen.replacementStart,
        replacementEnd: frozen.replacementEnd,
        sourceEventSeqs: frozen.sourceEventSeqs,
        checkpointPath: checkpoint && checkpoint.path ? String(checkpoint.path) : null,
      })
      await lifecycleCli('transition', binding, [], { to: 'apply-pending', reason: 'frozen operation persisted at completion; boundary owned by ' + binding.taskId, sessionId })
    } else {
      log({ event: 'context-compaction-freeze-deferred', sessionId, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId })
    }
    const telemetry = await lifecycleCli('write-telemetry', binding, [], {
      sessionId,
      checkpointPath: checkpoint && checkpoint.path ? String(checkpoint.path) : null,
      checkpointSizeBytes: checkpoint && checkpoint.sizeBytes !== undefined ? checkpoint.sizeBytes : null,
    })
    log({ event: 'context-compaction-checkpoint-ready', sessionId, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, checkpointSizeBytes: checkpoint && checkpoint.sizeBytes })
    return telemetry
  }

  // Flush one session through the supported DSH durability barrier
  // (ctx.sessions.flush -> session/flush -> write-behind drain). Returns
  // true when at least one durability listener participated, false when no
  // listener handled the session (detached/foreign session), and THROWS when
  // the durable write fails. No sleep/timeout emulation anywhere.
  async function flushSessionDurable(session) {
    if (!session) throw new Error('flush requires a session');
    if (!ctx || typeof ctx.get !== 'function') throw new Error('session store unavailable for durability flush');
    const sessions = ctx.get('sessions');
    if (!sessions || typeof sessions.flush !== 'function') throw new Error('ctx.sessions.flush is unavailable; durability cannot be proven');
    return sessions.flush(session);
  }

  // Applied on the NEXT agent/pre-step after authoritative completion: the
  // supported DSH surface seam (user/message with surfaceOp replace) changes
  // the MODEL-FACING projection while the raw session log stays intact (the
  // transcript renders from append-origin events). The replacement boundary
  // is FROZEN per operation (never recomputed): retry reuses the exact
  // frozen seqs, crash reconciles by operationId, and APPLIED lands only
  // after the DSH durability barrier. Any failure keeps the old context and
  // lets the turn proceed normally.
  //
  // Narrow in-process guard: duplicate pre-step handlers for the same
  // operationId join one in-flight attempt instead of appending twice. It
  // spans only the append+flush section (no Git, model, or external I/O
  // inside) and never replaces the durable operation record as the source
  // of truth: a second process still reconciles through persisted state.
  const compactionInflightByOperation = new Map()
  // Freeze the replacement boundary ONCE from the completion-time surface,
  // excluding the host-owned dynamic runtime-context snapshot (F1): the
  // frozen range only ever covers Task A bulk, and the CURRENT request keeps
  // its authoritative runtime policy because the retained snapshot node is
  // never shadowed and is refreshed below after the replace lands.
  // Returns the frozen operation or null (KEEP) without mutating state.
  function freezeCompactionBoundary(session) {
    const cut = contextCompaction.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 })
    if (!cut) return null
    const ownedRuntime = contextCompaction.runtimeContextSeqsOf(session)
    const excluded = ownedRuntime.filter((seq) => cut.shadowedSeqs.indexOf(seq) !== -1)
    const segments = contextCompaction.splitRangeAroundOwned(session, cut.shadowedSeqs, ownedRuntime)
    if (!segments) return null
    const flat = []
    for (const segment of segments) for (const seq of segment.sourceEventSeqs) flat.push(seq)
    return {
      segments,
      replacementStart: flat[0],
      replacementEnd: flat[flat.length - 1],
      sourceEventSeqs: flat,
      excludedRuntimeSeqs: excluded,
    }
  }

  // Refresh the authoritative CURRENT dynamic runtime snapshot after the
  // replace landed (F1 path B): re-render the live assembly through the real
  // DSH section pipeline and append a fresh snapshot ONLY when it differs
  // from the retained one. Never synthesizes policy text: the sections come
  // from ctx.systemPrompt (the same authority the loop used pre-step).
  async function refreshRuntimeContextSnapshot(session, agent) {
    try {
      if (!ctx || !agent) return null
      const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
      if (!systemPrompt || typeof systemPrompt.assemble !== 'function') return null
      const dshAgent = await import('@deepseek-ai/dsh-agent').catch(() => null)
      const dshPrompt = await import('@deepseek-ai/dsh-system-prompt').catch(() => null)
      if (!dshAgent || !dshPrompt) return null
      const assembleContextFor = dshAgent.assembleContextFor
      const renderContextSections = dshPrompt.renderContextSections
      const joinContextSections = dshPrompt.joinContextSections
      if (typeof assembleContextFor !== 'function' || typeof renderContextSections !== 'function' || typeof joinContextSections !== 'function') return null
      const assembly = await systemPrompt.assemble(assembleContextFor(agent, agent.signal || new AbortController().signal))
      const sections = renderContextSections(assembly)
      const snapshot = joinContextSections(sections)
      if (!snapshot) return null
      const retained = contextCompaction.runtimeContextSeqsOf(session)
      let retainedText = null
      for (const seq of retained) {
        const event = Array.isArray(session.events) ? session.events[seq] : null
        if (event && event.type === 'user/message' && Array.isArray(session.surface.nodes) && session.surface.nodes.indexOf(seq) !== -1) {
          const content = event.data && Array.isArray(event.data.content) ? event.data.content : []
          if (content.length === 1 && content[0] && content[0].type === 'text') retainedText = content[0].text
        }
      }
      if (retainedText === snapshot) return null
      return session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: snapshot }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: sections.map((section) => ({ name: section.name })) },
      }, { surfaceOp: 'append' })
    } catch (error) {
      log({ event: 'context-compaction-runtime-refresh-failed', error: String(error && error.message ? error.message : error) })
      return null
    }
  }

  async function maybeApplyContextCompaction(session, binding, agent) {
    if (!binding || !binding.taskInstanceId || !session) return null
    const sessionId = session.id ? String(session.id) : ''
    let snapshot = null
    try {
      snapshot = await lifecycleCli('snapshot', binding, [], {})
    } catch (error) {
      log({ event: 'context-compaction-snapshot-failed', sessionId, taskId: binding.taskId, error: String(error) })
      return null
    }
    // Legacy checkpoint-ready without a frozen operation is never admitted
    // to the apply path (F2/F5 repair): BLOCK/KEEP and require fresh work.
    if (!snapshot || (snapshot.state !== 'checkpoint-ready' && snapshot.state !== 'apply-pending' && snapshot.state !== 'awaiting-durability')) return null
    if (!snapshot.lifecycle || snapshot.lifecycle.taskInstanceId !== binding.taskInstanceId) {
      log({ event: 'context-compaction-generation-mismatch', sessionId, taskId: binding.taskId })
      return null
    }
    // Apply-time revalidation checks IDENTITY (still controller-complete,
    // same lifecycle generation), not pressure: the threshold decision was
    // authoritatively made at completion and stored in lifecycle state. A
    // small post-completion call lowers the volatile latest signal without
    // erasing the bulk, so below-threshold keep does not block; any other
    // keep (not complete, mismatch, unproven) blocks and keeps old context.
    const eligibility = await lifecycleCli('eligibility', binding, [], { sessionId }).catch(() => null)
    const belowThresholdKeep = eligibility && eligibility.eligibilityDecision === 'keep'
      && typeof eligibility.eligibilityReason === 'string' && eligibility.eligibilityReason.indexOf('below-threshold') === 0
    if ((!eligibility || eligibility.eligibilityDecision !== 'eligible') && !belowThresholdKeep) {
      await lifecycleCli('transition', binding, [], { to: 'blocked', reason: 'revalidation at apply time: ' + (eligibility && eligibility.eligibilityReason ? eligibility.eligibilityReason : 'not eligible'), sessionId }).catch(() => null)
      await lifecycleCli('write-telemetry', binding, [], { sessionId, blockedReason: 'apply-time revalidation failed' }).catch(() => null)
      return null
    }
    const checkpoint = await lifecycleCli('read-checkpoint', binding, [], {}).catch(() => null)
    const provenance = contextCompaction.checkpointProvenanceValid(checkpoint, { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId })
    if (!provenance.valid) {
      await lifecycleCli('transition', binding, [], { to: 'blocked', reason: 'checkpoint provenance invalid at apply time: ' + provenance.reason, sessionId }).catch(() => null)
      return null
    }
    if (typeof session.append !== 'function') {
      log({ event: 'context-compaction-no-append-seam', sessionId, taskId: binding.taskId })
      return null
    }
    // Case A first: the frozen replacement may already be durably present
    // (crash after append, before APPLIED). Reconcile, never re-append.
    let operation = await lifecycleCli('read-operation', binding, [], {}).catch(() => null)
    if (operation && operation.taskInstanceId !== binding.taskInstanceId) {
      log({ event: 'context-compaction-operation-generation-mismatch', sessionId, taskId: binding.taskId })
      return null
    }
    if (!operation) {
      // First attempt: freeze the boundary from the CURRENT surface (the
      // completion-time surface; no Task B work exists yet because apply
      // runs on the first pre-step after completion) and persist it BEFORE
      // any append. The freeze excludes host-owned runtime-context nodes.
      const frozen = freezeCompactionBoundary(session)
      if (!frozen) {
        log({ event: 'context-compaction-no-balanced-cut', sessionId, taskId: binding.taskId })
        return null
      }
      // operationId is deterministic per generation+session; compute it via
      // freeze with the real boundary (idempotent when retried pre-persist).
      operation = await lifecycleCli('freeze-operation', binding, [], {
        sessionId,
        replacementStart: frozen.replacementStart,
        replacementEnd: frozen.replacementEnd,
        sourceEventSeqs: frozen.sourceEventSeqs,
        segments: frozen.segments,
        checkpointPath: snapshot.lifecycle.checkpointPath || null,
      })
      await lifecycleCli('transition', binding, [], { to: 'apply-pending', reason: 'frozen operation persisted; boundary owned by ' + binding.taskId, sessionId }).catch(() => null)
    }
    const operationId = operation.operationId
    // Join duplicate in-flight attempts for the same operationId instead of
    // appending twice. The durable operation record stays authoritative.
    if (compactionInflightByOperation.has(operationId)) {
      return compactionInflightByOperation.get(operationId)
    }
    const attempt = (async () => {
      // Reconcile against the LIVE session: landed (same operationId) ->
      // applied; exact frozen range still valid -> append SAME range;
      // otherwise BLOCK/KEEP. Never recompute a broader range.
      const liveNodes = contextCompaction.surfaceNodesOf(session)
      const landed = contextCompaction.findReplacementByOperation(session, operationId)
      const reconcile = await lifecycleCli('reconcile', binding, [], {
        liveSurfaceSeqs: liveNodes,
        landedReplacementSeq: landed ? landed.seq : -1,
      })
      if (!reconcile) return null
      if (reconcile.decision === 'reconcile-applied') {
        await lifecycleCli('transition', binding, [], { to: 'applied', reason: 'reconciled: frozen replacement already durably present', sessionId }).catch(() => null)
        await lifecycleCli('write-telemetry', binding, [], { sessionId, checkpointPath: snapshot.lifecycle.checkpointPath || null }).catch(() => null)
        await lifecycleCli('mark-applied', binding, [], { sessionId, appliedAtUtc: new Date().toISOString() }).catch(() => null)
        log({ event: 'context-compaction-reconciled', sessionId, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, operationId })
        return { reconciled: true, operationId }
      }
      if (reconcile.decision !== 'retry-same') {
        await lifecycleCli('transition', binding, [], { to: 'blocked', reason: 'reconcile: ' + (reconcile.reason || 'frozen boundary unsafe'), sessionId }).catch(() => null)
        await lifecycleCli('write-telemetry', binding, [], { sessionId, blockedReason: 'frozen boundary unsafe at retry' }).catch(() => null)
        return null
      }
      // F2 current-prompt guard: no shadowed seq may be newer than the
      // frozen completion boundary. The frozen seqs ARE the boundary; any
      // live user/message newer than replacementEnd that is NOT retained
      // outside the frozen range blocks the apply (Task B prompt safety).
      // (The reconcile already proved all frozen seqs are still live; this
      // additionally proves no NEWER event was adopted into the operation.)
      const frozenSeqs = reconcile.sourceEventSeqs || operation.sourceEventSeqs
      const checkpointText = await lifecycleCli('checkpoint-text', binding, [], {})
      const message = createControllerMessage(checkpointText && checkpointText.text ? String(checkpointText.text) : '(context checkpoint unavailable)', 'context-checkpoint')
      message.source = Object.assign({}, message.source, { operationId })
      // One replacement node per FROZEN segment (persisted at freeze time;
      // owned runtime snapshots stay visible between segments). Segments
      // share the operationId so reconciliation addresses the whole
      // operation at once. Never recomputed here.
      const frozenSegments = Array.isArray(operation.segments) && operation.segments.length > 0
        ? operation.segments
        : [{ start: reconcile.replacementStart, end: reconcile.replacementEnd, sourceEventSeqs: frozenSeqs }]
      if (!frozenSegments || frozenSegments.length === 0) {
        log({ event: 'context-compaction-no-frozen-segments', sessionId, taskId: binding.taskId, operationId })
        return null
      }
      const appendedSeqs = []
      for (const segment of frozenSegments) {
        if (!segment || typeof segment.start !== 'number' || typeof segment.end !== 'number' || !Array.isArray(segment.sourceEventSeqs) || segment.sourceEventSeqs.length === 0) {
          log({ event: 'context-compaction-malformed-segment', sessionId, taskId: binding.taskId, operationId })
          return null
        }
        const node = session.append('user/message', message, { surfaceOp: { op: 'replace', start: segment.start, end: segment.end }, sourceEventSeqs: segment.sourceEventSeqs })
        appendedSeqs.push(node.seq)
      }
      const appended = { seq: appendedSeqs[appendedSeqs.length - 1] }
      await lifecycleCli('transition', binding, [], { to: 'awaiting-durability', reason: 'replacement appended in memory; durability unconfirmed', sessionId }).catch(() => null)
      // F5 durability barrier: the supported ctx.sessions.flush drain. Only
      // after it settles may APPLIED be persisted. A flush failure throws
      // here -> awaiting-durability persists -> retry reconciles.
      let flushed = false
      try {
        flushed = await flushSessionDurable(session)
      } catch (flushError) {
        log({ event: 'context-compaction-flush-failed', sessionId, taskId: binding.taskId, operationId, error: String(flushError && flushError.message ? flushError.message : flushError) })
        return null
      }
      if (flushed === false) {
        // No durability listener participated (foreign/detached session in
        // this host): cannot prove durability -> stay, retry reconciles.
        log({ event: 'context-compaction-no-durability-listener', sessionId, taskId: binding.taskId, operationId })
        return null
      }
      // Post-flush presence check: the landed node must be visible before
      // APPLIED is written.
      const landedAfter = contextCompaction.findReplacementByOperation(session, operationId)
      if (!landedAfter || landedAfter.seq !== appended.seq) {
        log({ event: 'context-compaction-landed-missing', sessionId, taskId: binding.taskId, operationId })
        return null
      }
      const appliedAtUtc = new Date().toISOString()
      await lifecycleCli('transition', binding, [], { to: 'applied', reason: 'surface replace durable; model-facing bulk shadowed', sessionId })
      await lifecycleCli('write-telemetry', binding, [], { sessionId, checkpointPath: snapshot.lifecycle.checkpointPath || null })
      await lifecycleCli('mark-applied', binding, [], { sessionId, appliedAtUtc })
      // F1 path B: refresh the CURRENT authoritative runtime snapshot after
      // the replace landed, so the first post-compaction request carries
      // current dynamic policy even though the stale snapshot was shadowed.
      await refreshRuntimeContextSnapshot(session, agent)
      log({ event: 'context-compaction-applied', sessionId, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, operationId, shadowedSeqs: frozenSeqs.length })
      appendMessage(session, createControllerMessage('Controller: context checkpoint applied · task ' + binding.taskId + '.\nPrior execution history was compacted to a structured checkpoint; the repository remains the source of truth. Completion authority stays with the deterministic controller.', 'context-compaction-applied'))
      return { applied: true, operationId, shadowed: frozenSeqs.length }
    })().finally(() => { compactionInflightByOperation.delete(operationId) })
    compactionInflightByOperation.set(operationId, attempt)
    return attempt.catch((error) => {
      log({ event: 'context-compaction-apply-failed', sessionId, taskId: binding.taskId, error: String(error && error.message ? error.message : error) })
      return null
    })
  }

  /** Completion decision after a passed verification (review disposition aware). */
  async function runCompletionTail(binding, session) {
    const review = readReviewResult(binding.workspace, binding.taskId)
    const reviewPass = Boolean(review && String(review.verdict) === 'pass')
    // V2: automatic visual loop at the completion boundary. Failures of the
    // loop infrastructure must never block non-visual completion accounting.
    let visualLoop = null
    try {
      visualLoop = await runVisualLoop(binding)
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      const unavailableState = persistVisualUnavailable(binding, reason)
      visualLoop = unavailableState
        ? { ok: false, visualWorkRequired: true, errorKind: 'visual-review-controller-invocation-failed', error: reason, reason, state: unavailableState }
        : null
      log({ event: 'visual-loop-failed', taskId: binding.taskId, error: reason, visualRequired: Boolean(unavailableState) })
    }
    const visualState = visualLoop && visualLoop.state ? visualLoop.state : null
    const visualStatus = visualState && visualState.status ? String(visualState.status) : 'none'
    const visualWorkRequired = Boolean(visualLoop && (visualLoop.visualWorkRequired === true || (visualState && visualState.required === true)))
    if (visualWorkRequired && visualStatus !== 'pass') {
      if (visualStatus === 'revise' && visualLoop.repairPacket) {
        appendMessage(
          session,
          createControllerMessage(visualRepairPacketText(binding, visualLoop), 'controller-visual-repair'),
        )
      } else if (visualStatus === 'exhausted') {
        appendMessage(
          session,
          createControllerMessage('Controller: visual iteration budget exhausted · task ' + binding.taskId + ' · operator attention required (HUMAN_REVIEW_PENDING). No automatic commit; completion stays blocked until visual status is pass.', 'controller-visual-blocked'),
        )
      } else if (visualStatus === 'unavailable') {
        appendMessage(
          session,
          createControllerMessage('Controller: visual verification unavailable · task ' + binding.taskId + ' · ' + String(visualLoop.reason || visualLoop.error || 'runtime or provider unavailable') + ' · no fabricated PASS; completion stays blocked until visual status is pass.', 'controller-visual-blocked'),
        )
      } else {
        appendMessage(
          session,
          createControllerMessage('Controller: visual verification incomplete · task ' + binding.taskId + ' · status ' + visualStatus + ' · no fabricated PASS; completion stays blocked until the controller-owned visual loop reaches pass.', 'controller-visual-blocked'),
        )
      }
      return { complete: false, visualBlocked: true, visualStatus, visualLoop }
    }
    const completion = await completionCheck(binding, reviewPass)
    const complete = Boolean(completion && completion.complete)
    if (complete) {
      appendMessage(
        session,
        createControllerMessage(
          'Controller: task ' + binding.taskId + ' COMPLETE.\nCompletion authority: deterministic controller. Verification passed' + (reviewPass ? '; independent review passed.' : '.') +
            (visualStatus === 'pass' ? '\nVisual review: VISUAL_REVIEW_PASS · HUMAN_REVIEW_PENDING (human acceptance is external; nothing was committed automatically). Final visual report: ' + String((visualLoop && visualLoop.resultPath) || '') : ''),
          'controller-complete',
        ),
      )
      // Context Compaction V1: authoritatively COMPLETE is the ONLY eligibility
      // trigger. Evaluate pressure, persist checkpoint-ready state, and record
      // telemetry. Every failure only logs: the session keeps working (KEEP).
      // The model-facing projection change happens on the NEXT pre-step via
      // maybeApplyContextCompaction (supported surface replace seam).
      evaluateContextCompactionAtCompletion(binding, session).catch((error) => log({ event: 'context-compaction-evaluate-failed', sessionId: session && session.id, taskId: binding.taskId, error: String(error) }))
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
    let epistemicAction = null
    try {
      epistemicAction = await selectEngineeringVerificationAction(binding)
      await attemptEvent(binding, 'verifying')
      const engineeringVerification = await planEngineeringVerification(binding)
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
      await completeEngineeringVerification(
        binding,
        engineeringVerification,
        failed > 0 ? 'fail' : 'pass',
        passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped',
      )
      await completeEngineeringEpistemicAction(binding, epistemicAction && epistemicAction.actionId, failed > 0 ? 'failed' : 'succeeded', passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped')
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
      await completeEngineeringEpistemicAction(binding, epistemicAction && epistemicAction.actionId, 'interrupted', String(error && error.message ? error.message : error)).catch(() => null)
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

  async function automaticallyVerifyVisualTask(session, binding) {
    if (!session || !binding || binding.visualAutoGateRunning) return null
    const latest = latestAttemptOf(binding.workspace, binding.taskId)
    if (!latest || !attemptIsOpen(latest)) return null
    binding.visualAutoGateRunning = true
    try {
      const detection = await detectVisualLoop(binding)
      const required = Boolean(detection && (detection.required === true || (detection.state && detection.state.required === true)))
      if (!required) return detection
      appendMessage(
        session,
        createControllerMessage(
          'Controller: visual verification REQUIRED · task ' + binding.taskId + '. The controller will run deterministic verification and then the automatic VisualLoop. Visual Review is a controller-owned capability; no skill lookup or engineer invocation is required.',
          'controller-visual-required',
        ),
      )
      return executeVerifyTurn({ session }, binding)
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      const state = persistVisualUnavailable(binding, reason)
      appendMessage(
        session,
        createControllerMessage(
          'Controller: automatic visual gate unavailable · task ' + binding.taskId + ' · ' + reason + '. No skill fallback and no fabricated PASS; completion remains blocked' + (state ? ' with visual status unavailable.' : ' until requirement detection can run.'),
          'controller-visual-blocked',
        ),
      )
      log({ event: 'automatic-visual-gate-failed', taskId: binding.taskId, error: reason, statePersisted: Boolean(state) })
      return null
    } finally {
      binding.visualAutoGateRunning = false
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
    // TASK-0009: context-quality guard. When the Context Engine reports that
    // the bundle contains no meaningful source/test/docs/config evidence (even
    // after its one deterministic broaden retry), the reviewer is NOT called:
    // the empty fileSlices plus the structured contextQuality report travel
    // back to executeReviewTurn, which rejects the review turn.
    if (bundle.contextQuality && bundle.contextQuality.status === 'fail') {
      return { contextMode, fileSlices: [], contextQuality: bundle.contextQuality }
    }
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
          requestedEngine: binding.engine,
          reviewRequested: true,
          taskInstanceId,
        })
        binding.executionClass = decision.executionClass
        binding.reviewRequired = Boolean(decision.reviewRequired)
        await markReviewRequested(workspace, taskId, taskInstanceId)
      }
      const { contextMode, fileSlices, contextQuality } = await contextBundle(workspace, taskId, question)
      // TASK-0009: fail closed BEFORE the reviewer when the bundle quality
      // guard rejected the selected evidence. Zero engineer and zero reviewer
      // calls happen on this path; the operator gets a structured reason.
      if (contextQuality && contextQuality.status === 'fail') {
        appendMessage(
          session,
          createControllerMessage(
            'Controller review rejected · task ' + taskId +
              '\nThe reviewer was NOT called: the repository context bundle contained no meaningful source/test/config/docs evidence for this question.' +
              '\nReason: ' + (contextQuality.reason || 'no meaningful evidence selected') +
              '\nNo files were modified; completion authority remains with the controller.',
            'review-context-quality',
          ),
        )
        log({ event: 'review-context-quality', taskId, contextMode, quality: contextQuality })
        return { kind: 'reject' }
      }
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

  // ── Phase V0/V1: controller-owned VISUAL REVIEW (orthogonal capability) ─
  // One manual invocation per turn: bounded visual packet -> ONE multimodal
  // transport call -> validated structured critique -> persisted artifacts.
  // The turn is REJECTED (no model call): the visual reviewer is never a
  // writable subagent, never gains completion authority, and never alters
  // routing/task state (telemetry only, via the controller service).
  async function runVisualReview(workspace, taskId, request, taskInstanceId) {
    // V2: manual /visual-review is an operator override - always trigger=manual,
    // never an automatic loop iteration.
    const args = ['-TaskId', taskId, '-Execute', '-InstallRoot', installRoot, '-Trigger', 'manual']
    if (taskInstanceId) args.push('-TaskInstanceId', taskInstanceId)
    return invokePowerShell('VisualReview.ps1', args, {
      payload: {
        workspace,
        question: request.question,
        platform: request.platform,
        taskInstanceId: taskInstanceId || undefined,
        screenshots: request.screenshots,
        references: request.references,
        invariants: request.invariants,
      },
    })
  }

  function visualReviewResultText(binding, result) {
    const lines = [
      'Controller: visual review complete · task ' + binding.taskId,
      'Verdict: ' + String(result.verdict) + ' · score: ' + String(result.score) + '/10 · model: ' + String(result.model || result.modelId || ''),
      'Findings: ' + (Array.isArray(result.findings) ? result.findings.length : 0) + ' · artifacts: ' + String(result.runDirectory || ''),
    ]
    for (const finding of Array.isArray(result.findings) ? result.findings.slice(0, 8) : []) {
      lines.push('- [' + String(finding.severity) + '] ' + String(finding.area) + ': ' + String(finding.observation) + ' → ' + String(finding.recommendation))
    }
    lines.push('Read-only: true · no code edits returned · human acceptance and completion authority remain with the controller.')
    return lines.join('\n')
  }

  async function executeVisualReviewTurn(agent, binding, request) {
    const session = agent.session
    const taskId = binding.taskId
    const taskInstanceId = binding.taskInstanceId || null
    try {
      if (!Array.isArray(request.screenshots) || request.screenshots.length === 0) {
        appendMessage(
          session,
          createControllerMessage(
            'Controller visual review rejected · task ' + taskId + '\nNo screenshot was supplied. Attach at least one existing PNG/JPEG screenshot path in the /visual-review prompt.\nNothing was modified; completion authority remains with the controller.',
            'visual-review-missing-screenshot',
          ),
        )
        log({ event: 'visual-review-missing-screenshot', taskId })
        return { kind: 'reject' }
      }
      const review = await runVisualReview(binding.workspace, taskId, request, taskInstanceId)
      if (!review || review.ok !== true) {
        const reason = review && review.error ? String(review.error) : 'no structured result'
        const violations = review && Array.isArray(review.violations) && review.violations.length ? review.violations : null
        appendMessage(
          session,
          createControllerMessage(
            'Controller visual review failed · task ' + taskId + '\n' + reason + (violations ? '\nViolations: ' + violations.join('; ') : '') + '\nThe visual reviewer was not given any tool; no files were modified; completion authority remains with the controller.',
            'visual-review-error',
          ),
        )
        log({ event: 'visual-review-failed', taskId, reason, violations })
        return { kind: 'reject' }
      }
      appendMessage(session, createControllerMessage(visualReviewResultText(binding, review), 'visual-review-result'))
      log({ event: 'visual-review-completed', taskId, iteration: review.iteration, verdict: review.verdict, score: review.score })
      return { kind: 'reject' }
    } catch (error) {
      appendMessage(
        session,
        createControllerMessage(
          'Controller visual review failed · task ' + taskId + '\n' + String(error && error.message ? error.message : error) + '\nNo files were modified; completion authority remains with the controller.',
          'visual-review-error',
        ),
      )
      log({ event: 'visual-review-failed', taskId, error: String(error) })
      return { kind: 'reject' }
    }
  }

  async function bindSession(agent, session, workspace, promptText, authoritative) {
    const workspaceIdentity = await resolveWorkspaceIdentity(workspace)
    if (normalizeWorkspaceIdentity(workspaceIdentity.executionRoot) !== normalizeWorkspaceIdentity(workspace)) {
      const error = new Error(`session execution root mismatch: expected '${workspaceIdentity.executionRoot}', actual '${workspace}'`)
      error.code = 'session-workspace-mismatch'
      throw error
    }
    const reviewRequested = isReviewCommand(promptText)
    // TASK-0056: stale recovery carries the ORIGINAL bound engine forward
    // explicitly. A fresh bind (no authoritative identity) selects once from
    // the new session preset; a recovery bind MUST reuse the stale binding's
    // engine/preset and never re-resolve from the mutable preference.
    const preset = authoritative && typeof authoritative.preset === 'string' ? authoritative.preset : agentPresetOf(session)
    const engine = authoritative && typeof authoritative.engine === 'string' ? authoritative.engine : engineForPreset(preset)
    if (!['dual', 'muse'].includes(engine)) {
      const error = new Error(`engine-binding-violation: bound='missing', task='missing', requested='${engineForPreset(preset)}'.`)
      error.code = 'engine-binding-violation'
      throw error
    }
    const task = await createTask(workspace, reviewRequested ? reviewQuestionOf(promptText) : promptText, reviewRequested, engine)
    // TASK-0005 Part 1: every newly created task carries an immutable
    // taskInstanceId from the TaskController; the binding references it.
    const taskInstanceId = task.taskInstanceId ?? null
    const binding = {
      sessionId: session.id,
      taskInstanceId,
      taskId: task.taskId,
      workspace,
      workspaceId: workspaceIdentity.workspaceId,
      repositoryId: workspaceIdentity.repositoryId,
      checkoutId: workspaceIdentity.checkoutId,
      checkoutRootPath: workspaceIdentity.checkoutRootPath,
      executionRoot: workspaceIdentity.executionRoot,
      preset,
      engine,
      description: task.description,
      executionClass: task.executionClass || 'engineer_normal',
      reviewRequired: Boolean(task.reviewRequested),
      needsRouteCheck: true,
      boundAtUtc: new Date().toISOString(),
    }
    // Persist the generation-safe identity before routing. If Route.ps1 fails,
    // the next prompt/restart validates and resumes this same task instead of
    // creating an orphan plus a duplicate replacement task.
    bindings[session.id] = binding
    persistBindings()
    const decision = await routeTask(workspace, task.taskId, task.description, {
      preset,
      requestedEngine: engine,
      reviewRequested,
      taskInstanceId,
    })
    binding.executionClass = decision.executionClass
    binding.reviewRequired = Boolean(decision.reviewRequired)
    binding.needsRouteCheck = false
    await initializeEngineeringLifecycle(binding)
    persistBindings()
    registerShellEnvironment()
    appendMessage(session, createControllerMessage(noticeText(binding), 'controller-binding'))
    log({ event: 'session-bound', sessionId: session.id, taskId: task.taskId, taskInstanceId, engine, executionClass: binding.executionClass })
    return binding
  }

  // Phase M3: the effective agent preset is resolved from the newest
  // agent-preset/selected event (the same authority the isolation layer uses),
  // falling back to the session header. A session recomposed onto another
  // agent plane (the mode selector's only path) must route as the plane it
  // now runs — the stale header alone would dispatch the wrong engine.
  function agentPresetOf(session) {
    try {
      if (Array.isArray(session.events)) {
        for (let index = session.events.length - 1; index >= 0; index -= 1) {
          const event = session.events[index]
          if (event && event.type === 'agent-preset/selected' && event.data && event.data.agentPreset) {
            const selected = String(event.data.agentPreset)
            if (selected === 'aih-engineering' || selected === 'aih-deepseek' || selected === 'aih-muse') return selected
          }
        }
      }
      const header = session.header || {}
      if (header.agentPreset === 'aih-deepseek') return 'aih-deepseek'
      if (header.agentPreset === 'aih-muse') return 'aih-muse'
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
          DSH_AIH_WORKSPACE_ID: { description: 'Nexus Phase 3.1 logical Workspace identity.' },
          DSH_AIH_REPOSITORY_ID: { description: 'Nexus Phase 3.1 logical Repository identity.' },
          DSH_AIH_CHECKOUT_ID: { description: 'Nexus Phase 3.1 physical Checkout identity.' },
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
            DSH_AIH_WORKSPACE_ID: binding.workspaceId || undefined,
            DSH_AIH_REPOSITORY_ID: binding.repositoryId || undefined,
            DSH_AIH_CHECKOUT_ID: binding.checkoutId || undefined,
          }
        },
      })
    } catch (error) {
      log({ event: 'shell-env-register-failed', error: String(error) })
    }
  }

  async function recordEngineeringModelUsage(binding, event) {
    const usage = engineeringUsageOfEvent(event)
    const current = binding && binding.currentEngineeringStep
    if (!usage || !current || !current.role) return null
    const roleTarget = current.roleTarget && typeof current.roleTarget === 'object' ? current.roleTarget : {}
    return invokePowerShell('Engineering.ps1', ['-Action', 'record-model-usage', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        role: current.role,
        milestoneId: usage.stepId || current.stepId || '',
        inputTokens: usage.inputTokens,
        uncachedInputTokens: usage.uncachedInputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        usageAvailable: usage.usageAvailable,
        model: roleTarget.model || '',
        provider: roleTarget.provider || '',
      },
    })
  }

  // ── Context Compaction V1: controller-owned root pressure + post-compaction ──
  // Root pressure counts ONLY root engineering calls (Dual engineer_normal /
  // engineer_deep, Muse muse_main). Reviewer, visual-review, worker/subagent
  // and ambiguous usage are excluded by rootUsageCandidateOf so they can
  // never pollute the compaction metric. Failures here only log (KEEP).
  function rootUsageViewOf(binding, session) {
    const current = binding && binding.currentEngineeringStep
    const role = current && typeof current.role === 'string' ? current.role : null
    const roleTarget = current && current.roleTarget && typeof current.roleTarget === 'object' ? current.roleTarget : {}
    return {
      engine: binding && binding.engine,
      role: binding && binding.engine === 'muse' ? 'muse_main' : role,
      executionClass: binding && binding.executionClass,
      isWorker: contextCompaction.isWorkerSession(session),
      stepId: current && current.stepId ? String(current.stepId) : '',
      model: typeof roleTarget.model === 'string' ? roleTarget.model : '',
      provider: typeof roleTarget.provider === 'string' ? roleTarget.provider : '',
    }
  }

  async function recordContextRootUsage(binding, session, event) {
    const candidate = contextCompaction.rootUsageCandidateOf(event, rootUsageViewOf(binding, session))
    if (!candidate) return null
    const recorded = await invokePowerShell('ContextLifecycleCli.ps1', ['-Action', 'record-root-usage', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        engineRole: candidate.engineRole,
        engine: candidate.engine,
        uncachedInputTokens: candidate.uncachedInputTokens,
        cacheReadTokens: candidate.cacheReadTokens,
        outputTokens: candidate.outputTokens,
        usageAvailable: true,
        model: candidate.model || '',
        provider: candidate.provider || '',
        stepId: candidate.stepId || '',
        sessionId: session && session.id ? String(session.id) : '',
      },
    })
    maybeRecordPostCompactionUsage(binding, session, candidate).catch((error) => log({ event: 'context-post-compaction-record-failed', sessionId: session && session.id, taskId: binding.taskId, error: String(error) }))
    return recorded
  }

  const postCompactionRecordedGenerations = new Set()
  async function maybeRecordPostCompactionUsage(binding, session, candidate) {
    if (!binding || !binding.taskInstanceId) return null
    const generationKey = String(binding.taskId) + '\n' + String(binding.taskInstanceId)
    if (postCompactionRecordedGenerations.has(generationKey)) return null
    const snapshot = await invokePowerShell('ContextLifecycleCli.ps1', ['-Action', 'snapshot', '-TaskId', binding.taskId], {
      payload: { workspace: binding.workspace, taskInstanceId: binding.taskInstanceId || undefined },
    })
    if (!snapshot || snapshot.state !== 'applied') return null
    if (!snapshot.lifecycle || snapshot.lifecycle.taskInstanceId !== binding.taskInstanceId) return null
    const recorded = await invokePowerShell('ContextLifecycleCli.ps1', ['-Action', 'record-post-compaction-usage', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        postCompactionEffectiveInputTokens: candidate.effectiveInputTokens,
        sessionId: session && session.id ? String(session.id) : '',
      },
    })
    postCompactionRecordedGenerations.add(generationKey)
    log({ event: 'context-post-compaction-recorded', sessionId: session && session.id, taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, postCompactionEffectiveInputTokens: candidate.effectiveInputTokens })
    return recorded
  }

  ctx.on('session/event', async (subject, event) => {
    if (!subject || !event) return
    const binding = bindings[subject.id]
    if (!binding) return
    if (engineeringUsageOfEvent(event) && binding.currentEngineeringStep) {
      recordEngineeringModelUsage(binding, event)
        .catch((error) => log({ event: 'engineering-usage-record-failed', sessionId: subject.id, taskId: binding.taskId, error: String(error) }))
    }
    if (event && event.type === 'assistant/chunk') {
      recordContextRootUsage(binding, subject, event)
        .catch((error) => log({ event: 'context-root-usage-record-failed', sessionId: subject.id, taskId: binding.taskId, error: String(error) }))
    }
    if (event.type === 'turn/end' && event.data && event.data.reason) {
      const reason = event.data.reason
      const completedEngineeringStep = Boolean(binding.currentEngineeringStep && binding.currentEngineeringStep.role)
      if (reason.kind === 'error' && reason.error && reason.error.message) {
        const actionId = binding.currentEpistemicActionId
        binding.currentEpistemicActionId = null
        completeEngineeringEpistemicAction(binding, actionId, 'failed', String(reason.error.message), 'turn-error')
          .catch((error) => log({ event: 'epistemic-action-complete-failed', sessionId: subject.id, error: String(error) }))
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
          requestedEngine: binding.engine,
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
        const actionId = binding.currentEpistemicActionId
        binding.currentEpistemicActionId = null
        completeEngineeringEpistemicAction(binding, actionId, 'interrupted', 'turn-' + reason.kind)
          .catch((error) => log({ event: 'epistemic-action-complete-failed', sessionId: subject.id, error: String(error) }))
        // TASK-0004: a user abort or system interrupt closes the open attempt
        // as interrupted (smallest truthful state) instead of leaving it open.
        const latest = latestAttemptOf(binding.workspace, binding.taskId)
        if (latest && attemptIsOpen(latest)) {
          attemptEvent(binding, 'interrupted', { reason: 'turn-' + reason.kind })
            .then(() => log({ event: 'attempt-interrupted-recorded', sessionId: subject.id, taskId: binding.taskId }))
            .catch((error) => log({ event: 'attempt-interrupt-record-failed', sessionId: subject.id, error: String(error) }))
        }
      } else {
        const actionId = binding.currentEpistemicActionId
        binding.currentEpistemicActionId = null
        await completeEngineeringEpistemicAction(binding, actionId, 'succeeded', 'engineering turn completed')
          .catch((error) => log({ event: 'epistemic-action-complete-failed', sessionId: subject.id, error: String(error) }))
      }
      binding.currentEngineeringStep = null
      if (completedEngineeringStep && reason.kind !== 'error' && reason.kind !== 'aborted' && reason.kind !== 'interrupted') {
        await automaticallyVerifyVisualTask(subject, binding)
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
          return agentPresetOf(session) === 'aih-muse' ? { kind: 'reject' } : next()
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

      try {
        assertEngineBinding(binding, agentPresetOf(session))
      } catch (error) {
        appendMessage(
          session,
          createControllerMessage(
            'Controller blocked execution: ' + String(error.message || error) + '\nThe existing task remains bound to engine=' + String(binding.engine || 'missing') + '. Start a new explicitly selected session to use another engine. No model call was made.',
            'engine-binding-violation',
          ),
        )
        log({ event: 'engine-binding-violation', sessionId: session.id, taskId: binding.taskId, boundEngine: binding.engine || null, requestedPreset: agentPresetOf(session) })
        return { kind: 'reject' }
      }

      if (explicitReview) {
        // Phase M3: the Muse engine has NO independent reviewer (profile
        // review.independent=false). The request fails closed truthfully:
        // Codex is never invoked from Muse as reviewer, fallback, repair
        // agent, or worker, and no Muse reviewer exists.
        if (binding.engine === 'muse') {
          appendMessage(
            session,
            createControllerMessage(
              'Controller: independent review is not available for the Muse engine (engine=muse, review.independent=false).\n' +
                'The Muse plane never invokes Codex as reviewer, fallback, repair agent, or worker, and no Muse reviewer exists in V0.\n' +
                'Route the task through a Dual profile (Normal Engineering + GLM/Codex or DeepSeek/Codex) for independent review. No files were modified.',
              'muse-review-unavailable',
            ),
          )
          log({ event: 'muse-review-unavailable', sessionId: session.id, taskId: binding.taskId })
          return { kind: 'reject' }
        }
        return executeReviewTurn(agent, binding, reviewQuestionOf(promptText), { explicit: true })
      }

      if (isVisualReviewCommand(promptText)) {
        return executeVisualReviewTurn(agent, binding, visualReviewRequestOf(promptText, binding.workspace))
      }

      if (isVerifyCommand(promptText)) {
        return executeVerifyTurn(agent, binding)
      }

      // Context Compaction V1: if the bound generation completed earlier with
      // a ready checkpoint, apply the model-facing projection change now
      // (supported surface replace; raw log untouched). Never blocks the
      // turn: any failure keeps the old context and execution continues.
      try {
        await maybeApplyContextCompaction(session, binding, agent)
      } catch (error) {
        log({ event: 'context-compaction-pre-step-failed', sessionId: session.id, taskId: binding.taskId, error: String(error) })
      }
      // Track the latest user prompt for checkpoint continuity (bounded use).
      binding.lastUserPrompt = String(promptText).slice(0, 2000)

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
          requestedEngine: binding.engine,
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
        const decision = await routeTask(binding.workspace, binding.taskId, promptText, { preset: binding.preset, requestedEngine: binding.engine, taskInstanceId: binding.taskInstanceId || undefined })
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
        binding.reviewRequired = Boolean(decision.reviewRequired)
        binding.needsRouteCheck = false
        persistBindings()
      }

      // Engineering turns own the attempt lifecycle: one execution = exactly
      // one attempt. Reload/reconnect/restart never adds an attempt — the
      // ledger's open-attempt guard is authoritative and the durable turn
      // identity (startedByTurn) makes the same execution idempotent.
      const latest = latestAttemptOf(binding.workspace, binding.taskId)
      if (!latest || !attemptIsOpen(latest)) {
        const nextSequence = latest ? latest.sequence + 1 : 1
        // Phase 3.2.5: the step role for THIS turn (deterministic; Normal is
        // the default; Deep only through the structured escalation gate).
        let stepRole = null
        // Phase M3: the Muse engine runs exactly ONE main agent with NO Dual
        // role semantics. The epistemic step router is a Dual-plane authority
        // (it selects engineer roles and step role targets) and never applies
        // to a muse session: stepRole stays null and the attempt runs on the
        // task-level execution class (muse_main) resolved by routing.
        const museEngine = binding.engine === 'muse'
        try {
          const stepDecision = museEngine ? null : await selectEngineeringEpistemicStep(binding, payload.turn, promptText)
          if (stepDecision) {
            stepRole = stepDecision.selectedRole
            binding.currentEpistemicActionId = stepDecision.actionId || null
            binding.currentEngineeringStep = {
              role: stepRole,
              stepId: stepDecision.step && stepDecision.step.stepId ? String(stepDecision.step.stepId) : String(payload.turn ?? ''),
              roleTarget: stepDecision.roleTarget || (stepDecision.step && stepDecision.step.roleTarget) || null,
              selectedAction: stepDecision.selectedAction || null,
            }
            const candidates = stepDecision.retrieval && Array.isArray(stepDecision.retrieval.candidates) ? stepDecision.retrieval.candidates : []
            const paths = candidates.map((item) => item && item.file ? String(item.file) : '').filter(Boolean).slice(0, 8)
            const retrievalLine = stepDecision.selectedAction === 'retrieve'
              ? '\nRepository evidence preload: ' + (stepDecision.retrievalError
                  ? 'FAILED (' + stepDecision.retrievalError + '); structured retrieval remains available to Engineer Normal.'
                  : String(candidates.length) + ' candidate(s)' + (paths.length ? ' · ' + paths.join(', ') : '') + '.')
              : ''
            appendMessage(
              session,
              createControllerMessage(
                'Controller epistemic action: ' + String(stepDecision.selectedAction || 'reason').toUpperCase() + ' · ' + String(stepDecision.selectionReason || '') + '\nEngineering role: ' + executionClassLabel(stepRole) + '.' + retrievalLine,
                'controller-epistemic-action',
              ),
            )
          }
        } catch (error) {
          log({ event: 'step-routing-failed', sessionId: session.id, taskId: binding.taskId, error: String(error) })
        }
        try {
          await beginAttempt(binding, payload.turn, stepRole)
          appendMessage(
            session,
            createControllerMessage(
              'Controller: attempt ' + nextSequence + ' started · task ' + binding.taskId + ' (execution ' + executionClassLabel(stepRole || binding.executionClass) + (museEngine ? ' · engine=muse' : ' · step-routed') + ').',
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
      const agent = payload && payload.agent
      const session = agent && agent.session
      log({
        event: 'pre-step-error',
        sessionId: session && session.id ? session.id : null,
        preset: session ? agentPresetOf(session) : null,
        error: boundedControllerDiagnostic(message),
        ...(error && error.cliFailure ? { cliFailure: error.cliFailure } : {}),
      })
      if (error && error.code === 'engine-binding-violation') {
        if (session) {
          appendMessage(
            session,
            createControllerMessage(
              'Controller blocked execution: ' + message + '\nThe persisted session/task engine identity did not match the requested engine. Start a new explicitly selected session to use another engine. No model call was made.',
              'engine-binding-violation',
            ),
          )
        }
        return { kind: 'reject' }
      }
      if (error && (error.code === 'session-workspace-mismatch' || error.code === 'repository-identity-mismatch' || error.code === 'repository-identity-missing' || error.code === 'session-workspace-identity-unavailable')) {
        if (session) {
          appendMessage(
            session,
            createControllerMessage(
              'Controller blocked execution: the session workspace identity could not be proven.\n' + message + '\nNo model or tool execution was allowed. Reopen the registered checkout or create a new conversation from the intended workspace.',
              'controller-workspace-error',
            ),
          )
        }
        return { kind: 'reject' }
      }
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
      // A Muse request without controller state must stop here. Continuing to
      // agent/request only replaces the useful controller failure with the
      // secondary Muse-Isolation error `missing-session-binding`.
      const musePlane = session && agentPresetOf(session) === 'aih-muse'
      if (session && promptText) {
        appendMessage(
          session,
          createControllerMessage(
            'Controller: task binding failed for this session.\n' + boundedControllerDiagnostic(message) + (musePlane
              ? '\nMuse execution was blocked before model request; no fallback was attempted.'
              : '\nThe session continues without controller routing; controller state was not recorded.'),
            'controller-error',
          ),
        )
      }
      return musePlane ? { kind: 'reject' } : next()
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
module.exports.isVisualReviewCommand = isVisualReviewCommand
module.exports.visualReviewRequestOf = visualReviewRequestOf
module.exports.classifyEpistemicPrompt = classifyEpistemicPrompt
module.exports.engineeringUsageOfEvent = engineeringUsageOfEvent
module.exports.textOf = textOf
module.exports.isUserPrompt = isUserPrompt
module.exports.userPromptMessages = userPromptMessages
module.exports.executionClassLabel = executionClassLabel
module.exports.canonicalExecutionClass = canonicalExecutionClass
module.exports.isReviewClass = isReviewClass
module.exports.contextCompactionForTest = contextCompaction
module.exports.isWorkerAgent = isWorkerAgent
module.exports.createControllerMessage = createControllerMessage
module.exports.parseCliJson = parseCliJson
module.exports.normalizeWorkspaceIdentity = normalizeWorkspaceIdentity
module.exports.createSingleFlight = createSingleFlight
module.exports.classifyBindingWorkspace = classifyBindingWorkspace
module.exports.classifyBindingRepositoryIdentity = classifyBindingRepositoryIdentity
module.exports.classifyBindingIdentity = classifyBindingIdentity
module.exports.engineForPreset = engineForPreset
module.exports.assertEngineBinding = assertEngineBinding
module.exports.createBindingGuard = createBindingGuard
module.exports.structuredCliStdout = structuredCliStdout
module.exports.verificationCliStdout = verificationCliStdout
module.exports.controllerCliFailure = controllerCliFailure
module.exports.redactControllerDiagnostic = redactControllerDiagnostic
module.exports.referencedFilesOf = referencedFilesOf
module.exports.hasInlineCode = hasInlineCode
module.exports.resolveReviewFiles = resolveReviewFiles
module.exports.classifyReviewContext = classifyReviewContext
module.exports.reviewBudgetPolicy = reviewBudgetPolicy
module.exports.reviewResultText = reviewResultText
