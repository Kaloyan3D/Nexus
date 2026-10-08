'use strict';
/**
 * ContextRetrieverV2XProc.Worker.cjs - one independent C03 retrieval process.
 *
 * Invoked by tests/ContextRetrieverV2XProc.Tests.cjs with:
 *   --in <fixtureJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Uses ONLY the real production authorities (config/ContextRetrieverV2.cjs
 * + config/ContextEvidenceIndexV2.cjs) with no shared module state.
 * Always exits 0 after writing a JSON result
 * ({ ok:true, indexId, resultDigest, resultCanonical } or
 * { ok:false, error }), so the parent can collect every outcome without
 * confusing a FAIL-CLOSED refusal with a crashed process. Identity-only
 * mode over an already-exact JSON fixture: no store reads, no session or
 * repository sources, no live task state.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const retriever = require(path.join(repoRoot, 'config', 'ContextRetrieverV2.cjs'));
const evidenceIndex = require(path.join(repoRoot, 'config', 'ContextEvidenceIndexV2.cjs'));
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
    const fixture = JSON.parse(fs.readFileSync(arg('--in'), 'utf8'));
    const index = evidenceIndex.buildEvidenceIndexV2({
      namespace: fixture.namespace, pages: fixture.pages,
    });
    const retrieved = retriever.retrieveContextEvidenceV2({
      namespace: fixture.namespace,
      exactEvidenceIds: [],
      exactPageIds: [],
      fileIdentities: [{ path: 'xproc/svc.ts' }],
      symbolIdentities: [{ symbol: 'xprocFn' }],
      lexicalTerms: ['xproc', 'canary', 'грешка', 'café', 'σφάλμα', '日本語', 'потребител', 'straße'],
      limit: 10,
      mode: 'identity-only',
      evidenceIndex: index,
      pages: fixture.pages,
    });
    result = {
      ok: true,
      indexId: index.indexId,
      resultDigest: retrieved.resultDigest,
      resultCanonical: retriever.canonicalizeRetrievalResultV2(retrieved),
    };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}
main();
