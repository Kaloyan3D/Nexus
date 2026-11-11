'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const helper = path.join(__dirname, '../../scripts/Test-SuiteProcess.cjs');

function run(seconds, executable, ...args) {
  const result = spawnSync(process.execPath, [helper, String(seconds), executable, ...args], {
    encoding: 'utf8', timeout: 12000,
  });
  assert.ifError(result.error);
  return result;
}
let result = run(5, process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'two words', '', 'last');
assert.equal(result.status, 0);
assert.equal(result.stdout.trim(), '["two words","","last"]');
result = run(5, process.execPath, '-e', 'process.exitCode=124');
assert.equal(result.status, 124);
assert.doesNotMatch(result.stdout, /PROCESS INCOMPLETE/);
result = run(5, path.join(__dirname, 'missing-fixture-executable'));
assert.notEqual(result.status, 0);
assert.match(result.stdout, /PROCESS INCOMPLETE/);
result = run(1, process.execPath, '-e', 'console.log("stage started"); setInterval(() => {}, 1000)');
assert.equal(result.status, 124);
assert.match(result.stdout, /stage started/);
assert.match(result.stdout, /PROCESS INCOMPLETE: deadline exceeded/);
console.log('PASS: watchdog preserves argv, ordinary exit codes, startup errors and bounded progress');
