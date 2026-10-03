'use strict';
// Offline contract validator only. Matching metadata is necessary, not proof
// that a snapshot was naturally reached or physically restored.
const {S}=require('./infrastructure.cjs');
function compare(runs){
 const reasons=[];if(!Array.isArray(runs)||runs.length!==3)return {pass:false,reasons:['three-arms-required']};
 const byArm=Object.fromEntries(runs.map(r=>[r.arm,r]));
 const prompt=S.hash(S.fs.readFileSync(S.path.join(S.BENCH,'prompts/T99-engineering.md')));
 const fields=['snapshotSeal','workspaceHash','durableStateHash','sessionLogHash','sessionId','taskId','taskInstanceId','provider','model','productionSourceHash','graderHash','contractHash'];
 const baseline=byArm.native;
 for(const arm of ['native','production','forced']){
  const r=byArm[arm];if(!r){reasons.push('missing-'+arm);continue;}
  if(r.promptHash!==prompt||r.contractHash!==S.contractHash()||r.provider!==S.manifest.provider||r.model!==S.manifest.model)reasons.push(arm+':authority-mismatch');
  for(const field of fields)if(typeof r[field]!=='string'||!r[field]||r[field]!==baseline?.[field])reasons.push(arm+':'+field+'-mismatch');
  if(r.policy?.contextCompiler?.mode!==S.manifest.arms[arm].mode||r.policy?.contextCompiler?.activation!==S.manifest.arms[arm].activation)reasons.push(arm+':policy-mismatch');
  const normalized=p=>{const compiler={...p?.contextCompiler};delete compiler.mode;delete compiler.activation;return {...p,contextCompiler:compiler};};
  if(S.json(normalized(r.policy))!==S.json(normalized(baseline?.policy)))reasons.push(arm+':unintended-policy-difference');
 }
 return {pass:reasons.length===0,reasons};
}
module.exports={compare};
