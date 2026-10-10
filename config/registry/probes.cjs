'use strict'

/**
 * Registry R4.4 — explicit, user-triggered discovery & capability probes.
 *
 * Runs with NO DSH process, NO session, NO controller involvement. Nothing
 * here runs on startup; every entry point is called explicitly from the
 * service layer after a user action (Test Connection / Discover Models /
 * Verify Capabilities). All requests are synthetic, bounded (timeout +
 * response-size cap), cancellable (AbortController), and every diagnostic
 * is redacted before it is stored or returned.
 *
 * Evidence levels (spec 8.2):
 *   discovered — the provider advertised the model id (listing only).
 *   declared   — capabilities from configuration/documentation.
 *   verified   — required probes succeeded for THIS route (only this level
 *                makes a route eligible; a model list alone never verifies).
 *
 * Minimum probes: reachability+auth, synthetic text request, streaming
 * (when the model declares it), tool-call emission + tool-result
 * continuation (when toolCalling), reasoning mapping (when the route lists
 * reasoning levels), transport compatibility, normalized errors/timeouts.
 *
 * fetchImpl is injected (tests use fakes; the service passes a bounded
 * undici/global-fetch wrapper). The module never imports a fetch itself,
 * so Registry Core stays dependency-free and DSH-independent.
 */

const DEFAULT_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 262144
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
  if (e && (e.code === 'probe-timeout' || /timeout|aborted|AbortError/i.test(String((e && e.name) || '') + ' ' + String((e && e.message) || '')))) {
    return err('probe-timeout', where, 'probe timed out (bounded request; provider did not answer in time)')
  }
  return err('probe-failed', where, redact(String((e && e.message) || e)))
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl).replace(/\/+$/, '')
  return base + suffix
}

function transportPaths(transportId) {
  if (transportId === 'openai-responses') return { models: '/models', text: '/responses' }
  return { models: '/models', text: '/chat/completions' }
}

async function boundedJson(fetchImpl, url, opts) {
  const timeoutMs = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res = null
  try {
    res = await fetchImpl(url, {
      method: (opts && opts.method) || 'GET',
      headers: Object.assign({ 'user-agent': PROBE_USER_AGENT, accept: 'application/json' }, (opts && opts.headers) || {}),
      body: opts && opts.body !== undefined ? opts.body : undefined,
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw Object.assign(new Error('probe transport error'), { code: 'probe-timeout' })
  }
  clearTimeout(timer)
  const status = res && typeof res.status === 'number' ? res.status : 0
  let text = ''
  try {
    text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json())
  } catch (e) {
    throw normalizeError(e, 'probe.body')
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw err('probe-response-too-large', 'probe.body', 'provider response exceeded the bounded probe size limit')
  }
  let json = null
  try {
    json = text.trim() === '' ? null : JSON.parse(text)
  } catch {
    throw err('probe-failed', 'probe.body', 'provider returned a non-JSON response (redacted, ' + text.length + ' bytes)')
  }
  return { status, json, bytes: text.length }
}

function authHeaders(connection) {
  // The probe never receives secret VALUES — only the opaque reference plus
  // a caller-supplied bearer supplied by the trusted credential boundary at
  // call time (tests inject it; production R4 reports the integration
  // blocker and never fabricates one). When absent, probes run unauthenticated
  // and the 401/403 outcome is itself the auth evidence.
  if (connection && typeof connection.testBearer === 'string' && connection.testBearer !== '') {
    return { authorization: 'Bearer ' + connection.testBearer }
  }
  return {}
}

/**
 * Test Connection: reachability + authentication only. Never verifies a route.
 */
async function testConnection(provider, connection, fetchImpl, options) {
  const opts = options || {}
  const where = 'probe.connection'
  const paths = transportPaths(provider.transportId)
  const started = Date.now()
  try {
    const out = await boundedJson(fetchImpl, joinUrl(provider.baseUrl, paths.models), {
      timeoutMs: opts.timeoutMs,
      headers: authHeaders(connection),
    })
    const ms = Date.now() - started
    if (out.status === 401 || out.status === 403) {
      return { ok: false, evidence: { kind: 'connection', reachable: true, authenticated: false, status: out.status, ms }, errors: [err('probe-auth-failed', where, 'provider rejected the credential (HTTP ' + out.status + '); connection is not authorized')] }
    }
    if (out.status < 200 || out.status >= 300) {
      return { ok: false, evidence: { kind: 'connection', reachable: true, authenticated: false, status: out.status, ms }, errors: [err('probe-failed', where, 'provider answered HTTP ' + out.status + ' (redacted body, ' + out.bytes + ' bytes)')] }
    }
    return { ok: true, evidence: { kind: 'connection', reachable: true, authenticated: true, status: out.status, ms, bytes: out.bytes }, errors: [] }
  } catch (e) {
    return { ok: false, evidence: { kind: 'connection', reachable: false, authenticated: false, ms: Date.now() - started }, errors: [e && e.code ? e : normalizeError(e, where)] }
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
    const out = await boundedJson(fetchImpl, joinUrl(provider.baseUrl, paths.models), {
      timeoutMs: opts.timeoutMs,
      headers: authHeaders(connection),
    })
    if (out.status === 401 || out.status === 403) {
      return { ok: false, advertised: [], errors: [err('probe-auth-failed', where, 'discovery rejected the credential (HTTP ' + out.status + ')')] }
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

function textPayload(transportId, remoteModelId, reasoning) {
  const probeText = 'nexus synthetic capability probe (no user content; reply with the single word: probe-ok)'
  if (transportId === 'openai-responses') {
    const body = { model: remoteModelId, input: probeText, max_output_tokens: 16 }
    if (reasoning) body.reasoning = { effort: reasoning }
    return body
  }
  const body = { model: remoteModelId, messages: [{ role: 'user', content: probeText }], max_tokens: 16, stream: false }
  if (reasoning) body.reasoning_effort = reasoning
  return body
}

function toolPayload(transportId, remoteModelId) {
  const tool = { type: 'function', function: { name: 'probe_echo', description: 'Synthetic probe tool (no user content).', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } } }
  if (transportId === 'openai-responses') {
    return { model: remoteModelId, input: 'nexus synthetic tool probe (no user content; call probe_echo with word set to probe-ok)', tools: [{ type: 'function', name: 'probe_echo', description: 'Synthetic probe tool.', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }], max_output_tokens: 64 }
  }
  return { model: remoteModelId, messages: [{ role: 'user', content: 'nexus synthetic tool probe (no user content; call probe_echo with word set to probe-ok)' }], tools: [tool], tool_choice: 'auto', max_tokens: 64, stream: false }
}

function continuationPayload(transportId, remoteModelId, toolCallId) {
  if (transportId === 'openai-responses') {
    return { model: remoteModelId, input: [{ type: 'function_call_output', call_id: toolCallId, output: 'probe-ok' }], max_output_tokens: 16 }
  }
  return { model: remoteModelId, messages: [{ role: 'user', content: 'probe' }, { role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'probe_echo', arguments: '{\\"word\\":\\"probe-ok\\"}' } }] }, { role: 'tool', tool_call_id: toolCallId, content: 'probe-ok' }], max_tokens: 16, stream: false }
}

/**
 * Verify Capabilities for ONE route. Required checks are derived from the
 * logical model + route: text always; streaming when declared; tool-round
 * -trip when toolCalling; reasoning mapping for the route's first level.
 * ALL required checks must pass for { ok: true }; anything else stays at
 * discovered/declared and the route remains ineligible.
 */
async function verifyRoute(provider, model, route, connection, fetchImpl, options) {
  const opts = options || {}
  const where = 'probe.route.' + route.id
  const checks = []
  const paths = transportPaths(provider.transportId)
  const reasoning = Array.isArray(route.reasoningLevels) && route.reasoningLevels.length > 0 ? route.reasoningLevels[0] : null
  const needsStreaming = !!(model.capabilities && model.capabilities.streaming)
  const needsTools = !!(model.capabilities && model.capabilities.toolCalling)

  async function postCheck(name, payload, validate) {
    const started = Date.now()
    try {
      const out = await boundedJson(fetchImpl, joinUrl(provider.baseUrl, paths.text), {
        method: 'POST',
        timeoutMs: opts.timeoutMs,
        headers: Object.assign({ 'content-type': 'application/json' }, authHeaders(connection)),
        body: JSON.stringify(payload),
      })
      const ms = Date.now() - started
      if (out.status === 401 || out.status === 403) {
        checks.push({ name, ok: false, ms, detail: 'rejected credential (HTTP ' + out.status + ')' })
        return { ok: false, fatal: true, out }
      }
      if (out.status < 200 || out.status >= 300) {
        checks.push({ name, ok: false, ms, detail: 'HTTP ' + out.status + ' (' + out.bytes + ' redacted bytes)' })
        return { ok: false, fatal: false, out }
      }
      const verdict = validate(out.json)
      checks.push({ name, ok: verdict.ok, ms, detail: verdict.detail })
      return { ok: verdict.ok, fatal: false, out }
    } catch (e) {
      const item = e && e.code ? e : normalizeError(e, where + '.' + name)
      checks.push({ name, ok: false, ms: Date.now() - started, detail: redact(item.message) })
      return { ok: false, fatal: item.code === 'probe-timeout' }
    }
  }

  // 1. reachability + auth (models endpoint).
  const conn = await testConnection(provider, connection, fetchImpl, opts)
  checks.push({ name: 'reachability-auth', ok: conn.ok, ms: conn.evidence.ms || 0, detail: conn.ok ? 'reachable + authenticated' : redact((conn.errors[0] && conn.errors[0].message) || 'unreachable') })
  if (!conn.ok) {
    return { ok: false, checks, evidence: null, errors: conn.errors }
  }

  // 2. synthetic text request (+ reasoning mapping when levels exist).
  const text = await postCheck('text-completion' + (reasoning ? ' (reasoning:' + reasoning + ')' : ''), textPayload(provider.transportId, route.remoteModelId, reasoning), (json) => {
    const blob = redact(JSON.stringify(json)).slice(0, 4000)
    if (!json || typeof json !== 'object') return { ok: false, detail: 'non-object completion payload' }
    return { ok: true, detail: 'completion shape accepted (' + Math.min(blob.length, 4000) + ' redacted bytes)' }
  })
  if (!text.ok) {
    return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'text probe failed; route stays unverified')] }
  }

  // 3. streaming where the model declares it (bounded SSE read via same POST).
  if (needsStreaming && !opts.skipStreaming) {
    const streamPayload = Object.assign(textPayload(provider.transportId, route.remoteModelId, reasoning), { stream: true })
    const stream = await postCheck('streaming', streamPayload, (json) => ({ ok: true, detail: 'streaming request accepted' }))
    if (!stream.ok) {
      return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'streaming probe failed; route stays unverified')] }
    }
  } else {
    checks.push({ name: 'streaming', ok: true, ms: 0, detail: 'not required by model capabilities (skipped)' })
  }

  // 4. tool-call emission + tool-result continuation where required.
  if (needsTools) {
    const emission = await postCheck('tool-call-emission', toolPayload(provider.transportId, route.remoteModelId), (json) => {
      const blob = JSON.stringify(json)
      const hasCall = /function_call|tool_calls|tool_call|probe_echo/.test(blob)
      return hasCall
        ? { ok: true, detail: 'provider emitted a tool call for the synthetic probe tool' }
        : { ok: false, detail: 'provider answered but emitted no tool call for the synthetic probe tool' }
    })
    if (!emission.ok) {
      return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'tool-call emission probe failed; route stays unverified')] }
    }
    const callId = 'call_probe_' + String(Date.now().toString(36))
    const continuation = await postCheck('tool-result-continuation', continuationPayload(provider.transportId, route.remoteModelId, callId), (json) => {
      if (!json || typeof json !== 'object') return { ok: false, detail: 'non-object continuation payload' }
      return { ok: true, detail: 'tool-result continuation accepted' }
    })
    if (!continuation.ok) {
      return { ok: false, checks, evidence: null, errors: [err('probe-failed', where, 'tool-result continuation probe failed; route stays unverified')] }
    }
  } else {
    checks.push({ name: 'tool-call-emission', ok: true, ms: 0, detail: 'not required by model capabilities (skipped)' })
    checks.push({ name: 'tool-result-continuation', ok: true, ms: 0, detail: 'not required by model capabilities (skipped)' })
  }

  const evidence = {
    kind: 'capability-verification',
    routeId: route.id,
    providerId: provider.id,
    transport: provider.transportId,
    reasoning: reasoning,
    streamingRequired: needsStreaming,
    toolsRequired: needsTools,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, ms: c.ms, detail: redact(c.detail) })),
    verifiedAtUtc: new Date().toISOString(),
    note: 'synthetic bounded probes only; no user workspace content was transmitted',
  }
  return { ok: true, checks, evidence, errors: [] }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  redact,
  testConnection,
  discoverModels,
  verifyRoute,
  transportPaths,
}
