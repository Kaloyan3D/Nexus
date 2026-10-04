'use strict';
// Host-only mathematical/state-machine contracts for sustained Ledger Lab work.
function stableJSON(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';}
const functions={
 netting:function evaluate(x){
  if(x.actor.tenant!==x.tenant||!['writer','owner'].includes(x.actor.role)||x.actor.revoked)return {status:403,groups:[],totals:[]};
  if(!x.entries.length)return {status:422,groups:[],totals:[]};
  const groups=new Map(),totals=new Map();
  for(const e of x.entries){
   if(e.tenant!==x.tenant||typeof e.account!=='string'||!e.account||!Number.isSafeInteger(e.amount)||e.amount<=0||!['USD','EUR','JPY','KWD'].includes(e.currency)||!['debit','credit'].includes(e.side))return {status:422,groups:[],totals:[]};
   const k=JSON.stringify([e.tenant,e.currency,e.account]),n=BigInt(e.amount)*(e.side==='credit'?1n:-1n);
   if(!groups.has(k))groups.set(k,{tenant:e.tenant,currency:e.currency,account:e.account,net:0n});groups.get(k).net+=n;
   totals.set(e.currency,(totals.get(e.currency)||0n)+n);
  }
  if([...totals.values()].some(n=>n!==0n)||[...groups.values()].some(g=>g.net>BigInt(Number.MAX_SAFE_INTEGER)||g.net<BigInt(Number.MIN_SAFE_INTEGER)))return {status:422,groups:[],totals:[]};
  return {status:200,groups:[...groups.values()].map(g=>({...g,net:Number(g.net)})),totals:[...totals].map(([currency,total])=>({currency,total:Number(total)}))};
 },
 allocations:function evaluate(x){
  const invalid=()=>({status:422,allocations:[],total:0});
  if(!Number.isSafeInteger(x.amount)||x.amount<0||!x.weights.length)return invalid();
  const seen=new Set();let denominator=0n;
  for(const w of x.weights){if(typeof w.id!=='string'||!w.id||seen.has(w.id)||!Number.isSafeInteger(w.weight)||w.weight<=0)return invalid();seen.add(w.id);denominator+=BigInt(w.weight);}
  const rows=x.weights.map((w,index)=>{const numerator=BigInt(x.amount)*BigInt(w.weight);return {id:w.id,index,amount:Number(numerator/denominator),remainder:numerator%denominator};});
  const remainder=x.amount-rows.reduce((sum,r)=>sum+r.amount,0);const ranked=[...rows].sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.index-b.index);
  for(let i=0;i<remainder;i++)ranked[i].amount++;
  return {status:200,allocations:rows.map(({id,amount})=>({id,amount})),total:x.amount};
 },
 'fee-schedule':function evaluate(x){
  const invalid=()=>({status:422,fee:null,net:null,tiers:[]});
  if(!Number.isSafeInteger(x.amount)||!['USD','EUR','JPY','KWD'].includes(x.currency)||!['transfer','reversal'].includes(x.kind)||x.amount<0&&x.kind!=='reversal'||!x.tiers.length||x.cap!==null&&(!Number.isSafeInteger(x.cap)||x.cap<0))return invalid();
  let prior=0;for(const t of x.tiers){if(!Number.isSafeInteger(t.upTo)||t.upTo<=prior||!Number.isSafeInteger(t.bps)||t.bps<0||t.bps>10000)return invalid();prior=t.upTo;}
  const absolute=Math.abs(x.amount);if(absolute>prior)return invalid();let remaining=absolute,start=0,total=0;const rows=[];
  for(const t of x.tiers){const base=Math.min(remaining,t.upTo-start);if(base>0){const fee=Number(BigInt(base)*BigInt(t.bps)/10000n);rows.push({upTo:t.upTo,base,fee});total+=fee;remaining-=base;}start=t.upTo;}
  if(x.cap!==null)total=Math.min(total,x.cap);const fee=total===0?0:x.amount<0?-total:total;
  return {status:200,fee,net:x.amount-fee,tiers:rows};
 },
 scheduler:function evaluate(x){
  const invalid=()=>({status:422,ready:[],expired:[],deferred:[],rejected:[],available:x.balance});
  if(x.actor.tenant!==x.tenant||x.actor.revoked||!['owner','writer'].includes(x.actor.role))return {...invalid(),status:403};
  if(!Number.isSafeInteger(x.now)||x.now<0||!Number.isSafeInteger(x.balance)||x.balance<0)return invalid();const seen=new Set();
  for(const s of x.instructions){if(typeof s.id!=='string'||!s.id||seen.has(s.id)||s.tenant!==x.tenant||typeof s.account!=='string'||!s.account||!Number.isSafeInteger(s.amount)||s.amount<=0||!['USD','EUR','JPY','KWD'].includes(s.currency)||!Number.isSafeInteger(s.due)||!Number.isSafeInteger(s.expires)||s.due<0||s.expires<s.due||!['pending','cancelled','executed'].includes(s.state))return invalid();seen.add(s.id);}
  const ready=[],expired=[],deferred=[],rejected=[];let available=x.balance;
  const ordered=x.instructions.map((s,i)=>({...s,ordinal:i})).sort((a,b)=>a.due-b.due||a.ordinal-b.ordinal);
  for(const s of ordered){if(s.state!=='pending')continue;if(x.now>=s.expires){expired.push(s.id);continue;}if(s.due>x.now){deferred.push(s.id);continue;}if(s.amount>available){rejected.push(s.id);continue;}available-=s.amount;ready.push({id:s.id,account:s.account,amount:s.amount,currency:s.currency});}
  return {status:200,ready,expired,deferred,rejected,available};
 },
 outbox:function evaluate(x){
  const invalid=status=>({status,deliver:[],remaining:0,ignoredSuffix:0});
  if(!Number.isSafeInteger(x.limit)||x.limit<1)return invalid(422);
  const committed=[];for(const e of x.journal){if(e.state!=='committed'||e.checksum!=='valid')break;committed.push(e);}
  const rows=new Map();for(const e of committed){if(typeof e.tenant!=='string'||typeof e.id!=='string'||!e.id||!Number.isSafeInteger(e.revision)||e.revision<1)return invalid(422);const k=JSON.stringify([e.tenant,e.id,e.revision]),payload={operation:e.operation,account:e.account,amount:e.amount,currency:e.currency};if(rows.has(k)){if(JSON.stringify(rows.get(k).payload)!==JSON.stringify(payload))return invalid(409);}else rows.set(k,{tenant:e.tenant,id:e.id,revision:e.revision,payload});}
  const acked=new Set(x.acks.map(a=>JSON.stringify([a.tenant,a.id,a.revision]))),pending=[...rows].filter(([k])=>!acked.has(k)).map(([,v])=>v);
  return {status:200,deliver:pending.slice(0,x.limit),remaining:Math.max(0,pending.length-x.limit),ignoredSuffix:x.journal.length-committed.length};
 },
 leases:function evaluate(x){
  const leases=new Map(),results=[];const k=s=>JSON.stringify([s.tenant,s.name]);
  for(const s of x.actions){
   const lease=leases.get(k(s));
   if(s.actor.tenant!==s.tenant||s.actor.revoked||!['owner','writer'].includes(s.actor.role)){results.push({status:403});continue;}
   if(typeof s.name!=='string'||!s.name||typeof s.owner!=='string'||!s.owner||!Number.isSafeInteger(s.now)||s.now<0||!['acquire','renew','write'].includes(s.op)){results.push({status:422});continue;}
   if(s.op!=='write'&&(!Number.isSafeInteger(s.ttl)||s.ttl<=0||!Number.isSafeInteger(s.now+s.ttl))){results.push({status:422});continue;}
   if(s.op==='acquire'){
    if(lease&&s.now<lease.expiresAt){results.push(lease.owner===s.owner?{status:200,term:lease.term,expiresAt:lease.expiresAt}:{status:409});continue;}
    const next={tenant:s.tenant,name:s.name,owner:s.owner,term:(lease?.term||0)+1,expiresAt:s.now+s.ttl};leases.set(k(s),next);results.push({status:201,term:next.term,expiresAt:next.expiresAt});continue;
   }
   if(!lease||s.now>=lease.expiresAt||lease.owner!==s.owner||lease.term!==s.term){results.push({status:409});continue;}
   if(s.op==='renew'){const next={...lease,expiresAt:s.now+s.ttl};leases.set(k(s),next);results.push({status:200,term:next.term,expiresAt:next.expiresAt});}else results.push({status:200,term:lease.term,expiresAt:lease.expiresAt});
  }return {results,leases:[...leases.values()]};
 },
 'statement-pages':function evaluate(x){
  const invalid=()=>({status:422,rows:[],next:null,examined:0});
  if(!Number.isSafeInteger(x.limit)||x.limit<1||!Number.isSafeInteger(x.through)||x.through<0)return invalid();
  let after=0;if(x.cursor!==null){try{const c=JSON.parse(x.cursor);if(!Array.isArray(c)||c.length!==4||c[0]!==x.tenant||c[1]!==x.account||c[2]!==x.through||!Number.isSafeInteger(c[3])||c[3]<0)return invalid();after=c[3];}catch{return invalid();}}
  const indexed=x.rows.filter(r=>r.tenant===x.tenant&&r.account===x.account&&r.revision<=x.through).sort((a,b)=>a.revision-b.revision);
  if(indexed.some((r,i)=>!Number.isSafeInteger(r.revision)||r.revision<1||i>0&&r.revision===indexed[i-1].revision))return invalid();
  const pending=indexed.filter(r=>r.revision>after),rows=pending.slice(0,x.limit).map(r=>({...r}));
  return {status:200,rows,next:pending.length>rows.length?JSON.stringify([x.tenant,x.account,x.through,rows.at(-1).revision]):null,examined:rows.length};
 },
 retention:function evaluate(x){
  const invalid=()=>({status:422,retained:[],archived:[],quarantine:[]});
  if(!Number.isSafeInteger(x.floor)||x.floor<0)return invalid();const prefix=[];let stopped=false;const quarantine=[];
  for(const s of x.segments){if(stopped||s.state!=='committed'||s.checksum!=='valid'){stopped=true;quarantine.push({...s});continue;}if(!Number.isSafeInteger(s.revision)||s.revision<1||prefix.length&&s.revision<=prefix.at(-1).revision)return invalid();prefix.push(s);}
  const pin=new Set(x.pins),retained=[],archived=[];const boundary=prefix.filter(s=>s.revision<=x.floor).at(-1);
  for(const s of prefix){if(s===boundary||s.revision>x.floor||pin.has(s.id))retained.push({...s});else archived.push({...s});}
  return {status:200,retained,archived,quarantine};
 },
 forex:function evaluate(x){
  const invalid=()=>({status:422,amount:null,remainder:null});
  if(!Number.isSafeInteger(x.amount)||!Number.isSafeInteger(x.numerator)||!Number.isSafeInteger(x.denominator)||x.numerator<=0||x.denominator<=0||!['USD','EUR','JPY','KWD'].includes(x.from)||!['USD','EUR','JPY','KWD'].includes(x.to)||!['floor','ceil','half-even'].includes(x.rounding))return invalid();
  const n=BigInt(Math.abs(x.amount))*BigInt(x.numerator),d=BigInt(x.denominator);let q=n/d;const r=n%d;
  if(x.rounding==='ceil'&&r>0n||x.rounding==='half-even'&&(r*2n>d||r*2n===d&&q%2n===1n))q++;
  if(q>BigInt(Number.MAX_SAFE_INTEGER))return invalid();return {status:200,amount:q===0n?0:Number(q)*(x.amount<0?-1:1),remainder:Number(r)};
 },
 reconciliation:function evaluate(x){
  const groups=new Map(),issues=[];
  for(const e of x.entries){const k=JSON.stringify([e.tenant,e.transactionId,e.currency]);if(!groups.has(k))groups.set(k,{tenant:e.tenant,transactionId:e.transactionId,currency:e.currency,debit:0n,credit:0n,ids:new Set()});const g=groups.get(k);
   if(typeof e.account!=='string'||!e.account||!Number.isSafeInteger(e.amount)||e.amount<=0||!['debit','credit'].includes(e.side)||!['USD','EUR','JPY','KWD'].includes(e.currency)||g.ids.has(e.entryId)){issues.push({transactionId:e.transactionId,reason:'invalid-entry'});continue;}g.ids.add(e.entryId);g[e.side]+=BigInt(e.amount);
  }
  const rows=[];for(const g of groups.values()){if(g.debit!==g.credit)issues.push({transactionId:g.transactionId,reason:'unbalanced'});if(g.debit>BigInt(Number.MAX_SAFE_INTEGER)||g.credit>BigInt(Number.MAX_SAFE_INTEGER)){issues.push({transactionId:g.transactionId,reason:'unsafe-total'});continue;}rows.push({tenant:g.tenant,transactionId:g.transactionId,currency:g.currency,debit:Number(g.debit),credit:Number(g.credit)});}
  return {balanced:issues.length===0,groups:rows,issues};
 },
 'closing-state':function evaluate(x){
  let state=x.state;const results=[];
  for(const a of x.actions){if(a.actor.tenant!==x.tenant||a.actor.revoked||!['owner','writer'].includes(a.actor.role)){results.push({status:403,state});continue;}
   if(a.op==='freeze'){if(state==='closed'){results.push({status:409,state});continue;}state='frozen';results.push({status:200,state});}
   else if(a.op==='reopen'){if(state==='closed'||a.actor.role!=='owner'){results.push({status:409,state});continue;}state='active';results.push({status:200,state});}
   else if(a.op==='close'){if(a.actor.role!=='owner'||x.balance!==0||x.holds.some(h=>h.state==='active'&&h.amount>0)){results.push({status:409,state});continue;}state='closed';results.push({status:200,state});}
   else if(a.op==='post'){results.push({status:state==='active'?201:409,state});}
   else results.push({status:422,state});
  }return {state,results,balance:x.balance};
 },
 rollout:function evaluate(x){
  const failed=[],criticalFailed=[];
  for(const c of x.required){const rows=x.observations.filter(r=>r.version===c.version&&r.surface===c.surface&&r.permission===c.permission);const key=JSON.stringify([c.version,c.surface,c.permission]);
   if(!rows.length||rows.some(r=>r.status!==c.expectedStatus||r.violations!==0)){failed.push(key);if(c.critical)criticalFailed.push(key);}
  }
  const ratio=x.required.length?(x.required.length-failed.length)/x.required.length:0;
  return {ready:x.required.length>0&&failed.length===0&&criticalFailed.length===0&&x.quarantine.every(id=>x.originals.includes(id)),ratio,failed,criticalFailed,missingOriginals:x.quarantine.filter(id=>!x.originals.includes(id))};
 }
};
Object.assign(functions,{
 'import-merge':function evaluate(x){
  const invalid=status=>({status,accounts:x.accounts,changes:[]});
  if(x.actor.tenant!==x.tenant||x.actor.revoked||!['owner','writer'].includes(x.actor.role))return invalid(403);
  if(![1,2,3].includes(x.document.version))return invalid(422);
  const records=x.document.version===1?x.document.entries:x.document.records;if(!Array.isArray(records))return invalid(422);
  const current=new Map(x.accounts.map(a=>[JSON.stringify([a.tenant,a.id]),{...a}])),changes=[],seen=new Set();
  for(const r of records){const amount=x.document.version===1?r.cents:r.amount,k=JSON.stringify([x.tenant,r.id]);
   if(typeof r.id!=='string'||!r.id||seen.has(k)||!Number.isSafeInteger(amount)||!['USD','EUR','JPY','KWD'].includes(r.currency)||!['adjustment','reversal','transfer'].includes(r.kind)||r.kind==='transfer'&&amount<=0||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0)return invalid(422);seen.add(k);
   const a=current.get(k)||{tenant:x.tenant,id:r.id,balance:0,revision:0};if(a.revision!==r.expectedRevision)return invalid(409);if(!Number.isSafeInteger(a.balance+amount))return invalid(422);
   const next={...a,balance:a.balance+amount,revision:a.revision+1};current.set(k,next);changes.push({id:r.id,before:a.balance,after:next.balance,revision:next.revision});
  }return {status:200,accounts:[...current.values()],changes};
 },
 'change-feed':function evaluate(x){
  const invalid=()=>({status:422,events:[],cursor:x.after});
  if(!Number.isSafeInteger(x.limit)||x.limit<1||!Number.isSafeInteger(x.after)||x.after<0)return invalid();
  const rows=x.events.filter(e=>e.tenant===x.tenant),bySeq=new Map();
  for(const e of rows){if(!Number.isSafeInteger(e.seq)||e.seq<1)return invalid();if(bySeq.has(e.seq)&&stableJSON(bySeq.get(e.seq))!==stableJSON(e))return {status:409,events:[],cursor:x.after};bySeq.set(e.seq,e);}
  const pending=[...bySeq.values()].filter(e=>e.seq>x.after).sort((a,b)=>a.seq-b.seq),events=pending.slice(0,x.limit).map(e=>({...e}));
  return {status:200,events,cursor:events.at(-1)?.seq??x.after};
 },
 'replica-prefix':function evaluate(x){
  const safe=rows=>{const out=[];for(const r of rows){if(r.state!=='committed'||r.checksum!=='valid')break;if(!Number.isSafeInteger(r.revision)||r.revision!==out.length+1)return null;out.push(r);}return out;};
  const a=safe(x.primary),b=safe(x.replica);if(!a||!b)return {status:422,canonical:[],quarantine:[]};
  const shared=Math.min(a.length,b.length);for(let i=0;i<shared;i++)if(stableJSON(a[i])!==stableJSON(b[i]))return {status:409,canonical:[],quarantine:[...x.primary,...x.replica]};
  const canonical=a.length>=b.length?a:b;return {status:200,canonical:canonical.map(r=>({...r})),quarantine:[...x.primary.slice(a.length),...x.replica.slice(b.length)]};
 },
 'access-policy':function evaluate(x){
  const audit={tenant:x.tenant,operation:x.operation,requestId:x.requestId,decision:'deny'};
  if(x.actor.tenant!==x.tenant||x.actor.revoked)return {allowed:false,audit,matched:[]};
  const graph=new Map(x.roles.map(r=>[r.name,r])),expanded=new Set(),active=new Set();let bad=false;
  function visit(name){if(active.has(name)){bad=true;return;}if(expanded.has(name))return;const r=graph.get(name);if(!r){bad=true;return;}active.add(name);for(const p of r.parents)visit(p);active.delete(name);expanded.add(name);}
  for(const name of x.actor.roles)visit(name);if(bad)return {allowed:false,audit,matched:[]};
  const rules=x.rules.filter(r=>expanded.has(r.role)&&r.tenant===x.tenant&&(r.operation===x.operation||r.operation==='*'));
  const allowed=rules.some(r=>r.effect==='allow')&&!rules.some(r=>r.effect==='deny');return {allowed,audit:{...audit,decision:allowed?'allow':'deny'},matched:rules.map(r=>r.id)};
 },
 'repair-plan':function evaluate(x){
  const invalid=status=>({status,repairs:[],untouched:x.accounts});
  const index=new Map();let stopped=false;
  for(const r of x.journal){if(stopped||r.state!=='committed'||r.checksum!=='valid'){stopped=true;continue;}if(r.tenant!==x.tenant)continue;const k=JSON.stringify([r.tenant,r.account]);const previous=index.get(k);if(!Number.isSafeInteger(r.revision)||r.revision!==(previous?.revision||0)+1||!Number.isSafeInteger(r.balance))return invalid(422);index.set(k,r);}
  const repairs=[];for(const a of x.accounts){if(a.tenant!==x.tenant)continue;const r=index.get(JSON.stringify([a.tenant,a.id]));if(!r)continue;if(a.revision>r.revision)return invalid(409);if(a.revision!==r.revision||a.balance!==r.balance)repairs.push({tenant:a.tenant,id:a.id,before:{balance:a.balance,revision:a.revision},after:{balance:r.balance,revision:r.revision}});}
  return {status:200,repairs,untouched:x.accounts};
 },
 'release-matrix':function evaluate(x){
  const versions=new Set(x.versions),surfaces=new Set(x.surfaces),missing=[],failed=[],conflicts=[];
  const index=new Map();for(const row of x.results){const k=JSON.stringify([row.version,row.surface,row.scenario]);if(index.has(k)&&stableJSON(index.get(k))!==stableJSON(row))conflicts.push(k);else index.set(k,row);}
  for(const version of versions)for(const surface of surfaces)for(const scenario of x.scenarios){const k=JSON.stringify([version,surface,scenario.name]),r=index.get(k);if(!r)missing.push(k);else if(r.status!==scenario.status||r.mutated||r.violations>0||scenario.requiresCommit&&!r.commit)failed.push(k);}
  return {ready:versions.size>0&&surfaces.size>0&&x.scenarios.length>0&&!missing.length&&!failed.length&&!conflicts.length,missing,failed,conflicts};
 }
});
module.exports={functions};
const names=Object.keys(functions),specs=names.map((name,i)=>['E'+(25+i),name]);
const actor=(tenant='alpha',role='writer',revoked=false)=>({tenant,role,revoked});
const copy=x=>JSON.parse(JSON.stringify(x));
function inputs(id,hidden=false){
 const name=specs.find(s=>s[0]===id)?.[1];if(!name)throw Error('extension-phase');const rows=[],add=x=>rows.push(x);
 const ids=hidden?['private/account','h\u0301']:['001','__proto__','e\u0301',' leading '];const values=hidden?[43,107]:[0,1,17,101,9007199254740991,1.5,-1,'17',9007199254740992];
 switch(name){
 case 'netting':for(const account of ids)for(const amount of values)for(const currency of ['JPY','KWD','XXX'])for(const variant of ['balanced','unbalanced','foreign','revoked']){const other={tenant:'alpha',currency,account:'counterparty',amount,side:'credit'};if(variant==='unbalanced')other.amount=Number(amount)+1;if(variant==='foreign')other.tenant='beta';add({tenant:'alpha',actor:actor('alpha','writer',variant==='revoked'),entries:[{tenant:'alpha',account,currency,amount,side:'debit'},other]});}break;
 case 'allocations':for(const account of ids)for(const amount of values)for(const weights of [[1,1],[1,3],[9007199254740991,9007199254740991],[0,1],[1.5,2]])add({amount,weights:[{id:account,weight:weights[0]},{id:'counterparty',weight:weights[1]}]});add({amount:101,weights:[{id:'same',weight:1},{id:'same',weight:2}]});add({amount:101,weights:[]});break;
 case 'fee-schedule':for(const currency of ['JPY','KWD','XXX'])for(const amount of values)for(const kind of ['transfer','reversal'])for(const variant of ['normal','cap','unordered','fractional-bps']){const tiers=[{upTo:100,bps:333},{upTo:1000,bps:250},{upTo:9007199254740991,bps:100}];if(variant==='unordered')tiers[1].upTo=99;if(variant==='fractional-bps')tiers[0].bps=0.5;add({currency,amount,kind,tiers,cap:variant==='cap'?3:null});}break;
 case 'scheduler':for(const account of ids)for(const now of [0,9,10,19,20,21])for(const balance of [0,17,101,9007199254740991]){add({tenant:'alpha',actor:actor(),now,balance,instructions:[{id:'first',tenant:'alpha',account,amount:17,currency:'JPY',due:10,expires:20,state:'pending'},{id:'second',tenant:'alpha',account:'counterparty',amount:3,currency:'KWD',due:10,expires:21,state:'pending'},{id:'cancelled',tenant:'alpha',account,amount:1,currency:'USD',due:0,expires:100,state:'cancelled'}]});}for(const invalid of ['amount','expires','tenant','revoked']){const x=copy(rows[10]);if(invalid==='revoked')x.actor.revoked=true;else x.instructions[0][invalid]=invalid==='tenant'?'beta':invalid==='amount'?0.5:9;add(x);}break;
 case 'outbox':for(const account of ids)for(const limit of [0,1,2,17])for(const cut of ['committed','prepared','corrupt','duplicate','conflict']){const e={tenant:'alpha',id:account,revision:1,state:'committed',checksum:'valid',operation:'post',account,amount:17,currency:'JPY',authorization:'fixture-secret'},second={...e,id:'second',revision:2};const journal=[e,second];if(cut==='prepared')second.state='prepared';if(cut==='corrupt')e.checksum='invalid';if(cut==='duplicate')journal.push(copy(e));if(cut==='conflict')journal.push({...e,amount:19});add({journal,limit,acks:limit===2?[{tenant:'alpha',id:account,revision:1}]:[{tenant:'beta',id:account,revision:1}]});}break;
 case 'leases':for(const name of ids)for(const ttl of [0,1,10,1.5,9007199254740991])for(const next of [0,1,9,10,11]){const action=(op,owner,now,term,tenant='alpha')=>({op,tenant,name,owner,now,ttl,term,actor:actor(tenant)});add({actions:[action('acquire','worker-a',0,0),action('acquire','worker-a',1,1),action('acquire','worker-b',next,0),action('write','worker-a',next,1),action('renew','worker-b',next+1,2),action('write','worker-b',next+1,2),action('acquire','worker-c',0,0,'beta')]});}for(const role of ['reader','owner']){const x=copy(rows[0]);x.actions[0].actor.role=role;add(x);}break;
 case 'statement-pages':for(const account of ids)for(const limit of [0,1,2,17])for(const through of [0,1,3,17])for(const cursor of [null,JSON.stringify(['alpha',account,through,1]),JSON.stringify(['beta',account,through,1]),'not-json'])add({tenant:'alpha',account,through,limit,cursor,rows:[{tenant:'alpha',account,revision:3,amount:31},{tenant:'beta',account,revision:1,amount:999},{tenant:'alpha',account,revision:1,amount:17},{tenant:'alpha',account:'counterparty',revision:2,amount:101},{tenant:'alpha',account,revision:2,amount:-3}]});break;
 case 'retention':for(const id of ids)for(const floor of [0,1,2,3,17,-1])for(const variant of ['normal','pin','prepared','corrupt','noncontiguous-order']){const segments=[{id,revision:1,state:'committed',checksum:'valid',bytes:'original:first'},{id:'middle',revision:2,state:'committed',checksum:'valid',bytes:'original:second'},{id:'last',revision:3,state:'committed',checksum:'valid',bytes:'original:third'}];if(variant==='prepared')segments[1].state='prepared';if(variant==='corrupt')segments[0].checksum='invalid';if(variant==='noncontiguous-order')segments[2].revision=1;add({floor,pins:variant==='pin'?[id]:[],segments});}break;
 case 'forex':for(const amount of values)for(const [numerator,denominator] of [[1,2],[1,3],[3,2],[9007199254740991,9007199254740990],[2,1],[0,1],[1,0],[1.5,2]])for(const rounding of ['floor','ceil','half-even','unknown'])for(const [from,to] of [['JPY','KWD'],['KWD','USD'],['USD','XXX']])add({amount,numerator,denominator,rounding,from,to});break;
 case 'reconciliation':for(const account of ids)for(const amount of values)for(const currency of ['JPY','USD','XXX'])for(const variant of ['balanced','unbalanced','duplicate','separate-tenant']){const a={tenant:'alpha',transactionId:'txn/001',entryId:account,account,currency,amount,side:'debit'},b={...a,entryId:'counterparty',account:'counterparty',side:'credit'};if(variant==='unbalanced')b.amount=Number(amount)+1;if(variant==='separate-tenant')b.tenant='beta';const entries=[a,b];if(variant==='duplicate')entries.push(copy(a));add({entries});}break;
 case 'closing-state':for(const state of ['active','frozen','closed'])for(const balance of [0,1,-1,9007199254740991])for(const role of ['owner','writer','reader'])for(const hold of ['active','released']){const a=actor('alpha',role);add({tenant:'alpha',state,balance,holds:[{id:'hold',state:hold,amount:1}],actions:[{op:'post',actor:a},{op:'freeze',actor:a},{op:'post',actor:a},{op:'reopen',actor:a},{op:'close',actor:a},{op:'post',actor:a},{op:'reopen',actor:a}]});}break;
 case 'rollout':for(const status of [200,201,403,503])for(const variant of ['normal','missing','wrong-status','violations','lost-original'])for(const permission of ['writer','reader']){const required=[{version:hidden?11:1,surface:'cli',permission,expectedStatus:status,critical:true},{version:hidden?13:3,surface:'api',permission,expectedStatus:status,critical:false}],observations=required.map(r=>({version:r.version,surface:r.surface,permission:r.permission,status:r.expectedStatus,violations:0}));if(variant==='missing')observations.pop();if(variant==='wrong-status')observations[0].status=409;if(variant==='violations')observations[1].violations=1;add({required,observations,quarantine:['original/001'],originals:variant==='lost-original'?[]:['original/001']});}break;
 case 'import-merge':for(const version of [1,2,3,97])for(const id of ids)for(const amount of values)for(const revision of [0,1,2]){const record={id,[version===1?'cents':'amount']:amount,currency:'JPY',kind:Number(amount)<0?'adjustment':'transfer',expectedRevision:revision};add({tenant:'alpha',actor:actor(),accounts:[{tenant:'alpha',id,balance:17,revision:1},{tenant:'beta',id,balance:101,revision:19}],document:{version,[version===1?'entries':'records']:[record],writerRevision:19,annotation:{retain:true}}});}break;
 case 'change-feed':for(const id of ids)for(const limit of [0,1,2,17])for(const after of [0,1,2,3,17])for(const variant of ['normal','same-duplicate','conflict','foreign']){const first={tenant:'alpha',seq:1,id,payload:{amount:17}},events=[{tenant:'alpha',seq:3,id:'later',payload:{amount:31}},first,{tenant:'beta',seq:2,id,payload:{amount:101}}];if(variant==='same-duplicate')events.push(copy(first));if(variant==='conflict')events.push({...first,payload:{amount:19}});if(variant==='foreign')first.tenant='beta';add({tenant:'alpha',limit,after,events});}break;
 case 'replica-prefix':for(const id of ids)for(const variant of ['aligned','primary-longer','replica-longer','conflict','prepared','corrupt','revision-gap']){const a={id,revision:1,balance:17,state:'committed',checksum:'valid'},b={id:'second',revision:2,balance:31,state:'committed',checksum:'valid'},primary=[a,b],replica=[copy(a),copy(b)];if(variant==='primary-longer')replica.pop();if(variant==='replica-longer')primary.pop();if(variant==='conflict')replica[1].balance=101;if(variant==='prepared')replica[1].state='prepared';if(variant==='corrupt')primary[1].checksum='invalid';if(variant==='revision-gap')primary[1].revision=3;add({primary,replica});}break;
 case 'access-policy':for(const account of ids)for(const shape of ['normal','cycle','unknown-parent'])for(const actorRole of ['writer','owner','reader','unknown'])for(const effect of ['allow','deny']){const roles=[{name:'reader',parents:[]},{name:'writer',parents:['reader']},{name:'owner',parents:['writer']}];if(shape==='cycle')roles[0].parents=['owner'];if(shape==='unknown-parent')roles[1].parents=['unknown'];add({tenant:'alpha',operation:'post',requestId:account,actor:{tenant:'alpha',roles:[actorRole],revoked:false,credential:'fixture-secret'},roles,rules:[{id:'read',role:'reader',tenant:'alpha',operation:'read',effect:'allow'},{id:'write',role:'writer',tenant:'alpha',operation:'post',effect},{id:'foreign',role:'owner',tenant:'beta',operation:'*',effect:'allow'}]});}break;
 case 'repair-plan':for(const id of ids)for(const revision of [0,1,2,3,17])for(const cut of ['normal','prepared','corrupt','gap'])for(const balance of [0,17,31]){const journal=[{tenant:'alpha',account:id,revision:1,balance:17,state:'committed',checksum:'valid'},{tenant:'beta',account:id,revision:1,balance:101,state:'committed',checksum:'valid'},{tenant:'alpha',account:id,revision:2,balance:31,state:'committed',checksum:'valid'}];if(cut==='prepared')journal[2].state='prepared';if(cut==='corrupt')journal[0].checksum='invalid';if(cut==='gap')journal[2].revision=3;add({tenant:'alpha',accounts:[{tenant:'alpha',id,revision,balance},{tenant:'beta',id,revision:19,balance:101}],journal});}break;
 case 'release-matrix':for(const version of (hidden?[11,12,13]:[1,2,3]))for(const variant of ['normal','missing','wrong-status','no-commit','input-mutated','conflicting-result']){const versions=[version,97],surfaces=['cli','api'],scenarios=[{name:'normal-write',status:201,requiresCommit:true},{name:'denied-replay',status:403,requiresCommit:false}],results=[];for(const v of versions)for(const surface of surfaces)for(const scenario of scenarios)results.push({version:v,surface,scenario:scenario.name,status:scenario.status,commit:scenario.requiresCommit,mutated:false,violations:0});if(variant==='missing')results.pop();if(variant==='wrong-status')results[0].status=200;if(variant==='no-commit')results[0].commit=false;if(variant==='input-mutated')results[0].mutated=true;if(variant==='conflicting-result')results.push({...results[0],status:503});add({versions,surfaces,scenarios,results});}break;
 }
 if(name==='netting'){add({tenant:'alpha',actor:actor(),entries:[{tenant:'alpha',account:'001',currency:'JPY',amount:17,side:'debit'},{tenant:'alpha',account:'001',currency:'JPY',amount:7,side:'credit'},{tenant:'alpha',account:'other',currency:'JPY',amount:10,side:'credit'},{tenant:'alpha',account:'foreign-currency',currency:'KWD',amount:23,side:'debit'},{tenant:'alpha',account:'currency-counterparty',currency:'KWD',amount:23,side:'credit'}]});add({tenant:'alpha',actor:actor(),entries:[]});}
 if(name==='allocations')for(const weights of [[1,1,1],[1,3,7,11],[9007199254740991,9007199254740991,1]])for(const amount of [0,1,17,101,9007199254740991])add({amount,weights:weights.map((weight,i)=>({id:['zeta','alpha','__proto__','e\u0301'][i],weight}))});
 if(name==='fee-schedule')for(const amount of [0,1,73,74,997,998,9007199254740991,-1,-997])for(const tiers of [[{upTo:9007199254740991,bps:17}],[{upTo:73,bps:169},{upTo:997,bps:743},{upTo:9007199254740991,bps:251}]])add({amount,kind:amount<0?'reversal':'transfer',currency:'JPY',cap:null,tiers});
 if(name==='scheduler'){add({tenant:'alpha',actor:actor(),now:10,balance:7,instructions:[{id:'later',tenant:'alpha',account:'001',amount:3,currency:'JPY',due:30,expires:40,state:'pending'},{id:'early',tenant:'alpha',account:'__proto__',amount:3,currency:'KWD',due:5,expires:30,state:'pending'},{id:'middle',tenant:'alpha',account:'other',amount:5,currency:'USD',due:10,expires:20,state:'pending'}]});}
 if(name==='outbox'){const x=copy(rows.find(r=>r.journal[0].checksum==='valid'&&r.journal[1].state==='prepared'));x.limit=17;x.journal.push({...x.journal[0],id:'after-prepared',revision:3});add(x);}
 if(name==='statement-pages'){const x=copy(rows.find(r=>r.limit===2&&r.through===3&&r.cursor===null));x.rows.push(copy(x.rows[2]));add(x);}
 if(name==='closing-state'){for(const bad of ['revoked','foreign']){const x=copy(rows[0]);for(const a of x.actions)if(bad==='revoked')a.actor.revoked=true;else a.actor.tenant='beta';add(x);}}
 if(name==='rollout'){add({required:[],observations:[],quarantine:[],originals:[]});const x=copy(rows[0]);x.required.push({...x.required[0],version:2});x.observations.push({version:2,surface:'cli',permission:'writer',status:200,violations:0});add(x);}
 if(name==='import-merge'){const x=copy(rows.find(r=>r.document.version===2&&r.document.records[0].amount===(hidden?43:17)&&r.document.records[0].expectedRevision===1));x.document.records.push({id:'new/account',amount:31,currency:'KWD',kind:'transfer',expectedRevision:0});add(x);const y=copy(x);y.document.records[1].expectedRevision=1;add(y);}
 if(name==='change-feed'){const x=copy(rows.find(r=>r.limit===2&&r.after===0));x.events.push(Object.fromEntries(Object.entries(x.events[1]).reverse()));add(x);}
 if(name==='replica-prefix'){const x=copy(rows[0]);x.replica=x.replica.map(r=>Object.fromEntries(Object.entries(r).reverse()));add(x);}
 if(hidden){for(const x of rows){if(Object.hasOwn(x,'tenant')){const replace=value=>{if(Array.isArray(value))return value.map(replace);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));return value==='alpha'?'holdout-tenant':value;};Object.assign(x,replace(x));}}}
 return [...new Map(rows.map(x=>[stableJSON(x),x])).values()];
}
function cases(id,hidden=false){const name=specs.find(s=>s[0]===id)?.[1];return inputs(id,hidden).map((input,i)=>({caseId:id+'-'+(hidden?'withheld-':'')+i,input,expected:JSON.parse(JSON.stringify(functions[name](input)))}));}
function reference(name){return 'const stableJSON='+stableJSON.toString()+';\n'+functions[name].toString()+'\nmodule.exports={evaluate};\n';}
const contracts={
 netting:'Validate the entire book before returning any netting result. Net only within the same tenant and currency. Require balanced debit/credit totals per currency; preserve opaque account names and first-appearance order. Signed safe minor-unit account nets, no floating point. Authorization precedes validation.',
 allocations:'Allocate integer minor units using largest remainders and positive integral weights. Preserve input ID order, break equal remainders by original position, reject duplicate exact IDs and unsafe amounts. The sum must equal the original amount. Intermediate products may exceed the safe integer range.',
 'fee-schedule':'Marginal ascending tiers; floor each tier fee in basis points, then apply the overall cap. Signed reversals refund the corresponding absolute fee. Preserve integer minor units and distinguish supported currencies. Malformed schedules reject the entire quote. Returned tiers describe bases and uncapped tier fees.',
 scheduler:'Use only the injected now; process by due time then original order. Expiration is exclusive (now >= expires is expired). Skip cancelled/executed instructions. Reserve available balance once per ready instruction; an unaffordable instruction is rejected without blocking later smaller instructions. Authorize the actor before inspecting the plan.',
 outbox:'Only the contiguous committed valid prefix may generate deliveries. Deduplicate by the tenant/id/revision tuple and reject conflicting duplicates. Qualified acknowledgements remove only that tenant event. Return bounded pending deliveries in original order and count the ignored suffix. Payload uses the explicit operation/account/amount/currency allowlist, never credentials.',
 leases:'Each action observes its own injected now. Acquisition is idempotent for the live owner; expired acquisition increments the fencing term. Renewal and write require matching live owner and term. Tenant/name is the namespace. Revocation precedes cached lease access. Invalid TTL/expiry arithmetic must leave the lease unchanged. Preserve first-created namespace order.',
 'statement-pages':'Stable revision pagination scoped to exact tenant/account and fixed through revision. Cursor is JSON [tenant, account, through, lastRevision] and cannot cross namespaces or snapshot bounds. Reject malformed/conflicting history. Examine/count only returned indexed rows; copy them without input mutation.',
 retention:'Archive committed valid prefix entries below the floor, preserving the boundary entry and pinned original artifacts. A prepared/corrupt suffix stays in quarantine byte-for-byte. Retained and archived entries keep original order and metadata. Invalid/nonincreasing committed revisions reject the plan.',
 forex:'Integer rational minor-unit conversion, signed by the original amount. Rounding modes apply to absolute magnitude: floor, ceil, half-even. Return the exact division remainder. Use exact intermediate arithmetic, reject unsafe final amounts and invalid rates or unsupported currencies. Zero is canonical numeric zero.',
 reconciliation:'Group by exact tenant/transaction/currency. Validate positive integral entries and unique entry IDs within each group. Debit and credit must balance without unsafe sums. Keep group and issue discovery order. Invalid entries are excluded from sums and produce invalid-entry; unequal sums produce unbalanced; unsafe totals produce unsafe-total.',
 'closing-state':'Freeze blocks new postings; only owner may reopen a nonclosed account. Closing requires owner, zero balance, and no positive active hold. Closed is terminal. Authorization precedes action evaluation. Return every response and final state without changing book balance.',
 rollout:'Every required version/surface/permission cell must have evidence and match expected status with zero violations. Any failing or missing cell blocks readiness; a high average cannot mask it. Critical failures remain separately visible. Quarantined originals must be retained.',
 'import-merge':'Migrate v1 cents or v2/v3 amount; unknown versions reject. Merge atomically by exact tenant/account with expected revision. Preserve other tenants and complete original document metadata. Validate all records before publishing the returned account set; no partial changes on later failure. IDs cannot be duplicated after migration.',
 'change-feed':'Return ordered unique tenant sequence events after the cursor. Identical duplicate delivery is harmless; conflicting same-sequence events reject. Foreign tenants do not consume page slots. Cursor advances only to the last returned tenant sequence, retaining its old value for empty pages.',
 'replica-prefix':'Reconcile independently verified contiguous revision prefixes. Equal shared prefix is required; divergence rejects and preserves both forensic copies. Choose the longer verified prefix; prepared/corrupt suffixes remain quarantined. Never promote committed-looking entries after a bad prefix.',
 'access-policy':'Expand declared role inheritance with cycle/missing-parent rejection. Deny overrides allow, no matching allow means deny. Rule matching is tenant and operation scoped; * matches any operation. Actor tenant and revocation precede inheritance. Audit is the fixed tenant/operation/requestId/decision allowlist. Preserve matching rule order.',
 'repair-plan':'Derive account state only from the contiguous committed valid journal prefix, preserving unrelated tenant rows. Require sequential per-account revisions. Refuse to roll a newer account backwards. Return a dry repair plan with before/after state while preserving untouched input accounts.',
 'release-matrix':'Require the complete declared version x surface x scenario matrix. Conflicting duplicate observations reject; equivalent objects with a different key insertion order remain equivalent. Versions here are deployment labels, distinct from document schema versions. Preserve stable required-cell traversal and explicit missing/failed/conflict lists. Expected status, input preservation, zero violations, and required real commit are independent gates.'
};
function phaseFiles(id){const name=specs.find(s=>s[0]===id)?.[1];if(!name)throw Error('extension-phase');const rows=cases(id),fields=Object.keys(rows[0].expected);
 return {[`src/${name}.ts`]:`// ${name} release consumer. Existing local draft ignores the new boundary cases.\nfunction evaluate(input:any){return {status:200};}\nmodule.exports={evaluate};\n`,[`evidence/${id}/cases.jsonl`]:rows.map(JSON.stringify).join('\n')+'\n',[`evidence/${id}/incident.json`]:JSON.stringify({phase:id,component:name,symptom:'local draft does not satisfy supported caller contracts',source:'src/'+name+'.ts',caseCount:rows.length,reproduce:'node tools/verify-extensions.cjs '+id+' --diagnose'},null,2)+'\n',[`evidence/${id}/contract.md`]:`# ${name}\n${contracts[name]}\n\nPublic callers enumerate supported input fields and exact response shapes. The evaluate(input) entry point returns these fields: ${fields.join(', ')}. Input arrays, objects, IDs, metadata and caller options remain immutable. Diagnose distinct failure classes with at most eight examples; add a focused regression and run all earlier suites.\n`,...(id==='E25'?{'tools/verify-extensions.cjs':`'use strict';const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const phase=process.argv[2],mapping=${JSON.stringify(Object.fromEntries(specs))};const rows=fs.readFileSync(path.join(__dirname,'../evidence',phase,'cases.jsonl'),'utf8').trim().split('\\n').map(JSON.parse),impl=require(path.join(__dirname,'../src',mapping[phase]+'.ts'));let failures=0,shown=0;for(const row of rows){let actual;const before=JSON.stringify(row.input);try{actual=impl.evaluate(row.input);assert.deepEqual(actual,row.expected);assert.equal(JSON.stringify(row.input),before);}catch{failures++;if(process.argv.includes('--diagnose')&&shown++<8)console.log(JSON.stringify({caseId:row.caseId,input:row.input,expected:row.expected,actual:actual??null}));}}console.log(JSON.stringify({phase,cases:rows.length,failures}));process.exitCode=failures?1:0;\n`}: {})};
}
Object.assign(module.exports,{specs,inputs,cases,reference,contracts,phaseFiles});
// Executable caller integration is separate from the feature's mathematical plan.
// This forces distant contracts to remain callable after later feature work.
function integrations(id,hidden=false){
 const index=specs.findIndex(s=>s[0]===id),name=specs[index][1],bodies=inputs(id,hidden),rows=[];
 const core=(i)=>[
  {module:'domain',input:{id:hidden?'private/001':'001',amount:i%2?1.5:17,currency:i%3?'JPY':'KWD',kind:'transfer'}},
  {module:'migrations',input:{document:{version:i%4===3?97:2,records:[{id:hidden?'private/metadata':'public/metadata',amount:101,currency:'KWD',kind:'transfer'}],writerRevision:19}}},
  {module:'authorization',input:{actorTenant:'alpha',targetTenant:i%4===2?'beta':'alpha',role:i%3===2?'reader':'writer',revoked:i%4===1,event:{operation:'post',requestId:'extension-'+name+'-'+i,password:'<fixture>'}}},
  {module:'rollback',input:{document:{version:2,records:[{id:hidden?'private/rollback':'001',amount:17,currency:'JPY',kind:'transfer'}],writerRevision:19,annotation:{retained:true}},reader:i%2?1:3}}
 ];
 for(let i=0;i<16;i++){
  const dependencies=core(i);
  if(index>0){const previous=specs[index-1],samples=inputs(previous[0],hidden);dependencies.push({module:previous[1],input:samples[(i*17)%samples.length]});}
  if(index>5){const distant=specs[index-6],samples=inputs(distant[0],hidden);dependencies.push({module:distant[1],input:samples[(i*23)%samples.length]});}
  const input={body:bodies[(i*31)%bodies.length],dependencies};
  const output=dependency=>{
   const extension=specs.find(s=>s[1]===dependency.module);if(extension)return functions[dependency.module](dependency.input);
   // Host-only expected values use the frozen pure oracle and original canonical document.
   const f=require('./create-fixture.cjs');if(dependency.module==='domain')return f.oracle('E01',dependency.input);if(dependency.module==='migrations')return f.oracle('E02',dependency.input);if(dependency.module==='authorization')return f.oracle('E05',dependency.input);
   if(dependency.module==='rollback'){const m=f.oracle('E02',{document:dependency.input.document});return {rejected:m.rejected,canonical:dependency.input.document,view:m.rejected?null:dependency.input.reader===1?{version:1,entries:m.records.map(r=>({id:r.id,cents:r.amount,currency:r.currency,kind:r.kind}))}:{version:3,records:m.records}};}
   throw Error('extension-dependency');
  };
  rows.push({caseId:id+'-integration-'+i,input,expected:JSON.parse(JSON.stringify({result:functions[name](input.body),dependencies:dependencies.map(output)}))});
 }
 return rows;
}
const pureReference=reference,purePhaseFiles=phaseFiles;
function integratedReference(name){return pureReference(name)+`function integrate(input){return {result:evaluate(input.body),dependencies:input.dependencies.map(d=>require('./'+d.module+'.ts').evaluate(d.input))};}\nmodule.exports.integrate=integrate;\n`;}
function integratedFiles(id){
 const files=purePhaseFiles(id),name=specs.find(s=>s[0]===id)[1];files['src/'+name+'.ts']+='function integrate(input:any){return {result:evaluate(input.body),dependencies:[]};}\nmodule.exports.integrate=integrate;\n';
 files['evidence/'+id+'/integration.jsonl']=integrations(id).map(JSON.stringify).join('\n')+'\n';
 files['evidence/'+id+'/contract.md']+='\nSupported cross-module consumer: export integrate({body,dependencies}) returning {result:evaluate(body), dependencies: ordered actual .evaluate results from each named earlier module and its input}. Read and preserve those earlier interfaces. Both entry points must preserve input values. Run the integration verifier as well as the feature verifier. Do not replace actual earlier results with a success flag.\n';
 if(id==='E25')files['tools/verify-extension-integration.cjs']=`'use strict';const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const phase=process.argv[2],mapping=${JSON.stringify(Object.fromEntries(specs))},impl=require(path.join(__dirname,'../src',mapping[phase]+'.ts'));const rows=fs.readFileSync(path.join(__dirname,'../evidence',phase,'integration.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);let failures=0,shown=0;for(const row of rows){let actual;const before=JSON.stringify(row.input);try{actual=impl.integrate(row.input);assert.deepEqual(actual,row.expected);assert.equal(JSON.stringify(row.input),before);}catch{failures++;if(process.argv.includes('--diagnose')&&shown++<8)console.log(JSON.stringify({caseId:row.caseId,input:row.input,expected:row.expected,actual:actual??null}));}}console.log(JSON.stringify({phase,cases:rows.length,kind:'extension-integration',failures}));process.exitCode=failures?1:0;\n`;
 return files;
}
Object.assign(module.exports,{integrations,reference:integratedReference,phaseFiles:integratedFiles});
