'use strict';
/**
 * ContextActiveApplyV2XProc.Tests.cjs - H1 two-process serialization proof.
 *
 * Two (and more) INDEPENDENT OS processes contend for one CCv2 active apply
 * through the REAL production lock authority (ContextLifecycleCli.ps1
 * acquire/renew/release-apply-lock against a real ledger workspace with a
 * real task binding). No in-process doubles stand in for exclusion: process
 * B cannot pass validate->mutate while process A holds the lock, an
 * identical retry recovers without new mutation, and a conflicting
 * operation fails closed. The session itself is file-backed (the durable
 * store seam); the lock file, checkpoint dir, and operation dir are shared
 * across processes.
 *
 * ENVIRONMENTAL skip (never faked): pwsh or git absent.
 */
const { execFileSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
const WORKER = path.join(__dirname, 'ContextActiveApplyV2XProc.Worker.cjs');
const builders = require(path.join(__dirname, 'ContextActiveApplyV2.Tests.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextShadowV2.cjs'));
const snapshotV2 = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const gate = require(path.join(repoRoot, 'config', 'ContextCheckpointabilityV2.cjs'));
const pressure = require(path.join(repoRoot, 'config', 'ContextPressureV2.cjs'));
const retention = require(path.join(repoRoot, 'config', 'ContextRetentionV2.cjs'));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-xproc-'));
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

// Shadow-ready single-segment fixture bound to the LEDGER task identity
// (the lock authority scopes by ledger task; the operation binding follows
// the same ids). requirementText varies the checkpoint -> operation id.
function buildLedgerFixture(taskId, taskInstanceId, sessionId, requirementText) {
  const evCounter = { n: 0 };
  const evUser = (text) => { evCounter.n += 1; return { type: 'user/message', data: { id: 'msg-xproc-' + evCounter.n, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }; };
  const evAssistant = (text) => { evCounter.n += 1; return { type: 'assistant/message', data: { turn: 't1', step: 's1', message: { id: 'msg-xproc-' + evCounter.n, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }; };
  const events = [evUser('u0'), evAssistant('a1'), evUser('u2'), evAssistant('a3'), evUser('u4'), evAssistant('a5'), evUser('u6-current')].map((e, i) => Object.assign({}, e, { seq: i }));
  const surface = events.map((e) => e.seq);
  const U = builders.U;
  const units = [U('u-hist-1', 0, 1, { requiresContinuation: true, a07Coverage: 'represented', tokenCost: { tokens: 3000, method: 'provider-tokenizer', exact: true } }), U('u-derived', 2, 3, { derivedNonAuthoritative: true, tokenCost: { tokens: 2500, method: 'provider-tokenizer', exact: true } }), U('u-req-new', 4, 5, { requiresContinuation: true, tokenCost: { tokens: 8000, method: 'provider-tokenizer', exact: true } }), U('u-user', 6, 6, { requiresContinuation: true, isCurrentUserTurn: true, tokenCost: { tokens: 1000, method: 'provider-tokenizer', exact: true } })];
  const ts0 = builders.draftTaskState(3, 3, { taskId, taskInstanceId, sessionId, workspaceId: '/tmp/nexus-a10h-xproc' });
  ts0.requirements = [{ id: 'R1', text: requirementText, status: 'active', evidenceRefs: ['ev-cmd-1'], sourceKind: 'controller' }];
  ts0.evidenceRefs = ts0.evidenceRefs.map((e) => Object.assign({}, e, { taskInstanceId: taskInstanceId }));
  const ts = builders.finalizeTs(ts0);
  const token = snapshotV2.capture(builders.snapInputOf(ts), builders.CREATED);
  const safe = builders.safeDecisionFor(ts);
  const g = gate.evaluateCheckpointabilityV2({ schemaVersion: 1, taskState: ts, safePointDecision: safe, snapshotToken: token });
  const p = builders.pressureFor(token, 100000);
  const plan = retention.planRetentionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, boundaryContext: builders.boundaryCtx(events, ts.taskRevision), contextUnits: units, protocolSpans: [] });
  const result = shadow.evaluateShadowCompactionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, snapshotToken: token, snapshotCurrentState: builders.snapInputOf(ts), safePointDecision: safe, checkpointabilityDecision: g, pressureDecision: p, retentionPlan: plan, taskState: ts, contextUnits: units, sessionEvents: events, surfaceNodes: surface, protocolSpans: [], createdAtUtc: builders.CREATED, sealedAtUtc: builders.CREATED });
  assert.equal(result.verdict, 'shadow-ready', 'xproc fixture must be shadow-ready');
  const sealed = shadow.buildShadowCheckpointV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, parentCheckpointId: null, safePointBoundarySeq: safe.boundarySeq, snapshotToken: token, taskState: ts, createdAtUtc: builders.CREATED, sealedAtUtc: builders.CREATED });
  const artifact = shadow.buildCompactedProjectionV2({ schemaVersion: 1, taskId: ts.taskId, taskInstanceId: ts.taskInstanceId, sessionId: ts.sessionId, generation: ts.generation, sealedCheckpoint: sealed.sealedCheckpoint, retentionPlan: plan, snapshotToken: token, taskState: ts, contextUnits: units, sourceEvents: events, surfaceNodes: surface, protocolSpans: [] });
  return { ts, token, safe, g, p, plan, units, events, surface, result, sealed: sealed.sealedCheckpoint, artifact };
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
async function waitForFile(p, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(p);
}

async function main() {
  if (!pwshAvailable()) {
    console.log('SKIP: pwsh is absent; the H1 two-process proof is PENDING (never faked).');
    process.exit(0);
  }
  try { execFileSync('git', ['--version']); }
  catch {
    console.log('SKIP: git is absent; the H1 two-process proof is PENDING (never faked).');
    process.exit(0);
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-ws-'));
  try {
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'a10h@example.invalid']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'a10h']);
    fs.writeFileSync(path.join(workspace, '.a10hbaseline'), 'baseline');
    execFileSync('git', ['-C', workspace, 'add', '.a10hbaseline']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'baseline']);
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'a10h xproc fixture', reviewRequested: false, engine: 'dual' });
    assert.ok(task && task.taskId && task.taskInstanceId, 'ledger task exists for the lock scope');
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-a10h-xproc';
    const lockPath = path.join(workspace, '.ai-harness', 'runs', taskId, 'context-compaction-apply.lock');

    section('H1 two-process exclusion (real lock authority)');
    const fx1 = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'Apply exactly the shadow prediction.');
    const ckptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-ckpt-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-op-'));
    const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-sess-')), 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({ events: fx1.events, surface: fx1.surface }));
    const writeSpec = (fx, sleepMs) => {
      const f = path.join(os.tmpdir(), 'a10h-spec-' + process.pid + '-' + Math.floor(Math.random() * 1000000) + '.json');
      fs.writeFileSync(f, JSON.stringify({ fx, ledgerWorkspace: workspace, sessionFile, checkpointDir: ckptDir, operationDir: opDir, flushSleepMs: sleepMs, leaseSeconds: 60 }));
      return f;
    };
    const specA = writeSpec(fx1, 4000);
    const promiseA = runWorker(specA);
    const lockSeen = await waitForFile(lockPath, 60000);
    check(lockSeen, 'process A acquires the real cross-process lock (lock file appears)');
    const resB = parseResult(await runWorker(writeSpec(fx1, 0)));
    check(resB.status === 'refused' && resB.codes.indexOf('active-serialization-conflict') !== -1, 'process B refused while A holds (got ' + resB.status + ' ' + JSON.stringify(resB.codes) + ')');
    check(resB.mutated === false && resB.intentDurable === false, 'refused contender mutates nothing and proves no intent');
    const resA = parseResult(await promiseA);
    check(resA.status === 'committed', 'process A commits under the lock (got ' + resA.status + ' ' + JSON.stringify(resA.codes) + ')');
    check(resA.intentDurable === true && resA.applicationDurable === true, 'A proves both durability legs');
    const afterA = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    check(afterA.events.length === fx1.events.length + 1, 'exactly one replacement node across processes');
    check(resA.payloadCount === 1, 'zero duplicate payloads across processes');

    section('H1 identical operation recovers across processes');
    const mtimeBefore = fs.statSync(sessionFile).mtimeMs;
    const bytesBefore = fs.readFileSync(sessionFile, 'utf8');
    const resC = parseResult(await runWorker(writeSpec(fx1, 0)));
    check(resC.status === 'recovered', 'post-commit process recovers (got ' + resC.status + ' ' + JSON.stringify(resC.codes) + ')');
    check(resC.mutated === false && resC.operationId === resA.operationId, 'recovery binds the same operation with no new mutation');
    check(fs.readFileSync(sessionFile, 'utf8') === bytesBefore, 'recovery writes nothing new (durable bytes identical; flush only re-confirms)');
    check(resC.eventsLen === resA.eventsLen, 'recovery appends zero events across processes');

    section('H1 conflicting operation fails closed across processes');
    const fx2 = buildLedgerFixture(taskId, taskInstanceId, sessionId, 'A DIFFERENT requirement text for O2.');
    check(fx2.artifact.operationId !== fx1.artifact.operationId, 'O2 is a genuinely incompatible operation');
    const freshSessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-sess-')), 'session.json');
    fs.writeFileSync(freshSessionFile, JSON.stringify({ events: fx2.events, surface: fx2.surface }));
    // O2 carries its own checkpoint intent path (separate dir) so the
    // proof isolates the OPERATION-conflict leg against the shared O1
    // operation file (same generation, incompatible identity).
    const ckptDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'a10h-ckpt-'));
    const specD = path.join(os.tmpdir(), 'a10h-spec-' + process.pid + '-o2.json');
    fs.writeFileSync(specD, JSON.stringify({ fx: fx2, ledgerWorkspace: workspace, sessionFile: freshSessionFile, checkpointDir: ckptDir2, operationDir: opDir, flushSleepMs: 0, leaseSeconds: 60 }));
    const resD = parseResult(await runWorker(specD));
    check(resD.status === 'failed' && resD.codes.indexOf('active-operation-conflict') !== -1, 'incompatible O2 fails closed (got ' + resD.status + ' ' + JSON.stringify(resD.codes) + ')');
    check(resD.mutated === false, 'conflicting attempt mutates nothing');
    const freshAfter = JSON.parse(fs.readFileSync(freshSessionFile, 'utf8'));
    check(freshAfter.events.length === fx2.events.length, 'no competing projection lands');
    check(!fs.existsSync(lockPath), 'no lock residue after the matrix');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log('A10H xproc: passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('A10H XPROC HARNESS FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
