'use strict';
// CCV2-RC2: availability of the authoritative Meta remote counter.
// Deterministic transport-level fault injection (no network): retry policy,
// exact-count cache, process-global AIMD limiter, cooldown gate, failure
// latches, retry budget, deadlines, pre-warm, and a Muse compiler regression
// of the live turn-2 -> counter-unavailable sequence.
const path = require('node:path');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
const muse = require(path.join(repoRoot, 'config', 'ContextCompilerActiveMuseV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DESCRIPTOR = remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
const KEY = 'test-key-resilience-SECRET-7f3a';
const okBody = (n) => JSON.stringify({ object: 'response.input_tokens', input_tokens: n });
// Fast, deterministic policy for tests (jitter = 0.5 of the ceiling).
function freshState(policy, extra) {
  return remote.createCounterResilienceV2(Object.assign({
    policy: Object.assign({
      transientBackoffBaseMs: 4, rateLimitBackoffBaseMs: 4, backoffCapMs: 16,
      operationDeadlineMs: 2000, payloadReserveMs: 500,
      exhaustedCooldownMs: 30000, exhaustedCooldownCapMs: 120000,
    }, policy || {}),
    random: () => 0.5,
  }, extra || {}));
}
// Scripted transport: plan(req, n) -> { status, bodyText, retryAfter, delayMs,
// throwCode, reused }. Tracks in-flight concurrency and honours the signal.
function scripted(plan) {
  const t = { calls: [], inFlight: 0, maxInFlight: 0, aborted: 0 };
  t.postJson = async (req) => {
    const n = t.calls.length + 1;
    t.calls.push({ at: Date.now(), bodyJson: req.bodyJson, timeoutMs: req.timeoutMs, hasSignal: req.signal instanceof AbortSignal });
    t.inFlight += 1;
    t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
    try {
      const step = (await plan(req, n)) || {};
      if (step.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, step.delayMs);
          if (req.signal && step.ignoreSignal !== true) {
            req.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              t.aborted += 1;
              const error = new Error('aborted');
              error.code = 'ABORT_ERR';
              reject(error);
            }, { once: true });
          }
        });
      }
      if (step.throwCode) {
        const error = new Error('socket detail with user text ' + KEY);
        error.code = step.throwCode;
        error.reusedSocket = step.reused === true;
        throw error;
      }
      const status = step.status === undefined ? 200 : step.status;
      return {
        status,
        bodyText: step.bodyText !== undefined ? step.bodyText : (status === 200 ? okBody(step.tokens === undefined ? 7 : step.tokens) : '{}'),
        retryAfter: step.retryAfter === undefined ? null : step.retryAfter,
      };
    } finally {
      t.inFlight -= 1;
    }
  };
  return t;
}
function counterOf(transport, state, extra) {
  return remote.createMuseRemoteCounterV2(Object.assign({ descriptor: DESCRIPTOR, apiKey: KEY, transport, resilience: state }, extra || {}));
}
async function failureOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}
const kindOf = (error) => (error && error.counterFailure ? error.counterFailure.kind : (error ? String(error.message).slice(0, 60) : null));
const scopeRow = (state) => state.snapshotV2().scopes[0];
// ---------------------------------------------------------------------------
async function sectionRetry() {
  section('RC2-1 RETRY CLASSIFICATION (per call, deadline bounded)');
  {
    const state = freshState();
    const t = scripted((req, n) => (n === 1 ? { status: 429, retryAfter: 0.06 } : { tokens: 11 }));
    const op = counterOf(t, state).beginCountOperationV2();
    const started = Date.now();
    const out = await op.countTextsV2(['a']);
    const tel = op.finish();
    check(out[0] === 11 && t.calls.length === 2, '429 -> Retry-After -> 200 (2 attempts)');
    check(t.calls[1].at - t.calls[0].at >= 60, 'retry never sooner than Retry-After (' + (t.calls[1].at - t.calls[0].at) + 'ms)');
    check(tel.retryAfterApplied === true && tel.counterHttpRequests === 2 && Date.now() - started < 1000, 'retryAfterApplied telemetry');
  }
  {
    const state = freshState();
    const t = scripted((req, n) => (n === 1 ? { status: 429 } : { tokens: 5 }));
    const op = counterOf(t, state).beginCountOperationV2();
    const out = await op.countTextsV2(['a']);
    const tel = op.finish();
    check(out[0] === 5 && t.calls.length === 2 && tel.retryAfterApplied === false, '429 without Retry-After -> jittered backoff -> 200');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ status: 429, retryAfter: '3600' }));
    const counter = counterOf(t, state);
    const op = counter.beginCountOperationV2();
    const started = Date.now();
    const error = await failureOf(op.countTextsV2(['a']));
    const tel = op.finish();
    check(kindOf(error) === 'counter-rate-limited' && error.counterFailure.exhaustReason === 'deadline', 'huge Retry-After: current compilation gives up instead of waiting');
    check(Date.now() - started < 300 && t.calls.length === 1, 'huge Retry-After: fails fast (' + (Date.now() - started) + 'ms, ' + t.calls.length + ' call)');
    check(tel.counterGateState === 'COOLING', 'Retry-After starts the cooldown for later callers');
    const row = scopeRow(state);
    check(row.coolingRemainingMs <= 120000 && row.coolingRemainingMs > 100000, 'future cooldown capped at 120s (' + row.coolingRemainingMs + 'ms)');
    const later = counter.beginCountOperationV2();
    const blocked = await failureOf(later.countTextsV2(['other']));
    later.finish();
    check(kindOf(blocked) === 'counter-gate-open' && t.calls.length === 1, 'future request respects cooldown: gate-open with zero HTTP');
  }
  {
    const state = freshState();
    const t = scripted((req, n) => (n <= 2 ? { status: 503 } : { tokens: 9 }));
    const op = counterOf(t, state).beginCountOperationV2();
    const out = await op.countTextsV2(['a']);
    op.finish();
    check(out[0] === 9 && t.calls.length === 3, '503 burst -> retry -> success (3 attempts)');
    check(scopeRow(state).concurrencyLimit === 1, 'AIMD halved on each 503 (4 -> 2 -> 1)');
  }
  {
    const state = freshState();
    const t = scripted((req, n) => (n <= 2 ? { status: 500 } : { tokens: 9 }));
    const op = counterOf(t, state).beginCountOperationV2();
    const error = await failureOf(op.countTextsV2(['a']));
    op.finish();
    check(kindOf(error) === 'counter-transient' && t.calls.length === 2 && error.counterFailure.httpStatus === 500, '500 -> exactly one retry');
    check(scopeRow(state).concurrencyLimit === 4, '500 is not an overload signal (limit unchanged)');
  }
  for (const status of [501, 505]) {
    const state = freshState();
    const t = scripted(() => ({ status }));
    const error = await failureOf(counterOf(t, state).countTextsV2(['a']));
    check(kindOf(error) === 'counter-transient' && t.calls.length === 1, status + ' -> no retry');
  }
  {
    const state = freshState();
    const t = scripted((req, n) => (n === 1 ? { status: 408 } : { tokens: 3 }));
    const out = await counterOf(t, state).countTextsV2(['a']);
    check(out[0] === 3 && t.calls.length === 2, '408 -> backoff retry -> success');
  }
  for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']) {
    const state = freshState();
    const t = scripted((req, n) => (n === 1 ? { throwCode: code } : { tokens: 4 }));
    const op = counterOf(t, state).beginCountOperationV2();
    const out = await op.countTextsV2(['a']);
    op.finish();
    check(out[0] === 4 && t.calls.length === 2, code + ' -> retry -> success');
  }
  {
    const state = freshState({ transientBackoffBaseMs: 400, backoffCapMs: 400 });
    const t = scripted((req, n) => (n === 1 ? { throwCode: 'ECONNRESET', reused: true } : { tokens: 6 }));
    const out = await counterOf(t, state).countTextsV2(['a']);
    check(out[0] === 6 && t.calls.length === 2 && t.calls[1].at - t.calls[0].at < 100, 'ECONNRESET on reused socket -> immediate retry (' + (t.calls[1].at - t.calls[0].at) + 'ms)');
    const t2 = scripted((req, n) => (n <= 2 ? { throwCode: 'ECONNRESET', reused: true } : { tokens: 6 }));
    await counterOf(t2, freshState({ transientBackoffBaseMs: 400, backoffCapMs: 400 })).countTextsV2(['a']);
    check(t2.calls.length === 3 && t2.calls[2].at - t2.calls[1].at >= 150, 'second reset falls back to normal backoff (' + (t2.calls[2].at - t2.calls[1].at) + 'ms)');
    const t3 = scripted((req, n) => (n === 1 ? { throwCode: 'ECONNRESET', reused: false } : { tokens: 6 }));
    await counterOf(t3, freshState({ transientBackoffBaseMs: 400, backoffCapMs: 400 })).countTextsV2(['a']);
    check(t3.calls[1].at - t3.calls[0].at >= 150, 'reset on a fresh socket uses backoff, not the immediate retry');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ status: 503 }));
    const op = counterOf(t, state).beginCountOperationV2();
    const error = await failureOf(op.countTextsV2(['a']));
    const tel = op.finish();
    check(kindOf(error) === 'counter-transient' && t.calls.length === 3 && error.counterFailure.exhaustReason === 'attempts', 'exhausted transient retries: max 3 attempts per call');
    check(tel.counterFailureKind === 'counter-transient' && tel.counterHttpStatus === 503 && tel.counterAttempts === 3, 'exhaustion telemetry: kind/status/attempts');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ throwCode: 'ENOTFOUND' }));
    const error = await failureOf(counterOf(t, state).countTextsV2(['a']));
    check(kindOf(error) === 'counter-transient' && error.counterFailure.netErrorCode === 'ENOTFOUND' && t.calls.length === 1, 'non-retryable network code: one attempt, allow-listed code');
    const t2 = scripted(() => ({ throwCode: 'EWEIRD_UNKNOWN' }));
    const error2 = await failureOf(counterOf(t2, freshState()).countTextsV2(['a']));
    check(error2.counterFailure.netErrorCode === 'OTHER', 'unknown network code maps to OTHER');
    check(String(error.message).indexOf(KEY) === -1 && String(error.message).indexOf('socket detail') === -1, 'raw exception text never propagates');
  }
}
async function sectionNonRetryable() {
  section('RC2-2 NON-RETRYABLE FAILURES + LATCHES');
  {
    const state = freshState();
    const t = scripted((req) => (req.apiKey === KEY ? { status: 401 } : { tokens: 8 }));
    const counter = counterOf(t, state);
    const error = await failureOf(counter.countTextsV2(['a']));
    check(kindOf(error) === 'counter-auth' && t.calls.length === 1, '401 -> no retry, counter-auth');
    const again = await failureOf(counter.countTextsV2(['b']));
    check(kindOf(again) === 'counter-auth' && t.calls.length === 1, 'auth latch: same credential makes zero further HTTP requests');
    const rotated = counterOf(t, state, { apiKey: KEY + '-rotated' });
    const out = await rotated.countTextsV2(['b']);
    check(out[0] === 8 && t.calls.length === 2, 'credential identity change clears the auth latch');
    const t403 = scripted(() => ({ status: 403 }));
    check(kindOf(await failureOf(counterOf(t403, freshState()).countTextsV2(['a']))) === 'counter-auth' && t403.calls.length === 1, '403 -> no retry, counter-auth');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ status: 404, bodyText: '<html>' }));
    const counter = counterOf(t, state);
    check(kindOf(await failureOf(counter.countTextsV2(['a']))) === 'counter-unsupported' && t.calls.length === 1, '404 -> no retry, counter-unsupported');
    check(kindOf(await failureOf(counter.countTextsV2(['z']))) === 'counter-unsupported' && t.calls.length === 1, 'unsupported latch: zero further HTTP requests');
    const t2 = scripted(() => ({ status: 400, bodyText: JSON.stringify({ error: { message: "Model 'x' not found" } }) }));
    check(kindOf(await failureOf(counterOf(t2, freshState()).countTextsV2(['a']))) === 'counter-unsupported' && t2.calls.length === 1, 'model-unsupported 400 -> unsupported latch');
    const decision = muse.classifyErrorV2(await failureOf(counterOf(t2, freshState()).countTextsV2(['a'])));
    check(decision.messageCode === 'remote-counter-counter-unsupported', 'unsupported carries a structural message code');
  }
  {
    const t = scripted(() => ({ status: 200, bodyText: '{"object":"response.input_tokens"}' }));
    check(kindOf(await failureOf(counterOf(t, freshState()).countTextsV2(['a']))) === 'counter-malformed' && t.calls.length === 1, 'malformed 200 -> no retry');
    const t2 = scripted(() => ({ status: 400, bodyText: JSON.stringify({ error: { message: 'bad input: ' + 'SECRET-PROMPT-TEXT' } }) }));
    const error = await failureOf(counterOf(t2, freshState()).countTextsV2(['a']));
    check(kindOf(error) === 'counter-request-invalid' && t2.calls.length === 1, '400 request-invalid -> no retry');
    check(String(error.message).indexOf('SECRET-PROMPT-TEXT') === -1, 'server error detail never copied into the error');
    const t3 = scripted(() => ({ status: 413 }));
    check(kindOf(await failureOf(counterOf(t3, freshState()).countTextsV2(['a']))) === 'counter-request-invalid' && t3.calls.length === 1, '413 -> no retry');
  }
}
async function sectionCache() {
  section('RC2-3 EXACT CANONICAL-BODY CACHE');
  {
    const state = freshState();
    const t = scripted((req) => ({ tokens: JSON.parse(req.bodyJson).input.length }));
    const counter = counterOf(t, state);
    await counter.countTextsV2(['alpha']);
    const op = counter.beginCountOperationV2();
    const again = await op.countTextsV2(['alpha']);
    const tel = op.finish();
    check(again[0] === 5 && t.calls.length === 1 && tel.counterCacheHits === 1 && tel.counterHttpRequests === 0, 'same body + contract + credScope + epoch: cache hit, zero HTTP');
    await counter.countTextsV2(['alphb']);
    check(t.calls.length === 2, 'one changed byte in the body: miss');
    await counterOf(t, state, { apiKey: KEY + '2' }).countTextsV2(['alpha']);
    check(t.calls.length === 3, 'different credential scope: miss');
    const otherTransport = scripted(() => ({ tokens: 5 }));
    await counterOf(otherTransport, state).countTextsV2(['alpha']);
    check(otherTransport.calls.length === 1, 'different transport scope: miss');
    const payloadLive = await counter.countPayloadV2({ instructions: 'sys', input: [{ role: 'user', content: 'hi' }] });
    const before = t.calls.length;
    const payloadCached = await counter.countPayloadV2({ input: [{ role: 'user', content: 'hi' }], instructions: 'sys' });
    check(payloadLive.source === 'live' && payloadCached.source === 'cache' && payloadCached.tokens === payloadLive.tokens && t.calls.length === before, 'cached whole-payload count == live authoritative count (canonical body, key order irrelevant)');
    await counter.countPayloadV2({ instructions: 'sys', input: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'xhigh' } });
    check(t.calls.length === before + 1, 'a new count-affecting field (reasoning) is covered automatically: miss');
    const entries = state.inspectCacheV2();
    check(entries.length > 0 && entries.every((e) => /^[0-9a-f]{64}$/.test(e.key) && Object.keys(e.value).sort().join(',') === 'observedAt,tokens'), 'cache holds only digest keys and {tokens, observedAt}');
    const blob = JSON.stringify(entries) + JSON.stringify(state.snapshotV2());
    check(blob.indexOf('alpha') === -1 && blob.indexOf(KEY) === -1 && blob.indexOf('sys') === -1, 'cache and snapshot carry no text or credential');
  }
  {
    const state = freshState();
    const base = { bodyDigest: 'd'.repeat(64), contract: { schemaVersion: 1, fingerprint: 'f', revision: 'r', host: 'h', countPath: '/p', model: 'm' }, credScope: 'c', transportScope: 'https' };
    const baseKey = state.cacheKeyOf(base).key;
    const mutations = [
      ['bodyDigest', Object.assign({}, base, { bodyDigest: 'e' + 'd'.repeat(63) })],
      ['schemaVersion', Object.assign({}, base, { contract: Object.assign({}, base.contract, { schemaVersion: 2 }) })],
      ['fingerprint', Object.assign({}, base, { contract: Object.assign({}, base.contract, { fingerprint: 'g' }) })],
      ['revision', Object.assign({}, base, { contract: Object.assign({}, base.contract, { revision: 's' }) })],
      ['host', Object.assign({}, base, { contract: Object.assign({}, base.contract, { host: 'i' }) })],
      ['countPath', Object.assign({}, base, { contract: Object.assign({}, base.contract, { countPath: '/q' }) })],
      ['model', Object.assign({}, base, { contract: Object.assign({}, base.contract, { model: 'n' }) })],
      ['credScope', Object.assign({}, base, { credScope: 'd' })],
      ['transportScope', Object.assign({}, base, { transportScope: 'transport-9' })],
    ];
    const differs = mutations.filter(([, parts]) => state.cacheKeyOf(parts).key !== baseKey).map(([name]) => name);
    check(differs.length === mutations.length, 'every single identity element changes the key (' + differs.join(',') + ')');
    check(state.cacheKeyOf(Object.assign({}, base)).key === baseKey, 'identical identity -> identical key');
    state.cachePut(baseKey, 0, 42);
    check(state.cacheGet(baseKey).tokens === 42, 'put/get round trip');
    const epoch = state.bumpCacheEpochV2();
    check(epoch === 1 && state.cacheGet(baseKey) === null && state.snapshotV2().cacheSize === 0, 'epoch bump flushes old entries');
    check(state.cacheKeyOf(base).key !== baseKey, 'epoch is part of the key');
    state.cachePut(baseKey, 0, 42);
    check(state.snapshotV2().cacheSize === 0, 'a count observed under a superseded epoch is never stored');
  }
  {
    let offset = 0;
    const state = freshState({ cacheTtlMs: 1000 }, { now: () => Date.now() + offset });
    const t = scripted(() => ({ tokens: 3 }));
    const counter = counterOf(t, state);
    await counter.countTextsV2(['ttl']);
    await counter.countTextsV2(['ttl']);
    check(t.calls.length === 1, 'within TTL: hit');
    offset = 1500;
    await counter.countTextsV2(['ttl']);
    check(t.calls.length === 2, 'past the TTL guard: miss');
  }
  {
    const state = freshState({ cacheCapacity: 3 });
    const t = scripted(() => ({ tokens: 1 }));
    const counter = counterOf(t, state);
    await counter.countTextsV2(['1', '2', '3']);
    await counter.countTextsV2(['1']);
    await counter.countTextsV2(['4']);
    check(state.snapshotV2().cacheSize === 3, 'LRU bounded at capacity');
    const before = t.calls.length;
    await counter.countTextsV2(['1']);
    check(t.calls.length === before, 'recently used entry survives eviction');
    await counter.countTextsV2(['2']);
    check(t.calls.length === before + 1, 'least recently used entry evicted');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ tokens: 2 }));
    const counter = counterOf(t, state);
    await counter.countTextsV2(['drift']);
    remote.invalidateExactCountCacheV2(state);
    await counter.countTextsV2(['drift']);
    check(t.calls.length === 2, 'drift invalidation: previously cached count is re-counted live');
  }
}
async function sectionLimiter() {
  section('RC2-4 PROCESS-GLOBAL AIMD LIMITER + CANCELLATION');
  {
    // Growth disabled here so the bound under test is exactly 4.
    const state = freshState({ growAfterSuccesses: 1000 });
    const t = scripted(() => ({ delayMs: 15, tokens: 1 }));
    const texts = Array.from({ length: 30 }, (_, i) => 'text-' + i);
    await counterOf(t, state).countTextsV2(texts);
    check(t.maxInFlight <= 4 && t.maxInFlight >= 2, 'one compilation never exceeds the limit (max in flight ' + t.maxInFlight + ')');
  }
  {
    const state = freshState({ growAfterSuccesses: 1000 });
    const t = scripted(() => ({ delayMs: 15, tokens: 1 }));
    const sessions = [0, 1, 2].map(() => counterOf(t, state));
    await Promise.all(sessions.map((counter, s) => counter.countTextsV2(Array.from({ length: 12 }, (_, i) => 's' + s + '-' + i))));
    check(t.maxInFlight <= 4 && t.calls.length === 36, 'three simultaneous sessions share ONE limit (max in flight ' + t.maxInFlight + ')');
  }
  {
    // With growth enabled the bound follows the AIMD limit (<= 8 ever).
    const state = freshState();
    const t = scripted(() => ({ delayMs: 5, tokens: 1 }));
    await counterOf(t, state).countTextsV2(Array.from({ length: 120 }, (_, i) => 'grow-' + i));
    check(t.maxInFlight <= scopeRow(state).concurrencyLimit && scopeRow(state).concurrencyLimit <= 8 && scopeRow(state).concurrencyLimit > 4, 'healthy traffic grows the limit additively (limit ' + scopeRow(state).concurrencyLimit + ', max in flight ' + t.maxInFlight + ')');
  }
  {
    const state = freshState();
    const t = scripted((req) => ({ delayMs: Math.floor(Math.random() * 20), tokens: Number(JSON.parse(req.bodyJson).input.slice(2)) * 3 }));
    const texts = Array.from({ length: 25 }, (_, i) => 'o-' + i);
    const shuffledDup = texts.concat(['o-3', 'o-0']);
    const out = await counterOf(t, state).countTextsV2(shuffledDup);
    check(out.every((n, i) => n === Number(shuffledDup[i].slice(2)) * 3), 'deterministic result order under randomized latency (with duplicates)');
  }
  {
    const state = freshState({ initialConcurrency: 2 });
    const t = scripted((req, n) => (n === 1 ? { status: 401 } : { delayMs: 80, tokens: 1 }));
    const texts = Array.from({ length: 20 }, (_, i) => 'c-' + i);
    const started = Date.now();
    const error = await failureOf(counterOf(t, state).countTextsV2(texts));
    const elapsed = Date.now() - started;
    await sleep(100);
    check(kindOf(error) === 'counter-auth', 'terminal failure surfaces its own kind (not a sibling cancellation)');
    check(t.calls.length <= 3, 'queued siblings never start after a terminal failure (' + t.calls.length + ' calls of 20)');
    check(t.aborted >= 1 && elapsed < 60, 'in-flight siblings aborted, no waiting on them (' + elapsed + 'ms, aborted ' + t.aborted + ')');
  }
  {
    const state = freshState({ initialConcurrency: 4 });
    const t = scripted(() => ({ tokens: 1 }));
    const counter = counterOf(t, state);
    for (let i = 0; i < 19; i += 1) await counter.countTextsV2(['g-' + i]);
    check(scopeRow(state).concurrencyLimit === 4, '19 consecutive successes: limit unchanged');
    await counter.countTextsV2(['g-19']);
    check(scopeRow(state).concurrencyLimit === 5, '20th consecutive success: limit +1');
    const t429 = scripted((req, n) => (n === 1 ? { status: 429 } : { tokens: 1 }));
    await counterOf(t429, state).countTextsV2(['h']);
    const hot = freshState({ initialConcurrency: 8 });
    const counterHot = counterOf(t, hot);
    for (let i = 0; i < 20; i += 1) await counterHot.countTextsV2(['k-' + i]);
    check(scopeRow(hot).concurrencyLimit === 8, 'limit never exceeds 8');
    const cold = freshState({ initialConcurrency: 1 });
    await counterOf(scripted((req, n) => (n === 1 ? { status: 503 } : { tokens: 1 })), cold).countTextsV2(['m']);
    check(scopeRow(cold).concurrencyLimit === 1, 'limit never goes below 1');
    const halved = freshState({ initialConcurrency: 8 });
    await counterOf(scripted((req, n) => (n === 1 ? { status: 429 } : { tokens: 1 })), halved).countTextsV2(['q']);
    check(scopeRow(halved).concurrencyLimit === 4, '429 halves the limit (8 -> 4)');
    const streakReset = freshState({ initialConcurrency: 4 });
    const flaky = counterOf(scripted((req, n) => (n === 10 ? { status: 500 } : { tokens: 1 })), streakReset);
    for (let i = 0; i < 25; i += 1) await failureOf(flaky.countTextsV2(['r-' + i]));
    check(scopeRow(streakReset).concurrencyLimit === 4, 'a failure resets the success streak (no growth before 20 consecutive)');
  }
}
async function sectionGate() {
  section('RC2-5 COOLDOWN GATE (no full breaker state machine)');
  {
    const state = freshState({ exhaustedCooldownMs: 80, exhaustedCooldownCapMs: 400 });
    let healthy = false;
    const t = scripted(() => (healthy ? { tokens: 2, delayMs: 30 } : { status: 503 }));
    const counter = counterOf(t, state);
    await failureOf(counter.countTextsV2(['cached-before-outage']));
    check(t.calls.length === 3, 'setup: outage counted');
    healthy = true;
    await counter.countTextsV2(['cached-before-outage']);
    healthy = false;
    const op1 = counter.beginCountOperationV2();
    await failureOf(op1.countTextsV2(['x1']));
    op1.finish();
    check(scopeRow(state).gateState === 'CLEAR', 'one exhausted operation does not cool the gate');
    const op2 = counter.beginCountOperationV2();
    await failureOf(op2.countTextsV2(['x2']));
    const tel2 = op2.finish();
    check(tel2.counterGateState === 'COOLING', 'two consecutive exhausted operations start the cooldown');
    const callsBefore = t.calls.length;
    const started = Date.now();
    const op3 = counter.beginCountOperationV2();
    const blocked = await failureOf(op3.countTextsV2(['x3']));
    const tel3 = op3.finish();
    check(kindOf(blocked) === 'counter-gate-open' && t.calls.length === callsBefore && Date.now() - started < 20, 'cooling + cache miss: immediate failure, zero HTTP, no limiter queueing');
    check(tel3.counterHttpRequests === 0 && tel3.counterGateState === 'COOLING', 'gate state in telemetry');
    const op4 = counter.beginCountOperationV2();
    const hit = await op4.countTextsV2(['cached-before-outage']);
    const tel4 = op4.finish();
    check(hit[0] === 2 && tel4.counterCacheHits === 1 && tel4.counterHttpRequests === 0, 'cooling + exact cache hit: still served');
    const prewarm = await counter.prewarmTextsV2(['p1', 'p2']);
    check(prewarm.skipped === 'gate' && t.calls.length === callsBefore, 'pre-warm never runs while cooling');
    await sleep(90);
    check(scopeRow(state).gateState === 'PROBE', 'cooldown elapsed: next request is the probe');
    // One probe at a time: the second concurrent operation fails fast.
    healthy = true;
    const probeOp = counter.beginCountOperationV2();
    const probe = probeOp.countTextsV2(['probe-1']);
    await sleep(5);
    const other = counter.beginCountOperationV2();
    const otherErr = await failureOf(other.countTextsV2(['probe-2']));
    other.finish();
    check(kindOf(otherErr) === 'counter-gate-open', 'while the probe is in flight, other operations fail fast');
    await probe;
    const probeTel = probeOp.finish();
    check(probeTel.counterGateState === 'CLEAR' && scopeRow(state).consecutiveExhausted === 0, 'probe success resets the gate');
    // Probe failure reopens the cooldown with doubling.
    healthy = false;
    for (let i = 0; i < 2; i += 1) {
      const op = counter.beginCountOperationV2();
      await failureOf(op.countTextsV2(['y' + i]));
      op.finish();
    }
    const first = scopeRow(state).coolingRemainingMs;
    await sleep(first + 10);
    const failedProbe = counter.beginCountOperationV2();
    await failureOf(failedProbe.countTextsV2(['y-probe']));
    failedProbe.finish();
    const second = scopeRow(state).coolingRemainingMs;
    check(scopeRow(state).gateState === 'COOLING' && second > first + 20, 'probe transient failure reopens the cooldown, doubled (' + first + ' -> ' + second + 'ms)');
  }
}
async function sectionBudgetDeadline() {
  section('RC2-6 RETRY BUDGET + DEADLINES');
  {
    const state = freshState({ retryBudgetCapacity: 2, retryBudgetRatio: 0.1, exhaustedThreshold: 1000 });
    const t = scripted(() => ({ status: 503 }));
    const counters = Array.from({ length: 5 }, () => counterOf(t, state));
    await Promise.all(counters.map((counter, i) => failureOf(counter.countTextsV2(['storm-' + i + '-a', 'storm-' + i + '-b']))));
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(counters.map((counter, i) => failureOf(counter.countTextsV2(['storm-r' + round + '-' + i]))));
    }
    const stats = state.snapshotV2().stats;
    check(stats.retries <= 2 + Math.ceil(0.1 * stats.firstAttempts), 'cross-session retries bounded by the token bucket (' + stats.retries + ' retries / ' + stats.firstAttempts + ' first attempts)');
    check(stats.retriesDenied > 0, 'retry storm denied once the budget is spent (' + stats.retriesDenied + ' denied)');
  }
  {
    const state = freshState({ operationDeadlineMs: 150, payloadReserveMs: 50 });
    const t = scripted(() => ({ delayMs: 1000, ignoreSignal: true }));
    const op = counterOf(t, state).beginCountOperationV2();
    const started = Date.now();
    const error = await failureOf(op.countTextsV2(['slow']));
    const tel = op.finish();
    const elapsed = Date.now() - started;
    check(kindOf(error) === 'counter-deadline' && elapsed < 200, 'hung transport: text phase stops at its deadline (' + elapsed + 'ms)');
    check(t.calls[0].timeoutMs <= 100, 'attempt timeout cut to the remaining text deadline (' + t.calls[0].timeoutMs + 'ms)');
    check(tel.counterFailureKind === 'counter-deadline' && tel.counterDeadlineMs === 150, 'deadline telemetry');
  }
  {
    // A transport that honours timeoutMs: the timeout cut to the deadline
    // expires WITH the deadline -> counter-deadline (not an endpoint verdict).
    const state = freshState({ operationDeadlineMs: 200, payloadReserveMs: 50 });
    const t = { calls: 0, postJson: async (req) => { t.calls += 1; await sleep(req.timeoutMs); const e = new Error('t'); e.code = 'ETIMEDOUT'; throw e; } };
    const op = counterOf(t, state).beginCountOperationV2();
    const error = await failureOf(op.countTextsV2(['cut']));
    op.finish();
    check(kindOf(error) === 'counter-deadline' && error.counterFailure.netErrorCode === 'ETIMEDOUT' && t.calls === 1, 'timeout cut to the deadline is classified as counter-deadline');
    const early = { calls: 0, postJson: async () => { early.calls += 1; const e = new Error('t'); e.code = 'ETIMEDOUT'; throw e; } };
    const opEarly = counterOf(early, freshState({ operationDeadlineMs: 2000 })).beginCountOperationV2();
    const earlyErr = await failureOf(opEarly.countTextsV2(['early']));
    opEarly.finish();
    check(kindOf(earlyErr) === 'counter-transient' && early.calls === 3, 'an early ETIMEDOUT stays a retryable transient');
  }
  {
    const state = freshState({ operationDeadlineMs: 400, payloadReserveMs: 200 });
    const t = scripted(() => ({ delayMs: 30, tokens: 5 }));
    const op = counterOf(t, state).beginCountOperationV2();
    await op.countTextsV2(['t']);
    const payload = await op.countPayloadV2({ instructions: 's', input: 'u' });
    const tel = op.finish();
    check(payload.tokens === 5 && tel.counterSource === 'live' && tel.counterElapsedMs < 400, 'payload count runs inside one operation deadline');
    check(t.calls[1].timeoutMs <= 400 && t.calls[1].timeoutMs > t.calls[0].timeoutMs - 200, 'payload attempt may use the reserved tail of the deadline');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ tokens: 1 }));
    const counter = remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: KEY, transport: t, resilience: state, timeoutMs: 300000 });
    await counter.countPayloadV2({ instructions: 'x', input: 'y' });
    check(t.calls[0].timeoutMs > 250000, 'explicit timeoutMs (M01/canary scripts) widens the implicit operation');
  }
}
async function sectionPrewarm() {
  section('RC2-7 BACKGROUND PRE-WARM (foreground priority)');
  {
    const state = freshState({ initialConcurrency: 2 });
    const t = scripted(() => ({ delayMs: 25, tokens: 1 }));
    const counter = counterOf(t, state);
    const background = Array.from({ length: 8 }, (_, i) => 'bg-' + i);
    const prewarmDone = counter.prewarmTextsV2(background);
    await sleep(5);
    const fgStarted = Date.now();
    await counter.countTextsV2(['fg-1', 'fg-2']);
    const fgElapsed = Date.now() - fgStarted;
    const summary = await prewarmDone;
    check(fgElapsed < 90, 'foreground is not starved by background pre-warm (' + fgElapsed + 'ms)');
    check(t.maxInFlight <= 2, 'pre-warm shares the process-global limit (max ' + t.maxInFlight + ')');
    check(summary.attempted === 8 && summary.counted === 8 && summary.skipped === null, 'pre-warm counted all misses');
    const op = counter.beginCountOperationV2();
    await op.countTextsV2(background);
    const tel = op.finish();
    check(tel.counterCacheHits === 8 && tel.counterHttpRequests === 0, 'next compile finds pre-warmed entries cached');
    const again = await counter.prewarmTextsV2(background);
    check(again.counted === 0 && again.cached === 8, 'pre-warm skips already-cached texts');
  }
  {
    const state = freshState();
    const t = scripted(() => ({ status: 503 }));
    const summary = await counterOf(t, state).prewarmTextsV2(['a', 'b', 'c']);
    check(t.calls.length === 1 && summary.skipped === 'counter-transient', 'pre-warm never retries and stops at the first failure');
    check(state.snapshotV2().stats.retries === 0 && scopeRow(state).consecutiveExhausted === 0, 'pre-warm spends no retry budget and never cools the gate by itself');
  }
  {
    const state = freshState({ initialConcurrency: 4 });
    const t = scripted(() => ({ delayMs: 200, tokens: 1 }));
    const counter = counterOf(t, state);
    const pending = counter.prewarmTextsV2(['long-1', 'long-2']);
    await sleep(10);
    state.cancelBackgroundV2();
    const summary = await pending;
    check(t.aborted >= 1 && summary.counted <= 1, 'background work is cancellable');
  }
}
// ---------------------------------------------------------------------------
// Muse compiler regression: the live turn-2 -> counter-unavailable sequence.
const NS = Object.freeze({ taskId: 'TASK-RC2-A', taskInstanceId: 'task_rc2_a_0001', sessionId: 'sess-rc2-a', workspaceId: '/tmp/nexus-rc2-a', repositoryId: 'repo-rc2', checkoutId: 'checkout-rc2' });
const SYSTEM = 'You are the Nexus RC2 system prompt.';
function stageMemory() {
  const raw = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove counter resilience.', status: 'in-progress' },
    requirements: [{ id: 'REQ-R1', text: 'Fail closed to LEGACY.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'RC2', remainingMilestones: [] },
    decisions: [{ id: 'D-R1', statement: 'Exact or nothing.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-R1', status: 'open', detail: 'Flaky counter.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Harden counter.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship RC2.' },
  };
  const token = snapshotMod.capture({
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: raw.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: raw.objective, requirements: raw.requirements, constraints: raw.constraints,
      progress: raw.progress, decisions: raw.decisions,
      failures: { activeFailures: raw.failures.activeFailures, rejectedHypotheses: raw.failures.rejectedHypotheses },
      verification: raw.verification, continuation: raw.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('rc2:index'), worktreeDigest: sha('rc2:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
  const CP = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: token })).checkpoint;
  const mk = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
      workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = mk('decision', 'agent', ['decision:R9'], [40], 'Historical RC2 note. '.repeat(30));
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-r1'], [7, 8], 'exit 0 settled RC2 tool log. '.repeat(8));
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-R1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-R1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-R1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  return { CP, pages: [COLD, TOOL], decisions, TOOL };
}
const STAGED = stageMemory();
function attemptInput(counter, turn) {
  return {
    compileInput: {
      checkpoint: STAGED.CP,
      currentTurn: { turnId: 'live', text: turn, revision: null },
      namespace: {
        taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
        workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
      },
      snapshotRevision: STAGED.CP.snapshot.revisionDigest,
      runtimeState: { pendingProtocol: null },
      pages: STAGED.pages,
      tierDecisions: STAGED.decisions,
      evidenceRefs: [],
      exactMaterial: [],
      toolTransactions: [{ pageId: STAGED.TOOL.id, callId: 'call-r1', callSeq: 7, resultSeq: 8 }],
      budget: { hardMax: 60000, target: 50000 },
      compilerPolicyRevision: compiler.COMPILER_POLICY_REVISION_V2,
    },
    pages: STAGED.pages,
    remoteCounter: counter,
    route: { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', maxContextTokens: 1048576 },
    requestTerms: { systemText: SYSTEM, turnText: turn, maxTokens: 512, outputReserve: 512 },
    binding: {
      taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
      checkpointGeneration: 1, checkpointId: STAGED.CP.checkpointId,
      snapshotRevision: STAGED.CP.snapshot.revisionDigest,
      turnId: 'live', turnTextHash: sha(turn),
      provider: 'meta-model-api', model: 'muse-spark-1.3-contributor',
      maxTokens: 512, outputReserve: 512,
      counterFingerprint: remote.REMOTE_FINGERPRINT_V1, counterRevision: remote.REMOTE_REVISION_V1,
    },
  };
}
const byteCount = (bodyJson) => {
  const body = JSON.parse(bodyJson);
  if (body.instructions !== undefined) return 400 + (Buffer.byteLength(bodyJson, 'utf8') % 97);
  return 1 + (Buffer.byteLength(String(body.input), 'utf8') % 11);
};
async function sectionMuseRegression() {
  section('RC2-8 MUSE COMPILER: LIVE SEQUENCE REGRESSION (compiled -> outage -> recover/LEGACY)');
  const state = freshState({ exhaustedCooldownMs: 120, operationDeadlineMs: 1500, payloadReserveMs: 400 });
  let mode = 'ok';
  const counted = new Map(); // canonical count body -> tokens (every 200 the provider ever answered)
  const t = scripted((req) => {
    if (mode === 'ok' || (mode === 'payload-503' && JSON.parse(req.bodyJson).instructions === undefined)) {
      counted.set(req.bodyJson, byteCount(req.bodyJson));
      return { tokens: byteCount(req.bodyJson), delayMs: 1 };
    }
    return { status: 503 };
  });
  const counter = counterOf(t, state);
  const decisions = [];
  const attempt = async (turn) => {
    const d = await muse.attemptMuseActiveV2(attemptInput(counter, turn));
    decisions.push(d);
    return d;
  };
  // Turn 2: two real compiled steps (requests 46/48 in the live log).
  const d46 = await attempt('RC2 turn two step one.');
  const d48 = await attempt('RC2 turn two step two.');
  check(d46.eligible === true && d48.eligible === true, 'first CCv2 requests compile');
  check(d46.telemetry.counterKind === 'REMOTE_EXACT' && d46.telemetry.counterSource === 'live' && d46.telemetry.counterHttpRequests > 3, 'compiled telemetry: REMOTE_EXACT, live, real HTTP request count (' + d46.telemetry.counterHttpRequests + ' requests vs remoteCalls ' + d46.telemetry.remoteCalls + ')');
  check(d48.telemetry.counterCacheHits > 0, 'second step reuses stable per-text counts (' + d48.telemetry.counterCacheHits + ' hits)');
  // The counter starts failing at the final payload count (live stage 1).
  mode = 'payload-503';
  const started = Date.now();
  const f1 = await attempt('RC2 turn three step one.');
  check(f1.eligible === false && f1.mode === 'LEGACY' && f1.failureStage === 'payload-count', 'payload-count outage -> LEGACY (stage payload-count)');
  check(f1.fallbackReason === 'active-tokenizer-unavailable' && f1.telemetry.counterFailureKind === 'counter-transient' && f1.telemetry.counterHttpStatus === 503, 'fallbackReason kept for compatibility; safe class retained (' + f1.telemetry.counterFailureKind + '/' + f1.telemetry.counterHttpStatus + ')');
  check(f1.errorClass && f1.errorClass.messageCode === 'remote-counter-counter-transient', 'errorClass messageCode names the safe kind');
  check(Date.now() - started < 1600, 'fails within the compilation deadline (' + (Date.now() - started) + 'ms)');
  // Full outage (live stage 2: reserve-count).
  mode = 'down';
  const f2 = await attempt('RC2 turn three step two.');
  check(f2.eligible === false && f2.failureStage === 'reserve-count' && f2.compilerExecutions === 0, 'reserve-count outage -> LEGACY before compiler execution');
  check(f2.telemetry.counterGateState === 'COOLING', 'two exhausted compilations cool the gate');
  const callsAtCooling = t.calls.length;
  const coolStart = Date.now();
  const f3 = await attempt('RC2 turn three step three.');
  check(f3.eligible === false && f3.telemetry.counterFailureKind === 'counter-gate-open' && t.calls.length === callsAtCooling, 'while cooling: LEGACY with zero HTTP requests');
  check(Date.now() - coolStart < 100, 'while cooling: no stalled turn (' + (Date.now() - coolStart) + 'ms)');
  // A cache hit during cooling is still exact authority: the identical
  // request (same turn, same memory) compiles with zero network.
  const replay = await attempt('RC2 turn two step two.');
  check(replay.eligible === true && replay.preCount === d48.preCount && replay.telemetry.counterSource === 'cache' && replay.telemetry.counterKind === 'REMOTE_EXACT', 'cooling + exact cache hit -> CCV2_COMPILED with REMOTE_EXACT (source cache)');
  check(t.calls.length === callsAtCooling && canonicalOf(replay.inferenceBody) === canonicalOf(d48.inferenceBody), 'cache replay: zero HTTP, byte-identical sendable body');
  // Recovery: the probe after the cooldown resumes compiled sends.
  mode = 'ok';
  await sleep(140);
  const r1 = await attempt('RC2 turn four step one.');
  check(r1.eligible === true && r1.telemetry.counterGateState === 'CLEAR', 'counter recovers: probe compiles and clears the gate');
  // Invariant over the whole sequence: every compiled decision's pre-count is
  // the provider's answer for exactly the body that would be sent.
  const compiled = decisions.filter((d) => d.eligible === true);
  const uncounted = compiled.filter((d) => {
    const body = { model: 'muse-spark-1.3-contributor' };
    for (const key of ['input', 'instructions', 'tools', 'max_output_tokens', 'reasoning']) {
      if (d.inferenceBody[key] !== undefined) body[key] = d.inferenceBody[key];
    }
    const json = canonicalOf(body);
    return counted.get(json) !== d.preCount;
  });
  check(compiled.length === 4 && uncounted.length === 0, 'never a modified request without an exact provider count for its exact body (' + compiled.length + ' compiled, ' + uncounted.length + ' uncounted)');
  const blob = JSON.stringify(decisions.map((d) => d.telemetry));
  check(blob.indexOf(KEY) === -1 && blob.indexOf('RC2 turn') === -1 && blob.indexOf(SYSTEM) === -1 && blob.indexOf('Historical RC2') === -1, 'decision telemetry carries no prompt, evidence or credential');
  const pre = muse.enumerateMusePrewarmTextsV2({ compileInput: attemptInput(counter, 'x').compileInput, pages: STAGED.pages, requestTerms: { systemText: SYSTEM, turnText: 'x' } });
  check(Array.isArray(pre) && pre.length > 5, 'pre-warm enumeration reuses the planning pass (' + (pre ? pre.length : 0) + ' texts)');
  check(muse.enumerateMusePrewarmTextsV2({ compileInput: {}, pages: [] }) === null, 'pre-warm enumeration never throws');
}
function canonicalOf(value) {
  return JSON.stringify(checkpoint.canonicalize(value));
}
async function sectionTelemetrySafety() {
  section('RC2-9 TELEMETRY SAFETY');
  const state = freshState();
  const t = scripted((req, n) => (n === 1 ? { throwCode: 'ECONNRESET', reused: true } : n === 2 ? { status: 429, retryAfter: 0.01 } : { tokens: 5 }));
  const op = counterOf(t, state).beginCountOperationV2();
  await op.countTextsV2(['SECRET-PROMPT-BODY evidence bytes']);
  const tel = op.finish();
  const keys = Object.keys(tel).sort();
  check(keys.join(',') === muse.COUNTER_TELEMETRY_KEYS.slice().sort().join(','), 'operation telemetry uses exactly the documented keys');
  const blob = JSON.stringify(tel) + JSON.stringify(state.snapshotV2());
  check(blob.indexOf('SECRET-PROMPT-BODY') === -1 && blob.indexOf(KEY) === -1 && blob.indexOf('Bearer') === -1, 'no prompt, credential or header in telemetry');
  check(Object.values(tel).every((v) => v === null || typeof v === 'number' || typeof v === 'boolean' || /^[A-Za-z0-9_.-]{1,64}$/.test(v)), 'every telemetry value is a scalar enum/number');
  const picked = muse.pickCounterTelemetryV2(Object.assign({}, tel, { counterFailureKind: 'free text with spaces ' + KEY, extra: 'x' }));
  check(picked.counterFailureKind === null && picked.extra === undefined, 'telemetry picker drops non-enum strings and unknown keys');
  check(remote.parseRetryAfterMsV2('12', 0) === 12000 && remote.parseRetryAfterMsV2('garbage', 0) === null && remote.parseRetryAfterMsV2(new Date(Date.now() + 5000).toUTCString(), Date.now()) > 3000, 'Retry-After: delta-seconds and HTTP-date');
}
async function main() {
  await sectionRetry();
  await sectionNonRetryable();
  await sectionCache();
  await sectionLimiter();
  await sectionGate();
  await sectionBudgetDeadline();
  await sectionPrewarm();
  await sectionMuseRegression();
  await sectionTelemetrySafety();
  console.log(String.fromCharCode(10) + 'ContextRemoteCounterResilienceV2 suite: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
