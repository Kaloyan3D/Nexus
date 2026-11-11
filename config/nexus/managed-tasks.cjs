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
 *
 * P2-B2E per-turn admission (durable multi-turn continuation): the task-level
 * one-turn ticket is replaced by turn-scoped tickets. Turn 1 is the original
 * submission (its fields stay on the intake record); every later user turn is
 * a durable continuation entry `record.continuations[]` with its own
 * Controller-allocated turn id, task+principal-scoped idempotency key, prompt
 * digest, DSH source request id, delivery evidence and execution/terminal
 * observations. A continuation runs through the same reserve -> delivering ->
 * accepted pipeline (same evidence rule, same reconcile rules) in the SAME DSH
 * session; step 1 of a turn is admitted only for that turn's reserved request
 * id, only after its acceptance is committed, and only once. The TaskController
 * attempt stays open across clean turns (one evolving candidate); verification
 * and completion are unchanged.
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

const MAX_TURNS = 64
const TURN_ONE = 't1'

function continuationsOf(record) { return record && Array.isArray(record.continuations) ? record.continuations : [] }

/** Turn 1 (the original submission) as a turn view. */
function firstTurn(record) {
  return {
    turnId: TURN_ONE, seq: 1, requestId: record.requestId,
    state: record.acceptedAt ? 'accepted' : record.state,
    idempotencyKey: record.idempotencyKey,
    promptDigest: record.prompt ? record.prompt.digest : null,
    acceptedAt: record.acceptedAt || null,
    executionStartedAt: record.executionStartedAt || null,
    turnEndedAt: record.turnEndedAt || null,
    turnEndReason: record.turnEndReason || null,
    ...(record.turnError ? { turnError: record.turnError } : {}),
  }
}
function turnsOf(record) { return record ? [firstTurn(record), ...continuationsOf(record)] : [] }
/** The task's current turn: the latest one that reached (or may reach) DSH; a
 *  continuation refused before delivery (`failed`, no DSH effect) is skipped. */
function currentTurn(record) { const turns = turnsOf(record).filter((turn, index) => index === 0 || turn.state !== 'failed'); return turns[turns.length - 1] || null }
function publicTurn(turn) {
  if (!turn) return null
  const status = turn.state === 'parked' ? 'held' : turn.state === 'failed' ? 'rejected' : turn.state !== 'accepted' ? 'delivering'
    : turn.turnEndedAt ? (turn.turnEndReason === 'completed' ? 'completed' : 'ended') : turn.executionStartedAt ? 'running' : 'accepted'
  return {
    turnId: turn.turnId, seq: turn.seq, status,
    acceptedAt: turn.acceptedAt || null, startedAt: turn.executionStartedAt || null, endedAt: turn.turnEndedAt || null,
    endReason: turn.turnEndReason || null,
    ...(turn.hold ? { hold: turn.hold.reason } : {}),
    ...(turn.failure ? { failure: turn.failure.code } : {}),
  }
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

  async function readEvidence(record, requestId = record.requestId) {
    await ports.flush(record.sessionId)
    const events = await ports.readDurable(record.sessionId)
    if (!Array.isArray(events)) throw new ManagedTaskError('evidence-unreadable', 'durable session log is unreadable')
    return deliveryEvidence(events, requestId)
  }

  // ── P2-B2E continuation turns ────────────────────────────────────────────
  const turnKey = (record, turnId) => record.intakeId + '#' + turnId
  const closing = new Set() // taskIds whose close is in progress (arbitration lock)

  /** CAS-patch one continuation entry (re-reads the current record). */
  function patchTurn(taskId, turnId, patch) {
    const current = store.byTaskId(taskId)
    const list = continuationsOf(current)
    const index = list.findIndex((turn) => turn.turnId === turnId)
    if (index < 0) throw new ManagedTaskError('turn-unknown', 'unknown continuation turn')
    const next = list.slice()
    next[index] = { ...list[index], ...patch }
    return store.annotate(current.intakeId, current.revision, { continuations: next })
  }
  /** Settle the execution fields of a turn (turn 1 lives on the record itself). */
  function patchTurnExecution(taskId, turnId, patch) {
    if (turnId === TURN_ONE) { const current = store.byTaskId(taskId); return store.annotate(current.intakeId, current.revision, patch) }
    return patchTurn(taskId, turnId, patch)
  }
  /** Hold the turn and its task (uncertain execution is never replayed). */
  function parkTurn(taskId, turnId, reason, detail = {}) {
    const hold = { reason, at: new Date().toISOString(), turnId, ...detail }
    let record = patchTurn(taskId, turnId, { state: 'parked', hold })
    if (record.state === 'accepted') record = store.transition(record.intakeId, ['accepted'], 'parked', { hold })
    metrics.parked += 1
    settleWaiter(turnKey(record, turnId), false)
    log({ event: 'managed-turn-parked', taskId, turnId, reason })
    return record
  }

  /** Decide a delivering continuation from durable evidence. */
  function decideTurn(record, turn, evidence, { restarted }) {
    if (evidence.inserted > 1 || evidence.claimed > 1) return parkTurn(record.taskId, turn.turnId, 'duplicate-input', { evidence })
    if (evidence.inserted === 1 || evidence.claimed === 1) {
      let next = patchTurn(record.taskId, turn.turnId, { state: 'accepted', acceptedAt: new Date().toISOString(), deliveryEvidence: evidence, prompt: { digest: turn.prompt.digest, bytes: turn.prompt.bytes, kind: turn.prompt.kind } })
      metrics.accepted += 1
      if (restarted) next = parkTurn(record.taskId, turn.turnId, evidence.claimed === 1 ? 'interrupted' : 'restored-input-not-resumed', { evidence })
      else settleWaiter(turnKey(record, turn.turnId), true)
      return next
    }
    return null
  }

  /** Advance one continuation as far as safely possible (serialized per turn). */
  function advanceTurn(taskId, turnId) {
    const record0 = store.byTaskId(taskId)
    const key = turnKey(record0, turnId)
    const running = flights.get(key)
    if (running) return running
    const flight = (async () => {
      let record = store.byTaskId(taskId)
      let turn = continuationsOf(record).find((item) => item.turnId === turnId)
      if (!turn) return record
      if (turn.state === 'reserved' && (record.closedAt || record.cancelRequestedAt || record.state !== 'accepted')) {
        // No DSH effect yet: the turn is refused under its ids.
        record = patchTurn(taskId, turnId, { state: 'failed', failure: { code: 'task-not-continuable', at: new Date().toISOString() }, prompt: { digest: turn.prompt.digest, bytes: turn.prompt.bytes, kind: turn.prompt.kind } })
        settleWaiter(key, false)
        return record
      }
      if (turn.state === 'reserved' || (turn.state === 'delivering' && redeliverable.delete(key))) {
        // Intent durable before the DSH write (same rule as the initial intake).
        record = patchTurn(taskId, turnId, { state: 'delivering', deliveringAt: new Date().toISOString() })
        turn = continuationsOf(record).find((item) => item.turnId === turnId)
        waiterFor(key)
        await faultPoint('continuation-before-prompt', { taskId, turnId })
        let promptError = null
        try { await ports.prompt({ sessionId: record.sessionId, requestId: turn.requestId, text: turn.prompt.text }) } catch (error) { promptError = error }
        await faultPoint('continuation-after-prompt', { taskId, turnId })
        let evidence
        try { evidence = await readEvidence(record, turn.requestId) } catch (error) { return parkTurn(taskId, turnId, 'delivery-evidence-unreadable', { error: String(error && error.message ? error.message : error) }) }
        await faultPoint('continuation-after-flush', { taskId, turnId })
        record = store.byTaskId(taskId)
        const decided = decideTurn(record, turn, evidence, { restarted: false })
        if (decided) return decided
        if (promptError && promptError.code === 'managed-port-unavailable') { redeliverable.add(key); settleWaiter(key, false); return record }
        if (promptError) return parkTurn(taskId, turnId, 'delivery-rejected', { error: String(promptError.message || promptError).slice(0, 300) })
        return parkTurn(taskId, turnId, 'delivery-not-durable', { evidence })
      }
      return record
    })()
    flights.set(key, flight)
    flight.finally(() => { if (flights.get(key) === flight) flights.delete(key) }).catch(() => {})
    return flight
  }

  /** Test-only deterministic fault injection (inert unless a hook is given). */
  async function faultPoint(name, detail) {
    if (typeof options.faultPoint === 'function') await options.faultPoint(name, detail)
  }

  /**
   * Why a new user turn is not allowed right now (null = allowed). Pure and
   * synchronous over durable + live state, so the reservation that follows it
   * is atomic with the check on the host's single JS thread.
   */
  function continuationRefusal(record, extra = {}) {
    if (!record) return 'task-unknown'
    if (record.retiredAt) return 'task-retired'
    if (record.closedAt) return 'task-closed'
    if (closing.has(record.taskId)) return 'task-closing'
    if (record.cancelRequestedAt || record.cancelledAt) return 'task-cancelled'
    if (record.state === 'parked') return record.hold && record.hold.reason ? record.hold.reason : 'task-held'
    if (record.state === 'failed') return 'intake-failed'
    if (record.state !== 'accepted') return 'turn-pending'
    if (extra.healthHeld) return extra.healthHeld
    if (extra.terminal) return 'task-terminal'
    if (record.verification) return record.verification.state === 'running' ? 'verification-running' : 'verification-started'
    if (verifyFlights.has(record.taskId)) return 'verification-running'
    if (reviewFlights.has(record.taskId) || (record.review && record.review.state === 'running')) return 'review-running'
    if (gateFlights.has(record.taskId)) return 'gate-action-running'
    if (activeTurns.has(record.sessionId) || tickets.has(record.sessionId)) return 'turn-live'
    if (broker.pendingFor && broker.pendingFor(record.taskId).length) return 'approval-pending'
    const turn = currentTurn(record)
    if (turn.state !== 'accepted') return turn.state === 'parked' ? 'turn-held' : 'turn-pending'
    if (!turn.executionStartedAt) return 'turn-not-started'
    if (!turn.turnEndedAt) return 'turn-live'
    if (turn.turnEndReason !== 'completed' || turn.turnError) return 'turn-not-clean'
    if (turnsOf(record).filter((item) => item.state === 'accepted').length >= MAX_TURNS) return 'turn-limit'
    return null
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
    const canonical = { workspaceId: workspace.workspaceId, workspacePath: workspace.path, mode: input.mode, promptDigest: digest, promptBytes: bytes.length, sourceKind: prompt.kind }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([principalId, canonical.workspaceId, canonical.mode, canonical.promptDigest])).digest('hex')
    // A retry of an existing intake never depends on today's profile choice:
    // the original receipt is returned (or the conflict reported) as recorded.
    const existing = typeof store.existing === 'function' ? store.existing(principalId, input.idempotencyKey) : null
    const profileId = existing ? existing.profileId : ports.resolveProfile(mode.preset)
    if (!existing && (typeof profileId !== 'string' || profileId === '')) return { ok: false, code: 'MODE_UNAVAILABLE', message: 'The mode has no resolvable engineering profile.' }
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

  function turnReceipt(record, turn, replay) {
    return {
      taskId: record.taskId,
      sessionId: record.sessionId,
      turnId: turn.turnId,
      turnSeq: turn.seq,
      status: 'accepted',
      mode: record.canonical.mode,
      idempotencyKey: turn.idempotencyKey,
      replay: Boolean(replay),
    }
  }

  /**
   * continueTask — one more explicitly authorized user turn in an existing
   * managed task (same task id, DSH session, mode, binding and attempt).
   * `precheck()` runs synchronously immediately before the reservation (the
   * Task API's expected-revision check), so continuation, verification and
   * close arbitrate atomically for one task revision.
   */
  async function continueTask(principalId, taskId, input, { precheck, healthHeld, terminal } = {}) {
    const gate = activation()
    if (!gate.active) return { ok: false, code: 'REQUIRED_CAPABILITY_UNAVAILABLE', message: 'Managed Nexus continuation is not active on this host.', details: { reason: 'managed-admission-inactive', problems: gate.problems } }
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['idempotencyKey', 'prompt'].includes(key))) return { ok: false, code: 'USAGE', message: 'continue accepts idempotencyKey and prompt only.' }
    if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) return { ok: false, code: 'USAGE', message: 'idempotencyKey must be 1-128 printable characters.' }
    const prompt = input.prompt
    if (!prompt || typeof prompt !== 'object' || Object.keys(prompt).some((key) => !['kind', 'text', 'digest'].includes(key)) || !['text', 'file', 'stdin'].includes(prompt.kind) || typeof prompt.text !== 'string' || typeof prompt.digest !== 'string') {
      return { ok: false, code: 'USAGE', message: 'prompt must be { kind, text, digest }.' }
    }
    const bytes = Buffer.from(prompt.text, 'utf8')
    if (bytes.length > MAX_PROMPT_BYTES) return { ok: false, code: 'PROMPT_LIMIT', message: 'prompt exceeds 262144 bytes.' }
    if (prompt.text.trim() === '' || prompt.text.includes('\u0000')) return { ok: false, code: 'USAGE', message: 'prompt is empty or contains NUL.' }
    const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
    if (digest !== prompt.digest) return { ok: false, code: 'USAGE', message: 'prompt digest does not match its text.' }
    let record = store.byTaskId(taskId)
    if (!record) return { ok: false, code: 'NOT_FOUND', message: 'No authorized task with that id.' }
    // Keys are scoped to (task, principal); the original submit key is separate.
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([principalId, taskId, digest])).digest('hex')
    const prior = continuationsOf(record).find((turn) => turn.principalId === principalId && turn.idempotencyKey === input.idempotencyKey)
    if (prior) {
      if (prior.fingerprint !== fingerprint) { metrics.conflicts += 1; return { ok: false, code: 'IDEMPOTENCY_CONFLICT', message: 'the idempotency key was used for a different continuation of this task', details: { reason: 'payload-differs', turnId: prior.turnId } } }
      metrics.replays += 1
      return finishContinuation(record, prior, true)
    }
    // Same authorized mode: the engineering profile must still resolve to the
    // one the task was bound with (revoked eligibility refuses, never re-routes).
    const mode = MODES[record.canonical.mode]
    let profileId = null
    try { profileId = mode ? ports.resolveProfile(mode.preset) : null } catch { profileId = null }
    if (!profileId) return { ok: false, code: 'MODE_UNAVAILABLE', message: 'The task\'s mode no longer resolves a runnable engineering profile.', details: { reason: 'mode-unavailable' } }
    if (profileId !== record.profileId) return { ok: false, code: 'MODE_UNAVAILABLE', message: 'The task\'s engineering profile changed since it was submitted; continue in a new task.', details: { reason: 'profile-changed' } }
    // ── synchronous arbitration section (no await until the reservation) ──
    record = store.byTaskId(taskId)
    if (typeof precheck === 'function') { const stale = precheck(); if (stale) return stale }
    const refusal = continuationRefusal(record, { healthHeld, terminal })
    if (refusal) return { ok: false, code: 'TASK_NOT_CONTINUABLE', message: 'The task cannot accept another turn now (' + refusal + ').', details: { reason: refusal } }
    const now = new Date().toISOString()
    const turn = {
      turnId: 'nturn_' + crypto.randomBytes(12).toString('hex'),
      seq: turnsOf(record).length + 1,
      principalId,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      requestId: crypto.randomUUID(),
      prompt: { text: prompt.text, digest, bytes: bytes.length, kind: prompt.kind },
      expectedRevision: record.revision,
      state: 'reserved',
      reservedAt: now,
    }
    try {
      record = store.annotate(record.intakeId, record.revision, { continuations: [...continuationsOf(record), turn] })
    } catch (error) {
      if (error && error.code === 'STALE_ACTION') return { ok: false, code: 'STALE_ACTION', message: 'The task changed while the continuation was being reserved.' }
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: String(error && error.message ? error.message : error), retryable: true }
    }
    metrics.continued = (metrics.continued || 0) + 1
    log({ event: 'managed-continuation-reserved', taskId, turnId: turn.turnId, seq: turn.seq })
    await faultPoint('continuation-reserved', { taskId, turnId: turn.turnId })
    return finishContinuation(record, turn, false)
  }

  async function finishContinuation(record, turn, replay) {
    let current = turn
    if (['reserved', 'delivering'].includes(turn.state)) {
      try { await advanceTurn(record.taskId, turn.turnId) } catch (error) {
        log({ event: 'managed-continuation-uncertain', taskId: record.taskId, turnId: turn.turnId, error: String(error && error.message ? error.message : error) })
        return { ok: false, code: 'SUBMISSION_UNCERTAIN', message: 'Continuation state is uncertain; retry with the same idempotency key.', retryable: true, details: { taskId: record.taskId, turnId: turn.turnId } }
      }
      record = store.byTaskId(record.taskId)
      current = continuationsOf(record).find((item) => item.turnId === turn.turnId) || turn
    }
    if (current.acceptedAt) return { ok: true, data: turnReceipt(record, current, replay) }
    if (current.state === 'failed') return { ok: false, code: 'TASK_NOT_CONTINUABLE', message: 'The continuation was refused before delivery.', details: { taskId: record.taskId, turnId: current.turnId, reason: current.failure && current.failure.code } }
    if (current.state === 'parked') return { ok: false, code: 'SUBMISSION_UNCERTAIN', message: 'The continuation is held for reconciliation; query the task status.', retryable: false, details: { taskId: record.taskId, turnId: current.turnId, reason: current.hold && current.hold.reason } }
    return { ok: false, code: 'SUBMISSION_UNCERTAIN', message: 'Continuation not yet acknowledged; retry with the same idempotency key.', retryable: true, details: { taskId: record.taskId, turnId: current.turnId } }
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
    // A verification that was running when the host stopped never becomes a
    // PASS: it is recorded as interrupted (its attempt is closed by the
    // TaskController's own verifying-without-evidence rule when re-run).
    for (let record of store.list()) {
      if (record.review && record.review.state === 'running') {
        // The reviewer may or may not have been called: never re-run it
        // automatically and never treat it as a verdict.
        try { store.annotate(record.intakeId, record.revision, { review: { ...record.review, state: 'interrupted', reason: 'host-restart-during-review', finishedAt: new Date().toISOString() } }) } catch { /* store unhealthy => gate fails */ }
      }
      const afterReview = store.byTaskId(record.taskId)
      if (afterReview.gateAction && afterReview.gateAction.state === 'running') {
        // The gate journal is the truth for whether the gate was resolved;
        // the completion re-run is offered only for an approved gate.
        try { store.annotate(afterReview.intakeId, afterReview.revision, { gateAction: { ...afterReview.gateAction, state: 'interrupted', reason: 'host-restart-during-gate-action', finishedAt: new Date().toISOString() } }) } catch { /* store unhealthy => gate fails */ }
      }
      record = store.byTaskId(record.taskId)
      if (record.verification && record.verification.state === 'running') {
        try { store.annotate(record.intakeId, record.revision, { verification: { ...record.verification, state: 'interrupted', reason: 'host-restart-during-verification', finishedAt: new Date().toISOString() } }) } catch { /* store unhealthy => gate fails */ }
      }
    }
    // P2-B2E continuation turns: the same evidence rules as the initial intake.
    for (const listed of store.list()) {
      for (const turn of continuationsOf(listed)) {
        const record = store.byTaskId(listed.taskId)
        const key = turnKey(record, turn.turnId)
        try {
          if (turn.state === 'parked') {
            // Crash between holding the turn and holding its task.
            if (record.state === 'accepted') store.transition(record.intakeId, ['accepted'], 'parked', { hold: turn.hold || { reason: 'turn-held', turnId: turn.turnId } })
          } else if (turn.state === 'delivering') {
            metrics.reconciled += 1
            let evidence
            try { evidence = await readEvidence(record, turn.requestId) } catch (error) { parkTurn(record.taskId, turn.turnId, 'delivery-evidence-unreadable', { error: String(error && error.message ? error.message : error) }); continue }
            if (!decideTurn(record, turn, evidence, { restarted: true })) { redeliverable.add(key); log({ event: 'managed-turn-redeliverable', taskId: record.taskId, turnId: turn.turnId }) }
          } else if (turn.state === 'reserved') {
            metrics.reconciled += 1
            log({ event: 'managed-turn-resumable', taskId: record.taskId, turnId: turn.turnId })
          } else if (turn.state === 'accepted' && !turn.turnEndedAt) {
            // Accepted but its end was never observed by this host: if it ran
            // it is interrupted; if it never started, the restored input is not
            // resumed. Either way: held, never replayed.
            metrics.reconciled += 1
            let claimed = Boolean(turn.executionStartedAt)
            if (!claimed) { try { claimed = (await readEvidence(record, turn.requestId)).claimed > 0 } catch { claimed = true } }
            parkTurn(record.taskId, turn.turnId, claimed ? 'interrupted' : 'restored-input-not-resumed')
          }
        } catch (error) {
          log({ event: 'managed-turn-reconcile-failed', taskId: record.taskId, turnId: turn.turnId, error: String(error && error.message ? error.message : error) })
        }
      }
    }
    // Accepted tasks whose admitted turn this host never saw end: interrupted.
    for (let record of store.list()) {
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
    // Continuations whose intent is durable but that provably never reached
    // DSH finish under their original ids (same rule as the initial intake).
    for (const record of store.list()) {
      for (const turn of continuationsOf(record)) {
        if (turn.state !== 'reserved' && !(turn.state === 'delivering' && redeliverable.has(turnKey(record, turn.turnId)))) continue
        try { results.push(await advanceTurn(record.taskId, turn.turnId)) } catch (error) { log({ event: 'managed-turn-resume-failed', taskId: record.taskId, turnId: turn.turnId, error: String(error && error.message ? error.message : error) }) }
      }
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
    if (record.closedAt) return refuse('managed-task-closed')
    if (record.cancelRequestedAt) return refuse('managed-task-cancelled')
    if (record.state === 'parked' || record.state === 'failed') return refuse('managed-task-held')
    const live = activeTurns.get(rootSessionId)
    if (session.id !== rootSessionId) return live ? (metrics.stepsAdmitted += 1, { allowed: true, code: null }) : refuse('managed-lineage-inactive')
    const step = payload && Number.isSafeInteger(payload.step) ? payload.step : 1
    if (step !== 1) return live ? (metrics.stepsAdmitted += 1, { allowed: true, code: null }) : refuse('managed-turn-not-admitted')
    // P2-B2E: the ticket is turn-scoped. Step 1 belongs to the task's current
    // turn (turn 1 or the latest continuation that reached DSH); a turn that
    // already executed is never admitted again.
    let turn = currentTurn(record)
    if (!turn) return refuse('managed-registry-unknown')
    if (turn.state === 'parked') return refuse('managed-task-held')
    if (!live && turn.executionStartedAt) return refuse('managed-turn-already-run')
    // DSH 0.2 hands the claimed inbox input to agent/pre-step and appends it to
    // the log only after the step is allowed: the claimed user input must be
    // exactly the reserved request id of that turn (runtime context may
    // accompany it).
    const claimed = payload && Array.isArray(payload.messages) ? payload.messages : null
    const userInputs = claimed ? claimed.filter((message) => message && message.source && message.source.kind === 'user') : null
    if (!userInputs || userInputs.length !== 1 || rpcIdOf(userInputs[0]) !== turn.requestId) return refuse('managed-input-mismatch')
    // Idempotent per turn: the host gate and the plane bridge both ask (in
    // either order); the second ask for the same admitted input is allowed.
    if (live) return live.requestId === turn.requestId && live.claimed === userInputs[0] ? (metrics.stepsAdmitted += 1, { allowed: true, code: null }) : refuse('managed-turn-already-run')
    const pendingTicket = tickets.get(rootSessionId)
    if (pendingTicket) return pendingTicket
    const turnId = turn.turnId
    const findTurn = (current) => turnsOf(current).find((item) => item.turnId === turnId)
    const issue = (async () => {
    if (turn.state !== 'accepted') {
      if (turn.state !== 'delivering') return refuse('managed-admission-uncommitted')
      const waiter = waiterFor(turnId === TURN_ONE ? record.intakeId : turnKey(record, turnId))
      let timer
      const committed = await Promise.race([waiter.promise, new Promise((resolve) => { timer = setTimeout(() => resolve(false), ADMISSION_WAIT_MS); if (timer.unref) timer.unref() })])
      clearTimeout(timer)
      record = store.bySessionId(rootSessionId)
      turn = record ? findTurn(record) : null
      if (!committed || !record || record.state !== 'accepted' || !turn || turn.state !== 'accepted') return refuse('managed-admission-uncommitted')
      if (record.cancelRequestedAt) return refuse('managed-task-cancelled')
      if (record.closedAt) return refuse('managed-task-closed')
    }
    if (activeTurns.has(rootSessionId)) return refuse('managed-turn-already-run')
    activeTurns.set(rootSessionId, { taskId: record.taskId, turnId, requestId: turn.requestId, claimed: userInputs[0], startedAt: Date.now() })
    try {
      patchTurnExecution(record.taskId, turnId, { executionStartedAt: new Date().toISOString() })
    } catch (error) {
      activeTurns.delete(rootSessionId)
      return refuse('managed-admission-unrecorded')
    }
    metrics.stepsAdmitted += 1
    log({ event: 'managed-turn-admitted', taskId: record.taskId, sessionId: rootSessionId, turnId })
    return { allowed: true, code: null }
    })()
    tickets.set(rootSessionId, issue)
    try { return await issue } finally { if (tickets.get(rootSessionId) === issue) tickets.delete(rootSessionId) }
  }

  /** Synchronous ticket view for plane bridges (after the host admitted). */
  function stepAdmitted(rootSessionId) { return activation().active && activeTurns.has(rootSessionId) }

  /**
   * Settle the live turn. The turn identity comes from the live ticket, so a
   * late end of an earlier turn can never settle a newer one.
   */
  function onTurnEnd(rootSessionId, reasonKind, turnError) {
    const live = activeTurns.get(rootSessionId)
    if (!live) return
    activeTurns.delete(rootSessionId)
    const record = store.bySessionId(rootSessionId)
    if (!record) return
    broker.cancelTask(record.taskId)
    const endedAt = new Date().toISOString()
    const patch = { turnEndedAt: endedAt, turnEndReason: reasonKind || null, ...(turnError ? { turnError } : {}) }
    try {
      patchTurnExecution(record.taskId, live.turnId || TURN_ONE, patch)
      if (record.cancelRequestedAt) { const current = store.byTaskId(record.taskId); store.annotate(current.intakeId, current.revision, { cancelledAt: endedAt }) }
    } catch (error) { log({ event: 'managed-turn-end-unrecorded', taskId: record.taskId, turnId: live.turnId, error: String(error && error.message ? error.message : error) }) }
  }

  // ── P2-B2D operator actions (Controller-derived, revision-bound) ────────
  const verifyFlights = new Map() // taskId -> promise

  /**
   * Run the existing Nexus verification for an executed managed task. The
   * intent is durable before dispatch; the outcome is recorded after; the
   * TaskController alone decides completion. Returns synchronously-recorded
   * acceptance; the pipeline continues in the background.
   */
  function runVerification(taskId, { actionId, attempt, operator }) {
    if (verifyFlights.has(taskId)) return { ok: false, code: 'STALE_ACTION', reason: 'verification-in-progress' }
    const record = store.byTaskId(taskId)
    if (!record || !record.taskInstanceId) return { ok: false, code: 'NOT_FOUND' }
    // P2-B2E arbitration: verification applies to the latest completed
    // candidate only — never while a turn is pending, live or held.
    const turn = currentTurn(record)
    if (closing.has(taskId) || record.closedAt) return { ok: false, code: 'STALE_ACTION', reason: 'task-closing' }
    if (activeTurns.has(record.sessionId) || tickets.has(record.sessionId) || !turn || turn.state !== 'accepted' || !turn.turnEndedAt) return { ok: false, code: 'STALE_ACTION', reason: 'turn-not-settled' }
    if (reviewFlights.has(taskId) || (record.review && record.review.state === 'running')) return { ok: false, code: 'STALE_ACTION', reason: 'review-running' }
    // P2-B2F freshness: only a review of THIS candidate (the current turn)
    // may count toward completion; an older one is treated as absent.
    const reviewUsable = reviewIsCurrent(record)
    const startedAt = new Date().toISOString()
    store.annotate(record.intakeId, record.revision, { verification: { state: 'running', actionId, attempt: String(attempt), operator: operator || null, startedAt, turnId: turn.turnId, reviewUsable } })
    log({ event: 'managed-verification-started', taskId, attempt })
    const flight = (async () => {
      let outcome
      try {
        outcome = await ports.verify({ sessionId: record.sessionId, taskInstanceId: record.taskInstanceId, attempt, reviewUsable })
      } catch (error) {
        outcome = { verification: 'incomplete', reason: (error && error.code ? error.code + ': ' : '') + String(error && error.message ? error.message : error).slice(0, 300) }
      }
      const current = store.byTaskId(taskId)
      const state = outcome && ['passed', 'failed', 'incomplete', 'rejected'].includes(outcome.verification) ? outcome.verification : 'incomplete'
      const verification = {
        ...current.verification,
        state,
        finishedAt: new Date().toISOString(),
        ...(outcome && outcome.checks ? { checks: outcome.checks } : {}),
        ...(outcome && Array.isArray(outcome.failingChecks) && outcome.failingChecks.length ? { failingChecks: outcome.failingChecks.slice(0, 20) } : {}),
        ...(outcome && outcome.reason ? { reason: String(outcome.reason).slice(0, 300) } : {}),
        ...(outcome && outcome.completion ? { completion: outcome.completion } : {}),
        ...(outcome && outcome.evidencePath ? { evidencePath: outcome.evidencePath } : {}),
        ...(outcome && outcome.attemptStatus ? { attemptStatus: outcome.attemptStatus } : {}),
      }
      try { store.annotate(current.intakeId, current.revision, { verification }) } catch (error) { log({ event: 'managed-verification-unrecorded', taskId, error: String(error && error.message ? error.message : error) }) }
      log({ event: 'managed-verification-finished', taskId, state, complete: Boolean(verification.completion && verification.completion.complete) })
      return verification
    })()
    verifyFlights.set(taskId, flight)
    flight.finally(() => { if (verifyFlights.get(taskId) === flight) verifyFlights.delete(taskId) }).catch(() => {})
    return { ok: true, disposition: 'accepted', startedAt, flight }
  }

  /**
   * Close a held or stalled managed task. Nothing resumes: an open attempt is
   * closed as interrupted (TaskController), pending approvals are withdrawn,
   * the intake record (identity, history, tombstone) is kept.
   */
  async function closeTask(taskId, { actionId, reason, operator }) {
    const record = store.byTaskId(taskId)
    if (!record) return { ok: false, code: 'NOT_FOUND' }
    if (record.closedAt) return { ok: true, disposition: record.closeActionId === actionId ? 'duplicate' : 'already_closed' }
    if (activeTurns.has(record.sessionId)) return { ok: false, code: 'STALE_ACTION', reason: 'turn-live-use-cancel' }
    if (verifyFlights.has(taskId)) return { ok: false, code: 'STALE_ACTION', reason: 'verification-in-progress' }
    if (closing.has(taskId)) return { ok: false, code: 'STALE_ACTION', reason: 'task-closing' }
    if (reviewFlights.has(taskId) || gateFlights.has(taskId)) return { ok: false, code: 'STALE_ACTION', reason: 'operation-running' }
    // P2-B2E arbitration: a continuation being delivered wins over close for
    // that revision (the operator sees the new turn and decides again).
    if (tickets.has(record.sessionId) || continuationsOf(record).some((turn) => turn.state === 'reserved' || turn.state === 'delivering')) return { ok: false, code: 'STALE_ACTION', reason: 'turn-pending' }
    closing.add(taskId) // synchronous lock: continuation and verification refuse from here on
    let attemptClosed = false
    try {
      if (record.taskInstanceId) {
        try { attemptClosed = Boolean((await ports.closeAttempt({ sessionId: record.sessionId, taskInstanceId: record.taskInstanceId })).attemptClosed) } catch (error) { log({ event: 'managed-close-attempt-failed', taskId, error: String(error && error.message ? error.message : error) }) }
      }
      broker.cancelTask(taskId)
      const current = store.byTaskId(taskId)
      store.annotate(current.intakeId, current.revision, { closedAt: new Date().toISOString(), closeReason: String(reason || 'operator-closed').slice(0, 200), closeActionId: actionId || null, closedBy: operator || null, attemptClosed })
    } finally { closing.delete(taskId) }
    log({ event: 'managed-task-closed', taskId, reason, attemptClosed })
    return { ok: true, disposition: 'closed', attemptClosed }
  }

  // ── P2-B2F review and gate actions (existing authorities only) ─────────
  const reviewFlights = new Map() // taskId -> promise
  const gateFlights = new Map()   // taskId -> promise

  /** A recorded review belongs to the task's current candidate (turn). */
  function reviewIsCurrent(record) {
    const turn = currentTurn(record)
    return Boolean(record && record.review && turn && record.review.turnId === turn.turnId && ['passed', 'failed', 'uncertain'].includes(record.review.state))
  }

  /**
   * Run the existing explicit independent review (EMv1 Dual by strategy) for
   * the current candidate. Durable intent before dispatch, outcome after; the
   * reviewer never completes the task (TaskController decides at
   * verification or through the existing review gate).
   */
  function runReview(taskId, { actionId, attempt, operator }) {
    if (reviewFlights.has(taskId)) return { ok: false, code: 'STALE_ACTION', reason: 'review-in-progress' }
    const record = store.byTaskId(taskId)
    if (!record || !record.taskInstanceId) return { ok: false, code: 'NOT_FOUND' }
    const turn = currentTurn(record)
    if (closing.has(taskId) || record.closedAt) return { ok: false, code: 'STALE_ACTION', reason: 'task-closing' }
    if (verifyFlights.has(taskId) || record.verification) return { ok: false, code: 'STALE_ACTION', reason: 'verification-started' }
    if (activeTurns.has(record.sessionId) || tickets.has(record.sessionId) || !turn || turn.state !== 'accepted' || !turn.turnEndedAt) return { ok: false, code: 'STALE_ACTION', reason: 'turn-not-settled' }
    if (continuationsOf(record).some((item) => item.state === 'reserved' || item.state === 'delivering')) return { ok: false, code: 'STALE_ACTION', reason: 'turn-pending' }
    const startedAt = new Date().toISOString()
    const runs = record.review && record.review.turnId === turn.turnId ? (record.review.runs || 1) + 1 : 1
    store.annotate(record.intakeId, record.revision, { review: { state: 'running', actionId, attempt: String(attempt), turnId: turn.turnId, operator: operator || null, startedAt, runs } })
    log({ event: 'managed-review-started', taskId, attempt, turnId: turn.turnId })
    const flight = (async () => {
      let outcome
      try {
        outcome = await ports.review({ sessionId: record.sessionId, taskInstanceId: record.taskInstanceId, attempt })
      } catch (error) {
        outcome = { review: 'incomplete', reason: (error && error.code ? error.code + ': ' : '') + String(error && error.message ? error.message : error).slice(0, 300) }
      }
      const current = store.byTaskId(taskId)
      const state = outcome && ['passed', 'failed', 'uncertain', 'incomplete', 'rejected', 'unavailable'].includes(outcome.review) ? outcome.review : 'incomplete'
      const review = {
        ...current.review,
        state,
        finishedAt: new Date().toISOString(),
        ...(outcome && outcome.verdict ? { verdict: String(outcome.verdict) } : {}),
        ...(outcome && Number.isInteger(outcome.findings) ? { findings: outcome.findings, blockingFindings: outcome.blockingFindings || 0 } : {}),
        ...(outcome && outcome.completedAt ? { reviewCompletedAt: String(outcome.completedAt) } : {}),
        ...(outcome && outcome.reason ? { reason: String(outcome.reason).slice(0, 300) } : {}),
        ...(outcome && outcome.gateOpened ? { gateOpened: true } : {}),
      }
      try { store.annotate(current.intakeId, current.revision, { review }) } catch (error) { log({ event: 'managed-review-unrecorded', taskId, error: String(error && error.message ? error.message : error) }) }
      log({ event: 'managed-review-finished', taskId, state })
      return review
    })()
    reviewFlights.set(taskId, flight)
    flight.finally(() => { if (reviewFlights.get(taskId) === flight) reviewFlights.delete(taskId) }).catch(() => {})
    return { ok: true, disposition: 'accepted', startedAt, flight }
  }

  /**
   * Answer the existing controller-owned review gate (approve/reject), or
   * re-run the completion check of an already approved gate. Durable intent
   * first; the gate journal (requestId = action id) prevents a second
   * resolution; on approve the ONE bounded transition is the TaskController
   * completion with the review passed — exactly the Control Room behavior.
   */
  async function resolveGateAction(taskId, { actionId, gateId, choice, mode, operator }) {
    if (gateFlights.has(taskId)) return { ok: false, code: 'STALE_ACTION', reason: 'gate-action-in-progress' }
    const record = store.byTaskId(taskId)
    if (!record || !record.taskInstanceId) return { ok: false, code: 'NOT_FOUND' }
    if (closing.has(taskId) || record.closedAt) return { ok: false, code: 'STALE_ACTION', reason: 'task-closing' }
    const startedAt = new Date().toISOString()
    store.annotate(record.intakeId, record.revision, { gateAction: { state: 'running', actionId, gateId, choice, mode: mode || 'resolve', operator: operator || null, startedAt } })
    const flight = (async () => {
      let outcome
      try {
        outcome = await ports.gate({ sessionId: record.sessionId, taskInstanceId: record.taskInstanceId, gateId, choice, mode: mode || 'resolve', requestId: actionId })
      } catch (error) {
        outcome = { disposition: 'failed', reason: (error && error.code ? error.code + ': ' : '') + String(error && error.message ? error.message : error).slice(0, 300) }
      }
      const current = store.byTaskId(taskId)
      const gateAction = {
        ...current.gateAction,
        state: outcome && ['resolved', 'duplicate', 'completion-rerun'].includes(outcome.disposition) ? 'done' : outcome && outcome.disposition === 'stale' ? 'stale' : 'failed',
        disposition: outcome ? outcome.disposition : 'failed',
        finishedAt: new Date().toISOString(),
        ...(outcome && outcome.gateStatus ? { gateStatus: outcome.gateStatus } : {}),
        ...(outcome && outcome.completion ? { completion: outcome.completion } : {}),
        ...(outcome && outcome.reason ? { reason: String(outcome.reason).slice(0, 300) } : {}),
      }
      try { store.annotate(current.intakeId, current.revision, { gateAction }) } catch (error) { log({ event: 'managed-gate-unrecorded', taskId, error: String(error && error.message ? error.message : error) }) }
      log({ event: 'managed-gate-action-finished', taskId, choice, disposition: gateAction.disposition })
      return gateAction
    })()
    gateFlights.set(taskId, flight)
    flight.finally(() => { if (gateFlights.get(taskId) === flight) gateFlights.delete(taskId) }).catch(() => {})
    const settled = await flight
    return { ok: settled.state === 'done', code: settled.state === 'stale' ? 'STALE_ACTION' : settled.state === 'failed' ? 'INTERNAL' : undefined, disposition: settled.disposition, gateAction: settled }
  }

  async function cancel(taskId) {
    const record = store.byTaskId(taskId)
    if (!record) return { ok: false, code: 'NOT_FOUND', message: 'No authorized task with that id.' }
    if (record.closedAt) return { ok: true, data: { taskId, disposition: 'already_terminal' } }
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
    runVerification,
    closeTask,
    continueTask,
    runReview,
    resolveGateAction,
    reviewIsCurrent: (record) => reviewIsCurrent(record),
    isReviewing: (taskId) => reviewFlights.has(taskId),
    isGateActing: (taskId) => gateFlights.has(taskId),
    continuationRefusal: (record, extra) => continuationRefusal(record, extra),
    isVerifying: (taskId) => verifyFlights.has(taskId),
    isClosing: (taskId) => closing.has(taskId),
    /** Nexus's last assistant text in a managed session (read-only; null when unavailable). */
    async lastReply(sessionId) { try { return typeof ports.lastReply === 'function' ? await ports.lastReply(sessionId) : null } catch { return null } },
    /** Whether a mode currently resolves a runnable profile of its engine. */
    modeProfile(mode) { const entry = MODES[mode]; if (!entry) return null; try { return ports.resolveProfile(entry.preset) || null } catch { return null } },
    activeSessionIds: () => [...activeTurns.keys()],
    get reconciled() { return reconciled },
    metrics: () => ({ ...metrics, activeTurns: activeTurns.size, inFlight: flights.size }),
  })
}

module.exports = { createManagedTasks, turnsOf, currentTurn, publicTurn, MAX_TURNS, deliveryEvidence, lastUserRpcId, ManagedTaskError, MODES, MAX_PROMPT_BYTES }
