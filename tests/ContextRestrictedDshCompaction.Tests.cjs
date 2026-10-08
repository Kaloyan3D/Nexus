'use strict';
// Real pinned DSH compactor/session; deterministic summarizer, no provider IO.
const assert=require('node:assert/strict');
const path=require('node:path');
const policy=require('../config/ContextDurableMutationPolicyV2.cjs');
const app=process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app';
const {Context,Service}=require(path.join(app,'node_modules/@deepseek-ai/cordis/lib/index.js'));
const {SessionStore}=require(path.join(app,'node_modules/@deepseek-ai/dsh-session/lib/index.js'));
const {BasicCompactionEngine}=require(path.join(app,'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'));
let passed=0;
function check(ok,name){assert(ok,name);passed++;console.log('PASS: '+name);}
async function main(){
 const ctx=new Context();const store=new SessionStore(ctx);
 const session=store.create('sess-restricted-native',{meta:{cwd:process.cwd()}});
 for(let i=0;i<4;i++) session.append('user/message',{id:'native-'+i,role:'user',content:[{type:'text',text:'synthetic native history '+i}],source:{kind:'user'}},{surfaceOp:'append'});
 session.append('turn/start',{turn:'turn-native',input:[]});
 const original=session.surface.nodes.slice();
 let summaries=0;
 class DeterministicCompactor extends BasicCompactionEngine {
  async summarize(input){summaries++;check(input.messages.length===2,'native summarizer receives selected history');return {summary:'synthetic summary',provider:'synthetic',model:'no-inference'};}
 }
 // Meter/summarizer are deterministic services; all compactor methods and
 // session replacement/lifecycle execute the installed implementation.
 class DeterministicMeter extends Service {
  constructor(ctx){super(ctx,'tokenMeter');}
  measure(s){return {nodes:s.surface.nodes.map(seq=>({seq,tokens:1000})),totalTokens:s.surface.nodes.length*1000};}
  estimateMessage(){return 1;}
 }
 new DeterministicMeter(ctx);
 const engine=new DeterministicCompactor(ctx,{auto:false});
 const result=await engine.compactRegion(original[0],original[1],{session},new AbortController().signal);
 check(policy.durableMutationEnabledV2()===false,'CCv2 durable policy stays disabled while native compaction runs');
 check(summaries===1 && result!==null,'real DSH compactor completes once');
 check(session.surface.nodes.includes(original[2]) && session.surface.nodes.includes(original[3]) && !session.surface.nodes.includes(original[0]) && !session.surface.nodes.includes(original[1]),'native compaction replaces selected history and retains tail');
 check(session.events.some(e=>e.type==='compaction/end') && session.events.some(e=>e.type==='user/message' && e.data.source.plugin==='compact'),'native lifecycle and checkpoint provenance preserved');
 let durable;ctx.on('session/flush',s=>{durable=JSON.stringify(s.events)});
 check(await store.flush(session)===true && !!durable,'native compaction can flush through the supported DSH barrier');
 const restored=new SessionStore(new Context()).create(session.id,{seedSource:'persistence',seed:JSON.parse(durable),meta:session.header});
 check(JSON.stringify(restored.deriveMessages())===JSON.stringify(session.deriveMessages()),'native compaction survives real session restore with CCv2 writes disabled');
 console.log('Restricted DSH compaction: passed='+passed+' failed=0');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
