'use strict'

/**
 * Registry R4.1 — hardened explicit discovery & capability probes.
 *
 * Runs with NO DSH process, NO session, NO controller involvement. Nothing
 * here runs on startup; every entry point is called explicitly from the
 * service layer after a user action (Test Connection / Discover Models /
 * Verify Capabilities).
 *
 * H1 transport guarantees (per request, not just at provider creation):
 * single deadline covering connection, headers and body; streaming
 * response-size enforcement BEFORE full buffering; redirect denial by
 * default (a 3xx is refused, the Location target is never fetched);
 * request-time DNS resolution with connection-target checks (a public
 * hostname resolving to a restricted address is refused); bounded
 * concurrency (4 inflight probe requests); caller cancellation; response
 * cleanup; synthetic-only bodies; redacted diagnostics.
 *
 * H2 verification is structural, per protocol dialect: real completion
 * objects (not any JSON), genuine SSE event streams, real tool-call objects
 * with parsed argument structure, continuation with the ACTUAL emitted call
 * id, reasoning-effort acknowledgment, and authenticated access proven only
 * by a presented credential that the provider accepted.
 *
 * H3 evidence carries contractVersion + a fingerprint over the verified
 * binding (endpoint, transport, model/checkpoint, remote model, route,
 * connection identity/status, capabilities, reasoning levels). Any change
 * to those fields invalidates the evidence at eligibility time.
 *
 * fetchImpl is injected (tests use fakes; the service passes the platform
 * fetch). DNS resolution is injected too (options.lookup); the default uses
 * node:dns. This module never imports DSH, PowerShell, sessions or secrets.
 */

const crypto = require('node:crypto')
const providerConfig = require('./provider-config.cjs')
const pinnedTransport = require('./pinned-transport.cjs')

const DEFAULT_TIMEOUT_MS = 15000
// OpenCode Go (S10-A): a NON-streaming probe returns its headers only after the whole answer is generated, and
// a reasoning model's latency is high-variance (a one-word answer measured 2.0 s at low, 4.2 s medium, 4.0 s
// high and 10.0 s at xhigh on the real provider). 15 s left no margin; 45 s keeps every probe bounded
// (8 probes < 6 min worst case) without touching any other provider or the production transport.
const GO_PROBE_TIMEOUT_MS = 45000
const MAX_RESPONSE_BYTES = 262144
const MAX_PROBE_INFLIGHT = 4
const PROBE_CONTRACT_VERSION = 3
const PROBE_USER_AGENT = 'nexus-registry-probe/1 (synthetic capability check; no user content)'

function err(code, p, message) {
  return { code, path: p, message }
}

function redact(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/sk-(live|proj|svcacct)-[A-Za-z0-9._-]+/g, '[redacted-key]')
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, '[redacted-key]')
    .replace(/xox[bap]-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/ghp_[A-Za-z0-9]+/g, '[redacted-token]')
    .replace(/gho_[A-Za-z0-9]+/g, '[redacted-token]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted-key]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
}

function normalizeError(e, where) {
  if (e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string' && typeof e.path === 'string') return e
  if (e && (e.code === 'probe-timeout' || e.code === 'probe-cancelled')) {
    return err(e.code, where, String(e.message || (e.code === 'probe-cancelled' ? 'probe cancelled by the caller' : 'probe timed out (bounded request; provider did not answer in time)')))
  }
  if (/abort|cancel/i.test(String((e && e.name) || '') + ' ' + String((e && e.message) || ''))) {
    return err('probe-cancelled', where, 'probe cancelled while contacting the provider')
  }
  if (/timeout/i.test(String((e && e.name) || '') + ' ' + String((e && e.message) || ''))) {
    return err('probe-timeout', where, 'probe timed out (bounded request; provider did not answer in time)')
  }
  return err('probe-failed', where, redact(String((e && e.message) || e)))
}

// --- bounded concurrency: at most MAX_PROBE_INFLIGHT requests in flight ---
let inflightProbes = 0
const probeWaiters = []
function acquireProbeSlot(signal) {
  if (signal && signal.aborted) return Promise.reject(err('probe-cancelled', 'probe', 'probe cancelled before it started'))
  if (inflightProbes < MAX_PROBE_INFLIGHT) {
    inflightProbes += 1
    return Promise.resolve(releaseProbeSlot)
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject }
    probeWaiters.push(entry)
    if (signal) {
      signal.addEventListener('abort', () => {
        const at = probeWaiters.indexOf(entry)
        if (at !== -1) probeWaiters.splice(at, 1)
        reject(err('probe-cancelled', 'probe', 'probe cancelled while queued'))
      }, { once: true })
    }
  })
}
function releaseProbeSlot() {
  const next = probeWaiters.shift()
  if (next) {
    next.resolve(releaseProbeSlot)
    return
  }
  inflightProbes = Math.max(0, inflightProbes - 1)
}

async function defaultLookup(host) {
  try {
    const dns = require('node:dns').promises
    const all = await dns.lookup(host, { all: true })
    return (all || []).map((a) => ({ address: a.address, family: a.family }))
  } catch {
    return []
  }
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl).replace(/\/+$/, '')
  return base + suffix
}

// A5.4: the OpenCode Go adapter is selected only by the provider's explicit
// `metadata.wireProfile`. Its models endpoint is NOT base+/models (it lives at
// /inference/go/v1/models) and every request carries a stable session header.
// Both are derived here from fixed constants, never from probe input.
const GO_PROFILE = 'opencode-go-responses'
const GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'
const GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'
// Muse is a reasoning model: with 128 the first live probe came back
// status "incomplete" (budget spent before any text); 1024 still flaked on the
// tool-result continuation (A6.1.4 P0: reasoning tokens count against the cap). Probe-only ceiling.
const GO_PROBE_MAX_OUTPUT = 4096
function isGoProfile(provider) {
  return !!(provider && provider.metadata && provider.metadata.wireProfile === GO_PROFILE)
}
function modelsUrlOf(provider, paths) {
  if (isGoProfile(provider) && String(provider.baseUrl).replace(/\/+$/, '') === GO_BASE_URL) return GO_MODELS_URL
  return joinUrl(provider.baseUrl, paths.models)
}
// The shared SSRF policy treats every global IPv6 address as restricted and
// refuses a host if ANY resolved address is restricted, so a dual-stack host
// (opencode.ai has AAAA records) would always be refused. For the Go profile
// only, the probe resolves IPv4 addresses alone: still every address validated,
// just a narrower dial set. Nothing in the policy is relaxed.
async function ipv4OnlyLookup(host) {
  try {
    const dns = require('node:dns').promises
    const all = await dns.lookup(host, { all: true, family: 4 })
    return (all || []).map((a) => ({ address: a.address, family: a.family }))
  } catch {
    return []
  }
}
function probeLookupFor(provider) {
  return isGoProfile(provider) ? ipv4OnlyLookup : undefined
}
function profileHeaders(provider) {
  if (!isGoProfile(provider)) return {}
  return { 'x-opencode-session': 'nexus-registry-probe-' + String(provider.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) }
}

function transportPaths(transportId) {
  if (transportId === 'openai-responses') return { models: '/models', text: '/responses' }
  return { models: '/models', text: '/chat/completions' }
}

function checkSyntheticBody(bodyText) {
  if (typeof bodyText !== 'string' || bodyText === '') return null
  if (/sk-(live|proj|svcacct)-|sk-ant-|xox[bap]-|ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bodyText)) {
    return err('secret-material-rejected', 'probe.body', 'probe bodies are synthetic; refusing to transmit secret-shaped material')
  }
  return null
}

function cleanupResponse(res) {
  try {
    const body = res && res.body
    if (!body) return
    if (typeof body.cancel === 'function') { try { const r = body.cancel(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {} return }
    if (typeof body.destroy === 'function') { try { body.destroy(); } catch {} return }
  } catch { /* best effort */ }
}

function isAsyncIterable(value) {
  return !!value && (typeof value[Symbol.asyncIterator] === 'function' || typeof value[Symbol.iterator] === 'function')
}

async function readCappedBody(res, signal) {
  // Streaming path: enforce the cap WHILE reading, before the full body is
  // ever accumulated. Returns { text, bytes, capped } where capped means the
  // provider exceeded the bound and reading stopped early.
  const chunks = []
  let bytes = 0
  const body = res.body
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        if (signal && signal.aborted) throw err('probe-cancelled', 'probe.body', 'probe cancelled while reading the response body')
        const { done, value } = await reader.read()
        if (done) break
        const part = typeof value === 'string' ? value : Buffer.from(value).toString('utf8')
        bytes += Buffer.byteLength(part, 'utf8')
        if (bytes > MAX_RESPONSE_BYTES) return { text: null, bytes, capped: true }
        chunks.push(part)
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return { text: chunks.join(''), bytes, capped: false }
  }
  const iterator = body[Symbol.asyncIterator] ? body[Symbol.asyncIterator]() : body[Symbol.iterator]()
  for (;;) {
    if (signal && signal.aborted) throw err('probe-cancelled', 'probe.body', 'probe cancelled while reading the response body')
    const step = await iterator.next()
    if (!step || step.done) break
    const part = typeof step.value === 'string' ? step.value : Buffer.from(step.value).toString('utf8')
    bytes += Buffer.byteLength(part, 'utf8')
    if (bytes > MAX_RESPONSE_BYTES) return { text: null, bytes, capped: true }
    chunks.push(part)
  }
  return { text: chunks.join(''), bytes, capped: false }
}

/**
 * One hardened probe request. The single deadline covers connection,
 * headers AND body consumption; the race below settles even when the
 * transport ignores the abort signal. Redirects are denied (never
 * followed); DNS results are revalidated per request.
 */
async function secureFetch(fetchImpl, url, opts) {
  const o = opts || {}
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : DEFAULT_TIMEOUT_MS
  const outerSignal = o.signal || null
  if (outerSignal && outerSignal.aborted) throw err('probe-cancelled', 'probe', 'probe cancelled before it started')
  let parsed = null
  try {
    parsed = new URL(String(url))
  } catch {
    throw err('endpoint-invalid', 'probe.target', 'probe URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw err('endpoint-invalid', 'probe.target', 'probe URL must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw err('endpoint-forbidden-ssrf', 'probe.target', 'probe URL must not embed userinfo/credentials')
  }
  const host = parsed.hostname
  const bodyText = o.body !== undefined ? String(o.body) : undefined
  const syntheticError = bodyText !== undefined ? checkSyntheticBody(bodyText) : null
  if (syntheticError) throw syntheticError
  const release = await acquireProbeSlot(outerSignal)
  if (outerSignal && outerSignal.aborted) {
    try { release(); } catch {}
    throw err('probe-cancelled', 'probe', 'probe cancelled while queued')
  }
  const internal = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { internal.abort(); } catch {} }, timeoutMs)
  let forwardAbort = null
  if (outerSignal) {
    forwardAbort = () => { try { internal.abort(); } catch {} }
    outerSignal.addEventListener('abort', forwardAbort, { once: true })
  }
  function packInit() {
    return {
      method: o.method || 'GET',
      headers: Object.assign({ 'user-agent': PROBE_USER_AGENT, accept: (o.accept || 'application/json') }, o.headers || {}),
      body: o.body !== undefined ? o.body : undefined,
      signal: internal.signal,
      redirect: 'manual',
    }
  }
  async function resolveValidated() {
    let addresses = []
    if (providerConfig.isIpLiteral(host)) {
      addresses = [{ address: host, family: host.indexOf(':') !== -1 ? 6 : 4 }]
    } else {
      const lookup = typeof o.lookup === 'function' ? o.lookup : defaultLookup
      try {
        addresses = (await lookup(host)) || []
      } catch (e) {
        if (outerSignal && outerSignal.aborted) throw err('probe-cancelled', 'probe', 'probe cancelled during DNS resolution')
        if (timedOut) throw err('probe-timeout', 'probe', 'probe timed out (bounded request; DNS resolution stalled past the deadline)')
        throw err('endpoint-forbidden-ssrf', 'probe.target', 'host ' + host + ' could not be resolved; refusing an unvalidated target')
      }
    }
    const targetErrors = providerConfig.checkRequestTarget(host, addresses, o.transportId, o.endpointOptions)
    if (targetErrors.length > 0) throw targetErrors[0]
    return addresses
  }
  async function doWork() {
    const addresses = await resolveValidated()
    let res = null
    try {
      if (typeof fetchImpl === 'function') {
        res = await fetchImpl(String(url), packInit())
      } else {
        res = await pinnedTransport.requestPinned(String(url), packInit(), { addresses: addresses }, {})
      }
    } catch (e) {
      if (outerSignal && outerSignal.aborted) throw err('probe-cancelled', 'probe', 'probe cancelled while contacting the provider')
      if (timedOut) throw err('probe-timeout', 'probe', 'probe timed out (bounded request; provider did not answer in time)')
      throw normalizeError(e, 'probe')
    }
    const status = res && typeof res.status === 'number' ? res.status : 0
    if (status >= 300 && status < 400) {
      cleanupResponse(res)
      throw err('probe-redirect-refused', 'probe.target', 'provider answered HTTP ' + status + ' with a redirect; redirects are denied and the Location target was not fetched')
    }
    try {
      if (res && isAsyncIterable(res.body)) {
        const read = await readCappedBody(res, internal.signal)
        if (read.capped) {
          cleanupResponse(res)
          throw err('probe-response-too-large', 'probe.body', 'provider response exceeded the bounded probe size limit before it was fully read')
        }
        return { status, text: read.text, bytes: read.bytes, headers: res.headers || null }
      }
      if (res && typeof res.text === 'function') {
        if (outerSignal && outerSignal.aborted) throw err('probe-cancelled', 'probe.body', 'probe cancelled while reading the response body')
        const text = await res.text()
        if (typeof text !== 'string') throw err('probe-failed', 'probe.body', 'provider returned an unreadable response body')
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
          cleanupResponse(res)
          throw err('probe-response-too-large', 'probe.body', 'provider response exceeded the bounded probe size limit')
        }
        return { status, text, bytes: text.length, headers: res.headers || null }
      }
      if (res && typeof res.json === 'function') {
        const json = await res.json()
        const text = JSON.stringify(json)
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
          cleanupResponse(res)
          throw err('probe-response-too-large', 'probe.body', 'provider response exceeded the bounded probe size limit')
        }
        return { status, text, bytes: text.length, headers: res.headers || null }
      }
      throw err('probe-failed', 'probe.body', 'provider returned a response with no readable body')
    } finally {
      cleanupResponse(res)
    }
  }
  try {
    const work = doWork()
    work.catch(() => {})
    let raceTimer = null
    const outcome = await Promise.race([
      work.then((v) => ({ ok: true, v })),
      new Promise((resolve) => { raceTimer = setTimeout(() => resolve({ ok: false }), Math.max(0, timeoutMs)) }),
    ])
    if (raceTimer !== null) {
      try { clearTimeout(raceTimer); } catch {}
    }
    if (outcome.ok) return outcome.v
    try { internal.abort(); } catch {}
    cleanupResponse({ body: null })
    if (outerSignal && outerSignal.aborted) throw err('probe-cancelled', 'probe', 'probe cancelled while reading the response body')
    throw err('probe-timeout', 'probe', 'probe timed out (bounded request; the response body stalled past the deadline)')
  } finally {
    clearTimeout(timer)
    if (outerSignal && forwardAbort) {
      try { outerSignal.removeEventListener('abort', forwardAbort); } catch {}
    }
    release()
  }
}

async function boundedJson(fetchImpl, url, opts) {
  const out = await secureFetch(fetchImpl, url, opts)
  let json = null
  try {
    json = out.text.trim() === '' ? null : JSON.parse(out.text)
  } catch {
    if (out.status < 200 || out.status >= 300) {
      // an HTTP error with a non-JSON body: keep the STATUS (it is the finding), plus a redacted sample
      return { status: out.status, json: null, bytes: out.bytes, textSample: redact(String(out.text)).slice(0, SAFE_BODY_LIMIT) }
    }
    throw err('probe-failed', 'probe.body', 'provider returned a non-JSON response (redacted, ' + out.bytes + ' bytes)')
  }
  return { status: out.status, json, bytes: out.bytes }
}

function parseSseEvents(text) {
  // Genuine SSE: event blocks separated by blank lines; payload lines start
  // with 'data:'. Returns { events, done } where events are raw payloads.
  const events = []
  let done = false
  const blocks = String(text).split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (line === '' || line[0] === ':') continue
      if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''))
      else if (line.indexOf('event:') === 0) continue
      else return { events: null, done: false, invalid: 'non-SSE line: ' + redact(line).slice(0, 80) }
    }
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    if (payload.trim() === '[DONE]') { done = true; continue }
    events.push(payload)
  }
  return { events, done, invalid: null }
}

async function boundedSse(fetchImpl, url, opts) {
  const out = await secureFetch(fetchImpl, url, Object.assign({}, opts, { accept: 'text/event-stream' }))
  if (out.status < 200 || out.status >= 300) {
    let json = null
    try { json = JSON.parse(out.text) } catch { /* not JSON: the sample below is used */ }
    return { status: out.status, events: [], done: false, bytes: out.bytes, json, textSample: redact(String(out.text)).slice(0, SAFE_BODY_LIMIT) }
  }
  const parsed = parseSseEvents(out.text)
  if (!parsed.events) {
    throw err('probe-sse-invalid', 'probe.body', 'streaming response is not a valid SSE stream (' + (parsed.invalid || 'no data events') + ')')
  }
  return { status: out.status, events: parsed.events, done: parsed.done, bytes: out.bytes }
}

// --- authentication model: reachability is not authorization ---------------
function authRequirement(connection) {
  const ref = connection && typeof connection.credentialRef === 'string' && connection.credentialRef !== ''
  if (!ref) return { required: false, reason: 'connection carries no credential reference; the provider needs no key' }
  if (connection && connection.connectionKind === 'local-server') {
    return { required: false, reason: 'local-server connection uses no key auth' }
  }
  return { required: true, reason: 'connection requires an API credential' }
}
function presentedBearer(connection) {
  return connection && typeof connection.testBearer === 'string' && connection.testBearer !== '' ? connection.testBearer : null
}
function authHeaders(connection) {
  const bearer = presentedBearer(connection)
  return bearer ? { authorization: 'Bearer ' + bearer } : {}
}

// --- safe HTTP-failure diagnostics (S10-A, the OpenCode Go 403 investigation) ------------------------
// A 401/403 used to read "rejected credential" for EVERY cause. This classifies what can honestly be
// told apart WITHOUT a token ever being shown: whether a credential was selected and an Authorization
// header attached (from the connection object, never its value), the HTTP status, and a class derived
// from the status and from the provider's own (redacted, bounded) error text. The classes are
// hypotheses ranked by evidence; `forbidden-unclassified` says "the provider did not say why".
const SAFE_BODY_LIMIT = 160
function sanitizedProviderText(json, text) {
  let raw = ''
  if (json && typeof json === 'object') {
    const e = json.error !== undefined ? json.error : json
    if (typeof e === 'string') raw = e
    else if (e && typeof e === 'object') raw = [e.type, e.code, e.message].filter((x) => typeof x === 'string').join(' | ')
  } else if (typeof text === 'string') raw = text
  // never echo anything that looks like a credential, and keep it to one short plain line
  return redact(String(raw)).replace(/[A-Za-z0-9_.\-+\/=]{24,}/g, '[redacted]').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SAFE_BODY_LIMIT)
}
function classifyHttpFailure(status, bearerPresent, providerText) {
  const t = String(providerText || '').toLowerCase()
  if (!bearerPresent) return 'credential-missing'
  if (status === 401) return 'credential-invalid-or-expired'
  if (status === 403) {
    if (/region|country|countr|geograph|location|jurisdiction|not available in your|unsupported territory/.test(t)) return 'region-restricted'
    if (/contributor|training|train |data.?use|privacy|consent|opt.?in|terms|agreement|policy/.test(t)) return 'contributor-privacy-or-terms'
    if (/permission|scope|plan|subscription|upgrade|limit|quota|billing|balance|credit|payment|not allowed|entitle|access to (this )?model/.test(t)) return 'insufficient-permissions-or-plan'
    if (/invalid|expired|revoked|unauthor|api.?key|token/.test(t)) return 'credential-invalid-or-expired'
    return 'forbidden-unclassified'
  }
  return 'http-error'
}
function httpFailureDiagnostic(status, connection, out) {
  const bearer = presentedBearer(connection)
  let providerText = sanitizedProviderText(out && out.json, out && out.textSample)
  if (bearer && providerText.indexOf(bearer) !== -1) providerText = providerText.split(bearer).join('[redacted]')
  return {
    http_status: status,
    credential_present: !!bearer,
    credential_selected: !!(connection && typeof connection.credentialRef === 'string' && connection.credentialRef !== ''),
    authorization_header_present: !!bearer,
    class: classifyHttpFailure(status, !!bearer, providerText),
    provider_message: providerText,
  }
}
function describeHttpFailure(d) {
  return 'HTTP ' + d.http_status + ' [' + d.class + '] credential_present=' + d.credential_present + ' credential_selected=' + d.credential_selected + ' authorization_header_present=' + d.authorization_header_present + (d.provider_message ? ' provider_message="' + d.provider_message + '"' : ' provider_message=(none)')
}

// --- structural protocol validators (H2) ------------------------------------
function failValidation(detail) { return { ok: false, detail } }
function okValidation(detail, extra) { return Object.assign({ ok: true, detail }, extra || {}) }

function validateTextCompletion(transportId, json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return failValidation('response is not a completion object')
  }
  if (json.error) {
    return failValidation('provider returned an error: ' + redact(typeof json.error === 'string' ? json.error : JSON.stringify(json.error)).slice(0, 200))
  }
  if (transportId === 'openai-responses') {
    if (json.status !== undefined && json.status !== 'completed') {
      const why = json.incomplete_details && typeof json.incomplete_details.reason === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/.test(json.incomplete_details.reason) ? ' (incomplete reason: ' + json.incomplete_details.reason + ')' : ''
      return failValidation('responses status is ' + JSON.stringify(json.status) + ', not completed' + why)
    }
    if (typeof json.output_text === 'string' && json.output_text.trim() !== '') {
      return okValidation('responses text completion (' + json.output_text.trim().length + ' chars of generated text)')
    }
    const out = json.output
    if (!Array.isArray(out) || out.length === 0) return failValidation('responses output is empty')
    for (const item of out) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content.filter((c) => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string').map((c) => c.text).join('')
        if (text.trim() !== '') return okValidation('responses text completion (' + text.trim().length + ' chars of generated text)')
      }
    }
    return failValidation('responses output carries no message text')
  }
  const choices = json.choices
  if (!Array.isArray(choices) || choices.length === 0) return failValidation('choices is empty')
  const msg = choices[0] && choices[0].message
  if (!msg || typeof msg.content !== 'string' || msg.content.trim() === '') {
    return failValidation('first choice carries no message content')
  }
  return okValidation('chat completion (' + msg.content.trim().length + ' chars of generated text)')
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

function validateToolEmission(transportId, json, toolName) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return failValidation('response is not an object')
  if (json.error) return failValidation('provider returned an error instead of a tool call')
  if (transportId === 'openai-responses') {
    const out = json.output
    if (!Array.isArray(out) || out.length === 0) return failValidation('responses output is empty; no tool call emitted')
    for (const item of out) {
      if (item && item.type === 'function_call' && item.name === toolName) {
        const callId = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : (typeof item.id === 'string' && item.id !== '' ? item.id : null)
        if (!callId) return failValidation('function call for ' + toolName + ' carries no call identifier')
        const args = parseToolArguments(item.arguments)
        if (!args.ok) return failValidation('function call arguments are not a JSON object')
        return okValidation('provider emitted ' + toolName + ' with call id ' + callId, { callId })
      }
    }
    return failValidation('responses output contains no function call for ' + toolName)
  }
  const choices = json.choices
  if (!Array.isArray(choices) || choices.length === 0) return failValidation('choices is empty; no tool call emitted')
  const msg = choices[0] && choices[0].message
  const calls = msg && msg.tool_calls
  if (!Array.isArray(calls) || calls.length === 0) return failValidation('first choice carries no tool_calls')
  for (const call of calls) {
    const fn = call && call.function
    if (call && (call.type === undefined || call.type === 'function') && fn && fn.name === toolName) {
      if (typeof call.id !== 'string' || call.id === '') return failValidation('tool call for ' + toolName + ' carries no call identifier')
      const args = parseToolArguments(fn.arguments)
      if (!args.ok) return failValidation('tool call arguments are not a JSON object')
      return okValidation('provider emitted ' + toolName + ' with call id ' + call.id, { callId: call.id })
    }
  }
  return failValidation('tool_calls contain no call for ' + toolName)
}

function validateContinuation(transportId, json) {
  // The provider must have consumed the tool result and produced language:
  // generated text is required; another bare function call is a loop, not a
  // continuation. Provider-specific continuation shapes that cannot be
  // validated stay unverified (never guessed).
  if (!json || typeof json !== 'object' || Array.isArray(json)) return failValidation('response is not an object')
  if (json.error) return failValidation('provider returned an error for the tool-result continuation')
  if (transportId === 'openai-responses') {
    const out = json.output
    if (!Array.isArray(out) || out.length === 0) return failValidation('continuation output is empty')
    let sawTextFlag = false
    let sawBareFlag = false
    for (const item of out) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content.filter((c) => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string').map((c) => c.text).join('')
        if (text.trim() !== '') sawTextFlag = true
      } else if (item && item.type === 'function_call') sawBareFlag = true
    }
    if (sawTextFlag) return okValidation('provider continued with generated text after the tool result')
    if (sawBareFlag) return failValidation('provider emitted another function call instead of continuing with text')
    return failValidation('continuation carries no generated text')
  }
  const choices = json.choices
  if (!Array.isArray(choices) || choices.length === 0) return failValidation('continuation choices are empty')
  const msg = choices[0] && choices[0].message
  if (msg && typeof msg.content === 'string' && msg.content.trim() !== '') {
    return okValidation('provider continued with generated text after the tool result')
  }
  return failValidation('continuation carries no generated text')
}

function findReasoningEvidence(json, effort, depth) {
  // Positive structural evidence that the requested reasoning effort was
  // honored: an echoed effort value under reasoning-associated keys, or
  // consumed reasoning tokens. Anything else leaves the mapping unverified.
  if (depth === undefined) depth = 0
  if (!json || typeof json !== 'object' || depth > 6) return false
  if (Array.isArray(json)) {
    for (const item of json) if (findReasoningEvidence(item, effort, depth + 1)) return true
    return false
  }
  for (const key of Object.keys(json)) {
    const value = json[key]
    if (/reasoning/i.test(key)) {
      if (typeof value === 'string' && value === effort) return true
      if (value && typeof value === 'object') {
        if (value.effort === effort) return true
        if (typeof value.reasoning_tokens === 'number' && value.reasoning_tokens > 0) return true
        if (typeof value.tokens === 'number' && /reasoning/i.test(key) && value.tokens > 0) return true
        if (findReasoningEvidence(value, effort, depth + 1)) return true
      }
      if (typeof value === 'number' && value > 0 && /tokens/i.test(key)) return true
    } else if (value && typeof value === 'object') {
      if (findReasoningEvidence(value, effort, depth + 1)) return true
    }
  }
  return false
}

function validateSseEvents(transportId, events) {
  if (!Array.isArray(events) || events.length === 0) {
    return failValidation('SSE stream carried no data events')
  }
  let contentEvents = 0
  for (const payload of events) {
    let parsed = null
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (transportId === 'openai-responses') {
      const out = parsed.output || (parsed.delta && parsed.delta.output) || parsed.response || null
      const blob = JSON.stringify(out !== null ? out : parsed)
      if (/output_text|"text"|delta/.test(blob)) contentEvents += 1
    } else {
      const choices = parsed.choices
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = choices[0].delta || choices[0].message || {}
        if ((typeof delta.content === 'string' && delta.content !== '') || delta.tool_calls || delta.reasoning_content) contentEvents += 1
      }
    }
  }
  if (contentEvents === 0) return failValidation('SSE stream carried ' + events.length + ' event(s) but none with completion content')
  return okValidation('SSE stream with ' + contentEvents + ' content event(s) of ' + events.length)
}

// --- evidence fingerprint (H3) -----------------------------------------------
function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}
function sortedCapabilities(caps) {
  const out = {}
  for (const k of Object.keys(caps || {}).sort()) out[k] = !!(caps || {})[k]
  return out
}
function fingerprintInputOf(parts) {
  const provider = (parts && parts.provider) || {}
  const model = (parts && parts.model) || {}
  const route = (parts && parts.route) || {}
  const connection = (parts && parts.connection) || null
  return {
    contractVersion: PROBE_CONTRACT_VERSION,
    endpoint: provider.baseUrl || null,
    transport: provider.transportId || null,
    model: model.id || null,
    checkpoint: model.checkpoint || null,
    capabilities: sortedCapabilities(model.capabilities),
    remoteModel: route.remoteModelId || null,
    route: route.id || null,
    reasoningLevels: Array.isArray(route.reasoningLevels) ? route.reasoningLevels.slice().sort() : [],
    verifiedLevels: parts && Array.isArray(parts.verifiedLevels) ? parts.verifiedLevels.slice().sort() : [],
    executionKind: route.executionKind || null,
    connection: connection ? (connection.id || null) : null,
    connectionKind: connection ? (connection.connectionKind || null) : null,
    connectionStatus: connection ? (connection.status || null) : null,
    credentialRef: connection ? (connection.credentialRef || null) : null,
  }
}
function fingerprintOf(input) {
  return crypto.createHash('sha256').update(canonicalize(input)).digest('hex')
}
/**
 * Test Connection: reachability is reported separately from authorization.
 * authenticated is true ONLY when a credential was presented and the
 * provider accepted it, or when the connection requires no credential. An
 * unauthenticated 200 against a key-required connection proves
 * reachability alone and fails closed with probe-auth-required.
 */
async function testConnection(provider, connection, fetchImpl, options) {
  const opts = options || {}
  const where = 'probe.connection'
  const paths = transportPaths(provider.transportId)
  const started = Date.now()
  const authReq = authRequirement(connection)
  const bearer = presentedBearer(connection)
  try {
    const out = await boundedJson(fetchImpl, modelsUrlOf(provider, paths), {
      transportId: provider.transportId,
      endpointOptions: opts.endpointOptions,
      lookup: opts.lookup || probeLookupFor(provider),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      headers: Object.assign({}, profileHeaders(provider), authHeaders(connection)),
    })
    const ms = Date.now() - started
    if (out.status === 401 || out.status === 403) {
      return { ok: false, evidence: { kind: 'connection', reachable: true, authenticated: false, credentialPresented: !!bearer, authRequired: authReq.required, status: out.status, ms }, errors: [err('probe-auth-failed', where, describeHttpFailure(httpFailureDiagnostic(out.status, connection, out)) + '; connection is not authorized')] }
    }
    if (out.status < 200 || out.status >= 300) {
      return { ok: false, evidence: { kind: 'connection', reachable: true, authenticated: false, credentialPresented: !!bearer, authRequired: authReq.required, status: out.status, ms }, errors: [err('probe-failed', where, 'provider answered HTTP ' + out.status + ' (redacted body, ' + out.bytes + ' bytes)')] }
    }
    if (authReq.required && !bearer) {
      return { ok: false, evidence: { kind: 'connection', reachable: true, authenticated: false, credentialPresented: false, authRequired: true, status: out.status, ms }, errors: [err('probe-auth-required', where, 'endpoint answered without credentials (HTTP ' + out.status + '); reachability only — present a credential to prove authenticated access')] }
    }
    return { ok: true, evidence: { kind: 'connection', reachable: true, authenticated: true, credentialPresented: !!bearer, authRequired: authReq.required, status: out.status, ms, bytes: out.bytes }, errors: [] }
  } catch (e) {
    return { ok: false, evidence: { kind: 'connection', reachable: false, authenticated: false, credentialPresented: !!bearer, authRequired: authReq.required, ms: Date.now() - started }, errors: [e && e.code ? e : normalizeError(e, where)] }
  }
}

/**
 * Discover Models: GET the provider models endpoint and return advertised
 * ids. Returned routes are ALWAYS 'discovered' — never verified.
 */
async function discoverModels(provider, connection, fetchImpl, options) {
  const opts = options || {}
  const where = 'probe.discover'
  const paths = transportPaths(provider.transportId)
  try {
    const out = await boundedJson(fetchImpl, modelsUrlOf(provider, paths), {
      transportId: provider.transportId,
      endpointOptions: opts.endpointOptions,
      lookup: opts.lookup || probeLookupFor(provider),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      headers: Object.assign({}, profileHeaders(provider), authHeaders(connection)),
    })
    if (out.status === 401 || out.status === 403) {
      return { ok: false, advertised: [], errors: [err('probe-auth-failed', where, 'discovery ' + describeHttpFailure(httpFailureDiagnostic(out.status, connection, out)))] }
    }
    if (out.status < 200 || out.status >= 300) {
      return { ok: false, advertised: [], errors: [err('probe-failed', where, 'discovery answered HTTP ' + out.status)] }
    }
    const data = out.json && Array.isArray(out.json.data) ? out.json.data : (Array.isArray(out.json) ? out.json : [])
    const advertised = []
    for (const entry of data) {
      const id = typeof entry === 'string' ? entry : entry && entry.id
      if (typeof id === 'string' && id !== '' && advertised.indexOf(id) === -1) advertised.push(redact(id))
      if (advertised.length >= 500) break
    }
    return { ok: true, advertised, errors: [] }
  } catch (e) {
    return { ok: false, advertised: [], errors: [e && e.code ? e : normalizeError(e, where)] }
  }
}

function textPayload(transportId, remoteModelId, reasoning, provider) {
  const probeText = 'nexus synthetic capability probe (no user content; reply with the single word: probe-ok)'
  if (transportId === 'openai-responses') {
    const body = { model: remoteModelId, input: probeText, max_output_tokens: isGoProfile(provider) ? GO_PROBE_MAX_OUTPUT : 16 }
    if (reasoning) body.reasoning = { effort: reasoning }
    return body
  }
  const body = { model: remoteModelId, messages: [{ role: 'user', content: probeText }], max_tokens: 16, stream: false }
  if (reasoning) body.reasoning_effort = reasoning
  return body
}

function toolPayload(transportId, remoteModelId, provider) {
  const tool = { type: 'function', function: { name: 'probe_echo', description: 'Synthetic probe tool (no user content).', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } } }
  if (transportId === 'openai-responses') {
    return { model: remoteModelId, input: 'nexus synthetic tool probe (no user content; call probe_echo with word set to probe-ok)', tools: [{ type: 'function', name: 'probe_echo', description: 'Synthetic probe tool.', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }], max_output_tokens: isGoProfile(provider) ? GO_PROBE_MAX_OUTPUT : 64 }
  }
  return { model: remoteModelId, messages: [{ role: 'user', content: 'nexus synthetic tool probe (no user content; call probe_echo with word set to probe-ok)' }], tools: [tool], tool_choice: 'auto', max_tokens: 64, stream: false }
}

function continuationPayload(transportId, remoteModelId, toolCallId, provider, reasoning) {
  if (transportId === 'openai-responses' && isGoProfile(provider)) {
    // Stateless Responses continuation: the function_call item must precede
    // its output, otherwise a real Responses endpoint rejects the call id.
    return { model: remoteModelId, input: [
      { type: 'function_call', call_id: toolCallId, name: 'probe_echo', arguments: '{"word":"probe-ok"}' },
      { type: 'function_call_output', call_id: toolCallId, output: 'probe-ok' },
    ], max_output_tokens: GO_PROBE_MAX_OUTPUT, ...(reasoning ? { reasoning: { effort: reasoning } } : {}) }
    // ^ like every production request, the continuation PINS its reasoning effort; without it the provider's
    //   default effort applies and the one non-streaming request without a pinned effort timed out (15 s)
  }
  if (transportId === 'openai-responses') {
    return { model: remoteModelId, input: [{ type: 'function_call_output', call_id: toolCallId, output: 'probe-ok' }], max_output_tokens: 16 }
  }
  return { model: remoteModelId, messages: [{ role: 'user', content: 'probe' }, { role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'probe_echo', arguments: '{"word":"probe-ok"}' } }] }, { role: 'tool', tool_call_id: toolCallId, content: 'probe-ok' }], max_tokens: 16, stream: false }
}

/**
 * Verify Capabilities for ONE route. Required checks are derived from the
 * logical model + route: authenticated access always; structural text
 * completion always (with reasoning acknowledgment when levels exist);
 * genuine SSE streaming when declared; real tool-call emission plus
 * continuation with the ACTUAL emitted call id when toolCalling. ALL
 * required checks must pass for { ok: true }.
 */
async function verifyRoute(provider, model, route, connection, fetchImpl, options) {
  const opts = options || {}
  const where = 'probe.route.' + route.id
  const checks = []
  const paths = transportPaths(provider.transportId)
  const reasoning = Array.isArray(route.reasoningLevels) && route.reasoningLevels.length > 0 ? route.reasoningLevels[0] : null
  const needsStreaming = !!(model.capabilities && model.capabilities.streaming)
  const needsTools = !!(model.capabilities && model.capabilities.toolCalling)
  const basePolicy = {
    transportId: provider.transportId,
    endpointOptions: opts.endpointOptions,
    lookup: opts.lookup || probeLookupFor(provider),
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : (isGoProfile(provider) ? GO_PROBE_TIMEOUT_MS : undefined),
    signal: opts.signal,
  }
  if (opts.signal && opts.signal.aborted) {
    return { ok: false, checks, evidence: null, errors: [err('probe-cancelled', where, 'verification cancelled before it started')] }
  }
  function requestOpts(extra) {
    return Object.assign({}, basePolicy, { headers: Object.assign({ 'content-type': 'application/json' }, profileHeaders(provider), authHeaders(connection)) }, extra || {})
  }
  async function postCheck(name, payload, validate) {
    const started = Date.now()
    try {
      const out = await boundedJson(fetchImpl, joinUrl(provider.baseUrl, paths.text), requestOpts({ method: 'POST', body: JSON.stringify(payload) }))
      const ms = Date.now() - started
      if (out.status === 401 || out.status === 403) {
        checks.push({ name, ok: false, ms, detail: describeHttpFailure(httpFailureDiagnostic(out.status, connection, out)) })
        return { ok: false, fatal: true, out }
      }
      if (out.status < 200 || out.status >= 300) {
        checks.push({ name, ok: false, ms, detail: describeHttpFailure(httpFailureDiagnostic(out.status, connection, out)) })
        return { ok: false, fatal: false, out }
      }
      const verdict = validate(out.json)
      checks.push({ name, ok: verdict.ok, ms, detail: verdict.detail })
      const result = { ok: verdict.ok, fatal: false, out }
      if (verdict.callId) result.callId = verdict.callId
      return result
    } catch (e) {
      const item = e && e.code ? e : normalizeError(e, where + '.' + name)
      const limit = typeof basePolicy.timeoutMs === 'number' ? basePolicy.timeoutMs : DEFAULT_TIMEOUT_MS
      const phase = item.code !== 'probe-timeout' ? '' : (/stalled/.test(String(item.message)) ? ' [timed out while reading the response body]' : ' [timed out before any response headers]')
      checks.push({ name, ok: false, ms: Date.now() - started, detail: redact(item.message) + (item.code === 'probe-timeout' ? phase + ' (limit ' + limit + ' ms)' : '') })
      return { ok: false, fatal: item.code === 'probe-timeout', error: item }
    }
  }
  const conn = await testConnection(provider, connection, fetchImpl, opts)
  checks.push({ name: 'reachability-auth', ok: conn.ok && !!(conn.evidence && conn.evidence.authenticated), ms: (conn.evidence && conn.evidence.ms) || 0, detail: conn.ok ? 'reachable + authenticated' : redact((conn.errors[0] && conn.errors[0].message) || 'unreachable') })
  if (!conn.ok || !(conn.evidence && conn.evidence.authenticated)) {
    const errors = conn.errors.length > 0 ? conn.errors : [err('probe-auth-required', where, 'authenticated access was not proven; the route stays unverified')]
    return { ok: false, checks, evidence: null, errors }
  }
  if (opts.signal && opts.signal.aborted) {
    return { ok: false, checks, evidence: null, errors: [err('probe-cancelled', where, 'verification cancelled')] }
  }
  const levels = Array.isArray(route.reasoningLevels) ? route.reasoningLevels.slice() : []
  if (levels.length === 0) {
    return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'route declares no reasoning levels; nothing verifiable')] }
  }
  const levelsChecked = []
  for (const level of levels) {
    if (opts.signal && opts.signal.aborted) {
      return { ok: false, checks, evidence: null, errors: [err('probe-cancelled', where, 'verification cancelled')] }
    }
    const probe = await postCheck('text-completion (reasoning:' + level + ')', textPayload(provider.transportId, route.remoteModelId, level, provider), (json) => {
      const shaped = validateTextCompletion(provider.transportId, json)
      if (!shaped.ok) return shaped
      if (!findReasoningEvidence(json, level)) {
        return { ok: false, detail: 'completion is structurally valid but carries no acknowledgment of reasoning effort ' + JSON.stringify(level) + '; mapping stays unverified' }
      }
      return { ok: true, detail: shaped.detail + ' + reasoning effort ' + level + ' acknowledged' }
    })
    levelsChecked.push({ level, ok: probe.ok })
    if (!probe.ok && (probe.fatal || (probe.error && (probe.error.code === 'probe-cancelled' || probe.error.code === 'probe-timeout')))) {
      const cancelled = probe.error && probe.error.code === 'probe-cancelled'
      return { ok: false, checks, evidence: null, errors: [cancelled ? err('probe-cancelled', where, 'verification cancelled') : err('probe-failed', where, 'text probe failed for reasoning level ' + level + '; route stays unverified')] }
    }
  }
  const levelsVerified = levelsChecked.filter((e) => e.ok).map((e) => e.level)
  if (levelsVerified.length === 0) {
    return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'no advertised reasoning level verified; route stays unverified')] }
  }
  if (needsStreaming) {
    const started = Date.now()
    try {
      const streamPayload = Object.assign(textPayload(provider.transportId, route.remoteModelId, reasoning, provider), { stream: true })
      const out = await boundedSse(fetchImpl, joinUrl(provider.baseUrl, paths.text), requestOpts({ method: 'POST', body: JSON.stringify(streamPayload) }))
      const ms = Date.now() - started
      if (out.status === 401 || out.status === 403) {
        checks.push({ name: 'streaming', ok: false, ms, detail: describeHttpFailure(httpFailureDiagnostic(out.status, connection, out)) })
        return { ok: false, checks, evidence: null, errors: [err('probe-auth-failed', where, 'streaming probe was refused (HTTP ' + out.status + '); route stays unverified')] }
      }
      if (out.status < 200 || out.status >= 300) {
        checks.push({ name: 'streaming', ok: false, ms, detail: describeHttpFailure(httpFailureDiagnostic(out.status, connection, out)) })
        return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'streaming probe failed; route stays unverified')] }
      }
      const verdict = validateSseEvents(provider.transportId, out.events)
      checks.push({ name: 'streaming', ok: verdict.ok, ms, detail: verdict.detail })
      if (!verdict.ok) {
        return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'streaming probe failed; route stays unverified')] }
      }
    } catch (e) {
      const item = e && e.code ? e : normalizeError(e, where + '.streaming')
      checks.push({ name: 'streaming', ok: false, ms: Date.now() - started, detail: redact(item.message) })
      return { ok: false, checks, evidence: null, errors: [item.code === 'probe-cancelled' ? err('probe-cancelled', where, 'verification cancelled') : err('probe-failed', where, 'streaming probe failed; route stays unverified')] }
    }
  } else {
    checks.push({ name: 'streaming', ok: true, ms: 0, detail: 'not declared by model capabilities' })
  }
  if (needsTools) {
    const emission = await postCheck('tool-call-emission', toolPayload(provider.transportId, route.remoteModelId, provider), (json) => validateToolEmission(provider.transportId, json, 'probe_echo'))
    if (!emission.ok) {
      return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'tool-call emission probe failed; route stays unverified')] }
    }
    const continuation = await postCheck('tool-result-continuation', continuationPayload(provider.transportId, route.remoteModelId, emission.callId, provider, reasoning), (json) => validateContinuation(provider.transportId, json))
    if (!continuation.ok) {
      return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'tool-result continuation probe failed; route stays unverified')] }
    }
    const emitted = checks.find((c) => c.name === 'tool-call-emission')
    if (emitted) emitted.detail += ' (call id ' + emission.callId + ' reused for the continuation)'
  } else {
    checks.push({ name: 'tool-call-emission', ok: true, ms: 0, detail: 'not declared by model capabilities' })
    checks.push({ name: 'tool-result-continuation', ok: true, ms: 0, detail: 'not declared by model capabilities' })
  }
  const bearer = presentedBearer(connection)
  const authReq = authRequirement(connection)
  const evidence = {
    kind: 'capability-verification',
    contractVersion: PROBE_CONTRACT_VERSION,
    routeId: route.id,
    providerId: provider.id,
    transport: provider.transportId,
    reasoning: reasoning,
    levelsChecked: levelsChecked.map((e) => ({ level: e.level, ok: e.ok })),
    levelsVerified: levelsVerified.slice(),
    streamingRequired: needsStreaming,
    toolsRequired: needsTools,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, ms: c.ms, detail: redact(c.detail) })),
    verifiedAtUtc: new Date().toISOString(),
    credentialPresented: !!bearer,
    authRequired: authReq.required,
    fingerprint: fingerprintOf(fingerprintInputOf({ provider, model, route, connection, verifiedLevels: levelsVerified })),
    note: 'synthetic bounded probes only; no user workspace content was transmitted',
  }
  return { ok: true, checks, evidence, errors: [] }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  GO_PROBE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_PROBE_INFLIGHT,
  PROBE_CONTRACT_VERSION,
  redact,
  normalizeError,
  testConnection,
  discoverModels,
  verifyRoute,
  transportPaths,
  authRequirement,
  fingerprintInputOf,
  fingerprintOf,
}

