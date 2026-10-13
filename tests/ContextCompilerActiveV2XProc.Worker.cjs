'use strict';
/**
 * ContextCompilerActiveV2XProc.Worker.cjs - one independent C08 active process.
 *
 * Invoked by tests/ContextCompilerActiveV2XProc.Tests.cjs with:
 *   --in <fixtureJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Fixture JSON shape: { compileInput, pages, ccv2Budget, counts,
 * capabilityRoute: { provider, model, maxContextTokens,
 * maxOutputTokens }, binding, systemText, toolsJson, framingJson }.
 * Uses ONLY the real production authorities
 * (config/ContextCompilerActiveV2.cjs over C01->C06 + renderer). The
 * counting authority is rebuilt from the stub fingerprint (production
 * closures never cross processes); transmitted counts are recomputed
 * from the transmitted texts and must match exactly. Always exits 0
 * after writing a JSON result ({ ok:true, viewId, viewDigest,
 * layoutDigest, renderDigest, finalInputTokens, mode,
 * decisionCanonical } or { ok:false, error }), so the parent can
 * collect every outcome without confusing a FAIL-CLOSED refusal with
 * a crashed process. The worker mutates no durable state and performs
 * no I/O beyond its three files.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const activeModule = require(path.join(repoRoot, 'config', 'ContextCompilerActiveV2.cjs'));
const capabilityModule = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const counterModule = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
const checkpointModule = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
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
function canonicalOf(value) {
  return JSON.stringify(checkpointModule.canonicalize(value));
}
function main() {
  const out = arg('--out');
  const write = (value) => {
    fs.writeFileSync(out, JSON.stringify(value));
  };
  try {
    const inFile = arg('--in');
    const goFile = arg('--go');
    waitForGo(goFile);
    const fixture = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const route = fixture.capabilityRoute;
    const capability = capabilityModule.createStubTestCapabilityV2({
      provider: route.provider, model: route.model,
      maxContextTokens: route.maxContextTokens, maxOutputTokens: route.maxOutputTokens,
    });
    const counter = capability.tokenCounter;
    // Count reconstruction proof: transmitted counts must equal fresh counts.
    const hostPrefixTokens = fixture.systemText === '' ? 0
      : counterModule.countTextVerifiedV2(counter, fixture.systemText);
    const toolSchemaTokens = counterModule.countTextVerifiedV2(counter, fixture.toolsJson);
    const framingTokens = counterModule.countTextVerifiedV2(counter, fixture.framingJson);
    if (hostPrefixTokens !== fixture.counts.hostPrefixTokens
      || toolSchemaTokens !== fixture.counts.toolSchemaTokens
      || framingTokens !== fixture.counts.framingTokens) {
      write({ ok: false, error: 'xproc-count-divergence' });
      return;
    }
    const decision = activeModule.attemptCompilerActiveV2({
      compileInput: fixture.compileInput,
      pages: fixture.pages,
      capability,
      ccv2Budget: fixture.ccv2Budget,
      hostPrefixTokens, toolSchemaTokens, framingTokens,
      reservedOutputTokens: fixture.counts.reservedOutputTokens,
      modelMax: fixture.counts.modelMax,
      binding: fixture.binding,
    });
    if (decision.eligible !== true) {
      write({ ok: false, error: 'xproc-ineligible:' + String(decision.fallbackReason) });
      return;
    }
    const recheck = activeModule.revalidateActiveRenderV2({ decision, liveBinding: fixture.binding });
    if (recheck.current !== true) {
      write({ ok: false, error: 'xproc-stale:' + String(recheck.fallbackReason) });
      return;
    }
    write({
      ok: true,
      viewId: decision.view.id,
      viewDigest: decision.view.viewDigest,
      layoutDigest: decision.layout.layoutDigest,
      renderDigest: decision.render.renderDigest,
      finalInputTokens: decision.tokenAccounting.finalInputTokens,
      mode: decision.mode,
      decisionCanonical: canonicalOf(activeModule.describeActiveDecisionV2(decision)),
    });
  } catch (error) {
    try {
      write({ ok: false, error: 'xproc-failed:' + String((error && error.message) || error).slice(0, 200) });
    } catch {
      // out file itself unwritable: nothing left to prove.
    }
  }
}
main();
