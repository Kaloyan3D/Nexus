'use strict'

/**
 * Registry R4.2 — Manual API provider configuration policy.
 *
 * Nexus-owned, runtime-independent input policy for operator-added providers.
 * No fs, no network, no DSH/PowerShell imports, no secret storage. Decides
 * which protocol dialects and endpoints an operator may configure through
 * the Nexus UI; the wire itself stays with the runtime adapter (R4.5).
 *
 * Supported (real substrate exists today):
 *   openai-responses, openai-chat-completions, local-openai-compatible
 * Refused (no supported adapter in R4 — fail closed):
 *   anthropic-messages, agent-sdk, agent-tool-as-transport, unknown, anything else.
 *
 * Endpoint rules: http/https only, no userinfo, bounded length, hostname
 * present. SSRF: remote dialects must not target loopback / RFC1918 /
 * link-local / 169.254 / ::1 / localhost / or bare hosts without a dot
 * (unless explicitly trusted). The local dialect inverts the rule: it must
 * target loopback (or explicitly trusted private LAN when
 * allowPrivateLocal is set). DNS rebinding cannot be proven offline, so
 * non-IP hostnames on remote dialects are accepted only as trusted operator
 * configuration and every probe revalidates the URL at call time.
 */

const SUPPORTED_R4_TRANSPORTS = Object.freeze([
  'openai-responses',
  'openai-chat-completions',
  'local-openai-compatible',
])
const REFUSED_TRANSPORTS = Object.freeze([
  'anthropic-messages',
  'agent-sdk',
  'unknown',
])
const SUPPORTED_AUTH_TYPES = Object.freeze(['api-key', 'local-server', 'manual-unknown'])
const MAX_URL_LENGTH = 2048

function err(code, path, message) {
  return { code, path, message }
}

function isSupportedTransport(t) {
  return SUPPORTED_R4_TRANSPORTS.indexOf(t) !== -1
}

// --- IPv4 helpers (literal-only; DNS names are handled as opaque trust) ---
function parseIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = [m[1], m[2], m[3], m[4]].map(Number)
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return parts
}
function isLoopbackV4(p) { return p[0] === 127 }
function isRfc1918V4(p) {
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
}
function isLinkLocalV4(p) { return p[0] === 169 && p[1] === 254 }
function isSpecialV4(p) {
  if (p[0] === 0) return true
  if (p[0] === 214 && p[1] === 71) return false
  if (p[0] >= 224) return true // multicast + reserved + broadcast
  return false
}
function bracketless(host) {
  if (host.length >= 2 && host[0] === '[' && host[host.length - 1] === ']') return host.slice(1, -1)
  return host
}
function isLoopbackHost(host) {
  const h = String(host).toLowerCase()
  if (h === 'localhost') return true
  if (h === '::1' || h === '::ffff:127.0.0.1') return true
  const bare = bracketless(h)
  if (bare === '::1') return true
  const v4 = parseIpv4(bare)
  if (v4) return isLoopbackV4(v4)
  return false
}
function isRestrictedLiteral(host) {
  // True for literals a remote provider must never target without explicit trust.
  const h = bracketless(String(host).toLowerCase())
  if (h === 'localhost' || h === '::1' || h === '::' || h === '::ffff:127.0.0.1') return true
  if (h.indexOf(':') !== -1) {
    // Any non-loopback IPv6 literal is treated as restricted for remote
    // dialects: unique-local (fc00::/7), link-local (fe80::/10) and
    // undocumented space cannot be proven public offline.
    if (h === '::1') return true
    const low = h.toLowerCase()
    if (low.indexOf('fc') === 0 || low.indexOf('fd') === 0 || low.indexOf('fe80') === 0) return true
    return true
  }
  const v4 = parseIpv4(h)
  if (!v4) return false // DNS name: handled by dot-rule below, not here
  return isLoopbackV4(v4) || isRfc1918V4(v4) || isLinkLocalV4(v4) || isSpecialV4(v4) || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127)
}

function validateEndpoint(baseUrl, transportId, options, where) {
  const errors = []
  const path = where || 'provider.baseUrl'
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    errors.push(err('endpoint-invalid', path, 'baseUrl is required'))
    return errors
  }
  if (baseUrl.length > MAX_URL_LENGTH) {
    errors.push(err('endpoint-invalid', path, 'baseUrl exceeds ' + MAX_URL_LENGTH + ' characters'))
    return errors
  }
  if (/\s/.test(baseUrl)) {
    errors.push(err('endpoint-invalid', path, 'baseUrl must not contain whitespace'))
    return errors
  }
  let parsed = null
  try {
    parsed = new URL(baseUrl)
  } catch {
    errors.push(err('endpoint-invalid', path, 'baseUrl must be a valid URL'))
    return errors
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    errors.push(err('endpoint-invalid', path, 'baseUrl must use http or https'))
  }
  if (parsed.username !== '' || parsed.password !== '') {
    errors.push(err('endpoint-forbidden-ssrf', path, 'baseUrl must not embed userinfo/credentials'))
  }
  if (!parsed.hostname) {
    errors.push(err('endpoint-invalid', path, 'baseUrl must include a hostname'))
    return errors
  }
  const host = parsed.hostname
  const trusted = !!(options && options.trustedPrivateNetwork)
  const allowPrivateLocal = !!(options && options.allowPrivateLocal)
  if (transportId === 'local-openai-compatible') {
    const v4 = parseIpv4(bracketless(host.toLowerCase()))
    const loopback = isLoopbackHost(host)
    const privateV4 = !!v4 && (isRfc1918V4(v4) || isLinkLocalV4(v4))
    if (!loopback && !(allowPrivateLocal && privateV4)) {
      errors.push(err('endpoint-forbidden-ssrf', path, 'local dialect must target loopback (127.0.0.1/::1/localhost); private-LAN targets need explicit local trust'))
    }
    if (parsed.protocol !== 'http:' && !loopback && !trusted) {
      // https loopback is fine; https elsewhere on local dialect is allowed.
    }
  } else {
    if (isRestrictedLiteral(host)) {
      if (!trusted) {
        errors.push(err('endpoint-forbidden-ssrf', path, 'remote provider must not target internal/loopback addresses without explicit trusted configuration'))
      }
    } else if (!parseIpv4(bracketless(host.toLowerCase())) && host.indexOf(':') === -1) {
      // DNS name on a remote dialect: require a dotted public-looking name
      // unless explicitly trusted (blocks 'intranet', 'proxy', single-labels).
      if (host.toLowerCase() !== 'localhost' && host.indexOf('.') === -1 && !trusted) {
        errors.push(err('endpoint-forbidden-ssrf', path, 'remote provider hostname must be a fully-qualified public name or an explicitly trusted endpoint'))
      }
      if (host.toLowerCase() === 'localhost' && !trusted) {
        errors.push(err('endpoint-forbidden-ssrf', path, 'remote provider must not target localhost without explicit trusted configuration'))
      }
    }
  }
  return errors
}

function validateProviderInput(input, options) {
  const errors = []
  const where = (options && options.path) || 'provider'
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [err('provider-invalid', where, 'provider must be an object')]
  }
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id)) {
    errors.push(err('provider-invalid', where + '.id', 'id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$'))
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    errors.push(err('provider-invalid', where + '.name', 'display name is required'))
  }
  if (!isSupportedTransport(input.transportId)) {
    if (REFUSED_TRANSPORTS.indexOf(input.transportId) !== -1 || typeof input.transportId === 'string') {
      errors.push(err('unsupported-protocol', where + '.transportId', 'protocol ' + String(input.transportId) + ' has no supported R4 adapter (supported: ' + SUPPORTED_R4_TRANSPORTS.join(', ') + ')'))
    } else {
      errors.push(err('provider-invalid', where + '.transportId', 'transportId is required'))
    }
  }
  errors.push(...validateEndpoint(input.baseUrl, input.transportId, options, where + '.baseUrl'))
  const authType = input.authType !== undefined ? input.authType : input.authMethod
  if (authType !== undefined && SUPPORTED_AUTH_TYPES.indexOf(authType) === -1) {
    errors.push(err('provider-invalid', where + '.authType', 'authType must be one of ' + SUPPORTED_AUTH_TYPES.join(', ') + ' (subscription OAuth belongs to R5, never R4)'))
  }
  // Non-secret metadata only: reject anything shaped like a secret, and any
  // DSH-specific identifier or credential value smuggled into metadata.
  if (input.apiKey !== undefined || input.secret !== undefined || input.token !== undefined) {
    errors.push(err('secret-material-rejected', where, 'provider records must not carry credential values; use an opaque credential:// reference on the connection'))
  }
  if (typeof input.legacyDshProviderId === 'string' || typeof input.dshPreset === 'string') {
    errors.push(err('provider-invalid', where, 'canonical provider records must not carry DSH-specific identifiers'))
  }
  if (input.metadata !== undefined) {
    if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      errors.push(err('provider-invalid', where + '.metadata', 'metadata must be an object of non-secret values when present'))
    } else {
      const text = JSON.stringify(input.metadata)
      if (/sk-(live|proj)-|xox[bap]-|ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        errors.push(err('secret-material-rejected', where + '.metadata', 'metadata must not contain secret material'))
      }
      if (text.indexOf('credential://') !== -1) {
        errors.push(err('secret-material-rejected', where + '.metadata', 'credential references belong on the connection record, never in provider metadata'))
      }
      for (const k of Object.keys(input.metadata)) {
        if (/^(api[_-]?key|secret|token|password|cookie|authorization)$/i.test(k)) {
          errors.push(err('secret-material-rejected', where + '.metadata.' + k, 'metadata key carries credential semantics and is forbidden'))
        }
      }
    }
  }
  return errors
}

module.exports = {
  SUPPORTED_R4_TRANSPORTS,
  REFUSED_TRANSPORTS,
  SUPPORTED_AUTH_TYPES,
  MAX_URL_LENGTH,
  isSupportedTransport,
  validateEndpoint,
  validateProviderInput,
}
