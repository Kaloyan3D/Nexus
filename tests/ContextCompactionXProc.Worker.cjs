'use strict';
// Cross-process worker: acquires the apply lock for one operation, holds it
// across a delay (simulating append/flush/verify), appends a marker record,
// then releases. Usage: node xproc_worker.cjs <workspace> <taskId> <taskInstanceId> <sessionId> <operationId> <holdMs> <tag>
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const INSTALL_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(INSTALL_ROOT, 'scripts', 'ContextLifecycleCli.ps1');
const PWSH = 'pwsh';
function cli(action, taskId, payload) {
  const payloadFile = '/tmp/ccv1_xproc_' + process.pid + '_' + action + '.json';
  require('node:fs').writeFileSync(payloadFile, JSON.stringify(payload));
  try {
    const out = execFileSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLI, '-Action', action, '-TaskId', taskId, '-PayloadFile', payloadFile], { encoding: 'utf8', timeout: 120000 });
    const text = out.trim();
    return text === '' ? null : JSON.parse(text);
  } finally {
    try { require('node:fs').unlinkSync(payloadFile); } catch {}
  }
}
async function main() {
  const [workspace, taskId, taskInstanceId, sessionId, operationId, holdMs, tag, leaseS, heartbeat] = process.argv.slice(2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const leaseSeconds = Number(leaseS) > 0 ? Number(leaseS) : 60;
  const acquired = cli('acquire-apply-lock', taskId, { workspace, taskInstanceId, sessionId, operationLockId: operationId, lockLeaseSeconds: leaseSeconds });
  console.log(JSON.stringify({ tag, acquired: acquired && acquired.acquired, reason: acquired && acquired.reason }));
  if (!acquired || acquired.acquired !== true) process.exit(2);
  // Owner heartbeat: renew every lease/3 while holding (production parity
  // with startCompactionHeartbeat). Disabled when heartbeat arg is 'off'.
  let renewals = 0;
  let renewFailed = false;
  let timer = null;
  if (heartbeat !== 'off') {
    const intervalMs = Math.max(250, Math.floor(leaseSeconds * 1000 / 3));
    timer = setInterval(() => {
      try {
        const res = cli('renew-apply-lock', taskId, { workspace, taskInstanceId, sessionId, operationLockId: operationId, lockOwnerId: acquired.ownerId, lockLeaseSeconds: leaseSeconds });
        if (res && res.renewed === true) renewals += 1;
        else renewFailed = true;
      } catch { renewFailed = true; }
    }, intervalMs);
  }
  await sleep(Number(holdMs) || 0);
  if (timer) clearInterval(timer);
  console.log(JSON.stringify({ tag, renewals, renewFailed }));
  if (renewFailed) { console.log(JSON.stringify({ tag, heartbeatUnhealthy: true })); process.exit(3); }
  cli('release-apply-lock', taskId, { workspace, lockOwnerId: acquired.ownerId });
  console.log(JSON.stringify({ tag, released: true }));
}
main().catch((e) => { console.error('WORKER-FAIL ' + e.message); process.exit(1); });
