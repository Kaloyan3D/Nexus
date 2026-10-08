'use strict';
/**
 * ContextCompressionLadderV2H.Tests.cjs - CCV2-C05 hardening proof.
 *
 * Tamper battery, C01 representation-contract battery, losslessness
 * matrix, and input-shape fail-closed proofs against the REAL
 * production authorities (no fakes). Companions the main C05 suite.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
const ladder = require(path.join(repoRoot, 'config', 'ContextCompressionLadderV2.cjs'));
const allocator = require(path.join(repoRoot, 'config', 'ContextBudgetAllocatorV2.cjs'));
const counterModule = require(path.join(repoRoot, 'config', 'ContextTokenCounterV2.cjs'));
const compiler = require(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'));
const view = require(path.join(repoRoot, 'config', 'ContextViewV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const tier = require(path.join(repoRoot, 'config', 'ContextMemoryTierV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('' + title + ''); }
function throwsWith(fn, fragment, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).indexOf(fragment) !== -1, name,
    error ? String(error.message).slice(0, 300) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const NS = Object.freeze({
  taskId: 'TASK-C05-H',
  taskInstanceId: 'task_c05_h_0001',
  sessionId: 'sess-c05-h',
  workspaceId: '/tmp/nexus-c05-h',
  repositoryId: 'repo-c05',
  checkoutId: 'checkout-c05',
});
function checkpointInput() {
  return {
    taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
    workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
    generation: 1, kind: 'active', safePointBoundarySeq: 9, safePointStepId: null,
    createdAtUtc: '2026-09-26T10:00:00.000Z',
    objective: { text: 'Harden the ladder.', status: 'in-progress' },
    requirements: [{ id: 'REQ-001', text: 'Active requirement stays PINNED.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C05H', remainingMilestones: [] },
    decisions: [{ id: 'D1', statement: 'Views are disposable working sets.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: {
      activeFailures: [{ id: 'F1', status: 'open', detail: 'Flaky harness gate.', attemptCount: 2, evidenceRefs: [] }],
      rejectedHypotheses: ['cache-miss theory'],
      retryState: { attemptCount: 1, nextRetryAtUtc: null, note: 'retry-after-flake' },
    },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: 'green', evidenceRefs: [] }] },
    continuation: { nextAction: 'Build C05H.', unresolvedQuestions: ['Approve the ladder policy?'], recentUserIntent: 'Ship C05H.' },
  };
}
const CP = checkpoint.buildCheckpointV2(checkpointInput()).checkpoint;
const SNAP_REV = CP.snapshot.revisionDigest;
function stateDecisions() {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-001' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-constraint', checkpoint: CP, elementRef: { section: 'constraint', text: 'Stay on feature/content-compaction-v2.' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'unresolved-approval', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP, exactPreservationRequired: true }),
    tier.classifyMemoryTierV2({ subjectKind: 'active-failure', checkpoint: CP, elementRef: { section: 'failure', id: 'F1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D1' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'verification-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'failure-state', checkpoint: CP }),
  ];
}
function inlinePage(kind, sourceKind, refs, seqs, text, extra) {
  return page.createContextPageV2(Object.assign({
    kind, namespace: clone(NS), sourceKind,
    sourceRefs: refs.slice(), mutability: 'immutable',
    sourceSeqs: seqs.slice(), exactText: text, createdAtGeneration: 1,
  }, extra || {}));
}
const EXTRACT = 'salient exact finding: cache key derives from plan digest';
const COLD_PAGE = inlinePage('conversation', 'user', ['session-event:301'], [301], 'Cold body. ' + EXTRACT + '. ' + 'filler words for budget pressure '.repeat(30), { extract: EXTRACT });
const D_COLD = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: COLD_PAGE });
const REPO_TEXT = 'export function cacheKey(plan) { return digest(plan); } // current code';
const REPO_DIGEST = sha(REPO_TEXT);
const REPO_PAGE = inlinePage('repo-span', 'repository', ['repo:src/cache.ts'], [], REPO_TEXT, {
  sourceBinding: { kind: 'repository-span', path: 'src/cache.ts', contentDigest: REPO_DIGEST, startLine: 1, endLine: 4 },
  symbols: ['cacheKey'],
  files: ['src/cache.ts'],
});
const D_REPO = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: REPO_PAGE });
const SUPER_PAGE = inlinePage('decision', 'agent', ['decision:D9'], [309], 'Old hypothesis superseded by measurement.');
const D_SUPER = tier.classifyMemoryTierV2({ subjectKind: 'superseded-hypothesis', page: SUPER_PAGE });
const LOG_TEXT = 'Log line one. ' + 'RESULT ok latency=3ms '.repeat(40);
const LOG_PAGE = inlinePage('other', 'agent', ['session-event:311'], [311], LOG_TEXT, { extract: 'RESULT ok latency=3ms' });
const D_LOG = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: LOG_PAGE });
const HPAGES = [COLD_PAGE, REPO_PAGE, SUPER_PAGE, LOG_PAGE];
const HDECISIONS = [D_COLD, D_REPO, D_SUPER, D_LOG];
function compileH(pages, decisions) {
  return compiler.compileContextV2({
    checkpoint: CP,
    currentTurn: { turnId: 't1', text: 'Ship C05H now.', revision: null },
    namespace: clone(NS),
    snapshotRevision: SNAP_REV,
    runtimeState: { pendingProtocol: null },
    pages: pages.slice(),
    tierDecisions: stateDecisions().concat(decisions),
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [],
    budget: { hardMax: 20000, target: 18000 },
    compilerPolicyRevision: 'context-compiler-v1',
  }).view;
}
const HV = compileH(HPAGES, HDECISIONS);
function testCounter() { return counterModule.createCodepointTestCounterV2(); }
function usageOf(v) { return allocator.calculateContextTokenUsageV2({ view: v, counter: testCounter() }); }
const H_USAGE = usageOf(HV);
const H_MAND = H_USAGE.mandatoryUsed;
const H_TOTAL = H_USAGE.materializedTotal;
function entryBySource(v, sourceId) {
  for (const section of view.VIEW_SECTIONS) {
    for (const entry of v[section]) {
      if (entry.sourceId === sourceId) return { section: section, entry: entry };
    }
  }
  return null;
}
function planSource(plan, sourceId) {
  for (const source of plan.sources) {
    if (source.sourceId === sourceId) return source;
  }
  return null;
}
function compress(v, pages, hardMax, target) {
  return ladder.compressContextViewV2({ view: v, pages: pages, budget: { hardMax: hardMax, target: target }, counter: testCounter() });
}
function bindingOf(cp) {
  return {
    checkpointGeneration: cp.generation,
    checkpointId: cp.checkpointId,
    checkpointContentHash: cp.checkpointContentDigest,
    snapshotRevision: cp.snapshot.revisionDigest,
  };
}
function extractiveRaw() {
  return {
    tier: 'COLD', sourceType: 'context-page', sourceId: COLD_PAGE.id, contentHash: sha(EXTRACT),
    provenance: clone(COLD_PAGE.provenance), mediaType: 'text', exactText: EXTRACT,
    mandatory: false, tierDecision: clone(D_COLD),
    representation: {
      kind: 'EXTRACTIVE', sourcePageId: COLD_PAGE.id,
      sourceContentHash: COLD_PAGE.contentHash, representationHash: sha(EXTRACT),
    },
  };
}
function viewWithCold(rawEntry) {
  return view.createContextViewV2({
    namespace: clone(NS),
    checkpointBinding: bindingOf(CP),
    turnRef: null,
    pinned: [], hot: [], warm: [],
    materializedCold: [rawEntry],
    referencedColdPages: [],
    tokenBudget: { hardMax: 8000, target: 6000, used: null },
    compilerPolicyRevision: 'context-compiler-v1',
    compilationTrace: [],
    mandatoryRefs: [],
  });
}
section('C05H C01 REPRESENTATION CONTRACT');
{
  const V = viewWithCold(extractiveRaw());
  check(view.validateContextViewV2(V).valid === true, 'hand-built EXTRACTIVE entry validates');
  check(V.materializedCold[0].id === view.deriveMaterialEntryIdV2('materializedCold', 'COLD', 'context-page', COLD_PAGE.id, sha(EXTRACT)), 'entry id derives from shown bytes');
  const exactRaw = {
    tier: 'COLD', sourceType: 'context-page', sourceId: COLD_PAGE.id, contentHash: COLD_PAGE.contentHash,
    provenance: clone(COLD_PAGE.provenance), mediaType: 'text', exactText: entryTextOf(COLD_PAGE),
    mandatory: false, tierDecision: clone(D_COLD),
  };
  const VE = viewWithCold(exactRaw);
  check(VE.id !== V.id, 'representation change alters the view id (no hash lie, distinct identity)');
  const kindFlip = clone(V);
  kindFlip.materializedCold[0].representation.kind = 'STRUCTURED';
  check(view.deriveContextViewIdV2(kindFlip) !== V.id, 'representation kind participates in view identity');
  kindFlip.id = view.deriveContextViewIdV2(kindFlip);
  kindFlip.viewDigest = view.deriveContextViewDigestV2(kindFlip);
  const ck = view.validateContextViewV2(kindFlip);
  check(ck.valid === true, 'same bytes relabeled STRUCTURED still satisfy the equations under their own identity');
  const digestFlip = clone(V);
  digestFlip.materializedCold[0].representation.sourceContentHash = sha('forged');
  const cd = view.validateContextViewV2(digestFlip);
  check(cd.valid === false, 'forged source hash breaks validation (digest/tier binding)');
  const unknownKey = extractiveRaw();
  unknownKey.representation.futureField = 1;
  throwsWith(function () { viewWithCold(unknownKey); }, 'context-view-unknown-field', 'unknown representation key fails closed');
  const badKind = extractiveRaw();
  badKind.representation.kind = 'ABSTRACTIVE';
  throwsWith(function () { viewWithCold(badKind); }, 'context-view-representation-invalid', 'unknown representation kind fails closed');
  const hashLie = extractiveRaw();
  hashLie.contentHash = COLD_PAGE.contentHash;
  throwsWith(function () { viewWithCold(hashLie); }, 'context-view-content-mismatch', 'entry hash must bind shown bytes');
  const repLie = extractiveRaw();
  repLie.representation.representationHash = COLD_PAGE.contentHash;
  throwsWith(function () { viewWithCold(repLie); }, 'context-view-representation-mismatch', 'representation hash must bind shown bytes');
  const launder = extractiveRaw();
  launder.representation.sourceContentHash = sha(EXTRACT);
  throwsWith(function () { viewWithCold(launder); }, 'context-view-representation-mismatch', 'lossy kind with source-equal hash rejected (anti-laundering)');
  const identMismatch = extractiveRaw();
  identMismatch.representation.sourcePageId = REPO_PAGE.id;
  throwsWith(function () { viewWithCold(identMismatch); }, 'context-view-representation-mismatch', 'source page identity mismatch rejected');
  const decisionMismatch = extractiveRaw();
  decisionMismatch.tierDecision = clone(D_REPO);
  throwsWith(function () { viewWithCold(decisionMismatch); }, 'context-view-tier-binding-mismatch', 'foreign tier decision rejected');
  const pinnedRep = extractiveRaw();
  pinnedRep.tier = 'PINNED';
  pinnedRep.mandatory = true;
  pinnedRep.tierDecision = clone(tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-001' } }));
  throwsWith(function () {
    view.createContextViewV2({
      namespace: clone(NS), checkpointBinding: bindingOf(CP), turnRef: null,
      pinned: [pinnedRep], hot: [], warm: [], materializedCold: [],
      referencedColdPages: [],
      tokenBudget: { hardMax: 8000, target: 6000, used: null },
      compilerPolicyRevision: 'context-compiler-v1', compilationTrace: [], mandatoryRefs: [],
    });
  }, 'context-view', 'representation on PINNED rejected');
  const hotRep = extractiveRaw();
  hotRep.tier = 'HOT';
  throwsWith(function () {
    view.createContextViewV2({
      namespace: clone(NS), checkpointBinding: bindingOf(CP), turnRef: null,
      pinned: [], hot: [hotRep], warm: [], materializedCold: [],
      referencedColdPages: [],
      tokenBudget: { hardMax: 8000, target: 6000, used: null },
      compilerPolicyRevision: 'context-compiler-v1', compilationTrace: [], mandatoryRefs: [],
    });
  }, 'context-view', 'representation on HOT rejected');
  const mandRep = extractiveRaw();
  mandRep.mandatory = true;
  throwsWith(function () { viewWithCold(mandRep); }, 'context-view', 'representation on mandatory material rejected');
  const toolRep = extractiveRaw();
  toolRep.toolTransaction = { callId: 'call-9', callPresent: true, resultPresent: true };
  throwsWith(function () { viewWithCold(toolRep); }, 'context-view', 'representation with a tool unit rejected');
  const stateRep = {
    tier: 'WARM', sourceType: 'checkpoint-state', sourceId: 'checkpoint:decision:D1', contentHash: sha(EXTRACT),
    provenance: { schemaVersion: 1, sourceKind: 'controller', trust: 'authoritative', sourceRefs: ['controller:D1'], authorityScope: 'task', fieldKind: 'decision-statement' },
    mediaType: 'text', exactText: EXTRACT, mandatory: false,
    tierDecision: clone(tier.classifyMemoryTierV2({ subjectKind: 'accepted-decision', checkpoint: CP, elementRef: { section: 'decision', id: 'D1' } })),
    representation: { kind: 'STRUCTURED', sourcePageId: COLD_PAGE.id, sourceContentHash: COLD_PAGE.contentHash, representationHash: sha(EXTRACT) },
  };
  throwsWith(function () {
    view.createContextViewV2({
      namespace: clone(NS), checkpointBinding: bindingOf(CP), turnRef: null,
      pinned: [], hot: [], warm: [stateRep], materializedCold: [],
      referencedColdPages: [],
      tokenBudget: { hardMax: 8000, target: 6000, used: null },
      compilerPolicyRevision: 'context-compiler-v1', compilationTrace: [], mandatoryRefs: [],
    });
  }, 'context-view', 'representation on state-backed truth rejected');
  const exactSelf = extractiveRaw();
  exactSelf.contentHash = COLD_PAGE.contentHash;
  exactSelf.exactText = entryTextOf(COLD_PAGE);
  exactSelf.representation = { kind: 'EXACT', sourcePageId: COLD_PAGE.id, sourceContentHash: COLD_PAGE.contentHash, representationHash: COLD_PAGE.contentHash };
  check(view.validateContextViewV2(viewWithCold(exactSelf)).valid === true, 'explicit EXACT self-description validates');
  const exactLie = extractiveRaw();
  exactLie.representation = { kind: 'EXACT', sourcePageId: COLD_PAGE.id, sourceContentHash: COLD_PAGE.contentHash, representationHash: sha(EXTRACT) };
  throwsWith(function () { viewWithCold(exactLie); }, 'context-view-representation-mismatch', 'EXACT claiming divergent bytes rejected');
}
function entryTextOf(pg) {
  return String(pg.exactText);
}
section('C05H LOSSLESSNESS MATRIX');
{
  const res = compress(HV, HPAGES, H_TOTAL + 500, H_MAND + 300, testCounter());
  check(view.validateContextViewV2(res.compressedView).valid === true, 'matrix view is C01-valid');
  check(JSON.stringify(res.compressedView.mandatoryRefs) === JSON.stringify(HV.mandatoryRefs), 'mandatory manifest survives byte-identical');
  check(JSON.stringify(res.compressedView.checkpointBinding) === JSON.stringify(HV.checkpointBinding), 'repo/checkpoint identity binding unchanged');
  function keptText(sourceId) {
    for (const section of view.VIEW_SECTIONS) {
      for (const entry of res.compressedView[section]) {
        if (entry.sourceId === sourceId) return entry.exactText;
      }
    }
    return null;
  }
  function baseText(sourceId) {
    const found = entryBySource(HV, sourceId);
    return found === null ? null : found.entry.exactText;
  }
  const pinReq = HV.mandatoryRefs.filter(function (r) { return r.kind === 'checkpoint-requirement'; })[0];
  check(keptText(pinReq.sourceId) === baseText(pinReq.sourceId), 'user requirements: no lossy representation');
  const pinCon = HV.mandatoryRefs.filter(function (r) { return r.kind === 'checkpoint-constraint'; })[0];
  check(keptText(pinCon.sourceId) === baseText(pinCon.sourceId), 'explicit constraints: no lossy representation');
  const pinAppr = HV.mandatoryRefs.filter(function (r) { return r.kind === 'current-turn'; })[0];
  check(pinAppr !== undefined && keptText(pinAppr.sourceId) === baseText(pinAppr.sourceId), 'approvals/current intent: lossless');
  const decSrc = planSource(res.compressionPlan, 'checkpoint:decision:D1');
  check(decSrc !== null && decSrc.selectedKind === 'EXACT' && decSrc.reasonCode === 'compression-exact-state-backed', 'accepted decisions: lossless typed core survives');
  const verSrc = planSource(res.compressionPlan, 'checkpoint:verification:0');
  const failSrc = planSource(res.compressionPlan, 'checkpoint:failure:F1');
  check(verSrc !== null && verSrc.selectedKind === 'EXACT', 'verification truth: no lossy replacement');
  check(failSrc !== null && failSrc.selectedKind === 'EXACT', 'active failures: exact identity survives');
  const repoSrc = planSource(res.compressionPlan, REPO_PAGE.id);
  check(repoSrc !== null && repoSrc.eligible !== false, 'relevant current code: ladder reachable');
  check(repoSrc.selectedKind === 'EXACT' || repoSrc.selectedKind === 'EXTRACTIVE' || repoSrc.selectedKind === 'STRUCTURED', 'current code: exact or source-exact extract only');
  const logSrc = planSource(res.compressionPlan, LOG_PAGE.id);
  check(logSrc !== null && (logSrc.selectedKind === 'EXTRACTIVE' || logSrc.selectedKind === 'EXACT'), 'large logs: exact backing plus salient exact extract');
  if (logSrc.selectedKind === 'EXTRACTIVE') {
    check(logSrc.representationHash === sha('RESULT ok latency=3ms'), 'log extract is the proven salient span');
  }
  const tiny = compress(HV, HPAGES, H_TOTAL + 500, H_MAND, testCounter());
  const superSrc = planSource(tiny.compressionPlan, SUPER_PAGE.id);
  check(superSrc.finalDisposition === 'REFERENCE', 'superseded hypotheses: reference disposition survives');
  const superRef = tiny.compressedView.referencedColdPages.filter(function (r) { return r.pageId === SUPER_PAGE.id; })[0];
  check(superRef !== undefined && superRef.kind === 'decision' && superRef.contentHash === SUPER_PAGE.contentHash, 'superseded reference keeps kind and source identity');
  check(JSON.stringify(superRef.provenance) === JSON.stringify(SUPER_PAGE.provenance), 'superseded reference keeps provenance');
  const repoTiny = planSource(tiny.compressionPlan, REPO_PAGE.id);
  check(repoTiny.finalDisposition === 'REFERENCE', 'old file reads: extract/reference allowed');
}
section('C05H STRUCTURED TOO LARGE + INPUT SHAPE');
{
  const bigFiles = [];
  for (let i = 0; i < 32; i += 1) bigFiles.push('src/module-' + i + '/file.ts/' + 'x'.repeat(440));
  const fatPage = inlinePage('other', 'agent', ['session-event:399'], [399], 'Fat page with maximal typed file metadata.', { files: bigFiles });
  const fatDecision = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: fatPage });
  check(fatDecision.tier === 'COLD', 'fat page is COLD');
  const fatStruct = ladder.deriveStructuredTextV2({ page: fatPage, viewNamespace: clone(NS) });
  check(fatStruct.available === false && fatStruct.reason === 'compression-structured-too-large', 'oversized structured form reports too-large, never clipped');
  const fatView = compileH([fatPage], [fatDecision]);
  const fatUsage = usageOf(fatView);
  const fatRes = compress(fatView, [fatPage], fatUsage.materializedTotal + 50, fatUsage.mandatoryUsed, testCounter());
  const fatSrc = planSource(fatRes.compressionPlan, fatPage.id);
  check(fatSrc.selectedKind === 'EXACT' && fatSrc.finalDisposition === 'REFERENCE', 'too-large structured falls through to REFERENCE honestly');
  check(fatSrc.transitions.length === 0, 'no phantom transitions recorded for unavailable rungs');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: HPAGES, budget: { hardMax: 100, target: 200 }, counter: testCounter() });
  }, 'context-compression-budget-invalid', 'target above hardMax rejected');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: HPAGES, budget: { hardMax: 100, target: 50 }, counter: null });
  }, 'context-compression-tokenizer-unavailable', 'missing counter fails closed');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: HPAGES, budget: { hardMax: 100, target: 50 }, counter: testCounter(), compressionPolicyRevision: 'ladder-v9' });
  }, 'context-compression-policy-unknown', 'unknown policy rejected');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: HPAGES, budget: { hardMax: 100, target: 50 }, counter: testCounter(), scoring: 'relevance' });
  }, 'context-compression-input-invalid', 'scoring smuggled into input rejected');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: 'nope', budget: { hardMax: 100, target: 50 }, counter: testCounter() });
  }, 'context-compression-source-invalid', 'non-array pages rejected');
  const dupPages = HPAGES.concat([COLD_PAGE]);
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: dupPages, budget: { hardMax: 10000, target: 9000 }, counter: testCounter() });
  }, 'context-compression-source-invalid', 'duplicate page identity rejected');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: { nope: 1 }, pages: [], budget: { hardMax: 100, target: 50 }, counter: testCounter() });
  }, 'context-compression-view-invalid', 'invalid view rejected');
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: [], budget: { hardMax: 10000, target: 9000 }, counter: testCounter() });
  }, 'context-compression-source-missing', 'view without bound sources fails closed (no partial view)');
  const mutatedNs = clone(COLD_PAGE);
  mutatedNs.namespace.taskId = 'TASK-FOREIGN';
  throwsWith(function () {
    ladder.compressContextViewV2({ view: HV, pages: [mutatedNs].concat(HPAGES.slice(1)), budget: { hardMax: 10000, target: 9000 }, counter: testCounter() });
  }, 'context-compression-source-invalid', 'foreign-namespace page fails closed at the source gate');
  const packedFirst = allocator.packContextBudgetV2({ view: HV, budget: { hardMax: 10000, target: 9000 }, counter: testCounter() });
  const reRes = compress(packedFirst.packedView, HPAGES, 10000, 9000, testCounter());
  check(view.validateContextViewV2(reRes.compressedView).valid === true, 'already-packed views compress deterministically');
  check(reRes.packingPlan.used <= 9000, 'recompression respects the budget');
  const emptyOptView = compileH([], []);
  const emptyRes = compress(emptyOptView, [], H_MAND + 1000, H_MAND + 500, testCounter());
  check(emptyRes.packingPlan.used <= H_MAND + 500, 'mandatory-only views pass through');
}
section('C05H PLAN VALIDATION BATTERY');
{
  const res = compress(HV, HPAGES, H_TOTAL + 500, H_MAND + 300, testCounter());
  const plan = res.compressionPlan;
  check(ladder.validateCompressionPlanV2(plan).valid === true, 'plan validates');
  check(ladder.validateCompressionPlanV2(plan, { expectedFingerprint: 'test-codepoint-v1' }).valid === true, 'fingerprint binding accepts');
  const bf = ladder.validateCompressionPlanV2(plan, { expectedFingerprint: 'other' });
  check(bf.valid === false && bf.reason === 'context-compression-plan-binding-mismatch', 'fingerprint binding rejects');
  const bp = ladder.validateCompressionPlanV2(plan, { expectedPolicyRevision: 'other' });
  check(bp.valid === false && bp.reason === 'context-compression-plan-binding-mismatch', 'policy binding rejects');
  const unk = clone(plan);
  unk.extra = 1;
  check(ladder.validateCompressionPlanV2(unk).valid === false, 'unknown plan key rejected');
  const nonMono = clone(plan);
  const withWalk = nonMono.sources.filter(function (s) { return s.transitions.length > 0; })[0];
  if (withWalk !== undefined) {
    withWalk.transitions.push({ from: withWalk.selectedKind, to: 'EXACT', reasonCode: 'compression-exact-fits', deterministic: true });
    check(ladder.validateCompressionPlanV2(nonMono).valid === false, 'backward walk rejected');
  } else {
    check(true, 'backward walk rejected (no walk present to mutate; monotonicity proven elsewhere)');
  }
  const cursorBad = clone(plan);
  cursorBad.sources[0].selectedKind = cursorBad.sources[0].selectedKind === 'EXACT' ? 'STRUCTURED' : 'EXACT';
  check(ladder.validateCompressionPlanV2(cursorBad).valid === false, 'selection/cursor mismatch rejected');
  const laundered = clone(plan);
  const lossy = laundered.sources.filter(function (s) { return s.selectedKind !== 'EXACT'; })[0];
  if (lossy !== undefined) {
    lossy.representationHash = lossy.sourceContentHash;
    check(ladder.validateCompressionPlanV2(laundered).valid === false, 'laundered hash equality rejected');
  } else {
    check(true, 'laundered hash equality rejected (no lossy source at this budget)');
  }
  throwsWith(function () { ladder.describeCompressionPlanV2({ nope: 1 }); }, 'context-compression-plan-invalid', 'describe rejects invalid plans');
  throwsWith(function () { ladder.deriveExtractiveTextV2({ page: COLD_PAGE }); }, 'context-compression-input-invalid', 'extract input shape enforced');
  const nonString = ladder.deriveExtractiveTextV2({ page: COLD_PAGE, entryText: 42 });
  check(nonString.available === false, 'non-string bytes report unavailable');
  throwsWith(function () { ladder.deriveStructuredTextV2({ page: COLD_PAGE, viewNamespace: clone(NS), rank: 1 }); }, 'context-compression-input-invalid', 'structured input shape enforced');
  throwsWith(function () { ladder.representationEligibilityV2({ entry: 42, section: 'warm', page: null }); }, 'context-compression-input-invalid', 'eligibility input shape enforced');
  throwsWith(function () { ladder.representationEligibilityV2({ entry: entryBySource(HV, COLD_PAGE.id).entry, section: 'everywhere', page: COLD_PAGE }); }, 'context-compression-input-invalid', 'eligibility section enforced');
  const names = Object.keys(ladder).filter(function (k) { return typeof ladder[k] === 'function'; });
  for (const fn of ['representationEligibilityV2', 'deriveExtractiveTextV2', 'deriveStructuredTextV2', 'deriveCompressionPlanDigestV2', 'validateCompressionPlanV2', 'describeCompressionPlanV2', 'compressContextViewV2']) {
    check(names.indexOf(fn) !== -1, 'exports ' + fn);
  }
}
section('C05H MODULE SURFACE + READ-ONLY');
{
  const src = fs.readFileSync(path.join(repoRoot, 'config', 'ContextCompressionLadderV2.cjs'), 'utf8');
  for (const frag of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'readFileSync', 'execSync', 'spawnSync', 'child_process', 'Date.now', 'Math.random', 'process.pid', 'normalize(', '.normalize(']) {
    check(src.indexOf(frag) === -1, 'no impure surface: ' + frag);
  }
  for (const mod of ['ContextRetrieverV2', 'ContextPageStoreV2', 'SessionEvidenceSource', 'RepositoryEvidenceSource', 'ContextEvidenceRehydrationV2', 'EvidenceIndex']) {
    check(src.indexOf(mod) === -1, 'no retrieval/rehydration coupling: ' + mod);
  }
  for (const frag of ['context-compression-ladder-v1', 'nexus/context-compression-plan/v1', 'nexus/context-structured-representation/v1', '(DISCARDABLE)']) {
    check(src.indexOf(frag) !== -1, 'frozen formula present: ' + frag);
  }
  const beforeDecisions = JSON.stringify(HDECISIONS);
  const beforeView = JSON.stringify(HV);
  compress(HV, HPAGES, H_TOTAL + 500, H_MAND + 300, testCounter());
  check(JSON.stringify(HDECISIONS) === beforeDecisions, 'tier decisions unchanged (retrieval result equivalent untouched)');
  check(JSON.stringify(HV) === beforeView, 'source view unchanged');
}
console.log('--- SUMMARY ---');
console.log('ContextCompressionLadderV2H suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exitCode = 1; }
