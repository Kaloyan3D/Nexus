'use strict';
/**
 * ContextCompilerV2H.Tests.cjs - CCV2-C02H open-protocol hardening proof.
 *
 * Freezes the distinction the C02 report left ambiguous:
 *   OPEN / PENDING protocol (call emitted, result not committed)
 *     = continuation-critical runtime state, never model-facing
 *   COMPLETED transaction (call + matching result, call before result)
 *     = exact balanced evidence unit, materializable
 * Proves against the REAL production authorities (no fakes):
 * config/ContextCompilerV2.cjs over frozen A03 checkpoints, A06
 * safe-point semantics (consumed, never modified), B01 pages, B03
 * balance semantics (mirrored, never re-resolved), B04 tier decisions,
 * and the C01 ContextView contract (unmodified) as the final gate.
 * Covers: completed call/result materialization with explicit matched
 * bindings, pending/result-pending/call-open blocking with
 * context-compiler-protocol-open, wrong-result and result-before-call
 * rejection, no balancing by seq count alone, conflicting bindings,
 * no-synthetic-result source proof, prompt-projection safety, the
 * mandatory-for-continuation vs legal-materialization distinction, and
 * C01 non-interaction (one-sided units still rejected there).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '..');
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
const NS = Object.freeze({
  taskId: 'TASK-C02H-A',
  taskInstanceId: 'task_c02h_a_0001',
  sessionId: 'sess-c02h-a',
  workspaceId: '/tmp/nexus-c02h-a',
  repositoryId: 'repo-c02h',
  checkoutId: 'checkout-c02h',
});
function inlineToolPage(callId, callSeq, resultSeq, text) {
  return page.createContextPageV2({
    kind: 'tool-result', namespace: clone(NS), sourceKind: 'tool',
    sourceRefs: ['tool-event:' + callId], mutability: 'immutable',
    sourceSeqs: [callSeq, resultSeq], exactText: text, createdAtGeneration: 1,
  });
}
const CP = checkpoint.buildCheckpointV2({
  taskId: NS.taskId, taskInstanceId: NS.taskInstanceId, sessionId: NS.sessionId,
  workspaceId: NS.workspaceId, repositoryId: NS.repositoryId, checkoutId: NS.checkoutId,
  generation: 1, kind: 'active', safePointBoundarySeq: 22, safePointStepId: null,
  createdAtUtc: '2026-09-26T10:00:00.000Z',
  objective: { text: 'Harden open protocol semantics.', status: 'in-progress' },
  requirements: [{ id: 'REQ-H', text: 'Pending calls never render as results.', status: 'active', evidenceRefs: [] }],
  constraints: [],
  progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'C02H', remainingMilestones: [] },
  decisions: [],
  repository: { repositoryId: NS.repositoryId, checkoutId: NS.checkoutId, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: [], changedFileCount: 0, stagedSummary: null, unstagedSummary: null },
  evidenceRefs: [],
  failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
  verification: { outcomes: [] },
  continuation: { nextAction: 'Freeze the distinction.', unresolvedQuestions: [], recentUserIntent: null },
}).checkpoint;
const SNAP_REV = CP.snapshot === null || CP.snapshot === undefined ? null : CP.snapshot.revisionDigest;
function stateDecisions() {
  return [
    tier.classifyMemoryTierV2({ subjectKind: 'active-requirement', checkpoint: CP, elementRef: { section: 'requirement', id: 'REQ-H' } }),
    tier.classifyMemoryTierV2({ subjectKind: 'mandatory-checkpoint-state', checkpoint: CP }),
    tier.classifyMemoryTierV2({ subjectKind: 'current-user-turn', checkpoint: CP }),
  ];
}
const TX_PAGE = inlineToolPage('call-21', 21, 22, 'exit 0 hardened tool log');
const D_TX = tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: TX_PAGE, immediateRelevance: true });
function buildInput(overrides) {
  const base = {
    checkpoint: CP,
    currentTurn: { turnId: 'th', text: 'Close the protocol gap.', revision: null },
    namespace: clone(NS),
    snapshotRevision: SNAP_REV,
    runtimeState: { pendingProtocol: null },
    pages: [TX_PAGE],
    tierDecisions: stateDecisions().concat([D_TX]),
    evidenceRefs: [],
    exactMaterial: [],
    toolTransactions: [{ pageId: TX_PAGE.id, callId: 'call-21', callSeq: 21, resultSeq: 22 }],
    budget: { hardMax: 8000, target: 6000 },
    compilerPolicyRevision: 'context-compiler-v1',
  };
  return Object.assign(base, overrides || {});
}
section('C02H COMPLETED TRANSACTION');
{
  const out = compiler.compileContextV2(buildInput());
  check(view.validateContextViewV2(out.view).valid === true, 'completed unit passes the C01 gate');
  const entry = out.view.hot.find((e) => e.sourceId === TX_PAGE.id);
  check(entry !== undefined && entry.tier === 'HOT', 'completed call+result materializes HOT');
  check(entry.toolTransaction !== null && entry.toolTransaction.callId === 'call-21'
    && entry.toolTransaction.callPresent === true && entry.toolTransaction.resultPresent === true,
    'completed unit carries the matched balanced identity');
  check(entry.exactText === 'exit 0 hardened tool log', 'completed bytes exact');
  const cand = out.plan.candidates.find((c) => c.sourceId === TX_PAGE.id);
  check(cand !== undefined && cand.deterministicReasonCode === 'compiler-load-immediate-transaction', 'completed reason code stable');
}
section('C02H OPEN PROTOCOL BLOCKS');
{
  const pending = buildInput({ runtimeState: { pendingProtocol: { callId: 'call-21', callSeq: 21 } } });
  throwsWith(() => compiler.compileContextV2(pending), 'context-compiler-protocol-open', 'result-pending blocks compilation');
  throwsWith(() => compiler.buildContextCompilationPlanV2(pending), 'context-compiler-protocol-open', 'result-pending blocks plan construction');
  throwsWith(() => compiler.enumerateContextCandidatesV2(pending), 'context-compiler-protocol-open', 'result-pending blocks enumeration');
  const callOpen = buildInput({ runtimeState: { pendingProtocol: { callId: 'call-21', callSeq: null } } });
  throwsWith(() => compiler.compileContextV2(callOpen), 'context-compiler-protocol-open', 'call-open without recorded start blocks compilation');
  const before = JSON.stringify(pending);
  try { compiler.compileContextV2(pending); } catch (e) { /* expected */ }
  check(JSON.stringify(pending) === before, 'blocked compilation mutated nothing');
  const otherPending = buildInput({ runtimeState: { pendingProtocol: { callId: 'call-77', callSeq: 40 } } });
  throwsWith(() => compiler.compileContextV2(otherPending), 'context-compiler-protocol-open', 'unrelated pending call still blocks');
}
section('C02H WRONG RESULT FAILS');
{
  const wrongCall = buildInput();
  wrongCall.toolTransactions = [{ pageId: TX_PAGE.id, callId: 'call-99', callSeq: 21, resultSeq: 22 }];
  throwsWith(() => compiler.compileContextV2(wrongCall), 'context-compiler-protocol-open', 'binding another callId fails');
  const outsideBacking = buildInput();
  outsideBacking.toolTransactions = [{ pageId: TX_PAGE.id, callId: 'call-21', callSeq: 21, resultSeq: 23 }];
  throwsWith(() => compiler.compileContextV2(outsideBacking), 'context-compiler-protocol-open', 'result outside exact backing fails');
  const callOutside = buildInput();
  callOutside.toolTransactions = [{ pageId: TX_PAGE.id, callId: 'call-21', callSeq: 20, resultSeq: 22 }];
  throwsWith(() => compiler.compileContextV2(callOutside), 'context-compiler-protocol-open', 'call outside exact backing fails');
  const nonTxPage = page.createContextPageV2({
    kind: 'verification', namespace: clone(NS), sourceKind: 'verification',
    sourceRefs: ['test-run:h:1'], mutability: 'immutable', sourceSeqs: [31],
    exactText: 'PASS h', createdAtGeneration: 1,
  });
  const dNonTx = tier.classifyMemoryTierV2({ subjectKind: 'historical-evidence', page: nonTxPage });
  const nonTx = buildInput({ pages: [TX_PAGE, nonTxPage], tierDecisions: stateDecisions().concat([D_TX, dNonTx]) });
  nonTx.toolTransactions = nonTx.toolTransactions.concat([{ pageId: nonTxPage.id, callId: 'call-21', callSeq: 21, resultSeq: 22 }]);
  throwsWith(() => compiler.compileContextV2(nonTx), 'context-compiler-protocol-open', 'binding a non-transaction page fails');
  const unknownPage = buildInput();
  unknownPage.toolTransactions = unknownPage.toolTransactions.concat(
    [{ pageId: 'cxp_ffffffffffffffffffffffffffffffff', callId: 'call-21', callSeq: 21, resultSeq: 22 }]);
  throwsWith(() => compiler.compileContextV2(unknownPage), 'context-compiler-input-invalid', 'binding an unknown page fails');
}
section('C02H RESULT BEFORE CALL FAILS');
{
  const reversed = buildInput();
  reversed.toolTransactions = [{ pageId: TX_PAGE.id, callId: 'call-21', callSeq: 22, resultSeq: 21 }];
  throwsWith(() => compiler.compileContextV2(reversed), 'context-compiler-protocol-open', 'reversed seqs fail');
  const equal = buildInput();
  equal.toolTransactions = [{ pageId: TX_PAGE.id, callId: 'call-21', callSeq: 21, resultSeq: 21 }];
  throwsWith(() => compiler.compileContextV2(equal), 'context-compiler-protocol-open', 'equal seqs fail');
}
section('C02H NO BALANCING BY COUNT');
{
  const missing = buildInput({ toolTransactions: [] });
  throwsWith(() => compiler.compileContextV2(missing), 'context-compiler-protocol-open', 'two seqs without a binding never balance');
  throwsWith(() => compiler.buildContextCompilationPlanV2(missing), 'context-compiler-protocol-open', 'plan construction refuses bindingless protocol too');
  const conflict = buildInput();
  conflict.toolTransactions = conflict.toolTransactions.concat(
    [{ pageId: TX_PAGE.id, callId: 'call-21', callSeq: 21, resultSeq: 22 },
     { pageId: TX_PAGE.id, callId: 'call-21', callSeq: 21, resultSeq: 22 }]);
  const out = compiler.compileContextV2(conflict);
  check(view.validateContextViewV2(out.view).valid === true, 'identical duplicate binding deduplicates');
  const tx3Page = page.createContextPageV2({
    kind: 'tool-result', namespace: clone(NS), sourceKind: 'tool',
    sourceRefs: ['tool-event:call-31'], mutability: 'immutable',
    sourceSeqs: [31, 32, 33], exactText: 'exit 0 three-seq tool log', createdAtGeneration: 1,
  });
  const dTx3 = tier.classifyMemoryTierV2({ subjectKind: 'completed-tool-transaction', page: tx3Page, immediateRelevance: true });
  const clash = buildInput({ pages: [tx3Page], tierDecisions: stateDecisions().concat([dTx3]) });
  clash.toolTransactions = [{ pageId: tx3Page.id, callId: 'call-31', callSeq: 31, resultSeq: 32 },
    { pageId: tx3Page.id, callId: 'call-31', callSeq: 31, resultSeq: 33 }];
  throwsWith(() => compiler.compileContextV2(clash), 'context-compiler-content-conflict', 'conflicting bindings fail');
}
section('C02H NO SYNTHETIC RESULT');
{
  const src = fs.readFileSync(path.join(repoRoot, 'config', 'ContextCompilerV2.cjs'), 'utf8');
  check(src.indexOf('openProtocol') === -1, 'fabricated open-protocol input removed');
  check(src.indexOf('recordText') === -1, 'fabricated protocol text removed');
  check(src.indexOf('compiler-pin-open-protocol') === -1, 'pending protocol has no materialization code');
  check(src.indexOf('pendingProtocol') !== -1, 'pending identity tracked explicitly');
  const out = compiler.compileContextV2(buildInput());
  const units = [];
  for (const s of view.VIEW_SECTIONS) {
    for (const e of out.view[s]) {
      if (e.toolTransaction !== null && e.toolTransaction !== undefined) units.push(e);
    }
  }
  check(units.length === 1, 'exactly one protocol unit materialized');
  check(units[0].toolTransaction.callId === 'call-21', 'unit callId equals the supplied matched binding');
  check(out.view.compilationTrace.find((t) => t.reasonCode === 'compiler-pin-open-protocol') === undefined, 'no open-protocol trace action exists');
}
section('C02H PROMPT PROJECTION SAFETY');
{
  const pendingSameCall = buildInput({ runtimeState: { pendingProtocol: { callId: 'call-21', callSeq: 21 } } });
  let error = null;
  try { compiler.compileContextV2(pendingSameCall); } catch (e) { error = e; }
  check(error !== null && String(error.message).indexOf('context-compiler-protocol-open') !== -1, 'pending wins over a completed binding for the same call');
  const out = compiler.compileContextV2(buildInput());
  const toolEntries = [];
  for (const s of view.VIEW_SECTIONS) {
    for (const e of out.view[s]) {
      if (e.toolTransaction !== null && e.toolTransaction !== undefined) toolEntries.push(e);
    }
  }
  for (const e of toolEntries) {
    check(e.toolTransaction.callPresent === true && e.toolTransaction.resultPresent === true, 'every emitted unit is genuinely balanced');
  }
  check(toolEntries.length === out.plan.candidates.filter((c) => c.subjectKind === 'completed-tool-transaction').length, 'no protocol entry without a bound completed subject');
}
section('C02H MANDATORY DISTINCTION');
{
  const dOpen = tier.classifyMemoryTierV2({ subjectKind: 'open-tool-protocol', checkpoint: CP });
  check(dOpen.tier === 'PINNED', 'pending protocol stays mandatory continuation state (control case)');
  const steady = buildInput();
  steady.tierDecisions = steady.tierDecisions.concat([dOpen]);
  const out = compiler.compileContextV2(steady);
  check(out.view.mandatoryRefs.find((m) => m.kind === 'tool-protocol') === undefined, 'acknowledged pending policy renders no mandatory ref');
  check(view.validateContextViewV2(out.view).valid === true, 'steady state compiles with the decision acknowledged');
  const pending = buildInput({ runtimeState: { pendingProtocol: { callId: 'call-21', callSeq: 21 } } });
  pending.tierDecisions = pending.tierDecisions.concat([clone(dOpen)]);
  let error = null;
  try { compiler.compileContextV2(pending); } catch (e) { error = e; }
  check(error !== null, 'mandatory continuation state without a result still blocks materialization');
  check(String(error && error.message).indexOf('context-compiler-protocol-open') !== -1, 'block carries the protocol-open code, not a fake view');
}
section('C02H C01 UNMODIFIED GATE');
{
  const src = fs.readFileSync(path.join(repoRoot, 'config', 'ContextViewV2.cjs'), 'utf8');
  check(src.indexOf('pending') === -1, 'C01 carries no pending-protocol vocabulary');
  const base = compiler.compileContextV2(buildInput()).view;
  const strip = (entry) => {
    const copy = clone(entry);
    delete copy.id;
    return copy;
  };
  const rebuild = (hot) => view.createContextViewV2({
    namespace: clone(base.namespace),
    checkpointBinding: clone(base.checkpointBinding),
    turnRef: clone(base.turnRef),
    pinned: clone(base.pinned).map(strip),
    hot: hot.map(strip),
    warm: clone(base.warm).map(strip),
    materializedCold: clone(base.materializedCold).map(strip),
    referencedColdPages: clone(base.referencedColdPages),
    tokenBudget: clone(base.tokenBudget),
    compilerPolicyRevision: base.compilerPolicyRevision,
    compilationTrace: clone(base.compilationTrace),
    mandatoryRefs: clone(base.mandatoryRefs),
  });
  const oneSided = clone(base.hot.find((e) => e.sourceId === TX_PAGE.id));
  oneSided.toolTransaction = { callId: 'call-21', callPresent: true, resultPresent: false };
  let oneSidedError = null;
  try {
    rebuild(clone(base.hot).map((e) => (e.sourceId === TX_PAGE.id ? oneSided : e)));
  } catch (e) { oneSidedError = e; }
  check(oneSidedError !== null && String(oneSidedError.message).indexOf('context-view-tool-protocol-unbalanced') !== -1, 'C01 still rejects one-sided units');
  const missing = clone(base.hot.find((e) => e.sourceId === TX_PAGE.id));
  missing.toolTransaction = null;
  let missingError = null;
  try {
    rebuild(clone(base.hot).map((e) => (e.sourceId === TX_PAGE.id ? missing : e)));
  } catch (e) { missingError = e; }
  check(missingError !== null && String(missingError.message).indexOf('context-view-tool-protocol-incomplete') !== -1, 'C01 still rejects missing units');
}
console.log('--- SUMMARY ---');
console.log('ContextCompilerV2H suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) { process.exitCode = 1; }
