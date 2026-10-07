#!/usr/bin/env node
'use strict';
const {S,load,authority}=require('./infrastructure.cjs'),B=require('./controller-bootstrap.cjs');
const T=require('./telemetry.cjs'),V=require('./validity.cjs'),Snapshots=require('./official-snapshot.cjs');
const {release,acceptance,protectedHashes}=require('./autorunner.cjs');
const P=require('./official-provider-policy.cjs'),Scratch=require('./scratch.cjs');
const M=require('../ccv2-lhcb/metrics.cjs'),cp=require('node:child_process');
const Provider=require('./provider-accounting.cjs');
const Session=load('session'),D=load('doctor'),ids=S.manifest.candidatePhases,arms=['native','production','forced'];
const same=(a,b)=>S.json(a)===S.json(b),identity=b=>Object.fromEntries(['sessionId','taskId','taskInstanceId'].map(k=>[k,b[k]]));
function protocolHash(){return S.hash(S.workloadHash()+['official-runner.cjs','official-snapshot.cjs','official-provider-policy.cjs'].map(f=>S.fs.readFileSync(S.path.join(__dirname,f),'utf8')).join('\0'));}
function prompt(id){if(!ids.includes(id))S.fail('lhcb02-official-phase');const names=S.fs.readdirSync(S.path.join(S.BENCH,'prompts')).filter(f=>f.startsWith(id+'-'));if(names.length!==1)S.fail('lhcb02-official-prompt');const text=S.fs.readFileSync(S.path.join(S.BENCH,'prompts',names[0]),'utf8');return {text,hash:S.hash(text)};}
function routeEvidence(b,a,required=false){const rows=b.events.filter(e=>e.type==='request/header'||e.type==='request/context');if(required&&!rows.length)S.fail('runner-provider-model-unobserved');for(const e of rows){const c=e.type==='request/header'?e.data.header?.config:e.data;if(c?.provider!==a.provider||c?.model!==a.model)S.fail('runner-provider-model-mismatch');}}
function completion(events,r){
 const users=events.filter(e=>e.seq>=r.startSeq&&e.type==='user/message'&&(!e.data.source||e.data.source.kind==='user'));
 if(!users.length)return null;if(users.length!==1)S.fail('runner-duplicate-prompt-evidence');const u=users[0];
 if(u.data.source?.rpcId!==r.rpcId||S.hash(u.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))!==r.promptHash)S.fail('runner-prompt-provenance-mismatch');
 const turn=events.slice(0,u.seq+1).findLast(e=>e.type==='turn/start'),end=events.find(e=>e.seq>u.seq&&e.type==='turn/end');
 if(!end)return null;if(!turn||end.data.turn!==turn.data.turn)S.fail('runner-turn-identity-mismatch');
 if(end.data.reason?.kind!=='completed'){const failure=P.failedGeneration(events,turn,end);if(failure)throw new P.ProviderFailure(failure);S.fail('runner-turn-failed');}return {endSeq:end.seq,agentLatencyMs:end.time-turn.time};
}
function verifyCalibration(raw){
 const root=S.rootOf(raw),marker=S.read(S.inside(root,'state/identity.json')),report=S.read(S.inside(root,'reports/calibration.json')),journal=S.read(S.inside(root,'state/calibration-journal.json'));
 if(marker.contractHash!==S.contractHash())S.fail('lhcb02-official-calibration-required');
 if(report.protocolRevision!==S.manifest.protocolRevision||!same(report.scratchPolicy,Scratch.POLICY)||marker.benchmarkId!==S.manifest.benchmarkId||marker.baseSha!==S.manifest.baseSha||marker.root!==root||marker.contractHash!==report.contractHash||journal.contractHash!==report.contractHash||journal.phase!=='COMPLETE'||report.workloadHash!==S.workloadHash()||report.calibration?.status!=='PASS'||S.fs.existsSync(S.inside(root,'state/simulation.json'))||journal.stages.length!==S.manifest.stages.length)S.fail('lhcb02-official-calibration-required');
 Scratch.assertEmpty(root);const b=Session.binding(root);routeEvidence(b,journal.creation.authority,true);
 for(const [i,r] of journal.stages.entries()){
  if(r.scratchBefore?.emptyAfterReset!==true||r.scratchAfter?.emptyAfterReset!==true||r.scratchBefore?.policyRevision!==Scratch.POLICY.revision||r.scratchAfter?.policyRevision!==Scratch.POLICY.revision||r.promptId!==S.manifest.stages[i]||r.phase!=='FLUSHED'||r.acceptance!==true||r.promptHash!==prompt(r.promptId).hash||!same(identity(r),identity(b))||!same(identity(b),journal.identity)||S.hash(S.json(b.events.slice(0,r.startSeq)))!==r.prefixHash||S.hash(S.json(b.events.slice(0,r.endSeq+1)))!==r.durableEventsHash||completion(b.events.slice(0,r.endSeq+1),r)?.endSeq!==r.endSeq)S.fail('lhcb02-official-calibration-evidence');
 }
 if(T.compilerObservation(root).mode!=='NATIVE'||!D.sourceGuard(S.REPO,S.inside(root,'nexus-root')).pass)S.fail('lhcb02-official-calibration-source');
 const requests=journal.stages.flatMap(r=>T.collectRequests(root,b,r));
 const phases=journal.stages.slice(1).map(r=>T.phaseSummary(b,r,requests.filter(x=>x.phase===r.promptId))),result=V.calibration(phases,requests);
 if(result.status!=='PASS'||!acceptance(root,S.manifest.calibration.phases).every(r=>r.pass))S.fail('lhcb02-official-calibration-invalid');
 return {root,reportHash:S.hash(S.json(report)),workloadHash:S.workloadHash(),calibration:result,phases};
}
function decisions(root,start){
 const file=S.inside(root,'nexus-root/data/logs/aih-controller.log');if(!S.fs.existsSync(file))return [];
 return S.fs.readFileSync(file).subarray(start).toString('utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.event==='ccv2-opencode-active-decided').map(r=>Object.fromEntries(['projectionMode','compilerExecutions','fallbackReason','activationDecision','activationReason','activationBasis','activationTokens','pressureTokens','authorityHealth','policyMode','requestSeq'].map(k=>[k,r[k]??null])));
}
function finalGrade(root){const r=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(S.BENCH,'grader/final.cjs'),S.inside(root,'workspace')],{encoding:'utf8',timeout:300000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,NODE_OPTIONS:''}});let g;try{g=JSON.parse(r.stdout);}catch{}if(r.status!==0||g?.kind!=='OFFLINE_CANDIDATE_CORRECTNESS'||typeof g.pass!=='boolean')S.fail('lhcb02-official-grader-unavailable');return g;}
function compare(results){
 const a=results.find(r=>r.arm==='native'),comparisons={};
 for(const arm of ['production','forced']){const b=results.find(r=>r.arm===arm),available=a?.valid===true&&b?.valid===true&&a.metrics.providerInputTokensTotal>0&&a.metrics.steps>0;
  const inputReduction=available?1-b.metrics.providerInputTokensTotal/a.metrics.providerInputTokensTotal:null,stepIncrease=available?b.metrics.steps/a.metrics.steps-1:null,latencyImpact=available&&a.agentLatencyMs>0?b.agentLatencyMs/a.agentLatencyMs-1:null;
  const quality=available&&a.grade.pass&&b.grade.pass;
  comparisons[arm]={available,inputReduction,stepIncrease,latencyImpact,correctness:!!quality,meaningful:!!quality&&inputReduction+1e-12>=S.manifest.acceptance.meaningfulReduction&&stepIncrease<=S.manifest.acceptance.maxStepIncrease+1e-12,headline:!!quality&&inputReduction+1e-12>=S.manifest.acceptance.headlineReduction&&stepIncrease<=S.manifest.acceptance.maxStepIncrease+1e-12};
 }
 const p=results.find(r=>r.arm==='production'),f=results.find(r=>r.arm==='forced');
 return {comparisons,compilerCapability:f?.valid&&f.metrics.compiledRequests>0?(comparisons.forced.meaningful?'PASS':'FAIL'):'INSUFFICIENT_DATA',productionBenefit:p?.valid?(p.metrics.compiledRequests===0?'NOT_TRIGGERED':comparisons.production.meaningful?'PASS':'FAIL'):'INSUFFICIENT_DATA',reasoningContinuitySafety:p?.valid&&a?.valid?(p.metrics.pressurePolicyMatches&&p.grade.pass&&a.grade.pass?'PASS':'FAIL'):'INSUFFICIENT_DATA',forcedContinuity:f?.valid&&a?.valid?(f.grade.pass&&a.grade.pass?'PASS':'FAIL'):'INSUFFICIENT_DATA'};
}
class OfficialRunner{
 constructor(root,calibration,options={}){this.root=S.owned(root);this.calibration=calibration;this.options=options;this.env=options.env||process.env;this.transport=options.transport||load('agent-transport').createTransport(root,this.env,{spawn:require('./isolation.cjs').spawnIsolated});this.journal={kind:'LIVE_OFFICIAL',protocolRevision:S.manifest.protocolRevision,scratchPolicy:Scratch.POLICY,protocolHash:protocolHash(),workloadHash:S.workloadHash(),calibration,stages:[],arms:[],phase:'PREPARING',providerFailurePolicy:P.POLICY,providerAborts:[...(options.prefixAborts||[])]};}
 save(){S.write(S.inside(this.root,'state/official-journal.json'),this.journal);}
 preflight(arm){S.ready(this.root);const d=D.doctor(this.root);if(!d.sourceGuard.pass||!d.runtime.ready||!d.liveReady||d.certification.state!=='valid')S.fail('lhcb02-official-preflight');for(const [k,v] of Object.entries(authority.thresholds))if(d.thresholds?.[k]!==v)S.fail('runner-threshold-mismatch');const policy=S.read(S.inside(this.root,'nexus-root/config/routing-policy.json'));if(!same(policy.contextCompiler,S.manifest.arms[arm]))S.fail('lhcb02-official-policy');}
 binding(required=false){const b=Session.binding(this.root);if(!same(identity(b),identity(this.journal.identity)))S.fail('runner-session-task-identity-drift');routeEvidence(b,this.journal.identity,required);return b;}
 async prepare(){
  this.preflight('native');const adapter=B.createAdapter(this.root),sid='session-'+S.crypto.randomUUID();await adapter.create(sid);this.journal.identity=B.exact(await adapter.prepare(sid),sid);await adapter.verify(this.journal.identity);
  const dir=S.inside(this.root,'nexus-root/data/sessions'),files=[];for(const w of S.fs.readdirSync(dir))for(const leaf of ['session.jsonl','session.jsonl.zstd']){const rel='nexus-root/data/sessions/'+w+'/'+sid+'/'+leaf;if(S.fs.existsSync(S.inside(this.root,rel)))files.push(rel);}if(files.length!==1)S.fail('runner-new-session-artifact-ambiguous');Session.bind(this.root,files[0]);if(!B.blankEvents(this.binding().events))S.fail('lhcb02-official-new-session');this.save();await this.transport.start();await this.transport.resume(sid);
 }
 async observeFlush(b,r,now){try{return await this.transport.flush(b.sessionId);}catch(e){if(!/^lhcb-runner-session-export-(?:unavailable|http-(?:408|425|429|5\d\d))$/.test(e.message))throw e;(r.statusObservationFailures??=[]).push({at:now(),code:e.message});return false;}}
 async waitCompletion(b,r){
  const now=this.options.now||Date.now,pause=this.options.pause||(()=>new Promise(resolve=>setTimeout(resolve,250)));const until=now()+(this.options.turnTimeoutMs??(r.promptId==='T99'?2700000:900000));
  for(;;){let status;try{status=await this.transport.status(b.sessionId);}catch(e){if(e.message!=='lhcb-runner-rpc-endpoint-unavailable')throw e;(r.statusObservationFailures??=[]).push({at:now(),code:e.message});}if(status&&(status.sessionId!==b.sessionId||status.cwd!==S.inside(this.root,'workspace')))S.fail('runner-status-malformed');if(status?.status==='running'&&now()>=(r.nextProviderObservationAt??0)){r.nextProviderObservationAt=now()+P.POLICY.providerRetryObservationMs;if(await this.observeFlush(b,r,now)){const observed=this.binding();routeEvidence(observed,this.journal.identity,false);if(S.hash(S.json(observed.events.slice(0,r.startSeq)))!==r.prefixHash)S.fail('runner-session-prefix-drift');const failure=P.observedRetry(observed.events,r);if(failure){routeEvidence(observed,this.journal.identity,true);await this.transport.stop({preSubmitFailure:true});if(this.binding().events.slice(r.startSeq).some(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed'))S.fail('EXTERNAL_BLOCKER_PROVIDER_INSTABILITY');failure.retryTelemetry=P.retryTelemetry(this.binding().events.slice(r.startSeq));throw new P.ProviderFailure(failure);}}}
   if(status?.status==='idle'&&await this.observeFlush(b,r,now)===true){const after=this.binding();routeEvidence(after,this.journal.identity,true);if(S.hash(S.json(after.events.slice(0,r.startSeq)))!==r.prefixHash)S.fail('runner-session-prefix-drift');const done=completion(after.events,r);if(done){Object.assign(r,done,{phase:'FLUSHED',durableEventsHash:S.hash(S.json(after.events.slice(0,done.endSeq+1)))});break;}}
   if(now()>until)S.fail('runner-durable-completion-timeout');await pause();
  }
 }
 async stage(id,records,arm='native'){
  this.preflight(arm);const scratchBefore=Scratch.reset(this.root);const set=release(this.root,id),b=this.binding(),bank=prompt(id),r={promptId:id,promptHash:bank.hash,rpcId:'lhcb-'+S.crypto.randomUUID(),...identity(b),startSeq:b.events.length,prefixHash:S.hash(S.json(b.events)),evidenceSetHash:set,protectedHashes:protectedHashes(this.root),scratchBefore,phase:'SUBMITTED',submitAt:Date.now()};records.push(r);this.save();
  await this.transport.submit(b.sessionId,bank.text,r.rpcId);
  await this.waitCompletion(b,r);
  if(this.binding().events.slice(r.startSeq,r.endSeq+1).some(e=>e.type==='llm/retry'||e.type==='llm/retry-started'))S.fail('EXTERNAL_BLOCKER_PROVIDER_INSTABILITY');
  Scratch.assertCandidate(this.root);r.scratchAfter=Scratch.reset(this.root);
  if(!same(protectedHashes(this.root),r.protectedHashes))S.fail('lhcb02-evidence-modified');
  const cumulative=ids.slice(1,ids.indexOf(id)+1);r.acceptanceResults=id==='T00'?[]:acceptance(this.root,cumulative);r.acceptance=id==='T00'||r.acceptanceResults.length===cumulative.length+1&&r.acceptanceResults.every(x=>x.pass);
  r.pressure=Session.currentPressure(this.root).pressureTokens;const rows=T.collectRequests(this.root,this.binding(true),r);S.write(S.inside(this.root,'reports/stage-'+(arm||'accumulation')+'-'+id+'.json'),{record:r,requests:rows});this.save();return r;
 }
 async accumulate(){
  await this.prepare();this.journal.phase='ACCUMULATING';this.save();
  for(const id of ids.slice(0,-1)){
   const r=await this.stage(id,this.journal.stages);
   if(r.acceptance&&r.pressure>=480000&&r.pressure<=550000&&this.journal.stages.length>=7){const until=Date.now()+60000;while(!Snapshots.memoryReady(this.root)){if(Date.now()>until)S.fail('lhcb02-official-memory-timeout');await new Promise(resolve=>setTimeout(resolve,250));}await this.transport.close();const meta=Snapshots.seal(this.root,{identity:this.journal.identity,completedStages:this.journal.stages.map(r=>r.promptId),pressureTokens:r.pressure,protocolHash:protocolHash()});this.journal.snapshotHash=S.hash(S.json(meta));this.journal.phase='CHECKPOINTED';this.save();return meta;}
   if(r.pressure>550000)S.fail('lhcb02-official-natural-checkpoint-skipped');
  }
  // T99 is diagnostic only after the finite pre-checkpoint workload is exhausted.
  // Its solution and pressure can never enable a checkpoint or a comparison.
  const final=await this.stage('T99',this.journal.stages);await this.transport.close();
  this.journal.nativeDiagnostic={eligibleForComparison:false,grade:finalGrade(this.root),finalPressure:final.pressure,agentLatencyMs:this.journal.stages.reduce((sum,r)=>sum+r.agentLatencyMs,0),stages:this.journal.stages.map(r=>({phase:r.promptId,pressure:r.pressure,acceptance:r.acceptance}))};
  this.journal.phase='WORKLOAD_INADEQUATE';this.save();return null;
 }
 async armAttempt(arm,meta){
  const restored=Snapshots.restore(this.root);if(S.hash(S.json(restored))!==this.journal.snapshotHash||Snapshots.selected(this.root).files&&S.treeHash(Snapshots.selected(this.root).files)!==meta.baselineHash)S.fail('lhcb02-official-arm-baseline');
  const policyFile=S.inside(this.root,'nexus-root/config/routing-policy.json'),original=S.read(policyFile);S.write(policyFile,load('arms').configure(original,arm));this.preflight(arm);
  this.transport=load('agent-transport').createTransport(this.root,this.env,{spawn:require('./isolation.cjs').spawnIsolated});const startSeq=this.binding().events.length,logFile=S.inside(this.root,'nexus-root/data/logs/aih-controller.log'),startLogBytes=S.fs.statSync(logFile).size;
  const run={arm,startedAt:Date.now(),baselineHash:meta.baselineHash,snapshotSeal:this.journal.snapshotHash,sessionLogHash:meta.sessionLogHash,promptHash:prompt('T99').hash,identity:this.journal.identity,policy:S.read(policyFile),stages:[]};this.journal.arms.push(run);this.save();
  await this.transport.start();await this.transport.resume(this.journal.identity.sessionId);
  for(const id of ids.slice(meta.completedStages.length))await this.stage(id,run.stages,arm);
  await this.transport.close();const b=this.binding(true),events=b.events.slice(startSeq),ds=decisions(this.root,startLogBytes),activation=Session.activation(b.events,this.root,arm).rows.filter(row=>events.some(e=>e.type==='assistant/message'&&e.data.turn===row.turn&&e.data.step===row.step));
  const metrics=M.collectMetrics(events,ds,arm,{telemetryComplete:arm==='native'?ds.length===0:ds.length===events.filter(e=>e.type==='assistant/message').length,replayRows:activation,wallClockMs:run.stages.reduce((sum,r)=>sum+r.agentLatencyMs,0)});
  metrics.providerAccounting=Provider.accounting(run.stages.flatMap(r=>T.collectRequests(this.root,b,r)));
  metrics.scientificPressure={totalAcceptedProviderInputTokens:metrics.providerAccounting.successfulAcceptedProviderInputTokens,phaseBoundaries:run.stages.map(r=>({phase:r.promptId,pressureAfter:r.pressure}))};
  const validation=M.validateArm(metrics,arm);run.grade=finalGrade(this.root);run.metrics=metrics;run.decisions=ds;run.agentLatencyMs=metrics.wallClockMs;run.timing=P.summary(run.stages,Date.now()-run.startedAt);run.valid=validation.status==='VALID'&&Number.isFinite(metrics.providerInputTokensTotal)&&metrics.steps>0&&!metrics.infrastructureInvalid&&metrics.toolProtocolViolations===0;run.invalidReason=validation.reason;run.finalWorkspaceHash=S.treeHash(S.inventory(S.inside(this.root,'workspace')));this.save();S.write(S.inside(this.root,'reports/arm-'+arm+'.json'),run);return run;
 }
 async arm(arm,meta){
  const startedAt=Date.now(),aborts=[];
  for(;;){try{const run=await this.armAttempt(arm,meta);run.timing=P.summary(run.stages,Date.now()-startedAt,aborts);this.save();S.write(S.inside(this.root,'reports/arm-'+arm+'.json'),run);return run;}
   catch(e){if(!(e instanceof P.ProviderFailure))throw e;await this.transport.close();const failed=this.journal.arms.pop(),attempt=aborts.length+1,dir=S.inside(this.root,'reports/provider-aborted-'+arm+'-'+attempt);S.fs.mkdirSync(dir,{recursive:true});S.fs.cpSync(S.inside(this.root,'workspace'),S.path.join(dir,'workspace'),{recursive:true});S.fs.cpSync(S.inside(this.root,'nexus-root/data/sessions'),S.path.join(dir,'sessions'),{recursive:true});S.fs.copyFileSync(S.inside(this.root,'nexus-root/data/logs/aih-controller.log'),S.path.join(dir,'aih-controller.log'));const record={arm,attempt,evidence:e.evidence,run:failed,wallClockMs:Date.now()-failed.startedAt};S.write(S.path.join(dir,'attempt.json'),record);aborts.push(record);this.journal.providerAborts.push(record);this.save();P.budget(this.journal.providerAborts.filter(r=>r.arm===arm).length);}
  }
 }
 async execute(){
  const unlock=require('./lease.cjs').acquire(S.inside(this.root,'state/official-lock.json'),this.root);
  try{const meta=await this.accumulate();if(!meta){const report={kind:'LIVE_OFFICIAL_ATTEMPT',scientificallyValid:false,checkpoint:null,calibration:this.calibration,workloadValidity:'WORKLOAD_INADEQUATE',reason:'finite-workload-did-not-reach-natural-CP500',lastPreCheckpointPressure:this.journal.stages.findLast(r=>r.promptId!=='T99')?.pressure,nativeDiagnostic:this.journal.nativeDiagnostic,arms:[],compilerCapability:'INSUFFICIENT_DATA',productionBenefit:'NOT_MEASURED',reasoningContinuitySafety:'NOT_MEASURED'};S.write(S.inside(this.root,'reports/benchmark.json'),report);return report;}
   const native=await this.arm('native',meta);
   const nativeStages=[...this.journal.stages,...native.stages];const growth=nativeStages.map((r,i)=>({phase:r.promptId,growth:r.pressure-(i?nativeStages[i-1].pressure:0)}));const total=growth.reduce((sum,r)=>sum+r.growth,0),maximumPhaseShare=Math.max(...growth.map(r=>r.growth))/total;
   const nativeValidation={kind:'LIVE_NATIVE_CANDIDATE_VALIDATION',checkpointSeal:this.journal.snapshotHash,checkpointPressure:meta.pressureTokens,workloadHash:S.workloadHash(),completed:native.stages.at(-1)?.promptId==='T99',durableTelemetryValid:native.valid,maximumPhaseShare,perPhaseGrowth:growth,synthetic:false};nativeValidation.pass=nativeValidation.completed&&nativeValidation.durableTelemetryValid&&maximumPhaseShare<=S.manifest.calibration.maximumPhaseShare;
   S.write(S.inside(this.root,'reports/native-candidate-validation.json'),nativeValidation);if(!nativeValidation.pass)S.fail('lhcb02-official-native-candidate-invalid');
   for(const arm of arms.slice(1))await this.arm(arm,meta);
   const results=this.journal.arms,baselineEqual=results.every(r=>r.baselineHash===meta.baselineHash&&r.sessionLogHash===meta.sessionLogHash&&r.snapshotSeal===this.journal.snapshotHash&&r.promptHash===prompt('T99').hash&&same(r.identity,this.journal.identity));
   const report={kind:'LIVE_OFFICIAL_BENCHMARK',protocolRevision:S.manifest.protocolRevision,scratchPolicy:Scratch.POLICY,providerFailurePolicy:P.POLICY,providerFailurePolicyHash:S.hash(S.json(P.POLICY)),providerAborts:this.journal.providerAborts,workloadHash:S.workloadHash(),protocolHash:protocolHash(),frozenAcceptance:S.manifest.acceptance,calibration:this.calibration,checkpoint:{id:'CP-500',pressureTokens:meta.pressureTokens,afterPhase:meta.completedStages.at(-1),seal:this.journal.snapshotHash},armBaselineEquality:baselineEqual,scientificallyValid:baselineEqual&&results.length===3&&results.every(r=>r.valid),workloadValidity:baselineEqual&&results.length===3&&results.every(r=>r.valid)?'WORKLOAD_VALID':'WORKLOAD_INADEQUATE',arms:results,...compare(results)};S.write(S.inside(this.root,'reports/benchmark.json'),report);this.journal.phase='COMPLETE';this.save();return report;
  }catch(e){this.journal.phase='FAILED';this.journal.failure=e.message;this.save();S.write(S.inside(this.root,'reports/benchmark-failure.json'),{kind:'LIVE_OFFICIAL_ATTEMPT',scientificallyValid:false,failureCode:e.message,stages:this.journal.stages.map(r=>({phase:r.promptId,pressure:r.pressure,acceptance:r.acceptance})),providerFailurePolicy:P.POLICY,providerAborts:this.journal.providerAborts,providerEvidence:e.evidence??null,completedArms:this.journal.arms.filter(r=>r.metrics),calibration:this.calibration});throw e;}
  finally{try{await this.transport.close?.();}finally{unlock();}}
 }
}
async function main([raw,calibrationRoot,certificationSource],options={}){
 if(process.version!==S.manifest.nodeVersion||!raw||!calibrationRoot||!certificationSource)S.fail('lhcb02-official-arguments');const calibration=verifyCalibration(calibrationRoot),root=S.rootOf(raw);if(S.fs.existsSync(root))S.fail('lhcb02-official-fresh-root-required');require('./prepare.cjs').prepare(root);load('init').stageRuntime(root,S.os.homedir()+'/.local/share/nexus');P.configure(root);require('./certification.cjs').provision(root,certificationSource);return new OfficialRunner(root,calibration,options).execute();
}
async function boundedMain(args,run=main){const startedAt=Date.now(),aborts=[];for(;;){const attemptStartedAt=Date.now(),next=[...args];if(aborts.length)next[0]=args[0]+'-provider-retry-'+aborts.length;try{const report=await run(next,{prefixAborts:aborts});const timing=P.summary([],Date.now()-startedAt,aborts);report.nativePrefixProviderAttempts={totalBenchmarkWallClockMs:timing.totalWallClockArmDurationMs,providerRetryCount:timing.providerRetryCount,freshAttemptRetries:timing.freshAttemptRetries,providerRetryDelayMs:timing.providerRetryDelayMs,providerScheduledRetryDelayMs:timing.providerScheduledRetryDelayMs,abortedAttempts:aborts};S.write(S.inside(next[0],'reports/benchmark.json'),report);return report;}catch(e){if(!(e instanceof P.ProviderFailure))throw e;aborts.push({arm:'native',root:next[0],wallClockMs:Date.now()-attemptStartedAt,evidence:e.evidence});S.write(args[0]+'-provider-attempts.json',{policy:P.POLICY,verdict:aborts.length>=P.POLICY.maxProviderAbortedRunsPerArm?'EXTERNAL_BLOCKER_PROVIDER_INSTABILITY':'RETRYING_FRESH_ROOT',abortedAttempts:aborts});P.budget(aborts.length);}}}
if(require.main===module)boundedMain(process.argv.slice(2)).then(r=>{process.stdout.write(S.json(r));if(!r.scientificallyValid)process.exitCode=2;}).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
module.exports={boundedMain,OfficialRunner,verifyCalibration,protocolHash,prompt,completion,compare,decisions};
