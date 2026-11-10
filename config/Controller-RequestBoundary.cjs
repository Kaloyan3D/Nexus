'use strict'

/**
 * Controller-RequestBoundary.cjs — the one composition pattern the preset
 * isolation plugins (Muse-Isolation.cjs, Engineering-Isolation.cjs,
 * DeepSeek-Isolation.cjs) use to apply a controller-produced provider/model/
 * effort route to a DSH agent (DSH 0.2.x model-selection lifecycle).
 *
 * WHY THE 0.1.x PATTERN IS GONE
 *   DSH 0.1.x let a request listener declare `payload.routingAuthority`
 *   (a Nexus patch to dsh-agent) and rewrite the route inside `agent/request`.
 *   DSH 0.2.x fixes the step's route BEFORE `agent/pre-step`
 *   (`agent.model.current()` = durable `model/selection` projection) and
 *   throws if `agent/request` proposes a different provider, model or
 *   reasoning effort ("use agent.model.select() before step preparation").
 *   There is no request-local route any more and no vendored patch.
 *
 * THE 0.2.x PATTERN (supported APIs only: agent.model.select + agent events)
 *   arm    (`agent/inbox/claimed`, then `agent/pre-step`): resolves the
 *          controller target with the plane's `targetFor`, runs the plane's
 *          `prepare` (adaptive effort), and records the complete selection
 *          with `agent.model.select()`. `agent/inbox/claimed` is dispatched by
 *          the inbox claim immediately before the loop reads
 *          `agent.model.current()`, so a turn's first step is exact. The
 *          pre-step arm prepares the FOLLOWING step.
 *   guard  (`agent/request`, preset row): the unchanged fail-closed gate.
 *          It re-validates task identity and Registry binding, re-resolves
 *          the controller target, and requires that the route the loop
 *          already fixed equals the armed selection AND the current target.
 *          A mismatch (stale arm, controller changed mid-turn, selection
 *          written by anyone else, effort drift) fails closed; the arm that
 *          ran for the next step makes a retry converge.
 *
 * DIFFERENCES FROM 0.1.x (deliberate, documented, not hidden):
 *   - Durable: a route/effort change appends a `model/selection` session
 *     event, and a provider/model change adds the upstream
 *     "[model changed: ...]" notice to the transcript (effort-only changes
 *     add none). 0.1.x kept the route request-local and out of the session.
 *   - Granularity: the route is applied at turn start / message claim and for
 *     the next step; a controller target that changes in the middle of a turn
 *     is refused for the current step (fail closed), never silently applied.
 *   - Adaptive effort (Muse) takes effect one step later than at the old
 *     request-time computation; it is computed once per arm, never per
 *     request, so request and recorded state cannot disagree.
 *   - Nothing here lowers authority: no fallback route exists, and the guard
 *     verifies provider, model and effort on every request.
 */

const registryBinding = require('./registry/session-binding.cjs')
const registryService = require('./registry/service.cjs')
const profiles = require('./Engineering-Profiles.cjs')
const path = require('node:path')
const fs = require('node:fs')
const runCli = require('node:util').promisify(require('node:child_process').execFile)

async function assertCurrentTaskIdentity(installRoot, binding) {
  const toolchainRoot = process.env.AIH_TOOLCHAIN_ROOT || installRoot
  const pinned = path.join(toolchainRoot, 'runtime', 'pwsh', 'pwsh')
  const host = process.platform === 'win32' ? 'powershell.exe' :
    (process.env.AIH_PWSH_HOST || (fs.existsSync(pinned) ? pinned : 'pwsh'))
  // EncodedCommand transports Unicode paths without shell interpolation or
  // Windows argv codepage conversion. TaskController remains the authority.
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'"
  const command = '& ' + quote(path.join(installRoot, 'scripts', 'Task.ps1')) +
    ' -Action test-task -Workspace ' + quote(binding.workspace) +
    ' -TaskId ' + quote(binding.taskId) + ' -TaskInstanceId ' + quote(binding.taskInstanceId)
  try {
    const result = await runCli(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, AIH_TOOLCHAIN_ROOT: toolchainRoot } })
    const identity = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
    if (identity.exists !== true || identity.instanceMatches !== true || identity.taskId !== binding.taskId || identity.taskInstanceId !== binding.taskInstanceId) throw new Error('Task identity differs')
    if (identity.boundEngine !== binding.engine) {
      const error = new Error('TaskController engine does not match the request binding.')
      error.code = 'engine-binding-violation'
      throw error
    }
    return identity
  } catch (cause) {
    if (cause && cause.code === 'engine-binding-violation') throw cause
    const error = new Error('Registry request identity is unverifiable; no downstream request authorized.', { cause })
    error.code = 'binding-validation-inconclusive'
    throw error
  }
}

function sameRoute(value, target) {
  return Boolean(value) && value.provider === target.provider && value.model === target.model
}

function selectionOf(target, effort) {
  return {
    provider: target.provider,
    model: target.model,
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
  }
}

function currentSelection(agent) {
  const model = agent && agent.model
  if (!model || typeof model.current !== 'function' || typeof model.select !== 'function') {
    const error = new Error('Controller route cannot be applied: the DSH agent has no model-selection API.')
    error.code = 'controller-route-selection-unavailable'
    throw error
  }
  return model.current()
}

/**
 * Install the arm/guard pair for one controller plane.
 *
 * @param ctx - the preset row's plugin context.
 * @param boundary - the plane's request semantics:
 *   targetFor(payload)  -> null (not this plane's request: pass through) or
 *                          the controller target ({ provider, model, ... });
 *                          throws to fail closed. Must be side-effect free and
 *                          read only `payload.agent`.
 *   prepare(payload, target) -> optional per-arm value (`{ effort }` for an
 *                          adaptive plane), computed once per arm.
 *   finalize(proposed, target, prepared) -> the request to return; must keep
 *                          every proposed field it does not own and may not
 *                          change provider, model or reasoning effort.
 *   fail(reason, target) -> the plane's fail-closed Error.
 */
function installControllerRequestBoundary(ctx, boundary) {
  const armedByAgent = new WeakMap()
  const markedScopes = new WeakSet()
  function observe(payload, target) {
    const agent = payload && payload.agent
    if (!agent) return
    const scope = agent.ctx || agent
    const binding = target && target.binding
    const marked = registryBinding.classifyRegistryState(binding).state !== 'legacy'
    if (markedScopes.has(scope) && !marked && (!binding || binding.bindingAuthority !== 'legacy-rollback')) {
      const error = new Error('Registry authority removed without a durable explicit rollback.')
      error.code = 'registry-authority-unverifiable'
      throw error
    }
    if (marked) markedScopes.add(scope)
  }

  // Resolve the controller target and record the complete selection with the
  // supported DSH API. Never throws: a refusal is stored and re-raised by the
  // guard on the request path so no request is produced.
  function arm(agent) {
    if (!agent || !agent.session) return
    const payload = { agent }
    let target
    try {
      target = boundary.targetFor(payload)
      observe(payload, target)
      if (target === null) { armedByAgent.delete(agent); return }
      const prepared = boundary.prepare ? boundary.prepare(payload, target) : undefined
      const effort = prepared && Object.hasOwn(prepared, 'effort') ? prepared.effort : target.reasoning
      const selection = selectionOf(target, effort)
      currentSelection(agent)
      agent.model.select(selection)
      armedByAgent.set(agent, { target, prepared, selection })
    } catch (error) {
      armedByAgent.set(agent, { error, target })
      armProvisional(agent, payload)
    }
  }

  // No controller target yet (a brand-new session is bound later, in
  // pre-step): record the plane's provisional selection so the step DSH fixes
  // right after this claim already carries the expected route and effort.
  // Selection only — the armed state stays the refusal above, and the request
  // guard verifies the real target as always.
  function armProvisional(agent, payload) {
    if (typeof boundary.provisionalTargetFor !== 'function') return
    try {
      const provisional = boundary.provisionalTargetFor(payload)
      if (!provisional) return
      const selection = selectionOf(provisional, provisional.reasoning)
      const current = currentSelection(agent)
      if (current && sameRoute(current, selection) && current.reasoningEffort === selection.reasoningEffort) return
      agent.model.select(selection)
    } catch { /* provisional arming is best effort; the guard stays authoritative */ }
  }

  ctx.on('agent/inbox/claimed', (payload) => {
    arm(payload && payload.agent)
  })

  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload && payload.agent
    observe(payload, boundary.targetFor(payload))
    arm(agent)
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    let target = boundary.targetFor(payload)
    observe(payload, target)
    if (target === null) return next()
    // R7.5A: pre-step is not the final request boundary. Re-read entitlement
    // here before downstream work, including later steps of an open attempt.
    let binding = target.binding
    if (registryBinding.classifyRegistryState(binding).state !== 'legacy' || markedScopes.has(payload.agent.ctx || payload.agent) || binding?.bindingAuthority === 'legacy-rollback') {
      const installRoot = target.installRoot || profiles.installRootOf()
      const identity = await assertCurrentTaskIdentity(installRoot, binding)
      // TaskController validation awaits a subprocess. Re-read authority and
      // target afterwards so a durable change during that wait cannot reuse
      // the earlier authorization snapshot. No async gap remains to dispatch.
      const current = boundary.targetFor(payload)
      if (!current || !current.binding || current.binding.taskId !== binding.taskId ||
          current.binding.taskInstanceId !== binding.taskInstanceId) {
        const error = new Error('Registry request generation changed during identity validation.')
        error.code = 'registry-generation-mismatch'
        throw error
      }
      if (current.binding.engine !== identity.boundEngine) {
        const error = new Error('Request engine changed during authoritative identity validation.')
        error.code = 'engine-binding-violation'
        throw error
      }
      observe(payload, current)
      target = current
      binding = current.binding
      let connection = null
      const role = binding.engine === 'muse' ? 'muse_main' : target.role
      const entry = registryBinding.mapEntryFor(binding.registryPin, role)
      if (entry && entry.target) {
        const svc = registryService.createService({ installRoot, dataRoot: process.env.DSH_HOME || path.join(installRoot, 'data') })
        const current = svc.getConnections()
        connection = (current.connections || []).find((c) => c.id === entry.target.connectionId) || null
      }
      const verdict = registryBinding.checkExecutionTarget({ binding, target, connection, flagOn: registryBinding.isRegistryBindingEnabled(process.env) })
      if (!verdict.ok) {
        const error = new Error('Registry request refused (' + verdict.code + '); no downstream request authorized.')
        error.code = verdict.code
        throw error
      }
    }
    const agent = payload.agent
    const armed = armedByAgent.get(agent)
    // The loop fixed this step's route before agent/request. It must be the
    // route armed for the CURRENT controller target; anything else (never
    // armed, arm refused, stale arm, or a selection written by another
    // party) fails closed. Re-arm so the next attempt converges.
    if (!armed) { arm(agent); throw boundary.fail('controller-route-selection-not-armed', target) }
    if (armed.error) { const refusal = armed.error; arm(agent); throw refusal }
    if (!sameRoute(armed.selection, target)) { arm(agent); throw boundary.fail('controller-route-selection-stale', target) }
    const fixed = currentSelection(agent)
    if (!fixed || !sameRoute(fixed, target) || fixed.reasoningEffort !== armed.selection.reasoningEffort) {
      arm(agent)
      throw boundary.fail('step-selection-differs-from-controller-target', target)
    }
    const resolved = await next()
    if (!sameRoute(resolved, target)) throw boundary.fail('effective-route-differs-from-controller-target', target)
    if (resolved.reasoningEffort !== armed.selection.reasoningEffort) {
      throw boundary.fail('effective-effort-differs-from-armed-effort', target)
    }
    if (registryBinding.classifyRegistryState(binding).state === 'pinned' && resolved.reasoningEffort !== target.reasoning) {
      throw boundary.fail('effective-effort-differs-from-pinned-target', target)
    }
    const finalized = boundary.finalize(resolved, target, armed.prepared)
    if (!sameRoute(finalized, target) || finalized.reasoningEffort !== resolved.reasoningEffort) {
      throw boundary.fail('finalize-changed-the-controller-route', target)
    }
    return Object.freeze(finalized)
  })
}

module.exports = {
  installControllerRequestBoundary,
}
