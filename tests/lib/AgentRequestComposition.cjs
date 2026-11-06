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
  const environment = []
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
    shellEnv: {
      list() { return environment.flatMap(c => Object.keys(c.variables).map(key => ({ key, contributor: c.name }))) },
      register(c) { environment.push(c) },
    },
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

/**
 * DSH 0.2.x model selection double. `agent.model.current()` is the durable
 * `model/selection` projection (pending ?? lastUsed ?? live AgentOptions);
 * `select()` records a `model/selection` event unless it equals the recorded
 * selection. The loop reads `current()` ONCE per step, after the inbox claim
 * and before `agent/pre-step`, and `agent/request` may not change it.
 */
function attachModel(agent, options) {
  if (agent.model) return
  const state = { recorded: null, options, events: [] }
  const same = (a, b) => a === b || (a && b && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort)
  agent.modelSelectionEvents = state.events
  agent.model = {
    current() {
      return state.recorded ? { ...state.recorded } : { ...state.options }
    },
    select(selection) {
      const next = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
      if (same(state.recorded ?? state.options, next)) return
      state.recorded = next
      state.events.push(next)
    },
  }
}

/** Dispatch an `emit`-mode event (agent-scoped listeners see only their agent). */
function emit(ctx, name, payload, agent) {
  for (const entry of (ctx.hooks.get(name) || []).filter((e) => e.agent === undefined || e.agent === agent)) {
    try { entry.listener(payload) } catch { /* contained, as in DSH emit dispatch */ }
  }
}

/**
 * Run one agent step the way DSH 0.2.x does: claim (emits agent/inbox/claimed),
 * capture the step selection, pre-step waterfall, then the request waterfall
 * whose result must equal the captured selection (upstream invariant).
 * `options.claim === false` skips the claim emit (a later step of an open turn).
 */
async function runAgentStep(ctx, payload, seed, options) {
  if (!payload.agent) payload.agent = {}
  const agent = payload.agent
  if (!agent.ctx) agent.ctx = ctx.scopeFor(agent)
  // Live AgentOptions: `agent.options` when the test supplies them, else the seed's route.
  // A seed with side effects (downstream-ran probes) is only invoked innermost.
  const initial = agent.options ? { ...agent.options } : await seed()
  attachModel(agent, { provider: initial.provider, model: initial.model, ...(initial.reasoningEffort === undefined ? {} : { reasoningEffort: initial.reasoningEffort }) })
  if (!options || options.claim !== false) emit(ctx, 'agent/inbox/claimed', { agent, message: {}, turn: 1 }, agent)
  const selection = agent.model.current()
  const stepPayload = { agent, messages: [], signal: new AbortController().signal, turn: 1, step: 1, modelSelection: selection }
  await waterfall(ctx, 'agent/pre-step', stepPayload, async () => ({ kind: 'enter', messages: [] }), agent)
  const proposed = await waterfall(ctx, 'agent/request', payload, async () => {
    const controls = { ...(await seed()) }
    delete controls.provider; delete controls.model; delete controls.reasoningEffort
    return { ...controls, ...selection }
  }, agent)
  if (proposed.provider !== selection.provider || proposed.model !== selection.model) {
    throw new Error('agent/request proposed "' + proposed.provider + '/' + proposed.model + '" after step preparation fixed "' + selection.provider + '/' + selection.model + '"; use agent.model.select() before step preparation')
  }
  if (proposed.reasoningEffort !== selection.reasoningEffort) {
    throw new Error('agent/request proposed reasoning effort "' + (proposed.reasoningEffort ?? 'adapter default') + '" after step preparation fixed "' + (selection.reasoningEffort ?? 'adapter default') + '"; use agent.model.select() before step preparation')
  }
  return proposed
}

module.exports = {
  createPresetCtx,
  attachModel,
  emit,
  waterfall,
  runAgentStep,
}
