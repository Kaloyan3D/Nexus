'use strict'

/**
 * Controller-RequestBoundary.cjs — the one composition pattern the preset
 * isolation plugins (Muse-Isolation.cjs, Engineering-Isolation.cjs) use to
 * apply a controller-produced provider/model route to DSH `agent/request`.
 *
 * WHY A PATTERN IS NEEDED (waterfall ordering, proven against the installed
 * cordis + dsh-agent + dsh-agent-presets + dsh-host-apiproxy):
 *   - `agent/request` is a cordis waterfall. Listeners run outermost-first in
 *     REGISTRATION order; the seed request (AgentOptions provider/model, i.e.
 *     the host default route) is the innermost `next`.
 *   - DSH model-selection (installModelSelection) is registered on each
 *     agent's own scope during agent setup. It protects
 *     `payload.routingAuthority` and requires the route returned by ITS
 *     `next()` to equal the declared authority target.
 *   - Preset rows are mounted once per preset as a STANDING composition that
 *     every later session of that preset joins. A listener a preset row
 *     registers is therefore inside model-selection only for agents whose
 *     setup ran before the standing mount existed (the first session of the
 *     preset in the process). For every later session it sits OUTSIDE
 *     model-selection, so a route rewritten after `next()` arrives too late:
 *     model-selection has already compared the default seed route with the
 *     controller authority and thrown.
 *
 * THE PATTERN:
 *   arm     (preset row, `agent/pre-step`): pre-step runs every step before
 *           the request is built and after any preset mount or recompose, so
 *           an agent-scoped listener registered here is always INSIDE
 *           model-selection. Registered once per agent on the agent's own
 *           scope, exactly where DSH registers model-selection, and disposed
 *           with the agent.
 *   guard   (preset row, `agent/request`): resolves the controller target
 *           once per request and hands it to the agent's rewrite through a
 *           per-request ticket. Fails closed when the rewrite is not composed,
 *           did not run, or the final route/authority is not the target.
 *   rewrite (agent scope, `agent/request`): declares the controller
 *           routingAuthority under model-selection's protection, then applies
 *           the target to the proposed request, so the route model-selection
 *           validates already equals the declared authority.
 *
 * The guard is always outside the rewrite: the standing mount exists before
 * any pre-step of an agent composed from it. The DSH guard is not weakened:
 * DSH still validates the declared controller authority against the
 * effective route, and still ranks and rejects every other route claim.
 */

const AUTHORITY_SOURCE = 'controller'

function sameRoute(value, target) {
  return Boolean(value) && value.provider === target.provider && value.model === target.model
}

/**
 * Install the arm/guard/rewrite triple for one controller plane.
 *
 * @param ctx - the preset row's plugin context.
 * @param boundary - the plane's request semantics:
 *   targetFor(payload)  -> null (not this plane's request: pass through) or
 *                          the controller target ({ provider, model, ... });
 *                          throws to fail closed. Must be side-effect free.
 *   prepare(payload, target) -> optional per-request value, computed once,
 *                          after the rewrite is known to be composed and
 *                          before anything downstream runs.
 *   finalize(proposed, target, prepared) -> the request to return; must keep
 *                          every proposed field it does not own.
 *   fail(reason, target) -> the plane's fail-closed Error.
 */
function installControllerRequestBoundary(ctx, boundary) {
  const composed = new WeakSet()
  const tickets = new WeakMap()

  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload && payload.agent
    if (agent && agent.ctx && !composed.has(agent)) {
      agent.ctx.on('agent/request', async (request, inner) => {
        const ticket = tickets.get(request)
        if (ticket === undefined) return inner()
        request.routingAuthority = {
          source: AUTHORITY_SOURCE,
          target: { provider: ticket.target.provider, model: ticket.target.model },
        }
        const proposed = await inner()
        ticket.applied = true
        return Object.freeze(boundary.finalize(proposed, ticket.target, ticket.prepared))
      })
      composed.add(agent)
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const target = boundary.targetFor(payload)
    if (target === null) return next()
    if (!composed.has(payload.agent)) throw boundary.fail('controller-route-rewrite-not-composed', target)
    const prepared = boundary.prepare ? boundary.prepare(payload, target) : undefined
    const ticket = { target, prepared, applied: false }
    tickets.set(payload, ticket)
    let resolved
    try {
      resolved = await next()
    } finally {
      tickets.delete(payload)
    }
    if (!ticket.applied) throw boundary.fail('controller-route-rewrite-did-not-run', target)
    const authority = payload.routingAuthority
    if (!authority || authority.source !== AUTHORITY_SOURCE || !sameRoute(authority.target, target)) {
      throw boundary.fail('declared-authority-is-not-controller-target', target)
    }
    if (!sameRoute(resolved, target)) throw boundary.fail('effective-route-differs-from-controller-target', target)
    return resolved
  })
}

module.exports = {
  installControllerRequestBoundary,
}
