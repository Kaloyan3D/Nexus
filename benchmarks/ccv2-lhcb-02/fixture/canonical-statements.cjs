'use strict';
const specs=[['E46','canonical-statements']];
function evaluate(x){
 const reject=status=>({status,entries:[],nextCursor:null});
 if(typeof x.tenant!=='string'||!x.tenant||typeof x.account!=='string'||!x.account||!Number.isSafeInteger(x.limit)||x.limit<1||x.limit>25)return reject(422);
 let cursor=null;
 if(x.cursor!==null){try{cursor=JSON.parse(x.cursor);}catch{return reject(422);}if(typeof x.cursor!=='string'||!Array.isArray(cursor)||cursor.length!==4||typeof cursor[0]!=='string'||typeof cursor[1]!=='string'||!Array.isArray(cursor[2])||cursor[2].some(k=>typeof k!=='string')||!Number.isSafeInteger(cursor[3])||cursor[3]<1)return reject(422);}
 const keys=[],entries=[],seen=new Set();
 for(const row of x.records){
  const j=row.journal,r=row.replay;let p;try{p=JSON.parse(r.fingerprint);}catch{return reject(409);}
  if(!j||!p||typeof p!=='object'||Array.isArray(p)||j.tenant!==x.tenant||j.state!=='committed'||j.checksum!=='valid'||typeof j.key!=='string'||!j.key||seen.has(j.key)||!Number.isSafeInteger(j.revision)||j.revision<1||!Number.isSafeInteger(j.balance)||!r.result||r.result.status!==201||r.result.revision!==j.revision||typeof r.result.transactionId!=='string'||!r.result.transactionId||!require('./domain.ts').evaluate(p).accepted)return reject(409);
  seen.add(j.key);keys.push(j.key);
  if(p.id===x.account)entries.push({key:j.key,posting:p,revision:j.revision,balance:j.balance,transactionId:r.result.transactionId});
 }
 if(!x.current||x.current.id!==x.account||!Number.isSafeInteger(x.current.balance)||!Number.isSafeInteger(x.current.revision)||x.current.revision<0)return reject(409);
 const last=entries.at(-1);if(last&&(last.revision!==x.current.revision||last.balance!==x.current.balance))return reject(409);
 if(cursor&&(cursor[0]!==x.tenant||cursor[1]!==x.account||JSON.stringify(cursor[2])!==JSON.stringify(keys)))return reject(409);
 const offset=cursor?cursor[3]:0;if(offset>entries.length)return reject(422);
 const end=Math.min(entries.length,offset+x.limit);
 return JSON.parse(JSON.stringify({status:200,account:x.current,entries:entries.slice(offset,end),nextCursor:end<entries.length?JSON.stringify([x.tenant,x.account,keys,end]):null}));
}
function execute(store,input,actor,clock){
 if(!require('./grants.ts').evaluate({actor,tenant:input.tenant,scope:'read',grant:input.grant}).allowed)return {status:403,entries:[],nextCursor:null};
 const journal=store.history().filter(row=>row.tenant===input.tenant),records=journal.map(row=>({journal:row,replay:store.replay(input.tenant,row.key)}));
 const result=evaluate({...input,records,current:store.read(input.tenant,input.account)});
 return result.status===200?{...result,at:clock()}:result;
}
function reference(){return evaluate.toString()+'\n'+execute.toString()+'\nmodule.exports={evaluate,execute};\n';}
// Independent host oracle uses parsed proof tables and a separate paging algorithm.
function expected(x){
 const error=status=>({status,entries:[],nextCursor:null});
 if(!x.tenant||typeof x.tenant!=='string'||!x.account||typeof x.account!=='string'||!Number.isSafeInteger(x.limit)||x.limit<=0||x.limit>25)return error(422);
 let c;
 if(x.cursor!==null){try{c=JSON.parse(x.cursor);}catch{return error(422);}if(typeof x.cursor!=='string'||!Array.isArray(c)||c.length!==4||typeof c[0]!=='string'||typeof c[1]!=='string'||!Array.isArray(c[2])||c[2].some(k=>typeof k!=='string')||!Number.isSafeInteger(c[3])||c[3]<=0)return error(422);}
 const table=[];const allKeys=[];
 for(const {journal:j,replay:r} of x.records){let posting;try{posting=JSON.parse(r.fingerprint);}catch{return error(409);}const result=r.result;
  if(!j||!posting||typeof posting!=='object'||Array.isArray(posting)||j.tenant!==x.tenant||j.state!=='committed'||j.checksum!=='valid'||typeof j.key!=='string'||!j.key||allKeys.includes(j.key)||!Number.isSafeInteger(j.revision)||j.revision<=0||!Number.isSafeInteger(j.balance)||!result||result.status!==201||result.revision!==j.revision||!result.transactionId||typeof result.transactionId!=='string'||!require('./create-fixture.cjs').oracle('E01',posting).accepted)return error(409);
  allKeys.push(j.key);if(posting.id===x.account)table.push({key:j.key,posting,revision:j.revision,balance:j.balance,transactionId:result.transactionId});
 }
 const a=x.current;if(!a||a.id!==x.account||!Number.isSafeInteger(a.balance)||!Number.isSafeInteger(a.revision)||a.revision<0)return error(409);
 if(table.length&&(table[table.length-1].revision!==a.revision||table[table.length-1].balance!==a.balance))return error(409);
 if(c&&(c[0]!==x.tenant||c[1]!==x.account||c[2].length!==allKeys.length||c[2].some((k,i)=>k!==allKeys[i])))return error(409);
 const start=c?c[3]:0;if(start>table.length)return error(422);
 const page=table.filter((_,i)=>i>=start&&i<start+x.limit),after=start+page.length;
 return structuredClone({status:200,account:a,entries:page,nextCursor:after<table.length?JSON.stringify([x.tenant,x.account,allKeys,after]):null});
}
function proof(tenant,key,id,amount,revision,balance,n){return {journal:{tenant,key,state:'committed',checksum:'valid',revision,balance},replay:{fingerprint:JSON.stringify({id,amount,currency:'JPY',kind:'adjustment'}),result:{status:201,transactionId:'txn-'+n,revision}}};}
function cases(id='E46',hidden=false){
 const account=hidden?'e\u0301':'__proto__',records=[proof('alpha','001',account,3,1,13,1),proof('alpha','other','other',2,1,2,2),proof('alpha','key/2',account,-2,2,11,3),proof('alpha','é',account,4,3,15,4)],current={id:account,balance:15,revision:3},x={tenant:'alpha',account,records,current,limit:1,cursor:null};
 const c=offset=>JSON.stringify(['alpha',account,records.map(r=>r.journal.key),offset]);
 const rows=[x,...['null','[]','7','"posting"'].map(fingerprint=>({...x,records:records.map((r,i)=>i===0?{...r,replay:{...r.replay,fingerprint}}:r)})),{...x,records:records.map((r,i)=>i===0?{...r,journal:null}:r)},{...x,limit:2},{...x,cursor:c(1)},{...x,cursor:c(2)},{...x,cursor:c(3)},{...x,limit:25},{...x,limit:0},{...x,limit:26},{...x,limit:1.5},{...x,cursor:'{'},{...x,cursor:'null'},{...x,cursor:JSON.stringify(['beta',account,records.map(r=>r.journal.key),1])},{...x,cursor:JSON.stringify(['alpha','other',records.map(r=>r.journal.key),1])},{...x,cursor:JSON.stringify(['alpha',account,['001'],1])},{...x,cursor:c(4)},{...x,account:''},{...x,records:[] ,current:{id:account,balance:10,revision:0}},{...x,current:{...current,balance:99}},{...x,records:records.map((r,i)=>i===0?{...r,replay:null}:r)},{...x,records:records.map((r,i)=>i===0?{...r,journal:{...r.journal,checksum:'invalid'}}:r)},{...x,records:records.map((r,i)=>i===0?{...r,replay:{...r.replay,fingerprint:'{'}}:r)},{...x,records:[...records,records[0]]}];
 return rows.map((input,i)=>({caseId:id+'-'+(hidden?'withheld':'public')+'-'+i,input,expected:expected(input)}));
}
// Same explicit action runner is released to the candidate; expected observations
// below are computed from independent host account/key/journal maps.
function runScenario(input,load){
 const original=JSON.stringify(input),store=load('persistence.ts').createStore(input.seed),observations=[],pages=[];
 for(const action of input.actions){let output,accessed=false,clockCalls=0;const clock=()=>{clockCalls++;return action.clock;};
  if(action.kind==='post')output=load('gateway.ts').dispatch(store,action.input,action.actor,clock,'api');
  else{
   const request=JSON.parse(JSON.stringify(action.input));if(action.cursorFrom!==undefined)request.cursor=pages[action.cursorFrom]?.nextCursor??null;
   const view={history(){accessed=true;return store.history();},read(t,id){accessed=true;return store.read(t,id);},replay(t,key){accessed=true;const r=store.replay(t,key);if(action.fault==='missing')return null;if(action.fault==='revision')return r?{...r,result:{...r.result,revision:99}}:r;return r;}};
   output=load('canonical-statements.ts').execute(view,request,action.actor,clock);pages.push(JSON.parse(JSON.stringify(output)));
   if(action.mutate&&output.status===200){if(output.entries.length){output.entries[0].posting.amount=999;output.entries[0].transactionId='changed';}output.account.balance=999;}
  }
  const recorded=action.kind==='read'?pages.at(-1):output;
  observations.push({output:recorded,accessed,clockCalls,accounts:input.ids.map(id=>store.read('alpha',id)),foreign:input.ids.map(id=>store.read('beta',id)),history:store.history()});
 }
 return {observations,inputPreserved:JSON.stringify(input)===original};
}
function scenarioCode(input){return 'const input=JSON.parse('+JSON.stringify(JSON.stringify(input))+');return ('+runScenario.toString()+')(input,__load);';}
function scenarioExpected(input){
 const accounts=new Map(input.seed.map(a=>[JSON.stringify(['alpha',a.id]),structuredClone(a)])),proofs=[],pages=[],observations=[];
 const read=(t,id)=>structuredClone(accounts.get(JSON.stringify([t,id]))??{id,balance:0,revision:0});
 for(const action of input.actions){const x=structuredClone(action.input),a=action.actor;let output,accessed=false;
  const allowed=a.tenant===x.tenant&&['owner','writer'].includes(a.role)&&!a.revoked&&x.grant.tenant===x.tenant&&!x.grant.revoked&&x.grant.scopes.includes(action.kind==='read'?'read':'post');
  if(action.kind==='post'){
   if(!allowed)output={status:403};else{
    const p=x.posting,prior=proofs.find(r=>r.journal.tenant===x.tenant&&r.journal.key===x.key),current=read(x.tenant,p.id);
    if(prior)output=prior.replay.fingerprint===JSON.stringify(p)?{...prior.replay.result,status:200}:{status:409};
    else if(current.revision!==x.expectedRevision)output={status:409};
    else{const next={id:p.id,balance:current.balance+p.amount,revision:current.revision+1},row=proof(x.tenant,x.key,p.id,p.amount,next.revision,next.balance,proofs.length+1);row.replay.fingerprint=JSON.stringify(p);proofs.push(row);accounts.set(JSON.stringify([x.tenant,p.id]),next);output={...row.replay.result,committedAt:action.clock};}
   }
  }else{
   if(action.cursorFrom!==undefined)x.cursor=pages[action.cursorFrom]?.nextCursor??null;
   if(!allowed)output={status:403,entries:[],nextCursor:null};else{
    accessed=true;const records=structuredClone(proofs.filter(r=>r.journal.tenant===x.tenant));for(const r of records){if(action.fault==='missing')r.replay=null;if(action.fault==='revision')r.replay.result.revision=99;}
    output=expected({...x,records,current:read(x.tenant,x.account)});if(output.status===200)output.at=action.clock;
   }pages.push(structuredClone(output));
  }
  observations.push(structuredClone({output,accessed,clockCalls:action.kind==='read'?(output.status===200?1:0):(output.status===201?1:0),accounts:input.ids.map(id=>read('alpha',id)),foreign:input.ids.map(id=>read('beta',id)),history:proofs.map(r=>r.journal)}));
 }
 return {observations,inputPreserved:true};
}
function executions(id='E46',hidden=false){
 const account=hidden?'e\u0301':'__proto__',other=hidden?'é':'001',ids=[account,other],seed=[{id:account,balance:10,revision:0},{id:other,balance:0,revision:0}],actor={tenant:'alpha',role:'owner',revoked:false},grant={tenant:'alpha',scopes:['post','read'],revoked:false};
 const post=(key,id,amount,revision,tenant='alpha')=>({kind:'post',actor:{...actor,tenant},clock:17,input:{tenant,key,expectedRevision:revision,grant:{...grant,tenant},requestId:key,posting:{id,amount,currency:'JPY',kind:'adjustment'}}});
 const read=(extras={},who=actor,opts={})=>({kind:'read',actor:who,clock:23,input:{tenant:'alpha',account,limit:1,cursor:null,grant,...extras},...opts});
 const prefix=[post('001',account,3,0),post('other',other,2,0),post('key/2',account,-2,1),post('é',account,4,2)];
 const sequences=[
 [...prefix,read(),read({},actor,{cursorFrom:0}),read({},actor,{cursorFrom:1}),read({limit:25}),read({},actor,{mutate:true}),read({limit:25})],
 [...prefix,read(),post('beta-key',account,9,0,'beta'),read({},actor,{cursorFrom:0}),post('append',account,1,3),read({},actor,{cursorFrom:0}),read({limit:25})],
 [...prefix,read(),read({cursor:'{'},{...actor,revoked:true}),read({cursor:'{'},{...actor,tenant:'beta'}),read({grant:{...grant,revoked:true}}),read({grant:{...grant,scopes:['post']}}),read({}, {...actor,role:'reader'})],
 [...prefix,read({},actor,{fault:'missing'}),read({},actor,{fault:'revision'}),read({records:[],current:{id:account,balance:0,revision:0},limit:25})],
 [read(),post('001',account,3,0),post('001',account,3,97),post('001',account,4,1),read()],
 [...prefix,read({account:other}),read({account:'absent'}),read({limit:0}),read({limit:26}),read({cursor:'null'}),read({cursor:JSON.stringify(['beta',account,['001','other','key/2','é'],1])})]
 ];
 return sequences.map((actions,i)=>{const input={seed,ids,actions};return {caseId:id+'-execution-'+(hidden?'withheld':'public')+'-'+i,input,expected:scenarioExpected(input)};});
}
const contract=`Implement evaluate(input) and execute(store,input,actor,clock). evaluate receives tenant, account, limit (safe integer1..25), cursor (null or JSON string), records (tenant journal/replay proof pairs), current (canonical account row). Reject malformed tenant/account/limit/cursor with {status:422,entries:[],nextCursor:null}. Cursor is JSON.stringify([tenant,account,allTenantJournalKeys,offset]); exactly four fields, string tenant/account, string key array, positive safe integer offset. Different cursor tenant/account/key vector =>409; offset beyond matching account entry count =>422. null starts at0. Validate EVERY tenant proof before paging: committed/valid journal, nonempty unique opaque key, positive safe integer revision, safe integer balance, parsable domain-valid posting fingerprint, replay result status201, matching revision and nonempty transactionId. Invalid/missing proof=>409, same empty rejection shape. current has exact account ID, safe balance/nonnegative revision; last matching journal balance/revision equals current. Filter posting.id===account, preserve append order. Success {status:200,account:current,entries:[{key,posting,revision,balance,transactionId}],nextCursor}; nextCursor encodes complete tenant key vector and next offset only if more matching entries remain. Deep-copy account and posting objects. Empty result succeeds with nextCursor:null. Opaque IDs/key strings are exact; never normalize/sort them.
execute FIRST calls grants.evaluate({actor,tenant:input.tenant,scope:'read',grant:input.grant}); denial=>{status:403,entries:[],nextCursor:null}, with ZERO store reads and no clock call. After permission use store.history(), filter tenant before store.replay(tenant,key), and store.read(tenant,account), then evaluate actual proof rows/current, IGNORING caller records/current. Success adds at:clock(); failure does not call clock or add at. No writes, cache, alternate journal or canonical receipt mutation. A same-tenant append (even another account) invalidates cursor; foreign-tenant appends do not. Dependency exceptions propagate. Inspect execution.jsonl: cursorFrom refers to a prior READ output, not action index. The verifier mutates returned nested values and then rereads canonical state to detect live references. Existing canonical gateway/batch and grants own writes/authorization. Add regressions in src only.`;
function phaseFiles(id='E46'){
 const files={'src/canonical-statements.ts':'// Draft statement delivery trusts caller rows and ignores canonical proof identity.\nfunction evaluate(input:any){return {status:200,entries:input.records||[],nextCursor:null};}\nfunction execute(store:any,input:any,actor:any,clock:()=>number){return evaluate(input);}\nmodule.exports={evaluate,execute};\n',
 ['evidence/'+id+'/cases.jsonl']:cases(id).map(JSON.stringify).join('\n')+'\n',
 ['evidence/'+id+'/execution.jsonl']:executions(id).map(JSON.stringify).join('\n')+'\n',
 ['evidence/'+id+'/contract.md']:'# Canonical statement delivery\n'+contract+'\n',
 ['evidence/'+id+'/incident.json']:JSON.stringify({phase:id,component:'canonical-statements',symptom:'caller-supplied history leaks tenant data and stale cursors skip canonical entries',source:'src/canonical-statements.ts',reproduce:'node tools/verify-canonical-statements.cjs --diagnose',caseCount:cases(id).length,executionCount:executions(id).length},null,2)+'\n'};
 files['tools/verify-canonical-statements.cjs']=`'use strict';const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),load=name=>require(path.join(__dirname,'../src',name));const rows=kind=>fs.readFileSync(path.join(__dirname,'../evidence/E46',kind+'.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);let failures=0,shown=0;const check=(row,fn)=>{let actual;try{actual=fn();assert.deepEqual(actual,row.expected);}catch(e){failures++;if(process.argv.includes('--diagnose')&&shown++<8)console.log(JSON.stringify({caseId:row.caseId,expected:row.expected,actual:actual??null,error:e.message}));}};for(const row of rows('cases'))check(row,()=>{const before=JSON.stringify(row.input),actual=load('canonical-statements.ts').evaluate(row.input);assert.equal(JSON.stringify(row.input),before);return actual;});const run=${runScenario.toString()};for(const row of rows('execution'))check(row,()=>run(row.input,load));console.log(JSON.stringify({phase:'E46',failures,status:failures?'FAIL':'PASS'}));process.exitCode=failures?1:0;\n`;
 return files;
}
module.exports={specs,reference,expected,cases,executions,scenarioCode,scenarioExpected,phaseFiles};
