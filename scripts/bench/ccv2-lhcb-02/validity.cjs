'use strict';
const {definition,S,authority}=require('./infrastructure.cjs');
const Provider=require('./provider-accounting.cjs');
const finite=x=>Number.isSafeInteger(x)&&x>=0;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function calibration(phases,requests){
  const reasons=[];const ids=definition.calibration.phases;
  if(!Array.isArray(phases)||!Array.isArray(requests)||phases.some(p=>!p||typeof p!=='object')||requests.some(r=>!r||typeof r!=='object'))return {status:'FAIL',reasons:['evidence-malformed']};
  if(phases.some(p=>p.measurementOrigin==='SIMULATED')||requests.some(r=>r.measurementOrigin==='SIMULATED'||r.authoritativeForCalibration===false))reasons.push('simulated-evidence');
  if(phases.length!==ids.length||phases.some((p,i)=>p.phase!==ids[i]))reasons.push('representative-phase-set-incomplete');
  const terminal=new Set(),evidence=new Set(),sets=new Set();
  if(!Array.isArray(phases)||!Array.isArray(requests))return {status:'FAIL',reasons:['evidence-malformed']};
  for(const p of phases){
    if(!finite(p.pressureGrowth)||p.pressureGrowth<10000)reasons.push(p.phase+':growth-below-10000');
    if(p.acceptance!==true)reasons.push(p.phase+':acceptance-not-passed');
    if(!digest(p.terminalContentHash)||terminal.has(p.terminalContentHash))reasons.push(p.phase+':duplicate-or-missing-terminal-hash');
    terminal.add(p.terminalContentHash);
    if(!digest(p.evidenceSetHash)||sets.has(p.evidenceSetHash))reasons.push(p.phase+':duplicate-or-missing-evidence-set');sets.add(p.evidenceSetHash);
    if(!finite(p.toolCalls)||p.toolCalls<2||!Array.isArray(p.newToolEvidenceHashes)||!p.newToolEvidenceHashes.some(h=>digest(h)&&!evidence.has(h)))reasons.push(p.phase+':fresh-tool-evidence-missing');
    for(const h of Array.isArray(p.newToolEvidenceHashes)?p.newToolEvidenceHashes:[])evidence.add(h);
    if(p.compactionEvents!==0||p.historyReplacements!==0)reasons.push(p.phase+':history-reduced');
    const rows=requests.filter(r=>r.phase===p.phase&&r.requestOutcome==='OBSERVED');
    if(!rows.length)reasons.push(p.phase+':requests-missing');
    else if(p.pressureGrowth!==rows.at(-1).pressureAfter-rows[0].pressureBefore||p.pressureBefore!==rows[0].pressureBefore||p.pressureAfter!==rows.at(-1).pressureAfter)reasons.push(p.phase+':pressure-authority-mismatch');
  }
  let last=null,lastSeq=-1,identity=null;const requestIds=new Set();
  for(const r of requests){
    if(!S.manifest.stages.includes(r.phase)||r.promptHash!==authority.promptHashes[r.phase]||!digest(r.requestIdentity)||requestIds.has(r.requestIdentity)||!Array.isArray(r.durableSequenceRange)||r.durableSequenceRange.length!==2||!r.durableSequenceRange.every(finite)||r.durableSequenceRange[0]<=lastSeq||r.durableSequenceRange[1]<r.durableSequenceRange[0])reasons.push('request-identity-or-sequence-invalid');
    lastSeq=r.durableSequenceRange?.[1]??lastSeq;requestIds.add(r.requestIdentity);
    const current=JSON.stringify([r.sessionId,r.taskId,r.taskInstanceId]);if(identity&&identity!==current)reasons.push('mixed-request-histories');identity=current;
    const recovered=Provider.recovered(r,requests);
    if(r.requestOutcome!=='OBSERVED'&&!recovered)reasons.push('failed-or-unobserved-request');
    if(r.provider!==S.manifest.provider||r.model!==S.manifest.model)reasons.push('provider-model-identity-mismatch');
    for(const key of [...(recovered?[]:['uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']),'historicalToolCallCount','historicalToolResultCount'])if(!finite(r[key]))reasons.push('required-metric-unavailable');
    if(finite(r.providerInputTokens)&&r.providerInputTokens!==r.uncachedInputTokens+r.cacheReadTokens+r.cacheWriteTokens)reasons.push('provider-input-accounting-mismatch');
    if(r.pressureDelta!==(r.pressureBefore===null||r.pressureAfter===null?null:r.pressureAfter-r.pressureBefore))reasons.push('pressure-delta-mismatch');
    if(!recovered){
      if(!finite(r.providerInputTokens))reasons.push('provider-input-unobservable');
      else if(last!==null&&r.providerInputTokens<last)reasons.push('provider-input-not-monotonic');
      last=r.providerInputTokens;
    }
    if(r.historyCompactionCount!==0||r.historyReplacementCount!==0)reasons.push('history-integrity-not-proven');
    if(r.mode!=='NATIVE'||r.compilerExecutionCount!==0)reasons.push('native-mode-violated');
    if(!digest(r.requestHash)||!finite(r.canonicalRequestByteCount)||!finite(r.messageCount)||!finite(r.reconstructedWireItemCount)||(r.phase!=='T00'&&!finite(r.pressureBefore))||!finite(r.pressureAfter))reasons.push('request-observation-incomplete');
  }
  const average=phases.length?phases.reduce((sum,p)=>sum+p.pressureGrowth,0)/phases.length:null;
  if(!Number.isFinite(average)||average<10000)reasons.push('average-growth-below-10000');
  const growth=phases.map(p=>p.pressureGrowth).filter(finite).sort((a,b)=>a-b),median=growth.length?((growth[Math.floor((growth.length-1)/2)]+growth[Math.floor(growth.length/2)])/2):null;
  const total=growth.reduce((a,b)=>a+b,0);if(total&&Math.max(...growth)/total>0.4)reasons.push('single-phase-dominates-pressure');
  const providerAccounting=Provider.accounting(requests),accepted=requests.filter(r=>r.requestOutcome==='OBSERVED');
  return {status:reasons.length?'FAIL':'PASS',averagePressureGrowth:average,medianPressureGrowth:median,minimumPressureGrowth:growth[0]??null,targetPhaseGrowth:[15000,25000],reasons:[...new Set(reasons)],diagnostics:providerAccounting.failedAttempts.some(r=>r.recovered&&r.providerInputTokens===null)?['provider-failed-attempt-usage-unavailable']:[],providerAccounting,scientificPressure:{complete:accepted.length>0&&accepted.every(r=>finite(r.providerInputTokens)&&finite(r.pressureAfter)&&(r.phase==='T00'||finite(r.pressureBefore)))&&phases.every(p=>finite(p.pressureBefore)&&finite(p.pressureAfter)),totalAcceptedProviderInputTokens:providerAccounting.successfulAcceptedProviderInputTokens,phaseGrowth:phases.map(p=>({phase:p.phase,pressureBefore:p.pressureBefore,pressureAfter:p.pressureAfter,pressureGrowth:p.pressureGrowth}))}};
}
function workload(evidence){
  // This delivery has no verified progressive runtime snapshot/restore or live pressure.
  // A boolean certificate or caller-supplied pressure must never enable scoring.
  const reasons=['official-implementation-disabled','natural-CP-500-not-proven','arm-fairness-not-proven','hidden-grader-isolation-not-proven'];
  return {verdict:'WORKLOAD_INADEQUATE',outcome:'INSUFFICIENT_DATA',ccv2BenefitVerdict:'NOT_MEASURED',officialBenefitEligible:false,reasons};
}
function benefit(evidence,arms){return workload(evidence);}
module.exports={calibration,workload,benefit};
