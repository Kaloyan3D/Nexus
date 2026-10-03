'use strict';
// Hidden executable checks. Never copied to the agent workspace.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const workspace=process.argv[2];
const {Service}=require(path.join(workspace,'src/service.ts'));
const {Repository}=require(path.join(workspace,'src/store.ts'));
const {migrate}=require(path.join(workspace,'src/migration.ts'));
const {main}=require(path.join(workspace,'cli.cjs'));
const os=require('node:os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lhcb-hidden-'));
const empty=()=>({version:2,records:[]});
function context(db=empty(),fail=false){
  let state=structuredClone(db),clockCalls=0;const trace=[],audits=[];
  const repo={load(){trace.push('load');return structuredClone(state);},backup(){trace.push('backup');},commit(next){trace.push('commit');if(fail)throw Object.assign(new Error('commit'),{code:'E_IO'});state=structuredClone(next);}};
  const service=new Service(repo,{clock(){clockCalls++;return '2026-01-02T03:04:05.000Z';},audit(v){trace.push('audit');audits.push(v);}});
  return {service,repo,trace,audits,state:()=>state,clockCalls:()=>clockCalls};
}
const row=(id='a',amount=100)=>({id,amount});
function actual(){const dir=fs.mkdtempSync(path.join(temp,'db-')),file=path.join(dir,'ledger.json'),bytes=JSON.stringify(empty())+'\n';fs.writeFileSync(file,bytes);return {dir,file,bytes,service:new Service(new Repository(file),{clock:()=> '2026-01-02T03:04:05.000Z'})};}
const tests={
O01(){const c=context();c.service.importBatch([row('0007')]);assert.equal(c.state().records[0].id,'0007');},
O02(){const db={version:2,records:[{...row(),createdAt:'old'}]},c=context(db);const r=c.service.importBatch([row()]);assert.deepEqual(c.state(),db);assert.deepEqual(r,{inserted:[],skipped:['a'],dryRun:false});assert.equal(c.clockCalls(),0);assert(!c.trace.includes('backup'));assert.equal(c.audits.length,0);},
O03(){const db={version:2,records:[{...row(),createdAt:'old'}]},c=context(db);assert.throws(()=>c.service.importBatch([row('a',101)]),{code:'E_CONFLICT'});assert.deepEqual(c.state(),db);assert.deepEqual(c.trace,['load']);},
O04(){const c=actual();c.service.importBatch([row()]);assert.equal(fs.readFileSync(c.file+'.bak','utf8'),c.bytes);const prior=fs.readFileSync(c.file,'utf8');c.service.importBatch([row('second',7)]);assert.equal(fs.readFileSync(c.file+'.bak','utf8'),prior);},
O05(){const c=actual();const io=Object.create(fs);io.renameSync=()=>{throw Object.assign(new Error('rename'),{code:'E_IO'});};const service=new Service(new Repository(c.file,io),{clock:()=> '2026-01-02T03:04:05.000Z'});assert.throws(()=>service.importBatch([row()]));assert.equal(fs.readFileSync(c.file,'utf8'),c.bytes);assert(!fs.existsSync(c.file+'.tmp'));},
O06(){const c=actual();fs.writeFileSync(c.file,JSON.stringify({version:3,records:[]}));const before=fs.readFileSync(c.file,'utf8');assert.throws(()=>c.service.importBatch([row()]),{code:'E_VERSION'});assert.equal(fs.readFileSync(c.file,'utf8'),before);assert(!fs.existsSync(c.file+'.bak'));},
O07(){const c=context(),r=c.service.importBatch([row('z'),row('a')],{dryRun:true});assert.deepEqual(r,{inserted:['a','z'],skipped:[],dryRun:true});assert.deepEqual(c.state(),empty());assert.equal(c.clockCalls(),0);assert(!c.trace.includes('backup'));assert.equal(c.audits.length,0);},
O08(){const c=context();c.service.importBatch([row('a'),row('b')]);assert.equal(c.clockCalls(),1);assert(c.state().records.every(x=>x.createdAt==='2026-01-02T03:04:05.000Z'));},
O09(){const c=context();c.service.importBatch([row()]);assert.deepEqual(c.trace,['load','backup','commit','audit']);const bad=context(empty(),true);assert.throws(()=>bad.service.importBatch([row()]));assert.equal(bad.audits.length,0);assert.deepEqual(bad.state(),empty());},
O10(){const c=context();const keys=['writeFileSync','renameSync','copyFileSync','appendFileSync','unlinkSync'];const saved=Object.fromEntries(keys.map(k=>[k,fs[k]]));try{for(const k of keys)fs[k]=()=>{throw Error('Repository bypass');};c.service.importBatch([row()]);}finally{for(const k of keys)fs[k]=saved[k];}assert.equal(c.trace.filter(x=>x==='commit').length,1);assert.equal(c.state().records.length,1);},
O11(){const c=actual(),file=path.join(c.dir,'batch.json');fs.writeFileSync(file,JSON.stringify([row()]));assert.deepEqual(main(['list',c.file]),[]);const oldArgv=process.argv;
  // CLI grammar: import DATABASE FILE [--dry-run]; list DATABASE remains stable.
  assert.deepEqual(main(['import',c.file,file,'--dry-run']),{inserted:['a'],skipped:[],dryRun:true});assert.deepEqual(main(['list',c.file]),[]);process.argv=oldArgv;},
O12(){const c=context();assert.throws(()=>c.service.importBatch([row('',1)]),{code:'E_INPUT'});const d=actual(),batch=path.join(d.dir,'invalid.json');fs.writeFileSync(batch,'[{"id":"","amount":1}]');const r=require('node:child_process').spawnSync(process.execPath,[path.join(workspace,'cli.cjs'),'import',d.file,batch],{env:process.env,encoding:'utf8',timeout:3000});assert.equal(r.status,2);assert.deepEqual(JSON.parse(r.stdout),{code:'E_INPUT'});},
O13(){const c=context();assert.throws(()=>c.service.importBatch([row(),row('b',1.5)]),{code:'E_INPUT'});assert.deepEqual(c.state(),empty());assert(!c.trace.includes('backup'));assert.equal(c.clockCalls(),0);},
O14(){const a=context(),b=context();const r=a.service.importBatch([row('z'),row('a')]),s=b.service.importBatch([row('a'),row('z')]);assert.deepEqual(a.state(),b.state());assert.deepEqual(r,s);assert.deepEqual(r.inserted,['a','z']);},
O15(){const c=context();c.service.importBatch([row(),row()]);assert.equal(c.state().records.length,1);const d=context();assert.throws(()=>d.service.importBatch([row(),row('a',101)]),{code:'E_CONFLICT'});assert.deepEqual(d.state(),empty());assert(!d.trace.includes('backup'));},
O16(){const c=context(),r=c.service.importBatch([]);assert.deepEqual(r,{inserted:[],skipped:[],dryRun:false});assert.equal(c.clockCalls(),0);assert(!c.trace.includes('backup'));assert.equal(c.audits.length,0);},
O17(){const old={version:1,entries:[{id:'0001',cents:-50,createdAt:'old'}]},before=JSON.stringify(old);assert.deepEqual(migrate(old),{version:2,records:[{id:'0001',amount:-50,createdAt:'old'}]});assert.equal(JSON.stringify(old),before);},
O18(){const c=context();c.service.importBatch([row('a',0),row('b',-7)]);assert.deepEqual(c.state().records.map(x=>x.amount),[0,-7]);for(const value of [1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'1',null]){const d=context();assert.throws(()=>d.service.importBatch([row('bad',value)]),{code:'E_INPUT'});assert.deepEqual(d.state(),empty());}},
O19(){const c=context();c.service.importBatch([row('z',123456),row('a',654321)]);assert.deepEqual(c.audits,[{action:'import',ids:['a','z'],at:'2026-01-02T03:04:05.000Z'}]);},
O20(){const db={version:2,records:[{id:'old',amount:5,createdAt:'old-time'}]},c=context(db);c.service.importBatch([row()]);assert.deepEqual(c.state().records.find(x=>x.id==='old'),db.records[0]);}
};
const results=[];
for(const [id,run] of Object.entries(tests)){try{run();results.push({id,passed:true,evidence:'Executable case passed'});}catch{results.push({id,passed:false,evidence:'Executable case failed'});}}
fs.rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify(results));
