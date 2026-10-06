'use strict';
// One connected access-audit consumer, with distinct service outcomes.
const reference=`const authorization=require('./authorization.ts'),service=require('./service.ts');
function postAudited(store:any,command:any,actor:any,audits:any[],clock:()=>number){
 const decision=authorization.evaluate({actorTenant:actor.tenant,targetTenant:command.tenant,role:actor.role,revoked:actor.revoked,event:{operation:'post',requestId:command.requestId,authorization:actor.credential,requestBody:command.posting}});
 const result=decision.allowed?service.post(store,command,actor,clock):{status:403};
 const {operation,tenant,decision:access,requestId}=decision.audit;
 audits.push({operation,tenant,decision:access,requestId});
 return result;
}
module.exports={postAudited};
`;
const source=reference.replace('audits.push({operation,tenant,decision:access,requestId});',"if(result.status===201)audits.push({...command,authorization:actor.credential});");
function inputs(hidden=false){return (hidden?['__proto__','e\u0301']:['001','account/child']).map((id,i)=>({id,amount:(hidden?29:13)+i,tenant:hidden?'holdout-a':'example-a',foreign:hidden?'holdout-b':'example-b',key:hidden?'private/key':'public/key',requestId:hidden?'held-request':'public-request'}));}
function exercise(createStore,postAudited,x){
 const store=createStore(),audits=[],actor={tenant:x.tenant,role:'writer',revoked:false,credential:'fixture-private'},command={tenant:x.tenant,key:x.key,expectedRevision:0,requestId:x.requestId,posting:{id:x.id,currency:'JPY',kind:'transfer',amount:x.amount}};
 const attempts=[ [command,actor], [command,actor], [command,{...actor,revoked:true}], [command,{...actor,tenant:x.foreign}], [{...command,posting:{...command.posting,amount:x.amount+1}},actor], [{...command,key:'invalid',expectedRevision:1,posting:{...command.posting,amount:0.5}},actor], [{...command,key:'stale'},actor], [{...command,tenant:x.foreign},{...actor,tenant:x.foreign}] ];
 let ticks=0;const results=[],responses=[],states=[];let inputPreserved=true;
 for(const [c,a] of attempts){const before=JSON.stringify([c,a]);const response=postAudited(store,c,a,audits,()=>++ticks);responses.push(response);results.push(response.status);inputPreserved&&=JSON.stringify([c,a])===before;states.push({writes:store.history().length,balance:store.read(x.tenant,x.id).balance,revision:store.read(x.tenant,x.id).revision,otherBalance:store.read(x.foreign,x.id).balance});}
 const snapshot=JSON.stringify(audits);command.requestId='changed';command.posting.amount=999;actor.credential='changed';
 return {results,responses,states,audits,ticks,inputPreserved,detached:JSON.stringify(audits)===snapshot};
}
function expected(x){return {results:[201,200,403,403,409,422,409,201],responses:[{status:201,transactionId:'txn-1',revision:1,committedAt:1},{status:200,transactionId:'txn-1',revision:1},{status:403},{status:403},{status:409},{status:422},{status:409},{status:201,transactionId:'txn-2',revision:1,committedAt:2}],states:[1,1,1,1,1,1,1,2].map((writes,i)=>({writes,balance:x.amount,revision:1,otherBalance:i===7?x.amount:0})),audits:[true,true,false,false,true,true,true,true].map((allowed,i)=>({operation:'post',tenant:i===7?x.foreign:x.tenant,decision:allowed?'allow':'deny',requestId:x.requestId})),ticks:2,inputPreserved:true,detached:true};}
function scenarioCode(x){return 'return ('+exercise.toString()+")(__load('persistence.ts').createStore,__load('audited-service.ts').postAudited,"+JSON.stringify(x)+');';}
const verifier=`'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const rows=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence/E05/audit-boundary.json'),'utf8'));
const exercise=${exercise.toString()};
let failures=0;for(const row of rows){let actual;try{actual=exercise(require('../src/persistence.ts').createStore,require('../src/audited-service.ts').postAudited,row.input);assert.deepEqual(actual,row.expected);}catch(e){failures++;if(process.argv.includes('--diagnose'))console.log(JSON.stringify({input:row.input,expected:row.expected,actual:actual??null,reason:e.message}));}}
console.log(JSON.stringify({phase:'E05-audit-boundary',cases:rows.length,failures}));if(failures)process.exitCode=1;
`;
function files(){return {'src/audited-service.ts':source,'tools/verify-audit.cjs':verifier,'evidence/E05/audit-boundary.json':JSON.stringify(inputs().map(input=>({input,expected:expected(input)})),null,2)+'\n','evidence/E05/audit-contract.json':JSON.stringify({signature:'postAudited(store,command,actor,audits,clock)',auditFields:['operation','tenant','decision','requestId'],normalResponses:'Append exactly one authorization decision for every normal response, including deny, replay, validation and conflict. Allow means access allowed, not committed.',state:'Delegate posting to service; denied/replayed/failed calls do not write. Clock runs only for new commits.',ownership:'Do not mutate command/actor; audit rows must be detached allowlisted copies. Unexpected thrown errors propagate without retry.'},null,2)+'\n'};}
module.exports={reference,source,inputs,exercise,expected,scenarioCode,files};
