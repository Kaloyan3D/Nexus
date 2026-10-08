'use strict';
/**
 * ContextEvidenceRehydrationV2XProc.Worker.cjs - one independent B03 reader process.
 *
 * Invoked by tests/ContextEvidenceRehydrationV2XProc.Tests.cjs with:
 *   --root <contextRoot> --op <read-page|read-ref> --id <readerId>
 *   --page <pageId> | --ref <taskInstanceId:evidenceId>
 *   --ns <namespaceJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Uses ONLY the real production authority. Always exits 0 after writing a
 * JSON result ({ ok:true,... } or { ok:false, error }), so the parent can
 * collect every reader outcome without confusing a FAIL-CLOSED refusal with
 * a crashed process. Telemetry only: digests and byte counts, never evidence
 * bytes (binary-safe by construction).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const rehydrate = require(path.join(repoRoot, 'config', 'ContextEvidenceRehydrationV2.cjs'));

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

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function main() {
  const root = arg('--root');
  const op = arg('--op');
  const id = Number(arg('--id'));
  const go = arg('--go');
  const out = arg('--out');
  let result = null;
  try {
    waitForGo(go);
    const expectedNamespace = JSON.parse(fs.readFileSync(arg('--ns'), 'utf8'));
    if (op === 'read-page') {
      const res = rehydrate.rehydrateContextPageV2({ contextRoot: root, pageId: arg('--page'), expectedNamespace });
      result = {
        ok: true, op, id, verified: res.verified, pageId: res.pageId,
        contentHash: res.contentHash, sourceRoute: res.sourceRoute, mediaType: res.mediaType,
        textDigest: res.mediaType === 'text' ? sha256HexUtf8(res.exactText) : null,
        byteLength: res.mediaType === 'text' ? Buffer.byteLength(res.exactText, 'utf8') : res.exactBytes.length,
        bytesDigest: res.mediaType === 'binary' ? crypto.createHash('sha256').update(res.exactBytes).digest('hex') : null,
        resultDigest: res.resultDigest, sourceIdentity: res.sourceIdentity,
      };
    } else if (op === 'read-ref') {
      const parts = String(arg('--ref')).split(':');
      const res = rehydrate.rehydrateEvidenceRefV2({
        contextRoot: root, taskInstanceId: parts[0], evidenceId: parts.slice(1).join(':'),
        expectedNamespace,
      });
      result = {
        ok: true, op, id, verified: res.verified, pageId: res.pageId, evidenceId: res.evidenceId,
        contentHash: res.contentHash, sourceRoute: res.sourceRoute, mediaType: res.mediaType,
        textDigest: res.mediaType === 'text' ? sha256HexUtf8(res.exactText) : null,
        byteLength: res.mediaType === 'text' ? Buffer.byteLength(res.exactText, 'utf8') : res.exactBytes.length,
        resultDigest: res.resultDigest, sourceIdentity: res.sourceIdentity,
      };
    } else {
      throw new Error('unknown op ' + op);
    }
  } catch (error) {
    result = { ok: false, op, id: Number.isFinite(id) ? id : null, error: String(error && error.message).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}

main();
