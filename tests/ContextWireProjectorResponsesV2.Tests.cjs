'use strict';
/**
 * ContextWireProjectorResponsesV2.Tests.cjs - Responses wire projector.
 *
 * Unit: settings.yaml route descriptor (closed world), projection shape,
 * determinism and typed refusals.
 *
 * T-NT-3 conformance: the REAL pinned chain (cordis + dsh-llm LlmRuntime +
 * dsh-llm-pi-ai configured from this repo's config/settings.yaml section,
 * pi-ai 0.82 openai-responses + the OpenAI SDK) posts each request to a
 * local capture server; projectResponsesWireV2(request) must equal the
 * posted HTTP body byte-for-byte. Only baseURL/apiKeyEnv are redirected to
 * the local server (the key is a local test value; nothing leaves the host).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '..');
const wire = require(path.join(repoRoot, 'config', 'ContextWireProjectorResponsesV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 600))); }
}
function section(title) { console.log('\n' + title); }
function throwsCode(fn, code, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error.message).indexOf('context-wire-' + code) === 0, name, error ? error.message : 'did not throw');
}

const PROVIDER = 'opencode-go';
const MODEL = 'muse-spark-1.3-contributor';
const SETTINGS_TEXT = fs.readFileSync(path.join(repoRoot, 'config', 'settings.yaml'), 'utf8');
const ROUTE = wire.readResponsesRouteFromSettingsV2(SETTINGS_TEXT, PROVIDER, MODEL);
// The same route with historical reasoning replay (the pinned adapter's own
// behaviour); ROUTE itself carries the frozen capability (none).
const NATIVE_ROUTE = Object.freeze(Object.assign({}, ROUTE, { reasoningReplay: 'native' }));

section('WP-1 ROUTE DESCRIPTOR FROM settings.yaml (closed world)');
{
  check(ROUTE !== null && ROUTE.api === 'openai-responses' && ROUTE.contextWindow === 1048576 && ROUTE.maxTokens === 131072
    && ROUTE.reasoning === true && ROUTE.defaultReasoning === 'xhigh' && ROUTE.supportsDeveloperRole === true
    && ROUTE.input.join(',') === 'text,image', 'opencode-go profile resolves to the traced descriptor', JSON.stringify(ROUTE));
  check(ROUTE.thinkingLevelMap.off === null && ROUTE.thinkingLevelMap.max === null && ROUTE.thinkingLevelMap.xhigh === 'xhigh',
    'reasoning map pins undeclared levels to null (dsh resolveModelReasoning)');
  check(wire.supportedThinkingLevelsV2(ROUTE).join(',') === 'minimal,low,medium,high,xhigh', 'supported levels mirror pi-ai getSupportedThinkingLevels');
  const block = '    opencode-go:\n';
  const inject = (after, line) => SETTINGS_TEXT.replace(block + after, block + after + line);
  const withLine = (line) => SETTINGS_TEXT.replace('      apiKeyEnv: OPENCODE_API_KEY\n', '      apiKeyEnv: OPENCODE_API_KEY\n' + line);
  check(wire.readResponsesRouteFromSettingsV2(withLine('      cacheRetention: long\n'), PROVIDER, MODEL) === null, 'unknown profile key (cacheRetention) fails closed');
  check(wire.readResponsesRouteFromSettingsV2(withLine('      headers:\n        x-a: b\n'), PROVIDER, MODEL) === null, 'profile headers fail closed');
  check(wire.readResponsesRouteFromSettingsV2(SETTINGS_TEXT.replace('        supportsDeveloperRole: true\n      models:\n        - id: muse-spark-1.3-contributor\n          name: Muse Spark 1.3 Contributor (OpenCode Go)',
    '        supportsDeveloperRole: true\n        supportsStrictMode: true\n      models:\n        - id: muse-spark-1.3-contributor\n          name: Muse Spark 1.3 Contributor (OpenCode Go)'), PROVIDER, MODEL) === null, 'unknown compat switch fails closed');
  check(wire.readResponsesRouteFromSettingsV2(SETTINGS_TEXT.replace('          name: Muse Spark 1.3 Contributor (OpenCode Go)\n', '          name: Muse Spark 1.3 Contributor (OpenCode Go)\n          compat:\n            supportsDeveloperRole: false\n'), PROVIDER, MODEL) === null,
    'model-level compat fails closed');
  check(wire.readResponsesRouteFromSettingsV2(SETTINGS_TEXT.replace('      api: openai-responses\n      baseURL: https://opencode.ai', '      api: openai-completions\n      baseURL: https://opencode.ai'), PROVIDER, MODEL) === null, 'non-Responses api fails closed');
  check(wire.readResponsesRouteFromSettingsV2(SETTINGS_TEXT, PROVIDER, 'other-model') === null, 'unknown model fails closed');
  check(wire.readResponsesRouteFromSettingsV2(SETTINGS_TEXT, 'nope', MODEL) === null && wire.readResponsesRouteFromSettingsV2(null, PROVIDER, MODEL) === null,
    'unknown provider / no text fails closed');
  void inject;
}

// ---- DSH-shaped message builders (production schema) ----
const replay = (stopReason, blocks, model) => ({
  response: { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: PROVIDER, model: model || MODEL, responseId: 'resp_x', stopReason },
  blocks,
});
const reasoningSig = (id) => JSON.stringify({ type: 'reasoning', id, summary: [], encrypted_content: 'ENC-' + id });
let msgSeq = 0;
const mid = () => 'msg_' + String(++msgSeq).padStart(4, '0');
const userMsg = (text, kind) => ({ id: mid(), role: 'user', content: [{ type: 'text', text }], source: { kind: kind || 'user' } });
const toolResult = (callId, text, isError) => ({ id: mid(), role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: isError === true }], source: { kind: 'tool', callId } });
function replayedAssistant(parts, stopReason, model) {
  const content = [];
  const blocks = [];
  for (const part of parts) {
    if (part.reasoning !== undefined) { content.push({ type: 'reasoning', text: part.reasoning }); blocks.push({ type: 'reasoning', thinkingSignature: reasoningSig(part.rs) }); }
    if (part.text !== undefined) { content.push({ type: 'text', text: part.text }); blocks.push(Object.assign({ type: 'text' }, part.sig ? { textSignature: part.sig } : {})); }
    if (part.call !== undefined) { content.push({ type: 'tool-call', id: part.call, name: part.name || 'run_code', arguments: part.args || '{"code":"1"}' }); blocks.push({ type: 'tool-call' }); }
  }
  return { id: mid(), role: 'assistant', content, source: { kind: 'model', provider: PROVIDER, model: model || MODEL, replayState: replay(stopReason || 'toolUse', blocks, model) } };
}
function foreignAssistant(content, provider, model) {
  return { id: mid(), role: 'assistant', content, source: { kind: 'model', provider: provider || 'flash-max-direct', model: model || 'deepseek-v4-flash' } };
}
const TOOLS = [
  { name: 'run_code', description: 'Run code.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'skill', description: 'Load a skill.', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
];
const SYSTEM = 'You are the Nexus host-contract system prompt.';
function baseRequest(messages, extra) {
  return Object.assign({ provider: PROVIDER, model: MODEL, messages, system: SYSTEM, tools: TOOLS, maxTokens: 2048, sessionId: 'sess-wire-1' }, extra || {});
}
// Multi-step active turn (production skill-loop shape).
function multiStepMessages() {
  return [
    userMsg('Old turn request.'),
    replayedAssistant([{ text: 'Old answer.', sig: JSON.stringify({ v: 1, id: 'msg_old', phase: 'final_answer' }) }], 'stop'),
    userMsg('Implement the feature.'),
    replayedAssistant([{ reasoning: 'Load the workflow first.', rs: 'rs_a' }, { call: 'call_A|fc_A', args: '{"code":"await tools.skill({name: \\"nexus-engineering-workflow\\"})"}' }]),
    toolResult('call_A|fc_A', 'loaded'),
    replayedAssistant([{ reasoning: '', rs: 'rs_b' }, { text: 'Workflow loaded; reading the spec.', sig: JSON.stringify({ v: 1, id: 'msg_b', phase: 'commentary' }) }, { call: 'call_B|fc_B', args: '{ "code" : "read()" }' }]),
    toolResult('call_B|fc_B', 'spec text'),
  ];
}

section('WP-2 PROJECTION SHAPE + REFUSALS (unit, reasoningReplay=native)');
{
  const projected = wire.projectResponsesWireV2({ request: baseRequest(multiStepMessages()), route: NATIVE_ROUTE, env: {} });
  const input = projected.wireBody.input;
  check(input[0].role === 'developer' && input[0].content === SYSTEM, 'system travels as the developer item');
  const types = input.map((item) => item.type || item.role);
  check(JSON.stringify(types) === JSON.stringify(['developer', 'user', 'message', 'user', 'reasoning', 'function_call', 'function_call_output', 'reasoning', 'message', 'function_call', 'function_call_output']),
    'native causal order: user -> reasoning -> function_call -> function_call_output -> ... ', JSON.stringify(types));
  const calls = input.filter((item) => item.type === 'function_call');
  check(calls[0].call_id === 'call_A' && calls[0].id === 'fc_A' && calls[1].call_id === 'call_B', 'call ids split call_id|fc item id');
  check(calls[1].arguments === '{"code":"read()"}', 'arguments re-serialized from the parsed object (pi-ai JSON.stringify)');
  check(input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id).join(',') === 'call_A,call_B', 'results correlate by call_id');
  check(input[4].encrypted_content === 'ENC-rs_a', 'reasoning replay item carries encrypted content verbatim');
  check(JSON.stringify(Object.keys(projected.countedBody)) === JSON.stringify(['model', 'input', 'tools', 'reasoning', 'max_output_tokens']), 'counted subset keys');
  check(projected.countedBody.input === projected.wireBody.input, 'counted input IS the wire input');
  check(projected.wireBody.reasoning.effort === 'xhigh' && projected.wireBody.reasoning.summary === 'auto', 'profile default effort applies when the request names none');
  const again = wire.projectResponsesWireV2({ request: baseRequest(multiStepMessages().map((m) => JSON.parse(JSON.stringify(m)))), route: NATIVE_ROUTE, env: {} });
  check(JSON.stringify(again.wireBody) !== undefined && JSON.stringify(again.wireBody).length === JSON.stringify(projected.wireBody).length, 'projection is deterministic over equal input');
  check(Object.isFrozen(projected.wireBody) && Object.isFrozen(projected.wireBody.input[1]), 'projection is deep-frozen');
  const img = baseRequest([{ id: 'i', role: 'user', content: [{ type: 'image', attachment: {} }], source: { kind: 'user' } }]);
  throwsCode(() => wire.projectResponsesWireV2({ request: img, route: ROUTE }), 'unsupported-content', 'image content refused');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([userMsg('x')], { stop: ['z'] }), route: ROUTE }), 'unsupported-option', 'stop sequences refused');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([{ id: 'r', role: 'tool', content: [], source: {} }]), route: ROUTE }), 'unsupported-content', 'unknown role refused');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([userMsg('x')], { reasoningEffort: 'max' }), route: ROUTE }), 'reasoning-unsupported', 'unsupported effort refused');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([userMsg('x')], { model: 'other' }), route: ROUTE }), 'route-mismatch', 'route mismatch refused');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([userMsg('x')]), route: null }), 'route-invalid', 'missing route refused');
}

section('WP-3 reasoningReplay CAPABILITY (provider-scoped, one transformed request)');
{
  check(ROUTE.reasoningReplay === 'none', 'opencode-go / muse-spark-1.3-contributor resolves reasoningReplay=none from the frozen capability table');
  check(wire.reasoningReplayOfV2('opencode-go', 'other-model') === 'native' && wire.reasoningReplayOfV2('openai', MODEL) === 'native'
    && wire.reasoningReplayOfV2('meta-model-api', MODEL) === 'native' && wire.reasoningReplayOfV2('opencode', MODEL) === 'native',
    'T7: no Muse-specific filtering leaks to other providers/models (default native)');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([userMsg('x')]), route: Object.assign({}, ROUTE, { reasoningReplay: 'bogus' }) }), 'route-invalid', 'unknown capability fails closed');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest([userMsg('x')]), route: Object.assign({}, ROUTE, { reasoningReplay: undefined }) }), 'route-invalid', 'missing capability fails closed');
  // T1: native keeps replay untouched.
  const messages = multiStepMessages();
  check(wire.applyReasoningReplayV2(messages, NATIVE_ROUTE) === messages, 'T1: native returns the same messages array (replay untouched)');
  const nativeBody = wire.projectResponsesWireV2({ request: baseRequest(messages), route: NATIVE_ROUTE, env: {} }).wireBody;
  check(nativeBody.input.filter((i) => i.type === 'reasoning').length === 2, 'T1: native projection carries both historical reasoning items');
  // T2: none removes historical reasoning only.
  const stripped = wire.applyReasoningReplayV2(messages, ROUTE);
  check(stripped.every((m, i) => (messages[i].role === 'assistant' && messages[i].content.some((b) => b.type === 'reasoning')) ? m !== messages[i] : m === messages[i]),
    'T2: only assistant messages with reasoning are copied; every other message is the same object');
  check(stripped.every((m) => !(m.role === 'assistant' && m.content.some((b) => b.type === 'reasoning'))), 'T2: no reasoning block remains in the transformed request');
  check(stripped.every((m, i) => m.id === messages[i].id && m.role === messages[i].role
    && m.content.every((b) => messages[i].content.indexOf(b) !== -1)), 'T2: ids, roles and surviving blocks (same objects) preserved');
  check(stripped[5].source.replayState.blocks.length === stripped[5].content.length && stripped[5].source.replayState.blocks.every((b) => b.type !== 'reasoning'),
    'T2: replay envelope drops exactly the reasoning entries (replay stays valid)');
  check(Object.isFrozen(messages[3]) === false && messages[3].content.some((b) => b.type === 'reasoning'), 'T2: input messages are never mutated');
  const noneProjection = wire.projectResponsesWireV2({ request: baseRequest(stripped), route: ROUTE, env: {} });
  const noneBody = noneProjection.wireBody;
  const expected = Object.assign({}, nativeBody, { input: nativeBody.input.filter((i) => i.type !== 'reasoning') });
  check(JSON.stringify(noneBody) === JSON.stringify(expected), 'T2: none body == native body minus exactly its reasoning items (everything else byte-identical)');
  check(noneBody.input.filter((i) => i.type === 'function_call').map((c) => c.call_id + '/' + c.id).join(',') === 'call_A/fc_A,call_B/fc_B'
    && noneBody.input.filter((i) => i.type === 'function_call_output').map((o) => o.call_id).join(',') === 'call_A,call_B',
    'T2: function_call / function_call_output and call ids survive');
  check(noneBody.input.some((i) => i.role === 'user' && JSON.stringify(i.content).indexOf('Implement the feature.') !== -1)
    && noneBody.input.some((i) => i.type === 'message' && JSON.stringify(i.content).indexOf('Workflow loaded; reading the spec.') !== -1),
    'T2: user anchor and visible assistant text survive');
  check(JSON.stringify(noneBody.input.map((i) => i.type || i.role)) === JSON.stringify(['developer', 'user', 'message', 'user', 'function_call', 'function_call_output', 'message', 'function_call', 'function_call_output']),
    'T2: tool order survives');
  check(noneBody.reasoning.effort === 'xhigh' && noneBody.reasoning.summary === 'auto' && JSON.stringify(noneBody.include) === '["reasoning.encrypted_content"]',
    'T2: reasoning request SETTINGS stay (fresh reasoning is still generated and returned)');
  check(noneProjection.facts.reasoningItems === 0 && noneProjection.facts.reasoningReplay === 'none', 'T2: projection facts report no replayed reasoning');
  throwsCode(() => wire.projectResponsesWireV2({ request: baseRequest(messages), route: ROUTE, env: {} }), 'reasoning-replay-forbidden',
    'T6: an untransformed request on a none route is refused (a count-side-only filter can never be introduced silently)');
  check(wire.applyReasoningReplayV2(stripped, ROUTE).every((m, i) => m === stripped[i]), 'T2: transform is idempotent');
}

// ---- T-NT-3: real pinned chain conformance ----
function resolveApp() {
  const roots = [];
  if (process.env.NEXUS_RUNTIME_ROOT) roots.push(process.env.NEXUS_RUNTIME_ROOT);
  roots.push(path.join(os.homedir(), '.local', 'share', 'nexus'));
  for (const root of roots) {
    if (!fs.existsSync(path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'))) continue;
    try { return { root, appRequire: createRequire(path.join(root, 'app', 'package.json')) }; } catch { /* keep searching */ }
  }
  return null;
}

async function conformance() {
  section('T-NT-3 REAL PINNED pi-ai WIRE CONFORMANCE (byte-exact HTTP body)');
  const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
  const found = resolveApp();
  if (found === null) {
    liveGate.reportLiveHostGate('WIRE-CONFORMANCE', liveGate.decideLiveHostGate(false, process.env));
    console.log('SKIP: pinned DSH app tree is absent; wire conformance is PENDING (never faked).');
    return;
  }
  liveGate.reportLiveHostGate('WIRE-CONFORMANCE', 'EXECUTED');
  const { appRequire } = found;
  const YAML = appRequire('yaml');
  const { Context } = appRequire('@deepseek-ai/cordis');
  const llm = appRequire('@deepseek-ai/dsh-llm');
  const piAi = appRequire('@deepseek-ai/dsh-llm-pi-ai');
  const bodies = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      bodies.push({ url: req.url, body: text });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"captured by the conformance server","type":"invalid_request_error"}}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const KEY_ENV = 'NEXUS_WIRE_CONFORMANCE_TEST_KEY';
  process.env[KEY_ENV] = 'local-conformance-test-key';
  const section0 = YAML.parse(SETTINGS_TEXT)['llm-pi-ai'].providers[PROVIDER];
  const profile = Object.assign({}, section0, { baseURL: base, apiKeyEnv: KEY_ENV });
  const small = JSON.parse(JSON.stringify(profile));
  small.models[0].contextWindow = 9000;
  const ctx = new Context();
  const previousRetention = process.env.PI_CACHE_RETENTION;
  try {
    await ctx.plugin(llm.default);
    await ctx.plugin(piAi, { providers: { [PROVIDER]: profile, 'opencode-go-small': small } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const smallRoute = Object.assign({}, ROUTE, { provider: 'opencode-go-small', contextWindow: 9000 });
    const long = 'x'.repeat(30000);
    const cases = [
      ['single user turn', baseRequest([userMsg('hi')])],
      ['multi-step active turn (replayed reasoning, text signatures, two tool calls)', baseRequest(multiStepMessages())],
      ['production skill loop: skill call -> "loaded" -> next request', baseRequest([userMsg('Build it.'),
        replayedAssistant([{ reasoning: 'r', rs: 'rs_s' }, { call: 'call_S|fc_S', args: '{"code":"await tools.skill({name: \\"nexus-engineering-workflow\\"}); console.log(\\"loaded\\")"}' }]),
        toolResult('call_S|fc_S', 'loaded')])],
      ['foreign assistant (no replay): reasoning->text, id normalization', baseRequest([userMsg('q'),
        foreignAssistant([{ type: 'reasoning', text: 'thinking aloud' }, { type: 'reasoning', text: '  ' }, { type: 'text', text: 'ans' }, { type: 'tool-call', id: 'call.weird/id:9___', name: 'run_code', arguments: 'not json' }]),
        toolResult('call.weird/id:9___', 'ok')])],
      ['invalid replay degrades to foreign', baseRequest([userMsg('q'),
        Object.assign(replayedAssistant([{ text: 'a' }, { call: 'call_D|fc_D' }]), {}), toolResult('call_D|fc_D', 'r')].map((m, i) => (i === 1 ? Object.assign({}, m, { source: Object.assign({}, m.source, { replayState: { response: { kind: 'pi-ai', version: 1 } } }) }) : m)))],
      ['different model on the same route', baseRequest([userMsg('q'), replayedAssistant([{ reasoning: 'r', rs: 'rs_m' }, { text: 't', sig: 'plain-signature-id' }, { call: 'call_M|fc_M' }], 'toolUse', 'muse-older'), toolResult('call_M|fc_M', 'r')])],
      ['system-role message inside messages', baseRequest([{ id: 'sys1', role: 'system', content: [{ type: 'text', text: 'ctx A' }, { type: 'text', text: 'ctx B' }], source: { kind: 'plugin', plugin: 'x' } }, userMsg('q')])],
      ['orphan tool call interrupted by a user message (synthetic result)', baseRequest([userMsg('q'), replayedAssistant([{ call: 'call_O|fc_O' }]), userMsg('follow-up')])],
      ['aborted replayed assistant is skipped', baseRequest([userMsg('q'), replayedAssistant([{ text: 'partial' }], 'aborted'), userMsg('again')])],
      ['explicit effort, temperature, long session id, duplicate tool names', baseRequest([userMsg('q')], {
        reasoningEffort: 'low', temperature: 0.2, sessionId: 's'.repeat(80), tools: TOOLS.concat([{ name: 'run_code', description: 'Override.', parameters: { type: 'object' } }]) })],
      ['no maxTokens, no tools, empty system, empty texts', { provider: PROVIDER, model: MODEL, system: '', messages: [userMsg(''), foreignAssistant([{ type: 'tool-call', id: 'call_E', name: 'run_code', arguments: '{}' }]),
        { id: 'te', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_E', content: [], isError: true }], source: { kind: 'tool', callId: 'call_E' } }] }],
      ['lone surrogates and multi-block user text', baseRequest([{ id: 'ls', role: 'user', content: [{ type: 'text', text: 'a\uD800b' }, { type: 'text', text: 'c\uDC00d🙈' }], source: { kind: 'user' } }])],
      ['maxTokens clamped by the context estimate', Object.assign(baseRequest([userMsg(long)]), { provider: 'opencode-go-small', maxTokens: 8000 }), smallRoute],
      ['PI_CACHE_RETENTION=long', baseRequest([userMsg('q')]), ROUTE, { PI_CACHE_RETENTION: 'long' }],
    ];
    const matrix = [];
    for (const [name, request, routeOverride, env] of cases) {
      const baseRoute = routeOverride || ROUTE;
      matrix.push([name + ' [replay=native]', request, Object.assign({}, baseRoute, { reasoningReplay: 'native' }), env]);
      // reasoningReplay=none: the ONE transformed request goes to the real
      // adapter AND to the projector.
      const noneRoute = Object.assign({}, baseRoute, { reasoningReplay: 'none' });
      matrix.push([name + ' [replay=none]', Object.assign({}, request, { messages: wire.applyReasoningReplayV2(request.messages, noneRoute) }), noneRoute, env]);
    }
    for (const [name, request, route, env] of matrix) {
      if (env && env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = env.PI_CACHE_RETENTION;
      else delete process.env.PI_CACHE_RETENTION;
      const before = bodies.length;
      const chunks = [];
      try {
        for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk);
      } catch (error) {
        chunks.push({ type: 'thrown', message: String(error && error.message) });
      }
      const posted = bodies.slice(before);
      let projected = null;
      let projectError = null;
      try {
        projected = wire.projectResponsesWireV2({ request, route, env: env || {} });
      } catch (error) {
        projectError = String(error.message);
      }
      const ok = posted.length === 1 && posted[0].url === '/v1/responses' && projected !== null && posted[0].body === JSON.stringify(projected.wireBody);
      check(ok, 'T-NT-3 ' + name + ': projector == posted body (byte-exact)',
        posted.length !== 1 ? 'posted ' + posted.length + ' bodies; chunks ' + JSON.stringify(chunks).slice(0, 300)
          : (projectError !== null ? projectError : '\nposted:    ' + posted[0].body.slice(0, 900) + '\nprojected: ' + JSON.stringify(projected.wireBody).slice(0, 900)));
      if (name.indexOf('clamped') !== -1 && projected !== null) {
        check(projected.facts.maxTokensClamped === true && projected.wireBody.max_output_tokens < 8000, 'clamp case actually exercises the estimate clamp');
      }
      if (name.indexOf('synthetic') !== -1 && projected !== null) check(projected.facts.syntheticToolResults === 1, 'synthetic result case exercises pi-ai orphan repair');
    }
  } finally {
    if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previousRetention;
    delete process.env[KEY_ENV];
    server.close();
    await ctx.fiber.dispose().catch(() => {});
  }
}

conformance().then(() => {
  console.log('\nContextWireProjectorResponsesV2 suite: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}, (error) => {
  console.log('FAIL: conformance crashed :: ' + String(error && error.stack).slice(0, 800));
  process.exitCode = 1;
});
