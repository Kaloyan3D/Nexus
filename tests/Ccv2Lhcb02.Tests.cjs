'use strict';
require('../benchmarks/ccv2-lhcb-01/grader/offline.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {S,load}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs');
const fixture=require('../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs');
const {calibration,workload,benefit}=require('../scripts/bench/ccv2-lhcb-02/validity.cjs');
const {release,acceptance}=require('../scripts/bench/ccv2-lhcb-02/autorunner.cjs');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-offline-'));
after(()=>{assert.equal(global.lhcbOfflineAudit.attempts(),0);S.fs.rmSync(tmp,{recursive:true,force:true});});
function good(){
 const phases=S.manifest.calibration.phases.map((phase,i)=>({phase,pressureBefore:20000*i,pressureAfter:20000*(i+1),pressureGrowth:20000,acceptance:true,terminalContentHash:S.hash('terminal'+i),evidenceSetHash:S.hash('set'+i),toolCalls:3,newToolEvidenceHashes:[S.hash('evidence'+i)],compactionEvents:0,historyReplacements:0}));
 const requests=phases.map((p,i)=>({phase:p.phase,sessionId:'session-offline',taskId:'TASK-0001',taskInstanceId:'instance',requestIdentity:S.hash('identity'+i),promptHash:require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs').authority.promptHashes[p.phase],durableSequenceRange:[i*10,i*10+3],requestOutcome:'OBSERVED',provider:S.manifest.provider,model:S.manifest.model,uncachedInputTokens:20000*(i+1),cacheReadTokens:0,cacheWriteTokens:0,outputTokens:25,historicalToolCallCount:2,historicalToolResultCount:2,historyCompactionCount:0,historyReplacementCount:0,providerInputTokens:20000*(i+1),mode:'NATIVE',compilerExecutionCount:0,requestHash:S.hash('request'+i),canonicalRequestByteCount:1234,messageCount:4,reconstructedWireItemCount:4,pressureBefore:p.pressureBefore,pressureAfter:p.pressureAfter,pressureDelta:20000}));return {phases,requests};
}
function recovered(){
 const x=good(),replacement=x.requests[4];
 Object.assign(replacement,{attempt:1,provider:S.manifest.provider,model:S.manifest.model});
 const raw={observationId:'failed-sdk',sessionId:replacement.sessionId,benchmarkPhase:replacement.phase,benchmarkRpcId:'rpc',turn:6,step:10,provider:S.manifest.provider,model:S.manifest.model,harnessRetryNumber:0};
 const failed={...replacement,attempt:0,requestIdentity:S.hash('failed-identity'),durableSequenceRange:[40,42],requestOutcome:'FAILED',pressureAfter:replacement.pressureBefore,pressureDelta:0,providerInputTokens:null,uncachedInputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,outputTokens:null};
 replacement.durableSequenceRange=[43,45];
 failed.failureEvidence={rawInvocation:{...raw,kind:'provider_request_start',timestamp:new Date(1000).toISOString()},rawFailure:{...raw,kind:'provider_raw_failure',timestamp:new Date(1100).toISOString(),sdkAttemptNumber:1,error:{name:'APIConnectionError',cause:{name:'TypeError',message:'fetch failed',cause:{code:'ECONNRESET'}}}},rawEnd:{...raw,kind:'provider_request_end',timestamp:new Date(1100).toISOString(),outcome:'FAILURE',sdkAttempts:1,providerReportedInputTokens:null},failedRequestHasCommittedResult:false,acceptedMutation:false,
  retryPolicy:{mode:'normal',maxRetries:5,retryableCodes:['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT'],initialDelayMs:500,maxDelayMs:10000,jitterRatio:0.1},
  scheduled:{seq:42,time:1101,data:{provider:S.manifest.provider,mode:'normal',retryId:'retry',turn:6,step:10,retry:1,maxRetries:5,delayMs:500,policyKey:'["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]',failure:{code:'TRANSPORT'}}},started:{seq:43,time:1601,data:{retryId:'retry',turn:6,step:10,retry:1}},
  replacementRequestIdentity:replacement.requestIdentity,replacementRawEnd:{...raw,observationId:'replacement-sdk',harnessRetryNumber:1,kind:'provider_request_end',timestamp:new Date(1700).toISOString(),outcome:'SUCCESS',sdkAttempts:1},sourceIdentityVerified:true};
 x.requests.splice(4,0,failed);return x;
}
test('recovered ECONNRESET without Response may qualify with complete accepted pressure',()=>{const x=recovered(),r=calibration(x.phases,x.requests);assert.equal(r.status,'PASS',JSON.stringify(r));});
test('unknown failed usage stays null and billing remains incomplete',()=>{const x=recovered(),r=calibration(x.phases,x.requests);assert.equal(x.requests[4].providerInputTokens,null);assert.equal(r.providerAccounting.failedAttempts[0].providerInputTokens,null);assert.equal(r.providerAccounting.failedAttemptUsageUnavailableCount,1);assert.equal(r.providerAccounting.billingUsageComplete,false);assert(r.diagnostics.includes('provider-failed-attempt-usage-unavailable'));});
for(const [name,mutate] of [
 ['committed result',x=>{x.requests[4].failureEvidence.failedRequestHasCommittedResult=true;}],
 ['no successful replacement',x=>{x.requests[5].requestOutcome='UNOBSERVED';}],
 ['missing accepted pressure',x=>{x.requests[5].pressureAfter=null;}],
 ['unobserved request',x=>{x.requests[4].requestOutcome='UNOBSERVED';}],
 ['illegal retry',x=>{x.requests[4].failureEvidence.scheduled.data.retry=6;}],
 ['provider mismatch',x=>{x.requests[4].failureEvidence.rawFailure.provider='other';}],
 ['unverified identity',x=>{x.requests[4].failureEvidence.sourceIdentityVerified=false;}],
 ['accepted mutation',x=>{x.requests[4].failureEvidence.acceptedMutation=true;}],
 ['missing raw invocation',x=>{x.requests[4].failureEvidence.rawInvocation=null;}],
 ['missing accepted usage',x=>{x.requests[5].providerInputTokens=null;}],
])test('recovery still rejects '+name,()=>{const x=recovered();mutate(x);assert.equal(calibration(x.phases,x.requests).status,'FAIL');});
test('scientific totals exclude failed usage while accounting retains known failed input',()=>{const x=recovered();x.requests[4].failureEvidence.rawEnd.providerReportedInputTokens=123456;const r=calibration(x.phases,x.requests);assert.equal(r.status,'PASS');assert.equal(r.providerAccounting.successfulAcceptedProviderInputTokens,420000);assert.equal(r.providerAccounting.knownFailedAttemptProviderInputTokens,123456);assert.equal(r.providerAccounting.totalKnownProviderInputTokens,543456);assert.equal(r.providerAccounting.failedAttempts.length,1);assert.equal(r.scientificPressure.totalAcceptedProviderInputTokens,420000);assert.equal(r.providerAccounting.failedAttempts[0].retry.actualBackoffMs,500);});
function joined(){
 const x=recovered(),r=x.requests[4],f=r.failureEvidence,events=Array.from({length:46},(_,seq)=>({seq,type:'noop',time:1000,data:{}}));
 events[40]={seq:40,time:1000,type:'step/start',data:{turn:6,step:10}};
 events[41]={seq:41,time:1100,type:'assistant/chunk',data:{chunk:{type:'finish'}}};
 events[42]={...f.scheduled,type:'llm/retry'};events[43]={...f.started,type:'llm/retry-started'};events[45]={seq:45,time:1701,type:'assistant/message',data:{}};
 const raw=[f.rawInvocation,f.rawFailure,f.rawEnd,f.replacementRawEnd];delete r.failureEvidence;
 return {x,events,raw,record:{rpcId:'rpc'},policy:f.retryPolicy};
}
test('read-only join binds raw failure and successful replacement to durable retry receipts',()=>{
 const A=require('../scripts/bench/ccv2-lhcb-02/provider-accounting.cjs'),{x,events,raw,record,policy}=joined();
 const originals=JSON.stringify({events,raw,record,policy});A.attach(x.requests,events,record,raw,policy,true);
 assert.equal(calibration(x.phases,x.requests).status,'PASS');assert.equal(JSON.stringify({events,raw,record,policy}),originals);
});
for(const [name,mutate] of [
 ['ambiguous raw starts',q=>q.raw.push({...q.raw[0],observationId:'other'})],
 ['wrong RPC',q=>{q.record.rpcId='other';}],
 ['committed tool mutation',q=>{q.events[41].type='tool/call';}],
 ['partial output',q=>{q.events[41].data.chunk.type='text-delta';}],
 ['wrong raw replacement model',q=>{q.raw[3].model='other';}],
 ['wrong policy',q=>{q.policy.initialDelayMs=800;}],
 ['raw failure absent',q=>{q.raw.splice(1,1);}],
])test('telemetry join rejects '+name,()=>{const A=require('../scripts/bench/ccv2-lhcb-02/provider-accounting.cjs'),q=joined();mutate(q);A.attach(q.x.requests,q.events,q.record,q.raw,q.policy,true);assert.equal(calibration(q.x.phases,q.x.requests).status,'FAIL');});
test('raw reader fails closed for missing or malformed capture without creating files',()=>{
 const A=require('../scripts/bench/ccv2-lhcb-02/provider-accounting.cjs'),root=S.path.join(tmp,'raw-reader'),file=S.path.join(root,'nexus-root/logs/provider-observability.jsonl');
 assert.deepEqual(A.readEvidence(root),[]);assert(!S.fs.existsSync(root));S.fs.mkdirSync(S.path.dirname(file),{recursive:true});S.fs.writeFileSync(file,'{"truncated":');assert.deepEqual(A.readEvidence(root),[]);assert.equal(S.fs.readFileSync(file,'utf8'),'{"truncated":');
});
test('accounting reads the pinned provider resolver without configuring or calling it',()=>{
 const A=require('../scripts/bench/ccv2-lhcb-02/provider-accounting.cjs'),root=S.path.join(tmp,'policy-reader'),install=S.path.join(root,'nexus-root');
 for(const dir of ['app','config','data'])S.fs.mkdirSync(S.path.join(install,dir),{recursive:true});
 S.fs.cpSync(S.path.join(S.os.homedir(),'.local/share/nexus/app/node_modules'),S.path.join(install,'app/node_modules'),{recursive:true});
 const config=S.path.join(install,'config/settings.yaml'),data=S.path.join(install,'data/settings.yaml');
 S.fs.writeFileSync(config,'llm-pi-ai:\n  providers:\n    opencode-go: {}\n');S.fs.writeFileSync(data,'{}\n');
 const originals=[config,data].map(p=>S.fs.readFileSync(p,'utf8'));
 assert.equal(A.policyKey(A.resolvedPolicy(root)),'["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]');
 assert.deepEqual([config,data].map(p=>S.fs.readFileSync(p,'utf8')),originals);
 S.fs.writeFileSync(config,'{}\n');assert.equal(A.resolvedPolicy(root),null);
});
test('calibration requires all six stages, >=10k each, and monotonic total input',()=>{let x=good();assert.equal(calibration(x.phases,x.requests).status,'PASS');x.phases[0].pressureGrowth=9999;assert.equal(calibration(x.phases,x.requests).status,'FAIL');x=good();x.requests[2].providerInputTokens=1;assert(calibration(x.phases,x.requests).reasons.includes('provider-input-not-monotonic'));assert.equal(calibration([],[]).status,'FAIL');});
test('unverifiable accepted provider or model identity stays fatal',()=>{for(const key of ['provider','model']){const x=good();delete x.requests[2][key];assert.equal(calibration(x.phases,x.requests).status,'FAIL');}});
for(const [key,value] of [['compactionEvents',1],['historyReplacements',1],['acceptance',false],['toolCalls',1],['terminalContentHash',null],['evidenceSetHash',null]])test('calibration rejects '+key,()=>{const x=good();x.phases[1][key]=value;assert.equal(calibration(x.phases,x.requests).status,'FAIL');});
test('repeated evidence and terminal hashes cannot pass',()=>{const x=good();x.phases[1].newToolEvidenceHashes=x.phases[0].newToolEvidenceHashes;x.phases[1].terminalContentHash=x.phases[0].terminalContentHash;assert.equal(calibration(x.phases,x.requests).status,'FAIL');});
test('compiled requests and missing wire observation cannot pass',()=>{for(const patch of [{mode:'COMPILED'},{compilerExecutionCount:1},{requestHash:null},{providerInputTokens:null}]){const x=good();Object.assign(x.requests[2],patch);assert.equal(calibration(x.phases,x.requests).status,'FAIL');}});
test('workload eligibility and benefit are gated before scoring',()=>{assert.deepEqual(benefit(null,[]),workload(null));assert.equal(workload(null).ccv2BenefitVerdict,'NOT_MEASURED');const evidence={cp500:{natural:true,pressureTokens:500000,snapshotSeal:'a'.repeat(64)},meaningfulEvidenceDiversity:true,noRepeatedPadding:true,sustainedPressureGrowth:true,noHiddenHistoryTruncation:true,noUnintendedDshCompaction:true};assert.equal(workload(evidence).verdict,'WORKLOAD_INADEQUATE');assert.equal(benefit(evidence,[]).ccv2BenefitVerdict,'NOT_MEASURED');for(const key of Object.keys(evidence)){const x={...evidence,[key]:null};assert.equal(workload(x).verdict,'WORKLOAD_INADEQUATE');}});
test('phase graph is acyclic, 54 major stages and T99 does not restate obligations',()=>{const manifest=require('../benchmarks/ccv2-lhcb-02/phase-manifest.json');const seen=new Set();for(const p of manifest.phases){for(const dep of p.dependsOn)assert(seen.has(dep));seen.add(p.id);}assert.equal(manifest.phases.filter(p=>/^E\d+$/.test(p.id)).length,54);const t99=S.fs.readFileSync(S.path.join(S.BENCH,'prompts/T99-engineering.md'),'utf8');assert.doesNotMatch(t99,/currency|tenant|replay|prefix|schema/);assert.equal(S.manifest.officialExecutionEnabled,false);});
test('fixture has fresh deterministic cases and actual failing source across six stages',()=>{const dir=S.path.join(tmp,'fixture');fixture.createFixture(dir);const hashes=new Set();for(const id of S.manifest.calibration.phases){const files=fixture.phaseFiles(id);assert.deepEqual(files,fixture.phaseFiles(id));const h=S.hash(S.json(files));assert(!hashes.has(h));hashes.add(h);fixture.release(dir,id);const result=require('node:child_process').spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(dir,'tools/verify.cjs'),id],{encoding:'utf8'});assert.equal(result.status,1);const summary=JSON.parse(result.stdout);assert(summary.failures>0);assert(summary.cases>100);const inputs=fixture.cases(id).map(r=>S.hash(S.json(r.input)));assert.equal(new Set(inputs).size,inputs.length);}});
test('phase release resumes a partial release but never replaces edits or evidence',()=>{const root=S.path.join(tmp,'release');S.fs.mkdirSync(S.path.join(root,'workspace'),{recursive:true});const hash=release(root,'E01');S.fs.appendFileSync(S.path.join(root,'workspace/src/domain.ts'),'\n// task edit');assert.equal(release(root,'E01'),hash);const second=S.path.join(tmp,'conflict');S.fs.mkdirSync(S.path.join(second,'workspace/src'),{recursive:true});S.fs.writeFileSync(S.path.join(second,'workspace/src/domain.ts'),'unrelated');assert.throws(()=>release(second,'E01'),/release-conflict/);});
test('all visible verifiers and independent holdouts pass with correct reference behavior',()=>{const root=S.path.join(tmp,'reference');fixture.createFixture(S.path.join(root,'workspace'));for(const id of S.manifest.calibration.phases){fixture.release(S.path.join(root,'workspace'),id);const source='const scales={USD:2,EUR:2,JPY:0,KWD:3};const oracle='+fixture.oracle.toString()+';module.exports={evaluate:x=>oracle('+JSON.stringify(id)+',x)};';S.fs.writeFileSync(S.path.join(root,'workspace/src/'+fixture.modules[id]+'.ts'),source);for(const [p,code] of Object.entries(fixture.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(root,'workspace/'+p),code);}const rows=acceptance(root,S.manifest.calibration.phases);assert(rows.every(x=>x.pass));assert(rows.at(-1).probes.length>=9);});
test('namespace loader leaves frozen exports unchanged; old roots and official commands reject',async()=>{const old=require('../scripts/bench/ccv2-lhcb/state.cjs');assert.equal(old.manifest.benchmarkId,'CCV2-LHCB-01');assert.equal(load('autorunner').authority.benchmarkId,'CCV2-LHCB-02');assert.throws(()=>S.rootOf(S.os.homedir()+'/nexus-bench/ccv2-lhcb-01'),/historical-root/);await assert.rejects(require('../scripts/bench/ccv2-lhcb-02/cli.cjs').main(['run-all',tmp]),/calibration-only/);});
test('prepare stages frozen source and new fixture offline with native policy',async()=>{
 const root=S.path.join(tmp,'prepared');const result=await require('../scripts/bench/ccv2-lhcb-02/cli.cjs').main(['prepare',root]);
 assert.equal(result.providerCalls,0);assert.equal(S.read(S.path.join(root,'state/identity.json')).benchmarkId,'CCV2-LHCB-02');
 assert.equal(S.read(S.path.join(root,'state/fixture.json')).revision,'ledger-lab-v2');
 assert.equal(S.read(S.path.join(root,'nexus-root/config/routing-policy.json')).contextCompiler.mode,'off');
 assert(S.fs.existsSync(S.path.join(root,'workspace/src/persistence.ts')));assert(!S.fs.existsSync(S.path.join(root,'state/calibration-journal.json')));
});
// Task 2: failures reproduced before benchmark hardening.
test('red team: boolean workload claims cannot authorize a benefit verdict',()=>{
 const forged={cp500:{natural:true,pressureTokens:500000,snapshotSeal:'a'.repeat(64)},meaningfulEvidenceDiversity:true,noRepeatedPadding:true,sustainedPressureGrowth:true,noHiddenHistoryTruncation:true,noUnintendedDshCompaction:true};
 assert.equal(workload(forged).officialBenefitEligible,false);assert.equal(benefit(forged,[]).ccv2BenefitVerdict,'NOT_MEASURED');
});
test('red team: semantic duplicates cannot become fresh evidence using tool call IDs',()=>{
 const T=require('../scripts/bench/ccv2-lhcb-02/telemetry.cjs');const record={promptId:'E01',startSeq:0,endSeq:1,before:{pressureTokens:0},after:{pressureTokens:20000}};
 const result=id=>({type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:id,content:[{type:'text',text:'same source bytes'}]}]}}});
 const a=T.phaseSummary({events:[result('call-A')]},{...record,endSeq:0},[]),b=T.phaseSummary({events:[result('call-B')]},{...record,endSeq:0},[]);
 assert.deepEqual(a.newToolEvidenceHashes,b.newToolEvidenceHashes);
});
test('red team: empty acceptance evidence cannot pass a phase',()=>{
 const root=S.path.join(tmp,'empty-grade');S.fs.mkdirSync(S.path.join(root,'workspace'),{recursive:true});fixture.createFixture(S.path.join(root,'workspace'));
 const Runner=require('../scripts/bench/ccv2-lhcb-02/autorunner.cjs').CalibrationRunner;
 const r=Object.create(Runner.prototype);r.root=root;r.options={acceptance:()=>[]};r.save=()=>{};
 const stage={promptId:'E01',protectedHashes:require('../scripts/bench/ccv2-lhcb-02/autorunner.cjs').protectedHashes(root)};
 r.finishAcceptance(stage);assert.equal(stage.acceptance,false);
});
test('red team: completed release receipts do not excuse missing evidence',()=>{
 const root=S.path.join(tmp,'deleted-evidence');S.fs.mkdirSync(S.path.join(root,'workspace'),{recursive:true});release(root,'E01');
 S.fs.unlinkSync(S.path.join(root,'workspace/evidence/E01/incident.json'));assert.throws(()=>release(root,'E01'),/evidence|release/);
});
test('red team: candidate code cannot forge verifier stdout and exit successfully',()=>{
 const root=S.path.join(tmp,'forge-grade');fixture.createFixture(S.path.join(root,'workspace'));release(root,'E01');
 S.fs.writeFileSync(S.path.join(root,'workspace/src/domain.ts'),`process.stdout.write(JSON.stringify({phase:'E01',status:'PASS',failures:0,cases:440,pass:true,probes:[]})+'\n');process.exit(0);`);
 assert(acceptance(root,['E01']).every(r=>r.pass===false));
});
test('red team: candidate code cannot modify host assertions or read holdouts',()=>{
 const root=S.path.join(tmp,'tamper-assert');fixture.createFixture(S.path.join(root,'workspace'));release(root,'E01');
 S.fs.writeFileSync(S.path.join(root,'workspace/src/domain.ts'),`require('node:assert/strict').equal=()=>{};module.exports={evaluate:()=>({accepted:true,scale:2})};`);
 assert.equal(require('../benchmarks/ccv2-lhcb-02/grader/probes.cjs').grade(S.path.join(root,'workspace'),['E01']).pass,false);
});
test('red team: diagnostics are bounded and do not dump a failure matrix for tokens',()=>{
 const root=S.path.join(tmp,'diagnostics');fixture.createFixture(root);fixture.release(root,'E01');
 const result=require('node:child_process').spawnSync(process.execPath,[S.path.join(root,'tools/verify.cjs'),'E01','--diagnose'],{encoding:'utf8'});
 assert.equal(result.status,1);const lines=result.stdout.trim().split('\n').map(JSON.parse);assert(lines.length<=9);assert(lines.at(-1).failures>8);
});
test('red team: partial base fixture generation resumes only identical bytes',()=>{
 const root=S.path.join(tmp,'partial-base');const files=fixture.baseFiles();const [first]=Object.entries(files);S.fs.mkdirSync(root,{recursive:true});S.fs.writeFileSync(S.path.join(root,first[0]),first[1]);fixture.createFixture(root);
 assert.equal(S.fs.readFileSync(S.path.join(root,'src/service.ts'),'utf8'),files['src/service.ts']);S.fs.appendFileSync(S.path.join(root,first[0]),'changed');assert.throws(()=>fixture.createFixture(root),/generation-conflict/);
});
test('red team: average and median cannot excuse a weak or dominating phase',()=>{
 const x=good();x.phases[0].pressureGrowth=1000000;assert.equal(calibration(x.phases,x.requests).status,'FAIL');
 const y=good();y.phases[0].pressureGrowth=9999;assert.equal(calibration(y.phases,y.requests).status,'FAIL');assert.equal(calibration(good().phases,good().requests).medianPressureGrowth,20000);
});
test('red team: identity, sequence, cache totals and optional unavailable values are checked',()=>{
 for(const patch of [{requestIdentity:S.hash('identity0')},{taskInstanceId:'different'},{durableSequenceRange:[0,3]},{cacheReadTokens:10},{outputTokens:null},{requestOutcome:'FAILED'},{pressureDelta:0}]){const x=good();Object.assign(x.requests[2],patch);assert.equal(calibration(x.phases,x.requests).status,'FAIL',JSON.stringify(patch));}
});
test('red team: unexpected candidate imports and constructor escapes cannot access grading host',()=>{
 for(const [i,source] of [`module.exports={evaluate:()=>require('node:fs').readFileSync(__filename)};`,`module.exports={evaluate:()=>({}).constructor.constructor('return process')()};`].entries()){
  const root=S.path.join(tmp,'escape-'+i);fixture.createFixture(root);fixture.release(root,'E01');S.fs.writeFileSync(S.path.join(root,'src/domain.ts'),source);
  assert.throws(()=>require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(root).evaluate('domain',{}));
 }
});
test('red team: arm comparison rejects unequal histories, sources, graders, prompt or unrelated policy',()=>{
 const Fair=require('../scripts/bench/ccv2-lhcb-02/fairness.cjs');
 const runs=['native','production','forced'].map(arm=>({arm,snapshotSeal:'a'.repeat(64),workspaceHash:'b'.repeat(64),durableStateHash:'c'.repeat(64),sessionLogHash:'d'.repeat(64),sessionId:'session-offline',taskId:'TASK-0001',taskInstanceId:'instance',provider:S.manifest.provider,model:S.manifest.model,productionSourceHash:'e'.repeat(64),graderHash:'f'.repeat(64),contractHash:S.contractHash(),promptHash:S.hash(S.fs.readFileSync(S.path.join(S.BENCH,'prompts/T99-engineering.md'))),policy:{contextCompiler:{...S.manifest.arms[arm],other:3},other:7}}));
 assert.equal(Fair.compare(runs).pass,true);
 for(const field of ['snapshotSeal','workspaceHash','durableStateHash','sessionLogHash','sessionId','taskId','taskInstanceId','provider','model','productionSourceHash','graderHash','promptHash']){const changed=structuredClone(runs);changed[1][field]='different';assert.equal(Fair.compare(changed).pass,false,field);}
 const changed=structuredClone(runs);changed[1].policy.other=9;assert.equal(Fair.compare(changed).pass,false);assert.equal(workload(runs).officialBenefitEligible,false);
});
test('red team: checkpoint and restore entry points fail closed before any destructive action',()=>{
 for(const name of ['snapshot','restore','collect','report','score'])assert.throws(()=>load(name),/official-disabled/);
 assert.equal(load('autorunner').AutoRunner.prototype.runAll,undefined);assert.equal(load('autorunner').AutoRunner.prototype.checkpoint,undefined);assert.equal(load('arms').start,undefined);
});
test('red team: prepare crash does not publish a partial root and resumes owned staging',()=>{
 const prepare=require('../scripts/bench/ccv2-lhcb-02/prepare.cjs').prepare,root=S.path.join(tmp,'prepare-crash');
 assert.throws(()=>prepare(root,{fault:point=>{if(point==='after-init')throw Error('simulated power loss');}}),/power loss/);
 assert(!S.fs.existsSync(S.path.join(root,'state/identity.json')));assert(prepare(root).prepared);assert.equal(S.read(S.path.join(root,'nexus-root/config/routing-policy.json')).contextCompiler.mode,'off');
});
test('red team: serialization hooks cannot conceal candidate input mutation',()=>{
 const root=S.path.join(tmp,'serialization-hook');fixture.createFixture(root);fixture.release(root,'E02');
 S.fs.writeFileSync(S.path.join(root,'src/migrations.ts'),`module.exports={evaluate:input=>{const before=JSON.parse(JSON.stringify(input));input.document.version=1;input.toJSON=()=>before;return {rejected:true};}};`);
 const sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(root);assert.throws(()=>sandbox.evaluate('migrations',{document:{version:19,records:[]}}),/grader-output-not-json/);
});
test('red team: candidate cannot replace trusted serialization helpers',()=>{
 const root=S.path.join(tmp,'helper-binding');fixture.createFixture(root);fixture.release(root,'E02');
 S.fs.writeFileSync(S.path.join(root,'src/migrations.ts'),`module.exports={evaluate:input=>{const before=JSON.parse(JSON.stringify(input));__snapshot=x=>x;input.document.version=1;input.toJSON=()=>before;return {rejected:true};}};`);
 assert.throws(()=>require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(root).evaluate('migrations',{document:{version:19,records:[]}}));
});

test('grader supports Node structuredClone for immutable JSON documents and opaque keys',()=>{
 const root=S.path.join(tmp,'clone-json');fixture.createFixture(root);S.fs.writeFileSync(S.path.join(root,'src/clone.ts'),`module.exports={evaluate:input=>{const copy=structuredClone(input);copy.metadata.notes.push('cloned');return copy;}};`);
 const input=JSON.parse('{"version":2,"records":[{"id":"001","amount":17}],"metadata":{"notes":[],"__proto__":{"opaque":true}}}');const expected=structuredClone(input);expected.metadata.notes.push('cloned');
 const result=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(root).evaluate('clone',input);assert.deepEqual(result.output,expected);assert.deepEqual(result.input,input);
});
test('grader clone retains internal aliases, cycles, collection values and clone errors',()=>{
 const root=S.path.join(tmp,'clone-graph');fixture.createFixture(root);S.fs.writeFileSync(S.path.join(root,'src/clone.ts'),`module.exports={evaluate:()=>{const shared={value:3},input={a:shared,b:shared,map:new Map([['opaque',shared]]),set:new Set([shared]),date:new Date(1234),bytes:new Uint8Array([1,2])};input.self=input;const copy=structuredClone(input);copy.a.value=7;let rejected=false;try{structuredClone(()=>0);}catch(e){rejected=e.name==='DataCloneError';}return {alias:copy.a===copy.b,self:copy.self===copy,distinct:copy.a!==input.a,original:input.a.value,map:copy.map.get('opaque')===copy.a,set:copy.set.has(copy.a),time:copy.date.getTime(),bytes:Array.from(copy.bytes),rejected};}};`);
 assert.deepEqual(require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(root).evaluate('clone',{}).output,{alias:true,self:true,distinct:true,original:3,map:true,set:true,time:1234,bytes:[1,2],rejected:true});
});
test('grader clone function and clone exceptions expose no grading host constructors',()=>{
 for(const [i,source] of [`module.exports={evaluate:()=>structuredClone.constructor.constructor('return process')()};`,`module.exports={evaluate:()=>{try{structuredClone(()=>0);}catch(e){return e.constructor.constructor('return process')();}}};`].entries()){
  const root=S.path.join(tmp,'clone-escape-'+i);fixture.createFixture(root);S.fs.writeFileSync(S.path.join(root,'src/clone.ts'),source);assert.throws(()=>require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(root).evaluate('clone',{}),/Code generation from strings disallowed/);
 }
});
