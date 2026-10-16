#!/usr/bin/env node
'use strict';
// A5.4: build the issuer-private credentials file for the isolated dev
// instance from an EXISTING OPENCODE_API_KEY. Order: the process environment
// first, then a single `KEY=value` line of an env file. The env file is
// PARSED, never sourced or executed; only the OPENCODE_API_KEY line is read.
// The key is never printed, logged or passed as an argument. Writing the file
// is not authorization to spend: both operator gates still apply.
//
//   node scripts/Prepare-NativeOpenCodeGoCredentials.cjs --out DIR [--env-file F]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CRED_REF = 'credential://connections/conn-opencode-go-native';
const NAME = 'OPENCODE_API_KEY';

function fromEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m || m[1] !== NAME) continue;
    if (found !== null) return { error: NAME + ' is defined more than once in the env file' };
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    found = v;
  }
  return found === null ? null : { value: found };
}

function validKey(v) {
  return typeof v === 'string' && v.length >= 16 && v.length <= 512 && /^[\x21-\x7e]+$/.test(v);
}

function run(argv, env, log) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = arg('--out');
  if (!out) { log('--out DIR is required (the isolated instance directory)'); return 2; }
  const dir = path.resolve(out);
  if (/(^|\/)\.nexus\/?$/.test(dir) || /production/.test(dir)) { log('refusing a production-looking directory'); return 2; }
  let key = null; let source = null;
  if (typeof env[NAME] === 'string' && env[NAME] !== '') { key = env[NAME]; source = 'process environment'; }
  else {
    const file = arg('--env-file') || path.join(path.resolve(__dirname, '..'), '.env');
    const r = fromEnvFile(file);
    if (r && r.error) { log(r.error); return 1; }
    if (r) { key = r.value; source = 'env file ' + file + ' (parsed, not executed)'; }
  }
  if (key === null) { log(NAME + ' not found in the environment or the env file'); return 1; }
  if (!validKey(key)) { log(NAME + ' was found but is not a plausible token (length/charset); nothing written'); return 1; }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const target = path.join(dir, 'credentials.json');
  const tmp = path.join(dir, '.credentials.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ [CRED_REF]: key }), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  log('key detected via ' + source + '; length ' + key.length + ' (value not shown)');
  log('wrote ' + target + ' (0600) under ' + CRED_REF);
  log('this is NOT authorization: route verification and nexus-broker authorize-live are still required');
  return 0;
}

module.exports = { run, CRED_REF };
if (require.main === module) process.exit(run(process.argv.slice(2), process.env, console.log));
