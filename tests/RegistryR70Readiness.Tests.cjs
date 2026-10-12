const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
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
function userMessage(text) { return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: text }] }; }function buildFixture() {
  const installRoot = tmpDir('r70-root-');
  const dataHome = path.join(installRoot, 'data');
  fs.mkdirSync(dataHome, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(installRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'config'), path.join(installRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'ui', 'nexus-controller', 'lib'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'), path.join(installRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'));
  fs.writeFileSync(path.join(dataHome, 'settings.yaml'), 'engineering-profile: deepseek-codex');
  const fixture = tmpDir('r70-ws-');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src', 'a.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(fixture, 'src', 'huge.js'), 'x'.repeat(140000));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true }));
  const polPath = path.join(installRoot, 'config', 'routing-policy.json');
  const pol = JSON.parse(fs.readFileSync(polPath, 'utf8'));
  pol.codex.automaticReview.enforceLimits = true;
  fs.writeFileSync(polPath, JSON.stringify(pol));
  return { installRoot: installRoot, dataHome: dataHome, fixture: fixture };
}
function makeSession(id, cwd, preset) { return { id: id, header: { cwd: cwd, agentPreset: preset || 'aih-engineering' }, messages: [], append: function (k, m) { this.messages.push([k, m]); } }; }
const prevHome = process.env.DSH_HOME; const prevRoot = process.env.AIH_INSTALL_ROOT; const prevFlag = process.env.NEXUS_REGISTRY_BINDING;
const fix = buildFixture();
process.env.DSH_HOME = fix.dataHome; process.env.AIH_INSTALL_ROOT = fix.installRoot; delete process.env.NEXUS_REGISTRY_BINDING;
const controller = require('../config/AihController.cjs');
function boot() { const handlers = {}; const ctx = { on: function (ev, fn) { handlers[ev] = fn; }, shellEnv: { list: function () { return [] }, register: function () {} } }; controller.apply(ctx); return handlers['agent/pre-step']; }
function countAttempts() { let n = 0; const runs = path.join(fix.fixture, '.ai-harness', 'runs'); try { for (const t of fs.readdirSync(runs)) { try { n += fs.readFileSync(path.join(runs, t, 'attempts.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; }).length; } catch (e) {} } } catch (e) {} return n; }
async function instrumentedTurn(preStep, sid, text, preset) {
  const before = countAttempts(); let nextCount = 0;
  const session = makeSession(sid, fix.fixture, preset);
  const result = await preStep({ agent: { session: session }, messages: [userMessage(text)], step: 1, turn: 'x' }, function () { nextCount++; return 'next'; });
  const kinds = session.messages.map(function (m) { return (m[1] && m[1].source && m[1].source.form) || '?'; });
  return { kind: (typeof result === 'string') ? result : (result && result.kind), nextCount: nextCount, attemptsDelta: countAttempts() - before, kinds: kinds };
}
function readBindings() { return JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8')).bindings; }
function logLines() { try { return fs.readFileSync(path.join(fix.dataHome, 'logs', 'aih-controller.log'), 'utf8').split('\n'); } catch (e) { return []; } }function closeAttempt(taskId, instanceId) {
  return new Promise((resolve, reject) => {
    const env = cleanEnv();
    env.AIH_INSTALL_ROOT = fix.installRoot;
    const argv = ['-NoProfile', '-NoLogo', '-File', path.join(repoRoot, 'scripts', 'Task.ps1'), '-Action', 'attempt-event', '-Workspace', fix.fixture, '-TaskId', taskId, '-Status', 'interrupted', '-Reason', 'r70-test-staging', '-TaskInstanceId', instanceId];
    cp.execFile('pwsh', argv, { cwd: repoRoot, env: env, timeout: 120000, maxBuffer: 1048576 }, (err, stdout, stderr) => {
      if (err) { reject(new Error('closeAttempt failed: ' + String(stderr || (err && err.message) || err).slice(0, 300))); return; }
      resolve(true);
    });
  });
}
function seedMaxAttempts(taskId) {
  const ledgerPath = path.join(fix.fixture, '.ai-harness', 'state', 'tasks.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const task = ledger.tasks.find((t) => t.taskId === taskId);
  task.attempt = task.maxAttempts;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
}
function stageSlots(patch) { const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome }); const st = svc.getModeConfiguration('engineering-v1', {}); const cfg = JSON.parse(JSON.stringify(st.result.config)); Object.assign(cfg.slots, patch); const rev = (st.result && st.result.persisted) ? st.result.config.revision : undefined; return svc.save('engineering-v1', cfg, rev, {}); }
function snapState() {
  let ledger = null;
  try { ledger = fs.readFileSync(path.join(fix.fixture, '.ai-harness', 'state', 'tasks.json'), 'utf8'); } catch (e) { ledger = null; }
  const runs = [];
  const runsRoot = path.join(fix.fixture, '.ai-harness', 'runs');
  try { for (const t of fs.readdirSync(runsRoot)) { const td = path.join(runsRoot, t); try { for (const f of fs.readdirSync(td)) runs.push(t + '/' + f + ':' + fs.readFileSync(path.join(td, f), 'utf8').length); } catch (e) {} } } catch (e) {}
  runs.sort();
  return JSON.stringify({ ledger: ledger, runs: runs });
}
const TURN = 'Fix null handling in workspace resolver';
let decisionsPrefix = null;
(async () => {
await check('R7.0 legacy visual path unchanged', async () => {
  const r0 = await instrumentedTurn(boot(), 's-off', TURN);
  assert.equal(r0.kind, 'next');
  const r = await instrumentedTurn(boot(), 's-off', '/visual-review shot.png');
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
  assert.ok(r.kinds.indexOf('visual-review-error') !== -1, 'legacy visual machinery runs: ' + JSON.stringify(r.kinds));
  decisionsPrefix = fs.readFileSync(path.join(fix.dataHome, 'routing', 'decisions.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; });
});await check('R7.0 refused visual review is rejected pre-transport', async () => {
  assert.equal(stageSlots({ engineer: { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' }, reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'low' } }).ok, true);
  process.env.NEXUS_REGISTRY_BINDING = '1';
  const r1 = await instrumentedTurn(boot(), 's-r1', TURN);
  assert.equal(r1.kind, 'reject');
  const r = await instrumentedTurn(boot(), 's-r1', '/visual-review shot.png');
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
  assert.ok(r.kinds.indexOf('controller-registry-rejected') !== -1, 'gate diagnostic, not review machinery: ' + JSON.stringify(r.kinds));
  assert.equal(r.kinds.indexOf('visual-review-error'), -1, 'review transport never entered');
  assert.equal(r.kinds.indexOf('visual-review-result'), -1, 'no review result');
});
await check('R7.0 refused verify is rejected without records', async () => {
  const before = snapState();
  const r = await instrumentedTurn(boot(), 's-r1', '/verify');
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0);
  assert.ok(r.kinds.indexOf('controller-registry-rejected') !== -1, 'gate diagnostic: ' + JSON.stringify(r.kinds));
  assert.equal(snapState(), before, 'no verification records written');
});
await check('R7.0 explicit review on refused stays rejected', async () => {
  const logBefore = logLines().length;
  const r = await instrumentedTurn(boot(), 's-r1', '/review the resolver');
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
  const hits = logLines().slice(logBefore).filter(function (l) { return l.indexOf('registry-binding-mismatch') !== -1; });
  console.log('R1SLICE ' + JSON.stringify(logLines().slice(logBefore).filter(function (l) { return l.indexOf('s-r1') !== -1; })));
  assert.ok(hits.length >= 1, 'exact choke code in log');
});
await check('R7.0 beginAttempt failure rejects pinned, legacy proceeds', async () => {
  assert.equal(stageSlots({ engineer: { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', reasoning: 'high' }, reviewer: { logicalModelId: 'gpt-5.6-sol', routeId: 'sol-local/gpt-5.6-sol', reasoning: 'medium' } }).ok, true);
  const p = await instrumentedTurn(boot(), 's-beg', TURN);
  assert.equal(p.kind, 'next');
  assert.equal(readBindings()['s-beg'].bindingAuthority, 'registry');
  await closeAttempt(readBindings()['s-beg'].taskId, readBindings()['s-beg'].taskInstanceId);
  seedMaxAttempts(readBindings()['s-beg'].taskId);
  const r = await instrumentedTurn(boot(), 's-beg', TURN);
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0);
  delete process.env.NEXUS_REGISTRY_BINDING;
  const l0 = await instrumentedTurn(boot(), 's-leg', TURN);
  assert.equal(l0.kind, 'next');
  assert.ok(!readBindings()['s-leg'].bindingAuthority && !readBindings()['s-leg'].registryPin, 'legacy stays unmarked');
  await closeAttempt(readBindings()['s-leg'].taskId, readBindings()['s-leg'].taskInstanceId);
  seedMaxAttempts(readBindings()['s-leg'].taskId);
  const l1 = await instrumentedTurn(boot(), 's-leg', TURN);
  assert.equal(l1.kind, 'next'); assert.equal(l1.nextCount, 1);
  process.env.NEXUS_REGISTRY_BINDING = '1';
});await check('R7.0 authorized verify on pinned session stays possible', async () => {
  const pp = await instrumentedTurn(boot(), 's-p1', TURN);
  assert.equal(pp.kind, 'next');
  assert.equal(readBindings()['s-p1'].bindingAuthority, 'registry');
  const before = snapState();
  const w = await instrumentedTurn(boot(), 's-p1', '/verify');
  assert.equal(w.kind, 'reject'); assert.equal(w.nextCount, 0);
  assert.ok(snapState() !== before, 'pinned verify records outcomes (authorized diagnostic)');
});
await check('R7.0 revoked pinned visual and verify are rejected', async () => {
  const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome });
  assert.equal(svc.setBuiltInConnectionStatus('conn-flash-high-direct', 'revoked', {}).ok, true);
  const v = await instrumentedTurn(boot(), 's-p1', '/visual-review shot.png');
  assert.equal(v.kind, 'reject'); assert.equal(v.nextCount, 0);
  const w = await instrumentedTurn(boot(), 's-p1', '/verify');
  assert.equal(w.kind, 'reject'); assert.equal(w.nextCount, 0);
  const hits = logLines().filter(function (l) { return l.indexOf('s-p1') !== -1 && l.indexOf('registry-authorization-revoked') !== -1; });
  assert.ok(hits.length >= 1, 'exact authorization code in log');
});
await check('R7.0 rollback preserves generation on command turns', async () => {
  assert.equal(stageSlots({ engineer: { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' } }).ok, true);
  process.env.NEXUS_REGISTRY_BINDING = '1';
  const rb = await instrumentedTurn(boot(), 's-r2', TURN); 
  assert.equal(rb.kind, 'reject');
  delete process.env.NEXUS_REGISTRY_BINDING;
  const r = await instrumentedTurn(boot(), 's-r2', '/visual-review shot.png');
  assert.equal(r.kind, 'reject');
  assert.ok(r.kinds.indexOf('visual-review-error') !== -1, 'rollback runs legacy machinery: ' + JSON.stringify(r.kinds));
  const b = readBindings()['s-r2'];
  assert.equal(b.bindingAuthority, 'legacy-rollback');
  assert.ok(b.registryRefused, 'refusal retained');
  assert.ok(!b.registryPin, 'no pin invented');
});
await check('R7.0 history append-only, credentials and trees untouched', async () => {
  const after = fs.readFileSync(path.join(fix.dataHome, 'routing', 'decisions.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; });
  assert.ok(after.length >= decisionsPrefix.length, 'history only appended');
  assert.deepEqual(after.slice(0, decisionsPrefix.length), decisionsPrefix, 'no historical record rewritten');
  let status = null;
  try { status = cp.execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { console.log('SKIP: git unavailable'); return; }
  const reviewed = ['config/AihController.cjs', 'scripts/Engineering/StepRouting.ps1'];
  const bad = String(status || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; }).filter(function (l) {
    const p = l.slice(3).trim();
    if (reviewed.indexOf(p) !== -1) return false;
    if (p.slice(0, 7) === 'config/' && (p.slice(-5) === '.json' || p.slice(-5) === '.yaml' || p.slice(-4) === '.yml')) return true;
    return p.indexOf('scripts/') === 0 || p.indexOf('data/') === 0 || p.indexOf('ui/') === 0;
  });
  assert.deepEqual(bad, [], 'protected trees clean apart from reviewed files: ' + JSON.stringify(bad));
});
if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
if (prevRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = prevRoot;
if (prevFlag === undefined) delete process.env.NEXUS_REGISTRY_BINDING; else process.env.NEXUS_REGISTRY_BINDING = prevFlag;
try { fs.rmSync(fix.installRoot, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(fix.fixture, { recursive: true, force: true }); } catch (e) {}
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
if (failed > 0) { console.log('FAILURES:'); console.log(failures.join(String.fromCharCode(10))); process.exitCode = 1; }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });