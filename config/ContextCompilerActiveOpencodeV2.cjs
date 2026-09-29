'use strict';
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const museActiveV2 = require('./ContextCompilerActiveMuseV2.cjs');
const OPENCODE_AUTHORITY_V1 = 'REMOTE_MUSE_PRECOUNT';
const OPENCODE_PROVIDER_V1 = 'opencode-go';
const OPENCODE_MODEL_V1 = 'muse-spark-1.3-contributor';
const OPENCODE_HOST_V1 = 'opencode.ai';
const OPENCODE_RESPONSES_PATH_V1 = '/zen/go/v1/responses';
const COUNT_PROVIDER_V1 = 'meta-model-api';
const COUNT_MODEL_V1 = 'muse-spark-1.3-contributor';
const COUNT_WINDOW_V1 = 1048576;
const MARGIN_MIN_TOKENS_V1 = 8192;
const MARGIN_RATIO_V1 = 0.01;
const NEXUS_USER_AGENT_V1 = 'nexus-ai-harness/1.0';
const OPENCODE_SESSION_HEADER_V1 = 'x-opencode-session';
const HEALTH_HEALTHY = 'HEALTHY';
const HEALTH_QUARANTINED = 'QUARANTINED';
const healthByRoute = new Map();
function failOpencode(code, detail) {
  throw new Error('opencode-active-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
function routeKeyOf(provider, model) {
  return String(provider) + String.fromCharCode(10) + String(model);
}
function providerSafetyMarginV2(preCount) {
  if (!Number.isInteger(preCount) || preCount < 0) failOpencode('margin-invalid', 'preCount must be a non-negative integer');
  return Math.max(MARGIN_MIN_TOKENS_V1, Math.ceil(preCount * MARGIN_RATIO_V1));
}
function opencodeHealthV2(route) {
  try {
    if (!isPlainObject(route)) return HEALTH_QUARANTINED;
    const key = routeKeyOf(route.provider, route.model);
    return healthByRoute.get(key) === HEALTH_HEALTHY ? HEALTH_HEALTHY : HEALTH_QUARANTINED;
  } catch (error) {
    void error;
    return HEALTH_QUARANTINED;
  }
}
function markOpencodeHealthyV2(route, evidence) {
  if (!isPlainObject(route) || route.provider !== OPENCODE_PROVIDER_V1 || route.model !== OPENCODE_MODEL_V1) {
    failOpencode('route-invalid', 'only the approved OpenCode Muse pair can become healthy');
  }
  if (!isPlainObject(evidence) || typeof evidence.canaryDigest !== 'string' || evidence.canaryDigest === '') {
    failOpencode('evidence-invalid', 'canary evidence digest is required');
  }
  healthByRoute.set(routeKeyOf(route.provider, route.model), HEALTH_HEALTHY);
  return Object.freeze({ provider: route.provider, model: route.model, health: HEALTH_HEALTHY, canaryDigest: evidence.canaryDigest });
}
function quarantineOpencodeV2(route, reason) {
  try {
    if (!isPlainObject(route)) return Object.freeze({ health: HEALTH_QUARANTINED, reason: 'route-invalid' });
    healthByRoute.set(routeKeyOf(route.provider, route.model), HEALTH_QUARANTINED);
    return Object.freeze({
      provider: route.provider,
      model: route.model,
      health: HEALTH_QUARANTINED,
      reason: typeof reason === 'string' && reason !== '' ? reason.slice(0, 128) : 'unspecified',
    });
  } catch (error) {
    void error;
    return Object.freeze({ health: HEALTH_QUARANTINED, reason: 'quarantine-failed' });
  }
}
function resetOpencodeHealthV2() {
  healthByRoute.clear();
}
function opencodeHeadersV2(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    failOpencode('headers-invalid', 'a stable session id is required for OpenCode routing');
  }
  const headers = {};
  headers[OPENCODE_SESSION_HEADER_V1] = sessionId;
  headers['user-agent'] = NEXUS_USER_AGENT_V1;
  return Object.freeze(headers);
}
function postOpencodeInferenceV2(input) {
  const https = require('node:https');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; fn(); } };
    try {
      const headers = isPlainObject(input.headers) ? input.headers : {};
      const merged = {};
      for (const key of Object.keys(headers)) merged[key] = headers[key];
      merged['Content-Type'] = 'application/json';
      merged.Authorization = 'Bearer ' + input.apiKey;
      const body = typeof input.bodyJson === 'string' ? input.bodyJson : JSON.stringify(input.bodyJson);
      merged['Content-Length'] = Buffer.byteLength(body);
      const req = https.request({
        hostname: input.hostname,
        path: input.reqPath,
        method: 'POST',
        timeout: input.timeoutMs,
        headers: merged,
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => done(() => resolve({ status: res.statusCode, bodyText: text })));
      });
      req.on('timeout', () => { req.destroy(new Error('opencode-inference-timeout')); });
      req.on('error', (error) => done(() => reject(error)));
      req.write(body);
      req.end();
    } catch (error) {
      done(() => reject(error));
    }
  });
}
function ineligibleOpencode(reason, health, extra) {
  return Object.freeze(Object.assign({
    eligible: false,
    mode: 'LEGACY',
    fallbackReason: reason,
    view: null,
    layout: null,
    render: null,
    preCount: null,
    providerSafetyMargin: null,
    inferenceBody: null,
    compilerExecutions: 0,
    authorityHealth: health,
    telemetry: Object.freeze({
      projectionMode: 'LEGACY',
      fallbackReason: reason,
      authority: OPENCODE_AUTHORITY_V1,
      authorityHealth: health,
      compilerExecutions: 0,
    }),
  }, extra || {}));
}
function checkAttemptShapeV2(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  const allowed = ['compileInput', 'pages', 'metaRemoteCounter', 'requestTerms', 'binding', 'retrievalRequest', 'compressionPolicyRevision', 'packingPolicyRevision', 'layoutPolicyRevision', 'getCurrentRevision', 'telemetrySink'];
  for (const key of Object.keys(input)) {
    if (allowed.indexOf(key) === -1) return 'unknown key ' + String(key).slice(0, 64);
  }
  if (!isPlainObject(input.compileInput) || !Array.isArray(input.pages)) return 'compileInput/pages required';
  if (!isPlainObject(input.requestTerms)) return 'requestTerms required';
  if (!isPlainObject(input.binding)) return 'binding required';
  return null;
}
function countBindingOfV2(binding) {
  if (!isPlainObject(binding)) return binding;
  return Object.freeze({
    taskId: binding.taskId,
    taskInstanceId: binding.taskInstanceId,
    sessionId: binding.sessionId,
    checkpointGeneration: binding.checkpointGeneration,
    checkpointId: binding.checkpointId,
    snapshotRevision: binding.snapshotRevision,
    turnId: binding.turnId,
    turnTextHash: binding.turnTextHash,
    provider: COUNT_PROVIDER_V1,
    model: COUNT_MODEL_V1,
    maxTokens: binding.maxTokens,
    outputReserve: binding.outputReserveTokens,
    counterFingerprint: binding.tokenizerFingerprint,
    counterRevision: binding.capabilityRevision,
  });
}
async function attemptOpencodeActiveV2(input) {
  const shapeError = checkAttemptShapeV2(input);
  if (shapeError !== null) return ineligibleOpencode('active-compiler-failed', HEALTH_QUARANTINED);
  const health = opencodeHealthV2({ provider: OPENCODE_PROVIDER_V1, model: OPENCODE_MODEL_V1 });
  if (health !== HEALTH_HEALTHY) return ineligibleOpencode('active-tokenizer-unavailable', health);
  try {
    const terms = input.requestTerms;
    const binding = input.binding;
    if (binding.provider !== OPENCODE_PROVIDER_V1 || binding.model !== OPENCODE_MODEL_V1) {
      return ineligibleOpencode('active-request-binding-changed', health);
    }
    const inner = await museActiveV2.attemptMuseActiveV2({
      compileInput: input.compileInput,
      pages: input.pages,
      remoteCounter: input.metaRemoteCounter,
      route: { provider: COUNT_PROVIDER_V1, model: COUNT_MODEL_V1, maxContextTokens: COUNT_WINDOW_V1 },
      requestTerms: terms,
      binding: countBindingOfV2(binding),
      retrievalRequest: input.retrievalRequest,
      compressionPolicyRevision: input.compressionPolicyRevision,
      packingPolicyRevision: input.packingPolicyRevision,
      layoutPolicyRevision: input.layoutPolicyRevision,
      getCurrentRevision: input.getCurrentRevision === undefined ? null : input.getCurrentRevision,
      telemetrySink: null,
    });
    if (inner.eligible !== true) {
      return ineligibleOpencode(inner.fallbackReason, health, {
        compilerExecutions: inner.compilerExecutions === 1 ? 1 : 0,
        telemetry: Object.freeze({
          projectionMode: 'LEGACY',
          fallbackReason: inner.fallbackReason,
          authority: OPENCODE_AUTHORITY_V1,
          authorityHealth: health,
          compilerExecutions: inner.compilerExecutions === 1 ? 1 : 0,
        }),
      });
    }
    const margin = providerSafetyMarginV2(inner.preCount);
    const reserve = Number.isInteger(terms.outputReserve) ? terms.outputReserve : 0;
    if (inner.preCount + margin + reserve > COUNT_WINDOW_V1) {
      return ineligibleOpencode('active-render-over-budget', health, {
        compilerExecutions: 1,
        telemetry: Object.freeze({
          projectionMode: 'LEGACY',
          fallbackReason: 'active-render-over-budget',
          authority: OPENCODE_AUTHORITY_V1,
          authorityHealth: health,
          compilerExecutions: 1,
          preCount: inner.preCount,
          providerSafetyMargin: margin,
          outputReserve: reserve,
        }),
      });
    }
    const telemetry = Object.freeze(Object.assign({}, inner.telemetry, {
      authority: OPENCODE_AUTHORITY_V1,
      authorityHealth: health,
      providerSafetyMargin: margin,
      inferenceHost: OPENCODE_HOST_V1,
      inferencePath: OPENCODE_RESPONSES_PATH_V1,
    }));
    if (typeof input.telemetrySink === 'function') {
      try {
        input.telemetrySink(telemetry, { policyRevision: museActiveV2.MUSE_ACTIVE_REVISION_V1, authoritative: false });
      } catch (error) {
        void error;
      }
    }
    return Object.freeze({
      eligible: true,
      mode: 'CCV2_COMPILED',
      fallbackReason: null,
      view: inner.view,
      layout: inner.layout,
      render: inner.render,
      preCount: inner.preCount,
      providerSafetyMargin: margin,
      inferenceBody: inner.inferenceBody,
      binding: Object.freeze(deepClone(binding)),
      compilerExecutions: 1,
      authorityHealth: health,
      telemetry,
    });
  } catch (error) {
    void error;
    return ineligibleOpencode('active-compiler-failed', HEALTH_QUARANTINED);
  }
}
async function sendOpencodeCompiledV2(input) {
  const fail = (reason, external) => Object.freeze({
    sent: false, completed: false, reason, external: external === true,
    usage: null, preCount: null, usageMatch: null, usageWithinBound: null,
    anomaly: false, authorityHealth: opencodeHealthV2({ provider: OPENCODE_PROVIDER_V1, model: OPENCODE_MODEL_V1 }),
    outputText: '', incompleteReason: null, providerError: null,
    authority: OPENCODE_AUTHORITY_V1, providerSafetyMargin: null,
  });
  try {
    if (!isPlainObject(input) || !isPlainObject(input.decision) || !isPlainObject(input.liveBinding)) {
      return fail('active-request-binding-changed', false);
    }
    const decision = input.decision;
    if (decision.eligible !== true || decision.mode !== 'CCV2_COMPILED') return fail('active-compiler-failed', false);
    if (opencodeHealthV2({ provider: OPENCODE_PROVIDER_V1, model: OPENCODE_MODEL_V1 }) !== HEALTH_HEALTHY) {
      return fail('muse-inference-quarantined', false);
    }
    if (typeof input.apiKey !== 'string' || input.apiKey === '') return fail('muse-inference-auth', true);
    let headers = null;
    try {
      headers = opencodeHeadersV2(input.liveBinding.sessionId);
    } catch (error) {
      void error;
      return fail('active-request-binding-changed', false);
    }
    const poster = typeof input.inferencePost === 'function'
      ? (req) => input.inferencePost(Object.assign({}, req, { headers }))
      : (req) => postOpencodeInferenceV2(Object.assign({}, req, { headers }));
    const margin = providerSafetyMarginV2(decision.preCount);
    const inner = await museActiveV2.sendMuseCompiledV2({
      decision: {
        eligible: true,
        mode: 'CCV2_COMPILED',
        preCount: decision.preCount,
        inferenceBody: decision.inferenceBody,
        binding: countBindingOfV2(decision.binding),
      },
      liveBinding: countBindingOfV2(input.liveBinding),
      inferenceBody: input.inferenceBody,
      inferencePost: poster,
      apiKey: input.apiKey,
      hostname: input.hostname === undefined ? OPENCODE_HOST_V1 : input.hostname,
      reqPath: input.reqPath === undefined ? OPENCODE_RESPONSES_PATH_V1 : input.reqPath,
      timeoutMs: input.timeoutMs,
    });
    const reported = inner.usage !== null && Number.isInteger(inner.usage.promptTokens) ? inner.usage.promptTokens : null;
    let anomaly = false;
    if (reported !== null && reported > decision.preCount + margin) {
      anomaly = true;
      quarantineOpencodeV2({ provider: OPENCODE_PROVIDER_V1, model: OPENCODE_MODEL_V1 }, 'input-over-margin');
    }
    return Object.freeze(Object.assign({}, inner, {
      authority: OPENCODE_AUTHORITY_V1,
      providerSafetyMargin: margin,
      anomaly,
      authorityHealth: opencodeHealthV2({ provider: OPENCODE_PROVIDER_V1, model: OPENCODE_MODEL_V1 }),
    }));
  } catch (error) {
    void error;
    return fail('muse-inference-transport', true);
  }
}
module.exports = {
  OPENCODE_AUTHORITY_V1,
  OPENCODE_PROVIDER_V1,
  OPENCODE_MODEL_V1,
  OPENCODE_HOST_V1,
  OPENCODE_RESPONSES_PATH_V1,
  COUNT_PROVIDER_V1,
  COUNT_MODEL_V1,
  COUNT_WINDOW_V1,
  MARGIN_MIN_TOKENS_V1,
  MARGIN_RATIO_V1,
  HEALTH_HEALTHY,
  HEALTH_QUARANTINED,
  providerSafetyMarginV2,
  opencodeHealthV2,
  markOpencodeHealthyV2,
  quarantineOpencodeV2,
  resetOpencodeHealthV2,
  opencodeHeadersV2,
  postOpencodeInferenceV2,
  attemptOpencodeActiveV2,
  sendOpencodeCompiledV2,
};
