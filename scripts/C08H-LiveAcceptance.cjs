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
const regMod = require(path.join(repoRoot, 'config', 'ContextTokenizerRegistryV2.cjs'));
const host = require(path.join(repoRoot, 'config', 'ContextCompilerActiveHostV2.cjs'));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
const NSH = { taskId: 'TASK-C08D-LIVE', taskInstanceId: 'task_c08d_live_0001', sessionId: 'sess-c08d-live', repositoryId: 'repo-c08d', checkoutId: 'co-c08d' };
const TURN_TEXT = 'Confirm the live acceptance turn with real counting.';
const SYSTEM_TEXT = 'You are the Nexus host-contract system prompt.';
const PROVIDER = 'flash-max-direct';
const MODEL = 'deepseek-v4-flash';
const MAX_TOKENS = 512;
const API_HOST = 'api.deepseek.com';
const API_PATH = '/chat/completions';
function checkpointInputH(workspace) {
  return {
    taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
    workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Prove live provider activation.', status: 'in-progress' },
    requirements: [{ id: 'REQ-L1', text: 'Live route compiles with real tokens.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C08H live', remainingMilestones: [] },
    decisions: [{ id: 'D-L1', statement: 'Live fallback stays safe.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F-L1', status: 'open', detail: 'Flaky gate.', attemptCount: 1, evidenceRefs: [] }],
      rejectedHypotheses: ['stale theory'], retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Attempt live C08H.', unresolvedQuestions: ['Approve?'], recentUserIntent: 'Ship C08H live.' },
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
    repositoryRevision: { headCommit: 'abc123', indexDigest: sha('c08l:index'), worktreeDigest: sha('c08l:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, '2026-09-26T10:00:00.000Z');
}
function stageMemoryH(workspace) {
  const raw = checkpointInputH(workspace);
  const built = checkpoint.buildCheckpointV2(Object.assign({}, raw, { snapshotToken: snapshotTokenForH(raw) }));
  const memDir = path.join(workspace, '.ai-harness', 'ccv2', NSH.taskId);
  const persisted = checkpoint.persistCheckpointV2(path.join(memDir, 'checkpoints'), { checkpoint: built.checkpoint, serialized: built.serialized });
  const inlinePage = (kind, sourceKind, refs, seqs, text) => page.createContextPageV2({
    kind, namespace: {
      taskId: NSH.taskId, taskInstanceId: NSH.taskInstanceId, sessionId: NSH.sessionId,
      workspaceId: workspace, repositoryId: NSH.repositoryId, checkoutId: NSH.checkoutId,
    },
    sourceKind, sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  });
  const COLD = inlinePage('decision', 'agent', ['decision:H9'], [40], 'Historical host note for live framing audit. '.repeat(30));
  const TOOL = inlinePage('tool-result', 'tool', ['tool-event:call-l7'], [7, 8], 'exit 0 settled live tool log. '.repeat(8));
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
  return { CP, memDir };
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
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c08h-live-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'c08h-live-ws-'));
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
      preset: 'aih-engineering', engine: 'dual',
    };
    fs.writeFileSync(bindingsPath, JSON.stringify(doc));
    stageMemoryH(workspace);
    const request = {
      provider: PROVIDER, model: MODEL, reasoningEffort: 'max', maxTokens: MAX_TOKENS,
      system: SYSTEM_TEXT,
      messages: [{ id: 'msg-u1', role: 'user', content: [{ type: 'text', text: TURN_TEXT }], source: { kind: 'user' } }],
      tools: [],
      routingAuthority: { source: 'controller', target: { provider: PROVIDER, model: MODEL } },
      sessionId: NSH.sessionId, metadata: { taskId: NSH.taskId, turnId: 'live' },
    };
    const policy = host.resolveActivePolicyV2({ installRoot: root });
    const outcome = host.applyActiveProjectionV2({
      request, policy, installRoot: repoRoot, bindingsPath,
    });
    const record = {
      provider: PROVIDER,
      model: MODEL,
      capabilityRevision: 'model-context-capability-v1',
      tokenizerFingerprint: outcome.telemetry ? outcome.telemetry.tokenizerFingerprint : null,
      contextWindow: 131072,
      requestedOutputReserve: MAX_TOKENS,
      projectionMode: outcome.mode,
      fallback: outcome.mode !== 'CCV2_COMPILED',
      fallbackReason: outcome.fallbackReason,
      viewId: outcome.decision ? outcome.decision.view.id : null,
      layoutDigest: outcome.decision ? outcome.decision.layout.layoutDigest : null,
      renderDigest: outcome.decision ? outcome.decision.render.renderDigest : null,
      hostTokens: outcome.telemetry ? outcome.telemetry.hostPrefixTokens : null,
      ccv2Tokens: outcome.telemetry ? outcome.telemetry.ccv2Tokens : null,
      toolSchemaTokens: outcome.telemetry ? outcome.telemetry.toolSchemaTokens : null,
      framingTokens: outcome.telemetry ? outcome.telemetry.framingTokens : null,
      finalInputTokens: outcome.telemetry ? outcome.telemetry.finalInputTokens : null,
      framedInputTokens: outcome.framed ? outcome.framed.framedInputTokens : null,
    };
    console.log('C08H-LIVE-RECORD ' + JSON.stringify(record));
    if (outcome.mode !== 'CCV2_COMPILED') {
      console.log('C08H-LIVE conclusion: no compiled projection (fallback=' + outcome.fallbackReason + '); live send not attempted.');
      cleanup();
      process.exitCode = 1;
      return;
    }
    if (typeof apiKey !== 'string' || apiKey === '') {
      console.log('CCV2-C08H — BLOCKED');
      console.log('blocker: missing DEEPSEEK_API_KEY (no credentials configured; no network call attempted, nothing faked)');
      cleanup();
      process.exitCode = 2;
      return;
    }
    const derived = outcome.request;
    const systemTexts = [derived.system];
    for (const message of derived.messages) {
      if (message.role === 'system') {
        for (const block of message.content) {
          if (block && block.type === 'text') systemTexts.push(block.text);
        }
      }
    }
    let userTurn = '';
    for (const message of derived.messages) {
      if (message.role === 'user') {
        for (const block of message.content) {
          if (block && block.type === 'text') userTurn += block.text;
        }
      }
    }
    const payload = {
      model: MODEL,
      messages: [{ role: 'system', content: systemTexts.join('') === '' ? '' : systemTexts.join(String.fromCharCode(10, 10)) }, { role: 'user', content: userTurn }],
      max_tokens: MAX_TOKENS,
      stream: false,
    };
    let response = null;
    try {
      response = await postJson(API_HOST, API_PATH, apiKey, payload, 120000);
    } catch (error) {
      console.log('C08H-LIVE conclusion: transport failure (not a CCv2 defect): ' + String((error && error.message) || error).slice(0, 200));
      cleanup();
      process.exitCode = 2;
      return;
    }
    if (response.status !== 200) {
      console.log('C08H-LIVE conclusion: provider HTTP ' + response.status + ' (external blocker, not a CCv2 defect): ' + String(response.text).slice(0, 300));
      cleanup();
      process.exitCode = 2;
      return;
    }
    let body = null;
    try {
      body = JSON.parse(response.text);
    } catch (error) {
      console.log('C08H-LIVE conclusion: provider returned non-JSON (external blocker).');
      cleanup();
      process.exitCode = 2;
      return;
    }
    const usage = body && body.usage ? body.usage : null;
    const completionLength = body && body.choices && body.choices[0] && body.choices[0].message && typeof body.choices[0].message.content === 'string'
      ? body.choices[0].message.content.length : null;
    console.log('C08H-LIVE-USAGE ' + JSON.stringify({
      promptTokens: usage ? usage.prompt_tokens : null,
      completionTokens: usage ? usage.completion_tokens : null,
      framedLocalTokens: outcome.framed ? outcome.framed.framedInputTokens : null,
      completionChars: completionLength,
      model: body ? body.model : null,
    }));
    console.log('CCV2-C08H — Real Provider Activation VERIFIED');
    cleanup();
    process.exitCode = 0;
  } catch (error) {
    console.log('C08H-LIVE conclusion: harness failure: ' + String((error && error.message) || error).slice(0, 300));
    cleanup();
    process.exitCode = 1;
  }
}
main();
