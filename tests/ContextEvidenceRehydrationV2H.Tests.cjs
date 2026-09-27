'use strict';
/**
 * ContextEvidenceRehydrationV2H.Tests.cjs - CCV2-B03H hardening proof.
 *
 * Proves against the REAL production authority (no fakes):
 *   config/ContextEvidenceRehydrationV2.cjs (inspectExactResolutionV2,
 *   rehydration paths) over frozen B01/B02 plus the hardened
 *   session/repository/artifact exact-source adapters.
 *
 * Covers H1 (stored rehydratable vs runtime exact resolvability + mode
 * matrix + B04 handoff partition + no semantic fallback), H2 (artifact
 * authority domain, realpath containment incl. symlink escape, namespace
 * before bytes, negative artifact matrix), and H3 (media-type determinism:
 * byte-boundary fixtures, conservative fallback stability, mtime
 * insensitivity, repeated-read determinism).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const store = require(path.join(repoRoot, 'config', 'ContextPageStoreV2.cjs'));
const page = require(path.join(repoRoot, 'config', 'ContextPageV2.cjs'));
const rehydrate = require(path.join(repoRoot, 'config', 'ContextEvidenceRehydrationV2.cjs'));
const memSession = require(path.join(repoRoot, 'config', 'ContextSessionEvidenceSourceV2.cjs'));
const repoSource = require(path.join(repoRoot, 'config', 'ContextRepositoryEvidenceSourceV2.cjs'));

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
  assert.ok(cond, name + (detail === undefined ? '' : ' :: ' + detail));
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function throwsWithCode(fn, code, name) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(error !== null && String(error && error.message).includes(code), name,
    error ? String(error.message).slice(0, 260) : 'did not throw');
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256Utf8 = (t) => sha256(Buffer.from(String(t), 'utf8'));

const NS_H = Object.freeze({
  taskId: 'TASK-B03H-A',
  taskInstanceId: 'task_b03h_a_0001',
  sessionId: 'sess-b03h-a',
  workspaceId: '/tmp/nexus-b03h-a',
  repositoryId: 'repo-b03h',
  checkoutId: 'checkout-b03h',
});
const NS_OTHER = Object.freeze({
  taskId: 'TASK-B03H-B',
  taskInstanceId: 'task_b03h_b_0001',
  sessionId: 'sess-b03h-b',
  workspaceId: '/tmp/nexus-b03h-b',
  repositoryId: 'repo-b03h',
  checkoutId: 'checkout-b03h',
});

function makeRoot(name) {
  const dir = path.join(repoRoot, 'tmp', 'b03h-unit-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function contextRootFor(taskId, name) {
  const root = store.contextRootForV2(makeRoot(name), taskId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function userEv(seq, text) {
  return { seq, type: 'user/message', data: { turn: 't1', step: 's1', message: { id: 'm' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } };
}
function memSource(sessionId, events) {
  return memSession.createMemorySessionSourceV2(sessionId, events);
}
function putPage(root, p, ns) {
  store.putContextPageV2(root, p, { expectedNamespace: clone(ns || NS_H) });
  return p;
}
function rehydratedPage(root, p, extra) {
  return rehydrate.rehydrateContextPageV2(Object.assign(
    { contextRoot: root, pageId: p.id, expectedNamespace: clone(NS_H) }, extra || {}));
}

// ── H1: CAPABILITY MATRIX ────────────────────────────────────────────
section('H1 CAPABILITY MATRIX');
{
  const root = contextRootFor('TASK-B03H-A', 'capability');

  // Inline page: stored true, durable-inline, no external authority needed.
  const pInline = putPage(root, page.createContextPageV2({
    kind: 'requirement', namespace: clone(NS_H), sourceKind: 'user', sourceRefs: ['session-event:3'],
    mutability: 'immutable', sourceSeqs: [3], exactText: 'H1 inline capability fixture.',
    createdAtGeneration: 1,
  }));
  const cInline = rehydrate.inspectExactResolutionV2(pInline, {});
  check(cInline.resolvable === true, 'inline page is exactly resolvable');
  check(cInline.mode === 'durable-inline', 'inline mode is durable-inline');
  check(cInline.requiresExternalSource === false, 'inline needs no external authority');
  check(cInline.storedRehydratable === true && cInline.durablySelfBacked === true, 'inline stored flag and backing agree');
  check(rehydratedPage(root, pInline).verified === true, 'inline page rehydrates');

  // Blob page: stored true, durable-blob.
  const blob = store.putBlobV2(root, 'H1 blob capability fixture line\n');
  const pBlob = putPage(root, page.createContextPageV2({
    kind: 'verification', namespace: clone(NS_H), sourceKind: 'verification', sourceRefs: ['test-run:h1'],
    mutability: 'immutable', sourceSeqs: [21], exactBlobRef: blob.blobRef, createdAtGeneration: 1,
  }));
  const cBlob = rehydrate.inspectExactResolutionV2(pBlob, {});
  check(cBlob.resolvable === true && cBlob.mode === 'durable-blob', 'blob mode is durable-blob');
  check(cBlob.requiresExternalSource === false && cBlob.storedRehydratable === true, 'blob needs no external authority');
  check(rehydratedPage(root, pBlob).verified === true, 'blob page rehydrates');

  // Pure-session page, no source: stored false, mode known, not resolvable.
  const sessEvents = [userEv(40, 'H1 session one.'), userEv(41, 'H1 session two.')];
  const sessDigest = rehydrate.deriveSessionEvidenceDigestV2(NS_H.sessionId, sessEvents);
  const pSess = putPage(root, page.createContextPageV2({
    kind: 'conversation', namespace: clone(NS_H), sourceKind: 'user', sourceRefs: ['session-event:40'],
    mutability: 'immutable', sourceSeqs: [40, 41], contentHash: sessDigest, createdAtGeneration: 1,
  }));
  check(pSess.rehydratable === false, 'pure-session page stores rehydratable=false');
  const cSessNone = rehydrate.inspectExactResolutionV2(pSess, {});
  check(cSessNone.resolvable === false, 'pure-session without authority is not resolvable');
  check(cSessNone.mode === 'exact-session-source', 'session mode is known structurally');
  check(cSessNone.requiresExternalSource === true && cSessNone.storedRehydratable === false, 'session route needs external authority, stored flag false');
  throwsWithCode(() => rehydratedPage(root, pSess),
    'context-rehydration-not-rehydratable', 'pure-session without source is refused, never guessed');

  // Pure-session + valid bound source: resolvable, stored flag UNCHANGED.
  const goodSrc = memSource(NS_H.sessionId, sessEvents);
  const cSessGood = rehydrate.inspectExactResolutionV2(pSess, { sessionSource: goodSrc });
  check(cSessGood.resolvable === true && cSessGood.mode === 'exact-session-source', 'bound session authority resolves capability');
  const rSess = rehydratedPage(root, pSess, { sessionSource: goodSrc });
  check(rSess.verified === true && rSess.sourceRoute === 'session', 'pure-session rehydrates with valid authority');
  const reread = store.readContextPageV2(root, pSess.id, { expectedNamespace: clone(NS_H) });
  check(reread.rehydratable === false, 'stored rehydratable:false is never rewritten by resolution');

  // Pure-session + wrong-session source: capability false, proof fails.
  const wrongSrc = memSource('sess-b03h-wrong', sessEvents);
  const cSessWrong = rehydrate.inspectExactResolutionV2(pSess, { sessionSource: wrongSrc });
  check(cSessWrong.resolvable === false && cSessWrong.mode === 'exact-session-source', 'wrong-session authority is capability-absent');
  throwsWithCode(() => rehydratedPage(root, pSess, { sessionSource: wrongSrc }),
    'context-rehydration-source-mismatch', 'wrong-session source fails closed at proof');

  // Pure-session + mutated source: capability structurally present, but
  // effective resolution is false (proof fails). This freezes the
  // inspector-vs-proof distinction.
  const mutated = [userEv(40, 'H1 session one.'), userEv(41, 'H1 session two MUTATED.')];
  const cSessMut = rehydrate.inspectExactResolutionV2(pSess, { sessionSource: memSource(NS_H.sessionId, mutated) });
  check(cSessMut.resolvable === true, 'mutated source is still capability-present (shape only)');
  throwsWithCode(() => rehydratedPage(root, pSess, { sessionSource: memSource(NS_H.sessionId, mutated) }),
    'context-rehydration-source-mismatch', 'mutated source has no effective resolution');

  // Repository binding page: capability tracks the supplied authority.
  const fixtureDir = makeRoot('h1repo');
  fs.writeFileSync(path.join(fixtureDir, 'note.txt'), 'line one\nline two\nline three\n');
  const spanDigest = sha256Utf8('line one\nline two');
  const pRepo = putPage(root, page.createContextPageV2({
    kind: 'repo-span', namespace: clone(NS_H), sourceKind: 'repository', sourceRefs: ['repo:HEAD:h1'],
    mutability: 'immutable', sourceSeqs: [],
    sourceBinding: { kind: 'repository-span', path: 'note.txt', contentDigest: spanDigest, startLine: 1, endLine: 2 },
    createdAtGeneration: 1,
  }));
  const cRepoNone = rehydrate.inspectExactResolutionV2(pRepo, {});
  check(cRepoNone.resolvable === false && cRepoNone.mode === 'exact-repository-source'
    && cRepoNone.requiresExternalSource === true, 'repo page without authority is not resolvable');
  const repoSrc = repoSource.createRepositoryExactSourceV2({ rootDir: fixtureDir });
  const cRepoGood = rehydrate.inspectExactResolutionV2(pRepo, { repositorySource: repoSrc });
  check(cRepoGood.resolvable === true, 'repo page with authority is resolvable');
  check(rehydratedPage(root, pRepo, { repositorySource: repoSrc }).verified === true, 'repo page rehydrates with authority');

  // Artifact binding page: same capability tracking.
  const artBytes = Buffer.from('H1 artifact bytes v1');
  fs.writeFileSync(path.join(fixtureDir, 'a.bin'), artBytes);
  const pArt = putPage(root, page.createContextPageV2({
    kind: 'other', namespace: clone(NS_H), sourceKind: 'agent', sourceRefs: ['agent:note:h1'],
    mutability: 'immutable', sourceSeqs: [],
    sourceBinding: { kind: 'artifact', artifactId: 'file:a.bin', contentDigest: sha256(artBytes) },
    createdAtGeneration: 1,
  }));
  const cArtNone = rehydrate.inspectExactResolutionV2(pArt, {});
  check(cArtNone.resolvable === false && cArtNone.mode === 'exact-artifact-source', 'artifact page without authority is not resolvable');
  const artSrc = repoSource.createArtifactExactSourceV2({ rootDir: fixtureDir });
  check(rehydrate.inspectExactResolutionV2(pArt, { artifactSource: artSrc }).resolvable === true, 'artifact page with authority is resolvable');
  check(rehydratedPage(root, pArt, { artifactSource: artSrc }).verified === true, 'artifact page rehydrates with authority');

  // Invalid page: never resolvable, never a mode.
  const cInvalid = rehydrate.inspectExactResolutionV2({ not: 'a page' }, {});
  check(cInvalid.resolvable === false && cInvalid.mode === null, 'invalid page has no resolution mode');
  throwsWithCode(() => rehydrate.inspectExactResolutionV2(pInline, { bogusSource: {} }),
    'context-rehydration-unknown-field', 'inspector is closed-world on sources');

  // H1.5: advisory metadata can never contribute to resolvability.
  const pGloss = page.createContextPageV2({
    kind: 'requirement', namespace: clone(NS_H), sourceKind: 'user', sourceRefs: ['session-event:3'],
    mutability: 'immutable', sourceSeqs: [3], exactText: 'H1 gloss trap fixture.',
    semanticGloss: 'a perfect gloss that must never count as backing',
    createdAtGeneration: 1,
  });
  const cGloss = rehydrate.inspectExactResolutionV2(pGloss, {});
  check(JSON.stringify(cGloss) === JSON.stringify(rehydrate.inspectExactResolutionV2(
    page.createContextPageV2({
      kind: 'requirement', namespace: clone(NS_H), sourceKind: 'user', sourceRefs: ['session-event:3'],
      mutability: 'immutable', sourceSeqs: [3], exactText: 'H1 gloss trap fixture.', createdAtGeneration: 1,
    }), {})), 'advisory gloss cannot change resolvability');

  // Inspector purity: works on a never-persisted page, reads nothing.
  const unpersisted = page.createContextPageV2({
    kind: 'conversation', namespace: clone(NS_H), sourceKind: 'user', sourceRefs: ['session-event:9'],
    mutability: 'immutable', sourceSeqs: [9], exactText: 'never persisted anywhere.', createdAtGeneration: 1,
  });
  const cPure = rehydrate.inspectExactResolutionV2(unpersisted, {});
  check(cPure.resolvable === true && cPure.mode === 'durable-inline', 'inspector is pure: no store, no contextRoot, no reads');

  // B04 handoff partition: durable modes need nothing external; source
  // modes always do. The stored flag alone never decides.
  for (const mode of rehydrate.EXACT_RESOLUTION_MODES) {
    check(['durable-inline', 'durable-blob', 'exact-session-source', 'exact-repository-source', 'exact-artifact-source'].includes(mode),
      'mode is in the frozen world: ' + mode);
  }
  check(cInline.requiresExternalSource === false && cBlob.requiresExternalSource === false
    && cSessGood.requiresExternalSource === true && cRepoGood.requiresExternalSource === true
    && rehydrate.inspectExactResolutionV2(pArt, { artifactSource: artSrc }).requiresExternalSource === true,
    'B04 partition: durable vs source-resolvable is explicit, flag alone decides nothing');
}

// ── H2: ARTIFACT AUTHORITY DOMAIN ────────────────────────────────────
section('H2 ARTIFACT AUTHORITY DOMAIN');
{
  const domainDir = makeRoot('h2domain');
  const outsideDir = makeRoot('h2outside');
  const goodBytes = Buffer.concat([Buffer.from('H2 authorized artifact\n'), crypto.randomBytes(48)]);
  fs.writeFileSync(path.join(domainDir, 'good.bin'), goodBytes);
  const outsideBytes = Buffer.concat([Buffer.from('H2 OUTSIDE bytes\n'), crypto.randomBytes(48)]);
  fs.writeFileSync(path.join(outsideDir, 'secret.bin'), outsideBytes);

  const root = contextRootFor('TASK-B03H-A', 'artifact-sec');
  function artifactPage(artifactId, digest) {
    return putPage(root, page.createContextPageV2({
      kind: 'other', namespace: clone(NS_H), sourceKind: 'agent', sourceRefs: ['agent:note:h2'],
      mutability: 'immutable', sourceSeqs: [],
      sourceBinding: { kind: 'artifact', artifactId, contentDigest: digest },
      createdAtGeneration: 1,
    }));
  }
  const src = repoSource.createArtifactExactSourceV2({ rootDir: domainDir });
  check(src.authorityDomain === domainDir, 'file-backed artifact source exposes its authorized domain');

  // Valid artifact in the allowed root passes.
  const pGood = artifactPage('file:good.bin', sha256(goodBytes));
  const rGood = rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pGood.id, expectedNamespace: clone(NS_H), artifactSource: src,
  });
  check(rGood.verified === true && rGood.exactBytes.equals(goodBytes), 'valid artifact in allowed root passes');

  // Wrong namespace refuses BEFORE any adapter read.
  let adapterCalled = false;
  const countingSrc = { kind: 'artifact-exact-source', readArtifactBytes: () => { adapterCalled = true; return goodBytes; } };
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pGood.id, expectedNamespace: clone(NS_OTHER), artifactSource: countingSrc,
  }), 'context-rehydration-namespace-mismatch', 'wrong namespace refuses');
  check(adapterCalled === false, 'namespace is proven before bytes: adapter never read');

  // Traversal refuses.
  const pTrav = artifactPage('file:../h2outside-' + process.pid + '/secret.bin', sha256(outsideBytes));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pTrav.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', '../ traversal refuses');

  // Absolute outside-root path refuses.
  const pAbs = artifactPage('file:' + path.join(outsideDir, 'secret.bin'), sha256(outsideBytes));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pAbs.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', 'absolute outside-root path refuses');

  // Symlink file escape refuses even though the digest matches the outside bytes.
  fs.symlinkSync(path.join(outsideDir, 'secret.bin'), path.join(domainDir, 'link.bin'));
  const pLink = artifactPage('file:link.bin', sha256(outsideBytes));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pLink.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', 'symlink file escape refuses (digest match does not authorize)');

  // Symlink directory escape refuses.
  fs.symlinkSync(outsideDir, path.join(domainDir, 'extdir'));
  const pDirLink = artifactPage('file:extdir/secret.bin', sha256(outsideBytes));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pDirLink.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', 'symlink directory escape refuses');

  // Alternate spelling with redundant segments refuses at the lexical layer.
  const pSpell = artifactPage('file:sub//good.bin', sha256(goodBytes));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pSpell.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', 'non-canonical spelling refuses');

  // Correct path, wrong hash: source-mismatch (identity, not bytes, decides).
  const pWrongHash = artifactPage('file:good.bin', '0'.repeat(64));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pWrongHash.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', 'correct path with wrong hash refuses');

  // Missing artifact: source-missing.
  const pMissing = artifactPage('file:absent.bin', '1'.repeat(64));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pMissing.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-missing', 'missing artifact refuses as source-missing');

  // Mutated artifact: source-mismatch.
  fs.writeFileSync(path.join(domainDir, 'flip.bin'), Buffer.from('H2 flip v1'));
  const pFlip = artifactPage('file:flip.bin', sha256(Buffer.from('H2 flip v1')));
  fs.writeFileSync(path.join(domainDir, 'flip.bin'), Buffer.from('H2 flip v2 MUTATED'));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pFlip.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-mismatch', 'mutated artifact refuses');

  // Non-file-bound identity with a file-backed adapter: no read primitive abuse.
  const pNonFile = artifactPage('run:artifact-99', sha256(goodBytes));
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pNonFile.id, expectedNamespace: clone(NS_H), artifactSource: src,
  }), 'context-rehydration-source-missing', 'non-file identity is not resolved by the file adapter');

  // Explicit controller-provided capability still verifies identity + namespace.
  const capSrc = repoSource.createArtifactExactSourceV2({ readArtifact: () => goodBytes });
  const pCap = artifactPage('cap:custom-1', sha256(goodBytes));
  const rCap = rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pCap.id, expectedNamespace: clone(NS_H), artifactSource: capSrc,
  });
  check(rCap.verified === true && rCap.exactBytes.equals(goodBytes), 'controller capability resolves with digest proof');
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: root, pageId: pCap.id, expectedNamespace: clone(NS_OTHER), artifactSource: capSrc,
  }), 'context-rehydration-namespace-mismatch', 'capability path still enforces namespace first');

  // Repository span shares the containment primitive: symlinked span refuses.
  const repoRoot2 = contextRootFor('TASK-B03H-A', 'repo-sec');
  const repoDir = makeRoot('h2repo');
  fs.writeFileSync(path.join(repoDir, 'real.txt'), 'alpha\nbeta\n');
  fs.symlinkSync(path.join(outsideDir, 'secret.bin'), path.join(repoDir, 'evil.txt'));
  const pEvilSpan = putPage(repoRoot2, page.createContextPageV2({
    kind: 'repo-span', namespace: clone(NS_H), sourceKind: 'repository', sourceRefs: ['repo:HEAD:h2'],
    mutability: 'immutable', sourceSeqs: [],
    sourceBinding: { kind: 'repository-span', path: 'evil.txt', contentDigest: sha256(outsideBytes.toString('utf8').split('\n').slice(0, 2).join('\n')), startLine: 1, endLine: 2 },
    createdAtGeneration: 1,
  }));
  const repoSrc = repoSource.createRepositoryExactSourceV2({ rootDir: repoDir });
  check(repoSrc.authorityDomain === repoDir, 'repository source exposes its authorized domain');
  throwsWithCode(() => rehydrate.rehydrateContextPageV2({
    contextRoot: repoRoot2, pageId: pEvilSpan.id, expectedNamespace: clone(NS_H), repositorySource: repoSrc,
  }), 'context-rehydration-source-mismatch', 'symlinked repository span refuses');
}

// ── H3: MEDIA-TYPE DETERMINISM ───────────────────────────────────────
section('H3 MEDIA DETERMINISM');
{
  const root = contextRootFor('TASK-B03H-A', 'media');

  // Binary blob: same mediaType across repeated reads.
  const binBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(64), Buffer.from([0xff, 0xfe])]);
  const binBranded = store.createPersistableExactBytesV2({ binary: binBytes, artifactId: 'h3:bin' });
  const binBlob = store.putBlobV2(root, binBranded);
  const pBin = putPage(root, page.createContextPageV2({
    kind: 'other', namespace: clone(NS_H), sourceKind: 'agent', sourceRefs: ['agent:note:h3'],
    mutability: 'immutable', sourceSeqs: [70], exactBlobRef: binBlob.blobRef, createdAtGeneration: 1,
  }));
  const seen = new Set();
  for (let i = 0; i < 3; i += 1) {
    const r = rehydratedPage(root, pBin);
    check(r.mediaType === 'binary' && r.exactBytes.equals(binBytes), 'binary repeat read ' + i + ' is byte-exact');
    seen.add(r.mediaType + ':' + r.sourceRoute + ':' + r.contentHash);
  }
  check(seen.size === 1, 'binary classification is deterministic across reads');

  // mtime changes cannot change classification.
  const blobPath = path.join(root, 'blobs', binBlob.digest.slice(0, 2), binBlob.digest + '.blob');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(blobPath, past, past);
  const rTouched = rehydratedPage(root, pBin);
  check(rTouched.mediaType === 'binary' && rTouched.contentHash === pBin.contentHash, 'mtime shift cannot change media type');

  // UTF-8 boundary fixtures via the blob route.
  function blobPageFor(bytesOrText, tag) {
    const put = store.putBlobV2(root, bytesOrText);
    return putPage(root, page.createContextPageV2({
      kind: 'verification', namespace: clone(NS_H), sourceKind: 'verification', sourceRefs: ['test-run:' + tag],
      mutability: 'immutable', sourceSeqs: [71], exactBlobRef: put.blobRef, createdAtGeneration: 1,
    }));
  }
  const pMulti = blobPageFor('café — naïve ✓\nplain ascii line\n', 'h3multi');
  const rMulti = rehydratedPage(root, pMulti);
  check(rMulti.mediaType === 'text', 'valid multibyte UTF-8 stays text');

  const pLone = blobPageFor(store.createPersistableExactBytesV2({ binary: Buffer.from([0x61, 0x80, 0x62]), artifactId: 'h3:lone' }), 'h3lone');
  check(rehydratedPage(root, pLone).mediaType === 'binary', 'lone continuation byte is binary, never coerced');

  const pOverlong = blobPageFor(store.createPersistableExactBytesV2({ binary: Buffer.from([0xc0, 0xaf]), artifactId: 'h3:overlong' }), 'h3overlong');
  check(rehydratedPage(root, pOverlong).mediaType === 'binary', 'overlong encoding is binary (strict decoder)');

  // Long word run: conservative text-to-binary fallback, stable.
  const runBytes = Buffer.from('A'.repeat(5000), 'utf8');
  const pRun = blobPageFor(store.createPersistableExactBytesV2({ binary: runBytes, artifactId: 'h3:run' }), 'h3run');
  const rRunA = rehydratedPage(root, pRun);
  const rRunB = rehydratedPage(root, pRun);
  check(rRunA.mediaType === 'binary' && rRunB.mediaType === 'binary', 'long-run bytes fall back to binary deterministically');
  check(rRunA.exactBytes.equals(runBytes), 'fallback preserves exact bytes');

  // Decodable but not persistable (unredacted secret shape): fail closed,
  // never silently served as either route.
  const leaky = store.createPersistableExactBytesV2({ binary: Buffer.from('password=hunter2-test-secret-AA', 'utf8'), artifactId: 'h3:leak' });
  const pLeak = blobPageFor(leaky, 'h3leak');
  throwsWithCode(() => rehydratedPage(root, pLeak),
    'context-rehydration-media-type-invalid', 'non-persistable text fails closed as media-type-invalid');
}

console.log('\nB03H: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
