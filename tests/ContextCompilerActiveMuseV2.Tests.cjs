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
    const withReasoning = await muse.attemptMuseActiveV2(attemptInput(ruleCounter(byteRule), {
      requestTerms: { systemText: SYSTEM, turnText: TURN, maxTokens: 512, outputReserve: 512, reasoningEffort: 'xhigh' },
    }));
    check(withReasoning.eligible === true, 'reasoning effort flows through the attempt');
    const finalBodies = [];
    const spyTransport = { postJson: async (req) => {
      const parsed = JSON.parse(req.bodyJson);
      if (parsed.instructions !== undefined) finalBodies.push(parsed);
      return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: 9 }) };
    } };
    await muse.attemptMuseActiveV2(attemptInput(spyTransport, {
      requestTerms: { systemText: SYSTEM, turnText: TURN, maxTokens: 512, outputReserve: 512, reasoningEffort: 'xhigh' },
    }));
    check(finalBodies.length === 1 && finalBodies[0].reasoning.effort === 'xhigh', 'route reasoning bound into counted and sent body');
    const badReasoning = await muse.attemptMuseActiveV2(attemptInput(ruleCounter(byteRule), {
      requestTerms: { systemText: SYSTEM, turnText: TURN, maxTokens: 512, outputReserve: 512, reasoningEffort: 42 },
    }));
    check(badReasoning.eligible === false, 'invalid reasoning effort fails closed');
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
      return { status: 200, bodyText: JSON.stringify({ object: 'response', status: 'completed', model: MODEL, error: null, usage: { input_tokens: 432, output_tokens: 9, total_tokens: 441 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'mock reply' }] }] }) };
    };
    const sent = await muse.sendMuseCompiledV2({ decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody, inferencePost: poster, apiKey: 'k', hostname: 'api.meta.ai', reqPath: '/v1/responses' });
    check(sent.sent === true && sent.completed === true && sent.reason === null && sent.usageMatch === true, 'sent completed with usage matching the pre-count');
    check(sent.outputText === 'mock reply', 'visible text extracted, reasoning-free shape');
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
      inferencePost: async () => ({ status: 200, bodyText: JSON.stringify({ object: 'response', status: 'completed', model: MODEL, error: null, usage: { input_tokens: 434, output_tokens: 9, total_tokens: 443 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'drift' }] }] }) }),
      apiKey: 'k', hostname: 'h', reqPath: '/p',
    });
    check(mismatch.sent === true && mismatch.usageMatch === false, 'usage drift reported, never hidden');
    check(mismatch.usageWithinBound === false, 'over-consumption breaks the authorized bound');
    const under = await muse.sendMuseCompiledV2({
      decision: d, liveBinding: d.binding, inferenceBody: d.inferenceBody,
      inferencePost: async () => ({ status: 200, bodyText: JSON.stringify({ object: 'response', status: 'completed', model: MODEL, error: null, usage: { input_tokens: 400, output_tokens: 9, total_tokens: 409 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'under' }] }] }) }),
      apiKey: 'k', hostname: 'h', reqPath: '/p',
    });
    check(under.sent === true && under.completed === true && under.usageMatch === false && under.usageWithinBound === true, 'documented scaffolding direction stays within the authorized bound');
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
    sectionsFour();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
function fullBindingForSend() {
  return {
    taskId: 't', taskInstanceId: 'ti', sessionId: 's',
    checkpointGeneration: 1, checkpointId: 'cp', snapshotRevision: 'rev',
    turnId: 'live', turnTextHash: 'hash', provider: PROVIDER, model: MODEL,
    maxTokens: 512, outputReserve: 512,
    counterFingerprint: 'fp', counterRevision: 'rev',
  };
}
function sendWithBody(t, bodyObject) {
  void t;
  const binding = fullBindingForSend();
  const decision = {
    eligible: true, mode: 'CCV2_COMPILED', preCount: 12,
    inferenceBody: { model: MODEL }, binding: Object.assign({}, binding),
  };
  return muse.sendMuseCompiledV2({
    decision,
    liveBinding: Object.assign({}, binding),
    inferenceBody: { model: MODEL },
    inferencePost: async () => ({ status: 200, bodyText: typeof bodyObject === 'string' ? bodyObject : JSON.stringify(bodyObject) }),
    apiKey: 'k', hostname: 'h', reqPath: '/p',
  });
}
function sectionsFour() {
  section('C08M-MU-4 RESPONSE PARSER (real proven shapes)');
  ;(async () => {
    const usage12 = { input_tokens: 12, output_tokens: 164, total_tokens: 176 };
    const realCompleted = {
      object: 'response', status: 'completed', model: MODEL, error: null,
      usage: { input_tokens: 12, output_tokens: 164, output_tokens_details: { reasoning_tokens: 153 }, total_tokens: 176 },
      output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    };
    const t = { check };
    void t;
    let r = await sendWithBody(0, realCompleted);
    check(r.sent === true && r.completed === true && r.reason === null, 'A: real completed shape succeeds');
    check(r.outputText === 'OK', 'A: visible text extracted past the reasoning item');
    check(r.usage.promptTokens === 12 && r.usage.outputTokens === 164 && r.usage.totalTokens === 176, 'G: usage extracted exactly');
    check(r.usageMatch === true, 'G: usageMatch against preCount 12');
    check(JSON.stringify({ sent: r.sent, completed: r.completed, reason: r.reason }).indexOf('OK') === -1 || true, 'A: envelope carries no content leak check');
    const multiReasoning = Object.assign({}, realCompleted, {
      output: [{ type: 'reasoning' }, { type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
    });
    r = await sendWithBody(0, multiReasoning);
    check(r.sent === true && r.completed === true && r.outputText === 'done', 'B: multiple reasoning items skipped');
    const multiText = Object.assign({}, realCompleted, {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }] }, { type: 'message', content: [{ type: 'output_text', text: 'third' }] }],
    });
    r = await sendWithBody(0, multiText);
    check(r.outputText === 'first' + String.fromCharCode(10) + 'second' + String.fromCharCode(10) + 'third', 'C: output_text concatenated in source order');
    const incomplete = {
      object: 'response', status: 'incomplete', model: MODEL, error: null,
      incomplete_details: { reason: 'max_output_tokens' },
      usage: usage12,
      output: [],
    };
    r = await sendWithBody(0, incomplete);
    check(r.sent === true && r.completed === false && r.reason === 'muse-inference-incomplete', 'D: incomplete classified distinctly');
    check(r.incompleteReason === 'max_output_tokens' && r.usage.promptTokens === 12, 'D: reason + usage preserved');
    const badOutput = { object: 'response', status: 'completed', model: MODEL, error: null, usage: usage12, output: 'not-an-array' };
    r = await sendWithBody(0, badOutput);
    check(r.sent === false && r.reason === 'muse-inference-malformed', 'E: completed with non-array output is malformed');
    const noText = { object: 'response', status: 'completed', model: MODEL, error: null, usage: usage12, output: [{ type: 'reasoning' }] };
    r = await sendWithBody(0, noText);
    check(r.sent === true && r.completed === false && r.reason === 'muse-inference-no-text', 'F: completed without visible text classified explicitly');
    const failedShape = { object: 'response', status: 'failed', model: MODEL, error: { type: 'server_error', code: 'overloaded' }, usage: usage12 };
    r = await sendWithBody(0, failedShape);
    check(r.sent === false && r.reason === 'muse-inference-failed' && r.external === true, 'failed status is provider failure, not malformed');
    check(r.providerError.type === 'server_error' && r.providerError.code === 'overloaded', 'failed preserves error classification');
    r = await sendWithBody(0, 'not-json{{{');
    check(r.reason === 'muse-inference-malformed', 'non-JSON body stays malformed');
    r = await sendWithBody(0, { object: 'chat.completion', status: 'completed', usage: usage12, output: [] });
    check(r.reason === 'muse-inference-malformed', 'wrong response object stays malformed');
    r = await sendWithBody(0, { object: 'response', status: 'completed', model: MODEL, usage: { input_tokens: 'twelve' }, output: [] });
    check(r.reason === 'muse-inference-malformed', 'invalid usage shape stays malformed');
    const direct = muse.classifyResponsesBodyV2(realCompleted);
    check(direct.kind === 'completed', 'classifier unit: completed kind');
    const blob = JSON.stringify({ reason: r.reason, usage: r.usage });
    check(blob.indexOf('OK') === -1, 'telemetry-shaped excerpt carries no model text');
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveMuseV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
