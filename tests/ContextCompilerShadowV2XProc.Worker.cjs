'use strict';
/**
 * ContextCompilerShadowV2XProc.Worker.cjs - one independent C07 shadow process.
 *
 * Invoked by tests/ContextCompilerShadowV2XProc.Tests.cjs with:
 *   --in <fixtureJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Fixture JSON shape: { compileInput, pages, budget, actual,
 * tokenizerFingerprint }. Uses ONLY the real production authorities
 * (config/ContextCompilerShadowV2.cjs over C01->C06). The counting
 * authority is rebuilt from its fingerprint string (only the
 * deterministic test adapter is reconstructable cross-process); no
 * closures cross processes. Always exits 0 after writing a JSON result
 * ({ ok:true, viewId, viewDigest, layoutDigest, stablePrefixDigest,
 * comparisonDigest, reportCanonical, status, promotionBlocker } or
 * { ok:false, error }), so the parent can collect every outcome without
 * confusing a FAIL-CLOSED refusal with a crashed process. Telemetry
 * only: ids, digests, canonical report bytes of an already-final
 * synthetic fixture - never live task state. The worker mutates no
 * durable state and performs no I/O beyond its three files.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const shadowModule = require(path.join(repoRoot, 'config', 'ContextCompilerShadowV2.cjs'));
const counterModule = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
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
    const counter = counterModule.createTokenCounterFromFingerprintV2(input.tokenizerFingerprint);
    const candidateResult = shadowModule.buildCandidateV2({
      compileInput: input.compileInput,
      pages: input.pages,
      budget: input.budget,
      counter,
    });
    const comparison = shadowModule.compareShadowV2({
      actual: input.actual,
      candidate: candidateResult.candidateObservation,
      captureSnapshotRevision: input.actual.checkpointBinding.snapshotRevision,
      completeSnapshotRevision: input.actual.checkpointBinding.snapshotRevision,
    });
    const report = shadowModule.buildShadowReportV2({
      actual: input.actual,
      candidateResult,
      comparison,
      tokenizerFingerprint: candidateResult.candidateObservation.tokenizerFingerprint,
    });
    result = {
      ok: true,
      viewId: candidateResult.candidateObservation.viewId,
      viewDigest: candidateResult.candidateObservation.viewDigest,
      layoutDigest: candidateResult.candidateObservation.layoutDigest,
      stablePrefixDigest: candidateResult.candidateObservation.stablePrefixDigest,
      comparisonDigest: comparison.comparisonDigest,
      reportCanonical: shadowModule.canonicalizeShadowReportV2(report),
      status: comparison.status,
      promotionBlocker: comparison.promotionBlocker,
    };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}
main();
