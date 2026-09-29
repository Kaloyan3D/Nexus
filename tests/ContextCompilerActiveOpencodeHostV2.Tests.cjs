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
section('C08H-OCH-1 STARTUP + REQUEST WRAPPER');
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
    const offListener = host.createOpencodeRequestListenerV2({ installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: () => {} });
    const reqOff = liveRequestH(NSH.sessionId);
    const outOff = await offListener({}, async () => reqOff);
    check(outOff === reqOff, 'wrapper returns resolved reference (policy off in fixture)');
    const fxActive = makeFixtureRoot({ mode: 'active' });
    seedBindingH(fxActive, NSH.sessionId);
    stageMemoryH(fxActive);
    cert.certifyOpencodeV2(storeRootOf(fxActive), host.currentOpencodeIdentityV2({ installRoot: fxActive.root }).identity, 'f'.repeat(64));
    host.startupOpencodeAuthorityV2({ storeRoot: storeRootOf(fxActive), installRoot: fxActive.root });
    const listener = host.createOpencodeRequestListenerV2({
      installRoot: fxActive.root, bindingsPath: bindingsPathOf(fxActive), log: () => {},
      metaRemoteCounter: mockRemoteCounter(byteRule),
    });
    const request = liveRequestH(NSH.sessionId);
    const before = snapshotOf(request);
    const outcome = await listener({}, async () => request);
    check(outcome.metadata.projectionMode === 'CCV2_COMPILED', 'wrapper replaces bulk via certified authority');
    check(outcome.metadata.ccv2Authority === 'REMOTE_MUSE_PRECOUNT', 'authority marker present');
    check(Number.isInteger(outcome.metadata.ccv2PreCount) && Number.isInteger(outcome.metadata.ccv2Margin), 'pre-count + margin travel for the observer');
    check(snapshotOf(request) === before, 'source request untouched');
    check(outcome.provider === PROVIDER && outcome.model === MODEL, 'route unchanged');
    const deepReq = liveRequestH(NSH.sessionId, TURN_TEXT, { provider: 'flash-max-direct', model: 'deepseek-v4-flash' });
    deepReq.routingAuthority = { source: 'controller', target: { provider: 'flash-max-direct', model: 'deepseek-v4-flash' } };
    const deepOut = await listener({}, async () => deepReq);
    check(deepOut === deepReq, 'non-opencode route passes through');
    opencode.resetOpencodeHealthV2();
    const quarOut = await listener({}, async () => liveRequestH(NSH.sessionId));
    check(quarOut.metadata === undefined || quarOut.metadata.projectionMode !== 'CCV2_COMPILED', 'quarantined wrapper never compiles');
    wipe(fx);
    wipe(fxActive);
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
    check(Array.isArray(listeners['agent/request']) && listeners['agent/request'].length === 1, 'exactly one request wrapper');
    check(Array.isArray(listeners['llm/stream']) && listeners['llm/stream'].length === 1, 'exactly one stream observer');
    const second = host.installOpencodeActiveProjection(ctx, { installRoot: fx.root, bindingsPath: bindingsPathOf(fx), log: () => {} });
    check(second.reason === 'already-installed' && listeners['agent/request'].length === 1, 'HMR-safe single install');
    const req = liveRequestH(NSH.sessionId);
    const out = await listeners['agent/request'][0]({}, async () => req);
    check(out === req, 'default-off install leaves requests reference-identical');
    const fxCert = makeFixtureRoot({ mode: 'active' });
    cert.certifyOpencodeV2(storeRootOf(fxCert), host.currentOpencodeIdentityV2({ installRoot: fxCert.root }).identity, 'f'.repeat(64));
    const certBytes = fs.readFileSync(path.join(storeRootOf(fxCert), 'opencode-muse-certification.json'), 'utf8');
    check(certBytes.indexOf(TURN_TEXT) === -1 && certBytes.indexOf('sk-') === -1 && certBytes.indexOf('Bearer') === -1, 'certification file carries no prompts or credentials');
    wipe(fxCert);
    wipe(fx);
    console.log(String.fromCharCode(10) + 'ContextCompilerActiveOpencodeHostV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
