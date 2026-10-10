'use strict'

/**
 * Registry R4.5 — runtime-neutral provider adapters.
 *
 * Provider metadata and discovery stay independent of DSH. This module maps
 * a canonical provider transportId onto the wire requirements the future
 * runtime projection must satisfy, reusing the EXISTING supported transport
 * substrate through the narrow DSH compatibility adapter (dsh-adapter.cjs).
 * It creates no production router and rewrites no execution loop.
 *
 * Supported R4 dialects (real substrate exists):
 *   openai-responses, openai-chat-completions, local-openai-compatible
 * Unknown / unsupported dialects (anthropic-messages, agent-sdk as a raw
 * transport, unknown, anything else) fail closed — never guessed.
 *
 * Provider-specific requirements preserved per dialect: session/continuation
 * headers stay adapter/runtime-owned (never in Registry snapshots),
 * reasoning field mapping, and tool-continuation semantics.
 */

const dshAdapter = require('./dsh-adapter.cjs')
const providerConfig = require('./provider-config.cjs')

const DIALECTS = Object.freeze({
  'openai-responses': Object.freeze({
    transportId: 'openai-responses',
    textPath: '/responses',
    modelsPath: '/models',
    reasoningField: 'reasoning.effort',
    streaming: 'sse-event-stream',
    toolSemantics: 'function-tool + function_call_output continuation',
    // Provider-specific continuity (e.g. OpenCode session headers,
    // provider request ids) is owned by the runtime adapter at execution
    // time and never enters Registry snapshots.
    continuity: 'runtime-owned (headers/request ids via DSH adapter projection)',
    dshSubstrate: 'existing-supported',
  }),
  'openai-chat-completions': Object.freeze({
    transportId: 'openai-chat-completions',
    textPath: '/chat/completions',
    modelsPath: '/models',
    reasoningField: 'reasoning_effort',
    streaming: 'sse-event-stream',
    toolSemantics: 'tool_calls + tool-role continuation',
    continuity: 'runtime-owned (no Registry snapshot state)',
    dshSubstrate: 'existing-supported',
  }),
  'local-openai-compatible': Object.freeze({
    transportId: 'local-openai-compatible',
    textPath: '/chat/completions',
    modelsPath: '/models',
    reasoningField: 'reasoning_effort',
    streaming: 'sse-event-stream',
    toolSemantics: 'tool_calls + tool-role continuation (server-dependent; verified per route)',
    continuity: 'runtime-owned (loopback; no Registry snapshot state)',
    dshSubstrate: 'existing-supported-via-local-policy',
  }),
})

function err(code, p, message) {
  return { code, path: p, message }
}

function isSupportedDialect(transportId) {
  return !!DIALECTS[transportId]
}

function describeDialect(transportId) {
  const dialect = DIALECTS[transportId]
  if (!dialect) {
    return { ok: false, errors: [err('unsupported-protocol', 'provider.transportId', 'no supported R4 adapter for protocol ' + String(transportId) + ' (supported: ' + providerConfig.SUPPORTED_R4_TRANSPORTS.join(', ') + '); failing closed')] }
  }
  return { ok: true, dialect }
}

/**
 * Prepare a future runtime projection for a verified route WITHOUT routing
 * or executing: intersect the route's transport with the named runtime
 * adapter's declared protocols. Returns { ok, projection } or fail-closed
 * errors. The projection carries opaque Nexus identity references only —
 * no credentials, no session objects, no DSH YAML.
 */
function prepareProjection(route, provider, runtime) {
  if (!route || typeof route !== 'object') return { ok: false, errors: [err('projection-invalid', 'route', 'route is required')] }
  if (!provider || typeof provider !== 'object') return { ok: false, errors: [err('projection-invalid', 'provider', 'provider is required')] }
  const described = describeDialect(provider.transportId)
  if (!described.ok) return described
  const transport = (route.compatibility && route.compatibility.transport) || provider.transportId
  if (transport !== provider.transportId && transport !== 'unknown') {
    return { ok: false, errors: [err('projection-mismatch', 'route.compatibility.transport', 'route transport ' + transport + ' disagrees with provider dialect ' + provider.transportId)] }
  }
  if (runtime && Array.isArray(runtime.protocols) && runtime.protocols.indexOf(provider.transportId) === -1) {
    return { ok: false, errors: [err('runtime-capability-unsatisfied', 'runtime', 'runtime ' + (runtime.adapterId || 'unknown') + ' does not implement dialect ' + provider.transportId)] }
  }
  // Narrow DSH compatibility: only known canonical providers project today.
  // Unknown (operator-added) provider ids intentionally yield a projected
  // status of 'pending-dsh-mapping' — the canonical record stays clean and
  // production DSH routing is untouched until R6.
  const dshKey = dshAdapter.dshProviderKeyOf(provider.id)
  return {
    ok: true,
    projection: {
      schemaVersion: 1,
      routeId: route.id,
      providerId: provider.id,
      logicalModelId: route.logicalModelId,
      remoteModelId: route.remoteModelId,
      transportId: provider.transportId,
      executionKind: route.executionKind,
      reasoningLevels: (route.reasoningLevels || []).slice(),
      dshMapping: dshKey ? { status: 'mapped', dshProviderKey: dshKey } : { status: 'pending-dsh-mapping', note: 'operator provider projects at R6 activation; canonical data carries no DSH identifiers' },
      continuity: described.dialect.continuity,
    },
  }
}

module.exports = {
  DIALECTS,
  isSupportedDialect,
  describeDialect,
  prepareProjection,
}
