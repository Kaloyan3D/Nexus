'use strict';
/**
 * ContextCompactionF8GitFacts.Tests.cjs - F8 Git-failure fail-closed.
 *
 * Production-path only: REAL Get-AihContextGitFacts / New-AihContextCheckpoint
 * via pwsh. Forced command failures use a PATH git shim (delegates normal
 * commands, fails the selected one with empty stdout) -- no production
 * simulate-failure variable. No fake object mutation as acceptance proof.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
function check(cond, name) { assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }
function runPs(script, extraEnv) {
  const f = path.join(os.tmpdir(), 'f8t-' + Date.now().toString(36) + Math.random().toString(16).slice(2) + '.ps1');
  fs.writeFileSync(f, script);
  return execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...(extraEnv || {}) } });
}
const HDR = [
  `. '${path.join(repoRoot, 'scripts', 'Common.ps1')}'`,
  `. '${path.join(repoRoot, 'scripts', 'TaskController.ps1')}'`,
  `. '${path.join(repoRoot, 'scripts', 'ContextLifecycle.ps1')}'`,
].join('\n');
function factsOf(ws, extraEnv) {
  const out = runPs(HDR + '\n' + [
    `$f = Get-AihContextGitFacts -Workspace '${ws}'`,
    'Write-Output ("KNOWN=" + [bool]$f.gitKnown)',
    'Write-Output ("REASON=" + [string]$f.gitReason)',
    'Write-Output ("HEAD=" + [string]$f.headCommit)',
    'Write-Output ("CLEAN=" + [string]$f.worktreeClean)',
    'Write-Output ("FILES=" + @($f.changedFiles).Count)',
  ].join('\n'), extraEnv);
  const got = {};
  for (const line of out.trim().split(/\r?\n/)) { const m = /^(KNOWN|REASON|HEAD|CLEAN|FILES)=(.*)$/.exec(line); if (m) got[m[1]] = m[2]; }
  return got;
}
function makeGitRepo(dirty) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'f8repo-'));
  execFileSync('git', ['init', '-q', ws]);
  execFileSync('git', ['-C', ws, 'config', 'user.email', 'f8@example.invalid']);
  execFileSync('git', ['-C', ws, 'config', 'user.name', 'f8']);
  fs.writeFileSync(path.join(ws, 'tracked.txt'), 'v1\n');
  execFileSync('git', ['-C', ws, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', ws, 'commit', '-qm', 'init']);
  if (dirty) fs.writeFileSync(path.join(ws, 'tracked.txt'), 'v2-dirty\n');
  return ws;
}
function makeShimDir(failStatus, failRevParse) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f8shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `REAL_GIT="${realGit}"`,
    failStatus ? 'for a in "$@"; do if [ "$a" = "status" ]; then exit 3; fi; done' : '',
    failRevParse ? 'for a in "$@"; do if [ "$a" = "rev-parse" ]; then exit 4; fi; done' : '',
    'exec "$REAL_GIT" "$@"',
  ].filter(Boolean).join('\n') + '\n');
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}
// 1. non-repository directory -> UNKNOWN.
const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'f8nonrepo-'));
const f1 = factsOf(nonRepo);
check(f1.KNOWN === 'False', 'F8-1: non-repo gitKnown=False (got ' + f1.KNOWN + ')');
check(f1.REASON === 'rev-parse-failed', 'F8-1: reason rev-parse-failed (got ' + f1.REASON + ')');
check(f1.CLEAN === '', 'F8-1: worktreeClean is null, never true');
check(f1.HEAD === '', 'F8-1: no empty HEAD presented as known');
// 2. real clean repo -> KNOWN CLEAN.
const cleanWs = makeGitRepo(false);
const wantHead = execFileSync('git', ['-C', cleanWs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const f2 = factsOf(cleanWs);
check(f2.KNOWN === 'True', 'F8-2: clean repo known');
check(f2.CLEAN === 'True', 'F8-2: clean repo worktreeClean=true');
check(f2.HEAD === wantHead, 'F8-2: headCommit exact');
check(f2.FILES === '0', 'F8-2: changedFiles empty on success');
// 3. real dirty repo -> KNOWN DIRTY.
const dirtyWs = makeGitRepo(true);
const f3 = factsOf(dirtyWs);
check(f3.KNOWN === 'True', 'F8-3: dirty repo known');
check(f3.CLEAN === 'False', 'F8-3: dirty repo worktreeClean=false');
check(Number(f3.FILES) >= 1, 'F8-3: changed files enumerated');
// 4. valid repo + forced status nonzero, empty stdout -> UNKNOWN.
const shimStatus = makeShimDir(true, false);
const f4 = factsOf(cleanWs, { PATH: shimStatus + ':' + process.env.PATH });
check(f4.KNOWN === 'False', 'F8-4: failed status => unknown');
check(f4.REASON === 'status-failed', 'F8-4: reason status-failed (got ' + f4.REASON + ')');
check(f4.CLEAN === '', 'F8-4: failed-empty output is NOT clean');
// 5. forced rev-parse failure -> UNKNOWN.
const shimHead = makeShimDir(false, true);
const f5 = factsOf(cleanWs, { PATH: shimHead + ':' + process.env.PATH });
check(f5.KNOWN === 'False', 'F8-5: failed rev-parse => unknown');
check(f5.REASON === 'rev-parse-failed', 'F8-5: reason rev-parse-failed');
check(f5.HEAD === '', 'F8-5: no HEAD accepted as known');
// 6/7. successful-empty vs failed-empty distinction is covered by F8-2 vs F8-4.
// 8. partial facts: HEAD ok + status failed never yields trusted whole.
check(f4.HEAD !== '' && f4.KNOWN === 'False', 'F8-8: partial facts (HEAD ok, status failed) stay untrusted');
// 9. checkpoint preparation fails closed on UNKNOWN: no checkpoint file.
const out9 = runPs(HDR + '\n' + [
  `$ws = '${nonRepo}'`,
  `$t = New-AihTask -Workspace $ws -Description 'f8 prep' -AcceptanceCriteria @('c1') -Engine 'dual'`,
  '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
  '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 130000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
  '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
  '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
  'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
  '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
  '$threw = $false; $msg = ""',
  'try { [void](New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST) } catch { $threw = $true; $msg = $_.Exception.Message }',
  'Write-Output ("THREW=" + $threw)',
  'Write-Output ("MSG=" + $msg)',
  'Write-Output ("NOFILE=" + (-not (Test-Path -LiteralPath (Join-Path $run "context-checkpoint.json"))))',
].join('\n'));
check(/THREW=True/.test(out9), 'F8-9: checkpoint preparation throws on UNKNOWN');
check(/rev-parse-failed/.test(out9), 'F8-9: machine-safe reason code surfaces');
check(/NOFILE=True/.test(out9), 'F8-9: no checkpoint file created from unknown state');
// 10. controls: (a) pristine clean repo is KNOWN CLEAN; (b) task ledger
// dirties the worktree by design, so a checkpoint there records KNOWN
// DIRTY with exact HEAD (never false-clean, never unknown).
const pristineWs = makeGitRepo(false);
const out10 = runPs(HDR + '\n' + [
  `$ws = '${cleanWs}'`,
  `$pristine = '${pristineWs}'`,
  '$pre = Get-AihContextGitFacts -Workspace $pristine',
  `$t = New-AihTask -Workspace $ws -Description 'f8 ctrl' -AcceptanceCriteria @('c1') -Engine 'dual'`,
  '$TID = $t.taskId; $INST = [string]$t.taskInstanceId',
  '[void](Add-AihContextRootUsage -Workspace $ws -TaskId $TID -TaskInstanceId $INST -EngineRole engineer_normal -Engine dual -UncachedInputTokens 130000 -CacheReadTokens 10000 -OutputTokens 10 -UsageAvailable $true -StepId "1:1" -SessionId s)',
  '$run = Join-Path (Join-Path $ws ".ai-harness/runs") $TID',
  '$ev = [ordered]@{ schemaVersion = 2; attempt = 1; taskInstanceId = $INST; acceptanceCriteria = @([ordered]@{ criterion = "c1"; status = "met"; evidence = "fixture evidence for c1" }); verification = @([ordered]@{ name = "v"; kind = "verify"; status = "PASS"; exitCode = 0; attempt = 1 }); scopePass = $true }',
  'Write-AihAtomicJson (Join-Path $run "evidence.json") $ev',
  '[void](Test-AihTaskCompletion -Workspace $ws -TaskId $TID -TaskInstanceId $INST)',
  'Write-Output ("PRE-KNOWN=" + [bool]$pre.gitKnown)',
  'Write-Output ("PRE-CLEAN=" + [bool]$pre.worktreeClean)',
  '$cp = New-AihContextCheckpoint -Workspace $ws -TaskId $TID -TaskInstanceId $INST',
  '$raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $cp.path | ConvertFrom-Json',
  'Write-Output ("CTRL-CLEAN=" + [string]$raw.repositoryState.worktreeClean)',
  'Write-Output ("CTRL-HEAD=" + [string]$raw.repositoryState.headCommit)',
  'Write-Output ("CTRL-TEXT-HAS-UNKNOWN=" + ((Get-AihContextCheckpointText -Checkpoint $raw).Contains("unknown")))',
].join('\n'));
check(/PRE-KNOWN=True/.test(out10) && /PRE-CLEAN=True/.test(out10), 'F8-10: pristine clean repo is KNOWN CLEAN');
check(/CTRL-CLEAN=False/.test(out10), 'F8-10: task ledger dirties worktree by design => checkpoint records KNOWN DIRTY (never false-clean)');
check(new RegExp('CTRL-HEAD=' + wantHead).test(out10), 'F8-10: control HEAD exact');
console.log('RESULT: ' + passed + ' F8 git-facts assertions passed.');
