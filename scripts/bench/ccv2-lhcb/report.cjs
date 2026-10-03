'use strict';
const S=require('./state.cjs'),Score=require('./score.cjs');
function buildReport(runs){
  runs=runs.slice().sort((a,b)=>a.checkpoint.localeCompare(b.checkpoint)||a.arm.localeCompare(b.arm)||a.runId.localeCompare(b.runId));
  for(const r of runs)S.validateSchema(r,'result');
  const comparisons=runs.filter(r=>r.arm!=='native').map(r=>({runId:r.runId,checkpoint:r.checkpoint,arm:r.arm,...Score.benefit(Score.matchedNative(runs,r),r)}));
  const report={benchmarkId:S.manifest.benchmarkId,benchmarkVersion:1,baseSha:S.manifest.baseSha,verdicts:Score.verdicts(runs),runs,comparisons};S.validateSchema(report,'report');return report;
}
function markdown(r){
  const val=v=>v===null||v===undefined?'UNAVAILABLE':String(v);
  const lines=['# CCV2-LHCB-01',`Frozen base: ${r.baseSha}`,`Compiler Capability: ${r.verdicts.compilerCapability}`,`Production Benefit: ${r.verdicts.productionBenefit}`,`Reasoning Continuity Safety: ${r.verdicts.reasoningContinuitySafety}`,'','| Run | Checkpoint | Arm | Status | Task | Obligations | Input | Reduction | Steps | Tools | Repeated | Output | Reasoning | Activations | Compiled | Fallbacks | Infra |','| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for(const x of r.runs){const c=r.comparisons.find(c=>c.runId===x.runId);const reduction=c?.available?(c.inputReduction*100).toFixed(2)+'%':'UNAVAILABLE';lines.push(`| ${x.runId} | ${x.checkpoint} | ${x.arm} | ${x.runStatus} | ${val(x.taskSuccess)} | ${val(x.obligationsPassed)}/20 (${val(x.criticalObligationsPassed)}/10 critical) | ${val(x.providerInputTokensTotal)} | ${reduction} | ${val(x.steps)} | ${val(x.toolCalls)} | ${val(x.exactRepeatedToolCalls)} | ${val(x.providerOutputTokensTotal)} | ${val(x.reasoningTokensTotal)} | ${val(x.activationCount)} | ${val(x.compiledRequests)} | ${val(x.fallbacks)} | ${x.infrastructureReasons.join(', ')||'none'} |`);}
  lines.push('','Rework Tax v1 uses only steps, tools, exact repeats, output and reasoning. Useful-edit timing and exact file-read repeats are unavailable unless structurally established. No weighted score. Invalid runs remain visible and are excluded from comparisons. Each null metric has an availability reason in JSON.','');return lines.join('\n');
}
function report(root){S.ready(root);const runs=[];for(const id of S.fs.readdirSync(S.inside(root,'runs')).sort()){const p=S.inside(root,'runs/'+id+'/result.json');if(S.fs.existsSync(p))runs.push(S.read(p));}
  const out=buildReport(runs);S.write(S.inside(root,'reports/CCV2-LHCB-01.json'),out);S.fs.writeFileSync(S.inside(root,'reports/CCV2-LHCB-01.md'),markdown(out),{mode:0o600});return out;
}
module.exports={buildReport,markdown,report};
