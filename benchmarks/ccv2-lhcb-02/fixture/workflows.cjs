'use strict';
// Finite business workflows. Reference consumers are never released to a live candidate.
const specs=[['E43','settlement'],['E44','reversal'],['E45','statement-close']];
function settlementPlan(x){
 const bad=()=>({status:422,postings:[],source:null,cost:0});
 const m=require('./migrations.ts').evaluate({document:x.document});
 if(m.rejected||m.records.length!==1)return bad();const p=m.records[0];
 if(p.kind!=='transfer'||p.amount<=0||typeof x.key!=='string'||!x.key)return bad();
 const fee=require('./fee-schedule.ts').evaluate({amount:p.amount,currency:p.currency,kind:'transfer',tiers:x.tiers,cap:x.cap});
 if(fee.status!==200)return bad();
 const split=require('./allocations.ts').evaluate({amount:fee.net,weights:x.weights});if(split.status!==200)return bad();
 const ids=[p.id,x.feeAccount,...split.allocations.map(r=>r.id)];
 if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)return bad();
 const postings=[{id:p.id,amount:-p.amount,currency:p.currency,kind:'adjustment'},
 {id:x.feeAccount,amount:fee.fee,currency:p.currency,kind:'adjustment'},
 ...split.allocations.map(r=>({id:r.id,amount:r.amount,currency:p.currency,kind:'adjustment'}))];
 if(!postings.every(p=>require('./domain.ts').evaluate(p).accepted))return bad();
 return {status:200,postings,source:p.id,cost:p.amount};
}
function reversalPlan(x){
 const bad=()=>({status:422,postings:[],source:null,cost:0});const r=x.receipt;
 if(!r||r.status!==200||typeof x.key!=='string'||!x.key||!r.postings.length)return bad();
 const ids=new Set();let total=0n;
 for(const p of r.postings){if(ids.has(p.id)||p.kind!=='adjustment'||!require('./domain.ts').evaluate(p).accepted)return bad();ids.add(p.id);total+=BigInt(p.amount);}
 if(total!==0n||new Set(r.postings.map(p=>p.currency)).size!==1||!ids.has(r.source))return bad();
 return {status:200,postings:r.postings.map(p=>({...p,amount:p.amount===0?0:-p.amount})),source:r.source,cost:0};
}
function publish(store,x,actor,clock,plan){
 const empty=status=>({status,postings:[],results:[],at:null});
 if(!require('./grants.ts').evaluate({actor,tenant:x.tenant,scope:'post',grant:x.grant}).allowed)return empty(403);
 if(plan.status!==200)return empty(422);
 const commands=plan.postings.map((posting,i)=>({key:JSON.stringify([x.key,i]),posting,expectedRevision:x.expectedRevisions[i]}));
 const prior=commands.map(c=>store.replay(x.tenant,c.key));
 if(prior.some(Boolean)){
  if(!prior.every((r,i)=>r&&r.fingerprint===JSON.stringify(commands[i].posting)))return empty(409);
  return {status:200,postings:plan.postings.map(p=>({...p})),results:prior.map(r=>({...r.result})),at:null};
 }
 if(!require('./cancellation.ts').evaluate({cancelAt:x.cancelAt,state:'prepared',key:x.key}).commit)return empty(422);
 // Balanced net zero must not bypass gross source or recipient funding constraints.
 for(const p of plan.postings)if(p.amount<0&&!require('./reservations.ts').evaluate({balance:store.read(x.tenant,p.id).balance,holds:x.holds.filter(h=>h.account===p.id),amount:-p.amount}).allowed)return empty(409);
 try{
  const result=require('./batch.ts').apply(store,commands,actor,clock,{tenant:x.tenant,account:plan.source,cost:plan.cost,holds:[],grant:x.grant,cancelAt:x.cancelAt});
  if(result.status!==201)return empty(result.status);
  return {status:201,postings:plan.postings.map(p=>({...p})),results:result.results.map(r=>({...r})),at:clock()};
 }catch(e){if(['revision-conflict','duplicate-commit'].includes(e.message))return empty(409);if(e.message==='balance-overflow')return empty(422);throw e;}
}
function settle(store,x,actor,clock){
 // Grant first even for invalid input or replay. No original object is changed.
 if(!require('./grants.ts').evaluate({actor,tenant:x.tenant,scope:'post',grant:x.grant}).allowed)return {status:403,postings:[],results:[],at:null};
 return publish(store,x,actor,clock,evaluate(x));
}
function reverse(store,x,actor,clock){
 const empty=status=>({status,postings:[],results:[],at:null});
 if(!require('./grants.ts').evaluate({actor,tenant:x.tenant,scope:'post',grant:x.grant}).allowed)return empty(403);
 const plan=evaluate(x);if(plan.status!==200)return empty(422);
 // A receipt alone is not authority: each original command must exist in this tenant.
 for(let i=0;i<x.receipt.postings.length;i++){
  const cached=store.replay(x.tenant,JSON.stringify([x.originalKey,i]));
  if(!cached||cached.fingerprint!==JSON.stringify(x.receipt.postings[i]))return empty(409);
 }
 return publish(store,x,actor,clock,plan);
}
function statementPlan(x){
 const exported=require('./exporter.ts').evaluate({format:x.reader===1?'v1':'v3',records:x.accounts.map(a=>({id:a.id,amount:a.balance,currency:x.currency,kind:'adjustment'}))});
 const rollback=require('./rollback.ts').evaluate({document:x.document,reader:x.reader});
 const closing=x.accounts.map(a=>require('./closing-state.ts').evaluate({tenant:x.tenant,state:'active',balance:a.balance,holds:x.holds.filter(h=>h.account===a.id),actions:[{op:'freeze',actor:x.actor},{op:'close',actor:x.actor}]}));
 const reconciled=x.accounts.map(a=>require('./reconcile.ts').evaluate({opening:x.opening.find(r=>r.id===a.id)?.balance??0,postings:x.postings.filter(p=>p.id===a.id).map(p=>p.amount),closing:a.balance,journalCount:x.journalCount,auditCount:x.auditCount}));
 const ready=!rollback.rejected&&closing.every(c=>c.state==='closed')&&reconciled.every(r=>r.balanced&&r.auditAligned);
 return {status:ready?200:409,ready,accounts:x.accounts.map(a=>({...a})),exported,rollback,closing};
}
function close(store,x,actor,clock){
 if(!require('./grants.ts').evaluate({actor,tenant:x.tenant,scope:'post',grant:x.grant}).allowed)return {status:403};
 const result=evaluate({...x,actor,accounts:x.opening.map(a=>store.read(x.tenant,a.id)),journalCount:store.history().filter(r=>r.tenant===x.tenant).length});
 return {...result,at:clock()};
}
function reference(name){
 if(name==='settlement')return settlementPlan.toString().replace('function settlementPlan','function evaluate')+'\n'+publish.toString()+'\n'+settle.toString()+'\nmodule.exports={evaluate,execute:settle};\n';
 if(name==='reversal')return reversalPlan.toString().replace('function reversalPlan','function evaluate')+'\n'+publish.toString()+'\n'+reverse.toString()+'\nmodule.exports={evaluate,execute:reverse};\n';
 if(name==='statement-close')return statementPlan.toString().replace('function statementPlan','function evaluate')+'\n'+close.toString()+'\nmodule.exports={evaluate,execute:close};\n';
 throw Error('workflow-name');
}
// Independent host plans use host-owned migration contract and integer arithmetic.
function expected(name,x){
 const bad={status:422,postings:[],source:null,cost:0};
 if(name==='settlement'){
  const migrated=require('./create-fixture.cjs').oracle('E02',{document:x.document});if(migrated.rejected||migrated.records.length!==1)return bad;
  const p=migrated.records[0];if(p.kind!=='transfer'||p.amount<=0||typeof x.key!=='string'||!x.key||!x.tiers.length||x.cap!==null&&(!Number.isSafeInteger(x.cap)||x.cap<0))return bad;
  let start=0,fee=0n;for(const t of x.tiers){if(!Number.isSafeInteger(t.upTo)||t.upTo<=start||!Number.isSafeInteger(t.bps)||t.bps<0||t.bps>10000)return bad;const base=Math.max(0,Math.min(p.amount,t.upTo)-start);fee+=BigInt(base)*BigInt(t.bps)/10000n;start=t.upTo;}if(p.amount>start)return bad;if(x.cap!==null&&fee>BigInt(x.cap))fee=BigInt(x.cap);
  const seen=new Set([p.id,x.feeAccount]);if(typeof x.feeAccount!=='string'||!x.feeAccount||seen.size!==2||!x.weights.length)return bad;
  let den=0n;for(const w of x.weights){if(typeof w.id!=='string'||!w.id||seen.has(w.id)||!Number.isSafeInteger(w.weight)||w.weight<=0)return bad;seen.add(w.id);den+=BigInt(w.weight);}
  const net=BigInt(p.amount)-fee,parts=x.weights.map((w,i)=>({id:w.id,index:i,amount:net*BigInt(w.weight)/den,rem:net*BigInt(w.weight)%den}));
  let left=net-parts.reduce((s,p)=>s+p.amount,0n);for(const p of [...parts].sort((a,b)=>a.rem===b.rem?a.index-b.index:a.rem>b.rem?-1:1)){if(left===0n)break;p.amount++;left--;}
  return {status:200,postings:[{id:p.id,amount:-p.amount,currency:p.currency,kind:'adjustment'},{id:x.feeAccount,amount:Number(fee),currency:p.currency,kind:'adjustment'},...parts.map(r=>({id:r.id,amount:Number(r.amount),currency:p.currency,kind:'adjustment'}))],source:p.id,cost:p.amount};
 }
 if(name==='reversal'){
  const r=x.receipt;if(!r||r.status!==200||typeof x.key!=='string'||!x.key||!r.postings.length)return bad;
  if(new Set(r.postings.map(p=>p.id)).size!==r.postings.length||r.postings.some(p=>p.kind!=='adjustment'||!require('./create-fixture.cjs').oracle('E01',p).accepted)||r.postings.reduce((s,p)=>s+BigInt(p.amount),0n)!==0n||new Set(r.postings.map(p=>p.currency)).size!==1||!r.postings.some(p=>p.id===r.source))return bad;
  return {status:200,postings:r.postings.map(p=>({...p,amount:p.amount===0?0:-p.amount})),source:r.source,cost:0};
 }
 const exported=x.reader===1?{version:1,entries:x.accounts.map(a=>({id:a.id,cents:a.balance,currency:x.currency,kind:'adjustment'}))}:{version:3,records:x.accounts.map(a=>({id:a.id,amount:a.balance,currency:x.currency,kind:'adjustment'}))};
 const rollback=require('./late.cjs').expected('rollback',{document:x.document,reader:x.reader});
 const closing=x.accounts.map(a=>require('./extensions.cjs').functions['closing-state']({tenant:x.tenant,state:'active',balance:a.balance,holds:x.holds.filter(h=>h.account===a.id),actions:[{op:'freeze',actor:x.actor},{op:'close',actor:x.actor}]}));
 const balanced=x.accounts.every(a=>BigInt(x.opening.find(r=>r.id===a.id)?.balance??0)+x.postings.filter(p=>p.id===a.id).reduce((s,p)=>s+BigInt(p.amount),0n)===BigInt(a.balance));
 const ready=!rollback.rejected&&closing.every(c=>c.state==='closed')&&balanced&&x.journalCount===x.auditCount;
 return {status:ready?200:409,ready,accounts:x.accounts,exported,rollback,closing};
}
function settlementInput(hidden=false){const source=hidden?'e\u0301':'001';return {tenant:'alpha',key:hidden?'opaque/replay':'__proto__',document:{version:1,entries:[{id:source,cents:hidden?113:101,currency:hidden?'KWD':'JPY',kind:'transfer'}],writerRevision:17,metadata:{original:'retained'}},feeAccount:'fee',weights:[{id:'merchant/a',weight:1},{id:'merchant/b',weight:1}],tiers:[{upTo:200,bps:100}],cap:null,expectedRevisions:[0,0,0,0],holds:[],cancelAt:'none',grant:{tenant:'alpha',scopes:['post'],revoked:false}};}
function inputs(id,hidden=false){
 const s=settlementInput(hidden),plan=expected('settlement',s);let rows;
 if(id==='E43')rows=[s,{...s,cap:0},{...s,weights:[{id:'merchant/a',weight:7},{id:'merchant/b',weight:3}]},{...s,document:{...s.document,version:93}},{...s,feeAccount:plan.source},{...s,weights:[{id:'merchant/a',weight:1},{id:'merchant/a',weight:2}]},{...s,tiers:[{upTo:200,bps:10001}]}];
 else if(id==='E44'){const x={tenant:'alpha',key:'undo',originalKey:s.key,receipt:plan,expectedRevisions:[1,1,1,1],holds:[],cancelAt:'none',grant:s.grant};rows=[x,{...x,receipt:{...plan,postings:plan.postings.map((p,i)=>i===0?{...p,amount:p.amount+1}:p)}},{...x,receipt:{...plan,postings:[...plan.postings,plan.postings[0]]}},{...x,receipt:{...plan,status:422}},{...x,key:''}];}
 else if(id==='E45'){const actor={tenant:'alpha',role:'owner',revoked:false},accounts=plan.postings.map(p=>({id:p.id,balance:0,revision:2})),x={tenant:'alpha',document:s.document,currency:plan.postings[0].currency,reader:1,actor,accounts,opening:accounts.map(a=>({...a,revision:0})),postings:[],journalCount:8,auditCount:8,holds:[]};rows=[x,{...x,reader:3},{...x,reader:2},{...x,auditCount:7},{...x,accounts:accounts.map((a,i)=>i===0?{...a,balance:1}:a)},{...x,actor:{...actor,role:'writer'}},{...x,holds:[{account:accounts[0].id,state:'active',amount:1}]}];}
 else throw Error('workflow-phase');
 return rows;
}
function cases(id,hidden=false){const name=specs.find(s=>s[0]===id)[1];return inputs(id,hidden).map((input,i)=>({caseId:id+'-'+(hidden?'withheld-':'public-')+i,input,expected:expected(name,input)}));}
function scenarioCode(input){return `
 const input=JSON.parse(${JSON.stringify(JSON.stringify(input))}),original=JSON.stringify(input);
 const store=__load('persistence.ts').createStore(input.seed);
 const observations=input.actions.map(a=>{
  const output=a.module==='gateway'?__load('gateway.ts').dispatch(store,a.input,a.actor,()=>a.clock,'api'):__load(a.module+'.ts').execute(store,a.input,a.actor,()=>a.clock);
  return {output,accounts:input.ids.map(id=>store.read('alpha',id)),foreign:input.ids.map(id=>store.read('beta',id)),history:store.history()};
 });return {observations,inputPreserved:JSON.stringify(input)===original};
`;}
function scenarioExpected(input){
 const accounts=new Map(input.seed.map(a=>[a.id,{...a}])),keys=new Map(),history=[],observations=[];
 const account=id=>accounts.get(id)||{id,balance:0,revision:0};
 const empty=status=>({status,postings:[],results:[],at:null});
 for(const a of input.actions){const x=a.input,actor=a.actor;let output;
  const allowed=actor.tenant===x.tenant&&['owner','writer'].includes(actor.role)&&!actor.revoked&&x.grant.tenant===x.tenant&&!x.grant.revoked&&x.grant.scopes.includes('post');
  if(a.module==='statement-close'){
   if(!allowed)output={status:403};else output={...expected('statement-close',{...x,actor,accounts:x.opening.map(r=>account(r.id)),journalCount:history.filter(r=>r.tenant===x.tenant).length}),at:a.clock};
  }else if(a.module==='gateway'){
   if(!allowed)output={status:403};else {
    const p=x.posting,k=JSON.stringify([x.tenant,x.key]),r=keys.get(k),current=account(p.id);
    if(r)output=r.fingerprint===JSON.stringify(p)?{...r.result,status:200}:{status:409};
    else if(current.revision!==x.expectedRevision)output={status:409};
    else {const next={id:p.id,balance:current.balance+p.amount,revision:current.revision+1},result={status:201,transactionId:'txn-'+(history.length+1),revision:next.revision};accounts.set(p.id,next);history.push({tenant:x.tenant,key:x.key,state:'committed',checksum:'valid',revision:next.revision,balance:next.balance});keys.set(k,{fingerprint:JSON.stringify(p),result});output={...result,committedAt:a.clock};}
   }
  }else {
   const plan=expected(a.module,x);output=empty(allowed?422:403);
   if(allowed&&plan.status===200){
    const originalValid=a.module!=='reversal'||x.receipt.postings.every((p,i)=>keys.get(JSON.stringify([x.tenant,JSON.stringify([x.originalKey,i])]))?.fingerprint===JSON.stringify(p));
    const k=plan.postings.map((_,i)=>JSON.stringify([x.tenant,JSON.stringify([x.key,i])])),prior=k.map(key=>keys.get(key));
    if(!originalValid)output=empty(409);
    else if(prior.some(Boolean))output=prior.every((r,i)=>r?.fingerprint===JSON.stringify(plan.postings[i]))?{status:200,postings:plan.postings,results:prior.map(r=>({...r.result})),at:null}:empty(409);
    else if(x.cancelAt==='before-commit')output=empty(422);
    else if(plan.postings.some(p=>p.amount<0&&-p.amount>account(p.id).balance-x.holds.filter(h=>h.account===p.id&&h.state==='active').reduce((s,h)=>s+h.amount,0)))output=empty(409);
    else if(plan.postings.some((p,i)=>account(p.id).revision!==x.expectedRevisions[i]))output=empty(409);
    else if(plan.postings.some(p=>!Number.isSafeInteger(account(p.id).balance+p.amount)))output=empty(422);
    else {const results=plan.postings.map((p,i)=>{const current=account(p.id),next={id:p.id,balance:current.balance+p.amount,revision:current.revision+1},result={status:201,transactionId:'txn-'+(history.length+1),revision:next.revision};accounts.set(p.id,next);history.push({tenant:x.tenant,key:JSON.stringify([x.key,i]),state:'committed',checksum:'valid',revision:next.revision,balance:next.balance});keys.set(k[i],{fingerprint:JSON.stringify(p),result});return result;});output={status:201,postings:plan.postings,results,at:a.clock};}
   }
  }
  observations.push(JSON.parse(JSON.stringify({output,accounts:input.ids.map(id=>account(id)),foreign:input.ids.map(id=>({id,balance:0,revision:0})),history})));
 }
 return {observations,inputPreserved:true};
}
function executions(id,hidden=false){
 const s=settlementInput(hidden),plan=expected('settlement',s),ids=plan.postings.map(p=>p.id),seed=ids.map((id,i)=>({id,balance:i===0?plan.cost:0,revision:0})),actor={tenant:'alpha',role:'owner',revoked:false};
 const action=(module,input,who=actor,clock=17)=>({module,input,actor:who,clock});
 const base=actions=>({seed,ids,actions});let rows=[];
 if(id==='E43'){
  rows=[base([action('settlement',s),action('settlement',{...s,expectedRevisions:[97,97,97,97],holds:[{account:ids[0],amount:1,state:'active'}],cancelAt:'before-commit'},actor,23),action('settlement',s,{...actor,revoked:true}),action('settlement',s,{...actor,tenant:'beta'}),action('settlement',{...s,cap:0})]),base([action('settlement',{...s,expectedRevisions:[0,0,0,1]})]),base([action('settlement',{...s,holds:[{account:ids[0],amount:1,state:'active'}]})]),base([action('settlement',{...s,cancelAt:'before-commit'})]),{...base([action('settlement',s)]),seed:seed.map((a,i)=>i===3?{...a,balance:Number.MAX_SAFE_INTEGER}:a)}];
 }else {
  const reverse={tenant:s.tenant,key:'undo',originalKey:s.key,receipt:plan,expectedRevisions:[1,1,1,1],holds:[],cancelAt:'none',grant:s.grant};
  if(id==='E44')rows=[base([action('settlement',s),action('reversal',reverse),action('reversal',{...reverse,expectedRevisions:[97,97,97,97],cancelAt:'before-commit'}),action('reversal',reverse,{...actor,revoked:true}),action('reversal',reverse,{...actor,tenant:'beta'})]),base([action('reversal',reverse)]),base([action('settlement',s),action('reversal',{...reverse,originalKey:'forged'})]),base([action('settlement',s),action('reversal',{...reverse,expectedRevisions:[1,1,1,2]})]),base([action('settlement',s),action('reversal',{...reverse,holds:[{account:ids[2],state:'active',amount:1}]})])];
  else {
   const withdrawal={tenant:'alpha',key:'close/debit',expectedRevision:2,requestId:'close',grant:s.grant,posting:{id:ids[0],amount:-plan.cost,currency:plan.postings[0].currency,kind:'adjustment'}};
   const changes=[...plan.postings,...expected('reversal',reverse).postings,withdrawal.posting];
   const statement={tenant:'alpha',grant:s.grant,document:s.document,currency:plan.postings[0].currency,reader:1,opening:seed,postings:changes,auditCount:9,holds:[]};
   const prefix=[action('settlement',s),action('reversal',reverse),action('gateway',withdrawal)];
   rows=[base([...prefix,action('statement-close',statement),action('statement-close',{...statement,reader:3},actor,23),action('statement-close',statement,{...actor,revoked:true})]),base([...prefix,action('statement-close',{...statement,auditCount:8})]),base([...prefix,action('statement-close',{...statement,reader:2})]),base([...prefix,action('statement-close',{...statement,holds:[{account:ids[0],amount:1,state:'active'}]})]),base([...prefix,action('statement-close',statement,{...actor,role:'writer'})]),base([action('settlement',s),action('statement-close',{...statement,postings:plan.postings,auditCount:4})])];
  }
 }
 return rows.map((input,i)=>({caseId:id+'-execution-'+(hidden?'withheld-':'public-')+i,input,expected:scenarioExpected(input)}));
}
const contracts={
 settlement:`evaluate(input) migrates exactly one positive transfer from input.document, computes fee using fee-schedule({amount,currency,kind:'transfer',tiers,cap}), then largest-remainder allocations of net with input.weights. Source, feeAccount and recipient IDs must be nonempty and distinct. Return {status:200,postings,source,cost}, ordered source debit, fee credit, recipient credits, all kind adjustment (including zero credits). Rejection: {status:422,postings:[],source:null,cost:0}. key must be a nonempty opaque string. No input mutation.`,
 reversal:`evaluate(input) accepts receipt {status:200,postings,source,cost} from the settlement plan, with distinct domain-valid adjustment postings of one currency summing exactly zero, containing source. key must be a nonempty opaque string. Negate each amount (zero remains zero), retain order/IDs/currency/kind; return {status:200,postings,source:receipt.source,cost:0}. Reject malformed receipt using the settlement rejection shape. Original fees and allocation are reversed exactly; never recalculate current fees. execute additionally proves each originalKey posting exists in this tenant's canonical replay map before any reversal, including reversal replay.`,
 'statement-close':`evaluate(input) receives opening, accounts (actual current rows), postings (all receipted signed movements), journalCount, auditCount, actor, tenant, holds, document, reader, currency. Each account must reconcile opening balance plus its postings to current balance; journalCount equals auditCount. For each account call closing-state with active state, its balance and holds, freeze then close actions by actor. ready only if every state is closed and rollback accepts reader. Export current balances as adjustment records through exporter (reader1 uses v1, otherwise v3); rollback keeps original document and metadata. Return {status:ready?200:409,ready,accounts,exported,rollback,closing}. execute reads current accounts in opening order and tenant journalCount from canonical store; it passes actor, preserves all caller inputs, and adds at:clock(). It is a read-only close receipt: no ledger or canonical document mutation.`
};
const executionContract=`execute(store,input,actor,clock) uses the existing canonical persistence store; inputs are JSON, clock is injected. All executions require grants({actor,tenant,scope:'post',grant}) before replay. Settlement/reversal return {status,postings,results,at}; denied/conflict/invalid returns empty arrays and at:null. Per-posting keys are JSON.stringify([input.key,index]), fingerprints JSON.stringify(posting). All matching cached postings replay with status200, original result copies and at:null BEFORE current revisions, holds or cancellation. Partial or changed cache conflicts409. New pre-commit cancellation rejects422. Every debit separately checks reservations against its actual account and holds filtered by account; insufficient gross funding conflicts409 even though a balanced batch sums zero. Existing batch.apply owns atomic publication with commands {key,posting,expectedRevision:input.expectedRevisions[index]} and context {tenant,account:plan.source,cost:plan.cost,holds:[],grant,cancelAt}. revision-conflict/duplicate-commit =>409, balance-overflow =>422, unknown errors propagate. New success201 uses copied batch results, plan postings and injected at. No alternate writer, receipt cache or mutation of original receipts. Statement authorization denial is {status:403}. Inspect execution.jsonl for complete sequential callers and exact actual state observations. Model-created regression tests may live in src only.`;
function phaseFiles(id){
 const name=specs.find(s=>s[0]===id)?.[1];if(!name)throw Error('workflow-phase');
 const rows=cases(id),runs=executions(id);
 const files={['src/'+name+'.ts']:`// ${name}: current local draft has no canonical execution path.\nfunction evaluate(input:any){return {status:200};}\nfunction execute(store:any,input:any,actor:any,clock:()=>number){return {status:201};}\nmodule.exports={evaluate,execute};\n`,['evidence/'+id+'/cases.jsonl']:rows.map(JSON.stringify).join('\n')+'\n',['evidence/'+id+'/execution.jsonl']:runs.map(JSON.stringify).join('\n')+'\n',['evidence/'+id+'/contract.md']:'# '+name+'\n'+contracts[name]+'\n\n'+executionContract+'\n',['evidence/'+id+'/incident.json']:JSON.stringify({phase:id,component:name,symptom:'local report claims success without canonical ledger changes or durable response identity',source:'src/'+name+'.ts',reproduce:'node tools/verify-workflows.cjs '+id+' --diagnose',caseCount:rows.length,executionCount:runs.length},null,2)+'\n'};
 if(id==='E43')files['tools/verify-workflows.cjs']=`'use strict';const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const mapping=${JSON.stringify(Object.fromEntries(specs))},phase=process.argv[2],__load=name=>require(path.join(__dirname,'../src',name));const rows=kind=>fs.readFileSync(path.join(__dirname,'../evidence',phase,kind+'.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);let failures=0,shown=0;const check=(row,fn)=>{let actual;try{actual=fn();assert.deepEqual(actual,row.expected);}catch(e){failures++;if(process.argv.includes('--diagnose')&&shown++<8)console.log(JSON.stringify({caseId:row.caseId,expected:row.expected,actual:actual??null,error:e.message}));}};for(const row of rows('cases'))check(row,()=>{const before=JSON.stringify(row.input),actual=__load(mapping[phase]+'.ts').evaluate(row.input);assert.equal(JSON.stringify(row.input),before);return actual;});for(const row of rows('execution'))check(row,()=>{const input=row.input,original=JSON.stringify(input),store=__load('persistence.ts').createStore(input.seed);const observations=input.actions.map(a=>{const output=a.module==='gateway'?__load('gateway.ts').dispatch(store,a.input,a.actor,()=>a.clock,'api'):__load(a.module+'.ts').execute(store,a.input,a.actor,()=>a.clock);return {output,accounts:input.ids.map(id=>store.read('alpha',id)),foreign:input.ids.map(id=>store.read('beta',id)),history:store.history()};});return {observations,inputPreserved:JSON.stringify(input)===original};});console.log(JSON.stringify({phase,failures,status:failures?'FAIL':'PASS'}));process.exitCode=failures?1:0;\n`;
 return files;
}
module.exports={specs,reference,expected,inputs,cases,executions,scenarioCode,scenarioExpected,phaseFiles};
