'use strict'

/**
 * @nexus/controller — read-only controller-state adapter (pure layer).
 *
 * Normalizes REAL Nexus controller state (task ledger, session bindings,
 * routing state, routing decisions, launcher state, git) into one small
 * structured snapshot for the Nexus Controller Panel. This module is
 * deliberately free of plugin/runtime concerns: every read is injected
 * (readFile / gitSummary), every parse is fail-closed (corrupt or missing
 * files degrade to null), and nothing here ever writes a byte. The host
 * plugin (lib/index.js) wires real IO; tests wire fixtures.
 *
 * Authoritative sources (in priority order per field):
 *   session -> task binding : data/routing/session-bindings.json
 *   task record             : <workspace>/.ai-harness/state/tasks.json
 *   live execution class    : data/routing/states/<hash>.json (persisted on
 *                             every routing decision; the in-memory binding
 *                             copy is only persisted at session teardown)
 *   executor provider/model : data/routing/decisions.jsonl (last record)
 *   model display names     : data/settings.yaml (llm-pi-ai providers)
 *   controller process      : data/aih-state.json
 *   git summary             : read-only git commands on the workspace
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

/** Display states — the smallest truthful set mapped from real Nexus state. */
const DISPLAY_STATES = [
  'idle', 'starting', 'working', 'verifying', 'reviewing',
  'repairing', 'waiting', 'complete', 'failed',
]

/** Default file reader (UTF-8). */
function defaultReadFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/** Read + parse JSON; any failure degrades to null (fail-closed). */
function readJson(filePath, readFile = defaultReadFile) {
  if (!filePath) return null
  try {
    const text = readFile(filePath)
    if (typeof text !== 'string' || text.trim() === '') return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Read a text file as a string, or '' on any failure. */
function readJsonSafeText(filePath, readFile) {
  if (!filePath) return ''
  try {
    const text = readFile(filePath)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * Normalize a workspace path for IDENTITY COMPARISON ONLY — never for
 * display and never for filesystem access (TASK-0003.2 isolation). The
 * normalization is deterministic and IO-free:
 *   - forward slashes become backslashes and redundant separators collapse
 *   - trailing separators are trimmed (a drive root like `C:\` is kept)
 *   - comparison is case-insensitive (Windows path semantics)
 * It deliberately does NOT resolve `..`/`.` segments, does not touch the
 * filesystem, and never treats prefix-related paths as equal:
 * `C:\Repo` != `C:\Repo2`, `C:\AI-Harness` != `C:\AI-Harness\tests`.
 */
function normalizeWorkspacePath(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return ''
  let normalized = workspace.replace(/[\\/]+/g, '\\')
  while (normalized.length > 3 && normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized.toLowerCase()
}

/** The routing-state file name mirroring Routing.ps1 Get-AihRoutingStatePath. */
function routingStateFileName(workspace, preset, taskId) {
  const normalized = path.resolve(String(workspace || '')).toLowerCase()
  const key = normalized + '\n' + String(preset || 'aih-engineering').toLowerCase() + '\n' + String(taskId || '')
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex')
  return hash + '.json'
}

/** Session bindings document -> { sessionId: binding } map. */
function bindingsOf(document) {
  if (!document || typeof document !== 'object') return {}
  const raw = document.bindings && typeof document.bindings === 'object'
    ? document.bindings
    : (document.schemaVersion === undefined ? document : {})
  const out = {}
  for (const [sessionId, binding] of Object.entries(raw)) {
    if (binding && typeof binding === 'object') out[sessionId] = binding
  }
  return out
}

/** Parse a JSON-lines document into records; corrupt lines are skipped. */
function jsonLinesOf(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const records = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* skip corrupt line */
    }
  }
  return records
}

/**
 * Last routing decision record for a task inside ONE workspace namespace
 * (decisions.jsonl). taskId is NOT globally unique (TASK-0003 lives in
 * several workspaces), so a record joins ONLY when BOTH identities match:
 *   normalizeWorkspacePath(record.workspace) === normalizeWorkspacePath(workspace)
 *   AND record.taskId === taskId
 * A missing workspace on either side never matches (fail-closed) — the
 * old taskId-only join made correctness depend on record ordering.
 * The Executor must be the model that OWNS primary execution. Review and
 * escalation decisions carry "escalatedFrom" (e.g. a later Codex/Sol
 * review) and must NOT replace the primary route merely because their
 * record is newer. Among primary decisions the newest wins; if only
 * escalations exist (edge), the last record is used as a fail-closed
 * best effort.
 */
function lastDecisionOf(records, taskId, workspace) {
  if (!Array.isArray(records)) return null
  const normalizedWorkspace = normalizeWorkspacePath(workspace)
  if (normalizedWorkspace === '') return null
  let primary = null
  let fallback = null
  for (const record of records) {
    if (!record || record.taskId !== taskId) continue
    if (normalizeWorkspacePath(record.workspace) !== normalizedWorkspace) continue
    fallback = record
    const escalatedFrom = record.escalatedFrom
    if (escalatedFrom === undefined || escalatedFrom === null || escalatedFrom === '') {
      primary = record
    }
  }
  return primary || fallback
}

/**
 * Normalize the task ledger record into the panel shape. Only fields the
 * panel displays are carried; both PascalCase (PowerShell) and camelCase
 * spellings are accepted for nested verification fields.
 */
function normalizeTaskRecord(task) {
  if (!task || typeof task !== 'object') return null
  const verification = task.verification && typeof task.verification === 'object' ? task.verification : {}
  const outcomes = Array.isArray(verification.outcomes) ? verification.outcomes : []
  const checks = outcomes
    .map((outcome) => {
      if (!outcome || typeof outcome !== 'object') return null
      const name = outcome.name ?? outcome.Name
      const status = String(outcome.status ?? outcome.Status ?? 'PASS').toUpperCase()
      if (typeof name !== 'string' || name === '') return null
      return { name, status }
    })
    .filter(Boolean)
  const passed = checks.filter((check) => check.status === 'PASS').length
  const failed = checks.filter((check) => check.status === 'FAIL').length
  const skipped = checks.filter((check) => check.status === 'SKIP').length
  let verificationStatus = 'not-run'
  if (checks.length > 0) {
    verificationStatus = failed > 0 ? (passed > 0 ? 'partial' : 'failed') : 'passed'
  }
  const failureSignatures = Array.isArray(task.failureSignatures) ? task.failureSignatures.map(String) : []
  return {
    taskId: String(task.taskId ?? ''),
    description: typeof task.description === 'string' ? task.description : '',
    status: String(task.status ?? ''),
    attempt: Number.isInteger(task.attempt) ? task.attempt : (Number(task.attempt) || 0),
    maxAttempts: Number.isInteger(task.maxAttempts) ? task.maxAttempts : null,
    baseCommit: task.baseCommit ? String(task.baseCommit) : null,
    worktree: task.worktree ? String(task.worktree) : null,
    reviewRequested: Boolean(task.reviewRequested),
    codexCalls: Number.isInteger(task.codexCalls) ? task.codexCalls : (Number(task.codexCalls) || 0),
    failureSignatures,
    failureSignature: failureSignatures.length > 0 ? failureSignatures[failureSignatures.length - 1] : null,
    createdAtUtc: task.createdAtUtc ? String(task.createdAtUtc) : null,
    updatedAtUtc: task.updatedAtUtc ? String(task.updatedAtUtc) : null,
    completedAtUtc: task.completedAtUtc ? String(task.completedAtUtc) : null,
    verification: {
      status: verificationStatus,
      passed,
      failed,
      skipped,
      total: checks.length,
      checks,
      required: Array.isArray(verification.required) ? verification.required.map(String) : [],
    },
  }
}

/**
 * File-derived controller state (no live session signal). The client folds
 * the session's live `running` flag in via deriveDisplayState.
 */
function deriveFileState(binding, task) {
  if (!binding) return 'idle'
  if (!task) return 'starting'
  const status = task.status
  const executionClass = typeof binding.executionClass === 'string' ? binding.executionClass : ''
  if (status === 'failed') return 'failed'
  if (status === 'complete') return 'complete'
  if (status === 'verifying') return 'verifying'
  if (status === 'implementing' || status === 'ready') {
    // GUI sessions never call begin-attempt, so a live task stays 'ready'
    // through its whole turn; both map to the working family.
    if (executionClass === 'codex_review') return 'reviewing'
    if (executionClass === 'deepseek_deep') return 'repairing'
    return 'working'
  }
  return 'working'
}

/**
 * Final display state: while the bound session is not actively running, every
 * non-terminal state reads as WAITING (the controller is between actions).
 * 'verifying' stays as-is because deterministic verification runs through the
 * CLI, outside the agent loop, so the session flag is not its signal.
 */
function deriveDisplayState(fileState, running) {
  if (fileState === 'idle' || fileState === 'failed' || fileState === 'complete') return fileState
  if (fileState === 'verifying') return 'verifying'
  if (running === true) return fileState
  return 'waiting'
}

/** Prettify a model id when no display name is configured. */
function prettyModelId(modelId) {
  if (typeof modelId !== 'string' || modelId === '') return null
  const tokens = modelId.split('-').map((token) => {
    if (/^[0-9.]+$/.test(token)) return token
    if (token.length <= 3) return token.toUpperCase()
    if (token.toLowerCase() === 'deepseek') return 'DeepSeek'
    return token.charAt(0).toUpperCase() + token.slice(1)
  })
  return tokens.join(' ')
}

/** Display name for a provider/model pair from the settings model map. */
function modelNameOf(provider, modelId, modelNames) {
  if (modelNames && typeof modelNames === 'object') {
    const direct = modelNames[String(provider) + '/' + String(modelId)]
    if (typeof direct === 'string' && direct !== '') return direct
  }
  return prettyModelId(modelId)
}

/**
 * Parse the `agent-default-model` block of data/settings.yaml — the
 * session PREFERENCE written by the mode seat (ControlRoom.ps1) from the
 * preset's rootExecutor. Fail-closed: any malformed/missing block yields
 * null; the preference is display metadata only and never changes routing.
 * The block is a flat 3-key YAML mapping:
 *
 *   agent-default-model:
 *     provider: flash-max-direct
 *     model: deepseek-v4-flash
 *     reasoningEffort: max
 */
function parseDefaultModel(settingsText) {
  if (typeof settingsText !== 'string' || settingsText === '') return null
  const lines = settingsText.split(/\r?\n/)
  let inBlock = false
  let result = null
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    const indent = line.match(/^\s*/)[0].length
    if (!inBlock) {
      if (/^\s*agent-default-model:\s*$/.test(line)) { inBlock = true; result = {} }
      continue
    }
    if (indent === 0 && line !== '') break
    const match = /^\s*([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    const value = match[2].replace(/^['"]|['"]$/g, '').trim()
    if (key === 'provider') result.provider = value
    else if (key === 'model') result.model = value
    else if (key === 'reasoningEffort') result.reasoningEffort = value
  }
  if (!result || typeof result.provider !== 'string' || result.provider === '' ||
      typeof result.model !== 'string' || result.model === '') return null
  return result
}

/**
 * Normalize the parsed default-model selection into the snapshot's
 * preference block (label via the settings display-name map, same source
 * the composer model chip renders). Null when the selection is unknown.
 */
function normalizePreference(defaultModel, modelNames) {
  if (!defaultModel || typeof defaultModel !== 'object') return null
  const provider = String(defaultModel.provider || '')
  const modelId = String(defaultModel.model || '')
  if (provider === '' || modelId === '') return null
  const reasoning = defaultModel.reasoningEffort ? String(defaultModel.reasoningEffort) : null
  return {
    provider,
    modelId,
    reasoning,
    label: modelNameOf(provider, modelId, modelNames),
  }
}

/** Build the normalized executor block. */
function normalizeExecution(binding, task, routingState, decision, modelNames) {
  if (!binding) return null
  const provider = decision && decision.provider ? String(decision.provider) : null
  const modelId = decision && decision.model ? String(decision.model) : null
  const reasoning = decision && decision.reasoning ? String(decision.reasoning) : null
  const executionClass = routingState && routingState.executionClass
    ? String(routingState.executionClass)
    : (typeof binding.executionClass === 'string' ? binding.executionClass : null)
  return {
    class: executionClass,
    provider,
    model: modelNameOf(provider, modelId, modelNames),
    modelId,
    reasoning,
    reviewRequired: Boolean(
      (routingState && routingState.reviewRequired) ||
      (task && task.reviewRequested) ||
      binding.reviewRequired,
    ),
    sameFailureCount: routingState && Number.isInteger(routingState.sameFailureCount)
      ? routingState.sameFailureCount
      : 0,
    escalatedFrom: decision && decision.escalatedFrom ? String(decision.escalatedFrom) : null,
    routedAtUtc: routingState && routingState.updatedAtUtc ? String(routingState.updatedAtUtc) : null,
  }
}

/** Parse `git status --porcelain=v1` output into file counts. */
function parsePorcelainStatus(lines) {
  let modified = 0
  let added = 0
  let deleted = 0
  let renamed = 0
  let untracked = 0
  let other = 0
  for (const line of lines) {
    if (line.length < 3) continue
    const flags = line.slice(0, 2)
    const isUntracked = flags === '??'
    if (isUntracked) untracked += 1
    else if (flags[0] === 'M' || flags[1] === 'M') modified += 1
    else if (flags[0] === 'A' || flags[1] === 'A') added += 1
    else if (flags[0] === 'D' || flags[1] === 'D') deleted += 1
    else if (flags[0] === 'R' || flags[1] === 'R') renamed += 1
    else other += 1
  }
  return { modified, added, deleted, renamed, untracked, other }
}

/** Parse `git diff --numstat HEAD` output into insertion/deletion sums. */
function parseNumstat(lines) {
  let insertions = 0
  let deletions = 0
  let files = 0
  for (const line of lines) {
    const match = /^([0-9-]+)\t([0-9-]+)\t/.exec(line)
    if (!match) continue
    files += 1
    if (match[1] !== '-') insertions += Number(match[1]) || 0
    if (match[2] !== '-') deletions += Number(match[2]) || 0
  }
  return { insertions, deletions, files }
}

/**
 * Run one git command, returning trimmed stdout lines or null on failure.
 * @param exec - (command, args, options) => Promise<{stdout}> (defaults to execFile).
 */
async function runGit(exec, workspace, args) {
  if (!exec || !workspace) return null
  try {
    const result = await exec('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    const stdout = typeof result === 'string' ? result : (result && result.stdout) || ''
    return String(stdout).split(/\r?\n/).filter((line) => line.trim() !== '')
  } catch {
    return null
  }
}

const DEFAULT_EXEC = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout) => {
    if (error) reject(error)
    else resolve({ stdout })
  })
})

/**
 * Read-only git summary for a workspace. Runs at most two git commands;
 * every failure degrades to null (no git binary, not a repository, ...).
 */
async function collectGitSummary(workspace, exec = DEFAULT_EXEC) {
  if (!workspace) return null
  const [branchLines, statusLines, numstatLines] = await Promise.all([
    runGit(exec, workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(exec, workspace, ['status', '--porcelain=v1']),
    runGit(exec, workspace, ['diff', '--numstat', 'HEAD']),
  ])
  if (branchLines === null && statusLines === null && numstatLines === null) return null
  const counts = parsePorcelainStatus(statusLines ?? [])
  const numstat = parseNumstat(numstatLines ?? [])
  const filesChanged = numstat.files > 0
    ? numstat.files + counts.untracked
    : (counts.modified + counts.added + counts.deleted + counts.renamed + counts.untracked)
  return {
    branch: branchLines && branchLines.length > 0 ? branchLines[0] : null,
    filesChanged,
    insertions: numstatLines !== null ? numstat.insertions : null,
    deletions: numstatLines !== null ? numstat.deletions : null,
    modified: counts.modified,
    added: counts.added,
    deleted: counts.deleted,
    renamed: counts.renamed,
    untracked: counts.untracked,
  }
}

/**
 * Assemble the complete normalized snapshot for one session.
 *
 * @param options.dataRoot - the harness data directory (DSH_HOME).
 * @param options.sessionId - the browser session id.
 * @param options.settingsPath - data/settings.yaml path (model names; kept for
 *   signature symmetry with the host plugin, modelNames may be pre-parsed).
 * @param options.statePath - data/aih-state.json path (launcher state).
 * @param options.readFile - injected UTF-8 file reader.
 * @param options.modelNames - pre-parsed { provider/model: displayName } map.
 * @param options.gitSummary - async (workspace) => git summary or null.
 * @param options.nowUtc - clock injection for tests.
 */
async function buildControllerSnapshot(options) {
  const {
    dataRoot,
    sessionId,
    settingsPath,
    statePath,
    readFile = defaultReadFile,
    modelNames = {},
    gitSummary = null,
    nowUtc = () => new Date().toISOString(),
  } = options || {}
  const generatedAtUtc = nowUtc()
  const bindingsDocument = readJson(path.join(dataRoot, 'routing', 'session-bindings.json'), readFile)
  const bindings = bindingsOf(bindingsDocument)
  const binding = sessionId ? (bindings[sessionId] || null) : null
  // Session PREFERENCE (agent-default-model) is binding-independent: it is
  // display metadata the composer chip already renders; the snapshot carries
  // it so the pill can label the preference truthfully even when no task is
  // bound. Never consulted for routing.
  const defaultModel = settingsPath
    ? parseDefaultModel(readJsonSafeText(settingsPath, readFile))
    : null

  let task = null
  let routingState = null
  let decision = null
  let git = null

  if (binding) {
    const workspace = typeof binding.workspace === 'string' ? binding.workspace : null
    const taskId = typeof binding.taskId === 'string' ? binding.taskId : null
    const preset = typeof binding.preset === 'string' ? binding.preset : 'aih-engineering'
    if (taskId) {
      const ledger = readJson(path.join(workspace || '', '.ai-harness', 'state', 'tasks.json'), readFile)
      if (ledger && Array.isArray(ledger.tasks)) {
        for (const candidate of ledger.tasks) {
          if (candidate && candidate.taskId === taskId) { task = candidate; break }
        }
      }
      if (workspace) {
        const stateFileName = routingStateFileName(workspace, preset, taskId)
        routingState = readJson(path.join(dataRoot, 'routing', 'states', stateFileName), readFile)
        const decisionsText = readJsonSafeText(path.join(dataRoot, 'routing', 'decisions.jsonl'), readFile)
        decision = lastDecisionOf(jsonLinesOf(decisionsText), taskId, workspace)
      }
      if (gitSummary && workspace) {
        try { git = await gitSummary(workspace) } catch { git = null }
      }
    }
  }

  const controller = readJson(statePath, readFile)
  const taskRecord = normalizeTaskRecord(task)

  return {
    schemaVersion: 1,
    generatedAtUtc,
    state: deriveFileState(binding, taskRecord),
    binding: binding ? {
      sessionId: String(binding.sessionId ?? sessionId),
      taskId: String(binding.taskId ?? ''),
      workspace: typeof binding.workspace === 'string' ? binding.workspace : null,
      preset: typeof binding.preset === 'string' ? binding.preset : null,
      executionClass: typeof binding.executionClass === 'string' ? binding.executionClass : null,
      reviewRequired: Boolean(binding.reviewRequired),
      boundAtUtc: binding.boundAtUtc ? String(binding.boundAtUtc) : null,
    } : null,
    task: taskRecord,
    preference: normalizePreference(defaultModel, modelNames),
    execution: normalizeExecution(binding, taskRecord, routingState, decision, modelNames),
    review: binding ? {
      codexCalls: taskRecord ? taskRecord.codexCalls : 0,
      reviewRequested: taskRecord ? taskRecord.reviewRequested : Boolean(binding.reviewRequired),
      required: Boolean(
        (routingState && routingState.reviewRequired) ||
        (taskRecord && taskRecord.reviewRequested) ||
        binding.reviewRequired,
      ),
    } : null,
    controller: controller && typeof controller === 'object' ? {
      status: controller.Status ? String(controller.Status) : null,
      pid: Number.isInteger(controller.Pid) ? controller.Pid : null,
      workspace: controller.Workspace ? String(controller.Workspace) : null,
      startedAtUtc: controller.ProcessStartedAtUtc ? String(controller.ProcessStartedAtUtc) : null,
      updatedAtUtc: controller.UpdatedAtUtc ? String(controller.UpdatedAtUtc) : null,
    } : null,
    git,
  }
}

module.exports = {
  DISPLAY_STATES,
  normalizeWorkspacePath,
  parseDefaultModel,
  normalizePreference,
  defaultReadFile,
  readJson,
  routingStateFileName,
  bindingsOf,
  lastDecisionOf,
  jsonLinesOf,
  normalizeTaskRecord,
  deriveFileState,
  deriveDisplayState,
  prettyModelId,
  modelNameOf,
  normalizeExecution,
  parsePorcelainStatus,
  parseNumstat,
  runGit,
  collectGitSummary,
  buildControllerSnapshot,
}
