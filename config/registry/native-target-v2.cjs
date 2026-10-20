'use strict';

/**
 * A2.3 Registry-issued ExecutionTargetV2 — authoritative extension over the
 * sealed V1 core. The ONLY model authority stays the Registry: every field
 * below derives from trusted Registry configuration (compiled binding plus
 * effective-snapshot records) or from the Controller attempt session passed
 * explicitly by the caller. Nothing is invented, defaulted, or fallen back.
 *
 * Initial scope mirrors native-issuer.cjs: mode 'engineering-v2', role
 * 'muse_main', executionKind 'raw-model' only. Anything else fails closed.
 *
 * Field provenance:
 *   endpoint.origin/path/protocol/method  provider.baseUrl + dialect path map
 *   endpoint.localLoopback                loopback-host check (http allows loopback only)
 *   remoteModelIdConfirmed/reasoningEffort compiled binding (must equal core)
 *   billing.tier                          provider/connection metadata.billingTier (explicit config)
 *   billing.dataUse                       model.dataUseTier (or binding passthrough)
 *   session.sessionId                     caller-supplied Controller attempt session (required)
 *   capabilities                          binding.requiredCapabilities (role-scoped, non-empty)
 *   contextLimitTokens                    model.contextWindow (positive, required)
 *   outputLimitTokens                     route.capacityConstraints.maxOutputTokens or model.maxOutputTokens
 *   connectionBinding                     binding.connectionId
 *   credentialRef                         connection.credentialRef (reference only, never a secret)
 *
 * The emitted extension JSON uses the exact camelCase contract consumed by
 * nexus-model ExecutionTargetV2::from_extension_json (extensionVersion,
 * endpoint{protocol,origin,path,method,localLoopback}, remoteModelIdConfirmed,
 * reasoningEffort, billing{tier,dataUse}, session{sessionId}, capabilities,
 * contextLimitTokens, outputLimitTokens, connectionBinding, credentialRef).
 * extensionDigest is sha256(canonical(extension)) and MUST equal the Rust
 * extension_digest() byte-for-byte (pinned by the E2E harness).
 */

const issuer = require('./native-issuer.cjs');

const TARGET_EXTENSION_VERSION = 1;
const MAX_URL_LENGTH = 2048;

const DIALECT_RESPONSE_PATHS = Object.freeze({
  'openai-responses': '/v1/responses',
  'local-openai-compatible': '/v1/responses',
});

function fail(code, message) {
  return { ok: false, code: code, message: message, target: null };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

function findById(list, id) {
  if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (e && e.id === id) return e;
  }
  return null;
}

function stripTrailingSlashes(s) {
  return String(s).replace(/\/+$/, '');
}

function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.indexOf('127.') === 0;
}

function splitBaseUrl(baseUrl) {
  if (!isNonEmptyString(baseUrl) || baseUrl.length > MAX_URL_LENGTH) return null;
  let parsed = null;
  try {
    parsed = new URL(String(baseUrl));
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (!isNonEmptyString(parsed.hostname)) return null;
  const port = parsed.port !== '' ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const origin = parsed.protocol + '//' + parsed.hostname + (parsed.port !== '' ? ':' + parsed.port : '');
  return { protocol: parsed.protocol.slice(0, -1), origin: origin, basePath: stripTrailingSlashes(parsed.pathname || ''), host: parsed.hostname };
}

// The dialect path carries its own version segment ('/v1/responses'). A
// provider baseUrl that already ends in '/v1' (the OpenAI convention) must
// not double it: the executed path has to equal the probed path.
function endpointPath(basePath, dialectPath) {
  const base = basePath === '' ? '' : basePath;
  if (/\/v1$/.test(base) && dialectPath.indexOf('/v1/') === 0) {
    return base + dialectPath.slice('/v1'.length);
  }
  return base + dialectPath;
}

function billingTierOf(provider, connection) {
  const c = connection && connection.metadata && connection.metadata.billingTier;
  if (isNonEmptyString(c)) return c;
  const p = provider && provider.metadata && provider.metadata.billingTier;
  if (isNonEmptyString(p)) return p;
  return '';
}

function positiveInt(v) {
  return Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * Issue the authoritative V2 extension for one Controller generation.
 *
 * options: { installRoot, dataRoot, taskInstanceId, sessionId, role?, selection? }
 *   sessionId is the Controller attempt session (required, non-empty).
 *   selection is an optional { logicalModelId, routeId } override: it is
 *   applied to an IN-MEMORY clone of the saved engineering-v2 mode
 *   configuration (the saved configuration is never written) and compiled
 *   through the same trusted pipeline. Absent selection behaves exactly as
 *   before; a present selection is covered by the snapshot/target/issuance
 *   digests because the compiled snapshot and mode config carry it.
 * deps: { service?, compiled? } — a live service or a precompiled issuance
 *   (tests inject compiled fixtures shaped like native-issuer output).
 *   An injected compiled fixture cannot be combined with a selection.
 */
function issueExecutionTargetV2(options, deps) {
  const o = options || {};
  const d = deps || {};
  const sessionId = isNonEmptyString(o.sessionId) ? o.sessionId : '';
  if (sessionId === '') return fail('registry-target-incomplete', 'a Controller attempt sessionId is required to bind the V2 session');
  if (/[\x00-\x20\x7F]/.test(sessionId) || /[^\x20-\x7E]/.test(sessionId)) {
    return fail('registry-target-incomplete', 'sessionId carries characters forbidden on the wire');
  }
  const taskInstanceId = isNonEmptyString(o.taskInstanceId) ? o.taskInstanceId : '';
  if (taskInstanceId === '') return fail('registry-binding-invalid', 'a task generation identity is required to bind the issuance');
  let service = d.service || null;
  if (!service && (typeof o.installRoot !== 'string' || typeof o.dataRoot !== 'string')) {
    return fail('registry-host-missing', 'installRoot and dataRoot (or an injected service) are required');
  }
  if (!service) {
    const serviceModule = require('./service.cjs');
    try {
      service = serviceModule.createService({ installRoot: o.installRoot, dataRoot: o.dataRoot });
    } catch (e) {
      return fail('registry-unavailable', 'registry service could not be created: ' + String((e && e.message) || e));
    }
  }
  let compiled = d.compiled || null;
  const selection = o.selection !== undefined && o.selection !== null ? o.selection : null;
  if (selection !== null && compiled !== null) {
    return fail('registry-binding-invalid', 'an injected compilation cannot be combined with a selection; refusing to issue');
  }
  if (selection !== null) {
    compiled = compileWithSelection(service, selection);
    if (!compiled || compiled.ok !== true) {
      return fail(compiled && compiled.code ? compiled.code : 'registry-unresolved', (compiled && compiled.message) || 'selection does not compile');
    }
    compiled = compiled.compiled;
  }
  if (!compiled) {
    compiled = issuer.compileTrustedMode({ installRoot: o.installRoot, dataRoot: o.dataRoot, modeId: 'engineering-v2', role: o.role || 'muse_main' }, { service: service });
  }
  if (!compiled || compiled.ok !== true) {
    return fail(compiled && compiled.code ? compiled.code : 'registry-unresolved', (compiled && compiled.message) || 'no trusted compilation to extend');
  }
  const issued = issuer.issueForGeneration(compiled, taskInstanceId);
  if (!issued || issued.ok !== true) {
    return fail(issued.code, issued.message);
  }
  const binding = compiled.binding;
  const snapshot = compiled.snapshot;
  let eff = null;
  try {
    eff = service.effectiveSnapshot();
  } catch (e) {
    return fail('registry-unavailable', 'effective snapshot is unreadable: ' + String((e && e.message) || e));
  }
  if (!eff || !eff.snapshot) {
    const codes = ((eff && eff.errors) || []).map(function (e) { return e && e.code; }).join(',');
    return fail('registry-unresolved', 'effective snapshot is unresolved (' + codes + '); refusing to extend');
  }
  const records = eff.snapshot;
  const provider = findById(records.providers, binding.providerId);
  const connection = binding.connectionId ? findById(records.connections, binding.connectionId) : null;
  const model = findById(records.models, binding.logicalModelId);
  const route = findById(records.routes, binding.routeId);
  if (!provider) return fail('registry-target-incomplete', 'provider ' + binding.providerId + ' is absent from the effective snapshot');
  if (!connection) return fail('registry-target-incomplete', 'connection ' + binding.connectionId + ' is absent from the effective snapshot');
  if (!model) return fail('registry-target-incomplete', 'model ' + binding.logicalModelId + ' is absent from the effective snapshot');
  if (!route) return fail('registry-target-incomplete', 'route ' + binding.routeId + ' is absent from the effective snapshot');
  if (connection.status === 'disabled') return fail('registry-target-unauthorized', 'connection ' + connection.id + ' is disabled; refusing to issue');
  if (connection.providerId !== provider.id) return fail('registry-target-unauthorized', 'connection ' + connection.id + ' belongs to provider ' + connection.providerId + ', not ' + provider.id);
  const split = splitBaseUrl(provider.baseUrl);
  if (!split) return fail('registry-target-incomplete', 'provider ' + provider.id + ' carries no usable https/http baseUrl');
  const dialectPath = DIALECT_RESPONSE_PATHS[binding.protocolId];
  if (!dialectPath) return fail('registry-target-incomplete', 'protocol dialect ' + binding.protocolId + ' has no Responses path mapping; refusing to invent one');
  if (split.protocol === 'http' && !isLoopbackHost(split.host)) {
    return fail('registry-target-incomplete', 'plaintext http endpoints are allowed only for loopback-local testbeds');
  }
  const tier = billingTierOf(provider, connection);
  if (tier === '') return fail('registry-target-incomplete', 'no billingTier in provider/connection metadata; billing is unknown and the target is not executable');
  const dataUse = typeof model.dataUseTier === 'string' && model.dataUseTier !== '' ? model.dataUseTier : (typeof binding.dataUseTier === 'string' ? binding.dataUseTier : null);
  if (!isNonEmptyString(dataUse)) return fail('registry-target-incomplete', 'no data-use tier on model or binding; data-use provenance is required');
  const caps = Array.isArray(binding.requiredCapabilities) ? binding.requiredCapabilities.slice().sort() : [];
  if (caps.length === 0 || caps.some(function (c) { return !isNonEmptyString(c); })) {
    return fail('registry-target-incomplete', 'role binding carries no authoritative capability set');
  }
  const context = positiveInt(model.contextWindow);
  if (context === 0) return fail('registry-target-incomplete', 'model ' + model.id + ' states no contextWindow; context is unknown, never infinite');
  const routeMax = route.capacityConstraints && route.capacityConstraints.maxOutputTokens;
  const output = positiveInt(routeMax) || positiveInt(model.maxOutputTokens);
  if (output === 0) return fail('registry-target-incomplete', 'no output limit on route or model; output is unbounded and refused');
  if (!isNonEmptyString(connection.credentialRef)) {
    return fail('registry-target-incomplete', 'connection ' + connection.id + ' carries no credential reference; binding is impossible');
  }
  const extension = {
    extensionVersion: TARGET_EXTENSION_VERSION,
    endpoint: {
      protocol: split.protocol,
      origin: split.origin,
      path: endpointPath(split.basePath, dialectPath),
      method: 'POST',
      localLoopback: isLoopbackHost(split.host),
    },
    remoteModelIdConfirmed: binding.remoteModelId,
    reasoningEffort: binding.reasoning,
    billing: { tier: tier, dataUse: dataUse },
    session: { sessionId: sessionId },
    capabilities: caps,
    contextLimitTokens: context,
    outputLimitTokens: output,
    connectionBinding: binding.connectionId,
    credentialRef: connection.credentialRef,
  };
  // Optional provider-declared wire profile (A5.4). Emitted ONLY when set so
  // every pre-existing target digest is unchanged; Rust validates the value.
  const wire = provider.metadata && provider.metadata.wireProfile;
  if (wire !== undefined && wire !== null) {
    if (wire !== 'opencode-go-responses') return fail('registry-target-incomplete', 'provider ' + provider.id + ' declares an unknown wireProfile');
    extension.wireProfile = wire;
  }
  const core = issued.issuance.resolution.target;
  if (extension.remoteModelIdConfirmed !== core.remoteModelId
    || extension.reasoningEffort !== core.reasoning
    || extension.connectionBinding !== core.connectionId) {
    return fail('registry-target-unauthorized', 'extension confirmation drifts from the sealed core identity; refusing to issue');
  }
  const extensionDigest = issuer.canonicalSha256(extension);
  // EM-02: the immutable task binding (everything but the effort, plus the route's declared
  // reasoning levels at issuance). Additive: the issuance and extension above are unchanged.
  const taskBinding = require('./native-task-binding.cjs').buildTaskBinding({ issuance: issued.issuance, extension: extension }, route);
  if (!taskBinding.ok) return fail(taskBinding.code, taskBinding.message);
  return {
    ok: true,
    code: null,
    message: null,
    target: {
      schemaVersion: 1,
      extensionVersion: TARGET_EXTENSION_VERSION,
      core: core,
      extension: extension,
      extensionDigest: extensionDigest,
      issuance: issued.issuance,
      snapshot: snapshot,
      taskInstanceId: taskInstanceId,
      sessionId: sessionId,
      taskBinding: taskBinding.binding,
      taskBindingDigest: taskBinding.bindingDigest,
    },
  };
}

/**
 * Compile the trusted engineering-v2/muse_main pipeline with an in-memory
 * main-slot override. The saved mode configuration is only read, never
 * written: the override applies to a deep clone. Unknown or non-issuable
 * selections fail closed with the catalog machine reason.
 */
function compileWithSelection(service, selection) {
  const sel = selection || {};
  const logicalModelId = isNonEmptyString(sel.logicalModelId) ? sel.logicalModelId : '';
  const routeId = isNonEmptyString(sel.routeId) ? sel.routeId : '';
  if (logicalModelId === '' || routeId === '') {
    return fail('registry-selection-not-issuable', 'selection carries no usable logicalModelId/routeId pair: unknown-target');
  }
  let eff = null;
  try {
    eff = service.effectiveSnapshot();
  } catch (e) {
    return fail('registry-unavailable', 'effective snapshot is unreadable: ' + String((e && e.message) || e));
  }
  if (!eff || !eff.snapshot) {
    return fail('registry-unresolved', 'effective snapshot is unresolved; refusing to select');
  }
  const records = eff.snapshot;
  const route = findById(records.routes, routeId);
  if (!route || route.logicalModelId !== logicalModelId) {
    return fail('registry-selection-not-issuable', 'selection ' + logicalModelId + '/' + routeId + ' names no known route: unknown-target');
  }
  const gate = catalogIssuability({
    route: route,
    model: findById(records.models, route.logicalModelId),
    provider: findById(records.providers, route.providerId),
    connection: route.connectionId ? findById(records.connections, route.connectionId) : null,
  });
  if (gate.issuable !== true) {
    return fail('registry-selection-not-issuable', 'selection ' + logicalModelId + '/' + routeId + ' is not issuable: ' + (gate.reason || 'not-issuable'));
  }
  let staged = null;
  try {
    staged = service.getModeConfiguration('engineering-v2', {});
  } catch (e) {
    return fail('registry-unavailable', 'effective mode configuration is unreadable: ' + String((e && e.message) || e));
  }
  if (!staged || !staged.result || !staged.result.config) {
    return fail('registry-unresolved', 'effective mode configuration for engineering-v2 is unresolved; refusing to select');
  }
  const modeConfig = JSON.parse(JSON.stringify(staged.result.config));
  const current = (modeConfig.slots && modeConfig.slots.main) || {};
  modeConfig.slots = modeConfig.slots || {};
  modeConfig.slots.main = {
    logicalModelId: logicalModelId,
    routeId: routeId,
    reasoning: isNonEmptyString(current.reasoning) ? current.reasoning : (Array.isArray(route.reasoningLevels) && isNonEmptyString(route.reasoningLevels[0]) ? route.reasoningLevels[0] : current.reasoning),
  };
  // EM-02: the operator's reasoning policy was written for the saved assignment; it applies to a
  // selection only when the selection IS that assignment. Any other model gets the default only.
  if (Array.isArray(current.allowedReasoning) && current.logicalModelId === logicalModelId && current.routeId === routeId) {
    modeConfig.slots.main.allowedReasoning = current.allowedReasoning.slice();
  }
  if (modeConfig.roleOverrides && modeConfig.roleOverrides.muse_main) {
    delete modeConfig.roleOverrides.muse_main;
  }
  let preview = null;
  try {
    preview = service.compilePreview(modeConfig);
  } catch (e) {
    return fail('registry-unavailable', 'registry compilation failed: ' + String((e && e.message) || e));
  }
  if (!preview || preview.ok !== true || !preview.snapshot) {
    const codes = ((preview && preview.errors) || []).map(function (e) { return e && e.code; }).join(',');
    const detail = ((preview && preview.errors) || []).map(function (e) { return e && e.message; }).join('; ');
    return fail(codes.split(',')[0] || 'registry-unresolved', 'selection ' + logicalModelId + '/' + routeId + ' does not compile (' + codes + '): ' + detail);
  }
  const snapshot = preview.snapshot;
  const binding = snapshot.roles && snapshot.roles.muse_main;
  if (!binding || typeof binding !== 'object') {
    return fail('registry-role-unauthorized', 'role muse_main has no compiled binding for the selection; refusing to issue');
  }
  return {
    ok: true,
    compiled: {
      ok: true, code: null, message: null, issuance: null,
      snapshot: snapshot, binding: binding, modeConfig: modeConfig,
      persisted: false,
      configRevision: staged.result.revision != null ? staged.result.revision : modeConfig.revision,
    },
  };
}

function catalogIssuability(input) {
  const r = input || {};
  const route = r.route || null;
  const model = r.model || null;
  const provider = r.provider || null;
  const connection = r.connection || null;
  if (!route) return { issuable: false, reason: 'unknown-route' };
  if (!model) return { issuable: false, reason: 'unknown-model' };
  if (!provider) return { issuable: false, reason: 'unknown-provider' };
  if (model.enabled === false) return { issuable: false, reason: 'model-disabled' };
  if (provider.status !== 'enabled') return { issuable: false, reason: 'provider-disabled' };
  const resolver = require('./resolver.cjs');
  const routeGate = resolver.routeEligibility(route);
  if (routeGate) return { issuable: false, reason: routeGate.code || 'route-not-verified' };
  if (route.logicalModelId !== model.id) return { issuable: false, reason: 'route-model-identity-mismatch' };
  if (route.providerId !== provider.id) return { issuable: false, reason: 'route-provider-mismatch' };
  if (!connection) return { issuable: false, reason: 'connection-not-connected' };
  const connGate = resolver.connectionEligibility(connection);
  if (connGate) return { issuable: false, reason: 'connection-not-connected' };
  if (connection.providerId !== provider.id) return { issuable: false, reason: 'connection-not-connected' };
  const protocolId = (route.compatibility && route.compatibility.transport) || 'unknown';
  if (!DIALECT_RESPONSE_PATHS[protocolId]) return { issuable: false, reason: 'protocol-unsupported' };
  if (!isNonEmptyString(connection.credentialRef)) return { issuable: false, reason: 'no-credential-ref' };
  const split = splitBaseUrl(provider.baseUrl);
  if (!split) return { issuable: false, reason: 'protocol-unsupported' };
  if (split.protocol === 'http' && !isLoopbackHost(split.host)) return { issuable: false, reason: 'protocol-unsupported' };
  if (positiveInt(model.contextWindow) === 0) return { issuable: false, reason: 'context-unknown' };
  const routeMax = route.capacityConstraints && route.capacityConstraints.maxOutputTokens;
  if (positiveInt(routeMax) === 0 && positiveInt(model.maxOutputTokens) === 0) return { issuable: false, reason: 'output-unknown' };
  if (billingTierOf(provider, connection) === '') return { issuable: false, reason: 'no-billing-tier' };
  const dataUse = typeof model.dataUseTier === 'string' && model.dataUseTier !== '' ? model.dataUseTier : null;
  if (!isNonEmptyString(dataUse)) return { issuable: false, reason: 'no-data-use' };
  return { issuable: true, reason: null };
}

module.exports = {
  TARGET_EXTENSION_VERSION: TARGET_EXTENSION_VERSION,
  DIALECT_RESPONSE_PATHS: DIALECT_RESPONSE_PATHS,
  issueExecutionTargetV2: issueExecutionTargetV2,
  catalogIssuability: catalogIssuability,
  splitBaseUrl: splitBaseUrl,
  billingTierOf: billingTierOf,
  positiveInt: positiveInt,
  isLoopbackHost: isLoopbackHost,
  endpointPath: endpointPath,
};
