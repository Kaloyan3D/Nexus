'use strict';
// Registry R6.2 - shadow parity at the real controller binding boundary.
// Dual and Muse decisions below come from the REAL Route.ps1 authority
// (-DryRun: full resolution, zero state writes). Staged Registry configs
// go through the REAL service (buildCanonical/getModeConfiguration/save/
// compilePreview) and the REAL dsh-adapter projection. Nothing here
// fabricates parity: unrepresentable targets yield exact mismatch codes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const shadow = require('../config/registry/shadow-binding.cjs');
const registry = require('../config/registry/index.cjs');
let passed = 0; let failed = 0; let skipped = 0; const failures = [];
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
function skip(label, reason) { skipped++; console.log('SKIP: ' + label + ' :: ' + reason); return Promise.resolve(); }
function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanEnv() { const e = Object.assign({}, process.env); delete e.DSH_AIH_PRESET; delete e.DSH_AIH_PROFILE; delete e.AIH_ACTIVE_PRESET; delete e.AIH_ACTIVE_PROFILE; return e; }
function runRouteDryRun(args, snapshotLabel) {
  return new Promise((resolve, reject) => {
    const argv = ['-NoProfile', '-NoLogo', '-File', path.join(repoRoot, 'scripts', 'Route.ps1')].concat(args);
    cp.execFile('pwsh', argv, { cwd: repoRoot, env: cleanEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout || '');
      const start = text.indexOf('{');
      if (err || start < 0) { reject(new Error(snapshotLabel + ': Route.ps1 produced no decision JSON: ' + String((err && err.message) || stderr || text).slice(0, 600))); return; }
      try { resolve(JSON.parse(text.slice(start))); } catch (e) { reject(new Error(snapshotLabel + ': decision JSON unparseable: ' + String(e.message))); }
    });
  });
}
function deepFreeze(v) { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; }
function svcOn(dataRoot) { return registry.service.createService({ installRoot: repoRoot, dataRoot: dataRoot }); }
(async () => {
let dualDecision = null;
await check('R6.2 real dual boundary decision resolves through the legacy authority', async () => {
  const ws = tmpDir('r62-ws-dual-');
  dualDecision = await runRouteDryRun(['-Description', 'Fix null handling in workspace resolver', '-Workspace', ws, '-InstallRoot', repoRoot, '-Preset', 'aih-engineering', '-DryRun'], 'dual');
  assert.equal(dualDecision.preset, 'aih-engineering');
  assert.equal(dualDecision.engine, 'dual');
  assert.equal(dualDecision.executionClass, 'engineer_normal');
  assert.equal(dualDecision.role, 'primaryEngineer');
  assert.ok(dualDecision.provider && dualDecision.model && dualDecision.reasoning, 'decision carries a complete target');
});
await check('R6.2 dual shadow parity is deterministic and never mutates the decision', async () => {
  assert.ok(dualDecision, 'dual decision captured above');
  const before = JSON.stringify(dualDecision);
  deepFreeze(dualDecision);
  const dataRoot = tmpDir('r62-store-dual-');
  const first = shadow.runShadowComparison(dualDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  const second = shadow.runShadowComparison(dualDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(first.shadowOk, true); assert.equal(first.parity, true, JSON.stringify(first.mismatches));
  assert.equal(first.code, 'shadow-parity');
  assert.ok(first.resolutionId && first.resolutionId.length >= 16, 'resolution pinned');
  assert.deepEqual(first, second, 'shadow is deterministic');
  assert.equal(JSON.stringify(dualDecision), before, 'legacy decision byte-identical after shadow');
  const fields = first.comparisons.map((c) => c.field);
  for (const f of ['provider', 'model', 'reasoning', 'role', 'engine', 'executionKind']) assert.ok(fields.indexOf(f) !== -1, 'compared: ' + f);
});
await check('R6.2 reasoning drift is reported with exact values, never hidden', async () => {
  const dataRoot = tmpDir('r62-store-drift-');
  const svc = svcOn(dataRoot);
  const staged = svc.getModeConfiguration('engineering-v1', {});
  const cfg = JSON.parse(JSON.stringify(staged.result.config));
  cfg.slots.engineer = { logicalModelId: 'deepseek-v4-flash', routeId: 'flash-max-direct/deepseek-v4-flash', reasoning: 'max' };
  const saved = svc.save('engineering-v1', cfg, undefined, {});
  assert.equal(saved.ok, true, JSON.stringify(saved.errors || []));
  const out = shadow.runShadowComparison(dualDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(out.shadowOk, true); assert.equal(out.parity, false);
  const codes = out.mismatches.map((m) => m.code);
  assert.ok(codes.indexOf('provider-mismatch') !== -1, JSON.stringify(codes));
  assert.ok(codes.indexOf('reasoning-mismatch') !== -1, JSON.stringify(codes));
  const pentry = out.comparisons.find((c) => c.field === 'provider');
  assert.equal(pentry.legacy, 'flash-high-direct'); assert.equal(pentry.registry, 'flash-max-direct');
  const rentry = out.comparisons.find((c) => c.field === 'reasoning');
  assert.equal(rentry.legacy, 'high'); assert.equal(rentry.registry, 'max');
  assert.equal(out.staged.persisted, true); assert.equal(out.configRevision, 0);
});
await check('R6.2 revoked connection fails closed with the exact auth code', async () => {
  const dataRoot = tmpDir('r62-store-revoked-');
  const svc = svcOn(dataRoot);
  const over = svc.setBuiltInConnectionStatus('conn-sol-local', 'revoked', {});
  assert.equal(over.ok, true, JSON.stringify(over.errors || []));
  const out = shadow.runShadowComparison(dualDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(out.shadowOk, false); assert.equal(out.parity, false);
  assert.equal(out.code, 'shadow-compile-failed');
  const codes = out.errors.map((e) => e.code);
  assert.ok(codes.indexOf('connection-auth-required') !== -1, JSON.stringify(codes));
});
await check('R6.2 locked aih-deepseek preset is reported and preserved', async () => {
  const ws = tmpDir('r62-ws-deepseek-');
  const decision = await runRouteDryRun(['-Description', 'Fix null handling in workspace resolver', '-Workspace', ws, '-InstallRoot', repoRoot, '-Preset', 'aih-deepseek', '-DryRun'], 'deepseek');
  assert.equal(decision.preset, 'aih-deepseek'); assert.equal(decision.engine, 'dual');
  const out = shadow.runShadowComparison(decision, { installRoot: repoRoot, dataRoot: tmpDir('r62-store-ds-') });
  assert.equal(out.shadowOk, true); assert.equal(out.lockedPreset, true);
  assert.ok(out.code === 'shadow-parity' || out.code === 'shadow-mismatch', 'structured outcome, never silent: ' + out.code);
  if (out.code === 'shadow-mismatch') assert.ok(out.mismatches.length > 0, 'mismatch carries reasons');
});
await check('R6.2 real muse boundary decision reaches shadow parity in isolation', async () => {
  const root = tmpDir('r62-root-muse-');
  try { fs.symlinkSync(path.join(repoRoot, 'config'), path.join(root, 'config'), 'dir'); }
  catch (e) { await skip('R6.2 muse isolation fixture', 'config symlink unavailable: ' + String((e && e.message) || e)); return; }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'config', 'settings.yaml'), path.join(root, 'data', 'settings.yaml'));
  const ws = tmpDir('r62-ws-muse-');
  const decision = await runRouteDryRun(['-Description', 'Harden contributor tool boundary', '-Workspace', ws, '-InstallRoot', root, '-Preset', 'aih-muse', '-ProfileId', 'muse-spark-1.3-contributor', '-DryRun'], 'muse');
  assert.equal(decision.engine, 'muse'); assert.equal(decision.role, null);
  const out = shadow.runShadowComparison(decision, { installRoot: repoRoot, dataRoot: tmpDir('r62-store-muse-') });
  assert.equal(out.shadowOk, true); assert.equal(out.parity, true, JSON.stringify(out.mismatches));
  assert.equal(out.role, 'muse_main');
  const dt = out.comparisons.find((c) => c.field === 'dataUseTier');
  assert.ok(dt && dt.match === true && dt.registry === 'contributor', 'contributor tier compared');
});
await check('R6.2 malformed and unmapped decisions never infer parity', async () => {
  const dataRoot = tmpDir('r62-store-bad-');
  for (const bad of [null, {}, { preset: 'aih-engineering' }]) {
    const out = shadow.runShadowComparison(bad, { installRoot: repoRoot, dataRoot: dataRoot });
    assert.equal(out.shadowOk, false); assert.equal(out.parity, false);
    assert.equal(out.code, 'shadow-decision-invalid');
  }
  const unmapped = shadow.runShadowComparison({ preset: 'aih-future', engine: 'dual', executionClass: 'engineer_normal', role: 'primaryEngineer' }, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(unmapped.code, 'shadow-preset-unmapped'); assert.equal(unmapped.parity, false);
});
await check('R6.2 subscription-agent route never parity-matches a mode role', async () => {
  const dataRoot = tmpDir('r62-store-claude-');
  const svc = svcOn(dataRoot);
  const staged = svc.getModeConfiguration('engineering-v1', {});
  const cfg = JSON.parse(JSON.stringify(staged.result.config));
  cfg.slots.engineer = { logicalModelId: 'claude-subscription-agent', routeId: 'claude-code-subscription/claude-subscription-agent', reasoning: 'managed' };
  const dir = path.join(dataRoot, 'registry'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mode-configurations.json'), JSON.stringify({ schemaVersion: 1, updatedAtUtc: new Date(0).toISOString(), modes: { 'engineering-v1': { revision: 0, savedAtUtc: new Date(0).toISOString(), source: 'operator-save', config: cfg } } }));
  const out = shadow.runShadowComparison(dualDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(out.parity, false, 'Claude agent route must never parity-match');
  assert.ok(out.code === 'shadow-compile-failed' || out.code === 'shadow-projection-failed', 'fails closed with exact code: ' + out.code);
});
await check('R6.2 shadow performs zero writes to stores, ledgers, or sessions', async () => {
  const dataRoot = tmpDir('r62-store-clean-');
  const out = shadow.runShadowComparison(dualDecision, { installRoot: repoRoot, dataRoot: dataRoot });
  assert.equal(out.shadowOk, true);
  const leftovers = fs.readdirSync(dataRoot);
  assert.deepEqual(leftovers, [], 'shadow created no files under dataRoot: ' + JSON.stringify(leftovers));
});
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | SKIP ' + skipped + ' | total ' + (passed + failed + skipped));
if (failed > 0) { console.log('FAILURES:'); console.log(failures.join(String.fromCharCode(10))); process.exitCode = 1; }
})().catch((e) => { console.error('SUITE CRASH: ' + ((e && e.stack) || e)); process.exitCode = 1; });