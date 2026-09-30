'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
const opencode = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const shadowHost = require(path.join(repoRoot, 'config', 'ContextCompilerShadowHostV2.cjs'));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const MODEL = 'muse-spark-1.3-contributor';
const META_HOST = 'api.meta.ai';
const OPENCODE_HOST = 'opencode.ai';
const OPENCODE_PATH = '/zen/go/v1/responses';
const chr = (c) => String.fromCharCode(c);
const BG = [1047, 1076, 1088, 1072, 1074, 1081].map(chr).join('');
const EMOJI = String.fromCodePoint(128512);
function postJson(hostname, reqPath, apiKey, payload, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + apiKey };
    if (extraHeaders !== undefined && extraHeaders !== null) {
      for (const key of Object.keys(extraHeaders)) headers[key] = extraHeaders[key];
    }
    const req = https.request({
      hostname, path: reqPath, method: 'POST', timeout: timeoutMs,
      headers: Object.assign({}, headers),
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, bodyText: text, contentType: res.headers['content-type'] === undefined ? null : res.headers['content-type'] }));
    });
    req.on('timeout', () => { req.destroy(new Error('canary-transport-timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function toolSchema(n) {
  const tools = [];
  for (let i = 0; i < n; i += 1) {
    tools.push({ type: 'function', name: 'tool_' + i, description: 'Synthetic canary tool number ' + i + ' for schema sizing.', parameters: { type: 'object', properties: { arg: { type: 'string' } } } });
  }
  return tools;
}
const PREFIX = 'Stable shared prefix for canary stability. '.repeat(40);
function fixtures() {
  const reasoning = { effort: 'minimal' };
  const withReasoning = (body) => Object.assign({ reasoning }, body);
  return [
    { id: 'short-ascii', body: withReasoning({ model: MODEL, input: 'Reply with OK.' }) },
    { id: 'cyrillic', body: withReasoning({ model: MODEL, input: BG + ', answer briefly.' }) },
    { id: 'unicode-emoji', body: withReasoning({ model: MODEL, input: 'Mixed scripts ' + BG + ' ' + EMOJI + ' end.' }) },
    { id: 'source-code', body: withReasoning({ model: MODEL, input: 'Explain: function add(a,b){return a+b;} in one short sentence.' }) },
    { id: 'json-heavy', body: withReasoning({ model: MODEL, instructions: 'Answer with JSON only.', input: 'Return {"a":[1,2,{"b":null}]} described briefly.' }) },
    { id: 'instructions-history', body: withReasoning({ model: MODEL, instructions: 'You are a terse assistant.', input: [{ role: 'user', content: 'First question here.' }, { role: 'assistant', content: 'First answer here.' }, { role: 'user', content: 'Follow-up question here.' }] }) },
    { id: 'tool-definition', body: withReasoning({ model: MODEL, instructions: 'Use tools when asked.', input: 'What is two plus two?', tools: toolSchema(1) }) },
    { id: 'large-tool-schema', body: withReasoning({ model: MODEL, instructions: 'Use tools when asked.', input: 'Pick a tool.', tools: toolSchema(40) }) },
    { id: 'longer-context', body: withReasoning({ model: MODEL, instructions: PREFIX, input: 'Summarize the context in one short sentence.' }) },
    { id: 'stable-prefix-variant', body: withReasoning({ model: MODEL, instructions: PREFIX, input: 'Ask a different short question here.' }) },
    // ACTIVE-TAIL-NATIVE wire shape (request-shape v2): the DSH system as a
    // developer item, compiled context appended to it, and a provider-native
    // tool tail (function_call + function_call_output) with the pinned pi-ai
    // reasoning fields.
    { id: 'native-tail-tools', body: nativeTailBody([
      { type: 'function_call', call_id: 'call_canary_1', name: 'load_skill', arguments: '{"name":"nexus-engineering-workflow"}' },
      { type: 'function_call_output', call_id: 'call_canary_1', output: 'loaded' },
      { type: 'function_call', call_id: 'call_canary_2', name: 'load_skill', arguments: '{"name":"spec-reader"}' },
      { type: 'function_call_output', call_id: 'call_canary_2', output: 'spec text' },
    ]) },
  ];
}
const NATIVE_TAIL_TOOLS = [{ type: 'function', name: 'load_skill', description: 'Load a named skill.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }];
function nativeTailBody(tailItems) {
  return {
    model: MODEL,
    input: [
      { role: 'developer', content: 'You are the Nexus canary.' + String.fromCharCode(10, 10) + '[user-message source=user]' + String.fromCharCode(10) + 'Earlier compiled request.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Load the nexus-engineering-workflow skill, then continue.' }] },
    ].concat(tailItems),
    tools: NATIVE_TAIL_TOOLS,
    reasoning: { effort: 'minimal', summary: 'auto' },
    max_output_tokens: 512,
  };
}
// The counted subset REMOTE_MUSE_PRECOUNT forwards (projector COUNTED_KEYS).
function countedSubset(body) {
  const out = {};
  for (const key of ['model', 'input', 'tools', 'reasoning', 'max_output_tokens']) if (body[key] !== undefined) out[key] = body[key];
  return out;
}
/**
 * Live no-replay continuation fixture (request shape v3): step 1 asks
 * OpenCode for a tool call (fresh reasoning is returned); step 2 continues
 * natively with the function_call and its output but WITHOUT the historical
 * reasoning items (reasoningReplay=none on this route: OpenCode-issued
 * encrypted_content is caller-bound, the Meta count endpoint rejects it).
 * The exact step-2 counted subset is counted by Meta and posted to
 * OpenCode; billed input must stay within preCount + margin.
 */
async function nativeNoReplayContinuationFixture(counter, opencodeKey) {
  const record = { fixtureId: 'native-no-replay-continuation' };
  const headers = { 'x-opencode-session': 'sess-oc01-canary-native-replay', 'user-agent': 'nexus-ai-harness/1.0' };
  const step1 = Object.assign(nativeTailBody([]), { include: ['reasoning.encrypted_content'], store: false });
  const first = await postJson(OPENCODE_HOST, OPENCODE_PATH, opencodeKey, step1, 120000, headers);
  let output = null;
  try {
    output = first.status === 200 ? JSON.parse(first.bodyText).output : null;
  } catch (error) {
    void error;
  }
  const call = Array.isArray(output) ? output.find((item) => item && item.type === 'function_call') : undefined;
  if (call === undefined) {
    record.status = first.status === 200 ? 'no-tool-call' : 'http-' + first.status;
    record.anomaly = true;
    return record;
  }
  record.freshReasoningReturned = output.some((item) => item && item.type === 'reasoning');
  const continued = [{ type: 'function_call', id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.call_id, output: 'loaded' }];
  const step2 = Object.assign(nativeTailBody(continued), { include: ['reasoning.encrypted_content'], store: false });
  record.historicalReasoningItemsSent = step2.input.filter((item) => item.type === 'reasoning').length;
  try {
    record.preCount = (await counter.countPayloadV2(countedSubset(step2))).tokens;
    record.metaCountAccepted = true;
  } catch (error) {
    record.metaCountAccepted = false;
    record.status = 'count-rejected:' + String((error && error.code) || 'unknown').slice(0, 64);
    record.anomaly = true;
    return record;
  }
  record.margin = opencode.providerSafetyMarginV2(record.preCount);
  const second = await postJson(OPENCODE_HOST, OPENCODE_PATH, opencodeKey, step2, 120000, headers);
  const parsed = second.status === 200 ? parseResponsesUsage(second.bodyText) : { ok: false };
  if (parsed.ok !== true || parsed.status !== 'completed') {
    record.status = second.status === 200 ? 'unparsable' : 'http-' + second.status;
    record.anomaly = true;
    return record;
  }
  record.status = 'completed';
  record.providerReportedInputTokens = parsed.inputTokens;
  record.cachedTokens = parsed.cachedTokens;
  let nextKinds = [];
  try {
    nextKinds = JSON.parse(second.bodyText).output.map((item) => item.type);
  } catch (error) {
    void error;
  }
  record.nextOutputKinds = nextKinds;
  record.anomaly = parsed.inputTokens > record.preCount + record.margin || record.freshReasoningReturned !== true;
  return record;
}
function parseResponsesUsage(bodyText) {
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    void error;
    return { ok: false };
  }
  if (body === null || typeof body !== 'object') return { ok: false };
  const usage = body.usage;
  if (usage === null || typeof usage !== 'object') return { ok: false };
  const pick = (...values) => {
    for (const value of values) {
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const inputTokens = pick(usage.input_tokens, usage.prompt_tokens);
  if (!Number.isInteger(inputTokens) || inputTokens < 0) return { ok: false };
  const detailsOf = (container, key, alias) => {
    if (container === null || typeof container !== 'object') return null;
    const details = container[key] !== undefined ? container[key] : container[alias];
    return details !== null && typeof details === 'object' ? details : null;
  };
  const inputDetails = detailsOf(usage, 'input_tokens_details', 'prompt_tokens_details');
  const outputDetails = detailsOf(usage, 'output_tokens_details', 'completion_tokens_details');
  const cachedTokens = inputDetails !== null && Number.isInteger(inputDetails.cached_tokens) ? inputDetails.cached_tokens : null;
  const reasoningTokens = outputDetails !== null && Number.isInteger(outputDetails.reasoning_tokens) ? outputDetails.reasoning_tokens : null;
  return {
    ok: true,
    status: typeof body.status === 'string' ? body.status : null,
    inputTokens,
    outputTokens: pick(usage.output_tokens, usage.completion_tokens),
    cachedTokens,
    reasoningTokens,
  };
}
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
async function runCanary(metaKey, opencodeKey) {
  const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
  const descriptor = remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: MODEL });
  if (descriptor === null) throw new Error('meta remote descriptor unavailable');
  const counter = remote.createMuseRemoteCounterV2({ descriptor, apiKey: metaKey });
  const results = [];
  let failed = 0;
  for (const fixture of fixtures()) {
    const record = { fixtureId: fixture.id };
    try {
      const counted = await counter.countPayloadV2(fixture.body);
      record.preCount = counted.tokens;
      record.margin = opencode.providerSafetyMarginV2(counted.tokens);
      const inferred = await postJson(OPENCODE_HOST, OPENCODE_PATH, opencodeKey,
        Object.assign({}, fixture.body, { max_output_tokens: 512 }), 120000,
        { 'x-opencode-session': 'sess-oc01-canary-' + fixture.id, 'user-agent': 'nexus-ai-harness/1.0' });
      if (inferred.status !== 200) {
        record.status = 'http-' + inferred.status;
        record.anomaly = true;
        failed += 1;
      } else {
        const parsed = parseResponsesUsage(inferred.bodyText);
        if (parsed.ok !== true || parsed.status !== 'completed') {
          record.status = parsed.ok === true ? parsed.status : 'unparsable';
          record.anomaly = true;
          failed += 1;
        } else {
          record.status = 'completed';
          record.providerReportedInputTokens = parsed.inputTokens;
          record.providerReportedOutputTokens = parsed.outputTokens;
          record.cachedTokens = parsed.cachedTokens;
          record.reasoningTokens = parsed.reasoningTokens;
          record.anomaly = parsed.inputTokens > counted.tokens + record.margin;
          if (record.anomaly === true) failed += 1;
        }
      }
    } catch (error) {
      record.status = 'transport-failure';
      record.anomaly = true;
      failed += 1;
    }
    results.push(record);
    console.log('OC01-CANARY ' + JSON.stringify(record));
  }
  // Request-shape v3 certification requires live evidence for the native
  // no-replay continuation (never faked; any failure quarantines).
  let replayRecord = null;
  try {
    replayRecord = await nativeNoReplayContinuationFixture(counter, opencodeKey);
  } catch (error) {
    replayRecord = { fixtureId: 'native-no-replay-continuation', status: 'transport-failure', anomaly: true };
  }
  if (replayRecord.anomaly === true) failed += 1;
  results.push(replayRecord);
  console.log('OC01-CANARY ' + JSON.stringify(replayRecord));
  const digest = sha(JSON.stringify(results.map((r) => [r.fixtureId, r.preCount, r.providerReportedInputTokens, r.status, r.anomaly])));
  return { results, failed, digest };
}
function storeRootOfV2(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    return require('node:path').join(process.env.DSH_HOME, 'data', 'ccv2-authority');
  }
  return null;
}
function persistCertificationV2(canaryDigest, trusted, storeRootOverride) {
  if (trusted === true) return null;
  const storeRoot = typeof storeRootOverride === 'string' && storeRootOverride !== ''
    ? storeRootOverride : storeRootOfV2(arg('--store-root'));
  if (storeRoot === null) {
    console.log('OC01-CERT-SKIPPED no --store-root and no DSH_HOME; certification not persisted');
    return;
  }
  try {
    const host = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeHostV2.cjs'));
    const built = host.currentOpencodeIdentityV2({ installRoot: repoRoot });
    if (built.known !== true) {
      console.log('OC01-CERT-SKIPPED current identity unknown; certification not persisted');
      return;
    }
    const cert = require(path.join(repoRoot, 'config', 'ContextAuthorityCertificationV2.cjs'));
    const written = cert.certifyOpencodeV2(storeRoot, built.identity, canaryDigest);
    console.log('OC01-CERTIFIED state=' + written.status + ' expires=' + written.expiresAtUtc);
  } catch (error) {
    console.log('OC01-CERT-SKIPPED persist failed: ' + String((error && error.message) || error).slice(0, 160));
  }
}
function stageCCv2Memory(workspace) {
  const NSH = { taskId: 'TASK-OC01-LIVE', taskInstanceId: 'task_oc01_live_0001', sessionId: 'sess-oc01-live-' + Date.now().toString(36), repositoryId: 'repo-oc01', checkoutId: 'co-oc01' };
  const raw = {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove OpenCode CCv2 activation.', status: 'in-progress' },
    requirements: [{ id: 'REQ-C1', text: 'OpenCode route compiles with Meta precount.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'OC01 live', remainingMilestones: [] },
    decisions: [{ id: 'D-C1', statement: 'Fallback stays safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-C1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt OC01.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship OC01.' },
  };
  const token = snapshotMod.capture({
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: raw.objective, requirements: raw.requirements, constraints: raw.constraints,
      progress: raw.progress, decisions: raw.decisions,
      failures: { activeFailures: raw.failures.activeFailures, rejectedHypotheses: raw.failures.rejectedHypotheses },
      verification: raw.verification, continuation: raw.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('oc01:index'), worktreeDigest: sha('oc01:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: token }));
  const memDir = path.join(workspace, '.ai-harness', 'ccv2', NSH.taskId);
  const persisted = checkpoint.persistCheckpointV2(path.join(memDir, 'checkpoints'), { checkpoint: built.checkpoint, serialized: built.serialized });
  const mk = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = mk('decision', 'agent', ['decision:H9'], [40], 'Historical host note for OpenCode audit. '.repeat(30));
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-c7'], [7, 8], 'exit 0 settled opencode tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
  const CP = persisted.checkpoint;
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-C1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-C1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-C1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  fs.writeFileSync(path.join(memDir, 'tier-decisions.json'), JSON.stringify(decisions));
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([{ pageId: TOOL.id, callId: 'call-c7', callSeq: 7, resultSeq: 8 }]));
  return { NSH, CP, memDir };
}
async function runActivation(metaKey, opencodeKey) {
  const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
  const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
  const shadowHost = require(path.join(repoRoot, 'config', 'ContextCompilerShadowHostV2.cjs'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oc01-ws-'));
  const cleanup = () => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (ignored) { void ignored; }
  };
  try {
    const staged = stageCCv2Memory(workspace);
    const NSH = staged.NSH;
    const CP = staged.CP;
    const memDir = staged.memDir;
    const triple = { taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId };
    const stagedPages = shadowHost.readStagedPagesV2(memDir, triple);
    const stagedDecisions = shadowHost.readStagedDecisionsV2(memDir, triple);
    const stagedTx = shadowHost.readStagedToolTransactionsV2(memDir);
    if (stagedPages.pages === null || stagedDecisions.decisions === null || stagedTx.transactions === null) {
      throw new Error('staged memory unreadable');
    }
    const TURN_TEXT = 'Confirm the OpenCode CCv2 turn.';
    const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';
    const MAX_TOKENS = 4096;
    const descriptor = remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: MODEL });
    const metaRemoteCounter = remote.createMuseRemoteCounterV2({ descriptor, apiKey: metaKey });
    const compileInput = {
      checkpoint: CP,
      currentTurn: { turnId: 'live', text: TURN_TEXT, revision: null },
      namespace: {
        taskId: CP.taskId, taskInstanceId: CP.taskInstanceId, sessionId: CP.sessionId,
        workspaceId: CP.workspaceId, repositoryId: CP.repositoryId, checkoutId: CP.checkoutId,
      },
      snapshotRevision: CP.snapshot.revisionDigest,
      runtimeState: { pendingProtocol: null },
      pages: stagedPages.pages,
      tierDecisions: stagedDecisions.decisions,
      evidenceRefs: [],
      exactMaterial: [],
      toolTransactions: stagedTx.transactions,
      budget: { hardMax: 60000, target: 50000 },
      compilerPolicyRevision: compiler.COMPILER_POLICY_REVISION_V2,
    };
    const binding = {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      checkpointGeneration: CP.generation, checkpointId: CP.checkpointId,
      snapshotRevision: CP.snapshot.revisionDigest,
      turnId: 'live', turnTextHash: sha(TURN_TEXT),
      provider: 'opencode-go', model: MODEL,
      maxTokens: MAX_TOKENS, outputReserve: MAX_TOKENS,
      counterFingerprint: remote.REMOTE_FINGERPRINT_V1, counterRevision: remote.REMOTE_REVISION_V1,
    };
    const decision = await opencode.attemptOpencodeActiveV2({
      compileInput,
      pages: stagedPages.pages,
      metaRemoteCounter,
      requestTerms: { systemText: SYSTEM_TEXT, turnText: TURN_TEXT, maxTokens: MAX_TOKENS, outputReserve: MAX_TOKENS, reasoningEffort: 'xhigh' },
      binding,
      getCurrentRevision: () => shadowHost.readSealedRevisionForTaskV2(memDir),
    });
    console.log('OC01-ACTIVE-RECORD ' + JSON.stringify({
      provider: 'opencode-go', model: MODEL, authority: 'REMOTE_MUSE_PRECOUNT',
      projectionMode: decision.mode, fallback: decision.mode !== 'CCV2_COMPILED',
      fallbackReason: decision.fallbackReason,
      preCount: decision.preCount, providerSafetyMargin: decision.providerSafetyMargin,
      outputReserve: MAX_TOKENS,
      hardMaxCheck: decision.preCount === null ? null : (decision.preCount + (decision.providerSafetyMargin || 0) + MAX_TOKENS <= 1048576 ? 'PASS' : 'FAIL'),
      viewId: decision.view ? decision.view.id : null,
      renderDigest: decision.render ? decision.render.renderDigest : null,
    }));
    if (decision.eligible !== true) {
      cleanup();
      return { ok: false, reason: decision.fallbackReason };
    }
    const poster = (req) => postJson(req.hostname, req.reqPath, req.apiKey, JSON.parse(req.bodyJson), req.timeoutMs, req.headers)
      .then((result) => {
        return { status: result.status, bodyText: result.bodyText };
      })
      .then((mapped) => {
        if (mapped.status === 200) {
          try {
            JSON.parse(mapped.bodyText);
          } catch (ignored) {
            void ignored;
            console.log('OC01-ACTIVE-NONJSON ' + JSON.stringify({
              status: mapped.status,
              bodyLength: typeof mapped.bodyText === 'string' ? mapped.bodyText.length : -1,
            }));
          }
        }
        return mapped;
      }).catch((error) => {
        console.log('OC01-POSTER-ERROR ' + String((error && error.message) || error).slice(0, 200));
        throw error;
      });
    const sent = await opencode.sendOpencodeCompiledV2({
      decision,
      liveBinding: decision.binding,
      inferenceBody: decision.inferenceBody,
      inferencePost: poster,
      apiKey: opencodeKey,
      timeoutMs: 120000,
    });
    console.log('OC01-ACTIVE-USAGE ' + JSON.stringify({
      sent: sent.sent, completed: sent.completed === true, reason: sent.reason, httpStatus: sent.httpStatus === undefined ? null : sent.httpStatus, rejection: sent.rejection === undefined ? null : sent.rejection,
      preCount: sent.preCount, providerSafetyMargin: sent.providerSafetyMargin,
      providerReportedInputTokens: sent.usage ? sent.usage.promptTokens : null,
      providerReportedOutputTokens: sent.usage ? sent.usage.outputTokens : null,
      anomaly: sent.anomaly === true, authorityHealth: sent.authorityHealth,
    }));
    cleanup();
    return { ok: sent.sent === true && sent.completed === true && sent.anomaly !== true, sent };
  } catch (error) {
    cleanup();
    return { ok: false, reason: 'harness-failure:' + String((error && error.message) || error).slice(0, 200) };
  }
}
// The pinned DSH app tree that runs this build (installed layout first).
function appRootV2() {
  const candidates = [process.env.NEXUS_RUNTIME_ROOT ? path.join(process.env.NEXUS_RUNTIME_ROOT, 'app') : null,
    path.join(repoRoot, 'app'), path.join(os.homedir(), '.local', 'share', 'nexus', 'app')];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'))) return candidate;
  }
  return null;
}
// Credentials through the production DSH credential store
// (<installRoot>/data/.credentials.yaml, dsh-credentials-local), never
// printed; environment variables win as they do for the store itself.
async function resolveCredentialsV2(appRoot) {
  const out = { metaKey: process.env.MODEL_API_KEY, opencodeKey: process.env.OPENCODE_API_KEY, source: 'env' };
  if (typeof out.metaKey === 'string' && out.metaKey !== '' && typeof out.opencodeKey === 'string' && out.opencodeKey !== '') return out;
  const store = path.join(repoRoot, 'data', '.credentials.yaml');
  if (appRoot === null || !fs.existsSync(store)) return out;
  const { createRequire } = require('node:module');
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const { Context } = appRequire('@deepseek-ai/cordis');
  const Credentials = appRequire('@deepseek-ai/dsh-credentials-local').default;
  const ctx = new Context();
  try {
    await ctx.plugin(Credentials, { path: store, watch: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const meta = await ctx.credentials.resolve('MODEL_API_KEY');
    const oc = await ctx.credentials.resolve('OPENCODE_API_KEY');
    if (!(typeof out.metaKey === 'string' && out.metaKey !== '') && meta && typeof meta.value === 'string') out.metaKey = meta.value;
    if (!(typeof out.opencodeKey === 'string' && out.opencodeKey !== '') && oc && typeof oc.value === 'string') out.opencodeKey = oc.value;
    out.source = 'dsh-credentials-store';
  } finally {
    await ctx.fiber.dispose().catch(() => {});
  }
  return out;
}
async function runNativeTailPhaseV2(canaryDigest, dryRun, dryScenario) {
  const appRoot = appRootV2();
  if (appRoot === null) {
    console.log('OC01-NATIVE-TAIL blocker: pinned DSH app tree not found');
    return { ok: false, failures: ['app-missing'], report: null };
  }
  const live = require(path.join(__dirname, 'OC01-NativeTailLive.cjs'));
  const result = await live.runNativeTailLive({
    installRoot: repoRoot, appRoot, repoRoot, canaryDigest, dryRun: dryRun === true,
    dryScenario: dryRun === true && typeof dryScenario === 'string' ? dryScenario : null,
  });
  console.log('OC01-NATIVE-TAIL ' + JSON.stringify({ ok: result.ok, failures: result.failures, report: result.report }));
  return result;
}
async function main() {
  if (arg('--dry-run-native-tail') !== null) {
    // Plumbing check against a scripted local upstream + local counter
    // transport: no network, never certifies.
    const dry = await runNativeTailPhaseV2('d'.repeat(64), true, arg('--dry-scenario'));
    console.log(dry.ok ? 'CCV2-OC01 native-tail DRY RUN — PASS (no certification written)' : 'CCV2-OC01 native-tail DRY RUN — FAIL');
    process.exitCode = dry.ok ? 0 : 1;
    return;
  }
  const onlyCanary = arg('--canary-only') !== null;
  const trustedDigest = arg('--trust-canary');
  const runtimeStepD = arg('--runtime-step-d') !== null;
  const fixtureRoot = arg('--fixture-root');
  const storeRootArg = arg('--store-root');
  if (runtimeStepD === true) {
    await runtimeStepDMain(fixtureRoot, storeRootArg);
    return;
  }
  const credentials = await resolveCredentialsV2(appRootV2());
  const metaKey = credentials.metaKey;
  const opencodeKey = credentials.opencodeKey;
  if (typeof metaKey !== 'string' || metaKey === '' || typeof opencodeKey !== 'string' || opencodeKey === '') {
    console.log('CCV2-OC01 — BLOCKED');
    console.log('blocker: MODEL_API_KEY and OPENCODE_API_KEY are both required (environment or the DSH credential store; no network calls attempted, nothing faked)');
    process.exitCode = 2;
    return;
  }
  let canaryDigest = null;
  if (trustedDigest !== null && trustedDigest !== '') {
    if (!/^[0-9a-f]{64}$/.test(trustedDigest)) {
      console.log('CCV2-OC01 — DEFECT');
      console.log('defect: --trust-canary must carry a 64-hex digest from a passing canary run');
      process.exitCode = 1;
      return;
    }
    canaryDigest = trustedDigest;
    console.log('OC01-CANARY-TRUSTED digest=' + canaryDigest);
  } else {
    const canary = await runCanary(metaKey, opencodeKey);
  if (canary.failed > 0) {
    console.log('CCV2-OC01 — QUARANTINED');
    console.log('canary failed on ' + canary.failed + ' fixture(s); OpenCode CCV2 ACTIVE stays disabled');
    process.exitCode = 2;
    return;
  }
    canaryDigest = canary.digest;
  }
  console.log('OC01-CREDENTIALS source=' + credentials.source);
  if (onlyCanary === true) {
    // Request-shape v2 certification requires the live native-tail phase.
    console.log('OC01-CANARY-PASSED digest=' + canaryDigest + ' (report only; no certification without the native-tail phase)');
    process.exitCode = 0;
    return;
  }
  const nativeTail = await runNativeTailPhaseV2(canaryDigest, false);
  if (nativeTail.ok !== true) {
    console.log('CCV2-OC01 — QUARANTINED');
    console.log('native-tail live phase failed: ' + nativeTail.failures.join(', ') + '; no certification written, OpenCode CCV2 stays LEGACY');
    process.exitCode = 2;
    return;
  }
  opencode.markOpencodeHealthyV2(
    { provider: 'opencode-go', model: MODEL },
    { canaryDigest },
  );
  const restartAcceptance = arg('--restart-acceptance') !== null;
  let fixturePaths = null;
  if (restartAcceptance === true) {
    const os = require('node:os');
    const fxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc01h-fx-'));
    const dataRoot = path.join(fxRoot, 'data');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oc01h-ws-'));
    stageFixtureV2(fxRoot, dataRoot, workspace);
    fixturePaths = { fxRoot, dataRoot, workspace };
  }
  const persistedStore = persistCertificationV2(
    canaryDigest,
    trustedDigest !== null && trustedDigest !== '',
    fixturePaths !== null ? path.join(fixturePaths.dataRoot, 'ccv2-authority') : undefined,
  );
  console.log('OC01-CANARY-HEALTHY digest=' + canaryDigest);
  if (restartAcceptance === true) {
    await restartAcceptanceMain(fixturePaths);
    return;
  }
  if (arg('--legacy-activation') === null) {
    // Startup proof on the store just written (no trust flag, no network).
    const hostModule = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeHostV2.cjs'));
    opencode.resetOpencodeHealthV2();
    const started = hostModule.startupOpencodeAuthorityV2({ installRoot: repoRoot, storeRoot: storeRootOfV2(arg('--store-root')) });
    const identity = hostModule.currentOpencodeIdentityV2({ installRoot: repoRoot });
    console.log('OC01-STARTUP ' + JSON.stringify({
      state: started.state, health: started.health,
      requestShapeRevision: identity.known ? identity.identity.requestShapeRevision : null,
    }));
    console.log(started.health === 'HEALTHY'
      ? 'CCV2-OC01 — native-tail request shape CERTIFIED (startup HEALTHY)'
      : 'CCV2-OC01 — HOLD (certification written but startup is not HEALTHY)');
    process.exitCode = started.health === 'HEALTHY' ? 0 : 1;
    return;
  }
  const active = await runActivation(metaKey, opencodeKey);
  if (active.ok === true) {
    console.log('CCV2-OC01 — OpenCode Go Muse Activation VERIFIED');
    console.log('OpenCode Go / Muse Spark 1.3 Contributor — CCV2 ACTIVE');
    process.exitCode = 0;
    return;
  }
  console.log('CCV2-OC01 — HOLD');
  console.log('blocker: ' + (active.reason || (active.sent ? JSON.stringify({ reason: active.sent.reason }) : 'activation failed')));
  process.exitCode = active.sent && active.sent.external === true ? 2 : 1;
}
function copyRepoConfigV2(fixtureRoot) {
  const configDir = path.join(fixtureRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of ['settings.yaml', 'model-registry.json']) {
    fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(configDir, name));
  }
}
function stageFixtureV2(fixtureRoot, dataRoot, workspace) {
  fs.mkdirSync(path.join(fixtureRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config', 'routing-policy.json'), JSON.stringify({ version: 3, contextCompiler: { mode: 'active' } }));
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }));
  copyRepoConfigV2(fixtureRoot);
  const sessionId = 'sess-oc01h-stepd';
  const bindingsPath = path.join(dataRoot, 'routing', 'session-bindings.json');
  const doc = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
  doc.bindings[sessionId] = {
    sessionId, taskInstanceId: 'task_oc01h_stepd_0001', taskId: 'TASK-OC01H-STEPD',
    workspace, workspaceId: workspace, repositoryId: 'repo-oc01h', checkoutId: 'co-oc01h',
    preset: 'aih-muse', engine: 'muse',
  };
  fs.writeFileSync(bindingsPath, JSON.stringify(doc));
  const staged = stageCCv2MemoryForV2(workspace, sessionId);
  return { sessionId, bindingsPath, staged };
}
function stageCCv2MemoryForV2(workspace, sessionId) {
  const NSH = { taskId: 'TASK-OC01H-STEPD', taskInstanceId: 'task_oc01h_stepd_0001', sessionId, repositoryId: 'repo-oc01h', checkoutId: 'co-oc01h' };
  const raw = {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove restart acceptance.', status: 'in-progress' },
    requirements: [{ id: 'REQ-S1', text: 'Restart keeps authority healthy.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'OC01H step D', remainingMilestones: [] },
    decisions: [{ id: 'D-S1', statement: 'Restart is safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-S1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt restart.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship restart.' },
  };
  const token = snapshotMod.capture({
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, safePointBoundarySeq: 9, sessionRevision: 21,
    taskRevision: snapshotMod.deriveTaskRevision({
      objective: raw.objective, requirements: raw.requirements, constraints: raw.constraints,
      progress: raw.progress, decisions: raw.decisions,
      failures: { activeFailures: raw.failures.activeFailures, rejectedHypotheses: raw.failures.rejectedHypotheses },
      verification: raw.verification, continuation: raw.continuation,
    }),
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('oc01h:index'), worktreeDigest: sha('oc01h:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: token }));
  const memDir = path.join(workspace, '.ai-harness', 'ccv2', NSH.taskId);
  const persisted = checkpoint.persistCheckpointV2(path.join(memDir, 'checkpoints'), { checkpoint: built.checkpoint, serialized: built.serialized });
  const mk = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = mk('decision', 'agent', ['decision:H9'], [40], 'Historical host note for restart audit. '.repeat(30));
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-s7'], [7, 8], 'exit 0 settled restart tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
  const CP = persisted.checkpoint;
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-S1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-S1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-S1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  fs.writeFileSync(path.join(memDir, 'tier-decisions.json'), JSON.stringify(decisions));
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([{ pageId: TOOL.id, callId: 'call-s7', callSeq: 7, resultSeq: 8 }]));
  return { NSH, memDir };
}
async function restartAcceptanceMain(fixturePaths) {
  const child = require('node:child_process');
  const storeRoot = path.join(fixturePaths.dataRoot, 'ccv2-authority');
  const args = [
    __filename, '--runtime-step-d',
    '--fixture-root', fixturePaths.fxRoot,
    '--store-root', storeRoot,
  ];
  const result = child.spawnSync(process.execPath, args, {
    env: Object.assign({}, process.env),
    encoding: 'utf8',
    timeout: 300000,
  });
  const out = String((result.stdout || '') + (result.stderr || '')).slice(0, 3000);
  console.log(out);
  if (result.status === 0) {
    console.log('CCV2-OC01H — Persistent OpenCode Authority VERIFIED');
    console.log('OpenCode Go / Muse — CCV2 ACTIVE survives restart');
    process.exitCode = 0;
    return;
  }
  console.log('CCV2-OC01H — HOLD');
  console.log('blocker: runtime Step D failed (exit=' + result.status + ')');
  process.exitCode = 1;
}
async function runtimeStepDMain(fixtureRoot, storeRootArg) {
  const storeRoot = storeRootArg || path.join(fixtureRoot, 'data', 'ccv2-authority');
  const bindingsPath = path.join(fixtureRoot, 'data', 'routing', 'session-bindings.json');
  const controllerPath = path.join(repoRoot, 'config', 'AihController.cjs');
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const listeners = {};
  const ctx = {
    on: (event, fn, opts) => {
      void opts;
      (listeners[event] = listeners[event] || []).push(fn);
      return () => {};
    },
    shellEnv: { register() {} },
  };
  const previousHome = process.env.DSH_HOME;
  const previousRoot = process.env.AIH_INSTALL_ROOT;
  const previousToolchain = process.env.AIH_TOOLCHAIN_ROOT;
  process.env.DSH_HOME = path.join(fixtureRoot, 'data');
  process.env.AIH_INSTALL_ROOT = fixtureRoot;
  process.env.AIH_TOOLCHAIN_ROOT = repoRoot;
  try {
    controller.apply(ctx);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousRoot === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previousRoot;
    if (previousToolchain === undefined) delete process.env.AIH_TOOLCHAIN_ROOT; else process.env.AIH_TOOLCHAIN_ROOT = previousToolchain;
  }
  // The production seam: agent/request only resolves {provider, model,
  // maxTokens}; the complete frozen, session-bound request reaches the
  // installed listeners through the llm/stream waterfall (cordis semantics:
  // `this` is the dispatching LlmRuntime, next() takes no argument).
  const fns = listeners['llm/stream'] || [];
  if (fns.length === 0) {
    console.log('OC01H-STEPD conclusion: no llm/stream listeners installed');
    process.exitCode = 1;
    return;
  }
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object' && !(value instanceof AbortSignal) && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  };
  const request = deepFreeze({
    provider: 'opencode-go', model: 'muse-spark-1.3-contributor', reasoningEffort: 'xhigh', maxTokens: 2048,
    messages: [{ id: 'msg-u1', role: 'user', content: [{ type: 'text', text: 'Confirm the restart acceptance turn.' }], source: { kind: 'user' } }],
    system: 'You are the Nexus host-contract system prompt.',
    tools: [],
    sessionId: 'sess-oc01h-stepd',
    signal: new AbortController().signal,
  });
  const dispatched = [];
  const empty = () => (async function* () {})();
  const runtime = { stream: (derived) => { dispatched.push(derived); return empty(); } };
  const chain = fns.slice();
  const next = () => {
    const fn = chain.shift();
    return fn === undefined ? empty() : fn.call(runtime, request, next);
  };
  for await (const chunk of next()) void chunk;
  const current = dispatched.length === 1 ? dispatched[0] : request;
  const metadata = current && current.metadata ? current.metadata : {};
  console.log('OC01H-STEPD-RECORD ' + JSON.stringify({
    provider: current.provider,
    model: current.model,
    projectionMode: metadata.projectionMode === undefined ? null : metadata.projectionMode,
    authority: metadata.ccv2Authority === undefined ? null : metadata.ccv2Authority,
    storeRoot,
  }));
  if (metadata.projectionMode === 'CCV2_COMPILED' && metadata.ccv2Authority === 'REMOTE_MUSE_PRECOUNT') {
    console.log('OC01H-STEPD conclusion: normal runtime path compiles after restart (no trust flag)');
    process.exitCode = 0;
    return;
  }
  console.log('OC01H-STEPD conclusion: runtime path did not compile after restart');
  process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
