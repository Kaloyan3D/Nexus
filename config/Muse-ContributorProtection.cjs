'use strict'

/**
 * Muse-ContributorProtection.cjs — Phase M5 provider-egress protection.
 *
 * This module NEVER modifies durable session history. It operates only on the
 * provider-native payload produced for Muse Spark Contributor immediately
 * before network egress through pi-ai's onPayload seam.
 *
 * Contract:
 *   - exact target only: meta-model-api / muse-spark-1.3-contributor
 *   - deterministic, non-mutating sanitization
 *   - secrets are redacted, never logged
 *   - opaque/binary/cyclic/non-JSON payloads fail closed
 *   - a missing/replaced global guard fails closed at the patched adapter
 */

const GUARD_SYMBOL = Symbol.for('nexus.museContributorPayloadGuard.v1')
const GUARD_VERSION = 1

const MUSE_PROVIDER = 'meta-model-api'
const MUSE_MODEL = 'muse-spark-1.3-contributor'

const REDACTION = '<redacted:nexus-contributor-secret>'
const REDACTION_JSON = JSON.stringify(REDACTION)

const MAX_DEPTH = 64
const MAX_NODES = 200000
const OMIT_OBJECT_PROPERTY = Symbol('nexus.museContributor.omitObjectProperty')
const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/

function protectionError(code, message) {
  const error = new Error('Nexus Muse contributor protection blocked outbound payload: ' + message)
  error.code = code
  return error
}

function keyParts(name) {
  return String(name == null ? '' : name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isSecretFieldName(name) {
  const parts = keyParts(name)
  if (parts.length === 0) return false

  const strong = new Set([
    'password',
    'passwd',
    'pwd',
    'secret',
    'secrets',
    'credential',
    'credentials',
    'authorization',
  ])

  if (parts.some((part) => strong.has(part))) return true

  const referenceOnly = parts.some((part) =>
    part === 'env' ||
    part === 'ref' ||
    part === 'reference' ||
    part === 'name'
  )

  const benignTokenContext = new Set([
    'max',
    'min',
    'input',
    'output',
    'prompt',
    'completion',
    'reasoning',
    'cache',
    'total',
    'usage',
    'budget',
    'count',
    'limit',
    'window',
  ])

  if (parts.includes('token')) {
    if (!parts.some((part) => benignTokenContext.has(part))) return true
  }

  if (parts.includes('key') && !referenceOnly) {
    const keyContext = new Set([
      'api',
      'private',
      'access',
      'client',
      'secret',
      'signing',
      'encryption',
      'auth',
    ])
    if (parts.some((part) => keyContext.has(part))) return true
  }

  return false
}

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]

const PRIVATE_KEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

const SECRET_QUERY_RE =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization)=)([^&#\s]+)/gi

const BASIC_AUTH_URL_RE =
  /\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi

function redactSecretAssignments(text) {
  const pieces = String(text).split(/(\r?\n)/)

  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index]

    let match = line.match(
      /^(\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)(.*)$/
    )

    if (match && isSecretFieldName(match[2])) {
      const suffixMatch = match[4].match(/([,;]\s*)$/)
      pieces[index] =
        match[1] +
        match[2] +
        match[3] +
        REDACTION_JSON +
        (suffixMatch ? suffixMatch[1] : '')
      continue
    }

    match = line.match(/^(\s*["'])([^"']+)(["']\s*:\s*)(.*)$/)

    if (match && isSecretFieldName(match[2])) {
      const suffixMatch = match[4].match(/([,;]\s*)$/)
      pieces[index] =
        match[1] +
        match[2] +
        match[3] +
        REDACTION_JSON +
        (suffixMatch ? suffixMatch[1] : '')
    }
  }

  return pieces.join('')
}

function hasImageSignature(bytes, mimeType) {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

function isValidatedImageDataUrl(value) {
  const match = String(value).match(IMAGE_DATA_URL_RE)
  if (!match || match[2].length % 4 !== 0) return false

  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== match[2]) return false
  return hasImageSignature(bytes, match[1])
}

function isProviderNativeImageUrlPath(root, path) {
  if (
    path.length !== 6 ||
    path[0] !== 'messages' ||
    !Number.isInteger(path[1]) ||
    path[2] !== 'content' ||
    !Number.isInteger(path[3]) ||
    path[4] !== 'image_url' ||
    path[5] !== 'url'
  ) return false

  const message = root.messages?.[path[1]]
  const block = message?.content?.[path[3]]
  if (
    !message || message.role !== 'user' ||
    !block || Object.getPrototypeOf(block) !== Object.prototype ||
    block.type !== 'image_url' ||
    !block.image_url || Object.getPrototypeOf(block.image_url) !== Object.prototype
  ) return false

  const blockKeys = Object.keys(block).sort()
  const imageUrlKeys = Object.keys(block.image_url).sort()
  return blockKeys.length === 2 && blockKeys[0] === 'image_url' && blockKeys[1] === 'type' &&
    imageUrlKeys.length === 1 && imageUrlKeys[0] === 'url'
}

function sanitizeContributorText(value, options) {
  let text = String(value)

  if (text.includes('\u0000')) {
    throw protectionError(
      'nexus-muse-contributor-opaque-payload',
      'text contains NUL/binary data'
    )
  }

  if (/data:[^,;\s]+;base64,/i.test(text)) {
    if (options?.allowImageDataUrl === true && isValidatedImageDataUrl(text)) {
      return text
    }
    throw protectionError(
      'nexus-muse-contributor-opaque-payload',
      'inline base64 data is not permitted on the Muse Contributor wire'
    )
  }

  text = text.replace(PRIVATE_KEY_RE, REDACTION)
  text = text.replace(BEARER_RE, 'Bearer ' + REDACTION)
  text = text.replace(
    BASIC_AUTH_URL_RE,
    (_whole, protocol, username) => protocol + username + ':' + REDACTION + '@'
  )
  text = text.replace(
    SECRET_QUERY_RE,
    (_whole, prefix) => prefix + encodeURIComponent(REDACTION)
  )

  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, REDACTION)
  }

  return redactSecretAssignments(text)
}

function sanitizeContributorValue(value, state, depth, position, path) {
  state.nodes += 1

  if (state.nodes > MAX_NODES) {
    throw protectionError(
      'nexus-muse-contributor-payload-too-large',
      'payload exceeds the deterministic node bound'
    )
  }

  if (depth > MAX_DEPTH) {
    throw protectionError(
      'nexus-muse-contributor-payload-too-deep',
      'payload exceeds the deterministic nesting bound'
    )
  }

  if (value === null) return null

  switch (typeof value) {
    case 'string':
      return sanitizeContributorText(value, {
        allowImageDataUrl: isProviderNativeImageUrlPath(state.root, path),
      })

    case 'boolean':
      return value

    case 'number':
      return Number.isFinite(value) ? value : null

    case 'undefined':
    case 'function':
    case 'symbol':
      return position === 'array' ? null : OMIT_OBJECT_PROPERTY

    case 'bigint':
      throw protectionError(
        'nexus-muse-contributor-invalid-payload',
        'payload contains an unsupported BigInt value'
      )
  }

  if (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    throw protectionError(
      'nexus-muse-contributor-opaque-payload',
      'binary payload material is not permitted'
    )
  }

  if (state.seen.has(value)) {
    throw protectionError(
      'nexus-muse-contributor-cyclic-payload',
      'cyclic payload cannot be sanitized deterministically'
    )
  }

  state.seen.add(value)

  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        sanitizeContributorValue(item, state, depth + 1, 'array', path.concat(index))
      )
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw protectionError(
        'nexus-muse-contributor-invalid-payload',
        'payload contains a non-plain object'
      )
    }

    const output = {}

    for (const [key, child] of Object.entries(value)) {
      const normalized = sanitizeContributorValue(child, state, depth + 1, 'object', path.concat(key))
      if (normalized === OMIT_OBJECT_PROPERTY) continue
      output[key] = isSecretFieldName(key) ? REDACTION : normalized
    }

    return output
  } finally {
    state.seen.delete(value)
  }
}

function sanitizeContributorPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw protectionError(
      'nexus-muse-contributor-invalid-payload',
      'provider payload must be a JSON object'
    )
  }

  return sanitizeContributorValue(
    payload,
    { seen: new WeakSet(), nodes: 0, root: payload },
    0,
    'root',
    []
  )
}

function isMuseContributorTarget(model) {
  if (!model || typeof model !== 'object') return false

  const provider =
    typeof model.provider === 'string' ? model.provider : ''

  const id =
    typeof model.id === 'string'
      ? model.id
      : typeof model.model === 'string'
        ? model.model
        : ''

  return provider === MUSE_PROVIDER && id === MUSE_MODEL
}

function payloadGuard(payload, model) {
  if (!isMuseContributorTarget(model)) return undefined
  return sanitizeContributorPayload(payload)
}

Object.defineProperty(payloadGuard, 'nexusMuseContributorGuardVersion', {
  value: GUARD_VERSION,
  enumerable: false,
  configurable: false,
  writable: false,
})

function installPayloadGuard() {
  const existing = globalThis[GUARD_SYMBOL]

  if (existing === undefined) {
    globalThis[GUARD_SYMBOL] = payloadGuard
    return { installed: true, reused: false, version: GUARD_VERSION }
  }

  if (
    typeof existing === 'function' &&
    existing.nexusMuseContributorGuardVersion === GUARD_VERSION
  ) {
    return { installed: true, reused: true, version: GUARD_VERSION }
  }

  throw protectionError(
    'nexus-muse-contributor-guard-conflict',
    'the global contributor guard slot is occupied by an unknown implementation'
  )
}

module.exports = {
  GUARD_SYMBOL,
  GUARD_VERSION,
  MUSE_PROVIDER,
  MUSE_MODEL,
  REDACTION,
  isSecretFieldName,
  sanitizeContributorText,
  sanitizeContributorPayload,
  isMuseContributorTarget,
  payloadGuard,
  installPayloadGuard,
}
