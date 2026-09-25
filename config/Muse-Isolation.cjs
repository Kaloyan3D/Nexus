'use strict'

/**
 * Muse-Isolation.cjs — the Muse V0 request boundary (agent plane: aih-muse).
 *
 * MODEL SELECTION HAS ONE AUTHORITY: the deterministic controller plane.
 * Routing.ps1 resolves the active Nexus profile (engine: muse) -> Muse
 * profile -> model registry -> provider route exactly once and persists the
 * resolved target in controller state. This plugin NEVER re-resolves a
 * profile, provider, model, or reasoning level. It only enforces the target
 * the controller already produced.
 *
 * Fail-closed contract (V0):
 *   - The task routing state MUST carry engine === 'muse'. A state without an
 *     engine field predates the Muse plane (legacy/Dual) and is blocked: the
 *     Muse agent plane never executes Dual targets.
 *   - The state MUST carry a complete provider/model/reasoning target. There
 *     is NO fallback provider, model, or reasoning level.
 *   - Every request is capped at the Nexus V0 effective output bound. The
 *     vendor hard maximum for muse-spark-1.3-contributor (131072 completion
 *     tokens) is a separate, larger number and is NOT the Nexus budget.
 *   - This plane has NO delegation rows: no subagent or workflow tool can
 *     exist here, so every request is the one Muse main agent. Unlike the
 *     Dual isolation there is deliberately NO worker exemption.
 *
 * Adaptive reasoning effort (Phase 2, TASK-0049): the per-call reasoning
 * effort is resolved by the Muse Reasoning Governor from task-local
 * reasoning state immediately before each request
 * (Muse-ReasoningRuntime.cjs prepareMuseRequestEffort). Precedence:
 *   1. task-local museReasoning state (initialized to discover on first use);
 *   2. Governor resolution against the actual registry entry;
 *   3. the resolved effort is written back to state.reasoning AND enforced
 *      here as reasoningEffort, overriding the static profile-default
 *      reasoning from routing time. The profile default never overrides an
 *      adaptive Governor result.
 * A MuseReasoningCapabilityError propagates unchanged and no request is
 * returned (fail closed, no fallback effort). Workers cannot override: the
 * enforced effort is overwritten unconditionally on every request.
 */

const fs = require('node:fs')
const path = require('node:path')
const profiles = require('./Engineering-Profiles.cjs')
const reasoningRuntime = require('./Muse-ReasoningRuntime.cjs')

const MUSE_ENGINE = 'muse'
const MUSE_AGENT_PRESET = 'aih-muse'

/**
 * Nexus V0 effective maximum completion tokens per root call. Deterministic,
 * documented in docs/architecture/muse-agent-plane-v0.md, and independent of
 * the vendor hard maximum.
 */
const MUSE_V0_MAX_OUTPUT_TOKENS = 32768

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
    role: typeof value.role === 'string' && value.role !== '' ? value.role : null,
    profile: typeof value.profile === 'string'
      ? value.profile
      : (typeof value.profileId === 'string' ? value.profileId : null),
    profileDisplayName: typeof value.profileDisplayName === 'string' ? value.profileDisplayName : null,
    engine: typeof value.engine === 'string' && value.engine !== '' ? value.engine : MUSE_ENGINE,
    dataUseTier: typeof value.dataUseTier === 'string' && value.dataUseTier !== '' ? value.dataUseTier : null,
  }
}

function sessionPreset(session) {
  if (Array.isArray(session.events)) {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event && event.type === 'agent-preset/selected' && event.data && event.data.agentPreset) {
        return event.data.agentPreset
      }
    }
  }
  return session.header && session.header.agentPreset
}

function enforcementError(reason, binding, state, code) {
  const task = binding && binding.taskId ? String(binding.taskId) : 'unbound'
  const preset = binding && binding.preset ? String(binding.preset) : 'unknown'
  const engine = state && typeof state.engine === 'string' && state.engine !== '' ? String(state.engine) : 'none'
  const profile = state && state.profile ? String(state.profile) : 'unknown'
  const error = new Error(
    `Nexus Muse execution blocked (${reason}) for task ${task}; preset=${preset}; engine=${engine}; profile=${profile}. ` +
      'The Muse plane executes only against a complete controller-produced muse target; there is no fallback provider, model, or reasoning level.',
  )
  error.code = code || 'nexus-execution-target-unavailable'
  return error
}

/**
 * Resolve the EFFECTIVE request target from controller-produced state only.
 * The Muse plane adds one invariant on top of the Dual contract: the routing
 * state must BE a muse-engine state. No settings/profile/registry resolution
 * is allowed here, and no Dual role is ever derived.
 */
function controllerTargetFor(installRoot, binding) {
  if (!binding) throw enforcementError('missing-session-binding', binding, null)
  if (binding.engine !== MUSE_ENGINE) {
    throw enforcementError('session-binding-is-not-muse-engine', binding, null, 'engine-binding-violation')
  }
  const state = routingStateFor(installRoot, binding)
  if (!state) throw enforcementError('missing-routing-state', binding, null)
  if (state.engine !== MUSE_ENGINE) {
    // Includes legacy/Dual states that predate the engine field entirely.
    throw enforcementError('routing-state-is-not-muse-engine', binding, state, 'nexus-muse-engine-mismatch')
  }
  const target = targetShape(state)
  if (!target) throw enforcementError('incomplete-routing-target', binding, state)
  return {
    ...target,
    profile: target.profile || (typeof state.profile === 'string' ? state.profile : null),
    source: 'routing-state',
    state,
  }
}

function apply(ctx) {
  ctx.shellEnv.register({
    name: 'aih-muse-preset',
    variables: { DSH_AIH_PRESET: { description: 'Active AI Harness engineering preset.' } },
    resolve: (execution) =>
      execution.agent === undefined || !execution.agent.session || sessionPreset(execution.agent.session) !== MUSE_AGENT_PRESET
        ? {}
        : { DSH_AIH_PRESET: MUSE_AGENT_PRESET },
  })

  ctx.on('agent/request', async (payload, next) => {
    const session = payload && payload.agent && payload.agent.session
    if (!session) throw enforcementError('missing-session', null, null)
    const installRoot = profiles.installRootOf()
    const binding = bindingFor(installRoot, session.id)
    const requestedEngine = sessionPreset(session) === MUSE_AGENT_PRESET ? 'muse' : 'dual'
    if (binding && binding.engine !== requestedEngine) {
      throw enforcementError('session-preset-does-not-match-bound-engine', binding, null, 'engine-binding-violation')
    }
    if (!binding && requestedEngine !== 'muse') return next()
    if (binding && binding.engine !== MUSE_ENGINE) return next()
    const target = controllerTargetFor(installRoot, binding)

    // Phase 2: per-call adaptive effort from task-local reasoning state.
    // Resolved BEFORE the downstream pipeline runs, so a capability refusal
    // (MuseReasoningCapabilityError) means no request is produced at all --
    // never a fallback effort, never the stale profile default.
    const adaptive = reasoningRuntime.prepareMuseRequestEffort({ installRoot, binding, target })

    payload.routingAuthority = {
      source: 'controller',
      target: { provider: target.provider, model: target.model },
    }

    const proposed = await next()

    const proposedMaxTokens =
      typeof proposed.maxTokens === 'number' && Number.isFinite(proposed.maxTokens) && proposed.maxTokens > 0
        ? proposed.maxTokens
        : MUSE_V0_MAX_OUTPUT_TOKENS
    return Object.freeze({
      ...proposed,
      provider: target.provider,
      model: target.model,
      reasoningEffort: adaptive.effort,
      maxTokens: Math.min(proposedMaxTokens, MUSE_V0_MAX_OUTPUT_TOKENS),
    })
  })
}

module.exports = {
  name: 'aih-muse-isolation',
  inject: ['shellEnv'],
  apply,
  bindingFor,
  routingStateFor,
  targetShape,
  sessionPreset,
  controllerTargetFor,
  MUSE_V0_MAX_OUTPUT_TOKENS,
}
