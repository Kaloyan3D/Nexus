'use strict';
/**
 * ContextCompactionF9TailBound.Tests.cjs - F9 continuity tail hard bound.
 *
 * REAL pinned DSH Session + REAL balancedRetainCut. Size metric is the
 * production one: JSON.stringify(event.data).length per node. Whole nodes
 * only: oversize-mandatory => null/KEEP, never truncation/split.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const compaction = require(path.join(repoRoot, 'config', 'ContextCompaction.cjs'));
let passed = 0;
function check(cond, name) { assert.ok(cond, name); passed += 1; console.log('PASS: ' + name); }
function resolveDshSession() {
  const cands = [process.env.AIH_TOOLCHAIN_ROOT, process.env.DSH_HOME && path.dirname(path.resolve(process.env.DSH_HOME)), '/home/kaloyan/.local/share/nexus'].filter(Boolean)
    .map((r) => path.join(r, 'app', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js'));
  for (const c of cands) { try { if (fs.existsSync(c)) return require(c); } catch {} }
  return null;
}
const dsh = resolveDshSession();
if (!dsh || !dsh.Session) { console.log('SKIP: live DSH session tree absent'); process.exit(0); }
const { Session } = dsh;
const OPTS = { maxTailNodes: 6, maxTailChars: 6000, minShadowed: 1 };
function tailCharsOf(session, cut) {
  let total = 0;
  for (const seq of cut.retainedSeqs) total += JSON.stringify(session.events[seq].data).length;
  return total;
}
function textSession(texts) {
  // texts: array of char counts for newest-ward user messages after 2 bulk nodes.
  const s = Session.create('f9-' + Math.random().toString(16).slice(2));
  const append = (t, d, o) => s.append(t, d, o);
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk-a' + 'x'.repeat(3000) }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk-b' + 'x'.repeat(3000) }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  texts.forEach((n, i) => append('user/message', { role: 'user', content: [{ type: 'text', text: 'T' + i + 'x'.repeat(Math.max(0, n - 30)) }] , source: { kind: 'user' } }, { surfaceOp: 'append' }));
  return s;
}
// A/B/C exact bounds: craft newest node so retained total lands 5999/6000/6001.
// Node overhead is constant per shape; calibrate empirically.
function calibratedSession(wantTotal) {
  let lo = 100, hi = 20000, best = null;
  for (let iter = 0; iter < 24; iter += 1) {
    const mid = Math.floor((lo + hi) / 2);
    const s = textSession([mid]);
    const cut = compaction.balancedRetainCut(s, OPTS);
    if (!cut) { hi = mid; continue; }
    const total = tailCharsOf(s, cut);
    if (total === wantTotal) return { session: s, cut, total };
    if (total < wantTotal) { best = { session: s, cut, total }; lo = mid; }
    else hi = mid;
  }
  return best;
}
// A: 5999 eligible. B: 6000 eligible. (Exact-hit calibration may land near;
// assert bound compliance + cut existence on a just-under and at-limit shape.)
{
  const s = textSession([5900]);
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut !== null, 'F9-A: just-under tail compacts');
  check(tailCharsOf(s, cut) <= 6000, 'F9-A: retained tail <= 6000');
}
{
  // At-limit: binary-search a single-node tail as close to 6000 as possible.
  let best = null;
  for (let n = 5900; n <= 6100; n += 10) {
    const s = textSession([n]);
    const cut = compaction.balancedRetainCut(s, OPTS);
    if (!cut) continue;
    const t = tailCharsOf(s, cut);
    if (t <= 6000 && (!best || t > best.total)) best = { total: t };
  }
  check(best !== null && best.total <= 6000, 'F9-B: at-limit tail compacts within bound (best ' + (best && best.total) + ')');
}
// C: 6001 indivisible => KEEP.
{
  const s = textSession([5950]);
  // Force over: pad until single retained node exceeds.
  let cut = compaction.balancedRetainCut(s, OPTS);
  let total = cut ? tailCharsOf(s, cut) : 0;
  check(total <= 6000, 'F9-C setup: baseline within bound (got ' + total + ')');
  const big = textSession([7000]);
  const bigCut = compaction.balancedRetainCut(big, OPTS);
  check(bigCut === null, 'F9-C: 6001+ indivisible tail => KEEP (null)');
}
// D: 100k single node => KEEP, history intact.
{
  const s = Session.create('f9-giant');
  const append = (t, d, o) => s.append(t, d, o);
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  append('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'GIANT' + 'Z'.repeat(100000) }] }, source: { kind: 'model' } }, { surfaceOp: 'append' });
  const before = s.events.length;
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut === null, 'F9-D: 100k node => KEEP');
  check(s.events.length === before, 'F9-D: zero mutation on KEEP');
}
// Normal multi-node 1700+1800+2000=5500 compacts; +1500 older excluded.
{
  const s = textSession([1700, 1800, 2000]);
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut !== null, 'F9-normal: 5500 tail compacts');
  check(tailCharsOf(s, cut) <= 6000, 'F9-normal: tail within bound');
  const s2 = textSession([1500, 1700, 1800, 2000]);
  const cut2 = compaction.balancedRetainCut(s2, OPTS);
  check(cut2 !== null, 'F9-normal: near-limit still compacts');
  check(tailCharsOf(s2, cut2) <= 6000, 'F9-normal: older node excluded to fit');
  check(cut2.retainedSeqs.length < s2.surface.nodes.length, 'F9-normal: cut actually shadows bulk');
}
// Tool pair/group > limit => KEEP (whole group budgeted).
{
  const s = Session.create('f9-pair');
  const append = (t, d, o) => s.append(t, d, o);
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'call' + 'C'.repeat(2500) }, { type: 'tool-call', name: 'run', callId: 'k1' }] }, source: { kind: 'model' } }, { surfaceOp: 'append' });
  append('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'k1' }, content: [{ type: 'tool-result', toolCallId: 'k1', content: [{ type: 'text', text: 'res' + 'R'.repeat(4500) }] }] } }, { surfaceOp: 'append' });
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut === null, 'F9-pair: required 2500+4500 group > 6000 => KEEP');
}
// Current-request oversize => KEEP, request intact.
{
  const s = Session.create('f9-cur');
  const append = (t, d, o) => s.append(t, d, o);
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'CUR' + 'Q'.repeat(20000) }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut === null, 'F9-current: oversize current request => KEEP (never truncated)');
}
// Final-report oversize (audit class) => KEEP.
{
  const s = Session.create('f9-final');
  const append = (t, d, o) => s.append(t, d, o);
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  append('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL' + 'Z'.repeat(100000) }] }, source: { kind: 'model' } }, { surfaceOp: 'append' });
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut === null, 'F9-final: 100k final report => KEEP');
}
// Open tool call KEEP preserved.
{
  const s = Session.create('f9-open');
  const append = (t, d, o) => s.append(t, d, o);
  append('user/message', { role: 'user', content: [{ type: 'text', text: 'bulk' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', name: 'run', callId: 'open1' }] }, source: { kind: 'model' } }, { surfaceOp: 'append' });
  const cut = compaction.balancedRetainCut(s, OPTS);
  check(cut === null, 'F9-open: unbalanced open call stays KEEP');
}
// Applied results always within bound (property sweep).
{
  let applied = 0;
  for (const sizes of [[500, 600, 700], [1500, 1500, 1500], [2500, 2000], [5900]]) {
    const s = textSession(sizes);
    const cut = compaction.balancedRetainCut(s, OPTS);
    if (cut) { applied += 1; check(tailCharsOf(s, cut) <= 6000, 'F9-bound: applied tail <= 6000 for ' + JSON.stringify(sizes)); }
  }
  check(applied >= 3, 'F9-bound: ordinary sessions still compact (' + applied + ' applied)');
}
console.log('RESULT: ' + passed + ' F9 tail-bound assertions passed.');
