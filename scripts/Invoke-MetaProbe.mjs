#!/usr/bin/env node
/**
 * Invoke-MetaProbe.mjs — Phase M2 provider capability probe for the Meta
 * Model API (Muse Spark) transport.
 *
 * BOUNDARY CONTRACT (see docs/architecture/nexus-profiles.md, Phase M2):
 *   - This module is TRANSPORT VALIDATION ONLY. It proves that the provider
 *     configuration resolved from settings.yaml (llm-pi-ai.providers route +
 *     the protected credential store) can carry one bounded OpenAI-compatible
 *     round trip: plain text, streaming deltas, a tool call, a mapped
 *     reasoning effort, and normalized errors.
 *   - It is NOT the Muse agent loop and never becomes one: no tools are
 *     executed, no history is assembled, no task ledger is touched, and no
 *     completion authority exists here. Muse execution stays disabled until
 *     the M3 agent plane.
 *   - The production Muse execution path (M3+) rides the DSH provider
 *     substrate (dsh-llm-pi-ai over the same settings.yaml route). This probe
 *     validates that route's wire contract — chat/completions, Bearer auth,
 *     reasoning_effort, stream_options.include_usage, tools[].function —
 *     using the provider truth from configuration, never a hardcoded URL.
 *   - The API key is read from the environment ONLY (the PowerShell plane
 *     injects it from data/.credentials.yaml). It is never persisted, never
 *     logged, and is redacted from every error string.
 *   - Mock seams: request.mockFile substitutes the HTTP round-trip with a
 *     canned response ({status, body} — body.resulting echoes the request
 *     body when echoRequest is true); request.mockStreamFile substitutes the
 *     streaming SSE body with a canned array of raw SSE event strings. Both
 *     exist for deterministic OFFLINE tests; production probes never set them.
 *
 * CLI: node Invoke-MetaProbe.mjs --request <request.json>
 * Exit codes: 0 probe outcome obtained (ok true or false — the outcome IS the
 *             finding) · 3 unexpected internal transport failure · 4 bad
 *             request shape.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hard default bound for probe requests; a request may lower it. */
const DEFAULT_TIMEOUT_MS = 60000

function errorOutcome(errorKind, error) {
  return { ok: false, errorKind, error: String(error == null ? '' : error) }
}

/**
 * Redact the actual key material from any surfaced text. Errors must never
 * carry the credential (defense in depth: a provider error body that echoes
 * the Authorization value is scrubbed before it reaches an outcome).
 */
export function redactSecrets(text, secret) {
  let out = String(text == null ? '' : text)
  if (secret && secret.length >= 4) out = out.split(secret).join('<redacted>')
  return out
}

/** Validate the probe request shape; returns an error string or null. */
export function validateRequest(request) {
  if (!request || typeof request !== 'object') return 'probe request must be an object'
  if (typeof request.baseUrl !== 'string' || !/^https?:\/\//i.test(request.baseUrl)) return 'request.baseUrl must be an http(s) URL'
  if (typeof request.model !== 'string' || request.model.trim() === '') return 'request.model is required'
  if (typeof request.apiKeyEnv !== 'string' || request.apiKeyEnv.trim() === '') return 'request.apiKeyEnv is required'
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') return 'request.prompt is required'
  if (request.tools != null && !Array.isArray(request.tools)) return 'request.tools must be an array when present'
  if (request.toolChoice != null && request.toolChoice !== 'auto') {
    // The direct Meta Model API accepts only tool_choice "auto" (official
    // tool-calling recipe); anything else is rejected with HTTP 400, so the
    // probe refuses it before the wire.
    return 'request.toolChoice supports only "auto" on the Meta Model API'
  }
  if (request.reasoningEffort != null && typeof request.reasoningEffort !== 'string') return 'request.reasoningEffort must be a string or null'
  if (request.maxCompletionTokens != null && (!Number.isInteger(request.maxCompletionTokens) || request.maxCompletionTokens <= 0)) return 'request.maxCompletionTokens must be a positive integer or null'
  if (request.mockFile != null && typeof request.mockFile !== 'string') return 'request.mockFile must be a string path or null'
  if (request.mockStreamFile != null && typeof request.mockStreamFile !== 'string') return 'request.mockStreamFile must be a string path or null'
  if (request.stream != null && typeof request.stream !== 'boolean') return 'request.stream must be a boolean or null'
  return null
}

/** Build the OpenAI-compatible chat-completions body for one probe. */
export function buildRequestBody(request) {
  const body = {
    model: String(request.model),
    messages: [
      { role: 'system', content: String(request.systemPrompt || 'You are a transport probe. Follow the user instruction exactly.') },
      { role: 'user', content: String(request.prompt) },
    ],
  }
  if (request.stream === true) {
    body.stream = true
    // Official streaming contract: usage arrives on a final chunk only when
    // stream_options.include_usage is set.
    body.stream_options = { include_usage: true }
  }
  // reasoning_effort carries the NATIVE wire value already mapped by the
  // provider boundary (Nexus level -> native mapping lives in settings.yaml
  // reasoningEfforts). An empty string (Nexus "off") omits the field.
  if (typeof request.reasoningEffort === 'string' && request.reasoningEffort.trim() !== '') {
    body.reasoning_effort = request.reasoningEffort.trim()
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools
    if (request.toolChoice === 'auto') body.tool_choice = 'auto'
  }
  if (Number.isInteger(request.maxCompletionTokens) && request.maxCompletionTokens > 0) {
    // Canonical Meta output-cap field (official docs; max_tokens is only a
    // deprecated alias).
    body.max_completion_tokens = request.maxCompletionTokens
  }
  return body
}

/** Extract the assistant text from a non-streaming response body. */
export function extractContent(body) {
  if (!body || typeof body !== 'object') return null
  const choices = Array.isArray(body.choices) ? body.choices : []
  const first = choices.length > 0 ? choices[0] : null
  const message = first && typeof first.message === 'object' && first.message !== null ? first.message : null
  return message && typeof message.content === 'string' ? message.content : null
}

/** Normalize tool_calls from a message into [{id, name, arguments}]. */
export function extractToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) return null
  const calls = []
  for (const call of message.tool_calls) {
    if (!call || typeof call !== 'object') continue
    const fn = typeof call.function === 'object' && call.function !== null ? call.function : {}
    calls.push({
      id: call.id == null ? null : String(call.id),
      name: fn.name == null ? null : String(fn.name),
      arguments: fn.arguments == null ? null : String(fn.arguments),
    })
  }
  return calls
}

/** Extract reasoning token usage when the provider exposes it. */
export function extractUsage(body) {
  if (!body || typeof body !== 'object' || !body.usage || typeof body.usage !== 'object') return null
  const usage = body.usage
  const details = typeof usage.completion_tokens_details === 'object' && usage.completion_tokens_details !== null
    ? usage.completion_tokens_details
    : null
  return {
    promptTokens: usage.prompt_tokens == null ? null : Number(usage.prompt_tokens),
    completionTokens: usage.completion_tokens == null ? null : Number(usage.completion_tokens),
    totalTokens: usage.total_tokens == null ? null : Number(usage.total_tokens),
    reasoningTokens: details && details.reasoning_tokens != null ? Number(details.reasoning_tokens) : null,
  }
}

/**
 * One SSE event block -> normalized probe facts, or { error } for a
 * malformed block. Tolerates keep-alive comment lines and empty choices
 * (usage-only final chunk), exactly like the official streaming recipe.
 */
export function parseSseBlock(block) {
  const facts = { content: null, toolCallDeltas: null, finishReason: null, usage: null }
  let sawData = false
  for (const rawLine of String(block).split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line === '' || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    const data = line.replace(/^data:\s?/, '')
    sawData = true
    if (data === '[DONE]') { facts.done = true; continue }
    let chunk
    try { chunk = JSON.parse(data) } catch { return { error: 'stream-malformed', detail: 'SSE data line is not valid JSON: ' + data.slice(0, 120) } }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const first = choices.length > 0 ? choices[0] : null
    const delta = first && typeof first.delta === 'object' && first.delta !== null ? first.delta : {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      facts.content = (facts.content || '') + delta.content
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      facts.toolCallDeltas = (facts.toolCallDeltas || []).concat(delta.tool_calls)
    }
    if (first && first.finish_reason != null) facts.finishReason = String(first.finish_reason)
    if (chunk.usage) facts.usage = chunk.usage
  }
  if (!sawData) return facts
  return facts
}

/** Read a UTF-8 text file tolerating a BOM (PowerShell writers emit one). */
function readUtf8Text(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
}

/** Assemble accumulated streaming tool-call deltas into complete calls. */
function assembleStreamToolCalls(deltas) {
  if (!deltas || deltas.length === 0) return null
  const byIndex = new Map()
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : 0
    if (!byIndex.has(index)) byIndex.set(index, { id: null, name: '', arguments: '' })
    const call = byIndex.get(index)
    if (delta.id != null) call.id = String(delta.id)
    const fn = typeof delta.function === 'object' && delta.function !== null ? delta.function : {}
    if (fn.name) call.name += String(fn.name)
    if (fn.arguments) call.arguments += String(fn.arguments)
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({
    id: call.id,
    name: call.name === '' ? null : call.name,
    arguments: call.arguments === '' ? null : call.arguments,
  }))
}

/** Non-streaming probe outcome from a canned mock document. */
function mockOutcomeFor(mockDoc, request, secret) {
  const status = Number(mockDoc && mockDoc.status)
  const body = mockDoc ? mockDoc.body : undefined
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const raw = body && typeof body === 'object' && body.error && body.error.message
      ? String(body.error.message)
      : 'mock provider error (status ' + String(mockDoc && mockDoc.status) + ')'
    const outcome = errorOutcome('provider-error', redactSecrets(raw, secret))
    outcome.status = Number.isInteger(status) ? status : null
    return outcome
  }
  const content = extractContent(body)
  const message = body && Array.isArray(body.choices) && body.choices[0] ? body.choices[0].message : null
  const toolCalls = extractToolCalls(message)
  if (content == null && toolCalls == null) {
    const outcome = errorOutcome('provider-response-shape', 'provider returned no assistant content and no tool calls')
    outcome.status = status
    return outcome
  }
  const outcome = {
    ok: true,
    mode: toolCalls != null ? 'tool' : 'text',
    model: body && typeof body.model === 'string' ? body.model : String(request.model),
    content,
    toolCalls,
    finishReason: body && Array.isArray(body.choices) && body.choices[0] && body.choices[0].finish_reason != null
      ? String(body.choices[0].finish_reason)
      : null,
    usage: extractUsage(body),
    status,
  }
  // Deterministic contract evidence: echo the exact request body the probe
  // built so offline tests can assert the wire fields (reasoning_effort,
  // tools, stream_options) without network access.
  if (mockDoc.echoRequest === true) outcome.resulting = mockDoc.resulting !== undefined ? mockDoc.resulting : body
  return outcome
}

/** Streaming probe outcome from a canned SSE fixture (array of blocks). */
function mockStreamOutcomeFor(blocks, request) {
  const result = consumeSseBlocks(Array.isArray(blocks) ? blocks : [])
  return finalizeStreamOutcome(result, request, null, Date.now())
}

/** Consume raw SSE event blocks into accumulated probe facts. */
function consumeSseBlocks(blocks) {
  const result = { content: '', toolCallDeltas: [], finishReason: null, usage: null, done: false, error: null, detail: null, ttftMs: null }
  const consumeStart = Date.now()
  for (const block of blocks) {
    const facts = parseSseBlock(block)
    if (facts.error) {
      result.error = facts.error
      result.detail = facts.detail
      break
    }
    if (facts.content) {
      if (result.ttftMs == null) result.ttftMs = Date.now() - consumeStart
      result.content += facts.content
    }
    if (facts.toolCallDeltas) result.toolCallDeltas = result.toolCallDeltas.concat(facts.toolCallDeltas)
    if (facts.finishReason) result.finishReason = facts.finishReason
    if (facts.usage) result.usage = facts.usage
    if (facts.done) { result.done = true; break }
  }
  return result
}

function finalizeStreamOutcome(result, request, secret, startedAt) {
  if (result.error) {
    const outcome = errorOutcome(result.error, redactSecrets(result.detail || 'malformed streaming chunk', secret))
    outcome.content = result.content
    outcome.interrupted = true
    outcome.durationMs = Date.now() - startedAt
    return outcome
  }
  // Interrupted stream: ended without [DONE] and without a finish_reason.
  // Fail closed but keep the partial text for diagnostics.
  if (!result.done && result.finishReason == null) {
    const outcome = errorOutcome('stream-interrupted', 'stream ended before [DONE] and before a finish_reason was observed')
    outcome.content = result.content
    outcome.interrupted = true
    outcome.durationMs = Date.now() - startedAt
    return outcome
  }
  const toolCalls = assembleStreamToolCalls(result.toolCallDeltas)
  const outcome = {
    ok: true,
    mode: toolCalls != null ? 'stream-tool' : 'stream',
    model: String(request.model),
    content: result.content,
    toolCalls,
    finishReason: result.finishReason,
    usage: result.usage ? extractUsage({ usage: result.usage }) : null,
    interrupted: false,
    durationMs: Date.now() - startedAt,
  }
  if (result.ttftMs != null) outcome.ttftMs = result.ttftMs
  return outcome
}

async function streamLiveResponse(response, request, secret, startedAt) {
  const blocks = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let timedOut = false
  const deadline = setTimeout(() => { timedOut = true; try { reader.cancel() } catch { /* already closed */ } }, DEFAULT_TIMEOUT_MS)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf('\n\n')
      while (separator >= 0) {
        blocks.push(buffer.slice(0, separator))
        buffer = buffer.slice(separator + 2)
        separator = buffer.indexOf('\n\n')
      }
      if (timedOut) break
    }
  } catch (error) {
    clearTimeout(deadline)
    const outcome = errorOutcome(timedOut ? 'timeout' : 'stream-interrupted', redactSecrets('stream read failed: ' + String(error && error.message), secret))
    const partial = consumeSseBlocks(blocks)
    outcome.content = partial.content
    outcome.interrupted = true
    outcome.durationMs = Date.now() - startedAt
    return outcome
  }
  clearTimeout(deadline)
  if (buffer.trim() !== '') blocks.push(buffer)
  if (timedOut) {
    const outcome = errorOutcome('timeout', 'stream exceeded the probe timeout before completing')
    const partial = consumeSseBlocks(blocks)
    outcome.content = partial.content
    outcome.interrupted = true
    outcome.durationMs = Date.now() - startedAt
    return outcome
  }
  const result = consumeSseBlocks(blocks)
  return finalizeStreamOutcome(result, request, secret, startedAt)
}

/** One probe round trip. Returns the transport outcome. */
export async function runProbe(request) {
  const invalid = validateRequest(request)
  if (invalid) return { exitCode: 4, outcome: errorOutcome('bad-request', invalid) }

  const apiKeyEnv = String(request.apiKeyEnv)
  const secret = typeof process.env[apiKeyEnv] === 'string' ? process.env[apiKeyEnv].trim() : ''
  const startedAt = Date.now()

  // Credentials detected is a probe FINDING, not a crash: the probe outcome
  // reports it and the orchestrator classifies (a missing Meta key means the
  // Muse provider is unavailable, never a broken Nexus installation).
  if (secret === '') {
    const outcome = errorOutcome('missing-api-key', 'credentials not detected: environment variable ' + apiKeyEnv + ' is not set')
    outcome.durationMs = Date.now() - startedAt
    return { exitCode: 0, outcome }
  }

  const body = buildRequestBody(request)

  let mockDoc = null
  if (request.mockFile) {
    try { mockDoc = JSON.parse(readUtf8Text(request.mockFile)) } catch (error) {
      return { exitCode: 3, outcome: errorOutcome('mock-unreadable', 'mock response file is unreadable or invalid JSON: ' + String(error && error.message)) }
    }
  }
  if (request.mockStreamFile) {
    let blocks = null
    try { blocks = JSON.parse(readUtf8Text(request.mockStreamFile)) } catch (error) {
      return { exitCode: 3, outcome: errorOutcome('mock-unreadable', 'mock stream file is unreadable or invalid JSON: ' + String(error && error.message)) }
    }
    const outcome = mockStreamOutcomeFor(blocks, request)
    return { exitCode: 0, outcome }
  }
  if (mockDoc != null) {
    // Mocked non-stream round trip: record the exact wire body for contract
    // evidence, then classify the canned response.
    if (mockDoc.echoRequest === true) mockDoc.resulting = body
    const outcome = mockOutcomeFor(mockDoc, request, secret)
    outcome.durationMs = Date.now() - startedAt
    return { exitCode: 0, outcome }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TIMEOUT_MS)
  let response
  try {
    const base = request.baseUrl.endsWith('/') ? request.baseUrl : request.baseUrl + '/'
    response = await fetch(new URL('chat/completions', base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + secret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const aborted = error && (error.name === 'AbortError' || String(error && error.message).includes('abort'))
    const outcome = errorOutcome(aborted ? 'timeout' : 'transport-error', redactSecrets('provider request failed: ' + String(error && error.message), secret))
    outcome.status = null
    outcome.durationMs = Date.now() - startedAt
    return { exitCode: 0, outcome }
  }
  if (request.stream === true && response.ok && response.body) {
    clearTimeout(timer)
    const outcome = await streamLiveResponse(response, request, secret, startedAt)
    return { exitCode: 0, outcome }
  }
  const responseText = await response.text()
  clearTimeout(timer)
  let responseBody = null
  try { responseBody = responseText ? JSON.parse(responseText) : null } catch { responseBody = null }
  if (!response.ok) {
    const raw = responseBody && responseBody.error && responseBody.error.message
      ? String(responseBody.error.message)
      : (responseText || 'HTTP ' + response.status).slice(0, 500)
    const outcome = errorOutcome('provider-error', redactSecrets('provider returned HTTP ' + response.status + ': ' + raw, secret))
    outcome.status = response.status
    outcome.durationMs = Date.now() - startedAt
    return { exitCode: 0, outcome }
  }
  const message = responseBody && Array.isArray(responseBody.choices) && responseBody.choices[0] ? responseBody.choices[0].message : null
  const toolCalls = extractToolCalls(message)
  const content = extractContent(responseBody)
  if (content == null && toolCalls == null) {
    const outcome = errorOutcome('provider-response-shape', 'provider returned no assistant content and no tool calls')
    outcome.status = response.status
    outcome.durationMs = Date.now() - startedAt
    return { exitCode: 0, outcome }
  }
  const outcome = {
    ok: true,
    mode: toolCalls != null ? 'tool' : 'text',
    model: responseBody && typeof responseBody.model === 'string' ? responseBody.model : String(request.model),
    content,
    toolCalls,
    finishReason: responseBody && Array.isArray(responseBody.choices) && responseBody.choices[0] && responseBody.choices[0].finish_reason != null
      ? String(responseBody.choices[0].finish_reason)
      : null,
    usage: extractUsage(responseBody),
    status: response.status,
    durationMs: Date.now() - startedAt,
  }
  return { exitCode: 0, outcome }
}

function main() {
  const argv = process.argv.slice(2)
  let requestPath = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--request' && argv[i + 1]) requestPath = argv[i + 1]
  }
  if (!requestPath) {
    process.stdout.write(JSON.stringify(errorOutcome('bad-request', 'usage: node Invoke-MetaProbe.mjs --request <request.json>')) + '\n')
    process.exit(4)
  }
  let request
  try {
    request = JSON.parse(readUtf8Text(requestPath))
  } catch (error) {
    process.stdout.write(JSON.stringify(errorOutcome('bad-request', 'probe request file is unreadable or invalid JSON: ' + String(error && error.message))) + '\n')
    process.exit(4)
  }
  runProbe(request).then((result) => {
    process.stdout.write(JSON.stringify(result.outcome) + '\n')
    process.exit(result.exitCode)
  }).catch((error) => {
    process.stdout.write(JSON.stringify(errorOutcome('transport-error', redactSecrets(String(error && error.message), null))) + '\n')
    process.exit(3)
  })
}

const invokedDirectly = process.argv[1] && (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) } catch { return false }
})()
if (invokedDirectly) main()
