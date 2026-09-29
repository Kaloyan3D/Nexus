'use strict';
/**
 * ContextCompilerActiveHostV2.Tests.cjs - CCV2-C08 host activation proof.
 *
 * Proves against the REAL production authorities
 * (config/ContextCompilerActiveHostV2.cjs + Active + Capability +
 * Renderer + frozen C01->C06 + C07H readers + AihController.apply):
 * unified OFF/OBSERVE/ACTIVE policy matrix with upgrade safety;
 * ACTIVE success replaces the bulk projection atomically (single
 * mode, no duplication, identity preserved); every failure returns
 * the identical legacy reference; the real apply() installs the
 * wrapper without changing default behavior; active mode runs zero
 * shadow work (one compiler execution).
 */
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
const STUB_ROUTES = [{ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 60000 }];

const NSH = Object.freeze({
  taskId: 'TASK-C08H-A',
  taskInstanceId: 'task_c08h_a_0001',
  sessionId: 'sess-c08h-a',
  repositoryId: 'repo-c08h',
  checkoutId: 'co-c08h',
});
const TURN_TEXT = 'Ship C08H now.';
const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';

function checkpointInputH(workspace) {
  return {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove production active wiring.', status: 'in-progress' },
    requirements: [{ id: 'REQ-H1', text: 'Active replaces bulk projection.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H wiring', remainingMilestones: [] },
    decisions: [{ id: 'D-H1', statement: 'Fallback is safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-H1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Wire C08H.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C08H.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08h:index'), worktreeDigest: sha('c08h:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
}
function makeFixtureRoot(policySection) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c08h-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c08h-ws-'));
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
  const COLD = inlinePage('decision', 'agent', ['decision:H9'], [40], 'Historical host note. '.repeat(30));
  const TOOL = inlinePage('tool-result', 'tool', ['tool-event:call-h7'], [7, 8], 'exit 0 settled host tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
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
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([{ pageId: TOOL.id, callId: 'call-h7', callSeq: 7, resultSeq: 8 }]));
  return { CP, COLD, TOOL, memDir };
}
function liveRequestH(sessionId, turnText, extra) {
  const base = {
    provider: 'stub-test', model: 'stub-model-v1', reasoningEffort: 'high', maxTokens: 2048,
    system: SYSTEM_TEXT,
    messages: [
      { id: 'msg-u1', role: 'user', content: [{ type: 'text', text: turnText || TURN_TEXT }], source: { kind: 'user' } },
      { id: 'msg-a1', role: 'assistant', content: [{ type: 'tool-call', name: 'run-tests', callId: 'call-h7' }], source: { kind: 'model', provider: 'stub-test', model: 'stub-model-v1' } },
      { id: 'msg-t1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-h7', content: [{ type: 'text', text: 'exit 0' }] }], source: { kind: 'tool', callId: 'call-h7' } },
    ],
    tools: [{ name: 'run-tests', description: 'Run the harness.' }],
    routingAuthority: { source: 'controller', target: { provider: 'stub-test', model: 'stub-model-v1' } },
    sessionId, metadata: { taskId: NSH.taskId, turnId: 'live' },
  };
  return Object.assign(clone(base), extra || {});
}
function bindingsPathOf(fx) { return path.join(fx.root, 'data', 'routing', 'session-bindings.json'); }
function snapshotOf(request) { return JSON.stringify(checkpoint.canonicalize(clone(request))); }
function activePolicy(fx) { return host.resolveActivePolicyV2({ installRoot: fx.root }); }

section('C08H-P POLICY MATRIX (single authority, upgrade-safe)');
{
  const fxNone = makeFixtureRoot(undefined);
  check(activePolicy(fxNone).mode === 'off' && activePolicy(fxNone).valid === true, 'absent section resolves off');
  const fxLegacy = makeFixtureRoot({ shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' });
  const legacy = activePolicy(fxLegacy);
  check(legacy.mode === 'observe' && legacy.valid === true, 'legacy observe preserved (never reinterpreted as active)');
  const fxActive = makeFixtureRoot({ mode: 'active' });
  const act = activePolicy(fxActive);
  check(act.mode === 'active' && act.valid === true, 'unified active honored');
  check(activePolicy(makeFixtureRoot({ mode: 'active', budget: { hardMax: 5, target: 5 } })).mode === 'off', 'active + legacy budget fails closed to off');
  check(activePolicy(makeFixtureRoot({ mode: 'active', tokenizer: 'logical-codepoint-v1' })).mode === 'off', 'active + logical tokenizer fails closed to off');
  check(activePolicy(makeFixtureRoot({ mode: 'turbo' })).mode === 'off', 'unknown mode fails closed to off');
  check(activePolicy(makeFixtureRoot({ shadowMode: 'active' })).mode === 'off', 'legacy key cannot smuggle active');
  check(activePolicy({ installRoot: '/nonexistent-root-xyz' }).mode === 'off', 'unreadable policy fails closed to off');
  // Shadow interplay: active mode performs ZERO shadow work (one compiler execution).
  const shadowInActive = shadowHost.resolveShadowPolicyV2({ installRoot: fxActive.root });
  check(shadowInActive.mode === 'off', 'C07 shadow resolves off under the unified active policy');
  const shadowInObserve = shadowHost.resolveShadowPolicyV2({ installRoot: fxLegacy.root });
  check(shadowInObserve.mode === 'observe', 'C07 shadow still observes under legacy observe policy');
  for (const fx of [fxNone, fxLegacy, fxActive]) { fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true }); }
}

section('C08H-A ACTIVE SUCCESS (atomic bulk replacement)');
{
  const fx = makeFixtureRoot({ mode: 'active' });
  seedBindingH(fx, NSH.sessionId);
  stageMemoryH(fx);
  const policy = activePolicy(fx);
  const request = liveRequestH(NSH.sessionId);
  const before = snapshotOf(request);
  let telemetries = 0;
  const outcome = host.applyActiveProjectionV2({
    request, policy, installRoot: fx.root, bindingsPath: bindingsPathOf(fx),
    supportedRoutes: STUB_ROUTES, telemetrySink: () => { telemetries += 1; },
  });
  check(outcome.mode === 'CCV2_COMPILED' && outcome.performed === true && outcome.fallbackReason === null, 'active success returns the compiled mode');
  check(telemetries === 1, 'exactly one secret-safe telemetry emission');
  check(snapshotOf(request) === before, 'source request untouched (immutable source)');
  const derived = outcome.request;
  check(Object.isFrozen(derived) === true, 'derived request frozen');
  check(derived.provider === 'stub-test' && derived.model === 'stub-model-v1' && derived.maxTokens === 2048, 'request identity: route + output allowance unchanged');
  check(derived.system === SYSTEM_TEXT, 'host-owned system prefix byte-identical');
  check(JSON.stringify(derived.tools) === JSON.stringify(request.tools), 'tool definitions byte-identical');
  check(JSON.stringify(derived.routingAuthority) === JSON.stringify(request.routingAuthority), 'routing authority byte-identical');
  check(derived.metadata.projectionMode === 'CCV2_COMPILED', 'typed single-mode marker on the derived request');
  // No legacy bulk survives: none of the legacy message ids remain.
  const legacyIds = request.messages.map((m) => m.id);
  const derivedIds = derived.messages.map((m) => m.id);
  check(legacyIds.every((id) => derivedIds.indexOf(id) === -1), 'legacy bulk region fully removed (no duplication)');
  // Current turn exactly once, byte-exact.
  const turnHash = sha(TURN_TEXT);
  let turnHits = 0;
  for (const m of derived.messages) {
    for (const b of m.content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && sha(b.text) === turnHash) turnHits += 1;
    }
  }
  check(turnHits === 1, 'current turn appears exactly once, byte-exact');
  // Physical over-budget proof through the production counter.
  const cap = capMod.createStubTestCapabilityV2({ provider: 'stub-test', model: 'stub-model-v1', maxContextTokens: 60000 });
  const finalInput = counterMod.countTextVerifiedV2(cap.tokenCounter, derived.system)
    + counterMod.countTextVerifiedV2(cap.tokenCounter, JSON.stringify(checkpoint.canonicalize(derived.messages)))
    + counterMod.countTextVerifiedV2(cap.tokenCounter, JSON.stringify(checkpoint.canonicalize(derived.tools)));
  check(finalInput + derived.maxTokens <= cap.maxContextTokens, 'physical input + output reserve fits the window (' + finalInput + ')');
  // Cache-layout integrity: stable system prefix untouched; compiled order = layout order.
  check(outcome.decision.render.segments.length === outcome.decision.layout.blocks.length, 'render realizes every layout block');
  const blob = JSON.stringify(outcome.telemetry);
  check(blob.indexOf(TURN_TEXT) === -1 && blob.indexOf(SYSTEM_TEXT) === -1, 'telemetry carries no prompt bytes');
  fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
}

section('C08H-F FALLBACK MATRIX (identical legacy reference back)');
{
  const setup = (policySection, seed) => {
    const fx = makeFixtureRoot(policySection);
    if (seed !== false) { seedBindingH(fx, NSH.sessionId); stageMemoryH(fx); }
    return fx;
  };
  // off/observe passthrough (zero compiler work, same reference).
  for (const [name, section] of [['off', undefined], ['observe-legacy', { shadowMode: 'observe', budget: { hardMax: 12000, target: 10000 }, tokenizer: 'logical-codepoint-v1' }]]) {
    const fx = setup(section);
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root,
      bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
    });
    check(out.mode === 'LEGACY' && out.request === request && out.performed === false, name + ' returns the identical legacy reference');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // tokenizer unavailable: real registry route, no stub registration.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId, TURN_TEXT, { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
    request.routingAuthority = { source: 'controller', target: { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' } };
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: repoRoot, bindingsPath: bindingsPathOf(fx),
    });
    check(out.mode === 'LEGACY' && out.request === request && out.fallbackReason === 'active-tokenizer-unavailable', 'real route without verified tokenizer falls back');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // unknown capability: unregistered stub pair.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId, TURN_TEXT, { provider: 'stub-test', model: 'stub-unknown' });
    request.routingAuthority = { source: 'controller', target: { provider: 'stub-test', model: 'stub-unknown' } };
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
    });
    check(out.fallbackReason === 'active-model-capability-unknown' && out.request === request, 'unknown pair falls back');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // no memory: binding without staged truth.
  {
    const fx = setup({ mode: 'active' }, false);
    seedBindingH(fx, NSH.sessionId);
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
    });
    check(out.fallbackReason === 'active-compiler-failed' && out.request === request, 'absent memory falls back (no invented candidate)');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // stale snapshot at send: revision moves between capture and completion.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx),
      supportedRoutes: STUB_ROUTES, getCurrentRevision: () => sha('moved-revision'),
    });
    check(out.fallbackReason === 'active-snapshot-stale' && out.request === request, 'mid-request checkpoint move discards the render');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // extra live user message: lossless rule refuses silent drops.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId);
    request.messages = request.messages.concat([{ id: 'msg-extra', role: 'user', content: [{ type: 'text', text: 'Untracked follow-up.' }], source: { kind: 'user' } }]);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
    });
    check(out.fallbackReason === 'active-current-turn-invalid' && out.request === request, 'unaccounted live turn falls back');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // foreign session: no binding, no cross-task read, legacy back.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH('sess-foreign');
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
    });
    check(out.fallbackReason === 'active-request-binding-changed' && out.request === request, 'foreign session never reads another task memory');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // open tool protocol in the live tail: C02 fails closed -> fallback.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId);
    request.messages = [
      { id: 'msg-u1', role: 'user', content: [{ type: 'text', text: TURN_TEXT }], source: { kind: 'user' } },
      { id: 'msg-a9', role: 'assistant', content: [{ type: 'tool-call', name: 'run-tests', callId: 'call-open-9' }], source: { kind: 'model' } },
    ];
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
    });
    check(out.mode === 'LEGACY' && out.request === request, 'open tool protocol falls back (balanced/ordered/atomic preserved)');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // telemetry failure alone never blocks a validated send.
  {
    const fx = setup({ mode: 'active' });
    const request = liveRequestH(NSH.sessionId);
    const out = host.applyActiveProjectionV2({
      request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx),
      supportedRoutes: STUB_ROUTES, telemetrySink: () => { throw new Error('sink down'); },
    });
    check(out.mode === 'CCV2_COMPILED', 'telemetry failure still allows the compiled send');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
  // failure isolation: corrupt staged page cannot crash the request path.
  {
    const fx = setup({ mode: 'active' });
    const pagesDir = path.join(fx.workspace, '.ai-harness', 'ccv2', NSH.taskId, 'pages');
    for (const f of fs.readdirSync(pagesDir)) fs.writeFileSync(path.join(pagesDir, f), '{corrupt');
    const request = liveRequestH(NSH.sessionId);
    let out = null;
    let threw = false;
    try {
      out = host.applyActiveProjectionV2({
        request, policy: activePolicy(fx), installRoot: fx.root, bindingsPath: bindingsPathOf(fx), supportedRoutes: STUB_ROUTES,
      });
    } catch (e) { threw = true; }
    check(threw === false && out !== null && out.request === request, 'corrupt memory isolates to legacy (never throws)');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
  }
}

section('C08H-W WATERFALL INSTALL (fake agent/request loop)');
{
  (async () => {
    // ACTIVE through the waterfall: compiled once per request object.
    const fx = makeFixtureRoot({ mode: 'active' });
    seedBindingH(fx, NSH.sessionId);
    stageMemoryH(fx);
    let telemetries = 0;
    const ctx2 = { on: (event, fn) => { ctx2.fn = fn; return () => {}; } };
    host.installCompilerActiveProjection(ctx2, {
      installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: () => {},
      supportedRoutes: STUB_ROUTES,
    });
    const request = liveRequestH(NSH.sessionId);
    const collected = [];
    collected.push(await ctx2.fn({}, async () => request));
    collected.push(await ctx2.fn({}, async () => request));
    check(collected[0].metadata.projectionMode === 'CCV2_COMPILED', 'waterfall ACTIVE replaces the projection');
    check(collected[1] === request, 'same request object never compiled twice (retry-safe)');
    check(collected[0].provider === 'stub-test' && collected[0].model === 'stub-model-v1', 'routing untouched by the wrapper');
    void telemetries;
    // OFF through the waterfall: verbatim, zero work (garbage bindings path tolerated).
    const fxOff = makeFixtureRoot(undefined);
    const ctxOff = { on: (event, fn) => { ctxOff.fn = fn; return () => {}; } };
    host.installCompilerActiveProjection(ctxOff, { installRoot: fxOff.root, bindingsPath: '/nonexistent/bindings.json', log: () => {} });
    const reqOff = liveRequestH(NSH.sessionId);
    const outOff = await ctxOff.fn({}, async () => reqOff);
    check(outOff === reqOff, 'OFF returns the resolved reference verbatim');
    // Auxiliary + session-less passthrough.
    const reqAux = Object.assign(clone(reqOff), { purpose: 'compaction' });
    check(await ctxOff.fn({}, async () => reqAux) === reqAux, 'auxiliary purpose skipped');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
    fs.rmSync(fxOff.root, { recursive: true, force: true }); fs.rmSync(fxOff.workspace, { recursive: true, force: true });
    check(true, 'waterfall matrix complete');
  })().then(() => {
    realApplySection();
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

function realApplySection() {
  section('C08H-R REAL APPLY (AihController registration path)');
  const controllerPath = path.join(repoRoot, 'config', 'AihController.cjs');
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const fx = makeFixtureRoot(undefined);
  const listeners = {};
  const ctx = { on: (event, fn) => { if (!listeners[event]) listeners[event] = []; listeners[event].push(fn); return () => {}; }, shellEnv: { register() {} } };
  const prev = { home: process.env.DSH_HOME, root: process.env.AIH_INSTALL_ROOT, toolchain: process.env.AIH_TOOLCHAIN_ROOT };
  process.env.DSH_HOME = path.join(fx.root, 'data');
  process.env.AIH_INSTALL_ROOT = fx.root;
  process.env.AIH_TOOLCHAIN_ROOT = repoRoot;
  try {
    controller.apply(ctx);
  } finally {
    if (prev.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev.home;
    if (prev.root === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = prev.root;
    if (prev.toolchain === undefined) delete process.env.AIH_TOOLCHAIN_ROOT; else process.env.AIH_TOOLCHAIN_ROOT = prev.toolchain;
  }
  check(Array.isArray(listeners['llm/stream']) && listeners['llm/stream'].length === 1, 'real apply keeps exactly one shadow observer');
  check(Array.isArray(listeners['agent/request']) && listeners['agent/request'].length >= 1, 'real apply installs the active projection wrapper');
  // Default policy: both inert (legacy request flows byte-identical).
  seedBindingH(fx, NSH.sessionId);
  stageMemoryH(fx);
  const request = liveRequestH(NSH.sessionId);
  const before = snapshotOf(request);
  const runAll = async () => {
    let current = request;
    for (const fn of listeners['agent/request']) current = await fn({}, async () => current);
    return current;
  };
  runAll().then((final) => {
    check(final === request, 'default OFF leaves the request reference-identical through the real path');
    check(snapshotOf(request) === before, 'default OFF leaves the request byte-identical');
    check(activeMod.resolveCompilerModeV2({ config: {} }).mode === 'off', 'upgrade with old config stays off');
    fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true });
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveHostV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
