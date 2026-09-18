'use strict';
/**
 * ContextCompactionXProc.Tests.cjs - cross-process apply-lock regression.
 *
 * Two SEPARATE Node processes race for one frozen operation's apply lock
 * through the REAL production CLIs (freeze-operation, acquire/release-
 * apply-lock). Exactly one physical owner may hold the lock; the loser is
 * refused and must reconcile, never append. Mutation property: with the
 * lock acquisition removed from the path, both processes would acquire and
 * this test fails.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'scripts', 'ContextLifecycleCli.ps1');
const TASK_CLI = path.join(repoRoot, 'scripts', 'Task.ps1');
const WORKER = path.join(__dirname, 'ContextCompactionXProc.Worker.cjs');

let passed = 0;
function pass(name) { passed += 1; console.log('PASS: ' + name); }

function pwsh(script, args, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xproc-'));
  const payloadFile = path.join(dir, 'p.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  const out = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args).concat(['-PayloadFile', payloadFile]), { encoding: 'utf8', timeout: 120000 });
  const text = out.trim();
  return text === '' ? null : JSON.parse(text);
}
function cli(taskId, action, payload) { return pwsh(CLI, ['-Action', action, '-TaskId', taskId], payload); }

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xproc-ws-'));
  try {
    const task = pwsh(TASK_CLI, ['-Action', 'create-task'], { workspace, description: 'xproc fixture', reviewRequested: false, engine: 'dual' });
    const taskId = task.taskId;
    const taskInstanceId = task.taskInstanceId;
    const sessionId = 'sess-xproc-1';
    const evidence = { schemaVersion: 2, attempt: 0, taskInstanceId, acceptanceCriteria: [], verification: [{ name: 'v', kind: 'verify', status: 'PASS' }], scopePass: true };
    fs.mkdirSync(path.join(workspace, '.ai-harness', 'runs', taskId), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.ai-harness', 'runs', taskId, 'evidence.json'), JSON.stringify(evidence));
    pwsh(TASK_CLI, ['-Action', 'complete', '-TaskId', taskId], { workspace, taskInstanceId });
    cli(taskId, 'transition', { workspace, taskInstanceId, to: 'eligible', reason: 'xproc', sessionId });
    const cp = cli(taskId, 'build-checkpoint', { workspace, taskInstanceId, continuityUserText: 'u', continuityAssistantText: 'a' });
    cli(taskId, 'transition', { workspace, taskInstanceId, to: 'checkpoint-ready', reason: 'xproc', sessionId, checkpointPath: cp.path });
    const op = cli(taskId, 'freeze-operation', { workspace, taskInstanceId, sessionId, replacementStart: 0, replacementEnd: 1, sourceEventSeqs: [0, 1], segments: [{ start: 0, end: 1, sourceEventSeqs: [0, 1] }], completionBoundarySeq: 5, checkpointPath: cp.path });
    assert.ok(op && op.operationId, 'production freeze persists the operation');
    pass('production freeze-operation persists one operation');
    const runWorker = (tag, holdMs) => new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, workspace, taskId, taskInstanceId, sessionId, op.operationId, String(holdMs), tag], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ tag, code, out }));
    });
    const a = runWorker('A', 4000);
    await new Promise((r) => setTimeout(r, 800));
    const b = await runWorker('B', 0);
    const ra = await a;
    assert.equal(ra.code, 0, 'winner completes while holding the lock');
    pass('exactly one process physically owns the apply transaction');
    assert.equal(b.code, 2, 'loser is refused while the lock is held');
    assert.ok(b.out.includes('held-by-live-owner'), 'loser observes live-owner refusal');
    pass('second process reconciles instead of appending (no duplicate writer)');
    const c = await runWorker('C', 0);
    assert.equal(c.code, 0, 'lock is acquirable again after release');
    pass('abandon-safe release restores the lock (no deadlock)');
    const lockPath = path.join(workspace, '.ai-harness', 'runs', taskId, 'context-compaction-apply.lock');
    assert.ok(!fs.existsSync(lockPath), 'no lock residue after release');
    pass('lock leaves no residue on the happy path');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log('RESULT: ' + passed + ' cross-process assertions passed.');
}
main().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1); });
