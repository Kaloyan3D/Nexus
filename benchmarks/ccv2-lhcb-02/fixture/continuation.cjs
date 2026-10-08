'use strict';
// Finite dependent business consumers. References stay on the grading host.
const specs=[['E47','balance-proof'],['E48','settlement-preview'],['E49','dispute-proof'],['E50','statement-cut'],['E51','scheduled-preview'],['E52','recovery-export'],['E53','closing-evidence'],['E54','release-proof']];
const fail=status=>({status,details:null});
const copy=x=>JSON.parse(JSON.stringify(x));
function balanceProof(x){
 const accounts=[],keys=x.records.map(r=>r.journal?.key);
 if(!Array.isArray(x.ids)||!x.ids.length||x.ids.length>16||x.ids.some(id=>typeof id!=='string'||!id)||new Set(x.ids).size!==x.ids.length)return fail(422);
 for(const id of x.ids){
  const current=x.accounts.find(a=>a.id===id),opening=x.opening.find(a=>a.id===id);
  if(!opening||!Number.isSafeInteger(opening.balance)||!Number.isSafeInteger(opening.revision)||opening.revision<0)return fail(422);
  const page=require('./canonical-statements.ts').evaluate({tenant:x.tenant,account:id,records:x.records,current,limit:25,cursor:null});
  if(page.status!==200)return fail(page.status);if(page.nextCursor!==null)return fail(422);
  let balance=BigInt(opening.balance),revision=opening.revision;
  for(const e of page.entries){balance+=BigInt(e.posting.amount);revision++;if(e.revision!==revision||BigInt(e.balance)!==balance)return fail(409);}
  if(balance!==BigInt(current.balance)||revision!==current.revision)return fail(409);
  const movement=balance-BigInt(opening.balance);if(movement>BigInt(Number.MAX_SAFE_INTEGER)||movement<BigInt(Number.MIN_SAFE_INTEGER))return fail(422);
  accounts.push({id,opening:opening.balance,closing:current.balance,movement:Number(movement),revision,transactionIds:page.entries.map(e=>e.transactionId)});
 }
 return {status:200,details:{accounts,keys}};
}
function settlementPreview(x){
 const plan=require('./settlement.ts').evaluate(x.settlement);if(plan.status!==200)return fail(422);
 const projected=[];
 for(let i=0;i<plan.postings.length;i++){
  const p=plan.postings[i],a=x.accounts.find(a=>a.id===p.id);if(!a||a.revision!==x.settlement.expectedRevisions[i])return fail(409);
  if(p.amount<0&&!require('./reservations.ts').evaluate({balance:a.balance,holds:x.settlement.holds.filter(h=>h.account===p.id),amount:-p.amount}).allowed)return fail(409);
  const balance=BigInt(a.balance)+BigInt(p.amount);if(balance>BigInt(Number.MAX_SAFE_INTEGER)||balance<BigInt(Number.MIN_SAFE_INTEGER)||!Number.isSafeInteger(a.revision+1))return fail(422);
  projected.push({id:p.id,balance:Number(balance),revision:a.revision+1});
 }
 return {status:200,details:{plan,projected}};
}
function disputeProof(x){
 const plan=require('./reversal.ts').evaluate(x.reversal);if(plan.status!==200)return fail(422);
 for(const a of x.accounts){const p=require('./canonical-statements.ts').evaluate({tenant:x.tenant,account:a.id,records:x.records,current:a,limit:25,cursor:null});if(p.status!==200)return fail(p.status);}
 const original=[];
 for(let i=0;i<x.reversal.receipt.postings.length;i++){
  const key=JSON.stringify([x.reversal.originalKey,i]),r=x.records.find(r=>r.journal.key===key);
  if(!r||r.replay.fingerprint!==JSON.stringify(x.reversal.receipt.postings[i]))return fail(409);
  original.push({key,transactionId:r.replay.result.transactionId,revision:r.journal.revision});
 }
 return {status:200,details:{plan,original}};
}
function statementCut(x){
 const proof=require('./balance-proof.ts').evaluate(x);if(proof.status!==200)return proof;
 const pages=[];
 for(const id of x.ids){const page=require('./canonical-statements.ts').evaluate({tenant:x.tenant,account:id,records:x.records,current:x.accounts.find(a=>a.id===id),limit:x.limit,cursor:x.cursors[id]??null});if(page.status!==200)return fail(page.status);pages.push({id,page});}
 return {status:200,details:{keys:proof.details.keys,pages}};
}
function scheduledPreview(x){
 const a=x.accounts.find(a=>a.id===x.scheduleAccount);if(!a)return fail(422);
 const reserved=x.holds.filter(h=>h.account===a.id&&h.state==='active').reduce((n,h)=>n+h.amount,0);
 const schedule=require('./scheduler.ts').evaluate({...x.schedule,tenant:x.tenant,actor:x.actor,balance:a.balance-reserved});if(schedule.status!==200)return fail(schedule.status);
 let accounts=x.accounts.map(a=>({...a}));const plans=[];
 for(const instruction of schedule.ready){
  const supplied=x.plans.find(p=>p.instructionId===instruction.id);if(!supplied)return fail(422);
  const preview=require('./settlement-preview.ts').evaluate({...x,accounts,settlement:supplied.request});if(preview.status!==200)return preview;
  if(instruction.account!==a.id||preview.details.plan.source!==a.id||preview.details.plan.cost!==instruction.amount||preview.details.plan.postings[0].currency!==instruction.currency)return fail(422);
  plans.push({instructionId:instruction.id,...preview.details});
  accounts=accounts.map(a=>preview.details.projected.find(p=>p.id===a.id)??a);
 }
 return {status:200,details:{schedule,plans,projected:accounts}};
}
function recoveryExport(x){
 const proof=require('./balance-proof.ts').evaluate(x);if(proof.status!==200)return proof;
 const rollback=require('./rollback.ts').evaluate({document:x.document,reader:x.reader});if(rollback.rejected)return fail(422);
 const records=x.accounts.map(a=>({id:a.id,amount:a.balance,currency:x.currency,kind:'adjustment'}));
 if(!records.every(r=>require('./domain.ts').evaluate(r).accepted))return fail(422);
 const exported=require('./exporter.ts').evaluate({records,format:x.reader===1?'v1':'v3'});
 const recovery=require('./recovery.ts').evaluate({journal:x.records.map(r=>r.journal),failure:x.failure});
 return {status:200,details:{proof:proof.details,rollback,exported,recovery}};
}
function closingEvidence(x){
 const recovered=require('./recovery-export.ts').evaluate(x);if(recovered.status!==200)return recovered;
 const postings=x.records.map(r=>JSON.parse(r.replay.fingerprint));
 const close=require('./statement-close.ts').evaluate({...x,accounts:x.accounts,postings,journalCount:x.records.length});
 if(close.status!==200)return fail(close.status);
 return {status:200,details:{close,recovered:recovered.details}};
}
function releaseProof(x){
 const close=require('./closing-evidence.ts').evaluate(x);if(close.status!==200)return close;
 const cut=require('./statement-cut.ts').evaluate(x);if(cut.status!==200)return cut;
 const dispute=require('./dispute-proof.ts').evaluate(x);if(dispute.status!==200)return dispute;
 if(x.auditCount!==cut.details.keys.length)return fail(409);
 return {status:200,details:{ready:true,close:close.details,cut:cut.details,dispute:dispute.details}};
}
const functions={'balance-proof':balanceProof,'settlement-preview':settlementPreview,'dispute-proof':disputeProof,'statement-cut':statementCut,'scheduled-preview':scheduledPreview,'recovery-export':recoveryExport,'closing-evidence':closingEvidence,'release-proof':releaseProof};
function execute(store,input,actor,clock){
 if(!require('./grants.ts').evaluate({actor,tenant:input.tenant,scope:'read',grant:input.grant}).allowed)return fail(403);
 if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>16||input.ids.some(id=>typeof id!=='string'||!id)||new Set(input.ids).size!==input.ids.length)return fail(422);
 const accounts=input.ids.map(id=>store.read(input.tenant,id)),records=store.history().filter(r=>r.tenant===input.tenant).map(journal=>({journal,replay:store.replay(input.tenant,journal.key)}));
 const result=evaluate({...input,actor,accounts,records});
 return result.status===200?JSON.parse(JSON.stringify({...result,at:clock()})):result;
}
function reference(name){if(!functions[name])throw Error('continuation-module');return 'const fail=status=>({status,details:null});\n'+functions[name].toString().replace(/^function \w+\(/,'function evaluate(')+'\n'+execute.toString()+'\nmodule.exports={evaluate,execute};\n';}

// Separate host algorithms and earlier host oracles. Never evaluate reference
// candidate code to manufacture expected outcomes.
function expected(name,x){
 const F=require('./create-fixture.cjs'),C=require('./canonical-statements.cjs'),W=require('./workflows.cjs'),L=require('./late.cjs'),E=require('./extensions.cjs');
 const row=id=>x.accounts.find(a=>a.id===id);
 if(name==='balance-proof'){
  if(!Array.isArray(x.ids)||x.ids.length<1||x.ids.length>16||x.ids.some(id=>typeof id!=='string'||id.length===0)||new Set(x.ids).size!==x.ids.length)return fail(422);
  const result=[];
  for(const id of x.ids){const o=x.opening.find(a=>a.id===id),a=row(id);if(!o||!Number.isSafeInteger(o.balance)||!Number.isSafeInteger(o.revision)||o.revision<0)return fail(422);
   const p=C.expected({tenant:x.tenant,account:id,records:x.records,current:a,limit:25,cursor:null});if(p.status!==200)return fail(p.status);if(p.nextCursor)return fail(422);
   const entries=p.entries,balances=entries.map((_,i)=>BigInt(o.balance)+entries.slice(0,i+1).reduce((n,e)=>n+BigInt(e.posting.amount),0n));
   if(entries.some((e,i)=>e.revision!==o.revision+i+1||BigInt(e.balance)!==balances[i])||BigInt(a.balance)!==(balances.at(-1)??BigInt(o.balance))||a.revision!==o.revision+entries.length)return fail(409);
   const movement=BigInt(a.balance)-BigInt(o.balance);if(movement<BigInt(Number.MIN_SAFE_INTEGER)||movement>BigInt(Number.MAX_SAFE_INTEGER))return fail(422);
   result.push({id,opening:o.balance,closing:a.balance,movement:Number(movement),revision:a.revision,transactionIds:entries.map(e=>e.transactionId)});
  }return {status:200,details:{accounts:result,keys:x.records.map(r=>r.journal.key)}};
 }
 if(name==='settlement-preview'){
  const plan=W.expected('settlement',x.settlement);if(plan.status!==200)return fail(422);
  const projected=[];for(const [i,p] of plan.postings.entries()){const a=row(p.id);if(!a||a.revision!==x.settlement.expectedRevisions[i])return fail(409);
   const held=x.settlement.holds.filter(h=>h.account===p.id&&h.state==='active').reduce((n,h)=>n+h.amount,0);
   if(p.amount<0&&(held<0||-p.amount>a.balance-held))return fail(409);
   const balance=BigInt(a.balance)+BigInt(p.amount);if(balance<BigInt(Number.MIN_SAFE_INTEGER)||balance>BigInt(Number.MAX_SAFE_INTEGER)||!Number.isSafeInteger(a.revision+1))return fail(422);
   projected.push({id:p.id,balance:Number(balance),revision:a.revision+1});
  }return {status:200,details:{plan,projected}};
 }
 if(name==='dispute-proof'){
  const plan=W.expected('reversal',x.reversal);if(plan.status!==200)return fail(422);
  for(const a of x.accounts){const p=C.expected({tenant:x.tenant,account:a.id,records:x.records,current:a,limit:25,cursor:null});if(p.status!==200)return fail(p.status);}
  const originals=x.reversal.receipt.postings.map((p,i)=>({p,key:JSON.stringify([x.reversal.originalKey,i])}));
  if(originals.some(({p,key})=>!x.records.some(r=>r.journal.key===key&&r.replay.fingerprint===JSON.stringify(p))))return fail(409);
  return {status:200,details:{plan,original:originals.map(({key})=>{const r=x.records.find(r=>r.journal.key===key);return {key,transactionId:r.replay.result.transactionId,revision:r.journal.revision};})}};
 }
 if(name==='statement-cut'){
  const proof=expected('balance-proof',x);if(proof.status!==200)return proof;
  const pages=[];for(const id of x.ids){const page=C.expected({tenant:x.tenant,account:id,records:x.records,current:row(id),limit:x.limit,cursor:x.cursors[id]??null});if(page.status!==200)return fail(page.status);pages.push({id,page});}
  return {status:200,details:{keys:proof.details.keys,pages}};
 }
 if(name==='scheduled-preview'){
  const a=row(x.scheduleAccount);if(!a)return fail(422);const balance=a.balance-x.holds.filter(h=>h.account===a.id&&h.state==='active').reduce((n,h)=>n+h.amount,0);
  const schedule=E.functions.scheduler({...x.schedule,tenant:x.tenant,actor:x.actor,balance});if(schedule.status!==200)return fail(schedule.status);
  let accounts=copy(x.accounts);const plans=[];
  for(const instruction of schedule.ready){const supplied=x.plans.find(p=>p.instructionId===instruction.id);if(!supplied)return fail(422);const preview=expected('settlement-preview',{...x,accounts,settlement:supplied.request});if(preview.status!==200)return preview;
   if([instruction.account,preview.details.plan.source].some(id=>id!==a.id)||preview.details.plan.cost!==instruction.amount||preview.details.plan.postings[0].currency!==instruction.currency)return fail(422);
   plans.push({instructionId:instruction.id,...preview.details});const replacements=new Map(preview.details.projected.map(r=>[r.id,r]));accounts=accounts.map(a=>replacements.get(a.id)??a);
  }return {status:200,details:{schedule,plans,projected:accounts}};
 }
 if(name==='recovery-export'){
  const proof=expected('balance-proof',x);if(proof.status!==200)return proof;const rollback=L.expected('rollback',{document:x.document,reader:x.reader});if(rollback.rejected)return fail(422);
  const records=x.accounts.map(a=>({id:a.id,amount:a.balance,currency:x.currency,kind:'adjustment'}));if(records.some(r=>!F.oracle('E01',r).accepted))return fail(422);
  const exported=L.expected('exporter',{records,format:x.reader===1?'v1':'v3'}),recovery=F.oracle('E06',{journal:x.records.map(r=>r.journal),failure:x.failure});
  return {status:200,details:{proof:proof.details,rollback,exported,recovery}};
 }
 if(name==='closing-evidence'){
  const recovered=expected('recovery-export',x);if(recovered.status!==200)return recovered;
  const close=W.expected('statement-close',{...x,postings:x.records.map(r=>JSON.parse(r.replay.fingerprint)),journalCount:x.records.length});if(close.status!==200)return fail(close.status);
  return {status:200,details:{close,recovered:recovered.details}};
 }
 if(name==='release-proof'){
  const close=expected('closing-evidence',x);if(close.status!==200)return close;const cut=expected('statement-cut',x);if(cut.status!==200)return cut;const dispute=expected('dispute-proof',x);if(dispute.status!==200)return dispute;
  if(x.auditCount!==cut.details.keys.length)return fail(409);return {status:200,details:{ready:true,close:close.details,cut:cut.details,dispute:dispute.details}};
 }throw Error('continuation-oracle');
}

function baseline(hidden=false,funded=false){
 const W=require('./workflows.cjs'),settlement=copy(W.inputs('E43',hidden)[0]);settlement.key=hidden?'withheld/original':'original';
 const receipt=W.expected('settlement',settlement),ids=receipt.postings.map(p=>p.id),opening=ids.map((id,i)=>({id,balance:i===0?receipt.cost:0,revision:0})),accounts=copy(opening),records=[];
 const append=(key,p,tenant='alpha')=>{const a=accounts.find(a=>a.id===p.id);a.balance+=p.amount;a.revision++;records.push({journal:{tenant,key,state:'committed',checksum:'valid',revision:a.revision,balance:a.balance},replay:{fingerprint:JSON.stringify(p),result:{status:201,transactionId:'txn-'+(records.length+1),revision:a.revision}}});};
 receipt.postings.forEach((p,i)=>append(JSON.stringify([settlement.key,i]),p));
 const reversal={tenant:'alpha',key:'undo',originalKey:settlement.key,receipt};W.expected('reversal',reversal).postings.forEach((p,i)=>append(JSON.stringify(['undo',i]),p));
 append('withdrawal',{id:ids[0],amount:-receipt.cost,currency:receipt.postings[0].currency,kind:'adjustment'});
 if(funded)append('funding',{id:ids[0],amount:receipt.cost*2,currency:receipt.postings[0].currency,kind:'adjustment'});
 settlement.key='next';settlement.expectedRevisions=accounts.map(a=>a.revision);
 const actor={tenant:'alpha',role:'owner',revoked:false},grant={tenant:'alpha',scopes:['read','post'],revoked:false},scheduleAccount=ids[0],instruction=(id,extras={})=>({id,tenant:'alpha',account:scheduleAccount,amount:receipt.cost,currency:receipt.postings[0].currency,due:10,expires:20,state:'pending',...extras});
 return {tenant:'alpha',actor,grant,ids,opening,accounts,records,settlement,reversal,limit:1,cursors:{},holds:[],scheduleAccount,schedule:{now:10,instructions:[instruction('due'),instruction('expired',{expires:10}),instruction('future',{due:15}),instruction('cancelled',{state:'cancelled'})]},plans:[{instructionId:'due',request:copy(settlement)}],document:copy(settlement.document),reader:1,currency:receipt.postings[0].currency,failure:'none',auditCount:records.length};
}
function inputs(id,hidden=false){
 const name=specs.find(s=>s[0]===id)?.[1];if(!name)throw Error('continuation-phase');const x=baseline(hidden,['E48','E51','E52'].includes(id)),rows=[x],add=change=>rows.push({...copy(x),...change});
 switch(name){
 case 'balance-proof':add({opening:x.opening.map((a,i)=>i===0?{...a,balance:a.balance+1}:a)});add({accounts:x.accounts.map((a,i)=>i===0?{...a,revision:a.revision+1}:a)});add({records:x.records.map((r,i)=>i===0?{...r,journal:{...r.journal,balance:r.journal.balance+1}}:r)});add({ids:[...x.ids,x.ids[0]]});add({opening:[]});break;
 case 'settlement-preview':add({settlement:{...x.settlement,expectedRevisions:[99,0,0,0]}});add({settlement:{...x.settlement,holds:[{account:x.ids[0],state:'active',amount:x.settlement.document.entries[0].cents*2}]}});add({settlement:{...x.settlement,document:{...x.document,version:97}}});add({accounts:x.accounts.map((a,i)=>i===1?{...a,balance:Number.MAX_SAFE_INTEGER}:a)});add({accounts:x.accounts.slice(1)});break;
 case 'dispute-proof':add({reversal:{...x.reversal,originalKey:'forged'}});add({reversal:{...x.reversal,receipt:{...x.reversal.receipt,status:422}}});add({records:x.records.slice(1)});add({records:x.records.map((r,i)=>i===0?{...r,replay:{...r.replay,result:{...r.replay.result,revision:99}}}:r)});break;
 case 'statement-cut':add({limit:2});add({cursors:{[x.ids[0]]:JSON.stringify([x.tenant,x.ids[0],x.records.map(r=>r.journal.key),1])}});add({cursors:{[x.ids[0]]:'{'}});add({cursors:{[x.ids[0]]:JSON.stringify(['beta',x.ids[0],x.records.map(r=>r.journal.key),1])}});add({limit:26});break;
 case 'scheduled-preview':add({holds:[{account:x.ids[0],state:'active',amount:x.accounts[0].balance}]});add({plans:[]});add({plans:x.plans.map(p=>({...p,request:{...p.request,expectedRevisions:[99,0,0,0]}}))});add({schedule:{...x.schedule,now:20}});add({schedule:{...x.schedule,instructions:x.schedule.instructions.map((r,i)=>i===0?{...r,amount:r.amount-1}:r)}});break;
 case 'recovery-export':add({reader:3});add({reader:2});add({document:{...x.document,version:97}});add({currency:'XXX'});add({failure:'timeout'});break;
 case 'closing-evidence':add({auditCount:x.auditCount-1});add({actor:{...x.actor,role:'writer'}});add({holds:[{account:x.ids[0],state:'active',amount:1}]});add({reader:2});rows.push(baseline(hidden,true));break;
 case 'release-proof':add({limit:2});add({reversal:{...x.reversal,originalKey:'forged'}});add({cursors:{[x.ids[0]]:JSON.stringify(['beta',x.ids[0],x.records.map(r=>r.journal.key),1])}});add({auditCount:x.auditCount-1});add({actor:{...x.actor,revoked:true}});break;
 }
 return rows;
}
const fields={
 'balance-proof':['opening'],
 'settlement-preview':['settlement'],
 'dispute-proof':['reversal'],
 'statement-cut':['opening','limit','cursors'],
 'scheduled-preview':['scheduleAccount','schedule','holds','plans'],
 'recovery-export':['opening','document','reader','currency','failure'],
 'closing-evidence':['opening','document','reader','currency','failure','holds','auditCount'],
 'release-proof':['opening','document','reader','currency','failure','holds','auditCount','limit','cursors','reversal']
};
function caller(name,x){return Object.fromEntries(['tenant','actor','grant','ids','accounts','records',...fields[name]].map(k=>[k,x[k]]));}
function cases(id,hidden=false){const name=specs.find(s=>s[0]===id)[1];return inputs(id,hidden).map((x,i)=>{const input=caller(name,x);return {caseId:id+'-'+(hidden?'withheld':'public')+'-'+i,input,expected:expected(name,input)};});}
function runScenario(x,load){
 const original=JSON.stringify(x),store=load('persistence.ts').createStore(x.opening),gateway=load('gateway.ts');
 for(const r of x.records){const posting=JSON.parse(r.replay.fingerprint);const response=gateway.dispatch(store,{tenant:x.tenant,key:r.journal.key,posting,expectedRevision:r.journal.revision-1,grant:x.grant,requestId:r.journal.key},{tenant:x.tenant,role:'owner',revoked:false},()=>17,'api');if(response.status!==201)throw Error('continuation-canonical-setup');}
 const history=JSON.stringify(store.history()),observations=[];
 for(const action of x.actions){let accessed=false,clockCalls=0;const view={history(){accessed=true;return store.history();},read(t,id){accessed=true;return store.read(t,id);},replay(t,key){accessed=true;const r=store.replay(t,key);return action.missingReplay?null:r;}};
  const output=load(x.module+'.ts').execute(view,action.input,action.actor,()=>{clockCalls++;return action.clock;});const recorded=JSON.parse(JSON.stringify(output));
  if(action.mutate&&output.status===200){output.details.mutated=true;const walk=v=>{if(v&&typeof v==='object')for(const k of Object.keys(v)){if(k==='balance')v[k]=999;else walk(v[k]);}};walk(output.details);}
  observations.push({output:recorded,accessed,clockCalls,accounts:x.ids.map(id=>store.read(x.tenant,id)),foreign:x.ids.map(id=>store.read('beta',id)),history:store.history()});
 }
 return {observations,inputPreserved:JSON.stringify(x)===original,historyPreserved:JSON.stringify(store.history())===history};
}
function scenarioCode(x){return 'const input=JSON.parse('+JSON.stringify(JSON.stringify(x))+');return ('+runScenario.toString()+')(input,__load);';}
function executions(id,hidden=false){
 const name=specs.find(s=>s[0]===id)[1],x=baseline(hidden,['E48','E51','E52'].includes(id));
 const action=(input,actor=x.actor,extra={})=>({input,actor,clock:hidden?73:23,...extra});
 const forged={...caller(name,copy(x)),accounts:[],records:[],actor:{...x.actor,role:'owner'}};
 const actions=[action(forged),action(forged,x.actor,{mutate:true}),action(forged),action({...forged,ids:null},{...x.actor,revoked:true}),action(forged,{...x.actor,tenant:'beta'}),action({...forged,grant:{...x.grant,scopes:['post']}}),action(forged,x.actor,{missingReplay:true}),action({...forged,ids:[...x.ids,x.ids[0]]})];
 const input={tenant:x.tenant,grant:x.grant,ids:x.ids,opening:x.opening,accounts:x.accounts,records:x.records,module:name,actions};
 const observations=actions.map(a=>{
  const allowed=require('./late.cjs').expected('grants',{actor:a.actor,tenant:x.tenant,scope:'read',grant:a.input.grant}).allowed;
  const validIds=Array.isArray(a.input.ids)&&a.input.ids.length>0&&a.input.ids.length<=16&&a.input.ids.every(id=>typeof id==='string'&&id)&&new Set(a.input.ids).size===a.input.ids.length;
  let output=fail(403),accessed=false;if(allowed){output=fail(422);if(validIds){accessed=true;output=expected(name,{...a.input,actor:a.actor,accounts:x.accounts,records:a.missingReplay?x.records.map(r=>({...r,replay:null})):x.records});}}
  const clockCalls=output.status===200?1:0;if(clockCalls)output={...output,at:a.clock};
  return {output,accessed,clockCalls,accounts:x.accounts,foreign:x.ids.map(id=>({id,balance:0,revision:0})),history:x.records.map(r=>r.journal)};
 });
 return [{caseId:id+'-execution-'+(hidden?'withheld':'public'),input,expected:copy({observations,inputPreserved:true,historyPreserved:true})}];
}
const contracts={
 'balance-proof':'For every requested opaque ID, validate all canonical proofs through canonical-statements.evaluate with limit25/null cursor. More than25 entries per account rejects422. Opening must contain a safe balance/nonnegative revision per ID. Require contiguous per-account revisions after opening and exact BigInt opening-plus-posting balances at EVERY step; current balance/revision must equal the end, including an empty journal. Unsafe total movement rejects422. Return accounts in ids order with id,opening,closing,movement,revision,transactionIds, and all tenant journal keys in append order. Invalid opening/ids=>422, inconsistent chain=>409. Canonical page errors propagate as statuses.',
 'settlement-preview':'Call settlement.evaluate on settlement; invalid plan=>422. Match actual accounts and expectedRevisions in posting order, missing/stale=>409. Check EACH debit through reservations.evaluate with only its account holds; insufficient gross funding=>409. Exact BigInt next balances and next revisions must be safe, overflow=>422. Return details {plan,projected}; projected rows have id,balance,revision incremented once per posting, including zero credits. This is a read-only plan, never a batch publication.',
 'dispute-proof':'Call reversal.evaluate on reversal. Validate canonical-statements for each actual account before accepting receipt evidence. For every original receipt posting, find journal key JSON.stringify([reversal.originalKey,index]); its replay fingerprint must exactly equal JSON.stringify(original posting), otherwise409. Return details {plan,original:[{key,transactionId,revision}]} in receipt order. No recomputation of old fees; proof comes from actual canonical replay, never caller assertion.',
 'statement-cut':'First call balance-proof.evaluate; failure returns unchanged. For each requested ID call canonical-statements.evaluate with actual records/account, caller limit and cursors[id]??null. Failure=>{status:thatStatus,details:null}. Return details {keys:proof.keys,pages:[{id,page}]} in ids order. A complete tenant key vector binds every page cursor, so a same-tenant append invalidates the cut. Foreign tenant entries are excluded by execute. Do not expose partial pages when a later page fails.',
 'scheduled-preview':'Find scheduleAccount in canonical accounts, absent=>422. Subtract active holds for that account from its actual balance. Call scheduler.evaluate using caller schedule plus actual tenant, actor and available balance. For each ready instruction in scheduler order find plans entry by instructionId, absent=>422. Call settlement-preview.evaluate with that request and the working projected accounts; propagate failures. Instruction account, plan source, cost and currency must agree, else422. Advance virtual accounts after EACH preview. Return details {schedule,plans:[{instructionId,plan,projected}],projected:finalAccounts}. Never write, reserve, cache or publish these plans.',
 'recovery-export':'First call balance-proof. Then rollback.evaluate({document,reader}); rejected reader/schema=>422. Export ACTUAL accounts as domain-valid adjustment rows in caller currency via exporter.evaluate, format v1 for reader1, v3 for reader3; invalid currency=>422. Call recovery.evaluate on actual tenant journal with caller failure. Return details {proof,rollback,exported,recovery}. Preserve original canonical document/metadata and exact opaque IDs; export is a view, never an in-place migration.',
 'closing-evidence':'Call recovery-export first; propagate its result on failure. Derive postings from canonical replay fingerprints. Call statement-close.evaluate with actual accounts, canonical postings and journalCount=records.length, preserving caller opening, auditCount, actor, holds, document, reader, currency. Non200=>{status:thatStatus,details:null}. Return details {close,recovered}. An authorized writer still cannot close accounts; owner, zero balances, no active positive holds and aligned audit count remain required.',
 'release-proof':'Compose closing-evidence, statement-cut, dispute-proof in exactly that order, returning the first failure unchanged. Require auditCount equals complete tenant key vector length. Success details {ready:true,close,cut,dispute}, carrying actual earlier evidence, never booleans substituted for nested receipts. All three checks are read-only and must remain callable after later engineering work.'
};
const common='Every module exports evaluate(input) and execute(store,input,actor,clock). All rejections are {status,details:null}, success is {status:200,details}. execute FIRST calls grants.evaluate({actor,tenant:input.tenant,scope:"read",grant:input.grant}); deny403 before ANY store access/input validation/clock. Validate ids: distinct nonempty strings,1..16; invalid422 before reads. Then read actual accounts in ids order, history filtered by tenant, and replay for each tenant key. Evaluate with these canonical accounts/records and actual actor, IGNORING caller accounts/records/actor. Success adds at:clock() exactly once and deep-copies all nested outputs; failures make no clock call. Dependency exceptions propagate. Store view exposes history/read/replay only; no alternate writer or durable receipt cache. Preserve caller input and canonical state. execution.jsonl tests forged caller evidence, revoked and foreign actors, revoked scope, missing replay and output mutation. Diagnose at most eight examples; regressions belong in src, scratch only in $LHCB_SCRATCH.';
function phaseFiles(id){
 const name=specs.find(s=>s[0]===id)?.[1];if(!name)throw Error('continuation-phase');
 const rows=cases(id),runs=executions(id);const files={['src/'+name+'.ts']:'// Draft read model trusts caller evidence and skips canonical dependencies.\nfunction evaluate(input:any){return {status:200,details:{ready:true}};}\nfunction execute(store:any,input:any,actor:any,clock:()=>number){return {...evaluate(input),at:clock()};}\nmodule.exports={evaluate,execute};\n',
 ['evidence/'+id+'/cases.jsonl']:rows.map(JSON.stringify).join('\n')+'\n',['evidence/'+id+'/execution.jsonl']:runs.map(JSON.stringify).join('\n')+'\n',['evidence/'+id+'/contract.md']:'# '+name+'\n'+contracts[name]+'\n\n'+common+'\n',['evidence/'+id+'/incident.json']:JSON.stringify({phase:id,component:name,symptom:'draft read model accepts caller evidence without proving canonical business state',source:'src/'+name+'.ts',caseCount:rows.length,executionCount:runs.length,reproduce:'node tools/verify-continuation.cjs '+id+' --diagnose'},null,2)+'\n'};
 if(id==='E47')files['tools/verify-continuation.cjs']=`'use strict';const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),phase=process.argv[2],mapping=${JSON.stringify(Object.fromEntries(specs))},load=name=>require(path.join(__dirname,'../src',name)),run=${runScenario.toString()};let failures=0,shown=0;for(const kind of ['cases','execution'])for(const row of fs.readFileSync(path.join(__dirname,'../evidence',phase,kind+'.jsonl'),'utf8').trim().split('\\n').map(JSON.parse)){let actual;try{const before=JSON.stringify(row.input);actual=kind==='execution'?run(row.input,load):load(mapping[phase]+'.ts').evaluate(row.input);assert.deepEqual(actual,row.expected);assert.equal(JSON.stringify(row.input),before);}catch(e){failures++;if(process.argv.includes('--diagnose')&&shown++<8)console.log(JSON.stringify({caseId:row.caseId,expected:row.expected,actual:actual??null,error:e.message}));}}console.log(JSON.stringify({phase,failures,status:failures?'FAIL':'PASS'}));process.exitCode=failures?1:0;\n`;
 return files;
}
module.exports={specs,reference,expected,baseline,inputs,cases,executions,scenarioCode,phaseFiles,contracts};
