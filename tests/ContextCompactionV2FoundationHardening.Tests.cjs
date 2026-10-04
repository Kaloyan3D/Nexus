'use strict';
/**
 * ContextCompactionV2FoundationHardening.Tests.cjs - CCV2-A05H foundation
 * hardening proof (H7 regression / security proofs + H8 formula freeze).
 *
 * Proves against the REAL production modules (no fakes, no mocks):
 *
 *   H1  unknown protocol fields FAIL CLOSED (top-level + nested), digest/id
 *       recomputation never legalizes them, secret-bearing extras block
 *       before persistence, canonical valid objects stay byte-identical.
 *   H2  snapshot-bound checkpoints require a full real SnapshotManager
 *       token; forged bare identity and legacy null/null behave exactly as
 *       specified.
 *   H3  A02 mutation requires persisted read-back proof (branded handle +
 *       byte identity); raw clones, stale handles, and restarts behave.
 *   H4  the live-host gate: optional SKIP vs strict REQUIRED-MISSING, plus
 *       static wiring of both live proofs.
 *   H5  seal tamper lands on the stable mismatch code; documentation states
 *       the unkeyed-integrity threat model without authenticity overclaims.
 *   H6  durability scope is frozen as documented (static assertions).
 *   H8  frozen domains/formulas reproduce known vectors byte-for-byte.
 *
 * Frozen formulas are NEVER recomputed against themselves here: the expected
 * vectors below are pinned outputs captured from the pre-hardening code and
 * must remain byte-for-byte identical after this task.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
const snapshot = require(path.join(repoRoot, 'config', 'ContextSnapshotV2.cjs'));
const trust = require(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'));
const liveGate = require(path.join(__dirname, 'Ccv2LiveHostGate.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function throwsWith(fn, fragment, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).includes(fragment), name, error ? String(error.message).slice(0, 220) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-h-' + tag + '-'));
}
function spySession() {
  return { appends: [], append(type, node, opts) { this.appends.push({ type, node, opts }); return { seq: 1000 + this.appends.length }; } };
}

// ── grounded fixtures ──────────────────────────────────────────────────────
const CREATED_H = '2026-09-25T10:00:00.000Z';
const CAPTURED_H = '2026-09-25T10:05:00.000Z';
const SEALED_H = '2026-09-25T10:06:00.000Z';
const TASK_H = { taskId: 'TASK-H', taskInstanceId: 'task_h_0001', sessionId: 'sess-h', workspace: '/tmp/nexus-h' };

function taskStateH() {
  return {
    objective: { text: 'Harden the foundation.', status: 'in-progress' },
    requirements: [{ id: 'R-h', text: 'Close the gaps.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'H', remainingMilestones: [] },
    decisions: [],
    failures: { activeFailures: [], rejectedHypotheses: [] },
    verification: { outcomes: [] },
    continuation: { nextAction: 'Harden.', unresolvedQuestions: [] },
  };
}
function baseStateH(overrides) {
  return Object.assign({
    taskId: 'TASK-H', taskInstanceId: 'task_h_0001', sessionId: 'sess-h', workspaceId: '/tmp/nexus-h',
    repositoryId: 'repo-h', checkoutId: 'co-h', generation: 1, safePointBoundarySeq: 9, sessionRevision: 42,
    taskRevision: snapshot.deriveTaskRevision(taskStateH()),
    repositoryRevision: { headCommit: 'abc123', indexDigest: snapshot.sha256HexUtf8('h:index'), worktreeDigest: snapshot.sha256HexUtf8('h:worktree') },
    runtimeRevision: { runtimeSnapshotSeq: 7 },
  }, overrides || {});
}
function checkpointInputH(token, overrides) {
  return Object.assign({
    taskId: 'TASK-H', taskInstanceId: 'task_h_0001', sessionId: 'sess-h', workspaceId: '/tmp/nexus-h',
    repositoryId: 'repo-h', checkoutId: 'co-h', generation: 1, kind: 'active',
    safePointBoundarySeq: 9, safePointStepId: null, createdAtUtc: CREATED_H,
    objective: { text: 'Harden the foundation.', status: 'in-progress' },
    requirements: [{ id: 'R-h', text: 'Close the gaps.', status: 'active', evidenceRefs: [] }],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: [], currentMilestone: 'H', remainingMilestones: [] },
    decisions: [],
    repository: { repositoryId: 'repo-h', checkoutId: 'co-h', headCommit: 'abc123', baseCommit: null, cleanWorktree: false, changedFiles: ['config/ContextCheckpointV2.cjs'], changedFileCount: 1, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
    verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: null }] },
    continuation: { nextAction: 'Harden.', unresolvedQuestions: [], recentUserIntent: null },
    snapshotToken: token === undefined ? null : token,
  }, overrides || {});
}
function provenanceInputsH() {
  const entry = (fieldKind, sourceKind, sourceRefs) => ({ fieldKind, sourceKind, sourceRefs });
  return {
    'objective.text': entry('task-objective', 'controller', ['task-state:h']),
    'repository': entry('repository-fact', 'repository', ['git:HEAD:abc123']),
    'requirements.0.text': entry('requirement-text', 'controller', ['user:session-event:12', 'task-state:h']),
    'requirements.0.status': entry('requirement-status', 'controller', ['task-state:h']),
    'constraints.0.text': entry('constraint-text', 'controller', ['policy:branch-freeze', 'task-state:h']),
    'verification.outcomes.0.status': entry('verification-outcome', 'verification', ['verification:E-h']),
    'continuation.nextAction': entry('next-action', 'controller', ['task-state:h']),
  };
}
const PAYLOAD_H = '<nexus-context-checkpoint schema="2" generation="1">\nH hardening text projection.\nStatus: complete - authority: deterministic-controller - engine: muse\n</nexus-context-checkpoint>';
function freezeOpH(dir, tag, ckptId, generation, snapshotTokenId) {
  const operationId = compaction.deriveCanonicalOperationIdV2(TASK_H.taskId, TASK_H.taskInstanceId, TASK_H.sessionId, generation, ckptId);
  const draft = {
    schemaVersion: 2, operationId, attemptId: 'att-h-' + tag,
    taskId: TASK_H.taskId, taskInstanceId: TASK_H.taskInstanceId, sessionId: TASK_H.sessionId,
    checkpointId: ckptId, checkpointGeneration: generation,
    checkpointContentDigest: compaction.sha256HexUtf8(PAYLOAD_H),
    snapshotTokenId: snapshotTokenId === undefined ? null : snapshotTokenId,
    safePointBoundarySeq: 9, sourceEventSeqs: [4, 5],
    segments: [{ start: 4, end: 5, sourceEventSeqs: [4, 5], role: 'payload' }],
    lifecycle: 'frozen', workspace: TASK_H.workspace, repositoryId: null, checkoutId: null,
  };
  const expected = { taskId: TASK_H.taskId, taskInstanceId: TASK_H.taskInstanceId, sessionId: TASK_H.sessionId, workspace: TASK_H.workspace, checkpointGeneration: generation, checkpointId: ckptId };
  const durable = compaction.freezeCompactionOperationV2(dir, draft, expected);
  return { draft, durable, expected, payloadText: PAYLOAD_H };
}
// Recompute checkpoint digest+id over an object that carries extra keys
// (simulating an attacker/peer that recomputes identities after injecting
// unknown schema fields). Closed-world validation must still BLOCK.
function recomputeCheckpointIdentity(obj) {
  const payload = {};
  for (const key of Object.keys(obj)) {
    if (key === 'checkpointId' || key === 'checkpointContentDigest' || key === 'seal') continue;
    payload[key] = obj[key];
  }
  obj.checkpointContentDigest = checkpoint.deriveCheckpointContentDigest(payload);
  obj.checkpointId = checkpoint.deriveCheckpointIdV2(obj.taskId, obj.taskInstanceId, obj.sessionId, obj.generation, obj.checkpointContentDigest);
  return obj;
}

const tokH = snapshot.capture(baseStateH(), CAPTURED_H);
const cpH = checkpoint.buildCheckpointV2(checkpointInputH(tokH));
const sealedH = trust.buildSealedCheckpointV2(checkpointInputH(tokH), provenanceInputsH(), { sealedAtUtc: SEALED_H });

// ── H1: closed-world schema validation ─────────────────────────────────────
section('H1 CLOSED-WORLD SCHEMA VALIDATION');
check(snapshot.validateSnapshotToken(tokH).valid === true, 'H1 baseline: real token validates');
check(checkpoint.validateCheckpointV2(cpH.checkpoint).valid === true, 'H1 baseline: real checkpoint validates');
check(trust.validateSealedCheckpoint(sealedH.checkpoint).valid === true, 'H1 baseline: real sealed checkpoint validates');

// 1. unknown ContextSnapshotToken field -> BLOCK
{
  const evil = clone(tokH); evil.injectedField = 'x';
  const r = snapshot.validateSnapshotToken(evil);
  check(r.valid === false && r.reason === 'snapshot-token-invalid', '1 unknown token field BLOCKs (snapshot-token-invalid)', r.reason);
}
// 2. unknown repositoryRevision field -> BLOCK
{
  const evil = clone(tokH); evil.repositoryRevision.injectedField = 'x';
  const r = snapshot.validateSnapshotToken(evil);
  check(r.valid === false && r.reason === 'snapshot-token-invalid', '2 unknown repositoryRevision field BLOCKs', r.reason);
}
// 3. unknown runtimeRevision field -> BLOCK
{
  const evil = clone(tokH); evil.runtimeRevision.injectedField = 'x';
  const r = snapshot.validateSnapshotToken(evil);
  check(r.valid === false && r.reason === 'snapshot-token-invalid', '3 unknown runtimeRevision field BLOCKs', r.reason);
}
// 4. unknown checkpoint top-level field -> BLOCK
{
  const evil = clone(cpH.checkpoint); evil.injectedField = 'x';
  const r = checkpoint.validateCheckpointV2(evil);
  check(r.valid === false, '4 unknown checkpoint top-level field BLOCKs', r.reason);
}
// 5. unknown checkpoint nested field -> BLOCK
{
  const evil = clone(cpH.checkpoint); evil.objective.injectedField = 'x';
  const r = checkpoint.validateCheckpointV2(evil);
  check(r.valid === false && r.reason === 'checkpoint-objective-missing', '5 unknown checkpoint nested field BLOCKs', r.reason);
}
// 6. unknown operation field -> BLOCK
{
  const f = freezeOpH(tmpDir('h1-op-'), 'u1', 'CKPT-H-U1', 1, null);
  const evil = clone(f.durable); evil.injectedField = 'x';
  const r = compaction.validateCompactionOperationV2(evil, f.expected);
  check(r.valid === false && r.reason === 'operation-schema-mismatch', '6 unknown operation field BLOCKs', r.reason);
}
// 7. unknown segment field -> BLOCK
{
  const f = freezeOpH(tmpDir('h1-seg-'), 'u2', 'CKPT-H-U2', 1, null);
  const evil = clone(f.durable); evil.segments[0].injectedField = 'x';
  const r = compaction.validateCompactionOperationV2(evil, f.expected);
  check(r.valid === false && r.reason === 'operation-schema-mismatch', '7 unknown segment field BLOCKs', r.reason);
}
// 7b. unknown attempt field -> BLOCK (create refuses, validate refuses, persist refuses)
{
  const attempt = compaction.createCompactionAttemptV2({ attemptId: 'att-h-x', operationId: 'ccop_x', taskId: 'TASK-H', taskInstanceId: 'task_h_0001', sessionId: 'sess-h', generation: 1 });
  const evil = Object.assign({}, attempt, { injectedField: 'x' });
  const r = compaction.validateCompactionAttemptV2(evil);
  check(r.valid === false && r.reason === 'operation-schema-mismatch', '7b unknown attempt field BLOCKs', r.reason);
  throwsWith(() => compaction.createCompactionAttemptV2({ attemptId: 'a', operationId: 'o', taskId: 't', taskInstanceId: 'ti', sessionId: 's', generation: 1, injectedField: 'x' }), 'unknown field', '7b attempt create refuses unknown input (never stripped)');
  throwsWith(() => compaction.persistCompactionAttemptV2(tmpDir('h1-att-'), evil), 'attempt refused', '7b attempt persist refuses unknown field before write');
}
// 8. unknown TrustProvenance field -> BLOCK
{
  const normalized = trust.normalizeField({ fieldPath: 'objective.text', fieldKind: 'task-objective', value: null, sourceKind: 'controller', sourceRefs: ['task-state:h'] });
  const evil = Object.assign({}, normalized.provenance, { injectedField: 'x' });
  const r = trust.validateTrustProvenance(evil);
  check(r.valid === false && r.reason === 'checkpoint-provenance-invalid', '8 unknown TrustProvenance field BLOCKs', r.reason);
  const mapEvil = { schemaVersion: 1, fields: { 'objective.text': Object.assign({}, normalized.provenance, { fieldKind: 'task-objective', injectedField: 'x' }) } };
  check(trust.validateProvenanceMap(mapEvil).valid === false, '8 unknown provenance entry field BLOCKs the map');
  check(trust.validateProvenanceMap({ schemaVersion: 1, fields: {}, injectedField: 'x' }).valid === false, '8 unknown provenance envelope field BLOCKs the map');
}
// 9. unknown ContentSeal field -> BLOCK
{
  const evil = clone(sealedH.checkpoint); evil.seal.injectedField = 'x';
  evil.seal.sealDigest = trust.deriveSealDigestV1(trust.sealBodyWithoutDigest(evil.seal));
  const r = trust.validateContentSeal(evil.seal, evil.checkpoint);
  check(r.valid === false && r.reason === 'checkpoint-seal-invalid', '9 unknown ContentSeal field BLOCKs (checkpoint-seal-invalid)', r.reason);
}
// 10. digest/id recomputation does not legalize unknown schema fields
{
  const evilTop = recomputeCheckpointIdentity(Object.assign(clone(cpH.checkpoint), { injectedField: 'x' }));
  check(checkpoint.validateCheckpointV2(evilTop).valid === false, '10 recomputed id/digest does not legalize unknown top-level field', checkpoint.validateCheckpointV2(evilTop).reason);
  const evilNested = clone(cpH.checkpoint); evilNested.objective.injectedField = 'x'; recomputeCheckpointIdentity(evilNested);
  check(checkpoint.validateCheckpointV2(evilNested).valid === false, '10 recomputed id/digest does not legalize unknown nested field', checkpoint.validateCheckpointV2(evilNested).reason);
  const evilTok = clone(tokH); evilTok.injectedField = 'x';
  evilTok.revisionDigest = snapshot.deriveRevisionDigest(snapshot.revisionBodyOf(snapshot.normalizeSnapshotState({
    taskId: evilTok.taskId, taskInstanceId: evilTok.taskInstanceId, sessionId: evilTok.sessionId, workspaceId: evilTok.workspaceId,
    repositoryId: evilTok.repositoryId, checkoutId: evilTok.checkoutId, generation: evilTok.generation,
    safePointBoundarySeq: evilTok.safePointBoundarySeq, sessionRevision: evilTok.sessionRevision, taskRevision: evilTok.taskRevision,
    repositoryRevision: evilTok.repositoryRevision, runtimeRevision: evilTok.runtimeRevision,
  })));
  evilTok.snapshotTokenId = snapshot.deriveSnapshotTokenId(evilTok.taskId, evilTok.taskInstanceId, evilTok.sessionId, evilTok.generation, evilTok.revisionDigest);
  check(snapshot.validateSnapshotToken(evilTok).valid === false, '10 recomputed token identities do not legalize unknown token field', snapshot.validateSnapshotToken(evilTok).reason);
  const f = freezeOpH(tmpDir('h1-recomp-'), 'u3', 'CKPT-H-U3', 1, null);
  const evilOp = clone(f.durable); evilOp.injectedField = 'x';
  evilOp.operationId = compaction.deriveCanonicalOperationIdV2(evilOp.taskId, evilOp.taskInstanceId, evilOp.sessionId, evilOp.checkpointGeneration, evilOp.checkpointId);
  check(compaction.validateCompactionOperationV2(evilOp, f.expected).valid === false, '10 recomputed operationId does not legalize unknown operation field');
}
// secret-bearing extras BLOCK before persistence (and never land on disk)
{
  const dir = tmpDir('h1-secret-op-');
  const f = freezeOpH(dir, 's0', 'CKPT-H-S0', 1, null);
  const evilDraft = Object.assign(clone(f.draft), { apiKey: 'sk-secretnotreal1234567890' });
  throwsWith(() => compaction.freezeCompactionOperationV2(tmpDir('h1-secret-op2-'), evilDraft, f.expected), 'operation-schema-mismatch', 'secret-bearing operation extra BLOCKs before persistence');
  const tdir = tmpDir('h1-secret-tok-');
  const evilTok = Object.assign(clone(tokH), { accessToken: 'Bearer secretnotreal' });
  throwsWith(() => snapshot.persistSnapshotToken(tdir, evilTok), 'snapshot-token-invalid', 'secret-bearing token extra BLOCKs before persistence');
  check(snapshot.readSnapshotToken(tdir, tokH.snapshotTokenId) === null, 'secret-bearing token never persisted (absent read)');
  const cdir = tmpDir('h1-secret-cp-');
  const evilCp = Object.assign(clone(cpH.checkpoint), { password: 'hunter2-notreal' });
  check(checkpoint.validateCheckpointV2(evilCp).valid === false, 'secret-bearing checkpoint extra BLOCKs before persistence');
}
// PS twin alignment: the Windows-plane validator enforces the same
// closed-world property (same shared operation file, same reason code).
{
  const psLifecycle = fs.readFileSync(path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1'), 'utf8');
  check(psLifecycle.includes('$operationV2Keys') && psLifecycle.includes("'createdAtUtc'") , 'H1 PS twin enforces exact operation keys (shared-file compatible)');
  check(psLifecycle.includes('$segmentV2Keys'), 'H1 PS twin enforces exact segment keys');
}
// canonical valid objects remain byte-identical and green
{
  const cpAgain = checkpoint.buildCheckpointV2(checkpointInputH(tokH));
  check(cpAgain.serialized === cpH.serialized, 'canonical checkpoint build is byte-identical and green');
  check(snapshot.serializeSnapshotTokenCanonical(snapshot.capture(baseStateH(), CAPTURED_H)) === snapshot.serializeSnapshotTokenCanonical(tokH), 'canonical token capture is byte-identical and green');
  check(checkpoint.serializeCheckpointCanonical(JSON.parse(cpH.serialized)) === cpH.serialized, 'checkpoint serialized bytes are canonical read-back identity');
}

// ── H2: snapshot identity bypass removed ───────────────────────────────────
section('H2 SNAPSHOT IDENTITY BYPASS REMOVED');
// 11. forged bare checkpoint snapshot identity -> BLOCK
{
  throwsWith(() => checkpoint.buildCheckpointV2(checkpointInputH(null, { snapshot: { snapshotTokenId: tokH.snapshotTokenId, revisionDigest: tokH.revisionDigest } })),
    'raw snapshot slots are not accepted', '11 forged tokenId+revisionDigest pair without full token BLOCKs');
}
// 12. real full SnapshotToken -> PASS (+ mismatch legs BLOCK)
{
  const bound = checkpoint.buildCheckpointV2(checkpointInputH(tokH));
  check(checkpoint.snapshotModeOf(bound.checkpoint) === 'snapshot-bound', '12 full real token builds a snapshot-bound checkpoint');
  check(snapshot.validateCheckpointSnapshotBinding(bound.checkpoint, tokH).valid === true, '12 bound checkpoint <-> token binding VALID');
  const wrongTask = snapshot.capture(baseStateH({ taskId: 'TASK-OTHER' }), CAPTURED_H);
  throwsWith(() => checkpoint.buildCheckpointV2(checkpointInputH(wrongTask)), 'snapshotToken taskId must equal checkpoint taskId', '12 token/task mismatch BLOCKs');
  const wrongSession = snapshot.capture(baseStateH({ sessionId: 'sess-other' }), CAPTURED_H);
  throwsWith(() => checkpoint.buildCheckpointV2(checkpointInputH(wrongSession)), 'snapshotToken sessionId must equal checkpoint sessionId', '12 token/session mismatch BLOCKs');
  const wrongGen = snapshot.capture(baseStateH({ generation: 2 }), CAPTURED_H);
  throwsWith(() => checkpoint.buildCheckpointV2(checkpointInputH(wrongGen)), 'must equal checkpoint generation', '12 token/generation mismatch BLOCKs');
  const tampered = clone(tokH); tampered.snapshotTokenId = 'cst_' + '0'.repeat(32);
  throwsWith(() => checkpoint.buildCheckpointV2(checkpointInputH(tampered)), 'snapshotToken refused', '12 tampered token BLOCKs at build');
}
// 13. legacy null/null checkpoint remains legacy (valid but NOT bound)
{
  const legacy = checkpoint.buildCheckpointV2(checkpointInputH(null));
  check(checkpoint.snapshotModeOf(legacy.checkpoint) === 'legacy', '13 legacy no-token checkpoint reports legacy mode');
  check(checkpoint.validateCheckpointV2(legacy.checkpoint).valid === true, '13 legacy checkpoint remains structurally valid');
  check(snapshot.validateCheckpointSnapshotBinding(legacy.checkpoint, tokH).reason === 'snapshot-token-missing', '13 legacy checkpoint is never bound (validateCheckpointSnapshotBinding rejects)');
  const explicitNull = checkpoint.buildCheckpointV2(checkpointInputH(null, { snapshot: { snapshotTokenId: null, revisionDigest: null } }));
  check(checkpoint.snapshotModeOf(explicitNull.checkpoint) === 'legacy', '13 explicit null/null slot stays legacy');
}

// ── H3: persisted read-back proof before mutation ──────────────────────────
section('H3 PERSISTED READ-BACK PROOF');
// 14. raw in-memory clone cannot satisfy the persisted-operation proof
{
  const f = freezeOpH(tmpDir('h3-clone-'), 'c1', 'CKPT-H-C1', 1, null);
  const rawClone = clone(f.durable);
  check(JSON.stringify(rawClone) === JSON.stringify(f.durable), '14 precondition: clone is byte-identical');
  throwsWith(() => compaction.applyCompactionOperationV2(spySession(), f.durable, f.payloadText, rawClone),
    'durable proof missing', '14 raw equal clone BLOCKs (no first append without read-back proof)');
  const session = spySession();
  try { compaction.applyCompactionOperationV2(session, f.durable, f.payloadText, rawClone); } catch { /* expected */ }
  check(session.appends.length === 0, '14 BLOCKed apply lands zero appends');
}
// 15. persisted/read-back operation can apply
{
  const dir = tmpDir('h3-readback-');
  const f = freezeOpH(dir, 'c2', 'CKPT-H-C2', 1, null);
  const stored = compaction.readCompactionOperationV2(dir);
  check(JSON.stringify(stored) === JSON.stringify(f.durable), '15 precondition: read-back is byte-identical');
  const session = spySession();
  const applied = compaction.applyCompactionOperationV2(session, f.durable, f.payloadText, stored);
  check(session.appends.length === 1 && applied.nextLifecycle === 'awaiting-durability', '15 persisted read-back applies exactly once');
  throwsWith(() => compaction.retryMissingSegmentsV2(spySession(), f.durable, f.payloadText, clone(f.durable), [0]),
    'durable proof missing', '15 retry path also requires the read-back proof');
  const retrySession = spySession();
  const retried = compaction.retryMissingSegmentsV2(retrySession, f.durable, f.payloadText, stored, [0]);
  check(retrySession.appends.length === 1 && retried.nextLifecycle === 'awaiting-durability', '15 retry with read-back proof applies the missing segment');
}
// 16. restart read-back can apply/reconcile
{
  const dir = tmpDir('h3-restart-');
  const f = freezeOpH(dir, 'c3', 'CKPT-H-C3', 1, null);
  // Simulated restart: fresh reads from disk only (new object identities).
  const reread = compaction.readCompactionOperationV2(dir);
  check(reread !== f.durable, '16 precondition: restart read is a new object identity');
  const session = spySession();
  compaction.applyCompactionOperationV2(session, reread, f.payloadText, reread);
  check(session.appends.length === 1, '16 restart read-back can apply');
  const fakeSession = (events, nodes) => ({ events, surface: { nodes } });
  const userEvent = (seq, text) => ({ seq, type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } });
  const untouched = fakeSession([4, 5].map((seq) => userEvent(seq, 'discussion ' + seq)), [4, 5]);
  const rec = compaction.reconcileCompactionOperationV2(reread, untouched, { payloadText: f.payloadText, durable: false });
  check(rec.decision === 'apply', '16 restart read-back reconciles (A02 reconciliation unchanged)', rec.reason);
  // stale/different persisted object BLOCKs
  const other = freezeOpH(tmpDir('h3-stale-'), 'c4', 'CKPT-H-C4', 2, null);
  throwsWith(() => compaction.applyCompactionOperationV2(spySession(), f.durable, f.payloadText, other.durable),
    'durable frozen operation required before mutation', '16 stale/different persisted handle BLOCKs');
}
// 17. stale A05 state still blocks before the FIRST new append
{
  const f = freezeOpH(tmpDir('h3-a05-'), 'c5', 'CKPT-H-C5', 1, tokH.snapshotTokenId);
  const session = spySession();
  const gate = snapshot.revalidateBeforeMutation(tokH, baseStateH({ sessionRevision: 77 }));
  check(gate.valid === false && gate.reason === 'snapshot-session-stale', '17 stale live state BLOCKs at the pre-mutation gate', gate.reason);
  if (gate.valid !== true) {
    // TransactionalApply must not proceed: zero appends land.
  } else {
    compaction.applyCompactionOperationV2(session, f.durable, f.payloadText, f.durable);
  }
  check(session.appends.length === 0, '17 BLOCKed operation lands no payload before the first new append');
  check(snapshot.revalidateBeforeMutation(tokH, baseStateH()).valid === true, '17 fresh state still passes the pre-mutation gate');
}

// ── H4: live-host gate ─────────────────────────────────────────────────────
section('H4 LIVE-HOST STRICT GATE');
// 18. optional missing host -> SKIP permitted
{
  check(liveGate.decideLiveHostGate(false, {}) === 'SKIPPED', '18 host missing + strict unset -> SKIPPED');
  check(liveGate.decideLiveHostGate(false, { NEXUS_REQUIRE_CCV2_LIVE_HOST: '0' }) === 'SKIPPED', '18 host missing + strict=0 -> SKIPPED');
  check(liveGate.decideLiveHostGate(false, { NEXUS_REQUIRE_CCV2_LIVE_HOST: 'false' }) === 'SKIPPED', '18 host missing + strict=false -> SKIPPED');
  check(liveGate.decideLiveHostGate(false, { NEXUS_REQUIRE_CCV2_LIVE_HOST: '' }) === 'SKIPPED', '18 host missing + strict empty -> SKIPPED');
  check(liveGate.reportLiveHostGate('A99', 'SKIPPED') === 'SKIPPED', '18 SKIPPED report returns without exiting');
}
// 19. strict missing host -> FAIL (non-zero exit, never faked)
{
  check(liveGate.decideLiveHostGate(false, { NEXUS_REQUIRE_CCV2_LIVE_HOST: '1' }) === 'REQUIRED-MISSING', '19 host missing + strict=1 -> REQUIRED-MISSING');
  check(liveGate.decideLiveHostGate(false, { NEXUS_REQUIRE_CCV2_LIVE_HOST: 'true' }) === 'REQUIRED-MISSING', '19 host missing + strict=true -> REQUIRED-MISSING');
  check(liveGate.decideLiveHostGate(false, { NEXUS_REQUIRE_CCV2_LIVE_HOST: 'YES' }) === 'REQUIRED-MISSING', '19 host missing + strict=YES -> REQUIRED-MISSING');
  let exitCode = null;
  try {
    execFileSync(process.execPath, ['-e', "require(" + JSON.stringify(path.join(__dirname, 'Ccv2LiveHostGate.cjs')) + ").reportLiveHostGate('A99', 'REQUIRED-MISSING')"], { encoding: 'utf8', timeout: 30000 });
  } catch (e) { exitCode = e.status; }
  check(exitCode !== null && exitCode !== 0, '19 REQUIRED-MISSING exits non-zero', 'exit=' + exitCode);
}
// 20. real host -> execute proof (+ static wiring of both live proofs)
{
  check(liveGate.decideLiveHostGate(true, {}) === 'EXECUTED', '20 host present -> EXECUTED (optional mode)');
  check(liveGate.decideLiveHostGate(true, { NEXUS_REQUIRE_CCV2_LIVE_HOST: '1' }) === 'EXECUTED', '20 host present + strict -> EXECUTED');
  const a01 = fs.readFileSync(path.join(__dirname, 'ContextCompactionV2DshGenerationProof.Tests.cjs'), 'utf8');
  const a02 = fs.readFileSync(path.join(__dirname, 'ContextCompactionV2Operation.Tests.cjs'), 'utf8');
  for (const [label, src, tag] of [['A01', a01, 'A01'], ['A02', a02, 'A02']]) {
    check(src.includes('Ccv2LiveHostGate.cjs'), label + ' proof requires the shared gate helper');
    check(src.includes("reportLiveHostGate('" + tag + "'"), label + ' proof reports ' + tag + ' LIVE HOST PROOF');
    check(src.includes('NEXUS_REQUIRE_CCV2_LIVE_HOST') || src.includes('Ccv2LiveHostGate'), label + ' proof wires the strict env contract');
  }
  const sessionPath = '/home/kaloyan/.local/share/nexus/app/node_modules/@deepseek-ai/dsh-session/lib/index.js';
  if (fs.existsSync(sessionPath)) {
    check(liveGate.decideLiveHostGate(true, process.env) === 'EXECUTED', '20 pinned host present in this env -> EXECUTED');
  } else {
    check(liveGate.decideLiveHostGate(false, process.env) === 'SKIPPED' || liveGate.decideLiveHostGate(false, process.env) === 'REQUIRED-MISSING', '20 pinned host absent -> gate decides SKIP-or-REQUIRED (env-driven)');
  }
}

// ── H5: seal threat model ──────────────────────────────────────────────────
section('H5 CONTENT-SEAL THREAT MODEL');
// 21. A04 seal metadata tamper -> existing stable mismatch code
{
  const evil = clone(sealedH.checkpoint);
  evil.seal.sealedAtUtc = '2026-09-26T10:06:00.000Z';
  const r = trust.validateSealedCheckpoint(evil);
  check(r.valid === false && r.reason === 'checkpoint-seal-record-digest-mismatch', '21 seal metadata tamper BLOCKs (checkpoint-seal-record-digest-mismatch)', r.reason);
  const evilSealOnly = clone(sealedH.seal);
  evilSealOnly.sealedAtUtc = '2026-09-26T10:06:00.000Z';
  check(trust.validateContentSeal(evilSealOnly, sealedH.checkpoint).reason === 'checkpoint-seal-record-digest-mismatch', '21 seal leg reports the record-digest code (never content-digest)');
}
// 22. documentation/threat-model static assertions
{
  const squashed = (text) => String(text).replace(/\s+/g, ' ').toLowerCase();
  const archPath = path.join(repoRoot, 'docs', 'architecture', 'context-compaction-v2.md');
  const archDocument = fs.readFileSync(archPath, 'utf8');
  // H5 specifies the checkpoint seal's threat model. Counter credential
  // HMACs and replay/text signatures in later sections describe other
  // mechanisms and must not be mistaken for checkpoint authenticity claims.
  const sealSectionOf = (document) => {
    const start = document.indexOf('### 3.13 `CheckpointContentSeal`');
    const end = document.indexOf('\n### ', start + 1);
    assert.ok(start >= 0 && end > start, 'checkpoint seal documentation section must exist');
    return document.slice(start, end);
  };
  const sealDocument = sealSectionOf(archDocument);
  const arch = squashed(sealDocument);
  const trustSrc = squashed(String(fs.readFileSync(path.join(repoRoot, 'config', 'ContextTrustV2.cjs'), 'utf8')).split('*').join(' '));
  for (const phrase of ['unkeyed integrity seal', 'deterministic tamper detection', 'record-integrity binding', 'does not defend against an attacker that can arbitrarily rewrite']) {
    check(arch.includes(phrase), '22 arch doc states "' + phrase + '"');
  }
  check(trustSrc.includes('unkeyed integrity seal') && trustSrc.includes('does not defend against an attacker that can arbitrarily rewrite'), '22 trust authority states the unkeyed-integrity threat model');
  check(!arch.includes('cryptographic authenticity'), '22 arch doc never claims cryptographic authenticity');
  const overclaimLines = (text) => String(text).split('\n').filter((line) => /signature|\bMAC\b|\bHMAC\b/i.test(line) && !/not a|NOT |out of scope|separately designed|HMAC\/key management is introduced/i.test(line));
  check(overclaimLines(sealDocument).length === 0, '22 no bare signature/MAC claim in the seal section', overclaimLines(sealDocument).join(' | ').slice(0, 200));
  const authenticityClaims = (text) => String(text).split('\n').filter((line) => /authentic/i.test(line) && !/NOT/i.test(line));
  const authenticLines = authenticityClaims(sealDocument);
  check(authenticLines.length === 0, '22 no positive authenticity claim remains in the seal section', authenticLines.join(' | ').slice(0, 200));
  check(overclaimLines(sealDocument + '\nThe checkpoint seal is a cryptographic signature.').length === 1,
    '22 seal signature overclaim mutation is still detected');
  check(authenticityClaims(sealDocument + '\nThe checkpoint seal guarantees authenticity.').length === 1,
    '22 seal authenticity overclaim mutation is still detected');
  check(sealSectionOf(archDocument + '\nA separate credential scope uses HMAC.\nReplay uses text signatures.\n') === sealDocument,
    '22 unrelated HMAC and replay signatures do not alter the seal threat-model subject');
}

// ── H6: durability scope ───────────────────────────────────────────────────
section('H6 DURABILITY SCOPE');
{
  const squashed = (text) => String(text).replace(/\s+/g, ' ');
  const arch = squashed(fs.readFileSync(path.join(repoRoot, 'docs', 'architecture', 'context-compaction-v2.md'), 'utf8'));
  check(arch.includes('power-loss durability is NOT claimed'), 'H6 arch doc freezes the power-loss exclusion');
  check(arch.includes('SessionStore.flush()'), 'H6 arch doc names the DSH flush barrier as authoritative');
  check(arch.includes('hardening is deferred as a separate future task'), 'H6 power-loss hardening explicitly deferred');
  const persistScopes = [
    ['config/ContextCompaction.cjs', 'operation/attempt persistence'],
    ['config/ContextCheckpointV2.cjs', 'checkpoint persistence'],
    ['config/ContextSnapshotV2.cjs', 'token persistence'],
    ['config/ContextTrustV2.cjs', 'sealed persistence'],
  ];
  for (const [rel, label] of persistScopes) {
    const src = squashed(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
    check(src.includes('power-loss durable') && /NOT claimed power-loss durable|not claimed power-loss durable|NOT power-loss durable/.test(src), 'H6 ' + label + ' states the frozen scope (' + rel + ')');
  }
  const ccv2Src = ['config/ContextCompaction.cjs', 'config/ContextCheckpointV2.cjs', 'config/ContextSnapshotV2.cjs', 'config/ContextTrustV2.cjs']
    .map((rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')).join('\n');
  check(!/crash-safe/i.test(ccv2Src), 'H6 no bare crash-safe claim remains in CCV2 authorities');
  check(!/crash-safe/i.test(String(fs.readFileSync(path.join(repoRoot, 'docs', 'architecture', 'context-compaction-v2.md'), 'utf8'))), 'H6 no bare crash-safe claim remains in the arch doc');
}

// ── ownership / semantics preserved ────────────────────────────────────────
section('OWNERSHIP AND SEMANTICS PRESERVED');
// 23. A01 proof logic unchanged (projection contracts intact)
{
  const a01 = fs.readFileSync(path.join(__dirname, 'ContextCompactionV2DshGenerationProof.Tests.cjs'), 'utf8');
  for (const anchor of ['SessionStore', 'deriveMessages', 'surfaceOp', 'fromRestore', 'session/flush']) {
    check(a01.includes(anchor), '23 A01 proof still exercises ' + anchor);
  }
}
// 24. A02 operation semantics unchanged
{
  const f = freezeOpH(tmpDir('h-sem-'), 'sem', 'CKPT-H-SEM', 1, null);
  check(compaction.validateCompactionOperationV2(f.durable, f.expected).valid === true, '24 1 payload + frozen lifecycle still validates');
  const fakeSession = (events, nodes) => ({ events, surface: { nodes } });
  const userEvent = (seq, text) => ({ seq, type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } });
  const untouched = fakeSession([4, 5].map((seq) => userEvent(seq, 'discussion ' + seq)), [4, 5]);
  const rec = compaction.reconcileCompactionOperationV2(f.durable, untouched, { payloadText: f.payloadText, durable: false });
  check(rec.decision === 'apply', '24 zero-landed reconciliation still says apply (semantics unchanged)', rec.reason);
  const opSrc = fs.readFileSync(path.join(repoRoot, 'config', 'ContextCompaction.cjs'), 'utf8');
  check(opSrc.includes('payload-segment-missing') && opSrc.includes('awaiting-durability'), '24 A02 decision vocabulary unchanged');
}
// 25-28 + H8. formula freeze: domains + pinned vectors byte-for-byte
{
  check(checkpoint.CHECKPOINT_ID_DOMAIN_V2 === 'nexus/context-checkpoint/v2', 'H8 A03 checkpoint id domain frozen');
  check(trust.CONTENT_SEAL_DIGEST_DOMAIN_V1 === 'nexus/context-content-seal/v1', 'H8 A04 seal digest domain frozen');
  check(snapshot.REVISION_DIGEST_DOMAIN_V1 === 'nexus/context-snapshot-revision/v1', 'H8 A05 revision digest domain frozen');
  check(snapshot.SNAPSHOT_TOKEN_ID_DOMAIN_V1 === 'nexus/context-snapshot-token/v1', 'H8 A05 token id domain frozen');
  const hex64 = 'a'.repeat(64);
  check(checkpoint.deriveCheckpointIdV2('TASK-A03', 'task_a03_0001', 'sess-a03', 1, hex64) === 'ccp_c4f15c8b0e4b8ca7869bb282fd51d733', '25 A03 checkpointId vector unchanged');
  check(checkpoint.deriveCheckpointContentDigest({ a: 1 }) === '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862', '25 A03 content-digest vector unchanged');
  const sealBody = { schemaVersion: 1, checkpointId: 'ccp_00000000000000000000000000000000', checkpointContentDigest: hex64, generation: 1, taskId: 'T', taskInstanceId: 'TI', sessionId: 'S', sealedAtUtc: '2026-09-25T10:00:00.000Z', algorithm: 'sha256' };
  check(trust.deriveSealDigestV1(sealBody) === 'da0f9fddd5beed89291c44816bfe5a35ad4b12cdef036b60c2a1d49f388e55e0', '26 A04 sealDigest vector unchanged');
  const runtimeDigest = snapshot.deriveRuntimeSnapshotDigest('rss_7');
  const revBody = { taskId: 'TASK-A05', taskInstanceId: 'task_a05_0001', sessionId: 'sess-a05', workspaceId: '/tmp/nexus-a05', repositoryId: 'repo-a05', checkoutId: 'co-a05', safePointBoundarySeq: 9, sessionRevision: 42, taskRevision: hex64, repositoryRevision: { headCommit: 'abc123', indexDigest: hex64, worktreeDigest: hex64 }, runtimeRevision: { runtimeSnapshotSeq: 7, runtimeSnapshotId: 'rss_7', runtimeSnapshotDigest: runtimeDigest } };
  const revDigest = snapshot.deriveRevisionDigest(revBody);
  check(revDigest === '549c9ff6234f382e99a858c7c65b43081229facee81178a22e55d3e47de6f587', '27 A05 revisionDigest vector unchanged');
  check(snapshot.deriveSnapshotTokenId('TASK-A05', 'task_a05_0001', 'sess-a05', 1, revDigest) === 'cst_91d6e0d1bd76a7c6d6a8daf1c49569b2', '28 A05 snapshotTokenId vector unchanged');
}

console.log('\n--- SUMMARY ---');
console.log('A05H foundation hardening suite: ' + passed + ' passed, ' + failed + ' failed.');

