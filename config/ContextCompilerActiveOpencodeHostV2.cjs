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
const rendererV2 = require('./ContextPromptRendererV2.cjs');
const certV2 = require('./ContextAuthorityCertificationV2.cjs');
const wireV2 = require('./ContextWireProjectorResponsesV2.cjs');
const activationV2 = require('./ContextActivationPressureV2.cjs');
const HOST_SCHEMA_VERSION = 1;
const OPENCODE_REQUEST_SHAPE_V1 = 'opencode-muse-request-shape-v1';
// ACTIVE-TAIL-NATIVE changed the provider request shape (system slot +
// native tail, counted as the pinned wire body). Certification binds this
// revision, so evidence gathered for the v1 text shape never authorizes it.
const OPENCODE_REQUEST_SHAPE_V2 = 'opencode-muse-request-shape-v2-native-tail';
// reasoningReplay=none on this route changes the provider wire again
// (historical reasoning items are never sent or counted), so evidence for
// the replay-enabled v2 shape never authorizes it.
const OPENCODE_REQUEST_SHAPE_V3 = 'opencode-muse-request-shape-v3-native-tail-no-replay';
// Deterministic separator between the DSH-owned system bytes (a strict
// prefix of the derived system) and the compiled CCv2 context.
const CCV2_SYSTEM_SEPARATOR_V1 = String.fromCharCode(10, 10);
const MARGIN_POLICY_REVISION_V1 = 'opencode-margin-policy-v1';
const OUTPUT_RESERVE_POLICY_REVISION_V1 = 'opencode-output-reserve-policy-v1';
const CANARY_SUITE_REVISION_V1 = 'oc01-canary-suite-v1';
// The OC01 suite certifying request shape v3: static count/bill fixtures,
// the native-tail no-replay continuation fixture, and the live native-tail
// phase (real DSH loop + pinned pi-ai adapter at xhigh: ACTIVE-TAIL-NATIVE,
// reasoningReplay:none validation, count/send payload parity, real DSH
// usage observation, multi-step tool progression). Certification binds
// this revision, so evidence from the v1 suite never authorizes a route.
const CANARY_SUITE_REVISION_V2 = 'oc01-canary-suite-v2';
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
  'staged-memory', 'current-turn', 'coverage', 'native-tail', 'wire-route', 'exact-material', 'counter', 'budget',
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
      requestShapeRevision: OPENCODE_REQUEST_SHAPE_V3,
      canarySuiteRevision: CANARY_SUITE_REVISION_V2,
    });
  } catch (error) {
    void error;
    return { known: false, identity: null };
  }
}
// Install root of this composition: explicit, else derived from the
// bindings file (<root>/data/routing/session-bindings.json).
function installRootOfV2(input) {
  if (isPlainObject(input) && typeof input.installRoot === 'string' && input.installRoot !== '') return path.resolve(String(input.installRoot));
  if (isPlainObject(input) && typeof input.bindingsPath === 'string' && input.bindingsPath !== '') {
    return path.resolve(path.dirname(path.resolve(String(input.bindingsPath))), '..', '..');
  }
  return null;
}
/**
 * The Responses wire route of the approved OpenCode pair, resolved from the
 * installed settings.yaml llm-pi-ai profile (closed world; null = unknown).
 */
function opencodeWireRouteV2(input) {
  try {
    const root = installRootOfV2(input);
    if (root === null) return null;
    const settingsText = readTextFileV2(path.join(root, 'config', 'settings.yaml'), 1048576);
    if (settingsText === null) return null;
    return wireV2.readResponsesRouteFromSettingsV2(settingsText, opencodeV2.OPENCODE_PROVIDER_V1, opencodeV2.OPENCODE_MODEL_V1);
  } catch (error) {
    void error;
    return null;
  }
}
// Extractor skip -> typed fallback reason (the skip code itself travels as
// the content-free nativeTailSkip diagnostic).
function nativeTailReasonOfV2(skipped) {
  if (skipped === 'active-tail-overlap') return 'active-native-tail-overlap';
  if (skipped === 'active-turn-missing' || skipped === 'active-turn-unanchored'
    || skipped === 'active-turn-anchor-missing' || skipped === 'active-turn-anchor-ambiguous') {
    return 'active-native-tail-ambiguous';
  }
  return 'active-native-tail-invalid';
}
function anchorTurnTextV2(message) {
  if (!isPlainObject(message) || message.role !== 'user' || !Array.isArray(message.content)) return null;
  const texts = [];
  for (const block of message.content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  const text = texts.join(String.fromCharCode(10));
  return text === '' ? null : text;
}
/**
 * The ONE derived-request builder (used for counting AND sending): every
 * non-owned key by reference; messages = the native tail after the route's
 * reasoningReplay capability (native: same objects, same order; none: an
 * assistant message with historical reasoning becomes a copy without those
 * blocks, everything else by reference); system = original system bytes +
 * separator + compiled context (the original is a strict byte prefix);
 * metadata = markers.
 */
function buildDerivedRequestV2(request, tail, contextText, markers, route) {
  const derived = {};
  for (const key of Object.keys(request)) derived[key] = request[key];
  derived.messages = Object.freeze(wireV2.applyReasoningReplayV2(tail.slice(), route));
  const base = typeof request.system === 'string' ? request.system : '';
  if (typeof contextText === 'string' && contextText !== '') {
    derived.system = base === '' ? contextText : base + CCV2_SYSTEM_SEPARATOR_V1 + contextText;
  } else if (request.system !== undefined) {
    derived.system = request.system;
  }
  derived.metadata = Object.freeze(Object.assign({}, isPlainObject(request.metadata) ? request.metadata : {}, markers || {}));
  return derived;
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
      nativeTailSkip: typeof found.nativeTailSkip === 'string' && shadowHostV2.ACTIVE_TAIL_SKIP_REASONS.concat(['active-turn-coverage-missing', 'active-turn-anchor-textless']).indexOf(found.nativeTailSkip) !== -1
        ? found.nativeTailSkip : null,
      nativeTailMessages: Number.isInteger(found.nativeTailMessages) ? found.nativeTailMessages : null,
      nativePrefixMessages: Number.isInteger(found.nativePrefixMessages) ? found.nativePrefixMessages : null,
    }, activationV2.activationTelemetryV2(found.activation),
    museV2.pickCounterTelemetryV2(found.counterTelemetry))),
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
    // RC1.1 Layer A: the context-pressure activation gate, before any
    // authority, counter, file or compiler work. NATIVE is the original
    // request verbatim (native reasoning replay): a policy outcome, not a
    // failure (fallbackReason null), always reported with its reason code.
    const wireRoute = opencodeWireRouteV2(input);
    const liveSession = isPlainObject(input.liveSession) && typeof input.liveSession.events === 'function' ? input.liveSession : null;
    let liveEvents = null;
    try {
      liveEvents = liveSession === null ? null : liveSession.events();
    } catch (error) {
      void error;
      liveEvents = null;
    }
    const activationMode = isPlainObject(input.activation) ? input.activation
      : activationV2.resolveActivationModeV2(readPolicyConfigV2(installRootOfV2(input)));
    const gate = activationV2.decideActivationV2({ mode: activationMode, route: wireRoute, events: liveEvents, messages: request.messages });
    diag.activation = gate;
    if (gate.decision !== activationV2.DECISION_ACTIVATE) return legacyHostResult(request, null, null, diag);
    if (currentOpencodeHealthV2() !== opencodeV2.HEALTH_HEALTHY) {
      return fallback(request, 'active-tokenizer-unavailable', 'authority-health');
    }
    const hasMockCounter = isPlainObject(input.metaRemoteCounter)
      && typeof input.metaRemoteCounter.countTextsV2 === 'function'
      && typeof input.metaRemoteCounter.countPayloadV2 === 'function'
      && typeof input.metaRemoteCounter.buildMemoCounterV2 === 'function'
      && input.metaRemoteCounter.fingerprint === remoteV2.REMOTE_FINGERPRINT_V1;
    // Staging stays synchronous and never resolves a credential: it only
    // requires that SOME key source exists (explicit, environment, or the
    // managed-credential resolver). The key itself is resolved in the async
    // completion phase, immediately before remote counting.
    const explicitMetaKey = typeof input.metaApiKey === 'string' && input.metaApiKey !== '' ? input.metaApiKey : null;
    const resolveMetaApiKey = typeof input.resolveMetaApiKey === 'function' ? input.resolveMetaApiKey : null;
    if (hasMockCounter !== true && explicitMetaKey === null && envMetaKeyV2() === null && resolveMetaApiKey === null) {
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
    // ACTIVE-TAIL-NATIVE boundary: the producer-owned anchor of the open
    // DSH turn, verified against the live request. prefix = messages
    // [0..anchor) must be historically covered; tail = messages[anchor..]
    // travels provider-native and must share nothing with staged memory.
    // Ambiguity or overlap is a typed LEGACY fallback, never a guess.
    const stagedCoverage = shadowHostV2.readStagedCoverageV2(memoryDir);
    if (stagedCoverage.skipped !== null) return fallback(request, 'active-current-turn-invalid', 'coverage');
    if (stagedCoverage.coverage === null) {
      diag.nativeTailSkip = 'active-turn-coverage-missing';
      return fallback(request, 'active-native-tail-ambiguous', 'native-tail');
    }
    const extracted = shadowHostV2.extractActiveTailV2({
      messages: request.messages, coverage: stagedCoverage.coverage, toolTransactions: stagedTx.transactions,
    });
    if (extracted.boundary === null) {
      diag.nativeTailSkip = extracted.skipped;
      return fallback(request, nativeTailReasonOfV2(extracted.skipped), 'native-tail');
    }
    const boundary = extracted.boundary;
    diag.nativeTailMessages = boundary.tail.length;
    diag.nativePrefixMessages = boundary.prefixLength;
    const anchorText = anchorTurnTextV2(boundary.tail[0]);
    if (anchorText === null) {
      diag.nativeTailSkip = 'active-turn-anchor-textless';
      return fallback(request, 'active-native-tail-ambiguous', 'native-tail');
    }
    const liveTurn = { turn: { turnId: 'live', text: anchorText, revision: null }, skipped: null };
    const liveTurnHash = sha256HexUtf8(anchorText);
    if (wireRoute === null) return fallback(request, 'active-native-tail-unprojectable', 'wire-route');
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
    // A supplied counter (tests, pre-warm re-staging) is used as-is; the
    // production counter is created at completion from the resolved key.
    const metaRemoteCounter = hasMockCounter === true ? input.metaRemoteCounter : null;
    const counterPlan = Object.freeze({
      descriptor, explicitMetaKey, resolveMetaApiKey,
      createMetaCounter: typeof input.createMetaCounter === 'function' ? input.createMetaCounter : remoteV2.createMuseRemoteCounterV2,
      timeoutMs: input.countTimeoutMs, deadlineMs: input.countDeadlineMs,
    });
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
      runtimeState: { pendingProtocol: shadowHostV2.derivePendingProtocolV2(request.messages.slice(0, boundary.anchorIndex)) },
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
      liveTurnHash, liveTurn, memoryDir, metaRemoteCounter, counterPlan, boundary, wireRoute,
      bindingFound: diag.bindingFound, checkpointFound: diag.checkpointFound,
      sessionSourceAvailable: diag.sessionSourceAvailable,
      nativeTailMessages: diag.nativeTailMessages, nativePrefixMessages: diag.nativePrefixMessages,
      activation: gate, liveSession,
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
// reasoning effort, output cap, tools, routing authority, session id,
// abort signal, ...) is carried by REFERENCE and verified identical.
// `system` is owned only as an append: the original bytes stay a strict
// prefix (proven below), the compiled context follows the separator.
const PROJECTION_OWNED_KEYS = Object.freeze(['messages', 'metadata', 'system']);
function envelopeUnchangedV2(request, derived) {
  const sourceKeys = Object.keys(request).filter((key) => PROJECTION_OWNED_KEYS.indexOf(key) === -1).sort();
  const derivedKeys = Object.keys(derived).filter((key) => PROJECTION_OWNED_KEYS.indexOf(key) === -1).sort();
  if (sourceKeys.join(',') !== derivedKeys.join(',')) return false;
  return sourceKeys.every((key) => derived[key] === request[key]);
}
// Original system bytes are a strict prefix of the derived system, joined
// by exactly the separator, followed by exactly the compiled context.
function systemPrefixProvenV2(request, derived, contextText) {
  if (typeof contextText !== 'string' || contextText === '' || typeof derived.system !== 'string') return false;
  if (request.system !== undefined && typeof request.system !== 'string') return false;
  const base = typeof request.system === 'string' ? request.system : '';
  const expected = base === '' ? contextText : base + CCV2_SYSTEM_SEPARATOR_V1 + contextText;
  return derived.system === expected && derived.system.length > base.length && derived.system.startsWith(base);
}
// The native tail survives in order with nothing added: each message is
// the original object, or (reasoningReplay=none) a copy of an assistant
// message whose non-reasoning blocks are the SAME objects in the same order
// and whose identity/role/other source fields are unchanged.
function nativeTailPreservedV2(request, derived, boundary, route) {
  const expected = request.messages.slice(boundary.anchorIndex);
  if (!Array.isArray(derived.messages) || derived.messages.length !== expected.length) return false;
  return expected.every((message, index) => {
    const got = derived.messages[index];
    if (got === message) return true;
    if (route.reasoningReplay !== wireV2.REASONING_REPLAY_NONE || message.role !== 'assistant' || got.role !== 'assistant') return false;
    if (got.id !== message.id || !Array.isArray(got.content) || got.content.some((block) => block.type === 'reasoning')) return false;
    const kept = message.content.filter((block) => block.type !== 'reasoning');
    if (kept.length !== got.content.length || !kept.every((block, i) => got.content[i] === block)) return false;
    const keys = new Set(Object.keys(message).concat(Object.keys(got)));
    for (const key of keys) {
      if (key === 'content' || key === 'source') continue;
      if (got[key] !== message[key]) return false;
    }
    for (const key of new Set(Object.keys(message.source || {}).concat(Object.keys(got.source || {})))) {
      if (key === 'replayState') continue;
      if (got.source[key] !== message.source[key]) return false;
    }
    return true;
  });
}
function envMetaKeyV2() {
  const value = typeof process !== 'undefined' && process.env ? process.env[MODEL_API_KEY_ENV] : undefined;
  return typeof value === 'string' && value !== '' ? value : null;
}
// Precedence: explicit dependency > process environment > managed
// credential store (its own resolver also honours the inherited
// environment). A throwing or empty resolver is "no key". Never logged.
async function resolveMetaKeyV2(plan) {
  if (plan.explicitMetaKey !== null) return plan.explicitMetaKey;
  const fromEnv = envMetaKeyV2();
  if (fromEnv !== null) return fromEnv;
  if (plan.resolveMetaApiKey === null) return null;
  try {
    const resolved = await plan.resolveMetaApiKey();
    return typeof resolved === 'string' && resolved !== '' ? resolved : null;
  } catch (error) {
    void error;
    return null;
  }
}
// Counter actually used for a staged request (pre-warm reuses it).
const resolvedCounters = new WeakMap();
function counterOfStagedV2(staged) {
  if (isPlainObject(staged.metaRemoteCounter)) return staged.metaRemoteCounter;
  const found = resolvedCounters.get(staged);
  return found === undefined ? null : found;
}
async function completeOpencodeProjectionV2(staged) {
  const request = staged.request;
  const diag = {
    bindingFound: staged.bindingFound === true, checkpointFound: staged.checkpointFound === true,
    sessionSourceAvailable: staged.sessionSourceAvailable, compilerExecutions: 0,
    nativeTailMessages: staged.nativeTailMessages, nativePrefixMessages: staged.nativePrefixMessages,
    activation: staged.activation,
  };
  const fallback = (reason, stage) => legacyHostResult(request, reason, stage, diag);
  try {
    let metaRemoteCounter = staged.metaRemoteCounter;
    if (metaRemoteCounter === null) {
      const plan = staged.counterPlan;
      const metaKey = await resolveMetaKeyV2(plan);
      if (metaKey === null) return fallback('active-tokenizer-unavailable', 'counter-credential');
      try {
        metaRemoteCounter = plan.createMetaCounter({ descriptor: plan.descriptor, apiKey: metaKey, timeoutMs: plan.timeoutMs, deadlineMs: plan.deadlineMs });
      } catch (error) {
        void error;
        return fallback('active-tokenizer-unavailable', 'counter');
      }
      resolvedCounters.set(staged, metaRemoteCounter);
    }
    const boundary = staged.boundary;
    // The exact-count authority: the pinned Responses wire projection of
    // the FINAL hybrid request (built by the same builder that builds the
    // sent request). Counting context and appending the tail later is
    // impossible by construction.
    const wire = Object.freeze({
      project: (contextText) => wireV2.projectResponsesWireV2({
        request: buildDerivedRequestV2(request, boundary.tail, contextText, null, staged.wireRoute),
        route: staged.wireRoute,
      }),
    });
    const decision = await opencodeV2.attemptOpencodeActiveV2({
      compileInput: staged.compileInput,
      pages: staged.pages,
      metaRemoteCounter,
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
      wire,
    });
    diag.compilerExecutions = decision.compilerExecutions === 1 ? 1 : 0;
    if (decision.eligible !== true) {
      diag.attemptFailureStage = typeof decision.failureStage === 'string' ? decision.failureStage : 'unknown';
      diag.attemptErrorClass = isPlainObject(decision.errorClass) ? decision.errorClass : null;
      diag.counterTelemetry = isPlainObject(decision.counterTelemetry) ? decision.counterTelemetry : null;
      return fallback(decision.fallbackReason, 'attempt');
    }
    // Current turn exactly once: natively in the tail (anchor), never in
    // the compiled context.
    const render = decision.render;
    if (render.roleContract !== rendererV2.RENDER_ROLE_CONTRACT_CONTEXT_ONLY_V2
      || render.messagePlan.some((message) => message.role !== 'system')
      || !isPlainObject(render.nativeTurn) || render.nativeTurn.contentHash !== staged.liveTurnHash
      || typeof decision.contextText !== 'string' || decision.contextText === '') {
      return fallback('active-current-turn-invalid', 'compiled-turn');
    }
    // Defense in depth over the structural overlap proof (staged call ids
    // and message hashes, extractActiveTailV2): no tail call id may appear
    // in a producer tool-call header inside the compiled context.
    for (const callId of boundary.tailCallIds) {
      if (decision.contextText.indexOf('id=' + callId + ']') !== -1) return fallback('active-native-tail-overlap', 'native-tail');
    }
    const derived = buildDerivedRequestV2(request, boundary.tail, decision.contextText, {
      projectionMode: 'CCV2_COMPILED',
      ccv2ViewId: decision.view.id,
      ccv2RenderDigest: render.renderDigest,
      ccv2Authority: 'REMOTE_MUSE_PRECOUNT',
      ccv2PreCount: decision.preCount,
      ccv2Margin: decision.providerSafetyMargin,
      ccv2WireRevision: wireV2.RESPONSES_WIRE_REVISION_V1,
      ccv2NativeTailMessages: boundary.tail.length,
      ccv2ReasoningReplay: staged.wireRoute.reasoningReplay,
    }, staged.wireRoute);
    if (!envelopeUnchangedV2(request, derived)) return fallback('active-request-binding-changed', 'envelope');
    if (!systemPrefixProvenV2(request, derived, decision.contextText)) return fallback('active-request-binding-changed', 'envelope');
    if (!nativeTailPreservedV2(request, derived, boundary, staged.wireRoute)) return fallback('active-native-tail-invalid', 'native-tail');
    // Counted == sent: the final derived request (markers included)
    // projects to exactly the body that was counted.
    let finalProjection = null;
    try {
      finalProjection = wireV2.projectResponsesWireV2({ request: derived, route: staged.wireRoute });
    } catch (error) {
      void error;
      return fallback('active-native-tail-unprojectable', 'native-tail');
    }
    if (JSON.stringify(finalProjection.countedBody) !== JSON.stringify(decision.inferenceBody)
      || JSON.stringify(finalProjection.wireBody) !== JSON.stringify(decision.wireBody)) {
      return fallback('active-request-binding-changed', 'envelope');
    }
    const telemetry = Object.freeze(Object.assign({}, decision.telemetry, {
      projectionMode: 'CCV2_COMPILED',
      fallbackReason: null,
      fallbackStage: null,
      compilerExecutions: 1,
      bindingFound: true,
      checkpointFound: true,
      nativeTailMessages: boundary.tail.length,
      nativePrefixMessages: boundary.prefixLength,
      nativeTailSkip: null,
      reasoningReplay: staged.wireRoute.reasoningReplay,
      replayedReasoningBlocksOmitted: boundary.tail.reduce((sum, message, index) => sum + (derived.messages[index] === message ? 0
        : message.content.filter((block) => block.type === 'reasoning').length), 0),
    }, activationV2.activationTelemetryV2(staged.activation)));
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
    const counter = counterOfStagedV2(staged);
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
        liveSession: liveSessionOfV2(safeDeps, staged.request.sessionId),
        installRoot: safeDeps.installRoot,
        bindingsPath: safeDeps.bindingsPath,
        sessionSourceFor: safeDeps.sessionSourceFor,
        metaApiKey: safeDeps.metaApiKey,
        resolveMetaApiKey: safeDeps.resolveMetaApiKey,
        metaRemoteCounter: counterOfStagedV2(staged),
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
    // Pre-warm seeds only the per-text memo counts of the context-only
    // compilation; the whole-payload counts (reserve + final) carry the
    // live native tail and are always counted at request time.
    const texts = museV2.enumerateMusePrewarmTextsV2({
      contextOnly: true,
      compileInput: source.compileInput,
      pages: source.pages,
      requestTerms: {
        systemText: typeof source.request.system === 'string' ? source.request.system : '',
        turnText: source.liveTurn.turn.text,
      },
    });
    summary = texts === null
      ? { attempted: 0, cached: 0, counted: 0, skipped: 'enumeration' }
      : await counterOfStagedV2(source).prewarmTextsV2(texts);
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
// deps.liveSessionFor(sessionId) (the M01 producer registry accessor) gives
// the gate its durable usage samples. Absent or throwing: null (the gate then
// measures nothing and stays NATIVE).
function liveSessionOfV2(deps, sessionId) {
  if (typeof deps.liveSessionFor !== 'function') return null;
  try {
    const found = deps.liveSessionFor(sessionId);
    return isPlainObject(found) ? found : null;
  } catch (error) {
    void error;
    return null;
  }
}
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
      // One read of the single config authority: compiler mode and the RC1.1
      // activation policy come from the same routing-policy.json section.
      const policyConfig = readPolicyConfigV2(safeDeps.installRoot);
      policy = activeV2.resolveCompilerModeV2({ config: policyConfig });
      if (policy.mode !== 'active' || policy.valid !== true) return next();
      const activation = activationV2.resolveActivationModeV2(policyConfig);
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
        activation,
        liveSession: liveSessionOfV2(safeDeps, request.sessionId),
        installRoot: safeDeps.installRoot,
        bindingsPath: safeDeps.bindingsPath,
        sessionSourceFor: safeDeps.sessionSourceFor,
        metaApiKey: safeDeps.metaApiKey,
        metaRemoteCounter: safeDeps.metaRemoteCounter === undefined ? null : safeDeps.metaRemoteCounter,
        resolveMetaApiKey: safeDeps.resolveMetaApiKey,
        createMetaCounter: safeDeps.createMetaCounter,
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
// The llm/stream seam carries DSH StreamChunks only: { type: 'usage',
// usage: TokenUsage }. TokenUsage counts are DISJOINT (dsh-llm types.d.ts):
// the pinned pi-ai Responses adapter reports inputTokens = wire
// input_tokens - cached_tokens - cache_write_tokens and omits a cache
// field when it is zero, so the provider-billed input the pre-count
// bounds is inputTokens + cacheReadTokens + cacheWriteTokens. Provider
// wire shapes (input_tokens / prompt_tokens) never reach this seam and
// are not accepted. A malformed usage chunk is no observation (null).
function readUsageFromChunkV2(chunk) {
  try {
    if (!isPlainObject(chunk) || chunk.type !== 'usage' || !isPlainObject(chunk.usage)) return null;
    const usage = chunk.usage;
    if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0) return null;
    const optional = (value) => {
      if (value === undefined) return 0;
      return Number.isInteger(value) && value >= 0 ? value : null;
    };
    const cacheReadTokens = optional(usage.cacheReadTokens);
    const cacheWriteTokens = optional(usage.cacheWriteTokens);
    if (cacheReadTokens === null || cacheWriteTokens === null) return null;
    return {
      inputTokens: usage.inputTokens + cacheReadTokens + cacheWriteTokens,
      uncachedInputTokens: usage.inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
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
              uncachedInputTokens: found.uncachedInputTokens,
              cacheReadTokens: found.cacheReadTokens,
              cacheWriteTokens: found.cacheWriteTokens,
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
  OPENCODE_REQUEST_SHAPE_V2,
  OPENCODE_REQUEST_SHAPE_V3,
  CCV2_SYSTEM_SEPARATOR_V1,
  PROJECTION_OWNED_KEYS,
  MARGIN_POLICY_REVISION_V1,
  OUTPUT_RESERVE_POLICY_REVISION_V1,
  CANARY_SUITE_REVISION_V1,
  CANARY_SUITE_REVISION_V2,
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
