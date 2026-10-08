'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const regModule = require(path.join(repoRoot, 'config', 'ContextTokenizerRegistryV2.cjs'));
const capModule = require(path.join(repoRoot, 'config', 'ContextModelCapabilityV2.cjs'));
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function waitForGo(goFile) {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    if (fs.existsSync(goFile)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error('xproc barrier timeout');
}
function main() {
  const out = arg('--out');
  const write = (value) => {
    fs.writeFileSync(out, JSON.stringify(value));
  };
  try {
    const inFile = arg('--in');
    const goFile = arg('--go');
    waitForGo(goFile);
    const fixture = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const counter = capModule.createProductionCounterFromFingerprintV2(fixture.fingerprint);
    if (counter.tokenizerFingerprint !== fixture.fingerprint) {
      write({ ok: false, error: 'xproc-fingerprint-mismatch' });
      return;
    }
    const counts = fixture.texts.map((text) => counter.countText(text));
    const idSamples = fixture.texts.map((text) => regModule.encodeDeepseekV4V2(text).slice(0, 8));
    const frames = fixture.convos.map((convo) => {
      const framed = regModule.frameDeepseekChatV2({
        systemTexts: convo.systems,
        turnText: convo.turn,
        generationPrime: convo.prime,
      });
      return { tokens: framed.tokens, markerTokens: framed.markerTokens, ids: Array.from(framed.ids).slice(0, 12) };
    });
    const descriptor = regModule.resolveProductionTokenizerV2({ provider: fixture.route.provider, model: fixture.route.model });
    write({
      ok: true,
      fingerprint: counter.tokenizerFingerprint,
      counts,
      idSamples: idSamples.map((ids) => Array.from(ids)),
      frames,
      descriptorValid: descriptor !== null && descriptor.verified === true,
    });
  } catch (error) {
    try {
      write({ ok: false, error: 'xproc-failed:' + String((error && error.message) || error).slice(0, 200) });
    } catch (ignored) {
      void ignored;
    }
  }
}
main();
