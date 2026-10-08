'use strict';
/**
 * ContextCompactionV2Operation.Tests.cjs - CCV2-A02 durable multi-generation
 * operation foundation proof.
 *
 * Proves, against the REAL pinned DSH host where host behavior matters and
 * the pure helper module where closed-world logic matters:
 *
 *   explicit payload/continuation roles, exactly one payload per generation,
 *   generation-aware V2 identity (+JS/PS parity), atomic durable persistence
 *   BEFORE mutation, deterministic partial-landing reconciliation, crash /
 *   append / flush / restore semantics, superseded-snapshot (B2) policy, and
 *   V1 backward compatibility.
 *
 * No active-task checkpoint generation is introduced here: payloads are
 * deterministic fixtures standing in for future CheckpointBuilder output.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function pass(name) { check(true, name); }
function section(title) { console.log('\n--- ' + title + ' ---'); }

// ── host resolution (never faked) ────────────────────────────────────────────
const HOST_APP = process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
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
        root, sessionPath, cordisPath,
        session: require(sessionPath),
        cordis: require(cordisPath),
        version: require(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json')).version,
      };
    } catch { /* keep searching */ }
  }
  return null;
}
const host = resolveHost();
// A05H H4: optional developer mode vs strict release gate (never faked).
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));
const liveHostFound = Boolean(host && host.session.Session && host.session.SessionStore && host.cordis.Context);
if (!liveHostFound) {
  liveGate.reportLiveHostGate('A02', liveGate.decideLiveHostGate(false, process.env));
  console.log('SKIP: pinned DSH host tree is absent; the A02 operation proof is PENDING (never faked).');
  process.exit(0);
}
liveGate.reportLiveHostGate('A02', 'EXECUTED');
const { Session, SessionStore } = host.session;
const { Context } = host.cordis;
const RUNTIME_PLUGIN = '@deepseek-ai/dsh-system-prompt';

// ── fixture builders ─────────────────────────────────────────────────────────
let messageCounter = 0;
function newMessageId() { messageCounter += 1; return 'msg-ccv2op-' + messageCounter; }
function userMessage(text, source) { return { id: newMessageId(), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } }; }
function runtimeSnapshot(text) { return userMessage(text, { kind: 'plugin', plugin: RUNTIME_PLUGIN, form: 'snapshot' }); }
function assistantText(text, turn, step) {
  const source = { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' };
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'text', text }], source }, source };
}
function assistantToolCall(callId, turn, step) {
  const source = { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' };
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: [{ type: 'tool-call', name: 'run_command', callId }], source }, source };
}
function toolResult(callId, text, turn, step) {
  return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } };
}
const POLICY_A = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: A';
const POLICY_B = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: B';
const POLICY_C = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox: workspace-write\npolicy-generation: C';
const CKPT_OPEN = '<nexus-context-checkpoint schema="2"';
function payloadFor(generation, tag) {
  return [CKPT_OPEN + ' generation="' + generation + '">', 'CCV2-OP-PAYLOAD-G' + generation, 'Task: A02 durable operation fixture ' + tag + '.', 'Status: complete - authority: deterministic-controller - engine: muse', 'Verify: ccv2-a02-operation [PASS]', 'Controller: CCV2-TASK COMPLETE - authority: deterministic-controller', '</nexus-context-checkpoint>'].join('\n');
}
const WORKSPACE = path.resolve(repoRoot);
function createHostProcess() {
  const app = new Context();
  const store = new SessionStore(app);
  const durable = { bytes: null, writes: 0 };
  const flushDisposer = app.on('session/flush', async (session) => {
    durable.bytes = JSON.stringify(session.events);
    durable.writes += 1;
    durable.header = { version: session.header.version, id: session.header.id, createdAt: session.header.createdAt, cwd: session.header.cwd };
  });
  return { app, store, durable, flushDisposer };
}
async function flushBarrier(proc, session) {
  const participated = await proc.store.flush(session);
  return participated === true;
}
function restartFromDurable(durable, sessionId) {
  assert.ok(typeof durable.bytes === 'string' && durable.bytes !== '', 'durable bytes exist before restart');
  const proc = createHostProcess();
  const seed = JSON.parse(durable.bytes);
  const session = proc.store.create(sessionId, { seedSource: 'persistence', seed, meta: durable.header });
  return { proc, session };
}
function projectionJson(session) { return JSON.stringify(session.deriveMessages()); }
function escaped(needle) { return JSON.stringify(String(needle)).slice(1, -1); }
function occurrences(session, needle) { return projectionJson(session).split(escaped(needle)).length - 1; }
function projectionHas(session, needle) { return projectionJson(session).includes(escaped(needle)); }
// Bulk fixture: controller binding + tool-pair bulk + optional runtime
// snapshots (each between complete pairs) + continuity + completion.
function buildBulkSession(session, snapshots) {
  const ap = (type, data, opts) => session.append(type, data, opts);
  ap('user/message', userMessage('Controller: task CCV2-A02 bound to this session.'), { surfaceOp: 'append' });
  ap('user/message', userMessage('Implement the long engineering task CCV2-A02.'), { surfaceOp: 'append' });
  const marks = Array.isArray(snapshots) ? snapshots : [];
  for (let round = 0; round < 6; round += 1) {
    ap('assistant/message', assistantToolCall('a02-' + round + '-' + session.id, 1, round + 1), { surfaceOp: 'append' });
    ap('tool/result', toolResult('a02-' + round + '-' + session.id, 'bulk output ' + round + ' A02-BULK-' + session.id, 1, round + 1), { surfaceOp: 'append' });
    if (marks[round]) ap('user/message', runtimeSnapshot(marks[round]), { surfaceOp: 'append' });
  }
  ap('user/message', userMessage('Final follow-up: confirm the work is complete.'), { surfaceOp: 'append' });
  ap('assistant/message', assistantText('A02-CONTINUITY: complete, verification passed.', 2, 1), { surfaceOp: 'append' });
  ap('user/message', userMessage('Controller: task CCV2-A02 COMPLETE. Completion authority: deterministic controller.'), { surfaceOp: 'append' });
}
// Freeze one V2 operation for the whole shadowable span: cut → V2 plan →
// roles → draft → atomic freeze (validate→persist→read-back proof).
function freezeGeneration(session, opDir, binding, generation, checkpointId, payloadText) {
  const cut = compaction.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
  assert.ok(cut, 'balanced cut exists for generation ' + generation);
  const boundary = session.events.length - 1;
  const capped = cut.shadowedSeqs.filter((seq) => seq <= boundary);
  assert.ok(capped.length > 0, 'capped shadowed span is non-empty');
  const plan = compaction.planCompactionSegmentsV2(session, capped);
  assert.ok(plan, 'V2 plan exists for generation ' + generation);
  const gate = compaction.currentRuntimeSnapshotUnchanged(session, plan.pinnedCurrentRuntimeSeq, capped);
  assert.ok(gate.ok, 'apply-gate: current runtime snapshot unchanged since planning');
  const roled = compaction.shapeSegmentsWithRoles(plan.segments);
  const flat = [];
  for (const s of roled) for (const seq of s.sourceEventSeqs) flat.push(seq);
  flat.sort((a, b) => a - b);
  const gate2 = compaction.currentRuntimeSnapshotUnchanged(session, plan.pinnedCurrentRuntimeSeq, flat);
  assert.ok(gate2.ok, 'apply-gate: frozen source set does not shadow the current snapshot');
  const operationId = compaction.deriveCanonicalOperationIdV2(binding.taskId, binding.taskInstanceId, binding.sessionId, generation, checkpointId);
  const draft = {
    schemaVersion: 2, operationId, attemptId: 'attempt-' + generation + '-' + checkpointId,
    taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, sessionId: binding.sessionId,
    checkpointId, checkpointGeneration: generation,
    checkpointContentDigest: compaction.sha256HexUtf8(payloadText),
    snapshotTokenId: null, safePointBoundarySeq: boundary,
    sourceEventSeqs: flat, segments: roled, lifecycle: 'frozen',
    workspace: binding.workspace, repositoryId: null, checkoutId: null,
  };
  const expected = { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, sessionId: binding.sessionId, workspace: binding.workspace, checkpointGeneration: generation, checkpointId };
  const durable = compaction.freezeCompactionOperationV2(opDir, draft, expected);
  return { plan, draft, durable, expected, payloadText, boundary };
}
function authoritativeRuntimeCount(session, marker) {
  const messages = session.deriveMessages();
  let count = 0; let seenNewer = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = JSON.stringify(messages[i]);
    const isRuntime = text.includes('supersedes earlier runtime-context snapshots');
    if (isRuntime && !seenNewer && text.includes(marker)) count += 1;
    if (isRuntime) seenNewer = true;
  }
  return count;
}
function nexusAuthoredRuntimeCount(session) {
  let count = 0;
  for (const event of session.events) {
    const source = event.data && event.data.source;
    if (event.type === 'user/message' && source && source.kind === 'plugin' && source.plugin === RUNTIME_PLUGIN) {
      if (source && source.operationId) count += 1;
    }
  }
  return count;
}
async function main() {
  const TASK = { taskId: 'CCV2-A02', taskInstanceId: 'task_ccv2_a02_0001', sessionId: 'sess-ccv2-a02', workspace: WORKSPACE };

  section('V2 IDENTITY BASICS (pure)');
  const idG1 = compaction.deriveCanonicalOperationIdV2('T', 'TI', 'S', 1, 'CKPT-A');
  const idG2 = compaction.deriveCanonicalOperationIdV2('T', 'TI', 'S', 2, 'CKPT-A');
  const idX = compaction.deriveCanonicalOperationIdV2('T', 'TI', 'S', 1, 'CKPT-B');
  check(idG1.startsWith('ccop_') && idG1.length === 37, 'V2 operationId carries ccop_ prefix and 32 hex chars');
  check(idG1 !== idG2, 'same task/session/checkpoint: generation 1 != generation 2');
  check(idG1 !== idX, 'same generation: checkpoint X != checkpoint Y');
  const idV1 = compaction.deriveCanonicalOperationId('T', 'TI', 'S');
  check(idG1 !== idV1, 'V1 and V2 IDs are never ambiguously interchangeable (separate domain)');
  check(compaction.deriveCanonicalOperationIdV2('T', 'TI', 'S', 1, 'CKPT-A') === idG1, 'V2 derivation is deterministic across calls');
  check(compaction.deriveCanonicalOperationIdV2('Tâsk-✓-🎯', 'inst/ané/✓', 'sess/✓/🎯', 3, 'CKPT-✓-🎯') === compaction.deriveCanonicalOperationIdV2('Tâsk-✓-🎯', 'inst/ané/✓', 'sess/✓/🎯', 3, 'CKPT-✓-🎯'), 'Unicode/path-like identity values derive deterministically');
  check(compaction.deriveCanonicalOperationIdV2('Tâsk-✓', 'TI', 'S', 1, 'C') !== compaction.deriveCanonicalOperationIdV2('Task-✓', 'TI', 'S', 1, 'C'), 'Unicode identity values actually discriminate');
  for (const bad of [[null, 'TI', 'S', 1, 'C'], ['T', 'TI', 'S', 0, 'C'], ['T', 'TI', 'S', 1, '']]) {
    let threw = null;
    try { compaction.deriveCanonicalOperationIdV2(bad[0], bad[1], bad[2], bad[3], bad[4]); } catch (e) { threw = e; }
    check(threw !== null, 'invalid V2 identity input is refused (' + JSON.stringify(bad[3]) + '/' + JSON.stringify(bad[4]) + ')');
  }

  section('JS/POWERSHELL V2 ID PARITY (real pwsh authority)');
  function psDeriveV2(taskId, instanceId, sessionId, generation, checkpointId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2opid-'));
    const script = path.join(dir, 'v2opid.ps1');
    const args = [taskId, instanceId, sessionId, String(generation), checkpointId];
    const probe = 'param([string]$T,[string]$I,[string]$S,[int]$G,[string]$C)\n' + ". '" + path.join(repoRoot, 'scripts', 'Common.ps1') + "'; . '" + path.join(repoRoot, 'scripts', 'TaskController.ps1') + "'; . '" + path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1') + "'; New-AihContextCompactionOperationIdV2 -TaskId $T -TaskInstanceId $I -SessionId $S -Generation $G -CheckpointId $C\n";
    fs.writeFileSync(script, probe, 'utf8');
    return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], { encoding: 'utf8', timeout: 120000 }).trim();
  }
  const parityCases = [
    ['CCV2-A02', 'task_ccv2_a02_0001', 'sess-ccv2-a02', 1, 'CKPT-G1'],
    ['CCV2-A02', 'task_ccv2_a02_0001', 'sess-ccv2-a02', 2, 'CKPT-G1'],
    ['CCV2-A02', 'task_ccv2_a02_0001', 'sess-ccv2-a02', 1, 'CKPT-G2'],
    ['Tâsk-✓-🎯', 'inst/ané/✓', 'sess/✓/🎯', 3, 'CKPT-✓-🎯'],
    ['TASK-1234', 'task_00000000000000000000000000000001', 'session-abcdef', 12, 'checkpoint-with-dashes_01'],
  ];
  for (const c of parityCases) {
    const js = compaction.deriveCanonicalOperationIdV2(c[0], c[1], c[2], c[3], c[4]);
    const ps = psDeriveV2(c[0], c[1], c[2], c[3], c[4]);
    check(js === ps, 'V2 ID parity for gen=' + c[3] + ' ckpt=' + c[4], 'js=' + js + ' ps=' + ps);
  }

  section('FROZEN SEGMENT VALIDATION MATRIX (pure, closed-world)');
  function baseDraft() {
    const opId = compaction.deriveCanonicalOperationIdV2(TASK.taskId, TASK.taskInstanceId, TASK.sessionId, 1, 'CKPT-M');
    return {
      schemaVersion: 2, operationId: opId, attemptId: 'attempt-m-1',
      taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: TASK.sessionId,
      checkpointId: 'CKPT-M', checkpointGeneration: 1,
      checkpointContentDigest: 'digest-m', snapshotTokenId: null, safePointBoundarySeq: 9,
      sourceEventSeqs: [0, 1, 3],
      segments: [
        { start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'payload' },
        { start: 3, end: 3, sourceEventSeqs: [3], role: 'continuation' },
      ],
      lifecycle: 'frozen', workspace: TASK.workspace, repositoryId: null, checkoutId: null,
    };
  }
  const baseExpected = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: TASK.sessionId, workspace: TASK.workspace, checkpointGeneration: 1, checkpointId: 'CKPT-M' };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  check(compaction.validateCompactionOperationV2(baseDraft(), baseExpected).valid === true, '1 payload + 1 continuation is valid');
  {
    const op = baseDraft();
    op.segments = [{ start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'payload' }];
    op.sourceEventSeqs = [0, 1];
    check(compaction.validateCompactionOperationV2(op, baseExpected).valid === true, '1 payload only is valid');
  }
  {
    const op = baseDraft();
    op.safePointBoundarySeq = 12;
    op.sourceEventSeqs = [0, 1, 3, 5, 6];
    op.segments = [
      { start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'payload' },
      { start: 3, end: 3, sourceEventSeqs: [3], role: 'continuation' },
      { start: 5, end: 6, sourceEventSeqs: [5, 6], role: 'continuation' },
    ];
    check(compaction.validateCompactionOperationV2(op, baseExpected).valid === true, '1 payload + N continuations is valid');
  }
  const matrix = [
    ['0 payload segments rejected', (op) => { op.segments = [{ start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'continuation' }, { start: 3, end: 3, sourceEventSeqs: [3], role: 'continuation' }]; }, 'payload-segment-missing'],
    ['2 payload segments rejected', (op) => { op.segments[1].role = 'payload'; }, 'payload-segment-duplicate'],
    ['unknown role rejected', (op) => { op.segments[1].role = 'summary'; }, 'segment-role-unknown'],
    ['missing role rejected', (op) => { delete op.segments[1].role; }, 'segment-role-missing'],
    ['unordered segments rejected', (op) => { op.segments = [op.segments[1], op.segments[0]]; }, 'segments-unordered'],
    ['segment endpoints must agree with source seqs', (op) => { op.segments = [{ start: 0, end: 3, sourceEventSeqs: [0, 1], role: 'payload' }, { start: 3, end: 3, sourceEventSeqs: [3], role: 'continuation' }]; }, 'segment-endpoint-mismatch'],
    ['overlapping source sets rejected', (op) => { op.segments = [{ start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'payload' }, { start: 1, end: 3, sourceEventSeqs: [1, 3], role: 'continuation' }]; }, 'segment-overlap'],
    ['source mismatch rejected', (op) => { op.segments[1].sourceEventSeqs = [4]; op.segments[1].start = 4; op.segments[1].end = 4; }, 'segment-union-mismatch'],
    ['boundary violation rejected', (op) => { op.safePointBoundarySeq = 2; }, 'source-seq-beyond-safe-point-boundary'],
    ['duplicate seqs rejected', (op) => { op.sourceEventSeqs = [0, 1, 1]; op.segments = [{ start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'payload' }, { start: 1, end: 1, sourceEventSeqs: [1], role: 'continuation' }]; }, 'source-seqs-duplicate'],
    ['tampered operationId rejected', (op) => { op.operationId = 'ccop_wrong_but_nonempty00000000000000'; }, 'operation-id-mismatch'],
    ['V1 schemaVersion rejected as V2', (op) => { op.schemaVersion = 1; }, 'operation-schema-mismatch'],
    ['missing attemptId rejected', (op) => { delete op.attemptId; }, 'attempt-id-missing'],
    ['task mismatch rejected', (op) => { op.taskId = 'OTHER'; }, 'task-id-mismatch'],
    ['instance mismatch rejected', (op) => { op.taskInstanceId = 'other'; }, 'task-instance-mismatch'],
    ['session mismatch rejected', (op) => { op.sessionId = 'other'; }, 'session-id-mismatch'],
    ['workspace mismatch rejected', (op) => { op.workspace = '/other'; }, 'workspace-mismatch'],
    ['generation invalid rejected', (op) => { op.checkpointGeneration = 0; }, 'checkpoint-generation-invalid'],
    ['checkpoint identity missing rejected', (op) => { op.checkpointId = ''; }, 'checkpoint-identity-missing'],
    ['lifecycle invalid rejected', (op) => { op.lifecycle = 'landed'; }, 'lifecycle-invalid'],
  ];
  {
    // Multi-generation canonical form: segment seqs in surface-application
    // order (interleaved), frozen sourceEventSeqs ascending.
    const op = baseDraft();
    op.safePointBoundarySeq = 27;
    op.sourceEventSeqs = [5, 26, 27];
    op.segments = [{ start: 26, end: 27, sourceEventSeqs: [26, 5, 27], role: 'payload' }];
    check(compaction.validateCompactionOperationV2(op, baseExpected).valid === true, 'surface-ordered multi-generation segment is valid');
  }
  for (const [name, mutate, reason] of matrix) {
    const op = baseDraft();
    mutate(op);
    const result = compaction.validateCompactionOperationV2(op, baseExpected);
    check(result.valid === false && result.reason === reason, name + ' (' + reason + ')', 'got valid=' + result.valid + ' reason=' + result.reason);
  }

  section('PROJECTION: 1 / 2 / 3 SEGMENTS CARRY EXACTLY ONE PAYLOAD (real host)');
  async function projectionCase(name, snapshots, segmentCount, v2Planner) {
    const proc = createHostProcess();
    const sid = 'sess-a02-proj-' + segmentCount + '-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, snapshots);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, name);
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02op-'));
    let frozen;
    if (v2Planner === false) {
      // 3-segment shape via the proven split primitive (two owned nodes),
      // roles assigned by the V2 layer: proves the apply layer supports
      // arbitrary continuation counts (planner under Option A yields <= 2).
      const cut = compaction.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
      assert.ok(cut, 'balanced cut exists');
      const boundary = session.events.length - 1;
      const capped = cut.shadowedSeqs.filter((seq) => seq <= boundary);
      const owned = compaction.runtimeContextSeqsOf(session);
      assert.ok(owned.length >= 2, 'two owned snapshots force three segments');
      const shaped = compaction.splitRangeAroundOwned(session, capped, owned);
      assert.ok(shaped && shaped.length === 3, 'three segments shaped');
      const roled = compaction.shapeSegmentsWithRoles(shaped);
      const flat = [];
      for (const s of roled) for (const seq of s.sourceEventSeqs) flat.push(seq);
      const operationId = compaction.deriveCanonicalOperationIdV2(binding.taskId, binding.taskInstanceId, binding.sessionId, 1, 'CKPT-' + name);
      const draft = {
        schemaVersion: 2, operationId, attemptId: 'attempt-' + name,
        taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, sessionId: binding.sessionId,
        checkpointId: 'CKPT-' + name, checkpointGeneration: 1,
        checkpointContentDigest: compaction.sha256HexUtf8(payloadText),
        snapshotTokenId: null, safePointBoundarySeq: boundary,
        sourceEventSeqs: flat, segments: roled, lifecycle: 'frozen',
        workspace: binding.workspace, repositoryId: null, checkoutId: null,
      };
      const expected = { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, sessionId: binding.sessionId, workspace: binding.workspace, checkpointGeneration: 1, checkpointId: 'CKPT-' + name };
      const durable = compaction.freezeCompactionOperationV2(opDir, draft, expected);
      frozen = { durable, expected, payloadText };
    } else {
      frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-' + name, payloadText);
    }
    check(frozen.durable.segments.length === segmentCount, name + ': frozen operation has ' + segmentCount + ' segment(s)', 'got ' + frozen.durable.segments.length);
    check(frozen.durable.segments.filter((s) => s.role === 'payload').length === 1, name + ': exactly one payload role persisted');
    const eventsBefore = session.events.length;
    const applied = compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, frozen.durable);
    check(session.events.length === eventsBefore + segmentCount, name + ': canonical log grew by exactly one node per segment');
    check(occurrences(session, payloadText) === 1, name + ': full checkpoint payload appears exactly once', 'n=' + occurrences(session, payloadText));
    check(occurrences(session, CKPT_OPEN) === 1, name + ': exactly one checkpoint element is model-facing');
    check(occurrences(session, 'nexus-context-continuation') === segmentCount - 1, name + ': ' + (segmentCount - 1) + ' identity-only continuation anchor(s)');
    // Continuation anchors carry no payload of any kind.
    for (const event of session.events.slice(eventsBefore)) {
      const text = compaction.textContentOfEvent(event);
      if (text.includes('nexus-context-continuation')) {
        check(!text.includes('CCV2-OP-PAYLOAD') && !text.includes('Status:') && !text.includes('policy-generation'), name + ': anchor is identity-only', text.slice(0, 120));
      }
    }
    // Nexus authored zero runtime-policy snapshots.
    const freshRuntime = session.events.slice(eventsBefore).filter((e) => compaction.isRuntimeContextMessage(e));
    check(freshRuntime.length === 0, name + ': Nexus authored zero runtime-policy snapshots');
    return { session, proc, frozen, binding, sid };
  }
  await projectionCase('one-segment', [], 1, true);
  await projectionCase('two-segment', [null, null, POLICY_B, null, null, null], 2, true);
  await projectionCase('three-segment', [null, POLICY_A, null, POLICY_B, null, null], 3, false);

  section('DURABLE-BEFORE-MUTATION (hard invariant, real host)');
  {
    const proc = createHostProcess();
    const sid = 'sess-a02-dbm-' + Date.now();
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, null, POLICY_B, null, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, 'dbm');
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02dbm-'));
    const frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-DBM', payloadText);
    const eventsBefore = session.events.length;
    let threw = null;
    try { compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, null); } catch (e) { threw = e; }
    check(threw !== null, 'mutation without a durable frozen operation is refused');
    check(session.events.length === eventsBefore, 'refused mutation appended nothing');
    let threw2 = null;
    try { compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, Object.assign({}, frozen.durable, { lifecycle: 'applying' })); } catch (e) { threw2 = e; }
    check(threw2 !== null, 'mutation with a non-identical operation copy is refused');
    check(session.events.length === eventsBefore, 'refused mutation appended nothing (copy)');
    // persist → validate → mutate ordering is observable in the op store:
    // the file exists with the exact frozen plan BEFORE the first append.
    const stored = compaction.readCompactionOperationV2(opDir);
    check(stored !== null && stored.operationId === frozen.durable.operationId, 'frozen operation is durably readable before mutation');
    check(JSON.stringify(stored.segments) === JSON.stringify(frozen.draft.segments), 'durable plan is immutable (byte-identical to draft)');
    const applied = compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, stored);
    check(applied.nextLifecycle === 'awaiting-durability', 'apply lands in awaiting-durability, never applied');
    check(applied.landed.length === frozen.durable.segments.length, 'every frozen segment applied exactly once');
  }

  section('RECONCILIATION MATRIX (real host, deterministic)');
  async function reconcCase(name, setup) {
    const proc = createHostProcess();
    const sid = 'sess-a02-rec-' + name + '-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, null, POLICY_B, null, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, 'rec-' + name);
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02rec-'));
    const frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-REC-' + name, payloadText);
    assert.ok(frozen.durable.segments.length === 2, 'reconciliation fixture has 2 segments');
    return { session, proc, frozen, binding, sid, payloadText };
  }
  {
    const f = await reconcCase('none');
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'apply' && r.missingSegments.length === 2, 'none landed → apply exact frozen operation');
  }
  {
    const f = await reconcCase('payload-only');
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, [0]);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'retry-missing' && JSON.stringify(r.missingSegments) === '[1]', 'payload landed, continuation missing → append missing continuation only', JSON.stringify(r));
    const before = f.session.events.length;
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, r.missingSegments);
    check(occurrences(f.session, f.payloadText) === 1, 'retry appended no second payload');
    check(f.session.events.length === before + 1, 'retry appended exactly the missing segment');
  }
  {
    const f = await reconcCase('continuation-only');
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, [1]);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'retry-missing' && JSON.stringify(r.missingSegments) === '[0]', 'continuation landed, payload missing → append exact missing payload once', JSON.stringify(r));
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, r.missingSegments);
    check(occurrences(f.session, f.payloadText) === 1, 'payload appended exactly once after continuation-first landing');
  }
  {
    const f = await reconcCase('all-unflushed');
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'awaiting-durability', 'all landed but unflushed → awaiting-durability (NOT applied)', r.decision);
  }
  {
    const f = await reconcCase('all-durable');
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    const flushed = await flushBarrier(f.proc, f.session);
    assert.ok(flushed, 'flush participated');
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: true });
    check(r.decision === 'applied', 'all landed + durable → applied', r.decision);
  }
  {
    const f = await reconcCase('foreign');
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    f.session.append('user/message', { id: newMessageId(), role: 'user', content: [{ type: 'text', text: 'FOREIGN-CHECKPOINT-SHAPED-JUNK' }], source: { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: f.frozen.durable.operationId, generation: 1 } }, { surfaceOp: 'append' });
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: true });
    check(r.decision === 'block', 'foreign replacement → BLOCK (do not improvise)', r.reason);
  }
  {
    // Corrupt payload citation: a second payload-shaped node citing the same
    // operation (session events are immutable, so corruption is modelled the
    // way a real foreign writer would produce it: an extra citation).
    const f = await reconcCase('corrupt');
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    f.session.append('user/message', { id: newMessageId(), role: 'user', content: [{ type: 'text', text: f.payloadText }], source: { kind: 'plugin', plugin: 'aih-controller', form: 'context-checkpoint', operationId: f.frozen.durable.operationId, generation: 1 } }, { surfaceOp: 'append' });
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: true });
    check(r.decision === 'block', 'corrupt (duplicate payload citation) → BLOCK', r.reason);
  }
  {
    // Digest mismatch: the operation's frozen digest does not match the
    // payload text offered at reconcile time → BLOCK, never improvise.
    const f = await reconcCase('digest');
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText + '\nTAMPERED', durable: true });
    check(r.decision === 'block' && r.reason === 'checkpoint-digest-mismatch', 'payload digest mismatch → BLOCK', r.reason);
  }
  {
    // payload + subset of continuations on a 3-segment operation.
    const proc = createHostProcess();
    const sid = 'sess-a02-rec-subset-' + Date.now();
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, POLICY_A, null, POLICY_B, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, 'rec-subset');
    const cut = compaction.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    const boundary = session.events.length - 1;
    const capped = cut.shadowedSeqs.filter((seq) => seq <= boundary);
    const owned = compaction.runtimeContextSeqsOf(session);
    const shaped = compaction.splitRangeAroundOwned(session, capped, owned);
    assert.ok(shaped && shaped.length === 3, 'three segments for subset case');
    const roled = compaction.shapeSegmentsWithRoles(shaped);
    const flat = [];
    for (const s of roled) for (const seq of s.sourceEventSeqs) flat.push(seq);
    const operationId = compaction.deriveCanonicalOperationIdV2(binding.taskId, binding.taskInstanceId, binding.sessionId, 1, 'CKPT-SUBSET');
    const draft = {
      schemaVersion: 2, operationId, attemptId: 'attempt-subset',
      taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, sessionId: binding.sessionId,
      checkpointId: 'CKPT-SUBSET', checkpointGeneration: 1,
      checkpointContentDigest: compaction.sha256HexUtf8(payloadText),
      snapshotTokenId: null, safePointBoundarySeq: boundary,
      sourceEventSeqs: flat, segments: roled, lifecycle: 'frozen',
      workspace: binding.workspace, repositoryId: null, checkoutId: null,
    };
    const expected = { taskId: binding.taskId, taskInstanceId: binding.taskInstanceId, sessionId: binding.sessionId, workspace: binding.workspace, checkpointGeneration: 1, checkpointId: 'CKPT-SUBSET' };
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02subset-'));
    const durable = compaction.freezeCompactionOperationV2(opDir, draft, expected);
    compaction.retryMissingSegmentsV2(session, durable, payloadText, durable, [0, 1]);
    const r = compaction.reconcileCompactionOperationV2(durable, session, { payloadText, durable: false });
    check(r.decision === 'retry-missing' && JSON.stringify(r.missingSegments) === '[2]', 'payload + subset → append only the exact missing continuation', JSON.stringify(r));
    compaction.retryMissingSegmentsV2(session, durable, payloadText, durable, r.missingSegments);
    check(occurrences(session, payloadText) === 1, 'subset retry kept exactly one payload');
  }

  section('CRASH / DURABILITY MATRIX (real host + file-backed frozen ops)');
  async function crashFixture(name) {
    const proc = createHostProcess();
    const sid = 'sess-a02-crash-' + name + '-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, null, POLICY_B, null, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, 'crash-' + name);
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02crash-'));
    const frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-CRASH-' + name, payloadText);
    assert.ok(frozen.durable.segments.length === 2, 'crash fixture has 2 segments');
    return { proc, session, frozen, binding, sid, payloadText, opDir };
  }
  function payloadCountOf(session, payloadText) { return projectionJson(session).split(escaped(payloadText)).length - 1; }
  {
    // C1: crash after durable persistence, before apply lock / first append.
    const f = await crashFixture('persist');
    const preCrashDraft = JSON.stringify(f.frozen.draft);
    f.session = null; f.proc = null; // process dies; op store survives on disk
    const stored = compaction.readCompactionOperationV2(f.opDir);
    check(stored !== null && JSON.stringify(stored.segments) === JSON.stringify(JSON.parse(preCrashDraft).segments), 'C1: frozen operation survives the crash byte-identical (never re-planned)');
  }
  {
    // C3: crash before first append → none landed → apply exact frozen op.
    const f = await crashFixture('before-append');
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, f.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'apply', 'C3: crash before first append reconciles to apply', r.decision);
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    check(payloadCountOf(f.session, f.payloadText) === 1, 'C3: retried operation lands exactly one payload');
  }
  {
    // C4a: payload lands in memory, crash before flush → durable bytes lack
    // it → retry exact frozen segments.
    const f = await crashFixture('payload-mem');
    const flushed0 = await flushBarrier(f.proc, f.session);
    assert.ok(flushed0, 'pre-apply flush participated');
    const preApplyBytes = f.proc.durable.bytes;
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, [0]);
    assert.ok(payloadCountOf(f.session, f.payloadText) === 1, 'payload landed in memory');
    f.session = null; // crash before flush: in-memory landing is lost
    const revived = restartFromDurable({ bytes: preApplyBytes, header: f.proc.durable.header }, f.sid);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, revived.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'apply', 'C4a: append-without-flush crash leaves replacement absent durably → retry exact frozen segments', r.decision);
    check(payloadCountOf(revived.session, f.payloadText) === 0, 'C4a: dead-process memory is never mistaken for durability');
  }
  {
    // C4b: payload lands + FLUSH participates, crash before continuation →
    // retry appends only the missing continuation; payload never duplicates.
    const f = await crashFixture('payload-durable');
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, [0]);
    const flushed = await flushBarrier(f.proc, f.session);
    assert.ok(flushed, 'payload-only flush participated');
    const midBytes = f.proc.durable.bytes;
    const midHeader = f.proc.durable.header;
    const revived = restartFromDurable({ bytes: midBytes, header: midHeader }, f.sid);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, revived.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'retry-missing' && JSON.stringify(r.missingSegments) === '[1]', 'C4b: crash after payload → complete exact missing continuation only', JSON.stringify(r));
    compaction.retryMissingSegmentsV2(revived.session, f.frozen.durable, f.payloadText, f.frozen.durable, r.missingSegments);
    check(payloadCountOf(revived.session, f.payloadText) === 1, 'C4b: payload appears exactly once after partial crash recovery');
  }
  {
    // C5 (inverse order): continuation lands + flush, crash → payload once.
    const f = await crashFixture('continuation-first');
    compaction.retryMissingSegmentsV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable, [1]);
    const flushed = await flushBarrier(f.proc, f.session);
    assert.ok(flushed, 'continuation-only flush participated');
    const revived = restartFromDurable({ bytes: f.proc.durable.bytes, header: f.proc.durable.header }, f.sid);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, revived.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'retry-missing' && JSON.stringify(r.missingSegments) === '[0]', 'C5: continuation-first crash → append exact missing payload once', JSON.stringify(r));
    compaction.retryMissingSegmentsV2(revived.session, f.frozen.durable, f.payloadText, f.frozen.durable, r.missingSegments);
    check(payloadCountOf(revived.session, f.payloadText) === 1, 'C5: exactly one payload after inverse-order recovery');
  }
  {
    // C6: all appended in memory, crash before flush → durable original → retry same op.
    const f = await crashFixture('final-noflush');
    const flushed0 = await flushBarrier(f.proc, f.session);
    assert.ok(flushed0, 'pre-apply flush participated');
    const preBytes = f.proc.durable.bytes;
    const preHeader = f.proc.durable.header;
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    assert.ok(payloadCountOf(f.session, f.payloadText) === 1, 'full op landed in memory');
    const revived = restartFromDurable({ bytes: preBytes, header: preHeader }, f.sid);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, revived.session, { payloadText: f.payloadText, durable: false });
    check(r.decision === 'apply' && r.missingSegments.length === 2, 'C6: crash after final append but before flush → safe original, retry same frozen op');
  }
  {
    // C7: FLUSH FAILURE — segments append, flush does not establish
    // durability → awaiting-durability, never applied; retry reuses same op.
    const proc = createHostProcess();
    // Remove the durability listener: a real non-participating backend.
    proc.flushDisposer();
    const sid = 'sess-a02-flushfail-' + Date.now();
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, null, POLICY_B, null, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, 'flushfail');
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02flush-'));
    const frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-FLUSHFAIL', payloadText);
    compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, frozen.durable);
    const flushed = await flushBarrier(proc, session);
    check(flushed === false, 'C7: flush reports a NON-participating durability listener');
    const r = compaction.reconcileCompactionOperationV2(frozen.durable, session, { payloadText, durable: flushed });
    check(r.decision === 'awaiting-durability', 'C7: flush failure keeps awaiting-durability (never APPLIED)', r.decision);
    check(r.decision !== 'applied', 'C7: flush failure cannot become APPLIED');
  }
  {
    // C8: crash after successful flush but before APPLIED state write →
    // restart reconciles to APPLIED without appending anything.
    const f = await crashFixture('flush-finalize');
    compaction.applyCompactionOperationV2(f.session, f.frozen.durable, f.payloadText, f.frozen.durable);
    const flushed = await flushBarrier(f.proc, f.session);
    assert.ok(flushed, 'final flush participated');
    const citedBefore = f.session.events.filter((e) => e.data && e.data.source && e.data.source.operationId === f.frozen.durable.operationId).length;
    const revived = restartFromDurable({ bytes: f.proc.durable.bytes, header: f.proc.durable.header }, f.sid);
    const r = compaction.reconcileCompactionOperationV2(f.frozen.durable, revived.session, { payloadText: f.payloadText, durable: true });
    check(r.decision === 'applied', 'C8: crash after flush before finalize → durable-state reconciliation to APPLIED', r.decision);
    const citedAfter = revived.session.events.filter((e) => e.data && e.data.source && e.data.source.operationId === f.frozen.durable.operationId).length;
    check(citedAfter === citedBefore, 'C8: finalization appended nothing (only the host restore marker is new)');
    check(payloadCountOf(revived.session, f.payloadText) === 1, 'C8: exactly one payload in the finalized projection');
  }
  {
    // C2: crash after apply lock. The lock/attempt state is durable; the op
    // plan is reused verbatim (operationId + segments identical).
    const f = await crashFixture('lock');
    const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02attempt-'));
    let attempt = compaction.createCompactionAttemptV2({ attemptId: f.frozen.durable.attemptId, operationId: f.frozen.durable.operationId, taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: f.sid, generation: 1 });
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'eligible', 'pressure');
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'checkpoint-ready', 'checkpoint');
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'apply-pending', 'lock-acquired');
    const storedAttempt = compaction.persistCompactionAttemptV2(attemptDir, attempt);
    const preCrashOp = JSON.stringify(f.frozen.durable);
    f.session = null; // crash after lock, before append
    const reloadedOp = compaction.readCompactionOperationV2(f.opDir);
    const reloadedAttempt = JSON.parse(fs.readFileSync(compaction.attemptV2FilePath(attemptDir, f.frozen.durable.attemptId), 'utf8'));
    check(JSON.stringify(reloadedOp) === preCrashOp, 'C2: retry uses the same frozen operation (never re-plans/widens)');
    check(reloadedAttempt.state === 'apply-pending' && reloadedAttempt.operationId === reloadedOp.operationId, 'C2: attempt lock state survives the crash bound to the same operation');
  }

  section('MULTI-GENERATION DURABILITY (gen1 → restart → gen2, real host)');
  {
    const proc = createHostProcess();
    const sid = 'sess-a02-multigen-' + Date.now();
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, null, POLICY_B, null, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payload1 = payloadFor(1, 'multigen');
    const opDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'a02mg1-'));
    const g1 = freezeGeneration(session, opDir1, binding, 1, 'CKPT-MG-1', payload1);
    compaction.applyCompactionOperationV2(session, g1.durable, payload1, g1.durable);
    assert.ok(await flushBarrier(proc, session), 'gen1 flush participated');
    check(occurrences(session, payload1) === 1, 'gen1 payload model-facing exactly once');
    const r1 = restartFromDurable(proc.durable, sid);
    check(occurrences(r1.session, payload1) === 1, 'gen1 survives restore exactly once');
    // New work + new host policy after gen1.
    r1.session.append('user/message', userMessage('CCV2-A02 post-gen1 work item'), { surfaceOp: 'append' });
    r1.session.append('user/message', runtimeSnapshot(POLICY_C), { surfaceOp: 'append' });
    const payload2 = payloadFor(2, 'multigen');
    const opDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'a02mg2-'));
    const g2 = freezeGeneration(r1.session, opDir2, binding, 2, 'CKPT-MG-2', payload2);
    check(g2.durable.operationId !== g1.durable.operationId, 'generation-aware identity: gen2 operation differs from gen1');
    compaction.applyCompactionOperationV2(r1.session, g2.durable, payload2, g2.durable);
    assert.ok(await flushBarrier(r1.proc, r1.session), 'gen2 flush participated');
    check(occurrences(r1.session, payload2) === 1, 'gen2 payload model-facing exactly once');
    check(occurrences(r1.session, payload1) === 0, 'gen1 payload superseded (latest-only projection)');
    check(authoritativeRuntimeCount(r1.session, 'policy-generation: C') === 1, 'exactly one authoritative runtime snapshot after gen2');
    const r2 = restartFromDurable(r1.proc.durable, sid);
    check(occurrences(r2.session, payload2) === 1 && occurrences(r2.session, payload1) === 0, 'multi-generation state survives restore');
  }

  section('ATTEMPT IDENTITY (attempt ≠ generation)');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02att-'));
    let attempt = compaction.createCompactionAttemptV2({ attemptId: 'att-1', operationId: 'ccop_x', taskId: 'T', taskInstanceId: 'TI', sessionId: 'S', generation: 1 });
    check(attempt.state === 'inactive' && attempt.result === 'in-progress', 'attempt starts inactive/in-progress (no generation fabricated)');
    let threw = null;
    try { compaction.transitionCompactionAttemptV2(attempt, 'applied', 'skip'); } catch (e) { threw = e; }
    check(threw !== null, 'illegal transition inactive → applied is refused');
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'eligible', 'pressure');
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'checkpoint-ready', 'checkpoint');
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'apply-pending', 'frozen');
    attempt = compaction.transitionCompactionAttemptV2(attempt, 'awaiting-durability', 'appended');
    const stored = compaction.persistCompactionAttemptV2(dir, attempt);
    check(stored.state === 'awaiting-durability', 'attempt persists mid-lifecycle without fabricating a generation');
    const done = compaction.transitionCompactionAttemptV2(stored, 'applied', 'durable');
    compaction.persistCompactionAttemptV2(dir, done);
    let threw2 = null;
    try { compaction.persistCompactionAttemptV2(dir, Object.assign({}, done, { state: 'blocked' })); } catch (e) { threw2 = e; }
    check(threw2 !== null, 'a finished attempt is immutable (never edited)');
    const blocked = compaction.transitionCompactionAttemptV2(stored, 'blocked', 'foreign-landing');
    check(blocked.result === 'blocked' && blocked.finishedAtUtc !== null, 'blocked attempt records result without a generation');
  }

  section('B2 RUNTIME-SNAPSHOT POLICY EXPERIMENT (real host, Option A proof)');
  {
    const proc = createHostProcess();
    const sid = 'sess-a02-b2-' + Date.now();
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    // Stale A strictly inside the future shadowed range; current B later.
    buildBulkSession(session, [null, POLICY_A, null, POLICY_B, null, null]);
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const cut = compaction.balancedRetainCut(session, { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 });
    assert.ok(cut, 'B2 cut exists');
    const boundary = session.events.length - 1;
    const capped = cut.shadowedSeqs.filter((seq) => seq <= boundary);
    const currentBefore = compaction.currentRuntimeSnapshotSeqOf(session);
    assert.ok(currentBefore !== null, 'a current runtime snapshot is identified from host-grounded semantics');
    const plan = compaction.planCompactionSegmentsV2(session, capped);
    assert.ok(plan, 'Option A plan exists');
    check(plan.segments.length === 2, 'Option A splits ONLY around the current snapshot (stale snapshots shadowed)', 'segments=' + plan.segments.length);
    check(plan.shadowedStaleRuntimeSeqs.length >= 1, 'stale snapshot(s) fall inside the shadowed bulk', JSON.stringify(plan.shadowedStaleRuntimeSeqs));
    check(plan.pinnedCurrentRuntimeSeq === currentBefore, 'the current snapshot is pinned (excluded), never cited as a source seq');
    const flat = [];
    for (const s of plan.segments) for (const seq of s.sourceEventSeqs) flat.push(seq);
    check(!flat.includes(currentBefore), 'pinned current snapshot is not in the frozen source set');
    const payloadText = payloadFor(1, 'b2');
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02b2-'));
    const frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-B2', payloadText);
    compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, frozen.durable);
    check(!projectionHas(session, 'policy-generation: A'), 'superseded snapshot A is shadowed out of the projection');
    check(authoritativeRuntimeCount(session, 'policy-generation: B') === 1, 'current snapshot B remains the single authority');
    check(occurrences(session, payloadText) === 1, 'payload still exactly once under Option A');
    assert.ok(await flushBarrier(proc, session), 'B2 flush participated');
    const revived = restartFromDurable(proc.durable, sid);
    check(authoritativeRuntimeCount(revived.session, 'policy-generation: B') === 1, 'restore preserves the same current policy (B)');
    check(!projectionHas(revived.session, 'policy-generation: A'), 'stale snapshot stays shadowed after restore');
    const runtimeTexts = revived.session.deriveMessages().filter((m) => JSON.stringify(m).includes('supersedes earlier runtime-context snapshots'));
    check(runtimeTexts.length <= 1, 'Option A ceiling: normal projection retains <= 1 applicable runtime snapshot', 'n=' + runtimeTexts.length);
    // Race gate: a NEWER host snapshot committed between plan and apply must BLOCK.
    const gateBefore = compaction.currentRuntimeSnapshotUnchanged(session, plan.pinnedCurrentRuntimeSeq);
    check(gateBefore.ok === true, 'apply-gate passes while the pinned snapshot is still current');
    session.append('user/message', runtimeSnapshot(POLICY_C), { surfaceOp: 'append' });
    const gateAfter = compaction.currentRuntimeSnapshotUnchanged(session, plan.pinnedCurrentRuntimeSeq);
    check(gateAfter.ok === false && gateAfter.reason === 'runtime-snapshot-changed', 'a newer host policy snapshot between plan and apply BLOCKS the frozen plan (never shadows a new current)');
  }

  section('F-03 REAL DSH RUNTIME-POLICY INTERPLAY (honest separation)');
  {
    const agentLoopPath = path.join(host.root, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js');
    const agentLoopSrc = fs.readFileSync(agentLoopPath, 'utf8');
    // Real production projection path contracts, read from the pinned source.
    check(agentLoopSrc.includes('var RuntimeContextProjection = class'), 'real host owns a RuntimeContextProjection (last-wins, non-owning)');
    check(agentLoopSrc.includes('this.retained = {') && agentLoopSrc.includes('surface.has(event.seq)'), 'real restore path re-derives retained from the last LIVE owned node');
    check(agentLoopSrc.includes('if (this.retained?.text === snapshot) return;'), 'real cadence is project-on-diff (uncommitted candidate, not a session append)');
    check(agentLoopSrc.includes('messages: context === void 0 ? claimed : [...claimed, context]'), 'real commit path stages the candidate through agent/pre-step, committed at the step boundary');
    check(agentLoopSrc.includes('isReplacementSurfaceEvent(event)') && agentLoopSrc.includes('this.retained = null'), 'real projection drops retained when its seq is shadowed by a replacement');
    // Behavioral evidence with the REAL session + REAL host helpers: the
    // constructor restore scan replicated against live session state
    // (last live owned node wins) before shadowing, after shadowing a stale
    // snapshot, and after flush+restore.
    const restoreScan = (sess) => {
      const live = new Set(compaction.surfaceNodesOf(sess));
      for (let i = sess.events.length - 1; i >= 0; i -= 1) {
        const e = sess.events[i];
        if (e && e.type === 'user/message' && compaction.isRuntimeContextMessage(e) && live.has(e.seq)) return e.seq;
      }
      return null;
    };
    const proc = createHostProcess();
    const sid = 'sess-a02-f03-' + Date.now();
    const session = proc.store.create(sid, { meta: { cwd: WORKSPACE } });
    buildBulkSession(session, [null, POLICY_A, null, POLICY_B, null, null]);
    const seqA = compaction.runtimeContextSeqsOf(session)[0];
    const seqB = compaction.runtimeContextSeqsOf(session)[1];
    check(restoreScan(session) === seqB, 'real last-wins scan: newest live owned snapshot (B) is authoritative before compaction');
    const binding = { taskId: TASK.taskId, taskInstanceId: TASK.taskInstanceId, sessionId: sid, workspace: TASK.workspace };
    const payloadText = payloadFor(1, 'f03');
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a02f03-'));
    const frozen = freezeGeneration(session, opDir, binding, 1, 'CKPT-F03', payloadText);
    compaction.applyCompactionOperationV2(session, frozen.durable, payloadText, frozen.durable);
    check(restoreScan(session) === seqB, 'shadowing stale A does not move authority: B still last live owned node');
    assert.ok(await flushBarrier(proc, session), 'F-03 flush participated');
    const revived = restartFromDurable(proc.durable, sid);
    check(restoreScan(revived.session) === seqB, 'after restore the same current policy (B) is authoritative');
    // Honest limitation marker: the full production waterfall
    // (systemPrompt.assemble → RuntimeContextProjection.project →
    // agent/pre-step → step-boundary append) requires a booted agent loop
    // with a model; no offline supported path triggers it. Synthetic
    // session.append snapshots share provenance shape + supersede text +
    // surface ordering, but NOT the project-on-diff cadence.
    const eventTypes = new Set(revived.session.events.map((e) => e.type));
    check(!eventTypes.has('agent/pre-step') && !eventTypes.has('turn/start'), 'LIMITATION (recorded, not hidden): full pre-step waterfall not exercised offline — synthetic snapshots model provenance + ordering only');
    console.log('INFO: F-03 conclusion — Option A is proven against the real session surface + pinned projection source contract; genuine project-on-diff cadence remains UNVERIFIED offline (no supported trigger without a live agent loop).');
  }

  section('V1 BACKWARD COMPATIBILITY (production baseline untouched)');
  {
    const v1a = compaction.deriveCanonicalOperationId('TASK-1', 'task_a', 'sess-1');
    check(v1a === compaction.deriveCanonicalOperationId('TASK-1', 'task_a', 'sess-1'), 'V1 operation identity derivation is unchanged and deterministic');
    check(v1a.startsWith('ccop_'), 'V1 IDs keep the ccop_ prefix in the V1 domain');
    const goodOp = { schemaVersion: 1, operationId: v1a, taskId: 'TASK-1', taskInstanceId: 'task_a', sessionId: 'sess-1', workspace: '/ws', checkpointPath: 'cp.json', replacementStart: 0, replacementEnd: 3, sourceEventSeqs: [0, 1, 3], segments: [{ start: 0, end: 1, sourceEventSeqs: [0, 1] }, { start: 3, end: 3, sourceEventSeqs: [3] }], completionBoundarySeq: 9 };
    const goodExp = { taskId: 'TASK-1', taskInstanceId: 'task_a', sessionId: 'sess-1', workspace: '/ws', repositoryId: null, checkoutId: null };
    check(compaction.validateOperationForApply(goodOp, goodExp).valid === true, 'V1 operation validation is unchanged');
    check(compaction.validateCompactionOperationV2(Object.assign({}, goodOp, { schemaVersion: 1 }), goodExp).valid === false, 'V1 schemaVersion: 1 is never reinterpreted as V2');
    let threw = null;
    try { compaction.persistCompactionOperationV2(fs.mkdtempSync(path.join(os.tmpdir(), 'a02v1-')), goodOp); } catch (e) { threw = e; }
    check(threw !== null, 'V1 operation is refused by the V2 persistence path (explicit schema branching)');
    check(compaction.readCompactionOperationV2(fs.mkdtempSync(path.join(os.tmpdir(), 'a02empty-'))) === null, 'absent V2 operation reads as null (never as corrupt)');
  }

  section('SUMMARY');
  console.log('host: @deepseek-ai/dsh-session ' + host.version + ' (real SessionStore + real session/flush barrier + real restore)');
  console.log('RESULT: ' + passed + ' A02 operation assertions passed, ' + failed + ' failed (live pinned DSH host).');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL: ' + (error && error.message ? error.message : error));
  if (error && error.stack) console.error(error.stack);
  process.exit(1);
});
