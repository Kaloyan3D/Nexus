'use strict'

/**
 * Engineering-Isolation.cjs — controller-target enforcement at the actual
 * DSH agent/request boundary.
 *
 * MODEL SELECTION HAS ONE AUTHORITY: the deterministic controller plane.
 * Routing.ps1 / Engineering StepRouting resolve the active profile + role +
 * model registry exactly once and persist the resolved target in controller
 * state. This plugin NEVER re-resolves a profile or silently chooses another
 * model. It only enforces the target already selected by the controller.
 *
 * Effective target precedence for a top-level engineering request:
 *   1. current step-routing record.roleTarget (step/milestone routing),
 *   2. task routing-state provider/model/reasoning (task-level route).
 *
 * If the controller did not produce a complete target, execution FAILS
 * CLOSED. In particular there is no historical DeepSeek fallback: a broken
 * profile/controller path must be visible instead of silently spending a
 * different provider while the UI reports the requested profile.
 *
 * Worker (subagent) sessions remain untouched: their models are configured by
 * delegation rows, exactly as before.
 */

const fs = require('node:fs')
const path = require('node:path')
const profiles = require('./Engineering-Profiles.cjs')

/** Read the persisted session binding (workspace/taskId/preset) for a session. */
function bindingFor(installRoot, sessionId) {
  try {
    const document = JSON.parse(
      fs.readFileSync(path.join(installRoot, 'data', 'routing', 'session-bindings.json'), 'utf8'),
    )
    if (document && document.schemaVersion === 1 && document.bindings && typeof document.bindings === 'object') {
      return document.bindings[sessionId] || null
    }
  } catch {
    /* fail closed at controllerTargetFor */
  }
  return null
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function routingStateFor(installRoot, binding) {
  const statePath = profiles.routingStatePath(installRoot, binding)
  return statePath ? readJson(statePath) : null
}

function targetShape(value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const reasoning = typeof value.reasoning === 'string' ? value.reasoning.trim() : ''
  if (!provider || !model || !reasoning) return null
  return {
    provider,
    model,
    reasoning,
    modelDisplayName: typeof value.modelDisplayName === 'string' ? value.modelDisplayName : null,
    vendor: typeof value.vendor === 'string' ? value.vendor : null,
    role: typeof value.role === 'string' ? value.role : null,
    profile: typeof value.profile === 'string'
      ? value.profile
      : (typeof value.profileId === 'string' ? value.profileId : null),
    profileDisplayName: typeof value.profileDisplayName === 'string' ? value.profileDisplayName : null,
  }
}

/**
 * Latest controller-owned step target for this exact task generation.
 * StepRouting writes one JSONL record per engineering turn and embeds the
 * already-resolved roleTarget. Reading that target here removes the former
 * second profile/model resolver from the DSH execution plane.
 */
function latestStepTargetFor(binding, expectedStepRole) {
  if (!binding || typeof binding.workspace !== 'string' || typeof binding.taskId !== 'string') return null
  const filePath = path.join(binding.workspace, '.ai-harness', 'runs', binding.taskId, 'step-routing.jsonl')
  let text
  try { text = fs.readFileSync(filePath, 'utf8') } catch { return null }
  const expectedInstance = typeof binding.taskInstanceId === 'string' && binding.taskInstanceId !== ''
    ? binding.taskInstanceId
    : null
  let latest = null
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (!record || typeof record !== 'object') continue
    if (expectedInstance !== null && record.taskInstanceId !== expectedInstance) continue
    if (record.selectedRole !== 'engineer_normal' && record.selectedRole !== 'engineer_deep') continue
    if (expectedStepRole && record.selectedRole !== expectedStepRole) continue
    const target = targetShape(record.roleTarget)
    if (!target) continue
    latest = {
      ...target,
      role: target.role || (record.selectedRole === 'engineer_deep' ? 'deepEngineer' : 'primaryEngineer'),
      source: 'step-routing',
      stepRole: record.selectedRole,
      stepId: typeof record.stepId === 'string' ? record.stepId : null,
    }
  }
  return latest
}

function enforcementError(reason, binding, state) {
  const task = binding && binding.taskId ? String(binding.taskId) : 'unbound'
  const preset = binding && binding.preset ? String(binding.preset) : 'unknown'
  const profile = state && state.profile ? String(state.profile) : 'unknown'
  const error = new Error(
    `Nexus execution target unavailable (${reason}) for task ${task}; preset=${preset}; profile=${profile}. ` +
    'Execution was blocked instead of silently falling back to another model.',
  )
  error.code = 'nexus-execution-target-unavailable'
  return error
}

/**
 * Resolve the EFFECTIVE request target from controller-produced state only.
 * No settings/profile/registry resolution is allowed here.
 */
function controllerTargetFor(installRoot, binding) {
  if (!binding) throw enforcementError('missing-session-binding', binding, null)
  const state = routingStateFor(installRoot, binding)
  if (!state) throw enforcementError('missing-routing-state', binding, null)

  const stepRole = state.stepRole === 'engineer_normal' || state.stepRole === 'engineer_deep'
    ? state.stepRole
    : null
  if (stepRole) {
    const stepTarget = latestStepTargetFor(binding, stepRole)
    if (stepTarget) return { ...stepTarget, state }

    // Upgrade compatibility: an older persisted state may carry stepRole but
    // predate roleTarget-in-step records. It is safe to reuse the task target
    // ONLY when the step role equals the task execution class; otherwise that
    // would silently collapse Deep/Normal routing into the wrong model.
    if (profiles.canonicalExecutionClass(state.executionClass) !== profiles.canonicalExecutionClass(stepRole)) {
      throw enforcementError('step-target-missing-for-role-change', binding, state)
    }
  }

  const taskTarget = targetShape(state)
  if (!taskTarget) throw enforcementError('incomplete-routing-target', binding, state)
  return {
    ...taskTarget,
    role: taskTarget.role || profiles.roleOfExecutionClass(state.executionClass),
    profile: taskTarget.profile || (typeof state.profile === 'string' ? state.profile : null),
    source: 'routing-state',
    stepRole,
    state,
  }
}

function apply(ctx) {
  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    const session = payload && payload.agent && payload.agent.session
    const header = session && session.header
    if (!header) return proposed
    const isWorker = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    if (isWorker) return proposed

    const installRoot = profiles.installRootOf()
    const binding = bindingFor(installRoot, session.id)
    const target = controllerTargetFor(installRoot, binding)

    return Object.freeze({
      ...proposed,
      provider: target.provider,
      model: target.model,
      reasoningEffort: target.reasoning,
    })
  })
}

module.exports = {
  name: 'aih-engineering-isolation',
  apply,
  bindingFor,
  routingStateFor,
  targetShape,
  latestStepTargetFor,
  controllerTargetFor,
}
