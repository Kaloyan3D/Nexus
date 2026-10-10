'use strict'

/**
 * Registry R3 — host adapter for the Nexus-owned Registry service.
 *
 * Transport glue ONLY: bounded JSON bodies, same-origin checks, method
 * gating, status-code mapping and response envelopes. Canonical logic lives
 * in config/registry/service.cjs (host-independent, no DSH imports); this
 * module runs inside the installed host (like the existing engineering
 * profile routes) and owns NO Registry semantics of its own.
 *
 * R3 endpoint contract (exact-match paths on the host webServer registry):
 *
 *   GET  /nexus/registry/v1/modes
 *   GET  /nexus/registry/v1/configuration?mode=<modeId>[&adopt=<profileId>]
 *   GET  /nexus/registry/v1/eligible?mode=<modeId>&slot=<slotId>
 *   POST /nexus/registry/v1/validate            { config }
 *   POST /nexus/registry/v1/preview             { config }
 *   PUT  /nexus/registry/v1/configuration       { modeId, config,
 *                                                  expectedRevision?,
 *                                                  source?, adoptedFrom? }
 *
 * Write boundary (R3.4): mutations reuse the exact trust boundary of the
 * existing engineering-profile-action route (loopback host webServer serving
 * the local GUI; no new network surface), plus per-request hardening that
 * the legacy route lacks: 64 KiB body cap (413), strict schema validation
 * (422), optimistic-concurrency revisions (409 on stale), and a
 * same-origin-when-present check (403). Responses are secret-free by
 * construction (service layer asserts it); error details carry stable codes
 * and non-secret ids only.
 *
 * Session pinning (R3.6): no handler reads or writes session bindings,
 * presets, settings.yaml, or routing ledgers. Saves stage preferences for
 * future activation; the running session is never touched.
 */

const MAX_BODY_BYTES = 65536
const ALLOWED_BODY_METHODS = ['POST', 'PUT']

function respond(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function methodNotAllowed(res) {
  respond(res, 405, { ok: false, error: 'method-not-allowed' })
}

function hostOf(value) {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed = new URL(value, 'http://x')
    // Absolute URL with a foreign scheme/host -> its hostname; a bare path
    // (Referer sent as origin+path is absolute in practice) falls through.
    if (parsed.host && parsed.host !== 'x') return parsed.hostname.toLowerCase()
    return null
  } catch {
    return null
  }
}

/**
 * Same-origin check for browser callers. Non-browser callers (no Origin /
 * Referer headers, e.g. the existing UI fetch paths) are allowed through —
 * the check only constrains callers that DECLARE a foreign origin, which a
 * cross-site form/fetch always does. Loopback and same-host origins pass.
 */
function checkSameOrigin(req) {
  const headers = (req && req.headers) || {}
  const declared = typeof headers.origin === 'string' && headers.origin !== ''
    ? headers.origin
    : (typeof headers.referer === 'string' ? headers.referer : (typeof headers.referrer === 'string' ? headers.referrer : ''))
  if (!declared) return null
  const originHost = hostOf(declared)
  if (!originHost) return null
  const loopback = originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1' || originHost === '[::1]'
  if (loopback) return null
  const hostHeader = typeof headers.host === 'string' ? headers.host.split(':')[0].toLowerCase() : null
  if (hostHeader && originHost === hostHeader) return null
  return 'origin-forbidden'
}

/**
 * Bounded JSON body reader. Resolves { body } or { error } with error in
 * { 'payload-too-large', 'invalid-json-body' }. Never throws; destroys an
 * over-limit stream so a hostile sender cannot hold the socket.
 */
function readBoundedJson(req, limit) {
  const cap = typeof limit === 'number' ? limit : MAX_BODY_BYTES
  return new Promise((resolve) => {
    let bytes = 0
    let text = ''
    let settled = false
    const done = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk) => {
      if (settled) return
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8')
      bytes += size
      if (bytes > cap) {
        try { req.destroy() } catch { /* best effort */ }
        done({ error: 'payload-too-large' })
        return
      }
      text += chunk
    })
    req.on('end', () => {
      if (settled) return
      if (text.trim() === '') {
        done({ error: 'invalid-json-body' })
        return
      }
      try {
        done({ body: JSON.parse(text) })
      } catch {
        done({ error: 'invalid-json-body' })
      }
    })
    req.on('error', () => done({ error: 'invalid-json-body' }))
  })
}

function errorStatusOf(errors) {
  const codes = (errors || []).map((e) => (e && e.code) || '')
  if (codes.indexOf('stale-revision') !== -1) return 409
  if (codes.indexOf('snapshot-unavailable') !== -1) return 503
  if (codes.indexOf('registry-store-corrupt') !== -1 || codes.indexOf('registry-store-unreadable') !== -1 || codes.indexOf('registry-store-unwritable') !== -1) return 500
  return 422
}

function createRegistryHandlers(service) {
  if (!service) throw new Error('registry-adapter: service is required')

  const modesHandler = async (req, res) => {
    if (req.method !== 'GET') {
      methodNotAllowed(res)
      return
    }
    const originError = checkSameOrigin(req)
    if (originError) {
      respond(res, 403, { ok: false, error: originError })
      return
    }
    try {
      const result = service.listModes()
      respond(res, 200, { ok: true, schemaVersion: 1, generatedAtUtc: new Date().toISOString(), modes: result.modes, errors: result.errors })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-modes-failed' })
    }
  }

  const configurationHandler = async (req, res) => {
    const originError = checkSameOrigin(req)
    if (originError) {
      respond(res, 403, { ok: false, error: originError })
      return
    }
    if (req.method === 'GET') {
      try {
        const url = new URL(req.url || '/', 'http://x')
        const modeId = (url.searchParams.get('mode') || '').trim()
        const adopt = (url.searchParams.get('adopt') || '').trim() || null
        if (modeId === '') {
          respond(res, 400, { ok: false, error: 'missing-mode' })
          return
        }
        const { result, errors } = service.getModeConfiguration(modeId, { adopt })
        if (!result) {
          respond(res, errorStatusOf(errors), { ok: false, error: (errors[0] && errors[0].code) || 'registry-configuration-unavailable', details: errors })
          return
        }
        respond(res, 200, { ok: true, schemaVersion: 1, generatedAtUtc: new Date().toISOString(), result })
      } catch {
        respond(res, 500, { ok: false, error: 'registry-configuration-failed' })
      }
      return
    }
    if (req.method === 'PUT') {
      const read = await readBoundedJson(req, MAX_BODY_BYTES)
      if (read.error) {
        respond(res, read.error === 'payload-too-large' ? 413 : 400, { ok: false, error: read.error })
        return
      }
      const payload = read.body
      const modeId = payload && typeof payload.modeId === 'string' ? payload.modeId.trim() : ''
      const config = payload ? payload.config : null
      const hasExpected = payload && Object.prototype.hasOwnProperty.call(payload, 'expectedRevision')
      const expectedRevision = hasExpected ? payload.expectedRevision : null
      const source = payload && typeof payload.source === 'string' ? payload.source : 'operator-save'
      const adoptedFrom = payload && Object.prototype.hasOwnProperty.call(payload, 'adoptedFrom') ? payload.adoptedFrom : null
      if (modeId === '' || !config) {
        respond(res, 400, { ok: false, error: 'invalid-configuration-payload' })
        return
      }
      try {
        const saved = service.save(modeId, config, hasExpected ? expectedRevision : null, { source, adoptedFrom })
        if (!saved.ok) {
          respond(res, errorStatusOf(saved.errors), { ok: false, error: (saved.errors[0] && saved.errors[0].code) || 'registry-save-rejected', details: saved.errors })
          return
        }
        respond(res, 200, { ok: true, modeId, revision: saved.revision, resolutionId: saved.resolutionId })
      } catch {
        respond(res, 500, { ok: false, error: 'registry-save-failed' })
      }
      return
    }
    methodNotAllowed(res)
  }

  const eligibleHandler = async (req, res) => {
    if (req.method !== 'GET') {
      methodNotAllowed(res)
      return
    }
    const originError = checkSameOrigin(req)
    if (originError) {
      respond(res, 403, { ok: false, error: originError })
      return
    }
    try {
      const url = new URL(req.url || '/', 'http://x')
      const modeId = (url.searchParams.get('mode') || '').trim()
      const slotId = (url.searchParams.get('slot') || '').trim()
      if (modeId === '' || slotId === '') {
        respond(res, 400, { ok: false, error: 'missing-mode-or-slot' })
        return
      }
      const eligible = service.listEligible(modeId, slotId)
      if (eligible.errors.length > 0) {
        respond(res, errorStatusOf(eligible.errors), { ok: false, error: (eligible.errors[0] && eligible.errors[0].code) || 'registry-eligible-unavailable', details: eligible.errors })
        return
      }
      const ineligible = service.listIneligible(modeId, slotId)
      respond(res, 200, { ok: true, schemaVersion: 1, generatedAtUtc: new Date().toISOString(), modeId, slotId, eligible: eligible.routes, ineligible: ineligible.routes })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-eligible-failed' })
    }
  }

  const bodyConfigHandler = (operation) => async (req, res) => {
    if (req.method !== 'POST') {
      methodNotAllowed(res)
      return
    }
    const originError = checkSameOrigin(req)
    if (originError) {
      respond(res, 403, { ok: false, error: originError })
      return
    }
    const read = await readBoundedJson(req, MAX_BODY_BYTES)
    if (read.error) {
      respond(res, read.error === 'payload-too-large' ? 413 : 400, { ok: false, error: read.error })
      return
    }
    const config = read.body ? read.body.config : null
    if (!config) {
      respond(res, 400, { ok: false, error: 'invalid-configuration-payload' })
      return
    }
    try {
      if (operation === 'validate') {
        const { errors } = service.validate(config)
        respond(res, errors.length > 0 ? 422 : 200, errors.length > 0
          ? { ok: false, error: 'validation-failed', details: errors }
          : { ok: true, valid: true })
        return
      }
      const compiled = service.compilePreview(config)
      if (!compiled.ok) {
        respond(res, errorStatusOf(compiled.errors), { ok: false, error: (compiled.errors[0] && compiled.errors[0].code) || 'registry-preview-rejected', details: compiled.errors })
        return
      }
      respond(res, 200, { ok: true, snapshot: compiled.snapshot })
    } catch {
      respond(res, 500, { ok: false, error: operation === 'validate' ? 'registry-validate-failed' : 'registry-preview-failed' })
    }
  }

  return {
    modesHandler,
    configurationHandler,
    eligibleHandler,
    validateHandler: bodyConfigHandler('validate'),
    previewHandler: bodyConfigHandler('preview'),
  }
}

module.exports = {
  MAX_BODY_BYTES,
  checkSameOrigin,
  readBoundedJson,
  errorStatusOf,
  createRegistryHandlers,
}
