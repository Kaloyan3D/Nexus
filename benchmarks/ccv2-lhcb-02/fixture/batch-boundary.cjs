'use strict';
function cases(){
 const actor={tenant:'alpha',role:'writer',revoked:false};
 const context={tenant:'alpha',account:'001',grant:{tenant:'alpha',scopes:['post'],revoked:false},holds:[],cost:26,cancelAt:'none'};
 const commands=[{key:'first',expectedRevision:0,posting:{id:'001',amount:13,currency:'USD',kind:'transfer'}},{key:'second',expectedRevision:1,posting:{id:'001',amount:13,currency:'USD',kind:'transfer'}}];
 const make=(name,changes,expected)=>({name,seed:[{id:'001',balance:79,revision:0}],actor:structuredClone(actor),context:structuredClone(context),commands:structuredClone(commands),...changes,expected});
 const none={status:422,history:0,balance:79};const stale=structuredClone(commands);stale[1].expectedRevision=0;
 const duplicate=structuredClone(commands);duplicate[1].key=duplicate[0].key;
 const invalid=structuredClone(commands);invalid[1].posting.currency='XXX';
 return [
  make('later-stale-CAS-publishes-nothing',{commands:stale},{throws:true,history:0,balance:79}),
  make('valid-staged-revisions-commit-once',{}, {status:201,history:2,balance:105}),
  make('duplicate-key-publishes-nothing',{commands:duplicate},{throws:true,history:0,balance:79}),
  make('revoked-actor-publishes-nothing',{actor:{...actor,revoked:true}},{status:403,history:0,balance:79}),
  make('foreign-actor-publishes-nothing',{actor:{...actor,tenant:'beta'}},{status:403,history:0,balance:79}),
  make('cancel-before-commit-publishes-nothing',{context:{...context,cancelAt:'before-commit'}},none),
  make('invalid-later-posting-publishes-nothing',{commands:invalid},none),
  make('active-hold-removes-availability',{context:{...context,holds:[{id:'opaque/hold',amount:79,state:'active'}]}},none)
 ];
}
const verifier=`'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const rows=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence/E23/batch-boundary.json'),'utf8'));
const createStore=require('../src/persistence.ts').createStore,batch=require('../src/batch.ts');
let failures=0,diagnostics=0;
for(const row of rows){const store=createStore(row.seed),commands=structuredClone(row.commands),context=structuredClone(row.context),actor=structuredClone(row.actor),before=JSON.stringify([commands,context,actor]);let result,threw=false;
 try{try{result=batch.apply(store,commands,actor,()=>1,context);}catch{threw=true;}
  assert.equal(threw,row.expected.throws??false,'storage preflight errors propagate');
  if(!threw)assert.equal(result.status,row.expected.status);
  assert.equal(store.history().length,row.expected.history,'no partial publication');
  assert.equal(store.read(context.tenant,context.account).balance,row.expected.balance);
  assert.equal(JSON.stringify([commands,context,actor]),before,'caller inputs preserved');
 }catch(e){failures++;if(process.argv.includes('--diagnose')&&diagnostics++<8)console.log(JSON.stringify({scenario:row.name,input:row,actual:result??null,threw,history:store.history(),reason:e.message}));}
}
console.log(JSON.stringify({phase:'E23-batch-boundary',cases:rows.length,failures}));if(failures)process.exitCode=1;
`;
function files(){return {'evidence/E23/batch-boundary.json':JSON.stringify(cases(),null,2)+'\n','tools/verify-batch.cjs':verifier,'evidence/E23/apply-contract.json':JSON.stringify({entry:'batch.apply(store,commands,actor,clock,context)',tenant:'commands inherit context.tenant',publication:'preflight the complete batch before publishing any write; use the shared atomic store boundary',input:'preserve commands, actor and context; pass posting signs unchanged to the store',errorChannel:'storage preflight failures (stale revisions or duplicate keys) throw without publishing; permission and planning denials return status with empty results',keys:'this atomic primitive accepts new keys; per-operation replay belongs to service.post'},null,2)+'\n'};}
module.exports={cases,files};
