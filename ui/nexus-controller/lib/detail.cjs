// @nexus/controller — pure detail adapter for the Task Control Room.
//
// Builds a normalized, UI-safe, READ-ONLY detail snapshot for one bound
// session. It answers "how did this task get here / what happened / what
// verification ran / why did a failure happen" from REAL Nexus records only:
//
//   data/routing/session-bindings.json     session -> task binding
//   data/routing/decisions.jsonl           routing decisions (routed events)
//   data/routing/states/<sha256>.json      routing state (same-failure count)
//   <workspace>/.ai-harness/state/tasks.json            task ledger
//   <workspace>/.ai-harness/state/decisions.jsonl       task lifecycle events
//   <workspace>/.ai-harness/runs/<task>/attempts.jsonl  attempt records
//   <workspace>/.ai-harness/runs/<task>/evidence.json   verification artifact
//   <workspace>/.ai-harness/runs/<task>/review-packet.json  review request
//   <workspace>/.ai-harness/runs/<task>/review-result.json  review outcome
//   <workspace>/.ai-harness/runs/<task>/manifest.json    run manifest
//   data/aih-state.json                    launcher state
//
// Every subsystem degrades independently and fail-closed: a corrupt
// verification artifact must not erase healthy task/routing data. Nothing
// here writes, mutates, or infers an event that has no authoritative record.
// Attempt "passed" is derived strictly: an attempt sequence with a real
// 'started' record, no 'failed' record, and a ledger that reached
// 'complete'; otherwise 'started' (in progress) — never fabricated.
//
// UTF-8: all text files are read as UTF-8 and carried through verbatim.
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const status = require('./status.cjs')

const DEFAULT_EXEC = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout) => {
    if (error) reject(error)
    else resolve({ stdout })
  })
})

function defaultReadFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/** Read a text file as a string, or '' on any failure (fail-closed). */
function safeReadText(filePath, readFile) {
  if (!filePath) return ''
  try {
    const text = readFile(filePath)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * Merge porcelain + numstat (worktree + index) into per-file rows.
 * Rows: { path, status, insertions, deletions, untracked }
 * - tracked rows carry numstat counts when Git reports them
 * - untracked rows (??) never get invented line counts
 * - rename rows use the target path (porcelain 'R... old -> new')
 */
function collectGitFiles(workspace, exec = DEFAULT_EXEC) {
  if (!workspace) return null
  const result = {
    files: null,
    branch: null,
    porcelain: null,
    numstat: null,
    numstatCached: null,
    error: null,
  }
  return Promise.all([
    status.runGit(exec, workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status.runGit(exec, workspace, ['status', '--porcelain=v1']),
    status.runGit(exec, workspace, ['diff', '--numstat', 'HEAD']),
    status.runGit(exec, workspace, ['diff', '--cached', '--numstat']),
  ]).then(([branchLines, statusLines, numstatLines, cachedLines]) => {
    if (branchLines === null && statusLines === null && numstatLines === null && cachedLines === null) {
      result.error = 'git-unavailable'
      return result
    }
    result.branch = Array.isArray(branchLines) && branchLines.length > 0 ? branchLines[0] : null
    result.porcelain = statusLines ?? []
    result.numstat = numstatLines ?? []
    result.numstatCached = cachedLines ?? []

    const byPath = new Map()
    for (const line of result.porcelain) {
      if (line.length < 4) continue
      const flags = line.slice(0, 2)
      let filePath = line.slice(3)
      const renameArrow = filePath.indexOf(' -> ')
      if (renameArrow !== -1) filePath = filePath.slice(renameArrow + 4)
      const untracked = flags === '??'
      byPath.set(filePath, {
        path: filePath,
        status: flags,
        index: flags[0],
        worktree: flags[1],
        untracked,
        insertions: null,
        deletions: null,
      })
    }
    for (const lines of [result.numstat, result.numstatCached]) {
      for (const line of lines) {
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const ins = parts[0]
        const del = parts[1]
        const filePath = parts.slice(2).join('\t')
        const row = byPath.get(filePath)
        if (!row || row.untracked) continue
        const i = Number.parseInt(ins, 10)
        const d = Number.parseInt(del, 10)
        row.insertions = Number.isNaN(i) ? null : i
        row.deletions = Number.isNaN(d) ? null : d
      }
    }
    result.files = [...byPath.values()]
    return result
  }).catch(() => {
    result.error = 'git-unavailable'
    return result
  })
}

/** Classify a routing record by routing semantics (never by model name). */
function routingKindOf(record) {
  if (!record || typeof record !== 'object') return 'unknown'
  const executionClass = String(record.executionClass || record.selectedExecutionClass || '')
  const escalatedFrom = record.escalatedFrom
  const hasEscalation = escalatedFrom !== undefined && escalatedFrom !== null && escalatedFrom !== ''
  if (executionClass === 'codex_review') return 'review'
  if (hasEscalation) return 'escalation'
  return 'primary'
}

/** Group attempts.jsonl records into ordered attempt rows. */
function groupAttempts(records, ledger) {
  if (!Array.isArray(records) || records.length === 0) return []
  const bySequence = new Map()
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const sequence = Number.isInteger(record.sequence) ? record.sequence : Number.parseInt(record.sequence, 10)
    if (!Number.isInteger(sequence) || sequence < 1) continue
    if (!bySequence.has(sequence)) {
      bySequence.set(sequence, { sequence, started: null, failed: null })
    }
    const row = bySequence.get(sequence)
    if (String(record.status) === 'started' && row.started === null && record.startedAtUtc) {
      row.started = record
    } else if (String(record.status) === 'failed' && row.failed === null) {
      row.failed = record
    }
  }
  const ledgerComplete = Boolean(ledger && ledger.status === 'complete')
  return [...bySequence.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sequence, row]) => {
      const startedAtUtc = row.started ? String(row.started.startedAtUtc) : null
      const failedAtUtc = row.failed ? String(row.failed.timestampUtc || '') : null
      let durationSeconds = null
      if (row.failed && row.started && failedAtUtc && startedAtUtc) {
        const end = Date.parse(failedAtUtc)
        const start = Date.parse(startedAtUtc)
        if (Number.isFinite(end) && Number.isFinite(start) && end >= start) {
          durationSeconds = Math.round((end - start) / 1000)
        }
      }
      return {
        sequence,
        attemptId: row.started && row.started.attemptId ? String(row.started.attemptId) : null,
        executionClass: row.started && row.started.executionClass ? String(row.started.executionClass) : null,
        status: row.failed ? 'failed' : (ledgerComplete ? 'passed' : 'started'),
        startedAtUtc,
        failedAtUtc,
        failureSignature: row.failed && row.failed.failureSignature ? String(row.failed.failureSignature) : null,
        evidence: row.failed && row.failed.evidence ? String(row.failed.evidence) : null,
        durationSeconds,
      }
    })
}

/** Count failure-signature occurrences, preserving first-seen order. */
function countFailureSignatures(signatures) {
  const counts = []
  const seen = new Map()
  for (const raw of Array.isArray(signatures) ? signatures : []) {
    const signature = String(raw)
    if (signature === '') continue
    if (!seen.has(signature)) {
      seen.set(signature, counts.length)
      counts.push({ signature, count: 0 })
    }
    counts[seen.get(signature)].count += 1
  }
  return counts
}

/** Verification checks from the evidence artifact or the ledger. */
function summarizeVerification(evidence, ledger) {
  const ledgerChecks = (ledger && ledger.verification && Array.isArray(ledger.verification.outcomes)
    ? ledger.verification.outcomes
    : []).map((outcome) => {
    if (!outcome || typeof outcome !== 'object') return null
    const name = outcome.name ?? outcome.Name
    if (typeof name !== 'string' || name === '') return null
    const statusValue = String(outcome.status ?? outcome.Status ?? 'PASS').toUpperCase()
    return {
      name,
      status: statusValue,
      evidence: typeof outcome.evidence === 'string' ? outcome.evidence : null,
    }
  }).filter(Boolean)

  const evidenceChecks = (evidence && Array.isArray(evidence.verification)
    ? evidence.verification
    : []).map((check) => {
    if (!check || typeof check !== 'object') return null
    const name = check.name ?? check.Name
    if (typeof name !== 'string' || name === '') return null
    const statusValue = String(check.status ?? check.Status ?? 'PASS').toUpperCase()
    return {
      name,
      status: statusValue,
      evidence: typeof check.evidence === 'string' ? check.evidence : null,
    }
  }).filter(Boolean)

  const checks = evidenceChecks.length > 0 ? evidenceChecks : ledgerChecks
  const passed = checks.filter((check) => check.status === 'PASS').length
  const failed = checks.filter((check) => check.status === 'FAIL').length
  const skipped = checks.filter((check) => check.status === 'SKIP').length
  let statusValue = 'not-run'
  if (checks.length > 0) {
    statusValue = failed > 0 ? (passed > 0 ? 'partial' : 'failed') : 'passed'
  }
  return {
    status: statusValue,
    passed,
    failed,
    skipped,
    total: checks.length,
    checks,
    acceptanceCriteria: evidence && Array.isArray(evidence.acceptanceCriteria)
      ? evidence.acceptanceCriteria.map((criterion) => {
        if (!criterion || typeof criterion !== 'object') return null
        const label = typeof criterion.criterion === 'string' ? criterion.criterion : null
        if (!label) return null
        return {
          criterion: label,
          status: String(criterion.status ?? ''),
          evidence: typeof criterion.evidence === 'string' ? criterion.evidence : null,
        }
      }).filter(Boolean)
      : [],
    scopePass: evidence && typeof evidence.scopePass === 'boolean' ? evidence.scopePass : null,
  }
}

/**
 * Build the detail envelope for one session. Fail-closed per subsystem:
 * a missing/corrupt source degrades its own section and never erases the
 * healthy sections. Returns null ONLY when the session cannot be resolved
 * at all (no binding, or the binding has no usable workspace).
 */
async function buildDetailSnapshot({
  dataRoot,
  sessionId,
  settingsPath,
  statePath,
  readFile = defaultReadFile,
  modelNames = {},
  gitSummary = null,
  gitFiles = null,
  nowUtc = () => new Date().toISOString(),
}) {
  const generatedAtUtc = nowUtc()
  const bindings = status.bindingsOf(status.readJson(path.join(dataRoot, 'routing', 'session-bindings.json'), readFile))
  const binding = bindings[String(sessionId || '')] || null
  if (!binding || !binding.workspace) {
    return null
  }
  const workspace = String(binding.workspace)
  const taskId = String(binding.taskId || '')
  const preset = String(binding.preset || 'aih-engineering')

  const stateDir = path.join(dataRoot, 'routing', 'states')
  const routingState = status.readJson(path.join(stateDir, status.routingStateFileName(workspace, preset, taskId)), readFile)

  let task = null
  let rawTask = null
  const ledger = status.readJson(path.join(workspace, '.ai-harness', 'state', 'tasks.json'), readFile)
  if (ledger && Array.isArray(ledger.tasks)) {
    rawTask = ledger.tasks.find((t) => t && t.taskId === taskId) || null
    if (rawTask) task = status.normalizeTaskRecord(rawTask)
  }

  const decisions = status.jsonLinesOf(safeReadText(path.join(dataRoot, 'routing', 'decisions.jsonl'), readFile))
  const routed = decisions.filter((record) => record && record.taskId === taskId)
  const primary = status.lastDecisionOf(decisions, taskId)
  const execution = status.normalizeExecution(binding, task, routingState, primary, modelNames)

  // routing history: every real decision for the task, oldest first
  const routingHistory = [...routed]
    .sort((a, b) => String(a.timestampUtc || '').localeCompare(String(b.timestampUtc || '')))
    .map((record) => ({
      timestampUtc: record.timestampUtc ? String(record.timestampUtc) : null,
      kind: routingKindOf(record),
      executionClass: record.executionClass ? String(record.executionClass) : null,
      selectedExecutionClass: record.selectedExecutionClass ? String(record.selectedExecutionClass) : null,
      provider: record.provider ? String(record.provider) : null,
      model: record.model ? status.modelNameOf(String(record.provider || ''), String(record.model), modelNames) : null,
      modelId: record.model ? String(record.model) : null,
      reasoning: record.reasoning ? String(record.reasoning) : null,
      writable: typeof record.writable === 'boolean' ? record.writable : null,
      reviewRequired: Boolean(record.reviewRequired),
      reviewRequested: Boolean(record.reviewRequested),
      escalatedFrom: record.escalatedFrom ? String(record.escalatedFrom) : null,
      reason: record.reason ? String(record.reason) : null,
    }))

  // task lifecycle events (workspace ledger), oldest first
  const lifecycle = status.jsonLinesOf(safeReadText(path.join(workspace, '.ai-harness', 'state', 'decisions.jsonl'), readFile))
    .filter((record) => record && record.taskId === taskId)
    .sort((a, b) => String(a.timestampUtc || '').localeCompare(String(b.timestampUtc || '')))
    .map((record) => ({
      timestampUtc: record.timestampUtc ? String(record.timestampUtc) : null,
      kind: String(record.kind || ''),
      executionClass: record.executionClass ? String(record.executionClass) : null,
      reason: record.reason ? String(record.reason) : null,
      dependencies: Array.isArray(record.dependencies) ? record.dependencies.map(String) : [],
    }))

  const runsDir = path.join(workspace, '.ai-harness', 'runs', taskId)
  const attempts = groupAttempts(
    status.jsonLinesOf(safeReadText(path.join(runsDir, 'attempts.jsonl'), readFile)),
    task,
  )

  const evidence = status.readJson(path.join(runsDir, 'evidence.json'), readFile)
  // Ledger fallback reads the RAW record: normalizeTaskRecord rebuilds
  // verification.checks and drops the original outcomes.
  const verification = summarizeVerification(evidence, rawTask)
  verification.artifactPath = path.join(runsDir, 'evidence.json')
  verification.artifactPresent = Boolean(evidence)
  verification.source = evidence ? 'evidence-artifact' : (
    rawTask && rawTask.verification && Array.isArray(rawTask.verification.outcomes) && rawTask.verification.outcomes.length > 0
      ? 'ledger'
      : null
  )

  const signatures = countFailureSignatures(task ? task.failureSignatures : [])
  const failures = {
    current: task && task.failureSignature ? task.failureSignature : null,
    signatures,
    sameFailureCount: routingState && Number.isInteger(routingState.sameFailureCount)
      ? routingState.sameFailureCount
      : null,
  }

  const reviewResult = status.readJson(path.join(runsDir, 'review-result.json'), readFile)
  const reviewPacket = status.readJson(path.join(runsDir, 'review-packet.json'), readFile)
  const reviews = {
    codexCalls: task ? task.codexCalls : 0,
    reviewRequired: Boolean(
      (routingState && routingState.reviewRequired) ||
      (task && task.reviewRequested) ||
      (binding && binding.reviewRequired),
    ),
    decisions: routingHistory.filter((record) => record.kind === 'review'),
    result: reviewResult && typeof reviewResult === 'object' ? {
      verdict: typeof reviewResult.verdict === 'string' ? reviewResult.verdict : null,
      needsBroaderContext: Boolean(reviewResult.needsBroaderContext),
      findings: Array.isArray(reviewResult.findings) ? reviewResult.findings.map((finding) => {
        if (!finding || typeof finding !== 'object') return null
        return {
          severity: typeof finding.severity === 'string' ? finding.severity : null,
          location: typeof finding.location === 'string' ? finding.location : null,
          problem: typeof finding.problem === 'string' ? finding.problem : null,
        }
      }).filter(Boolean) : [],
    } : null,
    packet: reviewPacket && typeof reviewPacket === 'object' ? {
      question: typeof reviewPacket.question === 'string' ? reviewPacket.question : null,
      relevantFileCount: Array.isArray(reviewPacket.relevantFiles) ? reviewPacket.relevantFiles.length : null,
      diffLength: typeof reviewPacket.diff === 'string' ? reviewPacket.diff.length : null,
    } : null,
  }

  const controller = (() => {
    const doc = status.readJson(statePath, readFile)
    if (!doc || typeof doc !== 'object') return null
    return {
      status: typeof doc.Status === 'string' ? doc.Status : (typeof doc.status === 'string' ? doc.status : null),
      pid: Number.isInteger(doc.Pid) ? doc.Pid : (Number.isInteger(doc.pid) ? doc.pid : null),
      startedAtUtc: typeof doc.ProcessStartedAtUtc === 'string' ? doc.ProcessStartedAtUtc : null,
      workspace: typeof doc.Workspace === 'string' ? doc.Workspace : null,
    }
  })()

  const fileState = status.deriveFileState(binding, task)
  const state = status.deriveDisplayState(fileState, null)

  return {
    schemaVersion: 1,
    generatedAtUtc,
    state,
    binding: {
      sessionId: binding.sessionId ? String(binding.sessionId) : sessionId,
      taskId,
      workspace,
      preset,
    },
    task,
    execution,
    routingHistory,
    lifecycle,
    attempts,
    verification,
    failures,
    reviews,
    git: {
      summary: gitSummary || null,
      files: gitFiles || null,
    },
    controller,
  }
}

module.exports = {
  buildDetailSnapshot,
  collectGitFiles,
  routingKindOf,
  groupAttempts,
  countFailureSignatures,
  summarizeVerification,
}
