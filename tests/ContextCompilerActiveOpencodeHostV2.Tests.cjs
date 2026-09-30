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
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
const opencode = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeV2.cjs'));
const host = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeHostV2.cjs'));
const cert = require(path.join(repoRoot, 'config', 'ContextAuthorityCertificationV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
const NSH = Object.freeze({ taskId: 'TASK-C08OH-A', taskInstanceId: 'task_c08oh_a_0001', sessionId: 'sess-c08oh-a', repositoryId: 'repo-c08oh', checkoutId: 'co-c08oh' });
const TURN_TEXT = 'Run the OpenCode host turn.';
const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';
const PROVIDER = 'opencode-go';
const MODEL = 'muse-spark-1.3-contributor';
function makeFixtureRoot(policySection) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c08oh-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c08oh-ws-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'routing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'logs'), { recursive: true });
  const policy = { version: 3 };
  if (policySection !== undefined) policy.contextCompiler = policySection;
  fs.writeFileSync(path.join(root, 'config', 'routing-policy.json'), JSON.stringify(policy));
  fs.writeFileSync(path.join(root, 'data', 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }));
  fs.writeFileSync(path.join(root, 'config', 'settings.yaml'), [
    'llm-pi-ai:', '  providers:', '    opencode-go:',
    '      apiKeyEnv: OPENCODE_API_KEY', '      api: openai-responses',
    '      baseURL: https://opencode.ai/zen/go/v1', '    meta-model-api:',
    '      apiKeyEnv: MODEL_API_KEY', '      api: openai-completions',
    '      baseURL: https://api.meta.ai/v1', '',
  ].join(String.fromCharCode(10)));
  fs.writeFileSync(path.join(root, 'config', 'model-registry.json'), JSON.stringify({
    schemaVersion: 1,
    models: [
      { id: 'muse-spark-1.3-contributor-opencode', provider: 'opencode-go', model: 'muse-spark-1.3-contributor', contextWindow: 1048576, maxOutputTokens: 131072 },
      { id: 'muse-spark-1.3-contributor', provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', contextWindow: 1048576, maxOutputTokens: 131072 },
    ],
  }));
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
function checkpointInputH(workspace) {
  return {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove OpenCode host wiring.', status: 'in-progress' },
    requirements: [{ id: 'REQ-H1', text: 'Host replaces bulk projection.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H host', remainingMilestones: [] },
    decisions: [{ id: 'D-H1', statement: 'Fallback is safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-H1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Wire host.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship host.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08oh:index'), worktreeDigest: sha('c08oh:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
}
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
  return { CP, memDir };
}
function liveRequestH(sessionId, turnText, extra) {
  const base = {
    provider: PROVIDER, model: MODEL, reasoningEffort: 'xhigh', maxTokens: 2048,
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
function storeRootOf(fx) { return path.join(fx.root, 'data', 'ccv2-authority'); }
function snapshotOf(request) { return JSON.stringify(checkpoint.canonicalize(clone(request))); }
function wipe(fx) { fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true }); }
function mockRemoteCounter(rule) {
  return {
    fingerprint: remote.REMOTE_FINGERPRINT_V1,
    provider: 'meta-model-api',
    model: 'muse-spark-1.3-contributor',
    countTextsV2: async (texts) => texts.map((text) => rule.countText(text)),
    countPayloadV2: async (shape) => {
      if (rule.finalOverride !== undefined && rule.finalOverride !== null) return { tokens: rule.finalOverride, object: 'response.input_tokens' };
      return { tokens: 432, object: 'response.input_tokens' };
    },
    buildMemoCounterV2: (table) => {
      if (!(table instanceof Map)) throw new Error('bad table');
      return Object.freeze({
        tokenizerFingerprint: remote.REMOTE_FINGERPRINT_V1,
        countText: (text) => {
          const hit = table.get(text);
          if (hit === undefined) throw new Error('remote-counter-memo-miss');
          return hit;
        },
      });
    },
  };
}
const byteRule = { countText: (text) => 1 + (Buffer.byteLength(text, 'utf8') % 11), finalOverride: 432 };
function healthyWithDigest(digest) {
  opencode.resetOpencodeHealthV2();
  opencode.markOpencodeHealthyV2({ provider: PROVIDER, model: MODEL }, { canaryDigest: digest || 'e'.repeat(64) });
}
// Production request shape at the llm/stream seam (captured from the real
// DSH loop's buildRequest): deep-frozen, session-bound, carries the live
// AbortSignal, and has NO routingAuthority/metadata keys.
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !(value instanceof AbortSignal) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
const BULK_MARKER = 'LEGACY-ASSISTANT-BULK-MARKER';
function prodRequestH(sessionId, extra) {
  const base = Object.assign({
    provider: PROVIDER, model: MODEL, reasoningEffort: 'xhigh', maxTokens: 2048,
    messages: [
      { id: 'msg-a0', role: 'assistant', content: [{ type: 'text', text: BULK_MARKER + ' '.repeat(4) + 'history.' }], source: { kind: 'model', provider: PROVIDER, model: MODEL } },
      { id: 'msg-u1', role: 'user', content: [{ type: 'text', text: TURN_TEXT }], source: { kind: 'user' } },
    ],
    system: SYSTEM_TEXT,
    tools: [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }],
    sessionId,
  }, extra || {});
  base.signal = new AbortController().signal;
  return deepFreeze(base);
}
async function* fakeChunks(tag) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: tag };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: tag } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
async function drainH(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}
// Drive one llm/stream listener the way cordis does: `this` is the
// dispatching LlmRuntime, next() takes no arguments.
async function runProjectionH(listener, request) {
  const dispatched = [];
  let nextCalls = 0;
  const nextStream = fakeChunks('legacy');
  const runtime = { stream: (derived) => { dispatched.push(derived); return fakeChunks('compiled'); } };
  const returned = listener.call(runtime, request, () => { nextCalls += 1; return nextStream; });
  const chunks = await drainH(returned);
  return { dispatched, nextCalls: () => nextCalls, returned, nextStream, chunks };
}
function userTurnCount(messages, text) {
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.content) if (block.type === 'text' && block.text.indexOf(text) !== -1) count += 1;
  }
  return count;
}
section('C08H-OCH-1 STARTUP + llm/stream PROJECTION (production request shape)');
{
  (async () => {
    const fx = makeFixtureRoot({ mode: 'active' });
    seedBindingH(fx, NSH.sessionId);
    stageMemoryH(fx);
    const started0 = host.startupOpencodeAuthorityV2({ storeRoot: storeRootOf(fx), installRoot: fx.root });
    check(started0.state === 'missing' && started0.health === 'QUARANTINED', 'empty store starts quarantined');
    const identity = host.currentOpencodeIdentityV2({ installRoot: fx.root });
    check(identity.known === true, 'fixture identity known');
    cert.certifyOpencodeV2(storeRootOf(fx), identity.identity, 'f'.repeat(64));
    const started1 = host.startupOpencodeAuthorityV2({ storeRoot: storeRootOf(fx), installRoot: fx.root });
    check(started1.state === 'valid' && started1.health === 'HEALTHY', 'certified store starts healthy (no trust flag)');

    // OFF / OBSERVE: verbatim next() reference, zero work, zero telemetry.
    for (const [label, sectionValue] of [['OFF', undefined], ['OBSERVE', { mode: 'observe' }]]) {
      const fxOff = makeFixtureRoot(sectionValue);
      seedBindingH(fxOff, NSH.sessionId);
      const logs = [];
      const offListener = host.createOpencodeProjectionStreamListenerV2({ installRoot: fxOff.root, bindingsPath: bindingsPathOf(fxOff), log: (e) => logs.push(e), metaRemoteCounter: mockRemoteCounter(byteRule) });
      const run = await runProjectionH(offListener, prodRequestH(NSH.sessionId));
      check(run.returned === run.nextStream && run.dispatched.length === 0 && run.nextCalls() === 1 && logs.length === 0, label + ' returns next() verbatim with zero compiler work and zero telemetry');
      wipe(fxOff);
    }

    const logs = [];
    const listener = host.createOpencodeProjectionStreamListenerV2({
      installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => logs.push(entry),
      metaRemoteCounter: mockRemoteCounter(byteRule),
    });
    // The OLD seam's value: agent/request resolves only the route config.
    const routeOnly = Object.freeze({ provider: PROVIDER, model: MODEL, maxTokens: 2048 });
    const routeRun = await runProjectionH(listener, routeOnly);
    check(routeRun.dispatched.length === 0 && routeRun.nextCalls() === 1, 'route-only config (agent/request shape) is never compiled');
    check(logs.length === 1 && logs[0].fallbackStage === 'request-shape' && logs[0].hasSessionId === false && logs[0].messagesIsArray === false, 'route-only config yields a TYPED request-shape fallback, never silence');
    logs.length = 0;

    const request = prodRequestH(NSH.sessionId);
    const run = await runProjectionH(listener, request);
    check(run.dispatched.length === 1 && run.nextCalls() === 0, 'eligible request re-dispatches ONE derived request; legacy stream never created');
    check(run.chunks.some((c) => c.text === 'compiled'), 'caller consumes the derived dispatch stream');
    const derived = run.dispatched[0];
    check(derived.metadata.projectionMode === 'CCV2_COMPILED', 'projectionMode = CCV2_COMPILED');
    check(derived.metadata.ccv2Authority === 'REMOTE_MUSE_PRECOUNT', 'authority marker present');
    check(Number.isInteger(derived.metadata.ccv2PreCount) && Number.isInteger(derived.metadata.ccv2Margin), 'pre-count + margin travel for the usage observer');
    check(['provider', 'model', 'reasoningEffort', 'maxTokens', 'system', 'tools', 'sessionId', 'signal'].every((key) => derived[key] === request[key]), 'route/reasoning/output cap/system/tools/session/signal carried by reference');
    check(derived.signal instanceof AbortSignal, 'derived request keeps the live AbortSignal (not a JSON husk)');
    check(Object.keys(derived).filter((k) => k !== 'metadata').sort().join(',') === Object.keys(request).sort().join(','), 'no request key added or dropped besides metadata');
    check(Object.isFrozen(derived) && Object.isFrozen(derived.messages), 'derived request is frozen');
    check(userTurnCount(derived.messages, TURN_TEXT) === 1, 'current user turn exists exactly once');
    check(JSON.stringify(derived.messages).indexOf(BULK_MARKER) === -1, 'legacy bulk does not survive in the compiled projection');
    check(logs.length === 1, 'exactly one decision event per request');
    const decided = logs[0] || {};
    check(decided.event === 'ccv2-opencode-active-decided' && decided.projectionMode === 'CCV2_COMPILED' && decided.fallbackReason === null, 'decision event: CCV2_COMPILED, fallbackReason null');
    check(decided.authority === 'REMOTE_MUSE_PRECOUNT' && decided.authorityHealth === 'HEALTHY' && decided.compilerExecutions === 1, 'decision event: REMOTE_MUSE_PRECOUNT / HEALTHY / compilerExecutions 1');
    check(decided.seam === 'llm/stream' && decided.policyMode === 'active' && decided.policyOrigin === 'config', 'decision event names seam + policy origin');

    const reentry = await runProjectionH(listener, derived);
    check(reentry.returned === reentry.nextStream && reentry.dispatched.length === 0 && logs.length === 1, 're-entry of the derived request is never projected again (no duplicate compiler execution)');
    const repeat = await runProjectionH(listener, request);
    check(repeat.returned === repeat.nextStream && logs.length === 1, 'one request object is projected at most once');

    const deep = await runProjectionH(listener, prodRequestH(NSH.sessionId, { provider: 'flash-max-direct', model: 'deepseek-v4-flash' }));
    check(deep.returned === deep.nextStream && deep.dispatched.length === 0 && logs.length === 1, 'non-opencode route passes through silently');
    const aux = await runProjectionH(listener, prodRequestH(NSH.sessionId, { purpose: 'compaction' }));
    check(aux.returned === aux.nextStream && logs.length === 1, 'auxiliary compaction call passes through');

    const unbound = await runProjectionH(listener, prodRequestH('sess-unbound'));
    check(unbound.returned === unbound.nextStream && logs[1].fallbackStage === 'binding' && logs[1].bindingFound === false, 'unbound session: typed binding fallback, verbatim stream');

    opencode.resetOpencodeHealthV2();
    const quar = await runProjectionH(listener, prodRequestH(NSH.sessionId));
    check(quar.returned === quar.nextStream && quar.dispatched.length === 0, 'quarantined authority never compiles');
    check(logs[2].fallbackReason === 'active-tokenizer-unavailable' && logs[2].fallbackStage === 'authority-health' && logs[2].authorityHealth === 'QUARANTINED', 'quarantine fallback is typed');

    const allLogs = JSON.stringify(logs);
    check(allLogs.indexOf(TURN_TEXT) === -1 && allLogs.indexOf(SYSTEM_TEXT) === -1 && allLogs.indexOf(BULK_MARKER) === -1 && allLogs.indexOf('inputSchema') === -1, 'decision events carry no prompt, message, system or tool content');
    wipe(fx);
    sectionsOCH2();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
function sectionsOCH2() {
  section('C08H-OCH-2 STREAM OBSERVER (usage-gated revoke)');
  ;(async () => {
    const fx = makeFixtureRoot({ mode: 'active' });
    seedBindingH(fx, NSH.sessionId);
    const storeRoot = storeRootOf(fx);
    cert.certifyOpencodeV2(storeRoot, host.currentOpencodeIdentityV2({ installRoot: fx.root }).identity, 'f'.repeat(64));
    host.startupOpencodeAuthorityV2({ storeRoot, installRoot: fx.root });
    const logged = [];
    const listener = host.createOpencodeStreamListenerV2({ installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => logged.push(entry) });
    const compiledRequest = (preCount, margin) => Object.freeze({
      provider: PROVIDER, model: MODEL, sessionId: NSH.sessionId,
      metadata: Object.freeze({ projectionMode: 'CCV2_COMPILED', ccv2Authority: 'REMOTE_MUSE_PRECOUNT', ccv2PreCount: preCount, ccv2Margin: margin }),
    });
    async function* fakeStream(chunks) {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    async function collect(stream) {
      const out = [];
      for await (const chunk of stream) out.push(chunk);
      return out;
    }
    const chunks = [{ type: 'text', text: 'a' }, { usage: { input_tokens: 100 } }, { type: 'text', text: 'b' }];
    const reqOk = compiledRequest(400, 8192);
    const wrapped = listener(reqOk, () => fakeStream(chunks));
    const seen = await collect(wrapped);
    check(JSON.stringify(seen) === JSON.stringify(chunks), 'chunks pass through byte-identical');
    check(host.startupOpencodeAuthorityV2({ storeRoot, installRoot: fx.root }).state === 'valid', 'in-bound usage does not revoke');
    const reqBad = compiledRequest(400, 8192);
    const badStream = listener(reqBad, () => fakeStream([{ usage: { input_tokens: 400 + 8192 + 1 } }]));
    await collect(badStream);
    const after = cert.readCertificationFileV2(storeRoot);
    check(after.present === true && after.certification !== null && after.certification.status === 'REVOKED', 'over-margin usage revokes durably');
    check(opencode.opencodeHealthV2({ provider: PROVIDER, model: MODEL }) === 'QUARANTINED', 'runtime health quarantined');
    check(host.startupOpencodeAuthorityV2({ storeRoot, installRoot: fx.root }).state === 'revoked', 'restart stays revoked');
    check(logged.some((entry) => entry && entry.event === 'ccv2-opencode-anomaly-revoked'), 'revocation logged without content');
    const legacyReq = liveRequestH(NSH.sessionId);
    const untouched = listener(legacyReq, () => fakeStream(chunks));
    check(untouched !== null, 'legacy requests bypass the observer');
    opencode.resetOpencodeHealthV2();
    wipe(fx);
    sectionsOCH3();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
function sectionsOCH3() {
  section('C08H-OCH-3 INSTALL + SECRET SAFETY');
  ;(async () => {
    const fx = makeFixtureRoot(undefined);
    const listeners = {};
    const ctx = { on: (event, fn, opts) => { (listeners[event] = listeners[event] || []).push(fn); return () => {}; }, shellEnv: { register() {} } };
    const installed = host.installOpencodeActiveProjection(ctx, { installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: () => {} });
    check(installed.installed === true, 'installer registers without throwing');
    check(listeners['agent/request'] === undefined, 'no listener on agent/request (that seam never carries messages/sessionId)');
    check(Array.isArray(listeners['llm/stream']) && listeners['llm/stream'].length === 2, 'exactly one projection + one usage observer on llm/stream');
    const second = host.installOpencodeActiveProjection(ctx, { installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: () => {} });
    check(second.reason === 'already-installed' && listeners['llm/stream'].length === 2, 'HMR-safe single install');
    const run = await runProjectionH(listeners['llm/stream'][0], prodRequestH(NSH.sessionId));
    check(run.returned === run.nextStream && run.dispatched.length === 0, 'default-off install leaves the stream reference-identical');
    const fxCert = makeFixtureRoot({ mode: 'active' });
    cert.certifyOpencodeV2(storeRootOf(fxCert), host.currentOpencodeIdentityV2({ installRoot: fxCert.root }).identity, 'f'.repeat(64));
    const certBytes = fs.readFileSync(path.join(storeRootOf(fxCert), 'opencode-muse-certification.json'), 'utf8');
    check(certBytes.indexOf(TURN_TEXT) === -1 && certBytes.indexOf('sk-') === -1 && certBytes.indexOf('Bearer') === -1, 'certification file carries no prompts or credentials');
    wipe(fxCert);
    wipe(fx);
    await sectionOCH1b();
    await sectionOCH4();
    await sectionOCH5();
    await sectionOCH6();
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveOpencodeHostV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
// ---------------------------------------------------------------------------
// OCH-4: the REAL pinned DSH loop (cordis + LlmRuntime + SessionStore +
// AgentLoop + package invariants) with the production installers: M01
// producer, Routing-Integrity, and installOpencodeActiveProjection. This is
// the production request seam the synthetic fixtures above cannot prove:
// agent/request only resolves {provider, model, maxTokens}; the complete
// frozen request exists only at llm/stream.
function resolveLoopHostH() {
  const { createRequire } = require('node:module');
  const roots = [];
  if (process.env.NEXUS_RUNTIME_ROOT) roots.push(process.env.NEXUS_RUNTIME_ROOT);
  roots.push(path.join(os.homedir(), '.local', 'share', 'nexus'));
  for (const root of roots) {
    const pkg = path.join(root, 'app', 'package.json');
    if (!fs.existsSync(path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-agent-loop'))) continue;
    try { return { root, appRequire: createRequire(pkg) }; } catch { /* keep searching */ }
  }
  return null;
}
async function sectionOCH4() {
  section('C08H-OCH-4 REAL DSH LOOP (production llm/stream seam, M01 producer, two turns)');
  const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
  const found = resolveLoopHostH();
  if (found === null) {
    liveGate.reportLiveHostGate('OCH-4', liveGate.decideLiveHostGate(false, process.env));
    console.log('SKIP: pinned DSH host tree is absent; the real-loop proof is PENDING (never faked).');
    return;
  }
  liveGate.reportLiveHostGate('OCH-4', 'EXECUTED');
  const { appRequire } = found;
  const { Context } = appRequire('@deepseek-ai/cordis');
  const llmMod = appRequire('@deepseek-ai/dsh-llm');
  const SessionStore = appRequire('@deepseek-ai/dsh-session').default;
  const SystemPrompt = appRequire('@deepseek-ai/dsh-system-prompt').default;
  const ToolRuntime = appRequire('@deepseek-ai/dsh-tools').default;
  const agentPackage = appRequire('@deepseek-ai/dsh-agent');
  const AgentLoop = appRequire('@deepseek-ai/dsh-agent-loop').default;
  const Invariants = appRequire('@deepseek-ai/dsh-invariants').default;
  const { pathToFileURL } = require('node:url');
  const appModules = path.join(found.root, 'app', 'node_modules', '@deepseek-ai');
  const llmInvariant = await import(pathToFileURL(path.join(appModules, 'dsh-llm', 'lib', 'invariant.js')).href);
  const loopInvariant = await import(pathToFileURL(path.join(appModules, 'dsh-agent-loop', 'lib', 'invariant.js')).href);
  const integrity = require(path.join(repoRoot, 'config', 'Routing-Integrity.cjs'));
  const profiles = require(path.join(repoRoot, 'config', 'Engineering-Profiles.cjs'));
  const producerHost = require(path.join(repoRoot, 'config', 'ContextMemoryProducerHostV2.cjs'));

  const fx = makeFixtureRoot({ mode: 'active' });
  seedBindingH(fx, NSH.sessionId);
  const binding = JSON.parse(fs.readFileSync(bindingsPathOf(fx), 'utf8')).bindings[NSH.sessionId];
  const stateFile = profiles.routingStatePath(fx.root, binding);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(Object.assign({}, binding, { profile: 'muse-spark-1.3-contributor', provider: PROVIDER, model: MODEL, reasoning: 'xhigh' })));
  cert.certifyOpencodeV2(storeRootOf(fx), host.currentOpencodeIdentityV2({ installRoot: fx.root }).identity, 'f'.repeat(64));
  opencode.resetOpencodeHealthV2();
  const previous = { home: process.env.DSH_HOME, root: process.env.AIH_INSTALL_ROOT };
  process.env.DSH_HOME = path.join(fx.root, 'data');
  process.env.AIH_INSTALL_ROOT = fx.root;
  const logs = [];
  const entered = [];
  const sent = [];
  let ctx = null;
  try {
    ctx = new Context();
    await ctx.plugin(Invariants);
    await ctx.plugin(llmMod.default);
    await ctx.plugin(llmInvariant);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SystemPrompt, { persona: 'OCH-4 real loop' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(agentPackage.default);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(loopInvariant);
    integrity.apply(ctx);
    const producer = producerHost.installMemoryProducer(ctx, {
      bindingFor: (id) => (id === NSH.sessionId ? binding : null),
      flush: async () => true,
      authorityFor: () => () => ({
        manifest: {
          schemaVersion: 1, taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, description: 'OCH-4 objective.',
          status: 'implementing', acceptanceCriteria: ['Compile turn two.'], verification: { required: [], outcomes: [] },
          failureSignatures: [], baseCommit: 'abc123',
        },
        authorityRecord: null,
      }),
      log: (entry) => logs.push(entry),
      env: {},
    });
    check(producer.installed === true, 'real M01 producer installed on the real ctx');
    // Records every request ENTERING the waterfall below the invariants
    // (the loop-built original and any re-dispatched derived request).
    ctx.on('llm/stream', (options, next) => { entered.push(options); return next(); }, { global: true });
    const installed = host.installOpencodeActiveProjection(ctx, {
      installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => logs.push(entry),
      sessionSourceFor: producer.registry.sessionSourceFor,
      metaRemoteCounter: mockRemoteCounter(byteRule),
    });
    check(installed.installed === true, 'production OpenCode installer ran on the real ctx');
    check(opencode.opencodeHealthV2({ provider: PROVIDER, model: MODEL }) === 'HEALTHY', 'startup certification load marks the route HEALTHY');
    // Terminal transport stub: the adapter boundary (what is actually sent).
    ctx.on('llm/stream', (options) => {
      sent.push(options);
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Acknowledged.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged.' } };
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    }, { global: true });
    const agent = ctx.agentLoop.create(NSH.sessionId, { provider: PROVIDER, model: MODEL, maxTokens: 2048 });
    const errors = [];
    ctx.on('agent/error', ({ error }) => { errors.push(String(error && error.message).slice(0, 200)); });
    async function turn(text) {
      const idle = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OCH-4 loop turn timed out')), 45000);
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve(); }
        });
      });
      agent.followup(llmMod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await idle;
      await producer.registry.idle(NSH.sessionId);
    }
    const decisions = () => logs.filter((entry) => entry && entry.event === 'ccv2-opencode-active-decided');

    // Turn 1: bootstrap. No sealed checkpoint yet -> typed LEGACY, verbatim.
    await turn('OCH-4 turn one: establish the task.');
    check(errors.length === 0, 'turn 1 completes without loop/invariant errors', errors.join(' | '));
    check(sent.length === 1 && entered.length === 1 && sent[0] === entered[0], 'turn 1 sends the loop-built request verbatim (bootstrap safe)');
    check(llmMod.isAgentLoopRequest(sent[0]), 'turn 1 transport request is the loop-built original');
    check(decisions().length === 1 && decisions()[0].projectionMode === 'LEGACY' && decisions()[0].fallbackStage === 'checkpoint'
      && decisions()[0].bindingFound === true && decisions()[0].checkpointFound === false, 'turn 1 emits a typed checkpoint fallback (not silence)', JSON.stringify(decisions()[0] || null));
    check(producer.registry.describe(NSH.sessionId).sealedGeneration === 1, 'M01 seals native generation 1 at turn/end');

    // Turn 2: usable sealed checkpoint + M01 coverage -> CCV2_COMPILED.
    await turn('OCH-4 turn two: continue the task.');
    check(errors.length === 0, 'turn 2 completes without loop/invariant errors', errors.join(' | '));
    const d2 = decisions()[1] || {};
    check(d2.projectionMode === 'CCV2_COMPILED', 'turn 2 projectionMode = CCV2_COMPILED', JSON.stringify(d2));
    check(d2.fallbackReason === null && d2.authority === 'REMOTE_MUSE_PRECOUNT' && d2.authorityHealth === 'HEALTHY' && d2.compilerExecutions === 1,
      'turn 2 fallbackReason null / REMOTE_MUSE_PRECOUNT / HEALTHY / compilerExecutions 1');
    check(decisions().length === 2, 'exactly one decision per root request (no duplicate compiler execution)');
    check(sent.length === 2, 'turn 2 dispatches the adapter exactly once');
    const original = entered[1];
    const derived = sent[1];
    check(entered.length === 3 && entered[2] === derived, 'derived request re-entered the waterfall below every transport guard');
    check(llmMod.isAgentLoopRequest(original) && !llmMod.isAgentLoopRequest(derived), 'loop-built original replaced by one derived request');
    check(derived.metadata && derived.metadata.projectionMode === 'CCV2_COMPILED' && derived.metadata.ccv2Authority === 'REMOTE_MUSE_PRECOUNT', 'transport request carries the compiled marker');
    check(['provider', 'model', 'reasoningEffort', 'maxTokens', 'system', 'tools', 'sessionId', 'signal'].every((key) => derived[key] === original[key]),
      'provider/model/reasoning/output cap/system/tools/session/signal unchanged (by reference)');
    check(derived.provider === PROVIDER && derived.model === MODEL && derived.sessionId === NSH.sessionId, 'route and session identity unchanged');
    check(derived.signal instanceof AbortSignal, 'live AbortSignal reaches the adapter');
    check(userTurnCount(derived.messages, 'OCH-4 turn two: continue the task.') === 1, 'current user turn exists exactly once');
    const originalIds = new Set(original.messages.map((m) => m.id));
    check(derived.messages.every((m) => !originalIds.has(m.id) && m.source && m.source.kind === 'ccv2-compiled'), 'no legacy message survives in the compiled projection');
    check(original.messages.length >= 3, 'turn 2 legacy request carried the turn-1 bulk', String(original.messages.length));
    const text = JSON.stringify(logs);
    check(text.indexOf('OCH-4 turn one') === -1 && text.indexOf('OCH-4 turn two') === -1 && text.indexOf('Acknowledged.') === -1, 'no prompt or message content in any log line');
  } finally {
    if (ctx) await ctx.fiber.dispose().catch(() => {});
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.root === undefined) delete process.env.AIH_INSTALL_ROOT; else process.env.AIH_INSTALL_ROOT = previous.root;
    opencode.resetOpencodeHealthV2();
    wipe(fx);
  }
}

// ---------------------------------------------------------------------------
// OCH-1b: blob-backed HOT/WARM exact material (B03 rehydrated evidence). The
// B03 proof brand is a module-private SYMBOL property; a JSON clone of the
// compile input drops it and the C02 gate rejects the material
// (context-compiler-evidence-binding-mismatch at planning-build). Every real
// session with a large tool result has such pages; the fixtures above had none.
async function sectionOCH1b() {
  section('C08H-OCH-1b BLOB-BACKED EXACT MATERIAL (B03 brand survives the attempt)');
  const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
  const fx = makeFixtureRoot({ mode: 'active' });
  seedBindingH(fx, NSH.sessionId);
  const { CP, memDir } = stageMemoryH(fx);
  const namespace = {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: fx.workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
  };
  const contextRoot = store.contextRootForV2(fx.workspace, NSH.taskId);
  const blob = store.putBlobV2(contextRoot, 'build step ok\ntests passed: 42\nBLOB-EXACT-EVIDENCE-MARKER\n');
  const blobPage = page.createContextPageV2({
    kind: 'verification', namespace, sourceKind: 'verification', sourceRefs: ['test-run:och1b:1'],
    mutability: 'immutable', sourceSeqs: [30], exactBlobRef: blob.blobRef, createdAtGeneration: 1,
  });
  store.putContextPageV2(contextRoot, blobPage, { expectedNamespace: namespace });
  fs.writeFileSync(path.join(memDir, 'pages', blobPage.id + '.json'), JSON.stringify(blobPage));
  const decisionsPath = path.join(memDir, 'tier-decisions.json');
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const blobDecision = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: blobPage, retentionRequired: true });
  check(blobDecision.tier === 'WARM', 'fixture: blob-backed page rests WARM (exact material required)');
  decisions.push(blobDecision);
  fs.writeFileSync(decisionsPath, JSON.stringify(decisions));
  void CP;
  cert.certifyOpencodeV2(storeRootOf(fx), host.currentOpencodeIdentityV2({ installRoot: fx.root }).identity, 'f'.repeat(64));
  host.startupOpencodeAuthorityV2({ storeRoot: storeRootOf(fx), installRoot: fx.root });
  const logs = [];
  const listener = host.createOpencodeProjectionStreamListenerV2({
    installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => logs.push(entry),
    metaRemoteCounter: mockRemoteCounter(byteRule),
  });
  const run = await runProjectionH(listener, prodRequestH(NSH.sessionId));
  const decided = logs[0] || {};
  check(decided.projectionMode === 'CCV2_COMPILED' && decided.fallbackReason === null && decided.compilerExecutions === 1,
    'request with blob-backed WARM exact material compiles', JSON.stringify({ stage: decided.fallbackStage, attempt: decided.attemptFailureStage, error: decided.attemptErrorClass }));
  check(run.dispatched.length === 1 && JSON.stringify(run.dispatched[0].messages).indexOf('BLOB-EXACT-EVIDENCE-MARKER') !== -1,
    'the blob page reaches the compiled projection with its exact bytes');
  check(JSON.stringify(logs).indexOf('BLOB-EXACT-EVIDENCE-MARKER') === -1, 'exact evidence bytes never reach the decision log');
  opencode.resetOpencodeHealthV2();
  wipe(fx);
}
// ---------------------------------------------------------------------------
// OCH-5: several mounted compositions in ONE real runtime. dsh-agent-presets
// mounts one standing composition per preset (and keeps superseded
// generations alive), each loading its OWN copy of the controller closure.
// llm/stream listeners are global (every copy sees every request) while
// session/event is scope-routed (only the joined composition sees a
// session). Exactly one decision per provider request, by the owner.
async function sectionOCH5() {
  section('C08H-OCH-5 MULTIPLE MOUNTED COMPOSITIONS (real dsh-scope routing, separate module copies)');
  const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
  const found = resolveLoopHostH();
  if (found === null) {
    liveGate.reportLiveHostGate('OCH-5', liveGate.decideLiveHostGate(false, process.env));
    console.log('SKIP: pinned DSH host tree is absent; the multi-mount proof is PENDING (never faked).');
    return;
  }
  liveGate.reportLiveHostGate('OCH-5', 'EXECUTED');
  const { appRequire } = found;
  const { pathToFileURL } = require('node:url');
  const { Context } = appRequire('@deepseek-ai/cordis');
  const llmMod = appRequire('@deepseek-ai/dsh-llm');
  const scope = await import(pathToFileURL(path.join(found.root, 'app', 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')).href);
  // A second, independent copy of the controller closure (what a second
  // preset directory or composition generation loads).
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c08oh-closure-'));
  for (const name of fs.readdirSync(path.join(repoRoot, 'config'))) {
    if (name.endsWith('.cjs') || name.endsWith('.json')) fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(copyDir, name));
  }
  const copies = {
    A: { host, producer: require(path.join(repoRoot, 'config', 'ContextMemoryProducerHostV2.cjs')) },
    B: { host: require(path.join(copyDir, 'ContextCompilerActiveOpencodeHostV2.cjs')), producer: require(path.join(copyDir, 'ContextMemoryProducerHostV2.cjs')) },
  };
  const failingCounter = Object.assign({}, mockRemoteCounter(byteRule), {
    countTextsV2: async () => { throw new Error('remote-counter-http-503: upstream unavailable'); },
  });
  async function runTwoMounts(sessionId, joinKey, counterFor) {
    const fx = makeFixtureRoot({ mode: 'active' });
    seedBindingH(fx, sessionId);
    const binding = JSON.parse(fs.readFileSync(bindingsPathOf(fx), 'utf8')).bindings[sessionId];
    cert.certifyOpencodeV2(storeRootOf(fx), host.currentOpencodeIdentityV2({ installRoot: fx.root }).identity, 'f'.repeat(64));
    const logs = [];
    const sent = [];
    const ctx = new Context();
    try {
      await ctx.plugin(llmMod.default);
      await ctx.plugin(appRequire('@deepseek-ai/dsh-session').default);
      await ctx.plugin(appRequire('@deepseek-ai/dsh-system-prompt').default, { persona: 'OCH-5 probe' });
      await ctx.plugin(appRequire('@deepseek-ai/dsh-tools').default);
      await ctx.plugin(appRequire('@deepseek-ai/dsh-agent').default);
      await ctx.plugin(appRequire('@deepseek-ai/dsh-agent-loop').default, { agents: [] });
      const keys = { A: { agentPreset: 'aih-muse', generation: 1 }, B: { agentPreset: 'aih-muse', generation: 2 } };
      const registries = {};
      for (const label of ['A', 'B']) {
        const mount = scope.createScope(ctx, keys[label]);
        const produced = copies[label].producer.installMemoryProducer(mount.ctx, {
          bindingFor: (id) => (id === sessionId ? binding : null), flush: async () => true,
          authorityFor: () => () => ({
            manifest: {
              schemaVersion: 1, taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, description: 'OCH-5 objective.',
              status: 'implementing', acceptanceCriteria: ['One decision.'], verification: { required: [], outcomes: [] },
              failureSignatures: [], baseCommit: 'abc123',
            },
            authorityRecord: null,
          }),
          log: (entry) => logs.push(Object.assign({ mount: label }, entry)), env: {},
        });
        registries[label] = produced.registry;
        copies[label].host.installOpencodeActiveProjection(mount.ctx, {
          installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => logs.push(Object.assign({ mount: label }, entry)),
          sessionSourceFor: produced.registry.sessionSourceFor, metaRemoteCounter: counterFor(),
        });
      }
      ctx.on('llm/stream', (options) => {
        sent.push(options);
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'Acknowledged.' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged.' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }, { global: true });
      const agent = ctx.agentLoop.create(sessionId, { provider: PROVIDER, model: MODEL, maxTokens: 2048 });
      if (joinKey !== null) scope.bindScopeParent(scope.scopeOf(agent.ctx), keys[joinKey]);
      for (const text of ['OCH-5 turn one.', 'OCH-5 turn two.']) {
        const idle = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('OCH-5 turn timed out')), 45000);
          const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
            if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve(); }
          });
        });
        agent.followup(llmMod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        await idle;
        for (const label of ['A', 'B']) await registries[label].idle(sessionId);
      }
      return { decisions: logs.filter((entry) => entry.event === 'ccv2-opencode-active-decided'), sent, logs };
    } finally {
      await ctx.fiber.dispose().catch(() => {});
      wipe(fx);
    }
  }
  const perRequest = (decisions) => {
    const counts = new Map();
    for (const decision of decisions) counts.set(decision.requestSeq, (counts.get(decision.requestSeq) || 0) + 1);
    return Array.from(counts.values());
  };
  for (const [owner, other] of [['A', 'B'], ['B', 'A']]) {
    const run = await runTwoMounts('sess-och5-owner-' + owner, owner, () => mockRemoteCounter(byteRule));
    const d = run.decisions;
    check(run.sent.length === 2, 'owner ' + owner + ': provider called exactly once per turn', String(run.sent.length));
    check(d.length === 2 && perRequest(d).every((n) => n === 1), 'owner ' + owner + ': exactly one decision per provider request', JSON.stringify(d.map((x) => [x.mount, x.requestSeq, x.fallbackStage])));
    check(d.every((x) => x.mount === owner), 'owner ' + owner + ': only the joined composition decides; ' + other + ' stays silent');
    check(new Set(d.map((x) => x.moduleInstanceId)).size === 1, 'owner ' + owner + ': decisions come from one module instance');
    check(d[0] && d[0].fallbackStage === 'checkpoint', 'owner ' + owner + ': turn 1 bootstrap is a typed checkpoint fallback');
    const t2 = d[1] || {};
    check(t2.projectionMode === 'CCV2_COMPILED' && t2.fallbackReason === null && t2.authority === 'REMOTE_MUSE_PRECOUNT'
      && t2.authorityHealth === 'HEALTHY' && t2.compilerExecutions === 1, 'owner ' + owner + ': turn 2 CCV2_COMPILED / null / REMOTE_MUSE_PRECOUNT / HEALTHY / 1', JSON.stringify(t2));
    check(run.sent[1] && run.sent[1].metadata && run.sent[1].metadata.projectionMode === 'CCV2_COMPILED', 'owner ' + owner + ': the ONE provider send in turn 2 is the compiled request');
    check(Number.isInteger(t2.derivedRequestSeq) && t2.derivedRequestSeq !== t2.requestSeq, 'owner ' + owner + ': derived request correlated, never re-decided by the other copy');
  }
  {
    // The live shape: the owner's attempt fails and falls through next();
    // the other composition must not produce a second decision.
    const run = await runTwoMounts('sess-och5-owner-fails', 'A', () => failingCounter);
    const d = run.decisions;
    check(run.sent.length === 2 && d.length === 2 && d.every((x) => x.mount === 'A'), 'owner attempt failure: still one decision per request, other copy silent', JSON.stringify(d.map((x) => [x.mount, x.requestSeq, x.fallbackStage])));
    const t2 = d[1] || {};
    check(t2.fallbackStage === 'attempt' && t2.attemptFailureStage === 'reserve-count' && t2.fallbackReason === 'active-tokenizer-unavailable',
      'owner attempt failure is typed down to the inner attempt stage', JSON.stringify(t2));
    check(t2.attemptErrorClass && t2.attemptErrorClass.messageCode === 'remote-counter-http-503' && t2.compilerExecutions === 0,
      'inner failure carries a structural error code and honest compilerExecutions');
    check(JSON.stringify(run.logs).indexOf('upstream unavailable') === -1 && JSON.stringify(run.logs).indexOf('OCH-5 turn') === -1,
      'no exception free text or message content in any log line');
    check(run.sent[1] && llmMod.isAgentLoopRequest(run.sent[1]), 'owner attempt failure sends the loop-built request verbatim');
  }
  {
    const run = await runTwoMounts('sess-och5-unowned', null, () => mockRemoteCounter(byteRule));
    const d = run.decisions;
    check(run.sent.length === 2 && d.length === 2 && perRequest(d).every((n) => n === 1) && d.every((x) => x.fallbackStage === 'ownership'),
      'no owning composition: exactly one typed ownership fallback per request (never silence, never two)', JSON.stringify(d.map((x) => [x.mount, x.requestSeq, x.fallbackStage])));
  }
  opencode.resetOpencodeHealthV2();
  fs.rmSync(copyDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// OCH-6 (CCV2-RC2): counter availability at the production seam. A REAL
// remote counter over a fault-injected transport replays the live sequence:
// compiled -> counter outage -> fast LEGACY -> cooldown -> exact cache hit ->
// recovery. LEGACY is always the verbatim original request.
async function sectionOCH6() {
  section('C08H-OCH-6 COUNTER RESILIENCE AT THE PRODUCTION SEAM');
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fx = makeFixtureRoot({ mode: 'active' });
  seedBindingH(fx, NSH.sessionId);
  stageMemoryH(fx);
  const storeRoot = storeRootOf(fx);
  cert.certifyOpencodeV2(storeRoot, host.currentOpencodeIdentityV2({ installRoot: fx.root }).identity, 'f'.repeat(64));
  host.startupOpencodeAuthorityV2({ storeRoot, installRoot: fx.root });
  const state = remote.createCounterResilienceV2({
    policy: { transientBackoffBaseMs: 2, rateLimitBackoffBaseMs: 2, backoffCapMs: 8, exhaustedCooldownMs: 150, operationDeadlineMs: 1500, payloadReserveMs: 400 },
    random: () => 0.5,
  });
  const COUNTER_KEY = 'meta-key-och6-SECRET-91c';
  let mode = 'ok';
  const httpCalls = [];
  const transport = {
    postJson: async (req) => {
      httpCalls.push(req.bodyJson);
      if (mode === 'down') return { status: 503, bodyText: '{"error":{"message":"overloaded ' + TURN_TEXT + '"}}' };
      const body = JSON.parse(req.bodyJson);
      const tokens = body.instructions !== undefined ? 432 : 1 + (Buffer.byteLength(String(body.input), 'utf8') % 11);
      return { status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: tokens }) };
    },
  };
  const descriptor = remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: MODEL });
  const counter = remote.createMuseRemoteCounterV2({ descriptor, apiKey: COUNTER_KEY, transport, resilience: state });
  const logs = [];
  const listener = host.createOpencodeProjectionStreamListenerV2({
    installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => logs.push(entry),
    metaRemoteCounter: counter, prewarmDelayMs: 0,
  });
  const turnRequest = (turn) => prodRequestH(NSH.sessionId, {
    messages: [
      { id: 'msg-a0', role: 'assistant', content: [{ type: 'text', text: BULK_MARKER + ' history.' }], source: { kind: 'model', provider: PROVIDER, model: MODEL } },
      { id: 'msg-u1', role: 'user', content: [{ type: 'text', text: turn }], source: { kind: 'user' } },
    ],
  });
  const decisionsOf = () => logs.filter((entry) => entry.event === host.DECISION_TELEMETRY_EVENT);
  const lastDecision = () => decisionsOf()[decisionsOf().length - 1] || {};
  const legacyChecks = (run, request, before, label) => {
    // next() takes no argument: the waterfall continues with the ORIGINAL
    // request object; the caller consumes exactly the legacy stream.
    check(run.dispatched.length === 0 && run.nextCalls() === 1 && run.chunks.length === 4 && run.chunks.some((c) => c.text === 'legacy') && !run.chunks.some((c) => c.text === 'compiled'), label + ': LEGACY continues next() once with the original request; no derived dispatch');
    check(snapshotOf(request) === before && Object.isFrozen(request), label + ': original request byte/structure-identical and still frozen');
  };

  // Live turn 2: compiled.
  const r1 = turnRequest('OCH-6 turn two.');
  const run1 = await runProjectionH(listener, r1);
  const d1 = lastDecision();
  check(run1.dispatched.length === 1 && d1.projectionMode === 'CCV2_COMPILED' && d1.authority === 'REMOTE_MUSE_PRECOUNT' && d1.authorityHealth === 'HEALTHY', 'healthy counter: CCV2_COMPILED / REMOTE_MUSE_PRECOUNT / HEALTHY');
  check(d1.counterSource === 'live' && d1.counterHttpRequests === httpCalls.length && d1.counterHttpRequests > d1.remoteCalls, 'decision line reports real HTTP requests (' + d1.counterHttpRequests + ') beside remoteCalls phases (' + d1.remoteCalls + ')');
  check(d1.counterConcurrencyLimit >= 1 && d1.counterGateState === 'CLEAR' && d1.cacheEpoch === 0 && Number.isInteger(d1.counterElapsedMs), 'decision line: limiter, gate, epoch, elapsed');
  await sleepMs(40);
  const prewarm1 = logs.filter((entry) => entry.event === host.PREWARM_TELEMETRY_EVENT);
  check(prewarm1.length === 1 && prewarm1[0].restaged === true && prewarm1[0].prewarmSkipped === null && prewarm1[0].prewarmCacheHits > 0, 'completed response schedules one background pre-warm (re-staged, mostly cached)');

  // Counter outage: reserve-count fails, fast LEGACY.
  mode = 'down';
  const r2 = turnRequest('OCH-6 turn three.');
  const before2 = snapshotOf(r2);
  const t2 = Date.now();
  const run2 = await runProjectionH(listener, r2);
  const d2 = lastDecision();
  legacyChecks(run2, r2, before2, 'outage');
  check(d2.fallbackReason === 'active-tokenizer-unavailable' && d2.fallbackStage === 'attempt' && d2.attemptFailureStage === 'reserve-count', 'outage: compatible fallbackReason at reserve-count');
  check(d2.counterFailureKind === 'counter-transient' && d2.counterHttpStatus === 503 && d2.counterAttempts === 3 && d2.counterExhaustReason === 'attempts', 'outage: safe class retained (transient/503/3 attempts)');
  check(Date.now() - t2 < 1500, 'outage: bounded by the counting deadline (' + (Date.now() - t2) + 'ms)');
  await sleepMs(40);
  const r3 = turnRequest('OCH-6 turn four.');
  const before3 = snapshotOf(r3);
  const run3 = await runProjectionH(listener, r3);
  legacyChecks(run3, r3, before3, 'second outage');
  check(lastDecision().counterGateState === 'COOLING', 'two exhausted compilations cool the counter gate');
  await sleepMs(40);
  const callsCooling = httpCalls.length;
  const r4 = turnRequest('OCH-6 turn five.');
  const before4 = snapshotOf(r4);
  const t4 = Date.now();
  const run4 = await runProjectionH(listener, r4);
  const d4 = lastDecision();
  legacyChecks(run4, r4, before4, 'cooling');
  check(d4.counterFailureKind === 'counter-gate-open' && d4.counterHttpRequests === 0 && httpCalls.length === callsCooling && Date.now() - t4 < 200, 'cooling + cache miss: immediate LEGACY with zero HTTP requests');
  // Identical content as turn 2 (a new request object): every count is an
  // exact cache hit, so the modified request is still exactly counted.
  const r1b = turnRequest('OCH-6 turn two.');
  const run1b = await runProjectionH(listener, r1b);
  const d1b = lastDecision();
  check(run1b.dispatched.length === 1 && d1b.projectionMode === 'CCV2_COMPILED' && d1b.counterSource === 'cache' && d1b.counterHttpRequests === 0 && httpCalls.length === callsCooling, 'cooling + exact cache hit: CCV2_COMPILED with zero HTTP (source cache)');
  check(run1b.dispatched[0].metadata.ccv2PreCount === run1.dispatched[0].metadata.ccv2PreCount && d1b.counterKind === 'REMOTE_EXACT', 'cache hit keeps REMOTE_EXACT and the identical authoritative pre-count');
  const prewarmSkips = logs.filter((entry) => entry.event === host.PREWARM_TELEMETRY_EVENT).map((entry) => entry.prewarmSkipped);
  check(prewarmSkips.indexOf('gate') !== -1, 'pre-warm is skipped while the gate cools (' + prewarmSkips.join(',') + ')');

  // Recovery: the probe after the cooldown resumes CCv2.
  mode = 'ok';
  await sleepMs(170);
  const r5 = turnRequest('OCH-6 turn six.');
  const run5 = await runProjectionH(listener, r5);
  const d5 = lastDecision();
  check(run5.dispatched.length === 1 && d5.projectionMode === 'CCV2_COMPILED' && d5.counterGateState === 'CLEAR', 'counter recovers: probe compiles, gate CLEAR');
  const allLogs = JSON.stringify(logs);
  check(allLogs.indexOf(COUNTER_KEY) === -1 && allLogs.indexOf('OCH-6 turn') === -1 && allLogs.indexOf(SYSTEM_TEXT) === -1
    && allLogs.indexOf(BULK_MARKER) === -1 && allLogs.indexOf('overloaded') === -1 && allLogs.indexOf('Bearer') === -1, 'decision + pre-warm lines carry no credential, prompt, evidence or response body');

  // Drift: provider usage above preCount + margin bumps the PROCESS epoch and
  // flushes every exact count (the certification revoke path is unchanged).
  const globalState = remote.processCounterResilienceV2();
  const driftTransport = { calls: 0, postJson: async () => { driftTransport.calls += 1; return { status: 200, bodyText: JSON.stringify({ input_tokens: 3 }) }; } };
  const globalCounter = remote.createMuseRemoteCounterV2({ descriptor, apiKey: COUNTER_KEY, transport: driftTransport });
  await globalCounter.countTextsV2(['drift-probe']);
  await globalCounter.countTextsV2(['drift-probe']);
  check(driftTransport.calls === 1, 'drift setup: count cached in the process state');
  const epochBefore = globalState.snapshotV2().cacheEpoch;
  const usageLogs = [];
  const observer = host.createOpencodeStreamListenerV2({ installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: (entry) => usageLogs.push(entry) });
  const compiledRequest = (preCount) => Object.freeze({
    provider: PROVIDER, model: MODEL, sessionId: NSH.sessionId,
    metadata: Object.freeze({ projectionMode: 'CCV2_COMPILED', ccv2Authority: 'REMOTE_MUSE_PRECOUNT', ccv2PreCount: preCount, ccv2Margin: 8192 }),
  });
  async function* usageStream(inputTokens) { yield { usage: { input_tokens: inputTokens } }; yield { usage: { input_tokens: inputTokens } }; }
  await drainH(observer(compiledRequest(500), () => usageStream(480)));
  const observed = usageLogs.filter((entry) => entry.event === host.USAGE_TELEMETRY_EVENT);
  check(observed.length === 1 && observed[0].preCountDrift === -20 && observed[0].withinMargin === true, 'usage observed once per request with preCountDrift');
  check(globalState.snapshotV2().cacheEpoch === epochBefore, 'in-bound usage never invalidates the cache');
  await drainH(observer(compiledRequest(500), () => usageStream(500 + 8192 + 1)));
  const anomaly = usageLogs.filter((entry) => entry.event === 'ccv2-opencode-anomaly-revoked');
  check(globalState.snapshotV2().cacheEpoch === epochBefore + 1, 'drift beyond the margin bumps cacheEpoch exactly once per request');
  check(anomaly.length >= 1 && anomaly[0].preCountDrift === 8193 && anomaly[0].cacheEpoch === epochBefore + 1, 'anomaly line carries preCountDrift and the new cacheEpoch');
  await globalCounter.countTextsV2(['drift-probe']);
  check(driftTransport.calls === 2, 'after drift the old cached count is not reused as authority');
  check(opencode.opencodeHealthV2({ provider: PROVIDER, model: MODEL }) === 'QUARANTINED', 'existing anomaly quarantine still fires');
  opencode.resetOpencodeHealthV2();
  wipe(fx);
}
