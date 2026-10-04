'use strict';
const {S,load,authority}=require('./infrastructure.cjs');
const {execFileSync}=require('node:child_process');
const fixture=require('../../../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs');
const Telemetry=require('./telemetry.cjs'),Validity=require('./validity.cjs');
const old=load('autorunner'),Session=load('session'),D=load('doctor');
const same=(a,b)=>S.json(a)===S.json(b);
const token=pid=>{try{return S.fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch{return null;}};
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

class CalibrationRunner {
  constructor(root,options={}){
    if(process.version!=='v24.18.1')S.fail('lhcb02-node-version');
    this.root=S.owned(root);if(S.fs.existsSync(S.inside(root,'state/simulation.json')))S.fail('lhcb02-simulation-live-forbidden');this.options=options;this.env=options.env||process.env;
    this.now=options.now||Date.now;this.pause=options.pause||(ms=>new Promise(r=>setTimeout(r,ms)));
    this.pollMs=options.pollMs??250;this.turnTimeout=options.turnTimeoutMs??900000;this.flushTimeout=options.flushTimeoutMs??60000;
    this.transport=options.transport||load('agent-transport').createTransport(this.root,this.env);
    this.controllerBootstrap=options.controllerBootstrap||require('./controller-bootstrap.cjs').createAdapter(this.root);
    this.file=S.inside(root,'state/calibration-journal.json');this.journal=S.fs.existsSync(this.file)?S.read(this.file):null;
    this.validateJournal();
  }
  validateJournal(){
    const j=this.journal;if(!j)return;
    const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
    const identity=x=>object(x)&&/^session-[a-f0-9-]+$/.test(x.sessionId)&&/^TASK-\d+$/.test(x.taskId)&&typeof x.taskInstanceId==='string'&&x.taskInstanceId.length>0;
    if(j.version!==1||j.root!==this.root||j.contractHash!==S.contractHash()||!Array.isArray(j.stages)||j.stages.length>S.manifest.stages.length||
      !['READY','SUBMITTED','AGENT_IDLE','FLUSHED','COMPLETE','FAILED'].includes(j.phase)||!object(j.creation)||!/^session-[a-f0-9-]+$/.test(j.creation.sessionId)||!['READY','CREATING','CREATED','PREPARED'].includes(j.creation.phase)||(j.identity!==null&&!identity(j.identity))||(j.identity&&j.creation.sessionId!==j.identity.sessionId))S.fail('lhcb02-journal-invalid');
    if(j.stages.length&&(!j.identity||j.creation.phase!=='PREPARED'))S.fail('lhcb02-journal-unprepared');
    if(j.creation.phase==='PREPARED'){const a=require('./controller-bootstrap.cjs').exact(j.creation.authority,j.creation.sessionId);if(!j.identity||['sessionId','taskId','taskInstanceId'].some(k=>a[k]!==j.identity[k]))S.fail('lhcb02-journal-unprepared');}
    const rpc=new Set();let pending=false,lastEnd=-1;
    for(const [i,r] of j.stages.entries()){
      if(!object(r)||r.promptId!==S.manifest.stages[i]||r.key!==r.promptId||r.promptHash!==authority.promptHashes[r.promptId]||!['READY','SUBMITTED','AGENT_IDLE','FLUSHED'].includes(r.phase)||
        !Number.isSafeInteger(r.startSeq)||r.startSeq<=lastEnd||!/^lhcb-[a-f0-9-]+$/.test(r.rpcId)||rpc.has(r.rpcId)||r.readOnly!==false||r.allowTurnFailure!==false||!/^([a-f0-9]{64})$/.test(r.prefixHash)||!object(r.protectedHashes)||!object(r.before)||pending||r.sessionId!==j.creation.sessionId||['taskId','taskInstanceId'].some(k=>r[k]!==j.identity?.[k]))S.fail('lhcb02-journal-invalid');
      if(r.phase==='FLUSHED'){
        if(!identity(r)||!Number.isSafeInteger(r.endSeq)||r.endSeq<r.startSeq||!/^([a-f0-9]{64})$/.test(r.durableEventsHash)||!object(r.after)||r.outcome!=='completed')S.fail('lhcb02-journal-invalid');lastEnd=r.endSeq;
      }else pending=true;
      rpc.add(r.rpcId);
    }
  }

  preflight(){
    S.ready(this.root);this.checkContract();old.validateCredentials(this.env);
    old.assertPreflight((this.options.doctor||D.doctor)(this.root));
    const policy=S.read(S.inside(this.root,'nexus-root/config/routing-policy.json'));
    if(policy.contextCompiler.mode!=='off'||policy.contextCompiler.activation!=='pressure')S.fail('lhcb02-native-policy-required');
    const binds=S.inside(this.root,'nexus-root/data/routing/session-bindings.json');if(S.fs.existsSync(binds)&&Object.keys(S.read(binds).bindings||{}).length!==1)S.fail('lhcb02-nonexclusive-session');
    const file=S.inside(this.root,'nexus-root/data/logs/aih-controller.log');
    if(S.fs.existsSync(file)&&S.fs.readFileSync(file,'utf8').split('\n').filter(Boolean).some(line=>{const r=JSON.parse(line);return r.event==='ccv2-opencode-active-decided'&&(r.compilerExecutions!==0||r.projectionMode==='CCV2_COMPILED');}))S.fail('lhcb02-unexpected-compiler-work');
  }
  checkContract(){if(this.journal&&this.journal.contractHash!==S.contractHash())S.fail('lhcb02-contract-drift');S.validateManifest(S.manifest);}
  async prepareController(){
    if(!this.journal){
      if(S.fs.existsSync(S.inside(this.root,'state/binding.json'))||(S.fs.existsSync(S.inside(this.root,'nexus-root/data/sessions'))&&Object.keys(S.inventory(S.inside(this.root,'nexus-root/data/sessions'))).length))S.fail('lhcb02-calibration-new-session-required');
      this.journal={version:1,root:this.root,contractHash:S.contractHash(),identity:null,stages:[],phase:'READY',creation:{sessionId:'session-'+S.crypto.randomUUID(),phase:'READY'}};this.save();
    }
    const c=this.journal.creation;
    if(!this.journal.stages.length){
      if(c.phase==='READY'){c.phase='CREATING';this.save();}
      if(c.phase==='CREATING'){
        await this.controllerBootstrap.create(c.sessionId);this.options.fault?.('after-session-create');
        c.phase='CREATED';this.save();
      }
      const a=require('./controller-bootstrap.cjs').exact(await this.controllerBootstrap.prepare(c.sessionId),c.sessionId);
      this.options.fault?.('after-controller-prepare');
      await this.controllerBootstrap.verify(a);
      if(this.journal.identity&&['sessionId','taskId','taskInstanceId'].some(k=>this.journal.identity[k]!==a[k]))S.fail('lhcb02-bootstrap-identity-drift');
      const candidates=this.sessionArtifacts(c.sessionId);if(candidates.length!==1)S.fail('runner-new-session-artifact-ambiguous');
      Session.bind(this.root,candidates[0]);const b=Session.binding(this.root);
      if(!require('./controller-bootstrap.cjs').blankEvents(b.events)||['sessionId','taskId','taskInstanceId'].some(k=>b[k]!==a[k]))S.fail('lhcb02-bootstrap-session-drift');
      this.journal.identity=old.identity(b);c.authority=a;this.save();this.options.fault?.('after-bootstrap-identity');
      c.phase='PREPARED';this.save();
    }
    if(!this.journal.identity||c.phase!=='PREPARED')S.fail('lhcb02-journal-unprepared');
  }
  async bootstrap(){
    this.preflight();await this.prepareController();
    this.binding();await this.transport.start();await this.transport.resume(this.journal.creation.sessionId);
    for(const r of this.journal.stages){if(r.promptId!=='T00'&&release(this.root,r.promptId)!==r.evidenceSetHash)S.fail('lhcb02-evidence-contract-drift');}
    for(const r of this.journal.stages.filter(r=>r.phase==='FLUSHED')){
      const b=this.binding(),e=old.evidence(b.events,r);if(e?.kind!=='completed'||e.endSeq!==r.endSeq||S.hash(S.json(b.events.slice(0,r.endSeq+1)))!==r.durableEventsHash)S.fail('runner-completed-stage-evidence-drift');
    }
  }
  async runStage(id){
    this.preflight();this.validateJournal();if(!this.journal.identity||this.journal.creation.phase!=='PREPARED')S.fail('lhcb02-journal-unprepared');let r=this.journal.stages.find(r=>r.promptId===id);
    if(r?.phase==='FLUSHED'){if(!r.acceptanceResults)this.finishAcceptance(r);this.observe();return r;}
    const next=S.manifest.stages[this.journal.stages.filter(r=>r.phase==='FLUSHED').length];if(id!==next)S.fail('runner-stage-order');
    if(!r){
      const evidenceSetHash=release(this.root,id),b=this.binding();
      if(id==='T00')await this.controllerBootstrap.verify(this.journal.creation.authority);
      const bank=old.exactPrompt(id);
      r={key:id,rpcId:'lhcb-'+S.crypto.randomUUID(),promptId:id,promptHash:bank.hash,
        ...old.identity(b),
        phase:'READY',startSeq:b?.events.length??0,prefixHash:S.hash(S.json(b?.events||[])),readOnly:false,allowTurnFailure:false,
        evidenceSetHash,protectedHashes:protectedHashes(this.root),before:b?this.telemetry():{pressureTokens:0},after:null};
      this.journal.stages.push(r);this.save('READY');
    }
    if(r.phase==='READY'){
      if(id==='T00')await this.controllerBootstrap.verify(this.journal.creation.authority);
      if((await this.transport.status(r.sessionId)).status!=='idle'||await this.transport.flush(r.sessionId)!==true)S.fail('runner-agent-busy');
      if(!same(protectedHashes(this.root),r.protectedHashes))S.fail('lhcb02-evidence-modified');
      this.options.fault?.('before-intent');r.phase='SUBMITTED';this.save('SUBMITTED');this.options.fault?.('after-intent');
      await this.transport.submit(r.sessionId,old.exactPrompt(id).text,r.rpcId);this.options.fault?.('after-rpc');
    }
    // Persisted SUBMITTED intent is never resent after a lost response.
    await this.durable(r);
    if(!same(protectedHashes(this.root),r.protectedHashes))S.fail('lhcb02-evidence-modified');
    this.finishAcceptance(r);this.observe();
    return r;
  }
  finishAcceptance(r){
    if(r.completionSourceHash&&r.completionSourceHash!==S.treeHash(S.inventory(S.inside(this.root,'workspace/src'))))S.fail('lhcb02-source-changed-before-grade');
    if(!same(protectedHashes(this.root),r.protectedHashes)){
      // Later releases add files; previously protected bytes must still match.
      const current=protectedHashes(this.root);
      if(Object.entries(r.protectedHashes).some(([p,h])=>current[p]!==h))S.fail('lhcb02-evidence-modified');
    }
    const ids=S.manifest.calibration.phases.filter(x=>S.manifest.stages.indexOf(x)<=S.manifest.stages.indexOf(r.promptId));
    r.acceptanceResults=r.promptId==='T00'?[]:(this.options.acceptance||acceptance)(this.root,ids);
    r.acceptance=r.promptId==='T00'||(r.acceptanceResults.length===ids.length+1&&r.acceptanceResults.every((x,i)=>x.phase===(ids[i]??'holdout')&&x.pass===true));
    r.acceptanceSourceHash=S.treeHash(S.inventory(S.inside(this.root,'workspace/src')));
    this.save();
  }
  observe(){
    if(!this.journal?.identity)return;
    const b=this.binding();const file=S.inside(this.root,'state/request-telemetry.json');
    const existing=this.requestCache||[];
    if(existing.some(r=>r.sessionId!==b.sessionId||r.taskId!==b.taskId||r.taskInstanceId!==b.taskInstanceId))S.fail('lhcb02-telemetry-identity-drift');
    const requests=this.journal.stages.flatMap(r=>Telemetry.collectRequests(this.root,b,r));
    S.write(S.inside(this.root,'state/request-telemetry.json'),requests);this.requestCache=requests;
  }
  async wait(predicate,timeout,code){
    return old.AutoRunner.prototype.wait.call(this,async()=>{const result=await predicate();this.observe();return result;},timeout,code);
  }
  async execute(){
    const lock=S.inside(this.root,'state/calibration-lock.json');
    const releaseLease=require('./lease.cjs').acquire(lock,this.root,this.options);
    try{
      // Constructors may precede another invocation; refresh authority under the lease.
      this.journal=S.fs.existsSync(this.file)?S.read(this.file):null;this.validateJournal();
      await this.bootstrap();for(const id of S.manifest.stages)await this.runStage(id);
      this.observe();const b=this.binding(),requests=this.requestCache;
      const phases=this.journal.stages.filter(r=>r.promptId!=='T00').map(r=>Telemetry.phaseSummary(b,r,requests.filter(x=>x.phase===r.promptId)));
      const report={benchmarkId:S.manifest.benchmarkId,kind:'CALIBRATION_ONLY',contractHash:S.contractHash(),phases,
        calibration:Validity.calibration(phases,requests),workload:Validity.workload(null),officialRunCreated:false};
      S.write(S.inside(this.root,'reports/calibration.json'),report);this.save('COMPLETE');return report;
    }catch(e){if(this.journal){this.journal.failure={operation:this.journal.creation?.phase==='PREPARED'?'stage':'controller-bootstrap',creationPhase:this.journal.creation?.phase,code:/^lhcb(?:02)?-[a-z0-9-]+$/.test(e.message)?e.message:'lhcb02-operation-failed'};this.save('FAILED');}throw Error(this.journal?.failure.code||(/^lhcb(?:02)?-[a-z0-9-]+$/.test(e.message)?e.message:'lhcb02-operation-failed'));}
    finally{try{await this.transport.close?.();}finally{releaseLease();}}
  }
}
// Reuse the proven journal completion protocol, including exact user/RPC,
// containing turn, prefix hash, idle/flush and memory generation checks.
for(const name of ['timestamp','telemetry','agentStatus','memoryReady','durable','sessionArtifacts','discoverBinding'])CalibrationRunner.prototype[name]=old.AutoRunner.prototype[name];
CalibrationRunner.prototype.binding=function(){
 const b=Session.binding(this.root);
 if(!same(old.identity(b),this.journal.identity))S.fail('runner-session-task-identity-drift');
 // A blank prepared session has controller route authority but no historical
 // request provenance. Once intent is submitted, the unchanged observer is
 // mandatory; production preparation never substitutes for prompt evidence.
 if(require('./controller-bootstrap.cjs').blankEvents(b.events)&&this.journal.stages.every(r=>r.phase==='READY'))return b;
 return old.AutoRunner.prototype.binding.call(this);
};
CalibrationRunner.prototype.save=function(phase){if(phase==='FLUSHED'){const r=this.journal.stages.at(-1);r.completionSourceHash=S.treeHash(S.inventory(S.inside(this.root,'workspace/src')));}old.AutoRunner.prototype.save.call(this,phase);const fd=S.fs.openSync(this.file,'r+');try{S.fs.fsyncSync(fd);}finally{S.fs.closeSync(fd);}if(process.platform!=='win32'){const directory=S.fs.openSync(S.path.dirname(this.file),'r');try{S.fs.fsyncSync(directory);}finally{S.fs.closeSync(directory);}}if(phase==='AGENT_IDLE')this.options.fault?.('after-idle');if(phase==='FLUSHED')this.options.fault?.('after-flush');};
module.exports={CalibrationRunner,release,acceptance,protectedHashes};
