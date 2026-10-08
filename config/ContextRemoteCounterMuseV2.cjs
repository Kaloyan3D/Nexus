'use strict';
const https = require('node:https');
const crypto = require('node:crypto');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const REMOTE_SCHEMA_VERSION = 1;
const REMOTE_REVISION_V1 = 'meta-muse-input-tokens-api-v1';
const REMOTE_FINGERPRINT_V1 = 'meta-muse-input-tokens-api-v1';
const COUNT_PATH_V1 = '/v1/responses/input_tokens';
const RESPONSES_PATH_V1 = '/v1/responses';
const META_HOST_V1 = 'api.meta.ai';
const REMOTE_EXACT_KEYS = Object.freeze(['schemaVersion', 'provider', 'model', 'endpoint', 'fingerprint', 'revision', 'source', 'verified']);
const PRODUCTION_REMOTE_ENTRIES = Object.freeze([
  Object.freeze({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', host: META_HOST_V1, countPath: COUNT_PATH_V1, responsesPath: RESPONSES_PATH_V1 }),
]);
// Availability policy for the authoritative remote counter. None of these
// values can weaken exactness: every count is still the provider's integer
// for the exact POSTed bytes, or no count at all (the caller falls back to
// the unmodified LEGACY request).
const RESILIENCE_POLICY_V1 = Object.freeze({
  initialConcurrency: 4,
  minConcurrency: 1,
  maxConcurrency: 8,
  growAfterSuccesses: 20,
  maxAttempts: 3,
  // One compilation's whole counting budget. Past it, LEGACY is the better
  // turn than a stalled one.
  operationDeadlineMs: 8000,
  // Text phases may not eat the time the final payload count needs.
  payloadReserveMs: 3000,
  textAttemptTimeoutMs: 5000,
  payloadAttemptTimeoutMs: 10000,
  transientBackoffBaseMs: 250,
  rateLimitBackoffBaseMs: 500,
  backoffCapMs: 2000,
  retryAfterCapMs: 120000,
  exhaustedThreshold: 2,
  exhaustedCooldownMs: 30000,
  exhaustedCooldownCapMs: 120000,
  // Process-wide retry token bucket: each first attempt earns `ratio` of a
  // retry, capped at `capacity` (sustained retries <= ~15% of first attempts).
  retryBudgetRatio: 0.15,
  retryBudgetCapacity: 10,
  cacheCapacity: 50000,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  backgroundDeadlineMs: 60000,
  backgroundMaxInFlight: 1,
  prewarmMaxTexts: 256,
  localWorkers: 8,
});
// Safe failure kinds (thrown as 'remote-counter-<kind>'; never raw text).
const COUNTER_FAILURE_KINDS = Object.freeze([
  'counter-auth', 'counter-rate-limited', 'counter-transient', 'counter-deadline', 'counter-gate-open',
  'counter-malformed', 'counter-unsupported', 'counter-request-invalid', 'counter-cancelled',
]);
// Network error codes that may appear in telemetry; anything else is OTHER.
const NET_ERROR_CODES = Object.freeze(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'ABORT_ERR']);
const RETRYABLE_NET_CODES = Object.freeze(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);
const GATE_CLEAR = 'CLEAR';
const GATE_COOLING = 'COOLING';
const GATE_PROBE = 'PROBE';
const DEFAULT_TRANSPORT_SCOPE = 'https';
const RETRY_AFTER_SLACK_MS = 5;
const DEADLINE_SLACK_MS = 25;
const RESILIENCE_KEY = Symbol.for('nexus.ccv2.remote-counter.resilience.v1');
function failRemote(code, detail) {
  throw new Error('remote-counter-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}
function safeNetCodeOf(code) {
  return typeof code === 'string' && NET_ERROR_CODES.indexOf(code) !== -1 ? code : 'OTHER';
}
// Content-free transport failure: a fixed message, an allow-listed code and
// whether the socket was a reused keep-alive socket. The underlying error's
// message is never carried (it may echo request content).
function transportErrorV2(code, reusedSocket) {
  const error = new Error('remote-counter-transport-failure (DISCARDABLE)');
  error.code = safeNetCodeOf(code);
  error.reusedSocket = reusedSocket === true;
  return error;
}
function counterFailureV2(kind, info) {
  const detail = isPlainObject(info) ? info : {};
  const error = new Error('remote-counter-' + kind + ' (DISCARDABLE)');
  error.code = kind;
  error.counterFailure = Object.freeze({
    kind,
    httpStatus: Number.isInteger(detail.httpStatus) ? detail.httpStatus : null,
    netErrorCode: typeof detail.netErrorCode === 'string' ? safeNetCodeOf(detail.netErrorCode) : null,
    attempts: Number.isInteger(detail.attempts) ? detail.attempts : 0,
    exhaustReason: typeof detail.exhaustReason === 'string' ? detail.exhaustReason : null,
  });
  return error;
}
const COUNT_AGENT = new https.Agent({ keepAlive: true, maxSockets: RESILIENCE_POLICY_V1.maxConcurrency });
function httpsPostJsonV2(input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;
    const signal = input.signal !== undefined && input.signal !== null ? input.signal : null;
    const reused = () => req !== null && req.reusedSocket === true;
    const onAbort = () => {
      try { if (req !== null) req.destroy(); } catch (error) { void error; }
      done(() => reject(transportErrorV2('ABORT_ERR', reused())));
    };
    function done(fn) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (signal !== null) signal.removeEventListener('abort', onAbort);
      fn();
    }
    if (signal !== null && signal.aborted) {
      reject(transportErrorV2('ABORT_ERR', false));
      return;
    }
    try {
      const body = typeof input.bodyJson === 'string' ? input.bodyJson : JSON.stringify(input.bodyJson);
      req = https.request({
        hostname: input.hostname,
        path: input.reqPath,
        method: 'POST',
        agent: COUNT_AGENT,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + input.apiKey,
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('error', (error) => done(() => reject(transportErrorV2(error && error.code, reused()))));
        res.on('end', () => done(() => resolve({
          status: res.statusCode,
          bodyText: text,
          retryAfter: typeof res.headers['retry-after'] === 'string' ? res.headers['retry-after'] : null,
        })));
      });
      // Whole-attempt timeout (the socket idle timeout alone never bounds a
      // slowly trickling response).
      timer = setTimeout(() => {
        try { req.destroy(); } catch (error) { void error; }
        done(() => reject(transportErrorV2('ETIMEDOUT', reused())));
      }, input.timeoutMs);
      req.on('error', (error) => done(() => reject(transportErrorV2(error && error.code, reused()))));
      if (signal !== null) signal.addEventListener('abort', onAbort, { once: true });
      req.write(body);
      req.end();
    } catch (error) {
      done(() => reject(transportErrorV2(error && error.code, reused())));
    }
  });
}
function resolveRemoteEntryV2(provider, model) {
  if (typeof provider !== 'string' || typeof model !== 'string') return null;
  for (const entry of PRODUCTION_REMOTE_ENTRIES) {
    if (entry.provider === provider && entry.model === model) return entry;
  }
  return null;
}
function resolveMuseRemoteV2(input) {
  try {
    if (!isPlainObject(input)) return null;
    const found = resolveRemoteEntryV2(input.provider, input.model);
    if (found === null) return null;
    return Object.freeze({
      schemaVersion: REMOTE_SCHEMA_VERSION,
      provider: found.provider,
      model: found.model,
      endpoint: Object.freeze({ host: found.host, countPath: found.countPath, responsesPath: found.responsesPath }),
      fingerprint: REMOTE_FINGERPRINT_V1,
      revision: REMOTE_REVISION_V1,
      source: 'meta-official-count-endpoint',
      verified: true,
    });
  } catch (error) {
    void error;
    return null;
  }
}
function classifyCountResponseV2(status, bodyText) {
  if (typeof status !== 'number') return { ok: false, kind: 'transport' };
  if (status === 200) {
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      void error;
      return { ok: false, kind: 'malformed' };
    }
    if (!isPlainObject(body) || !Number.isInteger(body.input_tokens) || body.input_tokens < 0) {
      return { ok: false, kind: 'malformed' };
    }
    return { ok: true, kind: null, tokens: body.input_tokens, object: typeof body.object === 'string' ? body.object : null };
  }
  if (status === 401 || status === 403) return { ok: false, kind: 'auth' };
  if (status === 404) return { ok: false, kind: 'unsupported' };
  if (status === 429) return { ok: false, kind: 'rate-limited' };
  if (status >= 500) return { ok: false, kind: 'transport' };
  let detail = '';
  try {
    const body = JSON.parse(bodyText);
    detail = String((body && body.error && (body.error.message || body.error.code)) || '').slice(0, 160);
  } catch (error) {
    void error;
  }
  if (/model/i.test(detail)) return { ok: false, kind: 'model-unsupported', detail };
  return { ok: false, kind: 'request-invalid', detail };
}
/**
 * Retry-After as milliseconds from `nowMs`: delta-seconds or an HTTP-date.
 * Anything else is null (no server hint).
 */
function parseRetryAfterMsV2(value, nowMs) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  if (text === '' || text.length > 64) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}
function retryAfterOfOutcomeV2(outcome) {
  if (!isPlainObject(outcome)) return null;
  if (outcome.retryAfter !== undefined && outcome.retryAfter !== null) return outcome.retryAfter;
  if (isPlainObject(outcome.headers)) {
    const value = outcome.headers['retry-after'] !== undefined ? outcome.headers['retry-after'] : outcome.headers['Retry-After'];
    if (value !== undefined) return value;
  }
  return null;
}
/**
 * One attempt's outcome -> what the retry loop does with it. Pure policy:
 * { ok } | { kind, retry, overload, httpStatus, netErrorCode, backoffBaseMs,
 *   maxRetries, latch, resetOnReused }.
 */
function classifyAttemptV2(outcome, transportError, policy) {
  if (transportError !== null) {
    const code = safeNetCodeOf(transportError && transportError.code);
    const retry = RETRYABLE_NET_CODES.indexOf(code) !== -1;
    return {
      ok: false, kind: 'counter-transient', retry, overload: false, httpStatus: null, netErrorCode: code,
      backoffBaseMs: policy.transientBackoffBaseMs, maxRetries: null, latch: null,
      resetOnReused: (code === 'ECONNRESET' || code === 'EPIPE') && transportError.reusedSocket === true,
    };
  }
  if (!isPlainObject(outcome) || typeof outcome.status !== 'number') {
    return { ok: false, kind: 'counter-transient', retry: false, overload: false, httpStatus: null, netErrorCode: 'OTHER', latch: null };
  }
  const status = outcome.status;
  const base = { ok: false, httpStatus: status, netErrorCode: null, latch: null, overload: false, maxRetries: null, resetOnReused: false };
  if (status === 200) {
    const classified = classifyCountResponseV2(status, outcome.bodyText);
    if (classified.ok === true) return { ok: true, tokens: classified.tokens, object: classified.object, httpStatus: 200 };
    return Object.assign(base, { kind: 'counter-malformed', retry: false });
  }
  if (status === 401 || status === 403) return Object.assign(base, { kind: 'counter-auth', retry: false, latch: 'auth' });
  if (status === 404) return Object.assign(base, { kind: 'counter-unsupported', retry: false, latch: 'unsupported' });
  if (status === 429) {
    return Object.assign(base, { kind: 'counter-rate-limited', retry: true, overload: true, backoffBaseMs: policy.rateLimitBackoffBaseMs });
  }
  if (status === 408) return Object.assign(base, { kind: 'counter-transient', retry: true, backoffBaseMs: policy.transientBackoffBaseMs });
  if (status === 501 || status === 505) return Object.assign(base, { kind: 'counter-transient', retry: false });
  if (status === 500) return Object.assign(base, { kind: 'counter-transient', retry: true, maxRetries: 1, backoffBaseMs: policy.transientBackoffBaseMs });
  if (status === 503) return Object.assign(base, { kind: 'counter-transient', retry: true, overload: true, backoffBaseMs: policy.transientBackoffBaseMs });
  if (status >= 500) return Object.assign(base, { kind: 'counter-transient', retry: true, backoffBaseMs: policy.transientBackoffBaseMs });
  const classified = classifyCountResponseV2(status, outcome.bodyText);
  if (classified.kind === 'model-unsupported') return Object.assign(base, { kind: 'counter-unsupported', retry: false, latch: 'unsupported' });
  return Object.assign(base, { kind: 'counter-request-invalid', retry: false });
}
// ---------------------------------------------------------------------------
// Process-global resilience state: limiter + gate per counter scope, the
// exact-count cache, failure latches and the retry budget. Shared through
// Symbol.for by every loaded copy of this module (each agent preset ships
// its own closure copy), so one process has ONE concurrency limit per scope.
// ---------------------------------------------------------------------------
function createCounterResilienceV2(options) {
  const opts = isPlainObject(options) ? options : {};
  const policy = Object.freeze(Object.assign({}, RESILIENCE_POLICY_V1, isPlainObject(opts.policy) ? opts.policy : {}));
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const secret = crypto.randomBytes(32);
  const cache = new Map();
  const scopes = new Map();
  const authLatches = new Map();
  const unsupportedLatches = new Set();
  const transportIds = new WeakMap();
  const backgroundOps = new Set();
  const bucket = { tokens: policy.retryBudgetCapacity };
  const stats = { httpRequests: 0, firstAttempts: 0, retries: 0, retriesDenied: 0, cacheHits: 0, cacheMisses: 0, epochBumps: 0 };
  let cacheEpoch = 0;
  let nextTransportId = 1;
  let nextOperationId = 1;
  function credScopeOf(apiKey) {
    return crypto.createHmac('sha256', secret).update(String(apiKey), 'utf8').digest('hex').slice(0, 32);
  }
  function transportScopeOf(transport) {
    if (transport === null || transport === undefined) return DEFAULT_TRANSPORT_SCOPE;
    let id = transportIds.get(transport);
    if (id === undefined) {
      id = 'transport-' + nextTransportId;
      nextTransportId += 1;
      transportIds.set(transport, id);
    }
    return id;
  }
  function limiterOf() {
    return { limit: policy.initialConcurrency, inFlight: 0, backgroundInFlight: 0, successStreak: 0, foreground: [], background: [] };
  }
  function scopeOf(scopeId) {
    let scope = scopes.get(scopeId);
    if (scope === undefined) {
      scope = { limiter: limiterOf(), gate: { notBefore: 0, consecutiveExhausted: 0, lastCooldownMs: 0, probeOwner: null } };
      scopes.set(scopeId, scope);
    }
    return scope;
  }
  // ---- limiter (AIMD) ----
  function pump(limiter) {
    while (limiter.inFlight < limiter.limit) {
      if (limiter.foreground.length > 0) {
        limiter.foreground.shift().grant();
        continue;
      }
      // Background work always leaves one slot free for foreground work.
      if (limiter.background.length > 0 && limiter.backgroundInFlight < policy.backgroundMaxInFlight
        && limiter.inFlight < limiter.limit - 1) {
        limiter.background.shift().grant();
        continue;
      }
      break;
    }
  }
  function acquire(limiter, priority, signal, waitUntil) {
    return new Promise((resolve, reject) => {
      const background = priority === 'background';
      const queue = background ? limiter.background : limiter.foreground;
      let timer = null;
      let finished = false;
      const cleanup = () => {
        finished = true;
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const leave = (error) => {
        if (finished) return;
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        cleanup();
        reject(error);
      };
      function onAbort() { leave(counterFailureV2('counter-cancelled')); }
      const waiter = {
        grant() {
          if (finished) return;
          cleanup();
          limiter.inFlight += 1;
          if (background) limiter.backgroundInFlight += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            limiter.inFlight -= 1;
            if (background) limiter.backgroundInFlight -= 1;
            pump(limiter);
          });
        },
      };
      if (signal && signal.aborted) {
        reject(counterFailureV2('counter-cancelled'));
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const remaining = waitUntil - now();
      if (remaining <= 0) {
        cleanup();
        reject(counterFailureV2('counter-deadline', { exhaustReason: 'deadline' }));
        return;
      }
      timer = setTimeout(() => leave(counterFailureV2('counter-deadline', { exhaustReason: 'deadline' })), remaining);
      if (typeof timer.unref === 'function') timer.unref();
      queue.push(waiter);
      pump(limiter);
    });
  }
  function limiterSuccess(limiter) {
    limiter.successStreak += 1;
    if (limiter.successStreak >= policy.growAfterSuccesses) {
      limiter.successStreak = 0;
      if (limiter.limit < policy.maxConcurrency) limiter.limit += 1;
      pump(limiter);
    }
  }
  function limiterFailure(limiter, overload) {
    limiter.successStreak = 0;
    if (overload === true) limiter.limit = Math.max(policy.minConcurrency, Math.floor(limiter.limit / 2));
  }
  // ---- cooldown gate ----
  function gateStateOf(gate, at) {
    if (at < gate.notBefore) return GATE_COOLING;
    if (gate.notBefore > 0) return GATE_PROBE;
    return GATE_CLEAR;
  }
  // true when this operation may make a remote attempt now.
  function gateAdmit(gate, opId, background) {
    const state = gateStateOf(gate, now());
    if (state === GATE_CLEAR) return true;
    if (state === GATE_COOLING || background) return false;
    // PROBE: exactly one operation probes; every other one fails fast.
    if (gate.probeOwner === null) gate.probeOwner = opId;
    return gate.probeOwner === opId;
  }
  function gateCoolFor(gate, ms) {
    const bounded = Math.max(0, Math.min(policy.retryAfterCapMs, ms));
    gate.notBefore = Math.max(gate.notBefore, now() + bounded);
  }
  function gateRecordExhausted(gate, opId) {
    gate.consecutiveExhausted += 1;
    const wasProbe = gate.probeOwner === opId;
    if (wasProbe) gate.probeOwner = null;
    if (wasProbe || gate.consecutiveExhausted >= policy.exhaustedThreshold) {
      const cooldown = gate.lastCooldownMs > 0
        ? Math.min(policy.exhaustedCooldownCapMs, gate.lastCooldownMs * 2)
        : policy.exhaustedCooldownMs;
      gate.lastCooldownMs = cooldown;
      gate.notBefore = Math.max(gate.notBefore, now() + cooldown);
    }
  }
  function gateRecordSuccess(gate, opId) {
    gate.consecutiveExhausted = 0;
    if (gate.probeOwner === opId) gate.probeOwner = null;
    // Never erase a still-running Retry-After window set by another caller.
    if (now() >= gate.notBefore) {
      gate.notBefore = 0;
      gate.lastCooldownMs = 0;
      gate.probeOwner = null;
    }
  }
  function gateRelease(gate, opId) {
    if (gate.probeOwner === opId) gate.probeOwner = null;
  }
  // ---- latches ----
  function authLatched(baseScopeId, credScope) {
    const latched = authLatches.get(baseScopeId);
    if (latched === undefined) return false;
    if (latched === credScope) return true;
    // A different credential identity clears the latch.
    authLatches.delete(baseScopeId);
    return false;
  }
  function latchAuth(baseScopeId, credScope) { authLatches.set(baseScopeId, credScope); }
  function unsupportedLatched(contractKey) { return unsupportedLatches.has(contractKey); }
  function latchUnsupported(contractKey) { unsupportedLatches.add(contractKey); }
  // ---- exact-count cache ----
  function cacheKeyOf(parts) {
    return { key: sha256Hex(canonicalJsonOf(Object.assign({}, parts, { cacheEpoch }))), epoch: cacheEpoch };
  }
  function cacheGet(key) {
    const entry = cache.get(key);
    if (entry === undefined) return null;
    if (now() - entry.observedAt > policy.cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }
  function cachePut(key, epoch, tokens) {
    // A count observed under a superseded epoch is never stored.
    if (epoch !== cacheEpoch || !Number.isInteger(tokens) || tokens < 0) return;
    cache.delete(key);
    cache.set(key, Object.freeze({ tokens, observedAt: now() }));
    while (cache.size > policy.cacheCapacity) cache.delete(cache.keys().next().value);
  }
  function bumpCacheEpochV2() {
    cacheEpoch += 1;
    cache.clear();
    stats.epochBumps += 1;
    return cacheEpoch;
  }
  // ---- retry budget ----
  function noteFirstAttempt() {
    stats.firstAttempts += 1;
    bucket.tokens = Math.min(policy.retryBudgetCapacity, bucket.tokens + policy.retryBudgetRatio);
  }
  function takeRetryToken() {
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      stats.retries += 1;
      return true;
    }
    stats.retriesDenied += 1;
    return false;
  }
  function cancelBackgroundV2() {
    for (const controller of Array.from(backgroundOps)) {
      try { controller.abort(); } catch (error) { void error; }
    }
    backgroundOps.clear();
  }
  // Content-free view of the cache for audits: digest keys and values only.
  function inspectCacheV2() {
    return Array.from(cache.entries()).map(([key, value]) => Object.freeze({ key, value }));
  }
  function snapshotV2() {
    const scopeRows = [];
    for (const [scopeId, scope] of scopes) {
      scopeRows.push(Object.freeze({
        scopeId: scopeId.slice(0, 16),
        concurrencyLimit: scope.limiter.limit,
        inFlight: scope.limiter.inFlight,
        queued: scope.limiter.foreground.length + scope.limiter.background.length,
        gateState: gateStateOf(scope.gate, now()),
        coolingRemainingMs: Math.max(0, scope.gate.notBefore - now()),
        probeHeld: scope.gate.probeOwner !== null,
        consecutiveExhausted: scope.gate.consecutiveExhausted,
      }));
    }
    return Object.freeze({
      cacheEpoch, cacheSize: cache.size, retryTokens: bucket.tokens,
      stats: Object.freeze(Object.assign({}, stats)), scopes: Object.freeze(scopeRows),
    });
  }
  return Object.freeze({
    version: 1,
    policy,
    now,
    random,
    stats,
    credScopeOf,
    transportScopeOf,
    scopeOf,
    acquire,
    limiterSuccess,
    limiterFailure,
    gateStateOf,
    gateAdmit,
    gateCoolFor,
    gateRecordExhausted,
    gateRecordSuccess,
    gateRelease,
    authLatched,
    latchAuth,
    unsupportedLatched,
    latchUnsupported,
    cacheKeyOf,
    cacheGet,
    cachePut,
    bumpCacheEpochV2,
    cacheEpochV2: () => cacheEpoch,
    noteFirstAttempt,
    takeRetryToken,
    backgroundOps,
    nextOperationIdV2: () => nextOperationId++,
    cancelBackgroundV2,
    inspectCacheV2,
    snapshotV2,
  });
}
function processCounterResilienceV2() {
  const existing = globalThis[RESILIENCE_KEY];
  if (existing !== undefined && existing !== null && existing.version === 1) return existing;
  const created = createCounterResilienceV2();
  Object.defineProperty(globalThis, RESILIENCE_KEY, { value: created, enumerable: false, configurable: false, writable: false });
  return created;
}
/**
 * Drift response: the provider billed more input than the authoritative
 * pre-count allowed. Every cached exact count is dropped and the epoch moves
 * on, so no count observed before the drift is reused as authority.
 */
function invalidateExactCountCacheV2(resilience) {
  const state = resilience === undefined || resilience === null ? processCounterResilienceV2() : resilience;
  return state.bumpCacheEpochV2();
}
function sleepAbortableV2(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(counterFailureV2('counter-cancelled'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(counterFailureV2('counter-cancelled'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
// Settles with the transport's promise, or rejects as soon as the operation
// is cancelled (an injected transport may ignore the abort signal).
function raceAbortV2(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(counterFailureV2('counter-cancelled'));
      return;
    }
    const onAbort = () => reject(counterFailureV2('counter-cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
function createMuseRemoteCounterV2(input) {
  if (!isPlainObject(input)) failRemote('counter-input-invalid', 'remote counter input must be an object');
  const descriptor = isPlainObject(input.descriptor) ? input.descriptor : null;
  const apiKey = input.apiKey;
  if (descriptor === null || descriptor.verified !== true || descriptor.fingerprint !== REMOTE_FINGERPRINT_V1) {
    failRemote('counter-input-invalid', 'a verified remote descriptor for this contract is required');
  }
  if (typeof apiKey !== 'string' || apiKey === '') failRemote('counter-unavailable', 'no credential for the remote count endpoint');
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    failRemote('counter-input-invalid', 'timeoutMs must be positive');
  }
  if (input.deadlineMs !== undefined && input.deadlineMs !== null && (!Number.isInteger(input.deadlineMs) || input.deadlineMs <= 0)) {
    failRemote('counter-input-invalid', 'deadlineMs must be positive');
  }
  const injected = input.transport !== undefined && input.transport !== null;
  const transport = injected ? input.transport : { postJson: httpsPostJsonV2 };
  if (typeof transport.postJson !== 'function') failRemote('counter-input-invalid', 'transport.postJson is required');
  const entry = resolveRemoteEntryV2(descriptor.provider, descriptor.model);
  if (entry === null) failRemote('counter-input-invalid', 'descriptor route is not registered');
  const resilience = input.resilience !== undefined && input.resilience !== null ? input.resilience : processCounterResilienceV2();
  const policy = resilience.policy;
  // An explicit timeoutMs (M01/canary scripts) is the per-attempt timeout
  // for every count and widens the implicit operation deadline to fit it.
  const explicitTimeout = Number.isInteger(input.timeoutMs) ? input.timeoutMs : null;
  const textTimeoutMs = explicitTimeout !== null ? explicitTimeout : policy.textAttemptTimeoutMs;
  const payloadTimeoutMs = explicitTimeout !== null ? explicitTimeout : policy.payloadAttemptTimeoutMs;
  const defaultDeadlineMs = Number.isInteger(input.deadlineMs)
    ? input.deadlineMs
    : Math.max(policy.operationDeadlineMs, explicitTimeout !== null ? explicitTimeout : 0);
  // Identity. credScope is a keyed one-way id: the key itself is never held
  // by the shared state or the cache.
  const credScope = resilience.credScopeOf(apiKey);
  const transportScope = resilience.transportScopeOf(injected ? transport : null);
  const contractIdentity = Object.freeze({
    schemaVersion: REMOTE_SCHEMA_VERSION, fingerprint: REMOTE_FINGERPRINT_V1, revision: REMOTE_REVISION_V1,
    host: entry.host, countPath: entry.countPath, model: entry.model,
  });
  const contractKey = sha256Hex(canonicalJsonOf({ contractIdentity, transportScope }));
  const baseScopeId = sha256Hex(canonicalJsonOf({ host: entry.host, model: entry.model, transportScope }));
  const scopeId = sha256Hex(canonicalJsonOf({ host: entry.host, model: entry.model, credScope, transportScope }));
  const scope = resilience.scopeOf(scopeId);
  function beginCountOperationV2(options) {
    const opts = isPlainObject(options) ? options : {};
    const background = opts.priority === 'background';
    const deadlineMs = Number.isInteger(opts.deadlineMs) && opts.deadlineMs > 0
      ? opts.deadlineMs
      : (background ? policy.backgroundDeadlineMs : defaultDeadlineMs);
    const opId = resilience.nextOperationIdV2();
    const startedAt = resilience.now();
    const deadlineAt = startedAt + deadlineMs;
    const textDeadlineAt = background ? deadlineAt : deadlineAt - Math.min(policy.payloadReserveMs, Math.floor(deadlineMs / 2));
    const controller = new AbortController();
    if (background) resilience.backgroundOps.add(controller);
    const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    const op = {
      httpRequests: 0, cacheHits: 0, cacheMisses: 0, liveSuccesses: 0, exhaustedTransient: false, deadlineHit: false,
      retryAfterApplied: false, failure: null, decidingAttempts: 0, payloadSource: null, finished: null,
    };
    const priority = background ? 'background' : 'foreground';
    function fail(kind, info) {
      const error = counterFailureV2(kind, info);
      if (op.failure === null) op.failure = error.counterFailure;
      return error;
    }
    // Deadline is an availability failure (the endpoint did not answer in
    // time), recorded once; a sibling cancellation is not a failure at all.
    function deadlineFailure(info) {
      op.deadlineHit = true;
      return fail('counter-deadline', Object.assign({ exhaustReason: 'deadline' }, info || {}));
    }
    function cancelledFailure(info) {
      return resilience.now() >= deadlineAt ? deadlineFailure(info) : counterFailureV2('counter-cancelled');
    }
    async function countBodyV2(bodyObject, phase) {
      if (op.finished !== null) throw counterFailureV2('counter-cancelled');
      const bodyJson = canonicalJsonOf(bodyObject);
      const cacheSlot = resilience.cacheKeyOf({
        bodyDigest: sha256Hex(bodyJson), contract: contractIdentity, credScope, transportScope,
      });
      const hit = resilience.cacheGet(cacheSlot.key);
      if (hit !== null) {
        op.cacheHits += 1;
        resilience.stats.cacheHits += 1;
        return { tokens: hit.tokens, object: null, source: 'cache', attempts: 0 };
      }
      op.cacheMisses += 1;
      resilience.stats.cacheMisses += 1;
      if (resilience.authLatched(baseScopeId, credScope)) throw fail('counter-auth', { exhaustReason: 'latched' });
      if (resilience.unsupportedLatched(contractKey)) throw fail('counter-unsupported', { exhaustReason: 'latched' });
      const callDeadline = phase === 'payload' ? deadlineAt : textDeadlineAt;
      const attemptTimeout = phase === 'payload' ? payloadTimeoutMs : textTimeoutMs;
      let resetRetried = false;
      let last = null;
      for (let attempt = 1; ; attempt += 1) {
        const prior = { attempts: attempt - 1, httpStatus: last && last.httpStatus, netErrorCode: last && last.netErrorCode };
        if (controller.signal.aborted) throw cancelledFailure(prior);
        if (!resilience.gateAdmit(scope.gate, opId, background)) {
          throw fail('counter-gate-open', Object.assign({ exhaustReason: 'gate' }, prior));
        }
        if (callDeadline - resilience.now() <= 0) throw deadlineFailure(prior);
        let release = null;
        try {
          release = await resilience.acquire(scope.limiter, priority, controller.signal, callDeadline);
        } catch (error) {
          void error;
          if (controller.signal.aborted) throw cancelledFailure(prior);
          throw deadlineFailure(prior);
        }
        const remaining = callDeadline - resilience.now();
        if (remaining <= 0) {
          release();
          throw deadlineFailure(prior);
        }
        let outcome = null;
        let transportError = null;
        const cutByDeadline = remaining < attemptTimeout;
        op.httpRequests += 1;
        resilience.stats.httpRequests += 1;
        if (attempt === 1) resilience.noteFirstAttempt();
        try {
          outcome = await raceAbortV2(transport.postJson({
            hostname: entry.host,
            reqPath: entry.countPath,
            apiKey,
            bodyJson,
            timeoutMs: Math.max(1, Math.min(attemptTimeout, remaining)),
            signal: controller.signal,
          }), controller.signal);
        } catch (error) {
          transportError = error === null || error === undefined ? transportErrorV2('OTHER', false) : error;
        } finally {
          release();
        }
        if (controller.signal.aborted) throw cancelledFailure(Object.assign({}, prior, { attempts: attempt }));
        const verdict = classifyAttemptV2(outcome, transportError, policy);
        if (verdict.ok === true) {
          resilience.limiterSuccess(scope.limiter);
          op.liveSuccesses += 1;
          resilience.cachePut(cacheSlot.key, cacheSlot.epoch, verdict.tokens);
          return { tokens: verdict.tokens, object: verdict.object, source: 'live', attempts: attempt };
        }
        last = verdict;
        resilience.limiterFailure(scope.limiter, verdict.overload);
        const info = { httpStatus: verdict.httpStatus, netErrorCode: verdict.netErrorCode, attempts: attempt };
        // An attempt whose timeout was cut to the remaining deadline and ran
        // out WITH the deadline is the deadline, not an endpoint verdict.
        if (cutByDeadline && verdict.netErrorCode === 'ETIMEDOUT' && callDeadline - resilience.now() <= DEADLINE_SLACK_MS) {
          throw deadlineFailure(info);
        }
        if (verdict.latch === 'auth') resilience.latchAuth(baseScopeId, credScope);
        if (verdict.latch === 'unsupported') resilience.latchUnsupported(contractKey);
        let retryAfterMs = null;
        if (verdict.kind === 'counter-rate-limited') {
          retryAfterMs = parseRetryAfterMsV2(retryAfterOfOutcomeV2(outcome), resilience.now());
          // Every later caller respects the server's window (capped).
          if (retryAfterMs !== null) resilience.gateCoolFor(scope.gate, retryAfterMs);
        }
        if (verdict.retry !== true) throw fail(verdict.kind, info);
        const exhausted = (reason) => {
          if (!background) op.exhaustedTransient = true;
          return fail(verdict.kind, Object.assign({}, info, { exhaustReason: reason }));
        };
        // Background (pre-warm) work never retries and never spends budget.
        if (background) throw exhausted('background');
        if (attempt >= policy.maxAttempts) throw exhausted('attempts');
        if (verdict.maxRetries !== null && attempt - 1 >= verdict.maxRetries) throw exhausted('attempts');
        let delay = 0;
        if (retryAfterMs !== null) {
          // Never sooner than Retry-After (timer slack included).
          delay = retryAfterMs + RETRY_AFTER_SLACK_MS;
        } else if (verdict.resetOnReused === true && resetRetried !== true) {
          // A reset on a reused keep-alive socket is the stale-socket race:
          // one immediate retry on a fresh socket.
          resetRetried = true;
          delay = 0;
        } else {
          const ceiling = Math.min(policy.backoffCapMs, verdict.backoffBaseMs * Math.pow(2, attempt - 1));
          delay = Math.floor(resilience.random() * ceiling);
        }
        // Never wait past this call's deadline inside the current request.
        if (resilience.now() + delay >= callDeadline) throw exhausted('deadline');
        if (!resilience.takeRetryToken()) throw exhausted('budget');
        if (retryAfterMs !== null) op.retryAfterApplied = true;
        if (delay > 0) {
          try {
            await sleepAbortableV2(delay, controller.signal);
          } catch (error) {
            void error;
            throw cancelledFailure(info);
          }
        }
      }
    }
    async function countTextsV2(texts) {
      if (!Array.isArray(texts)) failRemote('counter-input-invalid', 'texts must be an array');
      const unique = [];
      const seen = new Set();
      for (const text of texts) {
        if (typeof text !== 'string') failRemote('counter-input-invalid', 'every counted text must be a string');
        if (!seen.has(text)) { seen.add(text); unique.push(text); }
      }
      // Bounded local fan-out; every remote attempt additionally waits for a
      // slot of the process-global scope limiter. Results land by index.
      const results = new Array(unique.length);
      let next = 0;
      let firstError = null;
      const worker = async () => {
        while (firstError === null && next < unique.length) {
          const index = next;
          next += 1;
          try {
            const counted = await countBodyV2({ model: entry.model, input: unique[index] }, 'text');
            results[index] = counted.tokens;
          } catch (error) {
            if (firstError === null) {
              firstError = error;
              // Terminal for this compilation: cancel queued and in-flight
              // siblings instead of leaving remote calls running.
              controller.abort();
            }
          }
        }
      };
      const workers = [];
      for (let index = 0; index < Math.min(policy.localWorkers, unique.length); index += 1) workers.push(worker());
      await Promise.all(workers);
      if (firstError !== null) throw firstError;
      const table = new Map();
      for (let index = 0; index < unique.length; index += 1) table.set(unique[index], results[index]);
      return texts.map((text) => table.get(text));
    }
    async function countPayloadV2(shape) {
      if (!isPlainObject(shape)) failRemote('counter-input-invalid', 'payload shape must be an object');
      const body = { model: entry.model };
      if (shape.input !== undefined) body.input = shape.input;
      if (shape.instructions !== undefined) body.instructions = shape.instructions;
      if (shape.tools !== undefined) body.tools = shape.tools;
      if (shape.max_output_tokens !== undefined) body.max_output_tokens = shape.max_output_tokens;
      if (shape.reasoning !== undefined) body.reasoning = shape.reasoning;
      try {
        const counted = await countBodyV2(body, 'payload');
        op.payloadSource = counted.source;
        op.decidingAttempts = counted.attempts;
        return { tokens: counted.tokens, object: counted.object, source: counted.source };
      } catch (error) {
        controller.abort();
        throw error;
      }
    }
    function finish() {
      if (op.finished !== null) return op.finished;
      clearTimeout(deadlineTimer);
      controller.abort();
      if (background) {
        resilience.backgroundOps.delete(controller);
      } else if (op.exhaustedTransient || (op.deadlineHit && op.liveSuccesses === 0)) {
        // Retries exhausted, or the deadline passed without one live answer.
        // A deadline reached while counts were succeeding is a slow cold
        // enumeration, not an unavailable endpoint: it never cools the gate.
        resilience.gateRecordExhausted(scope.gate, opId);
      } else if (op.liveSuccesses > 0 && op.failure === null) {
        resilience.gateRecordSuccess(scope.gate, opId);
      } else {
        resilience.gateRelease(scope.gate, opId);
      }
      const failure = op.failure;
      op.finished = Object.freeze({
        counterHttpRequests: op.httpRequests,
        counterCacheHits: op.cacheHits,
        counterCacheMisses: op.cacheMisses,
        counterConcurrencyLimit: scope.limiter.limit,
        counterGateState: resilience.gateStateOf(scope.gate, resilience.now()),
        counterAttempts: failure !== null ? failure.attempts : op.decidingAttempts,
        counterFailureKind: failure !== null ? failure.kind : null,
        counterHttpStatus: failure !== null ? failure.httpStatus : null,
        counterNetErrorCode: failure !== null ? failure.netErrorCode : null,
        counterExhaustReason: failure !== null ? failure.exhaustReason : null,
        counterDeadlineMs: deadlineMs,
        counterElapsedMs: Math.max(0, resilience.now() - startedAt),
        counterSource: op.payloadSource,
        retryAfterApplied: op.retryAfterApplied,
        cacheEpoch: resilience.cacheEpochV2(),
      });
      return op.finished;
    }
    return Object.freeze({ countTextsV2, countPayloadV2, finish, signal: controller.signal });
  }
  async function withOperationV2(run) {
    const op = beginCountOperationV2(null);
    try {
      return await run(op);
    } finally {
      op.finish();
    }
  }
  async function countTextsV2(texts) {
    return withOperationV2((op) => op.countTextsV2(texts));
  }
  async function countPayloadV2(shape) {
    return withOperationV2((op) => op.countPayloadV2(shape));
  }
  /**
   * Background pre-warm: count cache misses among `texts` at background
   * priority. Never retries, never probes a cooling gate, never throws.
   */
  async function prewarmTextsV2(texts) {
    const summary = { attempted: 0, cached: 0, counted: 0, skipped: null };
    try {
      if (!Array.isArray(texts)) return Object.freeze(Object.assign(summary, { skipped: 'invalid' }));
      if (resilience.gateStateOf(scope.gate, resilience.now()) !== GATE_CLEAR) {
        return Object.freeze(Object.assign(summary, { skipped: 'gate' }));
      }
      if (resilience.authLatched(baseScopeId, credScope) || resilience.unsupportedLatched(contractKey)) {
        return Object.freeze(Object.assign(summary, { skipped: 'latched' }));
      }
      const unique = Array.from(new Set(texts.filter((text) => typeof text === 'string'))).slice(0, policy.prewarmMaxTexts);
      const op = beginCountOperationV2({ priority: 'background' });
      try {
        for (const text of unique) {
          if (op.signal.aborted) break;
          summary.attempted += 1;
          try {
            await op.countTextsV2([text]);
          } catch (error) {
            summary.skipped = error && error.counterFailure ? error.counterFailure.kind : 'failed';
            break;
          }
        }
      } finally {
        const done = op.finish();
        summary.cached = done.counterCacheHits;
        summary.counted = done.counterHttpRequests;
      }
    } catch (error) {
      void error;
      summary.skipped = 'failed';
    }
    return Object.freeze(summary);
  }
  function buildMemoCounterV2(table) {
    if (!(table instanceof Map)) failRemote('counter-input-invalid', 'memo table must be a Map');
    const frozen = new Map();
    for (const [text, tokens] of table) {
      if (typeof text !== 'string' || !Number.isInteger(tokens) || tokens < 0) {
        failRemote('counter-input-invalid', 'memo table carries non-countable entries');
      }
      frozen.set(text, tokens);
    }
    const counter = {
      tokenizerFingerprint: REMOTE_FINGERPRINT_V1,
      countText(text) {
        if (typeof text !== 'string') {
          throw new Error('remote-counter-memo-invalid: memo counter requires a string (DISCARDABLE)');
        }
        const hit = frozen.get(text);
        if (hit === undefined) {
          throw new Error('remote-counter-memo-miss: text was not provider-counted (DISCARDABLE)');
        }
        return hit;
      },
    };
    return Object.freeze(counter);
  }
  return Object.freeze({
    fingerprint: REMOTE_FINGERPRINT_V1,
    revision: REMOTE_REVISION_V1,
    provider: entry.provider,
    model: entry.model,
    endpoint: descriptor.endpoint,
    countTextsV2,
    countPayloadV2,
    beginCountOperationV2,
    prewarmTextsV2,
    buildMemoCounterV2,
  });
}
function describeMuseRemoteV2(descriptor) {
  try {
    if (!isPlainObject(descriptor) || descriptor.verified !== true) return Object.freeze({ valid: false });
    return Object.freeze({
      valid: true,
      provider: descriptor.provider,
      model: descriptor.model,
      fingerprint: descriptor.fingerprint,
      revision: descriptor.revision,
      source: descriptor.source,
      endpoint: descriptor.endpoint,
    });
  } catch (error) {
    void error;
    return Object.freeze({ valid: false });
  }
}
// Kept for compatibility: the longest single-attempt timeout.
const DEFAULT_TIMEOUT_MS = RESILIENCE_POLICY_V1.payloadAttemptTimeoutMs;
module.exports = {
  REMOTE_SCHEMA_VERSION,
  REMOTE_REVISION_V1,
  REMOTE_FINGERPRINT_V1,
  COUNT_PATH_V1,
  RESPONSES_PATH_V1,
  META_HOST_V1,
  DEFAULT_TIMEOUT_MS,
  REMOTE_EXACT_KEYS,
  RESILIENCE_POLICY_V1,
  COUNTER_FAILURE_KINDS,
  NET_ERROR_CODES,
  GATE_CLEAR,
  GATE_COOLING,
  GATE_PROBE,
  resolveMuseRemoteV2,
  classifyCountResponseV2,
  classifyAttemptV2,
  parseRetryAfterMsV2,
  createCounterResilienceV2,
  processCounterResilienceV2,
  invalidateExactCountCacheV2,
  createMuseRemoteCounterV2,
  describeMuseRemoteV2,
};
