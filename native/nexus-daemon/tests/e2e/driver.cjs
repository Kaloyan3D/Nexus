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
    return probeJson(200, JSON.stringify({ data: [{ id: 'e2e-mock-model' }] }));
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
  r = service.saveModel({ id: 'e2e/e2e-1', vendor: 'E2E', displayName: 'E2E Mock', checkpoint: 'e2e-1', capabilities: { textInput: true, imageInput: false, toolCalling: true, streaming: true, reasoning: true }, dataUseTier: 'contributor', contextWindow: 8192, maxOutputTokens: 1024, enabled: true, engines: ['muse-v0'] }, {});
  if (!r.ok) return fail('model', r);
  r = service.saveConnection({ id: 'conn-e2e-mock', providerId: 'e2e-mock', connectionKind: 'api-key', authMethod: 'api-key (test)', credentialRef: 'credential://connections/conn-e2e-mock', status: 'not-connected' }, {});
  if (!r.ok) return fail('connection', r);
  r = service.setConnectionStatus('conn-e2e-mock', 'connected', { attested: true });
  if (!r.ok) return fail('connection-status', r);
  r = service.saveRoute({ id: 'e2e-mock/e2e-1', providerId: 'e2e-mock', logicalModelId: 'e2e/e2e-1', remoteModelId: 'e2e-mock-model', connectionId: 'conn-e2e-mock', reasoningLevels: ['low'], availability: 'probe-required', executionKind: 'raw-model', accessType: 'api-key', compatibility: { transport: transportArg } }, {});
  if (!r.ok) return fail('route', r);



  try {
    const verified = await service.verifyProviderRoute('e2e-mock/e2e-1', { fetchImpl: probeFetch, testBearer: 'e2e-probe-bearer', lookup: async function () { return [{ address: '8.8.8.8', family: 4 }]; } });
    if (!verified.ok) return fail('route-probe', { code: 'route-probe-failed', message: JSON.stringify(verified.errors || verified).slice(0, 400) });
  } catch (e) {
    return fail('route-probe', { code: 'route-probe-threw', message: String((e && e.message) || e).slice(0, 200) });
  }
  r = service.save('engineering-v2', { schemaVersion: 1, modeId: 'engineering-v2', revision: 0, slots: { main: { logicalModelId: 'e2e/e2e-1', routeId: 'e2e-mock/e2e-1', reasoning: 'low' } }, roleOverrides: {} }, null, {});
  if (!r.ok) return fail('mode-config', r);
  emit({ ok: true });
}

function cmdIssue(args) {
  const installRoot = args[0];
  const dataRoot = args[1];
  const taskInstanceId = args[2];
  const sessionId = args[3];
  const service = makeService(installRoot, dataRoot);
  const out = v2.issueExecutionTargetV2({ installRoot: installRoot, dataRoot: dataRoot, taskInstanceId: taskInstanceId, sessionId: sessionId }, { service: service });
  if (!out.ok) {
    emit({ ok: false, code: out.code, message: out.message });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, resolution: out.target.issuance.resolution, snapshot: out.target.issuance.snapshot, core: out.target.core, extension: out.target.extension, extensionDigest: out.target.extensionDigest, issuanceId: out.target.issuance.issuanceId, modeId: out.target.issuance.modeId, role: out.target.issuance.role, modeConfigRevision: out.target.issuance.modeConfigRevision, modeConfigDigest: out.target.issuance.modeConfigDigest });
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
  if (sub === 'issue') return cmdIssue(args);
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
