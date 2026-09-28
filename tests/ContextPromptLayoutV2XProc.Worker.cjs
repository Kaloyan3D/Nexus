'use strict';
/**
 * ContextPromptLayoutV2XProc.Worker.cjs - one independent C06 layout process.
 *
 * Invoked by tests/ContextPromptLayoutV2XProc.Tests.cjs with:
 *   --in <layoutInputJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Layout input JSON shape: { view }. Uses ONLY the real production
 * authorities (config/ContextPromptLayoutV2.cjs, config/ContextViewV2.cjs).
 * No token counter crosses processes: layout planning needs no counting
 * authority. Always exits 0 after writing a JSON result ({ ok:true,
 * layoutDigest, stablePrefixDigest, layoutCanonical, sourceViewId,
 * sourceViewDigest } or { ok:false, error }), so the parent can collect
 * every outcome without confusing a FAIL-CLOSED refusal with a crashed
 * process. Telemetry only: ids, digests, canonical layout bytes of an
 * already-final fixture - never live task state.
 */
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const layoutModule = require(path.join(repoRoot, 'config', 'ContextPromptLayoutV2.cjs'));
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
    const planned = layoutModule.planContextPromptLayoutV2({ view: input.view });
    result = {
      ok: true,
      layoutDigest: planned.layout.layoutDigest,
      stablePrefixDigest: planned.layout.stablePrefixDigest,
      layoutCanonical: layoutModule.canonicalizeContextPromptLayoutV2(planned.layout),
      sourceViewId: planned.layout.sourceViewId,
      sourceViewDigest: planned.layout.sourceViewDigest,
    };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}
main();
