'use strict';
const S=require('./state.cjs'),gate=require('../../../config/ContextActivationPressureV2.cjs');
const unavailable='Not deterministically observable in this durable evidence';
function failureKind(f) {
  const c=String(f?.code||'').toUpperCase(), n=f?.status;
  if(n===429||/RATE.?LIMIT/.test(c))return 'rate-limit';
  if(n===401||n===403||/AUTH|UNAUTHORIZED|FORBIDDEN/.test(c))return 'authentication';
  if(n===503||/OVERLOAD|CAPACITY/.test(c))return 'provider-overload';
  if(/TIMEOUT|TIMEDOUT/.test(c))return 'transport-timeout';
  if(/ECONN|CONNECTION|TRANSPORT|NETWORK|FETCH/.test(c))return 'connection-failure';
  return null;
}
function collectMetrics(events,decisions,arm,{telemetryComplete=false,replayRows=[],wallClockMs=null}={}) {
  const assistants=events.filter(e=>e.type==='assistant/message'), calls=events.filter(e=>e.type==='tool/call'), usage=assistants.map(e=>e.data.usage);
  const known=usage.length>0&&usage.every(u=>gate.sampleTokensOfV2(u)!==null);
  const sum=k=>known?usage.reduce((a,u)=>a+(u[k]||0),0):null;
  const optional=k=>known&&usage.every(u=>Number.isInteger(u[k]))?sum(k):null;
  const seen=new Set();let repeated=0,violations=0;const pending=new Set(),allCallIds=new Set();
  for(const e of events){
    if(e.type==='tool/call'){const key=S.hash(S.json([e.data.name,e.data.arguments]));if(seen.has(key))repeated++;seen.add(key);if(allCallIds.has(e.data.callId))violations++;allCallIds.add(e.data.callId);pending.add(e.data.callId);}
    if(e.type==='tool/result'){const blocks=e.data.message?.content||[];for(const block of blocks.filter(x=>x.type==='tool-result')){if(!pending.delete(block.toolCallId))violations++;}}
  }
  violations+=pending.size;
  const failures=[];for(const e of events){if(e.type==='llm/retry'){const kind=failureKind(e.data.failure);if(kind)failures.push(kind);}if(e.type==='turn/end'&&e.data.reason?.kind==='error'){const kind=failureKind(e.data.reason.error);if(kind)failures.push(kind);}}
  const complete=arm==='native'?telemetryComplete:telemetryComplete&&decisions.length===assistants.length;
  const compiled=complete?decisions.filter(d=>d.projectionMode==='CCV2_COMPILED').length:null;
  const activation=complete?decisions.findIndex(d=>d.activationDecision==='ACTIVATE'):-1;
  const m={requests:assistants.length,steps:events.filter(e=>e.type==='step/start').length,toolCalls:calls.length,exactRepeatedToolCalls:repeated,repeatedExactFileReads:null,wallClockMs,firstUsefulEditStep:null,requestsBeforeFirstUsefulEdit:null,
    providerInputTokensTotal:known?usage.reduce((a,u)=>a+gate.sampleTokensOfV2(u)-u.outputTokens,0):null,providerOutputTokensTotal:sum('outputTokens'),reasoningTokensTotal:optional('reasoningTokens'),cacheReadTokensTotal:sum('cacheReadTokens'),cacheWriteTokensTotal:sum('cacheWriteTokens'),peakProviderPromptTokens:known?Math.max(...usage.map(u=>gate.sampleTokensOfV2(u)-u.outputTokens)):null,
    nativeRequests:complete?assistants.length-(compiled||0):null,compiledRequests:compiled,compilerExecutions:complete?decisions.reduce((a,d)=>a+d.compilerExecutions,0):null,fallbacks:complete?decisions.filter(d=>d.fallbackReason!==null).length:null,
    activationBasis:complete&&decisions.length?decisions[0].activationBasis:null,activationThreshold:complete&&decisions.length?decisions[0].activationTokens:null,activationCount:complete?decisions.filter(d=>d.activationDecision==='ACTIVATE').length:null,firstActivationRequest:complete?(activation<0?null:activation+1):null,surfaceReplacementCount:events.filter(e=>['user/message','assistant/message','tool/result'].includes(e.type)&&e.surfaceOp&&e.surfaceOp!=='append').length,
    providerRetries:events.filter(e=>e.type==='llm/retry-started').length,retriesScheduled:events.filter(e=>e.type==='llm/retry').length,rateLimitFailures:failures.filter(x=>x==='rate-limit').length,transportFailures:failures.filter(x=>['transport-timeout','connection-failure'].includes(x)).length,infrastructureInvalid:failures.length>0,infrastructureReasons:[...new Set(failures)].sort(),toolProtocolViolations:violations,
    telemetryComplete:complete,pressurePolicyMatches:arm==='production'&&complete&&replayRows.length===decisions.length?decisions.every((d,i)=>(d.projectionMode!=='CCV2_COMPILED'||d.activationDecision==='ACTIVATE')&&d.activationDecision===replayRows[i].decision&&d.activationReason===replayRows[i].reason&&d.pressureTokens===replayRows[i].pressureTokens):null,
    availability:{}};
  for(const [k,v] of Object.entries(m))if(v===null)m.availability[k]={available:false,reason:unavailable};
  return m;
}
function validateArm(m,arm) {
  if(!m.telemetryComplete)return {status:'INVALID',reason:'decision-evidence-incomplete'};
  if(arm==='native'&&(m.compiledRequests!==0||m.compilerExecutions!==0))return {status:'INVALID',reason:'native-compiler-work'};
  if(arm==='forced'&&m.compiledRequests<1)return {status:'INVALID',reason:'forced-not-compiled'};
  if(arm==='production'&&m.pressurePolicyMatches!==true)return {status:'INVALID',reason:'production-policy-mismatch'};
  return {status:'VALID',reason:null};
}
module.exports={failureKind,collectMetrics,validateArm};
