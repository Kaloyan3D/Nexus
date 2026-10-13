'use strict';

/**
 * A1.3 JS -> nexusd daemon transport: Unix-socket IPC client (shadow-only).
 *
 * This module speaks the daemon IPC protocol v1 (one JSON object per line
 * over a Unix Domain Socket, 1 MiB request cap enforced on both ends) and
 * presents the SAME invoke signature as the A1.2 CLI bridge
 * (`invokeDaemonBridge(subcommand, request, options)` returning
 * `{ ok, status, response?, code?, message? }`), so the existing
 * reconciliation logic in native-shadow.cjs is reused without duplication.
 *
 * Differences from the CLI bridge:
 * - Async (Promise-based): callers MUST await the result. The daemon
 *   holds no per-call subprocess; requests multiplex over short-lived
 *   socket connections with explicit timeouts.
 * - Privileged subcommands (acquire/seal/accept) require issuer
 *   authentication when the daemon runs in shadow-test trust mode: each
 *   request carries `auth: { nonce, ts, tag }` with
 *   `tag = HMAC-SHA256(capkey, canonical({protocol,id,cmd,params,nonce,ts}))`
 *   over the daemon's ephemeral capability file. The cap key is read from
 *   `options.daemonCapPath`; nonces are fresh 128-bit values per request.
 * - Read-only subcommands (receipt/journal/digest/health/status) need no
 *   authentication and are safe to call without a cap path.
 * - There is NEVER a silent fallback to the CLI: a refused daemon request
 *   is returned as `{ ok: true, status: 'refused', ... }` exactly like a
 *   kernel refusal, and transport failures as
 *   `{ ok: false, status: 'transport-error', ... }`. Callers surface these
 *   explicitly; falling back to an insecure CLI mutation would bypass
 *   daemon authorization and is forbidden.
 *
 * Trust boundary (same limitation as the daemon documents): the capability
 * file is readable by any same-UID process, so a hostile same-UID peer that
 * reads it can impersonate the trusted issuer. The supported boundary is a
 * single-tenant test machine with no hostile same-UID peer. Production use
 * is NOT claimed (see native/A1.3-EVIDENCE.md).
 *
 * Secrets: the cap key, tags and nonces are NEVER logged and never appear
 * in error messages (only ids, digests and codes are).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const resolver = require('./resolver.cjs');

const IPC_PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

function canonicalOf(value) {
  return resolver.canonicalize(value);
}

/**
 * Canonical auth bytes. MUST match Rust `IssuerAuth::auth_bytes`
 * field-for-field: { cmd, id, nonce, params, protocol, ts } (key order is
 * irrelevant — both sides canonicalize with sorted keys — but the field
 * SET and value encodings must agree; pinned by integration test).
 */
function authBytesOf(cmd, id, params, nonce, ts) {
  return canonicalOf({ cmd: cmd, id: id, nonce: nonce, params: params, protocol: IPC_PROTOCOL_VERSION, ts: ts });
}

function hmacTag(capKeyHex, bytes) {
  return crypto.createHmac('sha256', Buffer.from(String(capKeyHex).trim(), 'hex')).update(bytes, 'utf8').digest('hex');
}

function readCapKey(capPath) {
  const raw = fs.readFileSync(String(capPath), 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('daemon capability file is malformed');
  return raw;
}

function redactForLog(value) {
  try {
    const text = JSON.stringify(value);
    return String(text).replace(/(sk-(live|proj)-[A-Za-z0-9._-]+|xox[bap]-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g, '[REDACTED]');
  } catch {
    return '[unloggable]';
  }
}

function failTransport(code, message) {
  return { ok: false, status: 'transport-error', code: code, message: String(message).slice(0, 300) };
}

function sendOneRequest(socketPath, frame, timeoutMs) {
  return new Promise(function (resolve) {
    const socket = net.createConnection({ path: String(socketPath) });
    let settled = false;
    let buffer = '';
    function done(value) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    }
    socket.setTimeout(timeoutMs);
    socket.setEncoding('utf8');
    socket.on('timeout', function () { done(failTransport('daemon-timeout', 'daemon request timed out')); });
    socket.on('error', function (e) { done(failTransport('daemon-unavailable', 'daemon socket failed: ' + String((e && e.message) || e).slice(0, 200))); });
    socket.on('connect', function () {
      try {
        socket.write(frame + '\n', 'utf8');
      } catch (e) {
        done(failTransport('daemon-unavailable', 'daemon socket write failed'));
      }
    });
    socket.on('data', function (chunk) {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        done(failTransport('too-large', 'daemon response exceeds cap'));
        return;
      }
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        done({ ok: true, line: buffer.slice(0, idx) });
      }
    });
    socket.on('close', function () {
      done(failTransport('daemon-unavailable', 'daemon closed the connection before answering'));
    });
  });
}

const PRIVILEGED = { acquire: true, seal: true, accept: true };

/**
 * Invoke one daemon IPC command. Mirrors `invokeBridge(subcommand, request,
 * options)`; `options.daemonSocket` (required) and `options.daemonCapPath`
 * (required for privileged subcommands in shadow-test mode) select the
 * daemon. Async: callers must await.
 */
async function invokeDaemonBridge(subcommand, request, options) {
  const o = options || {};
  const socketPath = typeof o.daemonSocket === 'string' && o.daemonSocket !== '' ? o.daemonSocket : null;
  const timeoutMs = Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const allowed = { acquire: true, seal: true, accept: true, receipt: true, journal: true, digest: true, health: true, status: true };
  if (!allowed[subcommand]) return failTransport('bad-subcommand', 'unknown daemon subcommand');
  if (!socketPath) return failTransport('bridge-misconfigured', 'daemonSocket is required for daemon transport');
  let req;
  try {
    req = Object.assign({}, request);
  } catch {
    return failTransport('bad-request', 'request is not JSON-representable');
  }
  const id = 'd-' + crypto.randomBytes(8).toString('hex');
  const params = req && typeof req === 'object' && !Array.isArray(req) ? req : {};
  const envelope = { protocol: IPC_PROTOCOL_VERSION, id: id, cmd: subcommand, params: params };
  if (PRIVILEGED[subcommand]) {
    const capPath = typeof o.daemonCapPath === 'string' && o.daemonCapPath !== '' ? o.daemonCapPath : null;
    if (!capPath) {
      return { ok: true, status: 'refused', response: null, code: 'issuer-untrusted', message: 'no daemon capability is configured; privileged daemon requests are refused without issuer authentication (no CLI fallback)' };
    }
    let capKey;
    try {
      capKey = readCapKey(capPath);
    } catch (e) {
      return failTransport('bridge-misconfigured', 'daemon capability is unreadable: ' + String((e && e.message) || e).slice(0, 150));
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = Date.now();
    envelope.auth = { nonce: nonce, ts: ts, tag: hmacTag(capKey, authBytesOf(subcommand, id, params, nonce, ts)) };
  }
  let frame;
  try {
    frame = JSON.stringify(envelope);
    if (Buffer.byteLength(frame, 'utf8') > MAX_REQUEST_BYTES) return failTransport('too-large', 'daemon request exceeds 1 MiB');
  } catch {
    return failTransport('bad-request', 'request is not JSON-representable');
  }
  const sent = await sendOneRequest(socketPath, frame, timeoutMs);
  if (!sent.ok) return sent;
  let response;
  try {
    response = JSON.parse(sent.line);
  } catch {
    return failTransport('bad-response', 'daemon returned non-JSON');
  }
  if (!response || typeof response !== 'object' || response.protocol !== IPC_PROTOCOL_VERSION || typeof response.ok !== 'boolean' || response.id !== id) {
    return failTransport('bad-response', 'daemon response violates the versioned envelope');
  }
  if (response.ok !== true) {
    return { ok: true, status: 'refused', response: response, code: response.code || 'unknown', message: response.message || 'refused' };
  }
  return { ok: true, status: 'ok', response: response };
}

module.exports = {
  IPC_PROTOCOL_VERSION: IPC_PROTOCOL_VERSION,
  MAX_REQUEST_BYTES: MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  authBytesOf: authBytesOf,
  hmacTag: hmacTag,
  redactForLog: redactForLog,
  invokeDaemonBridge: invokeDaemonBridge,
};
