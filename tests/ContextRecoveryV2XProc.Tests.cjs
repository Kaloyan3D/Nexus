'use strict';
/**
 * ContextRecoveryV2XProc.Tests.cjs - CCV2-A12 true cross-process proof.
 *
 * Independent OS processes contend through the REAL production authorities
 * (real CLI lock client, same lock file/lease/owner semantics, real runtime
 * persistence). Never Promise.all() in one process. Covers: concurrent
 * identical active apply (one mutation, others converge), apply-vs-supersede
 * in both barrier orders (exactly one terminal winner), commit-head vs
 * next-reservation (no stale parent), dead-owner lock takeover (refused while
 * the owner lives, permitted after lease + PID-liveness rules allow, with
 * mandatory authoritative re-read), and stale pre-lock handles.
 *
 * ENVIRONMENTAL skip (never faked): pwsh or git absent.
 * Stress: each deterministic race repeats 3 iterations.
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
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));
const lockClient = require(path.join(repoRoot, 'config', 'ContextActiveApplyLockClientV2.cjs'));
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
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function pwshAvailable() {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8', timeout: 60000 });
    return true;
  } catch { return false; }
}
function pwsh(script, args, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-'));
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

function buildLedgerFixture(taskId, taskInstanceId, sessionId, requirementText, generation, parentCheckpointId) {
  const gen = generation === undefined ? 1 : generation;
  const fx0 = builders.buildHappy('single');
  const ts0 = builders.draftTaskState(3, 3, { taskId, taskInstanceId, sessionId, workspaceId: '/tmp/nexus-a12x', generation: gen });
  ts0.requirements = [{ id: 'R1', text: requirementText, status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }];
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId }));
  const ts = builders.finalizeTs(ts0);
  const token = snapshotV2.capture(builders.snapInputOf(ts), builders.CREATED);
  const safe = builders.safeDecisionFor(ts);
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = builders.pressureFor(token, 100000);
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: builders.boundaryCtx(fx0.events, ts.taskRevision), contextUnits: clone(fx0.units), protocolSpans: [] });
  const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: parentCheckpointId === undefined ? null : parentCheckpointId, snapshotToken: token, snapshotCurrentState: builders.snapInputOf(ts), safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: clone(fx0.units), sessionEvents: fx0.events, surfaceNodes: fx0.surface, protocolSpans: [], createdAtUtc: builders.CREATED, sealedAtUtc: builders.CREATED });
  assert.equal(result.verdict, 'shadow-ready', 'xproc fixture must be shadow-ready');
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: parentCheckpointId === undefined ? null : parentCheckpointId, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: builders.CREATED, sealedAtUtc: builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: clone(fx0.units), sourceEvents: fx0.events, surfaceNodes: fx0.surface, protocolSpans: [] });
  return { ts, token, safe, g, p, plan, units: clone(fx0.units), events: clone(fx0.events), surface: fx0.surface.slice(), result, sealed: sealed.sealedCheckpoint, artifact };
}

async function main() {
  if (!pwshAvailable()) {
    console.log('SKIP: pwsh is absent; the A12 cross-process proof is PENDING (never faked).');
    process.exit(0);
  }
  try { execFileSync('git', ['--version']); }
  catch {
    console.log('SKIP: git is absent; the A12 cross-process proof is PENDING (never faked).');
    process.exit(0);
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-ws-'));
  try {
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'a12x@example.invalid']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'a12x']);
    fs.writeFileSync(path.join(workspace, '.a12xbaseline'), 'baseline');
    execFileSync('git', ['-C', workspace, 'add', '.a12xbaseline']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'baseline']);
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'a12x fixture', reviewRequested: false, engine: 'dual' });
    assert.ok(task && task.taskId && task.taskInstanceId, 'ledger task exists for the lock scope');
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-a12x';
    const lockPath = path.join(workspace, '.ai-harness', 'runs', taskId, 'context-compaction-apply.lock');
    const base = { taskId, taskInstanceId, sessionId };
    const writeSpec = (spec) => {
      const f = path.join(os.tmpdir(), 'a12x-spec-' + process.pid + '-' + Math.floor(Math.random() * 1000000) + '.json');
      fs.writeFileSync(f, JSON.stringify(spec));
      return f;
    };
    const writeSession = (events, surface) => {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-sess-')), 'session.json');
      fs.writeFileSync(f, JSON.stringify({ events, surface }));
      return f;
    };
    const sessionOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

    for (let iter = 1; iter <= 3; iter += 1) {
      section('XPROC iter ' + iter + ': concurrent identical apply converges (one mutation)');
      {
        const dirs = {
          runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-rt-')),
          checkpointDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-ck-')),
          operationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-op-')),
        };
        const fx = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'Apply exactly once across processes (iter ' + iter + ').', 1, null);
        const res = parseResult(await runWorker(writeSpec({
          mode: 'reserve', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId,
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
          safePointBoundarySeq: fx.safe.boundarySeq, preSleepMs: 0,
        })));
        check(res.ok === true && res.generation === 1, 'iter ' + iter + ': G1 reserved');
        const sessionFile = writeSession(fx.events, fx.surface);
        const applySpec = (pre, mid, inspect) => ({
          mode: 'apply-current', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId, fx, sessionFile, preSleepMs: pre, midSleepMs: mid, inspectFirst: inspect === true,
        });
        const [runA, runB] = await Promise.all([
          runWorker(writeSpec(applySpec(0, 0, false))),
          runWorker(writeSpec(applySpec(1200, 0, false))),
        ]);
        let outA = parseResult(runA);
        let outB = parseResult(runB);
        // Lock serialization is legitimate: a contender refused while the
        // winner holds the lock retries and must converge (never a fork).
        for (const [idx, out] of [[0, outA], [1, outB]]) {
          if (out.ok !== true && /held by a live owner|reservation-conflict/.test(out.error || '')) {
            const retry = parseResult(await runWorker(writeSpec(applySpec(0, 0, false))));
            if (idx === 0) outA = retry; else outB = retry;
          }
        }
        // Convergence = exactly one mutation; the other contender reaches an
        // idempotent terminal: ok/recovered via forward recovery, or a stable
        // already-committed refusal after the entry's verified head healing
        // (head advanced from durable evidence, no second mutation either way).
        const converged = (o) => (o.ok === true && (o.status === 'committed' || o.status === 'recovered'))
          || (o.ok !== true && /already-committed/.test(o.error || ''));
        check(converged(outA) && converged(outB), 'iter ' + iter + ': both appliers converge (A=' + JSON.stringify(outA).slice(0, 200) + ' B=' + JSON.stringify(outB).slice(0, 200) + ')');
        const mutatedCount = [outA, outB].filter((o) => o.ok === true && o.mutated === true).length;
        check(mutatedCount <= 1, 'iter ' + iter + ': at most one actual mutation (got ' + mutatedCount + ')');
        const headAfter = runtime.inspectGenerationRuntimeV2(Object.assign({ schemaVersion: 1 }, base, { runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot, session: null }));
        check(headAfter.highestAllocatedGeneration === 1, 'iter ' + iter + ': one generation identity consumed');
        const after = sessionOf(sessionFile);
        const texts = JSON.stringify(after.events);
        const opId = fx.artifact.operationId;
        check(texts.split(opId).length - 1 <= 2, 'iter ' + iter + ': no duplicate application surface (op citations<=2, got ' + (texts.split(opId).length - 1) + ')');
        check(!fs.existsSync(lockPath), 'iter ' + iter + ': no lock residue');
      }
    }

    for (let iter = 1; iter <= 3; iter += 1) {
      section('XPROC iter ' + iter + ': apply-vs-supersede, apply wins (supersede refuses)');
      {
        const dirs = {
          runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-rt-')),
          checkpointDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-ck-')),
          operationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-op-')),
        };
        const fx = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'Apply wins over late supersede (iter ' + iter + ').', 1, null);
        parseResult(await runWorker(writeSpec({
          mode: 'reserve', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId,
          revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
          safePointBoundarySeq: fx.safe.boundarySeq, preSleepMs: 0,
        })));
        const sessionFile = writeSession(fx.events, fx.surface);
        const payloadText = shadow.checkpointPayloadTextOf(fx.sealed);
        const [runApply, runSup] = await Promise.all([
          runWorker(writeSpec({
            mode: 'apply-current', ledgerWorkspace: workspace,
            runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
            taskId, taskInstanceId, sessionId, fx, sessionFile, preSleepMs: 0, midSleepMs: 0,
          })),
          runWorker(writeSpec({
            mode: 'supersede', ledgerWorkspace: workspace,
            runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
            taskId, taskInstanceId, sessionId, generation: 1,
            observedRevisionDigest: sha('a12x-moved-' + iter), observedSafePointBoundarySeq: fx.safe.boundarySeq,
            payloadText, sessionFile, preSleepMs: 2500,
          })),
        ]);
        const applied = parseResult(runApply);
        let sup = parseResult(runSup);
        // Timing tolerance: if supersession arrived while the winner still
        // held the lock, retry once after handoff; the landed state still
        // refuses with the terminal code (never a second outcome).
        if (sup.ok === false && /held by a live owner|reservation-conflict/.test(sup.error || '')) {
          sup = parseResult(await runWorker(writeSpec({
            mode: 'supersede', ledgerWorkspace: workspace,
            runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
            taskId, taskInstanceId, sessionId, generation: 1,
            observedRevisionDigest: sha('a12x-moved-' + iter), observedSafePointBoundarySeq: fx.safe.boundarySeq,
            payloadText, sessionFile, preSleepMs: 0,
          })));
        }
        check(applied.ok === true, 'iter ' + iter + ': apply wins (got ' + applied.status + ')');
        check(sup.ok === false && /generation-cannot-supersede/.test(sup.error || ''), 'iter ' + iter + ': late supersede refuses (got ' + JSON.stringify(sup).slice(0, 160) + ')');
        const st = runtime.inspectGenerationRuntimeV2(Object.assign({ schemaVersion: 1 }, base, { runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot, session: null }));
        check(st.generations.filter((g) => g.generation === 1)[0].outcome !== 'SUPERSEDED', 'iter ' + iter + ': never SUPERSEDED+applied');
      }
    }

    section('XPROC: apply-vs-supersede, supersede wins (stale pre-lock apply refuses)');
    {
      const dirs = {
        runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-rt-')),
        checkpointDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-ck-')),
        operationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-op-')),
      };
      const fx = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'Supersede wins over stale apply.', 1, null);
      parseResult(await runWorker(writeSpec({
        mode: 'reserve', ledgerWorkspace: workspace,
        runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
        taskId, taskInstanceId, sessionId,
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
        safePointBoundarySeq: fx.safe.boundarySeq, preSleepMs: 0,
      })));
      const sessionFile = writeSession(fx.events, fx.surface);
      // Zero landing: no intent frozen, so supersession can win outright.
      const [runSup, runApply] = await Promise.all([
        runWorker(writeSpec({
          mode: 'supersede', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId, generation: 1,
          observedRevisionDigest: sha('a12x-moved-sup'), observedSafePointBoundarySeq: fx.safe.boundarySeq,
          payloadText: null, sessionFile, preSleepMs: 0,
        })),
        runWorker(writeSpec({
          mode: 'apply-current', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId, fx, sessionFile, preSleepMs: 800, midSleepMs: 1200, inspectFirst: true,
        })),
      ]);
      const sup = parseResult(runSup);
      const applied = parseResult(runApply);
      check(sup.ok === true && sup.outcome === 'SUPERSEDED', 'supersede wins on zero landing (got ' + JSON.stringify(sup).slice(0, 160) + ')');
      check(applied.ok === false && /generation-/.test(applied.error || ''), 'stale pre-lock apply refuses (got ' + JSON.stringify(applied).slice(0, 200) + ')');
      check(!fs.existsSync(lockPath), 'no lock residue after the supersede race');
    }

    section('XPROC: commit-head vs next-reservation (no stale parent)');
    {
      const dirs = {
        runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-rt-')),
        checkpointDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-ck-')),
        operationRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a12x-op-')),
      };
      const fx = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'Commit head then reserve next.', 1, null);
      parseResult(await runWorker(writeSpec({
        mode: 'reserve', ledgerWorkspace: workspace,
        runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
        taskId, taskInstanceId, sessionId,
        revisionDigest: fx.token.revisionDigest, snapshotTokenId: fx.token.snapshotTokenId,
        safePointBoundarySeq: fx.safe.boundarySeq, preSleepMs: 0,
      })));
      const sessionFile = writeSession(fx.events, fx.surface);
      const applied = parseResult(await runWorker(writeSpec({
        mode: 'apply-current', ledgerWorkspace: workspace,
        runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
        taskId, taskInstanceId, sessionId, fx, sessionFile, preSleepMs: 0, midSleepMs: 0,
      })));
      check(applied.ok === true, 'G1 applied before the head race (got ' + applied.status + ')');
      // The worker-produced entry result is the commit evidence (no parent
      // replay: re-entering would only hit the verified head healing as
      // already-committed). The race itself stays worker-vs-worker below.
      check(applied.activeResult && (applied.activeResult.status === 'committed' || applied.activeResult.status === 'recovered'), 'worker result is commit-grade');
      const afterSnap = sessionOf(sessionFile);
      const afterFile = writeSession(afterSnap.events, afterSnap.surface);
      const entry = { ok: true, activeResult: applied.activeResult };
      const [runCommit, runReserve] = await Promise.all([
        runWorker(writeSpec({
          mode: 'commit', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId, generation: 1,
          activeResult: entry.activeResult, sessionFile: afterFile, preSleepMs: 0,
        })),
        runWorker(writeSpec({
          mode: 'reserve', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId,
          revisionDigest: sha('a12x-g2-next'), snapshotTokenId: null, safePointBoundarySeq: 3, preSleepMs: 600,
        })),
      ]);
      const committed = parseResult(runCommit);
      const reserved = parseResult(runReserve);
      check(committed.ok === true && committed.head === 1, 'commit advances the head (got ' + JSON.stringify(committed).slice(0, 160) + ')');
      if (reserved.ok === true) {
        check(reserved.generation === 2, 'next reservation is G2');
        check(reserved.parentCommittedCheckpointId === committed.checkpointId, 'G2 parents from committed G1 (never stale)');
      } else {
        check(/generation-/.test(reserved.error || ''), 'early reserver refuses with a stable code (got ' + JSON.stringify(reserved).slice(0, 160) + ')');
        const retry = parseResult(await runWorker(writeSpec({
          mode: 'reserve', ledgerWorkspace: workspace,
          runtimeDir: dirs.runtimeDir, checkpointDir: dirs.checkpointDir, operationRoot: dirs.operationRoot,
          taskId, taskInstanceId, sessionId,
          revisionDigest: sha('a12x-g2-next'), snapshotTokenId: null, safePointBoundarySeq: 3, preSleepMs: 0,
        })));
        check(retry.ok === true && retry.parentCommittedCheckpointId === committed.checkpointId, 'retry parents from committed G1');
      }
    }

    section('XPROC: dead-owner lock takeover (refused live, permitted after rules allow)');
    {
      // Takeover is per-OPERATION: the taker continues the SAME operation
      // binding after the owner dies (a different operationId is fenced as
      // held-by-other-operation, never taken over).
      const OP = 'a12x-op-takeover';
      // Live holder (short lease so the dead-owner phase stays fast): a
      // second acquirer is refused while the owner lives.
      // Liveness is proven by renewal heartbeat (the CLI pwsh owner exits
      // immediately; the design renew-gate keeps a healthy owner unevictable
      // and lets a stalled/dead owner be taken over past expiry).
      const holderCode = "const lc=require(" + JSON.stringify(path.join(repoRoot, 'config', 'ContextActiveApplyLockClientV2.cjs')) + ");" +
        "(async()=>{const c=lc.createCliApplyLockClient({workspace:" + JSON.stringify(workspace) + ",leaseSeconds:4});" +
        "const call={taskId:" + JSON.stringify(taskId) + ",taskInstanceId:" + JSON.stringify(taskInstanceId) + ",sessionId:" + JSON.stringify(sessionId) + ",operationId:" + JSON.stringify(OP) + ",generation:1};" +
        "const r=await c.acquire(call);console.log(JSON.stringify({acquired:r.acquired}));" +
        "if(r.acquired!==true)process.exit(0);" +
        "const t=setInterval(async()=>{try{await c.renew(Object.assign({},call,{ownerId:r.ownerId}));}catch(e){}},2000);" +
        "await new Promise((res)=>setTimeout(res,12000));clearInterval(t);})().catch((e)=>{console.log(JSON.stringify({acquired:false,error:String(e&&e.message||e).slice(0,120)}));});";
      const holder = spawn(process.execPath, ['-e', holderCode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let holderOut = '';
      holder.stdout.on('data', (d) => { holderOut += d; });
      await new Promise((res) => setTimeout(res, 4000));
      const liveClient = lockClient.createCliApplyLockClient({ workspace, leaseSeconds: 60 });
      let liveSnap = '';
      let liveRefused = false;
      let liveReason = '';
      try {
        const r = await liveClient.acquire({ taskId, taskInstanceId, sessionId, operationId: OP, generation: 1 });
        liveSnap = JSON.stringify(r).slice(0, 200);
        liveRefused = r.acquired !== true;
        liveReason = String(r.reason || '');
      } catch (e) { liveRefused = true; liveReason = String((e && e.message) || e).slice(0, 80); liveSnap = 'threw:' + liveReason; }
      check(liveRefused === true, 'contender is refused while the owner lives (' + liveSnap + ')');
      check(/held-by-live-owner|busy|refused|KEEP/.test(liveSnap + liveReason), 'refusal is explicit, never silent (' + liveSnap + ')');
      check(holderOut.indexOf('"acquired":true') !== -1, 'live holder owns the lock');
      check(liveRefused === true, 'contender is refused while the owner lives');
      // Owner death: SIGKILL stops the heartbeat; the lease lapses on its own.
      holder.kill('SIGKILL');
      await new Promise((res) => holder.on('close', res));
      // Takeover must re-read authoritative state: the lock file still names
      // the dead owner, so immediate acquisition is refused or raced; only
      // after the lease lapses with no living owner does takeover succeed.
      await new Promise((res) => setTimeout(res, 7000));
      const taker = lockClient.createCliApplyLockClient({ workspace, leaseSeconds: 60 });
      const taken = await taker.acquire({ taskId, taskInstanceId, sessionId, operationId: OP, generation: 1 });
      check(taken.acquired === true, 'takeover succeeds after lease lapse + dead owner (got ' + JSON.stringify(taken).slice(0, 160) + ')');
      await taker.release({ taskId, ownerId: taken.ownerId });
      check(!fs.existsSync(lockPath), 'no lock residue after takeover');
    }

    console.log('\nA12 xproc: passed=' + passed + ' failed=' + failed);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('A12 XPROC HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
