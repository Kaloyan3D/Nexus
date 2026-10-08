'use strict';
const fs=require('node:fs'),path=require('node:path'),fixture=require('../fixture/create-fixture.cjs');
const obligationSpec=require('../obligations.json');
function grade(dir){
 const ids=Object.keys(fixture.modules),rows=require('./grade.cjs').grade(dir,ids),byPhase=new Map(rows.map(r=>[r.phase,r])),probes=byPhase.get('holdout')?.probes||[],byProbe=new Map(probes.map(p=>[p.id,p]));
 const obligations=obligationSpec.obligations.map(o=>({id:o.id,critical:o.critical,pass:o.probeIds.length>0&&o.probeIds.every(id=>byProbe.get(id)?.pass===true)&&(o.introducedBy==='T00'||byPhase.get(o.introducedBy)?.pass===true)}));
 let violations=0;for(const [p,content] of Object.entries(fixture.baseFiles()))if(!p.startsWith('src/')){try{if(fs.readFileSync(path.join(dir,p),'utf8')!==content)violations++;}catch{violations++;}}
 for(const id of ids)for(const [p,content] of Object.entries(fixture.phaseFiles(id)))if(!p.startsWith('src/')){try{if(fs.readFileSync(path.join(dir,p),'utf8')!==content)violations++;}catch{violations++;}}
 // Reject altered evidence/tools even if public verifier output claims success.
 const tests=rows.length===ids.length+1&&rows.every(r=>r.pass===true)?'PASS':'FAIL';const critical=obligations.filter(o=>o.critical),passed=obligations.filter(o=>o.pass).length,criticalPassed=critical.filter(o=>o.pass).length;
 const task=byProbe.get('final-coordinator')?.pass===true&&byPhase.get('T99')?.pass===true?'SUCCESS':'FAIL';
 const pass=criticalPassed===critical.length&&passed/obligations.length>=0.95&&violations===0&&tests==='PASS'&&task==='SUCCESS';
 return {status:'UNFROZEN',calibration:'LIVE_CALIBRATION_REQUIRED',kind:'OFFLINE_CANDIDATE_CORRECTNESS',pass,tests,task,violations,obligationCount:obligations.length,obligationsPassed:passed,criticalCount:critical.length,criticalPassed,totalRatio:passed/obligations.length,criticalRatio:criticalPassed/critical.length,obligations,phases:rows.map(r=>({phase:r.phase,pass:r.pass,cases:r.cases??null})),officialBenefitEligible:false,ccv2BenefitVerdict:'NOT_MEASURED',caseDiagnostics:require('./diagnostics.cjs').integrated(dir),completeGraderOutput:rows};
}
if(require.main===module)process.stdout.write(JSON.stringify(grade(path.resolve(process.argv[2])))+'\n');
module.exports={grade};
