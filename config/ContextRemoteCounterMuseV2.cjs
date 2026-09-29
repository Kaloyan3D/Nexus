'use strict';
const https = require('node:https');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const REMOTE_SCHEMA_VERSION = 1;
const REMOTE_REVISION_V1 = 'meta-muse-input-tokens-api-v1';
const REMOTE_FINGERPRINT_V1 = 'meta-muse-input-tokens-api-v1';
const COUNT_PATH_V1 = '/v1/responses/input_tokens';
const RESPONSES_PATH_V1 = '/v1/responses';
const META_HOST_V1 = 'api.meta.ai';
const DEFAULT_TIMEOUT_MS = 30000;
const REMOTE_EXACT_KEYS = Object.freeze(['schemaVersion', 'provider', 'model', 'endpoint', 'fingerprint', 'revision', 'source', 'verified']);
const PRODUCTION_REMOTE_ENTRIES = Object.freeze([
  Object.freeze({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', host: META_HOST_V1, countPath: COUNT_PATH_V1, responsesPath: RESPONSES_PATH_V1 }),
]);
function failRemote(code, detail) {
  throw new Error('remote-counter-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}
function httpsPostJsonV2(input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; fn(); } };
    try {
      const body = typeof input.bodyJson === 'string' ? input.bodyJson : JSON.stringify(input.bodyJson);
      const req = https.request({
        hostname: input.hostname,
        path: input.reqPath,
        method: 'POST',
        timeout: input.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + input.apiKey,
        },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => done(() => resolve({ status: res.statusCode, bodyText: text })));
      });
      req.on('timeout', () => { req.destroy(new Error('remote-counter-timeout')); });
      req.on('error', (error) => done(() => reject(error)));
      req.write(body);
      req.end();
    } catch (error) {
      done(() => reject(error));
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
function createMuseRemoteCounterV2(input) {
  if (!isPlainObject(input)) failRemote('counter-input-invalid', 'remote counter input must be an object');
  const descriptor = isPlainObject(input.descriptor) ? input.descriptor : null;
  const apiKey = input.apiKey;
  if (descriptor === null || descriptor.verified !== true || descriptor.fingerprint !== REMOTE_FINGERPRINT_V1) {
    failRemote('counter-input-invalid', 'a verified remote descriptor for this contract is required');
  }
  if (typeof apiKey !== 'string' || apiKey === '') failRemote('counter-unavailable', 'no credential for the remote count endpoint');
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) failRemote('counter-input-invalid', 'timeoutMs must be positive');
  const transport = input.transport === undefined || input.transport === null
    ? { postJson: httpsPostJsonV2 }
    : input.transport;
  if (typeof transport.postJson !== 'function') failRemote('counter-input-invalid', 'transport.postJson is required');
  const entry = resolveRemoteEntryV2(descriptor.provider, descriptor.model);
  if (entry === null) failRemote('counter-input-invalid', 'descriptor route is not registered');
  async function postCountV2(bodyObject) {
    let outcome = null;
    try {
      outcome = await transport.postJson({
        hostname: entry.host,
        reqPath: entry.countPath,
        apiKey,
        bodyJson: canonicalJsonOf(bodyObject),
        timeoutMs,
      });
    } catch (error) {
      failRemote('counter-unavailable', 'count transport failed: ' + String((error && error.message) || error).slice(0, 160));
    }
    const classified = classifyCountResponseV2(outcome.status, outcome.bodyText);
    if (classified.ok === true) return { tokens: classified.tokens, object: classified.object };
    if (classified.kind === 'auth') failRemote('counter-unavailable', 'count endpoint auth failure');
    if (classified.kind === 'model-unsupported' || classified.kind === 'unsupported') {
      failRemote('counter-model-unsupported', classified.detail || classified.kind);
    }
    if (classified.kind === 'malformed') failRemote('counter-malformed', 'count response is not a valid token count');
    failRemote('counter-unavailable', 'count endpoint failure: ' + classified.kind);
    return null;
  }
  async function countTextsV2(texts) {
    if (!Array.isArray(texts)) failRemote('counter-input-invalid', 'texts must be an array');
    const unique = [];
    const seen = new Set();
    for (const text of texts) {
      if (typeof text !== 'string') failRemote('counter-input-invalid', 'every counted text must be a string');
      if (!seen.has(text)) { seen.add(text); unique.push(text); }
    }
    const results = await Promise.all(unique.map(async (text) => {
      const counted = await postCountV2({ model: entry.model, input: text });
      return { text, tokens: counted.tokens };
    }));
    const table = new Map();
    for (const row of results) table.set(row.text, row.tokens);
    return texts.map((text) => table.get(text));
  }
  async function countPayloadV2(shape) {
    if (!isPlainObject(shape)) failRemote('counter-input-invalid', 'payload shape must be an object');
    const body = { model: entry.model };
    if (shape.input !== undefined) body.input = shape.input;
    if (shape.instructions !== undefined) body.instructions = shape.instructions;
    if (shape.tools !== undefined) body.tools = shape.tools;
    if (shape.max_output_tokens !== undefined) body.max_output_tokens = shape.max_output_tokens;
    const counted = await postCountV2(body);
    return { tokens: counted.tokens, object: counted.object };
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
module.exports = {
  REMOTE_SCHEMA_VERSION,
  REMOTE_REVISION_V1,
  REMOTE_FINGERPRINT_V1,
  COUNT_PATH_V1,
  RESPONSES_PATH_V1,
  META_HOST_V1,
  DEFAULT_TIMEOUT_MS,
  REMOTE_EXACT_KEYS,
  resolveMuseRemoteV2,
  classifyCountResponseV2,
  createMuseRemoteCounterV2,
  describeMuseRemoteV2,
};
