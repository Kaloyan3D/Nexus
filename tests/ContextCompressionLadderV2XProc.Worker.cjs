'use strict';
/**
 * ContextCompressionLadderV2XProc.Worker.cjs - one independent C05 compression process.
 *
 * Invoked by tests/ContextCompressionLadderV2XProc.Tests.cjs with:
 *   --in <compressInputJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Compress input JSON shape: { view, pages, budget, counterFingerprint }.
 * The counter is rebuilt from its fingerprint string only (deterministic
 * test adapter); function closures are never serialized across processes.
 * Uses ONLY the real production authorities
 * (config/ContextCompressionLadderV2.cjs,
 * config/ContextTokenCounterV2.cjs, config/ContextViewV2.cjs). Always
 * exits 0 after writing a JSON result ({ ok:true, planDigest,
 * planCanonical, viewId, viewDigest, viewCanonical } or { ok:false,
 * error }), so the parent can collect every outcome without confusing a
 * FAIL-CLOSED refusal with a crashed process. Telemetry only: ids,
 * digests, canonical bytes of an already-exact fixture - never live task
 * state. The fixture uses inline pages only, so no store paths or
 * branded proofs cross processes.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const ladder = require(path.join(repoRoot, 'config', 'ContextCompressionLadderV2.cjs'));
const counterModule = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
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
    const counter = counterModule.createTokenCounterFromFingerprintV2(input.counterFingerprint);
    const compressed = ladder.compressContextViewV2({
      view: input.view, pages: input.pages, budget: input.budget, counter,
    });
    result = {
      ok: true,
      planDigest: compressed.compressionPlan.planDigest,
      planCanonical: JSON.stringify(compressed.compressionPlan),
      viewId: compressed.compressedView.id,
      viewDigest: compressed.compressedView.viewDigest,
      viewCanonical: view.canonicalizeContextViewV2(compressed.compressedView),
    };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}
main();
