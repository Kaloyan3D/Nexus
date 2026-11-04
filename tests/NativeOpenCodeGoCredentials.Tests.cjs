'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, CRED_REF } = require('../scripts/Prepare-NativeOpenCodeGoCredentials.cjs');
let n = 0;
const ok = (l, f) => { f(); n++; console.log('PASS: ' + l); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogc-'));
const KEY = 'sk-test-0123456789abcdef0123456789';

ok('env var wins; file is 0600; nothing printed contains the key', () => {
  const d = tmp(); const logs = [];
  assert.equal(run(['--out', d], { OPENCODE_API_KEY: KEY }, (l) => logs.push(l)), 0);
  assert.equal(fs.statSync(path.join(d, 'credentials.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'credentials.json'), 'utf8')), { [CRED_REF]: KEY });
  assert.ok(!logs.join('\n').includes(KEY));
});
ok('env file is parsed, not executed; only the one line is used', () => {
  const d = tmp(); const f = path.join(d, 'e.env'); const marker = path.join(d, 'pwned');
  fs.writeFileSync(f, `OTHER=$(touch ${marker})\n# c\nexport OPENCODE_API_KEY="${KEY}"\nDEEPSEEK_API_KEY=zzz\n`);
  const logs = [];
  assert.equal(run(['--out', path.join(d, 'out'), '--env-file', f], {}, (l) => logs.push(l)), 0);
  assert.ok(!fs.existsSync(marker));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'out', 'credentials.json'), 'utf8'))[CRED_REF], KEY);
  assert.ok(!logs.join('\n').includes(KEY) && !logs.join('\n').includes('zzz'));
});
ok('missing, duplicate and implausible keys write nothing', () => {
  for (const content of ['A=1\n', `OPENCODE_API_KEY=${KEY}\nOPENCODE_API_KEY=${KEY}\n`, 'OPENCODE_API_KEY=short\n', 'OPENCODE_API_KEY=has space inside the key value\n']) {
    const d = tmp(); const f = path.join(d, 'e.env'); fs.writeFileSync(f, content);
    assert.notEqual(run(['--out', path.join(d, 'o'), '--env-file', f], {}, () => {}), 0);
    assert.ok(!fs.existsSync(path.join(d, 'o', 'credentials.json')));
  }
});
ok('production-looking output directories are refused', () => {
  assert.equal(run(['--out', path.join(os.homedir(), '.nexus')], { OPENCODE_API_KEY: KEY }, () => {}), 2);
});
console.log('SUITE RESULT: PASS ' + n + ' | FAIL 0 | total ' + n);
