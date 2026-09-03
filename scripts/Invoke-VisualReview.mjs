#!/usr/bin/env node
/**
 * Invoke-VisualReview.mjs — the generic OpenAI-compatible multimodal transport
 * for the Nexus Visual Review Service (Phase V0/V1).
 *
 * BOUNDARY CONTRACT (see docs/architecture/visual-review.md):
 *   - This module is TRANSPORT ONLY. It reads the transport request file,
 *     reads the declared local images, encodes them as base64 data URLs and
 *     sends ONE text+image chat-completions request to the resolved provider.
 *   - It NEVER writes project files, NEVER executes tools, NEVER touches the
 *     task ledger, and NEVER gains completion authority. The API key is read
 *     from the environment (never from the request file, never persisted).
 *   - It returns a strict JSON transport outcome on stdout:
 *       { ok: true,  model, content, review|null, usage }
 *       { ok: false, errorKind, error }
 *     Review SEMANTICS (schema validation, verdict/score/dimensions contract)
 *     are owned by the controller plane (scripts/VisualReview.ps1).
 *   - Mock seam: request.mockFile substitutes the HTTP round-trip with a
 *     canned response ({ "status": n, "body": ... }) for deterministic tests.
 *     Production requests never set it.
 *
 * CLI: node Invoke-VisualReview.mjs --request <request.json>
 * Exit codes: 0 transport outcome obtained (ok true or false) · 3 transport
 *             outcome is a provider/transport failure · 4 bad request shape.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Hard transport cap: a single image may never exceed 10 MB encoded. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function errorOutcome(errorKind, error) {
  return { ok: false, errorKind, error: String(error == null ? '' : error) }
}

/** Encode one image buffer as an OpenAI-compatible base64 data URL. */
export function buildDataUrl(buffer, mediaType) {
  return 'data:' + mediaType + ';base64,' + Buffer.from(buffer).toString('base64')
}

/** Resolve the media type from the file extension; null when unsupported. */
export function mediaTypeOf(imagePath) {
  const ext = path.extname(String(imagePath || '')).toLowerCase()
  return Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, ext) ? IMAGE_MEDIA_TYPES[ext] : null
}

/** Validate the transport request shape; returns an error string or null. */
export function validateRequest(request) {
  if (!request || typeof request !== 'object') return 'transport request must be an object'
  if (typeof request.baseUrl !== 'string' || !/^https?:\/\//i.test(request.baseUrl)) return 'request.baseUrl must be an http(s) URL'
  if (typeof request.model !== 'string' || request.model.trim() === '') return 'request.model is required'
  if (typeof request.userText !== 'string' || request.userText.trim() === '') return 'request.userText is required'
  const apiKeyEnv = typeof request.apiKeyEnv === 'string' && request.apiKeyEnv !== '' ? request.apiKeyEnv : 'DEEPSEEK_API_KEY'
  if (typeof process.env[apiKeyEnv] !== 'string' || process.env[apiKeyEnv].trim() === '') {
    return 'missing API key: environment variable ' + apiKeyEnv + ' is not set'
  }
  if (!Array.isArray(request.images) || request.images.length === 0) return 'request.images must contain at least one image'
  for (const image of request.images) {
    if (!image || typeof image !== 'object') return 'request.images entries must be objects'
    if (typeof image.path !== 'string' || image.path.trim() === '') return 'request.images entry is missing path'
    if (mediaTypeOf(image.path) === null) return 'unsupported image type (png/jpg/jpeg/webp/gif only): ' + image.path
  }
  if (request.mockFile != null && typeof request.mockFile !== 'string') return 'request.mockFile must be a string path or null'
  return null
}

/** Extract the assistant text from an OpenAI-compatible response body. */
export function extractContent(body) {
  if (!body || typeof body !== 'object') return null
  const choices = Array.isArray(body.choices) ? body.choices : []
  const first = choices.length > 0 ? choices[0] : null
  const message = first && typeof first.message === 'object' && first.message !== null ? first.message : null
  if (message && typeof message.content === 'string') return message.content
  if (message && Array.isArray(message.content)) {
    const parts = []
    for (const part of message.content) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return null
}

/** Read a UTF-8 text file tolerating a BOM (PowerShell writers emit one). */
function readUtf8Text(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
}

/** Best-effort strict-JSON extraction from model text (fenced or bare). */
export function parseReviewText(text) {
  if (typeof text !== 'string') return null
  let candidate = text.trim()
  // A fenced block uses three U+0060 GRAVE ACCENT characters on each side.
  const fence = String.fromCharCode(96, 96, 96)
  const first = candidate.indexOf(fence)
  if (first >= 0) {
    const inner = candidate.slice(first + fence.length)
    const last = inner.lastIndexOf(fence)
    candidate = (last >= 0 ? inner.slice(0, last) : inner).trim()
    if (candidate.toLowerCase().startsWith('json')) candidate = candidate.slice(4).trim()
  }
  if (!candidate.startsWith('{')) return null
  try { return JSON.parse(candidate) } catch { return null }
}

// V1.1: exactly ONE retry, only for clearly transient transport failures
// (empty content, HTTP 429/5xx, timeout, malformed transport envelope).
// Valid results, deterministic schema failures, and local request problems
// are never retried. Maximum provider calls per invocation: 2.
const MAX_TRANSPORT_ATTEMPTS = 2
const TRANSIENT_HTTP_STATUS = new Set([429, 500, 502, 503, 504])

/** A mock response document is {status, body} or an ARRAY of those entries,
 *  one per transport attempt (attempt 1 -> entry 1, retry -> entry 2). */
function mockEntryFor(document, cursor) {
  if (Array.isArray(document)) {
    const index = Math.min(cursor, document.length - 1)
    return document[index]
  }
  return document
}

function mockOutcomeFor(document, cursor) {
  const entry = mockEntryFor(document, cursor)
  const status = Number(entry && entry.status)
  const body = entry ? entry.body : undefined
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const message = body && typeof body === 'object' && body.error && body.error.message
      ? String(body.error.message)
      : 'mock provider error (status ' + String(entry && entry.status) + ')'
    const outcome = errorOutcome('provider-error', message)
    outcome.status = Number.isInteger(status) ? status : null
    return outcome
  }
  const content = extractContent(body)
  if (content != null && content.trim() === '') {
    const outcome = errorOutcome('empty-content', 'provider returned empty assistant content')
    outcome.status = status
    return outcome
  }
  if (content == null) {
    const outcome = errorOutcome('provider-response-shape', 'provider returned no assistant text content')
    outcome.status = status
    return outcome
  }
  return { ok: true, content, review: parseReviewText(content), usage: body && typeof body === 'object' ? body.usage : null, mocked: true, status }
}

/** One provider call. Returns { outcome, transient }. */
async function attemptOnce(request, mockDoc, cursor, transportBody, apiKeyEnv, timeoutMs) {
  const startedAt = Date.now()
  let outcome
  if (mockDoc != null) {
    outcome = mockOutcomeFor(mockDoc, cursor)
  } else {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      const base = request.baseUrl.endsWith('/') ? request.baseUrl : request.baseUrl + '/'
      response = await fetch(new URL('chat/completions', base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env[apiKeyEnv].trim(),
        },
        body: JSON.stringify(transportBody),
        signal: controller.signal,
      })
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || String(error && error.message).includes('abort'))
      outcome = errorOutcome(aborted ? 'timeout' : 'transport-error', 'provider request failed: ' + String(error && error.message))
      outcome.status = null
      return finishAttempt(outcome, startedAt)
    } finally {
      clearTimeout(timer)
    }
    const responseText = await response.text()
    let responseBody = null
    try { responseBody = responseText ? JSON.parse(responseText) : null } catch { responseBody = null }
    if (!response.ok) {
      const message = responseBody && responseBody.error && responseBody.error.message
        ? String(responseBody.error.message)
        : (responseText || ('HTTP ' + response.status)).slice(0, 500)
      outcome = errorOutcome('provider-error', 'provider returned HTTP ' + response.status + ': ' + message)
      outcome.status = response.status
      return finishAttempt(outcome, startedAt)
    }
    const content = extractContent(responseBody)
    if (content == null) {
      outcome = errorOutcome('provider-response-shape', 'provider returned no assistant text content')
      outcome.status = response.status
      return finishAttempt(outcome, startedAt)
    }
    if (content.trim() === '') {
      outcome = errorOutcome('empty-content', 'provider returned empty assistant content')
      outcome.status = response.status
      return finishAttempt(outcome, startedAt)
    }
    outcome = {
      ok: true,
      model: typeof responseBody.model === 'string' ? responseBody.model : String(request.model),
      content,
      review: parseReviewText(content),
      usage: responseBody && typeof responseBody === 'object' ? responseBody.usage : null,
      status: response.status,
    }
  }
  return finishAttempt(outcome, startedAt)
}

function finishAttempt(outcome, startedAt) {
  let transient = false
  if (!outcome.ok) {
    if (outcome.errorKind === 'timeout' || outcome.errorKind === 'transport-error') transient = true
    else if (outcome.errorKind === 'empty-content' || outcome.errorKind === 'provider-response-shape') transient = true
    else if (outcome.errorKind === 'provider-error' && TRANSIENT_HTTP_STATUS.has(Number(outcome.status))) transient = true
  }
  outcome.durationMs = Date.now() - startedAt
  return { outcome, transient }
}

/** Perform the transport. Never writes project files; never executes tools.
 *  V1.1: at most TWO provider calls - exactly one retry for transient
 *  failures only (empty content, HTTP 429/5xx, timeout, malformed envelope). */
export async function runTransport(request) {
  const invalid = validateRequest(request)
  if (invalid) return { exitCode: 4, outcome: errorOutcome('bad-request', invalid) }

  let mockDoc = null
  if (request.mockFile) {
    try {
      mockDoc = JSON.parse(readUtf8Text(request.mockFile))
    } catch (error) {
      return { exitCode: 3, outcome: errorOutcome('mock-unreadable', 'mock response file is unreadable or invalid JSON: ' + String(error && error.message)) }
    }
  }

  const contentParts = [{ type: 'text', text: String(request.userText) }]
  for (const image of request.images) {
    const mediaType = mediaTypeOf(image.path)
    let buffer
    try {
      buffer = fs.readFileSync(image.path)
    } catch (error) {
      return { exitCode: 4, outcome: errorOutcome('image-unreadable', 'image could not be read (' + image.path + '): ' + String(error && error.message)) }
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { exitCode: 4, outcome: errorOutcome('image-too-large', 'image exceeds the transport cap of ' + MAX_IMAGE_BYTES + ' bytes: ' + image.path) }
    }
    contentParts.push({ type: 'image_url', image_url: { url: buildDataUrl(buffer, mediaType) } })
  }

  // V1.1 hardening: provider-level constrained structured output. The
  // OpenAI-compatible chat-completions field is used by default; a request
  // may pass an explicit responseFormat object (e.g. json_schema through a
  // compatible API) which is forwarded verbatim - the controller never
  // branches on vendor. 'none' opts out. Provider-level structure NEVER
  // replaces the strict Nexus schema validation downstream.
  let responseFormat = { type: 'json_object' }
  if (request.responseFormat === 'none') responseFormat = undefined
  else if (request.responseFormat && typeof request.responseFormat === 'object') responseFormat = request.responseFormat
  const transportBody = {
    model: String(request.model),
    messages: [
      { role: 'system', content: String(request.systemPrompt || '') },
      { role: 'user', content: contentParts },
    ],
    stream: false,
  }
  if (responseFormat) transportBody.response_format = responseFormat
  if (responseFormat && responseFormat.type === 'json_object') {
    transportBody.messages[1].content[0].text = String(request.userText) + '\n\nRespond with a single JSON object only - no prose, no Markdown fences, no code blocks.'
  }
  if (Number.isFinite(Number(request.maxOutputTokens)) && Number(request.maxOutputTokens) > 0) {
    transportBody.max_tokens = Number(request.maxOutputTokens)
  }

  const apiKeyEnv = typeof request.apiKeyEnv === 'string' && request.apiKeyEnv !== '' ? request.apiKeyEnv : 'DEEPSEEK_API_KEY'
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 180000

  const attempts = []
  let final = null
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
    const { outcome, transient } = await attemptOnce(request, mockDoc, attempt - 1, transportBody, apiKeyEnv, timeoutMs)
    attempts.push({
      attempt,
      ok: outcome.ok === true,
      kind: outcome.ok ? 'success' : String(outcome.errorKind || 'error'),
      status: outcome.status == null ? null : Number(outcome.status),
      durationMs: Number(outcome.durationMs) || 0,
      error: outcome.ok ? null : String(outcome.error || '').slice(0, 200),
    })
    outcome.attempts = attempts.map((a) => Object.assign({}, a))
    outcome.attemptCount = attempts.length
    final = outcome
    if (!transient) break
  }
  return { exitCode: final.ok ? 0 : 3, outcome: final }
}

function main() {
  const argv = process.argv.slice(2)
  let requestPath = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--request' && argv[i + 1]) requestPath = argv[i + 1]
  }
  if (!requestPath) {
    process.stdout.write(JSON.stringify(errorOutcome('bad-request', 'usage: node Invoke-VisualReview.mjs --request <request.json>')) + '\n')
    process.exit(4)
  }
  let request
  try {
    request = JSON.parse(readUtf8Text(requestPath))
  } catch (error) {
    process.stdout.write(JSON.stringify(errorOutcome('bad-request', 'transport request file is unreadable or invalid JSON: ' + String(error && error.message))) + '\n')
    process.exit(4)
  }
  runTransport(request).then((result) => {
    process.stdout.write(JSON.stringify(result.outcome) + '\n')
    process.exit(result.exitCode)
  }).catch((error) => {
    process.stdout.write(JSON.stringify(errorOutcome('transport-error', String(error && error.message))) + '\n')
    process.exit(3)
  })
}

const invokedDirectly = process.argv[1] && (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) } catch { return false }
})()
if (invokedDirectly) main()
