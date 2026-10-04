'use strict';
// This driver has no live transport dependency. Synthetic pressure never crosses
// into the official checkpoint API or the calibration validity authority.
const {S,load}=require('./infrastructure.cjs'),Fake=require('./fake-transport.cjs');
const C=require('./candidate.cjs'),F=require('../../../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs');
const T=require('./telemetry.cjs'),Session=load('session'),cp=require('node:child_process');
const stageIds=C.phases().slice(0,-1),arms=['native','production','forced'];
const same=(a,b)=>S.json(a)===S.json(b);
function durable(file,value){S.write(file,value);const fd=S.fs.openSync(file,'r');try{S.fs.fsyncSync(fd);}finally{S.fs.closeSync(fd);}const dir=S.fs.openSync(S.path.dirname(file),'r');try{S.fs.fsyncSync(dir);}finally{S.fs.closeSync(dir);}}
function fixtureCommit(dir){
 if(!S.fs.existsSync(S.path.join(dir,'.git')))S.git(dir,['init','-q']);
 S.git(dir,['add','--all']);const tree=S.git(dir,['write-tree']);
 const commit=cp.execFileSync('git',['commit-tree',tree,'-m','LHCB-02 deterministic initial fixture'],{cwd:dir,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}}).trim();
 S.git(dir,['update-ref','HEAD',commit]);return {commit,tree};
}
function stageCodec(root){
 // Read-only local installed code dependency. No provider, credential module,
 // runtime launcher, package manager or bootstrap process is invoked.
 const app=S.inside(root,'nexus-root/app');S.fs.mkdirSync(app,{recursive:true});for(const file of ['package.json','package-lock.json'])S.fs.copyFileSync(S.inside(root,'nexus-root/runtime/'+file),S.path.join(app,file));
 const target=S.path.join(app,'node_modules');if(!S.fs.existsSync(target))S.fs.symlinkSync(S.path.join(S.os.homedir(),'.local/share/nexus/app/node_modules'),target);
}
function selected(root){const out={};for(const dir of ['workspace','state','nexus-root/data/sessions','nexus-root/data/routing','nexus-root/data/logs'])for(const [p,v] of Object.entries(S.inventory(S.inside(root,dir)))){if(dir==='workspace'&&p.startsWith('.git/'))continue;out[dir+'/'+p]=v;}return out;}
function sourceAuthority(root){
 // This hashes immutable installed CODE, including fixtures with literal secret
 // examples. No code bytes enter the snapshot/report. Mutable-state inventory
 // retains its secret-content checks unchanged.
 const files={};function walk(dir,prefix){S.noLinks(dir);for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const file=S.path.join(dir,e.name),p=prefix+e.name;if(e.isDirectory())walk(file,p+'/');else if(e.isFile())files[p]={hash:S.hash(S.fs.readFileSync(file)),mode:S.fs.statSync(file).mode&0o777};else S.fail('lhcb02-source-unsupported-file');}}
 for(const dir of ['config','scripts','bin','runtime','ui','skills','docs'])walk(S.inside(root,'nexus-root/'+dir),dir+'/');delete files['config/routing-policy.json'];files['data/settings.yaml']={hash:S.hash(S.fs.readFileSync(S.inside(root,'nexus-root/data/settings.yaml')))};return S.hash(S.json(files));}
function policyAuthority(root){const policy=S.read(S.inside(root,'nexus-root/config/routing-policy.json'));policy.contextCompiler={...policy.contextCompiler,mode:null,activation:null};return S.hash(S.json(policy));}
function authority(root){const files=selected(root);const binding=S.read(S.inside(root,'state/binding.json')),memory=S.read(S.inside(root,'workspace/.ai-harness/ccv2/'+binding.taskId+'/producer/state.json'));
 return {productionSourceHash:sourceAuthority(root),policyAuthorityHash:policyAuthority(root),workspaceTree:S.treeHash(Object.fromEntries(Object.entries(files).filter(([p])=>p.startsWith('workspace/')))),fixture:S.read(S.inside(root,'state/fixture-git.json')),sessionTask:binding,durableTaskHash:S.hash(S.json(memory)),obligationHash:S.hash(S.fs.readFileSync(S.path.join(S.BENCH,'obligations.json'))),t99Hash:Fake.prompt('T99').hash,checkpointAuthorityHash:S.hash(S.json(files)),contractHash:S.contractHash(),provider:S.manifest.provider,model:S.manifest.model};}
function validateReport(r){for(const k of ['compilerCapability','productionBenefit','reasoningContinuitySafety'])if(!['PASS','FAIL','NOT_MEASURED'].includes(r[k]))S.fail('lhcb02-report-verdict');if(!['VALID','INADEQUATE'].includes(r.workloadValidity)||Object.keys(r).some(k=>/combined|overallScore/i.test(k)))S.fail('lhcb02-report-verdict');if(r.measurementOrigin==='SIMULATED'&&(['compilerCapability','productionBenefit','reasoningContinuitySafety'].some(k=>r[k]!=='NOT_MEASURED')||r.workloadValidity!=='INADEQUATE'||r.officialBenefitEligible!==false))S.fail('lhcb02-simulation-promoted');return true;}
class Rehearsal {
 constructor(raw,options={}){Fake.guard();this.root=S.rootOf(raw);this.options=options;this.journalFile=S.inside(this.root,'rehearsal/journal.json');this.transport=null;}
 fault(point,stage){this.options.fault?.(point,stage);}
 save(){durable(this.journalFile,this.journal);}
 initialize(){const root=this.root;
  if(!S.fs.existsSync(S.inside(root,'state/identity.json')))require('./prepare.cjs').prepare(root);
  S.owned(root);stageCodec(root);
  const marker=S.inside(root,'state/simulation.json');if(!S.fs.existsSync(marker)){if(S.fs.existsSync(this.journalFile))S.fail('lhcb02-simulation-marker-missing');durable(marker,{measurementOrigin:'SIMULATED',officialBenefitEligible:false});}
  if(!same(S.read(marker),{measurementOrigin:'SIMULATED',officialBenefitEligible:false}))S.fail('lhcb02-simulation-marker-invalid');
  const gitFile=S.inside(root,'state/fixture-git.json');if(!S.fs.existsSync(gitFile)){if(S.fs.existsSync(this.journalFile))S.fail('lhcb02-fixture-authority-missing');durable(gitFile,fixtureCommit(S.inside(root,'workspace')));}
  this.transport=Fake.create(root);this.transport.initialize();
  this.journal=S.fs.existsSync(this.journalFile)?S.read(this.journalFile):{version:1,root,contractHash:S.contractHash(),stages:[],arms:[],checkpoint:null};
  const j=this.journal;if(j.version!==1||j.root!==root||j.contractHash!==S.contractHash()||!Array.isArray(j.stages)||!Array.isArray(j.arms)||j.stages.length>stageIds.length||j.arms.length>3)S.fail('lhcb02-rehearsal-journal');
  for(const [i,r] of j.stages.entries())if(r.id!==stageIds[i]||r.rpcId!=='rehearsal-'+r.id||!['INTENT','COMPLETE'].includes(r.state)||r.promptHash!==Fake.prompt(r.id).hash||!r.before||i<j.stages.length-1&&r.state!=='COMPLETE')S.fail('lhcb02-rehearsal-journal');
  for(const [i,a] of j.arms.entries())if(a.arm!==arms[i]||!['RESTORING','RESTORED','T99','COLLECTED','GRADED'].includes(a.state)||i<j.arms.length-1&&a.state!=='GRADED')S.fail('lhcb02-rehearsal-journal');
  const fixture=S.read(gitFile);if(S.git(S.inside(root,'workspace'),['rev-parse','HEAD'])!==fixture.commit||S.git(S.inside(root,'workspace'),['rev-parse','HEAD^{tree}'])!==fixture.tree)S.fail('lhcb02-fixture-git-drift');
  S.validateManifest(S.manifest);if(!load('doctor').sourceGuard().pass)S.fail('production-drift');this.save();
 }
 stage(id,records){let r=records.find(r=>r.id===id);
  if(!r){this.fault('before-intent',id);if(id!=='T00')F.release(S.inside(this.root,'workspace'),id);r={id,promptHash:Fake.prompt(id).hash,rpcId:records===this.journal.stages?'rehearsal-'+id:'rehearsal-'+this.journal.arms.at(-1).arm+'-'+id,before:S.inventory(S.inside(this.root,'workspace')),state:'INTENT'};records.push(r);this.save();this.fault('after-intent',id);}
  if(r.state==='COMPLETE'){this.transport.evidence(r.receipt);if(!r.acceptance?.pass)S.fail('lhcb02-stage-acceptance');return r;}
  let receipt=this.transport.receipt(r.rpcId);if(!receipt)receipt=this.transport.submit(id,r.rpcId);this.transport.evidence(receipt);this.fault('after-rpc-provenance',id);this.fault('before-flush',id);receipt=this.transport.flush(r.rpcId);this.fault('after-flush',id);
  const b=S.read(S.inside(this.root,'state/binding.json')),memory=S.read(S.inside(this.root,'workspace/.ai-harness/ccv2/'+b.taskId+'/producer/state.json'));
  if(memory.processedThroughSeq!==receipt.endSeq||memory.openTurn!==null||memory.blocker!==null||!same(memory.namespace,{workspaceId:S.inside(this.root,'workspace'),sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId}))S.fail('lhcb02-fake-flush-authority');
  r.acceptance=C.phaseAcceptance({dir:S.inside(this.root,'workspace'),id,events:this.transport.events().slice(receipt.startSeq,receipt.endSeq+1),before:r.before});if(!r.acceptance.pass)S.fail('lhcb02-stage-acceptance');r.receipt=receipt;r.state='COMPLETE';this.save();return r;
 }
 telemetry(){const b={...S.read(S.inside(this.root,'state/binding.json')),events:this.transport.events()},requests=this.journal.stages.flatMap(r=>T.collectRequests(this.root,b,{...r.receipt,promptId:r.id,promptHash:r.promptHash})).map(r=>({...r,measurementOrigin:'SIMULATED',authoritativeForCalibration:false})),phases=this.journal.stages.filter(r=>S.manifest.calibration.phases.includes(r.id)).map(r=>({...T.phaseSummary(b,{...r.receipt,promptId:r.id,promptHash:r.promptHash,acceptance:r.acceptance},requests.filter(x=>x.phase===r.id)),measurementOrigin:'SIMULATED'}));const report={measurementOrigin:'SIMULATED',calibrationVerdict:'NOT_MEASURED',authoritativeForCalibration:false,requests,phases};durable(S.inside(this.root,'rehearsal/calibration-telemetry.json'),report);return report;}
 snapshot(){const target=S.inside(this.root,'rehearsal/checkpoint.json');
  if(S.fs.existsSync(target)){const snapshot=this.readSnapshot();if(this.journal.checkpoint&&!same(this.journal.checkpoint,snapshot.authority))S.fail('lhcb02-checkpoint-journal-drift');this.journal.checkpoint=snapshot.authority;this.save();return snapshot;}
  const last=this.journal.stages.at(-1);if(last?.id!==stageIds.at(-1)||last.state!=='COMPLETE'||!this.transport.receipt(last.rpcId)?.flushed)S.fail('lhcb02-checkpoint-before-flush');
  const files=selected(this.root),entries=Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([path,v])=>({path,...v,bytes:S.fs.readFileSync(S.inside(this.root,path)).toString('base64')}));
  const telemetry=this.telemetry(),simulatedPressure=telemetry.requests.at(-1).pressureAfter;if(simulatedPressure<480000||simulatedPressure>550000)S.fail('lhcb02-simulated-checkpoint-range');
  const body={kind:'SIMULATED_CP_500',measurementOrigin:'SIMULATED',naturalPressure:false,officialBenefitEligible:false,simulatedPressure,authority:authority(this.root),entries};const snapshot={...body,seal:S.hash(S.json(body))};
  if(S.fs.existsSync(S.inside(this.root,'rehearsal/checkpoint-building.json'))){const staged=this.readSnapshot('rehearsal/checkpoint-building.json');if(!same(staged.authority,snapshot.authority)||staged.seal!==snapshot.seal)S.fail('lhcb02-checkpoint-staging-drift');}else durable(S.inside(this.root,'rehearsal/checkpoint-building.json'),snapshot);this.fault('checkpoint-creation','CP-500');S.fs.renameSync(S.inside(this.root,'rehearsal/checkpoint-building.json'),target);this.fault('checkpoint-completed','CP-500');this.journal.checkpoint=snapshot.authority;this.save();return this.readSnapshot();
 }
 readSnapshot(relative='rehearsal/checkpoint.json'){const snapshot=S.read(S.inside(this.root,relative)),{seal,...body}=snapshot;if(seal!==S.hash(S.json(body))||body.kind!=='SIMULATED_CP_500'||body.measurementOrigin!=='SIMULATED'||body.officialBenefitEligible!==false||!Array.isArray(body.entries)||body.authority.contractHash!==S.contractHash())S.fail('lhcb02-snapshot-seal');const paths=new Set();for(const e of body.entries){S.inside(this.root,e.path);if(paths.has(e.path)||!['workspace/','state/','nexus-root/data/sessions/','nexus-root/data/routing/','nexus-root/data/logs/'].some(p=>e.path.startsWith(p))||e.path.startsWith('workspace/.git/')||S.hash(Buffer.from(e.bytes,'base64'))!==e.hash)S.fail('lhcb02-snapshot-entry');paths.add(e.path);}return snapshot;}
 restore(a,snapshot){
  const marker=S.inside(this.root,'rehearsal/restoring.json');durable(marker,{arm:a.arm,seal:snapshot.seal});
  // Restarting this operation always reconstructs the entire sealed set. A
  // partial restore cannot advance to T99, and .git remains fixed throughout.
  for(const p of ['workspace','state','nexus-root/data/sessions','nexus-root/data/routing','nexus-root/data/logs'])for(const e of S.fs.readdirSync(S.inside(this.root,p))){if(p==='workspace'&&e==='.git')continue;S.fs.rmSync(S.inside(this.root,p+'/'+e),{recursive:true,force:true});}
  let n=0;for(const e of snapshot.entries){const file=S.inside(this.root,e.path);S.fs.mkdirSync(S.path.dirname(file),{recursive:true});S.fs.writeFileSync(file,Buffer.from(e.bytes,'base64'),{mode:e.mode});if(++n===3)this.fault('during-restore',a.arm);}
  if(!same(authority(this.root),snapshot.authority))S.fail('lhcb02-restore-authority');a.origin=authority(this.root);a.checkpointSeal=snapshot.seal;a.state='RESTORED';this.save();S.fs.unlinkSync(marker);
  const policy=S.inside(this.root,'nexus-root/config/routing-policy.json');S.write(policy,load('arms').configure(S.read(policy),a.arm));if(!same(authority(this.root),snapshot.authority)||!same(S.read(policy).contextCompiler,S.manifest.arms[a.arm]))S.fail('lhcb02-arm-policy-drift');this.fault('after-restore',a.arm);
 }
 collect(a){const r=a.stages[0],b={...S.read(S.inside(this.root,'state/binding.json')),events:this.transport.events()},record={...r.receipt,promptId:r.id};const requests=T.collectRequests(this.root,b,record).map(row=>({...row,measurementOrigin:'SIMULATED',authoritativeForCalibration:false}));
  const result={arm:a.arm,measurementOrigin:'SIMULATED',officialBenefitEligible:false,origin:a.origin,checkpointSeal:a.checkpointSeal,promptHash:r.promptHash,rpcId:r.rpcId,requests,resultSourceHash:Fake.sourceHash(this.root),durableResultHash:S.hash(S.json(b.events))};durable(S.inside(this.root,'rehearsal/'+a.arm+'/collection.json'),result);a.collectionHash=S.hash(S.json(result));a.state='COLLECTED';this.save();this.fault('after-collection',a.arm);
 }
 run(){const release=require('./lease.cjs').acquire(this.root+'.rehearsal-lock.json',this.root);try{return this.execute();}finally{release();}}
 execute(){
  const restoring=S.inside(this.root,'rehearsal/restoring.json');
  if(S.fs.existsSync(restoring)){this.journal=S.read(this.journalFile);if(this.journal.root!==this.root||this.journal.contractHash!==S.contractHash()||!Array.isArray(this.journal.arms))S.fail('lhcb02-rehearsal-journal');const snapshot=this.readSnapshot(),marker=S.read(restoring),a=this.journal.arms.at(-1);if(!a||marker.arm!==a.arm||marker.seal!==snapshot.seal||!['RESTORING','RESTORED'].includes(a.state)||a.stages?.length)S.fail('lhcb02-restore-marker');this.restore(a,snapshot);}
  this.initialize();
  // During restore state/identity may be absent: recover using only the sealed
  // checkpoint plus the journal outside the restored authority paths.
  for(const id of stageIds)if(!this.journal.checkpoint)this.stage(id,this.journal.stages);
  const snapshot=this.snapshot();
  for(const arm of arms){let a=this.journal.arms.find(a=>a.arm===arm);if(!a){a={arm,state:'RESTORING',stages:[]};this.journal.arms.push(a);this.save();}
   if(a.state==='RESTORING'||S.fs.existsSync(S.inside(this.root,'rehearsal/restoring.json')))this.restore(a,snapshot);
   if(a.state==='RESTORED'){this.stage('T99',a.stages);a.state='T99';this.save();this.fault('after-t99',arm);}
   if(a.state==='T99')this.collect(a);
   if(a.state==='COLLECTED'){const collection=S.read(S.inside(this.root,'rehearsal/'+arm+'/collection.json'));if(S.hash(S.json(collection))!==a.collectionHash||collection.resultSourceHash!==Fake.sourceHash(this.root)||collection.durableResultHash!==S.hash(S.json(this.transport.events())))S.fail('lhcb02-collection-drift');a.grade=require('../../../benchmarks/ccv2-lhcb-02/grader/final.cjs').grade(S.inside(this.root,'workspace'));if(!a.grade.pass)S.fail('lhcb02-arm-grade');durable(S.inside(this.root,'rehearsal/'+arm+'/grade.json'),a.grade);a.state='GRADED';this.save();}
  }
  if(this.journal.arms.some(a=>!same(a.origin,snapshot.authority)||a.stages.length!==1||a.stages[0].promptHash!==Fake.prompt('T99').hash||a.checkpointSeal!==snapshot.seal))S.fail('lhcb02-arm-equivalence');
  const submissions=S.read(S.inside(this.root,'rehearsal/submissions.json')),values=Object.values(submissions);if(values.length!==stageIds.length+3||values.filter(r=>r.id==='T99').length!==3||stageIds.some(id=>values.filter(r=>r.id===id).length!==1))S.fail('lhcb02-submission-count');
  for(const a of this.journal.arms){const collection=S.read(S.inside(this.root,'rehearsal/'+a.arm+'/collection.json')),grade=S.read(S.inside(this.root,'rehearsal/'+a.arm+'/grade.json'));if(S.hash(S.json(collection))!==a.collectionHash||!same(grade,a.grade))S.fail('lhcb02-result-drift');}
  const lastCollection=S.read(S.inside(this.root,'rehearsal/'+arms.at(-1)+'/collection.json'));if(lastCollection.resultSourceHash!==Fake.sourceHash(this.root)||lastCollection.durableResultHash!==S.hash(S.json(this.transport.events())))S.fail('lhcb02-completed-workspace-drift');
  const report={kind:'OFFLINE_DRESS_REHEARSAL',measurementOrigin:'SIMULATED',offlineLifecycle:'PASS',compilerCapability:'NOT_MEASURED',productionBenefit:'NOT_MEASURED',reasoningContinuitySafety:'NOT_MEASURED',workloadValidity:'INADEQUATE',workloadReason:'Live pressure calibration required',officialBenefitEligible:false,providerCalls:0,stages:stageIds.length,t99Submissions:values.filter(r=>r.id==='T99').length,stageSubmissions:values.length,snapshotAuthority:snapshot.authority,checkpointSeal:snapshot.seal,armEquivalence:true,arms:this.journal.arms.map(a=>({arm:a.arm,origin:a.origin,checkpointSeal:a.checkpointSeal,promptHash:a.stages[0].promptHash,collectionHash:a.collectionHash,gradePass:a.grade.pass}))};validateReport(report);durable(S.inside(this.root,'reports/offline-rehearsal.json'),report);return report;
 }
}
module.exports={Rehearsal,fixtureCommit,authority,validateReport,stageCodec};
