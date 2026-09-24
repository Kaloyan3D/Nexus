'use strict';

// header comment
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repoRoot = path.resolve(__dirname, '..');
const nexusProfiles = require(path.join(repoRoot, 'config', 'Nexus-Profiles.cjs'));
const isolation = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'));
const engineering = require(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'engineering.cjs'));
let passed = 0;
function pass(name) { passed++; console.log('PASS: ' + name); }
function loadJson(rel) { return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')); }
function registryEntry(registry, id) {
  const models = registry.models || [];
  for (let i = 0; i < models.length; i++) { if (models[i] && String(models[i].id) === id) return models[i]; }
  return null;
}function startMockProvider(handler) {
  return new Promise(function(resolve) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function() { resolve({ server: server, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' }); });
  });
}
function readBody(req) {
  return new Promise(function(resolve) {
    let raw = '';
    req.on('data', function(chunk) { raw += chunk; });
    req.on('end', function() { try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); } });
  });
}
function makeIsoFixture() {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-oc-iso-'));
  fs.mkdirSync(path.join(installRoot, 'data', 'routing', 'states'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'config'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'config', 'model-registry.json'), path.join(installRoot, 'config', 'model-registry.json'));
  return installRoot;
}
function statePathFor(installRoot, binding) {
  const resolvedWorkspace = path.resolve(binding.workspace);
  const ws = process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace;
  const preset = String(binding.preset || 'aih-muse').toLowerCase();
  const identity = binding.taskInstanceId || String(binding.taskId || '');
  const key = ws + chr(10) + preset + chr(10) + identity;
  return path.join(installRoot, 'data', 'routing', 'states', crypto.createHash('sha256').update(key, 'utf8').digest('hex') + '.json');
}
function chr(n) { return String.fromCharCode(n); }
function writeState(installRoot, binding, state) {
  fs.writeFileSync(statePathFor(installRoot, binding), JSON.stringify(state), 'utf8');
}
function writeBindings(installRoot, sessionId, binding) {
  const bindingsPath = path.join(installRoot, 'data', 'routing', 'session-bindings.json');
  let document = { schemaVersion: 1, bindings: {} };
  try { document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8')); } catch (e) { /* fresh */ }
  document.bindings = document.bindings || {};
  const merged = Object.assign({ engine: 'muse' }, binding);
  document.bindings[sessionId] = merged;
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  fs.writeFileSync(bindingsPath, JSON.stringify(document), 'utf8');
}
function opencodeState(overrides) {
  return Object.assign({ taskId: 'TASK-OC-1', preset: 'aih-muse', engine: 'muse', executionClass: 'muse_main', role: null, profile: 'muse-spark-1.3-contributor-opencode', profileDisplayName: 'Muse Spark 1.3 OpenCode Go', provider: 'opencode-go', model: 'muse-spark-1.3-contributor', modelDisplayName: 'Muse Spark 1.3 Contributor OpenCode Go', reasoning: 'xhigh', dataUseTier: 'contributor' }, overrides || {});
}
function makeCtx() {
  const handlers = {};
  const registrations = [];
  return { handlers: handlers, registrations: registrations, on: function(name, handler) { handlers[name] = handler; }, shellEnv: { register: function(d) { registrations.push(d); } } };
}
function runRequest(ctx, session, proposed) {
  const handler = ctx.handlers['agent/request'];
  assert.ok(handler, 'agent/request handler registered');
  return handler({ agent: { session: session } }, function() { return Promise.resolve(proposed); });
}async function main() {
  const probe = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'Invoke-MetaProbe.mjs')).href);
  const TEST_KEY = 'aih-muse-opencode-suite-not-a-real-secret-0123456789';
  const museDoc = loadJson('config/muse-profiles.json');
  assert.equal(museDoc.schemaVersion, 1);
  const metaProfile = museDoc.profiles.filter(function(p) { return p && p.id === 'muse-spark-1.3-contributor'; })[0];
  const ocProfile = museDoc.profiles.filter(function(p) { return p && p.id === 'muse-spark-1.3-contributor-opencode'; })[0];
  assert.ok(metaProfile, 'Meta muse profile present');
  assert.ok(ocProfile, 'OpenCode muse profile present');
  const seen = {};
  museDoc.profiles.forEach(function(p) { seen[String(p.id).toLowerCase()] = true; });
  assert.equal(Object.keys(seen).length, museDoc.profiles.length);
  pass('1.1: both Muse profiles coexist with unique ids');
  const catalog = nexusProfiles.loadNexusProfileCatalog(repoRoot);
  assert.deepEqual(nexusProfiles.validateCatalogDocument(catalog), []);
  const listed = nexusProfiles.listNexusProfiles(repoRoot).map(function(p) { return p.id; });
  assert.ok(listed.indexOf('muse-spark-1.3-contributor') !== -1);
  assert.ok(listed.indexOf('muse-spark-1.3-contributor-opencode') !== -1);
  pass('1.2: both Nexus profiles are listed');
  const metaResolved = nexusProfiles.resolveMuseProfileModel(repoRoot, 'muse-spark-1.3-contributor');
  assert.ok(metaResolved);
  assert.equal(metaResolved.provider, 'meta-model-api');
  assert.equal(metaResolved.model, 'muse-spark-1.3-contributor');
  pass('2: Meta profile still resolves to meta-model-api (unchanged)');
  assert.equal(nexusProfiles.museModelBindingOf(ocProfile), 'muse-spark-1.3-contributor-opencode');
  const ocResolved = nexusProfiles.resolveMuseProfileModel(repoRoot, 'muse-spark-1.3-contributor-opencode');
  assert.ok(ocResolved, 'opencode binding resolves');
  assert.equal(ocResolved.provider, 'opencode-go');
  assert.equal(ocResolved.model, 'muse-spark-1.3-contributor');
  assert.equal(ocResolved.reasoning, 'xhigh');
  assert.equal(ocResolved.dataUseTier, 'contributor');
  assert.notEqual(ocResolved.provider, 'meta-model-api');
  pass('3: OpenCode profile resolves only to opencode-go (never meta-model-api)');
  const ocRegistry = loadJson('config/model-registry.json');
  const ocEntry = registryEntry(ocRegistry, 'muse-spark-1.3-contributor-opencode');
  assert.ok(ocEntry && ocEntry.enabled === true);
  assert.deepEqual(ocEntry.agentEngines, ['muse']);
  const provValues = Object.keys(ocEntry.providers || {}).map(function(k) { return ocEntry.providers[k]; });
  assert.ok(provValues.indexOf('meta-model-api') === -1, 'no Meta route in opencode providers map');
  pass('3b: registry entry is muse-scoped with no Meta provider mapping');
  const metaNexus = nexusProfiles.resolveNexusProfile(repoRoot, 'muse-spark-1.3-contributor');
  const ocNexus = nexusProfiles.resolveNexusProfile(repoRoot, 'muse-spark-1.3-contributor-opencode');
  assert.ok(metaNexus && ocNexus);
  assert.equal(metaNexus.engine, 'muse');
  assert.equal(ocNexus.engine, 'muse');
  assert.equal(ocNexus.source.kind, 'muse-profile');
  assert.equal(ocNexus.selectable, true);
  assert.equal(ocNexus.runnable, true);
  assert.equal(nexusProfiles.engineAgentPresetOf(catalog, 'muse'), 'aih-muse');
  pass('4/5: both profiles remain engine=muse under internal preset aih-muse');  const installRoot = makeIsoFixture();
  process.env.DSH_HOME = installRoot + '/data';
  process.env.AIH_INSTALL_ROOT = installRoot;
  const binding = { workspace: '/tmp/oc-ws', taskId: 'TASK-OC-1', preset: 'aih-muse', taskInstanceId: 'oc-1' };
  binding.workspace = require('node:os').tmpdir() + '/muse-oc-ws';
  require('node:fs').mkdirSync(binding.workspace, { recursive: true });
  writeBindings(installRoot, 'sess-oc', binding);
  writeState(installRoot, binding, opencodeState());
  const target = isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-oc'));
  assert.equal(target.provider, 'opencode-go');
  assert.equal(target.model, 'muse-spark-1.3-contributor');
  assert.equal(target.profile, 'muse-spark-1.3-contributor-opencode');
  pass('6: Muse Isolation enforces the controller-produced opencode-go target');
  const ctx = makeCtx();
  isolation.apply(ctx);
  const session = { id: 'sess-oc', events: [{ type: 'agent-preset/selected', data: { agentPreset: 'aih-muse' } }], header: {} };
  const enforced = await runRequest(ctx, session, { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', reasoningEffort: 'max', maxTokens: 131072 });
  assert.equal(enforced.provider, 'opencode-go');
  assert.equal(enforced.model, 'muse-spark-1.3-contributor');
  assert.equal(enforced.maxTokens, 32768);
  pass('6b: request boundary overwrites a Meta-shaped proposal with the opencode-go target and the V0 cap');
  assert.equal(enforced.reasoningEffort, 'medium');
  pass('7: adaptive Governor effort (medium/discover) overrides the static xhigh default');
  const endpoint = await startMockProvider(function(req, res) {
    readBody(req).then(function(received) {
      const effort = received && received.reasoning_effort;
      const body = { id: 'chatcmpl-oc', object: 'chat.completion', model: 'muse-spark-1.3-contributor', choices: [{ index: 0, message: { role: 'assistant', content: 'OPENCODE-OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, echo: { reasoning_effort: effort === undefined ? null : effort } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  try {
    process.env.OPENCODE_API_KEY = TEST_KEY;
    const seen2 = await probe.runProbe({ baseUrl: endpoint.baseUrl, apiKeyEnv: 'OPENCODE_API_KEY', model: 'muse-spark-1.3-contributor', prompt: 'Reply NEXUS.', reasoningEffort: enforced.reasoningEffort, timeoutMs: 15000 });
    assert.equal(seen2.outcome.ok, true);
    assert.equal(seen2.outcome.content, 'OPENCODE-OK');
    pass('8a: opencode-go transport round trip carries text through the shared probe transport');
  } finally { delete process.env.OPENCODE_API_KEY; endpoint.server.close(); }
  const wireDir = fs.mkdtempSync(require('node:os').tmpdir() + '/muse-oc-wire-');
  const echoPath = wireDir + '/echo.json';
  fs.writeFileSync(echoPath, JSON.stringify({ status: 200, body: { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }, echoRequest: true }), 'utf8');
  process.env.OPENCODE_API_KEY = TEST_KEY;
  try {
    const echoed = await probe.runProbe({ baseUrl: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_API_KEY', model: 'muse-spark-1.3-contributor', prompt: 'ok', reasoningEffort: enforced.reasoningEffort, mockFile: echoPath, timeoutMs: 15000 });
    assert.equal(echoed.outcome.ok, true);
    assert.equal(echoed.outcome.resulting.reasoning_effort, enforced.reasoningEffort);
    pass('8b: resolved adaptive effort reaches the OpenCode wire body verbatim');
  } finally { delete process.env.OPENCODE_API_KEY; fs.rmSync(wireDir, { recursive: true, force: true }); }  const failDir = fs.mkdtempSync(require('node:os').tmpdir() + '/muse-oc-fail-');
  try {
    const cases = [[401, 'authentication failure'], [429, 'rate limit'], [402, 'quota exhausted'], [503, 'provider unavailable']];
    for (let ci = 0; ci < cases.length; ci++) {
      const status = cases[ci][0];
      const label = cases[ci][1];
      const docPath = failDir + '/e' + status + '.json';
      fs.writeFileSync(docPath, JSON.stringify({ status: status, body: { error: { message: 'synthetic ' + status, type: 'provider_error' } } }), 'utf8');
      process.env.OPENCODE_API_KEY = TEST_KEY;
      const failed = await probe.runProbe({ baseUrl: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_API_KEY', model: 'muse-spark-1.3-contributor', prompt: 'hi', mockFile: docPath, timeoutMs: 15000 });
      delete process.env.OPENCODE_API_KEY;
      assert.equal(failed.outcome.ok, false);
      assert.equal(failed.outcome.status, status);
      assert.ok(JSON.stringify(failed.outcome).indexOf('meta-model-api') === -1, 'failure outcome never names the Meta route (' + label + ')');
    }
    pass('9: auth/rate-limit/quota/unavailable failures normalize with status and never reference meta-model-api');
    const malformed = probe.parseSseBlock('data: {not-json');
    assert.equal(malformed.error, 'stream-malformed');
    pass('9b: malformed streaming chunks stay distinguishable provider errors');
  } finally { fs.rmSync(failDir, { recursive: true, force: true }); }
  const after = isolation.controllerTargetFor(installRoot, isolation.bindingFor(installRoot, 'sess-oc'));
  assert.equal(after.provider, 'opencode-go');
  assert.equal(after.profile, 'muse-spark-1.3-contributor-opencode');
  const bindingsDoc = JSON.parse(fs.readFileSync(installRoot + '/data/routing/session-bindings.json', 'utf8'));
  assert.equal(bindingsDoc.bindings['sess-oc'].engine, 'muse');
  pass('10: provider/profile binding is stable after simulated failures (no silent migration)');
  const settingsText = fs.readFileSync(path.join(repoRoot, 'config', 'settings.yaml'), 'utf8');
  assert.ok(settingsText.indexOf('opencode-go:') !== -1 && settingsText.indexOf('OPENCODE_API_KEY') !== -1 && settingsText.indexOf('https://opencode.ai/zen/go/v1') !== -1);
  pass('11: provider route opencode-go with OPENCODE_API_KEY reference at the Go baseURL is declared');
  const roles = ['primaryEngineer', 'deepEngineer', 'reviewer', 'solver', 'fallback', 'visualReviewer'];
  for (let ri = 0; ri < roles.length; ri++) {
    const ids = engineering.compatibleModelsForRole(ocRegistry, roles[ri]);
    assert.ok(ids.indexOf('muse-spark-1.3-contributor') === -1, 'meta muse absent from ' + roles[ri]);
    assert.ok(ids.indexOf('muse-spark-1.3-contributor-opencode') === -1, 'opencode muse absent from ' + roles[ri]);
  }
  pass('13: neither Muse entry serves any Dual role (Dual engine unchanged)');
  await substrateSection();
  delete process.env.DSH_HOME;
  delete process.env.AIH_INSTALL_ROOT;
  fs.rmSync(installRoot, { recursive: true, force: true });
  console.log('RESULT: ' + passed + ' MuseOpenCodeGo assertions passed.');
}
function substrateSection() {
  const { spawnSync } = require('node:child_process');
  const probeScript = path.join(repoRoot, 'scripts', 'Invoke-ProviderSubstrateProbe.mjs');
  const roots = [
    path.join(repoRoot, 'app', 'node_modules'),
    '/home/kaloyan/.local/share/nexus/app/node_modules',
  ];
  let packagesRoot = null;
  for (let i = 0; i < roots.length; i++) {
    try {
      fs.accessSync(path.join(roots[i], '@deepseek-ai', 'dsh-llm-pi-ai'));
      packagesRoot = roots[i];
      break;
    } catch (e) { /* next */ }
  }
  if (!fs.existsSync(probeScript) || !packagesRoot) {
    console.log('NOTE: pinned substrate packages not present; substrate section skipped');
    return Promise.resolve();
  }
  const managedSettings = path.join(repoRoot, 'config', 'settings.yaml');
  const checkOne = function(provider) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-oc-sub-'));
    const outFile = path.join(outDir, 'record.json');
    const res = spawnSync(process.execPath, [probeScript, '--settings', managedSettings, '--packages', packagesRoot, '--provider', provider, '--model', 'muse-spark-1.3-contributor', '--out', outFile], { encoding: 'utf8', timeout: 90000, stdio: 'ignore' });
    assert.equal(res.status, 0, 'substrate probe must pass for ' + provider);
    const record = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    fs.rmSync(outDir, { recursive: true, force: true });
    return record;
  };
  const metaRec = checkOne('meta-model-api');
  assert.equal(metaRec.status, 'ready');
  const ocRec = checkOne('opencode-go');
  assert.equal(ocRec.status, 'ready');
  pass('14a: real substrate registers BOTH meta-model-api and opencode-go (adding Go does not break Meta)');
  assert.equal(ocRec.model, 'muse-spark-1.3-contributor');
  const ocChecks = ocRec.checks.filter(function(c) { return c.ok; }).map(function(c) { return c.name; });
  const needed = ['settings-loaded', 'section-present', 'section-schema-valid', 'adapter-registered', 'route-registered', 'list-models:muse-spark-1.3-contributor', 'resolve-model', 'context-window', 'output-ceiling', 'image-input', 'reasoning-level:minimal', 'reasoning-level:low', 'reasoning-level:medium', 'reasoning-level:high', 'reasoning-level:xhigh', 'reasoning-level-refused:off', 'reasoning-level-refused:max'];
  for (let i = 0; i < needed.length; i++) {
    assert.ok(ocChecks.indexOf(needed[i]) !== -1, 'substrate check missing/failed on opencode-go: ' + needed[i]);
  }
  pass('14b: opencode-go resolves model muse-spark-1.3-contributor, window 1048576, ceiling 131072, image input, levels minimal..xhigh, no off/max');
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-oc-sub-bad-'));
  const badSettings = path.join(badDir, 'settings.yaml');
  const badDoc = [
    'llm-pi-ai:',
    '  providers:',
    '    meta-model-api:',
    '      displayName: Meta Model API (Muse Spark 1.3 Contributor, direct)',
    '      apiKeyEnv: MODEL_API_KEY',
    '      api: openai-completions',
    '      baseURL: https://api.meta.ai/v1',
    '      reasoning: xhigh',
    '      models:',
    '        - id: muse-spark-1.3-contributor',
    '          contextWindow: 1048576',
    '          maxTokens: 131072',
    '    opencode-go:',
    '      displayName: OpenCode Go (Muse Spark 1.3 Contributor over Responses)',
    '      apiKeyEnv: OPENCODE_API_KEY',
    '      api: openai-responses',
    '      baseURL: https://opencode.ai/zen/go/v1',
    '      reasoning: xhigh',
    '      compat:',
    '        supportsDeveloperRole: true',
    '        maxTokensField: max_completion_tokens',
    '      models:',
    '        - id: muse-spark-1.3-contributor',
    '          contextWindow: 1048576',
    '          maxTokens: 131072',
  ].join(chr(10)) + chr(10);
  fs.writeFileSync(badSettings, badDoc, 'utf8');
  const bad = spawnSync(process.execPath, [probeScript, '--settings', badSettings, '--packages', packagesRoot, '--provider', 'opencode-go', '--model', 'muse-spark-1.3-contributor'], { encoding: 'utf8', timeout: 90000, stdio: 'ignore' });
  fs.rmSync(badDir, { recursive: true, force: true });
  assert.notEqual(bad.status, 0, 'one invalid managed compat field must fail the substrate probe before installation');
  pass('14c: one invalid managed provider (stale maxTokensField) fails closed at substrate validation — never silently ships');
  return Promise.resolve();
}
main().then(function() { /* done */ }, function(error) {
  console.error('FAIL: ' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});