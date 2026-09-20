'use strict';
/**
 * ContextCompactionPartial.Tests.cjs - partial-segment restart (§10).
 *
 * A real segmented operation (>=2 segments): physically land ONLY the
 * first exact segment, simulate restart, then drive the REAL production
 * pre-step. Contract A: Nexus appends ONLY the exact missing segment(s),
 * never duplicates the landed one, never widens, never adopts Task B.
 * Task B intent/result survive exactly once; after durability: APPLIED.
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
  const prod = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
  const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
  const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
  const WSCLI = path.join(repoRoot, 'scripts', 'NexusWorkspace.ps1');
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-ws-'));
  harness.initGitRepo(workspace);
  try {
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'partial fixture', reviewRequested: false, engine: 'muse' });
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-partial';
    pwsh(CLI, ['-Action', 'record-root-usage', '-TaskId', taskId], { workspace, taskInstanceId, engineRole: 'muse_main', engine: 'muse', uncachedInputTokens: 100000, cacheReadTokens: 50000, outputTokens: 1, usageAvailable: true, stepId: '1:1', sessionId });
    const runDir = path.join(workspace, '.ai-harness', 'runs', taskId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ schemaVersion: 2, attempt: 0, taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true }));
    pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', taskId], { workspace, taskInstanceId });
    const wsIdentity = pwsh(WSCLI, ['-Action', 'resolve'], { path: workspace });
    // History with an owned runtime snapshot mid-bulk forces >=2 segments.
    const session = Session.create(sessionId);
    const ap = (type, data, opts) => session.append(type, data, opts);
    ap('user/message', harness.identifiedUserMessage('Controller: bound'), { surfaceOp: 'append' });
    ap('user/message', harness.identifiedUserMessage('Task A work HIST-P'), { surfaceOp: 'append' });
    ap('user/message', harness.identifiedUserMessage('Current runtime context. STALE-P', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }), { surfaceOp: 'append' });
    for (let r = 0; r < 4; r += 1) {
      ap('assistant/message', harness.identifiedAssistantMessage('', 1, r + 1, [{ type: 'tool-call', name: 'run', callId: 'p' + r }]), { surfaceOp: 'append' });
      ap('tool/result', harness.identifiedToolResult('p' + r, 'bulk HIST-P ' + r, 1, r + 1), { surfaceOp: 'append' });
    }
    ap('user/message', harness.identifiedUserMessage('Task A final'), { surfaceOp: 'append' });
    ap('assistant/message', harness.identifiedAssistantMessage('A done', 2, 1), { surfaceOp: 'append' });
    session.header = Object.assign({}, session.header, { cwd: workspace, agentPreset: 'aih-muse' });
    harness.seedBinding(dataRoot, sessionId, {
      sessionId, taskInstanceId, taskId, workspace,
      workspaceId: wsIdentity.workspaceId, repositoryId: wsIdentity.repositoryId,
      checkoutId: wsIdentity.checkoutId, checkoutRootPath: wsIdentity.checkoutRootPath,
      executionRoot: wsIdentity.executionRoot,
      preset: 'aih-muse', engine: 'muse', description: 'partial',
      executionClass: 'muse_main', reviewRequired: false, needsRouteCheck: false,
      boundAtUtc: new Date().toISOString(),
    });
    const cli = (action, payload) => pwsh(CLI, ['-Action', action, '-TaskId', taskId], payload);
    cli('eligibility', { workspace, taskInstanceId, sessionId });
    cli('transition', { workspace, taskInstanceId, to: 'eligible', reason: 'partial', sessionId });
    const cp = cli('build-checkpoint', { workspace, taskInstanceId, continuityUserText: 'u', continuityAssistantText: 'a' });
    cli('transition', { workspace, taskInstanceId, to: 'checkpoint-ready', reason: 'partial', sessionId, checkpointPath: cp.path });
    const cut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const owned = prod.runtimeContextSeqsOf(session);
    const segs = prod.splitRangeAroundOwned(session, cut.shadowedSeqs, owned);
    check(segs && segs.length >= 2, 'partial setup: operation has >=2 segments (got ' + (segs && segs.length) + ')');
    const flat = [];
    for (const sg of segs) for (const sq of sg.sourceEventSeqs) flat.push(sq);
    const op = cli('freeze-operation', { workspace, taskInstanceId, sessionId, replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments: segs, completionBoundarySeq: session.events.length - 1, repositoryId: wsIdentity.repositoryId, checkoutId: wsIdentity.checkoutId, checkpointPath: cp.path });
    check(op && op.operationId, 'partial setup: frozen operation persisted');
    cli('transition', { workspace, taskInstanceId, to: 'apply-pending', reason: 'partial', sessionId });
    // Crash after landing ONLY the first exact segment (same message shape
    // the bridge appends, same operationId).
    const first = segs[0];
    const landedOne = session.append('user/message', {
      id: harness.newMessageId(), role: 'user',
      content: [{ type: 'text', text: '<nexus-context-checkpoint task="T"/>' }],
      source: { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: op.operationId },
    }, { surfaceOp: { op: 'replace', start: first.start, end: first.end }, sourceEventSeqs: first.sourceEventSeqs });
    check(landedOne && typeof landedOne.seq === 'number', 'partial setup: first segment landed');
    const countAfterFirst = session.events.length;
    // Task B arrives before the retry.
    session.append('user/message', harness.identifiedUserMessage('Task B intent PARTIAL-B'), { surfaceOp: 'append' });
    session.append('assistant/message', harness.identifiedAssistantMessage('B noted', 3, 1), { surfaceOp: 'append' });
    // Simulate restart: drive the REAL production pre-step.
    const ctx = harness.makeCtx({});
    harness.loadBridge().apply(ctx);
    const preStep = ctx._handlers['agent/pre-step'][0];
    const agent = { session, signal: new AbortController().signal, options: {} };
    const prompt = () => ({ id: harness.newMessageId(), role: 'user', content: [{ type: 'text', text: 'resume' }], source: { kind: 'user' } });
    await preStep({ agent, messages: [prompt()], step: 1, turn: 5 }, async () => ({ kind: 'enter', messages: [] }));
    const snap = cli('snapshot', { workspace, taskInstanceId });
    check(snap.state === 'applied', 'partial: retry completes to APPLIED (got ' + snap.state + ')');
    const replacements = session.events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.operationId === op.operationId);
    check(replacements.length === segs.length, 'partial: exactly one node per frozen segment, no duplicates (got ' + replacements.length + ' for ' + segs.length + ' segments)');
    const frozenAfter = JSON.stringify(cli('read-operation', { workspace, taskInstanceId }));
    check(JSON.parse(frozenAfter).sourceEventSeqs.length === flat.length, 'partial: frozen sourceEventSeqs unchanged');
    const derived = session.deriveMessages().map((m) => JSON.stringify(m));
    check(derived.filter((t) => t.includes('PARTIAL-B')).length === 1, 'partial: Task B intent survives exactly once');
    check(!derived.join('').includes('HIST-P'), 'partial: Task A bulk fully shadowed after completion');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('RESULT: ' + passed + ' partial-segment assertions passed (' + assertions + ' total assertions).');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
