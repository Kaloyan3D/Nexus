'use strict'

const shellEnvironment = require('./Preset-ShellEnvironment.cjs')
const dualTarget = require('./Engineering-Isolation.cjs')
const profiles = require('./Engineering-Profiles.cjs')
const requestBoundary = require('./Controller-RequestBoundary.cjs')
const registryBinding = require('./registry/session-binding.cjs')

const ALLOWED = new Map([
  ['deepseek-pro-direct', new Set(['deepseek-v4-pro'])],
  ['flash-max-direct', new Set(['deepseek-v4-flash'])],
  ['flash-high-direct', new Set(['deepseek-v4-flash'])],
])

function allowed(provider, model) {
  return ALLOWED.get(provider)?.has(model) === true
}

function topLevelReasoning(proposed) {
  return proposed.reasoningEffort === 'high' || proposed.reasoningEffort === 'max'
    ? proposed.reasoningEffort
    : 'max'
}

function refusal(reason, code) {
  const error = new Error('DeepSeek request refused (' + reason + '); no downstream request authorized.')
  error.code = code
  return error
}

function apply(ctx) {
  shellEnvironment.ensure(ctx)

  // These observations may only make authorization stricter. They never
  // supply a route, grant entitlement, or replace the durable source of truth.
  const boundAgents = new WeakSet()
  const markedAgents = new WeakSet()
  function currentBinding(agent) {
    const session = agent && agent.session
    const scope = agent && (agent.ctx || agent)
    if (!session) throw refusal('missing-session', 'bindings-unverifiable')
    const binding = dualTarget.bindingFor(profiles.installRootOf(), session.id)
    if (!binding && boundAgents.has(scope)) throw refusal('required-binding-missing', 'bindings-unverifiable')
    if (binding) boundAgents.add(scope)
    const marked = registryBinding.classifyRegistryState(binding).state !== 'legacy'
    if (markedAgents.has(scope) && !marked && (!binding || binding.bindingAuthority !== 'legacy-rollback')) {
      throw refusal('marked-authority-removed-without-rollback', 'registry-authority-unverifiable')
    }
    if (marked) markedAgents.add(scope)
    return binding
  }
  ctx.on('agent/pre-step', (payload, next) => {
    currentBinding(payload.agent)
    return next()
  })
  requestBoundary.installControllerRequestBoundary(ctx, {
    targetFor(payload) {
      const agent = payload && payload.agent
      const binding = currentBinding(agent)
      if (registryBinding.classifyRegistryState(binding).state === 'legacy' && binding?.bindingAuthority !== 'legacy-rollback') return null
      const session = agent.session
      if (!session.header) throw refusal('missing-session-header', 'engine-binding-violation')
      if (shellEnvironment.presetFor(session) !== 'aih-deepseek') throw refusal('session-preset-mismatch', 'engine-binding-violation')
      const target = dualTarget.controllerTargetFor(profiles.installRootOf(), binding)
      if (!allowed(target.provider, target.model)) throw refusal('controller-target-is-not-deepseek', 'deepseek-provider-not-allowed')
      return { ...target, binding }
    },
    finalize(proposed, target) {
      return { ...proposed, provider: target.provider, model: target.model, reasoningEffort: target.reasoning }
    },
    fail(reason) { return refusal(reason, 'nexus-execution-target-unavailable') },
  })

  ctx.on('agent/request', async (_payload, next) => {
    // The outer shared boundary owns every marked request. Never overwrite
    // its approved immutable route with the historical legacy default.
    const binding = currentBinding(_payload.agent)
    if (registryBinding.classifyRegistryState(binding).state !== 'legacy' || binding?.bindingAuthority === 'legacy-rollback') return next()
    const proposed = await next()
    const header = _payload.agent.session.header
    const isWorker = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    if (isWorker && allowed(proposed.provider, proposed.model)) return proposed
    return Object.freeze({
      ...proposed,
      provider: 'flash-max-direct',
      model: 'deepseek-v4-flash',
      reasoningEffort: topLevelReasoning(proposed),
    })
  })

  ctx.on('agent/request-error', async (payload, _next) => {
    if (!ALLOWED.has(payload.provider)) {
      throw new Error(`DeepSeek-only blocked recovery from provider: ${payload.provider}`)
    }
    return undefined
  })
}

module.exports = { name: 'aih-deepseek-isolation', inject: ['shellEnv'], apply }
