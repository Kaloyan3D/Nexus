'use strict';
/**
 * ContextMemoryTierV2XProc.Worker.cjs - one independent B04 classifier process.
 *
 * Invoked by tests/ContextMemoryTierV2XProc.Tests.cjs with:
 *   --cases <casesJsonFile> --events <sessionEventsJsonFile> --go <barrierFile> --out <resultFile>
 *
 * Uses ONLY the real production authority (config/ContextMemoryTierV2.cjs
 * over frozen B01/B03/A03). Always exits 0 after writing a JSON result
 * ({ ok:true, decisions } or { ok:false, error }), so the parent can
 * collect every outcome without confusing a FAIL-CLOSED refusal with a
 * crashed process. Telemetry only: tiers, reason codes, digests, hash
 * prefixes - never evidence bytes.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const memSession = require(path.join(repoRoot, 'config', 'ContextSessionEvidenceSourceV2.cjs'));

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
    const cases = JSON.parse(fs.readFileSync(arg('--cases'), 'utf8'));
    const events = JSON.parse(fs.readFileSync(arg('--events'), 'utf8'));
    const sessionId = 'sess-b04-x';
    const decisions = cases.map((c) => {
      const input = { subjectKind: c.subjectKind };
      if (c.page !== undefined) input.page = c.page;
      if (c.checkpoint !== undefined) input.checkpoint = c.checkpoint;
      if (c.elementRef !== undefined) input.elementRef = c.elementRef;
      if (c.expectedNamespace !== undefined) input.expectedNamespace = c.expectedNamespace;
      if (c.needsSessionSource === true) {
        input.sources = { sessionSource: memSession.createMemorySessionSourceV2(sessionId, events) };
      }
      if (c.mandatoryCorrectness !== undefined) input.mandatoryCorrectness = c.mandatoryCorrectness;
      if (c.advisory !== undefined) input.advisory = c.advisory;
      return tier.classifyMemoryTierV2(input);
    });
    result = { ok: true, decisions };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  fs.writeFileSync(out, JSON.stringify(result));
}

main();
