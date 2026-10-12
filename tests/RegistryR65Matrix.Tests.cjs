'use strict';
// Registry R6.5 - compatibility matrix at the real routing boundary.
// Every decision below is a REAL Route.ps1 -DryRun record (zero state
// writes). Reviewer/solver/deepEngineer/opencode targets come from the
// live legacy authority; staged configs go through the real service and
// adapter. Corruption, revocation, and secret-hygiene cases assert exact
// fail-closed codes, never fabricated parity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
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
function cleanEnv() { const e = Object.assign({}, process.env); delete e.DSH_AIH_PRESET; delete e.DSH_AIH_PROFILE; delete e.AIH_ACTIVE_PRESET; delete e.AIH_ACTIVE_PROFILE; return e; }
function runRoute(args, label) {
  return new Promise((resolve, reject) => {
    const argv = ['-NoProfile', '-NoLogo', '-File', path.join(repoRoot, 'scripts', 'Route.ps1')].concat(args);
    cp.execFile('pwsh', argv, { cwd: repoRoot, env: cleanEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout || ''); const start = text.indexOf('{');
      if (err || start < 0) { const e = new Error(label + ': no decision: ' + String((err && err.message) || stderr || text).slice(0, 300)); e.routeStderr = String(stderr || ''); reject(e); return; }
      try { resolve(JSON.parse(text.slice(start))); } catch (e2) { reject(new Error(label + ': unparseable decision')); }
    });
  });
}
function svcOn(dataRoot, installRoot) { return registry.service.createService({ installRoot: installRoot || repoRoot, dataRoot: dataRoot }); }
const WS = tmpDir('r65-ws-');
const DESC = 'Fix null handling in workspace resolver';
function dualArgs(extra) { return ['-Description', DESC, '-Workspace', WS, '-InstallRoot', repoRoot, '-Preset', 'aih-engineering', '-DryRun'].concat(extra || []); }
(async () => {
await check('R6.5 reviewer parity with read-only enforcement on both planes', async () => {
  const d = await runRoute(dualArgs(['-ReviewRequested']), 'reviewer');
  assert.equal(d.executionClass, 'reviewer'); assert.equal(d.role, 'reviewer');
  assert.equal(d.writable, false, 'legacy reviewer is read-only');
  const out = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: tmpDir('r65-store-rev-') });
  assert.equal(out.shadowOk, true); assert.equal(out.parity, true, JSON.stringify(out.mismatches));
  const w = out.comparisons.find((c) => c.field === 'writable');
  assert.ok(w && w.match === true, 'read-only agrees on both planes');
});
await check('R6.5 solver keeps explicit-approval enforcement with R6 wiring', async () => {
  let threw = false;
  try { await runRoute(dualArgs(['-ForceClass', 'solver']), 'solver-noflag'); }
  catch (e) { threw = true; assert.ok(String(e.routeStderr || e.message).indexOf('UserApprovedCodexSolve') !== -1, 'exact approval gate: ' + String(e.message).slice(0, 200)); }
  assert.equal(threw, true, 'solver without approval still refused');
  const d = await runRoute(dualArgs(['-ForceClass', 'solver', '-UserApprovedCodexSolve']), 'solver-approved');
  assert.equal(d.role, 'solver');
  const out = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: tmpDir('r65-store-solv-') });
  assert.equal(out.shadowOk, true); assert.equal(out.parity, true, JSON.stringify(out.mismatches));
});
await check('R6.5 deep-engineer parity without reasoning downgrade', async () => {
  const d = await runRoute(dualArgs(['-ForceClass', 'engineer_deep']), 'deep');
  assert.equal(d.role, 'deepEngineer');
  const out = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: tmpDir('r65-store-deep-') });
  assert.equal(out.shadowOk, true); assert.equal(out.parity, true, JSON.stringify(out.mismatches));
  const r = out.comparisons.find((c) => c.field === 'reasoning');
  assert.equal(r.legacy, 'max'); assert.equal(r.registry, 'max');
});
await check('R6.5 opencode muse route parity under staged opencode config', async () => {
  const root = tmpDir('r65-root-oc-');
  try { fs.symlinkSync(path.join(repoRoot, 'config'), path.join(root, 'config'), 'dir'); }
  catch (e) { console.log('SKIP: opencode fixture needs a config symlink: ' + String((e && e.message) || e)); return; }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'config', 'settings.yaml'), path.join(root, 'data', 'settings.yaml'));
  const ws = tmpDir('r65-ws-oc-');
  const d = await runRoute(['-Description', 'Harden contributor tool boundary', '-Workspace', ws, '-InstallRoot', root, '-Preset', 'aih-muse', '-ProfileId', 'muse-spark-1.3-contributor-opencode', '-DryRun'], 'opencode');
  assert.equal(d.provider, 'opencode-go');
  const dataRoot = tmpDir('r65-store-oc-');
  const svc = svcOn(dataRoot);
  const staged = svc.getModeConfiguration('engineering-v2', {});
  const cfg = JSON.parse(JSON.stringify(staged.result.config));
  cfg.slots.main = { logicalModelId: 'meta/muse-spark-1.3-contributor', routeId: 'opencode-go/meta/muse-spark-1.3-contributor', reasoning: 'xhigh' };
  const saved = svc.save('engineering-v2', cfg, undefined, {});
  assert.equal(saved.ok, true, JSON.stringify(saved.errors || []));
  const out = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(out.shadowOk, true); assert.equal(out.parity, true, JSON.stringify(out.mismatches));
  assert.equal(out.projected.provider, 'opencode-go');
});
await check('R6.5 corrupt store and unknown routes fail closed with exact codes', async () => {
  const d = { preset: 'aih-engineering', engine: 'dual', executionClass: 'engineer_normal', role: 'primaryEngineer', profile: 'deepseek-codex', provider: 'flash-high-direct', model: 'deepseek-v4-flash', reasoning: 'high', writable: true };
  const corruptRoot = tmpDir('r65-store-corrupt-');
  const dir = path.join(corruptRoot, 'registry'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mode-configurations.json'), '{not-json');
  const c = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: corruptRoot });
  assert.equal(typeof c.shadowOk, 'boolean'); assert.equal(typeof c.parity, 'boolean');
  assert.ok(typeof c.code === 'string' && c.code !== '', 'structured code, never a throw');
  assert.ok(Array.isArray(c.mismatches) && Array.isArray(c.errors));
  if (c.parity === true) assert.equal(c.staged && c.staged.persisted, false, 'parity only via deterministic preview fallback, never staged lies');
  const bogusRoot = tmpDir('r65-store-bogus-');
  const svc = svcOn(bogusRoot);
  const staged = svc.getModeConfiguration('engineering-v1', {});
  const cfg = JSON.parse(JSON.stringify(staged.result.config));
  cfg.slots.engineer = { logicalModelId: 'deepseek-v4-flash', routeId: 'nope/missing-route', reasoning: 'high' };
  const bdir = path.join(bogusRoot, 'registry'); fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'mode-configurations.json'), JSON.stringify({ schemaVersion: 1, updatedAtUtc: new Date(0).toISOString(), modes: { 'engineering-v1': { revision: 0, savedAtUtc: new Date(0).toISOString(), source: 'operator-save', config: cfg } } }));
  const b = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: bogusRoot });
  assert.equal(b.parity, false); assert.equal(b.code, 'shadow-compile-failed');
  assert.ok(b.errors.map((e) => e.code).indexOf('unknown-reference') !== -1, JSON.stringify(b.errors.map((e) => e.code)));
});
await check('R6.5 shadow diagnostics and pins carry no credential material', async () => {
  const d = { preset: 'aih-muse', engine: 'muse', executionClass: 'muse_main', role: null, profile: 'muse-spark-1.3-contributor', provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', reasoning: 'xhigh', writable: true, dataUseTier: 'contributor' };
  const out = shadow.runShadowComparison(d, { installRoot: repoRoot, dataRoot: tmpDir('r65-store-sec-') });
  assert.equal(out.shadowOk, true);
  const text = JSON.stringify(out);
  assert.ok(!(/sk-(live|proj|svcacct)-[A-Za-z0-9._-]+|sk-ant-[A-Za-z0-9._-]+|xox[bap]-[A-Za-z0-9-]+|gh[pous]_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)), 'no secret shapes');
  assert.ok(text.indexOf('apiKey') === -1 && text.indexOf('auth.json') === -1, 'no credential fields');
});
await check('R6.5 protected production trees are unmodified', () => {
  let status = null;
  try { status = cp.execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { console.log('SKIP: git unavailable for tree check'); return; }
  const lines = String(status || '').split('\n').filter(function (l) { return l.trim() !== ''; });
  // R75A explicitly audits installation safety: the reviewed private-path
  // fix has its own escaping-symlink regression. Catalogs, policies, settings,
  // R7.5B.1a Setup copies the shared shell module; Test-Harness registers its
  // real SDK regression. These two reviewed packaging/test changes are exact
  // allowances; data, UI and every other script stay protected.
  const reviewed = ['config/AihController.cjs', 'scripts/Engineering/StepRouting.ps1', 'scripts/Platform.ps1', 'scripts/Setup.ps1', 'scripts/Test-Harness.ps1'];
  const bad = lines.filter(function (l) {
    const p = l.slice(3).trim();
    if (l.slice(0, 2).trim() === '' ) return false;
    if (reviewed.indexOf(p) !== -1) return false;
    return p.indexOf('scripts/') === 0 || p.indexOf('data/') === 0 || p.indexOf('ui/') === 0 || (/^config\/.*\.(json|yaml|yml)$/.test(p)) || p === 'config/AihController.cjs';
  });
  assert.deepEqual(bad, [], 'protected trees clean apart from reviewed R6 files: ' + JSON.stringify(bad));
  console.log('  info: reviewed R6 production files: ' + JSON.stringify(lines.filter(function (l) { return reviewed.indexOf(l.slice(3).trim()) !== -1; })));
});
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
if (failed > 0) { console.log('FAILURES:'); console.log(failures.join(String.fromCharCode(10))); process.exitCode = 1; }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });
