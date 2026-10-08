'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const capMod = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const regMod = require(path.join(repoRoot, 'config', 'ContextTokenizerRegistryV2.cjs'));
const host = require(path.join(repoRoot, 'config', 'ContextCompilerActiveHostV2.cjs'));
const shadowHost = require(path.join(repoRoot, 'config', 'ContextCompilerShadowHostV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
const ROUTES = [
  { provider: 'opencode-go', model: 'muse-spark-1.3-contributor', reasoning: 'xhigh', window: 1048576, output: 131072 },
  { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', reasoning: 'xhigh', window: 1048576, output: 131072 },
];
const NSH = Object.freeze({ taskId: 'TASK-C08M-A', taskInstanceId: 'task_c08m_a_0001', sessionId: 'sess-c08m-a', repositoryId: 'repo-c08m', checkoutId: 'co-c08m' });
const TURN_TEXT = 'Run the Muse acceptance turn.';
const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';
function checkpointInputH(workspace) {
  return {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove EMv2 acceptance wiring.', status: 'in-progress' },
    requirements: [{ id: 'REQ-M1', text: 'Muse routes stay safe without a verified tokenizer.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H Muse', remainingMilestones: [] },
    decisions: [{ id: 'D-M1', statement: 'Fallback stays safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-M1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt C08H Muse.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C08H Muse.' },
  };
}
function snapshotTokenForH(cpInput) {
  return snapshotMod.capture({
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: cpInput.workspaceId, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: cpInput.objective, requirements: cpInput.requirements, constraints: cpInput.constraints,
      progress: cpInput.progress, decisions: cpInput.decisions,
      failures: { activeFailures: cpInput.failures.activeFailures, rejectedHypotheses: cpInput.failures.rejectedHypotheses },
      verification: cpInput.verification, continuation: cpInput.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08m:index'), worktreeDigest: sha('c08m:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
}
function makeFixtureRoot(policySection) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c08m-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c08m-ws-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'routing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'logs'), { recursive: true });
  const policy = { version: 3 };
  if (policySection !== undefined) policy.contextCompiler = policySection;
  fs.writeFileSync(path.join(root, 'config', 'routing-policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(root, 'data', 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }));
  return { root, workspace };
}
function seedBindingH(fx, sessionId) {
  const p = path.join(fx.root, 'data', 'routing', 'session-bindings.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  doc.bindings[sessionId] = {
    sessionId, taskInstanceId: NSH.taskInstanceId, taskId: NSH.taskId,
    workspace: fx.workspace, workspaceId: fx.workspace,
    repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    preset: 'aih-muse', engine: 'muse',
  };
  fs.writeFileSync(p, JSON.stringify(doc));
}
function liveRequestH(route, sessionId, turnText, extra) {
  const base = {
    provider: route.provider, model: route.model, reasoningEffort: route.reasoning, maxTokens: 32768,
    system: SYSTEM_TEXT,
    messages: [
      { id: 'msg-u1', role: 'user', content: [{ type: 'text', text: turnText || TURN_TEXT }], source: { kind: 'user' } },
    ],
    tools: [],
    routingAuthority: { source: 'controller', target: { provider: route.provider, model: route.model } },
    sessionId, metadata: { taskId: NSH.taskId, turnId: 'live' },
  };
  return Object.assign(clone(base), extra || {});
}
function bindingsPathOf(fx) { return path.join(fx.root, 'data', 'routing', 'session-bindings.json'); }
function snapshotOf(request) { return JSON.stringify(checkpoint.canonicalize(clone(request))); }
function activePolicy(fx) { return host.resolveActivePolicyV2({ installRoot: fx.root }); }
function wipe(fx) { fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true }); }
function stageMemoryH(fx) {
  const raw = checkpointInputH(fx.workspace);
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: snapshotTokenForH(raw) }));
  const memDir = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId);
  const persisted = checkpoint.persistCheckpointV2(path.join(memDir, 'checkpoints'), { checkpoint: built.checkpoint, serialized: built.serialized });
  const inlinePage = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      workspaceId: fx.workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = inlinePage('decision', 'agent', ['decision:H9'], [40], 'Historical host note for Muse audit. '.repeat(30));
  const TOOL = inlinePage('tool-result', 'tool', ['tool-event:call-m7'], [7, 8], 'exit 0 settled Muse tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
  const CP = persisted.checkpoint;
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-M1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-M1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-M1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  fs.writeFileSync(path.join(memDir, 'tier-decisions.json'), JSON.stringify(decisions));
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([{ pageId: TOOL.id, callId: 'call-m7', callSeq: 7, resultSeq: 8 }]));
  return { CP, memDir };
}
section('C08M-1 CAPABILITY TRUTH (window known, tokenizer unavailable)');
{
  for (const route of ROUTES) {
    const r = capMod.resolveModelCapabilityV2({ provider: route.provider, model: route.model, installRoot: repoRoot });
    check(r.valid === false && r.reason === 'active-tokenizer-unavailable', route.provider + ' tokenizer-unavailable (never guessed)');
    check(r.windowKnown === true && r.maxContextTokens === route.window, route.provider + ' window authoritative (' + r.maxContextTokens + ')');
  }
  const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
  check(remote.resolveMuseRemoteV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }) === null, 'no remote authority for opencode (404 evidence)');
  const sniffed = capMod.resolveModelCapabilityV2({ provider: 'opencode-go', model: 'deepseek-v4-flash', installRoot: repoRoot });
  check(sniffed.valid === false, 'cross-route tokenizer reuse impossible');
  const deep = regMod.resolveProductionTokenizerV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' });
  check(deep === null, 'production registry has no Muse entry');
}
section('C08M-2 OFF / OBSERVE / ACTIVE ON BOTH EMV2 ROUTES');
{
  for (const route of ROUTES) {
    const runMode = (policySection) => {
      const fx = makeFixtureRoot(policySection);
      seedBindingH(fx, NSH.sessionId);
      stageMemoryH(fx);
      const request = liveRequestH(route, NSH.sessionId);
      const before = snapshotOf(request);
      const out = host.applyActiveProjectionV2({
        request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
      });
      return { out, request, before, fx };
    };
    const off = runMode(undefined);
    check(off.out.mode === 'LEGACY' && off.out.request === off.request && snapshotOf(off.request) === off.before, route.provider + ' OFF: identical legacy reference');
    wipe(off.fx);
    const obs = runMode({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
    check(obs.out.mode === 'LEGACY' && obs.out.request === obs.request, route.provider + ' OBSERVE: legacy, no active projection');
    wipe(obs.fx);
    const act = runMode({ mode: 'active' });
    check(act.out.mode === 'LEGACY' && act.out.request === act.request, route.provider + ' ACTIVE without verified local tokenizer stays legacy');
    check(act.out.fallbackReason === 'active-tokenizer-unavailable', route.provider + ' fallback reason exact');
    check(snapshotOf(act.request) === act.before, route.provider + ' legacy bytes untouched');
    check(shadowHost.resolveShadowPolicyV2({ installRoot: act.fx.root }).mode === 'off', route.provider + ' no second shadow compile under active');
    const blob = JSON.stringify(act.out.telemetry);
    check(blob.indexOf(TURN_TEXT) === -1 && blob.indexOf(SYSTEM_TEXT) === -1, route.provider + ' telemetry secret-safe');
    wipe(act.fx);
  }
}
section('C08M-3 EMV2 FALLBACKS (deterministic, no network)');
{
  for (const route of ROUTES) {
    const setup = () => {
      const fx = makeFixtureRoot({ mode: 'active' });
      seedBindingH(fx, NSH.sessionId);
      stageMemoryH(fx);
      return fx;
    };
    {
      const fx = setup();
      const request = liveRequestH(route, NSH.sessionId, TURN_TEXT, { provider: 'opencode-go', model: 'muse-spark-1.3-evil' });
      request.routingAuthority = { source: 'controller', target: { provider: request.provider, model: request.model } };
      const out = host.applyActiveProjectionV2({
        request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
      });
      check(out.mode === 'LEGACY' && out.request === request, route.provider + ' near-miss model falls back without fuzzy reuse');
      wipe(fx);
    }
    {
      const fx = setup();
      const request = liveRequestH(route, 'sess-foreign');
      const out = host.applyActiveProjectionV2({
        request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
      });
      check(out.mode === 'LEGACY' && out.request === request, route.provider + ' foreign session never reads task memory');
      wipe(fx);
    }
    {
      const fx = setup();
      const request = liveRequestH(route, NSH.sessionId);
      const out = host.applyActiveProjectionV2({
        request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
      });
      check(out.mode === 'LEGACY' && out.request === request && out.fallbackReason === 'active-tokenizer-unavailable', route.provider + ' tokenizer gate precedes revision checks (still legacy)');
      wipe(fx);
    }
  }
}
section('C08M-4 NO SUBSTITUTION (DeepSeek stays separate)');
{
  const deep = capMod.resolveModelCapabilityV2({ provider: 'flash-max-direct', model: 'deepseek-v4-flash', installRoot: repoRoot });
  check(deep.valid === true && deep.capability.source === 'deepseek-official-tokenizer', 'DeepSeek capability intact as additional provider');
  for (const route of ROUTES) {
    const r = capMod.resolveModelCapabilityV2({ provider: route.provider, model: route.model, installRoot: repoRoot });
    check(r.valid === false && r.capability === null, route.provider + ' never borrows the DeepSeek counter');
  }
}
console.log(String.fromCharCode(10) + 'ContextCompilerActiveMuseRoutesV2 suite: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
