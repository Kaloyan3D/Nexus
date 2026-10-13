'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const child = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const reg = require(path.join(repoRoot, 'config', 'ContextTokenizerRegistryV2.cjs'));
let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed += 1; console.log('PASS: ' + name); }
  else { failed += 1; console.log('FAIL: ' + name + (detail === undefined ? '' : ' :: ' + detail)); }
}
function section(title) { console.log(String.fromCharCode(10) + title); }
const chr = (c) => String.fromCharCode(c);
const BG = [1047, 1076, 1088, 1072, 1074, 1081].map(chr).join('');
const CJK = [20013, 25991].map(chr).join('');
const EMOJI = String.fromCodePoint(128512);
section('C08H-TOKX CROSS-PROCESS TOKENIZER PROOF');
{
  const fixture = {
    fingerprint: reg.TOKENIZER_FINGERPRINT_V1,
    route: { provider: 'flash-max-direct', model: 'deepseek-v4-flash' },
    texts: ['', 'hello', 'Ship C08H now.', 'h' + chr(233) + 'llo', BG, CJK, EMOJI, 'def f(x):', 'abc '.repeat(200)],
    convos: [
      { systems: ['You are helpful.'], turn: 'Hello turn', prime: true },
      { systems: ['First contract.', 'Second contract.'], turn: 'Go', prime: true },
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c08hx-'));
  const inFile = path.join(dir, 'fixture.json');
  const goFile = path.join(dir, 'go');
  const outA = path.join(dir, 'a.json');
  const outB = path.join(dir, 'b.json');
  fs.writeFileSync(inFile, JSON.stringify(fixture));
  const worker = path.join(repoRoot, 'tests', 'ContextTokenizerDeepseekV4XProc.Worker.cjs');
  const spawn = (out) => child.spawn(process.execPath, [worker, '--in', inFile, '--go', goFile, '--out', out], { stdio: 'ignore' });
  const a = spawn(outA);
  const b = spawn(outB);
  const wait = (proc) => new Promise((resolve) => proc.on('close', resolve));
  setTimeout(() => { try { fs.writeFileSync(goFile, 'go'); } catch (error) { void error; } }, 500);
  Promise.all([wait(a), wait(b)]).then(() => {
    let ra = null;
    let rb = null;
    try { ra = JSON.parse(fs.readFileSync(outA, 'utf8')); } catch (error) { ra = null; }
    try { rb = JSON.parse(fs.readFileSync(outB, 'utf8')); } catch (error) { rb = null; }
    check(ra !== null && ra.ok === true, 'worker A completes');
    check(rb !== null && rb.ok === true, 'worker B completes');
    if (ra !== null && rb !== null && ra.ok === true && rb.ok === true) {
      check(JSON.stringify(ra.counts) === JSON.stringify(rb.counts), 'counts identical across processes');
      check(JSON.stringify(ra.idSamples) === JSON.stringify(rb.idSamples), 'id samples identical across processes');
      check(JSON.stringify(ra.frames) === JSON.stringify(rb.frames), 'frames identical across processes');
      check(ra.fingerprint === reg.TOKENIZER_FINGERPRINT_V1, 'fingerprint identical across processes');
      check(ra.descriptorValid === true && rb.descriptorValid === true, 'capability binding identical across processes');
      const ctr = reg.createDeepseekV4CounterV2();
      const local = fixture.texts.map((text) => ctr.countText(text));
      check(JSON.stringify(local) === JSON.stringify(ra.counts), 'workers match the parent process');
      check(JSON.stringify(ra.counts) === JSON.stringify([0, 1, 6, 2, 4, 1, 2, 4, 201]), 'workers match recorded ground truth');
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { void error; }
    console.log(String.fromCharCode(10) + 'ContextTokenizerDeepseekV4XProc suite: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exitCode = 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
