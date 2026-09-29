'use strict';
/**
 * ContextCompilerActiveHostV2.cjs - CCV2-C08 production activation wiring.
 *
 * The ONE production installation point for active compiled projection.
 * Owned by the controller layer (installed from config/AihController.cjs
 * apply(), alongside the C07H shadow observer). This module owns the
 * unified contextCompiler policy, authoritative budget-counting inputs,
 * immutable projection replacement, and final-boundary revalidation;
 * the pure compile/render/gate math lives in
 * config/ContextCompilerActiveV2.cjs and is never duplicated here.
 *
 * Activation boundary (frozen): C07 = observe, C08 = model-facing
 * activation. The ONLY new authority is which validated context
 * projection reaches the root model. Task truth, checkpoint truth,
 * tier truth, retrieval, packing, compression, routing, provider and
 * model selection, approval semantics, and tool lifecycle are
 * untouched.
 *
 * Unified policy (single contextCompiler section in
 * <installRoot>/config/routing-policy.json):
 *   absent / { }                       -> off (upgrades never activate)
 *   legacy { shadowMode: off|observe,   -> honored exactly as C07H froze;
 *              budget, tokenizer }        'active' via shadowMode rejected
 *   { mode: off|observe|active,         -> unified authority; active takes
 *     target?, safetyReserveTokens? }     OPTIONAL target preference and
 *                                          safety reserve ONLY. A legacy
 *                                          budget{} or tokenizer{} key next
 *                                          to mode:active fails the policy
 *                                          closed to off (no competing
 *                                          budget/tokenizer authority;
 *                                          logical/test counters can never
 *                                          authorize production counting).
 *
 * In observe/off the wrapper returns next() verbatim (zero compiler
 * work; C07 keeps its own llm/stream observer, which resolves the same
 * section to off when mode:active, so active requests run exactly one
 * compiler execution and observe requests run exactly one shadow).
 *
 * In active mode the wrapper (preset-row agent/request position,
 * outside the routing rewrite so route/authority guards keep passing
 * on the unchanged route):
 *   resolved = await next() (frozen finalized request, read-only)
 *   capability <- explicit dep or closed-world resolve for the
 *                 ALREADY-SELECTED provider/model (never re-routes)
 *   counts <- production counter over system/tools/framing envelope
 *   budget <- derived modelMax minus every reserve (no guessing)
 *   staged <- frozen memory readers (shared with C07H, never
 *             reimplemented)
 *   decision <- attemptCompilerActiveV2 (one C01->C06 + one render)
 *   revalidate sealed revision at completion (TOCTOU guard)
 *   eligible -> return ONE frozen derived request (bulk messages
 *               replaced atomically; system/tools/route/authority
 *               byte-identical; metadata.projectionMode marker)
 *   ineligible -> return resolved VERBATIM (same reference)
 *
 * The derived request is built and fully validated BEFORE it is
 * returned; on any failure the original request is untouched
 * (immutable source, atomic replacement). Telemetry is secret-safe
 * (ids/digests/counts only) and never blocks a compiled send.
 */

const fs = require('node:fs');
const path = require('node:path');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const compilerV2 = require('./ContextCompilerV2.cjs');
const counterV2 = require('./ContextTokenCounterV2.cjs');
const capabilityV2 = require('./ContextModelCapabilityV2.cjs');
const activeV2 = require('./ContextCompilerActiveV2.cjs');
const shadowHostV2 = require('./ContextCompilerShadowHostV2.cjs');
const tokenizerRegistryV2 = require('./ContextTokenizerRegistryV2.cjs');

const HOST_SCHEMA_VERSION = 1;
const ACTIVE_POLICY_SECTION = 'contextCompiler';
const ROUTING_POLICY_FILE = 'routing-policy.json';
const ACTIVE_TELEMETRY_EVENT = 'ccv2-compiler-active-decided';

// Auxiliary llm/stream purposes are never root inference (mirrors C07H).
const AUXILIARY_PURPOSES = Object.freeze(['compaction', 'session-title']);

const READ_BOUNDS = Object.freeze({
  policyFileBytes: 1048576,
});

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
  if (typeof ns.taskId !== 'string' || typeof ns.taskInstanceId !== 'string'
    || typeof ns.sessionId !== 'string') return null;
  return { taskId: ns.taskId, taskInstanceId: ns.taskInstanceId, sessionId: ns.sessionId };
}

// ---- unified policy ----

/**
 * Resolve the unified contextCompiler policy from the ONE source:
 * <installRoot>/config/routing-policy.json -> contextCompiler.
 * Never throws: unreadable/invalid policy is off. Read fresh per
 * request (same cost profile as C07H); no cache, no stale policy.
 */
function resolveActivePolicyV2(input) {
  const off = (reason) => Object.freeze({
    mode: 'off', target: null, safetyReserveTokens: 0, valid: false, reason,
  });
  try {
    const root = input && typeof input.installRoot === 'string' && input.installRoot !== ''
      ? path.resolve(String(input.installRoot)) : null;
    if (root === null) return off('active-policy-no-install-root');
    const policyPath = path.join(root, 'config', ROUTING_POLICY_FILE);
    let text = null;
    try {
      text = fs.readFileSync(policyPath, 'utf8');
    } catch {
      return off('active-policy-absent');
    }
    if (Buffer.byteLength(text, 'utf8') > READ_BOUNDS.policyFileBytes) return off('active-policy-oversize');
    let document = null;
    try {
      document = JSON.parse(text);
    } catch {
      return off('active-policy-invalid');
    }
    const section = document && document[ACTIVE_POLICY_SECTION];
    if (section === undefined || section === null) {
      return Object.freeze({ mode: 'off', target: null, safetyReserveTokens: 0, valid: true, reason: null });
    }
    if (!isPlainObject(section)) return off('active-policy-section-invalid');
    const resolved = activeV2.resolveCompilerModeV2({ config: { contextCompiler: section } });
    if (resolved.mode === 'off') {
      return Object.freeze({
        mode: 'off', target: null, safetyReserveTokens: 0,
        valid: resolved.valid, reason: resolved.reason,
      });
    }
    if (resolved.mode === 'observe') {
      return Object.freeze({
        mode: 'observe', target: null, safetyReserveTokens: 0,
        valid: resolved.valid, reason: resolved.reason,
      });
    }
    // Active: ONLY target preference + safety reserve are configurable.
    // A legacy budget{} or tokenizer{} beside mode:active would compete
    // with derived budget / verified capability: fail closed to off.
    if (section.budget !== undefined && section.budget !== null) return off('active-policy-budget-forbidden');
    if (section.tokenizer !== undefined && section.tokenizer !== null) return off('active-policy-tokenizer-forbidden');
    let target = null;
    if (section.target !== undefined && section.target !== null) {
      if (!Number.isInteger(section.target) || section.target < 1) return off('active-policy-target-invalid');
      target = section.target;
    }
    let safety = 0;
    if (section.safetyReserveTokens !== undefined && section.safetyReserveTokens !== null) {
      if (!Number.isInteger(section.safetyReserveTokens) || section.safetyReserveTokens < 0) {
        return off('active-policy-reserve-invalid');
      }
      safety = section.safetyReserveTokens;
    }
    for (const key of Object.keys(section)) {
      if (['mode', 'shadowMode', 'target', 'safetyReserveTokens'].indexOf(key) === -1) {
        return off('active-policy-section-invalid');
      }
    }
    return Object.freeze({ mode: 'active', target, safetyReserveTokens: safety, valid: true, reason: null });
  } catch {
    return off('active-policy-failed');
  }
}

// ---- live-request measurement (typed structure, production counter) ----

function countVerified(counter, text, what) {
  try {
    return counterV2.countTextVerifiedV2(counter, text);
  } catch (error) {
    throw new Error('context-active-count-failed: ' + what + ' (DISCARDABLE)');
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
    if (texts.length > 0) found.push({ index, text: texts.join('\n') });
  });
  return found;
}

// ---- immutable projection replacement ----

function legacyResult(request, reason, decision) {
  return Object.freeze({
    mode: 'LEGACY',
    request,
    fallbackReason: reason,
    performed: false,
    decision: decision === undefined ? null : decision,
    telemetry: Object.freeze({
      projectionMode: 'LEGACY',
      fallbackReason: reason,
      compilerExecutions: decision && decision.compilerExecutions === 1 ? 1 : 0,
    }),
  });
}

/**
 * Attempt the active projection for one finalized request. Pure
 * except for bounded frozen memory/policy reads and the optional
 * telemetry sink. NEVER mutates the input request; the LEGACY path
 * returns the identical reference. NEVER throws for pipeline
 * reasons (returns LEGACY with a closed-world reason).
 */
function applyActiveProjectionV2(input) {
  try {
    if (!isPlainObject(input)) return legacyResult(null, 'active-compiler-failed');
    const request = isPlainObject(input.request) ? input.request : null;
    if (request === null) return legacyResult(input.request, 'active-compiler-failed');
    const policy = isPlainObject(input.policy) ? input.policy : null;
    if (policy === null || policy.mode !== 'active' || policy.valid !== true) {
      return legacyResult(request, null);
    }
    if (typeof request.sessionId !== 'string' || request.sessionId === '') {
      return legacyResult(request, 'active-request-binding-changed');
    }
    if (typeof request.provider !== 'string' || request.provider === ''
      || typeof request.model !== 'string' || request.model === '') {
      return legacyResult(request, 'active-model-capability-unknown');
    }
    if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
      return legacyResult(request, 'active-budget-unrepresentable');
    }
    if (!Array.isArray(request.messages)) return legacyResult(request, 'active-request-binding-changed');

    // Capability for the ALREADY-SELECTED route (explicit dep wins;
    // otherwise closed-world resolve; never re-routes, never guesses).
    let capability = null;
    if (input.capability !== undefined && input.capability !== null) {
      const check = capabilityV2.validateModelCapabilityV2(input.capability);
      if (!check.valid) {
        return legacyResult(request, check.reason === 'active-tokenizer-unavailable'
          ? 'active-tokenizer-unavailable' : 'active-model-capability-unknown');
      }
      if (check.capability.provider !== request.provider || check.capability.model !== request.model) {
        return legacyResult(request, 'active-request-binding-changed');
      }
      capability = check.capability;
    } else {
      const resolved = capabilityV2.resolveModelCapabilityV2({
        provider: request.provider,
        model: request.model,
        installRoot: input.installRoot,
        supportedRoutes: input.supportedRoutes,
      });
      if (!resolved.valid) return legacyResult(request, resolved.reason);
      capability = resolved.capability;
    }
    const counter = capability.tokenCounter;

    // Authoritative counts through the PRODUCTION counter.
    const systemText = typeof request.system === 'string' ? request.system : '';
    const hostPrefixTokens = systemText === '' ? 0 : countVerified(counter, systemText, 'host-prefix');
    const toolSchemaTokens = countVerified(counter, canonicalJsonOf(request.tools === undefined ? [] : request.tools), 'tool-schema');
    const framingTokens = countVerified(counter, canonicalJsonOf({
      provider: request.provider,
      model: request.model,
      reasoningEffort: request.reasoningEffort === undefined ? null : request.reasoningEffort,
    }), 'request-framing');
    let outputReserve = request.maxTokens;
    if (capability.maxOutputTokens !== null && capability.maxOutputTokens !== undefined) {
      if (request.maxTokens > capability.maxOutputTokens) {
        return legacyResult(request, 'active-budget-unrepresentable');
      }
    }

    const budgetCheck = activeV2.deriveActiveBudgetV2({
      modelMax: capability.maxContextTokens,
      hostPrefixTokens,
      toolSchemaTokens,
      framingTokens,
      reservedOutputTokens: outputReserve,
      safetyReserveTokens: policy.safetyReserveTokens || 0,
      requestedTarget: policy.target,
    });
    if (!budgetCheck.valid) return legacyResult(request, budgetCheck.reason);
    const derived = budgetCheck.budget;

    // Staged memory through the FROZEN C07H readers (one authority).
    const bindingsPath = typeof input.bindingsPath === 'string' ? input.bindingsPath : null;
    if (bindingsPath === null) return legacyResult(request, 'active-request-binding-changed');
    const binding = shadowHostV2.readSessionBindingV2({ bindingsPath, sessionId: request.sessionId });
    if (binding === null) return legacyResult(request, 'active-request-binding-changed');
    const bindingTriple = tripleOf({
      taskId: binding.taskId,
      taskInstanceId: typeof binding.taskInstanceId === 'string' ? binding.taskInstanceId : null,
      sessionId: typeof binding.sessionId === 'string' && binding.sessionId !== ''
        ? binding.sessionId : request.sessionId,
    });
    if (bindingTriple === null || bindingTriple.taskInstanceId === null) {
      return legacyResult(request, 'active-request-binding-changed');
    }
    const memoryDir = shadowHostV2.shadowMemoryDirForV2(binding.workspace, bindingTriple.taskId);
    if (memoryDir === null) return legacyResult(request, 'active-request-binding-changed');
    const checkpointFound = shadowHostV2.readSealedCheckpointForTaskV2(memoryDir);
    if (checkpointFound.sealed === null) return legacyResult(request, 'active-compiler-failed');
    const sealed = checkpointFound.sealed;
    const stagedPages = shadowHostV2.readStagedPagesV2(memoryDir, bindingTriple);
    if (stagedPages.pages === null) return legacyResult(request, 'active-compiler-failed');
    const stagedDecisions = shadowHostV2.readStagedDecisionsV2(memoryDir, bindingTriple);
    if (stagedDecisions.decisions === null) return legacyResult(request, 'active-compiler-failed');
    const stagedTx = shadowHostV2.readStagedToolTransactionsV2(memoryDir);
    if (stagedTx.transactions === null) return legacyResult(request, 'active-compiler-failed');

    // Live current turn (typed blocks only; content never branched on).
    const liveTurn = shadowHostV2.extractLiveCurrentTurnV2(request.messages);
    if (liveTurn.turn === null) return legacyResult(request, 'active-current-turn-invalid');
    // Lossless-replacement rule: exactly one live user-text message
    // (the current turn). Anything else is unaccounted live state and
    // fails safe instead of being silently dropped.
    const liveUserTexts = liveUserTextMessages(request.messages);
    if (liveUserTexts.length !== 1) return legacyResult(request, 'active-current-turn-invalid');
    const liveTurnHash = sha256HexUtf8(liveTurn.turn.text);
    if (sha256HexUtf8(liveUserTexts[0].text) !== liveTurnHash) {
      return legacyResult(request, 'active-current-turn-invalid');
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
      budget: { hardMax: derived.ccv2HardMax, target: derived.ccv2Target },
      compilerPolicyRevision: compilerV2.COMPILER_POLICY_REVISION_V2,
    };

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
      provider: request.provider,
      model: request.model,
      maxTokens: request.maxTokens,
      outputReserveTokens: outputReserve,
      tokenizerFingerprint: capability.tokenizerFingerprint,
      capabilityRevision: capability.capabilityRevision,
    };

    const decision = activeV2.attemptCompilerActiveV2({
      compileInput,
      pages: stagedPages.pages,
      capability,
      ccv2Budget: { hardMax: derived.ccv2HardMax, target: derived.ccv2Target },
      hostPrefixTokens,
      toolSchemaTokens,
      framingTokens,
      reservedOutputTokens: outputReserve,
      modelMax: capability.maxContextTokens,
      binding: attemptBinding,
    });
    if (decision.eligible !== true) return legacyResult(request, decision.fallbackReason, decision);

    // Final TOCTOU revalidation: sealed revision must be unchanged
    // since capture; the render digest must still verify; the live
    // turn bytes must still match the compiled user message.
    let completeRevision = null;
    try {
      completeRevision = typeof input.getCurrentRevision === 'function'
        ? input.getCurrentRevision()
        : shadowHostV2.readSealedRevisionForTaskV2(memoryDir);
    } catch {
      return legacyResult(request, 'active-snapshot-stale', decision);
    }
    const liveBinding = Object.assign({}, attemptBinding, {
      snapshotRevision: typeof completeRevision === 'string' && completeRevision !== ''
        ? completeRevision : attemptBinding.snapshotRevision,
    });
    const recheck = activeV2.revalidateActiveRenderV2({ decision, liveBinding });
    if (recheck.current !== true) return legacyResult(request, recheck.fallbackReason, decision);

    // Provider-framed final proof (framed capabilities only): recount
    // the EXACT templated input (BOS + systems + USER + turn +
    // generation priming) as one unit through the production counter.
    // The stub-terms check inside the attempt is a conservative
    // pre-gate; this framed total governs the window authoritatively.
    // Overflow falls back; truncation never exists.
    let framedAccounting = null;
    if (capability.framing !== null && capability.framing !== undefined) {
      if (capability.framing.revision !== tokenizerRegistryV2.FRAMING_REVISION_V1) {
        return legacyResult(request, 'active-request-binding-changed', decision);
      }
      try {
        const framedSystems = [systemText];
        for (const message of decision.render.messagePlan) {
          if (message.role === 'system') framedSystems.push(message.text);
        }
        const framed = tokenizerRegistryV2.frameDeepseekChatV2({
          systemTexts: framedSystems,
          turnText: liveTurn.turn.text,
          generationPrime: true,
        });
        if (framed.tokenizerFingerprint !== capability.tokenizerFingerprint
          || framed.templateDigest !== capability.framing.templateDigest) {
          return legacyResult(request, 'active-request-binding-changed', decision);
        }
        if (framed.tokens + outputReserve > capability.maxContextTokens) {
          return legacyResult(request, 'active-render-over-budget', decision);
        }
        framedAccounting = Object.freeze({
          framedInputTokens: framed.tokens,
          framedMarkerTokens: framed.markerTokens,
          framingRevision: framed.framingRevision,
          templateDigest: framed.templateDigest,
        });
      } catch (error) {
        return legacyResult(request, 'active-render-invalid', decision);
      }
    }

    // Build + validate the ENTIRE replacement before touching the
    // request shape: compiled messages only (no legacy bulk survives),
    // host system/tools/route/authority preserved byte-exact.
    const compiledUserText = decision.render.messagePlan
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join('\n');
    if (sha256HexUtf8(compiledUserText) !== liveTurnHash) {
      return legacyResult(request, 'active-current-turn-invalid', decision);
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
      { projectionMode: 'CCV2_COMPILED', ccv2ViewId: decision.view.id, ccv2RenderDigest: decision.render.renderDigest },
    );
    // Request-identity proof: everything except the replaced bulk
    // region must be byte-identical to the source request.
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
    if (sourceEnvelope !== derivedEnvelope) return legacyResult(request, 'active-request-binding-changed', decision);
    const derivedRequest = Object.freeze(cloned);

    const telemetry = Object.freeze(Object.assign(
      {},
      activeV2.describeActiveDecisionV2(decision),
      { hostPrefixTokens, toolSchemaTokens, framingTokens, outputReserveTokens: outputReserve },
      framedAccounting === null ? {} : { framed: framedAccounting },
    ));
    if (typeof input.telemetrySink === 'function') {
      try {
        input.telemetrySink(telemetry, { policyRevision: activeV2.ACTIVE_POLICY_REVISION_V1, authoritative: false });
      } catch {
        // Telemetry alone never fails a validated compiled send.
      }
    }

    return Object.freeze({
      mode: 'CCV2_COMPILED',
      request: derivedRequest,
      fallbackReason: null,
      performed: true,
      decision,
      framed: framedAccounting,
      telemetry,
    });
  } catch {
    try {
      return legacyResult(isPlainObject(input) ? input.request : null, 'active-compiler-failed');
    } catch {
      return legacyResult(null, 'active-compiler-failed');
    }
  }
}

function defaultActiveTelemetrySinkV2(log) {
  return (telemetry) => {
    try {
      log(Object.assign({ event: ACTIVE_TELEMETRY_EVENT }, telemetry));
    } catch {
      // Telemetry is never an availability dependency.
    }
  };
}

/**
 * Create the agent/request waterfall projection wrapper. Contract:
 * OFF/OBSERVE -> return next() verbatim (zero compiler work).
 * ACTIVE      -> exactly one applyActiveProjectionV2 per request
 *                object; eligible returns the derived request,
 *                ineligible returns resolved verbatim. Never throws
 *                into the waterfall (any internal failure keeps the
 *                resolved request intact).
 */
function createActiveRequestListenerV2(deps) {
  const seen = new WeakSet();
  const safeDeps = isPlainObject(deps) ? deps : {};
  return async function compilerActiveRequestListener(payload, next) {
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
      const policy = resolveActivePolicyV2({ installRoot: safeDeps.installRoot });
      if (policy.mode !== 'active' || policy.valid !== true) return resolved;
      if (seen.has(resolved)) return resolved;
      seen.add(resolved);
      const outcome = applyActiveProjectionV2({
        request: resolved,
        policy,
        installRoot: safeDeps.installRoot,
        bindingsPath: safeDeps.bindingsPath,
        capability: safeDeps.capability === undefined ? null : safeDeps.capability,
        supportedRoutes: safeDeps.supportedRoutes,
        getCurrentRevision: safeDeps.getCurrentRevision,
        telemetrySink: defaultActiveTelemetrySinkV2(safeDeps.log),
      });
      if (outcome.mode === 'CCV2_COMPILED') return outcome.request;
      return resolved;
    } catch {
      return resolved;
    }
  };
}

/**
 * Install the ONE production active projection wrapper on ctx
 * (agent/request, preset-row position: outside the routing rewrite,
 * so route/authority guards keep passing on the unchanged route).
 * Idempotent per ctx (HMR safety). Never throws: a failed install
 * reports { installed:false } while controller startup proceeds.
 */
function installCompilerActiveProjection(ctx, deps) {
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
    ctx.on('agent/request', createActiveRequestListenerV2(safeDeps));
    installedCtxs.add(ctx);
    return { installed: true, reason: null };
  } catch {
    return { installed: false, reason: 'install-failed' };
  }
}

module.exports = {
  HOST_SCHEMA_VERSION,
  ACTIVE_POLICY_SECTION,
  ACTIVE_TELEMETRY_EVENT,
  AUXILIARY_PURPOSES,
  READ_BOUNDS,
  resolveActivePolicyV2,
  liveUserTextMessages,
  applyActiveProjectionV2,
  createActiveRequestListenerV2,
  installCompilerActiveProjection,
};
