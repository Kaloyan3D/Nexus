'use strict'

/**
 * Nexus-MessageSource.cjs — the one place Nexus shapes and recognizes the
 * message sources it writes into DSH session logs (P2-B2C).
 *
 * DSH 0.2 session format v4 (session-format-v3-to-v4/src/message-sources.ts)
 * refuses on every durable read — cold restore, resume, persistence reads — a
 * message whose `source.kind` is missing, empty or the retired catch-all
 * `plugin`: "format v4 message requires a producer-owned source kind". Each
 * producer owns its kind (dsh-llm MessageSourceMap: "there is no shared
 * catch-all `plugin` kind"; consumers fall through unknown kinds).
 *
 * Nexus's producer kind is `aih-controller`. The `plugin` field stays on the
 * source so existing provenance readers (checkpoint lookup, citations, memory
 * detail) keep working; readers accept both the current and the legacy
 * (DSH 0.1 / pre-P2-B2C) shape so older live logs are still interpreted.
 *
 * Format v4 also requires the FIRST surface event of a session to be the
 * protected `system/message` head ("system/message requires a protected first
 * surface head"). `hasProtectedSurfaceHead` tells whether a surface
 * `user/message` may be appended yet.
 */

const CONTROLLER_SOURCE_KIND = 'aih-controller'
const CONTROLLER_PLUGIN = 'aih-controller'
const RETIRED_SOURCE_KIND = 'plugin'
const DSH_SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

/** Source for a Nexus Controller-authored message (notice, checkpoint, continuation). */
function controllerSource(fields = {}) {
  const extra = { ...fields }
  delete extra.kind
  delete extra.plugin
  return { kind: CONTROLLER_SOURCE_KIND, plugin: CONTROLLER_PLUGIN, ...extra }
}

/** True for a Nexus Controller source in the current or the legacy shape. */
function isControllerSource(source) {
  return Boolean(source && typeof source === 'object' && source.plugin === CONTROLLER_PLUGIN &&
    (source.kind === CONTROLLER_SOURCE_KIND || source.kind === RETIRED_SOURCE_KIND))
}

/**
 * True for DSH's runtime-context message: DSH 0.2 `{ kind: 'runtime-context' }`
 * or the DSH 0.1 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`.
 */
function isRuntimeContextSource(source) {
  if (!source || typeof source !== 'object') return false
  if (source.kind === 'runtime-context') return true
  return source.kind === RETIRED_SOURCE_KIND && source.plugin === DSH_SYSTEM_PROMPT_PLUGIN
}

/** Mirror of DSH format v4's source admission: would a durable read refuse it? */
function isRefusedSourceKind(source) {
  return !source || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind === '' || source.kind === RETIRED_SOURCE_KIND
}

/**
 * Whether a surface `user/message` may be appended to this log: the protected
 * `system/message` head exists. A log without any surface event yet has none.
 */
function hasProtectedSurfaceHead(events) {
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'system/message') return true
    if (['user/message', 'developer/message', 'assistant/message', 'tool/result'].includes(event.type) && event.surfaceOp !== undefined) return false
  }
  return false
}

module.exports = {
  CONTROLLER_SOURCE_KIND,
  CONTROLLER_PLUGIN,
  RETIRED_SOURCE_KIND,
  DSH_SYSTEM_PROMPT_PLUGIN,
  controllerSource,
  isControllerSource,
  isRuntimeContextSource,
  isRefusedSourceKind,
  hasProtectedSurfaceHead,
}
