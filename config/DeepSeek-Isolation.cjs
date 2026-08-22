'use strict'

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

function sessionPreset(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.header.agentPreset
}

function apply(ctx) {
  ctx.shellEnv.register({
    name: 'aih-deepseek-preset',
    variables: { DSH_AIH_PRESET: { description: 'Active AI Harness engineering preset.' } },
    resolve: (execution) => execution.agent === undefined || sessionPreset(execution.agent.session) !== 'aih-deepseek'
      ? {}
      : { DSH_AIH_PRESET: 'aih-deepseek' },
  })

  ctx.on('agent/request', async (_payload, next) => {
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
