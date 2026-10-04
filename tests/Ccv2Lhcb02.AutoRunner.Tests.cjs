'use strict';
require('../benchmarks/ccv2-lhcb-01/grader/offline.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {S,load,authority}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs');
const fixture=require('../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs');
const {CalibrationRunner}=require('../scripts/bench/ccv2-lhcb-02/autorunner.cjs');
const Session=load('session'),T=require('../scripts/bench/ccv2-lhcb-02/telemetry.cjs');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-runner-'));let serial=0;
after(()=>{assert.equal(global.lhcbOfflineAudit.attempts(),0);S.fs.rmSync(tmp,{recursive:true,force:true});});
function setup(){
 const root=S.path.join(tmp,'root-'+(++serial));for(const p of ['state','reports','workspace','nexus-root/config','nexus-root/app','nexus-root/data/sessions'])S.fs.mkdirSync(S.path.join(root,p),{recursive:true});
 fixture.createFixture(S.path.join(root,'workspace'));
 for(const p of ['settings.yaml','routing-policy.json'])S.fs.copyFileSync(S.path.join(S.REPO,'config',p),S.path.join(root,'nexus-root/config',p));
 const policyFile=S.path.join(root,'nexus-root/config/routing-policy.json');S.write(policyFile,load('arms').configure(S.read(policyFile),'native'));
 S.fs.writeFileSync(S.path.join(root,'nexus-root/app/package.json'),'{}');S.fs.symlinkSync(S.os.homedir()+'/.local/share/nexus/app/node_modules',S.path.join(root,'nexus-root/app/node_modules'));
 S.write(S.path.join(root,'state/identity.json'),{benchmarkId:S.manifest.benchmarkId,baseSha:S.manifest.baseSha,root,contractHash:S.contractHash()});
 let sid,events=[],clock=1000;const flags={},trace=[];
 const add=(type,data)=>{
  events.push({seq:events.length,type,time:clock++,data,...(['user/message','assistant/message','tool/result'].includes(type)?{surfaceOp:'append'}:{})});

 };
 const relative=()=> 'nexus-root/data/sessions/workspace/'+sid+'/session.jsonl';
 function persist(){const file=S.inside(root,relative());S.fs.mkdirSync(S.path.dirname(file),{recursive:true});const header={type:'session',id:sid,version:3,createdAt:1000,cwd:S.path.join(root,'workspace')};S.fs.writeFileSync(file,[header,...events].map(JSON.stringify).join('\n')+'\n');}
 function memory(){const dir=S.path.join(root,'workspace/.ai-harness/ccv2/TASK-0001');const state={namespace:{workspaceId:S.path.join(root,'workspace'),sessionId:sid,taskId:'TASK-0001',taskInstanceId:'instance'},processedThroughSeq:events.length-1,sealedGeneration:events.filter(e=>e.type==='turn/end').length,sealedCheckpointId:'cp-'+events.length,openTurn:null,blocker:null};S.write(S.path.join(dir,'producer/state.json'),state);S.write(S.path.join(dir,'staged.json'),{...state,activeTurn:null});}
 const controllerBootstrap={async create(id){if(sid&&sid!==id)throw Error('session drift');if(!sid){sid=id;persist();}},async prepare(id){assert.equal(sid,id);S.write(S.path.join(root,'nexus-root/data/routing/session-bindings.json'),{bindings:{[sid]:{sessionId:sid,taskId:'TASK-0001',taskInstanceId:'instance',workspace:S.path.join(root,'workspace')}}});S.write(S.path.join(root,'workspace/.ai-harness/runs/TASK-0001/manifest.json'),{taskId:'TASK-0001',taskInstanceId:'instance'});return {sessionId:sid,taskId:'TASK-0001',taskInstanceId:'instance',...require('../scripts/bench/ccv2-lhcb-02/controller-bootstrap.cjs').target};},async verify(a){assert.equal(a.sessionId,sid);return a;}};
 const transport={async start(){},async close(){trace.push('close');},async create(id){sid=id;persist();},async resume(id){assert.equal(id,sid);},async status(id){return {sessionId:id,cwd:S.path.join(root,'workspace'),status:'idle'};},async flush(){return true;},async submit(id,text,rpcId){
  const phase=S.manifest.stages.find(p=>load('autorunner').exactPrompt(p).text===text);assert(phase);trace.push(phase);const turn=trace.filter(x=>x!=='close').length;add('turn/start',{turn});add('user/message',{id:'u-'+turn,role:'user',content:[{type:'text',text}],source:{kind:'user',rpcId:flags.wrongRpc?'wrong':rpcId}});
  if(turn===1){add('request/header',{header:{config:{provider:S.manifest.provider,model:S.manifest.model,maxTokens:2048},system:'',tools:[]},reason:'initial'});add('request/context',{provider:S.manifest.provider,model:S.manifest.model,contextWindow:1048576});}
  add('step/start',{turn,step:1});
  const input=1000+22000*(turn-1);add('assistant/message',{turn,step:1,message:{id:'a-'+turn,role:'assistant',content:[{type:'text',text:'Investigating phase '+phase}]},usage:{inputTokens:input,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:25,reasoningTokens:0}});add('step/end',{turn,step:1});
  for(let i=0;i<2;i++){const callId='call-'+turn+'-'+i;add('tool/call',{turn,step:1,callId,name:'read_file',arguments:JSON.stringify({path:'evidence/'+phase+'/'+i})});add('tool/result',{turn,step:1,message:{role:'user',content:[{type:'tool-result',toolCallId:callId,toolName:'read_file',content:[{type:'text',text:'Fresh evidence '+phase+' '+i}]}]}});}
  add('step/start',{turn,step:2});add('assistant/message',{turn,step:2,message:{id:'b-'+turn,role:'assistant',content:[{type:'text',text:'Implemented '+phase}]},usage:{inputTokens:input+15000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:25,reasoningTokens:0}});add('step/end',{turn,step:2});
  if(flags.compact)add('compaction/prune',{shadowedRange:{start:0,end:1},shadowedSeqs:[],shadowedTokenCount:1});
  add('turn/end',{turn,reason:{kind:'completed'}});persist();
  S.write(S.path.join(root,'nexus-root/data/routing/session-bindings.json'),{bindings:{[sid]:{sessionId:sid,taskId:'TASK-0001',taskInstanceId:'instance',workspace:S.path.join(root,'workspace')}}});
  S.write(S.path.join(root,'workspace/.ai-harness/runs/TASK-0001/manifest.json'),{taskId:'TASK-0001',taskInstanceId:'instance'});memory();
  if(flags.mutate&&phase!=='T00')S.fs.appendFileSync(S.path.join(root,'workspace/evidence/'+phase+'/incident.json'),' ');
  if(flags.lose){flags.lose=false;throw Error('response lost');}
 }};
 const options={transport,controllerBootstrap,env:{OPENCODE_API_KEY:'offline-sentinel',MODEL_API_KEY:'offline-sentinel'},doctor:()=>({sourceGuard:{pass:true,baseSha:S.manifest.baseSha},runtime:{ready:true},certification:{health:'HEALTHY',state:'valid'},liveReady:true,thresholds:authority.thresholds}),acceptance:(_root,ids)=>[...ids.map(phase=>({phase,pass:true})),{phase:'holdout',pass:true}],now:()=>clock++,pause:async ms=>{clock+=ms;},pollMs:1,turnTimeoutMs:10,flushTimeoutMs:10};
 return {root,flags,trace,options,runner:()=>new CalibrationRunner(root,options),events:()=>events,persist,relative};
}
test('six phases execute once, content-free observations and no official run',async()=>{const s=setup();const report=await s.runner().execute();assert.equal(report.calibration.status,'PASS',JSON.stringify({calibration:report.calibration,rows:S.read(S.path.join(s.root,'state/request-telemetry.json')).slice(0,2)}));assert.equal(report.workload.verdict,'WORKLOAD_INADEQUATE');assert.equal(report.workload.ccv2BenefitVerdict,'NOT_MEASURED');assert.equal(report.officialRunCreated,false);assert.deepEqual(s.trace.filter(x=>x!=='close'),S.manifest.stages);const telemetry=S.fs.readFileSync(S.path.join(s.root,'state/request-telemetry.json'),'utf8');assert.doesNotMatch(telemetry,/Fresh evidence|Implemented|Investigating|safe integer/);const rows=JSON.parse(telemetry);assert.equal(rows.length,14);assert(rows.every(r=>r.requestHash&&r.canonicalRequestByteCount>0));assert(rows.every(r=>r.mode==='NATIVE'&&r.compilerExecutionCount===0));assert.equal(rows[0].historicalToolResultCount,0);assert.equal(rows[1].historicalToolResultCount,2);await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='E06').length,1);});
test('lost submission response preserves diagnostic root without retransmission',async()=>{const s=setup();s.flags.lose=true;await assert.rejects(s.runner().execute());await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='T00').length,1);});
test('T00 submission already has prepared production identity in the durable journal',async()=>{
 const s=setup(),submit=s.options.transport.submit;
 s.options.transport.submit=async(...args)=>{const j=S.read(S.path.join(s.root,'state/calibration-journal.json'));assert(j.identity,'T00 may not be submitted with null identity');assert.equal(j.creation.phase,'PREPARED');return submit(...args);};
 await s.runner().execute();
});
test('prompt RPC mismatch fails closed',async()=>{const s=setup();s.flags.wrongRpc=true;await assert.rejects(s.runner().execute(),/provenance-mismatch/);});
test('evidence modification fails independently of model completion',async()=>{const s=setup();s.flags.mutate=true;await assert.rejects(s.runner().execute(),/evidence-modified/);});
test('non-native policy cannot start',async()=>{const s=setup();const file=S.path.join(s.root,'nexus-root/config/routing-policy.json');const p=S.read(file);p.contextCompiler.mode='active';S.write(file,p);await assert.rejects(s.runner().execute(),/native-policy-required/);assert.equal(s.trace.length,1);});
test('real multiframe decoder observes all records; truncation fails',async()=>{const s=setup();await s.runner().execute();const z=require('node:zlib'),file=S.path.join(s.root,s.relative());const lines=S.fs.readFileSync(file,'utf8').trimEnd().split('\n');const compressed=file+'.zstd';S.fs.writeFileSync(compressed,Buffer.concat(lines.map(line=>z.zstdCompressSync(Buffer.from(line+'\n')))));const p=S.path.join(s.root,'state/binding.json'),b=S.read(p);b.sessionLog=s.relative()+'.zstd';S.write(p,b);assert.equal(Session.binding(s.root).events.length,s.events().length);const bytes=S.fs.readFileSync(compressed);S.fs.writeFileSync(compressed,bytes.subarray(0,-1));assert.throws(()=>Session.binding(s.root),/compressed-frame-invalid/);});
test('cache-aware usage adds each input category once; reasoning stays optional',async()=>{const s=setup();await s.runner().execute();const b=Session.binding(s.root),e=b.events.find(x=>x.type==='assistant/message');e.data.usage={inputTokens:12,cacheReadTokens:100,cacheWriteTokens:7,outputTokens:5};const record=s.runner().journal.stages[0];const rows=T.collectRequests(s.root,b,record);assert.equal(rows[0].providerInputTokens,119);assert.equal(rows[0].reasoningTokens,null);assert.equal(rows[0].outputTokens,5);});
test('compaction in the initial contract turn also fails calibration',async()=>{const s=setup();s.flags.compact=true;const report=await s.runner().execute();assert.equal(report.calibration.status,'FAIL');assert(report.calibration.reasons.includes('history-integrity-not-proven'));});
test('used roots reject another calibration even when durable evidence changes',async()=>{const s=setup();await s.runner().execute();s.events()[0].time++;s.persist();await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='T00').length,1);});
test('native policy and request provenance thresholds are frozen',async()=>{const s=setup();s.options.doctor=()=>({sourceGuard:{pass:true,baseSha:S.manifest.baseSha},runtime:{ready:true},certification:{health:'HEALTHY',state:'valid'},liveReady:true,thresholds:{...authority.thresholds,dshThresholdTokens:1}});await assert.rejects(s.runner().execute(),/threshold-mismatch/);});
test('unobserved provider usage fails calibration, not guessed zero',async()=>{const s=setup();await s.runner().execute();const b=Session.binding(s.root);delete b.events.find(e=>e.type==='assistant/message').data.usage;const rows=T.collectRequests(s.root,b,s.runner().journal.stages[0]);assert.equal(rows[0].providerInputTokens,null);});
test('red team: same-process stale runner cannot create a replacement session',async()=>{
 const s=setup(),first=s.runner(),stale=s.runner();await first.execute();await assert.rejects(stale.execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='T00').length,1);
});
test('red team: used diagnostic roots cannot restart even with malformed receipts',async()=>{
 const s=setup();await s.runner().execute();const file=S.path.join(s.root,'state/calibration-journal.json'),j=S.read(file);j.creation=null;j.identity=null;S.write(file,j);await assert.rejects(s.runner().execute(),/fresh-root-required/);
});
test('red team: failed attempts are durably represented, never omitted',async()=>{
 const s=setup();await s.runner().execute();const b=Session.binding(s.root),r=s.runner().journal.stages[0];
 const step=b.events.find(e=>e.type==='step/start');b.events=b.events.filter(e=>!(e.type==='assistant/message'&&e.data.step===step.data.step&&e.data.turn===step.data.turn));
 b.events.forEach((e,i)=>e.seq=i);r.endSeq=b.events.find(e=>e.type==='turn/end').seq;
 const rows=T.collectRequests(s.root,b,r);assert.equal(rows.length,2);assert.equal(rows[0].providerInputTokens,null);assert.equal(rows[0].requestOutcome,'UNOBSERVED');
});
test('red team: compiler telemetry is observed rather than hardcoded',async()=>{
 const s=setup();await s.runner().execute();const file=S.path.join(s.root,'nexus-root/data/logs/aih-controller.log');S.fs.mkdirSync(S.path.dirname(file),{recursive:true});S.fs.writeFileSync(file,JSON.stringify({event:'ccv2-opencode-active-decided',projectionMode:'CCV2_COMPILED',compilerExecutions:1})+'\n');
 const b=Session.binding(s.root),rows=T.collectRequests(s.root,b,s.runner().journal.stages[0]);assert(rows.some(r=>r.mode!=='NATIVE'||r.compilerExecutionCount!==0));
});
test('red team: stage summary pressure cannot trust edited journal counters',async()=>{
 const s=setup();await s.runner().execute();const b=Session.binding(s.root),record=s.runner().journal.stages[1];record.after.pressureTokens=999999999;
 assert.notEqual(T.phaseSummary(b,record,T.collectRequests(s.root,b,record)).pressureAfter,999999999);
});
for(const point of ['before-intent','after-intent','after-rpc','after-flush'])test('red team: interruption at '+point+' never duplicates the prompt',async()=>{
 const s=setup();let thrown=false;s.options.fault=p=>{if(p===point&&!thrown){thrown=true;throw Error('simulated crash');}};
 await assert.rejects(s.runner().execute());s.options.fault=undefined;
 await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='T00').length,['before-intent','after-intent'].includes(point)?0:1);assert(!S.fs.existsSync(S.path.join(s.root,'reports/calibration.json')));
});
test('red team: concurrent invocations cannot both submit',async()=>{
 const s=setup(),a=s.runner(),b=s.runner();let releaseStart,started;
 const startedSignal=new Promise(r=>{started=r;}),gate=new Promise(r=>{releaseStart=r;});s.options.transport.start=async()=>{started();await gate;};
 const first=a.execute();await startedSignal;await assert.rejects(b.execute(),/runner-busy/);releaseStart();await first;assert.equal(s.trace.filter(x=>x==='T00').length,1);
});
test('red team: reused PID and malformed lease cannot authorize deletion or startup',async()=>{
 for(const malformed of [false,true]){const s=setup(),file=S.path.join(s.root,'state/calibration-lock.json');const lease={root:s.root,contractHash:S.contractHash(),pid:malformed?-1:999999,processToken:'123',leaseId:'foreign'};S.write(file,lease);s.options.processToken=()=> '456';await assert.rejects(s.runner().execute(),malformed?/lock-invalid/:/lock-ambiguous/);assert.deepEqual(S.read(file),lease);assert.equal(s.trace.length,0);}
});
test('red team: interrupted restore marker blocks all calibration continuation',async()=>{
 const s=setup();S.write(S.path.join(s.root,'state/restore-lock.json'),{checkpoint:'CP-500'});await assert.rejects(s.runner().execute(),/restore-incomplete/);assert.equal(s.trace.filter(x=>x==='T00').length,0);
});
test('red team: acceptance is sealed for its phase and cannot improve retrospectively',async()=>{
 const s=setup();s.options.acceptance=(_root,ids)=>[...ids.map(phase=>({phase,pass:phase!=='E01'})),{phase:'holdout',pass:true}];const first=await s.runner().execute();assert.equal(first.phases[0].acceptance,false);
 s.options.acceptance=(_root,ids)=>[...ids.map(phase=>({phase,pass:true})),{phase:'holdout',pass:true}];await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(S.read(S.path.join(s.root,'reports/calibration.json')).phases[0].acceptance,false);
});
test('red team: source edits after durable completion cannot forge missing acceptance',async()=>{
 const s=setup();s.options.fault=point=>{if(point==='after-flush')throw Error('simulated crash');};await assert.rejects(s.runner().execute());s.options.fault=undefined;S.fs.appendFileSync(S.path.join(s.root,'workspace/src/service.ts'),'\n// altered');await assert.rejects(s.runner().execute(),/fresh-root-required/);
});
function transportRig(){
 const s=setup();const originalRoot=s.root;s.root=S.path.join(originalRoot,'transport-root');S.fs.mkdirSync(S.path.join(s.root,'state'),{recursive:true});S.write(S.path.join(s.root,'state/identity.json'),{...S.read(S.path.join(originalRoot,'state/identity.json')),root:s.root});const T=load('agent-transport'),{EventEmitter}=require('node:events');let alive=false,startToken='123',clock=0;const flags={},calls=[],kills=[];
 const transport=T.createTransport(s.root,s.options.env,{
  apiClient:(_install,fetch)=>T.createApiClient(S.os.homedir()+'/.local/share/nexus',fetch),
  token:()=>alive?startToken:null,listeners:()=>flags.preexisting?['foreign']:(alive?['owned']:[]),sameProcess:r=>alive&&r.pid===31337&&r.processToken===startToken,ownsListener:()=>alive&&!flags.foreign,
  now:()=>clock,pause:async ms=>{clock+=ms;},startTimeoutMs:200,rpcReadyTimeoutMs:200,
  spawn(){calls.push('spawn');alive=true;const child=new EventEmitter();child.pid=31337;child.unref=()=>{};child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>child.emit('spawn'));return child;},kill(pid){kills.push(pid);alive=false;},
  async fetch(_url,init){if(init.method==='HEAD')return new Response(null,{status:200});const req=JSON.parse(init.body);calls.push(req.method);assert.notEqual(req.method,'session.prompt');if(flags.cold-- >0)return new Response(null,{status:404});const value=req.method==='session.list'?{items:[{sessionId:'session-offline',cwd:S.path.join(s.root,'workspace'),running:false,blank:false,updatedAt:1000}]}:{sessionId:req.payload.sessionId};return Response.json({type:'server-response',rpcId:req.rpcId,result:{ok:true,value}});}
 });return {s,transport,flags,calls,kills,reuse(){startToken='456';}};
}
test('red team: foreign listener is never killed or adopted',async()=>{const rig=transportRig();rig.flags.preexisting=true;await assert.rejects(rig.transport.start(),/runner-port-in-use/);assert.deepEqual(rig.kills,[]);assert(!rig.calls.includes('spawn'));});
test('red team: PID reuse and listener substitution preserve transport ownership evidence',async()=>{
 for(const kind of ['pid','listener']){const rig=transportRig();await rig.transport.start();if(kind==='pid')rig.reuse();else rig.flags.foreign=true;await assert.rejects(rig.transport.close(),kind==='pid'?/process-drift/:/listener-mismatch/);assert.deepEqual(rig.kills,[]);assert(S.fs.existsSync(S.path.join(rig.s.root,'state/autorunner-runtime.json')));}
});
test('red team: cold API readiness polls without submitting a prompt',async()=>{const rig=transportRig();rig.flags.cold=1;await rig.transport.start();await rig.transport.close();assert.equal(rig.calls.filter(x=>x==='session.list').length,3);assert.deepEqual(rig.kills,[31337]);});

test('red team: failed retries remain distinct with non-overlapping durable ranges',async()=>{
 const s=setup();await s.runner().execute();const b=Session.binding(s.root),record=s.runner().journal.stages[0];
 const first=b.events.findIndex(e=>e.type==='assistant/message');
 b.events.splice(first,0,{type:'llm/retry',data:{reason:'offline transient failure'}},{type:'llm/retry-started',data:{attempt:1}});
 b.events.forEach((e,i)=>e.seq=i);record.endSeq=b.events.find(e=>e.type==='turn/end').seq;
 const rows=T.collectRequests(s.root,b,record);assert.equal(rows.length,3);assert.equal(rows[0].requestOutcome,'FAILED');assert.equal(rows[0].providerInputTokens,null);
 assert.equal(rows[1].requestOutcome,'OBSERVED');assert.notEqual(rows[0].requestIdentity,rows[1].requestIdentity);
 assert(rows[0].durableSequenceRange[1]<rows[1].durableSequenceRange[0]);assert.equal(rows[0].availability.providerInputTokens,'unavailable in durable evidence');
});

test('red team: off policy is sufficient when active decision log is absent',async()=>{
 const s=setup();await s.runner().execute();if(S.fs.existsSync(S.path.join(s.root,'nexus-root/data/logs/aih-controller.log')))S.fs.unlinkSync(S.path.join(s.root,'nexus-root/data/logs/aih-controller.log'));
 const rows=T.collectRequests(s.root,Session.binding(s.root),s.runner().journal.stages[0]);
 assert(rows.every(r=>r.mode==='NATIVE'&&r.compilerExecutionCount===0));
});

for(const point of ['after-session-create','after-controller-prepare','after-bootstrap-identity'])test('bootstrap crash at '+point+' preserves diagnostics and requires a fresh root',async()=>{
 const s=setup();let fired=false;const authorities=[];const prepare=s.options.controllerBootstrap.prepare;s.options.controllerBootstrap.prepare=async id=>{const a=await prepare(id);authorities.push(a);return a;};
 s.options.fault=p=>{if(p===point&&!fired){fired=true;throw Error('crash');}};
 await assert.rejects(s.runner().execute());assert.equal(s.trace.filter(x=>x==='T00').length,0);assert.equal(S.read(S.path.join(s.root,'state/calibration-journal.json')).stages.length,0);
 s.options.fault=undefined;await assert.rejects(s.runner().execute(),/fresh-root-required/);assert(authorities.every(a=>a.taskInstanceId==='instance'));assert.equal(s.trace.filter(x=>x==='T00').length,0);
});
test('interrupted preparation cannot be reused',async()=>{const s=setup(),prepare=s.options.controllerBootstrap.prepare;s.options.controllerBootstrap.prepare=async id=>{await prepare(id);throw Error('crash during prepare');};await assert.rejects(s.runner().execute());s.options.controllerBootstrap.prepare=prepare;await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='T00').length,0);});
test('historical plugin controller-error blocked turn cannot satisfy T00 provenance',()=>{const prompt=load('autorunner').exactPrompt('T00').text;const events=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',surfaceOp:'append',data:{content:[{type:'text',text:prompt}],source:{kind:'plugin',plugin:'aih-controller',form:'controller-error'}}},{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'blocked'}}}];assert.equal(load('autorunner').evidence(events,{promptId:'T00',startSeq:0,rpcId:'lhcb-offline'}),null);});
for(const field of ['profile','provider','model','engine'])test('wrong bootstrap '+field+' cannot produce T00 intent',async()=>{const s=setup(),prepare=s.options.controllerBootstrap.prepare;s.options.controllerBootstrap.prepare=async id=>({...await prepare(id),[field]:'wrong'});await assert.rejects(s.runner().execute(),/bootstrap-authority-invalid/);assert.equal(s.trace.filter(x=>x==='T00').length,0);assert.equal(S.read(S.path.join(s.root,'state/calibration-journal.json')).stages.length,0);});
test('used roots cannot accept altered READY or SUBMITTED receipt identity',async()=>{const s=setup();s.options.fault=p=>{if(p==='after-intent')throw Error('stop');};await assert.rejects(s.runner().execute());const file=S.path.join(s.root,'state/calibration-journal.json'),j=S.read(file);for(const phase of ['READY','SUBMITTED']){const altered=structuredClone(j);altered.identity=null;altered.stages[0].phase=phase;S.write(file,altered);await assert.rejects(s.runner().execute(),/fresh-root-required/);}});
test('interrupted READY T00 cannot be resubmitted',async()=>{
 const s=setup();s.options.fault=p=>{if(p==='before-intent')throw Error('crash');};await assert.rejects(s.runner().execute());assert.equal(s.runner().journal.stages[0].phase,'READY');
 s.options.fault=undefined;s.options.controllerBootstrap.verify=()=>{throw Error('lhcb-bootstrap-routing-drift');};await assert.rejects(s.runner().execute(),/fresh-root-required/);assert.equal(s.trace.filter(x=>x==='T00').length,0);
});

test('fresh normal staging may omit the lazy session directory before bootstrap',async()=>{const s=setup();S.fs.rmSync(S.path.join(s.root,'nexus-root/data/sessions'),{recursive:true});const r=s.runner();await r.prepareController();assert(r.journal.identity);assert.equal(r.journal.creation.phase,'PREPARED');assert.equal(r.journal.stages.length,0);assert.deepEqual(s.trace,[]);});

// The prompt RPC returns before the first request/header has been persisted.
test('async accepted T00 waits for delayed request authority and durable completion',async()=>{
 const s=setup(),submit=s.options.transport.submit;let pending,running=false,waits=0;
 s.options.transport.submit=async(...args)=>{pending=args;running=true;};
 s.options.transport.status=async id=>({sessionId:id,cwd:S.path.join(s.root,'workspace'),status:running?'running':'idle'});
 s.options.pause=async()=>{
  assert(running);if(waits++===0){if(s.trace.length===0)assert(!Session.binding(s.root).events.some(e=>e.type==='request/header'));return;}
  const args=pending;pending=null;await submit(...args);running=false;waits=0;
 };
 const r=await s.runner().execute();assert.equal(r.calibration.status,'PASS');assert.equal(s.trace.filter(x=>x==='T00').length,1);
 assert(S.read(S.path.join(s.root,'state/request-telemetry.json')).every(r=>r.requestOutcome==='OBSERVED'));
});
test('production off policy proves native operation without artificial decision events',async()=>{
 const s=setup();await s.runner().execute();S.fs.mkdirSync(S.path.join(s.root,'nexus-root/data/logs'),{recursive:true});S.fs.writeFileSync(S.path.join(s.root,'nexus-root/data/logs/aih-controller.log'),'');
 assert.deepEqual(T.compilerObservation(s.root),{mode:'NATIVE',compilerExecutionCount:0});
});

test('durable route differing from prepareSession authority rejects completion',async()=>{
 const s=setup(),submit=s.options.transport.submit;
 s.options.transport.submit=async(...args)=>{await submit(...args);s.events().find(e=>e.type==='request/header').data.header.config.model='foreign';s.persist();};
 await assert.rejects(s.runner().execute(),/provider-model-mismatch/);assert(!S.fs.existsSync(S.path.join(s.root,'reports/calibration.json')));
});
test('calibration does not inherit official runner state machine methods',()=>{
 const source=S.fs.readFileSync(S.path.join(S.REPO,'scripts/bench/ccv2-lhcb-02/autorunner.cjs'),'utf8');
 assert.doesNotMatch(source,/AutoRunner\.prototype|load\('autorunner'\)|memoryReady|sealedGeneration/);
});

test('pinned DSH adapter omits zero caches; durable valid usage still has exact input accounting',async()=>{
 const s=setup();await s.runner().execute();const b=Session.binding(s.root);
 for(const e of b.events.filter(e=>e.type==='assistant/message')){delete e.data.usage.cacheReadTokens;delete e.data.usage.cacheWriteTokens;}
 const rows=T.collectRequests(s.root,b,s.runner().journal.stages[0]);
 assert(rows.every(r=>r.cacheReadTokens===0&&r.cacheWriteTokens===0&&r.providerInputTokens===r.uncachedInputTokens));
});
test('native projection applies frozen no-replay transform to historical reasoning',async()=>{
 const s=setup();await s.runner().execute();const b=Session.binding(s.root);
 b.events.find(e=>e.type==='assistant/message').data.message.content.push({type:'reasoning',text:'private reasoning',signature:'opaque'});
 const rows=T.collectRequests(s.root,b,s.runner().journal.stages[0]);assert(rows.every(r=>r.requestHash&&r.canonicalRequestByteCount>0));
});
