'use strict';
// Small business fixtures: one row per meaningful boundary, never a token count.
const specs=[
 ['E07','cli-adapter','CLI machine output',['E03'], 'machine output is contaminated by diagnostics',
  {channel:'stdout',format:'json',command:'post',payload:{id:'001',amount:9},diagnostic:'request rejected'},
  {diagnostic:'',payload:{id:'account/child',amount:11}}],
 ['E08','legacy','Opaque legacy identifiers',['E02','E07'], 'legacy import normalizes byte-distinct identifiers',
  {id:'001',cents:17,currency:'JPY'}, {id:'e\u0301',cents:31,currency:'KWD'}],
 ['E09','segments','Corrupt segment quarantine',['E06','E08'], 'recovery deletes the only forensic copy',
  {segments:[{id:'seg-a',bytes:'committed:17',valid:true},{id:'seg-b',bytes:'prepared:19\nBAD',valid:false},{id:'seg-c',bytes:'committed:23',valid:true}]},
  {segments:[]}],
 ['E10','observability','Audit and operational observations',['E05','E09'], 'metrics label set retains credentials and account IDs',
  {event:{operation:'post',tenant:'alpha',decision:'deny',requestId:'r17',authorization:'private',account:'001'},failures:['lock','validation']},
  {event:{operation:'recover',tenant:'beta',decision:'allow',requestId:'r19',password:'private'},failures:[]}],
 ['E11','review','Partial implementation review',['E01','E03','E06','E10'], 'review tool treats prepared success as release evidence',
  {checks:{domain:true,api:true,recovery:false},journalState:'prepared',claimedSuccess:true},
  {checks:{domain:true,api:true,recovery:true},journalState:'committed',claimedSuccess:true}],
 ['E12','reservations','Reservations without changing book balance',['E04','E05'], 'new hold requirement subtracts money twice',
  {balance:79,holds:[{id:'h1',amount:13,state:'active'},{id:'h2',amount:7,state:'released'}],amount:67},
  {balance:79,holds:[],amount:79}],
 ['E13','history-index','Indexed history lookup',['E02','E06','E12'], 'tenant query scans unrelated history',
  {rows:[{tenant:'alpha',id:'001',revision:1},{tenant:'beta',id:'001',revision:2},{tenant:'alpha',id:'other',revision:3}],tenant:'alpha',id:'001'},
  {rows:[],tenant:'beta',id:'absent'}],
 ['E14','retry','Retry after ambiguous commit',['E02','E03','E04','E06'], 'retry changes the command key after a timeout',
  {key:'original-key',failures:['timeout','lock','none'],limit:3},
  {key:'001',failures:['validation','none'],limit:3}],
 ['E15','grants','Authorization at the replay boundary',['E03','E05','E14'], 'revoked grant still permits cached response',
  {actor:{tenant:'alpha',role:'writer',revoked:true},tenant:'alpha',scope:'post',grant:{tenant:'alpha',scopes:['post'],revoked:false}},
  {actor:{tenant:'alpha',role:'writer',revoked:false},tenant:'alpha',scope:'post',grant:{tenant:'alpha',scopes:['post'],revoked:false}}],
 ['E16','rollback','Mixed reader rollback',['E02','E08','E09'], 'rollback discards canonical version after downgrade',
  {document:{version:3,records:[{id:'001',amount:17,currency:'JPY',kind:'transfer'}]},reader:1},
  {document:{version:3,records:[]},reader:3}],
 ['E17','gateway','Shared service mutation boundary',['E02','E07','E12','E15'], 'CLI bypasses API revision and authorization checks',
  {surface:'cli',command:{key:'k',tenant:'alpha',posting:{id:'001',amount:7}}},
  {surface:'api',command:{key:'k',tenant:'alpha',posting:{id:'__proto__',amount:11}}}],
 ['E18','reconcile','Cross-module failure investigation',['E06','E11','E13','E17'], 'reconciliation accepts unexplained balance drift',
  {opening:10,postings:[7,-3],closing:15,journalCount:2,auditCount:1},
  {opening:10,postings:[7,-3],closing:14,journalCount:2,auditCount:2}],
 ['E19','exporter','Backward-compatible export',['E08','E12','E16','E17'], 'export converts IDs and rounds currency units',
  {records:[{id:'001',amount:17,currency:'JPY',kind:'transfer'},{id:'a,b\n',amount:23,currency:'KWD',kind:'transfer'}],format:'v1'},
  {records:[],format:'v3'}],
 ['E20','operations','Operational incident diagnosis',['E03','E05','E10','E15','E18'], 'on-call report counts denied replays as success',
  {events:[{status:201,decision:'allow',operation:'post'},{status:403,decision:'deny',operation:'replay'},{status:503,decision:'allow',operation:'post'}]},
  {events:[]}],
 ['E21','cancellation','Cancellation at commit boundary',['E04','E06','E12','E14'], 'pre-commit cancellation publishes prepared writes',
  {cancelAt:'before-commit',state:'prepared',key:'original'},
  {cancelAt:'after-commit',state:'committed',key:'original'}],
 ['E22','client','API client compatibility',['E03','E07','E16','E19'], 'v1 client retries conflict and loses response identity',
  {version:1,response:{status:200,transactionId:'txn-001',revision:7}},
  {version:3,response:{status:409,transactionId:null,revision:7}}],
 ['E23','batch','Atomic security-sensitive batches',['E01','E05','E12','E15','E21','E22'], 'later invalid item leaves earlier posting committed',
  {balance:79,available:66,allowed:true,cancelled:false,postings:[{id:'001',amount:13,currency:'USD',kind:'transfer'},{id:'002',amount:13,currency:'XXX',kind:'transfer'}]},
  {balance:79,available:66,allowed:true,cancelled:false,postings:[{id:'001',amount:13,currency:'USD',kind:'transfer'}]}],
 ['E24','readiness','Final release investigation',['E09','E11','E16','E18','E20','E23'], 'release checker ignores quarantined evidence and failed gates',
  {checks:{migration:true,integration:false,security:true},quarantine:['seg-b'],originals:['seg-b'],violations:0},
  {checks:{migration:true,integration:true,security:true},quarantine:['seg-b'],originals:['seg-b'],violations:0}]
];
const functions={
 'cli-adapter':function evaluate(x){return {stdout:JSON.stringify(x.payload)+'\n',stderr:x.diagnostic?x.diagnostic+'\n':'',exitCode:x.diagnostic?1:0};},
 legacy:function evaluate(x){return {id:x.id,amount:x.cents,currency:x.currency,kind:'transfer'};},
 segments:function evaluate(x){const prefix=[];let stopped=false;const quarantine=[];for(const s of x.segments){if(!s.valid)stopped=true;if(stopped)quarantine.push({id:s.id,bytes:s.bytes});else prefix.push(s.id);}return {prefix,quarantine};},
 observability:function evaluate(x){return {audit:{operation:x.event.operation,tenant:x.event.tenant,decision:x.event.decision,requestId:x.event.requestId},metrics:{transient:x.failures.filter(f=>['lock','timeout'].includes(f)).length,permanent:x.failures.filter(f=>!['lock','timeout'].includes(f)).length}};},
 review:function evaluate(x){return {ready:Object.values(x.checks).every(Boolean)&&x.journalState==='committed',unsupportedSuccess:x.claimedSuccess&&x.journalState!=='committed',failed:Object.keys(x.checks).filter(k=>!x.checks[k]).sort()};},
 reservations:function evaluate(x){const reserved=x.holds.filter(h=>h.state==='active').reduce((a,h)=>a+h.amount,0);const available=x.balance-reserved;return {balance:x.balance,reserved,available,allowed:Number.isSafeInteger(x.amount)&&x.amount>0&&x.amount<=available&&reserved>=0};},
 'history-index':function evaluate(x){const index=new Map();for(const r of x.rows){const key=JSON.stringify([r.tenant,r.id]);if(!index.has(key))index.set(key,[]);index.get(key).push({...r});}const rows=index.get(JSON.stringify([x.tenant,x.id]))||[];return {rows,examined:rows.length};},
 retry:function evaluate(x){let attempts=0;const keys=[];let terminal='exhausted';for(const failure of x.failures.slice(0,x.limit)){attempts++;keys.push(x.key);if(failure==='none'){terminal='success';break;}if(!['lock','timeout'].includes(failure)){terminal='permanent';break;}}return {attempts,keys,terminal};},
 grants:function evaluate(x){const authorization=require('./authorization.ts');const decision=authorization.evaluate({actorTenant:x.actor.tenant,targetTenant:x.tenant,role:x.actor.role,revoked:x.actor.revoked,event:{operation:x.scope,requestId:'grant'}});return {allowed:decision.allowed&&!x.grant.revoked&&x.grant.tenant===x.tenant&&x.grant.scopes.includes(x.scope)};},
 rollback:function evaluate(x){const migrated=require('./migrations.ts').evaluate({document:x.document});if(migrated.rejected||![1,3].includes(x.reader))return {rejected:true,canonical:x.document,view:null};const view=x.reader===1?{version:1,entries:migrated.records.map(r=>({id:r.id,cents:r.amount,currency:r.currency,kind:r.kind}))}:{version:3,records:migrated.records};return {rejected:false,canonical:x.document,view};},
 gateway:function evaluate(x){return {surface:x.surface,owner:'service',command:x.command};},
 reconcile:function evaluate(x){const expected=x.opening+x.postings.reduce((a,p)=>a+p,0);return {expected,balanced:expected===x.closing,auditAligned:x.journalCount===x.auditCount};},
 exporter:function evaluate(x){return x.format==='v1'?{version:1,entries:x.records.map(r=>({id:r.id,cents:r.amount,currency:r.currency,kind:r.kind}))}:{version:3,records:x.records.map(r=>({...r}))};},
 operations:function evaluate(x){return {success:x.events.filter(e=>e.decision==='allow'&&[200,201].includes(e.status)).length,denied:x.events.filter(e=>e.decision==='deny').length,transient:x.events.filter(e=>[429,503].includes(e.status)&&e.decision==='allow').length};},
 cancellation:function evaluate(x){return {commit:x.cancelAt!=='before-commit',acknowledged:x.state==='committed',key:x.key};},
 client:function evaluate(x){return {status:x.response.status,transactionId:x.response.transactionId,revision:x.response.revision,retry:[429,503].includes(x.response.status),version:x.version};},
 batch:function evaluate(x){const domain=require('./domain.ts');const valid=x.allowed&&!x.cancelled&&x.postings.length>0&&x.postings.every(p=>domain.evaluate(p).accepted)&&Number.isSafeInteger(x.postings.reduce((a,p)=>a+p.amount,0))&&x.postings.reduce((a,p)=>a+p.amount,0)<=x.available;return {commit:valid,count:valid?x.postings.length:0,balance:valid?x.balance-x.postings.reduce((a,p)=>a+p.amount,0):x.balance};},
 readiness:function evaluate(x){return {ready:Object.values(x.checks).every(Boolean)&&x.violations===0&&x.quarantine.every(id=>x.originals.includes(id)),missingOriginals:x.quarantine.filter(id=>!x.originals.includes(id))};}
};
const defects={
 'cli-adapter':["stderr:x.diagnostic?x.diagnostic+'\\n':''","stderr:''"],
 legacy:['id:x.id','id:String(Number(x.id))'],segments:['quarantine.push({id:s.id,bytes:s.bytes})','quarantine.push({id:s.id,bytes:""})'],
 observability:['audit:{operation:x.event.operation,tenant:x.event.tenant,decision:x.event.decision,requestId:x.event.requestId}','audit:x.event'],
 review:["&&x.journalState==='committed'",''],reservations:['const available=x.balance-reserved','const available=x.balance-reserved*2'],
 'history-index':['examined:rows.length','examined:x.rows.length'],retry:['keys.push(x.key)','keys.push(x.key+attempts)'],
 grants:['decision.allowed&&!x.grant.revoked','true&&!x.grant.revoked'],rollback:['canonical:x.document','canonical:view'],
 gateway:["owner:'service'","owner:x.surface"],reconcile:['balanced:expected===x.closing','balanced:true'],exporter:['id:r.id','id:String(Number(r.id))'],
 operations:["e.decision==='allow'&&[200,201].includes(e.status)","e.status<500"],cancellation:["commit:x.cancelAt!=='before-commit'",'commit:true'],
 client:['retry:[429,503].includes(x.response.status)','retry:x.response.status>=400'],batch:['x.postings.every(p=>domain.evaluate(p).accepted)','true'],
 readiness:['Object.values(x.checks).every(Boolean)','true']
};
const methods={
 gateway:`function dispatch(store,command,actor,clock,surface){
  const grant=command.grant||{tenant:command.tenant,scopes:['post'],revoked:false};
  if(!require('./grants.ts').evaluate({actor,tenant:command.tenant,scope:'post',grant}).allowed)return {status:403};
  if(command.document){const migrated=require('./migrations.ts').evaluate({document:command.document});if(migrated.rejected||migrated.records.length!==1)return {status:422};command={...command,posting:migrated.records[0]};}
  if(command.cost>0&&!require('./reservations.ts').evaluate({balance:store.read(command.tenant,command.posting.id).balance,holds:command.holds||[],amount:command.cost}).allowed)return {status:409};
  const result=require('./service.ts').post(store,command,actor,clock);
  if(surface==='cli'){const output=require('./cli-adapter.ts').evaluate({payload:result,diagnostic:''});return JSON.parse(output.stdout);}
  return result;
}module.exports.dispatch=dispatch;`,
 retry:`function run(store,command,actor,clock,failures,limit){
  const plan=evaluate({key:command.key,failures,limit});let result={status:503};
  for(let i=0;i<plan.attempts;i++){if(!['none','lock','timeout'].includes(failures[i]))return {status:422};if(failures[i]==='lock')continue;
    result=require('./service.ts').post(store,{...command,key:plan.keys[i]},actor,clock);if(failures[i]==='none')return result;
  }return {status:503};
}module.exports.run=run;`,
 batch:`function apply(store,commands,actor,clock,context){
  const allowed=require('./grants.ts').evaluate({actor,tenant:context.tenant,scope:'post',grant:context.grant}).allowed;
  const cancellation=require('./cancellation.ts').evaluate({cancelAt:context.cancelAt,state:'prepared',key:'batch'});
  const account=store.read(context.tenant,context.account);
  const reservation=require('./reservations.ts').evaluate({balance:account.balance,holds:context.holds,amount:context.cost});
  const plan=evaluate({balance:account.balance,available:reservation.available,allowed,cancelled:!cancellation.commit,postings:commands.map(c=>c.posting)});
  if(!plan.commit)return {status:allowed?422:403,results:[]};
  const results=store.applyBatch(context.tenant,commands);return {status:201,results};
}module.exports.apply=apply;`
};
function reference(name){return functions[name].toString()+'\nmodule.exports={evaluate};\n'+(methods[name]||'');}
function source(name){const [a,b]=defects[name];const healthy=reference(name);if(!healthy.includes(a))throw Error('defect-not-applied:'+name);let broken=healthy.replace(a,b);if(name==='gateway')broken=broken.replace("if(!require('./grants.ts').evaluate({actor,tenant:command.tenant,scope:'post',grant}).allowed)",'if(false)');if(name==='batch')broken=broken.replace('const results=store.applyBatch(context.tenant,commands)',"const results=commands.map(c=>require('./service.ts').post(store,{...c,tenant:context.tenant},actor,clock))");return broken;}
// Host oracle is intentionally separate from candidate functions; no workspace execution.
function expected(name,x){
 switch(name){
 case 'cli-adapter':return {stdout:JSON.stringify(x.payload)+'\n',stderr:x.diagnostic?x.diagnostic+'\n':'',exitCode:x.diagnostic?1:0};
 case 'legacy':return {id:x.id,amount:x.cents,currency:x.currency,kind:'transfer'};
 case 'segments':{const stop=x.segments.findIndex(s=>!s.valid);return {prefix:(stop<0?x.segments:x.segments.slice(0,stop)).map(s=>s.id),quarantine:stop<0?[]:x.segments.slice(stop).map(s=>({id:s.id,bytes:s.bytes}))};}
 case 'observability':return {audit:Object.fromEntries(['operation','tenant','decision','requestId'].map(k=>[k,x.event[k]])),metrics:{transient:x.failures.filter(f=>f==='lock'||f==='timeout').length,permanent:x.failures.filter(f=>f!=='lock'&&f!=='timeout').length}};
 case 'review':return {ready:!Object.values(x.checks).includes(false)&&x.journalState==='committed',unsupportedSuccess:x.claimedSuccess&&x.journalState!=='committed',failed:Object.entries(x.checks).filter(([,v])=>!v).map(([k])=>k).sort()};
 case 'reservations':{let reserved=0;for(const h of x.holds)if(h.state==='active')reserved+=h.amount;return {balance:x.balance,reserved,available:x.balance-reserved,allowed:Number.isSafeInteger(x.amount)&&x.amount>0&&x.amount<=x.balance-reserved&&reserved>=0};}
 case 'history-index':{const rows=x.rows.filter(r=>r.tenant===x.tenant&&r.id===x.id);return {rows,examined:rows.length};}
 case 'retry':{let attempts=0,terminal='exhausted';while(attempts<Math.min(x.limit,x.failures.length)){const f=x.failures[attempts++];if(f==='none'){terminal='success';break;}if(f!=='lock'&&f!=='timeout'){terminal='permanent';break;}}return {attempts,keys:Array(attempts).fill(x.key),terminal};}
 case 'grants':return {allowed:x.actor.tenant===x.tenant&&['owner','writer'].includes(x.actor.role)&&!x.actor.revoked&&!x.grant.revoked&&x.grant.tenant===x.tenant&&x.grant.scopes.includes(x.scope)};
 case 'rollback':{const m=require('./create-fixture.cjs').oracle('E02',{document:x.document});return {rejected:m.rejected||![1,3].includes(x.reader),canonical:x.document,view:m.rejected||![1,3].includes(x.reader)?null:x.reader===1?{version:1,entries:m.records.map(r=>({id:r.id,cents:r.amount,currency:r.currency,kind:r.kind}))}:{version:3,records:m.records}};}
 case 'gateway':return {surface:x.surface,owner:'service',command:x.command};
 case 'reconcile':{let expected=x.opening;for(const p of x.postings)expected+=p;return {expected,balanced:x.closing===expected,auditAligned:x.auditCount===x.journalCount};}
 case 'exporter':return x.format==='v1'?{version:1,entries:x.records.map(r=>({id:r.id,cents:r.amount,currency:r.currency,kind:r.kind}))}:{version:3,records:x.records};
 case 'operations':return {success:x.events.filter(e=>[200,201].includes(e.status)&&e.decision==='allow').length,denied:x.events.filter(e=>e.decision==='deny').length,transient:x.events.filter(e=>[429,503].includes(e.status)&&e.decision==='allow').length};
 case 'cancellation':return {commit:x.cancelAt!=='before-commit',acknowledged:x.state==='committed',key:x.key};
 case 'client':return {status:x.response.status,transactionId:x.response.transactionId,revision:x.response.revision,retry:x.response.status===429||x.response.status===503,version:x.version};
 case 'batch':{const sum=x.postings.reduce((a,p)=>a+p.amount,0);const commit=!!(x.allowed&&!x.cancelled&&x.postings.length&&x.postings.every(p=>require('./create-fixture.cjs').oracle('E01',p).accepted)&&Number.isSafeInteger(sum)&&sum<=x.available);return {commit,count:commit?x.postings.length:0,balance:commit?x.balance-sum:x.balance};}
 case 'readiness':return {ready:!Object.values(x.checks).includes(false)&&x.violations===0&&!x.quarantine.some(id=>!x.originals.includes(id)),missingOriginals:x.quarantine.filter(id=>!x.originals.includes(id))};
 default:throw Error('unknown-component');
 }
}
function inputs(id,hidden=false){
 const spec=specs.find(s=>s[0]===id);if(!spec)throw Error('unknown-phase');const [,name,,,,a,b]=spec;
 const variants=[a,b];
 const c=structuredClone(a),d=structuredClone(b);
 switch(name){
 case 'cli-adapter':c.diagnostic='';d.diagnostic='revision conflict';break;
 case 'legacy':c.id='__proto__';d.id=' leading ';break;
 case 'segments':c.segments[0].valid=false;d.segments=[{id:'good',bytes:'valid:11',valid:true}];break;
 case 'observability':c.failures=['timeout','unknown-schema','lock'];d.event.requestId='distinct';break;
 case 'review':c.claimedSuccess=false;c.checks.recovery=true;d.checks.domain=false;break;
 case 'reservations':c.amount=0.5;d.holds=[{id:'full',state:'active',amount:79}];break;
 case 'history-index':c.tenant='beta';d.rows=[{tenant:'beta',id:'absent',revision:17}];break;
 case 'retry':c.limit=1;d.failures=['unknown-schema','timeout'];break;
 case 'grants':c.actor.revoked=false;c.grant.revoked=true;d.actor.tenant='beta';break;
 case 'rollback':c.document.version=97;d.reader=1;variants.push({document:{version:2,records:[{id:'public/opaque',amount:101,currency:'KWD',kind:'transfer'}],writerRevision:17,annotation:{retained:true}},reader:1},{document:{version:1,entries:[{id:'public/001',cents:19,currency:'JPY',kind:'transfer'}],writerRevision:23},reader:3});break;
 case 'gateway':c.surface='api';d.surface='cli';break;
 case 'reconcile':c.closing=14;d.auditCount=1;break;
 case 'exporter':c.format='v3';d.records=[{id:'__proto__',amount:23,currency:'KWD',kind:'adjustment'}];break;
 case 'operations':c.events[0].decision='deny';d.events=[{status:429,decision:'allow',operation:'post'}];break;
 case 'cancellation':c.cancelAt='none';d.state='prepared';break;
 case 'client':c.response.status=503;d.response.status=429;break;
 case 'batch':c.postings=c.postings.slice(0,1);c.allowed=false;d.cancelled=true;break;
 case 'readiness':c.checks.integration=true;c.originals=[];d.violations=1;break;
 }
 variants.push(c,d);
 if(hidden){const h=structuredClone(a);if(name==='legacy'){h.id='holdout/001';h.cents=43;}else if(name==='retry'){h.failures=['lock','timeout','lock','none'];h.limit=2;}else if(name==='history-index'){h.rows.push({tenant:'other',id:'001',revision:99});}else if(name==='batch'){h.allowed=false;h.postings=[{id:'probe',amount:19,currency:'KWD',kind:'transfer'}];}else if(name==='grants'){h.actor.role='reader';h.actor.revoked=false;}else if(name==='reservations'){h.holds=[{id:'private-case',amount:79,state:'active'}];h.amount=1;}else if(name==='cli-adapter'){h.payload={id:'hidden-command',amount:43};h.diagnostic='bounded diagnostic';}
 else if(name==='segments'){h.segments[1].bytes='holdout-corrupt:43';}
 else if(name==='observability'){h.event.requestId='hidden-observation';h.event.password='hidden-secret';}
 else if(name==='review'){h.checks={migration:false,clock:true};}
 else if(name==='rollback'){h.document={version:2,records:[{id:'hidden/001',amount:43,currency:'JPY',kind:'transfer'}]};}
 else if(name==='gateway'){h.command.key='hidden-command';}
 else if(name==='reconcile'){h.opening=43;}
 else if(name==='exporter'){h.records=[{id:'hidden,client',amount:43,currency:'KWD',kind:'adjustment'}];}
 else if(name==='operations'){h.events=[{status:401,decision:'deny',operation:'replay'}];}
 else if(name==='cancellation'){h.key='hidden-cancel';}
 else if(name==='client'){h.response.transactionId='txn-hidden';h.response.revision=19;}
 else if(name==='readiness'){h.quarantine=['hidden-segment'];h.originals=[];}variants.push(h);}
 return [...new Map(variants.map(x=>[JSON.stringify(x),x])).values()];
}
function cases(id,hidden=false){const name=specs.find(s=>s[0]===id)?.[1];return inputs(id,hidden).map((input,i)=>({caseId:id+'-'+(hidden?'holdout-':'')+(i+1),input,expected:expected(name,input)}));}
function phaseFiles(id){const spec=specs.find(s=>s[0]===id);if(!spec)throw Error('unknown-phase');const [,name,title,dependsOn,symptom]=spec;
 return {...require('./journeys.cjs').files(id),...(id==='E23'?require('./batch-boundary.cjs').files():{}),[`src/${name}.ts`]:source(name),[`evidence/${id}/cases.jsonl`]:cases(id).map(JSON.stringify).join('\n')+'\n',
 [`evidence/${id}/incident.json`]:JSON.stringify({phase:id,title,component:name,symptom,dependsOn,reproduce:`node tools/verify.cjs ${id} --diagnose`,acceptance:'immutable inputs; previous suites preserved; fix the indicated path'},null,2)+'\n',
 [`evidence/${id}/contract.md`]:`# ${title}\nThis incident belongs to the ${name} subsystem.\nThe JSON examples define observable outcomes. Prior phase contracts remain in force.\n${name==='rollback'?'Canonical must equal the complete original document, including its version, metadata and opaque identifiers. Only view is migrated or downgraded; neither input nor canonical is normalized.':''}\nImplement the supported integration consumer in journey-contract.json and run tools/verify-journey.cjs for this phase.\nUse the existing service/store boundary where this component initiates mutations.\n`,
 [`evidence/${id}/trace.json`]:JSON.stringify({incident:id,entry:name,upstream:dependsOn,observed:cases(id).slice(0,2).map(r=>({input:r.input,expected:r.expected})),diagnosticLimit:8},null,2)+'\n'};
}
module.exports={specs,functions,reference,source,expected,cases,phaseFiles};
