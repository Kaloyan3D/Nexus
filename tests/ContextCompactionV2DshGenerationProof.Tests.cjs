'use strict';
/**
 * ContextCompactionV2DshGenerationProof.Tests.cjs - CCV2-A01.
 *
 * Pinned-DSH multi-generation projection proof. It answers one question:
 *
 *   Can the EXISTING pinned DSH session projection surface safely carry
 *   several checkpoint generations of one session binding?
 *
 * It uses the REAL pinned host, not a hand-written fake session:
 *
 *   @deepseek-ai/cordis            Context
 *   @deepseek-ai/dsh-session       SessionStore (ctx.sessions), Session,
 *                                  Session.fromRestore, deriveEventMessage
 *   session.append(type, data, { surfaceOp, sourceEventSeqs })
 *   session.deriveMessages()       model-facing projection
 *   store.flush(session)           -> session/flush durability barrier
 *   store.create(id, {seedSource: 'persistence', seed, meta})
 *                                  documented restore-and-resume path
 *
 * Scenario: RAW HISTORY -> CP1 -> derive -> flush -> restore -> new work
 *           -> CP2 -> derive -> flush -> restore -> new work -> CP3 -> derive.
 *
 * This file implements NO production behavior. The V2 reference plan builder
 * below (RetentionPlanner / TransactionalApply, proof-side only) exists to
 * prove the host; production implementation is CCV2-A02. The architecture it
 * exercises is frozen in docs/architecture/context-compaction-v2.md.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));

const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const RUNTIME_PLUGIN = '@deepseek-ai/dsh-system-prompt';

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function pass(name) { check(true, name); }
function section(title) { console.log('\n--- ' + title + ' ---'); }

// ── host resolution (never faked) ───────────────────────────────────────────
// The pinned host install root, resolved the same way the V1 suites resolve
// it: explicit environment first, then the standard install root.
function hostAppCandidates() {
  const roots = [];
  if (process.env.AIH_HOST_APP) roots.push(process.env.AIH_HOST_APP);
  if (process.env.AIH_TOOLCHAIN_ROOT) roots.push(path.join(process.env.AIH_TOOLCHAIN_ROOT, 'app'));
  if (process.env.DSH_HOME) roots.push(path.join(path.dirname(path.resolve(process.env.DSH_HOME)), 'app'));
  roots.push(HOST_APP);
  return roots;
}
function resolveHost() {
  for (const root of hostAppCandidates()) {
    const sessionPath = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
    const cordisPath = path.join(root, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
    if (!fs.existsSync(sessionPath) || !fs.existsSync(cordisPath)) continue;
    try {
      return {
        root,
        sessionPath,
        cordisPath,
        session: require(sessionPath),
        cordis: require(cordisPath),
        version: require(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')).version,
      };
    } catch { /* keep searching */ }
  }
  return null;
}

const host = resolveHost();
if (!host || !host.session.Session || !host.session.SessionStore || !host.cordis.Context) {
  console.log('SKIP: pinned DSH host tree is absent; the multi-generation proof is PENDING (never faked).');
  console.log('RESULT: 0 context compaction V2 generation assertions passed (live host missing).');
  process.exit(0);
}
const { Session, SessionStore } = host.session;
const { Context } = host.cordis;

// ── pinned-host drift guard ─────────────────────────────────────────────────
// The proof depends on four exact host contracts. If the installed host no
// longer states them, the proof fails loudly instead of silently diverging.
{
  const src = fs.readFileSync(host.sessionPath, 'utf8');
  const markers = [
    ['surface replace: sourceEventSeqs must include every shadowed surface node', 'split constraint (assertProvenance)'],
    ['static fromRestore(id, seed, header)', 'public restore path'],
    ['async flush(session)', 'session/flush durability barrier'],
    ['state.nodes.splice(', 'one replacement node per replace op'],
    ['case "user/message": return event.data;', 'per-node projection rule'],
  ];
  for (const [marker, label] of markers) {
    check(src.includes(marker), 'pinned host still states the ' + label + ' contract');
  }
}

// ── real host harness ───────────────────────────────────────────────────────
let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-ccv2probe-' + messageCounter; }
function modelSource() { return { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function runtimeSnapshot(text) { return userMessage(text, { kind: 'plugin', plugin: RUNTIME_PLUGIN, form: 'snapshot' }); }
function assistantText(text, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source };
}
function assistantToolCall(callId, turn, step) {
  const source = modelSource();
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source };
}
function toolResult(callId, text, turn, step) {
  return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } };
}

const WORKSPACE = path.resolve(repoRoot);
const SESSION_ID = 'sess-ccv2-generation-proof';

// One fresh real host process stand-in: a real cordis Context, the real
// SessionStore service, and a persistence listener that implements the
// documented host contract ("persistence plugins subscribe to session/event
// and flush on session/flush / dispose").
function createHostProcess() {
  const app = new Context();
  const store = new SessionStore(app);
  const durable = { bytes: null, writes: 0, flushedSessionIds: [] };
  app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(session.events);
    durable.writes += 1;
    durable.flushedSessionIds.push(session.id);
    durable.header = { version: session.header.version, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd };
  });
  return { app, store, durable };
}

// Real supported durability barrier (store.flush -> session/flush).
async function flushBarrier(proc, session) {
  const participated = await proc.store.flush(session);
  return participated === true;
}

// Real supported restore path: a fresh host process resuming the durable log.
function restartFromDurable(durable) {
  assert.ok(typeof durable.bytes === 'string' && durable.bytes !== '', 'durable bytes exist before restart');
  const proc = createHostProcess();
  const seed = JSON.parse(durable.bytes);
  let session = null;
  try {
    session = proc.store.create(SESSION_ID, {
      seedSource: 'persistence',
      seed,
      meta: durable.header,
    });
  } catch (error) {
    // Diagnostic: a host-side restore rejection must name the offending
    // canonical event, not just an index.
    const index = Number((/index (\d+)/.exec(String(error && error.message)) || [])[1]);
    if (Number.isInteger(index)) {
      console.error('restore diagnostic: seed[' + index + '] = ' + JSON.stringify(seed[index]));
    }
    throw error;
  }
  return { proc, session };
}

// ── projection helpers (all read the REAL deriveMessages()) ────────────────
function projection(session) { return session.deriveMessages(); }
function projectionJson(session) { return JSON.stringify(session.deriveMessages()); }
// The projection is compared in its serialized form, so multi-line payloads
// must be matched in their JSON-escaped shape.
function escaped(needle) { return JSON.stringify(String(needle)).slice(1, -1); }
function occurrences(session, needle) { return projectionJson(session).split(escaped(needle)).length - 1; }
function projectionHas(session, needle) { return projectionJson(session).includes(escaped(needle)); }
function toolBalanceOfProjection(session) {
  let calls = 0; let results = 0;
  for (const message of projection(session)) {
    for (const block of (message && message.content) || []) {
      if (block && block.type === 'tool-call') calls += 1;
      if (block && block.type === 'tool-result') results += 1;
    }
  }
  return { calls, results };
}
// Every assistant tool call in the projection must be matched by exactly one
// tool result, and every tool result by a call: no orphan crosses a cut.
function orphanToolLinks(session) {
  const calls = new Set(); const results = new Set();
  for (const message of projection(session)) {
    for (const block of (message && message.content) || []) {
      if (block && block.type === 'tool-call') calls.add(block.callId);
      if (block && block.type === 'tool-result') results.add(block.toolCallId);
    }
  }
  return {
    orphanCalls: [...calls].filter((id) => !results.has(id)),
    orphanResults: [...results].filter((id) => !calls.has(id)),
  };
}
// Compact, evidence-derived description of what the model actually receives.
function describeProjection(session) {
  const shapes = [];
  for (const message of projection(session)) {
    const text = JSON.stringify(message);
    if (text.includes('nexus-context-checkpoint')) shapes.push('CP-payload');
    else if (text.includes('nexus-context-continuation')) shapes.push('CP-anchor');
    else if (text.includes('supersedes earlier runtime-context snapshots')) {
      const policy = (/policy-generation: ([A-Z])/.exec(text) || [])[1] || '?';
      shapes.push('host-runtime-snapshot(' + policy + ')');
    } else if (message.role === 'assistant') shapes.push(text.includes('tool-call') ? 'assistant-tool-call' : 'assistant-text');
    else if (text.includes('tool-result')) shapes.push('tool-result');
    else shapes.push('user');
  }
  return shapes;
}
function runtimeSnapshotTexts(session) {
  const found = [];
  for (const message of projection(session)) {
    for (const block of (message && message.content) || []) {
      if (block && block.type === 'text' && typeof block.text === 'string'
        && block.text.includes('supersedes earlier runtime-context snapshots')) found.push(block.text);
    }
  }
  return found;
}
// DSH authority: a runtime snapshot is authoritative only while no NEWER
// runtime snapshot follows it. Exactly one authoritative snapshot is legal.
function authoritativeRuntimeCount(session, marker) {
  const messages = projection(session);
  let count = 0; let seenNewer = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = JSON.stringify(messages[i]);
    const isRuntime = text.includes('supersedes earlier runtime-context snapshots');
    if (isRuntime && !seenNewer && text.includes(marker)) count += 1;
    if (isRuntime) seenNewer = true;
  }
  return count;
}

// ── V2 reference plan (RetentionPlanner + TransactionalApply, proof-side) ──
// Frozen contract: docs/architecture/context-compaction-v2.md sections 3.8 and
// 4.11. Exactly ONE segment carries the full checkpoint payload; every other
// segment carries a bounded continuation anchor with no payload.
function planGeneration(session, options) {
  const cut = compaction.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
  if (!cut) return null;
  const boundary = Number(options.safePointBoundarySeq);
  if (!Number.isInteger(boundary) || boundary < 0) return null;
  const capped = cut.shadowedSeqs.filter((seq) => seq <= boundary);
  if (capped.length === 0) return null;
  const ownedRuntime = compaction.runtimeContextSeqsOf(session);
  const shaped = compaction.splitRangeAroundOwned(session, capped, ownedRuntime);
  if (!shaped) return null;
  const segments = shaped.map((segment, index) => ({
    start: segment.start,
    end: segment.end,
    sourceEventSeqs: segment.sourceEventSeqs,
    role: index === 0 ? 'payload' : 'continuation',
  }));
  const flat = [];
  for (const segment of segments) for (const seq of segment.sourceEventSeqs) flat.push(seq);
  // Contract 4.11: exactly one payload-bearing segment.
  if (segments.filter((segment) => segment.role === 'payload').length !== 1) return null;
  return {
    generation: options.generation,
    operationId: options.operationId,
    taskInstanceId: options.taskInstanceId,
    safePointBoundarySeq: boundary,
    retentionBoundarySeq: cut.end,
    retainedTailSeqs: cut.retainedSeqs,
    excludedRuntimeSeqs: ownedRuntime.filter((seq) => capped.includes(seq)),
    segments,
    sourceEventSeqs: flat,
    replacementStart: flat[0],
    replacementEnd: flat[flat.length - 1],
    payloadText: options.payloadText,
  };
}
function continuationAnchorText(plan, index) {
  return '<nexus-context-continuation operation="' + plan.operationId + '" generation="' + plan.generation
    + '" segment="' + (index + 1) + '/' + plan.segments.length + '"/>';
}
function applyGeneration(session, plan) {
  const landed = [];
  plan.segments.forEach((segment, index) => {
    const isPayload = segment.role === 'payload';
    const source = isPayload
      ? { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: plan.operationId, generation: plan.generation, taskInstanceId: plan.taskInstanceId }
      : { kind: 'plugin', plugin: 'aih-controller', form: 'context-continuation', operationId: plan.operationId, generation: plan.generation };
    const node = session.append('user/message', userMessage(isPayload ? plan.payloadText : continuationAnchorText(plan, index), source), {
      surfaceOp: { op: 'replace', start: segment.start, end: segment.end },
      sourceEventSeqs: segment.sourceEventSeqs,
    });
    landed.push({ seq: node.seq, role: segment.role, segmentIndex: index });
  });
  return landed;
}
function checkpointPayload(generation, extraLines) {
  return [
    CHECKPOINT_ELEMENT_OPEN + ' generation="' + generation + '" sessionId="' + SESSION_ID + '">',
    'CCV2-PAYLOAD-G' + generation,
    'Task: CCV2 generation proof fixture.',
    'Status: complete - authority: deterministic-controller - engine: muse',
    'Verify: ccv2-generation-proof [PASS]',
    CONTROLLER_STATE,
  ].concat(extraLines || []).concat([
    '</nexus-context-checkpoint>',
  ]).join('\n');
}

// ── fixture ─────────────────────────────────────────────────────────────────
const BULK_MARK = 'CCV2-RAW-BULK-4c1f';
const bulkText = BULK_MARK + ' ' + 'x'.repeat(1800);
const POLICY_A = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: A';
const POLICY_B = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: B';
const POLICY_C = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: C';
const CHECKPOINT_ELEMENT_OPEN = '<nexus-context-checkpoint schema="2"';
// Invariant 4.5 (self-contained generation): the checkpoint must carry the
// authoritative controller state itself, not rely on an earlier generation.
const CONTROLLER_STATE = 'Controller: CCV2-TASK COMPLETE - authority: deterministic-controller';
const CONTINUITY = 'CCV2-CONTINUITY-FINAL-REPORT';
const POST_CP1_USER = 'CCV2-POST-CP1-USER-REQUEST';
const POST_CP2_USER = 'CCV2-POST-CP2-USER-REQUEST';
const CURRENT_PROMPT_G2 = 'CCV2-CURRENT-PROMPT-G2';
const CURRENT_PROMPT_G3 = 'CCV2-CURRENT-PROMPT-G3';

function buildRawHistory(session) {
  const ap = (type, data, opts) => session.append(type, data, opts);
  ap('user/message', userMessage('Controller: task CCV2-TASK bound to this session.'), { surfaceOp: 'append' });
  ap('user/message', userMessage('Implement the long engineering task described in CCV2-TASK.'), { surfaceOp: 'append' });
  // Host-owned STALE runtime-context snapshot strictly inside the historical
  // bulk: this is the node that forces a split replacement plan.
  ap('user/message', runtimeSnapshot(POLICY_A), { surfaceOp: 'append' });
  for (let round = 0; round < 10; round += 1) {
    ap('assistant/message', assistantToolCall('ccv2-' + round, 1, round + 1), { surfaceOp: 'append' });
    ap('tool/result', toolResult('ccv2-' + round, 'shell bulk ' + round + ': ' + bulkText, 1, round + 1), { surfaceOp: 'append' });
  }
  ap('user/message', userMessage('Final follow-up: confirm the work is complete.'), { surfaceOp: 'append' });
  ap('assistant/message', assistantText(CONTINUITY + ': CCV2-TASK complete, verification passed.', 2, 1), { surfaceOp: 'append' });
  ap('user/message', userMessage('Controller: task CCV2-TASK COMPLETE. Completion authority: deterministic controller.'), { surfaceOp: 'append' });
}

// Host-owned runtime-policy projection: DSH commits the candidate itself.
// Nexus must never do this.
function hostCommitsRuntimeSnapshot(session, text) {
  return session.append('user/message', runtimeSnapshot(text), { surfaceOp: 'append' });
}
// One committed interaction, typed exactly like the real loop: the user
// message, the model's tool call, the matching tool result, and the model's
// closing text. Every assistant message is 'assistant/message'; only
// user-role material is 'user/message'.
function hostCommitsInteraction(session, options) {
  const nodes = [];
  nodes.push(session.append('user/message', userMessage(options.userText), { surfaceOp: 'append' }));
  nodes.push(session.append('assistant/message', assistantToolCall(options.callId, options.turn, options.step), { surfaceOp: 'append' }));
  nodes.push(session.append('tool/result', toolResult(options.callId, options.toolText, options.turn, options.step), { surfaceOp: 'append' }));
  nodes.push(session.append('assistant/message', assistantText(options.assistantText, options.turn, options.step), { surfaceOp: 'append' }));
  return nodes;
}
function nexusAuthoredRuntimeSnapshots(session, baselineSeqSet) {
  let count = 0;
  for (const event of session.events) {
    if (!baselineSeqSet.has(event.seq)) continue;
    const source = event.data && event.data.source;
    if (event.type === 'user/message' && source && source.plugin === RUNTIME_PLUGIN) count += 1;
  }
  return count;
}

const generationLog = [];

async function main() {
  const proc = createHostProcess();
  const session = proc.store.create(SESSION_ID, { meta: { cwd: WORKSPACE } });
  pass('real pinned host session created through SessionStore.create (' + host.version + ')');

  buildRawHistory(session);
  const rawLogLength = session.events.length;
  const rawEventsSnapshot = JSON.stringify(session.events);
  const TASK = { taskId: 'CCV2-TASK', taskInstanceId: 'task_ccv2_generation_proof_0001', sessionId: SESSION_ID };

  section('RAW HISTORY (before any generation)');
  check(projectionHas(session, BULK_MARK), 'raw projection carries the historical bulk');
  check(!projectionHas(session, 'CCV2-PAYLOAD-G1'), 'no checkpoint payload exists yet');
  check(compaction.runtimeContextSeqsOf(session).length === 1, 'exactly one host-owned runtime snapshot in raw history');
  check(toolBalanceOfProjection(session).calls === toolBalanceOfProjection(session).results, 'raw history is tool-balanced');
  const rawBulkSeqSet = new Set(session.events.filter((e) => JSON.stringify(e.data).includes(BULK_MARK)).map((e) => e.seq));
  check(rawBulkSeqSet.size >= 10, 'raw bulk spans ' + rawBulkSeqSet.size + ' canonical events');

  // ═══ GENERATION 1 ════════════════════════════════════════════════════════
  section('CP1 - apply first checkpoint generation');
  const boundary1 = session.events.length - 1;
  const payload1 = checkpointPayload(1, ['Cut: safe point ' + boundary1]);
  const plan1 = planGeneration(session, {
    generation: 1,
    operationId: 'ccop_ccv2_proof_generation_0001',
    safePointBoundarySeq: boundary1,
    payloadText: payload1,
    taskInstanceId: TASK.taskInstanceId,
  });
  check(plan1 !== null, 'CP1 plan exists (checkpointable, balanced, bounded)');
  check(plan1.sourceEventSeqs.every((seq) => seq <= boundary1), 'CP1 plan is capped by safePointBoundarySeq');
  const seg1 = plan1.segments.length;
  check(seg1 >= 2, 'CP1 plan is SPLIT by the host-owned runtime snapshot (' + seg1 + ' segments)', 'segments=' + seg1);
  check(plan1.excludedRuntimeSeqs.length >= 1, 'CP1 plan excludes the host-owned snapshot from the shadowed range');
  check(plan1.segments.filter((s) => s.role === 'payload').length === 1, 'CP1 plan has exactly one payload-bearing segment');
  const eventsBefore1 = session.events.length;
  const landed1 = applyGeneration(session, plan1);

  section('CP1 assertions');
  check(occurrences(session, 'CCV2-PAYLOAD-G1') === 1, 'CP1 payload appears exactly once in deriveMessages()', 'n=' + occurrences(session, 'CCV2-PAYLOAD-G1'));
  check(occurrences(session, payload1) === 1, 'CP1 full payload text appears exactly once (not once per segment)', 'n=' + occurrences(session, payload1));
  check(occurrences(session, CHECKPOINT_ELEMENT_OPEN) === 1, 'exactly one checkpoint element is model-facing');
  check(occurrences(session, 'nexus-context-continuation') === seg1 - 1, 'remaining segments carry continuation anchors, not payload (' + (seg1 - 1) + ')');
  check(!projectionHas(session, BULK_MARK), 'shadowed RAW bulk is absent from the projection');
  check(!projectionHas(session, 'shell bulk 0'), 'repeated tool output is absent from the projection');
  check(projectionHas(session, CONTINUITY), 'retained continuity survives');
  check(projectionHas(session, 'policy-generation: A'), 'the host runtime snapshot survives in the projection');
  check(occurrences(session, CONTROLLER_STATE) === 1, 'the checkpoint carries the authoritative controller state itself');
  const nexusNodesAfterCp1 = new Set(session.events.slice(eventsBefore1).map((e) => e.seq));
  check(nexusAuthoredRuntimeSnapshots(session, nexusNodesAfterCp1) === 0, 'Nexus authored zero runtime-policy snapshots',
    'nexus-appended runtime snapshots=' + nexusAuthoredRuntimeSnapshots(session, nexusNodesAfterCp1));
  check(session.events.length === eventsBefore1 + seg1, 'canonical log grew by exactly one node per segment (' + (session.events.length - eventsBefore1) + ')');
  check(session.events.some((e) => JSON.stringify(e.data).includes(BULK_MARK)), 'canonical event history still contains the original raw bulk events');
  check(JSON.stringify(session.events.slice(0, rawLogLength)) === rawEventsSnapshot, 'canonical history is append-only: every raw event is byte-identical after CP1');
  const balance1 = toolBalanceOfProjection(session);
  check(balance1.calls === balance1.results, 'CP1 projection keeps tool calls and results balanced', JSON.stringify(balance1));
  const orphans1 = orphanToolLinks(session);
  check(orphans1.orphanCalls.length === 0 && orphans1.orphanResults.length === 0, 'no orphan tool call/result crosses the CP1 cut', JSON.stringify(orphans1));
  console.log('PROJECTION after CP1: ' + JSON.stringify(describeProjection(session)));
  generationLog.push({ generation: 1, segments: seg1, payloadNodes: landed1.filter((n) => n.role === 'payload').length, records: landed1, shape: describeProjection(session) });

  section('CP1 - flush through the real host durability barrier');
  const flushed1 = await flushBarrier(proc, session);
  check(flushed1 === true, 'store.flush(session) reports a participating durability listener');
  check(typeof proc.durable.bytes === 'string' && proc.durable.bytes.includes('CCV2-PAYLOAD-G1'), 'durable backend bytes contain the landed CP1 replacement');
  check(proc.durable.writes >= 1, 'durability barrier actually ran (' + proc.durable.writes + ')');

  section('RESTART after CP1 (supported DSH restore path)');
  const r1 = restartFromDurable(proc.durable);
  check(projectionJson(r1.session) === projectionJson(session), 'restored projection is logically identical to the pre-restart projection');
  check(occurrences(r1.session, 'CCV2-PAYLOAD-G1') === 1, 'CP1 remains model-facing exactly once after restore');
  check(!projectionHas(r1.session, BULK_MARK), 'shadowed raw bulk stays absent from deriveMessages() after restore');
  check(r1.session.events.some((e) => JSON.stringify(e.data).includes(BULK_MARK)), 'canonical raw events still exist after restore');
  pass('restore re-validated the landed replacement through Session.fromRestore');

  section('NEW WORK after CP1');
  const postCp1 = hostCommitsInteraction(r1.session, {
    userText: POST_CP1_USER, callId: 'ccv2-post1', toolText: 'post-CP1 tool output', assistantText: 'CCV2-POST-CP1-ASSISTANT', turn: 3, step: 1,
  });
  check(postCp1.every((node) => !plan1.sourceEventSeqs.includes(node.seq)), 'new interaction seqs are outside the CP1 shadowed source set');
  check(projectionHas(r1.session, POST_CP1_USER), 'new post-CP1 user message is model-facing');

  // Host-owned policy change: DSH commits the new authoritative snapshot.
  hostCommitsRuntimeSnapshot(r1.session, POLICY_B);
  check(authoritativeRuntimeCount(r1.session, 'policy-generation: B') === 1, 'exactly one CURRENT authoritative runtime snapshot after the host policy change');
  check(authoritativeRuntimeCount(r1.session, 'policy-generation: A') === 0, 'the superseded runtime snapshot is no longer authoritative');

  section('CURRENT USER MESSAGE invariant (generation 2)');
  const sessionForG2 = r1.session;
  const boundary2 = sessionForG2.events.length - 1;
  const currentPromptG2 = sessionForG2.append('user/message', userMessage(CURRENT_PROMPT_G2), { surfaceOp: 'append' });
  check(currentPromptG2.seq > boundary2, 'a newer user message arrived after the frozen boundary');
  const payload2 = checkpointPayload(2, ['Cut: safe point ' + boundary2]);
  const plan2 = planGeneration(sessionForG2, {
    generation: 2,
    operationId: 'ccop_ccv2_proof_generation_0002',
    safePointBoundarySeq: boundary2,
    payloadText: payload2,
    taskInstanceId: TASK.taskInstanceId,
  });
  check(plan2 !== null, 'CP2 plan exists');
  check(plan2.sourceEventSeqs.every((seq) => seq <= boundary2), 'CP2 plan is capped by safePointBoundarySeq');
  check(!plan2.sourceEventSeqs.includes(currentPromptG2.seq), 'the current prompt is outside the CP2 frozen boundary');

  section('CP2 - apply second checkpoint generation');
  const seg2 = plan2.segments.length;
  check(seg2 >= 2, 'CP2 shadowed range is SPLIT around a DSH-owned runtime-context snapshot (' + seg2 + ' segments)', 'segments=' + seg2);
  const split2 = plan2.excludedRuntimeSeqs;
  check(split2.length >= 1, 'CP2 excludes ' + split2.length + ' host-owned snapshot node(s) from the shadowed range');
  const landed2 = applyGeneration(sessionForG2, plan2);
  check(occurrences(sessionForG2, 'CCV2-PAYLOAD-G2') === 1, 'CP2 appears exactly once in deriveMessages()', 'n=' + occurrences(sessionForG2, 'CCV2-PAYLOAD-G2'));
  check(occurrences(sessionForG2, payload2) === 1, 'the CP2 full payload text is not duplicated across segments', 'n=' + occurrences(sessionForG2, payload2));
  check(occurrences(sessionForG2, 'CCV2-PAYLOAD-G1') === 0, 'CP1 is no longer an active/full model-facing checkpoint');
  check(occurrences(sessionForG2, payload1) === 0, 'the CP1 payload text is fully superseded in the projection');
  check(sessionForG2.events.some((e) => e.seq === landed1.find((n) => n.role === 'payload').seq), 'CP1 payload node still exists in canonical history');
  check(!projectionHas(sessionForG2, BULK_MARK), 'old RAW bulk did not resurrect under CP2');
  check(occurrences(sessionForG2, CURRENT_PROMPT_G2) === 1, 'the current user message survives exactly once across CP2', 'n=' + occurrences(sessionForG2, CURRENT_PROMPT_G2));
  check(authoritativeRuntimeCount(sessionForG2, 'policy-generation: B') === 1, 'CP2 keeps exactly one CURRENT authoritative runtime snapshot');
  const balance2 = toolBalanceOfProjection(sessionForG2);
  check(balance2.calls === balance2.results, 'CP2 projection stays tool-balanced', JSON.stringify(balance2));
  const orphans2 = orphanToolLinks(sessionForG2);
  check(orphans2.orphanCalls.length === 0 && orphans2.orphanResults.length === 0, 'no orphan tool call/result crosses the CP2 cut', JSON.stringify(orphans2));
  console.log('PROJECTION after CP2: ' + JSON.stringify(describeProjection(sessionForG2)));
  generationLog.push({ generation: 2, segments: seg2, payloadNodes: landed2.filter((n) => n.role === 'payload').length, records: landed2, shape: describeProjection(sessionForG2) });

  section('CP2 - flush and restart');
  const flushed2 = await flushBarrier(r1.proc, sessionForG2);
  check(flushed2 === true, 'CP2 durability barrier participated');
  const r2 = restartFromDurable(r1.proc.durable);
  check(projectionJson(r2.session) === projectionJson(sessionForG2), 'restored CP2 projection is logically identical');
  check(occurrences(r2.session, 'CCV2-PAYLOAD-G2') === 1, 'CP2 remains model-facing exactly once after restore');
  check(occurrences(r2.session, 'CCV2-PAYLOAD-G1') === 0, 'CP1 stays superseded after restore');
  check(!projectionHas(r2.session, BULK_MARK), 'raw bulk stays absent after the CP2 restore');
  check(occurrences(r2.session, CURRENT_PROMPT_G2) === 1, 'the current user message still survives exactly once after restore');

  section('NEW WORK after CP2');
  const postCp2 = hostCommitsInteraction(r2.session, {
    userText: POST_CP2_USER, callId: 'ccv2-post2', toolText: 'post-CP2 tool output', assistantText: 'CCV2-POST-CP2-ASSISTANT', turn: 4, step: 1,
  });
  check(postCp2.every((node) => !plan2.sourceEventSeqs.includes(node.seq)), 'new post-CP2 interaction is outside the CP2 shadowed source set');
  hostCommitsRuntimeSnapshot(r2.session, POLICY_C);
  check(authoritativeRuntimeCount(r2.session, 'policy-generation: C') === 1, 'exactly one CURRENT authoritative snapshot after the second host policy change');

  section('CP3 - apply third checkpoint generation');
  const boundary3 = r2.session.events.length - 1;
  const currentPromptG3 = r2.session.append('user/message', userMessage(CURRENT_PROMPT_G3), { surfaceOp: 'append' });
  const payload3 = checkpointPayload(3, ['Cut: safe point ' + boundary3]);
  const plan3 = planGeneration(r2.session, {
    generation: 3,
    operationId: 'ccop_ccv2_proof_generation_0003',
    safePointBoundarySeq: boundary3,
    payloadText: payload3,
    taskInstanceId: TASK.taskInstanceId,
  });
  check(plan3 !== null, 'CP3 plan exists');
  check(!plan3.sourceEventSeqs.includes(currentPromptG3.seq), 'the G3 current prompt is outside the CP3 frozen boundary');
  const seg3 = plan3.segments.length;
  const landed3 = applyGeneration(r2.session, plan3);
  check(occurrences(r2.session, 'CCV2-PAYLOAD-G3') === 1, 'CP3 appears exactly once in deriveMessages()', 'n=' + occurrences(r2.session, 'CCV2-PAYLOAD-G3'));
  check(occurrences(r2.session, payload3) === 1, 'the CP3 full payload text is not duplicated across segments', 'n=' + occurrences(r2.session, payload3));
  check(occurrences(r2.session, 'CCV2-PAYLOAD-G2') === 0, 'CP2 is no longer an active/full model-facing checkpoint');
  check(occurrences(r2.session, 'CCV2-PAYLOAD-G1') === 0, 'CP1 remains fully superseded under CP3');
  check(occurrences(r2.session, payload2) === 0, 'neither earlier full payload is model-facing');
  check(!projectionHas(r2.session, BULK_MARK), 'raw bulk never resurrects across three generations');
  check(occurrences(r2.session, CURRENT_PROMPT_G3) === 1, 'the G3 current user message survives exactly once', 'n=' + occurrences(r2.session, CURRENT_PROMPT_G3));
  check(authoritativeRuntimeCount(r2.session, 'policy-generation: C') === 1, 'CP3 keeps exactly one CURRENT authoritative runtime snapshot');
  check(nexusAuthoredRuntimeSnapshots(r2.session, new Set(r2.session.events.slice(boundary3 + 1).map((e) => e.seq))) === 0, 'Nexus authored zero runtime-policy snapshots during CP3');
  const balance3 = toolBalanceOfProjection(r2.session);
  check(balance3.calls === balance3.results, 'CP3 projection stays tool-balanced', JSON.stringify(balance3));
  const orphans3 = orphanToolLinks(r2.session);
  check(orphans3.orphanCalls.length === 0 && orphans3.orphanResults.length === 0, 'no orphan tool call/result crosses the CP3 cut', JSON.stringify(orphans3));
  check(occurrences(r2.session, CHECKPOINT_ELEMENT_OPEN) === 1, 'exactly one full checkpoint payload is model-facing after CP3');
  check(occurrences(r2.session, CONTROLLER_STATE) === 1, 'the latest controller state is model-facing exactly once (self-contained generation)');
  console.log('PROJECTION after CP3: ' + JSON.stringify(describeProjection(r2.session)));
  generationLog.push({ generation: 3, segments: seg3, payloadNodes: landed3.filter((n) => n.role === 'payload').length, records: landed3, shape: describeProjection(r2.session) });

  section('CP3 - flush and restart');
  const flushed3 = await flushBarrier(r2.proc, r2.session);
  check(flushed3 === true, 'CP3 durability barrier participated');
  const r3 = restartFromDurable(r2.proc.durable);
  check(projectionJson(r3.session) === projectionJson(r2.session), 'restored CP3 projection is logically identical');
  check(occurrences(r3.session, 'CCV2-PAYLOAD-G3') === 1, 'CP3 remains model-facing exactly once after restore');
  check(occurrences(r3.session, 'CCV2-PAYLOAD-G2') === 0 && occurrences(r3.session, 'CCV2-PAYLOAD-G1') === 0, 'no earlier generation is model-facing after restore');
  check(occurrences(r3.session, CURRENT_PROMPT_G3) === 1, 'the G3 current user message survives exactly once after restore');
  const orphansRestored = orphanToolLinks(r3.session);
  check(orphansRestored.orphanCalls.length === 0 && orphansRestored.orphanResults.length === 0, 'restored projection has no orphan tool call/result', JSON.stringify(orphansRestored));
  check(JSON.stringify(r3.session.events.slice(0, rawLogLength)) === rawEventsSnapshot, 'canonical history is append-only across all three generations and restores');

  section('SPLIT-SEGMENT finding proof (naive one-payload-per-segment plan)');
  // The V1 plan construction repeats the checkpoint text in every segment
  // node. Reproduce it here on a scratch session to prove the defect the V2
  // architecture correction removes. This is evidence, not a workaround.
  {
    const scratchProc = createHostProcess();
    const scratch = scratchProc.store.create('sess-ccv2-naive-plan', { meta: { cwd: WORKSPACE } });
    buildRawHistory(scratch);
    const naiveCut = compaction.balancedRetainCut(scratch, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const naiveSegs = compaction.splitRangeAroundOwned(scratch, naiveCut.shadowedSeqs, compaction.runtimeContextSeqsOf(scratch));
    check(naiveSegs !== null && naiveSegs.length >= 2, 'naive plan is also split (' + (naiveSegs ? naiveSegs.length : 0) + ' segments)');
    for (const segment of naiveSegs) {
      scratch.append('user/message', userMessage('<nexus-context-checkpoint>NAIVE-PAYLOAD-MARKER</nexus-context-checkpoint>', { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: 'ccop_naive' }), {
        surfaceOp: { op: 'replace', start: segment.start, end: segment.end },
        sourceEventSeqs: segment.sourceEventSeqs,
      });
    }
    const naiveCopies = occurrences(scratch, 'NAIVE-PAYLOAD-MARKER');
    check(naiveCopies === naiveSegs.length, 'naive per-segment payload duplicates the checkpoint once per segment', 'copies=' + naiveCopies);
    check(naiveCopies > 1, 'BLOCKING FINDING: one replacement payload per segment DOES duplicate the checkpoint (' + naiveCopies + ' copies)');
  }

  section('HOST SPLIT CONSTRAINT (single-span replace cannot exclude a node)');
  {
    const scratchProc = createHostProcess();
    const scratch = scratchProc.store.create('sess-ccv2-split-constraint', { meta: { cwd: WORKSPACE } });
    buildRawHistory(scratch);
    const cut = compaction.balancedRetainCut(scratch, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const owned = compaction.runtimeContextSeqsOf(scratch);
    const withoutOwned = cut.shadowedSeqs.filter((seq) => !owned.includes(seq));
    let threw = null;
    try {
      scratch.append('user/message', userMessage('single-span-attempt'), {
        surfaceOp: { op: 'replace', start: cut.shadowedSeqs[0], end: cut.shadowedSeqs[cut.shadowedSeqs.length - 1] },
        sourceEventSeqs: withoutOwned,
      });
    } catch (error) { threw = error; }
    check(threw !== null, 'the host refuses a single-span replace that omits a shadowed host-owned node');
    check(threw !== null && /must include every shadowed surface node/.test(String(threw.message)), 'refusal is the documented provenance error', threw ? String(threw.message).slice(0, 120) : 'no error');
  }

  section('TOOL-PROTOCOL invariant (adversarial open-tool tail must refuse the cut)');
  {
    const scratchProc = createHostProcess();
    const scratch = scratchProc.store.create('sess-ccv2-open-tail', { meta: { cwd: WORKSPACE } });
    const ap = (type, data, opts) => scratch.append(type, data, opts);
    ap('user/message', userMessage('Controller: bound'), { surfaceOp: 'append' });
    ap('user/message', userMessage('bulk ' + 'y'.repeat(4000)), { surfaceOp: 'append' });
    ap('assistant/message', assistantToolCall('orphan-1', 1, 1), { surfaceOp: 'append' });
    const orphanCut = compaction.balancedRetainCut(scratch, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    check(orphanCut === null, 'an open tool tail refuses the cut (KEEP)');
    const orphanBalance = toolBalanceOfProjection(scratch);
    check(orphanBalance.calls !== orphanBalance.results, 'the adversarial fixture really is unbalanced', JSON.stringify(orphanBalance));
    const orphanPlan = planGeneration(scratch, {
      generation: 1, operationId: 'ccop_orphan', safePointBoundarySeq: scratch.events.length - 1,
      payloadText: checkpointPayload(1), taskInstanceId: TASK.taskInstanceId,
    });
    check(orphanPlan === null, 'the V2 reference planner refuses to plan on an open tool tail');
  }

  section('IDEMPOTENCY / RECONCILIATION (retry after the replacement landed)');
  {
    const eventsBefore = r3.session.events.length;
    const projectionBefore = projectionJson(r3.session);
    // Every landed generation stays addressable by operation identity after
    // three generations and three restores.
    for (const plan of [plan1, plan2, plan3]) {
      const landed = compaction.findReplacementByOperation(r3.session, plan.operationId);
      check(landed !== null && typeof landed.seq === 'number', 'generation ' + plan.generation + ' reconciles by operationId after restart');
    }
    // A retry that APPENDS the frozen segments again instead of reconciling is
    // refused by the host itself: the frozen source nodes are no longer live.
    let blindRetry = null;
    try {
      r3.session.append('user/message', userMessage('BLIND-RETRY-DUPLICATE-ATTEMPT', { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: plan1.operationId }), {
        surfaceOp: { op: 'replace', start: plan1.segments[0].start, end: plan1.segments[0].end },
        sourceEventSeqs: plan1.segments[0].sourceEventSeqs,
      });
    } catch (error) { blindRetry = error; }
    check(blindRetry !== null, 'a blind re-apply of an already-landed frozen segment is refused by the host', blindRetry ? '' : 'no refusal');
    check(!projectionHas(r3.session, 'BLIND-RETRY-DUPLICATE-ATTEMPT'), 'the refused retry never reached the projection');
    check(r3.session.events.length === eventsBefore, 'retry/re-entry appends nothing to canonical history');
    check(projectionJson(r3.session) === projectionBefore, 'retry/re-entry leaves the model-facing projection unchanged');
    for (const plan of [plan1, plan2, plan3]) {
      const payloadNodes = r3.session.events.filter((e) => e.type === 'user/message'
        && e.data && e.data.source && e.data.source.operationId === plan.operationId
        && e.data.source.form === 'context-checkpoint');
      check(payloadNodes.length === 1, 'generation ' + plan.generation + ' produced exactly one payload node in canonical history', 'n=' + payloadNodes.length);
      const anchors = r3.session.events.filter((e) => e.type === 'user/message'
        && e.data && e.data.source && e.data.source.operationId === plan.operationId
        && e.data.source.form === 'context-continuation');
      check(anchors.length === plan.segments.length - 1, 'generation ' + plan.generation + ' anchors carry identity only, one per non-payload segment', 'n=' + anchors.length);
    }
    check(occurrences(r3.session, 'CCV2-PAYLOAD-G3') === 1, 'reconciliation never appends a second checkpoint for one generation');
  }

  section('RUNTIME-POLICY OWNERSHIP across all generations');
  {
    const rtxSeqs = compaction.runtimeContextSeqsOf(r3.session);
    const hostCommitted = rtxSeqs.every((seq) => {
      const source = r3.session.events[seq].data.source;
      return source.plugin === RUNTIME_PLUGIN && source.kind === 'plugin';
    });
    check(hostCommitted, 'every runtime-context node carries the host plugin provenance');
    check(authoritativeRuntimeCount(r3.session, 'policy-generation: C') === 1, 'the authoritative runtime snapshot is the CURRENT host policy');
    const texts = runtimeSnapshotTexts(r3.session);
    check(new Set(texts).size === texts.length, 'no duplicate runtime snapshot text is model-facing (' + texts.length + ' total)');
    console.log('INFO: model-facing runtime snapshots after three generations: ' + texts.length
      + ' (host-owned, last-wins authority; stale snapshots are excluded from every shadowed range and therefore retained).');
  }

  section('SUMMARY');
  console.log('host: @deepseek-ai/dsh-session ' + host.version + ' (real SessionStore + real session/flush barrier + real restore)');
  for (const record of generationLog) {
    console.log('generation ' + record.generation + ': ' + record.segments + ' segment(s), '
      + record.payloadNodes + ' payload node(s), nodes=' + JSON.stringify(record.records.map((n) => n.seq)));
  }
  const finalTexts = runtimeSnapshotTexts(r3.session);
  console.log('final model-facing projection: checkpoint payloads=1, continuation anchors='
    + occurrences(r3.session, 'nexus-context-continuation') + ', runtime snapshots=' + finalTexts.length
    + ', tool balance=' + JSON.stringify(toolBalanceOfProjection(r3.session)));
  console.log('canonical log length: ' + r3.session.events.length + ' (raw history preserved, append-only)');
  console.log('RESULT: ' + passed + ' context compaction V2 generation assertions passed, ' + failed + ' failed (live pinned DSH host).');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL: ' + (error && error.message ? error.message : error));
  if (error && error.stack) console.error(error.stack);
  process.exit(1);
});
