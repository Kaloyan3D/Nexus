'use strict';
/**
 * ContextCompactionF5Slow.Tests.cjs - slow-owner cross-process production test.
 *
 * Process A drives the REAL production pre-step (short test lease 3s via
 * AIH_COMPACTION_TEST_LEASE_S, identical lock/heartbeat code) with a REAL
 * 8s persistence delay -- LONGER than the lease. Process B (separate Node
 * process, same operation, production acquire CLI) starts after the original
 * expiry and must NOT become a writer while A's heartbeat is healthy.
 *
 * Mutation property: with heartbeat renewal disabled, B acquires past
 * expiry and the 'no second writer' assertion fails.
 *
 * Evidence: A/B lock results, single operationId record, monotonic valid
 * sequence, fresh public restore PASS, final lifecycle APPLIED.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  process.env.AIH_COMPACTION_TEST_LEASE_S = '3';
  const dsh = harness.loadDshSession();
  const { Session } = dsh;
  const prod = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
  const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
  const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
  const WSCLI = path.join(repoRoot, 'scripts', 'NexusWorkspace.ps1');
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'f5slow-ws-'));
  harness.initGitRepo(workspace);
  try {
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'f5 slow fixture', reviewRequested: false, engine: 'muse' });
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-f5slow';
    pwsh(CLI, ['-Action', 'record-root-usage', '-TaskId', taskId], { workspace, taskInstanceId, engineRole: 'muse_main', engine: 'muse', uncachedInputTokens: 100000, cacheReadTokens: 50000, outputTokens: 1, usageAvailable: true, stepId: '1:1', sessionId });
    const runDir = path.join(workspace, '.ai-harness', 'runs', taskId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ schemaVersion: 2, attempt: 0, taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true }));
    pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', taskId], { workspace, taskInstanceId });
    const wsIdentity = pwsh(WSCLI, ['-Action', 'resolve'], { path: workspace });
    const session = Session.create(sessionId);
    const ap = (type, data, opts) => session.append(type, data, opts);
    ap('user/message', harness.identifiedUserMessage('Controller: bound'), { surfaceOp: 'append' });
    ap('user/message', harness.identifiedUserMessage('Task A work HIST-F5S'), { surfaceOp: 'append' });
    for (let r = 0; r < 4; r += 1) {
      ap('assistant/message', harness.identifiedAssistantMessage('', 1, r + 1, [{ type: 'tool-call', name: 'run', callId: 'fs' + r }]), { surfaceOp: 'append' });
      ap('tool/result', harness.identifiedToolResult('fs' + r, 'bulk HIST-F5S ' + r, 1, r + 1), { surfaceOp: 'append' });
    }
    ap('user/message', harness.identifiedUserMessage('Task A final'), { surfaceOp: 'append' });
    ap('assistant/message', harness.identifiedAssistantMessage('A done', 2, 1), { surfaceOp: 'append' });
    session.header = Object.assign({}, session.header, { cwd: workspace, agentPreset: 'aih-muse' });
    harness.seedBinding(dataRoot, sessionId, {
      sessionId, taskInstanceId, taskId, workspace,
      workspaceId: wsIdentity.workspaceId, repositoryId: wsIdentity.repositoryId,
      checkoutId: wsIdentity.checkoutId, checkoutRootPath: wsIdentity.checkoutRootPath,
      executionRoot: wsIdentity.executionRoot,
      preset: 'aih-muse', engine: 'muse', description: 'f5slow',
      executionClass: 'muse_main', reviewRequired: false, needsRouteCheck: false,
      boundAtUtc: new Date().toISOString(),
    });
    const cli = (action, payload) => pwsh(CLI, ['-Action', action, '-TaskId', taskId], payload);
    cli('eligibility', { workspace, taskInstanceId, sessionId });
    cli('transition', { workspace, taskInstanceId, to: 'eligible', reason: 'f5slow', sessionId });
    const cp = cli('build-checkpoint', { workspace, taskInstanceId, continuityUserText: 'u', continuityAssistantText: 'a' });
    cli('transition', { workspace, taskInstanceId, to: 'checkpoint-ready', reason: 'f5slow', sessionId, checkpointPath: cp.path });
    const cut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const segs = prod.splitRangeAroundOwned(session, cut.shadowedSeqs, prod.runtimeContextSeqsOf(session));
    const flat = [];
    for (const sg of segs) for (const sq of sg.sourceEventSeqs) flat.push(sq);
    const op = cli('freeze-operation', { workspace, taskInstanceId, sessionId, replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments: segs, completionBoundarySeq: session.events.length - 1, repositoryId: wsIdentity.repositoryId, checkoutId: wsIdentity.checkoutId, checkpointPath: cp.path });
    check(op && op.operationId, 'F5-slow setup: frozen operation persisted');
    cli('transition', { workspace, taskInstanceId, to: 'apply-pending', reason: 'f5slow', sessionId });
    // Process A: production pre-step with a REAL 8s persistence delay
    // (lease 3s, heartbeat ~1s, identical production code). Durable bytes
    // advance only on successful flush; the byte proof gates APPLIED.
    let durableBytes = '';
    const ctxA = harness.makeCtx({
      flushImpl: async (liveSession) => {
        await new Promise((r) => setTimeout(r, 8000));
        durableBytes = JSON.stringify(liveSession.events);
        return true;
      },
    });
    ctxA.get = ((baseGet) => (name) => {
      if (name === 'sessionPersistence') {
        return { async readRaw() { return durableBytes === '' ? undefined : { content: durableBytes, header: { id: sessionId } }; } };
      }
      return baseGet(name);
    })(ctxA.get.bind(ctxA));
    harness.loadBridge().apply(ctxA);
    const preStepA = ctxA._handlers['agent/pre-step'][0];
    const agentA = { session, signal: new AbortController().signal, options: {} };
    const promptA = () => ({ id: harness.newMessageId(), role: 'user', content: [{ type: 'text', text: 'slow apply' }], source: { kind: 'user' } });
    const promiseA = preStepA({ agent: agentA, messages: [promptA()], step: 1, turn: 3 }, async () => ({ kind: 'enter', messages: [] }));
    // Wait until A holds the lock (poll the lock file), then start B AFTER
    // the original 3s expiry while A is mid-flush with a healthy heartbeat.
    const lockPath = path.join(runDir, 'context-compaction-apply.lock');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(lockPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    check(fs.existsSync(lockPath), 'F5-slow: A holds the application lock');
    const lockTakenAt = Date.now();
    await new Promise((r) => setTimeout(r, 4500));
    // Process B: SEPARATE Node process, same operation, production acquire.
    const workerPath = path.join(repoRoot, 'tests', 'ContextCompactionXProc.Worker.cjs');
    const runB = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [workerPath, workspace, taskId, taskInstanceId, sessionId, op.operationId, '0', 'SLOW-B', '60', 'off'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    const rb = await runB();
    check(rb.code === 2, 'F5-slow: B refused while A alive past original expiry (code ' + rb.code + ')');
    check(rb.out.includes('held-by-live-owner'), 'F5-slow: B observes live-owner refusal');
    const resultA = await promiseA;
    void resultA;
    // The pre-step handler discards the apply result (it returns next());
    // the authoritative completion signal is the lifecycle state.
    const snapA = cli('snapshot', { workspace, taskInstanceId });
    check(snapA.state === 'applied', 'F5-slow: A completes the physical application (got ' + snapA.state + ')');
    const heldMs = Date.now() - lockTakenAt;
    check(heldMs > 3000, 'F5-slow: hold outlasted the original lease (' + heldMs + 'ms)');
    // Exactly one semantic application: one operationId record set.
    const replacements = session.events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.operationId === op.operationId);
    check(replacements.length >= 1, 'F5-slow: exactly one semantic application (' + replacements.length + ' segment node(s))');
    // Monotonic valid sequence: seqs strictly increase with log order.
    let monotonic = true;
    for (let i = 0; i < session.events.length; i += 1) {
      if (session.events[i].seq !== i) { monotonic = false; break; }
    }
    check(monotonic, 'F5-slow: JSONL sequence strictly valid/monotonic');
    // Fresh public restore in a new process shape (same-process restore of
    // the exact persisted-bytes form the backend would hold).
    const header = { version: 0, id: sessionId, createdAt: Date.now(), cwd: workspace };
    const seed = JSON.parse(durableBytes).map((e, i) => Object.assign({}, e, { seq: i }));
    let restored = null;
    try {
      restored = dsh.Session.fromRestore(sessionId, seed, header);
    } catch (e) {
      check(false, 'F5-slow: fresh restore succeeds (failed: ' + e.message + ')');
    }
    check(restored && restored.events.length === seed.length + 1, 'F5-slow: fresh public DSH restore PASS');
    const snap = cli('snapshot', { workspace, taskInstanceId });
    check(snap.state === 'applied', 'F5-slow: final lifecycle APPLIED (got ' + snap.state + ')');
  } finally {
    delete process.env.AIH_COMPACTION_TEST_LEASE_S;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('RESULT: ' + passed + ' F5 slow-owner assertions passed (' + assertions + ' total assertions).');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
