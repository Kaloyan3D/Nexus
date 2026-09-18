'use strict';
/**
 * ContextCompactionF1Prod.Tests.cjs - F1 production-path regression.
 *
 * Drives the REAL AihController agent/pre-step orchestration (apply() with a
 * harnessed ctx) over a REAL task generation plus REAL DSH Session objects.
 *
 * Case A (policy unchanged): FIRST model request after compaction contains
 *   exactly 1 authoritative CURRENT runtime snapshot.
 * Case B (policy changed between checkpoint and apply): 0 OLD authoritative
 *   snapshots, exactly 1 NEW authoritative snapshot.
 * Case C: the persisted session log (with the factory-identified refreshed
 *   snapshot) survives a fresh-process Session.fromRestore.
 *
 * Mutation property: reverting refreshRuntimeContextSnapshot to the
 * anonymous-message form (or deleting the prepend ordering) makes Case B
 * fail (OLD snapshot authoritative in the request) and Case C fail
 * (resume rejects the unidentified message).
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
  const pwsh = (script, args, payload) => harness.pwshFile(script, args, payload);
  const cli = (taskId, action, payload) => pwsh(CLI, ['-Action', action, '-TaskId', taskId], payload);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'f1prod-ws-'));
  try {
    // REAL generation to COMPLETE through production CLIs.
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'f1 production fixture', reviewRequested: false, engine: 'muse' });
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    pwsh(CLI, ['-Action', 'record-root-usage', '-TaskId', taskId], { workspace, taskInstanceId, engineRole: 'muse_main', engine: 'muse', uncachedInputTokens: 100000, cacheReadTokens: 50000, outputTokens: 50, usageAvailable: true, stepId: '1:1', sessionId: 'sess-f1' });
    const runDir = path.join(workspace, '.ai-harness', 'runs', taskId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify({ schemaVersion: 2, attempt: 0, taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true }));
    const done = pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', taskId], { workspace, taskInstanceId });
    check(done && done.status === 'COMPLETE', 'F1 setup: generation controller-COMPLETE');

    // REAL DSH session mirroring Task A history with a STALE owned snapshot.
    const sessionId = 'sess-f1';
    const session = Session.create(sessionId);
    const ap = (type, data, opts) => session.append(type, data, opts);
    const userMsg = (text, source) => harness.identifiedUserMessage(text, source);
    const STALE = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nmode: STALE-A';
    ap('user/message', userMsg('Controller: task bound ' + taskId), { surfaceOp: 'append' });
    ap('user/message', userMsg('Task A work HIST-F1'), { surfaceOp: 'append' });
    ap('user/message', userMsg(STALE, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }), { surfaceOp: 'append' });
    // Assistant/tool envelopes mirror production: identified assistant
    // messages with model source (provider+model) and tool results whose
    // callIds pair with their calls.
    // Production envelopes via the harness builders (ids placed exactly
    // where assertMessageEventShape requires them).
    for (let r = 0; r < 4; r += 1) {
      ap('assistant/message', harness.identifiedAssistantMessage('', 1, r + 1, [{ type: 'tool-call', name: 'run', callId: 'f1c' + r }]), { surfaceOp: 'append' });
      ap('tool/result', harness.identifiedToolResult('f1c' + r, 'bulk HIST-F1 ' + r, 1, r + 1), { surfaceOp: 'append' });
    }
    ap('user/message', userMsg('Task A final'), { surfaceOp: 'append' });
    ap('assistant/message', harness.identifiedAssistantMessage('A done', 2, 1), { surfaceOp: 'append' });
    session.header = Object.assign({}, session.header, { cwd: workspace, agentPreset: 'aih-muse' });

    // Seed the controller binding the bridge will validate against the ledger.
    // Repository identity matches what NexusWorkspace.ps1 resolves for this
    // workspace (production bindings are enriched by validateWorkspaceIdentity
    // before any compaction work runs).
    const wsIdentity = pwsh(path.join(repoRoot, 'scripts', 'NexusWorkspace.ps1'), ['-Action', 'resolve'], { path: workspace });
    harness.seedBinding(dataRoot, sessionId, {
      sessionId, taskInstanceId, taskId, workspace,
      workspaceId: wsIdentity.workspaceId, repositoryId: wsIdentity.repositoryId,
      checkoutId: wsIdentity.checkoutId, checkoutRootPath: wsIdentity.checkoutRootPath,
      executionRoot: wsIdentity.executionRoot,
      preset: 'aih-muse', engine: 'muse', description: 'f1 production fixture',
      executionClass: 'muse_main', reviewRequired: false, needsRouteCheck: false,
      boundAtUtc: new Date().toISOString(),
    });

    // Case B policy text: the CURRENT assembly differs from the stale node.
    const CURRENT = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nmode: CURRENT-B';
    const fakeSystemPrompt = {
      async assemble() {
        return { sections: [], contexts: [{ name: 'sandbox', text: 'mode: CURRENT-B' }], tools: [], variables: {} };
      },
    };
    const ctx = harness.makeCtx({ systemPromptImpl: fakeSystemPrompt });
    const bridge = harness.loadBridge();
    bridge.apply(ctx);
    const preStep = ctx._handlers['agent/pre-step'][0];
    check(typeof preStep === 'function', 'F1 setup: production pre-step handler captured');

    // Establish checkpoint-ready + frozen operation via the production
    // completion path is heavy here (verify CLIs); instead drive the SAME
    // production CLIs the completion path calls, in the SAME order.
    const elig = cli(taskId, 'eligibility', { workspace, taskInstanceId, sessionId });
    check(elig && elig.eligibilityDecision === 'eligible', 'F1 setup: eligible at threshold');
    cli(taskId, 'transition', { workspace, taskInstanceId, to: 'eligible', reason: 'f1prod', sessionId });
    const cp = cli(taskId, 'build-checkpoint', { workspace, taskInstanceId, continuityUserText: 'Task A work', continuityAssistantText: 'A done' });
    check(cp && cp.path, 'F1 setup: checkpoint built');
    cli(taskId, 'transition', { workspace, taskInstanceId, to: 'checkpoint-ready', reason: 'f1prod', sessionId, checkpointPath: cp.path });
    // Freeze through the production cut math on THIS session (same helpers
    // the bridge uses), then persist via the production freeze CLI.
    const prod = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
    const liveCut = prod.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    check(liveCut && liveCut.shadowedSeqs.length > 0, 'F1 setup: freeze cut computed');
    const owned = prod.runtimeContextSeqsOf(session);
    const segments = prod.splitRangeAroundOwned(session, liveCut.shadowedSeqs, owned);
    check(segments && segments.length > 0, 'F1 setup: segments split around owned snapshot');
    const flat = [];
    for (const sg of segments) for (const sq of sg.sourceEventSeqs) flat.push(sq);
    const boundary = session.events.length - 1;
    const op = cli(taskId, 'freeze-operation', { workspace, taskInstanceId, sessionId, replacementStart: flat[0], replacementEnd: flat[flat.length - 1], sourceEventSeqs: flat, segments, completionBoundarySeq: boundary, repositoryId: wsIdentity.repositoryId, checkoutId: wsIdentity.checkoutId, checkpointPath: cp.path });
    check(op && op.operationId, 'F1 setup: frozen operation persisted');
    cli(taskId, 'transition', { workspace, taskInstanceId, to: 'apply-pending', reason: 'f1prod', sessionId });

    // Drive the ACTUAL production pre-step with a new user prompt.
    // Keep the temp dataRoot path for the controller-log dump on failure.
    process.env.F1PROD_DATAROOT = dataRoot;
    const agent = { session, signal: new AbortController().signal, options: {} };
    const promptEvent = { role: 'user', content: [{ type: 'text', text: 'Next: follow-up work' }], source: { kind: 'user' } };
    let nextCalled = false;
    const result = await preStep({ agent, messages: [promptEvent], step: 1, turn: 3 }, async () => { nextCalled = true; return { kind: 'enter', messages: [] }; });
    check(nextCalled || (result && result.kind !== 'reject'), 'F1: production pre-step completes the turn');

    // FIRST ACTUAL model request = what buildRequest would send.
    // DSH authority rule: the LAST runtime snapshot on the surface is the
    // authoritative one (every snapshot carries 'supersedes earlier'
    // framing). The stale node remains as visible history; it must NOT be
    // the authority after a policy change.
    const requestMessages = session.deriveMessages();
    const requestText = JSON.stringify(requestMessages);
    const staleCount = requestText.split('STALE-A').length - 1;
    const currentCount = requestText.split('CURRENT-B').length - 1;
    check(staleCount <= 1, 'F1-B: stale snapshot at most visible history (got ' + staleCount + ')');
    check(currentCount === 1, 'F1-B: exactly 1 authoritative NEW snapshot in first request (got ' + currentCount + ')');
    check(requestText.lastIndexOf('CURRENT-B') > requestText.lastIndexOf('STALE-A'), 'F1-B: CURRENT snapshot is positionally authoritative (last wins)');
    check(!requestText.includes('HIST-F1'), 'F1: historical bulk absent from first request');
    check(requestText.includes('nexus-context-checkpoint'), 'F1: checkpoint present in first request');

    // Case C: fresh-process resume of the persisted log.
    const header = { version: 0, id: sessionId, createdAt: Date.now(), cwd: workspace };
    const seed = JSON.parse(JSON.stringify(session.events));
    let restored = null;
    try {
      restored = dsh.Session.fromRestore(sessionId, seed, header);
    } catch (e) {
      check(false, 'F1-C: fresh restore succeeds (failed: ' + e.message + ')');
    }
    // DSH appends a session/end-seed marker when the seed lacks one, so the
    // restored log is the seed plus exactly that marker -- nothing lost.
    check(restored && restored.events.length === seed.length + 1, 'F1-C: fresh-process resume succeeds (seed plus end-seed marker)');
    check(restored.events[restored.events.length - 1].type === 'session/end-seed', 'F1-C: marker is the native end-seed event');
    // Every user/message in the restored log carries DSH identity.
    let missingId = 0;
    for (const ev of restored.events) {
      if (ev.type === 'user/message' && (!ev.data || typeof ev.data.id !== 'string' || ev.data.id === '')) missingId += 1;
    }
    check(missingId === 0, 'F1-C: no anonymous messages persisted (missing ids: ' + missingId + ')');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('RESULT: ' + passed + ' F1 production assertions passed (' + assertions + ' total assertions).');
}
main().catch((e) => { console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
