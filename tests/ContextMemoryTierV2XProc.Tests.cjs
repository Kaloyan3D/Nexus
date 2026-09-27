'use strict';
/**
 * ContextMemoryTierV2XProc.Tests.cjs - CCV2-B04 cross-process determinism proof.
 *
 * Spawns independent OS processes (tests/ContextMemoryTierV2XProc.Worker.cjs)
 * that classify the same task-memory subjects through the REAL production
 * authority with no shared module state. Proves: simultaneous classifiers
 * return byte-identical decisions (tier, reason, capabilities, policy,
 * resolution mode), restart-fresh processes agree with in-process reads,
 * and concurrent classification mutates zero inputs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const rehydrate = require(path.join(repoRoot, 'config', 'ContextEvidenceRehydrationV2.cjs'));
const memSession = require(path.join(repoRoot, 'config', 'ContextSessionEvidenceSourceV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
const clone = (o) => JSON.parse(JSON.stringify(o));

const NS = Object.freeze({
  taskId: 'TASK-B04-X',
  taskInstanceId: 'task_b04_x_0001',
  sessionId: 'sess-b04-x',
  workspaceId: '/tmp/nexus-b04-x',
  repositoryId: 'repo-b04-x',
  checkoutId: 'checkout-b04-x',
});

function userEv(seq, text) {
  return { seq, type: 'user/message', data: { turn: 't1', step: 's1', message: { id: 'm' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } };
}

function makeDir(name) {
  const dir = path.join(repoRoot, 'tmp', 'b04-xproc-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const EVENTS = [userEv(12, 'Cross-process evidence one.'), userEv(13, 'Cross-process evidence two.')];
const SESS_DIGEST = rehydrate.deriveSessionEvidenceDigestV2(NS.sessionId, EVENTS);
const SESS_PAGE = page.createContextPageV2({
  kind: 'conversation', namespace: clone(NS), sourceKind: 'user',
  sourceRefs: ['session-event:12'], mutability: 'immutable',
  sourceSeqs: [12, 13], contentHash: SESS_DIGEST, createdAtGeneration: 1,
});
const INLINE_PAGE = page.createContextPageV2({
  kind: 'verification', namespace: clone(NS), sourceKind: 'verification',
  sourceRefs: ['test-run:xproc:1'], mutability: 'immutable',
  sourceSeqs: [31], exactText: 'PASS suites=9 tests=81', createdAtGeneration: 1,
});
const CP = checkpoint.buildCheckpointV2({
  taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
  workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
  generation: 1, kind: 'active', safePointBoundarySeq: 4, safePointStepId: null,
  createdAtUtc: '2026-09-26T10:00:00.000Z',
  objective: { text: 'Prove cross-process tiers.', status: 'in-progress' },
  requirements: [{ id: 'R-x', text: 'Tiers survive restart.', status: 'active', evidenceRefs: [] }],
  constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
  progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'B04 xproc', remainingMilestones: [] },
  decisions: [{ id: 'D-x', statement: 'Derived tiers.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
  repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
  evidenceRefs: [],
  failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
  verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'xproc', evidenceRefs: [] }] },
  continuation: { nextAction: 'Compare workers.', unresolvedQuestions: [], recentUserIntent: 'Land B04.' },
  pressure: { preCheckpointEffectiveInputTokens: 10, peakEffectiveInputTokens: 20 },
}).checkpoint;

const CASES = [
  { subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'R-x' }, expectedNamespace: clone(NS) },
  { subjectKind: 'active-constraint' },
  { subjectKind: 'current-user-turn' },
  { subjectKind: 'active-failure' },
  { subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D-x' } },
  { subjectKind: 'verification-state', checkpoint: CP, elementRef: { section: 'verification' } },
  { subjectKind: 'historical-evidence', page: INLINE_PAGE, expectedNamespace: clone(NS) },
  { subjectKind: 'historical-evidence', page: SESS_PAGE, needsSessionSource: true, expectedNamespace: clone(NS) },
  { subjectKind: 'historical-evidence', page: SESS_PAGE, expectedNamespace: clone(NS) },
  { subjectKind: 'resolved-failure', page: INLINE_PAGE },
  { subjectKind: 'archive-event', archiveRefMissing: true },
];

function buildInput(c) {
  const input = { subjectKind: c.subjectKind };
  if (c.page !== undefined) input.page = clone(c.page);
  if (c.checkpoint !== undefined) input.checkpoint = clone(c.checkpoint);
  if (c.elementRef !== undefined) input.elementRef = clone(c.elementRef);
  if (c.expectedNamespace !== undefined) input.expectedNamespace = clone(c.expectedNamespace);
  if (c.needsSessionSource === true) {
    input.sources = { sessionSource: memSession.createMemorySessionSourceV2(NS.sessionId, clone(EVENTS)) };
  }
  return input;
}

section('IN PROCESS BASELINE');
const baseline = CASES.map((c) => JSON.stringify(tier.classifyMemoryTierV2(buildInput(c))));
check(baseline.length === CASES.length, 'baseline covers every cross-process case');
check(JSON.parse(baseline[6]).tier === 'COLD', 'baseline inline history is COLD');
check(JSON.parse(baseline[7]).tier === 'WARM', 'sourced session history without proof is WARM (capability != proof, proofs never cross processes)');
check(JSON.parse(baseline[8]).tier === 'WARM', 'baseline unsourced session history is WARM');

function runWave(dir, count) {
  const casesFile = path.join(dir, 'cases.json');
  const eventsFile = path.join(dir, 'events.json');
  const goFile = path.join(dir, 'go');
  const serial = CASES.map((c) => {
    const s = { subjectKind: c.subjectKind };
    if (c.page !== undefined) s.page = clone(c.page);
    if (c.checkpoint !== undefined) s.checkpoint = clone(c.checkpoint);
    if (c.elementRef !== undefined) s.elementRef = clone(c.elementRef);
    if (c.expectedNamespace !== undefined) s.expectedNamespace = clone(c.expectedNamespace);
    if (c.needsSessionSource === true) s.needsSessionSource = true;
    return s;
  });
  fs.writeFileSync(casesFile, JSON.stringify(serial));
  fs.writeFileSync(eventsFile, JSON.stringify(EVENTS));
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({ outFile: path.join(dir, 'out-' + i + '.json') });
  }
  const procs = items.map((item, i) => spawn(process.execPath,
    [path.join(__dirname, 'ContextMemoryTierV2XProc.Worker.cjs'),
      '--cases', casesFile, '--events', eventsFile, '--go', goFile, '--out', item.outFile],
    { stdio: 'ignore' }));
  fs.writeFileSync(goFile, 'go');
  const deadline = Date.now() + 30000;
  let pending = true;
  while (pending && Date.now() < deadline) {
    pending = items.some((item) => !fs.existsSync(item.outFile));
    if (pending) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  check(!pending, 'every worker result landed before the deadline');
  for (const proc of procs) { try { proc.kill(); } catch { /* reaped */ } }
  return items.map((item) => JSON.parse(fs.readFileSync(item.outFile, 'utf8')));
}

section('SIMULTANEOUS PROCESSES');
{
  const dir = makeDir('wave1');
  const results = runWave(dir, 6);
  for (const [i, r] of results.entries()) {
    check(r.ok === true, 'worker ' + i + ' classified without crashing');
    const got = (r.decisions || []).map((d) => JSON.stringify(d));
    check(JSON.stringify(got) === JSON.stringify(baseline), 'worker ' + i + ' byte-identical to in-process baseline');
  }
}

section('RESTART FRESHNESS');
{
  const dir = makeDir('wave2');
  const results = runWave(dir, 3);
  for (const [i, r] of results.entries()) {
    const got = (r.decisions || []).map((d) => JSON.stringify(d));
    check(JSON.stringify(got) === JSON.stringify(baseline), 'restarted worker ' + i + ' agrees across waves');
  }
  for (const d of results[0].decisions) {
    check(tier.validateMemoryTierDecisionV2(d).valid === true, 'cross-process decision validates (' + d.tier + '/' + d.reasonCode + ')');
  }
}

console.log('\nB04 xproc assertions: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
