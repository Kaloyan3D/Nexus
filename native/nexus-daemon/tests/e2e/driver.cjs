'use strict';
// A2.3 mock-E2E fixture driver: REAL Registry/service/issuer/intent code
// against a fixture dataRoot. Subcommands print one JSON line to stdout.
// No network, no credentials, no writes outside the given directories.
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const serviceModule = require(path.join(REPO, 'config', 'registry', 'service.cjs'));
const issuer = require(path.join(REPO, 'config', 'registry', 'native-issuer.cjs'));
const v2 = require(path.join(REPO, 'config', 'registry', 'native-target-v2.cjs'));
const shadowIntent = require(path.join(REPO, 'config', 'registry', 'native-shadow-intent.cjs'));
const dispatchIntent = require(path.join(REPO, 'config', 'registry', 'native-dispatch-intent.cjs'));

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function makeService(installRoot, dataRoot) {
  return serviceModule.createService({ installRoot: installRoot, dataRoot: dataRoot });
}

// EM-04C2 S4 fixtures: the Registry CODE of an install root (its mode definitions are read next to
// the module), so a fixture install root that activates a mode is honoured by the same code the
// broker's bridge runs. Falls back to this repository's own modules for the repository root.
function registryOf(installRoot) {
  const base = path.join(String(installRoot), 'config', 'registry');
  return {
    service: require(path.join(base, 'service.cjs')),
    v2: require(path.join(base, 'native-target-v2.cjs')),
  };
}

function probeText(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function () { return 'text/event-stream'; } },
    json: async function () { throw new Error('no json'); },
    text: async function () { return text; }
  };
}

function probeJson(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function () { return 'application/json'; } },
    json: async function () { return JSON.parse(body); },
    text: async function () { return body; }
  };
}

async function probeFetch(url, init) {
  try {
    process.stderr.write("PROBE " + ((init && init.method) || "GET") + " " + String(url) + " " + String((init && init.body) || "").slice(0, 160) + "\n");
  } catch (ignored) {}
  const u = String(url);
  const method = (init && init.method) || 'GET';
  if (method === 'GET' && u.indexOf('/models') !== -1) {
    return probeJson(200, JSON.stringify({ data: [{ id: 'e2e-mock-model' }, { id: 'e2e-mock-model-2' }] }));
  }
  if (method === 'POST' && u.indexOf('/responses') !== -1) {
    let effort = 'low';
    try {
      const incoming = JSON.parse(String((init && init.body) || '{}'));
      if (incoming && incoming.reasoning && typeof incoming.reasoning.effort === 'string') effort = incoming.reasoning.effort;
    } catch (ignored) {}
    try {
      const inc2 = JSON.parse(String((init && init.body) || '{}'));
      if (inc2 && Array.isArray(inc2.tools) && inc2.tools.length > 0) {
        const nm = inc2.tools[0].name || 'probe_echo';
        return probeJson(200, JSON.stringify({ status: 'completed', reasoning: { effort: effort }, output: [{ type: 'function_call', id: 'fc_probe_1', call_id: 'call_probe_1', name: nm, arguments: '{"word":"probe-ok"}' }] }));
      }
      if (inc2 && Array.isArray(inc2.input) && inc2.input.length > 0 && inc2.input[0].type === 'function_call_output') {
        return probeJson(200, JSON.stringify({ status: 'completed', reasoning: { effort: effort }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] }));
      }
      if (inc2 && inc2.stream === true) {
        return probeText(200, 'data: {"type":"response.output_text.delta","delta":"probe-ok"}' + "\n\n" + 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}' + "\n\n" + 'data: [DONE]' + "\n\n");
      }
    } catch (ignoredS) {}
    return probeJson(200, JSON.stringify({ status: 'completed', reasoning: { effort: effort }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] }));
  }
  if (false) {
    return probeJson(200, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'probe-ok' }] }] }));
  }
  if (method === 'POST' && u.indexOf('/chat/completions') !== -1) {
    let effort = 'low';
    try {
      const incoming = JSON.parse(String((init && init.body) || '{}'));
      if (incoming && typeof incoming.reasoning_effort === 'string') effort = incoming.reasoning_effort;
    } catch (ignored) {}
    let wantStream = false;
    try {
      const incomingStream = JSON.parse(String((init && init.body) || '{}'));
      if (incomingStream && incomingStream.stream === true) wantStream = true;
    } catch (ignoredStream) {}
    let toolName = null;
    try {
      const incomingTools = JSON.parse(String((init && init.body) || '{}'));
      const tools = incomingTools && incomingTools.tools;
      if (Array.isArray(tools) && tools.length > 0 && tools[0] && tools[0].function && typeof tools[0].function.name === 'string') toolName = tools[0].function.name;
    } catch (ignoredTools) {}
    if (toolName !== null) {
      return probeJson(200, JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_probe_1', type: 'function', function: { name: toolName, arguments: '{"word":"probe-ok"}' } }] }, finish_reason: 'tool_calls' }], reasoning_effort: effort }));
    }
    if (wantStream) {
      return probeText(200, 'data: {"choices":[{"delta":{"content":"probe-ok"}}],"usage":{"prompt_tokens":1}}' + "\n\n" + 'data: [DONE]' + "\n\n");
    }
    return probeJson(200, JSON.stringify({ choices: [{ message: { content: 'probe-ok' } }], reasoning_effort: effort }));
  }
  if (false) {
    return probeJson(200, JSON.stringify({ choices: [{ message: { content: 'probe-ok' } }] }));
  }
  return probeJson(404, '{}');
}


async function cmdRegistry(args) {
  const dataRoot = args[0];
  const installRoot = args[1];
  const port = Number(args[2]);
  // A5.2: optional explicit provider base URL / dialect (default: loopback fixture).
  const baseUrlArg = args[3] || ('http://127.0.0.1:' + port);
  const transportArg = args[4] || 'local-openai-compatible';
  // A5.5: optional wire profile declared by the provider (e.g. opencode-go-responses).
  const wireProfileArg = args[5] || '';
  const fail = function (where, result) { console.error("SAVE_DEBUG " + JSON.stringify(result).slice(0, 600));
    emit({ ok: false, where: where, code: result.code, message: result.message });
    process.exitCode = 1;
  };
  const service = makeService(installRoot, dataRoot);
  let r = service.saveProvider({ id: 'e2e-mock', name: 'E2E Mock', transportId: transportArg, baseUrl: baseUrlArg, authType: 'api-key', metadata: Object.assign({ billingTier: 'e2e-unmetered-test' }, wireProfileArg ? { wireProfile: wireProfileArg } : {}) }, {});
  if (!r.ok) return fail('provider', r);
  r = service.saveModel({ id: 'e2e/e2e-1', vendor: 'E2E', displayName: 'E2E Mock', checkpoint: 'e2e-1', capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true }, dataUseTier: 'contributor', contextWindow: 1000000, maxOutputTokens: 1024, enabled: true, engines: ['muse-v0'] }, {});
  if (!r.ok) return fail('model', r);
  r = service.saveConnection({ id: 'conn-e2e-mock', providerId: 'e2e-mock', connectionKind: 'api-key', authMethod: 'api-key (test)', credentialRef: 'credential://connections/conn-e2e-mock', status: 'not-connected' }, {});
  if (!r.ok) return fail('connection', r);
  r = service.setConnectionStatus('conn-e2e-mock', 'connected', { attested: true });
  if (!r.ok) return fail('connection-status', r);
  r = service.saveRoute({ id: 'e2e-mock/e2e-1', providerId: 'e2e-mock', logicalModelId: 'e2e/e2e-1', remoteModelId: 'e2e-mock-model', connectionId: 'conn-e2e-mock', reasoningLevels: ['low'], availability: 'probe-required', executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: transportArg } }, {});
  if (!r.ok) return fail('route', r);
  // R-NATIVE-1: second issuable fixture model on the same provider/connection
  // (the selection target). Default main slot below stays on e2e-1.
  r = service.saveModel({ id: 'e2e/e2e-2', vendor: 'E2E', displayName: 'E2E Mock 2', checkpoint: 'e2e-2', capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true }, dataUseTier: 'contributor', contextWindow: 8192, maxOutputTokens: 512, enabled: true, engines: ['muse-v0'] }, {});
  if (!r.ok) return fail('model-2', r);
  // R-NATIVE-2: a second connection with its own credential reference, used by the second route
  r = service.saveConnection({ id: 'conn-e2e-mock-b', providerId: 'e2e-mock', connectionKind: 'api-key', authMethod: 'api-key (test)', credentialRef: 'credential://connections/conn-e2e-mock-b', status: 'not-connected' }, {});
  if (!r.ok) return fail('connection-b', r);
  r = service.setConnectionStatus('conn-e2e-mock-b', 'connected', { attested: true });
  if (!r.ok) return fail('connection-b-status', r);
  r = service.saveRoute({ id: 'e2e-mock/e2e-2', providerId: 'e2e-mock', logicalModelId: 'e2e/e2e-2', remoteModelId: 'e2e-mock-model-2', connectionId: 'conn-e2e-mock-b', reasoningLevels: ['low'], availability: 'probe-required', executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: transportArg } }, {});
  if (!r.ok) return fail('route-2', r);
  // R-NATIVE-1: a CONFIGURED but non-issuable target: the route is saved but never probe-verified,
  // so the Registry must refuse to issue it (catalog reason, refusal before any run exists).
  r = service.saveModel({ id: 'e2e/e2e-3', vendor: 'E2E', displayName: 'E2E Mock 3', checkpoint: 'e2e-3', capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true }, dataUseTier: 'contributor', contextWindow: 8192, maxOutputTokens: 1024, enabled: true, engines: ['muse-v0'] }, {});
  if (!r.ok) return fail('model-3', r);
  r = service.saveRoute({ id: 'e2e-mock/e2e-3', providerId: 'e2e-mock', logicalModelId: 'e2e/e2e-3', remoteModelId: 'e2e-mock-model-3', connectionId: 'conn-e2e-mock', reasoningLevels: ['low'], availability: 'probe-required', executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: transportArg } }, {});
  if (!r.ok) return fail('route-3', r);



  try {
    for (const rid of ['e2e-mock/e2e-1', 'e2e-mock/e2e-2']) {
      const verified = await service.verifyProviderRoute(rid, { fetchImpl: probeFetch, testBearer: 'e2e-probe-bearer', lookup: async function () { return [{ address: '8.8.8.8', family: 4 }]; } });
      if (!verified.ok) return fail('route-probe', { code: 'route-probe-failed', message: rid + ':' + JSON.stringify(verified.errors || verified).slice(0, 400) });
    }
  } catch (e) {
    return fail('route-probe', { code: 'route-probe-threw', message: String((e && e.message) || e).slice(0, 200) });
  }
  r = service.save('engineering-v2', { schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: 'e2e/e2e-1', routeId: 'e2e-mock/e2e-1', reasoning: 'low' } }, roleOverrides: {} }, null, {});
  if (!r.ok) return fail('mode-config', r);
  emit({ ok: true });
}

// R-NATIVE-2 test helpers (run AFTER `registry`): an extra issuable route whose id sorts BEFORE the saved default,
// and the disabling of a model (a target that stops being issuable).
async function cmdRegistryFirst(args) {
  const service = makeService(args[1], args[0]);
  const port = Number(args[2]);
  const transportArg = args[4] || 'local-openai-compatible';
  let r = service.saveModel({ id: 'e2e/a0', vendor: 'E2E', displayName: 'E2E A0', checkpoint: 'a0', capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true }, dataUseTier: 'contributor', contextWindow: 1000000, maxOutputTokens: 1024, enabled: true, engines: ['muse-v0'] }, {});
  if (!r.ok) return emit({ ok: false, where: 'a0-model', code: r.code, message: r.message });
  r = service.saveRoute({ id: 'a0-first/e2e', providerId: 'e2e-mock', logicalModelId: 'e2e/a0', remoteModelId: 'e2e-mock-model-a0', connectionId: 'conn-e2e-mock', reasoningLevels: ['low'], availability: 'probe-required', executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: transportArg } }, {});
  if (!r.ok) return emit({ ok: false, where: 'a0-route', code: r.code, message: r.message });
  const verified = await service.verifyProviderRoute('a0-first/e2e', { fetchImpl: probeFetch, testBearer: 'e2e-probe-bearer', lookup: async function () { return [{ address: '8.8.8.8', family: 4 }]; } });
  if (!verified.ok) return emit({ ok: false, where: 'a0-probe', code: 'route-probe-failed', message: JSON.stringify(verified.errors || verified).slice(0, 300) });
  emit({ ok: true });
}

function cmdRegistryDisable(args) {
  const service = makeService(args[1], args[0]);
  const id = args[2];
  const eff = service.effectiveSnapshot();
  const models = (eff && eff.snapshot && eff.snapshot.models) || [];
  const m = models.find(function (x) { return x.id === id; });
  if (!m) return emit({ ok: false, where: 'disable', code: 'not-found', message: id });
  const r = service.saveModel(Object.assign({}, m, { enabled: false }), {});
  emit(r.ok ? { ok: true } : { ok: false, where: 'disable', code: r.code, message: r.message });
}

// EM-02 fixture: re-declare the reasoning levels of one fixture route (fixture capability data,
// e.g. '["low","high"]'), then re-verify it like `registry` does.
async function cmdRegistryLevels(args) {
  const service = makeService(args[1], args[0]);
  const routeId = args[2];
  const levels = JSON.parse(args[3]);
  const eff = service.effectiveSnapshot();
  const route = ((eff && eff.snapshot && eff.snapshot.routes) || []).find(function (r) { return r.id === routeId; });
  if (!route) return emit({ ok: false, where: 'levels', code: 'not-found', message: routeId });
  const doc = { id: route.id, providerId: route.providerId, logicalModelId: route.logicalModelId, remoteModelId: route.remoteModelId, connectionId: route.connectionId, reasoningLevels: levels, availability: 'probe-required', executionKind: route.executionKind, accessType: route.accessType, compatibility: route.compatibility };
  const r = service.saveRoute(doc, {});
  if (!r.ok) return emit({ ok: false, where: 'levels-save', code: r.code, message: r.message });
  const verified = await service.verifyProviderRoute(routeId, { fetchImpl: probeFetch, testBearer: 'e2e-probe-bearer', lookup: async function () { return [{ address: '8.8.8.8', family: 4 }]; } });
  if (!verified.ok) return emit({ ok: false, where: 'levels-probe', code: 'route-probe-failed', message: JSON.stringify(verified.errors || verified).slice(0, 300) });
  emit({ ok: true });
}

// EM-02 fixture: the operator switches the saved default (main slot) to another model/route.
function cmdRegistryDefault(args) {
  const service = makeService(args[1], args[0]);
  const cur = service.getModeConfiguration('engineering-v2', {});
  const rev = cur && cur.result ? cur.result.revision : null;
  const config = { schemaVersion: 1, modeId: 'engineering-v2', revision: rev, slots: { main: { logicalModelId: args[2], routeId: args[3], reasoning: 'low' } }, roleOverrides: {} };
  const r = service.save('engineering-v2', config, rev, {});
  emit(r.ok ? { ok: true, revision: r.revision } : { ok: false, where: 'default', errors: r.errors || r.code || r });
}

// EM-02 fixture: the operator's reasoning policy for the main slot ('none' removes it).
function cmdRegistrySlotPolicy(args) {
  const service = makeService(args[1], args[0]);
  const cur = service.getModeConfiguration('engineering-v2', {});
  if (!cur || !cur.result || !cur.result.config) return emit({ ok: false, where: 'policy', code: 'unreadable' });
  const rev = cur.result.revision;
  const config = JSON.parse(JSON.stringify(cur.result.config));
  config.revision = rev;
  if (args[2] === 'none') delete config.slots.main.allowedReasoning;
  else config.slots.main.allowedReasoning = JSON.parse(args[2]);
  const r = service.save('engineering-v2', config, rev, {});
  emit(r.ok ? { ok: true, revision: r.revision } : { ok: false, where: 'policy', code: ((r.errors || [])[0] || {}).code, errors: r.errors || r.code || r });
}

// EM-04C2 S4 fixture: the operator SAVES a ModeConfiguration for `modeId` (main slot on
// model/route, reasoning `low`, optional policy). Nothing else writes a mode configuration.
function cmdRegistrySaveMode(args) {
  const service = registryOf(args[1]).service.createService({ installRoot: args[1], dataRoot: args[0] });
  const modeId = args[2];
  const config = { schemaVersion: 1, modeId: modeId, revision: 0, slots: { main: { logicalModelId: args[3], routeId: args[4], reasoning: 'low' } }, roleOverrides: {} };
  if (args[5] && args[5] !== 'none') config.slots.main.allowedReasoning = JSON.parse(args[5]);
  const r = service.save(modeId, config, undefined, {});
  emit(r.ok ? { ok: true, revision: r.revision } : { ok: false, where: 'save-mode', code: ((r.errors || [])[0] || {}).code, errors: r.errors || r.code || r });
}

// EM-03 fixture: scope the fixture models to an additional orchestration engine.
function cmdRegistryEngineScope(args) {
  const service = makeService(args[1], args[0]);
  const eff = service.effectiveSnapshot();
  const models = (eff && eff.snapshot && eff.snapshot.models) || [];
  for (const id of ['e2e/e2e-1', 'e2e/e2e-2']) {
    const m = models.find(function (x) { return x.id === id; });
    if (!m) return emit({ ok: false, where: 'scope', code: 'not-found', message: id });
    const engines = Array.from(new Set((m.engines || []).concat([args[2]])));
    const r = service.saveModel(Object.assign({}, m, { engines: engines }), {});
    if (!r.ok) return emit({ ok: false, where: 'scope', code: r.code, message: r.message, errors: r.errors });
  }
  emit({ ok: true });
}

function cmdIssueAttempt(stdinJson) {
  const tb = require(path.join(REPO, 'config', 'registry', 'native-task-binding.cjs'));
  const out = tb.authorizeAttemptTarget(JSON.parse(stdinJson));
  if (!out.ok) {
    emit({ ok: false, code: out.code, message: out.message });
    process.exitCode = 1;
    return;
  }
  emit(Object.assign({ ok: true }, out.attempt));
}

function cmdIssue(args) {
  const installRoot = args[0];
  const dataRoot = args[1];
  const taskInstanceId = args[2];
  const sessionId = args[3];
  const reg = registryOf(installRoot);
  const service = reg.service.createService({ installRoot: installRoot, dataRoot: dataRoot });
  // EM-04C2 S4 fixture: an optional selection JSON (as the broker passes it) as the fifth argument
  const selection = args[4] ? JSON.parse(args[4]) : null;
  const out = reg.v2.issueExecutionTargetV2({ installRoot: installRoot, dataRoot: dataRoot, taskInstanceId: taskInstanceId, sessionId: sessionId, selection: selection }, { service: service });
  if (!out.ok) {
    emit({ ok: false, code: out.code, message: out.message });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, resolution: out.target.issuance.resolution, snapshot: out.target.issuance.snapshot, core: out.target.core, extension: out.target.extension, extensionDigest: out.target.extensionDigest, issuanceId: out.target.issuance.issuanceId, modeId: out.target.issuance.modeId, role: out.target.issuance.role, modeConfigRevision: out.target.issuance.modeConfigRevision, modeConfigDigest: out.target.issuance.modeConfigDigest, taskBinding: out.target.taskBinding, taskBindingDigest: out.target.taskBindingDigest });
}

function cmdKernelIntent(args, stdinJson) {
  const input = JSON.parse(stdinJson);
  const bridge = require(path.join(REPO, 'config', 'registry', 'native-shadow-bridge.cjs'));
  const out = bridge.buildKernelIntent(input.shadowIntent, input.issuance);
  if (!out.ok) {
    emit({ ok: false, code: out.code, message: out.message });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, intent: out.intent });
}

function cmdIntent(args) {
  const workspace = args[0];
  const taskId = args[1];
  const attemptId = args[2];
  const taskInstanceId = args[3];
  const out = shadowIntent.resolveShadowIntent({ workspace: workspace, taskId: taskId, attemptId: attemptId, taskInstanceId: taskInstanceId });
  if (!out.ok) {
    emit({ ok: false, code: out.code, message: out.message });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, intent: out.intent });
}

function cmdPublish(args, stdinJson) {
  const input = JSON.parse(stdinJson);
  const out = dispatchIntent.buildDispatchIntent(input);
  if (!out.ok) {
    emit({ ok: false, code: out.code, message: out.message });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, bundle: out.bundle });
}

function main() {
  const sub = process.argv[2];
  const args = process.argv.slice(3);
  if (sub === 'registry') return cmdRegistry(args);
  if (sub === 'registry-first') return cmdRegistryFirst(args);
  if (sub === 'registry-disable') return cmdRegistryDisable(args);
  if (sub === 'issue') return cmdIssue(args);
  if (sub === 'registry-levels') return cmdRegistryLevels(args);
  if (sub === 'registry-default') return cmdRegistryDefault(args);
  if (sub === 'registry-slot-policy') return cmdRegistrySlotPolicy(args);
  if (sub === 'registry-engine-scope') return cmdRegistryEngineScope(args);
  if (sub === 'registry-save-mode') return cmdRegistrySaveMode(args);
  if (sub === 'issue-attempt') {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { text += c; });
    process.stdin.on('end', function () { cmdIssueAttempt(text); });
    return;
  }
  if (sub === 'intent') return cmdIntent(args);
  if (sub === 'kernel-intent') {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { text += c; });
    process.stdin.on('end', function () { cmdKernelIntent(args, text); });
    return;
  }
  if (sub === 'publish') {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { text += c; });
    process.stdin.on('end', function () { cmdPublish(args, text); });
    return;
  }
  emit({ ok: false, code: 'bad-subcommand', message: 'unknown driver subcommand' });
  process.exitCode = 1;
}

main();
