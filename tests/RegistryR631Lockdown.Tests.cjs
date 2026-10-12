'use strict';
// Registry R6.3.1 lockdown: adversarial regressions for rejected-bind reuse
// and per-turn pin bypass. Part 1 is pure (planned map/plan/authorization
// APIs); Part 2 drives the real controller pre-step boundary, real Route.ps1
// decisions, and real child-process restarts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const shadow = require('../config/registry/shadow-binding.cjs');
const sessionBinding = require('../config/registry/session-binding.cjs');
const registry = require('../config/registry/index.cjs');
let passed = 0; let failed = 0; const failures = [];
function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log('PASS: ' + label); }).catch((e) => { failed++; failures.push(label + ' :: ' + (e && e.message)); console.log('FAIL: ' + label + ' :: ' + (e && e.message)); });
    }
    passed++; console.log('PASS: ' + label);
  } catch (e) { failed++; failures.push(label + ' :: ' + (e && e.message)); console.log('FAIL: ' + label + ' :: ' + (e && e.message)); }
  return undefined;
}
function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanEnv() { const e = Object.assign({}, process.env); delete e.DSH_AIH_PRESET; delete e.DSH_AIH_PROFILE; delete e.AIH_ACTIVE_PRESET; delete e.AIH_ACTIVE_PROFILE; return e; }
function runRoute(args, label) {
  return new Promise((resolve, reject) => {
    const argv = ['-NoProfile', '-NoLogo', '-File', path.join(repoRoot, 'scripts', 'Route.ps1')].concat(args);
    cp.execFile('pwsh', argv, { cwd: repoRoot, env: cleanEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout || ''); const start = text.indexOf('{');
      if (err || start < 0) { reject(new Error(label + ': no decision: ' + String((err && err.message) || stderr || text).slice(0, 300))); return; }
      try { resolve(JSON.parse(text.slice(start))); } catch (e2) { reject(new Error(label + ': unparseable')); }
    });
  });
}
const WS = tmpDir('r631-ws-');
const DESC = 'Fix null handling in workspace resolver';
function dualArgs(extra) { return ['-Description', DESC, '-Workspace', WS, '-InstallRoot', repoRoot, '-Preset', 'aih-engineering', '-DryRun'].concat(extra || []); }
(async () => {
const engDecision = await runRoute(dualArgs([]), 'eng');
const glmDecision = await runRoute(dualArgs(['-ProfileId', 'glm-codex']), 'glm');
assert.ok(engDecision.provider !== glmDecision.provider, 'cross-profile decisions really differ: ' + engDecision.provider + ' vs ' + glmDecision.provider);
console.log('  info: eng=' + engDecision.provider + '/' + engDecision.reasoning + ' glm=' + glmDecision.provider + '/' + glmDecision.reasoning);
await check('R6.3.1 shadow projects the complete role-target map', () => {
  const out = shadow.runShadowComparison(engDecision, { installRoot: repoRoot, dataRoot: tmpDir('r631-u1-') });
  assert.equal(out.shadowOk, true);
  assert.ok(out.roleTargets && typeof out.roleTargets === 'object', 'full map present');
  for (const role of ['primaryEngineer', 'reviewer', 'solver']) {
    assert.ok(out.roleTargets[role] && out.roleTargets[role].available === true, 'role pinned in map: ' + role);
  }
  assert.ok(out.connection && out.connection.id, 'decision connection reported with live status');
});
await check('R6.3.1 evaluation pins the map plus generation identity', () => {
  const dataRoot = tmpDir('r631-u2-');
  const out = shadow.runShadowComparison(engDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  const v = sessionBinding.evaluateRegistryBinding(engDecision, out, { bindTask: { taskId: 'TASK-9', taskInstanceId: 'task_x' } });
  assert.equal(v.ok, true);
  assert.ok(v.pin.roleTargets && v.pin.roleTargets.reviewer && v.pin.roleTargets.reviewer.available === true, 'map pinned');
  assert.equal(v.pin.taskInstanceId, 'task_x'); assert.equal(v.pin.taskId, 'TASK-9');
  assert.ok(v.pin.authorization && typeof v.pin.authorization.verifiedAtBind === 'boolean', 'honest authorization record');
  assert.ok(v.pin.authorization.note.indexOf('no live probe') !== -1, 'no request-time fairy tales: ' + v.pin.authorization.note);
});
await check('R6.3.1 transition planner routes every session state', () => {
  const plan = sessionBinding.planTransition;
  const pin = { taskInstanceId: 'task_a', roleTargets: { primaryEngineer: { available: true, target: { provider: 'p', model: 'm', reasoning: 'r' } } } };
  const dec = { taskInstanceId: 'task_a', role: 'primaryEngineer', engine: 'dual', provider: 'p', model: 'm', reasoning: 'r' };
  assert.equal(plan({ binding: { registryPin: pin }, decision: dec, flagOn: true, isInitialBind: false }).action, 'verify');
  assert.equal(plan({ binding: { registryPin: pin }, decision: dec, flagOn: false, isInitialBind: false }).action, 'verify');
  assert.equal(plan({ binding: { registryPin: pin }, decision: Object.assign({}, dec, { taskInstanceId: 'task_b' }), flagOn: true, isInitialBind: false }).action, 'evaluate-fresh');
  assert.equal(plan({ binding: { registryRefused: { code: 'x' } }, decision: dec, flagOn: true, isInitialBind: false }).action, 'evaluate-fresh');
  assert.equal(plan({ binding: { registryRefused: { code: 'x' } }, decision: dec, flagOn: false, isInitialBind: false }).action, 'rollback-refused');
  assert.equal(plan({ binding: {}, decision: dec, flagOn: true, isInitialBind: true }).action, 'evaluate-fresh');
  assert.equal(plan({ binding: {}, decision: dec, flagOn: true, isInitialBind: false }).action, 'proceed-legacy');
  assert.equal(plan({ binding: {}, decision: dec, flagOn: false, isInitialBind: true }).action, 'proceed-legacy');
});
await check('R6.3.1 map verification guards every role, refusing unknown ones', async () => {
  const dataRoot = tmpDir('r631-u4-');
  const out = shadow.runShadowComparison(engDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  const pin = sessionBinding.evaluateRegistryBinding(engDecision, out, { bindTask: { taskId: 't', taskInstanceId: engDecision.taskInstanceId || 'g' } }).pin;
  const rev = await runRoute(dualArgs(['-ReviewRequested']), 'rev4');
  const okRev = sessionBinding.verifyTransitionTarget(rev, pin);
  assert.equal(okRev.ok, true, JSON.stringify(okRev.mismatches || []));
  const trimmed = JSON.parse(JSON.stringify(pin)); delete trimmed.roleTargets.reviewer;
  const noRole = sessionBinding.verifyTransitionTarget(rev, trimmed);
  assert.equal(noRole.ok, false); assert.equal(noRole.code, 'registry-role-unpinned');
  const cross = sessionBinding.verifyTransitionTarget(glmDecision, pin);
  assert.equal(cross.ok, false); assert.equal(cross.code, 'registry-pin-mismatch');
});
await check('R6.3.1 authorization mirrors live connection rules exactly', () => {
  const az = sessionBinding.authorizationForTransition;
  assert.equal(az({ id: 'c', status: 'connected', provenance: 'x' }).ok, true);
  assert.equal(az({ id: 'c', status: 'unknown', provenance: 'legacy-production-use' }).ok, true);
  assert.equal(az({ id: 'c', status: 'revoked', provenance: 'legacy' }).ok, false);
  assert.equal(az({ id: 'c', status: 'revoked', provenance: 'legacy' }).code, 'registry-authorization-revoked');
  assert.equal(az({ id: 'c', status: 'unknown', provenance: 'operator-attested' }).ok, false);
  assert.equal(az(null).ok, false);
});
await check('R6.3.1 step targets validate against the pinned map', () => {
  const dataRoot = tmpDir('r631-u6-');
  const out = shadow.runShadowComparison(engDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  const pin = sessionBinding.evaluateRegistryBinding(engDecision, out, { bindTask: { taskId: 't', taskInstanceId: 'g' } }).pin;
  const good = sessionBinding.validateStepTarget(pin, 'primaryEngineer', { provider: engDecision.provider, model: engDecision.model, reasoning: engDecision.reasoning });
  assert.equal(good.ok, true);
  const bad = sessionBinding.validateStepTarget(pin, 'primaryEngineer', { provider: 'evil-provider', model: engDecision.model, reasoning: engDecision.reasoning });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'registry-step-target-mismatch');
  const missing = sessionBinding.validateStepTarget(pin, 'no-such-role', { provider: 'p', model: 'm', reasoning: 'r' });
  assert.equal(missing.ok, false); assert.equal(missing.code, 'registry-role-unpinned');
});function buildFixture() {
  const installRoot = tmpDir('r631-root-');
  const dataHome = path.join(installRoot, 'data');
  fs.mkdirSync(dataHome, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(installRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'config'), path.join(installRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'ui', 'nexus-controller', 'lib'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'), path.join(installRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'));
  fs.writeFileSync(path.join(dataHome, 'settings.yaml'), 'engineering-profile: deepseek-codex\n');
  const fixture = tmpDir('r631-ws-');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true }));
  return { installRoot: installRoot, dataHome: dataHome, fixture: fixture };
}
function makeSession(id, cwd) { return { id: id, header: { cwd: cwd, agentPreset: 'aih-engineering' }, messages: [], append: function (k, m) { this.messages.push({ kind: k, message: m }); } }; }
function userMessage(text) { return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: text }] }; }
const prevHome = process.env.DSH_HOME; const prevRoot = process.env.AIH_INSTALL_ROOT; const prevFlag = process.env.NEXUS_REGISTRY_BINDING;
const fix = buildFixture();
process.env.DSH_HOME = fix.dataHome; process.env.AIH_INSTALL_ROOT = fix.installRoot; delete process.env.NEXUS_REGISTRY_BINDING;
const controller = require('../config/AihController.cjs');
const profiles = require('../config/Engineering-Profiles.cjs');
function boot() { const handlers = {}; const ctx = { on: function (ev, fn) { handlers[ev] = fn; }, shellEnv: { list: function () { return [] }, register: function () {} } }; controller.apply(ctx); return handlers['agent/pre-step']; }
async function turn(preStep, sessionId, text) { const session = makeSession(sessionId, fix.fixture); const agent = { session: session }; await preStep({ agent: agent, messages: [userMessage(text)], step: 1, turn: 'x' }, function () { return 'next'; }); }
function readBindings() { return JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8')).bindings; }
function logLines() { try { return fs.readFileSync(path.join(fix.dataHome, 'logs', 'aih-controller.log'), 'utf8').split('\n'); } catch (e) { return []; } }
function refusalLines(sid) { return logLines().filter(function (l) { return l.indexOf(sid) !== -1 && (l.indexOf('registry-binding-mismatch') !== -1 || l.indexOf('registry-pin-mismatch') !== -1 || l.indexOf('registry-authorization-') !== -1 || l.indexOf('registry-still-refused') !== -1); }); }
const CHILD = path.join(os.tmpdir(), 'r631-turn-' + String(process.pid) + '.cjs');
fs.writeFileSync(CHILD, [
  "const fs = require('node:fs'); const path = require('node:path');",
  'const repoRoot = ' + JSON.stringify(repoRoot) + ';',
  'const dataHome = ' + JSON.stringify(fix.dataHome) + ';',
  'const installRoot = ' + JSON.stringify(fix.installRoot) + ';',
  'const fixture = ' + JSON.stringify(fix.fixture) + ';',
  'const sessionId = ' + JSON.stringify('') + ';',
  'async function main() {',
  '  const argv = process.argv.slice(2);',
  '  const sid = argv[0]; const text = argv[1]; const flag = argv[2];',
  '  process.env.DSH_HOME = dataHome; process.env.AIH_INSTALL_ROOT = installRoot;',
  '  if (flag === "1") process.env.NEXUS_REGISTRY_BINDING = "1"; else delete process.env.NEXUS_REGISTRY_BINDING;',
  '  const controller = require(path.join(repoRoot, "config", "AihController.cjs"));',
  '  const handlers = {}; controller.apply({ on: function (ev, fn) { handlers[ev] = fn; }, shellEnv: { list: function () { return [] }, register: function () {} } });',
  '  const session = { id: sid, header: { cwd: fixture, agentPreset: "aih-engineering" }, messages: [], append: function () {} };',
  '  const um = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: text }] };',
  '  await handlers["agent/pre-step"]({ agent: { session: session }, messages: [um], step: 1, turn: "x" }, function () { return "next"; });',
  '  const bindings = JSON.parse(fs.readFileSync(path.join(dataHome, "routing", "session-bindings.json"), "utf8")).bindings;',
  '  console.log("CHILD-RESULT " + JSON.stringify(bindings[sid] || null));',
  '}',
  'main().then(function () {}, function (e) { console.error("CHILD-ERROR " + String((e && e.message) || e)); process.exitCode = 1; });',
].join('\n'));
function childTurn(sid, text, flag) {
  return new Promise((resolve, reject) => {
    cp.execFile(process.execPath, [CHILD, sid, text, flag], { cwd: repoRoot, env: cleanEnv(), timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const line = String(stdout || '').split('\n').find(function (l) { return l.indexOf('CHILD-RESULT ') === 0; });
      if (err || !line) { reject(new Error('child turn failed for ' + sid + ': ' + String((err && err.message) || stderr || stdout).slice(0, 400))); return; }
      try { resolve(JSON.parse(line.slice('CHILD-RESULT '.length))); } catch (e) { reject(new Error('child result unparseable')); }
    });
  });
}
function stageEngineer(slot) { const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome }); const st = svc.getModeConfiguration('engineering-v1', {}); const cfg = JSON.parse(JSON.stringify(st.result.config)); cfg.slots.engineer = slot; const rev = (st.result && st.result.persisted) ? st.result.config.revision : undefined; return svc.save('engineering-v1', cfg, rev, {}); }
function driftStage() { return stageEngineer({ logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' }); }
function fixStage() { return stageEngineer({ logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', reasoning: 'high' }); }
const TURN = 'Fix null handling in workspace resolver';
let decisionsPrefix = null;
await check('R6.3.1 OFF fresh session stays byte-identical legacy', async () => {
  await turn(boot(), 's-off', TURN);
  const b = readBindings()['s-off'];
  assert.ok(b && b.taskInstanceId);
  assert.ok(!b.bindingAuthority && !b.registryPin && !b.registryRefused, 'no registry fields');
  decisionsPrefix = fs.readFileSync(path.join(fix.dataHome, 'routing', 'decisions.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; });
});
await check('R6.3.1 ON mismatch refuses the first turn', async () => {
  assert.equal(driftStage().ok, true);
  process.env.NEXUS_REGISTRY_BINDING = '1';
  await turn(boot(), 's-r1', TURN);
  const b = readBindings()['s-r1'];
  assert.ok(b, 'provisional record remains');
  assert.ok(!b.bindingAuthority && !b.registryPin, 'nothing pinned');
  assert.equal(refusalLines('s-r1').length >= 1, true, 'exact refusal code in log');
});
await check('R6.3.1 second turn cannot bypass the rejection', async () => {
  await turn(boot(), 's-r1', TURN);
  const b = readBindings()['s-r1'];
  assert.ok(!b.bindingAuthority && !b.registryPin, 'still nothing pinned');
  assert.equal(b.needsRouteCheck, true, 'refused generation never completes routing');
  assert.ok(refusalLines('s-r1').length >= 2, 'every retry re-checks loudly, count=' + refusalLines('s-r1').length);
});
await check('R6.3.1 restart cannot launder a rejected generation', async () => {
  const b = await childTurn('s-r1', TURN, '1');
  assert.ok(b && !b.bindingAuthority && !b.registryPin, 'restart keeps refusal, pins nothing');
  assert.equal(b.needsRouteCheck, true);
});
let pinOn = null;
await check('R6.3.1 valid generation pins, then survives restart and staged drift', async () => {
  const saved = fixStage();
  assert.equal(saved.ok, true, JSON.stringify(saved.errors || []));
  await turn(boot(), 's-p1', TURN);
  const b = readBindings()['s-p1'];
  assert.equal(b.bindingAuthority, 'registry');
  pinOn = JSON.parse(JSON.stringify(b.registryPin));
  const again = await childTurn('s-p1', TURN, '1');
  assert.deepEqual(again.registryPin, pinOn, 'restart keeps identical pin');
  assert.equal(again.bindingAuthority, 'registry');
  assert.equal(driftStage().ok, true, 'staged drift after binding');
  const afterDrift = await childTurn('s-p1', TURN, '1');
  assert.deepEqual(afterDrift.registryPin, pinOn, 'staged drift cannot alter the active generation');
});await check('R6.3.1 reviewer transition cannot drift off the pinned role', async () => {
  assert.ok(pinOn, 'pinned generation captured above');
  const profPath = path.join(fix.installRoot, 'config', 'engineering-profiles.json');
  const backup = fs.readFileSync(profPath, 'utf8');
  const routePath = profiles.routingStatePath(fix.installRoot, readBindings()['s-p1']);
  const routeBackup = fs.readFileSync(routePath);
  try {
    const doc = JSON.parse(backup);
    doc.profiles.find(function (p) { return p.id === 'deepseek-codex'; }).roles.reviewer.reasoning = 'low';
    fs.writeFileSync(profPath, JSON.stringify(doc));
    await turn(boot(), 's-p1', '/review the resolver');
    const b = readBindings()['s-p1'];
    assert.equal(b.executionClass, 'engineer_normal', 'drifted reviewer never takes over');
    assert.deepEqual(b.registryPin, pinOn, 'pin untouched by refused transition');
    const hits = logLines().filter(function (l) { return l.indexOf('s-p1') !== -1 && l.indexOf('registry-pin-mismatch') !== -1; });
    assert.ok(hits.length >= 1, 'exact mismatch code in log');
  } finally {
    fs.writeFileSync(profPath, backup);
    // Route persists its candidate before the Registry transition rejects it.
    // Restore this isolated fixture too, so the next authorization test is
    // not intercepted by the new entry check for the previous target drift.
    fs.writeFileSync(routePath, routeBackup);
  }
});
await check('R6.3.1 revoked authorization fails the future execution boundary', async () => {
  const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome });
  const over = svc.setBuiltInConnectionStatus('conn-sol-local', 'revoked', {});
  assert.equal(over.ok, true, JSON.stringify(over.errors || []));
  await turn(boot(), 's-p1', '/review the resolver');
  const b = readBindings()['s-p1'];
  assert.equal(b.executionClass, 'engineer_normal', 'revoked reviewer never executes');
  const hits = logLines().filter(function (l) { return l.indexOf('s-p1') !== -1 && l.indexOf('registry-authorization-revoked') !== -1; });
  assert.ok(hits.length >= 1, 'exact authorization code in log');
});
await check('R6.3.1 rollback preserves refusal history under legacy authority', async () => {
  delete process.env.NEXUS_REGISTRY_BINDING;
  await turn(boot(), 's-r1', TURN);
  const b = readBindings()['s-r1'];
  assert.equal(b.bindingAuthority, 'legacy-rollback');
  assert.ok(b.registryRefused && b.registryRefused.code !== 'registry-pending', 'refusal retained as history: ' + JSON.stringify(b.registryRefused && b.registryRefused.code));
  assert.ok(!b.registryPin, 'no pin invented by rollback');
});
await check('R6.3.1 history append-only, credentials and trees untouched', async () => {
  const after = fs.readFileSync(path.join(fix.dataHome, 'routing', 'decisions.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; });
  assert.ok(after.length >= decisionsPrefix.length, 'history only appended');
  assert.deepEqual(after.slice(0, decisionsPrefix.length), decisionsPrefix, 'no historical record rewritten');
  let status = null;
  try { status = cp.execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { console.log('SKIP: git unavailable'); return; }
  const bad = String(status || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; }).filter(function (l) {
    const p = l.slice(3).trim();
    return p.indexOf('scripts/') === 0 || p.indexOf('data/') === 0 || p.indexOf('ui/') === 0 || (/^config\/.*\.(json|yaml|yml)$/.test(p));
  });
  assert.deepEqual(bad, [], 'protected trees clean: ' + JSON.stringify(bad));
});
if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
if (prevRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = prevRoot;
if (prevFlag === undefined) delete process.env.NEXUS_REGISTRY_BINDING; else process.env.NEXUS_REGISTRY_BINDING = prevFlag;
try { fs.rmSync(fix.installRoot, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(fix.fixture, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(CHILD, { force: true }); } catch (e) {}
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
if (failed > 0) { console.log('FAILURES:'); console.log(failures.join(String.fromCharCode(10))); process.exitCode = 1; }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });
