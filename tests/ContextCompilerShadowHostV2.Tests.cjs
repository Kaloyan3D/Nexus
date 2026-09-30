'use strict';
/**
 * ContextCompilerShadowHostV2.Tests.cjs - CCV2-C07H production wiring proof.
 *
 * Proves the normal Nexus runtime actually invokes C07 WITHOUT test code
 * ever calling the adapter as the proof driver:
 *   A. the REAL config/AihController.cjs apply() installs exactly one
 *      llm/stream observer (re-apply safe), and with shadow OFF the
 *      installed listener passes the live request through byte-identical
 *      with zero adapter calls and zero telemetry;
 *   B. through the repository's real request composition (installed DSH
 *      model selection + real isolation + real routing-integrity in the
 *      llm/stream waterfall), shadow ON performs exactly one observation
 *      per request with a real candidate/report, identical OFF/ON
 *      requests, identical stub responses, failure isolation, routing
 *      compatibility, and durable-memory immutability;
 *   C. through the REAL pinned DSH loop (cordis Context + AgentLoop +
 *      stub terminal), the installed observer fires on a normal
 *      followup turn end to end.
 *
 * The adapter module is SPIED ON (call counts only) and NEVER invoked
 * by this suite: every observation below is produced by the host
 * installation firing on a request lifecycle. Fault injection uses the
 * host module's own override seams (adapterModule/log), never adapter
 * internals.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const repoRoot = path.resolve(__dirname, '..');
const host = require(path.join(repoRoot, 'config', 'ContextCompilerShadowHostV2.cjs'));
const shadow = require(path.join(repoRoot, 'config', 'ContextCompilerShadowV2.cjs'));
const adapterMod = require(path.join(repoRoot, 'config', 'ContextCompilerShadowAdapterV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const trust = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));
const profiles = require(path.join(repoRoot, 'config', 'Engineering-Profiles.cjs'));
const integrity = require(path.join(repoRoot, 'config', 'Routing-Integrity.cjs'));
const muse = require(path.join(repoRoot, 'config', 'Muse-Isolation.cjs'));
const { createPresetCtx, waterfall } = require('./lib/AgentRequestComposition.cjs');
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('\n' + title); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
// Adapter call spy (counts only; the suite never invokes the adapter).
const realObserve = adapterMod.observeCompilerShadowV2;
let observeCalls = 0;
adapterMod.observeCompilerShadowV2 = function countedObserve(input) {
  observeCalls += 1;
  return realObserve(input);
};
function resetSpy() { observeCalls = 0; }

section('C07H FIXTURES - staged production-shaped CCv2 memory');
const NSH = Object.freeze({
  taskId: 'TASK-C07H-A',
  taskInstanceId: 'task_c07h_a_0001',
  sessionId: 'sess-c07h-a',
  repositoryId: 'repo-c07h',
  checkoutId: 'co-c07h',
});
const TURN_TEXT = 'Ship C07H now.';
function checkpointInputH(workspace) {
  return {
    taskId: NSH.taskId,
    taskInstanceId: NSH.taskInstanceId,
    sessionId: NSH.sessionId,
    workspaceId: workspace,
    repositoryId: NSH.repositoryId,
    checkoutId: NSH.checkoutId,
    generation: 1,
    kind: 'active',
    safePointBoundarySeq: 9,
    safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove production shadow wiring.', status: 'in-progress' },
    requirements: [
      { id: 'REQ-H1', text: 'Shadow observes production traffic.', status: 'active', evidenceRefs: [] },
    ],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C07H wiring', remainingMilestones: [] },
    decisions: [
      { id: 'D-H1', statement: 'Reports are disposable.', authority: 'controller-established', status: 'active', evidenceRefs: [] },
    ],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-H1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Wire C07H.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C07H.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c07h:index'), worktreeDigest: sha('c07h:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
}
// Production-shaped fixture root: <root>/config/routing-policy.json,
// <root>/data/routing/session-bindings.json, workspace with ccv2 memory.
function makeFixtureRoot(policySection) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c07h-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c07h-ws-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'routing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'logs'), { recursive: true });
  const policy = { version: 3 };
  if (policySection !== undefined) policy.contextCompiler = policySection;
  fs.writeFileSync(path.join(root, 'config', 'routing-policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(root, 'data', 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }));
  return { root, workspace };
}
function seedBindingH(fx, sessionId, extra) {
  const p = path.join(fx.root, 'data', 'routing', 'session-bindings.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  doc.bindings[sessionId] = Object.assign({
    sessionId,
    taskInstanceId: NSH.taskInstanceId,
    taskId: NSH.taskId,
    workspace: fx.workspace,
    workspaceId: fx.workspace,
    repositoryId: NSH.repositoryId,
    checkoutId: NSH.checkoutId,
    preset: 'aih-muse',
    engine: 'muse',
  }, extra || {});
  fs.writeFileSync(p, JSON.stringify(doc));
}
function seedRoutingStateH(fx, provider, model) {
  const binding = { workspace: fx.workspace, taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, preset: 'aih-muse', engine: 'muse' };
  const statePath = profiles.routingStatePath(fx.root, binding);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...binding, profile: 'muse-spark-1.3-contributor', provider, model, reasoning: 'high',
  }));
}
// Stage CCv2 observation memory with FROZEN builders through the FROZEN
// write path (persistCheckpointV2), exactly the bytes a C08 flow would
// later produce.
function stageMemoryH(fx) {
  const raw = checkpointInputH(fx.workspace);
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: snapshotTokenForH(raw) }));
  const memDir = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId);
  const cpDir = path.join(memDir, 'checkpoints');
  const persisted = checkpoint.persistCheckpointV2(cpDir, { checkpoint: built.checkpoint, serialized: built.serialized });
  const inlinePage = (kind, sourceKind, refs, seqs, text, extra) => page.createContextPageV2(Object.assign({
    kind, namespace: {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      workspaceId: fx.workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  }, extra || {}));
  const COLD = inlinePage('decision', 'agent', ['decision:H9'], [40], 'Historical host note. '.repeat(30));
  const TOOL = inlinePage('tool-result', 'tool', ['tool-event:call-h7'], [7, 8], 'exit 0 settled host tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) {
    fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
  }
  const CP = persisted.checkpoint;
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-H1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-H1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-H1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  fs.writeFileSync(path.join(memDir, 'tier-decisions.json'), JSON.stringify(decisions));
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([
    { pageId: TOOL.id, callId: 'call-h7', callSeq: 7, resultSeq: 8 },
  ]));
  return { CP, COLD, TOOL, decisions, memDir };
}
// Production-shaped llm/stream request (frozen by the loop in production;
// frozen here to mirror the host contract).
function liveRequestH(sessionId, turnText) {
  return Object.freeze({
    provider: 'meta-model-api',
    model: 'muse-spark-1.3-contributor',
    reasoningEffort: 'xhigh',
    maxTokens: 32768,
    system: 'You are the Nexus host-contract system prompt.',
    messages: Object.freeze([
      Object.freeze({ id: 'msg-h-u1', role: 'user', content: Object.freeze([{ type: 'text', text: turnText || TURN_TEXT }]), source: Object.freeze({ kind: 'user' }) }),
      Object.freeze({ id: 'msg-h-a1', role: 'assistant', content: Object.freeze([{ type: 'tool-call', name: 'run-tests', callId: 'call-h7' }]), source: Object.freeze({ kind: 'model', provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' }) }),
      Object.freeze({ id: 'msg-h-t1', role: 'user', content: Object.freeze([{ type: 'tool-result', toolCallId: 'call-h7', content: Object.freeze([{ type: 'text', text: 'exit 0' }]) }]), source: Object.freeze({ kind: 'tool', callId: 'call-h7' }) }),
    ]),
    tools: Object.freeze([Object.freeze({ name: 'run-tests', description: 'Run the harness.' })]),
    routingAuthority: Object.freeze({ source: 'controller', target: Object.freeze({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' }) }),
    sessionId,
    metadata: Object.freeze({ taskId: NSH.taskId, turnId: 'live' }),
  });
}
function snapshotOf(request) {
  return JSON.stringify(checkpoint.canonicalize(clone(request)));
}

section('C07H-A REAL APPLY INSTALLS THE HOOK (production registration path)');
function applyWithCtx(fx, shared) {
  const controllerPath = path.join(repoRoot, 'config', 'AihController.cjs');
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const listeners = (shared && shared.listeners) || {};
  const ctx = (shared && shared.ctx) || {
    on: (event, fn, opts) => {
      void opts;
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return () => {};
    },
    shellEnv: { register() {} },
  };
  const previousHome = process.env.DSH_HOME;
  const previousRoot = process.env.AIH_INSTALL_ROOT;
  const previousToolchain = process.env.AIH_TOOLCHAIN_ROOT;
  process.env.DSH_HOME = path.join(fx.root, 'data');
  process.env.AIH_INSTALL_ROOT = fx.root;
  process.env.AIH_TOOLCHAIN_ROOT = repoRoot;
  try {
    controller.apply(ctx);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot;
    if (previousToolchain === undefined) delete process.env.AIH_TOOLCHAIN_ROOT; else process.env.AIH_TOOLCHAIN_ROOT = previousToolchain;
  }
  return { listeners, ctx };
}
{
  // Shipped default: no contextCompiler section -> shadow OFF.
  const fx = makeFixtureRoot(undefined);
  resetSpy();
  const first = applyWithCtx(fx);
  const listeners = first.listeners;
  check(Array.isArray(listeners['llm/stream']) && listeners['llm/stream'].length === 3, 'real apply installs shadow + opencode projection + opencode usage observer (OC01H)');
  applyWithCtx(fx, first);
  check(listeners['llm/stream'].length === 3, 're-apply on the same ctx stays stable (HMR safety, no duplicates)');
  // OFF passthrough through the REAL installed listener.
  const hook = listeners['llm/stream'][0];
  const canned = { chunks: ['ok'] };
  const request = liveRequestH(NSH.sessionId);
  const before = snapshotOf(request);
  const returned = hook(request, () => canned);
  check(returned === canned, 'OFF returns the identical stream reference');
  check(snapshotOf(request) === before, 'OFF leaves the live request byte-identical');
  check(observeCalls === 0, 'OFF performs zero adapter calls');
  check(shadowLogLines(fx).length === 0, 'OFF emits zero telemetry');
}


section('C07H-A2 REAL APPLY + SHADOW ON (telemetry through the controller log)');
{
  const fx = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  seedBindingH(fx, NSH.sessionId);
  stageMemoryH(fx);
  resetSpy();
  const { listeners } = applyWithCtx(fx);
  const hook = listeners['llm/stream'][0];
  const canned = { chunks: ['ok'] };
  const request = liveRequestH(NSH.sessionId);
  const before = snapshotOf(request);
  const returned = hook(request, () => canned);
  check(returned === canned, 'ON returns the identical stream reference');
  check(snapshotOf(request) === before, 'ON leaves the live request byte-identical');
  check(observeCalls === 1, 'host installation invokes the adapter exactly once per request');
  const lines = shadowLogLines(fx);
  check(lines.length === 1, 'exactly one bounded telemetry line emitted');
  const logged = JSON.parse(lines[0]);
  check(logged.event === 'ccv2-compiler-shadow-observed', 'telemetry event namespaced');
  check(typeof logged.candidateViewId === 'string' && logged.shadowStatus === 'MATCHED', 'telemetry binds a MATCHED candidate', logged.shadowStatus);
  check(logged.promotionBlocker === false, 'no promotion blocker on the staged truth');
  check(logged.logicalReduction !== undefined && logged.candidateTokens > 0, 'token telemetry present');
  const blob = lines.join('\n');
  check(blob.indexOf(TURN_TEXT) === -1, 'telemetry carries no raw turn text');
  check(blob.indexOf('exit 0 settled host tool log.') === -1, 'telemetry carries no raw tool text');
  check(blob.indexOf('You are the Nexus host-contract') === -1, 'telemetry carries no system bytes');
  // Same request object re-dispatched (retry/re-entry shape) -> still one.
  hook(request, () => canned);
  check(observeCalls === 1, 'same request object never observed twice');
  check(shadowLogLines(fx).length === 1, 'no duplicate telemetry');
  // Auxiliary purposes and missing sessions never observe.
  hook({ ...clone(request), purpose: 'session-title' }, () => canned);
  hook({ ...clone(request), sessionId: '' }, () => canned);
  hook({ ...clone(request), purpose: 'compaction' }, () => canned);
  check(observeCalls === 1, 'auxiliary and session-less calls skipped');
{
  const fxFlip = makeFixtureRoot(undefined);
  seedBindingH(fxFlip, NSH.sessionId);
  stageMemoryH(fxFlip);
  resetSpy();
  const appliedFlip = applyWithCtx(fxFlip);
  const hookFlip = appliedFlip.listeners['llm/stream'][0];
  const cannedFlip = { chunks: ['flip'] };
  const reqFlip = liveRequestH(NSH.sessionId);
  hookFlip(reqFlip, () => cannedFlip);
  check(observeCalls === 0, 'OFF sighting performs no work');
  fs.writeFileSync(path.join(fxFlip.root, 'config', 'routing-policy.json'), JSON.stringify({ version: 3, contextCompiler: { shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' } }));
  hookFlip(reqFlip, () => cannedFlip);
  check(observeCalls === 1, 'later eligible pass over the same request still observes once');
  hookFlip(reqFlip, () => cannedFlip);
  check(observeCalls === 1, 'observed objects never re-observe');
}
}


section('C07H-B COMPOSITION HARNESS (real isolation + integrity + shadow in one waterfall)');
async function composedRun(fx, requests, opts) {
  const o = opts || {};
  const previousHome = process.env.DSH_HOME;
  const previousRoot = process.env.AIH_INSTALL_ROOT;
  process.env.DSH_HOME = path.join(fx.root, 'data');
  process.env.AIH_INSTALL_ROOT = fx.root;
  try {
    const ctx = createPresetCtx();
    const { installModelSelection } = await import('file:///home/kaloyan/.local/share/nexus/app/node_modules/@deepseek-ai/dsh-agent/lib/index.js');
    installModelSelection(ctx, { current: { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, assembled: undefined });
    muse.apply(ctx);
    integrity.apply(ctx);
    const installed = host.installCompilerShadowObserver(ctx, {
      installRoot: fx.root,
      bindingsPath: path.join(fx.root, 'data', 'routing', 'session-bindings.json'),
      log: o.log || (() => {}),
      adapterModule: o.adapterModule,
    });
    if (installed.installed !== true) throw new Error('shadow install failed in harness');
    // The harness invokes the terminal tail with no arguments, so record
    // what the terminal would receive with an innermost listener (still
    // inside the shadow + integrity wrappers, exactly where the adapter
    // sits in production).
    const seen = [];
    ctx.on('llm/stream', (payload, next) => {
      seen.push(payload);
      return next();
    });
    const terminal = () => ({ cannedChunks: ['host-stub-ok'] });
    const outputs = [];
    for (const request of requests) {
      outputs.push(await waterfall(ctx, 'llm/stream', request, terminal));
    }
    return { seen, outputs };
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot;
  }
}



section('C07H-U HOST UNIT (policy, readers, live derivation)');
{
  // Policy resolution across the closed world.
  const fxNone = makeFixtureRoot(undefined);
  check(host.resolveShadowPolicyV2({ installRoot: fxNone.root }).mode === 'off', 'absent section resolves off');
  const fxBad = makeFixtureRoot('not-an-object');
  check(host.resolveShadowPolicyV2({ installRoot: fxBad.root }).mode === 'off', 'non-object section resolves off');
  const fxMode = makeFixtureRoot({ shadowMode: 'active' });
  check(host.resolveShadowPolicyV2({ installRoot: fxMode.root }).mode === 'off', 'no active mode in the policy file');
  const fxNoBudget = makeFixtureRoot({ shadowMode: 'observe' });
  const noBudget = host.resolveShadowPolicyV2({ installRoot: fxNoBudget.root });
  check(noBudget.mode === 'observe' && noBudget.valid === false && noBudget.reason === 'shadow-policy-budget-required', 'observe without budget is invalid, never guessed');
  const fxBadBudget = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 10, target: 99 }, tokenizer: 'logical-codepoint-v1' });
  check(host.resolveShadowPolicyV2({ installRoot: fxBadBudget.root }).valid === false, 'target above hardMax rejected');
  const fxBadTok = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 8000, target: 6000 }, tokenizer: 'model-tokenizer-x' });
  const badTok = host.resolveShadowPolicyV2({ installRoot: fxBadTok.root });
  check(badTok.valid === false && badTok.reason === 'shadow-policy-tokenizer-unknown', 'unknown tokenizer fails closed (no silent model claim)');
  const fxGood = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  const good = host.resolveShadowPolicyV2({ installRoot: fxGood.root });
  check(good.mode === 'observe' && good.valid === true && good.budget.hardMax === 12000, 'valid observe policy resolves');
  check(host.resolveShadowPolicyV2({ installRoot: '/nonexistent-root-xyz' }).mode === 'off', 'unreadable policy fails closed to off');
  check(host.resolveShadowPolicyV2(null).mode === 'off', 'missing input fails closed to off');
  // Memory dir charset guard (path traversal can never escape).
  check(host.shadowMemoryDirForV2('/ws', '../evil') === null, 'dotdot taskId rejected');
  check(host.shadowMemoryDirForV2('/ws', 'a/b') === null, 'slash taskId rejected');
  check(host.shadowMemoryDirForV2('/ws', '') === null, 'empty taskId rejected');
  check(host.shadowMemoryDirForV2('/ws', NSH.taskId) === path.join('/ws', '.ai-harness', 'ccv2', NSH.taskId), 'well-formed task dir resolves');
  // Generation listing.
  check(host.listCheckpointGenerationsV2('/nonexistent-dir-xyz') === null, 'missing checkpoints dir lists null');
  const fxMem = makeFixtureRoot(undefined);
  seedBindingH(fxMem, NSH.sessionId);
  const staged = stageMemoryH(fxMem);
  void staged;
  const memDir = path.join(fxMem.workspace, '.ai-harness', 'ccv2', NSH.taskId);
  check(JSON.stringify(host.listCheckpointGenerationsV2(path.join(memDir, 'checkpoints'))) === '[1]', 'generation listing finds cp-000001.json');
  // Sealed-preferred read: unsealed-valid file accepted through frozen read.
  const readBack = host.readSealedCheckpointForTaskV2(memDir);
  check(readBack.sealed !== null && readBack.sealed.checkpointId !== undefined, 'staged checkpoint reads back with identity');
  check(readBack.sealed.snapshot.revisionDigest !== null, 'staged checkpoint snapshot-bound');
  // Revision re-read is the deterministic staleness signal.
  const rev1 = host.readSealedRevisionForTaskV2(memDir);
  check(rev1 === readBack.sealed.snapshot.revisionDigest, 'revision reader binds the sealed digest');
  // Live derivation units.
  const msgs = liveRequestH(NSH.sessionId).messages;
  const pairs = host.pairLiveToolTransactionsV2(clone(msgs));
  check(pairs.length === 1 && pairs[0].callId === 'call-h7' && pairs[0].balanced === true, 'settled live transaction pairs balanced');
  check(host.derivePendingProtocolV2(clone(msgs)) === null, 'settled tail claims no open protocol');
  const openMsgs = [clone(msgs[0]), clone(msgs[1])];
  const pending = host.derivePendingProtocolV2(openMsgs);
  check(pending !== null && pending.callId === 'call-h7', 'dangling tail call detected as open protocol');
  const turn = host.extractLiveCurrentTurnV2(clone(msgs));
  check(turn.turn !== null && turn.turn.text === TURN_TEXT, 'current turn extracted from typed text blocks');
  check(host.extractLiveCurrentTurnV2([]).turn === null, 'empty messages skip the turn');
  // Installer dep validation never throws.
  check(host.installCompilerShadowObserver(null, {}).installed === false, 'null ctx rejected');
  check(host.installCompilerShadowObserver({ on: () => {} }, {}).installed === false, 'missing deps rejected');
  // Sealed-preferred read: a minimal sealed build is accepted first.
  const sealWs = fs.mkdtempSync(path.join(os.tmpdir(), 'c07h-sealws-'));
  const sealNS = { taskId: 'TASK-SEAL', taskInstanceId: 'ti_seal_1', sessionId: 'sess-seal', workspaceId: sealWs, repositoryId: 'r', checkoutId: 'c' };
  const sealInput = { taskId: sealNS.taskId, taskInstanceId: sealNS.taskInstanceId, sessionId: sealNS.sessionId, workspaceId: sealWs, repositoryId: 'r', checkoutId: 'c', generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null, createdAtUtc: '2026-09-26T10:00:00.000Z', objective: { text: 'Seal probe.', status: 'in-progress' }, requirements: [], constraints: [], progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'm', remainingMilestones: [] }, decisions: [], repository: { repositoryId: 'r', checkoutId: 'c', headCommit: 'a', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null }, evidenceRefs: [], failures: { activeFailures: [], rejectedHypotheses: [], retryState: { attemptCount: 0, nextRetryAtUtc: null, note: 'n' } }, verification: { outcomes: [] }, continuation: { nextAction: 'N.', unresolvedQuestions: [], recentUserIntent: 'I.' } };
  sealInput.snapshotToken = snapshotMod.capture({ taskId: sealNS.taskId, taskInstanceId: sealNS.taskInstanceId, sessionId: sealNS.sessionId, workspaceId: sealWs, repositoryId: 'r', checkoutId: 'c', generation: 1, safePointBoundarySeq: 9, sessionRevision: 5, taskRevision: snapshotMod.deriveTaskRevision({ objective: sealInput.objective, requirements: [], constraints: [], progress: sealInput.progress, decisions: [], failures: { activeFailures: [], rejectedHypotheses: [] }, verification: sealInput.verification, continuation: sealInput.continuation }), repositoryRevision: { headCommit: 'a', indexDigest: sha('i'), worktreeDigest: sha('w') }, runtimeRevision: { runtimeSnapshotSeq: 1 } }, '2026-09-26T10:00:00.000Z');
  const sealProv = { 'objective.text': { fieldKind: 'task-objective', sourceKind: 'controller', sourceRefs: ['task-state:rev9'] }, 'repository': { fieldKind: 'repository-fact', sourceKind: 'repository', sourceRefs: ['git:HEAD:a'] }, 'continuation.nextAction': { fieldKind: 'next-action', sourceKind: 'controller', sourceRefs: ['task-state:rev9'] }, 'continuation.recentUserIntent': { fieldKind: 'user-intent', sourceKind: 'user', sourceRefs: ['user:session-event:12'] } };
  const sealedBuilt = trust.buildSealedCheckpointV2(sealInput, sealProv, { sealedAtUtc: '2026-09-26T10:05:00.000Z' });
  const sealMemDir = path.join(sealWs, '.ai-harness', 'ccv2', sealNS.taskId);
  const sealCpDir = path.join(sealMemDir, 'checkpoints');
  trust.persistSealedCheckpointV2(sealCpDir, sealedBuilt);
  const sealRead = host.readSealedCheckpointForTaskV2(sealMemDir);
  check(sealRead.sealed !== null && sealRead.sealed.checkpointId === sealedBuilt.checkpointId, 'sealed build preferred on read');
  check(host.readSealedRevisionForTaskV2(sealMemDir) === sealedBuilt.checkpoint.snapshot.revisionDigest, 'sealed revision binds');

}

(async () => {
section('C07H-B1 OBSERVE + EQUALITY + EXACTLY-ONCE (composition waterfall)');
{
  const fx = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  seedBindingH(fx, NSH.sessionId);
  seedRoutingStateH(fx, 'meta-model-api', 'muse-spark-1.3-contributor');
  stageMemoryH(fx);
  const telemetries = [];
  resetSpy();
  const r1 = liveRequestH(NSH.sessionId);
  const r2 = liveRequestH(NSH.sessionId, 'Second host turn.');
  const r3 = liveRequestH(NSH.sessionId, 'Third host turn with unicode 🎉.');
  const before = [snapshotOf(r1), snapshotOf(r2), snapshotOf(r3)];
  const { seen, outputs } = await composedRun(fx, [r1, r2, r3], { log: (e) => telemetries.push(e) });
  check(outputs.length === 3 && outputs.every((o) => o && o.cannedChunks[0] === 'host-stub-ok'), 'stub terminal served every request');
  check(seen.length === 3 && seen[0] === r1 && seen[1] === r2 && seen[2] === r3, 'terminal received the original request objects');
  check([snapshotOf(r1), snapshotOf(r2), snapshotOf(r3)].join('|') === before.join('|'), 'ON leaves all live requests byte-identical');
  check(observeCalls === 3, 'exactly one observation per inference request');
  check(telemetries.length === 3, 'exactly one telemetry line per observation, no duplicates');
  check(telemetries.every((t) => t.event === 'ccv2-compiler-shadow-observed' && t.shadowStatus === 'MATCHED' && t.promotionBlocker === false), 'every observation MATCHED without blockers');
  // OFF run over identical inputs: canonical equality + identical stub view.
  resetSpy();
  const fxOff = makeFixtureRoot(undefined);
  seedBindingH(fxOff, NSH.sessionId);
  seedRoutingStateH(fxOff, 'meta-model-api', 'muse-spark-1.3-contributor');
  const q1 = liveRequestH(NSH.sessionId);
  const { seen: seenOff, outputs: outputsOff } = await composedRun(fxOff, [q1], { log: () => { throw new Error('no telemetry when off'); } });
  check(observeCalls === 0, 'OFF performs zero adapter calls on the composed path');
  check(snapshotOf(q1) === before[0], 'OFF request == ON request (canonical equality)');
  check(JSON.stringify(outputsOff[0]) === JSON.stringify(outputs[0]), 'same stub response OFF == ON');
  check(seenOff[0].provider === 'meta-model-api' && seenOff[0].model === 'muse-spark-1.3-contributor', 'routing target preserved on the composed path');
}

section('C07H-B2 FAILURE ISOLATION FROM THE WIRED PATH');
{
  const fx = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  seedBindingH(fx, NSH.sessionId);
  seedRoutingStateH(fx, 'meta-model-api', 'muse-spark-1.3-contributor');
  const staged = stageMemoryH(fx);
  void staged;
  const telemetries = [];
  const runOne = async (request, opts) => {
    resetSpy();
    const { seen, outputs } = await composedRun(fx, [request], { log: (e) => telemetries.push(e), adapterModule: opts && opts.adapterModule });
    return { seen, outputs };
  };
  // Foreign staged memory (valid unsealed file, foreign triple) -> skip
  // closed on namespace isolation (no adapter call, request fine).
  const foreignCp = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId, 'checkpoints', 'cp-000001.json');
  const goodBytes = fs.readFileSync(foreignCp, 'utf8');
  const foreignRaw = checkpointInputH(fx.workspace);
  foreignRaw.taskId = 'TASK-FOREIGN';
  foreignRaw.taskInstanceId = 'task_foreign_0001';
  foreignRaw.sessionId = 'sess-foreign';
  // NOTE: snapshotTokenForH binds the NSH triple; mint the foreign token
  // inline so the staged file is fully valid for its own triple.
  const foreignToken = snapshotMod.capture({
    taskId: 'TASK-FOREIGN', taskInstanceId: 'task_foreign_0001', sessionId: 'sess-foreign',
    workspaceId: fx.workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: foreignRaw.objective, requirements: foreignRaw.requirements, constraints: foreignRaw.constraints,
      progress: foreignRaw.progress, decisions: foreignRaw.decisions,
      failures: { activeFailures: foreignRaw.failures.activeFailures, rejectedHypotheses: foreignRaw.failures.rejectedHypotheses },
      verification: foreignRaw.verification, continuation: foreignRaw.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c07h:index'), worktreeDigest: sha('c07h:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
  const foreignValid = checkpoint.buildCheckpointV2(Object.assign({}, foreignRaw, { snapshotToken: foreignToken }));
  fs.rmSync(foreignCp);
  checkpoint.persistCheckpointV2(path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId, 'checkpoints'), { checkpoint: foreignValid.checkpoint, serialized: foreignValid.serialized });
  {
    const r = liveRequestH(NSH.sessionId);
    const before = snapshotOf(r);
    const { seen, outputs } = await runOne(r);
    check(observeCalls === 0, 'foreign staged memory skips closed (no adapter call)');
    check(snapshotOf(r) === before && outputs[0].cannedChunks[0] === 'host-stub-ok', 'request still served on skip');
    check(seen[0] === r, 'terminal still receives the original request');
  }
  fs.writeFileSync(foreignCp, goodBytes);
  // Tampered staged decision (schema-valid, binding broken) -> the
  // frozen C02/C05 authorities throw INSIDE the adapter: CANDIDATE_FAILED
  // report, request fine.
  const decFile = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId, 'tier-decisions.json');
  const decBytes = fs.readFileSync(decFile, 'utf8');
  const decDoc = JSON.parse(decBytes);
  decDoc[decDoc.length - 1].contentHash = sha('tampered-by-c07h');
  fs.writeFileSync(decFile, JSON.stringify(decDoc));
  {
    resetSpy();
    telemetries.length = 0;
    const r = liveRequestH(NSH.sessionId);
    const before = snapshotOf(r);
    const { outputs } = await runOne(r);
    check(observeCalls === 1, 'invalid candidate still reaches a bounded adapter outcome');
    check(telemetries.length === 1 && telemetries[0].shadowStatus === 'CANDIDATE_FAILED' && telemetries[0].promotionBlocker === true, 'tamper yields CANDIDATE_FAILED + blocker in telemetry');
    check(snapshotOf(r) === before && outputs[0].cannedChunks[0] === 'host-stub-ok', 'tamper never fails inference');
  }
  fs.writeFileSync(decFile, decBytes);
  // Throwing adapter override (host-level defense) -> request proceeds.
  {
    const r = liveRequestH(NSH.sessionId);
    const before = snapshotOf(r);
    const { outputs } = await runOne(r, { adapterModule: { observeCompilerShadowV2: () => { throw new Error('adapter blew up'); } } });
    check(snapshotOf(r) === before && outputs[0].cannedChunks[0] === 'host-stub-ok', 'adapter throw cannot fail inference');
  }
  // Throwing telemetry sink -> request proceeds (adapter isolates too).
  {
    resetSpy();
    const r = liveRequestH(NSH.sessionId);
    const before = snapshotOf(r);
    const { outputs } = await composedRun(fx, [r], { log: () => { throw new Error('sink down'); } });
    check(observeCalls === 1, 'observation computed despite sink failure');
    check(snapshotOf(r) === before && outputs[0].cannedChunks[0] === 'host-stub-ok', 'sink failure never fails the request');
  }
  // Missing decisions file -> skip closed.
  {
    const decPath = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId, 'tier-decisions.json');
    const decBytes = fs.readFileSync(decPath, 'utf8');
    fs.rmSync(decPath);
    resetSpy();
    const r = liveRequestH(NSH.sessionId);
    const before = snapshotOf(r);
    const { outputs } = await runOne(r);
    check(observeCalls === 0, 'missing decisions skip closed');
    check(snapshotOf(r) === before && outputs[0].cannedChunks[0] === 'host-stub-ok', 'request served on skip');
    fs.writeFileSync(decPath, decBytes);
  }
}

section('C07H-B3 ROUTING COMPATIBILITY + DURABLE IMMUTABILITY + NO C08');
{
  const fx = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  seedBindingH(fx, NSH.sessionId);
  seedRoutingStateH(fx, 'meta-model-api', 'muse-spark-1.3-contributor');
  stageMemoryH(fx);
  const hashTree = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else out.push(entry.name + ':' + sha(fs.readFileSync(p)));
      }
    };
    walk(fx.workspace);
    walk(path.join(fx.root, 'data', 'routing'));
    return out.sort().join('|');
  };
  const beforeTree = hashTree();
  resetSpy();
  const telemetries = [];
  const r = liveRequestH(NSH.sessionId);
  const { seen } = await composedRun(fx, [r], { log: (e) => telemetries.push(e) });
  check(seen[0].provider === 'meta-model-api' && seen[0].model === 'muse-spark-1.3-contributor', 'controller route untouched by shadow');
  check(seen[0].reasoningEffort === 'xhigh' && seen[0].maxTokens === 32768, 'request controls untouched');
  check(JSON.stringify(seen[0].messages) === JSON.stringify(clone(r).messages), 'legacy messages untouched (no compiled prompt rendered)');
  check(JSON.stringify(seen[0].tools) === JSON.stringify(clone(r).tools), 'tool definitions untouched');
  check(!('cache_control' in seen[0]) && !('cacheControl' in seen[0]), 'no cache controls inserted');
  check(hashTree() === beforeTree, 'durable truth (workspace + routing state) unchanged');
  check(telemetries.length === 1 && telemetries[0].disposable === true, 'telemetry marked non-authoritative');
}
section('C07H-C REAL DSH LOOP (dispatch scope + normal lifecycle)');
async function loopBoot(policySection) {
  const fx = makeFixtureRoot(policySection);
  seedBindingH(fx, NSH.sessionId);
  seedRoutingStateH(fx, 'flash-max-direct', 'deepseek-v4-flash');
  stageMemoryH(fx);
  const telemetries = [];
  const runtimeRoot = process.env.NEXUS_RUNTIME_ROOT || path.join(os.homedir(), '.local', 'share', 'nexus');
  const appRequire = createRequire(path.join(runtimeRoot, 'app', 'package.json'));
  const cordisMod = appRequire('@deepseek-ai/cordis');
  const Context = cordisMod.Context;
  const llmMod = appRequire('@deepseek-ai/dsh-llm');
  const LlmRuntime = llmMod.default;
  const createUserMessage = llmMod.createUserMessage;
  const SessionStore = appRequire('@deepseek-ai/dsh-session').default;
  const SystemPrompt = appRequire('@deepseek-ai/dsh-system-prompt').default;
  const ToolRuntime = appRequire('@deepseek-ai/dsh-tools').default;
  const agentPackage = appRequire('@deepseek-ai/dsh-agent');
  const AgentLoop = appRequire('@deepseek-ai/dsh-agent-loop').default;
  const dshAgentLib = path.join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh-agent', 'lib', 'index.js');
  const { pathToFileURL } = await import('node:url');
  const { installModelSelection } = await import(pathToFileURL(dshAgentLib).href);
  const previousHome = process.env.DSH_HOME;
  const previousRoot = process.env.AIH_INSTALL_ROOT;
  process.env.DSH_HOME = path.join(fx.root, 'data');
  process.env.AIH_INSTALL_ROOT = fx.root;
  let ctx = null;
  try {
    ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SystemPrompt, { persona: 'c07h loop probe' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(agentPackage.default);
    await ctx.plugin(AgentLoop, { agents: [] });
    integrity.apply(ctx);
    const installed = host.installCompilerShadowObserver(ctx, {
      installRoot: fx.root,
      bindingsPath: path.join(fx.root, 'data', 'routing', 'session-bindings.json'),
      log: (entry) => telemetries.push(entry),
    });
    if (installed.installed !== true) throw new Error('shadow install failed in real loop');
    const agent = ctx.agentLoop.create(NSH.sessionId, { provider: 'flash-max-direct', model: 'deepseek-v4-flash' });
    installModelSelection(agent.ctx, { current: { provider: 'flash-max-direct', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, assembled: undefined });
    let terminalSeen = null;
    ctx.on('llm/stream', (options) => {
      terminalSeen = options;
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'C07H loop says hi.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'C07H loop says hi.' } };
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 7 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    });
    const idle = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('c07h loop probe timed out')), 45000);
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve(); }
      });
    });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'C07H live loop turn.' }], source: { kind: 'user' } }));
    await idle;
    if (!terminalSeen) throw new Error('terminal stub never received the loop request');
    return { fx, telemetries, terminalSeen };
  } finally {
    if (ctx) await ctx.fiber.dispose().catch(() => {});
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot;
  }
}
function maskIds(value) {
  if (Array.isArray(value)) return value.map(maskIds);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = key === 'id' && typeof value[key] === 'string' ? '#masked-id' : maskIds(value[key]);
    }
    return out;
  }
  return value;
}
{
  resetSpy();
  const off = await loopBoot(undefined);
  check(observeCalls === 0, 'real loop OFF performs zero adapter calls');
  check(off.telemetries.length === 0, 'real loop OFF emits zero telemetry');
  resetSpy();
  const on = await loopBoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  check(observeCalls === 1, 'normal loop turn invokes the adapter exactly once');
  check(on.telemetries.length === 1 && on.telemetries[0].event === 'ccv2-compiler-shadow-observed', 'real loop emits one telemetry line');
  check(on.telemetries[0].shadowStatus === 'MATCHED' && on.telemetries[0].promotionBlocker === false, 'loop observation MATCHED without blockers');
  const maskedOff = JSON.stringify(maskIds(JSON.parse(JSON.stringify(off.terminalSeen))));
  const maskedOn = JSON.stringify(maskIds(JSON.parse(JSON.stringify(on.terminalSeen))));
  check(maskedOff === maskedOn, 'OFF request == ON request through the real loop (volatile ids masked)');
  const roles = (req) => req.messages.map((m) => m.role).join(',');
  check(roles(off.terminalSeen) === roles(on.terminalSeen) && off.terminalSeen.messages.length === on.terminalSeen.messages.length, 'no structural drift hidden by id masking');
  check(on.terminalSeen.provider === 'flash-max-direct' && on.terminalSeen.model === 'deepseek-v4-flash', 'loop route preserved');
  fs.rmSync(off.fx.root, { recursive: true, force: true });
  fs.rmSync(off.fx.workspace, { recursive: true, force: true });
  fs.rmSync(on.fx.root, { recursive: true, force: true });
  fs.rmSync(on.fx.workspace, { recursive: true, force: true });
}
console.log('\nC07H host suite (async sections): ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });

function shadowLogLines(fx) {
  const p = path.join(fx.root, 'data', 'logs', 'aih-controller.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.indexOf('ccv2-compiler-shadow-observed') !== -1);
}
