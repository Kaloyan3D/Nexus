'use strict';
const S=require('./state.cjs');
function qualityMeasured(r){return typeof r?.taskSuccess==='boolean'&&typeof r.finalTestsPass==='boolean'&&Number.isInteger(r.obligationsPassed)&&Number.isInteger(r.criticalObligationsPassed);}
function matchedNative(runs,r){const found=runs.filter(a=>comparable(a,r));return found.length===1?found[0]:null;}
function correctness(r) {
  return r.runStatus==='VALID'&&r.taskSuccess===true&&r.finalTestsPass===true&&r.criticalObligationsTotal===10&&r.criticalObligationsPassed===r.criticalObligationsTotal&&r.obligationsTotal===20&&r.obligationsPassed/20>=S.manifest.acceptance.obligationRatio&&r.toolProtocolViolations===0;
}
function comparable(a,b) {
  return a&&b&&a.runStatus==='VALID'&&b.runStatus==='VALID'&&a.arm==='native'&&a.contractHash===b.contractHash&&a.checkpoint===b.checkpoint&&a.baseSha===b.baseSha&&a.fixtureRevision===b.fixtureRevision&&a.provider===b.provider&&a.model===b.model&&a.snapshotSeal===b.snapshotSeal&&a.settingsIdentityHash===b.settingsIdentityHash;
}
function benefit(a,b) {
  if(!comparable(a,b)||!qualityMeasured(a)||!qualityMeasured(b)||!Number.isFinite(a.providerInputTokensTotal)||a.providerInputTokensTotal<=0||!Number.isFinite(b.providerInputTokensTotal)||!Number.isFinite(a.steps)||a.steps<=0||!Number.isFinite(b.steps))return {available:false,inputReduction:null,stepIncrease:null,meaningful:null,headline:null,reason:'Missing unambiguous valid matched comparator, grading or accounting'};
  const inputReduction=1-b.providerInputTokensTotal/a.providerInputTokensTotal, stepIncrease=b.steps/a.steps-1,gate=correctness(a)&&correctness(b);
  return {available:true,inputReduction,stepIncrease,meaningful:gate&&inputReduction+1e-12>=.30&&stepIncrease<=.25+1e-12,headline:gate&&inputReduction+1e-12>=.50,reason:null};
}
function verdicts(runs) {
  const valid=runs.filter(r=>r.runStatus==='VALID');const natives=valid.filter(r=>r.arm==='native');
  function comparisons(arm){return valid.filter(r=>r.arm===arm).map(r=>({r,b:benefit(matchedNative(natives,r),r)}));}
  const forced=comparisons('forced'),production=comparisons('production');
  const cap=forced.filter(x=>x.r.compiledRequests>0&&x.b.available);
  const prod=production.filter(x=>x.r.compiledRequests>0&&x.b.available);
  const safety=production.filter(x=>x.r.requests>0&&qualityMeasured(x.r)&&x.r.pressurePolicyMatches!==null);
  return {
    compilerCapability:cap.length?cap.every(x=>x.b.meaningful)?'PASS':'FAIL':'INSUFFICIENT_DATA',
    productionBenefit:prod.length?prod.every(x=>x.b.meaningful)?'PASS':'FAIL':production.length&&production.every(x=>x.r.compiledRequests===0&&x.r.requests>0&&x.r.pressurePolicyMatches===true)?'NOT_TRIGGERED':'INSUFFICIENT_DATA',
    reasoningContinuitySafety:runs.some(r=>r.arm==='production'&&r.runStatus==='INVALID'&&r.invalidReason==='production-policy-mismatch')?'FAIL':safety.length?safety.every(x=>x.r.pressurePolicyMatches===true&&correctness(x.r))?'PASS':'FAIL':'INSUFFICIENT_DATA'
  };
}
module.exports={qualityMeasured,matchedNative,correctness,comparable,benefit,verdicts};
