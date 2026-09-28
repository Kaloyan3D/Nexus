'use strict'

/**
 * Test double for how DSH composes preset rows around one agent.
 *
 * Mirrors the installed cordis EventsService: listeners are kept per event in
 * REGISTRATION order and a waterfall runs them outermost-first, the seed being
 * the innermost `next`. `payload.agent.ctx` is an agent-scoped view of the
 * same registry: what it registers fires only for that agent (the cordis
 * scope filter) and lands after every preset row already registered, exactly
 * like a registration made after DSH agent setup.
 *
 * `ctx.handlers[name]` keeps the old single-handler test surface: for
 * `agent/request` it runs one full agent step (pre-step, then the composed
 * request waterfall); for every other event it is the last listener
 * registered, as before.
 */

function createPresetCtx(extra) {
  const hooks = new Map()
  function register(name, listener, agent) {
    const entries = hooks.get(name) || []
    const entry = { listener, agent }
    entries.push(entry)
    hooks.set(name, entries)
    return () => {
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
    }
  }
  const ctx = {
    hooks,
    shellEnv: { register() {} },
    ...(extra || {}),
    on(name, listener) {
      return register(name, listener, undefined)
    },
  }
  ctx.scopeFor = (agent) => ({ on: (name, listener) => register(name, listener, agent) })
  ctx.handlers = new Proxy({}, {
    get(_target, name) {
      const entries = hooks.get(name)
      if (!entries || entries.length === 0) return undefined
      if (name === 'agent/request') return (payload, seed) => runAgentStep(ctx, payload, seed)
      return entries[entries.length - 1].listener
    },
  })
  return ctx
}

/** Compose one waterfall for `agent`; the last element of `args` is replaced by the chain's `next`. */
function waterfall(ctx, name, payload, inner, agent) {
  const listeners = (ctx.hooks.get(name) || [])
    .filter((entry) => entry.agent === undefined || entry.agent === agent)
    .map((entry) => entry.listener)
  const next = () => (listeners.shift() || (() => inner()))(payload, next)
  return next()
}

/** Attach the agent scope, run pre-step, then the composed `agent/request` waterfall. */
async function runAgentStep(ctx, payload, seed) {
  if (!payload.agent) payload.agent = {}
  const agent = payload.agent
  if (!agent.ctx) agent.ctx = ctx.scopeFor(agent)
  const stepPayload = { agent, turn: 1, step: 1 }
  await waterfall(ctx, 'agent/pre-step', stepPayload, async () => ({ kind: 'enter', messages: [] }), agent)
  return waterfall(ctx, 'agent/request', payload, seed, agent)
}

module.exports = {
  createPresetCtx,
  waterfall,
  runAgentStep,
}
