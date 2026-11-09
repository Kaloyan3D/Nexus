'use strict'

/**
 * nexus/managed-tasks — durable managed task admission (P2-B2B).
 *
 * The Controller-owned engine behind task API `submit`, `cancel` and
 * `respond` and behind the managed-session admission tickets. It composes:
 *   - the durable intake store (intake-store.cjs): idempotency, identities,
 *     delivery state; the managed-session registry is derived from it;
 *   - the live approval broker (broker.cjs);
 *   - host ports for the DSH operations it may perform (create the exact
 *     session, prepare/bind through the existing Controller path, enqueue one
 *     user message with a stable request id, flush, read durable events,
 *     cancel the active turn). Ports are injected so the state machine is
 *     testable without DSH; the host plugin supplies the real ones.
 *
 * Intake state machine (persisted BEFORE each externally visible step):
 *   reserved --create exact session--> session-created --prepare/bind-->
 *   bound --persist intent--> delivering --enqueue+flush+read-back--> accepted
 *   any pre-acceptance failure with no DSH effect -> failed
 *   any uncertainty about whether work may have run -> parked (explicit hold)
 * Acknowledgement: `submit` answers `accepted` only after the exact user
 * message (source.rpcId === reserved requestId) is found once in the durable
 * session log after a flush. DSH's own prompt ack is never trusted alone.
 *
 * Admission tickets (agent/pre-step of a managed session or its subagents):
 * a model/tool step runs only when managed activation is active, the intake
 * is accepted (step 1 waits for the commit, so no provider call precedes it),
 * the step-1 claimed input is exactly the reserved request id, the task was not
 * cancelled or held, and no earlier turn of the task executed. Continuation
 * steps and subagent children run only while the admitted turn is live.
 * After a restart no turn is live: an interrupted turn is held, never resumed.
 */

const crypto = require('node:crypto')

const MAX_PROMPT_BYTES = 256 * 1024
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/
const ADMISSION_WAIT_MS = 30000
const MODES = Object.freeze({
  'engineering-v1': Object.freeze({ preset: 'aih-engineering', engine: 'dual' }),
  'engineering-v2': Object.freeze({ preset: 'aih-muse', engine: 'muse' }),
})

class ManagedTaskError extends Error {
  constructor(code, message, details) { super(message); this.code = code; if (details) this.details = details }
}

function rpcIdOf(message) {
  const source = message && message.source
  return source && source.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : undefined
}

/** Count durable insertion/claim evidence of one request id. */
function deliveryEvidence(events, requestId) {
  let inserted = 0
  let claimed = 0
  let discarded = 0
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'agent/inbox/spliced' && event.data) {
      for (const message of Array.isArray(event.data.inserted) ? event.data.inserted : []) if (rpcIdOf(message) === requestId) inserted += 1
    } else if (event.type === 'user/message' && rpcIdOf(event.data) === requestId) {
      claimed += 1
    } else if (event.type === 'agent/inbox/discarded' && event.data && rpcIdOf(event.data.message) === requestId) {
      discarded += 1
    }
  }
  return { inserted, claimed, discarded }
}

function lastUserRpcId(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'user/message') return rpcIdOf(event.data) || null
  }
  return undefined
}

/**
 * @param {object} options
 * @param {ReturnType<import('./intake-store.cjs').createIntakeStore>} options.store
 * @param {ReturnType<import('./broker.cjs').createApprovalBroker>} options.broker
 * @param {() => { active: boolean, problems: string[] }} options.activation
 * @param {object} options.ports host DSH operations (see module header)
 * @param {Function} [options.log]
 */
function createManagedTasks(options) {
  const { store, broker, ports } = options
  const activation = options.activation
  const log = typeof options.log === 'function' ? options.log : () => {}
  const flights = new Map()        // intakeId -> pipeline promise
  const waiters = new Map()        // intakeId -> { promise, resolve }
  const activeTurns = new Map()    // root sessionId -> { taskId, startedAt }
  const redeliverable = new Set()  // intakeIds proven never inserted (after restart)
  const tickets = new Map()        // root sessionId -> in-flight step-1 ticket promise
  const metrics = { submitted: 0, replays: 0, conflicts: 0, accepted: 0, parked: 0, failed: 0, stepsAdmitted: 0, stepsRefused: 0, cancels: 0, reconciled: 0 }
  let reconciled = false

  function waiterFor(intakeId) {
    let waiter = waiters.get(intakeId)
    if (!waiter) {
      let resolve
      const promise = new Promise((r) => { resolve = r })
      waiter = { promise, resolve }
      waiters.set(intakeId, waiter)
    }
    return waiter
  }
  function settleWaiter(intakeId, accepted) {
    const waiter = waiters.get(intakeId)
    if (waiter) { waiters.delete(intakeId); waiter.resolve(accepted) }
  }

  function park(record, reason, detail = {}) {
    const next = store.transition(record.intakeId, [record.state], 'parked', { hold: { reason, at: new Date().toISOString(), ...detail } })
    metrics.parked += 1
    settleWaiter(record.intakeId, false)
    log({ event: 'managed-intake-parked', taskId: record.taskId, sessionId: record.sessionId, reason })
    return next
  }
  function failIntake(record, code, message) {
    const next = store.transition(record.intakeId, [record.state], 'failed', { failure: { code, message: String(message).slice(0, 500), at: new Date().toISOString() } })
    metrics.failed += 1
    settleWaiter(record.intakeId, false)
    log({ event: 'managed-intake-failed', taskId: record.taskId, code })
    return next
  }

  async function readEvidence(record) {
    await ports.flush(record.sessionId)
    const events = await ports.readDurable(record.sessionId)
    if (!Array.isArray(events)) throw new ManagedTaskError('evidence-unreadable', 'durable session log is unreadable')
    return deliveryEvidence(events, record.requestId)
  }

  /** Decide a delivering intake from durable evidence (shared by submit and reconcile). */
  function decideDelivery(record, evidence, { restarted }) {
    if (evidence.inserted > 1 || evidence.claimed > 1) return park(record, 'duplicate-input', { evidence })
    if (evidence.inserted === 1 || evidence.claimed === 1) {
      let next = store.transition(record.intakeId, ['delivering'], 'accepted', { acceptedAt: new Date().toISOString(), deliveryEvidence: evidence })
      metrics.accepted += 1
      if (restarted) {
        // The input is durable exactly once, but this host did not observe
        // its turn: never resume or replay it automatically.
        next = park(next, evidence.claimed === 1 ? 'interrupted' : 'restored-input-not-resumed', { evidence })
      } else {
        settleWaiter(record.intakeId, true)
      }
      return next
    }
    return null // no durable insertion
  }

  /** Advance one intake as far as safely possible. Serialized per intake. */
  function advance(intakeId) {
    const running = flights.get(intakeId)
    if (running) return running
    const flight = (async () => {
      let record = store.get(intakeId)
      for (let guard = 0; guard < 8 && record; guard += 1) {
        if (record.cancelRequestedAt && ['reserved', 'session-created', 'bound'].includes(record.state)) {
          record = park(record, 'cancelled-before-delivery')
          break
        }
        if (record.state === 'reserved') {
          try {
            const exists = await ports.sessionExists(record.sessionId)
            if (!exists) {
              const createdId = await ports.createSession({ sessionId: record.sessionId, workspaceId: record.canonical.workspaceId, agentPreset: record.preset })
              if (createdId !== record.sessionId) { record = failIntake(record, 'session-identity-mismatch', `DSH created ${createdId}`); break }
            }
          } catch (error) { record = failIntake(record, 'session-create-failed', error && error.message ? error.message : error); break }
          record = store.transition(intakeId, ['reserved'], 'session-created', {})
          continue
        }
        if (record.state === 'session-created') {
          try {
            const bound = await ports.prepare({ sessionId: record.sessionId, cwd: record.canonical.workspacePath, preset: record.preset, profileId: record.profileId })
            if (!bound || typeof bound.taskInstanceId !== 'string') throw new ManagedTaskError('prepare-invalid', 'preparation returned no task identity')
            record = store.transition(intakeId, ['session-created'], 'bound', { taskInstanceId: bound.taskInstanceId, displayId: bound.taskId || null })
          } catch (error) { record = failIntake(record, 'session-prepare-failed', error && error.message ? error.message : error); break }
          continue
        }
        if (record.state === 'bound' || (record.state === 'delivering' && redeliverable.delete(intakeId))) {
          // Intent is durable before the DSH write; a crash after this point
          // is reconciled from DSH's durable log, never blindly replayed.
          record = store.transition(intakeId, [record.state], 'delivering', { deliveringAt: new Date().toISOString() })
          waiterFor(intakeId)
          let promptError = null
          try { await ports.prompt({ sessionId: record.sessionId, requestId: record.requestId, text: record.prompt.text }) } catch (error) { promptError = error }
          let evidence
          try { evidence = await readEvidence(record) } catch (error) { record = park(record, 'delivery-evidence-unreadable', { error: String(error && error.message ? error.message : error) }); break }
          const decided = decideDelivery(record, evidence, { restarted: false })
          if (decided) { record = decided; break }
          if (promptError && promptError.code === 'managed-port-unavailable') {
            // The DSH write was never attempted: stay delivering (proven absent)
            // and finish under the same ids when the host can deliver.
            redeliverable.add(intakeId)
            settleWaiter(intakeId, false)
            break
          }
          if (promptError) { record = park(record, 'delivery-rejected', { error: String(promptError.message || promptError).slice(0, 300) }); break }
          record = park(record, 'delivery-not-durable', { evidence })
          break
        }
        break
      }
      return record
    })()
    flights.set(intakeId, flight)
    flight.finally(() => { if (flights.get(intakeId) === flight) flights.delete(intakeId) }).catch(() => {})
    return flight
  }

  function receiptOf(record, replay) {
    return {
      taskId: record.taskId,
      sessionId: record.sessionId,
      status: 'accepted',
      mode: record.canonical.mode,
      revision: String(record.revision),
      idempotencyKey: record.idempotencyKey,
      replay: Boolean(replay),
    }
  }

  /**
   * submit — validated, reserved, created, bound, delivered and verified.
   * Returns { ok, data } or { ok:false, code, message, retryable }.
   */
  async function submit(principalId, input) {
    const gate = activation()
    if (!gate.active) return { ok: false, code: 'REQUIRED_CAPABILITY_UNAVAILABLE', message: 'Managed Nexus submission is not active on this host.', details: { reason: 'managed-admission-inactive', problems: gate.problems } }
    const allowed = ['idempotencyKey', 'workspace', 'mode', 'prompt']
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !allowed.includes(key))) return { ok: false, code: 'USAGE', message: 'submit accepts idempotencyKey, workspace, mode and prompt only.' }
    if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) return { ok: false, code: 'USAGE', message: 'idempotencyKey must be 1-128 printable characters.' }
    if (typeof input.workspace !== 'string' || input.workspace === '') return { ok: false, code: 'USAGE', message: 'workspace is required.' }
    const mode = MODES[input.mode]
    if (!mode) return { ok: false, code: 'MODE_UNAVAILABLE', message: 'Unknown or unavailable mode.' }
    const prompt = input.prompt
    if (!prompt || typeof prompt !== 'object' || Object.keys(prompt).some((key) => !['kind', 'text', 'digest'].includes(key)) || !['text', 'file', 'stdin'].includes(prompt.kind) || typeof prompt.text !== 'string' || typeof prompt.digest !== 'string') {
      return { ok: false, code: 'USAGE', message: 'prompt must be { kind, text, digest }.' }
    }
    const bytes = Buffer.from(prompt.text, 'utf8')
    if (bytes.length > MAX_PROMPT_BYTES) return { ok: false, code: 'PROMPT_LIMIT', message: 'prompt exceeds 262144 bytes.' }
    if (prompt.text.trim() === '' || prompt.text.includes('\u0000')) return { ok: false, code: 'USAGE', message: 'prompt is empty or contains NUL.' }
    const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
    if (digest !== prompt.digest) return { ok: false, code: 'USAGE', message: 'prompt digest does not match its text.' }
    const workspace = await ports.resolveWorkspace(input.workspace)
    if (!workspace) return { ok: false, code: 'NOT_FOUND', message: 'No authorized workspace at that path.' }
    const profileId = ports.resolveProfile(mode.preset)
    if (typeof profileId !== 'string' || profileId === '') return { ok: false, code: 'MODE_UNAVAILABLE', message: 'The mode has no resolvable engineering profile.' }
    const canonical = { workspaceId: workspace.workspaceId, workspacePath: workspace.path, mode: input.mode, promptDigest: digest, promptBytes: bytes.length, sourceKind: prompt.kind }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([principalId, canonical.workspaceId, canonical.mode, canonical.promptDigest])).digest('hex')
    let reservation
    try {
      reservation = store.reserve({ principalId, idempotencyKey: input.idempotencyKey, fingerprint, canonical, preset: mode.preset, profileId, promptText: prompt.text })
    } catch (error) {
      if (error && (error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'IDEMPOTENCY_RETIRED')) { metrics.conflicts += 1; return { ok: false, code: 'IDEMPOTENCY_CONFLICT', message: error.message, details: { reason: error.code === 'IDEMPOTENCY_RETIRED' ? 'identity-retained' : 'payload-differs' } } }
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: String(error && error.message ? error.message : error), retryable: true }
    }
    metrics.submitted += 1
    if (reservation.replay) metrics.replays += 1
    let record = reservation.record
    if (record.state !== 'accepted' && record.state !== 'parked' && record.state !== 'failed') {
      try { record = await advance(record.intakeId) } catch (error) {
        log({ event: 'managed-intake-uncertain', taskId: record.taskId, error: String(error && error.message ? error.message : error) })
        return { ok: false, code: 'SUBMISSION_UNCERTAIN', message: 'Submission state is uncertain; retry with the same idempotency key.', retryable: true, details: { taskId: record.taskId } }
      }
    }
    // A replay of an intake that was accepted returns the original receipt,
    // even if it is later held, cancelled or finished (query status for that).
    if (record.acceptedAt) return { ok: true, data: receiptOf(record, reservation.replay) }
    if (record.state === 'failed') return { ok: false, code: 'SUBMISSION_REJECTED', message: 'The submission was rejected before delivery.', details: { taskId: record.taskId, reason: record.failure && record.failure.code } }
    if (record.state === 'parked') return { ok: false, code: 'SUBMISSION_UNCERTAIN', message: 'The submission is held for reconciliation; query its status.', retryable: false, details: { taskId: record.taskId, reason: record.hold && record.hold.reason } }
    return { ok: false, code: 'SUBMISSION_UNCERTAIN', message: 'Submission not yet acknowledged; retry with the same idempotency key.', retryable: true, details: { taskId: record.taskId } }
  }

  /**
   * Startup reconciliation. Runs once, before activation can become active.
   * Every pending intake ends in a safe state; nothing that may have run is
   * re-delivered.
   */
  async function reconcile() {
    // Re-enter records missing from the identity ledger (adds protection only).
    try { if (typeof store.repairLedger === 'function') store.repairLedger() } catch (error) { log({ event: 'intake-ledger-repair-failed', error: String(error && error.message ? error.message : error) }) }
    for (const record of store.pending()) {
      metrics.reconciled += 1
      try {
        if (record.state === 'delivering') {
          let evidence
          try { evidence = await readEvidence(record) } catch (error) { park(record, 'delivery-evidence-unreadable', { error: String(error && error.message ? error.message : error) }); continue }
          const decided = decideDelivery(record, evidence, { restarted: true })
          if (decided) continue
          // Proven never inserted and never claimed: the original intent is
          // finished under the same ids once activation is active (DSH also
          // deduplicates the request id).
          redeliverable.add(record.intakeId)
          log({ event: 'managed-intake-redeliverable', taskId: record.taskId })
          continue
        }
        // reserved / session-created / bound: no user message was written. The
        // crash may have left a blank session or a prepared binding; both are
        // idempotent for the same ids, so the intent stays resumable.
        log({ event: 'managed-intake-resumable', taskId: record.taskId, state: record.state })
      } catch (error) {
        log({ event: 'managed-intake-reconcile-failed', taskId: record.taskId, error: String(error && error.message ? error.message : error) })
      }
    }
    // Accepted tasks whose admitted turn this host never saw end: interrupted.
    for (const record of store.list()) {
      if (record.state === 'accepted' && record.executionStartedAt && !record.turnEndedAt) {
        try { park(record, 'interrupted') } catch { /* store unhealthy => gate fails */ }
      }
    }
    reconciled = true
  }

  /** After activation: finish every resumable intent under its original ids. */
  async function resumePending() {
    if (!activation().active) return []
    const results = []
    for (const record of store.pending()) {
      if (record.state === 'delivering' && !redeliverable.has(record.intakeId)) continue
      try { results.push(await advance(record.intakeId)) } catch (error) { log({ event: 'managed-intake-resume-failed', taskId: record.taskId, error: String(error && error.message ? error.message : error) }) }
    }
    return results
  }

  /**
   * Admission ticket for one agent/pre-step. Async: step 1 waits for the
   * intake commit. Returns { allowed, code }.
   */
  async function admitStep(rootSessionId, session, payload) {
    const refuse = (code) => { metrics.stepsRefused += 1; return { allowed: false, code } }
    if (!activation().active) return refuse('managed-admission-inactive')
    let record = store.bySessionId(rootSessionId)
    if (!record) return refuse('managed-registry-unknown')
    if (record.retiredAt) return refuse('managed-task-retired')
    if (record.cancelRequestedAt) return refuse('managed-task-cancelled')
    if (record.state === 'parked' || record.state === 'failed') return refuse('managed-task-held')
    const live = activeTurns.get(rootSessionId)
    if (session.id !== rootSessionId) return live ? (metrics.stepsAdmitted += 1, { allowed: true, code: null }) : refuse('managed-lineage-inactive')
    const step = payload && Number.isSafeInteger(payload.step) ? payload.step : 1
    if (step !== 1) return live ? (metrics.stepsAdmitted += 1, { allowed: true, code: null }) : refuse('managed-turn-not-admitted')
    if (!live && record.executionStartedAt) return refuse('managed-turn-already-run')
    // DSH 0.2 hands the claimed inbox input to agent/pre-step and appends it to
    // the log only after the step is allowed: the claimed user input must be
    // exactly the reserved request id (runtime context may accompany it).
    const claimed = payload && Array.isArray(payload.messages) ? payload.messages : null
    const userInputs = claimed ? claimed.filter((message) => message && message.source && message.source.kind === 'user') : null
    if (!userInputs || userInputs.length !== 1 || rpcIdOf(userInputs[0]) !== record.requestId) return refuse('managed-input-mismatch')
    // Idempotent per turn: the host gate and the plane bridge both ask (in
    // either order); the second ask for the same admitted input is allowed.
    if (live) return live.requestId === record.requestId && live.claimed === userInputs[0] ? (metrics.stepsAdmitted += 1, { allowed: true, code: null }) : refuse('managed-turn-already-run')
    const pendingTicket = tickets.get(rootSessionId)
    if (pendingTicket) return pendingTicket
    const issue = (async () => {
    if (record.state !== 'accepted') {
      if (record.state !== 'delivering') return refuse('managed-admission-uncommitted')
      const waiter = waiterFor(record.intakeId)
      let timer
      const committed = await Promise.race([waiter.promise, new Promise((resolve) => { timer = setTimeout(() => resolve(false), ADMISSION_WAIT_MS); if (timer.unref) timer.unref() })])
      clearTimeout(timer)
      record = store.bySessionId(rootSessionId)
      if (!committed || !record || record.state !== 'accepted') return refuse('managed-admission-uncommitted')
      if (record.cancelRequestedAt) return refuse('managed-task-cancelled')
    }
    if (activeTurns.has(rootSessionId)) return refuse('managed-turn-already-run')
    activeTurns.set(rootSessionId, { taskId: record.taskId, requestId: record.requestId, claimed: userInputs[0], startedAt: Date.now() })
    try {
      store.annotate(record.intakeId, record.revision, { executionStartedAt: new Date().toISOString() })
    } catch (error) {
      activeTurns.delete(rootSessionId)
      return refuse('managed-admission-unrecorded')
    }
    metrics.stepsAdmitted += 1
    log({ event: 'managed-turn-admitted', taskId: record.taskId, sessionId: rootSessionId })
    return { allowed: true, code: null }
    })()
    tickets.set(rootSessionId, issue)
    try { return await issue } finally { if (tickets.get(rootSessionId) === issue) tickets.delete(rootSessionId) }
  }

  /** Synchronous ticket view for plane bridges (after the host admitted). */
  function stepAdmitted(rootSessionId) { return activation().active && activeTurns.has(rootSessionId) }

  function onTurnEnd(rootSessionId, reasonKind, turnError) {
    if (!activeTurns.delete(rootSessionId)) return
    const record = store.bySessionId(rootSessionId)
    if (!record) return
    broker.cancelTask(record.taskId)
    const patch = { turnEndedAt: new Date().toISOString(), turnEndReason: reasonKind || null, ...(turnError ? { turnError } : {}) }
    if (record.cancelRequestedAt) patch.cancelledAt = patch.turnEndedAt
    try { store.annotate(record.intakeId, record.revision, patch) } catch (error) { log({ event: 'managed-turn-end-unrecorded', taskId: record.taskId, error: String(error && error.message ? error.message : error) }) }
  }

  async function cancel(taskId) {
    const record = store.byTaskId(taskId)
    if (!record) return { ok: false, code: 'NOT_FOUND', message: 'No authorized task with that id.' }
    if (record.cancelledAt || record.state === 'failed' || (record.state === 'parked' && record.hold && record.hold.reason === 'cancelled-before-delivery')) return { ok: true, data: { taskId, disposition: 'already_terminal' } }
    if (record.cancelRequestedAt) return { ok: true, data: { taskId, disposition: 'already_requested' } }
    metrics.cancels += 1
    const live = activeTurns.has(record.sessionId)
    const now = new Date().toISOString()
    const patch = { cancelRequestedAt: now }
    if (!live) patch.cancelledAt = now
    store.annotate(record.intakeId, record.revision, patch)
    broker.cancelTask(taskId)
    if (live) { try { await ports.cancelTurn(record.sessionId) } catch (error) { log({ event: 'managed-cancel-turn-failed', taskId, error: String(error && error.message ? error.message : error) }) } }
    log({ event: 'managed-task-cancel-requested', taskId, live })
    return { ok: true, data: { taskId, disposition: 'requested' } }
  }

  return Object.freeze({
    submit,
    reconcile,
    resumePending,
    admitStep,
    stepAdmitted,
    onTurnEnd,
    cancel,
    isTurnLive: (sessionId) => activeTurns.has(sessionId),
    /** Nexus's last assistant text in a managed session (read-only; null when unavailable). */
    async lastReply(sessionId) { try { return typeof ports.lastReply === 'function' ? await ports.lastReply(sessionId) : null } catch { return null } },
    /** Whether a mode currently resolves a runnable profile of its engine. */
    modeProfile(mode) { const entry = MODES[mode]; if (!entry) return null; try { return ports.resolveProfile(entry.preset) || null } catch { return null } },
    activeSessionIds: () => [...activeTurns.keys()],
    get reconciled() { return reconciled },
    metrics: () => ({ ...metrics, activeTurns: activeTurns.size, inFlight: flights.size }),
  })
}

module.exports = { createManagedTasks, deliveryEvidence, lastUserRpcId, ManagedTaskError, MODES, MAX_PROMPT_BYTES }
