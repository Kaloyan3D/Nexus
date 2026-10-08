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

// Phase 2.2: the composer's Engineering selector derives the PREFERRED
// engineer (profile -> primaryEngineer -> registry) from the SAME resolver
// the Engineering editor state uses — never a second compatibility rule set.
const engineeringProfiles = require('./engineering.cjs')

/** Display states — the smallest truthful set mapped from real Nexus state. */
const DISPLAY_STATES = [
  'idle', 'starting', 'working', 'verifying', 'reviewing',
  'repairing', 'waiting', 'complete', 'failed',
]

// Phase 2: execution classes describe semantics, not model identity.
// Legacy names (deepseek_normal / deepseek_deep / codex_review / codex_solve)
// stay readable in old records and are normalized for display and state
// derivation; historical records are never rewritten.
const EXECUTION_CLASS_ALIASES = {
  deepseek_normal: 'engineer_normal',
  deepseek_deep: 'engineer_deep',
  codex_review: 'reviewer',
  codex_solve: 'solver',
}
const EXECUTION_CLASS_DISPLAY = {
  deterministic: 'Deterministic',
  engineer_normal: 'Engineer Normal',
  engineer_deep: 'Engineer Deep',
  reviewer: 'Independent Review',
  solver: 'Solve',
}
const EXECUTION_CLASS_ROLES = {
  deterministic: null,
  engineer_normal: 'primaryEngineer',
  engineer_deep: 'deepEngineer',
  reviewer: 'reviewer',
  solver: 'solver',
}

function canonicalExecutionClass(executionClass) {
  if (typeof executionClass !== 'string' || executionClass === '') return executionClass
  const key = executionClass.trim().toLowerCase()
  return EXECUTION_CLASS_ALIASES[key] || key
}

function executionClassDisplayName(executionClass) {
  return EXECUTION_CLASS_DISPLAY[canonicalExecutionClass(executionClass)] || executionClass
}

function roleOfExecutionClass(executionClass) {
  return EXECUTION_CLASS_ROLES[canonicalExecutionClass(executionClass)] || null
}

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

/**
 * The routing-state file name mirroring Routing.ps1 Get-AihRoutingStatePath.
 * TASK-0005 Part 14: when a taskInstanceId is supplied the file is keyed by
 * normalized workspace + preset + taskInstanceId — two lifecycle generations
 * of one display id read DIFFERENT state files. Legacy tasks (no instance)
 * keep the workspace+taskId compatibility key.
 */
function routingStateFileName(workspace, preset, taskId, taskInstanceId) {
  const resolved = path.resolve(String(workspace || ''))
  // Match Get-AihRoutingStatePath: Windows folds case; POSIX paths retain it.
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const identity = (typeof taskInstanceId === 'string' && taskInstanceId !== '') ? taskInstanceId : String(taskId || '')
  const key = normalized + '\n' + String(preset || 'aih-engineering').toLowerCase() + '\n' + identity
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
function lastDecisionOf(records, taskId, workspace, taskInstanceId) {
  if (!Array.isArray(records)) return null
  const normalizedWorkspace = normalizeWorkspacePath(workspace)
  if (normalizedWorkspace === '') return null
  // TASK-0005 Part 15/20: for a task WITH an immutable taskInstanceId only
  // records carrying THAT exact instance join; legacy taskId-only records are
  // NEVER mixed into an instance-aware task's execution state (that fallback
  // would recreate the cross-generation contamination bug). When no instance
  // is expected (legacy task), the historical workspace+taskId join applies.
  const expectedInstance = (typeof taskInstanceId === 'string' && taskInstanceId !== '') ? taskInstanceId : null
  let primary = null
  let fallback = null
  for (const record of records) {
    if (!record || record.taskId !== taskId) continue
    if (normalizeWorkspacePath(record.workspace) !== normalizedWorkspace) continue
    if (expectedInstance !== null) {
      if (typeof record.taskInstanceId !== 'string' || record.taskInstanceId !== expectedInstance) continue
    }
    fallback = record
    const escalatedFrom = record.escalatedFrom
    if (escalatedFrom === undefined || escalatedFrom === null || escalatedFrom === '') {
      primary = record
    }
  }
  return primary || fallback
}

/**
 * TASK-0004 attempt readers. Attempts are a controller-owned journal at
 * <workspace>/.ai-harness/runs/<taskId>/attempts.jsonl; each record is
 * produced by the controller CLI (Start-AihTaskAttempt / Add-AihAttemptEvent).
 * The panel only READS; the last record for this exact task is the current
 * attempt. No timestamps are ever derived here.
 */
function attemptsOf(text) {
  return jsonLinesOf(text)
}

/**
 * Latest attempt record for exactly this task (workspace-scoped by path).
 * TASK-0005: when a taskInstanceId is expected, only attempt records carrying
 * THAT instance join — a surviving journal of an older generation that shared
 * the display id can never be attributed to the new one.
 */
function latestAttemptOfTask(records, taskId, taskInstanceId) {
  if (!Array.isArray(records)) return null
  const expectedInstance = (typeof taskInstanceId === 'string' && taskInstanceId !== '') ? taskInstanceId : null
  let latest = null
  for (const record of records) {
    if (!record || String(record.taskId) !== String(taskId)) continue
    if (expectedInstance !== null && record.taskInstanceId !== expectedInstance) continue
    latest = record
  }
  return latest
}

/**
 * Phase V2: smallest truthful visual-state shape for the Control Room task
 * surface. Visual Review is an orthogonal capability — this block is
 * observability only and never feeds routing, the routing badge, or
 * completion authority. humanAcceptance is displayed as the human-pending
 * flag (always false here — human acceptance is external).
 */
function normalizeVisualState(record) {
  if (!record || typeof record !== 'object') return null
  const status = typeof record.status === 'string' ? record.status : null
  const requirement = typeof record.requirement === 'string' ? record.requirement : null
  const required = Boolean(record.required)
  if (!status && !requirement && !required) return null
  return {
    required,
    requirement,
    status,
    iteration: Number.isInteger(record.iteration) ? record.iteration : null,
    maxIterations: Number.isInteger(record.maxIterations) ? record.maxIterations : null,
    latestVerdict: typeof record.latestVerdict === 'string' ? record.latestVerdict : null,
    latestScore: typeof record.latestScore === 'number' ? record.latestScore : null,
    trigger: typeof record.trigger === 'string' ? record.trigger : null,
    humanAcceptance: Boolean(record.humanAcceptance),
    // human review pending = visual PASS achieved, external human acceptance still outstanding
    humanReviewPending: Boolean(required && status === 'pass' && !record.humanAcceptance),
    repairPending: Boolean(record.repairPending),
  }
}

/** Smallest truthful attempt shape for the panel. */
function normalizeAttemptRecord(record) {
  if (!record || typeof record !== 'object') return null
  const normalized = {
    sequence: Number.isInteger(record.sequence) ? record.sequence : null,
    status: typeof record.status === 'string' ? record.status : null,
    startedAtUtc: typeof record.startedAtUtc === 'string' ? record.startedAtUtc : null,
    timestampUtc: typeof record.timestampUtc === 'string' ? record.timestampUtc : null,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    startedByTurn: typeof record.startedByTurn === 'string' ? record.startedByTurn : null,
  }
  // TASK-0005: the immutable instance rides along ONLY for instance-aware
  // records, so legacy records keep their exact historical shape.
  if (typeof record.taskInstanceId === 'string' && record.taskInstanceId !== '') {
    normalized.taskInstanceId = record.taskInstanceId
  }
  return normalized
}

/**
 * TASK-0004 operator-gate readers. Gates live in data/completion/gates.jsonl
 * (append-only journal). The current gate for a binding is the LAST record
 * whose sessionId + normalized workspace + taskId match (never taskId alone).
 */
function currentGateOf(records, sessionId, workspace, taskId, taskInstanceId) {
  if (!Array.isArray(records)) return null
  const normalized = normalizeWorkspacePath(workspace)
  if (normalized === '') return null
  // TASK-0005: gates are lifecycle-scoped too — an instance-aware binding
  // never inherits a gate recorded for another generation of the display id.
  const expectedInstance = (typeof taskInstanceId === 'string' && taskInstanceId !== '') ? taskInstanceId : null
  let current = null
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (String(record.sessionId) !== String(sessionId)) continue
    if (normalizeWorkspacePath(record.workspace) !== normalized) continue
    if (String(record.taskId) !== String(taskId)) continue
    if (expectedInstance !== null && record.taskInstanceId !== expectedInstance) continue
    current = record
  }
  return current
}

/** Smallest truthful gate shape for the panel (buttons render ONLY from allowedActions). */
function normalizeGateRecord(record) {
  if (!record || typeof record !== 'object') return null
  const normalized = {
    gateId: typeof record.gateId === 'string' ? record.gateId : null,
    kind: typeof record.kind === 'string' ? record.kind : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    status: typeof record.status === 'string' ? record.status : null,
    allowedActions: Array.isArray(record.allowedActions) ? record.allowedActions.filter((a) => typeof a === 'string') : [],
    attempt: Number.isInteger(record.attempt) ? record.attempt : null,
    reviewVerdict: typeof record.reviewVerdict === 'string' ? record.reviewVerdict : null,
    revision: Number.isInteger(record.revision) ? record.revision : null,
    createdAtUtc: typeof record.createdAtUtc === 'string' ? record.createdAtUtc : null,
    resolvedAtUtc: typeof record.resolvedAtUtc === 'string' ? record.resolvedAtUtc : null,
    resolvedBy: typeof record.resolvedBy === 'string' ? record.resolvedBy : null,
    actionId: typeof record.actionId === 'string' ? record.actionId : null,
  }
  // TASK-0005: instance-aware gate records carry the immutable identity;
  // legacy records keep the exact historical shape.
  if (typeof record.taskInstanceId === 'string' && record.taskInstanceId !== '') {
    normalized.taskInstanceId = record.taskInstanceId
  }
  return normalized
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
    // TASK-0004.1: any FAILed check makes the overall status FAILED; the
    // schema has no incomplete-execution state, so 'partial' is never emitted.
    verificationStatus = failed > 0 ? 'failed' : 'passed'
  }
  const failureSignatures = Array.isArray(task.failureSignatures) ? task.failureSignatures.map(String) : []
  const normalized = {
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
  // TASK-0005: instance-aware ledger records carry the immutable identity;
  // legacy records keep the exact historical shape (panel deep-equal parity).
  if (typeof task.taskInstanceId === 'string' && task.taskInstanceId !== '') {
    normalized.taskInstanceId = task.taskInstanceId
  }
  return normalized
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
    const canonical = canonicalExecutionClass(executionClass)
    if (canonical === 'reviewer') return 'reviewing'
    if (canonical === 'engineer_deep') return 'repairing'
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

/**
 * Parse the operator-set `engineering-profile:` key from settings.yaml.
 * This is the PREFERRED profile (configuration), reported separately from the
 * RUNNING profile resolved per task — the Control Room never collapses the
 * two, exactly like PREFERRED vs RUNNING model.
 */
function parseEngineeringProfile(settingsText) {
  if (typeof settingsText !== 'string' || settingsText === '') return null
  const match = /^engineering-profile:\s*([^\s#\r\n]+)/m.exec(settingsText)
  if (!match) return null
  const id = match[1].replace(/^['"]|['"]$/g, '').trim()
  return id === '' ? null : id
}

/**
 * Resolve the PREFERRED engineering profile for display: settings
 * `engineering-profile:` (operator choice) with displayName from the profile
 * registry when available. Never consulted for routing.
 */
function preferredProfileOf(settingsText, profilesPath, readFile, customProfilesPath) {
  const profileId = parseEngineeringProfile(settingsText)
  if (!profileId) return null
  let displayName = profileId
  if (profilesPath) {
    const document = readJson(profilesPath, readFile)
    if (document && Array.isArray(document.profiles)) {
      for (const profile of document.profiles) {
        if (profile && String(profile.id) === profileId) {
          displayName = String(profile.displayName || profileId)
          break
        }
      }
    }
  }
  // Phase 2.1: the operator-defined CUSTOM profile lives in its own file —
  // look up its display name when the preferred profile is the custom one.
  if (displayName === profileId && customProfilesPath) {
    const custom = readJson(customProfilesPath, readFile)
    if (custom && custom.schemaVersion === 1 && custom.displayName && String(custom.profileId || 'custom') === profileId) {
      displayName = String(custom.displayName)
    }
  }
  return { id: profileId, displayName }
}

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

/**
 * TASK-0005 Part 24: execution-snapshot identity consistency. Returns a
 * reason string when the sources used to build ONE execution tuple belong to
 * DIFFERENT task lifecycle generations (or to no instance while the task has
 * one), null when the tuple is internally consistent. A contradictory tuple
 * must never be assembled — the caller fails closed instead.
 */
function executionIdentityInconsistency(binding, routingState, decision) {
  const expected = binding && typeof binding.taskInstanceId === 'string' && binding.taskInstanceId !== ''
    ? binding.taskInstanceId
    : null
  const stateInstance = routingState && typeof routingState.taskInstanceId === 'string' && routingState.taskInstanceId !== ''
    ? routingState.taskInstanceId
    : null
  const decisionInstance = decision && typeof decision.taskInstanceId === 'string' && decision.taskInstanceId !== ''
    ? decision.taskInstanceId
    : null
  // Two modern records that name different instances can never merge.
  if (stateInstance && decisionInstance && stateInstance !== decisionInstance) return 'routing-state-and-decision-disagree'
  // An instance-aware task must not inherit generation-blind (legacy
  // taskId-only) routing sources either.
  if (expected) {
    if (routingState && stateInstance !== expected) return 'routing-state-from-other-task-generation'
    if (decision && decisionInstance !== expected) return 'routing-decision-from-other-task-generation'
  }
  return null
}

/** Build the normalized executor block. */
function normalizeExecution(binding, task, routingState, decision, modelNames) {
  if (!binding) return null
  // TASK-0005 Part 24: fail closed instead of assembling an impossible tuple
  // (class from generation B + model from generation A). The panel renders
  // the inconsistency explicitly rather than a plausible-looking lie.
  const inconsistency = executionIdentityInconsistency(binding, routingState, decision)
  if (inconsistency) {
    return {
      identityInconsistent: true,
      inconsistencyReason: inconsistency,
      class: null,
      classDisplay: null,
      role: null,
      profile: null,
      profileDisplayName: null,
      provider: null,
      model: null,
      modelId: null,
      reasoning: null,
      reviewRequired: Boolean(binding.reviewRequired),
      sameFailureCount: 0,
      escalatedFrom: null,
      routedAtUtc: null,
    }
  }
  const provider = decision && decision.provider ? String(decision.provider) : null
  const modelId = decision && decision.model ? String(decision.model) : null
  const reasoning = decision && decision.reasoning ? String(decision.reasoning) : null
  const executionClass = routingState && routingState.executionClass
    ? String(routingState.executionClass)
    : (typeof binding.executionClass === 'string' ? binding.executionClass : null)
  // Phase 2: role/profile come from the decision record when present (new
  // records), from the routing state (new states), or are derived from the
  // execution class (works for legacy records too). The model display name is
  // the registry display name when the record carries one, with the settings
  // map as fallback — the UI must report the EFFECTIVE model, never the
  // configured profile name alone.
  const recordRole = (decision && decision.role) || (routingState && routingState.role) || null
  const recordProfile = (decision && decision.profile) || (routingState && routingState.profile) || null
  const recordProfileDisplay = (decision && decision.profileDisplayName) || (routingState && routingState.profileDisplayName) || null
  return {
    class: executionClass,
    classDisplay: executionClassDisplayName(executionClass),
    role: recordRole || roleOfExecutionClass(executionClass),
    profile: recordProfile,
    profileDisplayName: recordProfileDisplay,
    provider,
    model: (decision && decision.modelDisplayName) || modelNameOf(provider, modelId, modelNames),
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
 * Parse the `agent-presets.default` key from settings.yaml — the preset a
 * NEW task will run under when no session binding exists yet. Fail-closed:
 * any malformed/missing block yields null.
 */
function parseAgentPresetsDefault(settingsText) {
  if (typeof settingsText !== 'string' || settingsText === '') return null
  const lines = settingsText.split(/\r?\n/)
  let inBlock = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    const indent = line.match(/^\s*/)[0].length
    if (!inBlock) {
      if (/^\s*agent-presets:\s*$/.test(line)) inBlock = true
      continue
    }
    if (indent === 0 && line !== '') break
    const match = /^\s+default:\s*(['"]?)([^\s#'"]+)\1\s*$/.exec(line)
    if (match) return match[2]
  }
  return null
}

/**
 * The preset the composer's NEXT task would run under: the session binding's
 * preset while a task is bound, else the settings default, else the Normal
 * Engineering preset. Display/mode metadata only — never consulted for
 * routing.
 */
function composerPresetOf(binding, settingsText) {
  if (binding && typeof binding.preset === 'string' && binding.preset !== '') return binding.preset
  const fallback = parseAgentPresetsDefault(settingsText)
  return fallback || 'aih-engineering'
}

/**
 * Composer ownership is a user-facing Mode contract, not a runtime model-
 * override permission. Both internal planes selected by Normal Engineering
 * (`aih-engineering` and `aih-muse`) remain Profile-owned for the complete
 * session lifecycle. DeepSeek Only alone keeps the upstream model selector.
 * Unknown/corrupt policy state fails safe to legacy.
 */
function composerModeOf(activePreset, policyPath, readFile) {
  if (!policyPath || typeof activePreset !== 'string' || activePreset === '') return 'legacy'
  const policy = readJson(policyPath, readFile)
  if (!policy || typeof policy !== 'object' || !policy.presets || typeof policy.presets !== 'object') return 'legacy'
  const preset = policy.presets[activePreset]
  if (!preset || typeof preset !== 'object') return 'legacy'
  if (activePreset === 'aih-engineering' || activePreset === 'aih-muse') return 'engineering'
  return 'legacy'
}

/**
 * Derive the PREFERRED engineer for the composer label: preferred profile ->
 * primaryEngineer binding -> Model Registry displayName + resolved provider.
 * Same resolver rules as the Engineering editor state (engineering.cjs); the
 * target is null when the binding is not satisfiable (fail-closed — the UI
 * then shows no preferred chip rather than a wrong one).
 */
function preferredEngineerOf(settingsText, profilesPath, customProfilesPath, registryPath, readFile) {
  if (!settingsText) return null
  const profilesDocument = profilesPath || customProfilesPath
    ? engineeringProfiles.loadProfilesDocument(profilesPath, customProfilesPath, readFile)
    : null
  const preferred = engineeringProfiles.preferredProfileOf(settingsText, profilesDocument, readFile)
  if (!preferred || !profilesDocument || !Array.isArray(profilesDocument.profiles)) return null
  let profile = null
  for (const candidate of profilesDocument.profiles) {
    if (candidate && String(candidate.id) === preferred.id) { profile = candidate; break }
  }
  if (!profile) return null
  const registry = registryPath ? engineeringProfiles.loadRegistryDocument(registryPath, readFile) : null
  const target = engineeringProfiles.roleBindingTarget(registry, profile, 'primaryEngineer')
  if (!target) return null
  let entry = null
  for (const candidate of (registry && Array.isArray(registry.models) ? registry.models : [])) {
    if (candidate && String(candidate.id) === target.modelId) { entry = candidate; break }
  }
  return {
    profileId: preferred.id,
    profileDisplayName: preferred.displayName,
    modelId: target.modelId,
    modelDisplayName: entry ? String(entry.displayName || entry.id || target.modelId) : target.modelId,
    vendor: entry && entry.vendor ? String(entry.vendor) : null,
    reasoning: target.reasoning,
    provider: target.provider,
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
    profilesPath,
    customProfilesPath = null,
    policyPath = null,
    registryPath = null,
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
  // PREFERRED profile (operator configuration) — display metadata, reported
  // next to the RUNNING execution (class/role/model/provider) without ever
  // being collapsed into it.
  const preferredProfile = settingsPath
    ? preferredProfileOf(readJsonSafeText(settingsPath, readFile), profilesPath, readFile, customProfilesPath)
    : null
  // Phase 2.2: composer integration block — which selector the composer
  // shows (engineering vs legacy by active preset policy) and the PREFERRED
  // engineer derived from the preferred profile's primaryEngineer binding.
  // Both are configuration/preference display; RUNNING is never touched.
  const settingsText = settingsPath ? readJsonSafeText(settingsPath, readFile) : null
  const composerPreset = composerPresetOf(binding, settingsText)
  const composer = {
    mode: composerModeOf(composerPreset, policyPath, readFile),
    preset: composerPreset,
    preferredEngineer: preferredEngineerOf(settingsText, profilesPath, customProfilesPath, registryPath, readFile),
  }

  let task = null
  let routingState = null
  let decision = null
  let git = null
  let attempt = null
  let gate = null
  let visual = null

  if (binding) {
    const workspace = typeof binding.workspace === 'string' ? binding.workspace : null
    const taskId = typeof binding.taskId === 'string' ? binding.taskId : null
    const preset = typeof binding.preset === 'string' ? binding.preset : 'aih-engineering'
    // TASK-0005: the bound task's immutable lifecycle instance (null for
    // legacy bindings). Every join below prefers it.
    const taskInstanceId = typeof binding.taskInstanceId === 'string' && binding.taskInstanceId !== ''
      ? binding.taskInstanceId
      : null
    if (taskId) {
      const ledger = readJson(path.join(workspace || '', '.ai-harness', 'state', 'tasks.json'), readFile)
      if (ledger && Array.isArray(ledger.tasks)) {
        for (const candidate of ledger.tasks) {
          if (!candidate || candidate.taskId !== taskId) continue
          if (taskInstanceId !== null) {
            // Instance-aware binding: the ledger record must be the SAME
            // lifecycle generation; a re-allocated display id of an older
            // generation is never merged into this snapshot.
            if (candidate.taskInstanceId !== taskInstanceId) continue
          }
          task = candidate
          break
        }
      }
      if (workspace) {
        const stateFileName = routingStateFileName(workspace, preset, taskId, taskInstanceId)
        routingState = readJson(path.join(dataRoot, 'routing', 'states', stateFileName), readFile)
        const decisionsText = readJsonSafeText(path.join(dataRoot, 'routing', 'decisions.jsonl'), readFile)
        decision = lastDecisionOf(jsonLinesOf(decisionsText), taskId, workspace, taskInstanceId)
      }
      if (gitSummary && workspace) {
        try { git = await gitSummary(workspace) } catch { git = null }
      }
      // TASK-0004: attempt + gate are read from their authoritative records;
      // both degrade to null for old tasks (render as "—"), never to guesses.
      if (workspace) {
        const attemptsText = readJsonSafeText(path.join(workspace, '.ai-harness', 'runs', taskId, 'attempts.jsonl'), readFile)
        attempt = normalizeAttemptRecord(latestAttemptOfTask(attemptsOf(attemptsText), taskId, taskInstanceId))
      }
      // Phase V2: first-class visual state (orthogonal capability — never an
      // execution class). Read from the authoritative controller record only;
      // degrades to null for non-visual tasks.
      if (workspace) {
        visual = normalizeVisualState(readJson(path.join(workspace, '.ai-harness', 'runs', taskId, 'visual', 'state.json'), readFile))
      }
      const gatesText = readJsonSafeText(path.join(dataRoot, 'completion', 'gates.jsonl'), readFile)
      gate = normalizeGateRecord(currentGateOf(jsonLinesOf(gatesText), String(sessionId || ''), workspace || '', taskId, taskInstanceId))
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
      taskInstanceId: typeof binding.taskInstanceId === 'string' && binding.taskInstanceId !== '' ? binding.taskInstanceId : null,
      taskId: String(binding.taskId ?? ''),
      workspace: typeof binding.workspace === 'string' ? binding.workspace : null,
      workspaceId: typeof binding.workspaceId === 'string' ? binding.workspaceId : null,
      repositoryId: typeof binding.repositoryId === 'string' ? binding.repositoryId : null,
      checkoutId: typeof binding.checkoutId === 'string' ? binding.checkoutId : null,
      checkoutRootPath: typeof binding.checkoutRootPath === 'string' ? binding.checkoutRootPath : null,
      executionRoot: typeof binding.executionRoot === 'string' ? binding.executionRoot : (typeof binding.workspace === 'string' ? binding.workspace : null),
      preset: typeof binding.preset === 'string' ? binding.preset : null,
      executionClass: typeof binding.executionClass === 'string' ? binding.executionClass : null,
      reviewRequired: Boolean(binding.reviewRequired),
      boundAtUtc: binding.boundAtUtc ? String(binding.boundAtUtc) : null,
    } : null,
    task: taskRecord,
    attempt,
    gate,
    visual,
    preference: normalizePreference(defaultModel, modelNames),
    preferredProfile,
    composer,
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
      runtimeRoot: controller.RuntimeRoot ? String(controller.RuntimeRoot) : null,
      startedAtUtc: controller.ProcessStartedAtUtc ? String(controller.ProcessStartedAtUtc) : null,
      updatedAtUtc: controller.UpdatedAtUtc ? String(controller.UpdatedAtUtc) : null,
    } : null,
    git,
  }
}

module.exports = {
  DISPLAY_STATES,
  EXECUTION_CLASS_ALIASES,
  EXECUTION_CLASS_DISPLAY,
  EXECUTION_CLASS_ROLES,
  canonicalExecutionClass,
  executionClassDisplayName,
  roleOfExecutionClass,
  parseEngineeringProfile,
  preferredProfileOf,
  parseAgentPresetsDefault,
  composerPresetOf,
  composerModeOf,
  preferredEngineerOf,
  normalizeWorkspacePath,
  parseDefaultModel,
  normalizePreference,
  defaultReadFile,
  readJson,
  readJsonSafeText,
  routingStateFileName,
  bindingsOf,
  lastDecisionOf,
  attemptsOf,
  latestAttemptOfTask,
  normalizeAttemptRecord,
  currentGateOf,
  normalizeGateRecord,
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
