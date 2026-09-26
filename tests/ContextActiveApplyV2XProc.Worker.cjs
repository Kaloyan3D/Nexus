'use strict';
/**
 * ContextActiveApplyV2XProc.Worker.cjs - H1 two-process apply worker.
 *
 * One independent OS process: loads a file-backed session, runs the full
 * A10 path with the REAL production lock client (same CLI authority, same
 * lock file, same lease/owner semantics as production), persists through a
 * file-writing flushFn (the durable store seam), and prints the result as
 * JSON. Usage:
 *
 *   node ContextActiveApplyV2XProc.Worker.cjs <specFile>
 *
 * specFile JSON: { fx, ledgerWorkspace, sessionFile, checkpointDir,
 * operationDir, flushSleepMs, leaseSeconds }. fx is a complete internally
 * consistent shadow-ready fixture (built by the parent through the real
 * A05-A09 authorities). Always exits 0 with a result line on stdout; the
 * parent asserts on the JSON, never on exit codes.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const active = require(path.join(repoRoot, 'config', 'ContextActiveApplyV2.cjs'));
const lockClient = require(path.join(repoRoot, 'config', 'ContextActiveApplyLockClientV2.cjs'));
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return String(haystack).split(String(needle)).length - 1;
}
function messageTexts(messages) {
  const texts = [];
  const walk = (value) => {
    if (typeof value === 'string') { texts.push(value); return; }
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    if (value !== null && typeof value === 'object') {
      if (typeof value.text === 'string' && value.type === 'text') texts.push(value.text);
      else { for (const key of Object.keys(value)) { if (key !== 'id') walk(value[key]); } }
    }
  };
  for (const message of messages || []) walk(message);
  return texts;
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const fx = spec.fx;
  const snap = JSON.parse(fs.readFileSync(spec.sessionFile, 'utf8'));
  const session = builders.makeSessionDouble(snap.events, snap.surface);
  const serialization = lockClient.createCliApplyLockClient({
    workspace: spec.ledgerWorkspace,
    leaseSeconds: spec.leaseSeconds,
  });
  const input = {
    schemaVersion: 1,
    taskId: fx.ts.taskId,
    taskInstanceId: fx.ts.taskInstanceId,
    sessionId: fx.ts.sessionId,
    generation: fx.ts.generation,
    shadowResult: fx.result,
    sealedCheckpoint: fx.sealed,
    projectionArtifact: fx.artifact,
    snapshotToken: fx.token,
    snapshotCurrentState: builders.snapInputOf(fx.ts),
    safePointDecision: fx.safe,
    checkpointabilityDecision: fx.g,
    pressureDecision: fx.p,
    retentionPlan: fx.plan,
    taskState: fx.ts,
    contextUnits: fx.units,
    protocolSpans: [],
    session,
    checkpointDir: spec.checkpointDir,
    operationDir: spec.operationDir,
    flushFn: async (s) => {
      if (Number(spec.flushSleepMs) > 0) await sleep(Number(spec.flushSleepMs));
      fs.writeFileSync(spec.sessionFile, JSON.stringify({ events: s.events, surface: s.surface.nodes }));
      return true;
    },
    serialization,
  };
  let res = null;
  try {
    res = await active.applyActiveCompactionV2(input);
  } catch (error) {
    console.log(JSON.stringify({ workerError: String((error && error.message) || error).slice(0, 300) }));
    return;
  }
  const joinedTexts = messageTexts(session.deriveMessages()).join(' ');
  console.log(JSON.stringify({
    status: res.status,
    codes: res.blockers.map((b) => b.code),
    mutated: res.mutated,
    durable: res.durable,
    intentDurable: res.intentDurable,
    applicationDurable: res.applicationDurable,
    operationId: res.operationId,
    eventsLen: session.events.length,
    surfaceLen: session.surface.nodes.length,
    payloadCount: countOccurrences(joinedTexts, fx.artifact.payloadText),
    currentCount: countOccurrences(joinedTexts, 'u6-current'),
  }));
}

main().catch((error) => {
  console.log(JSON.stringify({ workerError: String((error && error.message) || error).slice(0, 300) }));
});
