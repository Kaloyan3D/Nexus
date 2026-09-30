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
const museV2 = require('./ContextCompilerActiveMuseV2.cjs');
const certV2 = require('./ContextAuthorityCertificationV2.cjs');
const HOST_SCHEMA_VERSION = 1;
const OPENCODE_REQUEST_SHAPE_V1 = 'opencode-muse-request-shape-v1';
const MARGIN_POLICY_REVISION_V1 = 'opencode-margin-policy-v1';
const OUTPUT_RESERVE_POLICY_REVISION_V1 = 'opencode-output-reserve-policy-v1';
const CANARY_SUITE_REVISION_V1 = 'oc01-canary-suite-v1';
const MODEL_API_KEY_ENV = 'MODEL_API_KEY';
const AUXILIARY_PURPOSES = Object.freeze(['compaction', 'session-title']);
const DECISION_TELEMETRY_EVENT = 'ccv2-opencode-active-decided';
const USAGE_TELEMETRY_EVENT = 'ccv2-opencode-usage-observed';
const PREWARM_TELEMETRY_EVENT = 'ccv2-opencode-counter-prewarm';
// Pre-warm waits briefly after a response so the memory producer can stage
// the step that just finished.
const PREWARM_DELAY_MS = 750;
// Closed-world fallback stages: WHERE a diagnosable active-mode request fell
// back (the reason says WHY). Never carries content.
const FALLBACK_STAGES = Object.freeze([
  'request-shape', 'authority-health', 'counter-credential', 'binding', 'checkpoint',
  'staged-memory', 'current-turn', 'coverage', 'exact-material', 'counter', 'budget',
  'attempt', 'compiled-turn', 'envelope', 'dispatch-surface', 'ownership', 'exception',
]);
const installedCtxs = new WeakSet();
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Process-global diagnostics registry, shared by EVERY copy of this module
// (each agent preset ships its own controller closure, so one process can
// load several). A request object gets one monotonic sequence number no
// matter which copy sees it first, so two decision lines carrying the same
// requestSeq provably concern the same request object. Ids only; never
// content or content hashes.
//
// The same registry carries the process-wide projection guards, because one
// provider request passes EVERY installed copy's global llm/stream listener:
//   derived  - CCV2_COMPILED requests re-dispatched by any copy (never
//              projected again, by any copy);
//   claimed  - request objects an owning listener already decided (exactly
//              one authoritative decision per request object);
//   owners   - sessionId -> installation id of the composition whose scoped
//              session/event stream carries that session (the one the agent
//              joined); only that installation may project it;
//   unowned  - request objects already reported as having no owner.
const DIAGNOSTICS_KEY = Symbol.for('nexus.ccv2.opencode-active.diagnostics.v1');
function processDiagnosticsV2() {
  const existing = globalThis[DIAGNOSTICS_KEY];
  if (isPlainObject(existing) && existing.version === 1) return existing;
  const created = {
    version: 1, requestIds: new WeakMap(), nextRequestSeq: 1, nextModuleInstanceId: 1, nextListenerId: 1,
    nextInstallationId: 1, derived: new WeakSet(), claimed: new WeakSet(), owners: new Map(), unowned: new WeakSet(),
  };
  Object.defineProperty(globalThis, DIAGNOSTICS_KEY, { value: created, enumerable: false, configurable: false, writable: false });
  return created;
}
const MODULE_INSTANCE_ID = processDiagnosticsV2().nextModuleInstanceId++;
// The directory this copy was loaded from ('config' in the repo, the preset
// id in an installed preset closure). Structural path segment only.
const MODULE_ORIGIN = (() => {
  const name = path.basename(path.dirname(__filename));
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : 'unknown';
})();
function requestSeqOfV2(request) {
  try {
    if (request === null || typeof request !== 'object') return null;
    const registry = processDiagnosticsV2();
    let seq = registry.requestIds.get(request);
    if (seq === undefined) {
      seq = registry.nextRequestSeq;
      registry.nextRequestSeq += 1;
      registry.requestIds.set(request, seq);
    }
    return seq;
  } catch (error) {
    void error;
    return null;
  }
}
function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
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
function currentOpencodeHealthV2() {
  try {
    return opencodeV2.opencodeHealthV2({ provider: opencodeV2.OPENCODE_PROVIDER_V1, model: opencodeV2.OPENCODE_MODEL_V1 });
  } catch (error) {
    void error;
    return opencodeV2.HEALTH_QUARANTINED;
  }
}
function legacyHostResult(request, reason, stage, diag) {
  const fallbackStage = reason === null ? null : (FALLBACK_STAGES.indexOf(stage) !== -1 ? stage : 'exception');
  const found = isPlainObject(diag) ? diag : {};
  return Object.freeze({
    mode: 'LEGACY',
    request,
    fallbackReason: reason,
    fallbackStage,
    performed: false,
    decision: null,
    telemetry: Object.freeze(Object.assign({
      projectionMode: 'LEGACY',
      fallbackReason: reason,
      fallbackStage,
      authority: 'REMOTE_MUSE_PRECOUNT',
      authorityHealth: currentOpencodeHealthV2(),
      compilerExecutions: Number.isInteger(found.compilerExecutions) ? found.compilerExecutions : 0,
      bindingFound: found.bindingFound === true,
      checkpointFound: found.checkpointFound === true,
      sessionSourceAvailable: typeof found.sessionSourceAvailable === 'boolean' ? found.sessionSourceAvailable : null,
      exactMaterialSkipped: typeof found.exactMaterialSkipped === 'string' ? found.exactMaterialSkipped : null,
      attemptFailureStage: typeof found.attemptFailureStage === 'string' ? found.attemptFailureStage : null,
      attemptErrorClass: isPlainObject(found.attemptErrorClass) ? found.attemptErrorClass : null,
    }, museV2.pickCounterTelemetryV2(found.counterTelemetry))),
  });
}
function applyOpencodeProjectionV2(input) {
  const diag = { bindingFound: false, checkpointFound: false };
  const fallback = (request, reason, stage) => legacyHostResult(request, reason, stage, diag);
  try {
    if (!isPlainObject(input)) return fallback(null, 'active-compiler-failed', 'request-shape');
    const request = isPlainObject(input.request) ? input.request : null;
    if (request === null) return fallback(input.request, 'active-compiler-failed', 'request-shape');
    const policy = isPlainObject(input.policy) ? input.policy : null;
    if (policy === null || policy.mode !== 'active' || policy.valid !== true) {
      return legacyHostResult(request, null);
    }
    if (request.provider !== opencodeV2.OPENCODE_PROVIDER_V1 || request.model !== opencodeV2.OPENCODE_MODEL_V1) {
      return legacyHostResult(request, null);
    }
    if (typeof request.sessionId !== 'string' || request.sessionId === '') {
      return fallback(request, 'active-request-binding-changed', 'request-shape');
    }
    if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
      return fallback(request, 'active-budget-unrepresentable', 'request-shape');
    }
    if (!Array.isArray(request.messages)) return fallback(request, 'active-request-binding-changed', 'request-shape');
    if (currentOpencodeHealthV2() !== opencodeV2.HEALTH_HEALTHY) {
      return fallback(request, 'active-tokenizer-unavailable', 'authority-health');
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
      return fallback(request, 'active-tokenizer-unavailable', 'counter-credential');
    }
    const bindingsPath = typeof input.bindingsPath === 'string' ? input.bindingsPath : null;
    if (bindingsPath === null) return fallback(request, 'active-request-binding-changed', 'binding');
    const binding = shadowHostV2.readSessionBindingV2({ bindingsPath, sessionId: request.sessionId });
    if (binding === null) return fallback(request, 'active-request-binding-changed', 'binding');
    diag.bindingFound = true;
    const bindingTriple = tripleOf({
      taskId: binding.taskId,
      taskInstanceId: typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : null,
      sessionId: typeof binding.sessionId === 'string' && binding.sessionId !== '' ? binding.sessionId : request.sessionId,
    });
    if (bindingTriple === null || bindingTriple.taskInstanceId === null) {
      return fallback(request, 'active-request-binding-changed', 'binding');
    }
    const memoryDir = shadowHostV2.shadowMemoryDirForV2(binding.workspace, bindingTriple.taskId);
    if (memoryDir === null) return fallback(request, 'active-request-binding-changed', 'binding');
    const checkpointFound = shadowHostV2.readSealedCheckpointForTaskV2(memoryDir);
    if (checkpointFound.sealed === null) return fallback(request, 'active-compiler-failed', 'checkpoint');
    diag.checkpointFound = true;
    const sealed = checkpointFound.sealed;
    const stagedPages = shadowHostV2.readStagedPagesV2(memoryDir, bindingTriple);
    if (stagedPages.pages === null) return fallback(request, 'active-compiler-failed', 'staged-memory');
    const stagedDecisions = shadowHostV2.readStagedDecisionsV2(memoryDir, bindingTriple);
    if (stagedDecisions.decisions === null) return fallback(request, 'active-compiler-failed', 'staged-memory');
    const stagedTx = shadowHostV2.readStagedToolTransactionsV2(memoryDir);
    if (stagedTx.transactions === null) return fallback(request, 'active-compiler-failed', 'staged-memory');
    const liveTurn = shadowHostV2.extractLiveCurrentTurnV2(request.messages);
    if (liveTurn.turn === null) return fallback(request, 'active-current-turn-invalid', 'current-turn');
    const liveTurnHash = sha256HexUtf8(liveTurn.turn.text);
    // CCV2-M01: with producer coverage, the lossless-replacement rule is the
    // stronger per-message proof (every non-current live message is
    // represented by staged memory); without it, the frozen single
    // user-text rule applies unchanged.
    const stagedCoverage = shadowHostV2.readStagedCoverageV2(memoryDir);
    if (stagedCoverage.skipped !== null) return fallback(request, 'active-current-turn-invalid', 'coverage');
    if (stagedCoverage.coverage !== null) {
      if (shadowHostV2.checkLiveCoverageV2(request.messages, stagedCoverage.coverage, liveTurn.turn.text) !== null) {
        return fallback(request, 'active-current-turn-invalid', 'coverage');
      }
    } else {
      const liveUserTexts = liveUserTextMessages(request.messages);
      if (liveUserTexts.length !== 1) return fallback(request, 'active-current-turn-invalid', 'current-turn');
      if (sha256HexUtf8(liveUserTexts[0].text) !== liveTurnHash) {
        return fallback(request, 'active-current-turn-invalid', 'current-turn');
      }
    }
    const sessionSource = typeof input.sessionSourceFor === 'function' ? input.sessionSourceFor(request.sessionId) : null;
    diag.sessionSourceAvailable = sessionSource !== null && sessionSource !== undefined;
    const exact = shadowHostV2.readStagedExactMaterialV2({
      workspace: binding.workspace, sealed, pages: stagedPages.pages, decisions: stagedDecisions.decisions,
      sessionSource,
    });
    if (exact.material === null) {
      diag.exactMaterialSkipped = typeof exact.skipped === 'string' ? exact.skipped : 'unknown';
      return fallback(request, 'active-compiler-failed', 'exact-material');
    }
    let descriptor = null;
    try {
      const found = remoteV2.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
      descriptor = found;
    } catch (error) {
      void error;
      descriptor = null;
    }
    if (descriptor === null) return fallback(request, 'active-tokenizer-unavailable', 'counter');
    let metaRemoteCounter = null;
    try {
      if (isPlainObject(input.metaRemoteCounter)
        && typeof input.metaRemoteCounter.countTextsV2 === 'function'
        && typeof input.metaRemoteCounter.countPayloadV2 === 'function'
        && typeof input.metaRemoteCounter.buildMemoCounterV2 === 'function'
        && input.metaRemoteCounter.fingerprint === remoteV2.REMOTE_FINGERPRINT_V1) {
        metaRemoteCounter = input.metaRemoteCounter;
      } else {
        metaRemoteCounter = remoteV2.createMuseRemoteCounterV2({
          descriptor, apiKey: metaKey, timeoutMs: input.countTimeoutMs, deadlineMs: input.countDeadlineMs,
        });
      }
    } catch (error) {
      void error;
      return fallback(request, 'active-tokenizer-unavailable', 'counter');
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
      exactMaterial: exact.material,
      toolTransactions: stagedTx.transactions,
      budget: { hardMax: 60000, target: 50000 },
      compilerPolicyRevision: compilerV2.COMPILER_POLICY_REVISION_V2,
    };
    const outputReserve = request.maxTokens;
    if (outputReserve > 131072) return fallback(request, 'active-budget-unrepresentable', 'budget');
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
      bindingFound: diag.bindingFound, checkpointFound: diag.checkpointFound,
      sessionSourceAvailable: diag.sessionSourceAvailable,
    });
  } catch (error) {
    void error;
    try {
      return fallback(isPlainObject(input) ? input.request : null, 'active-compiler-failed', 'exception');
    } catch (ignored) {
      void ignored;
      return fallback(null, 'active-compiler-failed', 'exception');
    }
  }
}
// Keys the compiled projection owns; every other request key (route,
// reasoning effort, output cap, system, tools, routing authority, session
// id, abort signal, ...) is carried by REFERENCE and verified identical.
const PROJECTION_OWNED_KEYS = Object.freeze(['messages', 'metadata']);
function deriveCompiledRequestV2(request, compiledMessages, markers) {
  const derived = {};
  for (const key of Object.keys(request)) derived[key] = request[key];
  derived.messages = Object.freeze(compiledMessages);
  derived.metadata = Object.freeze(Object.assign({}, isPlainObject(request.metadata) ? request.metadata : {}, markers));
  return derived;
}
function envelopeUnchangedV2(request, derived) {
  const sourceKeys = Object.keys(request).filter((key) => PROJECTION_OWNED_KEYS.indexOf(key) === -1).sort();
  const derivedKeys = Object.keys(derived).filter((key) => PROJECTION_OWNED_KEYS.indexOf(key) === -1).sort();
  if (sourceKeys.join(',') !== derivedKeys.join(',')) return false;
  return sourceKeys.every((key) => derived[key] === request[key]);
}
async function completeOpencodeProjectionV2(staged) {
  const request = staged.request;
  const diag = {
    bindingFound: staged.bindingFound === true, checkpointFound: staged.checkpointFound === true,
    sessionSourceAvailable: staged.sessionSourceAvailable, compilerExecutions: 0,
  };
  const fallback = (reason, stage) => legacyHostResult(request, reason, stage, diag);
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
      // The host reports ONE final decision per request (below), so a
      // later host-side rejection can never follow a "compiled" event.
      telemetrySink: null,
    });
    diag.compilerExecutions = decision.compilerExecutions === 1 ? 1 : 0;
    if (decision.eligible !== true) {
      diag.attemptFailureStage = typeof decision.failureStage === 'string' ? decision.failureStage : 'unknown';
      diag.attemptErrorClass = isPlainObject(decision.errorClass) ? decision.errorClass : null;
      diag.counterTelemetry = isPlainObject(decision.counterTelemetry) ? decision.counterTelemetry : null;
      return fallback(decision.fallbackReason, 'attempt');
    }
    const compiledUserText = decision.render.messagePlan
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join(String.fromCharCode(10));
    if (sha256HexUtf8(compiledUserText) !== staged.liveTurnHash) {
      return fallback('active-current-turn-invalid', 'compiled-turn');
    }
    const compiledMessages = decision.render.messagePlan.map((message, ordinal) => Object.freeze({
      id: 'ccv2-c' + ordinal,
      role: message.role,
      content: Object.freeze([Object.freeze({ type: 'text', text: message.text })]),
      source: Object.freeze({ kind: 'ccv2-compiled', viewId: decision.view.id }),
    }));
    const derived = deriveCompiledRequestV2(request, compiledMessages, {
      projectionMode: 'CCV2_COMPILED',
      ccv2ViewId: decision.view.id,
      ccv2RenderDigest: decision.render.renderDigest,
      ccv2Authority: 'REMOTE_MUSE_PRECOUNT',
      ccv2PreCount: decision.preCount,
      ccv2Margin: decision.providerSafetyMargin,
    });
    if (!envelopeUnchangedV2(request, derived)) return fallback('active-request-binding-changed', 'envelope');
    const telemetry = Object.freeze(Object.assign({}, decision.telemetry, {
      projectionMode: 'CCV2_COMPILED',
      fallbackReason: null,
      fallbackStage: null,
      compilerExecutions: 1,
      bindingFound: true,
      checkpointFound: true,
    }));
    return Object.freeze({
      mode: 'CCV2_COMPILED',
      request: Object.freeze(derived),
      fallbackReason: null,
      fallbackStage: null,
      performed: true,
      decision,
      telemetry,
    });
  } catch (error) {
    void error;
    return fallback('active-compiler-failed', 'exception');
  }
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
// One secret-safe decision line per active-mode OpenCode root request:
// ids, digests, counts, typed reason/stage and shape flags only. Never
// prompts, message content, tool payloads, or credentials.
function emitOpencodeDecisionV2(log, outcome, context) {
  if (typeof log !== 'function') return;
  try {
    const request = isPlainObject(context) && isPlainObject(context.request) ? context.request : {};
    log(Object.assign({ event: DECISION_TELEMETRY_EVENT }, outcome.telemetry, {
      requestSeq: requestSeqOfV2(context.request),
      derivedRequestSeq: outcome.mode === 'CCV2_COMPILED' ? requestSeqOfV2(outcome.request) : null,
      listenerId: Number.isInteger(context.listenerId) ? context.listenerId : null,
      moduleInstanceId: MODULE_INSTANCE_ID,
      moduleOrigin: MODULE_ORIGIN,
      seam: 'llm/stream',
      policyMode: context.policy.mode,
      policyOrigin: typeof context.policy.origin === 'string' ? context.policy.origin : null,
      hasSessionId: typeof request.sessionId === 'string' && request.sessionId !== '',
      hasMaxTokens: Number.isInteger(request.maxTokens),
      messagesIsArray: Array.isArray(request.messages),
      messageCount: Array.isArray(request.messages) ? request.messages.length : null,
      compiledMessageCount: outcome.mode === 'CCV2_COMPILED' ? outcome.request.messages.length : null,
    }));
  } catch (error) {
    void error;
  }
}
async function* compiledOrLegacyStreamV2(runtime, staged, next, safeDeps, policy, listenerId) {
  let outcome = null;
  try {
    outcome = await completeOpencodeProjectionV2(staged);
  } catch (error) {
    void error;
    outcome = legacyHostResult(staged.request, 'active-compiler-failed', 'exception', staged);
  }
  emitOpencodeDecisionV2(safeDeps.log, outcome, { request: staged.request, policy, listenerId });
  if (outcome.mode === 'CCV2_COMPILED') {
    // Re-dispatch the derived request through the SAME llm/stream waterfall
    // so every transport guard (Routing-Integrity, invariants, the usage
    // observer) sees exactly what is sent. The original stream is never
    // created, so the adapter is dispatched once.
    processDiagnosticsV2().derived.add(outcome.request);
    yield* runtime.stream(outcome.request);
  } else {
    yield* next();
  }
  // Only a response that completed reaches here (an abandoned or failed
  // stream never pre-warms).
  schedulePrewarmV2(safeDeps, staged);
}
// ---- background exact-count pre-warm (never a correctness input) ----
const prewarmTimers = new Map();
function schedulePrewarmV2(safeDeps, staged) {
  try {
    if (safeDeps.prewarm === false) return;
    const counter = staged.metaRemoteCounter;
    if (!isPlainObject(counter) || typeof counter.prewarmTextsV2 !== 'function') return;
    const sessionId = staged.request.sessionId;
    const previous = prewarmTimers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const delay = Number.isInteger(safeDeps.prewarmDelayMs) && safeDeps.prewarmDelayMs >= 0 ? safeDeps.prewarmDelayMs : PREWARM_DELAY_MS;
    const timer = setTimeout(() => {
      prewarmTimers.delete(sessionId);
      runPrewarmV2(safeDeps, staged).catch((error) => { void error; });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    prewarmTimers.set(sessionId, timer);
  } catch (error) {
    void error;
  }
}
async function runPrewarmV2(safeDeps, staged) {
  let summary = null;
  let restaged = false;
  try {
    // Re-stage from the CURRENT durable memory (read-only): the producer
    // has usually appended the finished step by now. If the old request no
    // longer stages (e.g. a new user turn), the original staging is used.
    let source = staged;
    try {
      const fresh = applyOpencodeProjectionV2({
        request: staged.request,
        policy: { mode: 'active', valid: true },
        bindingsPath: safeDeps.bindingsPath,
        sessionSourceFor: safeDeps.sessionSourceFor,
        metaApiKey: safeDeps.metaApiKey,
        metaRemoteCounter: staged.metaRemoteCounter,
        countTimeoutMs: safeDeps.countTimeoutMs,
        countDeadlineMs: safeDeps.countDeadlineMs,
      });
      if (fresh.pending === true) {
        source = fresh;
        restaged = true;
      }
    } catch (error) {
      void error;
    }
    const texts = museV2.enumerateMusePrewarmTextsV2({
      compileInput: source.compileInput,
      pages: source.pages,
      requestTerms: {
        systemText: typeof source.request.system === 'string' ? source.request.system : '',
        turnText: source.liveTurn.turn.text,
      },
    });
    summary = texts === null
      ? { attempted: 0, cached: 0, counted: 0, skipped: 'enumeration' }
      : await source.metaRemoteCounter.prewarmTextsV2(texts);
  } catch (error) {
    void error;
    summary = { attempted: 0, cached: 0, counted: 0, skipped: 'failed' };
  }
  if (typeof safeDeps.log === 'function') {
    try {
      safeDeps.log({
        event: PREWARM_TELEMETRY_EVENT,
        requestSeq: requestSeqOfV2(staged.request),
        restaged,
        prewarmAttempted: Number.isInteger(summary.attempted) ? summary.attempted : 0,
        prewarmCacheHits: Number.isInteger(summary.cached) ? summary.cached : 0,
        prewarmHttpRequests: Number.isInteger(summary.counted) ? summary.counted : 0,
        prewarmSkipped: typeof summary.skipped === 'string' ? summary.skipped : null,
      });
    } catch (error) {
      void error;
    }
  }
  return summary;
}
/**
 * CCV2-OC01H active projection at the llm/stream seam. The DSH agent/request
 * waterfall resolves ONLY the route config ({provider, model, maxTokens,
 * reasoningEffort}); messages/system/tools/sessionId are attached after it in
 * the loop's buildRequest, so the projection must run where the complete,
 * frozen, session-bound request exists: llm/stream (global, normal order,
 * inside Routing-Integrity's prepend check). cordis waterfall next() takes no
 * replacement argument, so an eligible request is re-dispatched via the
 * dispatching LlmRuntime (`this`); every fallback returns next() verbatim.
 * OFF/OBSERVE/other routes/auxiliary calls: next() with zero compiler work.
 */
// deps.ownsSession(sessionId) is supplied by installOpencodeActiveProjection;
// a listener created without it (standalone use) owns every session.
function ownsSessionV2(deps, sessionId) {
  if (typeof deps.ownsSession !== 'function') return true;
  try {
    return deps.ownsSession(sessionId) === true;
  } catch (error) {
    void error;
    return false;
  }
}
function createOpencodeProjectionStreamListenerV2(deps) {
  const seen = new WeakSet();
  const safeDeps = isPlainObject(deps) ? deps : {};
  const listenerId = processDiagnosticsV2().nextListenerId++;
  return function opencodeProjectionStreamListener(request, next) {
    let staged = null;
    let policy = null;
    try {
      if (!isPlainObject(request) || processDiagnosticsV2().derived.has(request)) return next();
      if (request.provider !== opencodeV2.OPENCODE_PROVIDER_V1 || request.model !== opencodeV2.OPENCODE_MODEL_V1) return next();
      if (typeof request.purpose === 'string' && AUXILIARY_PURPOSES.indexOf(request.purpose) !== -1) return next();
      policy = activeV2.resolveCompilerModeV2({ config: readPolicyConfigV2(safeDeps.installRoot) });
      if (policy.mode !== 'active' || policy.valid !== true) return next();
      if (seen.has(request)) return next();
      const registry = processDiagnosticsV2();
      if (registry.claimed.has(request)) return next();
      if (!ownsSessionV2(safeDeps, request.sessionId)) {
        // Another composition's session: its own installation decides it.
        if (typeof request.sessionId === 'string' && registry.owners.has(request.sessionId)) return next();
        // No installation owns it: report ONE typed decision, never silence.
        if (registry.unowned.has(request)) return next();
        registry.unowned.add(request);
        emitOpencodeDecisionV2(safeDeps.log, legacyHostResult(request, 'active-request-binding-changed', 'ownership'), { request, policy, listenerId });
        return next();
      }
      seen.add(request);
      registry.claimed.add(request);
      const runtime = this;
      if (runtime === null || runtime === undefined || typeof runtime.stream !== 'function') {
        emitOpencodeDecisionV2(safeDeps.log, legacyHostResult(request, 'active-compiler-failed', 'dispatch-surface'), { request, policy, listenerId });
        return next();
      }
      staged = applyOpencodeProjectionV2({
        request,
        policy: { mode: 'active', valid: true },
        bindingsPath: safeDeps.bindingsPath,
        sessionSourceFor: safeDeps.sessionSourceFor,
        metaApiKey: safeDeps.metaApiKey,
        metaRemoteCounter: safeDeps.metaRemoteCounter === undefined ? null : safeDeps.metaRemoteCounter,
        countTimeoutMs: safeDeps.countTimeoutMs,
        countDeadlineMs: safeDeps.countDeadlineMs,
      });
      if (staged.pending !== true) {
        emitOpencodeDecisionV2(safeDeps.log, staged, { request, policy, listenerId });
        return next();
      }
      return compiledOrLegacyStreamV2(runtime, staged, next, safeDeps, policy, listenerId);
    } catch (error) {
      void error;
      if (policy !== null && policy.mode === 'active' && staged === null) {
        emitOpencodeDecisionV2(safeDeps.log, legacyHostResult(request, 'active-compiler-failed', 'exception'), { request, policy, listenerId });
      }
      return next();
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
      if (!ownsSessionV2(safeDeps, request.sessionId)) return stream;
      const metadata = isPlainObject(request.metadata) ? request.metadata : null;
      if (metadata === null || metadata.projectionMode !== 'CCV2_COMPILED') return stream;
      if (metadata.ccv2Authority !== undefined && metadata.ccv2Authority !== null
        && metadata.ccv2Authority !== 'REMOTE_MUSE_PRECOUNT') return stream;
      if (!Number.isInteger(metadata.ccv2PreCount) || !Number.isInteger(metadata.ccv2Margin)) return stream;
      if (seen.has(request)) return stream;
      seen.add(request);
      const limit = metadata.ccv2PreCount + metadata.ccv2Margin;
      const log = typeof safeDeps.log === 'function' ? safeDeps.log : null;
      let driftHandled = false;
      let usageLogged = false;
      const revoke = (inputTokens) => {
        let cacheEpoch = null;
        if (!driftHandled) {
          driftHandled = true;
          // Unexplained drift: every exact count observed so far stops being
          // reusable authority (the epoch moves on and the cache is flushed).
          try {
            cacheEpoch = remoteV2.invalidateExactCountCacheV2();
          } catch (error) {
            void error;
          }
        }
        try {
          certV2.revokeCertificationV2(storeRoot, 'input-over-margin');
          quarantineOpencodeLocalV2();
          if (log !== null) {
            log({
              event: 'ccv2-opencode-anomaly-revoked', preCount: metadata.ccv2PreCount, margin: metadata.ccv2Margin,
              preCountDrift: inputTokens - metadata.ccv2PreCount, cacheEpoch,
            });
          }
        } catch (error) {
          void error;
        }
      };
      const onUsage = (chunk) => {
        const found = readUsageFromChunkV2(chunk);
        if (found === null) return;
        if (!usageLogged && log !== null) {
          usageLogged = true;
          try {
            log({
              event: USAGE_TELEMETRY_EVENT,
              requestSeq: requestSeqOfV2(request),
              preCount: metadata.ccv2PreCount,
              margin: metadata.ccv2Margin,
              inputTokens: found.inputTokens,
              preCountDrift: found.inputTokens - metadata.ccv2PreCount,
              withinMargin: found.inputTokens <= limit,
            });
          } catch (error) {
            void error;
          }
        }
        if (found.inputTokens > limit) revoke(found.inputTokens);
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
    // Ownership: llm/stream must be observed globally (the dispatching
    // LlmRuntime is host-plane), so every mounted composition's listener sees
    // every request. session/event is scope-routed: this NON-global listener
    // receives only the sessions of agents joined to THIS composition (or
    // every session when the controller sits in the unscoped host plane).
    const registry = processDiagnosticsV2();
    const installationId = registry.nextInstallationId++;
    const owned = new Set();
    ctx.on('session/event', (subject) => {
      try {
        const sessionId = subject && typeof subject.id === 'string' ? subject.id : null;
        if (sessionId === null || owned.has(sessionId)) return;
        owned.add(sessionId);
        if (!registry.owners.has(sessionId)) registry.owners.set(sessionId, installationId);
      } catch (error) {
        void error;
      }
    });
    const ownedDeps = Object.assign({}, safeDeps, { ownsSession: (sessionId) => owned.has(sessionId) });
    ctx.on('llm/stream', createOpencodeProjectionStreamListenerV2(ownedDeps), { global: true });
    ctx.on('llm/stream', createOpencodeStreamListenerV2(ownedDeps), { global: true });
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
  DECISION_TELEMETRY_EVENT,
  USAGE_TELEMETRY_EVENT,
  PREWARM_TELEMETRY_EVENT,
  FALLBACK_STAGES,
  runPrewarmV2,
  createOpencodeProjectionStreamListenerV2,
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
