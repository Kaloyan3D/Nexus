'use strict';
/**
 * ContextGenerationRuntimeV2XProc.Tests.cjs - A11 two-process allocation proof.
 *
 * Real independent OS processes contend for generation identity through the
 * REAL production lock authority (ContextLifecycleCli.ps1 acquire/release
 * against a real ledger workspace with a real task binding). No in-process
 * doubles stand in for exclusion. Proves: concurrent identical reservations
 * converge on one generation (never two incompatible G2s), a conflicting
 * contender refuses, repeated commit-head advancement converges idempotently,
 * and no fork/corrupt head results.
 *
 * ENVIRONMENTAL skip (never faked): pwsh or git absent.
 */
const { execFileSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtime = require(path.join(repoRoot, 'config', 'ContextGenerationRuntimeV2.cjs'));
const active = require(path.join(repoRoot, 'config', 'ContextActiveApplyV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));

const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
const WORKER = path.join(__dirname, 'ContextGenerationRuntimeV2XProc.Worker.cjs');

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(t) { console.log(''); console.log('--- ' + t + ' ---'); }
const clone = (o) => JSON.parse(JSON.stringify(o));

function pwshAvailable() {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8', timeout: 60000 });
    return true;
  } catch { return false; }
}
function pwsh(script, args, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-'));
  const payloadFile = path.join(dir, 'p.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  try {
    const out = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args).concat(['-PayloadFile', payloadFile]), { encoding: 'utf8', timeout: 120000 });
    const text = out.trim();
    return text === '' ? null : JSON.parse(text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function runWorker(specFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, specFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
function parseResult(run) {
  const NL = String.fromCharCode(10);
  const parts = String(run.out).split(NL);
  const line = parts.map((l) => l.trim()).filter((l) => l.charAt(0) === '{').pop();
  assert.ok(line, 'worker printed a result line (code=' + run.code + ' err=' + String(run.err).slice(0, 200) + ')');
  return JSON.parse(line);
}
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// Ledger-bound shadow-ready fixture (the lock authority scopes by ledger
// task; the operation binding follows the same ids).
function buildLedgerFixture(taskId, taskInstanceId, sessionId, requirementText, generation, parentCheckpointId) {
  const gen = generation === undefined ? 1 : generation;
  const fx0 = builders.buildHappy('single');
  const ts0 = builders.draftTaskState(3, 3, { taskId, taskInstanceId, sessionId, workspaceId: '/tmp/nexus-a11x', generation: gen });
  ts0.requirements = [{ id: 'R1', text: requirementText, status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }];
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId }));
  const ts = builders.finalizeTs(ts0);
  const token = snapshotV2.capture(builders.snapInputOf(ts), builders.CREATED);
  const safe = builders.safeDecisionFor(ts);
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = builders.pressureFor(token, 100000);
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: builders.boundaryCtx(fx0.events, ts.taskRevision), contextUnits: fx0.units, protocolSpans: [] });
  const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: parentCheckpointId === undefined ? null : parentCheckpointId, snapshotToken: token, snapshotCurrentState: builders.snapInputOf(ts), safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: unitsOf(fx0), sessionEvents: fx0.events, surfaceNodes: fx0.surface, protocolSpans: [], createdAtUtc: builders.CREATED, sealedAtUtc: builders.CREATED });
  assert.equal(result.verdict, 'shadow-ready', 'xproc fixture must be shadow-ready');
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: parentCheckpointId === undefined ? null : parentCheckpointId, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: builders.CREATED, sealedAtUtc: builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: unitsOf(fx0), sourceEvents: fx0.events, surfaceNodes: fx0.surface, protocolSpans: [] });
  return { ts, token, safe, g, p, plan, units: unitsOf(fx0), events: fx0.events, surface: fx0.surface, result, sealed: sealed.sealedCheckpoint, artifact };
}
function unitsOf(fx) { return clone(fx.units); }

async function main() {
  if (!pwshAvailable()) {
    console.log('SKIP: pwsh is absent; the A11 two-process proof is PENDING (never faked).');
    process.exit(0);
  }
  try { execFileSync('git', ['--version']); }
  catch {
    console.log('SKIP: git is absent; the A11 two-process proof is PENDING (never faked).');
    process.exit(0);
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-ws-'));
  try {
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'a11x@example.invalid']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'a11x']);
    fs.writeFileSync(path.join(workspace, '.a11xbaseline'), 'baseline');
    execFileSync('git', ['-C', workspace, 'add', '.a11xbaseline']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'baseline']);
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'a11x fixture', reviewRequested: false, engine: 'dual' });
    assert.ok(task && task.taskId && task.taskInstanceId, 'ledger task exists for the lock scope');
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-a11x';
    const lockPath = path.join(workspace, '.ai-harness', 'runs', taskId, 'context-compaction-apply.lock');
    const dirs = {
      runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-rt-')),
      checkpointDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-ckpt-')),
      operationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-op-')),
    };
    const writeSpec = (spec) => {
      const f = path.join(os.tmpdir(), 'a11x-spec-' + process.pid + '-' + Math.floor(Math.random() * 1000000) + '.json');
      fs.writeFileSync(f, JSON.stringify(spec));
      return f;
    };
    const reserveSpec = (revisionDigest, boundary, preSleepMs) => ({
      mode: 'reserve', ledgerWorkspace: workspace,
      runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
      taskId, taskInstanceId, sessionId,
      revisionDigest, snapshotTokenId: null, safePointBoundarySeq: boundary, preSleepMs: preSleepMs || 0,
    });

    section('XPROC concurrent identical reservations converge on one generation');
    const revA = sha('a11x-state-A');
    const [runA, runB] = await Promise.all([
      runWorker(writeSpec(reserveSpec(revA, 3, 1500))),
      runWorker(writeSpec(reserveSpec(revA, 3, 1500))),
    ]);
    // Symmetric race: either contender may win. Allowed outcomes per
    // section 18: the loser observes/reuses the same reservation, or refuses
    // while the winner holds the lock (never a second incompatible G1).
    // A refused loser retries and must converge on the winner's reservation.
    let resA = parseResult(runA);
    let resB = parseResult(runB);
    const winners = [resA, resB].filter((r) => r.ok === true);
    const losers = [resA, resB].filter((r) => r.ok !== true);
    check(winners.length >= 1, 'at least one contender reserves (A=' + JSON.stringify(resA).slice(0, 160) + ' B=' + JSON.stringify(resB).slice(0, 160) + ')');
    for (const loser of losers) {
      check(/generation-/.test(loser.error || ''), 'loser refuses with a stable code (got ' + JSON.stringify(loser).slice(0, 160) + ')');
    }
    for (const loser of losers) {
      const retry = parseResult(await runWorker(writeSpec(reserveSpec(revA, 3, 0))));
      check(retry.ok === true, 'refused contender converges on retry (got ' + JSON.stringify(retry).slice(0, 160) + ')');
      check(retry.generation === winners[0].generation && retry.reservationDigest === winners[0].reservationDigest, 'retry observes the same reservation');
    }
    if (winners.length === 2) {
      check(resA.generation === resB.generation && resA.reservationDigest === resB.reservationDigest, 'both winners share one compatible reservation (no duplicate G' + resA.generation + ')');
    }
    resA = winners[0]; resB = winners.length === 2 ? winners[1] : winners[0];
    const head1 = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId, taskInstanceId, sessionId, runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot, session: null });
    check(head1.highestAllocatedGeneration === 1, 'one allocation consumed exactly one generation (highest=1)');
    check(!fs.existsSync(lockPath), 'no lock residue after the reservation race');

    section('XPROC conflicting contender refuses (never a second incompatible G1)');
    const revB = sha('a11x-state-B');
    const resC = parseResult(await runWorker(writeSpec(reserveSpec(revB, 9, 0))));
    check(resC.ok === false && /generation-/.test(resC.error || ''), 'conflicting reservation refuses (got ' + JSON.stringify(resC).slice(0, 200) + ')');
    const head2 = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId, taskInstanceId, sessionId, runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot, session: null });
    check(head2.highestAllocatedGeneration === 1, 'conflict consumes no new generation');

    section('XPROC concurrent commit-head advancement converges idempotently');
    const fx = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'Commit the XProc head exactly once.');
    const session = builders.makeSessionDouble(fx.events, fx.surface);
    const fakeLock = builders.makeFakeLockClient();
    const applied = await active.applyActiveCompactionV2({
      schemaVersion: 1, taskId, taskInstanceId, sessionId, generation: 1,
      shadowResult: fx.result, sealedCheckpoint: fx.sealed, projectionArtifact: fx.artifact,
      snapshotToken: fx.token, snapshotCurrentState: builders.snapInputOf(fx.ts),
      safePointDecision: fx.safe, checkpointabilityDecision: fx.g, pressureDecision: fx.p,
      retentionPlan: fx.plan, taskState: fx.ts, contextUnits: fx.units, protocolSpans: [],
      session, checkpointDir: dirs.checkpointDir,
      operationDir: runtime.operationDirForGenerationV2(dirs.operationRoot, 1),
      flushFn: async () => true, serialization: fakeLock,
    });
    check(applied.status === 'committed', 'parent A10 G1 commits (got ' + applied.status + ')');
    const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-sess-')), 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({ events: session.events }));
    const commitSpec = {
      mode: 'commit', ledgerWorkspace: workspace,
      runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
      taskId, taskInstanceId, sessionId, generation: 1, activeResult: applied, sessionFile,
    };
    const [runC1, runC2] = await Promise.all([
      runWorker(writeSpec(Object.assign({ preSleepMs: 1200 }, commitSpec))),
      runWorker(writeSpec(Object.assign({ preSleepMs: 1200 }, commitSpec))),
    ]);
    let resC1 = parseResult(runC1);
    let resC2 = parseResult(runC2);
    const headWinners = [resC1, resC2].filter((r) => r.ok === true);
    check(headWinners.length >= 1, 'at least one committer advances the head (C1=' + JSON.stringify(resC1).slice(0, 150) + ' C2=' + JSON.stringify(resC2).slice(0, 150) + ')');
    for (const loser of [resC1, resC2].filter((r) => r.ok !== true)) {
      check(/generation-/.test(loser.error || ''), 'head-race loser refuses with a stable code');
      const retry = parseResult(await runWorker(writeSpec(commitSpec)));
      check(retry.ok === true, 'head-race loser converges on retry (got ' + JSON.stringify(retry).slice(0, 150) + ')');
      headWinners.push(retry);
    }
    resC1 = headWinners[0]; resC2 = headWinners[headWinners.length - 1];
    check(resC1.head === 1 && resC2.head === 1 && resC1.checkpointId === resC2.checkpointId, 'both processes converge on the same committed head');
    check(resC1.checkpointId === applied.checkpointId, 'converged head binds the proven checkpoint');
    const final = runtime.inspectGenerationRuntimeV2({ schemaVersion: 1, taskId, taskInstanceId, sessionId, runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot, session: { events: session.events } });
    check(final.latestCommittedGeneration === 1 && final.highestAllocatedGeneration === 1, 'durable head is coherent (no fork, no corrupt head)');
    check(!fs.existsSync(lockPath), 'no lock residue after head convergence');

    section('XPROC supersession is architectural: old handles never apply (H1.4/H1.5)');
    // Fresh ledger scope for the supersession race (same workspace authority).
    const task2 = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'a11x supersede fixture', reviewRequested: false, engine: 'dual' });
    const t2 = task2.taskId;
    const ti2 = task2.taskInstanceId;
    const s2 = 'sess-a11x-sup';
    const dirs2 = {
      runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-rt2-')),
      checkpointDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-ckpt2-')),
      operationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-op2-')),
    };
    const lock2Path = path.join(workspace, '.ai-harness', 'runs', t2, 'context-compaction-apply.lock');
    const fake2 = builders.makeFakeLockClient();
    const bind2 = (lock) => ({
      schemaVersion: 1, taskId: t2, taskInstanceId: ti2, sessionId: s2,
      runtimeDir: dirs2.runtimeDir, checkpointDir: dirs2.checkpointDir, operationRoot: dirs2.operationRoot,
      serialization: lock, lockWorkspace: workspace,
    });
    const freezeIntent2 = (fx, generation) => {
      const trust2 = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));
      const ckpt2 = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
      trust2.persistSealedCheckpointV2(dirs2.checkpointDir, { checkpoint: clone(fx.sealed), serialized: ckpt2.serializeCheckpointCanonical(fx.sealed) });
      const unioned = [];
      for (const seg of fx.artifact.segments) for (const seq of seg.sourceEventSeqs) unioned.push(seq);
      unioned.sort((a, b2) => a - b2);
      const draft = {
        schemaVersion: 2, operationId: fx.artifact.operationId,
        attemptId: active.deriveAttemptIdV2(fx.artifact.operationId),
        taskId: t2, taskInstanceId: ti2, sessionId: s2,
        workspace: '/tmp/nexus-a11x', repositoryId: null, checkoutId: null,
        checkpointGeneration: generation, checkpointId: fx.result.checkpoint.checkpointId,
        checkpointContentDigest: fx.result.checkpoint.checkpointContentDigest, checkpointPath: null,
        snapshotTokenId: fx.token.snapshotTokenId, safePointBoundarySeq: fx.safe.boundarySeq,
        sourceEventSeqs: unioned, segments: clone(fx.artifact.segments), lifecycle: 'frozen',
      };
      const expected = { taskId: t2, taskInstanceId: ti2, sessionId: s2, workspace: '/tmp/nexus-a11x', repositoryId: null, checkoutId: null, checkpointGeneration: generation, checkpointId: fx.result.checkpoint.checkpointId };
      return compaction.freezeCompactionOperationV2(runtime.operationDirForGenerationV2(dirs2.operationRoot, generation), draft, expected);
    };
    // G1 commits (parent, fake lock); the file-backed session carries the
    // real G1 landing for worker-side committed-head validation.
    const fxG1 = buildLedgerFixture(t2, ti2, s2, 'XProc supersede-chain G1.');
    await runtime.reserveNextGenerationV2(Object.assign(bind2(fake2), {
      revisionDigest: fxG1.token.revisionDigest, snapshotTokenId: fxG1.token.snapshotTokenId, safePointBoundarySeq: fxG1.safe.boundarySeq,
    }));
    const sessG1 = builders.makeSessionDouble(fxG1.events, fxG1.surface);
    const apG1 = await active.applyActiveCompactionV2({
      schemaVersion: 1, taskId: t2, taskInstanceId: ti2, sessionId: s2, generation: 1,
      shadowResult: fxG1.result, sealedCheckpoint: fxG1.sealed, projectionArtifact: fxG1.artifact,
      snapshotToken: fxG1.token, snapshotCurrentState: builders.snapInputOf(fxG1.ts),
      safePointDecision: fxG1.safe, checkpointabilityDecision: fxG1.g, pressureDecision: fxG1.p,
      retentionPlan: fxG1.plan, taskState: fxG1.ts, contextUnits: fxG1.units, protocolSpans: [],
      session: sessG1, checkpointDir: dirs2.checkpointDir,
      operationDir: runtime.operationDirForGenerationV2(dirs2.operationRoot, 1),
      flushFn: async () => true, serialization: fake2,
    });
    check(apG1.status === 'committed', 'xproc supersede-chain G1 commits');
    await runtime.commitGenerationV2(Object.assign(bind2(fake2), { generation: 1, activeResult: apG1, postApplyVerified: true, session: sessG1 }));
    // G2 reserves + intent goes durable with zero landing; state moves.
    const fxG2 = buildLedgerFixture(t2, ti2, s2, 'XProc G2 intent (stale).', 2, apG1.checkpointId);
    await runtime.reserveNextGenerationV2(Object.assign(bind2(fake2), {
      revisionDigest: fxG2.token.revisionDigest, snapshotTokenId: fxG2.token.snapshotTokenId, safePointBoundarySeq: fxG2.safe.boundarySeq,
    }));
    freezeIntent2(fxG2, 2);
    const fxG2moved = buildLedgerFixture(t2, ti2, s2, 'XProc G2 moved state.', 2, apG1.checkpointId);
    check(fxG2moved.token.revisionDigest !== fxG2.token.revisionDigest, 'xproc interrupt really moves the revision');
    const sessionFile2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a11x-sess2-')), 'session.json');
    fs.writeFileSync(sessionFile2, JSON.stringify({ events: sessG1.events, surface: sessG1.surface.nodes }));
    const payload2 = shadow.checkpointPayloadTextOf(fxG2.sealed);
    const applySpec2 = {
      mode: 'apply-current', ledgerWorkspace: workspace,
      runtimeDir: dirs2.runtimeDir, checkpointDir: dirs2.checkpointDir, operationRoot: dirs2.operationRoot,
      taskId: t2, taskInstanceId: ti2, sessionId: s2, fx: fxG2, sessionFile: sessionFile2,
    };
    // Process A supersedes G2 through the REAL lock authority.
    const resSup = parseResult(await runWorker(writeSpec({
      mode: 'supersede', ledgerWorkspace: workspace,
      runtimeDir: dirs2.runtimeDir, checkpointDir: dirs2.checkpointDir, operationRoot: dirs2.operationRoot,
      taskId: t2, taskInstanceId: ti2, sessionId: s2, generation: 2,
      observedRevisionDigest: fxG2moved.token.revisionDigest,
      observedSafePointBoundarySeq: fxG2moved.safe.boundarySeq,
      payloadText: payload2, sessionFile: sessionFile2,
    })));
    check(resSup.ok === true && resSup.outcome === 'SUPERSEDED', 'process A supersedes G2 (got ' + JSON.stringify(resSup).slice(0, 160) + ')');
    // Process B holds the old G2 handle and attempts the generation-aware
    // entry: refused as superseded with zero mutation.
    const bytesBefore = fs.readFileSync(sessionFile2, 'utf8');
    const eventsBefore = JSON.parse(bytesBefore).events.length;
    const resB2 = parseResult(await runWorker(writeSpec(applySpec2)));
    check(resB2.ok === false && /superseded|cannot-supersede/.test(resB2.error || ''), 'process B entry refuses the superseded handle (got ' + JSON.stringify(resB2).slice(0, 200) + ')');
    check(fs.readFileSync(sessionFile2, 'utf8') === bytesBefore, 'refused cross-process attempt mutates nothing (0 new events)');
    // Repeat after restart: still refused, still zero landing.
    const resB2r = parseResult(await runWorker(writeSpec(applySpec2)));
    check(resB2r.ok === false && /superseded|cannot-supersede/.test(resB2r.error || ''), 'post-restart attempt still refuses (got ' + JSON.stringify(resB2r).slice(0, 160) + ')');
    check(JSON.parse(fs.readFileSync(sessionFile2, 'utf8')).events.length === eventsBefore, 'post-restart attempt appends zero events');
    // H1.5 stale pre-supersession handle: B observes active G3, sleeps
    // while the parent supersedes through the REAL client, then the entry
    // must refuse via its final under-lock observation.
    const fxG3 = buildLedgerFixture(t2, ti2, s2, 'XProc G3 intent (stale).', 3, apG1.checkpointId);
    const r3 = await runtime.reserveNextGenerationV2(Object.assign(bind2(fake2), {
      revisionDigest: fxG3.token.revisionDigest, snapshotTokenId: fxG3.token.snapshotTokenId, safePointBoundarySeq: fxG3.safe.boundarySeq,
    }));
    check(r3.generation === 3, 'xproc G3 reserves past superseded G2 (got G' + r3.generation + ')');
    freezeIntent2(fxG3, 3);
    const fxG3moved = buildLedgerFixture(t2, ti2, s2, 'XProc G3 moved state.', 3, apG1.checkpointId);
    const staleRun = runWorker(writeSpec(Object.assign({ inspectFirst: true, midSleepMs: 4000 }, applySpec2, { fx: fxG3 })));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const realClient = require(path.join(repoRoot, 'config', 'ContextActiveApplyLockClientV2.cjs')).createCliApplyLockClient({ workspace, leaseSeconds: 60 });
    const sessP = builders.makeSessionDouble(sessG1.events, sessG1.surface.nodes);
    await runtime.supersedeGenerationV2(Object.assign(bind2(realClient), {
      generation: 3, observedRevisionDigest: fxG3moved.token.revisionDigest,
      observedSafePointBoundarySeq: fxG3moved.safe.boundarySeq,
      payloadText: shadow.checkpointPayloadTextOf(fxG3.sealed), session: sessP,
    }));
    const resStale = parseResult(await staleRun);
    check(resStale.ok === false && /superseded|cannot-supersede/.test(resStale.error || ''), 'stale pre-supersession handle refuses via the under-lock re-read (got ' + JSON.stringify(resStale).slice(0, 200) + ')');
    check(fs.readFileSync(sessionFile2, 'utf8') === bytesBefore, 'stale-handle race appends zero events (no resurrection)');
    check(!fs.existsSync(lock2Path), 'no lock residue after the supersession race');

  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log('A11 xproc: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('A11 XPROC HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
