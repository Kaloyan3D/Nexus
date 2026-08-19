'use strict'

const ALLOWED = new Map([
  ['deepseek-pro-direct', new Set(['deepseek-v4-pro'])],
  ['flash-max-direct', new Set(['deepseek-v4-flash'])],
  ['flash-high-direct', new Set(['deepseek-v4-flash'])],
])

function allowed(provider, model) {
  return ALLOWED.get(provider)?.has(model) === true
}

function apply(ctx) {
  ctx.shellEnv.register({
    name: 'aih-deepseek-preset',
    variables: { DSH_AIH_PRESET: { description: 'Active AI Harness engineering preset.' } },
    resolve: (execution) => execution.agent === undefined ? {} : { DSH_AIH_PRESET: 'aih-deepseek' },
  })

  ctx.on('agent/request', async (_payload, next) => {
    const proposed = await next()
    const header = _payload.agent.session.header
    const isWorker = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    if (isWorker && allowed(proposed.provider, proposed.model)) return proposed
    return Object.freeze({
      ...proposed,
      provider: 'deepseek-pro-direct',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
  })

  ctx.on('agent/request-error', async (payload, _next) => {
    if (!ALLOWED.has(payload.provider)) {
      throw new Error(`DeepSeek-only blocked recovery from provider: ${payload.provider}`)
    }
    return undefined
  })

  ctx.on('llm/stream', async function* (options, next) {
    if (!allowed(options.provider, options.model)) {
      throw new Error(`DeepSeek-only blocked model route: ${options.provider}/${options.model}`)
    }
    yield* next()
  })
}

module.exports = { name: 'aih-deepseek-isolation', inject: ['shellEnv'], apply }
