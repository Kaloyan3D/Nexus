'use strict';
require('../benchmarks/ccv2-lhcb-01/grader/offline.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {S}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs');
const R=require('../scripts/bench/ccv2-lhcb-02/official-runner.cjs');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-evidence-'));
function writable(dir){if(!S.fs.existsSync(dir))return;for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const f=S.path.join(dir,e.name);if(e.isDirectory())writable(f);S.fs.chmodSync(f,e.isDirectory()?0o700:0o600);}S.fs.chmodSync(dir,0o700);}
after(()=>{assert.equal(global.lhcbOfflineAudit.attempts(),0);writable(tmp);S.fs.rmSync(tmp,{recursive:true,force:true});});
test('completed candidates, sessions and exact failures survive destruction by the next arm',()=>{
 const root=S.path.join(tmp,'root');for(const p of ['state','workspace/src','nexus-root/data/sessions/ws/session-test','nexus-root/data/logs','nexus-root/logs'])S.fs.mkdirSync(S.path.join(root,p),{recursive:true});
 S.write(S.path.join(root,'state/identity.json'),{root,benchmarkId:S.manifest.benchmarkId,baseSha:S.manifest.baseSha,contractHash:S.contractHash()});
 const session='nexus-root/data/sessions/ws/session-test/session.jsonl';
 for(const arm of ['native','production']){
  const source='module.exports={arm:'+JSON.stringify(arm)+'};';S.fs.writeFileSync(S.path.join(root,'workspace/src/application.ts'),source);
  S.fs.writeFileSync(S.path.join(root,session),JSON.stringify({type:'session',id:arm})+'\n');S.fs.writeFileSync(S.path.join(root,'nexus-root/data/logs/aih-controller.log'),JSON.stringify({event:'test',arm})+'\n');
  const grade={pass:false,caseDiagnostics:{public:[{caseId:'T99-1',expected:{status:403},actual:{status:200}}],hidden:[{caseId:'T99-holdout-1',expected:{history:[{state:'committed'}]},actual:{history:[]}}]}};
  const run={arm,finalWorkspaceHash:S.treeHash(S.inventory(S.path.join(root,'workspace'))),grade,stages:[{promptId:'T99',acceptance:false,acceptanceResults:[{phase:'T99',pass:false}]}]};
  if(typeof R.archiveCompletedArm==='function')R.archiveCompletedArm(root,run);
  // Same physical destruction as snapshot restore; no candidate copy survives here.
  S.fs.rmSync(S.path.join(root,'workspace'),{recursive:true});S.fs.mkdirSync(S.path.join(root,'workspace/src'),{recursive:true});S.fs.writeFileSync(S.path.join(root,session),'next arm baseline\n');
  const archive=S.path.join(root,'reports/completed-arms',arm);
  assert(S.fs.existsSync(archive),'completed '+arm+' evidence was lost before the next restore');
  assert.equal(S.fs.readFileSync(S.path.join(archive,'payload/workspace/src/application.ts'),'utf8'),source);
  assert.equal(S.fs.readFileSync(S.path.join(archive,'payload',session),'utf8'),JSON.stringify({type:'session',id:arm})+'\n');
  assert.deepEqual(S.read(S.path.join(archive,'run.json')).grade,grade);
  assert.equal(S.fs.statSync(S.path.join(archive,'payload/workspace/src/application.ts')).mode&0o222,0);
  assert(!S.fs.existsSync(S.path.join(root,'workspace/reports')));
 }
});
test('T99 diagnostics preserve actual public and hidden failing values without changing grading',()=>{
 const F=require('../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs'),dir=S.path.join(tmp,'candidate');F.createFixture(dir);F.release(dir,'T99');
 const original=S.fs.readFileSync(S.path.join(dir,'src/application.ts'));
 const D=require('../benchmarks/ccv2-lhcb-02/grader/diagnostics.cjs');const result=D.integrated(dir);
 assert(result.public.some(r=>!r.pass&&r.actual?.history?.length===0));assert(result.hidden.some(r=>!r.pass));
 S.write(S.path.join(tmp,'diagnostics.json'),result);assert.deepEqual(result,S.read(S.path.join(tmp,'diagnostics.json')));
 assert.deepEqual(S.fs.readFileSync(S.path.join(dir,'src/application.ts')),original);
});
test('projection metrics distinguish attempts, successful projections and durable changes',()=>{
 const P=require('../scripts/bench/ccv2-lhcb-02/projection-metrics.cjs');const ds=[{requestSeq:1,compilerExecutions:1,projectionMode:'LEGACY',fallbackReason:'active-tokenizer-unavailable',attemptFailureStage:'enumeration-count',counterFailureKind:'counter-deadline',pressureTokens:907017,activationTokens:907018,activationDecision:'NATIVE'},{requestSeq:2,compilerExecutions:1,projectionMode:'CCV2_COMPILED',fallbackReason:null,pressureTokens:907018,activationTokens:907018,activationDecision:'ACTIVATE'}];
 const r=P.collect([],ds,[{kind:'compiled_projection_size',requestSeq:2,beforeBytes:10000,afterBytes:1000,measurementOverheadMs:0.5}]);
 assert.equal(r.compilerAttempts,2);assert.equal(r.compiledRequests,1);assert.equal(r.successfulProjectionRate,0.5);assert.equal(r.durableCompactions,0);assert.equal(r.surfaceReplacements,0);assert.equal(r.projectionReduction.reduction,0.9);assert.equal(r.activation.firstThresholdCrossing.armRequest,2);
 assert.equal(P.collect([],ds).projectionReduction.available,false);assert.equal(P.collect([],ds).projectionReduction.reduction,null);
 assert.equal(P.collect([{type:'compaction/start'},{type:'compaction/end'},{type:'user/message',surfaceOp:'replace'}],[]).durableCompactions,2);
});
test('unchanged DSH pressure policy requests compaction before the CCv2 activation region',async()=>{
 const {createRequire}=require('node:module'),appRequire=createRequire(S.os.homedir()+'/.local/share/nexus/app/package.json');
 const Basic=appRequire('@deepseek-ai/dsh-compaction-basic').BasicCompactionEngine;
 const engine=Object.create(Basic.prototype);engine.config={thresholdRatio:0.8,retainRatio:0.16,modelPolicies:[],compactionRetries:1};
 let totalTokens=850000,calls=0;const session={events:[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',data:{id:'a',role:'user',content:[]}},{seq:2,type:'user/message',data:{id:'b',role:'user',content:[]}}],surface:{nodes:[1,2]},requestHeader:()=>({config:{provider:S.manifest.provider,model:S.manifest.model}})};
 engine.ctx={llm:{resolveModelInfo:async()=>({context:{contextWindow:1048576}})},get:()=>undefined,tokenMeter:{measure:()=>({totalTokens,nodes:[{seq:1,tokens:650000},{seq:2,tokens:200000}]})}};
 // Substitute only the summarization result, not policy, threshold or selection.
 engine.compactRegion=async()=>{calls++;totalTokens=200000;return {shadowedSeqs:[1]};};
 const result=await engine.compactIfNeeded({session},'pressure',new AbortController().signal);
 assert.equal(calls,1);assert(result);assert(totalTokens<907018);
 const gate=require('../config/ContextActivationPressureV2.cjs');assert.equal(gate.deriveActivationThresholdsV2({contextWindow:1048576,maxTokens:131072,reasoningReplay:'none'}).activationTokens,907018);
});
test('inactive Production input variation is never claimed as CCv2 benefit',()=>{
 const make=(arm,input)=>({arm,valid:true,grade:{pass:true},agentLatencyMs:1,metrics:{providerInputTokensTotal:input,steps:1,compiledRequests:0,pressurePolicyMatches:true}});
 const result=R.compare([make('native',1000),make('production',400)]);assert.equal(result.comparisons.production.inputReduction,0.6);assert.equal(result.comparisons.production.ccv2AttributedInputReduction,null);assert.equal(result.comparisons.production.meaningful,false);assert.equal(result.productionBenefit,'NOT_TRIGGERED');assert.equal(result.scientificVerdicts.PRODUCTION_CCv2_POLICY_BENEFIT.status,'NOT_TRIGGERED_BY_PRODUCTION_POLICY');
});
