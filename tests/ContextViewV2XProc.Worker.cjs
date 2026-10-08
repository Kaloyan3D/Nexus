'use strict';
/**
 * ContextViewV2XProc.Worker.cjs - one independent C01 view compiler process.
 *
 * Invoked by tests/ContextViewV2XProc.Tests.cjs with:
 *   --in <createInputJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Uses ONLY the real production authority (config/ContextViewV2.cjs).
 * Always exits 0 after writing a JSON result
 * ({ ok:true, id, viewDigest, canonical } or { ok:false, error }), so the
 * parent can collect every outcome without confusing a FAIL-CLOSED refusal
 * with a crashed process. Telemetry only: ids, digests, canonical bytes
 * of an already-exact fixture - never live task state.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
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
    const built = view.createContextViewV2(input);
    result = { ok: true, id: built.id, viewDigest: built.viewDigest, canonical: view.canonicalizeContextViewV2(built) };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}
main();
