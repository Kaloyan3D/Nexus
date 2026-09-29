'use strict';
const fs = require('node:fs');
const path = require('node:path');
const checkpointV2 = require('./ContextCheckpointV2.cjs');
const compilerV2 = require('./ContextCompilerV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');
const activeV2 = require('./ContextCompilerActiveV2.cjs');
const shadowHostV2 = require('./ContextCompilerShadowHostV2.cjs');
const remoteV2 = require('./ContextRemoteCounterMuseV2.cjs');
const opencodeV2 = require('./ContextCompilerActiveOpencodeV2.cjs');
const certV2 = require('./ContextAuthorityCertificationV2.cjs');
const HOST_SCHEMA_VERSION = 1;
const OPENCODE_REQUEST_SHAPE_V1 = 'opencode-muse-request-shape-v1';
const MARGIN_POLICY_REVISION_V1 = 'opencode-margin-policy-v1';
const OUTPUT_RESERVE_POLICY_REVISION_V1 = 'opencode-output-reserve-policy-v1';
const CANARY_SUITE_REVISION_V1 = 'oc01-canary-suite-v1';
const MODEL_API_KEY_ENV = 'MODEL_API_KEY';
const AUXILIARY_PURPOSES = Object.freeze(['compaction', 'session-title']);
const installedCtxs = new WeakSet();
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
function tripleOf(ns) {
  if (!isPlainObject(ns)) return null;
  if (typeof ns.taskId !== 'string' || typeof ns.taskInstanceId !== 'string' || typeof ns.sessionId !== 'string') return null;
  return { taskId: ns.taskId, taskInstanceId: ns.taskInstanceId, sessionId: ns.sessionId };
}
function resolveOpencodeStoreRootV2(input) {
  try {
    if (isPlainObject(input) && typeof input.storeRoot === 'string' && input.storeRoot !== '') {
      return path.resolve(String(input.storeRoot));
    }
    if (isPlainObject(input) && typeof input.bindingsPath === 'string' && input.bindingsPath !== '') {
      return path.join(path.dirname(path.resolve(String(input.bindingsPath))), '..', 'ccv2-authority');
    }
    if (isPlainObject(input) && typeof input.installRoot === 'string' && input.installRoot !== '') {
      return path.join(path.resolve(String(input.installRoot)), 'data', 'ccv2-authority');
    }
    return null;
  } catch (error) {
    void error;
    return null;
  }
}
function readTextFileV2(filePath, maxBytes) {
  try {
    if (typeof filePath !== 'string' || filePath === '') return null;
    const text = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return null;
    return text;
  } catch (error) {
    void error;
    return null;
  }
}
function currentOpencodeIdentityV2(input) {
  try {
    const installRoot = isPlainObject(input) && typeof input.installRoot === 'string' ? input.installRoot : null;
    if (installRoot === null) return { known: false, identity: null };
    const settingsText = readTextFileV2(path.join(path.resolve(String(installRoot)), 'config', 'settings.yaml'), 1048576);
    const registryText = readTextFileV2(path.join(path.resolve(String(installRoot)), 'config', 'model-registry.json'), 1048576);
    if (settingsText === null || registryText === null) return { known: false, identity: null };
    let registryDocument = null;
    try {
      registryDocument = JSON.parse(registryText);
    } catch (error) {
      void error;
      return { known: false, identity: null };
    }
    return certV2.currentIdentityV2({
      settingsText,
      registryDocument,
      inferenceProvider: opencodeV2.OPENCODE_PROVIDER_V1,
      inferenceModel: opencodeV2.OPENCODE_MODEL_V1,
      counterProvider: 'meta-model-api',
      counterModel: 'muse-spark-1.3-contributor',
      counterFingerprint: remoteV2.REMOTE_FINGERPRINT_V1,
      safetyMarginPolicyRevision: MARGIN_POLICY_REVISION_V1,
      outputReservePolicyRevision: OUTPUT_RESERVE_POLICY_REVISION_V1,
      requestShapeRevision: OPENCODE_REQUEST_SHAPE_V1,
      canarySuiteRevision: CANARY_SUITE_REVISION_V1,
    });
  } catch (error) {
    void error;
    return { known: false, identity: null };
  }
}
function liveUserTextMessages(messages) {
  const found = [];
  messages.forEach((message, index) => {
    if (!isPlainObject(message) || message.role !== 'user' || !Array.isArray(message.content)) return;
    const texts = [];
    for (const block of message.content) {
      if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    if (texts.length > 0) found.push({ index, text: texts.join(String.fromCharCode(10)) });
  });
  return found;
}
function legacyHostResult(request, reason) {
  return Object.freeze({
    mode: 'LEGACY',
    request,
    fallbackReason: reason,
    performed: false,
    decision: null,
    telemetry: Object.freeze({ projectionMode: 'LEGACY', fallbackReason: reason, authority: 'REMOTE_MUSE_PRECOUNT' }),
  });
}
function applyOpencodeProjectionV2(input) {
  try {
    if (!isPlainObject(input)) return legacyHostResult(null, 'active-compiler-failed');
    const request = isPlainObject(input.request) ? input.request : null;
    if (request === null) return legacyHostResult(input.request, 'active-compiler-failed');
    const policy = isPlainObject(input.policy) ? input.policy : null;
    if (policy === null || policy.mode !== 'active' || policy.valid !== true) {
      return legacyHostResult(request, null);
    }
    if (request.provider !== opencodeV2.OPENCODE_PROVIDER_V1 || request.model !== opencodeV2.OPENCODE_MODEL_V1) {
      return legacyHostResult(request, null);
    }
    if (typeof request.sessionId !== 'string' || request.sessionId === '') {
      return legacyHostResult(request, 'active-request-binding-changed');
    }
    if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
      return legacyHostResult(request, 'active-budget-unrepresentable');
    }
    if (!Array.isArray(request.messages)) return legacyHostResult(request, 'active-request-binding-changed');
    if (opencodeV2.opencodeHealthV2({ provider: opencodeV2.OPENCODE_PROVIDER_V1, model: opencodeV2.OPENCODE_MODEL_V1 }) !== opencodeV2.HEALTH_HEALTHY) {
      return legacyHostResult(request, 'active-tokenizer-unavailable');
    }
    const hasMockCounter = isPlainObject(input.metaRemoteCounter)
      && typeof input.metaRemoteCounter.countTextsV2 === 'function'
      && typeof input.metaRemoteCounter.countPayloadV2 === 'function'
      && typeof input.metaRemoteCounter.buildMemoCounterV2 === 'function'
      && input.metaRemoteCounter.fingerprint === remoteV2.REMOTE_FINGERPRINT_V1;
    const metaKey = input.metaApiKey !== undefined && input.metaApiKey !== null
      ? input.metaApiKey
      : (typeof process !== 'undefined' && process.env ? process.env[MODEL_API_KEY_ENV] : undefined);
    if (hasMockCounter !== true && (typeof metaKey !== 'string' || metaKey === '')) {
      return legacyHostResult(request, 'active-tokenizer-unavailable');
    }
    const bindingsPath = typeof input.bindingsPath === 'string' ? input.bindingsPath : null;
    if (bindingsPath === null) return legacyHostResult(request, 'active-request-binding-changed');
    const binding = shadowHostV2.readSessionBindingV2({ bindingsPath, sessionId: request.sessionId });
    if (binding === null) return legacyHostResult(request, 'active-request-binding-changed');
    const bindingTriple = tripleOf({
      taskId: binding.taskId,
      taskInstanceId: typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : null,
      sessionId: typeof binding.sessionId === 'string' && binding.sessionId !== '' ? binding.sessionId : request.sessionId,
    });
    if (bindingTriple === null || bindingTriple.taskInstanceId === null) {
      return legacyHostResult(request, 'active-request-binding-changed');
    }
    const memoryDir = shadowHostV2.shadowMemoryDirForV2(binding.workspace, bindingTriple.taskId);
    if (memoryDir === null) return legacyHostResult(request, 'active-request-binding-changed');
    const checkpointFound = shadowHostV2.readSealedCheckpointForTaskV2(memoryDir);
    if (checkpointFound.sealed === null) return legacyHostResult(request, 'active-compiler-failed');
    const sealed = checkpointFound.sealed;
    const stagedPages = shadowHostV2.readStagedPagesV2(memoryDir, bindingTriple);
    if (stagedPages.pages === null) return legacyHostResult(request, 'active-compiler-failed');
    const stagedDecisions = shadowHostV2.readStagedDecisionsV2(memoryDir, bindingTriple);
    if (stagedDecisions.decisions === null) return legacyHostResult(request, 'active-compiler-failed');
    const stagedTx = shadowHostV2.readStagedToolTransactionsV2(memoryDir);
    if (stagedTx.transactions === null) return legacyHostResult(request, 'active-compiler-failed');
    const liveTurn = shadowHostV2.extractLiveCurrentTurnV2(request.messages);
    if (liveTurn.turn === null) return legacyHostResult(request, 'active-current-turn-invalid');
    const liveUserTexts = liveUserTextMessages(request.messages);
    if (liveUserTexts.length !== 1) return legacyHostResult(request, 'active-current-turn-invalid');
    const liveTurnHash = sha256HexUtf8(liveTurn.turn.text);
    if (sha256HexUtf8(liveUserTexts[0].text) !== liveTurnHash) {
      return legacyHostResult(request, 'active-current-turn-invalid');
    }
    let descriptor = null;
    try {
      const found = remoteV2.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
      descriptor = found;
    } catch (error) {
      void error;
      descriptor = null;
    }
    if (descriptor === null) return legacyHostResult(request, 'active-tokenizer-unavailable');
    let metaRemoteCounter = null;
    try {
      if (isPlainObject(input.metaRemoteCounter)
        && typeof input.metaRemoteCounter.countTextsV2 === 'function'
        && typeof input.metaRemoteCounter.countPayloadV2 === 'function'
        && typeof input.metaRemoteCounter.buildMemoCounterV2 === 'function'
        && input.metaRemoteCounter.fingerprint === remoteV2.REMOTE_FINGERPRINT_V1) {
        metaRemoteCounter = input.metaRemoteCounter;
      } else {
        metaRemoteCounter = remoteV2.createMuseRemoteCounterV2({ descriptor, apiKey: metaKey, timeoutMs: input.countTimeoutMs });
      }
    } catch (error) {
      void error;
      return legacyHostResult(request, 'active-tokenizer-unavailable');
    }
    const compileInput = {
      checkpoint: sealed,
      currentTurn: { turnId: 'live', text: liveTurn.turn.text, revision: null },
      namespace: {
        taskId: sealed.taskId,
        taskInstanceId: sealed.taskInstanceId,
        sessionId: sealed.sessionId,
        workspaceId: sealed.workspaceId,
        repositoryId: sealed.repositoryId,
        checkoutId: sealed.checkoutId,
      },
      snapshotRevision: sealed.snapshot.revisionDigest,
      runtimeState: { pendingProtocol: shadowHostV2.derivePendingProtocolV2(request.messages) },
      pages: stagedPages.pages,
      tierDecisions: stagedDecisions.decisions,
      evidenceRefs: [],
      exactMaterial: [],
      toolTransactions: stagedTx.transactions,
      budget: { hardMax: 60000, target: 50000 },
      compilerPolicyRevision: compilerV2.COMPILER_POLICY_REVISION_V2,
    };
    const outputReserve = request.maxTokens;
    if (outputReserve > 131072) return legacyHostResult(request, 'active-budget-unrepresentable');
    const attemptBinding = {
      taskId: bindingTriple.taskId,
      taskInstanceId: bindingTriple.taskInstanceId,
      sessionId: bindingTriple.sessionId,
      checkpointGeneration: sealed.generation,
      checkpointId: sealed.checkpointId,
      snapshotRevision: sealed.snapshot.revisionDigest,
      turnId: 'live',
      turnTextHash: liveTurnHash,
      turnRevision: null,
      provider: opencodeV2.OPENCODE_PROVIDER_V1,
      model: opencodeV2.OPENCODE_MODEL_V1,
      maxTokens: request.maxTokens,
      outputReserveTokens: outputReserve,
      tokenizerFingerprint: remoteV2.REMOTE_FINGERPRINT_V1,
      capabilityRevision: remoteV2.REMOTE_REVISION_V1,
    };
    return Object.freeze({
      pending: true, request, policy, compileInput,
      pages: stagedPages.pages, outputReserve, attemptBinding,
      liveTurnHash, liveTurn, memoryDir, metaRemoteCounter,
    });
  } catch (error) {
    void error;
    try {
      return legacyHostResult(isPlainObject(input) ? input.request : null, 'active-compiler-failed');
    } catch (ignored) {
      void ignored;
      return legacyHostResult(null, 'active-compiler-failed');
    }
  }
}
async function completeOpencodeProjectionV2(staged, input) {
  const request = staged.request;
  try {
    const decision = await opencodeV2.attemptOpencodeActiveV2({
      compileInput: staged.compileInput,
      pages: staged.pages,
      metaRemoteCounter: staged.metaRemoteCounter,
      requestTerms: {
        systemText: typeof request.system === 'string' ? request.system : '',
        turnText: staged.liveTurn.turn.text,
        maxTokens: request.maxTokens,
        outputReserve: staged.outputReserve,
        reasoningEffort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : null,
      },
      binding: {
        taskId: staged.attemptBinding.taskId,
        taskInstanceId: staged.attemptBinding.taskInstanceId,
        sessionId: staged.attemptBinding.sessionId,
        checkpointGeneration: staged.attemptBinding.checkpointGeneration,
        checkpointId: staged.attemptBinding.checkpointId,
        snapshotRevision: staged.attemptBinding.snapshotRevision,
        turnId: 'live',
        turnTextHash: staged.liveTurnHash,
        turnRevision: null,
        provider: opencodeV2.OPENCODE_PROVIDER_V1,
        model: opencodeV2.OPENCODE_MODEL_V1,
        maxTokens: request.maxTokens,
        outputReserveTokens: staged.outputReserve,
        tokenizerFingerprint: remoteV2.REMOTE_FINGERPRINT_V1,
        capabilityRevision: remoteV2.REMOTE_REVISION_V1,
      },
      getCurrentRevision: () => shadowHostV2.readSealedRevisionForTaskV2(staged.memoryDir),
      telemetrySink: isPlainObject(input) && typeof input.telemetrySink === 'function' ? input.telemetrySink : null,
    });
    if (decision.eligible !== true) return legacyHostResult(request, decision.fallbackReason);
    const compiledUserText = decision.render.messagePlan
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    if (sha256HexUtf8(compiledUserText) !== staged.liveTurnHash) {
      return legacyHostResult(request, 'active-current-turn-invalid');
    }
    const compiledMessages = decision.render.messagePlan.map((message, ordinal) => Object.freeze({
      id: 'ccv2-c' + ordinal,
      role: message.role,
      content: Object.freeze([{ type: 'text', text: message.text }]),
      source: Object.freeze({ kind: 'ccv2-compiled', viewId: decision.view.id }),
    }));
    const cloned = deepClone(request);
    cloned.messages = compiledMessages.map((message) => JSON.parse(JSON.stringify(message)));
    cloned.metadata = Object.assign(
      {},
      isPlainObject(request.metadata) ? JSON.parse(JSON.stringify(request.metadata)) : {},
      {
        projectionMode: 'CCV2_COMPILED',
        ccv2ViewId: decision.view.id,
        ccv2RenderDigest: decision.render.renderDigest,
        ccv2Authority: 'REMOTE_MUSE_PRECOUNT',
        ccv2PreCount: decision.preCount,
        ccv2Margin: decision.providerSafetyMargin,
      },
    );
    const sourceEnvelope = canonicalJsonOf({
      provider: request.provider, model: request.model,
      reasoningEffort: request.reasoningEffort === undefined ? null : request.reasoningEffort,
      maxTokens: request.maxTokens, system: request.system === undefined ? null : request.system,
      tools: request.tools === undefined ? null : request.tools,
      routingAuthority: request.routingAuthority === undefined ? null : request.routingAuthority,
      sessionId: request.sessionId,
    });
    const derivedEnvelope = canonicalJsonOf({
      provider: cloned.provider, model: cloned.model,
      reasoningEffort: cloned.reasoningEffort === undefined ? null : cloned.reasoningEffort,
      maxTokens: cloned.maxTokens, system: cloned.system === undefined ? null : cloned.system,
      tools: cloned.tools === undefined ? null : cloned.tools,
      routingAuthority: cloned.routingAuthority === undefined ? null : cloned.routingAuthority,
      sessionId: cloned.sessionId,
    });
    if (sourceEnvelope !== derivedEnvelope) return legacyHostResult(request, 'active-request-binding-changed');
    const telemetry = Object.freeze(Object.assign({}, decision.telemetry));
    return Object.freeze({
      mode: 'CCV2_COMPILED',
      request: Object.freeze(cloned),
      fallbackReason: null,
      performed: true,
      decision,
      telemetry,
    });
  } catch (error) {
    void error;
    return legacyHostResult(request, 'active-compiler-failed');
  }
}
function createOpencodeRequestListenerV2(deps) {
  const seen = new WeakSet();
  const safeDeps = isPlainObject(deps) ? deps : {};
  return async function opencodeActiveRequestListener(payload, next) {
    let resolved = null;
    try {
      resolved = await next();
    } catch (error) {
      throw error;
    }
    try {
      if (!isPlainObject(payload) || !isPlainObject(resolved)) return resolved;
      if (typeof resolved.purpose === 'string' && AUXILIARY_PURPOSES.indexOf(resolved.purpose) !== -1) return resolved;
      if (typeof resolved.sessionId !== 'string' || resolved.sessionId === '') return resolved;
      const policy = activeV2.resolveCompilerModeV2({ config: readPolicyConfigV2(safeDeps.installRoot) });
      if (policy.mode !== 'active' || policy.valid !== true) return resolved;
      if (seen.has(resolved)) return resolved;
      seen.add(resolved);
      const staged = applyOpencodeProjectionV2({
        request: resolved,
        policy: { mode: 'active', valid: true },
        bindingsPath: safeDeps.bindingsPath,
        metaApiKey: safeDeps.metaApiKey,
        metaRemoteCounter: safeDeps.metaRemoteCounter === undefined ? null : safeDeps.metaRemoteCounter,
        countTimeoutMs: safeDeps.countTimeoutMs,
      });
      if (staged.pending !== true) return staged.request;
      const outcome = await completeOpencodeProjectionV2(staged, {
        telemetrySink: defaultOpencodeTelemetrySinkV2(safeDeps.log),
      });
      if (outcome.mode === 'CCV2_COMPILED') return outcome.request;
      return resolved;
    } catch (error) {
      void error;
      return resolved;
    }
  };
}
function readPolicyConfigV2(installRoot) {
  try {
    if (typeof installRoot !== 'string' || installRoot === '') return {};
    const text = fs.readFileSync(path.join(path.resolve(String(installRoot)), 'config', 'routing-policy.json'), 'utf8');
    const document = JSON.parse(text);
    if (!isPlainObject(document)) return {};
    return document;
  } catch (error) {
    void error;
    return {};
  }
}
function defaultOpencodeTelemetrySinkV2(log) {
  if (typeof log !== 'function') return null;
  return (telemetry) => {
    try {
      log(Object.assign({ event: 'ccv2-opencode-active-decided' }, telemetry));
    } catch (error) {
      void error;
    }
  };
}
function readUsageFromChunkV2(chunk) {
  try {
    if (chunk === null || chunk === undefined) return null;
    const candidates = [chunk];
    if (isPlainObject(chunk)) {
      if (chunk.data !== undefined) candidates.push(chunk.data);
      if (isPlainObject(chunk.data) && chunk.data.chunk !== undefined) candidates.push(chunk.data.chunk);
    }
    for (const candidate of candidates) {
      if (!isPlainObject(candidate)) continue;
      const usage = candidate.usage;
      if (!isPlainObject(usage)) continue;
      const inputTokens = usage.input_tokens !== undefined ? usage.input_tokens : usage.prompt_tokens;
      if (Number.isInteger(inputTokens) && inputTokens >= 0) return { inputTokens };
    }
    return null;
  } catch (error) {
    void error;
    return null;
  }
}
async function* forwardStreamV2(source, onUsage, log) {
  try {
    for await (const chunk of source) {
      try {
        if (typeof onUsage === 'function') onUsage(chunk);
      } catch (error) {
        void error;
      }
      yield chunk;
    }
  } catch (error) {
    throw error;
  }
}
function createOpencodeStreamListenerV2(deps) {
  const seen = new WeakSet();
  const safeDeps = isPlainObject(deps) ? deps : {};
  const storeRoot = resolveOpencodeStoreRootV2(safeDeps);
  return function opencodeStreamListener(request, next) {
    let stream = null;
    try {
      stream = next();
    } catch (error) {
      throw error;
    }
    try {
      if (!isPlainObject(request)) return stream;
      if (request.provider !== opencodeV2.OPENCODE_PROVIDER_V1 || request.model !== opencodeV2.OPENCODE_MODEL_V1) return stream;
      const metadata = isPlainObject(request.metadata) ? request.metadata : null;
      if (metadata === null || metadata.projectionMode !== 'CCV2_COMPILED') return stream;
      if (metadata.ccv2Authority !== undefined && metadata.ccv2Authority !== null
        && metadata.ccv2Authority !== 'REMOTE_MUSE_PRECOUNT') return stream;
      if (!Number.isInteger(metadata.ccv2PreCount) || !Number.isInteger(metadata.ccv2Margin)) return stream;
      if (seen.has(request)) return stream;
      seen.add(request);
      const limit = metadata.ccv2PreCount + metadata.ccv2Margin;
      const log = typeof safeDeps.log === 'function' ? safeDeps.log : null;
      const revoke = () => {
        try {
          certV2.revokeCertificationV2(storeRoot, 'input-over-margin');
          quarantineOpencodeLocalV2();
          if (log !== null) {
            log({ event: 'ccv2-opencode-anomaly-revoked', preCount: metadata.ccv2PreCount, margin: metadata.ccv2Margin });
          }
        } catch (error) {
          void error;
        }
      };
      const onUsage = (chunk) => {
        const found = readUsageFromChunkV2(chunk);
        if (found !== null && found.inputTokens > limit) revoke();
      };
      if (stream !== null && stream !== undefined && typeof stream[Symbol.asyncIterator] === 'function') {
        return forwardStreamV2(stream, onUsage, log);
      }
      if (stream !== null && stream !== undefined && typeof stream.then === 'function') {
        return stream.then((resolved) => {
          if (resolved !== null && resolved !== undefined && typeof resolved[Symbol.asyncIterator] === 'function') {
            return forwardStreamV2(resolved, onUsage, log);
          }
          return resolved;
        });
      }
      return stream;
    } catch (error) {
      void error;
      return stream;
    }
  };
}
function quarantineOpencodeLocalV2() {
  try {
    opencodeV2.quarantineOpencodeV2(
      { provider: opencodeV2.OPENCODE_PROVIDER_V1, model: opencodeV2.OPENCODE_MODEL_V1 },
      'input-over-margin',
    );
  } catch (error) {
    void error;
  }
}
function installOpencodeActiveProjection(ctx, deps) {
  try {
    if (!ctx || typeof ctx.on !== 'function') return { installed: false, reason: 'no-hook-surface' };
    if (installedCtxs.has(ctx)) return { installed: true, reason: 'already-installed' };
    const safeDeps = isPlainObject(deps) ? deps : {};
    if (typeof safeDeps.installRoot !== 'string' || safeDeps.installRoot === '') {
      return { installed: false, reason: 'no-install-root' };
    }
    if (typeof safeDeps.bindingsPath !== 'string' || safeDeps.bindingsPath === '') {
      return { installed: false, reason: 'no-bindings-path' };
    }
    if (typeof safeDeps.log !== 'function') return { installed: false, reason: 'no-log-channel' };
    const started = startupOpencodeAuthorityV2(safeDeps);
    void started;
    ctx.on('agent/request', createOpencodeRequestListenerV2(safeDeps));
    ctx.on('llm/stream', createOpencodeStreamListenerV2(safeDeps), { global: true });
    installedCtxs.add(ctx);
    return { installed: true, reason: null };
  } catch (error) {
    void error;
    return { installed: false, reason: 'install-failed' };
  }
}
module.exports = {
  HOST_SCHEMA_VERSION,
  OPENCODE_REQUEST_SHAPE_V1,
  MARGIN_POLICY_REVISION_V1,
  OUTPUT_RESERVE_POLICY_REVISION_V1,
  CANARY_SUITE_REVISION_V1,
  MODEL_API_KEY_ENV,
  resolveOpencodeStoreRootV2,
  currentOpencodeIdentityV2,
  startupOpencodeAuthorityV2,
  applyOpencodeProjectionV2,
  completeOpencodeProjectionV2,
  createOpencodeRequestListenerV2,
  readUsageFromChunkV2,
  createOpencodeStreamListenerV2,
  installOpencodeActiveProjection,
};
function startupOpencodeAuthorityV2(input) {
  const idle = (state) => Object.freeze({ state, health: 'QUARANTINED', certification: null });
  try {
    const storeRoot = resolveOpencodeStoreRootV2(input);
    if (storeRoot === null) return idle('missing');
    const hasExplicit = isPlainObject(input) && isPlainObject(input.expectedIdentity);
    let expected = hasExplicit === true ? input.expectedIdentity : null;
    if (hasExplicit !== true) {
      const built = currentOpencodeIdentityV2(input);
      if (built.known !== true || built.identity === null) return idle('identity-mismatch');
      expected = built.identity;
    }
    const loaded = certV2.loadCertificationV2({
      storeRoot,
      expectedIdentity: expected,
      clock: isPlainObject(input) ? input.clock : null,
    });
    if (loaded.state !== 'valid') return idle(loaded.state);
    try {
      opencodeV2.markOpencodeHealthyV2(
        { provider: opencodeV2.OPENCODE_PROVIDER_V1, model: opencodeV2.OPENCODE_MODEL_V1 },
        { canaryDigest: loaded.certification.canaryEvidenceDigest },
      );
    } catch (error) {
      void error;
      return idle('malformed');
    }
    return Object.freeze({ state: 'valid', health: 'HEALTHY', certification: loaded.certification });
  } catch (error) {
    void error;
    return idle('malformed');
  }
}
