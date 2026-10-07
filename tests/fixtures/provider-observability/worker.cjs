'use strict';
// Offline differential fixture: actual pinned DSH → pi-ai → OpenAI SDK.
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),crypto=require('node:crypto'),{syncBuiltinESMExports}=require('node:module');
const app=process.argv[2],scenario=process.argv[3];
Date.now=()=>1700000000000;crypto.randomUUID=()=> '00000000-0000-4000-8000-000000000001';syncBuiltinESMExports();
const timers=[],originalTimer=global.setTimeout;
global.setTimeout=(fn,ms,...args)=>{if(ms===500||ms===1000||scenario==='sdk-timeout'&&ms===600000){timers.push(ms);return originalTimer(fn,0,...args);}return originalTimer(fn,ms,...args);};
const requests=[],controller=new AbortController();
function network(code){return Object.assign(new Error('socket failure'),{code,errno:code==='ECONNRESET'?-104:-110,syscall:'read',hostname:'mock.invalid',address:'203.0.113.5',port:443});}
function success(){const item={type:'message',id:'msg-test',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]};const events=[['response.created',{response:{id:'resp-muse-123',status:'in_progress',output:[]}}],['response.output_item.done',{output_index:0,item}],['response.completed',{response:{id:'resp-muse-123',status:'completed',output:[item],usage:{input_tokens:40,output_tokens:5,total_tokens:45,input_tokens_details:{cached_tokens:10}}}}]];return new Response(events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify({type:event,...data})+'\n\n').join(''),{headers:{'content-type':'text/event-stream','x-request-id':'http-123','x-opencode-log-id':'go-123','x-muse-request-id':'muse-123'}});}
global.fetch=async(url,init)=>{if(!String(url).startsWith('https://mock.invalid/'))throw Error('fixture forbids network');requests.push({url:String(url),body:init.body,headers:[...new Headers(init.headers)],method:init.method,signal:init.signal instanceof AbortSignal});
 if(scenario==='success'||scenario==='retry'&&requests.length===3)return success();
 if(scenario==='sdk-timeout')return new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('SDK deadline elapsed','AbortError')),{once:true});});
 if(scenario==='reset'||scenario==='timeout')throw new TypeError('fetch failed',{cause:network(scenario==='reset'?'ECONNRESET':'ETIMEDOUT')});
 if(scenario==='nested')throw new TypeError('fetch failed',{cause:Object.assign(new Error('SDK envelope',{cause:network('ECONNRESET')}),{code:'WRAPPED'})});
 if(scenario==='abort'||scenario==='caller-abort'){if(scenario==='caller-abort')controller.abort(Object.assign(new Error('client deadline elapsed'),{code:'CLIENT_TIMEOUT'}));throw new DOMException('client timeout','AbortError');}
 if(scenario==='termination')return new Response(new ReadableStream({start(c){c.error(new TypeError('terminated',{cause:Object.assign(network('UND_ERR_SOCKET'),{name:'SocketError'})}));}}),{headers:{'content-type':'text/event-stream','x-request-id':'remote-123'}});
 const status=scenario==='retry'?503:scenario==='quota'?429:scenario==='retry-ineligible'?500:Number(scenario);return new Response(JSON.stringify({error:{code:scenario==='quota'?'insufficient_quota':status===429?'rate_limit_exceeded':'upstream_unavailable',message:'Muse upstream busy; private-source-text; sk-fixture-secret-1234567890',upstream:{id:'muse-upstream-1'},api_key:'unknown-body-secret',prompt:'private-source-text'}}),{status,headers:{'content-type':'application/json','retry-after':'3','x-request-id':'http-123','x-opencode-log-id':'go-123','x-muse-request-id':'muse-123','authorization':'Bearer secret-header','set-cookie':'secret-cookie',...(scenario==='retry-ineligible'?{'x-should-retry':'false'}:{})}});
};
(async()=>{
 const load=relative=>import(pathToFileURL(path.join(app,'node_modules',relative)).href);
 const [{PiAiAdapter},{streamSimple:streamSimpleOpenAIResponses},{Session},{apply}]=await Promise.all([load('@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),load('@earendil-works/pi-ai/dist/api/openai-responses.js'),load('@deepseek-ai/dsh-session/lib/index.js'),load('@deepseek-ai/dsh-llm-retry/lib/index.js')]);
 const model={id:'muse-spark-1.3-contributor',name:'Muse',api:'openai-responses',provider:'opencode-go',baseUrl:'https://mock.invalid/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1048576,maxTokens:131072};
 const profile={streamIdleTimeoutMs:300000,timeoutMs:600000,configuredMaxTokens:new Map()},profiles=new Map([['opencode-go',profile]]);
 const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=> 'sk-fixture-secret-1234567890'});
 // Model catalog seam only: conversion, watchdog, stream normalization and SDK are real.
 adapter.snapshot={profiles,models:{getModel:()=>model,streamSimple:streamSimpleOpenAIResponses}};
 const session=new Session('session-test');session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1});session.append('user/message',{id:'user-1',role:'user',content:[{type:'text',text:'private-source-text'}],source:{kind:'user',rpcId:'rpc-test'}},{surfaceOp:'append'});
 let recover,cleanup;apply({on:(_name,fn)=>{recover=fn;return ()=>{};},effect:fn=>{cleanup=fn();},logger:{warn:()=>{}}},{},{random:()=>0.5});
 const outputs=[],decisions=[];
 for(let attempt=0;attempt<(scenario==='retry'?3:1);attempt++){
 const chunks=[];let thrown=null;try{for await(const chunk of adapter.stream({provider:model.provider,model:model.id,sessionId:session.id,messages:[{role:'user',content:[{type:'text',text:'private-source-text'}]}],signal:controller.signal}))chunks.push(chunk);}catch(e){thrown={name:e.name,message:e.message,code:e.code};}outputs.push({chunks,thrown});
 if(scenario==='retry'){const failure={code:'SERVER_ERROR',message:'upstream busy'};const decision=await recover({agent:{session},turn:1,step:1,provider:model.provider,failure,signal:controller.signal,retryPolicy:{mode:'normal',maxRetries:2,retryableCodes:['SERVER_ERROR'],initialDelayMs:500,maxDelayMs:10000,jitterRatio:0.1}},async()=>({kind:'stop'}));decisions.push(decision);if(decision?.kind!=='retry')break;}
 }
 await cleanup();console.log(JSON.stringify({requests,outputs,decisions,timers,events:session.events}));
})().catch(e=>{console.error(e);process.exitCode=1;});
