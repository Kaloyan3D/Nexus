'use strict'

/**
 * Registry R4.2 — pinned HTTP(S) transport for capability probes.
 *
 * DNS-to-connection binding: the caller (probes.cjs) resolves the target
 * hostname ONCE, validates every resolved address against the SSRF policy,
 * and hands the validated list here. This module then connects the socket
 * to the validated address WITHOUT re-resolving — there is no second,
 * independent resolution at connection time, so DNS rebinding between
 * validation and connect cannot redirect the probe.
 *
 * TLS is preserved, never downgraded: for https targets the original
 * hostname is sent as SNI (servername) and default hostname verification
 * applies (rejectUnauthorized stays true; checkServerIdentity is never
 * overridden). Redirects are never followed (plain http/https requests do
 * not follow them); a 3xx status is returned for the caller to refuse.
 *
 * Abort always destroys the socket: the signal handler tears down the
 * request and any live response, so an uncooperative endpoint cannot leave
 * a lingering connection behind after the probe deadline settles. This is
 * the bounded resource policy backing the concurrency limiter.
 *
 * Only node:http / node:https are used. No proxy support: proxy or
 * dispatcher behavior is unsupported and fails closed (there is no code
 * path that consults proxy configuration).
 */

const http = require('node:http')
const https = require('node:https')

function err(code, p, message) {
  return { code, path: p, message }
}

function stripBrackets(host) {
  const h = String(host)
  if (h.length >= 2 && h[0] === '[' && h[h.length - 1] === ']') return h.slice(1, -1)
  return h
}

function defaultPortFor(protocol) {
  if (protocol === 'https:') return 443
  return 80
}

function familyOf(address) {
  const bare = stripBrackets(String(address)).toLowerCase()
  if (bare.indexOf(':') !== -1) return 6
  return 4
}

/**
 * Pure request-option builder (unit-testable, no I/O). Throws an
 * err-shaped endpoint-forbidden-ssrf refusal when there is no validated
 * destination to bind.
 */
function buildRequestOptions(urlText, addresses, init) {
  const o = init || {}
  let parsed = null
  try {
    parsed = new URL(String(urlText))
  } catch (e) {
    void e
    throw err('endpoint-invalid', 'probe.target', 'probe URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw err('endpoint-invalid', 'probe.target', 'probe URL must use http or https')
  }
  const list = Array.isArray(addresses) ? addresses.filter(function (a) {
    return a && typeof a.address === 'string' && a.address !== ''
  }) : []
  if (list.length === 0) {
    throw err('endpoint-forbidden-ssrf', 'probe.target', 'no validated destination address; refusing an unbound connection')
  }
  const pinned = stripBrackets(list[0].address)
  const hostname = parsed.hostname
  const port = parsed.port !== '' ? Number(parsed.port) : defaultPortFor(parsed.protocol)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw err('endpoint-invalid', 'probe.target', 'probe URL carries an invalid port')
  }
  const headers = Object.assign({}, o.headers || {})
  headers.host = hostname + (parsed.port !== '' ? ':' + parsed.port : '')
  const options = {
    protocol: parsed.protocol,
    host: pinned,
    port: port,
    path: (parsed.pathname || '/') + (parsed.search || ''),
    method: o.method || 'GET',
    headers: headers,
    family: list[0].family === 6 ? 6 : familyOf(pinned),
    rejectUnauthorized: true,
  }
  if (parsed.protocol === 'https:') {
    options.servername = stripBrackets(hostname)
  }
  return options
}

function defaultRequestFn(options, onResponse) {
  const runner = options.protocol === 'https:' ? https : http
  return runner.request(options, onResponse)
}

function abortError() {
  const e = new Error('probe transport aborted')
  e.name = 'AbortError'
  return e
}

/**
 * Bound request against pre-validated addresses. Signature mirrors the
 * fetch subset the probe layer needs; the returned body is async-iterable
 * with cancel(), plus a text() convenience reader.
 */
function requestPinned(urlText, init, pinning, deps) {
  const o = init || {}
  const options = buildRequestOptions(urlText, pinning && pinning.addresses, o)
  const requestFn = deps && typeof deps.requestFn === 'function' ? deps.requestFn : defaultRequestFn
  const signal = o.signal || null
  return new Promise(function (resolve, reject) {
    let settled = false
    let req = null
    let res = null
    function destroyAll() {
      try { if (res && typeof res.destroy === 'function') res.destroy(); } catch (e) { void e; }
      try { if (req && typeof req.destroy === 'function') req.destroy(); } catch (e) { void e; }
    }
    function fail(e) {
      if (!settled) {
        settled = true
        destroyAll()
        reject(e)
      }
    }
    function onAbort() {
      destroyAll()
      fail(abortError())
    }
    if (signal && signal.aborted) {
      fail(abortError())
      return
    }
    let response = null
    function bodyIterator() {
      const stream = res
      const queue = []
      let finished = false
      let failed = null
      let pending = null
      function detach() {
        try { stream.removeListener('data', onData); } catch (e) { void e; }
        try { stream.removeListener('end', onEnd); } catch (e) { void e; }
        try { stream.removeListener('error', onError); } catch (e) { void e; }
        try { if (signal) signal.removeEventListener('abort', onAbortSignal); } catch (e) { void e; }
      }
      function drain() {
        if (!pending) return
        if (queue.length > 0) {
          const waiter = pending
          pending = null
          waiter.resolve({ done: false, value: queue.shift() })
          return
        }
        if (failed) {
          const waiter = pending
          pending = null
          waiter.reject(failed)
          return
        }
        if (finished) {
          const waiter = pending
          pending = null
          detach()
          waiter.resolve({ done: true, value: undefined })
        }
      }
      function onData(chunk) { queue.push(chunk); drain(); }
      function onEnd() { finished = true; drain(); }
      function onError(e) { failed = e; drain(); }
      function onAbortSignal() { failed = failed || abortError(); drain(); }
      stream.on('data', onData)
      stream.on('end', onEnd)
      stream.on('error', onError)
      if (signal) signal.addEventListener('abort', onAbortSignal, { once: true })
      return {
        next: function () {
          if (signal && signal.aborted) return Promise.reject(abortError())
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          if (failed) return Promise.reject(failed)
          if (finished) {
            detach()
            return Promise.resolve({ done: true, value: undefined })
          }
          return new Promise(function (resolveNext, rejectNext) {
            pending = { resolve: resolveNext, reject: rejectNext }
          })
        },
      }
    }
    const body = {}
    body[Symbol.asyncIterator] = function () { return bodyIterator() }
    body.cancel = async function () { destroyAll() }
    async function readAllText() {
      const parts = []
      const it = bodyIterator()
      for (;;) {
        const step = await it.next()
        if (!step || step.done) break
        parts.push(typeof step.value === 'string' ? Buffer.from(step.value, 'utf8') : Buffer.from(step.value))
      }
      return Buffer.concat(parts).toString('utf8')
    }
    try {
      req = requestFn(options, function (incoming) {
        res = incoming
        const headerFields = (incoming && incoming.headers) || {}
        const headers = {
          get: function (name) {
            const v = headerFields[String(name).toLowerCase()]
            if (Array.isArray(v)) return v[0]
            return v === undefined ? null : v
          },
          raw: headerFields,
        }
        response = { status: typeof incoming.statusCode === 'number' ? incoming.statusCode : 0, headers: headers, body: body, text: readAllText }
        if (!settled) {
          settled = true
          resolve(response)
        }
      })
    } catch (e) {
      fail(e)
      return
    }
    if (!req || typeof req.on !== 'function' || typeof req.end !== 'function') {
      fail(new Error('probe transport returned an unusable request handle'))
      return
    }
    req.on('error', fail)
    req.on('close', function () {
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch (e) { void e; }
      }
    })
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (o.body !== undefined) req.write(o.body)
      req.end()
    } catch (e) {
      fail(e)
    }
  })
}

module.exports = {
  buildRequestOptions,
  requestPinned,
}
