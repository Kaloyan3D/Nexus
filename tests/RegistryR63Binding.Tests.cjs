'use strict';
// Registry R6.3 - flagged session binding: pure unit checks plus the REAL
// controller boundary (AihController.apply turns through Task/Route PS).
// Flag OFF binds byte-identical legacy. Flag ON pins parity-proven targets,
// fails closed on drift, and rolls back without silent substitution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const sessionBinding = require('../config/registry/session-binding.cjs');
const shadow = require('../config/registry/shadow-binding.cjs');
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
function userMessage(text) { return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: text }] }; }
function parityShadow() {
  return { shadowOk: true, parity: true, code: 'shadow-parity', modeId: 'engineering-v1', preset: 'aih-engineering', engine: 'dual', role: 'primaryEngineer', lockedPreset: false, resolutionId: 'ab12cd34ef56ab78', configRevision: 0, staged: { persisted: false, source: 'legacy-preview', adoptedFrom: 'deepseek-codex', revision: 0 }, projected: { provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'high', modelId: 'deepseek-v4-flash', logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', connectionId: 'conn-flash-high-direct', executionKind: 'raw-model', accessType: 'api-key', dataUseTier: null }, mismatches: [], errors: [] };
}
function dualDecision() { return { preset: 'aih-engineering', engine: 'dual', executionClass: 'engineer_normal', role: 'primaryEngineer', profile: 'deepseek-codex', provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'high', writable: true }; }
(async () => {
await check('R6.3 flag defaults OFF and enables only on exact opt-in', () => {
  assert.equal(sessionBinding.isRegistryBindingEnabled({}), false);
  assert.equal(sessionBinding.isRegistryBindingEnabled(undefined), false);
  assert.equal(sessionBinding.isRegistryBindingEnabled({ NEXUS_REGISTRY_BINDING: '0' }), false);
  assert.equal(sessionBinding.isRegistryBindingEnabled({ NEXUS_REGISTRY_BINDING: 'true' }), false);
  assert.equal(sessionBinding.isRegistryBindingEnabled({ NEXUS_REGISTRY_BINDING: '1' }), true);
});
await check('R6.3 parity evaluation pins the complete generation identity', () => {
  const v = sessionBinding.evaluateRegistryBinding(dualDecision(), parityShadow(), { nowUtc: () => '2026-10-11T00:00:00.000Z' });
  assert.equal(v.ok, true); assert.equal(v.code, 'registry-bound');
  assert.equal(v.pin.authority, 'registry'); assert.equal(v.pin.resolutionId, 'ab12cd34ef56ab78');
  assert.equal(v.pin.configRevision, 0); assert.equal(v.pin.role, 'primaryEngineer');
  assert.equal(v.pin.roleTarget.provider, 'flash-high-direct'); assert.equal(v.pin.roleTarget.reasoning, 'high');
  assert.equal(v.pin.roleTarget.routeId, 'flash-high-direct/deepseek-v4-flash');
  assert.equal(v.pin.boundAtUtc, '2026-10-11T00:00:00.000Z');
});
await check('R6.3 mismatch, failed compile, and missing identity fail closed', () => {
  const mm = Object.assign({}, parityShadow(), { parity: false, code: 'shadow-mismatch', mismatches: [{ code: 'reasoning-mismatch', field: 'reasoning', message: 'x' }] });
  const r1 = sessionBinding.evaluateRegistryBinding(dualDecision(), mm, {});
  assert.equal(r1.ok, false); assert.equal(r1.code, 'registry-binding-mismatch');
  const bad = { shadowOk: false, parity: false, code: 'shadow-compile-failed', errors: [{ code: 'connection-auth-required', message: 'revoked' }] };
  const r2 = sessionBinding.evaluateRegistryBinding(dualDecision(), bad, {});
  assert.equal(r2.ok, false); assert.equal(r2.code, 'registry-binding-unavailable');
  assert.equal(r2.errors[0].code, 'connection-auth-required');
  const nopin = Object.assign({}, parityShadow(), { resolutionId: null });
  const r3 = sessionBinding.evaluateRegistryBinding(dualDecision(), nopin, {});
  assert.equal(r3.ok, false); assert.equal(r3.code, 'registry-binding-unpinned');
});
await check('R6.3 stale and revoked connection evidence fail closed', () => {
  const fresh = { connectionId: 'conn-sol-local', status: 'connected', checkedAtUtc: new Date(Date.now() - 60000).toISOString() };
  const rok = sessionBinding.evaluateRegistryBinding(dualDecision(), parityShadow(), { connectionEvidence: fresh });
  assert.equal(rok.ok, true); assert.equal(rok.pin.connectionLiveCheck, 'evidence-fresh');
  const stale = { connectionId: 'conn-sol-local', status: 'connected', checkedAtUtc: new Date(Date.now() - 3600000).toISOString() };
  const r1 = sessionBinding.evaluateRegistryBinding(dualDecision(), parityShadow(), { connectionEvidence: stale });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'registry-evidence-stale');
  const rev = { connectionId: 'conn-sol-local', status: 'revoked', checkedAtUtc: new Date().toISOString() };
  const r2 = sessionBinding.evaluateRegistryBinding(dualDecision(), parityShadow(), { connectionEvidence: rev });
  assert.equal(r2.ok, false); assert.equal(r2.code, 'registry-connection-revoked');
  const noStamp = { connectionId: 'conn-sol-local', status: 'connected' };
  const r3 = sessionBinding.evaluateRegistryBinding(dualDecision(), parityShadow(), { connectionEvidence: noStamp });
  assert.equal(r3.ok, false); assert.equal(r3.code, 'registry-evidence-stale');
});
await check('R6.3 pin verification detects drift; rollback keeps the target', () => {
  const pin = sessionBinding.evaluateRegistryBinding(dualDecision(), parityShadow(), {}).pin;
  assert.equal(sessionBinding.verifyPinnedBinding(dualDecision(), pin).ok, true);
  const drifted = Object.assign({}, dualDecision(), { provider: 'flash-max-direct' });
  const bad = sessionBinding.verifyPinnedBinding(drifted, pin);
  assert.equal(bad.ok, false); assert.equal(bad.code, 'registry-pin-mismatch');
  assert.equal(bad.mismatches[0].field, 'provider');
  const rb = sessionBinding.rollbackPinnedBinding(dualDecision(), pin);
  assert.equal(rb.ok, true); assert.equal(rb.pin.authority, 'legacy-rollback');
  assert.deepEqual(rb.pin.roleTarget, pin.roleTarget, 'rollback never substitutes the target');
  const rbBad = sessionBinding.rollbackPinnedBinding(drifted, pin);
  assert.equal(rbBad.ok, false); assert.equal(rbBad.code, 'registry-pin-mismatch');
});
await check('R6.3 flag activation is unreachable from the web interface', () => {
  const hits = [];
  function scan(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (name !== 'node_modules' && name !== '.git') scan(p); }
      else if (/\.(cjs|js|ts|tsx|ps1|json)$/.test(name)) {
        const text = fs.readFileSync(p, 'utf8');
        if (text.indexOf('NEXUS_REGISTRY_BINDING') !== -1) hits.push(path.relative(repoRoot, p));
      }
    }
  }
  scan(path.join(repoRoot, 'ui'));
  assert.deepEqual(hits, [], 'no UI file references the flag: ' + JSON.stringify(hits));
  const ctrlText = fs.readFileSync(path.join(repoRoot, 'config', 'AihController.cjs'), 'utf8');
  assert.equal(ctrlText.indexOf('NEXUS_REGISTRY_BINDING'), -1, 'controller uses the module gate, not the env literal');
});function buildFixture() {
  const installRoot = tmpDir('r63-root-');
  const dataHome = path.join(installRoot, 'data');
  fs.mkdirSync(dataHome, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(installRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'config'), path.join(installRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'ui', 'nexus-controller', 'lib'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'), path.join(installRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'));
  fs.writeFileSync(path.join(dataHome, 'settings.yaml'), 'engineering-profile: deepseek-codex\n');
  const fixture = tmpDir('r63-ws-');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true }));
  return { installRoot: installRoot, dataHome: dataHome, fixture: fixture };
}
function makeSession(id, cwd) {
  return { id: id, header: { cwd: cwd, agentPreset: 'aih-engineering' }, messages: [], append: function (k, m) { this.messages.push({ kind: k, message: m }); } };
}
const prevHome = process.env.DSH_HOME;
const prevRoot = process.env.AIH_INSTALL_ROOT;
const prevFlag = process.env.NEXUS_REGISTRY_BINDING;
const fix = buildFixture();
process.env.DSH_HOME = fix.dataHome;
process.env.AIH_INSTALL_ROOT = fix.installRoot;
delete process.env.NEXUS_REGISTRY_BINDING;
const controller = require('../config/AihController.cjs');
const profiles = require('../config/Engineering-Profiles.cjs');
function boot() { const handlers = {}; const ctx = { on: function (ev, fn) { handlers[ev] = fn; }, shellEnv: { register: function () {} } }; controller.apply(ctx); return handlers['agent/pre-step']; }
async function turn(preStep, sessionId, text) { const session = makeSession(sessionId, fix.fixture); const agent = { session: session }; await preStep({ agent: agent, messages: [userMessage(text)], step: 1, turn: 'x' }, function () { return 'next'; }); return session; }
function readBindings() { return JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8')).bindings; }
const TURN_TEXT = 'Fix null handling in workspace resolver';
await check('R6.3 OFF binds byte-identical legacy at the real boundary', async () => {
  await turn(boot(), 's-off', TURN_TEXT);
  const b = readBindings()['s-off'];
  assert.ok(b && b.taskInstanceId, 'session bound');
  assert.equal(b.engine, 'dual'); assert.equal(b.executionClass, 'engineer_normal');
  const keys = Object.keys(b).sort();
  assert.deepEqual(keys, ['boundAtUtc', 'checkoutId', 'checkoutRootPath', 'description', 'engine', 'executionClass', 'executionRoot', 'needsRouteCheck', 'preset', 'repositoryId', 'reviewRequired', 'sessionId', 'taskId', 'taskInstanceId', 'workspace', 'workspaceId'], 'no new persisted fields when flag OFF: ' + JSON.stringify(keys));
});
let pinOn = null;
await check('R6.3 ON pins the parity-proven target at the real boundary', async () => {
  process.env.NEXUS_REGISTRY_BINDING = '1';
  await turn(boot(), 's-on', TURN_TEXT);
  const b = readBindings()['s-on'];
  assert.equal(b.bindingAuthority, 'registry');
  assert.ok(b.registryPin && b.registryPin.resolutionId && b.registryPin.resolutionId.length >= 16, 'resolution pinned');
  assert.equal(b.registryPin.role, 'primaryEngineer');
  assert.equal(b.registryPin.roleTarget.provider, 'flash-high-direct');
  assert.equal(b.registryPin.roleTarget.model, 'deepseek-v4-flash');
  assert.equal(b.registryPin.roleTarget.reasoning, 'high');
  assert.equal(b.registryPin.configRevision, 0);
  const tgt = profiles.resolveTarget(fix.installRoot, 'deepseek-codex', 'primaryEngineer');
  assert.equal(tgt.provider, b.registryPin.roleTarget.provider);
  assert.equal(tgt.model, b.registryPin.roleTarget.model);
  assert.equal(tgt.reasoning, b.registryPin.roleTarget.reasoning);
  pinOn = JSON.parse(JSON.stringify(b.registryPin));
});
await check('R6.3 rollback keeps enforcing the pin under legacy authority', async () => {
  assert.ok(pinOn, 'flag-ON pin captured above');
  const oldInstance = readBindings()['s-on'].taskInstanceId;
  delete process.env.NEXUS_REGISTRY_BINDING;
  fs.writeFileSync(path.join(fix.fixture, '.ai-harness', 'state', 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextSequence: 1, tasks: [] }));
  fs.rmSync(path.join(fix.fixture, '.ai-harness', 'runs'), { recursive: true, force: true });
  await turn(boot(), 's-on', TURN_TEXT);
  const b = readBindings()['s-on'];
  assert.notEqual(b.taskInstanceId, oldInstance, 'recovery creates a new generation');
  assert.equal(b.bindingAuthority, 'legacy-rollback');
  assert.deepEqual(b.registryPin.roleTarget, pinOn.roleTarget, 'rollback never substitutes the target');
  assert.equal(b.registryPin.resolutionId, pinOn.resolutionId);
});
await check('R6.3 staged drift fails the bind closed at the real boundary', async () => {
  process.env.NEXUS_REGISTRY_BINDING = '1';
  const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome });
  const staged = svc.getModeConfiguration('engineering-v1', {});
  const cfg = JSON.parse(JSON.stringify(staged.result.config));
  cfg.slots.engineer = { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' };
  const saved = svc.save('engineering-v1', cfg, undefined, {});
  assert.equal(saved.ok, true, JSON.stringify(saved.errors || []));
  await turn(boot(), 's-bad', TURN_TEXT);
  const persisted = readBindings()['s-bad'];
  assert.ok(persisted, 'pre-route binding record remains (legacy semantics)');
  assert.ok(!persisted.bindingAuthority && !persisted.registryPin, 'no authority fields on a refused bind');
  const bridgeLog = fs.readFileSync(path.join(fix.dataHome, 'logs', 'aih-controller.log'), 'utf8');
  const refused = bridgeLog.split('\n').filter(function (l) { return l.indexOf('registry-binding-mismatch') !== -1 && l.indexOf('s-bad') !== -1; });
  assert.ok(refused.length >= 1, 'exact fail-closed code observable in controller log for s-bad');
});
if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
if (prevRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = prevRoot;
if (prevFlag === undefined) delete process.env.NEXUS_REGISTRY_BINDING; else process.env.NEXUS_REGISTRY_BINDING = prevFlag;
try { fs.rmSync(fix.installRoot, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(fix.fixture, { recursive: true, force: true }); } catch (e) {}
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
if (failed > 0) { console.log('FAILURES:'); console.log(failures.join(String.fromCharCode(10))); process.exitCode = 1; }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });