'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const snapshotMod = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const capMod = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
const host = require(path.join(repoRoot, 'config', 'ContextCompilerActiveHostV2.cjs'));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
const ROUTES = {
  opencode: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor', apiKeyEnv: 'OPENCODE_API_KEY', host: 'opencode.ai', api: 'responses' },
  meta: { provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', apiKeyEnv: 'MODEL_API_KEY', host: 'api.meta.ai', api: 'completions' },
};
const NSH = { taskId: 'TASK-C08M-LIVE', taskInstanceId: 'task_c08m_live_0001', sessionId: 'sess-c08m-live', repositoryId: 'repo-c08m', checkoutId: 'co-c08m' };
const TURN_TEXT = 'Confirm the Muse live acceptance turn.';
const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function stageMemoryH(workspace) {
  const raw = {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove Muse live activation.', status: 'in-progress' },
    requirements: [{ id: 'REQ-L1', text: 'Muse route activates.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H Muse live', remainingMilestones: [] },
    decisions: [{ id: 'D-L1', statement: 'Live fallback stays safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-L1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt Muse live.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship Muse live.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08ml:index'), worktreeDigest: sha('c08ml:worktree') },
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
  const COLD = mk('decision', 'agent', ['decision:H9'], [40], 'Historical host note for Muse live audit. '.repeat(30));
  const TOOL = mk('tool-result', 'tool', ['tool-event:call-l7'], [7, 8], 'exit 0 settled Muse live tool log. '.repeat(8));
  const pagesDir = path.join(memDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const pg of [COLD, TOOL]) fs.writeFileSync(path.join(pagesDir, pg.id + '.json'), JSON.stringify(pg));
  const CP = persisted.checkpoint;
  const decisions = [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-L1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F-L1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-L1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: COLD }),
    tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TOOL, immediateRelevance: true }),
  ];
  fs.writeFileSync(path.join(memDir, 'tier-decisions.json'), JSON.stringify(decisions));
  fs.writeFileSync(path.join(memDir, 'tool-transactions.json'), JSON.stringify([{ pageId: TOOL.id, callId: 'call-l7', callSeq: 7, resultSeq: 8 }]));
}
function postJson(hostname, reqPath, apiKey, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname, path: reqPath, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + apiKey },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => { req.destroy(new Error('live-transport-timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
async function main() {
  const which = arg('--route') || 'opencode';
  const route = ROUTES[which] || null;
  if (route === null) {
    console.log('C08H-MUSE-LIVE conclusion: unknown --route (use opencode|meta).');
    process.exitCode = 1;
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c08m-live-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c08m-live-ws-'));
  const cleanup = () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (ignored) { void ignored; }
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (ignored2) { void ignored2; }
  };
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'routing'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'routing-policy.json'), JSON.stringify({ version: 3, contextCompiler: { mode: 'active' } }));
    fs.writeFileSync(path.join(root, 'data', 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }));
    const bindingsPath = path.join(root, 'data', 'routing', 'session-bindings.json');
    const doc = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
    doc.bindings[NSH.sessionId] = {
      sessionId: NSH.sessionId, taskInstanceId: NSH.taskInstanceId, taskId: NSH.taskId,
      workspace, workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
      preset: 'aih-muse', engine: 'muse',
    };
    fs.writeFileSync(bindingsPath, JSON.stringify(doc));
    stageMemoryH(workspace);
    const request = {
      provider: route.provider, model: route.model, reasoningEffort: 'xhigh', maxTokens: 32768,
      system: SYSTEM_TEXT,
      messages: [{ id: 'msg-u1', role: 'user', content: [{ type: 'text', text: TURN_TEXT }], source: { kind: 'user' } }],
      tools: [],
      routingAuthority: { source: 'controller', target: { provider: route.provider, model: route.model } },
      sessionId: NSH.sessionId, metadata: { taskId: NSH.taskId, turnId: 'live' },
    };
    const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
    const museActive = require(path.join(repoRoot, 'config', 'ContextCompilerActiveMuseV2.cjs'));
    const shadowHost = require(path.join(repoRoot, 'config', 'ContextCompilerShadowHostV2.cjs'));
    const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
    const apiKey = process.env[route.apiKeyEnv];
    const descriptor = remote.resolveMuseRemoteV2({ provider: route.provider, model: route.model });
    if (descriptor === null) {
      let classification = 'UNVERIFIED';
      if (typeof apiKey === 'string' && apiKey !== '') {
        try {
          const probed = await postJson('opencode.ai', '/zen/go/v1/responses/input_tokens', apiKey,
            { model: route.model, input: 'probe' }, 30000);
          if (probed.status === 200) {
            let okShape = false;
            try {
              const parsed = JSON.parse(probed.text);
              okShape = parsed !== null && typeof parsed === 'object' && Number.isInteger(parsed.input_tokens);
            } catch (ignored) { void ignored; }
            classification = okShape === true ? 'SUPPORTED' : 'UNSUPPORTED';
          } else if (probed.status === 401 || probed.status === 403) {
            classification = 'AUTH BLOCKED';
          } else if (probed.status === 404) {
            classification = 'UNSUPPORTED';
          }
        } catch (error) {
          classification = 'UNVERIFIED';
        }
      }
      console.log('C08H-MUSE-RECORD ' + JSON.stringify({
        route: which, provider: route.provider, model: route.model,
        projectionMode: 'LEGACY', fallback: true, fallbackReason: 'active-tokenizer-unavailable',
        countEndpoint: classification,
      }));
      console.log('CCV2-C08H-MUSE — BLOCKED');
      console.log('blocker: opencode count endpoint ' + classification + ' (no registered remote authority; explicit registration required)');
      cleanup();
      process.exitCode = 2;
      return;
    }
    if (typeof apiKey !== 'string' || apiKey === '') {
      console.log('C08H-MUSE-RECORD ' + JSON.stringify({
        route: which, provider: route.provider, model: route.model,
        counterFingerprint: remote.REMOTE_FINGERPRINT_V1,
        projectionMode: 'LEGACY', fallback: true, fallbackReason: 'active-tokenizer-unavailable',
      }));
      console.log('CCV2-C08H-MUSE — BLOCKED');
      console.log('blocker: missing ' + route.apiKeyEnv + ' (remote authority verified, key absent; no network call attempted, nothing faked)');
      cleanup();
      process.exitCode = 2;
      return;
    }
    const memDir = require('node:path').join(workspace, '.ai-harness', 'ccv2', NSH.taskId);
    const triple = { taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId };
    const sealedFound = shadowHost.readSealedCheckpointForTaskV2(memDir);
    if (sealedFound.sealed === null) throw new Error('staged checkpoint unreadable');
    const sealed = sealedFound.sealed;
    const stagedPages = shadowHost.readStagedPagesV2(memDir, triple);
    const stagedDecisions = shadowHost.readStagedDecisionsV2(memDir, triple);
    const stagedTx = shadowHost.readStagedToolTransactionsV2(memDir);
    if (stagedPages.pages === null || stagedDecisions.decisions === null || stagedTx.transactions === null) {
      throw new Error('staged memory unreadable');
    }
    const MAX_TOKENS = 512;
    const compileInput = {
      checkpoint: sealed,
      currentTurn: { turnId: 'live', text: TURN_TEXT, revision: null },
      namespace: {
        taskId: sealed.taskId, taskInstanceId: sealed.taskInstanceId, sessionId: sealed.sessionId,
        workspaceId: sealed.workspaceId, repositoryId: sealed.repositoryId, checkoutId: sealed.checkoutId,
      },
      snapshotRevision: sealed.snapshot.revisionDigest,
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
      checkpointGeneration: sealed.generation, checkpointId: sealed.checkpointId,
      snapshotRevision: sealed.snapshot.revisionDigest,
      turnId: 'live', turnTextHash: sha(TURN_TEXT),
      provider: route.provider, model: route.model,
      maxTokens: MAX_TOKENS, outputReserve: MAX_TOKENS,
      counterFingerprint: remote.REMOTE_FINGERPRINT_V1, counterRevision: remote.REMOTE_REVISION_V1,
    };
    const remoteCounter = remote.createMuseRemoteCounterV2({ descriptor, apiKey });
    const decision = await museActive.attemptMuseActiveV2({
      compileInput,
      pages: stagedPages.pages,
      remoteCounter,
      route: { provider: route.provider, model: route.model, maxContextTokens: 1048576 },
      requestTerms: { systemText: SYSTEM_TEXT, turnText: TURN_TEXT, maxTokens: MAX_TOKENS, outputReserve: MAX_TOKENS },
      binding,
      getCurrentRevision: () => shadowHost.readSealedRevisionForTaskV2(memDir),
    });
    console.log('C08H-MUSE-RECORD ' + JSON.stringify({
      route: which, provider: route.provider, model: route.model,
      counterFingerprint: remote.REMOTE_FINGERPRINT_V1,
      contextWindow: 1048576, requestedOutputReserve: MAX_TOKENS,
      projectionMode: decision.mode, fallback: decision.mode !== 'CCV2_COMPILED',
      fallbackReason: decision.fallbackReason,
      viewId: decision.view ? decision.view.id : null,
      layoutDigest: decision.layout ? decision.layout.layoutDigest : null,
      renderDigest: decision.render ? decision.render.renderDigest : null,
      preCount: decision.preCount,
    }));
    if (decision.eligible !== true) {
      const external = decision.fallbackReason === 'active-tokenizer-unavailable';
      console.log('CCV2-C08H-MUSE — ' + (external === true ? 'BLOCKED' : 'DEFECT'));
      console.log((external === true ? 'blocker' : 'defect') + ': attempt fell back (' + decision.fallbackReason + ')');
      cleanup();
      process.exitCode = external === true ? 2 : 1;
      return;
    }
    const apiKeyLive = apiKey;
    void apiKeyLive;
    const poster = (req) => postJson(req.hostname, req.reqPath, req.apiKey, JSON.parse(req.bodyJson), req.timeoutMs);
    const sent = await museActive.sendMuseCompiledV2({
      decision,
      liveBinding: decision.binding,
      inferenceBody: decision.inferenceBody,
      inferencePost: poster,
      apiKey,
      hostname: 'api.meta.ai',
      reqPath: '/v1/responses',
      timeoutMs: 120000,
    });
    console.log('C08H-MUSE-USAGE ' + JSON.stringify({
      sent: sent.sent,
      external: sent.external,
      reason: sent.reason,
      preCount: sent.preCount,
      promptTokens: sent.usage ? sent.usage.promptTokens : null,
      outputTokens: sent.usage ? sent.usage.outputTokens : null,
      usageMatch: sent.usageMatch,
    }));
    if (sent.sent !== true) {
      console.log('CCV2-C08H-MUSE — ' + (sent.external === true ? 'BLOCKED' : 'DEFECT'));
      console.log('send failed: ' + sent.reason + ' (external=' + sent.external + ')');
      cleanup();
      process.exitCode = sent.external === true ? 2 : 1;
      return;
    }
    if (sent.usageMatch !== true) {
      console.log('CCV2-C08H-MUSE — DEFECT');
      console.log('defect: provider usage does not match the pre-count (pre=' + sent.preCount + ' in=' + (sent.usage ? sent.usage.promptTokens : null) + ')');
      cleanup();
      process.exitCode = 1;
      return;
    }
    console.log('CCV2-C08H-MUSE — Real EMv2 Muse Activation VERIFIED');
    cleanup();
    process.exitCode = 0;
  } catch (error) {
    console.log('C08H-MUSE conclusion: harness failure: ' + String((error && error.message) || error).slice(0, 300));
    cleanup();
    process.exitCode = 1;
  }
}
main();
