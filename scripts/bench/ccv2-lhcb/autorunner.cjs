'use strict';
const S=require('./state.cjs'),D=require('./doctor.cjs'),Session=require('./session.cjs');
const Snap=require('./snapshot.cjs'),Restore=require('./restore.cjs'),Arms=require('./arms.cjs'),Collect=require('./collect.cjs'),Report=require('./report.cjs');
const {observeRoute}=require('./route-observation.cjs');
const {validateCredentials}=require('./agent-transport.cjs');
const authority=require('../../../benchmarks/ccv2-lhcb-01/autorunner-authority.json');
const PHASES=['READY','SUBMITTED','AGENT_IDLE','FLUSHED','COLLECTED','CHECKPOINTING','CHECKPOINTED','RESTORING','RUNNING','GRADED','COMPLETE','FAILED'];
const identity=b=>({sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId});
const equal=(a,b)=>S.json(a)===S.json(b);
function exactPrompt(id,read=S.fs.readFileSync){
  if(!S.manifest.stages.includes(id))S.fail('runner-prompt-invalid');
  const files=S.fs.readdirSync(S.path.join(S.BENCH,'prompts')).filter(p=>p.startsWith(id+'-'));
  if(files.length!==1)S.fail('runner-prompt-invalid');
  const text=read(S.path.join(S.BENCH,'prompts',files[0]),'utf8');
  if(typeof text!=='string'||S.hash(text)!==authority.promptHashes[id])S.fail('runner-prompt-digest-mismatch');
  return {id,text,hash:S.hash(text)};
}
function assertPreflight(d){
  if(!d||!d.sourceGuard?.pass||d.sourceGuard.baseSha!==S.manifest.baseSha)S.fail('runner-source-guard-failed');
  if(!d.runtime?.ready)S.fail('runner-runtime-not-ready');
  if(d.certification?.health!=='HEALTHY'||d.certification?.state!=='valid'||d.liveReady!==true)S.fail('runner-certification-invalid');
  for(const [key,value] of Object.entries(authority.thresholds))if(d.thresholds?.[key]!==value)S.fail('runner-threshold-mismatch');
}
function evidence(events,r){
  const users=events.filter(e=>e.seq>=r.startSeq&&(r.endSeq==null||e.seq<=r.endSeq)&&e.type==='user/message'&&e.surfaceOp!=='replace'&&(!e.data.source||e.data.source.kind==='user'));
  const matches=users.filter(e=>e.type==='user/message'&&Array.isArray(e.data.content)&&Session.promptContent(e.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))===Session.promptContent(exactPrompt(r.promptId).text));
  if(matches.length>1)S.fail('runner-duplicate-prompt-evidence');
  if(users.length!==matches.length)S.fail('runner-unexpected-user-message');
  if(!matches.length)return null;
  const user=matches[0];if(r.rpcId&&user.data.source?.rpcId!==r.rpcId)S.fail('runner-prompt-provenance-mismatch');
  // The first containing turn owns completion; a later unrelated completed turn is not evidence.
  const prior=events.slice(0,user.seq+1).findLast(e=>e.type==='turn/start');
  const next=events.find(e=>e.seq>user.seq&&e.type==='turn/start');
  const end=events.find(e=>e.seq>user.seq&&(!next||e.seq<next.seq)&&e.type==='turn/end');
  if(end&&prior&&end.data.turn!==prior.data.turn)S.fail('runner-turn-identity-mismatch');
  return {userSeq:user.seq,endSeq:end?.seq??null,kind:end?.data.reason?.kind??null};
}
function workspace(root){
  const dir=S.inside(root,'workspace');S.noLinks(dir);
  const files=S.inventory(dir);return {path:S.fs.realpathSync(dir),head:S.git(dir,['rev-parse','HEAD']),tree:S.git(dir,['rev-parse','HEAD^{tree}']),gitStatus:S.git(dir,['status','--porcelain=v1','--untracked-files=all']),sourceHash:S.treeHash(Object.fromEntries(Object.entries(files).filter(([p])=>!p.startsWith('.git/')&&!p.startsWith('.ai-harness/'))))};
}
function checkpointBand(id,p){const n=p.pressureTokens,t=p.dshThresholdTokens;if(!Number.isFinite(n))S.fail('runner-pressure-unavailable');return id==='CP-500'?n>=480000&&n<=550000:id==='CP-750'?n>=720000&&n<=790000:id==='CP-PRE-DSH'?n>=t-65536&&n<t:id==='CP-OVERFLOW'?n>=p.activationTokens:false;}
function processToken(pid){try{return S.fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch{return null;}}
class AutoRunner {
  constructor(root,options={}){
    this.root=S.owned(S.rootOf(root));this.options=options;this.env=options.env||process.env;
    this.now=options.now||Date.now;this.pause=options.pause||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.transport=options.transport||require('./agent-transport.cjs').createTransport(this.root,this.env);
    this.ops={snapshot:Snap.createSnapshot,verifySnapshot:Snap.verifySnapshot,restore:Restore.restore,arm:Arms.start,collect:Collect.collect,grade:Collect.gradeRun,report:Report.report,...options.operations};
    this.file=S.inside(this.root,'state/autorunner.json');this.journal=S.fs.existsSync(this.file)?S.read(this.file):null;
    if(this.journal&&(this.journal.version!==1||this.journal.root!==this.root||this.journal.contractHash!==authority.contractHash||!PHASES.includes(this.journal.phase)||!Array.isArray(this.journal.stages)||!this.journal.checkpoints||!this.journal.arms))S.fail('runner-state-invalid');
    if(this.journal){const stagePhases=['READY','SUBMITTED','AGENT_IDLE','FLUSHED'];const keys=new Set();for(const r of this.journal.stages){if(!r||!stagePhases.includes(r.phase)||!S.manifest.stages.includes(r.promptId)||r.promptHash!==authority.promptHashes[r.promptId]||typeof r.key!=='string'||keys.has(r.key)||!Number.isSafeInteger(r.startSeq)||r.startSeq<0||(r.origin!=='manual'&&(typeof r.rpcId!=='string'||!/^lhcb-[a-f0-9-]+$/.test(r.rpcId))))S.fail('runner-state-invalid');if(r.origin!=='manual'&&(r.readOnly!==(r.promptId!=='T99')||r.allowTurnFailure!==(r.promptId==='T99')||(r.promptId==='T99'&&(r.runId!==r.key||!r.runId))))S.fail('runner-state-invalid');if(r.phase==='FLUSHED'&&(!Number.isSafeInteger(r.endSeq)||r.endSeq<r.startSeq||!/^([a-f0-9]{64})$/.test(r.durableEventsHash)))S.fail('runner-state-invalid');keys.add(r.key);}}
    if(this.journal){
      for(const field of ['checkpoints','arms'])if(typeof this.journal[field]!=='object'||Array.isArray(this.journal[field]))S.fail('runner-state-invalid');
      const ids=new Set();for(const [cp,entry] of Object.entries(this.journal.checkpoints))if(!S.manifest.checkpoints.includes(cp)||!['CHECKPOINTING','CHECKPOINTED'].includes(entry?.phase)||!equal(entry.identity,this.journal.identity)||!Number.isFinite(entry.pressure?.pressureTokens)||(entry.phase==='CHECKPOINTED'&&!/^[a-f0-9]{64}$/.test(entry.snapshotSeal)))S.fail('runner-state-invalid');
      for(const [cp,runs] of Object.entries(this.journal.arms)){
        if(!this.journal.checkpoints[cp]||!runs||typeof runs!=='object'||Array.isArray(runs))S.fail('runner-state-invalid');
        for(const [arm,run] of Object.entries(runs)){
          if(!Object.hasOwn(S.manifest.arms,arm)||run?.arm!==arm||!['RESTORING','RUNNING','COLLECTED','GRADED'].includes(run.phase)||typeof run.runId!=='string'||!/^auto-[A-Za-z0-9_-]+$/.test(run.runId)||ids.has(run.runId)||!/^[a-f0-9]{64}$/.test(run.snapshotSeal)||(run.phase!=='RESTORING'&&!/^[a-f0-9]{64}$/.test(run.manifestHash))||(run.phase==='GRADED'&&(!/^[a-f0-9]{64}$/.test(run.resultHash)||!/^[a-f0-9]{64}$/.test(run.gradeHash))))S.fail('runner-state-invalid');ids.add(run.runId);
        }
      }
    }
    this.turnTimeout=options.turnTimeoutMs??900000;this.flushTimeout=options.flushTimeoutMs??60000;this.pollMs=options.pollMs??250;
  }
  timestamp(){return new Date(this.now()).toISOString();}
  save(phase){if(phase)this.journal.phase=phase;this.journal.updatedAt=this.timestamp();S.write(this.file,this.journal);}
  checkContract(){if(S.contractHash()!==authority.contractHash)S.fail('runner-contract-drift');for(const stage of S.manifest.stages)exactPrompt(stage);}
  assertStageOrder(id,options={}){
    const initial=S.manifest.stages.slice(0,8);if(!S.manifest.stages.includes(id))S.fail('runner-stage-order');
    let completed;
    if(this.journal)completed=this.journal.stages.filter(r=>r.phase==='FLUSHED').map(r=>r.promptId);
    else{
      const file=S.inside(this.root,'state/stages.json'),rows=S.fs.existsSync(file)?S.read(file):[];
      const b=rows.length?Session.binding(this.root):null;
      completed=rows.filter((r,index)=>evidence(b.events.slice(0,rows[index+1]?.startSeq??b.events.length),{promptId:r.stage,startSeq:r.startSeq})?.kind==='completed').map(r=>r.stage);
    }
    const seen=[];for(const stage of completed)if(initial.includes(stage)&&!seen.includes(stage)){if(stage!==initial[seen.length])S.fail('runner-stage-order');seen.push(stage);}
    const required=id==='T99'||options.repeat?initial:initial.slice(0,initial.indexOf(id));
    if(required.some(stage=>!seen.includes(stage)))S.fail('runner-stage-order');
    if(this.journal&&seen.length){const b=this.binding();for(const stage of seen){const r=this.journal.stages.find(r=>r.promptId===stage&&r.phase==='FLUSHED'),e=evidence(b.events,r);if(e?.kind!=='completed'||e.endSeq!==r.endSeq||S.hash(S.json(b.events.slice(0,r.endSeq+1)))!==r.durableEventsHash)S.fail('runner-completed-stage-evidence-drift');}}
  }
  preflight(){this.checkContract();validateCredentials(this.env);assertPreflight((this.options.doctor||D.doctor)(this.root));}
  binding(){const b=Session.binding(this.root);if(this.journal?.identity&&!equal(identity(b),this.journal.identity))S.fail('runner-session-task-identity-drift');observeRoute(b.events,b);return b;}
  telemetry(){const b=this.binding(),p=Session.currentPressure(this.root);return {pressureTokens:p.pressureTokens,usageSamples:b.events.filter(e=>e.type==='assistant/message'&&e.data.usage&&Number.isFinite(e.data.usage.inputTokens)).length,dshThresholdTokens:p.dshThresholdTokens,activationTokens:p.activationTokens,...identity(b)};}
  async wait(predicate,timeout,code){const deadline=this.now()+timeout;for(;;){const result=await predicate();if(result)return result;if(this.now()>=deadline)S.fail(code);await this.pause(this.pollMs);}}
  async agentStatus(){const b=this.binding(),r=await this.transport.status(b.sessionId);if(!r||r.sessionId!==b.sessionId||r.cwd!==S.inside(this.root,'workspace')||!['idle','running'].includes(r.status))S.fail('runner-status-malformed');return r;}
  memoryReady(b,endSeq){
    try{const dir=S.inside(this.root,'workspace/.ai-harness/ccv2/'+b.taskId);const state=S.read(S.inside(dir,'producer/state.json')),staged=S.read(S.inside(dir,'staged.json'));
      if(!equal({sessionId:state.namespace?.sessionId,taskId:state.namespace?.taskId,taskInstanceId:state.namespace?.taskInstanceId},identity(b))||state.namespace.workspaceId!==S.inside(this.root,'workspace'))S.fail('runner-memory-identity-drift');
      if(state.blocker||staged.blocker)S.fail('runner-memory-blocked');
      return state.openTurn===null&&staged.activeTurn===null&&state.processedThroughSeq>=endSeq&&staged.processedThroughSeq>=endSeq&&state.sealedGeneration>0&&staged.sealedGeneration===state.sealedGeneration&&state.sealedCheckpointId===staged.sealedCheckpointId;
    }catch(e){if(/^lhcb-runner-/.test(e.message))throw e;return false;}
  }
  async durable(record){
    await this.wait(async()=>{return (await this.agentStatus()).status==='idle';},this.turnTimeout,'runner-agent-idle-timeout');
    record.phase='AGENT_IDLE';this.save('AGENT_IDLE');
    await this.wait(async()=>{
      if(await this.transport.flush(record.sessionId)!==true)return false;
      const b=this.binding();if(S.hash(S.json(b.events.slice(0,record.startSeq)))!==record.prefixHash)S.fail('runner-session-prefix-drift');
      const e=evidence(b.events,record);if(!e?.kind)return false;
      if(e.kind!=='completed'&&!record.allowTurnFailure)S.fail('runner-turn-failed');
      if(!this.memoryReady(b,e.endSeq))return false;
      if((await this.agentStatus()).status!=='idle')return false;
      record.endSeq=e.endSeq;record.outcome=e.kind;record.durableEventsHash=S.hash(S.json(b.events.slice(0,e.endSeq+1)));return true;
    },this.flushTimeout,'runner-durable-flush-timeout');
    if(record.readOnly){const after=workspace(this.root);if(after.gitStatus||!equal(after,record.workspaceBefore))S.fail('runner-read-only-workspace-mutated');}
    record.after=this.telemetry();record.durableCompletionAt=this.timestamp();record.sessionLogHash=S.hash(S.fs.readFileSync(S.inside(this.root,this.binding().sessionLog)));record.phase='FLUSHED';if(Number.isSafeInteger(record.auditCursorBefore))this.journal.auditCursor=record.auditCursorBefore+1;this.save('FLUSHED');
  }
  prepareManualAdoption(){
    S.ready(this.root);this.checkContract();
    const prior=this.journal;
    const emptyFailure=prior?.phase==='FAILED'&&prior.failure?.code==='lhcb-runner-provider-model-unobserved'&&!prior.identity&&!prior.creation&&!prior.stages.length&&!Object.keys(prior.checkpoints).length&&!Object.keys(prior.arms).length;
    const readyManual=prior?.phase==='READY'&&prior.identity&&!prior.creation&&prior.stages.every(r=>r.origin==='manual'&&r.phase==='FLUSHED')&&!Object.keys(prior.checkpoints).length&&!Object.keys(prior.arms).length;
    if(prior&&!emptyFailure&&!readyManual)S.fail('runner-manual-adoption-ambiguous');
    const ws=workspace(this.root),fixture=S.read(S.inside(this.root,'state/fixture.json'));
    if(ws.gitStatus||ws.head!==fixture.commit||ws.tree!==fixture.tree)S.fail('runner-workspace-not-pristine');
    const b=Session.binding(this.root),routeAdoption=observeRoute(b.events,b);
    if(prior?.identity&&!equal(prior.identity,identity(b)))S.fail('runner-session-task-identity-drift');
    const file=S.inside(this.root,'state/stages.json'),stages=S.fs.existsSync(file)?S.read(file):[];Session.verifyStages(this.root,b,stages);
    const receipts=[];
    for(const [index,stage] of stages.entries()){
      const events=b.events.slice(0,stages[index+1]?.startSeq??b.events.length),e=evidence(events,{promptId:stage.stage,startSeq:stage.startSeq});
      if(e?.kind!=='completed')S.fail('runner-manual-stage-incomplete');
      receipts.push({key:'manual-'+index,promptId:stage.stage,promptHash:stage.promptHash,...identity(b),phase:'FLUSHED',startSeq:stage.startSeq,endSeq:e.endSeq,durableEventsHash:S.hash(S.json(b.events.slice(0,e.endSeq+1))),origin:'manual',submitAt:null,durableCompletionAt:null,availability:{timestamps:'Manual stages predate runner receipts; timestamps were not recorded',telemetry:'Before/after samples were not recorded by manual prompt issuance'}});
    }
    if(readyManual&&!equal(prior.stages,receipts))S.fail('runner-completed-stage-evidence-drift');
    const journal=prior?JSON.parse(S.json(prior)):{version:1,root:this.root,contractHash:authority.contractHash,workspacePath:ws.path,fixtureCommit:fixture.commit,checkpoints:{},arms:{},createdAt:this.timestamp()};
    if(journal.workspacePath!==ws.path||journal.fixtureCommit!==fixture.commit)S.fail('runner-workspace-identity-drift');
    journal.phase='READY';journal.identity=identity(b);journal.stages=receipts;journal.routeAdoption=routeAdoption;delete journal.failure;
    return journal;
  }
  async bootstrap(options={}){
    this.preflight();
    if(S.fs.existsSync(S.inside(this.root,'state/binding.json'))&&(!this.journal||(this.journal.phase==='FAILED'&&this.journal.failure?.code==='lhcb-runner-provider-model-unobserved'&&!this.journal.identity))){this.journal=this.prepareManualAdoption();this.save('READY');}
    if(!this.journal){
      const ws=workspace(this.root),f=S.read(S.inside(this.root,'state/fixture.json'));if(ws.gitStatus||ws.head!==f.commit||ws.tree!==f.tree)S.fail('runner-workspace-not-pristine');
      this.journal={version:1,root:this.root,contractHash:authority.contractHash,phase:'READY',identity:null,workspacePath:ws.path,fixtureCommit:f.commit,stages:[],checkpoints:{},arms:{},createdAt:this.timestamp()};
      const file=S.inside(this.root,'state/binding.json');
      if(!S.fs.existsSync(file)){
        if(!options.newSession)S.fail('runner-bind-session-first');
        if(S.fs.readdirSync(S.inside(this.root,'runs')).length||S.fs.readdirSync(S.inside(this.root,'snapshots')).length||S.fs.existsSync(S.inside(this.root,'state/stages.json')))S.fail('runner-new-session-refused');
        this.journal.creation={sessionId:'session-'+S.crypto.randomUUID(),phase:'READY'};
      }
      this.save('READY');
    }
    if(this.journal.workspacePath!==S.fs.realpathSync(S.inside(this.root,'workspace')))S.fail('runner-workspace-identity-drift');
    await this.transport.start();
    if(!this.journal.identity){
      const c=this.journal.creation;if(!c||!['READY','CREATING','CREATED'].includes(c.phase))S.fail('runner-state-invalid');
      if(c.phase==='READY'){c.phase='CREATING';this.save();await this.transport.create(c.sessionId);c.phase='CREATED';this.save();}
      else{const artifacts=this.sessionArtifacts(c.sessionId);if(artifacts.length!==1)S.fail('runner-new-session-artifact-ambiguous');const parsed=Session.decode(this.root,artifacts[0]);if(parsed.header.id!==c.sessionId||parsed.header.cwd!==S.inside(this.root,'workspace'))S.fail('runner-session-task-identity-drift');await this.transport.resume(c.sessionId);c.phase='CREATED';this.save();}
      return;
    }
    const b=this.binding();await this.transport.resume(b.sessionId);
  }
  sessionArtifacts(sid){
    const dir=S.inside(this.root,'nexus-root/data/sessions');const candidates=[];
    if(S.fs.existsSync(dir))for(const w of S.fs.readdirSync(dir)){const child=S.inside(dir,w);if(!S.fs.statSync(child).isDirectory())continue;for(const leaf of ['session.jsonl.zstd','session.jsonl']){const rel='nexus-root/data/sessions/'+w+'/'+sid+'/'+leaf;if(S.fs.existsSync(S.inside(this.root,rel)))candidates.push(rel);}}
    return candidates;
  }
  discoverBinding(){
    const sid=this.journal.creation.sessionId,candidates=this.sessionArtifacts(sid);if(candidates.length!==1)S.fail('runner-new-session-artifact-ambiguous');Session.bind(this.root,candidates[0]);const b=Session.binding(this.root);if(b.sessionId!==sid)S.fail('runner-session-task-identity-drift');this.journal.identity=identity(b);this.save();return b;
  }
  async runStage(id,options={}){
    this.assertStageOrder(id,options);this.preflight();const bank=exactPrompt(id);if(!this.journal)await this.bootstrap(options);
    if(options.stageId!==undefined&&!/^stage-[A-Za-z0-9_-]{1,80}$/.test(options.stageId))S.fail('runner-stage-id-invalid');
    let record=options.record||this.journal.stages.find(r=>r.key===options.stageId);
    const unresolved=this.journal.stages.find(r=>r.origin!=='manual'&&r.phase!=='FLUSHED');
    if(record&&unresolved&&record!==unresolved)S.fail('runner-pending-stage');
    if(!record&&unresolved){if(unresolved.promptId!==id||unresolved.runId!==(options.runId||null))S.fail('runner-pending-stage');record=unresolved;}
    if(!record&&!options.repeat){record=this.journal.stages.findLast(r=>r.promptId===id&&!r.runId);if(record?.origin==='manual'&&record.phase==='FLUSHED'){const e=evidence(this.binding().events,record);if(e?.kind!=='completed'||e.endSeq!==record.endSeq||S.hash(S.json(this.binding().events.slice(0,record.endSeq+1)))!==record.durableEventsHash)S.fail('runner-completed-stage-evidence-drift');return record;}}
    if(!record){
      const pending=this.journal.stages.find(r=>r.origin!=='manual'&&r.phase!=='FLUSHED');if(pending)S.fail('runner-pending-stage');
      if(id==='T99'&&!options.runId)S.fail('runner-t99-requires-arm');
      if(id!=='T99'){
        const currentFile=S.inside(this.root,'state/current.json');if(S.fs.existsSync(currentFile)&&S.read(currentFile).arm)S.fail('runner-arm-in-progress');
        if(Object.values(this.journal.arms).some(runs=>Object.values(runs).some(run=>run.phase!=='GRADED')))S.fail('runner-arm-in-progress');
        if(!equal(S.read(S.inside(this.root,'nexus-root/config/routing-policy.json')).contextCompiler,S.manifest.arms.production))S.fail('runner-accumulation-policy-mismatch');
      }
      const ws=workspace(this.root);if(ws.path!==this.journal.workspacePath||ws.head!==this.journal.fixtureCommit)S.fail('runner-workspace-identity-drift');if(id!=='T99'&&(ws.gitStatus||ws.head!==this.journal.fixtureCommit))S.fail('runner-workspace-not-pristine');
      if(id!=='T99'&&this.journal.identity){const p=this.telemetry();if(S.manifest.checkpoints.some(cp=>this.journal.checkpoints[cp]?.phase!=='CHECKPOINTED'&&checkpointBand(cp,p)))S.fail('runner-checkpoint-pending');}
      let b;if(this.journal.identity)b=this.binding();else if(id!=='T00')S.fail('runner-new-session-requires-t00');
      record={key:options.runId||options.stageId||S.crypto.randomUUID(),rpcId:'lhcb-'+S.crypto.randomUUID(),promptId:id,promptHash:bank.hash,...(b?identity(b):{sessionId:this.journal.creation.sessionId,taskId:null,taskInstanceId:null}),phase:'READY',startSeq:b?.events.length||0,prefixHash:S.hash(S.json(b?.events||[])),workspaceBefore:ws,readOnly:id!=='T99',repeat:options.repeat===true,auditCursorBefore:options.auditCursor??null,runId:options.runId||null,allowTurnFailure:id==='T99',before:b?this.telemetry():{pressureTokens:0,usageSamples:0},submitAt:null,durableCompletionAt:null};
      this.journal.stages.push(record);this.save('READY');
    }
    if(record.promptHash!==bank.hash||record.promptId!==id)S.fail('runner-prompt-digest-mismatch');
    if(record.phase==='FLUSHED'){
      if(record.origin!=='manual'){const b=this.binding();const e=evidence(b.events,record);if(e?.endSeq!==record.endSeq||e.kind!==record.outcome||S.hash(S.json(b.events.slice(0,record.endSeq+1)))!==record.durableEventsHash||S.hash(S.json(b.events.slice(0,record.startSeq)))!==record.prefixHash)S.fail('runner-completed-stage-evidence-drift');}return record;
    }
    // Reconcile an issuance crash through the exact existing stage receipt, never blindly issue twice.
    if(record.phase==='READY'){
      if(this.journal.identity){if((await this.agentStatus()).status!=='idle')S.fail('runner-agent-busy');if(await this.transport.flush(record.sessionId)!==true)S.fail('runner-agent-flush-failed');const previous=this.binding().events.findLast(e=>e.type==='turn/end');if(previous&&!this.memoryReady(this.binding(),previous.seq))S.fail('runner-prior-stage-not-durable');}
      if(record.readOnly&&!equal(workspace(this.root),record.workspaceBefore))S.fail('runner-read-only-workspace-mutated');
      const file=S.inside(this.root,'state/stages.json'),stages=S.fs.existsSync(file)?S.read(file):[];
      const last=stages.at(-1);if(!last||last.stage!==id||last.promptHash!==bank.hash||last.startSeq!==record.startSeq){Session.prompt(this.root,id,{repeat:record.repeat});}
      else if(last.expectedSessionId&&last.expectedSessionId!==record.sessionId)S.fail('runner-prompt-provenance-mismatch');
      this.preflight();record.phase='SUBMITTED';record.submitAt=this.timestamp();this.save('SUBMITTED');
      await this.transport.submit(record.sessionId,bank.text,record.rpcId);
    }
    // SUBMITTED is an irreversible intent. On resume only inspect/flush; never retransmit.
    if(!this.journal.identity){
      await this.wait(async()=>{const status=await this.transport.status(record.sessionId);if(status?.sessionId!==record.sessionId||status.cwd!==S.inside(this.root,'workspace')||!['idle','running'].includes(status.status))S.fail('runner-status-malformed');if(status.status!=='idle')return false;return await this.transport.flush(record.sessionId)===true;},this.turnTimeout,'runner-agent-idle-timeout');
      const b=this.discoverBinding();Object.assign(record,identity(b));
    }
    await this.durable(record);return record;
  }
  async checkpoint(id){
    if(!S.manifest.checkpoints.includes(id))S.fail('runner-checkpoint-invalid');this.preflight();const before=this.telemetry();if(!checkpointBand(id,before))S.fail('runner-checkpoint-outside-band');
    const stages=S.read(S.inside(this.root,'state/stages.json'));if(!S.manifest.stages.slice(0,8).every(x=>stages.some(s=>s.stage===x)))S.fail('runner-checkpoint-audits-incomplete');
    const entry=this.journal.checkpoints[id]||{phase:'CHECKPOINTING',identity:this.journal.identity,pressure:before,snapshotSeal:null};this.journal.checkpoints[id]=entry;this.save('CHECKPOINTING');
    const b=this.binding(),last=b.events.findLast(e=>e.type==='turn/end');if(!last||!this.memoryReady(b,last.seq)||(await this.agentStatus()).status!=='idle'||await this.transport.flush(b.sessionId)!==true)S.fail('runner-checkpoint-not-durable');
    await this.transport.stop();
    const dir=S.inside(this.root,'snapshots/'+id);if(!S.fs.existsSync(dir))this.ops.snapshot(this.root,id,{stopped:true});
    const meta=this.ops.verifySnapshot(dir);this.checkSnapshot(meta,entry);entry.snapshotSeal=S.hash(S.json(meta));entry.phase='CHECKPOINTED';entry.createdAt=meta.createdAt;this.save('CHECKPOINTED');return entry;
  }
  checkSnapshot(meta,entry){if(!equal({sessionId:meta.sessionId,taskId:meta.taskId,taskInstanceId:meta.taskInstanceId},entry.identity)||meta.pressureTokens!==entry.pressure.pressureTokens||meta.baseSha!==S.manifest.baseSha||meta.contractHash!==authority.contractHash||(entry.snapshotSeal&&S.hash(S.json(meta))!==entry.snapshotSeal))S.fail('runner-snapshot-identity-mismatch');}
  async runUntil(target,options={}){
    if(!S.manifest.checkpoints.includes(target))S.fail('runner-checkpoint-invalid');if(!this.journal)await this.bootstrap(options);else await this.bootstrap();
    if(this.journal.checkpoints[target]?.phase==='CHECKPOINTED')return {phase:'CHECKPOINTED',checkpoint:target,...this.journal.checkpoints[target]};
    const max=options.maxStages??28;if(!Number.isSafeInteger(max)||max<1||max>10000)S.fail('runner-stage-budget-invalid');
    for(let index=0;index<=max;index++){
      const pending=this.journal.stages.find(r=>r.origin!=='manual'&&!r.runId&&r.phase!=='FLUSHED');if(pending)await this.runStage(pending.promptId,{record:pending});
      this.preflight();const p=this.journal.identity?this.telemetry():null;
      if(p){for(const cp of S.manifest.checkpoints)if(this.journal.checkpoints[cp]?.phase!=='CHECKPOINTED'&&checkpointBand(cp,p)){const entry=await this.checkpoint(cp);return {phase:'CHECKPOINTED',checkpoint:cp,requestedCheckpoint:target,...entry};}}
      if(index===max)break;
      const issued=S.fs.existsSync(S.inside(this.root,'state/stages.json'))?S.read(S.inside(this.root,'state/stages.json')):[];
      const next=S.manifest.stages.slice(0,8).find(id=>!issued.some(r=>r.stage===id));
      const id=next||S.manifest.stages[1+((this.journal.auditCursor||0)%7)];
      await this.runStage(id,{repeat:!next,auditCursor:next?undefined:(this.journal.auditCursor||0)});
    }
    const compacted=this.binding().events.some(e=>e.type==='compaction/end'&&e.data.error===undefined);
    const outcome=target==='CP-OVERFLOW'&&compacted?'NOT_TRIGGERED':'INSUFFICIENT_DATA';this.journal.limits={checkpoint:target,outcome,stageBudget:max,pressure:this.telemetry()};this.save('COMPLETE');return {phase:'COMPLETE',...this.journal.limits};
  }
  async runArms(cp){
    if(!this.journal)await this.bootstrap();if(!S.manifest.checkpoints.includes(cp))S.fail('runner-checkpoint-invalid');
    const entry=this.journal.checkpoints[cp];if(!entry||entry.phase!=='CHECKPOINTED')S.fail('runner-checkpoint-not-recorded');
    const meta=this.ops.verifySnapshot(S.inside(this.root,'snapshots/'+cp));this.checkSnapshot(meta,entry);
    this.journal.arms[cp]||={};
    if(entry.armsComplete===true){for(const arm of ['native','production','forced']){const run=this.journal.arms[cp][arm];if(run?.phase!=='GRADED')S.fail('runner-state-invalid');this.verifyRun(run,entry);}return this.ops.report(this.root);}
    for(const arm of ['native','production','forced']){
      let run=this.journal.arms[cp][arm];if(run?.phase==='GRADED'){this.verifyRun(run,entry);continue;}
      if(!run){run={phase:'RESTORING',arm,runId:'auto-'+cp+'-'+arm+'-'+S.crypto.randomUUID(),snapshotSeal:entry.snapshotSeal};this.journal.arms[cp][arm]=run;this.save('RESTORING');}
      if(run.snapshotSeal!==entry.snapshotSeal)S.fail('runner-arm-snapshot-mismatch');
      if(run.phase==='RESTORING'){
        await this.transport.stop();this.ops.restore(this.root,cp,{stopped:true});const current=S.read(S.inside(this.root,'state/current.json'));if(current.checkpoint!==cp||current.snapshotSeal!==entry.snapshotSeal)S.fail('runner-arm-snapshot-mismatch');
        this.preflight();this.binding();const file=S.inside(this.root,'runs/'+run.runId+'/run.json');if(S.fs.existsSync(file))S.fail('runner-arm-start-ambiguous');
        const started=this.ops.arm(this.root,arm,{stopped:true,runId:run.runId});if(started.snapshotSeal!==entry.snapshotSeal)S.fail('runner-arm-snapshot-mismatch');
        run.manifestHash=S.hash(S.fs.readFileSync(file));run.phase='RUNNING';this.save('RUNNING');
      }
      this.verifyRun(run,entry);
      if(run.phase==='RUNNING'){
        this.preflight();await this.transport.start();await this.transport.resume(this.journal.identity.sessionId);
        const record=this.journal.stages.find(r=>r.runId===run.runId);await this.runStage('T99',{runId:run.runId,record});await this.transport.stop();
        const dir=Collect.runPath(this.root,run.runId);if(!S.fs.existsSync(S.inside(dir,'result.json')))this.ops.collect(this.root,run.runId,{stopped:true});
        run.phase='COLLECTED';this.save('COLLECTED');
      }
      if(run.phase==='COLLECTED'){this.verifyRun(run,entry);const dir=Collect.runPath(this.root,run.runId);const resultFile=S.inside(dir,'result.json');const result=S.read(resultFile);if(result.correctnessGate===null||!S.fs.existsSync(S.inside(dir,'grade.json')))this.ops.grade(this.root,run.runId);run.resultHash=S.hash(S.fs.readFileSync(resultFile));run.gradeHash=S.hash(S.fs.readFileSync(S.inside(dir,'grade.json')));run.phase='GRADED';this.save('GRADED');this.ops.report(this.root);}
    }
    // Put accumulation back at the same clean baseline; T99 never becomes pressure history.
    await this.transport.stop();this.ops.restore(this.root,cp,{stopped:true});this.binding();entry.armsComplete=true;this.save('COMPLETE');return this.ops.report(this.root);
  }
  verifyRun(run,entry){
    if(run.snapshotSeal!==entry.snapshotSeal)S.fail('runner-arm-snapshot-mismatch');const stored=S.read(S.inside(this.root,'runs/'+run.runId+'/run.json'));
    if(S.hash(S.fs.readFileSync(S.inside(this.root,'runs/'+run.runId+'/run.json')))!==run.manifestHash)S.fail('runner-arm-manifest-drift');
    if(stored.snapshotSeal!==entry.snapshotSeal||stored.arm!==run.arm||!equal(identity(stored),entry.identity))S.fail('runner-arm-snapshot-mismatch');
    if(run.phase==='GRADED'){const dir=Collect.runPath(this.root,run.runId);if(S.hash(S.fs.readFileSync(S.inside(dir,'result.json')))!==run.resultHash||S.hash(S.fs.readFileSync(S.inside(dir,'grade.json')))!==run.gradeHash)S.fail('runner-graded-receipt-drift');}
    if(run.phase!=='GRADED'){const policy=S.read(S.inside(this.root,'nexus-root/config/routing-policy.json'));if(!equal(policy.contextCompiler,S.manifest.arms[run.arm]))S.fail('runner-arm-policy-mismatch');const current=S.read(S.inside(this.root,'state/current.json'));if(current.runId!==run.runId)S.fail('runner-arm-current-mismatch');}
  }
  async runAll(options={}){
    const recovery=S.inside(this.root,'state/restore-lock.json');if(S.fs.existsSync(recovery)){const cp=S.read(recovery).checkpoint;if(!this.journal?.checkpoints[cp])S.fail('runner-restore-recovery-ambiguous');await this.runArms(cp);}
    await this.bootstrap(options);for(const [cp,runs] of Object.entries(this.journal.arms))if(Object.values(runs).some(r=>r.phase!=='GRADED'))await this.runArms(cp);for(const target of S.manifest.checkpoints){
      if(this.journal.checkpoints[target]?.armsComplete===true){await this.runArms(target);continue;}
      for(;;){const result=await this.runUntil(target,options);if(result.phase!=='CHECKPOINTED')break;await this.runArms(result.checkpoint);if(result.checkpoint===target)break;}
    }
    this.save('COMPLETE');return this.ops.report(this.root);
  }
  status(){let pressure=null;try{pressure=this.telemetry();}catch{}return {benchmarkId:S.manifest.benchmarkId,phase:this.journal?.phase||'READY',identity:this.journal?.identity||null,pressure,journal:this.journal};}
  async execute(command,arg,options={}){
    if(command==='run-status')return this.status();if(command==='run-stage')this.assertStageOrder(arg,options);const lock=S.inside(this.root,'state/autorunner.lock.json');
    if(S.fs.existsSync(lock)){const prior=S.read(lock);if(prior.root!==this.root||prior.contractHash!==authority.contractHash||!Number.isSafeInteger(prior.pid))S.fail('runner-lock-invalid');const token=processToken(prior.pid);if(token&&token===prior.processToken)S.fail('runner-busy');if(token)S.fail('runner-lock-ambiguous');S.fs.unlinkSync(lock);}
    const fd=S.fs.openSync(lock,'wx',0o600);S.fs.writeFileSync(fd,S.json({root:this.root,contractHash:authority.contractHash,pid:process.pid,processToken:processToken(process.pid)}));S.fs.closeSync(fd);
    try{
      if(command==='run-stage'){await this.bootstrap(options);const record=await this.runStage(arg,options);const p=this.telemetry(),cp=S.manifest.checkpoints.find(cp=>this.journal.checkpoints[cp]?.phase!=='CHECKPOINTED'&&checkpointBand(cp,p));if(cp&&arg!=='T99')await this.checkpoint(cp);return record;}
      if(command==='run-until')return await this.runUntil(arg,options);
      if(command==='run-arms')return await this.runArms(arg);
      if(command==='run-all')return await this.runAll(options);
      S.fail('runner-command-invalid');
    }catch(e){const code=/^lhcb-[a-z0-9-]+$/.test(e?.message)?e.message:'lhcb-runner-operation-failed';if(this.journal){this.journal.failure={code,at:this.timestamp()};this.save('FAILED');}throw new Error(code);}
    finally{try{await this.transport.close?.();}catch(e){if(this.journal){this.journal.cleanup={code:/^lhcb-[a-z0-9-]+$/.test(e?.message)?e.message:'lhcb-runner-runtime-cleanup-failed',at:this.timestamp()};this.save();}}finally{S.fs.unlinkSync(lock);}}
  }
}
module.exports={AutoRunner,authority,PHASES,exactPrompt,validateCredentials,assertPreflight,evidence,checkpointBand,workspace,identity};
