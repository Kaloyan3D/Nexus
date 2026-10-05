'use strict';
require('../benchmarks/ccv2-lhcb-01/grader/offline.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {S,load}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs'),R=require('../scripts/bench/ccv2-lhcb-02/official-runner.cjs'),Snap=require('../scripts/bench/ccv2-lhcb-02/official-snapshot.cjs');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-official-unit-'));let root,meta,before;
function writable(dir){if(!S.fs.existsSync(dir))return;for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const f=S.path.join(dir,e.name);if(e.isDirectory())writable(f);if(!e.isSymbolicLink())S.fs.chmodSync(f,e.isDirectory()?0o700:0o600);}S.fs.chmodSync(dir,0o700);}
after(()=>{assert.equal(global.lhcbOfflineAudit.attempts(),0);writable(tmp);S.fs.rmSync(tmp,{recursive:true,force:true});});
test('completion waits for accepted asynchronous prompt, binds exact turn/RPC and rejects unrelated users',()=>{
 const text=R.prompt('E12').text,r={promptId:'E12',promptHash:S.hash(text),rpcId:'lhcb-unit',startSeq:0};
 const events=[{seq:0,time:100,type:'turn/start',data:{turn:12}},{seq:1,time:101,type:'user/message',data:{content:[{type:'text',text}],source:{kind:'user',rpcId:r.rpcId}}}];
 assert.equal(R.completion(events,r),null);events.push({seq:2,time:250,type:'turn/end',data:{turn:12,reason:{kind:'completed'}}});assert.deepEqual(R.completion(events,r),{endSeq:2,agentLatencyMs:150});
 assert.throws(()=>R.completion(events,{...r,rpcId:'foreign'}),/provenance/);events.push({...events[1],seq:3});assert.throws(()=>R.completion(events,r),/duplicate/);
});
test('calibration is required from actual root records, not caller PASS booleans',()=>{
 const bad=S.path.join(tmp,'bad-calibration');S.fs.mkdirSync(S.path.join(bad,'state'),{recursive:true});S.fs.mkdirSync(S.path.join(bad,'reports'));
 S.write(S.path.join(bad,'state/identity.json'),{root:bad,benchmarkId:S.manifest.benchmarkId,baseSha:S.manifest.baseSha,contractHash:'forged'});S.write(S.path.join(bad,'state/calibration-journal.json'),{contractHash:'forged',phase:'COMPLETE',stages:[]});S.write(S.path.join(bad,'reports/calibration.json'),{calibration:{status:'PASS'},contractHash:'forged',workloadHash:S.workloadHash()});assert.throws(()=>R.verifyCalibration(bad),/calibration-required/);
});
test('comparison uses disjoint total input, step and correctness gates without incompatible obligation totals',()=>{
 const make=(arm,tokens,steps,pass=true)=>({arm,valid:true,grade:{pass},agentLatencyMs:arm==='native'?100:120,metrics:{providerInputTokensTotal:tokens,steps,compiledRequests:arm==='forced'?4:0,pressurePolicyMatches:true}});
 let r=R.compare([make('native',1000,4),make('production',1000,4),make('forced',400,5)]);assert.equal(r.productionBenefit,'NOT_TRIGGERED');assert.equal(r.compilerCapability,'PASS');assert.equal(r.comparisons.forced.headline,true);assert.equal(r.reasoningContinuitySafety,'PASS');
 r=R.compare([make('native',1000,4),make('production',1000,4),make('forced',400,6)]);assert.equal(r.comparisons.forced.meaningful,false);
 r=R.compare([make('native',1000,4),make('production',1000,4,false),make('forced',400,4,false)]);assert.equal(r.reasoningContinuitySafety,'FAIL');assert.equal(r.compilerCapability,'FAIL');
});
test('progressive physical snapshot preserves edited source and durable state; caller pressure cannot create checkpoint',()=>{
 root=S.path.join(tmp,'snapshot-root');for(const p of ['state','workspace/src','nexus-root/data/sessions/ws/session-unit','nexus-root/data/routing','nexus-root/app'])S.fs.mkdirSync(S.path.join(root,p),{recursive:true});
 // Synthetic durable usage is only unit-test input, never live benchmark evidence.
 for(const p of S.manifest.protectedPaths){const bytes=require('node:child_process').execFileSync('git',['show',S.manifest.baseSha+':'+p],{cwd:S.REPO,maxBuffer:32*1024*1024});const target=S.path.join(root,'nexus-root',p);S.fs.mkdirSync(S.path.dirname(target),{recursive:true});S.fs.writeFileSync(target,bytes);}
 for(const f of ['package.json','package-lock.json'])S.fs.copyFileSync(S.path.join(root,'nexus-root/runtime',f),S.path.join(root,'nexus-root/app',f));
 S.fs.symlinkSync(S.os.homedir()+'/.local/share/nexus/app/node_modules',S.path.join(root,'nexus-root/app/node_modules'));S.fs.copyFileSync(S.path.join(root,'nexus-root/config/settings.yaml'),S.path.join(root,'nexus-root/data/settings.yaml'));
 S.write(S.path.join(root,'state/identity.json'),{root,benchmarkId:S.manifest.benchmarkId,baseSha:S.manifest.baseSha,contractHash:S.contractHash()});
 const a={sessionId:'session-unit',taskId:'TASK-0001',taskInstanceId:'unit-instance',provider:S.manifest.provider,model:S.manifest.model};
 S.write(S.path.join(root,'nexus-root/data/routing/session-bindings.json'),{bindings:{[a.sessionId]:{...a,workspace:S.path.join(root,'workspace')}}});S.write(S.path.join(root,'workspace/.ai-harness/runs/TASK-0001/manifest.json'),a);
 const relative='nexus-root/data/sessions/ws/session-unit/session.jsonl';const events=[{seq:0,time:1000,type:'turn/start',data:{turn:1}},{seq:1,time:1001,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'unit',role:'assistant',content:[{type:'text',text:'synthetic unit fixture'}]},usage:{inputTokens:500000,outputTokens:10}}},{seq:2,time:1002,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
 S.fs.writeFileSync(S.path.join(root,relative),[{type:'session',id:a.sessionId,cwd:S.path.join(root,'workspace'),version:3,createdAt:1000},...events].map(JSON.stringify).join('\n')+'\n');load('session').bind(root,relative);
 load('init').createLaunchDirectories(S.path.join(root,'nexus-root'));S.write(S.path.join(root,'state/release-E01.json'),{complete:true,fixture:'baseline'});S.fs.writeFileSync(S.path.join(root,'workspace/src/progressive.ts'),'module.exports={edited:true};');before=Snap.selected(root);const pressure=load('session').currentPressure(root).pressureTokens;
 assert.throws(()=>Snap.seal(root,{identity:a,pressureTokens:pressure+1,completedStages:['T00'],protocolHash:R.protocolHash()}),/checkpoint-pressure/);
 const producer=S.path.join(root,'workspace/.ai-harness/ccv2/TASK-0001');S.fs.mkdirSync(S.path.join(producer,'producer'),{recursive:true});S.write(S.path.join(producer,'producer/state.json'),{namespace:{...a,workspaceId:S.path.join(root,'workspace')},openTurn:null,processedThroughSeq:2,sealedGeneration:1,sealedCheckpointId:'synthetic-unit'});S.write(S.path.join(producer,'staged.json'),{activeTurn:null,processedThroughSeq:2,sealedGeneration:1,sealedCheckpointId:'synthetic-unit'});before=Snap.selected(root);const memory=S.read(S.path.join(producer,'producer/state.json'));S.write(S.path.join(producer,'producer/state.json'),{...memory,openTurn:1});assert.equal(Snap.memoryReady(root),false);S.write(S.path.join(producer,'producer/state.json'),memory);meta=Snap.seal(root,{identity:a,pressureTokens:pressure,completedStages:['T00','E01','E02','E03','E04','E05','E06'],protocolHash:R.protocolHash()});assert.deepEqual(Snap.verify(S.path.join(root,'snapshots/CP-500')).files,before.files);
 S.fs.writeFileSync(S.path.join(root,'workspace/src/progressive.ts'),'altered arm');S.fs.writeFileSync(S.path.join(root,'workspace/new-arm-file'),'remove me');S.write(S.path.join(root,'state/release-T99.json'),{complete:true,fixture:'arm'});Snap.restore(root);assert.deepEqual(Snap.selected(root),before);assert.equal(S.fs.existsSync(S.path.join(root,'workspace/new-arm-file')),false);
});
test('corrupt snapshot refuses restore before touching the active workspace',()=>{
 const file=S.path.join(root,'snapshots/CP-500/payload/workspace/src/progressive.ts');S.fs.chmodSync(file,0o600);S.fs.writeFileSync(file,'corrupt');const before=S.fs.readFileSync(S.path.join(root,'workspace/src/progressive.ts'));assert.throws(()=>Snap.restore(root),/snapshot-content/);assert.deepEqual(S.fs.readFileSync(S.path.join(root,'workspace/src/progressive.ts')),before);assert(!S.fs.existsSync(S.path.join(root,'state/restore-lock.json')));
});

test('finite workload completes after failed stage quality and diagnostic T99 cannot enable checkpoint',async()=>{
 const F=require('../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs'),L=require('../benchmarks/ccv2-lhcb-02/fixture/late.cjs'),Final=require('../benchmarks/ccv2-lhcb-02/fixture/final.cjs');const dir=S.path.join(tmp,'diagnostic-only');S.fs.mkdirSync(S.path.join(dir,'workspace'),{recursive:true});F.createFixture(S.path.join(dir,'workspace'));
 for(const id of S.manifest.candidatePhases.slice(1)){F.release(S.path.join(dir,'workspace'),id);const code=id==='T99'?Final.reference():S.manifest.calibration.phases.includes(id)?'const scales={USD:2,EUR:2,JPY:0,KWD:3};const oracle='+F.oracle.toString()+';module.exports={evaluate:x=>oracle('+JSON.stringify(id)+',x)};':require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').specs.some(s=>s[0]===id)?require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').reference(F.modules[id]):L.reference(F.modules[id]);S.fs.writeFileSync(S.path.join(dir,'workspace/src/'+F.modules[id]+'.ts'),code);for(const [p,text] of Object.entries(F.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(dir,'workspace',p),text);}
 const runner=Object.create(R.OfficialRunner.prototype);runner.root=dir;runner.journal={stages:[]};runner.prepare=async()=>{};runner.save=()=>{};runner.transport={close:async()=>{}};
 // Synthetic unit pressure is never provider evidence. A late T99 value is ineligible.
 runner.stage=async(id,records)=>{const r={promptId:id,pressure:id==='T99'?500000:100000,acceptance:id!=='E23',agentLatencyMs:1};records.push(r);return r;};
 assert.equal(await runner.accumulate(),null);assert.deepEqual(runner.journal.stages.map(r=>r.promptId),S.manifest.candidatePhases);assert.equal(runner.journal.nativeDiagnostic.eligibleForComparison,false);assert.equal(runner.journal.nativeDiagnostic.grade.pass,true);assert.equal(runner.journal.phase,'WORKLOAD_INADEQUATE');assert(!S.fs.existsSync(S.path.join(dir,'snapshots')));
});

function waitingRunner(status,options={}){
 const runner=Object.create(R.OfficialRunner.prototype),dir=S.path.join(tmp,'status-observer');runner.root=dir;runner.options=options;
 const b={sessionId:'session-poll',taskId:'TASK-0001',taskInstanceId:'poll-instance',events:[]};
 const text=R.prompt('E01').text,r={promptId:'E01',promptHash:S.hash(text),rpcId:'poll-unit',startSeq:0,prefixHash:S.hash(S.json([]))};
 const events=[{seq:0,time:100,type:'turn/start',data:{turn:1}},{seq:1,time:101,type:'user/message',data:{content:[{type:'text',text}],source:{kind:'user',rpcId:r.rpcId}}},{seq:2,time:102,type:'request/header',data:{header:{config:{provider:S.manifest.provider,model:S.manifest.model}}}},{seq:3,time:150,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
 runner.journal={identity:{provider:S.manifest.provider,model:S.manifest.model}};runner.binding=()=>({...b,events});runner.transport={status,flush:async()=>true};return {runner,b,r,dir};
}
test('accepted prompt survives a temporary status RPC outage without resubmission',async()=>{
 let polls=0,submissions=0,now=0;const x=waitingRunner(async()=>{if(++polls===1)throw Error('lhcb-runner-rpc-endpoint-unavailable');return {sessionId:x.b.sessionId,cwd:S.path.join(x.dir,'workspace'),status:polls===2?'running':'idle'};},{now:()=>now,pause:async()=>{now+=1;},turnTimeoutMs:10});
 x.runner.transport.submit=async()=>{submissions++;};await x.runner.transport.submit();await x.runner.waitCompletion(x.b,x.r);assert.equal(submissions,1);assert.equal(polls,3);assert.equal(x.r.phase,'FLUSHED');assert.equal(x.r.endSeq,3);assert.equal(x.r.agentLatencyMs,50);assert.equal(x.r.statusObservationFailures.length,1);
});
test('temporary status RPC outages remain bounded by the existing turn deadline',async()=>{
 let now=0;const x=waitingRunner(async()=>{throw Error('lhcb-runner-rpc-endpoint-unavailable');},{now:()=>now,pause:async()=>{now+=10;},turnTimeoutMs:5});await assert.rejects(x.runner.waitCompletion(x.b,x.r),/durable-completion-timeout/);assert.equal(x.r.phase,undefined);assert.equal(x.r.acceptance,undefined);
});
test('status observer still rejects identity drift and nontransient RPC failures',async()=>{
 const bad=waitingRunner(async()=>{throw Error('lhcb-runner-rpc-schema-rejected');});await assert.rejects(bad.runner.waitCompletion(bad.b,bad.r),/schema-rejected/);
 const drift=waitingRunner(async()=>({sessionId:'foreign',cwd:S.path.join(tmp,'workspace'),status:'idle'}));await assert.rejects(drift.runner.waitCompletion(drift.b,drift.r),/status-malformed/);
});
