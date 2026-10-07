'use strict';
// Read-only admission/accounting. Never invokes an adapter or controls retries.
const {S}=require('./infrastructure.cjs');
const finite=x=>Number.isSafeInteger(x)&&x>=0;
function policyKey(p){return JSON.stringify(p.mode==='always'?[p.mode,p.initialDelayMs,p.maxDelayMs,p.jitterRatio]:[p.mode,p.maxRetries,[...p.retryableCodes].sort(),p.initialDelayMs,p.maxDelayMs,p.jitterRatio]);}
function sameBinding(a,b){return !!a&&!!b&&['sessionId','benchmarkPhase','benchmarkRpcId','turn','step','provider','model'].every(k=>a[k]!=null&&a[k]===b[k]);}
function recovered(r,requests){
 try{
  const f=r.failureEvidence,s=f.scheduled,t=f.started,p=f.retryPolicy,a=f.rawInvocation,e=f.rawFailure,z=f.rawEnd,n=f.replacementRawEnd;
  const replacement=requests.find(x=>x.requestIdentity===f.replacementRequestIdentity);
  if(r.requestOutcome!=='FAILED'||f.sourceIdentityVerified!==true||f.failedRequestHasCommittedResult!==false||f.acceptedMutation!==false||!replacement||replacement.requestOutcome!=='OBSERVED')return false;
  if(r.provider!==S.manifest.provider||r.model!==S.manifest.model||replacement.provider!==r.provider||replacement.model!==r.model||replacement.phase!==r.phase||replacement.sessionId!==r.sessionId||replacement.taskId!==r.taskId||replacement.taskInstanceId!==r.taskInstanceId||replacement.attempt<=r.attempt)return false;
  if(!sameBinding(a,e)||!sameBinding(a,z)||!sameBinding(a,n)||a.observationId!==e.observationId||a.observationId!==z.observationId||a.sessionId!==r.sessionId||a.benchmarkPhase!==r.phase||a.provider!==r.provider||a.model!==r.model||a.harnessRetryNumber!==r.attempt||n.harnessRetryNumber!==replacement.attempt||n.observationId===a.observationId)return false;
  if(a.kind!=='provider_request_start'||e.kind!=='provider_raw_failure'||!e.error||!finite(e.sdkAttemptNumber)||e.sdkAttemptNumber<1||z.kind!=='provider_request_end'||z.outcome!=='FAILURE'||z.sdkAttempts!==1||n.kind!=='provider_request_end'||n.outcome!=='SUCCESS'||n.sdkAttempts!==1)return false;
  if(!finite(replacement.providerInputTokens)||!finite(replacement.pressureBefore)||!finite(replacement.pressureAfter))return false;
  const d=s.data,b=t.data,base=Math.min(p.maxDelayMs,p.initialDelayMs*2**(d.retry-1));
  if(p.mode!=='normal'||d.provider!==r.provider||d.mode!==p.mode||d.policyKey!==policyKey(p)||d.maxRetries!==p.maxRetries||d.retry!==r.attempt+1||d.retry>p.maxRetries||!p.retryableCodes.includes(d.failure?.code)||b.retry!==d.retry||b.retryId!==d.retryId||d.turn!==a.turn||d.step!==a.step||b.turn!==a.turn||b.step!==a.step)return false;
  if(!Number.isFinite(d.delayMs)||d.delayMs<base*(1-p.jitterRatio)||d.delayMs>Math.min(p.maxDelayMs,base*(1+p.jitterRatio))||!finite(s.time)||!finite(t.time)||t.time<s.time||s.seq>r.durableSequenceRange[1]||t.seq<=r.durableSequenceRange[1])return false;
  const times=[a.timestamp,e.timestamp,z.timestamp,n.timestamp].map(Date.parse);
  if(times.some(v=>!Number.isFinite(v))||times[0]>times[1]||times[1]>s.time||times[2]>s.time||times[3]<t.time)return false;
  return true;
 }catch{return false;}
}
function accounting(requests){
 const accepted=requests.filter(r=>r.requestOutcome==='OBSERVED'),failed=requests.filter(r=>r.requestOutcome==='FAILED');
 const known=accepted.filter(r=>finite(r.providerInputTokens)).reduce((s,r)=>s+r.providerInputTokens,0);
 const failures=failed.map(r=>{const f=r.failureEvidence,z=f?.rawEnd,s=f?.scheduled,t=f?.started;return {requestIdentity:r.requestIdentity,phase:r.phase,provider:r.provider??null,model:r.model??null,providerInputTokens:finite(z?.providerReportedInputTokens)?z.providerReportedInputTokens:null,outputTokens:finite(z?.outputTokens)?z.outputTokens:null,observationId:f?.rawInvocation?.observationId??null,rawFailure:f?.rawFailure??null,failedRequestHasCommittedResult:f?.failedRequestHasCommittedResult??null,recovered:recovered(r,requests),retry:s?{retryNumber:s.data.retry,policyKey:s.data.policyKey,scheduledBackoffMs:s.data.delayMs,actualRetryStart:t?new Date(t.time).toISOString():null,actualBackoffMs:t?t.time-s.time:null}:null};});
 const knownFailed=failures.filter(r=>finite(r.providerInputTokens)),unavailable=failures.length-knownFailed.length;
 return {successfulAcceptedProviderInputTokens:accepted.every(r=>finite(r.providerInputTokens))?known:null,knownFailedAttemptProviderInputTokens:knownFailed.length?knownFailed.reduce((s,r)=>s+r.providerInputTokens,0):failed.length?null:0,failedAttemptUsageUnavailableCount:unavailable,totalKnownProviderInputTokens:known+knownFailed.reduce((s,r)=>s+r.providerInputTokens,0),billingUsageComplete:unavailable===0&&requests.every(r=>r.requestOutcome==='OBSERVED'||r.requestOutcome==='FAILED')&&accepted.every(r=>finite(r.providerInputTokens)),failedAttemptCount:failed.length,recoveredFailedAttemptCount:failures.filter(r=>r.recovered).length,failedAttempts:failures,scope:'benchmark step attempts; auxiliary SDK invocations remain in raw evidence'};
}
function readEvidence(root){
 try{
  const file=S.inside(root,'nexus-root/logs/provider-observability.jsonl');
  const stat=S.fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1)return [];
  return S.fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse);
 }catch{return [];}
}
function resolvedPolicy(root){
 try{
  const base=S.inside(root,'nexus-root/app/node_modules'),yaml=require(S.path.join(base,'yaml'));
  const providers=['config/settings.yaml','data/settings.yaml'].map(p=>yaml.parse(S.fs.readFileSync(S.inside(root,'nexus-root/'+p),'utf8'))?.['llm-pi-ai']?.providers?.[S.manifest.provider]);
  if(!providers.some(p=>p&&typeof p==='object'))return null;
  const configs=providers.filter(Boolean).map(p=>p.retryPolicy).filter(p=>p!==undefined);
  if(configs.length>1&&S.json(configs[0])!==S.json(configs[1]))return null;
  return require(S.path.join(base,'@deepseek-ai/dsh-llm/lib/types/retry-policy.js')).resolveRetryPolicy(configs[0],'LHCB accounting read-only');
 }catch{return null;}
}
function attach(rows,events,record,raw,policy,sourceIdentityVerified){
 for(const r of rows.filter(x=>x.requestOutcome==='FAILED')){
  const start=events[r.durableSequenceRange[0]],end=events[r.durableSequenceRange[1]];
  const candidates=raw.filter(x=>x.kind==='provider_request_start'&&x.sessionId===r.sessionId&&x.benchmarkPhase===r.phase&&x.benchmarkRpcId===record.rpcId&&x.turn===start.data.turn&&x.step===start.data.step&&x.harnessRetryNumber===r.attempt&&Date.parse(x.timestamp)>=start.time&&Date.parse(x.timestamp)<=end.time);
  if(candidates.length!==1)continue;
  const a=candidates[0],group=raw.filter(x=>x.observationId===a.observationId),s=events.find(x=>x.type==='llm/retry'&&x.seq>=start.seq&&x.seq<=end.seq),t=events.find(x=>x.type==='llm/retry-started'&&x.data.retryId===s?.data.retryId&&x.seq>end.seq);
  const replacement=rows.find(x=>x.requestOutcome==='OBSERVED'&&x.attempt>r.attempt&&x.durableSequenceRange[0]>=t?.seq&&events[x.durableSequenceRange[0]]?.data.turn===a.turn&&events[x.durableSequenceRange[0]]?.data.step===a.step);
  const n=raw.filter(x=>x.kind==='provider_request_end'&&sameBinding(a,x)&&x.harnessRetryNumber===replacement?.attempt&&x.outcome==='SUCCESS'&&Date.parse(x.timestamp)>=t?.time&&Date.parse(x.timestamp)<=events[replacement?.durableSequenceRange[1]]?.time);
  const segment=events.slice(start.seq,end.seq+1),committed=segment.some(x=>['assistant/message','tool/call','tool/start','tool/end','tool/result'].includes(x.type)||x.surfaceOp);
  const output=segment.some(x=>x.type==='assistant/chunk'&&!['usage','finish'].includes(x.data.chunk?.type));
  r.failureEvidence={rawInvocation:a,rawFailure:group.find(x=>x.kind==='provider_raw_failure'&&x.sdkAttemptNumber>=1)??null,rawEnd:group.find(x=>x.kind==='provider_request_end')??null,failedRequestHasCommittedResult:committed,acceptedMutation:committed||output,retryPolicy:policy,scheduled:s??null,started:t??null,replacementRequestIdentity:replacement?.requestIdentity??null,replacementRawEnd:n.length===1?n[0]:null,sourceIdentityVerified};
 }
 return rows;
}
module.exports={recovered,accounting,readEvidence,resolvedPolicy,attach,policyKey};
