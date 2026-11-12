'use strict'

/**
 * nexus/task-api — internal shared task API foundation (P2-A, Task D).
 *
 * One set of operations that the GUI host routes and the future Nexus CLI
 * transport will both call on the SAME trusted host Controller. P2-A exposes
 * NO transport: this is an in-process contract on the `nexusController`
 * service, callable only by trusted host code with an internal principal.
 *
 * Implemented now (read-only projections over existing authorities, no new
 * store, no subprocess, no inference):
 *   hello, listModes, getStatus, getResult, follow
 * Contract-shaped but refused now (managed admission is disabled until the
 * P2-B gates pass — owner-peer mutation coverage and enforced single-host
 * ownership):
 *   submit, cancel, respond  -> REQUIRED_CAPABILITY_UNAVAILABLE
 *
 * Authorities read (never written): the host binding store (session -> task),
 * the TaskController ledger `<workspace>/.ai-harness/state/tasks.json`
 * (schema 1), `runs/<displayId>/attempts.jsonl`, `evidence.json` and
 * `review-result.json`. A task is `completed` only when the TaskController
 * ledger says `complete`; a DSH turn ending never completes a Nexus task.
 * For the legacy cohort the opaque external task id is the immutable
 * TaskController lifecycle identity (`task_<32 hex>`); the display id is
 * informational and never a lookup key.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const managedTasksModule = require('./managed-tasks.cjs')

const SCHEMA_MAJOR = 1
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const LEGACY_STATUS = Object.freeze({ ready: 'queued', implementing: 'running', verifying: 'verifying', complete: 'completed', failed: 'failed' })
const MODE_OF_ENGINE = Object.freeze({ dual: 'engineering-v1', muse: 'engineering-v2' })
const TASK_ID = /^(task|nt)_[0-9a-f]{32}$/
const MANAGED_TASK_ID = /^nt_[0-9a-f]{32}$/
// What an operator can do about each hold (shown with the task view).
const HOLD_GUIDANCE = Object.freeze({
  'review-running': 'The independent review of the current candidate is running; wait for its verdict.',
  'review-gate-pending': 'Deterministic verification passed but the required independent review failed. Answer the review gate (approve = complete with the review overridden by the operator, exactly as in the Control Room; reject = keep completion blocked), or close the task.',
  'review-rejected': 'The operator rejected the review gate; completion stays blocked. Close the task and start a new one for further work.',
  'review-required': 'The TaskController requires a passing independent review of this candidate, and none was recorded for it before verification. A review cannot be added after verification in this version: close the task and start a new one (review before verifying).',
  'review-approved-completion-pending': 'The review gate was approved but the TaskController completion check did not finish (e.g. interrupted). Re-run the completion check (operator action) or close the task.',
  'visual-revise': 'The controller-owned visual review requested repairs. A repair needs a new engineering turn and a fresh verification, which a managed task cannot do after verification in this version: open the visual report, then close the task and start a new one with the repair instructions.',
  'visual-exhausted': 'The visual iteration budget is exhausted (HUMAN_REVIEW_PENDING). The existing policy has no operator override: completion stays blocked. Close the task.',
  'visual-unavailable': 'Visual verification is required but this environment could not produce the visual evidence (runtime capture or visual reviewer unavailable). No PASS is fabricated: completion stays blocked. Fix the environment and run the work as a new task, or close this one.',
  'visual-pending': 'Visual verification is required and has not reached PASS; completion stays blocked until the controller-owned visual loop passes. Close the task to stop.',
  'continuation-delivering': 'A follow-up turn is being delivered to the task\'s session; wait for it to be accepted.',
  'turn-completed-awaiting-verification': 'The engineering turn finished. Run verification (operator action run-verification) when the candidate is final, send another instruction (nexus continue), or close the task.',
  'verification-failed': 'Required verification failed; completion is denied. The failing checks are in taskVerification. A new attempt requires a new task (multi-turn continuation is not available).',
  'verification-incomplete': 'Verification did not finish (error or host restart); no result was recorded and it is never treated as a pass. Close the task.',
  'verification-rejected': 'Verification could not start (no open attempt or registry refusal). Close the task.',
  'completion-denied': 'Verification passed but the TaskController denied completion (see taskVerification.completion.reason). Close the task or resolve the gate in the Nexus app.',
  interrupted: 'The task was executing when the host stopped. It may have had side effects, so it is never resumed automatically. Inspect the workspace, then close the task.',
  'restored-input-not-resumed': 'The input was durably accepted but never ran; this host cannot resume it safely. Close the task and submit again if needed.',
  'delivery-not-durable': 'The input was not durably found after delivery. Close the task and submit again with a new idempotency key.',
  'delivery-rejected': 'DSH refused the input. Close the task.',
  'delivery-evidence-unreadable': 'Delivery evidence could not be read. Close the task.',
  'duplicate-input': 'The input appears more than once durably; nothing runs. Close the task.',
  'session-history-retired-source-kind': 'The session history uses a retired message format and cannot be restored. Close the task; the history stays readable with scripts/NexusSessionAudit.cjs.',
  'session-history-notice-before-head': 'The session history violates the DSH 0.2 head rule and cannot be restored. Close the task.',
  'session-history-notice-before-head-pending': 'The session history would become unreadable on its next step, so it is held. Close the task.',
  'session-history-unreadable': 'The session history cannot be read. Close the task.',
  'intake-record-missing': 'The task\'s intake record is missing; the session stays protected. Restore the record file from backup to recover the task (no action is possible without it).',
  'operator-closed': 'Closed by an operator. Identity, history and tombstone are kept.',
})
const CAPABILITY_OF = Object.freeze({ hello: 'tasks:read', listModes: 'tasks:read', getStatus: 'tasks:read', getResult: 'tasks:read', follow: 'tasks:read', submit: 'tasks:submit', continueTask: 'tasks:submit', cancel: 'tasks:cancel', respond: 'tasks:respond', registerWorkspace: 'workspaces:register', listCredentials: 'credentials:read', setCredential: 'credentials:write', unsetCredential: 'credentials:write', checkSession: 'tasks:read' })
// Credential references Nexus providers resolve (shown by `nexus credentials list`).
const DEFAULT_CREDENTIAL_REFS = Object.freeze(['OPENCODE_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MODEL_API_KEY'])
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_CREDENTIAL_BYTES = 16384
// One installation owner: GUI and CLI share idempotency and task authority.
const OWNER_PRINCIPAL_ID = 'local-owner'

function ok(data) { return Object.freeze({ schemaVersion: SCHEMA_MAJOR, ok: true, data: Object.freeze(data) }) }
function fail(code, message, retryable = false, details) {
  return Object.freeze({ schemaVersion: SCHEMA_MAJOR, ok: false, error: Object.freeze({ code, message, retryable, ...(details ? { details: Object.freeze(details) } : {}) }) })
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { return error && error.code === 'ENOENT' ? undefined : null }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function createTaskApi(options) {
  const core = options.core
  const projections = new Map() // taskId -> { fingerprint, revision, view }
  const metrics = { reads: 0, follows: 0, refusedMutations: 0, notFound: 0 }

  // Principals are constructed by trusted host code only: `internal` (host
  // code) or `local-owner` (derived by the authenticated IPC transport, never
  // supplied by a client). P2-B1 grants `tasks:read` only.
  function authorize(principal, operation = 'getStatus') {
    if (principal && principal.kind === 'internal') return null
    if (principal && principal.kind === 'local-owner' && Array.isArray(principal.capabilities) && principal.capabilities.includes(CAPABILITY_OF[operation])) return null
    return fail('AUTH_REQUIRED', 'The task API accepts only host-derived principals with the required capability.')
  }

  // A local-owner may observe only tasks whose workspace is registered with
  // the host (DSH workspace registry, re-resolved on every request). Foreign
  // or unregistered workspaces answer NOT_FOUND (concealed), never data.
  async function workspaceAllowed(principal, binding) {
    if (principal.kind === 'internal') return true
    if (typeof core.workspaceAuthorizer !== 'function') return false
    try { return Boolean(await core.workspaceAuthorizer(binding.workspace)) } catch { return false }
  }

  function bindingForTask(taskId) {
    for (const sessionId of core.bindings.list()) {
      const binding = core.bindings.read(sessionId)
      if (binding && binding.taskInstanceId === taskId) return binding
    }
    return null
  }

  function project(binding) {
    const taskId = binding.taskInstanceId
    const workspace = binding.workspace
    const ledger = readJson(path.join(workspace, '.ai-harness', 'state', 'tasks.json'))
    const runs = path.join(workspace, '.ai-harness', 'runs', String(binding.taskId || ''))
    const unreadable = ledger === null || (ledger !== undefined && (ledger.schemaVersion !== 1 || !Array.isArray(ledger.tasks)))
    const task = !unreadable && ledger ? ledger.tasks.find((item) => item && item.taskInstanceId === taskId) : undefined
    const attempts = readJsonLines(path.join(runs, 'attempts.jsonl')).filter((record) => record.taskId === binding.taskId)
    const latest = attempts.length ? attempts[attempts.length - 1] : null
    const evidence = readJson(path.join(runs, 'evidence.json'))
    const review = readJson(path.join(runs, 'review-result.json'))
    let status
    let reason = null
    if (unreadable) { status = 'blocked'; reason = 'ledger-unreadable' }
    else if (!task) { status = 'blocked'; reason = 'ledger-task-missing' }
    else if (Object.prototype.hasOwnProperty.call(LEGACY_STATUS, task.status)) status = LEGACY_STATUS[task.status]
    else { status = 'blocked'; reason = 'ledger-status-unknown:' + String(task.status) }
    const checks = evidence && Array.isArray(evidence.verification) ? evidence.verification : []
    const verificationState = !evidence ? (status === 'verifying' ? 'running' : 'pending')
      : checks.length && checks.every((check) => String(check.status || '').toUpperCase() === 'PASS') ? 'passed'
        : checks.some((check) => String(check.status || '').toUpperCase() === 'FAIL') ? 'failed' : 'pending'
    const reviewRequired = Boolean(binding.reviewRequired || (task && (task.reviewRequested || task.risk === 'critical')))
    const engine = binding.engine
    const view = {
      taskId,
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId || null,
      mode: MODE_OF_ENGINE[engine] || null,
      strategyId: (() => { try { return core.strategies.forEngine(engine).descriptor.id } catch { return null } })(),
      status,
      ...(reason ? { statusReason: reason } : {}),
      attemptId: latest ? String(latest.sequence) : null,
      attemptStatus: latest && typeof latest.status === 'string' ? latest.status : null,
      displayId: binding.taskId || null,
      verification: { state: verificationState, required: true, snapshotDigest: null, checks: checks.length },
      review: engine === 'muse'
        ? { state: 'not_required', required: false, policyReason: 'muse-engine-has-no-independent-reviewer' }
        : { state: review ? (review.verdict === 'pass' || review.passed === true ? 'passed' : 'findings') : (reviewRequired ? 'pending' : 'not_required'), required: reviewRequired },
      operatorActions: [],
      cohort: 'legacy',
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([task || null, latest, evidence || null, review || null, binding.executionClass, binding.needsRouteCheck])).digest('hex')
    const previous = projections.get(taskId)
    const revision = !previous ? 1 : previous.fingerprint === fingerprint ? previous.revision : previous.revision + 1
    const entry = { fingerprint, revision, view: Object.freeze({ ...view, revision: String(revision), updatedAt: new Date().toISOString() }) }
    if (!previous || previous.fingerprint !== fingerprint) projections.set(taskId, entry)
    return (projections.get(taskId) || entry).view
  }

  async function locate(principal, input) {
    const taskId = input && input.taskId
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return { error: fail('USAGE', 'taskId must be an opaque Nexus task id.') }
    if (MANAGED_TASK_ID.test(taskId)) {
      const record = core.intake ? core.intake.byTaskId(taskId) : null
      if (!record) {
        // A retained identity whose record is gone (deleted, lost): still a
        // managed task, reported as an explicit hold — never NOT_FOUND-as-free.
        const identity = core.intake && typeof core.intake.identityStatus === 'function' ? core.intake.identityStatus().find((item) => item.taskId === taskId && item.disposition === 'record-missing') : null
        if (identity && (principal.kind === 'internal' || (identity.workspacePath && await workspaceAllowed(principal, { workspace: identity.workspacePath })))) return { orphan: identity }
        metrics.notFound += 1
        return { error: fail('NOT_FOUND', 'No authorized task with that id.') }
      }
      if (!(await workspaceAllowed(principal, { workspace: record.canonical.workspacePath }))) { metrics.notFound += 1; return { error: fail('NOT_FOUND', 'No authorized task with that id.') } }
      return { record }
    }
    const binding = bindingForTask(taskId)
    if (!binding || !(await workspaceAllowed(principal, binding))) { metrics.notFound += 1; return { error: fail('NOT_FOUND', 'No authorized task with that id.') } }
    return { binding }
  }

  /**
   * Managed task view: the intake state and live broker actions overlaid on
   * the legacy projection of the bound TaskController task. Completion is
   * still only the TaskController ledger's `complete`.
   */
  function projectManaged(taskId) {
    const record = core.intake.byTaskId(taskId)
    const binding = record.taskInstanceId ? bindingForTask(record.taskInstanceId) : null
    const base = binding ? project(binding) : null
    const actions = core.broker ? core.broker.pendingFor(taskId) : []
    let status
    let reason = null
    const health = core.sessionHealth ? core.sessionHealth.peek(record.sessionId) : null
    const verifying = Boolean(core.managedTasks && core.managedTasks.isVerifying && core.managedTasks.isVerifying(taskId))
    const turn = managedTasksModule.currentTurn(record)
    const reviewing = Boolean(core.managedTasks && core.managedTasks.isReviewing && core.managedTasks.isReviewing(taskId))
    const snapshot = binding ? gateSnapshot(record, binding) : null
    const vstate = record.verification ? record.verification.state : null
    // An operator close is final: identity, intake and tombstone stay.
    if (record.closedAt) { status = vstate === 'failed' ? 'failed' : 'cancelled'; reason = 'operator-closed' }
    else if (health && health.state === 'held') { status = 'blocked'; reason = health.reason }
    else if (record.state === 'failed') { status = 'failed'; reason = record.failure ? record.failure.code : 'intake-failed' }
    else if (record.cancelledAt || (record.state === 'parked' && record.hold && record.hold.reason === 'cancelled-before-delivery')) status = 'cancelled'
    else if (record.cancelRequestedAt) status = 'cancelling'
    else if (record.state === 'parked') { reason = record.hold ? record.hold.reason : 'held'; status = reason === 'interrupted' ? 'interrupted' : 'blocked' }
    else if (record.state !== 'accepted') status = 'queued'
    else if (actions.length) status = 'awaiting_operator'
    else if (core.managedTasks && core.managedTasks.isTurnLive(record.sessionId)) status = base && ['verifying', 'completed', 'failed'].includes(base.status) ? base.status : 'running'
    // P2-B2E: a continuation being delivered (intent durable, not yet accepted).
    else if (turn && turn.state !== 'accepted') { status = 'queued'; reason = 'continuation-delivering' }
    else if (!turn || !turn.executionStartedAt) status = 'accepted'
    // A managed verification in flight is reported until its outcome is
    // durable: the ledger can turn terminal mid-pipeline (failure recorded
    // before the outcome annotation), which must not end `wait` early.
    else if (verifying || vstate === 'running') status = 'verifying'
    // P2-B2F: an explicitly requested review of the current candidate.
    else if (reviewing || (record.review && record.review.state === 'running')) { status = 'verifying'; reason = 'review-running' }
    // Completion is the TaskController ledger's decision only.
    else if (base && TERMINAL.has(base.status)) { status = base.status; if (base.status === 'failed' && vstate === 'failed') reason = 'verification-failed' }
    else if (vstate === 'failed') { status = 'blocked'; reason = 'verification-failed' }
    else if (vstate === 'incomplete' || vstate === 'interrupted') { status = 'blocked'; reason = 'verification-incomplete' }
    else if (vstate === 'rejected') { status = 'blocked'; reason = 'verification-rejected' }
    else if (vstate === 'passed') { status = 'blocked'; reason = completionDeniedReason(record, snapshot) }
    else if (base && base.status === 'blocked') { status = 'blocked'; reason = base.statusReason || null }
    // A turn that ended in an error (e.g. a missing provider credential) is a
    // failed attempt; report the error instead of a generic hold.
    else if (turn.turnEndReason === 'error') { status = 'failed'; reason = 'turn-error' }
    // A successful turn without ledger completion: work done, verification
    // pending (or another explicitly requested turn).
    else if (turn.turnEndReason === 'completed') { status = 'blocked'; reason = 'turn-completed-awaiting-verification' }
    else if (!turn.turnEndedAt) status = 'running'
    else { status = 'blocked'; reason = 'turn-ended-without-ledger-completion' }
    const derived = derivedActions(record, { status, reason, base, verifying, snapshot, turn, reviewing })
    const allActions = [...actions, ...derived]
    const view = {
      taskId,
      sessionId: record.sessionId,
      workspaceId: record.canonical.workspaceId,
      mode: record.canonical.mode,
      strategyId: base ? base.strategyId : null,
      status,
      ...(reason ? { statusReason: reason } : {}),
      attemptId: base ? base.attemptId : null,
      displayId: record.displayId || null,
      verification: base ? base.verification : { state: 'pending', required: true, snapshotDigest: null, checks: 0 },
      review: base ? base.review : { state: 'not_required', required: false },
      operatorActions: allActions,
      intake: { state: record.state, acceptedAt: record.acceptedAt || null, hold: record.hold ? record.hold.reason : null },
      ...(record.verification ? { taskVerification: verificationView(record.verification) } : {}),
      ...(record.closedAt ? { closed: { at: record.closedAt, reason: record.closeReason || null, attemptClosed: Boolean(record.attemptClosed) } } : {}),
      ...(reason && HOLD_GUIDANCE[reason] ? { guidance: HOLD_GUIDANCE[reason] } : {}),
      ...(health ? { sessionHealth: { state: health.state, reason: health.reason, repair: health.repair } } : {}),
      ...(turn && turn.turnEndedAt ? { turn: { endedAt: turn.turnEndedAt, reason: turn.turnEndReason || null, ...(turn.turnError ? { error: turn.turnError } : {}) } } : {}),
      turns: { total: managedTasksModule.turnsOf(record).filter((item) => item.acceptedAt).length, current: managedTasksModule.publicTurn(turn) },
      continuation: continuationView(record, { status, base, health }),
      ...(snapshot ? { gates: { review: reviewView(record, snapshot, turn), gate: snapshot.gate, visual: snapshot.visual } } : {}),
      // Completion provenance (only for a TaskController-completed task):
      // the authority, the verification it rests on and the review basis.
      ...(status === 'completed' ? { completionProvenance: {
        authority: 'task-controller',
        ledgerStatus: snapshot ? snapshot.ledgerStatus : (base ? 'complete' : null),
        verification: record.verification ? { state: record.verification.state, checks: record.verification.checks || null, attempt: record.verification.attempt || null } : null,
        reviewBasis: snapshot ? reviewDisposition(record, snapshot, turn) : 'not-required',
        ...(snapshot && snapshot.gate && snapshot.gate.status === 'approved' ? { gate: { gateId: snapshot.gate.gateId, revision: snapshot.gate.revision, resolvedBy: snapshot.gate.resolvedBy, resolvedAt: snapshot.gate.resolvedAt, reviewVerdict: snapshot.gate.reviewVerdict } } : {}),
      } } : {}),
      cohort: 'managed',
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([record.revision, record.state, base ? base.revision : null, status, reason, allActions.map((action) => action.id), view.continuation.allowed, snapshot ? [snapshot.gate, snapshot.visual && [snapshot.visual.status, snapshot.visual.iteration], snapshot.reviewOnDisk, snapshot.ledgerStatus] : null, record.review ? record.review.state : null])).digest('hex')
    const previous = projections.get(taskId)
    const revision = !previous ? 1 : previous.fingerprint === fingerprint ? previous.revision : previous.revision + 1
    // Derived actions are bound to the view revision (stale answers refused).
    const bound = allActions.map((action) => (action.derived ? Object.freeze({ ...action, revision: String(revision) }) : action))
    const entry = { fingerprint, revision, view: Object.freeze({ ...view, operatorActions: bound, revision: String(revision), updatedAt: new Date().toISOString() }) }
    if (!previous || previous.fingerprint !== fingerprint) projections.set(taskId, entry)
    return (projections.get(taskId) || entry).view
  }
  /**
   * P2-B2F read-only gate snapshot of the bound TaskController task: the
   * engine's review policy (strategy capability), the review requirement and
   * the review result for this lifecycle instance, the current controller
   * review gate (journal) and the visual loop state. Nothing here decides
   * completion; it explains it and derives the advertised operator actions.
   */
  function gateSnapshot(record, binding) {
    if (!binding || !binding.workspace || !binding.taskId) return null
    const instance = binding.taskInstanceId
    const runs = path.join(binding.workspace, '.ai-harness', 'runs', String(binding.taskId))
    const ledger = readJson(path.join(binding.workspace, '.ai-harness', 'state', 'tasks.json'))
    const task = ledger && Array.isArray(ledger.tasks) ? ledger.tasks.find((item) => item && item.taskInstanceId === instance) : null
    let independentReview = false
    try { independentReview = Boolean(core.strategies.forEngine(binding.engine).descriptor.capabilities.independentReview) } catch { independentReview = false }
    const reviewRequired = Boolean(task && (task.risk === 'critical' || task.reviewRequested === true || String(task.executionClassOverride || '') === 'reviewer'))
    const reviewFile = readJson(path.join(runs, 'review-result.json'))
    const reviewOnDisk = reviewFile && (!reviewFile.taskInstanceId || reviewFile.taskInstanceId === instance) ? { verdict: String(reviewFile.verdict || ''), completedAt: reviewFile.completedAtUtc || null } : null
    const normalized = path.resolve(binding.workspace)
    let gate = null
    for (const item of readJsonLines(path.join(core.dataRoot || '', 'completion', 'gates.jsonl'))) {
      if (!item || item.sessionId !== record.sessionId || String(item.taskId) !== String(binding.taskId)) continue
      if (typeof item.workspace !== 'string' || path.resolve(item.workspace) !== normalized) continue
      if (instance && item.taskInstanceId !== instance) continue
      gate = item
    }
    const visualState = readJson(path.join(runs, 'visual', 'state.json'))
    const visual = visualState && typeof visualState === 'object'
      ? { required: visualState.required === true, requirement: visualState.requirement || null, status: String(visualState.status || 'unknown'), iteration: Number.isInteger(visualState.iteration) ? visualState.iteration : 0, maxIterations: Number.isInteger(visualState.maxIterations) ? visualState.maxIterations : null, reasons: Array.isArray(visualState.reasons) ? visualState.reasons.slice(-3).map((item) => String(item).slice(0, 200)) : [], updatedAt: visualState.updatedAtUtc || null }
      : null
    return {
      reviewPolicy: independentReview ? 'independent-review' : 'unavailable-for-engine',
      reviewRequired,
      reviewOnDisk,
      gate: gate ? { gateId: gate.gateId, status: gate.status, revision: gate.revision, attempt: gate.attempt, reviewVerdict: gate.reviewVerdict || null, resolvedBy: gate.resolvedBy || null, createdAt: gate.createdAtUtc || null, resolvedAt: gate.resolvedAtUtc || null } : null,
      visual,
      ledgerStatus: task ? task.status : null,
    }
  }
  /**
   * Review provenance, kept distinct from completion: what the independent
   * reviewer said for this candidate versus what the operator decided at the
   * existing gate. An approved gate over a reviewer FAIL is an operator
   * override (Control Room policy); it is never reported as a reviewer PASS,
   * even though the TaskController records that completion with its
   * review-passed flag.
   */
  function reviewDisposition(record, snapshot, turn) {
    const review = record.review || null
    const current = Boolean(review && turn && review.turnId === turn.turnId)
    const gate = snapshot && snapshot.gate
    const verdict = current ? review.verdict : null
    if (current && verdict === 'fail' && gate && gate.status === 'approved') return 'operator-override-of-reviewer-fail'
    if (current && verdict === 'fail' && gate && gate.status === 'rejected') return 'reviewer-fail-gate-rejected'
    if (current && verdict === 'fail') return 'reviewer-fail'
    if (current && verdict === 'pass') return 'reviewer-pass'
    if (current && verdict) return 'reviewer-' + verdict
    if (review && !current && ['passed', 'failed', 'uncertain'].includes(review.state)) return 'stale-review-ignored'
    return snapshot && snapshot.reviewPolicy === 'unavailable-for-engine' ? 'not-available-for-engine' : snapshot && snapshot.reviewRequired ? 'missing' : 'not-required'
  }
  function reviewView(record, snapshot, turn) {
    if (!snapshot) return null
    const review = record.review || null
    const current = Boolean(review && turn && review.turnId === turn.turnId)
    return {
      policy: snapshot.reviewPolicy,
      required: snapshot.reviewRequired,
      disposition: reviewDisposition(record, snapshot, turn),
      ...(review ? { state: review.state, verdict: review.verdict || null, attempt: review.attempt || null, current, findings: Number.isInteger(review.findings) ? review.findings : null, blockingFindings: Number.isInteger(review.blockingFindings) ? review.blockingFindings : null, startedAt: review.startedAt || null, finishedAt: review.finishedAt || null, ...(review.reason ? { reason: review.reason } : {}) } : { state: snapshot.reviewPolicy === 'unavailable-for-engine' ? 'unavailable' : 'not-run' }),
    }
  }

  /** P2-B2E: whether another explicitly requested user turn is allowed now. */
  function continuationView(record, { status, base, health }) {
    if (!core.managedTasks || typeof core.managedTasks.continuationRefusal !== 'function') return { allowed: false, reason: 'continuation-unavailable' }
    if (core.admission && core.admission.state !== 'active') return { allowed: false, reason: 'managed-admission-inactive' }
    const reason = core.managedTasks.continuationRefusal(record, { healthHeld: health && health.state === 'held' ? health.reason : null, terminal: Boolean(base && TERMINAL.has(base.status)) || TERMINAL.has(status) })
    return reason ? { allowed: false, reason } : { allowed: true }
  }
  /**
   * P2-B2D operator actions derived from durable state (not broker requests):
   *   run-verification  executed turn ended normally, attempt still `started`,
   *                     no verification running/recorded -> the existing
   *                     /verify pipeline through the plane bridge;
   *   close-task        a held or stalled task (interrupted, restored input,
   *                     delivery holds, historical damage, verification
   *                     incomplete/rejected, completion denied, awaiting
   *                     verification) -> closed, nothing resumes.
   * Never offered: resume of an interrupted turn, re-verification after an
   * outcome, anything on a live turn or a completed/failed/cancelled task.
   */
  /** Why the TaskController denied completion after a passed verification. */
  function completionDeniedReason(record, snapshot) {
    if (!snapshot) return 'completion-denied'
    const visual = snapshot.visual
    // The completion tail stops at an unsatisfied visual requirement before
    // the review gate is considered, so visual is reported first.
    if (visual && visual.required && visual.status !== 'pass') return ['revise', 'exhausted', 'unavailable'].includes(visual.status) ? 'visual-' + visual.status : 'visual-pending'
    const gate = snapshot.gate
    const reviewCurrent = Boolean(core.managedTasks && core.managedTasks.reviewIsCurrent && core.managedTasks.reviewIsCurrent(record)) && !(record.verification && record.verification.reviewUsable === false)
    if (gate && reviewCurrent && gate.status === 'approved') return 'review-approved-completion-pending'
    if (gate && reviewCurrent && gate.status === 'waiting') return 'review-gate-pending'
    if (gate && reviewCurrent && gate.status === 'rejected') return 'review-rejected'
    if (snapshot.reviewRequired) return 'review-required'
    return 'completion-denied'
  }

  function derivedActions(record, { status, reason, base, verifying, snapshot, turn, reviewing }) {
    if (!core.managedTasks || record.closedAt || verifying || reviewing || record.state === 'failed') return []
    if (core.managedTasks.isTurnLive(record.sessionId) || ['completed', 'failed', 'cancelled', 'cancelling', 'running', 'verifying', 'accepted', 'queued'].includes(status)) return []
    const list = []
    const attempt = base && base.attemptId ? base.attemptId : null
    // P2-B2F: explicit independent review of the current candidate — only
    // where the engine's strategy has an independent reviewer (EMv1 Dual).
    // A verdict-producing review is not repeated for the same candidate; an
    // incomplete/interrupted/rejected one may be re-run explicitly.
    if (status === 'blocked' && reason === 'turn-completed-awaiting-verification' && attempt && base.attemptStatus === 'started' && !record.verification && snapshot && snapshot.reviewPolicy === 'independent-review' && turn) {
      const prior = record.review && record.review.turnId === turn.turnId ? record.review : null
      if (!prior || ['incomplete', 'interrupted', 'rejected', 'unavailable'].includes(prior.state)) {
        const run = prior ? (prior.runs || 1) + 1 : 1
        list.push({ id: 'act_review_' + taskShort(record.taskId) + '_t' + turn.seq + '_n' + run, kind: 'review', label: 'Run the independent review of the current candidate (turn ' + turn.seq + ', attempt ' + attempt + '; existing reviewer; read-only; one reviewer request)' + (prior ? ' — re-run: the previous review produced no verdict (' + prior.state + ')' : ''), choices: [{ id: 'run', label: 'Run review' }], attempt, derived: true })
      }
    }
    // P2-B2F: the existing review gate after a passed verification of the
    // current candidate (gate journal is the authority).
    if (status === 'blocked' && reason === 'review-gate-pending' && snapshot && snapshot.gate) {
      list.push({ id: 'act_gate_' + String(snapshot.gate.gateId).replace(/^gate-/, '').slice(0, 12) + '_r' + snapshot.gate.revision, kind: 'gate', label: 'Review gate (verdict ' + String(snapshot.gate.reviewVerdict || 'fail').toUpperCase() + '): approve = complete with the review overridden by the operator (Control Room policy); reject = keep completion blocked', choices: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], gateId: snapshot.gate.gateId, derived: true })
    }
    if (status === 'blocked' && reason === 'review-approved-completion-pending' && snapshot && snapshot.gate) {
      list.push({ id: 'act_complete_' + String(snapshot.gate.gateId).replace(/^gate-/, '').slice(0, 12) + '_r' + snapshot.gate.revision, kind: 'completion', label: 'Re-run the TaskController completion check for the approved review gate', choices: [{ id: 'run', label: 'Run completion check' }], gateId: snapshot.gate.gateId, derived: true })
    }
    if (status === 'blocked' && reason === 'turn-completed-awaiting-verification' && attempt && base.attemptStatus === 'started' && !record.verification) {
      list.push({ id: 'act_verify_' + taskShort(record.taskId) + '_a' + attempt, kind: 'verification', label: 'Run Nexus verification for attempt ' + attempt + ' (existing /verify pipeline; the TaskController decides completion)', choices: [{ id: 'run', label: 'Run verification' }], attempt, derived: true })
    }
    if (status === 'blocked' || status === 'interrupted') {
      list.push({ id: 'act_close_' + taskShort(record.taskId) + '_r' + record.revision, kind: 'recovery', label: 'Close this task (' + (reason || status) + '): nothing resumes; identity and history are kept', choices: [{ id: 'close', label: 'Close task' }], derived: true })
    }
    return list
  }
  function taskShort(taskId) { return String(taskId).replace(/^nt_/, '').slice(0, 12) }
  function verificationView(v) {
    return { state: v.state, attempt: v.attempt || null, startedAt: v.startedAt || null, finishedAt: v.finishedAt || null, ...(v.checks ? { checks: v.checks } : {}), ...(v.failingChecks ? { failingChecks: v.failingChecks } : {}), ...(v.completion ? { completion: v.completion } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(v.evidencePath ? { evidencePath: v.evidencePath } : {}) }
  }
  const orphanView = (identity) => Object.freeze({
    taskId: identity.taskId, sessionId: identity.sessionId, workspaceId: null, mode: null, strategyId: null,
    status: 'blocked', statusReason: 'intake-record-missing', attemptId: null, displayId: null,
    verification: { state: 'unavailable', required: true, snapshotDigest: null, checks: 0 }, review: { state: 'not_required', required: false },
    operatorActions: [], intake: { state: 'record-missing', acceptedAt: null, hold: 'intake-record-missing' }, guidance: HOLD_GUIDANCE['intake-record-missing'], cohort: 'managed', revision: '1', updatedAt: new Date().toISOString(),
  })
  const viewOf = (located) => located.orphan ? orphanView(located.orphan) : located.record ? projectManaged(located.record.taskId) : project(located.binding)
  // Fill the session-health cache before projecting a managed task, so a held
  // history is never reported as a healthy task.
  async function ensureHealth(located) {
    if (located && located.record && core.sessionHealth) { try { await core.sessionHealth.check(located.record.sessionId) } catch { /* projection stays as is */ } }
  }
  // Read-only enrichment (outside the revision fingerprint): Nexus's last reply.
  async function withReply(view) {
    if (!view || view.cohort !== 'managed' || !core.managedTasks || view.status === 'queued') return view
    const reply = await core.managedTasks.lastReply(view.sessionId)
    return reply ? { ...view, reply } : view
  }

  function hello(principal) {
    const denied = authorize(principal, 'hello'); if (denied) return denied
    const readiness = core.readiness()
    const active = core.admission.state === 'active'
    return ok({
      negotiatedMajor: SCHEMA_MAJOR,
      controllerBuild: core.build,
      ready: readiness.ready,
      ownership: { state: readiness.ownership.state, enforced: readiness.ownership.enforced, generation: readiness.ownership.generation || null },
      transport: readiness.transport ? readiness.transport.state : 'none',
      operations: active ? ['hello', 'listModes', 'getStatus', 'getResult', 'follow', 'submit', 'continueTask', 'cancel', 'respond'] : ['hello', 'listModes', 'getStatus', 'getResult', 'follow', 'cancel', 'respond'],
      refusedOperations: active ? [] : ['submit'],
      managedAdmission: core.admission.state,
      managedBlockedBy: active ? [] : core.activation ? core.activation().problems : ['managed-intake-not-configured'],
    })
  }

  function listModes(principal) {
    const denied = authorize(principal, 'listModes'); if (denied) return denied
    const rows = core.readiness().strategies
    const active = core.admission.state === 'active'
    return ok({
      modes: rows.filter((row) => row.engines.some((engine) => MODE_OF_ENGINE[engine])).map((row) => {
        const id = MODE_OF_ENGINE[row.engines.find((engine) => MODE_OF_ENGINE[engine])]
        const profile = active && row.ready ? core.managedTasks.modeProfile(id) : null
        const blockedReason = !active ? 'managed-admission-disabled' : !row.ready ? 'strategy-not-ready' : !profile ? 'mode-profile-unresolved' : null
        return { id, strategyId: row.id, ready: row.ready, submittable: blockedReason === null, blockedReason }
      }),
    })
  }

  async function getStatus(principal, input) {
    const denied = authorize(principal, 'getStatus'); if (denied) return denied
    metrics.reads += 1
    const located = await locate(principal, input); if (located.error) return located.error
    await ensureHealth(located)
    return ok(await withReply(viewOf(located)))
  }

  async function getResult(principal, input) {
    const denied = authorize(principal, 'getResult'); if (denied) return denied
    metrics.reads += 1
    const located = await locate(principal, input); if (located.error) return located.error
    await ensureHealth(located)
    const view = await withReply(viewOf(located))
    const outcome = TERMINAL.has(view.status) ? view.status : 'pending'
    return ok({ ...view, outcome, summary: view.reply ? view.reply.text : null, artifacts: [] })
  }

  async function follow(principal, input) {
    const denied = authorize(principal, 'follow'); if (denied) return denied
    metrics.follows += 1
    const located = await locate(principal, input); if (located.error) return located.error
    await ensureHealth(located)
    const after = input.afterRevision === undefined ? null : String(input.afterRevision)
    if (after !== null && !/^\d+$/.test(after)) return fail('USAGE', 'afterRevision must be a decimal string.')
    const waitMs = Math.max(0, Math.min(Number.isFinite(input.waitMs) ? input.waitMs : 0, 30000))
    const deadline = Date.now() + waitMs
    for (;;) {
      const view = viewOf(located)
      if (after === null || view.revision !== after || TERMINAL.has(view.status)) return ok({ view: await withReply(view), unchanged: false })
      if (Date.now() >= deadline) return ok({ unchanged: true, revision: view.revision })
      if (core.closed) return fail('HOST_NOT_READY', 'The Nexus Controller is shutting down.', true)
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))))
    }
  }

  function refused(principal, operation) {
    const denied = authorize(principal, operation); if (denied) return denied
    metrics.refusedMutations += 1
    const problems = core.activation ? core.activation().problems : ['managed-intake-not-configured']
    return fail('REQUIRED_CAPABILITY_UNAVAILABLE', `${operation} is not available: managed Nexus submission stays disabled until every activation gate passes.`, false, { reason: 'managed-admission-disabled', problems })
  }

  /** submit — only through the managed engine, only with activation active. */
  async function submit(principal, input) {
    const denied = authorize(principal, 'submit'); if (denied) return denied
    if (!core.managedTasks || core.admission.state !== 'active') return refused(principal, 'submit')
    const result = await core.managedTasks.submit(OWNER_PRINCIPAL_ID, input || {})
    if (result.ok) return ok(result.data)
    if (result.code === 'REQUIRED_CAPABILITY_UNAVAILABLE') metrics.refusedMutations += 1
    return fail(result.code, result.message, Boolean(result.retryable), result.details)
  }

  /**
   * continueTask — one more user turn in an existing managed task (P2-B2E).
   * Same internal operation for IPC (CLI) and the GUI task route. The expected
   * revision is checked synchronously immediately before the durable
   * reservation, so continuation, run-verification and close arbitrate
   * atomically: only one wins for a given task revision.
   */
  async function continueTask(principal, input) {
    const denied = authorize(principal, 'continueTask'); if (denied) return denied
    if (!core.managedTasks || core.admission.state !== 'active') return refused(principal, 'continueTask')
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['taskId', 'idempotencyKey', 'prompt', 'expectedRevision'].includes(key))) return fail('USAGE', 'continueTask accepts taskId, idempotencyKey, prompt and expectedRevision only.')
    if (typeof input.expectedRevision !== 'string' || !/^\d+$/.test(input.expectedRevision)) return fail('USAGE', 'continueTask needs a decimal expectedRevision (from getStatus).')
    const located = await locate(principal, input); if (located.error) return located.error
    if (located.orphan) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'The task\'s intake record is missing; no turn is possible until it is restored.', false, { reason: 'intake-record-missing' })
    if (!located.record) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'continue is available for Nexus-managed tasks only.', false, { reason: 'legacy-task' })
    await ensureHealth(located)
    const taskId = located.record.taskId
    const health = core.sessionHealth ? core.sessionHealth.peek(located.record.sessionId) : null
    let view = null
    const result = await core.managedTasks.continueTask(OWNER_PRINCIPAL_ID, taskId, { idempotencyKey: input.idempotencyKey, prompt: input.prompt }, {
      healthHeld: health && health.state === 'held' ? health.reason : null,
      precheck() {
        view = projectManaged(taskId)
        if (input.expectedRevision !== view.revision) return { ok: false, code: 'STALE_ACTION', message: 'The task changed since revision ' + input.expectedRevision + ' (now ' + view.revision + ').', details: { revision: view.revision } }
        return TERMINAL.has(view.status) && view.status !== 'interrupted' ? { ok: false, code: 'TASK_NOT_CONTINUABLE', message: 'The task is ' + view.status + '; start a new task.', details: { reason: 'task-terminal', status: view.status } } : null
      },
    })
    if (!result.ok) return fail(result.code, result.message, Boolean(result.retryable), result.details)
    const after = projectManaged(taskId)
    return ok({ ...result.data, revision: after.revision, taskStatus: after.status })
  }

  /**
   * registerWorkspace — owner-only: register an existing directory with the
   * DSH workspace registry (idempotent; canonical realpath). Grants no other
   * principal anything; required before `submit` can target the directory.
   */
  async function registerWorkspace(principal, input) {
    const denied = authorize(principal, 'registerWorkspace'); if (denied) return denied
    const target = input && input.path
    if (typeof target !== 'string' || !path.isAbsolute(target)) return fail('USAGE', 'path must be an absolute directory path.')
    if (typeof core.workspaceRegistrar !== 'function') return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'workspace registration is unavailable on this host.')
    try {
      const result = await core.workspaceRegistrar(target)
      return ok({ workspaceId: result.workspaceId, path: result.path, disposition: result.disposition })
    } catch (error) {
      return fail('WORKSPACE_INVALID', String(error && error.message ? error.message : error).slice(0, 300))
    }
  }

  /**
   * Credentials — owner-only, through DSH's own credentials controller (the
   * service behind the GUI Models page). Values are write-only: no response,
   * log or error ever contains one. Changes are refused while a managed task is
   * live or pending (a running task must not have its provider swapped).
   */
  function credentialsPort() { return typeof core.credentials === 'object' && core.credentials ? core.credentials : null }
  function credentialMutationBlocked() {
    return core.admission && typeof core.admission.activeManagedSessions === 'function' && core.admission.activeManagedSessions().length > 0
  }
  async function listCredentials(principal, input) {
    const denied = authorize(principal, 'listCredentials'); if (denied) return denied
    const refs = input && input.refs !== undefined ? input.refs : DEFAULT_CREDENTIAL_REFS
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > 32 || refs.some((ref) => typeof ref !== 'string' || !CREDENTIAL_REF.test(ref))) return fail('USAGE', 'refs must be 1-32 credential names (letters, digits, underscore).')
    const port = credentialsPort(); if (!port) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'the credentials service is unavailable on this host.')
    try {
      const described = await port.describe([...new Set(refs)])
      return ok({ credentials: [...new Set(refs)].map((ref) => ({ ref, configured: Boolean(described[ref] && described[ref].configured), source: described[ref] && described[ref].source ? String(described[ref].source) : null, writable: Boolean(described[ref] && described[ref].writable) })) })
    } catch (error) { return fail('INTERNAL', 'credentials could not be described.') }
  }
  async function setCredential(principal, input) {
    const denied = authorize(principal, 'setCredential'); if (denied) return denied
    const ref = input && input.ref
    const value = input && input.value
    if (typeof ref !== 'string' || !CREDENTIAL_REF.test(ref)) return fail('USAGE', 'ref must be a credential name (letters, digits, underscore).')
    if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES || /[\u0000\r\n]/.test(value)) return fail('USAGE', 'value must be one non-empty line of at most 16 KiB.')
    if (credentialMutationBlocked()) return fail('FORBIDDEN', 'credentials cannot change while a Nexus task is running.', false, { reason: 'nexus-host-protected-while-active' })
    const port = credentialsPort(); if (!port) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'the credentials service is unavailable on this host.')
    try { await port.set(ref, value) } catch { return fail('CREDENTIAL_REJECTED', 'the credentials service refused the value for ' + ref + '.') }
    let configured = true
    try { const described = await port.describe([ref]); configured = Boolean(described[ref] && described[ref].configured) } catch { /* best effort */ }
    return ok({ ref, configured, disposition: 'stored' })
  }
  async function unsetCredential(principal, input) {
    const denied = authorize(principal, 'unsetCredential'); if (denied) return denied
    const ref = input && input.ref
    if (typeof ref !== 'string' || !CREDENTIAL_REF.test(ref)) return fail('USAGE', 'ref must be a credential name (letters, digits, underscore).')
    if (credentialMutationBlocked()) return fail('FORBIDDEN', 'credentials cannot change while a Nexus task is running.', false, { reason: 'nexus-host-protected-while-active' })
    const port = credentialsPort(); if (!port) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'the credentials service is unavailable on this host.')
    try { await port.unset(ref) } catch { return fail('CREDENTIAL_REJECTED', 'the credentials service refused to remove ' + ref + '.') }
    return ok({ ref, configured: false, disposition: 'removed' })
  }

  /**
   * checkSession — read-only history check for one stored session (no agent is
   * activated, nothing is written). Concealed unless the session's workspace is
   * authorized, like task reads.
   */
  async function checkSession(principal, input) {
    const denied = authorize(principal, 'checkSession'); if (denied) return denied
    const sessionId = input && input.sessionId
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return fail('USAGE', 'sessionId is required.')
    if (!core.sessionHealth) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'session checks are unavailable on this host.')
    if (principal.kind !== 'internal') {
      const record = core.intake ? core.intake.bySessionId(sessionId) : null
      const binding = core.bindings.read(sessionId)
      const workspace = record ? record.canonical.workspacePath : binding ? binding.workspace : await core.sessionHealth.cwdOf(sessionId)
      if (!workspace || !(await workspaceAllowed(principal, { workspace }))) { metrics.notFound += 1; return fail('NOT_FOUND', 'No authorized session with that id.') }
    }
    const result = await core.sessionHealth.check(sessionId)
    if (result.state === 'unknown') return fail('NOT_FOUND', 'No stored session with that id.')
    return ok({ sessionId, state: result.state, reason: result.reason, repair: result.repair, source: result.source, managed: Boolean(core.admission && core.admission.isManaged(sessionId)) })
  }

  /** cancel — managed tasks only (legacy GUI tasks keep their own controls). */
  async function cancel(principal, input) {
    const denied = authorize(principal, 'cancel'); if (denied) return denied
    const located = await locate(principal, input); if (located.error) return located.error
    if (located.orphan) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'the task\'s intake record is missing; it is held until the record is restored.', false, { reason: 'intake-record-missing' })
    if (!located.record) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'cancel is available for Nexus-managed tasks only.', false, { reason: 'legacy-task' })
    const result = await core.managedTasks.cancel(located.record.taskId)
    if (!result.ok) return fail(result.code, result.message)
    const view = projectManaged(located.record.taskId)
    return ok({ taskId: view.taskId, revision: view.revision, status: view.status, disposition: result.data.disposition })
  }

  /** respond — first valid authorized answer to a live broker action wins. */
  async function respond(principal, input) {
    const denied = authorize(principal, 'respond'); if (denied) return denied
    if (!input || typeof input.actionId !== 'string' || typeof input.choiceId !== 'string' || typeof input.expectedRevision !== 'string' || !/^\d+$/.test(input.expectedRevision)) return fail('USAGE', 'respond needs taskId, actionId, decimal expectedRevision and choiceId.')
    const located = await locate(principal, input); if (located.error) return located.error
    if (located.orphan) return fail('REQUIRED_CAPABILITY_UNAVAILABLE', 'The task\'s intake record is missing; no action is possible until it is restored.', false, { reason: 'intake-record-missing' })
    if (!located.record || !core.broker) return fail('NOT_FOUND', 'No such operator action.')
    const responder = principal.kind === 'internal' ? { kind: 'local-owner', via: 'internal', capabilities: ['tasks:respond'] } : principal
    if (/^act_(verify|close|review|gate|complete)_/.test(input.actionId)) return respondDerived(responder, located.record, input)
    const result = core.broker.respond(responder, { taskId: located.record.taskId, actionId: input.actionId, expectedRevision: input.expectedRevision, choiceId: input.choiceId })
    if (!result.ok) return fail(result.code, result.code === 'STALE_ACTION' ? 'The operator action is no longer pending at that revision.' : result.code === 'USAGE' ? 'Unknown choice for that action.' : 'No such operator action.')
    const view = projectManaged(located.record.taskId)
    return ok({ taskId: view.taskId, actionId: input.actionId, revision: view.revision, disposition: result.disposition })
  }

  /** Revision-checked answer to a Controller-derived action (verification, close). */
  async function respondDerived(principal, located, input) {
    await ensureHealth({ record: located })
    // Re-read after the await: a concurrent answer may have just been accepted.
    const record = core.intake.byTaskId(located.taskId)
    // Duplicate of an already-accepted answer: the prior receipt.
    if (record.verification && record.verification.actionId === input.actionId && input.choiceId === 'run') return ok({ taskId: record.taskId, actionId: input.actionId, revision: projectManaged(record.taskId).revision, disposition: 'duplicate' })
    if (record.closedAt && record.closeActionId === input.actionId && input.choiceId === 'close') return ok({ taskId: record.taskId, actionId: input.actionId, revision: projectManaged(record.taskId).revision, disposition: 'duplicate' })
    if (record.review && record.review.actionId === input.actionId && input.choiceId === 'run') return ok({ taskId: record.taskId, actionId: input.actionId, revision: projectManaged(record.taskId).revision, disposition: 'duplicate', review: record.review.state })
    if (record.gateAction && record.gateAction.actionId === input.actionId && record.gateAction.state !== 'running') return ok({ taskId: record.taskId, actionId: input.actionId, revision: projectManaged(record.taskId).revision, disposition: 'duplicate', gateStatus: record.gateAction.gateStatus || null })
    const view = projectManaged(record.taskId)
    const action = view.operatorActions.find((item) => item.id === input.actionId)
    if (!action) return fail('STALE_ACTION', 'That operator action is not offered for the task\'s current state.')
    if (input.expectedRevision !== view.revision) return fail('STALE_ACTION', 'The task changed since that action was offered (revision ' + view.revision + ').')
    if (!action.choices.some((choice) => choice.id === input.choiceId)) return fail('USAGE', 'Unknown choice for that action.')
    const operator = principal.via || principal.kind
    if (action.kind === 'verification') {
      const started = core.managedTasks.runVerification(record.taskId, { actionId: action.id, attempt: action.attempt, operator })
      if (!started.ok) return fail(started.code || 'STALE_ACTION', started.reason === 'verification-in-progress' ? 'Verification is already running for this task.' : 'Verification could not start.', false, started.reason ? { reason: started.reason } : undefined)
      return ok({ taskId: record.taskId, actionId: action.id, revision: projectManaged(record.taskId).revision, disposition: 'accepted', verification: 'running' })
    }
    if (action.kind === 'review') {
      const started = core.managedTasks.runReview(record.taskId, { actionId: action.id, attempt: action.attempt, operator })
      if (!started.ok) return fail(started.code || 'STALE_ACTION', 'The review could not start (' + (started.reason || 'refused') + ').', false, started.reason ? { reason: started.reason } : undefined)
      return ok({ taskId: record.taskId, actionId: action.id, revision: projectManaged(record.taskId).revision, disposition: 'accepted', review: 'running' })
    }
    if (action.kind === 'gate' || action.kind === 'completion') {
      const resolved = await core.managedTasks.resolveGateAction(record.taskId, { actionId: action.id, gateId: action.gateId, choice: action.kind === 'completion' ? 'approve' : input.choiceId, mode: action.kind === 'completion' ? 'complete-approved' : 'resolve', operator })
      if (!resolved.ok) return fail(resolved.code || 'STALE_ACTION', 'The gate action did not apply (' + (resolved.gateAction && resolved.gateAction.reason ? resolved.gateAction.reason : resolved.disposition) + ').', false, { reason: resolved.disposition })
      const after = projectManaged(record.taskId)
      return ok({ taskId: record.taskId, actionId: action.id, revision: after.revision, disposition: resolved.disposition, gateStatus: resolved.gateAction.gateStatus || null, status: after.status, ...(resolved.gateAction.completion ? { completion: resolved.gateAction.completion } : {}) })
    }
    const closed = await core.managedTasks.closeTask(record.taskId, { actionId: action.id, reason: view.statusReason || view.status, operator })
    if (!closed.ok) return fail(closed.code || 'STALE_ACTION', 'The task cannot be closed in its current state.', false, closed.reason ? { reason: closed.reason } : undefined)
    return ok({ taskId: record.taskId, actionId: action.id, revision: projectManaged(record.taskId).revision, disposition: closed.disposition })
  }

  return Object.freeze({
    hello,
    listModes,
    getStatus,
    getResult,
    follow,
    submit,
    continueTask,
    cancel,
    respond,
    registerWorkspace,
    listCredentials,
    checkSession,
    setCredential,
    unsetCredential,
    metrics: () => ({ ...metrics }),
  })
}

module.exports = { createTaskApi, LEGACY_STATUS, MODE_OF_ENGINE, SCHEMA_MAJOR, CAPABILITY_OF, OWNER_PRINCIPAL_ID, DEFAULT_CREDENTIAL_REFS }
