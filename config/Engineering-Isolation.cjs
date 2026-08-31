'use strict'

/**
 * Engineering-Isolation.cjs — profile-driven root-engineer enforcement.
 *
 * Phase 2: the ACTIVE ENGINEERING PROFILE decides WHICH model fulfills an
 * engineering role, so this enforcement layer no longer hardcodes a vendor.
 * For every top-level (non-worker) agent request it resolves:
 *
 *   session binding -> live execution class (routing state) -> role
 *   -> active engineering profile -> model registry -> provider/model
 *
 * and pins the request to that target (model identity comes from
 * configuration; this plugin is the enforcement adapter, not the selector).
 *
 * Fail-closed: if the profile/registry layer cannot be read, the request is
 * pinned to the historical DeepSeek V4 Flash MAX root so an operator who
 * switches profiles cannot silently land on an arbitrary model.
 *
 * Worker (subagent) sessions are untouched: their models are configured by
 * the delegation rows, exactly as before Phase 2.
 */

const fs = require('node:fs')
const path = require('node:path')
const profiles = require('./Engineering-Profiles.cjs')

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
    /* no binding yet: enforcement falls back to the profile's primary role */
  }
  return null
}

function apply(ctx) {
  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    const session = payload && payload.agent && payload.agent.session
    const header = session && session.header
    if (!header) return proposed
    const isWorker = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    if (isWorker) return proposed

    const installRoot = profiles.installRootOf()
    const binding = bindingFor(installRoot, session.id)
    const preset = (binding && binding.preset) || header.agentPreset || 'aih-engineering'
    const activeProfile = profiles.resolveActiveProfile(installRoot, preset)
    if (!activeProfile) {
      return Object.freeze({ ...proposed, provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
    }
    // TASK-0005 Part 17: for tasks with an immutable taskInstanceId the live
    // execution-class lookup goes through the GENERATION-AWARE routing state
    // (workspace + preset + taskInstanceId key, resolved inside
    // profiles.routingStatePath). Stale state from another lifecycle
    // generation of the same display taskId can therefore no longer flip
    // engineer roles onto a wrong model (e.g. engineer_deep -> the reviewer
    // model under GLM + Codex).
    const executionClass = profiles.liveExecutionClassOf(installRoot, binding)
    const role = profiles.roleOfExecutionClass(executionClass) || 'primaryEngineer'
    const target = profiles.resolveTarget(installRoot, activeProfile.id, role)
    if (!target) {
      return Object.freeze({ ...proposed, provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
    }
    return Object.freeze({
      ...proposed,
      provider: target.provider,
      model: target.model,
      reasoningEffort: target.reasoning || 'off',
    })
  })
}

module.exports = { name: 'aih-engineering-isolation', apply }
