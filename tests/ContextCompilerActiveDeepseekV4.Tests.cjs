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
const counterMod = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
const capMod = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const regMod = require(path.join(repoRoot, 'config', 'ContextTokenizerRegistryV2.cjs'));
const activeMod = require(path.join(repoRoot, 'config', 'ContextCompilerActiveV2.cjs'));
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
const NSH = Object.freeze({ taskId: 'TASK-C08D-A', taskInstanceId: 'task_c08d_a_0001', sessionId: 'sess-c08d-a', repositoryId: 'repo-c08d', checkoutId: 'co-c08d' });
const TURN_TEXT = 'Run the deepseek acceptance turn with real counting.';
const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';
const PROVIDER = 'flash-max-direct';
const MODEL = 'deepseek-v4-flash';
function checkpointInputH(workspace) {
  return {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove real-provider activation.', status: 'in-progress' },
    requirements: [{ id: 'REQ-D1', text: 'Deepseek route compiles with real tokens.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H live', remainingMilestones: [] },
    decisions: [{ id: 'D-D1', statement: 'Fallback stays safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-D1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt C08H.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C08H.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08d:index'), worktreeDigest: sha('c08d:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
}
function makeFixtureRoot(policySection) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c08d-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c08d-ws-'));
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
    preset: 'aih-engineering', engine: 'dual',
  };
  fs.writeFileSync(p, JSON.stringify(doc));
}
function stageMemoryH(fx) {
  const raw = checkpointInputH(fx.workspace);
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: snapshotTokenForH(raw) }));
  const memDir = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId);
  const cpDir = path.join(memDir, 'checkpoints');
  const persisted = checkpoint.persistCheckpointV2(cpDir, { checkpoint: built.checkpoint, serialized: built.serialized });
  const inlinePage = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      workspaceId: fx.workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = inlinePage('decision', 'agent', ['decision:H9'], [40], 'Historical host note for framing audit. '.repeat(30));
  const TOOL = inlinePage('tool-result', 'tool', ['tool-event:call-d7'], [7, 8], 'exit 0 settled deepseek tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
  const CP = persisted.checkpoint;
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-D1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-D1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-D1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  fs.writeFileSync(path.join(memDir, 'tier-decisions.json'), JSON.stringify(decisions));
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([{ pageId: TOOL.id, callId: 'call-d7', callSeq: 7, resultSeq: 8 }]));
  return { CP, COLD, TOOL, memDir };
}
function liveRequestH(sessionId, turnText, extra) {
  const base = {
    provider: PROVIDER, model: MODEL, reasoningEffort: 'max', maxTokens: 2048,
    system: SYSTEM_TEXT,
    messages: [
      { id: 'msg-u1', role: 'user', content: [{ type: 'text', text: turnText || TURN_TEXT }], source: { kind: 'user' } },
    ],
    tools: [],
    routingAuthority: { source: 'controller', target: { provider: PROVIDER, model: MODEL } },
    sessionId, metadata: { taskId: NSH.taskId, turnId: 'live' },
  };
  return Object.assign(clone(base), extra || {});
}
function bindingsPathOf(fx) { return path.join(fx.root, 'data', 'routing', 'session-bindings.json'); }
function snapshotOf(request) { return JSON.stringify(checkpoint.canonicalize(clone(request))); }
function activePolicy(fx) { return host.resolveActivePolicyV2({ installRoot: fx.root }); }
function wipe(fx) { fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true }); }
section('C08H-REAL-1 ACTIVE SUCCESS ON THE REAL ROUTE (framed proof)');
{
  const fx = makeFixtureRoot({ mode: 'active' });
  seedBindingH(fx, NSH.sessionId);
  stageMemoryH(fx);
  const request = liveRequestH(NSH.sessionId);
  const before = snapshotOf(request);
  let telemetries = 0;
  const outcome = host.applyActiveProjectionV2({
    request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
    telemetrySink: () => { telemetries += 1; },
  });
  check(outcome.mode === 'CCV2_COMPILED' && outcome.performed === true, 'real route ACTIVE compiles');
  check(telemetries === 1, 'one compiler execution (single telemetry)');
  check(snapshotOf(request) === before, 'source request untouched');
  const d = outcome.decision;
  check(d.coverage.mandatoryCovered === d.coverage.mandatoryTotal && d.coverage.mandatoryTotal > 0, 'mandatory coverage mechanically proven');
  check(d.coverage.currentTurnCovered === true && d.coverage.balancedToolTransactions >= 1, 'turn + settled tool history covered');
  check(outcome.telemetry.tokenizerFingerprint === regMod.TOKENIZER_FINGERPRINT_V1, 'verified real fingerprint in telemetry');
  check(outcome.framed !== null && outcome.framed.framedInputTokens > 0, 'framed accounting attached');
  check(outcome.framed.framingRevision === regMod.FRAMING_REVISION_V1, 'framing revision bound');
  check(outcome.framed.framedInputTokens + 2048 <= 131072, 'framed input + output reserve fits the real window (' + outcome.framed.framedInputTokens + ')');
  check(outcome.framed.framedMarkerTokens >= 3, 'template markers counted');
  const derived = outcome.request;
  check(derived.provider === PROVIDER && derived.model === MODEL && derived.maxTokens === 2048, 'route + output allowance unchanged');
  check(derived.system === SYSTEM_TEXT && JSON.stringify(derived.tools) === '[]', 'host system + tool-free schema preserved');
  const legacyIds = request.messages.map((m) => m.id);
  check(legacyIds.every((id) => derived.messages.map((m) => m.id).indexOf(id) === -1), 'no legacy bulk survives');
  let turnHits = 0;
  for (const m of derived.messages) {
    for (const b of m.content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && sha(b.text) === sha(TURN_TEXT)) turnHits += 1;
    }
  }
  check(turnHits === 1, 'current turn exactly once, byte-exact');
  const blob = JSON.stringify(outcome.telemetry);
  check(blob.indexOf(TURN_TEXT) === -1 && blob.indexOf(SYSTEM_TEXT) === -1, 'telemetry secret-safe');
  wipe(fx);
}
section('C08H-REAL-2 PROVIDER SCHEMA (openai-completions validity)');
{
  const fx = makeFixtureRoot({ mode: 'active' });
  seedBindingH(fx, NSH.sessionId);
  stageMemoryH(fx);
  const outcome = host.applyActiveProjectionV2({
    request: liveRequestH(NSH.sessionId), policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
  });
  check(outcome.mode === 'CCV2_COMPILED', 'baseline compiles');
  const wire = {
    model: outcome.request.model,
    messages: outcome.request.messages.map((m) => ({ role: m.role, content: m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') })),
    tools: outcome.request.tools,
    max_tokens: outcome.request.maxTokens,
  };
  const rolesOk = wire.messages.every((m) => (m.role === 'system' || m.role === 'user') && typeof m.content === 'string' && m.content !== '');
  check(rolesOk === true, 'system/user roles with string content');
  check(wire.messages[wire.messages.length - 1].role === 'user' && wire.messages[wire.messages.length - 1].content === TURN_TEXT, 'final user message is the byte-exact turn');
  const historyToolCalls = wire.messages.slice(0, -1).filter((m) => m.role !== 'system');
  check(historyToolCalls.length === 0, 'history carries no live tool protocol (context only)');
  const blob = JSON.stringify(wire.messages);
  check(blob.indexOf('tool_calls') === -1 && blob.indexOf('tool_call') === -1, 'no provider control structures in history');
  check(wire.model === MODEL && wire.max_tokens === 2048 && Array.isArray(wire.tools), 'model/output/tools fields native');
  wipe(fx);
}
section('C08H-REAL-3 OFF / OBSERVE / ACTIVE ON THE SAME ROUTE');
{
  const runMode = (policySection, seed) => {
    const fx = makeFixtureRoot(policySection);
    if (seed !== false) { seedBindingH(fx, NSH.sessionId); stageMemoryH(fx); }
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
    });
    const result = { out, request, fx };
    return result;
  };
  const off = runMode(undefined);
  check(off.out.mode === 'LEGACY' && off.out.request === off.request, 'OFF: identical legacy reference');
  wipe(off.fx);
  const obs = runMode({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  check(obs.out.mode === 'LEGACY' && obs.out.request === obs.request, 'OBSERVE: legacy request, no active projection');
  wipe(obs.fx);
  const act = runMode({ mode: 'active' });
  check(act.out.mode === 'CCV2_COMPILED', 'ACTIVE: real compiled projection');
  for (const item of [off, obs, act]) {
    check(item.request.provider === PROVIDER && item.request.model === MODEL, 'routing identical across modes');
  }
  check(shadowHost.resolveShadowPolicyV2({ installRoot: act.fx.root }).mode === 'off', 'no second shadow compile under active');
  wipe(act.fx);
}
section('C08H-REAL-4 FALLBACKS ON THE REAL ROUTE (deterministic, no network)');
{
  const setup = (policySection) => {
    const fx = makeFixtureRoot(policySection);
    seedBindingH(fx, NSH.sessionId);
    stageMemoryH(fx);
    return fx;
  };
  const stripRegistry = (fx) => {
    const regPath = path.join(fx.root, 'config', 'model-registry.json');
    fs.writeFileSync(regPath, JSON.stringify({ schemaVersion: 1, models: [{ id: 'other-only', provider: 'other-direct', model: 'other-model', contextWindow: 8000 }] }));
  };
  {
    const fx = setup({ mode: 'active' });
    stripRegistry(fx);
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx),
    });
    check(out.mode === 'LEGACY' && out.request === request, 'capability ineligible on the same route still serves legacy');
    wipe(fx);
  }
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId, TURN_TEXT, { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro' });
    request.routingAuthority = { source: 'controller', target: { provider: 'deepseek-pro-direct', model: 'deepseek-v4-pro' } };
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
    });
    check(out.mode === 'LEGACY' && out.request === request && out.fallbackReason === 'active-tokenizer-unavailable', 'unregistered near-miss model falls back without fuzzy reuse');
    wipe(fx);
  }
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId, TURN_TEXT, { maxTokens: 130000 });
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
    });
    check(out.mode === 'LEGACY' && out.request === request, 'physical overflow falls back (never truncates)');
    wipe(fx);
  }
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
      getCurrentRevision: () => sha('moved-revision'),
    });
    check(out.mode === 'LEGACY' && out.fallbackReason === 'active-snapshot-stale', 'mid-request state move discards the render');
    wipe(fx);
  }
}
console.log(String.fromCharCode(10) + 'ContextCompilerActiveDeepseekV4 suite: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
