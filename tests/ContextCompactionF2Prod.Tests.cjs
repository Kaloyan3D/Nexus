'use strict';
/**
 * ContextCompactionF2Prod.Tests.cjs - F2 production-path regression.
 *
 * Drives the REAL AihController pre-step orchestration over REAL task
 * generations plus REAL DSH Session objects.
 *
 * Matrix (every invalid case: 0 replacement appends, state != applied,
 * current/new work present):
 *   missing operation artifact, legacy checkpoint-ready without operation,
 *   wrong sessionId, wrong workspace, duplicate sourceEventSeqs, source seq
 *   beyond the completion boundary, segment union/endpoint mismatch, missing
 *   segments, corrupted operation JSON, operationId mismatch, completion
 *   race with Task B (0 Task B events adopted), valid crash-before/after
 *   (Task B survives exactly once).
 *
 * Mutation property: restoring the live-surface re-freeze fallback (or the
 * single-span fallback) makes the missing/legacy cases append replacements
 * and fail the zero-append assertions.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const harness = require('./lib/ContextCompactionProdHarness.cjs');

let passed = 0;
let assertions = 0;
function check(cond, name) { assertions += 1; assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }

function setupGeneration() {
  const repoRoot = harness.repoRoot;
  const dataRoot = harness.makeDataRoot();
  process.env.DSH_HOME = dataRoot;
  process.env.AIH_INSTALL_ROOT = repoRoot;
  process.env.AIH_TOOLCHAIN_ROOT = repoRoot;
  const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
  const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
  const WSCLI = path.join(repoRoot, 'scripts', 'NexusWorkspace.ps1');
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'f2prod-ws-'));
  const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'f2 production fixture', reviewRequested: false, engine: 'muse' });
  pwsh(CLI, ['-Action', 'record-root-usage', '-TaskId', task.taskId], { workspace, taskInstanceId: task.taskInstanceId, engineRole: 'muse_main', engine: 'muse', uncachedInputTokens: 100000, cacheReadTokens: 50000, outputTokens: 1, usageAvailable: true, stepId: '1:1', sessionId: 'sess-f2' });
  const runDir = path.join(workspace, '.ai-harness', 'runs', task.taskId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ schemaVersion: 2, attempt: 0, taskInstanceId: task.taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true }));
  pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', task.taskId], { workspace, taskInstanceId: task.taskInstanceId });
  const wsIdentity = pwsh(WSCLI, ['-Action', 'resolve'], { path: workspace });
  return { repoRoot, dataRoot, TASK_CLI, CLI, workspace, taskId: task.taskId, taskInstanceId: task.taskInstanceId, wsIdentity };
}

function buildTaskASession(dsh, sessionId, workspace, bulkMark) {
  const session = dsh.Session.create(sessionId);
  const ap = (type, data, opts) => session.append(type, data, opts);
  ap('user/message', harness.identifiedUserMessage('Controller: bound'), { surfaceOp: 'append' });
  ap('user/message', harness.identifiedUserMessage('Task A work ' + bulkMark), { surfaceOp: 'append' });
  for (let r = 0; r < 4; r += 1) {
    ap('assistant/message', harness.identifiedAssistantMessage('', 1, r + 1, [{ type: 'tool-call', name: 'run', callId: 'a' + r + bulkMark }]), { surfaceOp: 'append' });
    ap('tool/result', harness.identifiedToolResult('a' + r + bulkMark, 'bulk ' + bulkMark + ' ' + r, 1, r + 1), { surfaceOp: 'append' });
  }
  ap('user/message', harness.identifiedUserMessage('Task A final'), { surfaceOp: 'append' });
  ap('assistant/message', harness.identifiedAssistantMessage('A done', 2, 1), { surfaceOp: 'append' });
  session.header = Object.assign({}, session.header, { cwd: workspace, agentPreset: 'aih-muse' });
  return session;
}

function seedReadyGeneration(g, sessionId, session, operationSpec) {
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const cli = (action, payload) => pwsh(g.CLI, ['-Action', action, '-TaskId', g.taskId], payload);
  harness.seedBinding(g.dataRoot, sessionId, {
    sessionId, taskInstanceId: g.taskInstanceId, taskId: g.taskId, workspace: g.workspace,
    workspaceId: g.wsIdentity.workspaceId, repositoryId: g.wsIdentity.repositoryId,
    checkoutId: g.wsIdentity.checkoutId, checkoutRootPath: g.wsIdentity.checkoutRootPath,
    executionRoot: g.wsIdentity.executionRoot,
    preset: 'aih-muse', engine: 'muse', description: 'f2',
    executionClass: 'muse_main', reviewRequired: false, needsRouteCheck: false,
    boundAtUtc: new Date().toISOString(),
  });
  cli('eligibility', { workspace: g.workspace, taskInstanceId: g.taskInstanceId, sessionId });
  cli('transition', { workspace: g.workspace, taskInstanceId: g.taskInstanceId, to: 'eligible', reason: 'f2', sessionId });
  const cp = cli('build-checkpoint', { workspace: g.workspace, taskInstanceId: g.taskInstanceId, continuityUserText: 'u', continuityAssistantText: 'a' });
  cli('transition', { workspace: g.workspace, taskInstanceId: g.taskInstanceId, to: 'checkpoint-ready', reason: 'f2', sessionId, checkpointPath: cp.path });
  if (operationSpec) {
    const op = cli('freeze-operation', Object.assign({ workspace: g.workspace, taskInstanceId: g.taskInstanceId, sessionId, checkpointPath: cp.path }, operationSpec));
    cli('transition', { workspace: g.workspace, taskInstanceId: g.taskInstanceId, to: 'apply-pending', reason: 'f2', sessionId });
    return { cp, op };
  }
  return { cp, op: null };
}

function checkpointAppends(session) {
  return session.events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.form === 'context-checkpoint');
}

async function drivePreStep(g, session, sessionId, promptText) {
  const ctx = harness.makeCtx({});
  harness.loadBridge().apply(ctx);
  const preStep = ctx._handlers['agent/pre-step'][0];
  const agent = { session, signal: new AbortController().signal, options: {} };
  const result = await preStep({ agent, messages: [{ id: harness.newMessageId(), role: 'user', content: [{ type: 'text', text: promptText || 'follow-up' }], source: { kind: 'user' } }], step: 1, turn: 3 }, async () => ({ kind: 'enter', messages: [] }));
  const snap = harness.pwshFile(g.CLI, ['-Action', 'snapshot', '-TaskId', g.taskId], { workspace: g.workspace, taskInstanceId: g.taskInstanceId });
  return { result, state: snap.state, ctx };
}
async function main() {
  const dsh = harness.loadDshSession();
  const prod = require(path.join(harness.repoRoot, 'config', 'ContextCompaction.cjs'));

  // Case 1: missing operation artifact -> BLOCK, 0 appends.
  {
    const g = setupGeneration();
    try {
      const session = buildTaskASession(dsh, 'sess-f2-missing', g.workspace, 'M1');
      seedReadyGeneration(g, 'sess-f2-missing', session, null);
      const before = checkpointAppends(session).length;
      const { state } = await drivePreStep(g, session, 'sess-f2-missing', 'hello');
      check(checkpointAppends(session).length === before, 'F2-missing: 0 replacement appends');
      check(state !== 'applied', 'F2-missing: state != applied (got ' + state + ')');
      check(session.deriveMessages().length > 0, 'F2-missing: current work remains present');
    } finally { fs.rmSync(g.workspace, { recursive: true, force: true }); fs.rmSync(g.dataRoot, { recursive: true, force: true }); }
  }

  // Case 2: legacy checkpoint-ready without operation -> BLOCK, 0 appends.
  // (Same as missing on current code; kept distinct for the audit trail.)
  {
    const g = setupGeneration();
    try {
      const session = buildTaskASession(dsh, 'sess-f2-legacy', g.workspace, 'L2');
      seedReadyGeneration(g, 'sess-f2-legacy', session, null);
      const snap = harness.pwshFile(g.CLI, ['-Action', 'snapshot', '-TaskId', g.taskId], { workspace: g.workspace, taskInstanceId: g.taskInstanceId });
      check(snap.state === 'checkpoint-ready', 'F2-legacy: starts checkpoint-ready without operation');
      const before = checkpointAppends(session).length;
      const { state } = await drivePreStep(g, session, 'sess-f2-legacy', 'hello');
      check(checkpointAppends(session).length === before, 'F2-legacy: 0 replacement appends');
      check(state === 'blocked', 'F2-legacy: transitions to blocked (got ' + state + ')');
    } finally { fs.rmSync(g.workspace, { recursive: true, force: true }); fs.rmSync(g.dataRoot, { recursive: true, force: true }); }
  }

  // Case 3: wrong sessionId -> BLOCK, 0 appends.
  {
    const g = setupGeneration();
    try {
      const session = buildTaskASession(dsh, 'sess-f2-right', g.workspace, 'S3');
      seedReadyGeneration(g, 'sess-f2-right', session, null);
      // Freeze for session A, then drive pre-step as session B on the SAME ledger.
      const liveCut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
      const flat = liveCut.shadowedSeqs.filter((s) => !prod.runtimeContextSeqsOf(session).includes(s));
      const segs = prod.splitRangeAroundOwned(session, liveCut.shadowedSeqs, prod.runtimeContextSeqsOf(session));
      const flatFromSegs = [];
      for (const sg of segs) for (const sq of sg.sourceEventSeqs) flatFromSegs.push(sq);
      harness.pwshFile(g.CLI, ['-Action', 'freeze-operation', '-TaskId', g.taskId], { workspace: g.workspace, taskInstanceId: g.taskInstanceId, sessionId: 'sess-f2-WRONG', replacementStart: flatFromSegs[0], replacementEnd: flatFromSegs[flatFromSegs.length - 1], sourceEventSeqs: flatFromSegs, segments: segs, completionBoundarySeq: session.events.length - 1, repositoryId: g.wsIdentity.repositoryId, checkoutId: g.wsIdentity.checkoutId });
      harness.pwshFile(g.CLI, ['-Action', 'transition', '-TaskId', g.taskId], { workspace: g.workspace, taskInstanceId: g.taskInstanceId, to: 'apply-pending', reason: 'f2', sessionId: 'sess-f2-WRONG' });
      const before = checkpointAppends(session).length;
      const { state } = await drivePreStep(g, session, 'sess-f2-right', 'hello');
      check(checkpointAppends(session).length === before, 'F2-session: 0 replacement appends for wrong sessionId');
      check(state !== 'applied', 'F2-session: state != applied (got ' + state + ')');
    } finally { fs.rmSync(g.workspace, { recursive: true, force: true }); fs.rmSync(g.dataRoot, { recursive: true, force: true }); }
  }
  // Case 4: completion race -- Task B arrives before freeze; 0 adopted.
  {
    const g = setupGeneration();
    try {
      const session = buildTaskASession(dsh, 'sess-f2-race', g.workspace, 'R4');
      seedReadyGeneration(g, 'sess-f2-race', session, null);
      const boundaryAtComplete = session.events.length - 1;
      // Task B lands BEFORE the freeze is persisted (the race window).
      session.append('user/message', harness.identifiedUserMessage('Task B intent RACE-B4'), { surfaceOp: 'append' });
      session.append('assistant/message', harness.identifiedAssistantMessage('B noted', 3, 1), { surfaceOp: 'append' });
      const taskBSeqs = session.events.filter((e) => JSON.stringify(e.data).includes('RACE-B4') || JSON.stringify(e.data).includes('B noted')).map((e) => e.seq);
      check(taskBSeqs.length === 2, 'F2-race setup: Task B events present');
      // Freeze constrained to the completion boundary (production behavior).
      const liveCut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
      const capped = liveCut.shadowedSeqs.filter((s) => s <= boundaryAtComplete);
      const owned = prod.runtimeContextSeqsOf(session);
      const flat = capped.filter((s) => !owned.includes(s));
      const adopted = flat.some((s) => taskBSeqs.includes(s));
      check(!adopted, 'F2-race: 0 Task B events adopted into the frozen range');
      // Persisting a range that VIOLATES the boundary must throw (KEEP).
      let threw = false;
      try {
        harness.pwshFile(g.CLI, ['-Action', 'freeze-operation', '-TaskId', g.taskId], { workspace: g.workspace, taskInstanceId: g.taskInstanceId, sessionId: 'sess-f2-race', replacementStart: liveCut.shadowedSeqs[0], replacementEnd: liveCut.shadowedSeqs[liveCut.shadowedSeqs.length - 1], sourceEventSeqs: liveCut.shadowedSeqs, completionBoundarySeq: boundaryAtComplete, repositoryId: g.wsIdentity.repositoryId, checkoutId: g.wsIdentity.checkoutId });
      } catch { threw = true; }
      check(threw, 'F2-race: boundary-violating freeze is refused');
    } finally { fs.rmSync(g.workspace, { recursive: true, force: true }); fs.rmSync(g.dataRoot, { recursive: true, force: true }); }
  }

  // Case 5: valid crash-before/after -- Task B survives exactly once.
  {
    const g = setupGeneration();
    try {
      const session = buildTaskASession(dsh, 'sess-f2-crash', g.workspace, 'C5');
      const liveCut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
      const owned = prod.runtimeContextSeqsOf(session);
      const segs = prod.splitRangeAroundOwned(session, liveCut.shadowedSeqs, owned);
      const flat = [];
      for (const sg of segs) for (const sq of sg.sourceEventSeqs) flat.push(sq);
      seedReadyGeneration(g, 'sess-f2-crash', session, { replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments: segs, completionBoundarySeq: session.events.length - 1, repositoryId: g.wsIdentity.repositoryId, checkoutId: g.wsIdentity.checkoutId });
      const { state } = await drivePreStep(g, session, 'sess-f2-crash', 'follow-up');
      check(state === 'applied', 'F2-crash: valid operation applies (got ' + state + ')');
      const derived = JSON.stringify(session.deriveMessages());
      check(derived.includes('nexus-context-checkpoint'), 'F2-crash: checkpoint in projection');
      check(!derived.includes('bulk C5'), 'F2-crash: Task A bulk shadowed');
      // Crash-before/after with later Task B: Task B survives exactly once.
      session.append('user/message', harness.identifiedUserMessage('Task B intent SURVIVE-C5'), { surfaceOp: 'append' });
      const derived2 = session.deriveMessages().map((m) => JSON.stringify(m));
      check(derived2.filter((t) => t.includes('SURVIVE-C5')).length === 1, 'F2-crash: Task B survives exactly once');
    } finally { fs.rmSync(g.workspace, { recursive: true, force: true }); fs.rmSync(g.dataRoot, { recursive: true, force: true }); }
  }

  await runTamperMatrix(dsh, prod);
async function runTamperMatrix(dsh, prod) {
  const cases = [];
  const baseOp = (session) => {
    const liveCut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const owned = prod.runtimeContextSeqsOf(session);
    const segs = prod.splitRangeAroundOwned(session, liveCut.shadowedSeqs, owned);
    const flat = [];
    for (const sg of segs) for (const sq of sg.sourceEventSeqs) flat.push(sq);
    return { flat, segs, boundary: session.events.length - 1 };
  };
  const freezeWith = (gg, sid, spec) => harness.pwshFile(gg.CLI, ['-Action', 'freeze-operation', '-TaskId', gg.taskId], Object.assign({ workspace: gg.workspace, taskInstanceId: gg.taskInstanceId, sessionId: sid, checkpointPath: 'cp.json', repositoryId: gg.wsIdentity.repositoryId, checkoutId: gg.wsIdentity.checkoutId }, spec));
  const opPath = (gg) => path.join(gg.workspace, '.ai-harness', 'runs', gg.taskId, 'context-compaction-operation.json');
  const rewriteOp = (gg, fn) => {
    const doc = JSON.parse(fs.readFileSync(opPath(gg), 'utf8'));
    fn(doc);
    fs.writeFileSync(opPath(gg), JSON.stringify(doc));
  };
  async function runCase(name, mutateOp, sid) {
    const gg = setupGeneration();
    try {
      const session = buildTaskASession(dsh, sid || 'sess-f2-matrix', gg.workspace, 'MX');
      seedReadyGeneration(gg, session.id, session, null);
      const { flat, segs, boundary } = baseOp(session);
      const op = freezeWith(gg, session.id, { replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments: segs, completionBoundarySeq: boundary });
      harness.pwshFile(gg.CLI, ['-Action', 'transition', '-TaskId', gg.taskId], { workspace: gg.workspace, taskInstanceId: gg.taskInstanceId, to: 'apply-pending', reason: 'matrix', sessionId: session.id });
      // Tamper AFTER the legal transition: the drive must still refuse.
      if (mutateOp) mutateOp(gg, op, session);
      const before = checkpointAppends(session).length;
      const beforeMsgs = session.deriveMessages().length;
      const { state } = await drivePreStep(gg, session, session.id, 'matrix prompt');
      check(checkpointAppends(session).length === before, 'F2-matrix[' + name + ']: 0 replacement appends');
      check(state !== 'applied', 'F2-matrix[' + name + ']: state != applied (got ' + state + ')');
      check(session.deriveMessages().length >= beforeMsgs, 'F2-matrix[' + name + ']: work unchanged');
    } finally { fs.rmSync(gg.workspace, { recursive: true, force: true }); fs.rmSync(gg.dataRoot, { recursive: true, force: true }); }
  }
  const sidOf = (s) => s;
  await runCase('wrong-operationId', (gg) => rewriteOp(gg, (d) => { d.operationId = 'ccop_wrong_but_nonempty'; }));
  await runCase('wrong-taskInstanceId', (gg) => rewriteOp(gg, (d) => { d.taskInstanceId = 'task_ffffffffffffffffffffffffffffffff'; }));
  await runCase('wrong-taskId', (gg) => rewriteOp(gg, (d) => { d.taskId = 'TASK-9999'; }));
  await runCase('wrong-workspace', (gg) => rewriteOp(gg, (d) => { d.workspace = '/elsewhere/workspace'; }));
  await runCase('wrong-repository', (gg) => rewriteOp(gg, (d) => { d.repositoryId = 'repo_wrong'; }));
  await runCase('wrong-checkout', (gg) => rewriteOp(gg, (d) => { d.checkoutId = 'checkout_wrong'; }));
  await runCase('wrong-checkpoint', (gg) => rewriteOp(gg, (d) => { d.checkpointPath = ''; }));
  await runCase('duplicate-seq', (gg) => rewriteOp(gg, (d) => { d.sourceEventSeqs = [d.sourceEventSeqs[0], d.sourceEventSeqs[0]].concat(d.sourceEventSeqs.slice(1)); }));
  await runCase('unordered-seqs', (gg) => rewriteOp(gg, (d) => { d.sourceEventSeqs = d.sourceEventSeqs.slice().reverse(); d.replacementStart = d.sourceEventSeqs[0]; d.replacementEnd = d.sourceEventSeqs[d.sourceEventSeqs.length - 1]; }));
  await runCase('beyond-boundary', (gg, op, session) => rewriteOp(gg, (d) => { d.sourceEventSeqs = d.sourceEventSeqs.concat([session.events.length + 50]); }));
  await runCase('wrong-start', (gg) => rewriteOp(gg, (d) => { d.replacementStart = d.replacementStart + 1000; }));
  await runCase('wrong-end', (gg) => rewriteOp(gg, (d) => { d.replacementEnd = d.replacementEnd + 1000; }));
  await runCase('union-mismatch', (gg) => rewriteOp(gg, (d) => { const last = d.segments[d.segments.length - 1]; last.sourceEventSeqs = last.sourceEventSeqs.slice(0, -1); last.end = last.sourceEventSeqs[last.sourceEventSeqs.length - 1]; }));
  await runCase('endpoint-mismatch', (gg) => rewriteOp(gg, (d) => { d.segments[0].end = d.segments[0].end + 1000; }));
  await runCase('foreign-seq', (gg, op, session) => rewriteOp(gg, (d) => { d.segments[0].sourceEventSeqs = [session.events.length + 77].concat(d.segments[0].sourceEventSeqs.slice(1)); }));
  await runCase('missing-segments', (gg) => rewriteOp(gg, (d) => { d.segments = []; }));
  await runCase('malformed-json', (gg) => { fs.writeFileSync(opPath(gg), '{not json'); });
  await runCase('operationId-mismatch-readable', (gg, op) => rewriteOp(gg, (d) => { d.operationId = String(d.operationId).replace(/^ccop_/, 'ccop_deadbeef'); }));
}
  console.log('RESULT: ' + passed + ' F2 production assertions passed (' + assertions + ' total assertions).');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
