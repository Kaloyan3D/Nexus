'use strict'

/** Final controller-to-transport provider/model assertion for conversation requests. */
const fs = require('node:fs')
const path = require('node:path')
const profiles = require('../config/Engineering-Profiles.cjs')
const muse = require('../config/Muse-Isolation.cjs')
const engineering = require('../config/Engineering-Isolation.cjs')

function bindingFor(installRoot, sessionId) {
  let document
  try {
    document = JSON.parse(fs.readFileSync(path.join(installRoot, 'data', 'routing', 'session-bindings.json'), 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (!document || document.schemaVersion !== 1 || !document.bindings || typeof document.bindings !== 'object') {
    throw new Error('Nexus routing integrity violation: session bindings are invalid; inference aborted before transport.')
  }
  return document.bindings[sessionId] || null
}

function routingTarget(value) {
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  return { provider: value.provider, model: value.model }
}

function assertRoutingIntegrity(binding, expected, request) {
  const controller = routingTarget(expected)
  const final = routingTarget(request)
  if (controller && final && controller.provider === final.provider && controller.model === final.model) return
  const task = binding && binding.taskId ? binding.taskId : 'unknown'
  const engine = binding && binding.engine ? binding.engine : 'unknown'
  const error = new Error(
    `Nexus routing integrity violation. Task: ${task}; Engine: ${engine}. ` +
    `Controller target: ${controller ? controller.provider + ' / ' + controller.model : 'unavailable'}. ` +
    `Final request: ${final ? final.provider + ' / ' + final.model : 'unavailable'}. ` +
    'Inference aborted before transport.',
  )
  error.code = 'nexus-routing-integrity-violation'
  throw error
}

function expectedTargetFor(installRoot, binding) {
  if (binding.engine === 'muse') return muse.controllerTargetFor(installRoot, binding)
  if (binding.engine === 'dual') return engineering.controllerTargetFor(installRoot, binding)
  assertRoutingIntegrity(binding, null, null)
}

function apply(ctx) {
  ctx.on('llm/stream', (request, next) => {
    // These auxiliary calls do not execute a controller-bound task step.
    if (request.purpose === 'compaction' || request.purpose === 'session-title') return next()
    if (typeof request.sessionId !== 'string' || request.sessionId === '') return next()
    const installRoot = profiles.installRootOf()
    const binding = bindingFor(installRoot, request.sessionId)
    if (!binding) {
      const session = ctx.sessions && typeof ctx.sessions.get === 'function' ? ctx.sessions.get(request.sessionId) : null
      const preset = session && session.header && session.header.agentPreset
      if (preset === 'aih-muse' || preset === 'aih-engineering' || preset === 'aih-deepseek') {
        assertRoutingIntegrity({ engine: preset, taskId: 'unbound' }, null, request)
      }
      return next()
    }
    assertRoutingIntegrity(binding, expectedTargetFor(installRoot, binding), request)
    // The LLM adapter starts only when the returned stream is iterated. Inspect
    // again after downstream middleware has prepared that stream, before any
    // chunk can be requested from the adapter.
    const stream = next()
    assertRoutingIntegrity(binding, expectedTargetFor(installRoot, binding), request)
    return stream
  }, { global: true, prepend: true })
}

module.exports = { name: 'nexus-routing-integrity', apply, bindingFor, routingTarget, assertRoutingIntegrity, expectedTargetFor }
