'use strict';
// Production host/compiler with restriction active. Only fixture seeding uses
// the separate private research copy; it cannot enable the production module.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const policy = require('../config/ContextDurableMutationPolicyV2.cjs');
const host = require('../config/ContextCompilerActiveOpencodeHostV2.cjs');
const cert = require('../config/ContextAuthorityCertificationV2.cjs');
const { createLaboratory } = require('./Ccv2ResearchRunner.cjs');
let passed = 0;
function check(ok, name) { assert(ok, name); passed++; console.log('PASS: ' + name); }
function inventory(root) {
  const rows = {};
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else rows[path.relative(root, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(root); return JSON.stringify(rows);
}
async function main() {
  const lab = createLaboratory();
  let fx;
  try {
    const file = path.join(lab.area, 'tests/ContextCompilerActiveOpencodeHostV2.Tests.cjs');
    const source = fs.readFileSync(file, 'utf8');
    const offset = source.indexOf("section('C08H-OCH-1 STARTUP");
    assert(offset > 0);
    const fixture = new Module(file); fixture.filename = file; fixture.paths = Module._nodeModulePaths(path.dirname(file));
    fixture._compile(source.slice(0, offset) + '\nmodule.exports={makeFixtureRoot,seedBindingH,stageMemoryH,storeRootOf,bindingsPathOf,prodRequestH,mockRemoteCounter,byteRule,fakeChunks,drainH,coverRequestH,wipe,NSH};', file);
    const f = fixture.exports;
    fx = f.makeFixtureRoot({ mode: 'active' });
    f.seedBindingH(fx, f.NSH.sessionId);
    const memory = f.stageMemoryH(fx);
    const identity = host.currentOpencodeIdentityV2({ installRoot: fx.root });
    cert.certifyOpencodeV2(f.storeRootOf(fx), identity.identity, 'f'.repeat(64));
    check(host.startupOpencodeAuthorityV2({ storeRoot: f.storeRootOf(fx), installRoot: fx.root }).health === 'HEALTHY', 'synthetic certification satisfies unchanged production authority');
    const request = f.prodRequestH(f.NSH.sessionId);
    f.coverRequestH(memory.memDir, request);
    const beforeRequest = JSON.stringify(request);
    const beforeArtifacts = inventory(fx.workspace);
    const logs = [];
    const listener = host.createOpencodeProjectionStreamListenerV2({ installRoot: fx.root, bindingsPath: f.bindingsPathOf(fx), log: record => logs.push(record), metaRemoteCounter: f.mockRemoteCounter(f.byteRule) });
    async function drive(request) {
      const dispatched = [];
      let nextCalls = 0;
      const runtime = { stream: derived => { dispatched.push(derived); return f.fakeChunks('compiled'); } };
      await f.drainH(listener.call(runtime, request, () => { nextCalls++; return f.fakeChunks('legacy'); }));
      return { dispatched, nextCalls: () => nextCalls };
    }
    const auxiliary = await drive({...request,purpose:'compaction'});
    check(auxiliary.dispatched.length === 0 && auxiliary.nextCalls() === 1, 'DSH auxiliary compaction request retains the original stream');
    const run = await drive(request);
    check(policy.durableMutationEnabledV2() === false, 'production mutation policy stays disabled during projection');
    check(run.dispatched.length === 1 && run.nextCalls() === 0 && run.dispatched[0].metadata.projectionMode === 'CCV2_COMPILED', 'production host compiles a valid request with mutation disabled');
    const derived = run.dispatched[0];
    check(JSON.stringify(request) === beforeRequest, 'original request remains byte-identical');
    check(['provider', 'model', 'tools', 'signal', 'maxTokens', 'reasoningEffort', 'sessionId'].every(key => derived[key] === request[key]), 'request routing, tools, output and abort semantics preserved');
    check(derived.system.startsWith(request.system), 'original system contract preserved');
    check(derived.messages.filter(message => message.role === 'user').length === 1, 'native current user retained once');
    check(inventory(fx.workspace) === beforeArtifacts, 'projection never writes or repairs durable memory');
    // Re-starting the host still reads, rather than adopting/replaying intent.
    check(host.startupOpencodeAuthorityV2({ storeRoot: f.storeRootOf(fx), installRoot: fx.root }).health === 'HEALTHY', 'read-only host restart remains functional');
    const stale = { ...request, metadata: { ...request.metadata, nonce: 'stale' }, messages: request.messages.slice(0, 1) };
    const fallback = await drive(stale);
    check(fallback.dispatched.length === 0 && fallback.nextCalls() === 1, 'stale/missing native tail falls back without a derived request');
    check(inventory(fx.workspace) === beforeArtifacts, 'fallback/restart leave stored artifacts byte-identical');
    fs.renameSync(path.join(memory.memDir, 'checkpoints'), path.join(memory.memDir, 'checkpoints-preserved'));
    const missing = await drive({ ...request, metadata: { ...request.metadata, nonce: 'missing' } });
    check(missing.dispatched.length === 0 && missing.nextCalls() === 1, 'missing checkpoint uses unchanged legacy request');
    f.wipe(fx); fx = null;
  } finally {
    if (fx) { fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(fx.workspace, { recursive: true, force: true }); }
    fs.rmSync(lab.area, { recursive: true, force: true });
  }
  console.log('Restricted projection: passed=' + passed + ' failed=0');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
