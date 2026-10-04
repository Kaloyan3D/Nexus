'use strict';
// Integration regression journeys: every step changes or observes an actual caller contract.
const L=require('./late.cjs');
const baselineSteps=()=>[
 {op:'post',tenant:'alpha',actor:{tenant:'alpha',role:'writer',revoked:false},key:'opening',id:'001',amount:17,currency:'JPY',kind:'transfer',expectedRevision:0,clock:11},
 {op:'post',tenant:'alpha',actor:{tenant:'alpha',role:'writer',revoked:false},key:'opening',id:'001',amount:17,currency:'JPY',kind:'transfer',expectedRevision:0,clock:12},
 {op:'post',tenant:'alpha',actor:{tenant:'alpha',role:'writer',revoked:true},key:'opening',id:'001',amount:17,currency:'JPY',kind:'transfer',expectedRevision:0,clock:13},
 {op:'post',tenant:'alpha',actor:{tenant:'alpha',role:'writer',revoked:false},key:'opening',id:'001',amount:19,currency:'JPY',kind:'transfer',expectedRevision:1,clock:14},
 {op:'post',tenant:'beta',actor:{tenant:'beta',role:'owner',revoked:false},key:'opening',id:'001',amount:23,currency:'KWD',kind:'transfer',expectedRevision:0,clock:15},
 {op:'post',tenant:'alpha',actor:{tenant:'alpha',role:'writer',revoked:false},key:'adjustment',id:'001',amount:-3,currency:'USD',kind:'adjustment',expectedRevision:1,clock:16},
 {op:'post',tenant:'alpha',actor:{tenant:'alpha',role:'writer',revoked:false},key:'invalid',id:'001',amount:1.5,currency:'USD',kind:'transfer',expectedRevision:2,clock:17},
 {op:'recover',failure:'timeout'},
 {op:'inspect',tenant:'alpha',id:'001'},
 {op:'inspect',tenant:'beta',id:'001'}
];
function inputs(id,hidden=false){
 const spec=L.specs.find(x=>x[0]===id);if(!spec)return [];
 const name=spec[1],rows=[];
 // Independent equivalence classes: identifier encodings, permission states,
 // currencies and schema versions, interleaved tenant writes and ambiguous retries.
 const identities=hidden?['holdout/account','hidden\u0301']:['001','__proto__','account/child','e\u0301'];
 const amounts=hidden?[43,107]:[1,17,101];
 for(const [index,account] of identities.entries())for(const [amountIndex,amount] of amounts.entries())for(const variant of L.cases(id,hidden)){
  const currency=['JPY','USD','KWD'][(index+amountIndex)%3];
  const steps=baselineSteps();for(const s of steps){if(s.id)s.id=account;if(s.op==='post'&&s.amount===17){s.amount=amount;s.currency=currency;}}
  // Local component observation is between old writes and a new matching replay.
  steps.splice(8,0,{op:name,input:structuredClone(variant.input)});
  steps.push({...steps[0],clock:99},{op:'inspect',tenant:'alpha',id:account});
  rows.push({steps});
 }
 if(name==='rollback'){
  for(const version of [1,2,3,97])for(const reader of [1,3,8]){
   const document={version,[version===1?'entries':'records']:[{id:hidden?'hidden/canonical':'rollback/account',[version===1?'cents':'amount']:43,currency:'JPY',kind:'transfer'}],writerRevision:19,annotation:{original:'retained'}};
   rows.push({steps:[...baselineSteps(),{op:name,input:{document,reader}}]});
  }
 }
 return rows;
}
// Host-only ledger oracle. It does not execute candidate code or reuse its driver.
function expected(x){
 const accounts=new Map(),keys=new Map(),history=[],observations=[];
 const key=(t,id)=>JSON.stringify([t,id]);
 for(const s of x.steps){
  if(s.op==='post'){
   const actor=s.actor,posting={id:s.id,amount:s.amount,currency:s.currency,kind:s.kind},a=accounts.get(key(s.tenant,s.id))||{id:s.id,balance:0,revision:0};
   let result;
   if(actor.tenant!==s.tenant||!['owner','writer'].includes(actor.role)||actor.revoked)result={status:403};
   else{
    const replay=keys.get(key(s.tenant,s.key)),fingerprint=JSON.stringify(posting);
    if(replay)result=replay.fingerprint===fingerprint?{...replay.result,status:200}:{status:409};
    else if(a.revision!==s.expectedRevision)result={status:409};
    else if(!require('./create-fixture.cjs').oracle('E01',posting).accepted)result={status:422};
    else if(!Number.isSafeInteger(a.balance+s.amount))result={error:'balance-overflow'};
    else{
     const next={id:s.id,balance:a.balance+s.amount,revision:a.revision+1};accounts.set(key(s.tenant,s.id),next);
     result={status:201,transactionId:'txn-'+(history.length+1),revision:next.revision};keys.set(key(s.tenant,s.key),{fingerprint,result:{...result}});
     history.push({tenant:s.tenant,key:s.key,state:'committed',checksum:'valid',revision:next.revision,balance:next.balance});result={...result,committedAt:s.clock};
    }
   }observations.push(result);
  }else if(s.op==='inspect')observations.push(accounts.get(key(s.tenant,s.id))||{id:s.id,balance:0,revision:0});
  else if(s.op==='recover')observations.push(require('./create-fixture.cjs').oracle('E06',{journal:history,failure:s.failure}));
  else observations.push(L.expected(s.op,s.input));
 }
 return {observations,history};
}
function reference(){return `function evaluate(x:any){
 const store=require('./persistence.ts').createStore(),observations:any[]=[];
 for(const step of x.steps){
  if(step.op==='post'){
   const command={tenant:step.tenant,key:step.key,expectedRevision:step.expectedRevision,requestId:'journey',posting:{id:step.id,amount:step.amount,currency:step.currency,kind:step.kind}};
   try{observations.push(require('./service.ts').post(store,command,step.actor,()=>step.clock));}catch(e:any){observations.push({error:e.message});}
  }else if(step.op==='inspect')observations.push(store.read(step.tenant,step.id));
  else if(step.op==='recover')observations.push(require('./recovery.ts').evaluate({journal:store.history(),failure:step.failure}));
  else{
   const handlers={${L.specs.map(s=>JSON.stringify(s[1])+":()=>require('./"+s[1]+".ts')").join(',')}};
   observations.push(handlers[step.op]().evaluate(step.input));
  }
 }
 return {observations,history:store.history()};
}module.exports={evaluate};\n`;}
function files(id){
 const name=L.specs.find(x=>x[0]===id)?.[1];if(!name)return {};
 const scenarios=inputs(id).map((input,i)=>({caseId:id+'-journey-'+i,input,expected:expected(input)}));
 const contract={phase:id,component:name,entry:'src/'+name+'-journey.ts',method:'evaluate(input)',input:'{steps: ordered actions}; inputs immutable',output:'{observations: one result per action in order, history: actual committed store history}',actions:{post:'Construct posting and command exactly from action; requestId journey. Use normal service.post with injected clock. Preserve response fields, including committedAt on new commits. Catch thrown store errors as {error: message}.',inspect:'Return store.read(tenant,id) from the same store.',recover:'Call recovery.evaluate with actual store.history and action.failure.',[name]:'Call '+name+'.evaluate(action.input), preserving all prior contracts.'},lifecycle:'Create one persistence.createStore() per journey; no state shared between journeys. Duplicate keys, denied replays, foreign namespaces and invalid writes must never create extra commits.',verification:'node tools/verify-journey.cjs '+id+' --diagnose',dependencies:['domain','api','authorization','recovery','service','persistence',name],regression:'Run all released phase and journey verifiers. Keep earlier consumers working.'};
 return {[`src/${name}-journey.ts`]:`// New supported integration consumer: implement the released action contract.\nfunction evaluate(input:any){throw Error('journey-consumer-not-implemented');}\nmodule.exports={evaluate};\n`,[`evidence/${id}/journeys.jsonl`]:scenarios.map(JSON.stringify).join('\n')+'\n',[`evidence/${id}/journey-contract.json`]:JSON.stringify(contract,null,2)+'\n',...(id==='E07'?{'tools/verify-journey.cjs':`'use strict';const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const id=process.argv[2],contract=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence',id,'journey-contract.json'),'utf8')),impl=require(path.join(__dirname,'..',contract.entry));const rows=fs.readFileSync(path.join(__dirname,'../evidence',id,'journeys.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);let failures=0,diagnostics=0;for(const r of rows){const original=JSON.stringify(r.input);try{const actual=impl.evaluate(r.input);assert.deepEqual(actual,r.expected);assert.equal(JSON.stringify(r.input),original);}catch(e){failures++;if(process.argv.includes('--diagnose')&&diagnostics++<8)console.log(JSON.stringify({caseId:r.caseId,input:r.input,expected:r.expected,error:e.message}));}}console.log(JSON.stringify({phase:id,kind:'public-integration-journeys',cases:rows.length,failures}));process.exitCode=failures?1:0;\n`}: {})};
}
module.exports={inputs,expected,reference,files};
