'use strict';
// R7.1.1 - installed presets close over the Registry mode definitions.
// Live failure: NEXUS_REGISTRY_BINDING=1 produced shadow-compile-failed /
// registry-binding-unavailable with inner unknown-mode because
// data/.agent-presets/aih-muse/registry/modes/ held zero of the three mode
// definitions. registry/legacy-import.cjs loads them via __dirname-relative
// fs reads (not require), so the require-graph walk never discovered them.
// This suite builds REAL isolated installs with the actual closure tooling
// (prepare/copy/validate - the same functions Install-MusePreset.ps1 and
// Install-ControllerPresets.ps1 invoke), loads the Registry service from the
// preset-local copied module (never the checkout), and proves shadow parity
// through that preset-local module. Deterministic: no network, no pwsh,
// no sleeps; every root is an isolated tmp dir removed afterwards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = path.resolve(__dirname, '..');
const closureTool = require('../scripts/MusePresetDependencyClosure.cjs');
const MODES = Object.freeze([
  'registry/modes/engineering-v1.json',
  'registry/modes/engineering-v2.json',
  'registry/modes/engineering-v2-adaptive.json', // S10-A: the opt-in adaptive mode is part of the supported closure
  'registry/modes/engineering-v3.json',
]);
const MODE_IDS = Object.freeze(['engineering-v1', 'engineering-v2', 'engineering-v2-adaptive', 'engineering-v3']);
const PROFILES = Object.freeze(['muse', 'engineering', 'deepseek', 'controller']);
const LEGACY_JSONS = Object.freeze(['model-registry.json', 'engineering-profiles.json', 'muse-profiles.json']);
let passed = 0; let failed = 0; const failures = [];
function check(label, fn) {
  try { fn(); passed++; console.log('PASS: ' + label); }
  catch (e) { failed++; failures.push(label + ' :: ' + (e && e.message)); console.log('FAIL: ' + label + ' :: ' + (e && e.message)); }
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-registry-modes-'));
function installFixture(profile, tag) {
  const install = path.join(scratch, tag + '-' + profile + '-install');
  const preset = path.join(scratch, tag + '-' + profile + '-preset');
  const rows = closureTool.prepare(source, install, { profile });
  const copied = closureTool.copy(install, preset, { profile });
  const validated = closureTool.validate(install, preset, { profile });
  assert.deepEqual(copied.map((r) => r.name), rows.map((r) => r.name));
  assert.deepEqual(validated.map((r) => r.name), rows.map((r) => r.name));
  return { install, preset, rows };
}
// The preset-local Registry reads mode definitions from its own __dirname
// but legacy model/profile catalogs from the installRoot parameter (live
// layout: modules under data/.agent-presets/<preset>/, catalogs under the
// install config/). Replicate that split with an isolated install root.
function fakeInstallRoot(tag) {
  const root = path.join(scratch, tag + '-fake-install');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  for (const f of LEGACY_JSONS) fs.copyFileSync(path.join(source, 'config', f), path.join(root, 'config', f));
  return root;
}
try {
  for (const profile of PROFILES) {
    check('closure profile ' + profile + ' pins all four Registry mode assets', () => {
      const { preset, rows } = installFixture(profile, 'pin');
      const names = rows.map((r) => r.name);
      for (const mode of MODES) assert.ok(names.indexOf(mode) !== -1, profile + ' closure missing ' + mode);
      for (const mode of MODES) assert.ok(fs.existsSync(path.join(preset, mode)), profile + ' preset copy missing ' + mode);
      // Tokenizer assets are preserved for the three AI presets (controller
      // never shipped tokenizers - pre-existing boundary, unchanged here).
      if (profile !== 'controller') {
        assert.ok(names.indexOf('tokenizers/deepseek-v4-tokenizer.json') !== -1, profile + ' lost tokenizer asset');
      }
      // Manifest integrity: every pinned file carries a verifiable SHA-256.
      const { validate } = closureTool;
      assert.ok(typeof validate === 'function');
    });
  }
  check('preset-local Muse Registry lists all four mode definitions', () => {
    const { preset } = installFixture('muse', 'svc');
    const svc = require(path.join(preset, 'registry', 'service.cjs')).createService({
      installRoot: fakeInstallRoot('svc'), dataRoot: path.join(scratch, 'svc-data'),
    });
    const listed = svc.listModes();
    assert.equal(listed.modes.length, 4);
    assert.deepEqual(listed.modes.map((m) => m.id).sort(), MODE_IDS.slice().sort());
    for (const m of listed.modes) assert.equal(m.present, true, m.id + ' not present preset-locally');
  });
  check('preset-local Muse shadow reaches parity on a saved EMv2 config with contributor tier', () => {
    const { preset } = installFixture('muse', 'shadow');
    const installRoot = fakeInstallRoot('shadow');
    const dataRoot = path.join(scratch, 'shadow-data');
    fs.mkdirSync(dataRoot, { recursive: true });
    // Load Registry modules from the preset-local copy, never the checkout.
    const presetSvcMod = require(path.join(preset, 'registry', 'service.cjs'));
    const presetShadow = require(path.join(preset, 'registry', 'shadow-binding.cjs'));
    const presetDsh = require(path.join(preset, 'registry', 'dsh-adapter.cjs'));
    assert.ok(presetSvcMod.createService.toString().length > 0);
    const svc = presetSvcMod.createService({ installRoot, dataRoot });
    const staged = svc.getModeConfiguration('engineering-v2', {});
    assert.ok(staged.result && staged.result.config, 'no staged EMv2 config: ' + JSON.stringify(staged.errors));
    assert.equal(staged.result.config.modeId, 'engineering-v2');
    // Persist a real saved revision, then compile the SAVED config.
    const saved = svc.save('engineering-v2', staged.result.config, undefined, {});
    assert.equal(saved.ok, true, JSON.stringify(saved.errors || []));
    const reloaded = svc.getModeConfiguration('engineering-v2', {});
    assert.equal(reloaded.result.persisted, true);
    const compiled = svc.compilePreview(reloaded.result.config);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.errors || []));
    const binding = compiled.snapshot.roles && compiled.snapshot.roles.muse_main;
    assert.ok(binding, 'compiled EMv2 snapshot has no muse_main role');
    const projected = presetDsh.bindingToLegacyTarget(binding);
    assert.ok(projected && !projected.error && projected.target, 'muse_main does not project: ' + JSON.stringify(projected));
    const target = projected.target;
    // Build the COMPLETE matching Muse decision from the real projection
    // (same fields Route.ps1 emits for aih-muse: preset/engine/
    // executionClass/role/provider/model/reasoning/dataUseTier).
    const decision = {
      preset: 'aih-muse', engine: 'muse', executionClass: 'muse_main', role: null,
      provider: target.provider, model: target.model, reasoning: target.reasoning,
      dataUseTier: target.dataUseTier, writable: true,
    };
    const out = presetShadow.runShadowComparison(decision, { installRoot, dataRoot });
    assert.equal(out.shadowOk, true, JSON.stringify(out.errors || out.mismatches));
    assert.equal(out.parity, true, JSON.stringify(out.mismatches));
    assert.equal(out.code, 'shadow-parity');
    assert.equal(out.role, 'muse_main');
    assert.equal(out.modeId, 'engineering-v2');
    assert.equal(out.engine, 'muse');
    const byField = new Map(out.comparisons.map((c) => [c.field, c]));
    for (const field of ['provider', 'model', 'reasoning', 'engine', 'dataUseTier']) {
      const entry = byField.get(field);
      assert.ok(entry && entry.match === true, field + ' not compared/matched: ' + JSON.stringify(entry));
    }
    // Contributor data-use tier survives end to end on both planes.
    assert.equal(byField.get('dataUseTier').registry, 'contributor');
    assert.equal(byField.get('dataUseTier').legacy, 'contributor');
    assert.equal(out.projected.provider, decision.provider);
    assert.equal(out.projected.model, decision.model);
    assert.equal(out.projected.reasoning, decision.reasoning);
    assert.equal(out.projected.dataUseTier, 'contributor');
  });
  check('removing a required mode asset fails installation validation (fail-closed)', () => {
    const { install, preset } = installFixture('muse', 'negative');
    fs.rmSync(path.join(preset, 'registry', 'modes', 'engineering-v2.json'));
    assert.throws(() => closureTool.validate(install, preset, { profile: 'muse' }), /muse-closure-(installed|hash|missing)/);
  });
  check('preset-local shadow without mode assets reports missing definitions, never parity', () => {
    const { preset } = installFixture('muse', 'diag');
    const installRoot = fakeInstallRoot('diag');
    const dataRoot = path.join(scratch, 'diag-data');
    fs.mkdirSync(dataRoot, { recursive: true });
    // Persist a valid saved EMv2 config first (modes intact), then break the
    // preset copy the way the live defect did.
    const intactSvc = require(path.join(preset, 'registry', 'service.cjs')).createService({ installRoot, dataRoot });
    const staged = intactSvc.getModeConfiguration('engineering-v2', {});
    const saved = intactSvc.save('engineering-v2', staged.result.config, undefined, {});
    assert.equal(saved.ok, true);
    fs.rmSync(path.join(preset, 'registry', 'modes', 'engineering-v2.json'));
    const presetShadow = require(path.join(preset, 'registry', 'shadow-binding.cjs'));
    const out = presetShadow.runShadowComparison(
      { preset: 'aih-muse', engine: 'muse', executionClass: 'muse_main', role: null },
      { installRoot, dataRoot });
    assert.equal(out.shadowOk, false);
    assert.equal(out.parity, false);
    assert.equal(out.code, 'shadow-mode-definitions-missing');
    assert.ok(out.errors.some((e) => String(e.code).indexOf('registry-mode-definitions-missing') !== -1));
  });
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL ' + failed + ' | total ' + (passed + failed));
if (failed > 0) { console.log('FAILURES:'); console.log(failures.join('\n')); process.exitCode = 1; }
