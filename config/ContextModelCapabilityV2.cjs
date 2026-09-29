'use strict';
/**
 * ContextModelCapabilityV2.cjs - CCV2-C08 model/tokenizer capability authority.
 *
 * The ONE adapter-layer authority that binds an already-selected
 * provider/model route to its verified context/tokenizer contract.
 * C08 consumes this and NOTHING else for budget enforcement. Frozen
 * C01-C06 stay engine-neutral: no provider or model conditional lives
 * in the compiler, allocator, compressor, or layout modules, and none
 * lives here as a name-sniffing branch either. Resolution is exact
 * closed-world lookup only:
 *
 *   routeKey = provider + LF + model
 *
 * against (a) the Nexus model registry (config/model-registry.json,
 * contextWindow/maxOutputTokens, source 'model-registry') for capacity,
 * and (b) an explicit verified-tokenizer table for counting. Unknown
 * routes, unknown windows, and routes without a verified tokenizer
 * resolve to { valid:false } and force deterministic LEGACY fallback.
 * Nothing is guessed: no chars/4, no codepoints-as-model-tokens, no
 * word counts, no cross-model tokenizer reuse, no provider-name
 * assumptions.
 *
 * Production tokenizer posture (C08 activation boundary): the frozen
 * C04 test adapter ('test-codepoint-v1') and the C07 logical counter
 * ('logical-codepoint-v1') are NEVER production counting authorities.
 * Both fingerprints are explicitly rejected here. The only
 * production counting authority shipped in this module is the
 * deterministic stub-transport tokenizer below, whose tokenization
 * contract is DEFINED by the stub transport itself (exact UTF-8 byte
 * accounting, fingerprint 'nexus-stub-tokenizer-v1'). It makes exactly
 * one route family eligible for active compilation offline:
 * provider/model pairs explicitly registered as stub-verified. Every
 * real provider/model route resolves tokenizer-unknown until a
 * vendor-verified tokenizer with known vectors is registered, and
 * therefore stays on the legacy projection.
 *
 * A capability is immutable for the request it is bound to: frozen at
 * creation, validated before use, and re-checked at the final send
 * boundary by config/ContextCompilerActiveV2.cjs (fingerprint +
 * revision + route must still match).
 *
 * Determinism: no clocks, no randomness, no PIDs, no network, no
 * filesystem reads except the explicit model-registry file read in
 * resolveModelCapabilityV2 (bounded, read-only, fail-closed to
 * unknown). Identical inputs -> byte-identical capabilities.
 *
 * Security: typed metadata only. No prompt text, tool bodies, code,
 * or secrets are read, branched on, or emitted.
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (C08 record). NOT implemented here: budget derivation (Active),
 * rendering (Renderer), projection replacement (ActiveHost), routing
 * or provider selection (frozen independent authority).
 */

const fs = require('node:fs');
const path = require('node:path');

const counterV2 = require('./ContextTokenCounterV2.cjs');
const tokenizerRegistryV2 = require('./ContextTokenizerRegistryV2.cjs');

const MODEL_CAPABILITY_SCHEMA_VERSION = 1;
const MODEL_CAPABILITY_REVISION_V1 = 'model-context-capability-v1';
const MODEL_CAPABILITY_DIGEST_DOMAIN_V1 = 'nexus/model-context-capability/v1';

// Production stub-transport tokenizer: exact UTF-8 byte accounting.
// The contract is defined BY the stub transport (it counts the exact
// bytes it transmits), so for stub routes this IS the authoritative
// counter, not an approximation of another model's tokenizer.
const STUB_TOKENIZER_FINGERPRINT_V1 = 'nexus-stub-tokenizer-v1';

// Fingerprints that must never authorize production counting.
const REJECTED_PRODUCTION_FINGERPRINTS = Object.freeze([
  'test-codepoint-v1',
  'logical-codepoint-v1',
]);

// Known token vectors for the stub tokenizer (text -> exact UTF-8 bytes).
// Verification fixtures assert these byte-for-byte.
const STUB_TOKEN_VECTORS_V1 = Object.freeze([
  Object.freeze({ text: '', tokens: 0 }),
  Object.freeze({ text: 'hello', tokens: 5 }),
  Object.freeze({ text: 'Ship C08 now.', tokens: 13 }),
  Object.freeze({ text: 'h\u00e9llo', tokens: 6 }),
  Object.freeze({ text: '\uD83D\uDE00', tokens: 4 }),
  Object.freeze({ text: '\u4e2d\u6587', tokens: 6 }),
]);

const CAPABILITY_EXACT_KEYS = Object.freeze([
  'schemaVersion',
  'provider',
  'model',
  'maxContextTokens',
  'maxOutputTokens',
  'tokenizerFingerprint',
  'tokenCounter',
  'source',
  'verified',
  'capabilityRevision',
  'framing',
]);

const CAPABILITY_SOURCES = Object.freeze([
  'model-registry+stub-verified',
  'stub-verified',
  'deepseek-official-tokenizer',
]);

const FRAMING_EXACT_KEYS = Object.freeze(['revision', 'templateDigest']);

const POLICY_FILE_BOUND_BYTES = 1048576;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failCapability(code, detail) {
  throw new Error('model-capability-' + code + (detail === undefined ? '' : ': ' + detail) + ' (DISCARDABLE)');
}

function routeKeyOf(provider, model) {
  return String(provider) + '\n' + String(model);
}

/**
 * Create the deterministic stub-transport token counter. Counts exact
 * UTF-8 bytes via Buffer.byteLength, verified twice per text through
 * the frozen C04 verifier by callers. Frozen shape mirrors the C04
 * counter contract ({ tokenizerFingerprint, countText }).
 */
function createStubTokenizerCounterV2() {
  const counter = {
    tokenizerFingerprint: STUB_TOKENIZER_FINGERPRINT_V1,
    countText(text) {
      if (typeof text !== 'string') {
        throw new Error('model-capability-counter-invalid: stub adapter requires a string');
      }
      return Buffer.byteLength(text, 'utf8');
    },
  };
  return Object.freeze(counter);
}

/**
 * Rebuild a production counter from its fingerprint string (cross-
 * process reconstruction without serializing closures). Only the stub
 * tokenizer is reconstructable. Every other fingerprint fails closed,
 * including the frozen test/logical fingerprints (never production).
 */
function createProductionCounterFromFingerprintV2(fingerprint) {
  if (fingerprint === STUB_TOKENIZER_FINGERPRINT_V1) {
    return createStubTokenizerCounterV2();
  }
  if (fingerprint === tokenizerRegistryV2.TOKENIZER_FINGERPRINT_V1) {
    return tokenizerRegistryV2.createDeepseekV4CounterV2();
  }
  if (REJECTED_PRODUCTION_FINGERPRINTS.indexOf(fingerprint) !== -1) {
    failCapability('tokenizer-not-production', 'fingerprint ' + String(fingerprint).slice(0, 64) + ' is not a production counting authority');
  }
  failCapability('tokenizer-unavailable', 'fingerprint ' + String(fingerprint).slice(0, 64) + ' is not reconstructable');
  return null;
}

/**
 * Validate a caller-supplied capability WITHOUT trusting its claims:
 * exact keys, exact route types, positive integer windows, verified
 * flag true, known source, production (non-rejected) fingerprint, and
 * a live counter whose own fingerprint matches the claim and whose
 * counts verify through the frozen C04 double-count gate on a probe.
 * Returns { valid:true, capability } (frozen) or { valid:false, reason }.
 */
function validateModelCapabilityV2(raw) {
  const invalid = (reason) => ({ valid: false, reason, capability: null });
  if (!isPlainObject(raw)) return invalid('active-model-capability-unknown');
  for (const key of Object.keys(raw)) {
    if (CAPABILITY_EXACT_KEYS.indexOf(key) === -1) return invalid('active-model-capability-unknown');
  }
  if (raw.schemaVersion !== MODEL_CAPABILITY_SCHEMA_VERSION) return invalid('active-model-capability-unknown');
  if (typeof raw.provider !== 'string' || raw.provider === '' || raw.provider.length > 256) {
    return invalid('active-model-capability-unknown');
  }
  if (typeof raw.model !== 'string' || raw.model === '' || raw.model.length > 256) {
    return invalid('active-model-capability-unknown');
  }
  if (!Number.isInteger(raw.maxContextTokens) || raw.maxContextTokens <= 0) {
    return invalid('active-model-capability-unknown');
  }
  if (raw.maxOutputTokens !== null && raw.maxOutputTokens !== undefined
    && (!Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens <= 0)) {
    return invalid('active-model-capability-unknown');
  }
  if (typeof raw.tokenizerFingerprint !== 'string' || raw.tokenizerFingerprint === '') {
    return invalid('active-tokenizer-unavailable');
  }
  if (REJECTED_PRODUCTION_FINGERPRINTS.indexOf(raw.tokenizerFingerprint) !== -1) {
    return invalid('active-tokenizer-unavailable');
  }
  if (raw.verified !== true) return invalid('active-model-capability-unknown');
  if (CAPABILITY_SOURCES.indexOf(raw.source) === -1) return invalid('active-model-capability-unknown');
  if (raw.capabilityRevision !== MODEL_CAPABILITY_REVISION_V1) return invalid('active-model-capability-unknown');
  let framing = null;
  if (raw.framing !== undefined && raw.framing !== null) {
    if (!isPlainObject(raw.framing)) return invalid('active-model-capability-unknown');
    for (const key of Object.keys(raw.framing)) {
      if (FRAMING_EXACT_KEYS.indexOf(key) === -1) return invalid('active-model-capability-unknown');
    }
    if (typeof raw.framing.revision !== 'string' || raw.framing.revision === '') return invalid('active-model-capability-unknown');
    if (typeof raw.framing.templateDigest !== 'string' || raw.framing.templateDigest === '') return invalid('active-model-capability-unknown');
    if (raw.framing.revision !== tokenizerRegistryV2.FRAMING_REVISION_V1) return invalid('active-model-capability-unknown');
    let pinnedDigest = null;
    try {
      pinnedDigest = tokenizerRegistryV2.templateConfigDigestV2();
    } catch (error) {
      return invalid('active-tokenizer-unavailable');
    }
    if (raw.framing.templateDigest !== pinnedDigest) return invalid('active-model-capability-unknown');
    framing = Object.freeze({ revision: raw.framing.revision, templateDigest: raw.framing.templateDigest });
  }
  const counterCheck = counterV2.validateContextTokenCounterV2(raw.tokenCounter);
  if (!counterCheck.valid || counterCheck.fingerprint !== raw.tokenizerFingerprint) {
    return invalid('active-tokenizer-unavailable');
  }
  // Liveness probe: the bound counter must count deterministically now.
  try {
    counterV2.countTextVerifiedV2(raw.tokenCounter, 'capability-probe:\u00e9\uD83D\uDE00');
  } catch {
    return invalid('active-tokenizer-unavailable');
  }
  return {
    valid: true,
    reason: null,
    capability: Object.freeze({
      schemaVersion: raw.schemaVersion,
      provider: raw.provider,
      model: raw.model,
      maxContextTokens: raw.maxContextTokens,
      maxOutputTokens: raw.maxOutputTokens === undefined ? null : raw.maxOutputTokens,
      tokenizerFingerprint: raw.tokenizerFingerprint,
      tokenCounter: raw.tokenCounter,
      source: raw.source,
      verified: true,
      capabilityRevision: raw.capabilityRevision,
      framing,
    }),
  };
}

function readRegistryDocument(installRoot) {
  try {
    if (typeof installRoot !== 'string' || installRoot === '') return null;
    const registryPath = path.join(path.resolve(String(installRoot)), 'config', 'model-registry.json');
    const text = fs.readFileSync(registryPath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > POLICY_FILE_BOUND_BYTES) return null;
    const document = JSON.parse(text);
    if (!isPlainObject(document) || !Array.isArray(document.models)) return null;
    return document;
  } catch {
    return null;
  }
}

/**
 * Build an explicit stub-verified capability for a stub-transport
 * route (tests and offline host proof). The caller asserts the window;
 * the tokenizer is the verified stub authority. NEVER used for real
 * provider routes (exact-pair registration is the caller's claim, and
 * callers must only register stub transports here).
 */
function createStubTestCapabilityV2(input) {
  if (!isPlainObject(input)) failCapability('capability-input-invalid', 'input must be an object');
  const provider = input.provider;
  const model = input.model;
  const maxContextTokens = input.maxContextTokens;
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    failCapability('capability-input-invalid', 'stub route requires an exact provider/model pair');
  }
  if (!Number.isInteger(maxContextTokens) || maxContextTokens <= 0) {
    failCapability('capability-input-invalid', 'stub route requires a positive maxContextTokens');
  }
  let maxOutputTokens = input.maxOutputTokens === undefined ? null : input.maxOutputTokens;
  if (maxOutputTokens !== null && (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    failCapability('capability-input-invalid', 'maxOutputTokens must be a positive integer or omitted');
  }
  const built = {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    provider,
    model,
    maxContextTokens,
    maxOutputTokens,
    tokenizerFingerprint: STUB_TOKENIZER_FINGERPRINT_V1,
    tokenCounter: createStubTokenizerCounterV2(),
    source: 'stub-verified',
    verified: true,
    capabilityRevision: MODEL_CAPABILITY_REVISION_V1,
    framing: null,
  };
  const check = validateModelCapabilityV2(built);
  if (!check.valid) failCapability('capability-input-invalid', check.reason);
  return check.capability;
}

/**
 * Resolve the capability for an ALREADY-SELECTED route. Closed-world
 * exact lookup only; never branches on provider/model names.
 *
 * Input (exact keys): { provider, model, installRoot?, supportedRoutes? }
 *   supportedRoutes: optional array of { provider, model,
 *     maxContextTokens, maxOutputTokens? } explicitly registering
 *     stub-verified routes (exact pairs; test/host injection only).
 *
 * Resolution:
 *   exact pair in supportedRoutes -> stub-verified capability (valid).
 *   exact pair in the production tokenizer registry AND the same
 *     exact pair in model-registry (window + tokenizer bound to ONE
 *     route) -> verified production capability (valid, framed).
 *   exact model-registry entry without a verified tokenizer
 *     -> { valid:false, reason:'active-tokenizer-unavailable' }
 *     with the authoritative window attached (windowKnown:true).
 *   anything else -> { valid:false,
 *     reason:'active-model-capability-unknown' }.
 *
 * Never throws for unknown routes (fallback is the honest answer).
 */
function resolveModelCapabilityV2(input) {
  const unknown = (reason, extra) => Object.freeze(Object.assign({
    valid: false, reason, capability: null, windowKnown: false, maxContextTokens: null,
  }, extra || {}));
  try {
    if (!isPlainObject(input)) return unknown('active-model-capability-unknown');
    for (const key of Object.keys(input)) {
      if (['provider', 'model', 'installRoot', 'supportedRoutes'].indexOf(key) === -1) {
        return unknown('active-model-capability-unknown');
      }
    }
    const provider = input.provider;
    const model = input.model;
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return unknown('active-model-capability-unknown');
    }
    const wanted = routeKeyOf(provider, model);
    const supported = Array.isArray(input.supportedRoutes) ? input.supportedRoutes : [];
    for (const entry of supported) {
      if (!isPlainObject(entry) || typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue;
      if (routeKeyOf(entry.provider, entry.model) !== wanted) continue;
      if (!Number.isInteger(entry.maxContextTokens) || entry.maxContextTokens <= 0) continue;
      let maxOutputTokens = entry.maxOutputTokens === undefined ? null : entry.maxOutputTokens;
      if (maxOutputTokens !== null && (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)) continue;
      try {
        const capability = createStubTestCapabilityV2({
          provider, model,
          maxContextTokens: entry.maxContextTokens,
          maxOutputTokens,
        });
        return Object.freeze({
          valid: true, reason: null, capability, windowKnown: true, maxContextTokens: capability.maxContextTokens,
        });
      } catch {
        return unknown('active-model-capability-unknown');
      }
    }
    // Registry capacity lookup: exact model identity only (entry id or
    // entry model field), provider binding must be compatible where the
    // registry declares one. This is capacity truth, never a tokenizer.
    const document = readRegistryDocument(input.installRoot);
    if (document !== null) {
      for (const entry of document.models) {
        if (!isPlainObject(entry)) continue;
        const entryModel = typeof entry.model === 'string' ? entry.model : null;
        const entryId = typeof entry.id === 'string' ? entry.id : null;
        if (model !== entryModel && model !== entryId) continue;
        const entryProvider = typeof entry.provider === 'string' ? entry.provider : null;
        const entryProviders = isPlainObject(entry.providers) ? entry.providers : null;
        let providerCompatible = false;
        if (entryProvider !== null && provider === entryProvider) providerCompatible = true;
        if (entryProviders !== null) {
          for (const key of Object.keys(entryProviders)) {
            if (entryProviders[key] === provider) providerCompatible = true;
          }
        }
        if (providerCompatible !== true) continue;
        if (Number.isInteger(entry.contextWindow) && entry.contextWindow > 0) {
          // Same exact route in the production tokenizer registry:
          // window and tokenizer belong to ONE verified route.
          const production = tokenizerRegistryV2.resolveProductionTokenizerV2({ provider, model });
          if (production !== null) {
            try {
              const counter = production.createCounter();
              const registryMaxOutput = Number.isInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0
                ? entry.maxOutputTokens : null;
              const built = {
                schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
                provider,
                model,
                maxContextTokens: entry.contextWindow,
                maxOutputTokens: registryMaxOutput,
                tokenizerFingerprint: production.tokenizerFingerprint,
                tokenCounter: counter,
                source: production.source,
                verified: true,
                capabilityRevision: MODEL_CAPABILITY_REVISION_V1,
                framing: Object.freeze({
                  revision: production.framingRevision,
                  templateDigest: tokenizerRegistryV2.templateConfigDigestV2(),
                }),
              };
              const check = validateModelCapabilityV2(built);
              if (check.valid) {
                return Object.freeze({
                  valid: true, reason: null, capability: check.capability,
                  windowKnown: true, maxContextTokens: check.capability.maxContextTokens,
                });
              }
            } catch (error) {
              void error;
            }
          }
          // Capacity is known and authoritative; no verified tokenizer
          // is registered for this exact route.
          return unknown('active-tokenizer-unavailable', {
            windowKnown: true, maxContextTokens: entry.contextWindow,
          });
        }
        return unknown('active-model-capability-unknown');
      }
    }
    return unknown('active-model-capability-unknown');
  } catch {
    return unknown('active-model-capability-unknown');
  }
}

/**
 * Secret-safe capability summary (diagnostics only): route, window,
 * fingerprint, source, revision. Never a counter closure detail.
 */
function describeModelCapabilityV2(capability) {
  const check = validateModelCapabilityV2(capability);
  if (!check.valid) return Object.freeze({ valid: false, reason: check.reason });
  const value = check.capability;
  return Object.freeze({
    valid: true,
    provider: value.provider,
    model: value.model,
    maxContextTokens: value.maxContextTokens,
    maxOutputTokens: value.maxOutputTokens,
    tokenizerFingerprint: value.tokenizerFingerprint,
    source: value.source,
    capabilityRevision: value.capabilityRevision,
    framing: value.framing,
  });
}

module.exports = {
  MODEL_CAPABILITY_SCHEMA_VERSION,
  MODEL_CAPABILITY_REVISION_V1,
  MODEL_CAPABILITY_DIGEST_DOMAIN_V1,
  STUB_TOKENIZER_FINGERPRINT_V1,
  REJECTED_PRODUCTION_FINGERPRINTS,
  STUB_TOKEN_VECTORS_V1,
  CAPABILITY_EXACT_KEYS,
  CAPABILITY_SOURCES,
  FRAMING_EXACT_KEYS,
  createStubTokenizerCounterV2,
  createProductionCounterFromFingerprintV2,
  validateModelCapabilityV2,
  createStubTestCapabilityV2,
  resolveModelCapabilityV2,
  describeModelCapabilityV2,
};
