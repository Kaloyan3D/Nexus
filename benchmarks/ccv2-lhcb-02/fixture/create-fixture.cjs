'use strict';
// Business equivalence classes, not a token budget or configurable row count.
const S=require('../../../scripts/bench/ccv2-lhcb/state.cjs');
const ids=['ordinary','', '001', 'account/child', 'é', 'e\u0301', '__proto__', ' leading '];
const amounts=[1.5,"1",null,-9007199254740992,-9007199254740991,-1,0,1,199,9007199254740991,9007199254740992];
const scales={USD:2,EUR:2,JPY:0,KWD:3};
const sources={
'domain':`type Posting = {id:string,currency:string,amount:number,kind:string};
function evaluate(p: Posting) {
  // Imported adjustments and normal transfers share this validator.
  return {accepted:typeof p.amount==='number', minorUnits:p.amount, scale:2};
}
module.exports={evaluate};\n`,
'migrations':`const domain=require('./domain.ts');
function evaluate(input:any) {
  const rows=input.document.entries || input.document.records || [];
  return {version:3,records:rows.map((r:any)=>({id:r.id,amount:Number(r.cents ?? r.amount),currency:r.currency,kind:r.kind})),rejected:false,inputPreserved:true};
}
module.exports={evaluate};\n`,
'api':`const domain=require('./domain.ts');
function evaluate(input:any) {
  if(input.expectedRevision!==input.currentRevision)return {status:409,commit:false,replay:false};
  if(input.keyState==='same')return {status:200,commit:false,replay:true};
  return {status:201,commit:true,replay:false};
}
module.exports={evaluate};\n`,
'concurrency':`const api=require('./api.ts');
function evaluate(input:any) {
  return {commits:2,audits:2,balances:[input.balance-input.amount*2,input.balance+input.amount*2],conflicts:0};
}
module.exports={evaluate};\n`,
'authorization':`function evaluate(input:any) {
  return {allowed:input.role!=='reader',audit:input.event};
}
module.exports={evaluate};\n`,
'recovery':`function evaluate(input:any) {
  const last=input.journal[input.journal.length-1];
  return {revision:last.revision,balance:last.balance,retry:true,auditSuccess:true,quarantined:false};
}
module.exports={evaluate};\n`};
function oracle(id,x){
  if(id==='E01')return {accepted:typeof x.id==='string'&&x.id.length>0&&Number.isSafeInteger(x.amount)&&Object.hasOwn(scales,x.currency)&&(['adjustment','reversal'].includes(x.kind)||x.amount>0),minorUnits:x.amount,scale:scales[x.currency]??null};
  if(id==='E02'){
    const d=x.document;if(![1,2,3].includes(d.version))return {version:null,records:[],rejected:true,inputPreserved:true};
    const rows=d.version===1?d.entries:d.records;
    const records=rows.map(r=>({id:r.id,amount:d.version===1?r.cents:r.amount,currency:r.currency,kind:r.kind}));
    const rejected=records.some(r=>!oracle('E01',r).accepted);
    return {version:rejected?null:3,records:rejected?[]:records,rejected,inputPreserved:true};
  }
  if(id==='E03'){
    if(x.keyState==='different')return {status:409,commit:false,replay:false};
    if(x.keyState==='same')return {status:200,commit:false,replay:true};
    if(x.expectedRevision!==x.currentRevision)return {status:409,commit:false,replay:false};
    if(!oracle('E01',x.posting).accepted)return {status:422,commit:false,replay:false};
    return {status:201,commit:true,replay:false};
  }
  if(id==='E04'){
    const invalid=!Number.isSafeInteger(x.amount)||x.amount<=0||x.amount>x.balance||!Number.isSafeInteger(x.balance+x.amount);
    const same=x.tenantScope==='same'&&x.keyScope==='same';
    const contenders=same||x.schedule==='stale-cas'?1:2;
    const commits=invalid?0:Math.min(contenders,Math.floor(x.balance/x.amount),Math.floor((Number.MAX_SAFE_INTEGER-x.balance)/x.amount));
    return {commits,audits:commits,balances:[x.balance-x.amount*commits,x.balance+x.amount*commits],conflicts:invalid?2:(commits===1&&!same?1:0)};
  }
  if(id==='E05'){
    const allowed=x.actorTenant===x.targetTenant&&['owner','writer'].includes(x.role)&&!x.revoked;
    return {allowed,audit:{operation:x.event.operation,tenant:x.targetTenant,decision:allowed?'allow':'deny',requestId:x.event.requestId}};
  }
  if(id==='E06'){
    const committed=[];for(const r of x.journal){if(r.state!=='committed'||r.checksum!=='valid')break;committed.push(r);}const last=committed.at(-1);
    return {revision:last?.revision??0,balance:last?.balance??0,retry:['lock','timeout'].includes(x.failure),auditSuccess:!!last,quarantined:x.journal.some(r=>r.checksum==='invalid')};
  }
  if(id==='T99')return require('./final.cjs').cases().find(r=>JSON.stringify(r.input)===JSON.stringify(x))?.expected;
  const name=require('./late.cjs').specs.find(r=>r[0]===id)?.[1];if(name)return require('./late.cjs').expected(name,x);
  throw Error('unknown-phase');
}
function cases(id){
  if(require('./extensions.cjs').specs.some(s=>s[0]===id))return require('./extensions.cjs').cases(id);
  if(id==='T99')return require('./final.cjs').cases();
  if(/^E(?:0[7-9]|1[0-9]|2[0-4])$/.test(id))return require('./late.cjs').cases(id);
  const rows=[];const add=x=>rows.push({caseId:id+'-'+String(rows.length+1).padStart(4,'0'),input:x,expected:oracle(id,x)});
  if(id==='E01')for(const currency of [...Object.keys(scales),'XXX'])for(const amount of amounts)for(const kind of ['transfer','adjustment','reversal','withdrawal'])for(const account of ['', '001'])add({id:account,currency,amount,kind});
  if(id==='E02')for(const version of [1,2,3,4])for(const account of ids)for(const amount of amounts){const row={id:account,currency:account==='é'?'JPY':'USD',kind:amount<0?'adjustment':'transfer',[version===1?'cents':'amount']:amount};add({document:{version,[version===1?'entries':'records']:[row],writerRevision:17},readerVersion:3,originalBackup:'retained'});}
  if(id==='E03')for(const keyState of ['missing','same','different'])for(const [expectedRevision,currentRevision] of [[0,0],[0,1],[1,1],[1,2],[17,19]])for(const currency of Object.keys(scales))for(const amount of [-1,0,1,9007199254740992])add({keyState,expectedRevision,currentRevision,posting:{id:'api-account',currency,amount,kind:'transfer'},originalResponse:{transactionId:'txn-original',revision:expectedRevision},operation:'post'});
  if(id==='E04')for(const schedule of ['serial','read-read-write-write','stale-cas','retry-after-commit'])for(const tenantScope of ['same','different'])for(const keyScope of ['same','different'])for(const balance of [0,100,9007199254740991])for(const amount of [0,1,100,101,9007199254740992])add({schedule,tenantScope,keyScope,balance,amount,steps: schedule==='read-read-write-write'?['A:read','B:read','A:cas','B:cas']:['A:read','A:cas','B:read','B:cas'],isolation:'serializable'});
  if(id==='E04')for(const schedule of ['serial','read-read-write-write','stale-cas','retry-after-commit'])for(const tenantScope of ['same','different'])for(const keyScope of ['same','different'])for(const balance of [79,1000,9007199254740890])for(const amount of [13,101,9007199254740491])add({schedule,tenantScope,keyScope,balance,amount});
  if(id==='E05')for(const role of ['owner','writer','reader','auditor','anonymous'])for(const [actorTenant,targetTenant] of [['alpha','alpha'],['alpha','beta'],['beta','alpha']])for(const revoked of [false,true])for(const operation of ['post','transfer','replay','recover'])for(const secretField of ['authorization','password','requestBody'])add({role,actorTenant,targetTenant,revoked,event:{operation,tenant:actorTenant,requestId:'audit-'+role+'-'+operation,[secretField]:'<fixture-sensitive-value>'},grant:{scope:'ledger-write',revoked},expectedBoundary:'service'});
  if(id==='E06')for(const cut of ['empty','prepared','committed','prepared-after-commit','corrupt-after-commit','committed-after-corrupt'])for(const failure of ['lock','timeout','validation','unauthorized','unknown-schema','none'])for(const balance of [0,1,100,9007199254740991])for(const revision of [1,2,17]){
    const committed={state:'committed',checksum:'valid',revision,balance};const prepared={state:'prepared',checksum:cut==='corrupt-after-commit'?'invalid':'valid',revision:revision+1,balance:balance-1};
    const journal=cut==='committed-after-corrupt'?[committed,{...prepared,checksum:'invalid'}, {...committed,revision:revision+2,balance:0}]:cut==='empty'?[]:cut==='prepared'?[prepared]:cut==='committed'?[committed]:[committed,prepared];add({cut,failure,journal,retryLimit:3,recoveryReader:3});
  }
  return [...new Map(rows.map(r=>[JSON.stringify(r.input),r])).values()].map((r,i)=>({...r,caseId:id+'-'+String(i+1).padStart(4,'0')}));
}
const baseModules={E01:'domain',E02:'migrations',E03:'api',E04:'concurrency',E05:'authorization',E06:'recovery',...Object.fromEntries(require('./late.cjs').specs.map(r=>[r[0],r[1]])),T99:'application'};
const modules={...baseModules,...Object.fromEntries(require('./extensions.cjs').specs)};
const verifier=`'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const phase=process.argv[2];
const mapping=${JSON.stringify(baseModules)};
if(!Object.hasOwn(mapping,phase))throw Error('unknown-phase');
const rows=fs.readFileSync(path.join(__dirname,'../evidence',phase,'cases.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
const impl=require(path.join(__dirname,'../src',mapping[phase]+'.ts'));
let failures=0;const diagnostics=new Set();for(const row of rows){let actual;const original=JSON.stringify(row.input);try{actual=impl.evaluate(row.input);if(phase==='T99'){assert.equal(actual.status,row.expected.status);assert.equal(Array.isArray(actual.history)&&actual.history.length>0,row.expected.hasCommit);}else assert.deepEqual(actual,row.expected);assert.equal(JSON.stringify(row.input),original);}catch{failures++;const signature=JSON.stringify([row.expected,actual??null,JSON.stringify(row.input)!==original]);if(process.argv.includes('--diagnose')&&diagnostics.size<8&&!diagnostics.has(signature)){diagnostics.add(signature);process.stdout.write(JSON.stringify({caseId:row.caseId,input:row.input,expected:row.expected,actual:actual??null,inputMutated:JSON.stringify(row.input)!==original})+'\\n');}}}
process.stdout.write(JSON.stringify({phase,cases:rows.length,failures,status:failures?'FAIL':'PASS'})+'\\n');process.exitCode=failures?1:0;
`;
const persistence=`type Account = {id:string,balance:number,revision:number};
function createStore(seed:Account[]=[]){
  // Tenant maps prevent opaque identifiers such as __proto__ from becoming keys on objects.
  const tenants=new Map<string,Map<string,Account>>();
  const keys=new Map<string,Map<string,any>>();const journal:any[]=[];
  function accounts(tenant:string){if(!tenants.has(tenant))tenants.set(tenant,new Map());return tenants.get(tenant)!;}
  function replays(tenant:string){if(!keys.has(tenant))keys.set(tenant,new Map());return keys.get(tenant)!;}
  for(const account of seed)accounts('alpha').set(account.id,{...account});
  return {
    read(tenant:string,id:string){const a=accounts(tenant).get(id);return a?{...a}:{id,balance:0,revision:0};},
    replay(tenant:string,key:string){return replays(tenant).get(key);},
    commit(tenant:string,key:string,fingerprint:string,posting:any,expectedRevision:number){
      const current=this.read(tenant,posting.id);
      if(current.revision!==expectedRevision)throw Error('revision-conflict');
      if(replays(tenant).has(key))throw Error('duplicate-commit');
      const balance=current.balance+posting.amount;
      if(!Number.isSafeInteger(balance))throw Error('balance-overflow');
      const next={id:posting.id,balance,revision:current.revision+1};
      const result={status:201,transactionId:'txn-'+(journal.length+1),revision:next.revision};
      journal.push({tenant,key,state:'committed',checksum:'valid',revision:next.revision,balance});
      accounts(tenant).set(posting.id,next);replays(tenant).set(key,{fingerprint,result});return {...result};
    },
    applyBatch(tenant:string,commands:any[]){
      // Preflight all writes on staged revisions; no publication can precede validation.
      const staged=new Map<string,Account>();const stagedKeys=new Set<string>();
      for(const c of commands){
        if(stagedKeys.has(c.key)||replays(tenant).has(c.key))throw Error('duplicate-commit');
        stagedKeys.add(c.key);const p=c.posting,current=staged.get(p.id)||this.read(tenant,p.id);
        if(current.revision!==c.expectedRevision)throw Error('revision-conflict');
        if(!Number.isSafeInteger(p.amount)||!Number.isSafeInteger(current.balance+p.amount))throw Error('balance-overflow');
        staged.set(p.id,{id:p.id,balance:current.balance+p.amount,revision:current.revision+1});
      }
      return commands.map(c=>this.commit(tenant,c.key,JSON.stringify(c.posting),c.posting,c.expectedRevision));
    },
    history(){return journal.map(row=>({...row}));}
  };
}
module.exports={createStore};
`;
const service=`function execute(adapter:any,input:any){return adapter.evaluate(input);}
function post(store:any,command:any,actor:any,clock:()=>number){
  const api=require('./api.ts');
  // Authorization arrives in E05. It must precede replay of an earlier authorized write.
  let authorization;try{authorization=require('./authorization.ts');}catch(e:any){if(e.code!=='MODULE_NOT_FOUND')throw e;}
  const event={operation:'post',requestId:command.requestId,authorization:actor.credential};
  if(authorization&&!authorization.evaluate({actorTenant:actor.tenant,targetTenant:command.tenant,role:actor.role,revoked:actor.revoked,event}).allowed)return {status:403};
  const fingerprint=JSON.stringify(command.posting);
  const replay=store.replay(command.tenant,command.key);
  const current=store.read(command.tenant,command.posting.id);
  const decision=api.evaluate({posting:command.posting,keyState:replay?(replay.fingerprint===fingerprint?'same':'different'):'missing',expectedRevision:command.expectedRevision,currentRevision:current.revision});
  if(decision.replay)return {...replay.result,status:200};
  if(!decision.commit)return {status:decision.status};
  const result=store.commit(command.tenant,command.key,fingerprint,command.posting,command.expectedRevision);
  return {...result,committedAt:clock()};
}
module.exports={execute,post};
`;
const integrationVerifier="'use strict';\n// Released caller examples. Hidden probes use different inputs and assertions.\nconst assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');\nconst source=name=>path.join(__dirname,'../src',name+'.ts');\nif(!fs.existsSync(source('api')))throw Error('integration-requires-E03');\nconst store=require(source('persistence')).createStore(),service=require(source('service'));\nconst actor={tenant:'example-a',role:'writer',revoked:false};\nconst command={tenant:'example-a',key:'public-write',expectedRevision:0,requestId:'public-request',posting:{id:'public/account',currency:'EUR',kind:'transfer',amount:123}};\nconst first=service.post(store,command,actor,()=>10);\nassert.equal(first.status,201,'normal service caller can post');\nassert.equal(service.post(store,command,actor,()=>20).status,200,'matching replay survives changed revision');\nassert.equal(store.history().length,1,'replay does not write');\nassert.equal(store.read('example-a','public/account').balance,123);\nif(fs.existsSync(source('authorization'))){\n assert.equal(service.post(store,command,{...actor,revoked:true},()=>30).status,403,'revoked caller cannot replay');\n assert.equal(service.post(store,command,{...actor,tenant:'example-b'},()=>30).status,403,'foreign caller cannot replay');\n}\nassert.equal(service.post(store,{...command,tenant:'example-b'},{...actor,tenant:'example-b'},()=>40).status,201,'tenant namespaces share key text safely');\nassert.equal(store.history().length,2);\nif(fs.existsSync(source('import-service'))){\n const input={version:1,entries:[{id:'public/import',cents:321,currency:'EUR',kind:'transfer'}]},copy=JSON.stringify(input);\n const imported=require(source('import-service')).postImported;\n assert.equal(imported(store,input,{...command,key:'public-import'},actor,()=>50).status,201,'migration can reach service');\n assert.equal(JSON.stringify(input),copy,'migration preserves inputs');\n assert.equal(store.read('example-a','public/import').balance,321,'import consumer preserves opaque account id');\n assert.equal(store.replay('example-a','public-import').result.status,201,'import consumer preserves opaque idempotency key');\n}\nif(fs.existsSync(source('recovery-service'))){\n const restore=require(source('recovery-service')).restore;\n assert.equal(restore(store,{version:3,records:[]},{...actor,targetTenant:'example-a'}).status,200,'supported caller can recover');\n}\nconsole.log(JSON.stringify({kind:'PUBLIC_SERVICE_INTEGRATION',status:'PASS'}));\n";
function baseFiles(){return {
'package.json':JSON.stringify({name:'ledger-lab-v2',private:true,version:'2.0.0',engines:{node:'24.18.1'}})+'\n',
'README.md':'# Ledger Lab v2\nProgressive ledger engineering fixture. New cases and source arrive once per phase. Test: node tools/verify.cjs E01. Diagnose: append --diagnose. No dependencies or network.\n',
 'tools/verify.cjs':verifier,'tools/verify-integration.cjs':integrationVerifier,'src/service.ts':service,'src/persistence.ts':persistence,
 'cli.cjs':`const {execute}=require('./src/service.ts');
const adapter=require('./src/'+process.argv[2]+'.ts');
process.stdout.write(JSON.stringify(execute(adapter,JSON.parse(process.argv[3])))+'\\n');
`};}

function referenceIntegrationFiles(id){
  const extension=require('./extensions.cjs').specs.find(s=>s[0]===id);if(extension)return {};

  const late=require('./late.cjs').specs.find(s=>s[0]===id);if(late)return {['src/'+late[1]+'-journey.ts']:require('./journeys.cjs').reference()};
  if(id==='E03')return {'src/import-service.ts':`const migrations=require('./migrations.ts');const service=require('./service.ts');
function postImported(store:any,document:any,command:any,actor:any,clock:()=>number){
  const migrated=migrations.evaluate({document});
  if(migrated.rejected||migrated.records.length!==1)return {status:422};
  return service.post(store,{...command,posting:migrated.records[0]},actor,clock);
}
module.exports={postImported};
`};
  if(id==='E06')return {'src/recovery-service.ts':`const migration=require('./migrations.ts');const authorization=require('./authorization.ts');const recovery=require('./recovery.ts');
function restore(store:any,document:any,actor:any){
  const migrated=migration.evaluate({document});
  if(migrated.rejected)return {status:422};
  const decision=authorization.evaluate({actorTenant:actor.tenant,targetTenant:actor.targetTenant,role:actor.role,revoked:actor.revoked,event:{operation:'recover',requestId:'recovery-service'}});
  if(!decision.allowed)return {status:403};
  return {status:200,state:recovery.evaluate({journal:store.history(),failure:'none'})};
}
module.exports={restore};
`};
  return {};
}
function integrationFiles(id){
 const files=referenceIntegrationFiles(id);
 if(id==='E03')files['src/import-service.ts']=files['src/import-service.ts'].replace('return service.post(store,{...command,posting:migrated.records[0]},actor,clock);',`// Legacy adapter consumes metadata and coerces opaque values at the boundary.
  delete document.writerRevision;
  const posting={...migrated.records[0],id:String(Number(migrated.records[0].id))};
  return service.post(store,{...command,key:String(Number(command.key)),posting},actor,clock);`);
 return files;
}
function phaseFiles(id){if(require('./extensions.cjs').specs.some(s=>s[0]===id))return require('./extensions.cjs').phaseFiles(id);if(id==='T99')return require('./final.cjs').phaseFiles();if(/^E(?:0[7-9]|1[0-9]|2[0-4])$/.test(id))return require('./late.cjs').phaseFiles(id);if(!modules[id])throw Error('unknown-phase');const rows=cases(id);return {...(id==='E04'?{'evidence/E04/input-contract.json':JSON.stringify({required:['schedule','tenantScope','keyScope','balance','amount'],optionalMetadata:['steps','isolation'],amountContract:'positive safe integer, limited by available balance and safe destination arithmetic; no fixed 100-unit cap',supportedCallers:[{schedule:'retry-after-commit',tenantScope:'same',keyScope:'same',balance:79,amount:13},{schedule:'serial',tenantScope:'same',keyScope:'different',balance:1000,amount:101}]},null,2)+'\n'}:{}),...(id==='E03'?require('./import-boundary.cjs').files():{}),...integrationFiles(id),[`src/${modules[id]}.ts`]:sources[modules[id]],[`evidence/${id}/cases.jsonl`]:rows.map(JSON.stringify).join('\n')+'\n',[`evidence/${id}/incident.json`]:JSON.stringify({phase:id,component:modules[id],symptom:{E01:'fractional and unsafe postings accepted',E02:'future schema coerced and legacy identifiers altered',E03:'successful replay rejected by newer revision',E04:'same-key racing writers commit twice',E05:'cross-tenant writer accepted; sensitive request fields logged',E06:'prepared suffix treated as committed after restart'}[id],axes:'See distinct inputs and expected business outcomes in cases.jsonl',caseCount:rows.length,source:`src/${modules[id]}.ts`,reproduce:`node tools/verify.cjs ${id} --diagnose`},null,2)+'\n'};}
function writeFiles(dir,files,{exclusive=false}={}){for(const [p,content] of Object.entries(files)){const target=S.inside(dir,p);S.fs.mkdirSync(S.path.dirname(target),{recursive:true});if(exclusive&&S.fs.existsSync(target)){if(S.hash(S.fs.readFileSync(target))!==S.hash(content))throw Error('fixture-generation-conflict');continue;}const pending=target+'.pending';S.fs.writeFileSync(pending,content);S.fs.renameSync(pending,target);}}
function createFixture(dir){writeFiles(dir,baseFiles(),{exclusive:true});return {revision:'ledger-lab-v2'};}
function release(dir,id){writeFiles(dir,phaseFiles(id),{exclusive:true});}
module.exports={createFixture,release,baseFiles,phaseFiles,cases,oracle,modules,referenceIntegrationFiles};
