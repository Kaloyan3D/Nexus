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
 * R4 endpoint contract (Models & Providers management):
 *
 *   GET  /nexus/registry/v1/catalog
 *   PUT  /nexus/registry/v1/providers           { provider, expectedRevision?, endpointOptions? }
 *   PUT  /nexus/registry/v1/models              { model, expectedRevision? }
 *   PUT  /nexus/registry/v1/routes              { route, expectedRevision? }
 *   PUT  /nexus/registry/v1/connections         { connection, expectedRevision? }
 *   POST /nexus/registry/v1/providers/disable   { id, expectedRevision? }  (same for models/routes/connections)
 *   POST /nexus/registry/v1/providers/delete    { id }                     (same for models/routes/connections)
 *   POST /nexus/registry/v1/connections/status  { id, status, attested? }
 *   POST /nexus/registry/v1/providers/test      { id, connectionId? }
 *   POST /nexus/registry/v1/providers/discover  { id, connectionId? }
 *   POST /nexus/registry/v1/routes/verify       { id }
 *   GET  /nexus/registry/v1/routes/evidence?route=<routeId>
 *   POST /nexus/registry/v1/routes/project      { id, runtime? }
 *
 * R4 secrets rule: no endpoint accepts or returns credential VALUES.
 * Connections carry opaque credential:// references + status only.
 *
 * Write boundary (R3.4, hardened R3.1 H1): mutations reuse the exact trust
 * boundary of the existing engineering-profile-action route (loopback host
 * webServer serving the local GUI; no new network surface), plus
 * per-request hardening that the legacy route lacks: 64 KiB body cap
 * (413), strict schema validation (422), optimistic-concurrency revisions
 * (409 on stale / write-conflict), and a full origin-tuple check (403).
 * The check compares scheme, hostname and effective port of the declared
 * Origin (else Referer) against the Host header and socket scheme — no
 * loopback exemption, no localhost/127.0.0.1 equivalence, opaque and
 * malformed origins fail closed. Absent Origin/Referer still passes for
 * non-browser callers. This is a CSRF boundary, NOT authentication: the
 * host issues no caller credential (verified live), so any local process
 * can call these endpoints exactly like the pre-existing Nexus routes.
 * Responses are secret-free by construction (service layer asserts it);
 * error details carry stable codes and non-secret ids only.
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

function defaultPortForScheme(scheme) {
  if (scheme === 'http') return '80'
  if (scheme === 'https') return '443'
  return null
}

/**
 * Split a Host header into { hostname, port }. Hostname is lowercased;
 * port is the declared string or null when absent. Returns null when the
 * header is missing or malformed. IPv6 literals keep their brackets on
 * both sides of every comparison, matching WHATWG URL parsing.
 */
function splitHostPort(hostHeader) {
  if (typeof hostHeader !== 'string') return null
  const text = hostHeader.trim()
  if (text === '') return null
  let hostname = null
  let port = null
  if (text[0] === '[') {
    const close = text.indexOf(']')
    if (close === -1) return null
    hostname = text.slice(0, close + 1).toLowerCase()
    const rest = text.slice(close + 1)
    if (rest !== '') {
      if (rest[0] !== ':') return null
      port = rest.slice(1)
    }
  } else {
    const idx = text.lastIndexOf(':')
    if (idx !== -1) {
      if (!/^[0-9]+$/.test(text.slice(idx + 1))) return null
      hostname = text.slice(0, idx).toLowerCase()
      port = text.slice(idx + 1)
    } else {
      hostname = text.toLowerCase()
    }
  }
  if (!hostname || /\s/.test(hostname)) return null
  if (port !== null && !/^[0-9]+$/.test(port)) return null
  return { hostname, port }
}

/**
 * Parse one Origin header value into { scheme, hostname, port }. Only
 * origin-shaped http(s) values qualify; anything else (opaque 'null',
 * malformed text, merged duplicates, non-http schemes, paths or userinfo)
 * returns null and the caller fails closed. An empty value is NOT an
 * origin at all — callers treat it as absent.
 */
function parseOriginValue(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  if (text === 'null') return { opaque: true }
  if (text.indexOf(',') !== -1) return null
  let url = null
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null
  const scheme = url.protocol.slice(0, -1)
  const port = url.port !== '' ? url.port : defaultPortForScheme(scheme)
  if (port === null) return null
  return { scheme, hostname: url.hostname.toLowerCase(), port }
}

function parseRefererOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url = null
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const scheme = url.protocol.slice(0, -1)
  const port = url.port !== '' ? url.port : defaultPortForScheme(scheme)
  if (port === null) return null
  return { scheme, hostname: url.hostname.toLowerCase(), port }
}

function sameTuple(a, b) {
  return !!a && !!b && !a.opaque && !b.opaque
    && a.scheme === b.scheme && a.hostname === b.hostname && a.port === b.port
}

/**
 * Full origin-tuple check (R3.1 H1). The declared caller origin (Origin,
 * else Referer) must equal the server tuple (scheme from the socket, host
 * and effective port from the Host header) on ALL three components.
 *
 * Deliberately strict where the R3 check was loose:
 * - every loopback origin is NOT same-origin: a page served from
 *   127.0.0.1:9999 (or localhost:9999) is a different origin from the
 *   127.0.0.1:3080 GUI and is rejected;
 * - 'localhost' and '127.0.0.1' are different hostnames and never equated;
 * - opaque ('null'), malformed, merged-duplicate and non-http origins fail
 *   closed, as do conflicting Origin/Referer pairs and declared origins
 *   without a parseable server Host tuple.
 *
 * Absent Origin AND Referer still passes: non-browser callers (the shipped
 * UI fetch paths, curl, host tooling) declare no origin. This check is a
 * CSRF boundary, NOT authentication: any local process can send requests
 * without an Origin header, exactly like every pre-existing Nexus route.
 * Real authentication would require a host-issued caller credential, which
 * this host does not provide (verified live: bare loopback requests with
 * no cookies or tokens receive 200; the host emits no CORS policy
 * headers and answers preflights with 405).
 */
function checkSameOrigin(req) {
  const headers = (req && req.headers) || {}
  const hasOrigin = typeof headers.origin === 'string' && headers.origin.trim() !== ''
  const refererRaw = typeof headers.referer === 'string' ? headers.referer
    : (typeof headers.referrer === 'string' ? headers.referrer : undefined)
  const hasReferer = typeof refererRaw === 'string' && refererRaw.trim() !== ''
  if (!hasOrigin && !hasReferer) return null
  let caller = null
  if (hasOrigin) {
    const parsed = parseOriginValue(headers.origin)
    if (!parsed || parsed.opaque) return 'origin-forbidden'
    caller = parsed
  }
  if (hasReferer) {
    const parsed = parseRefererOrigin(refererRaw)
    if (!parsed) return 'origin-forbidden'
    if (caller && !sameTuple(caller, parsed)) return 'origin-forbidden'
    if (!caller) caller = parsed
  }
  const server = splitHostPort(headers.host)
  if (!server) return 'origin-forbidden'
  const scheme = req && req.socket && req.socket.encrypted ? 'https' : 'http'
  const serverPort = server.port !== null ? server.port : defaultPortForScheme(scheme)
  if (serverPort === null) return 'origin-forbidden'
  if (caller.scheme !== scheme || caller.hostname !== server.hostname || caller.port !== serverPort) {
    return 'origin-forbidden'
  }
  return null
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
  if (codes.indexOf('stale-revision') !== -1 || codes.indexOf('write-conflict') !== -1 || codes.indexOf('dependency-blocked') !== -1 || codes.indexOf('duplicate-id') !== -1) return 409
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

  // ── Registry R4 (provider/model/route catalog + probes) ──────────────
  // Same trusted caller boundary as R3 (loopback host webServer + full
  // origin-tuple check + 64 KiB body cap). R4.3: NO endpoint here accepts
  // secret VALUES — connections carry opaque credential:// references and
  // non-secret status only. There is deliberately no secret-write route on
  // this host (see docs/architecture/registry-r4-providers.md blocker).

  const catalogHandler = async (req, res) => {
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
      const { catalog, errors } = service.getCatalog()
      if (!catalog) {
        respond(res, errorStatusOf(errors), { ok: false, error: (errors[0] && errors[0].code) || 'registry-catalog-unavailable', details: errors })
        return
      }
      respond(res, 200, { ok: true, schemaVersion: 1, generatedAtUtc: new Date().toISOString(), catalog, warnings: errors })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-catalog-failed' })
    }
  }

  const catalogSaveHandler = (kind, field, saver) => async (req, res) => {
    if (req.method !== 'PUT') {
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
    const record = read.body ? read.body[field] : null
    if (!record || typeof record !== 'object') {
      respond(res, 400, { ok: false, error: 'invalid-catalog-payload' })
      return
    }
    const hasExpected = read.body && Object.prototype.hasOwnProperty.call(read.body, 'expectedRevision')
    const opts = { expectedRevision: hasExpected ? read.body.expectedRevision : null }
    if (read.body && read.body.endpointOptions && typeof read.body.endpointOptions === 'object') {
      opts.endpointOptions = {
        trustedPrivateNetwork: read.body.endpointOptions.trustedPrivateNetwork === true,
        allowPrivateLocal: read.body.endpointOptions.allowPrivateLocal === true,
      }
    }
    try {
      const saved = saver(record, opts)
      if (!saved.ok) {
        respond(res, errorStatusOf(saved.errors), { ok: false, error: (saved.errors[0] && saved.errors[0].code) || 'registry-save-rejected', details: saved.errors })
        return
      }
      respond(res, 200, { ok: true, revision: saved.revision, recordVersion: saved.recordVersion === undefined ? null : saved.recordVersion })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-save-failed' })
    }
  }

  const catalogIdHandler = (kind, operation) => async (req, res) => {
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
    const id = read.body && typeof read.body.id === 'string' ? read.body.id.trim() : ''
    if (id === '') {
      respond(res, 400, { ok: false, error: 'invalid-catalog-payload' })
      return
    }
    const hasExpected = read.body && Object.prototype.hasOwnProperty.call(read.body, 'expectedRevision')
    const opts = { expectedRevision: hasExpected ? read.body.expectedRevision : null }
    try {
      const out = operation === 'disable'
        ? service.disableCatalogRecord(kind, id, opts)
        : service.deleteCatalogRecord(kind, id, opts)
      if (!out.ok) {
        respond(res, errorStatusOf(out.errors), { ok: false, error: (out.errors[0] && out.errors[0].code) || 'registry-save-rejected', details: out.errors })
        return
      }
      respond(res, 200, { ok: true, revision: out.revision })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-save-failed' })
    }
  }

  const connectionStatusHandler = async (req, res) => {
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
    const id = read.body && typeof read.body.id === 'string' ? read.body.id.trim() : ''
    const status = read.body && typeof read.body.status === 'string' ? read.body.status.trim() : ''
    const attested = read.body ? read.body.attested === true : false
    if (id === '' || status === '') {
      respond(res, 400, { ok: false, error: 'invalid-catalog-payload' })
      return
    }
    try {
      const out = service.setConnectionStatus(id, status, { attested })
      if (!out.ok) {
        respond(res, errorStatusOf(out.errors), { ok: false, error: (out.errors[0] && out.errors[0].code) || 'registry-save-rejected', details: out.errors })
        return
      }
      respond(res, 200, { ok: true, revision: out.revision, attested: out.attested === true })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-save-failed' })
    }
  }

  // Explicit user-triggered probes (R4.4): bounded synthetic requests, no
  // startup probing, redacted diagnostics. Probe failures are honest 200
  // diagnostic envelopes ({ ok: false, checks/evidence, errors }), never a
  // transport error — the probe ran, the provider did not satisfy it.
  const providerProbeHandler = (operation) => async (req, res) => {
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
    const id = read.body && typeof read.body.id === 'string' ? read.body.id.trim() : ''
    if (id === '') {
      respond(res, 400, { ok: false, error: 'invalid-probe-payload' })
      return
    }
    // R4.1/R4.3: probe requests never carry secret values. Any credential-ish
    // field is rejected outright — credentials cross only the future R5
    // authenticated boundary, never this loopback UI API.
    if (read.body && (read.body.testBearer !== undefined || read.body.apiKey !== undefined || read.body.secret !== undefined || read.body.token !== undefined || read.body.password !== undefined)) {
      respond(res, 400, { ok: false, error: 'secret-material-rejected' })
      return
    }
    const connectionId = read.body && typeof read.body.connectionId === 'string' ? read.body.connectionId : undefined
    const endpointOptions = read.body && read.body.endpointOptions && typeof read.body.endpointOptions === 'object' ? {
      trustedPrivateNetwork: read.body.endpointOptions.trustedPrivateNetwork === true,
      allowPrivateLocal: read.body.endpointOptions.allowPrivateLocal === true,
    } : undefined
    try {
      if (operation === 'test') {
        const out = await service.testProviderConnection(id, { connectionId, endpointOptions })
        respond(res, 200, { ok: out.ok, evidence: out.evidence || null, errors: out.errors || [] })
        return
      }
      if (operation === 'discover') {
        const out = await service.discoverProviderModels(id, { connectionId, endpointOptions })
        respond(res, 200, { ok: out.ok, advertised: out.advertised || [], errors: out.errors || [] })
        return
      }
      const out = await service.verifyProviderRoute(id, { endpointOptions })
      respond(res, 200, { ok: out.ok, checks: out.checks || [], evidence: out.evidence || null, errors: out.errors || [] })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-probe-failed' })
    }
  }

  const routeEvidenceHandler = async (req, res) => {
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
      const routeId = (url.searchParams.get('route') || '').trim()
      if (routeId === '') {
        respond(res, 400, { ok: false, error: 'missing-route' })
        return
      }
      const { evidence, attempts, errors } = service.getRouteEvidence(routeId)
      if (errors.length > 0) {
        respond(res, errorStatusOf(errors), { ok: false, error: errors[0].code, details: errors })
        return
      }
      respond(res, 200, { ok: true, routeId, evidence, attempts: attempts || [] })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-evidence-failed' })
    }
  }

  const routeProjectHandler = async (req, res) => {
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
    const id = read.body && typeof read.body.id === 'string' ? read.body.id.trim() : ''
    if (id === '') {
      respond(res, 400, { ok: false, error: 'invalid-probe-payload' })
      return
    }
    try {
      const out = service.projectRoute(id, read.body && read.body.runtime !== undefined ? read.body.runtime : null)
      if (!out.ok) {
        respond(res, errorStatusOf(out.errors), { ok: false, error: (out.errors[0] && out.errors[0].code) || 'registry-projection-rejected', details: out.errors })
        return
      }
      respond(res, 200, { ok: true, projection: out.projection })
    } catch {
      respond(res, 500, { ok: false, error: 'registry-projection-failed' })
    }
  }

  return {
    modesHandler,
    configurationHandler,
    eligibleHandler,
    validateHandler: bodyConfigHandler('validate'),
    previewHandler: bodyConfigHandler('preview'),
    catalogHandler,
    providerSaveHandler: catalogSaveHandler('providers', 'provider', (record, opts) => service.saveProvider(record, opts)),
    modelSaveHandler: catalogSaveHandler('models', 'model', (record, opts) => service.saveModel(record, opts)),
    routeSaveHandler: catalogSaveHandler('routes', 'route', (record, opts) => service.saveRoute(record, opts)),
    connectionSaveHandler: catalogSaveHandler('connections', 'connection', (record, opts) => service.saveConnection(record, opts)),
    providerDisableHandler: catalogIdHandler('providers', 'disable'),
    modelDisableHandler: catalogIdHandler('models', 'disable'),
    routeDisableHandler: catalogIdHandler('routes', 'disable'),
    connectionDisableHandler: catalogIdHandler('connections', 'disable'),
    providerDeleteHandler: catalogIdHandler('providers', 'delete'),
    modelDeleteHandler: catalogIdHandler('models', 'delete'),
    routeDeleteHandler: catalogIdHandler('routes', 'delete'),
    connectionDeleteHandler: catalogIdHandler('connections', 'delete'),
    connectionStatusHandler,
    providerTestHandler: providerProbeHandler('test'),
    providerDiscoverHandler: providerProbeHandler('discover'),
    routeVerifyHandler: providerProbeHandler('verify'),
    routeEvidenceHandler,
    routeProjectHandler,
  }
}

module.exports = {
  MAX_BODY_BYTES,
  checkSameOrigin,
  readBoundedJson,
  errorStatusOf,
  createRegistryHandlers,
}
