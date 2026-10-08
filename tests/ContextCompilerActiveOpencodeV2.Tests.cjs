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
const opencode = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeV2.cjs'));
const capMod = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const NS = Object.freeze({ taskId: 'TASK-C08O-A', taskInstanceId: 'task_c08o_a_0001', sessionId: 'sess-c08o-a', workspaceId: '/tmp/nexus-c08o-a', repositoryId: 'repo-c08o', checkoutId: 'checkout-c08o' });
const TURN = 'Compile for OpenCode now.';
const SYSTEM = 'You are the Nexus host-contract system prompt.';
const WINDOW = 1048576;
const RESERVE = 512;
const DESCRIPTOR = remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
const ORDER = [];
function stageMemory() {
  const raw = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove OpenCode activation.', status: 'in-progress' },
    requirements: [{ id: 'REQ-O1', text: 'OpenCode gate holds.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'OC01', remainingMilestones: [] },
    decisions: [{ id: 'D-O1', statement: 'Fallback is safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-O1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt OC01.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship OC01.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08o:index'), worktreeDigest: sha('c08o:worktree') },
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
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-o1'], [7, 8], 'exit 0 settled opencode tool log. '.repeat(8));
  const pages = [COLD, TOOL];
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-O1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-O1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-O1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  return { CP, pages, decisions, TOOL };
}
function countTransport(rule, tag) {
  return {
    postJson: async (req) => {
      ORDER.push(tag + ':count');
      const body = JSON.parse(req.bodyJson);
      if (body.instructions !== undefined && rule.finalOverride !== undefined) {
        return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: rule.finalOverride }) };
      }
      const text = typeof body.input === 'string' ? body.input : JSON.stringify(body.input);
      return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: rule.countText(text) }) };
    },
  };
}
const byteRule = { countText: (text) => 1 + (Buffer.byteLength(text, 'utf8') % 11), finalOverride: 432 };
function attemptInput(countT, extra) {
  const staged = stageMemory();
  const remoteCounter = remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'meta-key', transport: countT });
  const binding = {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    checkpointGeneration: 1, checkpointId: staged.CP.checkpointId,
    snapshotRevision: staged.CP.snapshot.revisionDigest,
    turnId: 'live', turnTextHash: sha(TURN),
    provider: 'opencode-go', model: 'muse-spark-1.3-contributor',
    maxTokens: RESERVE, outputReserveTokens: RESERVE,
    tokenizerFingerprint: remote.REMOTE_FINGERPRINT_V1, capabilityRevision: remote.REMOTE_REVISION_V1,
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
    toolTransactions: [{ pageId: staged.TOOL.id, callId: 'call-o1', callSeq: 7, resultSeq: 8 }],
    budget: { hardMax: 60000, target: 50000 },
    compilerPolicyRevision: compiler.COMPILER_POLICY_REVISION_V2,
  };
  return Object.assign({
    compileInput,
    pages: staged.pages,
    metaRemoteCounter: remoteCounter,
    requestTerms: { systemText: SYSTEM, turnText: TURN, maxTokens: RESERVE, outputReserve: RESERVE },
    binding,
  }, extra || {});
}
function inferenceTransport(handler, tag) {
  return async (req) => {
    ORDER.push(tag + ':inference');
    return handler(req);
  };
}
const okInference = (usage) => async () => ({
  status: 200,
  bodyText: JSON.stringify(Object.assign({
    object: 'response', status: 'completed', model: 'muse-spark-1.3-contributor', error: null,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
  }, { usage })),
});
function healthy() {
  opencode.resetOpencodeHealthV2();
  opencode.markOpencodeHealthyV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }, { canaryDigest: 'test-canary' });
}
section('C08H-OC-1 MARGIN POLICY + HEALTH DEFAULTS');
{
  check(opencode.providerSafetyMarginV2(0) === 8192, 'zero pre-count still carries the minimum margin');
  check(opencode.providerSafetyMarginV2(432) === 8192, 'small pre-count uses the minimum (1% would be 5)');
  check(opencode.providerSafetyMarginV2(1000000) === 10000, 'large pre-count uses the 1% rule');
  opencode.resetOpencodeHealthV2();
  check(opencode.opencodeHealthV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }) === 'QUARANTINED', 'new routes start quarantined (fail-closed default)');
  healthy();
  check(opencode.opencodeHealthV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }) === 'HEALTHY', 'canary evidence marks healthy');
  let threw = false;
  try {
    opencode.markOpencodeHealthyV2({ provider: 'opencode-go', model: 'other-model' }, { canaryDigest: 'x' });
  } catch (error) {
    threw = true;
  }
  check(threw === true, 'only the approved pair can become healthy');
  opencode.resetOpencodeHealthV2();
}
section('C08H-OC-2 QUARANTINED DEFAULT (zero network)');
{
  (async () => {
    opencode.resetOpencodeHealthV2();
    const strict = { postJson: async () => { throw new Error('network must not be touched'); } };
    const d = await opencode.attemptOpencodeActiveV2(attemptInput(strict));
    check(d.eligible === false && d.mode === 'LEGACY', 'quarantined route falls back');
    check(d.fallbackReason === 'active-tokenizer-unavailable', 'authority-unavailable reason');
    check(d.authorityHealth === 'QUARANTINED', 'health visible');
    check(d.telemetry.authority === 'REMOTE_MUSE_PRECOUNT', 'authority class visible (never REMOTE_EXACT)');
    sectionsOC3();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
function sectionsOC3() {
  section('C08H-OC-3 HEALTHY PATH + ORDERING + MARGIN GATE');
  ;(async () => {
    healthy();
    ORDER.length = 0;
    const d = await opencode.attemptOpencodeActiveV2(attemptInput(countTransport(byteRule, 'meta')));
    check(d.eligible === true && d.mode === 'CCV2_COMPILED', 'healthy route compiles');
    check(d.telemetry.authority === 'REMOTE_MUSE_PRECOUNT' && d.telemetry.authorityHealth === 'HEALTHY', 'authority + health in telemetry');
    check(d.providerSafetyMargin === 8192 && d.telemetry.providerSafetyMargin === 8192, 'margin 8192 selected and exposed');
    check(d.preCount === 432, 'pre-count from Meta');
    const poster = inferenceTransport(okInference({ input_tokens: 400, output_tokens: 9, total_tokens: 409 }), 'opencode');
    const sent = await opencode.sendOpencodeCompiledV2({
      decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody,
      inferencePost: poster, apiKey: 'opencode-key',
    });
    check(sent.sent === true && sent.completed === true, 'inference sent through OpenCode');
    check(sent.authority === 'REMOTE_MUSE_PRECOUNT', 'send carries the authority');
    check(sent.anomaly === false, 'usage within pre-count + margin: no anomaly');
    check(sent.usageMatch === false && sent.usageWithinBound === true, 'strict equality not required, bound reported separately');
    const firstCount = ORDER.findIndex((entry) => entry === 'meta:count');
    const firstInference = ORDER.findIndex((entry) => entry === 'opencode:inference');
    check(firstCount !== -1 && firstInference !== -1 && firstCount < firstInference, 'Meta counter called before OpenCode inference');
    check(JSON.stringify(sent).indexOf('opencode-key') === -1 && JSON.stringify(sent).indexOf(TURN) === -1, 'result secret-safe (no key, no prompt)');
    let seenHeaders = null;
    const headerPoster = async (req) => {
      seenHeaders = req.headers;
      return { status: 200, bodyText: JSON.stringify({ object: 'response', status: 'completed', model: 'muse-spark-1.3-contributor', error: null, usage: { input_tokens: 400, output_tokens: 9, total_tokens: 409 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'h' }] }] }) };
    };
    await opencode.sendOpencodeCompiledV2({
      decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody,
      inferencePost: headerPoster, apiKey: 'opencode-key',
    });
    check(seenHeaders !== null && seenHeaders['x-opencode-session'] === 'sess-c08o-a', 'stable session header threaded to transport');
    check(typeof seenHeaders['user-agent'] === 'string' && seenHeaders['user-agent'] !== '', 'client user agent identified');
    sectionsOC4();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
function sectionsOC4() {
  section('C08H-OC-4 FALLBACKS + ANOMALY QUARANTINE');
  ;(async () => {
    const failingCount = { postJson: async () => ({ status: 401, bodyText: '{}' }) };
    healthy();
    const dMeta = await opencode.attemptOpencodeActiveV2(attemptInput(failingCount));
    check(dMeta.eligible === false && dMeta.mode === 'LEGACY', 'Meta failure falls back (no OpenCode call possible)');
    healthy();
    const overRule = { countText: byteRule.countText, finalOverride: WINDOW - RESERVE - 8192 };
    const dOver = await opencode.attemptOpencodeActiveV2(attemptInput(countTransport(overRule, 'meta')));
    check(dOver.eligible === false && dOver.fallbackReason === 'active-render-over-budget', 'over-margin request blocked');
    healthy();
    const dOk = await opencode.attemptOpencodeActiveV2(attemptInput(countTransport(byteRule, 'meta')));
    check(dOk.eligible === true, 'baseline eligible');
    const tampered = await opencode.sendOpencodeCompiledV2({
      decision: dOk, liveBinding: dOk.binding,
      inferenceBody: Object.assign({}, JSON.parse(JSON.stringify(dOk.inferenceBody)), { instructions: 'forged' }),
      inferencePost: inferenceTransport(okInference({ input_tokens: 400, output_tokens: 1, total_tokens: 401 }), 'opencode'),
      apiKey: 'k',
    });
    check(tampered.sent === false, 'counted/send mismatch blocked');
    const noKey = await opencode.sendOpencodeCompiledV2({
      decision: dOk, liveBinding: dOk.binding, inferenceBody: dOk.inferenceBody,
      inferencePost: inferenceTransport(okInference({ input_tokens: 400, output_tokens: 1, total_tokens: 401 }), 'opencode'),
      apiKey: '',
    });
    check(noKey.sent === false, 'missing OpenCode credential never succeeds');
    const anomalous = await opencode.sendOpencodeCompiledV2({
      decision: dOk, liveBinding: dOk.binding, inferenceBody: dOk.inferenceBody,
      inferencePost: inferenceTransport(okInference({ input_tokens: 432 + 8192 + 1, output_tokens: 1, total_tokens: 9000 }), 'opencode'),
      apiKey: 'k',
    });
    check(anomalous.sent === true && anomalous.anomaly === true, 'over-margin usage recorded (request not retro-failed)');
    check(opencode.opencodeHealthV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }) === 'QUARANTINED', 'anomaly quarantines the route');
    const after = await opencode.attemptOpencodeActiveV2(attemptInput(countTransport(byteRule, 'meta')));
    check(after.eligible === false && after.mode === 'LEGACY', 'quarantined route falls back on subsequent requests');
    const deep = capMod.resolveModelCapabilityV2({ provider: 'flash-max-direct', model: 'deepseek-v4-flash', installRoot: repoRoot });
    check(deep.valid === true, 'DeepSeek behavior unchanged');
    const meta = await opencode.attemptOpencodeActiveV2(attemptInput(countTransport(byteRule, 'meta')));
    void meta;
    opencode.resetOpencodeHealthV2();
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveOpencodeV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
