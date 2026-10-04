'use strict';
const {S,load,authority}=require('./infrastructure.cjs');
const fixture=require('../../../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs');
const Telemetry=require('./telemetry.cjs'),Validity=require('./validity.cjs');
const Session=load('session'),D=load('doctor'),Bootstrap=require('./controller-bootstrap.cjs');
const identity=b=>Object.fromEntries(['sessionId','taskId','taskInstanceId'].map(k=>[k,b[k]]));
const same=(a,b)=>S.json(a)===S.json(b);
function release(root,id){
  if(id==='T00')return null;
  const files=fixture.phaseFiles(id),receiptFile=S.inside(root,'state/release-'+id+'.json');
  let receipt=S.fs.existsSync(receiptFile)?S.read(receiptFile):null;
  const hashes=Object.fromEntries(Object.entries(files).map(([p,t])=>[p,S.hash(t)]));
  if(receipt){if(!same(receipt.hashes,hashes)||receipt.hash!==S.hash(S.json(hashes))||typeof receipt.complete!=='boolean')S.fail('lhcb02-evidence-contract-drift');if(receipt.complete){for(const [p,h] of Object.entries(hashes))if(!p.startsWith('src/')&&(!S.fs.existsSync(S.inside(root,'workspace/'+p))||S.hash(S.fs.readFileSync(S.inside(root,'workspace/'+p)))!==h))S.fail('lhcb02-evidence-modified');return receipt.hash;}}
  else{receipt={hashes,complete:false,hash:S.hash(S.json(hashes))};S.write(receiptFile,receipt);}
  for(const [p,t] of Object.entries(files)){
    const target=S.inside(root,'workspace/'+p);S.fs.mkdirSync(S.path.dirname(target),{recursive:true});
    if(S.fs.existsSync(target)){if(S.hash(S.fs.readFileSync(target))!==hashes[p])S.fail('lhcb02-release-conflict');}
    else S.fs.writeFileSync(target,t,{flag:'wx'});
  }
  receipt.complete=true;S.write(receiptFile,receipt);return receipt.hash;
}
function protectedHashes(root){
  const out={};for(const [p,h] of Object.entries(S.inventory(S.inside(root,'workspace'))))if(!p.startsWith('src/')&&!p.startsWith('.ai-harness/')&&!p.startsWith('.git/'))out[p]=h.hash;
  return out;
}
function acceptance(root,ids){
  const result=require('node:child_process').spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(S.BENCH,'grader/grade.cjs'),S.inside(root,'workspace'),JSON.stringify(ids)],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,NODE_OPTIONS:''}});
  let rows;try{rows=JSON.parse(result.stdout.trim());}catch{}
  if(result.status!==0||!Array.isArray(rows)||rows.length!==ids.length+1||rows.some((r,i)=>r.phase!==(ids[i]??'holdout')||typeof r.pass!=='boolean'))return [{phase:'grading-failure',pass:false}];
  return rows;
}

function exactPrompt(id){
 if(!S.manifest.stages.includes(id))S.fail('runner-prompt-invalid');
 const files=S.fs.readdirSync(S.path.join(S.BENCH,'prompts')).filter(p=>p.startsWith(id+'-'));
 if(files.length!==1)S.fail('runner-prompt-invalid');
 const text=S.fs.readFileSync(S.path.join(S.BENCH,'prompts',files[0]),'utf8'),hash=S.hash(text);
 if(hash!==authority.promptHashes[id])S.fail('runner-prompt-digest-mismatch');return {text,hash};
}
function completedTurn(events,r){
 const users=events.filter(e=>e.seq>=r.startSeq&&e.type==='user/message'&&e.surfaceOp!=='replace'&&(!e.data.source||e.data.source.kind==='user'));
 if(users.length>1)S.fail('runner-duplicate-prompt-evidence');
 if(!users.length)return null;const user=users[0];
 if(Session.promptContent(user.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))!==Session.promptContent(exactPrompt(r.promptId).text)||user.data.source?.rpcId!==r.rpcId)S.fail('runner-prompt-provenance-mismatch');
 const turn=events.slice(0,user.seq+1).findLast(e=>e.type==='turn/start');
 const end=events.find(e=>e.seq>user.seq&&e.type==='turn/end');
 if(!end)return null;if(!turn||end.data.turn!==turn.data.turn)S.fail('runner-turn-identity-mismatch');
 if(end.data.reason?.kind!=='completed')S.fail('runner-turn-failed');return end.seq;
}
class CalibrationRunner {
 constructor(root,options={}){
  if(process.version!==S.manifest.nodeVersion)S.fail('lhcb02-node-version');
  this.root=S.owned(root);this.options=options;this.env=options.env||process.env;
  if(S.fs.existsSync(S.inside(root,'state/simulation.json')))S.fail('lhcb02-simulation-live-forbidden');
  this.now=options.now||Date.now;this.pause=options.pause||(ms=>new Promise(r=>setTimeout(r,ms)));
  this.pollMs=options.pollMs??250;this.turnTimeout=options.turnTimeoutMs??900000;this.flushTimeout=options.flushTimeoutMs??60000;
  this.transport=options.transport||load('agent-transport').createTransport(root,this.env,{spawn:require('./isolation.cjs').spawnIsolated});
  this.controllerBootstrap=options.controllerBootstrap||Bootstrap.createAdapter(root);
  this.file=S.inside(root,'state/calibration-journal.json');this.journal=S.fs.existsSync(this.file)?S.read(this.file):null;
 }
 timestamp(){return new Date(this.now()).toISOString();}
 save(phase){if(phase)this.journal.phase=phase;this.journal.updatedAt=this.timestamp();S.write(this.file,this.journal);}
 preflight(){
  S.ready(this.root);S.validateManifest(S.manifest);load('agent-transport').validateCredentials(this.env);
  const d=(this.options.doctor||D.doctor)(this.root);
  if(!d.sourceGuard?.pass||d.sourceGuard.baseSha!==S.manifest.baseSha)S.fail('runner-source-guard-failed');
  if(!d.runtime?.ready)S.fail('runner-runtime-not-ready');
  if(d.certification?.health!=='HEALTHY'||d.certification?.state!=='valid'||!d.liveReady)S.fail('runner-certification-invalid');
  for(const [k,v] of Object.entries(authority.thresholds))if(d.thresholds?.[k]!==v)S.fail('runner-threshold-mismatch');
  if(Telemetry.compilerObservation(this.root).mode!=='NATIVE')S.fail('lhcb02-native-policy-required');
 }
 sessionArtifacts(sid){
  const dir=S.inside(this.root,'nexus-root/data/sessions'),found=[];
  if(S.fs.existsSync(dir))for(const w of S.fs.readdirSync(dir))if(S.fs.statSync(S.inside(dir,w)).isDirectory())for(const leaf of ['session.jsonl.zstd','session.jsonl']){
   const rel='nexus-root/data/sessions/'+w+'/'+sid+'/'+leaf;if(S.fs.existsSync(S.inside(this.root,rel)))found.push(rel);
  }return found;
 }
 async prepareController(){
  if(S.fs.existsSync(this.file)||S.fs.existsSync(S.inside(this.root,'state/binding.json')))S.fail('lhcb02-calibration-fresh-root-required');
  const sessions=S.inside(this.root,'nexus-root/data/sessions');if(S.fs.existsSync(sessions)&&Object.keys(S.inventory(sessions)).length)S.fail('lhcb02-calibration-new-session-required');
  const bindings=S.inside(this.root,'nexus-root/data/routing/session-bindings.json');if(S.fs.existsSync(bindings)&&Object.keys(S.read(bindings).bindings||{}).length)S.fail('lhcb02-nonexclusive-session');
  const sessionId='session-'+S.crypto.randomUUID();
  this.journal={version:2,root:this.root,contractHash:S.contractHash(),identity:null,stages:[],phase:'PREPARING',creation:{sessionId,phase:'CREATING'}};this.save();
  await this.controllerBootstrap.create(sessionId);this.options.fault?.('after-session-create');
  this.journal.creation.phase='CREATED';this.save();
  const a=Bootstrap.exact(await this.controllerBootstrap.prepare(sessionId),sessionId);this.options.fault?.('after-controller-prepare');
  await this.controllerBootstrap.verify(a);
  const artifacts=this.sessionArtifacts(sessionId);if(artifacts.length!==1)S.fail('runner-new-session-artifact-ambiguous');Session.bind(this.root,artifacts[0]);
  const b=Session.binding(this.root);if(!Bootstrap.blankEvents(b.events)||!same(identity(b),identity(a)))S.fail('lhcb02-bootstrap-session-drift');
  this.journal.identity=identity(a);this.journal.creation.authority=a;this.options.fault?.('after-bootstrap-identity');
  this.journal.creation.phase='PREPARED';this.save('PREPARED');
 }
 binding({requireRequest=false}={}){
  const b=Session.binding(this.root);if(!same(identity(b),this.journal.identity))S.fail('runner-session-task-identity-drift');
  const routes=b.events.filter(e=>['request/header','request/context'].includes(e.type));
  // Prepared authority is valid before send. Durable route evidence is a postcondition.
  if(requireRequest&&!routes.length)S.fail('runner-provider-model-unobserved');
  for(const e of routes){const c=e.type==='request/header'?e.data.header?.config:e.data,a=this.journal.creation.authority;
   if(c?.provider!==a.provider||c?.model!==a.model)S.fail('runner-provider-model-mismatch');
  }return b;
 }
 telemetry(){const b=this.binding(),p=Session.currentPressure(this.root);return {...identity(b),pressureTokens:p.pressureTokens};}
 async wait(predicate,timeout,code){const deadline=this.now()+timeout;for(;;){const result=await predicate();if(result)return result;if(this.now()>=deadline)S.fail(code);await this.pause(this.pollMs);}}
 async agentStatus(){const b=this.binding(),r=await this.transport.status(b.sessionId);if(r?.sessionId!==b.sessionId||r.cwd!==S.inside(this.root,'workspace')||!['idle','running'].includes(r.status))S.fail('runner-status-malformed');return r;}
 async durable(r){
  await this.wait(async()=>{
   if((await this.agentStatus()).status!=='idle'||await this.transport.flush(r.sessionId)!==true)return false;
   const b=this.binding();if(S.hash(S.json(b.events.slice(0,r.startSeq)))!==r.prefixHash)S.fail('runner-session-prefix-drift');
   const end=completedTurn(b.events,r);if(end===null)return false;
   this.binding({requireRequest:true});r.endSeq=end;r.durableEventsHash=S.hash(S.json(b.events));return true;
  },this.turnTimeout,'runner-durable-completion-timeout');
  r.outcome='completed';r.after=this.telemetry();r.durableCompletionAt=this.timestamp();r.phase='FLUSHED';
  r.completionSourceHash=S.treeHash(S.inventory(S.inside(this.root,'workspace/src')));this.save('FLUSHED');this.options.fault?.('after-flush');
 }
 finishAcceptance(r){
  if(r.completionSourceHash&&r.completionSourceHash!==S.treeHash(S.inventory(S.inside(this.root,'workspace/src'))))S.fail('lhcb02-source-changed-before-grade');
  const current=protectedHashes(this.root);if(Object.entries(r.protectedHashes).some(([p,h])=>current[p]!==h))S.fail('lhcb02-evidence-modified');
  const ids=S.manifest.calibration.phases.filter(x=>S.manifest.stages.indexOf(x)<=S.manifest.stages.indexOf(r.promptId));
  r.acceptanceResults=r.promptId==='T00'?[]:(this.options.acceptance||acceptance)(this.root,ids);
  r.acceptance=r.promptId==='T00'||(r.acceptanceResults.length===ids.length+1&&r.acceptanceResults.every((x,i)=>x.phase===(ids[i]??'holdout')&&x.pass===true));this.save();
 }
 observe(){const b=this.binding({requireRequest:true});this.requestCache=this.journal.stages.flatMap(r=>Telemetry.collectRequests(this.root,b,r));S.write(S.inside(this.root,'state/request-telemetry.json'),this.requestCache);}
 async runStage(id){
  this.preflight();if(id!==S.manifest.stages[this.journal.stages.length])S.fail('runner-stage-order');
  const evidenceSetHash=release(this.root,id),b=this.binding(),bank=exactPrompt(id);
  if(id==='T00')await this.controllerBootstrap.verify(this.journal.creation.authority);
  if((await this.agentStatus()).status!=='idle'||await this.transport.flush(b.sessionId)!==true)S.fail('runner-agent-busy');
  const r={key:id,rpcId:'lhcb-'+S.crypto.randomUUID(),promptId:id,promptHash:bank.hash,...identity(b),phase:'READY',startSeq:b.events.length,prefixHash:S.hash(S.json(b.events)),evidenceSetHash,protectedHashes:protectedHashes(this.root),before:this.telemetry()};
  this.journal.stages.push(r);this.save('READY');this.options.fault?.('before-intent');
  r.phase='SUBMITTED';r.submitAt=this.timestamp();this.save('SUBMITTED');this.options.fault?.('after-intent');
  await this.transport.submit(r.sessionId,bank.text,r.rpcId);this.options.fault?.('after-rpc');
  await this.durable(r);this.finishAcceptance(r);this.observe();return r;
 }
 async execute(){
  const releaseLease=require('./lease.cjs').acquire(S.inside(this.root,'state/calibration-lock.json'),this.root,this.options);
  try{
   // No replay, recovery or reuse: every execution gets a fresh production session.
   if(S.fs.existsSync(this.file)){this.journal=null;S.fail('lhcb02-calibration-fresh-root-required');}
   this.preflight();await this.prepareController();await this.transport.start();await this.transport.resume(this.journal.creation.sessionId);
   for(const id of S.manifest.stages)await this.runStage(id);
   const b=this.binding({requireRequest:true}),requests=this.requestCache;
   const phases=this.journal.stages.filter(r=>r.promptId!=='T00').map(r=>Telemetry.phaseSummary(b,r,requests.filter(x=>x.phase===r.promptId)));
   const report={benchmarkId:S.manifest.benchmarkId,kind:'CALIBRATION_ONLY',contractHash:S.contractHash(),workloadHash:S.workloadHash(),phases,calibration:Validity.calibration(phases,requests),workload:Validity.workload(null),officialRunCreated:false};
   S.write(S.inside(this.root,'reports/calibration.json'),report);this.save('COMPLETE');return report;
  }catch(e){
   if(this.journal){this.journal.failure={code:e.message};this.save('FAILED');}throw e;
  }finally{try{await this.transport.close?.();}finally{releaseLease();}}
 }
}
module.exports={CalibrationRunner,release,acceptance,protectedHashes,completedTurn,exactPrompt};
