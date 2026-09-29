'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
const muse = require(path.join(repoRoot, 'config', 'ContextCompilerActiveMuseV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const NS = Object.freeze({ taskId: 'TASK-C08Q-A', taskInstanceId: 'task_c08q_a_0001', sessionId: 'sess-c08q-a', workspaceId: '/tmp/nexus-c08q-a', repositoryId: 'repo-c08q', checkoutId: 'checkout-c08q' });
const TURN = 'Compile through the remote counter now.';
const SYSTEM = 'You are the Nexus host-contract system prompt.';
const PROVIDER = 'meta-model-api';
const MODEL = 'muse-spark-1.3-contributor';
const WINDOW = 1048576;
const RESERVE = 512;
const DESCRIPTOR = remote.resolveMuseRemoteV2({ provider: PROVIDER, model: MODEL });
function stageMemory() {
  const raw = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove remote activation.', status: 'in-progress' },
    requirements: [{ id: 'REQ-Q1', text: 'Remote gate holds.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H remote', remainingMilestones: [] },
    decisions: [{ id: 'D-Q1', statement: 'Fallback is safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-Q1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt remote.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship remote.' },
  };
  const token = snapshotMod.capture({
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: raw.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: raw.objective, requirements: raw.requirements, constraints: raw.constraints,
      progress: raw.progress, decisions: raw.decisions,
      failures: { activeFailures: raw.failures.activeFailures, rejectedHypotheses: raw.failures.rejectedHypotheses },
      verification: raw.verification, continuation: raw.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08q:index'), worktreeDigest: sha('c08q:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: token }));
  const CP = built.checkpoint;
  const mk = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
      workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = mk('decision', 'agent', ['decision:H9'], [40], 'Historical host note. '.repeat(30));
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-q1'], [7, 8], 'exit 0 settled remote tool log. '.repeat(8));
  const pages = [COLD, TOOL];
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-Q1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-Q1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-Q1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  return { CP, pages, decisions, TOOL };
}
function mockTransport(handler) {
  const calls = [];
  return {
    calls,
    postJson: async (req) => {
      calls.push({ reqPath: req.reqPath, bodyJson: req.bodyJson });
      return handler(req, calls.length);
    },
  };
}
function ruleCounter(rule) {
  return mockTransport((req) => {
    const body = JSON.parse(req.bodyJson);
    if (body.instructions !== undefined || Array.isArray(body.input)) {
      if (rule.finalOverride !== undefined && rule.finalOverride !== null) {
        return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: rule.finalOverride }) };
      }
    }
    const text = typeof body.input === 'string' ? body.input : JSON.stringify(body.input);
    return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: rule.countText(text) }) };
  });
}
const byteRule = { countText: (text) => 1 + (Buffer.byteLength(text, 'utf8') % 11), finalOverride: 432 };
function attemptInput(transport, extra) {
  const staged = stageMemory();
  const remoteCounter = remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'test-key', transport });
  const binding = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    checkpointGeneration: 1, checkpointId: staged.CP.checkpointId,
    snapshotRevision: staged.CP.snapshot.revisionDigest,
    turnId: 'live', turnTextHash: sha(TURN),
    provider: PROVIDER, model: MODEL,
    maxTokens: RESERVE, outputReserve: RESERVE,
    counterFingerprint: remote.REMOTE_FINGERPRINT_V1, counterRevision: remote.REMOTE_REVISION_V1,
  };
  const compileInput = {
    checkpoint: staged.CP,
    currentTurn: { turnId: 'live', text: TURN, revision: null },
    namespace: {
      taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
      workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    },
    snapshotRevision: staged.CP.snapshot.revisionDigest,
    runtimeState: { pendingProtocol: null },
    pages: staged.pages,
    tierDecisions: staged.decisions,
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [{ pageId: staged.TOOL.id, callId: 'call-q1', callSeq: 7, resultSeq: 8 }],
    budget: { hardMax: 60000, target: 50000 },
    compilerPolicyRevision: compiler.COMPILER_POLICY_REVISION_V2,
  };
  return Object.assign({
    compileInput,
    pages: staged.pages,
    remoteCounter,
    route: { provider: PROVIDER, model: MODEL, maxContextTokens: WINDOW },
    requestTerms: { systemText: SYSTEM, turnText: TURN, maxTokens: RESERVE, outputReserve: RESERVE },
    binding,
  }, extra || {});
}
section('C08M-MU-1 REMOTE SUCCESS (two-pass exact)');
{
  (async () => {
    const transport = ruleCounter(byteRule);
    const d = await muse.attemptMuseActiveV2(attemptInput(transport));
    check(d.eligible === true && d.mode === 'CCV2_COMPILED', 'eligible compiled decision');
    check(d.preCount === 432, 'pre-count is the provider whole-payload count');
    check(d.telemetry.counterKind === 'REMOTE_EXACT', 'telemetry names the remote authority');
    check(d.telemetry.counterFingerprint === remote.REMOTE_FINGERPRINT_V1, 'remote fingerprint bound');
    check(d.telemetry.memoEntries > 5 && d.compilerExecutions === 1, 'memoized provider counts, one execution');
    check(JSON.stringify(d.telemetry).indexOf(TURN) === -1, 'telemetry secret-safe');
    check(JSON.stringify(d.telemetry).indexOf('planning-byte') === -1, 'planning counter never reported as authority');
    const finals = transport.calls.filter((c) => JSON.parse(c.bodyJson).instructions !== undefined);
    check(finals.length === 1, 'whole-payload count called exactly once');
    const finalSent = JSON.parse(finals[0].bodyJson);
    check(JSON.stringify(checkpoint.canonicalize(finalSent)) === JSON.stringify(checkpoint.canonicalize(d.inferenceBody)), 'counted body equals the sendable body');
    check(finalSent.model === MODEL && typeof finalSent.instructions === 'string' && Array.isArray(finalSent.input), 'request-shape bound (model/instructions/input)');
    const perText = transport.calls.length - finals.length;
    check(perText >= 5, 'per-text provider counts back the pipeline (' + perText + ')');
    const r2 = await muse.attemptMuseActiveV2(attemptInput(ruleCounter(byteRule)));
    check(r2.eligible === true && r2.render.renderDigest === d.render.renderDigest, 'repeat attempt reproduces the decision');
  })().then(() => {
    sectionsTwo();
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
function sectionsTwo() {
  section('C08M-MU-2 SEND BOUNDARY');
  ;(async () => {
    const transport = ruleCounter(byteRule);
    const d = await muse.attemptMuseActiveV2(attemptInput(transport));
    check(d.eligible === true, 'baseline eligible');
    const inferenceCalls = [];
    const poster = async (req) => {
      inferenceCalls.push(JSON.parse(req.bodyJson));
      return { status: 200, bodyText: JSON.stringify({ id: 'resp_1', model: MODEL, usage: { input_tokens: 432, output_tokens: 9, total_tokens: 441 } }) };
    };
    const sent = await muse.sendMuseCompiledV2({ decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody, inferencePost: poster, apiKey: 'k', hostname: 'api.meta.ai', reqPath: '/v1/responses' });
    check(sent.sent === true && sent.usageMatch === true, 'sent with usage matching the pre-count');
    check(sent.usage.promptTokens === 432 && inferenceCalls.length === 1, 'usage parsed, one inference call');
    check(JSON.stringify(checkpoint.canonicalize(inferenceCalls[0])) === JSON.stringify(checkpoint.canonicalize(d.inferenceBody)), 'sent bytes equal counted bytes');
    const stale = await muse.sendMuseCompiledV2({
      decision: d,
      liveBinding: Object.assign({}, d.binding, { turnTextHash: sha('other') }),
      inferenceBody: d.inferenceBody, inferencePost: poster, apiKey: 'k', hostname: 'h', reqPath: '/p',
    });
    check(stale.sent === false && inferenceCalls.length === 1, 'binding change before inference blocks the send');
    const tampered = await muse.sendMuseCompiledV2({
      decision: d, liveBinding: d.binding,
      inferenceBody: Object.assign({}, JSON.parse(JSON.stringify(d.inferenceBody)), { instructions: 'forged' }),
      inferencePost: poster, apiKey: 'k', hostname: 'h', reqPath: '/p',
    });
    check(tampered.sent === false && inferenceCalls.length === 1, 'forged body never sent');
    const denied = await muse.sendMuseCompiledV2({
      decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody,
      inferencePost: async () => ({ status: 401, bodyText: '{}' }), apiKey: 'k', hostname: 'h', reqPath: '/p',
    });
    check(denied.sent === false && denied.external === true, 'auth failure is external, not a CCv2 defect');
    const mismatch = await muse.sendMuseCompiledV2({
      decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody,
      inferencePost: async () => ({ status: 200, bodyText: JSON.stringify({ usage: { input_tokens: 434, output_tokens: 9, total_tokens: 443 } }) }),
      apiKey: 'k', hostname: 'h', reqPath: '/p',
    });
    check(mismatch.sent === true && mismatch.usageMatch === false, 'usage drift reported, never hidden');
    sectionsThree();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
function sectionsThree() {
  section('C08M-MU-3 REMOTE FALLBACKS');
  ;(async () => {
    const failWith = async (handler, expected, name) => {
      const d = await muse.attemptMuseActiveV2(attemptInput(mockTransport(handler)));
      check(d.eligible === false && d.mode === 'LEGACY', name + ' falls back (never throws)');
      check(d.fallbackReason === expected, name + ' reason ' + expected, d.fallbackReason);
      check(d.view === null && d.inferenceBody === null, name + ' no partial artifacts');
    };
    await failWith(() => ({ status: 401, bodyText: '{}' }), 'active-tokenizer-unavailable', 'auth');
    await failWith(() => { throw new Error('socket hang up'); }, 'active-tokenizer-unavailable', 'timeout');
    await failWith(() => ({ status: 200, bodyText: 'garbage' }), 'active-tokenizer-unavailable', 'malformed');
    await failWith(() => ({ status: 400, bodyText: JSON.stringify({ error: { message: "Model 'x' unsupported", code: 'model_not_found' } }) }), 'active-model-capability-unknown', 'model-unsupported');
    await failWith((req) => {
      const body = JSON.parse(req.bodyJson);
      if (body.instructions !== undefined) return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: 99999999 }) };
      return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: 5 }) };
    }, 'active-render-over-budget', 'count-exceeds-window');
    {
      const d = await muse.attemptMuseActiveV2(attemptInput(ruleCounter(byteRule), { route: { provider: PROVIDER, model: MODEL, maxContextTokens: 100 } }));
      check(d.eligible === false && d.fallbackReason === 'active-budget-unrepresentable', 'window smaller than reserves fails closed');
    }
    {
      const rc = remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'k', transport: ruleCounter(byteRule) });
      const bad = attemptInput(ruleCounter(byteRule));
      bad.remoteCounter = rc;
      bad.route = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor', maxContextTokens: WINDOW };
      const d = await muse.attemptMuseActiveV2(bad);
      check(d.eligible === false, 'counter route mismatch falls back');
    }
    {
      let telemetries = 0;
      const d = await muse.attemptMuseActiveV2(attemptInput(ruleCounter(byteRule), { telemetrySink: () => { telemetries += 1; throw new Error('sink down'); } }));
      check(d.eligible === true && telemetries === 1, 'telemetry failure never blocks a validated decision');
    }
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveMuseV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
