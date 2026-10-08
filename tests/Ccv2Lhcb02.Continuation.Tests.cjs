'use strict';
require('../benchmarks/ccv2-lhcb-01/grader/offline.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {S}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs'),C=require('../scripts/bench/ccv2-lhcb-02/candidate.cjs');
const F=require('../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs'),N=require('../benchmarks/ccv2-lhcb-02/fixture/continuation.cjs');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-continuation-'));
after(()=>{assert.equal(global.lhcbOfflineAudit.attempts(),0);S.fs.rmSync(tmp,{recursive:true,force:true});});
test('finite workload has eight substantive dependent continuation phases before unchanged T99',()=>{
 assert.deepEqual(C.phases().slice(-9),[...N.specs.map(s=>s[0]),'T99']);assert(C.validateGraph());
 assert.equal(S.manifest.workloadRevision,'projection-continuation-v1');
 assert.equal(S.manifest.officialCheckpoint,'CP-750');assert.equal(S.manifest.minimumContinuationPhases,4);
});
test('CP750 uses a fixed broad band and requires four engineering phases remaining',()=>{
 const P=require('../scripts/bench/ccv2-lhcb-02/checkpoint-policy.cjs'),prefix=C.phases().slice(0,C.phases().indexOf('E51'));
 assert.equal(P.remaining(prefix),4);
 for(const pressure of [720000,750000,790000])assert.equal(P.eligible(pressure,prefix),true);
 for(const pressure of [719999,790001,907018])assert.equal(P.eligible(pressure,prefix),false);
 assert.equal(P.eligible(750000,[...prefix,'E51']),false);
 assert.throws(()=>P.remaining([...prefix.slice(1)]),/checkpoint-phases/);
 assert.throws(()=>P.band('caller-selected-pressure'),/checkpoint-id/);
});
function reference(){
 const dir=S.path.join(tmp,'reference');C.reconstruct(dir);
 for(const id of C.phases().slice(1)){
  const name=F.modules[id];let code;
  if(N.specs.some(s=>s[0]===id))code=N.reference(name);
  else if(id==='T99')code=require('../benchmarks/ccv2-lhcb-02/fixture/final.cjs').reference();
  else if(id==='E46')code=require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs').reference();
  else if(S.manifest.calibration.phases.includes(id))code='const scales={USD:2,EUR:2,JPY:0,KWD:3};const oracle='+F.oracle.toString()+';module.exports={evaluate:x=>oracle('+JSON.stringify(id)+',x)};';
  else {const module=['extensions','workflows','late'].map(n=>require('../benchmarks/ccv2-lhcb-02/fixture/'+n+'.cjs')).find(m=>m.specs.some(s=>s[0]===id));code=module.reference(name);}
  S.fs.writeFileSync(S.path.join(dir,'src/'+name+'.ts'),code);for(const [p,text] of Object.entries(F.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(dir,p),text);
 }return dir;
}
test('independent public/hidden oracles and actual canonical-store consumers pass; drafts and broken dependencies fail',()=>{
 const dir=reference();
 for(const [id,name] of N.specs){
  const sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);
  for(const hidden of [false,true]){
   const rows=N.cases(id,hidden);assert(rows.some(r=>r.expected.status===200),id);assert(rows.some(r=>r.expected.status!==200),id);
   for(const r of rows){const result=sandbox.evaluate(name,r.input);assert.deepEqual(result.output,r.expected,r.caseId);assert.deepEqual(result.input,r.input,r.caseId);}
   for(const r of N.executions(id,hidden))assert.deepEqual(sandbox.run(N.scenarioCode(r.input)),r.expected,r.caseId);
  }
  const file=S.path.join(dir,'src/'+name+'.ts'),bytes=S.fs.readFileSync(file);S.fs.writeFileSync(file,N.phaseFiles(id)['src/'+name+'.ts']);
  const broken=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);assert(N.cases(id).some(r=>{try{return JSON.stringify(broken.evaluate(name,r.input).output)!==JSON.stringify(r.expected);}catch{return true;}}),id);
  S.fs.writeFileSync(file,bytes);
 }
 const grant=S.path.join(dir,'src/grants.ts'),bytes=S.fs.readFileSync(grant);S.fs.writeFileSync(grant,'module.exports={evaluate:()=>({allowed:true})};');
 const broken=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);for(const [id] of N.specs){const r=N.executions(id)[0];assert.notDeepEqual(broken.run(N.scenarioCode(r.input)),r.expected);}
 S.fs.writeFileSync(grant,bytes);
 const dependencies={'E47':'canonical-statements','E48':'settlement','E49':'reversal','E50':'balance-proof','E51':'scheduler','E52':'balance-proof','E53':'recovery-export','E54':'closing-evidence'};
 for(const [id,name] of N.specs){
  const row=N.cases(id).find(r=>r.expected.status===200),file=S.path.join(dir,'src/'+dependencies[id]+'.ts'),original=S.fs.readFileSync(file);
  S.fs.writeFileSync(file,'module.exports={evaluate:()=>({status:409,details:null})};');
  const sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);assert.notDeepEqual(sandbox.evaluate(name,row.input).output,row.expected,id+' must consume actual dependency');S.fs.writeFileSync(file,original);
  const result=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(dir,'tools/verify-continuation.cjs'),id],{encoding:'utf8'});assert.equal(result.status,0,id+':'+result.stdout+result.stderr);
 }
});
