'use strict';
/**
 * ContextPageStoreV2XProc.Worker.cjs - one contending store writer process.
 *
 * Invoked by tests/ContextPageStoreV2XProc.Tests.cjs with:
 *   --root <contextRoot> --op <put-blob|put-page|put-conflict-page>
 *   --id <workerId> --go <barrierFile> --out <resultFile>
 *
 * Uses ONLY the real production authority. Always exits 0 after writing a
 * JSON result ({ ok:true,... } or { ok:false, error }), so the parent can
 * collect every contender's outcome without confusing a FAIL-CLOSED refusal
 * with a crashed process.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const NS = {
  taskId: 'TASK-B02-X',
  taskInstanceId: 'task_b02_x_0001',
  sessionId: 'sess-b02-x',
  workspaceId: '/tmp/nexus-b02-x',
  repositoryId: 'repo-b02',
  checkoutId: 'checkout-b02',
};

const BLOB_BYTES = 'xproc shared fixture bytes\nsecond line\n';
const CONFLICT_GLOSSES = ['alpha contender', 'beta contender', 'gamma contender', 'delta contender'];

function basePage(gloss) {
  return page.createContextPageV2({
    kind: 'conversation',
    namespace: Object.assign({}, NS),
    sourceKind: 'user',
    sourceRefs: ['session-event:61'],
    mutability: 'immutable',
    sourceSeqs: [61],
    exactText: 'XProc contention evidence unit.',
    semanticGloss: gloss,
    createdAtGeneration: 1,
  });
}

function waitForGo(goFile) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (fs.existsSync(goFile)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error('xproc barrier timeout');
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
    if (op === 'put-blob') {
      const res = store.putBlobV2(root, BLOB_BYTES);
      result = { ok: true, op, id, blobRef: res.blobRef, deduplicated: res.deduplicated };
    } else if (op === 'put-page') {
      const p = basePage('shared contender gloss');
      const res = store.putContextPageV2(root, p, { expectedNamespace: Object.assign({}, NS) });
      result = { ok: true, op, id, pageId: res.pageId, pageRecordDigest: res.pageRecordDigest };
    } else if (op === 'put-conflict-page') {
      const p = basePage(CONFLICT_GLOSSES[id % CONFLICT_GLOSSES.length]);
      const res = store.putContextPageV2(root, p, { expectedNamespace: Object.assign({}, NS) });
      result = { ok: true, op, id, pageId: res.pageId, gloss: CONFLICT_GLOSSES[id % CONFLICT_GLOSSES.length] };
    } else {
      throw new Error('unknown op ' + op);
    }
  } catch (error) {
    result = { ok: false, op, id, error: String(error && error.message).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}

main();
