'use strict';
/**
 * ContextPageStoreV2.cjs - CCV2-B02 content-addressed evidence store.
 *
 * ONE authority for durable Phase-B ContextPage + exact-blob persistence.
 * B02 answers "how is validated B01 exact evidence stored durably, addressed,
 * integrity-verified, and reconstructed after restart" and NOTHING else:
 *
 *   exact evidence bytes  ->  content-addressed immutable blob
 *   validated ContextPage ->  durable namespaced page record
 *   Phase-A EvidenceRef   ->  durable deterministic page/blob binding
 *
 * Normative architecture: docs/architecture/context-compaction-v2.md
 * (section 25, B02 freeze record). B01 (config/ContextPageV2.cjs) is frozen
 * and consumed verbatim: storage validates pages, never repairs them, and
 * never changes the pageId formula.
 *
 * Core invariant: CCv2 may forget from the prompt; CCv2 must never forget
 * from the task. No caller receives a durable reference before read-back
 * proof. Corruption anywhere FAILS CLOSED.
 *
 * Frozen identities:
 *
 *   blobRef          = 'blob:sha256:' + sha256Hex(persisted exact bytes)
 *   page storage key = pageId ('cxp_' + 32 hex, frozen B01 formula)
 *   pageRecordDigest = sha256Hex(canonical JSON of the full page record)
 *   evidenceBindingId = 'ev_' + sha256Hex(domain LF taskInstanceId LF
 *                        evidenceId).slice(0, 32)
 *
 * Frozen layout (under one authoritative context root):
 *
 *   <contextRoot>/blobs/<aa>/<digest>.blob
 *   <contextRoot>/pages/<aa>/<pageId>.json
 *   <contextRoot>/advisory/<aa>/<pageId>.<advisoryDigest>.json
 *   <contextRoot>/evidence/<aa>/<bindingId>.json
 *
 * where <contextRoot> = <workspace>/.ai-harness/runs/<taskId>/context
 * (see contextRootForV2) and <aa> is a hash shard (first hex pair).
 *
 * Blob deduplication is content-driven and namespace-independent WITHIN one
 * store domain: identical bytes converge on one blob file. Page ownership is
 * namespace-bound: identical bytes in different namespaces yield distinct
 * page records, and reads REQUIRE an explicit expected namespace. Separate
 * task run roots hold separate blob copies (isolation dominates
 * cross-filesystem sharing).
 *
 * Advisory metadata model (frozen): the core page record is immutable. An
 * advisory update (semanticGloss/tags/entities/lastNeededAtGeneration)
 * NEVER overwrites the historical record; it is persisted as a separate
 * derived advisory record bound to (pageId, contentHash). The core record
 * has no mutable history.
 *
 * Durability scope (A05H wording preserved): atomic file writes (exclusive
 * claim + read-back validation) are process-crash recoverable under the
 * filesystem/OS contract. NOT claimed power-loss durable (no fsync). Temp
 * files ('*.tmp-<pid>-*') are never authoritative: readers only open exact
 * deterministic filenames, so a crash leaves absent-or-valid state only.
 *
 *   NOT implemented here (out of scope, FAILS CLOSED if attempted): lexical
 *   / symbol / file search, relevance ordering, numeric closeness indexes,
 *   ContextView, Context Compiler, budget packing, memory-tier policy,
 *   JEV/Laya/DECIDE, exact-rehydration resolution (B03), garbage collection.
 *   This module answers only known-ID integrity: known pageId, known
 *   evidence binding, known blobRef.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const checkpointV2 = require('./ContextCheckpointV2.cjs');
const pageV2 = require('./ContextPageV2.cjs');

// ---- frozen constants ----
const STORE_SCHEMA_VERSION = 1;
const PAGE_RECORD_DOMAIN_V1 = 'nexus/context-page-record/v1';
const EVIDENCE_BINDING_DOMAIN_V1 = 'nexus/evidence-binding/v1';
const BLOB_REF_PREFIX = 'blob:sha256:';
const PAGE_ID_PATTERN = /^cxp_[0-9a-f]{32}$/;
const EVIDENCE_BINDING_ID_PATTERN = /^ev_[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
// Small exact evidence may stay inline in the page record; anything larger
// MUST travel the blob route. Explicit deterministic threshold (UTF-8 bytes).
const INLINE_EXACT_MAX_BYTES = 4096;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

const BLOB_DIRNAME = 'blobs';
const PAGE_DIRNAME = 'pages';
const ADVISORY_DIRNAME = 'advisory';
const EVIDENCE_DIRNAME = 'evidence';

// Closed-world advisory record keys. Only derived/advisory dimensions may
// appear here; identity dimensions (id, contentHash, namespace, provenance,
// sourceSeqs, sourceBinding, exact backing, kind, mutability, generation)
// can NEVER be versioned through this record.
const ADVISORY_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'pageId', 'contentHash', 'advisory', 'advisoryDigest',
]);
const ADVISORY_BODY_EXACT_KEYS = Object.freeze([
  'semanticGloss', 'entities', 'symbols', 'files', 'tags',
  'lastNeededAtGeneration',
]);

// Frozen blob string-route bounds. The reused A03 redaction pipeline scans
// each position with a greedy word prefix before its keyword alternation, so
// cost grows with the square of the longest continuous word run (measured:
// 4K chars ~23ms, 16K ~330ms, 65K ~4.7s). B01 is safe through its 8192-char
// exactText bound; the B02 string route therefore fails closed on inputs
// that would leave the interactive regime, while keeping whole-input
// verbatim pipeline semantics (a blob digest MUST equal the B01 contentHash
// of identical text). Oversized or long-run string evidence FAILS CLOSED
// (safe outcome, never silent bypass). Genuine opaque-binary evidence uses
// the branded binary factory, which stores bytes byte-exact under an
// explicit artifact descriptor and no secrecy guarantee; raw arbitrary
// Buffers are rejected at the boundary.
const BLOB_STRING_MAX_BYTES = 2 * 1024 * 1024;
const BLOB_MAX_WORD_RUN = 4096;

// Closed-world durable evidence-binding record keys. The Phase-A EvidenceRef
// itself is carried VERBATIM (never reinterpreted); the binding adds only
// the deterministic B02 join columns.
const EVIDENCE_RECORD_EXACT_KEYS = Object.freeze([
  'schemaVersion', 'evidenceBindingId', 'evidenceRef', 'pageId',
  'contentHash', 'exactBlobRef', 'namespace', 'bindingDigest',
]);

let tmpCounter = 0;

function failStore(reason, detail) {
  throw new Error('v2-context-store: ' + reason + (detail ? ' (' + detail + ')' : '') + ' (BLOCK/KEEP)');
}

function sha256HexBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256HexUtf8(text) {
  return checkpointV2.sha256HexUtf8(String(text));
}

function byteLengthUtf8(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function unknownKeyOf(value, allowedKeys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}

// ---- path safety (frozen) ----
// All derived paths stay under the authoritative context root. Filenames are
// derived ONLY from hex digests / frozen id patterns, never from page text,
// evidence text, or caller paths.
function assertSafeContextRoot(contextRoot) {
  if (typeof contextRoot !== 'string' || contextRoot === '') {
    failStore('context-store-root-invalid', 'contextRoot is required');
  }
  if (!path.isAbsolute(contextRoot)) failStore('context-store-root-invalid', 'contextRoot must be absolute');
  const normalized = path.normalize(contextRoot);
  if (normalized !== contextRoot) failStore('context-store-root-invalid', 'contextRoot must be normalized');
  const segments = normalized.split(path.sep);
  for (const segment of segments) {
    if (segment === '..') failStore('context-store-root-invalid', 'traversal rejected');
  }
  return normalized;
}

function assertSafeTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    failStore('context-store-task-invalid', 'taskId is not a safe run identity');
  }
  return taskId;
}

function joinUnder(root, ...parts) {
  const target = path.join(root, ...parts);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSep)) {
    failStore('context-store-path-escape', 'derived path escapes the store root');
  }
  if (target.includes('\0') || target !== path.normalize(target)) {
    failStore('context-store-path-invalid', 'derived path is not canonical');
  }
  return target;
}

function contextRootForV2(workspace, taskId) {
  if (typeof workspace !== 'string' || workspace === '' || !path.isAbsolute(workspace)) {
    failStore('context-store-workspace-invalid', 'workspace must be an absolute path');
  }
  assertSafeTaskId(taskId);
  return joinUnder(path.normalize(workspace), '.ai-harness', 'runs', taskId, 'context');
}

function blobFilePath(contextRoot, digest) {
  if (typeof digest !== 'string' || !HEX64_PATTERN.test(digest)) {
    failStore('context-blob-ref-invalid', 'digest must be lowercase sha256 hex');
  }
  return joinUnder(contextRoot, BLOB_DIRNAME, digest.slice(0, 2), digest + '.blob');
}

function blobPathForRef(contextRoot, blobRef) {
  if (typeof blobRef !== 'string' || !blobRef.startsWith(BLOB_REF_PREFIX)) {
    failStore('context-blob-ref-invalid', 'blobRef must be blob:sha256:<hex>');
  }
  return blobFilePath(contextRoot, blobRef.slice(BLOB_REF_PREFIX.length));
}

function pageFilePath(contextRoot, pageId) {
  if (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId)) {
    failStore('context-page-id-invalid', 'pageId must be cxp_ + 32 hex');
  }
  return joinUnder(contextRoot, PAGE_DIRNAME, pageId.slice(4, 6), pageId + '.json');
}

function advisoryFilePath(contextRoot, pageId, advisoryDigest) {
  if (typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId)) {
    failStore('context-page-id-invalid', 'pageId must be cxp_ + 32 hex');
  }
  if (typeof advisoryDigest !== 'string' || !HEX64_PATTERN.test(advisoryDigest)) {
    failStore('context-advisory-invalid', 'advisoryDigest must be sha256 hex');
  }
  return joinUnder(
    contextRoot, ADVISORY_DIRNAME, pageId.slice(4, 6), pageId + '.' + advisoryDigest + '.json',
  );
}

function evidenceFilePath(contextRoot, bindingId) {
  if (typeof bindingId !== 'string' || !EVIDENCE_BINDING_ID_PATTERN.test(bindingId)) {
    failStore('context-evidence-id-invalid', 'bindingId must be ev_ + 32 hex');
  }
  return joinUnder(contextRoot, EVIDENCE_DIRNAME, bindingId.slice(3, 5), bindingId + '.json');
}

// ---- atomic durable write (frozen protocol) ----
// Exclusive claim (hard link, same directory) so concurrent identical
// writers converge and concurrent conflicting writers FAIL CLOSED instead of
// last-writer-wins. Where hard links are unavailable (or the internal
// test seam forces it), the fallback claims with an exclusive create
// ('wx': atomic create-if-absent) and then read-back-verifies. No
// overwrite-capable rename is used as an authority claim anywhere in this
// module. Temp files are never authoritative.
//
// Test seam (internal, B02H): when the process environment carries
// NEXUS_B02_FORCE_FALLBACK_CLAIM=1, the hard-link attempt is skipped and the
// exclusive-create fallback is exercised deterministically. Production
// default behavior is unchanged, and no task/user content can select the
// strategy (the selector reads only process environment, never inputs).
function claimStrategyForTests() {
  return process.env.NEXUS_B02_FORCE_FALLBACK_CLAIM === '1' ? 'fallback' : 'auto';
}

function verifyExistingClaim(target, contentBytes, verifyAfterWrite) {
  let prior = null;
  try {
    prior = fs.readFileSync(target);
  } catch {
    failStore('context-store-missing', 'durable record vanished during claim');
  }
  if (prior.equals(contentBytes)) {
    if (typeof verifyAfterWrite === 'function') verifyAfterWrite(prior);
    return { disposition: 'existing-identical' };
  }
  // A rival-held file that fails integrity verification is crash debris
  // (e.g. a torn fallback-claim write), reported as corrupt; a rival-held
  // file that verifies but differs is a genuine identity conflict. Neither
  // is ever overwritten or adopted.
  if (typeof verifyAfterWrite === 'function') {
    try {
      verifyAfterWrite(prior);
    } catch {
      failStore('context-store-corrupt', 'durable record fails integrity verification');
    }
  }
  failStore('context-store-conflict', 'refusing to overwrite a different durable record');
  return null;
}

function atomicClaimFileSync(target, contentBytes, verifyAfterWrite) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    return verifyExistingClaim(target, contentBytes, verifyAfterWrite);
  }
  tmpCounter += 1;
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + tmpCounter;
  fs.writeFileSync(tmp, contentBytes);
  try {
    const tmpRead = fs.readFileSync(tmp);
    if (!tmpRead.equals(contentBytes)) {
      failStore('context-store-temp-unverifiable', 'temp bytes failed verification');
    }
    if (typeof verifyAfterWrite === 'function') verifyAfterWrite(tmpRead);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
  // A pre-existing torn authoritative file (fallback crash debris) must fail
  // closed here, never read as half-valid and never silently overwritten.
  const verifyClaimedBytes = (readBack) => {
    if (!readBack.equals(contentBytes)) {
      failStore('context-store-corrupt', 'durable record fails read-back verification');
    }
    if (typeof verifyAfterWrite === 'function') verifyAfterWrite(readBack);
  };
  const unlinkTmp = () => { try { fs.unlinkSync(tmp); } catch { /* best effort */ } };
  const forcedFallback = claimStrategyForTests() === 'fallback';
  // Primary: exclusive hard-link claim. EEXIST means a rival already holds
  // the identity: converge when identical, fail closed when conflicting.
  if (!forcedFallback) {
    try {
      fs.linkSync(tmp, target);
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      verifyClaimedBytes(fs.readFileSync(target));
      return { disposition: 'created' };
    } catch (linkError) {
      if (linkError && linkError.code === 'EEXIST') {
        unlinkTmp();
        return verifyExistingClaim(target, contentBytes, verifyAfterWrite);
      }
      // Any other link failure (EPERM/EXDEV/ENOSYS: no hard-link support)
      // falls through to the exclusive-create fallback below.
    }
  }
  // Fallback (B02H): exclusive create-if-absent ('wx'). Exactly one
  // concurrent writer wins; rivals observe EEXIST and converge-or-conflict
  // on the winner's bytes. A crash mid-write can leave a torn file; every
  // read path fails closed on it (never half-valid acceptance), and a later
  // identical write fails closed as corrupt debris rather than overwriting.
  try {
    fs.writeFileSync(target, contentBytes, { flag: 'wx' });
  } catch (writeError) {
    unlinkTmp();
    if (writeError && writeError.code === 'EEXIST') {
      return verifyExistingClaim(target, contentBytes, verifyAfterWrite);
    }
    throw writeError;
  }
  unlinkTmp();
  verifyClaimedBytes(fs.readFileSync(target));
  return { disposition: forcedFallback ? 'created-fallback' : 'created-exclusive' };
}

// ---- blob bytes ----
// String input travels the canonical persistable-text route: the frozen A03
// redaction pipeline runs BEFORE identity, and the digest binds the redacted
// bytes that are actually stored. Pre-sanitized or opaque-binary bytes
// travel ONLY as branded PersistableExactBytes (see below): a raw arbitrary
// Buffer is never interchangeable with that proof and FAILS CLOSED, so
// textual secrets in a Buffer cannot bypass persistent redaction. Either
// accepted route guarantees: stored bytes === hashed bytes.
function isWordRunChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 95 || code === 46 || code === 45;
}

function assertSafeWordRuns(input) {
  let run = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (isWordRunChar(input.charCodeAt(index))) {
      run += 1;
      if (run > BLOB_MAX_WORD_RUN) {
        failStore('context-blob-run-too-long', 'evidence carries an over-long token run; split evidence or use a binary artifact');
      }
    } else {
      run = 0;
    }
  }
}

// Proof boundary for pre-sanitized bytes (B02H). The brand lives on a
// module-private symbol: it cannot be forged by a user-controlled boolean
// or fabricated object literal. The ONLY producers are the factory below,
// whose text shape runs the frozen A03 pipeline and whose binary shape
// enforces the explicit opaque-artifact contract.
// Module-private unique symbol (NOT the global registry): external code
// cannot obtain or forge this brand without module access.
const PERSISTABLE_BYTES_BRAND = Symbol('nexus.ccv2.persistable-exact-bytes');
const PERSISTABLE_BINARY_MAX_BYTES = 64 * 1024 * 1024;
const PERSISTABLE_ARTIFACT_ID_MAX = 256;
const PERSISTABLE_NOTE_MAX = 500;

function canonicalizeBlobText(input) {
  if (input === '') failStore('context-blob-empty', 'blob bytes must be nonempty');
  if (byteLengthUtf8(input) > BLOB_STRING_MAX_BYTES) {
    failStore('context-blob-too-large', 'string evidence exceeds the redaction bound; split evidence or use a binary artifact');
  }
  assertSafeWordRuns(input);
  const headroom = input.length * 2 + 4096;
  const redacted = checkpointV2.redactCheckpointTextV2(input, headroom);
  if (redacted.endsWith('...<truncated>')) {
    failStore('context-blob-too-large', 'redacted blob exceeds the deterministic bound');
  }
  if (redacted === '') failStore('context-blob-empty', 'blob bytes are empty after redaction');
  return { bytes: Buffer.from(redacted, 'utf8'), kind: 'text' };
}

function isRedactionStableBounded(value, maxChars) {
  return typeof value === 'string' && value !== '' && value.length <= maxChars
    && checkpointV2.redactCheckpointTextV2(value, maxChars) === value;
}

// Opaque binary artifacts (B02H): explicit source descriptor, exact digest,
// byte-exact storage, NO redaction of the bytes themselves (redaction is a
// text policy and cannot apply to opaque bytes). Binary blobs therefore
// carry no secrecy guarantee on their content and MUST NOT be materialized
// as controller/model text by later phases; only their descriptor (which is
// redaction-stable) is safe to quote. Textual logs must never be relabeled
// as binary to skip redaction: genuine binary means non-textual bytes with
// a named producing artifact.
function brandBinaryBytes(binary, artifactId, note) {
  if (!Buffer.isBuffer(binary)) failStore('context-blob-invalid', 'binary evidence must be a Buffer');
  if (binary.length === 0) failStore('context-blob-empty', 'blob bytes must be nonempty');
  if (binary.length > PERSISTABLE_BINARY_MAX_BYTES) {
    failStore('context-blob-too-large', 'binary evidence exceeds the binary bound');
  }
  if (!isRedactionStableBounded(artifactId, PERSISTABLE_ARTIFACT_ID_MAX)) {
    failStore('context-blob-provenance-invalid', 'binary evidence requires a redaction-stable artifactId');
  }
  let cleanNote = null;
  if (note !== undefined && note !== null) {
    if (!isRedactionStableBounded(note, PERSISTABLE_NOTE_MAX)) {
      failStore('context-blob-provenance-invalid', 'binary evidence note must be redaction-stable');
    }
    cleanNote = note;
  }
  return Object.freeze({
    [PERSISTABLE_BYTES_BRAND]: true,
    kind: 'binary',
    bytes: Buffer.from(binary),
    artifactId,
    note: cleanNote,
  });
}

function createPersistableExactBytesV2(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    failStore('context-blob-invalid', 'a text or binary source is required');
  }
  const hasText = source.text !== undefined && source.text !== null;
  const hasBinary = source.binary !== undefined && source.binary !== null;
  if (hasText === hasBinary) {
    failStore('context-blob-invalid', 'exactly one of text or binary is required');
  }
  if (hasText) {
    if (typeof source.text !== 'string') failStore('context-blob-invalid', 'text evidence must be a string');
    if (unknownKeyOf(source, ['text']) !== null) failStore('context-blob-invalid', 'text source carries unknown keys');
    const canonical = canonicalizeBlobText(source.text);
    return Object.freeze({
      [PERSISTABLE_BYTES_BRAND]: true,
      kind: 'text',
      bytes: canonical.bytes,
    });
  }
  if (unknownKeyOf(source, ['binary', 'artifactId', 'note']) !== null) {
    failStore('context-blob-invalid', 'binary source carries unknown keys');
  }
  return brandBinaryBytes(source.binary, source.artifactId, source.note);
}

function isPersistableExactBytesV2(value) {
  return Boolean(value !== null && typeof value === 'object'
    && value[PERSISTABLE_BYTES_BRAND] === true
    && (value.kind === 'text' || value.kind === 'binary')
    && Buffer.isBuffer(value.bytes) && value.bytes.length > 0);
}

function canonicalizeBlobInput(input) {
  if (typeof input === 'string') {
    const canonical = canonicalizeBlobText(input);
    return { bytes: canonical.bytes, kind: 'text' };
  }
  if (isPersistableExactBytesV2(input)) {
    return { bytes: Buffer.from(input.bytes), kind: input.kind };
  }
  // Raw arbitrary Buffers are rejected: textual secrets inside a Buffer
  // must not bypass persistent redaction, and opaque bytes require the
  // explicit binary provenance of the branded factory. A user-controlled
  // boolean can never satisfy the module-private brand.
  if (Buffer.isBuffer(input)) {
    failStore('context-blob-attestation-required', 'raw Buffers are not persistable; use createPersistableExactBytesV2');
  }
  failStore('context-blob-invalid', 'blob input must be a string or PersistableExactBytes');
  return null;
}

function deriveBlobDigestV2(contentBytes) {
  return sha256HexBytes(contentBytes);
}

function blobRefForDigest(digest) {
  return BLOB_REF_PREFIX + digest;
}

// ---- blob write contract (frozen order) ----
// canonicalize -> digest -> final path -> (exists? verify+reuse : temp +
// verify + exclusive claim + read-back + recompute) -> durable ref.
function putBlobV2(contextRoot, input) {
  const root = assertSafeContextRoot(contextRoot);
  const canonical = canonicalizeBlobInput(input);
  const contentBytes = canonical.bytes;
  const blobKind = canonical.kind;
  const digest = deriveBlobDigestV2(contentBytes);
  const blobRef = blobRefForDigest(digest);
  const target = blobFilePath(root, digest);
  const verify = (bytes) => {
    if (sha256HexBytes(bytes) !== digest) {
      failStore('context-blob-content-mismatch', 'blob bytes do not hash to ' + digest.slice(0, 16));
    }
  };
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (sha256HexBytes(existing) !== digest) {
      failStore('context-blob-content-mismatch', 'existing blob bytes fail identity verification');
    }
    return { blobRef, digest, byteLength: existing.length, deduplicated: true, kind: blobKind };
  }
  const result = atomicClaimFileSync(target, contentBytes, verify);
  const readBack = fs.readFileSync(target);
  if (sha256HexBytes(readBack) !== digest) {
    failStore('context-blob-content-mismatch', 'blob read-back failed identity verification');
  }
  return {
    blobRef, digest, byteLength: readBack.length, deduplicated: result.disposition === 'existing-identical', kind: blobKind,
  };
}

function hasBlobV2(contextRoot, blobRef) {
  const root = assertSafeContextRoot(contextRoot);
  const target = blobPathForRef(root, blobRef);
  if (!fs.existsSync(target)) return false;
  const existing = fs.readFileSync(target);
  const digest = String(blobRef).slice(BLOB_REF_PREFIX.length);
  return sha256HexBytes(existing) === digest;
}

function readBlobV2(contextRoot, blobRef) {
  const root = assertSafeContextRoot(contextRoot);
  const target = blobPathForRef(root, blobRef);
  const digest = String(blobRef).slice(BLOB_REF_PREFIX.length);
  if (!HEX64_PATTERN.test(digest)) failStore('context-blob-ref-invalid', 'blobRef digest is malformed');
  let existing = null;
  try {
    existing = fs.readFileSync(target);
  } catch {
    failStore('context-blob-missing', 'blob is not durable');
  }
  if (sha256HexBytes(existing) !== digest) {
    failStore('context-blob-content-mismatch', 'stored blob bytes fail identity verification');
  }
  return existing;
}

// ---- full page-record integrity (frozen) ----
// B01 pageId binds evidence identity; advisory fields are deliberately
// excluded from it. The pageRecordDigest binds the COMPLETE canonical
// persisted page record, so advisory tampering on disk is detected even
// though the pageId legitimately stays the same. Reuses the frozen B01
// canonicalizer; the pageId formula is untouched.
function deriveContextPageRecordDigestV2(page) {
  const check = pageV2.validateContextPageV2(page);
  if (!check.valid) failStore(check.reason, 'cannot digest an invalid page');
  return sha256HexUtf8(pageV2.canonicalizeContextPageV2(page));
}

function serializePageRecord(page, pageRecordDigest) {
  return JSON.stringify(checkpointV2.canonicalize({
    schemaVersion: STORE_SCHEMA_VERSION,
    page,
    pageRecordDigest,
  }));
}

function parseAndVerifyPageRecord(rawText, expectedPageId) {
  let envelope = null;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    failStore('context-page-corrupt', 'page record is not valid JSON');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    failStore('context-page-corrupt', 'page record has an invalid envelope');
  }
  if (Number(envelope.schemaVersion) !== STORE_SCHEMA_VERSION) {
    failStore('context-page-corrupt', 'page record schema version mismatch');
  }
  if (unknownKeyOf(envelope, ['schemaVersion', 'page', 'pageRecordDigest']) !== null) {
    failStore('context-page-corrupt', 'page record carries unknown keys');
  }
  const check = pageV2.validateContextPageV2(envelope.page);
  if (!check.valid) failStore(check.reason, 'stored page fails closed-world validation');
  if (typeof envelope.pageRecordDigest !== 'string' || !HEX64_PATTERN.test(envelope.pageRecordDigest)) {
    failStore('context-page-digest-invalid', 'stored page record digest is malformed');
  }
  const recomputed = sha256HexUtf8(pageV2.canonicalizeContextPageV2(envelope.page));
  if (recomputed !== envelope.pageRecordDigest) {
    failStore('context-page-digest-mismatch', 'stored page record fails integrity verification');
  }
  if (expectedPageId !== undefined && expectedPageId !== null && envelope.page.id !== expectedPageId) {
    failStore('context-page-id-mismatch', 'stored page identity diverged from its storage key');
  }
  if (rawText !== serializePageRecord(envelope.page, envelope.pageRecordDigest)) {
    failStore('context-page-corrupt', 'page record bytes fail read-back identity');
  }
  return envelope;
}

function requireExpectedNamespace(expectedNamespace) {
  if (!expectedNamespace || typeof expectedNamespace !== 'object' || Array.isArray(expectedNamespace)) {
    failStore('context-namespace-required', 'an explicit expected namespace is required');
  }
  return expectedNamespace;
}

// ---- page persistence (frozen order) ----
// validate (B01 verbatim) -> namespace bind -> blob-backed proof (blob must
// ALREADY be durable) -> record digest -> exclusive claim -> read-back.
function putContextPageV2(contextRoot, page, options) {
  const root = assertSafeContextRoot(contextRoot);
  const expectedNamespace = options !== undefined && options !== null ? options.expectedNamespace : undefined;
  const check = pageV2.validateContextPageV2(page);
  if (!check.valid) failStore(check.reason, 'refusing to persist an invalid page');
  if (expectedNamespace !== undefined && expectedNamespace !== null) {
    const namespaced = pageV2.validateContextPageV2(page, { expectedNamespace });
    if (!namespaced.valid) failStore(namespaced.reason, 'page namespace is not bound to the expected namespace');
  }
  // Blob-backed proof MUST precede page durability: the referenced blob must
  // exist and its recomputed hash must equal the page contentHash.
  if (page.exactBlobRef !== null && page.exactBlobRef !== undefined) {
    const blobBytes = readBlobV2(root, page.exactBlobRef);
    if (sha256HexBytes(blobBytes) !== page.contentHash) {
      failStore('context-page-content-mismatch', 'referenced blob does not match page contentHash');
    }
  }
  const pageRecordDigest = deriveContextPageRecordDigestV2(page);
  const serialized = serializePageRecord(page, pageRecordDigest);
  const target = pageFilePath(root, page.id);
  const verify = (bytes) => {
    parseAndVerifyPageRecord(bytes.toString('utf8'), page.id);
  };
  const result = atomicClaimFileSync(target, Buffer.from(serialized, 'utf8'), verify);
  const readBack = parseAndVerifyPageRecord(fs.readFileSync(target, 'utf8'), page.id);
  return {
    pageId: page.id,
    pageRecordDigest: readBack.pageRecordDigest,
    byteLength: byteLengthUtf8(serialized),
    deduplicated: result.disposition === 'existing-identical',
  };
}

function hasContextPageV2(contextRoot, pageId, options) {
  const root = assertSafeContextRoot(contextRoot);
  const target = pageFilePath(root, pageId);
  if (!fs.existsSync(target)) return false;
  try {
    readContextPageV2(root, pageId, options);
    return true;
  } catch {
    return false;
  }
}

// Read contract (frozen): bytes -> parse -> closed-world validate -> pageId
// recompute (inside B01 validation) -> storage-key binding -> full-record
// digest -> expected namespace -> blob-backed re-proof -> frozen page.
function readContextPageV2(contextRoot, pageId, options) {
  const root = assertSafeContextRoot(contextRoot);
  const expectedNamespace = requireExpectedNamespace(
    options !== undefined && options !== null ? options.expectedNamespace : undefined,
  );
  const target = pageFilePath(root, pageId);
  let rawText = null;
  try {
    rawText = fs.readFileSync(target, 'utf8');
  } catch {
    failStore('context-page-missing', 'page is not durable');
  }
  const envelope = parseAndVerifyPageRecord(rawText, pageId);
  const namespaced = pageV2.validateContextPageV2(envelope.page, { expectedNamespace });
  if (!namespaced.valid) failStore(namespaced.reason, 'stored page is outside the expected namespace');
  if (envelope.page.exactBlobRef !== null && envelope.page.exactBlobRef !== undefined) {
    const blobBytes = readBlobV2(root, envelope.page.exactBlobRef);
    if (sha256HexBytes(blobBytes) !== envelope.page.contentHash) {
      failStore('context-page-content-mismatch', 'durable page references diverging blob bytes');
    }
  }
  return Object.freeze(JSON.parse(JSON.stringify(envelope.page)));
}

// ---- advisory metadata versioning (frozen) ----
// Historical core records are immutable. Advisory refreshes land in SEPARATE
// derived records bound to (pageId, contentHash); the core file is never
// rewritten. Readers must overlay explicitly; B03 owns overlay semantics.
// Advisory file entries are inert metadata (never resolved to the
// filesystem), but they keep the frozen B01 relative-POSIX shape so a
// derived record can never smuggle absolute/escape/traversal text.
function isAdvisoryPathShape(value) {
  if (typeof value !== 'string' || value === '' || value.length > 500) return false;
  if (value.startsWith('/')) return false;
  if (value.includes('\\')) return false;
  if (!/^[\x20-\x7E]+$/.test(value)) return false;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

function normalizeAdvisoryInput(advisory) {
  if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory)) {
    failStore('context-advisory-invalid', 'advisory update is required');
  }
  if (unknownKeyOf(advisory, ADVISORY_BODY_EXACT_KEYS) !== null) {
    failStore('context-advisory-invalid', 'advisory carries non-advisory keys');
  }
  const body = {};
  if (advisory.semanticGloss !== undefined && advisory.semanticGloss !== null) {
    if (typeof advisory.semanticGloss !== 'string' || advisory.semanticGloss === '') {
      failStore('context-page-gloss-invalid', 'semanticGloss must be a nonempty string');
    }
    body.semanticGloss = checkpointV2.redactCheckpointTextV2(
      advisory.semanticGloss, pageV2.PAGE_BOUNDS.semanticGlossMaxChars,
    );
    if (body.semanticGloss.length > pageV2.PAGE_BOUNDS.semanticGlossMaxChars
      || body.semanticGloss.endsWith('...<truncated>')) {
      failStore('context-page-gloss-invalid', 'semanticGloss exceeds the bound');
    }
  }
  for (const key of ['entities', 'symbols', 'tags']) {
    if (advisory[key] !== undefined && advisory[key] !== null) {
      if (!Array.isArray(advisory[key])) failStore('context-page-metadata-invalid', key);
      const cleaned = Array.from(new Set(advisory[key].map((entry) => String(entry)))).sort();
      for (const entry of cleaned) {
        if (typeof entry !== 'string' || entry === '' || entry.length > pageV2.PAGE_BOUNDS.metadataEntryMaxChars) {
          failStore('context-page-metadata-invalid', key);
        }
      }
      body[key] = cleaned;
    }
  }
  if (advisory.files !== undefined && advisory.files !== null) {
    if (!Array.isArray(advisory.files)) failStore('context-page-metadata-invalid', 'files');
    body.files = Array.from(new Set(advisory.files.map((entry) => String(entry)))).sort();
    for (const file of body.files) {
      if (!isAdvisoryPathShape(file)) failStore('context-page-path-invalid', 'advisory files');
    }
  }
  if (advisory.lastNeededAtGeneration !== undefined && advisory.lastNeededAtGeneration !== null) {
    if (!Number.isInteger(advisory.lastNeededAtGeneration) || advisory.lastNeededAtGeneration < 1) {
      failStore('context-page-generation-invalid', 'lastNeededAtGeneration must be an integer >= 1');
    }
    body.lastNeededAtGeneration = advisory.lastNeededAtGeneration;
  }
  if (Object.keys(body).length === 0) failStore('context-advisory-invalid', 'advisory update is empty');
  return body;
}

function deriveAdvisoryDigestV2(pageId, contentHash, advisoryBody) {
  return sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: PAGE_RECORD_DOMAIN_V1,
    pageId,
    contentHash,
    advisory: advisoryBody,
  })));
}

function updatePageAdvisoryV2(contextRoot, pageId, advisory, options) {
  const root = assertSafeContextRoot(contextRoot);
  const expectedNamespace = requireExpectedNamespace(
    options !== undefined && options !== null ? options.expectedNamespace : undefined,
  );
  // The core page must already be durable; advisory records never exist
  // without their core (orphan-safe by construction).
  // The core page must already be durable; advisory records never exist
  // without their core (orphan-safe by construction). Both immutable and
  // versioned pages may accrue derived advisory records, but the core file
  // itself never changes either way.
  const core = readContextPageV2(root, pageId, { expectedNamespace });
  const body = normalizeAdvisoryInput(advisory);
  if (body.lastNeededAtGeneration !== null && body.lastNeededAtGeneration !== undefined
    && body.lastNeededAtGeneration < core.createdAtGeneration) {
    failStore('context-page-generation-invalid', 'advisory generation precedes page creation');
  }
  const advisoryDigest = deriveAdvisoryDigestV2(core.id, core.contentHash, body);
  const record = {
    schemaVersion: STORE_SCHEMA_VERSION,
    pageId: core.id,
    contentHash: core.contentHash,
    advisory: body,
    advisoryDigest,
  };
  const serialized = JSON.stringify(checkpointV2.canonicalize(record));
  const target = advisoryFilePath(root, core.id, advisoryDigest);
  const result = atomicClaimFileSync(target, Buffer.from(serialized, 'utf8'), (bytes) => {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.advisoryDigest !== deriveAdvisoryDigestV2(parsed.pageId, parsed.contentHash, parsed.advisory)) {
      failStore('context-advisory-corrupt', 'advisory record fails integrity verification');
    }
  });
  return {
    pageId: core.id, advisoryDigest, byteLength: byteLengthUtf8(serialized),
    deduplicated: result.disposition === 'existing-identical',
  };
}

function readPageAdvisoryV2(contextRoot, pageId, advisoryDigest, options) {
  const root = assertSafeContextRoot(contextRoot);
  requireExpectedNamespace(options !== undefined && options !== null ? options.expectedNamespace : undefined);
  // Namespace proof rides on the core page read; advisory bytes are then
  // integrity-verified against their own digest.
  const core = readContextPageV2(root, pageId, options);
  const target = advisoryFilePath(root, pageId, advisoryDigest);
  let rawText = null;
  try {
    rawText = fs.readFileSync(target, 'utf8');
  } catch {
    failStore('context-advisory-missing', 'advisory record is not durable');
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    failStore('context-advisory-corrupt', 'advisory record is not valid JSON');
  }
  if (unknownKeyOf(parsed, ADVISORY_EXACT_KEYS) !== null) {
    failStore('context-advisory-corrupt', 'advisory record carries unknown keys');
  }
  if (parsed.pageId !== core.id || parsed.contentHash !== core.contentHash) {
    failStore('context-advisory-mismatch', 'advisory record is not bound to this page');
  }
  if (parsed.advisoryDigest !== deriveAdvisoryDigestV2(parsed.pageId, parsed.contentHash, parsed.advisory)) {
    failStore('context-advisory-corrupt', 'advisory record fails integrity verification');
  }
  return Object.freeze(JSON.parse(JSON.stringify(parsed)));
}

// ---- EvidenceRef durable binding (frozen) ----
// Reuses Phase-A EvidenceRef semantics VERBATIM (closed-world keys, kinds,
// bounds from config/ContextCheckpointV2.cjs exports). B02 adds only the
// deterministic join: evidenceBindingId + (pageId, contentHash, blobRef,
// namespace). No competing evidence identity model, no UUID, no clock.
function deriveEvidenceBindingIdV2(taskInstanceId, evidenceId) {
  if (typeof taskInstanceId !== 'string' || taskInstanceId === '') {
    failStore('context-evidence-invalid', 'taskInstanceId is required');
  }
  if (typeof evidenceId !== 'string' || evidenceId === '') {
    failStore('context-evidence-invalid', 'evidenceId is required');
  }
  const joined = [EVIDENCE_BINDING_DOMAIN_V1, taskInstanceId, evidenceId].join('\n');
  return 'ev_' + sha256HexUtf8(joined).slice(0, 32);
}

function validatePhaseAEvidenceRef(evidenceRef, taskInstanceId) {
  if (!evidenceRef || typeof evidenceRef !== 'object' || Array.isArray(evidenceRef)) {
    return 'checkpoint-evidence-invalid';
  }
  if (unknownKeyOf(evidenceRef, checkpointV2.CHECKPOINT_EVIDENCE_REF_EXACT_KEYS) !== null) {
    return 'checkpoint-evidence-invalid';
  }
  if (Number(evidenceRef.schemaVersion) !== 1) return 'checkpoint-evidence-invalid';
  if (typeof evidenceRef.evidenceId !== 'string' || evidenceRef.evidenceId === ''
    || evidenceRef.evidenceId.length > checkpointV2.BOUNDS.evidenceId) {
    return 'checkpoint-evidence-invalid';
  }
  if (!checkpointV2.EVIDENCE_KINDS.includes(evidenceRef.kind)) return 'checkpoint-evidence-invalid';
  if (typeof evidenceRef.locator !== 'string' || evidenceRef.locator === ''
    || evidenceRef.locator.length > checkpointV2.BOUNDS.evidenceLocator) {
    return 'checkpoint-evidence-invalid';
  }
  if (evidenceRef.digest !== null && evidenceRef.digest !== undefined
    && (typeof evidenceRef.digest !== 'string' || evidenceRef.digest === ''
      || String(evidenceRef.digest).length > checkpointV2.BOUNDS.evidenceDigest)) {
    return 'checkpoint-evidence-invalid';
  }
  if (typeof evidenceRef.observedAtUtc !== 'string' || !Number.isFinite(Date.parse(evidenceRef.observedAtUtc))) {
    return 'checkpoint-evidence-invalid';
  }
  if (typeof evidenceRef.taskInstanceId !== 'string' || evidenceRef.taskInstanceId !== taskInstanceId) {
    return 'checkpoint-evidence-invalid';
  }
  return null;
}

function deriveEvidenceBindingDigestV2(record) {
  return sha256HexUtf8(JSON.stringify(checkpointV2.canonicalize({
    domain: EVIDENCE_BINDING_DOMAIN_V1,
    evidenceRef: record.evidenceRef,
    pageId: record.pageId,
    contentHash: record.contentHash,
    exactBlobRef: record.exactBlobRef,
    namespace: record.namespace,
  })));
}

// Page durability MUST precede dependent EvidenceRef durability: the page is
// re-read (fully revalidated, namespace-bound, blob re-proven) before the
// binding is claimed.
function putEvidenceV2(contextRoot, input) {
  const root = assertSafeContextRoot(contextRoot);
  if (!input || typeof input !== 'object') failStore('context-evidence-invalid', 'input is required');
  const expectedNamespace = requireExpectedNamespace(input.expectedNamespace);
  if (typeof input.pageId !== 'string' || !PAGE_ID_PATTERN.test(input.pageId)) {
    failStore('context-page-id-invalid', 'pageId must be cxp_ + 32 hex');
  }
  const evidenceRef = input.evidenceRef;
  const refReason = validatePhaseAEvidenceRef(evidenceRef, expectedNamespace.taskInstanceId);
  if (refReason !== null) failStore(refReason, 'Phase-A EvidenceRef is not bindable');
  const page = readContextPageV2(root, input.pageId, { expectedNamespace });
  // Binding integrity: the record must not claim a contentHash the page and
  // blob do not carry.
  if (evidenceRef.digest !== null && evidenceRef.digest !== undefined
    && String(evidenceRef.digest) !== page.contentHash) {
    failStore('context-evidence-content-mismatch', 'EvidenceRef digest diverges from page contentHash');
  }
  const evidenceBindingId = deriveEvidenceBindingIdV2(expectedNamespace.taskInstanceId, evidenceRef.evidenceId);
  const record = {
    schemaVersion: STORE_SCHEMA_VERSION,
    evidenceBindingId,
    evidenceRef: JSON.parse(JSON.stringify(evidenceRef)),
    pageId: page.id,
    contentHash: page.contentHash,
    exactBlobRef: page.exactBlobRef,
    namespace: JSON.parse(JSON.stringify(page.namespace)),
    bindingDigest: null,
  };
  record.bindingDigest = deriveEvidenceBindingDigestV2(record);
  const serialized = JSON.stringify(checkpointV2.canonicalize(record));
  const target = evidenceFilePath(root, evidenceBindingId);
  const result = atomicClaimFileSync(target, Buffer.from(serialized, 'utf8'), (bytes) => {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.bindingDigest !== deriveEvidenceBindingDigestV2(parsed)) {
      failStore('context-evidence-corrupt', 'evidence record fails integrity verification');
    }
  });
  return {
    evidenceBindingId, pageId: page.id, contentHash: page.contentHash,
    byteLength: byteLengthUtf8(serialized),
    deduplicated: result.disposition === 'existing-identical',
  };
}

function readEvidenceV2(contextRoot, taskInstanceId, evidenceId, options) {
  const root = assertSafeContextRoot(contextRoot);
  const expectedNamespace = requireExpectedNamespace(
    options !== undefined && options !== null ? options.expectedNamespace : undefined,
  );
  if (typeof taskInstanceId !== 'string' || taskInstanceId !== expectedNamespace.taskInstanceId) {
    failStore('context-evidence-namespace-mismatch', 'taskInstanceId is outside the expected namespace');
  }
  const bindingId = deriveEvidenceBindingIdV2(taskInstanceId, evidenceId);
  const target = evidenceFilePath(root, bindingId);
  let rawText = null;
  try {
    rawText = fs.readFileSync(target, 'utf8');
  } catch {
    failStore('context-evidence-missing', 'evidence binding is not durable');
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    failStore('context-evidence-corrupt', 'evidence record is not valid JSON');
  }
  if (unknownKeyOf(parsed, EVIDENCE_RECORD_EXACT_KEYS) !== null) {
    failStore('context-evidence-corrupt', 'evidence record carries unknown keys');
  }
  if (parsed.evidenceBindingId !== bindingId) {
    failStore('context-evidence-id-mismatch', 'evidence record identity diverged from its storage key');
  }
  const refReason = validatePhaseAEvidenceRef(parsed.evidenceRef, expectedNamespace.taskInstanceId);
  if (refReason !== null) failStore(refReason, 'stored EvidenceRef fails Phase-A validation');
  if (parsed.bindingDigest !== deriveEvidenceBindingDigestV2(parsed)) {
    failStore('context-evidence-corrupt', 'evidence record fails integrity verification');
  }
  // Revalidate the full binding on every read: page + blob proof.
  const page = readContextPageV2(root, parsed.pageId, { expectedNamespace });
  if (page.contentHash !== parsed.contentHash) {
    failStore('context-evidence-content-mismatch', 'evidence binding diverges from its page');
  }
  return Object.freeze(JSON.parse(JSON.stringify(parsed)));
}

// ---- orchestrated persistence (frozen order: blob -> page -> evidence) ----
function persistEvidenceV2(contextRoot, input) {
  const root = assertSafeContextRoot(contextRoot);
  if (!input || typeof input !== 'object') failStore('context-evidence-invalid', 'input is required');
  const expectedNamespace = requireExpectedNamespace(input.expectedNamespace);
  let blobRef = null;
  let blobResult = null;
  if (input.blobBytes !== undefined && input.blobBytes !== null) {
    blobResult = putBlobV2(root, input.blobBytes);
    blobRef = blobResult.blobRef;
  }
  let page = null;
  if (input.page !== undefined && input.page !== null) {
    const check = pageV2.validateContextPageV2(input.page);
    if (!check.valid) failStore(check.reason, 'refusing to persist an invalid page');
    if (blobRef !== null && input.page.exactBlobRef !== blobRef) {
      failStore('context-page-content-mismatch', 'supplied page does not reference the persisted blob');
    }
    page = input.page;
  } else if (input.pageInput !== undefined && input.pageInput !== null) {
    const pageInput = Object.assign({}, input.pageInput);
    if (blobRef !== null) {
      if (pageInput.exactBlobRef !== undefined && pageInput.exactBlobRef !== null && pageInput.exactBlobRef !== blobRef) {
        failStore('context-page-content-mismatch', 'pageInput blob route diverges from the persisted blob');
      }
      pageInput.exactBlobRef = blobRef;
    }
    if (typeof pageInput.exactText === 'string' && byteLengthUtf8(pageInput.exactText) > INLINE_EXACT_MAX_BYTES
      && (pageInput.exactBlobRef === undefined || pageInput.exactBlobRef === null)) {
      failStore('context-store-inline-too-large', 'exact evidence exceeds the inline bound; use blobBytes');
    }
    page = pageV2.createContextPageV2(pageInput);
  } else {
    failStore('context-evidence-invalid', 'page or pageInput is required');
  }
  const pageResult = putContextPageV2(root, page, { expectedNamespace });
  let evidenceResult = null;
  if (input.evidenceRef !== undefined && input.evidenceRef !== null) {
    evidenceResult = putEvidenceV2(root, {
      evidenceRef: input.evidenceRef, pageId: pageResult.pageId, expectedNamespace,
    });
  }
  return {
    blobRef,
    blobDeduplicated: blobResult !== null ? blobResult.deduplicated : null,
    blobKind: blobResult !== null ? blobResult.kind : null,
    pageId: pageResult.pageId,
    pageRecordDigest: pageResult.pageRecordDigest,
    pageDeduplicated: pageResult.deduplicated,
    evidenceBindingId: evidenceResult !== null ? evidenceResult.evidenceBindingId : null,
  };
}

// ---- store validation + inspection (bounded, no content) ----
function listStoreFiles(root, dirname, extension) {
  const dir = path.join(root, dirname);
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.includes('.tmp-')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function validateContextPageStoreV2(contextRoot, options) {
  const root = assertSafeContextRoot(contextRoot);
  const expectedNamespace = options !== undefined && options !== null ? options.expectedNamespace : undefined;
  const report = {
    schemaVersion: STORE_SCHEMA_VERSION,
    pagesChecked: 0, pagesValid: 0, blobsChecked: 0, blobsValid: 0,
    evidenceChecked: 0, evidenceValid: 0, advisoryChecked: 0, advisoryValid: 0,
    orphanTempFiles: 0, failures: [],
  };
  const recordFailure = (file, reason) => {
    report.failures.push({ file: path.relative(root, file), reason });
  };
  // Temp files are never authoritative; count them as bounded crash debris.
  for (const dirname of [BLOB_DIRNAME, PAGE_DIRNAME, ADVISORY_DIRNAME, EVIDENCE_DIRNAME]) {
    const dir = path.join(root, dirname);
    const countTmp = (current) => {
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { countTmp(full); continue; }
        if (entry.isFile() && entry.name.includes('.tmp-')) report.orphanTempFiles += 1;
      }
    };
    countTmp(dir);
  }
  for (const file of listStoreFiles(root, BLOB_DIRNAME, '.blob')) {
    report.blobsChecked += 1;
    try {
      const base = path.basename(file, '.blob');
      const digest = base;
      if (!HEX64_PATTERN.test(digest)) throw new Error('malformed blob filename');
      const bytes = fs.readFileSync(file);
      if (sha256HexBytes(bytes) !== digest) throw new Error('context-blob-content-mismatch');
      report.blobsValid += 1;
    } catch (error) {
      recordFailure(file, String(error && error.message).slice(0, 160));
    }
  }
  for (const file of listStoreFiles(root, PAGE_DIRNAME, '.json')) {
    report.pagesChecked += 1;
    try {
      const base = path.basename(file, '.json');
      const envelope = parseAndVerifyPageRecord(fs.readFileSync(file, 'utf8'), base);
      if (expectedNamespace !== undefined && expectedNamespace !== null) {
        const namespaced = pageV2.validateContextPageV2(envelope.page, { expectedNamespace });
        if (!namespaced.valid) throw new Error(namespaced.reason);
      }
      if (envelope.page.exactBlobRef !== null && envelope.page.exactBlobRef !== undefined) {
        const blobBytes = readBlobV2(root, envelope.page.exactBlobRef);
        if (sha256HexBytes(blobBytes) !== envelope.page.contentHash) {
          throw new Error('context-page-content-mismatch');
        }
      }
      report.pagesValid += 1;
    } catch (error) {
      recordFailure(file, String(error && error.message).slice(0, 160));
    }
  }
  for (const file of listStoreFiles(root, EVIDENCE_DIRNAME, '.json')) {
    report.evidenceChecked += 1;
    try {
      const bindingId = path.basename(file, '.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.evidenceBindingId !== bindingId) throw new Error('context-evidence-id-mismatch');
      if (parsed.bindingDigest !== deriveEvidenceBindingDigestV2(parsed)) {
        throw new Error('context-evidence-corrupt');
      }
      report.evidenceValid += 1;
    } catch (error) {
      recordFailure(file, String(error && error.message).slice(0, 160));
    }
  }
  for (const file of listStoreFiles(root, ADVISORY_DIRNAME, '.json')) {
    report.advisoryChecked += 1;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.advisoryDigest
        !== deriveAdvisoryDigestV2(parsed.pageId, parsed.contentHash, parsed.advisory)) {
        throw new Error('context-advisory-corrupt');
      }
      report.advisoryValid += 1;
    } catch (error) {
      recordFailure(file, String(error && error.message).slice(0, 160));
    }
  }
  report.valid = report.failures.length === 0;
  return Object.freeze(report);
}

// Bounded observational facts only: digests, byte counts, namespaces, page
// kinds. NEVER evidence content.
function inspectContextPageStoreV2(contextRoot) {
  const root = assertSafeContextRoot(contextRoot);
  const facts = { schemaVersion: STORE_SCHEMA_VERSION, blobs: 0, blobBytes: 0, pages: 0, evidence: 0, advisory: 0 };
  for (const file of listStoreFiles(root, BLOB_DIRNAME, '.blob')) {
    facts.blobs += 1;
    try { facts.blobBytes += fs.statSync(file).size; } catch { /* best effort */ }
  }
  facts.pages = listStoreFiles(root, PAGE_DIRNAME, '.json').length;
  facts.evidence = listStoreFiles(root, EVIDENCE_DIRNAME, '.json').length;
  facts.advisory = listStoreFiles(root, ADVISORY_DIRNAME, '.json').length;
  return Object.freeze(facts);
}

function describeContextPageStoreV2(result) {
  if (!result || typeof result !== 'object') failStore('context-store-describe-invalid', 'result is required');
  return Object.freeze({
    pageId: result.pageId || null,
    pageRecordDigestPrefix: result.pageRecordDigest ? String(result.pageRecordDigest).slice(0, 16) : null,
    blobRefPrefix: result.blobRef ? String(result.blobRef).slice(0, 24) : null,
    evidenceBindingId: result.evidenceBindingId || null,
    deduplicated: Boolean(result.pageDeduplicated || result.blobDeduplicated),
  });
}

module.exports = {
  STORE_SCHEMA_VERSION,
  INLINE_EXACT_MAX_BYTES,
  BLOB_STRING_MAX_BYTES,
  BLOB_MAX_WORD_RUN,
  PERSISTABLE_BINARY_MAX_BYTES,
  BLOB_REF_PREFIX,
  contextRootForV2,
  createPersistableExactBytesV2,
  isPersistableExactBytesV2,
  putBlobV2,
  hasBlobV2,
  readBlobV2,
  deriveBlobDigestV2,
  deriveContextPageRecordDigestV2,
  putContextPageV2,
  hasContextPageV2,
  readContextPageV2,
  updatePageAdvisoryV2,
  readPageAdvisoryV2,
  deriveEvidenceBindingIdV2,
  putEvidenceV2,
  readEvidenceV2,
  persistEvidenceV2,
  validateContextPageStoreV2,
  inspectContextPageStoreV2,
  describeContextPageStoreV2,
};
