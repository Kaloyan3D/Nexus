'use strict'

function apply(ctx) {
  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    const header = payload.agent.session.header
    const isWorker = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    if (isWorker) return proposed
    return Object.freeze({
      ...proposed,
      provider: 'flash-max-direct',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
  })
}

module.exports = { name: 'aih-engineering-isolation', apply }
