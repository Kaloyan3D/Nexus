'use strict';
/**
 * ContextCompilerV2XProc.Worker.cjs - one independent C02 compiler process.
 *
 * Invoked by tests/ContextCompilerV2XProc.Tests.cjs with:
 *   --in <compileInputJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Uses ONLY the real production authority (config/ContextCompilerV2.cjs).
 * Always exits 0 after writing a JSON result
 * ({ ok:true, planDigest, planCanonical, viewId, viewDigest, viewCanonical }
 * or { ok:false, error }), so the parent can collect every outcome without
 * confusing a FAIL-CLOSED refusal with a crashed process. Telemetry only:
 * ids, digests, canonical bytes of an already-exact fixture - never live
 * task state. Branded B03 results never cross processes: the fixture uses
 * durably self-backed COLD material and identity-only references only.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const view = require(path.join(repoRoot, 'config', 'ContextViewV2.cjs'));
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function waitForGo(goFile) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (fs.existsSync(goFile)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error('xproc barrier timeout');
}
function main() {
  const out = arg('--out');
  let result = null;
  try {
    waitForGo(arg('--go'));
    const input = JSON.parse(fs.readFileSync(arg('--in'), 'utf8'));
    const compiled = compiler.compileContextV2(input);
    result = {
      ok: true,
      planDigest: compiled.plan.planDigest,
      planCanonical: JSON.stringify(compiled.plan),
      viewId: compiled.view.id,
      viewDigest: compiled.view.viewDigest,
      viewCanonical: view.canonicalizeContextViewV2(compiled.view),
    };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}
main();
