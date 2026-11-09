'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSuites } = require('../../tests/lib/SuiteLane.cjs');

const source = fs.readFileSync(require.resolve('../../scripts/Test-Harness.ps1'), 'utf8');
const inventory = parseSuites(source).filter(suite => suite.lane === 'production');
const security = inventory.find(suite => suite.completionMarker);
assert(security, 'required host proof is in the production inventory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ci-report-'));
const marker = security.completionMarker;
const report = {
  schemaVersion: 1, exitCode: 0, result: 'PASS', totalPassed: 0, totalFailed: 0,
  suiteCount: inventory.length, statusCounts: { PASS: inventory.length, FAIL: 0, SKIP: 0, NOT_RUN: 0, INCOMPLETE: 0 },
  suites: inventory.map(({ name, script }) => ({
    name, script, exitCode: 0, result: 'PASS', failed: 0, skipEvidence: [], completionVerified: true,
    command: 'fixture', startedAtUtc: '2026-01-01T00:00:00Z', finishedAtUtc: '2026-01-01T00:00:01Z', durationMs: 1000,
  })),
};
const securityRow = value => value.suites.find(suite => suite.name === security.name);
const cases = [
  ['executed with no assertion counters', true],
  ['required report missing', false, () => null],
  ['raw report missing', false, undefined, null],
  ['truncated raw report', false, undefined, 'truncated'],
  ['startup failure', false, value => Object.assign(value, { exitCode: 1, result: 'FAIL' })],
  ['required SKIP despite zero exit', false, value => { securityRow(value).result = 'SKIP'; }],
  ['zero-exit skip hidden in raw log', false, undefined, marker + '\nSKIP: no host'],
  ['zero-exit assertion failure', false, value => { securityRow(value).failed = 1; }],
  ['zero-exit failure hidden in raw log', false, undefined, marker + '\nFAIL: bypass'],
  ['not run', false, value => { securityRow(value).result = 'NOT_RUN'; }],
  ['incomplete', false, value => { securityRow(value).finishedAtUtc = null; }],
  ['omitted row and adjusted counts', false, value => { value.suites.pop(); value.suiteCount--; value.statusCounts.PASS--; }],
  ['substituted required suite', false, value => { securityRow(value).name = 'other'; }],
  ['missing proof', false, undefined, 'no completion record'],
  ['duplicate proof', false, undefined, marker + '\n' + marker],
];

try {
  for (const [name, pass, change, raw = marker] of cases) {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const reportPath = path.join(dir, 'report.json');
    const value = structuredClone(report);
    if (change?.(value) !== null) fs.writeFileSync(reportPath, JSON.stringify(value));
    if (raw !== null) {
      const rows = raw === 'truncated' ? inventory.slice(0, -1) : inventory;
      const verdicts = rows.map(suite => '===== RESULT ' + suite.name + ': PASS (exit 0) =====');
      fs.writeFileSync(path.join(dir, 'report.log'), [raw, ...verdicts, ''].join('\n'));
    }
    const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'harness-summary.ps1'), '-ReportPath', reportPath],
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') } });
    if (result.error) throw result.error;
    assert.notEqual(result.status, null, name + ' must return a process status');
    assert.equal(result.status === 0, pass, name + ': ' + result.stderr);
    console.log('PASS: report validator ' + name);
  }
  const shardInventory = shard => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'harness-inventory.cjs'), 'production', shard],
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const general = shardInventory('general');
  const boundary = shardInventory('boundary');
  assert.deepEqual(boundary, [security]);
  assert.equal(new Set([...general, ...boundary].map(suite => suite.name)).size, inventory.length);
  assert.deepEqual([...general, ...boundary].map(suite => suite.name).sort(), inventory.map(suite => suite.name).sort());
  for (const [shard, rows, proof, expected] of [
    ['general', general, '', true],
    ['boundary', boundary, marker, true],
    ['boundary', boundary, '', false],
    ['general', inventory, marker, false],
    ['full', general, '', false],
    ['boundary', general, '', false],
  ]) {
    const dir = fs.mkdtempSync(path.join(root, 'shard-'));
    const reportPath = path.join(dir, 'report.json');
    const value = structuredClone(report);
    value.suites = rows.map(row => value.suites.find(suite => suite.name === row.name));
    value.suiteCount = rows.length;
    value.statusCounts.PASS = rows.length;
    fs.writeFileSync(reportPath, JSON.stringify(value));
    const verdicts = rows.map(suite => '===== RESULT ' + suite.name + ': PASS (exit 0) =====');
    fs.writeFileSync(path.join(dir, 'report.log'), [proof, ...verdicts, ''].join('\n'));
    const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'harness-summary.ps1'),
      '-ReportPath', reportPath, '-ProductionShard', shard], {
      encoding: 'utf8', timeout: 15000, env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, null);
    assert.equal(result.status === 0, expected, result.stderr);
  }
  console.log('PASS: production shard inventories are complete, disjoint, and require boundary proof');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
