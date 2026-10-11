'use strict';
// Registry R6.3.2 execution boundary: a refused Registry generation must stop
// BEFORE the model pipeline. next() counters, attempt-file deltas, and reject
// kinds are asserted through the REAL agent/pre-step middleware (in-process
// turns plus real child-process restarts). DSH model invocation is downstream
// of next(): a turn that never calls next() and starts no attempt cannot
// invoke a model; this file proves the pre-step side of that boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const sessionBinding = require('../config/registry/session-binding.cjs');
const shadow = require('../config/registry/shadow-binding.cjs');
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
(async () => {
await check('R6.3.2 turn-entry gate upholds pins and exposes legacy', () => {
  const gate = sessionBinding.checkTurnEntry;
  const map = { primaryEngineer: { available: true, target: { provider: 'p', model: 'm', reasoning: 'r', connectionId: 'c1' } } };
  const pin = { taskInstanceId: 'task_a', roleTargets: map };
  const conn = { id: 'c1', status: 'connected', provenance: 'x' };
  const b = { taskInstanceId: 'task_a', engine: 'dual', executionClass: 'engineer_normal' };
  const ok = gate({ binding: Object.assign({ registryPin: pin }, b), role: 'primaryEngineer', connection: conn, flagOn: true });
  assert.equal(ok.ok, true); assert.equal(ok.mode, 'pinned');
  const legacy = gate({ binding: {}, role: null, connection: null, flagOn: true });
  assert.equal(legacy.ok, true); assert.equal(legacy.mode, 'legacy');
  const refused = gate({ binding: { registryRefused: { code: 'registry-binding-mismatch' } }, role: null, connection: null, flagOn: true });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'registry-binding-mismatch');
  const rolled = gate({ binding: { registryRefused: { code: 'registry-binding-mismatch' } }, role: null, connection: null, flagOn: false });
  assert.equal(rolled.ok, true); assert.equal(rolled.mode, 'rollback');
  const genBad = gate({ binding: Object.assign({ registryPin: pin }, b, { taskInstanceId: 'task_b' }), role: 'primaryEngineer', connection: conn, flagOn: true });
  assert.equal(genBad.ok, false); assert.equal(genBad.code, 'registry-generation-mismatch');
  const noRole = gate({ binding: Object.assign({ registryPin: pin }, b), role: 'reviewer', connection: conn, flagOn: true });
  assert.equal(noRole.ok, false); assert.equal(noRole.code, 'registry-role-unpinned');
  const rev = gate({ binding: Object.assign({ registryPin: pin }, b), role: 'primaryEngineer', connection: { id: 'c1', status: 'revoked', provenance: 'x' }, flagOn: true });
  assert.equal(rev.ok, false); assert.equal(rev.code, 'registry-authorization-revoked');
  const nov = gate({ binding: Object.assign({ registryPin: pin }, b), role: 'primaryEngineer', connection: null, flagOn: true });
  assert.equal(nov.ok, false); assert.equal(nov.code, 'registry-authorization-unverifiable');
});function buildFixture() {
  const installRoot = tmpDir('r632-root-');
  const dataHome = path.join(installRoot, 'data');
  fs.mkdirSync(dataHome, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(installRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'config'), path.join(installRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'ui', 'nexus-controller', 'lib'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'), path.join(installRoot, 'ui', 'nexus-controller', 'lib', 'gate.cjs'));
  fs.writeFileSync(path.join(dataHome, 'settings.yaml'), 'engineering-profile: deepseek-codex\n');
  const fixture = tmpDir('r632-ws-');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(path.join(fixture, 'src', 'huge.js'), 'x'.repeat(140000));
  const polPath = path.join(installRoot, 'config', 'routing-policy.json');
  const pol = JSON.parse(fs.readFileSync(polPath, 'utf8'));
  pol.codex.automaticReview.enforceLimits = true;
  fs.writeFileSync(polPath, JSON.stringify(pol));
  return { installRoot: installRoot, dataHome: dataHome, fixture: fixture };
}
function makeSession(id, cwd, preset) { return { id: id, header: { cwd: cwd, agentPreset: preset || 'aih-engineering' }, messages: [], append: function (k, m) { this.messages.push({ kind: k, message: m }); } }; }
const prevHome = process.env.DSH_HOME; const prevRoot = process.env.AIH_INSTALL_ROOT; const prevFlag = process.env.NEXUS_REGISTRY_BINDING;
const fix = buildFixture();
process.env.DSH_HOME = fix.dataHome; process.env.AIH_INSTALL_ROOT = fix.installRoot; delete process.env.NEXUS_REGISTRY_BINDING;
const controller = require('../config/AihController.cjs');
const registry = require('../config/registry/index.cjs');
function boot() { const handlers = {}; const ctx = { on: function (ev, fn) { handlers[ev] = fn; }, shellEnv: { register: function () {} } }; controller.apply(ctx); return handlers['agent/pre-step']; }
function countAttempts() { let n = 0; const runs = path.join(fix.fixture, '.ai-harness', 'runs'); try { for (const t of fs.readdirSync(runs)) { try { n += fs.readFileSync(path.join(runs, t, 'attempts.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; }).length; } catch (e) {} } } catch (e) {} return n; }
async function instrumentedTurn(preStep, sid, text, preset) {
  const before = countAttempts(); let nextCount = 0;
  const session = makeSession(sid, fix.fixture, preset);
  const result = await preStep({ agent: { session: session }, messages: [userMessage(text)], step: 1, turn: 'x' }, function () { nextCount++; return 'next'; });
  return { kind: (typeof result === 'string') ? result : (result && result.kind), nextCount: nextCount, attemptsDelta: countAttempts() - before };
}
function closeAttempt(taskId, instanceId) {
  return new Promise((resolve, reject) => {
    const env = cleanEnv();
    env.AIH_INSTALL_ROOT = fix.installRoot;
    const argv = ['-NoProfile', '-NoLogo', '-File', path.join(repoRoot, 'scripts', 'Task.ps1'), '-Action', 'attempt-event', '-Workspace', fix.fixture, '-TaskId', taskId, '-Status', 'interrupted', '-Reason', 'r632-test-staging', '-TaskInstanceId', instanceId];
    cp.execFile('pwsh', argv, { cwd: repoRoot, env: env, timeout: 120000, maxBuffer: 1048576 }, (err, stdout, stderr) => {
      if (err) { reject(new Error('closeAttempt failed: '+ String(stderr || (err && err.message) || err).slice(0, 300))); return; }
      resolve(true);
    });
  });
} function readBindings() { return JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8')).bindings; }
function logLines() { try { return fs.readFileSync(path.join(fix.dataHome, 'logs', 'aih-controller.log'), 'utf8').split('\n'); } catch (e) { return []; } }
const CHILD = path.join(os.tmpdir(), 'r632-turn-' + String(process.pid) + '.cjs');
fs.writeFileSync(CHILD, [
  "const fs = require('node:fs'); const path = require('node:path');",
  'async function main() {',
  '  const argv = process.argv.slice(2);',
  '  const repoRoot = argv[0]; const dataHome = argv[1]; const installRoot = argv[2]; const fixture = argv[3]; const sid = argv[4]; const preset = argv[5]; const text = argv[6]; const flag = argv[7];',
  '  process.env.DSH_HOME = dataHome; process.env.AIH_INSTALL_ROOT = installRoot;',
  '  if (flag === "1") process.env.NEXUS_REGISTRY_BINDING = "1"; else delete process.env.NEXUS_REGISTRY_BINDING;',
  '  const controller = require(path.join(repoRoot, "config", "AihController.cjs"));',
  '  function countAttempts() { let n = 0; const runs = path.join(fixture, ".ai-harness", "runs"); try { for (const t of fs.readdirSync(runs)) { try { n += fs.readFileSync(path.join(runs, t, "attempts.jsonl"), "utf8").split("\\n").filter(function (l) { return l !== ""; }).length; } catch (e) {} } } catch (e) {} return n; }',
  '  const handlers = {}; controller.apply({ on: function (ev, fn) { handlers[ev] = fn; }, shellEnv: { register: function () {} } });',
  '  const session = { id: sid, header: { cwd: fixture, agentPreset: preset }, messages: [], append: function () {} };',
  '  const um = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: text }] };',
  '  const before = countAttempts(); let nextCount = 0;',
  '  let kind = "none"; try { const r = await handlers["agent/pre-step"]({ agent: { session: session }, messages: [um], step: 1, turn: "x" }, function () { nextCount++; return "next"; }); kind = (r && r.kind) || "next"; } catch (e) { kind = "threw:" + String((e && e.code) || (e && e.message) || e).slice(0, 80); }',
  '  console.log("CHILD-RESULT " + JSON.stringify({ kind: kind, nextCount: nextCount, attemptsDelta: countAttempts() - before }));',
  '}',
  'main().then(function () {}, function (e) { console.error("CHILD-ERROR " + String((e && e.message) || e)); process.exitCode = 1; });',
].join('\n'));
function childTurn(sid, preset, text, flag) {
  return new Promise((resolve, reject) => {
    cp.execFile(process.execPath, [CHILD, repoRoot, fix.dataHome, fix.installRoot, fix.fixture, sid, preset, text, flag], { cwd: repoRoot, env: cleanEnv(), timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const line = String(stdout || '').split('\n').find(function (l) { return l.indexOf('CHILD-RESULT ') === 0; });
      if (err || !line) { reject(new Error('child turn failed for ' + sid + ': ' + String((err && err.message) || stderr || stdout).slice(0, 400))); return; }
      try { resolve(JSON.parse(line.slice('CHILD-RESULT '.length))); } catch (e) { reject(new Error('child result unparseable')); }
    });
  });
}
function cleanEnv() { const e = Object.assign({}, process.env); delete e.DSH_AIH_PRESET; delete e.DSH_AIH_PROFILE; delete e.AIH_ACTIVE_PRESET; delete e.AIH_ACTIVE_PROFILE; return e; }
function stageEngineer(slot) { const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome }); const st = svc.getModeConfiguration('engineering-v1', {}); const cfg = JSON.parse(JSON.stringify(st.result.config)); cfg.slots.engineer = slot; const rev = (st.result && st.result.persisted) ? st.result.config.revision : undefined; return svc.save('engineering-v1', cfg, rev, {}); }
const TURN = 'Fix null handling in workspace resolver';
let decisionsPrefix = null;
await check('R6.3.2 legacy session proceeds with next and attempt', async () => {
  const r = await instrumentedTurn(boot(), 's-off', TURN);
  assert.equal(r.kind, 'next'); assert.equal(r.nextCount, 1); assert.equal(r.attemptsDelta, 1);
  decisionsPrefix = fs.readFileSync(path.join(fix.dataHome, 'routing', 'decisions.jsonl'), 'utf8').split('\n').filter(function (l) { return l !== ''; });
});
await check('R6.3.2 initial mismatch rejects with no next and no attempt', async () => {
  assert.equal(stageEngineer({ logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' }).ok, true);
  process.env.NEXUS_REGISTRY_BINDING = '1';
  const r = await instrumentedTurn(boot(), 's-r1', TURN);
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
  assert.ok(readBindings()['s-r1'].registryRefused, 'refusal persisted');
});
await check('R6.3.2 second turn after rejection still rejects', async () => {
  const r = await instrumentedTurn(boot(), 's-r1', TURN);
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
});
await check('R6.3.2 restart after rejection still rejects', async () => {
  const r = await childTurn('s-r1', 'aih-engineering', TURN, '1');
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
});
await check('R6.3.2 valid pinned session proceeds exactly once', async () => {
  assert.equal(stageEngineer({ logicalModelId: 'deepseek-v4-flash', routeId: 'flash-high-direct/deepseek-v4-flash', reasoning: 'high' }).ok, true);
  const r = await instrumentedTurn(boot(), 's-p1', TURN);
  assert.equal(r.kind, 'next'); assert.equal(r.nextCount, 1); assert.equal(r.attemptsDelta, 1);
  assert.equal(readBindings()['s-p1'].bindingAuthority, 'registry');
});await check('R6.3.2 review-findings mismatch rejects', async () => {
  const r0 = await instrumentedTurn(boot(), 's-rf', TURN);
  assert.equal(r0.kind, 'next');
  assert.equal(readBindings()['s-rf'].bindingAuthority, 'registry');
  const doc = JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8'));
  doc.bindings['s-rf'].executionClass = 'reviewer';
  const statesDir = path.join(fix.dataHome, 'routing', 'states');
  let stHit = null;
  for (const fn of fs.readdirSync(statesDir)) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(statesDir, fn), 'utf8'));
      if (st && st.taskInstanceId === doc.bindings['s-rf'].taskInstanceId) { stHit = path.join(statesDir, fn); break; }
    } catch (e) {}
  }
  assert.ok(stHit, 'routing state exists for the generation');
  const stDoc = JSON.parse(fs.readFileSync(stHit, 'utf8'));
  stDoc.executionClass = 'reviewer'; stDoc.role = 'reviewer'; stDoc.selectedTier = 1;
  fs.writeFileSync(stHit, JSON.stringify(stDoc));
  fs.writeFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), JSON.stringify(doc));
  const profPath = path.join(fix.installRoot, 'config', 'engineering-profiles.json');
  const backup = fs.readFileSync(profPath, 'utf8');
  try {
    const pdoc = JSON.parse(backup);
    pdoc.profiles.find(function (p) { return p.id === 'deepseek-codex'; }).roles.deepEngineer.reasoning = 'high';
    fs.writeFileSync(profPath, JSON.stringify(pdoc));
    const bad = await childTurn('s-rf', 'aih-engineering', TURN, '1');
    assert.equal(bad.kind, 'reject'); assert.equal(bad.nextCount, 0); assert.equal(bad.attemptsDelta, 0);
    const fhits = logLines().filter(function (l) { return l.indexOf('s-rf') !== -1 && l.indexOf('registry-pin-mismatch') !== -1; });
        const srfAll = logLines().filter(function (l) { return l.indexOf('s-rf') !== -1; });
assert.ok(fhits.length >= 1, 'exact findings code in log; s-rf lines: '+ JSON.stringify(srfAll.slice(-6)).slice(0, 600));
  // Positive findings flow intentionally not driven: review execution transport is out of scope;
  } finally { fs.writeFileSync(profPath, backup); }
  const afterBad = JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8')).bindings['s-rf'];
  assert.ok(afterBad.registryPin, 'pin intact across the refused transition');
});
await check('R6.3.2 invalid step target rejects with no fallback execution', async () => {
  const r0 = await instrumentedTurn(boot(), 's-step', TURN);
  assert.equal(r0.kind, 'next');
  const sstep = readBindings()['s-step'];
  await closeAttempt(sstep.taskId, sstep.taskInstanceId);
  const profPath = path.join(fix.installRoot, 'config', 'engineering-profiles.json');
  const backup = fs.readFileSync(profPath, 'utf8');
  try {
    const pdoc = JSON.parse(backup);
    const prim = pdoc.profiles.find(function (p) { return p.id === 'deepseek-codex'; }).roles.primaryEngineer;
    prim.model = 'glm-5.3-flash'; prim.reasoning = 'high';
    fs.writeFileSync(profPath, JSON.stringify(pdoc));
    const r = await instrumentedTurn(boot(), 's-step', TURN);
    assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
    const hits = logLines().filter(function (l) { return l.indexOf('s-step') !== -1 && (l.indexOf('step-target-mismatch') !== -1 || l.indexOf('step-target-pin-mismatch') !== -1); });
    console.log('SSTEP-EVIDENCE '+ JSON.stringify({ pin: !!readBindings()['s-step'].registryPin, cls: readBindings()['s-step'].executionClass, nrc: readBindings()['s-step'].needsRouteCheck, lines: logLines().filter(function (l) { return l.indexOf('s-step') !== -1; }) }));
    const sall = logLines().filter(function (l) { return l.indexOf('s-step') !== -1; });
    assert.ok(hits.length >= 1, 'exact step code in log; s-step lines: '+ JSON.stringify(sall.slice(-8)).slice(0, 900));
  } finally { fs.writeFileSync(profPath, backup); }
});
await check('R6.3.2 revoked connection rejects the ordinary pinned turn', async () => {
  const r0 = await instrumentedTurn(boot(), 's-auth', TURN);
  assert.equal(r0.kind, 'next');
  const svc = registry.service.createService({ installRoot: fix.installRoot, dataRoot: fix.dataHome });
  assert.equal(svc.setBuiltInConnectionStatus('conn-flash-high-direct', 'revoked', {}).ok, true);
  const r = await instrumentedTurn(boot(), 's-auth', TURN);
  assert.equal(r.kind, 'reject'); assert.equal(r.nextCount, 0); assert.equal(r.attemptsDelta, 0);
  const hits = logLines().filter(function (l) { return l.indexOf('s-auth') !== -1 && l.indexOf('registry-authorization-revoked') !== -1; });
  assert.ok(hits.length >= 1, 'exact authorization code in log');
});await check('R6.3.2 muse pin proceeds, revoked muse connection rejects', async () => {
  const mroot = tmpDir('r632-mroot-');
  fs.symlinkSync(path.join(repoRoot, 'config'), path.join(mroot, 'config'), 'dir');
  fs.mkdirSync(path.join(mroot, 'data'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'config', 'settings.yaml'), path.join(mroot, 'data', 'settings.yaml'));
  const mfix = tmpDir('r632-mws-');
  const mdec = await new Promise((resolve, reject) => {
    const argv = ['-NoProfile', '-NoLogo', '-File', path.join(repoRoot, 'scripts', 'Route.ps1'), '-Description', 'Harden contributor tool boundary', '-Workspace', mfix, '-InstallRoot', mroot, '-Preset', 'aih-muse', '-ProfileId', 'muse-spark-1.3-contributor', '-DryRun'];
    cp.execFile('pwsh', argv, { cwd: repoRoot, env: cleanEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout || ''); const start = text.indexOf('{');
      if (err || start < 0) { reject(new Error('muse decision missing: ' + String((err && err.message) || stderr || text).slice(0, 300))); return; }
      try { resolve(JSON.parse(text.slice(start))); } catch (e) { reject(new Error('muse decision unparseable')); }
    });
  });
  assert.equal(mdec.engine, 'muse');
  const minst = 'task-d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
  const mshadow = shadow.runShadowComparison(mdec, { installRoot: repoRoot, dataRoot: tmpDir('r632-mstore-') });
  assert.equal(mshadow.parity, true, JSON.stringify(mshadow.mismatches));
  const mpin = sessionBinding.evaluateRegistryBinding(mdec, mshadow, { bindTask: { taskId: 'TASK-M1', taskInstanceId: minst } }).pin;
  fs.mkdirSync(path.join(mfix, '.ai-harness', 'state'), { recursive: true });
  fs.writeFileSync(path.join(mfix, '.ai-harness', 'state', 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextSequence: 2, tasks: [{ taskId: 'TASK-M1', taskInstanceId: minst, description: 'muse hardening', status: 'ready', boundEngine: 'muse' }] }));
  const mbind = { sessionId: 's-muse', taskId: 'TASK-M1', taskInstanceId: minst, workspace: mfix, preset: 'aih-muse', engine: 'muse', executionClass: 'muse_main', needsRouteCheck: false, boundAtUtc: '2026-10-11T00:00:00.000Z', registryPin: mpin, bindingAuthority: 'registry' };
  const mdoc = JSON.parse(fs.readFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), 'utf8'));
  mdoc.bindings['s-muse'] = mbind;
  fs.writeFileSync(path.join(fix.dataHome, 'routing', 'session-bindings.json'), JSON.stringify(mdoc));
  async function museTurn(text) {
    const session = makeSession('s-muse', mfix, 'aih-muse');
    let nextCount = 0;
    const r = await boot()({ agent: { session: session }, messages: [userMessage(text)], step: 1, turn: 'x' }, function () { nextCount++; return 'next'; });
    return { kind: (typeof r === 'string') ? r : (r && r.kind), nextCount: nextCount };
  }
  const mok = await museTurn(TURN);
  assert.equal(mok.kind, 'next'); assert.equal(mok.nextCount, 1);
  const svc = registry.service.createService({ installRoot: repoRoot, dataRoot: fix.dataHome });
  assert.equal(svc.setBuiltInConnectionStatus('conn-meta-model-api', 'revoked', {}).ok, true);
  const mno = await museTurn(TURN);
  assert.equal(mno.kind, 'reject'); assert.equal(mno.nextCount, 0);
  const hits = logLines().filter(function (l) { return l.indexOf('s-muse') !== -1 && l.indexOf('registry-authorization-revoked') !== -1; });
  assert.ok(hits.length >= 1, 'exact muse authorization code in log');
  try { fs.rmSync(mroot, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(mfix, { recursive: true, force: true }); } catch (e) {}
});await check('R6.3.2 authorized rollback proceeds under legacy authority', async () => {
  delete process.env.NEXUS_REGISTRY_BINDING;
  const r = await instrumentedTurn(boot(), 's-r1', TURN);
  assert.equal(r.kind, 'next'); assert.equal(r.nextCount, 1);
  const b = readBindings()['s-r1'];
  assert.equal(b.bindingAuthority, 'legacy-rollback');
  assert.ok(b.registryRefused, 'refusal retained as history');
  assert.ok(!b.registryPin, 'no pin invented');
});
await check('R6.3.2 history append-only, credentials and trees untouched', async () => {
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
    return p.indexOf('scripts/') === 0 || p.indexOf('data/') === 0 || p.indexOf('ui/') === 0 || (/^config\/.*\.(json|yaml|yml)$/.test(p));
  });
  assert.deepEqual(bad, [], 'protected trees clean apart from reviewed R6.3.2 files: ' + JSON.stringify(bad));
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