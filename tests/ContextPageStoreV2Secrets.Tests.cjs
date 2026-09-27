'use strict';
/**
 * ContextPageStoreV2Secrets.Tests.cjs - CCV2-B02H H2 secret-safety proof.
 *
 * Freezes the Buffer classification boundary against the REAL production
 * authority: raw arbitrary Buffers (textual or binary) FAIL CLOSED at
 * putBlobV2 instead of silently bypassing persistent redaction; text travels
 * the frozen A03 pipeline as string or branded text; opaque bytes travel
 * ONLY as branded binary with explicit artifact provenance. Proves the H2.5
 * large-evidence outcomes (large normal logs redact fast; long unbroken
 * secret-bearing runs fail closed fast) and the H2.6 binary semantics
 * (byte-exact, digest-bound, descriptor-clean, never controller text).
 * All secret fixtures below are obviously-fake test values.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const checkpoint = require(path.join(repoRoot, 'config', 'ContextCheckpointV2.cjs'));

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
  check(error !== null && String(error && error.message).includes(fragment), name,
    error ? String(error.message).slice(0, 240) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const SECRET_A = 'hunter2-test-secret-AA';
const SECRET_B = 'sk-test-AAAAAAAAbbbbbbbbcccccccc';
const SECRET_C = 'bearer-test-token-CC';

const NS = Object.freeze({
  taskId: 'TASK-B02H-S',
  taskInstanceId: 'task_b02h_s_0001',
  sessionId: 'sess-b02h-s',
  workspaceId: '/tmp/nexus-b02h-s',
  repositoryId: 'repo-b02h',
  checkoutId: 'checkout-b02h',
});

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b02h-sec-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return store.contextRootForV2(dir, 'TASK-B02H-S');
}

function storeText(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.isFile() && !e.name.includes('.tmp-')) out.push(fs.readFileSync(f));
    }
  };
  walk(root);
  return Buffer.concat(out).toString('utf8');
}

// ── H2.2 ARBITRARY TEXTUAL BUFFER ──────────────────────────────────────
section('ARBITRARY TEXTUAL BUFFER CANNOT BYPASS REDACTION');
{
  const root = makeRoot('bypass');
  fs.mkdirSync(root, { recursive: true });
  throwsWith(() => store.putBlobV2(root, Buffer.from('Authorization: Bearer ' + SECRET_C, 'utf8')),
    'v2-context-store: context-blob-attestation-required', 'credential-shaped Buffer fails closed');
  throwsWith(() => store.persistEvidenceV2(root, {
    expectedNamespace: clone(NS),
    blobBytes: Buffer.from('password=' + SECRET_A, 'utf8'),
    pageInput: {
      kind: 'other', namespace: clone(NS), sourceKind: 'agent', sourceRefs: ['agent:note:81'],
      mutability: 'immutable', sourceSeqs: [], createdAtGeneration: 1,
    },
  }), 'v2-context-store: context-blob-attestation-required', 'orchestrated raw Buffer fails closed');
  check(!storeText(root).includes(SECRET_C) && !storeText(root).includes(SECRET_A),
    'no raw secret from rejected Buffers persists anywhere in the store');
}

// ── H2.3 PROOF BOUNDARY ────────────────────────────────────────────────
section('SANITIZED-BYTE PROOF BOUNDARY');
{
  const root = makeRoot('brand');
  fs.mkdirSync(root, { recursive: true });
  // A user-controlled boolean (or any fabricated literal) is not authority.
  throwsWith(() => store.putBlobV2(root, { alreadyRedacted: true, bytes: Buffer.from('x') }),
    'v2-context-store: ', 'boolean-claimed bytes are rejected');
  throwsWith(() => store.putBlobV2(root, { kind: 'text', bytes: Buffer.from('x') }),
    'v2-context-store: ', 'unbranded shape is rejected');
  throwsWith(() => store.createPersistableExactBytesV2({ text: 'a', binary: Buffer.from('b') }),
    'v2-context-store: context-blob-invalid', 'factory requires exactly one source shape');
  throwsWith(() => store.createPersistableExactBytesV2({ binary: Buffer.from([1]) }),
    'v2-context-store: context-blob-provenance-invalid', 'binary without artifactId is rejected');
  throwsWith(() => store.createPersistableExactBytesV2({ binary: Buffer.from([1]), artifactId: 'k password=' + SECRET_A }),
    'v2-context-store: context-blob-provenance-invalid', 'secret-bearing artifactId is rejected');
  // Branded text equals the string route byte-for-byte (one pipeline, one digest).
  const text = 'deploy log with password=' + SECRET_A + ' inside';
  const viaString = store.putBlobV2(root, text);
  const root2 = makeRoot('brand2');
  fs.mkdirSync(root2, { recursive: true });
  const viaBrand = store.putBlobV2(root2, store.createPersistableExactBytesV2({ text }));
  check(viaString.blobRef === viaBrand.blobRef, 'branded text and string routes share one digest');
  check(viaBrand.kind === 'text', 'branded text reports its kind');
  check(!store.readBlobV2(root, viaString.blobRef).toString('utf8').includes(SECRET_A),
    'branded text route redacts before derived storage');
}

// ── H2.5 LARGE TEXT EVIDENCE ───────────────────────────────────────────
section('LARGE TEXT EVIDENCE STAYS SECRET-SAFE');
{
  const root = makeRoot('large');
  fs.mkdirSync(root, { recursive: true });
  const line = (i) => '[test] shard=' + i + ' PASS user token=' + SECRET_A + ' key=' + SECRET_B + ' ok\n';
  let big = '';
  for (let i = 0; i < 20000; i += 1) big += line(i);
  check(Buffer.byteLength(big, 'utf8') > 1024 * 1024, 'large test log exceeds 1 MiB');
  const start = Date.now();
  const put = store.putBlobV2(root, big);
  const elapsed = Date.now() - start;
  check(elapsed < 30000, 'large secret-bearing log persists in the interactive regime (' + elapsed + 'ms)');
  const dumped = storeText(root);
  check(!dumped.includes(SECRET_A) && !dumped.includes(SECRET_B), 'large log persists with no secret');
  check(dumped.includes('<redacted>'), 'large log carries stable redaction markers');
  check(put.kind === 'text', 'large log travels the redacted text route, never an unchecked bytes route');
  // Long unbroken secret-bearing run: safe outcome is fast fail-closed.
  const runStart = Date.now();
  throwsWith(() => store.putBlobV2(root, 'X'.repeat(5000) + 'password=' + SECRET_A + 'Y'.repeat(5000)),
    'v2-context-store: context-blob-run-too-long', 'long unbroken secret-bearing run fails closed');
  check(Date.now() - runStart < 15000, 'long-run refusal is fast');
  check(!storeText(root).includes(SECRET_A), 'refused long run persists nothing');
}

// ── H2.6 BINARY SEMANTICS ──────────────────────────────────────────────
section('BINARY EVIDENCE SEMANTICS');
{
  const root = makeRoot('binary');
  fs.mkdirSync(root, { recursive: true });
  // Opaque bytes with explicit provenance persist byte-exact and bind pages.
  const opaque = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x42]);
  const branded = store.createPersistableExactBytesV2({
    binary: opaque, artifactId: 'tool-output:render-3', note: 'opaque renderer bytes',
  });
  const put = store.putBlobV2(root, branded);
  check(put.blobRef === 'blob:sha256:' + sha256(opaque), 'binary digest binds exact opaque bytes');
  check(store.readBlobV2(root, put.blobRef).equals(opaque), 'binary round-trips byte-exact');
  const p = page.createContextPageV2({
    kind: 'tool-result', namespace: clone(NS), sourceKind: 'tool',
    sourceRefs: ['tool-event:call-83', 'tool-event:result-84'],
    mutability: 'immutable', sourceSeqs: [83, 84],
    exactBlobRef: put.blobRef,
    sourceBinding: { kind: 'artifact', artifactId: 'tool-output:render-3', contentDigest: put.digest },
    createdAtGeneration: 1,
  });
  store.putContextPageV2(root, p, { expectedNamespace: clone(NS) });
  const reread = store.readContextPageV2(root, p.id, { expectedNamespace: clone(NS) });
  check(reread.exactBlobRef === put.blobRef, 'binary evidence binds page identity like text evidence');
  // Binary carrying secret-shaped bytes stores them raw BY DOCUMENTED DESIGN:
  // opaque bytes get no text redaction and must never become controller text.
  const sneaky = Buffer.from('Authorization: Bearer ' + SECRET_C, 'utf8');
  const sneakyPut = store.putBlobV2(root, store.createPersistableExactBytesV2({
    binary: sneaky, artifactId: 'tool-output:bytes-9',
  }));
  check(store.readBlobV2(root, sneakyPut.blobRef).toString('utf8').includes(SECRET_C),
    'opaque binary is byte-exact by explicit contract (documented, never for controller text)');
  check(sneakyPut.kind === 'binary', 'opaque route is labeled binary in bounded telemetry');
}

// ── H2.4 NO DUPLICATE SECRET POLICY ────────────────────────────────────
section('A03 REMAINS THE REDACTION AUTHORITY');
{
  const source = fs.readFileSync(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'), 'utf8');
  for (const token of ['Bearer', 'PRIVATE KEY', 'passwd', 'apikey', 'client_secret', 'xox']) {
    check(!source.includes(token), 'store carries no independent secret pattern (' + token + ')');
  }
  check(source.includes('redactCheckpointTextV2'), 'store reuses the frozen A03 pipeline verbatim');
  const redacted = checkpoint.redactCheckpointTextV2('password=' + SECRET_A, 1024);
  check(!redacted.includes(SECRET_A), 'A03 pipeline is the authority that removes the secret');
}

console.log('\nB02H secrets suites: ' + passed + ' passed, ' + failed + ' failed');
