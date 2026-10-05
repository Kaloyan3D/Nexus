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
 for(const id of S.manifest.candidatePhases.slice(1)){F.release(S.path.join(dir,'workspace'),id);const code=id==='T99'?Final.reference():S.manifest.calibration.phases.includes(id)?'const scales={USD:2,EUR:2,JPY:0,KWD:3};const oracle='+F.oracle.toString()+';module.exports={evaluate:x=>oracle('+JSON.stringify(id)+',x)};':require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').specs.some(s=>s[0]===id)?require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').reference(F.modules[id]):require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').specs.some(s=>s[0]===id)?require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').reference(F.modules[id]):L.reference(F.modules[id]);S.fs.writeFileSync(S.path.join(dir,'workspace/src/'+F.modules[id]+'.ts'),code);for(const [p,text] of Object.entries(F.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(dir,'workspace',p),text);}
 const runner=Object.create(R.OfficialRunner.prototype);runner.root=dir;runner.journal={stages:[]};runner.prepare=async()=>{};runner.save=()=>{};runner.transport={close:async()=>{}};
 // Synthetic unit pressure is never provider evidence. A late T99 value is ineligible.
 runner.stage=async(id,records)=>{const r={promptId:id,pressure:id==='T99'?500000:100000,acceptance:id!=='E23',agentLatencyMs:1};records.push(r);return r;};
 assert.equal(await runner.accumulate(),null);assert.deepEqual(runner.journal.stages.map(r=>r.promptId),S.manifest.candidatePhases);assert.equal(runner.journal.nativeDiagnostic.eligibleForComparison,false);assert.equal(runner.journal.nativeDiagnostic.grade.pass,true);assert.equal(runner.journal.phase,'WORKLOAD_INADEQUATE');assert(!S.fs.existsSync(S.path.join(dir,'snapshots')));
});

function waitingRunner(status,options={},phase='E01'){
 const runner=Object.create(R.OfficialRunner.prototype),dir=S.path.join(tmp,'status-observer');runner.root=dir;runner.options=options;
 const b={sessionId:'session-poll',taskId:'TASK-0001',taskInstanceId:'poll-instance',events:[]};
 const text=R.prompt(phase).text,r={promptId:phase,promptHash:S.hash(text),rpcId:'poll-unit',startSeq:0,prefixHash:S.hash(S.json([]))};
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

test('full-workload integration has a bounded budget beyond the ordinary engineering turn',async()=>{
 let polls=0,now=0;const x=waitingRunner(async()=>({sessionId:x.b.sessionId,cwd:S.path.join(x.dir,'workspace'),status:++polls===3?'idle':'running'}),{now:()=>now,pause:async()=>{now+=1000000;}},'T99');await x.runner.waitCompletion(x.b,x.r);assert.equal(polls,3);assert.equal(x.r.phase,'FLUSHED');assert.equal(now,2000000);
});
test('ordinary engineering turns retain their original default deadline',async()=>{
 let now=0;const x=waitingRunner(async()=>({sessionId:x.b.sessionId,cwd:S.path.join(x.dir,'workspace'),status:'running'}),{now:()=>now,pause:async()=>{now+=1000000;}});await assert.rejects(x.runner.waitCompletion(x.b,x.r),/durable-completion-timeout/);assert.equal(now,1000000);
});

const Provider=require('../scripts/bench/ccv2-lhcb-02/official-provider-policy.cjs');
test('transient generation failures require a failed request without durable result; quality and auth never retry',()=>{
 const text=R.prompt('E01').text,r={startSeq:0,rpcId:'failure',promptHash:S.hash(text)};
 const events=[{seq:0,time:1,type:'turn/start',data:{turn:1}},{seq:1,time:2,type:'user/message',data:{source:{kind:'user',rpcId:'failure'},content:[{type:'text',text}]}},{seq:2,time:3,type:'step/start',data:{turn:1,step:1}},{seq:3,time:4,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'PI_AI_ERROR',message:'server_error: The model failed to generate a response.'}}}}];
 assert.throws(()=>R.completion(events,r),Provider.ProviderFailure);
 for(const message of ['fetch failed','ECONNRESET','upstream temporarily unavailable'])assert.equal(Provider.transient({code:'PI_AI_ERROR',message}),true);
 for(const status of [408,425,429,500,503,599])assert.equal(Provider.transient({status}),true);
 for(const message of ['quota exhausted','authentication failed','context length exceeded','invalid request'])assert.equal(Provider.transient({status:429,message}),false);
 assert.equal(Provider.transient({code:'PI_AI_ERROR',message:'unsupported request shape'}),false);
 const committed=[...events.slice(0,3),{seq:3,time:4,type:'assistant/message',data:{turn:1,step:1}}, {...events[3],seq:4}];assert.throws(()=>R.completion(committed,r),/runner-turn-failed/);
 const completed=structuredClone(events);completed[3].data.reason={kind:'completed'};assert.equal(R.completion(completed,r).agentLatencyMs,3);
});
test('identical fixed budget stops the third provider-aborted arm and excludes failures from successful latency',()=>{
 Provider.budget(0);Provider.budget(1);Provider.budget(2);assert.throws(()=>Provider.budget(3),/EXTERNAL_BLOCKER_PROVIDER_INSTABILITY/);
 const timing=Provider.summary([{agentLatencyMs:100,statusObservationFailures:[{}]},{agentLatencyMs:200}],9000,[{wallClockMs:5000}]);assert.equal(timing.successfulModelExecutionLatencyMs,300);assert.equal(timing.providerRetryCount,1);assert.equal(timing.providerRetryDelayMs,0);assert.equal(timing.observerStatusRpcRetries,1);assert.equal(timing.totalWallClockArmDurationMs,9000);
});
test('provider settings disable hidden step retries without changing route or normal authority identity',()=>{
 const YAML=require(S.os.homedir()+'/.local/share/nexus/app/node_modules/yaml'),host=require('../config/ContextCompilerActiveOpencodeHostV2.cjs'),cert=require('../config/ContextAuthorityCertificationV2.cjs');
 const original=S.fs.readFileSync(S.path.join(S.REPO,'config/settings.yaml'),'utf8'),configured=Provider.settings(original),old=YAML.parse(original),next=YAML.parse(configured);
 assert.deepEqual(next['llm-pi-ai'].providers['opencode-go'].retryPolicy,{mode:'normal',maxRetries:0});delete next['llm-pi-ai'].providers['opencode-go'].retryPolicy;assert.deepEqual(next,old);
 const identity=host.currentOpencodeIdentityV2({installRoot:S.os.homedir()+'/.local/share/nexus'});assert.equal(identity.known,true);const options={...identity.identity,registryDocument:S.read(S.path.join(S.REPO,'config/model-registry.json'))};assert.deepEqual(cert.currentIdentityV2({...options,settingsText:configured}),cert.currentIdentityV2({...options,settingsText:original}));
});
test('all arms archive provider-aborted candidates and retry clean attempts; correctness exceptions propagate',async()=>{
 for(const arm of ['native','production','forced']){
  const runner=Object.create(R.OfficialRunner.prototype);runner.root=S.path.join(tmp,'provider-'+arm);for(const dir of ['workspace','reports','nexus-root/data/sessions','nexus-root/data/logs'])S.fs.mkdirSync(S.path.join(runner.root,dir),{recursive:true});S.fs.writeFileSync(S.path.join(runner.root,'workspace/candidate'),'partial failed candidate');S.fs.writeFileSync(S.path.join(runner.root,'nexus-root/data/logs/aih-controller.log'),'observed controller log');
  runner.journal={arms:[],providerAborts:[]};runner.save=()=>{};runner.transport={close:async()=>{}};let attempts=0;
  runner.armAttempt=async()=>{const run={arm,startedAt:Date.now(),stages:[{agentLatencyMs:10}],valid:true};runner.journal.arms.push(run);if(++attempts===1)throw new Provider.ProviderFailure({failedRequestHasCommittedResult:false});return run;};
  const run=await runner.arm(arm,{});assert.equal(attempts,2);assert.equal(runner.journal.arms.length,1);assert.equal(run.timing.providerRetryCount,1);assert.equal(run.timing.successfulModelExecutionLatencyMs,10);assert.equal(S.fs.readFileSync(S.path.join(runner.root,'reports/provider-aborted-'+arm+'-1/workspace/candidate'),'utf8'),'partial failed candidate');
  runner.armAttempt=async()=>{throw Error('genuine-correctness-or-protocol-failure');};await assert.rejects(runner.arm(arm,{}),/genuine-correctness-or-protocol-failure/);
 }
});
test('fresh prefix retries exhaust after three roots and never repeat a successful or nonprovider result',async()=>{
 const root=S.path.join(tmp,'bounded-prefix'),args=[root,'calibration','certificate'];let roots=[];
 await assert.rejects(R.boundedMain(args,async(next,options)=>{roots.push(next[0]);assert.equal(options.prefixAborts.length,roots.length-1);throw new Provider.ProviderFailure({failedRequestHasCommittedResult:false});}),/EXTERNAL_BLOCKER_PROVIDER_INSTABILITY/);
 assert.deepEqual(roots,[root,root+'-provider-retry-1',root+'-provider-retry-2']);assert.equal(S.read(root+'-provider-attempts.json').verdict,'EXTERNAL_BLOCKER_PROVIDER_INSTABILITY');
 let calls=0;await assert.rejects(R.boundedMain([root+'-other'],async()=>{calls++;throw Error('nonprovider-failure');}),/nonprovider-failure/);assert.equal(calls,1);
 const successRoot=root+'-success';S.fs.mkdirSync(S.path.join(successRoot,'reports'),{recursive:true});calls=0;const result=await R.boundedMain([successRoot],async()=>{calls++;return {scientificallyValid:true};});assert.equal(calls,1);assert.equal(result.nativePrefixProviderAttempts.providerRetryCount,0);
});
test('Native prefix aborts and continuation aborts consume one shared per-arm budget',async()=>{
 const runner=Object.create(R.OfficialRunner.prototype);runner.root=S.path.join(tmp,'shared-native-budget');for(const dir of ['workspace','reports','nexus-root/data/sessions','nexus-root/data/logs'])S.fs.mkdirSync(S.path.join(runner.root,dir),{recursive:true});S.fs.writeFileSync(S.path.join(runner.root,'nexus-root/data/logs/aih-controller.log'),'log');runner.journal={arms:[],providerAborts:[{arm:'native',root:'prior-root-1'},{arm:'native',root:'prior-root-2'}]};runner.save=()=>{};runner.transport={close:async()=>{}};let calls=0;runner.armAttempt=async()=>{calls++;runner.journal.arms.push({arm:'native',startedAt:Date.now(),stages:[]});throw new Provider.ProviderFailure({failedRequestHasCommittedResult:false});};await assert.rejects(runner.arm('native',{}),/EXTERNAL_BLOCKER_PROVIDER_INSTABILITY/);assert.equal(calls,1);assert.equal(runner.journal.providerAborts.length,3);assert.equal(runner.journal.arms.length,0);
});
