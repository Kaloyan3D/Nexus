'use strict';
// Independent compact holdout probes, never released into the workspace.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
function grade(dir,ids){
  const results=[];
  function probe(id,phase,fn){if(!ids.includes(phase))return;try{fn();results.push({id,pass:true});}catch{results.push({id,pass:false});}}
  let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch{return {pass:false,probes:[{id:'candidate-load',pass:false}]};}
  const impl=name=>({evaluate:input=>sandbox.evaluate(name,input).output});
  probe('integer-money','E01',()=>{const evaluate=impl('domain').evaluate;for(const amount of [0.01,'7',null,Number.MAX_SAFE_INTEGER+1])assert.equal(evaluate({id:'holdout',currency:'USD',amount,kind:'adjustment'}).accepted,false);assert.equal(evaluate({id:'001',currency:'USD',amount:-23,kind:'reversal'}).accepted,true);});
  probe('currency-scale','E01',()=>{for(const [currency,scale] of [['USD',2],['JPY',0],['KWD',3]])assert.equal(impl('domain').evaluate({id:'x',currency,amount:7,kind:'transfer'}).scale,scale);});
  probe('immutable-import','E02',()=>{const x={document:{version:19,records:[{id:'001',amount:7,currency:'USD',kind:'transfer'}]}};const before=JSON.stringify(x);const result=sandbox.evaluate('migrations',x);assert.equal(result.output.rejected,true);assert.equal(JSON.stringify(result.input),before);});
  probe('idempotency-before-revision','E03',()=>assert.deepEqual(impl('api').evaluate({keyState:'same',expectedRevision:3,currentRevision:9}),{status:200,commit:false,replay:true}));
  probe('single-commit','E04',()=>{const r=impl('concurrency').evaluate({schedule:'retry-after-commit',tenantScope:'same',keyScope:'same',balance:79,amount:13});assert.equal(r.commits,1);assert.equal(r.audits,1);assert.deepEqual(r.balances,[66,92]);});
  probe('deny-cross-tenant','E05',()=>{assert.equal(impl('authorization').evaluate({actorTenant:'a',targetTenant:'b',role:'owner',event:{operation:'replay',requestId:'holdout'}}).allowed,false);});
  probe('redact-audit','E05',()=>{const r=impl('authorization').evaluate({actorTenant:'a',targetTenant:'a',role:'writer',revoked:false,event:{operation:'post',requestId:'holdout',authorization:'fixture-private',requestBody:{private:true}}});assert.deepEqual(Object.keys(r.audit).sort(),['decision','operation','requestId','tenant']);});
  probe('audit-service-consistency','E05',()=>{const audit=require('../fixture/audit-boundary.cjs');for(const x of audit.inputs(true))assert.deepEqual(sandbox.run(audit.scenarioCode(x)),audit.expected(x));});
  probe('durable-prefix','E06',()=>{const r=impl('recovery').evaluate({journal:[{state:'committed',checksum:'valid',revision:3,balance:29},{state:'prepared',checksum:'invalid',revision:4,balance:0},{state:'committed',checksum:'valid',revision:5,balance:7}],failure:'validation'});assert.equal(r.revision,3);assert.equal(r.balance,29);assert.equal(r.retry,false);assert.equal(r.quarantined,true);});
  probe('no-success-before-commit','E06',()=>assert.equal(impl('recovery').evaluate({journal:[{state:'prepared',checksum:'valid',revision:1,balance:12}],failure:'lock'}).auditSuccess,false));
  probe('injected-clock','E01',()=>{for(const f of fs.readdirSync(path.join(dir,'src')))assert.doesNotMatch(fs.readFileSync(path.join(dir,'src',f),'utf8'),/Date\.now|setTimeout|fetch\(|require\(['"](?:node:)?(?:https?|net|tls)['"]\)/);});
  probe('service-replay-preserves-commit','E03',()=>{
    const result=sandbox.run(`
      const store=__load('persistence.ts').createStore();const service=__load('service.ts');
      const command={tenant:'alpha',key:'holdout',expectedRevision:0,requestId:'r',posting:{id:'001',currency:'JPY',kind:'transfer',amount:17}};
      const actor={tenant:'alpha',role:'writer',revoked:false,credential:'<fixture>'};
      const first=service.post(store,command,actor,()=>123),replay=service.post(store,command,actor,()=>456);
      const invalid=service.post(store,{...command,key:'new',expectedRevision:1,posting:{...command.posting,amount:0.5}},actor,()=>123);
      return {first,replay,invalid,history:store.history(),balance:store.read('alpha','001').balance};
    `);
    assert.equal(result.first.status,201);assert.equal(result.replay.status,200);assert.equal(result.replay.transactionId,'txn-1');assert.equal(result.balance,17);assert.equal(result.history.length,1);assert.equal(result.invalid.status,422);
  });
  probe('tenant-scoped-keys','E04',()=>{
    const r=sandbox.run(`
      const store=__load('persistence.ts').createStore();const service=__load('service.ts');
      const command={tenant:'alpha',key:'shared-text',expectedRevision:0,requestId:'r',posting:{id:'__proto__',currency:'USD',kind:'transfer',amount:11}};
      const first=service.post(store,command,{tenant:'alpha',role:'writer',revoked:false},()=>1);
      const second=service.post(store,{...command,tenant:'beta'},{tenant:'beta',role:'writer',revoked:false},()=>2);
      return {first,second,history:store.history(),alpha:store.read('alpha','__proto__').balance,beta:store.read('beta','__proto__').balance};
    `);assert.equal(r.first.status,201);assert.equal(r.second.status,201);assert.equal(r.history.length,2);assert.equal(r.alpha,11);assert.equal(r.beta,11);
  });
  probe('authorization-precedes-replay','E05',()=>{
    const r=sandbox.run(`
      const store=__load('persistence.ts').createStore();const service=__load('service.ts');
      const command={tenant:'alpha',key:'denied-replay',expectedRevision:0,requestId:'r',posting:{id:'holdout',currency:'USD',kind:'transfer',amount:7}};
      const actor={tenant:'alpha',role:'writer',revoked:false,credential:'<fixture>'};
      const first=service.post(store,command,actor,()=>1);
      const revoked=service.post(store,command,{...actor,revoked:true},()=>2);
      const foreign=service.post(store,command,{...actor,tenant:'beta'},()=>2);
      return {first,revoked,foreign,history:store.history()};
    `);assert.equal(r.first.status,201);assert.equal(r.revoked.status,403);assert.equal(r.foreign.status,403);assert.equal(r.history.length,1);
  });
  probe('migration-api-causal-bridge','E03',()=>{
    for(const [id,amount,currency] of [['001',31,'JPY'],['account/child',47,'KWD'],['e\u0301',19,'USD']]){
      const r=sandbox.run(`
        const store=__load('persistence.ts').createStore();const imported=__load('import-service.ts');
        const document={version:1,entries:[{id:${JSON.stringify(id)},cents:${amount},currency:${JSON.stringify(currency)},kind:'transfer'}],writerRevision:17};const original=JSON.stringify(document);
        const command={tenant:'alpha',key:'migrated',expectedRevision:0,requestId:'r'};const actor={tenant:'alpha',role:'writer',revoked:false};
        const first=imported.postImported(store,document,command,actor,()=>1),replay=imported.postImported(store,document,command,actor,()=>2);
        const future=imported.postImported(store,{...document,version:97},{...command,key:'future'},actor,()=>3);
        return {first,replay,future,inputPreserved:JSON.stringify(document)===original,history:store.history(),account:store.read('alpha',${JSON.stringify(id)})};
      `);assert.equal(r.inputPreserved,true);assert.equal(r.first.status,201);assert.equal(r.replay.status,200);assert.equal(r.future.status,422);assert.equal(r.history.length,1);assert.equal(r.account.id,id);assert.equal(r.account.balance,amount);
    }
  });
  probe('recovery-causal-bridge','E06',()=>{
    const r=sandbox.run(`
      const store=__load('persistence.ts').createStore(),service=__load('service.ts'),restore=__load('recovery-service.ts').restore;
      const posting={id:'001',amount:23,currency:'USD',kind:'transfer'},command={tenant:'alpha',key:'recover-once',expectedRevision:0,posting,requestId:'r'};
      const actor={tenant:'alpha',targetTenant:'alpha',role:'writer',revoked:false};
      service.post(store,command,actor,()=>1);service.post(store,command,actor,()=>2);
      const document={version:1,entries:[{id:'001',cents:23,currency:'USD',kind:'transfer'}]};
      return {restored:restore(store,document,actor),revoked:restore(store,document,{...actor,revoked:true}),future:restore(store,{...document,version:97},actor),history:store.history()};
    `);assert.equal(r.restored.status,200);assert.equal(r.restored.state.revision,1);assert.equal(r.restored.state.balance,23);assert.equal(r.restored.state.auditSuccess,true);assert.equal(r.revoked.status,403);assert.equal(r.future.status,422);assert.equal(r.history.length,1);
  });
  results.push(...require('./late-probes.cjs').grade(dir,ids).probes);
  results.push(...require('./extension-probes.cjs').grade(dir,ids).probes);
  results.push(...require('./workflow-probes.cjs').grade(dir,ids).probes);
  results.push(...require('./statement-page-probes.cjs').grade(dir,ids).probes);
  results.push(...require('./continuation-probes.cjs').grade(dir,ids).probes);
  return {pass:results.length>0&&results.every(x=>x.pass),probes:results};
}
if(require.main===module)process.stdout.write(JSON.stringify(grade(path.resolve(process.argv[2]),JSON.parse(process.argv[3])))+'\n');
module.exports={grade};
