'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const repoRoot = path.resolve(__dirname, '..');
const cert = require(path.join(repoRoot, 'config', 'ContextAuthorityCertificationV2.cjs'));
const host = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeHostV2.cjs'));
const opencode = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const DIGEST = 'b'.repeat(64);
function identityFixture(overrides) {
  return Object.assign({
    inferenceProvider: 'opencode-go',
    inferenceBaseUrl: 'https://opencode.ai/zen/go/v1',
    inferenceModel: 'muse-spark-1.3-contributor',
    counterProvider: 'meta-model-api',
    counterBaseUrl: 'https://api.meta.ai/v1',
    counterModel: 'muse-spark-1.3-contributor',
    counterFingerprint: 'meta-muse-input-tokens-api-v1',
    contextWindow: 1048576,
    safetyMarginPolicyRevision: host.MARGIN_POLICY_REVISION_V1,
    outputReservePolicyRevision: host.OUTPUT_RESERVE_POLICY_REVISION_V1,
    requestShapeRevision: host.OPENCODE_REQUEST_SHAPE_V1,
    canarySuiteRevision: host.CANARY_SUITE_REVISION_V1,
  }, overrides || {});
}
function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oc01h-')); }
function wipe(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
section('C08H-OC01H-1 PERSIST + RESTART (same process, fresh load)');
{
  const dir = tempDir();
  const first = host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() });
  check(first.state === 'missing' && first.health === 'QUARANTINED', 'no certification starts quarantined');
  const written = cert.certifyOpencodeV2(dir, identityFixture(), DIGEST);
  check(written.status === 'CERTIFIED', 'certification persisted');
  check(typeof written.expiresAtUtc === 'string' && Date.parse(written.expiresAtUtc) > Date.parse(written.certifiedAtUtc), 'expiry after certification');
  const second = host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() });
  check(second.state === 'valid' && second.health === 'HEALTHY', 'reload derives healthy without manual trust');
  check(second.certification.canaryEvidenceDigest === DIGEST, 'evidence digest bound');
  const raw = fs.readFileSync(path.join(dir, 'opencode-muse-certification.json'), 'utf8');
  check(raw.indexOf('sk-') === -1 && raw.indexOf('Bearer') === -1 && raw.indexOf('AUTHORIZATION') === -1, 'no credential material persisted');
  wipe(dir);
}
section('C08H-OC01H-2 CORRUPTION + IDENTITY CHANGES');
{
  const dir = tempDir();
  cert.certifyOpencodeV2(dir, identityFixture(), DIGEST);
  const target = path.join(dir, 'opencode-muse-certification.json');
  const good = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, '{corrupt');
  check(host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() }).state === 'malformed', 'malformed file quarantines');
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, extra: true }));
  check(host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() }).state === 'malformed', 'unknown keys rejected');
  fs.writeFileSync(target, good);
  const variants = [
    [{ inferenceModel: 'other-model' }, 'model change'],
    [{ inferenceProvider: 'other-direct' }, 'provider change'],
    [{ inferenceBaseUrl: 'https://other.example/v1' }, 'base URL change'],
    [{ counterFingerprint: 'other-fp' }, 'counter fingerprint change'],
    [{ requestShapeRevision: 'other-shape' }, 'request-shape revision change'],
    [{ safetyMarginPolicyRevision: 'other-margin' }, 'margin-policy revision change'],
    [{ contextWindow: 8192 }, 'context-window change'],
    [{ canarySuiteRevision: 'other-suite' }, 'canary-suite revision change'],
  ];
  for (const pair of variants) {
    const loaded = host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture(pair[0]) });
    check(loaded.state === 'identity-mismatch' && loaded.health === 'QUARANTINED', pair[1] + ' invalidates');
  }
  wipe(dir);
}
section('C08H-OC01H-3 EXPIRY + DURABLE ANOMALY + RECERTIFY');
{
  const dir = tempDir();
  const past = { now: () => Date.now() - 8 * 24 * 60 * 60 * 1000 };
  cert.certifyOpencodeV2(dir, identityFixture(), DIGEST, past);
  const expired = host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() });
  check(expired.state === 'expired' && expired.health === 'QUARANTINED', 'expired certification quarantines');
  cert.certifyOpencodeV2(dir, identityFixture(), DIGEST);
  check(host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() }).state === 'valid', 'fresh certification restores');
  const revoked = cert.revokeCertificationV2(dir, 'input-over-margin');
  check(revoked.revoked === true, 'anomaly revokes durably');
  check(host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() }).state === 'revoked', 'restart after anomaly stays quarantined');
  cert.certifyOpencodeV2(dir, identityFixture(), 'c'.repeat(64));
  check(host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() }).state === 'valid', 'fresh canary replaces revocation');
  wipe(dir);
}
section('C08H-OC01H-4 CRASH SAFETY + REAL IDENTITY');
{
  const dir = tempDir();
  cert.certifyOpencodeV2(dir, identityFixture(), DIGEST);
  const target = path.join(dir, 'opencode-muse-certification.json');
  const good = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target + '.tmp-orphan-1', '{partial');
  const loaded = host.startupOpencodeAuthorityV2({ storeRoot: dir, expectedIdentity: identityFixture() });
  check(loaded.state === 'valid', 'orphan temp files never promote (target intact)');
  const again = cert.certifyOpencodeV2(dir, identityFixture(), 'd'.repeat(64));
  check(again.canaryEvidenceDigest === 'd'.repeat(64), 'atomic replace succeeds over orphans');
  void good;
  const built = host.currentOpencodeIdentityV2({ installRoot: repoRoot });
  check(built.known === true, 'real repo config yields a known identity');
  check(built.identity.inferenceBaseUrl === 'https://opencode.ai/zen/go/v1', 'opencode base URL from settings');
  check(built.identity.counterBaseUrl === 'https://api.meta.ai/v1', 'meta base URL from settings');
  check(built.identity.contextWindow === 1048576, 'window from model-registry');
  check(built.identity.counterFingerprint === 'meta-muse-input-tokens-api-v1', 'counter fingerprint bound');
  wipe(dir);
}
section('C08H-OC01H-5 TRUE RESTART (fresh OS process, no trust flag)');
{
  const child = require('node:child_process');
  const dir = tempDir();
  const identityFile = path.join(dir, 'identity.json');
  fs.writeFileSync(identityFile, JSON.stringify(identityFixture()));
  const outA = path.join(dir, 'a.json');
  const outB = path.join(dir, 'b.json');
  const worker = path.join(repoRoot, 'tests', 'ContextAuthorityCertificationV2XProc.Worker.cjs');
  const runWorker = (out) => new Promise((resolve) => {
    const proc = child.spawn(process.execPath, [worker, '--store', dir, '--identity', identityFile, '--out', out], { stdio: 'ignore' });
    proc.on('close', resolve);
  });
  runWorker(outA).then(() => {
    let ra = null;
    try { ra = JSON.parse(fs.readFileSync(outA, 'utf8')); } catch (error) { void error; }
    check(ra !== null && ra.ok === true && ra.state === 'missing' && ra.health === 'QUARANTINED', 'fresh process without certification starts quarantined');
    cert.certifyOpencodeV2(dir, identityFixture(), DIGEST);
    return runWorker(outB).then(() => {
      let rb = null;
      try { rb = JSON.parse(fs.readFileSync(outB, 'utf8')); } catch (error) { void error; }
      check(rb !== null && rb.ok === true && rb.state === 'valid' && rb.health === 'HEALTHY', 'fresh process loads certification to healthy (no trust flag)');
      wipe(dir);
      console.log(String.fromCharCode(10) + 'ContextAuthorityCertificationV2 suite: ' + passed + ' passed, ' + failed + ' failed');
      if (failed > 0) process.exitCode = 1;
    });
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
