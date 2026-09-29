'use strict';
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const viewV2 = require('./ContextViewV2.cjs');
const shadowV2 = require('./ContextCompilerShadowV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');
const rendererV2 = require('./ContextPromptRendererV2.cjs');
const remoteV2 = require('./ContextRemoteCounterMuseV2.cjs');
const MUSE_ACTIVE_REVISION_V1 = 'context-compiler-active-muse-v1';
const PLANNING_FINGERPRINT_V1 = 'planning-byte-v1';
const LF = String.fromCharCode(10);
function failMuse(code, detail) {
  throw new Error('muse-active-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}
function canonicalJsonOf(value) {
  return JSON.stringify(checkpointV2.canonicalize(value));
}
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
function createPlanningCounterV2() {
  const counter = {
    tokenizerFingerprint: PLANNING_FINGERPRINT_V1,
    countText(text) {
      if (typeof text !== 'string') throw new Error('muse-active-planning-invalid: planning counter requires a string (DISCARDABLE)');
      return Buffer.byteLength(text, 'utf8');
    },
  };
  return Object.freeze(counter);
}
function candidateIdentityV2(view, layout) {
  const members = [];
  for (const section of viewV2.VIEW_SECTIONS) {
    for (const entry of view[section]) {
      members.push({
        section, id: entry.id, sourceId: entry.sourceId, contentHash: entry.contentHash,
        tier: entry.tier, kind: entry.representation ? entry.representation.kind : 'EXACT',
      });
    }
  }
  return {
    namespace: view.namespace,
    checkpointBinding: view.checkpointBinding,
    turnRef: view.turnRef,
    mandatoryRefs: view.mandatoryRefs,
    members,
    referenced: view.referencedColdPages.map((ref) => ({ pageId: ref.pageId, contentHash: ref.contentHash })),
    blocks: layout.blocks.map((block) => ({
      ordinal: block.ordinal, zone: block.zone, memberKind: block.memberKind,
      memberId: block.memberId, sourceId: block.sourceId, contentHash: block.contentHash,
    })),
  };
}
function ineligibleMuse(reason) {
  return Object.freeze({
    eligible: false,
    mode: 'LEGACY',
    fallbackReason: reason,
    view: null,
    layout: null,
    render: null,
    preCount: null,
    inferenceBody: null,
    compilerExecutions: 1,
    telemetry: Object.freeze({ projectionMode: 'LEGACY', fallbackReason: reason, compilerExecutions: 1 }),
  });
}
function checkAttemptShapeV2(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  const allowed = ['compileInput', 'pages', 'remoteCounter', 'route', 'requestTerms', 'binding', 'retrievalRequest', 'compressionPolicyRevision', 'packingPolicyRevision', 'layoutPolicyRevision', 'getCurrentRevision', 'telemetrySink'];
  for (const key of Object.keys(input)) {
    if (allowed.indexOf(key) === -1) return 'unknown key ' + String(key).slice(0, 64);
  }
  if (!isPlainObject(input.compileInput) || !Array.isArray(input.pages)) return 'compileInput/pages required';
  const rc = input.remoteCounter;
  if (!isPlainObject(rc) || typeof rc.countTextsV2 !== 'function' || typeof rc.countPayloadV2 !== 'function' || typeof rc.buildMemoCounterV2 !== 'function') {
    return 'remoteCounter with countTexts/countPayload/memo builder required';
  }
  if (rc.fingerprint !== remoteV2.REMOTE_FINGERPRINT_V1) return 'remote counter fingerprint mismatch';
  const route = input.route;
  if (!isPlainObject(route) || typeof route.provider !== 'string' || typeof route.model !== 'string') return 'route provider/model required';
  if (rc.provider !== route.provider || rc.model !== route.model) return 'counter route mismatch';
  if (!Number.isInteger(route.maxContextTokens) || route.maxContextTokens <= 0) return 'route maxContextTokens required';
  const terms = input.requestTerms;
  if (!isPlainObject(terms) || typeof terms.systemText !== 'string' || typeof terms.turnText !== 'string') return 'requestTerms systemText/turnText required';
  if (!Number.isInteger(terms.maxTokens) || terms.maxTokens <= 0) return 'requestTerms maxTokens required';
  if (!Number.isInteger(terms.outputReserve) || terms.outputReserve < 0) return 'requestTerms outputReserve required';
  if (terms.reasoningEffort !== undefined && terms.reasoningEffort !== null
    && (typeof terms.reasoningEffort !== 'string' || terms.reasoningEffort === '')) {
    return 'requestTerms reasoningEffort must be a non-empty string or omitted';
  }
  if (terms.toolsJson !== undefined && terms.toolsJson !== null && typeof terms.toolsJson !== 'string') return 'toolsJson must be a string or omitted';
  if (!isPlainObject(input.binding)) return 'binding required';
  return null;
}
function checkBindingShapeV2(binding) {
  if (!isPlainObject(binding)) return false;
  const keys = ['taskId', 'taskInstanceId', 'sessionId', 'checkpointGeneration', 'checkpointId', 'snapshotRevision', 'turnId', 'turnTextHash', 'provider', 'model', 'maxTokens', 'outputReserve', 'counterFingerprint', 'counterRevision'];
  for (const key of keys) {
    if (binding[key] === undefined) return false;
  }
  for (const key of Object.keys(binding)) {
    if (keys.indexOf(key) === -1) return false;
  }
  return true;
}
function mapRemoteErrorV2(error) {
  const text = String((error && error.message) || error);
  if (text.indexOf('counter-model-unsupported') !== -1) return 'active-model-capability-unknown';
  if (text.indexOf('remote-counter-memo-miss') !== -1 || text.indexOf('remote-counter-memo-invalid') !== -1) return 'active-compiler-failed';
  if (text.indexOf('context-render-current-turn-invalid') !== -1) return 'active-current-turn-invalid';
  if (text.indexOf('context-render-tool-protocol-invalid') !== -1) return 'active-tool-protocol-invalid';
  if (text.indexOf('context-render-mandatory-missing') !== -1) return 'active-mandatory-coverage-failed';
  return 'active-tokenizer-unavailable';
}
function buildInferenceBodyV2(route, systemJoined, turnText, toolsJsonOrNull, maxOutputTokens, reasoningEffort) {
  const input = [{ role: 'user', content: turnText }];
  const body = { model: route.model, instructions: systemJoined, input };
  if (typeof reasoningEffort === 'string' && reasoningEffort !== '') {
    body.reasoning = { effort: reasoningEffort };
  }
  if (toolsJsonOrNull !== null && toolsJsonOrNull !== undefined) {
    let tools = null;
    try {
      tools = JSON.parse(toolsJsonOrNull);
    } catch (error) {
      void error;
      failMuse('tools-invalid', 'toolsJson is not valid JSON');
    }
    if (tools !== null && !(Array.isArray(tools) && tools.length === 0)) body.tools = tools;
  }
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_output_tokens = maxOutputTokens;
  return body;
}
async function attemptMuseActiveV2(input) {
  const shapeError = checkAttemptShapeV2(input);
  if (shapeError !== null) return ineligibleMuse('active-compiler-failed');
  try {
    const compileInput = input.compileInput;
    const pages = input.pages;
    const remoteCounter = input.remoteCounter;
    const route = input.route;
    const terms = input.requestTerms;
    const binding = input.binding;
    if (checkBindingShapeV2(binding) !== true) return ineligibleMuse('active-request-binding-changed');
    if (binding.provider !== route.provider || binding.model !== route.model) return ineligibleMuse('active-request-binding-changed');
    if (binding.counterFingerprint !== remoteV2.REMOTE_FINGERPRINT_V1 || binding.counterRevision !== remoteV2.REMOTE_REVISION_V1) {
      return ineligibleMuse('active-request-binding-changed');
    }
    if (binding.turnTextHash !== sha256HexUtf8(terms.turnText)) return ineligibleMuse('active-current-turn-invalid');
    if (binding.maxTokens !== terms.maxTokens || binding.outputReserve !== terms.outputReserve) {
      return ineligibleMuse('active-request-binding-changed');
    }
    let remoteCalls = 0;
    const countedRemote = async (texts) => {
      remoteCalls += 1;
      return remoteCounter.countTextsV2(texts);
    };
    // Reserve terms through the provider authority (parallel, exact).
    const reserveTexts = [terms.systemText, terms.turnText];
    if (typeof terms.toolsJson === 'string' && terms.toolsJson !== '') reserveTexts.push(terms.toolsJson);
    let reserveCounts = null;
    try {
      reserveCounts = await countedRemote(reserveTexts);
    } catch (error) {
      return ineligibleMuse(mapRemoteErrorV2(error));
    }
    let reserveTokens = 0;
    for (const count of reserveCounts) reserveTokens += count;
    const hardMax = route.maxContextTokens - terms.outputReserve - reserveTokens;
    if (!Number.isInteger(hardMax) || hardMax < 1) return ineligibleMuse('active-budget-unrepresentable');
    const budget = { hardMax, target: hardMax };
    const effectiveCompileInput = deepClone(compileInput);
    effectiveCompileInput.budget = { hardMax, target: hardMax };
    const planning = createPlanningCounterV2();
    // Pass 1 (planning only, never authoritative): full pipeline + render.
    let candidate1 = null;
    let render1 = null;
    try {
      candidate1 = shadowV2.buildCandidateV2({
        compileInput: effectiveCompileInput, pages, budget, counter: planning,
        retrievalRequest: input.retrievalRequest === undefined ? null : input.retrievalRequest,
        compressionPolicyRevision: input.compressionPolicyRevision,
        packingPolicyRevision: input.packingPolicyRevision,
        layoutPolicyRevision: input.layoutPolicyRevision,
      });
      render1 = rendererV2.renderContextPromptV2({ view: candidate1.view, layout: candidate1.layout, counter: planning });
    } catch (error) {
      return ineligibleMuse('active-compiler-failed');
    }
    // Binding coherence of the planned candidate.
    const view1 = candidate1.view;
    if (view1.turnRef.turnId !== binding.turnId) return ineligibleMuse('active-current-turn-invalid');
    if (view1.checkpointBinding.snapshotRevision !== binding.snapshotRevision) return ineligibleMuse('active-snapshot-stale');
    // Enumerate every text the authoritative pass may count.
    const enumeration = [];
    const seen = new Set();
    const addText = (text) => {
      if (typeof text !== 'string' || seen.has(text)) return;
      seen.add(text);
      enumeration.push(text);
    };
    for (const section of viewV2.VIEW_SECTIONS) {
      for (const entry of view1[section]) addText(entry.exactText);
    }
    for (const segment of render1.segments) addText(segment.text);
    addText(render1.joinedText);
    for (const message of render1.messagePlan) addText(message.text);
    addText(rendererV2.RENDER_SEPARATOR_V1);
    addText(terms.systemText);
    addText(terms.turnText);
    if (typeof terms.toolsJson === 'string' && terms.toolsJson !== '') addText(terms.toolsJson);
    let entryCounts = null;
    try {
      entryCounts = await countedRemote(enumeration);
    } catch (error) {
      return ineligibleMuse(mapRemoteErrorV2(error));
    }
    const table = new Map();
    for (let index = 0; index < enumeration.length; index += 1) table.set(enumeration[index], entryCounts[index]);
    let memo = null;
    try {
      memo = remoteCounter.buildMemoCounterV2(table);
    } catch (error) {
      return ineligibleMuse('active-compiler-failed');
    }
    // Pass 2 (authoritative): identical pipeline through provider counts.
    let candidate2 = null;
    let render2 = null;
    try {
      candidate2 = shadowV2.buildCandidateV2({
        compileInput: effectiveCompileInput, pages, budget, counter: memo,
        retrievalRequest: input.retrievalRequest === undefined ? null : input.retrievalRequest,
        compressionPolicyRevision: input.compressionPolicyRevision,
        packingPolicyRevision: input.packingPolicyRevision,
        layoutPolicyRevision: input.layoutPolicyRevision,
      });
      render2 = rendererV2.renderContextPromptV2({ view: candidate2.view, layout: candidate2.layout, counter: memo });
    } catch (error) {
      return ineligibleMuse(mapRemoteErrorV2(error));
    }
    // Counter-independence proof: identical selection under both
    // authorities, or no compiled send.
    if (canonicalJsonOf(candidateIdentityV2(candidate1.view, candidate1.layout))
      !== canonicalJsonOf(candidateIdentityV2(candidate2.view, candidate2.layout))) {
      return ineligibleMuse('active-compiler-failed');
    }
    // Current turn exactly once, byte-exact, in the authoritative render.
    const userTexts = render2.messagePlan.filter((message) => message.role === 'user').map((message) => message.text);
    if (userTexts.length !== 1 || sha256HexUtf8(userTexts[0]) !== sha256HexUtf8(terms.turnText)) {
      return ineligibleMuse('active-current-turn-invalid');
    }
    if (render2.renderedTokens > hardMax) return ineligibleMuse('active-render-over-budget');
    // Balanced tool protocol in the authoritative view.
    let balancedTools = 0;
    for (const section of viewV2.VIEW_SECTIONS) {
      for (const entry of candidate2.view[section]) {
        if (entry.toolTransaction !== null && entry.toolTransaction !== undefined) {
          if (entry.toolTransaction.callPresent !== true || entry.toolTransaction.resultPresent !== true) {
            return ineligibleMuse('active-tool-protocol-invalid');
          }
          balancedTools += 1;
        }
      }
    }
    // EXACT inference body (this object is counted, then sent verbatim).
    const systemMessages = render2.messagePlan.filter((message) => message.role === 'system').map((message) => message.text);
    const systems = [terms.systemText].concat(systemMessages).filter((text) => text !== '');
    let systemJoined = '';
    for (let index = 0; index < systems.length; index += 1) {
      systemJoined += (index === 0 ? '' : LF + LF) + systems[index];
    }
    let inferenceBody = null;
    try {
      inferenceBody = buildInferenceBodyV2(route, systemJoined, terms.turnText,
        typeof terms.toolsJson === 'string' ? terms.toolsJson : null, terms.maxTokens,
        typeof terms.reasoningEffort === 'string' ? terms.reasoningEffort : null);
    } catch (error) {
      return ineligibleMuse('active-compiler-failed');
    }
    // FINAL authoritative pre-count: exactly one whole-payload count.
    let preCount = null;
    try {
      const counted = await remoteCounter.countPayloadV2(inferenceBody);
      preCount = counted.tokens;
      remoteCalls += 1;
    } catch (error) {
      return ineligibleMuse(mapRemoteErrorV2(error));
    }
    if (preCount + terms.outputReserve > route.maxContextTokens) return ineligibleMuse('active-render-over-budget');
    // Final TOCTOU revalidation before the send boundary.
    let completeRevision = binding.snapshotRevision;
    if (typeof input.getCurrentRevision === 'function') {
      try {
        const observed = input.getCurrentRevision();
        if (typeof observed === 'string' && observed !== '') completeRevision = observed;
      } catch (error) {
        void error;
        return ineligibleMuse('active-snapshot-stale');
      }
    }
    if (completeRevision !== binding.snapshotRevision) return ineligibleMuse('active-snapshot-stale');
    const renderCheck = rendererV2.validateContextRenderV2(render2);
    if (!renderCheck.valid) return ineligibleMuse('active-render-invalid');
    let memoDigest = '';
    try {
      const sortedKeys = Array.from(table.keys()).sort();
      memoDigest = sha256HexUtf8(canonicalJsonOf(sortedKeys.map((key) => [sha256HexUtf8(key), table.get(key)])));
    } catch (error) {
      void error;
    }
    const telemetry = Object.freeze({
      projectionMode: 'CCV2_COMPILED',
      fallbackReason: null,
      candidateViewId: candidate2.view.id,
      viewDigest: candidate2.view.viewDigest,
      layoutDigest: candidate2.layout.layoutDigest,
      renderDigest: render2.renderDigest,
      counterFingerprint: remoteV2.REMOTE_FINGERPRINT_V1,
      counterRevision: remoteV2.REMOTE_REVISION_V1,
      counterKind: 'REMOTE_EXACT',
      modelMax: route.maxContextTokens,
      ccv2HardMax: hardMax,
      reserveTokens: reserveTokens,
      renderedTokens: render2.renderedTokens,
      boundaryDeltaTokens: render2.boundaryDeltaTokens,
      preCount,
      outputReserve: terms.outputReserve,
      memoEntries: table.size,
      memoDigest,
      remoteCalls,
      mandatoryTotal: candidate2.view.mandatoryRefs.length,
      balancedToolTransactions: balancedTools,
      compilerExecutions: 1,
    });
    if (typeof input.telemetrySink === 'function') {
      try {
        input.telemetrySink(telemetry, { policyRevision: MUSE_ACTIVE_REVISION_V1, authoritative: false });
      } catch (error) {
        void error;
      }
    }
    return Object.freeze({
      eligible: true,
      mode: 'CCV2_COMPILED',
      fallbackReason: null,
      view: candidate2.view,
      layout: candidate2.layout,
      render: render2,
      preCount,
      inferenceBody: Object.freeze(deepClone(inferenceBody)),
      binding: Object.freeze(deepClone(binding)),
      compilerExecutions: 1,
      telemetry,
    });
  } catch (error) {
    return ineligibleMuse(mapRemoteErrorV2(error));
  }
}
function httpsPostInferenceV2(input) {
  const https = require('node:https');
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
      req.on('timeout', () => { req.destroy(new Error('muse-inference-timeout')); });
      req.on('error', (error) => done(() => reject(error)));
      req.write(body);
      req.end();
    } catch (error) {
      done(() => reject(error));
    }
  });
}
function checkSendBindingV2(stored, live) {
  if (!checkBindingShapeV2(stored) || !checkBindingShapeV2(live)) return 'active-request-binding-changed';
  for (const key of Object.keys(stored)) {
    if (canonicalJsonOf(stored[key]) !== canonicalJsonOf(live[key])) {
      if (key === 'snapshotRevision' || key === 'checkpointGeneration' || key === 'checkpointId') return 'active-snapshot-stale';
      if (key === 'turnId' || key === 'turnTextHash') return 'active-current-turn-invalid';
      return 'active-request-binding-changed';
    }
  }
  return null;
}
function safeProviderErrorV2(error) {
  if (!isPlainObject(error)) return Object.freeze({ type: 'unspecified', code: 'unspecified' });
  const type = typeof error.type === 'string' && error.type !== '' ? error.type.slice(0, 128) : 'unspecified';
  const code = typeof error.code === 'string' && error.code !== '' ? error.code.slice(0, 128) : 'unspecified';
  return Object.freeze({ type, code });
}
function validUsageOrNullV2(usage) {
  if (!isPlainObject(usage)) return null;
  const firstDefined = (...values) => {
    for (const value of values) {
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const inputTokens = firstDefined(usage.input_tokens, usage.prompt_tokens);
  if (!Number.isInteger(inputTokens) || inputTokens < 0) return null;
  const outputTokens = firstDefined(usage.output_tokens, usage.completion_tokens);
  const totalTokens = firstDefined(usage.total_tokens);
  const optional = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const detailsOf = (container, key, alias) => {
    if (!isPlainObject(container)) return null;
    const details = container[key] !== undefined ? container[key] : container[alias];
    if (!isPlainObject(details)) return null;
    return details;
  };
  const inputDetails = detailsOf(usage, 'input_tokens_details', 'prompt_tokens_details');
  const outputDetails = detailsOf(usage, 'output_tokens_details', 'completion_tokens_details');
  return Object.freeze({
    promptTokens: inputTokens,
    outputTokens: optional(outputTokens),
    totalTokens: optional(totalTokens),
    cachedInputTokens: inputDetails !== null && Number.isInteger(inputDetails.cached_tokens) && inputDetails.cached_tokens >= 0
      ? inputDetails.cached_tokens : null,
    reasoningOutputTokens: outputDetails !== null && Number.isInteger(outputDetails.reasoning_tokens) && outputDetails.reasoning_tokens >= 0
      ? outputDetails.reasoning_tokens : null,
  });
}
function responseItemTypesV2(output) {
  const types = [];
  for (const item of output) {
    if (item !== null && typeof item === 'object' && typeof item.type === 'string' && types.indexOf(item.type) === -1) {
      types.push(item.type);
    }
  }
  return types;
}
function extractResponsesTextV2(output) {
  const parts = [];
  for (const item of output) {
    if (item === null || typeof item !== 'object') return { ok: false };
    if (typeof item.type !== 'string') return { ok: false };
    if (item.type !== 'message') continue;
    if (item.content === undefined || item.content === null) continue;
    if (!Array.isArray(item.content)) return { ok: false };
    for (const content of item.content) {
      if (content === null || content === undefined) continue;
      if (typeof content !== 'object') return { ok: false };
      if (content.type !== 'output_text') continue;
      if (typeof content.text !== 'string') return { ok: false };
      parts.push(content.text);
    }
  }
  return { ok: true, text: parts.join(String.fromCharCode(10)), types: responseItemTypesV2(output) };
}
function responseShapeOfV2(body) {
  try {
    if (!isPlainObject(body)) return null;
    const types = [];
    if (Array.isArray(body.output)) {
      for (const item of body.output) {
        if (item !== null && typeof item === 'object' && typeof item.type === 'string' && types.indexOf(item.type) === -1) {
          types.push(item.type);
        }
      }
    }
    return Object.freeze({
      object: typeof body.object === 'string' ? body.object : null,
      status: typeof body.status === 'string' ? body.status : null,
      hasError: body.error !== undefined && body.error !== null,
      hasUsage: isPlainObject(body.usage),
      outputIsArray: Array.isArray(body.output),
      outputTypes: Object.freeze(types),
    });
  } catch (error) {
    void error;
    return null;
  }
}
function classifyResponsesBodyV2(body) {
  if (!isPlainObject(body)) return { kind: 'malformed' };
  if (body.error !== undefined && body.error !== null) {
    return { kind: 'failed', providerError: safeProviderErrorV2(body.error) };
  }
  if (body.object !== 'response') return { kind: 'malformed' };
  const status = body.status;
  if (status === 'failed') {
    return { kind: 'failed', providerError: safeProviderErrorV2(body.error) };
  }
  const usage = validUsageOrNullV2(body.usage);
  if (status === 'incomplete') {
    if (usage === null) return { kind: 'malformed' };
    let reason = 'unspecified';
    if (isPlainObject(body.incomplete_details) && typeof body.incomplete_details.reason === 'string' && body.incomplete_details.reason !== '') {
      reason = body.incomplete_details.reason.slice(0, 128);
    }
    return { kind: 'incomplete', usage, incompleteReason: reason };
  }
  if (status !== 'completed') return { kind: 'malformed' };
  if (!Array.isArray(body.output)) return { kind: 'malformed' };
  if (usage === null) return { kind: 'malformed' };
  const extracted = extractResponsesTextV2(body.output);
  if (extracted.ok !== true) return { kind: 'malformed' };
  if (extracted.text === '') return { kind: 'no-text', usage, types: extracted.types };
  return { kind: 'completed', usage, outputText: extracted.text, types: extracted.types };
}
function finishMuseSendV2(fail, decision, body, shape) {
  const classified = classifyResponsesBodyV2(body);
  const withShape = (result) => Object.freeze(Object.assign({}, result, { responseShape: shape === undefined ? null : shape }));
  if (classified.kind === 'malformed') return withShape(fail('muse-inference-malformed', true));
  const modelName = typeof body.model === 'string' ? body.model : null;
  const packUsage = (usage) => Object.freeze({
    promptTokens: usage.promptTokens, outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens, model: modelName,
    cachedInputTokens: usage.cachedInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens,
  });
  const withinBound = (usageOrNull) => {
    if (usageOrNull === null) return null;
    if (usageOrNull.promptTokens === null || usageOrNull.promptTokens <= 0) return false;
    return usageOrNull.promptTokens <= decision.preCount;
  };
  if (classified.kind === 'failed') {
    const usage = validUsageOrNullV2(body.usage);
    return withShape(Object.freeze({
      sent: false, completed: false, reason: 'muse-inference-failed', external: true,
      preCount: decision.preCount, outputText: '',
      usage: usage === null ? null : packUsage(usage),
      usageMatch: usage === null ? null : usage.promptTokens === decision.preCount,
      usageWithinBound: usage === null ? null : withinBound(usage),
      incompleteReason: null,
      providerError: classified.providerError,
    }));
  }
  if (classified.kind === 'incomplete') {
    return withShape(Object.freeze({
      sent: true, completed: false, reason: 'muse-inference-incomplete', external: true,
      preCount: decision.preCount, outputText: '',
      usage: packUsage(classified.usage),
      usageMatch: classified.usage.promptTokens === decision.preCount,
      usageWithinBound: withinBound(classified.usage),
      incompleteReason: classified.incompleteReason,
      providerError: null,
    }));
  }
  if (classified.kind === 'no-text') {
    return withShape(Object.freeze({
      sent: true, completed: false, reason: 'muse-inference-no-text', external: false,
      preCount: decision.preCount, outputText: '',
      usage: packUsage(classified.usage),
      usageMatch: classified.usage.promptTokens === decision.preCount,
      usageWithinBound: withinBound(classified.usage),
      incompleteReason: null,
      providerError: null,
    }));
  }
  return withShape(Object.freeze({
    sent: true, completed: true, reason: null, external: false,
    usageWithinBound: withinBound(classified.usage),
    preCount: decision.preCount, outputText: classified.outputText,
    usage: packUsage(classified.usage),
    usageMatch: classified.usage.promptTokens === decision.preCount,
    incompleteReason: null,
    providerError: null,
  }));
}
async function sendMuseCompiledV2(input) {
  const fail = (reason, external) => Object.freeze({
    sent: false, completed: false, reason, external: external === true,
    usage: null, preCount: null, usageMatch: null, usageWithinBound: null,
    outputText: '', incompleteReason: null, providerError: null,
  });
  try {
    if (!isPlainObject(input) || !isPlainObject(input.decision) || !isPlainObject(input.liveBinding)) {
      return fail('active-request-binding-changed', false);
    }
    const decision = input.decision;
    if (decision.eligible !== true || decision.mode !== 'CCV2_COMPILED') return fail('active-compiler-failed', false);
    const drift = checkSendBindingV2(decision.binding, input.liveBinding);
    if (drift !== null) return fail(drift, false);
    if (canonicalJsonOf(decision.inferenceBody) !== canonicalJsonOf(input.inferenceBody)) {
      return fail('active-request-binding-changed', false);
    }
    const poster = typeof input.inferencePost === 'function' ? input.inferencePost : httpsPostInferenceV2;
    const timeoutMs = input.timeoutMs === undefined ? 120000 : input.timeoutMs;
    let outcome = null;
    try {
      outcome = await poster({
        hostname: input.hostname,
        reqPath: input.reqPath,
        apiKey: input.apiKey,
        bodyJson: canonicalJsonOf(decision.inferenceBody),
        timeoutMs,
      });
    } catch (error) {
      return fail('muse-inference-transport', true);
    }
    if (!isPlainObject(outcome) || typeof outcome.status !== 'number') return fail('muse-inference-transport', true);
    const withStatus = (result) => Object.freeze(Object.assign({}, result, { httpStatus: outcome.status }));
    if (outcome.status === 401 || outcome.status === 403) return withStatus(fail('muse-inference-auth', true));
    if (outcome.status === 429) return withStatus(fail('muse-inference-rate-limited', true));
    if (outcome.status !== 200) {
      let rejection = null;
      try {
        const parsed = JSON.parse(outcome.bodyText);
        if (isPlainObject(parsed)) {
          rejection = Object.freeze({
            bodyKind: isPlainObject(parsed.error) ? 'json-error' : 'json-other',
            errorType: isPlainObject(parsed.error) && typeof parsed.error.type === 'string' ? parsed.error.type.slice(0, 128) : null,
            errorCode: isPlainObject(parsed.error) && typeof parsed.error.code === 'string' ? parsed.error.code.slice(0, 128) : null,
          });
        } else {
          rejection = Object.freeze({ bodyKind: 'json-other', errorType: null, errorCode: null });
        }
      } catch (error) {
        void error;
        rejection = Object.freeze({
          bodyKind: typeof outcome.bodyText === 'string' && outcome.bodyText.trim().startsWith('<') ? 'html' : 'text',
          errorType: null, errorCode: null,
        });
      }
      const rejected = fail('muse-inference-rejected', true);
      return withStatus(Object.freeze(Object.assign({}, rejected, { rejection })));
    }
    let body = null;
    try {
      body = JSON.parse(outcome.bodyText);
    } catch (error) {
      void error;
      return fail('muse-inference-malformed', true);
    }
    return finishMuseSendV2(fail, decision, body, responseShapeOfV2(body));
  } catch (error) {
    void error;
    return fail('muse-inference-transport', true);
  }
}
module.exports = {
  MUSE_ACTIVE_REVISION_V1,
  PLANNING_FINGERPRINT_V1,
  createPlanningCounterV2,
  candidateIdentityV2,
  extractResponsesTextV2,
  classifyResponsesBodyV2,
  attemptMuseActiveV2,
  sendMuseCompiledV2,
};
