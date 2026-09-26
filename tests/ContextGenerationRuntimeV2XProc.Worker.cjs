'use strict';
/**
 * ContextGenerationRuntimeV2XProc.Worker.cjs - A11 two-process runtime worker.
 *
 * One independent OS process: runs ONE generation-runtime operation through
 * the REAL production lock client (same CLI authority, same lock file, same
 * lease/owner semantics as production) and prints the outcome as JSON.
 * Usage:
 *
 *   node ContextGenerationRuntimeV2XProc.Worker.cjs <specFile>
 *
 * specFile JSON (reserve): { mode:'reserve', ledgerWorkspace, runtimeDir,
 *   checkpointDir, operationRoot, taskId, taskInstanceId, sessionId,
 *   revisionDigest, snapshotTokenId, safePointBoundarySeq, preSleepMs }
 * specFile JSON (commit): { mode:'commit', ledgerWorkspace, runtimeDir,
 *   checkpointDir, operationRoot, taskId, taskInstanceId, sessionId,
 *   generation, activeResult, postApplyVerified, sessionFile }.
 * specFile JSON (apply-current): { mode:'apply-current', ledgerWorkspace,
 *   runtimeDir, checkpointDir, operationRoot, taskId, taskInstanceId,
 *   sessionId, fx (A10 fixture fields), sessionFile, inspectFirst,
 *   preSleepMs }. Runs the generation-aware entry (never raw A10).
 * specFile JSON (supersede): { mode:'supersede', ledgerWorkspace,
 *   runtimeDir, checkpointDir, operationRoot, taskId, taskInstanceId,
 *   sessionId, generation, observedRevisionDigest,
 *   observedSafePointBoundarySeq, payloadText, sessionFile }.
 * Always exits 0 with a result line on stdout; the parent asserts on the
 * JSON, never on exit codes.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtime = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
const lockClient = require(path.join(repoRoot, 'config', 'ContextActiveApplyLockClientV2.cjs'));
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (Number(spec.preSleepMs) > 0) await sleep(Number(spec.preSleepMs));
  const serialization = lockClient.createCliApplyLockClient({ workspace: spec.ledgerWorkspace, leaseSeconds: 60 });
  const base = {
    schemaVersion: 1,
    taskId: spec.taskId, taskInstanceId: spec.taskInstanceId, sessionId: spec.sessionId,
    runtimeDir: spec.runtimeDir, checkpointDir: spec.checkpointDir, operationRoot: spec.operationRoot,
    serialization, lockWorkspace: spec.ledgerWorkspace,
  };
  try {
    if (spec.mode === 'reserve') {
      const reservation = await runtime.reserveNextGenerationV2(Object.assign({}, base, {
        revisionDigest: spec.revisionDigest,
        snapshotTokenId: spec.snapshotTokenId === undefined ? null : spec.snapshotTokenId,
        safePointBoundarySeq: spec.safePointBoundarySeq,
      }));
      console.log(JSON.stringify({ ok: true, mode: 'reserve', generation: reservation.generation, reservationDigest: reservation.reservationDigest, parentCommittedCheckpointId: reservation.parentCommittedCheckpointId }));
      return;
    }
    if (spec.mode === 'commit') {
      let session = null;
      if (spec.sessionFile) {
        const snap = JSON.parse(fs.readFileSync(spec.sessionFile, 'utf8'));
        session = { events: snap.events };
      }
      const state = await runtime.commitGenerationV2(Object.assign({}, base, {
        generation: spec.generation, activeResult: spec.activeResult, postApplyVerified: true, session,
      }));
      console.log(JSON.stringify({ ok: true, mode: 'commit', head: state.latestCommittedGeneration, checkpointId: state.latestCommittedCheckpointId, highest: state.highestAllocatedGeneration }));
      return;
    }
    if (spec.mode === 'apply-current') {
      // Stale-handle simulation: optionally observe the runtime BEFORE the
      // window in which a contender supersedes, then attempt the entry.
      // The entry's final under-lock observation must still refuse.
      if (spec.inspectFirst === true) {
        runtime.inspectGenerationRuntimeV2({
          schemaVersion: 1,
          taskId: spec.taskId, taskInstanceId: spec.taskInstanceId, sessionId: spec.sessionId,
          runtimeDir: spec.runtimeDir, checkpointDir: spec.checkpointDir, operationRoot: spec.operationRoot,
          session: null,
        });
      }
      if (Number(spec.midSleepMs) > 0) await sleep(Number(spec.midSleepMs));
      const snap = JSON.parse(fs.readFileSync(spec.sessionFile, 'utf8'));
      const session = builders.makeSessionDouble(snap.events, snap.surface);
      const fx = spec.fx;
      const request = {
        schemaVersion: 1,
        taskId: fx.ts.taskId, taskInstanceId: fx.ts.taskInstanceId, sessionId: fx.ts.sessionId, generation: fx.ts.generation,
        shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
        snapshotToken: fx.token, snapshotCurrentState: builders.snapInputOf(fx.ts),
        safePointDecision: fx.safe, checkpointabilityDecision: fx.g, pressureDecision: fx.p,
        retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: [],
        session,
        checkpointDir: spec.checkpointDir,
        operationDir: runtime.operationDirForGenerationV2(spec.operationRoot, fx.ts.generation),
        flushFn: async (s) => {
          fs.writeFileSync(spec.sessionFile, JSON.stringify({ events: s.events, surface: s.surface.nodes }));
          return true;
        },
        serialization,
      };
      const out = await runtime.applyCurrentGenerationV2({
        schemaVersion: 1,
        taskId: spec.taskId, taskInstanceId: spec.taskInstanceId, sessionId: spec.sessionId,
        runtimeDir: spec.runtimeDir, checkpointDir: spec.checkpointDir,
        operationRoot: spec.operationRoot, lockWorkspace: spec.ledgerWorkspace,
        request,
      });
      const after = JSON.parse(fs.readFileSync(spec.sessionFile, 'utf8'));
      // A12: the full entry result is printed for cross-process commit races
      // (additive field; older parents ignore it). Frozen active-result shape.
      console.log(JSON.stringify({ ok: true, mode: 'apply-current', status: out.activeResult.status, mutated: out.activeResult.mutated, eventsLen: after.events.length, activeResult: out.activeResult }));
      return;
    }
    if (spec.mode === 'supersede') {
      const snap = JSON.parse(fs.readFileSync(spec.sessionFile, 'utf8'));
      const session = builders.makeSessionDouble(snap.events, snap.surface);
      const state = await runtime.supersedeGenerationV2(Object.assign({}, base, {
        generation: spec.generation,
        observedRevisionDigest: spec.observedRevisionDigest,
        observedSafePointBoundarySeq: spec.observedSafePointBoundarySeq,
        payloadText: spec.payloadText,
        session,
      }));
      const entry = state.generations.filter((g) => g.generation === spec.generation)[0];
      console.log(JSON.stringify({ ok: true, mode: 'supersede', outcome: entry && entry.outcome }));
      return;
    }
    console.log(JSON.stringify({ ok: false, error: 'unknown-mode' }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 400) }));
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 400) }));
});
