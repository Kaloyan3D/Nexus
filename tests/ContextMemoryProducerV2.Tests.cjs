'use strict';
/**
 * ContextMemoryProducerV2.Tests.cjs - CCV2-M01 production memory producer.
 *
 * Proves against the REAL production authorities (no fakes): unit
 * extraction (conversation / balanced tool transaction / narration), exact
 * page + B02 blob materialization, turn-boundary sealing through A06/A05/
 * A07/A03/A04, legacy UNRECORDED_LEGACY bootstrap vs NATIVE authority, the
 * R1 requiredness contract (HOT current turn, WARM latest sealed generation
 * and reachable units, COLD checkpoint-superseded-unreferenced history),
 * current-turn exclusion + lossless coverage, incremental == replay,
 * restart/crash convergence, fail-closed blockers, staged C02 compilation
 * with B03 blob material, the live producer host (sync staging, flush
 * before seal, bootstrap), and the controller task-authority module.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const cfg = (name) => require(path.join(repoRoot, 'config', name));
const producerV2 = cfg('ContextMemoryProducerV2.cjs');
const producerHost = cfg('ContextMemoryProducerHostV2.cjs');
const authorityV2 = cfg('ContextTaskAuthorityV2.cjs');
const shadowHost = cfg('ContextCompilerShadowHostV2.cjs');
const compilerV2 = cfg('ContextCompilerV2.cjs');
const trustV2 = cfg('ContextTrustV2.cjs');
const checkpointV2 = cfg('ContextCheckpointV2.cjs');
const memSession = cfg('ContextSessionEvidenceSourceV2.cjs');

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function throwsWith(fn, fragment, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).indexOf(fragment) !== -1, name,
    error ? String(error.message).slice(0, 240) : 'did not throw');
}
const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-m01-'));

// ---- synthetic DSH-shaped session builder ----
function sessionBuilder() {
  const events = [];
  let time = Date.UTC(2026, 8, 29, 10, 0, 0);
  const push = (type, data, extra) => {
    const event = Object.assign({ type, seq: events.length, time, data }, extra || {});
    time += 1000;
    events.push(event);
    return event.seq;
  };
  let turn = 0;
  let step = 0;
  let callCounter = 0;
  const api = {
    events,
    turnStart() { turn += 1; step = 0; return push('turn/start', { turn }); },
    turnEnd() { return push('turn/end', { turn, reason: { kind: 'completed' } }); },
    user(text, sourceKind) {
      return push('user/message', { id: 'u' + events.length, role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind || 'user' } }, { surfaceOp: 'append' });
    },
    tool(resultText, options) {
      step += 1;
      push('step/start', { turn, step });
      callCounter += 1;
      const callId = 'call_' + callCounter;
      const content = [{ type: 'reasoning', text: '' }];
      if (options && options.narration) content.push({ type: 'text', text: options.narration });
      content.push({ type: 'tool-call', id: callId, name: 'run_code', arguments: '{"code":"step ' + callCounter + '"}' });
      push('assistant/message', { turn, step, message: { role: 'assistant', content, source: { kind: 'model' } } }, { surfaceOp: 'append' });
      push('tool/call', { turn, step, callId, name: 'run_code', arguments: '{"code":"step ' + callCounter + '"}' });
      if (!(options && options.open)) {
        push('tool/result', { turn, step, message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }], id: 'r' + callCounter } }, { surfaceOp: 'append', sourceEventSeqs: [events.length - 1] });
        push('step/end', { turn, step });
      }
      return callId;
    },
    narrate(text) {
      step += 1;
      push('step/start', { turn, step });
      push('assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } }, { surfaceOp: 'append' });
      push('step/end', { turn, step });
    },
    raw: push,
  };
  return api;
}

const OBJECTIVE = 'Ship the M01 producer proof task.';
function manifestFor(taskId, instance, extra) {
  return Object.assign({
    schemaVersion: 1, taskId, taskInstanceId: instance, description: OBJECTIVE, status: 'implementing',
    acceptanceCriteria: ['Producer materializes units.'], verification: { required: [], outcomes: [] },
    failureSignatures: [], baseCommit: 'abc123',
  }, extra || {});
}
function nsFor(taskId, instance, sessionId, ws) {
  return { taskId, taskInstanceId: instance, sessionId, workspaceId: ws, repositoryId: null, checkoutId: null };
}
function threeTurnSession() {
  const s = sessionBuilder();
  s.raw('permission/preset', { preset: 'workspace-write' });
  s.turnStart();
  s.user('Controller: task bound.', 'plugin');
  s.user(OBJECTIVE);
  s.tool('exit 0 first');
  s.tool('large tool output line that must travel the blob route\n'.repeat(200));
  s.narrate('Turn one report.');
  s.turnEnd();
  s.turnStart();
  s.user('Second request.');
  s.tool('exit 0 second', { narration: 'Checking the second thing.' });
  s.turnEnd();
  s.turnStart();
  s.user('Third request.');
  s.tool('exit 0 third');
  s.turnEnd();
  return s;
}

// ============================================================================
section('UNITS, PAGES, BLOBS, SEALING (legacy bootstrap)');
const S3 = threeTurnSession();
const LEGACY_WS = path.join(TMP, 'legacy');
const LEGACY_NS = nsFor('TASK-M01A', 'task_m01_a', 'sess-m01-a', LEGACY_WS);
const LEGACY_MANIFEST = manifestFor('TASK-M01A', 'task_m01_a');
const legacyAuthority = () => ({ manifest: LEGACY_MANIFEST, authorityRecord: null });
const legacy = producerV2.replaySessionV2({ workspace: LEGACY_WS, namespace: LEGACY_NS, events: S3.events, controllerAuthority: legacyAuthority });
{
  const d = legacy.producer.describe();
  check(legacy.result.blocker === null, 'replay completes without blocker', JSON.stringify(legacy.result.blocker));
  check(d.unitCounts.conversation === 4 && d.unitCounts['tool-transaction'] === 4 && d.unitCounts.narration === 1,
    'one unit per user request / balanced transaction / narration', JSON.stringify(d.unitCounts));
  check(d.sealedGeneration === 3 && legacy.result.sealsAdded === 3, 'one sealed generation per safe turn boundary');
  check(d.blobCount === 1, 'large exact unit travels the B02 blob route (never truncated)');
  const units = legacy.producer.units();
  const tx = units.find((u) => u.kind === 'tool-transaction');
  check(tx.seqs.length === 3 && tx.seqs[0] < tx.seqs[1] && tx.seqs[1] < tx.seqs[2], 'transaction unit = assistant + call + result seqs');
  const page = legacy.producer.pageOf(tx.pageId);
  check(page.kind === 'tool-result' && page.provenance.sourceRefs[0] === 'tool-event:' + tx.callIds[0], 'tool page binds tool-event:<callId>');
  const blobUnit = units.find((u) => u.blobRef !== null);
  const blobPage = legacy.producer.pageOf(blobUnit.pageId);
  check(blobPage.exactText === null && blobPage.exactBlobRef === blobUnit.blobRef, 'blob page carries exactBlobRef, no inline text');
  const pluginUnit = units.find((u) => u.kind === 'conversation' && u.sourceKind === 'controller');
  check(pluginUnit !== undefined, 'plugin-injected user messages are controller-sourced conversation units');
  const cp = legacy.producer.sealedCheckpoint();
  check(trustV2.validateSealedCheckpoint(cp).valid === true, 'sealed checkpoint validates (A04 seal)');
  check(cp.authorityCompleteness.origin === 'LEGACY_BOOTSTRAP' && cp.authorityCompleteness.decisions === 'UNRECORDED_LEGACY',
    'legacy task seals with UNRECORDED_LEGACY categories');
  check(cp.objective.text === OBJECTIVE, 'short objective maps verbatim from the controller manifest');
  check(cp.requirements.length === 1 && cp.requirements[0].id === 'AC-1', 'acceptance criteria map to requirements');
  check(cp.evidenceRefs.some((ref) => ref.kind === 'event'), 'objective evidence ref binds the exact session event');
  check(cp.parentCheckpointId !== null && cp.generation === 3, 'checkpoint lineage is explicit');
  const staged = JSON.parse(fs.readFileSync(path.join(producerV2.memoryDirForV2(LEGACY_WS, 'TASK-M01A'), 'staged.json'), 'utf8'));
  check(staged.tierCounts.COLD === 0 && staged.tierCounts.WARM === 8, 'legacy completeness retains all history WARM (conservative)', JSON.stringify(staged.tierCounts));
  check(staged.stagedPageCount === 8 && staged.excludedCurrentTurnSeq !== null, 'the live current-turn message is not staged as a page');
}

// ============================================================================
section('NATIVE AUTHORITY: R1 REQUIREDNESS + HISTORICAL TRANSITION');
const NATIVE_WS = path.join(TMP, 'native');
const NATIVE_NS = nsFor('TASK-M01N', 'task_m01_n', 'sess-m01-n', NATIVE_WS);
const NATIVE_MANIFEST = manifestFor('TASK-M01N', 'task_m01_n');
fs.mkdirSync(path.join(NATIVE_WS, '.ai-harness', 'runs', 'TASK-M01N'), { recursive: true });
authorityV2.initializeNativeTaskAuthorityV2({ workspace: NATIVE_WS, taskId: 'TASK-M01N', taskInstanceId: 'task_m01_n', createdAtUtc: '2026-09-29T09:00:00.000Z' });
const nativeRecord = authorityV2.readTaskAuthorityRecordV2(NATIVE_WS, 'TASK-M01N', 'task_m01_n');
const nativeAuthority = () => ({ manifest: NATIVE_MANIFEST, authorityRecord: nativeRecord });
{
  const s = threeTurnSession();
  // A mid-turn prefix: turn 3 open (its units are the current generation).
  const lastStepStart = s.events.filter((e) => e.type === 'step/start').pop().seq;
  const prefixRun = producerV2.replaySessionV2({ workspace: path.join(TMP, 'native-prefix'), namespace: Object.assign({}, NATIVE_NS, { workspaceId: path.join(TMP, 'native-prefix') }), events: s.events.slice(0, lastStepStart + 5), controllerAuthority: nativeAuthority });
  check(prefixRun.result.blocker === null && prefixRun.producer.describe().sealedGeneration === 2, 'mid-turn prefix seals the two completed turns');
  const run = producerV2.replaySessionV2({ workspace: NATIVE_WS, namespace: NATIVE_NS, events: s.events, controllerAuthority: nativeAuthority });
  const cp = run.producer.sealedCheckpoint();
  check(cp.authorityCompleteness.origin === 'NATIVE' && checkpointV2.AUTHORITY_CATEGORIES.every((c) => cp.authorityCompleteness[c] === 'COMPLETE'),
    'native task seals with every category COMPLETE');
  check(typeof cp.continuation.nextAction === 'string', 'native continuation carries the controller lifecycle next action');
  const decisions = JSON.parse(fs.readFileSync(path.join(producerV2.memoryDirForV2(NATIVE_WS, 'TASK-M01N'), 'tier-decisions.json'), 'utf8'));
  const units = run.producer.units();
  const decisionOf = (unit) => decisions.find((d) => d.pageId === unit.pageId);
  const gen1 = units.filter((u) => u.createdAtGeneration === 1);
  const gen3 = units.filter((u) => u.createdAtGeneration === 3 && !(u.kind === 'conversation' && u.firstSeq === run.producer.describe().latestUserMessageSeq));
  const objectiveUnit = units.find((u) => u.kind === 'conversation' && legacy.producer && u.firstSeq === cp.evidenceRefs[0].locator * 1);
  const gen1Other = gen1.filter((u) => u !== objectiveUnit);
  check(gen1Other.length > 0 && gen1Other.every((u) => decisionOf(u).tier === 'COLD'
    && decisionOf(u).historicalTransition.reason === 'checkpoint-superseded-unreferenced'
    && decisionOf(u).historicalTransition.supersededByGeneration === 3),
  'unreferenced units older than the newly sealed generation transition COLD with typed provenance');
  check(objectiveUnit !== undefined && decisionOf(objectiveUnit).tier === 'WARM' && decisionOf(objectiveUnit).retentionRequired === true,
    'the unit reachable from the active objective EvidenceRef stays required WARM');
  check(gen3.length > 0 && gen3.every((u) => decisionOf(u).retentionRequired === true && decisionOf(u).tier === 'WARM'),
    'units of the most recently sealed generation stay required (M01A 45.2)');
  const coldTool = gen1Other.find((u) => u.kind === 'tool-transaction');
  check(coldTool !== undefined && decisionOf(coldTool).subjectKind === 'historical-evidence', 'a balanced transaction transitions whole (one page, one decision)');
  const prefixDecisions = JSON.parse(fs.readFileSync(path.join(producerV2.memoryDirForV2(path.join(TMP, 'native-prefix'), 'TASK-M01N'), 'tier-decisions.json'), 'utf8'));
  // ACTIVE-TURN boundary: the open turn's completed transaction is produced
  // and ledgered (it seals at turn/end) and still classifies HOT, but it
  // stays provider-native in the live request, so it never enters the
  // staged historical set.
  const prefixActive = prefixRun.producer.describe().activeTurn;
  const openTx = prefixRun.producer.units().filter((u) => prefixActive !== null && u.firstSeq > prefixActive.turnStartSeq && u.kind === 'tool-transaction');
  check(openTx.length === 1 && prefixDecisions.every((d) => d.pageId !== openTx[0].pageId), 'open-turn transaction is ledgered but excluded from the staged historical set');
  const openTier = producerV2.decideUnitTierV2({ unit: openTx[0], page: prefixRun.producer.pageOf(openTx[0].pageId), sealed: prefixRun.producer.sealedCheckpoint(), requiredSeqs: new Set(), authorityComplete: true });
  check(openTier.tier === 'HOT' && openTier.retentionRequired === true && openTier.subjectKind === 'completed-tool-transaction', 'current-generation transaction still classifies HOT and retention-required');
  check(prefixDecisions.filter((d) => d.tier === 'HOT' && typeof d.pageId === 'string').length === 0, 'no open-turn page is staged HOT');
  const bogusSize = decideForBigUnit();
  check(bogusSize === 'COLD', 'unit size never keeps history HOT/WARM (no size heuristic)');
}
function decideForBigUnit() {
  const units = legacy.producer.units();
  const big = units.find((u) => u.blobRef !== null);
  const cpNative = { generation: 5, checkpointId: 'x', evidenceRefs: [], authorityCompleteness: null };
  void cpNative;
  const sealedNative = producerV2.openMemoryProducerV2({ workspace: NATIVE_WS, namespace: NATIVE_NS, controllerAuthority: nativeAuthority }).sealedCheckpoint();
  return producerV2.decideUnitTierV2({
    unit: Object.assign({}, big, { createdAtGeneration: 1 }), page: legacy.producer.pageOf(big.pageId),
    sealed: sealedNative, requiredSeqs: new Set(), authorityComplete: true,
  }).tier;
}

// ============================================================================
section('INCREMENTAL == REPLAY; RESTART; CRASH DEBRIS');
function tree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(root, full) + ':' + sha(fs.readFileSync(full)));
    }
  };
  walk(root);
  return sha(out.join('\n'));
}
{
  const events = threeTurnSession().events;
  const mk = (name) => {
    const ws = path.join(TMP, name);
    return { ws, ns: nsFor('TASK-M01A', 'task_m01_a', 'sess-m01-a', LEGACY_WS) };
  };
  const inc = mk('inc');
  const producer = producerV2.openMemoryProducerV2({ workspace: inc.ws, namespace: inc.ns, controllerAuthority: legacyAuthority });
  for (const event of events) {
    producer.ingest([event], { eventsThrough: (seq) => events.slice(0, seq + 1), eventAt: (seq) => events[seq], durability: { flushedSeq: event.seq, flushParticipated: true } });
  }
  check(tree(path.join(inc.ws, '.ai-harness')) === tree(path.join(LEGACY_WS, '.ai-harness')), 'incremental(1..N) == replay(1..N) byte-for-byte');
  const rs = mk('restart');
  const half = Math.floor(events.length / 2);
  const first = producerV2.openMemoryProducerV2({ workspace: rs.ws, namespace: rs.ns, controllerAuthority: legacyAuthority });
  first.ingest(events.slice(0, half), { eventsThrough: (seq) => events.slice(0, seq + 1), durability: { flushedSeq: half - 1, flushParticipated: true } });
  // crash debris: an uncommitted ledger line past the committed state
  const ledger = path.join(producerV2.memoryDirForV2(rs.ws, 'TASK-M01A'), 'producer', 'units.jsonl');
  fs.appendFileSync(ledger, '{"torn":true}\n');
  const second = producerV2.openMemoryProducerV2({ workspace: rs.ws, namespace: rs.ns, controllerAuthority: legacyAuthority });
  second.ingest(events, { eventsThrough: (seq) => events.slice(0, seq + 1), eventAt: (seq) => events[seq], durability: { flushedSeq: events.length - 1, flushParticipated: true }, stage: true });
  check(tree(path.join(rs.ws, '.ai-harness')) === tree(path.join(LEGACY_WS, '.ai-harness')), 'restart + crash debris converge to the replay state');
  throwsWith(() => producerV2.openMemoryProducerV2({ workspace: rs.ws, namespace: Object.assign({}, rs.ns, { sessionId: 'other' }), controllerAuthority: legacyAuthority }),
    'namespace-mismatch', 'foreign session namespace never reuses the memory dir');
}

// ============================================================================
section('FAIL-CLOSED BLOCKERS');
{
  const s = sessionBuilder();
  s.turnStart();
  s.user('Request.');
  s.tool('exit 0');
  s.raw('tool/result', { message: { role: 'user', content: [] } }, { surfaceOp: { op: 'replace', start: 3, end: 3 } });
  const run = producerV2.replaySessionV2({ workspace: path.join(TMP, 'replace'), namespace: nsFor('TASK-M01R', 'task_m01_r', 'sess-r', path.join(TMP, 'replace')), events: s.events, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01R', 'task_m01_r'), authorityRecord: null }) });
  check(run.result.blocker !== null && run.result.blocker.code === 'producer-surface-replacement-unsupported', 'surface replacement blocks durably (never guessed)');
  const runSession = sessionBuilder();
  runSession.turnStart(); runSession.user('Request.'); runSession.tool('Z'.repeat(9000));
  const runRun = producerV2.replaySessionV2({ workspace: path.join(TMP, 'longrun'), namespace: nsFor('TASK-M01L', 'task_m01_l', 'sess-l', path.join(TMP, 'longrun')), events: runSession.events, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01L', 'task_m01_l'), authorityRecord: null }) });
  check(runRun.result.blocker !== null && /context-blob-run-too-long/.test(runRun.result.blocker.detail),
    'unpersistable long-run text blocks durably (never truncated, never relabeled binary)');
  const gapWs = path.join(TMP, 'gap');
  const p = producerV2.openMemoryProducerV2({ workspace: gapWs, namespace: nsFor('TASK-M01G', 'task_m01_g', 'sess-g', gapWs), controllerAuthority: () => ({ manifest: manifestFor('TASK-M01G', 'task_m01_g'), authorityRecord: null }) });
  const ev = sessionBuilder();
  ev.turnStart(); ev.user('x'); ev.user('y');
  const r = p.ingest([ev.events[0], ev.events[2]], { eventsThrough: (seq) => ev.events.slice(0, seq + 1) });
  check(r.blocker !== null && r.blocker.code === 'producer-sequence-gap', 'sequence gap blocks durably');
  const open = sessionBuilder();
  open.turnStart(); open.user('Open call.'); open.tool('never', { open: true }); open.turnEnd();
  const openRun = producerV2.replaySessionV2({ workspace: path.join(TMP, 'open'), namespace: nsFor('TASK-M01O', 'task_m01_o', 'sess-o', path.join(TMP, 'open')), events: open.events, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01O', 'task_m01_o'), authorityRecord: null }) });
  const od = openRun.producer.describe();
  check(od.unitCounts['tool-transaction'] === 0 && od.openGroups === 1, 'an open/unbalanced call never becomes a unit');
  check(od.sealedGeneration === 0 && od.sealFailures.length === 1 && od.sealFailures[0].blockers.some((b) => /safe-point-tool/.test(b)),
    'open protocol blocks the safe point (recorded seal failure, not a sealed lie)');
  const durableWs = path.join(TMP, 'undurable');
  const nd = producerV2.openMemoryProducerV2({ workspace: durableWs, namespace: nsFor('TASK-M01D', 'task_m01_d', 'sess-d', durableWs), controllerAuthority: () => ({ manifest: manifestFor('TASK-M01D', 'task_m01_d'), authorityRecord: null }) });
  const evs = threeTurnSession().events;
  nd.ingest(evs, { eventsThrough: (seq) => evs.slice(0, seq + 1), durability: { flushedSeq: null, flushParticipated: false } });
  check(nd.describe().sealedGeneration === 0 && nd.describe().sealFailures.every((f) => f.blockers.indexOf('safe-point-session-not-durable') !== -1),
    'no seal without the host durability barrier');
}

// ============================================================================
section('STAGED MEMORY COMPILES (C02 + B03 blob material) + COVERAGE');
{
  const memoryDir = producerV2.memoryDirForV2(LEGACY_WS, 'TASK-M01A');
  const triple = { taskId: 'TASK-M01A', taskInstanceId: 'task_m01_a', sessionId: 'sess-m01-a' };
  const sealed = shadowHost.readSealedCheckpointForTaskV2(memoryDir).sealed;
  const pages = shadowHost.readStagedPagesV2(memoryDir, triple).pages;
  const decisions = shadowHost.readStagedDecisionsV2(memoryDir, triple).decisions;
  const txs = shadowHost.readStagedToolTransactionsV2(memoryDir).transactions;
  const source = memSession.createMemorySessionSourceV2('sess-m01-a', S3.events);
  const noSession = shadowHost.readStagedExactMaterialV2({ workspace: LEGACY_WS, sealed, pages, decisions, sessionSource: null });
  check(noSession.material === null && noSession.skipped === 'shadow-exact-material-session-unavailable', 'blob tool pages need the live session source (skip, never partial)');
  const exact = shadowHost.readStagedExactMaterialV2({ workspace: LEGACY_WS, sealed, pages, decisions, sessionSource: source });
  check(Array.isArray(exact.material) && exact.material.length === 1, 'B03 rehydrates the one blob-backed required page');
  const latestUser = S3.events.filter((e) => e.type === 'user/message').pop();
  const turnText = latestUser.data.content[0].text;
  const compiled = compilerV2.compileContextV2({
    checkpoint: sealed, currentTurn: { turnId: 'live', text: turnText, revision: null },
    namespace: { taskId: sealed.taskId, taskInstanceId: sealed.taskInstanceId, sessionId: sealed.sessionId, workspaceId: sealed.workspaceId, repositoryId: sealed.repositoryId, checkoutId: sealed.checkoutId },
    snapshotRevision: sealed.snapshot.revisionDigest, runtimeState: { pendingProtocol: null },
    pages, tierDecisions: decisions, evidenceRefs: [], exactMaterial: exact.material, toolTransactions: txs,
    budget: { hardMax: 1000000, target: 1000000 }, compilerPolicyRevision: 'context-compiler-v1',
  });
  check(compiled.view.warm.length === 8, 'every staged required unit materializes exactly (no silent omission)');
  const firstSeqs = compiled.view.warm.map((entry) => pages.find((p) => p.id === entry.sourceId).sourceSeqs[0]);
  check(firstSeqs.every((seq, i) => i === 0 || firstSeqs[i - 1] < seq), 'history materializes in canonical session order');
  check(compiled.view.hot.filter((e) => e.sourceType === 'current-turn').length === 1, 'current turn appears exactly once');
  const coverage = shadowHost.readStagedCoverageV2(memoryDir).coverage;
  const dshMessages = S3.events.filter((e) => e.surfaceOp === 'append').map((e) => (e.type === 'user/message' ? e.data : e.data.message));
  check(shadowHost.checkLiveCoverageV2(dshMessages, coverage, turnText) === null, 'every non-current live message is covered by staged memory');
  const extra = dshMessages.concat([{ role: 'assistant', content: [{ type: 'text', text: 'unstaged' }] }, dshMessages[dshMessages.length - 1]]);
  void extra;
  const uncovered = dshMessages.slice(0, -1).concat([{ role: 'assistant', content: [{ type: 'text', text: 'not staged yet' }] }]).concat([dshMessages.find((m) => m.role === 'user' && m.content[0].text === turnText)]);
  check(shadowHost.checkLiveCoverageV2(uncovered, coverage, turnText) === 'live-message-uncovered', 'an unstaged live message fails the lossless-replacement proof');
  check(shadowHost.checkLiveCoverageV2(dshMessages, coverage, 'different turn') === 'current-turn-mismatch', 'current turn mismatch fails');
}

// ============================================================================
section('LIVE PRODUCER HOST (sync staging, flush before seal, bootstrap)');
async function hostSuite() {
  const s = threeTurnSession();
  const ws = path.join(TMP, 'host');
  const listeners = [];
  const ctx = { on: (name, fn) => { if (name === 'session/event') listeners.push(fn); } };
  const session = { id: 'sess-host', events: [] };
  let flushes = 0;
  const install = producerHost.installMemoryProducer(ctx, {
    bindingFor: (id) => (id === 'sess-host' ? { workspace: ws, taskId: 'TASK-M01H', taskInstanceId: 'task_m01_h' } : null),
    flush: async () => { flushes += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return true; },
    authorityFor: () => () => ({ manifest: manifestFor('TASK-M01H', 'task_m01_h'), authorityRecord: null }),
    log: () => {},
    env: {},
  });
  check(install.installed === true && listeners.length === 1, 'producer host installs one session/event listener');
  check(producerHost.installMemoryProducer(ctx, { bindingFor: () => null, env: {} }).registry === install.registry, 'installation is idempotent per ctx');
  check(producerHost.installMemoryProducer({ on: () => {} }, { bindingFor: () => null, env: { NEXUS_CCV2_PRODUCER: 'off' } }).installed === false, 'kill switch disables production');
  // Bootstrap: the session already holds a prefix when first observed.
  const firstTurnEnd = s.events.find((e) => e.type === 'turn/end').seq;
  for (let i = 0; i <= firstTurnEnd + 2; i += 1) session.events.push(s.events[i]);
  listeners[0](session, s.events[firstTurnEnd + 2]);
  await install.registry.idle('sess-host');
  check(install.registry.describe('sess-host').processedThroughSeq === firstTurnEnd + 2, 'mid-log session bootstraps its canonical prefix');
  check(install.registry.describe('sess-host').sealedGeneration === 1, 'bootstrap seals prior safe boundaries after a flush');
  const memoryDir = producerV2.memoryDirForV2(ws, 'TASK-M01H');
  // Synchronous staging: a completed transaction is staged before the listener returns.
  let syncStaged = true;
  for (let i = firstTurnEnd + 3; i < s.events.length; i += 1) {
    session.events.push(s.events[i]);
    const flushesBefore = flushes;
    listeners[0](session, s.events[i]);
    if (s.events[i].type === 'tool/result') {
      const staged = JSON.parse(fs.readFileSync(path.join(memoryDir, 'staged.json'), 'utf8'));
      if (staged.processedThroughSeq !== s.events[i].seq) syncStaged = false;
    }
    if (s.events[i].type === 'turn/end') {
      check(flushes === flushesBefore + 1, 'turn/end waits for exactly one durability barrier');
      await install.registry.idle('sess-host');
    }
  }
  check(syncStaged, 'tool results stage synchronously (before the next root request)');
  await install.registry.idle('sess-host');
  check(install.registry.describe('sess-host').sealedGeneration === 3, 'live host seals every turn');
  const replayWs = path.join(TMP, 'host-replay');
  producerV2.replaySessionV2({ workspace: replayWs, namespace: nsFor('TASK-M01H', 'task_m01_h', 'sess-host', ws), events: s.events, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01H', 'task_m01_h'), authorityRecord: null }) });
  check(tree(path.join(ws, '.ai-harness', 'ccv2')) === tree(path.join(replayWs, '.ai-harness', 'ccv2')), 'live host output == deterministic replay');
  const src = install.registry.sessionSourceFor('sess-host');
  check(src !== null && src.readEvent(0).seq === 0, 'hosts receive the live B03 session exact source');
  check(install.registry.sessionSourceFor('unknown') === null, 'unknown sessions have no source');
  listeners[0]({ id: 'unbound', events: [] }, { seq: 0, type: 'turn/start', data: {} });
  check(install.registry.describe('unbound') === null, 'unbound sessions are ignored');
}

// ============================================================================
section('CONTROLLER TASK AUTHORITY');
{
  const base = authorityV2.createNativeAuthorityRecordV2({ taskId: 'TASK-A', taskInstanceId: 'ti', createdAtUtc: '2026-09-29T00:00:00Z' });
  const r1 = authorityV2.applyTaskAuthorityMutationV2(base, { kind: 'constraint-add', sourceKind: 'user', sourceRefs: ['session-event:4'], type: 'branch', text: 'Stay on the feature branch.' });
  const r2 = authorityV2.applyTaskAuthorityMutationV2(r1, { kind: 'decision-record', sourceKind: 'controller', sourceRefs: ['controller:review'], id: 'D1', statement: 'Use the blob route for large units.', authority: 'controller-established' });
  const r3 = authorityV2.applyTaskAuthorityMutationV2(r2, { kind: 'decision-supersede', sourceKind: 'controller', sourceRefs: ['controller:review'], id: 'D1' });
  check(r3.revision === 3 && r3.decisions[0].status === 'superseded' && authorityV2.validateTaskAuthorityRecordV2(r3).valid, 'typed mutations advance revision and replay-validate');
  const drift = JSON.parse(JSON.stringify(r3));
  drift.constraints[0].text = 'Edited outside the log.';
  check(authorityV2.validateTaskAuthorityRecordV2(drift).reason === 'record-category-drift', 'category edits outside the typed log are detected');
  throwsWith(() => authorityV2.applyTaskAuthorityMutationV2(base, { kind: 'decision-record', sourceKind: 'user', sourceRefs: ['session-event:1'], id: 'D9', statement: 'x', authority: 'controller-established' }),
    'not establishable', 'a user cannot establish a controller decision');
  throwsWith(() => authorityV2.applyTaskAuthorityMutationV2(base, { kind: 'decision-record', sourceKind: 'controller', sourceRefs: ['c'], id: 'D9', statement: 'x', authority: 'agent-proposed' }),
    'accepted (non-proposal)', 'model proposals never become authority directly');
  throwsWith(() => authorityV2.applyTaskAuthorityMutationV2(base, { kind: 'bogus', sourceKind: 'controller', sourceRefs: ['c'] }), 'unknown mutation kind', 'unknown mutation kinds fail closed');
  const longManifest = manifestFor('TASK-A', 'ti', { description: 'D'.repeat(3000) });
  throwsWith(() => authorityV2.deriveControllerTaskStateV2({ manifest: longManifest, authorityRecord: null, namespace: nsFor('TASK-A', 'ti', 's', '/w'), boundary: { generation: 1, safePointBoundarySeq: 1, sessionRevision: 1 }, objectiveEvent: null }),
    'never entered the session', 'an unrepresentable objective without exact evidence fails (never truncated)');
  const event = { seq: 7, type: 'user/message', time: Date.UTC(2026, 8, 29), data: { role: 'user', content: [{ type: 'text', text: longManifest.description }], source: { kind: 'user' } } };
  const derived = authorityV2.deriveControllerTaskStateV2({ manifest: longManifest, authorityRecord: null, namespace: nsFor('TASK-A', 'ti', 's', '/w'), boundary: { generation: 1, safePointBoundarySeq: 7, sessionRevision: 7 }, objectiveEvent: event });
  check(derived.taskState.objective.text.indexOf(sha(longManifest.description)) !== -1 && derived.taskState.evidenceRefs[0].locator === '7',
    'an oversized objective becomes an exact durable reference to its session event');
  const failing = authorityV2.deriveControllerTaskStateV2({ manifest: manifestFor('TASK-A', 'ti', { failureSignatures: ['abc'] }), authorityRecord: null, namespace: nsFor('TASK-A', 'ti', 's', '/w'), boundary: { generation: 1, safePointBoundarySeq: 1, sessionRevision: 1 }, objectiveEvent: null });
  check(failing.taskState.authorityCompleteness.failures === 'UNRECORDED_LEGACY', 'bare legacy failure signatures are not invented into failures');
  const nat = authorityV2.deriveControllerTaskStateV2({ manifest: manifestFor('TASK-A', 'ti'), authorityRecord: r3, namespace: nsFor('TASK-A', 'ti', 's', '/w'), boundary: { generation: 1, safePointBoundarySeq: 1, sessionRevision: 1 }, objectiveEvent: null });
  check(nat.taskState.constraints.length === 1 && nat.taskState.decisions.length === 1 && nat.taskState.authorityCompleteness.origin === 'NATIVE',
    'native derivation maps typed constraints/decisions');
  throwsWith(() => authorityV2.deriveControllerTaskStateV2({ manifest: manifestFor('TASK-B', 'ti'), authorityRecord: null, namespace: nsFor('TASK-A', 'ti', 's', '/w'), boundary: { generation: 1, safePointBoundarySeq: 1, sessionRevision: 1 }, objectiveEvent: null }),
    'namespace-mismatch', 'a manifest from another task fails closed');
  const ws = path.join(TMP, 'authority');
  fs.mkdirSync(path.join(ws, '.ai-harness', 'runs', 'TASK-Z'), { recursive: true });
  authorityV2.initializeNativeTaskAuthorityV2({ workspace: ws, taskId: 'TASK-Z', taskInstanceId: 'tz', createdAtUtc: '2026-09-29T00:00:00Z' });
  throwsWith(() => authorityV2.initializeNativeTaskAuthorityV2({ workspace: ws, taskId: 'TASK-Z', taskInstanceId: 'tz', createdAtUtc: '2026-09-29T00:00:00Z' }), 'already exists', 'inception record is never overwritten');
  authorityV2.mutateTaskAuthorityV2({ workspace: ws, taskId: 'TASK-Z', taskInstanceId: 'tz', mutation: { kind: 'progress-set', sourceKind: 'controller', sourceRefs: ['controller:plan'], completedMilestones: ['R1'], currentMilestone: 'M01', remainingMilestones: [] } });
  check(authorityV2.readTaskAuthorityRecordV2(ws, 'TASK-Z', 'tz').progress.currentMilestone === 'M01', 'durable typed mutation round-trips');
  throwsWith(() => authorityV2.readTaskAuthorityRecordV2(ws, 'TASK-Z', 'other'), 'namespace-mismatch', 'authority record is instance-bound');
  check(authorityV2.readTaskAuthorityRecordV2(ws, 'TASK-NONE', 'x') === null, 'absent record means legacy (never assumed native)');
}

// ============================================================================
section('ACTIVE TURN BOUNDARY (producer-owned anchor, verified against the request)');
{
  // The DSH derived history: one model-visible message per surface event,
  // in log order (user/message -> data; assistant/message, tool/result ->
  // data.message), the rule surfaceMessageHashV2 hashes.
  const surfaceOf = (event) => (event.type === 'user/message' ? event.data : event.data.message);
  const requestOf = (events) => events.filter((e) => ['user/message', 'assistant/message', 'tool/result'].indexOf(e.type) !== -1).map(surfaceOf);
  let wsCounter = 0;
  const replayAt = (events) => {
    wsCounter += 1;
    const ws = path.join(TMP, 'active-turn-' + wsCounter);
    const run = producerV2.replaySessionV2({ workspace: ws, namespace: nsFor('TASK-M01T', 'task_m01_t', 'sess-m01-t', ws), events, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01T', 'task_m01_t'), authorityRecord: null }) });
    const memDir = producerV2.memoryDirForV2(ws, 'TASK-M01T');
    const coverage = shadowHost.readStagedCoverageV2(memDir);
    const txs = shadowHost.readStagedToolTransactionsV2(memDir).transactions;
    return { run, memDir, coverage: coverage.coverage, skipped: coverage.skipped, txs };
  };
  const extract = (messages, at) => shadowHost.extractActiveTailV2({ messages, coverage: at.coverage, toolTransactions: at.txs });
  const hashOf = (message) => sha(JSON.stringify(checkpointV2.canonicalize(message)));

  // Normal multi-step turn: turn 1 closed, turn 2 open after two tool steps.
  const s = sessionBuilder();
  s.turnStart();
  s.user('Turn one request.');
  s.tool('exit 0 one');
  s.turnEnd();
  const turn2Start = s.turnStart();
  const anchorSeq = s.user('Turn two request.');
  s.tool('loaded');
  s.tool('exit 0 two', { narration: 'Continuing.' });
  const normal = replayAt(s.events);
  const at = normal.coverage.activeTurn;
  check(normal.skipped === null && at !== null && at.turn === 2 && at.turnStartSeq === turn2Start && at.anchorSeq === anchorSeq
    && at.anchorMessageHash === hashOf(surfaceOf(s.events[anchorSeq])) && at.processedThroughSeq === s.events.length - 1,
    'normal turn: durable activeTurn { turn, anchorSeq, anchorMessageHash, processedThroughSeq } from DSH turn/start', JSON.stringify(at));
  const staged = JSON.parse(fs.readFileSync(path.join(normal.memDir, 'staged.json'), 'utf8'));
  check(staged.excludedActiveTurnUnitCount === 2 && staged.activeTurn.anchorSeq === anchorSeq, 'normal turn: open-turn units are excluded from the staged historical set');
  const openUnits = normal.run.producer.units().filter((u) => u.firstSeq > turn2Start);
  check(openUnits.length === 3 && openUnits.filter((u) => u.kind === 'tool-transaction').length === 2, 'normal turn: open-turn units are still produced and ledgered');
  check(openUnits.every((u) => u.messageHashes.every((h) => !normal.coverage.hashes.has(h))), 'normal turn: no open-turn message hash is in historical coverage');
  check(normal.txs.every((tx) => openUnits.every((u) => u.callIds.indexOf(tx.callId) === -1)), 'normal turn: no open-turn call id is in staged tool transactions');
  const request = requestOf(s.events);
  const found = extract(request, normal);
  const anchorIndex = request.indexOf(surfaceOf(s.events[anchorSeq]));
  check(found.skipped === null && found.boundary.anchorIndex === anchorIndex && found.boundary.tail.length === request.length - anchorIndex
    && found.boundary.tail.every((m, i) => m === request[anchorIndex + i]), 'normal turn: tail = messages[anchor..] by reference, in order', found.skipped);
  check(found.boundary.tailCallIds.join(',') === 'call_2,call_3', 'normal turn: tail tool protocol closed inside the tail');

  // Plugin user-role injection mid-turn never moves the anchor.
  const p = sessionBuilder();
  p.turnStart(); p.user('History.'); p.tool('exit 0'); p.turnEnd();
  p.turnStart();
  const pAnchor = p.user('Real request.');
  p.tool('loaded');
  const pluginSeq = p.user('Runtime context snapshot.', 'plugin');
  p.tool('exit 0 after snapshot');
  const plugin = replayAt(p.events);
  check(plugin.coverage.activeTurn.anchorSeq === pAnchor, 'plugin injection: anchor stays the turn-opening message');
  const pRequest = requestOf(p.events);
  const pFound = extract(pRequest, plugin);
  check(pFound.skipped === null && pFound.boundary.tail[0] === surfaceOf(p.events[pAnchor]) && pFound.boundary.tail.indexOf(surfaceOf(p.events[pluginSeq])) !== -1,
    'plugin injection: injected message stays inside the native tail', pFound.skipped);
  check(shadowHost.extractLiveCurrentTurnV2(pRequest).turn.text === 'Runtime context snapshot.',
    'plugin injection: the retired "latest user text" rule would have moved the boundary (why it is never used)');

  // Human follow-up claimed mid-turn never moves the anchor.
  const h = sessionBuilder();
  h.turnStart(); h.user('History.'); h.turnEnd();
  h.turnStart();
  const hAnchor = h.user('First ask.');
  h.tool('exit 0');
  const followSeq = h.user('Also do this.');
  h.tool('exit 0 again');
  const human = replayAt(h.events);
  check(human.coverage.activeTurn.anchorSeq === hAnchor && human.run.producer.describe().latestUserMessageSeq === followSeq,
    'human follow-up: anchor stays, even though the latest user message moved');
  const hFound = extract(requestOf(h.events), human);
  check(hFound.skipped === null && hFound.boundary.tail.length === 6 && hFound.boundary.tail.indexOf(surfaceOf(h.events[followSeq])) === 3, 'human follow-up: follow-up stays inside the native tail', hFound.skipped);

  // Missing anchor: the request does not carry the producer's anchor.
  const withoutAnchor = request.filter((m) => m !== surfaceOf(s.events[anchorSeq]));
  check(extract(withoutAnchor, normal).skipped === 'active-turn-anchor-missing', 'missing anchor fails closed');
  // Duplicate anchor hash: the anchor occurs twice.
  const doubled = request.slice(0, anchorIndex).concat([JSON.parse(JSON.stringify(surfaceOf(s.events[anchorSeq])))], request.slice(anchorIndex));
  check(extract(doubled, normal).skipped === 'active-turn-anchor-ambiguous', 'duplicate anchor hash fails closed');
  // Unanchored: turn/start processed, no model-visible message yet.
  const u = sessionBuilder();
  u.turnStart(); u.user('History.'); u.turnEnd(); u.turnStart();
  const unanchored = replayAt(u.events);
  check(unanchored.coverage.activeTurn !== null && unanchored.coverage.activeTurn.anchorSeq === null
    && extract(requestOf(u.events), unanchored).skipped === 'active-turn-unanchored', 'unanchored open turn fails closed');

  // Stale activeTurn state.
  const closedEvents = s.events.concat([{ type: 'turn/end', seq: s.events.length, time: s.events[s.events.length - 1].time + 1000, data: { turn: 2, reason: { kind: 'completed' } } }]);
  const closed = replayAt(closedEvents);
  check(closed.coverage.activeTurn === null && closed.run.producer.describe().activeTurn === null, 'turn/end clears the durable active turn');
  check(extract(request, closed).skipped === 'active-turn-missing', 'stale: a request of a turn the producer already closed (or has not opened) fails closed');
  const torn = { coverage: Object.assign({}, closed.coverage, { activeTurn: normal.coverage.activeTurn }), txs: closed.txs };
  check(extract(request, torn).skipped === 'active-tail-overlap', 'stale: an old anchor whose units are now historical is caught as tail overlap');
  const staleTx = { coverage: normal.coverage, txs: normal.txs.concat([{ pageId: 'x', callId: 'call_3', callSeq: 1, resultSeq: 2 }]) };
  check(extract(request, staleTx).skipped === 'active-tail-overlap', 'stale: a tail call id already staged historically fails closed');
  const uncovered = { coverage: Object.assign({}, normal.coverage, { hashes: new Set() }), txs: normal.txs };
  check(extract(request, uncovered).skipped === 'active-tail-prefix-uncovered', 'uncovered historical prefix fails closed');
  const straddle = request.slice(0, anchorIndex).concat([request[anchorIndex], request[request.length - 1]]);
  check(extract(straddle, normal).skipped === 'active-tail-protocol-open', 'a tail result without its tail call fails closed');
  check(extract(request, { coverage: null, txs: [] }).skipped === 'active-tail-input-invalid', 'no coverage fails closed');

  // Coverage file shape: pre-boundary files read as "no open turn"; a
  // malformed activeTurn invalidates coverage.
  const covPath = path.join(normal.memDir, 'coverage.json');
  const covDoc = JSON.parse(fs.readFileSync(covPath, 'utf8'));
  fs.writeFileSync(covPath, JSON.stringify(Object.assign({}, covDoc, { activeTurn: undefined })));
  check(shadowHost.readStagedCoverageV2(normal.memDir).coverage.activeTurn === null, 'coverage without activeTurn reads as no open turn');
  fs.writeFileSync(covPath, JSON.stringify(Object.assign({}, covDoc, { activeTurn: Object.assign({}, covDoc.activeTurn, { anchorSeq: covDoc.activeTurn.turnStartSeq }) })));
  check(shadowHost.readStagedCoverageV2(normal.memDir).skipped === 'shadow-coverage-invalid', 'malformed activeTurn invalidates coverage');

  // Sealing invariant: the closed turn's units seal and become historical.
  check(closed.run.producer.describe().sealedGeneration === 2 && closed.coverage.hashes.has(hashOf(surfaceOf(s.events[anchorSeq + 2]))),
    'turn/end seals and the former open-turn units join historical coverage');
  // Incremental == replay for the active-turn record.
  const incWs = path.join(TMP, 'active-turn-inc');
  const replayNs = nsFor('TASK-M01T', 'task_m01_t', 'sess-m01-t', path.join(TMP, 'active-turn-1'));
  const inc = producerV2.openMemoryProducerV2({ workspace: incWs, namespace: replayNs, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01T', 'task_m01_t'), authorityRecord: null }) });
  for (const event of s.events) {
    inc.ingest([event], { eventsThrough: (seq) => s.events.slice(0, seq + 1), durability: { flushedSeq: s.events.length - 1, flushParticipated: true } });
  }
  // processedThroughSeq is "as of the last staging" (staging rewrites only
  // when units, seals or the turn move; trailing step/* events do not).
  const withoutCursor = (doc) => JSON.stringify(Object.assign({}, doc, { processedThroughSeq: null, activeTurn: Object.assign({}, doc.activeTurn, { processedThroughSeq: null }) }));
  const incCoverage = JSON.parse(fs.readFileSync(path.join(producerV2.memoryDirForV2(incWs, 'TASK-M01T'), 'coverage.json'), 'utf8'));
  check(withoutCursor(incCoverage) === withoutCursor(covDoc) && incCoverage.activeTurn.processedThroughSeq >= incCoverage.activeTurn.anchorSeq,
    'incremental ingestion == replay for coverage + activeTurn');
  // Restart resumes the open turn from durable state.
  const resumed = producerV2.openMemoryProducerV2({ workspace: incWs, namespace: replayNs, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01T', 'task_m01_t'), authorityRecord: null }) });
  const resumedTurn = resumed.describe().activeTurn;
  check(resumedTurn !== null && resumedTurn.anchorSeq === covDoc.activeTurn.anchorSeq && resumedTurn.anchorMessageHash === covDoc.activeTurn.anchorMessageHash
    && resumedTurn.processedThroughSeq === s.events.length - 1, 'restart resumes the durable active turn');
  const statePath = path.join(producerV2.memoryDirForV2(incWs, 'TASK-M01T'), 'producer', 'state.json');
  const oldState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete oldState.openTurn;
  fs.writeFileSync(statePath, JSON.stringify(oldState));
  const legacyResume = producerV2.openMemoryProducerV2({ workspace: incWs, namespace: replayNs, controllerAuthority: () => ({ manifest: manifestFor('TASK-M01T', 'task_m01_t'), authorityRecord: null }) });
  check(legacyResume.describe().activeTurn === null, 'pre-boundary state resumes with no open turn (fail closed, never guessed)');
}

hostSuite().then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\nM01 producer: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}, (error) => {
  console.log('FAIL: host suite crashed :: ' + String(error && error.stack).slice(0, 400));
  process.exitCode = 1;
});
