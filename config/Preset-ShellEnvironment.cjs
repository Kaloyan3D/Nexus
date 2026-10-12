'use strict'

// ShellEnv owns keys per host, not per standing preset. Use its public
// declaration inventory as the idempotence authority even when installed
// presets load separate copies of this module. Registration is synchronous.
const OWNER = 'aih-session-preset'
const KEY = 'DSH_AIH_PRESET'
const PRESETS = new Set(['aih-engineering', 'aih-deepseek', 'aih-muse'])

function invalidIdentity() {
  const error = new Error('Nexus shell environment session preset identity is malformed.')
  error.code = 'shell-preset-identity-invalid'
  return error
}

function presetFor(session) {
  if (!session || typeof session !== 'object') throw invalidIdentity()
  if (session.events !== undefined && !Array.isArray(session.events)) throw invalidIdentity()
  const events = session.events || []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event && event.type === 'agent-preset/selected') {
      const selected = event.data && event.data.agentPreset
      if (typeof selected !== 'string' || selected.trim() === '') throw invalidIdentity()
      return PRESETS.has(selected) ? selected : null
    }
  }
  const selected = session.header && session.header.agentPreset
  // Delegated/native DSH sessions may have no Nexus preset. Never inherit a
  // parent identity or choose an engine from process-global defaults.
  if (selected === undefined) return null
  if (typeof selected !== 'string' || selected.trim() === '') throw invalidIdentity()
  return PRESETS.has(selected) ? selected : null
}

function resolve(execution) {
  if (!execution || execution.agent === undefined) return {}
  const preset = presetFor(execution.agent && execution.agent.session)
  return preset === null ? {} : { [KEY]: preset }
}

function ensure(ctx) {
  const root = ctx.root || ctx
  const shellEnv = typeof root.get === 'function' ? root.get('shellEnv') : root.shellEnv
  const declaration = shellEnv.list().find(variable => variable.key === KEY)
  if (declaration) {
    if (declaration.contributor !== OWNER) {
      const error = new Error(`Nexus shell preset key is owned by unexpected contributor ${declaration.contributor}.`)
      error.code = 'shell-preset-owner-conflict'
      throw error
    }
    return
  }
  // Calling the service through the host root binds the SDK's ctx.effect to
  // the host fiber. Individual preset mounts must not own this disposer.
  shellEnv.register({
    name: OWNER,
    variables: { [KEY]: { description: 'Active Nexus agent preset for this shell execution session.' } },
    resolve,
  })
}

module.exports = { ensure, presetFor, resolve }
