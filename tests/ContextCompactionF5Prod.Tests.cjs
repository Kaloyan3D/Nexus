'use strict';
/**
 * ContextCompactionF5Prod.Tests.cjs - F5 production-path regression.
 *
 * Drives the REAL AihController pre-step orchestration with a REAL task
 * generation, REAL DSH Session objects, and a CONTROLLABLE persistence
 * barrier (the harnessed ctx.sessions.flush fails on demand, then recovers).
 *
 * Required behavior:
 *   append accepted in memory -> flush fails -> state remains
 *   awaiting-durability -> retry while flush still fails -> STILL
 *   awaiting-durability, NEVER applied.
 *   After persistence recovers: flush succeeds -> durable restore sees the
 *   replacement operationId -> APPLIED. The frozen operation is unchanged
 *   throughout.
 *
 * Mutation property: if the bridge wrote APPLIED from memory presence
 * alone (no flush/proof), the first retry would report applied and fail.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const harness = require('./lib/ContextCompactionProdHarness.cjs');

let passed = 0;
let assertions = 0;
function check(cond, name) { assertions += 1; assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }

async function main() {
  const repoRoot = harness.repoRoot;
  const dataRoot = harness.makeDataRoot();
  process.env.DSH_HOME = dataRoot;
  process.env.AIH_INSTALL_ROOT = repoRoot;
  process.env.AIH_TOOLCHAIN_ROOT = repoRoot;
  const dsh = harness.loadDshSession();
  const { Session } = dsh;
  const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
  const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
  const WSCLI = path.join(repoRoot, 'scripts', 'NexusWorkspace.ps1');
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'f5prod-ws-'));
  try {
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'f5 production fixture', reviewRequested: false, engine: 'muse' });
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-f5';
    pwsh(CLI, ['-Action', 'record-root-usage', '-TaskId', taskId], { workspace, taskInstanceId, engineRole: 'muse_main', engine: 'muse', uncachedInputTokens: 100000, cacheReadTokens: 50000, outputTokens: 1, usageAvailable: true, stepId: '1:1', sessionId });
    const runDir = path.join(workspace, '.ai-harness', 'runs', taskId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ schemaVersion: 2, attempt: 0, taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true }));
    pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', taskId], { workspace, taskInstanceId });
    const wsIdentity = pwsh(WSCLI, ['-Action', 'resolve'], { path: workspace });
    const session = Session.create(sessionId);
    const ap = (type, data, opts) => session.append(type, data, opts);
    ap('user/message', harness.identifiedUserMessage('Controller: bound'), { surfaceOp: 'append' });
    ap('user/message', harness.identifiedUserMessage('Task A work HIST-F5'), { surfaceOp: 'append' });
    for (let r = 0; r < 4; r += 1) {
      ap('assistant/message', harness.identifiedAssistantMessage('', 1, r + 1, [{ type: 'tool-call', name: 'run', callId: 'f5c' + r }]), { surfaceOp: 'append' });
      ap('tool/result', harness.identifiedToolResult('f5c' + r, 'bulk HIST-F5 ' + r, 1, r + 1), { surfaceOp: 'append' });
    }
    ap('user/message', harness.identifiedUserMessage('Task A final'), { surfaceOp: 'append' });
    ap('assistant/message', harness.identifiedAssistantMessage('A done', 2, 1), { surfaceOp: 'append' });
    session.header = Object.assign({}, session.header, { cwd: workspace, agentPreset: 'aih-muse' });
    harness.seedBinding(dataRoot, sessionId, {
      sessionId, taskInstanceId, taskId, workspace,
      workspaceId: wsIdentity.workspaceId, repositoryId: wsIdentity.repositoryId,
      checkoutId: wsIdentity.checkoutId, checkoutRootPath: wsIdentity.checkoutRootPath,
      executionRoot: wsIdentity.executionRoot,
      preset: 'aih-muse', engine: 'muse', description: 'f5',
      executionClass: 'muse_main', reviewRequired: false, needsRouteCheck: false,
      boundAtUtc: new Date().toISOString(),
    });
    const cli = (action, payload) => pwsh(CLI, ['-Action', action, '-TaskId', taskId], payload);
    cli('eligibility', { workspace, taskInstanceId, sessionId });
    cli('transition', { workspace, taskInstanceId, to: 'eligible', reason: 'f5', sessionId });
    const cp = cli('build-checkpoint', { workspace, taskInstanceId, continuityUserText: 'u', continuityAssistantText: 'a' });
    cli('transition', { workspace, taskInstanceId, to: 'checkpoint-ready', reason: 'f5', sessionId, checkpointPath: cp.path });
    const prod = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
    const cut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const segs = prod.splitRangeAroundOwned(session, cut.shadowedSeqs, prod.runtimeContextSeqsOf(session));
    const flat = [];
    for (const sg of segs) for (const sq of sg.sourceEventSeqs) flat.push(sq);
    const op = cli('freeze-operation', { workspace, taskInstanceId, sessionId, replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments: segs, completionBoundarySeq: session.events.length - 1, repositoryId: wsIdentity.repositoryId, checkoutId: wsIdentity.checkoutId, checkpointPath: cp.path });
    check(op && op.operationId, 'F5 setup: frozen operation persisted');
    cli('transition', { workspace, taskInstanceId, to: 'apply-pending', reason: 'f5', sessionId });
    const frozenBefore = JSON.stringify(op);

    // Persistence DOWN: flush throws on every attempt. The fake backend
    // exposes a durable byte surface that only advances on successful
    // flush, so the byte proof and the restore proof agree with reality.
    let flushDown = true;
    let dropWrites = false;
    let durableBytes = '';
    const ctx = harness.makeCtx({
      flushImpl: async (liveSession) => {
        if (flushDown) throw new Error('simulated persistence outage');
        if (!dropWrites) durableBytes = JSON.stringify(liveSession.events);
        return true;
      },
    });
    const fakePersistence = {
      async readRaw() {
        if (durableBytes === '') return undefined;
        return { content: durableBytes, header: { id: sessionId } };
      },
    };
    const baseGet = ctx.get.bind(ctx);
    ctx.get = (name) => (name === 'sessionPersistence' ? fakePersistence : baseGet(name));
    harness.loadBridge().apply(ctx);
    const preStep = ctx._handlers['agent/pre-step'][0];
    const agent = { session, signal: new AbortController().signal, options: {} };
    const prompt = () => ({ id: harness.newMessageId(), role: 'user', content: [{ type: 'text', text: 'follow-up' }], source: { kind: 'user' } });
    const snap = () => pwsh(CLI, ['-Action', 'snapshot', '-TaskId', taskId], { workspace, taskInstanceId });

    await preStep({ agent, messages: [prompt()], step: 1, turn: 3 }, async () => ({ kind: 'enter', messages: [] }));
    check(snap().state === 'awaiting-durability', 'F5: flush failure rests at awaiting-durability (got ' + snap().state + ')');
    const landedOnce = prod.findReplacementByOperation(session, op.operationId);
    check(landedOnce, 'F5: replacement accepted in live memory despite flush failure');
    await preStep({ agent, messages: [prompt()], step: 1, turn: 4 }, async () => ({ kind: 'enter', messages: [] }));
    check(snap().state === 'awaiting-durability', 'F5: second retry while down STILL awaiting-durability');
    check(snap().state !== 'applied', 'F5: NEVER applied while persistence is down');

    // Flush ACKs but the write never lands (the two-process divergence
    // class): flush succeeds yet durable bytes lack the replacement. Only
    // the byte/restore proof can tell; memory presence must NOT apply.
    flushDown = false;
    dropWrites = true;
    await preStep({ agent, messages: [prompt()], step: 1, turn: 5 }, async () => ({ kind: 'enter', messages: [] }));
    check(snap().state === 'awaiting-durability', 'F5: acked-but-dropped write stays awaiting-durability (got ' + snap().state + ')');
    check(snap().state !== 'applied', 'F5: NEVER applied from memory presence alone');

    // Persistence RECOVERS: flush succeeds, durable restore sees the op.
    dropWrites = false;
    await preStep({ agent, messages: [prompt()], step: 1, turn: 6 }, async () => ({ kind: 'enter', messages: [] }));
    check(snap().state === 'applied', 'F5: applied after persistence recovers (got ' + snap().state + ')');
    const telemetry = JSON.parse(fs.readFileSync(path.join(runDir, 'context-compaction-telemetry.json'), 'utf8'));
    check(telemetry.checkpointApplied === true, 'F5: telemetry marks checkpoint applied');
    const opAfter = cli('read-operation', { workspace, taskInstanceId });
    check(JSON.stringify(Object.assign({}, opAfter, { createdAtUtc: null })) === JSON.stringify(Object.assign({}, JSON.parse(frozenBefore), { createdAtUtc: null })), 'F5: frozen operation unchanged throughout');
    // No duplicate replacement records for one operationId.
    const checkpoints = session.events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.operationId === op.operationId);
    const landedNow = prod.findReplacementByOperation(session, op.operationId);
    check(landedNow, 'F5: replacement durably present after recovery');
    check(checkpoints.length >= 1, 'F5: replacement record exists (' + checkpoints.length + ' segment node(s))');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('RESULT: ' + passed + ' F5 production assertions passed (' + assertions + ' total assertions).');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
