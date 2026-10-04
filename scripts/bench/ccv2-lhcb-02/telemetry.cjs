'use strict';
const {S,load}=require('./infrastructure.cjs');
const gate=require('../../../config/ContextActivationPressureV2.cjs'),wire=require('../../../config/ContextWireProjectorResponsesV2.cjs');
const Session=load('session'),D=load('doctor');
const count=(events,type)=>events.filter(e=>e.type===type).length;
const optional=(u,k)=>Number.isSafeInteger(u?.[k])&&u[k]>=0?u[k]:null;
function compilerObservation(root){
 const policy=S.read(S.inside(root,'nexus-root/config/routing-policy.json')).contextCompiler;
 const file=S.inside(root,'nexus-root/data/logs/aih-controller.log');
 let rows=[];try{if(S.fs.existsSync(file))rows=S.fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.event==='ccv2-opencode-active-decided');}catch{return {mode:null,compilerExecutionCount:null};}
 // Production bypasses the active listener when mode is off. Absence of active
 // decisions is expected, not missing evidence. Contradictory decisions fail.
 if(policy.mode!=='off'||policy.activation!=='pressure'||rows.some(r=>r.compilerExecutions!==0||r.projectionMode!=='LEGACY'||r.policyMode!=='off'))return {mode:null,compilerExecutionCount:null};
 return {mode:'NATIVE',compilerExecutionCount:0};
}
function pressure(root,events){return gate.decideActivationV2({events,messages:Session.surfaceMessages(events,root),route:D.route(root),mode:gate.resolveActivationModeV2({contextCompiler:S.manifest.arms.native})}).pressureTokens;}
function collectRequests(root,b,record){
 const rows=[],events=b.events;
 const steps=events.filter(e=>e.type==='step/start'&&e.seq>=record.startSeq&&e.seq<=(record.endSeq??Infinity));
 for(const step of steps){
  const next=events.find(e=>e.seq>step.seq&&(e.type==='step/start'||e.type==='turn/end'));
  const limit=Math.min(next?.seq??events.length-1,record.endSeq??events.length-1);
  const starts=[step,...events.filter(e=>e.seq>step.seq&&e.seq<limit&&e.type==='llm/retry-started')];
  for(const [attempt,start] of starts.entries()){
   const end=starts[attempt+1]?.seq??limit;
   const requestOrdinal=events.filter(e=>e.seq<start.seq&&(e.type==='step/start'||e.type==='llm/retry-started')).length,compiler=compilerObservation(root,requestOrdinal);
   const segment=events.filter(e=>e.seq>=start.seq&&e.seq<end);
   const responses=segment.filter(e=>e.type==='assistant/message');const response=responses.length===1?responses[0]:null;
   // Header can be emitted after step/start: snapshot the final header preceding send/response.
   const headerEnd=response?.seq??end;
   const prefix=events.slice(0,start.seq+1),header=events.slice(0,headerEnd).findLast(e=>e.type==='request/header')?.data.header;
   const boundary=prefix;let requestHash=null,canonicalRequestBytes=null,wireItemCount=null,messageCount=null;
   const availability={};
   try{
    if(!header)throw Error('missing-header');const route=D.route(root),messages=wire.applyReasoningReplayV2(Session.surfaceMessages(boundary,root),route);messageCount=messages.length;
    const request={...header.config,messages,system:header.system,tools:header.tools,sessionId:b.sessionId};
    const body=wire.projectResponsesWireV2({request,route}).wireBody;
    const bytes=S.json(body);requestHash=S.hash(bytes);canonicalRequestBytes=Buffer.byteLength(bytes);wireItemCount=body.input.length;
   }catch(e){availability.requestProjection=(e.message||'').match(/^context-wire-[a-z0-9-]+/)?.[0]??'durable-request-unobservable';}
   const usage=response?.data.usage,total=gate.sampleTokensOfV2(usage);
   const pressureBefore=pressure(root,boundary),through=events.slice(0,(response?.seq??Math.max(start.seq,end-1))+1),pressureAfter=pressure(root,through);
   const row={phase:record.promptId,sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId,
    requestIdentity:S.hash(S.json([b.sessionId,b.taskId,b.taskInstanceId,step.seq,attempt])),attempt,
    durableSequenceRange:[start.seq,response?.seq??Math.max(start.seq,end-1)],requestHash,promptHash:record.promptHash,
    requestOutcome:response?(response.data.interrupted?'INTERRUPTED':'OBSERVED'):(segment.some(e=>e.type==='llm/retry')?'FAILED':'UNOBSERVED'),
    providerInputTokens:total===null?null:total-usage.outputTokens,uncachedInputTokens:optional(usage,'inputTokens'),cacheReadTokens:total===null?null:usage.cacheReadTokens??0,cacheWriteTokens:total===null?null:usage.cacheWriteTokens??0,outputTokens:optional(usage,'outputTokens'),reasoningTokens:optional(usage,'reasoningTokens'),
    pressureBefore,pressureAfter,pressureDelta:pressureBefore===null||pressureAfter===null?null:pressureAfter-pressureBefore,
    messageCount,reconstructedWireItemCount:wireItemCount,historicalToolCallCount:count(boundary,'tool/call'),historicalToolResultCount:count(boundary,'tool/result'),canonicalRequestByteCount:canonicalRequestBytes,
    historyCompactionCount:through.filter(e=>e.type.startsWith('compaction/')).length,historyReplacementCount:through.filter(e=>e.surfaceOp&&e.surfaceOp!=='append').length,...compiler,availability};
   for(const [key,value] of Object.entries(row))if(value===null)availability[key]='unavailable in durable evidence';
   rows.push(row);
  }
 }
 return rows;
}
function evidenceHashes(events){
 const hashes=[];
 for(const e of events.filter(e=>e.type==='tool/result'))for(const block of e.data.message?.content||[])if(block.type==='tool-result'&&Array.isArray(block.content)&&block.content.length){
  // Transport identifiers and tool names are not new engineering evidence.
  const content=block.content.map(x=>x.type==='text'?{type:'text',text:x.text}:x);
  if(content.some(x=>x.type==='text'&&typeof x.text==='string'&&x.text.trim()))hashes.push(S.hash(S.json(content)));
 }
 return [...new Set(hashes)];
}
function phaseSummary(b,record,requests){
 const events=b.events.slice(record.startSeq,record.endSeq+1);
 // Counters in mutable journals are receipts, not pressure authority.
 const before=requests[0]?.pressureBefore??null,after=requests.at(-1)?.pressureAfter??null;
 const terminal=events.filter(e=>e.type==='assistant/message').at(-1)?.data.message?.content?.filter(x=>x.type==='text');
 return {phase:record.promptId,pressureBefore:before,pressureAfter:after,pressureGrowth:before===null||after===null?null:after-before,
  firstProviderInput:requests[0]?.providerInputTokens??null,lastProviderInput:requests.at(-1)?.providerInputTokens??null,requests:requests.length,toolCalls:count(events,'tool/call'),
  newToolEvidenceHashes:evidenceHashes(events),terminalContentHash:terminal?.length?S.hash(S.json(terminal)):null,evidenceSetHash:record.evidenceSetHash,acceptance:record.acceptance??null,
  compactionEvents:events.filter(e=>e.type.startsWith('compaction/')).length,historyReplacements:events.filter(e=>e.surfaceOp&&e.surfaceOp!=='append').length};
}
module.exports={collectRequests,phaseSummary,evidenceHashes,compilerObservation};
