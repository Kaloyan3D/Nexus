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

const SCHEMA_MAJOR = 1
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const LEGACY_STATUS = Object.freeze({ ready: 'queued', implementing: 'running', verifying: 'verifying', complete: 'completed', failed: 'failed' })
const MODE_OF_ENGINE = Object.freeze({ dual: 'engineering-v1', muse: 'engineering-v2' })
const TASK_ID = /^(task|nt)_[0-9a-f]{32}$/
const MANAGED_TASK_ID = /^nt_[0-9a-f]{32}$/
const CAPABILITY_OF = Object.freeze({ hello: 'tasks:read', listModes: 'tasks:read', getStatus: 'tasks:read', getResult: 'tasks:read', follow: 'tasks:read', submit: 'tasks:submit', cancel: 'tasks:cancel', respond: 'tasks:respond', registerWorkspace: 'workspaces:register', listCredentials: 'credentials:read', setCredential: 'credentials:write', unsetCredential: 'credentials:write' })
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
      if (!record || !(await workspaceAllowed(principal, { workspace: record.canonical.workspacePath }))) { metrics.notFound += 1; return { error: fail('NOT_FOUND', 'No authorized task with that id.') } }
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
    if (record.state === 'failed') { status = 'failed'; reason = record.failure ? record.failure.code : 'intake-failed' }
    else if (record.cancelledAt || (record.state === 'parked' && record.hold && record.hold.reason === 'cancelled-before-delivery')) status = 'cancelled'
    else if (record.cancelRequestedAt) status = 'cancelling'
    else if (record.state === 'parked') { reason = record.hold ? record.hold.reason : 'held'; status = reason === 'interrupted' ? 'interrupted' : 'blocked' }
    else if (record.state !== 'accepted') status = 'queued'
    else if (actions.length) status = 'awaiting_operator'
    else if (core.managedTasks && core.managedTasks.isTurnLive(record.sessionId)) status = base && ['verifying', 'completed', 'failed'].includes(base.status) ? base.status : 'running'
    else if (!record.executionStartedAt) status = 'accepted'
    else if (base && TERMINAL.has(base.status)) status = base.status
    else if (base && base.status === 'blocked') { status = 'blocked'; reason = base.statusReason || null }
    // A turn that ended in an error (e.g. a missing provider credential) is a
    // failed attempt; report the error instead of a generic hold.
    else if (record.turnEndReason === 'error') { status = 'failed'; reason = 'turn-error' }
    // A successful turn without ledger completion: work done, verification pending.
    else if (record.turnEndReason === 'completed') { status = 'blocked'; reason = 'turn-completed-awaiting-verification' }
    else { status = 'blocked'; reason = 'turn-ended-without-ledger-completion' }
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
      operatorActions: actions,
      intake: { state: record.state, acceptedAt: record.acceptedAt || null, hold: record.hold ? record.hold.reason : null },
      ...(record.turnEndedAt ? { turn: { endedAt: record.turnEndedAt, reason: record.turnEndReason || null, ...(record.turnError ? { error: record.turnError } : {}) } } : {}),
      cohort: 'managed',
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([record.revision, record.state, base ? base.revision : null, status, actions.map((action) => action.id)])).digest('hex')
    const previous = projections.get(taskId)
    const revision = !previous ? 1 : previous.fingerprint === fingerprint ? previous.revision : previous.revision + 1
    const entry = { fingerprint, revision, view: Object.freeze({ ...view, revision: String(revision), updatedAt: new Date().toISOString() }) }
    if (!previous || previous.fingerprint !== fingerprint) projections.set(taskId, entry)
    return (projections.get(taskId) || entry).view
  }
  const viewOf = (located) => located.record ? projectManaged(located.record.taskId) : project(located.binding)
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
      operations: active ? ['hello', 'listModes', 'getStatus', 'getResult', 'follow', 'submit', 'cancel', 'respond'] : ['hello', 'listModes', 'getStatus', 'getResult', 'follow', 'cancel', 'respond'],
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
    return ok(await withReply(viewOf(located)))
  }

  async function getResult(principal, input) {
    const denied = authorize(principal, 'getResult'); if (denied) return denied
    metrics.reads += 1
    const located = await locate(principal, input); if (located.error) return located.error
    const view = await withReply(viewOf(located))
    const outcome = TERMINAL.has(view.status) ? view.status : 'pending'
    return ok({ ...view, outcome, summary: view.reply ? view.reply.text : null, artifacts: [] })
  }

  async function follow(principal, input) {
    const denied = authorize(principal, 'follow'); if (denied) return denied
    metrics.follows += 1
    const located = await locate(principal, input); if (located.error) return located.error
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

  /** cancel — managed tasks only (legacy GUI tasks keep their own controls). */
  async function cancel(principal, input) {
    const denied = authorize(principal, 'cancel'); if (denied) return denied
    const located = await locate(principal, input); if (located.error) return located.error
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
    if (!located.record || !core.broker) return fail('NOT_FOUND', 'No such operator action.')
    const responder = principal.kind === 'internal' ? { kind: 'local-owner', via: 'internal', capabilities: ['tasks:respond'] } : principal
    const result = core.broker.respond(responder, { taskId: located.record.taskId, actionId: input.actionId, expectedRevision: input.expectedRevision, choiceId: input.choiceId })
    if (!result.ok) return fail(result.code, result.code === 'STALE_ACTION' ? 'The operator action is no longer pending at that revision.' : result.code === 'USAGE' ? 'Unknown choice for that action.' : 'No such operator action.')
    const view = projectManaged(located.record.taskId)
    return ok({ taskId: view.taskId, actionId: input.actionId, revision: view.revision, disposition: result.disposition })
  }

  return Object.freeze({
    hello,
    listModes,
    getStatus,
    getResult,
    follow,
    submit,
    cancel,
    respond,
    registerWorkspace,
    listCredentials,
    setCredential,
    unsetCredential,
    metrics: () => ({ ...metrics }),
  })
}

module.exports = { createTaskApi, LEGACY_STATUS, MODE_OF_ENGINE, SCHEMA_MAJOR, CAPABILITY_OF, OWNER_PRINCIPAL_ID, DEFAULT_CREDENTIAL_REFS }
