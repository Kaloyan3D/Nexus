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
 * options: { installRoot, dataRoot, taskInstanceId, sessionId, role? }
 *   sessionId is the Controller attempt session (required, non-empty).
 * deps: { service?, compiled? } — a live service or a precompiled issuance
 *   (tests inject compiled fixtures shaped like native-issuer output).
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
    },
  };
}

module.exports = {
  TARGET_EXTENSION_VERSION: TARGET_EXTENSION_VERSION,
  DIALECT_RESPONSE_PATHS: DIALECT_RESPONSE_PATHS,
  issueExecutionTargetV2: issueExecutionTargetV2,
};
