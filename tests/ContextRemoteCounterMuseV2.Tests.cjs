'use strict';
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const remote = require(path.join(repoRoot, 'config', 'ContextRemoteCounterMuseV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
function mockTransport(handler) {
  const calls = [];
  return {
    calls,
    postJson: async (req) => {
      calls.push({ hostname: req.hostname, reqPath: req.reqPath, bodyJson: req.bodyJson });
      return handler(req, calls.length);
    },
  };
}
const okCount = (n) => ({ status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: n }) });
const DESCRIPTOR = { schemaVersion: 1, provider: 'meta-model-api', model: 'muse-spark-1.3-contributor', endpoint: { host: 'api.meta.ai', countPath: '/v1/responses/input_tokens', responsesPath: '/v1/responses' }, fingerprint: 'meta-muse-input-tokens-api-v1', revision: 'meta-muse-input-tokens-api-v1', source: 'meta-official-count-endpoint', verified: true };
const counterWith = (handler, extra) => remote.createMuseRemoteCounterV2(Object.assign({ descriptor: DESCRIPTOR, apiKey: 'test-key-redacted', transport: mockTransport(handler) }, extra || {}));
section('C08M-RC-1 DESCRIPTOR AUTHORITY');
{
  check(remote.REMOTE_FINGERPRINT_V1 === 'meta-muse-input-tokens-api-v1', 'fingerprint names the remote contract (not a local artifact)');
  check(remote.COUNT_PATH_V1 === '/v1/responses/input_tokens', 'count path pinned');
  const d = remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor' });
  check(d !== null && d.verified === true && d.fingerprint === remote.REMOTE_FINGERPRINT_V1, 'exact meta pair resolves verified');
  check(remote.resolveMuseRemoteV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }) === null, 'opencode route unregistered (404 evidence)');
  check(remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3' }) === null, 'non-contributor id not assumed');
  check(remote.resolveMuseRemoteV2({ provider: 'meta-model-api', model: 'muse-spark-1.3-contributor-evil' }) === null, 'near-miss rejected');
  const summary = remote.describeMuseRemoteV2(d);
  check(summary.valid === true && JSON.stringify(summary).indexOf('test-key') === -1, 'secret-safe summary');
}
section('C08M-RC-2 RESPONSE CLASSIFICATION');
{
  const cases = [
    [{ status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens', input_tokens: 69 }) }, true, null],
    [{ status: 200, bodyText: 'not-json' }, false, 'malformed'],
    [{ status: 200, bodyText: JSON.stringify({ object: 'response.input_tokens' }) }, false, 'malformed'],
    [{ status: 200, bodyText: JSON.stringify({ input_tokens: -3 }) }, false, 'malformed'],
    [{ status: 200, bodyText: JSON.stringify({ input_tokens: 4.5 }) }, false, 'malformed'],
    [{ status: 401, bodyText: '{}' }, false, 'auth'],
    [{ status: 403, bodyText: '{}' }, false, 'auth'],
    [{ status: 404, bodyText: '<html>' }, false, 'unsupported'],
    [{ status: 429, bodyText: '{}' }, false, 'rate-limited'],
    [{ status: 500, bodyText: '{}' }, false, 'transport'],
    [{ status: 400, bodyText: JSON.stringify({ error: { message: "Model 'x' not found", code: 'model_not_found' } }) }, false, 'model-unsupported'],
    [{ status: 400, bodyText: JSON.stringify({ error: { message: 'bad request', code: 'invalid' } }) }, false, 'request-invalid'],
  ];
  for (const triple of cases) {
    const c = remote.classifyCountResponseV2(triple[0].status, triple[0].bodyText);
    check(c.ok === triple[1] && (triple[1] === true || c.kind === triple[2]), 'classify ' + triple[0].status + ' -> ' + (triple[1] ? 'ok' : triple[2]));
  }
  check(remote.classifyCountResponseV2(null, '').ok === false, 'non-response is transport failure');
}
section('C08M-RC-3 COUNT CALLS (mocked protocol)');
{
  (async () => {
    const transport = mockTransport(() => okCount(7));
    const ctr = remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'k', transport });
    const counts = await ctr.countTextsV2(['a', 'b', 'a']);
    check(JSON.stringify(counts) === JSON.stringify([7, 7, 7]), 'order preserved with dedupe');
    check(transport.calls.length === 2, 'each unique text counted once (' + transport.calls.length + ' calls)');
    check(transport.calls[0].hostname === 'api.meta.ai' && transport.calls[0].reqPath === '/v1/responses/input_tokens', 'exact endpoint bound');
    const sent = JSON.parse(transport.calls[0].bodyJson);
    check(sent.model === 'muse-spark-1.3-contributor' && sent.input === 'a', 'exact contributor model id sent');
    const payload = await ctr.countPayloadV2({ instructions: 'sys', input: [{ role: 'user', content: 'hi' }] });
    check(payload.tokens === 7, 'whole-payload count');
    const payloadSent = JSON.parse(transport.calls[2].bodyJson);
    check(payloadSent.instructions === 'sys' && Array.isArray(payloadSent.input) && payloadSent.tools === undefined, 'structured shape counted (no text flattening)');
    let threw = false;
    try {
      await remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'k', transport: mockTransport(() => ({ status: 401, bodyText: '{}' })) }).countTextsV2(['x']);
    } catch (error) {
      threw = String((error && error.message) || error).indexOf('counter-unavailable') !== -1;
    }
    check(threw === true, 'auth failure maps to counter-unavailable');
    let threwTimeout = false;
    try {
      await remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'k', transport: { postJson: async () => { throw new Error('socket hang up'); } } }).countTextsV2(['x']);
    } catch (error) {
      threwTimeout = true;
    }
    check(threwTimeout === true, 'network failure fails closed');
    let threwKey = false;
    try {
      remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: '' });
    } catch (error) {
      threwKey = true;
    }
    check(threwKey === true, 'missing credential refuses counter creation');
    console.log(String.fromCharCode(10) + 'ContextRemoteCounterMuseV2 suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
section('C08M-RC-4 MEMO COUNTER (fail-closed sync face)');
{
  const transport = mockTransport(() => okCount(1));
  const ctr = remote.createMuseRemoteCounterV2({ descriptor: DESCRIPTOR, apiKey: 'k', transport });
  const memo = ctr.buildMemoCounterV2(new Map([['known', 5]]));
  check(memo.tokenizerFingerprint === remote.REMOTE_FINGERPRINT_V1, 'memo speaks for the remote contract');
  check(memo.countText('known') === 5, 'memo hit exact');
  let threwMiss = false;
  try { memo.countText('unknown-text'); } catch (error) {
    threwMiss = String((error && error.message) || error).indexOf('memo-miss') !== -1;
  }
  check(threwMiss === true, 'memo miss fails closed (never guessed)');
  let threwType = false;
  try { memo.countText(42); } catch (error) { threwType = true; }
  check(threwType === true, 'non-string rejected');
}
