'use strict';
/**
 * ContextCompleteTaskV2XProc.Worker.cjs - A13 two-process integration worker.
 *
 * One independent OS process: runs ONE ContextCompleteTaskV2 operation
 * through the REAL production lock client (ContextActiveApplyLockClientV2
 * CLI authority: same CLI, same lock file, same lease/owner semantics as
 * production) and prints the outcome as JSON.
 * Usage:
 *   node ContextCompleteTaskV2XProc.Worker.cjs <specFile>
 *
 * specFile JSON (evaluate): { mode:'evaluate', ledgerWorkspace, runtimeDir,
 *   checkpointDir, operationRoot, taskId, taskInstanceId, sessionId,
 *   sessionFile, localSessionFile, taskStateFile, unitsFile, controller,
 *   sessionDurable, hostRuntime, provider, tokenObservation, faultAppends,
 *   resultFile }. The worker NEVER calls raw A10/A02: the integration owns
 *   the only production path (Controller -> A11 entry -> A10 -> A02).
 * specFile JSON (resume): { mode:'resume', ...dirs/ids..., sessionFile }.
 * specFile JSON (health): { mode:'health', ...dirs/ids..., sessionFile }.
 * Always exits 0 with a result line on stdout; the parent asserts on the
 * JSON, never on exit codes. pendingRequest bundles never cross the
 * process boundary (functions cannot serialize): the worker reports
 * hasPendingRequest + pendingGeneration instead.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const integ = require(path.join(repoRoot, 'config', 'ContextCompleteTaskV2.cjs'));
const lockClient = require(path.join(repoRoot, 'config', 'ContextActiveApplyLockClientV2.cjs'));
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));

function readSessionDouble(sessionFile) {
  const snap = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  return builders.makeSessionDouble(snap.events, snap.surface);
}
function writeSessionDouble(sessionFile, session) {
  fs.writeFileSync(sessionFile, JSON.stringify({ events: session.events, surface: session.surface.nodes }));
}
function serializableResult(result) {
  const out = {};
  for (const key of Object.keys(result || {})) {
    if (key === 'pendingRequest') continue;
    const value = result[key];
    if (typeof value === 'function') continue;
    out[key] = value;
  }
  out.hasPendingRequest = Boolean(result && result.pendingRequest);
  return out;
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const serialization = lockClient.createCliApplyLockClient({ workspace: spec.ledgerWorkspace, leaseSeconds: 60 });
  const base = {
    schemaVersion: 1,
    taskId: spec.taskId, taskInstanceId: spec.taskInstanceId, sessionId: spec.sessionId,
    runtimeDir: spec.runtimeDir, checkpointDir: spec.checkpointDir, operationRoot: spec.operationRoot,
  };
  try {
    if (spec.mode === 'resume') {
      const session = readSessionDouble(spec.sessionFile);
      const out = await integ.resumeTask(Object.assign({}, base, {
        session,
        flushFn: async (s) => { writeSessionDouble(spec.localSessionFile || spec.sessionFile, s); return true; },
      }));
      try { writeSessionDouble(spec.localSessionFile || spec.sessionFile, session); } catch (e) { /* keep */ }
      console.log(JSON.stringify({ ok: true, mode: 'resume', result: serializableResult(out) }));
      return;
    }
    if (spec.mode === 'health') {
      const session = readSessionDouble(spec.sessionFile);
      const out = integ.checkCompletionHealth(Object.assign({}, base, { session, terminal: spec.terminal === true }));
      console.log(JSON.stringify({ ok: true, mode: 'health', result: serializableResult(out) }));
      return;
    }
    if (spec.mode === 'evaluate') {
      const session = readSessionDouble(spec.sessionFile);
      const persistLocal = () => { try { writeSessionDouble(spec.localSessionFile || spec.sessionFile, flaky); } catch (e) { /* keep */ } };
      let flaky = session;
      if (Number(spec.faultAppends) > 0) {
        const hook = { appends: 0 };
        flaky = builders.makeSessionDouble(session.events, session.surface.nodes, {
          onAppend: () => { hook.appends += 1; if (hook.appends >= Number(spec.faultAppends)) throw new Error('injected A13 xproc partial crash'); },
        });
      }
      if (spec.writeThrough === true) {
        const origAppend = flaky.append.bind(flaky);
        flaky.append = (type, data, opts) => { const out = origAppend(type, data, opts); persistLocal(); return out; };
      }
      const taskState = JSON.parse(fs.readFileSync(spec.taskStateFile, 'utf8'));
      const contextUnits = JSON.parse(fs.readFileSync(spec.unitsFile, 'utf8'));
      const last = flaky.events.length - 1;
      const out = await integ.evaluateBoundary({
        schemaVersion: 1,
        taskId: spec.taskId, taskInstanceId: spec.taskInstanceId, sessionId: spec.sessionId,
        runtimeDir: spec.runtimeDir, checkpointDir: spec.checkpointDir, operationRoot: spec.operationRoot,
        lockWorkspace: spec.ledgerWorkspace,
        compactionVersion: 'v2',
        controller: spec.controller,
        sessionDurable: spec.sessionDurable || { flushedSeq: last, flushParticipated: true },
        hostRuntime: spec.hostRuntime || { currentSnapshotSeq: null, transitionOpen: false },
        provider: spec.provider,
        tokenObservation: spec.tokenObservation,
        session: flaky, taskState, contextUnits, protocolSpans: [],
        serialization,
        flushFn: async (s) => { writeSessionDouble(spec.localSessionFile || spec.sessionFile, s); return true; },
        stateCache: {}, createdAtUtc: builders.CREATED,
      });
      try { writeSessionDouble(spec.localSessionFile || spec.sessionFile, flaky); } catch (e) { /* keep */ }
      console.log(JSON.stringify({ ok: true, mode: 'evaluate', result: serializableResult(out) }));
      return;
    }
    console.log(JSON.stringify({ ok: false, mode: spec.mode, error: 'unknown worker mode' }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, mode: spec.mode, error: String((error && error.message) || error).slice(0, 500) }));
  }
}

main();
