'use strict'

/**
 * OpenCode-SessionHeader.cjs — the stable per-conversation `x-opencode-session`
 * header for the OpenCode Go Responses transport (TASK-0006/TASK-0008).
 *
 * The OpenCode Go endpoint answers HTTP 400 MissingSessionID without it
 * (live-proven 2026-09-23: no header -> 400; opaque header -> 200). pi-ai
 * maps the loop's per-request session id to `session_id` /
 * `x-client-request-id` only.
 *
 * DSH 0.1.x needed an in-place edit of the installed provider adapter bundle
 * (scripts/Apply-OpenCodeSessionPatch.cjs). DSH 0.2.x provides the supported
 * `llm-pi-ai/request-headers` waterfall, so this plugin replaces that patch
 * with identical semantics:
 *   - the value is the DSH session id the agent loop already stamps on every
 *     request (opaque; no workspace path, user, key or prompt content);
 *   - stable per conversation (same session -> same header on every turn and
 *     retry) and isolated across conversations;
 *   - scoped to provider id `opencode-go` ONLY, and only when a session id
 *     exists; every other route's headers are byte-for-byte unchanged;
 *   - harness attribution headers are applied AFTER this waterfall by pi-ai
 *     and can never be replaced here, and the header value is never logged.
 */

const HEADER = 'x-opencode-session'
const PROVIDER = 'opencode-go'

/** Apply the header to a request-owned Headers object (exported for tests). */
function applyOpenCodeSessionHeader(request, headers) {
  if (request && request.provider === PROVIDER && request.sessionId !== undefined) {
    headers.set(HEADER, String(request.sessionId))
  }
  return headers
}

function apply(ctx) {
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    applyOpenCodeSessionHeader(request, headers)
    return next()
  })
}

module.exports = {
  name: 'aih-opencode-session-header',
  apply,
  applyOpenCodeSessionHeader,
  HEADER,
  PROVIDER,
}
