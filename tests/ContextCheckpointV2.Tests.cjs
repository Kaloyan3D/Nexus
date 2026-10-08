'use strict';
/**
 * ContextCheckpointV2.Tests.cjs - CCV2-A03 Checkpoint Schema V2 proof.
 *
 * Proves against the REAL production modules (no fakes):
 *   schema happy path (active + complete), deterministic build +
 *   serialization, digest/id determinism, generation isolation, parent
 *   lineage CP1->CP2->CP3, self-contained CP3, 64 KiB UTF-8 bound,
 *   requirements/constraints retention, verification conservatism,
 *   redaction, repository truncation metadata, digest/ID tamper rejection,
 *   A02 operation binding to real checkpoint identity, JS/PS parity, and
 *   V1 coexistence.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));

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
  check(error !== null && String(error && error.message).includes(fragment), name, error ? String(error.message).slice(0, 200) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── grounded fixture inputs ────────────────────────────────────────────────
const CREATED_1 = '2026-09-25T10:00:00.000Z';
const CREATED_2 = '2026-09-25T11:00:00.000Z';
const CREATED_3 = '2026-09-25T12:00:00.000Z';

function baseInput(overrides) {
  return Object.assign({
    taskId: 'TASK-A03',
    taskInstanceId: 'task_a03_0001',
    sessionId: 'sess-a03',
    workspaceId: '/tmp/nexus-a03',
    repositoryId: null,
    checkoutId: null,
    generation: 1,
    kind: 'active',
    safePointBoundarySeq: 9,
    safePointStepId: null,
    createdAtUtc: CREATED_1,
    objective: { text: 'Ship checkpoint schema V2.', status: 'in-progress' },
    requirements: [
      { id: 'R-active', text: 'Requirements must survive recency.', status: 'active', evidenceRefs: [] },
      { id: 'R-done', text: 'Freeze the operation foundation.', status: 'satisfied', evidenceRefs: ['cmd:prove-a02'] },
    ],
    constraints: [{ type: 'branch', text: 'Stay on feature/content-compaction-v2.' }],
    progress: { taskStatus: 'in-progress', completedMilestones: ['A02 frozen'], currentMilestone: 'A03 schema', remainingMilestones: ['A04 seal'] },
    decisions: [{ id: 'D1', statement: 'Canonical JSON with sorted keys.', authority: 'controller-established', status: 'active', evidenceRefs: [] }],
    repository: { repositoryId: null, checkoutId: null, headCommit: 'abc123', baseCommit: null, cleanWorktree: true, changedFiles: ['config/ContextCheckpointV2.cjs'], changedFileCount: 1, stagedSummary: null, unstagedSummary: null },
    evidenceRefs: [],
    failures: { activeFailures: [], rejectedHypotheses: [], retryState: null },
    verification: { outcomes: [{ scope: 'unit', status: 'PENDING', detail: null }] },
    continuation: { nextAction: 'Implement the builder.', unresolvedQuestions: ['Seal formula?'], recentUserIntent: 'Land A03.' },
    pressure: { preCheckpointEffectiveInputTokens: 1000, peakEffectiveInputTokens: 2000 },
  }, overrides || {});
}

// ── schema happy path: active + complete ───────────────────────────────────
section('SCHEMA HAPPY PATH');
const cp1 = checkpoint.buildCheckpointV2(baseInput());
check(cp1.checkpoint.schemaVersion === 2, 'active checkpoint carries schemaVersion 2');
check(cp1.checkpoint.kind === 'active', 'active kind preserved');
check(cp1.checkpoint.parentCheckpointId === null, 'gen1 parent is null');
check(typeof cp1.checkpointId === 'string' && cp1.checkpointId.startsWith('ccp_'), 'checkpointId derived with ccp_ prefix');
check(/^[0-9a-f]{64}$/.test(cp1.contentDigest), 'contentDigest is sha256 hex');
check(cp1.checkpoint.checkpointId === cp1.checkpointId, 'finalized checkpoint carries derived id');
check(cp1.checkpoint.checkpointContentDigest === cp1.contentDigest, 'finalized checkpoint carries digest');
check(checkpoint.validateCheckpointV2(cp1.checkpoint).valid === true, 'happy-path checkpoint validates');

const cpComplete = checkpoint.buildCheckpointV2(baseInput({
  generation: 1, kind: 'complete',
  progress: { taskStatus: 'complete', completedMilestones: ['A03 schema'], currentMilestone: null, remainingMilestones: [] },
}));
check(cpComplete.checkpoint.kind === 'complete', 'complete kind supported');
check(checkpoint.validateCheckpointV2(cpComplete.checkpoint).valid === true, 'complete checkpoint validates');
throwsWith(() => checkpoint.buildCheckpointV2(baseInput({ kind: 'complete' })), 'kind=complete requires grounded progress.taskStatus=complete', 'kind=complete refused without controller-derived completion');

// ── deterministic build + serialization ────────────────────────────────────
section('DETERMINISM');
const cp1Again = checkpoint.buildCheckpointV2(baseInput());
check(cp1Again.serialized === cp1.serialized, 'identical grounded inputs build byte-identical checkpoints');
check(cp1Again.checkpointId === cp1.checkpointId, 'checkpointId deterministic across builds');
check(cp1Again.contentDigest === cp1.contentDigest, 'contentDigest deterministic across builds');
const shuffled = clone(cp1.checkpoint);
const reversed = {};
for (const key of Object.keys(shuffled).reverse()) reversed[key] = shuffled[key];
check(checkpoint.serializeCheckpointCanonical(reversed) === cp1.serialized, 'serialization independent of object insertion order');
const cp1Later = checkpoint.buildCheckpointV2(baseInput({ createdAtUtc: CREATED_2 }));
check(cp1Later.serialized !== cp1.serialized, 'explicit createdAtUtc input changes identity (no hidden clock)');
check(cp1Later.checkpointId !== cp1.checkpointId, 'createdAtUtc flows into digest/id deterministically');

// ── digest + id formulas ───────────────────────────────────────────────────
section('DIGEST AND ID FORMULAS');
const payloadBytes = checkpoint.serializeCheckpointCanonical(
  (function strip(cp) { const c = clone(cp); delete c.checkpointId; delete c.checkpointContentDigest; return c; })(cp1.checkpoint));
check(checkpoint.deriveCheckpointContentDigest(
  (function strip(cp) { const c = clone(cp); delete c.checkpointId; delete c.checkpointContentDigest; return c; })(cp1.checkpoint)) === cp1.contentDigest, 'digest recomputes from canonical payload bytes');
check(checkpoint.sha256HexUtf8(payloadBytes) === cp1.contentDigest, 'digest equals sha256 of canonical payload bytes');
const idRecomputed = checkpoint.deriveCheckpointIdV2('TASK-A03', 'task_a03_0001', 'sess-a03', 1, cp1.contentDigest);
check(idRecomputed === cp1.checkpointId, 'checkpointId recomputes from binding + digest');
check(checkpoint.deriveCheckpointIdV2('TASK-A03', 'task_a03_0001', 'sess-a03', 2, cp1.contentDigest) !== cp1.checkpointId, 'generation discriminates checkpointId');
throwsWith(() => checkpoint.deriveCheckpointIdV2('T', 'TI', 'S', 1, 'not-hex'), 'contentDigest must be sha256 hex', 'id derivation refuses non-digest input');
throwsWith(() => checkpoint.deriveCheckpointIdV2('T', 'TI', 'S', 0, 'a'.repeat(64)), 'positive integer', 'id derivation refuses generation 0');
check(!cp1.checkpointId.startsWith('ccop_'), 'checkpoint ids never collide with operation ids');

// ── multi-generation fixture CP1 -> CP2 -> CP3 ─────────────────────────────
section('MULTI-GENERATION LINEAGE');
const built2 = checkpoint.buildCheckpointV2(baseInput({
  generation: 2, createdAtUtc: CREATED_2,
  parentCheckpoint: cp1.checkpoint,
  requirements: [
    { id: 'R-active', text: 'Requirements must survive recency.', status: 'active', evidenceRefs: [] },
    { id: 'R-done', text: 'Freeze the operation foundation.', status: 'satisfied', evidenceRefs: ['cmd:prove-a02'] },
    { id: 'R-new', text: 'Cover the builder with tests.', status: 'active', evidenceRefs: [] },
  ],
  progress: { taskStatus: 'in-progress', completedMilestones: ['A02 frozen', 'A03 schema'], currentMilestone: 'A03 tests', remainingMilestones: ['A04 seal'] },
  continuation: { nextAction: 'Prove tamper rejection.', unresolvedQuestions: ['Seal formula?'], recentUserIntent: 'Land A03.' },
}));
const built3 = checkpoint.buildCheckpointV2(baseInput({
  generation: 3, createdAtUtc: CREATED_3,
  parentCheckpoint: built2.checkpoint,
  requirements: [
    { id: 'R-active', text: 'Requirements must survive recency.', status: 'active', evidenceRefs: [] },
    { id: 'R-done', text: 'Freeze the operation foundation.', status: 'satisfied', evidenceRefs: ['cmd:prove-a02'] },
    { id: 'R-new', text: 'Cover the builder with tests.', status: 'satisfied', evidenceRefs: ['run:a03-tests'] },
  ],
  verification: { outcomes: [{ scope: 'unit', status: 'PASS', detail: null }] },
  continuation: { nextAction: null, unresolvedQuestions: [], recentUserIntent: 'Land A03.' },
}));
check(built2.checkpoint.generation === 2 && built3.checkpoint.generation === 3, 'generations 1/2/3 assigned');
check(new Set([cp1.checkpointId, built2.checkpointId, built3.checkpointId]).size === 3, 'unique checkpoint IDs per generation');
check(built2.checkpoint.parentCheckpointId === cp1.checkpointId, 'CP2 parent = CP1 id');
check(built3.checkpoint.parentCheckpointId === built2.checkpointId, 'CP3 parent = CP2 id');
check(checkpoint.validateCheckpointV2(built2.checkpoint).valid === true, 'CP2 validates');
check(checkpoint.validateCheckpointV2(built3.checkpoint).valid === true, 'CP3 validates');
const rebuilt2 = checkpoint.buildCheckpointV2(baseInput({ generation: 2, parentCheckpoint: cp1.checkpoint, createdAtUtc: CREATED_2 }));
check(rebuilt2.checkpoint.parentCheckpointId === cp1.checkpointId, 'gen2 with unchanged body still binds CP1 parent');
check(rebuilt2.checkpointId !== cp1.checkpointId, 'gen2 with unchanged body still yields a unique id (generation-bound)');
section('SELF-CONTAINED CP3');
function selfContained(cp) {
  return cp.schemaVersion === 2 && typeof cp.objective.text === 'string' && cp.objective.text !== ''
    && Array.isArray(cp.requirements) && cp.requirements.length > 0
    && Array.isArray(cp.constraints) && typeof cp.progress.taskStatus === 'string'
    && Array.isArray(cp.decisions) && cp.repository !== null && typeof cp.repository === 'object'
    && Array.isArray(cp.verification.outcomes) && typeof cp.continuation === 'object'
    && Array.isArray(cp.continuation.unresolvedQuestions) && cp.snapshot && cp.snapshot.snapshotTokenId === null;
}
check(selfContained(built3.checkpoint), 'CP3 interpretable without CP1/CP2 payloads (all mandatory sections present)');
check(built3.checkpoint.requirements.some((r) => r.id === 'R-active' && r.status === 'active'), 'CP3 retains the CP1 active requirement verbatim');
check(built3.checkpoint.snapshot.snapshotTokenId === null && built3.checkpoint.snapshot.revisionDigest === null, 'A03 snapshot uses documented temporary null/null semantics');

// ── persistence: generation isolation, atomic, read-back ───────────────────
section('PERSISTENCE');
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2ckpt-'));
const persisted1 = checkpoint.persistCheckpointV2(storeDir, cp1);
check(persisted1.checkpoint.checkpointId === cp1.checkpointId, 'persisted CP1 reads back with identical id');
check(persisted1.serialized === cp1.serialized, 'persisted CP1 bytes identical to build bytes');
check(fs.existsSync(path.join(storeDir, 'cp-000001.json')), 'V2 file layout uses cp-000001.json');
check(checkpoint.persistCheckpointV2(storeDir, cp1).checkpoint.checkpointId === cp1.checkpointId, 'idempotent rewrite of identical bytes allowed');
const persisted2 = checkpoint.persistCheckpointV2(storeDir, built2);
check(persisted2.checkpoint.generation === 2, 'CP2 persists alongside CP1 (generation isolation)');
let overwriteBlocked = null;
try {
  const altered = clone(built2); altered.serialized = altered.serialized.replace('A03 tests', 'A03 MUNGED');
  checkpoint.persistCheckpointV2(storeDir, altered);
} catch (e) { overwriteBlocked = e; }
check(overwriteBlocked !== null, 'overwrite of a generation with different bytes is refused');
check(checkpoint.readCheckpointV2(storeDir, 999) === null, 'absent generation reads as null (no fabrication)');
const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2ckpt-evil-'));
fs.mkdirSync(evilDir, { recursive: true });
fs.writeFileSync(path.join(evilDir, 'cp-000001.json'), persisted2.serialized, 'utf8');
let isolationError = null;
try { checkpoint.readCheckpointV2(evilDir, 1); } catch (e) { isolationError = e; }
check(isolationError !== null && String(isolationError.message).includes('generation isolation'), 'generation misfile is refused on read-back');

// ── validator reason-code matrix ───────────────────────────────────────────
section('VALIDATOR REASON CODES');
function reasonOf(mutator) {
  const c = clone(cp1.checkpoint);
  mutator(c);
  return checkpoint.validateCheckpointV2(c).reason;
}
check(reasonOf((c) => { c.schemaVersion = 1; }) === 'checkpoint-schema-version', 'wrong schemaVersion rejected');
check(reasonOf((c) => { delete c.objective; }) === 'checkpoint-objective-missing', 'missing objective rejected');
check(reasonOf((c) => { c.generation = 0; }) === 'checkpoint-generation-invalid', 'invalid generation rejected');
check(reasonOf((c) => { c.parentCheckpointId = 'ccp_deadbeef'; }) === 'checkpoint-parent-invalid', 'gen1 with parent rejected');
check(reasonOf((c) => { c.requirements = [{ id: 'R', text: 't' }]; }) === 'checkpoint-requirements-invalid', 'requirement missing fields rejected');
check(reasonOf((c) => { c.constraints = [{ type: 'branch' }]; }) === 'checkpoint-constraints-invalid', 'invalid constraint rejected');
check(reasonOf((c) => { c.verification = { outcomes: [{ scope: 'unit', status: 'PARTIAL-PASS' }] }; }) === 'checkpoint-verification-invalid', 'non-conservative verification rejected');
check(reasonOf((c) => { c.repository = null; }) === 'checkpoint-repository-invalid', 'invalid repository rejected');
check(reasonOf((c) => { c.snapshot = { snapshotTokenId: 'tok', revisionDigest: null }; }) === 'checkpoint-snapshot-invalid', 'non-null snapshot token rejected (pre-A05)');
// A05H H1: unknown top-level keys fail closed at the schema leg (before the
// forbidden-content leg). Forbidden bulk keys are therefore refused as
// unknown schema fields; the forbidden-content leg still guards smuggled
// secret VALUES (see REDACTION AND SECURITY below).
check(reasonOf((c) => { c.shellLog = 'huge'; }) === 'checkpoint-schema-version', 'unknown top-level key rejected closed-world');
check(reasonOf((c) => { c.checkpointContentDigest = '0'.repeat(64); }) === 'checkpoint-content-digest-mismatch', 'digest tamper rejected');
check(reasonOf((c) => { c.checkpointId = 'ccp_' + '0'.repeat(32); }) === 'checkpoint-id-mismatch', 'checkpointId tamper rejected');

// ── requirements / constraints / verification conservatism ─────────────────
section('RETENTION AND CONSERVATISM');
check(built2.checkpoint.requirements.length === 3, 'no requirement silently dropped between generations');
check(built2.checkpoint.requirements[0].text === 'Requirements must survive recency.', 'requirement text semantically complete');
throwsWith(() => checkpoint.buildCheckpointV2(baseInput({ requirements: [{ id: 'R', text: 't', status: 'unknown', evidenceRefs: [] }] })), 'candidate rejected (checkpoint-requirements-invalid)', 'unknown requirement status is not upgraded to satisfied');
check(built2.checkpoint.constraints.length === 1 && built2.checkpoint.constraints[0].type === 'branch', 'active constraints retained structurally');
throwsWith(() => checkpoint.buildCheckpointV2(baseInput({ constraints: 'stay loose (prose)' })), 'constraints must be an array (never inferred from prose)', 'constraints are never inferred from agent prose');
check(cp1.checkpoint.verification.outcomes[0].status === 'PENDING', 'PENDING verification stays PENDING (never upgraded to PASS)');
check(built2.checkpoint.continuation.unresolvedQuestions.includes('Seal formula?'), 'unresolved question survives until resolved');
check(built3.checkpoint.continuation.unresolvedQuestions.length === 0, 'resolved questions may clear in a later generation');

// ── redaction + security ───────────────────────────────────────────────────
section('REDACTION AND SECURITY');
const secretInput = baseInput({
  objective: { text: 'Rotate Bearer abcdefghijklmnop now', status: 'in-progress' },
  continuation: { nextAction: 'Call with password=hunter2-secret', unresolvedQuestions: [], recentUserIntent: 'Authorization: Bearer zzzzzzzzzzzzzzzz' },
  requirements: [{ id: 'R-s', text: 'Key sk-abcdefghijklmnop1234 must rotate; see {"apiKey": "supersecretvalue"}', status: 'active', evidenceRefs: [] }],
  decisions: [{ id: 'D-s', statement: 'Token ghp_abcdefghijklmnopqrstuv rotates Monday', authority: 'agent-proposed', status: 'active', evidenceRefs: [] }],
});
const secretBuilt = checkpoint.buildCheckpointV2(secretInput);
const secretBytes = secretBuilt.serialized;
for (const raw of ['abcdefghijklmnop', 'hunter2-secret', 'supersecretvalue', 'zzzzzzzzzzzzzzzz']) {
  check(!secretBytes.includes(raw), 'raw secret never persisted (' + raw.slice(0, 8) + '…)');
}
check(secretBytes.includes('<redacted>'), 'stable <redacted> marker emitted');
check(checkpoint.redactCheckpointTextV2('key = sk-abcdefghijklmnop1234') === 'key = <redacted>', 'API-key shape redacted deterministically');
check(checkpoint.redactCheckpointTextV2('Authorization: Bearer token1234567890') === 'Authorization: Bearer <redacted>', 'authorization header redacted (Bearer prefix retained, secret removed)');
check(checkpoint.redactCheckpointTextV2('Bearer abcdefghijklmnop') === 'Bearer <redacted>', 'Bearer token redacted');
check(checkpoint.redactCheckpointTextV2('{"password": "hunter2"}') === '{"password": "<redacted>"}', 'sensitive JSON property redacted');
check(checkpoint.redactCheckpointTextV2('password=hunter2') === 'password=<redacted>', 'password field redacted');
const pemBuilt = checkpoint.buildCheckpointV2(baseInput({ continuation: { nextAction: 'none', unresolvedQuestions: [], recentUserIntent: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----' } }));
check(!pemBuilt.serialized.includes('BEGIN PRIVATE KEY') || pemBuilt.serialized.includes('<redacted>'), 'PEM block redacted');
throwsWith(() => checkpoint.buildCheckpointV2(baseInput({ evidenceRefs: [{ evidenceId: 'E1', kind: 'tweet', locator: '/x', observedAtUtc: CREATED_1, taskInstanceId: 'task_a03_0001' }] })), 'candidate rejected (checkpoint-evidence-invalid)', 'malformed evidence ref rejected');
throwsWith(() => checkpoint.buildCheckpointV2(baseInput({ repository: { headCommit: 'abc', changedFiles: ['a.txt'], changedFileCount: 0 } })), 'must cover every listed file', 'malformed repository identity rejected (count < listed)');
throwsWith(() => checkpoint.buildCheckpointV2(baseInput({ requirements: Array.from({ length: 101 }, (_, i) => ({ id: 'R' + i, text: 't', status: 'active', evidenceRefs: [] })) })), 'candidate rejected (checkpoint-requirements-invalid)', 'very large requirement set rejected (bounded, never silently dropped)');

// ── repository truncation metadata ─────────────────────────────────────────
section('REPOSITORY TRUNCATION');
const manyFiles = Array.from({ length: 150 }, (_, i) => 'src/file-' + i + '.ts');
const truncBuilt = checkpoint.buildCheckpointV2(baseInput({
  repository: { headCommit: 'abc123', changedFiles: manyFiles, changedFileCount: 150 },
}));
check(truncBuilt.checkpoint.repository.changedFiles.length === 100, 'changed files bounded inline at 100');
check(truncBuilt.checkpoint.repository.changedFilesTruncated === true, 'truncation explicitly marked');
check(truncBuilt.checkpoint.repository.changedFileCount === 150, 'total count preserved alongside truncation');
check(checkpoint.validateCheckpointV2(truncBuilt.checkpoint).valid === true, 'bounded repository state validates');

// ── size bound: 64 KiB measured in UTF-8 bytes ─────────────────────────────
section('SIZE BOUND');
check(cp1.sizeBytes <= 65536, 'happy-path checkpoint within 64 KiB (' + cp1.sizeBytes + ' bytes)');
check(cp1.sizeBytes === Buffer.byteLength(cp1.serialized, 'utf8'), 'size measured in UTF-8 bytes, not string length');
check(checkpoint.byteLengthUtf8('🎯') === 4 && '🎯'.length === 2, 'UTF-8 byte accounting differs from JS string length (multibyte proof)');
const emojiBuilt = checkpoint.buildCheckpointV2(baseInput({ objective: { text: '🎯'.repeat(500), status: 'in-progress' } }));
check(emojiBuilt.sizeBytes === Buffer.byteLength(emojiBuilt.serialized, 'utf8'), 'multibyte checkpoint sized in bytes (' + emojiBuilt.sizeBytes + ')');
const hugeRequirements = Array.from({ length: 100 }, (_, i) => ({ id: 'R' + i, text: 'x'.repeat(1000), status: 'active', evidenceRefs: [] }));
let oversizeError = null;
try { checkpoint.buildCheckpointV2(baseInput({ requirements: hugeRequirements })); } catch (e) { oversizeError = e; }
check(oversizeError !== null && String(oversizeError.message).includes('checkpoint-size-limit'), 'oversized mandatory state fails closed (' + (oversizeError ? String(oversizeError.message).slice(0, 100) : 'no error') + ')');

// ── A02 operation binding to real checkpoint identity ──────────────────────
section('A02 OPERATION BINDING');
const TASKB = { taskId: 'TASK-A03', taskInstanceId: 'task_a03_0001', sessionId: 'sess-a03', workspace: '/tmp/nexus-a03' };
function freezeForCounty(built, dir) {
  const opId = compaction.deriveCanonicalOperationIdV2(TASKB.taskId, TASKB.taskInstanceId, TASKB.sessionId, built.checkpoint.generation, built.checkpointId);
  const draft = {
    schemaVersion: 2, operationId: opId, attemptId: 'attempt-a03-' + built.checkpoint.generation,
    taskId: TASKB.taskId, taskInstanceId: TASKB.taskInstanceId, sessionId: TASKB.sessionId,
    checkpointId: built.checkpointId, checkpointGeneration: built.checkpoint.generation,
    checkpointContentDigest: built.contentDigest, snapshotTokenId: null, safePointBoundarySeq: 9,
    sourceEventSeqs: [0, 1, 3],
    segments: [
      { start: 0, end: 1, sourceEventSeqs: [0, 1], role: 'payload' },
      { start: 3, end: 3, sourceEventSeqs: [3], role: 'continuation' },
    ],
    lifecycle: 'frozen', workspace: TASKB.workspace, repositoryId: null, checkoutId: null,
  };
  const expected = { taskId: TASKB.taskId, taskInstanceId: TASKB.taskInstanceId, sessionId: TASKB.sessionId, workspace: TASKB.workspace, checkpointGeneration: built.checkpoint.generation, checkpointId: built.checkpointId };
  return { frozen: compaction.freezeCompactionOperationV2(dir, draft, expected), draft };
}
const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2opbind-'));
const { frozen: frozenOp } = freezeForCounty(cp1, opDir);
check(frozenOp.checkpointId === cp1.checkpointId, 'frozen A02 operation binds the real checkpoint id');
check(frozenOp.checkpointGeneration === 1, 'frozen A02 operation binds the real generation');
check(frozenOp.checkpointContentDigest === cp1.contentDigest, 'frozen A02 operation binds the real content digest');
const bindOk = checkpoint.assertOperationBindsCheckpointV2(frozenOp, cp1.checkpoint, cp1.serialized);
check(bindOk.ok === true, 'operation identity == projected checkpoint bytes before mutation');
const bindDigest = checkpoint.assertOperationBindsCheckpointV2(
  Object.assign({}, frozenOp, { checkpointContentDigest: '0'.repeat(64) }), cp1.checkpoint, cp1.serialized);
check(bindDigest.ok === false && bindDigest.reason === 'checkpoint-digest-mismatch', 'digest mismatch BLOCKS mutation');
const bindId = checkpoint.assertOperationBindsCheckpointV2(
  Object.assign({}, frozenOp, { checkpointId: 'ccp_' + '0'.repeat(32) }), cp1.checkpoint, cp1.serialized);
check(bindId.ok === false && bindId.reason === 'checkpoint-identity-mismatch', 'checkpointId mismatch BLOCKS mutation');
const bindGen = checkpoint.assertOperationBindsCheckpointV2(
  Object.assign({}, frozenOp, { checkpointGeneration: 2 }), cp1.checkpoint, cp1.serialized);
check(bindGen.ok === false && bindGen.reason === 'checkpoint-generation-mismatch', 'generation mismatch BLOCKS mutation');
const bindPayload = checkpoint.assertOperationBindsCheckpointV2(frozenOp, cp1.checkpoint, cp1.serialized + ' ');
check(bindPayload.ok === false && bindPayload.reason === 'checkpoint-digest-mismatch', 'mutated payload bytes BLOCK mutation');
const staleExpected = { taskId: TASKB.taskId, taskInstanceId: TASKB.taskInstanceId, sessionId: TASKB.sessionId, workspace: TASKB.workspace, checkpointGeneration: 1, checkpointId: 'ccp_' + 'f'.repeat(32) };
check(compaction.validateCompactionOperationV2(frozenOp, staleExpected).valid === false, 'A02 closed-world validation refuses a stale checkpoint binding');

// ── JS / PowerShell parity ─────────────────────────────────────────────────
section('JS/POWERSHELL PARITY');
function psInvoke(lines, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2ps-'));
  const script = path.join(dir, 'probe.ps1');
  const probe = 'param([string]$A,[string]$B,[string]$C,[int]$G,[string]$D)\n'
    + ". '" + path.join(repoRoot, 'scripts', 'Common.ps1') + "'; . '" + path.join(repoRoot, 'scripts', 'TaskController.ps1') + "'; . '" + path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1') + "';\n" + lines + '\n';
  fs.writeFileSync(script, probe, 'utf8');
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...(args || [])], { encoding: 'utf8', timeout: 120000 }).trim();
}
const digestCases = ['hello checkpoint', '🎯-unicode-✓', cp1.serialized.slice(0, 2000)];
for (const text of digestCases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2psd-'));
  const script = path.join(dir, 'd.ps1');
  fs.writeFileSync(script, ". '" + path.join(repoRoot, 'scripts', 'Common.ps1') + "'; . '" + path.join(repoRoot, 'scripts', 'TaskController.ps1') + "'; . '" + path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1') + "'; Get-AihContextCheckpointDigestV2 -Text ([IO.File]::ReadAllText($args[0]))", 'utf8');
  const input = path.join(dir, 'in.txt');
  fs.writeFileSync(input, text, 'utf8');
  const ps = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, input], { encoding: 'utf8', timeout: 120000 }).trim();
  check(checkpoint.sha256HexUtf8(text) === ps, 'digest parity (' + text.slice(0, 24).replace(/\n/g, '?') + '…)');
}
const idCases = [
  ['TASK-A03', 'task_a03_0001', 'sess-a03', 1, cp1.contentDigest],
  ['TASK-A03', 'task_a03_0001', 'sess-a03', 2, built2.contentDigest],
  ['Tâsk-✓-🎯', 'inst/ané/✓', 'sess/✓/🎯', 3, built3.contentDigest],
];
for (const c of idCases) {
  const js = checkpoint.deriveCheckpointIdV2(c[0], c[1], c[2], c[3], c[4]);
  const ps = psInvoke('New-AihContextCheckpointIdV2 -TaskId $A -TaskInstanceId $B -SessionId $C -Generation $G -ContentDigest $D', c);
  check(js === ps, 'checkpointId parity gen=' + c[3], 'js=' + js + ' ps=' + ps);
}

// ── V1 coexistence ─────────────────────────────────────────────────────────
section('V1 COEXISTENCE');
check(compaction.OPERATION_ID_DOMAIN_V2 !== compaction.OPERATION_ID_DOMAIN, 'V1 and V2 operation domains remain separated');
check(compaction.OPERATION_ID_DOMAIN === 'nexus/context-compaction-operation/v1', 'V1 operation domain unchanged');
check(typeof compaction.deriveCanonicalOperationId === 'function', 'V1 derivation helper unchanged');
check(checkpoint.checkpointV2FileName(1) === 'cp-000001.json', 'V2 layout uses cp-000001.json');
check(checkpoint.checkpointV2FileName(1) !== 'context-checkpoint.json', 'V2 files never collide with the V1 checkpoint file');
const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2v1-'));
fs.writeFileSync(path.join(v1Dir, 'cp-000001.json'), JSON.stringify({ schemaVersion: 1, taskId: 'T' }), 'utf8');
let v1Refused = null;
try { checkpoint.readCheckpointV2(v1Dir, 1); } catch (e) { v1Refused = e; }
check(v1Refused !== null && String(v1Refused.message).includes('checkpoint-schema-version'), 'V1-shaped payload is never reinterpreted as V2');

console.log('\nA03 checkpoint suite: ' + passed + ' passed, ' + failed + ' failed.');
if (failed > 0) process.exit(1);
